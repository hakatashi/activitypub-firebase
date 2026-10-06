import { rebuildReactionProjection } from '../src/projections/reactions.js';

// お気に入り・ブーストの射影 (`userInfos/{actor}/favourites|reblogs`) を、streams のローカル actor の
// Like / Announce から組み立て直すバックフィル (→ ADR-0084)。何度実行してもよい。
// `--dry-run` で書き込まずに差分だけ出す。

const dryRun = process.argv.includes('--dry-run');

const stats = await rebuildReactionProjection({ dryRun });
console.log({ dryRun, ...stats });
