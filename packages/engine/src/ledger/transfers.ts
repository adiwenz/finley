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

/**
 * Reporting provenance only: the simulator names the draw's flow bands from it
 * (`REPORT_PREFIX` in {@link import("../projection/fundingDrawStep")}); nothing in the
 * resolution reads it. A new money-out event adds a reason here plus its prefix there and
 * reuses the channel unchanged.
 */
export type FundingReason = "homeDownPayment";

/**
 * An ordered, cross-account outflow resolved at SIMULATION time — the money-out primitive for
 * events funding a fixed amount from a user-ordered source list (Home Purchase today).
 *
 * Unlike an {@link AccountTransfer}, whose per-account amount is fixed at authoring time, a
 * funding draw's split depends on each source's BALANCE at `month`, known only once the
 * projection runs. So the ledger records the intent (drain `amountCents` from `sourceIds`, in
 * order) and the simulator resolves it, taking as much as each source holds before moving to
 * the next — mirroring {@link import("./funding").drainSources}. Each contributing draw
 * reduces its account's balance and returns basis pro-rata.
 */
export interface FundingDraw {
  readonly month: number;
  /** Total to drain across the sources (the down payment). */
  readonly amountCents: Cents;
  /** Eligible funding accounts in drain order; earlier ids empty before later ones. */
  readonly sourceIds: readonly string[];
  readonly reason: FundingReason;
}
