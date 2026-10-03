// サードパーティ Mastodon クライアント(Elk / Phanpy)で dev 環境の画面を巡回し、
// スクリーンショット・ブラウザの例外・dev への失敗リクエストを out/ に書き出す。
// 手順と前提は docs/runbooks/client-testing.md を参照。
//
//   node run.mjs [--client elk|phanpy|all] [--write] [--headed]
//
// アクセストークンは リポジトリルートの .env の MASTODON_DEV_TOKEN を使う。
// トークンは出力のすべてから伏せ字にする。

import { mkdir, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const repoRoot = path.resolve(import.meta.dirname, '../..');
try {
	// git worktree から実行するときは ENV_FILE でメインの作業ツリーの .env を指す
	process.loadEnvFile(process.env.ENV_FILE ?? path.join(repoRoot, '.env'));
} catch {
	// .env がなければ環境変数だけを使う
}

const { values: args } = parseArgs({
	options: {
		client: { type: 'string', default: 'all' },
		write: { type: 'boolean', default: false },
		headed: { type: 'boolean', default: false },
	},
});

const SERVER = process.env.MASTODON_DEV_HOST ?? 'mastodon-dev.hakatashi.com';
const TOKEN = process.env.MASTODON_DEV_TOKEN;
const ELK_URL = process.env.ELK_URL ?? 'http://127.0.0.1:5314';
const PHANPY_URL = process.env.PHANPY_URL ?? 'http://127.0.0.1:5315';
const OUT_DIR = path.join(import.meta.dirname, 'out');

if (!TOKEN) {
	console.error('MASTODON_DEV_TOKEN が未設定です(docs/runbooks/client-testing.md を参照)');
	process.exit(2);
}

const redact = (text) => String(text).replaceAll(TOKEN, '<MASTODON_DEV_TOKEN>');

// fetch(undici)は名前解決込みで 10 秒の接続タイムアウトを持つ。HakataMatrix の上流 DNS は
// Firebase Hosting のホスト名への AAAA 問い合わせに 15 秒応答しないため、IPv4 に固定して https で叩く。
const api = (pathname) =>
	new Promise((resolve, reject) => {
		const req = https.get(
			`https://${SERVER}${pathname}`,
			{ family: 4, headers: { authorization: `Bearer ${TOKEN}` } },
			(res) => {
				let body = '';
				res.setEncoding('utf8');
				res.on('data', (chunk) => (body += chunk));
				res.on('end', () => {
					if (res.statusCode >= 400) {
						reject(new Error(`GET ${pathname} -> ${res.statusCode}`));
						return;
					}
					resolve(JSON.parse(body));
				});
			},
		);
		req.on('error', reject);
	});

// 画面がひととおり読み込まれるのを待つ。streaming などで networkidle にならないことがあるので上限付き。
const settle = async (page) => {
	await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
	await page.waitForTimeout(1500);
};

const clients = {
	elk: {
		// Elk の /signin/callback は OAuth のコールバック後に遷移するページで、
		// server と token を受け取って Elk 自身のログイン処理(loginTo)を実行する。
		async login(page) {
			// loginTo の完了より先に画面遷移するので、verify_credentials の応答でログイン完了を待つ
			const verified = page.waitForResponse(
				(res) => res.url().startsWith(`https://${SERVER}/api/v1/accounts/verify_credentials`),
				{ timeout: 60_000 },
			);
			const query = new URLSearchParams({ server: SERVER, token: TOKEN });
			await page.goto(`${ELK_URL}/signin/callback?${query}`);
			if (!(await verified).ok()) {
				throw new Error('Elk: verify_credentials failed');
			}
		},
		urls: ({ me, status }) => ({
			home: `${ELK_URL}/home`,
			notifications: `${ELK_URL}/notifications`,
			profile: `${ELK_URL}/${SERVER}/@${me.acct}`,
			following: `${ELK_URL}/${SERVER}/@${me.acct}/following`,
			followers: `${ELK_URL}/${SERVER}/@${me.acct}/followers`,
			...(status && { status: `${ELK_URL}/${SERVER}/@${status.account.acct}/${status.id}` }),
			'public-local': `${ELK_URL}/${SERVER}/public/local`,
		}),
		async post(page, text) {
			await page.goto(`${ELK_URL}/home`);
			await settle(page);
			const editor = page.locator('.content-editor[contenteditable="true"]').first();
			await editor.click();
			await editor.pressSequentially(text);
			await page
				.getByRole('button', { name: /^(Publish|投稿|トゥート)/ })
				.first()
				.click();
		},
	},
	phanpy: {
		// Phanpy はログイン後の状態を localStorage の accounts / currentAccount だけで持つ
		// (src/utils/api.js の initAccount)。verify_credentials の結果を入れて同じ状態を作る。
		async login(page, { me }) {
			const account = {
				info: me,
				instanceURL: SERVER,
				accessToken: TOKEN,
				createdAt: Date.now(),
			};
			await page.addInitScript(
				([accountJson, id]) => {
					if (!localStorage.getItem('accounts')) {
						localStorage.setItem('accounts', accountJson);
						localStorage.setItem('currentAccount', id);
					}
				},
				[JSON.stringify([account]), me.id],
			);
			await page.goto(`${PHANPY_URL}/`);
		},
		urls: ({ me, status }) => ({
			home: `${PHANPY_URL}/#/`,
			notifications: `${PHANPY_URL}/#/notifications`,
			profile: `${PHANPY_URL}/#/${SERVER}/a/${me.id}`,
			...(status && { status: `${PHANPY_URL}/#/${SERVER}/s/${status.id}` }),
			'public-local': `${PHANPY_URL}/#/${SERVER}/p/l`,
		}),
		async post(page, text) {
			await page.goto(`${PHANPY_URL}/#/`);
			await settle(page);
			await page.locator('#compose-button').click();
			const textarea = page.locator('#compose-container textarea').first();
			await textarea.fill(text);
			await page.locator('#compose-container button[type="submit"]').click();
		},
	},
};

const runClient = async (browser, name, context) => {
	const client = clients[name];
	const dir = path.join(OUT_DIR, name);
	await mkdir(dir, { recursive: true });

	const report = { client: name, server: SERVER, pages: [], post: null };
	let current = 'login';
	const errors = [];
	const requests = [];

	const browserContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	const page = await browserContext.newPage();

	page.on('pageerror', (error) => {
		// Error 以外が throw されると message も stack も空になるので、名前と文字列表現で補う
		const text = error.stack || error.message || `${error.name}: ${String(error)}`;
		// Elk が Chrome 内蔵の Translator / LanguageDetector API を呼んで出る例外。サーバーと無関係
		if (text.includes('Requires a user gesture when availability is')) {
			return;
		}
		errors.push({ page: current, type: 'pageerror', text: redact(text) });
	});
	page.on('console', (msg) => {
		// 失敗したリクエストは response 側で URL 付きで記録するので、ここでは重複させない
		if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource')) {
			errors.push({ page: current, type: 'console', text: redact(msg.text()) });
		}
	});
	page.on('requestfailed', (req) => {
		const failure = req.failure()?.errorText;
		// 画面遷移で中断されたリクエストは問題ではない
		if (failure !== 'net::ERR_ABORTED') {
			requests.push({
				page: current,
				method: req.method(),
				url: redact(req.url()),
				status: null,
				failure,
			});
		}
	});
	page.on('response', (res) => {
		const url = new URL(res.url());
		const entry = {
			page: current,
			method: res.request().method(),
			url: redact(res.url()),
			status: res.status(),
		};
		if (res.status() >= 400) {
			requests.push(entry);
		}
		// スクロールで2ページ目を取りに行ったか(Link ヘッダが効いているか)を見るため
		if (
			url.host === SERVER &&
			/\/api\/v1\/timelines\//.test(url.pathname) &&
			url.searchParams.has('max_id')
		) {
			report.paginated = true;
		}
	});

	await client.login(page, context);
	await settle(page);
	await page.screenshot({ path: path.join(dir, '00-login.png') });

	let index = 1;
	for (const [label, url] of Object.entries(client.urls(context))) {
		current = label;
		await page.goto(url);
		await settle(page);
		const file = `${String(index++).padStart(2, '0')}-${label}.png`;
		await page.screenshot({ path: path.join(dir, file) });
		report.pages.push({ label, url, screenshot: path.join(name, file) });

		if (label === 'home') {
			// 2ページ目の読み込みを誘発する
			for (let i = 0; i < 5; i++) {
				await page.mouse.wheel(0, 5000);
				await page.waitForTimeout(1000);
			}
			await settle(page);
			const scrolled = `${String(index++).padStart(2, '0')}-home-scrolled.png`;
			await page.screenshot({ path: path.join(dir, scrolled) });
			report.pages.push({ label: 'home-scrolled', url, screenshot: path.join(name, scrolled) });
		}
	}

	if (args.write) {
		current = 'post';
		const text = `client-e2e (${name}) ${new Date().toISOString()}`;
		await client.post(page, text);
		await page.waitForTimeout(5000);
		await page.screenshot({ path: path.join(dir, `${String(index++).padStart(2, '0')}-post.png`) });
		const statuses = await api(`/api/v1/accounts/${context.me.id}/statuses?limit=5`);
		report.post = { text, found: statuses.some((s) => s.content.includes(text)) };
	}

	report.paginated ??= false;
	report.errors = errors;
	report.failedRequests = requests;
	await writeFile(path.join(dir, 'report.json'), `${JSON.stringify(report, null, '\t')}\n`);
	await browserContext.close();
	return report;
};

const me = await api('/api/v1/accounts/verify_credentials');
const [status] = await api('/api/v1/timelines/home?limit=1');
const context = { me, status };

await rm(OUT_DIR, { recursive: true, force: true });
const browser = await chromium.launch({ headless: !args.headed });
const names = args.client === 'all' ? Object.keys(clients) : [args.client];
let failed = false;
for (const name of names) {
	if (!clients[name]) {
		console.error(`unknown client: ${name}`);
		process.exit(2);
	}
	const report = await runClient(browser, name, context);
	const problems =
		report.errors.length +
		report.failedRequests.length +
		(report.post && !report.post.found ? 1 : 0);
	failed ||= problems > 0;
	console.log(
		`\n== ${name}: ${problems === 0 ? 'OK' : `${problems} problem(s)`} (paginated: ${report.paginated})`,
	);
	for (const r of report.failedRequests) {
		console.log(`  [${r.page}] ${r.method} ${r.status ?? r.failure} ${r.url}`);
	}
	for (const e of report.errors) {
		console.log(`  [${e.page}] ${e.type}: ${e.text.split('\n')[0]}`);
	}
	if (report.post) {
		console.log(`  post: ${report.post.found ? 'found in account statuses' : 'NOT FOUND'}`);
	}
}
await browser.close();
console.log(`\nscreenshots and reports: ${OUT_DIR}`);
process.exit(failed ? 1 : 0);
