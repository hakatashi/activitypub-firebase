import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	root: import.meta.dirname,
	resolve: {
		alias: [
			{
				find: '../../index',
				replacement: path.resolve(import.meta.dirname, 'src/apex/index.ts'),
			},
		],
	},
	test: {
		environment: 'node',
		globals: true,
		include: ['test/**/*.spec.ts', 'test/apex-upstream/**/*.spec.js'],
		setupFiles: ['test/setup-keys.ts', 'test/apex-upstream/setup.ts'],
		testTimeout: 10000,
		// テストは Firestore エミュレータを共有し、各テストの afterEach で
		// 全ドキュメントを消去する。ファイルを並列実行すると互いのデータを消し合うため直列化する。
		fileParallelism: false,
	},
});
