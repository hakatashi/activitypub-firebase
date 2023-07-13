const instance = {
	uri: 'hakatashi.com',
	title: 'HakataFediverse',
	short_description: 'ActivityPub implementation for hakatashi',
	description: '',
	email: 'admin@hakatashi.com',
	version: '4.0.0',
	urls: {
	},
	stats: {
		user_count: 0,
		status_count: 0,
		domain_count: 0,
	},
	thumbnail: 'https://files.mastodon.social/site_uploads/files/000/000/001/@1x/57c12f441d083cde.png',
	languages: [
		'ja',
	],
	registrations: false,
	approval_required: true,
	invites_enabled: true,
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
	},
	contact_account: {
		id: '1',
		username: 'hakatashi',
		acct: 'hakatashi',
		display_name: 'hakatashi',
		locked: false,
		bot: false,
		discoverable: true,
		group: false,
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
	},
	rules: [
		{
			id: '1',
			text: 'Do anything.',
		},
	],
};

export default instance;
