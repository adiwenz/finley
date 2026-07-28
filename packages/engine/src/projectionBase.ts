/**
 * Turns a {@link Plan} (authored financial values — NOT life events) into the engine's
 * `LedgerBaseConfig`, including the waterfall config. The account/goal derivation is
 * exported so a goals surface can score the same goals without duplicating the map.
 *
 * Pure and jurisdiction-agnostic except for two facts the caller must supply via
 * {@link ProjectionContext}: the calendar "now" (`startYear` — the engine cannot read a
 * wall clock) and the public-health-coverage age (a jurisdiction fact).
 */

import { SimCashFlowSeries } from "./cashFlowSeries";
import {
  SimAccount,
  CAPITAL_GAINS_TAX_PROFILE,
  PRE_TAX_TAX_PROFILE,
  CASH_INTEREST_TAX_PROFILE,
  TAX_EXEMPT_TAX_PROFILE,
  type SimAccountTaxProfile,
} from "./simAccount";
import type { SimOwnedSeries, ProjectionSeries } from "./projection/simulate";
import type { SimGoal, GoalDisposal } from "./goal";
import type { LedgerBaseConfig } from "./ledger/ledgerBase";
import type { SurplusDestination } from "./projection/waterfall";
import type { Jurisdiction } from "./jurisdiction";
import type { Plan, GoalPlan, GoalAccountType } from "./plan";
import { type Person } from "./person";
import { compilePersonIncomeSeries } from "./compilePerson";
import { compileExpenseBudgetLines } from "./compileBudget";
import type { BudgetLine, TaxTreatment } from "./budgetLine";

/**
 * Environment + jurisdiction the plan→projection mapping resolves against. `startYear`
 * (the frozen "now") is caller-supplied because the engine is pure; the jurisdiction
 * carries the facts the mapping needs, notably {@link
 * Jurisdiction.publicHealthCoverageAge} for the health step.
 */
export interface ProjectionContext {
  /** The jurisdiction whose readable facts the mapping resolves against. */
  readonly jurisdiction: Jurisdiction;
  /** Calendar year of month 0 — the frozen "now". App-supplied environment, not a plan field. */
  readonly startYear: number;
}

/** The primary (and, in this slice, only) household member. */
export const PRIMARY_PERSON_ID = "p1";
const SAVINGS_ID = "savings";
/** The pre-tax retirement account a {@link Job}'s 401(k) deferral funds. */
export const RETIREMENT_ID = "retirement";
const BROKERAGE_ID = "brokerage";

// Standing-account labels — read by both {@link buildPlanAccounts} and
// {@link planAccountDescriptors}, so a name can't drift between the two.
const SAVINGS_LABEL = "Cash savings";
const RETIREMENT_LABEL = "Retirement account";
const BROKERAGE_LABEL = "Brokerage";

/**
 * Standing accounts a budget contribution line may pay into, with their portable
 * {@link TaxTreatment}. **Post-tax only**: contributions come out of already-taxed
 * take-home, so a pre-tax target would skip the deduction and overstate tax — pre-tax
 * saving is the job's 401(k) deferral. The app builds its target picker from this list,
 * so account ids are never hardcoded in the UI.
 */
export const CONTRIBUTION_TARGETS: readonly {
  readonly accountId: string;
  readonly label: string;
  readonly taxTreatment: TaxTreatment;
}[] = [
  { accountId: BROKERAGE_ID, label: "Brokerage", taxTreatment: "postTax" },
  { accountId: SAVINGS_ID, label: "Cash savings", taxTreatment: "postTax" },
];

/** The fund account a goal accumulates into (one per goal, so goals don't share a balance). */
export function goalFundAccountId(goal: GoalPlan): string {
  return `goal-${goal.id}`;
}

/**
 * Tax behaviour + liquidity a {@link GoalAccountType} resolves to on the goal's fund
 * account. The user authors what KIND of account holds the goal; the projection derives
 * the rest rather than hard-coding capital-gains-and-illiquid.
 *
 * `"cash"` and `"brokerage"` are liquid — a cash reserve exists to be reachable, and a
 * taxable brokerage is sellable on demand. The retirement vehicles (`"taxExempt"`,
 * `"preTax"`) are illiquid: locked up by age and penalty rules, so unreachable as a
 * buffer. Cash withdrawal is tax-free because its interest is taxed at accrual;
 * brokerage withdrawal is capital-gains. An unauthored type keeps `"brokerage"`.
 */
export const GOAL_ACCOUNT_SHAPES: Readonly<
  Record<GoalAccountType, { readonly taxProfile: SimAccountTaxProfile; readonly liquid: boolean }>
> = {
  cash: { taxProfile: CASH_INTEREST_TAX_PROFILE, liquid: true },
  brokerage: { taxProfile: CAPITAL_GAINS_TAX_PROFILE, liquid: true },
  taxExempt: { taxProfile: TAX_EXEMPT_TAX_PROFILE, liquid: false },
  preTax: { taxProfile: PRE_TAX_TAX_PROFILE, liquid: false },
};

/** The default account type for a goal that never declared one. */
const DEFAULT_GOAL_ACCOUNT_TYPE: GoalAccountType = "brokerage";

/** Resolve a goal's fund-account tax profile + liquidity from its authored account type. */
export function goalAccountShape(goal: GoalPlan): {
  readonly taxProfile: SimAccountTaxProfile;
  readonly liquid: boolean;
} {
  return GOAL_ACCOUNT_SHAPES[goal.accountType ?? DEFAULT_GOAL_ACCOUNT_TYPE];
}

/**
 * Every account implied by the plan: the liquid savings account, the pre-tax
 * retirement account (funded by the deferral lever), the sweep-target brokerage,
 * and one fund account per goal. All non-liquid accounts carry the plan's return
 * rate, which is what makes near-term goals in them trip the risk flag.
 */
export function buildPlanAccounts(budget: Plan): SimAccount[] {
  const accounts: SimAccount[] = [
    new SimAccount({
      id: SAVINGS_ID,
      ownerId: PRIMARY_PERSON_ID,
      label: SAVINGS_LABEL,
      liquid: true,
      // A cash buffer, not an investment: in post-tax, out untaxed. Not the
      // capital-gains profile — a capital-gains draw counts toward provisional income
      // and pulls the government benefit into tax (see federalTax's provisional-income
      // note). Not the tax-exempt one either: withdrawal is free only BECAUSE the
      // interest is taxed as ordinary income at accrual, which the cash profile declares.
      taxProfile: CASH_INTEREST_TAX_PROFILE,
      openingBalanceCents: budget.openingBalanceCents,
      initialAnnualRate: budget.savingsReturnPct / 100,
    }),
    new SimAccount({
      id: RETIREMENT_ID,
      ownerId: PRIMARY_PERSON_ID,
      label: RETIREMENT_LABEL,
      liquid: false,
      taxProfile: PRE_TAX_TAX_PROFILE,
      openingBalanceCents: 0,
      initialAnnualRate: budget.retirementReturnPct / 100,
    }),
    new SimAccount({
      id: BROKERAGE_ID,
      ownerId: PRIMARY_PERSON_ID,
      label: BROKERAGE_LABEL,
      liquid: false,
      taxProfile: CAPITAL_GAINS_TAX_PROFILE,
      openingBalanceCents: 0,
      initialAnnualRate: budget.brokerageReturnPct / 100,
    }),
  ];
  for (const goal of budget.goals) {
    // The authored account type is the source of truth; tax profile and liquidity
    // derive from it rather than every goal being a hard-coded capital-gains investment.
    const { taxProfile, liquid } = goalAccountShape(goal);
    accounts.push(
      new SimAccount({
        id: goalFundAccountId(goal),
        ownerId: PRIMARY_PERSON_ID,
        // Name the fund by its goal, so a drawdown reads as that goal rather than
        // an anonymous tax-bucket band.
        label: goal.name,
        liquid,
        taxProfile,
        openingBalanceCents: 0,
        initialAnnualRate: goal.annualReturnPct / 100,
      }),
    );
  }
  return accounts;
}

/** The kind of standing account a descriptor names — presentation grouping, not tax shape. */
export type PlanAccountKind = "cash" | "retirement" | "brokerage" | "goal";

/** A plan account as presentation metadata: its stable id, display label, and kind. */
export interface PlanAccountDescriptor {
  readonly id: string;
  readonly label: string;
  readonly kind: PlanAccountKind;
}

/**
 * The plan's accounts as presentation metadata, in the SAME order and with the SAME
 * ids/labels as {@link buildPlanAccounts} but without constructing sim objects. The
 * app's supported way to name and order accounts: the UI reads this instead of the
 * `SimAccount` instances, so presentation never depends on the sim-construction path
 * and account ids are never hardcoded in the app.
 */
export function planAccountDescriptors(budget: Plan): PlanAccountDescriptor[] {
  const descriptors: PlanAccountDescriptor[] = [
    { id: SAVINGS_ID, label: SAVINGS_LABEL, kind: "cash" },
    { id: RETIREMENT_ID, label: RETIREMENT_LABEL, kind: "retirement" },
    { id: BROKERAGE_ID, label: BROKERAGE_LABEL, kind: "brokerage" },
  ];
  for (const goal of budget.goals) {
    descriptors.push({ id: goalFundAccountId(goal), label: goal.name, kind: "goal" });
  }
  return descriptors;
}

/**
 * The plan's goals as engine `SimGoal`s. Array order is priority (index 0 first),
 * so reordering the plan array reprioritizes without touching anything else.
 */
export function buildPlanGoals(budget: Plan): SimGoal[] {
  return budget.goals.map((goal, i) => {
    // disposition/targetDate travel as ONE value ({@link GoalDisposal}) so a goal's
    // fate and its date stay correlated across the plan→sim mapping.
    const disposal: GoalDisposal = goal;
    return {
      id: goal.id,
      name: goal.name,
      targetCents: goal.targetCents,
      fundAccountId: goalFundAccountId(goal),
      priority: i,
      scope: "shared" as const,
      ...disposal,
    };
  });
}

/**
 * The health expense line, additive to the general expense and growing at its own
 * `healthInflationPct` rather than being pinned to CPI. When the plan enrols in public
 * coverage and the jurisdiction has a `publicHealthCoverageAge`, the line steps from the
 * self-funded figure down to the authored residual at the month that age is reached.
 * Both figures are authored in today's dollars and share the same forward inflation, so
 * the override is the residual inflated to the coverage age. Not enrolling, no coverage
 * age, or already past it collapses to a single segment.
 */
function buildHealthSeries(budget: Plan, coverageAge: number | undefined): SimCashFlowSeries {
  const rate = budget.healthInflationPct / 100;
  const growth = { type: "customRate" as const, annualRate: rate };
  // No coverage age means no public coverage to step down to.
  const enrolls = budget.enrollsInPublicHealthCoverage && coverageAge !== undefined;
  if (!enrolls) {
    return new SimCashFlowSeries(0, budget.healthMonthlyCents, growth, {
      baselineUnit: "monthly",
    });
  }
  const yearsToCoverage = coverageAge - budget.currentAge;

  // Already at/past the coverage age → the residual applies from month 0.
  if (yearsToCoverage <= 0) {
    return new SimCashFlowSeries(0, budget.postCoverageHealthMonthlyCents, growth, {
      baselineUnit: "monthly",
    });
  }

  const series = new SimCashFlowSeries(0, budget.healthMonthlyCents, growth, {
    baselineUnit: "monthly",
  });
  // Residual (today's dollars) inflated forward to the coverage month, then growing
  // at the same rate from its own anchor.
  const nominalResidualAtCoverage = Math.round(
    budget.postCoverageHealthMonthlyCents * Math.pow(1 + rate, yearsToCoverage),
  );
  series.addOverride(yearsToCoverage * 12, nominalResidualAtCoverage, "fromHereForward", {
    newGrowthMode: growth,
    resetAnchor: true,
  });
  return series;
}

export function createProjectionBase(budget: Plan, ctx: ProjectionContext): LedgerBaseConfig {
  const { startYear } = ctx;
  const inflationRate = budget.inflationPct / 100;
  const birthYear = startYear - budget.currentAge;

  // Jobs are the sole source of truth for earned income: both the pre-"now"
  // covered-earnings record and the forward income series fall out of the jobs' spans
  // and salaries, never a scalar lever.
  const standingPerson: Person = {
    id: PRIMARY_PERSON_ID,
    name: budget.name,
    birthYear,
    retirementTargetAge: budget.retirementAge,
    benefitClaimingAge: budget.benefitClaimingAge,
    jobs: budget.jobs,
  };

  // General (non-health) expenses grow with CPI — flat in real terms.
  const expenseSeries = new SimCashFlowSeries(
    0,
    budget.expenseCents,
    { type: "inflationLinked", annualRate: inflationRate },
    { baselineUnit: "monthly" },
  );
  // Value edits are overrides on the artifact — never life events (rule 1).
  for (const o of budget.expenseOverrides) {
    expenseSeries.addOverride(o.month, o.monthlyCents, o.scope);
  }

  // A non-empty line-item budget takes over from the scalar `expenseCents` series: its
  // EXPENSE lines compile to spending series (spans + dated overrides ride along).
  // Absent/empty falls back to the scalar series above.
  const budgetLines = budget.budgetLines;
  // Account-target lines fund the waterfall's contribution step each month; split once here.
  const contributionLines: readonly BudgetLine[] = (budgetLines ?? []).filter(
    (l) => l.target.kind === "account",
  );
  // The owner tag is inert today: the simulator sums all expense series into one
  // household obligation and splits it by `sharedScheme`, never reading an expense's
  // ownerId, so every expense is effectively shared. It starts doing work once a line
  // can be *personal* to its owner (charged against that person's take-home first).
  const generalExpenseSeries: readonly SimOwnedSeries[] =
    budgetLines != null && budgetLines.length > 0
      ? compileExpenseBudgetLines(budgetLines, PRIMARY_PERSON_ID, inflationRate)
      : [
          {
            series: expenseSeries,
            ownerId: PRIMARY_PERSON_ID,
            label: "Expenses",
            // The scalar lever, not a line: reports as one item, edited on the plan
            // rather than in the line editor.
            spendingSource: {
              kind: "planExpense",
              id: "plan-expenses",
              category: "other",
              editable: false,
            },
          },
        ];

  const healthSeries = buildHealthSeries(budget, ctx.jurisdiction.publicHealthCoverageAge);

  // One forward income {@link SimOwnedSeries} per job, from "now" (or the job's later
  // start) to its end. Pre-tax 401(k) deferral and employer match ride on the job.
  const initialIncomeSeries: readonly SimOwnedSeries[] = compilePersonIncomeSeries(
    standingPerson,
    startYear,
    inflationRate,
  );

  // Leftover cash idles in the liquid account unless `surplusCashTo` sweeps it into the
  // taxable brokerage (earning the brokerage return, not the cash rate); contribution
  // budget lines can still target any account. The concrete account id stays here — the
  // plan carries only the user-facing "savings"/"brokerage" intent.
  const surplusDestination: SurplusDestination =
    budget.surplusCashTo === "brokerage"
      ? { kind: "swept", accountId: BROKERAGE_ID }
      : { kind: "idle" };

  return {
    horizonMonths: Math.max(0, (budget.lifeExpectancy - budget.currentAge) * 12),
    annualInflationRate: inflationRate,
    benefitColaRate: budget.benefitColaRate,
    startYear,
    // Authoring Persons only; SimPerson is derived at the sim boundary
    // (buildHouseholdSimInput → compilePerson), never here.
    initialPersons: [standingPerson],
    initialAccounts: buildPlanAccounts(budget),
    initialIncomeSeries,
    initialExpenseSeries: [
      ...generalExpenseSeries,
      {
        series: healthSeries,
        ownerId: PRIMARY_PERSON_ID,
        label: "Healthcare",
        // Non-optional spending authored as a plan input, not a budget line — it
        // reports, but is not editable here.
        spendingSource: {
          kind: "healthcare",
          id: "health",
          category: "healthcare",
          editable: false,
        },
      },
    ],
    goals: buildPlanGoals(budget),
    contributionLines,
    sharedScheme: budget.sharedScheme,
    surplusDestination,
  };
}

export function firstInsolventMonth(series: ProjectionSeries): number | null {
  for (const m of series.months) if (m.isInsolvent) return m.month;
  return null;
}
