/**
 * What a person's share of the household's spending is weighed by.
 *
 * Proportional sharing asks one question — who can carry this month's rent — and the only honest
 * answer is recurring earning power. April is where that goes wrong if the weight is read off
 * charged take-home: the partner who under-withheld pays a balance and the partner who
 * over-withheld collects a refund, so for one month the earner looks broke and the person with no
 * job at all looks like the household's provider. The budget swings onto them, and swings back in
 * May. Neither swing describes anything about the household.
 *
 * So the weight puts the settlement back before it splits anything. Four things stay separate
 * throughout, and most cases below turn on the difference between two of them:
 *
 *  1. **Whose expense it is** — the share the split assigns, which nothing about a filing moves.
 *  2. **Whose tax it is** — the bill or the refund, fixed at the filing.
 *  3. **What actually funded it** — income first, then that person's own accounts.
 *  4. **Who helped** — the household covering what an owner's own money could not.
 */

import { describe, it, expect } from "vitest";
import { dollarsToCents } from "../money/cashFlowSeries";
import { runWaterfall, type IncomeSourceMonth } from "./waterfall";
import type { WaterfallInput } from "./waterfall.types";

const wages = (ownerId: string, cents: number): IncomeSourceMonth => ({
  ownerId,
  waterfallInflowCents: cents,
  taxCategory: "wages",
});

const socialSecurity = (ownerId: string, cents: number): IncomeSourceMonth => ({
  ownerId,
  waterfallInflowCents: cents,
  taxCategory: "governmentRetirementBenefit",
});

/** The household's whole monthly budget, shared. */
const RENT = dollarsToCents(3_000);

/** A month for Alex and Blake, sharing `RENT` proportionally, with no tax on the month's own pay. */
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

/** Each person's assigned share of `RENT`, whether their own money covered it or not. */
const sharesOf = (r: ReturnType<typeof runWaterfall>): Record<string, number> =>
  Object.fromEntries(r.obligationChargedByPersonCents);

describe("one partner owes April while the other is refunded", () => {
  const ALEX_BILL = dollarsToCents(2_000);
  const BLAKE_REFUND = dollarsToCents(1_500);

  /** Alex is the household's only earner. Blake stopped working and is owed last year's excess. */
  const april = () =>
    month({
      incomeSources: [wages("alex", dollarsToCents(4_000))],
      settlementCashCents: (pid) => (pid === "alex" ? ALEX_BILL : -BLAKE_REFUND),
    });

  it("leaves the whole budget with the person who actually earns", () => {
    // Read off charged take-home this month is $2,000 for Alex against $1,500 for Blake, and the
    // rent would split 4:3 — with Blake, who earns nothing, picking up $1,285 of it.
    expect(sharesOf(april())).toEqual({ alex: RENT, blake: 0 });
  });

  it("says exactly what an ordinary month says", () => {
    // The point of the fix in one line: April is not a month in which anybody's responsibility
    // for the household changed.
    expect(sharesOf(april())).toEqual(sharesOf(month({ incomeSources: [wages("alex", dollarsToCents(4_000))] })));
  });

  it("still charges Alex the bill and still hands Blake the refund", () => {
    // The expense moved back to Alex; the tax did not move at all. Alex's month is their pay less
    // their own bill, and the refund is Blake's money, in Blake's account, unspent.
    const r = april();
    expect(r.netCashFlowByPersonCents.get("alex")).toBe(dollarsToCents(4_000) - ALEX_BILL - RENT);
    expect(r.netCashFlowByPersonCents.get("blake")).toBe(BLAKE_REFUND);
    expect(r.accountDepositsCents.get("blake-savings")).toBe(BLAKE_REFUND);
  });

  it("holds the same way round", () => {
    const r = month({
      incomeSources: [wages("blake", dollarsToCents(4_000))],
      settlementCashCents: (pid) => (pid === "blake" ? ALEX_BILL : -BLAKE_REFUND),
    });
    expect(sharesOf(r)).toEqual({ alex: 0, blake: RENT });
    expect(r.netCashFlowByPersonCents.get("alex")).toBe(BLAKE_REFUND);
  });
});

describe("two earners, and April happening to one of them", () => {
  const BOTH = [wages("alex", dollarsToCents(6_000)), wages("blake", dollarsToCents(2_000))];

  it("splits by the salaries, not by what April left in the accounts", () => {
    // 3:1 on pay. Alex's $5,000 bill would otherwise make it 1:2 the other way.
    const r = month({ incomeSources: BOTH, settlementCashCents: (pid) => (pid === "alex" ? dollarsToCents(5_000) : 0) });
    expect(sharesOf(r)).toEqual({ alex: dollarsToCents(2_250), blake: dollarsToCents(750) });
    expect(sharesOf(r)).toEqual(sharesOf(month({ incomeSources: BOTH })));
  });

  it("is unmoved when both are refunded, however lopsided the refunds", () => {
    // Refunds are last year's wages coming back. Blake's is four times Alex's and buys Blake no
    // more of the rent for it.
    const r = month({
      incomeSources: BOTH,
      settlementCashCents: (pid) => (pid === "alex" ? -dollarsToCents(500) : -dollarsToCents(2_000)),
    });
    expect(sharesOf(r)).toEqual({ alex: dollarsToCents(2_250), blake: dollarsToCents(750) });
  });
});

describe("households with no wages to weigh", () => {
  it("weighs two retirements by their benefits", () => {
    // Recurring income is recurring income: a longer earnings record carries more of the rent,
    // exactly as a bigger salary does.
    const r = month({
      incomeSources: [socialSecurity("alex", dollarsToCents(3_000)), socialSecurity("blake", dollarsToCents(1_000))],
    });
    expect(sharesOf(r)).toEqual({ alex: dollarsToCents(2_250), blake: dollarsToCents(750) });
  });

  it("keeps weighing them by their benefits through their April", () => {
    const r = month({
      incomeSources: [socialSecurity("alex", dollarsToCents(3_000)), socialSecurity("blake", dollarsToCents(1_000))],
      settlementCashCents: (pid) => (pid === "alex" ? dollarsToCents(2_800) : -dollarsToCents(900)),
    });
    expect(sharesOf(r)).toEqual({ alex: dollarsToCents(2_250), blake: dollarsToCents(750) });
  });

  it("falls to what each person has saved when nobody has income at all", () => {
    const r = month({
      eligibleAssetsCentsByPerson: (pid) =>
        pid === "alex" ? dollarsToCents(300_000) : dollarsToCents(100_000),
    });
    expect(sharesOf(r)).toEqual({ alex: dollarsToCents(2_250), blake: dollarsToCents(750) });
  });

  it("shares it equally when there is neither income nor savings to weigh by", () => {
    // The last rung. Nobody can pay, so the whole rent is a shortfall either way — but a share
    // still has to be assigned, or the month reports as though it cost the household nothing.
    const r = month();
    expect(sharesOf(r)).toEqual({ alex: dollarsToCents(1_500), blake: dollarsToCents(1_500) });
    expect(r.shortfallCents).toBe(RENT);
  });

  it("does not let a lone refund decide the whole split", () => {
    // The trap the ladder exists for: one person's refund is the household's only positive cash,
    // and reading it as income would hand them every cent of the rent. It is not income, so the
    // split drops to the next rung — and Blake, who holds the savings, carries the month.
    const r = month({
      settlementCashCents: (pid) => (pid === "alex" ? -dollarsToCents(1_200) : 0),
      eligibleAssetsCentsByPerson: (pid) => (pid === "blake" ? dollarsToCents(80_000) : 0),
    });
    expect(sharesOf(r)).toEqual({ alex: 0, blake: RENT });
  });
});

describe("a share its owner cannot fund", () => {
  /** Alex earns $4,000 and owes all of it to April; Blake earns $1,000. */
  const squeezed = () =>
    month({
      incomeSources: [wages("alex", dollarsToCents(4_000)), wages("blake", dollarsToCents(1_000))],
      settlementCashCents: (pid) => (pid === "alex" ? dollarsToCents(4_000) : 0),
      eligibleAssetsCentsByPerson: (pid) => (pid === "blake" ? dollarsToCents(50_000) : 0),
    });

  it("keeps the share with its owner even though their income is entirely spoken for", () => {
    // Alex's take-home is nil, and the responsibility is still Alex's — 4:1 on recurring pay.
    expect(sharesOf(squeezed())).toEqual({ alex: dollarsToCents(2_400), blake: dollarsToCents(600) });
  });

  it("sends the unfunded part to the household, which draws from whoever has the money", () => {
    // Assistance, not reassignment. None of Alex's $2,400 could come out of income, so all of it
    // reaches the cascade — which prefers the accounts that exist, and the only ones here are
    // Blake's. What Alex owes is unchanged by whose account settles it.
    const r = squeezed();
    expect(r.shortfallCents).toBe(dollarsToCents(2_400));
    expect(r.obligationShortfallByPersonCents.get("blake")).toBe(dollarsToCents(2_400));
    expect(r.obligationShortfallByPersonCents.get("alex")).toBe(0);
    expect(r.obligationChargedByPersonCents.get("alex")).toBe(dollarsToCents(2_400));
  });
});

describe("the split setting itself", () => {
  it("leaves an even household exactly even, whatever April did", () => {
    // Proportional is the default; even is a choice, and it is a choice about the rent rather
    // than about anybody's tax.
    const r = month({
      sharedScheme: "even",
      incomeSources: [wages("alex", dollarsToCents(9_000))],
      settlementCashCents: (pid) => (pid === "alex" ? dollarsToCents(6_000) : -dollarsToCents(2_000)),
    });
    expect(sharesOf(r)).toEqual({ alex: dollarsToCents(1_500), blake: dollarsToCents(1_500) });
  });

  it("assigns every cent of the budget, under every combination of pay and filing", () => {
    // The invariant the whole split rests on: two people's shares are the household's spending,
    // exactly, with no rounding lost between them and nothing left unattributed.
    const pays = [0, 1, 3_333, 10_000];
    const settlements = [0, -4_321, -1_000, 2_500, 12_000];
    const wrong: string[] = [];
    for (const scheme of ["proportional", "even"] as const) {
      for (const alexPay of pays) {
        for (const blakePay of pays) {
          for (const alexSettlement of settlements) {
            for (const blakeSettlement of settlements) {
              const r = month({
                sharedScheme: scheme,
                incomeSources: [wages("alex", dollarsToCents(alexPay)), wages("blake", dollarsToCents(blakePay))],
                settlementCashCents: (pid) =>
                  dollarsToCents(pid === "alex" ? alexSettlement : blakeSettlement),
                eligibleAssetsCentsByPerson: () => dollarsToCents(10_000),
              });
              const assigned = [...r.obligationChargedByPersonCents.values()].reduce((s, c) => s + c, 0);
              if (assigned !== RENT) {
                wrong.push(`${scheme} ${alexPay}/${blakePay} ${alexSettlement}/${blakeSettlement}: ${assigned}`);
              }
            }
          }
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});
