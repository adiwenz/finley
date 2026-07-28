/**
 * The unified **spending read model**: everything a month costs, itemized, from one place.
 *
 * Spending reaches the simulator through unrelated authoring models — a standing
 * {@link import("../budgetLine").BudgetLine}, the plan's health line, an expense series a
 * life event created, a liability's payment computed from balance/rate/term. They are
 * *right* to be separate: a loan payment is not an expense line, and making it one would
 * invent an editable fact the model lacks. But a reader — a chart, a tooltip — wants one
 * list, and re-deriving it downstream from four shapes means each consumer gets it subtly
 * differently. That is what happened: the app assembled bands from `lineMonthlyCents`,
 * household series objects and payment records, and missed whole categories of spending.
 *
 * So the engine reports {@link SpendingItem}s: one flat, labelled, categorized list per
 * month, summing to the month's whole obligation ({@link sumSpendingItems} ==
 * `expensesCents + liabilityPaymentsCents`, pinned by test). A **read** model — no new
 * source of truth. Each item points back at its authoring fact
 * ({@link SpendingItem.sourceKind} / {@link SpendingItem.sourceId}) and states whether
 * that fact is editable as a line ({@link SpendingItem.editable}), so a UI offers an edit
 * exactly where one exists.
 */

import type { Cents } from "../money";
import type { BudgetCategory } from "../budgetLine";
import type { LiabilityKind, SimLiability } from "../liability";
import type { SimOwnedSeries } from "./simulate.types";

/**
 * Which authoring model an item's money comes from. Provenance, not presentation: it says
 * where to go to change the number (or that there is nowhere), and lets one list be
 * re-grouped without re-deriving it.
 */
export type SpendingSourceKind =
  /** A standing budget line the user authors and edits. */
  | "budgetLine"
  /** The plan's health line — a standing plan input, not a budget line. */
  | "healthcare"
  /** The scalar `Plan.expenseCents` series, used when a plan authors no budget lines. */
  | "planExpense"
  /** An expense series a life event created (a child's cost, alimony, an added expense). */
  | "event"
  /** A liability's scheduled payment — computed from balance/rate/term, never authored. */
  | "liability";

/**
 * How to *read* an item, as distinct from where it came from. Authored lines carry their
 * own priority tier; the rest carry the kind of obligation they are, since "need or want?"
 * is not a question a mortgage payment answers.
 */
export type SpendingCategory = BudgetCategory | "healthcare" | "debtService" | "other";

/**
 * One thing a month's money went to. `amountCents` is what the simulator actually charged:
 * a line's price-grown amount with overrides applied, a payoff-capped final loan payment,
 * 0 for a stream dormant this month.
 */
export interface SpendingItem {
  /** Stable id, unique within a month and constant across months (a chart band key). */
  readonly id: string;
  /** Human-facing name ("Housing", "Healthcare", "Student loan payment"). */
  readonly label: string;
  /** What it cost this month. */
  readonly amountCents: Cents;
  readonly category: SpendingCategory;
  readonly sourceKind: SpendingSourceKind;
  /** Id of the authoring fact: the budget line, the series, the liability. */
  readonly sourceId: string;
  /**
   * Editable *as itself* — true only for an authored budget line. A health line is edited
   * on the plan, an event's expense through its event, a loan payment not at all (change
   * the loan). A UI reads this instead of guessing from the kind.
   */
  readonly editable: boolean;
}

/**
 * The provenance an expense {@link SimOwnedSeries} carries so it can report itself as a
 * {@link SpendingItem}. Set where the series is compiled — the only place that knows its
 * authoring model — and read only here.
 */
export interface SpendingSource {
  readonly kind: Exclude<SpendingSourceKind, "liability">;
  readonly id: string;
  readonly category: SpendingCategory;
  readonly editable: boolean;
}

/** Fallback provenance for an expense series compiled before this seam existed. */
const UNTAGGED: SpendingSource = {
  kind: "planExpense",
  id: "expenses",
  category: "other",
  editable: false,
};

/** Plain-language name for a debt's payment, from the only human fact a liability has. */
const LIABILITY_LABEL: Record<LiabilityKind, string> = {
  mortgage: "Mortgage payment",
  auto: "Auto loan payment",
  studentLoan: "Student loan payment",
  creditCard: "Credit card payment",
};

/** Item id for a liability's payment band — namespaced so it cannot collide with a line's. */
export function liabilitySpendingId(liabilityId: string): string {
  return `debt:${liabilityId}`;
}

/**
 * Every {@link SpendingItem} for one simulated month: each expense series at the amount it
 * charges, then each liability at the payment applied against it.
 *
 * Series are reported even at 0 — a dormant line still exists, and a band vanishing
 * mid-chart reads as deleted rather than paused. Liabilities appear only with a payment
 * due, exactly the set `payments` holds.
 */
export function buildSpendingItems(
  expenseSeries: readonly SimOwnedSeries[],
  month: number,
  liabilities: readonly SimLiability[],
  payments: ReadonlyMap<string, Cents>,
): SpendingItem[] {
  const items: SpendingItem[] = expenseSeries.map((s): SpendingItem => {
    const source = s.spendingSource ?? UNTAGGED;
    return {
      id: source.kind === "budgetLine" ? `line:${source.id}` : source.id,
      label: s.label ?? source.id,
      amountCents: s.series.getMonthlyCents(month),
      category: source.category,
      sourceKind: source.kind,
      sourceId: source.id,
      editable: source.editable,
    };
  });

  for (const liability of liabilities) {
    const amountCents = payments.get(liability.id);
    if (amountCents === undefined || amountCents <= 0) continue;
    items.push({
      id: liabilitySpendingId(liability.id),
      label: LIABILITY_LABEL[liability.kind],
      amountCents,
      category: "debtService",
      sourceKind: "liability",
      sourceId: liability.id,
      editable: false,
    });
  }

  return items;
}

/** What the month costs in total — the sum every consumer would otherwise recompute. */
export function sumSpendingItems(items: readonly SpendingItem[]): Cents {
  return items.reduce((total, item) => total + item.amountCents, 0);
}
