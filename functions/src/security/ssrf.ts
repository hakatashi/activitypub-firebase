import dns from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { logger } from 'firebase-functions/v2';

// リモートが指定した任意の URL への到達 (SSRF) を防ぐための検証 (→ ADR-0032, Issue #52)。
export class UnsafeUrlError extends Error {}

// URL.hostname は IPv6 リテラルを `[::1]` のように角括弧付きで返すため、
// ipaddr.js / dns.lookup に渡す前に取り除く。
const stripBrackets = (hostname: string): string =>
	hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

const resolveAddresses = async (rawHostname: string): Promise<string[]> => {
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

// dev/本番の projectId ではなく、エミュレータ/テスト実行かどうかで切り替える。
// dev projectId (activitypub-firebase-dev) にデプロイされた本物の Cloud Functions は
// 本番同様クラウド上で動くため localhost/プライベート IP への到達を許可する理由がない。
// 一方エミュレータやテストは実際に localhost のモックサーバーへ到達する必要がある
// (→ ADR-0032, Issue #52 の注意書き)。activitypub.ts の adminOnly と同じ判定基準。
// テストが process.env を書き換えて挙動を切り替えられるよう、呼び出しのたびに評価する。
export const isLocalDevelopment = (): boolean =>
	process.env.FUNCTIONS_EMULATOR === 'true' || process.env.NODE_ENV === 'test';

export interface SafeUrl {
	url: URL;
	// assertSafeUrl が検証済みの IP アドレス群。DNS rebinding (検証時と実際の接続時で
	// 別の IP を返す攻撃者制御の DNS サーバー) を防ぐため、fetch 側はこの検証済みアドレスに
	// 接続を固定し、ホスト名を再解決してはならない (→ ADR-0032, Issue #52)。
	addresses: string[];
}

// fetch 前に呼び出し、安全でなければ UnsafeUrlError を投げる。リダイレクト追跡時にも
// ホップごとに呼び出すことで、検証をバイパスするリダイレクトを防ぐ。
export const assertSafeUrl = async (urlString: string): Promise<SafeUrl> => {
	let url: URL;
	try {
		url = new URL(urlString);
	} catch {
		logger.warn({ type: 'ssrfBlockedInvalidUrl', url: urlString });
		throw new UnsafeUrlError(`Invalid URL: ${urlString}`);
	}

	const localDev = isLocalDevelopment();
	const allowedProtocols = localDev ? ['https:', 'http:'] : ['https:'];
	const allowedRanges = new Set(localDev ? ['unicast', 'loopback'] : ['unicast']);

	if (!allowedProtocols.includes(url.protocol)) {
		logger.warn({ type: 'ssrfBlockedProtocol', url: urlString, protocol: url.protocol });
		throw new UnsafeUrlError(`Protocol not allowed: ${url.protocol}`);
	}

	const addresses = await resolveAddresses(url.hostname);
	if (addresses.length === 0) {
		logger.warn({ type: 'ssrfBlockedUnresolvable', url: urlString });
		throw new UnsafeUrlError(`Could not resolve hostname: ${url.hostname}`);
	}

	for (const address of addresses) {
		const range = ipaddr.process(address).range();
		if (!allowedRanges.has(range)) {
			logger.warn({ type: 'ssrfBlockedAddress', url: urlString, address, range });
			throw new UnsafeUrlError(`Address not allowed: ${address} (${range})`);
		}
	}

	return { url, addresses };
};
