/**
 * Ledger transfers — the shared, immutable value descriptors for one-time money
 * movements (§3.2). A payoff produces a matched pair: a {@link LiabilityTransfer}
 * that reduces the owed balance and an {@link AccountTransfer} for the funding
 * outflow. These sit on the boundary between the mutable interpret accumulator
 * ({@link InterpretState}) and the immutable {@link Household} it converts to, so
 * both depend on this module rather than on each other.
 */

import type { Cents } from "../money";
import type { AccountId } from "../ids";

/** A one-time principal adjustment against a liability (paydown), with its funding account. */
export interface LiabilityTransfer {
  readonly month: number;
  /** Negative = reduces the owed balance. */
  readonly amountCents: Cents;
  readonly accountId: AccountId;
}

/** A one-time outflow applied to an asset account (the funding half of a payoff, §3.2). */
export interface AccountTransfer {
  readonly accountId: AccountId;
  readonly month: number;
  /** Negative = outflow. */
  readonly amountCents: Cents;
}
