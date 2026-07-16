#!/usr/bin/env bash
#
# nm-install.sh — install npm packages INSIDE the sandbox without corrupting
# native binaries. Use this instead of a bare `npm install`: the workspace is a
# virtiofs mount, and writing a large native binary (esbuild's Go binary,
# rollup's .node) onto it intermittently corrupts the bytes (see
# sandbox-preflight.sh for the full diagnosis). So we install on the container's
# NATIVE filesystem, copy the result onto the mount, and repair native binaries
# with a verified copy (nm-sync.sh).
#
# Usage (run from anywhere in the repo):
#   ralph/nm-install.sh <npm install args...>
#     ralph/nm-install.sh lodash                 # add a dependency
#     ralph/nm-install.sh -D vitest-plugin-foo    # add a dev dependency
#     ralph/nm-install.sh some-dep -w @finley/engine   # into a workspace package
#     ralph/nm-install.sh                          # no args: re-sync node_modules
#                                                  #   after a manual manifest edit
#
# Manifest changes (package.json / package-lock.json) are copied back to the
# mount so your commit reflects the new dependency.
set -uo pipefail
. "$(dirname "$0")/nm-sync.sh"
cd "$(dirname "$0")/.."
SRC="$PWD"
WORK="/home/agent/nm-build-$(basename "$SRC")"

# Refresh the native build dir with the CURRENT manifests (create if missing).
mkdir -p "$WORK"
cp -a "$SRC/package.json" "$SRC/package-lock.json" "$WORK"/ 2>/dev/null || true
for pj in "$SRC"/packages/*/package.json; do
  [ -f "$pj" ] || continue
  d="$(dirname "${pj#"$SRC"/}")"; mkdir -p "$WORK/$d"; cp -a "$pj" "$WORK/$d/"
done

# Install on the native fs, where npm writes binaries intact.
echo "nm-install: npm install $* (native fs)…"
( cd "$WORK" && npm install --no-audit --no-fund "$@" ) || {
  echo "nm-install: ERROR — npm install failed" >&2; exit 1;
}

# Copy manifest changes (new dep, updated lockfile) BACK to the mount.
cp -a "$WORK/package.json" "$WORK/package-lock.json" "$SRC"/ 2>/dev/null || true
for pj in "$WORK"/packages/*/package.json; do
  [ -f "$pj" ] || continue
  rel="${pj#"$WORK"/}"; cp -a "$pj" "$SRC/$rel"
done

# Mirror node_modules onto the mount, with verified native-binary repair.
nm_sync_to_mount "$SRC" "$WORK" || { echo "nm-install: ERROR — sync failed" >&2; exit 1; }

# Verify the toolchain still runs off the mount.
if nm_verify_toolchain; then
  echo "nm-install: done — toolchain OK"
else
  echo "nm-install: ERROR — toolchain broken after install" >&2
  exit 1
fi
