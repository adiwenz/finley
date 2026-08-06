/**
 * The `Projection` root's ledger transactions: the remaining transaction writes, removing,
 * revising, or swapping one wholesale, the guard that a revision cannot replace an identity, and
 * the `assessHomePurchase` guideline read.
 */
import { describe, it, expect } from "vitest";
import { Projection } from "../index";
import { samplePlan, salariedJob, stateOf } from "../testing/samplePlan";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import { dollarsToCents } from "../money/cashFlowSeries";
import { P1, freshProjection, plainJob, partnerEvent } from "../testing/projectionFacadeFixtures";

describe("Projection root — the remaining ledger transactions", () => {
  it("haveChild() records a child, using one id for the event and the child", () => {
    const p = freshProjection();
    const childId = p.haveChild({ month: 12, name: "Robin", annualCostCents: dollarsToCents(12000) });
    expect(childId).toBe("child-1");
    expect(p.ledger.events[0]).toMatchObject({
      id: childId,
      type: "ChildEvent",
      childId,
      childName: "Robin",
      // Recorded as it happens: birthMonth defaults to the event's month.
      birthMonth: 12,
      annualCostCents: dollarsToCents(12000),
    });
  });

  it("haveChild() takes a birthMonth of its own for a child entered after the fact", () => {
    const p = freshProjection();
    p.haveChild({ month: 0, name: "Sam", annualCostCents: 0, birthMonth: -60 });
    expect(p.ledger.events[0]).toMatchObject({ month: 0, birthMonth: -60 });
  });

  it("separate() ends a partnership authored by marry()", () => {
    const p = freshProjection();
    const partnerId = p.marry({ month: 24, name: "Partner", birthYear: 1988 });
    const separationId = p.separate({
      month: 60,
      partnerPersonId: partnerId,
      alimonyMonthlyCents: dollarsToCents(1000),
      alimonyDurationMonths: 36,
    });

    expect(separationId).toBe("separation-2");
    expect(p.ledger.events[1]).toMatchObject({
      id: separationId,
      type: "SeparationEvent",
      partnerPersonId: partnerId,
      alimonyMonthlyCents: dollarsToCents(1000),
      alimonyDurationMonths: 36,
      // The no-support default, stated rather than omitted.
      childSupportMonthlyCents: 0,
    });
  });

  it("separate() is refused before the partnering it would end", () => {
    const p = freshProjection();
    const partnerId = p.marry({ month: 24, name: "Partner", birthYear: 1988 });
    const before = p.state;
    expect(() => p.separate({ month: 12, partnerPersonId: partnerId })).toThrow(
      /cannot apply transaction — .*before partnering at month 24/,
    );
    expect(p.state).toBe(before);
  });

  it("payOffDebt() pays a liability down from a named account", () => {
    const p = freshProjection();
    const loanId = p.takeLoan({
      month: 6,
      ownerId: P1,
      kind: "studentLoan",
      openingBalanceCents: dollarsToCents(20000),
      apr: 5,
      termMonths: 60,
    });
    const payoffId = p.payOffDebt({
      month: 12,
      liabilityId: loanId,
      accountId: "savings",
      amountCents: dollarsToCents(5000),
    });

    expect(payoffId).toBe("payoff-2");
    expect(p.ledger.events[1]).toMatchObject({
      id: payoffId,
      type: "DebtPayoffEvent",
      liabilityId: loanId,
      accountId: "savings",
      amountCents: dollarsToCents(5000),
    });
  });

  it("payOffDebt() is refused against a liability that does not exist", () => {
    const p = freshProjection();
    const before = p.state;
    expect(() =>
      p.payOffDebt({ month: 12, liabilityId: "no-such-loan", accountId: "savings", amountCents: 100 }),
    ).toThrow(/cannot apply transaction — .*liability "no-such-loan" not found/);
    expect(p.state).toBe(before);
  });
});

describe("Projection root — a transaction can be removed, revised, or swapped wholesale", () => {
  function marriedProjection(): { p: Projection; partnerId: string } {
    const p = freshProjection();
    return { p, partnerId: p.marry({ month: 24, name: "Partner", birthYear: 1988 }) };
  }

  it("removes a transaction by id, not by position", () => {
    const p = freshProjection();
    const first = p.takeLoan({ month: 3, ownerId: P1, kind: "studentLoan", openingBalanceCents: dollarsToCents(10000), apr: 4, termMonths: 48 });
    const second = p.takeLoan({ month: 6, ownerId: P1, kind: "studentLoan", openingBalanceCents: dollarsToCents(5000), apr: 4, termMonths: 24 });

    p.removeTransaction(first);
    expect(p.ledger.events.map((e) => e.id)).toEqual([second]);
  });

  it("refuses a removal that would strand a later transaction, naming it", () => {
    const { p, partnerId } = marriedProjection();
    const separationId = p.separate({ month: 60, partnerPersonId: partnerId });
    const before = p.state;

    expect(() => p.removeTransaction(partnerId)).toThrow(
      new RegExp(`cannot remove transaction — .*causes event "${separationId}" \\(SeparationEvent\\) to fail`),
    );
    // Refused means untouched, not partially applied.
    expect(p.state).toBe(before);
    expect(p.ledger.events).toHaveLength(2);

    // Removing the dependent first unblocks it.
    p.removeTransaction(separationId);
    p.removeTransaction(partnerId);
    expect(p.ledger.events).toHaveLength(0);
  });

  it("refuses to remove an id that is not in the ledger", () => {
    const p = freshProjection();
    expect(() => p.removeTransaction("no-such-event")).toThrow(
      /No event with id "no-such-event" to remove/,
    );
  });

  it("revises a transaction's data in place, keeping its id and its place in the log", () => {
    const { p, partnerId } = marriedProjection();
    const [before] = p.ledger.events;

    p.reviseTransaction(partnerId, { type: "marry", month: 36, name: "Partner (renamed)" });

    const [after] = p.ledger.events;
    expect(after).toMatchObject({ id: partnerId, month: 36 });
    expect(after?.type === "RelationshipEvent" && after.person.name).toBe("Partner (renamed)");
    expect(after?.sequenceNumber).toBe(before?.sequenceNumber);
    expect(p.ledger.events).toHaveLength(1);
  });

  it("refuses a revision that would strand a later transaction", () => {
    const { p, partnerId } = marriedProjection();
    p.separate({ month: 36, partnerPersonId: partnerId });
    const before = p.state;

    // Moving the marriage past the separation leaves the separation with nothing to end.
    expect(() => p.reviseTransaction(partnerId, { type: "marry", month: 48 })).toThrow(
      /cannot revise transaction — /,
    );
    expect(p.state).toBe(before);
  });

  it("refuses a revision naming the wrong verb for the event", () => {
    const { p, partnerId } = marriedProjection();
    expect(() => p.reviseTransaction(partnerId, { type: "takeLoan", apr: 9 })).toThrow(
      /is a RelationshipEvent, which a "takeLoan" revision does not address/,
    );
  });

  it("refuses a revision for an id the ledger does not hold", () => {
    const p = freshProjection();
    expect(() => p.reviseTransaction("no-such-event", { type: "marry", month: 1 })).toThrow(
      /no transaction "no-such-event"/,
    );
  });

  it("refuses the companion field belonging to the other loan arm", () => {
    const p = freshProjection();
    const loanId = p.takeLoan({
      month: 3, ownerId: P1, kind: "studentLoan",
      openingBalanceCents: dollarsToCents(10_000), apr: 4, termMonths: 48,
    });
    // `kind` is fixed by the event, so a term loan has no credit limit to revise.
    expect(() => p.reviseTransaction(loanId, { type: "takeLoan", creditLimitCents: 1 })).toThrow(
      /takes termMonths, not the other/,
    );
  });
});

/**
 * A revision changes DATA. It cannot re-point identity, because it never carries any: the
 * event is rebuilt from what is already in the log, so the event id and every durable id
 * hanging off it survive by construction rather than by the caller being careful.
 */
describe("Projection root — a revision cannot replace an identity", () => {
  const marriedProjection = (): { p: Projection; partnerId: string } => {
    const p = freshProjection();
    return { p, partnerId: p.marry({ month: 24, name: "Partner", birthYear: 1988 }) };
  };

  it("keeps the event id, the person id and every nested job id across a marry revision", () => {
    const p = freshProjection();
    const partnerId = p.marry({ month: 24, name: "Partner", birthYear: 1988 });
    const jobId = p.addPartnerJob(partnerId, plainJob);
    const before = partnerEvent(p);

    p.reviseTransaction(partnerId, {
      type: "marry",
      month: 30,
      name: "Renamed",
      birthYear: 1990,
      benefitClaimingAge: 70,
    });

    const after = partnerEvent(p);
    // The data moved…
    expect(after.month).toBe(30);
    expect(after.person.name).toBe("Renamed");
    expect(after.person.birthYear).toBe(1990);
    expect(after.person.benefitClaimingAge).toBe(70);
    // …and every identity stayed, including the job list a revision never mentions.
    expect(after.id).toBe(before.id);
    expect(after.person.id).toBe(partnerId);
    expect(after.person.jobs.map((j) => j.id)).toEqual([jobId]);
    expect(after.person.jobs).toEqual(before.person.jobs);
  });

  it("keeps the child id across a haveChild revision", () => {
    const p = freshProjection();
    const childId = p.haveChild({ month: 12, name: "Robin", annualCostCents: dollarsToCents(12_000) });

    p.reviseTransaction(childId, { type: "haveChild", name: "Robin (renamed)", annualCostCents: 1 });

    const event = p.ledger.events.find((e) => e.id === childId);
    expect(event?.type === "ChildEvent" && event.childName).toBe("Robin (renamed)");
    // `childId` is the same id as the event's own — a revision re-points neither.
    expect(event?.type === "ChildEvent" && event.childId).toBe(childId);
  });

  it("keeps the liability and owner ids across a takeLoan revision", () => {
    const p = freshProjection();
    const loanId = p.takeLoan({
      month: 3, ownerId: P1, kind: "studentLoan",
      openingBalanceCents: dollarsToCents(10_000), apr: 4, termMonths: 48,
    });

    p.reviseTransaction(loanId, { type: "takeLoan", apr: 9, openingBalanceCents: 1, termMonths: 12 });

    const event = p.ledger.events.find((e) => e.id === loanId);
    expect(event?.type === "LoanEvent" && event.apr).toBe(9);
    expect(event?.type === "LoanEvent" && event.liabilityId).toBe(loanId);
    expect(event?.type === "LoanEvent" && event.ownerId).toBe(P1);
    // `kind` is identity-adjacent: a card and a term loan are different instruments.
    expect(event?.type === "LoanEvent" && event.kind).toBe("studentLoan");
  });

  it("keeps the property and its securing-mortgage link across a buyHome revision", () => {
    const p = Projection.fromState(stateOf({ ...samplePlan, goals: [] }), nullJurisdiction);
    const homeId = p.buyHome({
      month: 12, ownerId: P1,
      purchasePriceCents: dollarsToCents(200_000),
      downPaymentCents: dollarsToCents(40_000),
      downPaymentSourceIds: ["savings"],
      mortgageApr: 6, mortgageTermMonths: 360,
    });
    const before = p.ledger.events.find((e) => e.id === homeId);
    const mortgageId = before?.type === "HomePurchaseEvent" ? before.securedByLiabilityId : "";
    expect(mortgageId).toBe(`${homeId}-mortgage`);

    // The property's own fields revise through `buyHome`; the mortgage is a separate `LoanEvent`,
    // revised through `takeLoan` on the derived id. Neither re-mints the other's identity.
    p.reviseTransaction(homeId, { type: "buyHome", downPaymentCents: dollarsToCents(50_000) });
    p.reviseTransaction(`${homeId}-mortgage`, { type: "takeLoan", apr: 5, termMonths: 240 });

    const after = p.ledger.events.find((e) => e.id === homeId);
    expect(after?.type === "HomePurchaseEvent" && after.downPaymentCents).toBe(dollarsToCents(50_000));
    expect(after?.type === "HomePurchaseEvent" && after.propertyId).toBe(homeId);
    expect(after?.type === "HomePurchaseEvent" && after.securedByLiabilityId).toBe(mortgageId);

    const mortgage = p.ledger.events.find((e) => e.id === `${homeId}-mortgage`);
    expect(mortgage?.type === "LoanEvent" && mortgage.apr).toBe(5);
    expect(mortgage?.type === "LoanEvent" && mortgage.kind === "mortgage" && mortgage.termMonths).toBe(240);
  });

  it("offers no way to name an identity, at the type level", () => {
    const { p, partnerId } = marriedProjection();

    // Each of these is the shape the old `NewLifeEvent` parameter accepted. If a revision
    // variant ever grows an identity field again, the `@ts-expect-error` goes unused and the
    // build fails — which is the point.
    // @ts-expect-error — a revision cannot name the event id
    p.reviseTransaction(partnerId, { type: "marry", id: "stolen" });
    // @ts-expect-error — a revision cannot replace the person
    p.reviseTransaction(partnerId, { type: "marry", person: { id: "stolen" } });
    // @ts-expect-error — a revision cannot replace the nested job list
    p.reviseTransaction(partnerId, { type: "marry", jobs: [] });

    // Untouched by any of the refused shapes above.
    expect(partnerEvent(p).person.id).toBe(partnerId);
  });
});

/**
 * Adopting a ledger that already holds ids is RESTORATION, and `fromState` is the only door
 * for it — `resetLedger` (which swapped a caller's ledger straight in) is gone. These pin that
 * the counters still clear whatever the adopted timeline occupies.
 */
describe("ProjectionResult.assessHomePurchase — the guideline read", () => {
  const purchase = {
    month: 0,
    purchasePriceCents: dollarsToCents(300000),
    downPaymentCents: dollarsToCents(60000),
    apr: 0.065,
    termMonths: 360,
  };

  const ranWith = (monthlyIncomeCents: number) =>
    Projection.fromState(
      stateOf({
        ...samplePlan,
        primary: { ...samplePlan.primary, jobs: [salariedJob(monthlyIncomeCents)] },
      }),
      nullJurisdiction,
    ).run(nullJurisdiction);

  it("flags a purchase that pushes housing past the front-end guideline", () => {
    // ~$1,517/mo of mortgage against $5,000/mo gross is over 28%.
    const dti = ranWith(dollarsToCents(5000)).assessHomePurchase(purchase);
    expect(dti.monthlyGrossCents).toBe(dollarsToCents(5000));
    expect(dti.assessment.frontEndExceeded).toBe(true);
    expect(dti.exceeded).toBe(true);
  });

  it("stays quiet when the same mortgage is small against the income", () => {
    const dti = ranWith(dollarsToCents(20000)).assessHomePurchase(purchase);
    expect(dti.assessment.frontEndExceeded).toBe(false);
    expect(dti.assessment.backEndExceeded).toBe(false);
    expect(dti.exceeded).toBe(false);
  });

  it("quotes the mortgage the purchase would add, financed on the balance after the deposit", () => {
    const dti = ranWith(dollarsToCents(5000)).assessHomePurchase(purchase);
    // $240,000 at 6.5% over 30 years — around $1,500/mo.
    expect(dti.monthlyMortgageCents).toBeGreaterThan(dollarsToCents(1400));
    expect(dti.monthlyMortgageCents).toBeLessThan(dollarsToCents(1600));
  });

  it("flags nothing at zero gross income rather than dividing by it", () => {
    const dti = Projection.fromState(
      stateOf({ ...samplePlan, primary: { ...samplePlan.primary, jobs: [] } }),
      nullJurisdiction,
    )
      .run(nullJurisdiction)
      .assessHomePurchase(purchase);
    expect(dti.monthlyGrossCents).toBe(0);
    expect(dti.assessment.frontEndRatio).toBe(0);
    expect(dti.exceeded).toBe(false);
  });

  it("counts debt already being serviced toward the back-end ratio", () => {
    const p = Projection.fromState(
      stateOf({
        ...samplePlan,
        primary: { ...samplePlan.primary, jobs: [salariedJob(dollarsToCents(12000))] },
      }),
      nullJurisdiction,
    );
    // Read a year in, where the loan taken at month 0 is being serviced.
    const later = { ...purchase, month: 12 };
    const clean = p.run(nullJurisdiction).assessHomePurchase(later);
    p.takeLoan({
      month: 0,
      ownerId: P1,
      kind: "studentLoan",
      openingBalanceCents: dollarsToCents(60000),
      apr: 6,
      termMonths: 60,
    });
    const withLoan = p.run(nullJurisdiction).assessHomePurchase(later);
    // Housing is unchanged — the loan is not a mortgage — but total debt is not.
    expect(withLoan.assessment.frontEndRatio).toBeCloseTo(clean.assessment.frontEndRatio, 5);
    expect(withLoan.assessment.backEndRatio).toBeGreaterThan(clean.assessment.backEndRatio);
  });
});

