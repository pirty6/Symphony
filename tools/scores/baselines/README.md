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

## Three layers, one chain

The non-regression gate is built from three committed artifacts that move together:

| Layer | Path | Status | Role |
| --- | --- | --- | --- |
| Live runs | `tools/scores/store/<pattern>/*.json` | gitignored, local-only | Every maestro run lands here. Source of truth for picking a new fixture. |
| Fixtures | `tools/scores/fixtures/<pattern>.json` | committed | One frozen SavedRun per pattern. The test runs `runMetrics` against this exact file on every machine. |
| Baselines | `tools/scores/baselines/<pattern>.json` | committed | The pinned floor for the four metrics. `sourceFile` points at the fixture. |

Initially the baseline is computed from the fixture, so the gate compares the fixture to itself — any drift in metric-extraction logic (`runMetrics`) goes red immediately.

## Refreshing a baseline (manual)

1. Run the pattern through maestro. A new SavedRun lands under `tools/scores/store/<pattern>/`.
2. Pick the SavedRun to anchor against (typically the newest green run; filenames sort lexicographically by ISO timestamp).
3. Copy it over the fixture: `cp tools/scores/store/<pattern>/<id>.json tools/scores/fixtures/<pattern>.json`. Do not reformat — the test reads it as bytes-on-disk and any mutation can change metrics.
4. Recompute the four metrics from the new fixture (use `runMetrics` from `metrics.ts` or compute by hand).
5. Update the pattern's baseline JSON: `sourceFile` to `tools/scores/fixtures/<pattern>.json`, fresh `capturedAt`, fresh `metrics` block.
6. Commit fixture + baseline together.

Hand-edit is intentional — baselines are a deliberate "this run is the floor", not a moving average.

## CI behavior

Two describe blocks back the baselines, both unconditional:

- `baseline-validity` — validates each baseline JSON's shape (`patternName`, `sourceFile`, `capturedAt`, `metrics` fields well-formed; `metrics === null` permitted). Catches malformed baseline edits.
- `non-regression` — loads `tools/scores/fixtures/<pattern>.json`, runs `runMetrics` on it, and compares against the baseline. Same fixture → same metrics → same result on every machine. No skips, no dependency on local `store/` contents.

If a baseline's `metrics` is `null`, the non-regression test for that pattern skips with a reason — refresh per the workflow above.

## Beat-count changes require a baseline refresh

Adding or removing a beat in a pattern definition (`tools/patterns/<name>.ts`) raises or lowers the `beatCount`/`spawnCount` floors in this baseline. The `beatCount` gate above will go red on the next captured run if the pattern is changed without refreshing the corresponding fixture + baseline JSON in the same change.

Workflow:

1. Make the pattern change.
2. Capture a fresh SavedRun by running the pattern through maestro on a small target.
3. Refresh the fixture and baseline JSON in the same commit.

## LINT_BEAT enforces oxlint clean

`tools/patterns/shared.ts` exports `LINT_BEAT`, the canonical lint-enforcement step. Patterns that touch source code should include `LINT_BEAT` near the end of their beat sequence (typically after `verify`, before any terminal `prune`). The beat halts if `oxlint` does not exit 0 — every error must either be fixed or explicitly suppressed with a rationale.

## Seeding a brand-new pattern (no SavedRun yet)

When a pattern is registered before any real run has been captured (e.g. the initial commit that introduces it), commit a placeholder baseline with `metrics: null` and no fixture file:

```json
{
  "patternName": "<name>",
  "sourceFile": null,
  "capturedAt": null,
  "metrics": null
}
```

The `non-regression` block in `tools/scores/metrics.test.ts` skips patterns with `metrics === null`, and `baseline-validity` accepts the placeholder shape. Once the pattern has been exercised against a real target:

1. Run it through maestro and capture the SavedRun under `tools/scores/store/<name>/`.
2. Copy that SavedRun to `tools/scores/fixtures/<name>.json`.
3. Compute `runMetrics` from the fixture and rewrite `baselines/<name>.json` with real `sourceFile`, `capturedAt`, and `metrics`.
4. Commit the fixture and baseline together.

This is the workflow for `fix.json` today: registered, placeholder baseline only, no fixture — the next real bug repair run populates both.
