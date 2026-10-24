import assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveInstanceConfig, DEV_PROJECT_ID } from '../src/instanceConfig.js';

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && process.env.GCP_SA_KEY) {
	const tempPath = join(tmpdir(), `gcp-sa-key-${Date.now()}.json`);
	writeFileSync(tempPath, process.env.GCP_SA_KEY, 'utf-8');
	process.env.GOOGLE_APPLICATION_CREDENTIALS = tempPath;
}

const { db, escapeFirestoreKey } = await import('../src/firebase.js');

const projectId = process.env.GCLOUD_PROJECT ?? DEV_PROJECT_ID;
const instanceConfig = resolveInstanceConfig(projectId);
const apHost = instanceConfig.domain;
const actorUrl = `https://${apHost}/activitypub/u/${instanceConfig.primaryActor.username}`;

const command = process.argv[2] ?? 'create';

if (command === 'create') {
	const userInfoDoc = await db.collection('userInfos').doc(escapeFirestoreKey(actorUrl)).get();
	assert(userInfoDoc.exists, `UserInfo for ${actorUrl} does not exist`);
	const uid = userInfoDoc.data()?.uid;
	assert(typeof uid === 'string', `UserInfo for ${actorUrl} is missing uid`);

	const tokenString = `client-e2e-token-${Math.random().toString(36).slice(2, 10)}`;
	await db.collection('accessTokens').add({
		accessToken: tokenString,
		accessTokenExpiresAt: new Date(Date.now() + 3600 * 1000),
		client: { id: 'client-e2e', grants: [] },
		scope: 'read write follow',
		user: { userId: uid },
	});
	console.log(tokenString);
} else if (command === 'revoke') {
	const token = process.argv[3];
	if (token) {
		const snapshot = await db.collection('accessTokens').where('accessToken', '==', token).get();
		await Promise.all(snapshot.docs.map((d) => d.ref.delete()));
	}
}
