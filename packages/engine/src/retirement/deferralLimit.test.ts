/**
 * The elective-limit scan's own mechanics, held apart from any jurisdiction's real numbers: the
 * limit here is a flat mock figure, so every case is about WHICH MONTHS are counted and at WHAT
 * PAY, which is the whole of what moved into the engine. The app's suite runs the same scan
 * against the real US limits and catch-up bands.
 *
 * Three of these could not be written while this lived in the app, because the app's copy
 * decided the answers itself: it read a job's authored `endYear` for the years worked, its own
 * reading of `HouseholdMembership.endMonth` for the years that belong to the household, and a
 * `Math.pow` for the pay — which no pay change ever reached.
 */
import { describe, it, expect } from "vitest";
import { firstDeferralLimitCrossing } from "./deferralLimit";
import { scenarioOf, withLedger } from "../plan/scenario";
import { addEvent } from "../ledger/addEvent";
import { emptyLedger } from "../ledger/ledger";
import { createProjectionBase } from "../compile/projectionBase";
import { dollarsToCents } from "../money/cashFlowSeries";
import { mockJurisdiction } from "../testing/mockJurisdiction";
import { samplePlan, SAMPLE_START_YEAR } from "../testing/samplePlan";
import { RETIREMENT_ID } from "../plan/ids";
import type { ProjectionContext } from "../compile/projectionBase";
import type { Job } from "../job/job";
import type { Person } from "../plan/person";
import type { Plan } from "../plan/plan";
import type { Scenario } from "../plan/scenario";

const START_YEAR = SAMPLE_START_YEAR;
const BIRTH_YEAR = samplePlan.primary.birthYear;
const CURRENT_AGE = START_YEAR - BIRTH_YEAR;
const monthAt = (age: number) => (age - CURRENT_AGE) * 12;

/** A flat $20k limit at every age and year: nothing here turns on how a jurisdiction indexes. */
const LIMIT = dollarsToCents(20_000);
const CTX: ProjectionContext = {
  jurisdiction: mockJurisdiction({ retirementDeferralLimitCents: () => LIMIT }),
  startYear: START_YEAR,
};

/** A deferring job on the owner's own clock, flat in real terms unless a test says otherwise. */
function deferringJob(
  id: string,
  ownerId: string,
  startAge: number,
  endAge: number,
  annualDollars: number,
  over: Partial<Job> = {},
): Job {
  return {
    id,
    ownerId,
    startYear: BIRTH_YEAR + startAge,
    endYear: BIRTH_YEAR + endAge,
    salary: {
      startingSalaryCents: dollarsToCents(annualDollars),
      currentSalaryCents: dollarsToCents(annualDollars),
      realGrowthPct: 0,
    },
    deferral: { deferralFraction: 0.5, fundAccountId: RETIREMENT_ID },
    ...over,
  };
}

/** No CPI: every figure below is the authored one, so a crossing is arithmetic and not drift. */
const flatPlan = (jobs: readonly Job[]): Plan => ({
  ...samplePlan,
  inflationPct: 0,
  primary: { ...samplePlan.primary, jobs },
});

/** The same plan with 3% CPI, for the cases about a figure that only crosses once it has grown. */
const inflatingPlan = (jobs: readonly Job[]): Plan => ({ ...flatPlan(jobs), inflationPct: 3 });

/** A partner joining at `joinMonth`, optionally leaving at `separationMonth`. */
function withPartner(
  plan: Plan,
  partner: Person,
  opts: { joinMonth?: number; separationMonth?: number } = {},
): Scenario {
  const base = createProjectionBase(plan, CTX);
  const married = addEvent(emptyLedger, base, {
    id: "r1",
    type: "RelationshipEvent",
    month: opts.joinMonth ?? 0,
    person: partner,
  });
  if (!married.ok) throw new Error(`fixture rejected: ${married.conflict}`);
  if (opts.separationMonth === undefined) return withLedger(scenarioOf(plan), married.ledger);
  const separated = addEvent(married.ledger, base, {
    id: "s1",
    type: "SeparationEvent",
    month: opts.separationMonth,
    partnerPersonId: partner.id,
    alimonyMonthlyCents: 0,
    alimonyDurationMonths: 0,
    childSupportMonthlyCents: 0,
  });
  if (!separated.ok) throw new Error(`fixture rejected: ${separated.conflict}`);
  return withLedger(scenarioOf(plan), separated.ledger);
}

const partnerHolding = (jobs: readonly Job[]): Person => ({
  id: "p2",
  name: "Partner",
  birthYear: BIRTH_YEAR,
  lifeExpectancy: 85,
  benefitClaimingAge: 67,
  jobs,
  continuationJobId: null,
});

describe("firstDeferralLimitCrossing", () => {
  it("says nothing at all where the jurisdiction states no limit", () => {
    // Not "never crosses" by accident: a jurisdiction with no elective limit has nothing to
    // cross, and inventing one from another jurisdiction's number would be the only alternative.
    const scenario = scenarioOf(flatPlan([deferringJob("j1", "p1", 30, 65, 100_000)]));
    expect(
      firstDeferralLimitCrossing(scenario, { jurisdiction: mockJurisdiction(), startYear: START_YEAR }),
    ).toBeNull();
  });

  it("crosses on the household's own pay, in the first year it does", () => {
    // $96k at 50% is $48k, well past the $20k limit, from the first year the job pays. Every
    // salary here divides by twelve, because the figure reported is the sum of twelve monthly
    // paychecks and not an annual number divided at the end.
    const crossing = firstDeferralLimitCrossing(
      scenarioOf(flatPlan([deferringJob("j1", "p1", 30, 65, 96_000)])),
      CTX,
    );
    expect(crossing).not.toBeNull();
    expect(crossing!.year).toBe(START_YEAR);
    expect(crossing!.age).toBe(CURRENT_AGE);
    expect(crossing!.annualDeferralCents).toBe(dollarsToCents(48_000));
    expect(crossing!.limitCents).toBe(LIMIT);
  });

  it("stops counting a departed partner's deferral at the separation", () => {
    // The partner's job would cross in its own terms — $96k at 50% — but they leave the
    // household before it starts paying, so none of that deferral is ever this household's.
    // The app's copy read the membership end itself and had no way to stay in step with the
    // projection that decides it.
    const partner = partnerHolding([deferringJob("pj", "p2", 45, 65, 96_000)]);
    const scenario = withPartner(flatPlan([]), partner, { separationMonth: monthAt(42) });

    expect(firstDeferralLimitCrossing(scenario, CTX)).toBeNull();

    // The same partner who stays crosses the year their job begins — so the fixture is capable
    // of crossing, and it is the separation that silences it.
    const together = withPartner(flatPlan([]), partner);
    expect(firstDeferralLimitCrossing(together, CTX)!.year).toBe(BIRTH_YEAR + 45);
  });

  it("counts a partner's deferral only from the month they JOIN", () => {
    // Their job is already running when they arrive. The years before the join are somebody
    // else's household, and a scan that began at the job's start would report a crossing in a
    // year this household had no partner at all.
    const partner = partnerHolding([deferringJob("pj", "p2", 30, 65, 96_000)]);
    const scenario = withPartner(flatPlan([]), partner, { joinMonth: monthAt(48) });

    const crossing = firstDeferralLimitCrossing(scenario, CTX);
    expect(crossing!.year).toBe(BIRTH_YEAR + 48);
    expect(crossing!.personName).toBe("Partner");
  });

  it("reads the pay a PAY CHANGE sets, not the salary the job was authored with", () => {
    // $36k at 50% is $18k — under the $20k limit for as long as it lasts. A raise to $72k at 50
    // puts them over, and the crossing is that year. Nothing in the app's projection of pay could
    // see this: it compounded the authored current salary and never looked at a pay change.
    const raised = deferringJob("j1", "p1", 30, 65, 36_000, {
      payChanges: [
        { id: "pc1", month: monthAt(50), kind: "setTo", cents: dollarsToCents(72_000) / 12 },
      ],
    });
    const crossing = firstDeferralLimitCrossing(scenarioOf(flatPlan([raised])), CTX);

    expect(crossing).not.toBeNull();
    expect(crossing!.year).toBe(BIRTH_YEAR + 50);
    expect(crossing!.annualDeferralCents).toBe(dollarsToCents(36_000));

    // Without the raise the same job never crosses at all.
    const flat = deferringJob("j1", "p1", 30, 65, 36_000);
    expect(firstDeferralLimitCrossing(scenarioOf(flatPlan([flat])), CTX)).toBeNull();
  });

  it("charges a part-year at the months it actually paid, not at a whole year of it", () => {
    // A membership is the one thing that can end mid-year — an authored job end is a calendar
    // year — so this is where the month-by-month sum earns its keep. $96k at 50% is $4,000 a
    // month; the partner leaves after six of them, so the year is $24,000 and not $48,000.
    const partner = partnerHolding([deferringJob("pj", "p2", 30, 65, 96_000)]);
    const scenario = withPartner(flatPlan([]), partner, { separationMonth: 6 });

    const crossing = firstDeferralLimitCrossing(scenario, CTX);
    expect(crossing!.year).toBe(START_YEAR);
    expect(crossing!.annualDeferralCents).toBe(dollarsToCents(24_000));
  });

  it("says nothing when nobody defers at all", () => {
    // A job big enough to cross several times over, electing nothing. The scan's first question.
    const { deferral: _none, ...noElection } = deferringJob("j1", "p1", 30, 65, 96_000);
    expect(firstDeferralLimitCrossing(scenarioOf(flatPlan([noElection])), CTX)).toBeNull();
  });

  it("crosses only once CPI lifts the deferral past a limit it started under", () => {
    // $36k at 50% is $18,000 — under the $20,000 limit as authored. The limit here does not
    // index, so the only thing that can move is the pay, and the crossing year is the year it
    // does. Reporting this one today would warn about a deferral nobody has elected yet.
    const growing = firstDeferralLimitCrossing(
      scenarioOf(inflatingPlan([deferringJob("j1", "p1", 30, 65, 36_000)])),
      CTX,
    );
    expect(growing).not.toBeNull();
    expect(growing!.year).toBeGreaterThan(START_YEAR);
    expect(growing!.annualDeferralCents).toBeGreaterThan(growing!.limitCents);

    // The same job with no CPI behind it never crosses at all.
    expect(
      firstDeferralLimitCrossing(scenarioOf(flatPlan([deferringJob("j1", "p1", 30, 65, 36_000)])), CTX),
    ).toBeNull();
  });
});

/**
 * **The limit belongs to the person, not to the job and not to the household.** One person's jobs
 * sum against one limit; two people are never pooled. Both halves of that have their own failure —
 * scanning job by job under-reports, scanning the household over-reports — so both are pinned.
 */
describe("firstDeferralLimitCrossing — whose deferral counts against whose limit", () => {
  it("sums one person's jobs before comparing, though neither crosses alone", () => {
    const first = deferringJob("j1", "p1", 30, 65, 30_000);
    const second = deferringJob("j2", "p1", 30, 65, 30_000);

    const crossing = firstDeferralLimitCrossing(scenarioOf(flatPlan([first, second])), CTX);
    expect(crossing!.annualDeferralCents).toBe(dollarsToCents(30_000)); // $15k + $15k
    expect(crossing!.personName).toBe(samplePlan.primary.name);

    // Either one on its own is $15,000, comfortably inside the limit.
    expect(firstDeferralLimitCrossing(scenarioOf(flatPlan([first])), CTX)).toBeNull();
  });

  it("counts a second job only from the year it starts paying", () => {
    // $15k today, $30k once the job at 45 begins. A scan that summed every authored job whatever
    // its span would warn fifteen years early.
    const crossing = firstDeferralLimitCrossing(
      scenarioOf(
        flatPlan([deferringJob("j1", "p1", 30, 65, 30_000), deferringJob("j2", "p1", 45, 65, 30_000)]),
      ),
      CTX,
    );
    expect(crossing!.year).toBe(BIRTH_YEAR + 45);
  });

  it("sums a partner's own jobs, and attributes the crossing to them", () => {
    const scenario = withPartner(
      flatPlan([]),
      partnerHolding([
        deferringJob("pj1", "p2", 40, 65, 24_000),
        deferringJob("pj2", "p2", 40, 65, 24_000),
      ]),
    );

    const crossing = firstDeferralLimitCrossing(scenario, CTX);
    expect(crossing!.personId).toBe("p2");
    expect(crossing!.annualDeferralCents).toBe(dollarsToCents(24_000));
  });

  it("does NOT pool two earners — each stays inside a limit of their own", () => {
    // $12,000 apiece is $24,000 across the household, past a single $20,000 limit; neither person
    // is anywhere near theirs. Summing the household would invent a warning out of nothing.
    const scenario = withPartner(
      flatPlan([deferringJob("j1", "p1", 30, 65, 24_000)]),
      partnerHolding([deferringJob("pj", "p2", 40, 65, 24_000)]),
    );
    expect(firstDeferralLimitCrossing(scenario, CTX)).toBeNull();
  });

  it("reports the EARLIEST crossing when both earners eventually cross", () => {
    // The nudge names one person, so which one is not a free choice: the primary crosses on a job
    // already running, the partner only when theirs begins at 50.
    const scenario = withPartner(
      flatPlan([deferringJob("j1", "p1", 30, 65, 96_000)]),
      partnerHolding([deferringJob("pj", "p2", 50, 65, 96_000)]),
    );

    const crossing = firstDeferralLimitCrossing(scenario, CTX);
    expect(crossing!.year).toBe(START_YEAR);
    expect(crossing!.personId).toBe("p1");
  });

  it("stops at the end of the PARTNER's own job, not at the household's last working year", () => {
    // $18,000 while it lasts, and it lasts one year — so the year CPI would have carried it past
    // the limit is a year they are no longer paid in. The primary works on either way.
    const oneYear = partnerHolding([deferringJob("pj", "p2", 40, 41, 36_000)]);
    expect(firstDeferralLimitCrossing(withPartner(inflatingPlan([]), oneYear), CTX)).toBeNull();

    // Held to 65, the same pay does cross — so it is the job's end that silences it.
    const wholeCareer = partnerHolding([deferringJob("pj", "p2", 40, 65, 36_000)]);
    expect(firstDeferralLimitCrossing(withPartner(inflatingPlan([]), wholeCareer), CTX)).not.toBeNull();
  });
});
