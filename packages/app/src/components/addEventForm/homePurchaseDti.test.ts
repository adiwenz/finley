/**
 * The §4.5 soft-DTI glue (#23): derives gross income + existing debt from the
 * live household and classifies a prospective purchase. The threshold arithmetic
 * itself is the engine's; these pin the *derivation* — that a big mortgage on a
 * modest income trips the guideline, a small one stays quiet, and zero gross
 * income never trips a divide-by-zero warning.
 */
import { describe, it, expect } from "vitest";
import {
  emptyLedger,
  interpretLedger,
  replayLedger,
  createProjectionBase,
  dollarsToCents,
  nullJurisdiction,
  type Plan,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { START_YEAR } from "../../config";
import { PLAN_DEFAULTS } from "../../planDefaults";
import { assessHomePurchaseDti } from "./homePurchaseDti";

function build(budget: Plan) {
  const base = createProjectionBase(budget, { jurisdiction: usJurisdiction, startYear: START_YEAR });
  return {
    household: interpretLedger(emptyLedger, base),
    series: replayLedger(emptyLedger, base, nullJurisdiction),
  };
}

const purchase = {
  month: 0,
  purchasePriceCents: dollarsToCents(300_000),
  downPaymentCents: dollarsToCents(60_000),
  apr: 0.065,
  termMonths: 360,
};

describe("assessHomePurchaseDti (§4.5, #23)", () => {
  it("flags a purchase that pushes housing past the 28% front-end guideline", () => {
    const { household, series } = build(PLAN_DEFAULTS); // $5,000/mo gross
    const dti = assessHomePurchaseDti(household, series, purchase);
    expect(dti.assessment.frontEndExceeded).toBe(true);
    expect(dti.exceeded).toBe(true);
    expect(dti.monthlyGrossCents).toBe(dollarsToCents(5000));
    expect(dti.monthlyMortgageCents).toBeGreaterThan(0);
  });

  it("stays quiet for a small mortgage well within the guideline", () => {
    const { household, series } = build(PLAN_DEFAULTS);
    const dti = assessHomePurchaseDti(household, series, {
      ...purchase,
      purchasePriceCents: dollarsToCents(80_000), // $20k financed → tiny payment
    });
    expect(dti.exceeded).toBe(false);
  });

  it("does not trip a divide-by-zero warning at zero gross income", () => {
    const noIncome: Plan = { ...PLAN_DEFAULTS, incomeCents: 0 };
    const { household, series } = build(noIncome);
    const dti = assessHomePurchaseDti(household, series, purchase);
    expect(dti.monthlyGrossCents).toBe(0);
    expect(dti.assessment.frontEndRatio).toBe(0);
    expect(dti.exceeded).toBe(false);
  });
});
