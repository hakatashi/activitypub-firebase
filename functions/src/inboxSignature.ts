import type { NextFunction, Request, RequestHandler, Response } from 'express';

// apex (activitypub-express) が署名検証に使う http-signature は draft-cavage 専用のフォークで、
// パラメータは必ず `name="value"` の形式 (ダブルクォート必須) を取る。RFC 9421 (HTTP Message
// Signatures) の構造化フィールド形式 (例: `Signature: sig1=:<base64>:`) を渡すと
// parseRequest が例外を投げ、apex 本体の net/security.js verifySignature はそれを catch して
// 区別なく 500 を返してしまう。500 は「一時的な障害」と解釈されるため、送信側はいつまでも
// 同じアクティビティを再送し続ける。
//
// mastodon-test.hakatashi.com からの Like/Announce の配送で実際に確認した
// (draft-cavage 版は 200 で成功する一方、RFC 9421 版が延々と 500 で再送され続けていた)。
// draft-cavage 形式の気配が一切ない場合は apex 本体を呼ぶ前に打ち切る。ステータスは
// apex 自身が「署名が検証に失敗した」場合に返す 403 に揃える(401 は apex の慣習では
// 「署名が全く無い」場合専用。加えて Mastodon 側の再送打ち切り判定
// (response_error_unsalvageable?, app/helpers/json_ld_helper.rb)は 401/408/429 を
// 「再送する価値があるかもしれない」として除外しているため、401 のままでは
// 実際には再送が止まらない。403 なら送信側に「これは恒久的に失敗する」と正しく伝わる
// → ADR-0036)。
const CAVAGE_LIKE_PATTERN = /(?<separator>^|,)\s*[A-Za-z]+="/;

export const rejectUnsupportedSignatureFormat: RequestHandler = (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	const header = req.get('signature') ?? req.get('authorization');
	if (header !== undefined && !CAVAGE_LIKE_PATTERN.test(header)) {
		res.status(403).send('Unsupported signature format');
		return;
	}
	next();
};
