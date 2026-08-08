/**
 * The engine-owned eligibility seam: which of a household's accounts may fund an obligation of a
 * given treatment. The UI never re-implements these rules — it asks here — so the picker and the
 * blocked-projection classifier can never disagree about what counts as a source.
 *
 * Only the rules that exist today are pinned: liquid asset accounts are eligible; retirement
 * (illiquid) accounts are not. Credit cards — eligible for an `expense`, never an
 * `asset-acquisition` — arrive in a later slice and are deliberately unrepresented here.
 */

import { describe, it, expect } from "vitest";
import { getEligibleFundingSources } from "./fundingEligibility";

const checking = { id: "checking", liquid: true } as const;
const brokerage = { id: "brokerage", liquid: true } as const;
const retirement = { id: "401k", liquid: false } as const;

describe("getEligibleFundingSources", () => {
  it("excludes retirement (illiquid) accounts for an asset-acquisition", () => {
    const eligible = getEligibleFundingSources("asset-acquisition", [checking, retirement, brokerage]);
    expect(eligible.map((a) => a.id)).toEqual(["checking", "brokerage"]);
  });

  it("admits only liquid accounts for an expense — credit cards are a later slice", () => {
    const eligible = getEligibleFundingSources("expense", [checking, retirement, brokerage]);
    expect(eligible.map((a) => a.id)).toEqual(["checking", "brokerage"]);
  });

  it("preserves input order and returns the candidates themselves", () => {
    const eligible = getEligibleFundingSources("asset-acquisition", [brokerage, checking]);
    expect(eligible).toEqual([brokerage, checking]);
  });
});
