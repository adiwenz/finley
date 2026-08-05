/**
 * @vitest-environment node
 *
 * **The QA script, executed.** Each test here authors a household through the public
 * `Projection` API exactly as a user would through the UI — add a job, marry, name a
 * continuation, separate — solves it against the real US jurisdiction, and asserts the
 * SENTENCES the retirement panel puts on screen.
 *
 * Everything else in this package tests one seam. `retirementSolver.test.ts` pins the engine's
 * `ContinuedJob` values; `retirementPanel.test.tsx` renders hand-built views to pin the
 * phrasing. Neither covers the join between them, so an engine that answers correctly and a
 * panel that renders correctly could still show a household a false claim, and every test would
 * stay green. These are the ones that would fail.
 *
 * Written as whole expected sentences rather than fragments, because the claim is the sentence:
 * "you could stop working at 57 if Sam's job continued through when Sam is 55" is either what a
 * household is told or it is not, and a `toContain("Sam")` cannot tell the difference between
 * that and crediting them through 57.
 */

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Projection, PRIMARY_PERSON_ID, dollarsToCents, type JobInput } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { stateOf } from "./testing/projectionHarness";
import { retirementView } from "./retirementView";
import { RetirementPanel } from "./components/retirementPanel/retirementPanel";
import { PLAN_DEFAULTS } from "./planDefaults";
import { START_YEAR } from "./config";

const ALEX_AGE = PLAN_DEFAULTS.currentAge;
const ALEX_BIRTH = START_YEAR - ALEX_AGE;
const LIFE_EXPECTANCY = PLAN_DEFAULTS.lifeExpectancy;
/** The simulation month the household reaches an age on the PRIMARY's clock. */
const monthAt = (age: number) => (age - ALEX_AGE) * 12;

/**
 * One job in the terms the Jobs form takes them: two ages on the owner's own clock and a
 * salary. Flat real growth throughout, so nothing in these scenarios turns on a pay curve.
 */
function jobAt(startAge: number, endAge: number, annualDollars: number, birthYear = ALEX_BIRTH): JobInput {
  return {
    startYear: birthYear + startAge,
    endYear: birthYear + endAge,
    salary: {
      startingSalaryCents: dollarsToCents(annualDollars),
      currentSalaryCents: dollarsToCents(annualDollars),
      realGrowthPct: 0,
    },
  };
}

/** The default plan as a fresh handle — the household a user starts from. */
const alexAlone = (): Projection => Projection.fromState(stateOf(PLAN_DEFAULTS), usJurisdiction);

/**
 * The panel's own paragraphs, as the plain text a reader sees. Rendered through the real
 * component and the real view, so nothing between the solve and the screen is stubbed.
 */
function paragraphs(p: Projection): string[] {
  const html = renderToStaticMarkup(
    <RetirementPanel
      view={retirementView(p, usJurisdiction)}
      budget={p.plan}
      previewing={false}
      onTogglePreview={() => {}}
    />,
  );
  return [...html.matchAll(/<p[^>]*>(.*?)<\/p>/gs)].map((m) =>
    m[1]!
      .replace(/<[^>]+>/g, "")
      .replace(/&#x27;|&#39;/g, "'")
      .replace(/&#x2019;/g, "’")
      .replace(/&#x2013;/g, "–")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

/**
 * The one sentence that gives the answer — in whichever of its three forms the panel chose.
 * Matched by what each form actually says rather than by position, so a new paragraph appearing
 * above it (a health nudge, a preview hint) cannot silently retarget these assertions.
 */
function headline(p: Projection): string {
  const found = paragraphs(p).find(
    (t) =>
      t.startsWith("You could stop working at") ||
      t.startsWith("You can retire at") ||
      t.startsWith("On these numbers"),
  );
  if (found === undefined) throw new Error(`no headline sentence in:\n${paragraphs(p).join("\n")}`);
  return found;
}

/** Every "This scenario assumes …" sentence — the overlap disclosures, in the order shown. */
const assumptions = (p: Projection): string[] =>
  paragraphs(p).filter((t) => t.startsWith("This scenario assumes"));

/**
 * Alex and Sam, married at month 0, Sam holding one job and named as the household's only
 * continuation — Alex answers None, so every claim these tests make is unambiguously about
 * Sam's job and no second extension can account for it.
 *
 * `$60k` and a job ending at Sam's 50 are tuned so the solved age lands PAST that end: the
 * continuation is then load-bearing, which is the only condition under which the panel says
 * anything about it at all.
 */
function alexAndSam(opts: { jobs?: readonly JobInput[]; joinAt?: number; separateAt?: number } = {}) {
  const p = alexAlone();
  p.setContinuationJob(PRIMARY_PERSON_ID, null);
  const sam = p.marry({ month: opts.joinAt ?? 0, name: "Sam", birthYear: ALEX_BIRTH });
  const jobIds = (opts.jobs ?? [jobAt(35, 50, 60_000)]).map((j) => p.addPartnerJob(sam, j));
  p.setContinuationJob(sam, jobIds[0]!);
  if (opts.separateAt !== undefined) p.separate({ month: opts.separateAt, partnerPersonId: sam });
  return { projection: p, sam, jobIds };
}

describe("scenarios — what the household is actually told", () => {
  it("names the reader's OWN job in the second person, on their own clock", () => {
    // The starting point every other scenario is a variation on: one earner, the default plan,
    // an age that only arrives because their job was modelled as never having ended.
    expect(headline(alexAlone())).toBe(
      `You could stop working at 76 if Alex's job continued through when you are 76 (2067), with the portfolio lasting to age ${LIFE_EXPECTANCY}.`,
    );
    expect(assumptions(alexAlone())).toEqual([]);
  });

  it("names a PARTNER's job as theirs, in their own years", () => {
    // Two earners, and the continuation is Sam's. The panel switches person — "Sam's job",
    // "when Sam is" — because the age on a continued job is its owner's, not the reader's.
    const { projection } = alexAndSam();
    expect(headline(projection)).toBe(
      `You could stop working at 53 if Sam's job continued through when Sam is 53 (2044), with the portfolio lasting to age ${LIFE_EXPECTANCY}.`,
    );
  });

  it("credits a departed partner's job with NOTHING once they have left", () => {
    // The bug, end to end. Sam's job is authored to Sam's 50 and Sam leaves at 45, so extending
    // that employment to the solved age adds employment and no income — the household is never
    // paid another cent for it. The old sentence promised the answer rested on Sam working on;
    // the household is now told a flat, unconditional age instead.
    const { projection } = alexAndSam({ separateAt: monthAt(45) });

    expect(headline(projection)).toBe(
      `You can retire at 65 and have the portfolio last to age ${LIFE_EXPECTANCY}.`,
    );
    // Not by absence of an answer: there IS a feasible age here, and it simply owes nothing to
    // Sam. Sam is not named anywhere in the reasoning.
    expect(retirementView(projection, usJurisdiction).headlineAge).toBe(65);
    expect(retirementView(projection, usJurisdiction).continuedJobs).toEqual([]);
    expect(assumptions(projection)).toEqual([]);

    // And the same household that does not separate IS told about Sam — so this is the
    // separation talking, not a fixture that could never have disclosed anything.
    expect(headline(alexAndSam().projection)).toContain("Sam");
  });

  it("credits a partner who leaves mid-continuation only as far as the money went", () => {
    // The partial case. Sam's job ends at 50, Sam leaves at 55, and the answer is 57 — so the
    // extension did buy the household five real years, and then stopped. The sentence says 55,
    // not 57: what is disclosed is where the money stopped, not where the hypothesis ran to.
    const { projection } = alexAndSam({ separateAt: monthAt(55) });

    expect(headline(projection)).toBe(
      `You could stop working at 57 if Sam's job continued through when Sam is 55 (2046), with the portfolio lasting to age ${LIFE_EXPECTANCY}.`,
    );
    const [continued] = retirementView(projection, usJurisdiction).continuedJobs;
    expect(continued!.throughAge).toBeLessThan(
      retirementView(projection, usJurisdiction).headlineAge!,
    );
  });

  it("opens an overlap at the JOIN, never at a job end this household never saw", () => {
    // Sam's first job was authored to end at 30 — long before they joined at Alex's 45 — so
    // continuing it pays this household only from the join. The overlap sentence is where that
    // shows: "from when Sam is 45", not from the 30 the job was authored to end at.
    const { projection } = alexAndSam({
      joinAt: monthAt(45),
      jobs: [jobAt(20, 30, 60_000), jobAt(30, 55, 60_000)],
    });

    expect(headline(projection)).toBe(
      `You could stop working at 54 if Sam's job 1 continued through when Sam is 54 (2045), with the portfolio lasting to age ${LIFE_EXPECTANCY}.`,
    );
    expect(assumptions(projection)).toEqual([
      "This scenario assumes Sam's job 1 continued alongside Sam's job 2 from when Sam is 45 to 54 (2036–2045).",
    ]);
  });

  it("says nothing about an overlap that is employment only", () => {
    // Both spans cross on paper — a job continued to the solved age and a second authored from
    // Sam's 50 — and the household is paid for neither crossing, because Sam leaves the year
    // the second job starts. Measured on employment this announced ten years of doubled income
    // that never arrives.
    const { projection } = alexAndSam({
      jobs: [jobAt(20, 30, 60_000), jobAt(50, 60, 60_000)],
      separateAt: monthAt(50),
    });

    expect(assumptions(projection)).toEqual([]);
    // The continuation itself is still real and still disclosed — through the separation.
    expect(headline(projection)).toBe(
      `You could stop working at 62 if Sam's job 1 continued through when Sam is 50 (2041), with the portfolio lasting to age ${LIFE_EXPECTANCY}.`,
    );
  });

  it("answers None with no conditional at all, and no invented income", () => {
    // The household says no job would carry on. The default plan's age rested entirely on
    // Alex's job doing so, so the honest answer becomes that there is none — stated as a
    // structural problem rather than as an age with a caveat.
    const p = alexAlone();
    p.setContinuationJob(PRIMARY_PERSON_ID, null);

    expect(headline(p)).toBe(
      `On these numbers the money never lasts to age ${LIFE_EXPECTANCY} — no retirement age is feasible. Structural changes are required.`,
    );
    expect(assumptions(p)).toEqual([]);
  });
});
