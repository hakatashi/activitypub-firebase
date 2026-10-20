import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { apex } from '../src/apex.js';
import { LOCAL_USERNAME, localActorIri } from '../src/localActor.js';
import { importLists, parseListsCsv } from '../src/social/import.js';
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
const follow = !args.includes('--no-follow');
const intervalArg = args.find((arg) => arg.startsWith('--interval-ms='));
const intervalMs = intervalArg ? parseInt(intervalArg.split('=')[1] ?? '1000', 10) : 1000;
const csvPath = args.find((arg) => !arg.startsWith('--'));

const printUsageAndExit = () => {
	console.error('Usage:');
	console.error(
		'  npx tsx bin/importLists.ts <path-to-lists.csv> [--dry-run] [--no-follow] [--interval-ms=1000]',
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

// Mastodon からエクスポートした lists.csv のリストとメンバーをインポートする (→ ADR-0133)。
// フォローしていない相手はフォローしてから足す。`--no-follow` ならフォローせずに飛ばす。
const main = async () => {
	console.log(`Loading local actor: ${actorId} (project: ${projectId})`);
	const localActor = await apex.store.getObject(actorId, true);
	assert(localActor !== undefined, `Local actor not found: ${actorId}`);
	assert(isAPActor(localActor), `Local actor is not an APActor: ${actorId}`);

	console.log(`Reading CSV from ${resolvedPath}`);
	const csvContent = fs.readFileSync(resolvedPath, 'utf-8');
	const rows = parseListsCsv(csvContent);
	console.log(`Parsed ${rows.length} unique rows from CSV.`);

	if (rows.length === 0) {
		console.log('No valid rows to import.');
		return;
	}

	console.log(
		`Starting import (dry-run: ${dryRun}, follow: ${follow}, interval: ${intervalMs}ms)...`,
	);

	const result = await importLists(localActor, rows, {
		dryRun,
		follow,
		intervalMs,
		onProgress: ({ index, total, listName, acct, status, detail }) => {
			const detailStr = detail ? ` (${detail})` : '';
			console.log(`[${index}/${total}] ${listName}: ${acct}: ${status}${detailStr}`);
		},
	});

	const suffix = dryRun ? ' (dry-run)' : '';
	console.log('\n=== Import Summary ===');
	console.log(`Total rows:          ${result.total}`);
	console.log(`Created lists:       ${result.createdLists.length}${suffix}`);
	console.log(`Added:               ${result.added.length}${suffix}`);
	console.log(`Followed and added:  ${result.followedAndAdded.length}${suffix}`);
	console.log(`Already member:      ${result.alreadyMember.length}`);
	console.log(`Not following:       ${result.notFollowing.length}`);
	console.log(`Moved to new actor:  ${result.moved.length}`);
	console.log(`Failed:              ${result.failed.length}`);

	if (result.createdLists.length > 0) {
		console.log('\n--- Created Lists ---');
		for (const title of result.createdLists) {
			console.log(`  ${title}`);
		}
	}

	if (result.notFollowing.length > 0) {
		console.log('\n--- Not Following (skipped) ---');
		for (const { listName, acct } of result.notFollowing) {
			console.log(`  ${listName}: ${acct}`);
		}
	}

	if (result.moved.length > 0) {
		console.log('\n--- Moved Accounts (skipped) ---');
		for (const { listName, acct, movedTo } of result.moved) {
			console.log(`  ${listName}: ${acct} -> movedTo: ${movedTo}`);
		}
	}

	if (result.failed.length > 0) {
		console.log('\n--- Failed Rows ---');
		for (const { listName, acct, reason } of result.failed) {
			console.log(`  ${listName}: ${acct}: ${reason}`);
		}
	}
};

main().catch((err) => {
	console.error('Fatal error during import:', err);
	process.exit(1);
});
