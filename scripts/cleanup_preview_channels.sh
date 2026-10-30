#!/usr/bin/env bash
# クローズ済み PR の Firebase Hosting preview channel を削除する。
# channel 数が上限に達すると PR の CI が 429 (channel quota reached) で失敗するための掃除用。
#
#   scripts/cleanup_preview_channels.sh            # 削除対象を表示するだけ (dry run)
#   scripts/cleanup_preview_channels.sh --delete   # 実際に削除する
#
# 残すもの: live、オープン中の PR (`pr<番号>-...`) の channel、`pr<番号>-` 形式でない channel。
# 前提: gh と jq が使え、gh / firebase CLI がログイン済みであること。
set -uo pipefail

cd "$(dirname "$0")/.."

DELETE=false
[ "${1:-}" = "--delete" ] && DELETE=true

if [ -x functions/node_modules/.bin/firebase ]; then
	FIREBASE=functions/node_modules/.bin/firebase
else
	FIREBASE=firebase
fi

# プロジェクト:サイト (.github/workflows/firebase-hosting-pull-request.yml の matrix と対応)
SITES=(
	activitypub-firebase:hakatashi-mastodon
	activitypub-firebase:activitypub-firebase
	activitypub-firebase-dev:hakatashi-mastodon-dev
	activitypub-firebase-dev:activitypub-firebase-dev
	activitypub-firebase-bots:activitypub-firebase-bots
)

OPEN=" $(gh pr list --state open --limit 200 --json number --jq '.[].number' | tr '\n' ' ')"
if [ "$OPEN" = " " ]; then
	echo "オープン中の PR を取得できなかったため中止する" >&2
	exit 1
fi

for entry in "${SITES[@]}"; do
	project=${entry%%:*}
	site=${entry##*:}
	channels=$("$FIREBASE" hosting:channel:list --json --project "$project" --site "$site" 2>/dev/null |
		jq -r '.result.channels[].name | split("/")[-1]') || {
		echo "FAIL list $site" >&2
		continue
	}
	for id in $channels; do
		[ "$id" = live ] && continue
		num=$(echo "$id" | sed -n 's/^pr\([0-9]*\)-.*/\1/p')
		[ -z "$num" ] && continue
		case "$OPEN" in *" $num "*) continue ;; esac
		if $DELETE; then
			if "$FIREBASE" hosting:channel:delete "$id" --force --project "$project" --site "$site" >/dev/null 2>&1; then
				echo "deleted $site $id"
			else
				echo "FAIL delete $site $id" >&2
			fi
		else
			echo "would delete $site $id"
		fi
	done
done
