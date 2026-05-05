# `tools/` — Map of the systems

This directory contains **two independent systems**.

```
tools/
├── meta-score/       # 8-phase prompt-loop CLI (legacy, fallback only)
└── symphony/         # Score / Beat / Performance — runtime artifacts for maestro
```

The two are unrelated and do not import each other. `meta-score` is the
older approach; `symphony` is what `maestro` uses today.

> Build artifacts (`tools/lib/`) are produced by `tsc` and are not checked
> in. Runtime entry points use `tsx` and execute the `.ts` sources
> directly; `lib/` only matters when the package is published.

---

## meta-score/

A standalone CLI that walks a problem through 8 prompt phases:
`goal → constraints → classification → discovery → ordering →
verify-hooks → score-emission → score-execution`.

- **Status:** legacy. Used as a fallback when `maestro` cannot reach
  agreement with the user on an algorithm. Most flows now skip it.
- **Type-name collision:** `meta-score.ts` exports `ScoreResult`, which
  is unrelated to `symphony`'s `Score`. Rename pending (target #2 in
  the cleanup investigation).
- **Entry:** `tools/meta-score/cli.ts`.

## symphony/

The runtime artifacts that `maestro` produces and consumes:

| Type | Role |
|------|------|
| `Score` | A plan: `frequencyMap` + `tempo` + `beats[]` + ids |
| `Beat` | One step: `{ level, voices[], directive }` |
| `Voice` | One instrument's contribution to a beat |
| `Performance` | The recording: per-beat `voices[].output` + `MoveVerdict` |
| `FrequencyMap` | Mechanically derived from beats; level histogram |
| `SavedRun` | `{ score, performance }` round-trippable on disk |

Pipeline: `parseAlgorithm(input) → Score`,
then `performScore(score, executor) → Performance`.

- `parse.ts` — algorithm-text → Score (deterministic)
- `perform.ts` — beat executor harness
- `persistence.ts` — load/save SavedRun
- `legality.ts` — sparse legality matrix for (level, instrument) pairs
- `algorithms/` — base + local templates (feature, investigate, refactor)
- `runs/` — saved investigations and their performances
- `examples/` — handwritten Score builders for cross-checking the parser
- `cli.ts` — `verify`, `parse`, `scaffold-performance`

`TempoConfig` is currently empty; see open question #2 below.

---

## When to use which

| You want to… | Go to |
|--------------|-------|
| Run `maestro` on a real problem | `symphony/` (parse + perform) |
| Add a new algorithm template | `symphony/algorithms/{base,local}/` |
| Fall back to the prompt-driven loop | `meta-score/` |

## Open architectural questions

See `tools/symphony/runs/investigate-cleanup-targets/` for the full
list. The remaining ones after the May 2026 cleanup:

1. **Rename `meta-score.ScoreResult`** → `MetaScoreResult` to remove
   the collision with `symphony.Score`.
2. **`Tempo`**: delete the empty wrapper, or repopulate it with fields
   a real executor will read.
3. **Provenance cluster** (`computeScoreId`, `schemaVersion`,
   `fingerprintProblem`, `generatedFrom`): keep for replay or drop
   (gated on a reproducibility-policy decision, "Q0").

## Cleanup history (May 2026)

- Deleted `tools/symphony/heuristic.ts` (dead — superseded by
  `parse.ts` deriving `FrequencyMap` mechanically).
- Stripped `Conservatism` and `beatsPerMeasure` from `TempoConfig`
  (no consumer read either field).
- Deleted `tools/refactoring/` and `tools/symphony-core/` — a parallel
  framework with the only consumer being its own tests. Resolved the
  `MoveVerdict` name duplication and the parallel-vocabulary problem.
- `tools/lib/` build output is no longer committed; only the source
  files live in git.
