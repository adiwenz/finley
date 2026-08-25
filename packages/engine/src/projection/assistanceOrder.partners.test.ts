/**
 * The order a household spends itself in — and specifically, the two rungs that used to be one.
 *
 * A person's authored share walks their own resources first: their income, then their accounts.
 * What neither can reach has to come from the other partner, and there the household has TWO
 * things to offer, which are not interchangeable. Spending a partner's unspent pay costs the
 * balance sheet nothing. Selling a partner's holding shrinks it — and if their pay was going to
 * be swept into savings anyway, the sale bought cash the household already had.
 *
 * The pooled fallback used to reach straight for the accounts, so a household with $2,000 of
 * unspent income liquidated a position to find $200. These tests pin the whole order:
 *
 *   own income → own accounts → partner's excess income → partner's accounts → credit
 *
 * Each case asserts the funding AND the balances, because the two can only be told apart by
 * looking: "Alex covered it" is true of both the right answer and the wrong one.
 */

import { describe, it, expect } from "vitest";
import { Projection } from "../index";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import type { ScenarioInput } from "../input/scenarioInput";
import { dollarsToCents } from "../money/cashFlowSeries";
import {
  ALEX_SAVINGS,
  blakeSavings,
  partnerHousehold as household,
  type PartnerHouseholdOverrides,
} from "./partnerHousehold.testSupport";
import type { ResolvedFunding } from "./resolvedFunding";

/** The month every assertion reads. Month 0 is a processed month, so its own flows are real. */
const M = 0;

const ALEX = "p1";

interface MonthView {
  readonly charged: Readonly<Record<string, number>>;
  readonly fundedFromOwnIncome: Readonly<Record<string, number>>;
  readonly assistanceReceived: Readonly<Record<string, number>>;
  readonly assistanceGiven: Readonly<Record<string, number>>;
  readonly leftover: Readonly<Record<string, number>>;
  readonly drawnByAccount: ReadonlyMap<string, number>;
  readonly balanceChange: ReadonlyMap<string, number>;
  readonly blake: string;
}

function monthAt(over: PartnerHouseholdOverrides): MonthView {
  return viewOf(household(over));
}

function viewOf(input: ScenarioInput): MonthView {
  const built = Projection.fromInput(input, nullJurisdiction);
  if (!built.ok) throw new Error(`scenario refused: ${built.error.reason}`);
  const series = built.projection.run(nullJurisdiction).series;
  const month = series.months[M]!;
  const flows = month.flows!;
  const drawn = new Map<string, number>();
  for (const record of flows.resolvedFunding as readonly ResolvedFunding[]) {
    for (const source of record.sources) {
      if (source.kind !== "account") continue;
      drawn.set(source.sourceId, (drawn.get(source.sourceId) ?? 0) + source.amountCents);
    }
  }
  // Against the balances the month OPENED on, so a draw shows as the fall it is.
  const balanceChange = new Map<string, number>();
  for (const [id, ending] of Object.entries(month.accountBalancesCents)) {
    balanceChange.set(id, ending - (series.opening.accountBalancesCents[id] ?? 0));
  }
  return {
    charged: flows.obligationChargedByPersonCents,
    fundedFromOwnIncome: flows.obligationFundedByPersonCents,
    assistanceReceived: flows.assistanceReceivedByPersonCents,
    assistanceGiven: flows.assistanceGivenByPersonCents,
    leftover: flows.leftoverByPersonCents,
    drawnByAccount: drawn,
    balanceChange,
    blake: blakeSavings(Object.keys(month.accountBalancesCents)),
  };
}

/** Blake's person id — whichever key of the per-person maps is not the primary's. */
function blakeId(view: MonthView): string {
  const id = Object.keys(view.charged).find((k) => k !== ALEX);
  if (id === undefined) throw new Error("the household has no partner");
  return id;
}

describe("a partner's unspent pay is spent before a partner's accounts", () => {
  it("does not touch the partner at all while the short person's own accounts can cover it", () => {
    // $2,700 each. Blake's $1,200 of pay leaves $1,500 of their own share unfunded and their own
    // $30,000 covers it outright — so the question of who helps never arises, and neither
    // Alex's pay nor Alex's savings is asked for a cent.
    const view = monthAt({ sharePercent: 50 });

    expect(view.assistanceReceived[blakeId(view)] ?? 0).toBe(0);
    expect(view.assistanceGiven[ALEX] ?? 0).toBe(0);
    expect(view.drawnByAccount.get(view.blake)).toBe(dollarsToCents(1_500));
    expect(view.drawnByAccount.has(ALEX_SAVINGS)).toBe(false);
    // Alex's whole surplus reaches Alex's savings, untouched by the month.
    expect(view.balanceChange.get(ALEX_SAVINGS)).toBe(dollarsToCents(4_000 - 2_700));
  });

  it("covers the remainder from the partner's income once the short person's accounts are spent", () => {
    // Blake carries all $5,400 on $1,200 of pay and $500 of savings: $4,200 unfunded, $500 of it
    // within their own reach, $3,700 beyond it. Alex is assigned nothing and has $4,000 of pay
    // doing nothing — so that is what pays, and Alex's $30,000 is never sold.
    const view = monthAt({ sharePercent: 100, blakeSavingsDollars: 500 });
    const blake = blakeId(view);

    expect(view.assistanceReceived[blake]).toBe(dollarsToCents(3_700));
    expect(view.assistanceGiven[ALEX]).toBe(dollarsToCents(3_700));
    expect(view.drawnByAccount.get(view.blake)).toBe(dollarsToCents(500));
    expect(view.drawnByAccount.has(ALEX_SAVINGS)).toBe(false);
    // Blake's own account emptied, Alex's balance sheet intact.
    expect(view.balanceChange.get(view.blake)).toBe(-dollarsToCents(500));
  });

  it("falls through to the partner's accounts for what their income could not reach", () => {
    // The same $4,200 gap, but Alex earns only $1,000. Their pay goes first and covers $1,000 of
    // it; the remaining $2,700 is what a sale is actually FOR.
    const view = monthAt({ sharePercent: 100, blakeSavingsDollars: 500, alexMonthlyDollars: 1_000 });
    const blake = blakeId(view);

    expect(view.assistanceReceived[blake]).toBe(dollarsToCents(1_000));
    expect(view.drawnByAccount.get(view.blake)).toBe(dollarsToCents(500));
    expect(view.drawnByAccount.get(ALEX_SAVINGS)).toBe(dollarsToCents(2_700));
    expect(view.balanceChange.get(ALEX_SAVINGS)).toBe(-dollarsToCents(2_700));
    expect(view.balanceChange.get(view.blake)).toBe(-dollarsToCents(500));
  });

  it("still reaches the partner's accounts when there is no spare income anywhere", () => {
    // Alex's $2,700 of pay is exactly their own $2,700 share, so nothing is spare. Blake is
    // short $1,500 with no savings of their own, and the account fallback is the only thing left
    // — the behaviour this change is careful NOT to remove.
    const view = monthAt({ sharePercent: 50, blakeSavingsDollars: 0, alexMonthlyDollars: 2_700 });
    const blake = blakeId(view);

    expect(view.assistanceReceived[blake] ?? 0).toBe(0);
    expect(view.drawnByAccount.get(ALEX_SAVINGS)).toBe(dollarsToCents(1_500));
    expect(view.balanceChange.get(ALEX_SAVINGS)).toBe(-dollarsToCents(1_500));
  });

  it("leaves the authored split and each person's own funding exactly where they were", () => {
    // The whole point of routing help through its own figure. Blake still OWES the $5,400 they
    // authored, and still funded only the $1,200 their own pay reached — a household that helped
    // is not a household that renegotiated.
    const view = monthAt({ sharePercent: 100, blakeSavingsDollars: 500 });
    const blake = blakeId(view);

    expect(view.charged[blake]).toBe(dollarsToCents(5_400));
    expect(view.charged[ALEX]).toBe(0);
    expect(view.fundedFromOwnIncome[blake]).toBe(dollarsToCents(1_200));
    expect(view.fundedFromOwnIncome[ALEX]).toBe(0);
  });

  it("does not bank the assisting income as surplus as well", () => {
    // The cents handed over leave the giver's leftover, which is the pool goals and the surplus
    // sweep are funded out of. Counting the same $3,700 as both help and savings would show a
    // household banking money it had already spent — and the balances alone cannot catch it,
    // since cash is conserved whichever rung paid.
    const view = monthAt({ sharePercent: 100, blakeSavingsDollars: 500 });

    expect(view.leftover[ALEX]).toBe(dollarsToCents(4_000 - 3_700));
    expect(view.balanceChange.get(ALEX_SAVINGS)).toBe(dollarsToCents(300));
  });

  it("conserves the household's cents however the help is split", () => {
    // Charged === funded from own income + assistance + what the accounts and the cascade found.
    // Asserted as one sum rather than line by line, because the failure this guards against is
    // a rung of the order that quietly funds the same cent twice.
    const view = monthAt({ sharePercent: 100, blakeSavingsDollars: 500, alexMonthlyDollars: 1_000 });
    const totalOf = (byPerson: Readonly<Record<string, number>>): number =>
      Object.values(byPerson).reduce((sum, cents) => sum + cents, 0);
    const drawnTotal = [...view.drawnByAccount.values()].reduce((sum, cents) => sum + cents, 0);

    expect(totalOf(view.assistanceReceived)).toBe(totalOf(view.assistanceGiven));
    expect(totalOf(view.charged)).toBe(
      totalOf(view.fundedFromOwnIncome) + totalOf(view.assistanceReceived) + drawnTotal,
    );
  });

  it("never drives an account below zero, however long the household runs short", () => {
    // Every rung capped at what it actually holds. Run to the horizon on a budget nobody can
    // meet, so each rung is exhausted in turn and the cascade takes over.
    const built = Projection.fromInput(
      household({ sharePercent: 100, blakeSavingsDollars: 500, alexMonthlyDollars: 1_000 }),
      nullJurisdiction,
    );
    if (!built.ok) throw new Error(`scenario refused: ${built.error.reason}`);
    const series = built.projection.run(nullJurisdiction).series;

    for (const month of series.months) {
      for (const [id, cents] of Object.entries(month.accountBalancesCents)) {
        expect(`${id}@${month.month}: ${cents}`).toBe(`${id}@${month.month}: ${Math.max(0, cents)}`);
      }
    }
  });
});
