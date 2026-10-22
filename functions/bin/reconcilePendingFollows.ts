import { localActorIri } from '../src/localActor.js';
import { reconcilePendingFollows } from '../src/social/follows.js';

// inbox にあり followers に入っていない未承認 Follow を見つけて承認し直すスクリプト (→ ADR-0111)。
// 引っ越しの監視や、承認失敗した Follow の救済に使う。
// `--dry-run` を指定すると書き込まずに対象件数と一覧を出力する。
// `--actor <username>` でボットなど主 actor 以外を対象にする (→ ADR-0150)。

const dryRun = process.argv.includes('--dry-run');
const actorIndex = process.argv.indexOf('--actor');
const username = actorIndex === -1 ? undefined : process.argv[actorIndex + 1];
const actorId = username === undefined ? undefined : localActorIri(username);

const result = await reconcilePendingFollows({ dryRun, ...(actorId && { actorId }) });
console.log({ dryRun, actorId, ...result });
