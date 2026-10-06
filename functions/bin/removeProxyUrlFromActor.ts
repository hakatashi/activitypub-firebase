import assert from 'node:assert';
import { LOCAL_USERNAME, localActorIri } from '../src/localActor.js';
import Store from '../src/store.js';

// dev/prod の Firestore に保存されている actor オブジェクトから endpoints (proxyUrl) を削除する使い捨てスクリプト。
// ts-node 等で手動実行する。実行対象プロジェクトは GCLOUD_PROJECT で決まる。
const projectId = process.env.GCLOUD_PROJECT;
assert(
	projectId === 'activitypub-firebase' || projectId === 'activitypub-firebase-dev',
	`GCLOUD_PROJECT must be set to activitypub-firebase or activitypub-firebase-dev, got: ${projectId}`,
);
const domain =
	projectId === 'activitypub-firebase' ? 'hakatashi.com' : 'activitypub-dev.hakatashi.com';

const actorId = localActorIri(LOCAL_USERNAME, domain);

const main = async () => {
	const store = new Store();
	const actor = await store.getObject(actorId, true);
	assert(actor, `actor not found: ${actorId}`);

	if (actor.endpoints) {
		delete actor.endpoints;
		await store.saveObject(actor);
		console.log(`Successfully removed endpoints from actor ${actorId}`);
	} else {
		console.log(`Actor ${actorId} has no endpoints property`);
	}
};

main();
