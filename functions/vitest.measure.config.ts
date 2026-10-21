import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.js';

// 読み取り回数の計測 (`npm run measure:reads`) 用。通常のテストには含めない。
// `mergeConfig` は配列を連結してしまうので、`include` はスプレッドで上書きする。
export default defineConfig({
	...baseConfig,
	test: {
		...baseConfig.test,
		include: ['test/measure/**/*.measure.ts'],
		fileParallelism: false,
	},
});
