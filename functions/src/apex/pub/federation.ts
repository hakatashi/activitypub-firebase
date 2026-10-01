import { constants, createHash, createPrivateKey, sign } from 'node:crypto';
import { createSignature } from 'http-message-sig';
import type { RequestDescriptor } from 'http-message-sig';
import { request } from 'undici';
import type { Dispatcher } from 'undici';
import type { Apex, APObject } from '../types.js';
import { errorMessage, firstString, isAPObject, isHashtag, isRecord, toArray } from '../values.js';
import {
	assertSafeUrl,
	makePinnedAgent,
	maxRedirects,
	readBodyWithLimit,
	UnsafeUrlError,
} from './ssrf.js';

const maxTimeout = 2 ** 31 - 1;
let isDelivering = false;
let nextDelivery: NodeJS.Timeout | undefined;

export const computeHttpSignature = ({
	method,
	url,
	headerNames,
	headerValues,
	keyId,
	privateKey,
}: {
	method: string;
	url: URL;
	headerNames: string[];
	headerValues: Record<string, string>;
	keyId: string;
	privateKey: string;
}): string => {
	const signedHeaders = headerNames.map((name) => {
		const lowerName = name.toLowerCase();
		if (lowerName === '(request-target)') {
			return [lowerName, `${method.toLowerCase()} ${url.pathname}${url.search}`];
		}
		if (lowerName === 'host') {
			return [lowerName, url.host];
		}
		const val = headerValues[lowerName];
		if (val === undefined) {
			throw new Error(`Missing header value for signature: ${name}`);
		}
		return [lowerName, val];
	});
	const stringToSign = signedHeaders.map(([name, val]) => `${name}: ${val}`).join('\n');
	const signature = sign('sha256', Buffer.from(stringToSign, 'utf-8'), privateKey).toString(
		'base64',
	);
	return `keyId="${keyId}",algorithm="rsa-sha256",headers="${signedHeaders.map(([name]) => name).join(' ')}",signature="${signature}"`;
};

export const computeHttpSignatureHeaders = ({
	method = 'get',
	url,
	keyId,
	privateKeyPem,
	date = new Date().toUTCString(),
	digest,
}: {
	method?: string;
	url: URL | string;
	keyId: string;
	privateKeyPem: string;
	date?: string;
	digest?: string | undefined;
}): { date: string; signature: string; digest?: string } => {
	const parsedUrl = typeof url === 'string' ? new URL(url) : url;
	const headerNames = ['(request-target)', 'host', 'date'];
	const headerValues: Record<string, string> = { date };
	if (digest !== undefined) {
		headerNames.push('digest');
		headerValues.digest = digest;
	}
	const signature = computeHttpSignature({
		method,
		url: parsedUrl,
		headerNames,
		headerValues,
		keyId,
		privateKey: privateKeyPem,
	});
	return digest === undefined ? { date, signature } : { date, signature, digest };
};

export const computeRfc9421SignatureHeaders = async ({
	method = 'post',
	url,
	keyId,
	privateKey,
	body,
	rawBody,
	created = Math.floor(Date.now() / 1000),
	expires,
	alg,
	components = ['@method', '@target-uri', 'content-digest'],
}: {
	method?: string;
	url: URL | string;
	keyId: string;
	privateKey: string;
	body?: unknown;
	rawBody?: string | Buffer | undefined;
	created?: number;
	expires?: number;
	alg?: string;
	components?: string[];
}): Promise<Record<string, string>> => {
	const parsedUrl = typeof url === 'string' ? new URL(url) : url;
	let privateKeyObj: ReturnType<typeof createPrivateKey>;
	try {
		privateKeyObj = createPrivateKey(privateKey);
	} catch {
		throw new Error('Invalid private key');
	}
	const keyType = privateKeyObj.asymmetricKeyType;
	const signatureAlg = alg ?? (keyType === 'ed25519' ? 'ed25519' : 'rsa-v1_5-sha256');

	const headers: Record<string, string> = {};
	const fields: { name: string; value: string }[] = [{ name: 'host', value: parsedUrl.host }];

	let payloadBuf: Buffer | undefined;
	if (rawBody !== undefined) {
		payloadBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf-8');
	} else if (body !== undefined) {
		if (Buffer.isBuffer(body)) {
			payloadBuf = body;
		} else if (typeof body === 'string') {
			payloadBuf = Buffer.from(body, 'utf-8');
		} else {
			payloadBuf = Buffer.from(JSON.stringify(body), 'utf-8');
		}
	}

	if (payloadBuf !== undefined) {
		const digestBase64 = createHash('sha256').update(payloadBuf).digest('base64');
		const contentDigestVal = `sha-256=:${digestBase64}:`;
		headers['content-digest'] = contentDigestVal;
		fields.push({ name: 'content-digest', value: contentDigestVal });
	}

	const signer = {
		algorithm: signatureAlg,
		sign(data: Uint8Array): Uint8Array {
			if (signatureAlg === 'ed25519') {
				return sign(null, data, privateKey);
			}
			if (signatureAlg === 'rsa-pss-sha512') {
				return sign('sha512', data, {
					key: privateKey,
					padding: constants.RSA_PKCS1_PSS_PADDING,
					saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
				});
			}
			return sign('sha256', data, privateKey);
		},
	};

	const reqDesc: RequestDescriptor = {
		kind: 'request',
		method: method.toUpperCase(),
		targetUri: parsedUrl.href,
		fields,
	};

	const params: Record<string, string | number> = {
		created,
		keyid: keyId,
	};
	if (expires !== undefined) {
		params.expires = expires;
	}
	if (alg !== undefined) {
		params.alg = alg;
	} else if (keyType === 'ed25519') {
		params.alg = 'ed25519';
	}

	const sigResult = await createSignature(reqDesc, {
		label: 'sig1',
		components,
		parameters: params,
		signer,
	});

	headers['signature-input'] = sigResult.signatureInput;
	headers.signature = sigResult.signature;

	return headers;
};

// SSRF セーフなリモートオブジェクト取得。URL の検証 (スキーム / DNS 解決結果のアドレス範囲) を
// リダイレクトの各ホップで行い、検証済み IP に接続を固定する。何を内部とみなすかは
// settings.remoteFetchPolicy で注入できる (→ ssrf.ts)。
export const requestObject = async function (
	this: Apex,
	id: string,
): Promise<APObject | undefined> {
	const guardOptions = { policy: this.settings?.remoteFetchPolicy, logger: this.logger };
	let { url, addresses } = await assertSafeUrl(id, guardOptions);

	for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
		const headers: Record<string, string> = {
			Accept: 'application/activity+json',
			'User-Agent': this.makeUserAgentString(),
		};
		const privateKey = this.systemUser?._meta?.privateKey;
		if (this.systemUser && privateKey) {
			const { date, signature } = computeHttpSignatureHeaders({
				method: 'get',
				url,
				// keyId には公開鍵の id (`#main-key`) を渡す必要がある
				keyId: `${this.systemUser.id}#main-key`,
				privateKeyPem: privateKey,
			});
			headers.Date = date;
			headers.Signature = signature;
		}

		const agent = makePinnedAgent(addresses);
		try {
			const response = await request(url, {
				method: 'GET',
				headers,
				headersTimeout: this.requestTimeout,
				bodyTimeout: this.requestTimeout,
				dispatcher: agent,
			});

			if (response.statusCode >= 300 && response.statusCode < 400) {
				const { location } = response.headers;
				await response.body.dump();
				if (typeof location !== 'string' || !location) {
					throw new Error(`Redirect from ${url.toString()} is missing Location header`);
				}
				({ url, addresses } = await assertSafeUrl(new URL(location, url).toString(), guardOptions));
				continue;
			}

			if (response.statusCode < 200 || response.statusCode >= 300) {
				await response.body.dump();
				throw new Error(`Request failed with status code ${response.statusCode}`);
			}

			const body = await readBodyWithLimit(response.body, response.headers);
			return await this.fromJSONLD(JSON.parse(body));
		} finally {
			await agent.close();
		}
	}

	this.logger.warn({ type: 'ssrfBlockedTooManyRedirects', url: id });
	throw new Error(`Too many redirects while fetching ${id}`);
};

const topLevelRefProps = ['inReplyTo', 'object', 'target', 'tag'] as const;
const recursiveRefProps = ['inReplyTo', 'object', 'target'] as const;

export interface ResolveReferencesOptions {
	visited?: Set<string>;
	resolvedCount?: { count: number };
}

const getCandidateIri = (item: unknown): string | undefined => {
	if (typeof item === 'string') {
		return item;
	}
	if (isRecord(item)) {
		const id = firstString(item.id);
		if (id !== undefined) {
			return id;
		}
		const href = firstString(item.href);
		if (href !== undefined) {
			return href;
		}
	}
	return undefined;
};

const mapConcurrentSettled = async <T, R>(
	items: readonly T[],
	concurrency: number,
	fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> => {
	const results: PromiseSettledResult<R>[] = Array.from({ length: items.length });
	let nextIndex = 0;
	const worker = async () => {
		while (nextIndex < items.length) {
			const index = nextIndex++;
			const item = items[index];
			if (item === undefined) {
				continue;
			}
			try {
				const value = await fn(item);
				results[index] = { status: 'fulfilled', value };
			} catch (reason) {
				results[index] = { status: 'rejected', reason };
			}
		}
	};
	const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () =>
		worker(),
	);
	await Promise.all(workers);
	return results;
};

export const resolveReferences = async function (
	this: Apex,
	object: APObject,
	depth = 0,
	context?: ResolveReferencesOptions,
): Promise<APObject[]> {
	const visited = context?.visited ?? new Set<string>();
	const resolvedCount = context?.resolvedCount ?? { count: 0 };
	const threadLimit = this.threadLimit;
	const threadConcurrency = this.threadConcurrency;

	if (depth === 0 && typeof object.id === 'string') {
		visited.add(object.id);
	}

	if (depth > this.threadDepth || resolvedCount.count >= threadLimit) {
		return [];
	}

	const props = depth === 0 ? topLevelRefProps : recursiveRefProps;
	const candidates: unknown[] = [];
	for (const prop of props) {
		const val = object[prop];
		if (val !== undefined && val !== null) {
			const arr = toArray(val);
			for (const item of arr) {
				if (item === undefined || item === null || isHashtag(item)) {
					continue;
				}
				const iri = getCandidateIri(item);
				if (iri !== undefined) {
					if (visited.has(iri)) {
						continue;
					}
					visited.add(iri);
				}
				candidates.push(item);
			}
		}
	}

	if (!candidates.length) {
		return [];
	}

	const settledResults = await mapConcurrentSettled(
		candidates,
		threadConcurrency,
		async (candidate) => {
			if (resolvedCount.count >= threadLimit) {
				return null;
			}
			const resolved = await this.resolveUnknown(candidate);
			if (resolvedCount.count >= threadLimit) {
				return null;
			}
			if (resolved && isAPObject(resolved)) {
				if (typeof resolved.id === 'string') {
					visited.add(resolved.id);
				}
				resolvedCount.count++;
				return resolved;
			}
			return null;
		},
	);

	const objects = settledResults.flatMap((r) =>
		r.status === 'fulfilled' && r.value ? [r.value] : [],
	);

	if (!objects.length || depth >= this.threadDepth || resolvedCount.count >= threadLimit) {
		return objects;
	}

	const nextLevelResults: APObject[] = [];
	for (const obj of objects) {
		if (resolvedCount.count >= threadLimit) {
			break;
		}
		const children = await this.resolveReferences(obj, depth + 1, { visited, resolvedCount });
		nextLevelResults.push(...children);
	}

	return objects.concat(nextLevelResults);
};

export interface DeliverResult {
	statusCode: number;
	headers: Dispatcher.ResponseData['headers'];
}

export const deliver = async function (
	this: Apex,
	actorId: string,
	activity: string,
	address: string,
	signingKey: string | undefined,
): Promise<DeliverResult | null> {
	const guardOptions = { policy: this.settings?.remoteFetchPolicy, logger: this.logger };
	let safe: { url: URL; addresses: string[] };
	try {
		safe = await assertSafeUrl(address, guardOptions);
	} catch (err) {
		if (err instanceof UnsafeUrlError) {
			return null;
		}
		throw err;
	}
	const { url, addresses } = safe;

	// digest header added for Mastodon 3.2.1 compatibility
	const digest = `SHA-256=${createHash('sha256').update(activity).digest('base64')}`;
	const date = new Date().toUTCString();
	const headers: Record<string, string> = {
		'Content-Type': this.consts.jsonldOutgoingType,
		Date: date,
		Digest: digest,
		Host: url.host,
		'User-Agent': this.makeUserAgentString(),
	};
	if (signingKey) {
		const { signature } = computeHttpSignatureHeaders({
			method: 'post',
			url,
			keyId: actorId,
			privateKeyPem: signingKey,
			date,
			digest,
		});
		headers.Signature = signature;
	}

	const agent = makePinnedAgent(addresses);
	try {
		const response = await request(url, {
			method: 'POST',
			headers,
			body: activity,
			headersTimeout: this.requestTimeout,
			bodyTimeout: this.requestTimeout,
			dispatcher: agent,
		});

		await response.body.dump();

		return {
			statusCode: response.statusCode,
			headers: response.headers,
		};
	} finally {
		await agent.close();
	}
};

export const queueForDelivery = async function (
	this: Apex,
	actor: APObject,
	activity: unknown,
	addresses: string[],
): Promise<void> {
	// custom stringify strips meta props
	const outgoingBody = this.stringifyPublicJSONLD(activity);
	await this.store.deliveryEnqueue(actor.id, outgoingBody, addresses, actor._meta?.privateKey);
	// returning promise makes first delivery complete during postWork (easier testing)
	return this.startDelivery();
};

export const startDelivery = function (this: Apex): Promise<void> {
	if (isDelivering || this.offlineMode) {
		return Promise.resolve();
	}
	return this.runDelivery();
};

export const runDelivery = async function (this: Apex): Promise<void> {
	isDelivering = true;
	const toDeliver = await this.store.deliveryDequeue();
	if (!toDeliver) {
		isDelivering = false;
		return;
	}
	// only future-dated items left, resume then
	if ('waitUntil' in toDeliver) {
		const wait = Math.min(toDeliver.waitUntil.getTime() - Date.now(), maxTimeout);
		nextDelivery = setTimeout(() => this.startDelivery(), wait);
		isDelivering = false;
		return;
	}
	// if new delivery run starts while another is pending,
	// it will add another timer when it finishes
	clearTimeout(nextDelivery);
	try {
		const { actorId, body, address, signingKey } = toDeliver;
		const result = await this.deliver(actorId, body, address, signingKey);
		this.logger.info('delivery:', address, result?.statusCode);
		if (result && result.statusCode >= 500) {
			// 5xx errors will get requeued
			throw new Error(`Request status ${result.statusCode}`);
		}
	} catch (err) {
		this.logger.warn(`Delivery error ${String(errorMessage(err))}, requeuing`);
		// 11 tries over ~5 months
		if (toDeliver.attempt < 11) {
			await this.store.deliveryRequeue(toDeliver).catch((requeueErr: unknown) => {
				this.logger.error('Failed to requeue delivery', errorMessage(requeueErr));
			});
		}
		// Not yet implemented: consider tracking unreachable servers, removing followers
	}
	setTimeout(() => this.runDelivery(), 0);
};

export const makeUserAgentString = function (this: Apex): string {
	return `${this.settings.name}/${this.settings.version} (+http://${this.settings.domain})`;
};
