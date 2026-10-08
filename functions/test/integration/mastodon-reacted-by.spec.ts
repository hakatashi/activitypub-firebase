import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { APObject } from '../../src/apex/index.js';
import { apex } from '../../src/apex.js';
import { getMastodonIds } from '../../src/mastodonId.js';
import { buildMetaIndex } from '../../src/meta.js';
import { plainTextToHtml, publishNote } from '../../src/notes.js';
import { Streams } from '../../src/schema.js';
import {
	addAccessToken,
	createLocalActor,
	mastodon as mastodonReq,
	resetFirestore,
} from '../helpers/index.js';
import type { LocalActor } from '../helpers/index.js';

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
const REMOTE_BOB = 'https://remote.example/users/bob';
const REMOTE_GHOST = 'https://remote.example/users/ghost';

const endpoints = [
	{ path: 'favourited_by', add: 'favourite', remove: 'unfavourite', type: 'Like' },
	{ path: 'reblogged_by', add: 'reblog', remove: 'unreblog', type: 'Announce' },
] as const;

// `Link` ヘッダの rel に対応する URL を、テスト用リクエストのパスに直す。
const getLinkPath = (link: string | undefined, rel: 'next' | 'prev') => {
	const match = link?.match(new RegExp(`<([^>]+)>; rel="${rel}"`));
	if (match?.[1] === undefined) {
		return undefined;
	}
	const url = new URL(match[1]);
	return `${url.pathname}${url.search}`;
};

// getReactionPageEntries は onStreamWritten が書く `_meta.index` を引くので、トリガーの代わりに書いておく。
const reindexStreams = async () => {
	const docs = await Streams.get();
	await Promise.all(
		docs.docs.map((doc) => doc.ref.update({ '_meta.index': buildMetaIndex(doc.data()) })),
	);
};

describe('GET /api/v1/statuses/:id/favourited_by and reblogged_by (Issue #224, ADR-0101)', () => {
	let me: LocalActor;
	let note: APObject;
	let statusId: string;

	const action = async (name: string, token: string, id = statusId) => {
		const res = await mastodonReq.post(`/api/v1/statuses/${id}/${name}`, token);
		expect(res.status).toBe(200);
		return res.body as { id: string };
	};

	const list = async (path: string, token?: string) => {
		await reindexStreams();
		const res = await mastodonReq.get(path, token);
		expect(res.status).toBe(200);
		return {
			usernames: (res.body as { username: string }[]).map((account) => account.username),
			link: res.headers.link as string | undefined,
		};
	};

	// oxlint-disable-next-line max-params
	const saveRemoteReaction = async (
		type: 'Like' | 'Announce',
		actor: string,
		suffix: string,
		published: string,
		to: string[] = [PUBLIC],
	) => {
		await apex.store.saveActivity({
			id: `${actor}/activities/${suffix}`,
			type,
			actor,
			object: note.id,
			published,
			to,
			cc: [],
		} as unknown as APObject);
	};

	beforeEach(async () => {
		vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(true);
		vi.spyOn(apex, 'publishUpdate').mockResolvedValue(undefined as never);
		me = await createLocalActor('hakatashi', { uid: 'uid-hakatashi', id: '1' });
		await createLocalActor('alice', { uid: 'uid-alice', id: '2' });
		await createLocalActor('carol', { uid: 'uid-carol', id: '3' });
		await addAccessToken('me-token', 'read write', 'uid-hakatashi');
		await addAccessToken('alice-token', 'read write', 'uid-alice');
		await addAccessToken('carol-token', 'read write', 'uid-carol');
		await apex.store.saveObject({
			id: REMOTE_BOB,
			type: 'Person',
			preferredUsername: 'bob',
			inbox: `${REMOTE_BOB}/inbox`,
			outbox: `${REMOTE_BOB}/outbox`,
			followers: `${REMOTE_BOB}/followers`,
		} as unknown as APObject);
		({ object: note } = await publishNote(me, {
			content: plainTextToHtml('hello'),
			visibility: 'public',
		}));
		statusId = (await getMastodonIds([{ iri: note.id, published: note.published }])).get(note.id)!;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await resetFirestore();
	});

	describe.each(endpoints)('$path', ({ path, add, remove, type }) => {
		const url = () => `/api/v1/statuses/${statusId}/${path}`;

		test('returns an empty list without a Link header', async () => {
			const { usernames, link } = await list(url());
			expect(usernames).toEqual([]);
			expect(link).toBeUndefined();
		});

		test('returns accounts newest-first without authentication, and pages with Link', async () => {
			await saveRemoteReaction(type, REMOTE_BOB, 'old', '2020-01-01T00:00:00.000Z');
			await action(add, 'alice-token');
			await action(add, 'carol-token');
			const expected = ['carol', 'alice', 'bob'];

			expect((await list(url())).usernames).toEqual(expected);
			expect((await list(url(), 'me-token')).usernames).toEqual(expected);

			const first = await list(`${url()}?limit=2`);
			expect(first.usernames).toEqual(expected.slice(0, 2));
			const nextPath = getLinkPath(first.link, 'next');
			expect(nextPath).toContain('limit=2');

			const second = await list(nextPath!);
			expect(second.usernames).toEqual(expected.slice(2));

			const third = await list(getLinkPath(second.link, 'next')!);
			expect(third.usernames).toEqual([]);
			expect(third.link).toBeUndefined();

			const back = await list(getLinkPath(second.link, 'prev')!);
			expect(back.usernames).toEqual(expected.slice(0, 2));
		});

		test('excludes undone reactions', async () => {
			// 取り消しの射影はローカル actor (hakatashi) の分しかないので、自分で取り消す
			await action(add, 'me-token');
			await action(add, 'carol-token');
			expect((await list(url())).usernames).toEqual(['carol', 'hakatashi']);
			await action(remove, 'me-token');
			expect((await list(url())).usernames).toEqual(['carol']);
		});

		test('counts an actor once even if multiple activities remain', async () => {
			await saveRemoteReaction(type, REMOTE_BOB, 'first', '2020-01-01T00:00:00.000Z');
			await action(add, 'alice-token');
			await saveRemoteReaction(
				type,
				REMOTE_BOB,
				'second',
				new Date(Date.now() + 1000).toISOString(),
			);
			expect((await list(url())).usernames).toEqual(['bob', 'alice']);
		});

		test('skips actors that are not stored, but keeps the cursor moving', async () => {
			await saveRemoteReaction(type, REMOTE_BOB, 'old', '2020-01-01T00:00:00.000Z');
			await saveRemoteReaction(type, REMOTE_GHOST, 'new', '2020-01-02T00:00:00.000Z');
			const first = await list(`${url()}?limit=1`);
			expect(first.usernames).toEqual([]);
			const second = await list(getLinkPath(first.link, 'next')!);
			expect(second.usernames).toEqual(['bob']);
		});

		test('returns 404 for a status the viewer cannot see', async () => {
			const { object: privateNote } = await publishNote(me, {
				content: plainTextToHtml('followers only'),
				visibility: 'private',
			});
			const privateId = (
				await getMastodonIds([{ iri: privateNote.id, published: privateNote.published }])
			).get(privateNote.id)!;
			expect((await mastodonReq.get(`/api/v1/statuses/${privateId}/${path}`)).status).toBe(404);
			expect(
				(await mastodonReq.get(`/api/v1/statuses/${privateId}/${path}`, 'alice-token')).status,
			).toBe(404);
			expect(
				(await mastodonReq.get(`/api/v1/statuses/${privateId}/${path}`, 'me-token')).status,
			).toBe(200);
			expect((await mastodonReq.get(`/api/v1/statuses/99999999999999999999/${path}`)).status).toBe(
				404,
			);
		});
	});

	test('reblogged_by excludes non-public boosts', async () => {
		await saveRemoteReaction('Announce', REMOTE_BOB, 'private', '2020-01-01T00:00:00.000Z', [
			`${REMOTE_BOB}/followers`,
		]);
		await action('reblog', 'alice-token');
		expect((await list(`/api/v1/statuses/${statusId}/reblogged_by`)).usernames).toEqual(['alice']);
	});

	test('a boost ID resolves to the boosted status', async () => {
		const boost = await action('reblog', 'alice-token');
		await action('favourite', 'carol-token');
		expect((await list(`/api/v1/statuses/${boost.id}/favourited_by`)).usernames).toEqual(['carol']);
		expect((await list(`/api/v1/statuses/${boost.id}/reblogged_by`)).usernames).toEqual(['alice']);
	});
});
