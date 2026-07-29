/**
 * The authoring account model: the user-facing `Account`, distinct from the simulator's {@link
 * import("./simAccount").SimAccount} (a compiled shape with a single `ownerId`, rate segments
 * and one-time transfers). Same seam that keeps the authoring `Person` out of the sim's
 * `SimPerson` (see `person.ts`).
 *
 * There is ONE canonical `household.accounts` list — a joint account lives in it exactly
 * once — which is what makes net worth a clean household aggregate with no double-counting.
 */

import type { Cents } from "./money";
import type { PersonId } from "./job";
import type { Person } from "./person";
import type { Household } from "./ledger/household";

/** `balanceCents` is the authored current balance (today's dollars); the trajectory is the simulator's job. */
export interface Account {
  readonly id: string;
  /** `[p]` = individual, `[p1, p2]` = joint. Retirement ⇒ exactly one owner. */
  readonly owners: readonly PersonId[];
  readonly balanceCents: Cents;
  readonly retirement: boolean;
}

type PersonRef = PersonId | Person;

function idOf(ref: PersonRef): PersonId {
  return typeof ref === "string" ? ref : ref.id;
}

/**
 * At least one owner, and exactly one for a retirement account (deferral limits and RMDs are
 * legally per-person). Refused where the account is authored, so the rest of the engine need
 * not defend against an illegal shape.
 */
export function assertAccountOwnership(account: Account): Account {
  if (account.owners.length === 0) {
    throw new Error(`Account "${account.id}" has no owners; an account needs at least one.`);
  }
  if (account.retirement && account.owners.length !== 1) {
    throw new Error(
      `Retirement account "${account.id}" has ${account.owners.length} owners; a retirement account is legally per-person and must have exactly one.`,
    );
  }
  return account;
}

export function makeAccount(params: {
  id: string;
  owners: readonly PersonId[];
  balanceCents: Cents;
  retirement: boolean;
}): Account {
  return assertAccountOwnership({
    id: params.id,
    owners: params.owners,
    balanceCents: params.balanceCents,
    retirement: params.retirement,
  });
}

export function isJoint(account: Account): boolean {
  return account.owners.length > 1;
}

export function isIndividual(account: Account): boolean {
  return account.owners.length === 1;
}

/** Personal + joint partition {@link accountsOf} with no overlap. */
export function personalAccounts(
  household: Household,
  person: PersonRef,
): Account[] {
  const id = idOf(person);
  return household.accounts.filter((a) => isIndividual(a) && a.owners[0] === id);
}

export function jointAccounts(household: Household, person: PersonRef): Account[] {
  const id = idOf(person);
  return household.accounts.filter((a) => isJoint(a) && a.owners.includes(id));
}

/** {@link personalAccounts} ∪ {@link jointAccounts}. */
export function accountsOf(household: Household, person: PersonRef): Account[] {
  const id = idOf(person);
  return household.accounts.filter((a) => a.owners.includes(id));
}

/** The canonical list summed once; a per-person sum would double-count joint accounts. */
export function householdNetWorthCents(household: Household): Cents {
  return household.accounts.reduce((sum, account) => sum + account.balanceCents, 0);
}
