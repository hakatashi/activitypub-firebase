#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';

const functionsDir = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);

const shellQuote = (arg) => `'${arg.replaceAll("'", "'\\''")}'`;

let baseCommand = 'vitest run';
let vitestArgs = args;

if (args[0] === 'related') {
	baseCommand = 'vitest related --run';
	vitestArgs = args.slice(1);
}

const quotedArgs = vitestArgs.map(shellQuote).join(' ');
const script = `cross-env GCLOUD_PROJECT=activitypub-firebase-dev ${baseCommand}${quotedArgs ? ` ${quotedArgs}` : ''}`;

const child = spawn(
	'npx',
	[
		'firebase',
		'emulators:exec',
		'--project',
		'activitypub-firebase-dev',
		'--only',
		'firestore',
		script,
	],
	{
		cwd: functionsDir,
		stdio: 'inherit',
	},
);

child.on('exit', (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
	} else {
		process.exit(code ?? 0);
	}
});
