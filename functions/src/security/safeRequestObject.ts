import type { Apex, APObject } from '../apex/index.js';
import { logger } from 'firebase-functions/v2';
import { Agent } from 'undici';
import { computeHttpSignatureHeaders } from '../apex/pub/federation.js';
import { assertSafeUrl } from './ssrf.js';

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

// npm の undici パッケージが持つ型定義は、Node 組み込みの fetch/RequestInit が使う
// undici-types のバージョンとわずかに異なり構造的に噛み合わないため、
// dispatcher オプションへの代入だけ型を橋渡しする。実行時の互換性は検証済み。
type FetchDispatcher = NonNullable<RequestInit['dispatcher']>;

// assertSafeUrl が検証した IP アドレスに接続を固定する Dispatcher を作る。
// lookup を差し替えることで、fetch 内部が独自に DNS を再解決して検証済みアドレスと
// 異なる IP (攻撃者制御の DNS サーバーが返す private/loopback アドレス) に接続してしまう
// DNS rebinding を防ぐ。ホスト名自体は変えないため TLS の SNI / 証明書検証には影響しない
// (→ ADR-0032, Issue #52)。
const makePinnedDispatcher = (addresses: string[]): FetchDispatcher =>
	new Agent({
		connect: {
			lookup: (_hostname, options, callback) => {
				const [address] = addresses;
				if (address === undefined) {
					callback(new Error('No pinned address available'), []);
					return;
				}
				const family = address.includes(':') ? 6 : 4;
				if (options.all) {
					callback(
						null,
						addresses.map((pinnedAddress) => ({
							address: pinnedAddress,
							family: pinnedAddress.includes(':') ? 6 : 4,
						})),
					);
				} else {
					callback(null, address, family);
				}
			},
		},
	}) as unknown as FetchDispatcher;

const readBodyWithLimit = async (response: Response, maxBytes: number): Promise<string> => {
	const contentLength = response.headers.get('content-length');
	if (contentLength !== null && Number(contentLength) > maxBytes) {
		throw new Error(`Response too large: ${contentLength} bytes`);
	}
	if (response.body === null) {
		return '';
	}
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	// ループ内で throw すると for await...of のイテレータが自動的に
	// response.body を cancel() するため、手動での reader 管理は不要。
	for await (const chunk of response.body) {
		totalBytes += chunk.byteLength;
		if (totalBytes > maxBytes) {
			throw new Error(`Response exceeded ${maxBytes} bytes`);
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString('utf-8');
};

// apex.requestObject の差し替え実装。resolveObject / resolveUnknown / resolveReferences /
// net/activity.js の resolveThread から `this.requestObject(id)` として呼ばれる
// (apex.ts で `apex.requestObject = safeRequestObject.bind(apex)` として上書きする)。
// → ADR-0032, Issue #52
export const safeRequestObject = async function (this: Apex, id: string): Promise<APObject> {
	let { url, addresses } = await assertSafeUrl(id);

	for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
		const headers: Record<string, string> = {
			Accept: 'application/activity+json',
			'User-Agent': this.makeUserAgentString(),
		};

		const privateKey = this.systemUser?._meta?.privateKey;
		if (this.systemUser !== undefined && typeof privateKey === 'string') {
			const { date, signature } = computeHttpSignatureHeaders({
				url,
				privateKeyPem: privateKey,
				// keyId には公開鍵の id (`#main-key`) を渡す必要がある (→ ADR-0015)
				keyId: `${this.systemUser.id}#main-key`,
			});
			headers.Date = date;
			headers.Signature = signature;
		}

		// oxlint-disable-next-line no-await-in-loop
		const response = await fetch(url, {
			headers,
			redirect: 'manual',
			signal: AbortSignal.timeout(this.requestTimeout),
			dispatcher: makePinnedDispatcher(addresses),
		});

		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get('location');
			if (location === null) {
				// oxlint-disable-next-line no-await-in-loop
				await response.body?.cancel();
				throw new Error(`Redirect from ${url.toString()} is missing Location header`);
			}
			// oxlint-disable-next-line no-await-in-loop
			await response.body?.cancel();
			// oxlint-disable-next-line no-await-in-loop
			({ url, addresses } = await assertSafeUrl(new URL(location, url).toString()));
			continue;
		}

		if (!response.ok) {
			// oxlint-disable-next-line no-await-in-loop
			await response.body?.cancel();
			throw new Error(`Unexpected status ${response.status} while fetching ${url.toString()}`);
		}

		// oxlint-disable-next-line no-await-in-loop
		const body = await readBodyWithLimit(response, MAX_RESPONSE_BYTES);
		const json: unknown = JSON.parse(body);
		// oxlint-disable-next-line no-await-in-loop
		return await this.fromJSONLD(json);
	}

	logger.warn({ type: 'ssrfBlockedTooManyRedirects', url: id });
	throw new Error(`Too many redirects while fetching ${id}`);
};
