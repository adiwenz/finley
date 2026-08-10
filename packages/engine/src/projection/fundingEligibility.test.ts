/**
 * The engine-owned eligibility seam: which of a household's accounts may fund an obligation of a
 * given treatment. The UI never re-implements these rules — it asks here — so the picker and the
 * blocked-projection classifier can never disagree about what counts as a source.
 *
 * The rules pinned here: liquid asset accounts are eligible for both treatments; retirement
 * (illiquid) accounts for neither; credit cards for an `expense` only, never an
 * `asset-acquisition` (no bank funds a down payment on a card).
 */

import { describe, it, expect } from "vitest";
import { getEligibleFundingSources } from "./fundingEligibility";

const checking = { id: "checking", liquid: true } as const;
const brokerage = { id: "brokerage", liquid: true } as const;
const retirement = { id: "401k", liquid: false } as const;
const visa = { id: "visa", liquid: false, credit: true } as const;

describe("getEligibleFundingSources", () => {
  it("excludes retirement (illiquid) accounts for an asset-acquisition", () => {
    const eligible = getEligibleFundingSources("asset-acquisition", [checking, retirement, brokerage]);
    expect(eligible.map((a) => a.id)).toEqual(["checking", "brokerage"]);
  });

  it("admits credit cards alongside liquid accounts for an expense", () => {
    const eligible = getEligibleFundingSources("expense", [checking, retirement, visa, brokerage]);
    expect(eligible.map((a) => a.id)).toEqual(["checking", "visa", "brokerage"]);
  });

  it("excludes credit cards for an asset-acquisition — no card funds a down payment", () => {
    const eligible = getEligibleFundingSources("asset-acquisition", [checking, visa, brokerage]);
    expect(eligible.map((a) => a.id)).toEqual(["checking", "brokerage"]);
  });

  it("preserves input order and returns the candidates themselves", () => {
    const eligible = getEligibleFundingSources("asset-acquisition", [brokerage, checking]);
    expect(eligible).toEqual([brokerage, checking]);
  });
});
