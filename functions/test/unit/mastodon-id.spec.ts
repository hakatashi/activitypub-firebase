import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
	buildMastodonId,
	getIriByMastodonId,
	getMastodonIds,
	getOrAssignMastodonId,
	isMastodonId,
	mastodonIdToTimestamp,
	MAX_SEQUENCE,
	toIdTimestamp,
} from '../../src/mastodonId.js';
import Store from '../../src/store.js';

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT;

// 長さでソート → 辞書順でソート (Mastodon API ドキュメントの推奨手順) で比較する。
const compareIds = (a: string, b: string) => a.length - b.length || Number(a > b) - Number(a < b);

describe('buildMastodonId', () => {
	test('uses the Mastodon snowflake layout and pads to 20 digits', () => {
		const timestamp = Date.parse('2023-06-01T00:00:00.000Z');
		const id = buildMastodonId(timestamp, 0);
		expect(id).toHaveLength(20);
		expect(isMastodonId(id)).toBe(true);
		expect(BigInt(id)).toBe(BigInt(timestamp) << 16n);
		expect(mastodonIdToTimestamp(id)).toBe(timestamp);
	});

	test('pads small values to a fixed length', () => {
		expect(buildMastodonId(0, 1)).toBe('00000000000000000001');
	});

	test('orders by timestamp first, then by sequence', () => {
		const ids = [
			buildMastodonId(2000, 0),
			buildMastodonId(1000, MAX_SEQUENCE),
			buildMastodonId(1000, 0),
			buildMastodonId(1, 0),
		];
		expect([...ids].sort(compareIds)).toEqual([ids[3], ids[2], ids[1], ids[0]]);
	});

	test('rejects out-of-range input', () => {
		expect(() => buildMastodonId(-1, 0)).toThrow(RangeError);
		expect(() => buildMastodonId(2 ** 48, 0)).toThrow(RangeError);
		expect(() => buildMastodonId(0, MAX_SEQUENCE + 1)).toThrow(RangeError);
		expect(() => buildMastodonId(1.5, 0)).toThrow(RangeError);
	});
});

describe('isMastodonId', () => {
	test.each(['', '123', 'abcdefghijabcdefghij', '0000000000000000000a', '000000000000000000001'])(
		'rejects %j',
		(value) => {
			expect(isMastodonId(value)).toBe(false);
		},
	);
});

describe('toIdTimestamp', () => {
	const now = Date.parse('2026-10-02T00:00:00.000Z');

	test('uses published', () => {
		expect(toIdTimestamp('2023-06-01T00:00:00.000Z', now)).toBe(
			Date.parse('2023-06-01T00:00:00.000Z'),
		);
		expect(toIdTimestamp(['2023-06-01T00:00:00.000Z'], now)).toBe(
			Date.parse('2023-06-01T00:00:00.000Z'),
		);
		expect(toIdTimestamp(new Date('2023-06-01T00:00:00.000Z'), now)).toBe(
			Date.parse('2023-06-01T00:00:00.000Z'),
		);
	});

	test('clamps future published to now', () => {
		expect(toIdTimestamp('2100-01-01T00:00:00.000Z', now)).toBe(now);
	});

	test('falls back to now for missing or invalid published', () => {
		expect(toIdTimestamp(undefined, now)).toBe(now);
		expect(toIdTimestamp('not a date', now)).toBe(now);
	});
});

describe('Mastodon ID mapping (Firestore)', () => {
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

	test('maps both ways and is stable across calls', async () => {
		const iri = 'https://example.com/objects/1';
		const id = await getOrAssignMastodonId(iri, '2023-06-01T00:00:00.000Z');
		expect(mastodonIdToTimestamp(id)).toBe(Date.parse('2023-06-01T00:00:00.000Z'));
		expect(await getOrAssignMastodonId(iri, '2024-01-01T00:00:00.000Z')).toBe(id);
		expect(await getIriByMastodonId(id)).toBe(iri);
	});

	test('returns undefined for unknown or malformed ids', async () => {
		expect(await getIriByMastodonId(buildMastodonId(1, 0))).toBeUndefined();
		expect(await getIriByMastodonId('../objects')).toBeUndefined();
	});

	test('does not collide when many ids are assigned concurrently in the same millisecond', async () => {
		const published = '2023-06-01T00:00:00.000Z';
		const iris = Array.from({ length: 20 }, (_, i) => `https://example.com/objects/c${i}`);
		const ids = await Promise.all(iris.map((iri) => getOrAssignMastodonId(iri, published)));

		expect(new Set(ids).size).toBe(iris.length);
		for (const id of ids) {
			expect(mastodonIdToTimestamp(id)).toBe(Date.parse(published));
		}
		const reverse = await Promise.all(ids.map((id) => getIriByMastodonId(id)));
		expect(reverse).toEqual(iris);
	}, 30000);

	test('getMastodonIds returns existing ids and assigns missing ones in published order', async () => {
		const existing = await getOrAssignMastodonId(
			'https://example.com/objects/old',
			'2020-01-01T00:00:00.000Z',
		);
		const result = await getMastodonIds([
			{ iri: 'https://example.com/objects/old', published: '2099-01-01T00:00:00.000Z' },
			{ iri: 'https://example.com/objects/new', published: '2023-01-01T00:00:00.000Z' },
		]);
		expect(result.get('https://example.com/objects/old')).toBe(existing);
		const newId = result.get('https://example.com/objects/new');
		expect(newId).toBeDefined();
		expect(compareIds(existing, newId ?? '')).toBeLessThan(0);
	});

	test('Store#saveObject and Store#saveActivity assign ids', async () => {
		const store = new Store();
		const note = {
			id: 'https://example.com/objects/note',
			type: 'Note',
			published: '2023-06-01T00:00:00.000Z',
		};
		const activity = {
			id: 'https://example.com/activities/create',
			type: 'Create',
			published: '2023-06-01T00:00:01.000Z',
			object: note,
		};
		await store.saveObject(note);
		await store.saveActivity(activity);

		const ids = await getMastodonIds([
			{ iri: note.id, published: undefined },
			{ iri: activity.id, published: undefined },
		]);
		const noteId = ids.get(note.id);
		const activityId = ids.get(activity.id);
		expect(noteId && mastodonIdToTimestamp(noteId)).toBe(Date.parse(note.published));
		expect(activityId && mastodonIdToTimestamp(activityId)).toBe(Date.parse(activity.published));

		// 再保存しても ID は変わらない
		await store.saveObject({ ...note, content: 'edited' });
		await store.saveActivity(activity);
		expect(await getMastodonIds([{ iri: note.id, published: undefined }])).toEqual(
			new Map([[note.id, noteId]]),
		);
	});
});
