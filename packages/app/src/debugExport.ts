/**
 * Debug export (§10) — filename for the downloaded run. The payload itself is the
 * engine's {@link import("@finley/engine").SimulationReport} verbatim (engine-only,
 * no app wrapper): the report already echoes the resolved inputs, so an export is a
 * self-contained account of the run. Only the filename is app-side, since it carries
 * a wall-clock stamp the pure engine can't produce.
 */

/** `finley-debug-2026-07-15-14-30-00.json` — a filesystem-safe, sortable filename. */
export function debugExportFilename(now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `finley-debug-${stamp}.json`;
}
