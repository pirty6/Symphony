---
default-complexity: 3
verb-triggers: [refactor, rename, consolidate, extract, inline, simplify, regroup, reorganize, restructure, dedupe, merge, split, move]
---

# Refactor Algorithm

The canonical algorithm for changing the shape of existing code without
changing its observable behavior. The output is the same system,
structured differently.

## Steps

1. Name target — restate the user's prompt as a concrete structural
   change ("rename X to Y", "merge module A into B", "extract C from
   D"). If the prompt has no named target ("clean it up", "this is
   messy"), halt and route to `investigate` to produce a target plan;
   re-enter this template per target. Refactor requires a named target
   to begin.
2. Pin invariant — state the behavior that must be preserved and name
   the contract surface that proves it (public API signatures,
   observable side effects, test outcomes, build artifacts). State
   what is allowed to change (import paths, file layout, internal
   names). Pin and survey are co-dependent — the pin is behavioral,
   the survey is locational; iterate if needed.
3. Survey blast radius — enumerate every reference. Distinguish
   **symbol-level** (imports, calls, type usages — AST/LSP-discoverable)
   from **string-level** (docs, comments, configs, serialized data,
   external API contracts, log queries — only grep + human reading
   finds these). Renames and splits fail silently when string-level
   surveys are skipped.
4. Capture baseline — run tests, types, and build BEFORE any edit on
   the surface this refactor touches. Record the green state as the
   equivalence reference. If the touched surface is red, halt — but
   global redness elsewhere in the repo is not a blocker for a scoped
   refactor.
5. Plan move — describe the sequence of mechanical edits in order
   (introduce new name → update call sites → relocate → delete shim)
   and mark reversible checkpoints between them. For **merge or
   consolidate**, add an equivalence step: prove the two sources have
   the same observable behavior (or document the diff) before picking
   a survivor.
6. Execute edits — apply the plan in order. Tag any scaffolding
   (deprecation shim, alias, parallel implementation) at the moment
   of introduction so step 8 is mechanical, not archaeological.
   Checkpoint after each reversible step.
7. Verify equivalence — re-run tests, types, and build, **covering the
   blast radius from step 3**. The verify surface must match the
   survey surface; integration tests outside the default run may need
   to be triggered explicitly. For non-obvious equivalence (logs,
   performance, serialized output), diff observable behavior directly.
8. Prune scaffolding — remove every item tagged in step 6. Re-verify
   equivalence. Dead aliases, deprecation shims, and parallel paths
   left after a refactor rot quickly and the second pass rarely
   happens.

## Notes for the iteration

- Steps 1, 2, and 4 form the load-bearing trio: target → invariant →
  baseline. Without a target, the refactor chases the loudest mess
  instead of the load-bearing one (this is why step 1 routes to
  investigate when no target exists). Without a pinned invariant,
  "equivalence" in step 7 has nothing to compare against. Without a
  baseline, equivalence is unprovable.
- Step 3's symbol-vs-string distinction is the single biggest source
  of silent refactor failures. Treat them as two separate surveys.
- The split between step 6 (execute) and step 8 (prune) is intentional.
  Shim removal frequently breaks things and gets silently absorbed
  into the main edit if the steps are merged. Splitting also makes
  pruning a checkable operation rather than a vibe.
- "Refactor" that changes observable behavior is not a refactor.
  Push back on the user and re-route.

### Wrong-template signals

- User describes broken behavior they want fixed → bug-fix
- User wants new capability, not reshaped existing code → feature
- User cannot pick between two structural targets → decide first,
  then refactor
- User wants to understand the code before deciding to change it →
  investigate
- User has named a feeling, not a target ("convoluted", "messy") →
  investigate first; refactor consumes the resulting target plan
- User wants a new module designed from scratch → design / feature
- "Refactor" that changes observable behavior → feature or bug-fix

### Common edit requests

- "Skip baseline, tests are slow" — reject. The baseline IS the
  equivalence reference; without it step 7 is theater.
- "Merge plan and execute" — reject. Plan exists so reversibility is
  named before edits begin; conflating eliminates rollback.
- "Skip prune, I'll do it later" — reject by default. Accept only if
  pruning is filed as an explicit follow-up refactor.
- "Drop pin invariant, behavior preservation is obvious" — accept
  only if the user names the contract surface (which tests, which
  API). Otherwise push back.
- "I don't have a target, just clean it up" — halt. Route to
  investigate. Do not proceed without a named target.
- "Add a design step" — reject. If design is needed, the work is
  not a refactor; route to design or decide first.
- "I have multiple targets" — accept; run this template per target.
  Do not absorb a queue into the template itself.

## Annotation

| Step             | Level | Instrument  | Why                                                                |
|------------------|-------|-------------|--------------------------------------------------------------------|
| name (restate)   | 1     | percussion  | mechanical pass-through of an already-concrete target              |
| name (no-target) | —     | —           | halt; route to investigate (no annotation, no beat emitted)        |
| pin              | 4     | brass       | asserts the behavior contract the refactor commits to preserving   |
| survey           | 3     | strings     | module-level relational mapping of every reference, two surfaces   |
| capture          | 1     | percussion  | raw artifact (test/type/build output) ordered before any change    |
| plan             | 3     | percussion  | orders the mechanical edits and marks reversible checkpoints       |
| execute          | 2     | percussion  | ordered local construction of the planned edits                    |
| verify           | 4     | piano       | integrates the reshaped code against the system contract end-to-end|
| prune            | 2     | brass       | assertive local removal of scaffolding tagged at introduction      |
