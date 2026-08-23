/**
 * The surplus/shortfall line, held to its definition: EXTERNAL income less taxes and spending,
 * measured before any account is opened to cover the gap.
 *
 * The failure mode this exists to catch is silent. An account is drawn precisely because the
 * month came up short, so a chart that counts the draw as income nets every shortfall to
 * approximately zero — and a retiree burning through savings reads as comfortably breaking even.
 * Which account funds the retirement must not change the shape of the answer, and the engine's
 * tax categories cannot tell you: an elective pre-tax draw, a required distribution and a
 * freelance series are all `ordinaryIncome`.
 *
 * Two households run end to end, identical but for where retirement's money comes from — one
 * from a pre-tax 401(k), one from after-tax cash. The invariants below hold for both.
 */

import { describe, expect, it } from "vitest";
import { Projection, dollarsToCents, type ProjectionMonth, type ScenarioInput } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { presetById } from "./presets";
import { buildCashFlowChartData } from "./components/baseAdjustments/cashFlowChartData";

/** Funds retirement out of a pre-tax 401(k): every dollar drawn is taxable income. */
const IRA_FUNDED = presetById("taxed-in-retirement").input;

/**
 * The same household funding the same retirement out of after-tax cash instead — the deferral
 * dropped so nothing accumulates pre-tax, and an opening balance large enough to carry the years
 * between the last paycheck and life expectancy.
 */
const CASH_FUNDED: ScenarioInput = (() => {
  const [job] = IRA_FUNDED.jobs!;
  const { deferral: _deferral, ...withoutDeferral } = job as typeof job & { deferral?: unknown };
  return {
    ...IRA_FUNDED,
    name: "Rowan",
    jobs: [withoutDeferral as typeof job],
    openingBalanceCents: dollarsToCents(700_000),
  };
})();

function run(input: ScenarioInput) {
  const built = Projection.fromInput(input, usJurisdiction);
  if (!built.ok) throw new Error(`fixture is not a valid ScenarioInput: ${built.error.reason}`);
  const series = built.projection.run(usJurisdiction).series;
  return { series, data: buildCashFlowChartData(series) };
}

const RUNS = [
  { id: "IRA-funded", ...run(IRA_FUNDED) },
  { id: "cash-funded", ...run(CASH_FUNDED) },
];

/** No wages: the household is living on a benefit and whatever it has put by. */
const isRetired = (m: ProjectionMonth): boolean =>
  (m.flows?.incomeSources ?? []).every((s) => s.category !== "wages");

/** Tax the month really paid: withholding, FICA, and a settlement only where it was a BILL. */
const taxPaidCents = (f: NonNullable<ProjectionMonth["flows"]>): number =>
  f.taxCents - f.taxSettlementCents + f.payrollTaxCents + Math.max(0, f.taxSettlementCents);

const obligationsCents = (f: NonNullable<ProjectionMonth["flows"]>): number =>
  f.obligations.reduce((sum, o) => sum + o.amountCents, 0);

/** Money from OUTSIDE the household: wages, benefits, a refund — never an account. */
const externalIncomeCents = (f: NonNullable<ProjectionMonth["flows"]>): number =>
  f.incomeSources
    .filter((s) => s.fromAccountWithdrawal !== true && s.category !== "savingsInterest")
    .reduce((sum, s) => sum + s.cashInflowCents, 0) + Math.max(0, -f.taxSettlementCents);

describe.each(RUNS)("$id retirement — the surplus/shortfall line", ({ id, series, data }) => {
  const rowAt = new Map(data.rows.map((r) => [r.month, r] as const));
  const retiredMonths = series.months.filter((m) => m.flows !== undefined && isRetired(m));

  it("reaches retirement at all, so the rest of these are measuring something", () => {
    expect(retiredMonths.length).toBeGreaterThan(24);
  });

  it("bands no account withdrawal as income, in any month", () => {
    const banded: string[] = [];
    for (const m of series.months) {
      const row = rowAt.get(m.month);
      if (row === undefined) continue;
      for (const s of m.flows!.incomeSources) {
        if (s.fromAccountWithdrawal !== true) continue;
        if ((row.inflowCentsByBand[s.sourceId] ?? 0) !== 0) {
          banded.push(`${id} · month ${m.month} · ${s.sourceId}`);
        }
      }
    }
    expect(banded).toEqual([]);
  });

  it("measures external income less taxes and spending, to the cent, in every month", () => {
    const wrong: string[] = [];
    for (const m of series.months) {
      const f = m.flows;
      const row = rowAt.get(m.month);
      if (f === undefined || row === undefined) continue;
      const expected = externalIncomeCents(f) - taxPaidCents(f) - obligationsCents(f);
      if (row.netCents !== expected) {
        wrong.push(`${id} · month ${m.month}: ${row.netCents} vs ${expected}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("shows retirement as a genuine shortfall, never netted to zero by the account funding it", () => {
    // The bug this replaces: counting the draw as income makes every one of these ≈ 0, because
    // the draw is sized to the gap. A shortfall must be at least the spending the benefit does
    // not cover.
    const notShort: string[] = [];
    for (const m of retiredMonths) {
      const f = m.flows!;
      const row = rowAt.get(m.month)!;
      const uncoveredByIncome = obligationsCents(f) + taxPaidCents(f) - externalIncomeCents(f);
      if (uncoveredByIncome <= 0) continue; // a month the benefit genuinely covered
      if (row.netCents !== -uncoveredByIncome) {
        notShort.push(`${id} · month ${m.month}: net ${row.netCents}, short ${uncoveredByIncome}`);
      }
    }
    expect(notShort).toEqual([]);
    // And it really is short: this household outlives its paycheck by design.
    expect(retiredMonths.some((m) => rowAt.get(m.month)!.netCents < 0)).toBe(true);
  });

  it("keeps the withdrawal's own tax on the outflow side, where it was really paid", () => {
    const wrong: string[] = [];
    for (const m of retiredMonths) {
      const f = m.flows!;
      const row = rowAt.get(m.month)!;
      const stackedTax = Object.entries(row.outflowCentsByBand)
        .filter(([bandId]) => bandId.startsWith("tax"))
        .reduce((sum, [, cents]) => sum + cents, 0);
      if (stackedTax !== taxPaidCents(f)) {
        wrong.push(`${id} · month ${m.month}: stacked ${stackedTax} vs paid ${taxPaidCents(f)}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("cash- vs IRA-funded retirement", () => {
  const [ira, cash] = RUNS;

  /** A month's shortfall as a positive number, averaged over the retired months. */
  const meanRetiredNet = ({ series, data }: (typeof RUNS)[number]): number => {
    const rowAt = new Map(data.rows.map((r) => [r.month, r] as const));
    const retired = series.months.filter((m) => m.flows !== undefined && isRetired(m));
    return Math.round(
      retired.reduce((sum, m) => sum + rowAt.get(m.month)!.netCents, 0) / retired.length,
    );
  };

  it("shows a shortfall in retirement either way — the account never masks the gap", () => {
    expect(meanRetiredNet(ira!)).toBeLessThan(0);
    expect(meanRetiredNet(cash!)).toBeLessThan(0);
  });

  it("differs only by the tax the pre-tax draw incurs, which is the real difference", () => {
    // Same household, same spending, same benefit. The 401(k) household's shortfall is deeper
    // because its withdrawals are taxable and the cash household's are not — a fact about tax,
    // not about how the chart is drawn.
    const meanTax = ({ series }: (typeof RUNS)[number]): number => {
      const retired = series.months.filter((m) => m.flows !== undefined && isRetired(m));
      return Math.round(retired.reduce((sum, m) => sum + taxPaidCents(m.flows!), 0) / retired.length);
    };
    expect(meanTax(ira!)).toBeGreaterThan(meanTax(cash!));
    expect(meanRetiredNet(ira!)).toBeLessThan(meanRetiredNet(cash!));
  });
});
