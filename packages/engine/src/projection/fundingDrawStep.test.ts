/**
 * The ordered funding-draw primitive, {@link resolveOrderedFundingDraw}, priced across a mixed
 * source list. An `account` source is sold and grossed up over the capital-gains tax the sale
 * induces; a `credit` source borrows against its remaining headroom (`creditLimit − balance`,
 * clamped at zero) with no sale, no basis and no tax. Both walk the SAME ordered list in one pass,
 * so a `[brokerage, visa]` list draws the brokerage first and then borrows — never reordered.
 *
 * A gain-taxing stub jurisdiction (flat 20% on realized capital gains) stands in for a rules
 * package the engine cannot import, so an appreciated account delivers strictly less than its
 * balance while credit stays tax-free.
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

function freshBase(): TaxableByOwner {
  return new Map();
}

describe("resolveOrderedFundingDraw — credit sources", () => {
  it("borrows against remaining headroom, tax-free, delivering the borrowed amount in full", () => {
    const result = resolveOrderedFundingDraw(
      5_000_00,
      [creditCard("visa", 2_000_00, 10_000_00)], // headroom 8_000_00
      gainTaxing,
      CTX,
      freshBase(),
    );

    expect(result.perSource).toHaveLength(1);
    const visa = result.perSource[0]!;
    expect(visa.kind).toBe("credit");
    expect(visa.grossCents).toBe(5_000_00);
    expect(visa.netDeliveredCents).toBe(5_000_00);
    expect(visa.gainCents).toBe(0);
    expect(visa.taxCents).toBe(0);
    expect(result.netDeliveredCents).toBe(5_000_00);
    expect(result.shortfallCents).toBe(0);
  });

  it("caps the borrow at headroom, leaving the remainder as a shortfall", () => {
    const result = resolveOrderedFundingDraw(
      12_000_00,
      [creditCard("visa", 2_000_00, 10_000_00)], // headroom 8_000_00
      gainTaxing,
      CTX,
      freshBase(),
    );

    expect(result.perSource[0]!.netDeliveredCents).toBe(8_000_00);
    expect(result.netDeliveredCents).toBe(8_000_00);
    expect(result.shortfallCents).toBe(4_000_00);
  });

  it("contributes nothing from a maxed-out card (balance ≥ limit) — headroom clamps at zero", () => {
    const result = resolveOrderedFundingDraw(
      5_000_00,
      [creditCard("visa", 10_000_00, 10_000_00)], // headroom 0
      gainTaxing,
      CTX,
      freshBase(),
    );

    expect(result.perSource).toHaveLength(0);
    expect(result.netDeliveredCents).toBe(0);
    expect(result.shortfallCents).toBe(5_000_00);
  });

  it("treats a null limit as unbounded, covering any remaining draw", () => {
    const result = resolveOrderedFundingDraw(
      5_000_00,
      [creditCard("visa", 0, null)],
      gainTaxing,
      CTX,
      freshBase(),
    );

    expect(result.perSource[0]!.netDeliveredCents).toBe(5_000_00);
    expect(result.shortfallCents).toBe(0);
  });

  it("walks account then credit in one authored-order pass, and credit stacks no gain onto the owner base", () => {
    const base = freshBase();
    const result = resolveOrderedFundingDraw(
      9_000_00,
      // Brokerage first (all gain, taxed), then borrow the remainder on the card.
      [appreciated("brokerage", 5_000_00), creditCard("visa", 0, 10_000_00)],
      gainTaxing,
      CTX,
      base,
    );

    expect(result.perSource.map((s) => s.id)).toEqual(["brokerage", "visa"]);
    // Brokerage fully liquidated: $50k gross, $50k gain, 20% ⇒ $10k tax, $40k net delivered.
    const brokerage = result.perSource[0]!;
    expect(brokerage.kind).toBe("account");
    expect(brokerage.taxCents).toBe(1_000_00);
    expect(brokerage.netDeliveredCents).toBe(4_000_00);
    // Visa covers the $50k that remains, tax-free.
    const visa = result.perSource[1]!;
    expect(visa.kind).toBe("credit");
    expect(visa.grossCents).toBe(5_000_00);
    expect(visa.taxCents).toBe(0);
    expect(result.shortfallCents).toBe(0);
    // Only the brokerage's gain was stacked onto the owner base; the borrow added nothing taxable.
    expect(base.get(OWNER)?.capitalGains).toBe(5_000_00);
  });
});
