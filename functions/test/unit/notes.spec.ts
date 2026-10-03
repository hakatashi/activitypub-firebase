import { describe, expect, test } from 'vitest';
import { htmlToPlainText, plainTextToHtml } from '../../src/notes.js';

describe('notes utils', () => {
	describe('htmlToPlainText', () => {
		test('converts basic paragraphs and br tags back to plain text', () => {
			const html = '<p>hello world</p><p>line 1<br />line 2</p>';
			expect(htmlToPlainText(html)).toBe('hello world\n\nline 1\nline 2');
		});

		test('decodes HTML entities', () => {
			const html =
				'<p>&lt;script&gt;alert(&quot;hello &amp; &#39;world&#39;&quot;)&lt;/script&gt;</p>';
			expect(htmlToPlainText(html)).toBe('<script>alert("hello & \'world\'")</script>');
		});

		test('handles various br and p tag formats', () => {
			const html = '<p class="status">first</p>\n<p>second<BR>third<br/>fourth</p>';
			expect(htmlToPlainText(html)).toBe('first\n\nsecond\nthird\nfourth');
		});

		test('round-trips with plainTextToHtml', () => {
			const original = 'Hello world!\n\nThis is a second paragraph.\nWith a second line.';
			const html = plainTextToHtml(original);
			expect(htmlToPlainText(html)).toBe(original);
		});
	});
});
