import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { apex } from '../src/apex.js';
import { LOCAL_USERNAME, localActorIri } from '../src/localActor.js';
import { importBookmarks, parseBookmarksCsv } from '../src/social/import.js';
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
		'  npx tsx bin/importBookmarks.ts <path-to-bookmarks.csv> [--dry-run] [--interval-ms=1000]',
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
	const urls = parseBookmarksCsv(csvContent);
	console.log(`Parsed ${urls.length} unique URLs from CSV.`);

	if (urls.length === 0) {
		console.log('No valid URLs to import.');
		return;
	}

	console.log(`Starting import (dry-run: ${dryRun}, interval: ${intervalMs}ms)...`);

	const result = await importBookmarks(localActor, urls, {
		dryRun,
		intervalMs,
		onProgress: ({ index, total, url, status, detail }) => {
			const detailStr = detail ? ` (${detail})` : '';
			console.log(`[${index}/${total}] ${url}: ${status}${detailStr}`);
		},
	});

	console.log('\n=== Import Summary ===');
	console.log(`Total URLs:          ${result.total}`);
	console.log(`Bookmarked:          ${result.bookmarked.length}${dryRun ? ' (dry-run)' : ''}`);
	console.log(`Already bookmarked:  ${result.alreadyBookmarked.length}`);
	console.log(`Failed:              ${result.failed.length}`);

	if (result.failed.length > 0) {
		console.log('\n--- Failed URLs ---');
		for (const { url, reason } of result.failed) {
			console.log(`  ${url}: ${reason}`);
		}
	}
};

main().catch((err) => {
	console.error('Fatal error during import:', err);
	process.exit(1);
});
