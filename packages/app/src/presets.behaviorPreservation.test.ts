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

/**
 * The BALANCES a month holds — everything attribution is forbidden from moving, and the part
 * that is money rather than commentary on it. Split out from {@link moneyShape} so a change to
 * how net worth is *reported* can never be confused with a change to what the household
 * actually has. Only a `balancesDigest` break means money moved.
 */
function balancesShape(m: ProjectionMonth) {
  return {
    month: m.month,
    accountBalancesCents: m.accountBalancesCents,
    accountBasisCents: m.accountBasisCents,
    liabilityBalancesCents: m.liabilityBalancesCents,
    propertyValuesCents: m.propertyValuesCents,
    isInsolvent: m.isInsolvent,
    taxCents: m.flows?.taxCents ?? null,
  };
}

/** The balances plus the reported net-worth aggregate derived from them. */
function moneyShape(m: ProjectionMonth) {
  return {
    ...balancesShape(m),
    netWorthNominalCents: m.netWorthNominalCents,
    netWorthRealCents: m.netWorthRealCents,
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
  return digest(JSON.stringify([series.opening, ...series.months].map(moneyShape)));
}

function balancesDigest(series: ProjectionSeries): string {
  return digest(JSON.stringify([series.opening, ...series.months].map(balancesShape)));
}

/**
 * Pre-slice digests + anchors, captured against the engine before ResolvedFunding existed.
 *
 * `balances` carries the pre-slice numbers unchanged — its VALUES were computed against the
 * engine as it stood before net worth started being withheld from the first insolvent month
 * (the misleading uptick — see `netWorthChart/insolventMonthNetWorth.test.ts`), and they still
 * hold. That is the claim worth making: the uptick fix withheld a derived figure for one month
 * per insolvent preset and moved no money.
 *
 * `digest` was re-baselined at the same time. Every preset's value moved, including the solvent
 * one, because {@link moneyShape} was also restructured and JSON key order feeds the hash — so
 * a `digest` break alone is weak evidence. `balances` is the load-bearing guard.
 */
const PRE_SLICE: Record<
  string,
  {
    digest: string;
    balances: string;
    months: number;
    finalNetWorthCents: number | null;
    firstInsolventMonth: number | null;
  }
> = {
  default: { digest: "9bacbd4e", balances: "565174cf", months: 660, finalNetWorthCents: null, firstInsolventMonth: 364 },
  "paycheck-to-paycheck": { digest: "3bd9f23e", balances: "7884bb2d", months: 660, finalNetWorthCents: null, firstInsolventMonth: 85 },
  "living-on-credit": { digest: "4c4ee7c6", balances: "7b25f211", months: 660, finalNetWorthCents: null, firstInsolventMonth: 40 },
  "student-loan": { digest: "d7f446be", balances: "ce4973c1", months: 660, finalNetWorthCents: 52_977_436, firstInsolventMonth: null },
  "taxed-in-retirement": { digest: "b1eafcf8", balances: "135e86a3", months: 444, finalNetWorthCents: null, firstInsolventMonth: 64 },
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
      // Balances first: this is the one that means money moved, and it must never be
      // re-baselined to make a change go green.
      expect(balancesDigest(series), "balances moved — money changed hands").toBe(
        expected.balances,
      );
      expect(moneyDigest(series)).toBe(expected.digest);
    },
  );
});
