import { describe, it, expect } from "vitest";
import { buildSimulationReport, summarizeSimulation } from "./report";
import { simulateHousehold, type HouseholdSimInput } from "./simulate";
import type { SimPerson } from "./simulate.types";
import { SimAccount, CAPITAL_GAINS_TAX_PROFILE } from "../plan/simAccount";
import { SimCashFlowSeries, dollarsToCents } from "../money/cashFlowSeries";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";

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
    const report = buildSimulationReport(baseInput({ horizonMonths: 13 }), nullJurisdiction);
    expect(report.months).toHaveLength(13); // horizon 13 → processed months 0..12
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
    // The fixture's series are `fixed`, so the rate is 0 — the mode says WHY (pinned flat,
    // not "0% inflation this run").
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
    // The engine's neutral simplifications must reach the consumer to be disclosed:
    // post-tax opening basis, plus how a committed account contribution is funded. Each
    // carries plain-language text.
    expect(ids).toContain("postTaxOpeningBasis");
    expect(ids).toContain("contributionsNotAssetFunded");
    for (const a of report.assumptions) expect(a.text.length).toBeGreaterThan(0);
  });

  it("surfaces cash flows per month — every row is a processed month, month 0 included", () => {
    const report = buildSimulationReport(baseInput(), nullJurisdiction);
    // The flow-free snapshot now rides `series.opening`, outside the report; months[0] is the
    // first processed month and carries the same income/expenses as any other.
    const m0 = report.months[0];
    expect(m0.totalIncomeCents).toBe(dollarsToCents(3000));
    expect(m0.expensesCents).toBe(dollarsToCents(2000));
    expect(m0.governmentRetirementBenefitCents).toBe(0);
  });

  it("reports the tax the jurisdiction seam charged, so it is inspectable and not just folded into take-home", () => {
    // The null jurisdiction taxes nothing — the row still exists, reading 0.
    expect(buildSimulationReport(baseInput(), nullJurisdiction).months[0].taxCents).toBe(0);

    // Flat 10%: $3,000 of wages → $300 of tax on the row, and the household is $300 poorer
    // (income 3000 − expenses 2000 − tax 300).
    const flatTax = {
      ...nullJurisdiction,
      computeTaxCents: (byCategory: Record<string, number>) =>
        Math.round(Object.values(byCategory).reduce((s, c) => s + (c ?? 0), 0) * 0.1),
      // Matching breakdown (the attribution contract): each category taxed 10%.
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
    // Month 0 is now a processed, taxed month: $300 tax, and savings up $700 after its flows.
    expect(report.months[0].taxCents).toBe(dollarsToCents(300));
    expect(report.months[0].accountBalancesCents.savings).toBe(dollarsToCents(10000 + 700));
  });

  it("lists column keys for accounts and income categories", () => {
    const report = buildSimulationReport(baseInput(), nullJurisdiction);
    expect(report.columns.accountIds).toContain("savings");
    expect(report.columns.personIds).toEqual(["p1"]);
    expect(report.columns.incomeCategories).toContain("ordinaryIncome");
  });

  it("carries the jurisdiction's per-category tax breakdown, summing to taxCents", () => {
    // A jurisdiction that taxes AND splits: flat 10%, half to wages, half to ordinaryIncome.
    // The report carries the split, and its Σ must equal the scalar `taxCents` take-home
    // already used — the invariant.
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
    // Two jobs for one person, a wages-taxing jurisdiction reporting the per-category
    // breakdown. The engine attributes the wages tax to each job by taxable weight.
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
    // No tax charged, so the required breakdown is `{}` on every flowed month — empty, not
    // absent; absent belongs only to the flow-free month 0 — and the column unions are empty.
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

  it("charges payroll tax on wages and accumulates it across the year so a wage cap binds", () => {
    // A synthetic FICA: 10% of year-to-date wages, capped at the first $12,000. Wages are
    // $3,000/mo, so the cap is reached after month 3 and no more is charged from month 4 on.
    const mkWages = (cents: number) =>
      new SimCashFlowSeries(0, cents, { type: "fixed" }, { baselineUnit: "monthly", taxCategory: "wages" });
    const cappedPayroll = (byCategory: Record<string, number>) =>
      Math.round(Math.min(byCategory.wages ?? 0, dollarsToCents(12000)) * 0.1);
    const cappedFica = {
      ...nullJurisdiction,
      computePayrollTaxCents: cappedPayroll,
      // Required companion (runtime-enforced): single earned category, so trivial.
      computePayrollTaxByCategoryCents: (byCategory: Record<string, number>) => {
        const charge = cappedPayroll(byCategory);
        return charge > 0 ? { wages: charge } : {};
      },
    };
    const report = buildSimulationReport(
      baseInput({ incomeSeries: [{ series: mkWages(dollarsToCents(3000)), ownerId: "p1" }] }),
      cappedFica as typeof nullJurisdiction,
    );
    // Months 0..3: 10% of each $3,000 slice under the cap = $300. Month 4 onward: the
    // year-to-date total is already at the $12,000 cap, so the difference charged is 0 —
    // proving the seam is fed CUMULATIVE, not annualized-monthly, earnings.
    expect(report.months[0].payrollTaxCents).toBe(dollarsToCents(300));
    expect(report.months[3].payrollTaxCents).toBe(dollarsToCents(300));
    expect(report.months[4].payrollTaxCents).toBe(0);
    expect(report.months[11].payrollTaxCents).toBe(0);
    // Every dollar charged is attributed to the wage source that generated it.
    const attributed = Object.values(report.months[0].payrollTaxBySourceCents ?? {}).reduce(
      (s, v) => s + v,
      0,
    );
    expect(attributed).toBe(report.months[0].payrollTaxCents);
  });

  it("charges no payroll tax on non-wage income (e.g. a retirement-account withdrawal, ordinaryIncome)", () => {
    // baseInput's income series carries no taxCategory → defaults to ordinaryIncome, the
    // withdrawal category. A wages-only FICA seam must leave it untouched.
    const wagesOnlyPayroll = (byCategory: Record<string, number>) =>
      Math.round((byCategory.wages ?? 0) * 0.0765);
    const wagesOnlyFica = {
      ...nullJurisdiction,
      computePayrollTaxCents: wagesOnlyPayroll,
      computePayrollTaxByCategoryCents: (byCategory: Record<string, number>) => {
        const charge = wagesOnlyPayroll(byCategory);
        return charge > 0 ? { wages: charge } : {};
      },
    };
    const report = buildSimulationReport(baseInput(), wagesOnlyFica as typeof nullJurisdiction);
    for (const m of report.months) expect(m.payrollTaxCents).toBe(0);
  });

  it("reconciles Σ per-source netCashFlowCents to aggregate income minus income tax, payroll tax, and total deferrals — including a source with pre-tax deferrals", () => {
    // A wage source deferring 10% pre-tax, an income-tax seam, and a FICA seam together: the
    // sum of every reported source's netCashFlowCents must equal totalIncome minus income
    // tax, payroll tax, AND the deferral — none of the three haircuts may be dropped or
    // double-counted at the per-source level. The deferral matters here because payroll tax
    // is charged on the FULL pre-deferral gross while income tax is charged on the
    // post-deferral taxable amount, so a source carrying both a deferral and payroll tax is
    // the sharpest reconciliation check.
    const mkWages = (cents: number) =>
      new SimCashFlowSeries(0, cents, { type: "fixed" }, { baselineUnit: "monthly", taxCategory: "wages" });
    const incomeTax20 = (byCategory: Record<string, number>) =>
      Math.round(Object.values(byCategory).reduce((s, v) => s + (v ?? 0), 0) * 0.2);
    const payroll765 = (byCategory: Record<string, number>) =>
      Math.round((byCategory.wages ?? 0) * 0.0765);
    const jurisdiction = {
      ...nullJurisdiction,
      computeTaxCents: incomeTax20,
      computeTaxByCategoryCents: (byCategory: Record<string, number>) => {
        const t = incomeTax20(byCategory);
        return t > 0 ? { wages: t } : {};
      },
      computePayrollTaxCents: payroll765,
      computePayrollTaxByCategoryCents: (byCategory: Record<string, number>) => {
        const charge = payroll765(byCategory);
        return charge > 0 ? { wages: charge } : {};
      },
    };
    const series = simulateHousehold(
      baseInput({
        incomeSeries: [
          {
            series: mkWages(dollarsToCents(5000)),
            ownerId: "p1",
            sourceId: "job",
            // Deferred pre-tax into the existing "savings" account — no new account needed.
            planDescriptor: { deferralFraction: 0.1, fundAccountId: "savings" },
          },
        ],
      }),
      jurisdiction as typeof nullJurisdiction,
    );
    const month0 = series.months[0].flows!;
    const netFromSources = month0.incomeSources.reduce((s, src) => s + src.netCashFlowCents, 0);
    const totalDeferralCents = Object.values(month0.deferralBySourceCents ?? {}).reduce(
      (s, v) => s + v,
      0,
    );
    expect(totalDeferralCents).toBeGreaterThan(0); // sanity: the deferral is actually exercised
    expect(netFromSources).toBe(
      month0.totalIncomeCents - month0.taxCents - month0.payrollTaxCents - totalDeferralCents,
    );
  });

  it("appends the jurisdiction's own disclosures after the engine's neutral ones", () => {
    // A jurisdiction's own simplifications merge onto the report after the engine's neutral
    // ones, so a US tax caveat rides `rules`, never the neutral engine.
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
