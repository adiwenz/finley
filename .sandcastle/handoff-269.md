# Handoff — issue 269

**Done so far:** Tasks 1–17 (see `git log`), and now **Task 18 (household scenarios — five new
`it`s in `packages/app/src/scenarios.test.tsx` under a second describe, "more households the same
panel has to answer": lone earner who never retires, partner who out-earns, mid-career separation,
stranded/blocked purchase, late-start earner). All assert whole panel sentences with `toBe`.**

**Tasks 19–20 remain — issue §Solution.3:**
- **Task 19 — extend the sentence-assertion style to the OTHER panels** (goals panel, net-worth
  breakdown, base adjustments), reusing the shared builders. Assert the sentence/figure that IS each
  panel's claim (the formatted string a user reads, not cents), not markup structure.
- **Task 20 — life-timeline scenarios**: one household across decades (marry → child → buy home →
  take loan → separate → retire), asserting the arc stays coherent. Must cover four
  currently-untested facade doors at least once: `startPartnered`, `haveExistingChild`,
  `deferralLimitCrossing`, `jobStartingMonthlyIncomeCents`.

## Live constraints
- **The scenario vocabulary lives in `packages/app/src/testing/scenarioBuilders.tsx`** (task 16).
  Exports `monthAt`, `jobAt`, `alexAlone`, `alexAndSam`, `paragraphs`, `headline`, `assumptions`,
  `LIFE_EXPECTANCY`. Tasks 19–20 import here and add assertions; do NOT re-implement the harness.
  - **`.tsx`, not `.ts`** — `paragraphs` renders a component via `renderToStaticMarkup`. A panel
    other than `RetirementPanel` (task 19) needs its OWN render helper here — mirror `paragraphs`'s
    HTML-strip/entity-decode (it decodes `&#x27;`→`'`, `&#x2019;`→`’`, `&#x2013;`→`–`, `&amp;`→`&`);
    do not assert on raw markup.
  - **`headline` matches by three known prefixes** (`"You could stop working at"`, `"You can retire
    at"`, `"On these numbers"`) on PURPOSE — it finds the answer sentence by prefix. Do NOT
    generalize to positional matching. A blocked projection's sentence ("Can’t compute a retirement
    age …") is NOT one of the three: task 18 asserts it via `paragraphs(p)` (which returns exactly
    that one sentence, because the panel suppresses every other line when blocked), not `headline`.
- **`scenarios.test.tsx` uses whole-sentence `toBe` golden assertions.** The expected strings carry
  hardcoded ages AND years (e.g. `(2069)`) and the panel's curly apostrophe `’`/en-dash `–`. Observe
  the real string first (write the assert, read the RED diff), then pin it — never hand-guess
  punctuation. The default budget-template dollar amounts are FIXED (authored at $5k/mo), NOT scaled
  to a replaced job's salary, so changing a job's pay via `replaceJob(p.plan.jobs[0]!.id, jobAt(…))`
  moves the answer strongly and predictably — task 18's five households all turn on this.
- **The blocked/stranded purchase is ALSO covered STRUCTURALLY** in
  `packages/app/src/scenarios.blockedPurchase.test.ts` (already on `main` — `view.blocked`,
  omitted-event ids, chart marker). Task 18 pins only the SENTENCE. Tasks 19–20 need not re-pin the
  block mechanics.
- **Shared ENGINE test fixtures live in `packages/engine/src/testing/projectionFacadeFixtures.ts`**
  (task 17) — `P1`, `freshProjection`, etc. Distinct from the APP `scenarioBuilders.tsx` above; task
  20's facade-door coverage may reach for these, but scenario assertions stay at the app seam.
- **`obligationBudgetLineId(lineId)`** in `packages/engine/src/projection/financialObligation.ts`
  is the one owner of the `line:<id>` convention — use it, never a raw `line:${id}`, if a test keys a
  budget line.
- Cluster folders `input/` `compile/` `retirement/` exist (tasks 12–14); their test files stayed in
  `src/`. Intra-cluster imports `./`, sibling-`src/` `../`.

## Traps
- **Test-count baseline: 1808 passing | 45 todo** (was 1803 before task 18 added 5). Tasks 19–20 ADD
  tests; any unexplained DROP is a regression.
- **`noUnusedLocals` is on** (root `tsconfig.json`). Every import must be USED in code — a symbol
  named only in a comment or describe-title string trips TS6133. `typecheck` catches it.
- **`comments.guard.test.ts` scans only `*.ts(x)` under `packages/`** — keep any new prose free of
  issue/PR numbers.
- **`authoringInputs.guard.test.ts` hardcodes `path === "input/scenarioInput.ts"`** and asserts
  `PartnerJobEntry` by name — update in the same commit if that file ever moves.
- **Dangling `{@link}`/backtick-path sweep on any move or deletion.**

## Dead ends
- (none)

## Deferred
- (none — tasks 19–20 are owned by their declared task headings.)
