/**
 * The tax and cash-flow charts, held to their arithmetic across every preset and every month a
 * preset simulates — roughly forty thousand month/preset pairs, projected through the real
 * engine and the real jurisdiction.
 *
 * These are the invariants the reporting split exists to keep, and they are asserted here rather
 * than on a fixture because a fixture is exactly where the old bug hid: hand-built months carried
 * tidy, same-signed attribution, and the real April that broke the chart carried a −$3,409.11
 * slice against a +$3,434.39 one. Anything that reads `taxBySourceCents` without accounting for
 * the settlement inside it fails here on the first preset that files.
 */

import { describe, expect, it } from "vitest";
import { Projection } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { PRESETS, presetState } from "./presets";
import { buildTaxChartData } from "./components/baseAdjustments/taxesByMonth";
import {
  TAX_INCOME_BAND_ID,
  TAX_PAYROLL_BAND_ID,
  TAX_REFUND_BAND_ID,
  TAX_SETTLEMENT_BAND_ID,
  buildCashFlowChartData,
  refundBandId,
} from "./components/baseAdjustments/cashFlowChartData";

/** Each preset projected once, reused by every case below — the runs dominate the file's cost. */
const RUNS = PRESETS.map((preset) => ({
  preset,
  series: Projection.fromState(presetState(preset), usJurisdiction).run(usJurisdiction).series,
}));

/** `preset · month` — so a failure names the month, not just the count of them. */
const where = (id: string, month: number) => `${id} · month ${month}`;

describe.each(RUNS)("$preset.id — the tax chart's accounting", ({ preset, series }) => {
  const rows = buildTaxChartData(series).rows;
  const flowedMonths = series.months.filter((m) => m.flows !== undefined);

  it("recovers a non-negative ordinary withholding for every source in every month", () => {
    const negatives: string[] = [];
    for (const m of flowedMonths) {
      const f = m.flows!;
      for (const [source, cents] of Object.entries(f.taxBySourceCents)) {
        // The whole point of reporting the settlement separately: this subtraction is what turns
        // the month's income-tax cash back into the withholding a paycheck really took.
        const withholding = cents - (f.taxSettlementBySourceCents[source] ?? 0);
        if (withholding < 0) negatives.push(`${where(preset.id, m.month)} · ${source} = ${withholding}`);
      }
    }
    expect(negatives).toEqual([]);
  });

  it("stacks bands summing to the tax actually paid, to the cent", () => {
    const mismatches: string[] = [];
    for (const m of flowedMonths) {
      const f = m.flows!;
      const row = rows.find((r) => r.month === m.month)!;
      const banded = Object.values(row.centsBySource).reduce((s, c) => s + c, 0);
      const withholding = Object.entries(f.taxBySourceCents).reduce(
        (s, [source, cents]) => s + cents - (f.taxSettlementBySourceCents[source] ?? 0),
        0,
      );
      const fica = Object.values(f.payrollTaxBySourceCents).reduce((s, c) => s + c, 0);
      // GROSS across the household's members, who settle as separate single filers: a month in
      // which one owes $1,000 and another is refunded $300 paid $1,000 of tax. Clamping the
      // −$700 net would assert an invariant against a figure nobody paid.
      const settled = Object.values(f.taxSettlementByPersonCents ?? {});
      const settlementPaid =
        settled.length > 0
          ? settled.reduce((s, c) => s + Math.max(0, c), 0)
          : Math.max(0, f.taxSettlementCents);
      const expected = withholding + fica + settlementPaid;
      if (banded !== expected || row.taxCents !== expected) {
        mismatches.push(`${where(preset.id, m.month)}: banded ${banded}, row ${row.taxCents}, expected ${expected}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("never draws a negative band", () => {
    const negatives = rows.flatMap((r) =>
      Object.entries(r.centsBySource)
        .filter(([, c]) => c < 0)
        .map(([id, c]) => `${where(preset.id, r.month)} · ${id} = ${c}`),
    );
    expect(negatives).toEqual([]);
  });

  it("keeps the signed settlement attribution summing exactly to the settlement", () => {
    const broken: string[] = [];
    for (const m of flowedMonths) {
      const f = m.flows!;
      const net = Object.values(f.taxSettlementBySourceCents).reduce((s, c) => s + c, 0);
      if (net !== f.taxSettlementCents) {
        broken.push(`${where(preset.id, m.month)}: attribution ${net} vs settlement ${f.taxSettlementCents}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("gives a refund month zero settlement band and the full refund as its refund figure", () => {
    const wrong: string[] = [];
    for (const m of flowedMonths) {
      const settlement = m.flows!.taxSettlementCents;
      if (settlement >= 0) continue;
      const row = rows.find((r) => r.month === m.month)!;
      if (row.settlementPaidCents !== 0 || row.centsBySource["tax-settlement"] !== undefined) {
        wrong.push(`${where(preset.id, m.month)}: refund drew a settlement band`);
      }
      if (row.refundCents !== -settlement) {
        wrong.push(`${where(preset.id, m.month)}: refund ${row.refundCents} vs ${-settlement}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

/**
 * The cash-flow chart, held to the property the three views exist to guarantee: nothing on
 * either stack is ever negative, so nothing is ever clamped and nothing is ever charged on pro
 * rata. The old chart netted tax into the source that bore it and needed both; a household with
 * three equal salaries drew ONE of them carrying the whole month's take-home.
 */
describe.each(RUNS)("$preset.id — the cash-flow chart's two stacks", ({ preset, series }) => {
  const data = buildCashFlowChartData(series);
  const rowAt = new Map(data.rows.map((r) => [r.month, r] as const));
  const flowedMonths = series.months.filter((m) => m.flows !== undefined);

  it("never draws a negative band on either side, in any month", () => {
    const negatives: string[] = [];
    for (const row of data.rows) {
      for (const [id, cents] of Object.entries(row.inflowCentsByBand)) {
        if (cents < 0) negatives.push(`${where(preset.id, row.month)} · in · ${id} = ${cents}`);
      }
      for (const [id, cents] of Object.entries(row.outflowCentsByBand)) {
        if (cents < 0) negatives.push(`${where(preset.id, row.month)} · out · ${id} = ${cents}`);
      }
    }
    expect(negatives).toEqual([]);
  });

  it("bands each filer's refund to that filer, and nobody's twice", () => {
    const wrong: string[] = [];
    for (const m of flowedMonths) {
      const row = rowAt.get(m.month)!;
      const byPerson = m.flows!.taxSettlementByPersonCents ?? {};
      // GROSS: the household's net settlement nets a bill against a refund, and a refund is
      // the filer's whatever their partner's filing came to.
      const refunded = Object.entries(byPerson).filter(([, c]) => c < 0);
      const expected = Object.fromEntries(refunded.map(([pid, c]) => [refundBandId(pid), -c]));
      const banded = Object.fromEntries(
        Object.entries(row.inflowCentsByBand).filter(([id]) => id.startsWith(TAX_REFUND_BAND_ID)),
      );
      if (JSON.stringify(banded) !== JSON.stringify(expected)) {
        wrong.push(
          `${where(preset.id, m.month)}: banded ${JSON.stringify(banded)} vs ${JSON.stringify(expected)}`,
        );
      }
    }
    expect(wrong).toEqual([]);
  });

  it("keeps every person's cut of the settlement summing to the household's", () => {
    const wrong: string[] = [];
    for (const m of flowedMonths) {
      const row = rowAt.get(m.month)!;
      const cuts = Object.values(row.outflowCentsByBandByPerson);
      const paid = cuts.reduce((sum, byBand) => sum + (byBand[TAX_SETTLEMENT_BAND_ID] ?? 0), 0);
      const refunds = Object.entries(row.inflowCentsByBand)
        .filter(([id]) => id.startsWith(TAX_REFUND_BAND_ID))
        .reduce((sum, [, c]) => sum + c, 0);
      const household = row.outflowCentsByBand[TAX_SETTLEMENT_BAND_ID] ?? 0;
      // The two halves of the same signed figure, each summing to its own household total —
      // and the difference between them is the household's net settlement.
      if (paid !== household || paid - refunds !== m.flows!.taxSettlementCents) {
        wrong.push(
          `${where(preset.id, m.month)}: paid ${paid} vs ${household}, refunds ${refunds}, net ${m.flows!.taxSettlementCents}`,
        );
      }
    }
    expect(wrong).toEqual([]);
  });

  it("bands every source's GROSS cash, untouched by any tax it bore", () => {
    const wrong: string[] = [];
    for (const m of flowedMonths) {
      const row = rowAt.get(m.month)!;
      for (const s of m.flows!.incomeSources) {
        if (s.fromAccountWithdrawal === true || s.category === "savingsInterest") continue;
        if (s.cashInflowCents === 0) continue;
        const banded = row.inflowCentsByBand[s.sourceId] ?? 0;
        if (banded !== s.cashInflowCents) {
          wrong.push(`${where(preset.id, m.month)} · ${s.sourceId}: ${banded} vs ${s.cashInflowCents}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it("sums the tax bands to the tax the month actually paid, to the cent", () => {
    const wrong: string[] = [];
    for (const m of flowedMonths) {
      const f = m.flows!;
      const out = rowAt.get(m.month)!.outflowCentsByBand;
      const banded =
        (out[TAX_INCOME_BAND_ID] ?? 0) + (out[TAX_PAYROLL_BAND_ID] ?? 0) + (out[TAX_SETTLEMENT_BAND_ID] ?? 0);
      // Withholding recovered by taking the signed settlement back out, plus FICA, plus a
      // settlement only where it was a BILL — a refund is money in, and bands on the other side.
      const expected =
        f.taxCents - f.taxSettlementCents + f.payrollTaxCents + Math.max(0, f.taxSettlementCents);
      if (banded !== expected) {
        wrong.push(`${where(preset.id, m.month)}: banded ${banded}, expected ${expected}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("sums the outflow stack to tax paid plus every obligation the month owed", () => {
    const wrong: string[] = [];
    for (const m of flowedMonths) {
      const f = m.flows!;
      const row = rowAt.get(m.month)!;
      const stacked = Object.values(row.outflowCentsByBand).reduce((sum, c) => sum + c, 0);
      const taxPaid =
        f.taxCents - f.taxSettlementCents + f.payrollTaxCents + Math.max(0, f.taxSettlementCents);
      const owed = f.obligations.reduce((sum, o) => sum + o.amountCents, 0);
      if (stacked !== taxPaid + owed) {
        wrong.push(`${where(preset.id, m.month)}: stacked ${stacked}, expected ${taxPaid + owed}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("hands every cent of the month's spending to somebody", () => {
    // The person cuts of "Going out" are the engine's own charge figures, so they are only
    // trustworthy if the charges account for the whole budget: a month that assigns nobody the
    // rent still spends it, and would read on every person's chart as though it cost them
    // nothing. Asserted against the household's obligations rather than against the shares
    // themselves, so a split that quietly drops a share to an unattributed shortfall fails here.
    const wrong: string[] = [];
    for (const m of flowedMonths) {
      const f = m.flows!;
      const charged = Object.values(f.obligationChargedByPersonCents).reduce((sum, c) => sum + c, 0);
      if (charged !== f.totalObligationsCents) {
        wrong.push(`${where(preset.id, m.month)}: charged ${charged} of ${f.totalObligationsCents}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("makes the net exactly what came in less what went out", () => {
    const wrong: string[] = [];
    for (const row of data.rows) {
      if (row.netCents !== row.inflowTotalCents - row.outflowTotalCents) {
        wrong.push(`${where(preset.id, row.month)}: ${row.netCents}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
