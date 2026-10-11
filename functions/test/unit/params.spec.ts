import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { declaredParams } from 'firebase-functions/params';
import firebaseEnv from 'firebase-tools/lib/functions/env.js';
import firebaseParams from 'firebase-tools/lib/deploy/functions/params.js';
import { describe, expect, test } from 'vitest';
// index.js を import することで全 Function 定義と declaredParams を読み込む
import '../../src/index.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const functionsDir = path.resolve(currentDir, '../../');
const projectDir = path.resolve(currentDir, '../../../');

describe('functions/.env and parameter validation', () => {
	test('functions/.env exists and defines ACTIVITYPUB_MIN_INSTANCES', () => {
		const envPath = path.join(functionsDir, '.env');
		expect(fs.existsSync(envPath)).toBe(true);
		const content = fs.readFileSync(envPath, 'utf8');
		expect(content).toMatch(/^ACTIVITYPUB_MIN_INSTANCES=\d+/m);
	});

	test('all declared parameters resolve in non-interactive mode for production and dev', async () => {
		const nonSecretParams = declaredParams
			.filter(
				(
					p,
				): p is typeof p & {
					toSpec: () => { name: string; type: string; [key: string]: unknown };
				} => 'toSpec' in p,
			)
			.map((p) => p.toSpec())
			.filter((spec) => spec.type !== 'secret');

		expect(nonSecretParams.length).toBeGreaterThan(0);

		for (const projectId of ['activitypub-firebase', 'activitypub-firebase-dev']) {
			const userEnvs = firebaseEnv.loadUserEnvs({
				functionsSource: functionsDir,
				projectId,
				projectDir,
			});

			const { paramValues } = await firebaseParams.resolveParams(
				nonSecretParams,
				{ projectId },
				userEnvs,
				'default',
				true, // nonInteractive
				false,
				true, // isEmulator
			);

			for (const param of nonSecretParams) {
				expect(userEnvs).toHaveProperty(param.name);
				expect(paramValues).toHaveProperty(param.name);
			}
		}
	});

	test('fails in non-interactive mode when a param is missing from userEnvs', async () => {
		const missingParam = [
			{
				name: 'NON_EXISTENT_PARAM',
				type: 'int',
				default: 0,
			},
		];

		await expect(
			firebaseParams.resolveParams(
				missingParam,
				{ projectId: 'activitypub-firebase' },
				{},
				'default',
				true, // nonInteractive
				false,
				true, // isEmulator
			),
		).rejects.toThrow(
			/In non-interactive mode but have no value for the following environment variables: NON_EXISTENT_PARAM/,
		);
	});
});
