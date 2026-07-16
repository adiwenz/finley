/**
 * @vitest-environment node
 *
 * Render coverage for the Retirement panel using the server renderer (this repo's
 * jsdom is unavailable here). The headline/target math is covered by
 * retirementView.test.ts; these pin the wiring — the headline age surfaced and the
 * Medicare early-retiree health nudge shown (and hidden) per the honesty flag (§5.4).
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { dollarsToCents } from "@finley/engine";
import { RetirementPanel } from "./retirementPanel";
import { retirementView } from "../../retirementView";
import { PLAN_DEFAULTS } from "../../planDefaults";
import type { Plan } from "@finley/engine";

function render(budget: Plan) {
  return renderToStaticMarkup(<RetirementPanel view={retirementView(budget)} budget={budget} />);
}

describe("RetirementPanel", () => {
  it("surfaces the headline retirement age (§7)", () => {
    const html = render(PLAN_DEFAULTS);
    expect(html).toContain("Retirement");
    expect(html).toContain("retire");
  });

  it("shows the pre-65 health nudge when the plan retires early and under-budgets (§5.4)", () => {
    const budget: Plan = {
      ...PLAN_DEFAULTS,
      retirementAge: 55,
      healthMonthlyCents: 0,
    };
    const html = render(budget);
    expect(html).toContain("Medicare");
    expect(html).toContain("self-funded");
    // Estimates-not-advice framing is visible on the nudge.
    expect(html).toContain("not advice");
  });

  it("does NOT show the health nudge when retiring at the Medicare age (§5.4)", () => {
    const html = render({ ...PLAN_DEFAULTS, retirementAge: 65 });
    expect(html).not.toContain("self-funded");
  });

  it("does NOT show the health nudge when the plan already budgets the benchmark (§5.4)", () => {
    const html = render({
      ...PLAN_DEFAULTS,
      retirementAge: 55,
      healthMonthlyCents: dollarsToCents(5000),
    });
    expect(html).not.toContain("self-funded");
  });

  it("shows the authored Medicare residual step at 65 when enrolling (§5.4)", () => {
    // Retiring at 65 has no pre-65 gap, but the downward step at 65 is still surfaced.
    const html = render({ ...PLAN_DEFAULTS, retirementAge: 65 });
    expect(html).not.toContain("self-funded"); // the pre-65 nudge is hidden
    expect(html).toContain("From 65"); // the authored residual step is shown
    expect(html).toContain("Medicare");
    expect(html).toContain("not advice");
  });

  it("tells the self-funded-for-life story when NOT enrolling in Medicare (§5.4)", () => {
    const html = render({ ...PLAN_DEFAULTS, retirementAge: 65, enrollsInMedicare: false });
    expect(html).toContain("doesn’t enrol in Medicare");
    expect(html).toContain("for life");
    expect(html).not.toContain("From 65"); // no residual step in this story
  });
});
