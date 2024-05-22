import { RequestHandlerArgs } from "../../request-handler.js";
import jwt from "jsonwebtoken";
import { ServerSocketState } from "../server-socket-state.js";
import { AuthTokenError, AuthTokenExpiredError, AuthTokenInvalidError, AuthTokenNotBeforeError, dehydrateError } from "@socket-mesh/errors";
import { AuthEngine } from "../auth-engine.js";
import { AuthToken, SignedAuthToken } from "@socket-mesh/auth";
import { Socket } from "../../socket.js";
import { SocketTransport } from "../../socket-transport.js";

export type AuthInfo = ValidAuthInfo | InvalidAuthInfo;

export interface InvalidAuthInfo {
	signedAuthToken: SignedAuthToken,
	authError: AuthTokenError
};

export interface ValidAuthInfo {
	signedAuthToken: SignedAuthToken,
	authToken: AuthToken
}

export async function authenticateHandler(
	{ socket, transport, options }: RequestHandlerArgs<string, ServerSocketState>
): Promise<void> {
	const state = transport.state;
	const server = state.server;
	const authInfo = await validateAuthToken(server.auth, options);

	await processAuthentication(socket, transport, authInfo);
}

export async function validateAuthToken(
	auth: AuthEngine, authToken: SignedAuthToken, verificationOptions?: jwt.VerifyOptions
): Promise<AuthInfo> {
	try {
		return {
			signedAuthToken: authToken,
			authToken: await auth.verifyToken(authToken, verificationOptions)
		};
	} catch (error) {
		return {
			signedAuthToken: authToken,
			authError: processTokenError(error)
		};		
	}
}

function processTokenError(err: jwt.VerifyErrors): AuthTokenError {
	if (err.name === 'TokenExpiredError' && 'expiredAt' in err) {
		return new AuthTokenExpiredError(err.message, err.expiredAt);
	}
	if (err.name === 'JsonWebTokenError') {
		return new AuthTokenInvalidError(err.message);
	}
	if (err.name === 'NotBeforeError' && 'date' in err) {
		// In this case, the token is good; it's just not active yet.
		return new AuthTokenNotBeforeError(err.message, err.date);
	}

	return new AuthTokenError(err.message);
}

export async function processAuthentication(
	socket: Socket<{}, {}, {}, {}, ServerSocketState>,
	transport: SocketTransport<{}, {}, {}, {}, ServerSocketState>,
	authInfo: AuthInfo
): Promise<void> {
	if ('authError' in authInfo) {
		await transport.deauthenticate();

		// If the error is related to the JWT being badly formatted, then we will
		// treat the error as a socket error.
		if (authInfo.signedAuthToken != null) {
			transport.onError(authInfo.authError);

			if (authInfo.authError instanceof AuthTokenError) {
				socket.emit('badAuthToken', { error: authInfo.authError, signedAuthToken: authInfo.signedAuthToken });
			}
		}
		throw authInfo.authError;
	}

	for (const middleware of transport.state.server.middleware) {
		if ('authenticate' in middleware) {
			try {
				transport.callMiddleware(
					middleware,
					() => {
						middleware.authenticate(authInfo);
					}
				);
			} catch (err) {
				await transport.deauthenticate();

				if (err instanceof AuthTokenError) {
					socket.emit('badAuthToken', { error: err, signedAuthToken: authInfo.signedAuthToken });
				}
				throw err;
			}
		}
	}

	await transport.setAuthorization(authInfo.signedAuthToken, authInfo.authToken);
}