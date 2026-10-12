import assert from 'node:assert';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { apex } from '../../src/apex.js';
import { escapeFirestoreKey } from '../../src/firebase.js';
import { LOCAL_USERNAME } from '../../src/localActor.js';
import { Deliveries, FollowRelations, Streams } from '../../src/schema.js';
import {
	classifyFollowerStatus,
	formatDomainSummaryTable,
	parseNextLink,
	preDeliverUpdatePerson,
	reconcileMigrationProgress,
} from '../../src/social/migration.js';
import type { RemoteFollowerAccount } from '../../src/social/migration.js';
import { createLocalActor, resetFirestore } from '../helpers/index.js';
import type { LocalActor } from '../helpers/index.js';
import { toIdArray } from '../../src/utils.js';

describe('social/migration (ADR-0125)', () => {
	let me: LocalActor;

	beforeEach(async () => {
		vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(true);
		me = await createLocalActor(LOCAL_USERNAME);
	});

	afterEach(async () => {
		await resetFirestore();
	});

	describe('parseNextLink', () => {
		test('extracts rel="next" url from Link header', () => {
			const link =
				'<https://pawoo.net/api/v1/accounts/1458/followers?limit=80&max_id=123>; rel="next", <https://pawoo.net/api/v1/accounts/1458/followers?limit=80&since_id=456>; rel="prev"';
			expect(parseNextLink(link)).toBe(
				'https://pawoo.net/api/v1/accounts/1458/followers?limit=80&max_id=123',
			);
		});

		test('returns undefined when rel="next" is absent', () => {
			const link = '<https://pawoo.net/api/v1/accounts/1458/followers?limit=80>; rel="prev"';
			expect(parseNextLink(link)).toBeUndefined();
		});

		test('returns undefined when link header is null or empty', () => {
			expect(parseNextLink(null)).toBeUndefined();
			expect(parseNextLink('')).toBeUndefined();
		});
	});

	describe('classifyFollowerStatus', () => {
		test('returns not_followed when actorUri is null', () => {
			expect(
				classifyFollowerStatus({
					actorUri: null,
					hasProjection: false,
					hasReceivedFollow: false,
				}),
			).toBe('not_followed');
		});

		test('returns not_followed when follow activity is not received', () => {
			expect(
				classifyFollowerStatus({
					actorUri: 'https://remote.example/users/alice',
					hasProjection: false,
					hasReceivedFollow: false,
				}),
			).toBe('not_followed');
		});

		test('returns follow_received_not_projected when follow is received but not in projection', () => {
			expect(
				classifyFollowerStatus({
					actorUri: 'https://remote.example/users/alice',
					hasProjection: false,
					hasReceivedFollow: true,
				}),
			).toBe('follow_received_not_projected');
		});

		test('returns accept_delivery_failed when projected but accept delivery failed or retrying', () => {
			expect(
				classifyFollowerStatus({
					actorUri: 'https://remote.example/users/alice',
					hasProjection: true,
					hasReceivedFollow: true,
					acceptDeliveryStatus: 'permanent_failure',
				}),
			).toBe('accept_delivery_failed');

			expect(
				classifyFollowerStatus({
					actorUri: 'https://remote.example/users/alice',
					hasProjection: true,
					hasReceivedFollow: true,
					acceptDeliveryStatus: 'retrying',
				}),
			).toBe('accept_delivery_failed');
		});

		test('returns followed when projected and accept delivery succeeded or clean', () => {
			expect(
				classifyFollowerStatus({
					actorUri: 'https://remote.example/users/alice',
					hasProjection: true,
					hasReceivedFollow: true,
					acceptDeliveryStatus: 'success',
				}),
			).toBe('followed');

			expect(
				classifyFollowerStatus({
					actorUri: 'https://remote.example/users/alice',
					hasProjection: true,
					hasReceivedFollow: true,
					acceptDeliveryStatus: null,
				}),
			).toBe('followed');
		});
	});

	describe('reconcileMigrationProgress', () => {
		const ALICE_ID = 'https://mastodon.example/users/alice';
		const BOB_ID = 'https://mastodon.example/users/bob';
		const CAROL_ID = 'https://other.example/users/carol';
		const DAVE_ID = 'https://failed.example/users/dave';

		const followers: RemoteFollowerAccount[] = [
			{
				id: '1',
				username: 'alice',
				acct: 'alice@mastodon.example',
				url: ALICE_ID,
			},
			{
				id: '2',
				username: 'bob',
				acct: 'bob@mastodon.example',
				url: BOB_ID,
			},
			{
				id: '3',
				username: 'carol',
				acct: 'carol@other.example',
				url: CAROL_ID,
			},
			{
				id: '4',
				username: 'dave',
				acct: 'dave@failed.example',
				url: DAVE_ID,
			},
		];

		beforeEach(async () => {
			// Objects に保存
			await apex.store.saveObject({
				id: ALICE_ID,
				type: 'Person',
				preferredUsername: 'alice',
				inbox: `${ALICE_ID}/inbox`,
				_meta: { preferredUsername: 'alice' },
			} as never);
			await apex.store.saveObject({
				id: BOB_ID,
				type: 'Person',
				preferredUsername: 'bob',
				inbox: `${BOB_ID}/inbox`,
				_meta: { preferredUsername: 'bob' },
			} as never);
			await apex.store.saveObject({
				id: CAROL_ID,
				type: 'Person',
				preferredUsername: 'carol',
				inbox: `${CAROL_ID}/inbox`,
				_meta: { preferredUsername: 'carol' },
			} as never);
			await apex.store.saveObject({
				id: DAVE_ID,
				type: 'Person',
				preferredUsername: 'dave',
				inbox: `${DAVE_ID}/inbox`,
				_meta: { preferredUsername: 'dave' },
			} as never);

			// 1. alice: 正常に移行完了 (Follow 受信、射影あり、Accept 成功)
			await Streams.doc(escapeFirestoreKey('https://mastodon.example/activities/follow-alice')).set(
				{
					id: 'https://mastodon.example/activities/follow-alice',
					type: 'Follow',
					actor: [ALICE_ID],
					object: [me.id],
					_meta: { collection: [toIdArray(me.inbox)[0]] },
				} as never,
			);
			await FollowRelations(escapeFirestoreKey(me.id), 'followers')
				.doc(escapeFirestoreKey(ALICE_ID))
				.set({
					actor: ALICE_ID,
					followIri: 'https://mastodon.example/activities/follow-alice',
					followMastodonId: '101',
					state: 'accepted',
					createdAt: new Date() as never,
					follows: [],
				});
			await Streams.doc(escapeFirestoreKey('https://local.example/activities/accept-alice')).set({
				id: 'https://local.example/activities/accept-alice',
				type: 'Accept',
				actor: [me.id],
				to: [ALICE_ID],
				object: ['https://mastodon.example/activities/follow-alice'],
			} as never);

			// 2. bob: Follow は受信したが射影にいない (未承認 / 承認失敗)
			await Streams.doc(escapeFirestoreKey('https://mastodon.example/activities/follow-bob')).set({
				id: 'https://mastodon.example/activities/follow-bob',
				type: 'Follow',
				actor: [BOB_ID],
				object: [me.id],
				_meta: { collection: [toIdArray(me.inbox)[0]] },
			} as never);

			// 3. carol: Follow がまだ届いていない (not_followed) -> Streams / FollowRelations なし

			// 4. dave: 射影にあるが Accept 配送が permanent_failure
			await Streams.doc(escapeFirestoreKey('https://failed.example/activities/follow-dave')).set({
				id: 'https://failed.example/activities/follow-dave',
				type: 'Follow',
				actor: [DAVE_ID],
				object: [me.id],
				_meta: { collection: [toIdArray(me.inbox)[0]] },
			} as never);
			await FollowRelations(escapeFirestoreKey(me.id), 'followers')
				.doc(escapeFirestoreKey(DAVE_ID))
				.set({
					actor: DAVE_ID,
					followIri: 'https://failed.example/activities/follow-dave',
					followMastodonId: '104',
					state: 'accepted',
					createdAt: new Date() as never,
					follows: [],
				});
			const daveAcceptId = 'https://local.example/activities/accept-dave';
			await Streams.doc(escapeFirestoreKey(daveAcceptId)).set({
				id: daveAcceptId,
				type: 'Accept',
				actor: [me.id],
				to: [DAVE_ID],
				object: ['https://failed.example/activities/follow-dave'],
			} as never);
			await Deliveries.doc(escapeFirestoreKey(`${daveAcceptId} ${DAVE_ID}/inbox`)).set({
				activityId: daveAcceptId,
				actorId: me.id,
				inbox: `${DAVE_ID}/inbox`,
				body: '{}',
				attempts: 5,
				status: 'permanent_failure',
				statusCode: 500,
				error: 'Internal Server Error',
				updatedAt: new Date() as never,
			});
		});

		test('accurately classifies each follower and aggregates by domain', async () => {
			const result = await reconcileMigrationProgress(me, followers, {
				resolveRemote: false,
			});

			expect(result.total).toBe(4);
			expect(result.followed).toBe(1); // alice
			expect(result.followReceivedNotProjected).toBe(1); // bob
			expect(result.notFollowed).toBe(1); // carol
			expect(result.acceptDeliveryFailed).toBe(1); // dave

			// 個別フォロワーのステータス
			const aliceStatus = result.followers.find((f) => f.account.username === 'alice');
			expect(aliceStatus?.status).toBe('followed');

			const bobStatus = result.followers.find((f) => f.account.username === 'bob');
			expect(bobStatus?.status).toBe('follow_received_not_projected');

			const carolStatus = result.followers.find((f) => f.account.username === 'carol');
			expect(carolStatus?.status).toBe('not_followed');

			const daveStatus = result.followers.find((f) => f.account.username === 'dave');
			expect(daveStatus?.status).toBe('accept_delivery_failed');

			// ドメイン別集計
			const mstdnSummary = result.domains['mastodon.example'];
			expect(mstdnSummary).toBeDefined();
			expect(mstdnSummary?.total).toBe(2);
			expect(mstdnSummary?.followed).toBe(1);
			expect(mstdnSummary?.followReceivedNotProjected).toBe(1);
			expect(mstdnSummary?.completionRate).toBe(0.5);

			const otherSummary = result.domains['other.example'];
			expect(otherSummary).toBeDefined();
			expect(otherSummary?.total).toBe(1);
			expect(otherSummary?.notFollowed).toBe(1);
			expect(otherSummary?.completionRate).toBe(0);

			const failedSummary = result.domains['failed.example'];
			expect(failedSummary).toBeDefined();
			expect(failedSummary?.total).toBe(1);
			expect(failedSummary?.acceptDeliveryFailed).toBe(1);
			expect(failedSummary?.completionRate).toBe(0);

			// フォーマットテーブル出力
			const table = formatDomainSummaryTable(result);
			expect(table).toContain('Migration Status Summary');
			expect(table).toContain('mastodon.example');
			expect(table).toContain('other.example');
			expect(table).toContain('[ALL PENDING - Move not processed?]');
		});
	});

	describe('preDeliverUpdatePerson', () => {
		const REMOTE_ACTOR_ID = 'https://remote.example/users/alice';

		const followers: RemoteFollowerAccount[] = [
			{
				id: '1',
				username: 'alice',
				acct: 'alice@remote.example',
				url: REMOTE_ACTOR_ID,
			},
		];

		beforeEach(async () => {
			await apex.store.saveObject({
				id: REMOTE_ACTOR_ID,
				type: 'Person',
				preferredUsername: 'alice',
				inbox: `${REMOTE_ACTOR_ID}/inbox`,
				endpoints: {
					sharedInbox: 'https://remote.example/inbox',
				},
				_meta: { preferredUsername: 'alice' },
			} as never);
		});

		test('dry-run resolves endpoints without enqueueing delivery', async () => {
			const result = await preDeliverUpdatePerson(me, followers, { dryRun: true });

			expect(result.dryRun).toBe(true);
			expect(result.totalDomains).toBe(1);
			expect(result.resolvedEndpoints['remote.example']).toBe('https://remote.example/inbox');
			expect(result.targetEndpoints).toEqual(['https://remote.example/inbox']);
			expect(result.enqueued).toBe(false);
			expect(apex.store.deliveryEnqueue).not.toHaveBeenCalled();
		});

		test('actual run saves activity and enqueues delivery', async () => {
			const result = await preDeliverUpdatePerson(me, followers, { dryRun: false });

			expect(result.dryRun).toBe(false);
			expect(result.enqueued).toBe(true);
			expect(result.activityId).toBeDefined();
			expect(apex.store.deliveryEnqueue).toHaveBeenCalledWith(
				me.id,
				expect.any(String),
				['https://remote.example/inbox'],
				expect.anything(),
			);

			// Activity が Streams に保存されていること
			assert(result.activityId !== undefined);
			const saved = await Streams.doc(escapeFirestoreKey(result.activityId)).get();
			expect(saved.exists).toBe(true);
			expect(saved.data()?.type).toBe('Update');
		});
	});
});
