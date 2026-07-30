/**
 * The app's single authoring hook. React holds one immutable {@link ProjectionState}; every
 * write builds a momentary {@link Projection} over it, mutates that, and discards it — the
 * state React keeps is the value, never a live handle (a mutated handle is `Object.is`-equal
 * to itself, so `useState` would bail out and re-render nothing).
 *
 * Two write shapes, one discipline. {@link transact} runs any facade write and surfaces a
 * refusal as {@link conflict}; the facade throws on a refused write, so the catch is where a
 * rejected transaction turns into a message instead of a state change. {@link setBudget}
 * reshapes the plan through the domain transforms directly (they mint nothing and need no
 * jurisdiction), carrying the ledger reference through untouched so a plan-only edit leaves
 * ledger-keyed memos able to skip. The counter is not re-floored here — every facade write
 * floors it on entry ({@link Projection.transact} builds through `fromState`), so an
 * app-minted job id is stepped over before the next mint regardless.
 */

import { useCallback, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Projection, withPlan } from "@finley/engine";
import type { Plan, ProjectionState, NewLifeEvent } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";

export interface EventRevision {
  readonly id: string;
  readonly next: NewLifeEvent;
}

export interface UseProjection {
  state: ProjectionState;
  conflict: string | null;
  /**
   * Reshape the plan through the domain transforms (`withGoalPatch`, `mapJob`, …). Functional
   * updates compose against the latest plan, so two edits in one tick don't discard each other.
   */
  setBudget: Dispatch<SetStateAction<Plan>>;
  /**
   * Run one facade write over the current state. Returns the write's own result — the minted
   * id for a creating write — or `undefined` when the facade refused it (the reason lands in
   * {@link conflict}).
   */
  transact: <R>(fn: (p: Projection) => R) => R | undefined;
  /**
   * Revise timeline events in one all-or-nothing write; `false` = refused, nothing changed.
   * Reports acceptance synchronously (off {@link stateRef}) so a caller spanning both planes —
   * the Jobs panel revises an event *and* edits the plan — can skip the plan side on a refusal.
   */
  reviseEvents: (revisions: readonly EventRevision[]) => boolean;
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
  // The latest state, readable synchronously: a cross-plane job write must know its ledger
  // revision was accepted before it writes the plan, which a functional setState (a render
  // later) cannot answer. Mirrored every render and on each accepted write.
  const stateRef = useRef(state);
  stateRef.current = state;

  const commit = useCallback((next: ProjectionState): void => {
    stateRef.current = next;
    setState(next);
    setConflict(null);
  }, []);

  const transact = useCallback(
    <R,>(fn: (p: Projection) => R): R | undefined => {
      try {
        const { state: next, result } = Projection.transact(stateRef.current, usJurisdiction, fn);
        commit(next);
        return result;
      } catch (error) {
        setConflict(conflictOf(error));
        return undefined;
      }
    },
    [commit],
  );

  const reviseEvents = useCallback(
    (revisions: readonly EventRevision[]): boolean => {
      try {
        // One projection, all revisions: the first refusal throws and the whole handle is
        // discarded, so a conflict can never land a partial edit.
        const { state: next } = Projection.transact(stateRef.current, usJurisdiction, (p) => {
          for (const r of revisions) p.reviseTransaction(r.id, r.next);
        });
        commit(next);
        return true;
      } catch (error) {
        setConflict(conflictOf(error));
        return false;
      }
    },
    [commit],
  );

  const removeEvent = useCallback(
    (id: string): void => {
      transact((p) => p.removeTransaction(id));
    },
    [transact],
  );

  const setBudget = useCallback<Dispatch<SetStateAction<Plan>>>((action) => {
    setState((s) => {
      const nextPlan =
        typeof action === "function" ? (action as (prev: Plan) => Plan)(s.scenario.plan) : action;
      return { ...s, scenario: withPlan(s.scenario, nextPlan) };
    });
  }, []);

  const loadState = useCallback((next: ProjectionState): void => commit(next), [commit]);

  return { state, conflict, setBudget, transact, reviseEvents, removeEvent, loadState };
}
