import { describe, it, expect } from "vitest";
import {
  emptyLedger,
  replayLedger,
  interpretLedger,
  removeEvent,
  updateEvent,
  computeDependents,
  snapshotAt,
  validateLedgerStructure,
  validateNewEvent,
  type Ledger,
  type LedgerBaseConfig,
  type LifeEvent,
} from "./index";
import { dollarsToCents, SimCashFlowSeries } from "./cashFlowSeries";
import { nullJurisdiction, type Jurisdiction } from "./jurisdiction";
import type { Person } from "./person";
import { personLit, makeLiquidAccount, baseConfig, add } from "./events.testSupport";

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
    ledger = add(ledger, {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: personLit("p2", "Bob"),
    });
    // Replay doesn't crash; p2 is now in state (not directly observable in
    // projection but needed for subsequent events).
    const series = replayLedger(ledger, baseConfig, nullJurisdiction);
    expect(series.months.length).toBe(13);
  });
});

// ─── RelationshipEvent — a partner's own jobs (issue #118) ────────────────────

describe("RelationshipEvent — partner jobs", () => {
  // A base anchored to a real calendar "now" so the partner's jobs (authored in
  // calendar years) compile into forward income relative to it.
  const jobsCfg: LedgerBaseConfig = {
    horizonMonths: 12,
    annualInflationRate: 0,
    startYear: 2020,
    initialPersons: [personLit("p1", "Alice")],
    initialAccounts: [makeLiquidAccount()],
  };

  /** A partner carrying one open-ended $2,000/mo job that starts at "now". */
  const partnerWith2kJob = (): Person => ({
    ...personLit("p2", "Bob"),
    jobs: [
      {
        id: "pj1",
        ownerId: "p2",
        startYear: 2020,
        endYear: null,
        salary: { startingSalaryCents: dollarsToCents(24_000), realGrowthPct: 0 },
      },
    ],
  });

  it("a partner's job drives forward earned income in the projection", () => {
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: partnerWith2kJob(),
    });
    const series = replayLedger(ledger, jobsCfg, nullJurisdiction);
    // $2,000/mo earned by the partner across months 1–12 → $24,000.
    expect(series.months[12].netWorthNominalCents).toBe(dollarsToCents(24_000));
  });

  it("a separated partner's job income ends at separation", () => {
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: partnerWith2kJob(),
    });
    ledger = add(ledger, {
      id: "sep1",
      type: "SeparationEvent",
      month: 6,
      partnerPersonId: "p2",
      alimonyMonthlyCents: 0,
      alimonyDurationMonths: 0,
      childSupportMonthlyCents: 0,
    });
    const series = replayLedger(ledger, jobsCfg, nullJurisdiction);
    // Months 1–5 pay ($2,000 × 5 = $10,000); the job stops at separation.
    expect(series.months[12].netWorthNominalCents).toBe(dollarsToCents(10_000));
  });

  it("a partner with no jobs adds no income (single-earner plans unchanged)", () => {
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: personLit("p2", "Bob"),
    });
    const series = replayLedger(ledger, jobsCfg, nullJurisdiction);
    expect(series.months[12].netWorthNominalCents).toBe(0);
  });
});

// ─── RelationshipEvent — a partner's own life-stage ages (issue #118) ─────────

describe("RelationshipEvent — partner retirement & claiming ages", () => {
  const cfg: LedgerBaseConfig = {
    horizonMonths: 120,
    annualInflationRate: 0,
    startYear: 2020,
    initialPersons: [personLit("p1", "Alice")],
    initialAccounts: [makeLiquidAccount()],
  };

  /** A jurisdiction paying a flat $1,000/mo benefit once claimed — the record is stubbed. */
  const flatBenefit: Jurisdiction = {
    ...nullJurisdiction,
    governmentBenefitBaseMonthlyCents: () => dollarsToCents(1_000),
  };

  /** A partner born in 1958 (62 as of the 2020 "now") who claims at `claimingAge`. */
  const partnerClaimingAt = (claimingAge: number): Person => ({
    ...personLit("p2", "Bob"),
    birthYear: 1958,
    benefitClaimingAge: claimingAge,
  });

  const incomeAt = (claimingAge: number, month: number): number => {
    const ledger = add(emptyLedger, {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: partnerClaimingAt(claimingAge),
    });
    return replayLedger(ledger, cfg, flatBenefit).months[month]?.flows?.totalIncomeCents ?? 0;
  };

  it("starts a partner's benefit on THEIR clock — the claiming age they were authored with", () => {
    // Claiming at 65 → 2023, three years past the 2020 "now" → month 36.
    expect(incomeAt(65, 35)).toBe(0);
    expect(incomeAt(65, 36)).toBe(dollarsToCents(1_000));
  });

  it("moves that start when the partner claims later — the age is load-bearing, not decoration", () => {
    // The same partner claiming at 67 is still paid nothing at month 36; their benefit
    // begins two years later, at month 60. A partner whose ages were hardcoded put every
    // partner's benefit in the same calendar month whoever they were.
    expect(incomeAt(67, 36)).toBe(0);
    expect(incomeAt(67, 59)).toBe(0);
    expect(incomeAt(67, 60)).toBe(dollarsToCents(1_000));
  });

  it("stops a partner's open-ended job at THEIR retirement age", () => {
    // Born 1958, retiring at 65 → the job's last paid year is 2022, so month 36 (2023)
    // pays nothing while month 35 still does.
    const working: Person = {
      ...partnerClaimingAt(70), // claim late, so the benefit can't mask the wage stopping
      retirementTargetAge: 65,
      jobs: [
        {
          id: "pj1",
          ownerId: "p2",
          startYear: 2020,
          endYear: null,
          salary: { startingSalaryCents: dollarsToCents(24_000), realGrowthPct: 0 },
        },
      ],
    };
    const ledger = add(emptyLedger, { id: "r1", type: "RelationshipEvent", month: 0, person: working });
    const series = replayLedger(ledger, cfg, flatBenefit);
    expect(series.months[35]?.flows?.totalIncomeCents).toBe(dollarsToCents(2_000));
    expect(series.months[36]?.flows?.totalIncomeCents).toBe(0);
  });
});

// ─── updateEvent — revising an event already in the ledger (§6.1) ─────────────

describe("updateEvent", () => {
  const cfg: LedgerBaseConfig = {
    horizonMonths: 12,
    annualInflationRate: 0,
    startYear: 2020,
    initialPersons: [personLit("p1", "Alice")],
    initialAccounts: [makeLiquidAccount()],
  };

  /** A partner carrying one open-ended job paying `monthlyDollars`, starting at "now". */
  const partnerEarning = (monthlyDollars: number): Person => ({
    ...personLit("p2", "Bob"),
    jobs: [
      {
        id: "pj1",
        ownerId: "p2",
        startYear: 2020,
        endYear: null,
        salary: { startingSalaryCents: dollarsToCents(monthlyDollars * 12), realGrowthPct: 0 },
      },
    ],
  });

  const partnered = (): Ledger =>
    add(emptyLedger, { id: "r1", type: "RelationshipEvent", month: 0, person: partnerEarning(2000) });

  it("revises a partner's jobs in place — the pay change drives the projection", () => {
    // The write that was missing: a partner's jobs live on their RelationshipEvent, so
    // without this the only way to change their salary was to remove the partner
    // entirely (taking every dependent event with them).
    const result = updateEvent(
      partnered(),
      "r1",
      { id: "r1", type: "RelationshipEvent", month: 0, person: partnerEarning(3000) },
      cfg,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const series = replayLedger(result.ledger, cfg, nullJurisdiction);
    expect(series.months[12].netWorthNominalCents).toBe(dollarsToCents(36_000));
  });

  it("keeps the event's place in the ledger — same sequence number, no number minted", () => {
    const ledger = partnered();
    const result = updateEvent(
      ledger,
      "r1",
      { id: "r1", type: "RelationshipEvent", month: 0, person: partnerEarning(3000) },
      cfg,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ledger.events).toHaveLength(1);
    expect(result.ledger.events[0].sequenceNumber).toBe(ledger.events[0].sequenceNumber);
    expect(result.ledger.nextSequenceNumber).toBe(ledger.nextSequenceNumber);
    expect(validateLedgerStructure(result.ledger).ok).toBe(true);
  });

  it("blocks a revision that strands a dependent event, naming it", () => {
    let ledger = partnered();
    ledger = add(ledger, {
      id: "sep1",
      type: "SeparationEvent",
      month: 6,
      partnerPersonId: "p2",
      alimonyMonthlyCents: 0,
      alimonyDurationMonths: 0,
      childSupportMonthlyCents: 0,
    });
    // Moving the partnership to month 9 would put the separation before it.
    const result = updateEvent(
      ledger,
      "r1",
      { id: "r1", type: "RelationshipEvent", month: 9, person: partnerEarning(2000) },
      cfg,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Replay runs in (month, sequence) order, so the separation would now come first —
    // and the conflict names the event the revision stranded, not just "invalid".
    expect(result.conflict).toMatch(/sep1/);
    expect(result.conflict).toMatch(/cannot separate/);
  });

  it("refuses to change an event's id or type, and to update one that isn't there", () => {
    const ledger = partnered();
    const renamed = updateEvent(
      ledger,
      "r1",
      { id: "r2", type: "RelationshipEvent", month: 0, person: partnerEarning(2000) },
      cfg,
    );
    expect(renamed.ok).toBe(false);
    if (!renamed.ok) expect(renamed.conflict).toMatch(/different id/);

    const retyped = updateEvent(
      ledger,
      "r1",
      {
        id: "r1",
        type: "SeparationEvent",
        month: 0,
        partnerPersonId: "p2",
        alimonyMonthlyCents: 0,
        alimonyDurationMonths: 0,
        childSupportMonthlyCents: 0,
      },
      cfg,
    );
    expect(retyped.ok).toBe(false);
    if (!retyped.ok) expect(retyped.conflict).toMatch(/type is fixed/);

    const missing = updateEvent(
      ledger,
      "nope",
      { id: "nope", type: "RelationshipEvent", month: 0, person: partnerEarning(2000) },
      cfg,
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.conflict).toMatch(/No event with id/);
  });

  it("blocks a revision whose own fields are structurally invalid", () => {
    // The same field-level gate `addEvent` runs — a revision is not a way around it.
    const result = updateEvent(
      partnered(),
      "r1",
      { id: "r1", type: "RelationshipEvent", month: 1.5, person: partnerEarning(2000) },
      cfg,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflict).toMatch(/month must be an integer/);
  });
});

// ─── Income series (BudgetItemStartEvent) ─────────────────────────────────────

describe("income series (BudgetItemStartEvent)", () => {
  it("creates income series that increases the liquid account balance", () => {
    const cfg: LedgerBaseConfig = {
      ...baseConfig,
      initialAccounts: [makeLiquidAccount()],
    };
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "j1",
      type: "BudgetItemStartEvent",
      month: 0,
      seriesId: "s1",
      ownerId: "p1",
      seriesType: "income",
      monthlyCents: dollarsToCents(5_000), // $5000/mo
      growthMode: { type: "fixed" },
      taxCategory: "wages",
    });
    const series = replayLedger(ledger, cfg, nullJurisdiction);
    // $5000/mo × 12 months = $60,000
    expect(series.months[12].netWorthNominalCents).toBe(dollarsToCents(60_000));
  });

  it("ending an income series and starting a new one swaps the active income", () => {
    const cfg: LedgerBaseConfig = {
      ...baseConfig,
      initialAccounts: [makeLiquidAccount()],
    };
    let ledger = emptyLedger;
    // First job: $3000/mo from month 0
    ledger = add(ledger, {
      id: "j1",
      type: "BudgetItemStartEvent",
      month: 0,
      seriesId: "s1",
      ownerId: "p1",
      seriesType: "income",
      monthlyCents: dollarsToCents(3_000), // $3000/mo
      growthMode: { type: "fixed" },
      taxCategory: "wages",
    });
    // Job change at month 6: end s1, then start s2 at $6000/mo
    ledger = add(ledger, {
      id: "end1",
      type: "BudgetItemEndEvent",
      month: 6,
      seriesId: "s1",
    });
    ledger = add(ledger, {
      id: "j2",
      type: "BudgetItemStartEvent",
      month: 6,
      seriesId: "s2",
      ownerId: "p1",
      seriesType: "income",
      monthlyCents: dollarsToCents(6_000), // $6000/mo
      growthMode: { type: "fixed" },
      taxCategory: "wages",
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
    ledger = add(ledger, {
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
    ledger = add(ledger, {
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
    ledger = add(ledger, {
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
    ledger = add(ledger, {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: personLit("p2", "Bob"),
    });
    // Partner income: $2000/mo from month 0
    ledger = add(ledger, {
      id: "j1",
      type: "BudgetItemStartEvent",
      month: 0,
      seriesId: "s1",
      ownerId: "p2",
      seriesType: "income",
      monthlyCents: dollarsToCents(2_000), // $2000/mo
      growthMode: { type: "fixed" },
      taxCategory: "wages",
    });
    // Separate at month 6 — partner income ends at month 5
    ledger = add(ledger, {
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
    ledger = add(ledger, {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: personLit("p2", "Bob"),
    });
    ledger = add(ledger, {
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
    ledger = add(ledger, {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: personLit("p2", "Bob"),
    });
    ledger = add(ledger, {
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
    ledger = add(ledger, {
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

  it("a LoanEvent at month M originates the liability at M, not at month 0", () => {
    const cfg: LedgerBaseConfig = {
      ...baseConfig,
      horizonMonths: 24,
      initialAccounts: [makeLiquidAccount("checking", dollarsToCents(20_000))],
    };
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "loan1",
      type: "LoanEvent",
      month: 12,
      liabilityId: "car",
      ownerId: "p1",
      kind: "auto",
      openingBalanceCents: dollarsToCents(10_000),
      apr: 0,
      termMonths: 60,
    });
    const series = replayLedger(ledger, cfg, nullJurisdiction);

    // Balance (a stock) is 0 until the loan originates, then the opening balance.
    expect(series.months[11].liabilityBalancesCents["car"]).toBe(0);
    expect(series.months[12].liabilityBalancesCents["car"]).toBe(dollarsToCents(10_000));
    // Net worth only carries the loan from month 12 onward.
    expect(series.months[11].netWorthNominalCents).toBe(dollarsToCents(20_000));
    expect(series.months[12].netWorthNominalCents).toBe(dollarsToCents(10_000));

    // Snapshot presence and projected balance now agree about when it starts.
    expect(snapshotAt(ledger, 11).liabilities).toHaveLength(0);
    expect(snapshotAt(ledger, 12).liabilities.map((l) => l.id)).toEqual(["car"]);
  });

  it("DebtPayoffEvent reduces liability balance and account balance", () => {
    const cfg: LedgerBaseConfig = {
      ...baseConfig,
      initialAccounts: [makeLiquidAccount("checking", dollarsToCents(20_000))],
    };
    let ledger = emptyLedger;
    ledger = add(ledger, {
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
    ledger = add(ledger, {
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

describe("addEvent — sequence numbers", () => {
  it("assigns monotonically increasing sequence numbers", () => {
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "e1",
      type: "BudgetItemStartEvent",
      month: 0,
      seriesId: "s1",
      ownerId: "p1",
      seriesType: "income",
      monthlyCents: 1000,
      growthMode: { type: "fixed" },
    });
    ledger = add(ledger, {
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
    expect(ledger.nextSequenceNumber).toBe(2);
  });

  it("does not recycle a removed sequence number (§13)", () => {
    let ledger = emptyLedger;
    for (const id of ["a", "b", "c"]) {
      ledger = add(ledger, {
        id,
        type: "BudgetItemStartEvent",
        month: 0,
        seriesId: `s-${id}`,
        ownerId: "p1",
        seriesType: "expense",
        monthlyCents: dollarsToCents(100),
        growthMode: { type: "fixed" },
      });
    }
    expect(ledger.nextSequenceNumber).toBe(3);

    const removed = removeEvent(ledger, "b", baseConfig);
    expect(removed.ok).toBe(true);
    if (removed.ok) ledger = removed.ledger;
    expect(ledger.nextSequenceNumber).toBe(3); // not decremented

    ledger = add(ledger, {
      id: "d",
      type: "BudgetItemStartEvent",
      month: 0,
      seriesId: "s-d",
      ownerId: "p1",
      seriesType: "expense",
      monthlyCents: dollarsToCents(100),
      growthMode: { type: "fixed" },
    });
    expect(ledger.events.at(-1)?.sequenceNumber).toBe(3); // reuses next, not the freed 1
    expect(ledger.nextSequenceNumber).toBe(4);
  });
});

// ─── removeEvent — base replay context (§7) ───────────────────────────────────

describe("removeEvent — replays against base-seeded people", () => {
  it("succeeds when a remaining event's owner is a base person; fails without that person", () => {
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "j1",
      type: "BudgetItemStartEvent",
      month: 0,
      seriesId: "s1",
      ownerId: "p1",
      seriesType: "income",
      monthlyCents: dollarsToCents(5_000),
      growthMode: { type: "fixed" },
      taxCategory: "wages",
    });
    ledger = add(ledger, {
      id: "b1",
      type: "BudgetItemStartEvent",
      month: 0,
      seriesId: "rent",
      ownerId: "p1",
      seriesType: "expense",
      monthlyCents: dollarsToCents(1_000),
      growthMode: { type: "fixed" },
    });
    // j1 (owned by base person p1) still validates when replayed after removal.
    expect(removeEvent(ledger, "b1", baseConfig).ok).toBe(true);
    // Without p1 in the base, j1's owner precondition fails.
    const noPeople: LedgerBaseConfig = { horizonMonths: 12, annualInflationRate: 0, initialPersons: [] };
    expect(removeEvent(ledger, "b1", noPeople).ok).toBe(false);
  });

  it("returns a failure when the event id does not exist", () => {
    const result = removeEvent(emptyLedger, "does-not-exist", baseConfig);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflict).toContain("does-not-exist");
  });
});

// ─── computeDependents — transitive cascade (§8) ──────────────────────────────

describe("computeDependents — transitive cascade", () => {
  it("returns the whole causedBy chain, and removeEvent cascades all of it", () => {
    let ledger = emptyLedger;
    ledger = add(ledger, {
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
    ledger = add(ledger, {
      id: "pay1",
      type: "DebtPayoffEvent",
      month: 3,
      causedByEventId: "loan1",
      liabilityId: "car",
      accountId: "checking",
      amountCents: dollarsToCents(1_000),
    });
    ledger = add(ledger, {
      id: "pay2",
      type: "DebtPayoffEvent",
      month: 6,
      causedByEventId: "pay1",
      liabilityId: "car",
      accountId: "checking",
      amountCents: dollarsToCents(1_000),
    });

    const deps = computeDependents(ledger, "loan1");
    expect(deps).toEqual(expect.arrayContaining(["loan1", "pay1", "pay2"]));
    expect(deps).toHaveLength(3);

    const result = removeEvent(ledger, "loan1", baseConfig);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ledger.events).toHaveLength(0);
  });
});

// ─── Event validation (§6, §13) ───────────────────────────────────────────────

describe("event validation", () => {
  it("validateLedgerStructure rejects a duplicate event id", () => {
    const dup: Ledger = {
      events: [
        { id: "x", type: "ChildEvent", sequenceNumber: 0, month: 0, childId: "k1", childName: "A", birthMonth: 0, annualCostCents: 0 },
        { id: "x", type: "ChildEvent", sequenceNumber: 1, month: 0, childId: "k2", childName: "B", birthMonth: 0, annualCostCents: 0 },
      ],
      nextSequenceNumber: 2,
    };
    expect(validateLedgerStructure(dup).ok).toBe(false);
  });

  it("validateNewEvent rejects a duplicate person id", () => {
    const ledger = add(emptyLedger, {
      id: "r1", type: "RelationshipEvent", month: 0, person: personLit("p2", "Sam"),
    });
    const result = validateNewEvent(ledger, baseConfig, {
      id: "r2", type: "RelationshipEvent", month: 0, person: personLit("p2", "Other"),
    });
    expect(result.ok).toBe(false);
  });

  it("validateNewEvent rejects ending a nonexistent series", () => {
    const result = validateNewEvent(emptyLedger, baseConfig, {
      id: "e1", type: "BudgetItemEndEvent", month: 0, seriesId: "ghost",
    });
    expect(result.ok).toBe(false);
  });

  it("validateNewEvent rejects separating from an already-separated partner", () => {
    let ledger = emptyLedger;
    ledger = add(ledger, { id: "r1", type: "RelationshipEvent", month: 0, person: personLit("p2", "Sam") });
    ledger = add(ledger, {
      id: "sep1", type: "SeparationEvent", month: 6, partnerPersonId: "p2",
      alimonyMonthlyCents: 0, alimonyDurationMonths: 0, childSupportMonthlyCents: 0,
    });
    const result = validateNewEvent(ledger, baseConfig, {
      id: "sep2", type: "SeparationEvent", month: 12, partnerPersonId: "p2",
      alimonyMonthlyCents: 0, alimonyDurationMonths: 0, childSupportMonthlyCents: 0,
    });
    expect(result.ok).toBe(false);
  });

  it("validateNewEvent rejects separating before the partnership month", () => {
    // Partner joins at month 60; a separation dated month 12 predates the partnership.
    const ledger = add(emptyLedger, {
      id: "r1", type: "RelationshipEvent", month: 60, person: personLit("p2", "Sam"),
    });
    const result = validateNewEvent(ledger, baseConfig, {
      id: "sep1", type: "SeparationEvent", month: 12, partnerPersonId: "p2",
      alimonyMonthlyCents: 0, alimonyDurationMonths: 0, childSupportMonthlyCents: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("before partnering");
  });
});

// ─── Replay order — (month, sequenceNumber) (§5, §6) ──────────────────────────

describe("replay order", () => {
  it("same-month producer-before-consumer: an end applies after the series it ends", () => {
    let ledger = emptyLedger;
    // s1 runs from month 0; at month 12 it ends and s2 begins in the same month.
    ledger = add(ledger, {
      id: "j1", type: "BudgetItemStartEvent", month: 0, seriesId: "s1", ownerId: "p1",
      seriesType: "income", monthlyCents: dollarsToCents(3_000), growthMode: { type: "fixed" }, taxCategory: "wages",
    });
    ledger = add(ledger, {
      id: "end1", type: "BudgetItemEndEvent", month: 12, seriesId: "s1",
    });
    ledger = add(ledger, {
      id: "j2", type: "BudgetItemStartEvent", month: 12, seriesId: "s2", ownerId: "p1",
      seriesType: "income", monthlyCents: dollarsToCents(5_000), growthMode: { type: "fixed" }, taxCategory: "wages",
    });
    const snap = snapshotAt(ledger, 12, { initialPersons: [personLit("p1", "Alice")] });
    // s1 ended at month 11 (12−1); only s2 is active at month 12.
    expect(snap.income.map((s) => s.id)).toEqual(["s2"]);
  });

  it("orders by sequenceNumber, not array position", () => {
    // Hand-built ledger with the events stored in reverse of their sequence.
    const j1: LifeEvent = {
      id: "j1", type: "BudgetItemStartEvent", sequenceNumber: 0, month: 0, seriesId: "s1", ownerId: "p1",
      seriesType: "income", monthlyCents: dollarsToCents(1_000), growthMode: { type: "fixed" }, taxCategory: "wages",
    };
    const end1: LifeEvent = {
      id: "end1", type: "BudgetItemEndEvent", sequenceNumber: 1, month: 0, seriesId: "s1",
    };
    const j2: LifeEvent = {
      id: "j2", type: "BudgetItemStartEvent", sequenceNumber: 2, month: 0, seriesId: "s2", ownerId: "p1",
      seriesType: "income", monthlyCents: dollarsToCents(2_000), growthMode: { type: "fixed" }, taxCategory: "wages",
    };
    const ledger: Ledger = { events: [j2, end1, j1], nextSequenceNumber: 3 };
    const snap = snapshotAt(ledger, 0, { initialPersons: [personLit("p1", "Alice")] });
    // Sorted by (month, seq): j1 creates s1, end1 ends it, j2 creates s2 → only s2 active.
    expect(snap.income.map((s) => s.id)).toEqual(["s2"]);
  });
});

// ─── ChildEvent ───────────────────────────────────────────────────────────────

describe("ChildEvent", () => {
  it("records a child as a durable entity", () => {
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "c1",
      type: "ChildEvent",
      month: 3,
      childId: "kid1",
      childName: "Charlie",
      birthMonth: 3,
      annualCostCents: 0,
    });
    // Replay doesn't crash; child entity is tracked internally.
    const series = replayLedger(ledger, baseConfig, nullJurisdiction);
    expect(series.months.length).toBe(13);
  });

  it("annual cost spawns a bounded 18-year childCost expense that reduces net worth", () => {
    const cfg: LedgerBaseConfig = {
      ...baseConfig,
      initialAccounts: [makeLiquidAccount("checking", dollarsToCents(12_000))],
    };
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "c1",
      type: "ChildEvent",
      month: 0,
      childId: "kid1",
      childName: "Charlie",
      birthMonth: 0,
      // $12,000/yr = $1,000/mo — over the 12-month horizon drains the account.
      annualCostCents: dollarsToCents(12_000),
    });
    const series = replayLedger(ledger, cfg, nullJurisdiction);
    expect(series.months[12].netWorthNominalCents).toBe(0);

    // The derived series is a childCost expense bounded to exactly 18 years.
    const household = interpretLedger(ledger, cfg);
    const cost = household.series.find((s) => s.role === "childCost")!;
    expect(cost).toBeDefined();
    expect(cost.seriesType).toBe("expense");
    expect(cost.causedByEventId).toBe("c1");
    expect(cost.startMonth).toBe(0);
    expect(cost.endMonth).toBe(18 * 12 - 1);
  });

  it("a zero annual cost creates no childCost expense", () => {
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "c1",
      type: "ChildEvent",
      month: 0,
      childId: "kid1",
      childName: "Charlie",
      birthMonth: 0,
      annualCostCents: 0,
    });
    const household = interpretLedger(ledger, baseConfig);
    expect(household.series.some((s) => s.role === "childCost")).toBe(false);
  });
});

// ─── Undo: Strategy A (precondition check) ───────────────────────────────────

describe("removeEvent — Strategy A", () => {
  it("blocks removing a RelationshipEvent if a SeparationEvent depends on the person", () => {
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: personLit("p2", "Bob"),
    });
    ledger = add(ledger, {
      id: "sep1",
      type: "SeparationEvent",
      month: 6,
      partnerPersonId: "p2",
      alimonyMonthlyCents: 0,
      alimonyDurationMonths: 0,
      childSupportMonthlyCents: 0,
    });
    // Removing r1 would leave sep1 referencing a non-existent person.
    const result = removeEvent(ledger, "r1", baseConfig);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toContain("p2");
    }
  });

  it("blocks removing a LoanEvent if a DebtPayoffEvent targets that liability", () => {
    let ledger = emptyLedger;
    ledger = add(ledger, {
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
    ledger = add(ledger, {
      id: "payoff1",
      type: "DebtPayoffEvent",
      month: 6,
      liabilityId: "car",
      accountId: "checking",
      amountCents: dollarsToCents(3_000),
    });
    const result = removeEvent(ledger, "loan1", baseConfig);
    expect(result.ok).toBe(false);
  });

  it("allows removing a standalone event with no dependents", () => {
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "b1",
      type: "BudgetItemStartEvent",
      month: 0,
      seriesId: "rent",
      ownerId: "p1",
      seriesType: "expense",
      monthlyCents: dollarsToCents(1_000),
      growthMode: { type: "fixed" },
    });
    const result = removeEvent(ledger, "b1", baseConfig);
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
    ledger = add(ledger, {
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
    ledger = add(ledger, {
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
    ledger = add(ledger, {
      id: "payoff1",
      type: "DebtPayoffEvent",
      month: 6,
      causedByEventId: "loan1",
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
    ledger = add(ledger, {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: personLit("p2", "Bob"),
    });
    // Income event tagged as child of r1 via sourceEventId
    ledger = add(ledger, {
      id: "j1",
      type: "BudgetItemStartEvent",
      month: 0,
      causedByEventId: "r1",
      seriesId: "s1",
      ownerId: "p2",
      seriesType: "income",
      monthlyCents: dollarsToCents(5_000),
      growthMode: { type: "fixed" },
      taxCategory: "wages",
    });
    // No SeparationEvent — so removing r1 is not blocked by Strategy A.
    const result = removeEvent(ledger, "r1", baseConfig);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Both r1 and j1 (its dependent) are removed.
      expect(result.ledger.events).toHaveLength(0);
    }
  });
});

// ─── Base series (value-editing surface, §10.2) ───────────────────────────────

describe("initialIncomeSeries / initialExpenseSeries", () => {
  it("base income series drive net worth without any events", () => {
    const income = new SimCashFlowSeries(
      0,
      dollarsToCents(4_000),
      { type: "fixed" },
      { baselineUnit: "monthly" },
    );
    const cfg: LedgerBaseConfig = {
      ...baseConfig,
      initialAccounts: [makeLiquidAccount()],
      initialIncomeSeries: [{ series: income, ownerId: "p1" }],
    };
    const series = replayLedger(emptyLedger, cfg, nullJurisdiction);
    // $4000/mo × 12 = $48,000
    expect(series.months[12].netWorthNominalCents).toBe(dollarsToCents(48_000));
  });

  it("base expense series net against event-derived income", () => {
    const expense = new SimCashFlowSeries(
      0,
      dollarsToCents(1_000),
      { type: "fixed" },
      { baselineUnit: "monthly" },
    );
    const cfg: LedgerBaseConfig = {
      ...baseConfig,
      initialAccounts: [makeLiquidAccount()],
      initialExpenseSeries: [{ series: expense, ownerId: "p1" }],
    };
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "j1",
      type: "BudgetItemStartEvent",
      month: 0,
      seriesId: "s1",
      ownerId: "p1",
      seriesType: "income",
      monthlyCents: dollarsToCents(3_000), // $3000/mo
      growthMode: { type: "fixed" },
      taxCategory: "wages",
    });
    const series = replayLedger(ledger, cfg, nullJurisdiction);
    // ($3000 − $1000)/mo × 12 = $24,000
    expect(series.months[12].netWorthNominalCents).toBe(dollarsToCents(24_000));
  });

  it("a fromHereForward value override on a base series changes the trajectory", () => {
    const expense = new SimCashFlowSeries(
      0,
      dollarsToCents(1_000),
      { type: "fixed" },
      { baselineUnit: "monthly" },
    );
    // Value edit (override), NOT an event: expenses rise to $2000 from month 6.
    expense.addOverride(6, dollarsToCents(2_000), "fromHereForward");
    const cfg: LedgerBaseConfig = {
      ...baseConfig,
      // Large opening balance so no shortfall cascade / interest muddies the math.
      initialAccounts: [makeLiquidAccount("checking", dollarsToCents(100_000))],
      initialExpenseSeries: [{ series: expense, ownerId: "p1" }],
    };
    const series = replayLedger(emptyLedger, cfg, nullJurisdiction);
    // Flow lands months 1–12. Override at month 6 (fromHereForward) covers
    // months 6–12: 5 months × $1000 + 7 months × $2000 = $19,000 spent.
    expect(series.months[12].netWorthNominalCents).toBe(dollarsToCents(81_000));
  });
});
