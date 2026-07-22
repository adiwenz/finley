import { describe, it, expect } from "vitest";
import {
  emptyLedger,
  addEvent,
  snapshotAt,
  replayLedger,
  interpretLedger,
  buildProjection,
  buildSnapshot,
  type Ledger,
  type LedgerBaseConfig,
  type NewLifeEvent,
} from "./index";
import { dollarsToCents, SimCashFlowSeries } from "./cashFlowSeries";
import { SimAccount, CAPITAL_GAINS_TAX_PROFILE } from "./simAccount";
import { SYNTHETIC_CARD_ID } from "./liability";
import { nullJurisdiction } from "./jurisdiction";

const primary = [{ id: "p1", name: "Alex" }];
// Validation base for fixtures — includes a liquid account so DebtPayoff
// fixtures (which require an account to draw from) pass. Used only to validate
// fixture events; each test still snapshots/replays against its own base.
const addBase: LedgerBaseConfig = {
  horizonMonths: 360,
  annualInflationRate: 0,
  initialPersons: primary,
  initialAccounts: [
    new SimAccount({
      id: "checking",
      ownerId: "p1",
      liquid: true,
      taxProfile: CAPITAL_GAINS_TAX_PROFILE,
      openingBalanceCents: 0,
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
      person: { id: "p2", name: "Sam" },
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
      person: { id: "p2", name: "Sam" },
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

  it("income from a job is active from its start and ends when replaced", () => {
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "j1",
      type: "JobChangeEvent",
      month: 0,
      seriesId: "s1",
      ownerId: "p1",
      annualIncomeCents: dollarsToCents(36_000),
      growthMode: { type: "fixed" },
      taxCategory: "wages",
    });
    ledger = add(ledger, {
      id: "j2",
      type: "JobChangeEvent",
      month: 24,
      seriesId: "s2",
      ownerId: "p1",
      annualIncomeCents: dollarsToCents(60_000),
      growthMode: { type: "fixed" },
      taxCategory: "wages",
      replacesSeriesId: "s1",
    });
    // At month 12 the first job is the active income.
    const early = snapshotAt(ledger, 12, { initialPersons: primary });
    expect(early.income.map((s) => s.id)).toEqual(["s1"]);
    expect(early.income[0].role).toBe("primaryIncome");
    // At month 24 the replacement is active; the old one ended at month 23.
    const later = snapshotAt(ledger, 24, { initialPersons: primary });
    expect(later.income.map((s) => s.id)).toEqual(["s2"]);
  });

  it("separation ends the departing partner's income and starts alimony", () => {
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: { id: "p2", name: "Sam" },
    });
    ledger = add(ledger, {
      id: "j2",
      type: "JobChangeEvent",
      month: 0,
      causedByEventId: "r1",
      seriesId: "s2",
      ownerId: "p2",
      annualIncomeCents: dollarsToCents(48_000),
      growthMode: { type: "fixed" },
      taxCategory: "wages",
    });
    ledger = add(ledger, {
      id: "sep1",
      type: "SeparationEvent",
      month: 36,
      partnerPersonId: "p2",
      alimonyMonthlyCents: dollarsToCents(500),
      alimonyDurationMonths: 12,
      childSupportMonthlyCents: 0,
    });
    expect(snapshotAt(ledger, 35, { initialPersons: primary }).income.map((s) => s.id)).toEqual(["s2"]);
    const after = snapshotAt(ledger, 36, { initialPersons: primary });
    expect(after.income).toHaveLength(0);
    // Alimony expense is now active, and expires with its duration.
    const alimony = after.expenses.find((s) => s.id === "sep1:alimony");
    expect(alimony?.role).toBe("alimony");
    expect(alimony?.monthlyCents).toBe(dollarsToCents(500));
    expect(snapshotAt(ledger, 48, { initialPersons: primary }).expenses).toHaveLength(0);
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
        new SimAccount({
          id: "savings",
          ownerId: "p1",
          liquid: true,
          taxProfile: CAPITAL_GAINS_TAX_PROFILE,
          openingBalanceCents: opening,
          initialAnnualRate: 0,
        }),
      ],
    };
    const projection = replayLedger(emptyLedger, base, nullJurisdiction);

    const snap = snapshotAt(emptyLedger, 12, { initialPersons: primary, projection });
    expect(snap.balances?.accounts).toEqual([{ id: "savings", balanceCents: opening }]);
    // Balances mirror the projection month exactly — including the shortfall
    // cascade's synthetic credit card, present at $0 until drawn on.
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
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "j1",
      type: "JobChangeEvent",
      month: 0,
      seriesId: "s1",
      ownerId: "p1",
      annualIncomeCents: dollarsToCents(60_000),
      growthMode: { type: "salaryCompound", annualRate: 0.1 },
      taxCategory: "wages",
    });
    const monthly = dollarsToCents(5_000);
    expect(snapshotAt(ledger, 0, { initialPersons: primary }).income[0].monthlyCents).toBe(monthly);
    // One full growth cycle later the rate has compounded by 10%.
    expect(snapshotAt(ledger, 12, { initialPersons: primary }).income[0].monthlyCents).toBe(
      Math.round(monthly * 1.1),
    );
  });
});

// ─── One replay-derived model feeds both snapshot and projection ──────────────

describe("buildSnapshot — the shared replay-derived model (§1, §2, §14, §16)", () => {
  function liquid(id = "checking", openingCents = 0): SimAccount {
    return new SimAccount({
      id,
      ownerId: "p1",
      liquid: true,
      taxProfile: CAPITAL_GAINS_TAX_PROFILE,
      openingBalanceCents: openingCents,
      initialAnnualRate: 0,
    });
  }
  function monthly(cents: number): SimCashFlowSeries {
    return new SimCashFlowSeries(0, cents, { type: "fixed" }, { baselineUnit: "monthly" });
  }

  it("base income/expense drive the projection AND appear as role 'base' in the snapshot (§2)", () => {
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
    expect(projection.months[12].netWorthNominalCents).toBe(dollarsToCents(36_000));

    const snap = buildSnapshot(household, 3, projection);
    expect(snap.income.find((s) => s.role === "base")?.monthlyCents).toBe(dollarsToCents(4_000));
    expect(snap.expenses.find((s) => s.role === "base")?.monthlyCents).toBe(dollarsToCents(1_000));
  });

  it("snapshot flows reconcile with the projection's month-over-month net worth (§14)", () => {
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

  it("clamps presence, balances, and the returned month to the horizon (§2)", () => {
    const base: LedgerBaseConfig = {
      horizonMonths: 24,
      annualInflationRate: 0,
      initialPersons: primary,
      initialAccounts: [liquid("savings", dollarsToCents(5_000))],
    };
    // Partner joins beyond the horizon — must not appear at the clamped month.
    const ledger = add(emptyLedger, {
      id: "r1", type: "RelationshipEvent", month: 30, person: { id: "p2", name: "Sam" },
    });
    const projection = replayLedger(ledger, base, nullJurisdiction);
    const household = interpretLedger(ledger, base);
    const snap = buildSnapshot(household, 999, projection);

    expect(snap.month).toBe(24); // clamped to last simulated month
    expect(snap.persons.map((p) => p.id)).toEqual(["p1"]); // p2 (month 30) not present at 24
    expect(snap.balances?.netWorthNominalCents).toBe(dollarsToCents(5_000)); // months[24]
  });

  it("a paid-off liability disappears from active snapshots (§16)", () => {
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

// ─── Properties (equity = value − mortgage, §4.1) ─────────────────────────────

const PROPERTY_PRICE = 30_000_000; // $300k
const PROPERTY_DOWN = 6_000_000; // $60k
const PROPERTY_FINANCED = PROPERTY_PRICE - PROPERTY_DOWN; // $240k

function propertyBase(openingCents: number): LedgerBaseConfig {
  return {
    horizonMonths: 24,
    annualInflationRate: 0,
    initialPersons: primary,
    initialAccounts: [
      new SimAccount({
        id: "savings",
        ownerId: "p1",
        liquid: true,
        taxProfile: CAPITAL_GAINS_TAX_PROFILE,
        openingBalanceCents: openingCents,
        initialAnnualRate: 0,
      }),
    ],
  };
}

function purchaseFixture(): NewLifeEvent {
  return {
    id: "buy1",
    type: "HomePurchaseEvent",
    month: 3,
    propertyId: "house1",
    ownerId: "p1",
    purchasePriceCents: PROPERTY_PRICE,
    downPaymentCents: PROPERTY_DOWN,
    downPaymentAccountId: "savings",
    mortgageLiabilityId: "mtg1",
    mortgageApr: 0,
    mortgageTermMonths: 360,
  } as NewLifeEvent;
}

describe("buildSnapshot — properties", () => {
  it("reports the property with equity = value − mortgage", () => {
    const base = propertyBase(10_000_000);
    const ledger = addEvent(emptyLedger, base, purchaseFixture());
    if (!ledger.ok) throw new Error(`event rejected: ${ledger.conflict}`);
    const household = interpretLedger(ledger.ledger, base);
    const series = buildProjection(household, base, nullJurisdiction);
    const snap = buildSnapshot(household, 3, series);

    expect(snap.properties).toHaveLength(1);
    expect(snap.properties[0].valueCents).toBe(PROPERTY_PRICE);
    expect(snap.properties[0].mortgageBalanceCents).toBe(PROPERTY_FINANCED);
    expect(snap.properties[0].equityCents).toBe(PROPERTY_DOWN);
  });

  it("does not report a property before its purchase month", () => {
    const base = propertyBase(10_000_000);
    const ledger = addEvent(emptyLedger, base, purchaseFixture());
    if (!ledger.ok) throw new Error(`event rejected: ${ledger.conflict}`);
    const household = interpretLedger(ledger.ledger, base);
    const series = buildProjection(household, base, nullJurisdiction);
    expect(buildSnapshot(household, 2, series).properties).toHaveLength(0);
  });
});
