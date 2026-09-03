import {defineConfig} from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['test/**/*.spec.ts'],
		testTimeout: 10000,
		// テストは Firestore エミュレータを共有し、各テストの afterEach で
		// 全ドキュメントを消去する。ファイルを並列実行すると互いのデータを消し合うため直列化する。
		fileParallelism: false,
	},
});
