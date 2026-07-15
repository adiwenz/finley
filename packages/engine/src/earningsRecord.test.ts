import { describe, it, expect } from "vitest";
import {
  EMPTY_EARNINGS_RECORD,
  seedEarnings,
  addEarnings,
  toEarningsRecord,
} from "./earningsRecord";

describe("EarningsRecord accumulator", () => {
  it("starts empty", () => {
    expect(EMPTY_EARNINGS_RECORD.annualWagesCents.size).toBe(0);
    expect(toEarningsRecord(seedEarnings()).annualWagesCents.size).toBe(0);
  });

  it("seeds from a pre-now earnings summary (§4.6), dropping non-positive years", () => {
    const acc = seedEarnings({ 2020: 5_000_00, 2021: 6_000_00, 2022: 0 });
    const record = toEarningsRecord(acc);
    expect(record.annualWagesCents.get(2020)).toBe(5_000_00);
    expect(record.annualWagesCents.get(2021)).toBe(6_000_00);
    expect(record.annualWagesCents.has(2022)).toBe(false);
  });

  it("folds monthly wages into the year total and ignores ≤ 0", () => {
    const acc = seedEarnings({ 2026: 1_000_00 });
    addEarnings(acc, 2026, 500_00);
    addEarnings(acc, 2026, 0);
    addEarnings(acc, 2026, -100_00);
    addEarnings(acc, 2027, 200_00);
    const record = toEarningsRecord(acc);
    expect(record.annualWagesCents.get(2026)).toBe(1_500_00);
    expect(record.annualWagesCents.get(2027)).toBe(200_00);
  });

  it("freezes a snapshot — later accumulation does not mutate a taken record", () => {
    const acc = seedEarnings();
    addEarnings(acc, 2026, 100_00);
    const record = toEarningsRecord(acc);
    addEarnings(acc, 2026, 100_00);
    expect(record.annualWagesCents.get(2026)).toBe(100_00);
  });
});
