import type { Cents } from "../money";
import type { Account } from "../account";
import type { Jurisdiction } from "../jurisdiction";
import type { IncomeSourceMonth } from "./waterfall";
import type { Person } from "./simulate";

/**
 * The slice of the simulator's state the RMD bookkeeping reads and mutates. A
 * structural view over `SimState` — declaring it here (rather than importing the
 * whole mutable `SimState`) keeps that state object private to the simulator
 * while this module stays independently testable, mirroring `EarningsState`.
 */
export interface RmdState {
  /** Every asset account — filtered here to a person's forced-distribution-eligible holdings. */
  readonly accounts: readonly Account[];
  /** The authoritative mutable balances; RMD withdrawals reduce pre-tax entries in place. */
  readonly assetBalances: Map<string, Cents>;
  /** Every person by id — an RMD needs the holder's birth year to derive age/start age. */
  readonly personsById: ReadonlyMap<string, Person>;
}

/**
 * Whether this month carries the year's single RMD event. Fires once per calendar
 * year, in that year's first PROCESSED month: month 0 is the opening snapshot
 * (never processed), months 1–11 are the start year (so month 1 carries it), and
 * every 12th month opens a new calendar year. This keeps the forced withdrawal
 * annual rather than compounding it twelve times.
 */
function isRmdTriggerMonth(month: number): boolean {
  return month > 0 && (month === 1 || month % 12 === 0);
}

/**
 * This year's Required Minimum Distributions (§5.4) — one income source per person
 * with a pre-tax balance who has reached the jurisdiction's start age. On a trigger
 * month, for each such person the seam is asked for the required amount from their
 * aggregate pre-tax balance; that amount is forced out of their pre-tax accounts
 * (sequentially — `required ≤ balance`, so it always fully draws) and re-enters as
 * `ordinaryIncome` with NO planDescriptor. That routing is deliberate: the single
 * tax chokepoint (§5.3) lives inside the waterfall, so the withdrawn gross is taxed
 * there once and its remainder lands in the surplus (taxable) destination; and
 * because it is not earned wages it enters POST-deferral and can never be re-deferred.
 *
 * The withdrawal binds as `max(desired, required)` (§5.4); the base sim has no
 * desired draw, so `required` binds. Absent seam (v1 null jurisdiction) → no RMD.
 * Mutates `assetBalances` as a side effect, as `buildSocialSecuritySources` does.
 */
export function buildRmdSources(
  state: RmdState,
  jurisdiction: Jurisdiction,
  month: number,
  startYear: number,
): IncomeSourceMonth[] {
  const rmdSeam = jurisdiction.requiredMinimumDistributionCents;
  if (rmdSeam === undefined || !isRmdTriggerMonth(month)) return [];

  const year = startYear + Math.floor(month / 12);
  const sources: IncomeSourceMonth[] = [];

  for (const person of state.personsById.values()) {
    if (person.birthYear === undefined) continue;

    const preTaxAccounts = state.accounts.filter(
      (a) => a.ownerId === person.id && a.taxProfile.forcedDistributionEligible,
    );
    let preTaxBalance = 0;
    for (const a of preTaxAccounts) preTaxBalance += state.assetBalances.get(a.id) ?? 0;
    if (preTaxBalance <= 0) continue;

    const required = Math.min(
      preTaxBalance,
      rmdSeam(preTaxBalance, { year, age: year - person.birthYear, birthYear: person.birthYear }),
    );
    if (required <= 0) continue;

    let remaining = required;
    for (const a of preTaxAccounts) {
      if (remaining <= 0) break;
      const bal = state.assetBalances.get(a.id) ?? 0;
      const take = Math.min(bal, remaining);
      state.assetBalances.set(a.id, bal - take);
      remaining -= take;
    }

    sources.push({ ownerId: person.id, grossCents: required, taxCategory: "ordinaryIncome" });
  }

  return sources;
}
