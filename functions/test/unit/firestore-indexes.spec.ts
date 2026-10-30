import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const indexesPath = path.resolve(currentDir, '../../../firestore.indexes.json');

interface IndexesFile {
	indexes: { collectionGroup: string; fields: { fieldPath: string }[] }[];
	fieldOverrides: {
		collectionGroup: string;
		fieldPath: string;
		ttl?: boolean;
		indexes: unknown[];
	}[];
}

const spec = JSON.parse(fs.readFileSync(indexesPath, 'utf8')) as IndexesFile;

// 単一フィールドインデックスでクエリ・orderBy に使うフィールド (→ ADR-0168)。
// エミュレータはインデックスを検査しないので、ここに挙げたフィールドを除外すると本番で初めて壊れる。
const QUERIED_FIELDS: Record<string, string[]> = {
	objects: [
		'type',
		'_meta.published',
		'_meta.attributedTo',
		'_meta.inReplyTo',
		'_meta.hashtags',
		'_meta.preferredUsername',
		'_meta.privateKey',
	],
	streams: [
		'type',
		'actor',
		'_meta.collection',
		'_meta.mastodonId',
		'_meta.actor',
		'_meta.published',
		'_meta.index',
	],
	deliveries: ['status'],
	homeFeed: ['id'],
	feed: ['id'],
};

// クエリに使うフィールドそのものか、それを含む map のフィールドか
const covers = (exempted: string, field: string) =>
	field === exempted || field.startsWith(`${exempted}.`);

const exemptions = spec.fieldOverrides.filter((override) => override.indexes.length === 0);

describe('firestore.indexes.json の単一フィールドインデックスの除外', () => {
	test('クエリに使うフィールドを除外していない', () => {
		for (const { collectionGroup, fieldPath } of exemptions) {
			for (const field of QUERIED_FIELDS[collectionGroup] ?? []) {
				expect(covers(fieldPath, field), `${collectionGroup}/${fieldPath}`).toBe(false);
			}
		}
	});

	test('複合インデックスに使うフィールドを除外していない', () => {
		for (const { collectionGroup, fieldPath } of exemptions) {
			for (const index of spec.indexes.filter((i) => i.collectionGroup === collectionGroup)) {
				for (const field of index.fields) {
					expect(covers(fieldPath, field.fieldPath), `${collectionGroup}/${fieldPath}`).toBe(false);
				}
			}
		}
	});

	test('firebase-tools が URL に入れられないフィールド名を使っていない', () => {
		for (const { collectionGroup, fieldPath } of spec.fieldOverrides) {
			expect(fieldPath, collectionGroup).not.toMatch(/[#/?%]/u);
		}
	});

	test('除外の数が Firestore の上限 (200) を超えない', () => {
		expect(spec.fieldOverrides.length).toBeLessThanOrEqual(200);
	});
});
