/**
 * @vitest-environment node
 *
 * Home-purchase authoring form — the soft DTI warning.
 *
 * Rendered through the server renderer: these assert on markup, not interaction. The
 * arithmetic (`assessDti`, `mortgagePaymentForPurchaseCents`) is unit-tested in the engine;
 * these pin the *wiring*: a purchase above the 28%/36% DTI guidelines surfaces a NON-blocking
 * advisory naming its downstream consequence, and an affordable one stays silent.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { dollarsToCents, type Plan } from "@finley/engine";
import { PLAN_DEFAULTS } from "../../planDefaults";
import { setJobMonthlyIncome } from "../../testing/planFixtures";
import { HomePurchaseForm } from "./homePurchaseForm";
import { readerOf, runOf } from "../../testing/projectionHarness";

const noop = () => {};

function render(budget: Plan, month = 0) {
  // The facade funding read runs under the app's own jurisdiction, so what the form renders is
  // what `buyHome`'s §4.5 gate would decide.
  return renderToStaticMarkup(
    <HomePurchaseForm
      defaultMonth={month}
      horizonMonths={660}
      onAdd={noop}
      result={runOf(budget)}
      funding={readerOf(budget).funding()}
    />,
  );
}

describe("HomePurchaseForm — soft DTI warning", () => {
  it("surfaces a soft warning when the purchase exceeds the DTI guideline", () => {
    // Default: $300k / $60k down / 6.5% / 30yr ≈ $1,516/mo on $5,000 gross →
    // ~30% front-end, above the 28% guideline.
    const html = render(PLAN_DEFAULTS);
    expect(html).toContain("soft-warning");
    expect(html.toLowerCase()).toContain("credit");
  });

  it("names the downstream consequence, not just the ratio", () => {
    const html = render(PLAN_DEFAULTS);
    expect(html).toMatch(/less income is left|run out of money|everything else/i);
  });

  it("does not block: the Add event button stays enabled alongside the warning", () => {
    const html = render(PLAN_DEFAULTS);
    expect(html).toContain("soft-warning");
    // The BUTTON specifically — not "no `disabled` anywhere", which the funding picker
    // legitimately trips by disabling accounts holding nothing at the chosen month.
    const button = html.match(/<button[^>]*>Add event<\/button>/)?.[0];
    expect(button).toBeDefined();
    expect(button).not.toContain("disabled");
  });

  it("stays silent when the purchase sits comfortably within the guideline", () => {
    // The same $300k / $60k down purchase against $50,000/mo gross: ≈$1,516/mo is ~3%
    // front-end, well under 28%.
    const html = render(setJobMonthlyIncome(PLAN_DEFAULTS, PLAN_DEFAULTS.primary.jobs[0]!.id, dollarsToCents(50_000)));
    expect(html).not.toContain("soft-warning");
  });
});

// The ordered down-payment source picker: the payment drains the accounts the user picks, in
// the order picked (it was once hardcoded to "savings"). These pin what the control SHOWS —
// the engine's own pool and after-tax coverage — so the advisory names the same shortfall the
// authoring gate would refuse the purchase on.

describe("HomePurchaseForm — down-payment source picker", () => {
  it("lists each fundable account with what it holds at that month", () => {
    // The default plan opens with $10,000 cash savings; the goal funds are still at $0 at
    // month 0, so they are listed but unpickable.
    const html = render(PLAN_DEFAULTS);
    expect(html).toContain("Down payment paid from");
    expect(html).toContain("Cash savings");
    expect(html).toContain("$10,000");
  });

  it("offers a goal fund by name once it holds money, largest first", () => {
    // By month 60 both savings goals have accumulated, so all three liquid accounts can
    // pay — a cash goal fund included, since it is genuinely reachable.
    const html = render(PLAN_DEFAULTS, 60);
    expect(html).toContain("Emergency fund");
    expect(html).toContain("Home down payment");
    // Retirement is not liquid and never appears as a way to pay for a house.
    expect(html).not.toContain("Retirement account");
  });

  it("states the shortfall against the SELECTED accounts, not total net worth", () => {
    // $10,000 cash savings against a $60,000 down payment, said while the user is still editing —
    // the advisory that precedes the projection block, not a submit-time refusal (there is none).
    const html = render(PLAN_DEFAULTS);
    expect(html).toContain("$50,000 short");
  });
});
