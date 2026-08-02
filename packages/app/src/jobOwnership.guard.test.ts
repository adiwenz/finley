/**
 * The ownership guard: a job's owner is settled when the job is created, and nothing in the
 * shipped app can restate it.
 *
 * `jobEditing.test.ts` proves the current path is owner-preserving. This proves something a
 * behavioural test cannot: that no *second* path is lying around. A move used to be an ordinary
 * form submission — a `reassign` write kind, a target-owner lookup, and `Projection.reassignJob`
 * behind them — and the hazard in removing a capability is that a fragment survives, unreachable
 * today and reachable again the moment someone wires a caller to it. Reassignment is not a
 * feature with the UI hidden; it is a feature that is gone.
 *
 * The engine keeps `reassignProjectionJob`, tested on its own. Relocating a job is a coherent
 * operation — it is just not one an ordinary edit may perform, because it re-reads every age
 * against another birth year, restates the job's whole calendar, and strands the pay changes
 * that fall outside the new span. Bringing it back means an explicit transfer operation that
 * puts those consequences in front of the user. Until then the app must not name it, and
 * `planWrites.guard.test.ts` independently bans importing it.
 *
 * Scanned as source text, because what is being banned is the *absence* of code — there is no
 * signature left to constrain once the write kind is gone.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const appSrc = fileURLToPath(new URL("./", import.meta.url));

/** Every shipped `.ts`/`.tsx` under `src/` — tests and harnesses excluded, as they are not shipped. */
function productionModules(dir = appSrc): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return entry === "testing" ? [] : productionModules(full);
    }
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) return [];
    return [full];
  });
}

const modules = productionModules().map((path) => ({
  name: relative(appSrc, path),
  source: readFileSync(path, "utf8"),
}));

describe("no reassignment path survives in the app", () => {
  it("names the facade's move operation nowhere", () => {
    // `Projection.reassignJob` is reachable from any module holding a handle, so the ban has to
    // be on the name rather than on an import.
    const offenders = modules.filter((m) => /reassignJob\s*\(/.test(m.source));
    expect(offenders.map((m) => m.name)).toEqual([]);
  });

  it("has no move-shaped write kind left to route", () => {
    // Both halves: the intent that would describe a move, and the branch that would commit it.
    const offenders = modules.filter((m) => /["']reassign["']/.test(m.source));
    expect(offenders.map((m) => m.name)).toEqual([]);
  });

  it("mentions reassignment only where it is ruled out", () => {
    // A dormant comment is how a removed capability comes back: it reads as a description of
    // what the code does. The word may survive only in prose that says it cannot happen.
    const offenders = modules
      .filter((m) => /reassign/i.test(m.source))
      .filter((m) => !/cannot|never|no longer|instead of|rather than|not one/i.test(m.source));
    expect(offenders.map((m) => m.name)).toEqual([]);
  });

  it("looks up no owner from an edit draft", () => {
    // The shape of the old bug: `owners.find(o => o.id === draft.ownerId)`. An edit draft has no
    // `ownerId` to find anyone by, so any such expression means the type split has been undone.
    const offenders = modules.filter((m) => /draft\.ownerId/.test(m.source) && !/NewJobDraft/.test(m.source));
    expect(offenders.map((m) => m.name)).toEqual([]);
  });
});

/**
 * The adjustment-arithmetic guard: what a bonus DOES to a month is the engine's to say.
 *
 * The app had its own copy — `kind === "setTo" ? cents : base + cents`, clamped at zero — and
 * the copy is exactly why a chart, a list and a projection could disagree about the same month.
 * `applyJobIncomeOverride` is now the one definition, exported from the engine beside the
 * compiler that uses it, and this bans the shape of a second one growing back.
 *
 * The rule is deliberately narrow: reading an adjustment's `kind` is fine and common, because a
 * surface has to choose WORDS for it — `describeIncomeOverride` and `describePayChange` both do.
 * What is banned is arithmetic on an adjustment's `cents`, which is the only way to restate the
 * rule and the one thing a labelling function never needs.
 */
describe("no app-side copy of the adjustment arithmetic", () => {
  it("adds an adjustment's cents to nothing — that sum is the engine's", () => {
    // `base + override.cents` or `change.cents + base`, the whole of what layering one on is.
    const sum = /(\+\s*\w+\.cents\b)|(\b\w+\.cents\s*\+(?!\+))/;
    const offenders = modules.filter((m) => sum.test(m.source));
    expect(offenders.map((m) => m.name)).toEqual([]);
  });

  it("names the addBonus branch nowhere it could compute one", () => {
    // The same rule written from the other end: `addBonus` is a discriminator the engine reads.
    // An app module naming it beside any arithmetic operator is reconstructing the fold.
    const offenders = modules.filter((m) =>
      /["']addBonus["'][\s\S]{0,120}?\bcents\b\s*[+\-*]/.test(m.source),
    );
    expect(offenders.map((m) => m.name)).toEqual([]);
  });

  it("still lets a surface read the kind to choose its words", () => {
    // The guard must not have been satisfied by deleting the labelling: `describeIncomeOverride`
    // reads `kind` and is exactly what should survive.
    const labels = modules.find((m) => m.name === "jobAdjustments.ts");
    expect(labels).toBeDefined();
    expect(/kind === "setTo"/.test(labels!.source)).toBe(true);
  });
});
