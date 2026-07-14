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
  type RetirementScenario,
  type RetirementPerson,
  type RetirementTargetAssessment,
} from "@finley/engine";
import { INFLATION } from "./config";
import { PRIMARY_PERSON_ID } from "./projectionBase";
import type { BudgetValues } from "./planTypes";

/** Convert a nominal annual rate to its real (inflation-adjusted) counterpart (§0.5). */
function toRealRate(nominalRate: number): number {
  return (1 + nominalRate) / (1 + INFLATION) - 1;
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
  const realReturnRate =
    accountRatesPct.reduce((sum, pct) => sum + toRealRate(pct / 100), 0) / accountRatesPct.length;
  // Savings is the only standing account with an opening balance today; retirement
  // and brokerage build up from contributions, so the nest egg starts from savings.
  return { startingPortfolioCents: budget.openingBalanceCents, realReturnRate };
}

/**
 * The plan as the §7 check sees it: one household member (this slice is
 * single-person), the combined opening portfolio, steady real income/expense, and
 * a real portfolio return. Exported so a test or a future multi-person panel can
 * reuse the exact mapping the headline is computed from.
 */
export function buildRetirementScenario(budget: BudgetValues): RetirementScenario {
  const person: RetirementPerson = {
    id: PRIMARY_PERSON_ID,
    currentAge: budget.currentAge,
    lifeExpectancy: budget.lifeExpectancy,
    ssClaimingAge: budget.ssClaimingAge,
    annualEmploymentIncomeCents: budget.incomeCents * 12,
    annualSocialSecurityCents: budget.socialSecurityAnnualCents,
    plannedRetirementAge: budget.retirementAge,
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
}

export function retirementView(budget: BudgetValues): RetirementView {
  const scenario = buildRetirementScenario(budget);
  const headlineAge = findRetirementAge(scenario, { mode: "group" }).earliestFeasibleAge;
  const headlineMonth =
    headlineAge === null ? null : Math.max(0, (headlineAge - budget.currentAge) * 12);
  const target = assessRetirementTarget(scenario, budget.retirementAge, { mode: "group" });
  return {
    headlineAge,
    headlineMonth,
    target,
    targetOnTrackPct: Math.min(100, Math.max(0, Math.round(target.onTrackFraction * 100))),
  };
}
