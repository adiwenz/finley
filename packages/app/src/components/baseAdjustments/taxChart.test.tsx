/**
 * @vitest-environment jsdom
 *
 * The tax chart's hover readout. Recharts owns the hover and needs a real layout width jsdom
 * lacks, so the readout is driven directly with the payload Recharts would hand it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { dollarsToCents } from "@finley/engine";
import { TaxTooltipContent } from "./taxChart";
import type { TaxMonthRow } from "./taxesByMonth";

afterEach(cleanup);

describe("TaxTooltipContent — the hover readout", () => {
  // Only the fields the readout reads; Recharts' own payload type carries plumbing a test has
  // no way to construct meaningfully.
  const entry = (dataKey: string, value: number) =>
    ({ dataKey, name: dataKey, value, color: "#000" }) as never;
  const props = (payload: unknown[]) =>
    ({ active: true, label: 12, payload }) as unknown as Parameters<typeof TaxTooltipContent>[0];

  it("leaves out the bands charging nothing this month", () => {
    // Every band sits in every row — zero-filled so a once-a-year band still draws — so without
    // this a two-earner plan hovers as nine lines of which one carries money.
    render(
      <TaxTooltipContent
        {...props([
          entry("income:job-a", dollarsToCents(900)),
          entry("fica:job-a", dollarsToCents(350)),
          entry("draw:brokerage", 0),
          entry("draw:pretax", 0),
        ])}
      />,
    );
    // Recharts splits each row into name/value spans, so read the rows whole.
    const rows = screen.getAllByRole("listitem").map((el) => el.textContent);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/income:job-a.*\$900/);
    expect(rows.join(" ")).not.toMatch(/brokerage|pretax/);
  });

  it("totals only what it shows — and the zeroes it dropped were worth nothing anyway", () => {
    render(
      <TaxTooltipContent
        {...props([
          entry("income:job-a", dollarsToCents(900)),
          entry("fica:job-a", dollarsToCents(350)),
          entry("draw:brokerage", 0),
        ])}
      />,
    );
    expect(screen.getByText("Total taxes paid").parentElement?.textContent).toMatch(/\$1,250/);
  });

  it("draws no Total for a single paying band, which would just repeat the row above", () => {
    render(
      <TaxTooltipContent {...props([entry("income:job-a", dollarsToCents(900)), entry("fica:job-a", 0)])} />,
    );
    expect(screen.queryByText("Total taxes paid")).toBeNull();
  });

  it("draws nothing in a month that charged no tax at all", () => {
    const { container } = render(<TaxTooltipContent {...props([entry("income:job-a", 0)])} />);
    expect(container.firstChild).toBeNull();
  });

  it("draws nothing when nothing is hovered", () => {
    const { container } = render(<TaxTooltipContent {...props([])} active={false} />);
    expect(container.firstChild).toBeNull();
  });
});

/**
 * The two sections below the bands. Both are explanation: neither is ever a band height, and the
 * bolded total goes on agreeing with the tax the month actually paid.
 */
describe("TaxTooltipContent — a filing month's readout", () => {
  const entry = (dataKey: string, value: number) =>
    ({ dataKey, name: dataKey, value, color: "#000" }) as never;
  const row = (over: Partial<TaxMonthRow>): TaxMonthRow => ({
    month: 15,
    taxCents: 0,
    centsBySource: {},
    settlementCents: 0,
    settlementPaidCents: 0,
    refundCents: 0,
    settlementBySourceCents: {},
    ...over,
  });
  const hover = (payload: unknown[], r: TaxMonthRow) => ({
    active: true,
    label: 16,
    payload,
    rowsByAxisX: new Map([[16, r]]),
    sourceLabels: { "job:job-1": "Main job", "job:job-2": "Second job", "interest:savings": "Savings" },
  }) as unknown as Parameters<typeof TaxTooltipContent>[0];

  it("shows the settlement's signed attribution as diagnostics, netting to the band", () => {
    render(
      <TaxTooltipContent
        {...hover(
          [entry("Main job", 157249), entry("Second job", 18463), entry("Tax settlement", 7126)],
          row({
            taxCents: 182838,
            settlementCents: 7126,
            settlementPaidCents: 7126,
            settlementBySourceCents: {
              "job:job-1": -340911,
              "job:job-2": 343439,
              "interest:savings": 4598,
            },
          }),
        )}
      />,
    );
    const diagnostic = screen.getByTestId("settlement-attribution").textContent!;
    expect(diagnostic).toMatch(/Main job.*-\$3,409/);
    expect(diagnostic).toMatch(/Second job.*\$3,434/);
    expect(diagnostic).toMatch(/Savings.*\$46/);
    expect(diagnostic).toMatch(/Net.*\$71/);
  });

  it("totals the tax actually paid — the diagnostic rows add nothing to it", () => {
    render(
      <TaxTooltipContent
        {...hover(
          [entry("Main job", 157249), entry("Second job", 18463), entry("Tax settlement", 7126)],
          row({
            taxCents: 182838,
            settlementCents: 7126,
            settlementPaidCents: 7126,
            settlementBySourceCents: { "job:job-1": -340911, "job:job-2": 343439, "interest:savings": 4598 },
          }),
        )}
      />,
    );
    expect(screen.getByText("Total taxes paid").parentElement?.textContent).toMatch(/\$1,828/);
  });

  it("names a refund as money back, and points at the chart it lands on", () => {
    render(
      <TaxTooltipContent
        {...hover(
          [entry("Main job", dollarsToCents(1100)), entry("Main job — FICA", dollarsToCents(400))],
          row({ taxCents: dollarsToCents(1500), settlementCents: dollarsToCents(-3000), refundCents: dollarsToCents(3000) }),
        )}
      />,
    );
    expect(screen.getByText("Tax refund").parentElement?.textContent).toMatch(/\$3,000/);
    expect(screen.getByText(/cash-flow chart/)).toBeTruthy();
    // The withholding stands: the refund did not net against it.
    expect(screen.getByText("Total taxes paid").parentElement?.textContent).toMatch(/\$1,500/);
  });

  it("still speaks for a refund-only month, which has no band to hover", () => {
    render(
      <TaxTooltipContent
        {...hover([entry("Main job", 0)], row({ settlementCents: dollarsToCents(-3000), refundCents: dollarsToCents(3000) }))}
      />,
    );
    expect(screen.getByText("Tax refund").parentElement?.textContent).toMatch(/\$3,000/);
    expect(screen.queryByText("Total taxes paid")).toBeNull();
  });

  it("adds neither section to an ordinary month", () => {
    render(
      <TaxTooltipContent
        {...hover([entry("Main job", dollarsToCents(1100))], row({ taxCents: dollarsToCents(1100) }))}
      />,
    );
    expect(screen.queryByTestId("settlement-attribution")).toBeNull();
    expect(screen.queryByText("Tax refund")).toBeNull();
  });
});
