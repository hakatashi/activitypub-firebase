import {describe, expect, test} from '@jest/globals';
import request from 'supertest';
import {activitypub} from '../../src/activitypub.js';

describe('activitypub', () => {
	test('Root path should not be implemented', async () => {
		const response = await request(activitypub).get('/');
		expect(response.status).toBe(404);
	});

	describe('/nodeinfo', () => {
		test('/nodeinfo/2.0', async () => {
			const response = await request(activitypub).get('/nodeinfo/2.0');
			expect(response.status).toBe(200);
			expect(response.body.version).toBe('2.0');
			expect(response.body.usage.users.total).toBe(0);
			expect(response.body.software.name).toBe('activitypub-firebase');
			expect(response.body.software.version).toBe('1.0.0');
		});

		test('/nodeinfo/2.1', async () => {
			const response = await request(activitypub).get('/nodeinfo/2.1');
			expect(response.status).toBe(200);
			expect(response.body.version).toBe('2.1');
			expect(response.body.usage.users.total).toBe(0);
			expect(response.body.software.name).toBe('activitypub-firebase');
			expect(response.body.software.version).toBe('1.0.0');
		});
	});
});
