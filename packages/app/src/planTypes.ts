/** Application-level plan types for the value-editing surface (§10.2). */

import type { OverrideScope } from "@finley/engine";

export interface ValueOverride {
  readonly month: number;
  readonly monthlyCents: number;
  readonly scope: OverrideScope;
}

/**
 * The ongoing numbers a user edits directly, with no timeline event. Held as one
 * object so its identity only changes when a value actually changes; that lets
 * `App` memoize the projection base on `[budget]`. React treats it as immutable —
 * replace it, never mutate in place.
 */
export interface BudgetValues {
  readonly name: string;
  readonly incomeCents: number;
  readonly expenseCents: number;
  readonly expenseOverrides: readonly ValueOverride[];
  readonly openingBalanceCents: number;
  readonly annualReturnPct: number;
}
