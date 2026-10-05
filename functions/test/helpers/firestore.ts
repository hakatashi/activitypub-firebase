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
};
