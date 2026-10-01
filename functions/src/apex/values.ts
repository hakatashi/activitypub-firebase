import type { APObject } from './types.js';

// JSON-LD (compactArrays: false で正規化した形) の値を読むための正規化ヘルパー。
// AP オブジェクトのプロパティは任意の JSON が入りうるため unknown として読み、ここで絞る (→ ADR-0051)。

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

export const isString = (value: unknown): value is string =>
	Object.prototype.toString.call(value) === '[object String]';

export const isAPObject = (value: unknown): value is APObject =>
	isRecord(value) &&
	typeof value.id === 'string' &&
	value.id !== '' &&
	typeof value.type === 'string' &&
	value.type !== '';

export const isHashtag = (value: unknown): boolean => {
	if (!isRecord(value)) {
		return false;
	}
	const typeVal = value.type;
	if (typeof typeVal === 'string') {
		return typeVal === 'Hashtag' || typeVal === 'as:Hashtag';
	}
	if (Array.isArray(typeVal)) {
		return typeVal.some((t) => t === 'Hashtag' || t === 'as:Hashtag');
	}
	return false;
};

export const toArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);

export const first = (value: unknown): unknown => toArray(value)[0];

export const firstString = (value: unknown): string | undefined => {
	const head = first(value);
	return typeof head === 'string' ? head : undefined;
};

// 配列の先頭が IRI ならそれを、オブジェクトならその id を返す
export const firstId = (value: unknown): string | undefined => {
	const head = first(value);
	if (typeof head === 'string') {
		return head;
	}
	if (isRecord(head) && typeof head.id === 'string') {
		return head.id;
	}
	return undefined;
};

export const stringArray = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

export const errorMessage = (err: unknown): unknown => (err instanceof Error ? err.message : err);
