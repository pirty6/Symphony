# Maestro and Symphony, from scratch

## The problem they solve

When you ask a chat AI to do a multi-step coding task ("refactor this", "add this feature", "investigate this bug"), the AI plans the steps _and_ executes them in the same head. It can skip steps, hallucinate that it did things it didn't, or drift mid-task. There's no referee.

Symphony and Maestro are this repo's answer: **separate the planning from the doing, and put a non-AI program in charge of the order.**

## The two halves

- **Symphony** is the _idea and the data shapes_. It says: every task is a sequence of small, named steps called **beats**. The full plan — the list of beats plus the inputs they need — is a **Score** (think: musical sheet music). The recording of what actually happened when you ran it is a **Performance**. Both are JSON files saved to disk, so you can audit, replay, and diff runs.

- **Maestro** is the _program that runs a Score_. It's a small state machine in TypeScript (engine.ts). It decides what to do next; the AI only fills in the parts that need judgment.

## A Pattern is a pre-built Score template

The repo ships three Patterns (patterns):

- **`feature`** — add a new capability
- **`refactor`** — restructure code without changing behavior
- **`investigate`** — answer a question about the codebase

Each Pattern is just a list of beats in a specific order. For example, refactor's beats are: `frame → survey → plan → execute → verify → prune`. Each beat has a directive (what to do) and a tag for what kind of work it is (read-only analysis vs. file edit vs. decision).

These Patterns were _pre-debated_ — humans argued about the right beat sequence once, saved it, and now every refactor follows the same proven script. You don't re-derive the playbook every time.

## How a prompt flows through Maestro

You type something like _"refactor the prompts to use fewer tokens"_. Then:

1. **Pick a Pattern.** `feature`, `refactor`, `investigate`, or `new` (let Maestro draft a custom one).
2. **Maestro pauses and asks: "is this Pattern a good fit?"** You say yes or reroute.
3. **Maestro asks for the missing inputs.** Each Pattern declares required fields (refactor needs `target` and `invariant`). Maestro refuses to advance until you fill them in. No guessing.
4. **Go gate.** Maestro asks for explicit approval. Only specific phrases work: `go`, `approved`, `proceed`, `looks good`, `ship it`. Vague approval is rejected.
5. **Beat-by-beat execution.** For each beat, Maestro spawns a small specialized AI:
   - **Assessor** — read-only. Searches code, reads files, returns findings.
   - **Executor** — write-only. Applies file edits as instructed.
     The engine validates each AI's response shape (right fields, valid confidence number, valid outcome). Malformed responses are rejected.
6. **Done.** A `Performance` JSON file is saved to store recording what every beat did. You can re-verify or replay it later.

## Why this beats a normal chat agent

Imagine a chat agent doing the same refactor. It reads your prompt, picks an approach in its head, edits files, claims it ran tests. If it skipped a step or made up a result, you only find out when something breaks.

|                                 | Plain chat agent                | Chat agent + skill file  | Maestro / Symphony                |
| ------------------------------- | ------------------------------- | ------------------------ | --------------------------------- |
| Who decides the next step?      | The AI                          | The AI (guided by prose) | A state machine in code           |
| Required inputs enforced?       | No                              | "Please"                 | Engine refuses to advance         |
| Read and write done by same AI? | Yes                             | Yes                      | No — separate Assessor & Executor |
| Response shape checked?         | No                              | No                       | Yes, every beat                   |
| Audit trail?                    | Chat log                        | Chat log                 | JSON artifact you can replay      |
| Failure mode                    | Hallucinated steps slip through | Skill quietly ignored    | State machine simply won't move   |

**The core shift:** in a chat, the AI's instructions are _suggestions it may follow loosely_. In Maestro, the same instructions are _rules the engine enforces_. The AI is only trusted with the parts that genuinely need judgment ("does this Pattern fit?", "did this beat achieve its directive?") — the _order_, the _gates_, and the _shape of the work_ are owned by code, not by the model.

A skill tells the AI what _should_ happen. Symphony refuses to continue when it doesn't.

## Contributing

### Prerequisites

- Node.js 20.x
- Yarn (the repo uses `yarn.lock` for dependency resolution)

### Setup

```sh
yarn install
```

The `prepare` script installs Husky's git hooks on first install.

### Local checks

These three commands are the contract — CI and the `pre-push` hook run the same set:

```sh
yarn lint         # oxlint
yarn typecheck    # tsc -p tools/tsconfig.typecheck.json
yarn test            # jest --config tools/jest.config.js
```

### Pre-push hook

`.husky/pre-push` runs `lint`, `typecheck`, and `test` before any `git push`.
To bypass in an emergency: `git push --no-verify` (discouraged — CI will still fail).

### CI

GitHub Actions (`.github/workflows/ci.yml`) runs on every push to `main` and
every pull request targeting `main`, executing the same three commands on
Node 20. A green local run should imply a green CI run.

### Baselines

Performance baselines under `tools/scores/baselines/` gate the non-regression
suite. When a pattern's beat sequence changes, the corresponding baseline must
be refreshed from a fresh SavedRun. See
[tools/scores/baselines/README.md](tools/scores/baselines/README.md).

## Using Maestro in your VS Code workspaces

Maestro runs as a VS Code Copilot Chat agent. The agent definitions live in `.github/agents/` inside this repo. VS Code automatically discovers `.agent.md` files in that directory and registers them as chat participants, so the setup is: clone Symphony once, then link its agents into every workspace where you want Maestro available.

### One-time setup

1. **Clone Symphony** somewhere permanent on your machine:

   ```sh
   git clone https://github.com/<org>/Symphony.git ~/Symphony
   cd ~/Symphony && yarn install
   ```

2. **Update the absolute path in `maestro.agent.md`.** Open `.github/agents/maestro.agent.md` and change the `SYMPHONY=` line to match where you cloned the repo:

   ```sh
   SYMPHONY=/Users/<you>/Symphony
   ```

   Every CLI invocation in the agent file uses this path, so it must be correct. Do the same for any hardcoded paths in the file (the `yarn tsx ...` commands).

### Per-workspace setup

For each VS Code workspace where you want to use Maestro, symlink the agents directory:

```sh
cd /path/to/your-project
mkdir -p .github
ln -s ~/Symphony/.github/agents .github/agents
```

This creates a symlink so VS Code discovers the agent files without duplicating them. When you update Symphony (e.g. `git pull`), every workspace picks up the changes automatically.

> **Tip:** If you prefer not to commit the symlink to your project's repo, add `.github/agents` to your project's `.gitignore`.

### Using Maestro

Once the agents are linked, open VS Code Copilot Chat and switch to **maestro** mode (click the mode selector at the top of the chat panel). Then just describe your task:

- _"refactor the auth module to use dependency injection"_
- _"add a rate-limiting middleware to the API"_
- _"investigate why the tests flake on CI"_

Maestro will:

1. Pick a pattern (`feature`, `refactor`, `investigate`, or `fix`) — or draft a new one.
2. Ask you to confirm the fit and fill in required context.
3. Present a go-gate for explicit approval.
4. Execute beat-by-beat, spawning read-only assessors and write-only executors.
5. Save a `Performance` JSON artifact you can audit.

### Requirements

- **VS Code** with GitHub Copilot Chat (agent mode must be enabled).
- **Node.js 20+** — Symphony's CLIs run via `yarn tsx`, which needs Node and the installed dependencies in the Symphony clone.
- The Symphony repo must have its dependencies installed (`yarn install`).
