import { verify } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { first, isRecord } from '../values.js';
import { getApex, getLocals } from './locals.js';

export interface SignatureHeader {
	keyId: string;
	algorithm: string;
	headers: string[];
	signature: string;
}

export const requireAuthorized = (_req: Request, res: Response, next: NextFunction): void => {
	const locals = getLocals(res);
	if (!locals.authorized) {
		res.sendStatus(403);
		return;
	}
	next();
};

export const requireAuthorizedOrPublic = (
	req: Request,
	res: Response,
	next: NextFunction,
): void => {
	const apex = getApex(req);
	const locals = getLocals(res);
	if (locals.target && !(apex.isPublic(locals.target) || locals.authorized)) {
		res.sendStatus(403);
		return;
	}
	next();
};

// PassportJS などが req.user に載せる認証済みユーザー
const authenticatedUsername = (req: Request): string | undefined => {
	const user: unknown = 'user' in req ? req.user : undefined;
	return isRecord(user) && typeof user.username === 'string' && user.username
		? user.username
		: undefined;
};

export const verifyAuthorization = (req: Request, res: Response, next: NextFunction): void => {
	const apex = getApex(req);
	const locals = getLocals(res);
	// if not already set, check for PassportJS-style auth
	if (locals.authorizedUserId === undefined || locals.authorizedUserId === null) {
		const username = authenticatedUsername(req);
		locals.authorizedUserId = username && apex.utils.usernameToIRI(username);
	}
	// if not already set, check authorization via ownership
	if (locals.authorized === undefined || locals.authorized === null) {
		locals.authorized = Boolean(
			locals.target &&
			locals.authorizedUserId &&
			apex.validateOwner(locals.target, { id: locals.authorizedUserId }),
		);
	}
	next();
};

const signatureParamPattern = /^\s*(?<name>[A-Za-z]+)\s*=\s*"(?<value>[^"]*)"\s*$/;

export const parseSignatureHeader = (rawHeader: unknown): SignatureHeader | null => {
	if (!rawHeader || typeof rawHeader !== 'string') {
		return null;
	}
	let header = rawHeader.trim();
	if (header.toLowerCase().startsWith('signature ')) {
		header = header.slice('signature '.length).trim();
	}
	const params = new Map<string, string>();
	for (const part of header.split(',')) {
		const match = signatureParamPattern.exec(part);
		if (!match?.groups?.name || match.groups.value === undefined) {
			return null;
		}
		params.set(match.groups.name, match.groups.value);
	}
	const keyId = params.get('keyId');
	const signature = params.get('signature');
	if (!keyId || !signature) {
		return null;
	}
	const headersParam = params.get('headers');
	const headers = headersParam ? headersParam.toLowerCase().split(/\s+/).filter(Boolean) : ['date'];
	return {
		keyId,
		algorithm: (params.get('algorithm') || 'rsa-sha256').toLowerCase(),
		headers,
		signature,
	};
};

export const buildStringToSign = (req: Request, headerNames: string[]): string | null => {
	const lines = [];
	for (const name of headerNames) {
		const lowerName = name.toLowerCase();
		if (lowerName === '(request-target)') {
			const path = req.originalUrl || req.url;
			lines.push(`(request-target): ${req.method.toLowerCase()} ${path}`);
		} else if (lowerName === 'host') {
			const host = req.get('host') ?? req.headers.host;
			if (host === undefined) {
				return null;
			}
			lines.push(`host: ${host}`);
		} else {
			const val = req.get(lowerName) ?? req.headers[lowerName];
			if (val === undefined) {
				return null;
			}
			lines.push(`${lowerName}: ${String(val)}`);
		}
	}
	return lines.join('\n');
};

const hashAlgorithms = new Map([
	['rsa-sha256', 'sha256'],
	['hs2019', 'sha256'],
	['rsa-sha512', 'sha512'],
	['rsa-sha1', 'sha1'],
]);

export const verifyHttpSignature = (
	sigHead: SignatureHeader,
	stringToSign: string,
	publicKeyPem: string,
): boolean => {
	const hashAlgo = hashAlgorithms.get(sigHead.algorithm.toLowerCase());
	if (hashAlgo === undefined) {
		return false;
	}

	try {
		const signatureBuffer = Buffer.from(sigHead.signature, 'base64');
		return verify(hashAlgo, Buffer.from(stringToSign, 'utf-8'), publicKeyPem, signatureBuffer);
	} catch {
		return false;
	}
};

const publicKeyPemOf = (signer: unknown): string | undefined => {
	if (!isRecord(signer)) {
		return undefined;
	}
	const publicKey = first(signer.publicKey);
	if (!isRecord(publicKey)) {
		return undefined;
	}
	const pem = first(publicKey.publicKeyPem);
	return typeof pem === 'string' && pem ? pem : undefined;
};

export const verifySignature = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	const apex = getApex(req);
	const locals = getLocals(res);
	const signatureHeader = req.get('signature') || req.get('authorization');

	if (!signatureHeader) {
		if (req.app.get('env') !== 'development') {
			apex.logger.warn('Request rejected: missing http signature');
			res.status(401).send('Missing http signature');
			return;
		}
		try {
			const actor = await apex.resolveObject(apex.actorIdFromActivity(req.body));
			locals.sender = actor;
			next();
		} catch (err) {
			apex.logger.warn('error resolving actor in dev mode', err);
			res.status(500).send();
		}
		return;
	}

	const sigHead = parseSignatureHeader(signatureHeader);
	if (!sigHead) {
		apex.logger.warn('Request rejected: unsupported or invalid signature header format');
		res.status(403).send('Invalid http signature');
		return;
	}

	const stringToSign = buildStringToSign(req, sigHead.headers);
	if (stringToSign === null) {
		apex.logger.warn('Request rejected: signed headers missing from request');
		res.status(403).send('Invalid http signature');
		return;
	}

	const body: unknown = req.body;
	const type =
		isRecord(body) && typeof body.type === 'string' && body.type ? body.type.toLowerCase() : '';
	let cached = true;
	let signer;
	try {
		signer = await apex.resolveObject(sigHead.keyId, false, false, true);
		if (
			(type === 'delete' || type === 'update') &&
			(!signer || signer.type.toLowerCase() === 'tombstone')
		) {
			console.log(
				'Ignoring unverifiable %s from %s',
				type,
				isRecord(body) ? body.actor : undefined,
			);
			// user delete message that can't be verified because we don't have the user cached
			res.status(200).send();
			return;
		}
		if (!signer) {
			console.log('Fetching actor to verify signature %s', sigHead.keyId);
			cached = false;
			signer = await apex.resolveObject(sigHead.keyId);
		}
	} catch (err) {
		apex.logger.warn('error resolving signer for signature verification', err);
		res.status(500).send();
		return;
	}

	const signerKey = publicKeyPemOf(signer);
	if (!signer || signerKey === undefined) {
		apex.logger.warn('Could not find key for %s %j', sigHead.keyId, signer);
		res.status(403).send('Invalid http signature');
		return;
	}

	let valid = verifyHttpSignature(sigHead, stringToSign, signerKey);
	if (!valid && cached) {
		console.log('Refreshing key for %s', sigHead.keyId);
		// try refreshing cached key in case of key rotation
		try {
			signer = await apex.resolveObject(sigHead.keyId, false, true);
		} catch (err) {
			apex.logger.warn('error refreshing key for signature verification', err);
			res.status(500).send();
			return;
		}
		const refreshedKey = publicKeyPemOf(signer);
		if (refreshedKey !== undefined) {
			valid = verifyHttpSignature(sigHead, stringToSign, refreshedKey);
		}
	}

	if (!valid) {
		apex.logger.warn('Request rejected: invalid http signature');
		res.status(403).send('Invalid http signature');
		return;
	}

	locals.sender = signer;
	next();
};
