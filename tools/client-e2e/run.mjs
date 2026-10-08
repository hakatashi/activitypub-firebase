// サードパーティ Mastodon クライアント(Elk / Phanpy)で dev 環境の画面を巡回し、
// スクリーンショット・ブラウザの例外・dev への失敗リクエストを out/ に書き出す。
// 手順と前提は docs/runbooks/client-testing.md を参照。
//
//   node run.mjs [--client elk|phanpy|all] [--write] [--post] [--media] [--delete] [--interact] [--profile] [--headed]
//
// アクセストークンは リポジトリルートの .env の MASTODON_DEV_TOKEN を使う。
// トークンは出力のすべてから伏せ字にする。

import { mkdir, rm, writeFile } from 'node:fs/promises';
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
		post: { type: 'boolean', default: false },
		media: { type: 'boolean', default: false },
		delete: { type: 'boolean', default: false },
		interact: { type: 'boolean', default: false },
		profile: { type: 'boolean', default: false },
		headed: { type: 'boolean', default: false },
	},
});

const shouldPost = args.post || args.write;
const shouldPostMedia = args.media || args.write;
const shouldDelete = args.delete || args.write;
const shouldInteract = args.interact || args.write;
const shouldUpdateProfile = args.profile || args.write;

const SERVER = process.env.MASTODON_DEV_HOST ?? 'mastodon-dev.hakatashi.com';
const TOKEN = process.env.MASTODON_DEV_TOKEN;
const ELK_URL = process.env.ELK_URL ?? 'http://127.0.0.1:5314';
const PHANPY_URL = process.env.PHANPY_URL ?? 'http://127.0.0.1:5315';
const OUT_DIR = path.join(import.meta.dirname, 'out');
const MEDIA_FIXTURE = path.join(import.meta.dirname, 'fixtures/avatar.png');

if (!TOKEN) {
	console.error('MASTODON_DEV_TOKEN が未設定です(docs/runbooks/client-testing.md を参照)');
	process.exit(2);
}

const redact = (text) => String(text).replaceAll(TOKEN, '<MASTODON_DEV_TOKEN>');

const api = async (pathname, options = {}) => {
	const res = await fetch(`https://${SERVER}${pathname}`, {
		...options,
		headers: {
			authorization: `Bearer ${TOKEN}`,
			...options.headers,
		},
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`${options.method ?? 'GET'} ${pathname} -> ${res.status}: ${text}`);
	}
	return res.json();
};

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
			favourites: `${ELK_URL}/favourites`,
			bookmarks: `${ELK_URL}/bookmarks`,
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
		async postMedia(page, text, mediaFile) {
			await page.goto(`${ELK_URL}/home`);
			await settle(page);
			const editor = page.locator('.content-editor[contenteditable="true"]').first();
			await editor.click();
			await editor.pressSequentially(text);
			const mediaBtn = page.locator('button:has(.i-ri\\:image-add-line), button[aria-label*="Add images"]').first();
			const uploadPromise = page.waitForResponse(
				(res) => (res.url().includes('/api/v1/media') || res.url().includes('/api/v2/media')) && res.status() < 400,
				{ timeout: 30_000 },
			);
			const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 10_000 });
			await mediaBtn.click();
			const fileChooser = await fileChooserPromise;
			await fileChooser.setFiles(mediaFile);
			await uploadPromise;
			await page.waitForTimeout(1000);
			const postPromise = page.waitForResponse(
				(res) => res.url().includes('/api/v1/statuses') && res.request().method() === 'POST' && res.status() < 400,
				{ timeout: 30_000 },
			);
			await page
				.getByRole('button', { name: /^(Publish|投稿|トゥート)/ })
				.first()
				.click();
			await postPromise;
			await settle(page);
		},
		async deleteStatus(page, statusId, context) {
			await page.goto(`${ELK_URL}/${SERVER}/@${context.me.acct}/${statusId}`);
			await settle(page);
			const moreBtn = page.locator('main button[aria-label="More"]').first();
			await moreBtn.click();
			await page.waitForTimeout(500);
			const deleteBtn = page.locator('button[aria-label="Delete"]').first();
			await deleteBtn.click();
			await page.waitForTimeout(500);
			const deletePromise = page.waitForResponse(
				(res) => res.url().includes(`/api/v1/statuses/${statusId}`) && res.request().method() === 'DELETE' && res.status() === 200,
				{ timeout: 15_000 },
			);
			const confirmBtn = page.locator('.dialog-main button.btn-solid, .dialog-main button').last();
			await confirmBtn.click();
			await deletePromise;
			await settle(page);
		},
		async interactStatus(page, statusId, context) {
			await page.goto(`${ELK_URL}/${SERVER}/@${context.me.acct}/${statusId}`);
			await settle(page);
			const favBtn = page.locator('main button[aria-label="Favorite"]').first();
			const favPromise = page.waitForResponse(
				(res) => res.url().includes(`/api/v1/statuses/${statusId}/favourite`) && res.status() === 200,
				{ timeout: 15_000 },
			);
			await favBtn.click();
			await favPromise;
			await page.waitForTimeout(500);

			const boostBtn = page.locator('main button[aria-label="Boost"]').first();
			const boostPromise = page.waitForResponse(
				(res) => res.url().includes(`/api/v1/statuses/${statusId}/reblog`) && res.status() === 200,
				{ timeout: 15_000 },
			);
			await boostBtn.click();
			await boostPromise;
			await settle(page);
		},
		async updateProfile(page, { displayName }) {
			await page.goto(`${ELK_URL}/settings/profile/appearance`);
			await settle(page);
			const nameInput = page.locator('input[type="text"]').first();
			await nameInput.fill(displayName);
			const updated = page.waitForResponse(
				(res) => res.url().includes('/api/v1/accounts/update_credentials') && res.status() === 200,
				{ timeout: 30_000 },
			);
			const saveBtn = page.locator('button[type="submit"]').first();
			await saveBtn.click();
			await updated;
			await settle(page);
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
			favourites: `${PHANPY_URL}/#/f`,
			bookmarks: `${PHANPY_URL}/#/b`,
		}),
		async post(page, text) {
			await page.goto(`${PHANPY_URL}/#/`);
			await settle(page);
			// 浮動ボタンがスクロール位置によってビューポート外と判定され、click() が待ち続けることがある
			await page.locator('#compose-button').dispatchEvent('click');
			const textarea = page.locator('#compose-container textarea').first();
			await textarea.fill(text);
			await page.locator('#compose-container button[type="submit"]').click();
		},
		async postMedia(page, text, mediaFile) {
			await page.goto(`${PHANPY_URL}/#/`);
			await settle(page);
			await page.locator('#compose-button').dispatchEvent('click');
			await page.waitForSelector('#compose-container');
			const textarea = page.locator('#compose-container textarea').first();
			await textarea.fill(text);
			const fileInput = page.locator('#compose-container input[type="file"]').first();
			await fileInput.setInputFiles(mediaFile);
			await page.waitForSelector('#compose-container .media-attachment, #compose-container [class*="media-attachment"]', { timeout: 10_000 });
			const postPromise = page.waitForResponse(
				(res) => res.url().includes('/api/v1/statuses') && res.request().method() === 'POST' && res.status() < 400,
				{ timeout: 30_000 },
			);
			await page.locator('#compose-container button[type="submit"]').click();
			await postPromise;
			await settle(page);
		},
		async deleteStatus(page, statusId) {
			await page.goto(`${PHANPY_URL}/#/${SERVER}/s/${statusId}`);
			await settle(page);
			const moreBtn = page.locator('.status-deck .actions .more-button, article .actions .more-button').first();
			await moreBtn.click();
			await page.waitForTimeout(500);
			const deleteMenuItem = page.locator('.szh-menu__item, [role="menuitem"]').filter({ hasText: /Delete/i }).first();
			await deleteMenuItem.click();
			await page.waitForTimeout(500);
			const confirmItem = page.locator('.szh-menu__item, [role="menuitem"]').filter({ hasText: /Delete this post\?/i }).first();
			const deletePromise = page.waitForResponse(
				(res) => res.url().includes(`/api/v1/statuses/${statusId}`) && res.request().method() === 'DELETE' && res.status() === 200,
				{ timeout: 15_000 },
			);
			if (await confirmItem.count() > 0) {
				await confirmItem.click();
			}
			await deletePromise;
			await settle(page);
		},
		async interactStatus(page, statusId) {
			await page.goto(`${PHANPY_URL}/#/${SERVER}/s/${statusId}`);
			await settle(page);
			const favBtn = page.locator('.status-deck .actions .favourite-button, article .actions .favourite-button').first();
			const favPromise = page.waitForResponse(
				(res) => res.url().includes(`/api/v1/statuses/${statusId}/favourite`) && res.status() === 200,
				{ timeout: 15_000 },
			);
			await favBtn.click();
			await favPromise;
			await page.waitForTimeout(500);

			const boostBtn = page.locator('.status-deck .actions .reblog-button, article .actions .reblog-button').first();
			await boostBtn.click();
			await page.waitForTimeout(500);
			const boostMenuItem = page.locator('.szh-menu__item, [role="menuitem"]').filter({ hasText: /^Boost/i }).first();
			const boostPromise = page.waitForResponse(
				(res) => res.url().includes(`/api/v1/statuses/${statusId}/reblog`) && res.status() === 200,
				{ timeout: 15_000 },
			);
			await boostMenuItem.click();
			await boostPromise;
			await settle(page);
		},
		async updateProfile(page, { displayName, avatarFile, headerFile }, context) {
			await page.goto(`${PHANPY_URL}/#/${SERVER}/a/${context.me.id}`);
			await settle(page);
			const editBtn = page.getByRole('button', { name: /Edit profile/i });
			await editBtn.click();
			await page.waitForSelector('#edit-profile-container');
			const nameInput = page.locator('#edit-profile-container input[name="display_name"]');
			await nameInput.fill(displayName);
			if (avatarFile) {
				const avatarInput = page.locator('#edit-profile-container input[name="avatar"]');
				if (await avatarInput.count() > 0) {
					await avatarInput.setInputFiles(avatarFile);
				}
			}
			if (headerFile) {
				const headerInput = page.locator('#edit-profile-container input[name="header"]');
				if (await headerInput.count() > 0) {
					await headerInput.setInputFiles(headerFile);
				}
			}
			const fieldNameInput = page.locator('#edit-profile-container input[name="fields_attributes[0][name]"]');
			if (await fieldNameInput.count() > 0) {
				await fieldNameInput.fill('Website');
				await page.locator('#edit-profile-container input[name="fields_attributes[0][value]"]').fill('https://hakatashi.com');
			}
			const updated = page.waitForResponse(
				(res) => res.url().includes('/api/v1/accounts/update_credentials') && res.status() === 200,
				{ timeout: 30_000 },
			);
			const saveBtn = page.locator('#edit-profile-container button[type="submit"]');
			await saveBtn.click();
			await updated;
			await settle(page);
		},
	},
};

const runClient = async (browser, name, context) => {
	const client = clients[name];
	const dir = path.join(OUT_DIR, name);
	await mkdir(dir, { recursive: true });

	const report = {
		client: name,
		server: SERVER,
		pages: [],
		paginatedCollections: { favourites: false, bookmarks: false },
		post: null,
		postMedia: null,
		delete: null,
		interact: null,
		profile: null,
	};
	let current = 'login';
	const errors = [];
	const requests = [];

	const browserContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	const page = await browserContext.newPage();

	if (name === 'elk') {
		// browser-fs-access に showOpenFilePicker ではなく input[type="file"] フォールバックを使わせる
		await page.addInitScript(() => {
			delete window.showOpenFilePicker;
		});
	}

	if (name === 'phanpy') {
		// メディア添付時に代替テキスト未入力時の confirm を承認する
		page.on('dialog', (dialog) => {
			dialog.accept().catch(() => {});
		});
	}

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
		if (url.host === SERVER && url.searchParams.has('max_id')) {
			if (/\/api\/v1\/timelines\//.test(url.pathname)) {
				report.paginated = true;
			}
			const collection = url.pathname.match(/^\/api\/v1\/(favourites|bookmarks)$/)?.[1];
			if (collection !== undefined) {
				report.paginatedCollections[collection] = true;
			}
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

		if (['home', 'favourites', 'bookmarks'].includes(label)) {
			// 2ページ目の読み込みを誘発する
			for (let i = 0; i < 5; i++) {
				await page.mouse.wheel(0, 5000);
				await page.waitForTimeout(1000);
			}
			await settle(page);
			const scrolled = `${String(index++).padStart(2, '0')}-${label}-scrolled.png`;
			await page.screenshot({ path: path.join(dir, scrolled) });
			report.pages.push({ label: `${label}-scrolled`, url, screenshot: path.join(name, scrolled) });
		}
	}

	if (shouldPost) {
		current = 'post';
		const text = `client-e2e (${name}) ${new Date().toISOString()}`;
		await client.post(page, text);
		await page.waitForTimeout(5000);
		await page.screenshot({ path: path.join(dir, `${String(index++).padStart(2, '0')}-post.png`) });
		const statuses = await api(`/api/v1/accounts/${context.me.id}/statuses?limit=5`);
		report.post = { text, found: statuses.some((s) => s.content.includes(text)) };
	}

	if (shouldPostMedia) {
		current = 'post-media';
		const text = `client-e2e media (${name}) ${new Date().toISOString()}`;
		await client.postMedia(page, text, MEDIA_FIXTURE);
		await page.waitForTimeout(5000);
		await page.screenshot({ path: path.join(dir, `${String(index++).padStart(2, '0')}-post-media.png`) });
		const statuses = await api(`/api/v1/accounts/${context.me.id}/statuses?limit=5`);
		const posted = statuses.find((s) => s.content.includes(text));
		report.postMedia = {
			text,
			found: Boolean(posted),
			hasMedia: Boolean(posted?.media_attachments?.length > 0),
		};
	}

	if (shouldDelete) {
		current = 'delete';
		// 削除専用の新規投稿を作成してUIから削除する(--postで投稿したものを消さない)
		const deleteTarget = await api('/api/v1/statuses', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: `client-e2e delete test (${name}) ${new Date().toISOString()}` }),
		});
		await client.deleteStatus(page, deleteTarget.id, context);
		await page.screenshot({ path: path.join(dir, `${String(index++).padStart(2, '0')}-delete.png`) });
		const checkRes = await fetch(`https://${SERVER}/api/v1/statuses/${deleteTarget.id}`, {
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		report.delete = {
			id: deleteTarget.id,
			deleted: checkRes.status === 404,
		};
	}

	if (shouldInteract) {
		current = 'interact';
		// お気に入り・ブースト専用の新規投稿を作成してUIから操作する
		const interactTarget = await api('/api/v1/statuses', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: `client-e2e interact test (${name}) ${new Date().toISOString()}` }),
		});
		await client.interactStatus(page, interactTarget.id, context);
		await page.screenshot({ path: path.join(dir, `${String(index++).padStart(2, '0')}-interact.png`) });
		const check = await api(`/api/v1/statuses/${interactTarget.id}`);
		report.interact = {
			id: interactTarget.id,
			favourited: Boolean(check.favourited),
			reblogged: Boolean(check.reblogged),
		};
	}

	if (shouldUpdateProfile) {
		current = 'profile-edit';
		const testDisplayName = `hakatashi (${name}-${Date.now().toString().slice(-4)})`;
		await client.updateProfile(
			page,
			{
				displayName: testDisplayName,
				avatarFile: path.join(import.meta.dirname, 'fixtures/avatar.png'),
				headerFile: path.join(import.meta.dirname, 'fixtures/header.png'),
			},
			context,
		);
		const file = `${String(index++).padStart(2, '0')}-profile-edit.png`;
		await page.screenshot({ path: path.join(dir, file) });
		const updated = await api('/api/v1/accounts/verify_credentials');
		report.profile = {
			displayName: testDisplayName,
			found: updated.display_name === testDisplayName,
		};
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

let originalAvatarBlob = null;
let originalHeaderBlob = null;
if (shouldUpdateProfile) {
	if (context.me.avatar) {
		originalAvatarBlob = await fetch(context.me.avatar)
			.then((r) => r.blob())
			.catch(() => null);
	}
	if (context.me.header) {
		originalHeaderBlob = await fetch(context.me.header)
			.then((r) => r.blob())
			.catch(() => null);
	}
}

await rm(OUT_DIR, { recursive: true, force: true });
const browser = await chromium.launch({ headless: !args.headed });
const names = args.client === 'all' ? Object.keys(clients) : [args.client];
let failed = false;

try {
	for (const name of names) {
		if (!clients[name]) {
			console.error(`unknown client: ${name}`);
			process.exit(2);
		}
		const report = await runClient(browser, name, context);
		const problems =
			report.errors.length +
			report.failedRequests.length +
			(report.post && !report.post.found ? 1 : 0) +
			(report.postMedia && (!report.postMedia.found || !report.postMedia.hasMedia) ? 1 : 0) +
			(report.delete && !report.delete.deleted ? 1 : 0) +
			(report.interact && (!report.interact.favourited || !report.interact.reblogged) ? 1 : 0) +
			(report.profile && !report.profile.found ? 1 : 0);
		failed ||= problems > 0;
		console.log(
			`\n== ${name}: ${problems === 0 ? 'OK' : `${problems} problem(s)`} (paginated: ${report.paginated}, favourites: ${report.paginatedCollections.favourites}, bookmarks: ${report.paginatedCollections.bookmarks})`,
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
		if (report.postMedia) {
			console.log(
				`  postMedia: ${report.postMedia.found && report.postMedia.hasMedia ? 'found with media in account statuses' : 'FAILED'}`,
			);
		}
		if (report.delete) {
			console.log(`  delete: ${report.delete.deleted ? 'status deleted via UI' : 'FAILED'}`);
		}
		if (report.interact) {
			console.log(
				`  interact: ${report.interact.favourited && report.interact.reblogged ? 'favourited and boosted via UI' : 'FAILED'}`,
			);
		}
		if (report.profile) {
			console.log(`  profile: ${report.profile.found ? 'updated successfully via UI' : 'FAILED'}`);
		}
	}
} finally {
	if (shouldUpdateProfile) {
		console.log('\nRestoring original profile...');
		const formData = new FormData();
		formData.append('display_name', context.me.display_name);
		formData.append('note', context.me.source?.note ?? '');
		if (originalAvatarBlob) {
			formData.append('avatar', originalAvatarBlob, 'avatar.png');
		}
		if (originalHeaderBlob) {
			formData.append('header', originalHeaderBlob, 'header.png');
		}
		await api('/api/v1/accounts/update_credentials', {
			method: 'PATCH',
			body: formData,
		});
		console.log('Original profile restored.');
	}
	await browser.close();
}

console.log(`\nscreenshots and reports: ${OUT_DIR}`);
process.exit(failed ? 1 : 0);
