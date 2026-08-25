/**
 * Re-owners a deceased member's cash and taxable-brokerage accounts to the surviving partner, at
 * the death month — in place, on the same {@link SimAccount} object, so the survivor's own
 * person-aware funding pass ({@link import("./withdrawal").buildWithdrawalSources}) and RMD gate
 * ({@link import("./rmd").buildRmdSources}) draw them under the new owner with no change to
 * either. Retirement accounts (`taxProfile.forcedDistributionEligible`) are left alone —
 * inherited-retirement distribution rules and beneficiary taxation are unmodelled; this hands
 * them to that future work rather than re-implementing it.
 */

import type { SimAccount } from "../plan/simAccount";
import type { SurvivingPartnerTransfer } from "../job/personActiveWindow";

export function applyDeathOwnershipTransfers(
  accounts: readonly SimAccount[],
  transfers: readonly SurvivingPartnerTransfer[],
  month: number,
): void {
  for (const transfer of transfers) {
    if (transfer.month !== month) continue;
    for (const account of accounts) {
      if (
        account.ownerId === transfer.deceasedPersonId &&
        !account.taxProfile.forcedDistributionEligible
      ) {
        account.reassignOwner(transfer.survivorPersonId);
      }
    }
  }
}
