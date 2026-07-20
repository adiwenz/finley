import type { Cents } from "./money";

/**
 * A person's lifetime record of Social-Security-covered earnings (§5.4) — one
 * nominal wage total per calendar year. Pure engine-side bookkeeping: the
 * simulator ACCUMULATES it as the projection runs forward (every wage segment
 * contributes) and seeds it with the optional pre-"now" earnings summary (§4.6),
 * but it holds NO jurisdiction knowledge.
 *
 * The full AIME→PIA benefit formula lives entirely in `rules`, which reads this
 * record through the {@link Jurisdiction.governmentBenefitBaseMonthlyCents} seam —
 * the same engine-defines-socket / rules-fills-plug pattern as tax and RMDs, but
 * history-dependent, so the record is threaded through. The engine can only test
 * accumulation and the null-jurisdiction path (which returns 0 while the record
 * still accumulates); the benefit anchor + monotonicity tests live in `rules`.
 */
export interface EarningsRecord {
  /** Nominal SS-covered wage earnings, keyed by calendar year. */
  readonly annualWagesCents: ReadonlyMap<number, Cents>;
}

/** A record with no earnings yet. */
export const EMPTY_EARNINGS_RECORD: EarningsRecord = {
  annualWagesCents: new Map<number, Cents>(),
};

/**
 * The mutable per-year accumulator the simulator threads through its months.
 * Kept separate from the immutable {@link EarningsRecord} the seam consumes:
 * {@link addEarnings} folds a month's covered wages in, {@link toEarningsRecord}
 * freezes a snapshot to hand to `rules` at claiming age.
 */
export type EarningsAccumulator = Map<number, Cents>;

/**
 * Seed a fresh accumulator from an optional pre-"now" earnings summary (§4.6) —
 * the one historical financial input, resolving the §4.6 ↔ §5.4 contradiction
 * (a mid-career record cannot be built purely from post-"now" earnings). A
 * missing/empty seed yields an empty accumulator.
 */
export function seedEarnings(
  priorEarningsCents?: Readonly<Record<number, Cents>>,
): EarningsAccumulator {
  const acc: EarningsAccumulator = new Map<number, Cents>();
  if (priorEarningsCents) {
    for (const [year, cents] of Object.entries(priorEarningsCents)) {
      if (cents > 0) acc.set(Number(year), (acc.get(Number(year)) ?? 0) + cents);
    }
  }
  return acc;
}

/** Fold a month's covered wage earnings into `year`'s running total. No-op for ≤ 0. */
export function addEarnings(acc: EarningsAccumulator, year: number, cents: Cents): void {
  if (cents <= 0) return;
  acc.set(year, (acc.get(year) ?? 0) + cents);
}

/** Freeze the accumulator into the immutable record the `rules` seam consumes. */
export function toEarningsRecord(acc: EarningsAccumulator): EarningsRecord {
  return { annualWagesCents: new Map(acc) };
}
