/**
 * Ref resolution for a {@link ScenarioInput}: the standalone validation pass that runs BEFORE
 * anything is minted or applied. It answers one question — does every {@link Ref} in the
 * document name something addressable at the point it is used? — and, as a byproduct, hands back
 * the month-ordered event schedule the applier will walk.
 *
 * A ref resolves against, in order:
 *  1. **Refs declared elsewhere in the same document.** An entry that declares a `ref` makes that
 *     name addressable; a goal's declared name addresses its DERIVED fund account
 *     ({@link goalFundAccountId}), which is why a contribution or payoff can target a goal.
 *  2. **Well-known stable ids** ({@link WELL_KNOWN_REF_IDS}) that exist before any entry applies:
 *     the primary person, the three standing accounts, and the synthetic credit card.
 *
 * Three shapes are refused, each naming the offending entry by index and ref:
 *  - **duplicate** — one name declared twice, or a name that shadows a well-known id;
 *  - **unresolvable** — a pointer to a name nothing ever declares;
 *  - **forward** — a pointer to a name declared only LATER in application order. Application is in
 *    month order, so a payoff at month 40 may reference a loan at month 12 but never the reverse.
 *
 * Actual ids are minted by the applier, not here — this pass proves the graph is sound so the
 * applier can mint in order and trust every lookup will hit.
 */

import { PRIMARY_PERSON_ID, SAVINGS_ID, BROKERAGE_ID } from "./projectionBase";
import { RETIREMENT_ID } from "./ids";
import { SYNTHETIC_CARD_ID } from "./liability";
import { entryMonth, ref } from "./scenarioInput";
import type {
  ScenarioInput,
  EventEntry,
  JobEntry,
  Ref,
  ScenarioInputError,
} from "./scenarioInput";

/**
 * The things a ref may name without any entry declaring them: the primary person and synthetic
 * card exist before the timeline runs, and the three standing accounts fall out of the plan's
 * scalar fields — there is no input object to hang a `ref` on, yet a down payment or contribution
 * must still be able to name them.
 *
 * Exported pre-branded so authoring reads `ownerRef: PRIMARY_PERSON_REF` rather than wrapping a
 * raw id at every call site. Each happens to spell the id it resolves to — these are the one
 * place where a ref and an id coincide, because the engine, not the document, named the thing.
 */
export const PRIMARY_PERSON_REF: Ref = ref(PRIMARY_PERSON_ID);
export const SAVINGS_REF: Ref = ref(SAVINGS_ID);
export const RETIREMENT_REF: Ref = ref(RETIREMENT_ID);
export const BROKERAGE_REF: Ref = ref(BROKERAGE_ID);
export const SYNTHETIC_CARD_REF: Ref = ref(SYNTHETIC_CARD_ID);

/** The same set, as the raw ids resolution matches against. */
export const WELL_KNOWN_REF_IDS: ReadonlySet<string> = new Set([
  PRIMARY_PERSON_ID,
  SAVINGS_ID,
  RETIREMENT_ID,
  BROKERAGE_ID,
  SYNTHETIC_CARD_ID,
]);

/** An event paired with its ORIGINAL index in `input.events`, so errors and the applier can name it. */
export interface ScheduledEvent {
  readonly entry: EventEntry;
  readonly index: number;
}

export type ResolveRefsResult =
  | { readonly ok: true; readonly order: readonly ScheduledEvent[] }
  | { readonly ok: false; readonly error: ScenarioInputError };

/**
 * The plan plane applies as one block before every event, so its declarations are visible to each
 * other regardless of array order; events take non-negative orders and see only STRICTLY earlier
 * ones. A usage at order `U` sees a declaration at order `D` iff `D` is the plan plane or `D < U`.
 */
const PLAN_ORDER = -1;

/** Where a ref sits, for the error's `reason` and its machine-readable `eventIndex`. */
interface Location {
  readonly describe: string;
  /** Set only when the entry is an event (or nested in one), matching {@link ScenarioInputError.eventIndex}. */
  readonly eventIndex?: number;
}

interface Declaration {
  readonly ref: Ref;
  readonly order: number;
  readonly loc: Location;
}

interface Usage {
  readonly ref: Ref;
  readonly order: number;
  readonly loc: Location;
}

/**
 * The refs a job carries whatever plane it sits on: its own declared name, and the account its
 * deferral funds. This is the whole of what a job nested in a `marry` can carry — its owner is
 * the partner that entry creates, so there is no `ownerRef` to read, and reading one would mean
 * validating a field the build then discards.
 */
function collectPartnerJob(
  // The OWNERLESS view of a job entry, not `PartnerJobEntry` itself: that type additionally
  // forbids `ownerRef` (`?: never`), which a plan-plane `JobEntry` cannot satisfy, and
  // `collectJob` below delegates here. Widening the parameter keeps one implementation of the
  // shared half while leaving the nested-position ban to the type `MarryEntry.jobs` declares.
  job: Omit<JobEntry, "ownerRef">,
  order: number,
  loc: Location,
  decls: Declaration[],
  usages: Usage[],
): void {
  if (job.ref !== undefined) decls.push({ ref: job.ref, order, loc });
  const fundRef = job.deferral?.fundAccountRef;
  if (fundRef !== undefined) usages.push({ ref: fundRef, order, loc });
}

/** A plan-plane job: the above, plus the owner it may name. */
function collectJob(
  job: JobEntry,
  order: number,
  loc: Location,
  decls: Declaration[],
  usages: Usage[],
): void {
  collectPartnerJob(job, order, loc, decls, usages);
  // `ownerRef` absent means the primary person (well-known), so only an explicit owner is a usage.
  if (job.ownerRef !== undefined) usages.push({ ref: job.ownerRef, order, loc });
}

/** Every ref an event declares or points at, keyed off the discriminant so a seventh kind must be added here. */
function collectEvent(
  scheduled: ScheduledEvent,
  order: number,
  decls: Declaration[],
  usages: Usage[],
): void {
  const { entry, index } = scheduled;
  const loc: Location = { describe: `event entry ${index} (${entry.type})`, eventIndex: index };
  if (entry.ref !== undefined) decls.push({ ref: entry.ref, order, loc });
  switch (entry.type) {
    case "marry":
      // A partner's jobs are created as the marry applies, so they share its order: their names
      // become addressable to later events, and their pointers resolve against the same instant.
      entry.jobs?.forEach((job, j) =>
        collectPartnerJob(job, order, { describe: `job ${j} of ${loc.describe}`, eventIndex: index }, decls, usages),
      );
      return;
    case "haveChild":
    case "haveExistingChild":
      return;
    case "startPartnered":
      // Like `marry`, a partner's jobs are created as the entry applies and share its order.
      entry.jobs?.forEach((job, j) =>
        collectPartnerJob(job, order, { describe: `job ${j} of ${loc.describe}`, eventIndex: index }, decls, usages),
      );
      return;
    case "takeLoan":
    case "carryLoan":
      usages.push({ ref: entry.ownerRef, order, loc });
      return;
    case "buyHome":
      usages.push({ ref: entry.ownerRef, order, loc });
      entry.downPaymentSourceRefs.forEach((ref) => usages.push({ ref, order, loc }));
      return;
    case "separate":
      usages.push({ ref: entry.partnerRef, order, loc });
      return;
    case "payOffDebt":
      usages.push({ ref: entry.liabilityRef, order, loc });
      usages.push({ ref: entry.accountRef, order, loc });
      return;
    default: {
      const exhaustive: never = entry;
      return exhaustive;
    }
  }
}

function error(reason: string, ref: Ref, loc: Location): ResolveRefsResult {
  return { ok: false, error: { reason, ref, eventIndex: loc.eventIndex } };
}

/**
 * Validate the ref graph and return the month-ordered event schedule. Events sort stably by
 * `month` — array position breaks ties — so forward-reference detection uses the order the applier
 * will actually apply them in, not the order they were authored.
 */
export function resolveRefs(input: ScenarioInput): ResolveRefsResult {
  const decls: Declaration[] = [];
  const usages: Usage[] = [];

  input.jobs?.forEach((job, i) =>
    collectJob(job, PLAN_ORDER, { describe: `job entry ${i}` }, decls, usages),
  );
  input.goals?.forEach((goal, i) => {
    if (goal.ref !== undefined)
      decls.push({ ref: goal.ref, order: PLAN_ORDER, loc: { describe: `goal entry ${i}` } });
  });
  input.budgetLines?.forEach((line, i) => {
    const loc: Location = { describe: `budget line entry ${i}` };
    if (line.ref !== undefined) decls.push({ ref: line.ref, order: PLAN_ORDER, loc });
    if (line.target.kind === "account")
      usages.push({ ref: line.target.accountRef, order: PLAN_ORDER, loc });
  });

  const order: ScheduledEvent[] = (input.events ?? [])
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => entryMonth(a.entry) - entryMonth(b.entry) || a.index - b.index);
  order.forEach((scheduled, position) => collectEvent(scheduled, position, decls, usages));

  // Build the name → order map, refusing the first duplicate in application order. Seeding with the
  // well-known ids makes shadowing one a duplicate too: a document cannot redefine a reserved name.
  const declaredAt = new Map<Ref, number>();
  for (const id of WELL_KNOWN_REF_IDS) declaredAt.set(ref(id), PLAN_ORDER);
  for (const d of decls) {
    if (WELL_KNOWN_REF_IDS.has(d.ref))
      return error(`${d.loc.describe} declares ref "${d.ref}", which is a reserved well-known id`, d.ref, d.loc);
    if (declaredAt.has(d.ref))
      return error(`${d.loc.describe} redeclares ref "${d.ref}"`, d.ref, d.loc);
    declaredAt.set(d.ref, d.order);
  }

  for (const u of usages) {
    const declOrder = declaredAt.get(u.ref);
    if (declOrder === undefined)
      return error(`${u.loc.describe} references unknown ref "${u.ref}"`, u.ref, u.loc);
    if (declOrder !== PLAN_ORDER && declOrder >= u.order)
      return error(`${u.loc.describe} references ref "${u.ref}" before it is declared`, u.ref, u.loc);
  }

  return { ok: true, order };
}
