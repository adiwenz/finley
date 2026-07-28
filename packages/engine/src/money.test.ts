import { describe, it, expect } from "vitest";
import { splitEven, apportionByWeight } from "./money";

describe("splitEven — integer-cents division that sums exactly", () => {
  it("divides evenly when it divides cleanly", () => {
    expect(splitEven(1000, 4)).toEqual([250, 250, 250, 250]);
  });

  it("absorbs the remainder without creating or losing a cent", () => {
    const parts = splitEven(1000, 3);
    expect(parts).toHaveLength(3);
    expect(parts.reduce((s, v) => s + v, 0)).toBe(1000);
    // Cumulative rounding places the odd cent where the running total rounds up.
    expect(parts).toEqual([333, 334, 333]);
  });

  it("handles a single slot and zero total", () => {
    expect(splitEven(777, 1)).toEqual([777]);
    expect(splitEven(0, 3)).toEqual([0, 0, 0]);
  });
});

describe("apportionByWeight — keyed largest-remainder split that sums exactly", () => {
  it("splits proportional to weight in whole cents", () => {
    const out = apportionByWeight(1000, [["a", 3], ["b", 1]]);
    expect(out.get("a")).toBe(750);
    expect(out.get("b")).toBe(250);
  });

  it("hands the leftover cent to the biggest remainder, summing to the total", () => {
    const out = apportionByWeight(1000, [["a", 1], ["b", 1], ["c", 1]]);
    const sum = [...out.values()].reduce((s, v) => s + v, 0);
    expect(sum).toBe(1000);
    // Exact shares 333.33 each; the odd cent goes to the first (stable sort of ties).
    expect([...out.values()].sort((x, y) => y - x)).toEqual([334, 333, 333]);
  });

  it("sums repeated keys and drops non-positive weights", () => {
    const out = apportionByWeight(900, [["a", 1], ["a", 1], ["b", 1], ["c", 0]]);
    expect(out.get("a")).toBe(600); // two weight-1 entries merged
    expect(out.get("b")).toBe(300);
    expect(out.has("c")).toBe(false);
  });

  it("returns an empty map for a zero total or zero weight sum", () => {
    expect(apportionByWeight(0, [["a", 1]]).size).toBe(0);
    expect(apportionByWeight(100, [["a", 0]]).size).toBe(0);
  });
});
