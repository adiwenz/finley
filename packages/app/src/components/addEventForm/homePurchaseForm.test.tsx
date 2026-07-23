/**
 * @vitest-environment node
 *
 * Home-purchase authoring form — the §4.5 soft DTI warning (Slice 4, #23).
 *
 * Rendered through the server renderer (this repo's jsdom is unavailable). The
 * arithmetic (`assessDti`, `mortgagePaymentForPurchaseCents`) is unit-tested in
 * the engine; these pin the *wiring*: that a purchase above the 28%/36% DTI
 * guidelines surfaces a NON-blocking advisory naming its downstream consequence,
 * and that a comfortably-affordable purchase stays silent.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  emptyLedger,
  interpretLedger,
  replayLedger,
  createProjectionBase,
  dollarsToCents,
  nullJurisdiction,
  type Household,
  type Plan,
  type ProjectionSeries,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { START_YEAR } from "../../config";
import { PLAN_DEFAULTS } from "../../planDefaults";
import { setMonthlyIncome } from "../../planPeople";
import { HomePurchaseForm } from "./homePurchaseForm";

const noop = () => {};

function build(budget: Plan): { household: Household; series: ProjectionSeries } {
  const base = createProjectionBase(budget, { jurisdiction: usJurisdiction, startYear: START_YEAR });
  return {
    household: interpretLedger(emptyLedger, base),
    series: replayLedger(emptyLedger, base, nullJurisdiction),
  };
}

function render(budget: Plan) {
  const { household, series } = build(budget);
  return renderToStaticMarkup(
    <HomePurchaseForm
      defaultMonth={0}
      nextId={0}
      horizonMonths={660}
      onAdd={noop}
      household={household}
      series={series}
    />,
  );
}

describe("HomePurchaseForm — §4.5 soft DTI warning (#23)", () => {
  it("surfaces a soft warning when the purchase exceeds the DTI guideline", () => {
    // Default: $300k / $60k down / 6.5% / 30yr ≈ $1,516/mo on $5,000 gross →
    // ~30% front-end, above the 28% guideline.
    const html = render(PLAN_DEFAULTS);
    expect(html).toContain("soft-warning");
    // Names the consequence, not just the ratio.
    expect(html.toLowerCase()).toContain("credit");
  });

  it("names the downstream consequence, not just the ratio (§4.5)", () => {
    const html = render(PLAN_DEFAULTS);
    // The ratio is shown, but the copy must go further than "you're over 28%".
    expect(html).toMatch(/less income is left|run out of money|everything else/i);
  });

  it("does not block: the Add event button stays enabled alongside the warning", () => {
    const html = render(PLAN_DEFAULTS);
    expect(html).toContain("soft-warning");
    expect(html).not.toContain("disabled");
    expect(html).toContain("Add event");
  });

  it("stays silent when the purchase sits comfortably within the guideline", () => {
    // The same default $300k / $60k down purchase against a $50,000/mo gross
    // income: ≈$1,516/mo is ~3% front-end, well under 28%.
    const html = render(setMonthlyIncome(PLAN_DEFAULTS, dollarsToCents(50_000)));
    expect(html).not.toContain("soft-warning");
  });
});
