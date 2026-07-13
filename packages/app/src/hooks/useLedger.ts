/** Event-ledger state: record and undo, both guarded by the §6.1 conflict rules. */

import { useRef, useState } from "react";
import {
  addEvent,
  removeEvent,
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
  undoEvent: (id: string) => void;
}

export function useLedger(base: LedgerBaseConfig): UseLedger {
  const [ledger, setLedger] = useState<Ledger>(emptyLedger);
  const [conflict, setConflict] = useState<string | null>(null);
  // Record and undo both validate against the same base replay context the
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

  function undoEvent(id: string) {
    setLedger((current) => {
      // Resolve against the latest ledger (not the render closure) so batched
      // undos can't discard each other. A blocked removal keeps the ledger and
      // surfaces the §6.1 conflict.
      const result = removeEvent(current, id, baseRef.current);
      setConflict(result.ok ? null : result.conflict);
      return result.ok ? result.ledger : current;
    });
  }

  return { ledger, conflict, recordEvent, undoEvent };
}
