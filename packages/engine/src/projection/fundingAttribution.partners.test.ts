/**
 * Whose account paid — the name a "Funded by" row puts on a savings draw.
 *
 * The attribution walk consumes the month's supply in cascade order, and the liquid layer of that
 * supply is a CASH BUFFER PER OWNER, not one household pot. Reporting it against a single account
 * threw the ownership away and named whichever buffer the roster listed first: in a two-earner
 * household where one partner's pay covered their share and the other's did not, the panel showed
 * the draw against the FIRST partner's savings — the balance that had gone UP that month — while
 * the balance that actually fell was the other's.
 *
 * So each case below asserts the same two things together, and they are the whole point of the
 * file: which account the attribution NAMES, and which account's balance actually MOVED. A test
 * that checked only the first would have passed against the bug for as long as the household had
 * one member.
 */

import { describe, it, expect } from "vitest";
import { Projection } from "../index";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import { ref } from "../input/scenarioInput";
import type { ScenarioInput } from "../input/scenarioInput";
import { dollarsToCents } from "../money/cashFlowSeries";
import type { ResolvedFunding } from "./resolvedFunding";

const START_YEAR = 2026;
const BUDGET = dollarsToCents(5_400);

/** The month every assertion reads. Month 0 is a processed month, so its own flows are real. */
const M = 0;

/**
 * Alex and Blake, both earning, against one shared budget neither paycheck alone can cover.
 *
 * Every return is 0 and there are no goals, so a balance moves for exactly one reason — something
 * drew on it — and "the balance that fell" is an unambiguous fact rather than a draw net of a
 * month's interest. Alex out-earns Blake, so which of them comes up short is decided by the
 * authored split alone, which is what makes the same fixture answer for 50/50, 70/30 and both
 * extremes.
 */
function household(over: {
  readonly sharePercent?: number;
  readonly alexMonthlyDollars?: number;
  readonly blakeMonthlyDollars?: number;
  readonly alexSavingsDollars?: number;
  readonly blakeSavingsDollars?: number;
}): ScenarioInput {
  const alexPay = over.alexMonthlyDollars ?? 4_000;
  const blakePay = over.blakeMonthlyDollars ?? 1_200;
  return {
    name: "Alex",
    startYear: START_YEAR,
    birthYear: START_YEAR - 40,
    lifeExpectancy: 70,
    benefitClaimingAge: 67,
    openingBalanceCents: dollarsToCents(over.alexSavingsDollars ?? 30_000),
    savingsReturnPct: 0,
    retirementReturnPct: 0,
    brokerageReturnPct: 0,
    inflationPct: 0,
    goals: [],
    budgetLines: [
      {
        label: "Household",
        target: { kind: "expense" },
        amountSource: { kind: "literal", monthlyCents: BUDGET },
        category: "needs",
      },
    ],
    jobs: [
      {
        startYear: START_YEAR - 20,
        endYear: START_YEAR + 20,
        salary: {
          startingSalaryCents: dollarsToCents(alexPay) * 12,
          currentSalaryCents: dollarsToCents(alexPay) * 12,
          realGrowthPct: 0,
        },
      },
    ],
    events: [
      {
        type: "startPartnered",
        ref: ref("blake"),
        partneredForMonths: 24,
        name: "Blake",
        birthYear: START_YEAR - 40,
        lifeExpectancy: 70,
        jobs: [
          {
            startYear: START_YEAR - 20,
            endYear: START_YEAR + 20,
            salary: {
              startingSalaryCents: dollarsToCents(blakePay) * 12,
              currentSalaryCents: dollarsToCents(blakePay) * 12,
              realGrowthPct: 0,
            },
          },
        ],
        accounts: {
          savingsBalanceCents: dollarsToCents(over.blakeSavingsDollars ?? 30_000),
          retirementBalanceCents: 0,
          brokerageBalanceCents: 0,
        },
        ...(over.sharePercent === undefined ? {} : { partnerSharePercent: over.sharePercent }),
      },
    ],
  };
}

/** The month's attribution and the balance change across it, read from one run. */
function fundingAt(input: ScenarioInput): {
  readonly sources: readonly { readonly kind: string; readonly sourceId: string; readonly amountCents: number }[];
  readonly balanceChange: ReadonlyMap<string, number>;
} {
  const built = Projection.fromInput(input, nullJurisdiction);
  if (!built.ok) throw new Error(`scenario refused: ${built.error.reason}`);
  const series = built.projection.run(nullJurisdiction).series;
  const month = series.months[M]!;
  const sources = (month.flows!.resolvedFunding as readonly ResolvedFunding[]).flatMap(
    (record) => record.sources,
  );
  // Against the balances the month OPENED on, so a draw shows as the fall it is. `opening` is the
  // pre-simulation position, which is what month 0's own draw is measured from.
  const balanceChange = new Map<string, number>();
  for (const [id, ending] of Object.entries(month.accountBalancesCents)) {
    balanceChange.set(id, ending - (series.opening.accountBalancesCents[id] ?? 0));
  }
  return { sources, balanceChange };
}

/** Every account source in the month, summed per account — the "Funded by" rows' own arithmetic. */
function drawnByAccount(
  sources: readonly { readonly kind: string; readonly sourceId: string; readonly amountCents: number }[],
): Map<string, number> {
  const byAccount = new Map<string, number>();
  for (const s of sources) {
    if (s.kind !== "account") continue;
    byAccount.set(s.sourceId, (byAccount.get(s.sourceId) ?? 0) + s.amountCents);
  }
  return byAccount;
}

/** The primary's cash account and the partner's, as the standing builds name them. */
const ALEX_SAVINGS = "savings";
const blakeSavings = (balanceChange: ReadonlyMap<string, number>): string => {
  const id = [...balanceChange.keys()].find((k) => k.startsWith("savings-"));
  if (id === undefined) throw new Error("the partner has no savings account");
  return id;
};

describe("a savings draw is attributed to the partner whose share it covered", () => {
  it("names the short partner's account under a 50/50 split, not the surplus partner's", () => {
    // $2,700 each. Alex's $4,000 covers theirs with room to spare; Blake's $1,200 leaves $1,500
    // of their own share for their own savings to find.
    const { sources, balanceChange } = fundingAt(household({ sharePercent: 50 }));
    const blake = blakeSavings(balanceChange);
    const drawn = drawnByAccount(sources);

    expect(drawn.get(blake)).toBe(dollarsToCents(1_500));
    // The surplus partner's account is not merely charged less — it is not a funding source at
    // all, which is the claim the bug inverted.
    expect(drawn.has(ALEX_SAVINGS)).toBe(false);
    // And the named account is the one that actually moved: Blake's fell by exactly what was
    // attributed to it, while Alex's ROSE by their unspent pay.
    expect(balanceChange.get(blake)).toBe(-dollarsToCents(1_500));
    expect(balanceChange.get(ALEX_SAVINGS)).toBe(dollarsToCents(4_000 - 2_700));
  });

  it("follows the authored 70/30 to the same partner, for a smaller amount", () => {
    // Alex 70% ($3,780, covered), Blake 30% ($1,620) against $1,200 of pay — short $420. The
    // split moved, so the amount moves; whose account pays does not.
    const { sources, balanceChange } = fundingAt(household({ sharePercent: 30 }));
    const blake = blakeSavings(balanceChange);
    const drawn = drawnByAccount(sources);

    expect(drawn.get(blake)).toBe(dollarsToCents(420));
    expect(drawn.has(ALEX_SAVINGS)).toBe(false);
    expect(balanceChange.get(blake)).toBe(-dollarsToCents(420));
    expect(balanceChange.get(ALEX_SAVINGS)).toBe(dollarsToCents(4_000 - 3_780));
  });

  it("charges the whole budget to one partner's account at 0/100", () => {
    // Blake carries all $5,400 on $1,200 of pay, so $4,200 comes out of Blake's savings while
    // Alex — assigned nothing — banks their entire paycheck.
    const { sources, balanceChange } = fundingAt(household({ sharePercent: 100 }));
    const blake = blakeSavings(balanceChange);
    const drawn = drawnByAccount(sources);

    expect(drawn.get(blake)).toBe(dollarsToCents(4_200));
    expect(drawn.has(ALEX_SAVINGS)).toBe(false);
    expect(balanceChange.get(blake)).toBe(-dollarsToCents(4_200));
    expect(balanceChange.get(ALEX_SAVINGS)).toBe(dollarsToCents(4_000));
  });

  it("and to the OTHER partner's account at 100/0 — the same rule, mirrored", () => {
    // The control for "it always blames the partner": with the split reversed it is Alex who is
    // short, and it is Alex's savings the attribution names.
    const { sources, balanceChange } = fundingAt(household({ sharePercent: 0 }));
    const blake = blakeSavings(balanceChange);
    const drawn = drawnByAccount(sources);

    expect(drawn.get(ALEX_SAVINGS)).toBe(dollarsToCents(1_400));
    expect(drawn.has(blake)).toBe(false);
    expect(balanceChange.get(ALEX_SAVINGS)).toBe(-dollarsToCents(1_400));
    expect(balanceChange.get(blake)).toBe(dollarsToCents(1_200));
  });

  it("names both accounts once the short partner's savings run out, in the order they were drawn", () => {
    // Blake owes all $5,400 with $1,200 of pay and only $500 of their own money. Their account
    // is emptied first and Alex's covers the rest — assistance, which is a different fact from
    // Blake having paid it, and the only way to tell them apart is whose account is named.
    const { sources, balanceChange } = fundingAt(
      household({ sharePercent: 100, blakeSavingsDollars: 500 }),
    );
    const blake = blakeSavings(balanceChange);
    const drawn = drawnByAccount(sources);

    expect(drawn.get(blake)).toBe(dollarsToCents(500));
    expect(drawn.get(ALEX_SAVINGS)).toBe(dollarsToCents(4_200 - 500));
    // Both named accounts moved by exactly what was attributed to them. Alex's fall is net of the
    // $4,000 of pay they banked, so the balance rises — the attribution is about the draw, and
    // the reconciliation has to add the surplus back to see it.
    expect(balanceChange.get(blake)).toBe(-dollarsToCents(500));
    expect(balanceChange.get(ALEX_SAVINGS)).toBe(dollarsToCents(4_000 - 3_700));
    // Blake's own money before Alex's: the cascade tries each person's own accounts for their own
    // share first, and the row order is what says so.
    const order = sources.filter((s) => s.kind === "account").map((s) => s.sourceId);
    expect(order.indexOf(blake)).toBeLessThan(order.indexOf(ALEX_SAVINGS));
  });

  it("leaves a single-person household naming its one account, exactly as before", () => {
    // The regression guard for the fix: with nobody to disambiguate, the layer is the household's
    // only buffer and the attribution reads the way it always did.
    const built = Projection.fromInput(
      {
        ...household({}),
        events: [],
      },
      nullJurisdiction,
    );
    if (!built.ok) throw new Error(`scenario refused: ${built.error.reason}`);
    const month = built.projection.run(nullJurisdiction).series.months[M]!;
    const drawn = drawnByAccount(
      (month.flows!.resolvedFunding as readonly ResolvedFunding[]).flatMap((r) => r.sources),
    );

    // $4,000 of pay against $5,400 of budget: $1,400 from the household's one cash account.
    expect(drawn.get(ALEX_SAVINGS)).toBe(dollarsToCents(1_400));
    expect(drawn.size).toBe(1);
  });
});
