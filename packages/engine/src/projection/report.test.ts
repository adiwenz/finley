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

  it("carries the model's disclosed assumptions & simplifications", () => {
    const report = buildSimulationReport(baseInput(), nullJurisdiction);
    const ids = report.assumptions.map((a) => a.id);
    // The engine's neutral simplifications must reach the consumer so the app can disclose
    // them: the post-tax opening-basis one, plus how a committed account contribution is
    // funded. Each carries plain-language text.
    expect(ids).toContain("postTaxOpeningBasis");
    expect(ids).toContain("contributionsNotAssetFunded");
    // The down-payment affordability check estimates the capital-gains tax standalone.
    expect(ids).toContain("downPaymentAffordabilityTaxEstimate");
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

  it("reports the tax the jurisdiction seam charged, so it is inspectable and not just folded into take-home", () => {
    // The null jurisdiction taxes nothing — the row still exists, reading 0.
    expect(buildSimulationReport(baseInput(), nullJurisdiction).months[1].taxCents).toBe(0);

    // A flat 10% jurisdiction: $3,000 of wages → $300 of tax on the report row, and
    // the household is $300 poorer for it (income 3000 − expenses 2000 − tax 300).
    const flatTax = {
      ...nullJurisdiction,
      computeTaxCents: (byCategory: Record<string, number>) =>
        Math.round(Object.values(byCategory).reduce((s, c) => s + (c ?? 0), 0) * 0.1),
      // Matching per-source breakdown (attribution contract): each category taxed 10%.
      computeTaxByCategoryCents: (byCategory: Record<string, number>) => {
        const out: Record<string, number> = {};
        for (const [cat, cents] of Object.entries(byCategory)) {
          const t = Math.round((cents ?? 0) * 0.1);
          if (t) out[cat] = t;
        }
        return out;
      },
    };
    const report = buildSimulationReport(baseInput(), flatTax as typeof nullJurisdiction);
    expect(report.months[1].taxCents).toBe(dollarsToCents(300));
    expect(report.months[0].taxCents).toBe(0); // month 0 is flow-free
    expect(report.months[1].accountBalancesCents.savings).toBe(dollarsToCents(10000 + 700));
  });

  it("lists column keys for accounts and income categories", () => {
    const report = buildSimulationReport(baseInput(), nullJurisdiction);
    expect(report.columns.accountIds).toContain("savings");
    expect(report.columns.personIds).toEqual(["p1"]);
    expect(report.columns.incomeCategories).toContain("ordinaryIncome");
  });

  it("carries the jurisdiction's per-category tax breakdown, summing to taxCents", () => {
    // A jurisdiction that both taxes AND splits: a flat 10% total, attributed half to
    // wages and half to ordinaryIncome. The report must carry the split, and its Σ must
    // equal the scalar `taxCents` the take-home already used — the invariant.
    const splittingTax = {
      ...nullJurisdiction,
      computeTaxCents: (byCategory: Record<string, number>) =>
        Math.round(Object.values(byCategory).reduce((s, c) => s + (c ?? 0), 0) * 0.1),
      computeTaxByCategoryCents: (byCategory: Record<string, number>) => {
        const total = Math.round(Object.values(byCategory).reduce((s, c) => s + (c ?? 0), 0) * 0.1);
        const half = Math.round(total / 2);
        return { wages: half, ordinaryIncome: total - half };
      },
    };
    const report = buildSimulationReport(baseInput(), splittingTax as typeof nullJurisdiction);
    const m1 = report.months[1];
    expect(m1.taxCents).toBe(dollarsToCents(300));
    expect(m1.taxByCategoryCents).toBeDefined();
    const split = m1.taxByCategoryCents!;
    const sum = Object.values(split).reduce((s: number, c) => s + (c ?? 0), 0);
    expect(sum).toBe(m1.taxCents);
    // The union of categories is exposed for the stacked-chart column layout.
    expect(report.columns.taxCategories).toEqual(expect.arrayContaining(["wages", "ordinaryIncome"]));
  });

  it("splits the tax by income SOURCE, naming each job and summing to taxCents", () => {
    // Two jobs for one person; a wages-taxing jurisdiction that reports the per-category
    // breakdown. The engine attributes the wages tax down to each job by taxable weight.
    const mkJob = (cents: number) =>
      new SimCashFlowSeries(0, cents, { type: "fixed" }, { baselineUnit: "monthly", taxCategory: "wages" });
    const wagesTax = {
      ...nullJurisdiction,
      computeTaxCents: (byCategory: Record<string, number>) => Math.round((byCategory.wages ?? 0) * 0.1),
      computeTaxByCategoryCents: (byCategory: Record<string, number>) => {
        const t = Math.round((byCategory.wages ?? 0) * 0.1);
        return t > 0 ? { wages: t } : {};
      },
    };
    const report = buildSimulationReport(
      baseInput({
        incomeSeries: [
          { series: mkJob(dollarsToCents(4000)), ownerId: "p1", sourceId: "job-a" },
          { series: mkJob(dollarsToCents(2000)), ownerId: "p1", sourceId: "job-b" },
        ],
      }),
      wagesTax as typeof nullJurisdiction,
    );
    const m1 = report.months[1];
    // $6000 taxable wages → $600 tax, split 4000:2000 → $400 / $200.
    expect(m1.taxBySourceCents).toEqual({ "job-a": dollarsToCents(400), "job-b": dollarsToCents(200) });
    const sum = Object.values(m1.taxBySourceCents!).reduce((s: number, c) => s + (c ?? 0), 0);
    expect(sum).toBe(m1.taxCents);
    // The union of tax-bearing sources is exposed for the per-job chart's columns.
    expect(report.columns.taxSources).toEqual(expect.arrayContaining(["job-a", "job-b"]));
  });

  it("reports an empty breakdown for a zero-tax jurisdiction (nothing to attribute)", () => {
    // The null jurisdiction charges no tax, so its required breakdown is `{}` on every flowed
    // month (empty, not absent — absent belongs only to the flow-free month 0), and the column
    // unions are empty.
    const report = buildSimulationReport(baseInput(), nullJurisdiction);
    for (const m of report.months) {
      const flowed = m.taxByCategoryCents !== undefined; // month 0 carries no flows at all
      if (flowed) {
        expect(m.taxByCategoryCents).toEqual({});
        expect(m.taxBySourceCents).toEqual({});
      } else {
        expect(m.taxBySourceCents).toBeUndefined();
      }
    }
    expect(report.columns.taxCategories).toEqual([]);
    expect(report.columns.taxSources).toEqual([]);
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
    // tax caveat rides `rules`, never the neutral engine.
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
