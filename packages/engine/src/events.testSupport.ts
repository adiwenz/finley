import { addEvent } from "./ledger/addEvent";
import type { Ledger } from "./ledger/ledger";
import type { LedgerBaseConfig } from "./ledger/ledgerBase";
import type { NewLifeEvent } from "./ledger/eventTypes";
import { CAPITAL_GAINS_TAX_PROFILE } from "./simAccount";
import type { Person } from "./person";
import { planAccount, type PlanAccount } from "./planAccount";
import type { PersonId } from "./job";

// Shared builders for the events.* test files, co-located with them, mirroring
// engine/src/testing/. Behaviour-identical to the originals from the top of events.test.ts,
// so the partitioned sibling suites stay byte-for-byte green.

export const personLit = (id: string, name: string): Person => ({
  id,
  name,
  birthYear: 1990,
  retirementTargetAge: 65,
  benefitClaimingAge: 67,
  jobs: [],
});

export function makeLiquidAccount(id = "checking", openingCents = 0): PlanAccount {
  return planAccount({
    id,
    owners: ["p1" as PersonId],
    liquid: true,
    taxProfile: CAPITAL_GAINS_TAX_PROFILE,
    balanceCents: openingCents,
    initialAnnualRate: 0,
  });
}

export const baseConfig: LedgerBaseConfig = {
  horizonMonths: 12,
  annualInflationRate: 0,
  initialPersons: [personLit("p1", "Alice")],
};

// Validation base for fixtures — baseConfig plus a liquid account so DebtPayoff fixtures
// (which need one to draw from) pass. Validates fixture events only; each test still
// replays against its own base.
export const addBase: LedgerBaseConfig = { ...baseConfig, initialAccounts: [makeLiquidAccount()] };

/** Append a fixture event, asserting it passes validation. */
export function add(ledger: Ledger, event: NewLifeEvent): Ledger {
  const result = addEvent(ledger, addBase, event);
  if (!result.ok) throw new Error(`fixture event rejected: ${result.conflict}`);
  return result.ledger;
}
