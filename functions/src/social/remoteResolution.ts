import { apex, ensureSystemUser } from '../apex.js';
import type { APObject } from '../apex/index.js';
import { domain, mastodonDomain } from '../firebase.js';
import { isAPActor } from '../utils.js';

// リモートの AP オブジェクトを外部から取得する共通処理 (→ ADR-0097、ADR-0104)。
// 取得は apex の requestObject (SSRF セーフ、ADR-0050) に、署名はローカル actor の鍵に任せる (→ ADR-0098)。

export const isLocalHost = (host: string) => {
	const lowerHost = host.toLowerCase();
	return lowerHost === domain.toLowerCase() || lowerHost === mastodonDomain.toLowerCase();
};

export const parseUrl = (value: string) => {
	try {
		return new URL(value);
	} catch {
		return undefined;
	}
};

export const originOf = (iri: string) => parseUrl(iri)?.origin;

export const hostOf = (iri: string) => parseUrl(iri)?.host.toLowerCase();

export const getObjectOrUndefined = (iri: string) => apex.store.getObject(iri, true);

// 外部から AP オブジェクトを取得して `objects` に保存する。
// 取得結果の `id` が要求した URL と別オリジンなら `id` で取り直し、`id` が一致するものだけを受け入れる
// (Mastodon の FetchResourceService と同じ。→ ADR-0097)。失敗はすべて undefined にする。
export const fetchRemoteObject = async (url: string): Promise<APObject | undefined> => {
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

// actor を手元から引き、なければ外部から取得して保存する。
export const resolveRemoteActor = async (iri: string): Promise<APObject | undefined> => {
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

// 外部からリモート actor を保存せずに取得し、オリジンとアクター型を検証する (→ ADR-0097、ADR-0110)。
// 失敗または検証に反する場合は undefined を返す。
export const requestRemoteActor = async (iri: string): Promise<APObject | undefined> => {
	const host = hostOf(iri);
	if (host === undefined || isLocalHost(host)) {
		return undefined;
	}
	try {
		await ensureSystemUser();
		let object = await apex.requestObject(iri);
		const id = typeof object?.id === 'string' ? object.id : undefined;
		const idHost = id === undefined ? undefined : hostOf(id);
		if (
			object === undefined ||
			id === undefined ||
			idHost === undefined ||
			isLocalHost(idHost) ||
			!isAPActor(object)
		) {
			return undefined;
		}
		if (originOf(id) !== originOf(iri)) {
			object = await apex.requestObject(id);
			if (object?.id !== id || !isAPActor(object)) {
				return undefined;
			}
		}
		return object.id === iri ? object : undefined;
	} catch (error) {
		apex.logger.warn({
			type: 'requestRemoteActorFailed',
			iri,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
};

// 外部のオブジェクトを保存せずに取得する。失敗は undefined にする。
export const requestRemoteObject = async (url: string): Promise<APObject | undefined> => {
	const host = hostOf(url);
	if (host === undefined || isLocalHost(host)) {
		return undefined;
	}
	try {
		await ensureSystemUser();
		return await apex.requestObject(url);
	} catch (error) {
		apex.logger.warn({
			type: 'requestRemoteObjectFailed',
			url,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
};
