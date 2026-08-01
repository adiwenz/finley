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

/**
 * Which authoring model an obligation's money comes from. Provenance, not presentation: it
 * says where to go to change the number, or that there is nowhere.
 */
export type ObligationSourceKind =
  /**
   * A standing budget line the user authors and edits — including health, which is an ordinary
   * `healthcare`-category line rather than the standing plan input it used to be.
   */
  | "budgetLine"
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
export type ObligationCategory = BudgetCategory | "debtService" | "other";

/**
 * The provenance an expense {@link SimOwnedSeries} carries so {@link buildObligations} can turn
 * it into an obligation. Set where the series is compiled — the only place that knows its
 * authoring model — and read only here. Liabilities carry no source: their obligation is built
 * from the roster and the payment map, not a tagged series.
 */
export interface ObligationSource {
  readonly kind: Exclude<ObligationSourceKind, "liability">;
  readonly id: string;
  readonly category: ObligationCategory;
  readonly editable: boolean;
  /**
   * The waterfall priority this source resolves to, carried from its compiler because the tier
   * cannot be recovered from `kind` alone: a budget line's authored/category ordering and a
   * court-ordered stream's mandatory rank both live in the authoring model. Absent → the
   * obligation defaults to its kind's tier ({@link DEFAULT_PRIORITY_BY_KIND}).
   */
  readonly priority?: number;
}

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
  /**
   * Waterfall rank, lower funded first. Resolved at construction from source kind ({@link
   * OBLIGATION_PRIORITY}). Ties break on the stable {@link id}, so obligations sharing a tier
   * hold a fixed order across months and chart bands never reshuffle.
   */
  readonly priority: number;
  readonly sourceKind: ObligationSourceKind;
  /**
   * Editable *as itself* — true only for an authored budget line, health included. An event's
   * expense is edited through its event, a loan payment not at all (change the loan).
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

/**
 * The obligation list ordered by {@link FinancialObligation.priority} ascending (see
 * {@link OBLIGATION_PRIORITY} for the ranking itself), ties broken on the stable
 * {@link FinancialObligation.id} — the id tie-break is what stops obligations sharing a tier
 * from reshuffling month to month, and from swapping which one a partial month's funding
 * reaches first.
 *
 * Two consumers: the order chart bands stack in, and the order {@link fundedLiabilityPayments}
 * walks to decide which obligation a scarce month's cash actually reached. Kept out of
 * {@link buildObligations} itself, whose output stays in source order — the waterfall's TOTAL
 * draw is order-invariant (it only cares about the summed `automaticFundingTotal`).
 */
export function orderObligationsByPriority(
  obligations: readonly FinancialObligation[],
): FinancialObligation[] {
  return [...obligations].sort(
    (a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * How much of EACH liability's scheduled payment actually got funded this month, given the
 * total the household could actually pay toward its obligations (`fundedTotalCents` — the
 * month's `automaticFundingTotal` minus whatever of it went unfunded).
 *
 * Walks every obligation — not liabilities alone — in {@link orderObligationsByPriority}'s
 * order, spending down `fundedTotalCents` obligation by obligation; a liability's own funded
 * amount is capped at what it's owed and at whatever budget is left when the walk reaches it.
 * PARTIAL, not all-or-nothing: a liability only partly reachable amortizes down by exactly
 * that partial amount, the same way a real partial payment reduces principal by what it
 * actually pays rather than nothing. Non-liability obligations still consume their place in
 * the walk — only a liability's own funded figure is returned.
 */
export function fundedLiabilityPayments(
  obligations: readonly FinancialObligation[],
  fundedTotalCents: Cents,
): Map<string, Cents> {
  const applied = new Map<string, Cents>();
  let remaining = Math.max(0, fundedTotalCents);
  for (const o of orderObligationsByPriority(obligations)) {
    const appliedCents = Math.max(0, Math.min(o.amountCents, remaining));
    remaining -= appliedCents;
    if (o.sourceKind === "liability") applied.set(o.sourceId, appliedCents);
  }
  return applied;
}

/** A debt's payment named from its kind — the only human fact a liability has. */
const LIABILITY_LABEL: Record<LiabilityKind, string> = {
  mortgage: "Mortgage payment",
  auto: "Auto loan payment",
  studentLoan: "Student loan payment",
  creditCard: "Credit card payment",
};

/** Provenance for an expense series that reached construction without tagging itself. */
const UNTRACKED: ObligationSource = {
  kind: "untracked",
  id: "expenses",
  category: "other",
  editable: false,
};

/**
 * Waterfall tiers, lower funded first — resolved from source kind, no new authoring surface.
 *
 * `mandatory` is below every expense: debt payments and court-ordered support (alimony, child
 * support) are legally non-rationable, so they fund FIRST — {@link fundedLiabilityPayments}
 * only ever starves one once the shortfall is severe enough to eat into this tier itself, never
 * because a lower-priority need or want went unfunded first. `needs` shares the budget "needs"
 * tier (0) so a child's cost ranks beside a user's own needs lines. An authored budget line
 * brings its own category/priority ordering and never reads a default here — health included,
 * whose `healthcare` category resolves to the same tier (0); `untracked` has no provenance to
 * rank by and funds after every authored tier.
 */
export const OBLIGATION_PRIORITY = {
  mandatory: -1000,
  needs: 0,
  untracked: 3000,
} as const;

/**
 * The tier a non-liability source funds at when it carries no explicit priority of its own.
 * Budget lines resolve their real priority in compilation ({@link ObligationSource.priority}) and
 * only hit `needs` here as a fallback; court-ordered event streams likewise stamp `mandatory` on
 * their source, since a child's cost and alimony share the `event` kind and cannot be told apart
 * by kind alone.
 */
const DEFAULT_PRIORITY_BY_KIND: Record<ObligationSource["kind"], number> = {
  budgetLine: OBLIGATION_PRIORITY.needs,
  event: OBLIGATION_PRIORITY.needs,
  untracked: OBLIGATION_PRIORITY.untracked,
};

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
 * debt, never by affordability). Reported here at that full authored amount regardless of
 * whether the month actually funded it — {@link import("./liabilitySteps").advanceLiabilities}
 * is what withholds the balance reduction on a month the shortfall cascade could not cover.
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
    const source = s.obligationSource ?? UNTRACKED;
    return {
      id: source.kind === "budgetLine" ? `line:${source.id}` : source.id,
      sourceId: source.id,
      month,
      amountCents: s.series.getMonthlyCents(month),
      treatment: "expense",
      funding: { kind: "automatic" },
      priority: source.priority ?? DEFAULT_PRIORITY_BY_KIND[source.kind],
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
      priority: OBLIGATION_PRIORITY.mandatory,
      sourceKind: "liability",
      editable: false,
      label: LIABILITY_LABEL[liability.kind],
      category: "debtService",
    });
  }

  return obligations;
}
