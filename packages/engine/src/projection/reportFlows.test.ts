import { describe, expect, it } from "vitest";
import { buildFlows, SAVINGS_DRAWDOWN_SOURCE_ID } from "./reportFlows";
import type { IncomeSourceMonth } from "./waterfall";
import { OBLIGATION_PRIORITY, type FinancialObligation } from "./financialObligation";

/** An authored budget line as the sim reports it, for the per-line slice and the band order. */
const line = (id: string, amountCents: number, priority = OBLIGATION_PRIORITY.needs): FinancialObligation => ({
  id: `line:${id}`,
  sourceId: id,
  month: 0,
  amountCents,
  treatment: "expense",
  funding: { kind: "automatic" },
  priority,
  sourceKind: "budgetLine",
  editable: true,
  label: id,
  category: "needs",
});

const debt = (id: string, amountCents: number): FinancialObligation => ({
  id: `debt:${id}`,
  sourceId: id,
  month: 0,
  amountCents,
  treatment: "debt-payment",
  funding: { kind: "automatic" },
  priority: OBLIGATION_PRIORITY.mandatory,
  sourceKind: "liability",
  editable: false,
  label: "Loan payment",
  category: "debtService",
});

const src = (
  ownerId: string,
  waterfallInflowCents: number,
  taxCategory: IncomeSourceMonth["taxCategory"],
  extra?: Partial<IncomeSourceMonth>,
): IncomeSourceMonth => ({ ownerId, waterfallInflowCents, taxCategory, ...extra });

describe("buildFlows", () => {
  it("buckets gross income by tax category and sums the total", () => {
    const flows = buildFlows(
      [src("p1", 5_000_00, "wages"), src("p1", 1_000_00, "ordinaryIncome"), src("p2", 2_000_00, "wages")],
      0,
      [],
    );
    expect(flows.cashFlowIncomeByCategoryCents).toEqual({ wages: 7_000_00, ordinaryIncome: 1_000_00 });
    expect(flows.totalIncomeCents).toBe(8_000_00);
  });

  it("surfaces the government-retirement-benefit slice as its own convenience field", () => {
    const flows = buildFlows(
      [src("p1", 2_500_00, "governmentRetirementBenefit"), src("p1", 4_000_00, "wages")],
      0,
      [],
    );
    expect(flows.governmentRetirementBenefitCents).toBe(2_500_00);
  });

  it("reports 0 government retirement benefit when no source carries that category", () => {
    const flows = buildFlows([src("p1", 4_000_00, "wages")], 0, []);
    expect(flows.governmentRetirementBenefitCents).toBe(0);
  });

  it("rolls the obligation list up into expenses and liability payments", () => {
    // The expense/debt rollups are derivations of the one list, not passed-in scalars: expenses
    // are the expense-treatment sum, liability payments the automatically-funded remainder.
    const flows = buildFlows([], 900_00, [line("rent", 3_200_00), debt("mortgage-1", 1_800_00)]);
    expect(flows.taxCents).toBe(900_00);
    expect(flows.expensesCents).toBe(3_200_00);
    expect(flows.liabilityPaymentsCents).toBe(1_800_00);
    expect(flows.totalObligationsCents).toBe(5_000_00);
  });

  it("derives the per-line map from the obligation list, debts excluded, and orders bands by priority", () => {
    const items = [line("rent", 2_000_00), line("fun", 100_00), debt("mortgage-1", 1_800_00)];
    const flows = buildFlows([], 0, items);
    // The per-line view is the budget-line slice of the list: a debt payment is a real
    // obligation but not a line, and must not leak in.
    expect(flows.lineMonthlyCents).toEqual({ "line:rent": 2_000_00, "line:fun": 100_00 });
    // Reported in priority order — mandatory debt first, then the two needs lines tie-broken on
    // id (`line:fun` < `line:rent`) — regardless of the source order they were built in.
    expect(flows.obligations).toEqual([
      debt("mortgage-1", 1_800_00),
      line("fun", 100_00),
      line("rent", 2_000_00),
    ]);
    expect(flows.totalObligationsCents).toBe(3_900_00);
  });

  it("yields empty buckets and zero totals for a month with no income", () => {
    const flows = buildFlows([], 0, []);
    expect(flows.cashFlowIncomeByCategoryCents).toEqual({});
    expect(flows.totalIncomeCents).toBe(0);
    expect(flows.governmentRetirementBenefitCents).toBe(0);
    expect(flows.taxCents).toBe(0);
    expect(flows.lineMonthlyCents).toEqual({});
    expect(flows.obligations).toEqual([]);
    expect(flows.totalObligationsCents).toBe(0);
    expect(flows.incomeSources).toEqual([]);
  });

  it("reports income by source, keeping distinct sources in one tax bucket apart", () => {
    // Two jobs both taxed as `wages`: the category rollup collapses them, the source list
    // keeps them apart so a chart can name which paycheck is which.
    const flows = buildFlows(
      [
        src("p1", 5_000_00, "wages", { sourceId: "job:a", label: "Job A" }),
        src("p1", 2_000_00, "wages", { sourceId: "job:b", label: "Job B" }),
      ],
      0,
      [],
    );
    expect(flows.cashFlowIncomeByCategoryCents).toEqual({ wages: 7_000_00 });
    expect(flows.incomeSources).toEqual([
      { sourceId: "job:a", label: "Job A", category: "wages", ownerId: "p1", cashInflowCents: 5_000_00, netCashFlowCents: 5_000_00 },
      { sourceId: "job:b", label: "Job B", category: "wages", ownerId: "p1", cashInflowCents: 2_000_00, netCashFlowCents: 2_000_00 },
    ]);
  });

  it("sums repeated source ids and falls back to the tax category when unlabelled", () => {
    const flows = buildFlows(
      [
        src("p1", 1_000_00, "ordinaryIncome", { sourceId: "rmd:p1", label: "RMD" }),
        src("p1", 500_00, "ordinaryIncome", { sourceId: "rmd:p1", label: "RMD" }),
        src("p2", 300_00, "capitalGains"), // no id/label → keyed & named by category
      ],
      0,
      [],
    );
    // Each band names WHOSE income it is — the owner rides through from the source.
    expect(flows.incomeSources).toEqual([
      { sourceId: "rmd:p1", label: "RMD", category: "ordinaryIncome", ownerId: "p1", cashInflowCents: 1_500_00, netCashFlowCents: 1_500_00 },
      {
        sourceId: "capitalGains",
        label: "capitalGains",
        category: "capitalGains",
        ownerId: "p2",
        cashInflowCents: 300_00,
        netCashFlowCents: 300_00,
      },
    ]);
  });

  it("bands accrued interest by its cash inflow (waterfallInflowCents 0, but real household cash)", () => {
    // An interest booking places nothing in the ALLOCATION waterfall (waterfallInflowCents
    // 0 — the cash already sits in the balance), yet it IS real cash, so it reports its
    // interest as a cash inflow rather than being dropped from the cash-flow view.
    const flows = buildFlows(
      [src("p1", 0, "ordinaryIncome", { cashInflowCents: 40_00, taxableCents: 40_00, sourceId: "interest:p1", label: "Savings interest" })],
      0,
      [],
    );
    expect(flows.incomeSources).toEqual([
      { sourceId: "interest:p1", label: "Savings interest", category: "ordinaryIncome", ownerId: "p1", cashInflowCents: 40_00, netCashFlowCents: 40_00 },
    ]);
    expect(flows.cashFlowIncomeByCategoryCents).toEqual({ ordinaryIncome: 40_00 });
    expect(flows.totalIncomeCents).toBe(40_00);
  });

  it("nets savings interest's tax off its cash inflow (the $500/$100/$400 reconciliation)", () => {
    // $500 of interest, $100 of attributed tax: cash inflow $500, net $400. The engine owns
    // net (cashInflow − deferral − tax); the $500 balance credit from compounding is a
    // separate fact this booking never re-injects.
    const flows = buildFlows(
      [src("p1", 0, "ordinaryIncome", { cashInflowCents: 500_00, taxableCents: 500_00, sourceId: "interest:p1:ordinaryIncome", label: "Savings interest" })],
      100_00, // household tax
      [],
      0,
      { ordinaryIncome: 100_00 }, // taxByCategoryCents
      { "interest:p1:ordinaryIncome": 100_00 }, // taxBySourceCents — the interest bore all of it
    );
    expect(flows.incomeSources).toEqual([
      {
        sourceId: "interest:p1:ordinaryIncome",
        label: "Savings interest",
        category: "ordinaryIncome",
        ownerId: "p1",
        cashInflowCents: 500_00,
        netCashFlowCents: 400_00,
      },
    ]);
    expect(flows.totalIncomeCents).toBe(500_00);
  });

  it("surfaces a liquid-buffer drawdown as its own savingsDrawdown source, out of the taxable rollup", () => {
    const flows = buildFlows(
      [src("p1", 2_000_00, "governmentRetirementBenefit", { sourceId: "benefit:p1", label: "Government benefit" })],
      0,
      [line("rent", 3_000_00)],
      1_000_00, // savings covered the $1,000 gap this month
    );
    // NOT taxable income: absent from the category rollup and the total…
    expect(flows.cashFlowIncomeByCategoryCents).toEqual({ governmentRetirementBenefit: 2_000_00 });
    expect(flows.totalIncomeCents).toBe(2_000_00);
    // …but present as its own band, so "living off savings" is visible, not zero income.
    expect(flows.incomeSources).toContainEqual({
      sourceId: SAVINGS_DRAWDOWN_SOURCE_ID,
      label: "Savings drawdown",
      category: "savingsDrawdown",
      cashInflowCents: 1_000_00,
      netCashFlowCents: 1_000_00,
    });
  });

  it("adds no drawdown band when savings covered nothing", () => {
    const flows = buildFlows([src("p1", 5_000_00, "wages", { sourceId: "job:a", label: "Job A" })], 0, [], 0);
    expect(flows.incomeSources.some((s) => s.category === "savingsDrawdown")).toBe(false);
  });
});

/**
 * Federal income tax is an annual liability paid in twelfths, so the month a dollar of tax is
 * CHARGED is routinely not the month the income arrived. The per-source haircut then has a share
 * of tax and no cash to take it from — and if that share is simply dropped, Σ `netCashFlowCents`
 * (the cash-flow chart's whole stack) claims more spendable cash than the household has.
 */
describe("buildFlows — tax charged against income that arrived in another month", () => {
  const RMD_IN_JANUARY = { sourceId: "rmd:p1", label: "Required distribution" };

  it("charges a band-less source's tax against the bands that did deliver cash", () => {
    // April of a retired year: the RMD landed in January and carries $150 of this month's
    // instalment, but no cash. The benefit ($900) and the account draw ($100) are what the
    // household actually has, so they are where the $150 was found — split 9:1 by cash.
    const flows = buildFlows(
      [
        src("p1", 900_00, "governmentRetirementBenefit", { sourceId: "benefit:p1", label: "Government benefit" }),
        src("p1", 100_00, "ordinaryIncome", { sourceId: "retirement", label: "Retirement account" }),
      ],
      150_00,
      [],
      0,
      { ordinaryIncome: 150_00 },
      { [RMD_IN_JANUARY.sourceId]: 150_00 },
    );
    const net = (id: string) => flows.incomeSources.find((s) => s.sourceId === id)!.netCashFlowCents;
    expect(net("benefit:p1")).toBe(900_00 - 135_00);
    expect(net("retirement")).toBe(100_00 - 15_00);
    // The invariant the chart rests on: what the bands add up to IS what the month can spend.
    const takeHome = flows.incomeSources.reduce((s, x) => s + x.netCashFlowCents, 0);
    expect(takeHome).toBe(1_000_00 - 150_00);
  });

  it("stacks the stranded share on top of a band's own tax rather than replacing it", () => {
    const flows = buildFlows(
      [src("p1", 1_000_00, "ordinaryIncome", { sourceId: "retirement", label: "Retirement account" })],
      150_00,
      [],
      0,
      { ordinaryIncome: 150_00 },
      { retirement: 50_00, [RMD_IN_JANUARY.sourceId]: 100_00 },
    );
    expect(flows.incomeSources[0]!.netCashFlowCents).toBe(1_000_00 - 50_00 - 100_00);
  });

  it("can charge it against a savings drawdown, which is also cash in hand", () => {
    // A month whose only cash is the liquid buffer. The buffer bears no tax of its own — but
    // the instalment was genuinely paid out of it, and leaving the share stranded would report
    // the drawdown as covering more spending than it did.
    const flows = buildFlows([], 80_00, [line("rent", 500_00)], 500_00, { ordinaryIncome: 80_00 }, {
      [RMD_IN_JANUARY.sourceId]: 80_00,
    });
    const drawdown = flows.incomeSources.find((s) => s.sourceId === SAVINGS_DRAWDOWN_SOURCE_ID)!;
    expect(drawdown.cashInflowCents).toBe(500_00);
    expect(drawdown.netCashFlowCents).toBe(500_00 - 80_00);
  });

  it("splits to the exact cent, leaving no residue for the stack to lose", () => {
    // Three bands and a total that does not divide evenly — largest-remainder, like every other
    // apportionment in the engine, so Σ net is exact rather than a cent or two adrift.
    const flows = buildFlows(
      [
        src("p1", 333_33, "wages", { sourceId: "a", label: "A" }),
        src("p1", 333_33, "wages", { sourceId: "b", label: "B" }),
        src("p1", 333_34, "wages", { sourceId: "c", label: "C" }),
      ],
      100_01,
      [],
      0,
      { wages: 100_01 },
      { [RMD_IN_JANUARY.sourceId]: 100_01 },
    );
    const takeHome = flows.incomeSources.reduce((s, x) => s + x.netCashFlowCents, 0);
    expect(takeHome).toBe(1_000_00 - 100_01);
  });

  it("leaves the haircut stranded when no source delivered any cash to charge it against", () => {
    // Nothing to apportion onto, and inventing a negative band out of thin air would be worse
    // than the honest gap. Degenerate — a month with tax and no cash at all.
    const flows = buildFlows([], 60_00, [], 0, { ordinaryIncome: 60_00 }, {
      [RMD_IN_JANUARY.sourceId]: 60_00,
    });
    expect(flows.incomeSources).toEqual([]);
  });

  it("leaves an ordinary month alone — nothing is stranded when every taxed source has cash", () => {
    const flows = buildFlows(
      [src("p1", 1_000_00, "wages", { sourceId: "job:a", label: "Job A" })],
      200_00,
      [],
      0,
      { wages: 200_00 },
      { "job:a": 200_00 },
    );
    expect(flows.incomeSources[0]!.netCashFlowCents).toBe(800_00);
  });
});

describe("buildFlows — the stranded haircut never takes more than a source has", () => {
  it("charges a heavily-deferred paycheck only what it actually delivered", () => {
    // A 76-year-old working part time and deferring $900 of a $1,000 paycheck, in a month
    // carrying $500 of tax on an RMD taken back in January. Weighted by GROSS cash the job
    // would owe $50 against the $20 it had left — a −$30 band, reading as though the paycheck
    // clawed money back. Weighted by what it delivered, it owes $20/8,520 of the $500 instead.
    const flows = buildFlows(
      [
        src("p1", 1_000_00, "wages", { sourceId: "job:a", label: "Part-time job" }),
        src("p1", 9_000_00, "governmentRetirementBenefit", { sourceId: "benefit:p1", label: "Government benefit" }),
      ],
      580_00,
      [],
      0,
      { ordinaryIncome: 580_00 },
      { "job:a": 80_00, "rmd:p1": 500_00 },
      { "job:a": 900_00 }, // deferral
    );
    const net = (id: string) => flows.incomeSources.find((s) => s.sourceId === id)!.netCashFlowCents;
    expect(net("job:a")).toBeGreaterThanOrEqual(0);
    expect(net("benefit:p1")).toBeGreaterThan(0);
    // Still exact: the month's spendable cash is its gross less deferral and the whole tax.
    const takeHome = flows.incomeSources.reduce((s, x) => s + x.netCashFlowCents, 0);
    expect(takeHome).toBe(10_000_00 - 900_00 - 580_00);
  });

  it("zeroes every contributing band rather than pushing one under, when the tax outruns them all", () => {
    // $200 of tax charged against $100 of net cash — the month funded the rest from balances or
    // credit. Bands bottom out at zero; the $100 that has nowhere to go stays stranded, because
    // the alternative says a source took money back out of the household.
    const flows = buildFlows(
      [src("p1", 100_00, "governmentRetirementBenefit", { sourceId: "benefit:p1", label: "Government benefit" })],
      200_00,
      [],
      0,
      { ordinaryIncome: 200_00 },
      { "rmd:p1": 200_00 },
    );
    expect(flows.incomeSources[0]!.netCashFlowCents).toBe(0);
  });

  it("never drives a band below zero that its own deductions had not already taken there", () => {
    // The property behind the two cases above, stated against the right baseline. A source CAN
    // still be negative on its own account — payroll tax rides the gross wage while a 401(k)
    // deferral removes the cash, so a fully-deferred paycheck really does cost the household
    // more than it delivered. That is the source's own arithmetic, and this pass must neither
    // cause it nor deepen it: a band standing at or above zero stays there, and one already
    // under is left exactly where its own deductions put it.
    const run = (deferredCents: number, strandedCents: number) => {
      const ownTaxCents = 80_00;
      return buildFlows(
        [
          src("p1", 1_000_00, "wages", { sourceId: "job:a", label: "Part-time job" }),
          src("p1", 9_000_00, "governmentRetirementBenefit", { sourceId: "benefit:p1", label: "Government benefit" }),
        ],
        ownTaxCents + strandedCents,
        [],
        0,
        { ordinaryIncome: ownTaxCents + strandedCents },
        { "job:a": ownTaxCents, "rmd:p1": strandedCents },
        { "job:a": deferredCents },
      ).incomeSources;
    };
    for (const deferredCents of [0, 250_00, 500_00, 900_00, 1_000_00]) {
      const baseline = new Map(run(deferredCents, 0).map((s) => [s.sourceId, s.netCashFlowCents]));
      for (const strandedCents of [100_00, 500_00, 900_00]) {
        for (const s of run(deferredCents, strandedCents)) {
          const floor = Math.min(0, baseline.get(s.sourceId)!);
          expect(s.netCashFlowCents, `deferred ${deferredCents}, stranded ${strandedCents}, ${s.sourceId}`)
            .toBeGreaterThanOrEqual(floor);
        }
      }
    }
  });
});
