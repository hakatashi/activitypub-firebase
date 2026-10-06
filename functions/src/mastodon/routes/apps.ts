import express from 'express';
import crypto from 'node:crypto';
import {
	OAuthError,
	Request as OauthRequest,
	Response as OauthResponse,
} from '@node-oauth/oauth2-server';
import { z } from 'zod';
import { db } from '../../firebase.js';
import { Clients } from '../../schema.js';
import type { MastodonClient } from '../../schema.js';
import { AuthenticationError, validScopes } from '../http/auth.js';
import { oauth } from '../oauth.js';

const router = express.Router();

export const createAppBodySchema = z.object({
	client_name: z.string().trim().min(1),
	redirect_uris: z.union([z.string().trim().min(1), z.array(z.string().trim().min(1)).min(1)]),
	scopes: z
		.string()
		.default('read')
		.refine((scopes) => scopes.split(' ').every((scope) => validScopes.includes(scope)), {
			message: 'Invalid scope included',
		}),
	website: z.string().default(''),
});

router.post('/v1/apps', async (req, res) => {
	const parsedBody = createAppBodySchema.safeParse(req.body ?? {});
	if (!parsedBody.success) {
		res.status(400).send('Bad request');
		return;
	}

	const { client_name: clientName, redirect_uris: redirectUrisRaw, scopes } = parsedBody.data;
	const website = parsedBody.data.website?.trim() ? parsedBody.data.website.trim() : null;

	const redirectUrisArray =
		typeof redirectUrisRaw === 'string'
			? redirectUrisRaw.trim().split(/\s+/)
			: redirectUrisRaw.map((uri) => uri.trim());
	const redirectUriString =
		typeof redirectUrisRaw === 'string'
			? redirectUrisRaw.trim()
			: redirectUrisRaw.map((uri) => uri.trim()).join('\n');

	const scopeSet = new Set<string>(scopes.split(' '));

	const clientId = crypto.randomBytes(32).toString('hex');
	const clientSecret = crypto.randomBytes(32).toString('hex');
	const vapidKey = crypto.randomBytes(32).toString('hex');

	const client = await db.runTransaction(async (transaction) => {
		const countSnapshot = await transaction.get(Clients.count());
		const id = (countSnapshot.data().count + 1).toString();
		const docRef = Clients.doc();
		const clientData: MastodonClient = {
			id,
			name: clientName,
			redirectUris: redirectUrisArray,
			grants: ['authorization_code', 'refresh_token'],
			clientId,
			clientSecret,
			scopes: Array.from(scopeSet),
			vapidKey,
			...(website ? { website } : {}),
		};
		transaction.set(docRef, clientData);
		return clientData;
	});

	res.json({
		id: client.id,
		name: client.name,
		website,
		scopes: Array.from(scopeSet),
		redirect_uri: redirectUriString,
		redirect_uris: redirectUrisArray,
		client_id: clientId,
		client_secret: clientSecret,
		client_secret_expires_at: 0,
		vapid_key: vapidKey,
	});
});

router.get('/v1/apps/verify_credentials', async (req, res, next) => {
	try {
		const request = new OauthRequest(req);
		const response = new OauthResponse(res);
		let token;
		try {
			token = await oauth.authenticate(request, response);
		} catch (error) {
			if (response.headers) {
				res.set(response.headers);
			}
			throw error;
		}
		const client = token.client as MastodonClient;

		let redirectUris: string[] = [];
		if (Array.isArray(client.redirectUris)) {
			redirectUris = client.redirectUris;
		} else if (typeof client.redirectUris === 'string' && client.redirectUris.length > 0) {
			redirectUris = client.redirectUris.split(/\s+/);
		}

		res.json({
			id: client.id,
			name: client.name,
			website: client.website ?? null,
			scopes: client.scopes ?? [],
			redirect_uri: redirectUris[0] ?? '',
			redirect_uris: redirectUris,
			vapid_key: client.vapidKey,
		});
	} catch (error) {
		if (error instanceof OAuthError || error instanceof AuthenticationError) {
			const status = (error as { statusCode?: number }).statusCode ?? 401;
			res.status(status).json({
				error: error.message,
			});
			return;
		}
		next(error);
	}
});

export default router;
