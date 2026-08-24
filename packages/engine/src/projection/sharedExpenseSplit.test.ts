/**
 * The authored shared-expense split: one number per partnership, written by the household and
 * changed by nobody else.
 *
 * There is no strategy here to choose and no second mode to fall into. 50/50 is a percentage the
 * field opens on, not a scheme; 70/30 is the same field with a different number in it. Everything
 * this file asserts follows from that one idea, and most of it is about what the split does NOT
 * do — a raise, a job loss, retirement, a bonus, an April bill, an April refund and a changed
 * balance are all things a household notices and none of them is a reason for a number somebody
 * typed to move.
 *
 * Three quantities stay apart throughout, and nearly every case below turns on two of them:
 *
 *  1. **Assigned** — the authored percentage of the month's shared spending.
 *  2. **Funded** — what that person's own money actually covered of it.
 *  3. **Assisted** — the difference, which the other partner paid and which changes neither (1).
 */

import { describe, it, expect } from "vitest";
import { dollarsToCents } from "../money/cashFlowSeries";
import { runWaterfall, type IncomeSourceMonth } from "./waterfall";
import type { WaterfallInput, WaterfallResult } from "./waterfall.types";

const wages = (ownerId: string, cents: number): IncomeSourceMonth => ({
  ownerId,
  waterfallInflowCents: cents,
  taxCategory: "wages",
});

const bonus = (ownerId: string, cents: number): IncomeSourceMonth => ({
  ownerId,
  waterfallInflowCents: cents,
  supplementalCents: cents,
  taxCategory: "wages",
});

const socialSecurity = (ownerId: string, cents: number): IncomeSourceMonth => ({
  ownerId,
  waterfallInflowCents: cents,
  taxCategory: "governmentRetirementBenefit",
});

/** The household's whole monthly budget, shared. */
const RENT = dollarsToCents(3_000);

/** Alex and Blake, sharing `RENT`, with no tax on the month's own pay. */
function month(over: Partial<WaterfallInput> = {}): WaterfallResult {
  return runWaterfall({
    personIds: ["alex", "blake"],
    incomeSources: [wages("alex", dollarsToCents(6_000)), wages("blake", dollarsToCents(2_000))],
    sharedObligationCents: RENT,
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

/** An authored split, stated the way the household states it: one percent per person. */
const split = (alex: number, blake: number) => (pid: string) => (pid === "alex" ? alex : blake);

/** Each person's ASSIGNED share of `RENT`, whether their own money covered it or not. */
const assigned = (r: WaterfallResult): Record<string, number> =>
  Object.fromEntries(r.obligationChargedByPersonCents);

describe("the number the household wrote", () => {
  it("splits a partnership down the middle when nobody has said otherwise", () => {
    // Not a mode and not a fallback: an absent percentage MEANS half, which is what a new
    // partnership starts on and what a scenario saved before the field existed replays as.
    expect(assigned(month())).toEqual({ alex: dollarsToCents(1_500), blake: dollarsToCents(1_500) });
  });

  it("assigns 100% to the only person there is", () => {
    const alone = runWaterfall({
      personIds: ["alex"],
      incomeSources: [wages("alex", dollarsToCents(6_000))],
      sharedObligationCents: RENT,
      surplusDestination: { kind: "idle" },
      goals: [],
      accountBalanceCents: () => 0,
      liquidAccountId: "alex-savings",
      remainingDeferralRoomCents: () => Infinity,
      remainingCombinedDepositRoomCents: () => Infinity,
      payPeriodsPerYear: 12,
      periodsRemainingInTaxYear: 12,
      surplusAccountIdForPerson: (pid) => `${pid}-savings`,
    });
    expect(alone.obligationChargedByPersonCents.get("alex")).toBe(RENT);
  });

  it("charges exactly what was authored, at every percentage from 0 to 100", () => {
    // Including both ends. 0/100 and 100/0 are ordinary answers — one partner carrying the whole
    // household is a real arrangement, not an edge case to be clamped away from.
    const wrong: string[] = [];
    for (let alexPct = 0; alexPct <= 100; alexPct++) {
      const r = month({ sharedSharePercentOf: split(alexPct, 100 - alexPct) });
      const alex = r.obligationChargedByPersonCents.get("alex") ?? 0;
      const blake = r.obligationChargedByPersonCents.get("blake") ?? 0;
      if (alex !== Math.round((RENT * alexPct) / 100)) wrong.push(`${alexPct}: alex ${alex}`);
      if (alex + blake !== RENT) wrong.push(`${alexPct}: sums to ${alex + blake}`);
    }
    expect(wrong).toEqual([]);
  });

  it("gives the whole budget to one person at 100/0, and none of it to the other", () => {
    expect(assigned(month({ sharedSharePercentOf: split(100, 0) }))).toEqual({
      alex: RENT,
      blake: 0,
    });
    expect(assigned(month({ sharedSharePercentOf: split(0, 100) }))).toEqual({
      alex: 0,
      blake: RENT,
    });
  });

  it("assigns every cent of an odd budget, at every percentage", () => {
    // Cumulative rounding rather than two independent multiplications, which is what keeps the
    // odd cent attributed instead of lost: a household that spends $1,000.01 spends all of it.
    const wrong: string[] = [];
    for (const budget of [1, 7, 99, 100_001, 333_333, 1_000_001]) {
      for (let alexPct = 0; alexPct <= 100; alexPct++) {
        const r = month({
          sharedObligationCents: budget,
          sharedSharePercentOf: split(alexPct, 100 - alexPct),
        });
        const total = [...r.obligationChargedByPersonCents.values()].reduce((s, c) => s + c, 0);
        if (total !== budget) wrong.push(`${budget} at ${alexPct}: ${total}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("what an authored split does not respond to", () => {
  const SEVENTY_THIRTY = { sharedSharePercentOf: split(70, 30) };
  const baseline = month(SEVENTY_THIRTY);

  /** The same 70/30 household, with one thing about it changed. */
  const changed = (over: Partial<WaterfallInput>) => month({ ...SEVENTY_THIRTY, ...over });

  it("stays 70/30 when either partner gets a raise", () => {
    expect(assigned(changed({ incomeSources: [wages("alex", dollarsToCents(20_000)), wages("blake", dollarsToCents(2_000))] }))).toEqual(assigned(baseline));
    expect(assigned(changed({ incomeSources: [wages("alex", dollarsToCents(6_000)), wages("blake", dollarsToCents(30_000))] }))).toEqual(assigned(baseline));
  });

  it("stays 70/30 when a partner loses their job entirely", () => {
    expect(assigned(changed({ incomeSources: [wages("alex", dollarsToCents(6_000))] }))).toEqual(
      assigned(baseline),
    );
    expect(assigned(changed({ incomeSources: [wages("blake", dollarsToCents(2_000))] }))).toEqual(
      assigned(baseline),
    );
    // Including the household with no income at all: the rent is still owed, and still 70/30.
    expect(assigned(changed({ incomeSources: [] }))).toEqual(assigned(baseline));
  });

  it("stays 70/30 when the paychecks become pensions", () => {
    // Retirement is not a mode this split has to switch into. One rule covers a working household
    // and a retired one, because the rule never looked at where the money came from.
    expect(
      assigned(
        changed({
          incomeSources: [
            socialSecurity("alex", dollarsToCents(2_400)),
            socialSecurity("blake", dollarsToCents(1_900)),
          ],
        }),
      ),
    ).toEqual(assigned(baseline));
  });

  it("stays 70/30 through a bonus, however lopsided", () => {
    expect(
      assigned(
        changed({
          incomeSources: [
            wages("alex", dollarsToCents(6_000)),
            wages("blake", dollarsToCents(2_000)),
            bonus("blake", dollarsToCents(50_000)),
          ],
        }),
      ),
    ).toEqual(assigned(baseline));
  });

  it("stays 70/30 through an April bill and an April refund", () => {
    // The month a weighted split gets most obviously wrong: the under-withheld partner pays and
    // the over-withheld one collects, so for one month the earner looks broke and the person with
    // no job at all looks like the household's provider. Nothing here reads either figure.
    expect(
      assigned(
        changed({ settlementCashCents: (pid) => (pid === "alex" ? dollarsToCents(9_000) : -dollarsToCents(4_000)) }),
      ),
    ).toEqual(assigned(baseline));
    expect(
      assigned(changed({ settlementCashCents: (pid) => (pid === "blake" ? -dollarsToCents(4_000) : 0) })),
    ).toEqual(assigned(baseline));
  });

  it("stays 70/30 however the account balances stand", () => {
    // Two households identical but for who holds the money. The split is the same in both,
    // because a balance is not a share and was never asked to be one.
    expect(assigned(changed({ accountBalanceCents: () => dollarsToCents(4_000_000) }))).toEqual(
      assigned(baseline),
    );
    expect(assigned(changed({ accountBalanceCents: () => 0 }))).toEqual(assigned(baseline));
  });

  it("stays 70/30 when a personal debt of one partner's arrives", () => {
    // A personal obligation is charged to its owner BEFORE the shared split runs and takes their
    // take-home with it. The shared share is unmoved: whose rent it is and what else they owe are
    // different questions.
    const r = changed({ personalObligationCentsByPerson: (pid) => (pid === "blake" ? dollarsToCents(1_500) : 0) });
    expect(r.obligationChargedByPersonCents.get("alex")).toBe(dollarsToCents(2_100));
    expect(r.obligationChargedByPersonCents.get("blake")).toBe(
      dollarsToCents(900) + dollarsToCents(1_500),
    );
  });
});

describe("best effort: assigned, funded, and who helped", () => {
  /**
   * The spec's own example. Shared spending $5,000 on an authored 70/30, and Blake's take-home is
   * only $900 — so Blake's $1,500 share is $600 short of what Blake can pay.
   */
  const example = () =>
    runWaterfall({
      personIds: ["alex", "blake"],
      incomeSources: [wages("alex", dollarsToCents(6_000)), wages("blake", dollarsToCents(900))],
      sharedObligationCents: dollarsToCents(5_000),
      sharedSharePercentOf: split(70, 30),
      surplusDestination: { kind: "idle" },
      goals: [],
      accountBalanceCents: () => 0,
      liquidAccountId: "alex-savings",
      remainingDeferralRoomCents: () => Infinity,
      remainingCombinedDepositRoomCents: () => Infinity,
      payPeriodsPerYear: 12,
      periodsRemainingInTaxYear: 12,
      surplusAccountIdForPerson: (pid) => `${pid}-savings`,
    });

  it("assigns $3,500 and $1,500, whatever either of them can pay", () => {
    expect(assigned(example())).toEqual({
      alex: dollarsToCents(3_500),
      blake: dollarsToCents(1_500),
    });
  });

  it("has the partner who cannot cover their share contribute what they can", () => {
    // $900 of $1,500. Not zero, and not $1,500 either — best effort is a real partial payment.
    expect(example().obligationFundedByPersonCents.get("blake")).toBe(dollarsToCents(900));
    expect(example().obligationFundedByPersonCents.get("alex")).toBe(dollarsToCents(3_500));
  });

  it("leaves the missing $600 with its owner, so the household covers it as assistance", () => {
    // Blake's gap is Blake's, which is what makes the cascade spend Blake's own accounts on it
    // before it reaches for Alex's. Only once Blake's money is gone does Alex's arrive — and it
    // arrives as help, not as a larger share.
    const r = example();
    expect(r.obligationShortfallByPersonCents.get("blake")).toBe(dollarsToCents(600));
    expect(r.obligationShortfallByPersonCents.get("alex")).toBe(0);
    expect(r.shortfallCents).toBe(dollarsToCents(600));
  });

  it("keeps the three figures distinguishable, and does not relabel help as a new split", () => {
    // The claim in one assertion. If Alex's $600 of help were folded into the split, this month
    // would read 82/18 and the household would be told its arrangement had changed. It has not:
    // the authored responsibility is still 70/30, and the difference is named as assistance.
    const r = example();
    const chargedAlex = r.obligationChargedByPersonCents.get("alex")!;
    const chargedBlake = r.obligationChargedByPersonCents.get("blake")!;
    expect(chargedAlex / (chargedAlex + chargedBlake)).toBeCloseTo(0.7, 6);
    const assistedBlake = chargedBlake - r.obligationFundedByPersonCents.get("blake")!;
    expect(assistedBlake).toBe(dollarsToCents(600));
    // And nobody is assisted twice: the household's own funding is what it is.
    expect(chargedAlex + chargedBlake).toBe(dollarsToCents(5_000));
  });

  it("keeps whatever neither of them can fund as a household shortfall", () => {
    // Both short. The rest is a shortfall for the cascade and, failing that, for debt — the
    // existing behaviour, reached through an authored split rather than a weighted one.
    const r = runWaterfall({
      personIds: ["alex", "blake"],
      incomeSources: [wages("alex", dollarsToCents(400)), wages("blake", dollarsToCents(300))],
      sharedObligationCents: dollarsToCents(5_000),
      sharedSharePercentOf: split(70, 30),
      surplusDestination: { kind: "idle" },
      goals: [],
      accountBalanceCents: () => 0,
      liquidAccountId: "alex-savings",
      remainingDeferralRoomCents: () => Infinity,
      remainingCombinedDepositRoomCents: () => Infinity,
      payPeriodsPerYear: 12,
      periodsRemainingInTaxYear: 12,
      surplusAccountIdForPerson: (pid) => `${pid}-savings`,
    });
    expect(r.shortfallCents).toBe(dollarsToCents(5_000 - 700));
    expect(r.obligationShortfallByPersonCents.get("alex")).toBe(dollarsToCents(3_500 - 400));
    expect(r.obligationShortfallByPersonCents.get("blake")).toBe(dollarsToCents(1_500 - 300));
  });
});

describe("what the split does not own", () => {
  it("banks a refund to the person who was refunded, whatever their share is", () => {
    // Blake carries 0% of the household and is still owed last year's money. A split is a claim
    // about spending, never about income, and least of all about somebody's tax.
    const r = month({
      sharedSharePercentOf: split(100, 0),
      settlementCashCents: (pid) => (pid === "blake" ? -dollarsToCents(1_200) : 0),
    });
    expect(r.accountDepositsCents.get("blake-savings")).toBe(
      dollarsToCents(2_000) + dollarsToCents(1_200),
    );
    expect(r.accountDepositsCents.get("alex-savings") ?? 0).toBe(dollarsToCents(6_000) - RENT);
  });

  it("leaves a tax bill with its owner even when the other partner's money settles it", () => {
    // Alex owes $9,000 against $6,000 of pay. The bill is Alex's — it is docked from Alex's own
    // take-home and takes it negative — and the household finds the rest. Whose liability it was
    // and whose cash moved are two different facts, and both survive the month.
    const r = month({
      sharedSharePercentOf: split(0, 100),
      settlementCashCents: (pid) => (pid === "alex" ? dollarsToCents(9_000) : 0),
    });
    expect(r.netCashFlowByPersonCents.get("alex")).toBe(dollarsToCents(6_000 - 9_000));
    // Blake authored 100% of the household's spending and pays not one cent more for Alex's
    // filing: the shortfall it opens is charged to nobody's share.
    expect(r.obligationChargedByPersonCents.get("blake")).toBe(RENT);
    expect(r.obligationChargedByPersonCents.get("alex")).toBe(0);
  });

  it("keeps a personally owned debt personal at every percentage", () => {
    const wrong: string[] = [];
    for (const pct of [0, 30, 50, 70, 100]) {
      const r = month({
        sharedSharePercentOf: split(pct, 100 - pct),
        incomeSources: [wages("alex", dollarsToCents(6_000))],
        personalObligationCentsByPerson: (pid) => (pid === "blake" ? dollarsToCents(1_200) : 0),
      });
      // Blake earns nothing this month, so the whole of Blake's own debt is unfunded — and it is
      // attributed to Blake, so Blake's own accounts are sold for it before Alex's ever are.
      const blakeShort = r.obligationShortfallByPersonCents.get("blake") ?? 0;
      const blakeShare = Math.round((RENT * (100 - pct)) / 100);
      if (blakeShort !== dollarsToCents(1_200) + blakeShare) {
        wrong.push(`${pct}: blake short ${blakeShort}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("the household the split applies to", () => {
  it("charges only the people who are actually here", () => {
    // A former partner is still on the run's roster — their own take-home in the month they left
    // is still theirs to account for — and has no share of a household they are not in.
    const r = month({
      personIds: ["alex", "blake", "casey"],
      householdMemberIds: ["alex", "casey"],
      incomeSources: [wages("alex", dollarsToCents(6_000)), wages("casey", dollarsToCents(3_000))],
      sharedSharePercentOf: (pid) => (pid === "casey" ? 40 : pid === "alex" ? 60 : 0),
    });
    expect(assigned(r)).toEqual({
      alex: dollarsToCents(1_800),
      blake: 0,
      casey: dollarsToCents(1_200),
    });
  });

  it("returns the remaining person to 100% when the household narrows to one", () => {
    const r = month({
      personIds: ["alex", "blake"],
      householdMemberIds: ["alex"],
      sharedSharePercentOf: (pid) => (pid === "alex" ? 100 : 30),
    });
    expect(assigned(r)).toEqual({ alex: RENT, blake: 0 });
  });

  it("gives the remaining person the whole budget even if the departed partner's number lingers", () => {
    // Belt and braces on the same rule: the split is renormalized over the members who are here,
    // so a stale 30 on somebody who left cannot leave 30% of the rent unattributed.
    const r = month({
      personIds: ["alex", "blake"],
      householdMemberIds: ["alex"],
      sharedSharePercentOf: (pid) => (pid === "alex" ? 70 : 30),
    });
    expect(assigned(r)).toEqual({ alex: RENT, blake: 0 });
  });
});
