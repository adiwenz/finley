/**
 * The terminal blocked marker on the net-worth chart. When a projection is BLOCKED — an
 * explicitly-funded obligation could not be funded — the series is truncated at the blocked month
 * and the chart draws a single presentation-only marker for the attempted obligation. It is never
 * a simulated month: it names the blocking obligation and its funding gap, and sits the shortfall
 * below the genuine final net worth so the missing capital is visible.
 *
 * The seam is `buildNetWorthChartData`, the pure data module — asserted without rendering Recharts.
 * The marker's y is READ off the engine's `markerNetWorthCents`, never computed here (the module
 * does no cents arithmetic, guarded by `insolventMonthNetWorth.test.ts`).
 */

import { describe, it, expect } from "vitest";
import type { BlockedObligation, ProjectionMonth, ProjectionSeries } from "@finley/engine";
import { buildNetWorthChartData } from "./netWorthChartData";
import { toAxisX } from "../monthAxis";

function month(m: number, netWorthNominalCents: number): ProjectionMonth {
  return {
    month: m,
    netWorthNominalCents,
    netWorthRealCents: netWorthNominalCents,
    accountBalancesCents: {},
    accountBasisCents: {},
    liabilityBalancesCents: {},
    liabilityPaymentRecords: {},
    propertyValuesCents: {},
    isInsolvent: false,
    uncoveredCents: 0,
  };
}

const BLOCK_MONTH = 3;

const blocking: BlockedObligation = {
  obligationId: "draw:downpayment:buy1",
  sourceEventId: "buy1",
  label: "Home purchase",
  month: BLOCK_MONTH,
  requiredCents: 8_000_000,
  availableCents: 5_000_000,
  shortfallCents: 3_000_000,
  markerNetWorthCents: 2_000_000, // final net worth $50k less the $30k shortfall
};

function blockedSeries(): ProjectionSeries {
  const months = [month(0, 5_200_000), month(1, 5_100_000), month(2, 5_050_000), month(3, 5_000_000)];
  return {
    opening: month(0, 5_300_000),
    months,
    status: "blocked",
    simulatedThroughMonth: BLOCK_MONTH,
    blockedAtMonth: BLOCK_MONTH,
    blockingObligation: blocking,
    obligationOutcomes: {},
  };
}

describe("net-worth chart — the terminal blocked marker", () => {
  it("draws a marker at the blocked month carrying the obligation and its funding gap", () => {
    const data = buildNetWorthChartData(blockedSeries());
    expect(data.blocked).not.toBeNull();
    expect(data.blocked?.x).toBe(toAxisX(BLOCK_MONTH));
    expect(data.blocked?.label).toBe("Home purchase");
    expect(data.blocked?.requiredCents).toBe(8_000_000);
    expect(data.blocked?.availableCents).toBe(5_000_000);
    expect(data.blocked?.shortfallCents).toBe(3_000_000);
  });

  it("sits the marker at the engine's figure — the shortfall below the final net worth", () => {
    const data = buildNetWorthChartData(blockedSeries());
    // Read straight off the engine's `markerNetWorthCents`, not recomputed.
    expect(data.blocked?.netWorthCents).toBe(2_000_000);
  });

  it("draws no simulated point past the blocked month, and keeps the marker in view", () => {
    const data = buildNetWorthChartData(blockedSeries());
    // The series is already truncated; the chart never invents a point beyond it.
    for (const p of data.points) expect(p.x).toBeLessThanOrEqual(toAxisX(BLOCK_MONTH));
    expect(data.blocked!.x).toBeLessThanOrEqual(data.xMax);
  });

  it("draws no blocked marker for a plan that ran to the horizon", () => {
    const months = [month(0, 5_000_000), month(1, 5_100_000)];
    const ranToHorizon: ProjectionSeries = {
      opening: month(0, 5_000_000),
      months,
      status: "ran-to-horizon",
      simulatedThroughMonth: 1,
      obligationOutcomes: {},
    };
    expect(buildNetWorthChartData(ranToHorizon).blocked).toBeNull();
  });

  // A blocked series is truncated at the block, so an axis derived from the data alone ends there
  // — and a plan stopped in year 1 then draws exactly as wide as one that reached life expectancy.
  // The whole plan is on the axis instead, and the unanswered remainder is shaded.
  describe("the axis spans the whole plan, not the truncated data", () => {
    const HORIZON_MONTHS = 55 * 12;

    it("runs to life expectancy even though the series stops at the block", () => {
      const data = buildNetWorthChartData(blockedSeries(), HORIZON_MONTHS);
      expect(data.xMax).toBe(toAxisX(HORIZON_MONTHS - 1));
      // ...without inventing a single point past the block.
      for (const p of data.points) expect(p.x).toBeLessThanOrEqual(toAxisX(BLOCK_MONTH));
      // The marker still lands where it always did — early on a now-long axis, which is the point.
      expect(data.blocked?.x).toBe(toAxisX(BLOCK_MONTH));
    });

    it("shades everything from the block to the end of the axis", () => {
      const data = buildNetWorthChartData(blockedSeries(), HORIZON_MONTHS);
      expect(data.stopped).toEqual({ fromX: toAxisX(BLOCK_MONTH), toX: data.xMax });
    });

    it("shades nothing for a plan that ran to the horizon", () => {
      const ranToHorizon: ProjectionSeries = {
        opening: month(0, 5_000_000),
        months: [month(0, 5_000_000), month(1, 5_100_000)],
        status: "ran-to-horizon",
        simulatedThroughMonth: 1,
        obligationOutcomes: {},
      };
      expect(buildNetWorthChartData(ranToHorizon, HORIZON_MONTHS).stopped).toBeNull();
    });

    it("shades nothing when the block lands at the very end of the axis", () => {
      // Nothing went unsimulated that a reader could be shown, so there is no band to draw.
      const data = buildNetWorthChartData(blockedSeries(), BLOCK_MONTH + 1);
      expect(data.stopped).toBeNull();
      expect(data.blocked?.x).toBe(toAxisX(BLOCK_MONTH));
    });

    it("falls back to the data's own span when no horizon is stated", () => {
      const data = buildNetWorthChartData(blockedSeries());
      expect(data.xMax).toBe(toAxisX(BLOCK_MONTH));
      expect(data.stopped).toBeNull();
    });
  });
});
