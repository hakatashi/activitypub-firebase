#!/usr/bin/env bash
# 移行前の点検 (→ #263、docs/runbooks/production-preflight-check.md)。
# **読み取りだけを行う。** Firestore への書き込み・配送・再送は一切しない。
#
#   functions/bin/preflightCheck.sh [activitypub-firebase | activitypub-firebase-dev] [section...]
#
# section は data / infra / logs / external のいずれか (省略時はすべて)。
# 秘密鍵・HAKATASHI_TOKEN は出力しない。
set -uo pipefail

PROJECT="${1:-activitypub-firebase}"
shift || true
SECTIONS="${*:-data infra logs external}"

case "$PROJECT" in
activitypub-firebase)
	DOMAIN=hakatashi.com
	;;
activitypub-firebase-dev)
	DOMAIN=activitypub-dev.hakatashi.com
	;;
*)
	echo "unknown project: $PROJECT" >&2
	exit 1
	;;
esac

FUNCTIONS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(dirname "$FUNCTIONS_DIR")"
ACTOR="https://$DOMAIN/activitypub/u/hakatashi"
AS='Accept: application/activity+json'
LOCATION="${LOCATION:-asia-northeast1}"
FRESHNESS="${FRESHNESS:-30d}"

section() { printf '\n\033[1m## %s\033[0m\n' "$*"; }
item() { printf '\n### %s\n' "$*"; }

# 1. データの整合性 -----------------------------------------------------------
if [[ " $SECTIONS " == *" data "* ]]; then
	section "1. データの整合性 ($PROJECT)"
	export GCLOUD_PROJECT="$PROJECT"
	export FIREBASE_CONFIG="{\"projectId\":\"$PROJECT\"}"
	# ログ (JSON の構造化ログ) は捨て、各スクリプトの集計結果だけを出す。
	for script in \
		backfillFollowProjection \
		backfillReactionProjection \
		backfillNotificationProjection \
		backfillRepliesCount \
		backfillObjectQueryMeta \
		backfillActivityQueryMeta \
		backfillPublishedMeta \
		backfillBookmarkCursor \
		assignMastodonIds \
		reconcilePendingFollows; do
		item "$script --dry-run"
		(cd "$FUNCTIONS_DIR" && npx tsx "bin/$script.ts" --dry-run 2>&1 | grep -v '^{"')
	done
	item "checkActorKeyPair"
	(cd "$FUNCTIONS_DIR" && npx tsx bin/checkActorKeyPair.ts 2>&1 | grep -v '^{"')

	item "followers コレクションの重複"
	url="$ACTOR/followers?page=true"
	followers=""
	while [[ -n "$url" && "$url" != null ]]; do
		page="$(curl -sf -H "$AS" "$url")" || break
		followers+="$(jq -r '.orderedItems[]?' <<<"$page")"$'\n'
		url="$(jq -r '.next // empty' <<<"$page")"
	done
	total="$(curl -sf -H "$AS" "$ACTOR/followers" | jq '.totalItems')"
	listed="$(grep -c . <<<"$followers")"
	unique="$(grep . <<<"$followers" | sort -u | wc -l)"
	echo "totalItems=$total listed=$listed unique=$unique"
	grep . <<<"$followers" | sort | uniq -d | sed 's/^/  duplicate: /'
fi

# 2. 設定とインフラ ------------------------------------------------------------
if [[ " $SECTIONS " == *" infra "* ]]; then
	section "2. 設定とインフラ ($PROJECT)"

	item "main の自動デプロイ (直近5回) と各 Function の最終更新"
	# Hosting だけ成功して Functions のデプロイが失敗することがある (→ #280)。ジョブ単位で見る。
	for run in $(gh run list --workflow main.yml --branch main --limit 5 --json databaseId --jq '.[].databaseId'); do
		gh run view "$run" --json createdAt,displayTitle,jobs \
			--jq '"\(.createdAt)\t\(.displayTitle[0:50])\t" + ([.jobs[] | select(.name | test("\\('"$PROJECT"',")) | "\(.name | split(" (")[0]):\(.conclusion)"] | join(" / "))'
	done
	gcloud functions list --project="$PROJECT" --format='value(name.basename(),updateTime)' | sort -k2

	item "Firestore インデックス (firestore.indexes.json との差分。__name__ は除く)"
	deployed="$(cd "$FUNCTIONS_DIR" && npx firebase firestore:indexes --project "$PROJECT" 2>/dev/null)"
	normalize='[.indexes[] | {collectionGroup, queryScope, fields: [.fields[] | select(.fieldPath != "__name__") | {fieldPath, order, arrayConfig} | with_entries(select(.value != null))]} | tojson]'
	jq -n \
		--argjson want "$(jq -c "$normalize" "$ROOT_DIR/firestore.indexes.json")" \
		--argjson have "$(jq -c "$normalize" <<<"$deployed")" \
		'{defined: ($want | length), deployed: ($have | length),
		  missing: ($want - $have | map(fromjson)),
		  extra: ($have - $want | map(fromjson | "\(.collectionGroup): \(.fields | map(.fieldPath) | join(","))") | unique)}'

	item "TTL ポリシー (firestore.indexes.json の fieldOverrides で ttl: true のもの)"
	jq -r '.fieldOverrides[] | select(.ttl) | "  defined: \(.collectionGroup)/\(.fieldPath)"' "$ROOT_DIR/firestore.indexes.json"
	gcloud firestore fields ttls list --project="$PROJECT" --format='value(name,ttlConfig.state)' |
		sed -E 's|.*/collectionGroups/([^/]+)/fields/([^\t ]+)|  deployed: \1/\2|'

	for queue in deliveryTask remoteActorRefreshTask; do
		item "Cloud Tasks: $queue"
		gcloud tasks queues describe "$queue" --location="$LOCATION" --project="$PROJECT" \
			--format='yaml(state,rateLimits,retryConfig)'
		echo "pending tasks: $(gcloud tasks list --queue="$queue" --location="$LOCATION" --project="$PROJECT" --format='value(name)' | wc -l)"
	done
	echo "(コード上の設定は functions/src/tasks.ts の rateLimits / retryConfig)"

	item "HAKATASHI_TOKEN (Secret Manager) で管理者エンドポイントに入れるか"
	token="$(gcloud secrets versions access latest --secret=HAKATASHI_TOKEN --project="$PROJECT" 2>/dev/null)"
	if [[ -z "$token" ]]; then
		echo "NG: secret を読めない"
	else
		status="$(curl -s -o /dev/null -w '%{http_code}' -H "X-Hakatashi-Token: $token" "https://$DOMAIN/activitypub/deliveries/failed")"
		echo "GET /activitypub/deliveries/failed -> $status"
	fi
fi

# 3. ログと配送の記録 -----------------------------------------------------------
if [[ " $SECTIONS " == *" logs "* ]]; then
	section "3. ログと配送の記録 ($PROJECT, 直近 $FRESHNESS)"

	item "severity>=ERROR の件数 (サービス / jsonPayload.type ごと)"
	gcloud logging read 'severity>=ERROR' --project="$PROJECT" --freshness="$FRESHNESS" --limit=20000 \
		--format='value(resource.labels.service_name,jsonPayload.type)' | sort | uniq -c | sort -rn

	item "inbox (POST .../inbox) の応答ステータス"
	inbox_filter="resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"activitypub\" AND logName=\"projects/$PROJECT/logs/run.googleapis.com%2Frequests\" AND httpRequest.requestMethod=\"POST\" AND httpRequest.requestUrl:\"/inbox\""
	gcloud logging read "$inbox_filter" --project="$PROJECT" --freshness="$FRESHNESS" --limit=50000 \
		--format='value(httpRequest.status)' | sort | uniq -c
	echo "4xx の内訳 (日時 / ステータス / 送信元の User-Agent):"
	gcloud logging read "$inbox_filter AND httpRequest.status>=400 AND httpRequest.status<500" \
		--project="$PROJECT" --freshness="$FRESHNESS" --limit=200 \
		--format='value(timestamp,httpRequest.status,httpRequest.userAgent)'

	item "失敗・リトライ中の配送 (宛先ホスト / status / statusCode / attempts ごと)"
	token="${token:-$(gcloud secrets versions access latest --secret=HAKATASHI_TOKEN --project="$PROJECT" 2>/dev/null)}"
	curl -sf -H "X-Hakatashi-Token: $token" "https://$DOMAIN/activitypub/deliveries/failed" |
		jq -r '.[] | "\(.inbox | split("/")[2])\t\(.status)\t\(.statusCode)\tattempts=\(.attempts)\t\(.error // "" | .[0:80])"' |
		sort | uniq -c | sort -rn
fi

# 4. 外部から見た状態 -----------------------------------------------------------
if [[ " $SECTIONS " == *" external "* ]]; then
	section "4. 外部から見た状態 ($DOMAIN)"

	item "WebFinger (acct:hakatashi@$DOMAIN)"
	curl -s "https://$DOMAIN/.well-known/webfinger?resource=acct:hakatashi@$DOMAIN" | jq -c .

	item "nodeinfo"
	nodeinfo="$(curl -s "https://$DOMAIN/.well-known/nodeinfo" | jq -r '.links[0].href')"
	curl -s "$nodeinfo" | jq -c '{version, software, openRegistrations, usage}'

	item "actor"
	curl -s -H "$AS" "$ACTOR" |
		jq '{id, type, preferredUsername, name, inbox, outbox, followers, following, endpoints, url,
		     publicKey: (.publicKey | {id, owner}), alsoKnownAs, movedTo, icon: .icon.url, image: .image.url}'
	echo "Accept: text/html での actor IRI: $(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -H 'Accept: text/html' "$ACTOR")"

	item "activitypub-testing (passed / inapplicable / cantTell / failed の件数)"
	npx -y activitypub-testing test actor "$ACTOR" 2>/dev/null | grep "^{" |
		jq -r 'select(.type == ["Assertion"]) | "\(.result.outcome)\t\(.test.slug)"' | sort
fi
