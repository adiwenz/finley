/**
 * The write-path guard: in app production code, authored state is read, never rebuilt.
 *
 * Every authored edit goes through `Projection` — it owns the id mint, the goal-funding
 * guard, the ledger's affordability gate and the counter floor. A panel that reassembles
 * `{ ...plan, goals: … }` and hands the result back to React reopens the second write path
 * this migration closed, and nothing else would notice: the app would simply stop enforcing
 * rules it no longer routes through.
 *
 * Both planes are covered, because a household member's jobs live on one or the other and the
 * hazard is the same on each: the primary person's on `Plan.jobs`, a partner's on the `person`
 * embedded in their `RelationshipEvent`.
 *
 * Scanned as source text rather than types, because the shapes being banned are a *spread* and
 * a *template literal*, neither of which has a signature to constrain. Six things are checked:
 *
 *  1. No plan-shaped setter prop (`Dispatch<SetStateAction<Plan>>`).
 *  2. No expression rebuilding a plan's collections, or swapping one into a scenario.
 *  3. No function that produces a `Plan` at all — a write path whatever it does inside.
 *  4. No rebuilding of a partner's `jobs` on the event that carries them.
 *  5. No minted job id — one counter inside `Projection` issues every one, on both planes.
 *  6. Nothing named from `@finley/engine` that `projectionRoot.ts` does not export — the app's
 *     whole engine surface is the facade module, values and types alike.
 *
 * (6) is the general rule the others are specific cases of, and it is checked against the
 * facade module's own text rather than a list kept here: widening what the app may name means
 * editing `projectionRoot.ts` and justifying it there, where the surface is. Two things follow
 * from stating it that way. Nothing that WRITES can be imported, because nothing that writes
 * is exported there — asserted directly below, so the rule cannot be satisfied by a facade
 * that quietly re-exports `withPayChange`. And no simulator internal can enter the app's
 * vocabulary, because types are scanned beside values.
 *
 * Seed data and test fixtures are exempt by location, not by name: {@link SEED_MODULES} state
 * a starting plan (nothing is being *edited*), and `src/testing/` is not shipped. Seeds are
 * exempt from (1)–(5) only — declaring a plan is no reason to reach around the facade for the
 * vocabulary to declare it in. Both lists are here so adding to one is a deliberate act with a
 * reason beside it.
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

/** Every app module that ships. */
function shippedModules(): { path: string; source: string }[] {
  return sourceFiles(appSrc)
    .map((full) => ({ path: relative(appSrc, full).replaceAll("\\", "/"), full }))
    .filter(({ path }) => !TEST_ONLY_DIRS.some((dir) => path.startsWith(dir)))
    .map(({ path, full }) => ({ path, source: readFileSync(full, "utf8") }));
}

/** The same, minus the seed data — which states a plan rather than editing one. */
function productionModules(): { path: string; source: string }[] {
  return shippedModules().filter(({ path }) => !SEED_MODULES.includes(path));
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

/**
 * Rebuilding the `jobs` array on an event's embedded person — the partner plane's counterpart
 * to a plan rebuild. A partner's jobs are a field of their `RelationshipEvent`, so reassembling
 * that person is how one gets written without `Projection`; both halves of that shape are
 * matched.
 *
 * The facade now closes the second half itself: `reviseTransaction` takes a `TransactionRevision`
 * carrying no person and no job list, so a revised event cannot be handed one. This still guards
 * the first half — assembling a person object anywhere in the app — and the regex self-test below
 * feeds it the old `reviseTransaction` shape as a sample of what it must catch, not as a call
 * that would compile today.
 */
const PARTNER_JOBS_REBUILD = /\.\.\.\s*[\w.]*\bperson\b[\s\S]{0,200}?\bjobs\s*:/;

/**
 * Minting a job id. The app has no id authority at all now — one counter inside `Projection`
 * issues every job id across both planes, and only ids of a shape its floor recognizes are
 * safe from being handed out twice. A locally-invented `job-N` (or a per-owner `p-1-job-N`) is
 * exactly the id the counter cannot see coming.
 */
const JOB_ID_MINT = /`[^`]*\bjob-\$\{/;

/**
 * The engine's facade module, read as text. The rule below is stated against what this file
 * exports rather than a list kept here, so "the app's whole engine surface" has ONE definition
 * and it lives beside the surface itself: to let the app name something new, you edit
 * `projectionRoot.ts` and say why there.
 */
const facadeSource = readFileSync(
  fileURLToPath(new URL("../../engine/src/projectionRoot.ts", import.meta.url)),
  "utf8",
);

/** Every name `projectionRoot.ts` exports — declared there, or re-exported through it. */
function facadeExports(source: string): Set<string> {
  const names = new Set<string>();
  // Re-export blocks: `export { a, b } from "./x"`, `export type { a } from "./y"`.
  for (const match of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"[^"]*"/gs)) {
    for (const part of match[1].split(",")) {
      const name = part.trim();
      if (name !== "") names.add(name.replace(/^type\s+/, "").split(" as ").pop()!.trim());
    }
  }
  // Declarations in the module itself.
  for (const match of source.matchAll(
    /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:class|interface|function|const|let|type|enum)\s+(\w+)/gm,
  )) {
    names.add(match[1]);
  }
  return names;
}

/**
 * Engine authoring transforms, named to prove the check below has teeth. Each is a second
 * write path if an app can reach it, so none may ever appear on the facade's surface.
 */
const WRITES_THAT_MUST_STAY_INTERNAL = [
  "addEvent",
  "updateEvent",
  "removeEvent",
  "withPayChange",
  "withIncomeOverride",
  "withJobPatch",
  "withGoalPatch",
  "withLinePatch",
  "withPlan",
  "withLedger",
];

/**
 * Every name a module imports or re-exports from the engine — types included. A type is part
 * of the surface too: naming a simulator internal is how an app comes to depend on one, and
 * keeping that vocabulary out of the app is half of what the facade is for.
 */
function engineImports(source: string): string[] {
  const names: string[] = [];
  const block = /(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"@finley\/engine"/gs;
  for (const match of source.matchAll(block)) {
    for (const part of match[1].split(",")) {
      const name = part.trim();
      if (name === "") continue;
      names.push(name.replace(/^type\s+/, "").split(" as ")[0].trim());
    }
  }
  return names;
}

describe("app write path — no direct plan writes outside the facade", () => {
  it("scans a plausible number of modules (the scan itself must not silently empty)", () => {
    // A broken path filter would pass every assertion below by checking nothing.
    expect(productionModules().length).toBeGreaterThan(30);
  });

  it("hands no panel a plan setter", () => {
    // A `Dispatch<SetStateAction<Plan>>` prop is a caller that can hand back any `Plan` at all,
    // which is the one thing the facade cannot check.
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

  it("rebuilds no partner's job list on the event it rides", () => {
    const offenders = productionModules()
      .filter(({ source }) => PARTNER_JOBS_REBUILD.test(code(source)))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it("mints no job id", () => {
    const offenders = productionModules()
      .filter(({ source }) => JOB_ID_MINT.test(code(source)))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it("names nothing from the engine that the facade module does not export", () => {
    const facade = facadeExports(facadeSource);
    // Every shipped module, seeds included: stating a starter plan is a reason to be exempt
    // from the no-rebuild checks, not a reason to reach past the facade for the vocabulary.
    const offenders = shippedModules().flatMap(({ path, source }) =>
      engineImports(source)
        .filter((name) => !facade.has(name))
        .map((name) => `${path}: ${name}`),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps every authoring transform off the facade's surface", () => {
    const facade = facadeExports(facadeSource);
    // Reading the facade's exports is only worth anything if it actually found them.
    expect(facade.has("Projection")).toBe(true);
    expect(facade.size).toBeGreaterThan(30);
    expect(WRITES_THAT_MUST_STAY_INTERNAL.filter((name) => facade.has(name))).toEqual([]);
  });

  it("keeps the guard honest — the patterns do fire on the shape they ban", () => {
    expect(PLAN_REBUILD.test("setPlan((p) => ({ ...p, goals: next(p.goals) }))")).toBe(true);
    expect(PLAN_REBUILD.test("return { ...plan, budgetLines: [...lines] };")).toBe(true);
    expect(PLAN_JOBS_REBUILD.test("return { ...plan, jobs: mapJob(plan.jobs, id, f) };")).toBe(true);
    expect(SCENARIO_REBUILD.test("withPlan(s.scenario, nextPlan)")).toBe(true);
    expect(PLAN_PRODUCER.test("export function withJob(plan: Plan, job: Job): Plan {")).toBe(true);
    expect(
      PARTNER_JOBS_REBUILD.test(
        "p.reviseTransaction(event.id, { ...event, person: { ...event.person, jobs: [...jobs] } });",
      ),
    ).toBe(true);
    expect(JOB_ID_MINT.test("return `${prefix}-job-${n}`;")).toBe(true);
    expect(JOB_ID_MINT.test("while (ids.has(`job-${n}`)) n++;")).toBe(true);
    // …and not on an unrelated spread, nor on a form appending to its own draft.
    expect(PLAN_REBUILD.test("return { ...draft, label: draft.label.trim() };")).toBe(false);
    expect(PLAN_JOBS_REBUILD.test("setDraft((d) => ({ ...d, jobs: [...d.jobs, job] }))")).toBe(
      false,
    );
    // The import scan reads types beside values, and a re-export as plainly as an import.
    expect(engineImports('import { addEvent, type Ledger } from "@finley/engine";')).toEqual([
      "addEvent",
      "Ledger",
    ]);
    expect(engineImports('export { withPayChange } from "@finley/engine";')).toEqual([
      "withPayChange",
    ]);
    expect(engineImports('import type { Plan, Job } from "@finley/engine";')).toEqual([
      "Plan",
      "Job",
    ]);
    // …and the facade scan reads both halves of its own module: what it declares, and what it
    // re-exports through itself.
    const facade = facadeExports(
      'export class Projection {}\nexport type { Job } from "./job";\nexport { dollarsToCents } from "./cashFlowSeries";',
    );
    expect([...facade].sort()).toEqual(["Job", "Projection", "dollarsToCents"]);
    // Reading a partner's jobs is not writing them.
    expect(PARTNER_JOBS_REBUILD.test("for (const j of event.person.jobs) ids.add(j.id);")).toBe(
      false,
    );
  });
});
