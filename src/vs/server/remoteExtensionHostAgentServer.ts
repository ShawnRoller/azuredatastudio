/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as url from 'url';
// import { performance } from 'perf_hooks';
import { VSBuffer } from 'vs/base/common/buffer';
import { Disposable, toDisposable } from 'vs/base/common/lifecycle';
import { generateUuid } from 'vs/base/common/uuid';
import { readdir, rimraf } from 'vs/base/node/pfs';
import { findFreePort } from 'vs/base/node/ports';
import * as platform from 'vs/base/common/platform';
import { PersistentProtocol } from 'vs/base/parts/ipc/common/ipc.net';
import { NodeSocket, WebSocketNodeSocket } from 'vs/base/parts/ipc/node/ipc.net';
import { ConnectionType, HandshakeMessage, IRemoteExtensionHostStartParams, ITunnelConnectionStartParams, SignRequest } from 'vs/platform/remote/common/remoteAgentConnection';
import { ExtensionHostConnection } from 'vs/server/extensionHostConnection';
import { ManagementConnection } from 'vs/server/remoteExtensionManagement';
import { createRemoteURITransformer } from 'vs/server/remoteUriTransformer';
import { ILogService, LogLevel, AbstractLogService, DEFAULT_LOG_LEVEL, MultiplexLogService, getLogLevel } from 'vs/platform/log/common/log';
import { FileAccess, Schemas } from 'vs/base/common/network';
import product from 'vs/platform/product/common/product';
import { IEnvironmentService, INativeEnvironmentService } from 'vs/platform/environment/common/environment';
import { ServiceCollection } from 'vs/platform/instantiation/common/serviceCollection';
import { SyncDescriptor } from 'vs/platform/instantiation/common/descriptors';
import { ConfigurationService } from 'vs/platform/configuration/common/configurationService';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IRequestService } from 'vs/platform/request/common/request';
import { RequestService } from 'vs/platform/request/node/requestService';
import { NullTelemetryService, ITelemetryAppender, NullAppender } from 'vs/platform/telemetry/common/telemetryUtils';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IExtensionGalleryService, IExtensionManagementService } from 'vs/platform/extensionManagement/common/extensionManagement';
import { ExtensionGalleryService } from 'vs/platform/extensionManagement/common/extensionGalleryService';
import { ExtensionManagementService } from 'vs/platform/extensionManagement/node/extensionManagementService';
import { InstantiationService } from 'vs/platform/instantiation/common/instantiationService';
import { IDownloadService } from 'vs/platform/download/common/download';
import { DownloadServiceChannelClient } from 'vs/platform/download/common/downloadIpc';
import { ILocalizationsService } from 'vs/platform/localizations/common/localizations';
import { LocalizationsService } from 'vs/platform/localizations/node/localizations';
import { AppInsightsAppender } from 'vs/platform/telemetry/node/appInsightsAppender';
import { ITelemetryServiceConfig, TelemetryService } from 'vs/platform/telemetry/common/telemetryService';
import { resolveCommonProperties } from 'vs/platform/telemetry/node/commonProperties';
import { getMachineId } from 'vs/base/node/id';
import { FileService } from 'vs/platform/files/common/fileService';
import { DiskFileSystemProvider } from 'vs/platform/files/node/diskFileSystemProvider';
import { IFileService } from 'vs/platform/files/common/files';
import { IProductService } from 'vs/platform/product/common/productService';
import { RemoteAgentConnectionContext } from 'vs/platform/remote/common/remoteAgentEnvironment';
import { IPCServer, ClientConnectionEvent, IMessagePassingProtocol, StaticRouter } from 'vs/base/parts/ipc/common/ipc';
import { Emitter, Event } from 'vs/base/common/event';
import { RemoteAgentEnvironmentChannel } from 'vs/server/remoteAgentEnvironmentImpl';
import { RemoteAgentFileSystemChannel } from 'vs/server/remoteAgentFileSystemImpl';
import { REMOTE_FILE_SYSTEM_CHANNEL_NAME } from 'vs/workbench/services/remote/common/remoteAgentFileSystemChannel';
import { RequestChannel } from 'vs/platform/request/common/requestIpc';
import { ExtensionManagementChannel } from 'vs/platform/extensionManagement/common/extensionManagementIpc';
import ErrorTelemetry from 'vs/platform/telemetry/node/errorTelemetry';
import { ExtensionHostDebugBroadcastChannel } from 'vs/platform/debug/common/extensionHostDebugIpc';
import { LoggerChannel } from 'vs/platform/log/common/logIpc';
import { IURITransformer } from 'vs/base/common/uriIpc';
import { WebClientServer, serveError, serveFile } from 'vs/server/webClientServer';
import { URI } from 'vs/base/common/uri';
import { isEqualOrParent } from 'vs/base/common/extpath';
import { ServerEnvironmentService, ServerParsedArgs } from 'vs/server/serverEnvironmentService';
import { basename, dirname, join } from 'vs/base/common/path';
import { REMOTE_TERMINAL_CHANNEL_NAME } from 'vs/workbench/contrib/terminal/common/remoteTerminalChannel';
import { RemoteTerminalChannel } from 'vs/server/remoteTerminalChannel';
//import { LoaderStats } from 'vs/base/common/amd';
import { SpdLogService } from 'vs/platform/log/node/spdlogService';
import { RemoteExtensionLogFileName } from 'vs/workbench/services/remote/common/remoteAgentService';

const SHUTDOWN_TIMEOUT = 5 * 60 * 1000;
const license = `

*
* Visual Studio Code Server
*
* Reminder: You may only use this software with Visual Studio family products,
* as described in the license https://aka.ms/vscode-remote/license
*

`;

const eventPrefix = 'monacoworkbench';

class SocketServer<TContext = string> extends IPCServer<TContext> {

	private _onDidConnectEmitter: Emitter<ClientConnectionEvent>;

	constructor() {
		const emitter = new Emitter<ClientConnectionEvent>();
		super(emitter.event);
		this._onDidConnectEmitter = emitter;
	}

	public acceptConnection(protocol: IMessagePassingProtocol, onDidClientDisconnect: Event<void>): void {
		this._onDidConnectEmitter.fire({ protocol, onDidClientDisconnect });
	}
}

function twodigits(n: number): string {
	if (n < 10) {
		return `0${n}`;
	}
	return String(n);
}

function now(): string {
	const date = new Date();
	return `${twodigits(date.getHours())}:${twodigits(date.getMinutes())}:${twodigits(date.getSeconds())}`;
}

class ServerLogService extends AbstractLogService implements ILogService {
	_serviceBrand: undefined;
	private useColors: boolean;

	constructor(logLevel: LogLevel = DEFAULT_LOG_LEVEL) {
		super();
		this.setLevel(logLevel);
		this.useColors = Boolean(process.stdout.isTTY);
	}

	trace(message: string, ...args: any[]): void {
		if (this.getLevel() <= LogLevel.Trace) {
			if (this.useColors) {
				console.log(`\x1b[90m[${now()}]\x1b[0m`, message, ...args);
			} else {
				console.log(`[${now()}]`, message, ...args);
			}
		}
	}

	debug(message: string, ...args: any[]): void {
		if (this.getLevel() <= LogLevel.Debug) {
			if (this.useColors) {
				console.log(`\x1b[90m[${now()}]\x1b[0m`, message, ...args);
			} else {
				console.log(`[${now()}]`, message, ...args);
			}
		}
	}

	info(message: string, ...args: any[]): void {
		if (this.getLevel() <= LogLevel.Info) {
			if (this.useColors) {
				console.log(`\x1b[90m[${now()}]\x1b[0m`, message, ...args);
			} else {
				console.log(`[${now()}]`, message, ...args);
			}
		}
	}

	warn(message: string | Error, ...args: any[]): void {
		if (this.getLevel() <= LogLevel.Warning) {
			if (this.useColors) {
				console.warn(`\x1b[93m[${now()}]\x1b[0m`, message, ...args);
			} else {
				console.warn(`[${now()}]`, message, ...args);
			}
		}
	}

	error(message: string, ...args: any[]): void {
		if (this.getLevel() <= LogLevel.Error) {
			if (this.useColors) {
				console.error(`\x1b[91m[${now()}]\x1b[0m`, message, ...args);
			} else {
				console.error(`[${now()}]`, message, ...args);
			}
		}
	}

	critical(message: string, ...args: any[]): void {
		if (this.getLevel() <= LogLevel.Critical) {
			if (this.useColors) {
				console.error(`\x1b[90m[${now()}]\x1b[0m`, message, ...args);
			} else {
				console.error(`[${now()}]`, message, ...args);
			}
		}
	}

	dispose(): void {
		// noop
	}

	flush(): void {
		// noop
	}
}

export type ServerListenOptions = { host?: string; port?: number; socketPath?: string };

export class RemoteExtensionHostAgentServer extends Disposable {

	private readonly _logService: ILogService;
	private readonly _socketServer: SocketServer<RemoteAgentConnectionContext>;
	private readonly _uriTransformerCache: { [remoteAuthority: string]: IURITransformer; };
	private readonly _extHostConnections: { [reconnectionToken: string]: ExtensionHostConnection; };
	private readonly _managementConnections: { [reconnectionToken: string]: ManagementConnection; };
	private readonly _webClientServer: WebClientServer | null;

	private shutdownTimer: NodeJS.Timer | undefined;

	constructor(
		private readonly _environmentService: ServerEnvironmentService,
		private readonly _connectionToken: string,
		private readonly _connectionTokenIsMandatory: boolean,
		hasWebClient: boolean,
		REMOTE_DATA_FOLDER: string
	) {
		super();

		const logService = getOrCreateSpdLogService(this._environmentService);
		logService.trace(`Remote configuration data at ${REMOTE_DATA_FOLDER}`);
		logService.trace('process arguments:', this._environmentService.args);
		logService.info(license);

		this._logService = new MultiplexLogService([new ServerLogService(getLogLevel(this._environmentService)), logService]);
		this._socketServer = new SocketServer<RemoteAgentConnectionContext>();
		this._uriTransformerCache = Object.create(null);
		this._extHostConnections = Object.create(null);
		this._managementConnections = Object.create(null);

		if (hasWebClient) {
			this._webClientServer = new WebClientServer(this._connectionToken, this._environmentService, this._logService);
		} else {
			this._webClientServer = null;
		}
		this._logService.info(`Extension host agent started.`);
	}

	public async initialize(): Promise<void> {
		await this._createServices();
		setTimeout(() => this._cleanupOlderLogs(this._environmentService.logsPath).then(null, err => this._logService.error(err)), 10000);
	}

	private async _createServices(): Promise<void> {
		const services = new ServiceCollection();

		// ExtensionHost Debug broadcast service
		this._socketServer.registerChannel(ExtensionHostDebugBroadcastChannel.ChannelName, new ExtensionHostDebugBroadcastChannel());

		// TODO: @Sandy @Joao need dynamic context based router
		const router = new StaticRouter<RemoteAgentConnectionContext>(ctx => ctx.clientId === 'renderer');
		this._socketServer.registerChannel('logger', new LoggerChannel(this._logService));

		services.set(IEnvironmentService, this._environmentService);
		services.set(INativeEnvironmentService, this._environmentService);

		services.set(ILogService, this._logService);
		services.set(IProductService, { _serviceBrand: undefined, ...product });

		// Files
		const fileService = this._register(new FileService(this._logService));
		services.set(IFileService, fileService);
		fileService.registerProvider(Schemas.file, this._register(new DiskFileSystemProvider(this._logService)));

		services.set(IConfigurationService, new SyncDescriptor(ConfigurationService, [this._environmentService.machineSettingsResource, fileService]));
		services.set(IRequestService, new SyncDescriptor(RequestService));

		let appInsightsAppender: ITelemetryAppender | null = NullAppender;
		if (!this._environmentService.args['disable-telemetry'] && product.enableTelemetry) {
			if (product.aiConfig && product.aiConfig.asimovKey) {
				appInsightsAppender = new AppInsightsAppender(eventPrefix, null, product.aiConfig.asimovKey);
				this._register(toDisposable(() => appInsightsAppender!.flush())); // Ensure the AI appender is disposed so that it flushes remaining data
			}

			const machineId = await getMachineId();
			const config: ITelemetryServiceConfig = {
				appender: appInsightsAppender,
				commonProperties: resolveCommonProperties(product.commit, product.version + '-remote', machineId, product.msftInternalDomains, this._environmentService.installSourcePath, 'remoteAgent'),
				piiPaths: [this._environmentService.appRoot]
			};

			services.set(ITelemetryService, new SyncDescriptor(TelemetryService, [config]));
		} else {
			services.set(ITelemetryService, NullTelemetryService);
		}

		services.set(IExtensionGalleryService, new SyncDescriptor(ExtensionGalleryService));

		const downloadChannel = this._socketServer.getChannel('download', router);
		services.set(IDownloadService, new DownloadServiceChannelClient(downloadChannel, () => this._getUriTransformer('renderer') /* TODO: @Sandy @Joao need dynamic context based router */));

		services.set(IExtensionManagementService, new SyncDescriptor(ExtensionManagementService));

		const instantiationService = new InstantiationService(services);
		services.set(ILocalizationsService, instantiationService.createInstance(LocalizationsService));

		instantiationService.invokeFunction(accessor => {
			const remoteExtensionEnvironmentChannel = new RemoteAgentEnvironmentChannel(this._connectionToken, this._environmentService, instantiationService, this._logService, accessor.get(ITelemetryService), appInsightsAppender);
			this._socketServer.registerChannel('remoteextensionsenvironment', remoteExtensionEnvironmentChannel);

			this._socketServer.registerChannel(REMOTE_TERMINAL_CHANNEL_NAME, new RemoteTerminalChannel(this._logService, this._environmentService));

			const remoteFileSystemChannel = new RemoteAgentFileSystemChannel(this._logService, this._environmentService);
			this._socketServer.registerChannel(REMOTE_FILE_SYSTEM_CHANNEL_NAME, remoteFileSystemChannel);

			this._socketServer.registerChannel('request', new RequestChannel(accessor.get(IRequestService)));

			const extensionManagementService = accessor.get(IExtensionManagementService);
			const channel = new ExtensionManagementChannel(extensionManagementService, (ctx: RemoteAgentConnectionContext) => this._getUriTransformer(ctx.remoteAuthority));
			this._socketServer.registerChannel('extensions', channel);

			// clean up deprecated extensions
			(extensionManagementService as ExtensionManagementService).removeDeprecatedExtensions();

			this._register(new ErrorTelemetry(accessor.get(ITelemetryService)));
		});
	}

	private _getUriTransformer(remoteAuthority: string): IURITransformer {
		if (!this._uriTransformerCache[remoteAuthority]) {
			this._uriTransformerCache[remoteAuthority] = createRemoteURITransformer(remoteAuthority);
		}
		return this._uriTransformerCache[remoteAuthority];
	}

	public async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
		// Only serve GET requests
		if (req.method !== 'GET') {
			return serveError(req, res, 405, `Unsupported method ${req.method}`);
		}

		if (!req.url) {
			return serveError(req, res, 400, `Bad request.`);
		}

		const parsedUrl = url.parse(req.url, true);
		const pathname = parsedUrl.pathname;

		if (!pathname) {
			return serveError(req, res, 400, `Bad request.`);
		}

		// Version
		if (pathname === '/version') {
			res.writeHead(200, { 'Content-Type': 'text/plain' });
			return res.end(product.commit || '');
		}

		// Delay shutdown
		if (pathname === '/delay-shutdown') {
			this._delayShutdown();
			res.writeHead(200);
			return res.end('OK');
		}

		if (pathname === '/vscode-remote-resource') {
			// Handle HTTP requests for resources rendered in the rich client (images, fonts, etc.)
			// These resources could be files shipped with extensions or even workspace files.
			if (parsedUrl.query['tkn'] !== this._connectionToken) {
				return serveError(req, res, 403, `Forbidden.`);
			}

			const desiredPath = parsedUrl.query['path'];
			if (typeof desiredPath !== 'string') {
				return serveError(req, res, 400, `Bad request.`);
			}

			let filePath: string;
			try {
				filePath = URI.from({ scheme: Schemas.file, path: desiredPath }).fsPath;
			} catch (err) {
				return serveError(req, res, 400, `Bad request.`);
			}

			const responseHeaders: Record<string, string> = Object.create(null);
			if (this._environmentService.isBuilt) {
				if (isEqualOrParent(filePath, this._environmentService.builtinExtensionsPath, !platform.isLinux)
					|| isEqualOrParent(filePath, this._environmentService.extensionsPath, !platform.isLinux)
				) {
					responseHeaders['Cache-Control'] = 'public, max-age=31536000';
				}
			}
			return serveFile(this._logService, req, res, filePath, responseHeaders);
		}

		// workbench web UI
		if (this._webClientServer) {
			this._webClientServer.handle(req, res, parsedUrl);
			return;
		}

		res.writeHead(404, { 'Content-Type': 'text/plain' });
		return res.end('Not found');
	}

	public handleUpgrade(req: http.IncomingMessage, socket: net.Socket) {
		if (req.headers['upgrade'] !== 'websocket') {
			socket.end('HTTP/1.1 400 Bad Request');
			return;
		}

		// https://tools.ietf.org/html/rfc6455#section-4
		const requestNonce = req.headers['sec-websocket-key'];
		const hash = crypto.createHash('sha1');
		hash.update(requestNonce + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11');
		const responseNonce = hash.digest('base64');

		const responseHeaders = [
			`HTTP/1.1 101 Switching Protocols`,
			`Upgrade: websocket`,
			`Connection: Upgrade`,
			`Sec-WebSocket-Accept: ${responseNonce}`
		];
		socket.write(responseHeaders.join('\r\n') + '\r\n\r\n');

		// Never timeout this socket due to inactivity!
		socket.setTimeout(0);
		// Finally!
		let reconnectionToken = generateUuid();
		let isReconnection = false;
		let skipWebSocketFrames = false;

		if (req.url) {
			const query = url.parse(req.url, true).query;
			if (typeof query.reconnectionToken === 'string') {
				reconnectionToken = query.reconnectionToken;
			}
			if (query.reconnection === 'true') {
				isReconnection = true;
			}
			if (query.skipWebSocketFrames === 'true') {
				skipWebSocketFrames = true;
			}
		}

		if (skipWebSocketFrames) {
			this._handleWebSocketConnection(new NodeSocket(socket), isReconnection, reconnectionToken);
		} else {
			this._handleWebSocketConnection(new WebSocketNodeSocket(new NodeSocket(socket)), isReconnection, reconnectionToken);
		}
	}

	public handleServerError(err: Error): void {
		this._logService.error(`Error occurred in server`);
		this._logService.error(err);
	}

	// Eventually cleanup
	/**
	 * Cleans up older logs, while keeping the 10 most recent ones.
	 */
	private async _cleanupOlderLogs(logsPath: string): Promise<void> {
		const currentLog = basename(logsPath);
		const logsRoot = dirname(logsPath);
		const children = await readdir(logsRoot);
		const allSessions = children.filter(name => /^\d{8}T\d{6}$/.test(name));
		const oldSessions = allSessions.sort().filter((d) => d !== currentLog);
		const toDelete = oldSessions.slice(0, Math.max(0, oldSessions.length - 9));

		await Promise.all(toDelete.map(name => rimraf(join(logsRoot, name))));
	}

	private _getRemoteAddress(socket: NodeSocket | WebSocketNodeSocket): string {
		let _socket: net.Socket;
		if (socket instanceof NodeSocket) {
			_socket = socket.socket;
		} else {
			_socket = socket.socket.socket;
		}
		return _socket.remoteAddress || `<unknown>`;
	}

	private _handleWebSocketConnection(socket: NodeSocket | WebSocketNodeSocket, isReconnection: boolean, reconnectionToken: string): void {
		const remoteAddress = this._getRemoteAddress(socket);
		const logPrefix = `[${remoteAddress}][${reconnectionToken.substr(0, 8)}]`;
		const protocol = new PersistentProtocol(socket);

		let validator: any;
		try {
			const vsda = <any>require.__$__nodeRequire('vsda');
			validator = new vsda.validator();
		} catch (e) {
		}

		const messageRegistration = protocol.onControlMessage((raw => {

			const msg = <HandshakeMessage>JSON.parse(raw.toString());
			if (msg.type === 'auth') {
				if (this._connectionTokenIsMandatory && msg.auth !== this._connectionToken) {
					// Invalid connection token, will not communicate further with this client
					this._logService.error(`${logPrefix} Unauthorized client refused, missing auth.`);
					protocol.sendControl(VSBuffer.fromString(JSON.stringify({ type: 'error', reason: 'Unauthorized client refused, missing auth.' })));
					protocol.dispose();
					socket.dispose();
					return;
				}

				let someText = 'VS Code Headless is cool';
				if (validator) {
					try {
						someText = validator.createNewMessage(someText);
					} catch (e) {
					}
				}

				const signRequest: SignRequest = {
					type: 'sign',
					data: someText
				};
				protocol.sendControl(VSBuffer.fromString(JSON.stringify(signRequest)));

			} else if (msg.type === 'connectionType') {

				// Stop listening for further events
				messageRegistration.dispose();

				const rendererCommit = msg.commit;
				const myCommit = product.commit;
				if (rendererCommit && myCommit) {
					// Running in the built version where commits are defined
					if (rendererCommit !== myCommit) {
						this._logService.error(`${logPrefix} Version mismatch, client refused.`);
						protocol.sendControl(VSBuffer.fromString(JSON.stringify({ type: 'error', reason: 'Version mismatch, client refused.' })));
						protocol.dispose();
						socket.dispose();
						return;
					}
				}

				let valid = false;

				if (msg.signedData === this._connectionToken) {
					// web client
					valid = true;
				}
				if (!valid && validator && typeof msg.signedData === 'string') {
					try {
						valid = validator.validate(msg.signedData) === 'ok';
					} catch (e) {
					}
				}

				if (!valid) {
					if (this._environmentService.isBuilt) {
						this._logService.error(`${logPrefix} Unauthorized client refused.`);
						protocol.sendControl(VSBuffer.fromString(JSON.stringify({ type: 'error', reason: 'Unauthorized client refused.' })));
						protocol.dispose();
						socket.dispose();
						return;
					} else {
						this._logService.error(`${logPrefix} Unauthorized client handshake failed but we proceed because of dev mode.`);
					}
				} else {
					if (!this._environmentService.isBuilt) {
						this._logService.trace(`${logPrefix} Client handshake succeded.`);
					}
				}

				// We have received a new connection.
				// This indicates that the server owner has connectivity.
				// Therefore we will shorten the reconnection grace period for disconnected connections!
				for (let key in this._managementConnections) {
					const managementConnection = this._managementConnections[key];
					managementConnection.shortenReconnectionGraceTimeIfNecessary();
				}
				for (let key in this._extHostConnections) {
					const extHostConnection = this._extHostConnections[key];
					extHostConnection.shortenReconnectionGraceTimeIfNecessary();
				}

				switch (msg.desiredConnectionType) {
					case ConnectionType.Management:
						// This should become a management connection

						if (isReconnection) {
							// This is a reconnection
							if (this._managementConnections[reconnectionToken]) {
								protocol.sendControl(VSBuffer.fromString(JSON.stringify({ type: 'ok' })));
								const dataChunk = protocol.readEntireBuffer();
								protocol.dispose();
								this._managementConnections[reconnectionToken].acceptReconnection(remoteAddress, socket, dataChunk);
							} else {
								// This is an unknown reconnection token
								this._logService.error(`${logPrefix}[ManagementConnection] Unknown reconnection token.`);
								protocol.sendControl(VSBuffer.fromString(JSON.stringify({ type: 'error', reason: 'Unknown reconnection token.' })));
								protocol.dispose();
								socket.dispose();
							}
						} else {
							// This is a fresh connection
							if (this._managementConnections[reconnectionToken]) {
								// Cannot have two concurrent connections using the same reconnection token
								this._logService.error(`${logPrefix}[ManagementConnection] Duplicate reconnection token.`);
								protocol.sendControl(VSBuffer.fromString(JSON.stringify({ type: 'error', reason: 'Duplicate reconnection token.' })));
								protocol.dispose();
								socket.dispose();
							} else {
								protocol.sendControl(VSBuffer.fromString(JSON.stringify({ type: 'ok' })));
								const con = new ManagementConnection(this._logService, reconnectionToken, remoteAddress, protocol);
								this._socketServer.acceptConnection(con.protocol, con.onClose);
								this._managementConnections[reconnectionToken] = con;
								con.onClose(() => {
									delete this._managementConnections[reconnectionToken];
								});
							}
						}

						break;

					case ConnectionType.ExtensionHost:
						// This should become an extension host connection
						const startParams = <IRemoteExtensionHostStartParams>msg.args || { language: 'en' };
						this._updateWithFreeDebugPort(startParams).then(startParams => {

							if (startParams.port) {
								this._logService.trace(`${logPrefix}[ExtensionHostConnection] - startParams debug port ${startParams.port}`);
							}
							if (msg.args) {
								this._logService.trace(`${logPrefix}[ExtensionHostConnection] - startParams language: ${startParams.language}`);
								this._logService.trace(`${logPrefix}[ExtensionHostConnection] - startParams env: ${JSON.stringify(startParams.env)}`);
							} else {
								this._logService.trace(`${logPrefix}[ExtensionHostConnection] - no UI language provided by renderer. Falling back to English`);
							}

							if (isReconnection) {
								// This is a reconnection
								if (this._extHostConnections[reconnectionToken]) {
									protocol.sendControl(VSBuffer.fromString(JSON.stringify(startParams.port ? { debugPort: startParams.port } : {})));
									const dataChunk = protocol.readEntireBuffer();
									protocol.dispose();
									this._extHostConnections[reconnectionToken].acceptReconnection(remoteAddress, socket, dataChunk);
								} else {
									// This is an unknown reconnection token
									this._logService.error(`${logPrefix}[ExtensionHostConnection] Unknown reconnection token.`);
									protocol.sendControl(VSBuffer.fromString(JSON.stringify({ type: 'error', reason: 'Unknown reconnection token.' })));
									protocol.dispose();
									socket.dispose();
								}
							} else {
								// This is a fresh connection
								if (this._extHostConnections[reconnectionToken]) {
									// Cannot have two concurrent connections using the same reconnection token
									this._logService.error(`${logPrefix}[ExtensionHostConnection] Duplicate reconnection token.`);
									protocol.sendControl(VSBuffer.fromString(JSON.stringify({ type: 'error', reason: 'Duplicate reconnection token.' })));
									protocol.dispose();
									socket.dispose();
								} else {
									protocol.sendControl(VSBuffer.fromString(JSON.stringify(startParams.port ? { debugPort: startParams.port } : {})));
									const dataChunk = protocol.readEntireBuffer();
									protocol.dispose();
									const con = new ExtensionHostConnection(this._environmentService, this._logService, reconnectionToken, remoteAddress, socket, dataChunk);
									this._extHostConnections[reconnectionToken] = con;
									con.onClose(() => {
										delete this._extHostConnections[reconnectionToken];
										this._onDidCloseExtHostConnection();
									});
									con.start(startParams);
								}
							}
						});
						break;

					case ConnectionType.Tunnel:
						const tunnelStartParams = <ITunnelConnectionStartParams>msg.args;
						this._createTunnel(protocol, tunnelStartParams);
						break;

					default:
						console.error(`Unknown initial data received.`);
						this._logService.error(`Unknown initial data received.`);
						protocol.sendControl(VSBuffer.fromString(JSON.stringify({ type: 'error', reason: 'Unknown initial data received.' })));
						protocol.dispose();
						socket.dispose();
				}
			}
		}));
	}

	private async _createTunnel(protocol: PersistentProtocol, tunnelStartParams: ITunnelConnectionStartParams): Promise<void> {
		const remoteSocket = (<NodeSocket>protocol.getSocket()).socket;
		const dataChunk = protocol.readEntireBuffer();
		protocol.dispose();

		remoteSocket.pause();
		const localSocket = await this._connectTunnelSocket(tunnelStartParams.port);

		if (dataChunk.byteLength > 0) {
			localSocket.write(dataChunk.buffer);
		}

		localSocket.on('end', () => remoteSocket.end());
		localSocket.on('close', () => remoteSocket.end());
		localSocket.on('error', () => remoteSocket.destroy());
		remoteSocket.on('end', () => localSocket.end());
		remoteSocket.on('close', () => localSocket.end());
		remoteSocket.on('error', () => localSocket.destroy());

		localSocket.pipe(remoteSocket);
		remoteSocket.pipe(localSocket);
	}

	private _connectTunnelSocket(port: number): Promise<net.Socket> {
		return new Promise<net.Socket>((c, e) => {
			const socket = net.createConnection({ port: port }, () => {
				socket.removeListener('error', e);
				socket.pause();
				c(socket);
			});

			socket.once('error', e);
		});
	}

	private _updateWithFreeDebugPort(startParams: IRemoteExtensionHostStartParams): Thenable<IRemoteExtensionHostStartParams> {
		if (typeof startParams.port === 'number') {
			return findFreePort(startParams.port, 10 /* try 10 ports */, 5000 /* try up to 5 seconds */).then(freePort => {
				startParams.port = freePort;
				return startParams;
			});
		}
		// No port clear debug configuration.
		startParams.debugId = undefined;
		startParams.port = undefined;
		startParams.break = undefined;
		return Promise.resolve(startParams);
	}

	private async _onDidCloseExtHostConnection(): Promise<void> {
		if (!this._environmentService.args['enable-remote-auto-shutdown']) {
			return;
		}

		this._cancelShutdown();

		const hasActiveExtHosts = !!Object.keys(this._extHostConnections).length;
		if (!hasActiveExtHosts) {
			console.log('Last EH closed, waiting before shutting down');
			this._logService.info('Last EH closed, waiting before shutting down');
			this._waitThenShutdown();
		}
	}

	private _waitThenShutdown(): void {
		if (!this._environmentService.args['enable-remote-auto-shutdown']) {
			return;
		}

		if (this._environmentService.args['remote-auto-shutdown-without-delay']) {
			this._shutdown();
		} else {
			this.shutdownTimer = setTimeout(() => {
				this.shutdownTimer = undefined;

				this._shutdown();
			}, SHUTDOWN_TIMEOUT);
		}
	}

	private _shutdown(): void {
		const hasActiveExtHosts = !!Object.keys(this._extHostConnections).length;
		if (hasActiveExtHosts) {
			console.log('New EH opened, aborting shutdown');
			this._logService.info('New EH opened, aborting shutdown');
			return;
		} else {
			console.log('Last EH closed, shutting down');
			this._logService.info('Last EH closed, shutting down');
			this.dispose();
			process.exit(0);
		}
	}

	/**
	 * If the server is in a shutdown timeout, cancel it and start over
	 */
	private _delayShutdown(): void {
		if (this.shutdownTimer) {
			console.log('Got delay-shutdown request while in shutdown timeout, delaying');
			this._logService.info('Got delay-shutdown request while in shutdown timeout, delaying');
			this._cancelShutdown();
			this._waitThenShutdown();
		}
	}

	private _cancelShutdown(): void {
		if (this.shutdownTimer) {
			console.log('Cancelling previous shutdown timeout');
			this._logService.info('Cancelling previous shutdown timeout');
			clearTimeout(this.shutdownTimer);
			this.shutdownTimer = undefined;
		}
	}
}

function parseConnectionToken(args: ServerParsedArgs): { connectionToken: string; connectionTokenIsMandatory: boolean; } {
	if (args['connection-secret']) {
		if (args['connectionToken']) {
			console.warn(`Please do not use the argument connectionToken at the same time as connection-secret.`);
			process.exit(1);
		}
		let rawConnectionToken = fs.readFileSync(args['connection-secret']).toString();
		rawConnectionToken = rawConnectionToken.replace(/\r?\n$/, '');
		if (!/^[0-9A-Za-z\-]+$/.test(rawConnectionToken)) {
			console.warn(`The secret defined in ${args['connection-secret']} does not adhere to the characters 0-9, a-z, A-Z or -.`);
			process.exit(1);
		}
		return { connectionToken: rawConnectionToken, connectionTokenIsMandatory: true };
	} else {
		return { connectionToken: args['connectionToken'] || generateUuid(), connectionTokenIsMandatory: false };
	}
}

export interface IServerAPI {
	initialize(): Promise<void>;
	handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
	handleUpgrade(req: http.IncomingMessage, socket: net.Socket): void;
	handleServerError(err: Error): void;
	dispose(): void;
}

export function createServer(address: string | net.AddressInfo | null, args: ServerParsedArgs, REMOTE_DATA_FOLDER: string): Promise<IServerAPI> {
	const environmentService = new ServerEnvironmentService(args);

	//
	// On Windows, exit early with warning message to users about potential security issue
	// if there is node_modules folder under home drive or Users folder.
	//
	if (process.platform === 'win32' && process.env.HOMEDRIVE && process.env.HOMEPATH) {
		const homeDirModulesPath = join(process.env.HOMEDRIVE, 'node_modules');
		const userDir = dirname(join(process.env.HOMEDRIVE, process.env.HOMEPATH));
		const userDirModulesPath = join(userDir, 'node_modules');
		if (fs.existsSync(homeDirModulesPath) || fs.existsSync(userDirModulesPath)) {
			const message = `

*
* !!!! Server terminated due to presence of CVE-2020-1416 !!!!
*
* Please remove the following directories and re-try
* ${homeDirModulesPath}
* ${userDirModulesPath}
*
* For more information on the vulnerability https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2020-1416
*

`;
			const logService = getOrCreateSpdLogService(environmentService);
			logService.warn(message);
			console.warn(message);
			process.exit(0);
		}
	}

	const { connectionToken, connectionTokenIsMandatory } = parseConnectionToken(args);
	const hasWebClient = fs.existsSync(FileAccess.asFileUri('vs/code/browser/workbench/workbench.html', require).fsPath);

	if (hasWebClient && address && typeof address !== 'string') {
		// ships the web ui!
		console.log(`Web UI available at http://localhost${address.port === 80 ? '' : `:${address.port}`}/?tkn=${connectionToken}`);
	}

	const remoteExtensionHostAgentServer = new RemoteExtensionHostAgentServer(environmentService, connectionToken, connectionTokenIsMandatory, hasWebClient, REMOTE_DATA_FOLDER);
	return remoteExtensionHostAgentServer.initialize().then(_ => {
		// {{SQL CARBON EDIT}} - build break
		// if (args['print-startup-performance']) {
		// 	const currentTime = performance.now();
		// 	const vscodeServerStartTime: number = (<any>global).vscodeServerStartTime;
		// 	const vscodeServerListenTime: number = (<any>global).vscodeServerListenTime;
		// 	const vscodeServerCodeLoadedTime: number = (<any>global).vscodeServerCodeLoadedTime;

		// 	const stats = LoaderStats.get();
		// 	let output = '';
		// 	output += '\n\n### Load AMD-module\n';
		// 	output += LoaderStats.toMarkdownTable(['Module', 'Duration'], stats.amdLoad);
		// 	output += '\n\n### Load commonjs-module\n';
		// 	output += LoaderStats.toMarkdownTable(['Module', 'Duration'], stats.nodeRequire);
		// 	output += '\n\n### Invoke AMD-module factory\n';
		// 	output += LoaderStats.toMarkdownTable(['Module', 'Duration'], stats.amdInvoke);
		// 	output += '\n\n### Invoke commonjs-module\n';
		// 	output += LoaderStats.toMarkdownTable(['Module', 'Duration'], stats.nodeEval);
		// 	output += `Start-up time: ${vscodeServerListenTime - vscodeServerStartTime}\n`;
		// 	output += `Code loading time: ${vscodeServerCodeLoadedTime - vscodeServerStartTime}\n`;
		// 	output += `Initialized time: ${currentTime - vscodeServerStartTime}\n`;
		// 	output += `\n`;
		// 	console.log(output);
		// }
		return remoteExtensionHostAgentServer;
	});
}

const getOrCreateSpdLogService: (environmentService: ServerEnvironmentService) => ILogService = (function () {
	let _logService: ILogService | null;
	return function getLogService(environmentService: ServerEnvironmentService): ILogService {
		if (!_logService) {
			_logService = new SpdLogService(RemoteExtensionLogFileName, environmentService.logsPath, getLogLevel(environmentService));
		}
		return _logService;
	};
})();
