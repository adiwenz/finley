/**
 * @vitest-environment node
 *
 * Naming an account once there is more than one person who could own one.
 */
import { describe, it, expect } from "vitest";
import type { PlanAccountDescriptor } from "@finley/engine";
import { accountLabelsFor, accountOwnersFor } from "./accountLabels";

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
