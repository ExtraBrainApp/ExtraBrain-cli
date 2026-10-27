#!/usr/bin/env bash
# Validates and builds both macOS executables inside the disposable Tart VM.
# `ci` also exercises the packaged update and per-user install paths; `release` sets
# RELEASE_VERSION and writes the release archives.
set -euo pipefail
mode=${1:?Usage: ci-macos.sh ci|release}

if [ "$mode" = release ]; then
  npm version "${RELEASE_VERSION:?}" --no-git-tag-version --ignore-scripts
  RELEASE_TAG="${RELEASE_TAG:?}" node scripts/check-release-version.mjs
fi
version=$(node -p 'require("./package.json").version')
npm ci
npm run check
npm run build:bundle
node scripts/build-sea.mjs --target darwin-arm64 --target darwin-x64
bash scripts/verify-macos.sh dist/darwin-arm64/extrabrain arm64 "$version"
bash scripts/verify-macos.sh dist/darwin-x64/extrabrain x64 "$version"

if [ "$mode" = release ]; then
  for target in darwin-arm64 darwin-x64; do
    tar -czf "extrabrain-$RELEASE_TAG-$target.tar.gz" -C "dist/$target" extrabrain
  done
  exit 0
fi

EXTRABRAIN_TEST_EXECUTABLE="$PWD/dist/darwin-arm64/extrabrain" npm test -- test/install.test.ts

work=$(mktemp -d)
release="$work/releases/download/v$version"
asset="extrabrain-v$version-darwin-arm64.tar.gz"
mkdir -p "$release" "$work/home"
tar -czf "$release/$asset" -C dist/darwin-arm64 extrabrain
(cd "$release" && shasum -a 256 "$asset" > SHA256SUMS)
env HOME="$work/home" ZDOTDIR="$work/home" SHELL=/bin/zsh EXTRABRAIN_RELEASE_BASE="file://$work/releases" \
  EXTRABRAIN_VERSION="v$version" EXTRABRAIN_INSTALL_DIR= bash < install.sh
for shell_mode in -lc -ic; do
  test "$(env HOME="$work/home" ZDOTDIR="$work/home" PATH=/usr/bin:/bin:/usr/sbin:/sbin /bin/zsh "$shell_mode" 'extrabrain --version')" = "$version"
done
test "$(stat -f '%Su:%Lp' "$work/home/.local/bin/extrabrain")" = "$(id -un):755"
