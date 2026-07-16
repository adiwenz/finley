#!/usr/bin/env bash
#
# Shared helpers for installing node deps in the sandbox without the virtiofs
# mount corrupting native binaries. Sourced by sandbox-preflight.sh and
# nm-install.sh — see sandbox-preflight.sh for the full diagnosis.
#
# The core problem: writing a large native binary (esbuild's ~9.7 MB Go binary)
# onto the virtiofs mount INTERMITTENTLY corrupts the bytes — npm, `cp -a`, and
# even a plain `cp` can all produce a wrong-sha copy (the read is stable, so it's
# a write-side corruption). The corrupt binary self-validates and dies "bad
# symbol table". So every native-binary write must be VERIFIED and retried.

# cp_verified SRC DST — copy onto the mount and confirm it round-trips; retry the
# write until sha256(DST) == sha256(SRC), failing loudly if it never converges.
cp_verified() {
  local src="$1" dst="$2" want got i
  want="$(sha256sum "$src" | cut -d' ' -f1)"
  for i in $(seq 1 15); do
    cp -f "$src" "$dst"; sync
    got="$(sha256sum "$dst" 2>/dev/null | cut -d' ' -f1)"
    [ "$got" = "$want" ] && return 0
  done
  echo "nm-sync: ERROR — could not write an intact copy of $dst after $i tries" >&2
  return 1
}

# nm_sync_to_mount SRC WORK — mirror WORK/node_modules (a clean native-fs install)
# onto the SRC (mount) tree, then repair every native binary with a verified copy.
nm_sync_to_mount() {
  local SRC="$1" WORK="$2" d rel f
  rm -rf "$SRC/node_modules" "$SRC"/packages/*/node_modules
  cp -a "$WORK/node_modules" "$SRC/node_modules"
  for d in "$WORK"/packages/*/node_modules; do
    [ -d "$d" ] || continue
    rel="${d#"$WORK"/}"; mkdir -p "$SRC/$(dirname "$rel")"; cp -a "$d" "$SRC/$rel"
  done
  # Repair native binaries the bulk copy corrupts. Process substitution (not a
  # pipe) so a failed cp_verified propagates out of the function.
  while IFS= read -r f; do
    rel="${f#"$WORK"/}"
    [ -f "$SRC/$rel" ] || continue
    cp_verified "$f" "$SRC/$rel" || return 1
  done < <(find "$WORK" -type f \( -name '*.node' -o -name esbuild \))
}

# nm_verify_toolchain — exit-status test that esbuild + rollup load off the mount.
nm_verify_toolchain() {
  node -e 'require("esbuild").transformSync("const x=1"); require("rollup");' >/dev/null 2>&1
}
