/**
 * @vitest-environment node
 *
 * Render coverage for the Goals + Budget panels using the server renderer, since
 * this repo's jsdom is unavailable here. Interaction (reorder) and the §5.2
 * priority tradeoff are covered by goalsView.test.ts; these pin the wiring —
 * on-track % surfaced, the honesty flag shown, and the person-partitioned
 * Budget/Accounts panel with its Shared section and four exposed levers.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { emptyLedger, replayLedger, dollarsToCents, nullJurisdiction } from "@finley/engine";
import { createProjectionBase } from "../../projectionBase";
import { GoalsPanel } from "./goalsPanel";
import { BudgetEditor } from "../budgetEditor/budgetEditor";
import { PLAN_DEFAULTS } from "../../planDefaults";
import type { BudgetValues } from "../../planTypes";

const noop = () => {};

function project(budget: BudgetValues) {
  return replayLedger(emptyLedger, createProjectionBase(budget), nullJurisdiction);
}

describe("GoalsPanel", () => {
  it("shows each goal's projection-based on-track % and name (§5.2)", () => {
    const html = renderToStaticMarkup(
      <GoalsPanel budget={PLAN_DEFAULTS} series={project(PLAN_DEFAULTS)} setBudget={noop} />,
    );
    expect(html).toContain("Emergency fund");
    expect(html).toContain("Home down payment");
    expect(html).toContain("on track");
  });

  it("shows the short-horizon-in-risky-account honesty flag (§5.2)", () => {
    // One near-term goal in a 7% account → the flag fires.
    const budget: BudgetValues = {
      ...PLAN_DEFAULTS,
      goals: [
        {
          id: "trip",
          name: "Trip",
          targetCents: dollarsToCents(5000),
          targetDate: 12,
          type: "oneTime",
          annualReturnPct: 7,
        },
      ],
    };
    const html = renderToStaticMarkup(
      <GoalsPanel budget={budget} series={project(budget)} setBudget={noop} />,
    );
    expect(html).toContain("market-risk account");
  });

  it("offers priority-reorder controls per goal", () => {
    const html = renderToStaticMarkup(
      <GoalsPanel budget={PLAN_DEFAULTS} series={project(PLAN_DEFAULTS)} setBudget={noop} />,
    );
    expect(html).toContain("Move Emergency fund up");
    expect(html).toContain("Move Home down payment down");
  });
});

describe("BudgetEditor — person-partitioned panel with the four levers", () => {
  const html = renderToStaticMarkup(
    <BudgetEditor budget={PLAN_DEFAULTS} setBudget={noop} scrubMonth={0} />,
  );

  it("partitions into a member section plus a Shared section (§4.2)", () => {
    expect(html).toContain("’s budget"); // member section aria-label
    expect(html).toContain('aria-label="Shared"');
  });

  it("discloses advanced controls behind a summary (§10.4)", () => {
    expect(html).toContain("<summary>Advanced</summary>");
    expect(html).toContain("401(k) contribution"); // lever 1, disclosed
  });

  it("exposes the shared-scheme and surplus-destination levers (§5.0)", () => {
    expect(html).toContain("Shared expenses split");
    expect(html).toContain("Split evenly");
    expect(html).toContain("Sweep to investments");
  });
});
