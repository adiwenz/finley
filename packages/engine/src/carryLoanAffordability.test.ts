/**
 * `carryLoan` authors a holding at the now marker with no funding draw and no §4.5
 * affordability gate at AUTHORING time (see `preExisting.test.ts`) — its balance is accepted
 * as current fact, not reconstructed or vetted against history. But month 0 onward, the
 * carried loan's scheduled payment is an ordinary obligation like any other: nothing exempts
 * it from the household actually being able to fund it going forward.
 *
 * This pins the SIMULATION-time behavior once a carried loan's first payment can't be
 * funded: the payment still enters the normal obligation waterfall (reported at its full
 * authored amount, same as every other obligation), the household hits the engine's
 * standard terminal-infeasibility signal (`isInsolvent` / `firstInsolventMonth`) exactly as
 * it would for any other unfundable obligation, and — the part that is easy to get wrong —
 * the loan's balance does NOT quietly amortize down as though the unfunded payment actually
 * went through.
 *
 * Deliberately NOT covered here (out of scope for `carryLoan`, which takes the balance as
 * given): whether the balance entered is realistic for the term/APR, or any default/
 * delinquency inference about the loan's PRE-now history. Only forward-looking affordability,
 * from month 0, is this engine's concern.
 */

import { describe, expect, it } from "vitest";
import { Projection } from "./index";
import { nullJurisdiction } from "./jurisdiction";
import { PRIMARY_PERSON_ID } from "./projectionBase";
import { SYNTHETIC_CARD_CREDIT_LIMIT_CENTS, SYNTHETIC_CARD_ID } from "./liability";
import { obligationLiabilityId } from "./projection/financialObligation";
import type { PersonId } from "./job";

/** No income, no savings, no returns/inflation — the household has nothing to fund month 0
 *  with beyond the synthetic shortfall card's finite limit. */
const brokeHousehold = {
  name: "Test",
  startYear: 2026,
  openingBalanceCents: 0,
  savingsReturnPct: 0,
  retirementReturnPct: 0,
  brokerageReturnPct: 0,
  sharedScheme: "proportional" as const,
  inflationPct: 0,
  currentAge: 30,
  retirementAge: 65,
  lifeExpectancy: 90,
  benefitClaimingAge: 67,
};

describe("carryLoan — month-0 payment the household cannot fund", () => {
  it("enters the obligation waterfall, trips the standard infeasibility signal, and does not amortize the balance as though it were paid", () => {
    const p = Projection.init(brokeHousehold, nullJurisdiction);
    // A single-month term: the WHOLE $100,000 balance is due as one payoff-capped payment at
    // month 0 — comfortably past the synthetic card's $50,000 limit with $0 income and $0
    // savings, so month 0 is unambiguously unfundable.
    const loanId = p.carryLoan({
      ownerId: PRIMARY_PERSON_ID as PersonId,
      kind: "auto",
      balanceCents: 10_000_000,
      apr: 0,
      remainingTermMonths: 1,
    });

    const result = p.run(nullJurisdiction);
    const month0 = result.series.months[0];
    if (!month0?.flows) throw new Error("expected month 0 to have flows");

    // 1. The loan payment enters the ordinary obligation waterfall — reported at its full
    //    authored amount, exactly like any other liability's scheduled payment, unrationed.
    const obligation = month0.flows.obligations.find(
      (o) => o.id === obligationLiabilityId(loanId),
    );
    expect(obligation).toMatchObject({
      sourceKind: "liability",
      treatment: "debt-payment",
      category: "debtService",
      editable: false,
      amountCents: 10_000_000,
    });

    // 2. The household hits the engine's standard terminal-infeasibility signal — the same
    //    one any other unfundable obligation trips, not a loan-specific outcome.
    expect(month0.isInsolvent).toBe(true);
    expect(result.firstInsolventMonth).toBe(0);
    // The deficit outran every funding source AND the full synthetic-card limit.
    expect(month0.liabilityBalancesCents[SYNTHETIC_CARD_ID] ?? 0).toBeGreaterThanOrEqual(
      SYNTHETIC_CARD_CREDIT_LIMIT_CENTS,
    );

    // 3. The balance is NOT reduced as though the unfunded payment succeeded — it opened at
    //    $100,000 and, with 0% APR, stays exactly there rather than quietly dropping to $0.
    expect(month0.liabilityBalancesCents[loanId]).toBe(10_000_000);
  });
});
