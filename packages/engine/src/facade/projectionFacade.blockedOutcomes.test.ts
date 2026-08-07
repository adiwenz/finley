/**
 * `ProjectionSeries.obligationOutcomes` as the public `Projection` facade reports it — the
 * consumer-visible seam the app's timeline/warning read. Authored entirely through `Projection`
 * (`buyHome`, `updatePlan`), never through simulator internals, since what matters here is what a
 * caller of the public API actually sees: the outcome CONTRACT (status + provenance), not the
 * resolution mechanics that produce it — those are pinned at the simulator seam in
 * `projection/simulate.blocking.test.ts`.
 *
 * The load-bearing case: four purchases in ledger order, A and B and C landing in the SAME month.
 * A resolves before the block, B is the block, C is a same-month sibling authored after B, and D
 * is authored in a later month entirely. Outcomes must reflect what the engine actually did during
 * resolution, not a month comparison — a same-month sibling that never resolved is `not-reached`,
 * identically to something authored later, never `executed`.
 */
import { describe, it, expect } from "vitest";
import { Projection, dollarsToCents } from "../index";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import { samplePlan, stateOf } from "../testing/samplePlan";
import { P1 } from "../testing/projectionFacadeFixtures";

const BLOCK_MONTH = 6;

/** Authored generously — large enough that all four purchases pass the §4.5 gate as authored. */
function freshProjection(): Projection {
  return Projection.fromState(
    stateOf({
      ...samplePlan,
      jobs: [],
      budgetLines: [],
      openingBalanceCents: dollarsToCents(2_000_000),
    }),
    nullJurisdiction,
  );
}

function buy(p: Projection, month: number, priceDollars: number, downDollars: number): string {
  return p.buyHome({
    month,
    ownerId: P1,
    purchasePriceCents: dollarsToCents(priceDollars),
    downPaymentCents: dollarsToCents(downDollars),
    downPaymentSourceIds: ["savings"],
    mortgageApr: 0.06,
    mortgageTermMonths: 360,
  });
}

describe("Projection.run().series.obligationOutcomes — actual resolution order, not month position", () => {
  it("reports A executed, B blocked, a same-month C not-reached, and a later D not-reached — with provenance", () => {
    const p = freshProjection();
    // Ledger order: A ($5k down, affordable alone), B ($80k down, the blocker), C ($10k down, same
    // month as B but authored after it), D ($10k down, two months later). $50k opening savings
    // covers A but leaves $45k — short of B's $80k.
    const a = buy(p, BLOCK_MONTH, 20_000, 5_000);
    const b = buy(p, BLOCK_MONTH, 400_000, 80_000);
    const c = buy(p, BLOCK_MONTH, 50_000, 10_000);
    const d = buy(p, BLOCK_MONTH + 2, 50_000, 10_000);
    // The plan edit that strands B (and, as its consequence, C and D): nothing that re-litigates
    // any purchase, exactly the seam the app drives through the opening-balance field.
    p.updatePlan({ openingBalanceCents: dollarsToCents(50_000) });

    const { series } = p.run(nullJurisdiction);
    expect(series.status).toBe("blocked");
    expect(series.blockedAtMonth).toBe(BLOCK_MONTH);
    const blockingObligationId = series.blockingObligation?.obligationId;
    expect(blockingObligationId).toBeDefined();

    // Provenance is explicit on the public result — no obligationId parsing required to recover
    // which event each outcome belongs to, and every outcome's own `sourceEventId` names its
    // authoring purchase.
    const byEvent = new Map(
      Object.values(series.obligationOutcomes)
        .filter((o) => o.sourceEventId !== undefined)
        .map((o) => [o.sourceEventId!, o]),
    );

    expect(byEvent.get(a)).toMatchObject({ status: "executed", sourceEventId: a });
    expect(byEvent.get(b)).toMatchObject({ status: "blocked", sourceEventId: b, month: BLOCK_MONTH });
    // C sits in the SAME month as the blocker but was authored after it — resolution stopped
    // before reaching it, so it reads `not-reached`, identically to D authored two months later,
    // never `executed`.
    expect(byEvent.get(c)).toMatchObject({
      status: "not-reached",
      sourceEventId: c,
      blockedByObligationId: blockingObligationId,
    });
    expect(byEvent.get(d)).toMatchObject({
      status: "not-reached",
      sourceEventId: d,
      blockedByObligationId: blockingObligationId,
    });
  });
});
