/**
 * @vitest-environment node
 *
 * Pure presentation coverage. The engine owns retirement solving; this suite gives the panel
 * controlled RetirementView values and tests only the copy/structure it renders from them.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PRIMARY_PERSON_ID, type Plan } from "@finley/engine";
import { PLAN_DEFAULTS } from "../../planDefaults";
import type { RetirementView } from "../../retirementView";
import { RetirementPanel } from "./retirementPanel";

const noop = () => {};

const baseView: RetirementView = {
  headlineAge: 64,
  headlineMonth: 348,
  blocked: false,
  blockedAtAge: null,
  plannedWorkStopAge: 65,
  authoredPlanSurvives: true,
  earlyRetireeHealth: { flagged: false, gapYears: 0, shortfallMonthlyCents: 0 },
  continuedJobs: [],
  horizonAge: 90,
  horizonMemberName: null,
};

function render(view: RetirementView = baseView, previewing = false, budget: Plan = PLAN_DEFAULTS) {
  return renderToStaticMarkup(
    <RetirementPanel
      view={view}
      budget={budget}
      previewing={previewing}
      onTogglePreview={noop}
    />,
  );
}

describe("RetirementPanel", () => {
  it("renders the authored plan and earliest-stop answer as separate results", () => {
    const html = render();
    expect(html).toContain("<h3>Current plan</h3>");
    expect(html).toContain("scheduled to end by the time you turn <strong>65</strong>");
    expect(html).toContain("<h3>Earliest you could stop all work</h3>");
    expect(html).toContain('aria-label="Earliest feasible retirement age">64</strong>');
  });

  it("renders authored-plan failure independently of the feasible headline", () => {
    const html = render({ ...baseView, authoredPlanSurvives: false });
    expect(html).toContain("This plan runs out of money before your life expectancy (age 90)");
    expect(html).toContain('aria-label="Earliest feasible retirement age">64</strong>');
  });

  it("renders the no-jobs state without inventing a planned stop age", () => {
    const html = render({ ...baseView, plannedWorkStopAge: null });
    expect(html).toContain("Your plan holds no jobs, so it earns nothing from work.");
    expect(html).not.toContain("scheduled to end by the time you turn");
  });

  it("renders a blocked answer instead of retirement claims", () => {
    const html = render({ ...baseView, blocked: true, blockedAtAge: 47, headlineAge: null, headlineMonth: null });
    expect(html).toContain("<strong>blocked at age 47</strong>");
    expect(html).not.toContain("Earliest you could stop all work");
  });

  it("renders an infeasible unblocked answer and hides the preview toggle", () => {
    const html = render({ ...baseView, headlineAge: null, headlineMonth: null });
    expect(html).toContain("no retirement age is feasible");
    expect(html).not.toContain("Preview the charts");
  });

  it("names whose life expectancy defines the horizon", () => {
    expect(render()).toContain("your life expectancy (age 90)");
    expect(render({ ...baseView, horizonAge: 94, horizonMemberName: "Sam" })).toContain(
      "Sam’s life expectancy (age 94)",
    );
  });

  it("labels the preview using the primary's own name and reflects checked state", () => {
    const namedBudget: Plan = {
      ...PLAN_DEFAULTS,
      primary: { ...PLAN_DEFAULTS.primary, name: "Alex" },
    };
    const html = render(baseView, true, namedBudget);
    expect(html).toContain("Alex turns <strong>64</strong>");
    expect(html).toContain('type="checkbox" checked=""');
  });

  it("falls back to second-person preview wording for an unnamed primary", () => {
    const budget: Plan = {
      ...PLAN_DEFAULTS,
      primary: { ...PLAN_DEFAULTS.primary, name: "" },
    };
    expect(render(baseView, false, budget)).toContain("you turn <strong>64</strong>");
  });

  it("makes a continued-job headline conditional", () => {
    const view: RetirementView = {
      ...baseView,
      continuedJobs: [
        {
          jobId: "job-1",
          jobLabel: "Alex's job",
          jobName: "Engineering",
          ownerId: PRIMARY_PERSON_ID,
          ownerName: "Alex",
          throughAge: 68,
          throughYear: 2059,
          overlaps: [],
        },
      ],
    };
    const html = render(view);
    expect(html).toContain("You could stop working at");
    expect(html).toContain("your <strong>Engineering</strong> job continued through when you are 68 (2059)");
  });

  it("uses a partner's name and clock for their continued job", () => {
    const view: RetirementView = {
      ...baseView,
      continuedJobs: [
        {
          jobId: "job-2",
          jobLabel: "Sam's job",
          jobName: "Nursing",
          ownerId: "partner-1",
          ownerName: "Sam",
          throughAge: 61,
          throughYear: 2059,
          overlaps: [],
        },
      ],
    };
    const html = render(view);
    expect(html).toContain("Sam’s <strong>Nursing</strong> job continued through when Sam is 61 (2059)");
  });

  it("renders overlap disclosure from the view rather than deriving it", () => {
    const view: RetirementView = {
      ...baseView,
      continuedJobs: [
        {
          jobId: "job-1",
          jobLabel: "Alex's job",
          jobName: "Engineering",
          ownerId: PRIMARY_PERSON_ID,
          ownerName: "Alex",
          throughAge: 68,
          throughYear: 2059,
          overlaps: [
            {
              jobId: "job-2",
              jobLabel: "Consulting",
              jobName: "Consulting",
              fromAge: 62,
              toAge: 65,
              fromYear: 2053,
              toYear: 2056,
            },
          ],
        },
      ],
    };
    const html = render(view);
    expect(html).toContain("continued alongside");
    expect(html).toContain("from when you are 62 to 65 (2053–2056)");
  });

  it("renders the early-retiree health nudge only when the view flags it", () => {
    const flagged = render({
      ...baseView,
      headlineAge: 58,
      earlyRetireeHealth: { flagged: true, gapYears: 7, shortfallMonthlyCents: 60_000 },
    });
    expect(flagged).toContain("Retiring at 58");
    expect(flagged).toContain("7 years");
    expect(flagged).toContain("$600/mo");

    expect(render(baseView)).not.toContain("self-funded health coverage");
  });
});
