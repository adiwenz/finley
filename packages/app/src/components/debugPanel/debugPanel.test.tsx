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
import { PRIMARY_PERSON_ID, dollarsToCents } from "@finley/engine";
import type { Job, Plan } from "@finley/engine";
import { START_YEAR } from "../../config";

// The debug panel reads a `SimulationReport` (`ProjectionResult.report`) — everything it shows
// comes off the very series the app draws, so it can never disagree with the engine. One `runOf`
// yields the whole pass the app would produce (defaults to usJurisdiction).
function render(budget: Plan) {
  const result = runOf(budget);
  return renderToStaticMarkup(
    <DebugPanel report={result.report} budget={budget} month0={result.series.months[0]!} />,
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

describe("DebugPanel — current income/deferral come off the projection's month-0 output", () => {
  // The default plan's one job pays $5,000/mo (`DEFAULT_MONTHLY_PAY_CENTS`) and elects no
  // deferral, flat real (`realGrowthPct: 0`) — so month 0 cash flow reads exactly what was
  // authored, with nothing else in play to blur the figure.
  const [currentJob] = PLAN_DEFAULTS.primary.jobs;

  // Long ended — the household stopped receiving this pay a decade before "now".
  const pastJob: Job = {
    id: "past-job",
    ownerId: PRIMARY_PERSON_ID,
    startYear: START_YEAR - 20,
    endYear: START_YEAR - 5,
    salary: {
      startingSalaryCents: dollarsToCents(30_000),
      currentSalaryCents: dollarsToCents(30_000),
      realGrowthPct: 0,
    },
  };

  // Not started yet — a planned raise the household has not begun earning.
  const futureJob: Job = {
    id: "future-job",
    ownerId: PRIMARY_PERSON_ID,
    startYear: START_YEAR + 5,
    endYear: START_YEAR + 10,
    salary: {
      startingSalaryCents: dollarsToCents(90_000),
      currentSalaryCents: dollarsToCents(90_000),
      realGrowthPct: 0,
    },
    deferral: { deferralFraction: 0.5, fundAccountId: "retirement" },
  };

  it("does not count a past, already-ended job's pay as current income", () => {
    const html = render({
      ...PLAN_DEFAULTS,
      primary: { ...PLAN_DEFAULTS.primary, jobs: [currentJob!, pastJob] },
    });
    // Only the still-active job's $5,000/mo shows — the ended $30,000/mo job does not inflate it.
    expect(html).toContain("<dd>$5,000</dd>");
    expect(html).not.toContain("$35,000");
  });

  it("does not count a future, not-yet-started job's pay as current income", () => {
    const html = render({
      ...PLAN_DEFAULTS,
      primary: { ...PLAN_DEFAULTS.primary, jobs: [currentJob!, futureJob] },
    });
    expect(html).toContain("<dd>$5,000</dd>");
    expect(html).not.toContain("$95,000");
  });

  it("does not let a future job's deferral election skew the blended rate", () => {
    const html = render({
      ...PLAN_DEFAULTS,
      primary: { ...PLAN_DEFAULTS.primary, jobs: [currentJob!, futureJob] },
    });
    // The active job elects nothing, so the blended figure reads 0% — not tugged toward the
    // not-yet-started job's 50%.
    expect(html).toContain("<dt>Retirement deferral (blended)</dt><dd>0%</dd>");
  });
});
