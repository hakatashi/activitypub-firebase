import type { Request, Response } from 'express';
import type { SaveActivityStatus } from '../store/interface.js';
import type { Apex, ApexEvents, APObject } from '../types.js';

export type PostWorkTask = (res: Response) => unknown;

// apex のミドルウェア間で受け渡す、リクエストごとの状態 (res.locals.apex)
export interface ApexLocals {
	eventName: keyof ApexEvents | null;
	eventMessage: ApexEvents[keyof ApexEvents] | Record<string, never>;
	postWork: PostWorkTask[];
	// ルートが指す自サーバーのオブジェクト (actor / object / activity)
	target?: APObject | null | undefined;
	// 受信した activity の actor (署名者と一致した場合のみ)
	actor?: APObject | undefined;
	// HTTP 署名の署名者
	sender?: APObject | undefined;
	// activity が参照する object。outbox の Block は解決できなければ IRI のまま持つ
	object?: APObject | string | undefined;
	result?: APObject | undefined;
	// activity の検証が通ったか
	activity?: boolean | undefined;
	linked?: APObject[] | undefined;
	isNewActivity?: SaveActivityStatus | undefined;
	authorized?: boolean | undefined;
	authorizedUserId?: string | undefined;
	responseType?: string | undefined;
	status?: number | undefined;
	statusMessage?: string | undefined;
	createdLocation?: string | undefined;
	doNotPublish?: boolean | undefined;
}

// Express の locals は Record<string, any> なので、ここで型を与える
export const getApex = (req: Request): Apex => req.app.locals.apex;

export const getLocals = (res: Response): ApexLocals => res.locals.apex;

// Express 5 の型では req.params の値が string | string[] になる (配列はワイルドカードのみ)。
// apex のルートは名前付きパラメーターだけなので、文字列以外は無いものとして扱う。
export const getRouteParam = (req: Request, name: string): string | undefined => {
	const value = req.params[name];
	return typeof value === 'string' ? value : undefined;
};
