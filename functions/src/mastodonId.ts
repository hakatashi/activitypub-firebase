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

// 空きシーケンスを探す起点。IRI の SHA-256 の先頭 16 bit を使う (→ ADR-0118)。
// Mastodon の actor の `published` は日単位なので同じタイムスタンプの採番が集中しうるが、
// 起点が散らばっていれば大半は最初の読み取りで空きが見つかり、並行するトランザクションも競合しない。
export const sequenceStartOf = (iri: string) =>
	createHash('sha256').update(iri).digest().readUInt16BE(0);

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

	const mastodonId = await findFreeMastodonIdInTransaction(
		transaction,
		toIdTimestamp(published),
		sequenceStartOf(iri),
	);
	transaction.create(MastodonIds.doc(escapeFirestoreKey(mastodonId)), { iri });
	transaction.set(byIriRef, { mastodonId });
	return mastodonId;
};

export const getOrAssignMastodonId = (iri: string, published: unknown) =>
	db.runTransaction((transaction) =>
		getOrAssignMastodonIdInTransaction(transaction, iri, published),
	);

// IRI → Mastodon ID をまとめて引く。採番はしない (未採番の IRI は結果に含まれない)。
// バックフィルの `--dry-run` など、書き込んではならない場面で使う。
export const findMastodonIds = async (iris: string[]) => {
	const result = new Map<string, string>();
	if (iris.length === 0) {
		return result;
	}

	const docs = await db.getAll(...iris.map((iri) => MastodonIdsByIri.doc(escapeFirestoreKey(iri))));
	iris.forEach((iri, index) => {
		const mastodonId = docs[index]?.get('mastodonId');
		if (typeof mastodonId === 'string') {
			result.set(iri, mastodonId);
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

// Mastodon ID → IRI。形式が不正な ID や未知の ID には undefined を返す。
export const getIriByMastodonId = async (mastodonId: string) => {
	if (!isMastodonId(mastodonId)) {
		return undefined;
	}
	const doc = await MastodonIds.doc(escapeFirestoreKey(mastodonId)).get();
	return doc.data()?.iri;
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
