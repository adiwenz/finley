/**
 * Bridge the replay-derived household into the simulator's input, then run it.
 *
 * Series arrive already materialized (one `CashFlowSeries` each, built in
 * replay); liabilities and account outflows are instantiated *here*, at the
 * simulation boundary, from immutable data (§5). Both projection and snapshot
 * read the same {@link Household}, so they cannot disagree (§1, §14).
 */

import type { Jurisdiction } from "../jurisdiction";
import { Liability } from "../liability";
import { growthAnnualRate } from "../cashFlowSeries";
import {
  simulateHousehold,
  type HouseholdSimInput,
  type OwnedSeries,
  type SimPerson,
  type ProjectionSeries,
  type SimProperty,
} from "./simulate";
import type { LedgerBaseConfig } from "../ledger/ledgerBase";
import type { Household } from "../ledger/household";
import { interpretLedger } from "../ledger/interpret";
import type { Ledger } from "../ledger/ledger";

export function buildHouseholdSimInput(
  household: Household,
  base: LedgerBaseConfig,
): HouseholdSimInput {
  const incomeSeries: OwnedSeries[] = [];
  const expenseSeries: OwnedSeries[] = [];
  for (const s of household.series) {
    if (s.seriesType === "income") {
      // Preserve the §5.5 plan descriptor so plan-bearing income defers pre-tax
      // in the waterfall; expenses never carry one.
      incomeSeries.push({ series: s.series, ownerId: s.ownerId, planDescriptor: s.planDescriptor });
    } else {
      expenseSeries.push({ series: s.series, ownerId: s.ownerId });
    }
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

  // Properties: durable appreciating stocks (§4.1). Resolve each growth mode to
  // its annual rate here, at the sim boundary — the simulator compounds value at
  // that rate exactly as it compounds accounts.
  const properties: SimProperty[] = household.properties.map((p) => ({
    id: p.id,
    ownerId: p.ownerId,
    startMonth: p.startMonth,
    endMonth: p.endMonth,
    openingValueCents: p.openingValueCents,
    appreciationAnnualRate: growthAnnualRate(p.appreciationMode),
  }));

  // Durable household roster (§3): membership intervals govern each person's
  // income series lifetime; the roster itself is the set of people who ever joined.
  const persons: SimPerson[] = household.memberships.map((m) => m.person);

  return {
    horizonMonths: base.horizonMonths,
    annualInflationRate: base.annualInflationRate,
    startYear: base.startYear,
    persons,
    accounts,
    incomeSeries,
    expenseSeries,
    liabilities: liabilities.length > 0 ? liabilities : undefined,
    properties: properties.length > 0 ? properties : undefined,
    // §5.0 waterfall config lives on the value-editing surface (§10.2), not the
    // ledger, so it rides along on the base rather than being derived from events.
    goals: base.goals,
    sharedScheme: base.sharedScheme,
    surplusDestination: base.surplusDestination,
  };
}

/** Run the simulation for an already-replayed household (§1). */
export function buildProjection(
  household: Household,
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
  return buildProjection(interpretLedger(ledger, base), base, jurisdiction);
}
