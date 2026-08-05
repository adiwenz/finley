# Handoff — issue 269

**Done so far:** Tasks 1–19 (see `git log`). Task 18 added household scenarios; **Task 19 (this
commit) extended the sentence-assertion style to the OTHER panels** — goals panel, net-worth
breakdown, base adjustments — in a new file `packages/app/src/scenarios.panels.test.tsx` (7 `it`s,
node env, whole-string `toBe`/`toEqual`). Three new shared render helpers were added to
`packages/app/src/testing/scenarioBuilders.tsx`: `goalClaim(p, name)`, `netWorthSummary(p)`,
`budgetIncome(p)` (see their doc-comments).

**Only Task 20 remains — issue §Solution.3:**
- **Task 20 — life-timeline scenarios**: one household across decades (marry → child → buy home →
  take loan → separate → retire), asserting the arc stays coherent. Must cover four
  currently-untested facade doors at least once: `startPartnered`, `haveExistingChild`,
  `deferralLimitCrossing`, `jobStartingMonthlyIncomeCents`. This is the LAST task, so its commit
  writes `.sandcastle/summary-269.md`, DELETES this handoff, and carries the `[task 20/20]` marker.

## Live constraints
- **The scenario vocabulary lives in `packages/app/src/testing/scenarioBuilders.tsx`** (task 16,
  grown by tasks 18–19). Exports the household builders (`monthAt`, `jobAt`, `alexAlone`,
  `alexAndSam`, `LIFE_EXPECTANCY`) and the panel readers (`paragraphs`, `headline`, `assumptions`
  for the retirement panel; `goalClaim`, `netWorthSummary`, `budgetIncome` for the others). Task 20
  imports here and adds assertions; do NOT re-implement the harness.
  - **`.tsx`, not `.ts`** — the readers render real components via `renderToStaticMarkup` (node
    env). The shared `plainText` (task 19) does the tag-strip / entity-decode every reader needs
    (`&#x27;`→`'`, `&#x2019;`→`’`, `&#x2013;`→`–`, `&amp;`→`&`) — route new readers through it, do
    not assert on raw markup.
  - **The chart-bearing panels (net worth, base adjustments) DO render under node
    `renderToStaticMarkup`** — Recharts' `ResponsiveContainer` renders an empty wrapper (width 0)
    rather than throwing, so the claim `<p>`/`<span>` above the chart is present. This was verified
    before task 19 committed; no jsdom env is needed for these readers.
  - **Panel readers pass a typed no-op `NO_WRITES: Transact = () => undefined`** for the write
    callback — `() => {}` (returning `void`) does NOT satisfy `Transact`'s `R | undefined`, and
    `noUnusedLocals` will not let you inline it. Static render never fires the callback; author any
    state change (a reorder, a marriage) on the `Projection` BEFORE rendering.
  - **`headline` matches by three known prefixes** (`"You could stop working at"`, `"You can retire
    at"`, `"On these numbers"`) on PURPOSE. A blocked projection's sentence ("Can’t compute a
    retirement age …") is NOT one of the three — assert it via `paragraphs(p)`, not `headline`.
- **Golden strings carry hardcoded figures.** Retirement asserts ages AND years (`(2069)`);
  `goalClaim` asserts dates as the panel renders them (`"$15,000 by Year 2 (2028)"`), status as
  `"Funded"` or `"N% on track"`; `netWorthSummary` asserts the whole `"Peaks around $X … "`
  sentence including the peak dollars; `budgetIncome` asserts `"$5,000/mo"`. Observe the real string
  first (write the assert, read the RED diff), then pin it — never hand-guess punctuation or a
  compounded figure.
- **The default budget-template dollar amounts are FIXED (authored at $5k/mo), NOT scaled** to a
  replaced job's salary, so `replaceJob(p.plan.jobs[0]!.id, jobAt(…))` moves every downstream answer
  strongly and predictably. Task 19's goals scenarios turn on this: default pay leaves both goals at
  0%; $70k funds the priority reserve to `Funded` and the second goal to 48%; reordering flips it.
- **The blocked/stranded purchase is ALSO covered STRUCTURALLY** in
  `packages/app/src/scenarios.blockedPurchase.test.ts` (on `main`). Tasks 18–20 need not re-pin the
  block mechanics.
- **Shared ENGINE test fixtures live in `packages/engine/src/testing/projectionFacadeFixtures.ts`**
  (task 17) — `P1`, `freshProjection`, etc. Distinct from the APP `scenarioBuilders.tsx`. Task 20's
  facade-door coverage may reach for these, but scenario assertions stay at the app seam.
- **`obligationBudgetLineId(lineId)`** in `packages/engine/src/projection/financialObligation.ts`
  is the one owner of the `line:<id>` convention — use it, never a raw `line:${id}`.
- Cluster folders `input/` `compile/` `retirement/` exist (tasks 12–14); their test files stayed in
  `src/`. Intra-cluster imports `./`, sibling-`src/` `../`.

## Traps
- **Test-count baseline: 1815 passing | 45 todo** (was 1803 before task 18; task 18 added 5 → 1808,
  task 19 added 7 → 1815). Task 20 ADDS tests; any unexplained DROP is a regression.
- **`noUnusedLocals` is on** (root `tsconfig.json`). Every import must be USED in code — a symbol
  named only in a comment or describe-title string trips TS6133. `typecheck` catches it.
- **`comments.guard.test.ts` scans only `*.ts(x)` under `packages/`** — keep any new prose free of
  issue/PR numbers.
- **`authoringInputs.guard.test.ts` hardcodes `path === "input/scenarioInput.ts"`** and asserts
  `PartnerJobEntry` by name — update in the same commit if that file ever moves.
- **No prettier/eslint is configured** — `npm run check` is purity + typecheck + test only.
- **Dangling `{@link}`/backtick-path sweep on any move or deletion.**

## Dead ends
- (none)

## Deferred
- (none — task 20 is owned by its declared task heading.)
