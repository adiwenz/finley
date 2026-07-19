/**
 * Slice 5 (issue #68): per-person account ownership + household net worth.
 *
 * The standing authoring account carries `owners: PersonId[]` — `[p]` is an
 * individual account, `[p1, p2]` a joint one. The pins here:
 *   - retirement accounts refuse more than one owner (`makeStandingAccount`);
 *   - `personalAccounts` / `jointAccounts` / `accounts` partition a person's
 *     holdings correctly (personal ∪ joint = accounts, personal ∩ joint = ∅);
 *   - household net worth sums the canonical list ONCE, so a joint account owned
 *     by two people is not double-counted (the headline §9 aggregate rule).
 */
import { describe, it, expect } from "vitest";
import {
  makeStandingAccount,
  personalAccounts,
  jointAccounts,
  accountsOf,
  householdNetWorthCents,
  isJoint,
  isIndividual,
  type StandingHousehold,
} from "./standingAccount";
import type { PersonId } from "./job";

const p1 = "p1" as PersonId;
const p2 = "p2" as PersonId;

const soloTaxable = makeStandingAccount({
  id: "acct-brokerage",
  owners: [p1],
  balanceCents: 100_00,
  retirement: false,
});

const jointTaxable = makeStandingAccount({
  id: "acct-joint",
  owners: [p1, p2],
  balanceCents: 400_00,
  retirement: false,
});

const p1Ira = makeStandingAccount({
  id: "acct-ira-p1",
  owners: [p1],
  balanceCents: 250_00,
  retirement: true,
});

const p2Ira = makeStandingAccount({
  id: "acct-ira-p2",
  owners: [p2],
  balanceCents: 150_00,
  retirement: true,
});

const household: StandingHousehold = {
  persons: [],
  accounts: [soloTaxable, jointTaxable, p1Ira, p2Ira],
};

describe("standing account ownership (§10, issue #68)", () => {
  it("refuses a retirement account with more than one owner", () => {
    expect(() =>
      makeStandingAccount({
        id: "bad-joint-ira",
        owners: [p1, p2],
        balanceCents: 0,
        retirement: true,
      }),
    ).toThrow(/retirement/i);
  });

  it("refuses an account with no owners", () => {
    expect(() =>
      makeStandingAccount({ id: "ownerless", owners: [], balanceCents: 0, retirement: false }),
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
    // 100 + 400 + 250 + 150 = 900. If the joint 400 were counted per-owner it
    // would inflate to 1300; the canonical single-list sum is the guard.
    expect(householdNetWorthCents(household)).toBe(900_00);

    const perPersonSum = [p1, p2].reduce(
      (sum, person) => sum + accountsOf(household, person).reduce((s, a) => s + a.balanceCents, 0),
      0,
    );
    expect(perPersonSum).toBe(1300_00);
    expect(householdNetWorthCents(household)).toBeLessThan(perPersonSum);
  });
});
