import type { Cents } from "../money";
import type { Jurisdiction, JurisdictionContext } from "../jurisdiction";
import { accumulateEarnings, buildGovernmentBenefitSources } from "./governmentBenefit";
import { buildRmdSources } from "./rmd";
import { buildWithdrawalSources } from "./withdrawal";
import { buildFlows } from "./reportFlows";
import { buildSpendingItems } from "./spendingItems";
import type {
  HouseholdSimInput,
  LiabilityPaymentRecord,
  SimOwnedSeries,
  ProjectionMonth,
  ProjectionMonthFlows,
  ProjectionSeries,
} from "./simulate.types";
import { initSimState } from "./runState";
import { snapshotMonth } from "./monthSnapshot";
import {
  computeLiabilityPayments,
  buildLiabilityPaymentRecords,
  applyShortfallCascade,
  advanceLiabilities,
} from "./liabilitySteps";
import { applyAssetTransfers, compoundAssets, advanceProperties } from "./assetSteps";
import { resolveFundingDraws, buildTaxableByOwner, toTaxableRecord } from "./fundingDrawStep";
import {
  buildIncomeSources,
  buildInterestAccrualSources,
  allocateMonth,
  unwindUnfundedContributions,
} from "./allocationStep";

// Re-exported so existing importers (and the engine barrel in index.ts) keep resolving
// the simulator's public types through ./simulate. `SimPerson` is deliberately OMITTED:
// it is an engine-INTERNAL compiled shape (the app authors the
// standing `Person` and the sim derives `SimPerson` via `compilePerson`), so it must not
// ride the public barrel. Internal engine code imports it directly from ./simulate.types.
export type {
  HouseholdSimInput,
  LiabilityPaymentRecord,
  SimOwnedSeries,
  ProjectionMonth,
  ProjectionMonthFlows,
  ProjectionIncomeSource,
  IncomeSourceCategory,
  ProjectionSeries,
  SimProperty,
} from "./simulate.types";

const DEFAULT_START_YEAR = 2026;

/** Σ of a set of series at `month` — reused for both income (step 1) and expenses (step 3). */
function sumMonthlySeries(series: readonly SimOwnedSeries[], month: number): Cents {
  let total = 0;
  for (const s of series) total += s.series.getMonthlyCents(month);
  return total;
}

/**
 * Household simulator. Fixed pipeline per month, each step a named helper:
 *   3–6. allocation waterfall: per-source pre-tax deferrals, tax seam,
 *        take-home pools, shared/personal goals, surplus — plus the deficit charge
 *        that feeds the cascade                            → allocateMonth
 *     7. shortfall cascade                                 → applyShortfallCascade
 *  8–9. Asset one-time transfers, then compounding        → applyAssetTransfers / compoundAssets
 *   10. Liability transfers, interest, payments           → advanceLiabilities
 *  10b. Property appreciation                             → advanceProperties
 *   11. Snapshot                                          → snapshotMonth
 * Expenses and liability payments are the month's shared obligations; the tax
 * chokepoint lives inside the waterfall and nowhere else.
 * Month 0 is the opening snapshot only — no month is processed before "now".
 */
export function simulateHousehold(
  input: HouseholdSimInput,
  jurisdiction: Jurisdiction,
): ProjectionSeries {
  const startYear = input.startYear ?? DEFAULT_START_YEAR;
  const state = initSimState(input);
  const months: ProjectionMonth[] = [];
  // Insolvency is terminal for net-worth reporting: once any month exhausts
  // all credit, every LATER month reports net worth as null. Tracks whether a prior
  // month already tripped it — the first insolvent month itself still reports its
  // (honest, negative) value; only the months after it are nulled.
  let priorInsolvency = false;

  for (let month = 0; month <= input.horizonMonths; month++) {
    let isInsolvent = false;
    let paymentRecords: Record<string, LiabilityPaymentRecord> = {};
    let flows: ProjectionMonthFlows | undefined;

    if (month > 0) {
      // Calendar year for this month's flows. NOTE (documented simplification):
      // because month 0 is the flow-free opening snapshot above and years bucket by
      // floor(month/12), the FIRST calendar year accrues only 11 flow-months — a
      // $5k/mo salary contributes $55k (not $60k) to year 0's covered-earnings record,
      // and one month of expenses/compounding is likewise absent. The engine tracks
      // integer years only and does not model what month of the year "now" is, so a
      // mid-year start would in reality leave even fewer months; 11 is neither that
      // nor a full 12. Impact is ~0.1% (e.g. the graph's benefit is ~$34/yr below the
      // panel's full-first-year closed form). Modelling a start month-of-year so the
      // first partial year is exact — and the two benefit numbers agree — remains future
      // work; do NOT "fix" it by making month 0 earn (that redefines "now").
      const year = startYear + Math.floor(month / 12);
      const ctx: JurisdictionContext = { year };

      // Fold this month's covered wages into each person's covered-earnings record
      // before assembling income, so a claim landing this month sees them.
      accumulateEarnings(state.earningsByPerson, input.incomeSeries, month, year, jurisdiction);
      // RMDs force this year's required draw out of pre-tax accounts BEFORE
      // the waterfall runs and re-enter it here as taxable ordinary income, so the
      // withdrawal is taxed once at the single chokepoint and lands in the surplus.
      const nonWithdrawalSources = [
        ...buildIncomeSources(input.incomeSeries, month),
        // Last month's credited cash interest, taxed as ordinary income at accrual
        // — a non-withdrawal taxable source, so it shrinks the gap and
        // feeds provisional income exactly like a benefit or RMD would.
        ...buildInterestAccrualSources(state),
        ...buildGovernmentBenefitSources(
          state,
          jurisdiction,
          month,
          startYear,
          // Benefit COLA defaults to general CPI when the plan doesn't decouple it.
          input.benefitColaRate ?? input.annualInflationRate,
        ),
        ...buildRmdSources(state, jurisdiction, month, startYear),
      ];

      const expenseCents = sumMonthlySeries(input.expenseSeries, month);
      const payments = computeLiabilityPayments(state, month);
      const totalPaymentsCents = [...payments.values()].reduce((s, v) => s + v, 0);

      // Decumulation: when non-withdrawal income can't cover the month's
      // obligations, liquidate investment accounts BEFORE the waterfall — same seam
      // as RMD/benefit — so the shortfall is funded by selling assets (taxed once at the
      // chokepoint) instead of landing on the synthetic credit card. RMD income is
      // already counted here, so the desired draw never double-withdraws.
      const withdrawal = buildWithdrawalSources(
        state,
        jurisdiction,
        nonWithdrawalSources,
        expenseCents + totalPaymentsCents,
        ctx,
      );
      const incomeSources = [...nonWithdrawalSources, ...withdrawal.sources];

      // Down-payment / one-time-spend draws resolve BEFORE the tax chokepoint
      // so an appreciated source's realized gain is actually taxed. Each selected source is
      // grossed up over that tax and drained here (before compounding, so a drained balance
      // does not earn this month); its net-neutral tax source rides into `allocateMonth` so
      // the gain is charged exactly once at the single chokepoint, and its gain / returned-
      // principal bands feed the flow view below. A cash source realizes no gain, grosses up
      // by nothing, and conserves net worth exactly as before; an appreciated source's
      // purchase now costs the household the tax, so net worth falls by that tax.
      // The month's taxable base, per owner, from the non-funding income — the marginal
      // context a down-payment gain's tax is differenced over. Exposed on the flow view so
      // the authoring §4.5 gate differences the gain the SAME way (exact under any regime,
      // not a flat-rate estimate); built before the draw so it is the pre-funding base.
      const fundingBase = buildTaxableByOwner(incomeSources);
      const fundingDraw = resolveFundingDraws(state, month, jurisdiction, ctx, fundingBase);
      const allocationSources = [...incomeSources, ...fundingDraw.taxSources];

      const { taxCents, taxByCategoryCents, taxBySourceCents, deferralBySourceCents, contributions } =
        allocateMonth(
          state,
          allocationSources,
          ctx,
          jurisdiction,
          expenseCents + totalPaymentsCents,
          month,
        );
      // Nothing — savings or credit — could absorb this: the terminal flag.
      const uncoveredCents = applyShortfallCascade(state, month);
      isInsolvent = uncoveredCents > 0;
      // A committed contribution deposits in full and borrows the rest; if that borrowing
      // couldn't be funded (this uncovered slice), unwind the phantom deposit so net worth
      // isn't inflated by a contribution the household could not actually make.
      unwindUnfundedContributions(state, contributions, uncoveredCents);

      applyAssetTransfers(state, month);
      compoundAssets(state, month, jurisdiction, ctx);
      advanceLiabilities(state, month, payments);
      advanceProperties(state, month);
      paymentRecords = buildLiabilityPaymentRecords(payments);
      // One itemized view of everything the month cost — every expense series at what
      // it charged, plus each liability's payment. The per-line map
      // and the spending total are both derived from it inside buildFlows.
      const spendingItems = buildSpendingItems(input.expenseSeries, month, state.liabilities, payments);
      flows = buildFlows(
        // Fold in the down-payment gain bands (reporting-only: `cashInflowCents` the gain,
        // no waterfall inflow — the tax the gain bears rode the separate net-neutral source
        // through allocation, so appending these here reports the gain without re-taxing it).
        [...incomeSources, ...fundingDraw.gainSources],
        taxCents,
        expenseCents,
        totalPaymentsCents,
        spendingItems,
        // The liquid-buffer drawdown the withdrawal channel measured PLUS a down
        // payment's returned principal (and any cash source's whole draw) — reported as
        // one `savingsDrawdown` source so a month spent from savings isn't a zero band.
        withdrawal.liquidDrawdownCents + fundingDraw.principalDrawdownCents,
        // The per-category tax breakdown, undefined when the jurisdiction
        // declines it — the app then draws one band, as before.
        taxByCategoryCents,
        // The finer per-SOURCE tax split and per-source deferral,
        // so a chart can band tax by job and show take-home per source.
        taxBySourceCents,
        deferralBySourceCents,
      );
      // Expose the taxable base WITH this month's funding gains already stacked in, so the
      // authoring gate prices a would-be draw exactly where the simulator would put it — on
      // top of any sibling draw already at this month, not just the non-funding income. A
      // newly appended event's draw is last in ledger order, hence last in this month's
      // resolution, so this post-draw base is precisely its marginal context.
      flows = { ...flows, taxableByOwnerAfterFundingCents: toTaxableRecord(fundingDraw.taxableByOwnerAfter) };
    }

    months.push(
      snapshotMonth(
        state,
        month,
        input.annualInflationRate,
        isInsolvent,
        priorInsolvency,
        paymentRecords,
        flows,
      ),
    );
    if (isInsolvent) priorInsolvency = true;
  }

  return { months };
}
