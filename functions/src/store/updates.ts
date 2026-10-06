// Store の更新系メソッド (updateObject / updateActivity) が共有する内部処理。
import type { DocumentReference } from '@google-cloud/firestore';
import type { APObject } from '../apex/index.js';
import firebase from 'firebase-admin';
import { isEqual, mapValues } from 'lodash-es';
import { db, escapeFirestoreKey } from '../firebase.js';
import { metaIndexPath } from '../meta.js';
import { Streams } from '../schema.js';

// fullReplace でドキュメントを丸ごと置き換える際も、既存の _meta (秘密鍵・非正規化カウンタ・
// _meta.collection 等) は引き継ぐ。外部から取得・受信した表現は _meta を持たないため、
// そのまま set すると内部状態が失われる。saveObject と同じマージ規則を使う (→ ADR-0053、ADR-0059)。
export const replaceKeepingMeta = (ref: DocumentReference<APObject>, object: APObject) =>
	db.runTransaction(async (transaction) => {
		const existingMeta = (await transaction.get(ref)).data()?._meta;
		transaction.set(
			ref,
			existingMeta === undefined
				? object
				: { ...object, _meta: { ...existingMeta, ...object._meta } },
		);
	});

export const objectToUpdateDoc = (object: APObject) =>
	mapValues(object, (value) => {
		if (value === null) {
			return firebase.firestore.FieldValue.delete();
		}
		return value;
	});

// `streams` に埋め込まれている古いコピーを新しい内容へ差し替える。
// `streams.object` は常に配列なので、ドット記法(`where('object.id', '==', ...)`)では
// 引けない。denormalizations.ts が書き込む map 形式のインデックスを使う(→ ADR-0021)。
//
// 置き換えるのは MongoDB 実装の arrayFilters(`{ 'element.id': object.id }`)と同じく
// `id` が一致する埋め込みオブジェクトの要素だけで、IRI 文字列の要素はそのまま残す。
// MongoDB 実装は配送キューの署名鍵も更新するが、こちらは配送時に actor を読み直すため不要。
export const updateObjectCopies = async (object: APObject) => {
	const replaceCopy = (value: unknown) => {
		if (typeof value === 'object' && value !== null && 'id' in value && value.id === object.id) {
			return object;
		}
		return value;
	};

	await db.runTransaction(async (transaction) => {
		const matchedDocs = await transaction.get(
			Streams.where(metaIndexPath('objects', escapeFirestoreKey(object.id)), '==', true),
		);
		matchedDocs.forEach((doc) => {
			const rawObject: unknown = doc.get('object');
			// 配列を配列のまま保つ(lodash の mapValues は配列を数値キーのマップに壊す)。
			const newObject = Array.isArray(rawObject)
				? rawObject.map(replaceCopy)
				: replaceCopy(rawObject);
			// IRI 文字列で参照しているだけのドキュメントには書き込まない
			// (無意味な書き込みで onStreamWritten を再発火させない)。
			if (isEqual(rawObject, newObject)) {
				return;
			}
			transaction.update(doc.ref, { object: newObject });
		});
	});
};
