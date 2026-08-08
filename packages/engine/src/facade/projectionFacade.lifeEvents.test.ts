/**
 * **What the `Projection` root REFUSES to author**, and why each refusal is the same rule.
 *
 * A person-scoped life event — a marriage, a separation, and everything hung off one — has to
 * fall inside a window both people are alive for. So authoring is refused in both directions: an
 * event written past its own owner's death, and an edit to a person that would strand an event
 * already written. Plus the seam either side of them: authoring validates against the jurisdiction
 * the projection was CONSTRUCTED with, not one handed in at run time.
 *
 * Running the plan is `projectionFacade.run.test.ts`; the retirement answer and the stop-working
 * preview are `projectionFacade.retirement.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { Projection } from "../index";
import { samplePlan, stateOf } from "../testing/samplePlan";
import { mockJurisdiction } from "../testing/mockJurisdiction";
import { nullJurisdiction, type Jurisdiction } from "../jurisdiction/jurisdiction";
import { dollarsToCents } from "../money/cashFlowSeries";
import { goalFundAccountId } from "../compile/projectionBase";
import { type PersonId } from "../job/job";
import { P1, freshProjection, plainJob, partnerEvent } from "../testing/projectionFacadeFixtures";

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
    // One event: the mortgage rides inside the purchase, minted as a dependent artifact.
    expect(p.ledger.events).toHaveLength(1);
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
