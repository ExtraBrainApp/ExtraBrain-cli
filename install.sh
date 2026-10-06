#!/bin/sh
set -eu
umask 022

repository='ExtraBrainApp/ExtraBrain-cli'
release_base=${EXTRABRAIN_RELEASE_BASE:-"https://github.com/$repository/releases"}
install_dir=${EXTRABRAIN_INSTALL_DIR:-"$HOME/.local/bin"}
use_sudo=0
system_install=0
user_install=0
case "$install_dir" in
  /usr/local/bin|/usr/local/bin/) system_install=1 ;;
  "$HOME/.local/bin"|"$HOME/.local/bin/") user_install=1 ;;
esac

install_command() {
  if [ "$use_sudo" -eq 1 ]; then
    sudo -n "$@"
  else
    "$@"
  fi
}

case "$(uname -s)" in
  Darwin) platform=darwin ;;
  *) echo 'Unsupported operating system' >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64) arch=arm64 ;;
  x86_64) arch=x64 ;;
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
  [ -z "$staging" ] || install_command /bin/rm -f "$staging" || :
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
if [ ! -f "$temporary/extrabrain" ] || [ -L "$temporary/extrabrain" ]; then
  echo 'Release executable is missing or invalid' >&2
  exit 1
fi
if [ -L "$install_dir/extrabrain" ] || { [ -e "$install_dir/extrabrain" ] && [ ! -f "$install_dir/extrabrain" ]; }; then
  echo "Refusing to replace a symlink or non-regular file at $install_dir/extrabrain" >&2
  exit 1
fi

# System installs are root-owned. Custom writable destinations remain user-owned.
parent=$install_dir
while [ ! -d "$parent" ]; do
  parent=$(dirname "$parent")
done
if [ "$user_install" -eq 1 ] && [ ! -w "$parent" ]; then
  echo "User installation directory is not writable: $install_dir. Fix its ownership or choose a writable EXTRABRAIN_INSTALL_DIR." >&2
  exit 1
fi
if [ "$(id -u)" -ne 0 ] && { [ "$system_install" -eq 1 ] || [ ! -w "$parent" ]; }; then
  use_sudo=1
  echo "Administrator access is required to install at $install_dir" >&2
  if ! command -v sudo >/dev/null 2>&1; then
    echo 'Ask an administrator to run the installer, or choose a writable EXTRABRAIN_INSTALL_DIR already on PATH.' >&2
    exit 1
  fi
  if ! sudo -n -v 2>/dev/null; then
    if ! ( : </dev/tty ) 2>/dev/null; then
      echo 'No terminal is available for administrator authentication. Rerun the installer in a terminal, or ask an administrator to install it.' >&2
      exit 1
    fi
    if ! sudo -v </dev/tty; then
      echo 'Administrator authorization failed. The existing executable was not replaced.' >&2
      exit 1
    fi
  fi
fi

install_command /bin/mkdir -p -m 755 "$install_dir"
staging=$(install_command /usr/bin/mktemp "$install_dir/.extrabrain.XXXXXXXX")
if [ "$system_install" -eq 1 ] || [ "$use_sudo" -eq 1 ]; then
  install_command /usr/bin/install -o root -g wheel -m 755 "$temporary/extrabrain" "$staging"
else
  install_command /usr/bin/install -m 755 "$temporary/extrabrain" "$staging"
fi
install_command /bin/mv -f "$staging" "$install_dir/extrabrain"
staging=''
echo "Installed extrabrain $version at $install_dir/extrabrain"

path_configured=0
if [ "$user_install" -eq 1 ] && [ "${EXTRABRAIN_NO_MODIFY_PATH:-0}" != 1 ]; then
  cat > "$temporary/path-setup" <<'EOF'
# ExtraBrain CLI: user-local PATH
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) export PATH="$HOME/.local/bin:$PATH" ;;
esac
EOF
  configure_profile() {
    profile_file=$1
    if [ -f "$profile_file" ] && grep -Fqx '# ExtraBrain CLI: user-local PATH' "$profile_file"; then
      return 0
    fi
    if mkdir -p "$(dirname "$profile_file")" && { printf '\n'; cat "$temporary/path-setup"; } >> "$profile_file"; then
      echo "Configured PATH in $profile_file"
      return 0
    fi
    echo "Warning: could not configure PATH in $profile_file. The executable is installed at $install_dir/extrabrain." >&2
    return 1
  }
  path_configured=1
  case "${SHELL:-/bin/zsh}" in
    */zsh)
      configure_profile "${ZDOTDIR:-$HOME}/.zprofile" || path_configured=0
      configure_profile "${ZDOTDIR:-$HOME}/.zshrc" || path_configured=0
      ;;
    */bash)
      login_profile="$HOME/.bash_profile"
      if [ -e "$HOME/.bash_profile" ] || [ -L "$HOME/.bash_profile" ]; then
        login_profile="$HOME/.bash_profile"
      elif [ -e "$HOME/.bash_login" ] || [ -L "$HOME/.bash_login" ]; then
        login_profile="$HOME/.bash_login"
      elif [ -e "$HOME/.profile" ] || [ -L "$HOME/.profile" ]; then
        login_profile="$HOME/.profile"
      fi
      configure_profile "$login_profile" || path_configured=0
      configure_profile "$HOME/.bashrc" || path_configured=0
      ;;
    *)
      path_configured=0
      echo "Warning: automatic PATH setup supports zsh and bash. Use $install_dir/extrabrain directly with your shell." >&2
      ;;
  esac
fi
if [ "$path_configured" -eq 1 ]; then
  echo 'Open a new terminal, then run: extrabrain --version'
fi

resolved=$(command -v extrabrain || :)
if [ -z "$resolved" ] && [ "$path_configured" -eq 0 ]; then
  echo "Warning: $install_dir is not on this terminal's PATH. Use $install_dir/extrabrain directly, or install into a directory already on PATH." >&2
elif [ -n "$resolved" ] && [ ! "$resolved" -ef "$install_dir/extrabrain" ]; then
  echo "Warning: PATH currently resolves extrabrain to $resolved. Check command -v extrabrain in a new terminal; remove or update an older copy if it still takes precedence." >&2
fi
