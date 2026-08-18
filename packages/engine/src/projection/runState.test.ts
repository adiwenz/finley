/**
 * {@link cloneSimState} is what makes the year's tax estimate safe: the forecast pass runs twelve
 * real months, and every write one of them makes has to land on the copy. A field left shared is
 * not a wrong number — it is a silent, compounding corruption of the authoritative run, showing up
 * as a balance that drifted for no reason a year later.
 *
 * TypeScript already refuses a clone that OMITS a field. These pin the half it cannot see: that a
 * field carrying mutable state is copied rather than aliased, one level into the objects it holds.
 */
import { describe, it, expect } from "vitest";
import { SimAccount, CASH_INTEREST_TAX_PROFILE } from "../plan/simAccount";
import { AmortizingLoan } from "../liability/liability";
import { dollarsToCents } from "../money/cashFlowSeries";
import { cloneSimState, initSimState, type SimState } from "./runState";
import type { HouseholdSimInput } from "./simulate.types";

const input: HouseholdSimInput = {
  horizonMonths: 24,
  annualInflationRate: 0,
  startYear: 2026,
  persons: [{ id: "p1", name: "You" }],
  accounts: [
    new SimAccount({
      id: "savings",
      ownerId: "p1",
      liquid: true,
      taxProfile: CASH_INTEREST_TAX_PROFILE,
      openingBalanceCents: dollarsToCents(50_000),
      initialAnnualRate: 0.02,
    }),
  ],
  liabilities: [
    new AmortizingLoan({
      id: "auto",
      ownerId: "p1",
      kind: "auto",
      openingBalanceCents: dollarsToCents(12_000),
      apr: 0.05,
      termMonths: 48,
    }),
  ],
  properties: [
    {
      id: "home",
      ownerId: "p1",
      startMonth: 0,
      endMonth: null,
      openingValueCents: dollarsToCents(400_000),
      appreciationAnnualRate: 0,
    },
  ],
  incomeSeries: [],
  expenseSeries: [],
};

/**
 * Every Map on the state carrying something — the accumulators a run fills as well as the balances
 * {@link initSimState} seeds. The reference checks below are only as strong as this: an empty Map
 * would pass them by having nothing to alias, so the size assertion comes first.
 */
function populatedState(): SimState {
  const state = initSimState(input);
  state.accruedReturnByAccount.set("savings", { cents: 8_300, category: "ordinaryIncome" });
  state.deferredByPersonYear.set("p1|2026", dollarsToCents(1_000));
  state.earnedByPersonYear.set("p1|2026", { wages: dollarsToCents(60_000) });
  state.combinedDepositsByPlanYear.set("p1:401k|2026", dollarsToCents(2_000));
  state.taxableIncomeByPersonYear.set("p1|2026", { wages: dollarsToCents(58_000) });
  state.earlyWithdrawalPenaltyByPersonYear.set("p1|2026", dollarsToCents(100));
  state.taxableBySourceByPersonYear.set(
    "p1|2026",
    new Map([["job:p1", { key: "job:p1", category: "wages" as const, taxableCents: dollarsToCents(58_000) }]]),
  );
  state.estimatedFederalTaxByPersonYear.set("p1|2026", {
    totalCents: dollarsToCents(9_000),
    byCategoryCents: { wages: dollarsToCents(9_000) },
    sourceWeights: [{ key: "job:p1", category: "wages", taxableCents: dollarsToCents(58_000) }],
  });
  state.federalTaxPaidByPersonYear.set("p1|2026", {
    totalCents: dollarsToCents(750),
    byCategoryCents: { wages: dollarsToCents(750) },
    bySourceCents: { "job:p1": dollarsToCents(750) },
  });
  state.pendingTaxSettlementsByPersonYear.set("p1|2025", {
    totalCents: dollarsToCents(300),
    byCategoryCents: { wages: dollarsToCents(300) },
    bySourceCents: { "job:p1": dollarsToCents(300) },
  });
  state.governmentBenefitBaseByPerson.set("p1", dollarsToCents(2_400));
  state.lastComputedThroughYear.set("p1", 2025);
  state.earningsByPerson.get("p1")!.set(2026, dollarsToCents(60_000));
  return state;
}

const mapFieldsOf = (state: SimState): [string, Map<unknown, unknown>][] =>
  Object.entries(state).filter(([, value]) => value instanceof Map) as [
    string,
    Map<unknown, unknown>,
  ][];

const at = (state: SimState, key: string): Map<unknown, unknown> =>
  (state as unknown as Record<string, Map<unknown, unknown>>)[key]!;

describe("cloneSimState", () => {
  it("copies every Map on the state — a new mutable field cannot be silently shared", () => {
    const state = populatedState();
    const fields = mapFieldsOf(state);
    // A field added to SimState and left out of the fixture fails HERE, before it can pass the
    // reference check below by being empty.
    for (const [key, map] of fields) expect(map.size, key).toBeGreaterThan(0);

    const clone = cloneSimState(state);
    for (const [key, map] of fields) expect(at(clone, key), key).not.toBe(map);
  });

  it("copies the objects those Maps hold, not merely the Maps themselves", () => {
    // The accumulators a month writes are edited IN PLACE — `taxableIncomeByPersonYear`'s
    // per-category object, `taxableBySourceByPersonYear`'s inner Map, `earningsByPerson`'s year
    // totals — so copying only the outer Map would leave every one of them shared.
    const state = populatedState();
    const clone = cloneSimState(state);
    for (const [key, map] of mapFieldsOf(state)) {
      for (const [entryKey, value] of map) {
        if (typeof value !== "object" || value === null) continue;
        expect(at(clone, key).get(entryKey), `${key}[${String(entryKey)}]`).not.toBe(value);
      }
    }
  });

  it("leaves the original untouched when the copy is written through", () => {
    const state = populatedState();
    // Read off the state rather than restated: a liability and a property authored at month 0 are
    // originated by their own step, so they open at 0 here and only `savings` carries a balance.
    const before = {
      savings: state.assetBalances.get("savings"),
      auto: state.liabilityBalances.get("auto"),
      home: state.propertyValues.get("home"),
    };
    const clone = cloneSimState(state);

    clone.assetBalances.set("savings", -1);
    clone.liabilityBalances.set("auto", -1);
    clone.propertyValues.set("home", -1);
    clone.taxableIncomeByPersonYear.get("p1|2026")!.wages = dollarsToCents(999_999);
    clone.taxableBySourceByPersonYear.get("p1|2026")!.set("draw:savings", {
      key: "draw:savings",
      category: "ordinaryIncome",
      taxableCents: dollarsToCents(40_000),
    });
    clone.earningsByPerson.get("p1")!.set(2026, 0);
    clone.pendingTaxSettlementsByPersonYear.delete("p1|2025");

    expect(state.assetBalances.get("savings")).toBe(before.savings);
    expect(state.liabilityBalances.get("auto")).toBe(before.auto);
    expect(state.propertyValues.get("home")).toBe(before.home);
    expect(state.taxableIncomeByPersonYear.get("p1|2026")).toEqual({ wages: dollarsToCents(58_000) });
    expect([...state.taxableBySourceByPersonYear.get("p1|2026")!.keys()]).toEqual(["job:p1"]);
    expect(state.earningsByPerson.get("p1")!.get(2026)).toBe(dollarsToCents(60_000));
    expect(state.pendingTaxSettlementsByPersonYear.get("p1|2025")?.totalCents).toBe(
      dollarsToCents(300),
    );
  });

  it("shares the compiled plan data, which no month writes", () => {
    // Accounts carry their own rate segments and transfers, liabilities their amortization
    // schedules. Copying them would be waste at best; at worst it would let a forecast month
    // diverge from the run on data that is meant to be identical.
    const state = populatedState();
    const clone = cloneSimState(state);
    expect(clone.accounts).toBe(state.accounts);
    expect(clone.liquidAccount).toBe(state.liquidAccount);
    expect(clone.liabilities).toBe(state.liabilities);
    expect(clone.cascadeCards).toBe(state.cascadeCards);
    expect(clone.properties).toBe(state.properties);
    expect(clone.goals).toBe(state.goals);
    expect(clone.contributionLines).toBe(state.contributionLines);
    expect(clone.fundingDraws).toBe(state.fundingDraws);
    expect(clone.personIds).toBe(state.personIds);
  });
});
