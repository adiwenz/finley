/**
 * Pure presentation logic for the retirement solver (§7). Builds the engine's
 * {@link RetirementScenario} from the editable plan values, then exposes the two
 * things the UI needs: the Mode-1 headline ("when can we retire?") and, for a
 * clicked person, their Mode-2 number — plus the target-mode assessment against
 * the pinned retirement age (on-track % + honest nearest-feasible date, §7.1).
 *
 * The scenario is expressed in today's dollars and compounds at a *real* return
 * (nominal return de-inflated), so the survival check runs on real net worth as
 * §0.5 requires. This standalone accumulation is a tracer-bullet approximation of
 * the full §5 waterfall projection; reconciling the two is a later slice.
 */

import {
  findRetirementAge,
  assessRetirementTarget,
  assessEarlyRetireeHealthCost,
  priceSocialSecurityAnnualRealCents,
  type Jurisdiction,
  type RetirementScenario,
  type RetirementPerson,
  type RetirementTargetAssessment,
  type EarlyRetireeHealthFlag,
} from "@finley/engine";
import { usJurisdiction, MEDICARE_ELIGIBILITY_AGE } from "@finley/rules";
import { START_YEAR } from "./config";
import { PRIMARY_PERSON_ID, fullCareerEarningsCents } from "./projectionBase";
import type { BudgetValues } from "./planTypes";

/**
 * Convert a nominal annual rate to its real (inflation-adjusted) counterpart at the
 * plan's configured CPI (§0.5). Everything on the retirement surface is real, so a
 * lower CPI raises real returns and real health growth, and vice versa.
 */
function toRealRate(nominalRate: number, inflationRate: number): number {
  return (1 + nominalRate) / (1 + inflationRate) - 1;
}

/**
 * The retirement portfolio's blended *real* return and its starting balance (§7).
 * The nest egg is spread across the household's standing investable accounts —
 * savings, the retirement account, and the brokerage — each with its own rate now
 * that rates are per-account, so the check must grow it at a blend of ALL of them,
 * not the retirement rate alone. Goal funds are excluded: they are earmarked for
 * their goals (and one-time goals are spent), not the retirement portfolio.
 *
 * A career's contributions land across these accounts in proportions the standalone
 * tracer-bullet can't see, so the rates are blended evenly here. A holdings-weighted
 * blend that tracks each account's own balance year by year is exactly what the
 * real §5 projection gives — that reconciliation is a later slice (see below).
 */
function portfolioSnapshot(budget: BudgetValues): {
  readonly startingPortfolioCents: number;
  readonly realReturnRate: number;
} {
  const accountRatesPct = [
    budget.savingsReturnPct,
    budget.retirementReturnPct,
    budget.brokerageReturnPct,
  ];
  const inflationRate = budget.inflationPct / 100;
  const realReturnRate =
    accountRatesPct.reduce((sum, pct) => sum + toRealRate(pct / 100, inflationRate), 0) /
    accountRatesPct.length;
  // Savings is the only standing account with an opening balance today; retirement
  // and brokerage build up from contributions, so the nest egg starts from savings.
  return { startingPortfolioCents: budget.openingBalanceCents, realReturnRate };
}

/**
 * The panel's real (today's-dollar) annual Social Security benefit, computed from
 * the SAME AIME→PIA formula the net-worth graph uses (§5.4) rather than a flat
 * authored figure — so the two surfaces report the same benefit. Builds the full-
 * career nominal earnings record the plan implies, prices the benefit at the claim
 * year through the US jurisdiction seam, then deflates it to today's dollars.
 *
 * The panel runs entirely in real terms and treats SS as flat-real; with COLA the
 * graph's benefit holds constant in real terms at exactly this claim-year value,
 * so a flat-real figure of this size is the consistent representation. A zero-
 * income plan yields an empty record and a $0 benefit.
 */
function computedSocialSecurityAnnualCents(
  budget: BudgetValues,
  jurisdiction: Jurisdiction,
): number {
  // App-side plan interpretation: reconstruct the career earnings record the plan
  // implies and pick the claim year. The engine owns the pricing (seam call +
  // real-terms deflation) so the panel and the net-worth graph can't price it apart.
  const annualWagesCents = new Map<number, number>(
    Object.entries(fullCareerEarningsCents(budget)).map(([year, cents]) => [Number(year), cents]),
  );
  const claimYear = START_YEAR - budget.currentAge + budget.ssClaimingAge;
  return priceSocialSecurityAnnualRealCents(
    jurisdiction,
    {
      record: { annualWagesCents },
      claimYear,
      claimingAge: budget.ssClaimingAge,
      currentAge: budget.ssClaimingAge,
    },
    START_YEAR,
    budget.inflationPct / 100,
  );
}

/**
 * The plan as the §7 check sees it: one household member (this slice is
 * single-person), the combined opening portfolio, steady real income/expense, and
 * a real portfolio return. Exported so a test or a future multi-person panel can
 * reuse the exact mapping the headline is computed from.
 */
export function buildRetirementScenario(
  budget: BudgetValues,
  jurisdiction: Jurisdiction = usJurisdiction,
): RetirementScenario {
  const person: RetirementPerson = {
    id: PRIMARY_PERSON_ID,
    currentAge: budget.currentAge,
    lifeExpectancy: budget.lifeExpectancy,
    ssClaimingAge: budget.ssClaimingAge,
    annualEmploymentIncomeCents: budget.incomeCents * 12,
    // Computed from the plan's earnings by default (matching the graph); an authored
    // figure, when present, overrides it (e.g. a number off an actual SSA statement).
    annualSocialSecurityCents:
      budget.socialSecurityAnnualCents ?? computedSocialSecurityAnnualCents(budget, jurisdiction),
    plannedRetirementAge: budget.retirementAge,
    // Health is per-person, additive to general spend, growing at the health rate
    // NET of general inflation so it rises in real terms while flat spending holds.
    annualHealthExpenseCents: budget.healthMonthlyCents * 12,
    healthRealGrowthRate: toRealRate(budget.healthInflationPct / 100, budget.inflationPct / 100),
    // Enrolling in Medicare steps health from the pre-65 line down to the authored
    // residual at 65; not enrolling leaves the eligibility age unset → self-funded
    // for life. Both figures are authored today's-dollars amounts (§5.4).
    ...(budget.enrollsInMedicare
      ? {
          medicareEligibilityAge: MEDICARE_ELIGIBILITY_AGE,
          postMedicareHealthAnnualCents: budget.postMedicareHealthMonthlyCents * 12,
        }
      : {}),
  };
  const portfolio = portfolioSnapshot(budget);
  return {
    persons: [person],
    startingPortfolioCents: portfolio.startingPortfolioCents,
    annualExpenseCents: budget.expenseCents * 12,
    // Blended real return across every standing account, not the retirement rate
    // alone — the nest egg is spread across accounts with different rates.
    realReturnRate: portfolio.realReturnRate,
  };
}

export interface RetirementView {
  /** Mode-1 headline: the earliest age everyone can retire, or null if unreachable. */
  readonly headlineAge: number | null;
  /**
   * Absolute simulation month for the chart's retirement reference line — the
   * headline age converted to months from "now". Null when there is no feasible age.
   */
  readonly headlineMonth: number | null;
  /** Target-mode assessment against the pinned `retirementAge` (§7.1). */
  readonly target: RetirementTargetAssessment;
  /** On-track % against the pinned age, whole-number and capped at 100 (§7.1). */
  readonly targetOnTrackPct: number;
  /**
   * Medicare honesty flag (§5.4): fires when the plan retires before the
   * Medicare-eligibility age but its authored health line is below the elevated
   * pre-65 self-funded benchmark. The panel surfaces it as a "you'll self-fund
   * coverage until 65" nudge — an estimate, not advice.
   */
  readonly earlyRetireeHealth: EarlyRetireeHealthFlag;
  /**
   * The authored Medicare residual the plan carries from 65 (§5.4), in **today's
   * dollars** — the user's own {@link BudgetValues.postMedicareHealthMonthlyCents},
   * not a derived figure. 0 when the plan does not enrol in Medicare (no residual —
   * the pre-65 self-funded line runs for life instead); {@link enrollsInMedicare}
   * tells the panel which story to tell.
   */
  readonly medicareResidualMonthlyCents: number;
  /** Whether the plan enrols in Medicare at 65 (§5.4) — drives the panel's post-65 copy. */
  readonly enrollsInMedicare: boolean;
}

/**
 * The pre-65 early-retiree health honesty flag for the plan (§5.4), in **today's
 * dollars**. The retirement panel is a real / today's-dollars surface (§0.5) and
 * the authored health line is a today's-dollars figure, so the benchmark is priced
 * at the base year too — NOT indexed out to the future retirement year, which would
 * pit a nominal 2040s cost against a today's-dollars budget. (The rules seam still
 * indexes forward for the nominal projection; this panel just asks in today's
 * terms.) Retiring at/after Medicare eligibility never flags (no self-funded gap).
 */
function earlyRetireeHealthFlag(
  budget: BudgetValues,
  jurisdiction: Jurisdiction,
): EarlyRetireeHealthFlag {
  return assessEarlyRetireeHealthCost({
    retirementAge: budget.retirementAge,
    medicareEligibilityAge: MEDICARE_ELIGIBILITY_AGE,
    authoredHealthMonthlyCents: budget.healthMonthlyCents,
    selfFundedBenchmarkMonthlyCents:
      jurisdiction.healthCostBenchmarkMonthlyCents?.({
        age: budget.retirementAge,
        year: START_YEAR,
      }) ?? 0,
  });
}

export function retirementView(
  budget: BudgetValues,
  jurisdiction: Jurisdiction = usJurisdiction,
): RetirementView {
  const scenario = buildRetirementScenario(budget, jurisdiction);
  const headlineAge = findRetirementAge(scenario, { mode: "group" }).earliestFeasibleAge;
  const headlineMonth =
    headlineAge === null ? null : Math.max(0, (headlineAge - budget.currentAge) * 12);
  const target = assessRetirementTarget(scenario, budget.retirementAge, { mode: "group" });
  return {
    headlineAge,
    headlineMonth,
    target,
    targetOnTrackPct: Math.min(100, Math.max(0, Math.round(target.onTrackFraction * 100))),
    earlyRetireeHealth: earlyRetireeHealthFlag(budget, jurisdiction),
    // The authored residual (today's dollars); 0 and moot when not enrolling.
    medicareResidualMonthlyCents: budget.enrollsInMedicare
      ? budget.postMedicareHealthMonthlyCents
      : 0,
    enrollsInMedicare: budget.enrollsInMedicare,
  };
}
