/**
 * @vitest-environment node
 *
 * **The QA script, executed — one household across decades.** Every other scenario file authors a
 * household and asks one question of it. These author a whole LIFE — a partner already a decade in,
 * a child already born, a home bought, a loan taken, a separation, a retirement answer read at the
 * end — and ask whether the projection stays coherent across the arc: whether balances, obligations
 * and the household's composition still agree AFTER every transaction has landed, not merely after
 * each one alone.
 *
 * The assertions sit at the same seam as the other scenarios — what the household is told — and,
 * where an intermediate state is the claim, at a public read on `Projection` / `ProjectionResult`
 * rather than an engine internal. The arc also exercises four facade doors no other facade test
 * reaches: `startPartnered` and `haveExistingChild` (the already-here counterparts to marry/have a
 * child), `deferralLimitCrossing`, and `jobStartingMonthlyIncomeCents`.
 */

import { describe, it, expect } from "vitest";
import { PRIMARY_PERSON_ID, RETIREMENT_ID, dollarsToCents, type JobInput } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { alexAlone, jobAt, monthAt, headline, ALEX_BIRTH, LIFE_EXPECTANCY } from "./testing/scenarioBuilders";
import { START_YEAR } from "./config";

/**
 * One household walked through a lifetime, in the order the events happened. The "past" arrives as
 * the anchor transactions — a partner already ten years in, a child already five — and the future
 * as dated ones: a home, a loan, a separation. A generous opening balance and two real salaries keep
 * the whole arc solvent, so what these tests read is coherence, not a shortfall cascade.
 *
 * Alex's own job carries two distinct salary anchors ($84k when it began, $120k now) so the
 * historical-income door proves it reads the past and not the present, and a 25% deferral so the
 * $30k it puts away tops the elective limit and the crossing door has a year to name.
 */
function lifeArc() {
  const p = alexAlone();
  p.updatePlan({ openingBalanceCents: dollarsToCents(500_000) });

  const alexJob: JobInput = {
    ...jobAt(22, 65, 120_000),
    salary: {
      startingSalaryCents: dollarsToCents(84_000),
      currentSalaryCents: dollarsToCents(120_000),
      realGrowthPct: 0,
    },
    deferral: { deferralFraction: 0.25, fundAccountId: RETIREMENT_ID },
  };
  const alexJobId = p.plan.jobs[0]!.id;
  p.replaceJob(alexJobId, alexJob);

  // Sam, already a decade into the household and the same age as Alex, holding a job of their own.
  const sam = p.startPartnered({
    partneredForMonths: 120,
    name: "Sam",
    birthYear: ALEX_BIRTH,
    jobs: [jobAt(30, 60, 90_000, ALEX_BIRTH)],
  });

  // Robin, born five years ago: the cost stream clips to the childhood that remains.
  const robin = p.haveExistingChild({ name: "Robin", ageMonths: 60, annualCostCents: dollarsToCents(12_000) });

  p.buyHome({
    month: monthAt(37),
    ownerId: PRIMARY_PERSON_ID,
    purchasePriceCents: dollarsToCents(400_000),
    downPaymentCents: dollarsToCents(150_000),
    downPaymentSourceIds: ["savings"],
    mortgageApr: 0.06,
    mortgageTermMonths: 360,
  });

  const loan = p.takeLoan({
    month: monthAt(39),
    ownerId: PRIMARY_PERSON_ID,
    kind: "studentLoan",
    openingBalanceCents: dollarsToCents(40_000),
    apr: 0.05,
    termMonths: 120,
  });

  p.separate({ month: monthAt(45), partnerPersonId: sam });

  return { projection: p, alexJobId, sam, robin, loan };
}

describe("life timeline — one household coherent across decades", () => {
  it("tracks who is in the household through every arrival and departure", () => {
    const { projection } = lifeArc();
    const result = projection.run(usJurisdiction);

    // Both anchors landed: Alex and the already-present Sam are members while together, and Robin
    // — a child, not a member — is still in the cross-section five years on.
    expect(result.membersAt(monthAt(44)).map((m) => m.name).sort()).toEqual(["Alex", "Sam"]);
    expect(result.snapshot(monthAt(40)).children.map((c) => c.name)).toEqual(["Robin"]);

    // And after the separation the roster agrees with it: Sam is gone, Alex remains.
    expect(result.membersAt(monthAt(46)).map((m) => m.name)).toEqual(["Alex"]);
  });

  it("carries both debts and the home once they have landed, still solvent", () => {
    const { projection } = lifeArc();
    const result = projection.run(usJurisdiction);
    const snap = result.snapshot(monthAt(42));

    // The mortgage the purchase minted and the student loan both show as owed, and the home shows
    // as a property — the balance sheet holds all three at once, not one at a time.
    expect(snap.liabilities.map((l) => l.kind).sort()).toEqual(["mortgage", "studentLoan"]);
    expect(snap.properties.map((prop) => prop.ownerId)).toEqual([PRIMARY_PERSON_ID]);

    // The whole arc stays solvent, so net worth is a real figure rather than the null a
    // shortfall cascade leaves behind.
    expect(snap.balances?.isInsolvent).toBe(false);
    expect(result.firstInsolventMonth).toBeNull();
  });

  it("still gives the household one retirement answer after the whole arc", () => {
    expect(headline(lifeArc().projection)).toBe(
      `You can retire at 47 and have the portfolio last to age ${LIFE_EXPECTANCY}.`,
    );
  });

  it("flags the year Alex's deferral first tops the elective limit", () => {
    const crossing = lifeArc().projection.deferralLimitCrossing(usJurisdiction);
    expect(crossing).not.toBeNull();
    expect(crossing!.personName).toBe("Alex");
    // 25% of $120k is $30k, already past the ~$24,500 elective limit, so the crossing is this year.
    expect(crossing!.year).toBe(START_YEAR);
    expect(crossing!.annualDeferralCents).toBeGreaterThan(crossing!.limitCents);
  });

  it("reads Alex's job at its historical anchor, not what it pays now", () => {
    const { projection, alexJobId } = lifeArc();
    // The starting-income door returns the $84k the job began at ($7,000/mo), distinct from the
    // $120k ($10,000/mo) it pays today — so it is demonstrably reading the past anchor.
    expect(projection.jobStartingMonthlyIncomeCents(alexJobId)).toBe(dollarsToCents(7_000));
    expect(projection.jobMonthlyIncomeCents(alexJobId)).toBe(dollarsToCents(10_000));
  });
});
