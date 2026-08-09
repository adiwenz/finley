/**
 * @vitest-environment node
 *
 * Render-only GoalsPanel coverage. Goal funding/progress math belongs to the engine; this suite
 * supplies the public progress answer and tests only the panel's presentation and controls.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { GoalPlan, Plan } from "@finley/engine";
import { PLAN_DEFAULTS } from "../../planDefaults";
import type { Transact } from "../../hooks/useProjection";
import { GoalsPanel } from "./goalsPanel";

const noWrites: Transact = () => undefined;

const goals: GoalPlan[] = [
  {
    id: "emergency",
    name: "Emergency fund",
    targetCents: 1_000_000,
    targetDate: 24,
    disposition: "retain",
    annualReturnPct: 1,
  },
  {
    id: "home",
    name: "Home down payment",
    targetCents: 6_000_000,
    targetDate: 60,
    disposition: "retain",
    annualReturnPct: 7,
  },
];

const budget: Plan = { ...PLAN_DEFAULTS, goals };
const projection = { eventsFundedByGoal: () => [] } as any;

function result(progress: readonly any[]) {
  return { goalProgress: () => progress } as any;
}

function render(progress: readonly any[], plan: Plan = budget) {
  return renderToStaticMarkup(
    <GoalsPanel budget={plan} projection={projection} result={result(progress)} transact={noWrites} />,
  );
}

const inProgress = (goal: GoalPlan, priority: number, fraction = 0.5, risk = false) => ({
  goal: { ...goal, priority },
  progress: { onTrackFraction: fraction, shortHorizonRiskFlag: risk, completion: "inProgress" },
});

describe("GoalsPanel", () => {
  it("renders goal names, progress, targets and dispositions from the view data", () => {
    const html = render([inProgress(goals[0], 0, 0.8), inProgress(goals[1], 1, 0.4)]);
    expect(html).toContain("Emergency fund");
    expect(html).toContain("80% on track");
    expect(html).toContain("Home down payment");
    expect(html).toContain("40% on track");
    expect(html).toContain("Kept as a reserve");
  });

  it("renders Funded instead of a pacing percentage for a completed goal", () => {
    const html = render([
      {
        goal: { ...goals[0], priority: 0 },
        progress: { onTrackFraction: 1.2, shortHorizonRiskFlag: false, completion: "funded" },
      },
      inProgress(goals[1], 1),
    ]);
    expect(html).toContain("Funded");
    expect(html).not.toContain("120% on track");
  });

  it("renders Behind pace only for an in-progress goal below pace", () => {
    const html = render([inProgress(goals[0], 0, 0.5), inProgress(goals[1], 1, 1)]);
    expect(html).toContain("In progress · Behind pace");
  });

  it("renders the short-horizon risk warning when the supplied row flags it", () => {
    const html = render([inProgress(goals[0], 0), inProgress(goals[1], 1, 0.5, true)]);
    expect(html).toContain("market-risk account");
  });

  it("renders reorder, edit, and delete controls with boundary moves disabled", () => {
    const html = render([inProgress(goals[0], 0), inProgress(goals[1], 1)]);
    expect(html).toMatch(/aria-label="Move Emergency fund up"[^>]*disabled/);
    expect(html).not.toMatch(/aria-label="Move Emergency fund down"[^>]*disabled/);
    expect(html).not.toMatch(/aria-label="Move Home down payment up"[^>]*disabled/);
    expect(html).toMatch(/aria-label="Move Home down payment down"[^>]*disabled/);
    expect(html).toContain('aria-label="Edit Emergency fund"');
    expect(html).toContain('aria-label="Delete Emergency fund"');
  });

  it("renders the add trigger but keeps the authoring form closed initially", () => {
    const html = render([inProgress(goals[0], 0), inProgress(goals[1], 1)]);
    expect(html).toContain("+ Add a goal");
    expect(html).not.toContain('aria-label="Add goal"');
  });

  it("renders the empty state without needing an engine run", () => {
    const html = render([], { ...PLAN_DEFAULTS, goals: [] });
    expect(html).toContain("No goals yet");
    expect(html).toContain("+ Add a goal");
  });
});
