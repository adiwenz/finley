/**
 * The PROVISIONAL federal income-tax schedule for a tax year: what the year owes on the taxable
 * income readable straight off compiled plan data — wages, pensions, the taxable slice of a
 * government benefit, this year's RMD — priced once, without running anything.
 *
 * It is not the year's estimate. The estimate comes from simulating the year on a discarded clone
 * ({@link import("./simulate").simulateHousehold}'s `priceTaxYear`), which sees the whole of what
 * this cannot: decumulation to cover ordinary living, an event that drains the brokerage in March,
 * contributions and basis, a loan that matures in June, an account that runs dry. Anticipating any
 * of that HERE is what turned this module into a parallel mini-simulator, and every layer it grew
 * was a re-derivation of something the simulator already computes exactly.
 *
 * What survives is the one thing the forecast pass cannot bootstrap for itself: it has to charge
 * some tax each month, and charging nothing would make it under-draw by the whole year's liability
 * and so under-report the very income those draws realize. Scheduled income is the cheap,
 * non-circular starting point — exact for a working household, and a first-order correction for a
 * retired one that the forecast pass then finishes.
 *
 * No fixed point here either. Tax and funding are circular, and that circularity is now resolved
 * where it actually lives: the forecast pass draws under this schedule, December closes on ACTUAL
 * income ({@link import("./taxYearSettlement").finalizeTaxYear}), and the following April settles
 * the difference through the ordinary waterfall.
 */

import type { Cents } from "../money/money";
import type { Jurisdiction, JurisdictionContext } from "../jurisdiction/jurisdiction";
import type { SimState } from "./runState";
import type { SimOwnedSeries } from "./simulate.types";
import { isPersonActiveAt } from "./simulate.types";
import type { IncomeSourceMonth } from "./waterfall";
import { deferralForSourceCents, taxableAfterDeferralCents } from "./waterfall";
import { addCategory, type SourceTaxable, type TaxableByCategory } from "./taxAttribution";
import { buildIncomeSources } from "./allocationStep";
import { buildGovernmentBenefitSources, type EarningsState } from "./governmentBenefit";
import { annualFederalTax, MONTHS_IN_TAX_YEAR, type EstimatedTaxYear } from "./federalIncomeTax";

export interface TaxYearProjectionInput {
  readonly state: SimState;
  readonly jurisdiction: Jurisdiction;
  readonly ctx: JurisdictionContext;
  /** The tax year's FIRST processed month. */
  readonly month: number;
  readonly startYear: number;
  readonly incomeSeries: readonly SimOwnedSeries[];
  readonly benefitColaRate: number;
  /**
   * This month's already-built non-withdrawal sources — reality, not a re-derivation. The year's
   * RMD is issued once, in this very month, so it arrives here rather than being predicted.
   */
  readonly openingMonthSources: readonly IncomeSourceMonth[];
  /** Each person's remaining annual deferral room as the year opens. */
  readonly remainingDeferralRoomCents: (personId: string) => number;
}

/** A person's taxable base and the per-source weights each instalment is apportioned across. */
interface PersonYearBase {
  readonly byCategory: TaxableByCategory;
  readonly weights: Map<string, SourceTaxable>;
}

/** Fold one taxable amount into a person's base, under a source key the tax chart bands on. */
function addTaxable(
  bases: Map<string, PersonYearBase>,
  personId: string,
  key: string,
  category: SourceTaxable["category"],
  taxableCents: Cents,
): void {
  if (taxableCents <= 0) return;
  let base = bases.get(personId);
  if (base === undefined) {
    base = { byCategory: {}, weights: new Map() };
    bases.set(personId, base);
  }
  addCategory(base.byCategory, category, taxableCents);
  const existing = base.weights.get(key);
  base.weights.set(
    key,
    existing === undefined
      ? { key, category, taxableCents }
      : { ...existing, taxableCents: existing.taxableCents + taxableCents },
  );
}

export function projectKnownTaxYear(
  input: TaxYearProjectionInput,
): Map<string, EstimatedTaxYear> {
  const { state, jurisdiction, ctx, month, startYear, incomeSeries, benefitColaRate } = input;

  // Pricing a FUTURE month's benefit must not advance the real run's caches: the base is
  // priced once at claim and re-priced when a completed year adds covered earnings, and a
  // projection that wrote those markers would silently skip the real re-pricing later.
  const benefitState: EarningsState = {
    earningsByPerson: state.earningsByPerson,
    personsById: state.personsById,
    governmentBenefitBaseByPerson: new Map(state.governmentBenefitBaseByPerson),
    lastComputedThroughYear: new Map(state.lastComputedThroughYear),
  };

  const roomRemaining = new Map<string, number>();
  for (const pid of state.personIds) {
    roomRemaining.set(pid, input.remainingDeferralRoomCents(pid));
  }

  const bases = new Map<string, PersonYearBase>();
  const fold = (sources: readonly IncomeSourceMonth[]): void => {
    for (const src of sources) {
      const room = roomRemaining.get(src.ownerId) ?? Infinity;
      const deferred = deferralForSourceCents(src, room);
      if (deferred > 0) roomRemaining.set(src.ownerId, room - deferred);
      addTaxable(
        bases,
        src.ownerId,
        src.sourceId ?? src.taxCategory,
        src.taxCategory,
        taxableAfterDeferralCents(src, deferred),
      );
    }
  };

  fold(input.openingMonthSources);
  // The remaining eleven months, from the compiled series alone. The same active-window gate
  // the simulator applies each month: a series stops paying this household when its owner
  // leaves it or dies, and a schedule that ignored that would over-withhold all year.
  for (let m = month + 1; m < month + MONTHS_IN_TAX_YEAR; m++) {
    const active = incomeSeries.filter((s) => {
      const owner = state.personsById.get(s.ownerId);
      return owner === undefined || isPersonActiveAt(owner, m);
    });
    fold([
      ...buildIncomeSources(active, m),
      ...buildGovernmentBenefitSources(benefitState, jurisdiction, m, startYear, benefitColaRate),
    ]);
  }

  const estimates = new Map<string, EstimatedTaxYear>();
  for (const pid of state.personIds) {
    const base = bases.get(pid);
    const { totalCents, byCategoryCents } = annualFederalTax(
      jurisdiction,
      ctx,
      pid,
      base?.byCategory ?? {},
    );
    if (totalCents <= 0) continue;
    estimates.set(pid, {
      totalCents,
      byCategoryCents,
      sourceWeights: [...(base?.weights.values() ?? [])],
    });
  }
  return estimates;
}
