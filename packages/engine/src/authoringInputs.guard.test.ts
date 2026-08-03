/**
 * The API boundary, asserted rather than described: **a caller-supplied id enters this engine
 * only through persisted-state restoration.**
 *
 *   - `Projection.fromInput` authors a new scenario and mints every identity.
 *   - `Projection.fromState` restores identities that were issued earlier.
 *   - An editing method may take an existing id as the TARGET it addresses, but nothing it is
 *     handed may replace that id or any identity nested under it.
 *
 * Two checks, because they fail in different ways. The type-level half proves the compiler
 * rejects the exact shapes that used to be accepted; the source scan proves a NEW input type
 * cannot be added with an `id` field and quietly go uncovered by the first half.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Projection } from "./index";
import { SAMPLE_START_YEAR } from "./testing/samplePlan";
import { ref } from "./scenarioInput";
import { PRIMARY_PERSON_REF } from "./scenarioRefs";
import type { PersonId } from "./job";
import type { JobEntry, ScenarioInput } from "./scenarioInput";

const P1 = "p1" as PersonId;

const openEndedJob = {
  startYear: SAMPLE_START_YEAR,
  endYear: null,
  salary: { startingSalaryCents: 100_000_00, currentSalaryCents: 100_000_00, realGrowthPct: 0 },
} as const;

const expenseLine = {
  label: "Rent",
  target: { kind: "expense" } as const,
  amountSource: { kind: "literal" as const, monthlyCents: 200_000 },
  category: "needs" as const,
};

const carGoal = {
  name: "Car",
  targetCents: 30_000_00,
  targetDate: 36,
  disposition: "retain" as const,
  annualReturnPct: 3,
};

/**
 * Never called — only type-checked. Each `@ts-expect-error` asserts the compiler REJECTS the
 * line below it, so if an input ever grows an `id` back the directive goes unused and the build
 * fails. Running these would be beside the point (and several would throw for unrelated
 * reasons), so the body stays unexecuted.
 */
function shapesTheCompilerMustReject(p: Projection): void {
  // Standing edits.
  // @ts-expect-error — a job's id is the engine's; a caller cannot name one into existence
  p.addJob(P1, { ...openEndedJob, id: "stolen" });
  // @ts-expect-error — a budget line's id is the engine's
  p.addBudgetLine({ ...expenseLine, id: "stolen" });
  // @ts-expect-error — a goal's id is the engine's
  p.addGoal({ ...carGoal, id: "stolen" });
  // @ts-expect-error — replacing a job keeps the id it already has
  p.replaceJob("job-1", { ...openEndedJob, id: "stolen" });
  // @ts-expect-error — a job cannot change owner; an edit patch names no `ownerId`
  p.updateJob("job-1", { ownerId: P1 });
  // @ts-expect-error — a partner's job is minted like any other
  p.addPartnerJob(P1, { ...openEndedJob, id: "stolen" });

  // Transactions.
  // @ts-expect-error — the person a marriage creates is named by the engine
  p.marry({ month: 24, name: "Sam", birthYear: 1988, id: "stolen" });
  // @ts-expect-error — a child's id is the engine's
  p.haveChild({ month: 12, name: "Robin", annualCostCents: 0, id: "stolen" });
  // @ts-expect-error — a liability's id is the engine's
  p.takeLoan({ month: 3, ownerId: P1, kind: "auto", openingBalanceCents: 1, apr: 4, termMonths: 12, id: "stolen" });
  // @ts-expect-error — a property's id (and its derived mortgage's) is the engine's
  p.buyHome({ month: 12, ownerId: P1, purchasePriceCents: 1, downPaymentCents: 1, downPaymentSourceIds: [], mortgageApr: 6, mortgageTermMonths: 360, id: "stolen" });
  // @ts-expect-error — a separation event's id is the engine's
  p.separate({ month: 36, partnerPersonId: P1, id: "stolen" });
  // @ts-expect-error — a payoff event's id is the engine's
  p.payOffDebt({ month: 6, liabilityId: "l", accountId: "savings", amountCents: 1, id: "stolen" });

  // Revisions: data only, no identity of any depth.
  // @ts-expect-error — a revision cannot rename the event
  p.reviseTransaction("e1", { type: "marry", id: "stolen" });
  // @ts-expect-error — a revision cannot replace the person a marriage created
  p.reviseTransaction("e1", { type: "marry", person: { id: "stolen" } });
  // @ts-expect-error — a revision cannot replace the nested job list
  p.reviseTransaction("e1", { type: "marry", jobs: [] });
  // @ts-expect-error — a revision cannot re-point a liability
  p.reviseTransaction("e1", { type: "takeLoan", liabilityId: "stolen" });
  // @ts-expect-error — a revision cannot re-point a child
  p.reviseTransaction("e1", { type: "haveChild", childId: "stolen" });
  // @ts-expect-error — a revision cannot re-point a property or its mortgage
  p.reviseTransaction("e1", { type: "buyHome", mortgageLiabilityId: "stolen" });
}

describe("the authoring API accepts no caller-supplied id — type level", () => {
  it("rejects every id-bearing authoring shape at compile time", () => {
    // The assertions are the `@ts-expect-error` directives above, enforced by `npm run
    // typecheck`. This keeps the function referenced so it cannot be dropped as dead code.
    expect(typeof shapesTheCompilerMustReject).toBe("function");
  });

  it("refuses an `id` anywhere in a ScenarioInput", () => {
    const base = {
      name: "T", startYear: 2026, openingBalanceCents: 0, savingsReturnPct: 1,
      retirementReturnPct: 5, brokerageReturnPct: 5, sharedScheme: "proportional" as const,
      inflationPct: 2, currentAge: 30, retirementAge: 65,
      lifeExpectancy: 90, benefitClaimingAge: 67,
    };

    const withJobId: ScenarioInput = {
      ...base,
      // @ts-expect-error — a job entry names no id
      jobs: [{ ...openEndedJob, id: "stolen" }],
    };
    const withLineId: ScenarioInput = {
      ...base,
      // @ts-expect-error — a budget line entry names no id
      budgetLines: [{ ...expenseLine, id: "stolen" }],
    };
    const withGoalId: ScenarioInput = {
      ...base,
      // @ts-expect-error — a goal entry names no id
      goals: [{ ...carGoal, id: "stolen" }],
    };
    const withEventId: ScenarioInput = {
      ...base,
      events: [
        // @ts-expect-error — an event entry names no id, only a build-time ref
        { type: "takeLoan", id: "stolen", month: 0, ownerRef: PRIMARY_PERSON_REF,
          kind: "studentLoan", openingBalanceCents: 1, apr: 4, termMonths: 12 },
      ],
    };

    // A `ref` is the supported way to name something, and it never lands in state.
    const withRef: ScenarioInput = {
      ...base,
      jobs: [{ ...openEndedJob, ref: ref("dayJob") }],
    };

    for (const input of [withJobId, withLineId, withGoalId, withEventId, withRef]) {
      expect(input.startYear).toBe(2026);
    }
  });

  it("refuses an `ownerRef` on a job nested in a marry", () => {
    const base = {
      name: "T", startYear: 2026, openingBalanceCents: 0, savingsReturnPct: 1,
      retirementReturnPct: 5, brokerageReturnPct: 5, sharedScheme: "proportional" as const,
      inflationPct: 2, currentAge: 30, retirementAge: 65,
      lifeExpectancy: 90, benefitClaimingAge: 67,
    };

    // A nested job belongs to the partner the same entry creates, and that person does not exist
    // until the marriage applies — so there is nothing an author could name. The field used to be
    // accepted and then dropped by `toJobInput`, which meant a stated owner was silently
    // overwritten AND `resolveRefs` still demanded it resolve. `PartnerJobEntry` omits it.
    const nestedOwner: ScenarioInput = {
      ...base,
      events: [
        {
          type: "marry", month: 12, name: "Sam", birthYear: 1994,
          // @ts-expect-error — a partner's job cannot name an owner
          jobs: [{ ...openEndedJob, ownerRef: PRIMARY_PERSON_REF }],
        },
      ],
    };

    // The same, arriving through a VARIABLE rather than a fresh literal. Excess-property
    // checking does not apply to these, so a bare `Omit<JobEntry, "ownerRef">` would let this
    // assign structurally and drop the owner in silence. `ownerRef?: never` is what refuses it.
    const authoredElsewhere: JobEntry = { ...openEndedJob, ownerRef: PRIMARY_PERSON_REF };
    const nestedOwnerViaVariable: ScenarioInput = {
      ...base,
      events: [
        {
          type: "marry", month: 12, name: "Sam", birthYear: 1994,
          // @ts-expect-error — a partner's job cannot name an owner, however it is passed
          jobs: [authoredElsewhere],
        },
      ],
    };

    // A plan-plane job still may: that owner exists before the entry applies. Through a variable
    // too — the tightening is confined to the nested position.
    const planOwner: ScenarioInput = {
      ...base,
      jobs: [{ ...openEndedJob, ownerRef: PRIMARY_PERSON_REF }],
    };
    const planOwnerViaVariable: ScenarioInput = { ...base, jobs: [authoredElsewhere] };

    // Everything else about a nested job is unchanged — a ref and a deferral still ride along.
    const nestedRest: ScenarioInput = {
      ...base,
      events: [
        {
          type: "marry", month: 12, name: "Sam", birthYear: 1994,
          jobs: [{ ...openEndedJob, ref: ref("samJob"), deferral: { deferralFraction: 0.05 } }],
        },
      ],
    };

    for (const input of [
      nestedOwner,
      nestedOwnerViaVariable,
      planOwner,
      planOwnerViaVariable,
      nestedRest,
    ]) {
      expect(input.startYear).toBe(2026);
    }
  });
});

/**
 * The breadth check. A `@ts-expect-error` only covers a shape someone thought to write down;
 * this covers every authoring type there is, including ones added later — and, since each input
 * is declared beside the module that applies it, wherever in the package it is declared.
 *
 * "Authoring type" is decided by two readings, unioned, because either alone leaks:
 *
 *  - **Declared in the authoring vocabulary** — under `authoring/`, or in `scenarioInput.ts`.
 *    This is what catches an entry `index.ts` does not publish by name: `PartnerJobEntry` and
 *    the per-verb `*Entry` shapes reach a caller only through the `EventEntry` union, so a
 *    surface-only reading would scan the union and miss the members.
 *  - **Published by the export map** — so an input declared somewhere new is covered the
 *    moment it becomes reachable, which it must be to be an input the API accepts.
 *
 * A whole-tree scan is what neither can be: `BalanceEntry` and `WaterfallInput` are simulator
 * internals that legitimately carry an `id`, and nobody authors with them.
 */
describe("the authoring API accepts no caller-supplied id — source scan", () => {
  const engineSrc = fileURLToPath(new URL("./", import.meta.url));
  const read = (name: string) =>
    readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

  /** Every non-test source file in the package, as `[repo-relative path, text]`. */
  function sourceFiles(dir: string): { path: string; source: string }[] {
    const out: { path: string; source: string }[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
      else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
        out.push({
          path: relative(engineSrc, full).replaceAll("\\", "/"),
          source: readFileSync(full, "utf8"),
        });
      }
    }
    return out;
  }

  /** Modules whose job IS to declare authoring vocabulary — scanned whole. */
  const AUTHORING_MODULES = (path: string) =>
    path.startsWith("authoring/") || path === "scenarioInput.ts";

  /** Every name the export map republishes — the package's whole public surface. */
  function publishedNames(): Set<string> {
    const names = new Set<string>();
    const source = read("./index.ts");
    for (const match of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"[^"]*"/gs)) {
      for (const part of match[1].split(",")) {
        const name = part.trim();
        if (name !== "") names.add(name.replace(/^type\s+/, "").split(" as ").pop()!.trim());
      }
    }
    return names;
  }

  /**
   * Every authoring type in the package, by both readings — deduped by name, since a published
   * one is also declared somewhere.
   */
  function allAuthoringTypes(): [string, string][] {
    const published = publishedNames();
    const byName = new Map<string, string>();
    for (const { path, source } of sourceFiles(engineSrc)) {
      const inVocabulary = AUTHORING_MODULES(path);
      for (const [name, body] of authoringTypes(source)) {
        if (inVocabulary || published.has(name)) byName.set(name, body);
      }
    }
    return [...byName];
  }

  /**
   * Every exported `*Input` / `*Entry` / `*Revision` declaration, as `[name, body]`. Brace
   * counting rather than a lazy regex, so a nested object literal inside a declaration does
   * not end it early.
   */
  function authoringTypes(source: string): [string, string][] {
    const found: [string, string][] = [];
    const header = /^export\s+(?:type|interface)\s+(\w*(?:Input|Entry|Revision))\b/gm;
    for (const match of source.matchAll(header)) {
      const name = match[1];
      // `ScenarioInput` is the document, and its id-bearing collections are the entries above,
      // each scanned in its own right.
      const from = match.index! + match[0].length;
      let depth = 0;
      let end = from;
      for (let i = from; i < source.length; i++) {
        const c = source[i];
        if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        } else if (c === ";" && depth === 0) {
          end = i;
          break;
        }
      }
      found.push([name, source.slice(from, end + 1)]);
    }
    return found;
  }

  /** A field literally named `id` — not `liabilityId`, not `downPaymentSourceIds`. */
  const DECLARES_ID = /(?:^|[{;\n])\s*(?:readonly\s+)?id\??\s*:/;

  it("finds the authoring types, so a broken scan cannot pass by matching nothing", () => {
    const names = allAuthoringTypes().map(([name]) => name);

    // The ones this rule exists for, named outright so a rename cannot silently drop coverage.
    // `PartnerJobEntry` is here because it is reachable only through the `EventEntry` union —
    // the case that proves the scan reads declarations, not just the published surface.
    for (const required of [
      "JobInput", "BudgetLineInput", "GoalInput", "MarryInput", "HaveChildInput",
      "TakeLoanInput", "BuyHomeInput", "SeparateInput", "PayOffDebtInput", "TransactionRevision",
      "JobEntry", "PartnerJobEntry", "GoalEntry", "BudgetLineEntry", "EventEntry", "ScenarioInput",
    ]) {
      expect(names).toContain(required);
    }
  });

  it("declares no `id` field on any authoring input", () => {
    const offenders = allAuthoringTypes()
      .filter(([, body]) => DECLARES_ID.test(body))
      .map(([name]) => name);

    expect(offenders).toEqual([]);
  });

  it("scans past the module the inputs used to share, wherever they are declared now", () => {
    // Each input lives beside the module that applies it, so the scan must reach more than one
    // file — a regression to a single-file read would still find `ScenarioInput` and pass.
    const names = allAuthoringTypes().map(([name]) => name);
    expect(names).toContain("BuyHomeInput");
    expect(names).toContain("JobInput");
    // …and it must NOT drag in the simulator internals that legitimately carry an `id`.
    expect(names).not.toContain("BalanceEntry");
    expect(names).not.toContain("WaterfallInput");
  });

  it("keeps the scan honest — it does fire on a declaration that names an id", () => {
    const [, body] = authoringTypes(
      'export interface SneakyInput {\n  readonly month: number;\n  readonly id?: string;\n}',
    )[0];
    expect(DECLARES_ID.test(body)).toBe(true);
    // …and not on the id-SHAPED field names that legitimately point at existing entities.
    expect(DECLARES_ID.test("  readonly liabilityId: string;\n")).toBe(false);
    expect(DECLARES_ID.test("  readonly downPaymentSourceIds: readonly string[];\n")).toBe(false);
    expect(DECLARES_ID.test("  readonly ownerId: PersonId;\n")).toBe(false);
  });
});
