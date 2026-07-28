/**
 * Starter simulations a session can load.
 *
 * A fresh plan opens on the healthy {@link PLAN_DEFAULTS} ("Alex"); this module adds three
 * more starting points — paycheck to paycheck, living on a credit card, and a student loan
 * into negative net worth — so the app opens onto a *choice* of situations. Each preset is a
 * full {@link Scenario}: the standing {@link Plan} plus the {@link NewLifeEvent}s it needs
 * (the student loan is a real amortizing liability at "now", not a negative cash balance),
 * so what the user loads is exactly what the engine projects.
 *
 * The numbers are tuned against the live engine (see `presets.test.ts`) so each projects to
 * its intended *shape*: paycheck-to-paycheck barely accumulates and can't fund retirement,
 * the credit-card plan overspends into a compounding synthetic-card liability, the
 * student-loan plan opens underwater then digs out. Health lines sit below the default's so
 * the income/expense gap, not an outsized medical line, sets the trajectory. Spend is
 * carried as line items — the default Base budget rescaled — so loading a preset lands on
 * an editable budget rather than an empty spending chart.
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
 * A named starting point: the standing {@link Plan} plus its timeline
 * {@link NewLifeEvent}s (empty for plan-only scenarios). Authored events rather than a
 * pre-built {@link Ledger}, so each replays through the UI's own validation — a preset can
 * never smuggle in an event the event form would reject.
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
 * The default Base budget rescaled to a scenario's monthly spend. A preset is authored as
 * one legible monthly number, but empty `budgetLines` open the Base + Adjustments editor
 * onto an empty chart with nothing to edit — so every scenario gets the fresh plan's starter
 * items (housing, groceries, transport, dining, subscriptions), scaled proportionally: the
 * mix stays recognisable, the total stays exactly what the scenario was tuned to. Rounding
 * residue settles on the largest line so the lines sum to `monthlyCents` to the cent — the
 * budget replaces the scalar series wholesale, so drift here is drift in the projection.
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
 * Shared knobs for the three teaching scenarios: each is one legible income/expense gap,
 * with health lines trimmed below the default's ~$700 so that gap, not an outsized medical
 * line, sets the trajectory. `expenseCents` is spread across the default budget's items
 * ({@link scaledBudgetLines}) so the chart and Base editor have real lines to edit; the
 * scalar stays set as the engine-native fallback, inert while lines exist.
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
 * Living paycheck to paycheck: a modest salary spent almost entirely each month. Net worth
 * clings to a thin buffer through the working years, and with no cushion retirement is
 * unfundable.
 */
const PAYCHECK_TO_PAYCHECK: Plan = teachingPlan({
  name: "Sam",
  jobs: [salariedJob(dollarsToCents(4500))],
  expenseCents: dollarsToCents(3600),
  openingBalanceCents: dollarsToCents(1500),
});

/**
 * Living on a credit card: expenses outrun income from month 0, so the shortfall cascade
 * routes the gap onto a synthetic credit-card liability compounding at ~22%, dragging net
 * worth negative within the first year.
 */
const LIVING_ON_CREDIT: Plan = teachingPlan({
  name: "Jordan",
  jobs: [salariedJob(dollarsToCents(3800))],
  expenseCents: dollarsToCents(3600),
  openingBalanceCents: dollarsToCents(1000),
});

/**
 * Student loan, negative net worth: a new graduate on a solid salary carrying a $45k loan,
 * so net worth opens underwater (assets − the loan). The income services it and then some,
 * climbing back above zero within a decade — the "negative but improving" case.
 */
const STUDENT_LOAN: Plan = teachingPlan({
  name: "Riley",
  jobs: [salariedJob(dollarsToCents(6000))],
  expenseCents: dollarsToCents(3000),
  openingBalanceCents: dollarsToCents(4000),
});

/**
 * Taxed in retirement: a 401(k) saver (12% of an $8k salary) who lives off that pre-tax
 * balance. Spending is high enough that cash never piles into a tax-free buffer, so
 * retirement is funded by taxable ~$9k/mo withdrawals; that ordinary income, stacked on
 * Social Security, lifts the benefit over the standard deduction. So tax does NOT stop at
 * the last paycheck — unlike the default plan, where SS sits under the deduction untaxed —
 * it continues near the working-years level, with both an ordinary-income (withdrawals) and
 * a Government-benefit band on the tax chart (~$946/mo of the retirement tax is on the
 * benefit itself).
 *
 * Tuning: the $5.5k spend forces the 401(k) to actually fund retirement — lower, and cash
 * accumulates to cover it tax-free, leaving SS barely taxed — and life expectancy 72 keeps
 * the draw smooth and the plan solvent, short of the age-73 required minimum distributions
 * that would spike the tax chart annually.
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
 * fresh plan already opens with; the rest are the teaching scenarios.
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
 * Replay a preset's seed events into a ledger against its projection `base`, via the same
 * base-aware {@link addEvent} path the live UI uses, so seeds validate exactly like
 * hand-added events. A rejected seed is a preset bug, not user error, so it throws rather
 * than dropping the event.
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
