/**
 * The surface ratchet: `index.ts` is the package's export map, and it may only ever *map*.
 *
 * Every line re-exports a name from the module that defines it. Nothing is declared here, nothing
 * is imported and re-emitted under another name, and — the load-bearing rule — nothing is exported
 * by wildcard. `export *` would make the surface a function of some other module's contents, so
 * widening it would stop being an edit anyone reviews; the whole point of a curated map is that
 * adding a name is a line in a diff with a comment beside it.
 *
 * Scanned as source TEXT, comments stripped, because what is being constrained is the SHAPE of the
 * file — a declaration, a wildcard, an `import` smuggling an internal back onto the surface — and a
 * doc comment naming another module must not trip it. Reading the text is also how the two
 * downstream guards work: the app's `planWrites.guard.test.ts` decides what the app may name by
 * parsing this file, and `authoringInputs.guard.test.ts` reads it to find every published input.
 * A wildcard here would silently blind both.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const engineSrc = fileURLToPath(new URL("./", import.meta.url));
const indexSource = readFileSync(join(engineSrc, "index.ts"), "utf8");

/** Comments stripped, so a doc comment naming a module or a banned shape cannot count as code. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * Every re-export statement, whole: `export { a } from "./x"`, `export type { a, b } from "./y"`,
 * and the multi-line form. This is the ONLY statement shape the map is allowed to contain, so
 * counting these against every `export`/`import` keyword below is what proves it declares nothing.
 */
const REEXPORT = /^\s*export\s+(?:type\s+)?\{[^}]*\}\s*from\s*"[^"]*";/gm;

/** Every top-level `export`/`import` keyword the code (not the comments) names. */
function statementKeywords(src: string): string[] {
  return [...code(src).matchAll(/^\s*(export|import)\b/gm)].map((m) => m[1]);
}

/** Every `from "…"` module specifier the code names. */
function moduleSpecifiers(src: string): string[] {
  return [...code(src).matchAll(/\bfrom\s*"([^"]*)"/g)].map((m) => m[1]);
}

/** Every name the map publishes, from its re-export blocks. */
function publishedNames(src: string): Set<string> {
  const names = new Set<string>();
  for (const match of code(src).matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"[^"]*"/gs)) {
    for (const part of match[1].split(",")) {
      const name = part.trim();
      if (name !== "") names.add(name.replace(/^type\s+/, "").split(" as ").pop()!.trim());
    }
  }
  return names;
}

/**
 * Names that must never reach the surface, listed outright so the check has teeth.
 *
 * The writes are the group that would do real damage: the entity transforms, and the
 * projection-level state functions the facade's methods delegate to. The latter take a whole
 * `ProjectionState` and hand back the next one, so a consumer holding one could author around the
 * id counter, the goal-funding guard and the affordability gate at once — a second write path,
 * which is the arrangement the facade exists to close. The app's `planWrites.guard.test.ts`
 * asserts this same group; deliberately duplicated rather than shared, because this package
 * publishes the surface and must be able to prove it is closed without depending on a consumer's
 * test suite to notice.
 *
 * The state plumbing is the group this map's shape makes reachable for the first time. Now that
 * `index.ts` re-exports straight from defining modules, `./authoring/state` is one line away from
 * the surface, and a state constructor or a counter floor published beside `ProjectionState`
 * would be a caller assembling states the gates never saw.
 */
const MUST_STAY_INTERNAL = [
  // Writes.
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
  "addProjectionJob",
  "reassignProjectionJob",
  "addProjectionBudgetLine",
  "removeProjectionGoal",
  "applyMarriage",
  "applyHomePurchase",
  "applyLoan",
  "reviseProjectionTransaction",
  "appendEvent",
  "replaceEvent",
  "withStatePlan",
  "withStateLedger",
  // State plumbing: constructing, restoring and re-flooring a `ProjectionState`.
  "emptyState",
  "restoreState",
  "withNormalizedCounters",
  "withFlooredIdCounter",
  "seqFloor",
];

describe("engine surface — index.ts is a map and only a map", () => {
  it("declares nothing: every statement re-exports from another module", () => {
    const keywords = statementKeywords(indexSource);
    const reexports = code(indexSource).match(REEXPORT) ?? [];
    // Equal counts is the whole assertion: a `const`, a `class`, a bare `import`, or an
    // `export * from` would each raise the keyword count without raising the re-export count.
    expect(keywords.length).toBe(reexports.length);
    expect(keywords.every((k) => k === "export")).toBe(true);
  });

  it("exports nothing by wildcard", () => {
    // The rule the two downstream text-scanning guards depend on. A wildcard would make this
    // file's published set unreadable from its own text, and both would quietly under-report.
    expect(/export\s+\*/.test(code(indexSource))).toBe(false);
  });

  it("maps only to modules inside this package, and each one exists", () => {
    const specifiers = moduleSpecifiers(indexSource);
    expect(specifiers.length).toBeGreaterThan(20);
    const broken = specifiers.filter(
      (spec) => !spec.startsWith("./") || !existsSync(join(engineSrc, `${spec}.ts`)),
    );
    expect(broken).toEqual([]);
  });

  it("names no intermediate barrel — every symbol comes from a module that defines something", () => {
    // The map points at defining modules, so no specifier may be a module whose own body is
    // nothing but re-exports. A pass-through would put a second file in the path of every
    // widening, which is the arrangement the map replaces.
    const passThrough = [...new Set(moduleSpecifiers(indexSource))].filter((spec) => {
      const body = code(readFileSync(join(engineSrc, `${spec}.ts`), "utf8")).trim();
      if (body === "") return false;
      const keywords = [...body.matchAll(/^\s*(export|import)\b/gm)].map((m) => m[1]);
      const reexports = body.match(REEXPORT) ?? [];
      return keywords.length > 0 && keywords.length === reexports.length;
    });
    expect(passThrough).toEqual([]);
  });

  it("publishes the facade, and a surface of a plausible size", () => {
    // A broken scan would pass every rule above by finding nothing.
    const names = publishedNames(indexSource);
    expect(names.has("Projection")).toBe(true);
    expect(names.size).toBeGreaterThan(30);
  });

  it("publishes nothing that writes, and no state plumbing", () => {
    const names = publishedNames(indexSource);
    expect(MUST_STAY_INTERNAL.filter((name) => names.has(name))).toEqual([]);
  });

  it("keeps the guard honest — the patterns do fire on the shapes they ban", () => {
    const declares = 'export const CURRENT = 1;\nexport { Projection } from "./projectionFacade";';
    expect(statementKeywords(declares).length).toBe(2);
    expect((declares.match(REEXPORT) ?? []).length).toBe(1);

    const wildcard = 'export * from "./projectionFacade";';
    expect(/export\s+\*/.test(wildcard)).toBe(true);
    expect((wildcard.match(REEXPORT) ?? []).length).toBe(0);

    const smuggled = 'import { addEvent } from "./ledger/addEvent";\nexport { addEvent };';
    expect(statementKeywords(smuggled)).toEqual(["import", "export"]);
    expect((smuggled.match(REEXPORT) ?? []).length).toBe(0);

    // The name scan reads a type re-export as plainly as a value one, and across lines.
    expect([...publishedNames('export type {\n  Job,\n  PersonId,\n} from "./job";')].sort()).toEqual(
      ["Job", "PersonId"],
    );
  });
});
