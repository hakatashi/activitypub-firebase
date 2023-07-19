module.exports = {
	root: true,
	extends: '@hakatashi/eslint-config/typescript',
	ignorePatterns: [
		'/lib/**/*', // Ignore built files.
	],
	rules: {
		'import/no-namespace': 'off',
		'no-undef-init': 'off',
		'import/no-named-as-default-member': 'off',
	},
};
