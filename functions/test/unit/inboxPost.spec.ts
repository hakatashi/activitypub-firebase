import { describe, expect, test } from 'vitest';
import { apex } from '../../src/apex.js';
import { correctIsNewActivity, markRedundantInboxDelivery } from '../../src/inboxDedup.js';
import { verifySameOriginForUpdateDelete } from '../../src/inboxOriginCheck.js';
import {
	buildInboxPostMiddlewares,
	inboxExecutionMiddlewares,
	inboxValidationMiddlewares,
} from '../../src/inboxPost.js';
import { denormalizeUndoObject } from '../../src/inboxUndo.js';

describe('inboxPost', () => {
	test('inboxValidationMiddlewares contains middlewares up to validators.inboxActivity', () => {
		expect(inboxValidationMiddlewares[0]).toBe(apex.net.validators.jsonld);
		expect(inboxValidationMiddlewares.at(-1)).toBe(apex.net.validators.inboxActivity);
	});

	test('inboxExecutionMiddlewares contains middlewares after activity.save', () => {
		expect(inboxExecutionMiddlewares[0]).toBe(apex.net.activity.resolveThread);
		expect(inboxExecutionMiddlewares.at(-1)).toBe(apex.net.responders.status);
	});

	test('buildInboxPostMiddlewares arranges all middlewares in the correct order', () => {
		const middlewares = buildInboxPostMiddlewares();

		const inboxActivityIdx = middlewares.indexOf(apex.net.validators.inboxActivity);
		const sameOriginIdx = middlewares.indexOf(verifySameOriginForUpdateDelete);
		const dedupMarkIdx = middlewares.indexOf(markRedundantInboxDelivery);
		const undoDenormalizeIdx = middlewares.indexOf(denormalizeUndoObject);
		const saveIdx = middlewares.indexOf(apex.net.activity.save);
		const dedupCorrectIdx = middlewares.indexOf(correctIsNewActivity);
		const resolveThreadIdx = middlewares.indexOf(apex.net.activity.resolveThread);

		expect(inboxActivityIdx).toBeGreaterThan(-1);
		expect(sameOriginIdx).toBe(inboxActivityIdx + 1);
		expect(dedupMarkIdx).toBe(sameOriginIdx + 1);
		expect(undoDenormalizeIdx).toBe(dedupMarkIdx + 1);
		expect(saveIdx).toBe(undoDenormalizeIdx + 1);
		expect(dedupCorrectIdx).toBe(saveIdx + 1);
		expect(resolveThreadIdx).toBe(dedupCorrectIdx + 1);
	});
});
