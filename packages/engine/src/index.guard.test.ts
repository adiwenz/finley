/**
 * The barrel ratchet: `@finley/engine`'s public surface is the {@link Projection} facade and
 * nothing else, so `index.ts` may do exactly one thing — re-export the whole of
 * `./projectionRoot`. Everything else in the package is internal and reached by relative path
 * from inside the package.
 *
 * Scanned as source text, comments stripped, because what is being banned is the SHAPE of the
 * file — a second `export`, or an `import` smuggling an internal back onto the surface — and a
 * doc comment mentioning another module must not trip it. This is the counterpart to the app's
 * `planWrites.guard.test.ts`: that one holds the app to the facade, this one holds the facade
 * to a single re-export so it cannot silently re-widen.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const indexSource = readFileSync(
  fileURLToPath(new URL("./index.ts", import.meta.url)),
  "utf8",
);

/** Comments stripped, so a doc comment naming another module cannot count as an export. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Every `from "…"` module specifier the code (not the comments) names. */
function moduleSpecifiers(src: string): string[] {
  return [...code(src).matchAll(/\bfrom\s*"([^"]*)"/g)].map((m) => m[1]);
}

/** Every top-level `export`/`import` statement keyword the code names. */
function statementKeywords(src: string): string[] {
  return [...code(src).matchAll(/^\s*(export|import)\b/gm)].map((m) => m[1]);
}

describe("engine barrel — the facade is the whole public surface", () => {
  it("re-exports exactly the projection facade, and nothing else", () => {
    // One statement, and it is `export * from "./projectionRoot"`: no second export widening the
    // surface, and no `import` pulling an internal in to re-export it under another name.
    expect(statementKeywords(indexSource)).toEqual(["export"]);
    expect(moduleSpecifiers(indexSource)).toEqual(["./projectionRoot"]);
    expect(/export\s+\*\s+from\s*"\.\/projectionRoot"/.test(code(indexSource))).toBe(true);
  });

  it("names no other module — no relative internal reachable through the barrel", () => {
    // The facade re-exports the internals an app may legitimately name; the barrel adds nothing
    // to that set. A second specifier here would be an internal riding onto the surface.
    expect(moduleSpecifiers(indexSource).filter((s) => s !== "./projectionRoot")).toEqual([]);
  });
});
