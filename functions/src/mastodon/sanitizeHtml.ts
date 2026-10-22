import { parseFragment } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

// Mastodon API で返す本文・プロフィールの HTML を、Mastodon の `Sanitize::Config::MASTODON_STRICT` と
// 同じ許可リストでサニタイズする (→ ADR-0145)。
// 参照: third_party/mastodon/lib/sanitize_ext/sanitize_config.rb

type ParsedNode = DefaultTreeAdapterMap['node'];
type ParsedElement = DefaultTreeAdapterMap['element'];

const ALLOWED_ELEMENTS = new Set([
	'p',
	'br',
	'span',
	'a',
	'del',
	's',
	'pre',
	'blockquote',
	'code',
	'b',
	'strong',
	'u',
	'i',
	'em',
	'ul',
	'ol',
	'li',
	'ruby',
	'rt',
	'rp',
]);
const VOID_ELEMENTS = new Set(['br']);

const ALLOWED_ATTRIBUTES: Record<string, Set<string> | undefined> = {
	a: new Set(['href', 'rel', 'class', 'translate']),
	span: new Set(['class', 'translate']),
	ol: new Set(['start', 'reversed']),
	li: new Set(['value']),
	p: new Set(['class']),
};
const GLOBAL_ATTRIBUTES = new Set(['lang']);

// Sanitize gem の既定。許可しない要素のうち、中身ごと捨てるもの。
const REMOVE_CONTENTS_ELEMENTS = new Set([
	'iframe',
	'math',
	'noembed',
	'noframes',
	'noscript',
	'plaintext',
	'script',
	'style',
	'svg',
	'xmp',
]);
// Sanitize gem の既定。外したときに前後へ空白を入れる要素。
const WHITESPACE_ELEMENTS = new Set([
	'address',
	'article',
	'aside',
	'blockquote',
	'br',
	'dd',
	'div',
	'dl',
	'dt',
	'footer',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'header',
	'hgroup',
	'hr',
	'li',
	'nav',
	'ol',
	'p',
	'pre',
	'section',
	'ul',
]);
const HEADING_ELEMENTS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

const LINK_PROTOCOLS = new Set([
	'http',
	'https',
	'dat',
	'dweb',
	'ipfs',
	'ipns',
	'ssb',
	'gopher',
	'xmpp',
	'magnet',
	'gemini',
]);
// Sanitize::REGEX_PROTOCOL と同じ。`/` か `#` より前にある最初の `:` までをスキームとみなす。
const PROTOCOL_PATTERN = /^\s*(?<scheme>[^/#]*?):/i;

const ALLOWED_CLASS_PATTERN =
	/^(?:(?:h|p|u|dt|e)-.*|mention|hashtag|ellipsis|invisible|quote-inline)$/;

const isElement = (node: ParsedNode): node is ParsedElement => 'tagName' in node;

const isText = (node: ParsedNode): node is DefaultTreeAdapterMap['textNode'] =>
	node.nodeName === '#text';

const getAttribute = (element: ParsedElement, name: string) =>
	element.attrs.find((attribute) => attribute.name === name)?.value;

const escapeText = (text: string) =>
	text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const escapeAttribute = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');

const textContent = (node: ParsedNode): string => {
	if (isText(node)) {
		return node.value;
	}
	return 'childNodes' in node ? node.childNodes.map(textContent).join('') : '';
};

const hasLinkProtocol = (href: string | undefined) => {
	const scheme = href === undefined ? undefined : PROTOCOL_PATTERN.exec(href)?.groups?.scheme;
	return scheme !== undefined && LINK_PROTOCOLS.has(scheme.toLowerCase());
};

// FEP-dc88 の `<math><semantics>…<annotation encoding>…</annotation></semantics></math>` を、
// 注釈のテキストに置き換える (Mastodon の MATH_TRANSFORMER)。注釈が無ければ undefined。
const mathToText = (math: ParsedElement) => {
	const semantics = math.childNodes.find(isElement);
	if (semantics?.tagName !== 'semantics') {
		return undefined;
	}
	const findAnnotation = (encoding: string) =>
		semantics.childNodes.find(
			(child): child is ParsedElement =>
				isElement(child) &&
				child.tagName === 'annotation' &&
				getAttribute(child, 'encoding') === encoding,
		);
	const tex = findAnnotation('application/x-tex');
	if (tex !== undefined) {
		const delimiter = getAttribute(math, 'display') === 'block' ? '$$' : '$';
		return `${delimiter}${textContent(tex)}${delimiter}`;
	}
	const plain = findAnnotation('text/plain');
	return plain === undefined ? undefined : textContent(plain);
};

const serializeAttributes = (element: ParsedElement, tag: string) => {
	const allowed = ALLOWED_ATTRIBUTES[tag];
	let result = '';
	for (const { name, value } of element.attrs) {
		if (!GLOBAL_ATTRIBUTES.has(name) && allowed?.has(name) !== true) {
			continue;
		}
		let sanitized: string | undefined = value;
		if (name === 'class') {
			sanitized = value
				.split(/[\t\n\f\r ]/)
				.filter((className) => ALLOWED_CLASS_PATTERN.test(className))
				.join(' ');
		} else if (name === 'translate') {
			sanitized = value === 'no' ? value : undefined;
		} else if (name === 'rel' && tag === 'a') {
			// add_attributes で上書きする。
			sanitized = undefined;
		}
		if (sanitized !== undefined) {
			result += ` ${name}="${escapeAttribute(sanitized)}"`;
		}
	}
	if (tag === 'a') {
		result += ' rel="nofollow noopener" target="_blank"';
	}
	return result;
};

const serializeNode = (node: ParsedNode): string => {
	const serializeChildren = (parent: ParsedElement) =>
		parent.childNodes.map(serializeNode).join('');
	if (isText(node)) {
		return escapeText(node.value);
	}
	if (!isElement(node)) {
		// コメントなど。
		return '';
	}
	const tag = node.tagName;
	if (tag === 'math') {
		const text = mathToText(node);
		return text === undefined ? '' : escapeText(text);
	}
	if (HEADING_ELEMENTS.has(tag)) {
		return `<p><strong>${serializeChildren(node)}</strong></p>`;
	}
	if (tag === 'a' && !hasLinkProtocol(getAttribute(node, 'href'))) {
		return escapeText(textContent(node));
	}
	if (!ALLOWED_ELEMENTS.has(tag)) {
		if (REMOVE_CONTENTS_ELEMENTS.has(tag)) {
			return '';
		}
		const children = serializeChildren(node);
		return WHITESPACE_ELEMENTS.has(tag) ? ` ${children} ` : children;
	}
	const attributes = serializeAttributes(node, tag);
	if (VOID_ELEMENTS.has(tag)) {
		return `<${tag}${attributes}>`;
	}
	return `<${tag}${attributes}>${serializeChildren(node)}</${tag}>`;
};

export const sanitizeHtml = (html: string): string => {
	if (html === '') {
		return '';
	}
	return parseFragment(html).childNodes.map(serializeNode).join('');
};
