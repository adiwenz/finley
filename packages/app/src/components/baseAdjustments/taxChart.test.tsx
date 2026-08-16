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
    expect(screen.getByText("Total").parentElement?.textContent).toMatch(/\$1,250/);
  });

  it("draws no Total for a single paying band, which would just repeat the row above", () => {
    render(
      <TaxTooltipContent {...props([entry("income:job-a", dollarsToCents(900)), entry("fica:job-a", 0)])} />,
    );
    expect(screen.queryByText("Total")).toBeNull();
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
