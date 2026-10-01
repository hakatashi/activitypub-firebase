import { constants, createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { APObject } from '../types.js';
import { first, isRecord } from '../values.js';
import { getApex, getLocals } from './locals.js';

export interface SignatureHeader {
	keyId: string;
	algorithm: string;
	headers: string[];
	signature: string;
	created?: number | undefined;
	expires?: number | undefined;
}

export interface Rfc9421Signature {
	label: string;
	components: string[];
	keyId: string;
	signature: string;
	created?: number | undefined;
	expires?: number | undefined;
	alg?: string | undefined;
	signatureParams: string;
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
	const createdParam = params.get('created');
	const created =
		createdParam !== undefined && /^\d+$/.test(createdParam)
			? parseInt(createdParam, 10)
			: undefined;
	const expiresParam = params.get('expires');
	const expires =
		expiresParam !== undefined && /^\d+$/.test(expiresParam)
			? parseInt(expiresParam, 10)
			: undefined;
	return {
		keyId,
		algorithm: (params.get('algorithm') || 'rsa-sha256').toLowerCase(),
		headers,
		signature,
		created,
		expires,
	};
};

export const buildStringToSign = (
	req: Request,
	headerNames: string[],
	sigHead?: SignatureHeader,
): string | null => {
	const lines = [];
	for (const name of headerNames) {
		const lowerName = name.toLowerCase();
		if (lowerName === '(request-target)') {
			const path = req.originalUrl || req.url;
			lines.push(`(request-target): ${req.method.toLowerCase()} ${path}`);
		} else if (lowerName === '(created)') {
			if (sigHead?.created === undefined) {
				return null;
			}
			lines.push(`(created): ${sigHead.created}`);
		} else if (lowerName === '(expires)') {
			if (sigHead?.expires === undefined) {
				return null;
			}
			lines.push(`(expires): ${sigHead.expires}`);
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

const publicKeyPemOf = (signer: unknown, keyId?: string): string | undefined => {
	if (!isRecord(signer)) {
		return undefined;
	}
	if (typeof signer.publicKeyPem === 'string' && signer.publicKeyPem) {
		return signer.publicKeyPem;
	}
	const directPem = first(signer.publicKeyPem);
	if (typeof directPem === 'string' && directPem) {
		return directPem;
	}
	if (Array.isArray(signer.publicKey)) {
		if (keyId) {
			const matchingKey = signer.publicKey.find(
				(k) => isRecord(k) && (k.id === keyId || first(k.id) === keyId),
			);
			if (matchingKey && isRecord(matchingKey)) {
				const pem = first(matchingKey.publicKeyPem);
				if (typeof pem === 'string' && pem) {
					return pem;
				}
			}
		}
		const firstKey = signer.publicKey[0];
		if (isRecord(firstKey)) {
			const pem = first(firstKey.publicKeyPem);
			if (typeof pem === 'string' && pem) {
				return pem;
			}
		}
	} else if (isRecord(signer.publicKey)) {
		const pem = first(signer.publicKey.publicKeyPem);
		return typeof pem === 'string' && pem ? pem : undefined;
	}
	return undefined;
};

export const splitStructuredDictionary = (header: string): string[] => {
	const members: string[] = [];
	let current = '';
	let inQuote = false;
	let inParen = false;
	let escape = false;

	for (let i = 0; i < header.length; i++) {
		const char = header[i];
		if (escape) {
			current += char;
			escape = false;
			continue;
		}
		if (char === '\\') {
			current += char;
			escape = true;
			continue;
		}
		if (char === '"') {
			inQuote = !inQuote;
			current += char;
			continue;
		}
		if (!inQuote) {
			if (char === '(') {
				inParen = true;
			} else if (char === ')') {
				inParen = false;
			} else if (char === ',' && !inParen) {
				if (current.trim()) {
					members.push(current.trim());
				}
				current = '';
				continue;
			}
		}
		current += char;
	}
	if (current.trim()) {
		members.push(current.trim());
	}
	return members;
};

export const splitParameters = (paramStr: string): Map<string, string> => {
	const params = new Map<string, string>();
	for (const part of paramStr.split(';')) {
		const trimmed = part.trim();
		if (!trimmed) {
			continue;
		}
		const eq = trimmed.indexOf('=');
		if (eq === -1) {
			params.set(trimmed.toLowerCase(), '');
		} else {
			const name = trimmed.slice(0, eq).trim().toLowerCase();
			let val = trimmed.slice(eq + 1).trim();
			if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
				val = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
			}
			params.set(name, val);
		}
	}
	return params;
};

export const parseInnerListComponents = (innerListContent: string): string[] | null => {
	const components: string[] = [];
	let idx = 0;
	const len = innerListContent.length;

	while (idx < len) {
		while (idx < len && innerListContent[idx] === ' ') {
			idx++;
		}
		if (idx >= len) {
			break;
		}

		const start = idx;
		if (innerListContent[idx] !== '"') {
			return null;
		}
		idx++;
		let escape = false;
		let closedQuote = false;
		while (idx < len) {
			if (escape) {
				escape = false;
				idx++;
				continue;
			}
			if (innerListContent[idx] === '\\') {
				escape = true;
				idx++;
				continue;
			}
			if (innerListContent[idx] === '"') {
				closedQuote = true;
				idx++;
				break;
			}
			idx++;
		}
		if (!closedQuote) {
			return null;
		}

		while (idx < len && innerListContent[idx] !== ' ') {
			idx++;
		}
		components.push(innerListContent.slice(start, idx));
	}
	return components;
};

export const parseRfc9421Headers = (
	signatureInputHeader: unknown,
	signatureHeader: unknown,
): Rfc9421Signature | null => {
	if (
		typeof signatureInputHeader !== 'string' ||
		!signatureInputHeader.trim() ||
		typeof signatureHeader !== 'string' ||
		!signatureHeader.trim()
	) {
		return null;
	}

	let sigHeader = signatureHeader.trim();
	if (sigHeader.toLowerCase().startsWith('signature ')) {
		sigHeader = sigHeader.slice('signature '.length).trim();
	}

	const inputMembers = splitStructuredDictionary(signatureInputHeader);
	const sigMembers = splitStructuredDictionary(sigHeader);
	if (inputMembers.length === 0 || sigMembers.length === 0) {
		return null;
	}

	const signaturesByLabel = new Map<string, string>();
	for (const sigMember of sigMembers) {
		const match =
			/^\s*(?<label>[a-zA-Z*][a-zA-Z0-9_.*-]*)\s*=\s*:(?<sig>[A-Za-z0-9+/=]+):\s*(?:;.*)?$/.exec(
				sigMember,
			);
		if (match?.groups?.label && match.groups.sig) {
			signaturesByLabel.set(match.groups.label.toLowerCase(), match.groups.sig);
		}
	}

	for (const member of inputMembers) {
		const eqIdx = member.indexOf('=');
		if (eqIdx === -1) {
			continue;
		}
		const label = member.slice(0, eqIdx).trim();
		if (!/^[a-zA-Z*][a-zA-Z0-9_.*-]*$/.test(label)) {
			continue;
		}

		const rest = member.slice(eqIdx + 1).trim();
		if (!rest.startsWith('(')) {
			continue;
		}

		let parenDepth = 0;
		let inQuote = false;
		let escape = false;
		let closeParenIdx = -1;
		for (let i = 0; i < rest.length; i++) {
			const char = rest[i];
			if (escape) {
				escape = false;
				continue;
			}
			if (char === '\\') {
				escape = true;
				continue;
			}
			if (char === '"') {
				inQuote = !inQuote;
				continue;
			}
			if (!inQuote) {
				if (char === '(') {
					parenDepth++;
				} else if (char === ')') {
					parenDepth--;
					if (parenDepth === 0) {
						closeParenIdx = i;
						break;
					}
				}
			}
		}
		if (closeParenIdx === -1) {
			continue;
		}

		const innerListContent = rest.slice(1, closeParenIdx).trim();
		const components = parseInnerListComponents(innerListContent);
		if (!components) {
			continue;
		}

		const paramPart = rest.slice(closeParenIdx + 1);
		const params = splitParameters(paramPart);

		const keyId = params.get('keyid');
		if (!keyId) {
			continue;
		}

		const sigBytes = signaturesByLabel.get(label.toLowerCase());
		if (!sigBytes) {
			continue;
		}

		const createdStr = params.get('created');
		const created = createdStr && /^\d+$/.test(createdStr) ? parseInt(createdStr, 10) : undefined;

		const expiresStr = params.get('expires');
		const expires = expiresStr && /^\d+$/.test(expiresStr) ? parseInt(expiresStr, 10) : undefined;

		const alg = params.get('alg')?.toLowerCase();

		return {
			label,
			components,
			keyId,
			signature: sigBytes,
			created,
			expires,
			alg,
			signatureParams: rest,
		};
	}

	return null;
};

export const parseContentDigest = (rawHeader: unknown): string | null => {
	if (!rawHeader || typeof rawHeader !== 'string') {
		return null;
	}
	const members = splitStructuredDictionary(rawHeader);
	for (const member of members) {
		const match = /^\s*(?<algo>[A-Za-z0-9_-]+)\s*=\s*:(?<digest>[A-Za-z0-9+/=]+):\s*(?:;.*)?$/.exec(
			member,
		);
		if (match?.groups?.algo?.toLowerCase() === 'sha-256' && match.groups.digest) {
			return match.groups.digest;
		}
	}
	return null;
};

export const buildRfc9421SignatureBase = (
	req: Request,
	sig: Rfc9421Signature,
	apex: ReturnType<typeof getApex>,
): string | null => {
	const lines: string[] = [];
	for (const comp of sig.components) {
		const quoteClose = comp.indexOf('"', 1);
		const name = quoteClose === -1 ? comp.toLowerCase() : comp.slice(1, quoteClose).toLowerCase();
		const paramPart = comp.slice(quoteClose + 1);
		const params = splitParameters(paramPart);

		let val: string;
		if (name === '@method') {
			val = req.method;
		} else if (name === '@target-uri') {
			const fullPath = req.originalUrl || req.url;
			if (fullPath.startsWith('http://') || fullPath.startsWith('https://')) {
				val = fullPath;
			} else {
				const host = (req.get('host') ?? req.headers.host ?? apex.domain)
					?.toLowerCase()
					.replace(/:(?:80|443)$/, '');
				if (!host) {
					return null;
				}
				const proto = (
					req.get('x-forwarded-proto') ??
					(req as { protocol?: string }).protocol ??
					'https'
				).toLowerCase();
				const normalizedPath = fullPath.startsWith('/') ? fullPath : `/${fullPath}`;
				val = `${proto}://${host}${normalizedPath}`;
			}
		} else if (name === '@authority') {
			const host = (req.get('host') ?? req.headers.host ?? apex.domain)
				?.toLowerCase()
				.replace(/:(?:80|443)$/, '');
			if (!host) {
				return null;
			}
			val = host;
		} else if (name === '@scheme') {
			val = (
				req.get('x-forwarded-proto') ??
				(req as { protocol?: string }).protocol ??
				'https'
			).toLowerCase();
		} else if (name === '@path') {
			const fullPath = req.originalUrl || req.url;
			const pathOnly =
				(fullPath.startsWith('http://') || fullPath.startsWith('https://')
					? new URL(fullPath).pathname
					: fullPath.split('?')[0]) ?? '';
			const normalizedPath = pathOnly.startsWith('/') ? pathOnly : `/${pathOnly}`;
			val = normalizedPath || '/';
		} else if (name === '@query') {
			const fullPath = req.originalUrl || req.url;
			const queryIdx = fullPath.indexOf('?');
			val = queryIdx === -1 ? '' : fullPath.slice(queryIdx);
		} else if (name === '@request-target') {
			const fullPath = req.originalUrl || req.url;
			val =
				fullPath.startsWith('http://') || fullPath.startsWith('https://')
					? new URL(fullPath).pathname + new URL(fullPath).search
					: fullPath;
		} else if (name === '@query-param') {
			const paramName = params.get('name');
			if (!paramName) {
				return null;
			}
			const fullPath = req.originalUrl || req.url;
			const url = new URL(
				fullPath.startsWith('http://') || fullPath.startsWith('https://')
					? fullPath
					: `https://dummy.example${fullPath.startsWith('/') ? '' : '/'}${fullPath}`,
			);
			const paramVal = url.searchParams.get(paramName);
			if (paramVal === null) {
				return null;
			}
			val = encodeURIComponent(paramVal);
		} else if (name.startsWith('@')) {
			return null;
		} else {
			const headerVal = req.get(name) ?? req.headers[name];
			if (headerVal === undefined) {
				return null;
			}
			val = Array.isArray(headerVal)
				? headerVal.map((v) => String(v).trim()).join(', ')
				: String(headerVal).trim();
		}

		const serializedComp = comp.startsWith('"') ? comp : `"${comp}"`;
		lines.push(`${serializedComp}: ${val}`);
	}

	lines.push(`"@signature-params": ${sig.signatureParams}`);
	const base = lines.join('\n');
	if ([...base].some((char) => char.charCodeAt(0) > 127)) {
		return null;
	}
	return base;
};

export const verifyRfc9421Signature = (
	sig: Rfc9421Signature,
	signatureBase: string,
	publicKeyPem: string,
): boolean => {
	const alg = sig.alg?.toLowerCase();
	try {
		const keyObj = createPublicKey(publicKeyPem);
		const signatureBuffer = Buffer.from(sig.signature, 'base64');
		const baseBuffer = Buffer.from(signatureBase, 'utf-8');

		if (alg === 'rsa-pss-sha512') {
			return verify(
				'sha512',
				baseBuffer,
				{
					key: keyObj,
					padding: constants.RSA_PKCS1_PSS_PADDING,
					saltLength: 64,
				},
				signatureBuffer,
			);
		}

		if (alg === 'ed25519' || keyObj.asymmetricKeyType === 'ed25519') {
			return verify(null, baseBuffer, keyObj, signatureBuffer);
		}

		if (alg === undefined || alg === 'rsa-v1_5-sha256') {
			return verify('sha256', baseBuffer, keyObj, signatureBuffer);
		}

		return false;
	} catch {
		return false;
	}
};

export const getRequestBodyBuffer = (req: Request): Buffer | undefined => {
	const rawBody = (req as { rawBody?: unknown }).rawBody;
	if (Buffer.isBuffer(rawBody)) {
		return rawBody;
	}
	if (typeof rawBody === 'string') {
		return Buffer.from(rawBody, 'utf-8');
	}
	if (Buffer.isBuffer(req.body)) {
		return req.body;
	}
	if (typeof req.body === 'string') {
		return Buffer.from(req.body, 'utf-8');
	}
	if (isRecord(req.body)) {
		return Buffer.from(JSON.stringify(req.body), 'utf-8');
	}
	return undefined;
};

const resolveSignerAndKey = async (
	apex: ReturnType<typeof getApex>,
	keyId: string,
	req: Request,
	res: Response,
): Promise<{ signer: APObject; signerKey: string; cached: boolean } | null | 'handled'> => {
	const body: unknown = req.body;
	const type =
		isRecord(body) && typeof body.type === 'string' && body.type ? body.type.toLowerCase() : '';
	let cached = true;
	let signer;
	try {
		signer = await apex.resolveObject(keyId, false, false, true);
		if (
			(type === 'delete' || type === 'update') &&
			(!signer || signer.type.toLowerCase() === 'tombstone')
		) {
			console.log(
				'Ignoring unverifiable %s from %s',
				type,
				isRecord(body) ? body.actor : undefined,
			);
			res.status(200).send();
			return 'handled';
		}
		if (!signer) {
			console.log('Fetching actor to verify signature %s', keyId);
			cached = false;
			signer = await apex.resolveObject(keyId);
		}
	} catch (err) {
		apex.logger.warn('error resolving signer for signature verification', err);
		res.status(500).send();
		return null;
	}

	let signerKey = publicKeyPemOf(signer, keyId);
	if (!signerKey && signer && isRecord(signer) && signer.owner) {
		const ownerId = first(signer.owner);
		if (typeof ownerId === 'string') {
			signer = await apex.resolveObject(ownerId, false, false, cached);
			signerKey = publicKeyPemOf(signer, keyId);
		}
	}
	if (!signer || signerKey === undefined) {
		apex.logger.warn(
			'Could not find key for %s (signer id: %s, type: %s)',
			keyId,
			signer?.id,
			signer?.type,
		);
		res.status(403).send('Invalid http signature');
		return null;
	}

	return { signer, signerKey, cached };
};

const CLOCK_SKEW_MARGIN_MS = 60 * 60 * 1000; // 1 hour
const EXPIRATION_WINDOW_LIMIT_MS = 12 * 60 * 60 * 1000; // 12 hours

export const verifySignature = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	const apex = getApex(req);
	const locals = getLocals(res);
	const signatureInputHeader = req.get('signature-input');
	const rawSignatureHeader = req.get('signature') || req.get('authorization');

	if (!rawSignatureHeader && !signatureInputHeader) {
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

	if (signatureInputHeader) {
		const rfcSig = parseRfc9421Headers(signatureInputHeader, rawSignatureHeader);
		if (!rfcSig) {
			apex.logger.warn('Request rejected: unsupported or invalid signature header format');
			res.status(403).send('Invalid http signature');
			return;
		}

		const componentNames = rfcSig.components.map((c) => {
			const quoteClose = c.indexOf('"', 1);
			return quoteClose === -1 ? c.toLowerCase() : c.slice(1, quoteClose).toLowerCase();
		});

		if (!componentNames.includes('@method')) {
			apex.logger.warn('Request rejected: RFC 9421 signature must include @method component');
			res.status(403).send('Invalid http signature');
			return;
		}

		const hasTargetUri = componentNames.includes('@target-uri');
		const hasPathAndAuthority =
			componentNames.includes('@path') &&
			(componentNames.includes('@authority') || componentNames.includes('host'));
		if (!hasTargetUri && !hasPathAndAuthority) {
			apex.logger.warn(
				'Request rejected: RFC 9421 signature must include @target-uri or (@path and @authority/host)',
			);
			res.status(403).send('Invalid http signature');
			return;
		}

		const isPost = req.method.toLowerCase() === 'post';
		if (
			isPost &&
			!componentNames.includes('content-digest') &&
			!componentNames.includes('digest')
		) {
			apex.logger.warn(
				'Request rejected: POST request signature must include content-digest or digest component',
			);
			res.status(403).send('Invalid http signature');
			return;
		}

		let requestTimeMs: number | undefined;
		if (rfcSig.created !== undefined) {
			requestTimeMs = rfcSig.created * 1000;
		} else if (componentNames.includes('date')) {
			const dateHeader = req.get('date') ?? req.headers.date;
			if (typeof dateHeader === 'string') {
				const parsed = Date.parse(dateHeader);
				if (!Number.isNaN(parsed)) {
					requestTimeMs = parsed;
				}
			}
		}

		if (requestTimeMs === undefined) {
			apex.logger.warn('Request rejected: missing or invalid created/date in signature');
			res.status(403).send('Invalid http signature');
			return;
		}

		const now = Date.now();
		if (requestTimeMs > now + CLOCK_SKEW_MARGIN_MS) {
			apex.logger.warn('Request rejected: request date is in the future');
			res.status(403).send('Invalid http signature');
			return;
		}

		const expiresTimeMs =
			rfcSig.expires === undefined
				? requestTimeMs + EXPIRATION_WINDOW_LIMIT_MS
				: Math.min(rfcSig.expires * 1000, requestTimeMs + EXPIRATION_WINDOW_LIMIT_MS);

		if (now > expiresTimeMs + CLOCK_SKEW_MARGIN_MS) {
			apex.logger.warn('Request rejected: request date is outside acceptable time window');
			res.status(403).send('Invalid http signature');
			return;
		}

		if (componentNames.includes('content-digest')) {
			const contentDigestHeader = req.get('content-digest') ?? req.headers['content-digest'];
			const providedDigest = parseContentDigest(contentDigestHeader);
			if (!providedDigest) {
				apex.logger.warn(
					'Request rejected: content-digest header missing or does not contain sha-256',
				);
				res.status(403).send('Invalid http signature');
				return;
			}

			const bodyBuffer = getRequestBodyBuffer(req);
			if (!bodyBuffer) {
				apex.logger.warn('Request rejected: unable to verify digest without raw request body');
				res.status(403).send('Invalid http signature');
				return;
			}

			const computedDigest = createHash('sha256').update(bodyBuffer).digest('base64');
			const providedBuffer = Buffer.from(providedDigest, 'base64');
			const computedBuffer = Buffer.from(computedDigest, 'base64');
			if (
				providedBuffer.length !== 32 ||
				computedBuffer.length !== 32 ||
				!timingSafeEqual(providedBuffer, computedBuffer)
			) {
				apex.logger.warn('Request rejected: body digest mismatch');
				res.status(403).send('Invalid http signature');
				return;
			}
		} else if (componentNames.includes('digest')) {
			const digestHeader = req.get('digest') ?? req.headers.digest;
			if (typeof digestHeader !== 'string') {
				apex.logger.warn('Request rejected: missing digest header');
				res.status(403).send('Invalid http signature');
				return;
			}

			let providedDigest: string | undefined;
			const digestPairs = digestHeader.split(',').map((part) => {
				const eqIdx = part.indexOf('=');
				if (eqIdx === -1) {
					return ['', part.trim()];
				}
				return [part.slice(0, eqIdx).trim().toLowerCase(), part.slice(eqIdx + 1).trim()];
			});
			const sha256Pair = digestPairs.find(([algo]) => algo === 'sha-256');
			if (sha256Pair?.[1]) {
				providedDigest = sha256Pair[1];
			} else if (digestPairs.length === 1 && digestPairs[0]?.[0] === '' && digestPairs[0][1]) {
				providedDigest = digestPairs[0][1];
			}

			if (!providedDigest) {
				apex.logger.warn(
					'Request rejected: digest header does not contain supported sha-256 algorithm',
				);
				res.status(403).send('Invalid http signature');
				return;
			}

			const bodyBuffer = getRequestBodyBuffer(req);
			if (!bodyBuffer) {
				apex.logger.warn('Request rejected: unable to verify digest without raw request body');
				res.status(403).send('Invalid http signature');
				return;
			}

			const computedDigest = createHash('sha256').update(bodyBuffer).digest('base64');
			const providedBuffer = Buffer.from(providedDigest, 'base64');
			const computedBuffer = Buffer.from(computedDigest, 'base64');
			if (
				providedBuffer.length !== 32 ||
				computedBuffer.length !== 32 ||
				!timingSafeEqual(providedBuffer, computedBuffer)
			) {
				apex.logger.warn('Request rejected: body digest mismatch');
				res.status(403).send('Invalid http signature');
				return;
			}
		}

		const stringToSign = buildRfc9421SignatureBase(req, rfcSig, apex);
		if (stringToSign === null) {
			apex.logger.warn('Request rejected: signed headers or components missing from request');
			res.status(403).send('Invalid http signature');
			return;
		}

		const signerResult = await resolveSignerAndKey(apex, rfcSig.keyId, req, res);
		if (signerResult === null || signerResult === 'handled') {
			return;
		}
		let signer = signerResult.signer;
		const { signerKey, cached } = signerResult;

		let valid = verifyRfc9421Signature(rfcSig, stringToSign, signerKey);
		if (!valid && cached) {
			console.log('Refreshing key for %s', rfcSig.keyId);
			let refreshed: APObject | undefined;
			try {
				refreshed = await apex.resolveObject(rfcSig.keyId, false, true);
			} catch (err) {
				apex.logger.warn('error refreshing key for signature verification', err);
				res.status(500).send();
				return;
			}
			let refreshedKey = publicKeyPemOf(refreshed, rfcSig.keyId);
			if (!refreshedKey && refreshed && isRecord(refreshed) && refreshed.owner) {
				const ownerId = first(refreshed.owner);
				if (typeof ownerId === 'string') {
					refreshed = await apex.resolveObject(ownerId, false, true);
					refreshedKey = publicKeyPemOf(refreshed, rfcSig.keyId);
				}
			}
			if (refreshed && refreshedKey !== undefined) {
				signer = refreshed;
				valid = verifyRfc9421Signature(rfcSig, stringToSign, refreshedKey);
			}
		}

		if (!valid) {
			apex.logger.warn('Request rejected: invalid RFC 9421 signature');
			res.status(403).send('Invalid http signature');
			return;
		}

		locals.sender = signer;
		next();
		return;
	}

	const sigHead = parseSignatureHeader(rawSignatureHeader);
	if (!sigHead) {
		apex.logger.warn('Request rejected: unsupported or invalid signature header format');
		res.status(403).send('Invalid http signature');
		return;
	}

	const stringToSign = buildStringToSign(req, sigHead.headers, sigHead);
	if (stringToSign === null) {
		apex.logger.warn('Request rejected: signed headers missing from request');
		res.status(403).send('Invalid http signature');
		return;
	}

	const signedHeaders = sigHead.headers;
	if (!signedHeaders.includes('date') && !signedHeaders.includes('(created)')) {
		apex.logger.warn('Request rejected: signature must include date or (created) header');
		res.status(403).send('Invalid http signature');
		return;
	}

	if (req.method.toLowerCase() === 'post' && !signedHeaders.includes('digest')) {
		apex.logger.warn('Request rejected: POST request signature must include digest header');
		res.status(403).send('Invalid http signature');
		return;
	}

	let requestTimeMs: number | undefined;
	if (signedHeaders.includes('(created)') && sigHead.created !== undefined) {
		requestTimeMs = sigHead.created * 1000;
	} else {
		const dateHeader = req.get('date') ?? req.headers.date;
		if (typeof dateHeader === 'string') {
			const parsed = Date.parse(dateHeader);
			if (!Number.isNaN(parsed)) {
				requestTimeMs = parsed;
			}
		}
	}

	if (requestTimeMs === undefined) {
		apex.logger.warn('Request rejected: missing or invalid date in request');
		res.status(403).send('Invalid http signature');
		return;
	}

	const now = Date.now();
	if (requestTimeMs > now + CLOCK_SKEW_MARGIN_MS) {
		apex.logger.warn('Request rejected: request date is in the future');
		res.status(403).send('Invalid http signature');
		return;
	}

	const expiresTimeMs =
		sigHead.expires === undefined
			? requestTimeMs + EXPIRATION_WINDOW_LIMIT_MS
			: Math.min(sigHead.expires * 1000, requestTimeMs + EXPIRATION_WINDOW_LIMIT_MS);

	if (now > expiresTimeMs + CLOCK_SKEW_MARGIN_MS) {
		apex.logger.warn('Request rejected: request date is outside acceptable time window');
		res.status(403).send('Invalid http signature');
		return;
	}

	if (signedHeaders.includes('digest')) {
		const digestHeader = req.get('digest') ?? req.headers.digest;
		if (typeof digestHeader !== 'string') {
			apex.logger.warn('Request rejected: missing digest header');
			res.status(403).send('Invalid http signature');
			return;
		}

		let providedDigest: string | undefined;
		const digestPairs = digestHeader.split(',').map((part) => {
			const eqIdx = part.indexOf('=');
			if (eqIdx === -1) {
				return ['', part.trim()];
			}
			return [part.slice(0, eqIdx).trim().toLowerCase(), part.slice(eqIdx + 1).trim()];
		});
		const sha256Pair = digestPairs.find(([algo]) => algo === 'sha-256');
		if (sha256Pair?.[1]) {
			providedDigest = sha256Pair[1];
		} else if (digestPairs.length === 1 && digestPairs[0]?.[0] === '' && digestPairs[0][1]) {
			providedDigest = digestPairs[0][1];
		}

		if (!providedDigest) {
			apex.logger.warn(
				'Request rejected: digest header does not contain supported sha-256 algorithm',
			);
			res.status(403).send('Invalid http signature');
			return;
		}

		const bodyBuffer = getRequestBodyBuffer(req);
		if (!bodyBuffer) {
			apex.logger.warn('Request rejected: unable to verify digest without raw request body');
			res.status(403).send('Invalid http signature');
			return;
		}

		const computedDigest = createHash('sha256').update(bodyBuffer).digest('base64');
		const providedBuffer = Buffer.from(providedDigest, 'base64');
		const computedBuffer = Buffer.from(computedDigest, 'base64');
		if (
			providedBuffer.length !== 32 ||
			computedBuffer.length !== 32 ||
			!timingSafeEqual(providedBuffer, computedBuffer)
		) {
			apex.logger.warn('Request rejected: body digest mismatch');
			res.status(403).send('Invalid http signature');
			return;
		}
	}

	const signerResult = await resolveSignerAndKey(apex, sigHead.keyId, req, res);
	if (signerResult === null || signerResult === 'handled') {
		return;
	}
	let signer = signerResult.signer;
	const { signerKey, cached } = signerResult;

	let valid = verifyHttpSignature(sigHead, stringToSign, signerKey);
	if (!valid && cached) {
		console.log('Refreshing key for %s', sigHead.keyId);
		let refreshed: APObject | undefined;
		try {
			refreshed = await apex.resolveObject(sigHead.keyId, false, true);
		} catch (err) {
			apex.logger.warn('error refreshing key for signature verification', err);
			res.status(500).send();
			return;
		}
		let refreshedKey = publicKeyPemOf(refreshed, sigHead.keyId);
		if (!refreshedKey && refreshed && isRecord(refreshed) && refreshed.owner) {
			const ownerId = first(refreshed.owner);
			if (typeof ownerId === 'string') {
				refreshed = await apex.resolveObject(ownerId, false, true);
				refreshedKey = publicKeyPemOf(refreshed, sigHead.keyId);
			}
		}
		if (refreshed && refreshedKey !== undefined) {
			signer = refreshed;
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
