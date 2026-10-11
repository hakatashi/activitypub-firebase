import assert from 'node:assert';
import crypto from 'node:crypto';
import { LOCAL_USERNAME, localActorIri } from '../src/localActor.js';
import Store from '../src/store/index.js';

// ローカル actor の `publicKey.publicKeyPem` が `_meta.privateKey` と対になっているかを確かめる、
// 読み取りだけのスクリプト (→ #263)。秘密鍵そのものは出力しない。公開鍵の指紋 (SHA-256) と判定結果だけを出す。
//
// 実行対象を誤らないよう、rotateActorKey.ts と同じく GCLOUD_PROJECT からドメインを決める。
const projectId = process.env.GCLOUD_PROJECT;
assert(
	projectId === 'activitypub-firebase' || projectId === 'activitypub-firebase-dev',
	`GCLOUD_PROJECT must be set to activitypub-firebase or activitypub-firebase-dev, got: ${projectId}`,
);
const domain =
	projectId === 'activitypub-firebase' ? 'hakatashi.com' : 'activitypub-dev.hakatashi.com';
const actorId = localActorIri(LOCAL_USERNAME, domain);

const fingerprint = (key: crypto.KeyObject) =>
	crypto
		.createHash('sha256')
		.update(key.export({ type: 'spki', format: 'der' }))
		.digest('hex');

const store = new Store();
const actor = await store.getObject(actorId, true);
assert(actor, `actor not found: ${actorId}`);
const privateKeyPem = actor._meta?.privateKey;
assert(typeof privateKeyPem === 'string', 'actor has no private key');

// apex は publicKey / publicKeyPem を1要素の配列で保存することがある (rotateActorKey.ts を参照)。
const publicKeyEntry = [actor.publicKey].flat()[0] as
	| { id?: unknown; publicKeyPem?: unknown }
	| undefined;
const publicKeyPem = [publicKeyEntry?.publicKeyPem].flat()[0];
assert(typeof publicKeyPem === 'string', 'actor has no public key pem');

const publicKey = crypto.createPublicKey(publicKeyPem);
const derivedPublicKey = crypto.createPublicKey(crypto.createPrivateKey(privateKeyPem));

// 署名して検証できることも確かめる (HTTP Signatures と同じ RSA-SHA256)。
const payload = Buffer.from(`key pair check ${Date.now()}`);
const signature = crypto.sign('sha256', payload, privateKeyPem);
const verified = crypto.verify('sha256', payload, publicKey, signature);

console.log({
	actorId,
	keyId: publicKeyEntry?.id,
	publicKeyFingerprint: fingerprint(publicKey),
	derivedFingerprint: fingerprint(derivedPublicKey),
	matches: fingerprint(publicKey) === fingerprint(derivedPublicKey) && verified,
});
