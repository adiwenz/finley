/**
 * CashFlowSeries
 * --------------
 * The single reusable primitive for any recurring dollar amount that changes
 * over time: salary, rent, groceries, debt payments, etc.
 *
 * Design rules encoded here (from prior architecture decisions):
 *  1. All math is done in integer CENTS. Never floats for money.
 *  2. Annual amounts are broken into 12 monthly values using CUMULATIVE
 *     ROUNDING so the 12 months always sum exactly to the annual total:
 *       month(m) = round(annual * m/12) - round(annual * (m-1)/12)
 *  3. Year-over-year growth compounds from the previous year's ACTUAL cents
 *     value (iteratively), never re-derived from the original baseline —
 *     this avoids compounding float/rounding error over long horizons.
 *  4. A user "editing a point on the timeline" is modeled as an Override,
 *     which is either:
 *       - fromHereForward: resets the baseline going forward (a new segment)
 *       - thisMonthOnly: perturbs exactly one month, nothing else
 *  5. Recompute is lazy and cached; adding an override only invalidates
 *     cached months from that point forward.
 */

export type GrowthMode =
  | { type: "fixed" }
  | { type: "inflationLinked"; annualRate: number }
  | { type: "customRate"; annualRate: number }
  | { type: "salaryCompound"; annualRate: number };

export type OverrideScope = "thisMonthOnly" | "fromHereForward";

/** A contiguous stretch of time governed by one baseline + growth mode. */
interface Segment {
  /** Absolute month index (0-based from series start) this segment begins at. */
  startMonth: number;
  /** Annual amount, in cents, effective for the 12-month cycle starting at startMonth. */
  annualCents: number;
  growthMode: GrowthMode;
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

/** Cumulative-rounding split of an annual cents figure into its 12 monthly cents values. */
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

  /** Per-segment cache of annualCents by yearsElapsed, built iteratively. */
  private yearlyAnnualCache: Map<Segment, Map<number, number>> = new Map();
  /** Final monthly cents cache, keyed by absolute month. Invalidated forward on override. */
  private monthlyCache: Map<number, number> = new Map();

  constructor(startMonth: number, initialAnnualCents: number, growthMode: GrowthMode) {
    this.segments = [{ startMonth, annualCents: initialAnnualCents, growthMode }];
  }

  /**
   * Apply a user edit at a point on the timeline.
   * @param month absolute month index being edited
   * @param newMonthlyCents the new monthly amount the user typed in
   * @param scope thisMonthOnly | fromHereForward
   * @param newGrowthMode optional: change the growth mode going forward (fromHereForward only)
   */
  addOverride(
    month: number,
    newMonthlyCents: number,
    scope: OverrideScope,
    newGrowthMode?: GrowthMode
  ): void {
    if (scope === "thisMonthOnly") {
      this.singleMonthOverrides.set(month, newMonthlyCents);
      this.invalidateFrom(month, /*onlyThisMonth*/ true);
      return;
    }

    // fromHereForward: start a brand new segment from this month.
    // We approximate the new annual baseline as 12x the typed monthly value.
    // This is a deliberate simplification: the user is telling us "this is
    // what it looks like now", and cumulative rounding will re-derive the
    // exact monthly split going forward.
    const priorSegment = this.segmentFor(month);
    const newSegment: Segment = {
      startMonth: month,
      annualCents: newMonthlyCents * 12,
      growthMode: newGrowthMode ?? priorSegment.growthMode,
    };

    // Drop any existing segments that start at or after this month (they're superseded).
    this.segments = this.segments.filter((s) => s.startMonth < month);
    this.segments.push(newSegment);
    this.segments.sort((a, b) => a.startMonth - b.startMonth);

    this.invalidateFrom(month, /*onlyThisMonth*/ false);
  }

  private invalidateFrom(month: number, onlyThisMonth: boolean): void {
    if (onlyThisMonth) {
      this.monthlyCache.delete(month);
      return;
    }
    for (const cachedMonth of Array.from(this.monthlyCache.keys())) {
      if (cachedMonth >= month) this.monthlyCache.delete(cachedMonth);
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

  /** Annual cents for the segment's year-cycle containing `month`, grown iteratively. */
  private annualCentsAt(segment: Segment, month: number): number {
    const yearsElapsed = Math.floor((month - segment.startMonth) / 12);
    let cache = this.yearlyAnnualCache.get(segment);
    if (!cache) {
      cache = new Map();
      this.yearlyAnnualCache.set(segment, cache);
    }
    if (cache.has(yearsElapsed)) return cache.get(yearsElapsed)!;

    const rate = rateFor(segment.growthMode);
    // Iteratively compound from year 0 using each year's actual cents value
    // (never re-derived from the original baseline), caching every year we pass.
    let cents = cache.get(0) ?? segment.annualCents;
    if (!cache.has(0)) cache.set(0, segment.annualCents);
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

  /** Get the monthly cents value for an absolute month index. */
  getMonthlyCents(month: number): number {
    if (this.singleMonthOverrides.has(month)) {
      return this.singleMonthOverrides.get(month)!;
    }
    if (this.monthlyCache.has(month)) {
      return this.monthlyCache.get(month)!;
    }

    const segment = this.segmentFor(month);
    const annualCents = this.annualCentsAt(segment, month);
    const monthInCycle = (month - segment.startMonth) % 12;
    const monthlyValues = splitAnnualToMonths(annualCents);
    const value = monthlyValues[monthInCycle];

    this.monthlyCache.set(month, value);
    return value;
  }

  /** Convenience: monthly cents values for an inclusive range of absolute months. */
  getRangeCents(startMonth: number, endMonthInclusive: number): number[] {
    const out: number[] = [];
    for (let m = startMonth; m <= endMonthInclusive; m++) {
      out.push(this.getMonthlyCents(m));
    }
    return out;
  }
}
