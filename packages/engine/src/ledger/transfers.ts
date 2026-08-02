/**
 * Ledger transfers — immutable value descriptors for one-time money movements. A payoff
 * produces a matched pair: a {@link LiabilityTransfer} reducing the owed balance and an
 * {@link AccountTransfer} for the funding outflow. They sit between the mutable interpret
 * accumulator ({@link InterpretState}) and the immutable {@link Household} it converts to,
 * so both depend on this module rather than on each other.
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

/** A one-time outflow applied to an asset account (the funding half of a payoff). */
export interface AccountTransfer {
  readonly accountId: AccountId;
  readonly month: number;
  /** Negative = outflow. */
  readonly amountCents: Cents;
}
