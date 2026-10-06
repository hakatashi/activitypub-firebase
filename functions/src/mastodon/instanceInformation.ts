import type { mastodon } from 'masto';
import { escapeFirestoreKey, mastodonDomain } from '../firebase.js';
import {
	LOCAL_ADMIN_EMAIL,
	LOCAL_DISPLAY_NAME,
	LOCAL_ICON_URL,
	LOCAL_SUMMARY,
	LOCAL_USERNAME,
	localAccountUrl,
	localActorId,
} from '../localActor.js';
import { UserInfos } from '../schema.js';
import type { CamelToSnake } from '../utils.js';

import { IMAGE_MATRIX_LIMIT, IMAGE_SIZE_LIMIT, SUPPORTED_MIME_TYPES } from './mediaProcessing.js';

export type ExtendedInstanceV2 = Omit<CamelToSnake<mastodon.v2.Instance>, 'configuration'> & {
	api_versions: {
		mastodon: number;
		[key: string]: number | undefined;
	};
	configuration: Omit<CamelToSnake<mastodon.v2.Instance>['configuration'], 'urls'> & {
		urls: {
			streaming: string;
			status?: string;
			about?: string;
			privacy_policy?: string;
			terms_of_service?: string | null;
		};
	};
};

const instanceV2: ExtendedInstanceV2 = {
	domain: mastodonDomain,
	title: 'HakataFediverse',
	description: 'HakataFediverse is the only instance created for hakatashi',
	version: '4.3.0',
	source_url: 'https://github.com/hakatashi/activitypub-firebase',
	api_versions: {
		mastodon: 1,
	},
	thumbnail: {
		url: LOCAL_ICON_URL,
		blurhash: '',
		versions: {
			'@1x': LOCAL_ICON_URL,
			'@2x': LOCAL_ICON_URL,
		},
	},
	languages: ['ja'],
	registrations: {
		enabled: false,
		approval_required: false,
		message: null,
	},
	configuration: {
		statuses: {
			max_characters: 500,
			max_media_attachments: 0,
			characters_reserved_per_url: 23,
		},
		media_attachments: {
			supported_mime_types: [...SUPPORTED_MIME_TYPES],
			image_size_limit: IMAGE_SIZE_LIMIT,
			image_matrix_limit: IMAGE_MATRIX_LIMIT,
			video_size_limit: 0,
			video_frame_rate_limit: 0,
			video_matrix_limit: 0,
		},
		polls: {
			max_options: 0,
			max_characters_per_option: 0,
			min_expiration: 0,
			max_expiration: 0,
		},
		urls: {
			streaming: '',
		},
		accounts: {
			max_featured_tags: 0,
		},
		translation: {
			enabled: false,
		},
	},
	contact: {
		email: LOCAL_ADMIN_EMAIL,
		account: {
			id: '1',
			username: LOCAL_USERNAME,
			acct: LOCAL_USERNAME,
			display_name: LOCAL_DISPLAY_NAME,
			locked: false,
			bot: false,
			discoverable: true,
			created_at: '2016-03-16T00:00:00.000Z',
			note: LOCAL_SUMMARY,
			url: localAccountUrl,
			avatar: LOCAL_ICON_URL,
			avatar_static: LOCAL_ICON_URL,
			header: LOCAL_ICON_URL,
			header_static: LOCAL_ICON_URL,
			followers_count: 0,
			following_count: 0,
			statuses_count: 0,
			last_status_at: '',
			emojis: [],
			fields: [],
			roles: [],
		},
	},
	rules: [
		{
			id: '1',
			text: 'Do anything.',
		},
	],
	usage: {
		users: {
			active_month: 1,
		},
	},
};

const instanceV1: CamelToSnake<mastodon.v1.Instance> = {
	uri: instanceV2.domain,
	title: instanceV2.title,
	short_description: instanceV2.description,
	description: instanceV2.description,
	email: instanceV2.contact.email,
	version: instanceV2.version,
	languages: instanceV2.languages,
	registrations: instanceV2.registrations.enabled,
	approval_required: instanceV2.registrations.approval_required,
	urls: {
		streaming_api: '',
	},
	stats: {
		user_count: instanceV2.usage.users.active_month,
		status_count: 0,
		domain_count: 1,
	},
	invites_enabled: instanceV2.registrations.enabled,
	configuration: {
		statuses: {
			max_characters: instanceV2.configuration.statuses.max_characters,
			max_media_attachments: instanceV2.configuration.statuses.max_media_attachments,
			characters_reserved_per_url: instanceV2.configuration.statuses.characters_reserved_per_url,
		},
		media_attachments: instanceV2.configuration.media_attachments,
		polls: instanceV2.configuration.polls,
		accounts: instanceV2.configuration.accounts,
	},
	contact_account: instanceV2.contact.account,
	rules: instanceV2.rules,
};

const getLocalUserInfo = async () => {
	try {
		const doc = await UserInfos.doc(escapeFirestoreKey(localActorId)).get();
		if (doc.exists) {
			return doc.data();
		}
	} catch {
		// Firestore に接続できない等の場合は無視
	}
	return undefined;
};

export const getInstanceV2 = async (): Promise<ExtendedInstanceV2> => {
	const userInfo = await getLocalUserInfo();
	if (!userInfo) {
		return instanceV2;
	}
	return {
		...instanceV2,
		contact: {
			...instanceV2.contact,
			account: {
				...instanceV2.contact.account,
				followers_count: userInfo.followers_count,
				following_count: userInfo.following_count,
				statuses_count: userInfo.statuses_count,
				last_status_at: userInfo.last_status_at,
			},
		},
	};
};

export const getInstanceV1 = async (): Promise<CamelToSnake<mastodon.v1.Instance>> => {
	const userInfo = await getLocalUserInfo();
	if (!userInfo) {
		return instanceV1;
	}
	const updatedAccount = {
		...instanceV2.contact.account,
		followers_count: userInfo.followers_count,
		following_count: userInfo.following_count,
		statuses_count: userInfo.statuses_count,
		last_status_at: userInfo.last_status_at,
	};
	return {
		...instanceV1,
		stats: {
			...instanceV1.stats,
			status_count: userInfo.statuses_count,
		},
		contact_account: updatedAccount,
	};
};

export { instanceV1, instanceV2 };
