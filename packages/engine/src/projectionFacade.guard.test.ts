/**
 * The facade reachability guard: every public member of `Projection` must be named by production
 * code somewhere, so a dead member is caught the day its last caller leaves rather than years
 * later. `setJobStartingMonthlyIncome` sat unreferenced repo-wide long enough to become
 * archaeology; this rule is the tripwire that fails the commit orphaning the next one.
 *
 * Scanned as source TEXT with comments stripped — the approach `index.guard.test.ts` and
 * `comments.guard.test.ts` both take — because a member is defined by the shape of its declaration
 * and reached by the shape of a call, so a doc comment naming either must not count as a use.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const engineSrc = fileURLToPath(new URL("./", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const facadeSource = readFileSync(join(engineSrc, "projectionFacade.ts"), "utf8");

/** Comments stripped, so a doc comment declaring a member or naming a call cannot read as code.
 * The `[^:]` before `//` spares a `://` inside a string, matching the sibling guards' stripper. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * Every public member `Projection` declares, read off the class body. Members sit at exactly two
 * spaces of indentation and open with `(` (a method) or `<` (a generic one); getters carry a
 * `get` prefix, statics a `static` one. The constructor and every `private` member are dropped:
 * the guard constrains the SURFACE a caller can reach, and neither is on it. Fields never match —
 * a `name:` type annotation has no `(`/`<` after the name.
 */
function publicMembers(src: string): string[] {
  const members = new Set<string>();
  const decl = /^ {2}((?:public |private |protected |static |get |set |async |readonly )*)([A-Za-z_]\w*)\s*[(<]/gm;
  for (const [, modifiers, name] of code(src).matchAll(decl)) {
    if (name !== "constructor" && !/\bprivate\b/.test(modifiers)) members.add(name);
  }
  return [...members];
}

/** Non-test `.ts`/`.tsx` under a directory, recursively — the files a member can be named from. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * The corpus a member has to be named from. The facade itself stays in — a member calling a
 * sibling (`fromInput` calls `init`) is a real use, and the `.member` scan below never mistakes a
 * declaration for one, since a declaration has no leading dot. Only one file is dropped:
 * `authoring/fromInput.ts`, the declarative compiler, which dispatches a `ScenarioInput` entry to
 * the matching method mechanically. It names every input-mappable member whether or not any
 * genuine consumer wants it, so a member reachable *only* through it (see `payOffDebt`) has no
 * real caller and should read as unreachable.
 */
const declarativeCompilerPath = join(engineSrc, "authoring", "fromInput.ts");
const callerCode = [
  ...sourceFiles(join(repoRoot, "packages/app/src")),
  ...sourceFiles(join(repoRoot, "packages/engine/src")),
]
  .filter((f) => f !== declarativeCompilerPath)
  .map((f) => code(readFileSync(f, "utf8")))
  .join("\n");

/** A member is named where some file accesses it — `.member` — not merely where its bare name
 * appears: `payOffDebt` doubles as a `ScenarioInput` discriminant string, and an object key or a
 * `case "payOffDebt"` must not pass as a call. Member names are plain identifiers, so no escaping. */
function isNamed(member: string, haystack: string): boolean {
  return new RegExp(`\\.${member}\\b`).test(haystack);
}

/**
 * Members with no genuine caller to name them, each exempt only for a reason a name scan cannot
 * see. An entry without its reason is exactly how this guard rots into a rubber stamp, so every
 * one states why it is here — remove the reason and remove the entry.
 */
const REACHABLE_WITHOUT_A_CALLER = new Set([
  // Invoked by `JSON.stringify`, which the runtime calls by convention rather than by name, so no
  // call site ever writes `.toJSON`.
  "toJSON",
  // No UI affordance. Reachable only declaratively: a `ScenarioInput` `payOffDebt` entry compiles
  // to this call inside `authoring/fromInput.ts`, which the corpus excludes precisely because its
  // dispatch names every mappable member mechanically rather than as a genuine consumer.
  "payOffDebt",
]);

describe("facade reachability — every public member of Projection has a caller", () => {
  const members = publicMembers(facadeSource);

  it("parses a facade surface of a plausible size", () => {
    // A broken parser would pass the reachability rule below by finding no members to check.
    expect(members.length).toBeGreaterThan(30);
    expect(members).toContain("run");
    expect(members).toContain("addJob");
    expect(members).not.toContain("constructor");
    expect(members).not.toContain("write");
  });

  it("names every public member from a non-test production file", () => {
    const dead = members.filter(
      (m) => !REACHABLE_WITHOUT_A_CALLER.has(m) && !isNamed(m, callerCode),
    );
    expect(dead).toEqual([]);
  });

  it("carries no allowlist entry that a caller has since started naming", () => {
    // The other way an allowlist rots: a member gains a caller but keeps its exemption, masking a
    // check that now has teeth. An allowlisted member a file now names should leave the list.
    const stale = [...REACHABLE_WITHOUT_A_CALLER].filter((m) => isNamed(m, callerCode));
    expect(stale).toEqual([]);
  });

  it("lists no allowlist entry that is not a member", () => {
    // A rename that misses the allowlist would otherwise leave a dead string exempting nothing.
    const orphans = [...REACHABLE_WITHOUT_A_CALLER].filter((m) => !members.includes(m));
    expect(orphans).toEqual([]);
  });

  it("keeps the guard honest — the scan rejects a member nothing names", () => {
    // Feed the predicate a live member and the very member this guard exists for, now deleted: a
    // scan that silently matched everything (or nothing) would pass every rule above by telling
    // them apart wrongly. `setJobStartingMonthlyIncome` is gone repo-wide, so it must read dead.
    expect(isNamed("run", callerCode)).toBe(true);
    expect(isNamed("setJobStartingMonthlyIncome", callerCode)).toBe(false);
  });
});
