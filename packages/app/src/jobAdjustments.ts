/**
 * One-month adjustments, read the way every surface must read them.
 *
 * A {@link JobIncomeOverride} is not part of a job's salary path: `jobPayPath` compiles standing
 * pay and knows nothing about bonuses, deliberately, because a bonus is a payment and not a
 * salary state. But the month it lands in genuinely pays more (or less), and a surface that
 * draws or lists "what this job pays" while silently dropping it is telling a reader something
 * false about that month.
 *
 * So the arithmetic lives here once, mirroring `applyIncomeOverrides` in the engine — `setTo`
 * replaces the month's pay, `addBonus` adds to it, and neither can drive it below zero. Two
 * surfaces reading it (the pay chart and the pay timeline) must agree with each other and with
 * what the projection actually pays, and one function is how that stays true.
 */

import type { JobIncomeOverride } from "@finley/engine";
import { formatDollars } from "./format";

/**
 * What a job pays in `month` once a one-month adjustment there is applied — `null` when the
 * month has none, which is nearly every month. `basePayCents` is the standing pay from
 * `jobPayPath`, so the caller states which denomination it is reading in and this never
 * silently mixes two.
 */
export function adjustedMonthlyCents(
  override: JobIncomeOverride,
  basePayCents: number,
): number {
  // `Math.max(0, …)` matches the engine: a deduction larger than the paycheck is a missed
  // paycheck, never a negative one.
  return Math.max(0, override.kind === "setTo" ? override.cents : basePayCents + override.cents);
}

/** "Bonus $4,000" / "Pay this month $0" — a one-month adjustment, undated. */
export function describeIncomeOverride(override: JobIncomeOverride): string {
  if (override.kind === "setTo") {
    return override.cents === 0
      ? "Missed paycheck this month"
      : `Pay this month ${formatDollars(override.cents)}`;
  }
  return override.cents < 0
    ? `Deducted ${formatDollars(Math.abs(override.cents))} this month`
    : `Bonus ${formatDollars(override.cents)}`;
}
