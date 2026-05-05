---
extends: base/investigate.md
---

# Investigate — Symphony repo overlay

Repo-specific guidance layered on top of `base/investigate.md`. The base
9-step shape and annotations are unchanged; the overlay only narrows
what each step looks at in this codebase.

## Repo-specific anchors

- Repo architecture memory lives at `/memories/repo/symphony-architecture.md`.
  Read it before step 1; it gives terminology for both maestro and
  meta-score and prevents Step 1 decompose mode from re-discovering
  facts already written down.
- Two systems coexist and are easy to confuse:
  - **meta-score** (`tools/meta-score/`) — 8-phase deterministic state
    machine, persisted Score/Performance artifacts, log-driven.
  - **maestro** (`.github/agents/maestro*.agent.md` + `tools/symphony/`)
    — debate-based orchestrator with template catalog under
    `tools/symphony/algorithms/`.
  An investigation that conflates the two will fail step 4 (read
  semantics) — symbol names overlap but the runtime contracts differ.

## Step-by-step refinements

- **Step 2 (scope inventory)** — when the question is about types or
  fields, the canonical sources are `tools/symphony/types.ts`,
  `tools/meta-score/meta-score.ts`, and `tools/meta-score/prompts.ts`.
  Out of scope by default: `tools/plugins/**` unless the prompt names a
  plugin.
- **Step 3 (locate references)** — grep is insufficient in this repo
  for at least three reasons:
  - Field names appear in JSON fixtures and prompt text, not just code.
  - The 8-phase state machine references phases by string keys.
  - `tools/symphony/persistence.ts` round-trips fields by name.
  Always check fixtures (`**/fixtures/**`), prompts (`prompts.ts`), and
  persistence modules in addition to code.
- **Step 4 (read semantics)** — for any field on a Score or Performance,
  read both producer (where it's written) and consumer (where it's
  read). A field with a producer and no consumer is a Step 7 "remove"
  candidate; a field with a consumer and no producer is a bug, not a
  remove.
- **Step 9 (recommend follow-ups)** — available templates in this repo
  today: `feature`, `investigate`. `bug-fix`, `refactor`, `decide`,
  `build`, and `design` are referenced but not yet authored. Tag
  follow-ups with their intended template even if the file doesn't
  exist; maestro will draft the template on demand.

## Wrong-template signals (repo-specific additions)

- "Add a Score field" or "wire a new phase" → `feature`, not investigate.
- "Phase X is broken" → `bug-fix` (forward reference; maestro will draft).

## Common edit requests (repo-specific)

- "Skip the repo memory read" — reject. The memory file is the cheapest
  source of truth and is updated after each significant session.
- "Investigate by running the CLI" — accept only if the question is
  about runtime behavior; for type/contract questions, reading source
  is faster and more reliable than executing.
