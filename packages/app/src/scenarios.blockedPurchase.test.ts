/**
 * @vitest-environment node
 *
 * **The blocked-purchase QA script, executed.** A household authors home purchases it can afford,
 * a later edit drains the account they named, and the projection blocks. Every step goes through
 * the public `Projection` API exactly as the UI drives it — `buyHome`, then an `updatePlan` opening
 * -balance edit — and is solved against the real US jurisdiction.
 *
 * The engine pins this behaviour per seam (`projection/simulate.blocking.test.ts` for the block and
 * its suppression, `events.homePurchase.test.ts` for the ledger path). What those cannot see is the
 * JOIN: the authoring gate accepting both purchases, a plan edit stranding them afterwards, and the
 * two surfaces that then have to tell the household — the retirement view and the net-worth chart.
 * An engine that suppresses correctly and a chart that draws correctly could still be wired to a
 * plan edit that never reaches either, and every per-seam test would stay green.
 *
 * The load-bearing case is the SECOND purchase. A block stops funding resolution for the rest of
 * the month, so a later same-month purchase's down payment is never withdrawn either — and its
 * property and mortgage are originated by a step separate from that draw. Suppressing only the
 * blocking event minted that second house and its loan against cash that never moved.
 */

import { describe, it, expect } from "vitest";
import { Projection, PRIMARY_PERSON_ID, dollarsToCents } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { DEFAULT_INPUT } from "./planDefaults";
import { START_YEAR } from "./config";
import { retirementView } from "./retirementView";
import { blockedWarning, timelineMarkers } from "./ledgerView";
import { buildNetWorthChartData } from "./components/netWorthChart/netWorthChartData";
import { toAxisX } from "./components/monthAxis";

/** Every purchase below is authored here, and the block lands here. */
const BUY_MONTH = 12;
/** Funded enough that both purchases pass the §4.5 gate when authored. */
const OPENING_WHEN_AUTHORED = dollarsToCents(400_000);
/** The later edit that strands them: too little for the first down payment, let alone both. */
const OPENING_AFTER_EDIT = dollarsToCents(60_000);

/** The default plan a fresh session opens on, at a stated opening balance. */
function household(openingBalanceCents: number): Projection {
  const built = Projection.fromInput({ ...DEFAULT_INPUT, openingBalanceCents }, usJurisdiction);
  if (!built.ok) throw new Error(`fixture is not a valid ScenarioInput: ${built.error.reason}`);
  return built.projection;
}

/**
 * One financed purchase at {@link BUY_MONTH}, paid from savings — the drain order the picker
 * writes. Returns the minted event id, which is what the omitted set is keyed on.
 */
function buyHome(p: Projection, priceDollars: number, downDollars: number): string {
  return p.buyHome({
    month: BUY_MONTH,
    ownerId: PRIMARY_PERSON_ID,
    purchasePriceCents: dollarsToCents(priceDollars),
    downPaymentCents: dollarsToCents(downDollars),
    downPaymentSourceIds: ["savings"],
    mortgageApr: 0.06,
    mortgageTermMonths: 360,
  });
}

/** The liability id `buyHome` minted alongside `homeId` — authored, not derived from it. */
function mortgageIdOf(p: Projection, homeId: string): string {
  const event = p.ledger.events.find((e) => e.id === homeId);
  const mortgageId = event?.type === "HomePurchaseEvent" ? event.mortgage?.liabilityId : undefined;
  if (mortgageId === undefined) throw new Error(`expected "${homeId}" to carry a mortgage`);
  return mortgageId;
}

describe("a purchase stranded by a later edit — what the projection does with it", () => {
  it("originates NEITHER of two same-month homes when the first cannot be funded", () => {
    const p = household(OPENING_WHEN_AUTHORED);
    // Both are affordable as authored: $200k leaves plenty, and the second is gated against what
    // the first leaves behind. Neither is a purchase the household was ever told it could not make.
    const first = buyHome(p, 500_000, 200_000);
    const second = buyHome(p, 300_000, 60_000);
    // The edit that strands them — the opening-balance field, nothing that re-litigates a purchase.
    p.updatePlan({ openingBalanceCents: OPENING_AFTER_EDIT });

    const series = p.run(usJurisdiction).series;
    expect(series.status).toBe("blocked");
    expect(series.blockedAtMonth).toBe(BUY_MONTH);

    // Reporting names the FIRST purchase and states ITS gap: the second was never priced against
    // its sources, so nothing claims it was unaffordable — only that it did not happen.
    expect(series.blockingObligation?.sourceEventId).toBe(first);
    expect(series.blockingObligation?.requiredCents).toBe(dollarsToCents(200_000));
    // ...while BOTH events are reported omitted, the blocker first.
    expect(series.omittedSourceEventIds).toEqual([first, second]);

    const blocked = series.months[BUY_MONTH]!;
    // Neither home, neither mortgage. The second is the regression: its draw was skipped, so its
    // artifacts are fabrication — a $300k property and a $240k loan against cash that never moved.
    expect(blocked.propertyValuesCents[first] ?? 0).toBe(0);
    expect(blocked.propertyValuesCents[second] ?? 0).toBe(0);
    expect(blocked.liabilityBalancesCents[mortgageIdOf(p, first)] ?? 0).toBe(0);
    expect(blocked.liabilityBalancesCents[mortgageIdOf(p, second)] ?? 0).toBe(0);

    // The sharpest statement of "no money moved and nothing was minted": the blocked month is
    // INDISTINGUISHABLE from the same household having authored no purchase at all. Written as a
    // comparison rather than as pinned cents so it survives any change to the plan's scalars —
    // what is asserted is the equality, not the dollar figure.
    const untouched = household(OPENING_AFTER_EDIT).run(usJurisdiction).series.months[BUY_MONTH]!;
    expect(blocked.accountBalancesCents).toEqual(untouched.accountBalancesCents);
    expect(blocked.netWorthNominalCents).toBe(untouched.netWorthNominalCents);

    // The timeline's claim has to agree with what actually happened: the SECOND purchase sits in
    // the same month as the blocker, but its draw never resolved, so it reads `not-reached` — never
    // `executed` — exactly like the artifacts above already show. Read off the public engine
    // output only; nothing here parses an obligation id to make the join.
    const outcome = new Map(timelineMarkers(p.ledger, series).map((m) => [m.id, m.outcome]));
    expect(outcome.get(first)).toBe("blocked");
    expect(outcome.get(second)).toBe("not-reached");
  });

  it("keeps an EARLIER same-month home whose down payment did resolve", () => {
    const p = household(OPENING_WHEN_AUTHORED);
    // A modest purchase resolves first and really does spend its money; the second blocks.
    // Suppression is keyed on the draws that were SKIPPED, so it must not reach back over this one.
    const funded = buyHome(p, 100_000, 10_000);
    const stranded = buyHome(p, 500_000, 200_000);
    p.updatePlan({ openingBalanceCents: OPENING_AFTER_EDIT });

    const series = p.run(usJurisdiction).series;
    expect(series.status).toBe("blocked");
    expect(series.blockingObligation?.sourceEventId).toBe(stranded);
    expect(series.omittedSourceEventIds).toEqual([stranded]);

    const blocked = series.months[BUY_MONTH]!;
    expect(blocked.propertyValuesCents[funded]).toBe(dollarsToCents(100_000));
    expect(blocked.liabilityBalancesCents[mortgageIdOf(p, funded)]).toBe(dollarsToCents(90_000));
    expect(blocked.propertyValuesCents[stranded] ?? 0).toBe(0);
    expect(blocked.liabilityBalancesCents[mortgageIdOf(p, stranded)] ?? 0).toBe(0);
    // Its down payment left the account, unlike the stranded pair's.
    const untouched = household(OPENING_AFTER_EDIT).run(usJurisdiction).series.months[BUY_MONTH]!;
    expect(blocked.accountBalancesCents.savings).toBeLessThan(
      untouched.accountBalancesCents.savings! - dollarsToCents(9_000),
    );
  });

  it("tells the household it is blocked, and marks the chart where the projection stopped", () => {
    const p = household(OPENING_WHEN_AUTHORED);
    buyHome(p, 500_000, 200_000);
    buyHome(p, 300_000, 60_000);
    p.updatePlan({ openingBalanceCents: OPENING_AFTER_EDIT });
    const series = p.run(usJurisdiction).series;

    // The retirement panel's third state: not "no age works" (which asks the household to retire
    // later), but "the projection stopped" (which asks them to fund the obligation differently).
    const view = retirementView(p, usJurisdiction);
    expect(view.blocked).toBe(true);
    expect(view.blockedAtAge).toBe(
      START_YEAR - DEFAULT_INPUT.birthYear + BUY_MONTH / 12,
    );

    // The chart's terminal marker, built from this real series rather than a hand-made one.
    const chart = buildNetWorthChartData(series);
    expect(chart.blocked?.x).toBe(toAxisX(BUY_MONTH));
    expect(chart.blocked?.requiredCents).toBe(dollarsToCents(200_000));
    expect(chart.blocked?.shortfallCents).toBe(series.blockingObligation!.shortfallCents);
    // The marker's y is READ from the engine, never recomputed in the app.
    expect(chart.blocked?.netWorthCents).toBe(series.blockingObligation!.markerNetWorthCents);
    // Nothing is plotted past the block.
    expect(Math.max(...chart.points.map((pt) => pt.x))).toBe(toAxisX(BUY_MONTH));
  });

  it("warns naming the stranded purchase and its month, and marks every later event not-reached", () => {
    const p = household(OPENING_WHEN_AUTHORED);
    const stranded = buyHome(p, 500_000, 200_000);
    // A second purchase authored strictly AFTER the block — the simulation stops before reaching it.
    const later = p.buyHome({
      month: 60,
      ownerId: PRIMARY_PERSON_ID,
      purchasePriceCents: dollarsToCents(300_000),
      downPaymentCents: dollarsToCents(60_000),
      downPaymentSourceIds: ["savings"],
      mortgageApr: 0.06,
      mortgageTermMonths: 360,
    });
    p.updatePlan({ openingBalanceCents: OPENING_AFTER_EDIT });
    const series = p.run(usJurisdiction).series;

    // The warning the household actually reads: the purchase in plain language, the month it was
    // scheduled for, and the engine's bare (already post-tax) shortfall — a stop, not advice.
    const warning = blockedWarning(p.ledger, series);
    expect(warning?.eventLabel).toBe("Bought a home");
    expect(warning?.month).toBe(BUY_MONTH);
    expect(warning?.shortfallCents).toBe(series.blockingObligation!.shortfallCents);

    // The timeline reads the same stop: the blocker is blocked, and the purchase after it — which
    // the stopped simulation never tested — is not-reached.
    const outcome = new Map(timelineMarkers(p.ledger, series).map((m) => [m.id, m.outcome]));
    expect(outcome.get(stranded)).toBe("blocked");
    expect(outcome.get(later)).toBe("not-reached");
  });
});
