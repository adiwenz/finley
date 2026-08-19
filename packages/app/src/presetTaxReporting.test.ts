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
import { Projection, type ProjectionSeries } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { PRESETS, presetState } from "./presets";
import { buildTaxChartData } from "./components/baseAdjustments/taxesByMonth";
import { buildIncomeChartData } from "./components/baseAdjustments/incomeChartData";

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
      const expected = withholding + fica + Math.max(0, f.taxSettlementCents);
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
 * The reclassification must MOVE the refund between bands, never mint it. "Before" is the same
 * series with the settlement stripped — the state of the world when a refund was silently spread
 * across whatever sources bore the year's tax, and the only thing the chart could do with it.
 */
function withoutSettlementReporting(series: ProjectionSeries): ProjectionSeries {
  return {
    ...series,
    months: series.months.map((m) =>
      m.flows === undefined
        ? m
        : { ...m, flows: { ...m.flows, taxSettlementCents: 0, taxSettlementBySourceCents: {} } },
    ),
  } as ProjectionSeries;
}

describe.each(RUNS)("$preset.id — the cash-flow chart's refund band", ({ preset, series }) => {
  const after = buildIncomeChartData(series);
  const before = buildIncomeChartData(withoutSettlementReporting(series));

  // Both charts drop the flow-free snapshot, so a row index is not a month index — every lookup
  // below goes through the month itself.
  const wasAt = new Map(before.rows.map((r) => [r.month, r] as const));

  it("leaves household take-home identical wherever the refund had somewhere to be", () => {
    const moved = after.rows
      .filter((row) => row.takeHomeCents !== wasAt.get(row.month)!.takeHomeCents)
      .filter((row) => {
        const flows = series.months.find((m) => m.month === row.month)?.flows;
        return (flows?.incomeSources.length ?? 0) > 0;
      })
      .map((row) => `${where(preset.id, row.month)}: ${wasAt.get(row.month)!.takeHomeCents} → ${row.takeHomeCents}`);
    expect(moved).toEqual([]);
  });

  /**
   * The one place take-home legitimately MOVES, and it moves up.
   *
   * A refund arriving in a month with no income at all has no source to net into — the engine's
   * stranded-haircut pass needs a band with cash on it and there is none — so before this the
   * money simply never reached the chart. `living-on-credit` files one such April 30 years in,
   * with six cents; a retiree filing on a year of withholding-free income is the same shape at
   * a scale that matters.
   */
  it("makes a refund visible in a month that has no income to hide it in", () => {
    const wrong: string[] = [];
    for (const m of series.months) {
      if (m.flows === undefined || m.flows.incomeSources.length > 0) continue;
      const refund = Math.max(0, -m.flows.taxSettlementCents);
      const row = after.rows.find((r) => r.month === m.month)!;
      const gained = row.takeHomeCents - wasAt.get(m.month)!.takeHomeCents;
      if (gained !== refund) wrong.push(`${where(preset.id, m.month)}: gained ${gained} vs refund ${refund}`);
    }
    expect(wrong).toEqual([]);
  });

  it("bands the refund exactly once, and only in the months that got one", () => {
    const wrong: string[] = [];
    for (const m of series.months) {
      if (m.flows === undefined) continue;
      const refund = Math.max(0, -m.flows.taxSettlementCents);
      const row = after.rows.find((r) => r.month === m.month)!;
      const banded = row.netCentsBySource["tax-refund"] ?? 0;
      if (banded !== refund) wrong.push(`${where(preset.id, m.month)}: banded ${banded} vs refund ${refund}`);
      // Once, not twice: gross carries the same single figure, never a doubled one.
      const gross = row.centsBySource["tax-refund"] ?? 0;
      if (gross !== refund) wrong.push(`${where(preset.id, m.month)}: gross ${gross} vs refund ${refund}`);
    }
    expect(wrong).toEqual([]);
  });
});
