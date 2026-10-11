#!/usr/bin/env bash
# Follow 殺到の負荷試験 (dev) (→ Issue #271, docs/runbooks/federation-testing.md)
#
# Usage:
#   functions/bin/loadTestFollowRush.sh [create|follow|status|post|unfollow|cleanup|metrics|all] [COUNT]
#
# Example:
#   functions/bin/loadTestFollowRush.sh create 500
#   functions/bin/loadTestFollowRush.sh follow 500
#   functions/bin/loadTestFollowRush.sh status 500
#   functions/bin/loadTestFollowRush.sh post
#   functions/bin/loadTestFollowRush.sh unfollow 500
#   functions/bin/loadTestFollowRush.sh cleanup 500

set -euo pipefail

export PATH="$HOME/.asdf/shims:$HOME/.asdf/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT_DIR"

if [[ -f .env ]]; then
	set -a
	# shellcheck disable=SC1091
	source .env
	set +a
fi

ACTION="${1:-all}"
COUNT="${2:-500}"
PREFIX="loadtest_"
DEV_DOMAIN="activitypub-dev.hakatashi.com"
TARGET_ACCOUNT="hakatashi"
TARGET_ACCT="${TARGET_ACCOUNT}@${DEV_DOMAIN}"
DEV_URL="https://${DEV_DOMAIN}"
DEV_ACTOR="${DEV_URL}/activitypub/u/${TARGET_ACCOUNT}"
MT="${MT:-/opt/mastodon-test}"

m_runner() {
	(cd "$MT" && docker compose exec -T web bin/rails runner "$@")
}

check_prerequisites() {
	if [[ ! -d "$MT" ]]; then
		echo "Error: Mastodon test directory $MT not found" >&2
		exit 1
	fi
}

clear_circuit_breaker() {
	(cd "$MT" && docker compose exec -T redis redis-cli del "stoplight:v5:metadata:${DEV_ACTOR}/inbox" >/dev/null 2>&1 || true)
}

cmd_create() {
	echo "=== Creating $COUNT test accounts ($PREFIX*) on mastodon-test ==="
	clear_circuit_breaker
	m_runner "
target_count = $COUNT
t0 = Time.now
created = 0
existing = 0
1.upto(target_count) do |i|
  username = sprintf('${PREFIX}%04d', i)
  account = Account.find_local(username)
  if account
    existing += 1
    if account.user_pending?
      account.user.update_column(:approved, true)
    end
    next
  end
  user = User.new(
    email: \"#{username}@mastodon-test.hakatashi.com\",
    password: SecureRandom.hex,
    agreement: true,
    bypass_registration_checks: true,
    confirmed_at: Time.now.utc,
    approved: true
  )
  user.skip_confirmation_notification! if user.respond_to?(:skip_confirmation_notification!)
  user.account = Account.new(username: username)
  user.save!
  user.update_column(:approved, true)
  created += 1
  if (created + existing) % 50 == 0 || (created + existing) == target_count
    puts \"Accounts processed: #{created + existing}/#{target_count} (#{created} created, #{existing} existing) in #{(Time.now - t0).round(1)}s\"
  end
end
puts \"Finished. Total: #{created + existing} accounts ready in #{(Time.now - t0).round(2)}s.\"
"
}

cmd_follow() {
	echo "=== Triggering Follow rush from $COUNT accounts to $TARGET_ACCT ==="
	clear_circuit_breaker

	# Clear any leftover FollowRequest for target to ensure fresh Follow activities
	m_runner "
target = Account.find_remote('${TARGET_ACCOUNT}', '${DEV_DOMAIN}')
raise 'Remote target account not found on Mastodon' unless target
FollowRequest.where(target_account: target).destroy_all
Sidekiq::RetrySet.new.clear
"

	START_ISO="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
	echo "Follow rush start timestamp (UTC): $START_ISO"
	echo "$START_ISO" > /tmp/loadtest_follow_start.txt

	m_runner "
target = Account.find_remote('${TARGET_ACCOUNT}', '${DEV_DOMAIN}')
accounts = Account.where('username LIKE ?', '${PREFIX}%').order(:id).limit($COUNT).to_a
puts \"Found #{accounts.size} test accounts. Starting follow enqueue...\"

t0 = Time.now
enqueued = 0
accounts.each do |account|
  FollowService.new.call(account, target)
  enqueued += 1
  if enqueued % 50 == 0 || enqueued == accounts.size
    puts \"Follow enqueued: #{enqueued}/#{accounts.size} in #{(Time.now - t0).round(2)}s\"
  end
end
puts \"All #{enqueued} follow requests enqueued in #{(Time.now - t0).round(2)}s.\"
"
}

cmd_status() {
	echo "=== Checking Follow & Acceptance Status ==="
	m_runner "
target = Account.find_remote('${TARGET_ACCOUNT}', '${DEV_DOMAIN}')
accounts = Account.where('username LIKE ?', '${PREFIX}%').order(:id).limit($COUNT).to_a

following = 0
requested = 0
neither = 0

accounts.each do |account|
  if account.following?(target)
    following += 1
  elsif account.requested?(target)
    requested += 1
  else
    neither += 1
  end
end

puts \"[Mastodon side] Total test accounts: #{accounts.size}\"
puts \"  following (Accept received): #{following}\"
puts \"  requested (Pending Accept) : #{requested}\"
puts \"  neither                    : #{neither}\"
puts \"  Sidekiq retry set size     : #{Sidekiq::RetrySet.new.size}\"
puts \"  Sidekiq push queue size    : #{Sidekiq::Queue.new('push').size}\"
"

	echo "--- [dev side] Followers collection & userInfos ---"
	curl -sH 'Accept: application/activity+json' "${DEV_ACTOR}/followers" | jq '{totalItems}'

	if command -v gcloud >/dev/null 2>&1; then
		GCP_TOKEN="$(gcloud auth print-access-token 2>/dev/null || true)"
		if [[ -n "$GCP_TOKEN" ]]; then
			ESC_KEY="https:%2F%2Factivitypub-dev%252Ehakatashi%252Ecom%2Factivitypub%2Fu%2F${TARGET_ACCOUNT}"
			curl -s -H "Authorization: Bearer $GCP_TOKEN" \
				"https://firestore.googleapis.com/v1/projects/activitypub-firebase-dev/databases/(default)/documents/userInfos/${ESC_KEY}" \
				| jq -c '{followers_count: .fields.followers_count.integerValue, statuses_count: .fields.statuses_count.integerValue}' 2>/dev/null || true

			echo "--- [dev side] Cloud Tasks deliveryTask queue depth ---"
			gcloud tasks list --queue=deliveryTask --location=us-central1 --project=activitypub-firebase-dev --format="table(name,scheduleTime,dispatchCount)" | head -n 10
		fi
	fi
}

cmd_post() {
	echo "=== Posting new status from dev and measuring fan-out ==="
	HAKATASHI_TOKEN="${HAKATASHI_TOKEN:-$(gcloud secrets versions access latest --secret=HAKATASHI_TOKEN --project=activitypub-firebase-dev 2>/dev/null || true)}"
	if [[ -z "$HAKATASHI_TOKEN" ]]; then
		echo "Error: HAKATASHI_TOKEN is required for createPost" >&2
		exit 1
	fi

	POST_TIME="$(date +%s)"
	TEXT="load test fan-out at $(date -u) ($POST_TIME)"
	echo "Posting status: $TEXT"
	START_TS=$(date +%s%N)
	RES=$(curl -s -w "\n%{http_code}\n%{time_total}" -X POST "${DEV_URL}/activitypub/createPost" \
		-H 'Content-Type: application/json' \
		-H "X-Hakatashi-Token: ${HAKATASHI_TOKEN}" \
		-d "{\"text\": \"${TEXT}\"}")
	END_TS=$(date +%s%N)

	HTTP_CODE=$(echo "$RES" | tail -n 2 | head -n 1)
	TIME_TOTAL=$(echo "$RES" | tail -n 1)
	BODY=$(echo "$RES" | sed '$d' | sed '$d')

	echo "createPost HTTP response: $HTTP_CODE (took ${TIME_TOTAL}s)"
	echo "Response body: $BODY"

	echo "Checking delivery queue after posting..."
	sleep 2
	gcloud tasks list --queue=deliveryTask --location=us-central1 --project=activitypub-firebase-dev --format="table(name,scheduleTime,dispatchCount)" | head -n 15
}

cmd_unfollow() {
	echo "=== Triggering Unfollow from $COUNT accounts to $TARGET_ACCT ==="
	clear_circuit_breaker
	UNFOLLOW_START_ISO="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
	echo "Unfollow start timestamp (UTC): $UNFOLLOW_START_ISO"
	echo "$UNFOLLOW_START_ISO" > /tmp/loadtest_unfollow_start.txt

	m_runner "
target = Account.find_remote('${TARGET_ACCOUNT}', '${DEV_DOMAIN}')
raise 'Remote target account not found on Mastodon' unless target

accounts = Account.where('username LIKE ?', '${PREFIX}%').order(:id).limit($COUNT).to_a
puts \"Found #{accounts.size} test accounts. Starting unfollow enqueue...\"

t0 = Time.now
enqueued = 0
accounts.each do |account|
  UnfollowService.new.call(account, target)
  enqueued += 1
  if enqueued % 50 == 0 || enqueued == accounts.size
    puts \"Unfollow enqueued: #{enqueued}/#{accounts.size} in #{(Time.now - t0).round(2)}s\"
  end
end
puts \"All #{enqueued} unfollow requests enqueued in #{(Time.now - t0).round(2)}s.\"
"
}

cmd_cleanup() {
	echo "=== Cleaning up $COUNT test accounts ($PREFIX*) on mastodon-test ==="
	m_runner "
accounts = Account.where('username LIKE ?', '${PREFIX}%').order(:id).limit($COUNT).to_a
puts \"Deleting #{accounts.size} test accounts...\"
t0 = Time.now
deleted = 0
accounts.each do |account|
  account.user&.destroy
  account.destroy
  deleted += 1
  if deleted % 50 == 0 || deleted == accounts.size
    puts \"Deleted #{deleted}/#{accounts.size} in #{(Time.now - t0).round(2)}s\"
  end
end
puts \"Finished deleting #{deleted} accounts in #{(Time.now - t0).round(2)}s.\"
"
}

cmd_metrics() {
	START_TIME="${2:-}"
	if [[ -z "$START_TIME" && -f /tmp/loadtest_follow_start.txt ]]; then
		START_TIME="$(cat /tmp/loadtest_follow_start.txt)"
	fi
	if [[ -z "$START_TIME" ]]; then
		START_TIME="$(date -u -d '1 hour ago' +"%Y-%m-%dT%H:%M:%SZ")"
	fi
	echo "=== Analyzing Cloud Logging Metrics since $START_TIME ==="

	FILTER="resource.labels.service_name=\"activitypub\" AND logName=~\"requests\" AND httpRequest.requestUrl=~\"/inbox\" AND timestamp>=\"${START_TIME}\""
	echo "Reading request logs with filter: $FILTER"

	# node script to aggregate metrics
	node -e '
const { execSync } = require("child_process");
const filter = process.argv[1];
console.log("Fetching logs from gcloud...");
const output = execSync(
  `gcloud logging read ${JSON.stringify(filter)} --project=activitypub-firebase-dev --format=json`,
  { maxBuffer: 100 * 1024 * 1024, encoding: "utf8" }
);
const logs = JSON.parse(output || "[]");
console.log(`Total inbox requests fetched: ${logs.length}`);

const statusCounts = {};
const latencies = [];

for (const entry of logs) {
  const status = entry.httpRequest?.status || "unknown";
  statusCounts[status] = (statusCounts[status] || 0) + 1;
  const latStr = entry.httpRequest?.latency;
  if (latStr) {
    const sec = parseFloat(latStr.replace("s", ""));
    if (!isNaN(sec)) latencies.push(sec);
  }
}

latencies.sort((a, b) => a - b);
const p = (pct) => {
  if (latencies.length === 0) return 0;
  const idx = Math.floor((pct / 100) * latencies.length);
  return latencies[Math.min(idx, latencies.length - 1)];
};

console.log("\n--- HTTP Status Distribution ---");
for (const [st, cnt] of Object.entries(statusCounts)) {
  console.log(`  ${st}: ${cnt}`);
}

console.log("\n--- Latency Distribution (seconds) ---");
console.log(`  count: ${latencies.length}`);
console.log(`  p50  : ${p(50).toFixed(3)}s`);
console.log(`  p90  : ${p(90).toFixed(3)}s`);
console.log(`  p95  : ${p(95).toFixed(3)}s`);
console.log(`  p99  : ${p(99).toFixed(3)}s`);
console.log(`  max  : ${(latencies[latencies.length - 1] || 0).toFixed(3)}s`);
' "$FILTER"

	echo -e "\n--- Checking Firestore transaction contention (ABORTED) logs ---"
	ABORT_FILTER="resource.labels.service_name=\"activitypub\" AND (jsonPayload.message=~\"ABORTED\" OR textPayload=~\"ABORTED\" OR severity>=WARNING) AND timestamp>=\"${START_TIME}\""
	gcloud logging read "$ABORT_FILTER" --project=activitypub-firebase-dev --limit=10 --format="table(timestamp,severity,jsonPayload.message,textPayload)"

	echo -e "\n--- Checking Accept delivery duration & status from deliveryTask ---"
	DELIVERY_FILTER="resource.labels.service_name=\"deliverytask\" AND jsonPayload.type=\"deliveryTaskResult\" AND timestamp>=\"${START_TIME}\""
	node -e '
const { execSync } = require("child_process");
const filter = process.argv[1];
const output = execSync(
  `gcloud logging read ${JSON.stringify(filter)} --project=activitypub-firebase-dev --format=json`,
  { maxBuffer: 100 * 1024 * 1024, encoding: "utf8" }
);
const logs = JSON.parse(output || "[]");
console.log(`Total deliveryTaskResult logs: ${logs.length}`);
const statusCounts = {};
let firstTime = null;
let lastTime = null;
for (const entry of logs) {
  const code = entry.jsonPayload?.statusCode || "unknown";
  statusCounts[code] = (statusCounts[code] || 0) + 1;
  const ts = new Date(entry.timestamp).getTime();
  if (!firstTime || ts < firstTime) firstTime = ts;
  if (!lastTime || ts > lastTime) lastTime = ts;
}
console.log("Delivery status codes:");
for (const [st, cnt] of Object.entries(statusCounts)) {
  console.log(`  ${st}: ${cnt}`);
}
if (firstTime && lastTime) {
  console.log(`Delivery duration: ${((lastTime - firstTime) / 1000).toFixed(2)}s`);
}
' "$DELIVERY_FILTER"
}

check_prerequisites

case "$ACTION" in
create)
	cmd_create
	;;
follow)
	cmd_follow
	;;
status)
	cmd_status
	;;
post)
	cmd_post
	;;
unfollow)
	cmd_unfollow
	;;
cleanup)
	cmd_cleanup
	;;
metrics)
	cmd_metrics "$@"
	;;
all)
	echo "Running complete test with COUNT=$COUNT..."
	cmd_create
	cmd_follow
	echo "Waiting 30 seconds for deliveries and processing..."
	sleep 30
	cmd_status
	cmd_metrics
	;;
*)
	echo "Usage: $0 [create|follow|status|post|unfollow|cleanup|metrics|all] [COUNT]"
	exit 1
	;;
esac
