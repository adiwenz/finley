/**
 * Ledger base configuration — the facts an interpretation starts from, supplied
 * outside the event ledger: the horizon, inflation, the durable persons and
 * accounts present before any event, and the value-editing (Budget/Accounts)
 * income/expense series. Value edits are overrides on those series
 * artifacts, never life events, so they are provided here.
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
  /**
   * Optional benefit COLA rate (decimal). Passed straight to the simulator;
   * when unset the benefit COLA is coupled to {@link annualInflationRate}.
   */
  readonly benefitColaRate?: number;
  readonly startYear?: number;
  /** Persons present before any events (e.g. the primary account holder) — authoring {@link Person}s. */
  readonly initialPersons?: readonly Person[];
  /** Accounts managed outside the event ledger (payoff events attach outflows). */
  readonly initialAccounts?: readonly SimAccount[];
  /**
   * Ongoing income series on the value-editing (Budget/Accounts) surface rather
   * than the event ledger. Value edits are overrides on the series
   * artifact, never life events, so they are supplied here.
   */
  readonly initialIncomeSeries?: readonly SimOwnedSeries[];
  /** Ongoing expense series on the value-editing surface (see initialIncomeSeries). */
  readonly initialExpenseSeries?: readonly SimOwnedSeries[];
  /**
   * Funding goals — prioritized destinations in the waterfall. Like
   * the budget series, goals live on the value-editing surface, not the event
   * ledger: reprioritizing a goal is a plan edit, not a life event.
   */
  readonly goals?: readonly SimGoal[];
  /**
   * Standing account-contribution budget lines: "put $X into this account" each
   * month, funded from discretionary in the waterfall. Like goals and the budget series,
   * they live on the value-editing surface, not the event ledger. Expense budget lines
   * are compiled into {@link initialExpenseSeries}; only account-target lines are here.
   */
  readonly contributionLines?: readonly BudgetLine[];
  /** Lever 2: how partners split shared obligations. Default proportional. */
  readonly sharedScheme?: SharedContributionScheme;
  /** Lever 4: where leftover cash lands once every goal is funded. */
  readonly surplusDestination?: SurplusDestination;
}
