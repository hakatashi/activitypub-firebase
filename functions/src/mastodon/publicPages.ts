import type { APActor } from 'activitypub-types';
import express from 'express';
import { apex } from '../apex.js';
import { domain, mastodonDomain } from '../firebase.js';
import {
	localAccountUrlOf,
	localActorIri,
	localFollowersIri,
	localProfilePageUrlOf,
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

// リンクプレビュー用に、ローカル actor (主 actor とボット) の投稿とプロフィールの最小限の HTML を返す
// (→ ADR-0107, ADR-0149)。Elk はクローラーからのアクセスをこのパスへ 301 する。
const router = express.Router();

// `name` と `name@<AP ドメイン>` の両方を受け付ける (Elk はドメインが違うと後者を使う)。
// ローカルの acct でなければ undefined。
const parseLocalAcct = (acct: string): string | undefined => {
	const [username, host, ...rest] = acct.toLowerCase().split('@');
	if (username === undefined || rest.length > 0 || (host !== undefined && host !== domain)) {
		return undefined;
	}
	return /^[a-z0-9_]+$/u.test(username) ? username : undefined;
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

const loadLocalActor = async (username: string): Promise<APActor | undefined> => {
	const actor = await apex.store.getObject(localActorIri(username));
	return isAPActor(actor) ? actor : undefined;
};

const toAuthor = (actor: APActor, username: string): PageAuthor => ({
	displayName: toStringValue(actor.name) || username,
	acct: `${username}@${domain}`,
	avatarUrl: toSafeHttpUrl(getImageUrl(firstOf(actor.icon))),
	profileUrl: localProfilePageUrlOf(username),
});

const siteName = mastodonDomain;

router.get('/@:acct/:id', async (req, res) => {
	const { acct, id } = req.params;
	const username = parseLocalAcct(acct);
	if (username === undefined || !isMastodonId(id)) {
		sendNotFound(res);
		return;
	}
	const iri = await getIriByMastodonId(id);
	const note = iri === undefined ? undefined : await apex.store.getObject(iri);
	// 他人の投稿・Tombstone・ブースト・private / direct は区別せず 404 にし、存在を明かさない。
	if (
		!isAPNote(note) ||
		note.id === undefined ||
		toIdArray(note.attributedTo)[0] !== localActorIri(username) ||
		!['public', 'unlisted'].includes(noteToVisibility(note, localFollowersIri(username)))
	) {
		sendNotFound(res);
		return;
	}
	const actor = await loadLocalActor(username);
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
			author: toAuthor(actor, username),
			url: localStatusPageUrl(id, username),
			activityPubIri: note.id,
			elkUrl: `${localAccountUrlOf(username)}/${id}`,
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
	const username = parseLocalAcct(req.params.acct);
	if (username === undefined) {
		sendNotFound(res);
		return;
	}
	const actor = await loadLocalActor(username);
	if (actor === undefined) {
		sendNotFound(res);
		return;
	}
	const summaryHtml = toStringValue(actor.summary) ?? '';
	sendHtml(
		res,
		renderProfilePage({
			siteName,
			author: toAuthor(actor, username),
			activityPubIri: localActorIri(username),
			elkUrl: localAccountUrlOf(username),
			summaryHtml,
			summaryText: htmlToPlainText(summaryHtml),
		}),
	);
});

export default router;
