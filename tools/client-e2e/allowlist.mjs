// docs/runbooks/client-testing.md の「既知の出力」に基づく許可リスト判定。
// クライアント(Elk / Phanpy)の正常動作や dev サーバーの障害に起因しない
// 既知の出力を判定し、CI の誤検知を防止する。

export const isKnownBenignRequest = (entry, serverHost = 'mastodon-dev.hakatashi.com') => {
	const urlStr = entry.url;
	let parsedUrl;
	try {
		parsedUrl = new URL(urlStr);
	} catch {
		parsedUrl = null;
	}

	// 1. Web Push 購読の 404 (Elk: Web Push 未実装。購読がないときの 404 は Mastodon と同じ挙動)
	if (entry.method === 'GET' && entry.status === 404 && parsedUrl?.pathname === '/api/v1/push/subscription') {
		return { reason: 'Web Push subscription 404 (not implemented / expected without subscription)' };
	}

	// 2. Blob URL の破棄 (Phanpy: 投稿後にプレビュー用の Object URL を破棄したもの)
	if (urlStr.startsWith('blob:') || (entry.failure === 'net::ERR_FILE_NOT_FOUND' && urlStr.startsWith('blob:'))) {
		return { reason: 'Blob URL cleanup' };
	}

	// 3. 外部ホストへのリクエストの失敗 (リモートの画像・アバター・OGP プレビューカード、外部サービスのレート制限や CORS など)
	if (parsedUrl && parsedUrl.host !== serverHost && !parsedUrl.host.startsWith('127.0.0.1')) {
		return { reason: `External third-party resource failure (${parsedUrl.host})` };
	}

	// 4. Cloud Storage のエッジキャッシュ伝播前の古いエラー等によるメディア取得失敗
	if (
		entry.failure === 'net::ERR_FAILED' ||
		entry.failure === 'net::ERR_NAME_NOT_RESOLVED' ||
		entry.failure === 'net::ERR_BLOCKED_BY_ORB'
	) {
		const isMediaOrAvatar =
			urlStr.includes('/accounts/avatars/') ||
			urlStr.includes('/headers/') ||
			urlStr.includes('/system/') ||
			urlStr.includes('/media_attachments/') ||
			urlStr.includes('/identicon/');
		if (isMediaOrAvatar) {
			return { reason: 'GCS cache edge failure' };
		}
	}

	return null;
};

export const isKnownBenignError = (entry) => {
	const text = entry.text ?? '';

	// 1. 画面遷移による中断 (Phanpy: 画面遷移で前の画面の fetch を中断したもの)
	if (text.includes('AbortError') || text.includes('signal is aborted without reason')) {
		return { reason: 'Navigation fetch abort' };
	}

	// 2. リモート画像取得時の CORS ポリシー警告コンソール出力
	if (
		text.includes('blocked by CORS policy') ||
		text.includes('Access-Control-Allow-Origin') ||
		text.includes('net::ERR_FAILED')
	) {
		return { reason: 'External media CORS policy warning' };
	}

	return null;
};
