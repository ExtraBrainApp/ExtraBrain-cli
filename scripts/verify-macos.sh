#!/usr/bin/env bash
# Checks a macOS executable's architecture and signature, then its version and the
# app-not-running contract. x64 runs through Rosetta when the host has it.
# Usage: scripts/verify-macos.sh <executable> <arm64|x64> <version>
set -euo pipefail
executable=$1
arch=$2
version=$3

test "$(lipo -archs "$executable")" = "$([ "$arch" = x64 ] && echo x86_64 || echo arm64)"
codesign --verify --strict "$executable"
command=("$executable")
if [ "$arch" = x64 ]; then
  if ! arch -x86_64 /usr/bin/true 2>/dev/null; then
    echo "::warning::Rosetta is unavailable; skipped running the x64 executable"
    exit 0
  fi
  command=(arch -x86_64 "$executable")
fi
test "$("${command[@]}" --version)" = "$version"
# Port 1 is never the app, so the result does not depend on what the runner has open.
set +e
result=$(EXTRABRAIN_PORT=1 "${command[@]}" --json capabilities)
code=$?
set -e
test "$code" = 3
echo "$result" | jq -e '.code == 3 and .message == "ExtraBrain is not running"'
