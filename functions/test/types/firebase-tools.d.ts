declare module 'firebase-tools/lib/functions/env.js' {
	interface LoadUserEnvsOptions {
		functionsSource: string;
		projectId: string;
		projectDir: string;
	}
	const env: {
		loadUserEnvs: (options: LoadUserEnvsOptions) => Record<string, string>;
	};
	export default env;
}

declare module 'firebase-tools/lib/deploy/functions/params.js' {
	interface ResolveParamsOptions {
		params: unknown[];
		firebaseConfig: { projectId: string; [key: string]: unknown };
		userEnvs: Record<string, string>;
		codebase?: string;
		nonInteractive?: boolean;
		isEmulator?: boolean;
	}
	const params: {
		resolveParams: (options: ResolveParamsOptions) => Promise<{
			paramValues: Record<string, unknown>;
			secretRefs: Record<string, unknown>;
		}>;
	};
	export default params;
}
