import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { APNote } from 'activitypub-types';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { apex } from '../../src/apex.js';
import { cleanUnattachedMedia } from '../../src/cleanup.js';
import { LOCAL_USERNAME } from '../../src/localActor.js';
import { noteToMediaAttachments } from '../../src/mastodon/statusAttributes.js';
import { findMastodonIds } from '../../src/mastodonId.js';
import { MediaAttachments, Streams } from '../../src/schema.js';
import {
	buildArchiveCreateActivity,
	convertArchiveAnnounce,
	convertArchiveNote,
	detectArchiveVisibility,
	extractStatusId,
	importArchiveItems,
	isOldActorStatusUri,
	resolveArchiveNoteIri,
	resolveArchivePublished,
	toArchiveStoragePaths,
} from '../../src/social/archive.js';
import type { ArchiveCreateItem, ArchiveItem } from '../../src/social/archive.js';
import { getReactedNoteIris } from '../../src/social/reactions.js';
import * as searchModule from '../../src/social/search.js';
import { resetMediaStorageDriver, setMediaStorageDriver } from '../../src/storage/media.js';
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

	describe('extractStatusId, isOldActorStatusUri, resolveArchiveNoteIri & resolveArchivePublished', () => {
		test('extracts status id from standard Mastodon status URIs', () => {
			expect(extractStatusId('https://pawoo.net/users/hakatashi/statuses/11622')).toBe('11622');
			expect(extractStatusId('https://pawoo.net/users/hakatashi/statuses/110660715599810805')).toBe(
				'110660715599810805',
			);
			expect(extractStatusId('https://pawoo.net/@hakatashi/12345')).toBe('12345');
			expect(extractStatusId('https://example.com/other')).toBeUndefined();
		});

		test('checks oldActorIri boundary strictly with trailing slash and valid status id', () => {
			const oldActorIri = 'https://pawoo.net/users/hakatashi';
			expect(
				isOldActorStatusUri('https://pawoo.net/users/hakatashi/statuses/100', oldActorIri),
			).toBe(true);
			expect(
				isOldActorStatusUri('https://pawoo.net/users/hakatashi_other/statuses/100', oldActorIri),
			).toBe(false);
			expect(isOldActorStatusUri('https://pawoo.net/users/hakatashi', oldActorIri)).toBe(false);
		});

		test('resolves archive note IRI deterministically', () => {
			const iri = resolveArchiveNoteIri('https://pawoo.net/users/hakatashi/statuses/11622');
			expect(iri).toBe(apex.utils.objectIdToIRI('11622'));
		});

		test('restores millisecond published timestamp for Snowflake status IDs', () => {
			// 110660715599810805 >> 16 = 1688548516842 (2023-07-05T09:15:16.842Z)
			expect(resolveArchivePublished('110660715599810805', '2023-07-05T09:15:16Z')).toBe(
				'2023-07-05T09:15:16.842Z',
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

		test('preserves remote inReplyTo without rewriting (including actor prefix lookalikes)', () => {
			const oldActorIri = 'https://pawoo.net/users/hakatashi';
			const converted = convertArchiveNote(
				me,
				{
					id: 'https://pawoo.net/users/hakatashi/statuses/200',
					inReplyTo: 'https://pawoo.net/users/hakatashi_other/statuses/999',
					content: '<p>reply to lookalike</p>',
				},
				oldActorIri,
			);

			expect(converted.note.inReplyTo).toBe('https://pawoo.net/users/hakatashi_other/statuses/999');
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
				id: 'https://pawoo.net/users/hakatashi/statuses/110660715599810805/activity',
				type: 'Create',
				actor: 'https://pawoo.net/users/hakatashi',
				published: '2023-07-05T09:15:16Z',
				object: {
					id: 'https://pawoo.net/users/hakatashi/statuses/110660715599810805',
					type: 'Note',
					published: '2023-07-05T09:15:16Z',
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
					inReplyTo: 'https://pawoo.net/users/hakatashi/statuses/110660715599810805',
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
			const snowflakeNoteId = apex.utils.objectIdToIRI('110660715599810805');
			const snowflakeNote = await apex.store.getObject(snowflakeNoteId, true);
			expect(snowflakeNote).toBeDefined();
			expect(snowflakeNote?.content).toBe('<p>Snowflake toot #welcome</p>');
			expect(snowflakeNote?.published).toBe('2023-07-05T09:15:16.842Z');
			expect(snowflakeNote?._meta?.hashtags).toEqual(['welcome']);

			const announceActivityId = apex.utils.activityIdToIRI('100700785027565134');
			const mastodonIds = await findMastodonIds([snowflakeNoteId, announceActivityId]);
			expect(mastodonIds.get(snowflakeNoteId)).toBe('00110660715599810805');
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

		test('recovers missing Create activity when Note object was already saved in a previous interrupted run', async () => {
			const partialItem = {
				id: 'https://pawoo.net/users/hakatashi/statuses/102/activity',
				type: 'Create' as const,
				actor: 'https://pawoo.net/users/hakatashi',
				published: '2017-04-14T11:00:00Z',
				object: {
					id: 'https://pawoo.net/users/hakatashi/statuses/102',
					type: 'Note',
					published: '2017-04-14T11:00:00Z',
					to: ['https://www.w3.org/ns/activitystreams#Public'],
					cc: ['https://pawoo.net/users/hakatashi/followers'],
					content: '<p>Interrupted import note</p>',
				},
			};

			const { note } = convertArchiveNote(
				me,
				partialItem.object,
				'https://pawoo.net/users/hakatashi',
			);
			await apex.store.saveObject(note);

			const result = await importArchiveItems(me, [partialItem]);
			expect(result.imported.length).toBe(1);
			expect(result.alreadyExists.length).toBe(0);

			const activityId = apex.utils.activityIdToIRI('102');
			const savedActivity = await apex.store.getActivity(activityId);
			expect(savedActivity).toBeDefined();
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
			const snowflakeNoteId = apex.utils.objectIdToIRI('110660715599810805');
			const snowflakeNote = await apex.store.getObject(snowflakeNoteId);
			expect(snowflakeNote).toBeUndefined();

			const streams = await Streams.get();
			expect(streams.size).toBe(0);
		});
	});

	describe('archive media attachments import (ADR-0127)', () => {
		let tempDir: string;
		const storageMap = new Map<string, { buffer: Buffer; mimeType: string }>();
		const deletedPaths: string[] = [];

		beforeEach(() => {
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-archive-media-'));
			storageMap.clear();
			deletedPaths.length = 0;

			setMediaStorageDriver({
				upload: vi.fn(),
				uploadPreview: vi.fn(),
				uploadArchiveFile: ({ storagePath, buffer, mimeType }) => {
					const alreadyExisted = storageMap.has(storagePath);
					if (!alreadyExisted) {
						storageMap.set(storagePath, { buffer, mimeType });
					}
					return Promise.resolve({
						url: `https://storage.googleapis.com/test-bucket/${storagePath}`,
						storagePath,
						alreadyExisted,
					});
				},
				delete: (paths: string[]) => {
					deletedPaths.push(...paths);
					return Promise.resolve();
				},
			});
		});

		afterEach(() => {
			resetMediaStorageDriver();
			fs.rmSync(tempDir, { recursive: true, force: true });
		});

		test('toArchiveStoragePaths maps original and small paths and rejects path traversal', () => {
			expect(
				toArchiveStoragePaths('/media_attachments/files/000/106/163/original/bc248cb77556eb9d.png'),
			).toEqual({
				storagePath: 'media_attachments/files/000/106/163/original/bc248cb77556eb9d.png',
				previewStoragePath: 'media_attachments/files/000/106/163/small/bc248cb77556eb9d.png',
			});

			expect(() => toArchiveStoragePaths('/media_attachments/files/../../../etc/passwd')).toThrow();
			expect(() => toArchiveStoragePaths('/other_dir/file.png')).toThrow();
		});

		test('imports image and video attachments, generates thumbnails and missing blurhash/dimensions, is idempotent, and is not deleted by cleanupMediaTask', async () => {
			const img1Rel = 'media_attachments/files/113/626/571/055/956/273/original/first.png';
			const img2Rel = 'media_attachments/files/113/626/571/141/560/687/original/second.jpeg';
			const vidRel = 'media_attachments/files/111/556/371/425/749/025/original/clip.mp4';

			for (const rel of [img1Rel, img2Rel, vidRel]) {
				fs.mkdirSync(path.join(tempDir, path.dirname(rel)), { recursive: true });
			}

			const pngBuffer = await sharp({
				create: {
					width: 800,
					height: 600,
					channels: 4,
					background: { r: 60, g: 120, b: 200, alpha: 1 },
				},
			})
				.png()
				.toBuffer();
			const jpegBuffer = await sharp({
				create: {
					width: 400,
					height: 300,
					channels: 3,
					background: { r: 200, g: 80, b: 60 },
				},
			})
				.jpeg()
				.toBuffer();
			const mp4Buffer = Buffer.from('fake-mp4-video-binary-content');

			fs.writeFileSync(path.join(tempDir, img1Rel), pngBuffer);
			fs.writeFileSync(path.join(tempDir, img2Rel), jpegBuffer);
			fs.writeFileSync(path.join(tempDir, vidRel), mp4Buffer);

			const mediaItems: ArchiveItem[] = [
				{
					id: 'https://pawoo.net/users/hakatashi/statuses/113626571363362037/activity',
					type: 'Create',
					actor: 'https://pawoo.net/users/hakatashi',
					published: '2024-12-10T10:00:00Z',
					object: {
						id: 'https://pawoo.net/users/hakatashi/statuses/113626571363362037',
						type: 'Note',
						published: '2024-12-10T10:00:00Z',
						to: ['https://www.w3.org/ns/activitystreams#Public'],
						cc: ['https://pawoo.net/users/hakatashi/followers'],
						sensitive: true,
						summary: 'CW spoiler',
						content: '<p>Post with two images and video</p>',
						attachment: [
							{
								type: 'Document',
								mediaType: 'image/png',
								url: `/${img1Rel}`,
								name: 'First alt text',
								blurhash: null, // Should be computed by sharp
								focalPoint: [0.25, -0.5],
								// width & height omitted to test sharp dimension fallback
							},
							{
								type: 'Document',
								mediaType: 'image/jpeg',
								url: `/${img2Rel}`,
								name: null,
								blurhash: 'UDSPX|Rj^%of$_ayE6ay?wt7sjay--fjIuay',
								width: 400,
								height: 300,
							},
							{
								type: 'Document',
								mediaType: 'video/mp4',
								url: `/${vidRel}`,
								name: 'Video description',
								blurhash: 'U009jvRjt7WBRjt7Rjoft7Rjt7WBRjt7Rjof',
								width: 1280,
								height: 720,
							},
						],
					},
				},
			];

			// 1. Dry-run reports total media size without uploading
			const dryRunResult = await importArchiveItems(me, mediaItems, {
				dryRun: true,
				archiveDir: tempDir,
			});
			expect(storageMap.size).toBe(0);
			expect(dryRunResult.media.totalFiles).toBe(3);
			expect(dryRunResult.media.uploadedFiles).toBe(3);
			expect(dryRunResult.media.totalBytes).toBe(
				pngBuffer.length + jpegBuffer.length + mp4Buffer.length,
			);
			expect(dryRunResult.media.byMediaType['image/png']?.count).toBe(1);
			expect(dryRunResult.media.byMediaType['image/jpeg']?.count).toBe(1);
			expect(dryRunResult.media.byMediaType['video/mp4']?.count).toBe(1);

			// 2. Actual import uploads originals + image thumbnails
			const importResult = await importArchiveItems(me, mediaItems, {
				archiveDir: tempDir,
			});
			expect(importResult.failed).toEqual([]);
			expect(importResult.imported).toHaveLength(1);
			expect(importResult.media.totalFiles).toBe(3);
			expect(importResult.media.uploadedFiles).toBe(3);
			expect(importResult.media.alreadyUploadedFiles).toBe(0);
			// 2 images * (original + small) + 1 video (original only) = 5 Storage files
			expect(storageMap.size).toBe(5);
			expect(
				storageMap.has('media_attachments/files/113/626/571/055/956/273/small/first.png'),
			).toBe(true);
			expect(
				storageMap.has('media_attachments/files/113/626/571/141/560/687/small/second.jpeg'),
			).toBe(true);

			// Verify saved Note and derived Status media_attachments
			const noteIri = apex.utils.objectIdToIRI('113626571363362037');
			const savedNote = await apex.store.getObject(noteIri);
			expect(savedNote).toBeDefined();

			const statusId = '00113626571363362037';
			const derived = noteToMediaAttachments(savedNote as unknown as APNote, statusId, {
				isLocal: true,
			});
			expect(derived).toHaveLength(3);

			// Unique IDs even though both images start with /media_attachments/files/113/...
			expect(derived[0]?.id).toBe(`${statusId}0`);
			expect(derived[1]?.id).toBe(`${statusId}1`);
			expect(derived[2]?.id).toBe(`${statusId}2`);

			expect(derived[0]).toMatchObject({
				type: 'image',
				url: `https://storage.googleapis.com/test-bucket/${img1Rel}`,
				preview_url:
					'https://storage.googleapis.com/test-bucket/media_attachments/files/113/626/571/055/956/273/small/first.png',
				remote_url: null,
				description: 'First alt text',
				meta: {
					original: { width: 800, height: 600, size: '800x600', aspect: 800 / 600 },
					small: { width: 800, height: 600, size: '800x600', aspect: 800 / 600 },
					focus: { x: 0.25, y: -0.5 },
				},
			});
			expect(typeof derived[0]?.blurhash).toBe('string');
			expect((derived[0]?.blurhash ?? '').length).toBeGreaterThan(5);

			expect(derived[1]).toMatchObject({
				type: 'image',
				url: `https://storage.googleapis.com/test-bucket/${img2Rel}`,
				preview_url:
					'https://storage.googleapis.com/test-bucket/media_attachments/files/113/626/571/141/560/687/small/second.jpeg',
				description: null,
				blurhash: 'UDSPX|Rj^%of$_ayE6ay?wt7sjay--fjIuay',
			});

			expect(derived[2]).toMatchObject({
				type: 'video',
				url: `https://storage.googleapis.com/test-bucket/${vidRel}`,
				preview_url: null,
				description: 'Video description',
				blurhash: 'U009jvRjt7WBRjt7Rjoft7Rjt7WBRjt7Rjof',
				meta: {
					original: { width: 1280, height: 720, size: '1280x720', aspect: 1280 / 720 },
				},
			});

			// 3. Re-running is idempotent: skips Note and does not re-upload media
			const secondRun = await importArchiveItems(me, mediaItems, {
				archiveDir: tempDir,
			});
			expect(secondRun.imported).toHaveLength(0);
			expect(secondRun.alreadyExists).toHaveLength(1);
			expect(secondRun.media.totalFiles).toBe(3);
			expect(secondRun.media.uploadedFiles).toBe(0);
			expect(secondRun.media.alreadyUploadedFiles).toBe(3);

			// 4. cleanupMediaTask does not delete imported media (MediaAttachments is empty)
			const mediaDocs = await MediaAttachments.get();
			expect(mediaDocs.empty).toBe(true);
			const deletedCount = await cleanUnattachedMedia({
				now: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
			});
			expect(deletedCount).toBe(0);
			expect(deletedPaths).toEqual([]);
		});

		test('resumes media import when Note and Create activity already exist in Firestore with relative attachment URLs', async () => {
			const imgRel = 'media_attachments/files/000/106/163/original/bc248cb77556eb9d.png';
			fs.mkdirSync(path.join(tempDir, path.dirname(imgRel)), { recursive: true });
			const pngBuffer = await sharp({
				create: {
					width: 200,
					height: 100,
					channels: 3,
					background: { r: 10, g: 20, b: 30 },
				},
			})
				.png()
				.toBuffer();
			fs.writeFileSync(path.join(tempDir, imgRel), pngBuffer);

			const item: ArchiveCreateItem = {
				id: 'https://pawoo.net/users/hakatashi/statuses/940000/activity',
				type: 'Create',
				actor: 'https://pawoo.net/users/hakatashi',
				published: '2017-05-01T00:00:00Z',
				object: {
					id: 'https://pawoo.net/users/hakatashi/statuses/940000',
					type: 'Note',
					published: '2017-05-01T00:00:00Z',
					to: ['https://www.w3.org/ns/activitystreams#Public'],
					cc: ['https://pawoo.net/users/hakatashi/followers'],
					content: '<p>Previously imported without media</p>',
					attachment: [
						{
							type: 'Document',
							mediaType: 'image/png',
							url: `/${imgRel}`,
							name: 'Resumed image',
						},
					],
				},
			};

			// Simulate state where Note & Create were saved with relative attachment URL (#268 / interrupted run)
			const { note, statusId } = convertArchiveNote(
				me,
				item.object,
				'https://pawoo.net/users/hakatashi',
			);
			const activity = buildArchiveCreateActivity(me, note, {
				oldActivityUri: item.id,
				statusId,
			});
			await apex.store.saveObject(note);
			await apex.store.saveActivity(activity);

			// Now run importArchiveItems with archiveDir
			const result = await importArchiveItems(me, [item], { archiveDir: tempDir });
			expect(result.failed).toEqual([]);
			expect(result.imported).toHaveLength(1);
			expect(result.media.uploadedFiles).toBe(1);

			const updatedNote = await apex.store.getObject(note.id);
			const updatedAttachments = (updatedNote?.attachment ?? []) as Array<Record<string, unknown>>;
			expect(updatedAttachments[0]?.url).toBe(
				`https://storage.googleapis.com/test-bucket/${imgRel}`,
			);

			const updatedActivity = await apex.store.getActivity(activity.id);
			const embeddedNote = (updatedActivity?.object as Record<string, unknown> | undefined) ?? {};
			const embeddedAttachments = (embeddedNote.attachment ?? []) as Array<Record<string, unknown>>;
			expect(embeddedAttachments[0]?.url).toBe(
				`https://storage.googleapis.com/test-bucket/${imgRel}`,
			);
		});
	});
});
