# Baselines

Per-pattern non-regression baselines for SavedRuns. One JSON file per pattern under this directory. Read by `tools/scores/metrics.test.ts`.

## What's pinned

Each baseline records the four metrics computed by `runMetrics` in `tools/scores/metrics.ts`:

- `beatCount` — number of performed beats
- `spawnCount` — total voice outputs across all beats
- `wallMs` — `completedAt − startedAt` in ms (`undefined` for in-progress runs)
- `meanConfidence` — flat mean of every `voice.confidence` across all beats

## The four gates

`compareToBaseline(current, baseline)` fails on any of:

1. `current.beatCount  <  baseline.beatCount` — missing beats
2. `current.spawnCount <  baseline.spawnCount` — skipped voices
3. `current.wallMs     >  baseline.wallMs * 1.25` — > 25% slowdown (only when both defined)
4. `current.meanConfidence < baseline.meanConfidence − 0.1` — major confidence drop

## Refreshing a baseline (manual)

1. Pick the SavedRun to anchor against — typically the newest green run for the pattern under `tools/scores/store/<pattern>/`. Filenames sort lexicographically by ISO timestamp; descending sort yields newest first.
2. Compute the four metrics. Either use `runMetrics` from `metrics.ts` in a one-shot script, or compute by hand from the JSON.
3. Update the pattern's baseline JSON: paste the new `sourceFile`, `capturedAt`, and `metrics` block. Commit.

Hand-edit is intentional — baselines are a deliberate "this run is the floor", not a moving average.

## Skipped patterns

If `metrics` is `null`, the non-regression test skips that pattern with a reason in the test message. `feature` is currently skipped because `tools/scores/store/feature/` is empty — refresh after the first feature run lands.

## Beat-count changes require a baseline refresh

Adding or removing a beat in a pattern definition (`tools/patterns/<name>.ts`) raises or lowers the `beatCount`/`spawnCount` floors in this baseline. The `beatCount` gate above will go red on the next captured run if the pattern is changed without refreshing the corresponding baseline JSON in the same change. The reverse is also true: bumping a baseline floor without a matching captured SavedRun under `tools/scores/store/<pattern>/` will make the non-regression test red until a fresh run lands.

Workflow:

1. Make the pattern change.
2. Capture a fresh SavedRun by running the pattern through maestro on a small target.
3. Refresh the baseline JSON in the same commit.

## LINT_BEAT enforces oxlint clean

`tools/patterns/shared.ts` exports `LINT_BEAT`, the canonical lint-enforcement step. Patterns that touch source code should include `LINT_BEAT` near the end of their beat sequence (typically after `verify`, before any terminal `prune`). The beat halts if `oxlint` does not exit 0 — every error must either be fixed or explicitly suppressed with a rationale.
