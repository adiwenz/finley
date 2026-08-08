/**
 * **`Projection.run(jurisdiction)` — the plan, run.**
 *
 * The result is immutable and the call mutates nothing; the horizon spans the LONGEST-LIVED
 * member rather than the primary; and every person-scoped stream inside the result ends at its
 * own person's death rather than at the run's end.
 *
 * Authoring refusals are `projectionFacade.lifeEvents.test.ts`; the retirement search and the
 * stop-working preview are `projectionFacade.retirement.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { Projection, resolvedJobPaySpan, type ProjectionState } from "../index";
import { resolvedJobEndMonth } from "../ledger/household";
import { samplePlan, stateOf } from "../testing/samplePlan";
import { mockJurisdiction } from "../testing/mockJurisdiction";
import {
  FLAT_BENEFIT_MONTHLY_CENTS,
  flatBenefitJurisdiction,
} from "../testing/flatBenefitJurisdiction";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import { dollarsToCents } from "../money/cashFlowSeries";
import { P1, freshProjection, plainJob } from "../testing/projectionFacadeFixtures";

describe("Projection root — run(jurisdiction) → immutable result, no mutation", () => {
  it("computes a per-month series and is frozen", () => {
    const p = freshProjection();
    const result = p.run(nullJurisdiction);
    expect(result.jurisdictionId).toBe("null");
    expect(result.series.months.length).toBeGreaterThan(0);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("runs the SAME plan under two jurisdictions without mutating the projection", () => {
    const p = freshProjection();
    p.addJob(P1, plainJob);
    const before = p.toJSON();

    const untaxed = p.run(nullJurisdiction);
    // A flat monthly tax bleeds net worth, so the taxed run must diverge from the null one.
    const taxed = p.run(
      mockJurisdiction({
        id: "flat-tax",
        computeTaxCents: () => dollarsToCents(1500),
        // The flat tax must reconcile per source, so key it to the job's wage income.
        computeTaxByCategoryCents: () => ({ wages: dollarsToCents(1500) }),
      }),
    );

    expect(taxed.jurisdictionId).toBe("flat-tax");
    const lastUntaxed = untaxed.series.months.at(-1)?.netWorthNominalCents;
    const lastTaxed = taxed.series.months.at(-1)?.netWorthNominalCents;
    expect(lastTaxed).not.toBe(lastUntaxed);

    // run() is read-only: the authoring state is identical before and after.
    expect(p.toJSON()).toBe(before);
  });

  it("surfaces the interpreted household and a report built from the same series", () => {
    const p = freshProjection();
    p.addJob(P1, plainJob);
    p.marry({ month: 12, name: "Partner", birthYear: 1990, lifeExpectancy: samplePlan.primary.lifeExpectancy });
    const result = p.run(nullJurisdiction);

    // The household the snapshot panel and owner picker read — both partners present.
    expect(result.household.memberships.map((m) => m.person.name)).toContain("Partner");

    // The report is derived from the very series the chart draws, not a second simulation:
    // every reported month lines up with the result's own series, value for value.
    expect(result.report.months.length).toBe(result.series.months.length);
    const lastReport = result.report.months.at(-1)?.netWorthNominalCents;
    const lastSeries = result.series.months.at(-1)?.netWorthNominalCents;
    expect(lastReport).toBe(lastSeries);

    // Knobs the sim input compiles away survive via meta — the whole plan and the run's rules.
    expect(result.report.meta).toEqual({ plan: p.plan, jurisdictionId: "null" });
  });
});

describe("Projection root — horizon spans to the LONGEST-LIVED member, not the primary's", () => {
  // Sample plan: primary age 40, life expectancy 85, start 2026 → the primary reaches 85 at
  // month (85 - 40) * 12 = 540, which is where the run used to always stop.
  const PRIMARY_HORIZON = (85 - 40) * 12;
  const monthsOf = (p: Projection) => p.run(nullJurisdiction).series.months.length;

  it("runs only to the primary's expectancy when nobody outlives them", () => {
    expect(monthsOf(freshProjection())).toBe(PRIMARY_HORIZON);
  });

  it("extends to a younger partner's expectancy — their later years are now inside the run", () => {
    // Sam is born 1996 (age 30 at 2026) and, stating none, takes the primary's expectancy age of
    // 85 at `marry`, so
    // Sam reaches 85 in 2081 — eleven years past the primary's 2071. The run must cover them:
    // month (1996 + 85 - 2026) * 12 = 660, not the primary's 540.
    const p = freshProjection();
    p.marry({ month: 12, name: "Sam", birthYear: 1996, lifeExpectancy: samplePlan.primary.lifeExpectancy });
    expect(monthsOf(p)).toBe((1996 + 85 - 2026) * 12);
    expect(monthsOf(p)).toBeGreaterThan(PRIMARY_HORIZON);
  });

  it("honours a partner's OWN stated expectancy over the household default", () => {
    const p = freshProjection();
    p.marry({ month: 12, name: "Sam", birthYear: 1996, lifeExpectancy: 95 });
    expect(monthsOf(p)).toBe((1996 + 95 - 2026) * 12);
  });

  it("does not shrink below the primary when the partner dies first", () => {
    // An older partner (born 1976, age 50) at the same expectancy age reaches 85 in 2061 —
    // before the primary — so the primary still sets the horizon.
    const p = freshProjection();
    p.marry({ month: 12, name: "Sam", birthYear: 1976, lifeExpectancy: samplePlan.primary.lifeExpectancy });
    expect(monthsOf(p)).toBe(PRIMARY_HORIZON);
  });

  // A separation only takes a partner's tail out of the run if it happens while BOTH are alive.
  // The boundary is `min(their death, the primary's)`, and here that is the PRIMARY's month 540 —
  // Sam, born 1996 at expectancy 85, would otherwise reach 660.
  //
  // Authoring cannot produce a posthumous separation at all any more: the write is refused when it
  // is dated past a death, and an edit that would strand an existing one is refused too. So these
  // build the state through RESTORATION, which is the only door left and exactly what the
  // simulation's clamp is a safeguard for — a file written by another build, hand-edited, or
  // exported before the rule existed. The clamp is what makes such a household model sensibly
  // rather than being refused at the door with nothing the user can open.
  describe("a separation ends their claim on the horizon only while both are alive", () => {
    const SAM_REACH = (1996 + 85 - 2026) * 12; // 660

    /**
     * A restored household whose separation at `month` has become posthumous: authored legally
     * against long expectancies, then lowered OUTSIDE the authoring gate the way an imported file
     * arrives.
     */
    const strandedAt = (month: number, expectancy = samplePlan.primary.lifeExpectancy) => {
      const authored = freshProjection();
      authored.updatePlan({ lifeExpectancy: 100 }); // dies 2086
      const partnerId = authored.marry({
        month: 12,
        name: "Sam",
        birthYear: 1996,
        lifeExpectancy: 95, // dies 2091 — so the separation below is legal when written
      });
      authored.separate({ month, partnerPersonId: partnerId });

      const state = JSON.parse(JSON.stringify(authored.toState())) as ProjectionState;
      const lowered: ProjectionState = {
        ...state,
        scenario: {
          ...state.scenario,
          plan: {
            ...state.scenario.plan,
            primary: { ...state.scenario.plan.primary, lifeExpectancy: expectancy },
          },
          ledger: {
            ...state.scenario.ledger,
            events: state.scenario.ledger.events.map((e) =>
              e.type === "RelationshipEvent"
                ? { ...e, person: { ...e.person, lifeExpectancy: expectancy } }
                : e,
            ),
          },
        },
      };
      return Projection.fromState(lowered, nullJurisdiction);
    };

    // The rule's own boundary sweep — before, exactly at, and after the first death — is pinned
    // directly against `memberHorizonReach` in `job/memberHorizonReach.test.ts`; that module's
    // own docstring names this file as the place callers are checked, not the rule re-derived.
    // What stays here is that the run's OWN last month and the retirement panel's anchor, two
    // separate consumers of the shared helper, agree at every one of those same boundary points.

    it("agrees with the anchor the panel names, at every point around the boundary", () => {
      // The reason the rule lives in one shared helper. The run's last month and the age the panel
      // prints are two readings of one horizon, so a household whose graph stops at Sam's death
      // must not be described by a sentence naming the primary's. Swept across the boundary rather
      // than spot-checked, because divergence is exactly what a copied rule produces at the edges.
      for (const month of [300, PRIMARY_HORIZON - 1, PRIMARY_HORIZON, 600, 700]) {
        const p = strandedAt(month);
        const anchor = p.retirement(nullJurisdiction).solution.horizonAnchor;
        const ranToSam = monthsOf(p) === SAM_REACH;
        expect({ month, named: anchor.memberName }).toEqual({
          month,
          named: ranToSam ? "Sam" : null,
        });
      }
    });

    it("covers the survivor through their death — the issue's worked example", () => {
      // Primary dies 2070, Sam dies 2080, separation booked for 2085. Sam never leaves while
      // alive, so the projection must run through 2080 rather than stopping at the primary's
      // 2070 and leaving the survivor's last decade unmodelled. Both at expectancy 84: the
      // primary (born 1986) reaches it in 2070, Sam (born 1996) in 2080.
      expect(monthsOf(strandedAt((2085 - 2026) * 12, 84))).toBe((2080 - 2026) * 12);
    });

    // The symmetric case — the binding death is the PARTNER's rather than the primary's — is
    // pinned the same way, directly against `memberHorizonReach`.
  });
});

/**
 * **A death is the upper bound of everything person-scoped**, end to end through the facade.
 *
 * `personActiveWindow.test.ts` pins the window itself. This pins that every subsystem comes out
 * the far side of it agreeing: what the simulation pays, what a raise or a bonus lands on, and
 * what a chart draws are one effective end date, not three that happen to match.
 *
 * The fixture throughout: the sample primary is born 1986 with expectancy 85, so they die in
 * 2071 — month 540. Sam is married at month 0, born 1996 with expectancy 90, so they die in 2086
 * — month 720, which is also the horizon. Both facts matter. The overlap is what makes these
 * assertions readable at all: without a partner outliving the primary the run would simply STOP
 * at 540, and "no wage after death" and "no months after death" would be the same observation.
 */
describe("every person-scoped stream ends at its own person's death", () => {
  /** Month 0 of the run is 2026; the primary dies in 2071 and Sam in 2086. */
  const PRIMARY_DEATH = 540;
  const SAM_DEATH = 720;

  const flatSalary = (annualDollars: number) => ({
    startingSalaryCents: dollarsToCents(annualDollars),
    currentSalaryCents: dollarsToCents(annualDollars),
    realGrowthPct: 0,
  });

  /**
   * The primary and Sam, each holding one job that runs PAST its own owner's death — the
   * primary's to 2081 (month 660), Sam's to 2090 (month 768).
   *
   * **Built through RESTORATION**, like the stranded separations above and for the same reason:
   * authoring cannot produce this household any more. A job must end while its owner is alive
   * (`assertPersonEventsStillReachable`), so both jobs are authored against expectancies that
   * cover them and the expectancies are then lowered OUTSIDE the authoring gate — which is what
   * an imported file, a hand-edited state or one exported before the rule existed looks like.
   *
   * That is exactly the state `personActiveWindow` is a safeguard for, and what these tests are
   * about: the clamp is not the rule, it is what keeps such a household modelling sensibly
   * instead of paying a dead earner.
   *
   * `adjust` hangs further authoring off the jobs while the expectancies still cover them —
   * the pay changes and bonuses the tests below date around a death. It runs BEFORE the lowering
   * because every write revalidates the whole state, so a restored household this far out of
   * contract accepts no edits at all; what it still does is RUN, which is the subject here.
   */
  const household = (
    adjust: (p: Projection, jobs: { primaryJob: string; samJob: string }) => void = () => {},
  ) => {
    const authored = freshProjection();
    authored.updatePlan({ lifeExpectancy: 100 }); // dies 2086, so the 2081 job below is legal
    const samId = authored.marry({ month: 0, name: "Sam", birthYear: 1996, lifeExpectancy: 95 });
    const primaryJob = authored.addJob(P1, {
      startYear: 2030,
      endYear: 2081,
      salary: flatSalary(120_000),
    });
    const samJob = authored.addPartnerJob(samId, {
      startYear: 2030,
      endYear: 2090, // legal against Sam's authored 95, which reaches 2091
      salary: flatSalary(60_000),
    });
    adjust(authored, { primaryJob, samJob });

    const state = JSON.parse(JSON.stringify(authored.toState())) as ProjectionState;
    const lowered: ProjectionState = {
      ...state,
      scenario: {
        ...state.scenario,
        plan: {
          ...state.scenario.plan,
          primary: { ...state.scenario.plan.primary, lifeExpectancy: 85 }, // dies 2071
        },
        ledger: {
          ...state.scenario.ledger,
          events: state.scenario.ledger.events.map((e) =>
            e.type === "RelationshipEvent"
              ? { ...e, person: { ...e.person, lifeExpectancy: 90 } } // Sam dies 2086
              : e,
          ),
        },
      },
    };
    return { p: Projection.fromState(lowered, nullJurisdiction), samId, primaryJob, samJob };
  };

  it("restores such a household rather than refusing it, and clamps rather than trusting it", () => {
    // The contract restoration keeps: a file this build did not author OPENS. Whatever else is
    // true of it, the user gets their plan back and a run they can reason about — which is the
    // whole reason the clamp exists beside the authoring rule rather than instead of it.
    const { p, primaryJob } = household();
    expect(p.plan.primary.jobs.map((j) => j.endYear)).toEqual([2081]);
    expect(() => p.run(nullJurisdiction)).not.toThrow();
    expect(p.run(nullJurisdiction).jobPayDisplay(primaryJob)?.employmentSpan).toEqual({
      startMonth: 48,
      endMonthExclusive: PRIMARY_DEATH,
    });
  });

  it("but refuses every further EDIT while it stays out of contract — including the repair", () => {
    // The cost of validating the whole prospective state rather than only what an edit touches.
    // An unrelated field first: nothing about the inflation rate strands a job, and it is still
    // refused, because the state it would produce holds the same contradiction it arrived with.
    const { p, primaryJob } = household();
    expect(() => p.updatePlan({ inflationPct: 4 })).toThrow(
      /would run the 2030 job on to 2081.*live only to 2071/,
    );
    expect(p.plan.inflationPct).toBe(samplePlan.inflationPct);

    // And — the part that matters — SHORTENING the primary's job is refused too, because Sam's
    // job is still past Sam's own death and the check answers about the whole state. With two
    // violations standing there is no single write that clears both, so nothing repairs this
    // household: removing a job, raising an expectancy and rewriting either job all fail the
    // same way. **A known dead end**, pinned here rather than left to be discovered: a file
    // holding more than ONE stranded artifact can be opened and run, and not edited at all.
    const job = p.plan.primary.jobs.find((j) => j.id === primaryJob)!;
    expect(() => p.replaceJob(job.id, { ...job, endYear: 2071 })).toThrow(
      /would run the 2030 job on to 2090.*Sam is projected to live only to 2086/,
    );
    expect(() => p.removeJob(job.id)).toThrow(/must end while its owner is alive/);
    expect(() => p.updatePlan({ lifeExpectancy: 100 })).toThrow(/must end while its owner is alive/);
  });

  it("is repairable when it holds only ONE stranded artifact — the boundary of that dead end", () => {
    // The same restoration with a single violation: unrelated edits are still refused, but
    // shortening the job to the death clears it in one write and the household is ordinary
    // again. This is the difference between "refuses edits until you fix it" and "cannot be
    // fixed", and it is why the case above is worth stating.
    const authored = freshProjection();
    authored.updatePlan({ lifeExpectancy: 100 }); // dies 2086
    const jobId = authored.addJob(P1, { startYear: 2030, endYear: 2081, salary: flatSalary(120_000) });

    const state = JSON.parse(JSON.stringify(authored.toState())) as ProjectionState;
    const p = Projection.fromState(
      {
        ...state,
        scenario: {
          ...state.scenario,
          plan: { ...state.scenario.plan, primary: { ...state.scenario.plan.primary, lifeExpectancy: 85 } },
        },
      },
      nullJurisdiction,
    );

    expect(() => p.updatePlan({ inflationPct: 4 })).toThrow(/must end while its owner is alive/);
    const job = p.plan.primary.jobs.find((j) => j.id === jobId)!;
    expect(() => p.replaceJob(job.id, { ...job, endYear: 2071 })).not.toThrow();
    expect(() => p.updatePlan({ inflationPct: 4 })).not.toThrow();
    expect(p.plan.inflationPct).toBe(4);
  });

  /** What one job's income source paid in `month`, or `null` when it booked none at all. */
  const paidBy = (result: ReturnType<Projection["run"]>, jobId: string, month: number) =>
    result.series.months[month]!.flows!.incomeSources.find((s) => s.sourceId === `job:${jobId}`)
      ?.cashInflowCents ?? null;

  it("stops a wage at the owner's death while the same run keeps paying the survivor's", () => {
    // The heart of it, and the case a single-person fixture cannot show. The run reaches 720
    // because Sam does; the primary's job was authored to 2081 and pays nothing from 540, while
    // Sam's own job — authored past THEIR death, to 2090 — pays right up to 719.
    const { p, primaryJob, samJob } = household();
    const r = p.run(nullJurisdiction);
    expect(r.series.months.length).toBe(SAM_DEATH);

    expect(paidBy(r, primaryJob, PRIMARY_DEATH - 1)).toBe(3_262_036);
    expect(paidBy(r, primaryJob, PRIMARY_DEATH)).toBeNull();
    expect(paidBy(r, primaryJob, SAM_DEATH - 1)).toBeNull();

    expect(paidBy(r, samJob, PRIMARY_DEATH - 1)).toBe(1_631_028);
    // Alive and earning through the month the primary dies, and on to their own last month.
    expect(paidBy(r, samJob, PRIMARY_DEATH)).toBe(1_679_959);
    expect(paidBy(r, samJob, SAM_DEATH - 1)).toBe(2_541_090);
  });

  it("draws the job ending where it pays its last wage, on every surface", () => {
    // The requirement that there be ONE effective end date. These three are read by three
    // different consumers — the chart's job bar, the household's resolved span, and the series
    // the simulator banked — and each used to be free to answer with the authored end.
    const { p, primaryJob, samJob } = household();
    const r = p.run(nullJurisdiction);

    // 48 = the job's authored 2030 start; the end is the death, not the authored 2081.
    expect(r.jobPayDisplay(primaryJob)).toEqual({
      employmentSpan: { startMonth: 48, endMonthExclusive: PRIMARY_DEATH },
      paidSpan: { startMonth: 48, endMonthExclusive: PRIMARY_DEATH },
      // No uncounted stretch: death SHORTENS the employment rather than leaving a tail the
      // household was not paid for. That is what separates it from a separation, which leaves
      // the employment running and does strand a tail.
      uncountedSpans: [],
    });
    expect(resolvedJobEndMonth(r.household, primaryJob)).toBe(PRIMARY_DEATH - 1);
    expect(
      resolvedJobPaySpan(r.household, primaryJob, { startMonth: 48, endMonthExclusive: 660 }),
    ).toEqual({ startMonth: 48, endMonthExclusive: PRIMARY_DEATH });

    // Sam's authored 2090 end (month 768) is capped at their own 720 by the same rule.
    expect(r.jobPayDisplay(samJob)?.employmentSpan).toEqual({
      startMonth: 48,
      endMonthExclusive: SAM_DEATH,
    });
  });

  it("ignores a raise and a bonus dated after the earner has died", () => {
    // Both kinds of compensation adjustment, at once: a permanent pay change (which would have
    // reset the salary for every later month) and a one-month bonus. Neither lands, and neither
    // disturbs the months before — the pay at 539 is exactly what it is with no adjustments
    // authored at all, which is the assertion that says "ignored" rather than "clipped".
    const { p, primaryJob } = household((a, { primaryJob: job }) => {
      a.addJobPayChange(job, { month: 600, kind: "setTo", cents: dollarsToCents(20_000) });
      a.addJobIncomeOverride(job, { month: 602, kind: "addBonus", cents: dollarsToCents(50_000) });
    });
    const r = p.run(nullJurisdiction);

    expect(paidBy(r, primaryJob, PRIMARY_DEATH - 1)).toBe(3_262_036);
    for (const month of [PRIMARY_DEATH, 600, 602, SAM_DEATH - 1]) {
      expect(paidBy(r, primaryJob, month)).toBeNull();
    }
  });

  it("still applies a raise and a bonus dated while the earner is alive", () => {
    // The control the case above is worth nothing without. The same two adjustments, moved
    // before the death, do land: the salary is set to $20,000/month from 528 and the bonus adds
    // $50,000 to month 530 alone, with 539 back on the raised salary.
    const { p, primaryJob } = household((a, { primaryJob: job }) => {
      a.addJobPayChange(job, { month: 528, kind: "setTo", cents: dollarsToCents(20_000) });
      a.addJobIncomeOverride(job, { month: 530, kind: "addBonus", cents: dollarsToCents(50_000) });
    });
    const r = p.run(nullJurisdiction);

    expect(paidBy(r, primaryJob, 527)).toBe(3_167_025); // the un-raised path
    expect(paidBy(r, primaryJob, 528)).toBe(2_000_000);
    expect(paidBy(r, primaryJob, 530)).toBe(7_000_000);
    expect(paidBy(r, primaryJob, PRIMARY_DEATH - 1)).toBe(2_000_000);
    expect(paidBy(r, primaryJob, PRIMARY_DEATH)).toBeNull();
  });

  it("stops a government benefit at the same death, through the real household pipeline", () => {
    // The benefit is the one person-scoped stream DERIVED inside the simulator rather than
    // compiled upstream, so it is the one whose window has to survive a whole extra seam: the
    // household resolves `personActiveWindow`, `compilePerson` carries it across as
    // `SimPerson.activeWindow`, and the benefit loop reads it there. `governmentBenefit.test.ts`
    // hands that loop a window by hand and proves it is honoured; nothing proved the window it is
    // handed in a real run is the same one a wage is clipped by. This does.
    //
    // Under a flat benefit, so "did it stop?" is a question about the window and not about COLA
    // or a covered-earnings record. Both people claim at 67: the primary from month 324, Sam
    // from 444, and both are still being paid at 492.
    const { p, samId } = household();
    const r = p.run(flatBenefitJurisdiction());
    const benefit = (personId: string, month: number) =>
      r.series.months[month]!.flows!.incomeSources.find((s) => s.sourceId === `benefit:${personId}`)
        ?.cashInflowCents ?? null;

    expect(benefit(P1, 492)).toBe(FLAT_BENEFIT_MONTHLY_CENTS);
    expect(benefit(samId, 492)).toBe(FLAT_BENEFIT_MONTHLY_CENTS);

    // The primary's stops at their death, exactly where their wage did.
    expect(benefit(P1, PRIMARY_DEATH - 1)).toBe(FLAT_BENEFIT_MONTHLY_CENTS);
    expect(benefit(P1, PRIMARY_DEATH)).toBeNull();
    expect(benefit(P1, 600)).toBeNull();

    // And the survivor keeps drawing theirs, to their own last month.
    expect(benefit(samId, PRIMARY_DEATH)).toBe(FLAT_BENEFIT_MONTHLY_CENTS);
    expect(benefit(samId, SAM_DEATH - 1)).toBe(FLAT_BENEFIT_MONTHLY_CENTS);
  });

  it("does NOT step household spending down when a member dies", () => {
    // The deliberate asymmetry, pinned so it cannot be "tidied up" into symmetry. Income is
    // person-scoped and stops; spending is the household's and runs on to the horizon, funding
    // the survivor at full cost. Conservative rather than dangerous — and the reason this is a
    // PERSON window and not a household one.
    // The whole sample plan, not `freshProjection`'s stripped one: this is the only case here
    // that needs the budget lines, since it is about what the household SPENDS.
    const p = Projection.fromState(stateOf(samplePlan), nullJurisdiction);
    p.marry({ month: 0, name: "Sam", birthYear: 1996, lifeExpectancy: 90 });
    const r = p.run(nullJurisdiction);
    expect(r.series.months.length).toBe(SAM_DEATH);
    expect(r.series.months[PRIMARY_DEATH - 1]!.flows!.expensesCents).toBe(1_688_864);
    expect(r.series.months[600]!.flows!.expensesCents).toBe(2_016_592);
    expect(r.series.months[SAM_DEATH - 1]!.flows!.expensesCents).toBe(2_631_197);
  });
});
