/**
 * Per-person account ownership + household net worth. An account carries
 * `owners: PersonId[]` — `[p]` individual, `[p1, p2]` joint. The pins:
 *   - retirement accounts refuse more than one owner (`makeAccount`);
 *   - `personalAccounts` / `jointAccounts` / `accounts` partition a person's holdings
 *     (personal ∪ joint = accounts, personal ∩ joint = ∅);
 *   - household net worth sums the canonical list ONCE, so a joint account is never
 *     double-counted.
 */
import { describe, it, expect } from "vitest";
import {
  makeAccount,
  personalAccounts,
  jointAccounts,
  accountsOf,
  householdNetWorthCents,
  isJoint,
  isIndividual,
  type Account,
} from "./account";
import type { Household } from "./ledger/household";
import type { Person } from "./person";
import type { PersonId } from "./job";

/**
 * A unified {@link Household} carrying only the account-ownership slice under test; every
 * ledger-derived collection is empty so the ownership helpers are exercised in isolation.
 * The roster rides on `memberships` — the single household aggregate has no separate person
 * list to drift from it.
 */
function householdWith(
  accounts: readonly Account[],
  persons: readonly Person[] = [],
): Household {
  return {
    memberships: persons.map((person) => ({ person, startMonth: 0, endMonth: null })),
    children: [],
    series: [],
    liabilities: [],
    properties: [],
    accountTransfers: [],
    fundingDraws: [],
    accounts,
  };
}

const p1 = "p1" as PersonId;
const p2 = "p2" as PersonId;

const soloTaxable = makeAccount({
  id: "acct-brokerage",
  owners: [p1],
  balanceCents: 100_00,
  retirement: false,
});

const jointTaxable = makeAccount({
  id: "acct-joint",
  owners: [p1, p2],
  balanceCents: 400_00,
  retirement: false,
});

const p1Ira = makeAccount({
  id: "acct-ira-p1",
  owners: [p1],
  balanceCents: 250_00,
  retirement: true,
});

const p2Ira = makeAccount({
  id: "acct-ira-p2",
  owners: [p2],
  balanceCents: 150_00,
  retirement: true,
});

const household: Household = householdWith([soloTaxable, jointTaxable, p1Ira, p2Ira]);

describe("standing account ownership", () => {
  it("refuses a retirement account with more than one owner", () => {
    expect(() =>
      makeAccount({
        id: "bad-joint-ira",
        owners: [p1, p2],
        balanceCents: 0,
        retirement: true,
      }),
    ).toThrow(/retirement/i);
  });

  it("refuses an account with no owners", () => {
    expect(() =>
      makeAccount({ id: "ownerless", owners: [], balanceCents: 0, retirement: false }),
    ).toThrow(/owner/i);
  });

  it("allows a single-owner retirement account and a joint non-retirement account", () => {
    expect(p1Ira.owners).toEqual([p1]);
    expect(isJoint(jointTaxable)).toBe(true);
    expect(isIndividual(jointTaxable)).toBe(false);
    expect(isIndividual(soloTaxable)).toBe(true);
  });

  it("partitions a person's accounts into personal vs joint", () => {
    expect(personalAccounts(household, p1)).toEqual([soloTaxable, p1Ira]);
    expect(jointAccounts(household, p1)).toEqual([jointTaxable]);
    // personal ∪ joint == accounts, with no overlap.
    expect(accountsOf(household, p1)).toEqual([soloTaxable, jointTaxable, p1Ira]);
  });

  it("gives each joint owner the account, but only once each", () => {
    expect(accountsOf(household, p2)).toEqual([jointTaxable, p2Ira]);
    expect(personalAccounts(household, p2)).toEqual([p2Ira]);
    expect(jointAccounts(household, p2)).toEqual([jointTaxable]);
  });

  it("sums household net worth once — joint accounts are NOT double-counted", () => {
    // 100 + 400 + 250 + 150 = 900. Counting the joint 400 per-owner inflates it to 1300.
    expect(householdNetWorthCents(household)).toBe(900_00);

    const perPersonSum = [p1, p2].reduce(
      (sum, person) => sum + accountsOf(household, person).reduce((s, a) => s + a.balanceCents, 0),
      0,
    );
    expect(perPersonSum).toBe(1300_00);
    expect(householdNetWorthCents(household)).toBeLessThan(perPersonSum);
  });
});

describe("accounts on the unified household aggregate", () => {
  const alice: Person = {
    id: p1,
    name: "Alice",
    birthYear: 1990,
    retirementTargetAge: 65,
    benefitClaimingAge: 67,
    jobs: [],
  };

  it("resolves ownership against a person the household rosters via memberships", () => {
    // The ownership helpers read the same household object the ledger produces — no separate
    // account-ownership aggregate to keep in sync with the roster.
    const unified = householdWith([soloTaxable, jointTaxable, p1Ira], [alice]);
    expect(accountsOf(unified, alice)).toEqual([soloTaxable, jointTaxable, p1Ira]);
    expect(personalAccounts(unified, alice)).toEqual([soloTaxable, p1Ira]);
    expect(householdNetWorthCents(unified)).toBe(750_00);
  });
});
