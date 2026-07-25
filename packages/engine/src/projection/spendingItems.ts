/**
 * The unified **spending read model** (issue #119 follow-up): everything a month
 * actually costs, itemized, from one place.
 *
 * A household's spending arrives at the simulator through several authoring models that
 * have nothing to do with each other — a standing {@link import("../budgetLine").BudgetLine}
 * the user edits, the plan's health line (§5.4), an expense series a life event created
 * (§10.2), and a liability's scheduled payment computed from balance/rate/term (§3).
 * Those models are *right* to be separate: a loan payment is not an expense line, and
 * making it one would invent an editable fact the model does not have. But a reader —
 * "what does this month cost?", a chart, a tooltip — wants one list, and reconstructing
 * that list downstream means every consumer re-derives it from four different shapes
 * and each gets it subtly differently. That is exactly what happened: the app assembled
 * bands from `lineMonthlyCents`, from household series objects, and from payment
 * records, and simply *missed* whole categories of real spending.
 *
 * So the engine reports {@link SpendingItem}s: one flat, labelled, categorized list per
 * month, summing to the month's whole obligation ({@link sumSpendingItems} ==
 * `expensesCents + liabilityPaymentsCents`, pinned by test). It is a **read** model —
 * it creates no new source of truth. Each item points back at the authoring fact it came
 * from ({@link SpendingItem.sourceKind} / {@link SpendingItem.sourceId}) and says
 * plainly whether that fact is editable as a line ({@link SpendingItem.editable}), so a
 * UI can offer an edit exactly where one exists and nowhere else.
 */

import type { Cents } from "../money";
import type { BudgetCategory } from "../budgetLine";
import type { LiabilityKind, SimLiability } from "../liability";
import type { SimOwnedSeries } from "./simulate.types";

/**
 * Which authoring model an item's money comes from. This is provenance, not
 * presentation: it tells a consumer where to go to change the number (or that there is
 * nowhere), and lets one list be re-grouped without re-deriving it.
 */
export type SpendingSourceKind =
  /** A standing budget line the user authors and edits (§12). */
  | "budgetLine"
  /** The plan's health line (§5.4) — a standing plan input, not a budget line. */
  | "healthcare"
  /** The scalar `Plan.expenseCents` series, used when a plan authors no budget lines. */
  | "planExpense"
  /** An expense series a life event created (a child's cost, alimony, an added expense). */
  | "event"
  /** A liability's scheduled payment (§3) — computed from balance/rate/term, never authored. */
  | "liability";

/**
 * How to *read* an item, as distinct from where it came from. Authored lines carry
 * their own §15 tier; the rest carry the kind of obligation they are, because "is this
 * a need or a want?" is not a question a mortgage payment answers.
 */
export type SpendingCategory = BudgetCategory | "healthcare" | "debtService" | "other";

/**
 * One thing a month's money went to. `amountCents` is what the simulator actually
 * charged this month — a line's price-grown amount with its overrides applied, a
 * payoff-capped final loan payment, 0 for a stream that is dormant this month.
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
   * Whether this amount is editable *as itself* — true only for an authored budget
   * line. A health line is edited on the plan, a loan payment is not editable at all
   * (change the loan), an event's expense is edited through its event. A UI reads this
   * instead of guessing from the kind.
   */
  readonly editable: boolean;
}

/**
 * The provenance an expense {@link SimOwnedSeries} carries so it can report itself as a
 * {@link SpendingItem}. Set where the series is compiled — the only place that knows
 * which authoring model it came from — and read only here.
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
 * Every {@link SpendingItem} for one simulated month: each expense series at the amount
 * it charges this month, then each liability at the payment applied against it.
 *
 * Series are reported even at 0 (a dormant line still exists, and a band that vanishes
 * mid-chart reads as a deleted line rather than a paused one); liabilities appear only
 * with a payment due, which is exactly the set `payments` holds.
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
