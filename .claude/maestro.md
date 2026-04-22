---
name: maestro
description: >
  Resolve any well-defined problem using a pattern-aware escalation ladder. Triggers on: "fix this", "resolve", "debug", "find a clean solution", "there's a bug", "something is broken", "how do I fix", "find the right pattern for".
  DOES NOT APPLY TO: exploratory research, architecture decisions without a concrete problem to solve, or tasks with no verifiable success condition.
---

# Maestro

You are the **Stage**. You run bash once and hand off to the Composer. You do NOT decide anything, investigate, or loop.

## Step 1: Run score.sh

```bash
env REPO_ROOT="$(pwd)" PROBLEM_DESCRIPTION="<description>" \
  KNOWLEDGE_CONTEXT="<conventions, patterns, quality criteria if provided>" \
  bash ".claude/skills/maestro/references/score.sh"
```

Include `KNOWLEDGE_CONTEXT` if the user specifies quality standards, conventions, or anti-patterns to avoid. Include `DOMAIN` if the problem is domain-specific (e.g. `DOMAIN=cve`, `DOMAIN=bug`, `DOMAIN=migration`). Use `env VAR=val` (inline), never `export`.

**Patience rule:** score.sh may run installs, builds, network fetches, and analysis
that routinely take 2–10 minutes. Use a **timeout of 600000** (10 min) when running the command.
Do NOT interpret slow output as a hang. Do NOT intervene, investigate, or take alternative action
while the command is running. Wait for the exit code. If the terminal times out, use
`get_terminal_output` to check progress — do NOT start over or run parallel commands.

## Step 2: Handle exit code

| Exit | Action |
|------|--------|
| `0`  | Report "Problem resolved" to user. **Done.** |
| `1`  | Report failure output to user verbatim. **Stop.** |
| `2`  | Go to Step 3. |

## Step 3: Hand off to the Composer (ONE call)

Call `runSubagent` with agent name `maestro-composer`. Pass the **complete, unmodified bash output** as the prompt, prefixed with:

> You are the Composer. You own the full resolution loop. Read the COMPOSER_INSTRUCTIONS and INSTRUMENT_INSTRUCTIONS blocks from the output below. Also read the KNOWLEDGE_CONTEXT block — it defines what a quality solution looks like for this problem. Spawn `maestro-assessor` for read-only evidence gathering and viability judgment. Based on the assessor's APPROACH_VIABLE and QUALITY answers, either spawn an executor to apply changes or re-invoke score.sh with SKIP_STRATEGY. Continue looping (assess → decide → execute → re-invoke score.sh) until score.sh exits 0 or 1. Return the final result to me.

## Step 4: Report result

Report the Composer's final result to the user including the `QUALITY` rating of the applied solution. **Done.**

## Rules (violations = broken protocol)

- **NEVER** run investigative commands yourself (`grep`, `find`, `curl`, etc.)
- **NEVER** construct env vars yourself — only the Composer constructs re-invocation commands
- **NEVER** edit files yourself — the Composer invokes executors when needed
- **NEVER** read domain-specific skills directly — the Score handles strategy selection
- **NEVER** loop on exit 2 yourself — the Composer owns the loop
- **NEVER** take action while score.sh is running — wait for the exit code, even if it takes minutes
- **NEVER** interpret partial output as a result — only the exit code determines the next step
- **NEVER** skip a strategy because its `QUALITY=HACKY` yourself — that judgment belongs to the Composer
- If the Composer returns an error or unexpected result, report it to the user and stop

## Guardrails

- `score.sh` enforces `MAX_INVOCATIONS=16` and rejects re-invocations where both `APPLY_COMPLETE` and `SKIP_STRATEGY` are set.
- One-shot judgment vars (`APPLY_COMPLETE`, `SKIP_STRATEGY`, `QUALITY`, `PATTERN_USED`) are consumed and unset by `score.sh` automatically.
- `KNOWLEDGE_CONTEXT` is passed through every cycle unchanged — the Score never modifies it.

**On any `*_WARNING` or `*_ERROR` line in output:**
Stop immediately. Show the user the exact line. Ask: *"score.sh reported a failure — do you want to continue?"* Do not proceed until they confirm.

