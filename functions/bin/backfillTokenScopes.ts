import { AccessTokens, RefreshTokens, AuthorizationCodes } from '../src/schema.js';

// accessTokens / refreshTokens / authorizationCodes の `scope` (文字列) を
// @node-oauth/oauth2-server v5 の仕様に合わせて `string[]` に正規化するバックフィル。
// 既に配列になっているものや scope が無いものはスキップするので、何度実行しても安全 (冪等)。
// `--dry-run` で書き込まずに件数だけ確認可能。

const dryRun = process.argv.includes('--dry-run');

const normalizeScope = (scope: unknown): string[] | undefined => {
	if (typeof scope === 'string') {
		const trimmed = scope.trim();
		return trimmed.length > 0 ? trimmed.split(/\s+/) : [];
	}
	return undefined;
};

const backfillCollection = async (
	name: string,
	collection: FirebaseFirestore.CollectionReference<FirebaseFirestore.DocumentData>,
) => {
	const snapshot = await collection.get();
	let updated = 0;
	let batch = collection.firestore.batch();
	let batchCount = 0;

	for (const doc of snapshot.docs) {
		const rawScope = doc.get('scope');
		const normalized = normalizeScope(rawScope);
		if (normalized !== undefined) {
			if (!dryRun) {
				batch.update(doc.ref, { scope: normalized });
				batchCount++;
				if (batchCount >= 400) {
					await batch.commit();
					batch = collection.firestore.batch();
					batchCount = 0;
				}
			}
			updated++;
		}
	}

	if (!dryRun && batchCount > 0) {
		await batch.commit();
	}

	return { total: snapshot.docs.length, updated };
};

const accessTokensStats = await backfillCollection(
	'accessTokens',
	AccessTokens as unknown as FirebaseFirestore.CollectionReference,
);
const refreshTokensStats = await backfillCollection(
	'refreshTokens',
	RefreshTokens as unknown as FirebaseFirestore.CollectionReference,
);
const authorizationCodesStats = await backfillCollection(
	'authorizationCodes',
	AuthorizationCodes as unknown as FirebaseFirestore.CollectionReference,
);

console.log({
	dryRun,
	accessTokens: accessTokensStats,
	refreshTokens: refreshTokensStats,
	authorizationCodes: authorizationCodesStats,
});
