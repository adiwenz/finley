#!/usr/bin/env bash
#
# Runs INSIDE the docker sandbox (called by afk.sh) to guarantee node_modules
# holds THIS platform's native binaries before the agent runs.
#
# Why this is needed: the sandbox mounts the workspace over virtiofs, so
# node_modules is SHARED between the macOS host (darwin-arm64) and the linux
# sandbox. Native deps like esbuild ship per-OS binaries that can't be shared,
# and npm won't swap platform-optional binaries incrementally (npm/cli#4828), so
# a node_modules last built on the host segfaults here (and vice versa). Rollup
# is aliased to the platform-independent WASM build in package.json, which
# removes rollup from this problem — esbuild is the remaining native binary.
#
# Strategy: functionally test the native toolchain; only clean-reinstall if it's
# broken (missing, or built for the other platform). Fast no-op when it's fine.
set -uo pipefail
cd "$(dirname "$0")/.."

plat="$(node -p 'process.platform + "-" + process.arch' 2>/dev/null || echo unknown)"

# Exercise the native binary (esbuild) + the rollup entry. A wrong-platform or
# missing binary throws or segfaults, i.e. exits non-zero.
if node -e 'require("esbuild").transformSync("const x=1"); require("rollup");' >/dev/null 2>&1; then
  echo "sandbox deps: native toolchain OK for ${plat}"
  exit 0
fi

echo "sandbox deps: (re)building node_modules for ${plat}…"
rm -rf node_modules packages/*/node_modules
npm install --no-audit --no-fund
