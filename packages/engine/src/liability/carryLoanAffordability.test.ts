/**
 * `carryLoan` authors a holding at the now marker with no funding draw and no §4.5
 * affordability gate at AUTHORING time (see `preExisting.test.ts`) — its balance is accepted
 * as current fact, not reconstructed or vetted against history. But month 0 onward, the
 * carried loan's scheduled payment is an ordinary obligation like any other: nothing exempts
 * it from the household actually being able to fund it going forward.
 *
 * This pins the SIMULATION-time behavior once a household's real covering capacity (income,
 * savings, credit) can't fully fund every liability's scheduled payment. The payment always
 * enters the normal obligation waterfall, reported at its full authored amount — unrationed,
 * same as every other obligation. But what actually reduces a liability's BALANCE is tracked
 * PER LIABILITY, walking the same priority order obligations already report in (mandatory
 * debt funds before needs, needs before wants; ties break on stable id): a liability funded
 * ahead of a shortfall amortizes normally regardless of what else in the household went
 * unfunded that month, a liability behind one is starved by it, and a liability whose payment
 * straddles the funded/unfunded boundary amortizes down by exactly the PARTIAL amount that
 * reached it — never the full scheduled amount, and never zero, when the truth is in between.
 *
 * Deliberately NOT covered here (out of scope for `carryLoan`, which takes the balance as
 * given): whether the balance entered is realistic for the term/APR, or any default/
 * delinquency inference about the loan's PRE-now history. Only forward-looking affordability,
 * from month 0, is this engine's concern.
 */

import { describe, expect, it } from "vitest";
import { Projection } from "../index";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import { PRIMARY_PERSON_ID } from "../compile/projectionBase";
import { SYNTHETIC_CARD_CREDIT_LIMIT_CENTS, SYNTHETIC_CARD_ID } from "./liability";
import { obligationLiabilityId } from "../projection/financialObligation";
import type { PersonId } from "../job/job";

const base = {
  name: "Test",
  startYear: 2026,
  openingBalanceCents: 0,
  savingsReturnPct: 0,
  retirementReturnPct: 0,
  brokerageReturnPct: 0,
  sharedScheme: "proportional" as const,
  inflationPct: 0,
  birthYear: 2026 - 30,
  lifeExpectancy: 90,
  benefitClaimingAge: 67,
};

/** A single-month term makes the WHOLE balance one payoff-capped payment at month 0 — a
 *  convenient way to author "this much is due right now" without amortization math. */
function carryBalloonLoan(p: Projection, balanceCents: number): string {
  return p.carryLoan({
    ownerId: PRIMARY_PERSON_ID as PersonId,
    kind: "auto",
    balanceCents,
    apr: 0,
    remainingTermMonths: 1,
  });
}

describe("carryLoan — month-0 payment the household cannot fully fund", () => {
  it("enters the obligation waterfall, trips the standard infeasibility signal, and amortizes only the PARTIAL amount actual credit reached — not the full payment, not zero", () => {
    const p = Projection.init(base, nullJurisdiction);
    // $0 income, $0 savings: the ENTIRE $100,000 balloon payment is a pre-cascade shortfall.
    // The synthetic card's $50,000 limit covers exactly half of it.
    const loanId = carryBalloonLoan(p, 10_000_000);

    const result = p.run(nullJurisdiction);
    const month0 = result.series.months[0];
    if (!month0?.flows) throw new Error("expected month 0 to have flows");

    // The payment enters the ordinary obligation waterfall — reported at its full authored
    // amount, exactly like any other liability's scheduled payment, unrationed.
    const obligation = month0.flows.obligations.find((o) => o.id === obligationLiabilityId(loanId));
    expect(obligation).toMatchObject({
      sourceKind: "liability",
      treatment: "debt-payment",
      category: "debtService",
      editable: false,
      amountCents: 10_000_000,
    });

    // The household hits the engine's standard terminal-infeasibility signal — the same one
    // any other unfundable obligation trips, not a loan-specific outcome.
    expect(month0.isInsolvent).toBe(true);
    expect(result.firstInsolventMonth).toBe(0);
    // The full $50,000 synthetic-card limit was drawn trying to cover the deficit (the
    // card's own balance also compounds a month of interest on top, same as any liability).
    expect(month0.liabilityBalancesCents[SYNTHETIC_CARD_ID] ?? 0).toBeGreaterThanOrEqual(
      SYNTHETIC_CARD_CREDIT_LIMIT_CENTS,
    );

    // The balance amortizes down by exactly the $50,000 that credit actually funded — not
    // the full $100,000 (that would be crediting a payment that never happened) and not
    // left untouched at $100,000 either (that would ignore the $50,000 that genuinely did
    // get borrowed and applied).
    expect(month0.liabilityBalancesCents[loanId]).toBe(5_000_000);
  });

  it("a fully funded loan payment amortizes even though an unrelated household expense goes unfunded", () => {
    const p = Projection.init(base, nullJurisdiction);
    // Mandatory debt (priority below every expense tier) funds FIRST: a small $1,000 loan
    // payment easily fits, well before the $100,000/mo expense even gets a look at the
    // household's (nonexistent) income or the $50,000 card.
    const loanId = carryBalloonLoan(p, 100_000);
    p.addBudgetLine({
      label: "Rent",
      target: { kind: "expense" },
      amountSource: { kind: "literal", monthlyCents: 10_000_000 },
      category: "needs",
    });

    const result = p.run(nullJurisdiction);
    const month0 = result.series.months[0];
    if (!month0?.flows) throw new Error("expected month 0 to have flows");

    // The household is genuinely insolvent — the rent obligation, reported at its full
    // authored amount, has nowhere near enough left to draw on.
    expect(month0.isInsolvent).toBe(true);
    const rentObligation = month0.flows.obligations.find((o) => o.category === "needs");
    expect(rentObligation?.amountCents).toBe(10_000_000);

    // But the mandatory loan payment — funded ahead of the rent line in the waterfall's
    // priority order — amortizes exactly as scheduled, unaffected by the rent shortfall
    // that comes after it.
    expect(month0.liabilityBalancesCents[loanId]).toBe(0);
  });

  it("two liabilities sharing the mandatory tier: only the first (by authoring order) amortizes when funding runs out between them", () => {
    const p = Projection.init(base, nullJurisdiction);
    // $0 income; the synthetic card's $50,000 limit is the household's ONLY covering
    // capacity. loan-1's payment consumes it exactly, leaving nothing for loan-2 — ties
    // within the mandatory tier break on the stable, authoring-order id ("loan-1" < "loan-2").
    const firstLoanId = carryBalloonLoan(p, 5_000_000);
    const secondLoanId = carryBalloonLoan(p, 1_000_000);
    expect(firstLoanId < secondLoanId).toBe(true);

    const result = p.run(nullJurisdiction);
    const month0 = result.series.months[0];
    if (!month0) throw new Error("expected month 0");

    expect(month0.isInsolvent).toBe(true);
    // The first loan is paid off in full ($50,000 balance − its own $50,000 payment).
    expect(month0.liabilityBalancesCents[firstLoanId]).toBe(0);
    // The second gets NOTHING — the walk reached it with zero funding budget left, not a
    // household-wide "insolvent ⇒ nobody gets paid" rule.
    expect(month0.liabilityBalancesCents[secondLoanId]).toBe(1_000_000);
  });

  it("partial funding from income alone: a payment straddling the funded/unfunded boundary amortizes down by exactly the funded slice", () => {
    const p = Projection.init(base, nullJurisdiction);
    // A $0-limit credit-card holding suppresses the synthetic shortfall card entirely (the
    // engine only mints one when no user-authored card exists), isolating this case to
    // income alone — no credit muddies which slice of the payment was actually funded.
    p.carryLoan({
      ownerId: PRIMARY_PERSON_ID as PersonId,
      kind: "creditCard",
      balanceCents: 0,
      apr: 0,
      creditLimitCents: 0,
    });
    const loanId = carryBalloonLoan(p, 1_000_000);
    p.addJob(PRIMARY_PERSON_ID as PersonId, {
      name: "Job",
      startYear: base.startYear,
      endYear: 2090,
      salary: {
        startingSalaryCents: 3_600_000,
        // Starts at "now", so there is no history for the two anchors to disagree across.
        currentSalaryCents: 3_600_000,
        realGrowthPct: 0,
      },
    });

    const result = p.run(nullJurisdiction);
    const month0 = result.series.months[0];
    if (!month0) throw new Error("expected month 0");

    // $3,000/mo of income against a $10,000/mo payment, with no savings and no credit to
    // close the gap: genuinely insolvent, and only $3,000 of the payment is funded.
    expect(month0.isInsolvent).toBe(true);
    expect(month0.liabilityBalancesCents[loanId]).toBe(700_000);
  });
});
