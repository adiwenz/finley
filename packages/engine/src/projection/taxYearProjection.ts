/**
 * Projects the annual taxable income knowable from compiled plan data without running the
 * stateful funding waterfall, sizing the year's estimated federal income-tax instalments.
 * Waterfall-dependent taxable income is discovered during simulation and reconciled at year end
 * against {@link import("./runState").SimState.taxableIncomeByPersonYear}, the authoritative base.
 */

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

/**
 * The year's estimated federal income-tax liability per person. Call ONCE, at the tax year's
 * first processed month; the result is held for the rest of the year, so every instalment comes
 * from the same estimate and no already-simulated month is ever revised.
 */
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

  const taxableByPerson = new Map<string, TaxableByCategory>();
  const weightsByPerson = new Map<string, Map<string, SourceTaxable>>();

  const fold = (sources: readonly IncomeSourceMonth[]): void => {
    for (const src of sources) {
      const room = roomRemaining.get(src.ownerId) ?? Infinity;
      const deferred = deferralForSourceCents(src, room);
      if (deferred > 0) roomRemaining.set(src.ownerId, room - deferred);
      const taxableCents = taxableAfterDeferralCents(src, deferred);
      if (taxableCents <= 0) continue;

      let byCategory = taxableByPerson.get(src.ownerId);
      if (byCategory === undefined) {
        byCategory = {};
        taxableByPerson.set(src.ownerId, byCategory);
      }
      addCategory(byCategory, src.taxCategory, taxableCents);

      let weights = weightsByPerson.get(src.ownerId);
      if (weights === undefined) {
        weights = new Map();
        weightsByPerson.set(src.ownerId, weights);
      }
      const key = src.sourceId ?? src.taxCategory;
      const existing = weights.get(key);
      weights.set(
        key,
        existing === undefined
          ? { key, category: src.taxCategory, taxableCents }
          : { ...existing, taxableCents: existing.taxableCents + taxableCents },
      );
    }
  };

  fold(input.openingMonthSources);
  // The remaining eleven months, from the compiled series alone. The same active-window gate
  // the simulator applies each month: a series stops paying this household when its owner
  // leaves it or dies, and an estimate that ignored that would over-withhold all year.
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
    const byCategory = taxableByPerson.get(pid) ?? {};
    const { totalCents, byCategoryCents } = annualFederalTax(jurisdiction, ctx, pid, byCategory);
    if (totalCents <= 0) continue;
    estimates.set(pid, {
      totalCents,
      byCategoryCents,
      sourceWeights: [...(weightsByPerson.get(pid)?.values() ?? [])],
    });
  }
  return estimates;
}
