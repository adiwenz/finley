/**
 * Starter simulations, beyond the healthy {@link DEFAULT_INPUT} ("Alex") a fresh plan opens on.
 * Each is a single declarative {@link ScenarioInput} — plan *and* timeline — built through
 * {@link Projection.fromInput}, so the engine mints every id and no preset hand-writes one. The
 * numbers are tuned against the live engine (`presets.test.ts`) to project to their intended
 * shape.
 */

import {
  dollarsToCents,
  Projection,
  PRIMARY_PERSON_ID,
  type BudgetLine,
  type ScenarioInput,
  type ProjectionState,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { PLAN_DEFAULTS, DEFAULT_INPUT } from "./planDefaults";

/**
 * A named starting point: one {@link ScenarioInput} the app builds into a scenario. Authored
 * declaratively rather than as a pre-built {@link import("@finley/engine").Ledger}, so each
 * replays through the engine's own authoring — a preset can never smuggle in an event the
 * event form would reject.
 */
export interface Preset {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly input: ScenarioInput;
}

const DEFAULT_CURRENT_AGE = 35;
const DEFAULT_WORK_START_AGE = 18;

const START_JOB_YEAR = DEFAULT_INPUT.startYear - DEFAULT_CURRENT_AGE + DEFAULT_WORK_START_AGE;

/** One budget line entry / one job entry, derived structurally so neither sub-type is named. */
type BudgetEntry = NonNullable<ScenarioInput["budgetLines"]>[number];
type JobEntry = NonNullable<ScenarioInput["jobs"]>[number];

/**
 * A budget line authored ID-free but for a pinned label-key. The key is not a minted-shaped id,
 * so it leaves the counter untouched (the same `id ?? label` convention the Base editor keys on)
 * while the chart, overrides and `allocations()` keep a stable handle across edits.
 */
function expenseLine(
  id: string,
  label: string,
  category: BudgetLine["category"],
  monthlyDollars: number,
): BudgetEntry {
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
const MODEST_BUDGET = [
  expenseLine("housing", "Housing", "needs", 1_650),
  expenseLine("groceries", "Groceries", "needs", 720),
  expenseLine("transport", "Transportation", "needs", 460),
  expenseLine("dining", "Dining & fun", "wants", 570),
  expenseLine("subscriptions", "Subscriptions", "wants", 200),
];

/** $3,000/mo — a new graduate living below a solid salary to dig out from under a loan. */
const LEAN_BUDGET = [
  expenseLine("housing", "Housing", "needs", 1_400),
  expenseLine("groceries", "Groceries", "needs", 600),
  expenseLine("transport", "Transportation", "needs", 400),
  expenseLine("dining", "Dining & fun", "wants", 450),
  expenseLine("subscriptions", "Subscriptions", "wants", 150),
];

/** $5,500/mo — high enough that cash never piles up, forcing the 401(k) to fund retirement. */
const COMFORTABLE_BUDGET = [
  expenseLine("housing", "Housing", "needs", 2_500),
  expenseLine("groceries", "Groceries", "needs", 950),
  expenseLine("transport", "Transportation", "needs", 650),
  expenseLine("dining", "Dining & fun", "wants", 1_000),
  expenseLine("subscriptions", "Subscriptions", "wants", 400),
];

/** A single open-ended, real-flat salaried job — the same shape a fresh plan opens with. Its
 * owner is omitted, so it binds to the primary person, and its id is minted. */
function salariedJob(monthlyCents: number): JobEntry {
  return {
    startYear: START_JOB_YEAR,
    endYear: null,
    salary: { startingSalaryCents: monthlyCents * 12, realGrowthPct: 0 },
  };
}

/**
 * Each teaching scenario is one legible income/expense gap. It inherits the default's scalars
 * (returns, ages, inflation), drops the goals so the gap — not a goal's accumulation — sets the
 * trajectory, and trims health below the default's ~$700 so no medical line dominates. The budget
 * and any overrides are layered on: a scenario states its spend as lines, the only expense
 * surface there is.
 */
function teachingInput(
  budgetLines: readonly BudgetEntry[],
  over: Partial<ScenarioInput>,
): ScenarioInput {
  return {
    ...DEFAULT_INPUT,
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
const PAYCHECK_TO_PAYCHECK = teachingInput(MODEST_BUDGET, {
  name: "Sam",
  jobs: [salariedJob(dollarsToCents(4500))],
  openingBalanceCents: dollarsToCents(1500),
});

/**
 * Expenses outrun income from month 0, so the shortfall cascade routes the gap onto a synthetic
 * credit card compounding at ~22%, dragging net worth negative within the first year.
 */
const LIVING_ON_CREDIT = teachingInput(MODEST_BUDGET, {
  name: "Jordan",
  jobs: [salariedJob(dollarsToCents(3800))],
  openingBalanceCents: dollarsToCents(1000),
});

/**
 * A new graduate on a solid salary carrying a $45k loan: net worth opens underwater and climbs
 * back above zero within a decade — the "negative but improving" case. The loan is the one seed
 * event, taken at "now"; its liability id is pinned to "loan-student" so the charts keyed on it
 * keep a stable series, while the event id is minted with it.
 */
const STUDENT_LOAN = teachingInput(LEAN_BUDGET, {
  name: "Riley",
  jobs: [salariedJob(dollarsToCents(6000))],
  openingBalanceCents: dollarsToCents(4000),
  events: [
    {
      type: "takeLoan",
      id: "loan-student",
      month: 0,
      ownerRef: PRIMARY_PERSON_ID,
      kind: "studentLoan",
      openingBalanceCents: dollarsToCents(45000),
      apr: 0.06,
      termMonths: 12 * 10,
    },
  ],
});

/**
 * A 401(k) saver living off that pre-tax balance. Spending is high enough that cash never piles
 * into a tax-free buffer, so retirement is funded by taxable withdrawals whose ordinary income,
 * stacked on Social Security, lifts the benefit over the standard deduction — so tax does not
 * stop at the last paycheck, unlike the default plan where SS sits under the deduction untaxed.
 *
 * Tuning: $5.5k spend forces the 401(k) to fund retirement (lower, and cash covers it tax-free,
 * leaving SS barely taxed); life expectancy 72 stops short of the age-73 RMDs that would spike
 * the tax chart annually. The deferral omits its fund-account ref, so it funds the standing
 * 401(k).
 */
const TAXED_IN_RETIREMENT = teachingInput(COMFORTABLE_BUDGET, {
  name: "Morgan",
  jobs: [{ ...salariedJob(dollarsToCents(8000)), deferral: { deferralFraction: 0.12 } }],
  retirementReturnPct: 4,
  lifeExpectancy: 72,
});

/**
 * The healthy default a fresh plan already opens on, expressed as its input: the exact
 * {@link DEFAULT_INPUT} the plan defaults build from, plus that plan's budget lines re-declared
 * as entries so this preset reproduces {@link PLAN_DEFAULTS} rather than authoring a second
 * source of truth for it.
 */
const DEFAULT_SCENARIO: ScenarioInput = {
  ...DEFAULT_INPUT,
  budgetLines: PLAN_DEFAULTS.budgetLines.map((line) =>
    line.target.kind === "account"
      ? { ...line, target: { kind: "account", accountRef: line.target.accountId, taxTreatment: line.target.taxTreatment } }
      : { ...line, target: { kind: "expense" } },
  ),
};

/** In picker order; the first is the healthy default a fresh plan already opens with. */
export const PRESETS: readonly Preset[] = [
  {
    id: "default",
    label: "On track",
    description: "A steady saver building toward retirement — the healthy baseline.",
    input: DEFAULT_SCENARIO,
  },
  {
    id: "paycheck-to-paycheck",
    label: "Paycheck to paycheck",
    description: "Income barely covers the bills, so almost nothing is saved.",
    input: PAYCHECK_TO_PAYCHECK,
  },
  {
    id: "living-on-credit",
    label: "Living on a credit card",
    description: "Spending outruns income, piling up compounding credit-card debt.",
    input: LIVING_ON_CREDIT,
  },
  {
    id: "student-loan",
    label: "Student loan",
    description: "A new graduate underwater on a student loan, digging back to zero.",
    input: STUDENT_LOAN,
  },
  {
    id: "taxed-in-retirement",
    label: "Taxed in retirement",
    description: "A strong 401(k) saver whose withdrawals and Social Security are both taxed after the paychecks stop.",
    input: TAXED_IN_RETIREMENT,
  },
];

export function presetById(id: string): Preset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
}

/**
 * The state to load for a preset — plan plus its seed timeline — as the app's single
 * {@link ProjectionState}. Built through {@link Projection.fromInput} under the jurisdiction the
 * app projects with, so a preset's seed events are gate-checked (a §4.5 down-payment, deferral
 * caps) exactly as a live edit would be. A refusal is a preset-authoring bug, not user error, so
 * it throws rather than silently dropping the scenario.
 */
export function presetState(preset: Preset): ProjectionState {
  const built = Projection.fromInput(preset.input, usJurisdiction);
  if (!built.ok) {
    throw new Error(`Preset "${preset.id}" is not a valid ScenarioInput: ${built.error.reason}`);
  }
  return built.projection.toState();
}
