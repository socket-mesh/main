import { AnyPacket } from "../packet.js";
import { ServerMap } from "../client/maps/server-map.js";
import { ServerSocket, ServerSocketOptions } from "./server-socket.js";
import { SocketTransport } from "../socket-transport.js";
import { AuthToken, SignedAuthToken } from "@socket-mesh/auth";
import { AuthError, BrokerError, InvalidActionError, socketProtocolErrorStatuses } from "@socket-mesh/errors";
import { SocketMapFromServer } from "../client/maps/socket-map.js";
import jwt from 'jsonwebtoken';
import { AuthTokenOptions } from "./auth-engine.js";
import { SocketStatus } from "../socket.js";
import { RawData } from "ws";
import { AnyResponse } from "../response.js";
import { ClientRequest, IncomingMessage } from "http";

export class ServerTransport<T extends ServerMap> extends SocketTransport<SocketMapFromServer<T>> {
	readonly service?: string;

	constructor(options: ServerSocketOptions<T>) {
		super(options);

		this.type = 'server';
		this.service = options.service;
		this.webSocket = options.socket;
	}

	public override async changeToUnauthenticatedState(): Promise<boolean> {
		if (this.signedAuthToken) {
			const authToken = this.authToken;
			const signedAuthToken = this.signedAuthToken;

			this.socket.state.server.emit('socketAuthStateChange', { socket: this.socket, wasAuthenticated: true, isAuthenticated: false });

			await super.changeToUnauthenticatedState();

			this.socket.state.server.emit('socketDeauthenticate', { socket: this.socket, signedAuthToken, authToken });

			return true;
		}

		return false;
	}
	
	protected override decode(data: string | RawData): AnyPacket<SocketMapFromServer<T>> | AnyPacket<SocketMapFromServer<T>>[] | AnyResponse<SocketMapFromServer<T>> | AnyResponse<SocketMapFromServer<T>>[] | null {
		const packet = super.decode(data);

		if ((packet === null || typeof packet !== 'object') && this.socket.state.server.strictHandshake && this.status === 'connecting') {
			this.disconnect(4009);
			return null;
		}

		return packet;
	}

	protected override onClose(code: number, reason?: string | Buffer): void {
		const status = this.status;
		const strReason = reason?.toString() || socketProtocolErrorStatuses[code];

		super.onClose(code, reason);

		this.socket.state.server.emit('socketClose', { socket: this.socket, code, reason: strReason });

		this.onDisconnect(status, code, strReason);
	}
	
	protected override onDisconnect(status: SocketStatus, code: number, reason?: string): void {
		if (status === 'ready') {
			this.socket.state.server.emit('socketDisconnect', { socket: this.socket, code, reason });
		} else {
			this.socket.state.server.emit('socketConnectAbort', { socket: this.socket, code, reason });
		}

		super.onDisconnect(status, code, reason);

		if (!!this.socket.state.server.clients[this.id]) {
			delete this.socket.state.server.clients[this.id];
			this.socket.state.server.clientCount--;
		}

		if (!!this.socket.state.server.pendingClients[this.id]) {
			delete this.socket.state.server.pendingClients[this.id];
			this.socket.state.server.pendingClientCount--;
		}

		if (this.socket.state.channelSubscriptions) {
			const channels = Object.keys(this.socket.state.channelSubscriptions);

			channels.map((channel) => this.unsubscribe(channel));	
		}

		if (this.streamCleanupMode !== 'none') {
			(async () => {
				await this.socket.listen('end').once();

				if (this.streamCleanupMode === 'kill') {
					this.socket.killListeners();
				} else if (this.streamCleanupMode === 'close') {
					this.socket.closeListeners();
				}
			
				for (let i = 0; i < this.middleware.length; i++) {
					const middleware = this.middleware[i];
		
					if (middleware.onEnd) {
						middleware.onEnd({ socket: this.socket, transport: this });
					}
				}
			})();
		}
		
		this.socket.emit('end');		
	}

	public override onError(error: Error): void {
		super.onError(error);
		this.socket.state.server.emit('socketError', { socket: this.socket, error });
	}
	
	protected override onMessage(data: RawData, isBinary: boolean): void {
		this.socket.state.server.emit('socketMessage', { socket: this.socket, data, isBinary });
		super.onMessage(data, isBinary);
	}

	protected override onPing(data: Buffer): void {
		if (this.socket.state.server.strictHandshake && this.status === 'connecting') {
			this.disconnect(4009);
			return;
		}

		super.onPing(data);
		this.socket.state.server.emit('socketPing', { socket: this.socket, data });	
	}

	protected override onPong(data: Buffer): void {
		this.resetPingTimeout(this.socket.state.server.isPingTimeoutDisabled ? false : this.socket.state.server.pingTimeoutMs, 4001);
		super.onPong(data);
		this.socket.state.server.emit('socketPong', { socket: this.socket, data });
	}

	protected override async onRequest(packet: AnyPacket<SocketMapFromServer<T>>, timestamp: Date): Promise<boolean> {
		let wasHandled = false;

		if (!this.service || !('service' in packet) || packet.service === this.service) {
			if (this.socket.state.server.strictHandshake && this.status === 'connecting' && packet.method !== '#handshake') {
				this.disconnect(4009);
				return true;
			}

			wasHandled = await super.onRequest(packet, timestamp);
		} else {
			wasHandled = this.onUnhandledRequest(packet);
		}

		return wasHandled;
	}
	
	protected override onResponse(response: AnyResponse<SocketMapFromServer<T>>): void {
		super.onResponse(response);
		this.socket.state.server.emit('socketResponse', { socket: this.socket, response });
	}

	protected override onUpgrade(request: IncomingMessage): void {
		super.onUpgrade(request);
		this.socket.state.server.emit('socketUpgrade', { socket: this.socket, request });
	}
	
	protected override onUnexpectedResponse(request: ClientRequest, response: IncomingMessage): void {
		super.onUnexpectedResponse(request, response);
		this.socket.state.server.emit('socketUnexpectedResponse', { socket: this.socket, request, response });
	}

	public override async setAuthorization(authToken: AuthToken, options?: AuthTokenOptions): Promise<boolean>;
	public override async setAuthorization(signedAuthToken: SignedAuthToken, authToken?: AuthToken): Promise<boolean>;
	public override async setAuthorization(authToken: AuthToken | SignedAuthToken, options?: AuthToken | AuthTokenOptions): Promise<boolean> {
		const wasAuthenticated = !!this.signedAuthToken;

		if (typeof authToken === 'string') {
			const changed = await super.setAuthorization(authToken, options as AuthToken);

			if (changed && this.status === 'ready') {
				this.triggerAuthenticationEvents(false, wasAuthenticated);
			}
			
			return changed;
		}

		const auth = this.socket.state.server.auth;
		const rejectOnFailedDelivery = options?.rejectOnFailedDelivery;
		let signedAuthToken: string;

		delete options?.rejectOnFailedDelivery;

		try {
			signedAuthToken = await auth.signToken(authToken, auth, options as jwt.SignOptions);
		} catch (err) {
			this.onError(err);
			this.disconnect(4002, err.toString());
			throw err;
		}

		const changed = await super.setAuthorization(signedAuthToken, authToken);

		if (changed && this.status === 'ready') {
			this.triggerAuthenticationEvents(true, wasAuthenticated);
		}

		if (rejectOnFailedDelivery) {
			try {
				await this.invoke('#setAuthToken', signedAuthToken)[0];
			} catch (err) {

				let error: AuthError;

				if (err && typeof err.message === 'string') {
					error = new AuthError(`Failed to deliver auth token to client - ${err.message}`);
				} else {
					error = new AuthError(
						'Failed to confirm delivery of auth token to client due to malformatted error response'
					);
				}

				this.onError(error);
				throw error;
			}
			return;
		}

		try {
			await this.transmit('#setAuthToken', signedAuthToken);
		} catch (err) {
			if (err.name !== 'BadConnectionError') {
				throw err;
			}
		}

		return changed;
	}

	public override setReadyStatus(pingTimeoutMs: number, authError?: Error): void {
		super.setReadyStatus(pingTimeoutMs, authError);
		this.socket.state.server.emit('socketConnect', { socket: this.socket, pingTimeoutMs, id: this.socket.id, isAuthenticated: !!this.signedAuthToken, authError });
	}

	public override get socket(): ServerSocket<T> {
		return super.socket as ServerSocket<T>;
	}

	public override set socket(value: ServerSocket<T>) {
		super.socket = value;

		this.resetPingTimeout(
			value.state.server.isPingTimeoutDisabled ? false : value.state.server.pingTimeoutMs,
			4001
		);
	}

	public override triggerAuthenticationEvents(wasSigned: boolean, wasAuthenticated: boolean): void {
		super.triggerAuthenticationEvents(wasSigned, wasAuthenticated);

		this.socket.state.server.emit(
			'socketAuthStateChange',
			{ socket: this.socket, wasAuthenticated, isAuthenticated: true, authToken: this.authToken, signedAuthToken: this.signedAuthToken }
		);

		this.socket.state.server.emit(
			'socketAuthenticate',
			{ socket: this.socket, wasSigned, signedAuthToken: this.signedAuthToken, authToken: this.authToken }
		);

	}

	public type: 'server'

	public async unsubscribe(channel: string): Promise<void> {
		if (typeof channel !== 'string') {
			throw new InvalidActionError(
				`Socket ${this.id} tried to unsubscribe from an invalid channel name`
			);
		}
	
		if (!this.socket.state.channelSubscriptions?.[channel]) {
			throw new InvalidActionError(
				`Socket ${this.id} tried to unsubscribe from a channel which it is not subscribed to`
			);
		}

		try {
			const server = this.socket.state.server;
			await server.brokerEngine.unsubscribe(this, channel);
			delete this.socket.state.channelSubscriptions[channel];
	
			if (this.socket.state.channelSubscriptionsCount != null) {
				this.socket.state.channelSubscriptionsCount--;
			}
	
			server.exchange.emit('unsubscribe', { channel });
		} catch (err) {
			throw new BrokerError(`Failed to unsubscribe socket from the ${channel} channel - ${err}`);
		}		
	}
}