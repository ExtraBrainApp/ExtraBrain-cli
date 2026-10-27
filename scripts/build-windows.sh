#!/usr/bin/env bash
# Cross-builds the Windows x64 and arm64 executables in a pinned Node container and
# checks their format and injected blob. Run `npm ci` first. With RELEASE_TAG set, it
# also writes the release archives, which hold extrabrain.exe at their root.
set -euo pipefail

docker run --rm \
  -v "$PWD:/src" -w /src \
  -e HOME=/tmp \
  -e RELEASE_TAG="${RELEASE_TAG:-}" \
  -e OWNER="$(id -u):$(id -g)" \
  node:24.20.0-bookworm bash -c '
    set -euo pipefail
    trap "chown -R \"\$OWNER\" dist node_modules/.cache *.zip 2>/dev/null || true" EXIT
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends osslsigncode file zip >/dev/null
    npm run build:bundle
    node scripts/build-sea.mjs --target win32-x64 --target win32-arm64
    for arch in x64 arm64; do
      executable="dist/win32-$arch/extrabrain.exe"
      machine=$([ "$arch" = x64 ] && echo x86-64 || echo Aarch64)
      file "$executable" | grep -q "PE32+ executable (console) $machine"
      grep -q NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:1 "$executable"
      if [ -n "$RELEASE_TAG" ]; then
        zip -j "extrabrain-$RELEASE_TAG-win32-$arch.zip" "$executable"
      fi
    done
  '
