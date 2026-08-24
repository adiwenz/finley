/**
 * What the cash-flow chart WARNS about, and who it is warning about.
 *
 * Two failures of scope live here, and they are the same failure twice. A figure that is true of
 * one person was stated as though it were true of the household ("you're living off savings" over
 * a household earning $10,400 against $5,400 of spending, because one partner sold a fund). And a
 * transition that is true of the arithmetic was stated as though it were true of the plan ("Tax
 * refund begins" over a row reading $0, because the refund was four cents). Both are answered the
 * same way: a claim is made at the scope it is true at, in the units the reader can see.
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
import { buildCashFlowChartData, describeCashFlowGap } from "./cashFlowChartData";
import { buildCashFlowChartModel } from "./cashFlowChartModel";

interface MonthSpec {
  readonly sources?: ProjectionCashFlowIncomeSource[];
  readonly obligations?: { id: string; label: string; category: string; amountCents: number }[];
  readonly expensesCents?: number;
  readonly taxSettlementCents?: number;
  readonly taxSettlementByPersonCents?: Record<string, number>;
  readonly netCashFlowByPersonCents?: Record<string, number>;
  readonly obligationChargedByPersonCents?: Record<string, number>;
  readonly isInsolvent?: boolean;
}

function seriesOf(...perMonth: MonthSpec[]): ProjectionSeries {
  const months = [
    { month: 0 },
    ...perMonth.map((m, i) => ({
      month: i + 1,
      isInsolvent: m.isInsolvent ?? false,
      flows: {
        incomeSources: m.sources ?? [],
        obligations: m.obligations ?? [],
        taxCents: 0,
        payrollTaxCents: 0,
        taxSettlementCents: m.taxSettlementCents ?? 0,
        taxSettlementByPersonCents: m.taxSettlementByPersonCents ?? {},
        expensesCents: m.expensesCents ?? 0,
        liabilityPaymentsCents: 0,
        netCashFlowByPersonCents: m.netCashFlowByPersonCents ?? {},
        deferredByPersonCents: {},
        obligationChargedByPersonCents: m.obligationChargedByPersonCents ?? {},
      },
    })),
  ];
  return { months } as unknown as ProjectionSeries;
}

const wages = (id: string, cents: number, ownerId: string): ProjectionCashFlowIncomeSource =>
  ({ sourceId: id, label: id, category: "wages", cashInflowCents: cents, netCashFlowCents: cents, ownerId }) as
    ProjectionCashFlowIncomeSource;

/** Cash out of an account somebody OWNS — never an inflow, and always attributable. */
const draw = (id: string, cents: number, ownerId: string): ProjectionCashFlowIncomeSource =>
  ({
    sourceId: id,
    label: id,
    category: "savingsDrawdown",
    cashInflowCents: cents,
    netCashFlowCents: cents,
    ownerId,
    fromAccountWithdrawal: true,
  }) as ProjectionCashFlowIncomeSource;

const rent = (dollars: number) => ({
  id: "rent",
  label: "Rent",
  category: "needs",
  amountCents: dollarsToCents(dollars),
});

const ALEX = dollarsToCents(8_000);
const BLAKE = dollarsToCents(2_400);
const SHARED = dollarsToCents(5_400);
/** Half each, which is what leaves Blake $300 short of their own share every month. */
const HALF = SHARED / 2;

/** The reported household: two earners, an even split, and only Blake reaching for savings. */
const solventHousehold = () =>
  buildCashFlowChartData(
    seriesOf({
      sources: [
        wages("Alex's job", ALEX, "p1"),
        wages("Blake's job", BLAKE, "p2"),
        draw("Blake's savings", dollarsToCents(300), "p2"),
      ],
      obligations: [rent(5_400)],
      expensesCents: SHARED,
      netCashFlowByPersonCents: { p1: ALEX - HALF, p2: BLAKE - HALF },
      obligationChargedByPersonCents: { p1: HALF, p2: HALF },
    }),
  );

describe("a warning about the household is a claim about the household", () => {
  it("says nothing about savings when one partner draws and the household is ahead", () => {
    // $10,400 arriving against $5,400 of spending. Blake sells $300 of their own to cover their
    // half — a fact about Blake — and the household is $5,000 up. The old reading announced
    // "From Year 1 you're living off savings" over exactly this month.
    const data = solventHousehold();
    expect(data.rows[0]!.netCents).toBe(ALEX + BLAKE - SHARED);
    expect(data.firstHouseholdDrawdownMonth).toBeNull();
    expect(describeCashFlowGap(data)).toBeNull();
  });

  it("says it plainly when the household really is living off savings", () => {
    const data = buildCashFlowChartData(
      seriesOf(
        {
          sources: [wages("Alex's job", ALEX, "p1")],
          obligations: [rent(5_400)],
          expensesCents: SHARED,
        },
        {
          sources: [draw("Cash savings", dollarsToCents(5_400), "p1")],
          obligations: [rent(5_400)],
          expensesCents: SHARED,
        },
      ),
    );
    expect(data.firstHouseholdDrawdownMonth).toBe(2);
    expect(describeCashFlowGap(data)).toContain("living off savings");
  });

  it("does not call an unfunded month a drawdown, since nothing was drawn", () => {
    // Spending outruns income and no account covers the difference. That is a shortfall, and
    // insolvency is what names it — claiming savings paid for it would invent an account.
    const data = buildCashFlowChartData(
      seriesOf({
        sources: [wages("Alex's job", dollarsToCents(1_000), "p1")],
        obligations: [rent(5_400)],
        expensesCents: SHARED,
        isInsolvent: true,
      }),
    );
    expect(data.rows[0]!.netCents).toBeLessThan(0);
    expect(data.firstHouseholdDrawdownMonth).toBeNull();
    expect(describeCashFlowGap(data)).toBeNull();
    expect(data.firstInsolventMonth).toBe(1);
  });

  it("still names a household with nothing arriving and nothing left", () => {
    const data = buildCashFlowChartData(
      seriesOf({ obligations: [rent(5_400)], expensesCents: SHARED }),
    );
    expect(describeCashFlowGap(data)).toContain("No cash coming in");
  });

  it("counts a month whose only gap is an April settlement, once it is a real gap", () => {
    const data = buildCashFlowChartData(
      seriesOf({
        sources: [wages("Alex's job", ALEX, "p1"), draw("Cash savings", dollarsToCents(4_000), "p1")],
        obligations: [rent(5_400)],
        expensesCents: SHARED,
        taxSettlementCents: dollarsToCents(7_000),
        taxSettlementByPersonCents: { p1: dollarsToCents(7_000) },
      }),
    );
    // $8,000 in against $12,400 out — the settlement is what tips it, and the savings covered it.
    expect(data.firstHouseholdDrawdownMonth).toBe(1);
  });
});

describe("a warning about one person is a claim about that person", () => {
  it("names the partner who is covering their share out of savings", () => {
    const data = solventHousehold();
    expect(data.firstDrawdownMonthByPerson["p2"]).toBe(1);
    const said = describeCashFlowGap(data, "p2", "Blake");
    expect(said).toContain("Blake");
    expect(said).toContain("personal savings");
    expect(said).not.toContain("living off savings");
  });

  it("says nothing about the partner who is not", () => {
    expect(describeCashFlowGap(solventHousehold(), "p1", "Alex")).toBeNull();
  });

  it("scopes the nonvisual table's reason to the view it is read under", () => {
    const data = solventHousehold();
    const reasonsOf = (ownerId?: string) =>
      buildCashFlowChartModel(data, { view: "net", ...(ownerId ? { ownerId } : {}) })
        .accessibleMoments.map((m) => m.reason)
        .join(" ");
    expect(reasonsOf()).not.toContain("savings");
    expect(reasonsOf("p2")).toContain("First personal savings withdrawal");
    expect(reasonsOf("p1")).not.toContain("savings");
  });

  it("carries the same scoping into the chart's own visible hint", () => {
    const data = solventHousehold();
    const names = new Map([["p2", "Blake"]]);
    expect(buildCashFlowChartModel(data, { view: "net", personNames: names }).gapSummary).toBeNull();
    expect(
      buildCashFlowChartModel(data, { view: "net", ownerId: "p2", personNames: names }).gapSummary,
    ).toContain("Blake");
  });
});

describe("against the real presets", () => {
  const dataFor = (id: string) =>
    buildCashFlowChartData(
      Projection.fromState(presetState(presetById(id)), usJurisdiction).run(usJurisdiction).series,
    );

  it("no longer tells a two-income household it lives off savings in its first working year", () => {
    // The report's case exactly: ~$10,400/mo against ~$5,400 of shared spending, and a combined
    // view that announced Year 1. What remains is retirement, where it is true.
    const data = dataFor("partner-even-split");
    expect(data.firstHouseholdDrawdownMonth).not.toBeNull();
    expect(data.firstHouseholdDrawdownMonth!).toBeGreaterThan(25 * 12);
    for (const row of data.rows.slice(0, 12)) expect(row.netCents).toBeGreaterThan(0);
  });

  it("keeps a sequential household's partner-level drawdowns with the partner", () => {
    // Casey joins in Year 7 and is the only one who ever reaches for their own accounts to cover
    // their share; the household's own gap is a separate month with a separate cause.
    const data = dataFor("partner-sequential");
    const owners = Object.keys(data.firstDrawdownMonthByPerson);
    expect(owners.length).toBeGreaterThan(0);
    for (const [pid, month] of Object.entries(data.firstDrawdownMonthByPerson)) {
      expect(data.rows.find((r) => r.month === month)!.netCentsByPerson[pid]!).toBeLessThan(0);
    }
  });
});

describe("a transition nobody can see is not a transition", () => {
  /** One month with a refund of `cents` to `p1`, between two months with none. */
  const withRefund = (cents: number) =>
    buildCashFlowChartData(
      seriesOf(
        { sources: [wages("Alex's job", ALEX, "p1")], obligations: [rent(5_400)], expensesCents: SHARED },
        {
          sources: [wages("Alex's job", ALEX, "p1")],
          obligations: [rent(5_400)],
          expensesCents: SHARED,
          taxSettlementByPersonCents: { p1: -cents },
        },
        { sources: [wages("Alex's job", ALEX, "p1")], obligations: [rent(5_400)], expensesCents: SHARED },
      ),
    );

  const refundReasons = (data: ReturnType<typeof withRefund>, ownerId?: string) =>
    buildCashFlowChartModel(data, {
      view: "inflows",
      mode: "advanced",
      ...(ownerId ? { ownerId } : {}),
    })
      .accessibleMoments.map((m) => m.reason)
      .filter((r) => /refund/i.test(r));

  it("announces nothing for a refund of exactly nothing", () => {
    expect(refundReasons(withRefund(0))).toEqual([]);
  });

  it("announces nothing for a refund that prints as $0", () => {
    // Four cents. The milestone and the figure beneath it now agree, because they are read off
    // the same rounding rather than one off cents and the other off dollars.
    expect(refundReasons(withRefund(4))).toEqual([]);
  });

  it("announces a refund the reader can actually see, beginning and ending", () => {
    const reasons = refundReasons(withRefund(dollarsToCents(1_200)));
    expect(reasons.some((r) => /begins/.test(r))).toBe(true);
    expect(reasons.some((r) => /ends/.test(r))).toBe(true);
  });

  it("holds the same line in one person's cut as in the combined view", () => {
    expect(refundReasons(withRefund(4), "p1")).toEqual([]);
    expect(refundReasons(withRefund(dollarsToCents(1_200)), "p1").length).toBeGreaterThan(0);
  });

  it("keeps a refund with its own filer while the other owes", () => {
    // One April, two filings. Blake's refund is Blake's — it bands on Blake's cut and nowhere
    // else — and Alex's bill stays Alex's, on the outflow side where a bill belongs.
    const data = buildCashFlowChartData(
      seriesOf({
        sources: [wages("Alex's job", ALEX, "p1"), wages("Blake's job", BLAKE, "p2")],
        obligations: [rent(5_400)],
        expensesCents: SHARED,
        taxSettlementByPersonCents: { p1: dollarsToCents(900), p2: -dollarsToCents(1_100) },
        obligationChargedByPersonCents: { p1: HALF, p2: HALF },
      }),
    );
    const bandsFor = (ownerId: string) =>
      buildCashFlowChartModel(data, { view: "inflows", mode: "advanced", ownerId }).bands.map(
        (b) => b.label,
      );
    expect(bandsFor("p2")).toContain("Tax refund");
    expect(bandsFor("p1")).not.toContain("Tax refund");
    expect(data.rows[0]!.outflowCentsByBandByPerson["p1"]!["tax:settlement"]).toBe(
      dollarsToCents(900),
    );
    expect(data.rows[0]!.outflowCentsByBandByPerson["p2"]?.["tax:settlement"]).toBeUndefined();
  });

  it("announces no phantom refund across a whole real projection", () => {
    // Fifteen months of this preset settle a few cents back to one filer. Every one of them used
    // to be a "Tax refund begins" over a $0 row.
    const data = buildCashFlowChartData(
      Projection.fromState(presetState(presetById("partner-even-split")), usJurisdiction).run(
        usJurisdiction,
      ).series,
    );
    const subDollar = data.rows.filter((r) =>
      Object.entries(r.inflowCentsByBand).some(
        ([id, cents]) => id.startsWith("tax-refund") && cents > 0 && cents < 50,
      ),
    );
    expect(subDollar.length).toBeGreaterThan(0);
    const reasons = buildCashFlowChartModel(data, { view: "inflows", mode: "advanced" })
      .accessibleMoments.map((m) => m.reason)
      .filter((r) => /refund/i.test(r));
    expect(reasons).toEqual([]);
  });
});
