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
