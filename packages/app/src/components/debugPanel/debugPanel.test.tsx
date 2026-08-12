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
import { runOf } from "../../testing/projectionHarness";
import { PLAN_DEFAULTS } from "../../planDefaults";
import { PRIMARY_PERSON_ID } from "@finley/engine";
import type { MonthlyWages, Plan, ProjectionMonth } from "@finley/engine";

// The debug panel reads a `SimulationReport` (`ProjectionResult.report`) — everything it shows
// comes off the very series the app draws, so it can never disagree with the engine. One `runOf`
// yields the whole pass the app would produce (defaults to usJurisdiction).
function render(budget: Plan) {
  const result = runOf(budget);
  return renderToStaticMarkup(
    <DebugPanel report={result.report} budget={budget} month0={result.series.months[0]!} />,
  );
}

/**
 * Renders with the primary person's month-0 wages REPLACED by a stated record. The panel prints
 * what the engine put there and derives nothing, so a test of the readout states the engine's
 * answer directly — whether that answer is right for a given set of jobs is settled in the
 * engine's own `wagesByOwner` tests, not by grepping this HTML.
 */
function renderWithWages(wages: MonthlyWages) {
  const result = runOf(PLAN_DEFAULTS);
  const real = result.series.months[0]!;
  const month0: ProjectionMonth = {
    ...real,
    flows: { ...real.flows!, wagesByOwner: { [PRIMARY_PERSON_ID]: wages } },
  };
  return renderToStaticMarkup(
    <DebugPanel report={result.report} budget={PLAN_DEFAULTS} month0={month0} />,
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

describe("DebugPanel — the monthly cash-flow readout prints what the engine stated", () => {
  it("shows the pay, job count and blended deferral the projection reported", () => {
    const html = renderWithWages({
      jobCount: 2,
      grossCents: 12_345_00,
      deferralCents: 1_234_50,
      deferralFraction: 0.1,
    });
    expect(html).toContain("<dt>Income (2 jobs)</dt><dd>$12,345</dd>");
    expect(html).toContain("<dt>Retirement deferral (blended)</dt><dd>10%</dd>");
  });

  it("counts the jobs that PAID, so an authored job the engine did not pay is not among them", () => {
    // The plan behind this render authors a job, and the panel still says one — because the
    // engine said one. Were the label counting `budget.primary.jobs`, this record could not
    // change it.
    const html = renderWithWages({
      jobCount: 0,
      grossCents: 0,
      deferralCents: 0,
      deferralFraction: 0,
    });
    expect(PLAN_DEFAULTS.primary.jobs.length).toBeGreaterThan(0);
    expect(html).toContain("<dt>Income (0 jobs)</dt><dd>$0</dd>");
    expect(html).toContain("<dt>Retirement deferral (blended)</dt><dd>0%</dd>");
  });

  it("says one job in the singular", () => {
    const html = renderWithWages({
      jobCount: 1,
      grossCents: 5_000_00,
      deferralCents: 0,
      deferralFraction: 0,
    });
    expect(html).toContain("<dt>Income (1 job)</dt><dd>$5,000</dd>");
  });

  it("reads an earner the projection never mentioned as no wages at all, rather than blank", () => {
    // A retiree's month has no wage entry for anyone. The panel must print zeros, not `NaN%`
    // or an empty cell, and it must not fall back to reading the plan's jobs.
    const result = runOf(PLAN_DEFAULTS);
    const real = result.series.months[0]!;
    const html = renderToStaticMarkup(
      <DebugPanel
        report={result.report}
        budget={PLAN_DEFAULTS}
        month0={{ ...real, flows: { ...real.flows!, wagesByOwner: {} } }}
      />,
    );
    expect(html).toContain("<dt>Income (0 jobs)</dt><dd>$0</dd>");
    expect(html).toContain("<dt>Retirement deferral (blended)</dt><dd>0%</dd>");
  });
});
