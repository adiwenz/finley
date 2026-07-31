/**
 * The transactions that change who is in the household: a partner arrives, a child arrives, a
 * partner leaves. Each mints the durable entity it creates and appends one event through the
 * gated ledger path.
 */

import type { Job } from "../job";
import type { PersonId } from "../job";
import type { Jurisdiction } from "../jurisdiction";
import type { Person } from "../person";
import type { ProjectionState, Written } from "./state";
import { mint } from "./mint";
import { appendEvent } from "./eventWrite";
import type { JobInput } from "./jobs";

/**
 * The incoming partner. `birthYear` is REQUIRED: it makes a benefit basis and the age-50
 * catch-up computable. `retirementTargetAge` defaults to 65, `benefitClaimingAge` to 67.
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
  readonly retirementTargetAge?: number;
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
  const { id, nextSeq: afterPerson } = mint(state, "person");
  // One counter, threaded person → jobs: each job mints against the seq the previous mint left,
  // so the partner and their jobs draw distinct ids from the same monotonic run. The owner is
  // `id` — the person minted just above — because a partner's jobs belong to the person this
  // call creates, never to the caller.
  let nextSeq = afterPerson;
  const jobs: Job[] = (input.jobs ?? []).map((job) => {
    const minted = mint({ ...state, nextSeq }, "job");
    nextSeq = minted.nextSeq;
    return { ...job, id: minted.id, ownerId: id };
  });
  const person: Person = {
    id,
    name: input.name,
    birthYear: input.birthYear,
    retirementTargetAge: input.retirementTargetAge ?? 65,
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
