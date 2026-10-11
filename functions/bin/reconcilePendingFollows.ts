import { reconcilePendingFollows } from '../src/social/follows.js';

// inbox にあり followers に入っていない未承認 Follow を見つけて承認し直すスクリプト (→ ADR-0111)。
// 引っ越しの監視や、承認失敗した Follow の救済に使う。
// `--dry-run` を指定すると書き込まずに対象件数と一覧を出力する。

const dryRun = process.argv.includes('--dry-run');

const result = await reconcilePendingFollows({ dryRun });
console.log({ dryRun, ...result });
