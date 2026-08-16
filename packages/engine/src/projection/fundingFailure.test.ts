/**
 * Classifying a blocked funding draw: does the money exist elsewhere among the household's
 * eligible accounts (a funding-configuration mistake), or does nothing eligible suffice? The
 * classifier reports; it never reassigns, reorders, or substitutes the selected sources — the
 * actual draw already ran in its named order and fell short. Alternatives are advice only.
 *
 * Availability is priced through the same {@link resolveOrderedFundingDraw} the simulator uses:
 * no gross-up and no tax charged at the draw, so an appreciated source's available capacity is
 * its full balance (or headroom, for a card) — never netted down for the gain it would realize. A
 * gain-taxing stub jurisdiction stands in for a real rules package (the engine cannot import one),
 * taxing capital gains at a flat 20%, to prove that tax genuinely goes unused here.
 */

import { describe, it, expect } from "vitest";
import { classifyFundingFailure, type EligibleAccountState } from "./fundingFailure";
import { nullJurisdiction, type Jurisdiction } from "../jurisdiction/jurisdiction";
import type { TaxableByOwner } from "./fundingDrawStep";

const OWNER = "p1";
const CTX = { year: 2026 };
const NO_BASE: TaxableByOwner = new Map();

/** Flat 20% on realized capital gains — proves it goes unused since draws are never taxed here. */
const gainTaxing: Jurisdiction = {
  id: "test-cg",
  computeTaxCents: (t) => Math.round(0.2 * (t.capitalGains ?? 0)),
  computeTaxByCategoryCents: (t) => ({ capitalGains: Math.round(0.2 * (t.capitalGains ?? 0)) }),
};

/** A liquid account; `basisCents === balanceCents` ⇒ a cash source that books no gain and no tax. */
function cash(id: string, balanceCents: number): EligibleAccountState {
  return { id, ownerId: OWNER, category: "capitalGains", balanceCents, basisCents: balanceCents, liquid: true, label: id };
}

/** A liquid, fully-appreciated brokerage account (basis 0): every cent drawn is a taxable gain. */
function appreciated(id: string, balanceCents: number): EligibleAccountState {
  return { id, ownerId: OWNER, category: "capitalGains", balanceCents, basisCents: 0, liquid: true, label: id };
}

/** An illiquid retirement account — never eligible for an asset acquisition. */
function retirement(id: string, balanceCents: number): EligibleAccountState {
  return { id, ownerId: OWNER, category: "ordinaryIncome", balanceCents, basisCents: 0, liquid: false, label: id };
}

/** A credit card: `balanceOwedCents` is the debt, headroom is `creditLimitCents − balance`. */
function card(id: string, balanceOwedCents: number, creditLimitCents: number): EligibleAccountState {
  return { kind: "credit", id, ownerId: OWNER, balanceCents: balanceOwedCents, creditLimitCents, liquid: false, credit: true, label: id };
}

describe("classifyFundingFailure — funding-configuration", () => {
  it("names an eligible account elsewhere that could cover the obligation", () => {
    const failure = classifyFundingFailure({
      treatment: "asset-acquisition",
      requiredCents: 8_000_000,
      selectedSourceIds: ["houseFund"],
      selectedSourcesAvailableCents: 5_000_000,
      selectedSourcesTaxCents: 0,
      selectedSources: [{ accountId: "houseFund", label: "houseFund", kind: "account", availableCents: 5_000_000 }],
      accounts: [cash("houseFund", 5_000_000), cash("brokerage", 10_000_000)],
      jurisdiction: nullJurisdiction,
      ctx: CTX,
      taxableByOwner: NO_BASE,
    });

    expect(failure.kind).toBe("funding-configuration");
    if (failure.kind !== "funding-configuration") return;
    expect(failure.requiredCents).toBe(8_000_000);
    expect(failure.selectedSourcesAvailableCents).toBe(5_000_000);
    expect(failure.selectedSourcesTaxCents).toBe(0);
    expect(failure.shortfallCents).toBe(3_000_000);
    // The selected house fund is not "elsewhere"; only the brokerage is offered, at its full balance.
    expect(failure.alternativeSources).toEqual([{ accountId: "brokerage", availableCents: 10_000_000 }]);
  });

  it("offers an unselected credit card as an expense alternative, at its headroom and tax-free", () => {
    const failure = classifyFundingFailure({
      treatment: "expense",
      requiredCents: 8_000_00,
      selectedSourceIds: ["cash"],
      selectedSourcesAvailableCents: 3_000_00,
      selectedSourcesTaxCents: 0,
      selectedSources: [{ accountId: "cash", label: "cash", kind: "account", availableCents: 3_000_00 }],
      // Cash covers $3k; the card's $9k headroom ($10k limit − $1k owed) covers the rest.
      accounts: [cash("cash", 3_000_00), card("visa", 1_000_00, 10_000_00)],
      jurisdiction: gainTaxing,
      ctx: CTX,
      taxableByOwner: NO_BASE,
    });

    expect(failure.kind).toBe("funding-configuration");
    if (failure.kind !== "funding-configuration") return;
    expect(failure.shortfallCents).toBe(5_000_00);
    // Headroom, not the $1k owed balance, and never taxed.
    expect(failure.alternativeSources).toEqual([{ accountId: "visa", availableCents: 9_000_00 }]);
  });

  it("reports an appreciated alternative's available at its full balance — gain untaxed here", () => {
    const failure = classifyFundingFailure({
      treatment: "asset-acquisition",
      requiredCents: 8_000_000,
      selectedSourceIds: ["cash"],
      selectedSourcesAvailableCents: 5_000_000,
      selectedSourcesTaxCents: 0,
      selectedSources: [{ accountId: "cash", label: "cash", kind: "account", availableCents: 5_000_000 }],
      accounts: [cash("cash", 5_000_000), appreciated("brokerage", 10_000_000)],
      jurisdiction: gainTaxing,
      ctx: CTX,
      taxableByOwner: NO_BASE,
    });

    expect(failure.kind).toBe("funding-configuration");
    if (failure.kind !== "funding-configuration") return;
    // $100k brokerage, all gain — even under a jurisdiction taxing gains at 20%, nothing is
    // withheld at the draw, so the full balance is reported available.
    expect(failure.alternativeSources).toEqual([{ accountId: "brokerage", availableCents: 10_000_000 }]);
  });
});

describe("classifyFundingFailure — no-eligible-source-suffices", () => {
  it("returns no-eligible when retirement wealth cannot be reached by an asset acquisition", () => {
    const failure = classifyFundingFailure({
      treatment: "asset-acquisition",
      requiredCents: 8_000_000,
      selectedSourceIds: ["houseFund"],
      selectedSourcesAvailableCents: 5_000_000,
      selectedSourcesTaxCents: 0,
      selectedSources: [{ accountId: "houseFund", label: "houseFund", kind: "account", availableCents: 5_000_000 }],
      // $50k liquid, $2M retirement: obviously wealthy, yet nothing eligible suffices.
      accounts: [cash("houseFund", 5_000_000), retirement("401k", 200_000_000)],
      jurisdiction: nullJurisdiction,
      ctx: CTX,
      taxableByOwner: NO_BASE,
    });

    expect(failure.kind).toBe("no-eligible-source-suffices");
    if (failure.kind !== "no-eligible-source-suffices") return;
    expect(failure.requiredCents).toBe(8_000_000);
    expect(failure.eligibleAvailableCents).toBe(5_000_000);
    expect(failure.eligibleTaxCents).toBe(0);
    expect(failure.shortfallCents).toBe(3_000_000);
  });

  it("never offers a credit card for an asset-acquisition — a card's headroom is not eligible", () => {
    const failure = classifyFundingFailure({
      treatment: "asset-acquisition",
      requiredCents: 8_000_00,
      selectedSourceIds: ["cash"],
      selectedSourcesAvailableCents: 3_000_00,
      selectedSourcesTaxCents: 0,
      selectedSources: [{ accountId: "cash", label: "cash", kind: "account", availableCents: 3_000_00 }],
      // With the card admitted this would be funding-configuration; a down payment excludes it,
      // so only the $3k cash is eligible and nothing eligible suffices.
      accounts: [cash("cash", 3_000_00), card("visa", 0, 10_000_00)],
      jurisdiction: nullJurisdiction,
      ctx: CTX,
      taxableByOwner: NO_BASE,
    });

    expect(failure.kind).toBe("no-eligible-source-suffices");
    if (failure.kind !== "no-eligible-source-suffices") return;
    expect(failure.eligibleAvailableCents).toBe(3_000_00);
    expect(failure.shortfallCents).toBe(5_000_00);
  });

  it("prices the eligible pool at full balance — an appreciated source's gain goes untaxed here", () => {
    const failure = classifyFundingFailure({
      treatment: "asset-acquisition",
      requiredCents: 8_000_000,
      selectedSourceIds: ["brokerage"],
      selectedSourcesAvailableCents: 5_000_000,
      selectedSourcesTaxCents: 0,
      selectedSources: [{ accountId: "brokerage", label: "brokerage", kind: "account", availableCents: 5_000_000 }],
      accounts: [appreciated("brokerage", 5_000_000)],
      jurisdiction: gainTaxing,
      ctx: CTX,
      taxableByOwner: NO_BASE,
    });

    expect(failure.kind).toBe("no-eligible-source-suffices");
    if (failure.kind !== "no-eligible-source-suffices") return;
    // $50k all-gain brokerage, fully liquidated: no tax withheld ⇒ $50k available, $30k short of $80k.
    expect(failure.eligibleAvailableCents).toBe(5_000_000);
    expect(failure.eligibleTaxCents).toBe(0);
    expect(failure.shortfallCents).toBe(3_000_000);
  });
});

describe("classifyFundingFailure — selectedSources", () => {
  it("preserves the selected sources, in configured order, with what each held", () => {
    const failure = classifyFundingFailure({
      treatment: "expense",
      requiredCents: 8_000_00,
      selectedSourceIds: ["visa", "cash"],
      selectedSourcesAvailableCents: 3_000_00,
      selectedSourcesTaxCents: 0,
      // Deliberately reversed from the accounts pool's own order, to prove the classifier forwards
      // exactly what the caller passed rather than re-deriving it from `accounts`.
      selectedSources: [
        { accountId: "visa", label: "Visa", kind: "credit", availableCents: 9_000_00 },
        { accountId: "cash", label: "Checking", kind: "account", availableCents: 3_000_00 },
      ],
      accounts: [cash("cash", 3_000_00), card("visa", 1_000_00, 10_000_00)],
      jurisdiction: gainTaxing,
      ctx: CTX,
      taxableByOwner: NO_BASE,
    });

    expect(failure.selectedSources).toEqual([
      { accountId: "visa", label: "Visa", kind: "credit", availableCents: 9_000_00 },
      { accountId: "cash", label: "Checking", kind: "account", availableCents: 3_000_00 },
    ]);
  });
});
