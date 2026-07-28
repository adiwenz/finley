/**
 * @vitest-environment node
 *
 * One-Time Spend authoring form (#154). Rendered through the server renderer (this
 * repo's jsdom is unavailable). These pin the *wiring*: that the form reuses the
 * ordered funding-source picker, showing the engine's own pool and after-tax coverage,
 * so what it renders is exactly what `addEvent`'s hard block would decide — the user
 * learns a shortfall while editing rather than from a red alert after submitting.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  emptyLedger,
  createProjectionBase,
  fundingLookup,
  type FundingLookup,
  type Plan,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { START_YEAR } from "../../config";
import { PLAN_DEFAULTS } from "../../planDefaults";
import { SpendForm } from "./spendForm";

const noop = () => {};

function buildFunding(budget: Plan): FundingLookup {
  const base = createProjectionBase(budget, { jurisdiction: usJurisdiction, startYear: START_YEAR });
  // The picker's pool and coverage line come from the engine, under the SAME jurisdiction the
  // app runs — so what it renders is what `addEvent` would decide.
  return fundingLookup(emptyLedger, base, usJurisdiction);
}

function render(budget: Plan, month = 0) {
  return renderToStaticMarkup(
    <SpendForm
      defaultMonth={month}
      nextId={0}
      horizonMonths={660}
      onAdd={noop}
      funding={buildFunding(budget)}
    />,
  );
}

describe("SpendForm — ordered funding-source picker", () => {
  it("lists each fundable account with what it holds at that month", () => {
    // The default plan opens with $10,000 in cash savings. "Year 0" is month 0 — the
    // flow-free opening snapshot — so a spend authored there is drained in month 1, and the
    // picker prices month 1 to match: $10,008 after one month of interest and saving.
    const html = render(PLAN_DEFAULTS);
    expect(html).toContain("Spending paid from");
    expect(html).toContain("Cash savings");
    expect(html).toContain("$10,008");
  });

  it("states the shortfall against the SELECTED accounts while editing", () => {
    // $10,000 of cash savings against a larger default spend: the form says so before the user
    // can submit into the hard block.
    const html = render(PLAN_DEFAULTS);
    expect(html).toMatch(/short/i);
  });

  it("offers an Add event button that never blocks in the UI", () => {
    // The only hard block (source coverage) is enforced in the engine; the button itself is
    // always enabled — the coverage line, not a disabled button, is what warns.
    const html = render(PLAN_DEFAULTS);
    const button = html.match(/<button[^>]*>Add event<\/button>/)?.[0];
    expect(button).toBeDefined();
    expect(button).not.toContain("disabled");
  });
});
