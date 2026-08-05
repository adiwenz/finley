/**
 * The transactions that change who is in the household: a partner arrives, a child arrives, a
 * partner leaves. Each mints the durable entity it creates and appends one event through the
 * gated ledger path.
 */

import type { Job } from "../job/job";
import { AGE_LIMITS, MAX_LIVED_AGE } from "../plan/plan";
import type { PersonId } from "../job/job";
import type { Jurisdiction } from "../jurisdiction/jurisdiction";
import type { Person } from "../plan/person";
import type { ProjectionState, Written } from "./state";
import { mint } from "./mint";
import { appendEvent } from "./eventWrite";
import { resolveJobInput, type JobInput } from "./jobs";

/**
 * The incoming partner. `birthYear` is REQUIRED: it makes a benefit basis and the age-50
 * catch-up computable. `benefitClaimingAge` defaults to 67. A partner states no retirement
 * age of their own: every job they hold says when it ends, so there is nothing left for one
 * to decide.
 * Covered earnings derive from `jobs`, so the empty default models no benefit basis.
 *
 * Jobs arrive as {@link JobInput}, not `Job`: the engine is the sole id authority, and for a
 * partner the owner is the person this very call creates — a caller could not name either id
 * before the marriage minted the person.
 */
export interface MarryInput {
  readonly month: number;
  readonly name: string;
  readonly birthYear: number;
  readonly benefitClaimingAge?: number;
  readonly jobs?: readonly JobInput[];
}

/**
 * A partner already present at simulation start — an anchor, keyed on how long the household has
 * been together. The partnering is placed at its true past month (`-partneredForMonths`), which
 * is what lets a separation be dated before "now" and, later, a life axis render the relationship.
 * The partner's income still compiles from month 0 (the membership window clips it), so only the
 * partnering's position — not a reconstructed past — drives the forward projection.
 *
 * Same shape as {@link MarryInput} but for `month`: a marriage happens AT a plan month the caller
 * picks, an existing partnering is measured BACKWARD from now, so the two never share a field.
 */
export interface StartPartneredInput {
  /** Months the household has been together; a positive integer, so the anchor lands before "now". */
  readonly partneredForMonths: number;
  readonly name: string;
  readonly birthYear: number;
  readonly benefitClaimingAge?: number;
  readonly jobs?: readonly JobInput[];
}

/**
 * A child joins the household. `birthMonth` defaults to `month` — recording a birth as it
 * happens; they differ only when a pre-existing child is entered after the fact (a birth month
 * at or below 0). A positive `annualCostCents` spawns the linked 18-year cost stream; 0 records
 * the child with no financial effect.
 */
export interface HaveChildInput {
  readonly month: number;
  readonly name: string;
  readonly annualCostCents: number;
  readonly birthMonth?: number;
}

/**
 * A child who was ALREADY born — an anchor, keyed on the child's age. The birth is placed at its
 * true past month (`-ageMonths`), which is exactly what clips the 18-year cost stream to the
 * years of childhood that remain. `annualCostCents` is today's cost of a full year, unchanged by
 * how much of childhood is already spent; the clip, not a smaller figure, yields the remainder.
 */
export interface HaveExistingChildInput {
  readonly name: string;
  /** Months since birth; a positive integer, so the birth anchor lands strictly before "now". */
  readonly ageMonths: number;
  readonly annualCostCents: number;
}

/**
 * A partner leaves the household. Every money field defaults to 0 — the no-support separation is
 * the plain case, not an omission — and alimony runs from `month`.
 */
export interface SeparateInput {
  readonly month: number;
  /** The partner the marriage returned. */
  readonly partnerPersonId: PersonId;
  readonly alimonyMonthlyCents?: number;
  readonly alimonyDurationMonths?: number;
  readonly childSupportMonthlyCents?: number;
}

/** Answers with the minted `"person-N"` id. */
export function applyMarriage(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  input: MarryInput,
): Written<string> {
  // A partner is a person, and the same age bound holds for them as for the primary — stated
  // here in the three places a partner's age is actually authored. Their age is a birth YEAR on
  // the way in, so it is read against the plan's frozen "now" rather than a wall clock.
  const ages: readonly (readonly [string, number | undefined, number])[] = [
    // An age they already ARE, so it stops one short of the ceiling like the primary's.
    ["age", state.startYear - input.birthYear, MAX_LIVED_AGE],
    ["benefitClaimingAge", input.benefitClaimingAge, AGE_LIMITS.benefitClaimingAge],
  ];
  for (const [field, age, limit] of ages) {
    if (age !== undefined && age > limit) {
      throw new Error(`Projection: cannot author a partner with ${field} ${age} — it may not exceed ${limit}`);
    }
  }
  const { id, nextSeq: afterPerson } = mint(state, "person");
  // One counter, threaded person → jobs: each job mints against the seq the previous mint left,
  // so the partner and their jobs draw distinct ids from the same monotonic run. The owner is
  // `id` — the person minted just above — because a partner's jobs belong to the person this
  // call creates, never to the caller.
  let nextSeq = afterPerson;
  const jobs: Job[] = (input.jobs ?? []).map((job) => {
    const minted = mint({ ...state, nextSeq }, "job");
    nextSeq = minted.nextSeq;
    return resolveJobInput(job, minted.id, id);
  });
  const person: Person = {
    id,
    name: input.name,
    birthYear: input.birthYear,
    benefitClaimingAge: input.benefitClaimingAge ?? 67,
    jobs,
  };
  return {
    state: appendEvent(
      state,
      jurisdiction,
      { id, type: "RelationshipEvent", month: input.month, person },
      nextSeq,
    ),
    result: id,
  };
}

/**
 * Author a partner already present at start. Reuses {@link applyMarriage} — a partnering IS a
 * `RelationshipEvent`, only dated at its true past month — so it shares the person-and-jobs
 * minting and answers with the same minted `"person-N"` id.
 */
export function applyStartPartnered(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  input: StartPartneredInput,
): Written<string> {
  if (!Number.isInteger(input.partneredForMonths) || input.partneredForMonths <= 0) {
    throw new Error(
      `Projection: partneredForMonths must be a positive integer (got ${input.partneredForMonths})`,
    );
  }
  const { partneredForMonths, ...rest } = input;
  return applyMarriage(state, jurisdiction, { ...rest, month: -partneredForMonths });
}

/**
 * Answers with the minted `"child-N"` id, which is both the event's id and the durable child's —
 * one id, so the cost stream this spawns and the child it belongs to are addressed the same way,
 * exactly as a home purchase does for a property.
 */
export function applyChild(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  input: HaveChildInput,
): Written<string> {
  const { id, nextSeq } = mint(state, "child");
  return {
    state: appendEvent(
      state,
      jurisdiction,
      {
        id,
        type: "ChildEvent",
        month: input.month,
        childId: id,
        childName: input.name,
        birthMonth: input.birthMonth ?? input.month,
        annualCostCents: input.annualCostCents,
      },
      nextSeq,
    ),
    result: id,
  };
}

/**
 * Record an already-born child as an anchor at its birth month. Reuses {@link applyChild}: both
 * the event and the birth are dated `-ageMonths`, so the child is a past life event whose cost
 * stream the engine clips to the remaining months exactly as it does a birth authored forward.
 * Answers with the minted `"child-N"` id.
 */
export function applyHaveExistingChild(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  input: HaveExistingChildInput,
): Written<string> {
  if (!Number.isInteger(input.ageMonths) || input.ageMonths <= 0) {
    throw new Error(
      `Projection: an existing child's ageMonths must be a positive integer (got ${input.ageMonths})`,
    );
  }
  const birthMonth = -input.ageMonths;
  return applyChild(state, jurisdiction, {
    month: birthMonth,
    name: input.name,
    annualCostCents: input.annualCostCents,
    birthMonth,
  });
}

/**
 * The counterpart to {@link applyMarriage}: ends the departing partner's income and opens
 * whatever support streams the split carries. REFUSED when the person was never partnered, has
 * already separated, or the month precedes the partnering — all preconditions the append surfaces
 * as a thrown conflict.
 *
 * Answers with the minted `"separation-N"` id — its own, not the partner's, since a separation is
 * an event about a person rather than a durable entity of its own.
 */
export function applySeparation(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  input: SeparateInput,
): Written<string> {
  const { id, nextSeq } = mint(state, "separation");
  return {
    state: appendEvent(
      state,
      jurisdiction,
      {
        id,
        type: "SeparationEvent",
        month: input.month,
        partnerPersonId: input.partnerPersonId,
        alimonyMonthlyCents: input.alimonyMonthlyCents ?? 0,
        alimonyDurationMonths: input.alimonyDurationMonths ?? 0,
        childSupportMonthlyCents: input.childSupportMonthlyCents ?? 0,
      },
      nextSeq,
    ),
    result: id,
  };
}
