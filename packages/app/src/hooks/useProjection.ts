/**
 * The app's single authoring hook. React holds one immutable {@link ProjectionState}; every
 * write builds a momentary {@link Projection} over it, mutates that, and discards it — the
 * state React keeps is the value, never a live handle (a mutated handle is `Object.is`-equal
 * to itself, so `useState` would bail out and re-render nothing).
 *
 * **One write primitive.** {@link transact} runs any facade write — plan or ledger, one call
 * or a batch — and surfaces a refusal as {@link conflict}; the facade throws on a refused
 * write, so the catch is where a rejected transaction turns into a message instead of a state
 * change. There is deliberately no plan-shaped setter beside it: a `setPlan` would let a
 * caller hand back a `Plan` this hook could only take on faith, and the id counter, the
 * goal-funding guard and the affordability gate all live on the far side of the facade.
 *
 * A write spanning both planes is therefore one transaction rather than two coordinated ones
 * (see `jobWrites.ts`): the handle is discarded whole on a refusal, so a conflict cannot land
 * the plan half of an edit whose ledger half was rejected.
 */

import { useCallback, useRef, useState } from "react";
import { Projection } from "@finley/engine";
import type { ProjectionState } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";

/**
 * Run one transaction against a momentary {@link Projection}. Returns the write's own result
 * — the minted id for a creating write — or `undefined` when the facade refused it.
 */
export type Transact = <R>(fn: (projection: Projection) => R) => R | undefined;

export interface UseProjection {
  state: ProjectionState;
  conflict: string | null;
  transact: Transact;
  /** Drop a timeline transaction and everything it caused. */
  removeEvent: (id: string) => void;
  /** Replace the whole state — how a preset load swaps in a pre-built scenario. */
  loadState: (next: ProjectionState) => void;
}

/**
 * The raw conflict the UI shows, recovered from the facade's thrown message
 * (`Projection: cannot <verb> — <reason>`). The reason is what `addEvent`/`removeEvent` return,
 * so stripping the prefix keeps the wording identical to the pre-facade write path.
 */
function conflictOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Projection: cannot [^—]*— /, "");
}

export function useProjection(initial: ProjectionState): UseProjection {
  const [state, setState] = useState(initial);
  const [conflict, setConflict] = useState<string | null>(null);
  // The latest state, readable synchronously. Two reasons, both about *this* tick: a caller
  // needing the minted id cannot use a functional updater (it would only run a render later),
  // and two writes in one tick must compose — the second reads what the first committed here,
  // not the render-old `state`. Mirrored every render and on each accepted write.
  const stateRef = useRef(state);
  stateRef.current = state;

  const transact = useCallback<Transact>((fn) => {
    try {
      const { state: next, result } = Projection.transact(stateRef.current, usJurisdiction, fn);
      stateRef.current = next;
      setState(next);
      // Cleared only on success, so a standing conflict survives until something actually
      // changes — and never outlives the write that answered it.
      setConflict(null);
      return result;
    } catch (error) {
      setConflict(conflictOf(error));
      return undefined;
    }
  }, []);

  const removeEvent = useCallback(
    (id: string): void => {
      transact((p) => p.removeTransaction(id));
    },
    [transact],
  );

  const loadState = useCallback((next: ProjectionState): void => {
    stateRef.current = next;
    setState(next);
    setConflict(null);
  }, []);

  return { state, conflict, transact, removeEvent, loadState };
}
