import { createHash, randomInt } from 'node:crypto';
import type { Transaction } from '@google-cloud/firestore';
import { db, escapeFirestoreKey } from './firebase.js';
import { MastodonIds, MastodonIdsByIri } from './schema.js';
import { toStringValue } from './utils.js';

// Mastodon API の ID の採番と、AP IRI との相互マッピング (→ ADR-0006、ADR-0058)。
//
// レイアウトは Mastodon 本体 (`third_party/mastodon/lib/mastodon/snowflake.rb`) と同じ
// `UNIX エポックからのミリ秒 << 16 | シーケンス(16 bit)` で、10 進数の 20 桁にゼロパディングする。

const SEQUENCE_BITS = 16n;
export const MAX_SEQUENCE = 2 ** Number(SEQUENCE_BITS) - 1;
export const MASTODON_ID_LENGTH = 20;
// タイムスタンプ部の上限 (48 bit)。これを超えると 64 bit に収まらない。
const MAX_TIMESTAMP = 2 ** 48 - 1;
// 空きシーケンスを探すとき、1回の getAll でまとめて読む候補の数。
const PROBE_BATCH_SIZE = 16;

// IRI ⇔ Mastodon ID の対応のインスタンス内キャッシュ (→ ADR-0137)。対応は採番後に変わらないので無効化しない。
// Map の挿入順を使った LRU で、参照したものを末尾に移し、上限を超えたら先頭から捨てる。
const MAPPING_CACHE_MAX_ENTRIES = 20_000;
const mastodonIdByIriCache = new Map<string, string>();
const iriByMastodonIdCache = new Map<string, string>();

const touchCache = (cache: Map<string, string>, key: string) => {
	const value = cache.get(key);
	if (value !== undefined) {
		cache.delete(key);
		cache.set(key, value);
	}
	return value;
};

const setCache = (cache: Map<string, string>, key: string, value: string) => {
	cache.delete(key);
	cache.set(key, value);
	while (cache.size > MAPPING_CACHE_MAX_ENTRIES) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) {
			break;
		}
		cache.delete(oldest);
	}
};

const rememberMapping = (iri: string, mastodonId: string) => {
	setCache(mastodonIdByIriCache, iri, mastodonId);
	setCache(iriByMastodonIdCache, mastodonId, iri);
};

// テスト用。エミュレータを消したときに、消えた対応を返さないようにする。
export const clearMastodonIdCache = () => {
	mastodonIdByIriCache.clear();
	iriByMastodonIdCache.clear();
};

const mastodonIdPattern = new RegExp(`^\\d{${MASTODON_ID_LENGTH}}$`);

export const isMastodonId = (value: string) => mastodonIdPattern.test(value);

export const buildMastodonId = (timestamp: number, sequence: number) => {
	if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp > MAX_TIMESTAMP) {
		throw new RangeError(`timestamp out of range: ${timestamp}`);
	}
	if (!Number.isInteger(sequence) || sequence < 0 || sequence > MAX_SEQUENCE) {
		throw new RangeError(`sequence out of range: ${sequence}`);
	}
	return ((BigInt(timestamp) << SEQUENCE_BITS) | BigInt(sequence))
		.toString()
		.padStart(MASTODON_ID_LENGTH, '0');
};

export const mastodonIdToTimestamp = (mastodonId: string) =>
	Number(BigInt(mastodonId) >> SEQUENCE_BITS);

// 採番に使うタイムスタンプ (ミリ秒) を決める。`published` を基準とし、未来の値は現在時刻に丸め、
// 欠損・解釈不能なら現在時刻を使う (→ ADR-0058)。新規保存時とバックフィルで同じ規則を使うこと。
export const toIdTimestamp = (published: unknown, now = Date.now()) => {
	const publishedString =
		published instanceof Date ? published.toISOString() : toStringValue(published);
	const parsed = publishedString === undefined ? Number.NaN : Date.parse(publishedString);
	if (Number.isNaN(parsed)) {
		return now;
	}
	return Math.max(0, Math.min(parsed, now));
};

// `_meta.published` に入れる、タイムライン用の並べ替えキー。ID のタイムスタンプ (`toIdTimestamp`)
// と同じ規則で決めるので、ID の大小と同じ順序になる。ミリ秒つきの ISO 8601 (UTC) なので辞書順が時系列順になる。
// AP の `published` は配列・表記揺れ・欠損がありうるため、クエリには使わずこちらを使う (→ ADR-0062)。
// `published` が解釈できなければ undefined (タイムラインの対象外)。
export const toPublishedSortKey = (published: unknown, now = Date.now()) => {
	const publishedString =
		published instanceof Date ? published.toISOString() : toStringValue(published);
	if (publishedString === undefined || Number.isNaN(Date.parse(publishedString))) {
		return undefined;
	}
	return new Date(toIdTimestamp(published, now)).toISOString();
};

const trailingNumericIdPattern = /\/(?<id>\d{15,20})$/u;

// 空きシーケンスを探す起点。IRI 末尾の数値 ID が Snowflake (`id >> 16` が timestamp と一致) なら
// その下位 16 bit を優先し (→ ADR-0126)、それ以外は IRI の SHA-256 の先頭 16 bit を使う (→ ADR-0118)。
export const sequenceStartOf = (iri: string, timestamp?: number) => {
	if (timestamp !== undefined) {
		const match = trailingNumericIdPattern.exec(iri);
		const id = match?.groups?.id;
		if (id !== undefined) {
			const bigId = BigInt(id);
			if (bigId >> SEQUENCE_BITS === BigInt(timestamp)) {
				return Number(bigId & BigInt(MAX_SEQUENCE));
			}
		}
	}
	return createHash('sha256').update(iri).digest().readUInt16BE(0);
};

// `start` から 65,536 で折り返しながら空きシーケンスを探す。書き込みは呼び出し側が行う。
const findFreeMastodonIdInTransaction = async (
	transaction: Transaction,
	timestamp: number,
	start: number,
) => {
	const sequenceCount = MAX_SEQUENCE + 1;
	for (let offset = 0; offset < sequenceCount; offset += PROBE_BATCH_SIZE) {
		const candidates = Array.from(
			{ length: Math.min(PROBE_BATCH_SIZE, sequenceCount - offset) },
			(_, index) => buildMastodonId(timestamp, (start + offset + index) % sequenceCount),
		);
		const candidateDocs = await transaction.getAll(
			...candidates.map((candidate) => MastodonIds.doc(escapeFirestoreKey(candidate))),
		);
		const freeIndex = candidateDocs.findIndex((doc) => !doc.exists);
		const mastodonId = candidates[freeIndex];
		if (mastodonId !== undefined) {
			return mastodonId;
		}
	}

	throw new Error(`Mastodon ID sequence exhausted at ${timestamp}`);
};

// トランザクション内で IRI の Mastodon ID を引き、無ければ採番する。
//
// Firestore のトランザクションは「すべての読み取りの後に書き込み」を要求する。この関数は
// 読み取りを済ませてから書き込みを積むので、呼び出し側はこれより後に読み取りをしてはならない。
// 同じミリ秒に並行して採番した場合は、同じ `mastodonIds` ドキュメントを読んだトランザクションの
// 一方が競合で再試行され、次のシーケンスを取る。
export const getOrAssignMastodonIdInTransaction = async (
	transaction: Transaction,
	iri: string,
	published: unknown,
) => {
	const byIriRef = MastodonIdsByIri.doc(escapeFirestoreKey(iri));
	const byIriDoc = await transaction.get(byIriRef);
	const existing = byIriDoc.data()?.mastodonId;
	if (existing !== undefined) {
		return existing;
	}

	const timestamp = toIdTimestamp(published);
	const mastodonId = await findFreeMastodonIdInTransaction(
		transaction,
		timestamp,
		sequenceStartOf(iri, timestamp),
	);
	transaction.create(MastodonIds.doc(escapeFirestoreKey(mastodonId)), { iri });
	transaction.set(byIriRef, { mastodonId });
	return mastodonId;
};

// コミットが成功してから覚える。トランザクションの中で覚えると、再試行で捨てられた ID が残る。
export const getOrAssignMastodonId = async (iri: string, published: unknown) => {
	const mastodonId = await db.runTransaction((transaction) =>
		getOrAssignMastodonIdInTransaction(transaction, iri, published),
	);
	rememberMapping(iri, mastodonId);
	return mastodonId;
};

// IRI → Mastodon ID をまとめて引く。採番はしない (未採番の IRI は結果に含まれない)。
// バックフィルの `--dry-run` など、書き込んではならない場面で使う。
// キャッシュに無いものだけを読む (→ ADR-0137)。トランザクションの中では使わないこと。
export const findMastodonIds = async (iris: string[]) => {
	const result = new Map<string, string>();
	const missing: string[] = [];
	for (const iri of new Set(iris)) {
		const cached = touchCache(mastodonIdByIriCache, iri);
		if (cached === undefined) {
			missing.push(iri);
		} else {
			result.set(iri, cached);
		}
	}
	if (missing.length === 0) {
		return result;
	}

	const docs = await db.getAll(
		...missing.map((iri) => MastodonIdsByIri.doc(escapeFirestoreKey(iri))),
	);
	missing.forEach((iri, index) => {
		const mastodonId = docs[index]?.get('mastodonId');
		if (typeof mastodonId === 'string') {
			result.set(iri, mastodonId);
			rememberMapping(iri, mastodonId);
		}
	});
	return result;
};

// IRI → Mastodon ID をまとめて引く。未採番の IRI があればその場で採番する (→ ADR-0058)。
export const getMastodonIds = async (entries: { iri: string; published: unknown }[]) => {
	const result = await findMastodonIds(entries.map(({ iri }) => iri));
	for (const { iri, published } of entries) {
		if (!result.has(iri)) {
			result.set(iri, await getOrAssignMastodonId(iri, published));
		}
	}
	return result;
};

// Mastodon ID → IRI。形式が不正な ID や未知の ID には undefined を返す。キャッシュを先に見る (→ ADR-0137)。
export const getIriByMastodonId = async (mastodonId: string) => {
	if (!isMastodonId(mastodonId)) {
		return undefined;
	}
	const cached = touchCache(iriByMastodonIdCache, mastodonId);
	if (cached !== undefined) {
		return cached;
	}
	const doc = await MastodonIds.doc(escapeFirestoreKey(mastodonId)).get();
	const iri = doc.data()?.iri;
	if (iri !== undefined) {
		rememberMapping(iri, mastodonId);
	}
	return iri;
};

// メディア添付用の Mastodon ID を採番する (→ ADR-0091)。
// 投稿前は AP IRI が存在しないため、`mediaAttachment:${id}` をダミー IRI として MastodonIds に登録し、
// Status などの ID との衝突を防ぐ。
export const assignMediaMastodonIdInTransaction = async (
	transaction: Transaction,
	now = Date.now(),
) => {
	// IRI が無いので乱数を起点にする (→ ADR-0118)。
	const mastodonId = await findFreeMastodonIdInTransaction(
		transaction,
		toIdTimestamp(now),
		randomInt(MAX_SEQUENCE + 1),
	);
	transaction.create(MastodonIds.doc(escapeFirestoreKey(mastodonId)), {
		iri: `mediaAttachment:${mastodonId}`,
	});
	return mastodonId;
};

export const assignMediaMastodonId = (now = Date.now()) =>
	db.runTransaction((transaction) => assignMediaMastodonIdInTransaction(transaction, now));
