import OAuth2Server, {
	Request as OauthRequest,
	Response as OauthResponse,
} from '@node-oauth/oauth2-server';
import cors from 'cors';
import { htmlEscape } from 'escape-goat';
import express from 'express';
import firebase from 'firebase-admin';
import { logger } from 'firebase-functions/v2';
import fetch from 'node-fetch';
import { z } from 'zod';
import { AccessTokens, RefreshTokens } from '../schema.js';
import { projectId } from '../firebase.js';
import { redactSensitiveBody } from '../utils.js';
import { getFirstDoc, Oauth2Model } from './oauth2Model.js';

export const firebaseWebappsResponseSchema = z.object({
	apps: z
		.array(z.object({ appId: z.string() }))
		.optional()
		.default([]),
});

export const firebaseWebappConfigSchema = z.record(z.string(), z.unknown());

export const oauthAuthorizeQuerySchema = z.object({
	client_id: z.string().min(1),
	redirect_uri: z.string().min(1),
	response_type: z.string().min(1),
	scope: z.string().default('scope'),
	state: z.string().optional(),
	code_challenge: z.string().optional(),
	code_challenge_method: z.string().optional(),
});

export const oauthAuthorizeBodySchema = z
	.object({
		idToken: z.string().min(1),
	})
	.passthrough();

export const oauthTokenBodySchema = z
	.object({
		grant_type: z.string().min(1),
	})
	.passthrough();

const getFirebaseWebapps = async (accessToken: string) => {
	const endpoint = `https://firebase.googleapis.com/v1beta1/projects/${projectId}/webApps`;
	const response = await fetch(endpoint, {
		headers: {
			authorization: `Bearer ${accessToken}`,
		},
	});

	if (!response.ok) {
		throw new Error(
			`Firebase WebApps API failed with status ${response.status}: ${response.statusText}`,
		);
	}

	const json: unknown = await response.json();
	const parsed = firebaseWebappsResponseSchema.safeParse(json);
	if (!parsed.success) {
		logger.error({
			type: 'firebaseWebappsResponseValidationError',
			error: parsed.error,
		});
		throw new Error(`Invalid Firebase WebApps response: ${parsed.error.message}`);
	}

	return parsed.data.apps;
};

const getFirebaseWebappConfig = async (accessToken: string, appId: string) => {
	const endpoint = `https://firebase.googleapis.com/v1beta1/projects/${projectId}/webApps/${appId}/config`;
	const response = await fetch(endpoint, {
		headers: {
			authorization: `Bearer ${accessToken}`,
		},
	});

	if (!response.ok) {
		throw new Error(
			`Firebase WebApp config API failed with status ${response.status}: ${response.statusText}`,
		);
	}

	const json: unknown = await response.json();
	const parsed = firebaseWebappConfigSchema.safeParse(json);
	if (!parsed.success) {
		logger.error({
			type: 'firebaseWebappConfigResponseValidationError',
			error: parsed.error,
		});
		throw new Error(`Invalid Firebase WebApp config response: ${parsed.error.message}`);
	}

	return parsed.data;
};

const getWebappConfig = async () => {
	const credential = firebase.credential.applicationDefault();
	const accessToken = await credential.getAccessToken();

	const apps = await getFirebaseWebapps(accessToken.access_token);
	const app = apps[0];
	if (!app) {
		throw new Error('No webapp found');
	}

	const appId = app.appId;
	const config = await getFirebaseWebappConfig(accessToken.access_token, appId);

	return config;
};

export const oauthModel = new Oauth2Model();

export const oauth = new OAuth2Server({
	model: oauthModel,
});

const router = express.Router();

// Phanpy など、ブラウザ上で動くクライアントは別オリジンから token/revoke を fetch する。
// authorize はページ遷移なので CORS は不要。
const tokenCors = cors({
	origin: true,
	methods: ['POST'],
	allowedHeaders: ['Authorization', 'Content-Type'],
});
router.options('/token', tokenCors);
router.options('/revoke', tokenCors);

router.get('/authorize', async (req, res) => {
	logger.info({
		type: 'oauthAuthorizeGet',
		params: req.query,
	});

	const parsedQuery = oauthAuthorizeQuerySchema.safeParse(req.query);
	if (!parsedQuery.success) {
		res.status(400).send('Bad request');
		return;
	}

	const {
		client_id: clientId,
		redirect_uri: redirectUri,
		response_type: responseType,
		scope,
		state,
		code_challenge: codeChallenge,
		code_challenge_method: codeChallengeMethod,
	} = parsedQuery.data;

	let config: Record<string, unknown>;
	try {
		config = await getWebappConfig();
	} catch (error) {
		logger.error({
			type: 'oauthAuthorizeGetConfigError',
			error: error instanceof Error ? error.message : String(error),
		});
		res.status(500).send('Internal server error');
		return;
	}

	const extraInputs: string[] = [];
	if (state !== undefined) {
		extraInputs.push(
			`<input type="hidden" name="state" id="state" value="${htmlEscape(state)}" autocomplete="off">`,
		);
	}
	if (codeChallenge !== undefined) {
		extraInputs.push(
			`<input type="hidden" name="code_challenge" id="code_challenge" value="${htmlEscape(codeChallenge)}" autocomplete="off">`,
		);
	}
	if (codeChallengeMethod !== undefined) {
		extraInputs.push(
			`<input type="hidden" name="code_challenge_method" id="code_challenge_method" value="${htmlEscape(codeChallengeMethod)}" autocomplete="off">`,
		);
	}

	const baseHtml = htmlEscape`
				<!DOCTYPE html>
				<html lang="en">
					<head>
						<meta charset="utf-8">
						<meta name="firebaseConfig" content="${JSON.stringify(config)}">
						<title>Authorize</title>
						<script defer src="https://www.gstatic.com/firebasejs/ui/6.0.1/firebase-ui-auth.js"></script>
						<script defer src="https://www.gstatic.com/firebasejs/10.1.0/firebase-app-compat.js"></script>
						<script defer src="https://www.gstatic.com/firebasejs/10.1.0/firebase-auth-compat.js"></script>
						<link type="text/css" rel="stylesheet" href="https://www.gstatic.com/firebasejs/ui/6.0.1/firebase-ui-auth.css" />

						<script type="module">
							const firebaseConfig = JSON.parse(document.querySelector('meta[name="firebaseConfig"]').content);
							const app = firebase.initializeApp(firebaseConfig);

							const auth = app.auth();

							auth.onAuthStateChanged(async (user) => {
								if (user) {
									document.getElementById('firebaseui-auth-container').style.display = 'none';
									document.getElementById('authenticated').style.display = 'block';
									const idToken = await user.getIdToken();
									document.getElementById('idToken').value = idToken;
								}
							});

							const ui = new firebaseui.auth.AuthUI(auth);
							ui.start('#firebaseui-auth-container', {
								signInOptions: [
									firebase.auth.GoogleAuthProvider.PROVIDER_ID,
								],
								callbacks: {
									signInSuccessWithAuthResult(authResult, redirectUrl) {
										console.log({authResult, redirectUrl});
										return false;
									},
								},
								signInFlow: 'popup',
							});
						</script>
					</head>
					<body>
						<div id="firebaseui-auth-container"></div>
						<div id="authenticated" style="display: none;">
							<pre>${JSON.stringify(req.query, null, '  ')}</pre>
							<form action="/oauth/authorize" accept-charset="UTF-8" method="post">
								<input type="hidden" name="client_id" id="client_id" value="${clientId}" autocomplete="off">
								<input type="hidden" name="redirect_uri" id="redirect_uri" value="${redirectUri}" autocomplete="off">
								<input type="hidden" name="response_type" id="response_type" value="${responseType}" autocomplete="off">
								<input type="hidden" name="scope" id="scope" value="${scope}" autocomplete="off">
								<!-- EXTRA_INPUTS -->
								<input type="hidden" name="idToken" id="idToken" value="" autocomplete="off">
								<button name="button" type="submit">承認</button>
							</form>
						</div>
					</body>
				</html>
			`;

	const renderedHtml =
		extraInputs.length > 0
			? baseHtml.replace('<!-- EXTRA_INPUTS -->', extraInputs.join('\n\t\t\t\t\t\t\t\t'))
			: baseHtml.replace('<!-- EXTRA_INPUTS -->\n', '');

	res.status(200).contentType('text/html').send(renderedHtml);
});

router.post('/authorize', async (req, res) => {
	const request = new OauthRequest(req);
	const response = new OauthResponse(res);

	const parsedBody = oauthAuthorizeBodySchema.safeParse(req.body);
	if (!parsedBody.success) {
		res.sendStatus(400);
		return;
	}

	const { idToken } = parsedBody.data;

	let authUser: firebase.auth.DecodedIdToken;
	try {
		authUser = await firebase.auth().verifyIdToken(idToken);
	} catch (error) {
		logger.error({
			type: 'oauthAuthorizeVerifyIdTokenError',
			error: error instanceof Error ? error.message : String(error),
		});
		res.status(400).send('Bad request');
		return;
	}

	logger.info({
		type: 'oauthAuthorizePost',
		uid: authUser.uid,
	});

	try {
		const token = await oauth.authorize(request, response, {
			allowEmptyState: true,
			authenticateHandler: {
				handle() {
					return {
						userId: authUser.uid,
					};
				},
			},
		});

		logger.info({
			type: 'oauthAuthorizePost',
			token: redactSensitiveBody(token),
			response: redactSensitiveBody(response.body),
		});

		// eslint-disable-next-line require-atomic-updates
		res.locals.oauth = { token };

		res.set(response.headers);
		res.status(response.status ?? 200).send(response.body);
	} catch (error) {
		logger.error({
			type: 'oauthAuthorizePost',
			error,
		});
		res.status(400).send('Bad request');
	}
});

router.post('/token', tokenCors, async (req, res) => {
	const parsedBody = oauthTokenBodySchema.safeParse(req.body);
	if (!parsedBody.success) {
		res.status(400).send('Bad request');
		return;
	}

	const request = new OauthRequest(req);
	const response = new OauthResponse(res);

	try {
		// Some application sends JSON instead of form-data (why?). This is a workaround.
		// https://github.com/elk-zone/elk/issues/2244
		if (request.headers?.['content-type'] === 'application/json') {
			request.headers['content-type'] = 'application/x-www-form-urlencoded';
		}

		const token = await oauth.token(request, response, {
			accessTokenLifetime: 24 * 60 * 60,
			refreshTokenLifetime: 30 * 24 * 60 * 60,
		});

		logger.info({
			type: 'oauthToken',
			token: redactSensitiveBody(token),
			response: redactSensitiveBody(response.body),
		});

		res.set(response.headers);
		res.status(response.status ?? 200).send(response.body);
	} catch (error) {
		logger.error({
			type: 'oauthTokenPost',
			error,
		});
		res.status(400).send('Bad request');
	}
});

router.post('/revoke', tokenCors, async (req, res) => {
	let body: Record<string, unknown> = {};
	if (typeof req.body === 'object' && req.body !== null) {
		body = req.body as Record<string, unknown>;
	}

	let clientId = typeof body.client_id === 'string' ? body.client_id : undefined;
	let clientSecret = typeof body.client_secret === 'string' ? body.client_secret : undefined;

	const authHeader = req.headers.authorization;
	if (authHeader?.startsWith('Basic ')) {
		try {
			const credentials = Buffer.from(authHeader.slice(6).trim(), 'base64').toString('utf-8');
			const colonIndex = credentials.indexOf(':');
			if (colonIndex !== -1) {
				clientId = decodeURIComponent(credentials.slice(0, colonIndex));
				clientSecret = decodeURIComponent(credentials.slice(colonIndex + 1));
			}
		} catch {
			// ignore malformed basic auth header
		}
	}

	if (!clientId) {
		res.status(401).json({
			error: 'invalid_client',
			error_description: 'Client authentication failed',
		});
		return;
	}

	const client = await oauthModel.getClient(clientId, clientSecret ?? null);
	if (!client) {
		res.status(401).json({
			error: 'invalid_client',
			error_description: 'Client authentication failed',
		});
		return;
	}

	const token = body.token;
	if (typeof token !== 'string' || token.length === 0) {
		res.status(400).json({
			error: 'invalid_request',
			error_description: 'Missing token parameter',
		});
		return;
	}

	const accessTokenDoc = await getFirstDoc(AccessTokens.where('accessToken', '==', token));
	if (accessTokenDoc) {
		const tokenData = accessTokenDoc.data();
		if (tokenData.client?.id !== client.id && tokenData.client?.clientId !== client.clientId) {
			res.status(403).json({
				error: 'unauthorized_client',
				error_description: 'You are not authorized to revoke this token',
			});
			return;
		}
		await oauthModel.revokeToken(tokenData);
		res.status(200).json({});
		return;
	}

	const refreshTokenDoc = await getFirstDoc(RefreshTokens.where('refreshToken', '==', token));
	if (refreshTokenDoc) {
		const tokenData = refreshTokenDoc.data();
		if (tokenData.client?.id !== client.id && tokenData.client?.clientId !== client.clientId) {
			res.status(403).json({
				error: 'unauthorized_client',
				error_description: 'You are not authorized to revoke this token',
			});
			return;
		}
		await oauthModel.revokeToken(tokenData);
		res.status(200).json({});
		return;
	}

	res.status(200).json({});
});

export default router;
