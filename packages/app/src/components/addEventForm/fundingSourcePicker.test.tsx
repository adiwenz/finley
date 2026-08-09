/**
 * @vitest-environment jsdom
 *
 * FundingSourcePicker owns selection order, disabled/empty presentation, coverage copy and
 * emitting the edited source-id list. Funding availability itself is an engine answer and is
 * supplied directly here rather than recomputed through a real projection.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { FundingAvailability, FundingSourceBalance } from "@finley/engine";
import { FundingSourcePicker } from "./fundingSourcePicker";

afterEach(cleanup);

const pool: readonly FundingSourceBalance[] = [
  { id: "brokerage", label: "Home fund", balanceCents: 5_000_000 },
  { id: "cash", label: "Cash savings", balanceCents: 2_000_000 },
  { id: "empty", label: "Emergency fund", balanceCents: 0 },
];

const availability = (over: Partial<FundingAvailability> = {}): FundingAvailability => ({
  shortfallCents: 0,
  availableCents: 6_000_000,
  taxCents: 0,
  taxed: false,
  sources: [],
  ...over,
});

function renderPicker({
  selected = ["brokerage"],
  currentAvailability = availability(),
  currentPool = pool,
  amountCents = 6_000_000,
}: {
  selected?: readonly string[];
  currentAvailability?: FundingAvailability;
  currentPool?: readonly FundingSourceBalance[];
  amountCents?: number;
} = {}) {
  const onChange = vi.fn();
  render(
    <FundingSourcePicker
      pool={currentPool}
      selected={selected}
      amountCents={amountCents}
      availability={currentAvailability}
      onChange={onChange}
    />,
  );
  return onChange;
}

describe("FundingSourcePicker", () => {
  it("appends newly selected accounts so click order is drain order", () => {
    const onChange = renderPicker({ selected: ["brokerage"] });
    fireEvent.click(screen.getByRole("checkbox", { name: /Cash savings/ }));
    expect(onChange).toHaveBeenCalledWith(["brokerage", "cash"]);
  });

  it("removes a deselected account without reordering the rest", () => {
    const onChange = renderPicker({ selected: ["brokerage", "cash"] });
    fireEvent.click(screen.getByRole("checkbox", { name: /Home fund/ }));
    expect(onChange).toHaveBeenCalledWith(["cash"]);
  });

  it("shows drain positions only for selected accounts", () => {
    renderPicker({ selected: ["cash", "brokerage"] });
    const cash = screen.getByRole("checkbox", { name: /Cash savings/ }).closest("label")!;
    const brokerage = screen.getByRole("checkbox", { name: /Home fund/ }).closest("label")!;
    expect(cash.textContent).toContain("1");
    expect(brokerage.textContent).toContain("2");
  });

  it("keeps empty accounts visible, disabled and labelled with $0", () => {
    renderPicker();
    const empty = screen.getByRole("checkbox", { name: /Emergency fund/ }) as HTMLInputElement;
    expect(empty.disabled).toBe(true);
    expect(empty.closest("label")?.textContent).toContain("$0");
  });

  it("asks for a source when funds exist but none is selected", () => {
    renderPicker({ selected: [] });
    expect(screen.getByText(/Choose at least one account/i)).toBeTruthy();
  });

  it("distinguishes an all-empty pool from an unselected funded pool", () => {
    renderPicker({
      selected: [],
      currentPool: pool.map((source) => ({ ...source, balanceCents: 0 })),
      currentAvailability: availability({ availableCents: 0, shortfallCents: 6_000_000 }),
    });
    expect(screen.getByText(/No account holds anything at that month/i)).toBeTruthy();
    expect(screen.queryByText(/Choose at least one account/i)).toBeNull();
  });

  it("renders the engine-provided shortfall without recomputing it", () => {
    renderPicker({
      currentAvailability: availability({ availableCents: 4_500_000, shortfallCents: 1_500_000 }),
    });
    expect(screen.getByRole("status").textContent).toContain("$15,000 short of the $60,000 needed");
  });

  it("renders the engine-provided capital-gains tax note", () => {
    renderPicker({
      currentAvailability: availability({ taxed: true, taxCents: 125_000 }),
    });
    expect(screen.getByRole("status").textContent).toContain("$1,250 of capital-gains tax");
  });

  it("renders covered state from the supplied availability", () => {
    renderPicker();
    expect(screen.getByRole("status").textContent).toContain("Covers the $60,000 needed");
  });

  it("explains when the plan has no funding accounts at all", () => {
    renderPicker({ selected: [], currentPool: [] });
    expect(screen.getByText(/plan has no cash or investment account/i)).toBeTruthy();
  });
});
