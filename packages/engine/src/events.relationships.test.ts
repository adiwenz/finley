import { describe, it, expect } from "vitest";
import { emptyLedger, replayLedger, interpretLedger, type LedgerBaseConfig } from "./index";
import { dollarsToCents } from "./cashFlowSeries";
import { nullJurisdiction, type Jurisdiction } from "./jurisdiction";
import type { Person } from "./person";
import { personLit, makeLiquidAccount, baseConfig, add } from "./events.testSupport";

describe("RelationshipEvent", () => {
  it("adds a person to the household", () => {
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: personLit("p2", "Bob"),
    });
    // Replay doesn't crash; p2 is in state — not observable in the projection, but needed
    // by subsequent events.
    const series = replayLedger(ledger, baseConfig, nullJurisdiction);
    expect(series.months.length).toBe(12);
  });
});

describe("RelationshipEvent — partner jobs", () => {
  // Anchored to a real calendar "now" so the partner's jobs, authored in calendar years,
  // compile into forward income relative to it.
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
    // $2,000/mo earned by the partner across the 12 processed months (0..11) → $24,000.
    expect(series.months[11].netWorthNominalCents).toBe(dollarsToCents(24_000));
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
    // Processed months 0..5 pay before the month-6 separation ($2,000 × 6 = $12,000); the job
    // stops at separation.
    expect(series.months[11].netWorthNominalCents).toBe(dollarsToCents(12_000));
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
    expect(series.months[11].netWorthNominalCents).toBe(0);
  });
});

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
    // The same partner claiming at 67 is paid nothing at month 36; their benefit begins two
    // years later, at month 60. Hardcoded ages put every partner's benefit in the same
    // calendar month whoever they were.
    expect(incomeAt(67, 36)).toBe(0);
    expect(incomeAt(67, 59)).toBe(0);
    expect(incomeAt(67, 60)).toBe(dollarsToCents(1_000));
  });

  it("stops a partner's open-ended job at THEIR retirement age", () => {
    // Born 1958, retiring at 65 → last paid year 2022, so month 36 (2023) pays nothing
    // while month 35 still does.
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

describe("SeparationEvent", () => {
  it("ends partner income streams from separation month", () => {
    // A partner's income is their job, authored on the RelationshipEvent; anchoring to a
    // 2020 "now" compiles the calendar-year job into forward income.
    const cfg: LedgerBaseConfig = {
      ...baseConfig,
      startYear: 2020,
      initialAccounts: [makeLiquidAccount()],
    };
    const partner: Person = {
      ...personLit("p2", "Bob"),
      jobs: [
        {
          id: "pj1",
          ownerId: "p2",
          startYear: 2020,
          endYear: null,
          salary: { startingSalaryCents: dollarsToCents(24_000), realGrowthPct: 0 }, // $2,000/mo
        },
      ],
    };
    let ledger = emptyLedger;
    // Add partner carrying the $2,000/mo job.
    ledger = add(ledger, {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: partner,
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
    // Processed months 0–5: $2000 × 6 = $12,000; months 6–11: $0 (income ends at separation).
    expect(series.months[11].netWorthNominalCents).toBe(dollarsToCents(12_000));
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
    // Alimony is keyed to absolute months 1–6 (starts at the month-1 separation, duration 6):
    // 6 × $1000 = $6000 expense → $14,000 remaining. Final state is month index 11.
    expect(series.months[11].netWorthNominalCents).toBe(dollarsToCents(14_000));
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
    // Child support runs from the month-0 separation across all 12 processed months (0..11):
    // 12 × $1000 = $12,000 → $0 remaining
    expect(series.months[11].netWorthNominalCents).toBe(0);
  });
});

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
    // Replay doesn't crash; the child entity is tracked internally.
    const series = replayLedger(ledger, baseConfig, nullJurisdiction);
    expect(series.months.length).toBe(12);
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
    // $1,000/mo drains the $12,000 opening across all 12 processed months (0..11) → $0.
    expect(series.months[11].netWorthNominalCents).toBe(0);

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
