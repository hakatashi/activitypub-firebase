import type { Timestamp } from '@google-cloud/firestore';
import firebase from 'firebase-admin';
import { escapeFirestoreKey } from '../../src/firebase.js';
import { clearMastodonIdCache } from '../../src/mastodonId.js';
import { timelineFeedsMarkerRef } from '../../src/projections/timelineFeeds.js';

/**
 * テスト用 Firestore エミュレータのリセットヘルパー。
 * 現在のプロセスの GCLOUD_PROJECT (ワーカー固有の projectId) の全ドキュメントを消去する。
 */
export const resetFirestore = async (): Promise<void> => {
	const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
	const projectId = process.env.GCLOUD_PROJECT;
	if (firestoreHost === undefined || projectId === undefined) {
		throw new Error(
			'Firestore emulator is not running or GCLOUD_PROJECT is not set (FIRESTORE_EMULATOR_HOST or GCLOUD_PROJECT missing)',
		);
	}
	const res = await fetch(
		`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
		{ method: 'DELETE' },
	);
	if (!res.ok) {
		throw new Error(`Failed to reset Firestore emulator: ${res.status} ${res.statusText}`);
	}
	// 消えた対応をキャッシュから返さないようにする (→ ADR-0138)。
	clearMastodonIdCache();
};

/**
 * タイムラインの射影から読むためのマーカーを書く (→ ADR-0136 決定5)。
 * バックフィルを通さずに、書き込み時の射影だけで読み出しを確かめるときに使う。
 */
export const enableTimelineFeeds = async (actorId: string): Promise<void> => {
	await timelineFeedsMarkerRef(escapeFirestoreKey(actorId)).set({
		updatedAt: firebase.firestore.Timestamp.now() as unknown as Timestamp,
	});
};
