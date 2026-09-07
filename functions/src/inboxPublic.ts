import type { APObject } from 'activitypub-express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ApexLocals } from './utils.js';

type InboxRequest = Request<Record<string, string>, unknown, APObject>;

const AUDIENCE_KEYS = ['to', 'cc', 'bto', 'bcc', 'audience'] as const;

const normalizeAddressValue = (value: unknown): unknown => {
	if (typeof value === 'string') {
		if (value === 'Public' || value === 'https://www.w3.org/ns/activitystreams#Public') {
			return 'as:Public';
		}
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(normalizeAddressValue);
	}
	return value;
};

export const normalizePublicAddresses = (target: unknown): void => {
	if (target === null || typeof target !== 'object') {
		return;
	}

	const record = target as Record<string, unknown>;

	for (const key of AUDIENCE_KEYS) {
		if (key in record && record[key] !== undefined) {
			record[key] = normalizeAddressValue(record[key]);
		}
	}

	if ('object' in record && record.object !== undefined) {
		if (Array.isArray(record.object)) {
			for (const item of record.object) {
				normalizePublicAddresses(item);
			}
		} else {
			normalizePublicAddresses(record.object);
		}
	}
};

// apex.net.inbox.post の検証後・保存前に挿入する。
// JSON-LD compact の結果によって公開宛先は "as:Public", "https://www.w3.org/ns/activitystreams#Public",
// "Public" の3通りで届きうるが、apex は publicAddress: 'as:Public' のみ認識するため、
// "Public" のままだと isPublic() が false になり公開フィルタで除外されてしまう。
// 受信したアクティビティと解決済みオブジェクトの audience フィールドに含まれる "Public" を
// "as:Public" に正規化する (→ ADR-0034)。
export const normalizeInboxPublic: RequestHandler = (
	req: InboxRequest,
	res: Response,
	next: NextFunction,
) => {
	if (req.body) {
		normalizePublicAddresses(req.body);
	}
	const apexLocals = res.locals.apex as ApexLocals | undefined;
	if (apexLocals?.object) {
		normalizePublicAddresses(apexLocals.object);
	}
	next();
};
