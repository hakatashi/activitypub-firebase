// Mastodon API の主なエンドポイントの Firestore 読み取り回数を数え、月額を見積もる。
// `npm --prefix functions run measure:reads` で実行する。手順と見積もりの前提は
// docs/runbooks/measure-firestore-reads.md にある。
import { writeFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import type { APObject } from '../../src/apex/index.js';
import { apex } from '../../src/apex.js';
import { db } from '../../src/firebase.js';
import { clearTimelineHeadCache } from '../../src/mastodon/presenters/timelineHeadCache.js';
import { clearMastodonIdCache } from '../../src/mastodonId.js';
import { rebuildTimelineFeeds } from '../../src/projections/timelineFeeds.js';
import { addListAccounts, createList } from '../../src/social/lists.js';
import {
	addAccessToken,
	createLocalActor,
	enableTimelineFeeds,
	mastodon as mastodonReq,
} from '../helpers/index.js';

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

// データの規模 (PR #346 の計測と同じ)。
const FOLLOWS = 280;
const NOTES_PER_ACTOR = 10;
const ANNOUNCES_PER_ACTOR = 3;
const LIST_MEMBERS = 30;
const MY_NOTES = 20;
const LIKES = 120;

// 月額の見積もりの前提 (PR #346 と同じ)。Phanpy の自動更新で通知・ホーム・リストを 24 時間表示する。
const SECONDS_PER_MONTH = 30 * 24 * 60 * 60;
const TIMELINE_REQUESTS_PER_MONTH = SECONDS_PER_MONTH / 15;
const NOTIFICATION_POLLS_PER_MONTH = SECONDS_PER_MONTH / 20;
const NOTIFICATION_RELOADS_PER_MONTH = 30 * 30;
// タイムラインの先頭ページのキャッシュ (ADR-0139) は 5 分で組み立て直すので、15 秒ごとのリクエストの
// 20 回に 1 回が組み立て直し、残りがキャッシュの検証だけになる。
const TIMELINE_REQUESTS_PER_REBUILD = (5 * 60) / 15;
// 東京リージョンの読み取りの単価 (USD / 1 回) と、無料枠 (1 日 5 万回)。
const READ_PRICE = 0.038 / 100_000;
const FREE_READS_PER_MONTH = 50_000 * 30;

// 読み取りの課金規則に合わせて数える。`getAll` (`DocumentReference#get` もこれを通る) は
// 引いたドキュメント数、クエリは返った件数 (0 件でも 1 回)。トランザクション内の読み取りは数えない。
// firebase-admin は自前の @google-cloud/firestore を同梱しているので、実インスタンスのプロトタイプを差し替える。
let counts: Map<string, number> | undefined;
const count = (collection: string, n: number) => {
	counts?.set(collection, (counts.get(collection) ?? 0) + n);
};
const firestoreProto = Object.getPrototypeOf(db) as { getAll: (...args: unknown[]) => unknown };
const queryProto = Object.getPrototypeOf(Object.getPrototypeOf(db.collection('_'))) as {
	get: () => Promise<{ size: number }>;
};
const originalGetAll = firestoreProto.getAll;
firestoreProto.getAll = function (this: unknown, ...args: unknown[]) {
	for (const arg of args) {
		const parentId = (arg as { parent?: { id?: string } } | undefined)?.parent?.id;
		if (parentId !== undefined) {
			count(parentId, 1);
		}
	}
	return originalGetAll.apply(this, args);
};
const originalQueryGet = queryProto.get;
queryProto.get = async function (this: unknown) {
	const snapshot = await originalQueryGet.call(this);
	// クエリの対象のコレクション名は公開 API から取れない。
	// oxlint-disable-next-line no-underscore-dangle
	const { collectionId } = (this as { _queryOptions: { collectionId: string } })._queryOptions;
	count(collectionId, Math.max(1, snapshot.size));
	return snapshot;
};

// エミュレータはトランザクションのロックが悲観的で、並列に保存するとロックのタイムアウトが多発する。
// 逐次に保存し、まれな ABORTED だけ再試行する。
const sequentially = async <T>(label: string, items: T[], fn: (item: T) => Promise<unknown>) => {
	for (const item of items) {
		for (let attempt = 0; ; attempt++) {
			try {
				await fn(item);
				break;
			} catch (error) {
				if (attempt >= 8 || !String(error).includes('ABORTED')) {
					throw error;
				}
			}
		}
	}
	process.stderr.write(`[measure] ${label}: ${items.length}\n`);
};

interface Measurement {
	total: number;
	items: number;
	breakdown: Record<string, number>;
}

describe('Firestore reads per request', () => {
	test('PR #346 scenario', { timeout: 3_600_000 }, async () => {
		vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(true);
		const me = await createLocalActor('hakatashi', { uid: 'uid-me', id: '1' });
		await addAccessToken('me-token', 'read write', 'uid-me');

		const remotes = Array.from(
			{ length: FOLLOWS },
			(_, i) => `https://r${i % 40}.example/u/user${i}`,
		);
		await sequentially('actors', remotes, (id) =>
			apex.store.saveObject({
				id,
				type: 'Person',
				preferredUsername: id.split('/').at(-1),
				inbox: `${id}/inbox`,
				outbox: `${id}/outbox`,
			} as unknown as APObject),
		);

		// Note (うち 2 割はほかの人の Note へのリプライ) と Announce。フォローより先に保存し、
		// 射影はあとで `rebuildTimelineFeeds` でまとめて作る。
		const base = Date.UTC(2026, 8, 1);
		const notes = Array.from({ length: FOLLOWS * NOTES_PER_ACTOR }, (_, index) => {
			const actor = remotes[index % FOLLOWS]!;
			return { index, actor, id: `${actor}/notes/${Math.floor(index / FOLLOWS)}` };
		});
		await sequentially('notes', notes, ({ index, actor, id }) => {
			const inReplyTo = index % 5 === 4 ? notes[index - 3]?.id : undefined;
			return apex.store.saveObject({
				id,
				type: 'Note',
				attributedTo: actor,
				content: `<p>${id}</p>`,
				published: new Date(base + index * 60_000).toISOString(),
				to: [PUBLIC],
				cc: [`${actor}/followers`],
				...(inReplyTo === undefined ? {} : { inReplyTo }),
			} as unknown as APObject);
		});
		const announces = Array.from({ length: FOLLOWS * ANNOUNCES_PER_ACTOR }, (_, index) => {
			const actor = remotes[index % FOLLOWS]!;
			return {
				index,
				actor,
				id: `${actor}/announces/${Math.floor(index / FOLLOWS)}`,
				object: notes[(index * 7 + 13) % notes.length]!.id,
			};
		});
		await sequentially('announces', announces, ({ index, actor, id, object }) =>
			apex.store.saveActivity({
				id,
				type: 'Announce',
				actor,
				object,
				published: new Date(base + index * 200_000 + 30_000).toISOString(),
				to: [PUBLIC],
				cc: [`${actor}/followers`],
			} as unknown as APObject),
		);

		await sequentially('follows', remotes, async (target) => {
			const activity = {
				id: `${me.id}/follows/${encodeURIComponent(target)}`,
				type: 'Follow',
				actor: me.id,
				object: target,
			} as APObject;
			await apex.store.saveActivity(activity);
			await apex.store.updateActivityMeta(activity, 'collection', `${me.id}/following`, false);
		});
		const list = await createList(me.id, { title: 'TSG', repliesPolicy: 'list', exclusive: false });
		expect(list).toBeDefined();
		expect(await addListAccounts(me, list!.id, remotes.slice(0, LIST_MEMBERS))).toEqual({
			ok: true,
		});

		// 通知: 自分の Note へのリモートからのお気に入り。
		const myNotes = Array.from({ length: MY_NOTES }, (_, i) => `${me.id}/notes/${i}`);
		await sequentially('my notes', myNotes, (id) =>
			apex.store.saveObject({
				id,
				type: 'Note',
				attributedTo: me.id,
				content: `<p>${id}</p>`,
				published: new Date(base + myNotes.indexOf(id) * 1000).toISOString(),
				to: [PUBLIC],
				cc: [`${me.id}/followers`],
			} as unknown as APObject),
		);
		const likes = Array.from({ length: LIKES }, (_, i) => i);
		await sequentially('likes', likes, (i) =>
			apex.store.saveActivity({
				id: `${remotes[i % FOLLOWS]}/likes/${i}`,
				type: 'Like',
				actor: remotes[i % FOLLOWS],
				object: myNotes[i % MY_NOTES],
				published: new Date(base + 10_000_000 + i * 1000).toISOString(),
			} as unknown as APObject),
		);

		await rebuildTimelineFeeds();
		await enableTimelineFeeds(me.id);

		const results: Record<string, Measurement> = {};
		const measure = async (label: string, path: string) => {
			counts = new Map();
			const res = await mastodonReq.get(path, 'me-token');
			const breakdown = Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]));
			counts = undefined;
			expect(res.status).toBe(200);
			results[label] = {
				total: Object.values(breakdown).reduce((sum, n) => sum + n, 0),
				items: (res.body as unknown[]).length,
				breakdown,
			};
			return res.body as { id: string }[];
		};

		// 1 回目はインスタンス内のキャッシュ (ADR-0135、ADR-0138、ADR-0139) が空の状態、2 回目は効いた状態。
		// タイムラインは、先頭ページのキャッシュ (ADR-0139) だけを捨てて組み立て直す回 (rebuild) も測る。
		const timelinePaths = {
			home: '/api/v1/timelines/home?limit=20',
			list: `/api/v1/timelines/list/${list!.id}?limit=20`,
		};
		for (const [label, path] of [
			...Object.entries(timelinePaths),
			['notifications', '/api/v1/notifications?limit=80'],
		] as const) {
			clearMastodonIdCache();
			clearTimelineHeadCache();
			await measure(`${label} (cold)`, path);
			if (label !== 'notifications') {
				clearTimelineHeadCache();
				await measure(`${label} (rebuild)`, path);
			}
			await measure(label, path);
		}
		// 新着が 1 件あるとき (ADR-0139 決定4)。リストのメンバーの Note なので、ホームとリストの両方に載る。
		await apex.store.saveObject({
			id: `${remotes[0]}/notes/new`,
			type: 'Note',
			attributedTo: remotes[0],
			content: '<p>new</p>',
			published: new Date().toISOString(),
			to: [PUBLIC],
			cc: [`${remotes[0]}/followers`],
		} as unknown as APObject);
		await measure('home (new entry)', timelinePaths.home);
		await measure('list (new entry)', timelinePaths.list);
		const [latest] = await measure('notifications', '/api/v1/notifications?limit=80');
		await measure('notifications poll', `/api/v1/notifications?limit=1&since_id=${latest!.id}`);

		const timelineMonthlyReads = (label: 'home' | 'list') =>
			Math.round(
				((results[`${label} (rebuild)`]!.total +
					results[label]!.total * (TIMELINE_REQUESTS_PER_REBUILD - 1)) /
					TIMELINE_REQUESTS_PER_REBUILD) *
					TIMELINE_REQUESTS_PER_MONTH,
			);
		const monthly = {
			home: timelineMonthlyReads('home'),
			list: timelineMonthlyReads('list'),
			notifications:
				results['notifications poll']!.total * NOTIFICATION_POLLS_PER_MONTH +
				results.notifications!.total * NOTIFICATION_RELOADS_PER_MONTH,
		};
		const monthlyReads = monthly.home + monthly.list + monthly.notifications;
		const estimate = {
			monthlyReads: monthly,
			totalMonthlyReads: monthlyReads,
			monthlyUsd:
				Math.round(Math.max(0, monthlyReads - FREE_READS_PER_MONTH) * READ_PRICE * 100) / 100,
		};

		const lines = [
			'| request | reads | items | breakdown |',
			'|---|---:|---:|---|',
			...Object.entries(results).map(
				([label, { total, items, breakdown }]) =>
					`| ${label} | ${total} | ${items} | ${Object.entries(breakdown)
						.map(([collection, n]) => `${collection} ${n}`)
						.join(', ')} |`,
			),
			'',
			`monthly reads: home ${monthly.home}, list ${monthly.list}, notifications ${monthly.notifications}, total ${monthlyReads}`,
			`monthly cost: $${estimate.monthlyUsd}`,
		];
		process.stdout.write(`\n${lines.join('\n')}\n`);
		if (process.env.MEASURE_OUT !== undefined) {
			writeFileSync(process.env.MEASURE_OUT, JSON.stringify({ results, estimate }, null, 2));
		}
	});
});
