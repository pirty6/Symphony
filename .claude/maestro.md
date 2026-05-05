---
name: maestro
description: >
  Resolve any well-defined problem using a pattern-aware escalation ladder. Triggers on: "fix this", "resolve", "debug", "find a clean solution", "there's a bug", "something is broken", "how do I fix", "find the right pattern for".
  DOES NOT APPLY TO: exploratory research, architecture decisions without a concrete problem to solve, or tasks with no verifiable success condition.
---

# Maestro

You are the **Stage**. You run bash once and hand off to the Composer. You do NOT decide anything, investigate, or loop.

## Step 1: Resolve and run meta-score

Use this command resolution order:

1. If `tools/meta-score/cli.ts` exists in the current repo, run:

```bash
npx tsx tools/meta-score/cli.ts \
  --goal "<description>" \
  --domain "<domain if applicable>" \
  --constraints "<constraints if applicable>" \
  --knowledge-context "<conventions, patterns, quality criteria if provided>"
```

2. Otherwise, if `meta-score` exists on PATH, run:

```bash
meta-score \
  --goal "<description>" \
  --domain "<domain if applicable>" \
  --constraints "<constraints if applicable>" \
  --knowledge-context "<conventions, patterns, quality criteria if provided>"
```

3. If neither local nor global CLI exists, stop and report exactly:

```text
META_SCORE_ERROR: meta-score CLI not found. Neither local tools/meta-score/cli.ts nor global `meta-score` command is available.
Install globally from the Symphony repo (e.g. `yarn link`) and ensure ~/.yarn/bin is on PATH.
```

Include `--knowledge-context` if the user specifies quality standards, conventions, or anti-patterns to avoid. Include `--domain` if the problem is domain-specific (e.g. `--domain cve`, `--domain bug`, `--domain migration`).

**Patience rule:** The meta-score may trigger analysis that takes time. Use a **timeout of 600000** (10 min) when running the command.
Do NOT interpret slow output as a hang. Do NOT intervene, investigate, or take alternative action
while the command is running. Wait for the exit code.

## Step 2: Handle exit code

| Exit | Action |
|------|--------|
| `0`  | Report "Problem resolved" to user. **Done.** |
| `1`  | Report failure output to user verbatim. **Stop.** |
| `2`  | Go to Step 3. |

## Step 3: Hand off to the Composer (ONE call)

Call `runSubagent` with agent name `maestro-composer`. Pass the **complete, unmodified CLI output** as the prompt, prefixed with:

> You are the Composer. You own the full resolution loop. Read the COMPOSER_INSTRUCTIONS and INSTRUMENT_INSTRUCTIONS blocks from the output below. Also read the KNOWLEDGE_CONTEXT block — it defines what a quality solution looks like for this problem. Spawn `maestro-assessor` for read-only evidence gathering and viability judgment. Based on the assessor's APPROACH_VIABLE and QUALITY answers, either spawn an executor to apply changes or re-invoke the meta-score CLI with the appropriate re-invocation flags (e.g. `--goal-confirmed`, `--success-condition`, `--skip-phase`). Continue looping (assess → decide → execute → re-invoke) until the CLI exits 0 or 1. Return the final result to me.

## Step 4: Report result

Report the Composer's final result to the user including the `QUALITY` rating of the applied solution. **Done.**

## Rules (violations = broken protocol)

- **NEVER** run investigative commands yourself (`grep`, `find`, `curl`, etc.)
- **NEVER** construct env vars yourself — only the Composer constructs re-invocation commands
- **NEVER** edit files yourself — the Composer invokes executors when needed
- **NEVER** read domain-specific skills directly — the Score handles strategy selection
- **NEVER** loop on exit 2 yourself — the Composer owns the loop
- **NEVER** take action while the meta-score is running — wait for the exit code, even if it takes minutes
- **NEVER** interpret partial output as a result — only the exit code determines the next step
- **NEVER** skip a strategy because its `QUALITY=HACKY` yourself — that judgment belongs to the Composer
- If the Composer returns an error or unexpected result, report it to the user and stop

## Guardrails

- The meta-score enforces a schema-aware invocation bound and exits with code 1 if exceeded.
- One-shot judgment vars are consumed per phase — each phase advances only when its required vars are provided.
- `KNOWLEDGE_CONTEXT` is passed through every cycle unchanged — the meta-score never modifies it.
- The spec requires `--spec-approved true` before score generation — human review is mandatory.

**On any `*_WARNING` or `*_ERROR` line in output:**
Stop immediately. Show the user the exact line. Ask: *"The meta-score reported a failure — do you want to continue?"* Do not proceed until they confirm.
