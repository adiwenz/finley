/**
 * Starter simulations a session can load (issue #119).
 *
 * A fresh plan opens on the healthy {@link PLAN_DEFAULTS} ("Alex"), but that single
 * on-track saver is a thin slice of the lives the model is meant to illuminate. This
 * module adds three more starting points drawn straight from the issue — living
 * paycheck to paycheck, living on a credit card, and carrying a student loan into
 * negative net worth — so the app opens onto a *choice* of situations rather than one
 * comfortable default. Each preset is authored as a full {@link Scenario}: the standing
 * {@link Plan} plus the timeline {@link NewLifeEvent}s it needs (the student loan is a
 * real amortizing liability at "now", not a negative cash balance), so what the user
 * loads is exactly what the engine projects.
 *
 * The numbers are tuned against the live engine (see `presets.test.ts`) so each
 * scenario projects to its intended *shape*: the paycheck-to-paycheck plan barely
 * accumulates and can't fund retirement, the credit-card plan overspends into a
 * compounding synthetic-card liability, and the student-loan plan opens underwater and
 * then digs out. Health lines are trimmed below the default's so the working-years
 * trajectory reflects the income/expense gap the scenario is about, not an outsized
 * medical line.
 */

import {
  dollarsToCents,
  emptyLedger,
  addEvent,
  PRIMARY_PERSON_ID,
  type Plan,
  type Job,
  type Ledger,
  type LedgerBaseConfig,
  type NewLifeEvent,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { START_YEAR } from "./config";
import { PLAN_DEFAULTS } from "./planDefaults";

/**
 * A named starting point the user can load: the standing {@link Plan} paired with the
 * timeline {@link NewLifeEvent}s that complete the picture (empty for the plan-only
 * scenarios). Kept as authored events rather than a pre-built {@link Ledger} so each is
 * replayed through the same validation the UI uses — a preset can never smuggle in an
 * event the engine would reject from the event form.
 */
export interface Preset {
  /** Stable machine key (used by the picker and by {@link presetById}). */
  readonly id: string;
  /** Human-facing name shown in the picker. */
  readonly label: string;
  /** One-line description of the situation this scenario models. */
  readonly description: string;
  /** The standing numbers. */
  readonly plan: Plan;
  /** Timeline events replayed on top of the plan at load (§6). */
  readonly events: readonly NewLifeEvent[];
}

const DEFAULT_CURRENT_AGE = 35;
const DEFAULT_WORK_START_AGE = 18;

/** A single open-ended, real-flat salaried job — the same shape a fresh plan opens with. */
function salariedJob(monthlyCents: number): Job {
  return {
    id: "job-1",
    ownerId: PRIMARY_PERSON_ID,
    startYear: START_YEAR - DEFAULT_CURRENT_AGE + DEFAULT_WORK_START_AGE,
    endYear: null,
    salary: { startingSalaryCents: monthlyCents * 12, realGrowthPct: 0 },
  };
}

/**
 * Shared knobs for the three teaching scenarios: they drive spending through the scalar
 * {@link Plan.expenseCents} series (an empty `budgetLines` yields to it) so the
 * income/expense gap is the single, legible lever, and trim the health lines below the
 * default's ~$700 so that gap — not an outsized medical line — sets the trajectory.
 */
function teachingPlan(over: Partial<Plan>): Plan {
  return {
    ...PLAN_DEFAULTS,
    budgetLines: [],
    goals: [],
    healthMonthlyCents: dollarsToCents(450),
    postCoverageHealthMonthlyCents: dollarsToCents(350),
    ...over,
  };
}

/**
 * Living paycheck to paycheck: a modest salary spent almost entirely each month. Net
 * worth clings to a thin buffer through the working years — never the wealth the
 * default saver builds — and, with no cushion, retirement is unfundable.
 */
const PAYCHECK_TO_PAYCHECK: Plan = teachingPlan({
  name: "Sam",
  jobs: [salariedJob(dollarsToCents(4500))],
  expenseCents: dollarsToCents(3600),
  openingBalanceCents: dollarsToCents(1500),
});

/**
 * Living on a credit card: expenses outrun income from month 0, so the §5.1 shortfall
 * cascade routes the monthly gap onto a synthetic credit-card liability that compounds
 * at ~22% and drags net worth negative within the first year.
 */
const LIVING_ON_CREDIT: Plan = teachingPlan({
  name: "Jordan",
  jobs: [salariedJob(dollarsToCents(3800))],
  expenseCents: dollarsToCents(3600),
  openingBalanceCents: dollarsToCents(1000),
});

/**
 * Student loan, negative net worth: a new graduate on a solid salary but carrying a
 * $45k student loan, so net worth opens underwater (assets − the loan, §3). The income
 * services the loan and then some, so the line climbs back above zero within a decade —
 * the "negative but improving" case §5.1 says the model must show.
 */
const STUDENT_LOAN: Plan = teachingPlan({
  name: "Riley",
  jobs: [salariedJob(dollarsToCents(6000))],
  expenseCents: dollarsToCents(3000),
  openingBalanceCents: dollarsToCents(4000),
});

/** The $45k amortizing student loan {@link STUDENT_LOAN} opens with, taken at "now". */
const STUDENT_LOAN_EVENT: NewLifeEvent = {
  id: "e0",
  type: "LoanEvent",
  month: 0,
  liabilityId: "loan-student",
  ownerId: PRIMARY_PERSON_ID,
  openingBalanceCents: dollarsToCents(45000),
  apr: 0.06,
  kind: "studentLoan",
  termMonths: 12 * 10,
};

/**
 * The loadable starter simulations, in picker order. The first is the healthy default a
 * fresh plan already opens with; the rest are the issue's three teaching scenarios.
 */
export const PRESETS: readonly Preset[] = [
  {
    id: "default",
    label: "On track",
    description: "A steady saver building toward retirement — the healthy baseline.",
    plan: PLAN_DEFAULTS,
    events: [],
  },
  {
    id: "paycheck-to-paycheck",
    label: "Paycheck to paycheck",
    description: "Income barely covers the bills, so almost nothing is saved.",
    plan: PAYCHECK_TO_PAYCHECK,
    events: [],
  },
  {
    id: "living-on-credit",
    label: "Living on a credit card",
    description: "Spending outruns income, piling up compounding credit-card debt.",
    plan: LIVING_ON_CREDIT,
    events: [],
  },
  {
    id: "student-loan",
    label: "Student loan",
    description: "A new graduate underwater on a student loan, digging back to zero.",
    plan: STUDENT_LOAN,
    events: [STUDENT_LOAN_EVENT],
  },
];

/** The preset with this id, or the default when the id is unknown. */
export function presetById(id: string): Preset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
}

/**
 * Replay a preset's seed events into a ledger against its projection `base` — the same
 * base-aware {@link addEvent} path the live UI uses, so a preset's events are validated
 * exactly as a hand-added one would be. A rejected seed event is a bug in the preset,
 * not a user error, so it throws rather than silently dropping the event.
 */
export function buildPresetLedger(
  base: LedgerBaseConfig,
  events: readonly NewLifeEvent[],
): Ledger {
  let ledger = emptyLedger;
  for (const event of events) {
    const result = addEvent(ledger, base, event, usJurisdiction);
    if (!result.ok) {
      throw new Error(`Preset seed event "${event.id}" was rejected: ${result.conflict}`);
    }
    ledger = result.ledger;
  }
  return ledger;
}
