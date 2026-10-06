import type { UserInfo } from '../../schema.js';

export interface ValidatedData {
	params?: unknown;
	query?: unknown;
	body?: unknown;
}

export interface MastodonLocals {
	auth?: UserInfo | undefined;
	actorId?: string | undefined;
	scope?: string | string[] | undefined;
	valid?: ValidatedData | undefined;
}

declare global {
	namespace Express {
		interface Locals {
			auth?: UserInfo | undefined;
			actorId?: string | undefined;
			scope?: string | string[] | undefined;
			valid?: ValidatedData | undefined;
		}
	}
}
