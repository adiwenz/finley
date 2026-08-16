/**
 * **A household of two, and the estate the LAST of them leaves.**
 *
 * Two facts have to line up for a couple, and they are decided in different places. Which death
 * ends the household is {@link import("../job/personActiveWindow").memberHorizonReach}'s answer,
 * turned into `householdDeathMonthExclusive` by {@link
 * import("./buildHouseholdInput").buildHouseholdSimInput}; what the estate then owes is {@link
 * settleEstate}'s. The simulator settles only where the two coincide, so a partner who outlives
 * the primary must both extend the run AND be the death that licenses the settlement — get either
 * half wrong and a real death silently settles nothing at all, taking the retirement solver's
 * terminal test with it.
 *
 * The first death is not an ending. The survivor goes on being funded at full household cost, the
 * tax year the partner died in still closes in its own December and settles the following April,
 * and only the second death reaches the estate.
 */
import { describe, it, expect } from "vitest";
import { SimAccount, CASH_INTEREST_TAX_PROFILE, PRE_TAX_TAX_PROFILE } from "../plan/simAccount";
import { SimCashFlowSeries, dollarsToCents } from "../money/cashFlowSeries";
import type { Cents } from "../money/money";
import type { Jurisdiction } from "../jurisdiction/jurisdiction";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import { Projection } from "../index";
import { samplePlan, stateOf, SAMPLE_START_YEAR } from "../testing/samplePlan";
import {
  simulateHousehold,
  type HouseholdSimInput,
  type ProjectionSeries,
  type SimOwnedSeries,
} from "./simulate";
import type { SimPerson } from "./simulate.types";

const RATE = 0.25;

/** Flat 25%, scalar and breakdown rounded identically so the two reconcile. */
const flat25: Jurisdiction = {
  id: "flat-25",
  computeTaxCents: (byCat) => Math.round(((byCat.wages ?? 0) + (byCat.ordinaryIncome ?? 0)) * RATE),
  computeTaxByCategoryCents: (byCat) => {
    const out: Partial<Record<string, Cents>> = {};
    for (const category of ["wages", "ordinaryIncome"] as const) {
      const cents = byCat[category] ?? 0;
      if (cents > 0) out[category] = Math.round(cents * RATE);
    }
    return out;
  },
};

function account(id: string, ownerId: string, dollars: number, liquid = false): SimAccount {
  return new SimAccount({
    id,
    ownerId,
    liquid,
    taxProfile: liquid ? CASH_INTEREST_TAX_PROFILE : PRE_TAX_TAX_PROFILE,
    openingBalanceCents: dollarsToCents(dollars),
    initialAnnualRate: 0,
  });
}

/** Wages for one owner, ending where the series says — NOT where its owner dies. */
function wages(ownerId: string, monthlyDollars: number, endMonth?: number): SimOwnedSeries {
  return {
    series: new SimCashFlowSeries(0, dollarsToCents(monthlyDollars), { type: "fixed" }, {
      baselineUnit: "monthly",
      taxCategory: "wages",
      ...(endMonth !== undefined ? { endMonth } : {}),
    }),
    ownerId,
    sourceId: `job:${ownerId}`,
  };
}

function spending(monthlyDollars: number): SimOwnedSeries {
  return {
    series: new SimCashFlowSeries(0, dollarsToCents(monthlyDollars), { type: "fixed" }, {
      baselineUnit: "monthly",
    }),
    ownerId: "p1",
  };
}

/** A person who dies at `deathMonth` — the first month they are gone — or never. */
function person(id: string, deathMonth?: number): SimPerson {
  return {
    id,
    name: id,
    ...(deathMonth !== undefined
      ? { activeWindow: { startMonth: 0, endMonthExclusive: deathMonth } }
      : {}),
  };
}

/**
 * A two-person household whose LAST member dies at the horizon — the only shape that settles an
 * estate. `persons` carries each member's own window, so a partner may die long before it.
 */
function couple(
  horizonMonths: number,
  persons: SimPerson[],
  accounts: SimAccount[],
  overrides: Partial<HouseholdSimInput> = {},
): ProjectionSeries {
  return simulateHousehold(
    {
      horizonMonths,
      householdDeathMonthExclusive: horizonMonths,
      annualInflationRate: 0,
      startYear: 2026,
      persons,
      accounts,
      incomeSeries: [],
      expenseSeries: [],
      ...overrides,
    },
    flat25,
  );
}

const settlementOf = (series: ProjectionSeries) => {
  const settlement = series.estateSettlement;
  if (settlement === undefined) throw new Error("expected an estate settlement");
  return settlement;
};

describe("Estate settlement — a household of two", () => {
  it("settles once, at the last member's death, and not at the first", () => {
    // Sam dies at month 12; Alex lives to the horizon at month 36. One settlement, dated the final
    // month — the run does not end, and nothing is settled, when the first of them dies.
    const series = couple(
      36,
      [person("p1"), person("p2", 12)],
      [account("cash", "p1", 100_000, true)],
      { expenseSeries: [spending(1_000)] },
    );
    expect(series.months.length).toBe(36);
    expect(settlementOf(series).month).toBe(35);
  });

  it("counts the dead partner's own accounts as estate assets", () => {
    // Ownership does not follow a person out of the household: Sam's account is still household
    // wealth at the end, and an estate that dropped it would understate what the heirs receive.
    const series = couple(
      24,
      [person("p1"), person("p2", 6)],
      [account("cash", "p1", 40_000, true), account("sams-ira", "p2", 60_000)],
    );
    const settlement = settlementOf(series);
    expect(settlement.totalAssetsCents).toBe(dollarsToCents(100_000));
    expect(settlement.terminalEconomicNetWorthCents).toBe(dollarsToCents(100_000));
  });

  it("stops the dead partner's wages at their death, so the estate inherits nothing they never earned", () => {
    // The income series runs the whole horizon; the active window is what ends it. Sam is paid for
    // six months of a twelve-month run, so the household banks six — not twelve — of them.
    const paidTo = (deathMonth: number | undefined): Cents => {
      const series = couple(
        12,
        [person("p1"), person("p2", deathMonth)],
        [account("cash", "p1", 0, true)],
        { incomeSeries: [wages("p2", 1_000)] },
      );
      return settlementOf(series).totalAssetsCents;
    };
    const wholeYear = paidTo(undefined);
    const halfYear = paidTo(6);
    expect(wholeYear).toBe(dollarsToCents(12_000) - Math.round(dollarsToCents(12_000) * RATE));
    expect(halfYear).toBe(dollarsToCents(6_000) - Math.round(dollarsToCents(6_000) * RATE));
  });

  it("prices the final year's tax over BOTH members, including one who died inside it", () => {
    // Both die in the same tax year, Sam in July and Alex in November, so the year closes in
    // neither a December nor an April — `settleEstate` prices it. Sam's seven months of wages are
    // as taxable as Alex's eleven, and an estate that walked only the surviving member would
    // under-charge by Sam's whole share.
    //
    // No liquid account and no spending: nothing is drawn, so the year's only income is wages and
    // the estate's tax is exactly a quarter of them.
    const series = couple(
      23,
      [person("p1", 23), person("p2", 19)],
      [account("cash", "p1", 0, true)],
      { incomeSeries: [wages("p1", 1_000), wages("p2", 1_000)] },
    );
    const settlement = settlementOf(series);
    // Year 1 is months 12–22: Alex is paid all eleven, Sam months 12–18, seven of them.
    const finalYearLiabilityCents = Math.round(
      (dollarsToCents(11_000) + dollarsToCents(7_000)) * RATE,
    );
    const instalmentsPaidCents = series.months
      .slice(12)
      .reduce((total, m) => total + m.flows!.taxCents, 0);
    // The year's whole liability, over both of them, is instalments plus the estate's balance —
    // nothing of Sam's seven months goes uncharged just because Sam died in July.
    expect(instalmentsPaidCents + settlement.finalTaxDueCents).toBe(finalYearLiabilityCents);
    // And what is left over is exactly the twelfth instalment the run had no December to pay: the
    // estimate saw both members' years, Sam's death included, and priced eleven of the twelve.
    expect(settlement.finalTaxDueCents).toBe(Math.round(finalYearLiabilityCents / 12));
    // The estate is worse off by exactly that unpaid balance.
    expect(settlement.terminalEconomicNetWorthCents).toBe(
      settlement.totalAssetsCents - settlement.finalTaxDueCents,
    );
  });

  it("closes the dead partner's last tax year inside the household's life, not at the estate", () => {
    // Sam dies in October of year 0, having earned $40,000 that year. The first death is not an
    // ending, so that year closes in its OWN December and settles in its own April, out of the
    // surviving household — it is not carried a decade forward to the estate. Here it is settled
    // by the instalments alone: the year's estimate is a simulation of the year, so it already
    // knew Sam's wages stopped in September and paced the whole liability across the twelve.
    const series = couple(
      36,
      [person("p1"), person("p2", 10)],
      [account("cash", "p1", 100_000, true)],
      { incomeSeries: [wages("p2", 4_000, 9)] },
    );
    const yearZeroTaxCents = series.months
      .slice(0, 12)
      .reduce((total, m) => total + m.flows!.taxCents, 0);
    expect(yearZeroTaxCents).toBe(Math.round(dollarsToCents(40_000) * RATE));
    // Which leaves the following April nothing to charge…
    expect(series.months[15]!.flows!.taxCents).toBe(0);
    // …and the estate, dying two years later, no trace of the year Sam died in.
    expect(settlementOf(series).finalTaxDueCents).toBe(0);
  });
});

/**
 * The seam between the two decisions, exercised through the facade so the horizon really is
 * derived from the plan rather than handed to the simulator. The sample primary is 40 at 2026 with
 * an expectancy of 85, so they die at month 540.
 */
describe("Estate settlement — which death ends the household", () => {
  const PRIMARY_DEATH_MONTH = (85 - 40) * 12;

  function withPartner(birthYear: number, lifeExpectancy: number): ProjectionSeries {
    const projection = Projection.fromState(
      stateOf({ ...samplePlan, primary: { ...samplePlan.primary, jobs: [] }, budgetLines: [] }),
      nullJurisdiction,
    );
    projection.marry({ month: 12, name: "Sam", birthYear, lifeExpectancy });
    return projection.run(nullJurisdiction).series;
  }

  it("settles at the primary's death when the partner dies first", () => {
    // Sam, born 1976 at expectancy 85, dies in 2061 — fifteen years before the primary's 2071.
    // The primary's own death is what ends the household, and what the estate is dated to.
    const series = withPartner(1976, 85);
    expect(series.months.length).toBe(PRIMARY_DEATH_MONTH);
    expect(settlementOf(series).month).toBe(PRIMARY_DEATH_MONTH - 1);
  });

  it("runs on to the survivor and settles at THEIR death when the partner outlives the primary", () => {
    // Sam is born 1996 and reaches 85 in 2081, eleven years past the primary. Those eleven years
    // are inside the run, and the estate is settled at the end of them — the case where taking the
    // primary's death as the household's would settle early and leave the survivor unmodelled.
    const series = withPartner(1996, 85);
    const samsDeathMonth = (1996 + 85 - SAMPLE_START_YEAR) * 12;
    expect(samsDeathMonth).toBeGreaterThan(PRIMARY_DEATH_MONTH);
    expect(series.months.length).toBe(samsDeathMonth);
    expect(settlementOf(series).month).toBe(samsDeathMonth - 1);
  });

  it("settles when both die in the same month, which is one ending and not two", () => {
    // Same birth year and expectancy as the primary: one death month, reached once, settled once.
    const series = withPartner(SAMPLE_START_YEAR - 40, 85);
    expect(series.months.length).toBe(PRIMARY_DEATH_MONTH);
    expect(settlementOf(series).month).toBe(PRIMARY_DEATH_MONTH - 1);
  });
});
