/**
 * The `Projection` root's read paths that run the plan: `run(jurisdiction)` purity, authoring
 * validated against the construction-time jurisdiction, the retirement search, and the
 * stop-working-age preview.
 */
import { describe, it, expect } from "vitest";
import { Projection, resolvedJobPaySpan } from "../index";
import { resolvedJobEndMonth } from "../ledger/household";
import { samplePlan, stateOf, SAMPLE_START_YEAR } from "../testing/samplePlan";
import { mockJurisdiction } from "../testing/mockJurisdiction";
import { nullJurisdiction, type Jurisdiction } from "../jurisdiction/jurisdiction";
import { dollarsToCents } from "../money/cashFlowSeries";
import { goalFundAccountId } from "../compile/projectionBase";
import { type Job } from "../job/job";
import { P1, freshProjection, JOB_END_YEAR, plainJob } from "../testing/projectionFacadeFixtures";

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
  describe("a separation ends their claim on the horizon only while both are alive", () => {
    const SAM_REACH = (1996 + 85 - 2026) * 12; // 660
    const separatedAt = (month: number) => {
      const p = freshProjection();
      const partnerId = p.marry({
        month: 12,
        name: "Sam",
        birthYear: 1996,
        lifeExpectancy: samplePlan.primary.lifeExpectancy,
      });
      p.separate({ month, partnerPersonId: partnerId });
      return p;
    };

    it("BEFORE either death: Sam leaves, and the run stops at the primary's own expectancy", () => {
      expect(monthsOf(separatedAt(300))).toBe(PRIMARY_HORIZON);
      // Right up to the last month it can still happen.
      expect(monthsOf(separatedAt(PRIMARY_HORIZON - 1))).toBe(PRIMARY_HORIZON);
    });

    it("EXACTLY AT the first death: too late to happen, so Sam's tail stays in the run", () => {
      // Month 540 is the first month the primary is gone — there is no couple left to dissolve,
      // so the separation is not an event in either life and Sam is covered to their own 660.
      expect(monthsOf(separatedAt(PRIMARY_HORIZON))).toBe(SAM_REACH);
    });

    it("AFTER the first death: same answer — Sam never left while alive", () => {
      expect(monthsOf(separatedAt(600))).toBe(SAM_REACH);
      // Including a separation booked past Sam's OWN death, which is doubly moot.
      expect(monthsOf(separatedAt(700))).toBe(SAM_REACH);
    });

    it("covers the survivor through their death — the issue's worked example", () => {
      // Primary dies 2070, Sam dies 2080, separation booked for 2085. Sam never leaves while
      // alive, so the projection must run through 2080 rather than stopping at the primary's
      // 2070 and leaving the survivor's last decade unmodelled.
      const p = freshProjection();
      p.updatePlan({ lifeExpectancy: 84 }); // born 1986 → dies 2070
      const partnerId = p.marry({ month: 12, name: "Sam", birthYear: 1996, lifeExpectancy: 84 }); // → 2080
      p.separate({ month: (2085 - 2026) * 12, partnerPersonId: partnerId });
      expect(monthsOf(p)).toBe((2080 - 2026) * 12);
    });

    it("agrees with the anchor the panel names, at every point around the boundary", () => {
      // The reason the rule lives in one shared helper. The run's last month and the age the panel
      // prints are two readings of one horizon, so a household whose graph stops at Sam's death
      // must not be described by a sentence naming the primary's. Swept across the boundary rather
      // than spot-checked, because divergence is exactly what a copied rule produces at the edges.
      for (const month of [300, PRIMARY_HORIZON - 1, PRIMARY_HORIZON, 600, 700]) {
        const p = separatedAt(month);
        const anchor = p.retirement(nullJurisdiction).solution.horizonAnchor;
        const ranToSam = monthsOf(p) === SAM_REACH;
        expect({ month, named: anchor.memberName }).toEqual({
          month,
          named: ranToSam ? "Sam" : null,
        });
      }
    });

    it("is symmetric — a separation after the PARTNER's death is equally moot", () => {
      // Sam is older and dies 2061, before the primary's 2071; the separation is booked 2065.
      // Sam's own reach is below the primary's, so the horizon is unchanged — but the reason is
      // that Sam never left, not that they did.
      const p = freshProjection();
      const partnerId = p.marry({
        month: 12,
        name: "Sam",
        birthYear: 1976,
        lifeExpectancy: samplePlan.primary.lifeExpectancy,
      });
      p.separate({ month: (2065 - 2026) * 12, partnerPersonId: partnerId });
      expect(monthsOf(p)).toBe(PRIMARY_HORIZON);
    });
  });
});

describe("Projection root — authoring validates against the construction-time jurisdiction", () => {
  /**
   * Taxes `capitalGains` at `rate`, returning basis pro-rata — the same monotone shape the
   * `addEvent` gross-up requires. A brokerage down-payment source therefore nets less than its
   * face balance under this jurisdiction, and exactly its balance under {@link nullJurisdiction}.
   */
  function flatCapitalGains(rate: number): Jurisdiction {
    return {
      id: "test-capital-gains",
      computeTaxCents: (byCat) => Math.round((byCat.capitalGains ?? 0) * rate),
      computeTaxByCategoryCents: (byCat) => {
        const tax = Math.round((byCat.capitalGains ?? 0) * rate);
        return tax > 0 ? { capitalGains: tax } : {};
      },
      taxableWithdrawalCents: ({ grossCents, basisCents, balanceCents }) => {
        const basisFraction = balanceCents > 0 ? Math.min(1, basisCents / balanceCents) : 0;
        return grossCents - Math.round(grossCents * basisFraction);
      },
    };
  }

  /**
   * A single high-growth brokerage goal, so surplus accrues into ONE liquid capital-gains
   * account whose balance outruns its basis. By month 24 it holds ~$96.8k of which a large
   * share is embedded gain — the setup that makes a mid-range down payment affordable pre-tax
   * and short once the gain is taxed.
   */
  const NEST_GOAL = {
    id: "nest",
    name: "Nest",
    targetCents: dollarsToCents(1_000_000),
    targetDate: 60,
    disposition: "retain",
    annualReturnPct: 40,
    accountType: "brokerage",
  } as const;

  function nestProjection(jurisdiction: Jurisdiction): Projection {
    return Projection.fromState(stateOf({ ...samplePlan, goals: [NEST_GOAL] }), jurisdiction);
  }

  // A $90k down payment against a ~$96.8k balance: the face balance covers it, the capital-gains
  // tax on liquidating the embedded gain does not.
  const buyFromNest = {
    month: 24,
    ownerId: P1,
    purchasePriceCents: dollarsToCents(300000),
    downPaymentCents: dollarsToCents(90000),
    downPaymentSourceIds: [goalFundAccountId(NEST_GOAL)],
    mortgageApr: 6,
    mortgageTermMonths: 360,
  };

  it("refuses a buyHome the validation jurisdiction's §4.5 tax gate rejects", () => {
    // Under a capital-gains jurisdiction the funded gain grosses the draw up past the balance,
    // so the gate blocks — the false-accept this change closes.
    const p = nestProjection(flatCapitalGains(0.5));
    expect(() => p.buyHome(buyFromNest)).toThrow(/tax/i);
    expect(p.ledger.events).toHaveLength(0);
  });

  it("accepts the same buyHome when constructed against nullJurisdiction", () => {
    // No tax, so the balance nets in full and the down payment clears — the path that made the
    // weaker check invisible before, now reachable only by asking for it explicitly.
    const p = nestProjection(nullJurisdiction);
    expect(() => p.buyHome(buyFromNest)).not.toThrow();
    // Two events: the financing mortgage and the property that secures against it.
    expect(p.ledger.events).toHaveLength(2);
  });

  it("keeps run(jurisdiction) independent of the authoring jurisdiction", () => {
    // Authored under a taxing jurisdiction that would refuse the purchase, then projected
    // under another: run() takes its own jurisdiction and never consults the authoring one,
    // so one scenario still re-runs under whatever rules a caller asks for.
    const p = nestProjection(flatCapitalGains(0.5));
    p.marry({ month: 12, name: "Partner", birthYear: 1990, lifeExpectancy: samplePlan.primary.lifeExpectancy });
    expect(p.run(nullJurisdiction).jurisdictionId).toBe(nullJurisdiction.id);
    expect(p.run(flatCapitalGains(0.5)).jurisdictionId).toBe("test-capital-gains");
    expect(p.run(mockJurisdiction()).jurisdictionId).toBe("mock");
  });
});

// ── Reads ────────────────────────────────────────────────────────────────────
//
// The facade answers questions about a household as well as authoring one. Two homes, split
// by what each needs: a question about the plan as authored is a `Projection` method, while
// one that needs the simulated future rides the `ProjectionResult` a `run` produced — asked
// off the pass already in hand rather than provoking another.

describe("Projection.retirement — the whole question, one search", () => {
  const CURRENT_AGE = SAMPLE_START_YEAR - samplePlan.primary.birthYear;

  const covered = mockJurisdiction({
    publicHealthCoverageAge: 65,
    healthCostBenchmarkMonthlyCents: () => dollarsToCents(1000),
  });

  const outlookOf = (plan: typeof samplePlan, jurisdiction = nullJurisdiction) =>
    Projection.fromState(stateOf(plan), nullJurisdiction).retirement(jurisdiction);

  it("reports the solved age and the authored stop, and pins no target between them", () => {
    // `target` went with `Plan.retirementAge`. What is left is the pair that cannot disagree
    // with the jobs: the earliest age the search reached, and the age the plan already stops.
    const outlook = outlookOf(samplePlan) as unknown as Record<string, unknown>;
    expect(outlook.target).toBeUndefined();
    expect(outlookOf(samplePlan).solution.fullRetirementAge).toBe(60);
    expect(outlookOf(samplePlan).solution.plannedWorkStopAge).toBe(60);
  });

  it("dates the full-retirement age in months from now, for a chart's reference line", () => {
    const outlook = outlookOf(samplePlan);
    const age = outlook.solution.fullRetirementAge;
    expect(age).not.toBeNull();
    expect(outlook.fullRetirementMonth).toBe((age! - CURRENT_AGE) * 12);
  });

  it("dates a BLOCK as an age, the mirror of dating the solved age as a month", () => {
    // Months and ages are one clock read two ways, and it is this package's clock: a caller that
    // converted the blocked month itself would be re-deriving where "now" sits on a plan it can
    // only see the outside of. Authored affordable, then stranded by lowering the opening balance
    // — the §4.5 gate refuses an unaffordable purchase up front, so a block has to be made this way.
    const p = Projection.fromState(stateOf(samplePlan), nullJurisdiction);
    p.updatePlan({ openingBalanceCents: dollarsToCents(500000) });
    p.buyHome({
      month: 24,
      ownerId: P1,
      purchasePriceCents: dollarsToCents(600000),
      downPaymentCents: dollarsToCents(400000),
      downPaymentSourceIds: ["savings"],
      mortgageApr: 6,
      mortgageTermMonths: 360,
    });
    p.updatePlan({ openingBalanceCents: dollarsToCents(1000) });

    const series = p.run(nullJurisdiction).series;
    expect(series.status).toBe("blocked");
    const outlook = p.retirement(nullJurisdiction);
    expect(outlook.solution.blocked).toBe(true);
    // Two years out on a plan aged 40 → 42, floored to whole years like every reported age.
    expect(outlook.blockedAtAge).toBe(CURRENT_AGE + 2);
  });

  it("states no blocked age for a projection that was never blocked", () => {
    expect(outlookOf(samplePlan).blockedAtAge).toBeNull();
  });

  it("flags a health gap only when the SOLVED age lands before the coverage age", () => {
    // The sample plan solves to 60. With $600/mo authored against a $1,000/mo benchmark that
    // is a 5-year gap — measured off the search's answer, not off any figure the plan states.
    const flag = outlookOf(samplePlan, covered).earlyRetireeHealth;
    expect(flag.gapYears).toBe(5);
    expect(flag.shortfallMonthlyCents).toBe(dollarsToCents(400));

    // A coverage age the household already clears closes the window, whatever the line says.
    const coversEarly = mockJurisdiction({
      publicHealthCoverageAge: 55,
      healthCostBenchmarkMonthlyCents: () => dollarsToCents(1000),
    });
    expect(outlookOf(samplePlan, coversEarly).earlyRetireeHealth.gapYears).toBe(0);
    // A jurisdiction naming no coverage age has no window to be early for.
    expect(outlookOf(samplePlan).earlyRetireeHealth.gapYears).toBe(0);
  });

  it("raises no health gap for a household that can never retire", () => {
    // No solved age is not an early one. Flagging here would warn about a retirement the plan
    // cannot take, which is exactly what measuring against a pinned age used to do.
    const broke = {
      ...samplePlan,
      openingBalanceCents: 0,
      primary: { ...samplePlan.primary, jobs: [] },
    };
    const outlook = outlookOf(broke, covered);
    expect(outlook.solution.fullRetirementAge).toBeNull();
    expect(outlook.earlyRetireeHealth.flagged).toBe(false);
    expect(outlook.earlyRetireeHealth.gapYears).toBe(0);
  });

  it("leaves run() alone — a simulation is not a search", () => {
    const p = Projection.fromState(stateOf(samplePlan), nullJurisdiction);
    const result = p.run(nullJurisdiction);
    // Nothing on a run answers the retirement question, so a caller that only wants the graph
    // never pays for the search.
    expect("retirement" in result).toBe(false);
    expect(result.series.months.length).toBeGreaterThan(0);
  });
});

describe("Projection root — previewing a stop-working age", () => {
  /** Wages the household draws in `month`, the signal the income chart bands. */
  const wagesAt = (result: ReturnType<Projection["run"]>, month: number): number =>
    result.series.months[month]?.flows?.incomeByCategoryCents.wages ?? 0;

  const CURRENT_AGE = SAMPLE_START_YEAR - samplePlan.primary.birthYear;

  // The sample primary works an open-ended job to age 60 (`retirementAge`), from age 40.
  const AGE_50_MONTH = (50 - CURRENT_AGE) * 12;

  it("ceases every job at the candidate age without touching the authored plan", () => {
    const p = Projection.fromState(stateOf(samplePlan), nullJurisdiction);
    const before = p.state;

    // Stop at 45: fifteen years short of the authored age-60 stop, so age 50 has no wages.
    const preview = p.runAtStopWorkingAge(nullJurisdiction, 45);
    expect(wagesAt(preview, AGE_50_MONTH)).toBe(0);

    // The authored run is untouched — the primary still earns to 60 — and no write happened.
    expect(wagesAt(p.run(nullJurisdiction), AGE_50_MONTH)).toBeGreaterThan(0);
    expect(p.state).toBe(before);
  });

  it("EXTENDS the last job when the candidate is later — that is the 'work longer' question", () => {
    // The authored job ends at 60, so the authored run pays nothing at 63. Asking "what if we
    // retired at 65?" has to be allowed to run that same employment five years longer, or the
    // question cannot be asked at all — and the solver could never find an age past the one
    // already written down.
    const p = Projection.fromState(stateOf(samplePlan), nullJurisdiction);
    const AGE_63_MONTH = (63 - CURRENT_AGE) * 12;
    expect(wagesAt(p.run(nullJurisdiction), AGE_63_MONTH)).toBe(0);
    expect(wagesAt(p.runAtStopWorkingAge(nullJurisdiction, 65), AGE_63_MONTH)).toBeGreaterThan(0);
    // The authored plan is untouched — the extension lives only in the hypothesis.
    expect(p.plan.primary.jobs[0]!.endYear).toBe(SAMPLE_START_YEAR - CURRENT_AGE + 60);
  });

  it("previews the SOLVED age self-consistently — the toggle shows what the headline means", () => {
    // The QA path a user actually walks: read the headline age off the panel, turn the preview
    // on, and see the charts. Those are two separate engine calls (`retirement`, then
    // `runAtStopWorkingAge`), and nothing but this pins that they agree — a preview built on a
    // different hypothesis from the search would draw a working life the headline never meant.
    const tight = { ...samplePlan, openingBalanceCents: 0 };
    const p = Projection.fromState(stateOf(tight), nullJurisdiction);
    const headline = p.retirement(nullJurisdiction).solution.fullRetirementAge;
    expect(headline).not.toBeNull();
    const age = headline as number;

    const preview = p.runAtStopWorkingAge(nullJurisdiction, age);
    // Work runs right up to the headline age — including past the job's authored end at 60,
    // which is the whole reason that age is reachable...
    expect(wagesAt(preview, (age - 1 - CURRENT_AGE) * 12)).toBeGreaterThan(0);
    // ...and stops there.
    expect(wagesAt(preview, (age - CURRENT_AGE) * 12)).toBe(0);
    // And the plan the headline promised survives really does survive in the previewed run.
    expect(preview.series.months.every((m) => m.netWorthRealCents !== null)).toBe(true);
  });

  it("leaves the authored plan alone when the preview EXTENDED work, not just when it capped", () => {
    // The no-mutation guarantee is easy to hold while a hypothesis only ever subtracts. It now
    // adds employment the plan does not contain, so this walks the toggle both ways: preview a
    // later age, then read the authored run back and find it unchanged, byte for byte.
    const p = Projection.fromState(stateOf(samplePlan), nullJurisdiction);
    const before = p.state;
    const authoredBefore = JSON.stringify(p.run(nullJurisdiction).series.months);

    const AGE_63_MONTH = (63 - CURRENT_AGE) * 12;
    expect(wagesAt(p.runAtStopWorkingAge(nullJurisdiction, 70), AGE_63_MONTH)).toBeGreaterThan(0);

    // Toggling back off: the authored projection is identical, and no write ever happened.
    expect(JSON.stringify(p.run(nullJurisdiction).series.months)).toBe(authoredBefore);
    expect(wagesAt(p.run(nullJurisdiction), AGE_63_MONTH)).toBe(0);
    expect(p.state).toBe(before);
    expect(p.plan.primary.jobs[0]!.endYear).toBe(SAMPLE_START_YEAR - CURRENT_AGE + 60);
  });

  it("hands back a whole read-only result, answered under the run jurisdiction", () => {
    const p = Projection.fromState(stateOf(samplePlan), nullJurisdiction);
    const preview = p.runAtStopWorkingAge(nullJurisdiction, 55);
    // The full ProjectionResult — roster and report beside the series — so the income and
    // net-worth charts read one preview pass, exactly as they read one authored pass.
    expect(preview.jurisdictionId).toBe(nullJurisdiction.id);
    expect(preview.household.memberships).toHaveLength(1);
    expect(preview.report).toBeDefined();
    expect(Object.isFrozen(preview)).toBe(true);
  });

  describe("resolvedJobEndMonth — the resolved end every chart should read instead of re-deriving it", () => {
    // The sample primary's open-ended job (`job-main`) naturally ends at the authored
    // retirement age, 60, from a current age of 40.
    it("reads the authored retirement age off the authored run", () => {
      const p = Projection.fromState(stateOf(samplePlan), nullJurisdiction);
      expect(resolvedJobEndMonth(p.run(nullJurisdiction).household, "job-main")).toBe(
        (60 - CURRENT_AGE) * 12 - 1,
      );
    });

    it("moves the last job's resolved end to a later preview candidate", () => {
      // The chart reads this, so previewing "retire at 65" draws the job running to 65 — the
      // same thing the headline age means.
      const p = Projection.fromState(stateOf(samplePlan), nullJurisdiction);
      const preview = p.runAtStopWorkingAge(nullJurisdiction, 65);
      expect(resolvedJobEndMonth(preview.household, "job-main")).toBe(
        (65 - CURRENT_AGE) * 12 - 1,
      );
    });

    it("caps an open-ended job short of the authored age when the preview candidate is earlier", () => {
      const p = Projection.fromState(stateOf(samplePlan), nullJurisdiction);
      const preview = p.runAtStopWorkingAge(nullJurisdiction, 45);
      expect(resolvedJobEndMonth(preview.household, "job-main")).toBe(
        (45 - CURRENT_AGE) * 12 - 1,
      );
    });

    it("returns null for an id with no matching job series", () => {
      const p = Projection.fromState(stateOf(samplePlan), nullJurisdiction);
      expect(resolvedJobEndMonth(p.run(nullJurisdiction).household, "no-such-job")).toBeNull();
    });
  });

  describe("resolvedJobPaySpan — the same resolution as a span, empty when the run pays nothing", () => {
    // A job the primary only picks up at 55, on top of the one they already hold. Open-ended,
    // so the authored plan pays it from 55 to the authored stop at 60.
    const laterJob: Job = {
      id: "job-later",
      ownerId: "p1",
      startYear: SAMPLE_START_YEAR - CURRENT_AGE + 55,
      endYear: JOB_END_YEAR,
      salary: {
        startingSalaryCents: dollarsToCents(36000),
        currentSalaryCents: dollarsToCents(36000),
        realGrowthPct: 0,
      },
    };
    const withLaterJob = {
      ...samplePlan,
      primary: { ...samplePlan.primary, jobs: [...samplePlan.primary.jobs, laterJob] },
    };
    /** The job's authored start, in months from "now" — the caller's half of the span. */
    const AUTHORED_START = (55 - CURRENT_AGE) * 12;
    const authoredSpan = { startMonth: AUTHORED_START, endMonthExclusive: (60 - CURRENT_AGE) * 12 };

    it("carries the caller's start and takes the end from the run", () => {
      const p = Projection.fromState(stateOf(withLaterJob), nullJurisdiction);
      expect(resolvedJobPaySpan(p.run(nullJurisdiction).household, "job-later", authoredSpan)).toEqual({
        startMonth: AUTHORED_START,
        // The authored stop at 60 — one past the last month paid.
        endMonthExclusive: (60 - CURRENT_AGE) * 12,
      });
    });

    it("caps the span when the preview candidate lands inside the job", () => {
      const p = Projection.fromState(stateOf(withLaterJob), nullJurisdiction);
      const preview = p.runAtStopWorkingAge(nullJurisdiction, 57);
      expect(resolvedJobPaySpan(preview.household, "job-later", authoredSpan)).toEqual({
        startMonth: AUTHORED_START,
        endMonthExclusive: (57 - CURRENT_AGE) * 12,
      });
    });

    it("empties the span for a job the run never reaches — absence of a series is zero, not a fallback", () => {
      // Stopping at 45 retires the household ten years before this job would have started, so
      // the run compiles no series for it. The span must collapse rather than fall back to the
      // authored one: a caller that falls back charts income the preview explicitly removed.
      const p = Projection.fromState(stateOf(withLaterJob), nullJurisdiction);
      const preview = p.runAtStopWorkingAge(nullJurisdiction, 45);
      expect(resolvedJobEndMonth(preview.household, "job-later")).toBeNull();
      expect(resolvedJobPaySpan(preview.household, "job-later", authoredSpan)).toEqual({
        startMonth: AUTHORED_START,
        endMonthExclusive: AUTHORED_START, // pays no month at all
      });
      // The authored plan still holds the job, untouched — this resolves what a household PAYS.
      expect(p.state.scenario.plan.primary.jobs.map((j) => j.id)).toContain("job-later");
    });
  });
});

/**
 * `setContinuationJob` as the npm API surface — the one write that names a PERSON rather than a
 * job, and therefore the one that has to settle a plane from a person id instead of taking the
 * caller's word for it.
 *
 * The state function underneath is covered in `authoring/jobs.test.ts`. What is asserted here is
 * the contract a package consumer actually holds: one method for both planes, reads that answer
 * with what was written, and refusals that leave the handle usable.
 */
