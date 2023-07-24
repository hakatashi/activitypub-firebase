import OAuth2Server, {Request as OauthRequest, Response as OauthResponse} from '@node-oauth/oauth2-server';
import {htmlEscape} from 'escape-goat';
import express from 'express';
import firebase from 'firebase-admin';
import {logger} from 'firebase-functions/v2';
import fetch from 'node-fetch';
import {projectId} from '../firebase.js';
import {Oauth2Model} from './oauth2Model.js';

const getFirebaseWebapps = async (accessToken: string) => {
	const endpoint = `https://firebase.googleapis.com/v1beta1/projects/${projectId}/webApps`;
	const response = await fetch(endpoint, {
		headers: {
			authorization: `Bearer ${accessToken}`,
		},
	});

	const data = (await response.json()) as {apps: {appId: string}[]};
	return data.apps;
};

const getFirebaseWebappConfig = async (accessToken: string, appId: string) => {
	const endpoint = `https://firebase.googleapis.com/v1beta1/projects/${projectId}/webApps/${appId}/config`;
	const response = await fetch(endpoint, {
		headers: {
			authorization: `Bearer ${accessToken}`,
		},
	});

	const data = (await response.json()) as {[key: string]: any};

	return data;
};

const getWebappConfig = async () => {
	const credential = firebase.credential.applicationDefault();
	const accessToken = await credential.getAccessToken();

	const apps = await getFirebaseWebapps(accessToken.access_token);
	if (apps.length === 0) {
		throw new Error('No webapp found');
	}

	const appId = apps[0].appId;
	const config = await getFirebaseWebappConfig(accessToken.access_token, appId);

	return config;
};

export const oauth = new OAuth2Server({
	model: new Oauth2Model(),
});

const router = express.Router();

router.get('/authorize', async (req, res) => {
	logger.info({
		type: 'oauthAuthorizeGet',
		params: req.query,
	});

	const config = await getWebappConfig();

	const clientId = req.query.client_id;
	const redirectUri = req.query.redirect_uri;
	const responseType = req.query.response_type;
	const scope = req.query.scope ?? 'scope';

	if (
		typeof clientId !== 'string' ||
		typeof redirectUri !== 'string' ||
		typeof responseType !== 'string' ||
		typeof scope !== 'string'
	) {
		res.status(400).send('Bad request');
		return;
	}

	res.status(200)
		.contentType('text/html')
		.send(
			htmlEscape`
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

							auth.onAuthStateChanged((user) => {
								console.log({user});
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
									uiShown() {
										document.getElementById('loader').style.display = 'none';
									},
								},
								signInFlow: 'popup',
							});
						</script>
					</head>
					<body>
						<div id="firebaseui-auth-container"></div>
						<div id="loader">Loading...</div>
						<pre>${JSON.stringify(req.query, null, '  ')}</pre>
						<form action="/oauth/authorize" accept-charset="UTF-8" method="post">
							<input type="hidden" name="client_id" id="client_id" value="${clientId}" autocomplete="off">
							<input type="hidden" name="redirect_uri" id="redirect_uri" value="${redirectUri}" autocomplete="off">
							<!-- <input type="hidden" name="state" id="state" autocomplete="off"> -->
							<input type="hidden" name="response_type" id="response_type" value="${responseType}" autocomplete="off">
							<input type="hidden" name="scope" id="scope" value="${scope}" autocomplete="off">
							<button name="button" type="submit">承認</button>
						</form>
					</body>
				</html>
			`,
		);
});

router.post('/authorize', async (req, res) => {
	const request = new OauthRequest(req);
	const response = new OauthResponse(res);

	try {
		const token = await oauth.authorize(request, response, {
			allowEmptyState: true,
			authenticateHandler: {
				handle() {
					// TODO: Implement session handling
					return {
						userId: '1337',
					};
				},
			},
		});

		logger.info({
			type: 'oauthAuthorizePost',
			token,
			response: response.body,
		});

		// eslint-disable-next-line require-atomic-updates
		res.locals.oauth = {token};

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

router.post('/token', async (req, res) => {
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
			token,
			response: response.body,
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

router.post('/revoke', (req, res) => {
	res.sendStatus(501);
});

export default router;
