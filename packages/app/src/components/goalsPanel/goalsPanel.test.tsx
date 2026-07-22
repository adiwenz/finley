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
import {
  emptyLedger,
  replayLedger,
  dollarsToCents,
  nullJurisdiction,
  createProjectionBase,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { START_YEAR } from "../../config";
import { GoalsPanel } from "./goalsPanel";
import { BudgetEditor } from "../budgetEditor/budgetEditor";
import { PLAN_DEFAULTS } from "../../planDefaults";
import type { Plan } from "@finley/engine";

const noop = () => {};

function project(budget: Plan) {
  return replayLedger(
    emptyLedger,
    createProjectionBase(budget, { jurisdiction: usJurisdiction, startYear: START_YEAR }),
    nullJurisdiction,
  );
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

  it("surfaces each goal's disposition — the fate of the money at target (§5.2, #28)", () => {
    const html = renderToStaticMarkup(
      <GoalsPanel budget={PLAN_DEFAULTS} series={project(PLAN_DEFAULTS)} setBudget={noop} />,
    );
    // Emergency fund → retain; Home down payment → convertToEquity (planDefaults).
    expect(html).toContain("Kept as a reserve");
    expect(html).toContain("Becomes home equity");
  });

  it("shows the short-horizon-in-risky-account honesty flag (§5.2)", () => {
    // One near-term goal in a 7% account → the flag fires.
    const budget: Plan = {
      ...PLAN_DEFAULTS,
      goals: [
        {
          id: "trip",
          name: "Trip",
          targetCents: dollarsToCents(5000),
          targetDate: 12,
          disposition: "spend",
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

  it("offers per-goal edit and delete authoring controls (Slice 5b)", () => {
    const html = renderToStaticMarkup(
      <GoalsPanel budget={PLAN_DEFAULTS} series={project(PLAN_DEFAULTS)} setBudget={noop} />,
    );
    expect(html).toContain("Edit Emergency fund");
    expect(html).toContain("Delete Emergency fund");
  });

  it("discloses the add-goal form on demand, not always open (§10.4)", () => {
    const html = renderToStaticMarkup(
      <GoalsPanel budget={PLAN_DEFAULTS} series={project(PLAN_DEFAULTS)} setBudget={noop} />,
    );
    // The disclosure trigger is present; the form itself is closed until clicked.
    expect(html).toContain("+ Add a goal");
    expect(html).not.toContain('aria-label="Add goal"');
  });

  it("invites a first goal when the plan has none", () => {
    const empty: Plan = { ...PLAN_DEFAULTS, goals: [] };
    const html = renderToStaticMarkup(
      <GoalsPanel budget={empty} series={project(empty)} setBudget={noop} />,
    );
    expect(html).toContain("No goals yet");
    expect(html).toContain("+ Add a goal");
  });
});

describe("BudgetEditor — person-partitioned panel with the four levers", () => {
  const html = renderToStaticMarkup(
    <BudgetEditor budget={PLAN_DEFAULTS} setBudget={noop} />,
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
