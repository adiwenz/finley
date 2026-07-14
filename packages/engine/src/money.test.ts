import { describe, it, expect } from "vitest";
import { splitEven } from "./money";

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
