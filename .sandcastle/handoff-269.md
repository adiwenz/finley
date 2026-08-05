# Handoff — issue 269

**Done so far:** Task 1 (exploration rule in `AGENTS.md`). Tasks 2–20 remain — see the issue body.

## Live constraints
- The exploration rule now lives in a `## Testing & exploration` section of `AGENTS.md`.
  Task 3 pins it: it extends `packages/engine/src/comments.guard.test.ts` to assert both
  `AGENTS.md` and `.sandcastle/new_flow/implement-prompt.md` still carry the rule. If you
  reword the section, keep the phrasing the guard matches (task 3 chooses those patterns).
- `AGENTS.md` refers to the REPL as `repl.ts`, run with `npx tsx repl.ts`. Task 2 adds an
  `npm run repl` script to the root `package.json`; when it lands, update that reference here.
- The guard (`comments.guard.test.ts`) only scans `*.ts(x)` under `packages/`, so it does not
  yet police `AGENTS.md` for issue/PR numbers — task 3 adds the AGENTS.md check. Keep
  `AGENTS.md` free of issue/PR numbers regardless.

## Dead ends
- (none)

## Deferred
- (none — everything below task 1 is owned by its declared task)
