import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { apex } from '../src/apex.js';
import { LOCAL_USERNAME, localActorIri } from '../src/localActor.js';
import {
	fetchRemoteFollowers,
	formatDomainSummaryTable,
	preDeliverUpdatePerson,
	reconcileMigrationProgress,
} from '../src/social/migration.js';
import type { RemoteFollowerAccount } from '../src/social/migration.js';
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

const getArgValue = (prefix: string): string | undefined => {
	const found = args.find((arg) => arg.startsWith(`${prefix}=`));
	if (found) {
		return found.split('=', 2)[1];
	}
	const index = args.indexOf(prefix);
	if (index !== -1 && index < args.length - 1) {
		return args[index + 1];
	}
	return undefined;
};

const hasFlag = (flag: string): boolean => args.includes(flag);

const printUsageAndExit = () => {
	console.error('Usage:');
	console.error('  npx tsx bin/migrationStatus.ts [options]');
	console.error('');
	console.error('Options:');
	console.error(
		'  --account=<acct-or-id>     Remote account to inspect (default: hakatashi@pawoo.net)',
	);
	console.error(
		'  --instance=<domain>        Remote instance domain (inferred from --account if omitted)',
	);
	console.error('  --file=<path>              Load followers from saved JSON file');
	console.error('  --save=<path>              Save fetched followers to JSON file');
	console.error('  --announce                 Pre-deliver Update(Person) to follower instances');
	console.error('  --dry-run                  Simulate actions without enqueueing deliveries');
	console.error('  --force                    Allow delivery in production project');
	console.error('  --json                     Output result in machine-readable JSON format');
	console.error(
		'  --skip-remote              Skip remote WebFinger resolution for unmatched actors',
	);
	console.error('');
	console.error('Examples:');
	console.error('  # 1. Fetch & save followers:');
	console.error(
		'  npx tsx bin/migrationStatus.ts --account=hakatashi@pawoo.net --save=followers.json',
	);
	console.error('');
	console.error('  # 2. Dry-run pre-delivery:');
	console.error('  npx tsx bin/migrationStatus.ts --file=followers.json --announce --dry-run');
	console.error('');
	console.error('  # 3. Perform pre-delivery (announce):');
	console.error('  npx tsx bin/migrationStatus.ts --file=followers.json --announce');
	console.error('');
	console.error('  # 4. Check migration status progress:');
	console.error('  npx tsx bin/migrationStatus.ts --file=followers.json');
	process.exit(1);
};

if (hasFlag('--help') || hasFlag('-h')) {
	printUsageAndExit();
}

const accountArg = getArgValue('--account') ?? 'hakatashi@pawoo.net';
const instanceArg = getArgValue('--instance');
const filePathArg = getArgValue('--file') ?? getArgValue('--followers-file');
const savePathArg = getArgValue('--save') ?? getArgValue('--save-followers');
const announce = hasFlag('--announce') || hasFlag('--pre-deliver');
const dryRun = hasFlag('--dry-run');
const force = hasFlag('--force');
const outputJson = hasFlag('--json');
const skipRemote = hasFlag('--skip-remote');

const parseAccount = (accountStr: string, explicitInstance?: string) => {
	let clean = accountStr.trim();
	if (clean.startsWith('@')) {
		clean = clean.slice(1);
	}
	if (clean.includes('@')) {
		const [username, host] = clean.split('@', 2);
		return { username: username!, host: explicitInstance ?? host! };
	}
	return { username: clean, host: explicitInstance ?? 'pawoo.net' };
};

const main = async () => {
	const localActor = await apex.store.getObject(actorId, true);
	assert(localActor !== undefined, `Local actor not found: ${actorId}`);
	assert(isAPActor(localActor), `Local actor is not an APActor: ${actorId}`);

	let followers: RemoteFollowerAccount[];

	if (filePathArg) {
		const resolvedFile = path.resolve(process.cwd(), filePathArg);
		if (!fs.existsSync(resolvedFile)) {
			console.error(`File not found: ${resolvedFile}`);
			process.exit(1);
		}
		if (!outputJson) {
			console.log(`Loading followers from file: ${resolvedFile}`);
		}
		const content = fs.readFileSync(resolvedFile, 'utf-8');
		followers = JSON.parse(content) as RemoteFollowerAccount[];
		if (!outputJson) {
			console.log(`Loaded ${followers.length} followers from JSON.`);
		}
	} else {
		const { username, host } = parseAccount(accountArg, instanceArg);
		if (!outputJson) {
			console.log(`Fetching followers for @${username}@${host} from Mastodon API...`);
		}
		followers = await fetchRemoteFollowers(host, username);
		if (!outputJson) {
			console.log(`Fetched ${followers.length} followers.`);
		}
	}

	if (savePathArg) {
		const resolvedSavePath = path.resolve(process.cwd(), savePathArg);
		fs.writeFileSync(resolvedSavePath, JSON.stringify(followers, null, 2), 'utf-8');
		if (!outputJson) {
			console.log(`Saved followers to ${resolvedSavePath}`);
		}
	}

	if (announce) {
		// 事前 Update(Person) 配送モード
		if (projectId === 'activitypub-firebase' && !dryRun && !force) {
			console.error(
				'Refusing to enqueue deliveries in production (activitypub-firebase) without --force flag.',
			);
			process.exit(1);
		}

		if (!outputJson) {
			console.log(
				`Starting pre-delivery of Update(Person) (dry-run: ${dryRun}, project: ${projectId})...`,
			);
		}

		const deliveryResult = await preDeliverUpdatePerson(localActor, followers, {
			dryRun,
			onProgress: ({ index, total, domain: d, endpoint }) => {
				if (!outputJson) {
					console.log(`[${index}/${total}] ${d}: ${endpoint ?? 'unresolved sharedInbox/inbox'}`);
				}
			},
		});

		if (outputJson) {
			console.log(JSON.stringify(deliveryResult, null, 2));
		} else {
			console.log('\n=== Pre-Delivery Summary ===');
			console.log(`Total domains:        ${deliveryResult.totalDomains}`);
			console.log(`Resolved endpoints:   ${deliveryResult.targetEndpoints.length}`);
			console.log(`Unresolved domains:   ${deliveryResult.unresolvedDomains.length}`);
			console.log(`Deliveries enqueued:  ${deliveryResult.enqueued}`);
			if (deliveryResult.activityId) {
				console.log(`Activity ID:          ${deliveryResult.activityId}`);
			}
			if (deliveryResult.unresolvedDomains.length > 0) {
				console.log('\n--- Unresolved Domains ---');
				for (const d of deliveryResult.unresolvedDomains) {
					console.log(`  ${d}`);
				}
			}
		}
		return;
	}

	// 状態突き合わせモード
	if (!outputJson) {
		console.log(`Reconciling migration progress with local store (project: ${projectId})...`);
	}

	const progressResult = await reconcileMigrationProgress(localActor, followers, {
		resolveRemote: !skipRemote,
		onProgress: ({ index, total, acct }) => {
			if (!outputJson && (index % 20 === 0 || index === total)) {
				process.stdout.write(`\rReconciling: [${index}/${total}] ${acct}`.padEnd(60));
			}
		},
	});

	if (!outputJson) {
		process.stdout.write(`${'\r'.padEnd(60)}\r`);
	}

	if (outputJson) {
		console.log(JSON.stringify(progressResult, null, 2));
	} else {
		console.log(formatDomainSummaryTable(progressResult));
	}
};

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
