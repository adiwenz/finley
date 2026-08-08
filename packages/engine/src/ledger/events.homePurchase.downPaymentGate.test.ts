/**
 * **The §4.5 affordability gate — whether a purchase may be authored at all.**
 *
 * Authoring is refused when the selected sources cannot cover the down payment, and the refusal
 * has to name the buckets it counted. What counts is every LIQUID source the buyer selected,
 * including a goal held as cash; what it is sized against is the down payment PLUS the tax
 * liquidating it would realize.
 *
 * The load-bearing invariant is **gate == sim**: the gate prices a candidate over the same base
 * the simulator will resolve it against — after explicit draws, before automatic decumulation —
 * so it blocks exactly when the sim would fall short and never wider. A gate that read a
 * different base would refuse purchases the simulator funds in full.
 *
 * Where the money actually comes out is `events.homePurchase.downPaymentDraw.test.ts`; the
 * event's own lifecycle is `events.homePurchase.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { emptyLedger } from "./ledger";
import { addEvent, fundingLookup } from "./addEvent";
import { interpretLedger } from "./interpret";
import { buildProjection } from "../projection/buildHouseholdInput";
import type { LedgerBaseConfig } from "./ledgerBase";
import type { NewLifeEvent } from "./eventTypes";
import { CAPITAL_GAINS_TAX_PROFILE } from "../plan/simAccount";
import { SimCashFlowSeries, dollarsToCents } from "../money/cashFlowSeries";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import { personLit } from "./events.testSupport";
import { planAccount, type PlanAccount } from "../plan/planAccount";
import type { PersonId } from "../job/job";
import {
  DOWN,
  PRICE,
  addWithBase,
  baseWith,
  baseWithAccounts,
  bracketedCapitalGains,
  flatCapitalGains,
  liquidAcct,
  purchase,
  savings,
} from "./events.homePurchase.testUtils";

describe("HomePurchaseEvent — down-payment hard block", () => {
  it("blocks the purchase when liquid funds cannot cover the down payment", () => {
    const base = baseWith(5_000_000); // $50k < $60k down
    const result = addEvent(emptyLedger, base, purchase({ month: 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflict).toMatch(/down payment/);
  });

  it("allows the purchase when liquid funds cover the down payment", () => {
    const base = baseWith(6_000_000); // exactly $60k
    const result = addEvent(emptyLedger, base, purchase({ month: 1 }));
    expect(result.ok).toBe(true);
  });

  it("hard-blocks on any shortfall — one cent short still fails the gate", () => {
    const base = baseWith(DOWN - 1);
    const result = addEvent(emptyLedger, base, purchase({ month: 1 }));
    expect(result.ok).toBe(false);
  });

  it("quotes dollars, not raw cents, and says why other balances don't count", () => {
    const base = baseWith(5_000_000);
    const result = addEvent(emptyLedger, base, purchase({ month: 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toContain("$60,000");
      expect(result.conflict).toContain("$50,000");
      expect(result.conflict).not.toMatch(/¢|\d{7}/);
      expect(result.conflict).toMatch(/goal funds|retirement|brokerage/);
    }
  });

  it("never counts credit as a down-payment source", () => {
    const base = baseWith(5_000_000);
    // Credit is not liquid.
    const withCard = addWithBase(emptyLedger, base, {
      id: "card",
      type: "LoanEvent",
      month: 0,
      liabilityId: "cc1",
      ownerId: "p1",
      kind: "creditCard",
      openingBalanceCents: 0,
      apr: 0.2,
      creditLimitCents: 50_000_000,
    } as NewLifeEvent);
    const result = addEvent(withCard, base, purchase({ month: 1 }));
    expect(result.ok).toBe(false);
  });
});

// §4.5 gate: a goal held as cash lands in a liquid account, so the gate counts it and the
// block message must name the buckets it counted.

function goalFund(id: string, label: string, openingCents: number, liquid: boolean): PlanAccount {
  return planAccount({
    id,
    owners: ["p1" as PersonId],
    label,
    liquid,
    taxProfile: CAPITAL_GAINS_TAX_PROFILE,
    balanceCents: openingCents,
    initialAnnualRate: 0,
  });
}

function baseWithGoalFund(
  savingsCents: number,
  goal: { label: string; cents: number; liquid: boolean },
): LedgerBaseConfig {
  return {
    horizonMonths: 24,
    annualInflationRate: 0,
    initialPersons: [personLit("p1", "Alice")],
    initialAccounts: [savings(savingsCents), goalFund("goal-emergency", goal.label, goal.cents, goal.liquid)],
  };
}

const BOTH_SOURCES = ["savings", "goal-emergency"];

describe("HomePurchaseEvent — §4.5 gate counts selected liquid goal funds", () => {
  it("lets a selected liquid emergency reserve cover the gap savings alone cannot", () => {
    // $30k savings + $40k cash emergency fund = $70k liquid ≥ $60k down, both selected.
    const base = baseWithGoalFund(3_000_000, {
      label: "Emergency fund",
      cents: 4_000_000,
      liquid: true,
    });
    const result = addEvent(emptyLedger, base, purchase({ month: 1, downPaymentSourceIds: BOTH_SOURCES }));
    expect(result.ok).toBe(true);
  });

  it("names the selected goal buckets it counted when the gate still blocks", () => {
    // $30k savings + $20k cash emergency fund = $50k liquid < $60k down.
    const base = baseWithGoalFund(3_000_000, {
      label: "Emergency fund",
      cents: 2_000_000,
      liquid: true,
    });
    const result = addEvent(emptyLedger, base, purchase({ month: 1, downPaymentSourceIds: BOTH_SOURCES }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toContain("Emergency fund");
      expect(result.conflict).toContain("$50,000"); // the counted selected total
    }
  });

  it("still excludes an illiquid goal fund even when it is selected", () => {
    // The illiquid fund contributes 0: only $30k of the selected $70k counts.
    const base = baseWithGoalFund(3_000_000, {
      label: "Retirement top-up",
      cents: 4_000_000,
      liquid: false,
    });
    const result = addEvent(emptyLedger, base, purchase({ month: 1, downPaymentSourceIds: BOTH_SOURCES }));
    expect(result.ok).toBe(false);
  });

  it("falls back to the account id when a counted bucket has an empty label", () => {
    // $30k + $15k = $45k < $60k, so the gate blocks and lists both.
    const base = baseWithGoalFund(3_000_000, { label: "", cents: 1_500_000, liquid: true });
    const result = addEvent(emptyLedger, base, purchase({ month: 1, downPaymentSourceIds: BOTH_SOURCES }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toContain("goal-emergency ($15,000)");
      expect(result.conflict).not.toContain("()");
    }
  });

  it("states a total that equals the sum of the buckets it lists", () => {
    // $30k + $15k = $45k: the stated total derives from the buckets it itemises.
    const base = baseWithGoalFund(3_000_000, {
      label: "Emergency fund",
      cents: 1_500_000,
      liquid: true,
    });
    const result = addEvent(emptyLedger, base, purchase({ month: 1, downPaymentSourceIds: BOTH_SOURCES }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toContain("$45,000"); // the stated total
      expect(result.conflict).toContain("savings ($30,000)");
      expect(result.conflict).toContain("Emergency fund ($15,000)");
    }
  });
});

describe("HomePurchaseEvent — §4.5 gate sizes on down payment + tax", () => {
  it("blocks when a selected investment source covers the down payment but not the tax on it", () => {
    // $50k basis grown 24 months at 10%/yr clears $60k pre-tax; the tax on the gain does not.
    const base = baseWithAccounts([liquidAcct("brokerage", 5_000_000, 0.1)]);
    // Allowed with no tax: the block is the tax, not insufficiency.
    const allowed = addEvent(
      emptyLedger,
      base,
      purchase({ month: 24, downPaymentSourceIds: ["brokerage"] }),
      nullJurisdiction,
    );
    expect(allowed.ok).toBe(true);

    const blocked = addEvent(
      emptyLedger,
      base,
      purchase({ month: 24, downPaymentSourceIds: ["brokerage"] }),
      flatCapitalGains(0.2),
    );
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.conflict).toMatch(/tax/i);
  });

  it("prices the gain MARGINALLY over the owner's other income, not standalone", () => {
    // Same brokerage, same down payment: affordable with no other income, unaffordable once a
    // wage pushes the gain into the taxed band. Only a gate reading the owner's other income
    // can tell these apart.
    const wage = new SimCashFlowSeries(0, dollarsToCents(15_000), { type: "fixed" }, { baselineUnit: "monthly" });
    const accounts = () => [liquidAcct("savings", 0), liquidAcct("brokerage", 5_000_000, 0.1)];
    const jur = bracketedCapitalGains(dollarsToCents(15_000), 0.4); // $15k/mo threshold, 40% above

    const withoutWage: LedgerBaseConfig = {
      horizonMonths: 24,
      annualInflationRate: 0,
      initialPersons: [personLit("p1", "Alice")],
      initialAccounts: accounts(),
    };
    const withWage: LedgerBaseConfig = {
      ...withoutWage,
      initialAccounts: accounts(),
      initialIncomeSeries: [{ series: wage, ownerId: "p1" }],
    };
    const buy = purchase({ month: 24, downPaymentSourceIds: ["brokerage"] });

    // No other income: the ~$10k gain sits below the $15k threshold → untaxed → affordable.
    expect(addEvent(emptyLedger, withoutWage, buy, jur).ok).toBe(true);
    // The wage stacks the gain above the threshold → taxed → proceeds no longer cover it.
    const blocked = addEvent(emptyLedger, withWage, buy, jur);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.conflict).toMatch(/tax/i);
  });
});

// §4.5 gate, sibling draws: the sim threads one working base across a month's draws, stacking
// the first's realized gain under the second. The gate must price a candidate over that stacked
// base, not the pre-funding one.

describe("HomePurchaseEvent — §4.5 gate stacks a sibling draw in the same month", () => {
  // Each brokerage: $50k basis grown 24 months at 10%/yr → ~$60,021, a ~$10,021 gain. Alone it
  // sits under the $15k threshold, untaxed, exactly covering the $60,000 down payment. Purchase
  // at month 23: months[23] holds those 24 flow-months of growth now that month 0 is processed.
  const jurisdiction = () => bracketedCapitalGains(dollarsToCents(15_000), 0.4);
  const twoBrokerages = () =>
    baseWithAccounts([
      liquidAcct("brokerage-a", 5_000_000, 0.1),
      liquidAcct("brokerage-b", 5_000_000, 0.1),
    ]);
  const secondPurchase = purchase({
    id: "buy2",
    month: 23,
    propertyId: "house2",
    downPaymentSourceIds: ["brokerage-b"],
  });

  it("blocks the second purchase, whose gain the first purchase pushes over the threshold", () => {
    const jur = jurisdiction();
    const base = twoBrokerages();
    const first = addEvent(
      emptyLedger,
      base,
      purchase({ month: 23, downPaymentSourceIds: ["brokerage-a"] }),
      jur,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // The sim resolves this AFTER its sibling, stacking that ~$10k gain underneath: this gain
    // crosses the threshold and leaves the brokerage short of $60,000.
    const second = addEvent(first.ledger, base, secondPurchase, jur);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.conflict).toMatch(/tax/i);
  });

  it("accepts that same second purchase when it has no sibling (the block IS the stacking)", () => {
    // The control: identical but for the sibling.
    expect(addEvent(emptyLedger, twoBrokerages(), secondPurchase, jurisdiction()).ok).toBe(true);
  });
});

// gate == sim, the load-bearing invariant: the affordability gate prices a candidate over the
// SAME base the simulator resolves it against, so it blocks exactly when the sim would fall
// short — never wider. Explicit draws now resolve before automatic decumulation, so a
// candidate's marginal context is "after explicit draws, before decumulation": decumulation's
// gains come AFTER it and are none of the candidate's tax. A gate that still read the
// after-decumulation base would stack decumulation's gain under the candidate, over-tax the
// sale, and block a purchase the sim funds in full — this fixture is the guard against that
// regression.

describe("HomePurchaseEvent — §4.5 gate == sim across a decumulation month", () => {
  // The candidate draws `cash` (a $60k buffer, no gain); decumulation draws the appreciated
  // `nest`. The gains-above-$15k jurisdiction taxes `nest`'s liquidation but never the cash
  // draw, so the candidate's shortfall is purely a question of balance — precisely the axis the
  // reorder moved.
  const jur = () => bracketedCapitalGains(dollarsToCents(15_000), 0.4);
  // One decumulation month at the purchase: $150k of expense with no income at month 23 only,
  // so `nest` grows untouched until then and liquidates exactly once, alongside the draw. In the
  // PRE-CANDIDATE projection the gate probes, decumulation would spend the whole $60k `cash`
  // buffer here and liquidate `nest` for the rest — so end-of-month `cash` reads $0. The gate
  // must instead see `cash` as it stands BEFORE decumulation, which is what the candidate (first
  // in resolution order) actually draws from.
  const baseWithLateExpense = (): LedgerBaseConfig => ({
    horizonMonths: 24,
    annualInflationRate: 0,
    initialPersons: [personLit("p1", "Alice")],
    initialAccounts: [liquidAcct("cash", DOWN, 0), liquidAcct("nest", 20_000_000, 0.1)],
    initialExpenseSeries: [
      {
        series: new SimCashFlowSeries(
          23,
          dollarsToCents(150_000),
          { type: "fixed" },
          { baselineUnit: "monthly", endMonth: 23 },
        ),
        ownerId: "p1" as PersonId,
      },
    ],
  });
  const buy = purchase({ month: 23, downPaymentSourceIds: ["cash"] });

  it("accepts a candidate the sim funds in full from a buffer decumulation would otherwise spend", () => {
    const base = baseWithLateExpense();

    // The gate, probing the pre-candidate ledger, prices the $60k down payment against `cash` as
    // it stands BEFORE the month's decumulation — the full $60k buffer — so it predicts zero
    // shortfall and (cash has no gain) zero tax. This is the load-bearing read: end-of-month
    // `cash` is $0 there, and a gate reading it would predict a full $60k shortfall and block.
    const gate = fundingLookup(emptyLedger, base, jur()).availabilityAt(["cash"], DOWN, 23);
    expect(gate.taxCents).toBe(0);
    expect(gate.shortfallCents).toBe(0);

    // The discriminating assertion: the gate accepts, matching the sim below. Read the
    // post-decumulation balance and it would block a purchase the simulator funds in full.
    const accepted = addEvent(emptyLedger, base, buy, jur());
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;

    const series = buildProjection(interpretLedger(accepted.ledger, base), base, jur());
    const at = series.months[23];

    // gate == sim: the candidate resolved FIRST and took the full $60k `cash` buffer, draining
    // it to exactly zero — the shortfall the gate predicted (none) is the shortfall the sim
    // produced (none), and the property was acquired.
    expect(at.accountBalancesCents.cash).toBe(0);
    expect(at.propertyValuesCents.house1).toBe(PRICE);
    // The month genuinely decumulated AND taxed it: the $150k expense forced `nest`'s
    // liquidation, whose gain crossed the $15k threshold — the very decumulation whose balance
    // drain and tax the gate had to keep off the candidate.
    expect(at.flows!.expensesCents).toBe(dollarsToCents(150_000));
    expect(at.flows!.taxCents).toBeGreaterThan(0);
    expect(at.accountBalancesCents.nest).toBeLessThan(series.months[22].accountBalancesCents.nest);
  });
});

// Membership is a property of the account, not the month: every liquid account is listed at
// every month and only `balanceCents` moves. Omitting empty ones let a picker row vanish while
// its id stayed selected.

describe("fundingLookup — the source pool", () => {
  // $40k savings + $40k brokerage, $60k down at month 3: savings empties, brokerage keeps $20k.
  const base = () =>
    baseWithAccounts([liquidAcct("savings", 4_000_000), liquidAcct("brokerage", 4_000_000)]);
  const spendIt = purchase({ month: 3, downPaymentSourceIds: ["savings", "brokerage"] });

  it("lists an account the plan has emptied, at $0, rather than dropping it", () => {
    const b = base();
    const ledger = addWithBase(emptyLedger, b, spendIt);
    const { sourcesAt } = fundingLookup(ledger, b, nullJurisdiction);

    expect(sourcesAt(2).map((s) => s.id).sort()).toEqual(["brokerage", "savings"]);
    expect(sourcesAt(3).map((s) => s.id).sort()).toEqual(["brokerage", "savings"]);
    expect(sourcesAt(2).find((s) => s.id === "savings")?.balanceCents).toBe(4_000_000);
    expect(sourcesAt(3).find((s) => s.id === "savings")?.balanceCents).toBe(0);
    expect(sourcesAt(3).find((s) => s.id === "brokerage")?.balanceCents).toBe(2_000_000);
  });

  it("keeps the largest-first order, so the empty accounts sort to the bottom", () => {
    const b = base();
    const ledger = addWithBase(emptyLedger, b, spendIt);
    // The picker's default drain order: biggest bucket first.
    expect(fundingLookup(ledger, b, nullJurisdiction).sourcesAt(3).map((s) => s.id)).toEqual([
      "brokerage",
      "savings",
    ]);
  });

  it("omits accounts that could never fund a draw, empty or not", () => {
    // Membership is "liquid", not "has money": the illiquid fund is absent, the empty liquid
    // account present.
    const b = baseWithAccounts([liquidAcct("savings", 0), goalFund("retirement", "401(k)", 5_000_000, false)]);
    expect(fundingLookup(emptyLedger, b, nullJurisdiction).sourcesAt(6).map((s) => s.id)).toEqual([
      "savings",
    ]);
  });
});
