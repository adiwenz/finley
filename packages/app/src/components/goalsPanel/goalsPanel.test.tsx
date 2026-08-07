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
  dollarsToCents,
} from "@finley/engine";
import { GoalsPanel } from "./goalsPanel";
import { readerOf, runOf } from "../../testing/projectionHarness";
import { BudgetEditor } from "../budgetEditor/budgetEditor";
import { PLAN_DEFAULTS } from "../../planDefaults";
import { setJobMonthlyIncome } from "../../testing/planFixtures";
import type { Transact } from "../../hooks/useProjection";
import type {
  Plan,
} from "@finley/engine";

/** Render-only tests: nothing is written, so the transaction runner never runs one. */
const noWrites: Transact = () => undefined;

describe("GoalsPanel", () => {
  it("shows each goal's projection-based on-track % and name", () => {
    const html = renderToStaticMarkup(
      <GoalsPanel budget={PLAN_DEFAULTS} projection={readerOf(PLAN_DEFAULTS)} result={runOf(PLAN_DEFAULTS)} transact={noWrites} />,
    );
    expect(html).toContain("Emergency fund");
    expect(html).toContain("Home down payment");
    expect(html).toContain("on track");
  });

  it("surfaces each goal's disposition — the fate of the money at target", () => {
    const html = renderToStaticMarkup(
      <GoalsPanel budget={PLAN_DEFAULTS} projection={readerOf(PLAN_DEFAULTS)} result={runOf(PLAN_DEFAULTS)} transact={noWrites} />,
    );
    // Both default goals are `retain` savings reserves (planDefaults).
    expect(html).toContain("Kept as a reserve");
  });

  it("shows a Funded badge once a goal's projected fund reaches target on/before the date", () => {
    // With FICA charged, the default $5k plan has essentially no surplus, so a fundable
    // goal needs a plan that actually saves: a $6,500 wage fills a $5,000 target well before
    // the 24-month date.
    const budget: Plan = {
      ...setJobMonthlyIncome(PLAN_DEFAULTS, PLAN_DEFAULTS.primary.jobs[0]!.id, dollarsToCents(6500)),
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
      <GoalsPanel budget={budget} projection={readerOf(budget)} result={runOf(budget)} transact={noWrites} />,
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
      <GoalsPanel budget={budget} projection={readerOf(budget)} result={runOf(budget)} transact={noWrites} />,
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
      <GoalsPanel budget={budget} projection={readerOf(budget)} result={runOf(budget)} transact={noWrites} />,
    );
    expect(html).toContain("market-risk account");
  });

  it("offers priority-reorder controls per goal", () => {
    const html = renderToStaticMarkup(
      <GoalsPanel budget={PLAN_DEFAULTS} projection={readerOf(PLAN_DEFAULTS)} result={runOf(PLAN_DEFAULTS)} transact={noWrites} />,
    );
    expect(html).toContain("Move Emergency fund up");
    expect(html).toContain("Move Home down payment down");
  });

  it("disables the reorder control at each end, rather than asking for a refused move", () => {
    // `Projection.reorderGoal` refuses a move that cannot happen, so the panel must not offer
    // one: an enabled button here would surface as a conflict message on a dead click.
    const html = renderToStaticMarkup(
      <GoalsPanel budget={PLAN_DEFAULTS} projection={readerOf(PLAN_DEFAULTS)} result={runOf(PLAN_DEFAULTS)} transact={noWrites} />,
    );
    // First goal cannot go up, last cannot go down; the inner moves stay live.
    expect(html).toMatch(/aria-label="Move Emergency fund up"[^>]*disabled/);
    expect(html).toMatch(/aria-label="Move Home down payment down"[^>]*disabled/);
    expect(html).not.toMatch(/aria-label="Move Emergency fund down"[^>]*disabled/);
    expect(html).not.toMatch(/aria-label="Move Home down payment up"[^>]*disabled/);
  });

  it("offers per-goal edit and delete authoring controls", () => {
    const html = renderToStaticMarkup(
      <GoalsPanel budget={PLAN_DEFAULTS} projection={readerOf(PLAN_DEFAULTS)} result={runOf(PLAN_DEFAULTS)} transact={noWrites} />,
    );
    expect(html).toContain("Edit Emergency fund");
    expect(html).toContain("Delete Emergency fund");
  });

  it("discloses the add-goal form on demand, not always open", () => {
    const html = renderToStaticMarkup(
      <GoalsPanel budget={PLAN_DEFAULTS} projection={readerOf(PLAN_DEFAULTS)} result={runOf(PLAN_DEFAULTS)} transact={noWrites} />,
    );
    // The disclosure trigger is present; the form itself is closed until clicked.
    expect(html).toContain("+ Add a goal");
    expect(html).not.toContain('aria-label="Add goal"');
  });

  it("invites a first goal when the plan has none", () => {
    const empty: Plan = { ...PLAN_DEFAULTS, goals: [] };
    const html = renderToStaticMarkup(
      <GoalsPanel budget={empty} projection={readerOf(empty)} result={runOf(empty)} transact={noWrites} />,
    );
    expect(html).toContain("No goals yet");
    expect(html).toContain("+ Add a goal");
  });
});

describe("BudgetEditor — person-partitioned panel with the four levers", () => {
  const html = renderToStaticMarkup(
    <BudgetEditor budget={PLAN_DEFAULTS} transact={noWrites} />,
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
