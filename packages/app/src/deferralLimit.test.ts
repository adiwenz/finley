import { describe, expect, it } from "vitest";
import { firstDeferralLimitCrossing } from "./deferralLimit";
import { PLAN_DEFAULTS } from "./planDefaults";
import type { Plan } from "@finley/engine";
import { dollarsToCents } from "@finley/engine";
import { START_YEAR } from "./config";

/** A budget built off the defaults with the deferral-relevant fields overridden. */
function budget(overrides: Partial<Plan>): Plan {
  return { ...PLAN_DEFAULTS, ...overrides };
}

describe("firstDeferralLimitCrossing", () => {
  it("returns null when nothing is deferred", () => {
    expect(firstDeferralLimitCrossing(budget({ retirementDeferralPct: 0 }))).toBeNull();
  });

  it("crosses in the current year when the rate already tops the limit", () => {
    // $60k/yr at 50% = $30k, above the 2026 $24,500 elective limit → crosses at k=0.
    const crossing = firstDeferralLimitCrossing(
      budget({ incomeCents: dollarsToCents(5000), retirementDeferralPct: 50 }),
    );
    expect(crossing).not.toBeNull();
    expect(crossing!.year).toBe(START_YEAR);
  });

  it("crosses in a LATER year when income inflates past the limit", () => {
    // $48k/yr at 50% = $24k, just under the 2026 $24,500 limit today. Income grows at
    // 3% CPI while the limit indexes at 2.5%, so it crosses within a few years.
    const crossing = firstDeferralLimitCrossing(
      budget({
        incomeCents: dollarsToCents(4000),
        retirementDeferralPct: 50,
        inflationPct: 3,
        currentAge: 35,
        retirementAge: 65,
      }),
    );
    expect(crossing).not.toBeNull();
    expect(crossing!.year).toBeGreaterThan(START_YEAR); // NOT flagged today — the precise part
    expect(crossing!.annualDeferralCents).toBeGreaterThan(crossing!.limitCents);
  });

  it("never crosses when a modest rate stays under the limit for the whole career", () => {
    // $48k/yr at 10% = $4.8k, far below the limit for all 30 working years.
    expect(
      firstDeferralLimitCrossing(
        budget({
          incomeCents: dollarsToCents(4000),
          retirementDeferralPct: 10,
          inflationPct: 3,
          currentAge: 35,
          retirementAge: 65,
        }),
      ),
    ).toBeNull();
  });

  it("stops scanning at retirement — a post-retirement crossing never counts", () => {
    // Retiring next year: even a high rate has only one working year to cross in.
    const crossing = firstDeferralLimitCrossing(
      budget({
        incomeCents: dollarsToCents(1500),
        retirementDeferralPct: 50,
        currentAge: 64,
        retirementAge: 65,
      }),
    );
    // $18k/yr at 50% = $9k, under the age-64 limit ($24,500 + $8,000 catch-up) → null.
    expect(crossing).toBeNull();
  });
});
