/**
 * What an interpretation starts from, supplied outside the event ledger — including the
 * income/expense series of the value-editing (Budget/Accounts) surface. Value edits are
 * overrides on those series artifacts, never life events, so they belong here.
 */

import type { SimOwnedSeries } from "../projection/simulate";
import type { Person } from "../person";
import type { SimAccount } from "../simAccount";
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
  /** Payoff events attach their outflows to these. */
  readonly initialAccounts?: readonly SimAccount[];
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
