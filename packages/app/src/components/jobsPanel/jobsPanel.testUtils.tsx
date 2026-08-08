/**
 * Shared setup for the `jobsPanel.*.test.tsx` suites.
 *
 * The panel's behaviour splits into several files — listing, authoring, permanent pay changes,
 * one-off adjustments, the continuation question — and every one of them renders the same
 * controlled harness: a real `useProjection`, a real `Projection`, and a probe for each plane a
 * job can live on (the primary's on the plan, a partner's on their `RelationshipEvent`).
 *
 * Deliberately thin. Builders return plain values and the query helpers are one-liners over
 * Testing Library, so a test that reads `headline("Alex's job 1")` needs nothing from this file
 * beyond that line to be understood. No custom render wrapper, no assertion helpers, no
 * per-suite configuration object.
 */
import { useMemo } from "react";
import { screen, within } from "@testing-library/react";
import {
  Projection,
  dollarsToCents,
  type Job,
  type Ledger,
  type NewLifeEvent,
  type Plan,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import type { Transact } from "../../hooks/useProjection";
import { useTestProjection } from "../../testing/projectionHarness";
import { PLAN_DEFAULTS } from "../../planDefaults";
import { START_YEAR } from "../../config";
import { primaryJobs } from "../../planPeople";
import { JobsPanel } from "./jobsPanel";

/** The default plan's single job, addressed by its engine-minted id rather than a hardcoded one. */
export const DEFAULT_JOB_ID = PLAN_DEFAULTS.primary.jobs[0]!.id;

/** A refused transaction: the facade threw, so nothing on either plane changed. */
const refuseEveryWrite: Transact = () => undefined;

/**
 * Controlled harness standing in for `App`, with a probe for each plane a job can live on: the
 * primary person's on the plan, a partner's on their `RelationshipEvent`. Writes go through a
 * real `useProjection`, so an edit spanning both planes is committed the way the app commits
 * it — one transaction, all of it or none.
 */
export function Harness({
  initial = PLAN_DEFAULTS,
  events = [],
  rejectRevisions = false,
  previewStopAge = null,
}: {
  initial?: Plan;
  events?: readonly NewLifeEvent[];
  /** Stands in for a conflict: the transaction is refused, as the facade would refuse it. */
  rejectRevisions?: boolean;
  /** Stands in for the Retirement panel's preview toggle, on at this age. */
  previewStopAge?: number | null;
}) {
  const { state, transact } = useTestProjection(initial, {
    events: events.map((e, i) => ({ ...e, sequenceNumber: i })),
    nextSequenceNumber: events.length,
  });
  const budget = state.scenario.plan;
  const ledger = state.scenario.ledger;
  const projection = useMemo(() => Projection.fromState(state, usJurisdiction), [state]);
  // ONE authored run, the way `main.tsx` does it: the household roster and the pay display the
  // chart draws are two reads off the same result. Running the simulation once per read — which
  // this harness used to do — modelled an app that does not exist, and doubled the engine work
  // behind every gesture in these suites (measured: 6.9s → 5.6s of test time across them).
  const authoredRun = useMemo(() => projection.run(usJurisdiction), [projection]);
  const household = authoredRun.household;
  // A real preview run — the resolved household a stop-working candidate produces — rather
  // than a hand-built stand-in, so these tests exercise the same engine path the app does.
  // The run the charts read: the preview when the toggle is on, the authored pass otherwise —
  // the same swap `main.tsx` makes, so these exercise the engine path the app does.
  const chartRun = useMemo(
    () =>
      previewStopAge === null
        ? authoredRun
        : projection.runAtStopWorkingAge(usJurisdiction, previewStopAge),
    [projection, authoredRun, previewStopAge],
  );

  return (
    <>
      <JobsPanel
        budget={budget}
        transact={rejectRevisions ? refuseEveryWrite : transact}
        household={household}
        ledger={ledger}
        projection={projection}
        payDisplay={chartRun.jobPayDisplay}
      />
      <output data-testid="job-count">{primaryJobs(budget).length}</output>
      <output data-testid="partner-jobs">{JSON.stringify(partnerJobsOf(ledger))}</output>
      {/* Both planes as the panel left them, so a test can project the real pair rather
          than a hand-built stand-in. */}
      <output data-testid="plan">{JSON.stringify(budget)}</output>
      <output data-testid="ledger">{JSON.stringify(ledger)}</output>
    </>
  );
}

/** The ledger plane: jobs authored on the partner's RelationshipEvent. */
function partnerJobsOf(ledger: Ledger): readonly Job[] {
  for (const e of ledger.events) if (e.type === "RelationshipEvent") return e.person.jobs;
  return [];
}

export const partnerJoining = (jobs: readonly Job[], month = 0): NewLifeEvent => ({
  id: "r1",
  type: "RelationshipEvent",
  month,
  person: {
    id: "p-1",
    name: "Sam",
    birthYear: START_YEAR - 40,
    lifeExpectancy: 85,
    benefitClaimingAge: 67,
    jobs,
  },
});

/** Open-ended, started at the partner's age 40 ("now"). */
export const partnerJob = (monthlyDollars: number, name?: string, over: Partial<Job> = {}): Job => ({
  id: "p-1-job-1",
  ...(name ? { name } : {}),
  ownerId: "p-1",
  startYear: START_YEAR,
  endYear: START_YEAR - 40 + 65,
  salary: { startingSalaryCents: dollarsToCents(monthlyDollars * 12), currentSalaryCents: dollarsToCents(monthlyDollars * 12), realGrowthPct: 0 },
  ...over,
});

export const spin = (name: RegExp | string) => screen.getByRole("spinbutton", { name }) as HTMLInputElement;
/**
 * A row's headline — CURRENT pay. Addressed by its title rather than its text: the row now also
 * charts and lists the same job's pay, so the figure legitimately appears more than once.
 */
export const headline = (label: string): string =>
  within(screen.getByLabelText(label)).getByTitle(/Current pay/).textContent ?? "";
/** The pay-history list on a row, where every dated change reads back. */
export const timeline = (label: string) => within(screen.getByLabelText(`Pay history for ${label}`));
export const jobCount = () => Number(screen.getByTestId("job-count").textContent);
export const partnerJobs = (): readonly Job[] =>
  JSON.parse(screen.getByTestId("partner-jobs").textContent || "[]") as Job[];
/** What a partner's job pays NOW — the month-0 anchor, which is what the panel's headline
 * quotes and what the salary field on a job with a past authors. */
export const partnerMonthlyDollars = (i = 0): number =>
  Math.round((partnerJobs()[i]?.salary.currentSalaryCents ?? 0) / 12 / 100);
/** Both planes as the panel left them — what the app itself would project. */
export const authored = (): { plan: Plan; ledger: Ledger } => ({
  plan: JSON.parse(screen.getByTestId("plan").textContent || "{}") as Plan,
  ledger: JSON.parse(screen.getByTestId("ledger").textContent || "{}") as Ledger,
});
