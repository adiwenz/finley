import type { Cents } from "../money";
import type { SimAccount } from "../simAccount";
import type { Jurisdiction } from "../jurisdiction";
import type { IncomeSourceMonth } from "./waterfall";
import type { SimPerson } from "./simulate.types";

/**
 * The slice of simulator state RMD bookkeeping reads and mutates. Declaring this
 * structural view rather than importing the mutable `SimState` keeps that object private
 * to the simulator while this module stays independently testable, as `EarningsState` does.
 */
export interface RmdState {
  /** Every asset account — filtered here to forced-distribution-eligible holdings. */
  readonly accounts: readonly SimAccount[];
  /** Authoritative mutable balances; RMD withdrawals reduce pre-tax entries in place. */
  readonly assetBalances: Map<string, Cents>;
  /** Every person by id — an RMD needs the holder's birth year for age/start age. */
  readonly personsById: ReadonlyMap<string, SimPerson>;
}

/**
 * Whether this month carries the year's single RMD event — its first PROCESSED month.
 * Month 0 is the opening snapshot (never processed) and months 1–11 are the start year,
 * so month 1 carries it; every 12th month opens a new calendar year. Keeps the forced
 * withdrawal annual rather than compounding it twelve times.
 */
function isRmdTriggerMonth(month: number): boolean {
  return month > 0 && (month === 1 || month % 12 === 0);
}

/**
 * This year's Required Minimum Distributions — one income source per person with a pre-tax
 * balance who has reached the jurisdiction's start age. On a trigger month the seam prices
 * the requirement off their aggregate pre-tax balance; that amount is forced out of their
 * pre-tax accounts sequentially (`required ≤ balance`, so it always fully draws) and
 * re-enters as `ordinaryIncome` with NO planDescriptor. That routing is deliberate: the
 * single tax chokepoint is inside the waterfall, so the gross is taxed once there and the
 * remainder lands in the surplus (taxable) destination; and since it is not earned wages
 * it enters POST-deferral and can never be re-deferred.
 *
 * The withdrawal binds as `max(desired, required)`; the base sim has no desired draw, so
 * `required` binds. Absent seam (null jurisdiction) → no RMD. Mutates `assetBalances`, as
 * `buildGovernmentBenefitSources` does.
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
      // Its own source, so a forced distribution reads apart from an elective pre-tax
      // draw even though both are `ordinaryIncome`.
      sourceId: `rmd:${person.id}`,
      label: "Required distribution",
    });
  }

  return sources;
}
