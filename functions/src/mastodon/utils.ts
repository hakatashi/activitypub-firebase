type CamelToSnakeCase<S extends string> =
	S extends `${infer T}${infer U}` ?
		`${T extends Capitalize<T> ? (T extends Lowercase<T> ? '' : '_') : ''}${Lowercase<T>}${CamelToSnakeCase<U>}` :
		S;

type CamelToSnakeList<T extends object> =
	T extends Array<infer E> ?
		(E extends object ? Array<CamelToSnake<E>> : T) :
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
