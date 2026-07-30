/**
 * The panel-test harness: a real {@link useProjection} over a plan (and optionally a seed
 * ledger), so an edit made in a panel round-trips through the same facade the app writes
 * through — the id mint, the counter floor and the ledger's validation all included.
 *
 * Panels take a `transact`, not a plan setter, so a bare `useState<Plan>` cannot stand in for
 * one: it would accept writes the facade refuses and mint ids the facade would not. Using the
 * hook itself keeps the tests honest about both.
 */

import { useState } from "react";
import { Projection, emptyLedger, scenarioOf, withLedger } from "@finley/engine";
import type {
  Jurisdiction,
  Ledger,
  Plan,
  ProjectionResult,
  ProjectionState,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { START_YEAR } from "../config";
import { useProjection, type UseProjection } from "../hooks/useProjection";

/**
 * A fixture plan and its seed ledger as the {@link ProjectionState} the app holds.
 *
 * `nextSeq: 1` means "not known" rather than "starts at 1": {@link Projection.fromState} floors
 * both counters past whatever ids the fixture already carries, so a fixture holding `goal-1`
 * cannot have a second `goal-1` minted on top of it. Every helper below goes through here, so a
 * test builds its state exactly one way.
 */
export function stateOf(plan: Plan, ledger: Ledger = emptyLedger): ProjectionState {
  return { scenario: withLedger(scenarioOf(plan), ledger), startYear: START_YEAR, nextSeq: 1 };
}

export function useTestProjection(plan: Plan, ledger: Ledger = emptyLedger): UseProjection {
  const [initial] = useState(() =>
    Projection.fromState(stateOf(plan, ledger), usJurisdiction).toState(),
  );
  return useProjection(initial);
}

/**
 * A handle over a fixture plan, for the reads a panel makes. Each panel's prop names only the
 * members it uses, so this satisfies every one of them. Built through `fromState`, so the
 * counters are floored exactly as the app's are.
 */
export function readerOf(plan: Plan, ledger: Ledger = emptyLedger): Projection {
  return Projection.fromState(stateOf(plan, ledger), usJurisdiction);
}

/**
 * One completed run over a fixture plan — what a panel taking a `ProjectionResult` reads. Built
 * the same way the app builds its own (`fromState` → `run`), so a test cannot accidentally
 * assemble a result the app could never produce.
 *
 * `jurisdiction` defaults to the app's, which is what a panel test wants. Pass
 * `nullJurisdiction` where a fixture pins arithmetic on a stated surplus: withholding would
 * make "$5,000 gross − $3,500 spending = $1,500 to save" untrue, and the assertion would then
 * be pinning the tax tables rather than the behaviour under test.
 */
export function runOf(
  plan: Plan,
  ledger: Ledger = emptyLedger,
  jurisdiction: Jurisdiction = usJurisdiction,
): ProjectionResult {
  return Projection.fromState(stateOf(plan, ledger), jurisdiction).run(jurisdiction);
}
