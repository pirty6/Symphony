/**
 * prompts.ts — Paired prompt templates for the meta-score.
 *
 * Every judgment type has both a _composer and _instrument function.
 * Every _instrument declares ALLOWED TOOLS.
 * Both return non-empty strings.
 */

// ── Phase 1: Goal Clarification ────────────────────────────────────

export function promptGoalClarificationComposer(): string {
  return `Spawn Assessor with INSTRUMENT_INSTRUCTIONS and REVIEW_CONTEXT.

If goal IS concrete: use RE_INVOCATION_TEMPLATE, copy ACCUMULATED_FLAGS as-is, append:
  --goal-confirmed "<confirmed goal>" --success-condition "<success condition>"
If NOT concrete: ask the user for clarification. Do NOT guess.`;
}

export function promptGoalClarificationInstrument(): string {
  return `Instrument-Assessor. ALLOWED TOOLS: semantic_search, grep_search, file_search, read_file, list_dir.

Analyze the GOAL. Determine:
1. CONCRETE: Is it specific enough to verify completion? (YES/NO)
   - Concrete = testable end state. Vague = no verifiable condition.
2. If NOT concrete: list CLARIFICATION_QUESTIONS to make it concrete.
3. If concrete: propose SUCCESS_CONDITION — verifiable end state.

Return:
CONCRETE=YES|NO
SUCCESS_CONDITION=<if concrete>
CLARIFICATION_QUESTIONS=<if not concrete>`;
}

// ── Phase 2: Constraint Mapping ────────────────────────────────────

export function promptConstraintMappingComposer(): string {
  return `Goal and success condition confirmed. Map the boundaries.

Spawn Assessor with INSTRUMENT_INSTRUCTIONS and REVIEW_CONTEXT.

Use RE_INVOCATION_TEMPLATE, copy ACCUMULATED_FLAGS as-is, append:
  --constraints-confirmed true --invariants "<invariants>" --degrees-of-freedom "<degrees>" --quality-criteria "<criteria>"`;
}

export function promptConstraintMappingInstrument(): string {
  return `Instrument-Assessor. ALLOWED TOOLS: semantic_search, grep_search, file_search, read_file, list_dir.

Given GOAL, SUCCESS_CONDITION, DOMAIN, and CONSTRAINTS, search the codebase and identify:

1. INVARIANTS — must NOT change (e.g., public APIs, schemas, test contracts, auth flows).
2. DEGREES_OF_FREEDOM — CAN change (e.g., internal implementation, new files, config).
3. QUALITY_CRITERIA — what good looks like. Derive from KNOWLEDGE_CONTEXT if provided, else infer from codebase.

Return:
INVARIANTS=<comma-separated>
DEGREES_OF_FREEDOM=<comma-separated>
QUALITY_CRITERIA=<comma-separated>`;
}

// ── Phase 3: Problem Classification ────────────────────────────────

export function promptProblemClassificationComposer(): string {
  return `Goal, success condition, and constraints mapped. Classify the problem.

Spawn Assessor with INSTRUMENT_INSTRUCTIONS and REVIEW_CONTEXT.

Use RE_INVOCATION_TEMPLATE, copy ACCUMULATED_FLAGS as-is, append:
  --problem-class "<change_type>:<scope>:<known_shape_or_novel>"

Known shapes enable short-circuit: strategy discovery uses the known ladder directly.`;
}

export function promptProblemClassificationInstrument(): string {
  return `Instrument-Assessor. ALLOWED TOOLS: semantic_search, grep_search, file_search, read_file, list_dir.

Classify on three axes:

**Axis 1 — Change Type:** BEHAVIORAL | STRUCTURAL | HYGIENE
**Axis 2 — Scope:** LOCALIZED | SYSTEMIC
**Axis 3 — Known Shape:**
Known: SCHEMA_MIGRATION, RACE_CONDITION, CACHING, AUTH_FLOW, FEATURE_FLAG, API_VERSIONING, DEPENDENCY_UPGRADE, STATE_MACHINE
Otherwise: NOVEL (requires full brainstorming)

Search codebase to confirm. Look at affected files.

Return:
CHANGE_TYPE=BEHAVIORAL|STRUCTURAL|HYGIENE
SCOPE=LOCALIZED|SYSTEMIC
KNOWN_SHAPE=<shape or NOVEL>
KNOWN_SHAPE_RATIONALE=<why>
PROBLEM_CLASS=<change_type>:<scope>:<known_shape>`;
}

// ── Phase 4: Strategy Discovery ────────────────────────────────────

export function promptStrategyDiscoveryComposer(): string {
  return `Discover all possible strategies.

Spawn Assessor with INSTRUMENT_INSTRUCTIONS and REVIEW_CONTEXT.

Use RE_INVOCATION_TEMPLATE, copy ACCUMULATED_FLAGS as-is, append:
  --strategies-raw "<strategy1|strategy2|strategy3|...>"

Each strategy = short name, | delimited.`;
}

export function promptStrategyDiscoveryInstrument(): string {
  return `Instrument-Assessor. ALLOWED TOOLS: semantic_search, grep_search, file_search, read_file, list_dir, fetch_webpage.

If PROBLEM_CLASS has a known shape: use its known strategy ladder as starting point.
If NOVEL: brainstorm all plausible strategies.

Constraints from PROBLEM_CLASS:
- LOCALIZED → don't touch multiple modules
- HYGIENE → no architectural strategies
- BEHAVIORAL → prefer behavior changes without restructuring

For each strategy: name concisely, describe changes (1-2 sentences), note invariants respected.
Include narrow/safe, moderate, and wide/architectural approaches.

Return:
STRATEGY_1=<name>: <description>
...
STRATEGIES_RAW=<name1|name2|name3|...>`;
}

// ── Phase 5: Strategy Ordering ─────────────────────────────────────

export function promptStrategyOrderingComposer(): string {
  return `Order raw strategies into a safety ladder (safest → most invasive).

Spawn Assessor with INSTRUMENT_INSTRUCTIONS and REVIEW_CONTEXT.

Use RE_INVOCATION_TEMPLATE, copy ACCUMULATED_FLAGS as-is, append:
  --strategies-ordered "<strategy1|strategy2|strategy3|...>"`;
}

export function promptStrategyOrderingInstrument(): string {
  return `Instrument-Assessor. ALLOWED TOOLS: semantic_search, grep_search, file_search, read_file, list_dir.

Order strategies safest → most invasive by priority:
1. SCOPE (narrow first) 2. REVERSIBILITY (reversible first) 3. RISK (low first) 4. QUALITY (clean first)

For each: assign SCOPE narrow|moderate|wide, REVERSIBILITY reversible|partial|irreversible, RISK low|medium|high, QUALITY clean|acceptable|hacky.

Return:
ORDERING_RATIONALE=<why this order>
STRATEGIES_ORDERED=<strategy1|strategy2|strategy3|...>`;
}

// ── Phase 6: Verify Hook Definition ────────────────────────────────

export function promptVerifyHookComposer(): string {
  return `Define two tiers of verification hooks.

Spawn Assessor with INSTRUMENT_INSTRUCTIONS and REVIEW_CONTEXT.

Use RE_INVOCATION_TEMPLATE, copy ACCUMULATED_FLAGS as-is, append:
  --verify-hook-confirmed true --problem-hooks '[{"verify":"<cmd>"}, ...]' --strategy-hooks '[{"strategy":"<name>","verify":"<cmd>"}, ...]'

Problem hooks = from SUCCESS_CONDITION (survive escalation). Strategy hooks = strategy-specific (discarded on escalation).`;
}

export function promptVerifyHookInstrument(): string {
  return `Instrument-Assessor. ALLOWED TOOLS: semantic_search, grep_search, file_search, read_file, list_dir.

Define TWO TIERS of hooks:

**Tier 1 — Problem-level** (from SUCCESS_CONDITION/GOAL only, survive escalation):
Must NOT reference strategy details. E.g., "run: npm test", "check: endpoint returns 200".

**Tier 2 — Strategy-level** (strategy-specific, discarded on escalation):
Reference strategy artifacts. E.g., "check: flag 'collab' in config".

Rule: derivable purely from SUCCESS_CONDITION+GOAL → problem-level. References strategy implementation → strategy-level.

Return:
PROBLEM_HOOKS=[{"verify":"<cmd>"}, ...]
STRATEGY_HOOKS=[{"strategy":"<name>","verify":"<cmd>"}, ...]`;
}

// ── Phase 7: Score Emission ────────────────────────────────────────

export function promptScoreEmissionComposer(): string {
  return `If SPEC_APPROVED NOT set: present SPEC to human for review. HUMAN GATE — ask user to approve. On approval, use RE_INVOCATION_TEMPLATE, append:
  --spec-approved true

If SPEC_APPROVED IS set: spawn Executor to implement top strategy. Then append:
  --score-generated true`;
}

export function promptScoreEmissionInstrument(): string {
  return `Instrument-Assessor. ALLOWED TOOLS: read_file, list_dir.

If spec review (SPEC_APPROVED not set):
Verify: every strategy has a hook, strategies ordered safe→invasive, success condition verifiable, no invariant violations.
Return: SPEC_VALID=YES|NO, SPEC_ISSUES=<if NO>

If SPEC_APPROVED set:
Return: READY_TO_EMIT=YES`;
}

// ── Phase 8: Score Execution ───────────────────────────────────────

export function promptScoreExecutionComposer(): string {
  return `Strategy implemented. Present execution plan to human for approval. HUMAN GATE.

Show: strategies attempted, verify hooks to run, standard Symphony protocol.
On approval, use RE_INVOCATION_TEMPLATE, append:
  --execution-approved true

If declined, report and stop.`;
}

export function promptScoreExecutionInstrument(): string {
  return `Instrument-Assessor. ALLOWED TOOLS: read_file, list_dir, grep_search.

Review generated score for execution readiness:
1. score.sh exists, follows Symphony conventions (exit codes 0/1/2, judgment() calls)
2. prompts.sh has paired composer/instrument functions
3. Every instrument declares ALLOWED TOOLS
4. Strategy order matches approved spec

Return:
EXECUTION_READY=YES|NO
EXECUTION_ISSUES=<if NO>
STRATEGIES_TO_EXECUTE=<ordered list>`;
}
