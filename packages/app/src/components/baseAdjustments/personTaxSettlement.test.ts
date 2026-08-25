/**
 * April, per person — who paid the bill and who got the money back.
 *
 * The household files as separate single filers, so an April is never one figure. It is one
 * balance per person, and the two can point opposite ways: a partner whose pay stopped mid-year
 * is refunded the withholding they no longer owed, in the same month the other partner settles a
 * bill on interest nothing withheld against. The chart's job is to show each of those to the
 * person it happened to, and to keep the two cuts summing to the household's.
 *
 * The bug these exist against banded the refund to the HOUSEHOLD: it appeared under Combined and
 * vanished from both people's cuts, so the one question the toggle is for — who got the $3,708?
 * — had no answer anywhere on the chart.
 */

import { describe, expect, it } from "vitest";
import {
  Projection,
  dollarsToCents,
  type ProjectionCashFlowIncomeSource,
  type ProjectionSeries,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { presetById, presetState } from "../../presets";
import {
  SHARED_SPENDING_BAND_ID,
  TAX_INCOME_BAND_ID,
  TAX_PAYROLL_BAND_ID,
  TAX_SETTLEMENT_BAND_ID,
  buildCashFlowChartData,
  cashFlowBandsForView,
  refundBandId,
} from "./cashFlowChartData";

const ALEX = "p1";
const BLAKE = "p2";
const NAMES = new Map([
  [ALEX, "Alex"],
  [BLAKE, "Blake"],
]);

interface AprilSpec {
  /** SIGNED per person: positive is their bill, negative is their refund. */
  readonly settlementByPerson: Record<string, number>;
  /** Withholding per source, INCLUDING the settlement — the shape the engine reports. */
  readonly taxBySource?: Record<string, number>;
  readonly settlementBySource?: Record<string, number>;
  readonly chargedByPerson?: Record<string, number>;
}

/**
 * One flowed month shaped like the engine's April: `taxCents` carries the month's withholding
 * plus the signed settlement, exactly as the simulator reports it, so the chart's own
 * subtraction is the one under test rather than a tidied fixture.
 */
function aprilOf(spec: AprilSpec): ProjectionSeries {
  const settlement = Object.values(spec.settlementByPerson).reduce((s, c) => s + c, 0);
  const taxBySourceCents = spec.taxBySource ?? {};
  const withholding = Object.values(taxBySourceCents).reduce((s, c) => s + c, 0);
  const owned = (sourceId: string, ownerId: string, cents: number): ProjectionCashFlowIncomeSource =>
    ({
      sourceId,
      label: sourceId,
      category: "wages",
      ownerId,
      cashInflowCents: cents,
      netCashFlowCents: cents,
    }) as ProjectionCashFlowIncomeSource;
  return {
    months: [
      { month: 0 },
      {
        month: 1,
        flows: {
          incomeSources: [owned("alex-job", ALEX, dollarsToCents(8_000)), owned("blake-job", BLAKE, 0)],
          obligations: [
            {
              id: "line:rent",
              label: "Rent",
              category: "needs",
              amountCents: dollarsToCents(3_000),
              funding: { kind: "automatic" },
            },
          ],
          taxCents: withholding,
          payrollTaxCents: 0,
          payrollTaxBySourceCents: {},
          taxBySourceCents,
          taxSettlementCents: settlement,
          taxSettlementBySourceCents: spec.settlementBySource ?? {},
          taxSettlementByPersonCents: spec.settlementByPerson,
          expensesCents: dollarsToCents(3_000),
          liabilityPaymentsCents: 0,
          netCashFlowByPersonCents: {},
          deferredByPersonCents: {},
          obligationChargedByPersonCents:
            spec.chargedByPerson ?? { [ALEX]: dollarsToCents(3_000), [BLAKE]: 0 },
        },
      },
    ],
  } as unknown as ProjectionSeries;
}

/** What one person's cut of one view actually stacks, by band id. */
function cutOf(series: ProjectionSeries, view: "inflows" | "outflows", ownerId?: string) {
  const data = buildCashFlowChartData(series);
  const folded = cashFlowBandsForView(data, view, "advanced", NAMES, ownerId);
  return folded.rows.find((r) => r.month === 1)!.centsByBand;
}

describe("April's settlement, per filer", () => {
  it("bands a refund to the person refunded, and their partner's bill to them", () => {
    const april = aprilOf({
      settlementByPerson: { [ALEX]: dollarsToCents(7_460), [BLAKE]: -dollarsToCents(3_708) },
      taxBySource: { "alex-job": dollarsToCents(8_460), "blake-job": -dollarsToCents(3_708) },
      settlementBySource: { "alex-job": dollarsToCents(7_460), "blake-job": -dollarsToCents(3_708) },
    });

    expect(cutOf(april, "inflows", BLAKE)[refundBandId(BLAKE)]).toBe(dollarsToCents(3_708));
    expect(cutOf(april, "inflows", ALEX)[refundBandId(BLAKE)]).toBeUndefined();

    // Alex's bill is Alex's WHOLE bill: nothing about Blake's refund reduces or reassigns it.
    expect(cutOf(april, "outflows", ALEX)[TAX_SETTLEMENT_BAND_ID]).toBe(dollarsToCents(7_460));
    expect(cutOf(april, "outflows", BLAKE)[TAX_SETTLEMENT_BAND_ID]).toBeUndefined();

    // And the household still states both gross figures, neither netted into the other.
    expect(cutOf(april, "inflows")[refundBandId(BLAKE)]).toBe(dollarsToCents(3_708));
    expect(cutOf(april, "outflows")[TAX_SETTLEMENT_BAND_ID]).toBe(dollarsToCents(7_460));
  });

  it("holds the other way round, with the primary refunded", () => {
    const april = aprilOf({
      settlementByPerson: { [ALEX]: -dollarsToCents(1_200), [BLAKE]: dollarsToCents(900) },
      taxBySource: { "alex-job": -dollarsToCents(1_200), "blake-job": dollarsToCents(900) },
      settlementBySource: { "alex-job": -dollarsToCents(1_200), "blake-job": dollarsToCents(900) },
    });

    expect(cutOf(april, "inflows", ALEX)[refundBandId(ALEX)]).toBe(dollarsToCents(1_200));
    expect(cutOf(april, "inflows", BLAKE)[refundBandId(ALEX)]).toBeUndefined();
    expect(cutOf(april, "outflows", BLAKE)[TAX_SETTLEMENT_BAND_ID]).toBe(dollarsToCents(900));
    expect(cutOf(april, "outflows", ALEX)[TAX_SETTLEMENT_BAND_ID]).toBeUndefined();
  });

  it("bands two refunds separately, and names each one for its filer", () => {
    const april = aprilOf({
      settlementByPerson: { [ALEX]: -dollarsToCents(500), [BLAKE]: -dollarsToCents(300) },
    });
    const combined = cutOf(april, "inflows");

    expect(combined[refundBandId(ALEX)]).toBe(dollarsToCents(500));
    expect(combined[refundBandId(BLAKE)]).toBe(dollarsToCents(300));
    // One legend entry repeated is unreadable, so two refunds on one chart carry their names.
    const bands = cashFlowBandsForView(buildCashFlowChartData(april), "inflows", "advanced", NAMES).bands;
    expect(bands.filter((b) => b.id.startsWith("tax-refund")).map((b) => b.label)).toEqual([
      "Tax refund · Alex",
      "Tax refund · Blake",
    ]);
    // Nobody paid anything, so no settlement band is drawn at all.
    expect(cutOf(april, "outflows")[TAX_SETTLEMENT_BAND_ID]).toBeUndefined();
  });

  it("names a lone refund plainly, and still bands it to its filer", () => {
    const april = aprilOf({ settlementByPerson: { [BLAKE]: -dollarsToCents(3_708) } });
    const bands = cashFlowBandsForView(buildCashFlowChartData(april), "inflows", "advanced", NAMES).bands;

    expect(bands.filter((b) => b.id.startsWith("tax-refund")).map((b) => b.label)).toEqual(["Tax refund"]);
    expect(cutOf(april, "inflows", BLAKE)[refundBandId(BLAKE)]).toBe(dollarsToCents(3_708));
    expect(cutOf(april, "inflows", ALEX)[refundBandId(BLAKE)]).toBeUndefined();
  });

  it("keeps each person's withholding and FICA their own", () => {
    const april = aprilOf({
      settlementByPerson: { [ALEX]: dollarsToCents(7_460), [BLAKE]: -dollarsToCents(3_708) },
      taxBySource: { "alex-job": dollarsToCents(8_460), "blake-job": -dollarsToCents(3_708) },
      settlementBySource: { "alex-job": dollarsToCents(7_460), "blake-job": -dollarsToCents(3_708) },
    });

    // $8,460 charged less the $7,460 that settled last year is the $1,000 this month withheld.
    expect(cutOf(april, "outflows", ALEX)[TAX_INCOME_BAND_ID]).toBe(dollarsToCents(1_000));
    // Blake's whole charge WAS the refund, so Blake withheld nothing rather than a negative.
    expect(cutOf(april, "outflows", BLAKE)[TAX_INCOME_BAND_ID]).toBeUndefined();
    expect(cutOf(april, "outflows", BLAKE)[TAX_PAYROLL_BAND_ID]).toBeUndefined();
  });

  it("states each person's share of the shared spending instead of the lines themselves", () => {
    const april = aprilOf({
      settlementByPerson: { [ALEX]: dollarsToCents(7_460), [BLAKE]: -dollarsToCents(3_708) },
      chargedByPerson: { [ALEX]: dollarsToCents(1_800), [BLAKE]: dollarsToCents(1_200) },
    });

    expect(cutOf(april, "outflows", ALEX)[SHARED_SPENDING_BAND_ID]).toBe(dollarsToCents(1_800));
    expect(cutOf(april, "outflows", BLAKE)[SHARED_SPENDING_BAND_ID]).toBe(dollarsToCents(1_200));
    // The household draws the real line; the shares are the same money asked about differently.
    expect(cutOf(april, "outflows")["line:rent"]).toBe(dollarsToCents(3_000));
    expect(cutOf(april, "outflows")[SHARED_SPENDING_BAND_ID]).toBeUndefined();
  });
});

/**
 * The reported bug, end to end: the real engine, the real jurisdiction, and the preset and edits
 * it was reported against. Blake earns $10,000/mo, stops in month 6, and is refunded the
 * withholding that assumed a whole year of it; Alex's $500,000 of cash at 7% throws off interest
 * nothing withholds against, and settles a bill in the same April.
 */
describe("Two incomes, one household — one partner refunded while the other owes", () => {
  const BLAKE_ENGINE_ID = "person-8";
  const APRIL = 15;

  function reported(): ProjectionSeries {
    const p = Projection.fromState(presetState(presetById("partner-uneven-split")), usJurisdiction);
    p.updatePlan({ openingBalanceCents: dollarsToCents(500_000), savingsReturnPct: 7 });
    p.replacePartnerJob("job-9", {
      startYear: 2009,
      endYear: 2056,
      salary: {
        // Authored annually; $10,000 a month is what the pay editor shows and edits.
        startingSalaryCents: dollarsToCents(120_000),
        currentSalaryCents: dollarsToCents(120_000),
        realGrowthPct: 0,
      },
    });
    p.addJobPayChange("job-9", { month: 6, kind: "setTo", cents: 0 });
    return p.run(usJurisdiction).series;
  }

  const series = reported();
  const data = buildCashFlowChartData(series);
  const bandsAt = (view: "inflows" | "outflows", ownerId?: string) =>
    cashFlowBandsForView(data, view, "advanced", NAMES, ownerId).rows.find((r) => r.month === APRIL)!
      .centsByBand;

  const REFUND = 370_313;
  const ALEX_SETTLEMENT = 739_788;

  it("shows Blake the refund Blake received", () => {
    expect(bandsAt("inflows", BLAKE_ENGINE_ID)[refundBandId(BLAKE_ENGINE_ID)]).toBe(REFUND);
  });

  it("keeps it out of Alex's cut, and out of Alex's April bill", () => {
    expect(bandsAt("inflows", ALEX)[refundBandId(BLAKE_ENGINE_ID)]).toBeUndefined();
    expect(bandsAt("outflows", ALEX)[TAX_SETTLEMENT_BAND_ID]).toBe(ALEX_SETTLEMENT);
    expect(bandsAt("outflows", BLAKE_ENGINE_ID)[TAX_SETTLEMENT_BAND_ID]).toBeUndefined();
  });

  it("leaves the combined view showing the same refund it always did", () => {
    expect(bandsAt("inflows")[refundBandId(BLAKE_ENGINE_ID)]).toBe(REFUND);
    expect(bandsAt("outflows")[TAX_SETTLEMENT_BAND_ID]).toBe(ALEX_SETTLEMENT);
  });

  it("changes what Going out says when the reader picks a person", () => {
    // The other half of the report: the outflow view answered every filter with the household's
    // own stack, so all three cuts drew the same figures.
    const combined = bandsAt("outflows");
    expect(bandsAt("outflows", ALEX)).not.toEqual(combined);
    expect(bandsAt("outflows", BLAKE_ENGINE_ID)).not.toEqual(combined);
    expect(bandsAt("outflows", ALEX)).not.toEqual(bandsAt("outflows", BLAKE_ENGINE_ID));
  });

  it("does not move the household's spending onto Blake for the month Alex files", () => {
    // The other thing April was doing to this scenario: Alex's bill took their take-home
    // negative, and a split weighed on charged take-home read that as Blake — who earns nothing —
    // being the household's sole earner for one month, so the whole $5,562 budget jumped to Blake
    // and jumped back in May. The split is now a number the household wrote, so April, March and
    // May are the identical 70/30 to the cent.
    const spendAt = (month: number, ownerId: string) =>
      cashFlowBandsForView(data, "outflows", "advanced", NAMES, ownerId).rows.find(
        (r) => r.month === month,
      )!.centsByBand[SHARED_SPENDING_BAND_ID] ?? 0;
    for (const month of [APRIL - 1, APRIL, APRIL + 1]) {
      expect(spendAt(month, ALEX)).toBe(spendAt(APRIL, ALEX));
      expect(spendAt(month, ALEX) + spendAt(month, BLAKE_ENGINE_ID)).toBe(556_200);
      expect(spendAt(month, BLAKE_ENGINE_ID) / 556_200).toBeCloseTo(0.3, 4);
    }
  });

  it("reconciles the two cuts with the household's, every month", () => {
    const wrong: string[] = [];
    for (const row of data.rows) {
      const cuts = Object.values(row.outflowCentsByBandByPerson);
      const settled = cuts.reduce((s, byBand) => s + (byBand[TAX_SETTLEMENT_BAND_ID] ?? 0), 0);
      const refunded = Object.entries(row.inflowCentsByBand)
        .filter(([id]) => id.startsWith("tax-refund"))
        .reduce((s, [, c]) => s + c, 0);
      const household = row.outflowCentsByBand[TAX_SETTLEMENT_BAND_ID] ?? 0;
      if (settled !== household) wrong.push(`month ${row.month}: settled ${settled} vs ${household}`);
      // The signed household figure is what is left once the gross halves are set against
      // each other — the netting the person cuts exist to avoid doing first.
      if (settled - refunded !== (series.months[row.month]?.flows?.taxSettlementCents ?? 0)) {
        wrong.push(`month ${row.month}: ${settled} − ${refunded} is not the net settlement`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("closes each person's month: what arrived, less what they were charged, is their net", () => {
    // The identity that makes the toggle safe to read — a person's stack is not a slice of the
    // household's, it is their own arithmetic, and it lands on the engine's own net figure.
    //
    // Asserted on THIS scenario rather than on every preset because the chart deliberately bands
    // no account withdrawal as an inflow while the engine's take-home counts a person's own
    // draw: a retiree living off an IRA closes the month by the size of that draw, by design.
    // Nobody here draws their own account, so the two sides have to meet to the cent.
    const wrong: string[] = [];
    for (const row of data.rows) {
      for (const personId of Object.keys(row.netCentsByPerson)) {
        const inflow = Object.entries(row.inflowCentsByBand)
          .filter(([, c]) => c > 0)
          .reduce((s, [id, c]) => s + (bandOwner(data, id) === personId ? c : 0), 0);
        const outflow = Object.values(row.outflowCentsByBandByPerson[personId] ?? {}).reduce(
          (s, c) => s + c,
          0,
        );
        if (inflow - outflow !== row.netCentsByPerson[personId]) {
          wrong.push(
            `month ${row.month} · ${personId}: ${inflow} − ${outflow} vs ${row.netCentsByPerson[personId]}`,
          );
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});

/** Which person an inflow band pays, or `undefined` for a household one. */
function bandOwner(data: ReturnType<typeof buildCashFlowChartData>, bandId: string): string | undefined {
  return data.inflowBands.find((b) => b.id === bandId)?.ownerId;
}

describe("a partner who leaves before the filing", () => {
  it("settles the April they were here for between both, and the next one for Alex alone", () => {
    // Blake leaves at month 60. The April inside their last full tax year splits two ways; the
    // one after they are gone is the remaining filer's whole bill, never redistributed.
    const series = Projection.fromState(presetState(presetById("partner-separation")), usJurisdiction)
      .run(usJurisdiction).series;
    const data = buildCashFlowChartData(series);
    const cut = (month: number, ownerId?: string) =>
      cashFlowBandsForView(data, "outflows", "advanced", NAMES, ownerId).rows.find(
        (r) => r.month === month,
      )!.centsByBand;

    const together = data.rows.find((r) => r.month === 51)!;
    const settledTogether = Object.values(together.outflowCentsByBandByPerson).filter(
      (byBand) => (byBand[TAX_SETTLEMENT_BAND_ID] ?? 0) > 0,
    );
    expect(settledTogether).toHaveLength(2);
    expect(cut(51, "p1")[TAX_SETTLEMENT_BAND_ID]! + cut(51, "person-8")[TAX_SETTLEMENT_BAND_ID]!).toBe(
      together.outflowCentsByBand[TAX_SETTLEMENT_BAND_ID],
    );

    const alone = data.rows.find((r) => r.month === 63)!;
    expect(Object.keys(alone.outflowCentsByBandByPerson)).toEqual(["p1"]);
    expect(cut(63, "p1")[TAX_SETTLEMENT_BAND_ID]).toBe(
      alone.outflowCentsByBand[TAX_SETTLEMENT_BAND_ID],
    );
  });
});

/**
 * A band nobody can see is not a band. The lists are already cut to what carried something at the
 * CENT, which left a real preset with a "Tax refund" band peaking at six cents — a legend entry, a
 * flat-zero area, and a `$0` row under every reading of both the combined table and Blake's. The
 * test is the rounding the table itself prints with, so a band survives exactly when some month
 * of it shows a figure.
 */
describe("a refund too small to print", () => {
  const bandsOf = (series: ProjectionSeries, ownerId?: string) =>
    cashFlowBandsForView(buildCashFlowChartData(series), "inflows", "advanced", NAMES, ownerId).bands;

  it("drops a refund that rounds to $0 in every month it exists", () => {
    const april = aprilOf({ settlementByPerson: { [BLAKE]: -6 } });
    expect(bandsOf(april).filter((b) => b.id.startsWith("tax-refund"))).toEqual([]);
    expect(bandsOf(april, BLAKE).filter((b) => b.id.startsWith("tax-refund"))).toEqual([]);
    // The cents are still in the row: the money was real, only too small to draw, and taking it
    // out of the totals would stop the rows adding up to the month.
    expect(cutOf(april, "inflows", BLAKE)[refundBandId(BLAKE)]).toBe(6);
  });

  it("keeps a refund of half a dollar, which the table does print", () => {
    // The threshold is `formatDollars`' own rounding and not a tolerance invented here: 50 cents
    // prints as $1, so it is a band.
    const april = aprilOf({ settlementByPerson: { [BLAKE]: -50 } });
    expect(bandsOf(april).map((b) => b.id)).toContain(refundBandId(BLAKE));
  });

  it("clears the six-cent refund out of the preset it was reported in", () => {
    // "Two incomes, one household", where Blake's largest refund across the whole horizon is $0.06
    // — enough for the band to exist, never enough for a row to show anything.
    const series = Projection.fromState(
      presetState(presetById("partner-even-split")),
      usJurisdiction,
    ).run(usJurisdiction).series;
    const names = new Map([
      ["p1", "Alex"],
      ["person-8", "Blake"],
    ]);
    for (const owner of [undefined, "p1", "person-8"]) {
      const folded = cashFlowBandsForView(
        buildCashFlowChartData(series),
        "inflows",
        "advanced",
        names,
        owner,
      );
      expect(folded.bands.filter((b) => b.id.startsWith("tax-refund"))).toEqual([]);
    }
  });

  it("still draws a partner's real refund, and still under their own name", () => {
    const april = aprilOf({
      settlementByPerson: { [ALEX]: dollarsToCents(7_460), [BLAKE]: -dollarsToCents(3_708) },
    });
    // Combined and Blake's cut both carry it; Alex's does not, because it was never Alex's.
    expect(bandsOf(april).map((b) => b.id)).toContain(refundBandId(BLAKE));
    expect(bandsOf(april, BLAKE).map((b) => b.id)).toContain(refundBandId(BLAKE));
    expect(bandsOf(april, ALEX).map((b) => b.id)).not.toContain(refundBandId(BLAKE));
    expect(cutOf(april, "inflows", BLAKE)[refundBandId(BLAKE)]).toBe(dollarsToCents(3_708));
  });
});

/**
 * The third of the three concepts the engine keeps apart — who FUNDED a bill, as against whose
 * bill it is. The household helps a member who cannot cover their own month, and the settlement
 * diagnostic must go on explaining that member's balance with that member's own income: an April
 * paid for out of a partner's paycheck is still not the partner's April.
 */
describe("a bill the household helped pay is still its owner's", () => {
  const series = Projection.fromState(
    presetState(presetById("partner-even-split")),
    usJurisdiction,
  ).run(usJurisdiction).series;
  /** The first April: Blake owes $29.14 on a month their own income falls $637.73 short of. */
  const flows = series.months[15]!.flows!;
  const ALEX_ID = "p1";
  const BLAKE_ID = "person-8";

  it("has the household covering part of Blake's month, which is what makes this a test", () => {
    expect(flows.netCashFlowByPersonCents[BLAKE_ID]).toBeLessThan(0);
    expect(flows.obligationFundedByPersonCents[BLAKE_ID]).toBeLessThan(
      flows.obligationChargedByPersonCents[BLAKE_ID]!,
    );
  });

  it("still charges Blake's balance to Blake and explains it with Blake's own income", () => {
    expect(flows.taxSettlementByPersonCents[BLAKE_ID]).toBe(2914);
    const blake = flows.taxSettlementBySourcePersonCents[BLAKE_ID]!;
    expect(Object.values(blake).reduce((a, b) => a + b, 0)).toBe(2914);
    // Blake's own job and Blake's own savings interest — and nothing of Alex's, whose money paid
    // for it. Source keys carry no owner of their own (`job:job-9` names a job, not a person),
    // which is why the split has to come from the engine rather than from reading the keys.
    const alex = flows.taxSettlementBySourcePersonCents[ALEX_ID]!;
    expect(Object.keys(blake).filter((id) => id in alex)).toEqual([]);
    expect(blake["job:job-9"]).toBe(1824);
    expect(blake["interest:savings-person-8"]).toBe(1090);
  });

  it("leaves Alex's own balance untouched by the help Alex gave", () => {
    const alex = flows.taxSettlementBySourcePersonCents[ALEX_ID]!;
    expect(Object.values(alex).reduce((a, b) => a + b, 0)).toBe(
      flows.taxSettlementByPersonCents[ALEX_ID],
    );
    expect(Object.keys(alex).some((id) => id.includes(BLAKE_ID))).toBe(false);
  });
});
