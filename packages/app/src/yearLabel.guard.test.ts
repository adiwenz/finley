/**
 * One month→year conversion, and it lives in `format.ts`.
 *
 * The plan's years are 0-based: months 0–11 are Year 0, "now". Every private helper that has
 * re-derived that has re-derived it wrong, and always in the same direction — `floor(month / 12)
 * + 1`, which is what you write if you think of a year as an ordinal rather than as an elapsed
 * count. It has happened twice. The net-worth chart called an insolvency month "year 45" while
 * the banner called it Year 44; later the spending headline said "From Year 31 this budget is no
 * longer financeable" under a banner reading "Year 30 (2056)", and the cash-flow hints said the
 * same about living off savings.
 *
 * A behavioural test cannot catch the third one, because the third one is in a file that does not
 * exist yet. So this is a source scan, and it bans the shape rather than the symptom: no second
 * definition of the conversion, and no year LABEL built by a module doing its own arithmetic.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const appSrc = fileURLToPath(new URL("./", import.meta.url));

/** Every shipped `.ts`/`.tsx` under `src/`, except the one module allowed to do the arithmetic. */
function productionModules(dir = appSrc): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return entry === "testing" ? [] : productionModules(full);
    }
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry) || entry === "format.ts") return [];
    return [full];
  });
}

const modules = productionModules().map((path) => ({
  name: relative(appSrc, path),
  source: readFileSync(path, "utf8"),
}));

describe("the month→year conversion has exactly one home", () => {
  it("is defined nowhere else", () => {
    // Shadowing is what made both regressions invisible: a local `yearOf` is called exactly like
    // the shared one, so the call sites read correct while returning a different year.
    const offenders = modules.filter((m) => /function\s+yearOf\b|const\s+yearOf\s*=/.test(m.source));
    expect(offenders.map((m) => m.name)).toEqual([]);
  });

  it("is not open-coded against an absolute month", () => {
    // The expression itself, whatever it is assigned to. `Math.floor(scrubMonth / 12) * 12` and
    // `termMonths / 12` are untouched — a duration in months is not a plan year, and the ban is
    // on converting THE month.
    const offenders = modules.filter((m) => /Math\.floor\(\s*month\s*\/\s*12\s*\)/.test(m.source));
    expect(offenders.map((m) => m.name)).toEqual([]);
  });

  it("is what every user-facing 'Year N' is built from", () => {
    // A module that prints a year must have imported one, not computed one. Both halves matter:
    // the import proves where the number came from, and the absence of a division proves nothing
    // adjusted it on the way.
    const offenders = modules.filter(
      (m) =>
        /Year \$\{/.test(m.source) &&
        (!/import \{[^}]*\byearOf\b[^}]*\} from "[^"]*format"/.test(m.source) ||
          /\/\s*12\b/.test(m.source)),
    );
    expect(offenders.map((m) => m.name)).toEqual([]);
  });
});
