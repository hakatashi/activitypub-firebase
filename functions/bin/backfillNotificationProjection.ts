import { rebuildNotificationProjection } from '../src/projections/notifications.js';

// 通知の射影 (`userInfos/{actor}/notifications`) を、streams のアクティビティから
// 組み立て直すバックフィル (→ ADR-0088)。何度実行してもよい。`--dry-run` で書き込まずに差分だけ出す。

const dryRun = process.argv.includes('--dry-run');

const stats = await rebuildNotificationProjection({ dryRun });
console.log({ dryRun, ...stats });
