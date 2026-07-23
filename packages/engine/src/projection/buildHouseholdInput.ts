/**
 * Bridge the replay-derived household into the simulator's input, then run it.
 *
 * Series arrive already materialized (one `SimCashFlowSeries` each, built in
 * replay); liabilities and account outflows are instantiated *here*, at the
 * simulation boundary, from immutable data (§5). Both projection and snapshot
 * read the same {@link Household}, so they cannot disagree (§1, §14).
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
      // Preserve the §5.5 plan descriptor so plan-bearing income defers pre-tax
      // in the waterfall; expenses never carry one.
      incomeSeries.push({
        series: s.series,
        ownerId: s.ownerId,
        label: s.label,
        planDescriptor: s.planDescriptor,
      });
    } else {
      // Preserve the budget-line provenance (§Q27) so the simulator can report each
      // line's monthly amount; a scalar/health expense series carries none.
      expenseSeries.push({
        series: s.series,
        ownerId: s.ownerId,
        label: s.label,
        ...(s.lineId !== undefined ? { lineId: s.lineId } : {}),
      });
    }
  }

  const liabilities = household.liabilities.map((def): SimLiability => {
    // The derived liability is a discriminated union on kind, so each SimLiability
    // subclass is constructed from exactly the fields its kind carries — no
    // optional-field juggling, no null-bridging at the sim boundary (§5).
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

  // Durable household roster (§3): membership intervals govern each person's income
  // series lifetime; the roster itself is the set of people who ever joined. The roster
  // holds authoring {@link Person}s (§8) — compile each to the {@link SimPerson} the sim
  // consumes here, at the boundary, so the pre-"now" covered-earnings record (§4.6) is
  // derived from the jobs rather than baked into the roster. `startYear` is the frozen
  // "now" the base was built against; the ambient default keeps a startYear-less test base
  // (no benefit basis intended) from throwing.
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
    // §5.0 waterfall config lives on the value-editing surface (§10.2), not the
    // ledger, so it rides along on the base rather than being derived from events.
    goals: base.goals,
    // Standing account-contribution lines (§12) ride on the base like goals — value-plane
    // data, not ledger-derived — and fund their accounts in the waterfall each month.
    contributionLines: base.contributionLines,
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
