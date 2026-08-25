/**
 * @vitest-environment jsdom
 *
 * "Funded by", in a household of two — the panel that used to answer with a line and a name.
 *
 * The per-line waterfall says which OBLIGATION the pool financed, which is an arbitrary reading of
 * a fungible pool and admits as much. Once there are two people it stops being merely arbitrary:
 * accounts are personally owned, so naming one asserts an owner, and the owner it named was
 * whichever buffer the roster listed first — in "Two incomes, one household" that is the partner
 * whose balance ROSE that month, while the balance that actually fell belonged to the other.
 *
 * So these run the whole App on the real presets and assert the two halves together: that the
 * per-person view appears in a partnered month and reads off the engine's own per-person figures,
 * and that a household of one — including the years between two relationships — still gets the
 * per-line walk, unchanged.
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { App } from "./main";
import { enterNumber } from "./testing/numberField";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(cleanup);

/** Load a scenario and move the month editor to `month`. */
function load(presetId: string, month = 0): void {
  render(<App />);
  fireEvent.change(screen.getByLabelText(/Start from a scenario/), { target: { value: presetId } });
  if (month !== 0) {
    enterNumber(screen.getByRole("spinbutton", { name: "Month to edit" }), month);
  }
}

/** One person's block in the per-person view, found by the id the engine minted for them. */
function personBlock(name: string): HTMLElement {
  const blocks = [...document.querySelectorAll("[data-person]")] as HTMLElement[];
  const found = blocks.find((b) => b.textContent?.startsWith(name) === true);
  if (found === undefined) {
    throw new Error(`no row for ${name}; rows are: ${blocks.map((b) => b.textContent).join(" | ")}`);
  }
  return found;
}

/** Every "what covered it" line under a person, as "label amount" pairs. */
function coverage(name: string): string[] {
  return [...within(personBlock(name)).getAllByRole("listitem")].map((li) =>
    (li.textContent ?? "").trim(),
  );
}

/** A "$1,234" as the number it prints — the reader's own arithmetic, done in the test. */
const dollars = (text: string): number => Number(text.replace(/[^\d-]/g, ""));

/** Every dollar figure in an element, in order. */
const amounts = (el: HTMLElement): number[] =>
  [...(el.textContent ?? "").matchAll(/\$[\d,]+/g)].map((m) => dollars(m[0]));

/** The heading the funding section is currently rendering — the two views are told apart by it. */
const headings = (): string[] =>
  screen.queryAllByRole("heading", { level: 4 }).map((h) => h.textContent ?? "");

describe("Funded by — a partnered month answers per person", () => {
  it("prints parts that add up: each row to its share, and the shares to the household total", () => {
    // Rounded independently, two shares of $2,700.005 print as $2,700 each beside a total that
    // prints as $5,401 — a breakdown the reader can see does not add up. Asserted on a month
    // years into the run, where inflation has left the figures with cents on them.
    load("partner-even-split", 61);
    for (const who of ["Alex", "Blake"]) {
      const [share, ...lines] = amounts(personBlock(who));
      // The trailing "Left over" is a fact about the month, not part of what covered the share.
      const covered = coverage(who).filter((l) => !l.startsWith("Left over")).length;
      expect(lines.slice(0, covered).reduce((sum, n) => sum + n, 0)).toBe(share);
    }
    const total = dollars(document.querySelector("[data-person-total]")!.textContent ?? "");
    const shares = ["Alex", "Blake"].map((who) => amounts(personBlock(who))[0]!);
    expect(shares.reduce((sum, n) => sum + n, 0)).toBe(total);
  });

  it("charges each partner their authored share, and both shares sum to the month's spend", () => {
    // "Two incomes, one household": $5,400 of budget at 50/50, so $2,700 each however unequal
    // the two paychecks are. That the split does not read income is the preset's whole point.
    load("partner-even-split");
    expect(personBlock("Alex").textContent).toContain("$2,700");
    expect(personBlock("Blake").textContent).toContain("$2,700");
  });

  it("shows the partner whose pay covers their share funding it from income alone", () => {
    load("partner-even-split");
    const alex = coverage("Alex");
    // Alex grosses $8,000 and owes $2,700, so nothing of theirs was sold — the row is one line.
    expect(alex.some((l) => l.startsWith("From their income"))).toBe(true);
    expect(alex.some((l) => l.includes("savings"))).toBe(false);
    expect(alex.some((l) => l.includes("assistance"))).toBe(false);
    // What the month did not consume, kept out of the arithmetic and stated as itself.
    expect(alex.some((l) => l.startsWith("Left over"))).toBe(true);
  });

  it("names the SHORT partner's own savings for the draw that covered their share", () => {
    // The defect this file exists for: $590 came out of Blake's savings and the panel called it
    // Alex's, because it named the household's first liquid account rather than the one that fell.
    load("partner-even-split");
    const blake = coverage("Blake");
    expect(blake.some((l) => l.startsWith("From their income"))).toBe(true);
    const fromSavings = blake.find((l) => l.includes("savings"));
    expect(fromSavings).toBeDefined();
    expect(fromSavings).toContain("Blake");
    // And Alex's account is nowhere in Blake's row, nor in Alex's own.
    expect(coverage("Alex").some((l) => l.includes("Alex"))).toBe(false);
  });

  it("calls it assistance when one partner's accounts cover the other's share", () => {
    // By Year 5 of "Two incomes, one household" Blake's $30,000 is gone — they have been short
    // every month since month 0 — so Alex's money is what covers Blake's share. The split has not
    // moved: Blake is still charged 50%, and the row says who paid it instead.
    load("partner-even-split", 60);
    const blake = coverage("Blake");
    // Still 50/50 five years on: both rows carry the same share, inflated together.
    const shareOf = (who: string) => (personBlock(who).textContent ?? "").match(/\$[\d,]+/)?.[0];
    expect(shareOf("Blake")).toBe(shareOf("Alex"));
    const help = blake.find((l) => l.includes("assistance"));
    expect(help).toBeDefined();
    expect(help).toContain("Alex");
  });

  it("keeps the per-line waterfall for a household of one", () => {
    // The control. Nothing about the single-person view changes, caveat and all.
    load("default");
    expect(document.querySelectorAll("[data-person]").length).toBe(0);
    expect(document.querySelectorAll("[data-obligation]").length).toBeGreaterThan(0);
    expect(headings()).toContain("Funded by");
    expect(screen.getByText(/reordering priorities would reassign/)).toBeTruthy();
  });

  it("follows a sequential household through a separation and a new partnership", () => {
    // Month 0: Alex and Blake. The per-person view, with both of them on it.
    load("partner-sequential");
    expect(personBlock("Alex")).toBeTruthy();
    expect(personBlock("Blake")).toBeTruthy();

    // Year 6: Blake has gone and Casey has not arrived. A household of one, so the per-line
    // walk is back — the question "which line did the pool finance" is a fair one again.
    enterNumber(screen.getByRole("spinbutton", { name: "Month to edit" }), 72);
    expect(document.querySelectorAll("[data-person]").length).toBe(0);
    expect(document.querySelectorAll("[data-obligation]").length).toBeGreaterThan(0);

    // Year 8: Casey is here, and it is Casey on the list — not Blake, whose figures the
    // per-person maps still carry as zeroes for every month after they left.
    enterNumber(screen.getByRole("spinbutton", { name: "Month to edit" }), 96);
    expect(personBlock("Alex")).toBeTruthy();
    expect(personBlock("Casey")).toBeTruthy();
    expect(() => personBlock("Blake")).toThrow();
  });

  it("does not say a fungible pool decided anything once there are two people", () => {
    load("partner-even-split");
    // The old caveat was defensible alone and wrong partnered: the split is authored, the accounts
    // are owned, and assistance is modelled. None of that is a priority order.
    expect(screen.queryByText(/reordering priorities would reassign/)).toBeNull();
    expect(screen.getByText(/covering the other’s share is help/)).toBeTruthy();
  });
});
