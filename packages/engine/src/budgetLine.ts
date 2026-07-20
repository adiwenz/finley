/**
 * The line-item budget authoring model (§12, §15, §18, §19 of
 * JOBS_HOUSEHOLD_REDESIGN, issue #67, slice 4) — the *new* source of truth for
 * cash allocation, replacing the scalar `Plan.expenseCents` /
 * `retirementDeferralPct%` / `surplusSwept`. A budget is a **prioritized list of
 * dollar line items**: general expenses and dollar contributions to named
 * accounts, each with an explicit {@link AmountSource} and time-variation
 * (spans + dated value overrides).
 *
 * Pure types plus one pure resolver. This module imports nothing from
 * `projection/*`, so the standing budget types stay clear of the simulator core
 * (the sim dependency lives in {@link import("./compileBudget")}). It lands
 * **additively**, alongside the scalar budget path — both compile into the same
 * `LedgerBaseConfig` — so nothing existing is removed here (that is #72's job).
 *
 * Two facts a contribution line needs are jurisdiction-agnostic and ride on the
 * target *account*, never named per line in engine vocabulary (§12):
 *   - **pre/post-tax treatment** — the account target carries a {@link TaxTreatment}
 *     (`preTax`/`postTax`) directly. The concrete vehicle names that imply it (US
 *     "traditional"/"Roth", UK ISA/SIPP, …) are jurisdiction-specific and live in
 *     the `rules`/`Account` layer, which maps a vehicle to this portable treatment;
 *     the engine never hardcodes a jurisdiction's account-type names (issue #38).
 *   - **the annual limit** a `fill-to-limit` line tracks — supplied through the
 *     rules/jurisdiction seam ({@link ResolveLineContext.annualLimitCents}), which
 *     auto-follows the legislated age-50 catch-up bump with no user edit (§19).
 */

import type { Cents } from "./money";
import type { OverrideScope } from "./cashFlowSeries";
import type { DeferralLimitContext } from "./jurisdiction";

/**
 * Whether a contribution goes in pre-tax (reduces taxable income) or post-tax
 * (§12). This is the portable, jurisdiction-agnostic fact the waterfall consumes;
 * the concrete account vehicle that implies it (US "traditional"/"Roth", etc.) is
 * a jurisdiction concern the `rules`/`Account` layer resolves to this treatment.
 */
export type TaxTreatment = "preTax" | "postTax";

/**
 * What a line funds (§12): general expenses (a cash outflow) or a dollar
 * contribution to a named account. A contribution carries the target account's
 * {@link TaxTreatment} directly (derived upstream from the account's vehicle), so
 * pre/post-tax treatment is read off the target, not authored per line and not
 * named in engine-side jurisdiction vocabulary. The legislated annual cap a
 * `fill-to-limit` line tracks arrives separately through the rules/jurisdiction
 * seam ({@link ResolveLineContext.annualLimitCents}).
 */
export type BudgetTarget =
  | { readonly kind: "expense" }
  | {
      readonly kind: "account";
      readonly accountId: string;
      readonly taxTreatment: TaxTreatment;
    };

/**
 * How a line's dollar amount is computed each month (§19) — the three amount
 * sources:
 *   - `literal` — a fixed monthly dollar amount authored directly.
 *   - `fillToLimit` — max out the target account's legislated annual cap, spread
 *     evenly across the year. Auto-follows the age-50 catch-up bump via the
 *     rules/jurisdiction seam ({@link ResolveLineContext.annualLimitCents}); the
 *     user authors nothing (§19, AC3).
 *   - `goalPaced` — the #26 deadline-paced sinking-fund pace: fund the remaining
 *     gap to `targetCents` evenly over the months left to `targetMonth`. The full
 *     #26 pacing computation is wired in slice 6; this carries the primitive.
 */
export type AmountSource =
  | { readonly kind: "literal"; readonly monthlyCents: Cents }
  | { readonly kind: "fillToLimit" }
  | { readonly kind: "goalPaced"; readonly targetCents: Cents; readonly targetMonth: number };

/**
 * Descriptive category tier (§15): needs/wants/savings. A default-priority source
 * (needs before wants before savings) and a UI ring, but NOT constraining — an
 * explicit {@link BudgetLine.priority} overrides it.
 */
export type BudgetCategory = "needs" | "wants" | "savings";

/**
 * The calendar window a line is active in (§19 spans). `startMonth` is inclusive,
 * `endMonth` exclusive; an absent bound is open on that side. Outside the span the
 * line resolves to 0 — it contributes nothing to that month's allocation.
 */
export interface BudgetLineSpan {
  /** Inclusive first active month (absent = active from month 0). */
  readonly startMonth?: number;
  /** Exclusive last active month (absent = never stops). */
  readonly endMonth?: number;
}

/**
 * A dated value override on a line (§10.3/§19: "value edits are overrides, not
 * events"). From `month`, the line's monthly amount becomes `monthlyCents`,
 * layered on top of whatever the {@link AmountSource} computes. A
 * `thisMonthOnly` override perturbs exactly that month; a `fromHereForward`
 * override replaces the amount from that month onward. This is the explicit
 * alternative to `fill-to-limit` for the age-50 catch-up: a dated dollar bump.
 */
export interface BudgetLineOverride {
  readonly month: number;
  readonly monthlyCents: Cents;
  readonly scope: OverrideScope;
}

/**
 * One budget line (§12): an expense or a dollar contribution to a named account,
 * with an amount source, a descriptive category, an optional explicit priority,
 * and optional time-variation (span + dated overrides). Dollars, not percentages.
 * Priority is the line's rank in the waterfall (§15); when absent the category
 * tier supplies the default (see {@link orderBudgetLines}).
 */
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
 * The environment a single line resolves against for one month. The engine is
 * pure and cannot read a wall clock, so `year` (the calendar year of `month`) and
 * `age` (the contributor's age that year) are supplied by the caller. The two
 * seams a source may need — the legislated annual cap and the current fund
 * balance — are passed as data, keeping the resolver jurisdiction-agnostic.
 */
export interface ResolveLineContext {
  /** Absolute simulation month being resolved (0 = "now"). */
  readonly month: number;
  /** Calendar year of `month` — parameterizes the year-indexed contribution cap. */
  readonly year: number;
  /** The contributor's age in `year`; enables the fill-to-limit age-50 catch-up bump. */
  readonly age?: number;
  /**
   * §12 rules/jurisdiction seam: the target account's legislated annual
   * contribution cap for the given year+age. Consulted ONLY by `fill-to-limit`.
   * Absent → uncapped, so a `fill-to-limit` line has no cap to max and resolves
   * to 0 (nothing to fill). The catch-up bump rides inside this function, so the
   * line auto-follows it with no authoring change (§19, AC3).
   */
  readonly annualLimitCents?: (ctx: DeferralLimitContext) => Cents;
  /**
   * The target account's current balance, for `goal-paced` pacing (the gap to the
   * target ÷ the months left). Absent → treated as 0 (fund the whole target).
   */
  readonly currentBalanceCents?: Cents;
}

/** Whether `month` falls inside a line's span (§19). No span → always active. */
function isWithinSpan(span: BudgetLineSpan | undefined, month: number): boolean {
  if (span === undefined) return true;
  if (span.startMonth !== undefined && month < span.startMonth) return false;
  if (span.endMonth !== undefined && month >= span.endMonth) return false;
  return true;
}

/** The base monthly amount an {@link AmountSource} yields for a month, before overrides. */
function baseSourceMonthlyCents(source: AmountSource, ctx: ResolveLineContext): Cents {
  switch (source.kind) {
    case "literal":
      return source.monthlyCents;
    case "fillToLimit": {
      // "Max the target account's annual cap" — spread evenly across the 12 months
      // of the year. The cap (incl. the age-50 catch-up) comes entirely from the
      // rules/jurisdiction seam; no seam → no cap to fill → 0 (§19, AC3).
      if (ctx.annualLimitCents === undefined) return 0;
      const annualCap = ctx.annualLimitCents({ year: ctx.year, age: ctx.age });
      return Math.round(annualCap / 12);
    }
    case "goalPaced": {
      // #26 deadline pace: the remaining gap funded evenly over the months left.
      // Past (or at) the deadline there is no time left to pace, so it stops.
      const monthsLeft = source.targetMonth - ctx.month;
      if (monthsLeft <= 0) return 0;
      const remaining = Math.max(0, source.targetCents - (ctx.currentBalanceCents ?? 0));
      return Math.round(remaining / monthsLeft);
    }
  }
}

/**
 * The dated-override value that applies at `month`, or `undefined` if none (§19).
 * A `thisMonthOnly` override at exactly `month` wins outright; otherwise the
 * latest `fromHereForward` override on or before `month` stands. Mirrors the
 * {@link import("./cashFlowSeries").SimCashFlowSeries} override semantics so the
 * authoring model and the compiled series agree.
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
 * Resolve one budget line to its funded monthly dollar amount for a single month
 * (§19) — the amount source computed, then any dated override layered on top,
 * gated by the line's span. This is the primitive the waterfall/compilation reads
 * so all three amount sources resolve through one path (AC2). Pure and
 * jurisdiction-agnostic: every jurisdiction fact arrives via {@link
 * ResolveLineContext}.
 */
export function resolveBudgetLineMonthlyCents(line: BudgetLine, ctx: ResolveLineContext): Cents {
  if (!isWithinSpan(line.span, ctx.month)) return 0;
  const override = overrideValueAt(line.overrides, ctx.month);
  return override ?? baseSourceMonthlyCents(line.amountSource, ctx);
}

/** The tax treatment a line's contribution carries — post-tax for expenses (§12). */
export function taxTreatmentForLine(line: BudgetLine): TaxTreatment {
  return line.target.kind === "account" ? line.target.taxTreatment : "postTax";
}

/** Default priority a category tier implies (§15): needs before wants before savings. */
const CATEGORY_DEFAULT_PRIORITY: Record<BudgetCategory, number> = {
  needs: 0,
  wants: 1000,
  savings: 2000,
};

/**
 * The budget as a prioritized list (§15): explicit {@link BudgetLine.priority}
 * first, else the category tier default. A stable sort keeps authored order within
 * a tier. Order only bites in a shortfall — it is the waterfall's funding sequence.
 */
export function orderBudgetLines(lines: readonly BudgetLine[]): BudgetLine[] {
  const priorityOf = (l: BudgetLine): number =>
    l.priority ?? CATEGORY_DEFAULT_PRIORITY[l.category];
  return lines
    .map((line, index) => ({ line, index }))
    .sort((a, b) => priorityOf(a.line) - priorityOf(b.line) || a.index - b.index)
    .map((e) => e.line);
}

/** One line's resolved amount for a month, with its target and derived tax treatment. */
export interface ResolvedBudgetLine {
  readonly lineId: string;
  readonly target: BudgetTarget;
  readonly taxTreatment: TaxTreatment;
  readonly monthlyCents: Cents;
}

/**
 * Resolve the whole budget for one month into the prioritized, per-line funded
 * view (§13 `allocations()` / §Q27 per-line monthly resolution): every line's
 * dollar amount in waterfall priority order, each tagged with the pre/post-tax
 * treatment derived from its target account's kind (§12). This is the resolved
 * allocation the waterfall consumes — author line ↔ resolved line.
 */
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
