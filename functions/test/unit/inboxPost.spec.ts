import { describe, expect, test } from 'vitest';
import { apex } from '../../src/apex.js';
import { inboxExecutionMiddlewares, inboxValidationMiddlewares } from '../../src/inboxPost.js';

describe('inboxPost', () => {
	test('inboxValidationMiddlewares contains middlewares up to validators.inboxActivity', () => {
		expect(inboxValidationMiddlewares[0]).toBe(apex.net.validators.jsonld);
		expect(inboxValidationMiddlewares.at(-1)).toBe(apex.net.validators.inboxActivity);
	});

	test('inboxExecutionMiddlewares contains middlewares after activity.save', () => {
		expect(inboxExecutionMiddlewares[0]).toBe(apex.net.activity.resolveThread);
		expect(inboxExecutionMiddlewares.at(-1)).toBe(apex.net.responders.status);
	});
});
