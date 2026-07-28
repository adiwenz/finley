/**
 * Ledger transfers — the shared, immutable value descriptors for one-time money
 * movements. A payoff produces a matched pair: a {@link LiabilityTransfer}
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

/** A one-time outflow applied to an asset account (the funding half of a payoff). */
export interface AccountTransfer {
  readonly accountId: AccountId;
  readonly month: number;
  /** Negative = outflow. */
  readonly amountCents: Cents;
}

/**
 * Why a {@link FundingDraw} exists — drives its reporting provenance downstream: the
 * simulator names the draw's flow bands from it (`REPORT_PREFIX` in {@link
 * import("../projection/fundingDrawStep")}), and nothing else about the resolution reads it.
 * So a new money-out event (One-Time Spend) adds a reason here plus its prefix there,
 * and reuses the whole channel unchanged.
 */
export type FundingReason = "homeDownPayment";

/**
 * An ordered, cross-account outflow resolved at SIMULATION time — the money-out
 * primitive for events that fund a fixed amount from a user-ordered list of
 * sources (Home Purchase today; the One-Time Spend event next).
 *
 * Unlike an {@link AccountTransfer}, whose per-account amount is fixed the moment
 * it is authored, a funding draw's split across its sources depends on each source's
 * BALANCE at `month` — which is only known once the projection runs. So the ledger
 * records the intent (drain `amountCents` from `sourceIds`, in order) and the
 * simulator resolves it: it takes as much as each source holds before moving to the
 * next, mirroring the shared {@link import("./funding").drainSources} helper. Each
 * contributing draw reduces its account's balance and returns basis pro-rata, and is
 * surfaced in the diagnostic flow view — an investment source's gain as capital-gains
 * income, its returned principal (and any cash source) as a savings drawdown.
 */
export interface FundingDraw {
  readonly month: number;
  /** Total to drain across the sources (the down payment). */
  readonly amountCents: Cents;
  /** Eligible funding accounts in drain order; earlier ids empty before later ones. */
  readonly sourceIds: readonly string[];
  readonly reason: FundingReason;
}
