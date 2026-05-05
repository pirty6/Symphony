---
default-complexity: 4
verb-triggers: [investigate, explore, understand, clarify, analyze, assess, evaluate, examine, "how does", "why does", "what is", "is there", "should we keep", "is X still useful"]
---

# Investigate Algorithm

The canonical algorithm for answering a question about an existing system
without modifying it. The output is understanding plus a list of
follow-ups, not a code change.

## Steps

1. Clarify question — restate the user's prompt as the question to be
   investigated, AND if the prompt is multi-part or fuzzy, decompose it
   into concrete answerable sub-questions or a numbered list of items.
   The two operations are one numbered step but cognitively distinct;
   the proposer applies whichever mode the prompt requires.
2. Scope inventory — enumerate the items, files, or behaviors in bounds
   and explicitly mark what is out.
3. Locate references — find every direct and indirect use: dynamic
   dispatch, string keys, serialization, runtime config, type-only
   usages. Grep alone is insufficient.
4. Read semantics — at each reference, capture what the code actually
   does, not what its name suggests. One summary per reference.
5. Map relationships — describe how in-scope items depend on, produce,
   or consume each other.
6. Test hypotheses — per sub-question or item, propose a claim and
   actively seek counter-evidence (callers that contradict, tests that
   pin down, invariants that survive).
7. Classify findings — bucket each item: keep / remove / change /
   unresolved. The "unresolved" bucket is real; do not force a verdict.
8. Synthesize answer — answer every sub-question from step 1; mark
   explicitly which are answered, which are partial, which remain open.
9. Recommend follow-ups — per item, list next actions tagged with the
   target template (bug-fix, refactor, feature, decide, or "no action").

## Notes for the iteration

- Step 1 is load-bearing in two distinct modes. **Restate mode** is a
  cheap pass-through for clean prompts. **Decompose mode** is the most
  expensive cognitive step in the whole investigation when the prompt
  is multi-part or fuzzy — do not let it be silently skipped. If the
  output of step 1 is a single sentence when the prompt has many items,
  step 1 was done wrong.
- Step 3 is where investigations most often produce false confidence.
  Grep returning zero hits does NOT mean a field is unused — string
  keys, JSON paths, dynamic dispatch, registries, decorators, and
  serializer round-trips all hide usage.
- Step 7's "unresolved" bucket is required. An investigation that
  classifies every item as keep/remove/change is suspect; real
  investigations leave at least one open question.
- Step 7 (classify items found during investigation) and Step 9 (tag
  follow-ups by target template) do not overlap when Step 1's
  decompose mode was applied correctly. If they appear to overlap,
  recheck Step 1.
- Step 9 must produce a *list*, not a single recommendation. Mixed
  follow-ups (one refactor, one bug-fix, one no-action) are common and
  must not be collapsed.

### Wrong-template signals

- User describes broken behavior they want fixed → bug-fix
- User already knows the change they want → refactor or feature
- User wants to compare options before deciding → decide
- User's question is a pure keep/remove decision with no semantic
  unknowns → decide (not investigate)
- User wants a design from scratch → design template

### Common edit requests

- "Merge locate + read" — reject. Locate finds non-obvious references;
  read interprets them. Conflating them produces false negatives on
  vestigial-field audits.
- "Drop step 1, my question is clean" — accept as restate-mode
  pass-through, never as removal.
- "Drop the recommendation step" — reject. Investigations must
  terminate in a decision, even if "leave it alone."
- "Add a writeup step" — accept if the investigation feeds a durable
  artifact (ADR, architecture doc, repo memory note).

## Annotation

| Step                | Level | Instrument  | Why                                                              |
|---------------------|-------|-------------|------------------------------------------------------------------|
| clarify (restate)   | 1     | percussion  | mechanical pass-through of the user's prompt                     |
| clarify (decompose) | 5     | piano       | integrative reframing across many sub-questions                  |
| scope               | 3     | percussion  | orders what is in vs. out before evidence collection             |
| locate              | 2     | strings     | local pattern recognition across reference sites                 |
| read                | 3     | strings     | module-behavior reading; relational summaries at each site      |
| map                 | 3     | strings     | module-level relationships expressed as connections              |
| hypothesize         | 4     | woodwinds   | exploratory probing of contracts; per-item                       |
| classify            | 4     | brass       | assertive judgment per item against the question                 |
| synthesize          | 5     | piano       | integrates evidence, map, classifications into one answer set    |
| recommend           | 5     | percussion  | orders the next moves; closes the investigation                  |
