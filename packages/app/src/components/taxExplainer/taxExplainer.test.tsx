/**
 * @vitest-environment jsdom
 *
 * The tax explanation panel. Two things are being pinned: the LAYERING — the whole panel shut by
 * default, a short explanation once it is opened, and each mechanism behind a further disclosure
 * of its own — and the DIVISION of labour between the panel's two sections, so a reader is never
 * told the same thing twice under two headings.
 *
 * The copy itself is asserted by topic rather than by sentence: these check that a section covers
 * its concept, not that it covers it in any particular words, so the prose can be improved without
 * a test failing for it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ModelAssumption } from "@finley/engine";
import { TaxExplainer } from "./taxExplainer";

/** Stand-ins for the real disclosures, which the engine and the jurisdiction declare. */
const ASSUMPTIONS: readonly ModelAssumption[] = [
  { id: "postTaxOpeningBasis", text: "Money already in a post-tax account is treated as principal." },
  { id: "w4AssumedDefault", text: "A Form W-4 is assumed, filing single and claiming nothing." },
];

const renderPanel = (assumptions: readonly ModelAssumption[] = ASSUMPTIONS) =>
  render(<TaxExplainer assumptions={assumptions} />);

/** A disclosure, found by the heading in its own `<summary>` rather than by a class. */
const disclosure = (name: string | RegExp): HTMLDetailsElement =>
  screen.getByRole("heading", { name }).closest("details") as HTMLDetailsElement;

const outer = (): HTMLDetailsElement => disclosure("Implementation Details");

/**
 * A disclosure's prose as one line. JSX breaks a sentence across source lines wherever it happens
 * to wrap, so the assertions below would otherwise be pinned to the formatter's choices.
 */
const textOf = (details: HTMLDetailsElement): string => details.textContent!.replace(/\s+/g, " ");

/** Every topic disclosure the panel offers, by the heading each is opened with. */
const TOPICS = [
  "Paycheck withholding",
  "Multiple jobs",
  "Bonuses",
  "Income outside payroll",
  "The tax you owe for the year",
  "The April settlement",
  "Social Security and Medicare",
] as const;

afterEach(cleanup);

describe("TaxExplainer — the outermost disclosure", () => {
  it("is closed on arrival, so the panel costs a line until someone wants it", () => {
    renderPanel();
    expect(outer().open).toBe(false);
  });

  it("opens on its own control, which names the section it reveals", () => {
    renderPanel();
    const control = screen.getByRole("heading", { name: "Implementation Details" }).parentElement!;
    expect(control.tagName).toBe("SUMMARY");
    // `<details>` carries the expanded state on the element itself, which is what assistive
    // technology reads — there is no `aria-expanded` to keep in sync and none is added.
    expect(outer().hasAttribute("open")).toBe(false);
    fireEvent.click(control);
    expect(outer().hasAttribute("open")).toBe(true);
  });

  it("leads with the short explanation, above any further disclosure", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("heading", { name: "Implementation Details" }).parentElement!);
    expect(screen.getByRole("heading", { name: "How we calculate your taxes" })).toBeTruthy();
    // The one idea the whole panel rests on: liability and withholding are different things.
    expect(textOf(outer())).toMatch(/tax you owe.*tax taken out/i);
  });

  it("says its short piece without jargon a reader would have to look up", () => {
    renderPanel();
    // The short explanation is everything between its heading and the first topic disclosure.
    const short = textOf(outer()).split(TOPICS[0])[0]!;
    for (const jargon of [/W-4/, /Form 8959/, /Schedule 3/, /Publication 15/, /supplemental/i, /FICA/, /wage base/i]) {
      expect(short).not.toMatch(jargon);
    }
  });
});

describe("TaxExplainer — the topic disclosures inside it", () => {
  it("offers one per mechanism, each shut until it is asked for", () => {
    renderPanel();
    for (const topic of TOPICS) {
      expect(disclosure(topic).open).toBe(false);
    }
  });

  it("expands a single topic without expanding its siblings", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("heading", { name: "Bonuses" }).parentElement!);
    expect(disclosure("Bonuses").open).toBe(true);
    for (const topic of TOPICS.filter((t) => t !== "Bonuses")) {
      expect(disclosure(topic).open).toBe(false);
    }
  });

  it("explains withholding as causal — from this paycheck, never rewriting an earlier one", () => {
    renderPanel();
    const text = textOf(disclosure("Paycheck withholding"));
    expect(text).toMatch(/withhold/i);
    expect(text).toMatch(/one month is treated as one pay period/i);
    expect(text).toMatch(/rewrites a paycheck you have already been paid/i);
  });

  it("explains multiple jobs as an assumed W-4 adjustment, NOT employers comparing notes", () => {
    renderPanel();
    const text = textOf(disclosure("Multiple jobs"));
    expect(text).toMatch(/more than one job/i);
    expect(text).toMatch(/highest-paying/i);
    expect(text).toMatch(/not employers quietly sharing payroll information/i);
  });

  it("explains a bonus as withheld its own way and never read as a raise", () => {
    renderPanel();
    const text = textOf(disclosure("Bonuses"));
    expect(text).toMatch(/supplemental pay/i);
    expect(text).toMatch(/never makes later ordinary paychecks look as though your salary had permanently gone up/i);
  });

  it("names the annual liability as the authoritative figure", () => {
    renderPanel();
    const text = textOf(disclosure("The tax you owe for the year"));
    expect(text).toMatch(/actual federal income tax/i);
    expect(text).toMatch(/authoritative/i);
  });

  it("explains the April settlement in both directions, without calling it a correction", () => {
    renderPanel();
    const text = textOf(disclosure("The April settlement"));
    expect(text).toMatch(/refund/i);
    expect(text).toMatch(/payment/i);
    expect(text).toMatch(/does not go back and change any earlier month/i);
  });

  it("explains FICA per employer, and both filing-time consequences of that", () => {
    renderPanel();
    const text = textOf(disclosure("Social Security and Medicare"));
    expect(text).toMatch(/per employer/i);
    expect(text).toMatch(/Medicare has no cap/i);
    expect(text).toMatch(/more Social Security taken out than you actually owe/i);
    expect(text).toMatch(/no single employer withheld any/i);
  });

  it("describes non-payroll income as a modelling choice, not as a fact about tax law", () => {
    // The claim "a retirement withdrawal never has tax withheld" would be false in general, and
    // the panel must not make it — MODEL_ASSUMPTIONS states the same thing the same way.
    renderPanel();
    const text = textOf(disclosure("Income outside payroll"));
    expect(text).toMatch(/In Finley they do not have tax withheld/i);
    expect(text).toMatch(/modelling choice rather than a rule of tax law/i);
  });

  it("keeps statutory figures out of the prose — those belong to the rules layer", () => {
    // A dollar amount or a percentage written here is a second source of truth that indexes
    // forward every year while the prose stays put.
    renderPanel();
    expect(textOf(outer())).not.toMatch(/\$[\d,]|\d\s?%/);
  });
});

describe("TaxExplainer — the assumptions section beside it", () => {
  it("is its own disclosure, shut like the rest, and renders each assumption exactly once", () => {
    renderPanel();
    expect(disclosure(/simplifications and assumptions/i).open).toBe(false);
    for (const assumption of ASSUMPTIONS) {
      expect(screen.getAllByText(assumption.text)).toHaveLength(1);
    }
  });

  it("does not restate an assumption in any topic section", () => {
    // The two answer different questions — what the model does, and where it knowingly differs
    // from reality. Rendering an assumption's text in both would blur that and double the panel.
    renderPanel();
    for (const topic of TOPICS) {
      const text = textOf(disclosure(topic));
      for (const assumption of ASSUMPTIONS) {
        expect(text).not.toContain(assumption.text);
      }
    }
  });

  it("drops the whole section when a jurisdiction discloses nothing", () => {
    renderPanel([]);
    expect(screen.queryByRole("heading", { name: /simplifications and assumptions/i })).toBeNull();
    // The explanation itself is not conditional on there being any.
    expect(screen.getByRole("heading", { name: "How we calculate your taxes" })).toBeTruthy();
  });
});
