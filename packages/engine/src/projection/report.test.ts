import { describe, it, expect } from "vitest";
import { buildSimulationReport, summarizeSimulation } from "./report";
import { simulateHousehold, type HouseholdSimInput } from "./simulate";
import type { SimPerson } from "./simulate.types";
import { SimAccount, CAPITAL_GAINS_TAX_PROFILE } from "../simAccount";
import { SimCashFlowSeries, dollarsToCents } from "../cashFlowSeries";
import { nullJurisdiction } from "../jurisdiction";

function baseInput(overrides: Partial<HouseholdSimInput> = {}): HouseholdSimInput {
  const person: SimPerson = { id: "p1", name: "Alice", birthYear: 1991 };
  const acc = new SimAccount({
    id: "savings",
    ownerId: "p1",
    liquid: true,
    taxProfile: CAPITAL_GAINS_TAX_PROFILE,
    openingBalanceCents: dollarsToCents(10000),
    initialAnnualRate: 0,
  });
  return {
    horizonMonths: 12,
    annualInflationRate: 0.03,
    startYear: 2026,
    persons: [person],
    accounts: [acc],
    incomeSeries: [{ series: new SimCashFlowSeries(0, dollarsToCents(3000), { type: "fixed" }, { baselineUnit: "monthly" }), ownerId: "p1" }],
    expenseSeries: [{ series: new SimCashFlowSeries(0, dollarsToCents(2000), { type: "fixed" }, { baselineUnit: "monthly" }), ownerId: "p1" }],
    ...overrides,
  };
}

describe("buildSimulationReport", () => {
  it("emits one row per simulated month with year and age axes", () => {
    const report = buildSimulationReport(baseInput(), nullJurisdiction);
    expect(report.months).toHaveLength(13); // horizon 12 → months 0..12
    expect(report.months[0]).toMatchObject({ month: 0, year: 2026, ageByPerson: { p1: 35 } });
    // Month 12 rolls into the next calendar year → age ticks up.
    expect(report.months[12]).toMatchObject({ month: 12, year: 2027, ageByPerson: { p1: 36 } });
  });

  it("echoes the resolved inputs, incl. derived horizon and age", () => {
    const report = buildSimulationReport(baseInput(), nullJurisdiction);
    expect(report.inputs.annualInflationRate).toBe(0.03);
    expect(report.inputs.persons[0]).toMatchObject({ id: "p1", birthYear: 1991, ageAtStart: 35 });
    expect(report.inputs.accounts[0]).toMatchObject({ id: "savings", openingBalanceCents: dollarsToCents(10000) });
    expect(report.inputs.incomeSources[0].monthlyCentsAtStart).toBe(dollarsToCents(3000));
    expect(report.inputs).toMatchObject({ horizonMonths: 12, horizonYears: 1, startYear: 2026, endYear: 2027 });
  });

  it("echoes every growth rate: the raise rate, expense escalation, and account returns", () => {
    const report = buildSimulationReport(baseInput(), nullJurisdiction);
    // The fixture's series are `fixed`, so the rate is 0 — but the field is present
    // and the mode says WHY it is 0 (pinned flat, not "0% inflation this run").
    expect(report.inputs.incomeSources[0]).toMatchObject({
      annualGrowthRate: 0,
      growthMode: "fixed",
      growthSchedule: [{ startMonth: 0, annualRate: 0, mode: "fixed" }],
    });
    expect(report.inputs.expenseSources[0]).toMatchObject({ annualGrowthRate: 0, growthMode: "fixed" });
    expect(report.inputs.accounts[0].rateSchedule).toEqual([{ startMonth: 0, annualRate: 0 }]);
  });

  it("carries a raise rate through to the report, not just the opening amount", () => {
    const raise = new SimCashFlowSeries(0, dollarsToCents(3000), { type: "salaryCompound", annualRate: 0.04 }, {
      baselineUnit: "monthly",
    });
    const report = buildSimulationReport(
      baseInput({ incomeSeries: [{ series: raise, ownerId: "p1" }] }),
      nullJurisdiction,
    );
    expect(report.inputs.incomeSources[0]).toMatchObject({
      annualGrowthRate: 0.04,
      growthMode: "salaryCompound",
    });
  });

  it("reports a MID-RUN rate change, which a single opening rate would hide", () => {
    const raise = new SimCashFlowSeries(0, dollarsToCents(3000), { type: "salaryCompound", annualRate: 0.04 }, {
      baselineUnit: "monthly",
    });
    // A promotion at month 24 that also changes the ongoing raise rate.
    raise.addOverride(24, dollarsToCents(4000), "fromHereForward", {
      newGrowthMode: { type: "salaryCompound", annualRate: 0.06 },
    });
    const report = buildSimulationReport(
      baseInput({ horizonMonths: 36, incomeSeries: [{ series: raise, ownerId: "p1" }] }),
      nullJurisdiction,
    );
    // `annualGrowthRate` still reports month 0; the schedule carries the change.
    expect(report.inputs.incomeSources[0].annualGrowthRate).toBe(0.04);
    expect(report.inputs.incomeSources[0].growthSchedule).toEqual([
      { startMonth: 0, annualRate: 0.04, mode: "salaryCompound" },
      { startMonth: 24, annualRate: 0.06, mode: "salaryCompound" },
    ]);
  });

  it("resolves the benefit COLA rate, and says whether it was authored or inherited from CPI", () => {
    const inherited = buildSimulationReport(baseInput(), nullJurisdiction).inputs;
    expect(inherited).toMatchObject({ benefitColaRate: 0.03, benefitColaRateIsExplicit: false });

    const authored = buildSimulationReport(baseInput({ benefitColaRate: 0.02 }), nullJurisdiction).inputs;
    expect(authored).toMatchObject({ benefitColaRate: 0.02, benefitColaRateIsExplicit: true });
  });

  it("echoes caller-supplied meta verbatim (and omits it when absent)", () => {
    expect(buildSimulationReport(baseInput(), nullJurisdiction).meta).toBeUndefined();
    const meta = { plan: { lifeExpectancy: 90 }, jurisdictionId: "US-2026" };
    const report = buildSimulationReport(baseInput(), nullJurisdiction, meta);
    expect(report.meta).toEqual(meta);
  });

  it("carries the model's disclosed assumptions & simplifications (#94)", () => {
    const report = buildSimulationReport(baseInput(), nullJurisdiction);
    const ids = report.assumptions.map((a) => a.id);
    // The engine's neutral simplifications must reach the consumer so the app can disclose
    // them: the two post-tax basis ones (#94), plus how a committed account contribution is
    // funded (§12). Each carries plain-language text.
    expect(ids).toContain("postTaxOpeningBasis");
    expect(ids).toContain("convertedEquityNoBasis");
    expect(ids).toContain("contributionsNotAssetFunded");
    for (const a of report.assumptions) expect(a.text.length).toBeGreaterThan(0);
  });

  it("surfaces cash flows per month (month 0 flow-free; month 1 carries income and expenses)", () => {
    const report = buildSimulationReport(baseInput(), nullJurisdiction);
    expect(report.months[0].totalIncomeCents).toBe(0);
    expect(report.months[0].incomeByCategoryCents).toEqual({});

    const m1 = report.months[1];
    expect(m1.totalIncomeCents).toBe(dollarsToCents(3000));
    expect(m1.expensesCents).toBe(dollarsToCents(2000));
    expect(m1.governmentRetirementBenefitCents).toBe(0);
  });

  it("reports the tax the §5.3 seam charged, so it is inspectable and not just folded into take-home", () => {
    // The null jurisdiction taxes nothing — the row still exists, reading 0.
    expect(buildSimulationReport(baseInput(), nullJurisdiction).months[1].taxCents).toBe(0);

    // A flat 10% jurisdiction: $3,000 of wages → $300 of tax on the report row, and
    // the household is $300 poorer for it (income 3000 − expenses 2000 − tax 300).
    const flatTax = { ...nullJurisdiction, computeTaxCents: (byCategory: Record<string, number>) =>
      Math.round(Object.values(byCategory).reduce((s, c) => s + (c ?? 0), 0) * 0.1) };
    const report = buildSimulationReport(baseInput(), flatTax as typeof nullJurisdiction);
    expect(report.months[1].taxCents).toBe(dollarsToCents(300));
    expect(report.months[0].taxCents).toBe(0); // month 0 is flow-free (§4.6)
    expect(report.months[1].accountBalancesCents.savings).toBe(dollarsToCents(10000 + 700));
  });

  it("lists column keys for accounts and income categories", () => {
    const report = buildSimulationReport(baseInput(), nullJurisdiction);
    expect(report.columns.accountIds).toContain("savings");
    expect(report.columns.personIds).toEqual(["p1"]);
    expect(report.columns.incomeCategories).toContain("ordinaryIncome");
  });

  it("summarizeSimulation matches a report built from the same run", () => {
    const input = baseInput();
    const series = simulateHousehold(input, nullJurisdiction);
    const summarized = summarizeSimulation(input, series);
    expect(summarized.months.at(-1)?.netWorthNominalCents).toBe(
      series.months.at(-1)?.netWorthNominalCents,
    );
  });

  it("is JSON-serializable without loss", () => {
    const report = buildSimulationReport(baseInput(), nullJurisdiction);
    const roundTripped = JSON.parse(JSON.stringify(report));
    expect(roundTripped).toEqual(report);
  });

  it("appends the jurisdiction's own disclosures after the engine's neutral ones", () => {
    // A jurisdiction that declares its own simplifications gets them merged onto the
    // report — engine's neutral assumptions first, the jurisdiction's after — so a US
    // tax caveat rides `rules`, never the neutral engine (§5.0).
    const jurisdictionAssumption = { id: "j-specific", text: "A jurisdiction-specific caveat." };
    const withAssumptions = {
      ...nullJurisdiction,
      modelAssumptions: [jurisdictionAssumption],
    };
    const engineOnly = buildSimulationReport(baseInput(), nullJurisdiction).assumptions;
    const merged = buildSimulationReport(baseInput(), withAssumptions).assumptions;
    expect(merged).toEqual([...engineOnly, jurisdictionAssumption]);
    // The neutral engine list is unchanged when no jurisdiction assumptions are present.
    expect(engineOnly).not.toContainEqual(jurisdictionAssumption);
  });
});
