import { describe, it, expect } from "vitest";
import type { Cents, RmdContext } from "@finley/engine";
import { requiredMinimumDistributionCents } from "./rmd";

/** RMD context for a holder of the given birth year at the given age. */
function ctx(birthYear: number, age: number): RmdContext {
  return { year: birthYear + age, age, birthYear };
}

const ONE_MILLION: Cents = 1_000_000_00;

describe("requiredMinimumDistributionCents — US RMD schedule (§5.4)", () => {
  it("cent-pinned anchor: $1,000,000 at age 75 uses the 24.6 divisor", () => {
    // Uniform Lifetime Table divisor at 75 is 24.6:
    //   $1,000,000 / 24.6 = $40,650.4065… → round to the cent → $40,650.41
    expect(requiredMinimumDistributionCents(ONE_MILLION, ctx(1960, 75))).toBe(40_650_41);
  });

  it("start age is 73 for birth years 1951–1959", () => {
    // Nothing required the year before the start age…
    expect(requiredMinimumDistributionCents(ONE_MILLION, ctx(1955, 72))).toBe(0);
    // …and a positive distribution from the start age on.
    expect(requiredMinimumDistributionCents(ONE_MILLION, ctx(1955, 73))).toBeGreaterThan(0);
  });

  it("start age is 75 for birth years 1960+", () => {
    // At 74 a 1960 cohort holder still owes nothing (start age 75)…
    expect(requiredMinimumDistributionCents(ONE_MILLION, ctx(1960, 74))).toBe(0);
    // …then a positive distribution at 75.
    expect(requiredMinimumDistributionCents(ONE_MILLION, ctx(1960, 75))).toBeGreaterThan(0);
  });

  it("returns 0 for a zero (or empty) balance even past the start age", () => {
    expect(requiredMinimumDistributionCents(0, ctx(1955, 80))).toBe(0);
  });

  it("is monotonic in age: a fixed balance never withdraws less as the holder ages", () => {
    let prev = -1;
    for (let age = 73; age <= 100; age++) {
      const rmd = requiredMinimumDistributionCents(ONE_MILLION, ctx(1955, age));
      expect(rmd).toBeGreaterThanOrEqual(prev);
      prev = rmd;
    }
  });

  it("is monotonic in balance: a larger balance never withdraws less at the same age", () => {
    const small = requiredMinimumDistributionCents(500_000_00, ctx(1955, 80));
    const large = requiredMinimumDistributionCents(ONE_MILLION, ctx(1955, 80));
    expect(large).toBeGreaterThan(small);
  });

  it("never withdraws more than the balance (very advanced age clamps to the last divisor)", () => {
    const rmd = requiredMinimumDistributionCents(ONE_MILLION, ctx(1955, 130));
    expect(rmd).toBeGreaterThan(0);
    expect(rmd).toBeLessThanOrEqual(ONE_MILLION);
  });
});
