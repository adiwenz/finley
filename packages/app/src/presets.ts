/**
 * Starter simulations, beyond the healthy {@link PLAN_DEFAULTS} ("Alex") a fresh plan opens on.
 * Each is a full {@link Scenario} — plan plus events — so what the user loads is what the engine
 * projects. The numbers are tuned against the live engine (`presets.test.ts`) to project to
 * their intended shape.
 */

import {
  dollarsToCents,
  emptyLedger,
  addEvent,
  PRIMARY_PERSON_ID,
  RETIREMENT_ID,
  type Plan,
  type Job,
  type BudgetLine,
  type Ledger,
  type LedgerBaseConfig,
  type NewLifeEvent,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { START_YEAR } from "./config";
import { PLAN_DEFAULTS } from "./planDefaults";

/**
 * A named starting point. Authored events rather than a pre-built {@link Ledger}, so each
 * replays through the UI's own validation — a preset can never smuggle in an event the event
 * form would reject.
 */
export interface Preset {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly plan: Plan;
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

/** A flat monthly expense line. A preset's spend is authored as these and nothing else. */
function expenseLine(
  id: string,
  label: string,
  category: BudgetLine["category"],
  monthlyDollars: number,
): BudgetLine {
  return {
    id,
    label,
    target: { kind: "expense" },
    amountSource: { kind: "literal", monthlyCents: dollarsToCents(monthlyDollars) },
    category,
  };
}

/**
 * Each teaching budget is written out line by line rather than scaled from a total: the lines
 * ARE the scenario's spend, so what the engine charges is what the Base + Adjustments editor
 * shows. A budget's SUM is the tuned number — retuning a line without retuning its siblings
 * moves the scenario's trajectory, so `presets.test.ts` pins each total independently.
 */

/** $3,600/mo. Sam and Jordan run the same household on different paychecks — that IS the pair. */
const MODEST_BUDGET: readonly BudgetLine[] = [
  expenseLine("housing", "Housing", "needs", 1_650),
  expenseLine("groceries", "Groceries", "needs", 720),
  expenseLine("transport", "Transportation", "needs", 460),
  expenseLine("dining", "Dining & fun", "wants", 570),
  expenseLine("subscriptions", "Subscriptions", "wants", 200),
];

/** $3,000/mo — a new graduate living below a solid salary to dig out from under a loan. */
const LEAN_BUDGET: readonly BudgetLine[] = [
  expenseLine("housing", "Housing", "needs", 1_400),
  expenseLine("groceries", "Groceries", "needs", 600),
  expenseLine("transport", "Transportation", "needs", 400),
  expenseLine("dining", "Dining & fun", "wants", 450),
  expenseLine("subscriptions", "Subscriptions", "wants", 150),
];

/** $5,500/mo — high enough that cash never piles up, forcing the 401(k) to fund retirement. */
const COMFORTABLE_BUDGET: readonly BudgetLine[] = [
  expenseLine("housing", "Housing", "needs", 2_500),
  expenseLine("groceries", "Groceries", "needs", 950),
  expenseLine("transport", "Transportation", "needs", 650),
  expenseLine("dining", "Dining & fun", "wants", 1_000),
  expenseLine("subscriptions", "Subscriptions", "wants", 400),
];

/**
 * Each teaching scenario is one legible income/expense gap, with health trimmed below the
 * default's ~$700 so that gap — not a medical line — sets the trajectory. The budget is passed
 * in rather than derived: a scenario states its spend as lines, the only expense surface there is.
 */
function teachingPlan(budgetLines: readonly BudgetLine[], over: Partial<Plan>): Plan {
  return {
    ...PLAN_DEFAULTS,
    goals: [],
    healthMonthlyCents: dollarsToCents(450),
    postCoverageHealthMonthlyCents: dollarsToCents(350),
    budgetLines,
    ...over,
  };
}

/**
 * A modest salary spent almost entirely each month: net worth clings to a thin buffer through
 * the working years, and with no cushion retirement is unfundable.
 */
const PAYCHECK_TO_PAYCHECK: Plan = teachingPlan(MODEST_BUDGET, {
  name: "Sam",
  jobs: [salariedJob(dollarsToCents(4500))],
  openingBalanceCents: dollarsToCents(1500),
});

/**
 * Expenses outrun income from month 0, so the shortfall cascade routes the gap onto a synthetic
 * credit card compounding at ~22%, dragging net worth negative within the first year.
 */
const LIVING_ON_CREDIT: Plan = teachingPlan(MODEST_BUDGET, {
  name: "Jordan",
  jobs: [salariedJob(dollarsToCents(3800))],
  openingBalanceCents: dollarsToCents(1000),
});

/**
 * A new graduate on a solid salary carrying a $45k loan: net worth opens underwater and climbs
 * back above zero within a decade — the "negative but improving" case.
 */
const STUDENT_LOAN: Plan = teachingPlan(LEAN_BUDGET, {
  name: "Riley",
  jobs: [salariedJob(dollarsToCents(6000))],
  openingBalanceCents: dollarsToCents(4000),
});

/**
 * A 401(k) saver living off that pre-tax balance. Spending is high enough that cash never piles
 * into a tax-free buffer, so retirement is funded by taxable withdrawals whose ordinary income,
 * stacked on Social Security, lifts the benefit over the standard deduction — so tax does not
 * stop at the last paycheck, unlike the default plan where SS sits under the deduction untaxed.
 *
 * Tuning: $5.5k spend forces the 401(k) to fund retirement (lower, and cash covers it tax-free,
 * leaving SS barely taxed); life expectancy 72 stops short of the age-73 RMDs that would spike
 * the tax chart annually.
 */
const TAXED_IN_RETIREMENT: Plan = {
  ...PLAN_DEFAULTS,
  name: "Morgan",
  jobs: [
    {
      ...salariedJob(dollarsToCents(8000)),
      deferral: { deferralFraction: 0.12, fundAccountId: RETIREMENT_ID },
    },
  ],
  budgetLines: COMFORTABLE_BUDGET,
  retirementReturnPct: 4,
  lifeExpectancy: 72,
};

/** The amortizing loan {@link STUDENT_LOAN} opens underwater against. */
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

/** In picker order; the first is the healthy default a fresh plan already opens with. */
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
  {
    id: "taxed-in-retirement",
    label: "Taxed in retirement",
    description: "A strong 401(k) saver whose withdrawals and Social Security are both taxed after the paychecks stop.",
    plan: TAXED_IN_RETIREMENT,
    events: [],
  },
];

export function presetById(id: string): Preset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
}

/**
 * Replays seeds through the same {@link addEvent} path the live UI uses, so they validate like
 * hand-added events. A rejected seed is a preset bug, not user error, so it throws rather than
 * silently dropping the event.
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
