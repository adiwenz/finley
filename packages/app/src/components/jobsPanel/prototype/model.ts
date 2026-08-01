/**
 * PROTOTYPE — throwaway. Delete this whole `prototype/` directory once the question is
 * answered (see NOTES.md next door).
 *
 * The question: what UI lets a user author a job's pay HISTORY — a start salary that
 * differs from current pay, plus raises before "now" — when the engine dates those with a
 * negative `JobPayChange.month`?
 *
 * This is a standalone in-memory stand-in for the job model. It does NOT import the engine:
 * the point is to feel out the authoring surface, not to be correct. Real growth
 * (`realGrowthPct`) and inflation are ignored throughout — a pay change is the only thing
 * that moves the number here.
 */

export interface ProtoPayChange {
  /** Simulation month relative to "now". NEGATIVE = history. */
  readonly month: number;
  readonly kind: "setTo" | "changeBy";
  /** Monthly dollars. Negative `changeBy` is a cut. */
  readonly dollars: number;
}

export interface ProtoJob {
  readonly name: string;
  /** The owner's age today — month 0. */
  readonly currentAge: number;
  readonly startAge: number;
  readonly endAge: number | null;
  /**
   * The two anchors the engine keeps, in monthly dollars. Neither derives from the other:
   * `starting` feeds the historical reconstruction only, `current` is authoritative from
   * month 0 forward.
   */
  readonly startingMonthlyDollars: number;
  readonly currentMonthlyDollars: number;
  readonly payChanges: readonly ProtoPayChange[];
}

/** Age → simulation month. Whole years, so history lands on multiples of 12. */
export const monthOfAge = (job: ProtoJob, age: number): number => (age - job.currentAge) * 12;

/** Simulation month → the owner's age. */
export const ageOfMonth = (job: ProtoJob, month: number): number =>
  job.currentAge + Math.floor(month / 12);

const applyChange = (pay: number, change: ProtoPayChange): number =>
  change.kind === "setTo" ? change.dollars : pay + change.dollars;

export const sortedChanges = (job: ProtoJob): readonly ProtoPayChange[] =>
  [...job.payChanges].sort((a, b) => a.month - b.month);

/**
 * What the reconstructed history reaches by the month before now — the left-hand side of the
 * month-0 seam. Starts at the START anchor and applies every negative-month change in order.
 */
export function historyReachesDollars(job: ProtoJob): number {
  let pay = job.startingMonthlyDollars;
  for (const change of sortedChanges(job)) {
    if (change.month < 0) pay = applyChange(pay, change);
  }
  return pay;
}

/**
 * The authored step at month 0, in dollars. The engine deliberately does NOT reconcile this
 * (handoff-83: "the authored current salary already reflects historical raises"), so the UI's
 * job is to make it legible rather than to close it. 0 = history lands exactly on current pay.
 */
export const monthZeroStepDollars = (job: ProtoJob): number =>
  job.currentMonthlyDollars - historyReachesDollars(job);

/** One row per event, in age order, with the pay in force after it. Includes the "now" seam. */
export interface PayRow {
  readonly key: string;
  readonly age: number;
  readonly month: number;
  readonly kind: "start" | "history" | "now" | "future";
  readonly label: string;
  readonly payDollars: number;
  readonly change?: ProtoPayChange;
}

/** The whole pay story as a single age-ordered list — what variants A and C render. */
export function payTimeline(job: ProtoJob): readonly PayRow[] {
  const rows: PayRow[] = [];
  const changes = sortedChanges(job);

  let pay = job.startingMonthlyDollars;
  rows.push({
    key: "start",
    age: job.startAge,
    month: monthOfAge(job, job.startAge),
    kind: "start",
    label: "Started this job",
    payDollars: pay,
  });

  for (const change of changes) {
    if (change.month >= 0) continue;
    pay = applyChange(pay, change);
    rows.push({
      key: `h${change.month}`,
      age: ageOfMonth(job, change.month),
      month: change.month,
      kind: "history",
      label: describeChange(change),
      payDollars: pay,
      change,
    });
  }

  // The seam. Pay jumps to the current anchor here regardless of where history landed.
  pay = job.currentMonthlyDollars;
  rows.push({
    key: "now",
    age: job.currentAge,
    month: 0,
    kind: "now",
    label: "Now",
    payDollars: pay,
  });

  for (const change of changes) {
    if (change.month < 0) continue;
    pay = applyChange(pay, change);
    rows.push({
      key: `f${change.month}`,
      age: ageOfMonth(job, change.month),
      month: change.month,
      kind: "future",
      label: describeChange(change),
      payDollars: pay,
      change,
    });
  }

  return rows;
}

export function describeChange(change: ProtoPayChange): string {
  if (change.kind === "setTo") return `Pay set to ${money(change.dollars)}/mo`;
  return change.dollars < 0
    ? `Pay cut ${money(Math.abs(change.dollars))}/mo`
    : `Pay raised ${money(change.dollars)}/mo`;
}

export const money = (dollars: number): string =>
  `$${Math.round(dollars).toLocaleString("en-US")}`;

/** What this job paid per month at a given age. 0 outside the job's span. */
export function monthlyPayAtAge(job: ProtoJob, age: number): number {
  if (age < job.startAge) return 0;
  // An open-ended job runs to retirement, not forever — same rule the real panel states.
  if (age >= (job.endAge ?? RETIREMENT_AGE)) return 0;
  const month = monthOfAge(job, age);
  const changes = sortedChanges(job);
  if (month < 0) {
    let pay = job.startingMonthlyDollars;
    for (const c of changes) if (c.month < 0 && c.month <= month) pay = applyChange(pay, c);
    return pay;
  }
  let pay = job.currentMonthlyDollars;
  for (const c of changes) if (c.month >= 0 && c.month <= month) pay = applyChange(pay, c);
  return pay;
}

/** Household earned income for one age-year, across every job. */
export const householdIncomeAtAge = (jobs: readonly ProtoJob[], age: number): number =>
  jobs.reduce((sum, job) => sum + monthlyPayAtAge(job, age) * 12, 0);

export const RETIREMENT_AGE = 67;
export const LIFE_EXPECTANCY = 85;

/**
 * The scenario the spec centred on and the front end can't currently reach: $60k start,
 * a historical raise to $75k, $80k now. Held in monthly dollars.
 */
export const SEED_JOB: ProtoJob = {
  name: "Software Engineer",
  currentAge: 41,
  startAge: 30,
  endAge: null,
  startingMonthlyDollars: 5000, // $60k
  currentMonthlyDollars: 6667, // $80k
  payChanges: [
    { month: -12 * 5, kind: "setTo", dollars: 6250 }, // $75k at age 36
    { month: 12 * 6, kind: "setTo", dollars: 7500 }, // $90k at age 47
  ],
};

/**
 * A job that ENDED before now — the case variant D's lifetime view exists to show, and one
 * today's Jobs panel can hold but never really displays as past.
 */
export const SEED_PAST_JOB: ProtoJob = {
  name: "Barista",
  currentAge: 41,
  startAge: 22,
  endAge: 26,
  startingMonthlyDollars: 1800,
  currentMonthlyDollars: 1800,
  payChanges: [{ month: 12 * (24 - 41), kind: "setTo", dollars: 2100 }], // $2.1k at age 24
};

export const SEED_JOBS: readonly ProtoJob[] = [SEED_JOB, SEED_PAST_JOB];

/** Add or replace a change at a month (the engine keeps at most one per job per month). */
export function withChange(job: ProtoJob, change: ProtoPayChange): ProtoJob {
  return {
    ...job,
    payChanges: [...job.payChanges.filter((c) => c.month !== change.month), change],
  };
}

export function withoutChange(job: ProtoJob, month: number): ProtoJob {
  return { ...job, payChanges: job.payChanges.filter((c) => c.month !== month) };
}
