/**
 * Behavior-preservation guard for the per-line funding-attribution slice (ResolvedFunding).
 *
 * Attribution is a DERIVED partition of a flow that already happens — computed during the
 * funding walk instead of inferred afterward — so it must move no money. This test pins the
 * numbers the slice may not touch: per-month balances, basis, liability balances, property
 * values, tax, net worth and the insolvency flag, across the default plan and every preset.
 * Every later task in the slice keeps this green or has changed money it had no licence to.
 *
 * The whole per-month money shape is folded into one FNV-1a digest per preset rather than a
 * 70k-line golden: any moved cent, anywhere in the horizon, flips the digest. A run also pins
 * the horizon length, the final net worth and the first insolvent month in the clear, so a
 * digest break lands next to human-readable anchors instead of an opaque hash diff.
 *
 * `flows.resolvedFunding` is deliberately NOT hashed — surfacing an interpretation is not a
 * behavior change, and folding it in would let a reshaped attribution masquerade as a preserved
 * projection.
 */

import { describe, it, expect } from "vitest";
import { Projection, type ProjectionMonth, type ProjectionSeries } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { PRESETS, type Preset } from "./presets";

function seriesOf(preset: Preset): ProjectionSeries {
  const built = Projection.fromInput(preset.input, usJurisdiction);
  if (!built.ok) throw new Error(`Preset "${preset.id}" was rejected: ${built.error.reason}`);
  return built.projection.run(usJurisdiction).series;
}

/** The money-bearing slice of a month — everything attribution is forbidden from moving. */
function moneyShape(m: ProjectionMonth) {
  return {
    month: m.month,
    netWorthNominalCents: m.netWorthNominalCents,
    netWorthRealCents: m.netWorthRealCents,
    accountBalancesCents: m.accountBalancesCents,
    accountBasisCents: m.accountBasisCents,
    liabilityBalancesCents: m.liabilityBalancesCents,
    propertyValuesCents: m.propertyValuesCents,
    isInsolvent: m.isInsolvent,
    taxCents: m.flows?.taxCents ?? null,
  };
}

/** FNV-1a over a string → an 8-hex digest, stable across runs and platforms. */
function digest(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function moneyDigest(series: ProjectionSeries): string {
  const shape = [series.opening, ...series.months].map(moneyShape);
  return digest(JSON.stringify(shape));
}

/** Pre-slice digests + anchors, captured against the engine before ResolvedFunding existed. */
const PRE_SLICE: Record<
  string,
  { digest: string; months: number; finalNetWorthCents: number | null; firstInsolventMonth: number | null }
> = {
  default: { digest: "771c48f3", months: 660, finalNetWorthCents: null, firstInsolventMonth: 364 },
  "paycheck-to-paycheck": { digest: "ccdd15f5", months: 660, finalNetWorthCents: null, firstInsolventMonth: 85 },
  "living-on-credit": { digest: "792820a7", months: 660, finalNetWorthCents: null, firstInsolventMonth: 40 },
  "student-loan": { digest: "9d753232", months: 660, finalNetWorthCents: 52_977_436, firstInsolventMonth: null },
  "taxed-in-retirement": { digest: "7c339e84", months: 444, finalNetWorthCents: null, firstInsolventMonth: 64 },
};

const firstInsolventMonthOf = (series: ProjectionSeries): number | null =>
  series.months.find((m) => m.isInsolvent)?.month ?? null;

describe("behavior preservation across the default plan and every preset", () => {
  it.each(PRESETS.map((p) => [p.id, p] as const))(
    "%s projects bit-identically to pre-slice output",
    (id, preset) => {
      const series = seriesOf(preset);
      const expected = PRE_SLICE[id];
      expect(expected, `no pre-slice baseline recorded for preset "${id}"`).toBeDefined();
      expect(series.months.length).toBe(expected.months);
      expect(series.months[series.months.length - 1]?.netWorthNominalCents).toBe(
        expected.finalNetWorthCents,
      );
      expect(firstInsolventMonthOf(series)).toBe(expected.firstInsolventMonth);
      expect(moneyDigest(series)).toBe(expected.digest);
    },
  );
});
