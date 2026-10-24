import assert from 'node:assert';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveInstanceConfig, DEV_PROJECT_ID } from '../src/instanceConfig.js';
import { computeHttpSignatureHeaders } from '../src/apex/pub/federation.js';

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && process.env.GCP_SA_KEY) {
	const tempPath = join(tmpdir(), `gcp-sa-key-${Date.now()}.json`);
	writeFileSync(tempPath, process.env.GCP_SA_KEY, 'utf-8');
	process.env.GOOGLE_APPLICATION_CREDENTIALS = tempPath;
}

const { db, escapeFirestoreKey } = await import('../src/firebase.js');

const projectId = process.env.GCLOUD_PROJECT ?? DEV_PROJECT_ID;
const instanceConfig = resolveInstanceConfig(projectId);
const apHost = instanceConfig.domain;
const mastodonHost = instanceConfig.mastodonDomain;
const actorUrl = `https://${apHost}/activitypub/u/${instanceConfig.primaryActor.username}`;
const inboxUrl = `${actorUrl}/inbox`;

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

const warmup = async (): Promise<void> => {
	console.log(`[1/3] Warming up actor endpoint: ${actorUrl}`);
	for (let i = 1; i <= 10; i++) {
		try {
			const res = await fetch(actorUrl, {
				headers: { Accept: 'application/activity+json' },
			});
			if (res.status === 200) {
				console.log(`Actor endpoint is up (HTTP 200) on attempt ${i}`);
				return;
			}
			console.log(`Waiting for actor endpoint (HTTP ${res.status})... attempt ${i}`);
		} catch (err) {
			console.log(`Connection error on attempt ${i}: ${err}`);
		}
		await sleep(5000);
	}
	throw new Error(`Actor endpoint failed to respond with HTTP 200`);
};

const testSignedInbox = async (): Promise<void> => {
	console.log(`[2/3] Testing signed inbox delivery to ${inboxUrl}`);
	const { publicKey, privateKey } = generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	});

	const randomId = Math.random().toString(36).slice(2, 10);
	const remoteActorId = `https://smoke-test.invalid/u/smoke-${randomId}`;
	const keyId = `${remoteActorId}#main-key`;

	const remoteActorDoc = {
		'@context': 'https://www.w3.org/ns/activitystreams',
		id: remoteActorId,
		type: 'Person',
		preferredUsername: `smoke-${randomId}`,
		inbox: `${remoteActorId}/inbox`,
		publicKey: {
			id: keyId,
			owner: remoteActorId,
			publicKeyPem: publicKey,
		},
	};

	const actorDocRef = db.collection('objects').doc(escapeFirestoreKey(remoteActorId));
	await actorDocRef.set(remoteActorDoc);

	const activityId = `https://smoke-test.invalid/activities/create-${randomId}`;
	const noteId = `https://smoke-test.invalid/notes/note-${randomId}`;
	const activity = {
		'@context': 'https://www.w3.org/ns/activitystreams',
		id: activityId,
		type: 'Create',
		actor: remoteActorId,
		to: [actorUrl],
		object: {
			id: noteId,
			type: 'Note',
			attributedTo: remoteActorId,
			to: [actorUrl],
			content: 'Smoke test message',
		},
	};

	const activityDocRef = db.collection('streams').doc(escapeFirestoreKey(activityId));

	try {
		const bodyString = JSON.stringify(activity);
		const digest = `SHA-256=${createHash('sha256').update(bodyString).digest('base64')}`;
		const { signature, date } = computeHttpSignatureHeaders({
			method: 'post',
			url: inboxUrl,
			keyId,
			privateKeyPem: privateKey,
			digest,
		});

		const res = await fetch(inboxUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/activity+json',
				Date: date,
				Digest: digest,
				Signature: signature,
			},
			body: bodyString,
		});

		if (res.status !== 200) {
			const bodyText = await res.text();
			throw new Error(`Inbox POST failed with HTTP ${res.status}: ${bodyText}`);
		}
		console.log(`Inbox successfully accepted signed activity with HTTP 200`);
	} finally {
		await actorDocRef.delete().catch((err: unknown) => {
			console.warn('Failed to cleanup test actor:', err);
		});
		await activityDocRef.delete().catch((err: unknown) => {
			console.warn('Failed to cleanup test activity:', err);
		});
	}
};

const testMastodonApi = async (): Promise<void> => {
	console.log(`[3/3] Testing Mastodon API on https://${mastodonHost}`);
	const userInfoDoc = await db.collection('userInfos').doc(escapeFirestoreKey(actorUrl)).get();
	assert(userInfoDoc.exists, `UserInfo for ${actorUrl} does not exist`);
	const uid = userInfoDoc.data()?.uid;
	assert(typeof uid === 'string', `UserInfo for ${actorUrl} is missing uid`);

	const tokenString = `smoke-test-token-${Math.random().toString(36).slice(2, 10)}`;
	const tokenRef = await db.collection('accessTokens').add({
		accessToken: tokenString,
		accessTokenExpiresAt: new Date(Date.now() + 3600 * 1000),
		client: { id: 'smoke-test', grants: [] },
		scope: 'read write follow',
		user: { userId: uid },
	});

	try {
		// 1. verify_credentials
		const verifyRes = await fetch(`https://${mastodonHost}/api/v1/accounts/verify_credentials`, {
			headers: { Authorization: `Bearer ${tokenString}` },
		});
		if (verifyRes.status !== 200) {
			const text = await verifyRes.text();
			throw new Error(`verify_credentials failed with HTTP ${verifyRes.status}: ${text}`);
		}
		const account = (await verifyRes.json()) as { username?: string };
		assert(
			account.username === instanceConfig.primaryActor.username,
			`Unexpected username: ${account.username}`,
		);
		console.log(`verify_credentials succeeded for user: ${account.username}`);

		// 2. timelines/home
		const timelineRes = await fetch(`https://${mastodonHost}/api/v1/timelines/home`, {
			headers: { Authorization: `Bearer ${tokenString}` },
		});
		if (timelineRes.status !== 200) {
			const text = await timelineRes.text();
			throw new Error(`timelines/home failed with HTTP ${timelineRes.status}: ${text}`);
		}
		const timeline = await timelineRes.json();
		assert(Array.isArray(timeline), 'timelines/home must return an array');
		console.log(`timelines/home returned ${timeline.length} statuses`);
	} finally {
		await tokenRef.delete().catch((err: unknown) => {
			console.warn('Failed to cleanup test token:', err);
		});
	}
};

const main = async (): Promise<void> => {
	console.log(`Starting smoke test for ${projectId}...`);
	await warmup();
	await testSignedInbox();
	await testMastodonApi();
	console.log(`Smoke test passed successfully!`);
};

main().catch((err) => {
	console.error('Smoke test failed:', err);
	process.exit(1);
});
