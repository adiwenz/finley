import { describe, it, expect } from "vitest";
import { emptyLedger, type Ledger } from "./ledger";
import { validateLedger, type ValidateLedgerResult } from "./validateLedger";
import type { LedgerBaseConfig } from "./ledgerBase";
import type { LifeEvent } from "./eventTypes";
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

  // A ledger built the way an import arrives — as data, not through `addEvent`, which mints only
  // known types and would refuse these outright.
  const imported = (event: object): Ledger => ({
    events: [event as LifeEvent],
    nextSequenceNumber: 2,
  });

  it("rejects an unknown event type rather than dispatching to a missing handler", () => {
    // An imported plan is untrusted data wearing a `LifeEvent` type: hand-edited, or written by
    // a build that knows an event this one doesn't. The handler lookup would return `undefined`
    // and throw a raw TypeError from inside the fold; this is a normal rejection instead.
    const ledger = imported({ ...loan, id: "bogus-1", type: "Frobnicate", sequenceNumber: 1 });

    let result: ValidateLedgerResult | undefined;
    expect(() => {
      result = validateLedger(ledger, baseConfig);
    }).not.toThrow();

    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect(result.event.id).toBe("bogus-1");
      expect(result.event.type).toBe("Frobnicate");
      // The reason explains the failure without naming the event — the caller stamps that in.
      expect(result.reason).toBe("unknown event type");
      expect(result.reason).not.toContain("bogus-1");
    }
  });

  it("rejects a missing or non-string event type", () => {
    for (const type of [undefined, null, 42, {}]) {
      const ledger = imported({ ...loan, id: "malformed-1", type, sequenceNumber: 1 });
      const result = validateLedger(ledger, baseConfig);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("unknown event type");
    }
  });

  it("does not mistake an inherited Object property for a registered event type", () => {
    // The registry is a plain object, so a discriminant of "toString" or "constructor" finds a
    // truthy value through the prototype chain — `in` or a bare lookup would dispatch into it.
    for (const type of ["toString", "constructor", "hasOwnProperty"]) {
      const ledger = imported({ ...loan, id: `proto-${type}`, type, sequenceNumber: 1 });
      const result = validateLedger(ledger, baseConfig);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("unknown event type");
    }
  });
});
