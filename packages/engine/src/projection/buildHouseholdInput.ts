/**
 * Bridge the replay-derived household into the simulator's input, then run it.
 *
 * Series arrive already materialized (one `CashFlowSeries` each, built in
 * replay); liabilities and account outflows are instantiated *here*, at the
 * simulation boundary, from immutable data (§5). Both projection and snapshot
 * read the same {@link ReplayedHousehold}, so they cannot disagree (§1, §14).
 */

import type { Jurisdiction } from "../jurisdiction";
import { Liability } from "../liability";
import {
  simulateHousehold,
  type HouseholdSimInput,
  type OwnedSeries,
  type Person,
  type ProjectionSeries,
} from "./simulate";
import type { LedgerBaseConfig, ReplayedHousehold } from "../ledger/replayState";
import { replayHousehold } from "../ledger/replay";
import type { Ledger } from "../ledger/ledger";

export function buildHouseholdSimInput(
  household: ReplayedHousehold,
  base: LedgerBaseConfig,
): HouseholdSimInput {
  const incomeSeries: OwnedSeries[] = [];
  const expenseSeries: OwnedSeries[] = [];
  for (const s of household.series) {
    const owned: OwnedSeries = { series: s.series, ownerId: s.ownerId };
    if (s.seriesType === "income") incomeSeries.push(owned);
    else expenseSeries.push(owned);
  }

  const liabilities = household.liabilities.map((def) => {
    const liab = new Liability({
      id: def.id,
      ownerId: def.ownerId,
      kind: def.kind,
      openingBalanceCents: def.openingBalanceCents,
      startMonth: def.startMonth,
      apr: def.apr,
      termMonths: def.termMonths,
      creditLimitCents: def.creditLimitCents,
    });
    for (const t of def.transfers) {
      liab.addTransfer({ month: t.month, amountCents: t.amountCents });
    }
    return liab;
  });

  // Attach payoff outflows to their accounts without discarding account state (§5).
  const accounts = (base.initialAccounts ?? []).map((acc) => {
    const transfers = household.accountTransfers
      .filter((t) => t.accountId === acc.id)
      .map((t) => ({ month: t.month, amountCents: t.amountCents }));
    return transfers.length > 0 ? acc.withAdditionalTransfers(transfers) : acc;
  });

  // Durable household roster (§3): membership intervals govern each person's
  // income series lifetime; the roster itself is the set of people who ever joined.
  const persons: Person[] = household.memberships.map((m) => m.person);

  return {
    horizonMonths: base.horizonMonths,
    annualInflationRate: base.annualInflationRate,
    startYear: base.startYear,
    persons,
    accounts,
    incomeSeries,
    expenseSeries,
    liabilities: liabilities.length > 0 ? liabilities : undefined,
  };
}

/** Run the simulation for an already-replayed household (§1). */
export function buildProjection(
  household: ReplayedHousehold,
  base: LedgerBaseConfig,
  jurisdiction: Jurisdiction,
): ProjectionSeries {
  return simulateHousehold(buildHouseholdSimInput(household, base), jurisdiction);
}

/** Convenience: replay the ledger and project in one call (§1 pipeline, single interpreter). */
export function replayLedger(
  ledger: Ledger,
  base: LedgerBaseConfig,
  jurisdiction: Jurisdiction,
): ProjectionSeries {
  return buildProjection(replayHousehold(ledger, base), base, jurisdiction);
}
