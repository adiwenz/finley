/**
 * @vitest-environment node
 *
 * Render coverage for the Retirement panel via the server renderer (jsdom is unavailable
 * here). The headline/target math lives in retirementView.test.ts; these pin the wiring.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { dollarsToCents, scenarioOf } from "@finley/engine";
import { RetirementPanel } from "./retirementPanel";
import { retirementView } from "../../retirementView";
import { PLAN_DEFAULTS } from "../../planDefaults";
import type { Plan } from "@finley/engine";

function render(budget: Plan) {
  return renderToStaticMarkup(
    <RetirementPanel view={retirementView(scenarioOf(budget))} budget={budget} />,
  );
}

describe("RetirementPanel", () => {
  it("surfaces the headline retirement age", () => {
    const html = render(PLAN_DEFAULTS);
    expect(html).toContain("Retirement");
    expect(html).toContain("retire");
  });

  it("shows an honest sub-100% on-track line for an infeasible pin, never the contradiction", () => {
    // The default plan pinned at 65 is infeasible (floor 71 — the home goal is a drawable
    // `retain` reserve) yet net worth stays positive throughout: the shape that printed the
    // self-contradicting "100% of the way there".
    const html = render(PLAN_DEFAULTS);
    expect(html).not.toContain("on track (100%)");
    expect(html).toContain("of the way there");
    expect(html).toContain("the nearest feasible age is 71");
    expect(html).not.toContain("100% of the way there");
  });

  it("shows the pre-65 health nudge when the plan retires early and under-budgets", () => {
    const budget: Plan = {
      ...PLAN_DEFAULTS,
      retirementAge: 55,
      healthMonthlyCents: 0,
    };
    const html = render(budget);
    expect(html).toContain("Medicare");
    expect(html).toContain("self-funded");
    expect(html).toContain("not advice");
  });

  it("does NOT show the health nudge when retiring at the Medicare age", () => {
    const html = render({ ...PLAN_DEFAULTS, retirementAge: 65 });
    expect(html).not.toContain("self-funded");
  });

  it("does NOT show the health nudge when the plan already budgets the benchmark", () => {
    const html = render({
      ...PLAN_DEFAULTS,
      retirementAge: 55,
      healthMonthlyCents: dollarsToCents(5000),
    });
    expect(html).not.toContain("self-funded");
  });

  it("shows the authored Medicare residual step at 65 when enrolling", () => {
    // No pre-65 gap when retiring at 65, but the downward step at 65 is still surfaced.
    const html = render({ ...PLAN_DEFAULTS, retirementAge: 65 });
    expect(html).not.toContain("self-funded"); // the pre-65 nudge is hidden
    expect(html).toContain("From 65"); // the authored residual step is shown
    expect(html).toContain("Medicare");
    expect(html).toContain("not advice");
  });

  it("tells the self-funded-for-life story when NOT enrolling in Medicare", () => {
    const html = render({ ...PLAN_DEFAULTS, retirementAge: 65, enrollsInPublicHealthCoverage: false });
    expect(html).toContain("doesn’t enrol in Medicare");
    expect(html).toContain("for life");
    expect(html).not.toContain("From 65"); // no residual step in this story
  });
});
