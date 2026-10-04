import { request } from 'undici';
import { apex } from './apex.js';
import { assertSafeUrl, makePinnedAgent, maxRedirects, readBodyWithLimit } from './apex/index.js';
import { domain, mastodonDomain } from './firebase.js';
import type { ExtractedMention, ResolvedMention } from './mastodon/statusContent.js';
import { isAPActor } from './utils.js';

export interface WebfingerLink {
	rel?: unknown;
	type?: unknown;
	href?: unknown;
}

export interface WebfingerJrd {
	subject?: unknown;
	links?: unknown;
}

// SSRF セーフに WebFinger リクエストを行い、ActivityPub actor の IRI を解決する。
export const fetchWebfinger = async (
	username: string,
	host: string,
): Promise<string | undefined> => {
	const isLocalDev = process.env.FUNCTIONS_EMULATOR === 'true' || process.env.NODE_ENV === 'test';
	const isLocalHost = host.startsWith('localhost') || host.startsWith('127.0.0.1');
	const protocol = (isLocalDev && isLocalHost) || host.startsWith('http://') ? 'http:' : 'https:';
	const cleanHost = host.replace(/^https?:\/\//, '');

	const targetUrl = `${protocol}//${cleanHost}/.well-known/webfinger?resource=acct:${encodeURIComponent(username)}@${cleanHost}`;

	const guardOptions = {
		policy: apex.settings?.remoteFetchPolicy,
		logger: apex.logger,
	};

	try {
		let { url, addresses } = await assertSafeUrl(targetUrl, guardOptions);

		for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
			const agent = makePinnedAgent(addresses);
			try {
				const response = await request(url, {
					method: 'GET',
					headers: {
						Accept: 'application/jrd+json, application/json',
						'User-Agent': apex.makeUserAgentString(),
					},
					headersTimeout: apex.requestTimeout,
					bodyTimeout: apex.requestTimeout,
					dispatcher: agent,
				});

				if (response.statusCode >= 300 && response.statusCode < 400) {
					const { location } = response.headers;
					await response.body.dump();
					if (typeof location !== 'string' || !location) {
						apex.logger.warn({ type: 'webfingerRedirectMissingLocation', url: url.toString() });
						return undefined;
					}
					({ url, addresses } = await assertSafeUrl(
						new URL(location, url).toString(),
						guardOptions,
					));
					continue;
				}

				if (response.statusCode < 200 || response.statusCode >= 300) {
					await response.body.dump();
					apex.logger.warn({
						type: 'webfingerErrorResponse',
						url: url.toString(),
						statusCode: response.statusCode,
					});
					return undefined;
				}

				const body = await readBodyWithLimit(response.body, response.headers, 1024 * 1024);
				const data = JSON.parse(body) as WebfingerJrd;
				const links = Array.isArray(data.links) ? (data.links as WebfingerLink[]) : [];

				const selfLink = links.find((link) => {
					if (link.rel !== 'self' || typeof link.href !== 'string') {
						return false;
					}
					return (
						link.type === 'application/activity+json' ||
						link.type === 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"'
					);
				});

				return typeof selfLink?.href === 'string' ? selfLink.href : undefined;
			} finally {
				await agent.close();
			}
		}

		apex.logger.warn({ type: 'webfingerTooManyRedirects', url: targetUrl });
		return undefined;
	} catch (error) {
		apex.logger.warn({
			type: 'webfingerResolutionFailed',
			username,
			host,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
};

// メンションから actor を解決する (ローカル actor は DB 直引き、リモートは WebFinger + resolveObject)。
export const resolveActorByMention = async (
	username: string,
	host: string | undefined,
): Promise<ResolvedMention | undefined> => {
	const isLocal =
		host === undefined ||
		host.toLowerCase() === domain.toLowerCase() ||
		host.toLowerCase() === mastodonDomain.toLowerCase();

	if (isLocal) {
		const actorIri = apex.utils.usernameToIRI(username.toLowerCase());
		const actor = await apex.store.getObject(actorIri);
		if (actor !== undefined && isAPActor(actor)) {
			const actorUrl = typeof actor.url === 'string' ? actor.url : actor.id;
			return {
				actorIri: actor.id,
				url: actorUrl,
				username,
				domain: undefined,
			};
		}
		return undefined;
	}

	try {
		const actorIri = await fetchWebfinger(username, host);
		if (actorIri === undefined) {
			return undefined;
		}

		const actor = await apex.resolveObject(actorIri);
		if (actor !== undefined && isAPActor(actor)) {
			const actorUrl = typeof actor.url === 'string' ? actor.url : actor.id;
			return {
				actorIri: actor.id,
				url: actorUrl,
				username,
				domain: host,
			};
		}
		return undefined;
	} catch (error) {
		apex.logger.warn({
			type: 'resolveActorByMentionFailed',
			username,
			host,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
};

export const resolveMentions = async (
	mentions: ExtractedMention[],
): Promise<Map<string, ResolvedMention>> => {
	const result = new Map<string, ResolvedMention>();
	const uniqueKeys = new Map<string, ExtractedMention>();

	for (const mention of mentions) {
		const key = mention.raw.toLowerCase();
		if (!uniqueKeys.has(key)) {
			uniqueKeys.set(key, mention);
		}
	}

	const resolvedEntries = await Promise.all(
		[...uniqueKeys.entries()].map(async ([key, mention]) => {
			const resolved = await resolveActorByMention(mention.username, mention.domain);
			return [key, resolved] as const;
		}),
	);

	for (const [key, resolved] of resolvedEntries) {
		if (resolved !== undefined) {
			result.set(key, resolved);
		}
	}

	return result;
};
