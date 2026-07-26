/** Event-ledger state: record, revise, and remove — all guarded by the §6.1 conflict rules. */

import { useRef, useState } from "react";
import {
  addEvent,
  removeEvent as removeLedgerEvent,
  updateEvent as updateLedgerEvent,
  emptyLedger,
  type Ledger,
  type LedgerBaseConfig,
  type NewLifeEvent,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";

/** One event to replace, by id — the unit {@link UseLedger.reviseEvents} commits. */
export interface EventRevision {
  readonly id: string;
  readonly next: NewLifeEvent;
}

export interface UseLedger {
  ledger: Ledger;
  conflict: string | null;
  recordEvent: (event: NewLifeEvent) => void;
  /**
   * Revise events already on the timeline, keeping each one's id and its place in the log —
   * how a partner's own jobs are edited after they join (issue #118). A revision that would
   * strand a later event is rejected and surfaces as a conflict, exactly like a blocked
   * removal.
   *
   * **All or nothing**, and it reports back: the revisions are replayed onto one ledger
   * value and committed only if every one is accepted. Returning `false` for a rejected
   * batch is what lets a caller spanning both authoring planes stay atomic — the Jobs panel
   * moves a job between members by revising an event *and* editing the plan, and must not
   * write the plan side if the ledger side was refused (issue #118).
   */
  reviseEvents: (revisions: readonly EventRevision[]) => boolean;
  removeEvent: (id: string) => void;
  /**
   * Replace the whole ledger wholesale — the seam a preset load uses to swap in a
   * scenario's pre-replayed timeline (issue #119). The caller owns the new ledger's
   * validity (a preset builds it against the matching base via `buildPresetLedger`);
   * this just installs it and clears any stale conflict.
   */
  resetLedger: (ledger: Ledger) => void;
}

export function useLedger(base: LedgerBaseConfig): UseLedger {
  const [ledger, setLedger] = useState<Ledger>(emptyLedger);
  const [conflict, setConflict] = useState<string | null>(null);
  // Record and remove both validate against the same base replay context the
  // projection uses (§7). Held in a ref so the functional updaters below always
  // see the latest base without being re-created on every budget edit.
  const baseRef = useRef(base);
  baseRef.current = base;
  // The latest ledger, readable *synchronously*. `reviseEvents` has to answer whether it
  // was accepted before its caller writes the other plane, which a functional updater
  // (whose result arrives a render later) cannot do. Mirrored on every render and again on
  // each accepted revision, so two revisions in one tick still see each other.
  const ledgerRef = useRef(ledger);
  ledgerRef.current = ledger;

  function recordEvent(event: NewLifeEvent) {
    setLedger((current) => {
      // The engine rejects an event whose preconditions fail (e.g. separating
      // before partnering); a rejected event never enters the ledger.
      // The same jurisdiction the displayed projection uses, so the §4.5
      // down-payment affordability check sees the same liquid balances.
      const result = addEvent(current, baseRef.current, event, usJurisdiction);
      setConflict(result.ok ? null : result.conflict);
      return result.ok ? result.ledger : current;
    });
  }

  function reviseEvents(revisions: readonly EventRevision[]): boolean {
    // Replayed onto ONE ledger value and committed only once every revision is accepted:
    // a batch that fails part-way leaves the ledger exactly as it was, and the §6.1
    // conflict names the revision that blocked it.
    let next = ledgerRef.current;
    for (const revision of revisions) {
      const result = updateLedgerEvent(next, revision.id, revision.next, baseRef.current);
      if (!result.ok) {
        setConflict(result.conflict);
        return false;
      }
      next = result.ledger;
    }
    setConflict(null);
    ledgerRef.current = next;
    setLedger(next);
    return true;
  }

  function removeEvent(id: string) {
    setLedger((current) => {
      // Resolve against the latest ledger (not the render closure) so batched
      // removals can't discard each other. A blocked removal keeps the ledger and
      // surfaces the §6.1 conflict.
      const result = removeLedgerEvent(current, id, baseRef.current);
      setConflict(result.ok ? null : result.conflict);
      return result.ok ? result.ledger : current;
    });
  }

  function resetLedger(next: Ledger) {
    setLedger(next);
    setConflict(null);
  }

  return { ledger, conflict, recordEvent, reviseEvents, removeEvent, resetLedger };
}
