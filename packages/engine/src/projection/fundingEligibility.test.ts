/**
 * The engine-owned eligibility seam: which of a household's accounts may fund an obligation of a
 * given treatment. The UI never re-implements these rules — it asks here — so the picker and the
 * blocked-projection classifier can never disagree about what counts as a source.
 *
 * The rules pinned here: every account holding the household's own money is eligible for both
 * treatments, brokerage and retirement included; a credit card is eligible for an `expense` only,
 * never an `asset-acquisition` (no bank funds a down payment on a card). Credit is the only axis
 * the two treatments differ on.
 */

import { describe, it, expect } from "vitest";
import { getEligibleFundingSources } from "./fundingEligibility";

// No `liquid` field: eligibility does not read one. That flag names what may RECEIVE the
// waterfall's surplus, not what can be converted to cash, and a fixture that conflated the two
// (brokerage as `liquid: true`, which the engine never mints) is what let an asset acquisition
// silently exclude every brokerage in the app while this suite stayed green.
const checking = { id: "checking", credit: false } as const;
const brokerage = { id: "brokerage", credit: false } as const;
const retirement = { id: "401k", credit: false } as const;
const visa = { id: "visa", credit: true } as const;

describe("getEligibleFundingSources", () => {
  it("admits brokerage and retirement to an asset-acquisition — a down payment may come from any holding", () => {
    const eligible = getEligibleFundingSources("asset-acquisition", [checking, retirement, brokerage]);
    expect(eligible.map((a) => a.id)).toEqual(["checking", "401k", "brokerage"]);
  });

  it("admits credit cards and illiquid accounts alongside liquid accounts for an expense", () => {
    const eligible = getEligibleFundingSources("expense", [checking, retirement, visa, brokerage]);
    expect(eligible.map((a) => a.id)).toEqual(["checking", "401k", "visa", "brokerage"]);
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
