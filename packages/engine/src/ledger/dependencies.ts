/**
 * Dependent-event resolution for undo (§6.2, §8).
 *
 * A dependent points at its producer through `causedByEventId`. Removing a
 * producer removes the *transitive closure* of everything it caused — a
 * dependent may itself have dependents. Resolved by breadth-first traversal of
 * the causedBy graph rather than a single ad-hoc filter pass.
 */

import type { Ledger } from "./ledger";
import { causedByEventId } from "./eventTypes";

/**
 * Ids removed when event `id` is removed: `id` first, then every event
 * transitively caused by it, each once. Returns just `[id]` when `id` has no
 * dependents (and when `id` is absent, callers treat the lone result as a
 * no-op / not-found).
 */
export function computeDependents(ledger: Ledger, id: string): string[] {
  const dependentsByCause = new Map<string, string[]>();
  for (const e of ledger.events) {
    const cause = causedByEventId(e);
    if (cause == null) continue;
    const list = dependentsByCause.get(cause);
    if (list) list.push(e.id);
    else dependentsByCause.set(cause, [e.id]);
  }

  const removed: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [id];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    removed.push(current);
    for (const dependent of dependentsByCause.get(current) ?? []) {
      queue.push(dependent);
    }
  }
  return removed;
}
