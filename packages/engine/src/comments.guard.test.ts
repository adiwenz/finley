import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Repo-wide guard for the comment style: no issue/PR references may survive in
 * a comment, and the implementation prompt must carry the rule that keeps it
 * that way. String and template literals are stripped before scanning so hex
 * colors and URLs living in code never register as comment text.
 */

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith("."))
      continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Extract only the comment text from a TypeScript source, dropping code and
 * string/template literals so their contents can never be mistaken for a
 * comment. */
function commentsOf(src: string): string {
  const out: string[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      let j = i + 2;
      while (j < n && src[j] !== "\n") j++;
      out.push(src.slice(i + 2, j));
      i = j;
    } else if (c === "/" && next === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
      out.push(src.slice(i + 2, j));
      i = j + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === "\\") j++;
        j++;
      }
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join("\n");
}

const ISSUE_REF =
  /#\d{2,}|\bGH-\d+|\bissues?\s+#?\d+|\bPR\s*#?\d+|github\.com\/[^\s)]+\/(?:issues|pull)\/\d+/i;

const files = sourceFiles(join(repoRoot, "packages"));

describe("comment style guard", () => {
  it("no comment references an issue or PR number", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const comments = commentsOf(readFileSync(file, "utf8"));
      for (const line of comments.split("\n")) {
        if (ISSUE_REF.test(line))
          offenders.push(`${file.slice(repoRoot.length)}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the implementation prompt carries the comment-style rule", () => {
    const prompt = readFileSync(
      join(repoRoot, ".sandcastle/new_flow/implement-prompt.md"),
      "utf8",
    );
    expect(prompt).toMatch(/comments must be dense/i);
    expect(prompt).toMatch(/never reference issue or pr numbers/i);
  });
});
