import express from 'express';
import request from 'supertest';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {apex, app} from '../../src/activitypub.js';
import {runPostWorkBeforeSend} from '../../src/postWork.js';

describe('apex-inbox event: Follow auto-accept', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test('accepts an incoming Follow and publishes the updated followers collection', async () => {
		const recipient = {id: 'https://example.com/activitypub/u/hakatashi', followers: ['https://example.com/activitypub/u/hakatashi/followers']};
		const actor = {id: 'https://remote.example/u/alice'};
		const activity = {
			id: 'https://remote.example/activities/follow-1',
			type: 'Follow',
			actor: actor.id,
			object: recipient.id,
			_meta: {collection: ['https://example.com/activitypub/u/hakatashi/inbox']},
		};
		const acceptActivity = {id: 'https://example.com/activitypub/s/accept-1', type: 'Accept'};
		const postTask = vi.fn().mockResolvedValue(undefined);

		const buildActivitySpy = vi.spyOn(apex, 'buildActivity').mockResolvedValue(acceptActivity);
		const acceptFollowSpy = vi.spyOn(apex, 'acceptFollow').mockResolvedValue({postTask, updated: true});
		const addToOutboxSpy = vi.spyOn(apex, 'addToOutbox').mockResolvedValue(undefined);

		const listeners = app.listeners('apex-inbox') as ((message: any) => Promise<void>)[];
		expect(listeners).toHaveLength(1);

		await listeners[0]({activity, actor, recipient});

		expect(buildActivitySpy).toHaveBeenCalledWith(
			'Accept',
			recipient.id,
			actor.id,
			{object: {id: activity.id, type: 'Follow', actor: actor.id, object: recipient.id}},
		);
		expect(acceptFollowSpy).toHaveBeenCalledWith(recipient, activity);
		expect(addToOutboxSpy).toHaveBeenCalledWith(recipient, acceptActivity);
		expect(postTask).toHaveBeenCalledTimes(1);
	});

	test('does not treat non-Follow activities as follow requests', async () => {
		const buildActivitySpy = vi.spyOn(apex, 'buildActivity').mockResolvedValue({});
		const acceptFollowSpy = vi.spyOn(apex, 'acceptFollow').mockResolvedValue({postTask: vi.fn(), updated: true});
		const addToOutboxSpy = vi.spyOn(apex, 'addToOutbox').mockResolvedValue(undefined);

		const listeners = app.listeners('apex-inbox') as ((message: any) => Promise<void>)[];

		await listeners[0]({
			activity: {id: 'https://remote.example/activities/create-1', type: 'Create'},
			actor: {id: 'https://remote.example/u/alice'},
			recipient: {id: 'https://example.com/activitypub/u/hakatashi'},
			object: {type: 'Note'},
		});

		expect(buildActivitySpy).not.toHaveBeenCalled();
		expect(acceptFollowSpy).not.toHaveBeenCalled();
		expect(addToOutboxSpy).not.toHaveBeenCalled();
	});
});

// ADR-0013: postWork の実行はグローバルなプロトタイプ書き換えではなく、
// リクエストごとに res.send を差し替えるミドルウェアで行う。
describe('runPostWorkBeforeSend middleware (apex postWork / event dispatch)', () => {
	test('runs apex postWork tasks in order before the body is actually sent', async () => {
		const order: string[] = [];
		const testApp = express();
		testApp.use(runPostWorkBeforeSend);
		testApp.get('/test', (req, res) => {
			res.locals.apex = {
				postWork: [
					() => {
						order.push('task1');
					},
					async () => {
						await new Promise((resolve) => {
							setTimeout(resolve, 10);
						});
						order.push('task2');
					},
				],
			};
			res.status(200).send('ok');
		});

		const response = await request(testApp).get('/test');

		expect(response.status).toBe(200);
		expect(response.text).toBe('ok');
		expect(order).toEqual(['task1', 'task2']);
	});

	test('dispatches apexLocal.eventMessage to listeners of apexLocal.eventName on the owning app', async () => {
		const testApp = express();
		const received: any[] = [];
		testApp.use(runPostWorkBeforeSend);
		testApp.on('custom-apex-event', (message: any) => {
			received.push(message);
		});
		testApp.get('/test', (req, res) => {
			res.locals.apex = {
				postWork: [],
				eventName: 'custom-apex-event',
				eventMessage: {foo: 'bar'},
			};
			res.send('done');
		});

		const response = await request(testApp).get('/test');

		expect(response.status).toBe(200);
		expect(received).toEqual([{foo: 'bar'}]);
	});

	test('drains postWork and eventName so that apex onFinished does not run them twice', async () => {
		const task = vi.fn();
		const testApp = express();
		const received: any[] = [];
		let apexLocal: any;
		testApp.use(runPostWorkBeforeSend);
		testApp.on('custom-apex-event', (message: any) => {
			received.push(message);
		});
		testApp.get('/test', (req, res) => {
			apexLocal = {
				postWork: [task],
				eventName: 'custom-apex-event',
				eventMessage: {foo: 'bar'},
			};
			res.locals.apex = apexLocal;
			res.send('done');
		});

		await request(testApp).get('/test');

		expect(task).toHaveBeenCalledTimes(1);
		expect(received).toHaveLength(1);
		expect(apexLocal.postWork).toEqual([]);
		expect(apexLocal.eventName).toBeNull();
	});

	test('still sends the response even if a postWork task throws', async () => {
		const testApp = express();
		testApp.use(runPostWorkBeforeSend);
		testApp.get('/test', (req, res) => {
			res.locals.apex = {
				postWork: [
					() => {
						throw new Error('boom');
					},
				],
			};
			res.status(200).send('ok despite error');
		});

		const response = await request(testApp).get('/test');

		expect(response.status).toBe(200);
		expect(response.text).toBe('ok despite error');
	});

	test('sends normally when res.locals.apex is not set', async () => {
		const testApp = express();
		testApp.use(runPostWorkBeforeSend);
		testApp.get('/test', (req, res) => {
			res.status(200).send('plain');
		});

		const response = await request(testApp).get('/test');

		expect(response.status).toBe(200);
		expect(response.text).toBe('plain');
	});

	test('does not affect apps without the middleware (no global monkey patch)', async () => {
		const task = vi.fn();
		const testApp = express();
		testApp.get('/test', (req, res) => {
			res.locals.apex = {postWork: [task], eventName: null};
			res.status(200).send('untouched');
		});

		const response = await request(testApp).get('/test');

		expect(response.status).toBe(200);
		expect(response.text).toBe('untouched');
		expect(task).not.toHaveBeenCalled();
	});
});
