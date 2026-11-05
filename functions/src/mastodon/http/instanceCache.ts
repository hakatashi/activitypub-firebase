// 認証の結果と閲覧者の actor のインスタンス内キャッシュ (→ ADR-0169)。覚えてから maxAgeMs で読み直す。
// Map の挿入順を LRU に使う。

interface Entry<V> {
	value: V;
	storedAt: number;
}

export interface TtlCache<V> {
	get: (key: string) => V | undefined;
	set: (key: string, value: V) => void;
	delete: (key: string) => void;
	deleteWhere: (predicate: (value: V) => boolean) => void;
	clear: () => void;
}

export const createTtlCache = <V>({
	maxEntries,
	maxAgeMs,
}: {
	maxEntries: number;
	maxAgeMs: number;
}): TtlCache<V> => {
	const cache = new Map<string, Entry<V>>();
	return {
		get: (key) => {
			const entry = cache.get(key);
			if (entry === undefined) {
				return undefined;
			}
			cache.delete(key);
			if (Date.now() - entry.storedAt >= maxAgeMs) {
				return undefined;
			}
			cache.set(key, entry);
			return entry.value;
		},
		set: (key, value) => {
			cache.delete(key);
			cache.set(key, { value, storedAt: Date.now() });
			for (const oldest of cache.keys()) {
				if (cache.size <= maxEntries) {
					break;
				}
				cache.delete(oldest);
			}
		},
		delete: (key) => {
			cache.delete(key);
		},
		deleteWhere: (predicate) => {
			for (const [key, entry] of cache) {
				if (predicate(entry.value)) {
					cache.delete(key);
				}
			}
		},
		clear: () => {
			cache.clear();
		},
	};
};

// プレーンなオブジェクトと配列だけを複製する。Firestore の Timestamp などは不変なので共有する。
export const clonePlain = <T>(value: T): T => {
	if (Array.isArray(value)) {
		return value.map((item: unknown) => clonePlain(item)) as T;
	}
	if (
		typeof value === 'object' &&
		value !== null &&
		Object.getPrototypeOf(value) === Object.prototype
	) {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, clonePlain(item)]),
		) as T;
	}
	return value;
};
