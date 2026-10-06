import type { APActor } from 'activitypub-types';
import type { APObject } from '../../src/apex/index.js';
import { apex } from '../../src/activitypub.js';
import { escapeFirestoreKey } from '../../src/firebase.js';
import { UserInfos } from '../../src/schema.js';
import type { UserInfo } from '../../src/schema.js';

// apex のオブジェクトであり、かつ Mastodon API 層が要求する APActor でもある (api.ts の assertIsAPActor と同じ形)
export type LocalActor = APObject & APActor;

export interface CreateLocalActorOptions {
	id?: string;
	uid?: string | null;
	displayName?: string;
	summary?: string;
	icon?: string;
	type?: string;
	save?: boolean;
	userInfo?: Partial<UserInfo>;
}

/**
 * テスト用のローカル actor を作成・保存し、UserInfos ドキュメントを投入する。
 */
export const createLocalActor = async (
	name: string,
	options: CreateLocalActorOptions = {},
): Promise<LocalActor> => {
	const displayName = options.displayName ?? name;
	const summary = options.summary ?? '';
	const icon = options.icon ?? '';
	const type = options.type ?? 'Person';

	const actor = (await apex.createActor(name, displayName, summary, icon, type)) as LocalActor;

	if (options.save !== false) {
		await apex.store.saveObject(actor);
	}

	const userInfoDoc: UserInfo = {
		id: options.id ?? '1',
		uid: options.uid === undefined ? `uid-${name}` : options.uid,
		locked: false,
		bot: false,
		created_at: '2026-01-01T00:00:00.000Z',
		followers_count: 0,
		following_count: 0,
		statuses_count: 0,
		last_status_at: '',
		emojis: [],
		fields: [],
		roles: [],
		...options.userInfo,
	};
	await UserInfos.doc(escapeFirestoreKey(actor.id as string)).set(userInfoDoc);

	return actor;
};
