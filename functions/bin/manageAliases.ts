import assert from 'node:assert';
import { execSync } from 'node:child_process';

const projectId = process.env.GCLOUD_PROJECT ?? 'activitypub-firebase-dev';
assert(
	projectId === 'activitypub-firebase' || projectId === 'activitypub-firebase-dev',
	`GCLOUD_PROJECT must be set to activitypub-firebase or activitypub-firebase-dev, got: ${projectId}`,
);

const domain =
	projectId === 'activitypub-firebase' ? 'hakatashi.com' : 'activitypub-dev.hakatashi.com';

const getAdminToken = (): string => {
	if (process.env.HAKATASHI_TOKEN) {
		return process.env.HAKATASHI_TOKEN;
	}
	const output = execSync(
		`gcloud secrets versions access latest --secret=HAKATASHI_TOKEN --project=${projectId}`,
		{ encoding: 'utf-8' },
	);
	return output.trim();
};

const [action, aliasArg] = process.argv.slice(2);

const printUsageAndExit = () => {
	console.error('Usage:');
	console.error('  npx tsx bin/manageAliases.ts list');
	console.error('  npx tsx bin/manageAliases.ts add <acct-or-uri>');
	console.error('  npx tsx bin/manageAliases.ts remove <acct-or-uri>');
	process.exit(1);
};

if (!action || !['list', 'add', 'remove'].includes(action)) {
	printUsageAndExit();
}

if ((action === 'add' || action === 'remove') && !aliasArg) {
	printUsageAndExit();
}

const main = async () => {
	const token = getAdminToken();
	const baseUrl = `https://${domain}/activitypub/aliases`;

	let res: Response;
	if (action === 'list') {
		res = await fetch(baseUrl, {
			headers: { 'X-Hakatashi-Token': token },
		});
	} else if (action === 'add') {
		res = await fetch(baseUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Hakatashi-Token': token,
			},
			body: JSON.stringify({ alias: aliasArg }),
		});
	} else {
		res = await fetch(baseUrl, {
			method: 'DELETE',
			headers: {
				'Content-Type': 'application/json',
				'X-Hakatashi-Token': token,
			},
			body: JSON.stringify({ alias: aliasArg }),
		});
	}

	const data = await res.json();
	if (!res.ok) {
		console.error(`Error (${res.status}):`, data);
		process.exit(1);
	}

	console.log(JSON.stringify(data, null, 2));
};

main().catch((err) => {
	console.error('Failed to execute command:', err);
	process.exit(1);
});
