import type { Cents } from "../money/money";

/**
 * A person's lifetime covered earnings — one nominal wage total per calendar year,
 * accumulated as the projection runs forward and holding NO jurisdiction knowledge. The
 * benefit formula lives entirely in `rules`, which reads this through the
 * {@link Jurisdiction.governmentBenefitBaseMonthlyCents} seam — like tax and RMDs, but
 * history-dependent, hence the threading. So the engine can only test accumulation and the
 * null-jurisdiction path; benefit anchor and monotonicity tests live in `rules`.
 */
export interface EarningsRecord {
  readonly annualWagesCents: ReadonlyMap<number, Cents>;
}

export const EMPTY_EARNINGS_RECORD: EarningsRecord = {
  annualWagesCents: new Map<number, Cents>(),
};

/**
 * The mutable counterpart the simulator threads through its months;
 * {@link toEarningsRecord} freezes a snapshot for `rules` at claiming age.
 */
export type EarningsAccumulator = Map<number, Cents>;

/**
 * The pre-"now" earnings summary is the one historical financial input: a mid-career
 * record cannot be built purely from post-"now" earnings.
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

export function addEarnings(acc: EarningsAccumulator, year: number, cents: Cents): void {
  if (cents <= 0) return;
  acc.set(year, (acc.get(year) ?? 0) + cents);
}

export function toEarningsRecord(acc: EarningsAccumulator): EarningsRecord {
  return { annualWagesCents: new Map(acc) };
}
