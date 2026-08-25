/**
 * Ledger transfers — immutable value descriptors for one-time money movements. A payoff
 * produces a matched pair: a {@link LiabilityTransfer} reducing the owed balance and an
 * {@link AccountTransfer} for the funding outflow. They sit between the mutable interpret
 * accumulator ({@link InterpretState}) and the immutable {@link Household} it converts to,
 * so both depend on this module rather than on each other.
 */

import type { Cents } from "../money/money";
import type { AccountId } from "../plan/ids";

/** A one-time principal adjustment against a liability (paydown), with its funding account. */
export interface LiabilityTransfer {
  readonly month: number;
  /** Negative = reduces the owed balance. */
  readonly amountCents: Cents;
  readonly accountId: AccountId;
}

/**
 * A one-time adjustment applied to an asset account — the funding half of a payoff, a
 * partner's account landing at their join month, or a departing partner's account draining to
 * zero at separation.
 */
export interface AccountTransfer {
  readonly accountId: AccountId;
  readonly month: number;
  /** Negative = outflow. */
  readonly amountCents: Cents;
  /**
   * Takes this share of the balance in addition to `amountCents` (e.g. `-1` drains it
   * entirely) — see {@link import("../plan/simAccount").SimOneTimeTransfer}. Absent = 0.
   */
  readonly proportionalFraction?: number;
}
