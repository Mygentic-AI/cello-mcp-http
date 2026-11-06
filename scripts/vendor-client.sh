#!/bin/sh
# The client isn't on npm yet, so this packs a checkout of it into vendor/, where package.json expects it.
# Usage: scripts/vendor-client.sh <client checkout>
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
client=$(cd "${1:?name a checkout of the client}" && pwd)
mkdir -p "$here/vendor"
(cd "$client" && npm pack --pack-destination "$here/vendor" >/dev/null)
mv "$here"/vendor/cello-protocol-cli-*.tgz "$here/vendor/cello-cli.tgz"
cd "$here"
rm -rf node_modules/@cello-protocol/cli
npm install --no-audit --no-fund
