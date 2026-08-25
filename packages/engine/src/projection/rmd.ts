import type { Cents } from "../money/money";
import type { SimAccount } from "../plan/simAccount";
import type { Jurisdiction } from "../jurisdiction/jurisdiction";
import type { IncomeSourceMonth } from "./waterfall";
import { isPersonActiveAt, type SimPerson } from "./simulate.types";
import type { DecumulationDrawResult } from "./withdrawal";

/**
 * A structural view rather than the mutable `SimState`, so that object stays private to the
 * simulator while this module stays independently testable (as `EarningsState` does).
 */
export interface RmdState {
  /** Every asset account; filtered here to forced-distribution-eligible holdings. */
  readonly accounts: readonly SimAccount[];
  /** Authoritative mutable balances; a forced withdrawal reduces pre-tax entries in place. */
  readonly assetBalances: Map<string, Cents>;
  /** Read for the holder's birth year (age, start age). */
  readonly personsById: ReadonlyMap<string, SimPerson>;
  /**
   * Each eligible person's annual requirement, keyed `${personId}|${year}` — set once, at the
   * year's first processed month, and read (never recomputed) by December's true-up. Priced off
   * the balance the year OPENS with, so a mid-year withdrawal that shrinks the balance cannot
   * shrink what the year already owes.
   */
  readonly rmdRequiredByPersonYear: Map<string, Cents>;
  /**
   * Each person's qualifying distributions taken so far this year, keyed the same way —
   * accumulated by {@link recordQualifyingDistributions} as ordinary decumulation draws pre-tax
   * accounts down, and consumed (never reset mid-year) by December's true-up.
   */
  readonly rmdSatisfiedByPersonYear: Map<string, Cents>;
}

function yearKeyOf(personId: string, year: number): string {
  return `${personId}|${year}`;
}

/** The year's first processed month — where this year's requirement gets established. */
function isAnnualEstablishMonth(month: number): boolean {
  return month % 12 === 0;
}

/** The year's last processed month — December, where the annual requirement is trued up. */
function isAnnualTrueUpMonth(month: number): boolean {
  return month % 12 === 11;
}

function forcedDistributionEligibleAccountsOf(
  state: RmdState,
  ownerId: string,
): readonly SimAccount[] {
  return state.accounts.filter(
    (a) => a.ownerId === ownerId && a.taxProfile.forcedDistributionEligible,
  );
}

function balanceOf(state: RmdState, accounts: readonly SimAccount[]): Cents {
  let total = 0;
  for (const a of accounts) total += state.assetBalances.get(a.id) ?? 0;
  return total;
}

/**
 * Establishes each eligible person's Required Minimum Distribution for the year about to run —
 * one seam call per person with a pre-tax balance who has reached the jurisdiction's start age,
 * priced off their aggregate pre-tax balance AS IT STANDS NOW, before anything this year has
 * touched it. Nothing is withdrawn here: this only fixes the number December's true-up
 * ({@link buildRmdSources}) works toward, exactly the way the IRS's own divisor divides a
 * PRIOR year-end balance regardless of what the year does to the account afterward.
 *
 * Eligibility (age, and — see {@link buildRmdSources}'s doc — being alive) is decided HERE and
 * only here: once a requirement is on the books for a person-year, December trues it up
 * regardless of what happens to that person before December, the same "the year's requirement
 * was already theirs, and it stands" rule the old single-pass version encoded.
 */
export function establishRmdRequirements(
  state: RmdState,
  jurisdiction: Jurisdiction,
  month: number,
  startYear: number,
): void {
  const rmdSeam = jurisdiction.requiredMinimumDistributionCents;
  if (rmdSeam === undefined || !isAnnualEstablishMonth(month)) return;

  const year = startYear + Math.floor(month / 12);
  for (const person of state.personsById.values()) {
    if (person.birthYear === undefined || !isPersonActiveAt(person, month)) continue;

    const preTaxBalance = balanceOf(state, forcedDistributionEligibleAccountsOf(state, person.id));
    if (preTaxBalance <= 0) continue;

    const required = Math.min(
      preTaxBalance,
      rmdSeam(preTaxBalance, { year, age: year - person.birthYear, birthYear: person.birthYear }),
    );
    if (required <= 0) continue;

    state.rmdRequiredByPersonYear.set(yearKeyOf(person.id, year), required);
  }
}

/**
 * Folds this month's ordinary decumulation draws into each owner's year-to-date qualifying
 * total — every dollar a normal withdrawal pulls from a forced-distribution-eligible account
 * counts toward THEIR annual requirement, whether it lands in January or the same December
 * {@link buildRmdSources} trues up against. Takes `DecumulationDrawResult`s directly (rather
 * than re-deriving from reported income sources) so a forced-distribution-eligible account is
 * identified the same way {@link establishRmdRequirements} aggregates it — by the account's own
 * `taxProfile`, not by a label on the draw.
 */
export function recordQualifyingDistributions(
  state: RmdState,
  decumulationDraws: readonly DecumulationDrawResult[],
  month: number,
  startYear: number,
): void {
  if (decumulationDraws.length === 0) return;
  const year = startYear + Math.floor(month / 12);

  for (const draw of decumulationDraws) {
    if (draw.grossWithdrawnCents <= 0) continue;
    const account = state.accounts.find((a) => a.id === draw.sourceId);
    if (account === undefined || !account.taxProfile.forcedDistributionEligible) continue;

    const key = yearKeyOf(account.ownerId, year);
    state.rmdSatisfiedByPersonYear.set(
      key,
      (state.rmdSatisfiedByPersonYear.get(key) ?? 0) + draw.grossWithdrawnCents,
    );
  }
}

/**
 * December's true-up — the ONLY month a Required Minimum Distribution is actually forced.
 * `remaining = established requirement − qualifying distributions YTD` (this same month's own
 * ordinary decumulation included, since {@link recordQualifyingDistributions} runs before this
 * is called); positive, that remainder is forced out of pre-tax accounts sequentially, same
 * aggregation as {@link establishRmdRequirements} priced it off. Zero or negative — spending
 * already pulled at least the requirement out of pre-tax this year — forces nothing, and
 * nothing carries the excess into a future year: `rmdSatisfiedByPersonYear` is read, never
 * written, here.
 *
 * Re-enters as `ordinaryIncome` with no planDescriptor, same as the old single-pass version:
 * the waterfall is the single tax chokepoint, so the gross is taxed once there, and whatever
 * this month's obligations don't need lands in the surplus (taxable) destination — the forced
 * excess a household never asked for, banked rather than re-spent or re-sold for.
 *
 * No re-check of eligibility here: {@link establishRmdRequirements} already decided who owes
 * this year, and forces it whether or not they are still active by December — a distribution
 * already owed does not un-owe itself because the holder died after owing it. The account
 * itself is untouched by any death gate — it stays household wealth to the end — this only
 * stops a distribution from being forced on someone who never owed one to begin with.
 */
export function buildRmdSources(
  state: RmdState,
  jurisdiction: Jurisdiction,
  month: number,
  startYear: number,
): IncomeSourceMonth[] {
  if (jurisdiction.requiredMinimumDistributionCents === undefined || !isAnnualTrueUpMonth(month)) {
    return [];
  }

  const year = startYear + Math.floor(month / 12);
  const sources: IncomeSourceMonth[] = [];

  for (const personId of state.personsById.keys()) {
    const key = yearKeyOf(personId, year);
    const required = state.rmdRequiredByPersonYear.get(key);
    if (required === undefined) continue;

    const satisfied = state.rmdSatisfiedByPersonYear.get(key) ?? 0;
    const preTaxAccounts = forcedDistributionEligibleAccountsOf(state, personId);
    const remaining = Math.min(
      Math.max(0, required - satisfied),
      balanceOf(state, preTaxAccounts),
    );
    if (remaining <= 0) continue;

    let toDraw = remaining;
    for (const a of preTaxAccounts) {
      if (toDraw <= 0) break;
      const bal = state.assetBalances.get(a.id) ?? 0;
      const take = Math.min(bal, toDraw);
      state.assetBalances.set(a.id, bal - take);
      toDraw -= take;
    }

    sources.push({
      ownerId: personId,
      waterfallInflowCents: remaining,
      taxCategory: "ordinaryIncome",
      // Own id, so a forced distribution reads apart from an elective pre-tax draw even
      // though both are `ordinaryIncome`.
      sourceId: `rmd:${personId}`,
      label: "Required distribution",
      // Forced, but still the household's own money leaving its own account.
      fromAccountWithdrawal: true,
    });
  }

  return sources;
}
