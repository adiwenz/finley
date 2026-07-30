/**
 * The panel-test harness: a real {@link useProjection} over a plan (and optionally a seed
 * ledger), so an edit made in a panel round-trips through the same facade the app writes
 * through — the id mint, the counter floor and the ledger's validation all included.
 *
 * Panels take a `transact`, not a plan setter, so a bare `useState<Plan>` cannot stand in for
 * one: it would accept writes the facade refuses and mint ids the facade would not. Using the
 * hook itself keeps the tests honest about both.
 *
 * Every projection here is built the way the app builds its own — `Projection.create` over the
 * plan, then `resetLedger` for a seed timeline — so a test cannot assemble a handle the app
 * could never produce, and never reaches past the public API to do it.
 */

import { useState } from "react";
import { Projection } from "@finley/engine";
import type { Jurisdiction, Ledger, Plan, ProjectionResult } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { START_YEAR } from "../config";
import { useProjection, type UseProjection } from "../hooks/useProjection";

/**
 * A handle over a fixture plan and an optional seed ledger. `create` floors the counters past
 * whatever ids the plan already carries, and `resetLedger` re-floors past the timeline's, so a
 * fixture holding `job-1` cannot have a second `job-1` minted on top of it.
 */
function projectionFor(
  plan: Plan,
  ledger: Ledger | undefined,
  jurisdiction: Jurisdiction,
): Projection {
  const projection = Projection.create({ plan, startYear: START_YEAR }, jurisdiction);
  if (ledger !== undefined) projection.resetLedger(ledger);
  return projection;
}

export function useTestProjection(plan: Plan, ledger?: Ledger): UseProjection {
  const [initial] = useState(() => projectionFor(plan, ledger, usJurisdiction).toState());
  return useProjection(initial);
}

/**
 * A handle over a fixture plan, for the reads a panel makes. Each panel's prop names only the
 * members it uses, so this satisfies every one of them.
 */
export function readerOf(plan: Plan, ledger?: Ledger): Projection {
  return projectionFor(plan, ledger, usJurisdiction);
}

/**
 * One completed run over a fixture plan — what a panel taking a `ProjectionResult` reads. Built
 * the same way the app builds its own (`create` → `run`), so a test cannot accidentally
 * assemble a result the app could never produce.
 *
 * `jurisdiction` defaults to the app's, which is what a panel test wants. Pass
 * `nullJurisdiction` where a fixture pins arithmetic on a stated surplus: withholding would
 * make "$5,000 gross − $3,500 spending = $1,500 to save" untrue, and the assertion would then
 * be pinning the tax tables rather than the behaviour under test.
 */
export function runOf(
  plan: Plan,
  ledger?: Ledger,
  jurisdiction: Jurisdiction = usJurisdiction,
): ProjectionResult {
  return projectionFor(plan, ledger, jurisdiction).run(jurisdiction);
}
