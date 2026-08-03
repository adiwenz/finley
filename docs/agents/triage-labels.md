# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the
actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                 |
| -------------------------- | -------------------- | --------------------------------------- |
| `ready-for-agent`          | `Sandcastle`         | Fully specified, ready for an AFK agent |
| `wontfix`                  | `wontfix`            | Will not be actioned                    |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding
label string from this table.

## Roles this repo does not use

`needs-triage`, `needs-info` and `ready-for-human` have **no label** here, deliberately. This
is a solo repo with no external reporters, so there is nobody to wait on for information and
no queue of unevaluated incoming work.

If a skill asks for one of those three, **do not create a label for it.** Say what state the
issue is in and leave it unlabelled.

## Notes on this repo's mapping

`Sandcastle` ("Issues for Sandcastle to work on") is the existing AFK-agent queue, paired
with `sandcastle-done` ("Implemented by Sandcastle; open for review") and drained by the
`/ship` command. `ready-for-agent` maps onto it rather than creating a parallel queue.
