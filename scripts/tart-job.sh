#!/usr/bin/env bash
# Runs CI commands in a disposable macOS VM cloned from the pinned ExtraBrain toolchain
# image (Node 24.20.0, codesign, Rosetta), so nothing executes on the shared Tart host.
# Usage: tart-job.sh start | run <command> | fetch <path>... | stop
set -euo pipefail

IMAGE=ghcr.io/extrabrainapp/extrabrain-macos@sha256:6e5191fc73f2f24e68fef3acd33c1834529655ab8069ba2777a705733957b1b3
PREFIX=extrabrain-cli-job
GUEST_USER='admin'
GUEST_ROOT=/Users/admin/extrabrain-cli
state="${RUNNER_TEMP:?}/tart-job"
key="$state/id_ed25519"
vm="$PREFIX-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}-${GITHUB_JOB:?}"

ssh_vm() {
  ssh -i "$key" -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
    "$GUEST_USER@$(cat "$state/ip")" "$@"
}

remove_vm() {
  tart stop --timeout 60 "$1" >/dev/null 2>&1 || true
  tart delete "$1" >/dev/null 2>&1 || true
}

case "${1:-}" in
  start)
    rm -rf "$state"
    mkdir -p "$state"
    # The runner takes one job at a time, so a VM left with this prefix belongs to a killed job.
    while IFS= read -r stale; do
      case "$stale" in "$PREFIX"-*) remove_vm "$stale" ;; esac
    done < <(tart list --source local --quiet)
    for attempt in 1 2 3; do
      tart clone "$IMAGE" "$vm" && break
      remove_vm "$vm"
      if [ "$attempt" = 3 ]; then echo "Could not clone $IMAGE" >&2; exit 1; fi
      sleep $((attempt * 10))
    done
    tart set "$vm" --cpu 4 --memory 8192
    /usr/bin/env -u RUNNER_TRACKING_ID nohup tart run --no-graphics --no-clipboard --no-audio "$vm" \
      </dev/null >"$state/tart.log" 2>&1 &
    ready=
    for _ in $(seq 120); do
      if tart exec "$vm" /usr/bin/true >/dev/null 2>&1; then ready=1; break; fi
      sleep 1
    done
    if [ -z "$ready" ]; then tail -n 50 "$state/tart.log" >&2; echo "$vm did not start" >&2; exit 1; fi
    ssh-keygen -q -t ed25519 -N '' -f "$key"
    # The single quotes are intentional: HOME must expand in the guest.
    # shellcheck disable=SC2016
    tart exec -i "$vm" /bin/bash -c \
      'umask 077; mkdir -p "$HOME/.ssh"; cat > "$HOME/.ssh/authorized_keys"' <"$key.pub"
    tart ip --wait 60 "$vm" >"$state/ip"
    for _ in $(seq 60); do
      ssh_vm /usr/bin/true >/dev/null 2>&1 && break
      sleep 1
    done
    ssh_vm /bin/mkdir -p "$GUEST_ROOT"
    git ls-files -z | xargs -0 tar -c -f - | ssh_vm tar -x -f - -C "$GUEST_ROOT"
    ;;
  run)
    printf -v command 'cd %q && %s' "$GUEST_ROOT" "$2"
    ssh_vm /bin/bash -lc "$(printf '%q' "$command")"
    ;;
  fetch)
    shift
    printf -v paths ' %q' "$@"
    ssh_vm "cd $(printf '%q' "$GUEST_ROOT") && tar -c -f -$paths" | tar -x -f -
    ;;
  stop)
    remove_vm "$vm"
    rm -rf "$state"
    ;;
  *)
    echo 'Usage: tart-job.sh start | run <command> | fetch <path>... | stop' >&2
    exit 2
    ;;
esac
