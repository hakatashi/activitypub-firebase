import { sign } from 'node:crypto';

// リモートオブジェクト取得 (GET) 用の HTTP Signature を自前計算する (→ ADR-0032)。
// digest ヘッダーは body を持たない GET には不要なため、apex.deliver (POST) が使う
// request-promise-native + http-signature の実装より小さく、移植リスクが低い
// (third_party/minipub/src/crypto.ts の computeHttpSignatureHeaders を参考にした)。
// Node の crypto.sign は PEM 文字列をそのまま鍵として受け取れるため、
// WebCrypto への鍵インポートは不要。
export const computeHttpSignatureHeaders = (options: {
	url: URL;
	privateKeyPem: string;
	keyId: string;
}): { date: string; signature: string } => {
	const { url, privateKeyPem, keyId } = options;
	const date = new Date().toUTCString();
	const signedHeaders: [string, string][] = [
		['(request-target)', `get ${url.pathname}${url.search}`],
		['host', url.host],
		['date', date],
	];
	const stringToSign = signedHeaders.map(([name, value]) => `${name}: ${value}`).join('\n');
	const signatureBytes = sign('sha256', Buffer.from(stringToSign, 'utf-8'), privateKeyPem);
	const signature = [
		`keyId="${keyId}"`,
		'algorithm="rsa-sha256"',
		`headers="${signedHeaders.map(([name]) => name).join(' ')}"`,
		`signature="${signatureBytes.toString('base64')}"`,
	].join(',');
	return { date, signature };
};
