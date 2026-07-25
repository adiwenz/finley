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

export interface UseLedger {
  ledger: Ledger;
  conflict: string | null;
  recordEvent: (event: NewLifeEvent) => void;
  /**
   * Revise an event already on the timeline, keeping its id and its place in the log —
   * how a partner's own jobs are edited after they join (issue #118). A revision that
   * would strand a later event is rejected and surfaces as a conflict, exactly like a
   * blocked removal.
   */
  reviseEvent: (id: string, next: NewLifeEvent) => void;
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

  function reviseEvent(id: string, next: NewLifeEvent) {
    setLedger((current) => {
      // Resolve against the latest ledger, like removal, so two revisions in one tick
      // can't discard each other. A blocked revision keeps the ledger and surfaces the
      // §6.1 conflict.
      const result = updateLedgerEvent(current, id, next, baseRef.current);
      setConflict(result.ok ? null : result.conflict);
      return result.ok ? result.ledger : current;
    });
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

  return { ledger, conflict, recordEvent, reviseEvent, removeEvent, resetLedger };
}
