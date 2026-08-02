/**
 * How a one-month adjustment READS. Only the words — the arithmetic is the engine's.
 *
 * A {@link JobIncomeOverride} is not part of a job's salary path: `jobPayPath` compiles standing
 * pay and knows nothing about bonuses, deliberately, because a bonus is a payment and not a
 * salary state. But the month it lands in genuinely pays more (or less), and a surface that
 * draws or lists "what this job pays" while silently dropping it is telling a reader something
 * false about that month.
 *
 * What that month comes to is `applyJobIncomeOverride` / `applyJobIncomeOverridesAt`, exported
 * from the engine beside the compiler that uses them. This module deliberately holds no copy of
 * that rule: it had one, and a UI that restates the engine's arithmetic is a second definition
 * that drifts the first time either side changes.
 */

import type { JobIncomeOverride } from "@finley/engine";
import { formatDollars } from "./format";

/**
 * "Bonus $4,000" / "Pay this month $0" — a one-month adjustment, undated.
 *
 * Says what KIND of thing it is, not what the month totals: several may share a month, so a row
 * naming only a figure would leave a reader unable to tell two of them apart. The total is the
 * row's own job to state.
 */
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
