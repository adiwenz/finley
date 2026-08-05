/**
 * The single construction site for an account: one spec yields both the authoring
 * {@link Account} the household rosters and the compiled {@link SimAccount} the simulator
 * runs. Neither type is derivable from the other — `Account` carries ownership and the
 * retirement flag, `SimAccount` carries tax profile, liquidity and rate segments — so
 * pairing them here is what keeps `household.accounts` and the simulation's accounts the
 * same canonical collection rather than two lists that can drift.
 *
 * Direction is authoring → compiled, matching `Person` → `SimPerson`. Never recover an
 * `Account` from a `SimAccount`: `SimAccount.ownerId` is single-valued, so joint ownership
 * is unrepresentable in the compiled shape.
 */

import { makeAccount, type Account } from "./account";
import { SimAccount, type SimAccountTaxProfile } from "./simAccount";
import type { Cents } from "../money/money";
import type { PersonId } from "../job/job";

/**
 * One account under both of its aspects. `account.id === sim.id` and
 * `account.balanceCents === sim.openingBalanceCents` by construction — {@link planAccount}
 * is the only way to build one.
 */
export interface PlanAccount {
  readonly account: Account;
  readonly sim: SimAccount;
}

export function planAccount(spec: {
  readonly id: string;
  readonly owners: readonly PersonId[];
  readonly balanceCents: Cents;
  readonly label?: string;
  readonly liquid: boolean;
  readonly taxProfile: SimAccountTaxProfile;
  readonly initialAnnualRate: number;
}): PlanAccount {
  // Forced distributions are what *makes* an account a retirement account in engine terms,
  // so the authoring flag reads off the tax profile rather than being stated twice.
  const account = makeAccount({
    id: spec.id,
    owners: spec.owners,
    balanceCents: spec.balanceCents,
    retirement: spec.taxProfile.forcedDistributionEligible,
  });
  return {
    account,
    // `owners[0]`: every account is single-owner today. When joint ownership lands, the
    // compile step — not this cast — decides how the simulator apportions a joint balance.
    // `assertAccountOwnership` has already guaranteed at least one owner.
    sim: new SimAccount({
      id: spec.id,
      ownerId: account.owners[0],
      label: spec.label,
      liquid: spec.liquid,
      taxProfile: spec.taxProfile,
      openingBalanceCents: spec.balanceCents,
      initialAnnualRate: spec.initialAnnualRate,
    }),
  };
}

/** The authoring view of a base's accounts — what the household rosters. */
export function authoringAccounts(
  planAccounts: readonly PlanAccount[] = [],
): readonly Account[] {
  return planAccounts.map((a) => a.account);
}

/** The compiled view — what the simulator runs. */
export function simAccounts(planAccounts: readonly PlanAccount[] = []): readonly SimAccount[] {
  return planAccounts.map((a) => a.sim);
}
