/**
 * The interpreted household's accounts ARE the simulation's accounts. These are the
 * regressions for the disconnect the unified aggregate was introduced with: `Household`
 * once carried an always-empty `accounts`, so every ownership helper and net worth answered
 * against a collection the simulator never saw.
 */

import { describe, it, expect } from "vitest";
import { interpretLedger } from "./interpret";
import { emptyLedger } from "./ledger";
import type { LedgerBaseConfig } from "./ledgerBase";
import { buildHouseholdSimInput } from "../projection/buildHouseholdInput";
import { planAccount } from "../planAccount";
import {
  accountsOf,
  personalAccounts,
  jointAccounts,
  householdNetWorthCents,
} from "../account";
import { CAPITAL_GAINS_TAX_PROFILE, PRE_TAX_TAX_PROFILE } from "../simAccount";
import type { Person } from "../person";
import type { PersonId } from "../job";

const p1 = "p1" as PersonId;
const p2 = "p2" as PersonId;

const alice: Person = {
  id: p1,
  name: "Alice",
  birthYear: 1990,
  retirementTargetAge: 65,
  benefitClaimingAge: 67,
  jobs: [],
};

const savings = planAccount({
  id: "savings",
  owners: [p1],
  label: "Cash savings",
  liquid: true,
  taxProfile: CAPITAL_GAINS_TAX_PROFILE,
  balanceCents: 250_00,
  initialAnnualRate: 0,
});

const retirement = planAccount({
  id: "retirement",
  owners: [p1],
  label: "Retirement",
  liquid: false,
  taxProfile: PRE_TAX_TAX_PROFILE,
  balanceCents: 500_00,
  initialAnnualRate: 0,
});

const base: LedgerBaseConfig = {
  horizonMonths: 12,
  annualInflationRate: 0,
  initialPersons: [alice],
  initialAccounts: [savings, retirement],
};

describe("interpretLedger — the household's accounts are the simulation's accounts", () => {
  it("rosters the base's accounts on the interpreted household", () => {
    const household = interpretLedger(emptyLedger, base);
    expect(household.accounts).toEqual([savings.account, retirement.account]);
  });

  it("hands the simulator the compiled side of those very same accounts", () => {
    // The two views cannot describe different holdings: same ids, same order, same balances.
    const household = interpretLedger(emptyLedger, base);
    const input = buildHouseholdSimInput(household, base);
    expect(input.accounts.map((a) => a.id)).toEqual(household.accounts.map((a) => a.id));
    expect(input.accounts.map((a) => a.openingBalanceCents)).toEqual(
      household.accounts.map((a) => a.balanceCents),
    );
  });

  it("counts the initial balances in household net worth", () => {
    // Previously 0 for every interpreted household — the bug this file exists for.
    const household = interpretLedger(emptyLedger, base);
    expect(householdNetWorthCents(household)).toBe(750_00);
  });

  it("resolves ownership for a person the household rosters", () => {
    const household = interpretLedger(emptyLedger, base);
    expect(accountsOf(household, alice)).toEqual([savings.account, retirement.account]);
    expect(personalAccounts(household, alice)).toEqual([savings.account, retirement.account]);
    // Joint ownership is not yet authorable, so an empty partition here is the correct
    // answer rather than a gap: every account the plan builds has exactly one owner.
    expect(jointAccounts(household, alice)).toEqual([]);
    expect(household.accounts.every((a) => a.owners.length === 1)).toBe(true);
  });

  it("answers nothing for a person the household does not roster", () => {
    const household = interpretLedger(emptyLedger, base);
    expect(accountsOf(household, p2)).toEqual([]);
    expect(personalAccounts(household, p2)).toEqual([]);
  });

  it("refuses a base whose account is owned by someone off the roster", () => {
    // The failure mode the invariant closes: ownership queries would silently understate
    // rather than surface a mis-built base.
    const orphaned: LedgerBaseConfig = {
      ...base,
      initialAccounts: [
        planAccount({
          id: "stranger-savings",
          owners: [p2],
          liquid: true,
          taxProfile: CAPITAL_GAINS_TAX_PROFILE,
          balanceCents: 100_00,
          initialAnnualRate: 0,
        }),
      ],
    };
    expect(() => interpretLedger(emptyLedger, orphaned)).toThrow(
      /owned by "p2", who is not a member of the household/,
    );
  });
});
