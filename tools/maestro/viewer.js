/* ════════════════════════════════════════════════════════════════════
   Maestro Run Viewer — Pure Vanilla JS
   Supports: Engine State, ExecutableScore, SavedRun
   ════════════════════════════════════════════════════════════════════ */

// ─── DOM References ────────────────────────────────────────────────
const $dropZone    = document.getElementById("drop-zone");
const $dropArea    = document.getElementById("drop-area");
const $fileInput   = document.getElementById("file-input");
const $pasteInput  = document.getElementById("paste-input");
const $pasteBtn    = document.getElementById("paste-btn");
const $viewer      = document.getElementById("viewer");
const $backBtn     = document.getElementById("back-btn");
const $statusBadge = document.getElementById("status-badge");
const $pattern     = document.getElementById("header-pattern");
const $prompt      = document.getElementById("header-prompt");
const $timing      = document.getElementById("header-timing");
const $stepper     = document.getElementById("phase-stepper");
const $leftPanel   = document.getElementById("left-panel");
const $rightPanel  = document.getElementById("right-panel");
const $watchToggle = document.getElementById("watch-toggle");
const $exportBtn   = document.getElementById("export-btn");
const $toast       = document.getElementById("toast");
const $promptBanner = document.getElementById("prompt-banner");

const $library       = document.getElementById("library");
const $libraryList   = document.getElementById("library-list");
const $librarySearch = document.getElementById("library-search");

let currentData  = undefined;
let currentType  = undefined; // "engine-state" | "executable-score" | "saved-run"
let fileHandle   = undefined;
let watchTimer   = undefined;
let manifest     = [];

// ─── File Type Detection ───────────────────────────────────────────
function detectFileType(data) {
  if (!data || typeof data !== "object") {return undefined;}
  // SavedRun: has patternScore + executableScore + performance
  if (data.patternScore && data.executableScore && data.performance) {return "saved-run";}
  // ExecutableScore: has schemaVersion + id + frequencyMap + beats array
  if (data.schemaVersion && data.id && data.frequencyMap && Array.isArray(data.beats)) {return "executable-score";}
  // Engine state: has kind field (running | done | planned | failed)
  if (data.kind && ["running", "done", "planned", "failed"].includes(data.kind)) {return "engine-state";}
  return undefined;
}

// ─── File Loading ──────────────────────────────────────────────────
$dropArea.addEventListener("click", () => $fileInput.click());
$dropArea.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $fileInput.click(); }
});

$dropArea.addEventListener("dragover", (e) => {
  e.preventDefault(); $dropArea.classList.add("drag-over");
});
$dropArea.addEventListener("dragleave", () => $dropArea.classList.remove("drag-over"));
$dropArea.addEventListener("drop", (e) => {
  e.preventDefault(); $dropArea.classList.remove("drag-over");
  const file = e.dataTransfer.files[0];
  if (file) {readFile(file);}
});

$fileInput.addEventListener("change", () => {
  if ($fileInput.files[0]) {readFile($fileInput.files[0]);}
});

$pasteBtn.addEventListener("click", () => {
  const text = $pasteInput.value.trim();
  if (!text) {return;}
  try {
    const data = JSON.parse(text);
    loadData(data);
  } catch (err) {
    showToast("Invalid JSON: " + err.message);
  }
});

function readFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      loadData(data);
    } catch (err) {
      showToast("Invalid JSON: " + err.message);
    }
  };
  reader.readAsText(file);
}

// ─── Watch / Auto-refresh ──────────────────────────────────────────
$watchToggle.addEventListener("change", () => {
  if ($watchToggle.checked) {
    startWatching();
  } else {
    stopWatching();
  }
});

async function startWatching() {
  if (!("showOpenFilePicker" in window)) {
    showToast("File System Access API not available — watch mode disabled");
    $watchToggle.checked = false;
    return;
  }
  try {
    if (!fileHandle) {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
      });
      fileHandle = handle;
    }
    watchTimer = setInterval(async () => {
      try {
        const file = await fileHandle.getFile();
        const text = await file.text();
        const data = JSON.parse(text);
        loadData(data, true);
      } catch (_) { /* ignore transient read errors */ }
    }, 2000);
  } catch (_) {
    $watchToggle.checked = false;
  }
}

function stopWatching() {
  if (watchTimer) { clearInterval(watchTimer); watchTimer = undefined; }
}

// ─── Navigation ────────────────────────────────────────────────────
$backBtn.addEventListener("click", () => {
  stopWatching();
  $watchToggle.checked = false;
  fileHandle = undefined;
  if ($promptBanner) $promptBanner.classList.add("hidden");
  $viewer.classList.remove("visible");
  $dropZone.classList.remove("hidden");
});

$prompt.addEventListener("click", () => $prompt.classList.toggle("expanded"));
$prompt.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $prompt.classList.toggle("expanded"); }
});

// ─── Export ────────────────────────────────────────────────────────
$exportBtn.addEventListener("click", () => {
  if (!currentData) {return;}
  const summary = buildExportSummary(currentData, currentType);
  navigator.clipboard.writeText(JSON.stringify(summary, undefined, 2))
    .then(() => showToast("Copied to clipboard"))
    .catch(() => showToast("Copy failed"));
});

function buildExportSummary(data, type) {
  if (type === "executable-score") {
    return {
      type: "executable-score",
      id: data.id,
      pattern: data.pattern,
      totalBeats: data.beats?.length ?? 0,
      generatedAt: data.generatedAt,
      domain: data.frequencyMap?.key,
    };
  }
  if (type === "saved-run") {
    const p = data.performance;
    return {
      type: "saved-run",
      scoreId: data.executableScore?.id,
      pattern: data.executableScore?.pattern ?? data.patternScore?.pattern,
      outcome: p.outcome,
      totalBeats: p.beats.length,
      applied: p.beats.filter(b => b.verdict?.outcome === "applied").length,
      skipped: p.beats.filter(b => b.verdict?.outcome === "skipped").length,
      failed: p.beats.filter(b => b.verdict?.outcome === "failed").length,
      startedAt: p.startedAt,
      completedAt: p.completedAt,
    };
  }
  // engine-state
  const s = { type: "engine-state", kind: data.kind };
  if (data.kind === "running") {
    const i = data.internal;
    s.pattern = i.active?.patternName;
    s.prompt = i.prompt;
    s.draftRound = i.draftRound;
    s.performedBeats = i.performedBeats?.length ?? 0;
    s.pauseKind = data.pause?.kind;
    s.startedAt = i.startedAt;
  } else if (data.kind === "done") {
    const p = data.result.performance;
    s.outcome = p.outcome;
    s.totalBeats = p.beats.length;
    s.applied = p.beats.filter(b => b.verdict?.outcome === "applied").length;
    s.skipped = p.beats.filter(b => b.verdict?.outcome === "skipped").length;
    s.failed = p.beats.filter(b => b.verdict?.outcome === "failed").length;
    s.startedAt = p.startedAt;
    s.completedAt = p.completedAt;
  } else if (data.kind === "failed") {
    s.error = data.error;
  }
  return s;
}

// ─── Toast ─────────────────────────────────────────────────────────
function showToast(msg) {
  $toast.textContent = msg;
  $toast.classList.add("show");
  setTimeout(() => $toast.classList.remove("show"), 2500);
}

// ─── Helpers ───────────────────────────────────────────────────────
function esc(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function truncate(str, len) {
  if (!str) {return "";}
  return str.length > len ? str.slice(0, len) + "…" : str;
}

function formatTime(iso) {
  if (!iso) {return "—";}
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch { return iso; }
}

function friendlyDate(iso) {
  if (!iso) {return "";}
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) {return iso;}
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
}

function elapsed(startIso, endIso) {
  if (!startIso) {return "";}
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const sec = Math.floor((end - start) / 1000);
  if (sec < 60) {return sec + "s";}
  const min = Math.floor(sec / 60);
  return min + "m " + (sec % 60) + "s";
}

function field(label, value) {
  if (value === undefined || value === undefined) {return "";}
  return `<div class="payload-field">
    <div class="payload-label">${esc(label)}</div>
    <div class="payload-value">${esc(String(value))}</div>
  </div>`;
}

function renderKVTable(obj) {
  if (!obj || !Object.keys(obj).length) {return "—";}
  let html = `<table class="ctx-table">`;
  for (const [k, v] of Object.entries(obj)) {
    html += `<tr><td class="ctx-key">${esc(k)}</td><td class="ctx-val">${esc(String(v))}</td></tr>`;
  }
  html += `</table>`;
  return html;
}


// ─── Prompt Extraction ─────────────────────────────────────────────
// The user's original prompt is only preserved verbatim in EngineState
// internal.prompt. ExecutableScore and SavedRun do NOT store the raw
// prompt — it is hashed into generatedFrom.rawHash by fingerprintProblem().
// Context fields (problem, target, scope) are pattern-specific repo context,
// NOT the user's original prompt.
function extractOriginalPrompt(data, type) {
  if (type === "engine-state") {
    // "running" state preserves internal.prompt
    if (data.kind === "running") return data.internal?.prompt ?? "";
    // "done" state drops internal — prompt is not available
    if (data.kind === "done") return "";
    if (data.kind === "planned") return data.algorithm?.prompt ?? "";
    return "";
  }
  // SavedRun and ExecutableScore do not store the raw prompt.
  // The prompt was consumed by fingerprintProblem() at compile time.
  return "";
}

function showPromptBanner(promptText) {
  if (!promptText || !$promptBanner) {
    if ($promptBanner) $promptBanner.classList.add("hidden");
    return;
  }
  $promptBanner.classList.remove("hidden");
  $promptBanner.innerHTML =
    '<div class="prompt-banner-label">Original Prompt</div>' +
    '<div class="prompt-banner-text">' + esc(promptText) + '</div>';
}

// ─── Main Load Orchestrator ────────────────────────────────────────
function loadData(data, isRefresh) {
  const type = detectFileType(data);
  if (!type) {
    showToast("Unrecognized file format — expected Engine State, ExecutableScore, or SavedRun");
    return;
  }
  currentData = data;
  currentType = type;
  $dropZone.classList.add("hidden");
  $viewer.classList.add("visible");

  if (type === "engine-state") {
    renderEngineState(data);
  } else if (type === "executable-score") {
    renderExecutableScore(data);
  } else if (type === "saved-run") {
    renderSavedRun(data);
  }

  // Show original prompt banner (only available for running engine state)
  showPromptBanner(extractOriginalPrompt(data, type));

  if (!isRefresh) {
    const labels = { "engine-state": "Engine State", "executable-score": "ExecutableScore", "saved-run": "SavedRun" };
    showToast("Loaded: " + labels[type]);
  }
}

// ════════════════════════════════════════════════════════════════════
// ENGINE STATE RENDERING (existing functionality)
// ════════════════════════════════════════════════════════════════════

function renderEngineState(state) {
  renderEngineHeader(state);
  renderEngineStepper(state);
  $stepper.classList.remove("hidden");
  renderEngineLeftPanel(state);
  renderEngineRightPanel(state);
}

function renderEngineHeader(state) {
  $statusBadge.className = "status-badge " + state.kind;
  $statusBadge.textContent = state.kind;

  if (state.kind === "running") {
    const i = state.internal;
    $pattern.textContent = i.active?.patternName ?? "No pattern";
    $prompt.textContent = i.prompt ?? "";
    $prompt.title = i.prompt ?? "";
    $timing.textContent = "Started " + formatTime(i.startedAt) + " · " + elapsed(i.startedAt) + " elapsed";
  } else if (state.kind === "done") {
    const sc = state.result.executableScore;
    const p = state.result.performance;
    $pattern.textContent = sc?.pattern ?? sc?.id ?? "Score";
    $prompt.textContent = "";
    $timing.textContent = formatTime(p.startedAt) + " → " + formatTime(p.completedAt) + " · " + elapsed(p.startedAt, p.completedAt);
  } else if (state.kind === "planned") {
    $pattern.textContent = "Planned";
    $prompt.textContent = state.algorithm?.prompt ?? "";
    $timing.textContent = "";
  } else if (state.kind === "failed") {
    $pattern.textContent = "Failed";
    $prompt.textContent = state.error ? truncate(state.error, 100) : "";
    $timing.textContent = "";
  }
}

const PHASES = ["Route", "Context", "Gate", "Execute"];
const PAUSE_PHASE_MAP = {
  "confirm-fit": 0,
  "classify-complexity": 0,
  "draft-pattern-round": 0,
  "elicit-context": 1,
  "go-gate": 2,
  "perform-beat": 3,
};

function renderEngineStepper(state) {
  let activeIdx = -1;
  if (state.kind === "running" && state.pause) {
    activeIdx = PAUSE_PHASE_MAP[state.pause.kind] ?? -1;
  } else if (state.kind === "done") {
    activeIdx = 4;
  }

  let html = "";
  PHASES.forEach((name, i) => {
    const cls = i < activeIdx ? "complete" : i === activeIdx ? "active" : "";
    html += `<div class="phase-step ${cls}" aria-label="Phase: ${name}, ${cls || 'pending'}">
      <span class="step-num">${cls === "complete" ? "" : i + 1}</span>
      <span>${name}</span>
    </div>`;
    if (i < PHASES.length - 1) {
      html += `<div class="phase-connector ${i < activeIdx ? "complete" : ""}" aria-hidden="true"></div>`;
    }
  });
  $stepper.innerHTML = html;
}

function renderEngineLeftPanel(state) {
  if (state.kind === "failed") {
    $leftPanel.innerHTML = `<div class="error-display">
      <h3>Run Failed</h3>
      <pre>${esc(state.error ?? "Unknown error")}</pre>
    </div>`;
    return;
  }

  if (state.kind === "planned") {
    $leftPanel.innerHTML = `<div class="section-title">Planned Run</div>
      <p style="color:var(--color-text-muted)">This run has been planned but not yet started.</p>
      ${state.outPath ? `<p style="margin-top:8px;font-family:var(--font-mono);font-size:0.82rem">Output: ${esc(state.outPath)}</p>` : ""}`;
    return;
  }

  let scoreBeats = [];
  let performedBeats = [];
  let activeBeatIdx = -1;

  if (state.kind === "running") {
    scoreBeats = state.internal.score?.beats ?? [];
    performedBeats = state.internal.performedBeats ?? [];
    if (state.pause?.kind === "perform-beat") {
      activeBeatIdx = state.pause.payload?.beatIndex ?? -1;
    }
  } else if (state.kind === "done") {
    scoreBeats = state.result.executableScore?.beats ?? [];
    performedBeats = state.result.performance?.beats ?? [];
  }

  const perfMap = new Map();
  performedBeats.forEach(pb => perfMap.set(pb.beatIndex, pb));

  let html = `<div class="section-title">Beat Sequence (${scoreBeats.length} beats)</div>`;

  if (state.kind === "done") {
    html += renderPerformanceSummary(state.result.performance);
  }

  html += renderBeatFlow(scoreBeats, perfMap, activeBeatIdx);

  if (scoreBeats.length === 0) {
    html += `<p style="color:var(--color-text-muted);margin-top:12px">No beats in score yet.</p>`;
  }

  $leftPanel.innerHTML = html;
}

function renderEngineRightPanel(state) {
  let html = "";

  if (state.kind === "running") {
    html += renderPausePanel(state.pause);
    html += renderContextPanel(state.internal.context, state.pause);
  } else if (state.kind === "done") {
    html += renderContextPanel(state.result.executableScore?.context);
    html += renderScoreInfo(state.result.executableScore);
  } else if (state.kind === "planned") {
    html += `<div class="section-title">Algorithm Input</div>`;
    html += `<details class="collapsible-code" open>
      <summary>Algorithm config</summary>
      <pre>${esc(JSON.stringify(state.algorithm ?? {}, undefined, 2))}</pre>
    </details>`;
  } else if (state.kind === "failed") {
    html += `<div class="section-title">Error Details</div>
      <pre style="color:var(--color-failed);font-family:var(--font-mono);font-size:0.85rem;white-space:pre-wrap">${esc(state.error ?? "")}</pre>`;
  }

  $rightPanel.innerHTML = html;
}

// ════════════════════════════════════════════════════════════════════
// EXECUTABLE SCORE RENDERING
// ════════════════════════════════════════════════════════════════════

function renderExecutableScore(score) {
  // Header
  $statusBadge.className = "status-badge score";
  $statusBadge.textContent = "Score";
  $pattern.textContent = score.pattern ?? "Custom Score";
  $prompt.textContent = "ID: " + (score.id ?? "—");
  $prompt.title = score.id ?? "";
  $timing.textContent = "Generated " + formatTime(score.generatedAt);

  // Hide phase stepper — not applicable
  $stepper.classList.add("hidden");

  // Left: beat sequence
  let html = `<div class="section-title">Planned Beat Sequence (${score.beats?.length ?? 0} beats)</div>`;
  html += renderScoreBeatFlow(score.beats ?? []);
  $leftPanel.innerHTML = html;

  // Right: score metadata
  let right = "";
  right += renderScoreInfo(score);
  right += renderFrequencyMap(score.frequencyMap);
  right += renderContextPanel(score.context);
  if (score.generatedFrom) {
    right += `<div class="section-title">Problem Fingerprint</div>`;
    right += `<div class="pause-payload">`;
    right += field("Raw Hash", score.generatedFrom.rawHash);
    right += field("Canonical Hash", score.generatedFrom.canonicalHash);
    right += field("Schema Version", score.generatedFrom.schemaVersion);
    right += `</div>`;
  }
  $rightPanel.innerHTML = right;
}

function renderScoreBeatFlow(beats) {
  let html = `<div class="beat-flow">`;
  beats.forEach((beat, idx) => {
    html += `<div class="beat-card" role="article" aria-label="Beat ${idx}">`;
    html += `<div class="beat-header">`;
    html += `<span class="beat-index">#${idx}</span>`;
    html += `<span class="level-badge">L${beat.level}</span>`;
    if (beat.voices) {
      beat.voices.forEach(v => {
        html += `<span class="instrument-tag">${esc(v.instrument)}</span>`;
      });
    }
    html += `</div>`;
    html += `<div class="beat-directive">${esc(beat.directive ?? "")}</div>`;
    html += `</div>`;
    if (idx < beats.length - 1) {
      html += `<div class="beat-connector-line" aria-hidden="true"></div>`;
    }
  });
  html += `</div>`;
  return html;
}

// ════════════════════════════════════════════════════════════════════
// SAVED RUN RENDERING
// ════════════════════════════════════════════════════════════════════

function renderSavedRun(run) {
  const score = run.executableScore;
  const perf = run.performance;
  const patternName = score?.pattern ?? run.patternScore?.pattern ?? "Unknown";

  // Header
  $statusBadge.className = "status-badge saved-run";
  $statusBadge.textContent = "Saved Run";
  $pattern.textContent = patternName;
  $prompt.textContent = "Score: " + (score?.id ?? "—");
  $prompt.title = score?.id ?? "";
  $timing.textContent = formatTime(perf?.startedAt) + " → " + formatTime(perf?.completedAt) + " · " + elapsed(perf?.startedAt, perf?.completedAt);

  // Hide phase stepper — show all-complete stepper instead
  $stepper.classList.remove("hidden");
  renderAllCompleteStepper();

  // Left: beats with performance overlay
  const scoreBeats = score?.beats ?? [];
  const performedBeats = perf?.beats ?? [];
  const perfMap = new Map();
  performedBeats.forEach(pb => perfMap.set(pb.beatIndex, pb));

  let html = `<div class="section-title">Executed Beats (${scoreBeats.length} planned, ${performedBeats.length} performed)</div>`;
  html += renderPerformanceSummary(perf);
  html += renderBeatFlow(scoreBeats, perfMap, -1);
  $leftPanel.innerHTML = html;

  // Right: score info + pattern score + context
  let right = "";
  right += renderScoreInfo(score);
  right += renderFrequencyMap(score?.frequencyMap);
  right += renderContextPanel(score?.context);
  right += renderPatternScorePanel(run.patternScore);
  if (run.problemFingerprint) {
    right += `<div class="section-title">Run Metadata</div>`;
    right += `<div class="pause-payload">`;
    right += field("Problem Fingerprint", run.problemFingerprint);
    right += field("Timestamp", formatTime(run.timestamp));
    right += field("Schema Version", run.schemaVersion);
    right += `</div>`;
  }
  $rightPanel.innerHTML = right;
}

function renderAllCompleteStepper() {
  let html = "";
  PHASES.forEach((name, i) => {
    html += `<div class="phase-step complete" aria-label="Phase: ${name}, complete">
      <span class="step-num"></span>
      <span>${name}</span>
    </div>`;
    if (i < PHASES.length - 1) {
      html += `<div class="phase-connector complete" aria-hidden="true"></div>`;
    }
  });
  $stepper.innerHTML = html;
}

function renderPatternScorePanel(patternScore) {
  if (!patternScore) {return "";}
  let html = `<div class="pattern-score-panel">`;
  html += `<div class="section-title">Pattern Score (Template)</div>`;
  html += `<div class="pause-payload">`;
  html += field("Pattern", patternScore.pattern);
  html += field("Domain", patternScore.domain);
  html += `</div>`;
  if (patternScore.beats?.length) {
    html += `<div class="beat-list-compact">`;
    patternScore.beats.forEach((b, i) => {
      html += `<div class="beat-compact">
        <span class="beat-index">#${i}</span>
        <span class="beat-compact-step">${esc(b.step ?? "")}</span>
        <span class="level-badge">L${b.level}</span>
        <span class="beat-compact-instrument instrument-tag">${esc(b.instrument ?? "")}</span>
      </div>`;
    });
    html += `</div>`;
  }
  html += `</div>`;
  return html;
}

// ════════════════════════════════════════════════════════════════════
// SHARED RENDERING COMPONENTS
// ════════════════════════════════════════════════════════════════════

function agentIcon(producedBy) {
  if (producedBy === "maestro-assessor") return "\u{1F50D}";
  if (producedBy === "maestro-executor") return "\u{270F}\u{FE0F}";
  if (producedBy === "maestro-proposer") return "\u{1F4DD}";
  if (producedBy === "maestro-skeptic") return "\u{1F9D0}";
  if (producedBy === "maestro-pragmatist") return "\u{2696}\u{FE0F}";
  if (producedBy === "maestro-template-critic") return "\u{1F3AF}";
  return "\u{26A1}";
}

function renderBeatFlow(scoreBeats, perfMap, activeBeatIdx) {
  let html = `<div class="beat-flow">`;

  scoreBeats.forEach((beat, idx) => {
    const perf = perfMap.get(idx);
    const verdict = perf?.verdict;
    let cardClass = "";

    if (idx === activeBeatIdx) {
      cardClass = "active";
    } else if (verdict) {
      cardClass = verdict.outcome;
    }

    html += `<div class="beat-card ${cardClass}" role="article" aria-label="Beat ${idx}">`;
    html += `<div class="beat-header">`;
    html += `<span class="beat-index">#${idx}</span>`;
    html += `<span class="level-badge">L${beat.level}</span>`;
    if (idx === activeBeatIdx) {html += `<span class="active-badge">ACTIVE</span>`;}
    if (beat.voices) {
      beat.voices.forEach(v => {
        html += `<span class="instrument-tag">${esc(v.instrument)}</span>`;
      });
    }
    html += `</div>`;

    html += `<div class="beat-directive">${esc(beat.directive ?? "")}</div>`;

    // Performed voices — show as sub-agent branch nodes
    if (perf && perf.voices && perf.voices.length > 0) {
      const multiVoice = perf.voices.length > 1;
      html += `<div class="subagent-branches${multiVoice ? " multi" : ""}">`;
      perf.voices.forEach((voice, vi) => {
        const voiceId = `voice-${idx}-${vi}`;
        const full = voice.output ?? "";
        const agentName = voice.producedBy || "unknown";
        const shortAgent = agentName.replace("maestro-", "");
        const agentClass = agentName === "maestro-assessor" ? "agent-assessor"
          : agentName === "maestro-executor" ? "agent-executor" : "agent-other";
        const confPct = Math.round((voice.confidence ?? 0) * 100);

        html += `<div class="subagent-branch">`;
        html += `<div class="subagent-connector-line"></div>`;
        html += `<div class="subagent-node ${agentClass}">`;

        // Agent header
        html += `<div class="subagent-header">`;
        html += `<span class="subagent-icon">${agentIcon(agentName)}</span>`;
        html += `<span class="subagent-name">${esc(shortAgent)}</span>`;
        html += `<span class="subagent-instrument">${esc(voice.instrument)}</span>`;
        html += `<span class="subagent-conf">${confPct}%</span>`;
        html += `</div>`;

        // Collapsible output
        html += `<div class="voice-header" onclick="toggleVoice('${voiceId}')" role="button" tabindex="0" aria-expanded="false" aria-controls="${voiceId}-output">`;
        html += `<span class="arrow" id="${voiceId}-arrow">\u25B6</span>`;
        html += `<span>Output (${full.length} chars)</span>`;
        html += `</div>`;
        html += `<div class="voice-output" id="${voiceId}-output">${esc(full)}</div>`;

        // Confidence bar
        html += `<div class="confidence-bar-wrap">`;
        html += `<div class="confidence-bar"><div class="confidence-bar-fill" style="width:${confPct}%"></div></div>`;
        html += `<span class="confidence-label">${confPct}%</span>`;
        html += `</div>`;

        html += `</div>`; // .subagent-node
        html += `</div>`; // .subagent-branch
      });
      html += `</div>`; // .subagent-branches
    }

    // Verdict
    if (verdict) {
      html += `<div class="verdict-row">`;
      html += `<span class="verdict-badge ${verdict.outcome}">${esc(verdict.outcome)}</span>`;
      html += `<div class="confidence-bar-wrap" style="flex:0">`;
      html += `<div class="confidence-bar"><div class="confidence-bar-fill" style="width:${Math.round((verdict.confidence ?? 0) * 100)}%"></div></div>`;
      html += `<span class="confidence-label">${Math.round((verdict.confidence ?? 0) * 100)}%</span>`;
      html += `</div>`;
      if (verdict.shouldTerminate) {html += `<span class="verdict-badge failed">TERM</span>`;}
      html += `<span class="verdict-reason">${esc(verdict.reason ?? "")}</span>`;
      html += `</div>`;
    }

    html += `</div>`;

    if (idx < scoreBeats.length - 1) {
      html += `<div class="beat-connector-line" aria-hidden="true"></div>`;
    }
  });

  html += `</div>`;
  return html;
}

function renderPerformanceSummary(perf) {
  if (!perf) {return "";}
  const beats = perf.beats ?? [];
  const applied = beats.filter(b => b.verdict?.outcome === "applied").length;
  const skipped = beats.filter(b => b.verdict?.outcome === "skipped").length;
  const failed  = beats.filter(b => b.verdict?.outcome === "failed").length;
  const outcomeColor = perf.outcome === "success" ? "var(--color-applied)"
    : perf.outcome === "failed" ? "var(--color-failed)"
    : perf.outcome === "partial" ? "var(--color-skipped)"
    : "var(--color-active)";

  return `<div class="perf-summary">
    <div class="perf-grid">
      <div>
        <div class="perf-stat-value" style="color:${outcomeColor}">${esc(perf.outcome ?? "—")}</div>
        <div class="perf-stat-label">Outcome</div>
      </div>
      <div>
        <div class="perf-stat-value">${beats.length}</div>
        <div class="perf-stat-label">Total</div>
      </div>
      <div>
        <div class="perf-stat-value" style="color:var(--color-applied)">${applied}</div>
        <div class="perf-stat-label">Applied</div>
      </div>
      <div>
        <div class="perf-stat-value" style="color:var(--color-skipped)">${skipped}</div>
        <div class="perf-stat-label">Skipped</div>
      </div>
      <div>
        <div class="perf-stat-value" style="color:var(--color-failed)">${failed}</div>
        <div class="perf-stat-label">Failed</div>
      </div>
      <div>
        <div class="perf-stat-value">${elapsed(perf.startedAt, perf.completedAt)}</div>
        <div class="perf-stat-label">Duration</div>
      </div>
    </div>
  </div>`;
}

function renderFrequencyMap(freqMap) {
  if (!freqMap) {return "";}
  let html = `<div class="freq-map">`;
  html += `<div class="section-title">Frequency Map</div>`;
  html += field("Domain Key", freqMap.key);
  const activeLevels = freqMap.activeLevels ?? [];
  html += `<div class="freq-levels">`;
  for (let l = 1; l <= 8; l += 1) {
    const isActive = activeLevels.includes(l);
    html += `<div class="freq-level-bar ${isActive ? "active" : "inactive"}">${l}</div>`;
  }
  html += `</div>`;
  html += `</div>`;
  return html;
}

function renderPausePanel(pause) {
  if (!pause) {return `<div class="section-title">Pause</div><p style="color:var(--color-text-muted)">No active pause</p>`;}

  let html = `<div class="pause-panel">`;
  html += `<div class="section-title">Current Pause</div>`;
  html += `<div class="pause-kind-badge">${esc(pause.kind)}</div>`;
  html += `<div class="pause-id" title="${esc(pause.pauseId ?? "")}">${esc(pause.pauseId ?? "—")}</div>`;

  html += `<div class="pause-payload">`;
  html += renderPausePayload(pause.kind, pause.payload);
  html += `</div>`;

  if (pause.composerPrompt) {
    html += `<details class="collapsible-code">
      <summary>Composer Prompt</summary>
      <pre>${esc(pause.composerPrompt)}</pre>
    </details>`;
  }

  if (pause.instrumentPrompt) {
    html += `<details class="collapsible-code">
      <summary>Instrument Prompt</summary>
      <pre>${esc(pause.instrumentPrompt)}</pre>
    </details>`;
  }

  html += `</div>`;
  return html;
}

function renderPausePayload(kind, payload) {
  if (!payload) {return "";}
  let html = "";

  switch (kind) {
    case "confirm-fit":
      html += field("Pattern", payload.pattern);
      html += field("Description", payload.description);
      break;
    case "classify-complexity":
      html += field("Prompt", payload.prompt);
      break;
    case "draft-pattern-round":
      html += field("Round", `${payload.round} / ${payload.maxRounds}`);
      html += field("Complexity", payload.complexity);
      html += field("Base Hint", payload.baseHint);
      if (payload.priorDraft) {
        html += `<details class="collapsible-code">
          <summary>Prior Draft</summary>
          <pre>${esc(JSON.stringify(payload.priorDraft, undefined, 2))}</pre>
        </details>`;
      }
      break;
    case "elicit-context":
      html += field("Pattern", payload.pattern);
      if (payload.missingKeys?.length) {
        html += `<div class="payload-field">
          <div class="payload-label">Missing Keys</div>
          <div class="payload-value">${payload.missingKeys.map(k => `<span class="missing-key">${esc(k)}</span>`).join(", ")}</div>
        </div>`;
      }
      if (payload.collected && Object.keys(payload.collected).length) {
        html += `<div class="payload-field">
          <div class="payload-label">Collected</div>
          <div class="payload-value">`;
        html += renderKVTable(payload.collected);
        html += `</div></div>`;
      }
      break;
    case "go-gate":
      html += field("Pattern", payload.pattern);
      html += field("Beats", payload.beats);
      if (payload.context && Object.keys(payload.context).length) {
        html += `<div class="payload-field">
          <div class="payload-label">Context</div>
          <div class="payload-value">${renderKVTable(payload.context)}</div>
        </div>`;
      }
      break;
    case "perform-beat":
      html += field("Beat Index", payload.beatIndex);
      if (payload.beat) {
        html += field("Level", payload.beat.level);
        html += field("Directive", payload.beat.directive);
        if (payload.beat.voices) {
          html += `<div class="payload-field">
            <div class="payload-label">Voices</div>
            <div class="payload-value">${payload.beat.voices.map(v => `<span class="instrument-tag">${esc(v.instrument)}</span>`).join(" ")}</div>
          </div>`;
        }
      }
      if (payload.previousOutputs?.length) {
        html += `<details class="collapsible-code">
          <summary>Previous Outputs (${payload.previousOutputs.length})</summary>
          <pre>${esc(JSON.stringify(payload.previousOutputs, undefined, 2))}</pre>
        </details>`;
      }
      break;
    default:
      html += `<details class="collapsible-code" open>
        <summary>Payload</summary>
        <pre>${esc(JSON.stringify(payload, undefined, 2))}</pre>
      </details>`;
  }
  return html;
}

function renderContextPanel(context, pause) {
  const ctx = context ?? {};
  const missingKeys = (pause?.kind === "elicit-context" && pause.payload?.missingKeys) || [];
  const hasEntries = Object.keys(ctx).length > 0 || missingKeys.length > 0;

  if (!hasEntries) {return "";}

  let html = `<div class="context-panel">`;
  html += `<div class="section-title">Context</div>`;
  html += `<table class="ctx-table" role="table" aria-label="Context key-value pairs">`;

  for (const [k, v] of Object.entries(ctx)) {
    html += `<tr><td class="ctx-key">${esc(k)}</td><td class="ctx-val">${esc(String(v))}</td></tr>`;
  }

  for (const k of missingKeys) {
    if (!(k in ctx)) {
      html += `<tr><td class="ctx-key missing-key">${esc(k)}</td><td class="ctx-val missing-key">missing</td></tr>`;
    }
  }

  html += `</table></div>`;
  return html;
}

function renderScoreInfo(score) {
  if (!score) {return "";}
  let html = `<div class="section-title">Score Info</div>`;
  html += `<div class="pause-payload">`;
  html += field("ID", score.id);
  html += field("Pattern", score.pattern);
  html += field("Schema Version", score.schemaVersion);
  html += field("Generated At", formatTime(score.generatedAt));
  if (score.frequencyMap) {
    html += field("Key", score.frequencyMap.key);
    html += field("Active Levels", score.frequencyMap.activeLevels?.join(", "));
  }
  html += `</div>`;
  return html;
}

// ─── Voice Toggle ──────────────────────────────────────────────────
window.toggleVoice = function(voiceId) {
  const output = document.getElementById(voiceId + "-output");
  const arrow = document.getElementById(voiceId + "-arrow");
  if (!output || !arrow) {return;}
  const isOpen = output.classList.toggle("expanded");
  arrow.classList.toggle("open", isOpen);
  const header = arrow.closest(".voice-header");
  if (header) {header.setAttribute("aria-expanded", String(isOpen));}
};

// ════════════════════════════════════════════════════════════════════
// LIBRARY — auto-load manifest when served via dev server
// ════════════════════════════════════════════════════════════════════

async function tryLoadManifest() {
  try {
    const res = await fetch("/api/manifest");
    if (!res.ok) { return; }
    manifest = await res.json();
    if (!Array.isArray(manifest) || manifest.length === 0) { return; }
    showLibrary();
  } catch {
    // Not served via dev server — library stays hidden
  }
}

function showLibrary() {
  $library.classList.remove("hidden");
  $dropZone.classList.add("has-library");
  renderLibrary(manifest);
}

function renderLibrary(entries) {
  if (!entries.length) {
    $libraryList.innerHTML = '<div class="library-empty">No saved runs found</div>';
    return;
  }

  const groups = {};
  for (const entry of entries) {
    const groupKey = entry.category === "run"
      ? "Runs — " + entry.pattern
      : entry.category === "baseline"
        ? "Baselines"
        : "Fixtures";
    if (!groups[groupKey]) { groups[groupKey] = []; }
    groups[groupKey].push(entry);
  }

  let html = "";
  for (const [groupName, items] of Object.entries(groups)) {
    html += '<div class="library-group">';
    html += '<div class="library-group-header">' + esc(groupName) + ' <span class="library-group-count">(' + items.length + ')</span></div>';
    for (const item of items) {
      const promptSnippet = item.prompt ? truncate(item.prompt, 60) : "";
      const dateStr = item.timestamp ? friendlyDate(item.timestamp) : "";
      const typeLabel = item.category === "run" ? "saved run" : item.category;
      const outcomeClass = item.outcome === "success" ? "applied"
        : item.outcome === "failed" ? "failed"
        : item.outcome === "partial" ? "skipped" : "";

      html += '<div class="library-item" data-path="' + esc(item.path) + '" role="button" tabindex="0" title="' + esc(item.filename) + '">';
      html += '<div class="library-item-main">';
      if (promptSnippet) {
        html += '<div class="library-item-prompt">' + esc(promptSnippet) + '</div>';
      } else {
        html += '<div class="library-item-name">' + esc(item.filename.replace(".json", "")) + '</div>';
      }
      if (dateStr) { html += '<div class="library-item-time">' + esc(dateStr) + '</div>'; }
      html += '</div>';
      html += '<div class="library-item-badges">';
      if (item.outcome) {
        html += '<span class="library-item-outcome ' + outcomeClass + '">' + esc(item.outcome) + '</span>';
      }
      if (item.beatCount != null) {
        html += '<span class="library-item-beats">' + item.beatCount + ' beats</span>';
      }
      html += '<span class="library-item-type">' + esc(typeLabel) + '</span>';
      html += '</div>';
      html += '</div>';
    }
    html += '</div>';
  }
  $libraryList.innerHTML = html;

  $libraryList.querySelectorAll(".library-item").forEach(el => {
    el.addEventListener("click", () => loadFromLibrary(el.dataset.path));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); loadFromLibrary(el.dataset.path); }
    });
  });
}

async function loadFromLibrary(path) {
  try {
    const res = await fetch(path);
    if (!res.ok) { showToast("Failed to load: " + res.statusText); return; }
    const data = await res.json();
    loadData(data);
  } catch (err) {
    showToast("Error loading file: " + err.message);
  }
}

if ($librarySearch) {
  $librarySearch.addEventListener("input", () => {
    const query = $librarySearch.value.toLowerCase().trim();
    if (!query) {
      renderLibrary(manifest);
      return;
    }
    const filtered = manifest.filter(e =>
      e.filename.toLowerCase().includes(query) ||
      (e.pattern ?? "").toLowerCase().includes(query) ||
      e.category.toLowerCase().includes(query) ||
      (e.prompt ?? "").toLowerCase().includes(query) ||
      (e.outcome ?? "").toLowerCase().includes(query)
    );
    renderLibrary(filtered);
  });
}

tryLoadManifest();
