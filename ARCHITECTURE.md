# Architecture — repositories & open-core structure

How the system is **partitioned and shipped**. `BUILD_SPEC.md` says *what* to build;
this says *where each piece lives, what's public, and how the pieces depend on each other*.
Read once at setup, and whenever deciding where a new piece of code belongs.

---

## The open-core split

The value to keep private is the **product** (UX, recommendation experience, user data,
brand, hosting) — **not** the math. Compound interest, amortization, and tax formulas are
textbook, not proprietary, and no user data flows through them. So the engine is both safe
to expose and valuable to others; public scrutiny is a genuine *correctness* asset given how
easily financial math is silently wrong.

### Three repositories

| Repo | Visibility | Contents | Changes |
|------|-----------|----------|---------|
| **`engine`** | **Public** | Pure simulation (`simulate(events, assumptions) → projection`), the ledger/event model, the recommendation *mechanism*, and the **jurisdiction interface** it calls. Timeless math. | Slowly (stable API) |
| **`rules`** | **Public** | Jurisdiction *implementations* of the engine's interface — `US-2026` (tax brackets, contribution limits, Social Security, Medicare, RMDs), later others. Current-year facts. | Often (yearly figures) |
| **`app`** | **Private** | UI, persistence, user data, snapshot/scrubber, recommendation *presentation*. Imports the two public packages. | Continuously |

### Dependency direction (one-way, never violated)

```
app  ──imports──▶  rules  ──implements──▶  engine's jurisdiction interface
 └──────────────imports──────────────────▶  engine
```

- `engine` depends on **nothing** app- or rules-specific. It defines the interface; it does
  not know which jurisdiction is plugged in. It ships with a trivial "null jurisdiction" (no
  taxes, no programs) so it runs standalone.
- `rules` depends only on `engine` (to implement its interface).
- `app` depends on both, consuming them as **published, versioned packages** — the same way
  any third party would. This is the forcing function that keeps the boundary clean.

### Why separate repos, not subfolders

1. **Different release clocks.** The engine's math is stable for years; the rules' figures
   change every year (new contribution limits, RMD ages, SS parameters). You must be able to
   ship `US-2027` rules without cutting an engine release. Separate versioning demands
   separate packages.
2. **Boundary erosion is the main failure mode of open-core.** In one repo, the pressure to
   reach across the boundary ("just this once, add a UI concern to the engine") is constant,
   and six months later the engine isn't pure and can't be cleanly open-sourced. A hard repo
   boundary + published-dependency consumption makes every violation cost something visible.
3. **Different contributors.** A tax-rules contributor isn't necessarily an engine
   contributor. Separate repos let each community form.

---

## The engine-purity rule (enforced, not just intended)

The engine is a **pure function of its inputs**: no I/O, no network, no storage, no
user-data / PII types, no dependency on app code. Jurisdiction specifics enter ONLY through
the jurisdiction interface — never hardcoded. This is a **correctness constraint** (see
`BUILD_SPEC.md` §0.8), not a packaging preference: violating code cannot be in the engine.

- Enforce with a CI/lint check (no disallowed imports; no `fetch`/`fs`/`localStorage`).
- The determinism invariants (`invariants.test.ts` §3 — replay is byte-identical) partly
  prove purity: a function with hidden I/O or state wouldn't replay identically.

---

## The jurisdiction interface (the plug-and-play seam)

The engine defines *what a jurisdiction must supply*; a `rules` package implements it. Rough
shape (finalize when building the tax seams, `BUILD_SPEC.md` §5.3–5.5):

- `computeTax(taxableIncome, context) → taxCents`
- contribution limits + catch-up (by account type, age band, year)
- government programs: Social Security benefit formula (from an earnings record), Medicare
  eligibility + health-cost step, RMD schedule
- all figures parameterized by year, so `US-2026` and `US-2027` are separate data, same shape

The engine ships a **null jurisdiction** (zero tax, no programs) so it runs and is testable
with no rules package present. This is what lets Phase 1 (below) complete standalone.

---

## Build order — vertical slices, not whole repos in sequence

The three repos do **not** map to "finish repo 1, then 2, then 3." Build order is about thin
vertical slices (the walking-skeleton principle from `HANDOFF.md`, applied across repos).

**Phase 0 — walking skeleton across all three.** Before deep work: a trivial `engine` that
returns a flat projection → a null jurisdiction → a bare `app` that renders it. Proves the
three-repo *wiring* (packaging, API boundary, dependency direction) while each repo is ~50
lines. Discovering a boundary problem here is trivial; discovering it after the engine is
complete is expensive.

**Phase 1 — `engine` core, standalone (public).** `BUILD_SPEC.md` build steps 1–8:
`CashFlowSeries` → `Account` → entities → `Simulator` → undo/cascade → retirement. **Define
the jurisdiction interface here**, stubbed with the null jurisdiction, so the engine runs
end-to-end and is publishable/useful on its own. The invariant suite lives here and is the
gate.

**Phase 2 — `rules`, separate public repo implementing the interface.** `BUILD_SPEC.md` step
9: build `US-2026` (tax, contribution limits, Social Security, Medicare, RMDs) against the
stable Phase-1 interface. The engine does not change — you're filling the plug, not reshaping
the socket. Heavy "estimates, not advice, figures change yearly" disclaimer.

**Phase 3 — `app`, private repo importing both.** `BUILD_SPEC.md` steps 10–11: UI,
persistence, user data, snapshot/scrubber, recommendation presentation. Consumes the
published engine + rules packages as an external user would.

`HANDOFF.md`'s workflow (spec → grill → PRD → issues → supervised per-issue loop → review →
commit) applies **per repo**. The invariant suite is the gate in `engine`; `rules` needs its
own known-value anchors (published tax tables, a hand-computed SS benefit); `app` gets
integration tests.

---

## Open items (decide before/at repo split)

1. **Engine license.** Permissive (MIT/Apache) maximizes adoption and trust and fits "the
   moat is the app, not the math" — recommended default. Copyleft/source-available (AGPL/BSL)
   protects against a competitor lifting the engine. Hard to relicense later once external
   contributions land, so decide first.
2. **Rules license.** Likely the same permissive license; the value of open rules is
   community correction and auditability of a financial tool.
3. **Contributor licensing (CLA / DCO).** Set up *before* the first external PR, or you can't
   cleanly relicense or reuse contributions in the private app.
4. **Core-vs-app line for ambiguous pieces.** Proposed: the **ledger/event model** and the
   **recommendation mechanism** ("no new simulation logic — just re-runs and diffs") go in the
   public engine; the **recommendation presentation**, default assumptions/tuning, and UX flows
   stay private. Open-source the *capability*, keep the *taste*. Confirm this line.
5. **What must never be public.** Specific tuned default assumptions you consider
   differentiating, the recommendation presentation, and of course anything touching user data.
