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
import { PRIMARY_PERSON_ID, dollarsToCents } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { retirementView } from "./retirementView";
import {
  monthAt,
  jobAt,
  alexAlone,
  alexAndSam,
  headline,
  paragraphs,
  assumptions,
  LIFE_EXPECTANCY,
} from "./testing/scenarioBuilders";

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

describe("scenarios — more households the same panel has to answer", () => {
  it("tells a lone earner whose pay never covers the plan that no age is feasible", () => {
    // A single earner on a wage the household outspends: continuing that job to any age still
    // never funds life expectancy, so the honest answer is structural rather than a later age.
    // Distinct from the None scenario above, which reached this same sentence by REMOVING the
    // continuation — here the continuation is intact and simply cannot carry the numbers.
    const p = alexAlone();
    p.replaceJob(p.plan.jobs[0]!.id, jobAt(18, 65, 12_000));

    expect(headline(p)).toBe(
      `On these numbers the money never lasts to age ${LIFE_EXPECTANCY} — no retirement age is feasible. Structural changes are required.`,
    );
    expect(assumptions(p)).toEqual([]);
  });

  it("lets a household a partner out-earns retire outright, naming no job at all", () => {
    // Sam earns $200k to Alex's $60k, so the AUTHORED plan funds itself well before either job
    // ends — the search needs no continuation hypothesis, and the sentence names no job. Alex
    // alone reaches only a conditional 76 (the opening scenario); the partner's earnings pull the
    // earliest stop forward to 45 and drop the "if … continued" clause entirely.
    const { projection } = alexAndSam({ jobs: [jobAt(35, 50, 200_000)] });

    expect(headline(projection)).toBe(
      `You can retire at 45 and have the portfolio last to age ${LIFE_EXPECTANCY}.`,
    );
    expect(retirementView(projection, usJurisdiction).continuedJobs).toEqual([]);
  });

  it("pushes the earliest stop out when a mid-career separation loses the higher earner", () => {
    // Together, Sam's $120k pulls the earliest stop to 48. Separating at Alex's 48 ends Sam's
    // contribution there, and the household — on Alex's $60k plus what was saved while together —
    // cannot stop until 55. The separation is the only difference between the two, so it is what
    // moved the age.
    const jobs = [jobAt(35, 55, 120_000)];

    expect(headline(alexAndSam({ jobs }).projection)).toBe(
      `You can retire at 48 and have the portfolio last to age ${LIFE_EXPECTANCY}.`,
    );
    expect(headline(alexAndSam({ jobs, separateAt: monthAt(48) }).projection)).toBe(
      `You can retire at 55 and have the portfolio last to age ${LIFE_EXPECTANCY}.`,
    );
  });

  it("tells a household a stranded purchase blocked the projection, and shows nothing else", () => {
    // A home authored when the account could fund it, then stranded by a later opening-balance
    // edit: the down payment no longer resolves, so the projection BLOCKS rather than reaching an
    // age. The panel then drops every other line and states only that — its third state, "fund the
    // obligation differently", not "retire later". The block's mechanics are pinned in
    // scenarios.blockedPurchase.test.ts; this pins the one SENTENCE the household is shown.
    const p = alexAlone();
    p.updatePlan({ openingBalanceCents: dollarsToCents(400_000) });
    p.buyHome({
      month: 12,
      ownerId: PRIMARY_PERSON_ID,
      purchasePriceCents: dollarsToCents(500_000),
      downPaymentCents: dollarsToCents(200_000),
      downPaymentSourceIds: ["savings"],
      mortgageApr: 0.06,
      mortgageTermMonths: 360,
    });
    p.updatePlan({ openingBalanceCents: dollarsToCents(60_000) });

    expect(paragraphs(p)).toEqual([
      "Can’t compute a retirement age — your projection is blocked at age 36. Fund the blocking obligation differently to see how far your plan reaches.",
    ]);
  });

  it("gives a late-start earner a feasible age, just a later one", () => {
    // Alex's career begins at 35 rather than the usual 18 — the same $60k job, two decades of
    // saving forgone. The plan still resolves, but only on the continuation, and the earliest stop
    // lands at 78: past the 76 the from-18 default reaches on the identical wage.
    const p = alexAlone();
    p.replaceJob(p.plan.jobs[0]!.id, jobAt(35, 65, 60_000));

    expect(headline(p)).toBe(
      `You could stop working at 78 if Alex's job continued through when you are 78 (2069), with the portfolio lasting to age ${LIFE_EXPECTANCY}.`,
    );
  });
});
