import sharp from 'sharp';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { apex } from '../../src/apex.js';
import { mediaUploadApi as mastodon } from '../../src/mastodon/index.js';
import {
	getMediaStorageBucketName,
	resetMediaStorageDriver,
	setMediaStorageDriver,
} from '../../src/storage/media.js';
import type { UploadProfileImageParams } from '../../src/storage/media.js';
import { addAccessToken, createLocalActor, resetFirestore } from '../helpers/index.js';
import type { LocalActor } from '../helpers/index.js';

const UID_ME = 'uid-hakatashi';

describe('update_credentials with media (Issue #220)', () => {
	let me: LocalActor;
	let uploadedFiles: Map<string, Buffer>;
	let deletedPaths: string[];

	const addToken = (token: string, scope: string, uid = UID_ME) =>
		addAccessToken(token, scope, uid);

	const createSampleJpeg = (withGps = true, width = 600, height = 300) => {
		let pipeline = sharp({
			create: {
				width,
				height,
				channels: 3,
				background: { r: 100, g: 150, b: 200 },
			},
		});
		if (withGps) {
			pipeline = pipeline.withMetadata({
				exif: {
					IFD0: { Artist: 'TestUser' },
					GPS: {
						GPSLatitudeRef: 'N',
						GPSLatitude: '35/1 41/1 22/1',
					},
				} as never,
			});
		}
		return pipeline.jpeg().toBuffer();
	};

	beforeEach(async () => {
		await resetFirestore();
		uploadedFiles = new Map();
		deletedPaths = [];

		vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(undefined as never);
		vi.spyOn(apex, 'publishUpdate').mockResolvedValue(undefined as never);

		const bucketName = getMediaStorageBucketName();
		setMediaStorageDriver({
			upload() {
				throw new Error('Not implemented');
			},
			uploadPreview() {
				throw new Error('Not implemented');
			},
			uploadProfileImage(params: UploadProfileImageParams) {
				const storagePath = `accounts/${params.type}s/${params.id}.${params.extension}`;
				uploadedFiles.set(storagePath, params.buffer);
				return Promise.resolve({
					url: `https://storage.googleapis.com/${bucketName}/${storagePath}`,
					storagePath,
				});
			},
			delete(paths: string[]) {
				deletedPaths.push(...paths);
				return Promise.resolve();
			},
		});

		me = await createLocalActor('hakatashi', { uid: UID_ME, id: '1' });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		resetMediaStorageDriver();
		await resetFirestore();
	});

	test('updates avatar, crops to 400x400, strips EXIF, and delivers Update', async () => {
		await addToken('write-token', 'write:accounts');
		const avatarBuffer = await createSampleJpeg(true, 800, 400);

		const res = await request(mastodon)
			.patch('/api/v1/accounts/update_credentials')
			.set('Authorization', 'Bearer write-token')
			.attach('avatar', avatarBuffer, 'avatar.jpg');

		expect(res.status).toBe(200);
		expect(res.body.avatar).toMatch(
			/^https:\/\/storage\.googleapis\.com\/[^/]+\/accounts\/avatars\//,
		);
		expect(res.body.avatar_static).toBe(res.body.avatar);
		expect(apex.publishUpdate).toHaveBeenCalled();

		// actor オブジェクトに icon が保存されていること
		const updatedActor = await apex.store.getObject(me.id);
		expect(updatedActor?.icon).toMatchObject({
			type: 'Image',
			mediaType: 'image/jpeg',
			url: res.body.avatar,
		});

		// アップロードされた画像の EXIF が除去され、400x400 であること
		const uploadedKey = Array.from(uploadedFiles.keys()).find((k) =>
			k.startsWith('accounts/avatars/'),
		);
		expect(uploadedKey).toBeDefined();
		const uploadedBuffer = uploadedFiles.get(uploadedKey!)!;
		const meta = await sharp(uploadedBuffer).metadata();
		expect(meta.exif).toBeUndefined();
		expect(meta.width).toBe(400);
		expect(meta.height).toBe(400);
	});

	test('updates header, resizes to <=1500x500, strips EXIF, and delivers Update', async () => {
		await addToken('write-token', 'write:accounts');
		const headerBuffer = await createSampleJpeg(true, 2000, 1000);

		const res = await request(mastodon)
			.patch('/api/v1/accounts/update_credentials')
			.set('Authorization', 'Bearer write-token')
			.attach('header', headerBuffer, 'header.jpg');

		expect(res.status).toBe(200);
		expect(res.body.header).toMatch(
			/^https:\/\/storage\.googleapis\.com\/[^/]+\/accounts\/headers\//,
		);
		expect(res.body.header_static).toBe(res.body.header);
		expect(apex.publishUpdate).toHaveBeenCalled();

		// actor オブジェクトに image が保存されていること
		const updatedActor = await apex.store.getObject(me.id);
		expect(updatedActor?.image).toMatchObject({
			type: 'Image',
			mediaType: 'image/jpeg',
			url: res.body.header,
		});

		// アップロードされた画像の EXIF が除去され、1000x500 であること
		const uploadedKey = Array.from(uploadedFiles.keys()).find((k) =>
			k.startsWith('accounts/headers/'),
		);
		expect(uploadedKey).toBeDefined();
		const uploadedBuffer = uploadedFiles.get(uploadedKey!)!;
		const meta = await sharp(uploadedBuffer).metadata();
		expect(meta.exif).toBeUndefined();
		expect(meta.width).toBe(1000);
		expect(meta.height).toBe(500);
	});

	test('deletes previous avatar when updating with a new avatar', async () => {
		await addToken('write-token', 'write:accounts');

		// 1回目のアバター更新
		const firstAvatar = await createSampleJpeg(false, 400, 400);
		const res1 = await request(mastodon)
			.patch('/api/v1/accounts/update_credentials')
			.set('Authorization', 'Bearer write-token')
			.attach('avatar', firstAvatar, 'avatar1.jpg');
		expect(res1.status).toBe(200);
		const firstPath = Array.from(uploadedFiles.keys())[0]!;

		// 2回目のアバター更新
		const secondAvatar = await createSampleJpeg(false, 400, 400);
		const res2 = await request(mastodon)
			.patch('/api/v1/accounts/update_credentials')
			.set('Authorization', 'Bearer write-token')
			.attach('avatar', secondAvatar, 'avatar2.jpg');
		expect(res2.status).toBe(200);

		// 古いファイルが削除されたこと
		expect(deletedPaths).toContain(firstPath);
	});

	test('updates avatar, header, and profile fields simultaneously via multipart/form-data', async () => {
		await addToken('write-token', 'write:accounts');
		const avatarBuffer = await createSampleJpeg(false, 400, 400);
		const headerBuffer = await createSampleJpeg(false, 1500, 500);

		const res = await request(mastodon)
			.patch('/api/v1/accounts/update_credentials')
			.set('Authorization', 'Bearer write-token')
			.field('display_name', 'New Display Name')
			.field('note', 'New Bio')
			.field('fields_attributes[0][name]', 'Website')
			.field('fields_attributes[0][value]', 'https://example.com')
			.attach('avatar', avatarBuffer, 'avatar.jpg')
			.attach('header', headerBuffer, 'header.jpg');

		expect(res.status).toBe(200);
		expect(res.body.display_name).toBe('New Display Name');
		expect(res.body.source.note).toBe('New Bio');
		expect(res.body.source.fields).toEqual([
			{ name: 'Website', value: 'https://example.com', verified_at: null },
		]);
		expect(res.body.avatar).toMatch(
			/^https:\/\/storage\.googleapis\.com\/[^/]+\/accounts\/avatars\//,
		);
		expect(res.body.header).toMatch(
			/^https:\/\/storage\.googleapis\.com\/[^/]+\/accounts\/headers\//,
		);
	});

	test('returns 422 when uploaded file is invalid or corrupted', async () => {
		await addToken('write-token', 'write:accounts');
		const invalidBuffer = Buffer.from('corrupted data');

		const res = await request(mastodon)
			.patch('/api/v1/accounts/update_credentials')
			.set('Authorization', 'Bearer write-token')
			.attach('avatar', invalidBuffer, 'avatar.jpg');

		expect(res.status).toBe(422);
	});
});
