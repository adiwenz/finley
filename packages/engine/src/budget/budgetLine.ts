/**
 * The line-item budget authoring model: a prioritized list of dollar line items — expenses
 * and dollar contributions to named accounts.
 *
 * Imports nothing from `projection/*`; that dependency lives in
 * {@link import("../compile/compileBudget")}.
 *
 * Two jurisdiction facts ride on the target *account*, never per line: the pre/post-tax
 * {@link TaxTreatment}, and the annual limit a `fill-to-limit` line tracks ({@link
 * ResolveLineContext.annualLimitCents}). Vehicle names implying them (US
 * "traditional"/"Roth", UK ISA/SIPP) stay in the `rules`/`Account` layer.
 */

import type { Cents } from "../money/money";
import type { OverrideScope } from "../money/cashFlowSeries";
import type { DeferralLimitContext } from "../jurisdiction/jurisdiction";
import { requiredContributionCents } from "../goal/requiredContribution";

/** `preTax` reduces taxable income; `postTax` does not. */
export type TaxTreatment = "preTax" | "postTax";

export type BudgetTarget =
  | { readonly kind: "expense" }
  | {
      readonly kind: "account";
      readonly accountId: string;
      readonly taxTreatment: TaxTreatment;
    };

/**
 * How a line's monthly dollar amount is computed. `fillToLimit` spreads the target
 * account's legislated annual cap evenly across the year, following the age-50 catch-up
 * bump with no authoring change; `goalPaced` is a sinking fund, pacing the gap to
 * `targetCents` over the months left to `targetMonth`.
 */
export type AmountSource =
  | { readonly kind: "literal"; readonly monthlyCents: Cents }
  | { readonly kind: "fillToLimit" }
  | { readonly kind: "goalPaced"; readonly targetCents: Cents; readonly targetMonth: number };

/**
 * Descriptive tier, not constraining: it supplies a default priority that an explicit
 * {@link BudgetLine.priority} overrides.
 *
 * `healthcare` is a tier rather than a plan field: health used to be a standing plan input
 * compiled into its own series, which made it the one recurring cost the budget editor could
 * not edit. It is an ordinary expense line now, and this tier is all that survives of the
 * distinction — it funds beside `needs` (see `CATEGORY_DEFAULT_PRIORITY`) and reads back as
 * itself on the spending chart.
 */
export type BudgetCategory = "needs" | "wants" | "savings" | "healthcare";

/** Outside its span a line resolves to 0. */
export interface BudgetLineSpan {
  /** Inclusive; absent = active from month 0. */
  readonly startMonth?: number;
  /** Exclusive; absent = never stops. */
  readonly endMonth?: number;
}

/** A dated override layered on top of the {@link AmountSource}. */
export interface BudgetLineOverride {
  readonly month: number;
  readonly monthlyCents: Cents;
  readonly scope: OverrideScope;
}

/** Dollars, not percentages. */
export interface BudgetLine {
  readonly id: string;
  readonly label: string;
  readonly target: BudgetTarget;
  readonly amountSource: AmountSource;
  readonly category: BudgetCategory;
  /** Explicit waterfall priority (lower = funded first); absent → category default. */
  readonly priority?: number;
  readonly span?: BudgetLineSpan;
  readonly overrides?: readonly BudgetLineOverride[];
}

/**
 * The engine is pure and cannot read a wall clock or jurisdiction rules, so calendar and
 * legislated facts arrive here as data.
 */
export interface ResolveLineContext {
  /** Absolute simulation month (0 = "now"). */
  readonly month: number;
  /** Calendar year of `month`; parameterizes the year-indexed contribution cap. */
  readonly year: number;
  /** The contributor's age in `year`; enables the age-50 catch-up bump. */
  readonly age?: number;
  /**
   * Jurisdiction seam, consulted only by `fill-to-limit`. Absent → no cap to fill, so the
   * line resolves to 0. The catch-up bump rides inside this function.
   */
  readonly annualLimitCents?: (ctx: DeferralLimitContext) => Cents;
  /** For `goal-paced`. Absent → 0, i.e. fund the whole target. */
  readonly currentBalanceCents?: Cents;
  /** For the growth-aware `goal-paced` pace; absent → 0, a flat even spread. */
  readonly fundMonthlyRate?: number;
}

/** No span → always active. */
function isWithinSpan(span: BudgetLineSpan | undefined, month: number): boolean {
  if (span === undefined) return true;
  if (span.startMonth !== undefined && month < span.startMonth) return false;
  if (span.endMonth !== undefined && month >= span.endMonth) return false;
  return true;
}

function baseSourceMonthlyCents(source: AmountSource, ctx: ResolveLineContext): Cents {
  switch (source.kind) {
    case "literal":
      return source.monthlyCents;
    case "fillToLimit": {
      if (ctx.annualLimitCents === undefined) return 0;
      const annualCap = ctx.annualLimitCents({ year: ctx.year, age: ctx.age });
      return Math.round(annualCap / 12);
    }
    case "goalPaced": {
      // At or past the deadline there is nothing left to pace: the goal has matured.
      const monthsLeft = source.targetMonth - ctx.month;
      if (monthsLeft <= 0) return 0;
      return requiredContributionCents(
        source.targetCents,
        ctx.currentBalanceCents ?? 0,
        monthsLeft,
        ctx.fundMonthlyRate ?? 0,
      );
    }
  }
}

/**
 * A `thisMonthOnly` override at exactly `month` wins outright; otherwise the latest
 * `fromHereForward` on or before `month` stands. Mirrors {@link
 * import("../money/cashFlowSeries").SimCashFlowSeries}, so authoring model and compiled series agree.
 */
function overrideValueAt(
  overrides: readonly BudgetLineOverride[] | undefined,
  month: number,
): Cents | undefined {
  if (overrides === undefined || overrides.length === 0) return undefined;
  const thisMonth = overrides.find((o) => o.scope === "thisMonthOnly" && o.month === month);
  if (thisMonth !== undefined) return thisMonth.monthlyCents;
  let latest: BudgetLineOverride | undefined;
  for (const o of overrides) {
    if (o.scope !== "fromHereForward" || o.month > month) continue;
    if (latest === undefined || o.month > latest.month) latest = o;
  }
  return latest?.monthlyCents;
}

/**
 * The single path all three amount sources resolve through, so the waterfall and
 * compilation cannot disagree.
 */
export function resolveBudgetLineMonthlyCents(line: BudgetLine, ctx: ResolveLineContext): Cents {
  if (!isWithinSpan(line.span, ctx.month)) return 0;
  const override = overrideValueAt(line.overrides, ctx.month);
  return override ?? baseSourceMonthlyCents(line.amountSource, ctx);
}

/** Expenses are post-tax. */
export function taxTreatmentForLine(line: BudgetLine): TaxTreatment {
  return line.target.kind === "account" ? line.target.taxTreatment : "postTax";
}

const CATEGORY_DEFAULT_PRIORITY: Record<BudgetCategory, number> = {
  needs: 0,
  // Shares the needs tier deliberately: health funded beside a user's own needs lines before it
  // was a budget line, and this preserves that rank rather than inventing a new one.
  healthcare: 0,
  wants: 1000,
  savings: 2000,
};

/**
 * The single source of truth for ordering: both {@link orderBudgetLines} and the obligation
 * compiler ({@link import("../compile/compileBudget").compileExpenseBudgetLines}, which stamps
 * each obligation's `priority`) read it, so the ordered view and the funded waterfall cannot
 * drift.
 */
export function budgetLinePriority(line: BudgetLine): number {
  return line.priority ?? CATEGORY_DEFAULT_PRIORITY[line.category];
}

/**
 * What the plan states it spends on health each month, in **today's dollars** — the budget's
 * answer to a question the plan used to hold as its own `healthMonthlyCents` field. Reads the
 * authored baseline rather than a resolved month, because its one caller (the early-retiree
 * check) compares it against a today's-dollars benchmark; pitting a grown figure against a real
 * one would flag every plan.
 *
 * Several health lines sum: nothing stops a user splitting premiums from prescriptions, and the
 * check asks what health costs, not how many rows say so. Non-literal sources cannot arise —
 * `compileExpenseLine` rejects them for expenses — so a baseline is always exactly the amount.
 */
export function healthcareMonthlyCents(lines: readonly BudgetLine[]): Cents {
  return lines.reduce(
    (total, line) =>
      line.category === "healthcare" && line.amountSource.kind === "literal"
        ? total + line.amountSource.monthlyCents
        : total,
    0,
  );
}

/**
 * The waterfall's funding sequence, which only bites in a shortfall. A stable sort keeps
 * authored order within a tier.
 */
export function orderBudgetLines(lines: readonly BudgetLine[]): BudgetLine[] {
  return lines
    .map((line, index) => ({ line, index }))
    .sort((a, b) => budgetLinePriority(a.line) - budgetLinePriority(b.line) || a.index - b.index)
    .map((e) => e.line);
}

export interface ResolvedBudgetLine {
  readonly lineId: string;
  readonly target: BudgetTarget;
  readonly taxTreatment: TaxTreatment;
  readonly monthlyCents: Cents;
}

export function resolveBudget(
  lines: readonly BudgetLine[],
  ctx: ResolveLineContext,
): ResolvedBudgetLine[] {
  return orderBudgetLines(lines).map((line) => ({
    lineId: line.id,
    target: line.target,
    taxTreatment: taxTreatmentForLine(line),
    monthlyCents: resolveBudgetLineMonthlyCents(line, ctx),
  }));
}

// ── Authoring transforms ──
//
// Pure list-in/list-out edits, beside the type they edit, so the `Projection` API and the
// app's Base + Adjustments panel share one definition of what editing a line means.

/** Every {@link BudgetLine} field except the stable `id`. */
export type BudgetLinePatch = Partial<Omit<BudgetLine, "id">>;

/**
 * Overwrite the named fields, carrying through what an edit does not name — the line's
 * `span`, its dated `overrides`, an explicit `priority`. Those are timeline facts about the
 * line rather than part of what an edit states.
 *
 * `target` and `amountSource` are whole discriminated unions and are replaced entire when
 * patched: half a union is not a value, so switching an expense line to a contribution means
 * supplying the new `target` complete. The `id` is stripped. An unknown id changes nothing.
 */
export function withLinePatch(
  lines: readonly BudgetLine[],
  id: string,
  patch: BudgetLinePatch,
): readonly BudgetLine[] {
  const { id: _drop, ...rest } = patch as Partial<BudgetLine>;
  return lines.map((l) => (l.id === id ? ({ ...l, ...rest } as BudgetLine) : l));
}

/** Drop a line. Nothing to guard: a line derives no account an event can reference. */
export function withoutLine(lines: readonly BudgetLine[], id: string): readonly BudgetLine[] {
  return lines.filter((l) => l.id !== id);
}

/**
 * Layer a dated override onto one line. At most one per (scope, month) — re-authoring the
 * same month at the same scope REPLACES rather than stacking, so the two scopes stay
 * independent (a `thisMonthOnly` correction does not erase the `fromHereForward` step it sits
 * on top of, and {@link overrideValueAt} still resolves them in that order).
 *
 * Appended, not sorted: `overrideValueAt` scans for the latest qualifying entry rather than
 * trusting order, and preserving authoring order keeps a re-authored month where the user
 * last put it. An unknown id changes nothing.
 */
export function withLineOverride(
  lines: readonly BudgetLine[],
  id: string,
  override: BudgetLineOverride,
): readonly BudgetLine[] {
  return lines.map((line) => {
    if (line.id !== id) return line;
    const kept = (line.overrides ?? []).filter(
      (o) => !(o.scope === override.scope && o.month === override.month),
    );
    return { ...line, overrides: [...kept, override] };
  });
}
