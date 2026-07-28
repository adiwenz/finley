import type { Jurisdiction, JurisdictionContext } from "../jurisdiction";
import { preciseMonthlyRate } from "../cashFlowSeries";
import type { SimState } from "./runState";

/** Step 8: one-time transfers to asset accounts. Fixed + proportional; neither grows. */
export function applyAssetTransfers(state: SimState, month: number): void {
  for (const acc of state.accounts) {
    for (const t of acc.getTransfersAt(month)) {
      const prev = state.assetBalances.get(acc.id) ?? 0;
      const fixed = t.amountCents ?? 0;
      const proportional = Math.round(prev * (t.proportionalFraction ?? 0));
      state.assetBalances.set(acc.id, prev + fixed + proportional);
      // Keep cost basis coherent: a proportional move (a crash, say) scales basis with
      // the balance; a fixed OUTFLOW returns basis pro-rata like a draw; a fixed post-tax
      // INFLUX adds basis. Pre-tax accounts stay at basis 0 — untaxed in, fully taxable out.
      const basis = Math.max(0, state.basisByAccount.get(acc.id) ?? 0);
      let nextBasis = basis + Math.round(basis * (t.proportionalFraction ?? 0));
      if (fixed < 0) {
        const basisFraction = prev > 0 ? Math.min(1, basis / prev) : 0;
        nextBasis -= Math.min(nextBasis, Math.round(-fixed * basisFraction));
      } else if (fixed > 0 && !acc.taxProfile.contributionsPreTax) {
        nextBasis += fixed;
      }
      state.basisByAccount.set(acc.id, Math.max(0, nextBasis));
    }
  }
}

/** Step 9: compound every asset account exactly once at preciseMonthlyRate(rateAt(m)). */
export function compoundAssets(
  state: SimState,
  month: number,
  jurisdiction: Jurisdiction,
  ctx: JurisdictionContext,
): void {
  for (const acc of state.accounts) {
    const bal = state.assetBalances.get(acc.id) ?? 0;
    const grown = Math.round(bal * (1 + acc.getMonthlyRateAt(month)));
    state.assetBalances.set(acc.id, grown);
    // The engine owns compounding and bookkeeping; the JURISDICTION owns whether this
    // account's return is taxed at accrual and under which category. The credited growth is
    // taxed by next month's waterfall — this step runs after that seam, so it can only be
    // taxed one month on. Refreshed every month, cleared when deferred, so no figure goes
    // stale.
    if (acc.taxProfile.returnKind !== undefined) {
      const treatment = jurisdiction.returnTaxTreatment?.(acc.taxProfile.returnKind, ctx);
      if (treatment?.taxAtAccrual) {
        state.accruedReturnByAccount.set(acc.id, {
          cents: Math.max(0, grown - bal),
          category: treatment.category,
        });
      } else {
        state.accruedReturnByAccount.delete(acc.id);
      }
    }
  }
}

/**
 * The purchase month opens at `openingValueCents` with no appreciation, mirroring an account
 * opening or loan origination; a sold property (past `endMonth`) drops to 0 and leaves net
 * worth. Runs after the liability step so a same-month sale (future) settles consistently.
 */
export function advanceProperties(state: SimState, month: number): void {
  for (const p of state.properties) {
    if (month < p.startMonth) continue;
    if (p.endMonth !== null && month > p.endMonth) {
      state.propertyValues.set(p.id, 0);
      continue;
    }
    if (month === p.startMonth) {
      state.propertyValues.set(p.id, p.openingValueCents);
      continue;
    }
    const value = state.propertyValues.get(p.id) ?? 0;
    state.propertyValues.set(
      p.id,
      Math.round(value * (1 + preciseMonthlyRate(p.appreciationAnnualRate))),
    );
  }
}
