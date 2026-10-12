import assert from 'node:assert';
import path from 'node:path';
import { apex } from '../src/apex.js';
import { LOCAL_USERNAME, localActorIri } from '../src/localActor.js';
import { importArchiveItems, prepareArchiveSource } from '../src/social/archive.js';
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
const concurrencyArg = args.find((arg) => arg.startsWith('--concurrency='));
const concurrency = concurrencyArg ? parseInt(concurrencyArg.split('=')[1] ?? '5', 10) : 5;
const archivePath = args.find((arg) => !arg.startsWith('--'));

const printUsageAndExit = () => {
	console.error('Usage:');
	console.error(
		'  npx tsx bin/importArchive.ts <path-to-archive.tar.gz|dir|outbox.json> [--dry-run] [--concurrency=5]',
	);
	process.exit(1);
};

if (!archivePath) {
	printUsageAndExit();
}
assert(archivePath !== undefined);

const resolvedPath = path.resolve(process.cwd(), archivePath);

const formatBytes = (bytes: number): string => {
	const mib = (bytes / (1024 * 1024)).toFixed(2);
	const mb = (bytes / 1_000_000).toFixed(2);
	return `${bytes.toLocaleString()} bytes (${mib} MiB / ${mb} MB)`;
};

const main = async () => {
	console.log(`Loading local actor: ${actorId} (project: ${projectId})`);
	const localActor = await apex.store.getObject(actorId, true);
	assert(localActor !== undefined, `Local actor not found: ${actorId}`);
	assert(isAPActor(localActor), `Local actor is not an APActor: ${actorId}`);

	console.log(`Preparing archive from ${resolvedPath}...`);
	const { items, archiveDir, cleanup } = await prepareArchiveSource(resolvedPath);
	try {
		console.log(`Loaded ${items.length} items from archive.`);

		if (items.length === 0) {
			console.log('No items found in archive.');
			return;
		}

		console.log(`Starting import (dry-run: ${dryRun}, concurrency: ${concurrency})...`);

		let lastReported = 0;
		const startTime = Date.now();

		const result = await importArchiveItems(localActor, items, {
			dryRun,
			concurrency,
			archiveDir,
			onProgress: ({ index, total, status, id, visibility, detail }) => {
				if (index - lastReported >= 100 || index === total || status === 'failed') {
					lastReported = index;
					const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
					const visStr = visibility ? ` [${visibility}]` : '';
					const detailStr = detail ? ` (${detail})` : '';
					console.log(
						`[${index}/${total}] (${elapsedSec}s) ${status}${visStr}: ${id ?? ''}${detailStr}`,
					);
				}
			},
		});

		console.log('\n=== Archive Import Summary ===');
		console.log(`Total items in archive: ${result.total}`);
		console.log(`Imported Notes:         ${result.imported.length}${dryRun ? ' (dry-run)' : ''}`);
		console.log(
			`Imported Announces:     ${result.importedAnnounces.length}${dryRun ? ' (dry-run)' : ''}`,
		);
		console.log(`Already exists:         ${result.alreadyExists.length}`);
		console.log(`Skipped Other:          ${result.skippedOther}`);
		console.log(`Failed:                 ${result.failed.length}`);

		console.log('\n--- Visibility Breakdown ---');
		console.log(`Public:                 ${result.visibilityCounts.public}`);
		console.log(`Unlisted:               ${result.visibilityCounts.unlisted}`);
		console.log(`Private (Followers):    ${result.visibilityCounts.private}`);
		console.log(`Direct:                 ${result.visibilityCounts.direct}`);

		console.log('\n--- Media Attachments Summary ---');
		console.log(`Total media files:      ${result.media.totalFiles}`);
		console.log(
			`Uploaded media files:   ${result.media.uploadedFiles}${dryRun ? ' (dry-run)' : ''}`,
		);
		console.log(`Already uploaded:       ${result.media.alreadyUploadedFiles}`);
		console.log(`Total original size:    ${formatBytes(result.media.totalBytes)}`);
		console.log(
			`Uploaded size:          ${formatBytes(result.media.uploadedBytes)}${dryRun ? ' (originals only, dry-run)' : ' (incl. thumbnails)'}`,
		);
		for (const [mediaType, stat] of Object.entries(result.media.byMediaType)) {
			console.log(`  ${mediaType.padEnd(20)} ${stat.count} files, ${formatBytes(stat.bytes)}`);
		}

		if (result.failed.length > 0) {
			console.log('\n--- Failed Items ---');
			for (const { oldUri, reason } of result.failed.slice(0, 20)) {
				console.log(`  ${oldUri ?? 'unknown'}: ${reason}`);
			}
			if (result.failed.length > 20) {
				console.log(`  ... and ${result.failed.length - 20} more failed items.`);
			}
		}
	} finally {
		cleanup?.();
	}
};

main().catch((err) => {
	console.error('Fatal error during import:', err);
	process.exit(1);
});
