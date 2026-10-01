import { Objects } from '../src/schema.js';

// `published` が1要素の文字列配列で保存されている objects を文字列に直すバックフィル (→ ADR-0062)。
// 配列のままだと published の範囲指定クエリから落ちる。何度実行してもよい。

const objects = await Objects.get();
let fixed = 0;
for (const doc of objects.docs) {
	const published: unknown = doc.get('published');
	if (Array.isArray(published) && published.length === 1 && typeof published[0] === 'string') {
		await doc.ref.update({ published: published[0] });
		fixed++;
	}
}
console.log(`objects: ${objects.docs.length}, normalized: ${fixed}`);
