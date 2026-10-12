import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { apex } from '../../src/apex.js';
import { LOCAL_USERNAME } from '../../src/localActor.js';
import { Streams } from '../../src/schema.js';
import {
	convertArchiveNote,
	detectArchiveVisibility,
	extractStatusId,
	importArchiveItems,
	resolveArchiveNoteIri,
} from '../../src/social/archive.js';
import type { ArchiveItem } from '../../src/social/archive.js';
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
		await resetFirestore();
	});

	describe('extractStatusId & resolveArchiveNoteIri', () => {
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

	describe('convertArchiveNote', () => {
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
	});

	describe('importArchiveItems', () => {
		const sampleItems: ArchiveItem[] = [
			{
				id: 'https://pawoo.net/users/hakatashi/statuses/101/activity',
				type: 'Create',
				actor: 'https://pawoo.net/users/hakatashi',
				published: '2017-04-14T10:00:00Z',
				object: {
					id: 'https://pawoo.net/users/hakatashi/statuses/101',
					type: 'Note',
					published: '2017-04-14T10:00:00Z',
					to: ['https://www.w3.org/ns/activitystreams#Public'],
					cc: ['https://pawoo.net/users/hakatashi/followers'],
					content: '<p>First toot #welcome</p>',
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
					inReplyTo: 'https://pawoo.net/users/hakatashi/statuses/101',
					content: '<p>Self reply thread</p>',
				},
			},
			{
				id: 'https://pawoo.net/users/hakatashi/statuses/103/activity',
				type: 'Announce',
				actor: 'https://pawoo.net/users/hakatashi',
				published: '2017-04-14T12:00:00Z',
				object: 'https://pawoo.net/users/someone/statuses/50',
			},
		];

		test('imports notes without delivering anything, and handles idempotency', async () => {
			const result = await importArchiveItems(me, sampleItems, { concurrency: 2 });

			// 絶対に配送キューが呼ばれないこと (ADR-0126)
			expect(deliveryEnqueueSpy).not.toHaveBeenCalled();

			expect(result.total).toBe(3);
			expect(result.imported.length).toBe(2);
			expect(result.skippedAnnounce.length).toBe(1);
			expect(result.alreadyExists.length).toBe(0);
			expect(result.failed.length).toBe(0);
			expect(result.visibilityCounts.public).toBe(1);
			expect(result.visibilityCounts.private).toBe(1);

			// Note 101 が保存されていること
			const note101Id = apex.utils.objectIdToIRI('101');
			const note101 = await apex.store.getObject(note101Id, true);
			expect(note101).toBeDefined();
			expect(note101?.content).toBe('<p>First toot #welcome</p>');
			expect(note101?._meta?.hashtags).toEqual(['welcome']);

			// Note 102 が自リプライとして保存されていること
			const note102Id = apex.utils.objectIdToIRI('102');
			const note102 = await apex.store.getObject(note102Id, true);
			expect(note102).toBeDefined();
			expect(note102?.inReplyTo).toBe(note101Id);

			// Streams (outbox) に Create アクティビティが保存されていること
			const outboxIri = toIdArray(me.outbox)[0];
			const stream101 = await Streams.where('_meta.collection', 'array-contains', outboxIri).get();
			expect(stream101.size).toBe(2);
			const stream101Doc = stream101.docs.find(
				(doc) => (doc.data().object as { id?: string })?.id === note101Id,
			);
			expect(stream101Doc).toBeDefined();
			expect(stream101Doc?.data().type).toBe('Create');

			// 2回目の実行: 冪等にスキップされること
			const secondResult = await importArchiveItems(me, sampleItems, { concurrency: 2 });
			expect(deliveryEnqueueSpy).not.toHaveBeenCalled();
			expect(secondResult.imported.length).toBe(0);
			expect(secondResult.alreadyExists.length).toBe(2);
			expect(secondResult.skippedAnnounce.length).toBe(1);
		});

		test('dry-run does not write to database', async () => {
			const result = await importArchiveItems(me, sampleItems, {
				dryRun: true,
				concurrency: 2,
			});

			expect(deliveryEnqueueSpy).not.toHaveBeenCalled();
			expect(result.imported.length).toBe(2);

			// DB に書き込まれていないこと
			const note101Id = apex.utils.objectIdToIRI('101');
			const note101 = await apex.store.getObject(note101Id);
			expect(note101).toBeUndefined();

			const streams = await Streams.get();
			expect(streams.size).toBe(0);
		});
	});
});
