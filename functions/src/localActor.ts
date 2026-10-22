import { domain, instanceConfig, mastodonDomain } from './firebase.js';
import { routes } from './routes.js';

// インスタンスの主 actor の設定 (ADR-0005, ADR-0078)。値はプロジェクトごとに決まる (→ ADR-0148)。
export const LOCAL_USERNAME = instanceConfig.primaryActor.username;
export const LOCAL_DISPLAY_NAME = instanceConfig.primaryActor.displayName;
export const LOCAL_SUMMARY = instanceConfig.primaryActor.summary;
export const LOCAL_ICON_URL = instanceConfig.primaryActor.iconUrl;
export const LOCAL_ACTOR_TYPE = instanceConfig.primaryActor.type;
export const LOCAL_LOGIN_EMAIL = instanceConfig.primaryActor.loginEmail;
export const LOCAL_ADMIN_EMAIL = instanceConfig.contactEmail;

export const localAccountUrlOf = (username: string) =>
	`https://elk.zone/${mastodonDomain}/@${username}@${domain}`;
export const localAccountUrl = localAccountUrlOf(LOCAL_USERNAME);

// リンクプレビュー用の HTML を返す、Mastodon と同じ形の URL (→ ADR-0107)。
export const localProfilePageUrlOf = (username: string) => `https://${mastodonDomain}/@${username}`;
export const localProfilePageUrl = localProfilePageUrlOf(LOCAL_USERNAME);
export const localStatusPageUrl = (mastodonId: string, username: string = LOCAL_USERNAME) =>
	`${localProfilePageUrlOf(username)}/${mastodonId}`;

export const localActorIri = (
	username: string = LOCAL_USERNAME,
	customDomain: string = domain,
): string => `https://${customDomain}${routes.actor.replace(':actor', username)}`;

export const localFollowersIri = (
	username: string = LOCAL_USERNAME,
	customDomain: string = domain,
): string => `https://${customDomain}${routes.followers.replace(':actor', username)}`;

export const localFollowingIri = (
	username: string = LOCAL_USERNAME,
	customDomain: string = domain,
): string => `https://${customDomain}${routes.following.replace(':actor', username)}`;

export const localInboxIri = (
	username: string = LOCAL_USERNAME,
	customDomain: string = domain,
): string => `https://${customDomain}${routes.inbox.replace(':actor', username)}`;

export const localOutboxIri = (
	username: string = LOCAL_USERNAME,
	customDomain: string = domain,
): string => `https://${customDomain}${routes.outbox.replace(':actor', username)}`;

// 自分発の Follow が相手に Reject されたとき、apex はこのコレクションに入れる。
export const localRejectionsIri = (
	username: string = LOCAL_USERNAME,
	customDomain: string = domain,
): string => `https://${customDomain}${routes.rejections.replace(':actor', username)}`;

export const localActorId = localActorIri();
export const localFollowersId = localFollowersIri();
export const localFollowingId = localFollowingIri();
export const localInboxId = localInboxIri();
export const localOutboxId = localOutboxIri();
export const localRejectionsId = localRejectionsIri();

const localActorIriPrefix = `https://${domain}${routes.actor.replace(':actor', '')}`;

// IRI がこのインスタンスのローカル actor (主 actor またはボット) のものか (→ ADR-0149)。読み取りはしない。
export const isLocalActorIri = (iri: string | undefined): iri is string =>
	iri !== undefined &&
	iri.startsWith(localActorIriPrefix) &&
	/^[^/#?]+$/u.test(iri.slice(localActorIriPrefix.length));

// ローカル actor の IRI から username を取り出す。ローカルでなければ undefined。
export const localUsernameOf = (iri: string | undefined): string | undefined =>
	isLocalActorIri(iri) ? iri.slice(localActorIriPrefix.length) : undefined;
