/**
 * Funding-reference integrity for goals — which events spend from a goal's derived fund
 * account, and the removal check built on that. Pure structure over a ledger literal: no
 * replay, because a reference is an authoring fact whether or not the draw ever resolves.
 */
import { describe, it, expect } from "vitest";
import {
  eventFundingSourceIds,
  eventsFundedByGoal,
  validateGoalRemoval,
} from "./goalFunding";
import { goalFundAccountId } from "./projectionBase";
import type { GoalPlan } from "./plan";
import type { Ledger, LifeEvent } from "./index";
import { dollarsToCents } from "./cashFlowSeries";

const goal = (id: string): GoalPlan => ({
  id,
  name: `Goal ${id}`,
  targetCents: dollarsToCents(50000),
  annualReturnPct: 4,
  disposition: "retain",
  targetDate: 60,
});

const GOALS = [goal("home"), goal("emergency")];
const HOME_FUND = goalFundAccountId(goal("home"));

function homePurchase(
  id: string,
  month: number,
  sequenceNumber: number,
  sourceIds: readonly string[],
): LifeEvent {
  return {
    id,
    type: "HomePurchaseEvent",
    month,
    sequenceNumber,
    propertyId: `home-${id}`,
    ownerId: "p1",
    purchasePriceCents: dollarsToCents(300000),
    downPaymentCents: dollarsToCents(60000),
    downPaymentSourceIds: sourceIds,
    mortgageLiabilityId: `mortgage-${id}`,
    mortgageApr: 0.065,
    mortgageTermMonths: 360,
  };
}

function debtPayoff(
  id: string,
  month: number,
  sequenceNumber: number,
  accountId: string,
): LifeEvent {
  return {
    id,
    type: "DebtPayoffEvent",
    month,
    sequenceNumber,
    liabilityId: "loan-1",
    accountId,
    amountCents: dollarsToCents(5000),
  };
}

const ledgerOf = (events: readonly LifeEvent[]): Ledger => ({
  events,
  nextSequenceNumber: events.length + 1,
});

describe("eventFundingSourceIds — what an event spends from", () => {
  it("reports a home purchase's down-payment sources in drain order", () => {
    const event = homePurchase("e1", 24, 1, [HOME_FUND, "savings"]);
    expect(eventFundingSourceIds(event)).toEqual([HOME_FUND, "savings"]);
  });

  it("reports the account a debt payoff drains — its paired outflow", () => {
    expect(eventFundingSourceIds(debtPayoff("e1", 12, 1, HOME_FUND))).toEqual([HOME_FUND]);
  });

  it("reports nothing for an event that spends from no account", () => {
    const end: LifeEvent = { id: "e1", type: "BudgetItemEndEvent", month: 6, sequenceNumber: 1, seriesId: "s1" };
    expect(eventFundingSourceIds(end)).toEqual([]);
  });
});

describe("eventsFundedByGoal — the events a goal's fund account pays for", () => {
  it("finds the event naming the goal's derived fund account", () => {
    const ledger = ledgerOf([homePurchase("e1", 24, 1, [HOME_FUND])]);
    expect(eventsFundedByGoal(GOALS, "home", ledger).map((e) => e.id)).toEqual(["e1"]);
  });

  it("ignores events funded from other accounts", () => {
    const ledger = ledgerOf([homePurchase("e1", 24, 1, ["savings", "brokerage"])]);
    expect(eventsFundedByGoal(GOALS, "home", ledger)).toEqual([]);
  });

  it("keeps one goal's blockers off another goal", () => {
    const ledger = ledgerOf([homePurchase("e1", 24, 1, [HOME_FUND])]);
    expect(eventsFundedByGoal(GOALS, "emergency", ledger)).toEqual([]);
  });

  it("sorts multiple blockers by (month, sequence) so they read in timeline order", () => {
    const ledger = ledgerOf([
      homePurchase("late", 40, 1, [HOME_FUND]),
      debtPayoff("early", 12, 3, HOME_FUND),
      debtPayoff("same-month-later-seq", 12, 9, HOME_FUND),
    ]);
    expect(eventsFundedByGoal(GOALS, "home", ledger).map((e) => e.id)).toEqual([
      "early",
      "same-month-later-seq",
      "late",
    ]);
  });

  it("does not mutate the ledger's event order while sorting", () => {
    const events = [homePurchase("late", 40, 1, [HOME_FUND]), debtPayoff("early", 12, 2, HOME_FUND)];
    eventsFundedByGoal(GOALS, "home", ledgerOf(events));
    expect(events.map((e) => e.id)).toEqual(["late", "early"]);
  });

  it("finds nothing for an id that is not a goal", () => {
    const ledger = ledgerOf([homePurchase("e1", 24, 1, [HOME_FUND])]);
    expect(eventsFundedByGoal(GOALS, "no-such-goal", ledger)).toEqual([]);
  });
});

describe("validateGoalRemoval — the refusal", () => {
  it("allows removing a goal nothing funds", () => {
    const ledger = ledgerOf([homePurchase("e1", 24, 1, ["savings"])]);
    expect(validateGoalRemoval(GOALS, "home", ledger)).toEqual({ ok: true });
  });

  it("allows removing from an empty ledger", () => {
    expect(validateGoalRemoval(GOALS, "home", ledgerOf([]))).toEqual({ ok: true });
  });

  it("refuses while an event spends from the fund account, naming the blocker", () => {
    const ledger = ledgerOf([homePurchase("e1", 24, 1, [HOME_FUND])]);
    const result = validateGoalRemoval(GOALS, "home", ledger);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe(
      `Cannot remove goal "home": its fund account "goal-home" funds "e1" (HomePurchaseEvent, month 24)`,
    );
  });

  it("names every blocker, in timeline order", () => {
    const ledger = ledgerOf([
      homePurchase("e2", 40, 2, [HOME_FUND]),
      debtPayoff("e1", 12, 1, HOME_FUND),
    ]);
    const result = validateGoalRemoval(GOALS, "home", ledger);
    expect(result.ok === false && result.reason).toBe(
      `Cannot remove goal "home": its fund account "goal-home" funds ` +
        `"e1" (DebtPayoffEvent, month 12), "e2" (HomePurchaseEvent, month 40)`,
    );
  });

  it("allows an id that is not a goal — it references nothing by definition", () => {
    const ledger = ledgerOf([homePurchase("e1", 24, 1, [HOME_FUND])]);
    expect(validateGoalRemoval(GOALS, "no-such-goal", ledger)).toEqual({ ok: true });
  });
});
