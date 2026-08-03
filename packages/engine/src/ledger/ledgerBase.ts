/**
 * What an interpretation starts from, supplied outside the event ledger — including the
 * income/expense series of the value-editing (Budget/Accounts) surface. Value edits are
 * overrides on those series artifacts, never life events, so they belong here.
 */

import type { SimOwnedSeries } from "../projection/simulate";
import type { Person } from "../person";
import type { StopWorkingBoundary } from "../compilePerson";
import type { PlanAccount } from "../planAccount";
import type { SimGoal } from "../goal";
import type { BudgetLine } from "../budgetLine";
import type {
  SharedContributionScheme,
  SurplusDestination,
} from "../projection/waterfall";

export interface LedgerBaseConfig {
  readonly horizonMonths: number;
  readonly annualInflationRate: number;
  /** Benefit COLA rate (decimal); unset couples it to {@link annualInflationRate}. */
  readonly benefitColaRate?: number;
  readonly startYear?: number;
  /** Persons present before any events — authoring {@link Person}s. */
  readonly initialPersons?: readonly Person[];
  /**
   * The retirement solver's candidate stop-working boundary, when a solve is under way. Rides on
   * the base so BOTH job-compilation paths see it — the primary's in `createProjectionBase` and a
   * partner's in `interpret` — and every earner ceases at the same point. Absent for an ordinary
   * projection, where each person's own `retirementTargetAge` ends their open-ended jobs.
   */
  readonly stopWorking?: StopWorkingBoundary;
  /**
   * The household's accounts, each carrying both its authoring and compiled aspect (see
   * {@link PlanAccount}) so the roster's `household.accounts` and the simulation's accounts
   * are one collection. Payoff events attach their outflows to the compiled side.
   */
  readonly initialAccounts?: readonly PlanAccount[];
  readonly initialIncomeSeries?: readonly SimOwnedSeries[];
  readonly initialExpenseSeries?: readonly SimOwnedSeries[];
  /** Prioritized destinations in the waterfall. */
  readonly goals?: readonly SimGoal[];
  /**
   * Standing monthly account contributions, funded from discretionary in the waterfall.
   * Account-target lines only; expense lines compile into {@link initialExpenseSeries}.
   */
  readonly contributionLines?: readonly BudgetLine[];
  /** Lever 2: how partners split shared obligations. Default proportional. */
  readonly sharedScheme?: SharedContributionScheme;
  /** Lever 4: where leftover cash lands once every goal is funded. */
  readonly surplusDestination?: SurplusDestination;
}
