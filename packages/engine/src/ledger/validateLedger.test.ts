import { describe, it, expect } from "vitest";
import { emptyLedger, validateLedger, type LedgerBaseConfig } from "../index";
import { dollarsToCents } from "../cashFlowSeries";
import { baseConfig, add } from "../events.testSupport";

// validateLedger — the replay-validation fold shared by removeEvent / updateEvent: seed base
// state, then checkEvent + applyEvent each sorted event, bailing on the first conflict.
describe("validateLedger", () => {
  const loan = {
    id: "loan1",
    type: "LoanEvent" as const,
    month: 0,
    liabilityId: "car",
    ownerId: "p1",
    kind: "auto" as const,
    openingBalanceCents: dollarsToCents(5_000),
    apr: 0,
    termMonths: 60,
  };

  it("accepts a ledger whose events all replay cleanly against the base", () => {
    const ledger = add(emptyLedger, loan);
    expect(validateLedger(ledger, baseConfig).ok).toBe(true);
  });

  it("rejects an un-replayable ledger, naming the offending event and its reason", () => {
    const ledger = add(emptyLedger, loan);
    // loan1 is owned by p1, but this base rosters no persons, so its owner precondition fails.
    const noPeople: LedgerBaseConfig = {
      horizonMonths: 12,
      annualInflationRate: 0,
      initialPersons: [],
    };
    const result = validateLedger(ledger, noPeople);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.event.id).toBe("loan1");
      expect(result.event.type).toBe("LoanEvent");
      expect(result.reason).toContain("p1");
    }
  });

  it("accepts the empty ledger", () => {
    expect(validateLedger(emptyLedger, baseConfig).ok).toBe(true);
  });
});
