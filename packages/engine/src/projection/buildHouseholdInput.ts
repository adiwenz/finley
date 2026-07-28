/**
 * Bridge the replay-derived household into the simulator's input, then run it.
 *
 * Series arrive already materialized from replay; liabilities and account outflows are
 * instantiated here, at the simulation boundary. Projection and snapshot read the same
 * {@link Household}, so they cannot disagree.
 */

import type { Jurisdiction } from "../jurisdiction";
import { AmortizingLoan, RevolvingCard, type SimLiability } from "../liability";
import { growthAnnualRate } from "../cashFlowSeries";
import {
  simulateHousehold,
  type HouseholdSimInput,
  type SimOwnedSeries,
  type ProjectionSeries,
  type SimProperty,
} from "./simulate";
import type { SimPerson } from "./simulate.types";
import type { LedgerBaseConfig } from "../ledger/ledgerBase";
import type { Household } from "../ledger/household";
import { interpretLedger } from "../ledger/interpret";
import type { Ledger } from "../ledger/ledger";
import { compilePerson } from "../compilePerson";

export function buildHouseholdSimInput(
  household: Household,
  base: LedgerBaseConfig,
): HouseholdSimInput {
  const incomeSeries: SimOwnedSeries[] = [];
  const expenseSeries: SimOwnedSeries[] = [];
  for (const s of household.series) {
    if (s.seriesType === "income") {
      // Keep the plan descriptor so plan-bearing income defers pre-tax in the waterfall;
      // expenses never carry one.
      incomeSeries.push({
        series: s.series,
        ownerId: s.ownerId,
        label: s.label,
        ...(s.sourceId !== undefined ? { sourceId: s.sourceId } : {}),
        planDescriptor: s.planDescriptor,
      });
    } else {
      // Keep the budget-line provenance so the simulator can report each line's monthly
      // amount; a scalar/health series carries none.
      expenseSeries.push({
        series: s.series,
        ownerId: s.ownerId,
        label: s.label,
        ...(s.lineId !== undefined ? { lineId: s.lineId } : {}),
        // …and its spending provenance, so the month's cost is reported itemized.
        ...(s.spendingSource !== undefined ? { spendingSource: s.spendingSource } : {}),
      });
    }
  }

  const liabilities = household.liabilities.map((def): SimLiability => {
    // Discriminated on kind, so each SimLiability subclass is built from exactly the fields
    // its kind carries — no optional-field juggling or null-bridging at the sim boundary.
    const liab: SimLiability =
      def.kind === "creditCard"
        ? new RevolvingCard({
            id: def.id,
            ownerId: def.ownerId,
            openingBalanceCents: def.openingBalanceCents,
            startMonth: def.startMonth,
            apr: def.apr,
            creditLimitCents: def.creditLimitCents,
          })
        : new AmortizingLoan({
            id: def.id,
            ownerId: def.ownerId,
            kind: def.kind,
            openingBalanceCents: def.openingBalanceCents,
            startMonth: def.startMonth,
            apr: def.apr,
            termMonths: def.termMonths,
          });
    for (const t of def.transfers) {
      liab.addTransfer({ month: t.month, amountCents: t.amountCents });
    }
    return liab;
  });

  // Attach payoff outflows to their accounts without discarding account state.
  const accounts = (base.initialAccounts ?? []).map((acc) => {
    const transfers = household.accountTransfers
      .filter((t) => t.accountId === acc.id)
      .map((t) => ({ month: t.month, amountCents: t.amountCents }));
    return transfers.length > 0 ? acc.withAdditionalTransfers(transfers) : acc;
  });

  // Resolve each growth mode to its annual rate here, at the sim boundary; the simulator
  // compounds property value as it compounds accounts.
  const properties: SimProperty[] = household.properties.map((p) => ({
    id: p.id,
    ownerId: p.ownerId,
    startMonth: p.startMonth,
    endMonth: p.endMonth,
    openingValueCents: p.openingValueCents,
    appreciationAnnualRate: growthAnnualRate(p.appreciationMode),
  }));

  // Everyone who ever joined; membership intervals govern each person's income series
  // lifetime. Authoring {@link Person}s are compiled to {@link SimPerson} here, at the
  // boundary, so the pre-"now" covered-earnings record is derived from the jobs rather than
  // baked into the roster. `startYear` is the frozen "now" the base was built against; the
  // default keeps a startYear-less test base from throwing.
  const nowYear = base.startYear ?? 0;
  const persons: SimPerson[] = household.memberships.map((m) =>
    compilePerson(m.person, nowYear, base.annualInflationRate),
  );

  return {
    horizonMonths: base.horizonMonths,
    annualInflationRate: base.annualInflationRate,
    benefitColaRate: base.benefitColaRate,
    startYear: base.startYear,
    persons,
    accounts,
    incomeSeries,
    expenseSeries,
    liabilities: liabilities.length > 0 ? liabilities : undefined,
    properties: properties.length > 0 ? properties : undefined,
    // Ordered draws, resolved against source balances at their month: the per-source split is
    // balance-dependent.
    fundingDraws: household.fundingDraws.length > 0 ? household.fundingDraws : undefined,
    // Waterfall config lives on the value-editing surface, so it rides on the base rather
    // than being derived from events.
    goals: base.goals,
    // Rides on the base like goals, and funds its accounts in the waterfall each month.
    contributionLines: base.contributionLines,
    sharedScheme: base.sharedScheme,
    surplusDestination: base.surplusDestination,
  };
}

export function buildProjection(
  household: Household,
  base: LedgerBaseConfig,
  jurisdiction: Jurisdiction,
): ProjectionSeries {
  return simulateHousehold(buildHouseholdSimInput(household, base), jurisdiction);
}

/** Replay the ledger and project in one call, through a single interpreter. */
export function replayLedger(
  ledger: Ledger,
  base: LedgerBaseConfig,
  jurisdiction: Jurisdiction,
): ProjectionSeries {
  return buildProjection(interpretLedger(ledger, base), base, jurisdiction);
}
