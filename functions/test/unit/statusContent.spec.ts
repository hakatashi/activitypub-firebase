import { describe, expect, it } from 'vitest';
import {
	cleanUrl,
	extractEntities,
	extractHashtags,
	extractMentions,
	extractUrls,
	formatHashtag,
	formatMention,
	formatPostContent,
	formatShortenedUrl,
	textToParagraphs,
} from '../../src/mastodon/statusContent.js';

describe('statusContent unit tests', () => {
	describe('cleanUrl & extractUrls', () => {
		it('extracts standard http and https URLs', () => {
			const urls = extractUrls('Check https://example.com/foo and http://test.org/bar');
			expect(urls).toHaveLength(2);
			expect(urls[0]?.url).toBe('https://example.com/foo');
			expect(urls[1]?.url).toBe('http://test.org/bar');
		});

		it('strips trailing punctuation', () => {
			expect(cleanUrl('https://example.com!')?.cleanedUrl).toBe('https://example.com');
			expect(cleanUrl('https://example.com.')?.cleanedUrl).toBe('https://example.com');
			expect(cleanUrl('https://example.com,')?.cleanedUrl).toBe('https://example.com');
			expect(cleanUrl('https://example.com?')?.cleanedUrl).toBe('https://example.com');
			expect(cleanUrl("https://example.com'")?.cleanedUrl).toBe('https://example.com');
			expect(cleanUrl('https://example.com>')?.cleanedUrl).toBe('https://example.com');
		});

		it('handles balanced vs unbalanced parentheses', () => {
			// Unbalanced trailing parenthesis stripped
			expect(cleanUrl('https://example.com/)')?.cleanedUrl).toBe('https://example.com/');
			// Balanced parenthesis inside URL preserved
			expect(cleanUrl('https://en.wikipedia.org/wiki/Diaspora_(software)')?.cleanedUrl).toBe(
				'https://en.wikipedia.org/wiki/Diaspora_(software)',
			);
			// URL inside parentheses in text
			const urls = extractUrls('(https://google.com/)');
			expect(urls).toHaveLength(1);
			expect(urls[0]?.url).toBe('https://google.com/');
		});

		it('extracts unicode and IDN URLs', () => {
			const urls = extractUrls('See https://nic.みんな/ and https://ja.wikipedia.org/wiki/日本');
			expect(urls).toHaveLength(2);
			expect(urls[0]?.url).toBe('https://nic.みんな/');
			expect(urls[1]?.url).toBe('https://ja.wikipedia.org/wiki/日本');
		});

		it('preserves trailing @ if part of path', () => {
			const urls = extractUrls('Visit https://gta.fandom.com/wiki/TW@ Content');
			expect(urls).toHaveLength(1);
			expect(urls[0]?.url).toBe('https://gta.fandom.com/wiki/TW@');
		});

		it('rejects invalid URLs', () => {
			const urls = extractUrls('Invalid http://www\\.google\\.com url');
			expect(urls).toHaveLength(0);
		});
	});

	describe('extractHashtags', () => {
		it('extracts ASCII hashtags', () => {
			const tags = extractHashtags('Hello #world and #fediverse_rocks');
			expect(tags).toHaveLength(2);
			expect(tags[0]?.hashtag).toBe('world');
			expect(tags[1]?.hashtag).toBe('fediverse_rocks');
		});

		it('extracts Unicode hashtags and fullwidth hash', () => {
			const tags = extractHashtags('#hashtagタグ ＃日本語タグ');
			expect(tags).toHaveLength(2);
			expect(tags[0]?.hashtag).toBe('hashtagタグ');
			expect(tags[1]?.hashtag).toBe('日本語タグ');
		});

		it('does not extract number-only hashtags', () => {
			const tags = extractHashtags('Number #123 is not a tag but #123a is');
			expect(tags).toHaveLength(1);
			expect(tags[0]?.hashtag).toBe('123a');
		});

		it('requires hashtag to be preceded by whitespace or start of string', () => {
			expect(extractHashtags('foo#bar')).toHaveLength(0);
			expect(extractHashtags('foo #bar')).toHaveLength(1);
			expect(extractHashtags('\n#bar')).toHaveLength(1);
		});
	});

	describe('extractMentions', () => {
		it('extracts local mentions', () => {
			const mentions = extractMentions('Hello @alice and @bob_123');
			expect(mentions).toHaveLength(2);
			expect(mentions[0]?.username).toBe('alice');
			expect(mentions[0]?.domain).toBeUndefined();
			expect(mentions[1]?.username).toBe('bob_123');
		});

		it('extracts remote mentions with domain', () => {
			const mentions = extractMentions('Ping @alice@example.social and @bob@mastodon.test:8080');
			expect(mentions).toHaveLength(2);
			expect(mentions[0]?.username).toBe('alice');
			expect(mentions[0]?.domain).toBe('example.social');
			expect(mentions[1]?.username).toBe('bob');
			expect(mentions[1]?.domain).toBe('mastodon.test:8080');
		});

		it('supports IDN domains', () => {
			const mentions = extractMentions('Hello @sneak@hæresiar.ch and @foo@հայ.հայ');
			expect(mentions).toHaveLength(2);
			expect(mentions[0]?.username).toBe('sneak');
			expect(mentions[0]?.domain).toBe('hæresiar.ch');
			expect(mentions[1]?.username).toBe('foo');
			expect(mentions[1]?.domain).toBe('հայ.հայ');
		});

		it('does not match emails or =/ preceded strings', () => {
			expect(extractMentions('user@example.com')).toHaveLength(0);
			expect(extractMentions('param=@alice')).toHaveLength(0);
		});

		it('handles mentions inside parentheses or followed by punctuation', () => {
			const mentions = extractMentions('(@alice)! How are you @bob?');
			expect(mentions).toHaveLength(2);
			expect(mentions[0]?.username).toBe('alice');
			expect(mentions[1]?.username).toBe('bob');
		});
	});

	describe('removeOverlappingEntities', () => {
		it('drops mentions and hashtags embedded within URLs', () => {
			const text = 'Check https://example.com/@alice and https://example.com/#hashtag';
			const entities = extractEntities(text);
			expect(entities).toHaveLength(2);
			expect(entities[0]?.type).toBe('url');
			expect(entities[0]?.raw).toBe('https://example.com/@alice');
			expect(entities[1]?.type).toBe('url');
			expect(entities[1]?.raw).toBe('https://example.com/#hashtag');
		});
	});

	describe('formatShortenedUrl', () => {
		it('formats short URL without ellipsis', () => {
			const html = formatShortenedUrl('https://example.com');
			expect(html).toBe(
				'<a href="https://example.com" target="_blank" rel="nofollow noopener noreferrer" translate="no"><span class="invisible">https://</span><span class="">example.com</span><span class="invisible"></span></a>',
			);
		});

		it('truncates long URL with ellipsis and invisible suffix', () => {
			const url = 'https://prepitaph.org/wip/web-dovespair/';
			const html = formatShortenedUrl(url);
			expect(html).toContain('<span class="invisible">https://</span>');
			expect(html).toContain('<span class="ellipsis">prepitaph.org/wip/web-dovespai</span>');
			expect(html).toContain('<span class="invisible">r/</span>');
		});

		it('reverts truncation when suffix length is 1 (Mastodon spec)', () => {
			const url = 'https://prepitaph.org/wip/web-devspair/';
			const html = formatShortenedUrl(url);
			expect(html).toContain('<span class="invisible">https://</span>');
			expect(html).toContain('<span class="">prepitaph.org/wip/web-devspair/</span>');
			expect(html).toContain('<span class="invisible"></span>');
		});

		it('escapes HTML in URL and query strings', () => {
			const url = 'https://example.com/search?q=<test>&foo=bar';
			const html = formatShortenedUrl(url);
			expect(html).toContain('href="https://example.com/search?q=&lt;test&gt;&amp;foo=bar"');
			expect(html).toContain('&lt;test&gt;&amp;foo=bar');
		});
	});

	describe('formatHashtag', () => {
		it('generates hashtag HTML and ActivityPub Tag object', () => {
			const { html, tag } = formatHashtag('fediverse', 'mastodon-dev.hakatashi.com');
			expect(html).toBe(
				'<a href="https://mastodon-dev.hakatashi.com/tags/fediverse" class="mention hashtag" rel="tag">#<span>fediverse</span></a>',
			);
			expect(tag).toEqual({
				type: 'Hashtag',
				href: 'https://mastodon-dev.hakatashi.com/tags/fediverse',
				name: '#fediverse',
			});
		});

		it('URI encodes Unicode hashtag URL but keeps label in span', () => {
			const { html, tag } = formatHashtag('タグ', 'mastodon-dev.hakatashi.com');
			expect(html).toContain('/tags/%E3%82%BF%E3%82%B0');
			expect(html).toContain('#<span>タグ</span>');
			expect(tag.href).toBe('https://mastodon-dev.hakatashi.com/tags/%E3%82%BF%E3%82%B0');
			expect(tag.name).toBe('#タグ');
		});
	});

	describe('formatMention', () => {
		it('returns plain text when unresolved', () => {
			const mention = {
				raw: '@unknown@example.com',
				username: 'unknown',
				domain: 'example.com',
				indices: [0, 20] as [number, number],
			};
			const { html, tag, actorIri } = formatMention(mention, undefined);
			expect(html).toBe('@unknown@example.com');
			expect(tag).toBeUndefined();
			expect(actorIri).toBeUndefined();
		});

		it('formats resolved local mention', () => {
			const mention = {
				raw: '@alice',
				username: 'alice',
				domain: undefined,
				indices: [0, 6] as [number, number],
			};
			const resolved = {
				actorIri: 'https://hakatashi.com/activitypub/u/alice',
				url: 'https://hakatashi.com/activitypub/u/alice',
				username: 'alice',
			};
			const { html, tag, actorIri } = formatMention(mention, resolved);
			expect(html).toBe(
				'<span class="h-card" translate="no"><a href="https://hakatashi.com/activitypub/u/alice" class="u-url mention">@<span>alice</span></a></span>',
			);
			expect(tag).toEqual({
				type: 'Mention',
				href: 'https://hakatashi.com/activitypub/u/alice',
				name: '@alice',
			});
			expect(actorIri).toBe('https://hakatashi.com/activitypub/u/alice');
		});

		it('formats resolved remote mention with displayUsername without domain by default', () => {
			const mention = {
				raw: '@bob@remote.social',
				username: 'bob',
				domain: 'remote.social',
				indices: [0, 18] as [number, number],
			};
			const resolved = {
				actorIri: 'https://remote.social/users/bob',
				url: 'https://remote.social/@bob',
				username: 'bob',
				domain: 'remote.social',
			};
			const { html, tag, actorIri } = formatMention(mention, resolved, false);
			expect(html).toBe(
				'<span class="h-card" translate="no"><a href="https://remote.social/@bob" class="u-url mention">@<span>bob</span></a></span>',
			);
			expect(tag).toEqual({
				type: 'Mention',
				href: 'https://remote.social/users/bob',
				name: '@bob@remote.social',
			});
			expect(actorIri).toBe('https://remote.social/users/bob');
		});

		it('formats resolved remote mention with domain when disambiguation is required', () => {
			const mention = {
				raw: '@bob@remote.social',
				username: 'bob',
				domain: 'remote.social',
				indices: [0, 18] as [number, number],
			};
			const resolved = {
				actorIri: 'https://remote.social/users/bob',
				url: 'https://remote.social/@bob',
				username: 'bob',
				domain: 'remote.social',
			};
			const { html } = formatMention(mention, resolved, true);
			expect(html).toContain('@<span>bob@remote.social</span>');
		});
	});

	describe('textToParagraphs', () => {
		it('wraps paragraphs in <p> and converts single newlines to <br />', () => {
			const input = 'First line\nSecond line\n\nSecond paragraph';
			expect(textToParagraphs(input)).toBe(
				'<p>First line<br />Second line</p><p>Second paragraph</p>',
			);
		});
	});

	describe('formatPostContent full integration', () => {
		it('formats complex post with HTML escaping, URLs, hashtags, and mentions', () => {
			const text = `Hello <b>world</b>!
Check out https://example.com/test?a=1&b=2

Also mention @alice and @bob@remote.social and @charlie@unknown.org
Tag: #mastodon #fediverse #mastodon`;

			const resolvedMentions = new Map([
				[
					'@alice',
					{
						actorIri: 'https://hakatashi.com/activitypub/u/alice',
						url: 'https://hakatashi.com/activitypub/u/alice',
						username: 'alice',
					},
				],
				[
					'@bob@remote.social',
					{
						actorIri: 'https://remote.social/users/bob',
						url: 'https://remote.social/@bob',
						username: 'bob',
						domain: 'remote.social',
					},
				],
			]);

			const result = formatPostContent(text, {
				resolvedMentions,
				mastodonDomain: 'mastodon-dev.hakatashi.com',
			});

			// Plain text HTML escaped
			expect(result.html).toContain('&lt;b&gt;world&lt;/b&gt;!');

			// URL formatted
			expect(result.html).toContain('href="https://example.com/test?a=1&amp;b=2"');
			expect(result.html).toContain('target="_blank"');

			// Resolved mentions formatted
			expect(result.html).toContain(
				'<span class="h-card" translate="no"><a href="https://hakatashi.com/activitypub/u/alice" class="u-url mention">@<span>alice</span></a></span>',
			);
			expect(result.html).toContain(
				'<span class="h-card" translate="no"><a href="https://remote.social/@bob" class="u-url mention">@<span>bob</span></a></span>',
			);

			// Unresolved mention remains plain text
			expect(result.html).toContain('@charlie@unknown.org');
			expect(result.html).not.toContain('charlie</span>');

			// Hashtags formatted
			expect(result.html).toContain(
				'<a href="https://mastodon-dev.hakatashi.com/tags/mastodon" class="mention hashtag" rel="tag">#<span>mastodon</span></a>',
			);
			expect(result.html).toContain(
				'<a href="https://mastodon-dev.hakatashi.com/tags/fediverse" class="mention hashtag" rel="tag">#<span>fediverse</span></a>',
			);

			// Paragraphs and line breaks
			expect(result.html).toContain('<p>Hello');
			expect(result.html).toContain('<br />Check out');

			// Tags deduplicated (mastodon appears twice in text, but only 1 tag in array)
			expect(result.tags).toHaveLength(4); // 2 mentions + 2 unique hashtags
			expect(result.tags.map((t) => t.name)).toEqual([
				'@alice',
				'@bob@remote.social',
				'#mastodon',
				'#fediverse',
			]);

			// Mentioned actors
			expect(result.mentionedActorIris).toEqual([
				'https://hakatashi.com/activitypub/u/alice',
				'https://remote.social/users/bob',
			]);
		});

		it('disambiguates display names when same username exists across multiple domains', () => {
			const text = 'Hello @alice@domain1.com and @alice@domain2.com';
			const resolvedMentions = new Map([
				[
					'@alice@domain1.com',
					{
						actorIri: 'https://domain1.com/users/alice',
						url: 'https://domain1.com/@alice',
						username: 'alice',
						domain: 'domain1.com',
					},
				],
				[
					'@alice@domain2.com',
					{
						actorIri: 'https://domain2.com/users/alice',
						url: 'https://domain2.com/@alice',
						username: 'alice',
						domain: 'domain2.com',
					},
				],
			]);

			const result = formatPostContent(text, {
				resolvedMentions,
				mastodonDomain: 'mastodon-dev.hakatashi.com',
			});

			expect(result.html).toContain('@<span>alice@domain1.com</span>');
			expect(result.html).toContain('@<span>alice@domain2.com</span>');
		});
	});
});
