import { localActorId } from '../src/localActor.js';
import { backfillBookmarkCursors } from '../src/social/bookmarks.js';

// ブックマーク (`userInfos/{actor}/bookmarks`) に、一覧のカーソル `cursorId` を `createdAt` から入れる
// バックフィル (→ ADR-0099)。入っているものは書き換えないので、何度実行してもよい。
// `--dry-run` で書き込まずに件数だけ出す。

const dryRun = process.argv.includes('--dry-run');

const stats = await backfillBookmarkCursors(localActorId, { dryRun });
console.log({ dryRun, ...stats });
