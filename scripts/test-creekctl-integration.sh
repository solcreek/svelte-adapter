#!/usr/bin/env bash
# End-to-end integration test: real `creekd` + `creekctl` against the
# adapter's emitted .creek-creekd/manifest.json.
#
# This is the final-truth test of the manifest contract — proving that
# what the adapter writes is what creekd reads. Lives outside vitest
# because it shells out to Go binaries and needs the sibling creekd
# repo checked out.
#
# Layout assumed:
#
#   <parent>/svelte-adapter      ← this repo
#   <parent>/creekd              ← https://github.com/solcreek/creekd
#
# Override paths via CREEKD_REPO / CREEKCTL_BIN / CREEKD_BIN env vars.

set -euo pipefail

# ---- Configuration ----------------------------------------------------

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ADAPTER_ROOT="$( cd "${SCRIPT_DIR}/.." && pwd )"
CREEKD_REPO="${CREEKD_REPO:-${ADAPTER_ROOT}/../creekd}"
FIXTURE_DIR="${ADAPTER_ROOT}/test/fixtures/real-sveltekit"
APP_ID="sveltefx-it"

# Pick non-default ports so this never clashes with anything the user
# has running locally.
ADMIN_PORT="${ADMIN_PORT:-19080}"
DISPATCH_PORT="${DISPATCH_PORT:-19000}"
APP_PORT="${APP_PORT:-13000}"

CREEKD_BIN="${CREEKD_BIN:-${TMPDIR:-/tmp}/creekd-it}"
CREEKCTL_BIN="${CREEKCTL_BIN:-${TMPDIR:-/tmp}/creekctl-it}"
DAEMON_LOG="$(mktemp -t creekd-it.XXXXXX.log)"
APP_LOG_DIR="$(mktemp -d -t creekd-applogs.XXXXXX)"
DAEMON_PID=""

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
blue()  { printf '\033[34m%s\033[0m\n' "$*"; }

# ---- Cleanup ----------------------------------------------------------

cleanup() {
  local rc=$?
  set +e
  blue "==> Cleaning up"
  if [[ -n "$DAEMON_PID" ]] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    CREEKCTL_SERVER="http://127.0.0.1:${ADMIN_PORT}" \
      "$CREEKCTL_BIN" rm "$APP_ID" >/dev/null 2>&1 || true
    kill "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
  if [[ $rc -ne 0 ]]; then
    red "==> FAILED (exit $rc)"
    red "    daemon log: $DAEMON_LOG"
    [[ -s "$DAEMON_LOG" ]] && tail -30 "$DAEMON_LOG" | sed 's/^/    | /'
  else
    rm -f "$DAEMON_LOG"
    rm -rf "$APP_LOG_DIR"
  fi
  exit "$rc"
}
trap cleanup EXIT INT TERM

# ---- 1. Build creekd + creekctl --------------------------------------

if [[ ! -d "$CREEKD_REPO" ]]; then
  red "==> creekd repo not found at $CREEKD_REPO"
  red "    Clone https://github.com/solcreek/creekd next to svelte-adapter,"
  red "    or set CREEKD_REPO=/path/to/creekd"
  exit 2
fi

blue "==> Building creekd + creekctl from $CREEKD_REPO"
(
  cd "$CREEKD_REPO"
  go build -o "$CREEKD_BIN" ./cmd/creekd
  go build -o "$CREEKCTL_BIN" ./cmd/creekctl
)
green "    creekd:   $CREEKD_BIN"
green "    creekctl: $CREEKCTL_BIN"

# ---- 2. Build the adapter + fixture ----------------------------------

blue "==> Building adapter"
( cd "$ADAPTER_ROOT" && pnpm build >/dev/null )

if [[ ! -d "$FIXTURE_DIR/node_modules" ]]; then
  blue "==> Installing fixture deps (one-time)"
  ( cd "$FIXTURE_DIR" && pnpm install --ignore-workspace >/dev/null )
fi

blue "==> Building fixture"
( cd "$FIXTURE_DIR" && BENCH_ADAPTER= pnpm build 2>&1 | tail -2 )

MANIFEST="$FIXTURE_DIR/.creek-creekd/manifest.json"
if [[ ! -f "$MANIFEST" ]]; then
  red "==> Manifest not emitted at $MANIFEST — adapter regressed?"
  exit 1
fi
green "    manifest: $MANIFEST"

# Override the manifest's port from APP_PORT so this test never collides
# with a real dev server on :3000. Done with jq if available, else a
# python fallback.
TMP_MANIFEST="$(mktemp -t manifest.XXXXXX.json)"
if command -v jq >/dev/null 2>&1; then
  jq --argjson p "$APP_PORT" '.port = $p' "$MANIFEST" > "$TMP_MANIFEST"
else
  python3 -c "
import json, sys
with open('$MANIFEST') as f: m = json.load(f)
m['port'] = $APP_PORT
with open('$TMP_MANIFEST', 'w') as f: json.dump(m, f, indent=2)
"
fi
cp "$TMP_MANIFEST" "$MANIFEST"
rm -f "$TMP_MANIFEST"

# ---- 3. Start creekd --------------------------------------------------

blue "==> Starting creekd (admin :$ADMIN_PORT, dispatch :$DISPATCH_PORT)"
CREEKD_ADMIN_ADDR="127.0.0.1:${ADMIN_PORT}" \
CREEKD_DISPATCH_ADDR="127.0.0.1:${DISPATCH_PORT}" \
CREEKD_LOG_DIR="$APP_LOG_DIR" \
  "$CREEKD_BIN" > "$DAEMON_LOG" 2>&1 &
DAEMON_PID=$!

# Wait until admin API is reachable.
for _ in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:${ADMIN_PORT}/v1/apps" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
if ! curl -sf "http://127.0.0.1:${ADMIN_PORT}/v1/apps" >/dev/null 2>&1; then
  red "==> creekd never became ready"
  exit 1
fi
green "    creekd ready (pid $DAEMON_PID)"

export CREEKCTL_SERVER="http://127.0.0.1:${ADMIN_PORT}"

# ---- 4. up --from -----------------------------------------------------

blue "==> creekctl up $APP_ID --from .creek-creekd/manifest.json"
"$CREEKCTL_BIN" up "$APP_ID" --from "$MANIFEST" --json > /dev/null
green "    spawn ok"

# Wait for the app to actually be listening — `up` returns once the
# process is spawned, but Node SvelteKit needs ~200ms to bind the port.
for _ in $(seq 1 50); do
  if curl -sf -H "X-Creek-App: $APP_ID" \
      "http://127.0.0.1:${DISPATCH_PORT}/_creek/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

# ---- 5. Probe through dispatch ---------------------------------------

probe() {
  local label="$1"
  local path="$2"
  local expect_pattern="$3"
  local body
  body=$(curl -sf -H "X-Creek-App: $APP_ID" \
      "http://127.0.0.1:${DISPATCH_PORT}${path}")
  if [[ "$body" =~ $expect_pattern ]]; then
    green "    ✓ $label  $path → matches /$expect_pattern/"
  else
    red   "    ✗ $label  $path → got: ${body:0:120}"
    return 1
  fi
}

blue "==> Probing via dispatch (X-Creek-App: $APP_ID → :$DISPATCH_PORT)"
probe "health probe"       "/_creek/health"      '^ok$'
probe "SSR home"           "/"                   "home:"
probe "prerendered route"  "/about"              "about: prerendered"
probe "JSON +server.ts"    "/api/ping"           '"ok":true'
probe "\$app/server read"  "/asset"              "creek-svelte-asset-marker"
probe "platform.cache set" "/cache?op=set&key=it&value=via-dispatch"  '^set$'
probe "platform.cache get" "/cache?op=get&key=it"                     '^via-dispatch$'

# ---- 6. ps + stats sanity --------------------------------------------

blue "==> creekctl ps shows the app as running"
# `ps --json` pretty-prints with a space after the colon, so match
# loosely on the id field rather than a packed format.
if ! "$CREEKCTL_BIN" ps --json | grep -qE "\"id\"[[:space:]]*:[[:space:]]*\"$APP_ID\""; then
  red "    ✗ $APP_ID not in ps output:"
  "$CREEKCTL_BIN" ps --json | sed 's/^/      | /'
  exit 1
fi
green "    ✓ present in ps"

green ""
green "==> All checks passed."
green "    @solcreek/svelte-adapter's manifest contract is consumable by creekd end-to-end:"
green "    adapter → manifest.json → creekctl up → creekd spawn → dispatch → SvelteKit → platform.cache"
