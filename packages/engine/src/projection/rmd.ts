import type { Cents } from "../money";
import type { SimAccount } from "../simAccount";
import type { Jurisdiction } from "../jurisdiction";
import type { IncomeSourceMonth } from "./waterfall";
import type { SimPerson } from "./simulate.types";

/**
 * A structural view rather than the mutable `SimState`, so that object stays private to the
 * simulator while this module stays independently testable (as `EarningsState` does).
 */
export interface RmdState {
  /** Every asset account; filtered here to forced-distribution-eligible holdings. */
  readonly accounts: readonly SimAccount[];
  /** Authoritative mutable balances; RMD withdrawals reduce pre-tax entries in place. */
  readonly assetBalances: Map<string, Cents>;
  /** Read for the holder's birth year (age, start age). */
  readonly personsById: ReadonlyMap<string, SimPerson>;
}

/**
 * The year's single RMD event lands on its first processed month: month 0 is the opening
 * snapshot and months 1–11 are the start year, so month 1 carries it, and every 12th month
 * opens a new calendar year. Keeps the forced withdrawal annual rather than twelvefold.
 */
function isRmdTriggerMonth(month: number): boolean {
  return month > 0 && (month === 1 || month % 12 === 0);
}

/**
 * This year's Required Minimum Distributions — one income source per person with a pre-tax
 * balance who has reached the jurisdiction's start age. The seam prices the requirement off
 * their aggregate pre-tax balance; that amount is forced out of their pre-tax accounts
 * sequentially (`required ≤ balance`, so it always fully draws) and re-enters as
 * `ordinaryIncome` with no planDescriptor: the waterfall is the single tax chokepoint, so the
 * gross is taxed once there and the remainder lands in the surplus (taxable) destination, and
 * entering post-deferral it can never be re-deferred.
 *
 * The withdrawal binds as `max(desired, required)`; the base sim has no desired draw. No seam →
 * no RMD. Mutates `assetBalances`, as `buildGovernmentBenefitSources` does.
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

    sources.push({
      ownerId: person.id,
      waterfallInflowCents: required,
      taxCategory: "ordinaryIncome",
      // Own id, so a forced distribution reads apart from an elective pre-tax draw even
      // though both are `ordinaryIncome`.
      sourceId: `rmd:${person.id}`,
      label: "Required distribution",
    });
  }

  return sources;
}
