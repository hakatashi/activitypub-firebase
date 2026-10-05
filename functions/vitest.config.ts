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
		setupFiles: ['test/setup-env.ts', 'test/setup-keys.ts', 'test/apex-upstream/setup.ts'],
		testTimeout: 15000,
		fileParallelism: true,
		maxWorkers: 4,
	},
});
