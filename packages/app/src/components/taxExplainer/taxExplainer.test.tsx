/**
 * @vitest-environment jsdom
 *
 * The tax explanation panel. Two things are being pinned: the LAYERING — a short explanation
 * anyone can read, with the mechanics behind a disclosure that starts shut — and the DIVISION of
 * labour between this panel's two sections, so a reader is never told the same thing twice under
 * two headings.
 *
 * The copy itself is asserted by topic rather than by sentence: these check that the detailed view
 * covers each concept, not that it covers it in any particular words, so the prose can be improved
 * without a test failing for it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ModelAssumption } from "@finley/engine";
import { TaxExplainer } from "./taxExplainer";

/** Stand-ins for the real disclosures, which the engine and the jurisdiction declare. */
const ASSUMPTIONS: readonly ModelAssumption[] = [
  { id: "postTaxOpeningBasis", text: "Money already in a post-tax account is treated as principal." },
  { id: "w4AssumedDefault", text: "A Form W-4 is assumed, filing single and claiming nothing." },
];

const renderPanel = (assumptions: readonly ModelAssumption[] = ASSUMPTIONS) =>
  render(<TaxExplainer assumptions={assumptions} />);

/** The `<details>` holding the mechanics — found by its own control, not by a class. */
const detailDisclosure = (): HTMLDetailsElement =>
  screen.getByText("Detailed").closest("details") as HTMLDetailsElement;

/**
 * The disclosure's prose as one line. JSX breaks a sentence across source lines wherever it
 * happens to wrap, so the assertions below would otherwise be pinned to the formatter's choices.
 */
const detailText = (): string => detailDisclosure().textContent!.replace(/\s+/g, " ");

afterEach(cleanup);

describe("TaxExplainer — the short explanation", () => {
  it("shows it without anything being opened first", () => {
    renderPanel();
    expect(screen.getByRole("heading", { name: "How we calculate your taxes" })).toBeTruthy();
    // The one idea the whole panel rests on: liability and withholding are different things.
    expect(document.body.textContent).toMatch(/tax you owe.*tax taken out/is);
  });

  it("says its piece without form numbers or jargon a reader would have to look up", () => {
    renderPanel();
    // Everything outside the disclosure is the short version; the detail may be more technical.
    const short = screen.getByRole("heading", { name: "How we calculate your taxes" })
      .parentElement!.textContent!.split("Detailed")[0]!;
    for (const jargon of [/W-4/, /Form 8959/, /Schedule 3/, /Publication 15/, /supplemental/i, /FICA/, /wage base/i]) {
      expect(short).not.toMatch(jargon);
    }
  });
});

describe("TaxExplainer — the Detailed disclosure", () => {
  it("starts collapsed", () => {
    renderPanel();
    expect(detailDisclosure().open).toBe(false);
  });

  it("has an accessible control that reports whether it is expanded", () => {
    renderPanel();
    const control = screen.getByText("Detailed");
    expect(control.tagName).toBe("SUMMARY");
    // `<details>` carries the expanded state on the element itself, which is what assistive
    // technology reads — there is no `aria-expanded` to keep in sync and none is added.
    expect(control.closest("details")!.hasAttribute("open")).toBe(false);
    fireEvent.click(control);
    expect(control.closest("details")!.hasAttribute("open")).toBe(true);
  });

  it("reveals the mechanics when the control is clicked", () => {
    renderPanel();
    fireEvent.click(screen.getByText("Detailed"));
    expect(detailDisclosure().open).toBe(true);
    expect(within(detailDisclosure()).getByRole("heading", { name: /paycheck withholding/i })).toBeTruthy();
  });

  it("covers every part of the model a reader might come looking for", () => {
    renderPanel();
    const text = detailText();
    // Paycheck withholding, worked out from the paycheck and never rewriting an earlier one.
    expect(text).toMatch(/withhold/i);
    expect(text).toMatch(/rewrites a paycheck you have already been paid/i);
    // Multiple jobs — the assumed W-4 adjustment, carried on one job, and NOT employer collusion.
    expect(text).toMatch(/more than one job/i);
    expect(text).toMatch(/highest-paying/i);
    expect(text).toMatch(/not employers quietly sharing payroll information/i);
    // Bonuses, withheld their own way and never read as a raise.
    expect(text).toMatch(/bonus/i);
    expect(text).toMatch(/never makes later ordinary paychecks look as though your salary had permanently gone up/i);
    // The year's liability as the authoritative figure.
    expect(text).toMatch(/actual federal income tax/i);
    expect(text).toMatch(/authoritative/i);
    // The following April, both directions.
    expect(text).toMatch(/April/);
    expect(text).toMatch(/refund/i);
    expect(text).toMatch(/payment/i);
    // FICA, per employer, and both filing-time consequences of that.
    expect(text).toMatch(/Social Security/);
    expect(text).toMatch(/Medicare/);
    expect(text).toMatch(/per employer/i);
    expect(text).toMatch(/more Social Security taken out than you actually owe/i);
  });

  it("describes non-payroll income as a modelling choice, not as a fact about tax law", () => {
    // The claim "a retirement withdrawal never has tax withheld" would be false in general, and
    // the panel must not make it — MODEL_ASSUMPTIONS states the same thing the same way.
    renderPanel();
    const text = detailText();
    expect(text).toMatch(/In Finley they do not have tax withheld/i);
    expect(text).toMatch(/modelling choice rather than a rule of tax law/i);
  });

  it("keeps statutory figures out of the prose — those belong to the rules layer", () => {
    // A dollar amount or a percentage written here is a second source of truth that indexes
    // forward every year while the prose stays put.
    renderPanel();
    expect(detailText()).not.toMatch(/\$[\d,]|\d\s?%/);
  });
});

describe("TaxExplainer — the assumptions section beside it", () => {
  it("renders every assumption it is given, exactly once", () => {
    renderPanel();
    expect(screen.getByRole("heading", { name: /simplifications and assumptions/i })).toBeTruthy();
    for (const assumption of ASSUMPTIONS) {
      expect(screen.getAllByText(assumption.text)).toHaveLength(1);
    }
  });

  it("does not restate an assumption inside the Detailed section", () => {
    // The two sections answer different questions — what the model does, and where it knowingly
    // differs from reality. Rendering an assumption's text in both would blur that and make the
    // panel twice as long as it needs to be.
    renderPanel();
    const text = detailText();
    for (const assumption of ASSUMPTIONS) {
      expect(text).not.toContain(assumption.text);
    }
  });

  it("drops the whole section when a jurisdiction discloses nothing", () => {
    renderPanel([]);
    expect(screen.queryByRole("heading", { name: /simplifications and assumptions/i })).toBeNull();
    // The explanation itself is not conditional on there being any.
    expect(screen.getByRole("heading", { name: "How we calculate your taxes" })).toBeTruthy();
  });
});
