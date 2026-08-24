/**
 * Two members, two filings. Finley models household members as SEPARATE SINGLE FILERS, so an
 * April in which one owes and the other is refunded is two independent settlements — not one
 * netted household figure.
 *
 * Three concepts are kept apart throughout, and each case below leans on the distinction:
 *
 *  1. **Whose liability it is.** Fixed at the filing, and it never moves.
 *  2. **Whose cash moves.** A bill is docked from its owner's take-home; a refund raises it and
 *     banks into that owner's own account, by the same routing as any other money they receive.
 *  3. **Who funded a shortfall.** An owner who cannot cover their own bill is helped by the
 *     household — and the liability stays theirs regardless of whose account paid.
 *
 * Netting collapses all three. $1,000 owed against $300 refunded is not $700 of tax: it is
 * $1,000 paid and $300 returned, to two different people, out of and into two different accounts.
 */

import { describe, it, expect } from "vitest";
import { dollarsToCents } from "../money/cashFlowSeries";
import { runWaterfall, type IncomeSourceMonth } from "./waterfall";
import type { WaterfallInput } from "./waterfall.types";
import { initSimState } from "./runState";
import type { SimState } from "./runState";
import { dueTaxYearSettlements } from "./taxYearSettlement";

const wages = (ownerId: string, waterfallInflowCents: number): IncomeSourceMonth => ({
  ownerId,
  waterfallInflowCents,
  taxCategory: "wages",
});

const ALEX_BILL = dollarsToCents(1_000);
const BLAKE_REFUND = dollarsToCents(300);

/**
 * A household of two with a bank account each, no tax on the month's own income, and whatever
 * April handed them. `settlementCashCents` is the seam the simulator charges a settlement
 * through — signed, positive owed.
 */
function april(
  settlements: Readonly<Record<string, number>>,
  over: Partial<WaterfallInput> = {},
): ReturnType<typeof runWaterfall> {
  return runWaterfall({
    personIds: ["alex", "blake"],
    incomeSources: [wages("alex", dollarsToCents(4_000)), wages("blake", dollarsToCents(2_000))],
    sharedObligationCents: 0,
    sharedScheme: "proportional",
    surplusDestination: { kind: "idle" },
    goals: [],
    accountBalanceCents: () => 0,
    liquidAccountId: "alex-savings",
    remainingDeferralRoomCents: () => Infinity,
    remainingCombinedDepositRoomCents: () => Infinity,
    payPeriodsPerYear: 12,
    periodsRemainingInTaxYear: 12,
    settlementCashCents: (pid) => settlements[pid] ?? 0,
    surplusAccountIdForPerson: (pid) => `${pid}-savings`,
    ...over,
  });
}

describe("April settlements — one owes while the other is refunded", () => {
  it("charges the bill to its owner and returns the refund to theirs, with no netting between", () => {
    const r = april({ alex: ALEX_BILL, blake: -BLAKE_REFUND });

    // Alex is $1,000 lighter, Blake $300 heavier. Neither figure is $700, and neither person's
    // balance moved by an amount the other's filing decided.
    expect(r.netCashFlowByPersonCents.get("alex")).toBe(dollarsToCents(4_000) - ALEX_BILL);
    expect(r.netCashFlowByPersonCents.get("blake")).toBe(dollarsToCents(2_000) + BLAKE_REFUND);
  });

  it("banks the refund into the refunded member's OWN account", () => {
    // Cash flow follows the person it belongs to, by the same routing as any other money they
    // receive — not into the household's designated buffer, which here is Alex's.
    const r = april({ alex: ALEX_BILL, blake: -BLAKE_REFUND });
    expect(r.accountDepositsCents.get("blake-savings")).toBe(dollarsToCents(2_000) + BLAKE_REFUND);
    expect(r.accountDepositsCents.get("alex-savings")).toBe(dollarsToCents(4_000) - ALEX_BILL);
  });

  it("reports the household's NET cash effect without erasing either gross figure", () => {
    // −$700 is a true statement about the household's cash and a false one about its tax. The
    // net is available; the two figures it was made from are still there to be read.
    const r = april({ alex: ALEX_BILL, blake: -BLAKE_REFUND });
    const signed = [...r.netCashFlowByPersonCents.values()];
    const wagesTotal = dollarsToCents(6_000);
    expect(signed.reduce((s, c) => s + c, 0)).toBe(wagesTotal - ALEX_BILL + BLAKE_REFUND);
    expect(ALEX_BILL - BLAKE_REFUND).toBe(dollarsToCents(700));
  });
});

describe("April settlements — the same direction, and none at all", () => {
  it("charges both when both owe", () => {
    const r = april({ alex: ALEX_BILL, blake: dollarsToCents(500) });
    expect(r.netCashFlowByPersonCents.get("alex")).toBe(dollarsToCents(4_000) - ALEX_BILL);
    expect(r.netCashFlowByPersonCents.get("blake")).toBe(dollarsToCents(2_000 - 500));
  });

  it("returns both when both are refunded, each to their own account", () => {
    const r = april({ alex: -dollarsToCents(200), blake: -BLAKE_REFUND });
    expect(r.accountDepositsCents.get("alex-savings")).toBe(dollarsToCents(4_000 + 200));
    expect(r.accountDepositsCents.get("blake-savings")).toBe(dollarsToCents(2_000) + BLAKE_REFUND);
  });

  it("keeps equal and opposite settlements whole rather than cancelling them out", () => {
    // The case that makes netting look harmless: the household's net is exactly zero, and both
    // people's cash still moved by $1,000.
    const r = april({ alex: ALEX_BILL, blake: -ALEX_BILL });
    expect(r.netCashFlowByPersonCents.get("alex")).toBe(dollarsToCents(4_000) - ALEX_BILL);
    expect(r.netCashFlowByPersonCents.get("blake")).toBe(dollarsToCents(2_000) + ALEX_BILL);
    const net = [...r.netCashFlowByPersonCents.values()].reduce((s, c) => s + c, 0);
    expect(net).toBe(dollarsToCents(6_000));
  });
});

describe("April settlements — an owner who cannot cover their own bill", () => {
  const BLAKE_BILL = dollarsToCents(2_000);
  /** Blake earns $200 against a $2,000 bill, so $1,800 has to be found somewhere. */
  const short = (alexPayDollars: number) =>
    april(
      { blake: BLAKE_BILL },
      {
        incomeSources: [
          wages("alex", dollarsToCents(alexPayDollars)),
          wages("blake", dollarsToCents(200)),
        ],
      },
    );

  it("is helped by the partner's discretionary cash before the cascade sees anything", () => {
    // The household backstop, working as it does for any other unfunded need: Alex's $4,000
    // absorbs Blake's $1,800 gap, so nothing reaches the cascade at all.
    const r = short(4_000);
    expect(r.shortfallCents).toBe(0);
    // And it is visible in whose money moved — Alex banks $2,200, not $4,000.
    expect(r.accountDepositsCents.get("alex-savings")).toBe(dollarsToCents(4_000 - 1_800));
    expect(r.accountDepositsCents.get("blake-savings")).toBeUndefined();
  });

  it("leaves the liability with its owner however the household funded it", () => {
    // The three concepts pulled apart in one assertion. Blake's month is short by the whole
    // $2,000 they owed — that is the liability. Alex's own charges are unchanged by it — Blake's
    // bill never became Alex's. What Alex actually banked is where the assistance shows up.
    const helped = short(4_000);
    const unhelped = april({}, {
      incomeSources: [wages("alex", dollarsToCents(4_000)), wages("blake", dollarsToCents(200))],
    });
    expect(helped.netCashFlowByPersonCents.get("blake")).toBe(dollarsToCents(200) - BLAKE_BILL);
    expect(helped.netCashFlowByPersonCents.get("alex")).toBe(
      unhelped.netCashFlowByPersonCents.get("alex"),
    );
    expect(helped.accountDepositsCents.get("alex-savings")).toBeLessThan(
      unhelped.accountDepositsCents.get("alex-savings")!,
    );
  });

  it("sends what the household cannot cover to the cascade, preferring the OWNER's accounts", () => {
    // Alex earns $500, so the pool covers $500 of Blake's $1,800 gap and $1,300 has to come out
    // of accounts. The shortfall map is decumulation's preference — try THIS person's accounts
    // for this much first — and an unfunded deduction is one person's own charge, so it is
    // attributed whole to them rather than spread by asset weight the way a shared obligation is.
    const r = short(500);
    expect(r.shortfallCents).toBe(dollarsToCents(1_300));
    expect(r.obligationShortfallByPersonCents.get("blake")).toBe(dollarsToCents(1_300));
    expect(r.obligationShortfallByPersonCents.get("alex")).toBe(0);
  });

  it("prefers the owner even where the partner holds every eligible asset", () => {
    // Asset weight decides a SHARED obligation's shortfall. It must not decide this one, or a
    // cash-rich partner would have their accounts drained first for a bill that was never theirs.
    const r = april(
      { blake: BLAKE_BILL },
      {
        incomeSources: [wages("alex", dollarsToCents(500)), wages("blake", dollarsToCents(200))],
        eligibleAssetsCentsByPerson: (pid) => (pid === "alex" ? dollarsToCents(500_000) : 0),
      },
    );
    expect(r.obligationShortfallByPersonCents.get("blake")).toBe(dollarsToCents(1_300));
    expect(r.obligationShortfallByPersonCents.get("alex")).toBe(0);
  });
});

/**
 * Separation. A balance is parked in December and settled the following April, so a partner can
 * leave in between — and their bill must not land on the household they left, nor their refund
 * be banked by it. The parked balance goes with them, exactly as their accounts and their debts do.
 *
 * Death is the opposite case and deliberately not caught by the same rule: a deceased member's
 * balance is a real claim, and their assets have already merged into the household it settles
 * against.
 */
describe("a settlement that comes due after its owner has left", () => {
  const SETTLEMENT_MONTH = 15; // the April after month 11 closes the first year

  function household(separationMonth: number | undefined): SimState {
    const state = initSimState({
      horizonMonths: 24,
      annualInflationRate: 0,
      startYear: 2026,
      persons: [
        { id: "alex", name: "Alex" },
        { id: "blake", name: "Blake", ...(separationMonth === undefined ? {} : { separationMonth }) },
      ],
      accounts: [],
      incomeSeries: [],
      expenseSeries: [],
    });
    for (const [pid, cents] of [
      ["alex", ALEX_BILL],
      ["blake", -BLAKE_REFUND],
    ] as const) {
      state.pendingTaxSettlementsByPersonYear.set(`${pid}|2026`, {
        totalCents: cents,
        byCategoryCents: {},
        bySourceCents: {},
      });
    }
    return state;
  }

  it("settles both while both are still in the household", () => {
    const due = dueTaxYearSettlements(household(undefined), { year: 2027 }, SETTLEMENT_MONTH);
    expect(due.get("alex")?.totalCents).toBe(ALEX_BILL);
    expect(due.get("blake")?.totalCents).toBe(-BLAKE_REFUND);
  });

  it("lets a departed member's REFUND leave with them rather than banking it", () => {
    // Blake separated in February; the money back is Blake's, and the household they left has no
    // claim on it.
    const due = dueTaxYearSettlements(household(13), { year: 2027 }, SETTLEMENT_MONTH);
    expect(due.has("blake")).toBe(false);
    expect(due.get("alex")?.totalCents).toBe(ALEX_BILL);
  });

  it("lets a departed member's BILL leave with them rather than charging the household", () => {
    const state = initSimState({
      horizonMonths: 24,
      annualInflationRate: 0,
      startYear: 2026,
      persons: [
        { id: "alex", name: "Alex" },
        { id: "blake", name: "Blake", separationMonth: 13 },
      ],
      accounts: [],
      incomeSeries: [],
      expenseSeries: [],
    });
    state.pendingTaxSettlementsByPersonYear.set("blake|2026", {
      totalCents: dollarsToCents(5_000),
      byCategoryCents: {},
      bySourceCents: {},
    });
    const due = dueTaxYearSettlements(state, { year: 2027 }, SETTLEMENT_MONTH);
    // Charged to nobody — not to Alex, who never owed it and would otherwise fund it from their
    // own accounts because Blake has no income left to dock.
    expect(due.size).toBe(0);
  });

  it("consumes a departed member's balance so it cannot resurface in a later April", () => {
    const state = household(13);
    dueTaxYearSettlements(state, { year: 2027 }, SETTLEMENT_MONTH);
    expect(state.pendingTaxSettlementsByPersonYear.has("blake|2026")).toBe(false);
  });

  it("still settles a member who separates AFTER the April that charges them", () => {
    // The rule is about who is in the household when the balance comes due, not about whether
    // they ever leave.
    const due = dueTaxYearSettlements(household(20), { year: 2027 }, SETTLEMENT_MONTH);
    expect(due.get("blake")?.totalCents).toBe(-BLAKE_REFUND);
  });

  it("goes on charging a member who DIED rather than separated", () => {
    // Their assets merged into the household; so does the claim against them.
    const state = initSimState({
      horizonMonths: 24,
      annualInflationRate: 0,
      startYear: 2026,
      persons: [
        { id: "alex", name: "Alex" },
        { id: "blake", name: "Blake", activeWindow: { startMonth: 0, endMonthExclusive: 13 } },
      ],
      accounts: [],
      incomeSeries: [],
      expenseSeries: [],
    });
    state.pendingTaxSettlementsByPersonYear.set("blake|2026", {
      totalCents: dollarsToCents(5_000),
      byCategoryCents: {},
      bySourceCents: {},
    });
    const due = dueTaxYearSettlements(state, { year: 2027 }, SETTLEMENT_MONTH);
    expect(due.get("blake")?.totalCents).toBe(dollarsToCents(5_000));
  });
});
