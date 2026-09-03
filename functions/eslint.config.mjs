import hakatashi from '@hakatashi/eslint-config/typescript.js';

export default [
	...hakatashi,
	{
		ignores: [
			'lib/**/*', // Ignore built files.
		],
	},
	{
		rules: {
			'import/no-namespace': 'off',
			'no-undef-init': 'off',
			'import/no-named-as-default-member': 'off',
			'no-underscore-dangle': ['error', {allow: ['_meta']}],
			'private-props/no-use-outside': 'off',
			// activitypub-express に型定義がなく(ADR-0002)、その戻り値・引数の型付けに any を多用するため。
			'@typescript-eslint/no-explicit-any': 'off',
		},
	},
];
