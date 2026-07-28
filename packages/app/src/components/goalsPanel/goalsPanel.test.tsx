/**
 * @vitest-environment node
 *
 * Render coverage for the Goals + Budget panels via the server renderer (jsdom is
 * unavailable here). Interaction and the priority tradeoff live in goalsView.test.ts; these
 * pin the wiring — on-track % surfaced, honesty flag shown, and the person-partitioned
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
  it("shows each goal's projection-based on-track % and name", () => {
    const html = renderToStaticMarkup(
      <GoalsPanel budget={PLAN_DEFAULTS} series={project(PLAN_DEFAULTS)} setBudget={noop} />,
    );
    expect(html).toContain("Emergency fund");
    expect(html).toContain("Home down payment");
    expect(html).toContain("on track");
  });

  it("surfaces each goal's disposition — the fate of the money at target", () => {
    const html = renderToStaticMarkup(
      <GoalsPanel budget={PLAN_DEFAULTS} series={project(PLAN_DEFAULTS)} setBudget={noop} />,
    );
    // Both default goals are `retain` savings reserves (planDefaults).
    expect(html).toContain("Kept as a reserve");
  });

  it("shows a Funded badge once a goal's projected fund reaches target on/before the date", () => {
    // $5,000 target off the default surplus fills long before the 24-month date.
    const budget: Plan = {
      ...PLAN_DEFAULTS,
      goals: [
        {
          id: "car",
          name: "New car",
          targetCents: dollarsToCents(5000),
          targetDate: 24,
          disposition: "retain",
          annualReturnPct: 0,
        },
      ],
    };
    const html = renderToStaticMarkup(
      <GoalsPanel budget={budget} series={project(budget)} setBudget={noop} />,
    );
    expect(html).toContain("Funded");
    // Funded is terminal: the pacing % ("am I on pace to get there") is dropped so it can't
    // contradict the badge — e.g. a drained fund's low %.
    expect(html).not.toContain("on track");
  });

  it("marks an unreachable goal In progress and behind pace", () => {
    // A $10M target by month 12 is nowhere near funded off the default surplus.
    const budget: Plan = {
      ...PLAN_DEFAULTS,
      goals: [
        {
          id: "moon",
          name: "Moon base",
          targetCents: dollarsToCents(10_000_000),
          targetDate: 12,
          disposition: "retain",
          annualReturnPct: 0,
        },
      ],
    };
    const html = renderToStaticMarkup(
      <GoalsPanel budget={budget} series={project(budget)} setBudget={noop} />,
    );
    expect(html).toContain("In progress");
    expect(html).toContain("Behind pace");
    // The on-track % is the pacing signal, shown while a goal is still In progress.
    expect(html).toContain("on track");
  });

  it("shows the short-horizon-in-risky-account honesty flag", () => {
    // One near-term goal in a 7% account → the flag fires.
    const budget: Plan = {
      ...PLAN_DEFAULTS,
      goals: [
        {
          id: "trip",
          name: "Trip",
          targetCents: dollarsToCents(5000),
          targetDate: 12,
          disposition: "retain",
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

  it("offers per-goal edit and delete authoring controls", () => {
    const html = renderToStaticMarkup(
      <GoalsPanel budget={PLAN_DEFAULTS} series={project(PLAN_DEFAULTS)} setBudget={noop} />,
    );
    expect(html).toContain("Edit Emergency fund");
    expect(html).toContain("Delete Emergency fund");
  });

  it("discloses the add-goal form on demand, not always open", () => {
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

  it("partitions into a member section plus a Shared section", () => {
    expect(html).toContain("’s budget"); // member section aria-label
    expect(html).toContain('aria-label="Shared"');
  });

  it("discloses advanced controls behind a summary", () => {
    expect(html).toContain("<summary>Advanced</summary>");
    // The account-return knobs are the disclosed levers; the 401(k) deferral lives on jobs,
    // not here.
    expect(html).toContain("Retirement return");
    expect(html).not.toContain("401(k) contribution");
  });

  it("exposes the shared-scheme lever", () => {
    // No surplus-destination lever: leftover cash idles, and investing it is authored as a
    // brokerage contribution line, not a scalar toggle.
    expect(html).toContain("Shared expenses split");
    expect(html).toContain("Split evenly");
  });
});
