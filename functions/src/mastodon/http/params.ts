// Mastodon の `ActiveModel::Type::Boolean` に合わせ、フォーム由来の文字列も解釈する。
const FALSE_VALUES = new Set(['0', 'f', 'false', 'off']);
export const toBoolean = (value: boolean | string | null | undefined) => {
	if (typeof value === 'boolean') {
		return value;
	}
	if (value === null || value === undefined || value === '') {
		return undefined;
	}
	return !FALSE_VALUES.has(value.toLowerCase());
};

export const isPresent = (value: unknown) => {
	if (value === undefined || value === null || value === '') {
		return false;
	}
	if (Array.isArray(value)) {
		return value.length > 0;
	}
	if (typeof value === 'object') {
		return Object.keys(value).length > 0;
	}
	return true;
};
