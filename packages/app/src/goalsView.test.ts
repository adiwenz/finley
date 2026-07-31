import { describe, it, expect } from "vitest";
import {
  Projection,
  nullJurisdiction,
  dollarsToCents,
} from "@finley/engine";
import { START_YEAR } from "./config";
import { monthLabel } from "./format";
import { readerOf, runOf, stateOf } from "./testing/projectionHarness";
import {
  goalRows,
  dispositionLabel,
  goalDisposal,
  goalFundingBlocks,
  fundingBlockMessage,
} from "./goalsView";
import type {
  Plan,
  GoalPlan,
  Ledger,
  LifeEvent,
} from "@finley/engine";

const baseBudget: Plan = {
  name: "Alex",
  // Income is a single real-flat job — $5,000/mo, the surplus source below.
  jobs: [
    {
      id: "job-1",
      ownerId: "p1",
      startYear: START_YEAR - 35 + 18,
      endYear: null,
      salary: { startingSalaryCents: dollarsToCents(5000) * 12, realGrowthPct: 0 },
    },
  ],
  budgetLines: [
    {
      id: "spend",
      label: "Spending",
      target: { kind: "expense" },
      amountSource: { kind: "literal", monthlyCents: dollarsToCents(3500) },
      category: "needs",
    },
  ],
  openingBalanceCents: 0,
  savingsReturnPct: 0,
  retirementReturnPct: 0,
  brokerageReturnPct: 0,
  sharedScheme: "proportional",
  goals: [],
  // No health line: these tests pin the $1,500/mo surplus ($5,000 − $3,500) goal funding
  // draws from, and health is a separate additive expense.
  healthMonthlyCents: 0,
  postCoverageHealthMonthlyCents: 0,
  enrollsInPublicHealthCoverage: true,
  healthInflationPct: 3,
  inflationPct: 3,
  currentAge: 35,
  retirementAge: 65,
  lifeExpectancy: 90,
  benefitClaimingAge: 67,
};

/** Two goals that together outstrip the $1,500/mo surplus, so priority decides. */
const goalA: GoalPlan = {
  id: "a",
  name: "Goal A",
  targetCents: dollarsToCents(30000),
  targetDate: 12,
  disposition: "retain",
  annualReturnPct: 0,
};
const goalB: GoalPlan = {
  id: "b",
  name: "Goal B",
  targetCents: dollarsToCents(30000),
  targetDate: 12,
  disposition: "retain",
  annualReturnPct: 0,
};

/** The surplus these rows are scored against is stated, not withheld — see {@link runOf}. */
const taxFreeRun = (plan: Plan) => runOf(plan, undefined, nullJurisdiction);

/**
 * A goal's derived fund account, read off the facade's `accountDescriptors` rather than the
 * engine's internal `goalFundAccountId` — the same account id the panel resolves through.
 */
const fundAccountIdOf = (goal: GoalPlan): string => {
  const account = readerOf({ ...baseBudget, goals: [goal] })
    .accountDescriptors()
    .find((a) => a.kind === "goal");
  if (account === undefined) throw new Error(`no fund account for goal "${goal.id}"`);
  return account.id;
};

/** Reprioritize a goal through the facade, returning the reordered plan. */
const reorderGoals = (plan: Plan, id: string, direction: "up" | "down"): Plan =>
  Projection.transact(stateOf(plan), nullJurisdiction, (p) => p.reorderGoal(id, direction)).state
    .scenario.plan;

describe("goalRows — projection-based on-track %", () => {
  it("scores each goal by projected fund at target ÷ target, not saved-so-far", () => {
    const budget = { ...baseBudget, goals: [goalA, goalB] };
    const rows = goalRows(budget, taxFreeRun(budget));
    // $1,500/mo surplus, all to priority-0 Goal A. months[12] is the end of month 12, so 13
    // processed months (0–12) have funded it — now that month 0 saves — → $19,500 of $30,000.
    expect(rows[0]).toMatchObject({ id: "a", priority: 0, onTrackPct: 65 });
    // Goal B is starved behind A → 0% on track.
    expect(rows[1]).toMatchObject({ id: "b", priority: 1, onTrackPct: 0 });
  });

  it("reprioritizing visibly moves the OTHER goal's number (tradeoff)", () => {
    const budget = { ...baseBudget, goals: [goalA, goalB] };
    const reordered = reorderGoals(budget, "b", "up");
    const rows = goalRows(reordered, taxFreeRun(reordered));
    // Now B is funded first: it takes the 65%, and A drops to 0.
    expect(rows.find((r) => r.id === "b")?.onTrackPct).toBe(65);
    expect(rows.find((r) => r.id === "a")?.onTrackPct).toBe(0);
  });

  it("caps on-track % at 100 once a goal is funded and left to grow", () => {
    // A $3,000 target fills in 2 months from the $1,500/mo surplus, then compounds for
    // the rest of the horizon — the raw fraction drifts past 1.0, but display is capped:
    // a met goal reads 100% and the surplus flows onward.
    const smallGoal: GoalPlan = {
      id: "s",
      name: "Small goal",
      targetCents: dollarsToCents(3000),
      targetDate: 24,
      disposition: "drawDown",
      annualReturnPct: 10,
    };
    const budget = { ...baseBudget, goals: [smallGoal] };
    const rows = goalRows(budget, taxFreeRun(budget));
    expect(rows[0].onTrackPct).toBe(100);
  });

  it("flags a near-term goal accumulating in an equity-like account", () => {
    // A 7% return account + a 12-month horizon is exactly the risk v1 can't model.
    const budget = { ...baseBudget, goals: [{ ...goalA, annualReturnPct: 7 }] };
    const rows = goalRows(budget, taxFreeRun(budget));
    expect(rows[0].shortHorizonRiskFlag).toBe(true);
  });

  it("does NOT flag the same goal in a low-return account", () => {
    const budget = { ...baseBudget, goals: [{ ...goalA, annualReturnPct: 1 }] };
    const rows = goalRows(budget, taxFreeRun(budget));
    expect(rows[0].shortHorizonRiskFlag).toBe(false);
  });
});

describe("goalRows — surfaces derived completion (In Progress → Funded) and behind-pace", () => {
  it("marks a goal Funded once its projected balance reaches target on/before the date", () => {
    // $1,500/mo surplus fills a $3,000 target by ~month 2, well before month 24.
    const funded: GoalPlan = {
      id: "f",
      name: "Funded goal",
      targetCents: dollarsToCents(3000),
      targetDate: 24,
      disposition: "retain",
      annualReturnPct: 0,
    };
    const budget = { ...baseBudget, goals: [funded] };
    const rows = goalRows(budget, taxFreeRun(budget));
    expect(rows[0].completion).toBe("funded");
    // A funded goal is by definition not behind pace.
    expect(rows[0].behindPace).toBe(false);
  });

  it("marks an underfunded goal In Progress and behind pace (onTrackFraction < 1)", () => {
    // $30,000 by month 12 off a $1,500/mo surplus → only 60% funded in time.
    const budget = { ...baseBudget, goals: [goalA] };
    const rows = goalRows(budget, taxFreeRun(budget));
    expect(rows[0].completion).toBe("inProgress");
    expect(rows[0].behindPace).toBe(true);
  });
});

describe("goalRows — surfaces each goal's disposition", () => {
  it("carries the disposition and a plain-language label so the fate of the money is visible", () => {
    // What BECOMES of a goal's money at target must be explicit.
    const nestEggGoal: GoalPlan = { ...goalA, id: "nest", disposition: "drawDown" };
    const budget = { ...baseBudget, goals: [nestEggGoal] };
    const rows = goalRows(budget, taxFreeRun(budget));
    expect(rows[0].disposition).toBe("drawDown");
    expect(rows[0].dispositionLabel).toBe("Drawn down over time");
  });
});

describe("dispositionLabel", () => {
  it("maps each disposition to a plain-language fate", () => {
    expect(dispositionLabel("retain")).toBe("Kept as a reserve");
    expect(dispositionLabel("drawDown")).toBe("Drawn down over time");
  });
});

describe("goalDisposal — disposition/date pairing", () => {
  it("assembles the disposition and date verbatim, including 'asap'", () => {
    // Both dispositions are purely descriptive, so either date is kept as-is.
    expect(goalDisposal("retain", "asap")).toEqual({ disposition: "retain", targetDate: "asap" });
    expect(goalDisposal("drawDown", 24)).toEqual({ disposition: "drawDown", targetDate: 24 });
    expect(goalDisposal("retain", 12)).toEqual({ disposition: "retain", targetDate: 12 });
  });
});

// Every goal edit — add, patch, reorder, remove — now lives on `Projection` and is covered in
// the engine's `projectionRoot.test`. What stays here is what the panel itself still answers:
// how a goal reads (`goalRows`, `dispositionLabel`), and which events refuse its deletion.



/**
 * A home purchase drawing its down payment from `sourceIds`, in drain order. Today's only
 * event type that names a fund account as a funding source — the single real path to a
 * dangling reference a deleted goal would leave.
 */
function homePurchase(
  id: string,
  month: number,
  sequenceNumber: number,
  sourceIds: readonly string[],
): LifeEvent {
  return {
    type: "HomePurchaseEvent",
    id,
    sequenceNumber,
    month,
    propertyId: `${id}-house`,
    ownerId: "p1",
    purchasePriceCents: dollarsToCents(500000),
    downPaymentCents: dollarsToCents(100000),
    downPaymentSourceIds: sourceIds,
    mortgageLiabilityId: `${id}-mtg`,
    mortgageApr: 0,
    mortgageTermMonths: 360,
  };
}

function ledgerOf(...events: LifeEvent[]): Ledger {
  return { events, nextSequenceNumber: events.length };
}

/**
 * Which events block a goal is asked of a completed run, so the fixture states the goals and
 * the timeline and lets the facade pair them — the same route the panel takes.
 */
function blocksFor(goals: readonly GoalPlan[], id: string, ledger: Ledger) {
  return goalFundingBlocks(readerOf({ ...baseBudget, goals }, ledger), id);
}

describe("goalFundingBlocks — events naming a goal's fund account as a funding source", () => {
  it("names the event blocking a goal whose fund account it draws from", () => {
    // The home purchase at month 72 funds its down payment from Goal A's derived account.
    const buy = homePurchase("buy1", 72, 0, ["savings", fundAccountIdOf(goalA)]);
    const blocks = blocksFor([goalA, goalB], "a", ledgerOf(buy));
    expect(blocks).toEqual([{ eventId: "buy1", label: "Bought a home", month: 72 }]);
  });

  it("returns nothing when no event references the goal's fund account", () => {
    const buy = homePurchase("buy1", 72, 0, ["savings"]);
    expect(blocksFor([goalA, goalB], "a", ledgerOf(buy))).toEqual([]);
  });

  it("unblocks once the referencing event is removed from the ledger", () => {
    const referenced = blocksFor(
      [goalA],
      "a",
      ledgerOf(homePurchase("buy1", 72, 0, [fundAccountIdOf(goalA)])),
    );
    expect(referenced).toHaveLength(1);
    // The event gone from the log, nothing points at the fund account any more.
    expect(blocksFor([goalA], "a", ledgerOf())).toEqual([]);
  });

  it("lists every blocking event, sorted by (month, sequence)", () => {
    const later = homePurchase("buy2", 90, 1, [fundAccountIdOf(goalA)]);
    const earlier = homePurchase("buy1", 72, 0, ["savings", fundAccountIdOf(goalA)]);
    const blocks = blocksFor([goalA], "a", ledgerOf(later, earlier));
    expect(blocks).toEqual([
      { eventId: "buy1", label: "Bought a home", month: 72 },
      { eventId: "buy2", label: "Bought a home", month: 90 },
    ]);
  });
});

describe("fundingBlockMessage — the refuse-to-delete text", () => {
  const messageFor = (goals: readonly GoalPlan[], id: string, ledger: Ledger) =>
    fundingBlockMessage(blocksFor(goals, id, ledger));

  it("is null when the goal's fund account is unreferenced (deletion may proceed)", () => {
    const buy = homePurchase("buy1", 72, 0, ["savings"]);
    expect(messageFor([goalA], "a", ledgerOf(buy))).toBeNull();
  });

  it("names each blocking event by label and month", () => {
    const buy = homePurchase("buy1", 72, 0, [fundAccountIdOf(goalA)]);
    expect(messageFor([goalA], "a", ledgerOf(buy))).toBe(
      `This account cannot be deleted because it funds:\n- Bought a home in ${monthLabel(72)}`,
    );
  });

  it("names a narrowed set of blockers — the panel formats one refusal's own", () => {
    const early = homePurchase("buy1", 72, 0, [fundAccountIdOf(goalA)]);
    const late = homePurchase("buy2", 90, 1, [fundAccountIdOf(goalA)]);
    const blocks = blocksFor([goalA], "a", ledgerOf(early, late));
    expect(fundingBlockMessage(blocks.filter((b) => b.eventId === "buy2"))).toBe(
      `This account cannot be deleted because it funds:\n- Bought a home in ${monthLabel(90)}`,
    );
  });
});

