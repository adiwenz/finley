/**
 * The ordered funding-draw primitive, {@link resolveOrderedFundingDraw}, priced across a mixed
 * source list. An `account` source sells EXACTLY the remainder requested, capped at its balance —
 * no gross-up, no tax charged at the draw; a `credit` source borrows against its remaining
 * headroom (`creditLimit − balance`, clamped at zero) with no sale, no basis and no tax. Both walk
 * the SAME ordered list in one pass, so a `[brokerage, visa]` list draws the brokerage first and
 * then borrows — never reordered.
 *
 * A gain-taxing stub jurisdiction (flat 20% on realized capital gains) stands in for a rules
 * package the engine cannot import — it proves the realized gain is still computed and stacked
 * onto the owner base even though nothing is withheld from the sale itself.
 */

import { describe, it, expect } from "vitest";
import {
  resolveOrderedFundingDraw,
  type FundingSourceState,
  type TaxableByOwner,
} from "./fundingDrawStep";
import { type Jurisdiction } from "../jurisdiction/jurisdiction";

const OWNER = "p1";
const CTX = { year: 2026 };

const gainTaxing: Jurisdiction = {
  id: "test-cg",
  computeTaxCents: (t) => Math.round(0.2 * (t.capitalGains ?? 0)),
  computeTaxByCategoryCents: (t) => ({ capitalGains: Math.round(0.2 * (t.capitalGains ?? 0)) }),
};

/** A liquid, fully-appreciated account (basis 0): every cent drawn is a taxable gain. */
function appreciated(id: string, balanceCents: number): FundingSourceState {
  return { kind: "account", id, ownerId: OWNER, category: "capitalGains", balanceCents, basisCents: 0, label: id };
}

/** A credit line: `balanceCents` is what is currently owed; headroom is `creditLimitCents − balance`. */
function creditCard(id: string, balanceCents: number, creditLimitCents: number | null): FundingSourceState {
  return { kind: "credit", id, ownerId: OWNER, balanceCents, creditLimitCents, label: id };
}

/** A pre-tax (basis-0, `ordinaryIncome`) account, optionally carrying its owner's age. */
function preTax(id: string, balanceCents: number, age?: number): FundingSourceState {
  return { kind: "account", id, ownerId: OWNER, category: "ordinaryIncome", balanceCents, basisCents: 0, label: id, age };
}

function freshBase(): TaxableByOwner {
  return new Map();
}

// Credit-only headroom behavior (borrow in full, cap at headroom, a maxed or limitless card
// contributing nothing) is exercised through the owning abstractions instead of here — the
// simulator (`simulate.creditFunding.test.ts`) for what actually gets applied, and the
// authoring gate (`fundingLookup.test.ts` — "fundingLookup — credit sources") for what a
// candidate is told before it runs. What stays here is the one thing neither of those seams can
// pin: the mixed-order gross-up math, which needs a real tax jurisdiction stub the simulator
// tests intentionally avoid (`nullJurisdiction`).
describe("resolveOrderedFundingDraw — credit sources", () => {
  it("walks account then credit in one authored-order pass, and credit stacks no gain onto the owner base", () => {
    const base = freshBase();
    const result = resolveOrderedFundingDraw(
      9_000_00,
      // Brokerage first (all gain, realized but untaxed here), then borrow the remainder on the card.
      [appreciated("brokerage", 5_000_00), creditCard("visa", 0, 10_000_00)],
      gainTaxing,
      CTX,
      base,
    );

    expect(result.perSource.map((s) => s.id)).toEqual(["brokerage", "visa"]);
    // Brokerage sells its whole $5k balance (the $9k request exceeds it) — no gross-up, so gross
    // equals the balance and nothing is withheld: $5k gain realized, $0 tax, $5k net delivered.
    const brokerage = result.perSource[0]!;
    expect(brokerage.kind).toBe("account");
    expect(brokerage.grossCents).toBe(5_000_00);
    expect(brokerage.taxCents).toBe(0);
    expect(brokerage.netDeliveredCents).toBe(5_000_00);
    // Visa covers the $4k that remains after the brokerage, tax-free.
    const visa = result.perSource[1]!;
    expect(visa.kind).toBe("credit");
    expect(visa.grossCents).toBe(4_000_00);
    expect(visa.taxCents).toBe(0);
    expect(result.shortfallCents).toBe(0);
    // The brokerage's realized gain still stacks onto the owner base even though it went untaxed
    // here — it feeds the annual settlement; the borrow added nothing taxable.
    expect(base.get(OWNER)?.capitalGains).toBe(5_000_00);
  });
});

/** Flat 10% on the taxable portion of an ordinary-income (pre-tax) draw before 59½. */
const penaltyJurisdiction: Jurisdiction = {
  id: "test-penalty",
  computeTaxCents: () => 0,
  computeTaxByCategoryCents: () => ({}),
  earlyWithdrawalPenaltyCents: (basis, wctx) =>
    basis.category === "ordinaryIncome" && wctx.age < 59.5 ? Math.round(basis.grossCents * 0.1) : 0,
};

describe("resolveOrderedFundingDraw — early-withdrawal penalty", () => {
  it("nets the penalty out of what a pre-tax source delivers, drawing more from the next source to make up the rest", () => {
    const base = freshBase();
    const result = resolveOrderedFundingDraw(
      1_000_00,
      [preTax("pretax", 10_000_00, 35), appreciated("brokerage", 10_000_00)],
      penaltyJurisdiction,
      CTX,
      base,
    );

    const pretax = result.perSource[0]!;
    expect(pretax.grossCents).toBe(1_000_00);
    expect(pretax.taxCents).toBe(100_00);
    expect(pretax.netDeliveredCents).toBe(900_00);

    const brokerage = result.perSource[1]!;
    expect(brokerage.grossCents).toBe(100_00);
    expect(brokerage.taxCents).toBe(0);

    expect(result.netDeliveredCents).toBe(1_000_00);
    expect(result.shortfallCents).toBe(0);
  });

  it("reports a real shortfall when the penalized source is the only one and can't make up its own leakage", () => {
    const base = freshBase();
    const result = resolveOrderedFundingDraw(
      1_000_00,
      [preTax("pretax", 1_000_00, 35)],
      penaltyJurisdiction,
      CTX,
      base,
    );
    expect(result.netDeliveredCents).toBe(900_00);
    expect(result.shortfallCents).toBe(100_00);
  });

  it("charges nothing when the source carries no age", () => {
    const base = freshBase();
    const result = resolveOrderedFundingDraw(
      1_000_00,
      [preTax("pretax", 10_000_00)],
      penaltyJurisdiction,
      CTX,
      base,
    );
    expect(result.perSource[0]!.taxCents).toBe(0);
  });
});
