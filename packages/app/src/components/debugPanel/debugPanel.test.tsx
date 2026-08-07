/**
 * @vitest-environment node
 *
 * Render coverage for the debug panel via the server renderer (jsdom is unavailable here).
 * Pins the RESOLVED growth rates — those exist only on the report, never on the plan — so
 * the panel can't drop back to echoing plan knobs and hiding what the engine applied.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DebugPanel } from "./debugPanel";
import { runOf, readerOf } from "../../testing/projectionHarness";
import { PLAN_DEFAULTS } from "../../planDefaults";
import type { Plan } from "@finley/engine";

// The debug panel reads a `SimulationReport` (`ProjectionResult.report`) and a `Projection`.
// One `runOf` yields the whole pass the app would produce (defaults to usJurisdiction), so the
// report the panel shows is derived from the very series the app draws — no hand-assembled
// pipeline.
function render(budget: Plan) {
  const result = runOf(budget);
  return renderToStaticMarkup(
    <DebugPanel report={result.report} budget={budget} projection={readerOf(budget)} />,
  );
}

describe("DebugPanel — resolved growth rates", () => {
  it("shows the income raise rate, which the plan itself does not carry", () => {
    const html = render(PLAN_DEFAULTS);
    expect(html).toContain("Growth rates (resolved)");
    // Named from the series itself — an untitled job by its owner ("Alex's job"), since a
    // minted id names nothing to a reader. The amount is not repeated; it appears under
    // Monthly cash flow.
    expect(html).toContain("<dt>Income · Alex&#x27;s job</dt><dd>3%</dd>");
  });

  it("names each expense line separately, and does not mistake an amount step for a rate change", () => {
    const html = render(PLAN_DEFAULTS);
    // The default plan authors a line-item budget, so each standing line is its own named
    // series rather than one lumped "Expenses" row. Lines are authored in today's dollars
    // and rise with CPI.
    expect(html).toContain("<dt>Housing</dt><dd>3%</dd>");
    expect(html).toContain("<dt>Groceries</dt><dd>3%</dd>");
    // Health is one of those lines now, not a plan-level series with a rate of its own.
    expect(html).toContain("<dt>Healthcare</dt><dd>3%</dd>");
  });

  it("reports the SS COLA and whether it was authored or inherited from CPI", () => {
    expect(render(PLAN_DEFAULTS)).toContain("3% (from CPI)");
    expect(render({ ...PLAN_DEFAULTS, benefitColaRate: 0.02 })).toContain("<dd>2%</dd>");
  });
});

describe("DebugPanel — rates that differ between series", () => {
  it("reports a job's real growth apart from the CPI every expense line inherits", () => {
    // Nothing in an authored plan varies a rate WITHIN one series any more: health was the
    // only series compiled with its own rate, and it is an ordinary CPI-grown budget line
    // now. What still differs is BETWEEN series — a job with real growth outruns CPI — and
    // that is what the resolved readout must not flatten.
    const [job] = PLAN_DEFAULTS.primary.jobs;
    const html = render({
      ...PLAN_DEFAULTS,
      primary: {
        ...PLAN_DEFAULTS.primary,
        jobs: [{ ...job!, salary: { ...job!.salary, realGrowthPct: 2 } }],
      },
    });
    expect(html).toContain("<dt>Housing</dt><dd>3%</dd>");
    expect(html).toContain("<dt>Healthcare</dt><dd>3%</dd>");
    expect(html).not.toContain("<dt>Income · Alex&#x27;s job</dt><dd>3%</dd>");
  });
});
