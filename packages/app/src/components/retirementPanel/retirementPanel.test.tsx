/**
 * @vitest-environment node
 *
 * Render coverage for the Retirement panel via the server renderer (jsdom is unavailable
 * here). The headline/target math lives in retirementView.test.ts; these pin the wiring.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Projection, dollarsToCents } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { stateOf } from "../../testing/projectionHarness";
import { RetirementPanel } from "./retirementPanel";
import { retirementView, type RetirementView } from "../../retirementView";
import { PLAN_DEFAULTS } from "../../planDefaults";
import type { Plan } from "@finley/engine";

const noop = () => {};

function render(budget: Plan) {
  return renderToStaticMarkup(
    <RetirementPanel
      view={retirementView(Projection.fromState(stateOf(budget), usJurisdiction))}
      budget={budget}
      previewing={false}
      onTogglePreview={noop}
    />,
  );
}

function renderWithView(view: RetirementView, previewing = false) {
  return renderToStaticMarkup(
    <RetirementPanel view={view} budget={PLAN_DEFAULTS} previewing={previewing} onTogglePreview={noop} />,
  );
}

/**
 * The default plan with its health spend restated. Health is a `healthcare`-category budget
 * line, so a test that used to set `healthMonthlyCents` edits the budget instead.
 */
function withHealth(dollars: number, over: Partial<Plan> = {}): Plan {
  return {
    ...PLAN_DEFAULTS,
    budgetLines: PLAN_DEFAULTS.budgetLines.map((line) =>
      line.category === "healthcare"
        ? { ...line, amountSource: { kind: "literal", monthlyCents: dollarsToCents(dollars) } }
        : line,
    ),
    ...over,
  };
}

describe("RetirementPanel", () => {
  it("surfaces the headline retirement age", () => {
    const html = render(PLAN_DEFAULTS);
    expect(html).toContain("Retirement");
    expect(html).toContain("retire");
  });

  it("shows an honest sub-100% on-track line for an infeasible pin, never the contradiction", () => {
    // The default plan pinned at 65 is infeasible (floor 78 — the home goal is a drawable
    // `retain` reserve) yet net worth stays positive throughout: the shape that printed the
    // self-contradicting "100% of the way there". Charging FICA on wages removes the
    // plan's slim savings surplus, so the feasible floor moves several years out.
    const html = render(PLAN_DEFAULTS);
    expect(html).not.toContain("on track (100%)");
    expect(html).toContain("of the way there");
    expect(html).toContain("the nearest feasible age is 76");
    expect(html).not.toContain("100% of the way there");
  });

  it("shows the pre-65 health nudge when the plan retires early and under-budgets", () => {
    const html = render(withHealth(0, { retirementAge: 55 }));
    expect(html).toContain("Medicare");
    expect(html).toContain("self-funded");
    expect(html).toContain("not advice");
  });

  it("does NOT show the health nudge when retiring at the Medicare age", () => {
    const html = render({ ...PLAN_DEFAULTS, retirementAge: 65 });
    expect(html).not.toContain("self-funded");
  });

  it("does NOT show the health nudge when the plan already budgets the benchmark", () => {
    const html = render(withHealth(5_000, { retirementAge: 55 }));
    expect(html).not.toContain("self-funded");
  });

  it("says nothing about a step at 65 — the plan no longer steps health there", () => {
    // The residual readout went with the plan fields that drove it. The panel's only health
    // copy left is the pre-65 gap nudge, which reads the authored budget line.
    const html = render({ ...PLAN_DEFAULTS, retirementAge: 65 });
    expect(html).not.toContain("From 65");
    expect(html).not.toContain("doesn’t enrol in Medicare");
  });

  it("reads the nudge off the budget's health line, the only place health is stated", () => {
    // Same retirement age, same everything but the health line: raising it clears the flag,
    // proving the panel follows the budget rather than a plan scalar.
    expect(render(withHealth(0, { retirementAge: 55 }))).toContain("self-funded");
    expect(render(withHealth(5_000, { retirementAge: 55 }))).not.toContain("self-funded");
  });
});

describe("RetirementPanel — chart preview toggle", () => {
  const feasible = retirementView(Projection.fromState(stateOf(PLAN_DEFAULTS), usJurisdiction));

  it("offers a preview toggle naming the solved headline age", () => {
    // The default plan solves to a feasible headline (age 76), so the toggle is available and
    // names the age whose charts it previews.
    expect(feasible.headlineAge).not.toBeNull();
    const html = renderWithView(feasible);
    expect(html).toContain("checkbox");
    expect(html).toContain(`Preview`);
    expect(html).toContain(String(feasible.headlineAge));
  });

  it("names the PRIMARY's own age, not a claim that every member turns it", () => {
    // `runAtStopWorkingAge` reads the headline age as the primary's timeline age and turns it
    // into one shared calendar boundary — a partner authored at a different age reaches that
    // month at a different age of their own. "everyone stopped working at 76" would claim every
    // member personally turns 76; the copy instead anchors the age to whoever it's actually the
    // primary's age (PLAN_DEFAULTS names them "Alex").
    const html = renderWithView(feasible);
    expect(html).toContain(`Alex turns`);
    expect(html).toContain(String(feasible.headlineAge));
    expect(html).not.toMatch(/everyone stopped working at\s*(<[^>]+>)?\s*\d/i);
  });

  it("falls back to 'you' when the plan has no authored name", () => {
    const unnamed = renderToStaticMarkup(
      <RetirementPanel
        view={feasible}
        budget={{ ...PLAN_DEFAULTS, name: "" }}
        previewing={false}
        onTogglePreview={noop}
      />,
    );
    expect(unnamed).toContain("you turn");
    expect(unnamed).not.toContain("undefined turns");
  });

  it("reflects the on state, so the box shows checked while previewing", () => {
    expect(renderWithView(feasible, false)).not.toContain("checked");
    expect(renderWithView(feasible, true)).toContain("checked");
  });

  it("hides the toggle when no retirement age is feasible — there is nothing to preview", () => {
    // A null headline means even working to life expectancy never survives; capping work earlier
    // could only be worse, so offering to preview it would be offering an empty hypothetical.
    const infeasible: RetirementView = { ...feasible, headlineAge: null, headlineMonth: null };
    const html = renderWithView(infeasible);
    expect(html).not.toContain("checkbox");
    expect(html).not.toContain("Preview");
  });
});
