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

export interface EventRevision {
  readonly id: string;
  readonly next: NewLifeEvent;
}

export interface UseLedger {
  ledger: Ledger;
  conflict: string | null;
  recordEvent: (event: NewLifeEvent) => void;
  /**
   * Revise timeline events, keeping each id and its place in the log — how a partner's
   * jobs are edited after they join. A revision that would strand a later event is
   * rejected as a conflict, like a blocked removal.
   *
   * **All or nothing**, and reports back: revisions replay onto one ledger value and
   * commit only if every one is accepted. The `false` return keeps a caller spanning both
   * authoring planes atomic — the Jobs panel moves a job between members by revising an
   * event *and* editing the plan, and must not write the plan side if the ledger refused.
   */
  reviseEvents: (revisions: readonly EventRevision[]) => boolean;
  removeEvent: (id: string) => void;
  /**
   * Replace the whole ledger — how a preset load swaps in a scenario's pre-replayed
   * timeline. The caller owns the new ledger's validity (a preset builds it against the
   * matching base via `buildPresetLedger`); this installs it and clears stale conflicts.
   */
  resetLedger: (ledger: Ledger) => void;
}

export function useLedger(base: LedgerBaseConfig): UseLedger {
  const [ledger, setLedger] = useState<Ledger>(emptyLedger);
  const [conflict, setConflict] = useState<string | null>(null);
  // Record and remove validate against the same base replay context the projection uses.
  // In a ref so the functional updaters below see the latest base without being re-created
  // on every budget edit.
  const baseRef = useRef(base);
  baseRef.current = base;
  // The latest ledger, readable *synchronously*: `reviseEvents` must report acceptance
  // before its caller writes the other plane, which a functional updater (result a render
  // later) cannot do. Mirrored every render and on each accepted revision, so two
  // revisions in one tick still see each other.
  const ledgerRef = useRef(ledger);
  ledgerRef.current = ledger;

  function recordEvent(event: NewLifeEvent) {
    setLedger((current) => {
      // An event whose preconditions fail (e.g. separating before partnering) never enters
      // the ledger. Same jurisdiction as the displayed projection, so the down-payment
      // affordability check sees the same liquid balances.
      const result = addEvent(current, baseRef.current, event, usJurisdiction);
      setConflict(result.ok ? null : result.conflict);
      return result.ok ? result.ledger : current;
    });
  }

  function reviseEvents(revisions: readonly EventRevision[]): boolean {
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
      // Resolve against the latest ledger, not the render closure, so batched removals
      // can't discard each other. A blocked removal keeps the ledger and shows the conflict.
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
