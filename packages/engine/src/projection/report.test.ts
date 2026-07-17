import { describe, it, expect } from "vitest";
import {
  buildSimulationReport,
  summarizeSimulation,
  SIMULATION_REPORT_VERSION,
} from "./report";
import { simulateHousehold, type HouseholdSimInput, type Person } from "./simulate";
import { Account, CAPITAL_GAINS_TAX_PROFILE } from "../account";
import { CashFlowSeries, dollarsToCents } from "../cashFlowSeries";
import { nullJurisdiction } from "../jurisdiction";

function baseInput(overrides: Partial<HouseholdSimInput> = {}): HouseholdSimInput {
  const person: Person = { id: "p1", name: "Alice", birthYear: 1991 };
  const acc = new Account({
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
    incomeSeries: [{ series: new CashFlowSeries(0, dollarsToCents(3000), { type: "fixed" }, { baselineUnit: "monthly" }), ownerId: "p1" }],
    expenseSeries: [{ series: new CashFlowSeries(0, dollarsToCents(2000), { type: "fixed" }, { baselineUnit: "monthly" }), ownerId: "p1" }],
    ...overrides,
  };
}

describe("buildSimulationReport", () => {
  it("emits one row per simulated month with year and age axes", () => {
    const report = buildSimulationReport(baseInput(), nullJurisdiction);
    expect(report.version).toBe(SIMULATION_REPORT_VERSION);
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

  it("echoes caller-supplied meta verbatim (and omits it when absent)", () => {
    expect(buildSimulationReport(baseInput(), nullJurisdiction).meta).toBeUndefined();
    const meta = { plan: { lifeExpectancy: 90 }, jurisdictionId: "US-2026" };
    const report = buildSimulationReport(baseInput(), nullJurisdiction, meta);
    expect(report.meta).toEqual(meta);
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
});
