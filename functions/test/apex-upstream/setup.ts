import express from 'express';
import nock from 'nock';
import fetch from 'node-fetch';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import firebase from 'firebase-admin';
import ActivitypubExpress from '../../src/apex/index.js';
import { computeHttpSignatureHeaders } from '../../src/apex/pub/federation.js';
import { escapeFirestoreKey } from '../../src/firebase.js';
import Store from '../../src/store.js';
import { resetFirestore } from '../helpers/index.js';

// MongoDB native driver compatibility for upstream specs
(firebase.firestore.CollectionReference.prototype as any).findOne = async function (query?: any) {
	if (query?.id) {
		const doc = await this.doc(escapeFirestoreKey(query.id)).get();
		if (!doc.exists) return null;
		return { ...doc.data(), _id: doc.id };
	}
	const snap = await this.get();
	for (const doc of snap.docs) {
		const data = doc.data();
		let match = true;
		if (query && typeof query === 'object') {
			for (const [k, v] of Object.entries(query)) {
				if (k.startsWith('$')) continue;
				const actual = data[k];
				if (Array.isArray(actual)) {
					if (Array.isArray(v)) {
						if (JSON.stringify(actual) !== JSON.stringify(v)) match = false;
					} else if (!actual.includes(v)) {
						match = false;
					}
				} else if (actual !== v) {
					match = false;
				}
			}
		}
		if (match) {
			return { ...data, _id: doc.id };
		}
	}
	return null;
};

(firebase.firestore.CollectionReference.prototype as any).insertOne = async function (doc: any) {
	const ref = doc.id ? this.doc(escapeFirestoreKey(doc.id)) : this.doc();
	await ref.set(doc);
	return { insertedId: ref.id };
};

(firebase.firestore.CollectionReference.prototype as any).insertMany = async function (docs: any[]) {
	const batch = this.firestore.batch();
	for (const doc of docs) {
		const ref = doc.id ? this.doc(escapeFirestoreKey(doc.id)) : this.doc();
		batch.set(ref, doc);
	}
	await batch.commit();
};

(firebase.firestore.CollectionReference.prototype as any).find = function (query?: any) {
	const col = this;
	return {
		toArray: async () => {
			const snap = await col.get();
			const results: any[] = [];
			for (const doc of snap.docs) {
				const data = doc.data();
				let match = true;
				if (query && typeof query === 'object') {
					for (const [k, v] of Object.entries(query)) {
						if (k.startsWith('$')) continue;
						const parts = k.split('.');
						let actual = data;
						for (const part of parts) {
							if (actual == null) break;
							actual = actual[part];
						}
						if (Array.isArray(actual)) {
							if (!actual.includes(v)) match = false;
						} else if (actual !== v) {
							match = false;
						}
					}
				}
				if (match) results.push({ ...data, _id: doc.id });
			}
			return results;
		},
	};
};

expect.extend({
	toBeTrue(received) {
		const pass = received === true;
		return {
			pass,
			message: () => `expected ${String(received)} to be true`,
		};
	},
	toBeFalse(received) {
		const pass = received === false;
		return {
			pass,
			message: () => `expected ${String(received)} to be false`,
		};
	},
});

// Jasmine-compatible spy wrapper over vi.spyOn
export function spyOn(obj: any, method: string) {
	const spy = vi.spyOn(obj, method as any);
	const and = {
		returnValue: (val: any) => {
			spy.mockReturnValue(val);
			return spy;
		},
		returnValues: (...vals: any[]) => {
			for (const val of vals) {
				spy.mockReturnValueOnce(val);
			}
			return spy;
		},
		resolveTo: (val: any) => {
			spy.mockResolvedValue(val);
			return spy;
		},
		rejectWith: (err: any) => {
			spy.mockRejectedValue(err);
			return spy;
		},
		callFake: (fn: any) => {
			spy.mockImplementation(fn);
			return spy;
		},
		callThrough: () => {
			return spy;
		},
	};
	(spy as any).and = and;
	(spy as any).calls = {
		argsFor: (index: number) => spy.mock.calls[index] ?? [],
		count: () => spy.mock.calls.length,
		allArgs: () => spy.mock.calls,
		reset: () => spy.mockClear(),
	};
	return spy;
}

export const jasmine = {
	DEFAULT_TIMEOUT_INTERVAL: 10000,
	clock: () => ({
		install: () => ({
			mockDate: (d: Date) => {
				vi.useFakeTimers();
				vi.setSystemTime(d);
			},
		}),
		uninstall: () => {
			vi.useRealTimers();
		},
	}),
};

function wrapTestFn(fn: any) {
	if (typeof fn !== 'function') return fn;
	if (fn.length === 0) return fn;
	return function (this: any) {
		return new Promise((resolve, reject) => {
			const done = (err?: any) => {
				if (err) reject(err);
				else resolve(undefined);
			};
			done.fail = (err: any) => reject(err);
			try {
				const res = fn.call(this, done);
				if (res && typeof res.then === 'function') {
					res.then(resolve, reject);
				}
			} catch (err) {
				reject(err);
			}
		});
	};
}

function wrapIt(origIt: any) {
	const wrapped: any = function (name: string, fn: any, timeout?: number) {
		return origIt(name, wrapTestFn(fn), timeout);
	};
	Object.setPrototypeOf(wrapped, origIt);
	for (const key of Object.getOwnPropertyNames(origIt)) {
		try {
			const val = origIt[key];
			if (typeof val === 'function') {
				wrapped[key] = function (name: string, fn: any, timeout?: number) {
					return val(name, wrapTestFn(fn), timeout);
				};
				Object.setPrototypeOf(wrapped[key], val);
			} else {
				wrapped[key] = val;
			}
		} catch {
			// ignore non-configurable properties
		}
	}
	return wrapped;
}

if ((globalThis as any).it) {
	(globalThis as any).it = wrapIt((globalThis as any).it);
}
if ((globalThis as any).test) {
	(globalThis as any).test = wrapIt((globalThis as any).test);
}


export async function initApex() {
	const routes = {
		actor: '/u/:actor',
		object: '/o/:id',
		activity: '/s/:id',
		inbox: '/inbox/:actor',
		outbox: '/outbox/:actor',
		followers: '/followers/:actor',
		following: '/following/:actor',
		liked: '/liked/:actor',
		shares: '/s/:id/shares',
		likes: '/s/:id/likes',
		collections: '/u/:actor/c/:id',
		blocked: '/u/:actor/blocked',
		rejections: '/u/:actor/rejections',
		rejected: '/u/:actor/rejected',
		nodeinfo: '/nodeinfo',
	};
	process.env.npm_package_version ??= '1.0.0';
	const app = express();
	app.set('env', 'development');
	const apex = ActivitypubExpress({
		name: 'Apex Test Suite',
		version: process.env.npm_package_version,
		openRegistrations: false,
		nodeInfoMetadata: { foo: 'bar' },
		domain: 'localhost',
		actorParam: 'actor',
		objectParam: 'id',
		activityParam: 'id',
		routes,
		store: new Store(),
		offlineMode: true,
		remoteFetchPolicy: () => ({
			allowedProtocols: ['https:', 'http:'],
			allowedRanges: ['unicast', 'loopback'],
		}),
		endpoints: {
			uploadMedia: 'https://localhost/upload',
			oauthAuthorizationEndpoint: 'https://localhost/auth/authorize',
			proxyUrl: 'https://localhost/proxy',
		},
	});

	// 上流テストでは Cloud Tasks への配送キューイングを行わないためスタブ化する (ADR-0003, ADR-0052)
	apex.store.deliveryEnqueue = async () => true;

	app.use(
		express.json({
			type: apex.consts.jsonldTypes,
			verify: (req, _res, buf) => {
				(req as { rawBody?: Buffer }).rawBody = buf;
			},
		}),
		express.urlencoded({ extended: true }),
		apex,
	);
	app.use((err: any, _req: any, _res: any, next: any) => {
		next(err);
	});

	// nock でインターセプトできるように node-fetch (http/https モジュール経由) を使う
	apex.requestObject = async function (id: string) {
		try {
			const headers: Record<string, string> = {
				Accept: 'application/activity+json',
				'User-Agent': this.makeUserAgentString(),
			};
			const privateKey = this.systemUser?._meta?.privateKey;
			if (this.systemUser && privateKey) {
				const { date, signature } = computeHttpSignatureHeaders({
					method: 'get',
					url: new URL(id),
					keyId: `${this.systemUser.id}#main-key`,
					privateKeyPem: privateKey,
				});
				headers.Date = date;
				headers.Signature = signature;
			}
			const res = await fetch(id, { headers });
			if (!res.ok) {
				return undefined;
			}
			const json = await res.json();
			return await this.fromJSONLD(json);
		} catch {
			return undefined;
		}
	};

	apex.deliver = async function (_actorId: string, activity: string, address: string) {
		try {
			const res = await fetch(address, {
				method: 'POST',
				headers: {
					'Content-Type': this.consts.jsonldOutgoingType,
					'User-Agent': this.makeUserAgentString(),
				},
				body: activity,
			});
			const body = await res.text();
			const headers: Record<string, string> = {};
			res.headers.forEach((v: string, k: string) => {
				headers[k] = v;
			});
			return {
				statusCode: res.status,
				headers,
				body,
			};
		} catch (err: any) {
			throw err;
		}
	};

	const originalJsonldContextLoader = apex.jsonldContextLoader.bind(apex);
	apex.jsonldContextLoader = async function (url: string) {
		if (
			url === 'https://w3id.org/security/v1' ||
			url === 'https://www.w3.org/ns/activitystreams'
		) {
			return originalJsonldContextLoader(url);
		}
		const cached = await apex.store.getContext(url);
		if (cached) {
			return cached as any;
		}
		const res = await fetch(url, {
			headers: { Accept: 'application/ld+json, application/json' },
		});
		if (!res.ok) {
			throw new Error(`Failed to fetch context: ${res.status}`);
		}
		const document = await res.json();
		const context = {
			contextUrl: null,
			documentUrl: url,
			document,
		};
		await apex.store.saveContext(context);
		return context as any;
	};

	const client = {};
	const testUser = await apex.createActor('test', 'test', 'test user');

	return { app, apex, client, testUser, routes };
}

export async function resetDb(apex: any, _client: any, testUser: any) {
	await resetFirestore();
	delete testUser._local;
	await apex.store.setup(testUser);
	testUser._local = { blockList: [] };
}

function skipTransient(key: string, value: any) {
	if (['_id', 'id', 'published', 'first'].includes(key)) {
		return undefined;
	}
	return value;
}

export function stripIds(obj: any) {
	return JSON.parse(JSON.stringify(obj, skipTransient));
}

export async function toExternalJSONLD(apex: any, value: any, noContext?: boolean) {
	value = JSON.parse(apex.stringifyPublicJSONLD(await apex.toJSONLD(value)));
	if (noContext) {
		delete value['@context'];
	}
	return value;
}

export function failOrDone(err: any, done: any) {
	if (err) {
		if (typeof done?.fail === 'function') {
			done.fail(err);
		} else {
			done(err);
		}
	} else {
		done();
	}
}

export function failIfError(err: any, done: any) {
	if (err) {
		if (typeof done?.fail === 'function') {
			done.fail(err);
		} else {
			done(err);
		}
	}
}

// Assign to global
(globalThis as any).initApex = initApex;
(globalThis as any).resetDb = resetDb;
(globalThis as any).stripIds = stripIds;
(globalThis as any).toExternalJSONLD = toExternalJSONLD;
(globalThis as any).failOrDone = failOrDone;
(globalThis as any).failIfError = failIfError;
(globalThis as any).spyOn = spyOn;
(globalThis as any).jasmine = jasmine;

// Allow net connect to localhost / 127.0.0.1 for firestore emulator and supertest
nock.enableNetConnect(/(localhost|127\.0\.0\.1)/);

// Setup default nocks matching upstream helpers/nocks.js
beforeEach(() => {
	nock.enableNetConnect(/(localhost|127\.0\.0\.1)/);
	nock('https://ignore.com')
		.get((uri) => uri.startsWith('/s/'))
		.reply(200, (uri) => ({
			id: `https://ignore.com${uri}`,
			type: 'Activity',
			actor: 'https://ignore.com/u/bob',
		}))
		.persist()
		.get((uri) => !uri.startsWith('/s/'))
		.reply(200, (uri) => ({ id: `https://ignore.com${uri}`, type: 'Object' }))
		.persist()
		.post(() => true)
		.reply(200)
		.persist();
});

afterEach(() => {
	nock.cleanAll();
	vi.restoreAllMocks();
});

