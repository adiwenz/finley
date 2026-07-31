/**
 * The authoring state every projection write derives from, and the three derivations they all
 * share: swap the plan, swap the ledger, or prove a plan collection holds the id being edited.
 *
 * Writes are plain functions of state — `(state, …) => ProjectionState` — so the module that
 * knows a domain (jobs, goals, transactions) owns its rules without owning the handle. The
 * `Projection` facade is what holds `current` and is the only thing that swaps it; nothing here
 * mutates anything.
 */

import type { Plan } from "../plan";
import type { Scenario } from "../scenario";
import { withLedger, withPlan } from "../scenario";
import type { Ledger } from "../ledger/ledger";

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
  if (!plan[collection].some((entry: { id: string }) => entry.id === id)) {
    throw new Error(`Projection: cannot edit a ${noun} — no ${noun} "${id}" on this plan`);
  }
  return plan;
}
