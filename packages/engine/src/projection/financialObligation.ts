/**
 * The normalized runtime representation of anything a month must fund: a budget line, a
 * healthcare cost, an event-spawned expense series, a debt payment. One flat, summable list
 * that *drives* the waterfall rather than reporting on it after the fact — each obligation
 * points back at its authoring fact, states how it wants to be funded, and carries the
 * priority the waterfall ranks it by.
 *
 * `amountCents` is what is *requested/owed*, nominal at `month` — a debt's payoff-capped
 * payment, a line's price-grown amount — not what turned out to be affordable. What was
 * actually charged is a later concern (`ResolvedFunding`, Slice #5); keeping obligations at
 * "owed" is what keeps them dumb and summable.
 */

import type { Cents } from "../money";
import type { BudgetCategory } from "../budgetLine";
import type { LiabilityKind, SimLiability } from "../liability";
import type { SimOwnedSeries } from "./simulate.types";
import type { SpendingSource } from "./spendingItems";

/**
 * Which authoring model an obligation's money comes from. Provenance, not presentation: it
 * says where to go to change the number, or that there is nowhere.
 */
export type ObligationSourceKind =
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
 * How to *read* an obligation, as distinct from where it came from. Authored lines carry their
 * own priority tier; the rest carry the kind of obligation they are — "need or want?" is not a
 * question a mortgage payment answers.
 */
export type ObligationCategory = BudgetCategory | "healthcare" | "debtService" | "other";

/**
 * One thing a month must fund. Every obligation this slice constructs is `funding: automatic`;
 * the `explicit` branch is defined but unused until Slice #4, where an obligation may name the
 * accounts it draws from and so leave the shared waterfall.
 */
export interface FinancialObligation {
  /** Stable id, unique within a month and constant across months (a chart band key). */
  readonly id: string;
  /** Id of the authoring fact: the budget line, the series, the liability. */
  readonly sourceId: string;
  readonly month: number;
  /** Requested/owed, nominal at `month` — not the affordable or actually-charged amount. */
  readonly amountCents: Cents;
  /**
   * What the money *does*, which decides whether it is an expense. Only `"expense"` reduces net
   * worth; a `"debt-payment"` retires a liability and an `"asset-acquisition"` converts cash to
   * an asset, so neither belongs in the expense graph even though both must be funded.
   */
  readonly treatment: "expense" | "asset-acquisition" | "debt-payment";
  /**
   * How the obligation is funded. `"automatic"` draws the shared income→decumulation waterfall;
   * `"explicit"` (Slice #4) draws the named accounts in order, bypassing the waterfall.
   */
  readonly funding:
    | { readonly kind: "automatic" }
    | { readonly kind: "explicit"; readonly orderedAccountIds: readonly string[] };
  /** Waterfall rank, lower funded first. Resolved at construction from source kind (Slice #3 task 3). */
  readonly priority: number;
  readonly sourceKind: ObligationSourceKind;
  /**
   * Editable *as itself* — true only for an authored budget line. A health line is edited on
   * the plan, an event's expense through its event, a loan payment not at all (change the loan).
   */
  readonly editable: boolean;
  readonly label: string;
  readonly category: ObligationCategory;
}

/**
 * What the shared waterfall must cover and what decumulation sizes its gap against: the sum of
 * every *automatically-funded* obligation, whatever its treatment — an expense, a debt payment
 * and an asset acquisition all draw the same cash. Explicitly-funded obligations draw their own
 * accounts and are excluded so they never inflate the amount the waterfall is asked for.
 *
 * Deliberately kept distinct from {@link expenseReportingTotal}: the two coincide only while no
 * obligation is explicitly funded (this slice) and diverge permanently once that branch is used.
 */
export function automaticFundingTotal(obligations: readonly FinancialObligation[]): Cents {
  return obligations.reduce(
    (total, o) => (o.funding.kind === "automatic" ? total + o.amountCents : total),
    0,
  );
}

/**
 * What the expense graph and its totals report: the sum of every *expense-treatment*
 * obligation, under either funding kind — an explicitly-funded expense is still an expense.
 * Debt payments and asset acquisitions move money without being expenses, so they never enter
 * this sum even though {@link automaticFundingTotal} funds them.
 */
export function expenseReportingTotal(obligations: readonly FinancialObligation[]): Cents {
  return obligations.reduce(
    (total, o) => (o.treatment === "expense" ? total + o.amountCents : total),
    0,
  );
}

/** A debt's payment named from its kind — the only human fact a liability has. */
const LIABILITY_LABEL: Record<LiabilityKind, string> = {
  mortgage: "Mortgage payment",
  auto: "Auto loan payment",
  studentLoan: "Student loan payment",
  creditCard: "Credit card payment",
};

/** Provenance for an expense series that reached construction without tagging itself. */
const UNTRACKED: SpendingSource = {
  kind: "untracked",
  id: "expenses",
  category: "other",
  editable: false,
};

/**
 * Placeholder rank until Slice #3 task 3 resolves priority from source kind. Nothing ranks
 * obligations yet (the list is built but not consumed), so a single shared value is correct:
 * making it meaningful before there is a ranker would be inventing an ordering no test pins.
 */
const UNRESOLVED_PRIORITY = 0;

/** Obligation id for a liability's payment band — namespaced so it cannot collide with a line's. */
export function obligationLiabilityId(liabilityId: string): string {
  return `debt:${liabilityId}`;
}

/**
 * Every {@link FinancialObligation} one simulated month must fund, from the same four inputs
 * the spending report reads — so the two lists cannot disagree while both exist. Expense series
 * (budget lines, healthcare, event-spawned streams) are `treatment: "expense"`; a liability's
 * scheduled payment is `treatment: "debt-payment"` — funded like any other draw, but not an
 * expense that reduces net worth.
 *
 * Series are constructed even at 0: a dormant line still exists, and a band vanishing mid-chart
 * reads as deleted rather than paused. Liabilities appear only with a payment due, and their
 * `amountCents` is what `payments` holds — the payoff-capped scheduled figure (capped by the
 * debt, never by affordability), the exact amount the simulator also applies to the balance.
 *
 * Every obligation here is `funding: automatic`; the explicit branch arrives in Slice #4.
 */
export function buildObligations(
  expenseSeries: readonly SimOwnedSeries[],
  month: number,
  liabilities: readonly SimLiability[],
  payments: ReadonlyMap<string, Cents>,
): FinancialObligation[] {
  const obligations: FinancialObligation[] = expenseSeries.map((s): FinancialObligation => {
    const source = s.spendingSource ?? UNTRACKED;
    return {
      id: source.kind === "budgetLine" ? `line:${source.id}` : source.id,
      sourceId: source.id,
      month,
      amountCents: s.series.getMonthlyCents(month),
      treatment: "expense",
      funding: { kind: "automatic" },
      priority: UNRESOLVED_PRIORITY,
      sourceKind: source.kind,
      editable: source.editable,
      label: s.label ?? source.id,
      category: source.category,
    };
  });

  for (const liability of liabilities) {
    const amountCents = payments.get(liability.id);
    if (amountCents === undefined || amountCents <= 0) continue;
    obligations.push({
      id: obligationLiabilityId(liability.id),
      sourceId: liability.id,
      month,
      amountCents,
      treatment: "debt-payment",
      funding: { kind: "automatic" },
      priority: UNRESOLVED_PRIORITY,
      sourceKind: "liability",
      editable: false,
      label: LIABILITY_LABEL[liability.kind],
      category: "debtService",
    });
  }

  return obligations;
}
