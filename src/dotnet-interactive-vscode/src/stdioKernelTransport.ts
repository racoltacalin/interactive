// Copyright (c) .NET Foundation and contributors. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

import { AddressInfo, createServer } from "net";
import * as cp from 'child_process';
import {
    DisposableSubscription,
    KernelCommand,
    KernelCommandType,
    KernelEventEnvelope,
    KernelEventEnvelopeObserver,
    KernelTransport,
    DiagnosticLogEntryProducedType,
    DiagnosticLogEntryProduced,
    KernelReadyType,
    KernelCommandEnvelopeObserver
} from 'dotnet-interactive-vscode-interfaces/out/contracts';
import { ProcessStart } from './interfaces';
import { ReportChannel, Uri } from 'dotnet-interactive-vscode-interfaces/out/notebook';
import { LineReader } from './lineReader';
import { isNotNull, parse, stringify } from './utilities';
import fetch from 'node-fetch';

export class StdioKernelTransport implements KernelTransport {
    private childProcess: cp.ChildProcessWithoutNullStreams | null;
    private lineReader: LineReader;
    private notifyOnExit: boolean = true;
    private readyPromise: Promise<void>;
    private subscribers: Array<KernelEventEnvelopeObserver> = [];
    public httpPort: Number;
    public externalUri: Uri | null;

    constructor(
        notebookPath: string,
        processStart: ProcessStart,
        private diagnosticChannel: ReportChannel,
        private parseUri: (uri: string) => Uri,
        private notification: { displayError: (message: string) => Promise<void>, displayInfo: (message: string) => Promise<void> },
        private processExited: (pid: number, code: number | undefined, signal: string | undefined) => void) {
        // prepare root event handler
        this.lineReader = new LineReader();
        this.lineReader.subscribe(line => this.handleLine(line));
        this.childProcess = null;
        this.externalUri = null;
        this.httpPort = 0;

        // prepare one-time ready event
        this.readyPromise = new Promise<void>(async (resolve, reject) => {

            let args = await this.configureHttpArgs(processStart.args);
            // launch the process
            let childProcess = cp.spawn(processStart.command, args, { cwd: processStart.workingDirectory });
            let pid = childProcess.pid;

            this.childProcess = childProcess;
            this.diagnosticChannel.appendLine(`Kernel for '${notebookPath}' started (${childProcess.pid}).`);

            childProcess.on('exit', (code: number, signal: string) => {
                const message = `Kernel for '${notebookPath}' ended (${pid})`;
                const messageCodeSuffix = (code && code !== 0)
                    ? ` with code ${code}`
                    : '';
                const messageSignalSuffix = signal
                    ? ` with signal ${signal}`
                    : '';
                const fullMessage = `${message}${messageCodeSuffix}${messageSignalSuffix}.`;
                this.diagnosticChannel.appendLine(fullMessage);
                if (this.notifyOnExit) {
                    this.processExited(pid, code, signal);
                }
            });

            childProcess.stdout.on('data', data => this.lineReader.onData(data));
            childProcess.stderr.on('data', data => this.diagnosticChannel.appendLine(`kernel (${pid}) stderr: ${data.toString('utf-8')}`));

            const readySubscriber = this.subscribeToKernelEvents(eventEnvelope => {
                if (eventEnvelope.eventType === KernelReadyType) {
                    readySubscriber.dispose();
                    resolve();
                }
            });
        });
    }

    public async setExternalUri(externalUri: Uri): Promise<void> {
        this.externalUri = externalUri;
        let bootstrapperUri = await this.configureTunnel(this.parseUri(`http://localhost:${this.httpPort}`));
        if (bootstrapperUri === null) {
            bootstrapperUri = await this.configureTunnel(externalUri);
        }

        if (bootstrapperUri === null) {
            let errorMessage = `No valid bootstrapper uri can be found, .NET Interactive http api for Kernel Process ${this.childProcess?.pid} will not work correctly`;
            this.diagnosticChannel.appendLine(errorMessage);
            this.notification.displayError(errorMessage);
        }
    }

    private async configureTunnel(uri: Uri): Promise<Uri | null> {
        try {
            this.diagnosticChannel.appendLine(`Kernel process ${this.childProcess?.pid} Port ${this.httpPort} is using tunnel uri ${uri.toString()}`);
            let apitunnelUri = `${uri.toString()}apitunnel`;
            let response = await fetch(apitunnelUri, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ tunnelUri: uri.toString(), frontendType: "vscode" })
            });

            let reponseObject: any = await response.json();
            return this.parseUri(reponseObject["bootstrapperUri"]);
        }
        catch (error) {
            this.diagnosticChannel.appendLine(`Failure setting up tunnel confinguration for Kernel process ${this.childProcess?.pid}`);
            this.diagnosticChannel.appendLine(`Error : ${error.message}`);
            return null;
        }
    }

    private async configureHttpArgs(args: string[]): Promise<string[]> {
        let newArgs = [...args];
        let index = newArgs.indexOf("--http-port");
        if (index < 0) {
            index = newArgs.indexOf("--http-port-range");
            this.httpPort = await this.findFreePort();

            //todo: this is a temporary work during transition
            if (index > 0) {
                this.diagnosticChannel.appendLine("The --http-port-range option is not supported in the VS Code extension. Please use --http-port instead.");
                newArgs[index] = "--http-port";
                newArgs[index + 1] = `${this.httpPort}`;
            } else {
                newArgs.push("--http-port");
                newArgs.push(`${this.httpPort}`);
            }
        } else {
            this.httpPort = parseInt(newArgs[index + 1]);
        }

        return newArgs;
    }

    private findFreePort(): Promise<number> {
        return new Promise<number>((resolve, reject) => {
            const server = createServer();
            let port: number;
            server.once("listening", () => {
                const address = server.address() as AddressInfo;
                port = address.port;
                server.close();
            });
            server.once("close", () => {
                if (typeof port === "undefined") {
                    reject("Can't get port");
                    return;
                }
                resolve(port);
            });
            server.once("error", reject);
            server.listen(0, "127.0.0.1");
        });
    }

    private handleLine(line: string) {
        let obj = parse(line);
        let envelope = <KernelEventEnvelope>obj;
        switch (envelope.eventType) {
            case DiagnosticLogEntryProducedType:
                this.diagnosticChannel.appendLine((<DiagnosticLogEntryProduced>envelope.event).message);
                break;
        }

        for (let i = this.subscribers.length - 1; i >= 0; i--) {
            this.subscribers[i](envelope);
        }
    }

    subscribeToKernelEvents(observer: KernelEventEnvelopeObserver): DisposableSubscription {
        this.subscribers.push(observer);
        return {
            dispose: () => {
                let i = this.subscribers.indexOf(observer);
                if (i >= 0) {
                    this.subscribers.splice(i, 1);
                }
            }
        };
    }

    subscribeToCommands(observer: KernelCommandEnvelopeObserver): DisposableSubscription {
        throw new Error('Backchannel not currently supported by this transport');
    }

    submitCommand(command: KernelCommand, commandType: KernelCommandType, token: string): Promise<void> {
        return new Promise((resolve, reject) => {
            let submit = {
                token,
                commandType,
                command
            };

            let str = stringify(submit);
            if (isNotNull(this.childProcess)) {
                try {
                    this.childProcess.stdin.write(str);
                    this.childProcess.stdin.write('\n');
                    resolve();
                } catch (e) {
                    reject(e);
                }
            }
            else {
                reject('Kernel process is `null`.');
            }
        });
    }

    publishKernelEvent(eventEnvelope: KernelEventEnvelope): Promise<void> {
        throw new Error('Backchannel not currently supported by this transport');
    }

    waitForReady(): Promise<void> {
        return this.readyPromise;
    }

    dispose() {
        this.notifyOnExit = false;
        if (this.childProcess) {
            this.childProcess.kill();
        }
    }
}
