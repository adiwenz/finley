/**
 * Starter simulations a session can load.
 *
 * A fresh plan opens on the healthy {@link PLAN_DEFAULTS} ("Alex"), but that single
 * on-track saver is a thin slice of the lives the model is meant to illuminate. This
 * module adds three more starting points — living
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
 * medical line. Each scenario's spend is carried as line items — the default Base
 * budget rescaled to its total — so loading a preset lands on a budget the user can
 * read and edit rather than an empty spending chart.
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
import {
  defaultBudgetTemplate,
  toBudgetLines,
  DEFAULT_TEMPLATE_TOTAL_CENTS,
} from "./components/baseAdjustments/budgetTemplate";

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
  /** Timeline events replayed on top of the plan at load. */
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
 * The default Base budget, rescaled to a scenario's monthly spend. A preset is authored
 * as a single legible number — what this household spends each month — but a plan whose
 * `budgetLines` are empty opens the Base + Adjustments editor onto an empty spending
 * chart, with nothing to click or edit. So every scenario gets the same starter line
 * items a fresh plan has (housing, groceries, transport, dining, subscriptions),
 * proportionally scaled to its own spend: the mix stays recognisable while the total
 * stays exactly the number each scenario was tuned to. Rounding residue settles on the
 * largest line so the lines sum to `monthlyCents` to the cent — the budget is the source
 * of truth for spending (it replaces the scalar series wholesale), so a few cents of
 * drift here would be a few cents of drift in the projection.
 */
function scaledBudgetLines(monthlyCents: number): BudgetLine[] {
  const scale = monthlyCents / DEFAULT_TEMPLATE_TOTAL_CENTS;
  const lines = toBudgetLines(defaultBudgetTemplate()).map((line) =>
    line.amountSource.kind === "literal"
      ? {
          ...line,
          amountSource: {
            kind: "literal" as const,
            monthlyCents: Math.round(line.amountSource.monthlyCents * scale),
          },
        }
      : line,
  );

  const amountOf = (line: BudgetLine) =>
    line.amountSource.kind === "literal" ? line.amountSource.monthlyCents : 0;
  const residual = monthlyCents - lines.reduce((sum, line) => sum + amountOf(line), 0);
  if (residual === 0) return lines;
  const largest = lines.reduce((a, b) => (amountOf(b) > amountOf(a) ? b : a));
  return lines.map((line) =>
    line === largest
      ? {
          ...line,
          amountSource: { kind: "literal" as const, monthlyCents: amountOf(line) + residual },
        }
      : line,
  );
}

/**
 * Shared knobs for the three teaching scenarios: each is authored as one legible
 * income/expense gap — the single lever the scenario is about — and trims the health
 * lines below the default's ~$700 so that gap, not an outsized medical line, sets the
 * trajectory. The authored `expenseCents` is spread across the default budget's line
 * items ({@link scaledBudgetLines}) so the spending chart and the Base editor have real
 * lines to show and edit; the scalar stays set as the engine-native fallback, inert
 * while lines exist.
 */
function teachingPlan(over: Partial<Plan> & { readonly expenseCents: number }): Plan {
  return {
    ...PLAN_DEFAULTS,
    goals: [],
    healthMonthlyCents: dollarsToCents(450),
    postCoverageHealthMonthlyCents: dollarsToCents(350),
    ...over,
    budgetLines: scaledBudgetLines(over.expenseCents),
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
 * Living on a credit card: expenses outrun income from month 0, so the shortfall
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
 * $45k student loan, so net worth opens underwater (assets − the loan). The income
 * services the loan and then some, so the line climbs back above zero within a decade —
 * the "negative but improving" case the model must show.
 */
const STUDENT_LOAN: Plan = teachingPlan({
  name: "Riley",
  jobs: [salariedJob(dollarsToCents(6000))],
  expenseCents: dollarsToCents(3000),
  openingBalanceCents: dollarsToCents(4000),
});

/**
 * Taxed in retirement: a diligent 401(k) saver (12% of an $8k salary) who then lives off
 * that pre-tax balance in retirement. Because the household spends enough that its cash
 * doesn't pile into a tax-free buffer, retirement is funded by taxable 401(k) withdrawals
 * (~$9k/mo) rather than a savings drawdown — and that ordinary income, stacked on top of
 * Social Security, lifts the benefit over the standard deduction. So — unlike the default
 * plan, where Social Security sits under it and is never taxed — tax does NOT stop at the
 * last paycheck: it continues at roughly the working-years level right through retirement,
 * with both an ordinary-income (the withdrawals) and a Government-benefit band on the tax
 * chart (~$946/mo of the retirement tax is on the benefit itself).
 *
 * Tuned deliberately: the $5.5k monthly spend forces the 401(k) to actually fund
 * retirement (a lower spend lets cash accumulate and cover it tax-free, leaving SS barely
 * taxed), and a life expectancy of 72 keeps the draw smooth and the plan solvent, before
 * age-73 required minimum distributions would turn the tax chart into lumpy annual spikes.
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
  expenseCents: dollarsToCents(5500),
  budgetLines: scaledBudgetLines(dollarsToCents(5500)),
  retirementReturnPct: 4,
  lifeExpectancy: 72,
};

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
  {
    id: "taxed-in-retirement",
    label: "Taxed in retirement",
    description: "A strong 401(k) saver whose withdrawals and Social Security are both taxed after the paychecks stop.",
    plan: TAXED_IN_RETIREMENT,
    events: [],
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
