# Symphony

A framework for building deterministic, auditable AI agent workflows. Symphony separates planning from execution and puts a state machine — not the AI — in charge of the workflow.

## The problem it solves

When you ask a chat AI to do a multi-step coding task ("refactor this", "add this feature", "investigate this bug"), the AI plans the steps _and_ executes them in the same head. It can skip steps, hallucinate that it did things it didn't, or drift mid-task. There's no referee.

Symphony and Maestro are this repo's answer: **separate the planning from the doing, and put a non-AI program in charge of the order.**

## The two halves

- **Symphony** is the _idea and the data shapes_. It says: every task is a sequence of small, named steps called **beats**. The full plan — the list of beats plus the inputs they need — is a **Score** (think: musical sheet music). The recording of what actually happened when you ran it is a **Performance**. Both are JSON files saved to disk, so you can audit, replay, and diff runs.

- **Maestro** is the _program that runs a Score_. It's a small state machine in TypeScript (`tools/maestro/engine.ts`). It decides what to do next; the AI only fills in the parts that need judgment.

## Patterns

A Pattern is a pre-built Score template. The repo ships four:

| Pattern           | Domain      | Required context      | Beats                                                              |
| ----------------- | ----------- | --------------------- | ------------------------------------------------------------------ |
| **`feature`**     | feature     | `scope`, `contract`   | frame → test → sketch → implement → cover → verify → lint          |
| **`refactor`**    | refactor    | `target`, `invariant` | frame → survey → plan → execute → verify → document → lint → prune |
| **`fix`**         | fix         | `bug`, `reproduction` | reproduce → diagnose → fix → cover → regress → document → lint     |
| **`investigate`** | investigate | _(none)_              | clarify → scope → map → hypothesize → answer → recommend           |

Each Pattern is a list of beats in a specific order. Each beat has a directive (what to do), a level (abstraction tier, 1–8), and voices with instrument types (`analyze`, `decide`, `question`, `order`, `integrate`). These Patterns were _pre-debated_ — the right beat sequence was argued once, saved, and now every run follows the same proven script.

## How a prompt flows through Maestro

You type something like _"refactor the prompts to use fewer tokens"_. Then:

1. **Pick a Pattern.** `feature`, `refactor`, `fix`, `investigate`, or `new` (let Maestro draft a custom one).
2. **Maestro pauses and asks: "is this Pattern a good fit?"** You say yes or reroute.
3. **Maestro asks for the missing inputs.** Each Pattern declares required fields (refactor needs `target` and `invariant`). Maestro refuses to advance until you fill them in. No guessing.
4. **Go gate.** Maestro asks for explicit approval. Only specific phrases work: `go`, `approved`, `proceed`, `looks good`, `ship it`. Vague approval is rejected.
5. **Beat-by-beat execution.** For each beat, Maestro spawns a small specialized AI:
   - **Assessor** — read-only. Searches code, reads files, returns findings.
   - **Executor** — write-only. Applies file edits as instructed.

   The engine validates each AI's response shape (right fields, valid confidence number, valid outcome). Malformed responses are rejected.

6. **Done.** A `Performance` JSON file records what every beat did. You can re-verify or replay it later.

## Architecture

### The compiler pipeline

The compiler (`tools/compiler/compile.ts`) transforms a Pattern + user context into an `ExecutableScore`:

1. Validates that all `requiredContext` keys are present.
2. Builds a `FrequencyMap` from the beat histogram (level × instrument distribution).
3. Asserts beat legality against the level/instrument matrix.
4. Computes a deterministic content-hash `id` for the Score.

There's also `parseAlgorithm()` for converting free-form algorithm descriptions (from the `new` pattern draft flow) into Scores, and `algorithmFromPattern()` for the `maestro plan` handoff.

### Typed event system

The engine emits a typed `MaestroEvent` union (`tools/maestro/types/event.ts`) with 13 event kinds: `run-started`, `pause-emitted`, `pattern-confirmed`, `pattern-rerouted`, `complexity-classified`, `draft-round-completed`, `context-collected`, `score-compiled`, `beat-started`, `beat-completed`, `run-completed`, `run-failed`, and `run-planned`. Events are pure return values from the engine (no side effects) and support visualization, structured logging, and CI integration.

### Visual run viewer

`tools/maestro/viewer.html` is a standalone viewer (no build step) that visualizes Maestro artifacts. It auto-detects the file type and renders accordingly:

- **Engine state files** (`.state.json`): beat-by-beat timeline with instrument budgets, confidence scores, verdict badges, expandable voice outputs, and live watch mode.
- **ExecutableScore files**: the compiled plan showing beat sequence, frequency map, domain key, context, and pattern provenance.
- **SavedRun files** (from `tools/scores/store/`): the Score's planned beats alongside the Performance's actual results — verdicts, confidence, outcomes, timing, and the original pattern template.

Drag-and-drop any JSON file or paste it. Dark theme, fully client-side. The viewer is split into three files: `viewer.html` (structure), `viewer.css` (styles), and `viewer.js` (logic).

### Beat legality

The legality matrix (`tools/symphony/legality.ts`) governs which level/instrument pairs are valid. Illegal pairs (e.g., level 1 + `question`, level 8 + `order`) are rejected at compile time, preventing incoherent beat definitions.

### Persistence and replay

Every completed run is saved as a `SavedRun` JSON file under `tools/scores/store/<pattern>/`. The `verify` CLI command can detect divergence between a saved run and a fresh Performance, enabling regression detection and replay.

## Why this beats a normal chat agent

|                                 | Plain chat agent                | Chat agent + skill file  | Maestro / Symphony                |
| ------------------------------- | ------------------------------- | ------------------------ | --------------------------------- |
| Who decides the next step?      | The AI                          | The AI (guided by prose) | A state machine in code           |
| Required inputs enforced?       | No                              | "Please"                 | Engine refuses to advance         |
| Read and write done by same AI? | Yes                             | Yes                      | No — separate Assessor & Executor |
| Response shape checked?         | No                              | No                       | Yes, every beat                   |
| Audit trail?                    | Chat log                        | Chat log                 | JSON artifact you can replay      |
| Failure mode                    | Hallucinated steps slip through | Skill quietly ignored    | State machine simply won't move   |

**The core shift:** in a chat, the AI's instructions are _suggestions it may follow loosely_. In Maestro, the same instructions are _rules the engine enforces_. The AI is only trusted with the parts that genuinely need judgment — the _order_, the _gates_, and the _shape of the work_ are owned by code, not by the model.

## Contributing

### Prerequisites

- **Node.js 20+** — CI runs on Node 20; the codebase uses `@types/node` v25 and TypeScript 6
- **Yarn** — the repo uses `yarn.lock` for dependency resolution; install via `corepack enable && corepack prepare yarn@stable --activate` or see [yarnpkg.com](https://yarnpkg.com/getting-started/install)

### Setup

```sh
git clone https://github.com/pirty6/Symphony.git
cd Symphony && yarn install
```

#### Using Maestro in VS Code Chat

Maestro registers as a VS Code Chat agent via `.github/agents/maestro.agent.md`. There are two scopes:

**When the Symphony repo is open** — `/maestro` appears in Chat automatically. VS Code discovers `.github/agents/*.agent.md` files in the workspace and registers them as chat agents. No extra setup needed.

**In any VS Code workspace (global)** — symlink the agent and prompt files to the VS Code user prompts directory:

```sh
# From the Symphony repo root
PROMPTS_DIR="$HOME/Library/Application Support/Code/User/prompts"  # macOS
# Linux:  PROMPTS_DIR="$HOME/.config/Code/User/prompts"
# Windows: PROMPTS_DIR="$APPDATA/Code/User/prompts"

mkdir -p "$PROMPTS_DIR"

# Symlink all agent files (maestro + its sub-agents)
for f in .github/agents/*.agent.md; do
  ln -snf "$(pwd)/$f" "$PROMPTS_DIR/$(basename "$f")"
done

# Symlink the maestro mode entry (registers /maestro in the Chat mode picker)
ln -snf "$(pwd)/.github/prompts/maestro.prompt.md" "$PROMPTS_DIR/maestro.prompt.md"
```

After this, `/maestro` appears in every VS Code window regardless of which repo is open.

**Required: set your clone path.** The agent instructions reference Symphony's CLI tools via an absolute path. Open `.github/agents/maestro.agent.md` and update the `SYMPHONY=` line to your clone location:

```sh
SYMPHONY=/path/to/your/Symphony
```

This path is used at runtime to invoke `tools/maestro/cli.ts` and `tools/patterns/cli.ts`. Since the symlinks point back to the repo, you only edit it once.

#### Symlink for global CLI access (optional)

If you want to run the Maestro CLI from other repos without specifying the full path, create a symlink:

```sh
# From the Symphony repo root — adjust the target if your clone is elsewhere
ln -snf "$(pwd)/tools/maestro/cli.ts" /usr/local/bin/maestro-cli
```

The `prepare` script installs Husky's git hooks on first install.

### Local checks

These three commands are the contract — CI and the `pre-push` hook run the same set:

```sh
yarn lint         # oxlint
yarn typecheck    # tsc -p tools/tsconfig.typecheck.json
yarn test         # jest --config tools/jest.config.js
```

### Pre-push hook

`.husky/pre-push` runs `lint`, `typecheck`, and `test` before any `git push`.
To bypass in an emergency: `git push --no-verify` (discouraged — CI will still fail).

### CI

GitHub Actions (`.github/workflows/ci.yml`) runs on every push to `main` and every pull request targeting `main`, executing the same three commands on Node 20. A green local run should imply a green CI run.
