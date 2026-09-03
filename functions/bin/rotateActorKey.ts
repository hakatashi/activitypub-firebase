import assert from 'node:assert';
import crypto from 'node:crypto';
import {promisify} from 'node:util';
import Store from '../src/store.js';

// ADR-0009: 配送が未実装の Phase 0 のうちに actor の秘密鍵をローテーションする、使い捨てスクリプト。
// ts-node 等で手動実行する。実行対象プロジェクトは firebase-admin の Application Default
// Credentials(GOOGLE_APPLICATION_CREDENTIALS または `firebase use` の対象)で決まる。
//
// `../src/firebase.js` の `domain` はローカル実行時(Cloud Functions 環境外)には
// `getInstallations().app.options.projectId` が undefined になり、常に dev ドメインへ
// フォールバックしてしまう。実行対象を誤らないよう、ここでは GCLOUD_PROJECT を直接見る。
const generateKeyPair = promisify(crypto.generateKeyPair);

const projectId = process.env.GCLOUD_PROJECT;
assert(
	projectId === 'activitypub-firebase' || projectId === 'activitypub-firebase-dev',
	`GCLOUD_PROJECT must be set to activitypub-firebase or activitypub-firebase-dev, got: ${projectId}`,
);
const domain = projectId === 'activitypub-firebase' ? 'hakatashi.com' : 'activitypub-dev.hakatashi.com';

const actorId = `https://${domain}/activitypub/u/hakatashi`;

const main = async () => {
	const store = new Store();
	const actor = await store.getObject(actorId, true);
	assert(actor, `actor not found: ${actorId}`);
	assert(typeof actor._meta?.privateKey === 'string', 'actor has no existing private key');

	// apex は fromJSONLD() で actor を JSON-LD 展開形に正規化して保存するため、
	// publicKey は単一オブジェクトではなく1要素の配列、publicKeyPem もその中で
	// 配列になっている(functions/node_modules/activitypub-express/pub/jsonld.js)。
	// 将来の実装変化に備え、配列/非配列どちらの形でも動くようにしておく。
	const currentPublicKeyEntry = Array.isArray(actor.publicKey) ? actor.publicKey[0] : actor.publicKey;
	assert(currentPublicKeyEntry, 'actor has no existing public key');
	const currentPublicKeyPem = currentPublicKeyEntry.publicKeyPem;
	assert(currentPublicKeyPem !== undefined, 'actor has no existing public key pem');
	const publicKeyPemIsArray = Array.isArray(currentPublicKeyPem);

	// apex の createActor と同じパラメータで生成する
	// (functions/node_modules/activitypub-express/pub/actor.js)
	const {publicKey, privateKey} = await generateKeyPair('rsa', {
		modulusLength: 4096,
		publicKeyEncoding: {type: 'spki', format: 'pem'},
		privateKeyEncoding: {type: 'pkcs8', format: 'pem'},
	});

	const newPublicKeyEntry = {
		...currentPublicKeyEntry,
		publicKeyPem: publicKeyPemIsArray ? [publicKey] : publicKey,
	};

	const rotatedActor = {
		...actor,
		id: actorId,
		publicKey: Array.isArray(actor.publicKey) ? [newPublicKeyEntry] : newPublicKeyEntry,
		_meta: {
			...actor._meta,
			privateKey,
		},
	};

	await store.updateObject(rotatedActor, actorId, true);

	console.log(`Rotated actor key for ${actorId}`);
};

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
