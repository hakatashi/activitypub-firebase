// Vitest ワーカーごとに projectId を分離し、Firestore エミュレータ上の
// データをワーカー間で独立させる (ADR-0077)。
// このファイルは functions/src/firebase.ts 等のモジュールが import されるより前に
// setupFiles の先頭で実行されなければならない。
const poolId = process.env.VITEST_POOL_ID ?? '0';
const projectId = `activitypub-firebase-dev-w${poolId}`;

process.env.GCLOUD_PROJECT = projectId;

if (process.env.FIREBASE_CONFIG) {
	try {
		const config = JSON.parse(process.env.FIREBASE_CONFIG) as Record<string, unknown>;
		config.projectId = projectId;
		process.env.FIREBASE_CONFIG = JSON.stringify(config);
	} catch {
		// Ignore invalid JSON
	}
}
