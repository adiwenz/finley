/**
 * The panel-test harness: a real {@link useProjection} over a plan (and optionally a seed
 * ledger), so an edit made in a panel round-trips through the same facade the app writes
 * through — the id mint, the counter floor and the ledger's validation all included.
 *
 * Panels take a `transact`, not a plan setter, so a test can no longer stand in a bare
 * `useState<Plan>`: it would accept writes the facade would refuse and mint ids the facade
 * would not. Using the hook itself keeps the tests honest about both.
 */

import { useState } from "react";
import { Projection, emptyLedger, scenarioOf, withLedger } from "@finley/engine";
import type { Ledger, Plan } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { START_YEAR } from "../config";
import { useProjection, type UseProjection } from "../hooks/useProjection";

/**
 * `fromScenario` floors both counters past whatever ids the fixture already carries, so a
 * fixture holding `job-1` cannot have a second `job-1` minted on top of it.
 */
export function useTestProjection(plan: Plan, ledger: Ledger = emptyLedger): UseProjection {
  const [initial] = useState(() =>
    Projection.fromScenario(
      withLedger(scenarioOf(plan), ledger),
      START_YEAR,
      usJurisdiction,
    ).toState(),
  );
  return useProjection(initial);
}
