import type { APActor } from 'activitypub-types';
import express from 'express';
import { apex } from '../apex.js';
import { domain, mastodonDomain } from '../firebase.js';
import {
	LOCAL_USERNAME,
	localAccountUrl,
	localActorId,
	localFollowersId,
	localProfilePageUrl,
	localStatusPageUrl,
} from '../localActor.js';
import { getIriByMastodonId, isMastodonId } from '../mastodonId.js';
import { htmlToPlainText } from '../notes.js';
import { firstOf, getImageUrl, isAPActor, isAPNote, toIdArray, toStringValue } from '../utils.js';
import {
	PUBLIC_PAGE_CSP,
	renderProfilePage,
	renderStatusPage,
	toSafeHttpUrl,
} from './publicPageHtml.js';
import type { PageAuthor } from './publicPageHtml.js';
import { noteToLanguage, noteToMediaAttachments, noteToVisibility } from './statusAttributes.js';

// リンクプレビュー用に、ローカル actor の投稿とプロフィールの最小限の HTML を返す (→ ADR-0107)。
// Elk はクローラーからのアクセスをこのパスへ 301 する。
const router = express.Router();

const localAcct = `${LOCAL_USERNAME}@${domain}`;

// `hakatashi` と `hakatashi@<AP ドメイン>` の両方を受け付ける (Elk はドメインが違うと後者を使う)。
const isLocalAcct = (acct: string) => {
	const lower = acct.toLowerCase();
	return lower === LOCAL_USERNAME || lower === localAcct;
};

const sendNotFound = (res: express.Response) => {
	res
		.status(404)
		.set('Cache-Control', 'no-store')
		.type('text/plain; charset=utf-8')
		.send('Not Found');
};

const sendHtml = (res: express.Response, html: string) => {
	res
		.status(200)
		.set({
			'Cache-Control': 'public, max-age=60, s-maxage=300',
			'Content-Security-Policy': PUBLIC_PAGE_CSP,
			'X-Content-Type-Options': 'nosniff',
			'Referrer-Policy': 'strict-origin-when-cross-origin',
		})
		.type('text/html; charset=utf-8')
		.send(html);
};

const loadLocalActor = async (): Promise<APActor | undefined> => {
	const actor = await apex.store.getObject(localActorId);
	return isAPActor(actor) ? actor : undefined;
};

const toAuthor = (actor: APActor): PageAuthor => ({
	displayName: toStringValue(actor.name) || LOCAL_USERNAME,
	acct: localAcct,
	avatarUrl: toSafeHttpUrl(getImageUrl(firstOf(actor.icon))),
	profileUrl: localProfilePageUrl,
});

const siteName = mastodonDomain;

router.get('/@:acct/:id', async (req, res) => {
	const { acct, id } = req.params;
	if (!isLocalAcct(acct) || !isMastodonId(id)) {
		sendNotFound(res);
		return;
	}
	const iri = await getIriByMastodonId(id);
	const note = iri === undefined ? undefined : await apex.store.getObject(iri);
	// 他人の投稿・Tombstone・ブースト・private / direct は区別せず 404 にし、存在を明かさない。
	if (
		!isAPNote(note) ||
		note.id === undefined ||
		toIdArray(note.attributedTo)[0] !== localActorId ||
		!['public', 'unlisted'].includes(noteToVisibility(note, localFollowersId))
	) {
		sendNotFound(res);
		return;
	}
	const actor = await loadLocalActor();
	if (actor === undefined) {
		sendNotFound(res);
		return;
	}

	const contentHtml = toStringValue(note.content) ?? '';
	const attachments = noteToMediaAttachments(note, id, { isLocal: true });
	const published = note.published;
	sendHtml(
		res,
		renderStatusPage({
			siteName,
			author: toAuthor(actor),
			url: localStatusPageUrl(id),
			activityPubIri: note.id,
			elkUrl: `${localAccountUrl}/${id}`,
			published:
				published instanceof Date
					? published.toISOString()
					: String(toStringValue(published) ?? ''),
			lang: noteToLanguage(note),
			contentHtml,
			contentText: htmlToPlainText(contentHtml),
			spoilerText: toStringValue(note.summary) ?? '',
			sensitive: (note as { sensitive?: unknown }).sensitive === true,
			images: attachments.flatMap((attachment) => {
				const url =
					attachment.type === 'image' ? toSafeHttpUrl(attachment.url ?? undefined) : undefined;
				return url === undefined
					? []
					: [
							{
								url,
								alt: attachment.description ?? undefined,
								width: attachment.meta?.original?.width,
								height: attachment.meta?.original?.height,
							},
						];
			}),
			attachmentCount: attachments.length,
		}),
	);
});

router.get('/@:acct', async (req, res) => {
	if (!isLocalAcct(req.params.acct)) {
		sendNotFound(res);
		return;
	}
	const actor = await loadLocalActor();
	if (actor === undefined) {
		sendNotFound(res);
		return;
	}
	const summaryHtml = toStringValue(actor.summary) ?? '';
	sendHtml(
		res,
		renderProfilePage({
			siteName,
			author: toAuthor(actor),
			activityPubIri: localActorId,
			elkUrl: localAccountUrl,
			summaryHtml,
			summaryText: htmlToPlainText(summaryHtml),
		}),
	);
});

export default router;
