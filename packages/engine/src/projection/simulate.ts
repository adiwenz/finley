import type { Cents } from "../money";
import type { Jurisdiction, JurisdictionContext } from "../jurisdiction";
import { accumulateEarnings, buildGovernmentBenefitSources } from "./governmentBenefit";
import { buildRmdSources } from "./rmd";
import { buildWithdrawalSources } from "./withdrawal";
import { buildFlows } from "./reportFlows";
import { buildSpendingItems } from "./spendingItems";
import type {
  HouseholdSimInput,
  SimOwnedSeries,
  ProjectionMonth,
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

// Re-exported so importers (and the engine barrel in index.ts) keep resolving the
// simulator's public types through ./simulate. `SimPerson` is OMITTED: it is an
// engine-INTERNAL compiled shape (the app authors `Person`, the sim derives `SimPerson` via
// `compilePerson`), so internal code imports it directly from ./simulate.types.
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
 * The tax chokepoint lives inside the waterfall and nowhere else. The pre-flow state is
 * captured once as {@link ProjectionSeries.opening}; every entry in `months` is a real,
 * processed month, `months[i]` folding in `months[i-1]`'s flows plus its own.
 */
export function simulateHousehold(
  input: HouseholdSimInput,
  jurisdiction: Jurisdiction,
): ProjectionSeries {
  const startYear = input.startYear ?? DEFAULT_START_YEAR;
  const state = initSimState(input);
  // "Now", before any flow: the net-worth chart's first point and the baseline every
  // processed month builds on. Captured before the loop mutates state; carries no flows.
  const opening = snapshotMonth(state, {
    month: 0,
    // "Now" itself: nothing has elapsed, so real dollars equal nominal here.
    elapsedMonths: 0,
    annualInflationRate: input.annualInflationRate,
    isInsolvent: false,
    netWorthTerminated: false,
    liabilityPaymentRecords: {},
    flows: undefined,
  });
  const months: ProjectionMonth[] = [];
  // Insolvency is terminal for net-worth reporting: once a month exhausts all credit, every
  // LATER month reports net worth as null. The first insolvent month still reports its
  // honest, negative value.
  let priorInsolvency = false;

  // `< horizonMonths` (not `<=`): the opening snapshot is no longer an array slot, so the
  // same span now yields exactly `horizonMonths` processed months, `month` 0-based.
  for (let month = 0; month < input.horizonMonths; month++) {
    // Calendar year for this month's flows. Month 0 is now processed like any other, so
    // `months[0..11]` accrue a full 12 covered-earnings months in year 0 — a $5k/mo salary
    // contributes the whole $60k, closing the graph-vs-panel benefit gap. A mid-year start
    // (fewer than 12 real months left in this calendar year) is still unmodelled.
    const year = startYear + Math.floor(month / 12);
    const ctx: JurisdictionContext = { year };

    // Fold this month's covered wages into the covered-earnings record before assembling
    // income, so a claim landing this month sees them.
    accumulateEarnings(state.earningsByPerson, input.incomeSeries, month, year, jurisdiction);
    // RMDs force this year's required draw out of pre-tax accounts BEFORE the waterfall
    // runs and re-enter here as taxable ordinary income, so the withdrawal is taxed once
    // at the single chokepoint.
    const nonWithdrawalSources = [
      ...buildIncomeSources(input.incomeSeries, month),
      // Last month's credited cash interest, taxed as ordinary income at accrual; a
      // non-withdrawal source, so it shrinks the gap and feeds provisional income.
      ...buildInterestAccrualSources(state),
      ...buildGovernmentBenefitSources(
        state,
        jurisdiction,
        month,
        startYear,
        input.benefitColaRate ?? input.annualInflationRate,
      ),
      ...buildRmdSources(state, jurisdiction, month, startYear),
    ];

    const expenseCents = sumMonthlySeries(input.expenseSeries, month);
    const payments = computeLiabilityPayments(state, month);
    const totalPaymentsCents = [...payments.values()].reduce((s, v) => s + v, 0);

    // Decumulation: when non-withdrawal income can't cover the month's obligations,
    // liquidate investment accounts BEFORE the waterfall — same seam as RMD/benefit — so
    // the shortfall is funded by selling assets instead of landing on the synthetic credit
    // card. RMD income is already counted here, so the draw never double-withdraws.
    const withdrawal = buildWithdrawalSources(
      state,
      jurisdiction,
      nonWithdrawalSources,
      expenseCents + totalPaymentsCents,
      ctx,
    );
    const incomeSources = [...nonWithdrawalSources, ...withdrawal.sources];

    // Down-payment / one-time-spend draws resolve BEFORE the tax chokepoint so an
    // appreciated source's realized gain is actually taxed. Each source is grossed up over
    // that tax and drained here (before compounding, so a drained balance does not earn
    // this month); its net-neutral tax source rides into `allocateMonth` so the gain is
    // charged exactly once. `fundingBase` is the month's per-owner taxable base from
    // non-funding income — the marginal context the gain's tax is differenced over, built
    // before the draw and exposed on the flow view so the authoring §4.5 gate differences
    // the gain the SAME way (exact under any regime, not a flat-rate estimate).
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
    const isInsolvent = uncoveredCents > 0;
    // A committed contribution deposits in full and borrows the rest; if that borrowing
    // couldn't be funded (this uncovered slice), unwind the phantom deposit.
    unwindUnfundedContributions(state, contributions, uncoveredCents);

    applyAssetTransfers(state, month);
    compoundAssets(state, month, jurisdiction, ctx);
    advanceLiabilities(state, month, payments);
    advanceProperties(state, month);
    const paymentRecords = buildLiabilityPaymentRecords(payments);
    const spendingItems = buildSpendingItems(input.expenseSeries, month, state.liabilities, payments);
    const bands = buildFlows(
      // The down-payment gain bands are reporting-only: `cashInflowCents` the gain, no
      // waterfall inflow — its tax already rode the net-neutral source through allocation.
      [...incomeSources, ...fundingDraw.gainSources],
      taxCents,
      expenseCents,
      totalPaymentsCents,
      spendingItems,
      // The withdrawal channel's liquid-buffer drawdown PLUS a down payment's returned
      // principal (and any cash source's whole draw) — one `savingsDrawdown` source, so a
      // month spent from savings isn't a zero band.
      withdrawal.liquidDrawdownCents + fundingDraw.principalDrawdownCents,
      // Undefined when the jurisdiction declines a breakdown; the app then draws one band.
      taxByCategoryCents,
      // The finer per-SOURCE splits, so a chart can band tax by job and show take-home
      // per source.
      taxBySourceCents,
      deferralBySourceCents,
    );
    // The taxable base WITH this month's funding gains stacked in, so the authoring gate
    // prices a would-be draw on top of any sibling draw at this month. A newly appended
    // event's draw is last in ledger order, hence last in resolution, so this post-draw
    // base is its marginal context.
    const flows = {
      ...bands,
      taxableByOwnerAfterFundingCents: toTaxableRecord(fundingDraw.taxableByOwnerAfter),
    };

    months.push(
      snapshotMonth(state, {
        month,
        // `month + 1`, NOT `month`: this snapshot is the END of month `month`, so that many
        // months plus one have passed since "now". Deflating by `month` would understate a
        // year of inflation by a twelfth, every month, all the way out.
        elapsedMonths: month + 1,
        annualInflationRate: input.annualInflationRate,
        isInsolvent,
        netWorthTerminated: priorInsolvency,
        liabilityPaymentRecords: paymentRecords,
        flows,
      }),
    );
    if (isInsolvent) priorInsolvency = true;
  }

  return { opening, months };
}
