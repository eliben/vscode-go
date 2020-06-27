/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------*/

import net = require('net');
import stream = require('stream');

import { ChildProcess, execFile, execSync, spawn, spawnSync } from 'child_process';
import { EventEmitter } from 'events';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as util from 'util';
import {
	BreakpointEvent,
	Breakpoint,
	DebugSession,
	Handles,
	InitializedEvent,
	logger,
	Logger,
	LoggingDebugSession,
	OutputEvent,
	Scope,
	Source,
	StackFrame,
	StoppedEvent,
	TerminatedEvent,
	Thread
} from 'vscode-debugadapter';

import { DebugProtocol } from 'vscode-debugprotocol';

interface LoadConfig {
	// FollowPointers requests pointers to be automatically dereferenced.
	followPointers: boolean;
	// MaxVariableRecurse is how far to recurse when evaluating nested types.
	maxVariableRecurse: number;
	// MaxStringLen is the maximum number of bytes read from a string
	maxStringLen: number;
	// MaxArrayValues is the maximum number of elements read from an array, a slice or a map.
	maxArrayValues: number;
	// MaxStructFields is the maximum number of fields read from a struct, -1 will read all fields.
	maxStructFields: number;
}

const fsAccess = util.promisify(fs.access);
const fsUnlink = util.promisify(fs.unlink);

// This interface should always match the schema found in `package.json`.
interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	request: 'launch';
	[key: string]: any;
	program: string;
	stopOnEntry?: boolean;
	args?: string[];
	showLog?: boolean;
	logOutput?: string;
	cwd?: string;
	env?: { [key: string]: string };
	mode?: 'auto' | 'debug' | 'remote' | 'test' | 'exec';
	remotePath?: string;
	port?: number;
	host?: string;
	buildFlags?: string;
	init?: string;
	trace?: 'verbose' | 'log' | 'error';
	/** Optional path to .env file. */
	envFile?: string | string[];
	backend?: string;
	output?: string;
	/** Delve LoadConfig parameters */
	dlvLoadConfig?: LoadConfig;
	dlvToolPath: string;
	/** Delve Version */
	apiVersion: number;
	/** Delve maximum stack trace depth */
	stackTraceDepth: number;

	showGlobalVariables?: boolean;
	packagePathToGoModPathMap: { [key: string]: string };
}

interface AttachRequestArguments extends DebugProtocol.AttachRequestArguments {
	request: 'attach';
	processId?: number;
	stopOnEntry?: boolean;
	showLog?: boolean;
	logOutput?: string;
	cwd?: string;
	mode?: 'local' | 'remote';
	remotePath?: string;
	port?: number;
	host?: string;
	trace?: 'verbose' | 'log' | 'error';
	backend?: string;
	/** Delve LoadConfig parameters */
	dlvLoadConfig?: LoadConfig;
	dlvToolPath: string;
	/** Delve Version */
	apiVersion: number;
	/** Delve maximum stack trace depth */
	stackTraceDepth: number;

	showGlobalVariables?: boolean;
}

process.on('uncaughtException', (err: any) => {
	const errMessage = err && (err.stack || err.message);
	logger.error(`Unhandled error in debug adapter: ${errMessage}`);
	throw err;
});

function logArgsToString(args: any[]): string {
	return args
		.map((arg) => {
			return typeof arg === 'string' ? arg : JSON.stringify(arg);
		})
		.join(' ');
}

function log(...args: any[]) {
	logger.warn(logArgsToString(args));
}

function logError(...args: any[]) {
	logger.error(logArgsToString(args));
}

export class GoDlvDapDebugSession extends LoggingDebugSession {
	private logLevel: Logger.LogLevel = Logger.LogLevel.Error;

	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private static THREAD_ID = 1;

	public constructor() {
		super();

		// Invoke logger.init here because we want logging to work in 'inline'
		// DA mode. It's typically called in the start() method of our parent
		// class, but this method isn't called in 'inline' mode.
		logger.init(e => this.sendEvent(e));

		// this debugger uses zero-based lines and columns
		this.setDebuggerLinesStartAt1(false);
		this.setDebuggerColumnsStartAt1(false);
	}

	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		log('InitializeRequest');
		response.body.supportsConfigurationDoneRequest = true;
		response.body.supportsSetVariable = true;
		this.sendResponse(response);
		log('InitializeResponse');
	}

	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		super.configurationDoneRequest(response, args);
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {
		// Setup logger now that we have the 'trace' level passed in from
		// LaunchRequestArguments.
		this.logLevel =
			args.trace === 'verbose'
				? Logger.LogLevel.Verbose
				: args.trace === 'log'
					? Logger.LogLevel.Log
					: Logger.LogLevel.Error;
		const logPath =
			this.logLevel !== Logger.LogLevel.Error ? path.join(os.tmpdir(), 'vscode-godlvdapdebug.txt') : undefined;
		logger.setup(this.logLevel, logPath);

		log("launchRequest");
		this.sendResponse(response);
		log("launchResponse");
	}

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
		this.sendResponse(response);
	}

	protected breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		this.sendResponse(response);
	}

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
		this.sendResponse(response);
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
		this.sendResponse(response);
	}

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request) {
		this.sendResponse(response);
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this.sendResponse(response);
	}

	protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, args: DebugProtocol.ReverseContinueArguments) : void {
		this.sendResponse(response);
 	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this.sendResponse(response);
	}

	protected stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments): void {
		this.sendResponse(response);
	}

	protected stepInTargetsRequest(response: DebugProtocol.StepInTargetsResponse, args: DebugProtocol.StepInTargetsArguments) {
		this.sendResponse(response);
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
		this.sendResponse(response);
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
		this.sendResponse(response);
	}

	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
		this.sendResponse(response);
	}

	protected dataBreakpointInfoRequest(response: DebugProtocol.DataBreakpointInfoResponse, args: DebugProtocol.DataBreakpointInfoArguments): void {
		this.sendResponse(response);
	}

	protected setDataBreakpointsRequest(response: DebugProtocol.SetDataBreakpointsResponse, args: DebugProtocol.SetDataBreakpointsArguments): void {
		this.sendResponse(response);
	}

	protected completionsRequest(response: DebugProtocol.CompletionsResponse, args: DebugProtocol.CompletionsArguments): void {
		this.sendResponse(response);
	}
}

class DapClient extends EventEmitter {
    private static readonly TWO_CRLF = '\r\n\r\n';

    private outputStream: stream.Writable;

    private rawData = Buffer.alloc(0);
    private contentLength: number = -1;

    constructor() {
        super();
    }

    protected connect(readable: stream.Readable, writable: stream.Writable): void {
        this.outputStream = writable;

        readable.on('data', (data: Buffer) => {
            this.handleData(data);
        });
    }

    protected send(req: any): void {
        const json = JSON.stringify(req);
        this.outputStream.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`, 'utf8');
    }

    private handleData(data: Buffer): void {
        this.rawData = Buffer.concat([this.rawData, data]);

        while (true) {
            if (this.contentLength >= 0) {
                if (this.rawData.length >= this.contentLength) {
                    const message = this.rawData.toString('utf8', 0, this.contentLength);
                    this.rawData = this.rawData.slice(this.contentLength);
                    this.contentLength = -1;
                    if (message.length > 0) {
                        this.dispatch(message);
                    }
                    continue;	// there may be more complete messages to process
                }
            } else {
                const idx = this.rawData.indexOf(DapClient.TWO_CRLF);
                if (idx !== -1) {
                    const header = this.rawData.toString('utf8', 0, idx);
                    const lines = header.split('\r\n');
                    for (let i = 0; i < lines.length; i++) {
                        const pair = lines[i].split(/: +/);
                        if (pair[0] === 'Content-Length') {
                            this.contentLength = +pair[1];
                        }
                    }
                    this.rawData = this.rawData.slice(idx + DapClient.TWO_CRLF.length);
                    continue;
                }
            }
            break;
        }
    }

    private dispatch(body: string): void {
        const rawData = JSON.parse(body);

        if (rawData.type == 'event') {
            const event = <DebugProtocol.Event>rawData;
            this.emit('event', event);
        } else if (rawData.type == 'response') {
            const response = <DebugProtocol.Response>rawData;
            this.emit('response', response);
        } else if (rawData.type == 'request') {
            const request = <DebugProtocol.Request>rawData;
            this.emit('request', request);
        } else {
            throw new Error(`unknown message ${JSON.stringify(rawData)}`);
        }
    }
}
