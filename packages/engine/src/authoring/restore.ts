/**
 * Restoration — what has to be true of state that arrives from outside before a handle will
 * open over it, in the one order that gives a usable answer.
 *
 * A serialized state is the least trustworthy input the API takes: through JSON, possibly
 * hand-edited or truncated, possibly written by a build whose counters meant something else. So
 * three things happen here and nowhere else — the version is checked, both counters are floored
 * past what the scenario actually holds, and the ledger is proved to replay.
 */

import type { Jurisdiction } from "../jurisdiction/jurisdiction";
import type { ProjectionState } from "./state";
import { CURRENT_FORMAT_VERSION } from "./state";
import { withNormalizedCounters } from "./mint";
import { assertReplayable } from "./eventWrite";

/**
 * The version-rejection bucket, distinct from the generic invalid-plan `Error` a shape/replay
 * failure throws: it names a file the app cannot open because it is the wrong *version*, so the
 * UX is "update to open this" rather than "can't open". Carries the file's declared version
 * (`undefined` when the plan predates versioning) and the one version this build reads.
 */
export class UnsupportedVersionError extends Error {
  constructor(
    readonly fileVersion: number | undefined,
    readonly supported: number,
  ) {
    super(
      `Projection: cannot load — plan format version ${fileVersion ?? "unknown"} is unsupported; ` +
        `this build reads version ${supported}`,
    );
    this.name = "UnsupportedVersionError";
  }
}

/**
 * Reject anything but {@link CURRENT_FORMAT_VERSION}, including an unversioned plan.
 *
 * Exact equality, deliberately — an older version is no more loadable than a newer one while
 * there is nothing to migrate it with.
 */
function assertSupportedVersion(version: number | undefined): void {
  if (version !== CURRENT_FORMAT_VERSION) {
    throw new UnsupportedVersionError(version, CURRENT_FORMAT_VERSION);
  }
}

/**
 * Every person in the state states a life expectancy — the primary on the plan, and each partner
 * on the `RelationshipEvent` that brought them in.
 *
 * The field is required, and the version says nothing about it: the shape changed while this build
 * was the only thing writing states, so no file carries the older one and the version was not
 * bumped. What is left is the case restoration exists for — a state whose contents are simply
 * wrong, hand-edited, truncated, or written by something other than `toJSON`. Checked here rather
 * than left to the projection because the field is what the horizon is computed from, and its
 * absence surfaces as a run of `NaN` months rather than as anything a reader could act on.
 *
 * A generic invalid-plan `Error`, not {@link UnsupportedVersionError}: the version is the one this
 * build reads, so "update to open this" would be a lie. It is simply not a valid state.
 */
function assertEveryPersonHasLifeExpectancy(state: ProjectionState): void {
  const stated = (age: unknown): boolean => typeof age === "number" && Number.isFinite(age);
  if (!stated(state.scenario.plan.primary?.lifeExpectancy)) {
    throw new Error("Projection: cannot load — the plan's primary states no lifeExpectancy");
  }
  for (const event of state.scenario.ledger.events) {
    if (event.type !== "RelationshipEvent") continue;
    if (!stated(event.person?.lifeExpectancy)) {
      throw new Error(
        `Projection: cannot load — "${event.person?.name ?? event.id}" states no lifeExpectancy`,
      );
    }
  }
}

/**
 * `state` made fit to open a handle over, or a refusal. The order is the contract:
 *
 *  1. **Version first.** A foreign shape must be refused as unsupported, not dragged through a
 *     replay that would blame some arbitrary event for a mismatch the whole file carries.
 *  2. **Shape checked**, for what the version does not promise — see
 *     {@link assertEveryPersonHasLifeExpectancy}. Before the counters and the replay, for the same
 *     reason the version is: a state missing a field the horizon is derived from should be refused
 *     as itself, not as a replay failure at some arbitrary event.
 *  3. **Counters floored.** A stale `nextSeq` beside a plan holding `job-5` would mint `job-5`
 *     again on the first write. Normalization only ever RAISES a counter and is idempotent from
 *     the second pass on, so a reload can never walk one downward.
 *  4. **Replay proved**, against the floored state and the jurisdiction the handle will validate
 *     under — so a timeline that cannot rebuild is refused at the door rather than at run time.
 */
export function restoreState(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
): ProjectionState {
  assertSupportedVersion(state.version);
  assertEveryPersonHasLifeExpectancy(state);
  const normalized = withNormalizedCounters(state);
  assertReplayable(normalized, jurisdiction);
  return normalized;
}
