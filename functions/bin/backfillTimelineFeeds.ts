import { rebuildTimelineFeeds } from '../src/projections/timelineFeeds.js';

// ホーム・リストのタイムラインの射影 (`userInfos/{actor}/homeFeed`、`.../lists/{リスト ID}/feed`) を、
// Note / Announce から組み立て直し、射影から読むためのマーカーを書くバックフィル (→ ADR-0136)。
// 何度実行してもよい。`--dry-run` で書き込まずに差分だけ出す。
// 射影から読むのをやめるには `userInfos/{actor}/projectionVersions/timelineFeeds` を消す。

const dryRun = process.argv.includes('--dry-run');

const stats = await rebuildTimelineFeeds({ dryRun });
console.log({ dryRun, ...stats });
