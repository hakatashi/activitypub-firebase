import { describe, expect, test, afterEach, beforeEach } from 'vitest';
import { escapeFirestoreKey } from '../../src/firebase.js';
import { removeSupersededFollows } from '../../src/follows.js';
import { buildMetaIndex } from '../../src/meta.js';
import { Streams } from '../../src/schema.js';

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT;

const saveFollow = (id: string, actor: string, object: string) => {
	const activity = { id, type: 'Follow', actor: [actor], object: [object] };
	return Streams.doc(escapeFirestoreKey(id)).set({
		...activity,
		_meta: { index: buildMetaIndex(activity) },
	} as never);
};

describe('removeSupersededFollows', () => {
	beforeEach(() => {
		if (firestoreHost === undefined || projectId === undefined) {
			throw new Error('Firestore emulator is not running');
		}
	});

	afterEach(async () => {
		await fetch(
			`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
			{ method: 'DELETE' },
		);
	});

	test('removes older Follows from the same actor to the same object only', async () => {
		const me = 'https://example.com/u/me';
		const alice = 'https://remote.example/u/alice';
		await saveFollow('https://remote.example/f1', alice, me);
		await saveFollow('https://remote.example/f2', alice, me);
		await saveFollow('https://remote.example/f3', 'https://remote.example/u/bob', me);
		await saveFollow('https://remote.example/f4', alice, 'https://example.com/u/other');

		const removed = await removeSupersededFollows(alice, me, 'https://remote.example/f2');

		expect(removed).toBe(1);
		const ids = (await Streams.get()).docs.map((doc) => doc.data().id).toSorted();
		expect(ids).toEqual([
			'https://remote.example/f2',
			'https://remote.example/f3',
			'https://remote.example/f4',
		]);
	});
});
