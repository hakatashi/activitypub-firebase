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
	for (let start = 0; start <= MAX_SEQUENCE; start += PROBE_BATCH_SIZE) {
		const candidates = Array.from(
			{ length: Math.min(PROBE_BATCH_SIZE, MAX_SEQUENCE - start + 1) },
			(_, offset) => buildMastodonId(timestamp, start + offset),
		);
		const candidateDocs = await transaction.getAll(
			...candidates.map((candidate) => MastodonIds.doc(escapeFirestoreKey(candidate))),
		);
		const freeIndex = candidateDocs.findIndex((doc) => !doc.exists);
		const mastodonId = candidates[freeIndex];
		if (mastodonId !== undefined) {
			transaction.create(MastodonIds.doc(escapeFirestoreKey(mastodonId)), { iri });
			transaction.set(byIriRef, { mastodonId });
			return mastodonId;
		}
	}

	throw new Error(`Mastodon ID sequence exhausted at ${timestamp} for ${iri}`);
};

export const getOrAssignMastodonId = (iri: string, published: unknown) =>
	db.runTransaction((transaction) =>
		getOrAssignMastodonIdInTransaction(transaction, iri, published),
	);

// IRI → Mastodon ID をまとめて引く。未採番の IRI があればその場で採番する (→ ADR-0058)。
export const getMastodonIds = async (entries: { iri: string; published: unknown }[]) => {
	const result = new Map<string, string>();
	if (entries.length === 0) {
		return result;
	}

	const docs = await db.getAll(
		...entries.map(({ iri }) => MastodonIdsByIri.doc(escapeFirestoreKey(iri))),
	);
	const missing: { iri: string; published: unknown }[] = [];
	entries.forEach((entry, index) => {
		const mastodonId = docs[index]?.get('mastodonId');
		if (typeof mastodonId === 'string') {
			result.set(entry.iri, mastodonId);
		} else {
			missing.push(entry);
		}
	});

	for (const { iri, published } of missing) {
		result.set(iri, await getOrAssignMastodonId(iri, published));
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
