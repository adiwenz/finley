/**
 * Turns a {@link Plan} (authored financial values — NOT life events) into the engine's
 * `LedgerBaseConfig`. Pure and jurisdiction-agnostic except for one fact the caller supplies
 * via {@link ProjectionContext}: the calendar "now" (`startYear` — the engine cannot read a
 * wall clock). The public-health-coverage age is no longer among them; health is an ordinary
 * budget line, so nothing here steps it at an age.
 */

import {
  CAPITAL_GAINS_TAX_PROFILE,
  PRE_TAX_TAX_PROFILE,
  CASH_INTEREST_TAX_PROFILE,
  TAX_EXEMPT_TAX_PROFILE,
  type SimAccountTaxProfile,
} from "./simAccount";
import { planAccount, type PlanAccount } from "./planAccount";
import type { PersonId } from "./job";
import type { SimOwnedSeries, ProjectionSeries } from "./projection/simulate";
import type { SimGoal, GoalDisposal } from "./goal";
import type { LedgerBaseConfig } from "./ledger/ledgerBase";
import type { SurplusDestination } from "./projection/waterfall";
import type { Jurisdiction } from "./jurisdiction";
import { planHorizonMonths, type Plan, type GoalPlan, type GoalAccountType } from "./plan";
import { type Person } from "./person";
import { compileHouseholdJobSeries } from "./compilePerson";
import {
  personJobContexts,
  resolveHouseholdJobs,
  type StopWorkingBoundary,
} from "./householdJob";
import { compileExpenseBudgetLines } from "./compileBudget";
import type { BudgetLine, TaxTreatment } from "./budgetLine";
import { RETIREMENT_ID } from "./ids";

export interface ProjectionContext {
  readonly jurisdiction: Jurisdiction;
  /** Calendar year of month 0 — the frozen "now". Environment, not a plan field. */
  readonly startYear: number;
}

/** The primary (and, in this slice, only) household member. */
export const PRIMARY_PERSON_ID = "p1";
export const SAVINGS_ID = "savings";
// RETIREMENT_ID — the account this module mints for a job's 401(k) deferral to fund — lives
// in `ids` so `job` can name the same default without importing this module (which would
// cycle back through `compilePerson`). Imported above; not re-exported, so the export map has
// exactly one source for it.
export const BROKERAGE_ID = "brokerage";

// Shared by {@link buildPlanAccounts} and {@link planAccountDescriptors} so a label
// can't drift between the two.
const SAVINGS_LABEL = "Cash savings";
const RETIREMENT_LABEL = "Retirement account";
const BROKERAGE_LABEL = "Brokerage";

/**
 * Standing accounts a budget contribution line may pay into. **Post-tax only**:
 * contributions come out of already-taxed take-home, so a pre-tax target would skip the
 * deduction and overstate tax — pre-tax saving is the job's 401(k) deferral. The app
 * builds its target picker from this list, so account ids are never hardcoded in the UI.
 */
export const CONTRIBUTION_TARGETS: readonly {
  readonly accountId: string;
  readonly label: string;
  readonly taxTreatment: TaxTreatment;
}[] = [
  { accountId: BROKERAGE_ID, label: "Brokerage", taxTreatment: "postTax" },
  { accountId: SAVINGS_ID, label: "Cash savings", taxTreatment: "postTax" },
];

/**
 * One fund account per goal, so two goals never share a balance. Prefixed `fund-`, not
 * `goal-`: once ids are minted the goal id already reads `goal-N`, and a `goal-` fund
 * prefix would double it to `goal-goal-N`.
 */
export function goalFundAccountId(goal: GoalPlan): string {
  return `fund-${goal.id}`;
}

/**
 * Tax behaviour + liquidity a {@link GoalAccountType} resolves to on the goal's fund
 * account: the user authors what KIND of account holds the goal, the projection derives
 * the rest. The retirement vehicles are illiquid — locked up by age and penalty rules, so
 * unreachable as a buffer. Cash withdrawal is tax-free because its interest is taxed at
 * accrual instead.
 */
export const GOAL_ACCOUNT_SHAPES: Readonly<
  Record<GoalAccountType, { readonly taxProfile: SimAccountTaxProfile; readonly liquid: boolean }>
> = {
  cash: { taxProfile: CASH_INTEREST_TAX_PROFILE, liquid: true },
  brokerage: { taxProfile: CAPITAL_GAINS_TAX_PROFILE, liquid: true },
  taxExempt: { taxProfile: TAX_EXEMPT_TAX_PROFILE, liquid: false },
  preTax: { taxProfile: PRE_TAX_TAX_PROFILE, liquid: false },
};

const DEFAULT_GOAL_ACCOUNT_TYPE: GoalAccountType = "brokerage";

export function goalAccountShape(goal: GoalPlan): {
  readonly taxProfile: SimAccountTaxProfile;
  readonly liquid: boolean;
} {
  return GOAL_ACCOUNT_SHAPES[goal.accountType ?? DEFAULT_GOAL_ACCOUNT_TYPE];
}

/**
 * Every account implied by the plan: the three standing accounts, then one fund per goal.
 * Nobody authors these by hand — every projection has savings, retirement and brokerage by
 * construction, owned by the plan's single {@link PRIMARY_PERSON_ID} person. Each comes out
 * as a {@link PlanAccount}, so the household's authoring view and the simulator's compiled
 * view are built from one spec here and cannot diverge downstream.
 */
export function buildPlanAccounts(budget: Plan): PlanAccount[] {
  const owners = [PRIMARY_PERSON_ID as PersonId];
  const accounts: PlanAccount[] = [
    planAccount({
      id: SAVINGS_ID,
      owners,
      label: SAVINGS_LABEL,
      liquid: true,
      // Not capital-gains: such a draw counts toward provisional income and pulls the
      // government benefit into tax. Not tax-exempt either: withdrawal is free only
      // BECAUSE the interest is taxed as ordinary income at accrual.
      taxProfile: CASH_INTEREST_TAX_PROFILE,
      balanceCents: budget.openingBalanceCents,
      initialAnnualRate: budget.savingsReturnPct / 100,
    }),
    planAccount({
      id: RETIREMENT_ID,
      owners,
      label: RETIREMENT_LABEL,
      liquid: false,
      taxProfile: PRE_TAX_TAX_PROFILE,
      balanceCents: 0,
      initialAnnualRate: budget.retirementReturnPct / 100,
    }),
    planAccount({
      id: BROKERAGE_ID,
      owners,
      label: BROKERAGE_LABEL,
      liquid: false,
      taxProfile: CAPITAL_GAINS_TAX_PROFILE,
      balanceCents: 0,
      initialAnnualRate: budget.brokerageReturnPct / 100,
    }),
  ];
  for (const goal of budget.goals) {
    const { taxProfile, liquid } = goalAccountShape(goal);
    accounts.push(
      planAccount({
        id: goalFundAccountId(goal),
        owners,
        // Named for its goal, so a drawdown reads as that goal, not a tax bucket.
        label: goal.name,
        liquid,
        taxProfile,
        balanceCents: 0,
        initialAnnualRate: goal.annualReturnPct / 100,
      }),
    );
  }
  return accounts;
}

/** Presentation grouping, not tax shape. */
export type PlanAccountKind = "cash" | "retirement" | "brokerage" | "goal";

export interface PlanAccountDescriptor {
  readonly id: string;
  readonly label: string;
  readonly kind: PlanAccountKind;
}

/**
 * The plan's accounts as presentation metadata, in the SAME order and with the SAME
 * ids/labels as {@link buildPlanAccounts} but without constructing sim objects. The UI
 * reads this instead of the `SimAccount` instances, so presentation never depends on the
 * sim-construction path and account ids are never hardcoded in the app.
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

/** The plan's goals as engine `SimGoal`s. Array order is priority (index 0 first). */
export function buildPlanGoals(budget: Plan): SimGoal[] {
  return budget.goals.map((goal, i) => {
    // disposition/targetDate travel as ONE value so a goal's fate and its date stay
    // correlated across the mapping.
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
 * Compile a {@link Plan} into the ledger base. `stopWorking` is the retirement solver's candidate
 * boundary — supplied only when the question is a hypothesis, and threaded to every
 * job-compilation path so all earners move together; absent, every job ends where it was
 * authored to end.
 */
export function createProjectionBase(
  budget: Plan,
  ctx: ProjectionContext,
  stopWorking?: StopWorkingBoundary,
): LedgerBaseConfig {
  const { startYear } = ctx;
  const inflationRate = budget.inflationPct / 100;
  const birthYear = startYear - budget.currentAge;

  // Jobs are the sole source of earned income: the pre-"now" covered-earnings record and
  // the forward income series both fall out of job spans and salaries, never a scalar lever.
  //
  // Nothing about a retirement AGE reaches this person. The plan used to pin one and hand it
  // down here as a per-person figure the compiler read as an employment end — and mid-solve that
  // field was quietly swapped for the candidate age, since it was the only way a search could
  // explore past what the plan already said. Both are gone: a job ends where it was authored to,
  // and a candidate travels as a {@link StopWorkingBoundary} that says plainly it is a
  // hypothesis.
  const standingPerson: Person = {
    id: PRIMARY_PERSON_ID,
    name: budget.name,
    birthYear,
    benefitClaimingAge: budget.benefitClaimingAge,
    jobs: budget.jobs,
    // The one plan field that is a reference into `jobs` rather than a figure. Copied verbatim,
    // `undefined` included: "not chosen yet" is a state `continuationJobIdOf` resolves on read,
    // so defaulting it here would freeze an answer the plan never gave.
    continuationJobId: budget.continuationJobId,
  };

  // Expenses are authored solely as budget lines — there is no separate general-expense
  // lever, and none for health either: a `healthcare`-category line is compiled by exactly
  // the path every other expense takes. An empty budget spends nothing; events still apply.
  const budgetLines = budget.budgetLines;
  // Account-target lines fund the waterfall's contribution step each month.
  const contributionLines: readonly BudgetLine[] = budgetLines.filter(
    (l) => l.target.kind === "account",
  );
  // The owner tag is inert today: the simulator sums all expense series into one household
  // obligation and splits it by `sharedScheme`, never reading an expense's ownerId. It
  // starts doing work once a line can be *personal* (charged against that person's
  // take-home first).
  const generalExpenseSeries: readonly SimOwnedSeries[] = compileExpenseBudgetLines(
    budgetLines,
    PRIMARY_PERSON_ID,
    inflationRate,
  );

  /**
   * The plan's own span, "now" to life expectancy — the one definition, shared with every surface
   * that draws the plan, so a chart axis and the months the simulator emitted cannot disagree.
   */
  const horizonMonths = planHorizonMonths(budget);

  // One forward income series per job; pre-tax 401(k) deferral and employer match ride
  // on the job.
  //
  // The primary's membership runs the whole projection — they are the household from month
  // `-Infinity` and never separate from it — so it clips nothing; it is passed anyway so the
  // primary's jobs take exactly the path a partner's do, with no primary-only branch anywhere
  // in job resolution or compilation.
  const initialIncomeSeries: readonly SimOwnedSeries[] = compileHouseholdJobSeries(
    resolveHouseholdJobs(
      personJobContexts({ person: standingPerson, startMonth: -Infinity, endMonth: null }),
      startYear,
      stopWorking === undefined
        ? { kind: "authored" }
        : { kind: "hypothetical", stopWorking },
    ),
    startYear,
    inflationRate,
  );

  // Leftover cash idles in the liquid account unless `surplusCashTo` sweeps it into the
  // taxable brokerage. The concrete account id stays here — the plan carries only the
  // user-facing "savings"/"brokerage" intent.
  const surplusDestination: SurplusDestination =
    budget.surplusCashTo === "brokerage"
      ? { kind: "swept", accountId: BROKERAGE_ID }
      : { kind: "idle" };

  return {
    horizonMonths,
    annualInflationRate: inflationRate,
    benefitColaRate: budget.benefitColaRate,
    startYear,
    // Authoring Persons only; SimPerson is derived at the sim boundary, never here.
    initialPersons: [standingPerson],
    initialAccounts: buildPlanAccounts(budget),
    initialIncomeSeries,
    initialExpenseSeries: generalExpenseSeries,
    goals: buildPlanGoals(budget),
    contributionLines,
    sharedScheme: budget.sharedScheme,
    surplusDestination,
    // Carried through so `interpret` caps a partner's jobs at the same boundary this call just
    // capped the primary's at.
    stopWorking,
  };
}

export function firstInsolventMonth(series: ProjectionSeries): number | null {
  for (const m of series.months) if (m.isInsolvent) return m.month;
  return null;
}
