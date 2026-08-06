/**
 * The authoring state every projection write derives from, and the three derivations they all
 * share: swap the plan, swap the ledger, or prove a plan collection holds the id being edited.
 *
 * Writes are plain functions of state — `(state, …) => ProjectionState` — so the module that
 * knows a domain (jobs, goals, transactions) owns its rules without owning the handle. The
 * `Projection` facade is what holds `current` and is the only thing that swaps it; nothing here
 * mutates anything.
 */

import type { Plan } from "../plan/plan";
import { ageAboveMaximum } from "../plan/plan";
import type { Scenario } from "../plan/scenario";
import { scenarioOf, withLedger, withPlan } from "../plan/scenario";
import type { Ledger } from "../ledger/ledger";
import type { ScenarioScalars } from "../input/scenarioInput";
import { PRIMARY_PERSON_ID } from "../compile/projectionBase";

/** The immutable authoring state a `Projection` holds, and the whole of what it serializes. */
export interface ProjectionState {
  /**
   * Plan plus the {@link Ledger} replayed on top of it. One field rather than two siblings,
   * so a timeline cannot be silently dropped on its way to a run.
   */
  readonly scenario: Scenario;
  /** The frozen "now" — calendar year of month 0. An input, never a wall-clock read. */
  readonly startYear: number;
  readonly nextSeq: number;
  /**
   * The format version of the shape that wrote this state — self-describing, so a loader knows
   * whether it can read it. A write stamps `CURRENT_FORMAT_VERSION`; restoration rejects any
   * other with `UnsupportedVersionError` before it touches replay, since a shape this build
   * cannot read is not worth replaying.
   */
  readonly version: number;
}

/**
 * The format version this build writes, and — until a migration exists — the sole one it reads.
 * Bump when the serialized shape changes incompatibly.
 *
 * Declared beside {@link ProjectionState} because it describes that shape: a state stamps it on
 * the way out, and `./restore` refuses anything else on the way in. A *range* of accepted
 * versions would be a promise this build cannot keep — reading a v1 file under v2 rules means
 * transforming it, and no transforms exist — so the gate there is exact equality, and it stays
 * exact until the first real migration lands.
 */
export const CURRENT_FORMAT_VERSION = 1;

/**
 * The one state that provably holds no id at all: the plan's scalars, three empty collections and
 * an empty ledger. Everything else about a scenario is added afterwards, through the authoring
 * methods that mint as they go.
 *
 * The counter opens at 1 with nothing to floor past, and the version is stamped current because
 * THIS build authored it — so restoring straight back over it passes both gates trivially, which
 * is exactly what `Projection.init` does rather than keeping a second, unchecked door open.
 */
export function emptyState(scalars: ScenarioScalars): ProjectionState {
  const { startYear, name, birthYear, lifeExpectancy, benefitClaimingAge, ...rest } = scalars;
  // The age bound applies at the door as well as on every later edit — `Projection.init` is a
  // way into the plan that does not pass through `withPlanPatch`, and a horizon nobody can
  // afford to simulate is no more welcome for having arrived first.
  const bad = ageAboveMaximum({ birthYear, lifeExpectancy, benefitClaimingAge }, startYear);
  if (bad) {
    throw new Error(`Projection: cannot open a plan with ${bad.field} ${bad.age} — it may not exceed ${bad.limit}`);
  }
  return {
    scenario: scenarioOf({
      ...rest,
      goals: [],
      budgetLines: [],
      primary: {
        id: PRIMARY_PERSON_ID,
        name,
        birthYear,
        lifeExpectancy,
        benefitClaimingAge,
        jobs: [],
      },
    }),
    startYear,
    nextSeq: 1,
    version: CURRENT_FORMAT_VERSION,
  };
}

/**
 * A write that answers with something besides the next state — the minted id, almost always.
 * A write with nothing to say returns the state alone, so the common case stays unwrapped.
 */
export interface Written<R> {
  readonly state: ProjectionState;
  readonly result: R;
}

/**
 * `state` with `plan` swapped in, carrying the ledger through so no standing write drops the
 * timeline. `nextSeq` moves with it when the write minted an id, so the plan and the counter
 * that named its contents land as ONE new state.
 */
export function withStatePlan(
  state: ProjectionState,
  plan: Plan,
  nextSeq?: number,
): ProjectionState {
  return {
    ...state,
    scenario: withPlan(state.scenario, plan),
    ...(nextSeq !== undefined ? { nextSeq } : {}),
  };
}

/** The ledger-plane counterpart of {@link withStatePlan}, carrying the plan through. */
export function withStateLedger(
  state: ProjectionState,
  ledger: Ledger,
  nextSeq?: number,
): ProjectionState {
  return {
    ...state,
    scenario: withLedger(state.scenario, ledger),
    ...(nextSeq !== undefined ? { nextSeq } : {}),
  };
}

/**
 * The plan, once it is known to hold `id` in `collection` — or a refusal naming the id.
 *
 * An edit aimed at something that is not there is a caller error, not a smaller edit: the id
 * came from somewhere that no longer agrees with this state, so the write the caller believes
 * it made has not happened. One contract across every authored collection and both planes
 * (`partnerJobSite` in `./jobs` for a partner's jobs), so a caller never has to know which kind
 * of thing it asked for in order to handle the answer.
 */
export function planSite(
  state: ProjectionState,
  collection: "jobs" | "goals" | "budgetLines",
  id: string,
): Plan {
  const plan = state.scenario.plan;
  const noun = collection === "budgetLines" ? "budget line" : collection.slice(0, -1);
  const entries = collection === "jobs" ? plan.primary.jobs : plan[collection];
  if (!entries.some((entry: { id: string }) => entry.id === id)) {
    throw new Error(`Projection: cannot edit a ${noun} — no ${noun} "${id}" on this plan`);
  }
  return plan;
}
