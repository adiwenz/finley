/**
 * The fixtures every `retirementSolver.*.test.ts` suite builds its scenarios from.
 *
 * They live here because the solver's behaviour splits into several files — baseline search,
 * truncation, continuation, disclosure, membership, immutability — and every one of them needs
 * the same household to reason about: `samplePlan`'s primary, their clock, and a partner arriving
 * on a `RelationshipEvent`. Duplicating that setup per file is how two suites end up quietly
 * disagreeing about how old the primary is.
 *
 * Deliberately shallow: plain builders returning plain values, no shared mutable state and no
 * assertion helpers. A test that reads `job("career", 35, 65)` should need nothing from this file
 * beyond that one line to be understood.
 */
import { addEvent } from "../ledger/addEvent";
import { emptyLedger } from "../ledger/ledger";
import { dollarsToCents } from "../money/cashFlowSeries";
import { createProjectionBase } from "../compile/projectionBase";
import { mockJurisdiction } from "../testing/mockJurisdiction";
import { scenarioOf, withLedger } from "../plan/scenario";
import { samplePlan, baristaPlan, SAMPLE_START_YEAR } from "../testing/samplePlan";
import type { ProjectionContext } from "../compile/projectionBase";
import type { Plan } from "../plan/plan";
import type { Person } from "../plan/person";
import type { Job, JobId, PersonId } from "../job/job";
import type { Scenario } from "../plan/scenario";
import type { ProjectionSeries } from "../projection/simulate";

export const START_YEAR = SAMPLE_START_YEAR;
export const CTX: ProjectionContext = { jurisdiction: mockJurisdiction(), startYear: START_YEAR };

/** `samplePlan.primary`'s current age, derived from its frozen `birthYear` — `Plan.currentAge` no longer exists. */
export const CURRENT_AGE = SAMPLE_START_YEAR - samplePlan.primary.birthYear;
/** `baristaPlan.primary`'s current age, derived the same way. */
export const BARISTA_CURRENT_AGE = SAMPLE_START_YEAR - baristaPlan.primary.birthYear;
/** Primary's birth year in every solver suite: `SAMPLE_START_YEAR − CURRENT_AGE`. */
export const PRIMARY_BIRTH_YEAR = START_YEAR - CURRENT_AGE;
/** The same year under the name the continuation suites read it by. */
export const BIRTH_YEAR = PRIMARY_BIRTH_YEAR;

/** The calendar year the primary turns `age`. */
export const at = (age: number): number => PRIMARY_BIRTH_YEAR + age;
/** Months from "now" to the primary's `age`. */
export const monthAt = (age: number): number => (age - CURRENT_AGE) * 12;

/**
 * What a partner fixture may vary. An explicit list, NOT `Partial<Person>`: a partial of a type
 * whose fields are required says every one of them may be absent, which is the opposite of what
 * `Person` means — and it silently re-admits `undefined` for `lifeExpectancy`, the field the
 * horizon is computed from, so a builder spreading it had to patch the value back afterwards.
 * Naming the four things these fixtures actually change makes the builders total by construction.
 */
export interface PartnerOverrides {
  readonly id?: PersonId;
  readonly birthYear?: number;
  /** Theirs, never the primary's — the engine requires one and infers nothing. */
  readonly lifeExpectancy?: number;
  readonly continuationJobId?: JobId | null;
}

/** A primary-owned job spanning the primary's `startAge`–`endAge`, flat-salaried unless varied. */
export function job(id: string, startAge: number, endAge: number, annualDollars = 90_000): Job {
  return {
    id,
    ownerId: "p1",
    startYear: at(startAge),
    endYear: at(endAge),
    salary: {
      startingSalaryCents: dollarsToCents(annualDollars),
      currentSalaryCents: dollarsToCents(annualDollars),
      realGrowthPct: 0,
    },
  };
}

/**
 * A plan holding `jobs`, with the primary's selection stated. Omitting `continuationJobId`
 * leaves it UNSTATED — the "nobody has chosen yet" case the initialization rule answers — which
 * is a different plan from one stating `null`, so the two are never spelled the same way here.
 */
export const planWithJobs = (jobs: readonly Job[], continuationJobId?: string | null): Plan => ({
  ...samplePlan,
  primary: {
    ...samplePlan.primary,
    jobs,
    ...(continuationJobId !== undefined ? { continuationJobId } : {}),
  },
});

/** What `job:<id>` paid the household in `month`, or 0 when it paid nothing at all. */
export function wageAt(series: ProjectionSeries, id: string, month: number): number {
  const source = (series.months[month]?.flows?.incomeSources ?? []).find(
    (s) => s.sourceId === `job:${id}`,
  );
  return source?.cashInflowCents ?? 0;
}

/** Every cent of household income in `month`, whatever paid it. */
export const incomeAt = (series: ProjectionSeries, month: number): number =>
  series.months[month]?.flows?.totalIncomeCents ?? 0;

/**
 * A career and the token job that follows it, read against `baristaPlan`'s OWN clock — the cases
 * that turn on a SOLVED age use that fixture's tighter budget, and its current age differs from
 * `samplePlan`'s.
 */
export const baristaJobs: readonly Job[] = (() => {
  const birthYear = START_YEAR - BARISTA_CURRENT_AGE;
  const atBarista = (age: number) => birthYear + age;
  const shift = (j: Job, startAge: number, endAge: number): Job => ({
    ...j,
    startYear: atBarista(startAge),
    endYear: atBarista(endAge),
  });
  return [
    shift(job("career", 35, 65, 90_000), 35, 65),
    shift(job("token", 65, 70, 12_000), 65, 70),
  ];
})();

/** A partner-owned job. Long-running unless a test says otherwise. */
export function partnerJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "pj1",
    ownerId: "p2",
    startYear: START_YEAR,
    endYear: SAMPLE_START_YEAR + 40,
    salary: {
      startingSalaryCents: dollarsToCents(24_000),
      currentSalaryCents: dollarsToCents(24_000),
      realGrowthPct: 0,
    },
    ...overrides,
  };
}

/** A partner born the same year as the primary, holding `jobs`. */
export function partnerWith(overrides: PartnerOverrides & { jobs: readonly Job[] }): Person {
  return {
    id: "p2",
    name: "Partner",
    birthYear: PRIMARY_BIRTH_YEAR,
    lifeExpectancy: samplePlan.primary.lifeExpectancy,
    benefitClaimingAge: 67,
    ...overrides,
  };
}

/**
 * A partner holding a job authored to run far past any plausible stop age, so their wage can only
 * stop because a boundary stopped it.
 */
export const partnerWithLateJob = (): Person =>
  partnerWith({ jobs: [partnerJob({ endYear: PRIMARY_BIRTH_YEAR + 80 })] });

/** `samplePlan` with `partner` married in at month 0 — a partner's jobs live on the event, not the plan. */
export function twoEarnerScenario(partner: Person = partnerWithLateJob()): Scenario {
  const added = addEvent(emptyLedger, createProjectionBase(samplePlan, CTX), {
    id: "r1",
    type: "RelationshipEvent",
    month: 0,
    person: partner,
  });
  if (!added.ok) throw new Error(`fixture rejected: ${added.conflict}`);
  return withLedger(scenarioOf(samplePlan), added.ledger);
}

/** The partner's own job-income source for one projected month, or undefined if absent. */
export function partnerSource(series: ProjectionSeries, month: number) {
  return series.months[month]?.flows?.incomeSources.find((s) => s.sourceId === "job:pj1");
}
