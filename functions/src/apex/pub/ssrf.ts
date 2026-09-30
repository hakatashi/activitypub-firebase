import type { LookupAddress } from 'node:dns';
import { promises as dns } from 'node:dns';
import type { LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent } from 'undici';
import type { Dispatcher } from 'undici';
import type { ApexLogger } from '../types.js';

// リモートが指定した任意の URL への到達 (SSRF) を防ぐための検証。
// 「どのアドレスを内部とみなすか」は運用環境ごとに変わりうるため policy として注入できる。
export class UnsafeUrlError extends Error {}

// 省略した項目は厳格なデフォルト (https のみ / unicast のみ / DNS 解決) になる。
export interface RemoteFetchPolicy {
	allowedProtocols?: string[];
	allowedRanges?: string[];
	resolveAddresses?: (hostname: string) => Promise<string[]>;
}

export interface AssertSafeUrlOptions {
	policy?: RemoteFetchPolicy | (() => RemoteFetchPolicy) | undefined;
	logger?: Pick<ApexLogger, 'warn'> | undefined;
}

// URL.hostname は IPv6 リテラルを `[::1]` のように角括弧付きで返すため、
// ipaddr.js / dns.lookup に渡す前に取り除く。
const stripBrackets = (hostname: string) =>
	hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

// IP リテラルはそのまま、ホスト名は DNS 解決した全アドレスを返す。解決できなければ空配列。
const defaultResolveAddresses = async (rawHostname: string): Promise<string[]> => {
	const hostname = stripBrackets(rawHostname);
	if (ipaddr.isValid(hostname)) {
		return [hostname];
	}
	try {
		const entries = await dns.lookup(hostname, { all: true, verbatim: true });
		return entries.map((entry) => entry.address);
	} catch {
		return [];
	}
};

const defaultPolicy: Required<RemoteFetchPolicy> = {
	allowedProtocols: ['https:'],
	allowedRanges: ['unicast'],
	resolveAddresses: defaultResolveAddresses,
};

const resolvePolicy = (policy: AssertSafeUrlOptions['policy']): Required<RemoteFetchPolicy> => ({
	...defaultPolicy,
	...(typeof policy === 'function' ? policy() : policy),
});

// fetch 前に呼び出し、安全でなければ UnsafeUrlError を投げる。リダイレクト追跡時にも
// ホップごとに呼び出す。戻り値の addresses は検証済みの IP で、接続側はこのアドレスに
// 固定しホスト名を再解決してはならない (DNS rebinding 対策)。
export const assertSafeUrl = async (
	urlString: string,
	{ policy, logger = console }: AssertSafeUrlOptions = {},
): Promise<{ url: URL; addresses: string[] }> => {
	const { allowedProtocols, allowedRanges, resolveAddresses } = resolvePolicy(policy);
	let url;
	try {
		url = new URL(urlString);
	} catch {
		logger.warn({ type: 'ssrfBlockedInvalidUrl', url: urlString });
		throw new UnsafeUrlError(`Invalid URL: ${urlString}`);
	}

	if (!allowedProtocols.includes(url.protocol)) {
		logger.warn({ type: 'ssrfBlockedProtocol', url: urlString, protocol: url.protocol });
		throw new UnsafeUrlError(`Protocol not allowed: ${url.protocol}`);
	}

	const addresses = await resolveAddresses(url.hostname);
	if (addresses.length === 0) {
		logger.warn({ type: 'ssrfBlockedUnresolvable', url: urlString });
		throw new UnsafeUrlError(`Could not resolve hostname: ${url.hostname}`);
	}

	const allowed = new Set(allowedRanges);
	for (const address of addresses) {
		const range = ipaddr.process(address).range();
		if (!allowed.has(range)) {
			logger.warn({ type: 'ssrfBlockedAddress', url: urlString, address, range });
			throw new UnsafeUrlError(`Address not allowed: ${address} (${range})`);
		}
	}

	return { url, addresses };
};

export const maxRedirects = 5;
export const maxResponseBytes = 5 * 1024 * 1024;

// assertSafeUrl が検証した IP アドレスに接続を固定する Agent を作る。lookup を差し替えることで、
// 接続時に DNS が再解決されて検証済みアドレスと異なる IP (攻撃者制御の DNS が返す
// private/loopback アドレス) に接続してしまう DNS rebinding を防ぐ。ホスト名自体は変えないため
// TLS の SNI / 証明書検証には影響しない。
export const makePinnedAgent = (addresses: string[]): Agent => {
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

export const readBodyWithLimit = async (
	body: Dispatcher.ResponseData['body'],
	headers: Dispatcher.ResponseData['headers'],
	limit = maxResponseBytes,
): Promise<string> => {
	const contentLength = headers['content-length'];
	if (contentLength !== undefined && Number(contentLength) > limit) {
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
		if (total > limit) {
			throw new Error(`Response exceeded ${limit} bytes`);
		}
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString('utf-8');
};
