import type { Cents } from "./money";

/**
 * A person's lifetime covered earnings — one nominal wage total per calendar year. Pure
 * engine-side bookkeeping: the simulator accumulates it as the projection runs forward
 * (every wage segment contributes) from a seed of the optional pre-"now" summary, and
 * holds NO jurisdiction knowledge.
 *
 * The benefit formula lives entirely in `rules`, which reads this through the
 * {@link Jurisdiction.governmentBenefitBaseMonthlyCents} seam — the same
 * engine-defines-socket / rules-fills-plug pattern as tax and RMDs, but
 * history-dependent, hence the threading. The engine can only test accumulation and the
 * null-jurisdiction path (0 while the record still accumulates); benefit anchor and
 * monotonicity tests live in `rules`.
 */
export interface EarningsRecord {
  /** Nominal covered wage earnings, keyed by calendar year. */
  readonly annualWagesCents: ReadonlyMap<number, Cents>;
}

/** A record with no earnings yet. */
export const EMPTY_EARNINGS_RECORD: EarningsRecord = {
  annualWagesCents: new Map<number, Cents>(),
};

/**
 * The mutable per-year accumulator the simulator threads through its months, kept
 * separate from the immutable {@link EarningsRecord} the seam consumes:
 * {@link addEarnings} folds a month's covered wages in, {@link toEarningsRecord} freezes
 * a snapshot for `rules` at claiming age.
 */
export type EarningsAccumulator = Map<number, Cents>;

/**
 * Seed a fresh accumulator from an optional pre-"now" earnings summary — the one
 * historical financial input, since a mid-career record cannot be built purely from
 * post-"now" earnings. A missing or empty seed yields an empty accumulator.
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
