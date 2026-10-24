import assert from 'node:assert';
import { parseArgs } from 'node:util';
import { LOCAL_USERNAME, localActorIri } from '../src/localActor.js';
import { rotateActorKey } from '../src/actorKey.js';

// ADR-0009: 鍵をローテーションする管理スクリプト。
// ADR-0161: 鍵ローテーション時に keyId も世代番号で更新し、リモートの公開鍵キャッシュに古い鍵を使わせない。
//
// ts-node / tsx 等で手動実行する。実行対象プロジェクトは firebase-admin の Application Default
// Credentials(GOOGLE_APPLICATION_CREDENTIALS または `firebase use` の対象)で決まる。
//
// `../src/firebase.js` の `domain` はローカル実行時(Cloud Functions 環境外)には
// `getInstallations().app.options.projectId` が undefined になり、常に dev ドメインへ
// フォールバックしてしまう。実行対象を誤らないよう、ここでは GCLOUD_PROJECT を直接見る。
const projectId = process.env.GCLOUD_PROJECT;
assert(
	projectId === 'activitypub-firebase' || projectId === 'activitypub-firebase-dev',
	`GCLOUD_PROJECT must be set to activitypub-firebase or activitypub-firebase-dev, got: ${projectId}`,
);
const domain =
	projectId === 'activitypub-firebase' ? 'hakatashi.com' : 'activitypub-dev.hakatashi.com';

const { values } = parseArgs({
	options: {
		username: { type: 'string' },
		keyId: { type: 'string' },
		dryRun: { type: 'boolean' },
	},
	strict: false,
});

const username = typeof values.username === 'string' ? values.username : LOCAL_USERNAME;
const actorId = localActorIri(username, domain);
const customKeyId = typeof values.keyId === 'string' ? values.keyId : undefined;
const dryRun = values.dryRun === true;

const main = async () => {
	const result = await rotateActorKey({
		actorId,
		customKeyId,
		dryRun,
	});

	const prefix = dryRun ? '[DRY RUN] Would rotate' : 'Rotated';
	console.log(
		`${prefix} actor key for ${result.actorId}: ${String(result.oldKeyId)} -> ${result.newKeyId}`,
	);
};

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
