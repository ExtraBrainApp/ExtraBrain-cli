#!/bin/sh
set -eu

repository='ExtraBrainApp/ExtraBrain-cli'
release_base=${EXTRABRAIN_RELEASE_BASE:-"https://github.com/$repository/releases"}
install_dir=${EXTRABRAIN_INSTALL_DIR:-"$HOME/.local/bin"}

case "$(uname -s)" in
  Darwin) platform=darwin ;;
  Linux) platform=linux ;;
  *) echo 'Unsupported operating system' >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) echo 'Unsupported architecture' >&2; exit 1 ;;
esac

if [ -n "${EXTRABRAIN_VERSION:-}" ]; then
  version=$EXTRABRAIN_VERSION
else
  latest=$(curl --fail --location --silent --show-error --output /dev/null --write-out '%{url_effective}' "$release_base/latest")
  version=${latest##*/}
fi
if ! printf '%s\n' "$version" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo 'Invalid release version' >&2
  exit 1
fi

asset="extrabrain-$version-$platform-$arch.tar.gz"
temporary=$(mktemp -d)
staging=''
cleanup() {
  [ -z "$staging" ] || rm -f "$staging"
  rm -rf "$temporary"
}
trap cleanup EXIT HUP INT TERM

curl --fail --location --silent --show-error --output "$temporary/SHA256SUMS" "$release_base/download/$version/SHA256SUMS"
curl --fail --location --silent --show-error --output "$temporary/$asset" "$release_base/download/$version/$asset"
expected=$(awk -v name="$asset" '$2 == name { print $1 }' "$temporary/SHA256SUMS")
case "$expected" in
  ????????????????????????????????????????????????????????????????) ;;
  *) echo 'Release checksum is missing or invalid' >&2; exit 1 ;;
esac
if command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$temporary/$asset" | awk '{ print $1 }')
elif command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$temporary/$asset" | awk '{ print $1 }')
else
  echo 'A SHA-256 checksum utility is required' >&2
  exit 1
fi
if [ "$actual" != "$expected" ]; then
  echo 'Release checksum mismatch' >&2
  exit 1
fi

tar -xzf "$temporary/$asset" -C "$temporary" extrabrain
mkdir -p "$install_dir"
staging=$(mktemp "$install_dir/.extrabrain.XXXXXXXX")
install -m 755 "$temporary/extrabrain" "$staging"
mv -f "$staging" "$install_dir/extrabrain"
staging=''
echo "Installed extrabrain $version at $install_dir/extrabrain"
