// Firebase プロジェクトごとのインスタンス設定 (→ ADR-0148)。
// 副作用を持たせず、firebase.ts より前に読み込めるようにする。

export interface PrimaryActorConfig {
	username: string;
	displayName: string;
	summary: string;
	iconUrl: string;
	type: 'Person' | 'Application';
	// Google ログインで Mastodon API を使える唯一のメールアドレス。null なら誰もログインできない。
	loginEmail: string | null;
}

export interface BotsConfig {
	// ボット actor の作成と、オペレータートークンによる操作を許すか (→ ADR-0149, ADR-0151)。
	enabled: boolean;
	// 作成したボットのフォローを自動承認する actor の IRI の既定値 (→ ADR-0150)。
	defaultFollowAllowlist: string[];
}

export interface InstanceConfig {
	// ActivityPub (WebFinger) のドメイン。
	domain: string;
	// Mastodon API のドメイン。ActivityPub と同じでもよい。
	mastodonDomain: string;
	primaryActor: PrimaryActorConfig;
	// インスタンス情報の連絡先。
	contactEmail: string;
	bots: BotsConfig;
}

const ADMIN_EMAIL = 'hakatasiloving@gmail.com';

const hakatashiActor: PrimaryActorConfig = {
	username: 'hakatashi',
	displayName: 'hakatashi',
	summary: '博多市です。',
	iconUrl: 'https://raw.githubusercontent.com/hakatashi/icon/master/images/icon_480px.png',
	type: 'Person',
	loginEmail: ADMIN_EMAIL,
};

const PRODUCTION_HAKATASHI = 'https://hakatashi.com/activitypub/u/hakatashi';
const DEV_HAKATASHI = 'https://activitypub-dev.hakatashi.com/activitypub/u/hakatashi';

export const PRODUCTION_PROJECT_ID = 'activitypub-firebase';
export const DEV_PROJECT_ID = 'activitypub-firebase-dev';
export const BOTS_PROJECT_ID = 'activitypub-firebase-bots';

const devConfig: InstanceConfig = {
	domain: 'activitypub-dev.hakatashi.com',
	mastodonDomain: 'mastodon-dev.hakatashi.com',
	primaryActor: hakatashiActor,
	contactEmail: ADMIN_EMAIL,
	bots: { enabled: true, defaultFollowAllowlist: [DEV_HAKATASHI] },
};

const instanceConfigs: Record<string, InstanceConfig> = {
	[PRODUCTION_PROJECT_ID]: {
		domain: 'hakatashi.com',
		mastodonDomain: 'mastodon.hakatashi.com',
		primaryActor: hakatashiActor,
		contactEmail: ADMIN_EMAIL,
		bots: { enabled: false, defaultFollowAllowlist: [] },
	},
	[DEV_PROJECT_ID]: devConfig,
	[BOTS_PROJECT_ID]: {
		domain: 'bots.activitypub.hakatashi.com',
		mastodonDomain: 'bots.activitypub.hakatashi.com',
		// 人が使うアカウントは置かない。GET の署名やインスタンスの連絡先に使うインスタンス actor。
		primaryActor: {
			username: 'instance',
			displayName: 'hakatashi bots',
			summary: 'hakatashi の個人用ボットのインスタンスです。',
			iconUrl: hakatashiActor.iconUrl,
			type: 'Application',
			loginEmail: null,
		},
		contactEmail: ADMIN_EMAIL,
		bots: { enabled: true, defaultFollowAllowlist: [PRODUCTION_HAKATASHI, DEV_HAKATASHI] },
	},
};

// 対応表にない projectId (テストのワーカーごとの activitypub-firebase-dev-wN など) は dev とみなす。
export const resolveInstanceConfig = (projectId: string | undefined): InstanceConfig =>
	(projectId === undefined ? undefined : instanceConfigs[projectId]) ?? devConfig;
