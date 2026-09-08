import { describe, expect, test, vi } from 'vitest';
import ActivitypubExpress from '../../../src/apex/index.js';
import type IApexStore from '../../../src/apex/store/interface.js';

describe('apex JSON-LD public address normalization (ADR-0045)', () => {
	const mockStore = {
		generateId: () => 'generated-id-123',
	} as unknown as IApexStore;

	const apex = ActivitypubExpress({
		name: 'test-apex',
		version: '1.0.0',
		domain: 'example.com',
		actorParam: 'actor',
		objectParam: 'id',
		activityParam: 'id',
		routes: {
			actor: '/u/:actor',
			object: '/o/:id',
			activity: '/s/:id',
			inbox: '/u/:actor/inbox',
			outbox: '/u/:actor/outbox',
			followers: '/u/:actor/followers',
			following: '/u/:actor/following',
			liked: '/u/:actor/liked',
			collections: '/u/:actor/c/:id',
			blocked: '/u/:actor/blocked',
			rejections: '/u/:actor/rejections',
			rejected: '/u/:actor/rejected',
			shares: '/s/:id/shares',
			likes: '/s/:id/likes',
		},
		logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
		store: mockStore,
		offlineMode: false,
	});

	describe('fromJSONLD addressing normalization', () => {
		test.each([
			['bare Public', 'Public'],
			['full URI', 'https://www.w3.org/ns/activitystreams#Public'],
			['compact as:Public', 'as:Public'],
		])('normalizes %s in "to" array to "as:Public"', async (_label, publicTarget) => {
			const processed = await apex.fromJSONLD({
				'@context': 'https://www.w3.org/ns/activitystreams',
				type: 'Create',
				to: [publicTarget],
				cc: ['https://example.com/followers'],
			});

			expect(processed.to).toEqual(['as:Public']);
			expect(processed.cc).toEqual(['https://example.com/followers']);
			expect(apex.isPublic(processed)).toBe(true);
		});

		test.each([
			['bare Public', 'Public'],
			['full URI', 'https://www.w3.org/ns/activitystreams#Public'],
			['compact as:Public', 'as:Public'],
		])('normalizes %s in "to" single string to "as:Public"', async (_label, publicTarget) => {
			const processed = await apex.fromJSONLD({
				'@context': 'https://www.w3.org/ns/activitystreams',
				type: 'Create',
				to: publicTarget,
			});

			expect(processed.to).toEqual(['as:Public']);
			expect(apex.isPublic(processed)).toBe(true);
		});

		test('normalizes all audience fields: to, cc, bto, bcc, audience', async () => {
			const processed = await apex.fromJSONLD({
				'@context': 'https://www.w3.org/ns/activitystreams',
				type: 'Create',
				to: ['Public'],
				cc: ['https://www.w3.org/ns/activitystreams#Public'],
				bto: ['Public'],
				bcc: ['https://www.w3.org/ns/activitystreams#Public'],
				audience: ['Public'],
			});

			expect(processed.to).toEqual(['as:Public']);
			expect(processed.cc).toEqual(['as:Public']);
			expect(processed.bto).toEqual(['as:Public']);
			expect(processed.bcc).toEqual(['as:Public']);
			expect(processed.audience).toEqual(['as:Public']);
		});

		test('normalizes nested object addressing', async () => {
			const processed = await apex.fromJSONLD({
				'@context': 'https://www.w3.org/ns/activitystreams',
				type: 'Create',
				to: ['Public'],
				object: {
					type: 'Note',
					to: ['https://www.w3.org/ns/activitystreams#Public'],
					cc: ['Public', 'https://example.com/followers'],
				},
			});

			expect(processed.to).toEqual(['as:Public']);
			const obj = (processed.object as Record<string, unknown>[])[0];
			expect(obj.to).toEqual(['as:Public']);
			expect(obj.cc).toEqual(['as:Public', 'https://example.com/followers']);
			expect(apex.isPublic(obj)).toBe(true);
		});

		test('normalizes array of nested objects', async () => {
			const processed = await apex.fromJSONLD({
				'@context': 'https://www.w3.org/ns/activitystreams',
				type: 'Create',
				object: [
					{
						type: 'Note',
						to: 'Public',
					},
					{
						type: 'Note',
						audience: ['Public'],
					},
				],
			});

			const objects = processed.object as Record<string, unknown>[];
			expect(objects[0].to).toEqual(['as:Public']);
			expect(objects[1].audience).toEqual(['as:Public']);
			expect(apex.isPublic(objects[0])).toBe(true);
			expect(apex.isPublic(objects[1])).toBe(true);
		});
	});

	describe('normalizePublicAddresses standalone function', () => {
		test('handles null, undefined, and primitives safely', () => {
			expect(apex.normalizePublicAddresses(null)).toBeNull();
			expect(apex.normalizePublicAddresses(undefined)).toBeUndefined();
			expect(apex.normalizePublicAddresses('string')).toBe('string');
			expect(apex.normalizePublicAddresses(123)).toBe(123);
		});
	});
});
