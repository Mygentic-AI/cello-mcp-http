#!/bin/sh
# A real server from nothing, a real daemon, the built endpoint as its own process, and real HTTP MCP clients.
# Usage: scripts/live-test.sh <client checkout>. It vendors that checkout first.
set -eu
# Two of seven early runs stalled for a minute or more. Both lined up exactly with the Mac idle-sleeping on battery
# (pmset log: sleep at 08:51:01 and 09:03:01, then each daemon's "server.silent" at the next wake). Keep it awake.
if [ -z "${CELLO_LIVE_AWAKE:-}" ] && command -v caffeinate >/dev/null 2>&1; then
  CELLO_LIVE_AWAKE=1 exec caffeinate -i "$0" "$@"
fi
here=$(cd "$(dirname "$0")/.." && pwd)
client=$(cd "${1:?name a checkout of the client}" && pwd)
server_dir="${CELLO_SERVER_DIR:-$HOME/code/cello-server}"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-cello-web}" CELLO_PORT="${CELLO_PORT:-18620}"
# The endpoints listen on the next two ports, so a run given its own CELLO_PORT shares nothing with another.
export CELLO_WEB_PORT=$((CELLO_PORT + 1))
# Servers require a verified email signal. The client's stand-in issuer gives one, and tells the server to count it.
endpoint_dir="$here"; here="$client"
CELLO_ISSUER_DIR="${CELLO_ISSUER_DIR:-$HOME/code/cello-issuer}"
. "$client/scripts/test-issuer-env.sh"
here="$endpoint_dir"
POSTGRES_PASSWORD=$(openssl rand -hex 16); CELLO_APP_PASSWORD=$(openssl rand -hex 16)
export POSTGRES_PASSWORD CELLO_APP_PASSWORD
if ! diff -r "$client/src/protocol" "$server_dir/src/protocol" >/dev/null; then
  echo "The server's protocol copy differs from the client's. Point CELLO_SERVER_DIR at a server checkout that matches." >&2
  exit 1
fi
lock="$HOME/cello-live-runs/.heavy-lock"
held=""
# A killed test skips its own cleanup. Only this run's daemons carry this port in their command.
trap 'if [ -n "$held" ]; then rmdir "$lock" 2>/dev/null; fi; pkill -f "daemon/main.js ws://127.0.0.1:$CELLO_PORT/v1" 2>/dev/null || true; pkill -f "cello-mcp-http.js --port $CELLO_WEB_PORT " 2>/dev/null || true; pkill -f "cello-mcp-http.js --port $((CELLO_WEB_PORT + 1)) " 2>/dev/null || true; cd "$server_dir" && docker compose logs --timestamps server > "$HOME/cello-live-runs/web-endpoint-server-$(date +%s).log" 2>&1; docker compose down -v --remove-orphans >/dev/null 2>&1 || true' EXIT
waited=0
until mkdir "$lock" 2>/dev/null; do
  waited=$((waited + 5))
  if [ "$waited" -ge 900 ]; then echo "Another run held the build lock for 15 minutes, so this one stopped." >&2; exit 75; fi
  sleep 5
done
held=1
"$here/scripts/vendor-client.sh" "$client" >/dev/null 2>&1
(cd "$here" && npm run build >/dev/null)
cd "$server_dir"
docker compose up -d --build --wait server || { docker compose logs migrate postgres 2>&1 | tail -30; exit 1; }
rmdir "$lock"
held=""
cd "$here"
CELLO_URL="ws://127.0.0.1:$CELLO_PORT/v1" node --test --test-concurrency=1 --test-force-exit --test-timeout=400000 live/endpoint.live.ts
