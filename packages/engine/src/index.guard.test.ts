/**
 * The barrel guard: `index.ts` re-exports the {@link Projection} facade and NOTHING else.
 *
 * The public surface of `@finley/engine` is `./projectionRoot`. The barrel exists only to make
 * that the package entry point — so it must be exactly `export * from "./projectionRoot"`, with
 * no second `export` smuggling an internal (the simulator, the ledger, the waterfall, an
 * authoring transform) back onto the surface a re-export at a time. Widening what the package
 * exposes means adding to `projectionRoot.ts` and justifying it beside the surface, never here.
 *
 * Checked as source text: the thing being constrained is the SET of export statements, and the
 * one legal statement has no signature to assert against. Comments are stripped first so prose
 * describing the old wide barrel can't trip it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const barrel = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");

/** Source with block and line comments removed. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("@finley/engine barrel — the facade, and only the facade", () => {
  it("re-exports projectionRoot and declares no other export or import", () => {
    const src = code(barrel);
    const [only, ...rest] = src.match(/\bexport\b[^\n;]*/g) ?? [];
    // Exactly one export statement, and it is the whole-facade re-export.
    expect(rest).toEqual([]);
    expect(only?.replace(/\s+/g, " ").trim()).toBe('export * from "./projectionRoot"');
    // No module specifier other than projectionRoot may appear — no `export … from "./x"`,
    // no `import` reaching for an internal to re-emit.
    const specifiers = [...src.matchAll(/from\s*["']([^"']+)["']/g)].map((m) => m[1]);
    expect(specifiers).toEqual(["./projectionRoot"]);
  });
});
