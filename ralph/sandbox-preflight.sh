#!/usr/bin/env bash
#
# Runs INSIDE the docker sandbox (called by afk.sh) to guarantee node_modules
# holds THIS platform's native binaries — UNCORRUPTED — before the agent runs.
#
# Two problems, both because the workspace is a virtiofs mount shared with macOS:
#
#  1. node_modules is SHARED between the host (darwin-arm64) and the linux
#     sandbox. Native deps ship a per-OS companion binary; only one platform's
#     can exist in the shared mount at a time, and npm won't swap them
#     incrementally (npm/cli#4828). A node_modules last built on the host fails
#     here (and vice versa).
#
#  2. Writing a large native binary onto the virtiofs mount INTERMITTENTLY
#     corrupts the bytes — verified: identical package + version, same size,
#     different sha256 vs a native-fs install; npm, `cp -a`, and even a plain
#     `cp` can all produce a bad copy. esbuild's Go binary self-validates and dies
#     "bad symbol table"; rollup's .node fails to load. We cannot move
#     node_modules off the mount (`docker sandbox` has no volume flag; the
#     container lacks CAP_SYS_ADMIN for a bind mount). So we install on the
#     container's NATIVE filesystem (npm writes intact there) and copy the result
#     onto the mount, VERIFYING every native binary's sha and retrying the write
#     until it round-trips (see nm-sync.sh).
#
# Strategy: functionally test the native toolchain; only rebuild if it's broken.
# Fast no-op when it's fine.
set -uo pipefail
. "$(dirname "$0")/nm-sync.sh"
cd "$(dirname "$0")/.."
SRC="$PWD"

plat="$(node -p 'process.platform + "-" + process.arch' 2>/dev/null || echo unknown)"

if nm_verify_toolchain; then
  echo "sandbox deps: native toolchain OK for ${plat}"
  exit 0
fi

echo "sandbox deps: rebuilding node_modules for ${plat} (install native, copy onto mount)…"

# 1) Install on the container-native fs, where npm writes binaries intact. Only
#    the manifests + lockfile are needed to resolve the tree; the workspace
#    (@finley/*) symlinks npm creates are RELATIVE, so they repoint correctly
#    once node_modules is copied back next to the real packages/ on the mount.
WORK="/home/agent/nm-build-$(basename "$SRC")"
rm -rf "$WORK"; mkdir -p "$WORK"
cp -a "$SRC/package.json" "$SRC/package-lock.json" "$WORK"/ 2>/dev/null || true
for pj in "$SRC"/packages/*/package.json; do
  [ -f "$pj" ] || continue
  d="$(dirname "${pj#"$SRC"/}")"; mkdir -p "$WORK/$d"; cp -a "$pj" "$WORK/$d/"
done
( cd "$WORK" && npm install --no-audit --no-fund )

# 2) Mirror node_modules onto the mount, with verified native-binary repair.
nm_sync_to_mount "$SRC" "$WORK" || { echo "sandbox deps: ERROR — sync failed" >&2; exit 1; }

# 3) Verify the toolchain is now healthy; fail loudly (non-zero) if not.
if nm_verify_toolchain; then
  echo "sandbox deps: native toolchain rebuilt OK for ${plat}"
else
  echo "sandbox deps: ERROR — toolchain still broken after rebuild" >&2
  exit 1
fi
