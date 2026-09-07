import assert from 'node:assert';
import type { RequestHandler } from 'express';
import { apex } from './apex.js';
import { correctIsNewActivity, markRedundantInboxDelivery } from './inboxDedup.js';
import { verifySameOriginForUpdateDelete } from './inboxOriginCheck.js';
import { denormalizeUndoObject } from './inboxUndo.js';

const originalInboxPost = apex.net.inbox.post;
const inboxActivityIndex = originalInboxPost.indexOf(apex.net.validators.inboxActivity);
const saveIndex = originalInboxPost.indexOf(apex.net.activity.save);
assert(
	inboxActivityIndex !== -1,
	'apex.net.validators.inboxActivity not found in inbox post middleware chain',
);
assert(saveIndex !== -1, 'apex.net.activity.save not found in inbox post middleware chain');
assert(
	inboxActivityIndex + 1 === saveIndex,
	'unexpected middleware between inboxActivity and save in apex.net.inbox.post',
);

// apex.net.inbox.post の前半部分: validators.jsonld 〜 validators.inboxActivity
export const inboxValidationMiddlewares = originalInboxPost.slice(0, inboxActivityIndex + 1);

// apex.net.inbox.post の後半部分: activity.resolveThread 〜 responders.status
export const inboxExecutionMiddlewares = originalInboxPost.slice(saveIndex + 1);

// inbox post で実行される全ミドルウェアの配列を組み立てる。
// apex 本体のミドルウェア配列を変更せず、適切な位置にカスタムミドルウェアを挟む
// (→ ADR-0030, ADR-0031, ADR-0033)。
export const buildInboxPostMiddlewares = (): RequestHandler[] => [
	// 1. リクエスト検証・署名検証・アクター/オブジェクト解決 (apex)
	...inboxValidationMiddlewares,
	// 2. Update / Delete の同一オリジン検証 (ADR-0031)
	verifySameOriginForUpdateDelete,
	// 3. 重複配送検出 (ADR-0030)
	markRedundantInboxDelivery,
	// 4. Undo のオブジェクト解決埋め込み (ADR-0033)
	denormalizeUndoObject,
	// 5. アクティビティ保存 (apex)
	apex.net.activity.save,
	// 6. 重複配送時のフラグ補正 (ADR-0030)
	correctIsNewActivity,
	// 7. スレッド解決・Side effects・配送・レスポンス (apex)
	...inboxExecutionMiddlewares,
];
