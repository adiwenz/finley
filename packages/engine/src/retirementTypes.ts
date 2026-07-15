/**
 * Types for the retirement solver (§7). The scenario the survival check consumes,
 * the withdrawal seam, and the shapes it returns — separated from the solver logic
 * in `retirement.ts` so the vocabulary reads on its own. All monetary amounts are
 * real (inflation-adjusted, §0.5) integer cents.
 */

import type { Cents } from "./money";

/**
 * A withdrawal request handed to the {@link WithdrawalStep}. Carries enough
 * context for a future tax-by-type implementation to reason about *when* and *for
 * whom* the withdrawal happens; v1 ignores all of it and returns the net amount.
 */
export interface WithdrawalRequest {
  /** After-tax cash the household needs from the portfolio this year. */
  readonly netNeededCents: Cents;
  /** Years from "now" (age = currentAge + yearOffset for each person). */
  readonly yearOffset: number;
  /** Each person's age this year — the seam a future per-person tax calc reads. */
  readonly personAges: ReadonlyMap<string, number>;
}

/**
 * The replaceable withdrawal step (§5.3 seam 3): given the *net* cash needed,
 * return the *gross* portfolio withdrawal required to produce it. v1 is
 * `untaxedWithdrawal` (gross = net); a real jurisdiction grosses up for the tax
 * owed by account type. Swapping this in is the whole point of the seam.
 */
export type WithdrawalStep = (req: WithdrawalRequest) => Cents;

/** One household member as the retirement check sees them (§7). All amounts real. */
export interface RetirementPerson {
  readonly id: string;
  /** Age at "now" (year offset 0). */
  readonly currentAge: number;
  /** Age the portfolio must last to (the survival horizon for this person). */
  readonly lifeExpectancy: number;
  /**
   * Pinned Social Security claiming age (§7): benefits begin when age reaches it.
   * An INPUT to the check, never searched.
   */
  readonly ssClaimingAge: number;
  /** Real annual employment income while working (age < retirement age). */
  readonly annualEmploymentIncomeCents: Cents;
  /** Real annual Social Security benefit once age ≥ ssClaimingAge. */
  readonly annualSocialSecurityCents: Cents;
  /**
   * The person's current planned retirement age. Used as the Mode 2 pin for
   * everyone *except* the searched person, and as the target in target mode
   * (§7.1). Ignored by Mode 1 (which ties every age to the searched value).
   */
  readonly plannedRetirementAge: number;
  /**
   * Real (today's-dollars) annual health cost for this person BEFORE Medicare —
   * the self-funded figure, and the lifelong figure when {@link medicareEligibilityAge}
   * is unset (not enrolled). Grows at {@link healthRealGrowthRate} from year 0.
   * Health is per-person (its own cost and its own Medicare timing), separate from
   * and additive to the household {@link RetirementScenario.annualExpenseCents}.
   * Absent → no modelled health cost for this person (§5.4).
   */
  readonly annualHealthExpenseCents?: Cents;
  /**
   * The age this person enrolls in Medicare (§5.4): at/after it, health switches
   * from {@link annualHealthExpenseCents} to the lower
   * {@link postMedicareHealthAnnualCents} residual. UNSET models "not enrolled" —
   * the pre-Medicare (self-funded) figure runs for life, with no step. The age is
   * per-person, so each member steps on their own 65th (not the household's).
   */
  readonly medicareEligibilityAge?: number;
  /**
   * Real (today's-dollars) annual health cost from {@link medicareEligibilityAge}
   * onward — the residual Medicare leaves (premiums/Part B/out-of-pocket), an
   * authored figure, not a fixed fraction of the pre-Medicare cost. Grows at
   * {@link healthRealGrowthRate}. Ignored when not enrolled. Absent → 0 (e.g. the
   * user models forgoing coverage entirely).
   */
  readonly postMedicareHealthAnnualCents?: Cents;
  /**
   * Real (above-CPI) annual growth of this person's health cost: the health
   * inflation rate net of general inflation, so health rises in real terms while
   * flat spending holds. Applied from year 0 to whichever figure is in force.
   */
  readonly healthRealGrowthRate?: number;
}

export interface RetirementScenario {
  readonly persons: readonly RetirementPerson[];
  /** Combined real portfolio at "now" (shared + owned assets, §7). */
  readonly startingPortfolioCents: Cents;
  /** Real household annual spending (non-health), held constant across the horizon. */
  readonly annualExpenseCents: Cents;
  /**
   * Real (inflation-adjusted, §0.5) annual portfolio return. This being *real*
   * is what makes the survival check honest — nominal growth would understate how
   * fast inflation erodes a fixed withdrawal stream.
   */
  readonly realReturnRate: number;
  /** Replaceable withdrawal step (§5.3 seam 3). Defaults to `untaxedWithdrawal`. */
  readonly withdrawalStep?: WithdrawalStep;
}

/** Which ages are pinned and which are searched — the ONLY thing "mode" means (§7). */
export type RetirementSearch =
  | { readonly mode: "group" }
  | { readonly mode: "person"; readonly personId: string };

export interface RetirementSolution {
  readonly search: RetirementSearch;
  /**
   * Earliest feasible integer retirement age for the searched dimension, or null
   * when no age in range lets the money last (even working to death fails).
   */
  readonly earliestFeasibleAge: number | null;
  /**
   * The age assignment at the feasible age — the searched value applied, everyone
   * else at their pin. Empty when there is no feasible age.
   */
  readonly agesByPersonId: ReadonlyMap<string, number>;
}

export interface SurvivalResult {
  /** True when the real portfolio never runs dry through the last life expectancy. */
  readonly survives: boolean;
  /** The lowest real portfolio balance reached (post-withdrawal); < 0 ⇒ ran out. */
  readonly lowestBalanceCents: Cents;
}

export interface RetirementTargetAssessment {
  /** The pinned target age fed to the check (§7.1). */
  readonly targetAge: number;
  /** Does the portfolio survive at the pinned age? */
  readonly feasible: boolean;
  /**
   * On-track fraction (§7.1): the nest egg the plan has *at* the target retirement
   * ÷ the nest egg *required* to fund withdrawals to life expectancy. 1.0 = fully
   * funded; 0.78 = "78% of the way to a feasible age-55 retirement". Raw (not
   * capped) — the reporting layer caps at 100%.
   */
  readonly onTrackFraction: number;
  /**
   * The honest nearest-feasible age when the pin is unreachable (§7.1 / §8.2): the
   * truthful "this date isn't achievable; the nearest feasible is 58". Null when
   * no age is feasible. Equals `targetAge` when the pin itself is feasible.
   */
  readonly nearestFeasibleAge: number | null;
}
