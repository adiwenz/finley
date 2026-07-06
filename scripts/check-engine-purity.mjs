#!/usr/bin/env node
/**
 * Engine-purity check (§0.8, ARCHITECTURE.md — enforced, not just intended).
 *
 * The engine is a pure function of its inputs: no I/O, no network, no storage,
 * and no dependency on app- or rules-specific code. Jurisdiction facts enter
 * ONLY through the jurisdiction interface. This scanner fails the build if any
 * engine SOURCE file (excluding *.test.ts) violates that.
 *
 * Heuristic, line-based, comment-stripped — the engine surface is small and we
 * own it, so a targeted regex guard is enough and needs no dependencies.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const engineSrc = join(repoRoot, "packages", "engine", "src");

/** Forbidden patterns. Each: a name + a regex tested against comment-stripped lines. */
const RULES = [
  {
    name: "imports app/rules code (breaks one-way dependency direction)",
    re: /\b(?:from|import)\s*\(?\s*['"](?:@finley\/(?:rules|app)|\.\.\/(?:rules|app))/,
  },
  {
    name: "imports a Node built-in (I/O / no standalone-purity)",
    re: /\b(?:from|import|require)\s*\(?\s*['"](?:node:)?(?:fs|path|os|http|https|net|dns|tls|dgram|child_process|worker_threads|cluster|readline|stream|zlib|crypto|process)(?:\/[^'"]*)?['"]/,
  },
  {
    name: "uses browser / storage / network I/O",
    re: /\b(?:fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB|window|document|navigator)\b/,
  },
  {
    name: "reads ambient process / dynamic require (hidden input)",
    re: /\bprocess\.\w|\brequire\s*\(/,
  },
  {
    name: "uses Date (non-deterministic wall-clock input)",
    re: /\bDate\s*\.\s*now\b|\bnew\s+Date\b/,
  },
];

// Blank out block and line comments so forbidden tokens mentioned in prose don't trip the scan.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/.*$/gm, "");
}

function tsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const violations = [];
for (const file of tsFiles(engineSrc)) {
  const lines = stripComments(readFileSync(file, "utf8")).split("\n");
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.re.test(line)) {
        violations.push({
          file: relative(repoRoot, file),
          line: i + 1,
          rule: rule.name,
          text: line.trim(),
        });
      }
    }
  });
}

if (violations.length > 0) {
  console.error("✗ Engine purity check FAILED (§0.8):\n");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.rule}`);
    console.error(`      ${v.text}`);
  }
  console.error(
    `\n${violations.length} violation(s). The engine must be a pure function of its inputs.`,
  );
  process.exit(1);
}

console.log("✓ Engine purity check passed: no I/O and no app/rules imports in engine source.");
