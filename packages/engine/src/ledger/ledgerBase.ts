/**
 * Ledger base configuration — what an interpretation starts from, supplied outside the event
 * ledger: horizon, inflation, the durable persons and accounts present before any event, and
 * the value-editing (Budget/Accounts) income/expense series. Value edits are overrides on
 * those series artifacts, never life events, so they belong here.
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
  /** Persons present before any events (e.g. the primary account holder) — authoring {@link Person}s. */
  readonly initialPersons?: readonly Person[];
  /** Accounts managed outside the event ledger (payoff events attach outflows). */
  readonly initialAccounts?: readonly SimAccount[];
  /** Ongoing income series on the value-editing (Budget/Accounts) surface, not the ledger. */
  readonly initialIncomeSeries?: readonly SimOwnedSeries[];
  /** Ongoing expense series on the value-editing surface (see initialIncomeSeries). */
  readonly initialExpenseSeries?: readonly SimOwnedSeries[];
  /**
   * Funding goals — prioritized destinations in the waterfall. Value-editing surface, not
   * the event ledger: reprioritizing a goal is a plan edit, not a life event.
   */
  readonly goals?: readonly SimGoal[];
  /**
   * Standing account-contribution budget lines: "put $X into this account" monthly, funded
   * from discretionary in the waterfall. Value-editing surface, not the event ledger.
   * Expense lines compile into {@link initialExpenseSeries}; only account-target lines here.
   */
  readonly contributionLines?: readonly BudgetLine[];
  /** Lever 2: how partners split shared obligations. Default proportional. */
  readonly sharedScheme?: SharedContributionScheme;
  /** Lever 4: where leftover cash lands once every goal is funded. */
  readonly surplusDestination?: SurplusDestination;
}
