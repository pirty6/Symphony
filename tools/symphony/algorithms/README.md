# Algorithm Templates

This directory holds the catalog of generic problem-solving algorithms. **Files
here are authored by maestro on demand, not by humans up front.** When maestro
needs a template that does not exist, it drafts one, presents it to the user
for approval, and saves it here. Subsequent runs reuse it.

## Two-tier structure

```
algorithms/
  base/        <- generic, repo-agnostic templates. Reusable across any repo.
  local/       <- repo-specific overlays. Only present when this repo
                  customizes a base template's notes, conventions, or
                  verification steps. Never replaces base — composes on top.
```

When maestro loads `bug-fix`, it reads `base/bug-fix.md` first, then merges
`local/bug-fix.md` if it exists. The overlay never removes base steps; it
adds repo-specific notes per step, repo-specific verification commands, and
optional annotation overrides.

## Template structure

Every template has three sections:

1. **Steps** — the canonical numbered list. Verb + noun per step.
2. **Notes for the iteration** — known edit pressures: which steps are
   load-bearing, which signal the wrong template was chosen, common
   user requests and how to handle them.
3. **Annotation** — deterministic mapping from each step to its
   `(level, instrument)` pair, used during Score conversion.

Optional metadata at the top:

- `default-complexity: 1 | 2 | 3 | 4` — guides maestro's debate-architecture choice
- `verb-triggers: [...]` — phrases in the user's prompt that select this template

## Authoring discipline

When maestro drafts a new base template:
- Steps must be small (5–9 total). Split if longer.
- Steps must be verb-noun pairs, not paragraphs.
- Annotations must be mechanical: same verb + noun → same (level, instrument).
- The template must be approved by the user before being saved.
