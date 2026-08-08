# Finley

See [AGENTS.md](./AGENTS.md) — it holds the instructions for this repo, and is the file to
edit. This file exists only so tools that look for `CLAUDE.md` find their way there.

Before adding or changing a test, read **[Test ownership](./AGENTS.md#test-ownership)**. The rule
in one line: engine tests prove domain truth, app Node tests prove engine-output → UI-model
transformations, app jsdom tests prove rendering and interaction — and app tests never re-prove
domain behaviour the engine already owns.
