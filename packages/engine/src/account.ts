/**
 * The authoring account model — per-person account *ownership* and the household net-worth
 * aggregate the multi-person panel and account types build on.
 *
 * The external, user-facing `Account`, deliberately distinct from the simulator's {@link
 * import("./simAccount").SimAccount} (a compiled shape with a single `ownerId`, rate
 * segments and one-time transfers). It carries only what the user authors: identity,
 * `owners`, a balance, and whether it is a retirement vehicle. Same seam that keeps the
 * authoring `Person` out of the sim's `SimPerson` (see `person.ts`).
 *
 * Ownership is a set of persons: `owners = [p]` individual, `[p1, p2]` joint. There is ONE
 * canonical `household.accounts` list — a joint account lives in it exactly once — which is
 * what makes net worth a clean household aggregate with no double-counting.
 */

import type { Cents } from "./money";
import type { PersonId } from "./job";
import type { Person } from "./person";

/**
 * A user-authored account. `owners` distinguishes individual (`[p]`) from joint
 * (`[p1, p2]`); `retirement` marks a legally per-person vehicle, hence its single-owner
 * constraint. `balanceCents` is the authored current balance (today's dollars) — the
 * projected trajectory is the simulator's job.
 */
export interface Account {
  readonly id: string;
  /** `[p]` = individual, `[p1, p2]` = joint. Retirement ⇒ exactly one owner. */
  readonly owners: readonly PersonId[];
  readonly balanceCents: Cents;
  /** True for a per-person retirement vehicle — single-owner. */
  readonly retirement: boolean;
}

/**
 * An authoring household: the persons and the single canonical account list. Net worth is a
 * property of *this* aggregate, not of any one person — summing `accounts` once is what
 * avoids double-counting joint holdings.
 */
export interface AccountHousehold {
  readonly persons: readonly Person[];
  readonly accounts: readonly Account[];
}

/** A person id, or the {@link Person} that carries one — accepted by the selectors. */
type PersonRef = PersonId | Person;

function idOf(ref: PersonRef): PersonId {
  return typeof ref === "string" ? ref : ref.id;
}

/**
 * Assert the ownership invariants and return the account unchanged. Refused where the
 * account is authored — an illegal shape is a hard model constraint, not something the rest
 * of the engine should defend against:
 *   - an account has at least one owner;
 *   - a retirement account has *exactly* one (deferral limits and RMDs are legally
 *     per-person, so a joint retirement account is meaningless).
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

/** Author an {@link Account}, enforcing {@link assertAccountOwnership} at creation. */
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

/** A joint account — held by more than one person. */
export function isJoint(account: Account): boolean {
  return account.owners.length > 1;
}

/** An individual account — held by exactly one person. */
export function isIndividual(account: Account): boolean {
  return account.owners.length === 1;
}

/**
 * The person's individually-held accounts: those they own *alone* (`owners === [person]`).
 * Personal + joint partition {@link accountsOf} with no overlap.
 */
export function personalAccounts(
  household: AccountHousehold,
  person: PersonRef,
): Account[] {
  const id = idOf(person);
  return household.accounts.filter((a) => isIndividual(a) && a.owners[0] === id);
}

/** The person's jointly-held accounts: multi-owner accounts including this person. */
export function jointAccounts(household: AccountHousehold, person: PersonRef): Account[] {
  const id = idOf(person);
  return household.accounts.filter((a) => isJoint(a) && a.owners.includes(id));
}

/**
 * Every account this person owns — {@link personalAccounts} ∪ {@link jointAccounts}, each
 * listed once regardless of co-owners.
 */
export function accountsOf(household: AccountHousehold, person: PersonRef): Account[] {
  const id = idOf(person);
  return household.accounts.filter((a) => a.owners.includes(id));
}

/**
 * Household net worth: the canonical account list summed **once**. A joint account lives in
 * `household.accounts` a single time, so this never double-counts it — the aggregate is a
 * property of the household, not the per-person sum (which *would* count joint twice).
 */
export function householdNetWorthCents(household: AccountHousehold): Cents {
  return household.accounts.reduce((sum, account) => sum + account.balanceCents, 0);
}
