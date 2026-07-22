/**
 * @vitest-environment node
 *
 * Render coverage for the debug panel using the server renderer (this repo's jsdom
 * is unavailable here). These pin the RESOLVED growth rates — the ones that exist
 * only on the report, never on the plan — so the panel can't silently drop back to
 * echoing plan knobs and hiding the rates the engine actually applied.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildHouseholdSimInput,
  createProjectionBase,
  emptyLedger,
  interpretLedger,
  simulateHousehold,
  summarizeSimulation,
  type ProjectionContext,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { DebugPanel } from "./debugPanel";
import { PLAN_DEFAULTS } from "../../planDefaults";
import { START_YEAR } from "../../config";
import type { Plan } from "@finley/engine";

function render(budget: Plan) {
  const ctx: ProjectionContext = { jurisdiction: usJurisdiction, startYear: START_YEAR };
  const base = createProjectionBase(budget, ctx);
  const input = buildHouseholdSimInput(interpretLedger(emptyLedger, base), base);
  const report = summarizeSimulation(input, simulateHousehold(input, usJurisdiction), {
    jurisdictionId: usJurisdiction.id,
  });
  return renderToStaticMarkup(<DebugPanel report={report} budget={budget} />);
}

describe("DebugPanel — resolved growth rates", () => {
  it("shows the income raise rate, which the plan itself does not carry", () => {
    const html = render(PLAN_DEFAULTS);
    expect(html).toContain("Growth rates (resolved)");
    // Named from the series itself, not numbered positionally; the amount is not
    // repeated here — it already appears under Monthly cash flow.
    expect(html).toContain("<dt>Income</dt><dd>3%</dd>");
  });

  it("names each expense line separately, and does not mistake an amount step for a rate change", () => {
    const html = render(PLAN_DEFAULTS);
    expect(html).toContain("<dt>Expenses</dt><dd>3%</dd>");
    // Health is a SEPARATE series with its own rate — and its amount step at Medicare
    // age must NOT read as a rate change, since the rate never moves.
    expect(html).toContain("<dt>Healthcare</dt><dd>3%</dd>");
  });

  it("reports the SS COLA and whether it was authored or inherited from CPI", () => {
    expect(render(PLAN_DEFAULTS)).toContain("3% (from CPI)");
    expect(render({ ...PLAN_DEFAULTS, benefitColaRate: 0.02 })).toContain("<dd>2%</dd>");
  });
});

describe("DebugPanel — growth rate that actually changes", () => {
  it("shows a rate CHANGE as from → to, unlike a mere amount step", () => {
    // Health inflation differing from CPI gives the two expense lines distinct rates.
    const html = render({ ...PLAN_DEFAULTS, healthInflationPct: 5 });
    expect(html).toContain("<dt>Expenses</dt><dd>3%</dd>");
    expect(html).toContain("<dt>Healthcare</dt><dd>5%</dd>");
  });
});
