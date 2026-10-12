import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { apex } from '../../src/apex.js';
import { LOCAL_USERNAME } from '../../src/localActor.js';
import { findMastodonIds } from '../../src/mastodonId.js';
import { Streams } from '../../src/schema.js';
import {
	convertArchiveAnnounce,
	convertArchiveNote,
	detectArchiveVisibility,
	extractStatusId,
	importArchiveItems,
	resolveArchiveNoteIri,
	resolveArchivePublished,
} from '../../src/social/archive.js';
import type { ArchiveItem } from '../../src/social/archive.js';
import { getReactedNoteIris } from '../../src/social/reactions.js';
import * as searchModule from '../../src/social/search.js';
import { createLocalActor, resetFirestore } from '../helpers/index.js';
import type { LocalActor } from '../helpers/index.js';
import { toIdArray } from '../../src/utils.js';

describe('social/archive (ADR-0126)', () => {
	let me: LocalActor;
	let deliveryEnqueueSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		deliveryEnqueueSpy = vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(true);
		me = await createLocalActor(LOCAL_USERNAME);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await resetFirestore();
	});

	describe('extractStatusId, resolveArchiveNoteIri & resolveArchivePublished', () => {
		test('extracts status id from standard Mastodon status URIs', () => {
			expect(extractStatusId('https://pawoo.net/users/hakatashi/statuses/11622')).toBe('11622');
			expect(extractStatusId('https://pawoo.net/users/hakatashi/statuses/110660715599810805')).toBe(
				'110660715599810805',
			);
			expect(extractStatusId('https://pawoo.net/@hakatashi/12345')).toBe('12345');
			expect(extractStatusId('https://example.com/other')).toBeUndefined();
		});

		test('resolves archive note IRI deterministically', () => {
			const iri = resolveArchiveNoteIri('https://pawoo.net/users/hakatashi/statuses/11622');
			expect(iri).toBe(apex.utils.objectIdToIRI('11622'));
		});

		test('restores millisecond published timestamp for Snowflake status IDs', () => {
			// 117416500863858883 >> 16 = 1791633619138 (2026-10-10T12:00:19.138Z)
			expect(resolveArchivePublished('117416500863858883', '2026-10-10T12:00:19Z')).toBe(
				'2026-10-10T12:00:19.138Z',
			);
			// Pre-Snowflake sequential ID keeps original published
			expect(resolveArchivePublished('11622', '2017-04-14T14:36:43Z')).toBe('2017-04-14T14:36:43Z');
		});
	});

	describe('detectArchiveVisibility', () => {
		const publicAddress = apex.consts.publicAddress;
		const followers = 'https://example.com/followers';

		test('detects public when to includes Public', () => {
			expect(detectArchiveVisibility([publicAddress], [followers], followers)).toBe('public');
		});

		test('detects unlisted when cc includes Public', () => {
			expect(detectArchiveVisibility([followers], [publicAddress], followers)).toBe('unlisted');
		});

		test('detects private when only followers included', () => {
			expect(detectArchiveVisibility([followers], [], followers)).toBe('private');
		});

		test('detects direct when neither Public nor followers included', () => {
			expect(detectArchiveVisibility(['https://remote.example/users/alice'], [], followers)).toBe(
				'direct',
			);
		});
	});

	describe('convertArchiveNote & convertArchiveAnnounce', () => {
		test('converts archive note with attribution, audience, and metadata', () => {
			const oldActorIri = 'https://pawoo.net/users/hakatashi';
			const converted = convertArchiveNote(
				me,
				{
					id: 'https://pawoo.net/users/hakatashi/statuses/11622',
					type: 'Note',
					published: '2017-04-14T14:36:43Z',
					to: ['https://www.w3.org/ns/activitystreams#Public'],
					cc: ['https://pawoo.net/users/hakatashi/followers'],
					content: '<p>Test content</p>',
					tag: [
						{
							type: 'Hashtag',
							name: '#test',
							href: 'https://pawoo.net/tags/test',
						},
					],
					attachment: [
						{
							type: 'Document',
							mediaType: 'image/png',
							url: '/media_attachments/files/000/106/163/original/bc248cb77556eb9d.png',
						},
					],
				},
				oldActorIri,
			);

			expect(converted.statusId).toBe('11622');
			expect(converted.oldUri).toBe('https://pawoo.net/users/hakatashi/statuses/11622');
			expect(converted.visibility).toBe('public');
			expect(converted.note.id).toBe(apex.utils.objectIdToIRI('11622'));
			expect(converted.note.attributedTo).toBe(me.id);
			expect(converted.note.content).toBe('<p>Test content</p>');
			expect(converted.note.published).toBe('2017-04-14T14:36:43Z');
			expect(converted.note.to).toEqual(['https://www.w3.org/ns/activitystreams#Public']);
			expect(converted.note.cc).toEqual(toIdArray(me.followers));
			expect(converted.note.tag).toEqual([
				{
					type: 'Hashtag',
					name: '#test',
					href: 'https://pawoo.net/tags/test',
				},
			]);
			expect(converted.note.attachment).toEqual([
				{
					type: 'Document',
					mediaType: 'image/png',
					url: '/media_attachments/files/000/106/163/original/bc248cb77556eb9d.png',
				},
			]);
			expect(converted.note._meta).toEqual({
				legacyUri: 'https://pawoo.net/users/hakatashi/statuses/11622',
			});
		});

		test('rewrites inReplyTo for self-reply to new local IRI', () => {
			const oldActorIri = 'https://pawoo.net/users/hakatashi';
			const converted = convertArchiveNote(
				me,
				{
					id: 'https://pawoo.net/users/hakatashi/statuses/200',
					inReplyTo: 'https://pawoo.net/users/hakatashi/statuses/100',
					content: '<p>reply</p>',
				},
				oldActorIri,
			);

			expect(converted.note.inReplyTo).toBe(apex.utils.objectIdToIRI('100'));
		});

		test('preserves remote inReplyTo without rewriting', () => {
			const oldActorIri = 'https://pawoo.net/users/hakatashi';
			const converted = convertArchiveNote(
				me,
				{
					id: 'https://pawoo.net/users/hakatashi/statuses/200',
					inReplyTo: 'https://remote.example/users/bob/statuses/999',
					content: '<p>reply to bob</p>',
				},
				oldActorIri,
			);

			expect(converted.note.inReplyTo).toBe('https://remote.example/users/bob/statuses/999');
		});

		test('converts archive announce with outbox collection and audience', () => {
			const oldActorIri = 'https://pawoo.net/users/hakatashi';
			const targetNoteIri = 'https://pawoo.net/users/halcana/statuses/100700783445017986';
			const converted = convertArchiveAnnounce(
				me,
				{
					id: 'https://pawoo.net/users/hakatashi/statuses/100700785027565134/activity',
					type: 'Announce',
					actor: oldActorIri,
					published: '2018-09-10T09:33:57Z',
					to: ['https://www.w3.org/ns/activitystreams#Public'],
					cc: ['https://pawoo.net/users/halcana', 'https://pawoo.net/users/hakatashi/followers'],
					object: targetNoteIri,
				},
				{ oldActorIri, targetNoteIri },
			);

			expect(converted.statusId).toBe('100700785027565134');
			expect(converted.visibility).toBe('public');
			expect(converted.activity.id).toBe(apex.utils.activityIdToIRI('100700785027565134'));
			expect(converted.activity.type).toBe('Announce');
			expect(converted.activity.actor).toBe(me.id);
			expect(converted.activity.object).toBe(targetNoteIri);
			expect(converted.activity._meta?.collection).toEqual(toIdArray(me.outbox));
		});
	});

	describe('importArchiveItems', () => {
		const remoteBoostTargetIri = 'https://pawoo.net/users/someone/statuses/50';
		const sampleItems: ArchiveItem[] = [
			{
				id: 'https://pawoo.net/users/hakatashi/statuses/117416500863858883/activity',
				type: 'Create',
				actor: 'https://pawoo.net/users/hakatashi',
				published: '2026-10-10T12:00:19Z',
				object: {
					id: 'https://pawoo.net/users/hakatashi/statuses/117416500863858883',
					type: 'Note',
					published: '2026-10-10T12:00:19Z',
					to: ['https://www.w3.org/ns/activitystreams#Public'],
					cc: ['https://pawoo.net/users/hakatashi/followers'],
					content: '<p>Snowflake toot #welcome</p>',
					tag: [{ type: 'Hashtag', name: '#welcome' }],
				},
			},
			{
				id: 'https://pawoo.net/users/hakatashi/statuses/102/activity',
				type: 'Create',
				actor: 'https://pawoo.net/users/hakatashi',
				published: '2017-04-14T11:00:00Z',
				object: {
					id: 'https://pawoo.net/users/hakatashi/statuses/102',
					type: 'Note',
					published: '2017-04-14T11:00:00Z',
					to: ['https://pawoo.net/users/hakatashi/followers'],
					cc: [],
					inReplyTo: 'https://pawoo.net/users/hakatashi/statuses/117416500863858883',
					content: '<p>Self reply thread</p>',
				},
			},
			{
				id: 'https://pawoo.net/users/hakatashi/statuses/100700785027565134/activity',
				type: 'Announce',
				actor: 'https://pawoo.net/users/hakatashi',
				published: '2018-09-10T09:33:57Z',
				to: ['https://www.w3.org/ns/activitystreams#Public'],
				cc: ['https://pawoo.net/users/hakatashi/followers'],
				object: remoteBoostTargetIri,
			},
		];

		test('imports notes and announces without delivering anything, preserves Snowflake Mastodon IDs, and handles idempotency', async () => {
			const remoteNote = {
				id: remoteBoostTargetIri,
				type: 'Note',
				attributedTo: 'https://pawoo.net/users/someone',
				published: '2017-04-14T11:30:00Z',
				to: ['https://www.w3.org/ns/activitystreams#Public'],
				cc: ['https://pawoo.net/users/someone/followers'],
				content: '<p>Remote boosted toot</p>',
			};
			await apex.store.saveObject(remoteNote);
			vi.spyOn(searchModule, 'resolveUrl').mockResolvedValue(remoteNote);

			const result = await importArchiveItems(me, sampleItems, { concurrency: 2 });

			// 絶対に配送キューが呼ばれないこと (ADR-0126)
			expect(deliveryEnqueueSpy).not.toHaveBeenCalled();

			expect(result.total).toBe(3);
			expect(result.imported.length).toBe(2);
			expect(result.importedAnnounces.length).toBe(1);
			expect(result.alreadyExists.length).toBe(0);
			expect(result.failed.length).toBe(0);
			expect(result.visibilityCounts.public).toBe(1);
			expect(result.visibilityCounts.private).toBe(1);

			// Snowflake Note の Mastodon ID が 00 + 旧 status ID と完全一致すること
			const snowflakeNoteId = apex.utils.objectIdToIRI('117416500863858883');
			const snowflakeNote = await apex.store.getObject(snowflakeNoteId, true);
			expect(snowflakeNote).toBeDefined();
			expect(snowflakeNote?.content).toBe('<p>Snowflake toot #welcome</p>');
			expect(snowflakeNote?.published).toBe('2026-10-10T12:00:19.138Z');
			expect(snowflakeNote?._meta?.hashtags).toEqual(['welcome']);

			const announceActivityId = apex.utils.activityIdToIRI('100700785027565134');
			const mastodonIds = await findMastodonIds([snowflakeNoteId, announceActivityId]);
			expect(mastodonIds.get(snowflakeNoteId)).toBe('00117416500863858883');
			expect(mastodonIds.get(announceActivityId)).toBe('00100700785027565134');

			// Note 102 が自リプライとして保存されていること
			const note102Id = apex.utils.objectIdToIRI('102');
			const note102 = await apex.store.getObject(note102Id, true);
			expect(note102).toBeDefined();
			expect(note102?.inReplyTo).toBe(snowflakeNoteId);

			// Streams (outbox) に Create 2件 + Announce 1件が保存されていること
			const outboxIri = toIdArray(me.outbox)[0];
			const outboxStreams = await Streams.where(
				'_meta.collection',
				'array-contains',
				outboxIri,
			).get();
			expect(outboxStreams.size).toBe(3);

			// reblogs 射影が更新されていること
			const reblogged = await getReactedNoteIris(me.id, 'reblogs', [remoteBoostTargetIri]);
			expect(reblogged.has(remoteBoostTargetIri)).toBe(true);

			// 2回目の実行: 冪等にスキップされること
			const secondResult = await importArchiveItems(me, sampleItems, { concurrency: 2 });
			expect(deliveryEnqueueSpy).not.toHaveBeenCalled();
			expect(secondResult.imported.length).toBe(0);
			expect(secondResult.importedAnnounces.length).toBe(0);
			expect(secondResult.alreadyExists.length).toBe(3);
		});

		test('dry-run does not write to database', async () => {
			const result = await importArchiveItems(me, sampleItems, {
				dryRun: true,
				concurrency: 2,
			});

			expect(deliveryEnqueueSpy).not.toHaveBeenCalled();
			expect(result.imported.length).toBe(2);
			expect(result.importedAnnounces.length).toBe(1);

			// DB に書き込まれていないこと
			const snowflakeNoteId = apex.utils.objectIdToIRI('117416500863858883');
			const snowflakeNote = await apex.store.getObject(snowflakeNoteId);
			expect(snowflakeNote).toBeUndefined();

			const streams = await Streams.get();
			expect(streams.size).toBe(0);
		});
	});
});
