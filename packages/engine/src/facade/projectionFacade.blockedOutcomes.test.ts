/**
 * `ProjectionSeries.obligationOutcomes` as the public `Projection` facade reports it — the
 * consumer-visible seam the app's timeline/warning read. Authored entirely through `Projection`
 * (`buyHome`, `updatePlan`), never through simulator internals, since what matters here is what a
 * caller of the public API actually sees.
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
  it("reports A executed, B blocked, a same-month C not-reached, and a later D not-reached", () => {
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

    const outcomes = series.obligationOutcomes;
    const byEvent = new Map(
      Object.values(outcomes)
        .filter((o) => o.sourceEventId !== undefined)
        .map((o) => [o.sourceEventId!, o]),
    );

    expect(byEvent.get(a)?.status).toBe("executed");
    expect(byEvent.get(b)?.status).toBe("blocked");
    expect(byEvent.get(c)?.status).toBe("not-reached");
    expect(byEvent.get(d)?.status).toBe("not-reached");

    // Provenance is explicit on the public result — no obligationId parsing required to recover
    // which event each outcome belongs to.
    expect(byEvent.get(a)?.sourceEventId).toBe(a);
    expect(byEvent.get(b)?.sourceEventId).toBe(b);
    expect(byEvent.get(c)?.sourceEventId).toBe(c);
    expect(byEvent.get(d)?.sourceEventId).toBe(d);

    // The claim is grounded in what actually happened: A's home stands, B/C/D's do not — an
    // obligation is never reported executed while its artifacts were omitted.
    const blocked = series.months[BLOCK_MONTH];
    const homeIdOf = (eventId: string) => {
      const event = p.state.scenario.ledger.events.find((e) => e.id === eventId);
      if (event?.type !== "HomePurchaseEvent") throw new Error(`expected a home purchase for ${eventId}`);
      return event.propertyId;
    };
    expect(blocked.propertyValuesCents[homeIdOf(a)]).toBeGreaterThan(0);
    for (const eventId of [b, c, d]) {
      expect(blocked.propertyValuesCents[homeIdOf(eventId)] ?? 0).toBe(0);
    }
  });
});
