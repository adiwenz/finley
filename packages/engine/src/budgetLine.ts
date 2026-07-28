/**
 * The line-item budget authoring model: a prioritized list of dollar line items — expenses
 * and dollar contributions to named accounts — each with an {@link AmountSource} and
 * time-variation (spans + dated overrides).
 *
 * Imports nothing from `projection/*`, keeping these types clear of the simulator core;
 * that dependency lives in {@link import("./compileBudget")}.
 *
 * Two jurisdiction facts ride on the target *account*, never per line: the pre/post-tax
 * {@link TaxTreatment}, and the annual limit a `fill-to-limit` line tracks ({@link
 * ResolveLineContext.annualLimitCents}). Vehicle names implying them (US
 * "traditional"/"Roth", UK ISA/SIPP) stay in the `rules`/`Account` layer.
 */

import type { Cents } from "./money";
import type { OverrideScope } from "./cashFlowSeries";
import type { DeferralLimitContext } from "./jurisdiction";
import { requiredContributionCents } from "./requiredContribution";

/** `preTax` reduces taxable income; `postTax` does not. */
export type TaxTreatment = "preTax" | "postTax";

/**
 * What a line funds. A contribution carries its target account's {@link TaxTreatment}
 * directly, so treatment is read off the target rather than authored per line.
 */
export type BudgetTarget =
  | { readonly kind: "expense" }
  | {
      readonly kind: "account";
      readonly accountId: string;
      readonly taxTreatment: TaxTreatment;
    };

/**
 * How a line's monthly dollar amount is computed:
 *   - `literal` — authored directly.
 *   - `fillToLimit` — the target account's legislated annual cap spread evenly across the
 *     year, following the age-50 catch-up bump with no authoring change.
 *   - `goalPaced` — sinking fund: the gap to `targetCents` paced over the months left to
 *     `targetMonth`.
 */
export type AmountSource =
  | { readonly kind: "literal"; readonly monthlyCents: Cents }
  | { readonly kind: "fillToLimit" }
  | { readonly kind: "goalPaced"; readonly targetCents: Cents; readonly targetMonth: number };

/**
 * Descriptive tier, not constraining: it supplies a default priority (needs, wants,
 * savings) that an explicit {@link BudgetLine.priority} overrides.
 */
export type BudgetCategory = "needs" | "wants" | "savings";

/** Outside its span a line resolves to 0. */
export interface BudgetLineSpan {
  /** Inclusive; absent = active from month 0. */
  readonly startMonth?: number;
  /** Exclusive; absent = never stops. */
  readonly endMonth?: number;
}

/**
 * A dated override layered on top of the {@link AmountSource}: `thisMonthOnly` perturbs one
 * month, `fromHereForward` replaces the amount from `month` onward.
 */
export interface BudgetLineOverride {
  readonly month: number;
  readonly monthlyCents: Cents;
  readonly scope: OverrideScope;
}

/** One budget line. Dollars, not percentages. */
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
 * What one line resolves against for one month. The engine is pure and cannot read a wall
 * clock or jurisdiction rules, so calendar and legislated facts arrive here as data.
 */
export interface ResolveLineContext {
  /** Absolute simulation month (0 = "now"). */
  readonly month: number;
  /** Calendar year of `month`, parameterizing the year-indexed contribution cap. */
  readonly year: number;
  /** The contributor's age in `year`; enables the age-50 catch-up bump. */
  readonly age?: number;
  /**
   * Jurisdiction seam, consulted only by `fill-to-limit`. Absent → uncapped, so the line
   * has no cap to fill and resolves to 0. The catch-up bump rides inside this function.
   */
  readonly annualLimitCents?: (ctx: DeferralLimitContext) => Cents;
  /** For `goal-paced`. Absent → 0, i.e. fund the whole target. */
  readonly currentBalanceCents?: Cents;
  /**
   * For the growth-aware `goal-paced` pace; absent → 0, a flat even spread. Leaning on
   * projected growth lowers the required contribution below the flat pace.
   */
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
      // No jurisdiction seam → no cap to fill → 0.
      if (ctx.annualLimitCents === undefined) return 0;
      const annualCap = ctx.annualLimitCents({ year: ctx.year, age: ctx.age });
      return Math.round(annualCap / 12);
    }
    case "goalPaced": {
      // At or past the deadline there is no time left to pace: the goal has matured and
      // holds its accumulated fund.
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
 * import("./cashFlowSeries").SimCashFlowSeries}, so authoring model and compiled series agree.
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
  wants: 1000,
  savings: 2000,
};

/**
 * The single source of truth for ordering: both {@link orderBudgetLines} and the
 * `allocations()` view read it, so the two cannot drift on how a tier maps to a number.
 */
export function budgetLinePriority(line: BudgetLine): number {
  return line.priority ?? CATEGORY_DEFAULT_PRIORITY[line.category];
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

/** The whole budget for one month, in waterfall priority order. */
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
