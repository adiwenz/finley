/**
 * The unified spending **read** model: one flat, labelled, categorized list of everything a
 * month costs. No new source of truth — spending still reaches the simulator through four
 * unrelated authoring models, rightly so (a loan payment is not an expense line, and making it
 * one would invent an editable fact the model lacks), but re-deriving the list downstream from
 * four shapes made each consumer get it subtly differently and miss whole categories.
 *
 * {@link sumSpendingItems} == `expensesCents + liabilityPaymentsCents`, pinned by test. Each
 * item points back at its authoring fact and states whether that fact is editable as a line.
 */

import type { Cents } from "../money";
import type { BudgetCategory } from "../budgetLine";
import type { LiabilityKind, SimLiability } from "../liability";
import type { SimOwnedSeries } from "./simulate.types";

/**
 * Which authoring model an item's money comes from. Provenance, not presentation: it says
 * where to go to change the number, or that there is nowhere.
 */
export type SpendingSourceKind =
  /** A standing budget line the user authors and edits. */
  | "budgetLine"
  /** The plan's health line — a standing plan input, not a budget line. */
  | "healthcare"
  /** An expense series a life event created (a child's cost, alimony, an added expense). */
  | "event"
  /**
   * An expense stream that carries no authoring provenance — nowhere to edit it. Never arises
   * from the plan→projection pipeline (budget lines, health and events all tag themselves);
   * it exists only for raw engine-level series that bypass those compilers.
   */
  | "untracked"
  /** A liability's scheduled payment — computed from balance/rate/term, never authored. */
  | "liability";

/**
 * How to *read* an item, as distinct from where it came from. Authored lines carry their
 * own priority tier; the rest carry the kind of obligation they are — "need or want?" is
 * not a question a mortgage payment answers.
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
  readonly label: string;
  readonly amountCents: Cents;
  readonly category: SpendingCategory;
  readonly sourceKind: SpendingSourceKind;
  /** Id of the authoring fact: the budget line, the series, the liability. */
  readonly sourceId: string;
  /**
   * Editable *as itself* — true only for an authored budget line. A health line is edited
   * on the plan, an event's expense through its event, a loan payment not at all (change
   * the loan).
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

/** Provenance for an expense series that reached the report without tagging itself. */
const UNTRACKED: SpendingSource = {
  kind: "untracked",
  id: "expenses",
  category: "other",
  editable: false,
};

/** A debt's payment named from its kind — the only human fact a liability has. */
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
 * Every {@link SpendingItem} for one simulated month. Series are reported even at 0 — a
 * dormant line still exists, and a band vanishing mid-chart reads as deleted rather than
 * paused. Liabilities appear only with a payment due.
 */
export function buildSpendingItems(
  expenseSeries: readonly SimOwnedSeries[],
  month: number,
  liabilities: readonly SimLiability[],
  payments: ReadonlyMap<string, Cents>,
): SpendingItem[] {
  const items: SpendingItem[] = expenseSeries.map((s): SpendingItem => {
    const source = s.spendingSource ?? UNTRACKED;
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

export function sumSpendingItems(items: readonly SpendingItem[]): Cents {
  return items.reduce((total, item) => total + item.amountCents, 0);
}
