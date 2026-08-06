/**
 * The id mint and the floor that keeps it ahead of everything a scenario already holds.
 *
 * One counter issues every id in a scenario, and one parser recognizes them coming back in.
 * Both live here because they are inverses: a kind that mints but is not recognized on the way
 * back is exactly how a counter walks onto a live id.
 */

import type { Job } from "../job/job";
import type { Scenario } from "../plan/scenario";
import type { LifeEvent } from "../ledger/eventTypes";
import { causedByEventId } from "../ledger/eventTypes";
import type { ProjectionState } from "./state";
import { withStateLedger } from "./state";

/**
 * Every kind the shared counter issues ids for. ONE list: {@link mint} accepts nothing else,
 * so the compiler refuses a new kind until it is named here, and {@link MINTED_ID} — the
 * parser that has to recognize the same ids coming back in — is built from it.
 */
const MINTED_KINDS = [
  "job",
  "adjustment",
  "line",
  "goal",
  "person",
  "child",
  "separation",
  "payoff",
  "loan",
  "home",
  "mortgage",
] as const;

export type MintedKind = (typeof MINTED_KINDS)[number];

/** The exact inverse of {@link mint}'s `${kind}-${n}` template — no other shape parses. */
const MINTED_ID = new RegExp(`^(?:${MINTED_KINDS.join("|")})-(\\d+)$`);

/**
 * The number {@link mint} issued to make this id, or `null` for anything it did not make.
 *
 * Rejects a suffix past `Number.MAX_SAFE_INTEGER`: past that, `Number` rounds, so
 * `job-9007199254740993` would parse to an integer neighbouring value and set a floor no
 * counter can reach — the mint would then hand out the SAME id forever, since incrementing a
 * non-safe integer is a no-op. Ignoring it is correct as well as safe: `mint` cannot have
 * issued a number it cannot count to, so nothing that far out is a real minted id.
 */
function mintedNumber(id: string | undefined): number | null {
  if (id === undefined) return null;
  const match = MINTED_ID.exec(id);
  if (match === null) return null;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Issue the next id. `<kind>-<n>` off ONE counter shared by every kind, so a job, a goal and a
 * loan can never be handed the same number and an id says what it names.
 *
 * There is no override: no authoring input carries an `id`, so identity has a single source.
 * Every authoring path mints through here, and a caller cannot name what they issue.
 *
 * Ids that already exist therefore reach a scenario exactly one way — restoration adopting
 * state that was authored earlier. Those never pass through here at all; {@link seqFloor} steps
 * the counter past them instead.
 */
export function mint(
  state: ProjectionState,
  kind: MintedKind,
): { id: string; nextSeq: number } {
  return { id: `${kind}-${state.nextSeq}`, nextSeq: state.nextSeq + 1 };
}

/**
 * A job's ids: its own, its owner's, the account its deferral funds, and every authored
 * adjustment riding it.
 *
 * The adjustments matter as much as the job: they are minted off this same counter, so a
 * restored plan holding `adjustment-7` must push the floor past it or the next bonus authored
 * is handed an id a stacked sibling already answers to — and removing one would then take both.
 */
function jobIds(job: Job): readonly (string | undefined)[] {
  return [
    job.id,
    job.ownerId,
    job.deferral?.fundAccountId,
    ...(job.payChanges ?? []).map((c) => c.id),
    ...(job.incomeOverrides ?? []).map((o) => o.id),
  ];
}

/**
 * The id-bearing fields of one event, named field by field. The switch is exhaustive over
 * {@link LifeEvent} — the `never` default makes a new event type a COMPILE error here, so an
 * id field cannot be added to the union and silently left out of the floor.
 */
function eventIds(event: LifeEvent): readonly (string | undefined)[] {
  const common = [event.id, causedByEventId(event)];
  switch (event.type) {
    case "RelationshipEvent":
      return [...common, event.person.id, ...event.person.jobs.flatMap(jobIds)];
    case "ChildEvent":
      return [...common, event.childId];
    case "SeparationEvent":
      return [...common, event.partnerPersonId];
    case "HomePurchaseEvent":
      // The embedded mortgage's liability id is minted just like any other — floor past it too,
      // or a restored plan holding `mortgage-3` hands the next financed purchase the same id.
      return [
        ...common,
        event.propertyId,
        event.ownerId,
        event.mortgage?.liabilityId,
        ...event.downPaymentSourceIds,
      ];
    case "LoanEvent":
      return [...common, event.liabilityId, event.ownerId];
    case "DebtPayoffEvent":
      return [...common, event.liabilityId, event.accountId];
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

/**
 * Every field of a {@link Scenario} that can hold an id the counter issued — the plan's three
 * collections and each event, named explicitly.
 *
 * Named fields, NOT a walk over every string: a `childName` of `"room-50000"` or a label of
 * `"goal-2 rewrite"` is a person's words, and treating it as a counter reading would advance
 * the mint by fifty thousand on the strength of a typo. Only somewhere an id actually lives
 * is read.
 */
function mintedIdFields(scenario: Scenario): readonly (string | undefined)[] {
  const { plan, ledger } = scenario;
  return [
    ...plan.jobs.flatMap(jobIds),
    ...plan.goals.map((g) => g.id),
    ...plan.budgetLines.flatMap((l) => [
      l.id,
      l.target.kind === "account" ? l.target.accountId : undefined,
    ]),
    ...ledger.events.flatMap(eventIds),
  ];
}

/**
 * The counter floor a scenario forces — ONE number, computed once, serving both counters that
 * RESTORED data can invalidate.
 *
 * Restored is the whole of it: authoring mints, so nothing an authoring call produces can be
 * ahead of the counter. Ids reach a scenario without passing through {@link mint} only when
 * restoration adopts state that already holds them — which is why that is the one place this
 * runs on the way in.
 *
 *  - `ProjectionState.nextSeq`, the id mint. A plan holding `job-1` or an event holding
 *    `child-1` means the next `addJob` / `haveChild` must not mint it a second time.
 *  - `Ledger.nextSequenceNumber`, the same-month tie-breaker `addEvent` stamps from.
 *    Its invariant (strictly above every event's `sequenceNumber`) is documented but not
 *    enforced on data arriving from outside, and a ledger violating it hands the next two
 *    appends the SAME sequence number.
 *
 * Never decreases: `current` is a lower bound, so a number already issued stays spent and an
 * import cannot walk the counter back onto a live id.
 */
export function seqFloor(scenario: Scenario, current: number): number {
  let floor = Math.max(current, scenario.ledger.nextSequenceNumber);
  for (const event of scenario.ledger.events) {
    floor = Math.max(floor, event.sequenceNumber + 1);
  }
  for (const id of mintedIdFields(scenario)) {
    const n = mintedNumber(id);
    if (n !== null) floor = Math.max(floor, n + 1);
  }
  return floor;
}

/**
 * `state` with the id counter alone raised to the floor its contents force — the shape a handle
 * adopts every derived state through.
 *
 * Just `nextSeq`, because a state reached by a write has a ledger counter the ledger itself
 * advanced; only one arriving from outside has an untrustworthy one, and that is
 * {@link withNormalizedCounters}. Flooring on adoption rather than inside each write is what
 * makes it structural: a new authoring path cannot be added that forgets to. Since the floor
 * never decreases, doing it every time costs nothing but a walk.
 */
export function withFlooredIdCounter(state: ProjectionState): ProjectionState {
  return { ...state, nextSeq: seqFloor(state.scenario, state.nextSeq) };
}

/**
 * `state` with BOTH counters raised to the floor its own contents force — the entry point for
 * every state that arrives from outside rather than being built up by writes.
 *
 * Whole-state normalization, not just `nextSeq`: a serialized state carries the ledger's
 * `nextSequenceNumber` too, and it is no more trustworthy than the id counter. Its invariant
 * (strictly above every event's `sequenceNumber`) is documented but nothing enforces it on
 * data that has been round-tripped through JSON, edited by hand, or written by an older build.
 *
 * Never decreases either counter, and is idempotent — normalizing an already-normal state
 * returns the same numbers.
 */
export function withNormalizedCounters(state: ProjectionState): ProjectionState {
  const floored = withFlooredIdCounter(state);
  return withStateLedger(
    floored,
    { ...floored.scenario.ledger, nextSequenceNumber: floored.nextSeq },
    floored.nextSeq,
  );
}
