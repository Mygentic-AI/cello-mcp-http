#!/usr/bin/env bash
# PRE-TAG GATE: run before any release tag, on the exact commit you will tag. Modelled on the cello repo's.
#
# Runs what CI runs: install, build, typecheck, the whole test suite. Records the commit only if every step
# passes, in ~/.cache/.cello-pre-tag-gate. Tag that commit and no other: any later commit needs the gate again.
# (The publish guard hook resolves the tag in cello-client, cello and this repo.)
#
# Usage: scripts/pre-tag-gate.sh
set -euo pipefail
cd "$(dirname "$0")/.."
marker="$HOME/.cache/.cello-pre-tag-gate"
rm -f "$marker"

# Untracked files count: tsc and the tests read them, and the tag doesn't carry them.
dirty="$(git status --porcelain)"
if [ -n "$dirty" ]; then
  echo "PRE-TAG GATE: FAILED, the working tree isn't clean, so what gets tested isn't what gets tagged:" >&2
  echo "$dirty" >&2
  exit 1
fi

sha="$(git rev-parse HEAD)"
version="$(node -p "require('./package.json').version")"
name="$(node -p "require('./package.json').name")"
echo "PRE-TAG GATE: testing $sha, $name $version"
if [ "$(node -p "require('./package.json').private === true")" = "true" ]; then echo "PRE-TAG GATE: FAILED, package.json says private: true." >&2; exit 1; fi
if curl -sf -H 'Cache-Control: no-cache' "https://registry.npmjs.org/${name/\//%2f}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.exit(JSON.parse(d).versions?.[process.argv[1]]?0:1))" "$version"; then
  echo "PRE-TAG GATE: FAILED, $name@$version is already on npm. A version is never reused." >&2
  exit 1
fi

step() { echo; echo "-- $1"; shift; "$@" || { echo "PRE-TAG GATE: FAILED at '$*' on $sha. Nothing recorded." >&2; exit 1; }; }
step "install (clean, as CI)" npm ci
step "build" npm run build
step "typecheck" npm run typecheck
step "test, the whole suite" npm test

if [ -n "$(git status --porcelain)" ] || [ "$(git rev-parse HEAD)" != "$sha" ]; then
  echo "PRE-TAG GATE: FAILED, the tree or HEAD changed while the gate ran. Nothing recorded." >&2
  exit 1
fi
mkdir -p "$(dirname "$marker")"
printf '%s\n' "$sha" > "$marker"
echo
echo "PRE-TAG GATE: PASSED on $sha. Tag it as v$version."
