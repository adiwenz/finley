/**
 * CashFlowSeries — the one primitive for any recurring dollar amount that changes over
 * time: salary, rent, groceries, debt payments, support obligations.
 *
 * Rules:
 *  1. All math in integer CENTS, never floats.
 *  2. Annual-native amounts: split via cumulative rounding, so 12 months sum exactly to
 *     the annual total.
 *  3. Monthly-native amounts: repeat exactly each month — no split, no drift.
 *  4. Year-over-year growth compounds iteratively from the prior year's actual cents value
 *     (cached per segment), never re-derived from the baseline.
 *  5. Three edits: `thisMonthOnly` perturbs one month; `fromHereForward` starts a new
 *     segment (optionally with resetAnchor); `correctHistory` edits a prior segment's
 *     baseCents in-place, creating no segment.
 *  6. Recompute is lazy and cached; an override invalidates from that month forward.
 */

export type GrowthMode =
  | { type: "fixed" }
  | { type: "inflationLinked"; annualRate: number }
  | { type: "customRate"; annualRate: number }
  | { type: "salaryCompound"; annualRate: number };

export type OverrideScope = "thisMonthOnly" | "fromHereForward";

/**
 * The annual rate in force from `startMonth`, plus the {@link GrowthMode} that produced it:
 * `fixed` reads 0, and only the mode distinguishes "pinned flat" from "0% inflation this
 * run".
 */
export interface GrowthSegmentView {
  readonly startMonth: number;
  readonly annualRate: number;
  readonly mode: GrowthMode["type"];
}

/**
 * The engine-owned flow-provenance vocabulary: the engine labels where a flow originated, the
 * jurisdiction's tax seam decides how much of each category is taxed. Brand-neutral — no
 * jurisdiction program names, so US Social Security is `governmentRetirementBenefit`.
 */
export type TaxCategory =
  | "wages"
  | "governmentRetirementBenefit"
  | "ordinaryIncome"
  | "capitalGains"
  | "taxExempt";

export interface SimCashFlowSeriesOptions {
  /**
   * "annual" (default): baseCents is annual, split monthly via cumulative rounding.
   * "monthly": baseCents is the monthly amount, repeated exactly with no rounding drift.
   */
  baselineUnit?: "annual" | "monthly";
  /**
   * "ownCycle" (default): growth fires every 12 months from anchorMonth.
   * "calendar": growth fires on simulation calendar year boundaries (months 12, 24…).
   */
  growthAnchor?: "ownCycle" | "calendar";
  /**
   * Absolute month (from sim start) the growth clock started; may be negative for backdated
   * streams. Defaults to startMonth. Ignored for "calendar", which anchors to month 0.
   */
  anchorMonth?: number;
  /** Inclusive end month; getMonthlyCents returns 0 for month > endMonth. */
  endMonth?: number;
  /** Tax-routing provenance for this stream; defaults to `ordinaryIncome` downstream. */
  taxCategory?: TaxCategory;
}

interface Segment {
  startMonth: number;
  /** Annual cents when baselineUnit="annual", monthly cents when "monthly". */
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
 * Exposed so growth-bearing stocks that aren't cash-flow series (a property's appreciating
 * value) compound at the same rate.
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

export function preciseMonthlyRate(annualRate: number): number {
  return Math.pow(1 + annualRate, 1 / 12) - 1;
}

export function dollarsToCents(amount: number): number {
  return Math.round(amount * 100);
}

export function centsToDollars(cents: number): number {
  return cents / 100;
}

export class SimCashFlowSeries {
  private segments: Segment[];
  private singleMonthOverrides: Map<number, number> = new Map();
  private readonly baselineUnit: "annual" | "monthly";
  private readonly growthAnchorMode: "ownCycle" | "calendar";
  /**
   * The first month this series can pay; getMonthlyCents returns 0 before it, and consumers read
   * it to decide whether the series is live at all. Normally the construction-time start, but
   * {@link clipPaymentsBefore} moves it later without disturbing the salary path behind it — so
   * a partner's job is correctly absent from the household until they join, while still carrying
   * the raises it collected before then.
   */
  get startMonth(): number {
    return this.paysFromMonth != null
      ? Math.max(this.pathStartMonth, this.paysFromMonth)
      : this.pathStartMonth;
  }
  /** Where the salary PATH begins — the job's own start, membership notwithstanding. */
  private readonly pathStartMonth: number;
  readonly endMonth: number | undefined;
  readonly taxCategory: TaxCategory | undefined;
  /** See {@link clipPaymentsBefore}. */
  private paysFromMonth: number | undefined;

  /** Per-segment cache: yearsElapsed → compounded baseCents at that year. */
  private yearlyBaseCache: Map<Segment, Map<number, number>> = new Map();
  private monthlyCache: Map<number, number> = new Map();

  constructor(
    startMonth: number,
    initialBaseCents: number,
    growthMode: GrowthMode,
    options?: SimCashFlowSeriesOptions,
  ) {
    this.pathStartMonth = startMonth;
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

  /** Edits a prior segment's base in-place; no new segment, boundary stays. */
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

  growthAnnualRateAt(month: number): number {
    return rateFor(this.segmentFor(month).growthMode);
  }

  /**
   * One entry per segment, ascending by `startMonth`. A series edited `fromHereForward` with
   * a new growth mode carries more than one, so month 0's rate alone would hide later changes.
   */
  growthSchedule(): readonly GrowthSegmentView[] {
    return this.segments.map((s) => ({
      startMonth: s.startMonth,
      annualRate: rateFor(s.growthMode),
      mode: s.growthMode.type,
    }));
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

  /**
   * Stop paying before `month`, WITHOUT touching the salary path behind it — the segments, their
   * growth clock and every layered change stay exactly as built.
   *
   * The distinction is the point. A partner's job pays the household only while they are a
   * member, but the job itself ran before that and the raises it collected are part of the
   * salary they bring in. Narrowing the series' own `startMonth` instead would drop those raises
   * on the floor, because a change dated before the start has no segment to open.
   *
   * Call it AFTER layering changes and overrides: the `changeBy` and `addBonus` forms read the
   * month's standing pay to add to, and those reads must see the real path rather than a
   * clipped zero.
   */
  clipPaymentsBefore(month: number): void {
    this.paysFromMonth = month;
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
