/**
 * Contribution capacity — the one rule that decides each person's share of the household's
 * shared spending, before and after the paychecks stop:
 *
 *     capacity = recurring monthly income + eligible assets × 4% ÷ 12
 *
 * Income alone was wrong in both directions, and this file is mostly the two directions. A
 * retired partner living off a million dollars has no income, so an income-weighted split handed
 * their working partner the entire budget; and a $2,000/mo earner sitting on two million was
 * asked for a quarter of what an $8,000/mo earner with nothing was asked for. Capacity answers
 * what each person could actually put toward the rent this month, which is what a share of the
 * rent is a claim about.
 *
 * Four things stay separate throughout, and most cases below turn on the difference between two
 * of them: whose expense it is (the share), whose tax it is, what actually funded it, and who
 * helped. Assistance never moves a share.
 */

import { describe, it, expect } from "vitest";
import { dollarsToCents } from "../money/cashFlowSeries";
import { SimAccount, type SimAccountTaxProfile, CAPITAL_GAINS_TAX_PROFILE, CASH_INTEREST_TAX_PROFILE, PRE_TAX_TAX_PROFILE, TAX_EXEMPT_TAX_PROFILE } from "../plan/simAccount";
import { nullJurisdiction, type Jurisdiction } from "../jurisdiction/jurisdiction";
import { runWaterfall, SUSTAINABLE_DRAW_RATE, type IncomeSourceMonth } from "./waterfall";
import type { WaterfallInput } from "./waterfall.types";
import { capacityAssetsCentsByPerson } from "./allocationStep";
import { initSimState } from "./runState";
import type { HouseholdSimInput } from "./simulate";
import type { SimPerson } from "./simulate.types";

const wages = (ownerId: string, dollars: number): IncomeSourceMonth => ({
  ownerId,
  waterfallInflowCents: dollarsToCents(dollars),
  taxCategory: "wages",
});

const socialSecurity = (ownerId: string, dollars: number): IncomeSourceMonth => ({
  ownerId,
  waterfallInflowCents: dollarsToCents(dollars),
  taxCategory: "governmentRetirementBenefit",
});

/** The household's whole monthly budget, shared. */
const RENT = dollarsToCents(3_000);

/** What a balance is worth as a monthly contribution — the sum every case below is stated in. */
const draw = (dollars: number) => Math.floor((dollarsToCents(dollars) * SUSTAINABLE_DRAW_RATE) / 12);

/**
 * One month for Alex and Blake, sharing `RENT` by capacity, with no tax on the month's own pay —
 * so a stated wage IS the recurring income the weight reads, and the arithmetic in each case is
 * the arithmetic a reader can do in their head.
 */
function month(over: Partial<WaterfallInput> = {}): ReturnType<typeof runWaterfall> {
  return runWaterfall({
    personIds: ["alex", "blake"],
    incomeSources: [],
    sharedObligationCents: RENT,
    sharedScheme: "proportional",
    surplusDestination: { kind: "idle" },
    goals: [],
    accountBalanceCents: () => 0,
    liquidAccountId: "alex-savings",
    remainingDeferralRoomCents: () => Infinity,
    remainingCombinedDepositRoomCents: () => Infinity,
    payPeriodsPerYear: 12,
    periodsRemainingInTaxYear: 12,
    surplusAccountIdForPerson: (pid) => `${pid}-savings`,
    ...over,
  });
}

/** Capacity assets stated in dollars, for the two people every case here has. */
const assets = (alexDollars: number, blakeDollars: number) => (pid: string) =>
  dollarsToCents(pid === "alex" ? alexDollars : blakeDollars);

const sharesOf = (r: ReturnType<typeof runWaterfall>): Record<string, number> =>
  Object.fromEntries(r.obligationChargedByPersonCents);

/** The share each person was assigned, as a fraction of the budget — how the cases read. */
const fractionsOf = (r: ReturnType<typeof runWaterfall>) => {
  const shares = sharesOf(r);
  return { alex: shares["alex"]! / RENT, blake: shares["blake"]! / RENT };
};

describe("two people who both still work", () => {
  it("splits unequal pay against equal savings by the pay", () => {
    // The spec's own worked example: $8,000 + $100 against $2,400 + $100, so 76% / 24%. Equal
    // savings shift both capacities by the same amount, which moves the ratio slightly toward
    // even — $30,000 each is worth $100 a month each, and that is the whole of their effect.
    const r = month({
      incomeSources: [wages("alex", 8_000), wages("blake", 2_400)],
      capacityAssetsCentsByPerson: assets(30_000, 30_000),
    });
    expect(fractionsOf(r).alex).toBeCloseTo(0.764, 3);
    expect(fractionsOf(r).blake).toBeCloseTo(0.236, 3);
    expect(draw(30_000)).toBe(dollarsToCents(100));
  });

  it("splits equal pay against unequal savings by the savings", () => {
    // Same paycheck, and the only thing left to tell them apart is what they have put by.
    const r = month({
      incomeSources: [wages("alex", 5_000), wages("blake", 5_000)],
      capacityAssetsCentsByPerson: assets(600_000, 0),
    });
    // $5,000 + $2,000 against $5,000 + $0.
    expect(fractionsOf(r).alex).toBeCloseTo(7 / 12, 3);
    expect(fractionsOf(r).blake).toBeCloseTo(5 / 12, 3);
  });

  it("can hand the larger share to the partner who earns less", () => {
    // The spec's second example, and the case income alone gets flatly backwards: Alex out-earns
    // Blake four to one, and Blake's two million makes them marginally the more able of the two.
    const r = month({
      incomeSources: [wages("alex", 8_000), wages("blake", 2_000)],
      capacityAssetsCentsByPerson: assets(50_000, 2_000_000),
    });
    expect(fractionsOf(r).alex).toBeCloseTo(0.485, 3);
    expect(fractionsOf(r).blake).toBeCloseTo(0.515, 3);
    expect(fractionsOf(r).blake).toBeGreaterThan(fractionsOf(r).alex);
  });

  it("weighs a paycheck against a portfolio when each partner has only one of them", () => {
    // $6,000 a month against $1,800,000 saved — $6,000 of capacity each, and an even split falls
    // out of the arithmetic rather than being a special case anybody wrote.
    const r = month({
      incomeSources: [wages("alex", 6_000)],
      capacityAssetsCentsByPerson: assets(0, 1_800_000),
    });
    expect(sharesOf(r)).toEqual({ alex: RENT / 2, blake: RENT / 2 });
  });
});

describe("two people whose paychecks have stopped", () => {
  it("weighs two retirements by their benefits and their portfolios together", () => {
    // The spec's third example: nothing but a portfolio against a benefit and a small balance.
    const r = month({
      incomeSources: [socialSecurity("blake", 3_343)],
      capacityAssetsCentsByPerson: assets(1_000_000, 50_000),
    });
    expect(fractionsOf(r).alex).toBeCloseTo(0.487, 3);
    expect(fractionsOf(r).blake).toBeCloseTo(0.513, 3);
  });

  it("weighs unequal benefits against unequal balances, with no separate retirement mode", () => {
    const r = month({
      incomeSources: [socialSecurity("alex", 2_800), socialSecurity("blake", 1_400)],
      capacityAssetsCentsByPerson: assets(120_000, 900_000),
    });
    // $2,800 + $400 against $1,400 + $3,000.
    expect(fractionsOf(r).alex).toBeCloseTo(3_200 / 7_600, 3);
    expect(fractionsOf(r).blake).toBeCloseTo(4_400 / 7_600, 3);
  });

  it("splits by balances alone when neither has any income left", () => {
    const r = month({ capacityAssetsCentsByPerson: assets(900_000, 300_000) });
    expect(sharesOf(r)).toEqual({ alex: RENT * 0.75, blake: RENT * 0.25 });
  });
});

describe("a household with nothing, or nearly nothing, to weigh by", () => {
  it("shares the budget equally when neither person has income or eligible assets", () => {
    // Not "nobody owes it": the household still spends the money, and a split that assigned it to
    // nobody would report the month as costing each of them nothing while their balances fell.
    const r = month();
    expect(sharesOf(r)).toEqual({ alex: RENT / 2, blake: RENT / 2 });
    expect(r.shortfallCents).toBe(RENT);
  });

  it("gives the whole budget to the only person who can contribute anything", () => {
    const byIncome = month({ incomeSources: [wages("alex", 3_000)] });
    expect(sharesOf(byIncome)).toEqual({ alex: RENT, blake: 0 });

    // And by assets alone, which is the same rule and not a second one.
    const byAssets = month({ capacityAssetsCentsByPerson: assets(0, 400_000) });
    expect(sharesOf(byAssets)).toEqual({ alex: 0, blake: RENT });
  });

  it("still weighs by locked-up balances when capacity has nothing else to offer", () => {
    // Two partners under sixty holding nothing but 401(k)s have no capacity at all — but the
    // household's cascade will sell exactly those accounts to pay the month, so charging them
    // half each would describe the wrong person as having paid. The middle rung says who did.
    const r = month({
      capacityAssetsCentsByPerson: () => 0,
      eligibleAssetsCentsByPerson: (pid) => dollarsToCents(pid === "alex" ? 300_000 : 100_000),
    });
    expect(sharesOf(r)).toEqual({ alex: RENT * 0.75, blake: RENT * 0.25 });
  });
});

describe("what capacity refuses to count", () => {
  const BASE = {
    incomeSources: [wages("alex", 6_000), wages("blake", 3_000)],
    capacityAssetsCentsByPerson: assets(60_000, 60_000),
  };

  it("ignores an April settlement, whichever way it fell", () => {
    const ordinary = sharesOf(month(BASE));
    const april = month({
      ...BASE,
      settlementCashCents: (pid) => (pid === "alex" ? dollarsToCents(5_000) : -dollarsToCents(2_000)),
    });
    // A refund is last year's wages returned and a bill is a debt; neither says anything about
    // who can carry the rent, and both move take-home in the direction that would say the most.
    expect(sharesOf(april)).toEqual(ordinary);
    // The tax itself is untouched: Alex's bill is Alex's, and Blake keeps the refund.
    expect(april.netCashFlowByPersonCents.get("blake")).toBe(
      dollarsToCents(3_000) + dollarsToCents(2_000) - ordinary["blake"]!,
    );
  });

  it("ignores a bonus, however large", () => {
    const withBonus = month({
      ...BASE,
      incomeSources: [
        {
          ownerId: "alex",
          waterfallInflowCents: dollarsToCents(26_000),
          supplementalCents: dollarsToCents(20_000),
          taxCategory: "wages",
        },
        wages("blake", 3_000),
      ],
    });
    // $20,000 once is not a rate of pay. Alex's recurring $6,000 is what the split reads, and the
    // bonus reaches Alex's own account instead of the household's budget.
    expect(sharesOf(withBonus)).toEqual(sharesOf(month(BASE)));
    expect(withBonus.accountDepositsCents.get("alex-savings")).toBeGreaterThan(dollarsToCents(20_000));
  });

  it("ignores money taken out of an account, which is already on the other side of the sum", () => {
    const withDraw = month({
      ...BASE,
      incomeSources: [
        ...BASE.incomeSources,
        {
          ownerId: "blake",
          waterfallInflowCents: dollarsToCents(9_000),
          taxCategory: "ordinaryIncome",
          fromAccountWithdrawal: true,
        },
      ],
    });
    // Counting it would count Blake's savings twice, and would say a household that had to sell
    // something this month could suddenly afford more of its own budget.
    expect(sharesOf(withDraw)).toEqual(sharesOf(month(BASE)));
  });

  it("ignores interest and dividends on balances the weight already holds", () => {
    const withReturns = month({
      ...BASE,
      incomeSources: [
        ...BASE.incomeSources,
        // An accrued booking: the cash is already inside the balance, so it injects nothing.
        {
          ownerId: "alex",
          waterfallInflowCents: 0,
          taxableCents: dollarsToCents(350),
          taxCategory: "ordinaryIncome",
          reportCategory: "savingsInterest",
        },
      ],
    });
    expect(sharesOf(withReturns)).toEqual(sharesOf(month(BASE)));
  });
});

describe("who pays is not who owes", () => {
  it("leaves a share with its owner when the other partner's money covers it", () => {
    // Alex owns $2,000 of the budget on capacity and has $500 of income to meet it with; only
    // Blake holds anything sellable. The household finds the money; the debt stays Alex's.
    const r = month({
      incomeSources: [wages("alex", 500), wages("blake", 250)],
      capacityAssetsCentsByPerson: assets(0, 0),
      eligibleAssetsCentsByPerson: (pid) => (pid === "blake" ? dollarsToCents(400_000) : 0),
    });
    const shares = sharesOf(r);
    expect(shares["alex"]! + shares["blake"]!).toBe(RENT);
    expect(shares["alex"]).toBe(dollarsToCents(2_000));
    // What Alex's own income could not cover is a household shortfall, attributed to Blake's
    // accounts as the place to look for it — a preference about funding, not a transfer of the
    // obligation, which `obligationChargedByPersonCents` still reads as Alex's in full.
    expect(r.shortfallCents).toBe(RENT - dollarsToCents(750));
    expect(r.obligationShortfallByPersonCents.get("blake")).toBe(r.shortfallCents);
    expect(r.obligationShortfallByPersonCents.get("alex")).toBe(0);
    expect(r.obligationChargedByPersonCents.get("alex")).toBe(dollarsToCents(2_000));
  });
});

describe("splitting evenly, which capacity does not touch", () => {
  it("halves the budget whatever either partner earns or holds", () => {
    for (const over of [
      {},
      { incomeSources: [wages("alex", 9_000)] },
      { capacityAssetsCentsByPerson: assets(4_000_000, 0) },
      {
        incomeSources: [wages("alex", 9_000)],
        capacityAssetsCentsByPerson: assets(4_000_000, 0),
        settlementCashCents: (pid: string) => (pid === "alex" ? dollarsToCents(6_000) : -dollarsToCents(2_000)),
      },
    ]) {
      expect(sharesOf(month({ ...over, sharedScheme: "even" }))).toEqual({
        alex: RENT / 2,
        blake: RENT / 2,
      });
    }
  });
});

describe("every cent of the budget is assigned, under either scheme", () => {
  it("sums the shares to the obligation across a sweep of households", () => {
    const PAYS = [0, 1, 2_400, 8_000];
    const HOLDINGS = [0, 1, 30_000, 2_000_000];
    const SETTLEMENTS = [0, 5_000, -3_000];
    const wrong: string[] = [];
    for (const scheme of ["proportional", "even"] as const) {
      for (const alexPay of PAYS) {
        for (const blakePay of PAYS) {
          for (const alexHeld of HOLDINGS) {
            for (const blakeHeld of HOLDINGS) {
              for (const settlement of SETTLEMENTS) {
                const r = month({
                  sharedScheme: scheme,
                  incomeSources: [
                    ...(alexPay > 0 ? [wages("alex", alexPay)] : []),
                    ...(blakePay > 0 ? [wages("blake", blakePay)] : []),
                  ],
                  capacityAssetsCentsByPerson: assets(alexHeld, blakeHeld),
                  settlementCashCents: (pid) => (pid === "alex" ? dollarsToCents(settlement) : 0),
                });
                const shares = sharesOf(r);
                const assigned = (shares["alex"] ?? 0) + (shares["blake"] ?? 0);
                if (assigned !== RENT) {
                  wrong.push(`${scheme} ${alexPay}/${blakePay} ${alexHeld}/${blakeHeld} ${settlement}: ${assigned}`);
                }
              }
            }
          }
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});

/**
 * Which balances capacity is allowed to see. The rule is the household's own funding rules read
 * back: money that is locked up or already committed is not money a person can put toward the
 * rent, whatever it would do for them in a genuine emergency.
 */
describe("the balances capacity counts", () => {
  const AT_SIXTY_FIVE = 1_960;
  const person = (id: string, birthYear: number): SimPerson => ({ id, name: id, birthYear });
  /** Non-compounding, so a balance is exactly what the case says it is. */
  const account = (id: string, ownerId: string, taxProfile: SimAccountTaxProfile, dollars: number) =>
    new SimAccount({
      id,
      ownerId,
      liquid: false,
      taxProfile,
      openingBalanceCents: dollarsToCents(dollars),
      initialAnnualRate: 0,
    });

  const stateOf = (accounts: readonly SimAccount[], persons: readonly SimPerson[], goals: HouseholdSimInput["goals"] = []) =>
    initSimState({
      horizonMonths: 12,
      annualInflationRate: 0,
      startYear: 2026,
      persons,
      accounts: [...accounts],
      incomeSeries: [],
      expenseSeries: [],
      goals,
    } as HouseholdSimInput);

  /** A jurisdiction that says nothing but the one age this rule reads. */
  const withAccessAge = (age: number): Jurisdiction => ({ ...nullJurisdiction, penaltyFreeRetirementAge: age });

  it("counts cash and taxable investments in full", () => {
    const state = stateOf(
      [
        account("cash", "alex", CASH_INTEREST_TAX_PROFILE, 25_000),
        account("brokerage", "alex", CAPITAL_GAINS_TAX_PROFILE, 75_000),
      ],
      [person("alex", 1991)],
    );
    expect(capacityAssetsCentsByPerson(state, { year: 2026 }, nullJurisdiction).get("alex")).toBe(
      dollarsToCents(100_000),
    );
  });

  it("counts retirement savings only once their owner can draw on them without penalty", () => {
    const state = stateOf(
      [
        account("cash", "alex", CASH_INTEREST_TAX_PROFILE, 10_000),
        account("401k", "alex", PRE_TAX_TAX_PROFILE, 500_000),
        account("roth", "alex", TAX_EXEMPT_TAX_PROFILE, 200_000),
      ],
      [person("alex", AT_SIXTY_FIVE)],
    );
    const capacity = (year: number) =>
      capacityAssetsCentsByPerson(state, { year }, withAccessAge(59.5)).get("alex");

    // 59 in 2019, and locked: the engine prices no early-withdrawal penalty, so counting these
    // would claim an access the projection cannot model — and would hand a household's budget to
    // whichever partner had the larger 401(k) at forty.
    expect(capacity(2019)).toBe(dollarsToCents(10_000));
    // 60 in 2020, and both retirement accounts join the cash.
    expect(capacity(2020)).toBe(dollarsToCents(710_000));
    // A jurisdiction that states no such age never counts them at all.
    expect(capacityAssetsCentsByPerson(state, { year: 2030 }, nullJurisdiction).get("alex")).toBe(
      dollarsToCents(10_000),
    );
  });

  it("never counts a goal's fund, however liquid the account behind it is", () => {
    const state = stateOf(
      [
        account("cash", "alex", CASH_INTEREST_TAX_PROFILE, 20_000),
        account("fund-goal-1", "alex", CASH_INTEREST_TAX_PROFILE, 15_000),
        account("fund-goal-2", "alex", CAPITAL_GAINS_TAX_PROFILE, 60_000),
      ],
      [person("alex", 1991)],
      [
        { id: "goal-1", name: "Emergency fund", targetCents: dollarsToCents(15_000), fundAccountId: "fund-goal-1", priority: 0, scope: "shared", disposition: "retain", targetDate: "asap" },
        { id: "goal-2", name: "Home down payment", targetCents: dollarsToCents(60_000), fundAccountId: "fund-goal-2", priority: 1, scope: "shared", disposition: "retain", targetDate: 60 },
      ],
    );
    // An emergency fund and a down-payment fund are committed money. They still back their owner
    // in a real shortfall — `eligibleAssetsCentsByPerson` counts every balance — but "can survive
    // on it" and "is free to spend it on the rent" are different questions.
    expect(capacityAssetsCentsByPerson(state, { year: 2026 }, nullJurisdiction).get("alex")).toBe(
      dollarsToCents(20_000),
    );
  });

  it("keeps each person's balances to themselves", () => {
    const state = stateOf(
      [
        account("alex-cash", "alex", CASH_INTEREST_TAX_PROFILE, 40_000),
        account("blake-cash", "blake", CASH_INTEREST_TAX_PROFILE, 10_000),
      ],
      [person("alex", 1991), person("blake", 1989)],
    );
    const capacity = capacityAssetsCentsByPerson(state, { year: 2026 }, nullJurisdiction);
    expect(capacity.get("alex")).toBe(dollarsToCents(40_000));
    expect(capacity.get("blake")).toBe(dollarsToCents(10_000));
  });
});
