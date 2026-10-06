import { rebuildFollowProjection } from '../src/projections/follows.js';

// フォロー関係の射影 (`userInfos/{actor}/followers|following`) とカウンタを、streams の Follow から
// 組み立て直すバックフィル (→ ADR-0082)。何度実行してもよい。`--dry-run` で書き込まずに差分だけ出す。

const dryRun = process.argv.includes('--dry-run');

const stats = await rebuildFollowProjection({ dryRun });
console.log({ dryRun, ...stats });
