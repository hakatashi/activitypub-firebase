import { createHash, sign } from 'node:crypto';
import type { LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { Agent, request } from 'undici';
import type { Dispatcher } from 'undici';
import type { Apex, APObject } from '../types.js';
import { errorMessage } from '../values.js';
import { assertSafeUrl } from './ssrf.js';

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

const maxRedirects = 5;
const maxResponseBytes = 5 * 1024 * 1024;

// assertSafeUrl が検証した IP アドレスに接続を固定する Agent を作る。lookup を差し替えることで、
// 接続時に DNS が再解決されて検証済みアドレスと異なる IP (攻撃者制御の DNS が返す
// private/loopback アドレス) に接続してしまう DNS rebinding を防ぐ。ホスト名自体は変えないため
// TLS の SNI / 証明書検証には影響しない。
const makePinnedAgent = (addresses: string[]) => {
	const toEntry = (address: string): LookupAddress => ({
		address,
		family: address.includes(':') ? 6 : 4,
	});
	const lookup: LookupFunction = (_hostname, options, callback) => {
		if (options.all) {
			callback(null, addresses.map(toEntry));
		} else {
			const [head = ''] = addresses;
			const { address, family } = toEntry(head);
			callback(null, address, family);
		}
	};
	return new Agent({ connect: { lookup } });
};

const readBodyWithLimit = async (
	body: Dispatcher.ResponseData['body'],
	headers: Dispatcher.ResponseData['headers'],
): Promise<string> => {
	const contentLength = headers['content-length'];
	if (contentLength !== undefined && Number(contentLength) > maxResponseBytes) {
		// 破棄時に発火する AbortError を握りつぶす (呼び出し元へは下の Error を投げる)
		body.on('error', () => {
			// noop
		});
		body.destroy();
		throw new Error(`Response too large: ${String(contentLength)} bytes`);
	}
	const chunks: Buffer[] = [];
	let total = 0;
	// ループ内で throw すると for await...of が body を破棄する
	for await (const chunk of body) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		total += buffer.byteLength;
		if (total > maxResponseBytes) {
			throw new Error(`Response exceeded ${maxResponseBytes} bytes`);
		}
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString('utf-8');
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

const refProps = ['inReplyTo', 'object', 'target', 'tag'];

export const resolveReferences = async function (
	this: Apex,
	object: APObject,
	depth = 0,
): Promise<APObject[]> {
	const objectPromises = refProps
		.flatMap((prop) => object[prop]) // may have multiple tags to resolve
		.map((o) => this.resolveUnknown(o));
	const objects = (await Promise.allSettled(objectPromises)).flatMap((r) =>
		r.status === 'fulfilled' && r.value ? [r.value] : [],
	);
	if (!objects.length || depth >= this.threadDepth) {
		return objects;
	}
	const nextLevel = objects.map((o) => this.resolveReferences(o, depth + 1));
	const nextLevelResolved = (await Promise.allSettled(nextLevel)).flatMap((r) =>
		r.status === 'fulfilled' && r.value ? [r.value] : [],
	);
	return objects.concat(nextLevelResolved.flat());
};

export interface DeliverResult {
	statusCode: number;
	headers: Dispatcher.ResponseData['headers'];
	body: string;
}

export const deliver = async function (
	this: Apex,
	actorId: string,
	activity: string,
	address: string,
	signingKey: string | undefined,
): Promise<DeliverResult | null> {
	if (this.isProductionEnv() && this.isLocalhostIRI(address)) {
		return null;
	}
	const url = new URL(address);
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

	const response = await request(url, {
		method: 'POST',
		headers,
		body: activity,
		headersTimeout: this.requestTimeout,
		bodyTimeout: this.requestTimeout,
	});

	const body = await response.body.text();

	return {
		statusCode: response.statusCode,
		headers: response.headers,
		body,
	};
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
