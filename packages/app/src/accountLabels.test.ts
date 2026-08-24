/**
 * @vitest-environment node
 *
 * Naming an account once there is more than one person who could own one.
 */
import { describe, it, expect } from "vitest";
import { SYNTHETIC_CARD_ID, type Household, type PlanAccountDescriptor } from "@finley/engine";
import { accountLabelsFor, accountOwnersFor, liabilityLabelsFor } from "./accountLabels";

const ACCOUNTS = [
  { id: "savings", label: "Cash savings", kind: "cash", ownerId: "p1" },
  { id: "retirement", label: "Retirement account", kind: "retirement", ownerId: "p1" },
  { id: "fund-goal-1", label: "Emergency fund", kind: "goal", ownerId: "p1" },
  { id: "savings-p2", label: "Blake — Cash savings", kind: "cash", ownerId: "p2" },
] as unknown as PlanAccountDescriptor[];

const SOLO = new Map([["p1", "Alex"]]);
const COUPLE = new Map([
  ["p1", "Alex"],
  ["p2", "Blake"],
]);

describe("accountLabelsFor", () => {
  it("leaves every label as authored in a household of one", () => {
    // There is nobody to distinguish them from, so a possessive would be pure noise.
    const labels = accountLabelsFor(ACCOUNTS, SOLO);
    expect(labels.get("savings")).toBe("Cash savings");
    expect(labels.get("retirement")).toBe("Retirement account");
  });

  it("names the owner once there are two people", () => {
    const labels = accountLabelsFor(ACCOUNTS, COUPLE);
    expect(labels.get("savings")).toBe("Alex’s cash savings");
    expect(labels.get("retirement")).toBe("Alex’s retirement account");
  });

  it("does not qualify a partner's account twice", () => {
    // A partner's account is compiled with its owner already in the label, for the whole-plan
    // charts that have no roster to hand. Naming it again gave "Blake's Blake — Cash savings".
    expect(accountLabelsFor(ACCOUNTS, COUPLE).get("savings-p2")).toBe("Blake’s cash savings");
  });

  it("leaves a goal fund impersonal", () => {
    // A goal is the household's purpose, not a person's holding.
    expect(accountLabelsFor(ACCOUNTS, COUPLE).get("fund-goal-1")).toBe("Emergency fund");
  });

  it("leaves an account whose owner the roster cannot name alone", () => {
    // An unnameable owner is a holding this roster cannot speak for — not grounds for building a
    // possessive out of an internal id.
    const orphan = [
      { id: "savings-p9", label: "Cash savings", kind: "cash", ownerId: "p9" },
    ] as unknown as PlanAccountDescriptor[];
    expect(accountLabelsFor(orphan, COUPLE).get("savings-p9")).toBe("Cash savings");
  });
});

describe("accountOwnersFor", () => {
  it("answers who holds each account", () => {
    const owners = accountOwnersFor(ACCOUNTS);
    expect(owners.get("savings")).toBe("p1");
    expect(owners.get("savings-p2")).toBe("p2");
  });
});

/** Just the liability list — the only part of a household these labels are built from. */
const householdWith = (
  liabilities: readonly { id: string; kind: string; ownerId: string }[],
): Household => ({ liabilities } as unknown as Household);

describe("liabilityLabelsFor", () => {
  it("gives the engine's own last-resort borrowing a name a person would use", () => {
    // Nobody authored it, so it has no label of its own and the balances list printed the id:
    // "synthetic-credit-card (owed)" names an implementation detail at the reader.
    const labels = liabilityLabelsFor(householdWith([]), SOLO);
    expect(labels.get(SYNTHETIC_CARD_ID)).toBe("Credit card");
  });

  it("names a debt by its kind in a household of one", () => {
    const labels = liabilityLabelsFor(
      householdWith([{ id: "loan-1", kind: "auto", ownerId: "p1" }]),
      SOLO,
    );
    expect(labels.get("loan-1")).toBe("Auto loan");
  });

  it("qualifies a debt by its owner once two people could carry one", () => {
    // Two partners can each have an auto loan; without the owner the two rows are one sentence.
    const labels = liabilityLabelsFor(
      householdWith([
        { id: "loan-1", kind: "auto", ownerId: "p1" },
        { id: "loan-2", kind: "auto", ownerId: "p2" },
      ]),
      COUPLE,
    );
    expect(labels.get("loan-1")).toBe("Alex — Auto loan");
    expect(labels.get("loan-2")).toBe("Blake — Auto loan");
  });

  it("never attributes the synthetic card to a person", () => {
    // It is the household's borrowing of last resort, not anybody's card.
    const labels = liabilityLabelsFor(
      householdWith([{ id: "loan-1", kind: "auto", ownerId: "p2" }]),
      COUPLE,
    );
    expect(labels.get(SYNTHETIC_CARD_ID)).toBe("Credit card");
  });
});
