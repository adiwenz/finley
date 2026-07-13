/**
 * CashFlowSeries
 * --------------
 * The single reusable primitive for any recurring dollar amount that changes
 * over time: salary, rent, groceries, debt payments, support obligations.
 *
 * Design rules:
 *  1. All math is done in integer CENTS. Never floats for money.
 *  2. Annual-native amounts: split via cumulative rounding so 12 months sum
 *     exactly to the annual total.
 *  3. Monthly-native amounts: repeat exactly each month — no split, no drift.
 *  4. Year-over-year growth compounds iteratively from the prior year's actual
 *     cents value (cached per segment), never re-derived from the baseline.
 *  5. Three edit operations:
 *     - thisMonthOnly: perturbs exactly one month.
 *     - fromHereForward: starts a new segment (optionally with resetAnchor).
 *     - correctHistory: edits a prior segment's baseCents in-place; no new segment.
 *  6. Recompute is lazy and cached; an override invalidates from that month forward.
 */

export type GrowthMode =
  | { type: "fixed" }
  | { type: "inflationLinked"; annualRate: number }
  | { type: "customRate"; annualRate: number }
  | { type: "salaryCompound"; annualRate: number };

export type OverrideScope = "thisMonthOnly" | "fromHereForward";

/** v1-ignored seam: tax routing category for income series. */
export type TaxCategory =
  | "wages"
  | "socialSecurity"
  | "ordinaryIncome"
  | "capitalGains"
  | "taxExempt";

export interface CashFlowSeriesOptions {
  /**
   * "annual" (default): baseCents is the annual amount; monthly via cumulative
   * rounding. Use for salary, annual subscriptions.
   * "monthly": baseCents is the monthly amount; repeats exactly — no rounding
   * drift. Use for rent, groceries, fixed debt payments.
   */
  baselineUnit?: "annual" | "monthly";
  /**
   * "ownCycle" (default): growth fires every 12 months from anchorMonth.
   * "calendar": growth fires on simulation calendar year boundaries (months 12, 24…).
   */
  growthAnchor?: "ownCycle" | "calendar";
  /**
   * Absolute month (from sim start) where the growth clock started.
   * May be negative for backdated streams. Defaults to startMonth.
   * Ignored for "calendar" anchor (always anchors to month 0).
   */
  anchorMonth?: number;
  /** Inclusive end month; getMonthlyCents returns 0 for month > endMonth. */
  endMonth?: number;
  /** v1-ignored seam: category for future tax routing. */
  taxCategory?: TaxCategory;
}

interface Segment {
  startMonth: number;
  /**
   * Annual cents when baselineUnit="annual"; monthly cents when
   * baselineUnit="monthly". The iteration cache preserves the actual
   * compounded value at each year to avoid re-deriving from the baseline.
   */
  baseCents: number;
  growthMode: GrowthMode;
  /** The month from which this segment's growth clock counts (ownCycle only). */
  anchorMonth: number;
}

function rateFor(mode: GrowthMode): number {
  switch (mode.type) {
    case "fixed":
      return 0;
    case "inflationLinked":
    case "customRate":
    case "salaryCompound":
      return mode.annualRate;
  }
}

/**
 * The annual growth rate a {@link GrowthMode} implies — 0 for `fixed`, the
 * carried `annualRate` otherwise. Exposed so growth-bearing stocks that aren't
 * cash-flow series (a property's appreciating value, §4.1) can compound at the
 * same rate the series machinery uses, without duplicating the switch.
 */
export function growthAnnualRate(mode: GrowthMode): number {
  return rateFor(mode);
}

/** Cumulative-rounding split of an annual cents figure into its 12 monthly values. */
export function splitAnnualToMonths(annualCents: number): number[] {
  const months: number[] = [];
  let prevCum = 0;
  for (let m = 1; m <= 12; m++) {
    const cum = Math.round((annualCents * m) / 12);
    months.push(cum - prevCum);
    prevCum = cum;
  }
  return months;
}

/** Precise monthly compounding rate from an annual rate: (1+r)^(1/12) - 1 */
export function preciseMonthlyRate(annualRate: number): number {
  return Math.pow(1 + annualRate, 1 / 12) - 1;
}

export function dollarsToCents(amount: number): number {
  return Math.round(amount * 100);
}

export function centsToDollars(cents: number): number {
  return cents / 100;
}

export class CashFlowSeries {
  private segments: Segment[];
  private singleMonthOverrides: Map<number, number> = new Map();
  private readonly baselineUnit: "annual" | "monthly";
  private readonly growthAnchorMode: "ownCycle" | "calendar";
  /** The construction-time start month; getMonthlyCents returns 0 for month < startMonth. */
  readonly startMonth: number;
  readonly endMonth: number | undefined;
  readonly taxCategory: TaxCategory | undefined;

  /** Per-segment cache: yearsElapsed → compounded baseCents at that year. */
  private yearlyBaseCache: Map<Segment, Map<number, number>> = new Map();
  /** Final monthly cents cache, keyed by absolute month. */
  private monthlyCache: Map<number, number> = new Map();

  constructor(
    startMonth: number,
    initialBaseCents: number,
    growthMode: GrowthMode,
    options?: CashFlowSeriesOptions,
  ) {
    this.startMonth = startMonth;
    this.baselineUnit = options?.baselineUnit ?? "annual";
    this.growthAnchorMode = options?.growthAnchor ?? "ownCycle";
    this.endMonth = options?.endMonth;
    this.taxCategory = options?.taxCategory;
    const anchorMonth = options?.anchorMonth ?? startMonth;
    this.segments = [{ startMonth, baseCents: initialBaseCents, growthMode, anchorMonth }];
  }

  addOverride(
    month: number,
    newMonthlyCents: number,
    scope: OverrideScope,
    options?: { newGrowthMode?: GrowthMode; resetAnchor?: boolean },
  ): void {
    if (scope === "thisMonthOnly") {
      this.singleMonthOverrides.set(month, newMonthlyCents);
      this.invalidateFrom(month, true);
      return;
    }

    const priorSegment = this.segmentFor(month);
    const newAnchor = options?.resetAnchor === true ? month : priorSegment.anchorMonth;
    const newBaseCents =
      this.baselineUnit === "monthly" ? newMonthlyCents : newMonthlyCents * 12;

    const newSegment: Segment = {
      startMonth: month,
      baseCents: newBaseCents,
      growthMode: options?.newGrowthMode ?? priorSegment.growthMode,
      anchorMonth: newAnchor,
    };

    this.segments = this.segments.filter((s) => s.startMonth < month);
    this.segments.push(newSegment);
    this.segments.sort((a, b) => a.startMonth - b.startMonth);
    this.invalidateFrom(month, false);
  }

  /**
   * History correction: edit a prior segment's base value in-place.
   * No new segment is created; the boundary stays where it is.
   */
  correctHistory(segmentStartMonth: number, newBaseCents: number): void {
    const segment = this.segments.find((s) => s.startMonth === segmentStartMonth);
    if (!segment) return;
    segment.baseCents = newBaseCents;
    this.yearlyBaseCache.delete(segment);
    this.invalidateFrom(segmentStartMonth, false);
  }

  private invalidateFrom(month: number, onlyThisMonth: boolean): void {
    if (onlyThisMonth) {
      this.monthlyCache.delete(month);
      return;
    }
    for (const m of Array.from(this.monthlyCache.keys())) {
      if (m >= month) this.monthlyCache.delete(m);
    }
  }

  private segmentFor(month: number): Segment {
    let best = this.segments[0];
    for (const s of this.segments) {
      if (s.startMonth <= month) best = s;
      else break;
    }
    return best;
  }

  private yearsElapsedFor(segment: Segment, month: number): number {
    if (this.growthAnchorMode === "calendar") {
      return Math.floor(month / 12);
    }
    return Math.max(0, Math.floor((month - segment.anchorMonth) / 12));
  }

  private monthInCycleFor(segment: Segment, month: number): number {
    if (this.growthAnchorMode === "calendar") {
      return month % 12;
    }
    const fromAnchor = month - segment.anchorMonth;
    return ((fromAnchor % 12) + 12) % 12;
  }

  private baseCentsAt(segment: Segment, yearsElapsed: number): number {
    let cache = this.yearlyBaseCache.get(segment);
    if (!cache) {
      cache = new Map();
      this.yearlyBaseCache.set(segment, cache);
    }
    if (cache.has(yearsElapsed)) return cache.get(yearsElapsed)!;

    const rate = rateFor(segment.growthMode);
    let cents = cache.get(0) ?? segment.baseCents;
    if (!cache.has(0)) cache.set(0, segment.baseCents);

    for (let y = 1; y <= yearsElapsed; y++) {
      if (cache.has(y)) {
        cents = cache.get(y)!;
        continue;
      }
      cents = Math.round(cents * (1 + rate));
      cache.set(y, cents);
    }
    return cents;
  }

  getMonthlyCents(month: number): number {
    if (month < this.startMonth) return 0;
    if (this.endMonth != null && month > this.endMonth) return 0;

    if (this.singleMonthOverrides.has(month)) {
      return this.singleMonthOverrides.get(month)!;
    }
    if (this.monthlyCache.has(month)) {
      return this.monthlyCache.get(month)!;
    }

    const segment = this.segmentFor(month);
    const yearsElapsed = this.yearsElapsedFor(segment, month);
    const baseCents = this.baseCentsAt(segment, yearsElapsed);

    let value: number;
    if (this.baselineUnit === "monthly") {
      value = baseCents;
    } else {
      const monthInCycle = this.monthInCycleFor(segment, month);
      value = splitAnnualToMonths(baseCents)[monthInCycle];
    }

    this.monthlyCache.set(month, value);
    return value;
  }

  getRangeCents(startMonth: number, endMonthInclusive: number): number[] {
    const out: number[] = [];
    for (let m = startMonth; m <= endMonthInclusive; m++) {
      out.push(this.getMonthlyCents(m));
    }
    return out;
  }
}
