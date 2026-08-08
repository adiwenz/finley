/**
 * @vitest-environment node
 *
 * **The blocked-purchase QA script, executed.** A household authors home purchases it can afford,
 * a later edit drains the account they named, and the projection blocks. Every step goes through
 * the public `Projection` API exactly as the UI drives it — `buyHome`, then an `updatePlan` opening
 * -balance edit — and is solved against the real US jurisdiction.
 *
 * The engine pins the block itself and its same-month suppression at `projection/simulate.blocking
 * .test.ts`; the public outcome contract (executed/blocked/not-reached, with provenance) is
 * `projectionFacade.blockedOutcomes.test.ts`'s job. The per-surface presentation mappings
 * (`timelineMarkers`, `blockedWarning`, the chart's blocked marker, `retirementView`'s blocked
 * state) each have their own dedicated, stub-driven tests. What none of those can see is the JOIN:
 * a real household authoring two same-month purchases through the public API, a plan edit
 * stranding them, and every one of those surfaces agreeing about what happened — without this test
 * re-deriving the engine's own math or re-asserting a mapping already pinned elsewhere.
 */

import { describe, it, expect } from "vitest";
import { Projection, PRIMARY_PERSON_ID, dollarsToCents } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { DEFAULT_INPUT } from "./planDefaults";
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

/** One financed purchase, paid from savings — the drain order the picker writes. */
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

describe("a purchase stranded by a later edit — every surface agrees about what happened", () => {
  it("wires a blocked, same-month-suppressed purchase through the warning, timeline, chart, and retirement panel", () => {
    const p = household(OPENING_WHEN_AUTHORED);
    // Both are affordable as authored. The edit that strands them is the opening-balance field,
    // nothing that re-litigates a purchase.
    const first = buyHome(p, 500_000, 200_000);
    const second = buyHome(p, 300_000, 60_000);
    p.updatePlan({ openingBalanceCents: OPENING_AFTER_EDIT });
    const series = p.run(usJurisdiction).series;

    // The warning names the actual blocking purchase in plain language.
    const warning = blockedWarning(p.ledger, series);
    expect(warning?.eventLabel).toBe("Bought a home");
    expect(warning?.month).toBe(BUY_MONTH);

    // The timeline agrees: the first purchase is the block, the same-month second is not-reached —
    // never `executed`, since its draw never resolved.
    const outcome = new Map(timelineMarkers(p.ledger, series).map((m) => [m.id, m.outcome]));
    expect(outcome.get(first)).toBe("blocked");
    expect(outcome.get(second)).toBe("not-reached");

    // The chart's terminal marker is built from this real series, not a hand-made one.
    const chart = buildNetWorthChartData(series);
    expect(chart.blocked?.x).toBe(toAxisX(BUY_MONTH));

    // The retirement panel's block state is wired to the same run.
    expect(retirementView(p, usJurisdiction).blocked).toBe(true);
  });
});
