import type { Apex, APObject } from 'activitypub-express';
import { logger } from 'firebase-functions/v2';
import { computeHttpSignatureHeaders } from './httpSignature.js';
import { assertSafeUrl } from './ssrf.js';

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

const readBodyWithLimit = async (response: Response, maxBytes: number): Promise<string> => {
	const contentLength = response.headers.get('content-length');
	if (contentLength !== null && Number(contentLength) > maxBytes) {
		throw new Error(`Response too large: ${contentLength} bytes`);
	}
	if (response.body === null) {
		return '';
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	for (;;) {
		// oxlint-disable-next-line no-await-in-loop
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		totalBytes += value.byteLength;
		if (totalBytes > maxBytes) {
			// oxlint-disable-next-line no-await-in-loop
			await reader.cancel();
			throw new Error(`Response exceeded ${maxBytes} bytes`);
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString('utf-8');
};

// apex.requestObject の差し替え実装。resolveObject / resolveUnknown / resolveReferences /
// net/activity.js の resolveThread から `this.requestObject(id)` として呼ばれる
// (apex.ts で `apex.requestObject = safeRequestObject.bind(apex)` として上書きする)。
// → ADR-0032, Issue #52
export const safeRequestObject = async function (this: Apex, id: string): Promise<APObject> {
	let url = await assertSafeUrl(id);

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
		});

		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get('location');
			if (location === null) {
				throw new Error(`Redirect from ${url.toString()} is missing Location header`);
			}
			// oxlint-disable-next-line no-await-in-loop
			url = await assertSafeUrl(new URL(location, url).toString());
			continue;
		}

		if (!response.ok) {
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
