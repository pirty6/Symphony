/**
 * prompts.ts — Richer prompt templates for maestro pause points.
 *
 * The engine ships terse defaults inline. This module is for callers
 * (a CLI harness, an agent scaffold) that want fuller text aligned
 * with the .github/agents/maestro.agent.md voice. Pure string builders;
 * no engine state, no fs, no LLM.
 */

import type { Pattern } from "../patterns/types";
import type { Beat } from "../symphony/types";
import { MAESTRO_DRAFT_MAX_ROUNDS, MAESTRO_GO_PHRASES, type DebateComplexity, type Pause, type PatternSummary } from "./engine";

// ── Per-pause builders ─────────────────────────────────────────────

export function composerPromptFor(pause: Pause): string {
  switch (pause.kind) {
    case "match-pattern":
      return matchComposer(pause.payload.prompt, pause.payload.candidates);
    case "confirm-fit":
      return confirmComposer(pause.payload.pattern, pause.payload.matchedVerb);
    case "draft-pattern-round":
      return draftComposer(
        pause.payload.round,
        pause.payload.debateComplexity,
        pause.payload.priorDraft,
      );
    case "elicit-context":
      return elicitComposer(
        pause.payload.pattern,
        pause.payload.missingKeys,
        pause.payload.collected,
      );
    case "go-gate":
      return goGateComposer(
        pause.payload.pattern,
        pause.payload.context,
        pause.payload.beats,
      );
    case "perform-beat":
      return performComposer(pause.payload.beatIndex, pause.payload.beat);
  }
}

export function instrumentPromptFor(pause: Pause): string {
  switch (pause.kind) {
    case "match-pattern":
      return matchInstrument(pause.payload.candidates);
    case "confirm-fit":
      return confirmInstrument(pause.payload.pattern);
    case "draft-pattern-round":
      return draftInstrument(pause.payload.round, pause.payload.debateComplexity);
    case "elicit-context":
      return elicitInstrument(pause.payload.missingKeys);
    case "go-gate":
      return goGateInstrument();
    case "perform-beat":
      return performInstrument(pause.payload.beatIndex, pause.payload.beat);
  }
}

// ── Builders ───────────────────────────────────────────────────────

function matchComposer(prompt: string, candidates: readonly PatternSummary[]): string {
  return [
    "Multiple patterns match the user's prompt. Decide which one applies.",
    "",
    `Prompt: ${prompt}`,
    "",
    "Candidates:",
    ...candidates.map((c) => `  - ${c.pattern}  (matched verb: '${c.matchedVerb}')`),
    "",
    "Reply with: { kind: 'match-pattern', chosen: '<name>' | 'no-match' }",
  ].join("\n");
}

function matchInstrument(candidates: readonly PatternSummary[]): string {
  return `Pick one of: ${candidates.map((c) => c.pattern).join(", ")} or 'no-match'.`;
}

function confirmComposer(pattern: string, matchedVerb: string): string {
  return [
    `Pattern fit check. Matched verb '${matchedVerb}' → '${pattern}'.`,
    "",
    "Confirm in one sentence to the user, like:",
    `  > This is a '${pattern}' problem (matched verb: '${matchedVerb}').`,
    "",
    "If they object, reply with reroute=<other-pattern>.",
    "Reply with: { kind: 'confirm-fit', ok: boolean, reroute?: string }",
  ].join("\n");
}

function confirmInstrument(pattern: string): string {
  return `Confirm pattern '${pattern}' or reroute.`;
}

function draftComposer(
  round: number,
  complexity: DebateComplexity,
  priorDraft: Pattern | null,
): string {
  const agents = [
    "proposer",
    complexity >= 2 ? "skeptic" : null,
    complexity >= 3 ? "pragmatist" : null,
    complexity >= 4 ? "template-critic" : null,
  ].filter(Boolean) as string[];
  return [
    `Draft-pattern round ${round} of ${MAESTRO_DRAFT_MAX_ROUNDS} (complexity ${complexity}).`,
    "",
    `Spawn: ${agents.join(", ")}.`,
    priorDraft
      ? `Prior draft to iterate on:\n${JSON.stringify(priorDraft, null, 2)}`
      : "No prior draft; propose from scratch.",
    "",
    "Synthesize a Pattern TS module. Show it to the user in plain prose:",
    "  - 'How I got here.' (1 sentence on framing)",
    "  - 'What we argued about.' (biggest disagreement, plain English)",
    "  - 'What I'm not sure about.' (open risks)",
    "  - 'What I cut.' (over-engineering trimmed)",
    "  - Ask: save as tools/patterns/<name>.ts, or change something?",
    "",
    "Reply with: { kind: 'draft-pattern-round', outcome: 'approve'|'edit'|'ambiguous', nextDraft? }",
  ].join("\n");
}

function draftInstrument(round: number, complexity: DebateComplexity): string {
  return `Round ${round}, complexity ${complexity}. Run the debate, return a draft Pattern.`;
}

function elicitComposer(
  pattern: string,
  missing: readonly string[],
  collected: Readonly<Record<string, string>>,
): string {
  return [
    `Pattern '${pattern}' requires context. Some keys are still missing.`,
    "",
    `Missing: [${missing.join(", ")}]`,
    `Already collected: ${JSON.stringify(collected, null, 2)}`,
    "",
    "For each missing key:",
    "  1. Try to extract from the user's original prompt. State the extraction explicitly.",
    "  2. If not in the prompt, ask one targeted question.",
    "Do not guess. Empty / whitespace values will not advance.",
    "",
    "Reply with: { kind: 'elicit-context', values: { <key>: <value>, ... } }",
  ].join("\n");
}

function elicitInstrument(missing: readonly string[]): string {
  return `Provide values for: ${missing.join(", ")}. Empty values are rejected.`;
}

function goGateComposer(
  pattern: string,
  context: Readonly<Record<string, string>>,
  beats: number,
): string {
  return [
    "Ready to run.",
    "",
    `Pattern: ${pattern}`,
    `Beats:   ${beats}`,
    `Context:`,
    ...Object.entries(context).map(([k, v]) => `  ${k}: ${v}`),
    "",
    `Ask the user for explicit go. Accepted phrases (case-insensitive):`,
    `  ${MAESTRO_GO_PHRASES.join(", ")}`,
    "",
    "Vague positive language ('sounds fine-ish', 'yeah maybe') will be rejected.",
    "",
    "Reply with: { kind: 'go-gate', phrase: '<user phrase>' }",
  ].join("\n");
}

function goGateInstrument(): string {
  return `Send a canonical go phrase: ${MAESTRO_GO_PHRASES.join(", ")}.`;
}

function performComposer(beatIndex: number, beat: Beat): string {
  return [
    `Beat ${beatIndex}: ${beat.directive}`,
    "",
    `Level: ${beat.level}    Voices: ${beat.voices.map((v) => v.instrument).join(", ")}`,
    "",
    "Read-only beats → spawn maestro-assessor.",
    "Mutating beats → spawn maestro-executor with explicit write instructions.",
    "Capture each voice's output, then return a verdict.",
    "",
    "Reply with: { kind: 'perform-beat', voiceOutputs: [...], verdict: {...} }",
    "Voice shape: { instrument: string, output: string, confidence: number in [0,1] }.",
    "Verdict shape: { outcome: 'applied'|'failed'|'skipped', confidence, reason, shouldTerminate }.",
    "Wrong shape → engine fails the run before save.",
  ].join("\n");
}

function performInstrument(beatIndex: number, beat: Beat): string {
  return `Beat ${beatIndex} (${beat.voices.map((v) => v.instrument).join("+")}): ${beat.directive}`;
}
