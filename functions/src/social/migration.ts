import assert from 'node:assert';
import { setTimeout } from 'node:timers/promises';
import type { APActor } from 'activitypub-types';
import { apex } from '../apex.js';
import type { APObject } from '../apex/index.js';
import { escapeFirestoreKey } from '../firebase.js';
import { Deliveries, FollowRelations, Objects, Streams } from '../schema.js';
import { firstOf, isAPActor, toIdArray } from '../utils.js';
import { fetchWebfinger } from '../webfinger.js';
import { hostOf, resolveRemoteActor } from './remoteResolution.js';

export interface RemoteFollowerAccount {
	id: string;
	username: string;
	acct: string;
	url: string;
}

export type MigrationFollowerStatus =
	| 'followed' // こちらのフォロワーの射影にいる
	| 'follow_received_not_projected' // inbox に Follow は届いたが射影にいない (承認の失敗)
	| 'accept_delivery_failed' // Accept の配送が deliveries で失敗・リトライ中
	| 'not_followed'; // Follow が届いていない

export interface FollowerClassificationInput {
	actorUri: string | null;
	hasProjection: boolean;
	hasReceivedFollow: boolean;
	acceptDeliveryStatus?: 'permanent_failure' | 'retrying' | 'success' | null;
}

export interface ClassifiedFollower {
	account: RemoteFollowerAccount;
	domain: string;
	actorUri: string | null;
	status: MigrationFollowerStatus;
	detail?: string;
}

export interface DomainSummary {
	domain: string;
	total: number;
	followed: number;
	notFollowed: number;
	followReceivedNotProjected: number;
	acceptDeliveryFailed: number;
	completionRate: number; // 0.0 - 1.0
}

export interface MigrationProgressResult {
	total: number;
	followed: number;
	notFollowed: number;
	followReceivedNotProjected: number;
	acceptDeliveryFailed: number;
	completionRate: number;
	domains: Record<string, DomainSummary>;
	followers: ClassifiedFollower[];
}

export interface ReconcileMigrationOptions {
	resolveRemote?: boolean;
	onProgress?: (info: { index: number; total: number; acct: string }) => void;
}

export interface PreDeliveryOptions {
	dryRun?: boolean;
	onProgress?: (info: {
		index: number;
		total: number;
		domain: string;
		endpoint?: string | undefined;
	}) => void;
}

export interface PreDeliveryResult {
	dryRun: boolean;
	totalDomains: number;
	resolvedEndpoints: Record<string, string>;
	unresolvedDomains: string[];
	targetEndpoints: string[];
	enqueued: boolean;
	activityId?: string;
}

// Mastodon API の Link ヘッダから rel="next" の URL を取り出す。
export const parseNextLink = (linkHeader: string | null | undefined): string | undefined => {
	if (!linkHeader) {
		return undefined;
	}
	const parts = linkHeader.split(',');
	for (const part of parts) {
		const match = /<(?<url>[^>]+)>;\s*rel="next"/iu.exec(part.trim());
		if (match?.groups?.url) {
			return match.groups.url;
		}
	}
	return undefined;
};

// 4 つの状態に分類する (ADR-0125)。
export const classifyFollowerStatus = (
	input: FollowerClassificationInput,
): MigrationFollowerStatus => {
	if (!input.actorUri || !input.hasReceivedFollow) {
		return 'not_followed';
	}
	if (!input.hasProjection) {
		return 'follow_received_not_projected';
	}
	if (
		input.acceptDeliveryStatus === 'permanent_failure' ||
		input.acceptDeliveryStatus === 'retrying'
	) {
		return 'accept_delivery_failed';
	}
	return 'followed';
};

// Mastodon API GET /api/v1/accounts/:id/followers をページングして取得する。
export const fetchRemoteFollowers = async (
	instanceDomain: string,
	acctOrId: string,
	options: { intervalMs?: number } = {},
): Promise<RemoteFollowerAccount[]> => {
	const { intervalMs = 100 } = options;
	const cleanDomain = instanceDomain.replace(/^https?:\/\//u, '').replace(/\/.*$/u, '');

	let accountId = acctOrId;
	if (!/^\d+$/u.test(acctOrId)) {
		const cleanAcct = acctOrId.startsWith('@') ? acctOrId.slice(1) : acctOrId;
		const lookupUrl = `https://${cleanDomain}/api/v1/accounts/lookup?acct=${encodeURIComponent(cleanAcct)}`;
		const lookupRes = await fetch(lookupUrl, {
			headers: { Accept: 'application/json' },
		});
		if (!lookupRes.ok) {
			throw new Error(
				`Failed to lookup account ${acctOrId} on ${cleanDomain}: HTTP ${lookupRes.status}`,
			);
		}
		const data = (await lookupRes.json()) as { id?: string };
		if (!data.id) {
			throw new Error(`Account lookup response missing id for ${acctOrId}`);
		}
		accountId = data.id;
	}

	const followers: RemoteFollowerAccount[] = [];
	let nextUrl: string | undefined =
		`https://${cleanDomain}/api/v1/accounts/${accountId}/followers?limit=80`;

	while (nextUrl) {
		const res = await fetch(nextUrl, {
			headers: { Accept: 'application/json' },
		});
		if (!res.ok) {
			throw new Error(`Failed to fetch followers from ${nextUrl}: HTTP ${res.status}`);
		}
		const data = (await res.json()) as Array<{
			id?: string;
			username?: string;
			acct?: string;
			url?: string;
		}>;

		if (!Array.isArray(data) || data.length === 0) {
			break;
		}

		for (const item of data) {
			if (item.id && item.username && item.url) {
				const rawAcct = item.acct ?? item.username;
				const acct = rawAcct.includes('@') ? rawAcct : `${rawAcct}@${cleanDomain}`;
				followers.push({
					id: item.id,
					username: item.username,
					acct,
					url: item.url,
				});
			}
		}

		const linkHeader = res.headers.get('link');
		nextUrl = parseNextLink(linkHeader);

		if (nextUrl && intervalMs > 0) {
			await setTimeout(intervalMs);
		}
	}

	return followers;
};

// endpoints は plain object (resolveRemoteActor / 生の JSON) と、
// apex が Firestore に保存した配列形式 ([{ sharedInbox: [...] }]) の両方がありうる (#301)。
export const getActorSharedInboxOrInbox = (actor: APObject): string | undefined => {
	const endpoints = firstOf(actor.endpoints as unknown);
	if (endpoints !== null && typeof endpoints === 'object') {
		const sharedInbox = toIdArray((endpoints as { sharedInbox?: unknown }).sharedInbox)[0];
		if (sharedInbox) {
			return sharedInbox;
		}
	}
	const sharedInbox = toIdArray((actor as { sharedInbox?: unknown }).sharedInbox)[0];
	if (sharedInbox) {
		return sharedInbox;
	}
	const inbox = toIdArray(actor.inbox)[0];
	return inbox || undefined;
};

// 旧アカウントのフォロワー一覧とローカルの進捗を突き合わせる (ADR-0125)。
export const reconcileMigrationProgress = async (
	localActor: APActor,
	followers: RemoteFollowerAccount[],
	options: ReconcileMigrationOptions = {},
): Promise<MigrationProgressResult> => {
	assert(localActor.id !== undefined, 'localActor.id is undefined');
	const localActorId = localActor.id;
	const localInboxId = toIdArray(localActor.inbox)[0];
	assert(localInboxId !== undefined, 'localActor.inbox is undefined');

	const { resolveRemote = true, onProgress } = options;

	// 1. フォロワー射影の全件取得
	const projectedSnapshot = await FollowRelations(
		escapeFirestoreKey(localActorId),
		'followers',
	).get();
	const projectedActors = new Set<string>();
	for (const doc of projectedSnapshot.docs) {
		const data = doc.data();
		if (data.actor && data.state === 'accepted') {
			projectedActors.add(data.actor);
		}
	}

	// 2. inbox に届いた Follow アクティビティの全件取得
	const receivedFollowDocs = await Streams.where('type', '==', 'Follow')
		.where('_meta.collection', 'array-contains', localInboxId)
		.get();
	const receivedFollowActors = new Map<string, string>(); // actorUri -> followActivityId
	for (const doc of receivedFollowDocs.docs) {
		const data = doc.data();
		const objectId = toIdArray(data.object)[0];
		if (objectId === localActorId) {
			const actorId = toIdArray(data.actor)[0];
			if (actorId && typeof data.id === 'string') {
				receivedFollowActors.set(actorId, data.id);
			}
		}
	}

	// 3. ローカル actor が発行した Accept アクティビティの取得
	const acceptDocs = await Streams.where('type', '==', 'Accept')
		.where('actor', 'array-contains', localActorId)
		.get();
	const acceptActivityIdByRecipient = new Map<string, string>(); // recipientActor -> acceptActivityId
	for (const doc of acceptDocs.docs) {
		const data = doc.data();
		const recipient = toIdArray(data.to)[0];
		if (recipient && typeof data.id === 'string') {
			acceptActivityIdByRecipient.set(recipient, data.id);
		}
	}

	// 4. 失敗・リトライ中の配送を取得
	const failedDeliveryDocs = await Deliveries.where('status', 'in', [
		'permanent_failure',
		'retrying',
	]).get();
	const failedActivityIds = new Map<string, 'permanent_failure' | 'retrying'>();
	for (const doc of failedDeliveryDocs.docs) {
		const data = doc.data();
		if (data.activityId && (data.status === 'permanent_failure' || data.status === 'retrying')) {
			failedActivityIds.set(data.activityId, data.status);
		}
	}

	const webfingerCache = new Map<string, string | null>();

	const resolveFollowerActorUri = async (
		username: string,
		host: string,
		url: string,
	): Promise<string | null> => {
		// url が既に射影や Follow に含まれていればそれを採用
		if (projectedActors.has(url) || receivedFollowActors.has(url)) {
			return url;
		}

		// Objects からキャッシュを検索
		const cachedSnapshot = await Objects.where('_meta.preferredUsername', '==', username).get();
		for (const doc of cachedSnapshot.docs) {
			const data = doc.data();
			if (
				isAPActor(data) &&
				typeof data.id === 'string' &&
				hostOf(data.id) === host.toLowerCase()
			) {
				return data.id;
			}
		}

		if (!resolveRemote) {
			return null;
		}

		const cacheKey = `${username}@${host}`.toLowerCase();
		if (webfingerCache.has(cacheKey)) {
			return webfingerCache.get(cacheKey) ?? null;
		}

		try {
			const resolvedUri = await fetchWebfinger(username, host);
			const uri = resolvedUri ?? null;
			webfingerCache.set(cacheKey, uri);
			return uri;
		} catch {
			webfingerCache.set(cacheKey, null);
			return null;
		}
	};

	const classifiedFollowers: ClassifiedFollower[] = [];
	const domainsMap = new Map<string, DomainSummary>();

	for (let i = 0; i < followers.length; i++) {
		const follower = followers[i]!;
		const host = (
			follower.acct.includes('@') ? follower.acct.split('@')[1]! : 'unknown'
		).toLowerCase();
		const username = follower.username;

		onProgress?.({ index: i + 1, total: followers.length, acct: follower.acct });

		const actorUri = await resolveFollowerActorUri(username, host, follower.url);

		let hasProjection = false;
		let hasReceivedFollow = false;
		let acceptDeliveryStatus: 'permanent_failure' | 'retrying' | 'success' | null = null;

		if (actorUri) {
			hasProjection = projectedActors.has(actorUri);
			hasReceivedFollow = receivedFollowActors.has(actorUri);

			const acceptId = acceptActivityIdByRecipient.get(actorUri);
			if (acceptId) {
				const failedStatus = failedActivityIds.get(acceptId);
				if (failedStatus) {
					acceptDeliveryStatus = failedStatus;
				} else {
					acceptDeliveryStatus = 'success';
				}
			}
		}

		const status = classifyFollowerStatus({
			actorUri,
			hasProjection,
			hasReceivedFollow,
			acceptDeliveryStatus,
		});

		classifiedFollowers.push({
			account: follower,
			domain: host,
			actorUri,
			status,
		});

		// ドメイン集計の加算
		let summary = domainsMap.get(host);
		if (!summary) {
			summary = {
				domain: host,
				total: 0,
				followed: 0,
				notFollowed: 0,
				followReceivedNotProjected: 0,
				acceptDeliveryFailed: 0,
				completionRate: 0,
			};
			domainsMap.set(host, summary);
		}

		summary.total++;
		if (status === 'followed') {
			summary.followed++;
		} else if (status === 'not_followed') {
			summary.notFollowed++;
		} else if (status === 'follow_received_not_projected') {
			summary.followReceivedNotProjected++;
		} else if (status === 'accept_delivery_failed') {
			summary.acceptDeliveryFailed++;
		}
	}

	// 完了率の計算
	for (const summary of domainsMap.values()) {
		summary.completionRate = summary.total > 0 ? summary.followed / summary.total : 0;
	}

	const domains: Record<string, DomainSummary> = {};
	for (const [host, summary] of domainsMap.entries()) {
		domains[host] = summary;
	}

	let followedCount = 0;
	let notFollowedCount = 0;
	let followReceivedNotProjectedCount = 0;
	let acceptDeliveryFailedCount = 0;

	for (const f of classifiedFollowers) {
		if (f.status === 'followed') {
			followedCount++;
		} else if (f.status === 'not_followed') {
			notFollowedCount++;
		} else if (f.status === 'follow_received_not_projected') {
			followReceivedNotProjectedCount++;
		} else if (f.status === 'accept_delivery_failed') {
			acceptDeliveryFailedCount++;
		}
	}

	return {
		total: classifiedFollowers.length,
		followed: followedCount,
		notFollowed: notFollowedCount,
		followReceivedNotProjected: followReceivedNotProjectedCount,
		acceptDeliveryFailed: acceptDeliveryFailedCount,
		completionRate: classifiedFollowers.length > 0 ? followedCount / classifiedFollowers.length : 0,
		domains,
		followers: classifiedFollowers,
	};
};

// 旧アカウントのフォロワーがいるサーバーへ Update(Person) を事前配送する (ADR-0125)。
export const preDeliverUpdatePerson = async (
	localActor: APActor,
	followers: RemoteFollowerAccount[],
	options: PreDeliveryOptions = {},
): Promise<PreDeliveryResult> => {
	assert(localActor.id !== undefined, 'localActor.id is undefined');
	const localHost = hostOf(localActor.id);
	const { dryRun = false, onProgress } = options;

	// ドメインごとにフォロワーをグループ化
	const domainFollowers = new Map<string, RemoteFollowerAccount[]>();
	for (const follower of followers) {
		const host = (
			follower.acct.includes('@') ? follower.acct.split('@')[1]! : 'unknown'
		).toLowerCase();
		if (localHost && host === localHost) {
			continue;
		}
		const list = domainFollowers.get(host) ?? [];
		list.push(follower);
		domainFollowers.set(host, list);
	}

	const domains = Array.from(domainFollowers.keys());
	const resolvedEndpoints: Record<string, string> = {};
	const unresolvedDomains: string[] = [];

	for (let i = 0; i < domains.length; i++) {
		const domain = domains[i]!;
		const accountList = domainFollowers.get(domain) ?? [];

		let endpoint: string | undefined;

		// 代表アカウントの actor を解決して sharedInbox / inbox を取得
		for (const account of accountList) {
			try {
				let actor: APObject | undefined;
				// 手元の Objects にあればそれを使う
				const cached = await Objects.where('_meta.preferredUsername', '==', account.username).get();
				for (const doc of cached.docs) {
					const data = doc.data();
					if (isAPActor(data) && typeof data.id === 'string' && hostOf(data.id) === domain) {
						actor = data;
						break;
					}
				}

				if (!actor) {
					const actorUri = await fetchWebfinger(account.username, domain);
					if (actorUri) {
						actor = await resolveRemoteActor(actorUri);
					}
				}

				if (actor) {
					endpoint = getActorSharedInboxOrInbox(actor);
					if (endpoint) {
						break;
					}
				}
			} catch {
				// 次のアカウントを試す
			}
		}

		if (endpoint) {
			resolvedEndpoints[domain] = endpoint;
		} else {
			unresolvedDomains.push(domain);
		}

		onProgress?.({
			index: i + 1,
			total: domains.length,
			domain,
			endpoint,
		});
	}

	const targetEndpoints = Array.from(new Set(Object.values(resolvedEndpoints)));

	if (dryRun || targetEndpoints.length === 0) {
		return {
			dryRun,
			totalDomains: domains.length,
			resolvedEndpoints,
			unresolvedDomains,
			targetEndpoints,
			enqueued: false,
		};
	}

	// Update(Person) アクティビティを生成
	const activity = await apex.buildActivity('Update', localActor.id, undefined, {
		object: localActor,
	});
	const outgoingJsonLd = await apex.toJSONLD(activity);
	const body = apex.stringifyPublicJSONLD(outgoingJsonLd);

	await apex.store.saveActivity(activity);

	const localActorMeta = (localActor as { _meta?: { privateKey?: unknown } })._meta;
	const privateKey =
		typeof localActorMeta?.privateKey === 'string' ? localActorMeta.privateKey : undefined;

	await apex.store.deliveryEnqueue(localActor.id, body, targetEndpoints, privateKey);

	return {
		dryRun: false,
		totalDomains: domains.length,
		resolvedEndpoints,
		unresolvedDomains,
		targetEndpoints,
		enqueued: true,
		activityId: activity.id,
	};
};

// ドメイン集計結果を見やすい表形式で整形する。
export const formatDomainSummaryTable = (result: MigrationProgressResult): string => {
	const lines: string[] = [];
	lines.push(
		'========================================================================================================',
	);
	lines.push('Migration Status Summary');
	lines.push(
		'========================================================================================================',
	);
	const pct = (n: number) =>
		`${(result.total > 0 ? (n / result.total) * 100 : 0).toFixed(1)}%`.padStart(6);

	lines.push(`Total followers: ${result.total}`);
	lines.push(
		`  - Followed (projected):         ${String(result.followed).padStart(4)} (${pct(result.followed)})`,
	);
	lines.push(
		`  - Not followed yet:              ${String(result.notFollowed).padStart(4)} (${pct(result.notFollowed)})`,
	);
	lines.push(
		`  - Follow received / not in proj: ${String(result.followReceivedNotProjected).padStart(4)} (${pct(result.followReceivedNotProjected)})`,
	);
	lines.push(
		`  - Accept delivery failed/retry:  ${String(result.acceptDeliveryFailed).padStart(4)} (${pct(result.acceptDeliveryFailed)})`,
	);
	lines.push('');
	lines.push(
		'--------------------------------------------------------------------------------------------------------',
	);
	lines.push('Domain Breakdown');
	lines.push(
		'--------------------------------------------------------------------------------------------------------',
	);
	lines.push(
		[
			'Domain'.padEnd(30),
			'Total'.padStart(7),
			'Followed'.padStart(10),
			'Not Followed'.padStart(14),
			'Failed Appr'.padStart(13),
			'Accept Fail'.padStart(13),
			'Rate'.padStart(8),
			'  Note',
		].join(''),
	);
	lines.push('-'.repeat(104));

	const sortedDomains = Object.values(result.domains).sort((a, b) => {
		if (b.total !== a.total) {
			return b.total - a.total;
		}
		return a.domain.localeCompare(b.domain);
	});

	for (const d of sortedDomains) {
		const rateStr = `${(d.completionRate * 100).toFixed(1)}%`.padStart(7);
		let note = '';
		if (d.total > 0 && d.followed === 0) {
			note = '[ALL PENDING - Move not processed?]';
		} else if (d.acceptDeliveryFailed > 0) {
			note = `[${d.acceptDeliveryFailed} Accept delivery failed]`;
		} else if (d.followReceivedNotProjected > 0) {
			note = `[${d.followReceivedNotProjected} unapproved Follow]`;
		}

		lines.push(
			[
				d.domain.padEnd(30),
				String(d.total).padStart(7),
				String(d.followed).padStart(10),
				String(d.notFollowed).padStart(14),
				String(d.followReceivedNotProjected).padStart(13),
				String(d.acceptDeliveryFailed).padStart(13),
				rateStr.padStart(8),
				note ? `  ${note}` : '',
			].join(''),
		);
	}

	lines.push(
		'========================================================================================================',
	);
	return lines.join('\n');
};
