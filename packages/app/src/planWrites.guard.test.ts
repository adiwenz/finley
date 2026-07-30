/**
 * The write-path guard: in app production code, a `Plan` is read, never rebuilt.
 *
 * Every authored edit goes through `Projection` — it owns the id mint, the goal-funding
 * guard, the ledger's affordability gate and the counter floor. A panel that reassembles
 * `{ ...plan, goals: … }` and hands the result back to React reopens the second write path
 * this migration closed, and nothing else would notice: the app would simply stop enforcing
 * rules it no longer routes through.
 *
 * Scanned as source text rather than types, because the shape being banned is a *spread*, and
 * a spread has no signature to constrain. Four things are checked:
 *
 *  1. No `setBudget` — the plan setter itself.
 *  2. No plan-shaped setter prop under another name (`Dispatch<SetStateAction<Plan>>`).
 *  3. No expression rebuilding a plan's collections, or swapping one into a scenario.
 *  4. No function that produces a `Plan` at all — a write path whatever it does inside.
 *
 * Seed data and test fixtures are exempt by location, not by name: {@link SEED_MODULES} state
 * a starting plan (nothing is being *edited*), and `src/testing/` is not shipped. Both are
 * listed here so adding one is a deliberate act with a reason beside it.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const appSrc = fileURLToPath(new URL("./", import.meta.url));

/**
 * Modules that declare a plan rather than edit one: the default plan a fresh session opens
 * on, the starter scenarios, and the budget template they are built from. Each states a
 * whole `Plan` (or a whole list of lines) as literal data — there is no prior plan being
 * revised, so there is no write to route through the facade.
 */
const SEED_MODULES = [
  "planDefaults.ts",
  "presets.ts",
  "components/baseAdjustments/budgetTemplate.ts",
];

/** Not shipped: harnesses and plan-shaped fixture builders the tests author with. */
const TEST_ONLY_DIRS = ["testing/"];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "assets" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Every app module that ships, minus the seed data and the test-only helpers. */
function productionModules(): { path: string; source: string }[] {
  return sourceFiles(appSrc)
    .map((full) => ({ path: relative(appSrc, full).replaceAll("\\", "/"), full }))
    .filter(({ path }) => !SEED_MODULES.includes(path))
    .filter(({ path }) => !TEST_ONLY_DIRS.some((dir) => path.startsWith(dir)))
    .map(({ path, full }) => ({ path, source: readFileSync(full, "utf8") }));
}

/** Comments stripped, so prose describing the old shape can't fail the scan. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * A spread rebuilding a plan collection: `{ ...plan, goals: … }`, `{ ...p, budgetLines: … }`.
 * `goals` and `budgetLines` belong to nothing else the app holds, so the key alone identifies
 * the shape whatever the spread source is called.
 */
const PLAN_REBUILD = /\{\s*\.\.\.\s*\w+\s*,\s*(goals|budgetLines)\s*:/;

/**
 * The same for `jobs`, qualified by the source's name. A `jobs` field is not plan-only — an
 * authoring draft and a `Person` each carry one — so an unqualified match would flag a form
 * appending to its own draft. The plan-shaped names are the ones a plan travels under.
 */
const PLAN_JOBS_REBUILD = /\{\s*\.\.\.\s*(plan|budget|current|prev|state)\s*,\s*jobs\s*:/;

/**
 * A function in the app layer that *produces* a `Plan` is a write path by construction,
 * whatever it does inside. Only the seed modules declare one.
 */
const PLAN_PRODUCER = /\)\s*:\s*Plan\s*[{;]/;

/**
 * Swapping the plan (or ledger) into a scenario wholesale. `Projection` does this internally;
 * an app module doing it is holding the state open and writing to it directly.
 */
const SCENARIO_REBUILD = /\b(withPlan|withLedger)\s*\(/;

describe("app write path — no direct plan writes outside the facade", () => {
  it("scans a plausible number of modules (the scan itself must not silently empty)", () => {
    // A broken path filter would pass every assertion below by checking nothing.
    expect(productionModules().length).toBeGreaterThan(30);
  });

  it("has no `setBudget` anywhere in app production code", () => {
    const offenders = productionModules()
      .filter(({ source }) => code(source).includes("setBudget"))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it("has no plan-shaped setter prop left forwarding one", () => {
    // `Dispatch<SetStateAction<Plan>>` is the type the removed prop travelled as; a panel
    // holding one again is holding a plan setter under a different name.
    const offenders = productionModules()
      .filter(({ source }) => /SetStateAction\s*<\s*Plan\s*>/.test(code(source)))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it("rebuilds neither a plan's collections nor a scenario", () => {
    const offenders = productionModules()
      .filter(({ source }) => {
        const src = code(source);
        return PLAN_REBUILD.test(src) || PLAN_JOBS_REBUILD.test(src) || SCENARIO_REBUILD.test(src);
      })
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it("declares no function that produces a plan", () => {
    const offenders = productionModules()
      .filter(({ source }) => PLAN_PRODUCER.test(code(source)))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it("keeps the guard honest — the patterns do fire on the shape they ban", () => {
    expect(PLAN_REBUILD.test("setBudget((p) => ({ ...p, goals: next(p.goals) }))")).toBe(true);
    expect(PLAN_REBUILD.test("return { ...plan, budgetLines: [...lines] };")).toBe(true);
    expect(PLAN_JOBS_REBUILD.test("return { ...plan, jobs: mapJob(plan.jobs, id, f) };")).toBe(true);
    expect(SCENARIO_REBUILD.test("withPlan(s.scenario, nextPlan)")).toBe(true);
    expect(PLAN_PRODUCER.test("export function addJobFromDraft(plan: Plan): Plan {")).toBe(true);
    // …and not on an unrelated spread, nor on a form appending to its own draft.
    expect(PLAN_REBUILD.test("return { ...draft, label: draft.label.trim() };")).toBe(false);
    expect(PLAN_JOBS_REBUILD.test("setDraft((d) => ({ ...d, jobs: [...d.jobs, job] }))")).toBe(
      false,
    );
  });
});
