/**
 * Bridge the replay-derived household into the simulator's input, then run it.
 *
 * Series arrive already materialized from replay; liabilities and account outflows are
 * instantiated here, at the simulation boundary. Projection and snapshot read the same
 * {@link Household}, so they cannot disagree.
 */

import type { Jurisdiction } from "../jurisdiction/jurisdiction";
import { AmortizingLoan, RevolvingCard, type SimLiability } from "../liability/liability";
import { growthAnnualRate } from "../money/cashFlowSeries";
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
import { compilePerson } from "../compile/compilePerson";
import {
  lifeExpectancyEndMonthExclusive,
  memberHorizonReach,
  membershipWindow,
  type JobResolutionScope,
} from "../job/householdJob";
import { PRIMARY_PERSON_ID } from "../compile/projectionBase";

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
      // amount; a health or event series carries none.
      expenseSeries.push({
        series: s.series,
        ownerId: s.ownerId,
        label: s.label,
        ...(s.lineId !== undefined ? { lineId: s.lineId } : {}),
        // …and its obligation provenance, so the month's cost is built into an obligation.
        ...(s.obligationSource !== undefined ? { obligationSource: s.obligationSource } : {}),
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
  const accounts = (base.initialAccounts ?? []).map(({ sim: acc }) => {
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
    // Carried so the simulator can suppress this property and its mortgage when the down-payment
    // draw for the same event blocks — the linkage the block decision matches on.
    causedByEventId: p.causedByEventId,
    mortgageLiabilityId: p.mortgageLiabilityId,
  }));

  // Everyone who ever joined; membership intervals govern each person's income series
  // lifetime. Authoring {@link Person}s are compiled to {@link SimPerson} here, at the
  // boundary, so the pre-"now" covered-earnings record is derived from the jobs rather than
  // baked into the roster. `startYear` is the frozen "now" the base was built against; the
  // default keeps a startYear-less test base from throwing.
  const nowYear = base.startYear ?? 0;
  // The same question the income series was compiled under, asked once more. A solve carries a
  // candidate boundary, and the person whose job it continues worked the years that continuation
  // implies — including any before "now", which is where the covered-earnings record lives. Left
  // authored when there is no hypothesis, which is every ordinary run.
  const scope: JobResolutionScope =
    base.stopWorking === undefined
      ? { kind: "authored" }
      : { kind: "hypothetical", stopWorking: base.stopWorking };
  // The membership window rides along: the income series were clipped to it up here, but a
  // government benefit is derived inside the sim and would otherwise be paid to a household the
  // person has left.
  // Each member resolved once: their household window (start..separation) and the month their own
  // life ends. Every member states their own expectancy, so nothing is inherited here — the
  // primary's is a default applied at `marry`, not a value read through to. The life-end bounds
  // the government benefit inside the sim; it never touches a wage, which ends where the job was
  // authored to.
  //
  // A life-end is a birth year plus an age placed on the calendar, so it needs a real frozen
  // "now". A base without `startYear` has none — only a hand-built test base is ever in that
  // state — and reckoning against the `0` the job compiler falls back to would put a member's
  // death two thousand years out and drag the horizon there. Unbounded is the honest answer:
  // no member bounds a benefit or extends the run when there is no calendar to place them on.
  const lifeEndOf = (person: Household["memberships"][number]["person"]) =>
    base.startYear === undefined
      ? Number.POSITIVE_INFINITY
      : lifeExpectancyEndMonthExclusive(person, base.startYear);
  const resolvedMembers = household.memberships.map((m) => ({
    memberWindow: membershipWindow(m),
    lifeEnd: lifeEndOf(m.person),
    separationMonth: m.endMonth,
    person: m.person,
  }));
  // The other half of "while both are alive" — see {@link memberHorizonReach}. Absent only for a
  // hand-built base holding no primary, where nothing is reckonable anyway.
  const primaryLifeEnd =
    resolvedMembers.find((r) => r.person.id === PRIMARY_PERSON_ID)?.lifeEnd ??
    Number.POSITIVE_INFINITY;

  const persons: SimPerson[] = resolvedMembers.map((r) =>
    compilePerson(r.person, nowYear, scope, r.memberWindow, r.lifeEnd),
  );

  // The horizon is the longest-lived member's reach, not the primary's: a member present to their
  // death contributes their expectancy month, covering their tail. Whether a separation takes that
  // claim away is {@link memberHorizonReach}'s single answer, shared with `horizonAnchorOf` so the
  // run and the sentence the panel prints about it cannot diverge.
  //
  // `base.horizonMonths` (the primary's) is the floor, so a shorter-lived member can only fail to
  // raise it, never shorten the run.
  const horizonMonths = resolvedMembers.reduce((reach, r) => {
    const memberReach = memberHorizonReach(r.lifeEnd, r.separationMonth, primaryLifeEnd);
    return memberReach === null ? reach : Math.max(reach, memberReach);
  }, base.horizonMonths);

  return {
    horizonMonths,
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

export function replayLedger(
  ledger: Ledger,
  base: LedgerBaseConfig,
  jurisdiction: Jurisdiction,
): ProjectionSeries {
  return buildProjection(interpretLedger(ledger, base), base, jurisdiction);
}
