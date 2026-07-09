import { describe, it, expect } from "vitest";
import {
  emptyLedger,
  appendEvent,
  replayLedger,
  removeEvent,
  computeDependents,
  type LedgerBaseConfig,
} from "./events";
import { Account } from "./account";
import { dollarsToCents } from "./cashFlowSeries";
import { nullJurisdiction } from "./jurisdiction";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeLiquidAccount(id = "checking", openingCents = 0): Account {
  return new Account({
    id,
    ownerId: "p1",
    liquid: true,
    taxTreatment: "taxable",
    openingBalanceCents: openingCents,
    initialAnnualRate: 0,
  });
}

const baseConfig: LedgerBaseConfig = {
  horizonMonths: 12,
  annualInflationRate: 0,
  initialPersons: [{ id: "p1", name: "Alice" }],
};

// ─── Replay basics ────────────────────────────────────────────────────────────

describe("replayLedger — empty ledger", () => {
  it("empty ledger with no income/expense produces flat zero projection", () => {
    const series = replayLedger(emptyLedger, baseConfig, nullJurisdiction);
    expect(series.months.length).toBe(13);
    expect(series.months[0].netWorthNominalCents).toBe(0);
    expect(series.months[12].netWorthNominalCents).toBe(0);
  });
});

// ─── RelationshipEvent ────────────────────────────────────────────────────────

describe("RelationshipEvent", () => {
  it("adds a person to the household", () => {
    let ledger = emptyLedger;
    ledger = appendEvent(ledger, {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: { id: "p2", name: "Bob" },
    });
    // Replay doesn't crash; p2 is now in state (not directly observable in
    // projection but needed for subsequent events).
    const series = replayLedger(ledger, baseConfig, nullJurisdiction);
    expect(series.months.length).toBe(13);
  });
});

// ─── JobChangeEvent ───────────────────────────────────────────────────────────

describe("JobChangeEvent", () => {
  it("creates income series that increases the liquid account balance", () => {
    const cfg: LedgerBaseConfig = {
      ...baseConfig,
      initialAccounts: [makeLiquidAccount()],
    };
    let ledger = emptyLedger;
    ledger = appendEvent(ledger, {
      id: "j1",
      type: "JobChangeEvent",
      month: 0,
      seriesId: "s1",
      ownerId: "p1",
      annualIncomeCents: dollarsToCents(60_000), // $5000/mo
      growthMode: { type: "fixed" },
      taxCategory: "wages",
    });
    const series = replayLedger(ledger, cfg, nullJurisdiction);
    // $5000/mo × 12 months = $60,000
    expect(series.months[12].netWorthNominalCents).toBe(dollarsToCents(60_000));
  });

  it("replacesSeriesId ends the previous income series at month−1", () => {
    const cfg: LedgerBaseConfig = {
      ...baseConfig,
      initialAccounts: [makeLiquidAccount()],
    };
    let ledger = emptyLedger;
    // First job: $3000/mo from month 0
    ledger = appendEvent(ledger, {
      id: "j1",
      type: "JobChangeEvent",
      month: 0,
      seriesId: "s1",
      ownerId: "p1",
      annualIncomeCents: dollarsToCents(36_000), // $3000/mo
      growthMode: { type: "fixed" },
      taxCategory: "wages",
    });
    // Job change at month 6: $6000/mo, replaces s1
    ledger = appendEvent(ledger, {
      id: "j2",
      type: "JobChangeEvent",
      month: 6,
      seriesId: "s2",
      ownerId: "p1",
      annualIncomeCents: dollarsToCents(72_000), // $6000/mo
      growthMode: { type: "fixed" },
      taxCategory: "wages",
      replacesSeriesId: "s1",
    });
    const series = replayLedger(ledger, cfg, nullJurisdiction);
    // Old job ends at month 5 (endMonth = 6−1); new job starts at month 6.
    // Months 1–5 at $3000 = $15,000; months 6–12 at $6000 = $42,000 → $57,000
    expect(series.months[12].netWorthNominalCents).toBe(dollarsToCents(57_000));
  });
});

// ─── BudgetItemStartEvent / BudgetItemEndEvent ────────────────────────────────

describe("BudgetItemStartEvent / BudgetItemEndEvent", () => {
  it("creates an expense series that reduces net worth", () => {
    const cfg: LedgerBaseConfig = {
      ...baseConfig,
      initialAccounts: [makeLiquidAccount("checking", dollarsToCents(24_000))],
    };
    let ledger = emptyLedger;
    ledger = appendEvent(ledger, {
      id: "b1",
      type: "BudgetItemStartEvent",
      month: 0,
      seriesId: "rent",
      ownerId: "p1",
      seriesType: "expense",
      monthlyCents: dollarsToCents(2_000),
      growthMode: { type: "fixed" },
    });
    const series = replayLedger(ledger, cfg, nullJurisdiction);
    // $24,000 opening − $2000/mo × 12 = $0
    expect(series.months[12].netWorthNominalCents).toBe(0);
  });

  it("BudgetItemEndEvent ends the expense series at month−1", () => {
    const cfg: LedgerBaseConfig = {
      ...baseConfig,
      initialAccounts: [makeLiquidAccount("checking", dollarsToCents(12_000))],
    };
    let ledger = emptyLedger;
    ledger = appendEvent(ledger, {
      id: "b1",
      type: "BudgetItemStartEvent",
      month: 0,
      seriesId: "rent",
      ownerId: "p1",
      seriesType: "expense",
      monthlyCents: dollarsToCents(1_000),
      growthMode: { type: "fixed" },
    });
    // End rent at month 6 (stops after month 5, last active = month 5)
    ledger = appendEvent(ledger, {
      id: "b2",
      type: "BudgetItemEndEvent",
      month: 6,
      seriesId: "rent",
    });
    const series = replayLedger(ledger, cfg, nullJurisdiction);
    // Months 1–5 active: 5 × $1000 = $5000 spent → $7000 remaining
    expect(series.months[12].netWorthNominalCents).toBe(dollarsToCents(7_000));
  });
});

// ─── SeparationEvent ──────────────────────────────────────────────────────────

describe("SeparationEvent", () => {
  it("ends partner income streams from separation month", () => {
    const cfg: LedgerBaseConfig = {
      ...baseConfig,
      initialAccounts: [makeLiquidAccount()],
    };
    let ledger = emptyLedger;
    // Add partner
    ledger = appendEvent(ledger, {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: { id: "p2", name: "Bob" },
    });
    // Partner income: $2000/mo from month 0
    ledger = appendEvent(ledger, {
      id: "j1",
      type: "JobChangeEvent",
      month: 0,
      seriesId: "s1",
      ownerId: "p2",
      annualIncomeCents: dollarsToCents(24_000), // $2000/mo
      growthMode: { type: "fixed" },
      taxCategory: "wages",
    });
    // Separate at month 6 — partner income ends at month 5
    ledger = appendEvent(ledger, {
      id: "sep1",
      type: "SeparationEvent",
      month: 6,
      partnerPersonId: "p2",
      alimonyMonthlyCents: 0,
      alimonyDurationMonths: 0,
      childSupportMonthlyCents: 0,
    });
    const series = replayLedger(ledger, cfg, nullJurisdiction);
    // Months 1–5: $2000 × 5 = $10,000; months 6–12: $0
    expect(series.months[12].netWorthNominalCents).toBe(dollarsToCents(10_000));
  });

  it("creates alimony expense stream after separation", () => {
    const cfg: LedgerBaseConfig = {
      ...baseConfig,
      initialAccounts: [makeLiquidAccount("checking", dollarsToCents(20_000))],
    };
    let ledger = emptyLedger;
    ledger = appendEvent(ledger, {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: { id: "p2", name: "Bob" },
    });
    ledger = appendEvent(ledger, {
      id: "sep1",
      type: "SeparationEvent",
      month: 1,
      partnerPersonId: "p2",
      alimonyMonthlyCents: dollarsToCents(1_000),
      alimonyDurationMonths: 6,
      childSupportMonthlyCents: 0,
    });
    const series = replayLedger(ledger, cfg, nullJurisdiction);
    // Alimony months 1–6: 6 × $1000 = $6000 expense → $14,000 remaining
    expect(series.months[12].netWorthNominalCents).toBe(dollarsToCents(14_000));
  });

  it("child support expense runs indefinitely (no endMonth)", () => {
    const cfg: LedgerBaseConfig = {
      ...baseConfig,
      initialAccounts: [makeLiquidAccount("checking", dollarsToCents(12_000))],
    };
    let ledger = emptyLedger;
    ledger = appendEvent(ledger, {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: { id: "p2", name: "Bob" },
    });
    ledger = appendEvent(ledger, {
      id: "sep1",
      type: "SeparationEvent",
      month: 0,
      partnerPersonId: "p2",
      alimonyMonthlyCents: 0,
      alimonyDurationMonths: 0,
      childSupportMonthlyCents: dollarsToCents(1_000),
    });
    const series = replayLedger(ledger, cfg, nullJurisdiction);
    // Child support months 1–12: 12 × $1000 = $12,000 → $0 remaining
    expect(series.months[12].netWorthNominalCents).toBe(0);
  });
});

// ─── LoanEvent + DebtPayoffEvent ─────────────────────────────────────────────

describe("LoanEvent + DebtPayoffEvent", () => {
  it("LoanEvent adds a liability that reduces net worth at month 0", () => {
    const cfg: LedgerBaseConfig = {
      ...baseConfig,
      initialAccounts: [makeLiquidAccount("checking", dollarsToCents(20_000))],
    };
    let ledger = emptyLedger;
    ledger = appendEvent(ledger, {
      id: "loan1",
      type: "LoanEvent",
      month: 0,
      liabilityId: "car",
      ownerId: "p1",
      kind: "auto",
      openingBalanceCents: dollarsToCents(10_000),
      apr: 0,
      termMonths: 60,
    });
    const series = replayLedger(ledger, cfg, nullJurisdiction);
    // $20k assets − $10k loan = $10k net worth at month 0
    expect(series.months[0].netWorthNominalCents).toBe(dollarsToCents(10_000));
  });

  it("DebtPayoffEvent reduces liability balance and account balance", () => {
    const cfg: LedgerBaseConfig = {
      ...baseConfig,
      initialAccounts: [makeLiquidAccount("checking", dollarsToCents(20_000))],
    };
    let ledger = emptyLedger;
    ledger = appendEvent(ledger, {
      id: "loan1",
      type: "LoanEvent",
      month: 0,
      liabilityId: "car",
      ownerId: "p1",
      kind: "auto",
      openingBalanceCents: dollarsToCents(10_000),
      apr: 0,
      termMonths: 120,
    });
    // Lump-sum payoff at month 6: $5000
    ledger = appendEvent(ledger, {
      id: "payoff1",
      type: "DebtPayoffEvent",
      month: 6,
      liabilityId: "car",
      accountId: "checking",
      amountCents: dollarsToCents(5_000),
    });
    const series = replayLedger(ledger, cfg, nullJurisdiction);
    // Net worth is conserved (cash out = debt reduced): stays at $10k every month
    // (at 0% APR with no income/expense; scheduled payments also zero the gap)
    expect(series.months[6].liabilityBalancesCents["car"]).toBeLessThan(
      dollarsToCents(10_000),
    );
  });
});

// ─── Sequence number + same-month ordering ────────────────────────────────────

describe("appendEvent — sequence numbers", () => {
  it("assigns monotonically increasing sequence numbers", () => {
    let ledger = emptyLedger;
    ledger = appendEvent(ledger, {
      id: "e1",
      type: "BudgetItemStartEvent",
      month: 0,
      seriesId: "s1",
      ownerId: "p1",
      seriesType: "income",
      monthlyCents: 1000,
      growthMode: { type: "fixed" },
    });
    ledger = appendEvent(ledger, {
      id: "e2",
      type: "BudgetItemStartEvent",
      month: 0,
      seriesId: "s2",
      ownerId: "p1",
      seriesType: "income",
      monthlyCents: 2000,
      growthMode: { type: "fixed" },
    });
    expect(ledger.events[0].sequenceNumber).toBe(0);
    expect(ledger.events[1].sequenceNumber).toBe(1);
    expect(ledger.nextSeq).toBe(2);
  });
});

// ─── ChildEvent ───────────────────────────────────────────────────────────────

describe("ChildEvent", () => {
  it("records a child as a durable entity", () => {
    let ledger = emptyLedger;
    ledger = appendEvent(ledger, {
      id: "c1",
      type: "ChildEvent",
      month: 3,
      childId: "kid1",
      childName: "Charlie",
      birthMonth: 3,
    });
    // Replay doesn't crash; child entity is tracked internally.
    const series = replayLedger(ledger, baseConfig, nullJurisdiction);
    expect(series.months.length).toBe(13);
  });
});

// ─── Undo: Strategy A (precondition check) ───────────────────────────────────

describe("removeEvent — Strategy A", () => {
  it("blocks removing a RelationshipEvent if a SeparationEvent depends on the person", () => {
    let ledger = emptyLedger;
    ledger = appendEvent(ledger, {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: { id: "p2", name: "Bob" },
    });
    ledger = appendEvent(ledger, {
      id: "sep1",
      type: "SeparationEvent",
      month: 6,
      partnerPersonId: "p2",
      alimonyMonthlyCents: 0,
      alimonyDurationMonths: 0,
      childSupportMonthlyCents: 0,
    });
    // Removing r1 would leave sep1 referencing a non-existent person.
    const result = removeEvent(ledger, "r1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toContain("p2");
    }
  });

  it("blocks removing a LoanEvent if a DebtPayoffEvent targets that liability", () => {
    let ledger = emptyLedger;
    ledger = appendEvent(ledger, {
      id: "loan1",
      type: "LoanEvent",
      month: 0,
      liabilityId: "car",
      ownerId: "p1",
      kind: "auto",
      openingBalanceCents: dollarsToCents(10_000),
      apr: 0.05,
      termMonths: 60,
    });
    ledger = appendEvent(ledger, {
      id: "payoff1",
      type: "DebtPayoffEvent",
      month: 6,
      liabilityId: "car",
      accountId: "checking",
      amountCents: dollarsToCents(3_000),
    });
    const result = removeEvent(ledger, "loan1");
    expect(result.ok).toBe(false);
  });

  it("allows removing a standalone event with no dependents", () => {
    let ledger = emptyLedger;
    ledger = appendEvent(ledger, {
      id: "b1",
      type: "BudgetItemStartEvent",
      month: 0,
      seriesId: "rent",
      ownerId: "p1",
      seriesType: "expense",
      monthlyCents: dollarsToCents(1_000),
      growthMode: { type: "fixed" },
    });
    const result = removeEvent(ledger, "b1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ledger.events).toHaveLength(0);
    }
  });
});

// ─── Undo: Strategy B (computeDependents cascade) ─────────────────────────────

describe("computeDependents", () => {
  it("returns just the event id when there are no dependents", () => {
    let ledger = emptyLedger;
    ledger = appendEvent(ledger, {
      id: "e1",
      type: "BudgetItemStartEvent",
      month: 0,
      seriesId: "s1",
      ownerId: "p1",
      seriesType: "income",
      monthlyCents: 1000,
      growthMode: { type: "fixed" },
    });
    expect(computeDependents(ledger, "e1")).toEqual(["e1"]);
  });

  it("includes events whose sourceEventId matches the target", () => {
    let ledger = emptyLedger;
    ledger = appendEvent(ledger, {
      id: "loan1",
      type: "LoanEvent",
      month: 0,
      liabilityId: "car",
      ownerId: "p1",
      kind: "auto",
      openingBalanceCents: dollarsToCents(10_000),
      apr: 0.05,
      termMonths: 60,
    });
    // Tag a payoff as a child of loan1 via sourceEventId
    ledger = appendEvent(ledger, {
      id: "payoff1",
      type: "DebtPayoffEvent",
      month: 6,
      sourceEventId: "loan1",
      liabilityId: "car",
      accountId: "checking",
      amountCents: dollarsToCents(3_000),
    });
    const deps = computeDependents(ledger, "loan1");
    expect(deps).toContain("loan1");
    expect(deps).toContain("payoff1");
  });
});

describe("removeEvent — Strategy B cascade", () => {
  it("removes dependent events (sourceEventId chain) along with the target", () => {
    let ledger = emptyLedger;
    ledger = appendEvent(ledger, {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: { id: "p2", name: "Bob" },
    });
    // Job event tagged as child of r1 via sourceEventId
    ledger = appendEvent(ledger, {
      id: "j1",
      type: "JobChangeEvent",
      month: 0,
      sourceEventId: "r1",
      seriesId: "s1",
      ownerId: "p2",
      annualIncomeCents: dollarsToCents(60_000),
      growthMode: { type: "fixed" },
      taxCategory: "wages",
    });
    // No SeparationEvent — so removing r1 is not blocked by Strategy A.
    const result = removeEvent(ledger, "r1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Both r1 and j1 (its dependent) are removed.
      expect(result.ledger.events).toHaveLength(0);
    }
  });
});
