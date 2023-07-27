import {describe, expect, test, afterEach, jest, beforeEach} from '@jest/globals';
import request from 'supertest';
import {mastodonApi as mastodon} from '../../src/mastodon/index.js';

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT;

describe('mastodon', () => {
	jest.setTimeout(10000);

	beforeEach(() => {
		if (firestoreHost === undefined || projectId === undefined) {
			throw new Error('Firestore emulator is not running');
		}
	});

	// Teardown firestore database after each test
	afterEach(async () => {
		await fetch(
			`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
			{
				method: 'DELETE',
			},
		);
	});

	test('Root path should not be implemented', async () => {
		const response = await request(mastodon).get('/');
		expect(response.status).toBe(404);
	});

	describe('/api', () => {
		describe('/api/v1/instance', () => {
			test('Returns instance information', async () => {
				const response = await request(mastodon).get('/api/v1/instance');
				expect(response.status).toBe(200);
				expect(response.body.uri).toBe('hakatashi.com');
				expect(response.body.title).toBe('HakataFediverse');
			});
		});

		describe('/api/v2/instance', () => {
			test('Returns instance information', async () => {
				const response = await request(mastodon).get('/api/v2/instance');
				expect(response.status).toBe(200);
				expect(response.body.domain).toBe('hakatashi.com');
				expect(response.body.title).toBe('HakataFediverse');
			});
		});
	});
});
