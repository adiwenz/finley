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
#  2. npm's tarball extraction WRITING a large native binary directly onto the
#     virtiofs mount silently CORRUPTS it — verified: identical package + version,
#     same byte size, different sha256 vs a native-fs install. esbuild's Go binary
#     validates its own symbol table at startup and dies with "bad symbol table" /
#     "invalid function symbol table"; rollup's .node fails to load. (A plain C
#     binary like node survives, which makes this easy to misdiagnose.) We cannot
#     move node_modules off the mount: `docker sandbox` exposes no volume flag and
#     the container has no CAP_SYS_ADMIN for a bind mount. So we install on the
#     container's NATIVE filesystem (npm writes intact there) and copy the result
#     onto the mount. Quirk: a plain per-file `cp` copies a native binary intact,
#     but `cp -a`'s bulk/preserve write corrupts it the same way npm does — so we
#     bulk-copy the (JS-heavy) tree with `cp -a`, then re-copy each native binary
#     with a plain `cp`.
#
# Strategy: functionally test the native toolchain; only rebuild if it's broken.
# Fast no-op when it's fine.
set -uo pipefail
cd "$(dirname "$0")/.."
SRC="$PWD"

plat="$(node -p 'process.platform + "-" + process.arch' 2>/dev/null || echo unknown)"

# Exercise the native binaries (esbuild + rollup). A wrong-platform, missing, or
# corrupted binary throws or segfaults, i.e. exits non-zero.
if node -e 'require("esbuild").transformSync("const x=1"); require("rollup");' >/dev/null 2>&1; then
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

# 2) Mirror node_modules onto the virtiofs mount. cp -a is fine for the JS tree
#    (only large native binaries corrupt; those are repaired in step 3).
rm -rf "$SRC/node_modules" "$SRC"/packages/*/node_modules
cp -a "$WORK/node_modules" "$SRC/node_modules"
for d in "$WORK"/packages/*/node_modules; do
  [ -d "$d" ] || continue
  rel="${d#"$WORK"/}"; mkdir -p "$SRC/$(dirname "$rel")"; cp -a "$d" "$SRC/$rel"
done

# 3) Repair native binaries corrupted by cp -a: re-copy every *.node addon and
#    every esbuild binary with a plain per-file cp (which preserves them).
find "$WORK" -type f \( -name '*.node' -o -name esbuild \) | while read -r f; do
  rel="${f#"$WORK"/}"
  [ -f "$SRC/$rel" ] || continue
  cp -f "$f" "$SRC/$rel"
done

# Verify the toolchain is now healthy; fail loudly (non-zero) if not.
if node -e 'require("esbuild").transformSync("const x=1"); require("rollup");' >/dev/null 2>&1; then
  echo "sandbox deps: native toolchain rebuilt OK for ${plat}"
else
  echo "sandbox deps: ERROR — toolchain still broken after rebuild" >&2
  exit 1
fi
