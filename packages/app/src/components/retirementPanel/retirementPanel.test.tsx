/**
 * @vitest-environment node
 *
 * Render coverage for the Retirement panel via the server renderer (jsdom is unavailable
 * here). The headline/target math lives in retirementView.test.ts; these pin the wiring.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PRIMARY_PERSON_ID, Projection, dollarsToCents } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { stateOf } from "../../testing/projectionHarness";
import { RetirementPanel } from "./retirementPanel";
import { retirementView, type RetirementView } from "../../retirementView";
import { PLAN_DEFAULTS } from "../../planDefaults";
import type { Plan } from "@finley/engine";

const noop = () => {};

function render(budget: Plan) {
  return renderToStaticMarkup(
    <RetirementPanel
      view={retirementView(Projection.fromState(stateOf(budget), usJurisdiction))}
      budget={budget}
      previewing={false}
      onTogglePreview={noop}
    />,
  );
}

function renderWithView(view: RetirementView, previewing = false) {
  return renderToStaticMarkup(
    <RetirementPanel view={view} budget={PLAN_DEFAULTS} previewing={previewing} onTogglePreview={noop} />,
  );
}

/**
 * The default plan with its health spend restated. Health is a `healthcare`-category budget
 * line, so a test that used to set `healthMonthlyCents` edits the budget instead.
 */
function withHealth(dollars: number, over: Partial<Plan> = {}): Plan {
  return {
    ...PLAN_DEFAULTS,
    budgetLines: PLAN_DEFAULTS.budgetLines.map((line) =>
      line.category === "healthcare"
        ? { ...line, amountSource: { kind: "literal", monthlyCents: dollarsToCents(dollars) } }
        : line,
    ),
    ...over,
  };
}

/**
 * A view whose solved age lands before Medicare, with the health flag the engine would have
 * raised for it. Hand-built because the flag is an engine answer: the panel's job is to print
 * it against {@link RetirementView.headlineAge}, and that is what this isolates.
 */
function earlyRetiree(flagged: boolean): RetirementView {
  return {
    ...retirementView(Projection.fromState(stateOf(PLAN_DEFAULTS), usJurisdiction)),
    headlineAge: 58,
    headlineMonth: (58 - PLAN_DEFAULTS.currentAge) * 12,
    earlyRetireeHealth: flagged
      ? { flagged: true, gapYears: 7, shortfallMonthlyCents: dollarsToCents(600) }
      : { flagged: false, gapYears: 0, shortfallMonthlyCents: 0 },
  };
}

describe("RetirementPanel", () => {
  it("surfaces the headline retirement age", () => {
    const html = render(PLAN_DEFAULTS);
    expect(html).toContain("Retirement");
    // The default plan's answer leans on a continuation, so the headline is the conditional
    // form. Asserted by the age itself rather than by the word "retire", which only one of the
    // two phrasings uses.
    const view = retirementView(Projection.fromState(stateOf(PLAN_DEFAULTS), usJurisdiction));
    expect(view.headlineAge).not.toBeNull();
    expect(html).toContain(`>${view.headlineAge}</strong>`);
  });

  it("states no target age and scores no on-track percentage", () => {
    // Both went with the plan's `retirementAge`. The headline above IS the nearest feasible
    // age, so a second line naming a target could only ever repeat it or contradict it — and
    // it did contradict it, once printing "100% of the way there" beside an age the plan
    // could not actually reach.
    const html = render(PLAN_DEFAULTS);
    expect(html).not.toContain("Your target is age");
    expect(html).not.toContain("of the way there");
    expect(html).not.toContain("on track (100%)");
    expect(html).not.toContain("nearest feasible age");
  });

  it("shows the pre-65 health nudge, naming the SOLVED age rather than a pinned one", () => {
    // Rendered from a view rather than solved from a plan: WHETHER a household's earliest
    // feasible age falls before 65 is the engine's question (`retirementOutlook`), and pinning
    // a fixture that happens to solve early would tie this render test to the solver's current
    // answer. What the panel owes is that it prints the flag, and prints it against
    // `headlineAge` — the retirement whose gap they would actually live through.
    const html = renderWithView(earlyRetiree(true));
    expect(html).toContain("Medicare");
    expect(html).toContain("self-funded");
    expect(html).toContain("not advice");
    expect(html).toContain("Retiring at 58");
  });

  it("does NOT show the health nudge when the engine did not flag one", () => {
    expect(renderWithView(earlyRetiree(false))).not.toContain("self-funded");
  });

  it("shows no nudge on the default plan, whose solved age clears Medicare", () => {
    expect(render(PLAN_DEFAULTS)).not.toContain("self-funded");
  });

  it("says nothing about a step at 65 — the plan no longer steps health there", () => {
    // The residual readout went with the plan fields that drove it. The panel's only health
    // copy left is the pre-65 gap nudge, which reads the authored budget line.
    const html = render(PLAN_DEFAULTS);
    expect(html).not.toContain("From 65");
    expect(html).not.toContain("doesn’t enrol in Medicare");
  });

  it("reads the nudge off the budget's health line, the only place health is stated", () => {
    // End-to-end through the engine, so this is what would catch the flag drifting back onto a
    // plan scalar: same everything but the health line, and raising it clears the flag.
    const flagOf = (dollars: number) =>
      retirementView(Projection.fromState(stateOf(withHealth(dollars)), usJurisdiction))
        .earlyRetireeHealth;
    expect(flagOf(5_000).shortfallMonthlyCents).toBe(0);
    expect(flagOf(0).shortfallMonthlyCents).toBeGreaterThan(0);
  });
});

describe("RetirementPanel — chart preview toggle", () => {
  const feasible = retirementView(Projection.fromState(stateOf(PLAN_DEFAULTS), usJurisdiction));

  it("offers a preview toggle naming the solved headline age", () => {
    // The default plan solves to a feasible headline (age 76), so the toggle is available and
    // names the age whose charts it previews.
    expect(feasible.headlineAge).not.toBeNull();
    const html = renderWithView(feasible);
    expect(html).toContain("checkbox");
    expect(html).toContain(`Preview`);
    expect(html).toContain(String(feasible.headlineAge));
  });

  it("names the PRIMARY's own age, not a claim that every member turns it simultaneously", () => {
    // `runAtStopWorkingAge` reads the headline age as the primary's timeline age and turns it
    // into one shared calendar boundary no job pays past — a partner authored at a different
    // age reaches that month at a different age of their own, and a fixed-term job or a
    // partner's own job can already end BEFORE the boundary rather than exactly at it (the
    // boundary only ever caps, never extends, anyone but the primary). "everyone stopped
    // working at 76" would claim every member personally turns 76 at once; "by the time Alex
    // turns 76" claims only what's guaranteed — nobody earns past that point.
    const html = renderWithView(feasible);
    expect(html).toContain(`by the time`);
    expect(html).toContain(`Alex turns`);
    expect(html).toContain(String(feasible.headlineAge));
    expect(html).not.toMatch(/everyone stopped working (at|when)\s*(<[^>]+>)?\s*\d/i);
  });

  it("falls back to 'you' when the plan has no authored name", () => {
    const unnamed = renderToStaticMarkup(
      <RetirementPanel
        view={feasible}
        budget={{ ...PLAN_DEFAULTS, name: "" }}
        previewing={false}
        onTogglePreview={noop}
      />,
    );
    expect(unnamed).toContain("by the time you turn");
    expect(unnamed).not.toContain("undefined turns");
  });

  it("reflects the on state, so the box shows checked while previewing", () => {
    expect(renderWithView(feasible, false)).not.toContain("checked");
    expect(renderWithView(feasible, true)).toContain("checked");
  });

  /** One continued job, owned by the primary — the ordinary conditional case. */
  const oneContinuation: RetirementView["continuedJobs"] = [
    {
      jobId: "job-1",
      jobLabel: "Software Engineer",
      jobName: "Software Engineer",
      ownerId: PRIMARY_PERSON_ID,
      ownerName: "Alex",
      throughAge: 76,
      throughYear: 2067,
      overlaps: [],
    },
  ];

  it("states the age flatly when NOTHING was assumed to reach it", () => {
    // The unconditional form is earned: every job in the plan already pays for this age, so
    // there is no premise to attach and attaching one would invent a caveat.
    const html = renderWithView({ ...feasible, continuedJobs: [] });
    expect(html).toContain(
      `You can retire at <strong aria-label="Earliest feasible retirement age">${feasible.headlineAge}</strong> and have the portfolio last to age ${PLAN_DEFAULTS.lifeExpectancy}.`,
    );
    expect(html).not.toContain("could stop working");
    // No condition hung off the age. Scoped to the headline paragraph: the preview toggle above
    // legitimately says "as if everyone stopped working", which is a different sentence.
    expect(html).not.toContain("</strong> if ");
    expect(html).not.toContain("This scenario assumes");
  });

  it("makes the headline itself conditional when the age assumed a continuation", () => {
    // The finding this pins: the panel used to assert "You can retire at 76" and only then add
    // a second sentence naming the job that had to run past its authored end. A reader who
    // stopped at the first line had been told a conclusion whose premise they never chose. One
    // sentence, and the survival claim rides it rather than being asserted separately.
    const html = renderWithView({ ...feasible, continuedJobs: oneContinuation });
    expect(html).toContain(
      `You could stop working at <strong aria-label="Earliest feasible retirement age">${feasible.headlineAge}</strong> if your <strong>Software Engineer</strong> job continued through when you are 76 (2067), with the portfolio lasting to age ${PLAN_DEFAULTS.lifeExpectancy}.`,
    );
    // The unconditional phrasing must be gone, not merely followed by a correction.
    expect(html).not.toContain("You can retire at");
    // Nothing about restarting, resuming or going back: the job never ended in this scenario.
    expect(html).not.toMatch(/restart|resume|return to|go back|begin(s|ning)? again/i);
  });

  it("states the age ONCE, however many jobs the answer leaned on", () => {
    // Two clauses, one age, one survival claim: the failure mode of building a sentence from a
    // list is repeating the number per clause, or trailing a stray comma before "with".
    const html = renderWithView({
      ...feasible,
      continuedJobs: [
        ...oneContinuation,
        {
          jobId: "job-11",
          jobLabel: "Nursing",
          jobName: "Nursing",
          ownerId: "person-10",
          ownerName: "Sam",
          throughAge: 71,
          throughYear: 2057,
          overlaps: [],
        },
      ],
    });
    expect(html).toContain(
      `You could stop working at <strong aria-label="Earliest feasible retirement age">${feasible.headlineAge}</strong> if your <strong>Software Engineer</strong> job continued through when you are 76 (2067) and Sam’s <strong>Nursing</strong> job continued through when Sam is 71 (2057), with the portfolio lasting to age ${PLAN_DEFAULTS.lifeExpectancy}.`,
    );
    // Each owner keeps their own clock; neither age is restated as the household's.
    expect(html.match(/could stop working/g)).toHaveLength(1);
    expect(html).not.toContain(",  with");
    expect(html).not.toContain("(2067) ,");
  });

  it("separates the third clause with a comma and the last with 'and'", () => {
    const html = renderWithView({
      ...feasible,
      continuedJobs: [1, 2, 3].map((n) => ({
        jobId: `job-${n}`,
        jobLabel: `Job ${n}`,
        jobName: `Job ${n}`,
        ownerId: PRIMARY_PERSON_ID,
        ownerName: "Alex",
        throughAge: 70 + n,
        throughYear: 2060 + n,
        overlaps: [],
      })),
    });
    expect(html).toContain(
      "if your <strong>Job 1</strong> job continued through when you are 71 (2061), your <strong>Job 2</strong> job continued through when you are 72 (2062) and your <strong>Job 3</strong> job continued through when you are 73 (2063), with the portfolio",
    );
  });

  it("discloses the overlap a continued job creates, with the years it covers", () => {
    // The consequence a reader would not predict. Continuing a job means it never ended, so it
    // now runs THROUGH the work authored to follow it and both pay — which is intended, and
    // exactly why it has to be said rather than left in the numbers.
    const html = renderWithView({
      ...feasible,
      continuedJobs: [
        {
          jobId: "job-1",
          jobLabel: "Software Engineer",
          jobName: "Software Engineer",
          ownerId: PRIMARY_PERSON_ID,
          ownerName: "Alex",
          throughAge: 76,
          throughYear: 2067,
          overlaps: [
            { jobId: "job-2", jobLabel: "Consulting", jobName: "Consulting",
              fromAge: 65, toAge: 70, fromYear: 2056, toYear: 2061 },
          ],
        },
      ],
    });
    expect(html).toContain(
      "This scenario assumes your <strong>Software Engineer</strong> job continued alongside your <strong>Consulting</strong> job from when you are 65 to 70 (2056\u20132061).",
    );
    // Still its OWN paragraph, after the headline rather than inside it: it qualifies the
    // assumption, not the age, and folding it in would bury the condition it footnotes.
    expect(html).toContain(
      `age ${PLAN_DEFAULTS.lifeExpectancy}.</p><p class="hint">This scenario assumes`,
    );
  });

  it("names an untitled job by its owner rather than forcing it into 'your X job'", () => {
    // A job with no name has no bare title to slot into the phrasing, so the engine's fallback
    // label — already a whole noun phrase — stands on its own instead.
    const html = renderWithView({
      ...feasible,
      continuedJobs: [
        {
          jobId: "job-1",
          jobLabel: "Alex\u2019s job",
          jobName: null,
          ownerId: PRIMARY_PERSON_ID,
          ownerName: "Alex",
          throughAge: 76,
          throughYear: 2067,
          overlaps: [],
        },
      ],
    });
    expect(html).toContain("if <strong>Alex\u2019s job</strong> continued through when you are 76");
    expect(html).not.toContain("your <strong>");
  });

  it("counts a PARTNER's continuation in the partner's own years, and says whose they are", () => {
    // The bug this pins: every age on a continued job was converted through the PRIMARY's birth
    // year, so a partner five years older had their job's terminus and overlap reported in
    // Alex's years — a number from one person's life attached to a sentence about another's.
    // Sam holds Nursing to 71 and Consulting at 52–58; none of those are Alex's ages.
    const html = renderWithView({
      ...feasible,
      continuedJobs: [
        {
          jobId: "job-11",
          jobLabel: "Nursing",
          jobName: "Nursing",
          ownerId: "person-10",
          ownerName: "Sam",
          throughAge: 71,
          throughYear: 2057,
          overlaps: [
            { jobId: "job-12", jobLabel: "Consulting", jobName: "Consulting",
              fromAge: 52, toAge: 58, fromYear: 2038, toYear: 2044 },
          ],
        },
      ],
    });
    expect(html).toContain("Sam’s <strong>Nursing</strong> job continued through when Sam is 71 (2057)");
    expect(html).toContain("from when Sam is 52 to 58 (2038–2044)");
    // The headline stays the household's, in the primary's years — the two clocks coexist, and
    // the calendar years in parentheses are what let a reader line them up.
    expect(html).toContain(
      `You could stop working at <strong aria-label="Earliest feasible retirement age">${feasible.headlineAge}</strong> if Sam’s <strong>Nursing</strong> job continued`,
    );
  });

  it("says 'when you are' for the primary, matching how their job is already phrased", () => {
    // The panel calls the primary's work "your X job", so naming them in the same sentence
    // would switch person mid-clause. It also gives an unnamed plan something to say.
    const html = renderToStaticMarkup(
      <RetirementPanel
        view={{
          ...feasible,
          continuedJobs: [
            {
              jobId: "job-1",
              jobLabel: "job",
              jobName: null,
              ownerId: PRIMARY_PERSON_ID,
              ownerName: "",
              throughAge: 76,
              throughYear: 2067,
              overlaps: [],
            },
          ],
        }}
        budget={{ ...PLAN_DEFAULTS, name: "" }}
        previewing={false}
        onTogglePreview={noop}
      />,
    );
    expect(html).toContain("continued through when you are 76 (2067)");
    expect(html).not.toContain("when  is");
  });

  it("says nothing about continued work when the age assumed none", () => {
    // Silence is the correct disclosure for a household that can already stop inside its own
    // authored plan: there is no assumption to surface, and inventing a reassuring sentence
    // would be its own kind of claim.
    expect(renderWithView({ ...feasible, continuedJobs: [] })).not.toContain("if you continued");
  });

  it("hides the toggle when no retirement age is feasible — there is nothing to preview", () => {
    // A null headline means even working to life expectancy never survives; capping work earlier
    // could only be worse, so offering to preview it would be offering an empty hypothetical.
    const infeasible: RetirementView = { ...feasible, headlineAge: null, headlineMonth: null };
    const html = renderWithView(infeasible);
    expect(html).not.toContain("checkbox");
    expect(html).not.toContain("Preview");
  });
});
