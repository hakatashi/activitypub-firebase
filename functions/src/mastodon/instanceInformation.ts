import type {mastodon} from 'masto';
import type {CamelToSnake} from '../utils.js';

const instanceV2: CamelToSnake<mastodon.v2.Instance> = {
	domain: 'hakatashi.com',
	title: 'HakataFediverse',
	description: 'HakataFediverse is the only instance created for hakatashi',
	version: '4.0.0',
	source_url: 'https://github.com/hakatashi/activitypub-firebase',
	thumbnail: {
		url: 'https://files.mastodon.social/site_uploads/files/000/000/001/@1x/57c12f441d083cde.png',
		blurhash: 'UeKUpFxuo~R%0nW;WCnhF6RjaJt757oJodS$',
		versions: {
			'@1x': 'https://files.mastodon.social/site_uploads/files/000/000/001/@1x/57c12f441d083cde.png',
			'@2x': 'https://files.mastodon.social/site_uploads/files/000/000/001/@2x/57c12f441d083cde.png',
		},
	},
	languages: [
		'ja',
	],
	registrations: {
		enabled: false,
		approval_required: false,
		message: null,
	},
	configuration: {
		statuses: {
			max_characters: 140,
			max_media_attachments: 0,
			characters_reserved_per_url: 23,
		},
		media_attachments: {
			supported_mime_types: [],
			image_size_limit: 0,
			image_matrix_limit: 0,
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
			streaming_api: '',
		},
		accounts: {
			max_featured_tags: 0,
		},
		translation: {
			enabled: false,
		},
	},
	contact: {
		email: 'hakatasiloving@gmail.com',
		account: {
			id: '1',
			username: 'hakatashi',
			acct: 'hakatashi',
			display_name: 'hakatashi',
			locked: false,
			bot: false,
			discoverable: true,
			created_at: '2016-03-16T00:00:00.000Z',
			note: '博多市です。',
			url: 'https://mastodon.social/@Gargron',
			avatar: 'https://raw.githubusercontent.com/hakatashi/icon/master/images/icon_480px.png',
			avatar_static: 'https://raw.githubusercontent.com/hakatashi/icon/master/images/icon_480px.png',
			header: 'https://raw.githubusercontent.com/hakatashi/icon/master/images/icon_480px.png',
			header_static: 'https://raw.githubusercontent.com/hakatashi/icon/master/images/icon_480px.png',
			followers_count: 1,
			following_count: 1,
			statuses_count: 0,
			last_status_at: '2022-08-24',
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
	urls: instanceV2.configuration.urls,
	stats: {
		user_count: instanceV2.usage.users.active_month,
		status_count: 0,
		domain_count: 0,
	},
	invites_enabled: instanceV2.registrations.enabled,
	configuration: {
		statuses: {
			max_characters: instanceV2.configuration.statuses.max_characters,
			max_media_attachments: instanceV2.configuration.statuses.max_media_attachments,
			characters_reserved_per_url: instanceV2.configuration.statuses.characters_reserved_per_url.toString(),
		},
		media_attachments: instanceV2.configuration.media_attachments,
		polls: instanceV2.configuration.polls,
		accounts: instanceV2.configuration.accounts,
	},
	contact_account: instanceV2.contact.account,
	rules: instanceV2.rules,
};


export {instanceV1, instanceV2};
