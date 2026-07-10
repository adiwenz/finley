#!/usr/bin/env bash
#
# Runs INSIDE the docker sandbox (called by afk.sh) to guarantee node_modules
# holds THIS platform's native binaries before the agent runs.
#
# Why this is needed: the sandbox mounts the workspace over virtiofs, so
# node_modules is SHARED between the macOS host (darwin-arm64) and the linux
# sandbox. Native deps like esbuild and rollup ship their compiled code as a
# per-OS companion package (e.g. @rollup/rollup-linux-arm64-gnu, an ELF .node);
# only one platform's can exist in the shared mount at a time, and npm won't swap
# platform-optional binaries incrementally (npm/cli#4828). So a node_modules last
# built on the host fails here (and vice versa): esbuild's mismatched binary can
# SIGSEGV, while rollup throws "Cannot find module @rollup/rollup-<plat>" at load.
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
