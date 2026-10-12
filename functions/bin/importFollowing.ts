import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { apex } from '../src/apex.js';
import { LOCAL_USERNAME, localActorIri } from '../src/localActor.js';
import { importFollowing, parseFollowingCsv } from '../src/social/import.js';
import { isAPActor } from '../src/utils.js';

const projectId = process.env.GCLOUD_PROJECT ?? 'activitypub-firebase-dev';
assert(
	projectId === 'activitypub-firebase' || projectId === 'activitypub-firebase-dev',
	`GCLOUD_PROJECT must be set to activitypub-firebase or activitypub-firebase-dev, got: ${projectId}`,
);

const domain =
	projectId === 'activitypub-firebase' ? 'hakatashi.com' : 'activitypub-dev.hakatashi.com';
const actorId = localActorIri(LOCAL_USERNAME, domain);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const intervalArg = args.find((arg) => arg.startsWith('--interval-ms='));
const intervalMs = intervalArg ? parseInt(intervalArg.split('=')[1] ?? '1000', 10) : 1000;
const csvPath = args.find((arg) => !arg.startsWith('--'));

const printUsageAndExit = () => {
	console.error('Usage:');
	console.error(
		'  npx tsx bin/importFollowing.ts <path-to-following_accounts.csv> [--dry-run] [--interval-ms=1000]',
	);
	process.exit(1);
};

if (!csvPath) {
	printUsageAndExit();
}
assert(csvPath !== undefined);

const resolvedPath = path.resolve(process.cwd(), csvPath);
if (!fs.existsSync(resolvedPath)) {
	console.error(`File not found: ${resolvedPath}`);
	process.exit(1);
}

const main = async () => {
	console.log(`Loading local actor: ${actorId} (project: ${projectId})`);
	const localActor = await apex.store.getObject(actorId, true);
	assert(localActor !== undefined, `Local actor not found: ${actorId}`);
	assert(isAPActor(localActor), `Local actor is not an APActor: ${actorId}`);

	console.log(`Reading CSV from ${resolvedPath}`);
	const csvContent = fs.readFileSync(resolvedPath, 'utf-8');
	const accounts = parseFollowingCsv(csvContent);
	console.log(`Parsed ${accounts.length} unique accounts from CSV.`);

	if (accounts.length === 0) {
		console.log('No valid accounts to import.');
		return;
	}

	console.log(`Starting import (dry-run: ${dryRun}, interval: ${intervalMs}ms)...`);

	const result = await importFollowing(localActor, accounts, {
		dryRun,
		intervalMs,
		onProgress: ({ index, total, acct, status, detail }) => {
			const detailStr = detail ? ` (${detail})` : '';
			console.log(`[${index}/${total}] ${acct}: ${status}${detailStr}`);
		},
	});

	console.log('\n=== Import Summary ===');
	console.log(`Total accounts:      ${result.total}`);
	console.log(`Followed:            ${result.followed.length}${dryRun ? ' (dry-run)' : ''}`);
	console.log(`Already following:   ${result.alreadyFollowing.length}`);
	console.log(`Pending approval:    ${result.pendingApproval.length}`);
	console.log(`Skipped self:        ${result.skippedSelf.length}`);
	console.log(`Moved to new actor:  ${result.moved.length}`);
	console.log(`Failed:              ${result.failed.length}`);

	if (result.moved.length > 0) {
		console.log('\n--- Moved Accounts (skipped) ---');
		for (const { acct, movedTo } of result.moved) {
			console.log(`  ${acct} -> movedTo: ${movedTo}`);
		}
	}

	if (result.failed.length > 0) {
		console.log('\n--- Failed Accounts ---');
		for (const { acct, reason } of result.failed) {
			console.log(`  ${acct}: ${reason}`);
		}
	}
};

main().catch((err) => {
	console.error('Fatal error during import:', err);
	process.exit(1);
});
