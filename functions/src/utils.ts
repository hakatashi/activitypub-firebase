import type { APObject } from 'activitypub-express';
import type { APActor, APFollow, APNote, APUndo } from 'activitypub-types';
import type express from 'express';
import { z } from 'zod';

type CamelToSnakeCase<S extends string> = S extends `${infer T}${infer U}`
	? `${T extends Capitalize<T> ? (T extends Lowercase<T> ? '' : '_') : ''}${Lowercase<T>}${CamelToSnakeCase<U>}`
	: S;

type CamelToSnakeList<T extends object> = T extends (infer E)[]
	? E extends object
		? CamelToSnake<E>[]
		: T
	: CamelToSnake<T>;

export type CamelToSnake<T extends object> = {
	[K in keyof T as `${CamelToSnakeCase<string & K>}`]: T[K] extends object
		? CamelToSnakeList<T[K]>
		: T[K] extends (infer S extends object) | null
			? CamelToSnakeList<S> | null
			: T[K] extends (infer U extends object) | null | undefined
				? CamelToSnakeList<U> | null | undefined
				: T[K];
};

export class Counter<T> {
	#counter = new Map<T, number>();

	increment(key: T, amount = 1) {
		const current = this.#counter.get(key) ?? 0;
		this.#counter.set(key, current + amount);
		return current + amount;
	}

	get(key: T) {
		return this.#counter.get(key) ?? 0;
	}

	[Symbol.iterator]() {
		return this.#counter[Symbol.iterator]();
	}

	entries() {
		return this.#counter.entries();
	}
}

// リクエストログに残してよいヘッダーの許可リスト。
// Authorization / Signature / Cookie など機微なヘッダーはここに含めない。
const SAFE_REQUEST_HEADERS = [
	'accept',
	'content-length',
	'content-type',
	'digest',
	'host',
	'user-agent',
] as const;

export const pickSafeHeaders = (headers: Record<string, string | string[] | undefined>) =>
	Object.fromEntries(
		SAFE_REQUEST_HEADERS.filter((name) => headers[name] !== undefined).map((name) => [
			name,
			headers[name],
		]),
	);

// リクエストボディに含まれうる機微情報(OAuth の client_secret や password grant など)をログ用にマスクする。
const SENSITIVE_BODY_FIELDS = [
	'accessToken',
	'access_token',
	'client_secret',
	'code',
	'idToken',
	'password',
	'privateKey',
	'refreshToken',
	'refresh_token',
];

export const ACTOR_TYPES = ['Person', 'Application', 'Group', 'Organization', 'Service'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

// AS2 のプロパティ値はスカラーまたは配列のいずれでも届きうる(activitypub-express は
// compactArrays: false で JSON-LD を正規化するため通常は配列になるが、スカラーのまま
// 保存された既存データも扱う必要がある)。どちらの表現でも同じように扱えるよう配列に正規化する。
export const toArray = <T>(value: T | T[] | null | undefined): T[] => {
	if (value === undefined || value === null) {
		return [];
	}
	return Array.isArray(value) ? value : [value];
};

// AS2 の type は単一の文字列または文字列の配列になりうる(activitypub-express は
// compactArrays: false で JSON-LD を正規化するため常に配列になる)。
// どの表現でも同じように判定できるよう、常に文字列の配列に正規化する。
export const toTypeArray = (value: unknown): string[] => {
	const values = toArray(value);
	return values.flatMap((entry): string[] => {
		if (typeof entry === 'string') {
			return [entry];
		}
		return [];
	});
};

export const objectToTypeArray = (value: object): string[] => {
	if ('type' in value) {
		return toTypeArray(value.type);
	}
	return [];
};

// AS2 のプロパティ値から単一の文字列を取り出す。文字列配列の場合は先頭要素を返し、
// 文字列でない場合や空配列の場合は undefined を返す。
export const toStringValue = (value: unknown): string | undefined => {
	if (typeof value === 'string') {
		return value;
	}
	if (Array.isArray(value)) {
		const first = value[0];
		if (typeof first === 'string') {
			return first;
		}
	}
	return undefined;
};

// 配列または単一値から先頭の要素を取り出す。
export const firstOf = <T>(value: T | T[] | undefined | null): T | undefined => {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (Array.isArray(value)) {
		return value[0];
	}
	return value;
};

const ACTOR_TYPE_SET = new Set<string>(ACTOR_TYPES);

// 型ガード関数: AS2 の type が配列で届く場合でも正しく絞り込めるようにする (→ ADR-0025)
export const isAPActor = <T>(object: T): object is T & APActor => {
	if (typeof object !== 'object' || object === null) {
		return false;
	}
	const types = objectToTypeArray(object);
	return types.some((type) => ACTOR_TYPE_SET.has(type));
};

export const isAPNote = <T>(object: T): object is T & APNote => {
	if (typeof object !== 'object' || object === null) {
		return false;
	}
	return objectToTypeArray(object).includes('Note');
};

export const isAPFollow = <T>(object: T): object is T & APFollow => {
	if (typeof object !== 'object' || object === null) {
		return false;
	}
	return objectToTypeArray(object).includes('Follow');
};

export const isAPUndo = <T>(object: T): object is T & APUndo => {
	if (typeof object !== 'object' || object === null) {
		return false;
	}
	return objectToTypeArray(object).includes('Undo');
};

// AS2 の Object/Link は id/href を持つが、activitypub-express は compactArrays: false で
// JSON-LD を正規化するため、actor・object のようなプロパティは常に配列になり、その要素は
// IRI 文字列・Link・埋め込みオブジェクトのいずれにもなりうる
// (activitypub-express/pub/utils.js の actorIdFromActivity / objectIdFromActivity と同じ判定)。
// どの表現でも同じ IRI として比較できるよう、常にスカラーの ID 文字列の配列に正規化する。
export const toIdArray = (value: unknown): string[] => {
	const values = toArray(value);
	return values.flatMap((entry): string[] => {
		if (typeof entry === 'string') {
			return [entry];
		}
		if (entry === null || typeof entry !== 'object') {
			return [];
		}
		if (objectToTypeArray(entry).includes('Link')) {
			const href = 'href' in entry ? toStringValue(entry.href) : undefined;
			return href === undefined ? [] : [href];
		}
		const id = 'id' in entry ? toStringValue(entry.id) : undefined;
		return id === undefined ? [] : [id];
	});
};

export const redactSensitiveBody = (body: unknown): unknown => {
	if (Array.isArray(body)) {
		return body.map(redactSensitiveBody);
	}
	if (body !== null && typeof body === 'object') {
		return Object.fromEntries(
			Object.entries(body).map(([key, value]) =>
				SENSITIVE_BODY_FIELDS.includes(key)
					? [key, '[REDACTED]']
					: [key, redactSensitiveBody(value)],
			),
		);
	}
	return body;
};

export const toError = (value: unknown): Error => {
	if (value instanceof Error) {
		return value;
	}
	return new Error(typeof value === 'string' ? value : String(value));
};

export const apexLocalsSchema = z
	.object({
		activity: z
			.union([z.boolean(), z.custom<APObject>((val) => typeof val === 'object' && val !== null)])
			.optional(),
		actor: z.custom<APObject>((val) => typeof val === 'object' && val !== null).optional(),
		object: z.custom<APObject>((val) => typeof val === 'object' && val !== null).optional(),
		target: z.custom<APObject>((val) => typeof val === 'object' && val !== null).optional(),
		sender: z.custom<APObject>((val) => typeof val === 'object' && val !== null).optional(),
		status: z.number().optional(),
		statusMessage: z.string().optional(),
		responseType: z.string().optional(),
		createdLocation: z.string().optional(),
		eventName: z.string().nullable().optional(),
		eventMessage: z.unknown().optional(),
		isNewActivity: z.union([z.boolean(), z.string()]).optional(),
		isRedundantDelivery: z.boolean().optional(),
		postWork: z
			.array(z.custom<(res: express.Response) => unknown>((fn) => typeof fn === 'function'))
			.optional(),
		authorized: z.boolean().optional(),
	})
	.passthrough();

export type ApexLocals = z.infer<typeof apexLocalsSchema>;

export const safeParseApexLocals = (value: unknown) => apexLocalsSchema.safeParse(value);
