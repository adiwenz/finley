import type { Cents } from "../money/money";
import type { AccountTaxTreatment, SimAccount } from "../plan/simAccount";
import type { Jurisdiction, JurisdictionContext } from "../jurisdiction/jurisdiction";
import type { IncomeSourceMonth } from "./waterfall";

/**
 * The slice of `SimState` decumulation reads and mutates, declared structurally to keep
 * state private to the simulator and this module independently testable.
 */
export interface WithdrawalState {
  readonly accounts: readonly SimAccount[];
  /** Authoritative balances; a draw reduces its source account in place. */
  readonly assetBalances: Map<string, Cents>;
  /**
   * Post-tax principal, per account. A draw books only its GAIN (`draw − pro-rata basis`)
   * to tax. Absent → basis 0, so the whole draw is taxable, as for a pre-tax account.
   */
  readonly basisByAccount: Map<string, Cents>;
  /**
   * The designated FALLBACK surplus/shortfall sink `allocateMonth` posts the household's
   * residual cash-flow gap against, when decumulation's own owner-aware prediction (see {@link
   * import("./withdrawal").WithdrawalPlan.liquidDrawdownByAccountCents}) names nothing — e.g. no
   * liquid account exists at all. NOT read by this module directly: a household-wide "the liquid
   * account drains first regardless of whose it is" pre-pass was exactly the ownership-blind
   * behavior decumulation (below) now avoids — every liquid account, this one included, is just
   * another owner-aware candidate.
   */
  readonly liquidAccount: SimAccount | null;
}

/**
 * Default liquidation order, keyed by an account's {@link
 * import("../plan/simAccount").AccountTaxTreatment} — earlier is drawn first, ranking accounts by
 * what HOLDING each one still defers:
 *
 *  - `taxedAtAccrual` (a cash balance) first: its return is taxed the month it is credited, so
 *    holding it defers nothing. Spending it costs a household nothing at all, and every month it
 *    is skipped is a month something taxable was sold instead.
 *  - `taxable` next — a realized gain is the least friction of the taxable draws under a
 *    preferential-rate regime.
 *  - `taxDeferred` after that: the whole withdrawal is ordinary income.
 *  - `taxExempt` last, because its growth is genuinely never taxed and holding it compounds that.
 *    The two accounts that owe nothing on withdrawal sit at OPPOSITE ends for that reason alone.
 *
 * Keyed on the TREATMENT and not on the withdrawal {@link import("../money/cashFlowSeries").TaxCategory}, though the two line up
 * one-for-one across today's four profiles. The category answers "what is this money when it
 * arrives" — a question for the brackets — and reusing it here made the order right only by
 * coincidence: two accounts sharing a category would have shared a rank whatever their treatment,
 * and a cash buffer inherited "draw last to preserve tax-free growth" from a Roth on the strength
 * of a shared label.
 *
 * No gross-up happens here — an ordinary mid-year decumulation's own tax is settled with the rest
 * of the year's, through the year's withholding and its closing balance (see {@link
 * import("../jurisdiction/jurisdiction").Jurisdiction.computeTaxCents}'s ANNUAL contract) — so
 * the order ranks accounts by preference alone, not by gross-up cost.
 */
export const DEFAULT_LIQUIDATION_ORDER: readonly AccountTaxTreatment[] = [
  "taxedAtAccrual",
  "taxable",
  "taxDeferred",
  "taxExempt",
];

function liquidationRankMap(
  order: readonly AccountTaxTreatment[],
): Partial<Record<AccountTaxTreatment, number>> {
  const map: Partial<Record<AccountTaxTreatment, number>> = {};
  order.forEach((treatment, index) => {
    if (map[treatment] === undefined) map[treatment] = index;
  });
  return map;
}

/** The shape {@link orderedLiquidationAccounts} ranks by — every account state in the engine has it. */
export interface LiquidationRankable {
  readonly id: string;
  readonly taxProfile: { readonly taxTreatment: AccountTaxTreatment };
}

/**
 * The account order every money-out path ranks by: `liquidAccountId` (if given) absolutely
 * first, otherwise by `liquidationOrder` rank, ties held in the roster's own order by a stable
 * sort — cash (`taxedAtAccrual`) ranks first there regardless, so a `null` id still drains cash
 * before investments.
 *
 * Decumulation ({@link buildWithdrawalSources}) passes `null`: which account is "the" liquid one
 * is ownership-blind and irrelevant to it — every owner-aware pass ranks each candidate list by
 * `liquidationOrder` alone, so a person's own cash is preferred within THEIR accounts without any
 * single account being singled out ahead of time. The year-start tax projection ({@link
 * import("./taxYearProjection").projectKnownTaxYear}) is the one caller that still names an id: it
 * forecasts a POOLED, aggregate taxable draw for withholding purposes, not a real per-person
 * liquidation, so whose account is "the" designated buffer does not change the estimate.
 */
export function orderedLiquidationAccounts<T extends LiquidationRankable>(
  accounts: readonly T[],
  liquidAccountId: string | null,
  liquidationOrder: readonly AccountTaxTreatment[] = DEFAULT_LIQUIDATION_ORDER,
): readonly T[] {
  const rankMap = liquidationRankMap(liquidationOrder);
  const rank = (a: T): number =>
    a.id === liquidAccountId ? -1 : (rankMap[a.taxProfile.taxTreatment] ?? 99);
  return [...accounts].sort((a, b) => rank(a) - rank(b));
}

/**
 * Result of the decumulation channel, which runs BEFORE the waterfall AND before December's
 * Required Minimum Distribution true-up ({@link import("./rmd").buildRmdSources}) reads what it
 * drew: it pulls cash from investment accounts (mutating `assetBalances`) and re-injects it as
 * income.
 *
 * NEED-based, not a safe-withdrawal rate — and the need is HANDED to it, measured by the very
 * waterfall that will charge the month ({@link
 * import("./allocationStep").projectObligationShortfallCents}) rather than re-derived here from a
 * second model of take-home. This module therefore knows nothing about deferrals, payroll tax or
 * tax withheld, which is the point: the one arithmetic that decides what a household has left
 * lives in one place, so a deduction cannot be docked there and missed here.
 *
 * A liquid ({@link import("../plan/simAccount").SimAccount.liquid}) balance is spent before
 * anything is sold, but OWNER-AWARE: each person's own liquid accounts are tried as part of
 * THEIR share of the gap FIRST (see {@link buildWithdrawalSources}), never pooled ahead of time
 * into one arbitrarily-chosen household-wide buffer regardless of whose it is. That spend is
 * PREDICTED here (see {@link WithdrawalPlan.liquidDrawdownByAccountCents}), never applied — the
 * caller's real debit happens once, against the SAME accounts in the SAME proportion, when it
 * posts the month's actual residual shortfall (see {@link
 * import("./allocationStep").allocateMonth}); applying it twice would double-spend the buffer.
 * Every investment draw, by contrast, sells EXACTLY `need` (capped at the account's balance) here
 * and now — no gross-up: the tax this draw's own gain causes is not charged here, or in any other
 * month, but folded into the year's actual taxable income and settled with the year. The realized
 * gain still rides `taxableCents` on the returned source, so it reaches the caller's annual
 * accumulator; it is simply not netted out of the draw itself.
 *
 * Runs BEFORE December's Required Minimum Distribution true-up ({@link
 * import("./rmd").buildRmdSources}), not after: this module sizes and sells purely off the
 * household's own need, and whatever it draws from a pre-tax account counts toward that
 * person's annual requirement ({@link import("./rmd").recordAccountDistributions}) before
 * the true-up decides what — if anything — is still owed.
 */
export interface WithdrawalPlan {
  readonly sources: IncomeSourceMonth[];
  /**
   * The slice of the gap PREDICTED to be covered by each owner's designated liquid ({@link
   * import("../plan/simAccount").SimAccount.liquid}) buffer — the sum of {@link
   * liquidDrawdownByAccountCents}. Reporting-only, never a waterfall source: the cascade already
   * spends this cash directly, so injecting it would double-count and mis-tax it.
   */
  readonly liquidDrawdownCents: Cents;
  /**
   * {@link liquidDrawdownCents}, broken out by WHICH liquid account is predicted to cover it —
   * owner-aware (each person's own liquid accounts first, for their share of the gap; the
   * pooled remainder afterward), so the caller's actual debit ({@link
   * import("./allocationStep").allocateMonth}) can charge the household's residual shortfall
   * against the right people's accounts instead of one arbitrarily-chosen household-wide buffer.
   * A PREDICTION, not a mutation: this module sells investments (below) but never touches a
   * liquid balance itself — see {@link liquidDrawdownCents}'s own doc for why.
   */
  readonly liquidDrawdownByAccountCents: ReadonlyMap<string, Cents>;
  /**
   * Each liquidated account's full withdrawal result, in liquidation order — the decumulation
   * slice per-line funding attribution partitions across obligations. Carries the whole breakdown,
   * not just the net, so a consumer never re-derives basis or tax from a flattened amount:
   * `gross = principal + gain` (principal is the returned basis) and `net = gross − tax`. Reported
   * net so Σ `netDeliveredCents` is the cash the walk funds with, not the gross sold. Aligns 1:1
   * with {@link sources}; empty when nothing was liquidated. Never includes a liquid account —
   * see {@link liquidDrawdownCents}.
   */
  readonly decumulationDraws: readonly DecumulationDrawResult[];
}

/** One account's liquidation, gross down to the net cash it delivered toward the month. */
export interface DecumulationDrawResult {
  readonly sourceId: string;
  readonly grossWithdrawnCents: Cents;
  /** Returned basis (`gross − gain`); the amount the draw reduced the account's basis by. */
  readonly principalCents: Cents;
  readonly realizedGainCents: Cents;
  readonly taxCents: Cents;
  readonly netDeliveredCents: Cents;
}

/**
 * PREDICT up to `targetCents` of coverage from `candidates` — every liquid account eligible for
 * this pass — in order, capped at each account's CURRENT balance. Never mutates: unlike {@link
 * drainAccounts}, a liquid account's real debit happens once, later, when the caller posts the
 * month's actual residual shortfall (see {@link WithdrawalPlan.liquidDrawdownByAccountCents}).
 * Adds each account's predicted share into `byAccount` and returns what was predicted in total
 * (≤ `targetCents`; less when the candidates together fall short).
 */
function predictLiquidCoverage(
  candidates: readonly SimAccount[],
  targetCents: Cents,
  state: WithdrawalState,
  byAccount: Map<string, Cents>,
): Cents {
  let remaining = targetCents;
  for (const account of candidates) {
    if (remaining <= 0) break;
    // Each account's OWN balance minus whatever an earlier pass this same month already
    // predicted against it — a person-aware pass and the pooled fallback must never together
    // predict more from one account than it actually holds.
    const balance = Math.max(0, state.assetBalances.get(account.id) ?? 0) - (byAccount.get(account.id) ?? 0);
    if (balance <= 0) continue;
    const draw = Math.min(balance, remaining);
    byAccount.set(account.id, (byAccount.get(account.id) ?? 0) + draw);
    remaining -= draw;
  }
  return targetCents - remaining;
}

/**
 * Sell up to `targetCents` from `candidates`, in order, capped at each account's balance —
 * the one sale mechanic both the per-person pass and the pooled pass below run, so a draw's
 * gain/basis/reporting shape cannot drift between them. Returns what was actually raised
 * (≤ `targetCents`; less when the candidates together fall short).
 */
function drainAccounts(
  candidates: readonly SimAccount[],
  targetCents: Cents,
  state: WithdrawalState,
  jurisdiction: Jurisdiction,
  ctx: JurisdictionContext,
  sources: IncomeSourceMonth[],
  decumulationDraws: DecumulationDrawResult[],
): Cents {
  let remaining = targetCents;
  for (const account of candidates) {
    if (remaining <= 0) break;
    const balance = state.assetBalances.get(account.id) ?? 0;
    if (balance <= 0) continue;

    const withdrawalCategory = account.taxProfile.withdrawalCategory;
    // Only the GAIN is taxable, but WHICH portion is the jurisdiction's call: the engine
    // owns and passes the basis state, the jurisdiction owns the return-of-capital policy
    // and accounting method. Absent seam → the whole draw is taxable.
    const basis = Math.max(0, state.basisByAccount.get(account.id) ?? 0);
    const gainOf = (draw: Cents): Cents =>
      jurisdiction.taxableWithdrawalCents?.(
        { grossCents: draw, basisCents: basis, balanceCents: balance, category: withdrawalCategory },
        ctx,
      ) ?? draw;
    // Sell exactly what's still needed, capped at the balance — no gross-up. Only the gain is
    // booked as `taxableCents` on the returned source (fed to the caller's annual
    // accumulator); the full gross is still paid out as take-home below, and no tax is netted
    // out of it.
    const gross = Math.min(balance, remaining);
    const gainCents = gainOf(gross);

    // The rest of the gross is returned principal; reduce basis by it (method-agnostic:
    // gross − taxable).
    state.basisByAccount.set(account.id, basis - (gross - gainCents));
    state.assetBalances.set(account.id, balance - gross);
    remaining -= gross;
    sources.push({
      ownerId: account.ownerId,
      waterfallInflowCents: gross,
      taxCategory: withdrawalCategory,
      taxableCents: gainCents,
      // Reporting only bands the realized gain as income — `cashInflowCents` overrides the
      // `waterfallInflowCents` (full gross) fallback `buildFlows` would otherwise use. The
      // returned principal is not income; it bands under this account's own name instead
      // (see `decumulationDraws[].principalCents`, read by the simulator).
      cashInflowCents: gainCents,
      // Report by source account, so a draining "emergency fund" reads by name rather than
      // as an anonymous `capitalGains` band. Suffixed "draw" — parallel to the explicit funding
      // pipeline's "<Account> gains" — so this reads as the same KIND of thing (a realized-gain
      // band from a sale) rather than, say, interest or growth on the account.
      sourceId: account.id,
      label: `${account.label ?? account.id} draw`,
      fromAccountWithdrawal: true,
    });
    // `gross − gain` is the returned basis (the same figure that reduced `basisByAccount`
    // above); `taxCents` is always 0 and `netDeliveredCents` always equals `gross` — no tax
    // is charged against an ordinary mid-year draw.
    decumulationDraws.push({
      sourceId: account.id,
      grossWithdrawnCents: gross,
      principalCents: gross - gainCents,
      realizedGainCents: gainCents,
      taxCents: 0,
      netDeliveredCents: gross,
    });
  }
  return targetCents - remaining;
}

export function buildWithdrawalSources(
  state: WithdrawalState,
  jurisdiction: Jurisdiction,
  /**
   * The month's uncovered obligation cash — what the waterfall over non-decumulation income
   * alone could not fund, deductions and all. Already net of income: a household whose pay
   * covers the month is short 0 and sells nothing.
   */
  shortfallCents: Cents,
  ctx: JurisdictionContext,
  liquidationOrder: readonly AccountTaxTreatment[] = DEFAULT_LIQUIDATION_ORDER,
  /**
   * {@link import("./waterfall").WaterfallResult.obligationShortfallByPersonCents} — whose
   * share of the gap this is, a PREFERENCE for {@link need}'s liquidation order (§ Household
   * funding, step 3), never a second total. Absent, or every dollar unattributed (nobody
   * carries a positive share), sells in EXACTLY the pooled order below, unchanged from before
   * this parameter existed.
   */
  byPersonCents?: ReadonlyMap<string, Cents>,
): WithdrawalPlan {
  const gap = shortfallCents;
  if (gap <= 0) {
    return {
      sources: [],
      liquidDrawdownCents: 0,
      liquidDrawdownByAccountCents: new Map(),
      decumulationDraws: [],
    };
  }

  let need = gap;
  const liquidDrawdownByAccountCents = new Map<string, Cents>();
  const sources: IncomeSourceMonth[] = [];
  // The designated "buffer" — one PER OWNER, the same way `state.liquidAccount` used to be one
  // for the whole household: their FIRST liquid account, whatever its own tax treatment (a
  // household's sole account can be a liquid brokerage, and the buffer role — spent first,
  // tax-free for THIS purpose — has always ridden on `liquid` alone, not on being cash
  // specifically). A person's OTHER liquid accounts — a named "cash" GOAL fund, say — are
  // excluded: a goal is a distinct financial object the household tracks by name, and keeps
  // selling through the normal, named, taxed path below. Every standing household build
  // (`buildPlanAccounts`/`buildPartnerAccounts`) lists a person's own cash/savings account before
  // any goal fund of theirs, so "first" reliably lands on the standing account — byte-identical
  // to `state.liquidAccount`'s own selection for a single-person household.
  const bufferIdByOwner = new Map<string, string>();
  for (const a of state.accounts) {
    if (a.liquid && !bufferIdByOwner.has(a.ownerId)) bufferIdByOwner.set(a.ownerId, a.id);
  }
  const isBuffer = (a: SimAccount): boolean => bufferIdByOwner.get(a.ownerId) === a.id;
  const decumulationDraws: DecumulationDrawResult[] = [];

  // Every non-liquid pass below sells from this set — a buffer account is only ever PREDICTED
  // (see `predictLiquidCoverage`), never sold here.
  const investmentCandidates = (owner: string | undefined): readonly SimAccount[] =>
    orderedLiquidationAccounts(
      state.accounts.filter((a) => !isBuffer(a) && (owner === undefined || a.ownerId === owner)),
      null,
      liquidationOrder,
    );

  // Person-aware pass: try each person's OWN accounts — their liquid buffer first (predicted,
  // see {@link predictLiquidCoverage}), then their own investments (sold now) — for their share
  // of `need` FIRST — the fix for "account ordering arbitrarily causing one person's assets to
  // fund the household while the other's remain untouched" (§ Household funding). An
  // individually-owned savings/cash account is not carved out into a separate household-wide
  // buffer; it competes for its owner's own share on the same terms as any other account they
  // hold. Each target is FLOORED against the `need` this pass started with (never rounded, never
  // cumulative), so two people with IDENTICAL weight compute the identical target from the
  // identical formula — no positional tie-break to land on one of them arbitrarily — and the sum
  // of every floored target can only fall short of `need`, never overshoot it, so no one's target
  // is ever clamped by an earlier person's draw either. Whatever the flooring leaves on the table
  // (at most one cent per person) falls through to the pooled pass below, same as an unattributed
  // shortfall.
  //
  // Runs even with exactly ONE positive entry: a personal obligation (§ Household funding,
  // "person-specific obligations should remain assigned entirely to that person") routinely
  // attributes the WHOLE gap to a single person, unlike a shared obligation's proportional
  // split, which usually leaves both with something. Skipping straight to the ownership-blind
  // pooled pass there would sell whichever account the roster lists first — often the OTHER
  // partner's — for a debt that was never theirs. A single-person household's own lone entry
  // still matches this: every account there is that person's, so the person-aware pass and the
  // pooled pass draw the identical set in the identical order regardless.
  const positiveByPerson = [...(byPersonCents ?? [])].filter(([, cents]) => cents > 0);
  const totalByPerson = positiveByPerson.reduce((sum, [, cents]) => sum + cents, 0);
  if (totalByPerson > 0) {
    const needAtStart = need;
    for (const [pid, weightCents] of positiveByPerson) {
      if (need <= 0) break;
      const targetCents = Math.min(Math.floor((needAtStart * weightCents) / totalByPerson), need);
      if (targetCents <= 0) continue;

      const personLiquid = state.accounts.filter((a) => a.ownerId === pid && isBuffer(a));
      const predictedLiquid = predictLiquidCoverage(
        personLiquid,
        targetCents,
        state,
        liquidDrawdownByAccountCents,
      );
      need -= predictedLiquid;

      const remainingTarget = targetCents - predictedLiquid;
      if (remainingTarget > 0) {
        need -= drainAccounts(
          investmentCandidates(pid),
          remainingTarget,
          state,
          jurisdiction,
          ctx,
          sources,
          decumulationDraws,
        );
      }
    }
  }

  // Shared pooled pass, in the same order as before this function took a per-person hint:
  // whatever `need` remains — a single funding-eligible person, cross-person coverage once
  // someone's own accounts ran dry, or an unattributed slice (a negative-take-home deficit
  // the split could not name a person for). The LAST rung a household's own money reaches:
  // whatever a partner's unspent pay could cover has already left `shortfallCents` before this
  // function was called (see {@link import("./waterfall").runWaterfall}'s assistance step), so
  // an account is only sold here for a gap no income anywhere could close. Never lets an account go negative: both passes below
  // cap every draw at the account's own balance, same as the per-person pass above.
  if (need > 0) {
    const pooledLiquid = state.accounts.filter(isBuffer);
    need -= predictLiquidCoverage(pooledLiquid, need, state, liquidDrawdownByAccountCents);
  }
  if (need > 0) {
    need -= drainAccounts(
      investmentCandidates(undefined),
      need,
      state,
      jurisdiction,
      ctx,
      sources,
      decumulationDraws,
    );
  }

  const liquidDrawdownCents = [...liquidDrawdownByAccountCents.values()].reduce(
    (sum, cents) => sum + cents,
    0,
  );

  return { sources, liquidDrawdownCents, liquidDrawdownByAccountCents, decumulationDraws };
}
