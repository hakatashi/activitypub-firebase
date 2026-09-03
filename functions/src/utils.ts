type CamelToSnakeCase<S extends string> =
	S extends `${infer T}${infer U}` ?
		`${T extends Capitalize<T> ? (T extends Lowercase<T> ? '' : '_') : ''}${Lowercase<T>}${CamelToSnakeCase<U>}` :
		S;

type CamelToSnakeList<T extends object> =
	T extends (infer E)[] ?
		(E extends object ? CamelToSnake<E>[] : T) :
		CamelToSnake<T>;

export type CamelToSnake<T extends object> = {
	[K in keyof T as `${CamelToSnakeCase<string & K>}`]:
		T[K] extends object ?
			(
				CamelToSnakeList<T[K]>
			) :
			(
				T[K] extends ((infer S extends object) | null) ?
				CamelToSnakeList<S> | null :
				(
					T[K] extends ((infer U extends object) | null | undefined) ?
					CamelToSnakeList<U> | null | undefined :
					T[K]
				)
			)
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

export const pickSafeHeaders = (headers: Record<string, string | string[] | undefined>) => (
	Object.fromEntries(
		SAFE_REQUEST_HEADERS
			.filter((name) => headers[name] !== undefined)
			.map((name) => [name, headers[name]]),
	)
);

// リクエストボディに含まれうる機微情報(OAuth の client_secret や password grant など)をログ用にマスクする。
const SENSITIVE_BODY_FIELDS = [
	'accessToken',
	'access_token',
	'client_secret',
	'code',
	'idToken',
	'password',
	'refreshToken',
	'refresh_token',
];

export const redactSensitiveBody = (body: unknown): unknown => {
	if (Array.isArray(body)) {
		return body.map(redactSensitiveBody);
	}
	if (body !== null && typeof body === 'object') {
		return Object.fromEntries(
			Object.entries(body as Record<string, unknown>).map(([key, value]) => (
				SENSITIVE_BODY_FIELDS.includes(key) ? [key, '[REDACTED]'] : [key, redactSensitiveBody(value)]
			)),
		);
	}
	return body;
};
