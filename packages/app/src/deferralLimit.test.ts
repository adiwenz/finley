import { describe, expect, it } from "vitest";
import { firstDeferralLimitCrossing } from "./deferralLimit";
import { PLAN_DEFAULTS } from "./planDefaults";
import type { Plan } from "@finley/engine";
import { dollarsToCents } from "@finley/engine";
import { START_YEAR } from "./config";
import { setJobDeferralFraction, setJobMonthlyIncome } from "./planPeople";

/**
 * A budget built off the defaults with the career job's salary + deferral set — income
 * and the pre-tax deferral now ride the job (§11), not scalar plan fields.
 */
function budget(opts: {
  monthlyIncome?: number;
  deferralPct?: number;
  overrides?: Partial<Plan>;
}): Plan {
  let plan: Plan = { ...PLAN_DEFAULTS, ...(opts.overrides ?? {}) };
  if (opts.monthlyIncome !== undefined) plan = setJobMonthlyIncome(plan, "career", dollarsToCents(opts.monthlyIncome));
  if (opts.deferralPct !== undefined) plan = setJobDeferralFraction(plan, "career", opts.deferralPct / 100);
  return plan;
}

describe("firstDeferralLimitCrossing", () => {
  it("returns null when nothing is deferred", () => {
    expect(firstDeferralLimitCrossing(budget({ deferralPct: 0 }))).toBeNull();
  });

  it("crosses in the current year when the rate already tops the limit", () => {
    // $60k/yr at 50% = $30k, above the 2026 $24,500 elective limit → crosses at k=0.
    const crossing = firstDeferralLimitCrossing(budget({ monthlyIncome: 5000, deferralPct: 50 }));
    expect(crossing).not.toBeNull();
    expect(crossing!.year).toBe(START_YEAR);
  });

  it("crosses in a LATER year when income inflates past the limit", () => {
    // $48k/yr at 50% = $24k, just under the 2026 $24,500 limit today. Income grows at
    // 3% CPI while the limit indexes at 2.5%, so it crosses within a few years.
    const crossing = firstDeferralLimitCrossing(
      budget({
        monthlyIncome: 4000,
        deferralPct: 50,
        overrides: { inflationPct: 3, currentAge: 35, retirementAge: 65 },
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
          monthlyIncome: 4000,
          deferralPct: 10,
          overrides: { inflationPct: 3, currentAge: 35, retirementAge: 65 },
        }),
      ),
    ).toBeNull();
  });

  it("stops scanning at retirement — a post-retirement crossing never counts", () => {
    // Retiring next year: even a high rate has only one working year to cross in.
    const crossing = firstDeferralLimitCrossing(
      budget({
        monthlyIncome: 1500,
        deferralPct: 50,
        overrides: { currentAge: 64, retirementAge: 65 },
      }),
    );
    // $18k/yr at 50% = $9k, under the age-64 limit ($24,500 + $8,000 catch-up) → null.
    expect(crossing).toBeNull();
  });
});
