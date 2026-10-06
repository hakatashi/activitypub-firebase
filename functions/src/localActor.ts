import { domain, mastodonDomain } from './firebase.js';
import { routes } from './routes.js';

// 単一ユーザー運用 (AGENTS.md, ADR-0005) のローカルアクター設定。
export const LOCAL_USERNAME = 'hakatashi';
export const LOCAL_DISPLAY_NAME = 'hakatashi';
export const LOCAL_SUMMARY = '博多市です。';
export const LOCAL_ICON_URL =
	'https://raw.githubusercontent.com/hakatashi/icon/master/images/icon_480px.png';
export const LOCAL_ADMIN_EMAIL = 'hakatasiloving@gmail.com';

export const localAccountUrl = `https://elk.zone/${mastodonDomain}/@${LOCAL_USERNAME}@${domain}`;

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

export const localActorId = localActorIri();
export const localFollowersId = localFollowersIri();
export const localFollowingId = localFollowingIri();
