import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Structural regression guard for the federal-tax module graph. The scalar seam
 * (./federalTax) and the per-category attribution (./federalTaxAttribution) once
 * imported each other, forming a cycle. Both now read the neutral ./federalTaxCore
 * intermediate instead, so dependencies flow one way:
 *
 *   federalTax ─┬─▶ federalTaxAttribution ─▶ federalTaxCore ─▶ federalTaxTables
 *               └────────────────────────────▶ federalTaxCore
 *
 * These assertions fail the moment anyone reintroduces a sibling→sibling edge that
 * would recreate the cycle.
 */
function sourceOf(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const importsFrom = (src: string, specifier: string): boolean =>
  new RegExp(`from\\s+["']${specifier.replace(/[.]/g, "\\$&")}["']`).test(src);

describe("federal-tax module dependency direction (acyclic)", () => {
  it("federalTaxCore imports neither sibling seam", () => {
    const core = sourceOf("./federalTaxCore.ts");
    expect(importsFrom(core, "./federalTax")).toBe(false);
    expect(importsFrom(core, "./federalTaxAttribution")).toBe(false);
  });

  it("federalTaxAttribution does not import ./federalTax (that edge closed the cycle)", () => {
    const attribution = sourceOf("./federalTaxAttribution.ts");
    expect(importsFrom(attribution, "./federalTax")).toBe(false);
  });

  it("both seams share the core intermediate", () => {
    expect(importsFrom(sourceOf("./federalTax.ts"), "./federalTaxCore")).toBe(true);
    expect(importsFrom(sourceOf("./federalTaxAttribution.ts"), "./federalTaxCore")).toBe(true);
  });
});
