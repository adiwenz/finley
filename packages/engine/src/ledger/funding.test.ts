import { describe, it, expect } from "vitest";
import { drainSources } from "./funding";

// ─── drainSources — the shared ordered-drain funding primitive (§4.5 / #129) ──────
// Both money-out events (Home Purchase, One-Time Spend) fund from an ordered list of
// eligible accounts. This pure helper resolves "take X from these accounts, in order"
// into how much came out (`drained`), how much couldn't be covered (`shortfall`), and
// the per-account draws the caller turns into transfers.

const src = (balanceCents: number) => ({ balanceCents });

describe("drainSources — full coverage", () => {
  it("drains the full amount and reports no shortfall when balances cover it", () => {
    const result = drainSources([src(3_000_000), src(4_000_000)], 6_000_000);
    expect(result.drained).toBe(6_000_000);
    expect(result.shortfall).toBe(0);
  });

  it("stops once the amount is met, leaving later sources untouched", () => {
    // $60k drains fully from the first $30k + $40k of the second; the third is not reached.
    const result = drainSources([src(3_000_000), src(4_000_000), src(9_000_000)], 6_000_000);
    expect(result.draws.map((d) => d.amountCents)).toEqual([3_000_000, 3_000_000]);
    expect(result.drained).toBe(6_000_000);
  });
});

describe("drainSources — partial shortfall", () => {
  it("drains everything available and reports the uncovered remainder", () => {
    // $30k + $20k = $50k available against a $60k ask → $10k shortfall.
    const result = drainSources([src(3_000_000), src(2_000_000)], 6_000_000);
    expect(result.drained).toBe(5_000_000);
    expect(result.shortfall).toBe(1_000_000);
    expect(result.draws.map((d) => d.amountCents)).toEqual([3_000_000, 2_000_000]);
  });

  it("has drained + shortfall reconcile to the requested amount", () => {
    const result = drainSources([src(1_000_000)], 6_000_000);
    expect(result.drained + result.shortfall).toBe(6_000_000);
  });
});

describe("drainSources — ordering", () => {
  it("draws in the order given, not by balance size", () => {
    // A smaller account listed first is drained first; ordering is the caller's choice.
    const small = { id: "small", balanceCents: 1_000_000 };
    const large = { id: "large", balanceCents: 9_000_000 };
    const result = drainSources([small, large], 5_000_000);
    expect(result.draws.map((d) => d.source.id)).toEqual(["small", "large"]);
    expect(result.draws.map((d) => d.amountCents)).toEqual([1_000_000, 4_000_000]);
  });

  it("skips a zero-balance source without emitting an empty draw", () => {
    const result = drainSources([src(0), src(5_000_000)], 3_000_000);
    expect(result.draws).toHaveLength(1);
    expect(result.draws[0].amountCents).toBe(3_000_000);
  });
});
