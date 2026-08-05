import { describe, it, expect } from "vitest";
import { emptyLedger, type Ledger } from "../ledger/ledger";
import { addEvent } from "../ledger/addEvent";
import { snapshotAt, buildSnapshot } from "./snapshot";
import { replayLedger, buildProjection } from "./buildHouseholdInput";
import { interpretLedger } from "../ledger/interpret";
import type { LedgerBaseConfig } from "../ledger/ledgerBase";
import type { NewLifeEvent } from "../ledger/eventTypes";
import { dollarsToCents, SimCashFlowSeries } from "../money/cashFlowSeries";
import { CAPITAL_GAINS_TAX_PROFILE } from "../plan/simAccount";
import { SYNTHETIC_CARD_ID } from "../liability/liability";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import type { Person } from "../plan/person";
import { planAccount, type PlanAccount } from "../plan/planAccount";
import type { PersonId } from "../job/job";

const personLit = (id: string, name: string): Person => ({
  id,
  name,
  birthYear: 1990,
  benefitClaimingAge: 67,
  jobs: [],
});

const primary = [personLit("p1", "Alex")];
// Validation base for fixtures — carries a liquid account so DebtPayoff fixtures (which
// need one to draw from) pass. Validates fixture events only; each test still
// snapshots/replays against its own base.
const addBase: LedgerBaseConfig = {
  horizonMonths: 360,
  annualInflationRate: 0,
  initialPersons: primary,
  initialAccounts: [
    planAccount({
      id: "checking",
      owners: ["p1" as PersonId],
      liquid: true,
      taxProfile: CAPITAL_GAINS_TAX_PROFILE,
      balanceCents: 0,
      initialAnnualRate: 0,
    }),
  ],
};

/** Append a fixture event, asserting it passes validation. */
function add(ledger: Ledger, event: NewLifeEvent): Ledger {
  const result = addEvent(ledger, addBase, event);
  if (!result.ok) throw new Error(`fixture event rejected: ${result.conflict}`);
  return result.ledger;
}

describe("snapshotAt — active entities as of a month (end-of-month convention)", () => {
  it("empty ledger shows only the initial persons; no projection means no balances", () => {
    const snap = snapshotAt(emptyLedger, 0, { initialPersons: primary });
    expect(snap.persons.map((p) => p.id)).toEqual(["p1"]);
    expect(snap.children).toHaveLength(0);
    expect(snap.balances).toBeNull();
  });

  it("a partner is present from the marriage month (end-of-month)", () => {
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "r1",
      type: "RelationshipEvent",
      month: 36,
      person: personLit("p2", "Sam"),
    });
    expect(snapshotAt(ledger, 35, { initialPersons: primary }).persons.map((p) => p.id)).toEqual(["p1"]);
    // The month you marry shows you married.
    expect(snapshotAt(ledger, 36, { initialPersons: primary }).persons.map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("a separated partner is gone from the separation month", () => {
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "r1",
      type: "RelationshipEvent",
      month: 12,
      person: personLit("p2", "Sam"),
    });
    ledger = add(ledger, {
      id: "sep1",
      type: "SeparationEvent",
      month: 60,
      partnerPersonId: "p2",
      alimonyMonthlyCents: 0,
      alimonyDurationMonths: 0,
      childSupportMonthlyCents: 0,
    });
    expect(snapshotAt(ledger, 59, { initialPersons: primary }).persons.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(snapshotAt(ledger, 60, { initialPersons: primary }).persons.map((p) => p.id)).toEqual(["p1"]);
  });

  it("children appear at birth month and carry their age", () => {
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "c1",
      type: "ChildEvent",
      month: 24,
      childId: "kid1",
      childName: "Robin",
      birthMonth: 24,
      annualCostCents: 0,
    });
    expect(snapshotAt(ledger, 23, { initialPersons: primary }).children).toHaveLength(0);
    const snap = snapshotAt(ledger, 48, { initialPersons: primary });
    expect(snap.children).toHaveLength(1);
    expect(snap.children[0].ageMonths).toBe(24);
  });

  it("a partner's own job income appears in the snapshot while they are a member", () => {
    // Snapshot and projection read the SAME household, so a partner's job income must
    // surface in the cross-section exactly as it drives net worth.
    const base: LedgerBaseConfig = {
      horizonMonths: 360,
      annualInflationRate: 0,
      startYear: 2020,
      initialPersons: primary,
    };
    const partner: Person = {
      ...personLit("p2", "Sam"),
      jobs: [
        {
          id: "pj1",
          ownerId: "p2",
          startYear: 2020,
          endYear: 2090,
          salary: { startingSalaryCents: dollarsToCents(60_000), currentSalaryCents: dollarsToCents(60_000), realGrowthPct: 0 },
        },
      ],
    };
    const ledger = add(emptyLedger, { id: "r1", type: "RelationshipEvent", month: 36, person: partner });
    // Snapshot from the SAME household the projection reads (the app's path: interpretLedger
    // + buildSnapshot), so the calendar "now" (startYear) is honoured.
    const household = interpretLedger(ledger, base);
    const incomeAt = (m: number) =>
      buildSnapshot(household, m).income.filter((s) => s.ownerId === "p2");
    // Before the partner joins (month 35): no partner income in the snapshot.
    expect(incomeAt(35)).toHaveLength(0);
    // While a member (month 48): the partner's $60k/yr job shows as $5,000/mo income.
    const partnerIncome = incomeAt(48);
    expect(partnerIncome).toHaveLength(1);
    expect(partnerIncome[0].monthlyCents).toBe(dollarsToCents(5_000));
  });

  it("separation ends the departing partner's income and starts alimony", () => {
    // The partner's income is their job (authored on the RelationshipEvent); a 2020 "now"
    // compiles the calendar-year job into forward income, so buildSnapshot — not snapshotAt,
    // which carries no calendar — reads the same household the projection does.
    const base: LedgerBaseConfig = {
      horizonMonths: 360,
      annualInflationRate: 0,
      startYear: 2020,
      initialPersons: primary,
    };
    const partner: Person = {
      ...personLit("p2", "Sam"),
      jobs: [
        {
          id: "pj1",
          ownerId: "p2",
          startYear: 2020,
          endYear: 2090,
          salary: { startingSalaryCents: dollarsToCents(48_000), currentSalaryCents: dollarsToCents(48_000), realGrowthPct: 0 }, // $4,000/mo
        },
      ],
    };
    let ledger = emptyLedger;
    ledger = add(ledger, { id: "r1", type: "RelationshipEvent", month: 0, person: partner });
    ledger = add(ledger, {
      id: "sep1",
      type: "SeparationEvent",
      month: 36,
      partnerPersonId: "p2",
      alimonyMonthlyCents: dollarsToCents(500),
      alimonyDurationMonths: 12,
      childSupportMonthlyCents: 0,
    });
    const household = interpretLedger(ledger, base);
    // Before separation the partner's job income is in the cross-section; at separation it stops.
    expect(buildSnapshot(household, 35).income.filter((s) => s.ownerId === "p2")).toHaveLength(1);
    const after = buildSnapshot(household, 36);
    expect(after.income.filter((s) => s.ownerId === "p2")).toHaveLength(0);
    // Alimony expense is now active, and expires with its duration.
    const alimony = after.expenses.find((s) => s.id === "sep1:alimony");
    expect(alimony?.role).toBe("alimony");
    expect(alimony?.monthlyCents).toBe(dollarsToCents(500));
    expect(buildSnapshot(household, 48).expenses).toHaveLength(0);
  });

  it("a loan is present from its origination month", () => {
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "loan1",
      type: "LoanEvent",
      month: 12,
      liabilityId: "car",
      ownerId: "p1",
      kind: "auto",
      openingBalanceCents: dollarsToCents(30_000),
      apr: 0.06,
      termMonths: 60,
    });
    expect(snapshotAt(ledger, 11, { initialPersons: primary }).liabilities).toHaveLength(0);
    expect(snapshotAt(ledger, 12, { initialPersons: primary }).liabilities.map((l) => l.id)).toEqual(["car"]);
  });

  it("reads balances (stocks) from a supplied projection", () => {
    const opening = dollarsToCents(10_000);
    const base: LedgerBaseConfig = {
      horizonMonths: 24,
      annualInflationRate: 0,
      initialPersons: primary,
      initialAccounts: [
        planAccount({
          id: "savings",
          owners: ["p1" as PersonId],
          liquid: true,
          taxProfile: CAPITAL_GAINS_TAX_PROFILE,
          balanceCents: opening,
          initialAnnualRate: 0,
        }),
      ],
    };
    const projection = replayLedger(emptyLedger, base, nullJurisdiction);

    const snap = snapshotAt(emptyLedger, 12, { initialPersons: primary, projection });
    expect(snap.balances?.accounts).toEqual([{ id: "savings", balanceCents: opening }]);
    // Balances mirror the projection month exactly — including the shortfall cascade's
    // synthetic credit card, present at $0 until drawn on.
    expect(snap.balances?.liabilities).toEqual([
      { id: SYNTHETIC_CARD_ID, balanceCents: 0 },
    ]);
    expect(snap.balances?.netWorthNominalCents).toBe(opening);
    expect(snap.balances?.isInsolvent).toBe(false);

    // Months beyond the projection horizon clamp to the last simulated month.
    const past = snapshotAt(emptyLedger, 999, { initialPersons: primary, projection });
    expect(past.balances?.netWorthNominalCents).toBe(opening);
  });

  it("reports the grown monthly rate at the snapshot month, not the baseline", () => {
    // A base income series compounding 10% a year — the value-editing surface, read straight
    // by the snapshot with no projection needed.
    const income = new SimCashFlowSeries(
      0,
      dollarsToCents(5_000),
      { type: "salaryCompound", annualRate: 0.1 },
      { baselineUnit: "monthly" },
    );
    const base: LedgerBaseConfig = {
      horizonMonths: 24,
      annualInflationRate: 0,
      initialPersons: primary,
      initialIncomeSeries: [{ series: income, ownerId: "p1" }],
    };
    const household = interpretLedger(emptyLedger, base);
    const monthly = dollarsToCents(5_000);
    expect(buildSnapshot(household, 0).income[0].monthlyCents).toBe(monthly);
    // One full growth cycle later the rate has compounded by 10%.
    expect(buildSnapshot(household, 12).income[0].monthlyCents).toBe(Math.round(monthly * 1.1));
  });
});

// One replay-derived model feeds both snapshot and projection

describe("buildSnapshot — the shared replay-derived model", () => {
  function liquid(id = "checking", openingCents = 0): PlanAccount {
    return planAccount({
      id,
      owners: ["p1" as PersonId],
      liquid: true,
      taxProfile: CAPITAL_GAINS_TAX_PROFILE,
      balanceCents: openingCents,
      initialAnnualRate: 0,
    });
  }
  function monthly(cents: number): SimCashFlowSeries {
    return new SimCashFlowSeries(0, cents, { type: "fixed" }, { baselineUnit: "monthly" });
  }

  it("base income/expense drive the projection AND appear as role 'base' in the snapshot", () => {
    const base: LedgerBaseConfig = {
      horizonMonths: 12,
      annualInflationRate: 0,
      initialPersons: primary,
      initialAccounts: [liquid()],
      initialIncomeSeries: [{ series: monthly(dollarsToCents(4_000)), ownerId: "p1" }],
      initialExpenseSeries: [{ series: monthly(dollarsToCents(1_000)), ownerId: "p1" }],
    };
    const household = interpretLedger(emptyLedger, base);
    const projection = buildProjection(household, base, nullJurisdiction);
    // 12 processed flow-months (months[11] is the last of the 12-month horizon): $3,000/mo net.
    expect(projection.months[11].netWorthNominalCents).toBe(dollarsToCents(36_000));

    const snap = buildSnapshot(household, 3, projection);
    expect(snap.income.find((s) => s.role === "base")?.monthlyCents).toBe(dollarsToCents(4_000));
    expect(snap.expenses.find((s) => s.role === "base")?.monthlyCents).toBe(dollarsToCents(1_000));
  });

  it("snapshot flows reconcile with the projection's month-over-month net worth", () => {
    const base: LedgerBaseConfig = {
      horizonMonths: 12,
      annualInflationRate: 0,
      initialPersons: primary,
      initialAccounts: [liquid()], // 0% rate → net-worth delta equals net flow
      initialIncomeSeries: [{ series: monthly(dollarsToCents(4_000)), ownerId: "p1" }],
      initialExpenseSeries: [{ series: monthly(dollarsToCents(1_000)), ownerId: "p1" }],
    };
    const household = interpretLedger(emptyLedger, base);
    const projection = buildProjection(household, base, nullJurisdiction);
    const snap = buildSnapshot(household, 3, projection);

    const snapFlow =
      snap.income.reduce((a, s) => a + s.monthlyCents, 0) -
      snap.expenses.reduce((a, s) => a + s.monthlyCents, 0);
    const projFlow =
      projection.months[3].netWorthNominalCents! - projection.months[2].netWorthNominalCents!;
    expect(snapFlow).toBe(projFlow);
    // Balances read straight from the same projection month.
    expect(snap.balances?.netWorthNominalCents).toBe(projection.months[3].netWorthNominalCents);
  });

  it("clamps presence, balances, and the returned month to the horizon", () => {
    const base: LedgerBaseConfig = {
      horizonMonths: 24,
      annualInflationRate: 0,
      initialPersons: primary,
      initialAccounts: [liquid("savings", dollarsToCents(5_000))],
    };
    // Partner joins beyond the horizon — must not appear at the clamped month.
    const ledger = add(emptyLedger, {
      id: "r1", type: "RelationshipEvent", month: 30, person: personLit("p2", "Sam"),
    });
    const projection = replayLedger(ledger, base, nullJurisdiction);
    const household = interpretLedger(ledger, base);
    const snap = buildSnapshot(household, 999, projection);

    expect(snap.month).toBe(23); // clamped to the last simulated month (horizonMonths-1 = 23)
    expect(snap.persons.map((p) => p.id)).toEqual(["p1"]); // p2 (month 30) not present at 23
    expect(snap.balances?.netWorthNominalCents).toBe(dollarsToCents(5_000)); // months[23]: no flows, opening $5,000 unchanged
  });

  it("a paid-off liability disappears from active snapshots", () => {
    const base: LedgerBaseConfig = {
      horizonMonths: 12,
      annualInflationRate: 0,
      initialPersons: primary,
      initialAccounts: [liquid("checking", dollarsToCents(20_000))],
    };
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "loan1", type: "LoanEvent", month: 0, liabilityId: "car", ownerId: "p1",
      kind: "auto", openingBalanceCents: dollarsToCents(5_000), apr: 0, termMonths: 120,
    });
    ledger = add(ledger, {
      id: "payoff1", type: "DebtPayoffEvent", month: 3, liabilityId: "car",
      accountId: "checking", amountCents: dollarsToCents(5_000),
    });
    const household = interpretLedger(ledger, base);
    const projection = buildProjection(household, base, nullJurisdiction);

    expect(buildSnapshot(household, 1, projection).liabilities.map((l) => l.id)).toContain("car");
    expect(buildSnapshot(household, 6, projection).liabilities.find((l) => l.id === "car")).toBeUndefined();
  });
});

// Properties (equity = value − mortgage)

const PROPERTY_PRICE = 30_000_000; // $300k
const PROPERTY_DOWN = 6_000_000; // $60k
const PROPERTY_FINANCED = PROPERTY_PRICE - PROPERTY_DOWN; // $240k

function propertyBase(openingCents: number): LedgerBaseConfig {
  return {
    horizonMonths: 24,
    annualInflationRate: 0,
    initialPersons: primary,
    initialAccounts: [
      planAccount({
        id: "savings",
        owners: ["p1" as PersonId],
        liquid: true,
        taxProfile: CAPITAL_GAINS_TAX_PROFILE,
        balanceCents: openingCents,
        initialAnnualRate: 0,
      }),
    ],
  };
}

/** A financed purchase — one event carrying the mortgage inline, from which the handler derives
 * the securing `house1-mortgage` liability. */
function purchaseFixture(): NewLifeEvent {
  return {
    id: "buy1",
    type: "HomePurchaseEvent",
    month: 3,
    propertyId: "house1",
    ownerId: "p1",
    purchasePriceCents: PROPERTY_PRICE,
    downPaymentCents: PROPERTY_DOWN,
    downPaymentSourceIds: ["savings"],
    mortgage: { openingBalanceCents: PROPERTY_FINANCED, apr: 0, termMonths: 360 },
  } as NewLifeEvent;
}

function addPurchase(base: LedgerBaseConfig): Ledger {
  const r = addEvent(emptyLedger, base, purchaseFixture());
  if (!r.ok) throw new Error(`event rejected: ${r.conflict}`);
  return r.ledger;
}

describe("buildSnapshot — properties", () => {
  it("reports the property with equity = value − mortgage", () => {
    const base = propertyBase(10_000_000);
    const household = interpretLedger(addPurchase(base), base);
    const series = buildProjection(household, base, nullJurisdiction);
    const snap = buildSnapshot(household, 3, series);

    expect(snap.properties).toHaveLength(1);
    expect(snap.properties[0].valueCents).toBe(PROPERTY_PRICE);
    expect(snap.properties[0].mortgageBalanceCents).toBe(PROPERTY_FINANCED);
    expect(snap.properties[0].equityCents).toBe(PROPERTY_DOWN);
  });

  it("does not report a property before its purchase month", () => {
    const base = propertyBase(10_000_000);
    const household = interpretLedger(addPurchase(base), base);
    const series = buildProjection(household, base, nullJurisdiction);
    expect(buildSnapshot(household, 2, series).properties).toHaveLength(0);
  });
});
