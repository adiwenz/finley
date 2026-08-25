/**
 * Who paid for the month, in a household of more than one — the per-person counterpart to
 * {@link import("./fundingView").buildFundingAttribution}'s per-line waterfall.
 *
 * The line-level view says "Housing came from income, Subscriptions from cash savings". That is a
 * DERIVED reading of a fungible pool (see CONTEXT.md, "Funding attribution"), and for one person
 * it is a fair one: reordering the priorities would swap which line was financed, and nothing else
 * about the month would change. With a partner it stops being fair. Accounts are personally owned,
 * the split is an authored percentage, and one partner covering the other's share is a modelled
 * concept with its own name — so a row reading "Subscriptions · Alex's cash savings" asserts an
 * ordering the engine never decided AND puts a name on it, which is the part that can be flatly
 * wrong rather than merely arbitrary.
 *
 * What the engine DID decide, per person and per month, is exactly four things, and this view
 * shows those and nothing else:
 *
 *  1. **Share** — their authored percentage of the household's spending, plus any obligation of
 *     their own. `obligationChargedByPersonCents`.
 *  2. **From income** — how much of that share their own take-home reached.
 *     `obligationFundedByPersonCents`.
 *  3. **From their own accounts** — the balances of theirs that fell to cover the rest.
 *  4. **Assistance** — what the other partner's accounts covered once their own ran out, which is
 *     help rather than a retroactive edit to the split.
 *
 * (3) and (4) are read off the funding records' account OWNERS, so no line is ever assigned to a
 * person. The one assumption is the cascade's own: a person's accounts go to their own share
 * before anyone else's (`buildWithdrawalSources`, § Household funding, step 3). Anything past
 * every account is credit, which belongs to no one and is reported as the household's.
 *
 * Pure — no React, no simulation — so it unit-tests in node beside the other `*View` modules.
 */

import type { FinancialObligation, ResolvedFunding } from "@finley/engine";

/** One account of this person's that paid toward their own share. */
export interface OwnAccountDraw {
  readonly accountId: string;
  readonly label: string;
  readonly amountCents: number;
}

/** What one partner's accounts covered of ANOTHER person's share. */
export interface Assistance {
  readonly fromPersonId: string;
  readonly fromName: string;
  readonly amountCents: number;
}

/** One person's month: what they owed, and every distinct thing that covered it. */
export interface PersonFundingRow {
  readonly personId: string;
  readonly name: string;
  /** Σ of the figures below, and this person's slice of the household total. */
  readonly shareCents: number;
  readonly fromIncomeCents: number;
  readonly fromOwnAccounts: readonly OwnAccountDraw[];
  readonly assistance: readonly Assistance[];
  /** Nobody's account: what the household borrowed toward this person's share. */
  readonly onCreditCents: number;
  /**
   * Money from an account this roster cannot name an owner for. Not expected — every account the
   * panel can be shown is one the roster carries — but it is real money that covered a real share,
   * and dropping it would report the difference as a shortfall the month never had.
   */
  readonly fromUnattributedCents: number;
  /** What nothing covered — the residue the month reports as insolvency. */
  readonly shortfallCents: number;
  /**
   * Take-home less their share, SIGNED — what they had left when the month closed, before goals
   * and the surplus sweep. Shown as a trailing fact rather than as part of the arithmetic above:
   * a surplus is not a funding source, it is what funding did not consume.
   */
  readonly leftOverCents: number;
}

export interface PersonFundingView {
  readonly rows: readonly PersonFundingRow[];
  /** The month's whole automatic spend — Σ every row's `shareCents`. */
  readonly totalCents: number;
}

/** The month's per-person figures, as the flows carry them. */
export interface PersonMonthFigures {
  readonly obligationChargedByPersonCents: Readonly<Record<string, number>>;
  readonly obligationFundedByPersonCents: Readonly<Record<string, number>>;
  readonly netCashFlowByPersonCents: Readonly<Record<string, number>>;
}

/** Whose account is whose, and what to call them — the same maps the per-line view names with. */
export interface PersonFundingNaming {
  readonly accountLabels: ReadonlyMap<string, string>;
  readonly accountOwners: ReadonlyMap<string, string>;
  readonly personNames: ReadonlyMap<string, string>;
}

/**
 * The people this month is actually about: anyone the household charged, or who had cash flow of
 * their own. Every per-person map carries a key for every member the plan has EVER had, zeroed for
 * the months they are not here, so a departed partner would otherwise keep a row of zeroes years
 * after they left — and their presence in the list is exactly what decides whether this view is
 * shown at all.
 */
export function fundingPeopleAt(figures: PersonMonthFigures): string[] {
  const ids = new Set([
    ...Object.keys(figures.obligationChargedByPersonCents),
    ...Object.keys(figures.netCashFlowByPersonCents),
  ]);
  return [...ids].filter(
    (id) =>
      (figures.obligationChargedByPersonCents[id] ?? 0) !== 0 ||
      (figures.netCashFlowByPersonCents[id] ?? 0) !== 0,
  );
}

/**
 * Whether the household is more than one person THIS month — the condition the per-person view
 * replaces the per-line waterfall under. Dated, not structural: a plan with two relationships in
 * it is a household of one during the years between them, and reads as one.
 */
export function isPartneredMonth(figures: PersonMonthFigures): boolean {
  return fundingPeopleAt(figures).length > 1;
}

/** Only the records the shared waterfall funded; an explicitly-funded draw named its own accounts. */
export function automaticFundingRecords(
  resolvedFunding: readonly ResolvedFunding[],
  obligations: readonly FinancialObligation[],
): ResolvedFunding[] {
  const automaticIds = new Set(
    obligations.filter((o) => o.funding.kind === "automatic").map((o) => o.id),
  );
  return resolvedFunding.filter((r) => automaticIds.has(r.obligationId));
}

/**
 * Build the month's per-person rows.
 *
 * The two account passes are the whole algorithm. First each person's own accounts are matched to
 * their own unfunded share, capped at whichever is smaller — the cascade drew them in exactly that
 * order, so this is a reading of what happened rather than a rule imposed on it. Whatever a
 * person's accounts delivered BEYOND their own share is help, and is offered to whoever is still
 * short, proportionally, so two helpers split a shortfall the way their draws did. Credit closes
 * anything past every account.
 */
export function buildPersonFunding(
  figures: PersonMonthFigures,
  resolvedFunding: readonly ResolvedFunding[],
  obligations: readonly FinancialObligation[],
  naming: PersonFundingNaming,
): PersonFundingView {
  const people = fundingPeopleAt(figures);
  const records = automaticFundingRecords(resolvedFunding, obligations);

  // Every account draw of the month, per owner and per account, in the order the cascade took
  // them — the row order below is the order the money left.
  const drawsByOwner = new Map<string, OwnAccountDraw[]>();
  let creditCents = 0;
  let unattributedCents = 0;
  for (const record of records) {
    for (const source of record.sources) {
      if (source.kind === "credit") {
        creditCents += source.amountCents;
        continue;
      }
      if (source.kind !== "account") continue;
      const owner = naming.accountOwners.get(source.sourceId);
      if (owner === undefined) {
        unattributedCents += source.amountCents;
        continue;
      }
      const draws = drawsByOwner.get(owner) ?? [];
      const existing = draws.find((d) => d.accountId === source.sourceId);
      if (existing === undefined) {
        draws.push({
          accountId: source.sourceId,
          label: naming.accountLabels.get(source.sourceId) ?? source.sourceId,
          amountCents: source.amountCents,
        });
      } else {
        draws[draws.indexOf(existing)] = { ...existing, amountCents: existing.amountCents + source.amountCents };
      }
      drawsByOwner.set(owner, draws);
    }
  }

  // Pass one: a person's own accounts against their own unfunded share.
  const gapCents = new Map<string, number>();
  const ownDraws = new Map<string, OwnAccountDraw[]>();
  const surplusCents = new Map<string, number>();
  for (const id of people) {
    const share = figures.obligationChargedByPersonCents[id] ?? 0;
    const fromIncome = figures.obligationFundedByPersonCents[id] ?? 0;
    const gap = Math.max(0, share - fromIncome);
    const draws = drawsByOwner.get(id) ?? [];
    const taken: OwnAccountDraw[] = [];
    let remaining = gap;
    for (const draw of draws) {
      const take = Math.min(remaining, draw.amountCents);
      if (take > 0) taken.push({ ...draw, amountCents: take });
      remaining -= take;
    }
    const drawnTotal = draws.reduce((sum, d) => sum + d.amountCents, 0);
    ownDraws.set(id, taken);
    gapCents.set(id, remaining);
    surplusCents.set(id, Math.max(0, drawnTotal - (gap - remaining)));
  }

  // Pass two: whatever is left of somebody's accounts covers whoever is still short.
  const assistanceTo = new Map<string, Assistance[]>();
  const helpers = people.filter((id) => (surplusCents.get(id) ?? 0) > 0);
  const totalHelp = helpers.reduce((sum, id) => sum + (surplusCents.get(id) ?? 0), 0);
  if (totalHelp > 0) {
    for (const id of people) {
      const gap = gapCents.get(id) ?? 0;
      if (gap <= 0) continue;
      const covered = Math.min(gap, totalHelp);
      const given: Assistance[] = [];
      let handedOut = 0;
      helpers.forEach((helper, i) => {
        // The last helper absorbs the rounding, so the parts sum to `covered` to the cent.
        const cents =
          i === helpers.length - 1
            ? covered - handedOut
            : Math.round((covered * (surplusCents.get(helper) ?? 0)) / totalHelp);
        handedOut += cents;
        if (cents > 0) {
          given.push({
            fromPersonId: helper,
            fromName: naming.personNames.get(helper) ?? helper,
            amountCents: cents,
          });
        }
      });
      assistanceTo.set(id, given);
      gapCents.set(id, gap - covered);
    }
  }

  /**
   * Divide a household-wide pool across the shares still open, in proportion to how open each is,
   * and CLOSE those shares by what it covered — so a second pool divides what the first left
   * rather than the gap as it stood before either ran.
   *
   * Capped by the open gap in total: past the last pool the month is genuinely insolvent, and
   * what remains has to stay its own figure. Rolling it into "from income" would report money as
   * having arrived when the whole point of the month is that it did not.
   */
  const acrossOpenShares = (poolCents: number): Map<string, number> => {
    const openGapCents = people.reduce((sum, id) => sum + (gapCents.get(id) ?? 0), 0);
    const toShare = Math.min(poolCents, openGapCents);
    const byPerson = new Map<string, number>();
    let handedOut = 0;
    people.forEach((id, i) => {
      // The last row absorbs the rounding, so the parts sum to the pool to the cent.
      const cents = Math.max(
        0,
        i === people.length - 1
          ? toShare - handedOut
          : Math.round((toShare * (gapCents.get(id) ?? 0)) / (openGapCents || 1)),
      );
      handedOut += cents;
      byPerson.set(id, cents);
      gapCents.set(id, (gapCents.get(id) ?? 0) - cents);
    });
    return byPerson;
  };
  // An owner-less account's money before the card: it is somebody's holding even if this roster
  // cannot say whose, and a household does not borrow while it still has cash.
  const unattributedByPerson = acrossOpenShares(unattributedCents);
  const creditByPerson = acrossOpenShares(creditCents);

  const rows = people.map((id): PersonFundingRow => {
    const share = figures.obligationChargedByPersonCents[id] ?? 0;
    const own = ownDraws.get(id) ?? [];
    const assistance = assistanceTo.get(id) ?? [];
    const onCreditCents = creditByPerson.get(id) ?? 0;
    return {
      personId: id,
      name: naming.personNames.get(id) ?? id,
      shareCents: share,
      fromIncomeCents: figures.obligationFundedByPersonCents[id] ?? 0,
      fromOwnAccounts: own,
      assistance,
      onCreditCents,
      fromUnattributedCents: unattributedByPerson.get(id) ?? 0,
      // The residue every pool above has already been subtracted from, so the figures sum to the
      // share exactly however the month went.
      shortfallCents: Math.max(0, gapCents.get(id) ?? 0),
      leftOverCents: figures.netCashFlowByPersonCents[id] ?? 0,
    };
  });

  return { rows, totalCents: rows.reduce((sum, r) => sum + r.shareCents, 0) };
}
