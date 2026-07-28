/**
 * A `Scenario` is the **projectable unit**: a {@link Plan} (standing steady-state numbers)
 * paired with the {@link Ledger} of timeline events played on top. The engine always
 * projects a `Scenario`, never a bare `Plan`, so life events (a child at 40, a new expense,
 * a separation) can never be silently dropped — there is no way to hand the simulator a plan
 * and forget its ledger.
 *
 * The split mirrors {@link Plan}'s own definition ("standing state, as opposed to timeline
 * events"): `createProjectionBase` compiles only the `plan`, and the `ledger` replays on
 * top. The `Scenario` is just the bundle the two are projected as.
 */
import type { Plan } from "./plan";
import type { Ledger } from "./ledger/ledger";
import { emptyLedger } from "./ledger/ledger";

export interface Scenario {
  /** The standing steady-state numbers (income, expenses, returns, ages, jobs, goals). */
  readonly plan: Plan;
  /** The timeline events replayed on top of the plan. */
  readonly ledger: Ledger;
}

/**
 * The baseline scenario for a plan: its authored numbers with **no** timeline events. For
 * the plan-only projection (e.g. engine tests pinning solver behaviour on the standing
 * plan), making "no events" an explicit choice rather than a silent default.
 */
export function scenarioOf(plan: Plan): Scenario {
  return { plan, ledger: emptyLedger };
}

/** `scenario` with its `plan` replaced and its `ledger` carried through unchanged. */
export function withPlan(scenario: Scenario, plan: Plan): Scenario {
  return { plan, ledger: scenario.ledger };
}

/**
 * `scenario` with its `ledger` replaced and its `plan` carried through unchanged — mirror of
 * {@link withPlan}, for a transaction that grows the timeline without touching the standing
 * numbers. Having both means neither half is dropped by a spread that forgot a field.
 */
export function withLedger(scenario: Scenario, ledger: Ledger): Scenario {
  return { plan: scenario.plan, ledger };
}
