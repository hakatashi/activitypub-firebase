import type { MediaAttachmentRecord } from '../../schema.js';
import type { MediaAttachmentEntity } from '../statusAttributes.js';

// MediaAttachmentRecord を Mastodon API のエンティティに変換する (→ ADR-0091)。
export const toMediaAttachmentEntity = (record: MediaAttachmentRecord): MediaAttachmentEntity => ({
	id: record.id,
	type: record.type,
	url: record.url,
	preview_url: record.previewUrl,
	remote_url: record.remoteUrl,
	preview_remote_url: null,
	text_url: record.textUrl,
	meta: record.meta,
	description: record.description,
	blurhash: record.blurhash,
});
