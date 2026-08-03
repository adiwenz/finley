# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the
codebase.

## Before exploring, read this

**`CONTEXT.md`** at the repo root. It is the canonical ubiquitous language for the project —
a glossary and nothing else, deliberately free of implementation detail.

## This repo does not use ADRs

There is no `docs/adr/` directory and none should be created. Architectural decisions are
recorded in the **spec or PRD issue** that produced them, and in the doc-comments on the code
that implements them — this codebase carries unusually dense module headers that explain why
a seam exists and which alternatives were rejected, and that is where the reasoning lives.

If a skill offers to write an ADR, decline and put the reasoning in the issue instead.

Longer-form design documents live in `docs/` when a decision needs more room than an issue
body (see `docs/projection-blocking-design.md`). Reach for one only when several issues need
to share the same reasoning.

## File structure

This repo is **single-context**:

```
/
├── CONTEXT.md
├── docs/            ← long-form design docs, when warranted
└── packages/
    ├── engine/      ← pure simulation engine
    ├── rules/       ← jurisdiction implementations
    └── app/         ← React/Vite UI
```

`CONTEXT.md` says so itself in its Notes section: the vocabulary is the engine's, and if
`rules` and `app` grow their own it should split into a `CONTEXT-MAP.md` at that point rather
than overloading one file. Until that happens, there is one glossary.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis,
a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary
explicitly avoids — the `_Avoid_` lines are load-bearing, not decoration.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing
language the project doesn't use (reconsider) or there's a real gap worth adding.

## Keep the glossary honest

`CONTEXT.md` is normative, but it can drift from the code. If you find an entry describing a
type or behaviour that no longer exists, say so rather than coding to the glossary — and fix
the entry as part of the work that revealed it.
