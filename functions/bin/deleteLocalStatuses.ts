import assert from 'node:assert';
import { randomBytes } from 'node:crypto';
import { escapeFirestoreKey, mastodonDomain } from '../src/firebase.js';
import { LOCAL_USERNAME, localActorIri } from '../src/localActor.js';
import { findMastodonIds } from '../src/mastodonId.js';
import { htmlToPlainText } from '../src/notes.js';
import { AccessTokens, Objects, UserInfos } from '../src/schema.js';
import { getAttributedTo, isAPNote } from '../src/utils.js';

const projectId = process.env.GCLOUD_PROJECT ?? 'activitypub-firebase-dev';
assert(
	projectId === 'activitypub-firebase' || projectId === 'activitypub-firebase-dev',
	`GCLOUD_PROJECT must be set to activitypub-firebase or activitypub-firebase-dev, got: ${projectId}`,
);

const domain =
	projectId === 'activitypub-firebase' ? 'hakatashi.com' : 'activitypub-dev.hakatashi.com';
const actorId = localActorIri(LOCAL_USERNAME, domain);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const main = async () => {
	console.log(
		`Scanning local Note objects for ${actorId} (project: ${projectId}, dry-run: ${dryRun})...`,
	);

	const snapshot = await Objects.where('type', '==', 'Note')
		.where('_meta.attributedTo', '==', actorId)
		.get();
	const localNotes = snapshot.docs
		.map((doc) => doc.data())
		.filter(
			(obj) =>
				isAPNote(obj) &&
				getAttributedTo(obj) === actorId &&
				typeof obj._meta?.legacyUri !== 'string',
		)
		.sort((a, b) => String(a.published ?? '').localeCompare(String(b.published ?? '')));

	if (localNotes.length === 0) {
		console.log('No matching local Note objects found.');
		return;
	}

	const mastodonIds = await findMastodonIds(localNotes.map((note) => note.id));
	console.log(`Found ${localNotes.length} local Note(s) to delete via Mastodon API:`);
	for (const note of localNotes) {
		const mastodonId = mastodonIds.get(note.id) ?? 'UNASSIGNED';
		const preview = htmlToPlainText(String(note.content ?? '')).replaceAll(/\s+/g, ' ');
		console.log(`  - ${mastodonId} | ${String(note.published ?? '')} | ${note.id} | ${preview}`);
	}

	if (dryRun) {
		console.log(`\nDry-run complete. ${localNotes.length} status(es) would be deleted.`);
		return;
	}

	const userInfoDoc = await UserInfos.doc(escapeFirestoreKey(actorId)).get();
	const uid = userInfoDoc.data()?.uid;
	assert(typeof uid === 'string' && uid.length > 0, `UserInfo.uid not found for ${actorId}`);

	const tempAccessToken = randomBytes(32).toString('hex');
	const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
	const tokenDocRef = await AccessTokens.add({
		accessToken: tempAccessToken,
		accessTokenExpiresAt: expiresAt,
		scope: ['read', 'write'],
		client: {
			id: 'cli-delete-local-statuses',
			grants: ['authorization_code'],
		},
		user: {
			userId: uid,
		},
	});

	let deletedCount = 0;
	let failedCount = 0;
	try {
		for (const note of localNotes) {
			const mastodonId = mastodonIds.get(note.id);
			if (mastodonId === undefined) {
				console.error(`Skipping ${note.id}: Mastodon ID not assigned`);
				failedCount++;
				continue;
			}

			const url = `https://${mastodonDomain}/api/v1/statuses/${mastodonId}`;
			const response = await fetch(url, {
				method: 'DELETE',
				headers: {
					Authorization: `Bearer ${tempAccessToken}`,
				},
			});

			if (response.ok) {
				deletedCount++;
				console.log(`Deleted ${mastodonId} (${note.id}) -> HTTP ${response.status}`);
			} else {
				failedCount++;
				const text = await response.text();
				console.error(
					`Failed to delete ${mastodonId} (${note.id}) -> HTTP ${response.status}: ${text}`,
				);
			}
		}
	} finally {
		await tokenDocRef.delete();
	}

	console.log(`\nDone. Deleted: ${deletedCount}, Failed: ${failedCount}`);
	if (failedCount > 0) {
		process.exit(1);
	}
};

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
