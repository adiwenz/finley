/**
 * @vitest-environment node
 *
 * Home-purchase authoring form — the soft DTI warning.
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
  fundingLookup,
  nullJurisdiction,
  type FundingLookup,
  type Household,
  type Plan,
  type ProjectionSeries,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { START_YEAR } from "../../config";
import { PLAN_DEFAULTS } from "../../planDefaults";
import { setJobMonthlyIncome } from "../../planPeople";
import { HomePurchaseForm } from "./homePurchaseForm";

const noop = () => {};

function build(budget: Plan): {
  household: Household;
  series: ProjectionSeries;
  funding: FundingLookup;
} {
  const base = createProjectionBase(budget, { jurisdiction: usJurisdiction, startYear: START_YEAR });
  return {
    household: interpretLedger(emptyLedger, base),
    series: replayLedger(emptyLedger, base, nullJurisdiction),
    // The picker's pool and coverage line come from the engine, under the SAME jurisdiction
    // the app runs — so what it renders is what `addEvent` would decide.
    funding: fundingLookup(emptyLedger, base, usJurisdiction),
  };
}

function render(budget: Plan, month = 0) {
  const { household, series, funding } = build(budget);
  return renderToStaticMarkup(
    <HomePurchaseForm
      defaultMonth={month}
      nextId={0}
      horizonMonths={660}
      onAdd={noop}
      household={household}
      series={series}
      funding={funding}
    />,
  );
}

describe("HomePurchaseForm — soft DTI warning", () => {
  it("surfaces a soft warning when the purchase exceeds the DTI guideline", () => {
    // Default: $300k / $60k down / 6.5% / 30yr ≈ $1,516/mo on $5,000 gross →
    // ~30% front-end, above the 28% guideline.
    const html = render(PLAN_DEFAULTS);
    expect(html).toContain("soft-warning");
    // Names the consequence, not just the ratio.
    expect(html.toLowerCase()).toContain("credit");
  });

  it("names the downstream consequence, not just the ratio", () => {
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
    const html = render(setJobMonthlyIncome(PLAN_DEFAULTS, "job-1", dollarsToCents(50_000)));
    expect(html).not.toContain("soft-warning");
  });
});

// ─── The ordered down-payment source picker (#156) ───────────────────────────
// The down payment was hardcoded to drain "savings"; it now drains the accounts the
// user picks, in the order picked. These pin what the control SHOWS — the engine's own
// pool and after-tax coverage — so the form can never promise what §4.5 would refuse.

describe("HomePurchaseForm — down-payment source picker", () => {
  it("lists each fundable account with what it holds at that month", () => {
    // The default plan opens with $10,000 in cash savings; the goal funds are still
    // empty at month 0, so they are not offered (an empty account funds nothing).
    const html = render(PLAN_DEFAULTS);
    expect(html).toContain("Down payment paid from");
    expect(html).toContain("Cash savings");
    expect(html).toContain("$10,000");
  });

  it("offers a goal fund by name once it holds money, largest first", () => {
    // By month 60 the plan's two savings goals have accumulated, so all three liquid
    // accounts are offered — a cash goal fund included, since it is genuinely reachable.
    const html = render(PLAN_DEFAULTS, 60);
    expect(html).toContain("Emergency fund");
    expect(html).toContain("Home down payment");
    // Retirement is not liquid and never appears as a way to pay for a house.
    expect(html).not.toContain("Retirement account");
  });

  it("states the shortfall against the SELECTED accounts, not total net worth", () => {
    // $10,000 of cash savings against a $60,000 down payment: the form says so while the
    // user is still editing, rather than letting them submit into the §4.5 block.
    const html = render(PLAN_DEFAULTS);
    expect(html).toContain("$50,000 short");
  });
});
