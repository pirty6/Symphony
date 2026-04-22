# Symphony Architecture

A pattern for building deterministic, auditable AI agent workflows using state machines, structured prompt hand-offs, and strict role separation.

---

## Core Idea

Split every AI workflow into two strands — the **Double Helix**:

1. **Deterministic strand** (`score.sh`) — a bash state machine that controls flow and
   pauses with `exit 2` when a decision is needed.
2. **Intelligence strand** (Composer + Instruments) — AI agents that act only at
   explicit pause points, never in the middle of control flow.

The state machine is the Score. The agents are the Performers. The Stage is the pipe
that connects them.

---

## The Four Roles (Three Layers)

| Layer          | Role           | What it does                                                                                                                         |  Edit files?  | Spawn agents? |
| -------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------ | :-----------: | :-----------: |
| Infrastructure | **Stage**      | Pure pipe — runs bash, routes output. Zero decisions.                                                                                |       ✗       |       ✗       |
| Infrastructure | **Score**      | `score.sh` — deterministic state machine. Never writes files, never spawns agents.                                                   |       ✗       |       ✗       |
| Direction      | **Composer**   | Owns the full resolution loop. Reads Score instructions. Spawns Assessors for evidence. Decides. Spawns Executors. Re-invokes Score. |       ✗       |       ✓       |
| Performance    | **Instrument** | Does the actual work. Two sub-types: **Assessor** (read-only + viability judgment) and **Executor** (sole write path).               | Executor only |       ✗       |

### Why this split matters

- Stage and Score are deterministic — no AI hallucination in control flow
- Composer cannot corrupt state — no write permission, only spawn permission
- Assessor cannot corrupt state — read-only
- Executor is the only write path, and only after the Composer confirms viability
- **Mistakes are contained to the judgment layer**

---

## File Structure

Every Symphony skill needs at least three files, plus optional `lib/` and `test-score.sh`:

```
skills/my-skill/
  SKILL.md           # Stage instructions
  score.sh           # Deterministic state machine (bash)
  prompts.sh         # Paired prompt templates
  test-score.sh      # Tests (structural + behavioral)
  lib/               # Complex scripts called by score.sh
    analyze.ts       #   TypeScript, Node, etc.
    transform.sh     #   Heavier bash logic
```

### `score.sh` — The State Machine

```bash
#!/usr/bin/env bash
set -euo pipefail

: "${REQUIRED_VAR:?REQUIRED_VAR must be set}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "${SCRIPT_DIR}/prompts.sh"

emit_composer()   { printf 'COMPOSER_INSTRUCTIONS_BEGIN\n%s\nCOMPOSER_INSTRUCTIONS_END\n' "$1"; }
emit_instrument() { printf 'INSTRUMENT_INSTRUCTIONS_BEGIN\n%s\nINSTRUMENT_INSTRUCTIONS_END\n' "$1"; }

judgment() {
  local jtype="$1" composer="$2" instrument="$3"; shift 3
  echo "JUDGMENT_REQUEST: $jtype"
  echo "REVIEW_CONTEXT_BEGIN"
  local kv; for kv in "$@"; do [[ "${kv#*=}" != "" ]] && echo "$kv"; done
  echo "REVIEW_CONTEXT_END"
  emit_composer "$composer"
  emit_instrument "$instrument"
  exit 2
}

# Phase 1 → Phase N: deterministic work
# Call judgment() when AI intelligence is required
exit 0
```

**Exit codes:** `0` = success, `1` = fatal failure, `2` = judgment needed.

### `lib/` — Complex Scripts

When a phase needs logic that's awkward in bash (parsing, data transforms, API calls),
put it in `lib/` as a standalone script. `score.sh` calls these via `npx tsx`:

```bash
# score.sh calls a TypeScript script
result=$(npx tsx "${SCRIPT_DIR}/lib/analyze.ts" --input "$data" 2>&1) || {
  judgment "analysis-failed" \
    "$(prompt_analysis_failed_composer)" \
    "$(prompt_analysis_failed_instrument)" \
    "error=$result"
}
```

Lib scripts follow the same exit code contract as `score.sh`:

| Exit | Meaning                                        |
| ---- | ---------------------------------------------- |
| `0`  | Success — stdout has the result                |
| `1`  | Fatal failure — stderr has the error           |
| `2`  | Judgment needed — stdout has structured output |

Lib scripts must be **deterministic and testable** — no AI calls, no side effects
beyond their explicit output. They're part of the Score layer, not the Intelligence
layer.

```typescript
// lib/analyze.ts — Example lib script.

interface AnalysisResult {
  result: string;
}

function analyze(data: Record<string, unknown>): AnalysisResult {
  // Deterministic work...
  return { result: "ok" };
}

const args = process.argv.slice(2);
const inputIdx = args.indexOf("--input");
if (inputIdx === -1 || inputIdx + 1 >= args.length) {
  console.error("--input is required");
  process.exit(1);
}

try {
  const result = analyze(JSON.parse(args[inputIdx + 1]));
  console.log(JSON.stringify(result));
  process.exit(0);
} catch (e) {
  console.error(String(e));
  process.exit(1);
}
```

### `prompts.sh` — The Prompt Templates

Paired functions for every judgment type:

```bash
#!/usr/bin/env bash

prompt_<type>_composer() {
  cat <<'PROMPT'
What the Composer should do with the judgment result.
PROMPT
}

prompt_<type>_instrument() {
  cat <<'PROMPT'
Instrument-Assessor. ALLOWED TOOLS: <explicit list>.
What to investigate. Return structured findings.
PROMPT
}
```

**Invariants:**

- Every judgment type has **both** `_composer()` and `_instrument()` — no orphans
- Every `_instrument()` declares `ALLOWED TOOLS:` — explicit allowlist
- Both functions return non-empty output

### `SKILL.md` — The Stage Instructions

Tells the consumer to run bash, route exit codes, and hand off to the Composer.
The Stage makes zero decisions.

---

## Judgment Flow

```
score.sh exit 2 + structured blocks
  └─> Stage hands output to Composer
        └─> Composer spawns Assessor
              └─> Assessor returns APPROACH_VIABLE=YES|NO + findings
        └─> Composer decides to proceed or skip
        └─> Composer spawns Executor (if proceeding)
        └─> Composer re-invokes score.sh
```

The exit-2 output always contains two blocks:

```
COMPOSER_INSTRUCTIONS_BEGIN … COMPOSER_INSTRUCTIONS_END
INSTRUMENT_INSTRUCTIONS_BEGIN … INSTRUMENT_INSTRUCTIONS_END
```

---

## Permission Model

| Role                | Edit files? | Spawn agents? | Read/web? | Viability judgment? |
| ------------------- | :---------: | :-----------: | :-------: | :-----------------: |
| Stage               |      ✗      |       ✗       |     ✗     |          ✗          |
| Score               |      ✗      |       ✗       |     ✗     |          ✗          |
| Composer            |      ✗      |       ✓       |     ✓     |    ✗ (delegates)    |
| Instrument-Assessor |      ✗      |       ✗       |     ✓     |          ✓          |
| Instrument-Executor |      ✓      |       ✗       |     ✓     |          ✗          |

---

## Testing

Every Symphony skill has a `test-score.sh` with two categories of tests:

### Structural Tests (Role Pairing Guards)

These prevent accidental role removal during refactoring:

**1. Prompt Pairing** — every `_composer()` has a matching `_instrument()`:

```bash
composers=$(grep -oE '^prompt_[a-z_]+_composer\(' prompts.sh | sed 's/_composer(//;s/^prompt_//' | sort)
instruments=$(grep -oE '^prompt_[a-z_]+_instrument\(' prompts.sh | sed 's/_instrument(//;s/^prompt_//' | sort)
# Assert sets are equal
```

**2. Non-Empty Prompts** — source `prompts.sh`, call every `prompt_*()`, assert non-empty.

**3. ALLOWED TOOLS** — every `*_instrument()` output contains `ALLOWED TOOLS:`.

### Behavioral Tests

Test `score.sh` and `lib/` scripts directly:

```bash
# Test score.sh exit codes
output=$(env REPO_ROOT=/tmp bash score.sh 2>&1) || exit_code=$?
assert_eq "exits 0 on happy path" "0" "${exit_code:-0}"

# Test lib scripts
output=$(npx tsx lib/analyze.ts --input '{"test": true}' 2>&1) || exit_code=$?
assert_eq "analyze.ts exits 0" "0" "${exit_code:-0}"
assert_contains "returns JSON" '"result"' "$output"
```

### Watch Mode

Run tests automatically on every file change:

```bash
bash run-tests-watch.sh skills/my-skill
```

Uses `fswatch` if available (instant reload), falls back to 2s polling.
Watches `*.sh`, `*.ts`, `*.md` in the skill directory.

---

## Composability

An Executor can itself be a Symphony. Inner symphony exit codes bubble up to the outer
Composer:

```
Outer Symphony
  └── Executor = inner score.sh
        ├── Phase 1
        ├── Phase 2 (may exit 2 → outer Composer handles)
        └── Phase 3
```

---

## How to Build a New Symphony

1. Identify the phases (deterministic steps)
2. Identify judgment calls (where AI intelligence is needed)
3. Write `score.sh` — phases + `judgment()` calls at pause points
4. Write `prompts.sh` — paired `_composer()` + `_instrument()` for each judgment type
5. Add `lib/` scripts — for any logic too complex for bash (TypeScript, Node, etc.)
6. Write `SKILL.md` — Stage instructions
7. Write `test-score.sh` — structural tests + behavioral tests for score.sh and lib/
8. Set up watch mode — `bash run-tests-watch.sh skills/my-skill`
9. Register agents — Composer and Assessor entries in your agent list

### Checklist per judgment call

- [ ] `score.sh` calls `judgment()` with type, composer prompt, instrument prompt, context vars
- [ ] `prompts.sh` has `prompt_<type>_composer()` — non-empty, tells Composer what to do
- [ ] `prompts.sh` has `prompt_<type>_instrument()` — non-empty, declares `ALLOWED TOOLS:`
- [ ] `test-score.sh` triggers this exit 2
- [ ] Structural tests verify the pairing exists

---

## Key Design Decisions

| Decision                               | Reason                                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| Bash for the state machine             | Deterministic, auditable, testable — no AI hallucination in control flow                |
| Paired prompts                         | Composer decides _what to do_; Assessor decides _what the evidence shows_ — never mixed |
| `ALLOWED TOOLS:` in instrument prompts | Explicit tool allowlists are the security boundary per judgment type                    |
| One-shot vars with `unset`             | Prevents judgment results from leaking to subsequent phases or re-invocations           |
| Max invocation guard                   | Prevents infinite loops — force `exit 1` after N re-invocations                         |
| `exit 2` pause protocol                | Clean boundary between deterministic and AI layers — no in-band signaling               |
| `lib/` for complex scripts             | TypeScript/Node scripts follow the same exit code contract; tested alongside score.sh   |
| Watch mode testing                     | Instant feedback loop — structural + behavioral tests on every save                     |
