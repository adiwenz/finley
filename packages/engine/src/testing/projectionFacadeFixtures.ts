/**
 * Fixtures shared by the split `projectionFacade.*.test.ts` files. Kept in one place so the seven
 * capability files don't each re-declare a fresh projection, a plain job, an expense line, and a
 * goal — the shapes several of them build on.
 */
import { Projection } from "../index";
import { samplePlan, stateOf, SAMPLE_START_YEAR } from "./samplePlan";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import { dollarsToCents } from "../money/cashFlowSeries";
import type { PersonId } from "../job/job";

export const P1 = "p1" as PersonId;

export function freshProjection(): Projection {
  // Empty job and budget-line lists so minted ids and roster lengths reflect only what each
  // test adds — the sample plan seeds a spend line that would otherwise skew the counts.
  return Projection.fromState(stateOf({ ...samplePlan, jobs: [], budgetLines: [] }), nullJurisdiction);
}

/**
 * A plain job for the authoring tests. It states an end like every job does — the fixture's
 * primary is 40 and the sample plan retires at 60, so 20 years out is the span these tests
 * used to get implicitly from a `null` end.
 */
export const JOB_END_YEAR = SAMPLE_START_YEAR + 20;

export const plainJob = {
  startYear: SAMPLE_START_YEAR,
  endYear: JOB_END_YEAR,
  salary: { startingSalaryCents: dollarsToCents(100000), currentSalaryCents: dollarsToCents(100000), realGrowthPct: 0 },
} as const;

/** The partner a single `marry()` authored, whose jobs live on the event, not the plan. */
export function partnerEvent(p: Projection) {
  const event = p.state.scenario.ledger.events[0];
  if (event?.type !== "RelationshipEvent") throw new Error("expected a RelationshipEvent");
  return event;
}

export const expenseLine = {
  label: "Rent",
  target: { kind: "expense" } as const,
  amountSource: { kind: "literal" as const, monthlyCents: dollarsToCents(2000) },
  category: "needs" as const,
};

/**
 * A goal, for the counter tests. `GoalInput` still takes an optional `id` — jobs and budget
 * lines do not — so a goal is what an "authored id claims the counter" case is written against.
 */
export const carGoalInput = {
  name: "Car",
  targetCents: dollarsToCents(30000),
  targetDate: 36,
  disposition: "retain" as const,
  annualReturnPct: 3,
};
