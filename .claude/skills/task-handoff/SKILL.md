---
name: task-handoff
description: Write the rolling handoff note that carries context from one agent to the next. Use before any commit that leaves an issue unfinished, whether the issue declares tasks or the agent split the work itself.
---

# Task handoff

An issue is finished by a succession of agents, each starting with **no memory of the last** — it sees only the repository, the branch's commit log, and this note. Write the note that makes the next one competent.

Two things put you here. The issue declares tasks and you finished one with tasks still to go; or the issue declares none, you split the work yourself, and you have just committed a part. They are the same job: the branch is about to change hands.

## Where it lives

`.sandcastle/handoff-<issue-id>.md`, **committed as part of the commit you are about to make.**

Not the OS temp directory, and not an uncommitted file. Every agent runs in a different sandbox; anything not on the branch is gone when yours is torn down. That is doubly true when nobody chose to hand off — an agent stopped by the iteration ceiling is stopped without warning, and whatever it had not committed is simply lost.

## Cover the whole run, and rewrite rather than append

**Read the existing file first.** What you write replaces it, and it must still describe the state of the *entire issue implementation so far* — not just your task. The next agent gets this one document; if you drop task 1's live constraint because you personally didn't hit it, that constraint is gone for good.

So: carry everything forward that is still live, add what your task learned, and delete only what is genuinely **resolved** — a dead end that no longer applies because the code moved, a deferral that has since been done, a constraint that no longer binds.

Rewriting rather than appending is about **signal, not size**. The file is never going to be long enough to matter. But an append-only doc buries the three things that still bind under twenty that don't, and the next agent has no way to tell which is which. You have just done the work and you *can* tell — that judgement is the value you are adding.

## What earns a place

Carried across everything done on this branch so far, not just your part:

- **Live constraints** — an invariant that must be preserved, a shape a later task must match, an interface an earlier task introduced that the remaining ones consume.
- **Dead ends** — what was tried and did not work, and why. This is the highest-value content, because it is the only thing *nowhere else in the repository*: the code shows what was built, never what was abandoned. Without it each agent re-pays the same cost.
- **Deliberate deferrals** — something left undone on purpose, and which task owns it. Distinguish this from something an agent simply did not reach.
- **Traps** — a test shaped oddly for a reason, a file that looks safe to change and is not, a check that passes locally but is load-bearing elsewhere.

## What does not

- Anything already in the diff, the commit messages, the issue, or `CONTEXT.md`. **Reference those by path** — `see packages/engine/src/foo.ts:42`, `see task 2's commit` — never restate them.
- A narrative of what you did. The next agent can read `git log` and `git diff`.
- Restating tasks the issue declares. The next agent reads the issue directly.

One exception, and it matters: if **you** split the work — the issue declares no tasks — then your breakdown exists nowhere but in your head. Give it as a short list with what is done and what is not. Without it your successor re-plans the issue from scratch and may cut it differently, leaving a branch built two ways.
- Praise, status, or filler. If a section has nothing live in it, delete the section.

## Shape

Keep it short enough to read in full — a page is generous, and most issues warrant far less. If your part added nothing live, carry the previous content forward unchanged rather than padding it; an honest short handoff beats a thorough-looking one.

```md
# Handoff — issue <id>

**Done so far:** <the declared tasks completed, or your own breakdown marked done/remaining>

## Live constraints
- …

## Dead ends
- …

## Deferred
- …
```

Redact anything sensitive — keys, tokens, personal data. This file is committed.
