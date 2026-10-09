import type { APActor } from 'activitypub-types';
import { apex, ensureSystemUser } from '../apex.js';
import type { APObject } from '../apex/index.js';
import { domain, mastodonDomain } from '../firebase.js';
import { normalizeHashtag, toHashtagDisplayName } from '../hashtags.js';
import { getIriByMastodonId } from '../mastodonId.js';
import { Objects } from '../schema.js';
import { getAttributedTo, isAPActor, isAPNote } from '../utils.js';
import { fetchWebfinger } from '../webfinger.js';
import { getFollowing } from './follows.js';
import { hasPublicHashtagNotes } from './timelines.js';
import type { NoteObject } from './types.js';
import { isNoteVisibleTo, noteToVisibility } from './visibility.js';

// アカウント検索と、URL・acct からのリモートのアカウント / 投稿の解決 (→ ADR-0097)。
// Mastodon エンティティへの変換は mastodon/ 側で行い、ここでは actor IRI と Note を返す (→ ADR-0080)。

export const SEARCH_TYPES = ['accounts', 'hashtags', 'statuses'] as const;

export type SearchType = (typeof SEARCH_TYPES)[number];

export interface SearchOptions {
	type?: SearchType | undefined;
	// 外部への取得 (WebFinger・AP オブジェクトの取得) を行うか。認証済みのときだけ true にする。
	resolve: boolean;
	following: boolean;
	limit: number;
	offset: number;
	viewer?: APActor | undefined;
}

export interface SearchResult {
	actorIris: string[];
	notes: NoteObject[];
	// Tag エンティティの name にする表示用のタグ名 (→ ADR-0103)。
	hashtags: string[];
}

// 接頭辞検索の結果をドメインやフォロー関係で後から絞り込むときに読む actor の上限。
const PREFIX_SEARCH_SCAN_LIMIT = 200;

const ACCT_PATTERN = /^@?(?<username>[^@\s/]+)@(?<host>[^@\s/]+)$/u;

// Mastodon の HTML 用 URL (`/@user/123`、`/@user`)。IRI (`/users/user/statuses/123`) の推定に使う。
const MASTODON_STATUS_PATH = /^\/@(?<username>[\w.-]+)\/(?:statuses\/)?(?<id>\w+)$/u;
const MASTODON_ACCOUNT_PATH = /^\/@(?<username>[\w.-]+)$/u;

const isLocalHost = (host: string) => {
	const lowerHost = host.toLowerCase();
	return lowerHost === domain.toLowerCase() || lowerHost === mastodonDomain.toLowerCase();
};

const emptyResult = (): SearchResult => ({ actorIris: [], notes: [], hashtags: [] });

const parseUrl = (value: string) => {
	try {
		return new URL(value);
	} catch {
		return undefined;
	}
};

const originOf = (iri: string) => parseUrl(iri)?.origin;

const hostOf = (iri: string) => parseUrl(iri)?.host.toLowerCase();

const getObjectOrUndefined = (iri: string) => apex.store.getObject(iri, true);

// 手元の `objects` から URL に対応するオブジェクトを引く。外部へは取りに行かない。
const findLocalObjectByUrl = async (url: URL): Promise<APObject | undefined> => {
	const statusMatch = MASTODON_STATUS_PATH.exec(url.pathname)?.groups;
	const accountMatch = MASTODON_ACCOUNT_PATH.exec(url.pathname)?.groups;

	if (url.host.toLowerCase() === mastodonDomain.toLowerCase()) {
		if (statusMatch?.id !== undefined) {
			const iri = await getIriByMastodonId(statusMatch.id);
			return iri === undefined ? undefined : getObjectOrUndefined(iri);
		}
		if (accountMatch?.username !== undefined) {
			return getObjectOrUndefined(apex.utils.usernameToIRI(accountMatch.username.toLowerCase()));
		}
		return undefined;
	}

	const byIri = await getObjectOrUndefined(url.href);
	if (byIri !== undefined) {
		return byIri;
	}
	if (statusMatch !== undefined) {
		return getObjectOrUndefined(
			`${url.origin}/users/${statusMatch.username}/statuses/${statusMatch.id}`,
		);
	}
	if (accountMatch !== undefined) {
		return getObjectOrUndefined(`${url.origin}/users/${accountMatch.username}`);
	}
	return undefined;
};

// 外部から AP オブジェクトを取得して `objects` に保存する。
// 取得結果の `id` が要求した URL と別オリジンなら `id` で取り直し、`id` が一致するものだけを受け入れる
// (Mastodon の FetchResourceService と同じ。→ ADR-0097)。失敗はすべて undefined にする。
const fetchRemoteObject = async (url: string): Promise<APObject | undefined> => {
	try {
		await ensureSystemUser();
		let object = await apex.requestObject(url);
		const id = typeof object?.id === 'string' ? object.id : undefined;
		const idHost = id === undefined ? undefined : hostOf(id);
		if (object === undefined || id === undefined || idHost === undefined || isLocalHost(idHost)) {
			return undefined;
		}
		if (originOf(id) !== originOf(url)) {
			const cached = await getObjectOrUndefined(id);
			if (cached !== undefined) {
				return cached;
			}
			object = await apex.requestObject(id);
			if (object?.id !== id) {
				return undefined;
			}
		}
		return await apex.resolveObject(object, false, true);
	} catch (error) {
		apex.logger.warn({
			type: 'searchFetchRemoteObjectFailed',
			url,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
};

const resolveRemoteActor = async (iri: string): Promise<APObject | undefined> => {
	const cached = await getObjectOrUndefined(iri);
	if (cached !== undefined) {
		return isAPActor(cached) ? cached : undefined;
	}
	const host = hostOf(iri);
	if (host === undefined || isLocalHost(host)) {
		return undefined;
	}
	const fetched = await fetchRemoteObject(iri);
	return fetched !== undefined && isAPActor(fetched) && fetched.id === iri ? fetched : undefined;
};

// URL からアカウント (actor) か投稿 (Note) を引く。Note は投稿者の actor も手元に入れる。
const resolveUrl = async (query: string, resolve: boolean): Promise<APObject | undefined> => {
	const url = parseUrl(query);
	if (url === undefined) {
		return undefined;
	}

	const local = await findLocalObjectByUrl(url);
	if (local !== undefined) {
		if (!isAPNote(local)) {
			return local;
		}
		// 手元の Note でも、投稿者が手元にないと Status に変換できない。
		const author = getAttributedTo(local);
		if (author === undefined) {
			return undefined;
		}
		const authorActor = resolve
			? await resolveRemoteActor(author)
			: await getObjectOrUndefined(author);
		return authorActor !== undefined && isAPActor(authorActor) ? local : undefined;
	}
	if (!resolve || isLocalHost(url.host)) {
		return undefined;
	}

	const fetched = await fetchRemoteObject(url.href);
	if (fetched === undefined || !isAPNote(fetched)) {
		return fetched;
	}

	// 投稿者は Note と同じオリジンのものだけ受け入れる。
	const author = getAttributedTo(fetched);
	if (author === undefined || originOf(author) !== originOf(String(fetched.id))) {
		return undefined;
	}
	return (await resolveRemoteActor(author)) === undefined ? undefined : fetched;
};

// `_meta.preferredUsername` の前方一致で actor を引く。大文字小文字は区別する。
const searchActorsByUsernamePrefix = async (prefix: string, scanLimit: number) => {
	if (prefix.length === 0) {
		return [];
	}
	const snapshot = await Objects.where('_meta.preferredUsername', '>=', prefix)
		.where('_meta.preferredUsername', '<', `${prefix}`)
		.limit(scanLimit)
		.get();
	return snapshot.docs.map((doc) => doc.data()).filter((object) => isAPActor(object));
};

// `user@domain` を手元から引き、完全一致が無ければ (resolve 時のみ) WebFinger で解決する。
// ドメインは入力途中のこともあるため、手元の検索では前方一致で絞り込む (Mastodon と同じ)。
const searchAccountsByAcct = async (
	username: string,
	host: string,
	resolve: boolean,
): Promise<string[]> => {
	if (isLocalHost(host)) {
		const actor = await getObjectOrUndefined(apex.utils.usernameToIRI(username.toLowerCase()));
		return actor !== undefined && isAPActor(actor) ? [String(actor.id)] : [];
	}

	const lowerHost = host.toLowerCase();
	const candidates = (
		await searchActorsByUsernamePrefix(username, PREFIX_SEARCH_SCAN_LIMIT)
	).filter((actor) => hostOf(String(actor.id))?.startsWith(lowerHost) === true);
	const exactMatch = candidates.find(
		(actor) =>
			actor._meta?.preferredUsername === username && hostOf(String(actor.id)) === lowerHost,
	);
	const candidateIris = candidates.map((actor) => String(actor.id));

	let firstIri = exactMatch === undefined ? undefined : String(exactMatch.id);
	if (firstIri === undefined && resolve) {
		const actorIri = await fetchWebfinger(username, host);
		const resolved = actorIri === undefined ? undefined : await resolveRemoteActor(actorIri);
		firstIri = resolved === undefined ? undefined : String(resolved.id);
	}
	return firstIri === undefined
		? candidateIris
		: [firstIri, ...candidateIris.filter((iri) => iri !== firstIri)];
};

const isTypeIncluded = (type: SearchType | undefined, target: SearchType) =>
	type === undefined || type === target;

const searchByUrl = async (query: string, options: SearchOptions): Promise<SearchResult> => {
	if (options.offset > 0) {
		return emptyResult();
	}
	const object = await resolveUrl(query, options.resolve);
	if (object === undefined) {
		return emptyResult();
	}
	if (isAPActor(object) && isTypeIncluded(options.type, 'accounts')) {
		return { actorIris: [String(object.id)], notes: [], hashtags: [] };
	}
	if (isAPNote(object) && isTypeIncluded(options.type, 'statuses')) {
		const { viewer } = options;
		const needsFollowing =
			noteToVisibility(object) === 'private' &&
			viewer !== undefined &&
			getAttributedTo(object) !== viewer.id;
		const following = needsFollowing ? new Set(await getFollowing(viewer)) : new Set<string>();
		if (isNoteVisibleTo(object, viewer?.id, following)) {
			return { actorIris: [], notes: [object], hashtags: [] };
		}
	}
	return emptyResult();
};

// タグは完全一致だけを探し、その名前の公開 Note が手元に1件でもあれば返す (→ ADR-0103)。
const searchHashtags = async (query: string, options: SearchOptions): Promise<string[]> => {
	if (options.offset > 0 || query.includes('@')) {
		return [];
	}
	const displayName = toHashtagDisplayName(query);
	const normalized = normalizeHashtag(query);
	if (displayName === undefined || normalized === undefined) {
		return [];
	}
	return (await hasPublicHashtagNotes(normalized)) ? [displayName] : [];
};

const searchAccounts = async (q: string, options: SearchOptions): Promise<string[]> => {
	const acctMatch = ACCT_PATTERN.exec(q)?.groups;
	const filterFollowing = options.following && options.viewer !== undefined;
	let actorIris =
		acctMatch?.username !== undefined && acctMatch.host !== undefined
			? await searchAccountsByAcct(acctMatch.username, acctMatch.host, options.resolve)
			: (
					await searchActorsByUsernamePrefix(
						q.replace(/^@/u, ''),
						filterFollowing ? PREFIX_SEARCH_SCAN_LIMIT : options.offset + options.limit,
					)
				).map((actor) => String(actor.id));

	if (filterFollowing && options.viewer !== undefined) {
		const following = new Set(await getFollowing(options.viewer));
		actorIris = actorIris.filter((iri) => following.has(iri));
	}

	return actorIris.slice(options.offset, options.offset + options.limit);
};

export const search = async (query: string, options: SearchOptions): Promise<SearchResult> => {
	const q = query.trim();
	if (q.length === 0 || options.limit <= 0) {
		return emptyResult();
	}

	if (/^https?:\/\//iu.test(q)) {
		return searchByUrl(q, options);
	}

	// 投稿の全文検索は行わない (→ ADR-0097)。
	const [actorIris, hashtags] = await Promise.all([
		isTypeIncluded(options.type, 'accounts') ? searchAccounts(q, options) : [],
		isTypeIncluded(options.type, 'hashtags') ? searchHashtags(q, options) : [],
	]);
	return { actorIris, notes: [], hashtags };
};
