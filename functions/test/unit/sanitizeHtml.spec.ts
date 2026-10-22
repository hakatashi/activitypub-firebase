import { describe, expect, test } from 'vitest';
import { sanitizeHtml } from '../../src/mastodon/sanitizeHtml.js';

// Mastodon API で返す HTML のサニタイズ (→ ADR-0145)。
describe('sanitizeHtml', () => {
	test('keeps the markup of ordinary remote statuses', () => {
		expect(
			sanitizeHtml(
				'<p>hello<br>world <a href="https://example.com/tags/tag" class="mention hashtag" rel="tag">#<span>tag</span></a> ' +
					'<span class="h-card" translate="no"><a href="https://example.com/@alice" class="u-url mention">@<span>alice</span></a></span></p>' +
					'<p><a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="nofollow noopener noreferrer" translate="no"><span class="invisible">https://</span><span class="ellipsis">example.com/a</span><span class="invisible">?b=1&amp;c=2</span></a></p>',
			),
		).toBe(
			'<p>hello<br>world <a href="https://example.com/tags/tag" class="mention hashtag" rel="nofollow noopener" target="_blank">#<span>tag</span></a> ' +
				'<span class="h-card" translate="no"><a href="https://example.com/@alice" class="u-url mention" rel="nofollow noopener" target="_blank">@<span>alice</span></a></span></p>' +
				'<p><a href="https://example.com/a?b=1&amp;c=2" translate="no" rel="nofollow noopener" target="_blank"><span class="invisible">https://</span><span class="ellipsis">example.com/a</span><span class="invisible">?b=1&amp;c=2</span></a></p>',
		);
	});

	test('keeps plain text and escapes it', () => {
		expect(sanitizeHtml('')).toBe('');
		expect(sanitizeHtml('Hello, Fediverse!')).toBe('Hello, Fediverse!');
		expect(sanitizeHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
	});

	test('keeps the formatting elements allowed by MASTODON_STRICT', () => {
		const html =
			'<p lang="ja"><b>b</b><strong>s</strong><i>i</i><em>e</em><u>u</u><del>d</del><s>s</s><code>c</code></p>' +
			'<blockquote><p>q</p></blockquote><pre><code>x</code></pre>' +
			'<ol start="3" reversed=""><li value="5">a</li></ol><ul><li>b</li></ul>' +
			'<ruby>漢<rp>(</rp><rt>かん</rt><rp>)</rp></ruby>';
		expect(sanitizeHtml(html)).toBe(html);
	});

	test('drops scripts, event handlers and unknown elements', () => {
		expect(
			sanitizeHtml(
				'<p onclick="alert(1)" style="color:red">a<script>alert(1)</script><img src=x onerror=alert(1)><style>p{}</style><iframe src="https://e.com"></iframe><svg><script>alert(1)</script></svg>b</p>',
			),
		).toBe('<p>ab</p>');
		expect(sanitizeHtml('<div>a</div><div>b</div>')).toBe(' a  b ');
		expect(sanitizeHtml('<p>a<!-- c --><font color="red">b</font></p>')).toBe('<p>ab</p>');
	});

	test('turns links with unsupported schemes into text', () => {
		expect(
			sanitizeHtml(
				'<a href="javascript:alert(1)"><b>x</b></a><a href=" jav&#x61;script:alert(1)">y</a><a href="/relative">z</a><a>w</a><a href="data:text/html,1">v</a>',
			),
		).toBe('xyzwv');
		expect(sanitizeHtml('<a href="gemini://e.com/">g</a>')).toBe(
			'<a href="gemini://e.com/" rel="nofollow noopener" target="_blank">g</a>',
		);
	});

	test('escapes attribute values and keeps only allowed classes', () => {
		expect(sanitizeHtml('<a href="https://e.com/&quot;onmouseover=x">d</a>')).toBe(
			'<a href="https://e.com/&quot;onmouseover=x" rel="nofollow noopener" target="_blank">d</a>',
		);
		expect(sanitizeHtml('<span class="x&quot; onclick=&quot;y mention custom">z</span>')).toBe(
			'<span class="mention">z</span>',
		);
		expect(sanitizeHtml('<span translate="yes" data-x="1">z</span>')).toBe('<span>z</span>');
	});

	test('does not let broken markup escape the sanitizer', () => {
		expect(sanitizeHtml('<p>a<img src="x>" onerror="alert(1)">b')).toBe('<p>ab</p>');
		expect(sanitizeHtml('<p><b>unclosed')).toBe('<p><b>unclosed</b></p>');
		expect(sanitizeHtml('<scr<script>ipt>alert(1)</script>')).toBe('ipt&gt;alert(1)');
	});

	test('converts headings and math like Mastodon', () => {
		expect(sanitizeHtml('<h1>Title</h1><p>body</p>')).toBe(
			'<p><strong>Title</strong></p><p>body</p>',
		);
		expect(
			sanitizeHtml(
				'<math display="block"><semantics><mi>x</mi><annotation encoding="application/x-tex">x^2</annotation></semantics></math>',
			),
		).toBe('$$x^2$$');
		expect(
			sanitizeHtml(
				'<math><semantics><mi>x</mi><annotation encoding="text/plain">x squared</annotation></semantics></math>',
			),
		).toBe('x squared');
		expect(sanitizeHtml('<math><mi>x</mi></math>')).toBe('');
	});
});
