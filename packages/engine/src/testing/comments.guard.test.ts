import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Repo-wide comment-style guard: no comment may reference an issue or PR, and the
 * implementation prompt must carry the rule keeping it that way. String and template
 * literals are stripped first, so hex colors and URLs in code never read as comment text.
 */

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

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

/** Comment text only: code and string/template literals are dropped so their contents can
 * never be mistaken for a comment. */
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

  it("both AGENTS.md and the implementation prompt carry the exploration rule", () => {
    // The rule reaches agents through two doors: AGENTS.md (read by those who read it) and the
    // implement prompt (read by those who never do). Pinning both keeps them from drifting apart.
    const agents = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
    const prompt = readFileSync(
      join(repoRoot, ".sandcastle/new_flow/implement-prompt.md"),
      "utf8",
    );
    for (const doc of [agents, prompt]) {
      expect(doc).toMatch(/through the REPL/i);
      expect(doc).toMatch(/pin what you observed/i);
    }
  });
});
