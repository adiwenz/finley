/**
 * The `Projection` root's read paths that run the plan: `run(jurisdiction)` purity, authoring
 * validated against the construction-time jurisdiction, the retirement search, and the
 * stop-working-age preview.
 */
import { describe, it, expect } from "vitest";
import { Projection, resolvedJobPaySpan, type ProjectionState } from "../index";
import { resolvedJobEndMonth } from "../ledger/household";
import { samplePlan, stateOf, SAMPLE_START_YEAR } from "../testing/samplePlan";
import { mockJurisdiction } from "../testing/mockJurisdiction";
import {
  FLAT_BENEFIT_MONTHLY_CENTS,
  flatBenefitJurisdiction,
} from "../testing/flatBenefitJurisdiction";
import { nullJurisdiction, type Jurisdiction } from "../jurisdiction/jurisdiction";
import { dollarsToCents } from "../money/cashFlowSeries";
import { goalFundAccountId } from "../compile/projectionBase";
import { type Job, type PersonId } from "../job/job";
import { P1, freshProjection, JOB_END_YEAR, plainJob, partnerEvent } from "../testing/projectionFacadeFixtures";

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

    it("BEFORE either death: Sam leaves, and the run stops at the primary's own expectancy", () => {
      expect(monthsOf(strandedAt(300))).toBe(PRIMARY_HORIZON);
      // Right up to the last month it can still happen.
      expect(monthsOf(strandedAt(PRIMARY_HORIZON - 1))).toBe(PRIMARY_HORIZON);
    });

    it("EXACTLY AT the first death: too late to happen, so Sam's tail stays in the run", () => {
      // Month 540 is the first month the primary is gone — there is no couple left to dissolve,
      // so the separation is not an event in either life and Sam is covered to their own 660.
      expect(monthsOf(strandedAt(PRIMARY_HORIZON))).toBe(SAM_REACH);
    });

    it("AFTER the first death: same answer — Sam never left while alive", () => {
      expect(monthsOf(strandedAt(600))).toBe(SAM_REACH);
      // Including a separation stranded past Sam's OWN death, which is doubly moot.
      expect(monthsOf(strandedAt(700))).toBe(SAM_REACH);
    });

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

    it("is symmetric — a separation after the PARTNER's death is equally moot", () => {
      // Sam is OLDER (born 1976) and so dies 2061, before the primary's 2071, with the separation
      // stranded at 2065. Sam's own reach is below the primary's, so the horizon is unchanged —
      // but the reason is that Sam never left, not that they did, and the binding death here is
      // the PARTNER's rather than the primary's.
      const authored = freshProjection();
      authored.updatePlan({ lifeExpectancy: 100 });
      const partnerId = authored.marry({
        month: 12,
        name: "Sam",
        birthYear: 1976,
        lifeExpectancy: 95,
      });
      authored.separate({ month: (2065 - 2026) * 12, partnerPersonId: partnerId });
      const state = JSON.parse(JSON.stringify(authored.toState())) as ProjectionState;
      const lowered = {
        ...state,
        scenario: {
          ...state.scenario,
          plan: {
            ...state.scenario.plan,
            primary: {
              ...state.scenario.plan.primary,
              lifeExpectancy: samplePlan.primary.lifeExpectancy,
            },
          },
          ledger: {
            ...state.scenario.ledger,
            events: state.scenario.ledger.events.map((e) =>
              e.type === "RelationshipEvent"
                ? { ...e, person: { ...e.person, lifeExpectancy: samplePlan.primary.lifeExpectancy } }
                : e,
            ),
          },
        },
      } as ProjectionState;
      expect(monthsOf(Projection.fromState(lowered, nullJurisdiction))).toBe(PRIMARY_HORIZON);
    });
  });
});

/**
 * A marriage and a separation are both things a COUPLE does, so neither can be dated at or after
 * `min(the primary's death, the partner's)`. Refused at the moment it is authored rather than
 * silently modelled — a plan holding an event nobody could have lived through is a plan whose own
 * timeline disagrees with the answer beside it.
 *
 * The sample primary is born 1986 at expectancy 85, so they are gone from month 540 (2071).
 */
describe("Projection root — a marriage or separation needs both partners alive", () => {
  const marriedTo = (birthYear: number, lifeExpectancy: number) => {
    const p = freshProjection();
    const partnerId = p.marry({ month: 12, name: "Sam", birthYear, lifeExpectancy });
    return { p, partnerId };
  };

  it("refuses a separation dated AT the first death, naming who dies and when", () => {
    const { p, partnerId } = marriedTo(1996, samplePlan.primary.lifeExpectancy);
    expect(() => p.separate({ month: 540, partnerPersonId: partnerId })).toThrow(
      /cannot separate — a separation in 2071 needs both partners alive.*live only to 2071/,
    );
  });

  it("refuses one dated after it, and accepts the last month that still works", () => {
    const { p, partnerId } = marriedTo(1996, samplePlan.primary.lifeExpectancy);
    expect(() => p.separate({ month: 600, partnerPersonId: partnerId })).toThrow(/cannot separate/);
    // The boundary is exclusive on the death month, so 539 is still a month both are alive in.
    expect(() => p.separate({ month: 539, partnerPersonId: partnerId })).not.toThrow();
  });

  it("bounds a separation by the PARTNER's death when they go first", () => {
    // Sam is born 1976 at expectancy 85 → gone from 2061, a decade before the primary.
    const { p, partnerId } = marriedTo(1976, samplePlan.primary.lifeExpectancy);
    expect(() => p.separate({ month: (2065 - 2026) * 12, partnerPersonId: partnerId })).toThrow(
      /Sam is projected to live only to 2061/,
    );
  });

  it("refuses a marriage dated after the primary's death, and mints nothing", () => {
    const p = freshProjection();
    const before = p.toState().nextSeq;
    expect(() =>
      p.marry({ month: 600, name: "Sam", birthYear: 1996, lifeExpectancy: 85 }),
    ).toThrow(/a marriage in 2076 needs both partners alive/);
    // Refused before the first mint, so no id was issued and then abandoned.
    expect(p.toState().nextSeq).toBe(before);
    expect(p.ledger.events).toEqual([]);
  });

  it("refuses marrying someone the plan has already buried", () => {
    // Sam is born 1950 at expectancy 77 → alive at "now" (2026, aged 76) and gone from 2027, the
    // year of the wedding. Deliberately not someone ALREADY past their expectancy: that is
    // refused one step earlier, by the age floor, and would not exercise this guard at all.
    const p = freshProjection();
    expect(() =>
      p.marry({ month: 12, name: "Sam", birthYear: 1950, lifeExpectancy: 77 }),
    ).toThrow(/Sam is projected to live only to 2027/);
  });

  it("refuses a partner whose expectancy is already behind them, before asking about dates", () => {
    // The floor, and the reason it is worth having separately: this partner has no window at all
    // — no job of theirs could pay a month, no benefit could ever be claimed — so there is no
    // date the marriage could be moved to that would make the plan mean anything.
    const p = freshProjection();
    expect(() => p.marry({ month: 12, name: "Sam", birthYear: 1950, lifeExpectancy: 60 })).toThrow(
      /lifeExpectancy 60 — it must be past the age they already are \(76\)/,
    );
  });

  it("still accepts a partnering anchored in the PAST — a negative month precedes any death", () => {
    const p = freshProjection();
    expect(() =>
      p.startPartnered({ partneredForMonths: 24, name: "Sam", birthYear: 1996, lifeExpectancy: 85 }),
    ).not.toThrow();
  });

  // The other direction. Anything scoped to a person and legal when written can be STRANDED by a
  // later edit that moves a death earlier — and no second write to that thing happens, so nothing
  // would catch it. Both edit paths therefore revalidate the whole state they would produce.
  describe("an edit that would strand an existing separation is refused", () => {
    /** A household with a separation in 2076, legal against expectancies of 100 and 95. */
    const withLateSeparation = () => {
      const p = freshProjection();
      p.updatePlan({ lifeExpectancy: 100 }); // dies 2086
      const partnerId = p.marry({ month: 12, name: "Sam", birthYear: 1996, lifeExpectancy: 95 });
      p.separate({ month: 600, partnerPersonId: partnerId }); // 2076
      return { p, partnerId };
    };

    it("updatePlan: refuses a lowered life expectancy, naming what it would strand", () => {
      const { p } = withLateSeparation();
      expect(() => p.updatePlan({ lifeExpectancy: 85 })).toThrow(
        /would strand the 2076 separation.*live only to 2071.*both partners alive/,
      );
      // And leaves the plan exactly as it was — a refused write moves nothing.
      expect(p.plan.primary.lifeExpectancy).toBe(100);
    });

    it("updatePlan: refuses a moved BIRTH YEAR too — it moves the death just as surely", () => {
      const { p } = withLateSeparation();
      expect(() => p.updatePlan({ birthYear: 1970 })).toThrow(/would strand the 2076 separation/);
      expect(p.plan.primary.birthYear).toBe(samplePlan.primary.birthYear);
    });

    it("reviseTransaction: refuses lowering the PARTNER's expectancy under their own separation", () => {
      const { p, partnerId } = withLateSeparation();
      expect(() => p.reviseTransaction(partnerId, { type: "marry", lifeExpectancy: 60 })).toThrow(
        /would strand the 2076 separation.*Sam is projected to live only to 2056/,
      );
      expect(partnerEvent(p).person.lifeExpectancy).toBe(95);
    });

    it("reviseTransaction: refuses a moved partner birth year for the same reason", () => {
      const { p, partnerId } = withLateSeparation();
      expect(() => p.reviseTransaction(partnerId, { type: "marry", birthYear: 1940 })).toThrow(
        /would strand the 2076 separation/,
      );
      expect(partnerEvent(p).person.birthYear).toBe(1996);
    });

    it("still allows an edit that keeps the separation reachable", () => {
      // The guard is about reachability, not about expectancies being immovable: 99 still leaves
      // the primary alive in 2076, so the edit lands.
      const { p, partnerId } = withLateSeparation();
      expect(() => p.updatePlan({ lifeExpectancy: 99 })).not.toThrow();
      expect(p.plan.primary.lifeExpectancy).toBe(99);
      expect(() =>
        p.reviseTransaction(partnerId, { type: "marry", lifeExpectancy: 90 }),
      ).not.toThrow();
    });

    it("leaves an unrelated scalar edit alone", () => {
      const { p } = withLateSeparation();
      expect(() => p.updatePlan({ inflationPct: 4 })).not.toThrow();
    });

    it("does not fire for a household with no separation at all", () => {
      // The common case: lowering an expectancy is an ordinary edit, and must stay one.
      const p = freshProjection();
      p.marry({ month: 12, name: "Sam", birthYear: 1996, lifeExpectancy: 85 });
      expect(() => p.updatePlan({ lifeExpectancy: 70 })).not.toThrow();
      expect(p.plan.primary.lifeExpectancy).toBe(70);
    });
  });

  // A separation is one person-scoped thing among several, and the rule is not about separations:
  // anything that names a person through the ownership it already carries — the marriage itself, a
  // loan somebody takes out, a job somebody starts — is bounded by that person's death, and an edit
  // that moves the death under one of them is refused the same way. Both edit paths, both people.
  describe("the same refusal covers every person-scoped event, not only separations", () => {
    /**
     * A household married in 2076, legal against expectancies of 100 and 95 — the wedding itself
     * is the far-future event here, so nothing but the marriage is at stake.
     */
    const marriedLate = () => {
      const p = freshProjection();
      p.updatePlan({ lifeExpectancy: 100 }); // the primary dies 2086
      const partnerId = p.marry({ month: 600, name: "Sam", birthYear: 1996, lifeExpectancy: 95 });
      return { p, partnerId };
    };

    /** The same household, married at once, with a far-future thing hung off each person. */
    const marriedEarly = () => {
      const p = freshProjection();
      p.updatePlan({ lifeExpectancy: 100 });
      const partnerId = p.marry({ month: 12, name: "Sam", birthYear: 1996, lifeExpectancy: 95 });
      return { p, partnerId };
    };

    const studentLoan = (month: number, ownerId: string) => ({
      month,
      ownerId: ownerId as PersonId,
      kind: "studentLoan" as const,
      openingBalanceCents: dollarsToCents(20000),
      apr: 5,
      termMonths: 120,
    });

    describe("1. a relationship start", () => {
      it("updatePlan: refuses a primary expectancy that lands before their own wedding", () => {
        const { p } = marriedLate();
        expect(() => p.updatePlan({ lifeExpectancy: 85 })).toThrow(
          /would strand the 2076 marriage.*live only to 2071.*a marriage needs both partners alive/,
        );
        expect(p.plan.primary.lifeExpectancy).toBe(100);
      });

      it("reviseTransaction: refuses a partner expectancy that lands before the same wedding", () => {
        const { p, partnerId } = marriedLate();
        expect(() => p.reviseTransaction(partnerId, { type: "marry", lifeExpectancy: 60 })).toThrow(
          /would strand the 2076 marriage.*Sam is projected to live only to 2056/,
        );
        expect(partnerEvent(p).person.lifeExpectancy).toBe(95);
      });
    });

    // 2. a separation — the block above, which covers both edit paths and both partners.

    describe("3. another person-scoped event — a loan, and a job", () => {
      it("updatePlan: refuses an expectancy that lands before a loan the PRIMARY owns", () => {
        // A loan is owner-scoped, not couple-scoped, so the refusal says so: its owner, not both
        // partners. Month 660 is 2081; the primary at 85 is gone from 2071.
        const p = freshProjection();
        p.updatePlan({ lifeExpectancy: 100 });
        p.takeLoan(studentLoan(660, p.plan.primary.id));
        expect(() => p.updatePlan({ lifeExpectancy: 85 })).toThrow(
          /would strand the 2081 loan.*live only to 2071.*a loan needs its owner alive/,
        );
        expect(p.plan.primary.lifeExpectancy).toBe(100);
      });

      it("reviseTransaction: refuses a partner expectancy that lands before a loan THEY own", () => {
        // Month 700 is 2084, and the primary's own 2086 death does not bound it — a loan takes
        // only its owner. Sam at 80 is gone from 2076.
        const { p, partnerId } = marriedEarly();
        p.takeLoan(studentLoan(700, partnerId));
        expect(() => p.reviseTransaction(partnerId, { type: "marry", lifeExpectancy: 80 })).toThrow(
          /would strand the 2084 loan.*Sam is projected to live only to 2076.*its owner alive/,
        );
        expect(partnerEvent(p).person.lifeExpectancy).toBe(95);
      });

      it("updatePlan: refuses an expectancy that lands before a job the PRIMARY starts", () => {
        // A job is person-scoped like an event, and its START is what a death can STRAND: nobody
        // takes up work in 2080 having died in 2071, so there is no plan left to interpret and
        // the edit is refused. An end past the death is a different case — see below.
        const p = freshProjection();
        p.updatePlan({ lifeExpectancy: 100 });
        p.addJob(p.plan.primary.id, { ...plainJob, startYear: 2080, endYear: 2085 });
        expect(() => p.updatePlan({ lifeExpectancy: 85 })).toThrow(
          /would strand the 2080 job.*live only to 2071.*a job needs its owner alive/,
        );
        expect(p.plan.primary.lifeExpectancy).toBe(100);
      });

      it("reviseTransaction: refuses a partner expectancy that lands before a job THEY start", () => {
        const { p, partnerId } = marriedEarly();
        p.addPartnerJob(partnerId, { ...plainJob, startYear: 2080, endYear: 2085 });
        expect(() => p.reviseTransaction(partnerId, { type: "marry", lifeExpectancy: 80 })).toThrow(
          /would strand the 2080 job.*Sam is projected to live only to 2076/,
        );
        expect(partnerEvent(p).person.lifeExpectancy).toBe(95);
      });

      it("leaves a HOUSEHOLD event alone — a child names no person, so no death bounds one", () => {
        // The line the rule draws: a person-scoped thing is one the event's own fields name a
        // person on. A `ChildEvent` names none, so an expectancy that falls before it strands
        // nothing and the edit lands.
        const p = freshProjection();
        p.updatePlan({ lifeExpectancy: 100 });
        p.haveChild({ month: 700, name: "Kid", annualCostCents: 0 }); // 2084
        expect(() => p.updatePlan({ lifeExpectancy: 85 })).not.toThrow();
        expect(p.plan.primary.lifeExpectancy).toBe(85);
      });
    });

    describe("4. no event stranded — the edit lands", () => {
      it("updatePlan: a lowered primary expectancy that still clears everything", () => {
        const { p, partnerId } = marriedEarly();
        p.takeLoan(studentLoan(12, p.plan.primary.id));
        p.addPartnerJob(partnerId, plainJob);
        expect(() => p.updatePlan({ lifeExpectancy: 70 })).not.toThrow();
        expect(p.plan.primary.lifeExpectancy).toBe(70);
      });

      it("reviseTransaction: a lowered partner expectancy that still clears everything", () => {
        const { p, partnerId } = marriedEarly();
        p.takeLoan(studentLoan(24, partnerId));
        p.addPartnerJob(partnerId, plainJob);
        expect(() =>
          p.reviseTransaction(partnerId, { type: "marry", lifeExpectancy: 70 }),
        ).not.toThrow();
        expect(partnerEvent(p).person.lifeExpectancy).toBe(70);
      });
    });
  });

  // The other half of the same invariant. An edit is refused for what IT strands, which is only
  // meaningful if authoring could never have written something unreachable in the first place —
  // otherwise a household that booked a posthumous loan would be refused every later edit for
  // carrying it, and the guard would brick the plan instead of protecting it.
  describe("authoring cannot write a person-scoped event past its own owner's death", () => {
    it("refuses a loan dated after its owner dies", () => {
      const p = freshProjection();
      expect(() =>
        p.takeLoan({
          month: 900, // 2101, long past the primary's 2071
          ownerId: p.plan.primary.id as PersonId,
          kind: "studentLoan",
          openingBalanceCents: dollarsToCents(20000),
          apr: 5,
          termMonths: 120,
        }),
      ).toThrow(/would strand the 2101 loan.*live only to 2071/);
      expect(p.ledger.events).toEqual([]);
    });

    it("refuses a job that starts after its owner dies", () => {
      const p = freshProjection();
      expect(() =>
        p.addJob(p.plan.primary.id, { ...plainJob, startYear: 2080, endYear: 2085 }),
      ).toThrow(/would strand the 2080 job.*live only to 2071/);
      expect(p.plan.primary.jobs).toEqual([]);
    });

    // A job is the one person-scoped artifact that occupies a STRETCH of a life rather than an
    // instant, and containment is about the whole stretch: it starts inside the window and it
    // ends inside it. The primary here is born 1986 at expectancy 85, so the window closes with
    // 2071 — the last year they are alive to work.
    describe("a job is contained end to end, not just at its start", () => {
      const jobTo = (endYear: number) => ({ ...plainJob, startYear: 2030, endYear });

      it("accepts a job that ends BEFORE its owner's death", () => {
        const p = freshProjection();
        expect(() => p.addJob(p.plan.primary.id, jobTo(2060))).not.toThrow();
        expect(p.plan.primary.jobs).toHaveLength(1);
      });

      it("accepts a job that ends EXACTLY at its owner's death — the bound is exclusive", () => {
        // `endYear` is exclusive and so is the death month, so these are the same month: the last
        // month worked is the last month lived. Working to the end of your life is a plan a
        // person may write, and the boundary is where an off-by-one would make it unwritable.
        const p = freshProjection();
        expect(() => p.addJob(p.plan.primary.id, jobTo(2071))).not.toThrow();
        expect(p.plan.primary.jobs).toHaveLength(1);
      });

      it("refuses a job that ends AFTER its owner's death", () => {
        // Not clamped at authoring time, which is what this used to be: a plan whose numbers are
        // read one way by the form and another by the run is the thing the containment rule
        // exists to stop. `personActiveWindow` still clips such a job, for state this build did
        // not author — see the restored fixtures below.
        const p = freshProjection();
        expect(() => p.addJob(p.plan.primary.id, jobTo(2090))).toThrow(
          /would run the 2030 job on to 2090.*live only to 2071.*must end while its owner is alive/,
        );
        expect(p.plan.primary.jobs).toEqual([]);
      });

      it("refuses a job whose end does not come after its start", () => {
        // The other half of `startMonth < endMonthExclusive <= deathMonth`, and the half no
        // expectancy can fix: a span that runs backwards describes no employment at all.
        const p = freshProjection();
        expect(() => p.addJob(p.plan.primary.id, jobTo(2030))).toThrow(
          /the 2030 job would end in 2030, and a job must end after it starts/,
        );
        expect(p.plan.primary.jobs).toEqual([]);
      });

      it("refuses a partner's job that outlasts the PARTNER, on their own clock", () => {
        // Sam is born 1996 at expectancy 80, so they die in 2076 — before the primary's own
        // 2086 here. A job takes only its owner, so it is Sam's death that bounds Sam's job.
        const p = freshProjection();
        p.updatePlan({ lifeExpectancy: 100 });
        const samId = p.marry({ month: 12, name: "Sam", birthYear: 1996, lifeExpectancy: 80 });
        expect(() => p.addPartnerJob(samId, jobTo(2080))).toThrow(
          /would run the 2030 job on to 2080.*Sam is projected to live only to 2076/,
        );
        expect(partnerEvent(p).person.jobs).toEqual([]);
      });
    });

    // The other direction, for the end as much as for the start: a job legal when written is
    // stranded by an edit that moves the death back under it, and there is no second write to
    // that job to catch it.
    describe("an edit that would leave an existing job posthumous is refused", () => {
      it("updatePlan: refuses an expectancy lowered under a job's END", () => {
        const p = freshProjection();
        p.updatePlan({ lifeExpectancy: 100 }); // dies 2086
        p.addJob(p.plan.primary.id, { ...plainJob, startYear: 2030, endYear: 2085 });
        expect(() => p.updatePlan({ lifeExpectancy: 85 })).toThrow(
          /would run the 2030 job on to 2085.*live only to 2071.*must end while its owner is alive/,
        );
        expect(p.plan.primary.lifeExpectancy).toBe(100);
      });

      it("updatePlan: refuses a birth year moved under a job's end IN THE SAME EDIT as an expectancy", () => {
        // A birth year alone cannot do this any more — it carries the job with it, and the death
        // it is compared against moves by the same delta (see the rebasing block below). What
        // still can is moving the expectancy too: the job's end AGE is preserved at 99 and the
        // life it must fit inside is cut to 85.
        const p = freshProjection();
        p.updatePlan({ lifeExpectancy: 100 });
        p.addJob(p.plan.primary.id, { ...plainJob, startYear: 2030, endYear: 2085 });
        expect(() => p.updatePlan({ birthYear: 1970, lifeExpectancy: 85 })).toThrow(
          /would run the 2014 job on to 2069.*live only to 2055.*must end while its owner is alive/,
        );
        expect(p.plan.primary.birthYear).toBe(samplePlan.primary.birthYear);
        expect(p.plan.primary.lifeExpectancy).toBe(100);
      });

      it("reviseTransaction: refuses a partner expectancy lowered under THEIR job's end", () => {
        const p = freshProjection();
        p.updatePlan({ lifeExpectancy: 100 });
        const samId = p.marry({ month: 12, name: "Sam", birthYear: 1996, lifeExpectancy: 95 });
        p.addPartnerJob(samId, { ...plainJob, startYear: 2030, endYear: 2085 });
        expect(() => p.reviseTransaction(samId, { type: "marry", lifeExpectancy: 80 })).toThrow(
          /would run the 2030 job on to 2085.*Sam is projected to live only to 2076/,
        );
        expect(partnerEvent(p).person.lifeExpectancy).toBe(95);
      });

      it("still allows an edit that keeps the whole job inside the life", () => {
        // The guard is about containment, not about expectancies being immovable: an expectancy
        // of 99 still has the primary alive through the job's 2085 end, so the edit lands.
        const p = freshProjection();
        p.updatePlan({ lifeExpectancy: 100 });
        p.addJob(p.plan.primary.id, { ...plainJob, startYear: 2030, endYear: 2085 });
        expect(() => p.updatePlan({ lifeExpectancy: 99 })).not.toThrow();
        expect(p.plan.primary.lifeExpectancy).toBe(99);
      });
    });
  });

  it("refuses a separation naming nobody, rather than booking one against no partner", () => {
    const p = freshProjection();
    expect(() => p.separate({ month: 12, partnerPersonId: "person-nope" })).toThrow(
      /no partner "person-nope" in this timeline/,
    );
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

  it("accepts a buyHome whose tax makes it unaffordable, and blocks the projection on it", () => {
    // Under a capital-gains jurisdiction the funded gain grosses the draw up past the balance.
    // Affordability is no longer a refusal (§9, §13): the purchase is authored, and the block
    // surfaces when the draw runs under that same jurisdiction.
    const p = nestProjection(flatCapitalGains(0.5));
    expect(() => p.buyHome(buyFromNest)).not.toThrow();
    expect(p.ledger.events).toHaveLength(1);
    expect(p.run(flatCapitalGains(0.5)).series.status).toBe("blocked");
  });

  it("runs the same buyHome to the horizon under nullJurisdiction — no tax, so it clears", () => {
    // No tax, so the balance nets in full and the down payment clears rather than blocking.
    const p = nestProjection(nullJurisdiction);
    expect(() => p.buyHome(buyFromNest)).not.toThrow();
    // One event: the mortgage rides inside the purchase, minted as a dependent artifact.
    expect(p.ledger.events).toHaveLength(1);
    expect(p.run(nullJurisdiction).series.status).toBe("ran-to-horizon");
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
    // only see the outside of. Authored affordable, then stranded by lowering the opening balance —
    // a plan edit strands an accepted purchase, which is how a block arises now that affordability
    // is not refused up front.
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

/**
 * `setContinuationJob` as the npm API surface — the one write that names a PERSON rather than a
 * job, and therefore the one that has to settle a plane from a person id instead of taking the
 * caller's word for it.
 *
 * The state function underneath is covered in `authoring/jobs.test.ts`. What is asserted here is
 * the contract a package consumer actually holds: one method for both planes, reads that answer
 * with what was written, and refusals that leave the handle usable.
 */
