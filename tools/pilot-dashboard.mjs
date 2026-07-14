#!/usr/bin/env node
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { availableParallelism } from "node:os";
import { Script } from "node:vm";
import { writeJsonAtomicSync } from "../src/artifact-io.js";
import { buildDashboardCurrentRunStatus } from "../src/dashboard-current-run.js";
import { buildOverallDeckRankings } from "../src/deck-rankings.js";
import { trainingResourcePlan } from "../src/training-resources.js";
import {
  pilotDashboardTrainingDefaults as sharedDashboardTrainingDefaults,
  pilotExplorationDefaults as sharedExplorationDefaults
} from "../src/pilot-training-presets.js";
import {
  COUNTERFACTUAL_STATE_EVALUATION_VERSION,
  MAX_ML_RUNTIME_DOMINANT_ACTION_PAIR_RATE,
  MAX_ML_RUNTIME_HISTORICAL_UNCLASSIFIED_EXAMPLES,
  MAX_ML_RUNTIME_VALIDATION_DOMINANT_ACTION_PAIR_RATE,
  MIN_LEARNING_EVIDENCE_FILTER_VERSION,
  MIN_LEARNING_SOURCE_DIGEST_VERSION,
  MIN_ML_EVIDENCE_DIVERSITY_VERSION,
  MIN_ML_PAIRWISE_INPUT_CONSISTENCY_VERSION,
  MIN_ML_PAIRWISE_EFFECTIVE_WEIGHT_VERSION,
  MIN_ML_RUNTIME_DISTINCT_ACTION_PAIRS,
  MIN_ML_RUNTIME_DISTINCT_OPPONENTS,
  MIN_ML_RUNTIME_DISTINCT_PHASES,
  MIN_ML_RUNTIME_DIVERSITY_EXAMPLES,
  MIN_ML_RUNTIME_HELDOUT_GAMES,
  MIN_ML_RUNTIME_PAIRWISE_EXAMPLES,
  MIN_ML_RUNTIME_PAIRWISE_EFFECTIVE_WEIGHT,
  MIN_ML_RUNTIME_TRUST,
  MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_ACCURACY,
  MIN_ML_RUNTIME_VALIDATION_BALANCED_ACCURACY,
  MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_EXAMPLES,
  MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_GAMES,
  MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_SIGN_EXAMPLES,
  MIN_ML_RUNTIME_VALIDATION_CONSISTENCY_REPEATED_CONTEXTS,
  MIN_ML_RUNTIME_VALIDATION_CONSISTENCY_REPEATED_EXAMPLES,
  MIN_ML_RUNTIME_VALIDATION_DISTINCT_ACTION_PAIRS,
  MIN_ML_RUNTIME_VALIDATION_DISTINCT_OPPONENTS,
  MIN_ML_RUNTIME_VALIDATION_DISTINCT_PHASES,
  MIN_ML_RUNTIME_VALIDATION_PAIRWISE_EFFECTIVE_WEIGHT,
  MIN_ML_PAIRWISE_ORIENTATION_VERSION,
  MIN_ML_REGRESSION_VERSION,
  MIN_ML_TRAINING_PIPELINE_VERSION,
  MIN_ML_VALIDATION_ASSIGNMENT_VERSION,
  MIN_ML_VALIDATION_DIVERSITY_VERSION,
  MIN_ML_VALIDATION_STATE_VERSION,
  MAX_ML_RUNTIME_VALIDATION_INPUT_CONFLICT_RATE,
  completedMatchupMetricSummary,
  mlActionModelReadiness,
  mlValidationInputConsistency,
  matchupOverlayReadiness,
  matchupOverlayRuntimeTrust
} from "../src/index.js";
import {
  actionModelCandidatePathsForKey,
  actionModelPathForKey,
  baselineDeckDirForKey,
  baselineOriginPathForKey,
  baselinePolicyPathForKey,
  matchupOverlayCandidateFilesForKey,
  matchupOverlayFilesForKey,
  policyKeySegment as routePolicyKeySegment,
  resolveArchetypeProfile
} from "../src/policy-router.js";

const AGENT_ROOT = option("--agent-root") ?? "work/private/pilot-agent";
const DECK_LIBRARY = option("--library") ?? "work/private/decks";
const CATALOG_PATH = option("--catalog") ?? "work/private/egman-unionarena-catalog.json";
const DASHBOARD_DECK_PREFIX = option("--dashboard-deck-prefix") ?? "carnerr-,engine-";
const TRAINING_LOGICAL_PROCESSORS = Math.max(1, availableParallelism());
const DEFAULT_TRAINING_RESOURCE_PLAN = trainingResourcePlan({
  logicalProcessors: TRAINING_LOGICAL_PROCESSORS,
  workerBudget: option("--training-worker-budget")
});
const TRAINING_WORKER_BUDGET = DEFAULT_TRAINING_RESOURCE_PLAN.workerBudget;
const BASELINE_SUITE_CONCURRENCY_DEFAULT = Math.max(1, Number(option("--baseline-suite-concurrency-default") ?? 1));
const RUNS_ROOT = option("--runs-root") ?? join(AGENT_ROOT, "runs");
const DECK_EXPERIMENT_ROOT = option("--deck-experiment-root") ?? join(AGENT_ROOT, "deck-experiments");
const POLICY_DIR = option("--policy-dir") ?? join(AGENT_ROOT, "policies");
const BASELINE_ROOT = option("--baseline-root") ?? join(AGENT_ROOT, "baselines");
const DASHBOARD_DIR = option("--dashboard-dir") ?? join(AGENT_ROOT, "dashboard");
const HOST = option("--host") ?? "127.0.0.1";
const PORT = Number(option("--port") ?? 8787);
const CARD_EVIDENCE_MAX_FILES = Number(option("--card-evidence-max-files") ?? 240);
const CARD_EVIDENCE_MAX_ROWS = Number(option("--card-evidence-max-rows") ?? 2500000);
const CARD_EVIDENCE_MAX_FILE_BYTES = Number(option("--card-evidence-max-file-mb") ?? 256) * 1024 * 1024;
const CARD_EVIDENCE_CACHE_MS = Number(option("--card-evidence-cache-seconds") ?? 3600) * 1000;
const CARD_EVIDENCE_WARM_DELAY_MS = Math.max(0, Number(option("--card-evidence-warm-delay-ms") ?? 750));
const DASHBOARD_ANALYTICS_CACHE_MS = Number(option("--analytics-cache-seconds") ?? 30) * 1000;
const STATE_PATH = join(DASHBOARD_DIR, "controller-state.json");
const PREFS_PATH = join(DASHBOARD_DIR, "dashboard-prefs.json");
const LOG_PATH = join(DASHBOARD_DIR, "loop.log");
const RUNTIME_LOG_PATH = join(DASHBOARD_DIR, "dashboard-runtime.log");
const CARD_EVIDENCE_CACHE_PATH = join(DASHBOARD_DIR, "card-evidence-cache.json");
const CARD_EVIDENCE_CACHE_SCHEMA = "union-arena-local-engine/dashboard-card-evidence-cache@3";

if (process.argv.includes("--check-html")) {
  assertDashboardHtmlScripts(dashboardHtml());
  console.log("Dashboard HTML and embedded scripts are syntactically valid.");
  process.exit(0);
}

mkdirSync(DASHBOARD_DIR, { recursive: true });
runtimeLog(`starting pid=${process.pid} cwd=${process.cwd()} port=${PORT}`);

let managedProcess = null;
let catalogCache = null;
let cardEvidenceCache = null;
let cardEvidenceWarmScheduled = false;
let cardEvidenceWarming = false;
let dashboardAnalyticsCache = null;

if (process.argv.includes("--build-card-evidence-cache")) {
  buildDecisionCardEvidenceByOwnKey();
  process.exit(0);
}

if (process.argv.includes("--check-launch-contract")) {
  const deck = loopConfigFromBody({ trainingMode: "deck", deck: "carnerr-spear", ownKey: "eva-purple-spear-eva-13", seed: 1 });
  const matchup = loopConfigFromBody({ trainingMode: "matchup", deck: "carnerr-spear", ownKey: "eva-purple-spear-eva-13", seed: 2 });
  const baselines = baselineSuiteConfigFromBody({ seed: 3 });
  const autoRefine = autoRefineConfigFromBody({ seed: 4 });
  console.log(JSON.stringify({
    deck: { config: deck, args: loopArgs(deck) },
    matchup: { config: matchup, args: loopArgs(matchup) },
    baselines: { config: baselines, args: baselineSuiteArgs(baselines) },
    autoRefine: { config: autoRefine, args: autoRefineArgs(autoRefine) }
  }, null, 2));
  process.exit(0);
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/") {
      sendHtml(response, dashboardHtml());
      return;
    }
    if (request.method === "GET" && request.url === "/api/health") {
      sendJson(response, dashboardHealth());
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/api/state")) {
      const requestUrl = new URL(request.url, `http://${HOST}:${PORT}`);
      sendJson(response, dashboardState({ clientAnalyticsVersion: requestUrl.searchParams.get("analyticsVersion") }));
      return;
    }
    if (request.method === "GET" && request.url === "/api/log") {
      sendJson(response, { log: tailFile(LOG_PATH, 120) });
      return;
    }
    if (request.method === "POST" && request.url === "/api/log/clear") {
      sendJson(response, clearDashboardLog());
      return;
    }
    if (request.method === "POST" && request.url === "/api/baseline/delete") {
      const body = await readBody(request);
      sendJson(response, deleteBaseline(body));
      return;
    }
    if (request.method === "POST" && request.url === "/api/loop/start") {
      const body = await readBody(request);
      sendJson(response, startLoop(body));
      return;
    }
    if (request.method === "POST" && request.url === "/api/loop/stop") {
      sendJson(response, stopLoop());
      return;
    }
    if (request.method === "POST" && request.url === "/api/loop/force-stop") {
      sendJson(response, forceStopLocalAgentProcesses());
      return;
    }
    sendJson(response, { error: "Not found" }, 404);
  } catch (error) {
    sendJson(response, { error: error.message, stack: error.stack }, 500);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Pilot dashboard running at http://${HOST}:${PORT}`);
  runtimeLog(`listening pid=${process.pid} url=http://${HOST}:${PORT}`);
});

server.on("error", (error) => {
  runtimeLog(`server error ${error.stack || error.message || error}`);
  console.error(error);
});

server.on("close", () => {
  runtimeLog(`server close pid=${process.pid}`);
});

process.on("uncaughtException", (error) => {
  runtimeLog(`uncaughtException ${error.stack || error.message || error}`);
  console.error(error);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  runtimeLog(`unhandledRejection ${reason?.stack || reason?.message || reason}`);
  console.error(reason);
});

process.on("beforeExit", (code) => {
  runtimeLog(`beforeExit code=${code} pid=${process.pid}`);
});

process.on("exit", (code) => {
  runtimeLog(`exit code=${code} pid=${process.pid}`);
});

function dashboardHealth() {
  return {
    ok: true,
    cwd: process.cwd(),
    pid: process.pid,
    uptimeSeconds: Number(process.uptime().toFixed(1)),
    trainingResources: DEFAULT_TRAINING_RESOURCE_PLAN,
    controller: lightweightControllerState(),
    now: new Date().toISOString()
  };
}

function startLoop(body = {}) {
  const current = controllerState();
  if (current.running && current.pid && isProcessAlive(current.pid)) {
    return { ok: false, message: `Loop already running with PID ${current.pid}.`, state: current };
  }

  const config = body.baselineAll
    ? baselineSuiteConfigFromBody(body)
    : body.deckExperiment
      ? deckExperimentConfigFromBody(body)
      : body.autoRefine
        ? autoRefineConfigFromBody(body)
        : body.matchupSweep
          ? matchupSweepConfigFromBody(body)
          : loopConfigFromBody(body);
  const currentRunBaseline = currentRunBaselineForConfig(config);
  if (currentRunBaseline) config.currentRunBaseline = currentRunBaseline;
  const args = config.kind === "baseline-suite"
    ? baselineSuiteArgs(config)
    : config.kind === "deck-experiment"
      ? deckExperimentArgs(config)
      : config.kind === "auto-refiner"
        ? autoRefineArgs(config)
        : config.kind === "matchup-sweep"
          ? matchupSweepArgs(config)
          : loopArgs(config);
  appendFileSync(LOG_PATH, `\n=== Dashboard loop start ${new Date().toISOString()} ===\n`);
  appendFileSync(LOG_PATH, `node ${args.join(" ")}\n`);

  const logFd = openSync(LOG_PATH, "a");
  let child;
  try {
    child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd]
    });
  } finally {
    closeSync(logFd);
  }
  child.unref();
  managedProcess = child;

  const nextState = {
    running: true,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    signal: null,
    command: `node ${args.join(" ")}`,
    config,
    logPath: LOG_PATH,
    launcher: "detached-log-file"
  };
  writeControllerState(nextState);
  const prefs = advanceDashboardSeed(config.seed, {
    kind: config.kind ?? "loop",
    trainingMode: config.trainingMode ?? null,
    deck: config.deck ?? null,
    session: config.session ?? null
  });

  child.on("error", (error) => {
    appendFileSync(LOG_PATH, `\n=== Dashboard loop spawn error ${new Date().toISOString()} ===\n${error.stack || error.message || error}\n`);
    const previous = controllerState();
    writeControllerState({
      ...previous,
      running: false,
      endedAt: new Date().toISOString(),
      exitCode: 1,
      signal: "spawn-error",
      error: error.message
    });
    if (managedProcess === child) managedProcess = null;
  });

  child.on("exit", (code, signal) => {
    appendFileSync(LOG_PATH, `\n=== Dashboard loop exit ${new Date().toISOString()} code=${code} signal=${signal ?? ""} ===\n`);
    const previous = controllerState();
    const requestedStop = previous.signal === "dashboard-stop-requested"
      || previous.signal === "dashboard-stop";
    const autoRefineSummary = createAutoRefineSummaryForController(
      previous,
      requestedStop ? "dashboard-stop" : code === 0 ? "dashboard-exit" : "dashboard-exit-error"
    );
    writeControllerState({
      ...previous,
      running: false,
      endedAt: new Date().toISOString(),
      exitCode: code,
      signal: requestedStop ? "dashboard-stop" : signal,
      autoRefineSummary: autoRefineSummary ?? previous.autoRefineSummary ?? null
    });
    if (managedProcess?.pid === child.pid) managedProcess = null;
  });

  return { ok: true, message: `Started loop with PID ${child.pid}.`, state: nextState, nextSeed: prefs.nextSeed };
}

function stopLoop() {
  const current = controllerState();
  const pid = managedProcess?.pid ?? current.pid;
  if (!pid || !isProcessAlive(pid)) {
    const autoRefineSummary = createAutoRefineSummaryForController(current, "dashboard-stop-no-process");
    const stopped = {
      ...current,
      running: false,
      endedAt: current.endedAt ?? new Date().toISOString(),
      autoRefineSummary: autoRefineSummary ?? current.autoRefineSummary ?? null
    };
    writeControllerState(stopped);
    return {
      ok: false,
      message: autoRefineSummary
        ? "No dashboard-managed loop is running. Auto Refine summary was refreshed."
        : "No dashboard-managed loop is running.",
      state: stopped,
      autoRefineSummary
    };
  }

  writeControllerState({
    ...current,
    signal: "dashboard-stop-requested",
    stopRequestedAt: new Date().toISOString()
  });
  const stopResult = stopProcessTree(pid);
  const aliveAfterStop = isProcessAlive(pid);
  appendFileSync(LOG_PATH, `\n=== Dashboard loop stop ${new Date().toISOString()} pid=${pid} ok=${stopResult.ok} aliveAfter=${aliveAfterStop} ===\n${stopResult.stderr || stopResult.stdout || ""}\n`);
  const autoRefineSummary = createAutoRefineSummaryForController(current, "dashboard-stop");

  const stopping = {
    ...current,
    running: aliveAfterStop,
    endedAt: new Date().toISOString(),
    signal: stopResult.ok || !aliveAfterStop ? "dashboard-stop" : "dashboard-stop-failed",
    stopResult,
    autoRefineSummary: autoRefineSummary ?? current.autoRefineSummary ?? null
  };
  writeControllerState(stopping);
  return {
    ok: stopResult.ok || !aliveAfterStop,
    message: stopResult.ok || !aliveAfterStop
      ? `Stopped dashboard-managed loop process tree rooted at PID ${pid}.`
      : `Stop command failed for PID ${pid}. Use Force Stop Agent if child processes are still running.`,
    state: stopping,
    autoRefineSummary
  };
}

function autoRefineStatePathForController(state) {
  if (state?.config?.kind !== "auto-refiner") return null;
  const session = String(state.config.session ?? "").trim();
  if (!session) return null;
  const outRoot = String(state.config.outRoot ?? join(AGENT_ROOT, "auto-refiner", session));
  return join(outRoot, "auto-refiner-state.json");
}

function createAutoRefineSummaryForController(state, reason) {
  const statePath = autoRefineStatePathForController(state);
  if (!statePath) return null;
  const outDir = dirname(statePath);
  if (!existsSync(statePath)) {
    const missing = {
      ok: false,
      skipped: true,
      reason,
      statePath,
      markdownPath: join(outDir, "auto-refiner-summary.md"),
      jsonPath: join(outDir, "auto-refiner-summary.json"),
      message: "Auto Refine state file does not exist yet."
    };
    appendAutoRefineSummaryLog(missing);
    return missing;
  }

  const result = spawnSync(process.execPath, [
    "tools/pilot-auto-refiner-summary.mjs",
    "--state", statePath,
    "--reason", reason
  ], {
    cwd: process.cwd(),
    windowsHide: true,
    encoding: "utf8"
  });
  const summary = {
    ok: result.status === 0,
    skipped: false,
    reason,
    status: result.status,
    signal: result.signal ?? null,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? result.error?.message ?? "",
    statePath,
    markdownPath: join(outDir, "auto-refiner-summary.md"),
    jsonPath: join(outDir, "auto-refiner-summary.json")
  };
  appendAutoRefineSummaryLog(summary);
  return summary;
}

function appendAutoRefineSummaryLog(summary) {
  const detail = summary.skipped
    ? summary.message
    : summary.ok
      ? `Markdown: ${summary.markdownPath}\nJSON: ${summary.jsonPath}`
      : summary.stderr || summary.stdout || "summary command failed without output";
  appendFileSync(
    LOG_PATH,
    `\n=== Auto Refine summary ${new Date().toISOString()} reason=${summary.reason} ok=${summary.ok} skipped=${Boolean(summary.skipped)} ===\n${detail}\n`
  );
}

function stopProcessTree(pid) {
  if (process.platform === "win32") {
    const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      encoding: "utf8"
    });
    return {
      ok: result.status === 0,
      command: `taskkill.exe /PID ${pid} /T /F`,
      status: result.status,
      signal: result.signal ?? null,
      stdout: result.stdout?.trim() ?? "",
      stderr: result.stderr?.trim() ?? result.error?.message ?? ""
    };
  }

  try {
    process.kill(-Number(pid), "SIGTERM");
    return {
      ok: true,
      command: `kill -TERM -${pid}`,
      status: 0,
      signal: "SIGTERM",
      stdout: "",
      stderr: ""
    };
  } catch (groupError) {
    try {
      process.kill(Number(pid), "SIGTERM");
      return {
        ok: true,
        command: `kill -TERM ${pid}`,
        status: 0,
        signal: "SIGTERM",
        stdout: "",
        stderr: ""
      };
    } catch (pidError) {
      return {
        ok: false,
        command: `kill -TERM ${pid}`,
        status: null,
        signal: null,
        stdout: "",
        stderr: pidError.message || groupError.message
      };
    }
  }
}

function forceStopLocalAgentProcesses() {
  if (process.platform !== "win32") {
    return { ok: false, message: "Force Stop Agent is currently implemented for Windows only." };
  }

  const previous = controllerState();
  const nodePath = process.execPath.replace(/'/g, "''");
  const script = [
    `$exclude = ${process.pid}`,
    `$nodePath = '${nodePath}'`,
    "$targets = @(Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $exclude -and $_.Path -eq $nodePath })",
    "$rows = @($targets | Select-Object Id, StartTime, CPU, Path)",
    "$targets | Stop-Process -Force -ErrorAction SilentlyContinue",
    "$payload = [PSCustomObject]@{ stopped = $targets.Count; targets = $rows }",
    "$payload | ConvertTo-Json -Depth 5 -Compress"
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    windowsHide: true,
    encoding: "utf8"
  });
  const stdout = result.stdout?.trim() ?? "";
  const stderr = result.stderr?.trim() ?? result.error?.message ?? "";
  const parsed = readJsonFromString(stdout) ?? { stopped: 0, targets: [] };
  const ok = result.status === 0;
  appendFileSync(LOG_PATH, `\n=== Dashboard force stop ${new Date().toISOString()} ok=${ok} stopped=${parsed.stopped ?? 0} ===\n${stderr || stdout}\n`);
  const autoRefineSummary = createAutoRefineSummaryForController(previous, "dashboard-force-stop");
  const nextState = {
    ...previous,
    running: false,
    endedAt: new Date().toISOString(),
    signal: ok ? "dashboard-force-stop" : "dashboard-force-stop-failed",
    autoRefineSummary: autoRefineSummary ?? previous.autoRefineSummary ?? null,
    forceStopResult: {
      ok,
      status: result.status,
      stderr,
      ...parsed
    }
  };
  writeControllerState(nextState);
  return {
    ok,
    message: ok
      ? `Force stopped ${parsed.stopped ?? 0} local Node agent process(es).`
      : `Force stop failed: ${stderr || "unknown error"}`,
    state: nextState,
    autoRefineSummary
  };
}

function clearDashboardLog() {
  mkdirSync(DASHBOARD_DIR, { recursive: true });
  writeFileSync(LOG_PATH, `=== Dashboard log cleared ${new Date().toISOString()} ===\n`);
  return { ok: true, message: "Dashboard log cleared." };
}

function deleteBaseline(body = {}) {
  const current = controllerState();
  if (current.running && current.pid && isProcessAlive(current.pid)) {
    return { ok: false, message: "Stop the active loop before deleting a baseline." };
  }

  const deckId = text(body.deck, "");
  const requestedOwnKey = policyKeySegment(text(body.ownKey, ""));
  const decks = allSavedDecks().filter((deck) => dashboardDeckVisible(deck));
  const deck = decks.find((candidate) => candidate.id === deckId)
    ?? decks.find((candidate) => policyKeySegment(candidate.ownKey) === requestedOwnKey);
  if (!deck) {
    return { ok: false, message: "Select a pilot deck baseline to delete." };
  }

  const ownKey = policyKeySegment(deck.ownKey);
  if (ownKey === "unknown") {
    return { ok: false, message: "Selected deck does not have a set/color policy key." };
  }
  const includeLearning = body.includeLearning === true || normalizeToken(body.includeLearning) === "true";
  const includeGlobalLearning = includeLearning
    && (body.includeGlobalLearning === true || normalizeToken(body.includeGlobalLearning) === "true");
  const deleted = [];
  const missing = [];
  const errors = [];

  deleteFileIfExists(baselinePolicyPathForKey(ownKey, { policyDir: POLICY_DIR, baselineRoot: BASELINE_ROOT }), deleted, missing, errors, "baseline policy");
  deleteFileIfExists(baselineOriginPathForKey(ownKey, { policyDir: POLICY_DIR, baselineRoot: BASELINE_ROOT }), deleted, missing, errors, "baseline origin metadata");
  deleteFileIfExists(join(POLICY_DIR, `${ownKey}.json`), deleted, missing, errors, "legacy baseline policy");

  if (includeLearning) {
    for (const path of actionModelCandidatePathsForKey(ownKey, { agentRoot: AGENT_ROOT, baselineRoot: BASELINE_ROOT })) {
      deleteFileIfExists(path, deleted, missing, errors, path.includes(`${ownKey}.json`) ? "legacy profile action model" : "profile action model");
    }

    for (const file of matchupOverlayFilesForKey(ownKey, { policyDir: POLICY_DIR, baselineRoot: BASELINE_ROOT })) {
      deleteFileIfExists(file.path, deleted, missing, errors, `${file.layout} matchup overlay`);
    }

    if (includeGlobalLearning) {
      deleteFileIfExists(join(AGENT_ROOT, "current-action-model.json"), deleted, missing, errors, "global fallback action model");
    }
  }

  appendFileSync(
    LOG_PATH,
    `\n=== Dashboard baseline delete ${new Date().toISOString()} deck=${deck.id} ownKey=${ownKey} includeLearning=${includeLearning} includeGlobalLearning=${includeGlobalLearning} deleted=${deleted.length} errors=${errors.length} ===\n`
  );

  invalidateDashboardAnalyticsCache();
  return {
    ok: errors.length === 0,
    message: errors.length === 0
      ? `Deleted ${deleted.length} artifact(s) for ${deck.name || deck.id} (${ownKey}).`
      : `Deleted ${deleted.length} artifact(s), but ${errors.length} delete operation(s) failed.`,
    deckId: deck.id,
    ownKey,
    includeLearning,
    includeGlobalLearning,
    deleted,
    missing,
    errors
  };
}

function deleteFileIfExists(path, deleted, missing, errors, kind) {
  if (!existsSync(path)) {
    missing.push({ kind, path });
    return;
  }
  try {
    unlinkSync(path);
    deleted.push({ kind, path });
  } catch (error) {
    errors.push({ kind, path, message: error.message });
  }
}

function dashboardState({ clientAnalyticsVersion = null } = {}) {
  const controller = reconcileControllerState(controllerState());
  const analytics = dashboardAnalyticsState();
  const health = loopHealth(controller);
  const currentRunStatus = buildDashboardCurrentRunStatus({
    controller,
    loopHealth: health,
    profiles: analytics.data.deckProfiles ?? [],
    regionalArchetypes: analytics.data.regionalArchetypes ?? [],
    sweepState: currentRunSweepState(controller, health)
  });
  const live = {
    now: new Date().toISOString(),
    cwd: process.cwd(),
    controller,
    loopHealth: health,
    currentRunStatus,
    analyticsVersion: analytics.version,
    logTail: tailFile(LOG_PATH, 80)
  };
  if (clientAnalyticsVersion && clientAnalyticsVersion === analytics.version) {
    return { ...live, analyticsUnchanged: true };
  }
  return { ...live, analyticsUnchanged: false, ...analytics.data };
}

function dashboardAnalyticsState() {
  const now = Date.now();
  if (dashboardAnalyticsCache && now - dashboardAnalyticsCache.createdAt < DASHBOARD_ANALYTICS_CACHE_MS) {
    return dashboardAnalyticsCache;
  }
  const allDeckRows = allSavedDecks();
  const pilotDecks = allDeckRows.filter((deck) => dashboardDeckVisible(deck));
  const overlays = matchupOverlays();
  const runs = recentRuns(100);
  const deckExperiments = recentDeckExperiments(40, allDeckRows);
  const knowledgeUpdates = recentKnowledgeUpdates(10);
  const statsByOwnKey = matchupStatsByOwnKey(allDeckRows);
  const cardEvidenceByOwnKey = decisionCardEvidenceByOwnKey({ allowColdScan: false });
  const profiles = deckProfiles(pilotDecks, {
    overlays,
    runs,
    deckExperiments,
    statsByOwnKey,
    cardEvidenceByOwnKey
  });
  dashboardAnalyticsCache = {
    createdAt: now,
    version: `${now}`,
    data: {
    activeFiles: activeFiles(),
    decks: pilotDecks.map(dashboardDeckSummary),
    deckProfiles: profiles,
    deckRankings: buildOverallDeckRankings(profiles),
    regionalArchetypes: regionalArchetypes(allDeckRows),
    regionalDecks: regionalDeckOptions(allDeckRows),
    policies: policyState(),
    dashboardPrefs: dashboardPrefs(),
    runs,
    deckExperiments,
    knowledgeUpdates,
    matchupOverlays: overlays
    }
  };
  return dashboardAnalyticsCache;
}

function invalidateDashboardAnalyticsCache() {
  dashboardAnalyticsCache = null;
}

function currentRunBaselineForConfig(config = {}) {
  if (config.trainingMode !== "matchup" || !config.ownKey || !config.opponentKey) return null;
  const decks = allSavedDecks();
  const row = (matchupStatsByOwnKey(decks)[config.ownKey] ?? [])
    .find((candidate) => candidate.opponentKey === config.opponentKey) ?? null;
  const opponentDeck = decks.find((deck) => deck.ownKey === config.opponentKey && String(deck.id ?? "").startsWith("engine-"))
    ?? decks.find((deck) => deck.ownKey === config.opponentKey);
  return {
    capturedAt: new Date().toISOString(),
    ownKey: config.ownKey,
    opponentKey: config.opponentKey,
    opponentLabel: opponentDeck?.name ?? row?.opponentLabel ?? config.opponentKey,
    winRate: numberOrNull(row?.winRate),
    completedGames: row ? matchupCompletedGames(row) : 0,
    recordedGames: Number(row?.games ?? 0)
  };
}

function currentRunSweepState(controller, health) {
  const kind = controller?.config?.kind ?? null;
  const session = String(controller?.config?.session ?? "").trim();
  if (!session) return null;

  if (kind === "matchup-sweep") {
    return readJsonIfExists(join(AGENT_ROOT, "matchup-sweeps", session, "matchup-sweep-state.json"));
  }
  if (kind !== "auto-refiner") return null;

  const current = health?.currentCycle ?? null;
  if (!current || current.taskType !== "matchup-sweep") return null;
  let outRoot = current.outRoot ?? null;
  if (!outRoot && current.trainingJob && current.stage && current.deckId) {
    const autoRefinerStatePath = autoRefineStatePathForController(controller);
    if (autoRefinerStatePath) {
      const label = `job-${String(current.trainingJob).padStart(3, "0")}-${routePolicyKeySegment(current.deckId)}-matchups`;
      outRoot = join(dirname(autoRefinerStatePath), current.stage, label);
    }
  }
  return outRoot ? readJsonIfExists(join(outRoot, "matchup-sweep-state.json")) : null;
}

function dashboardDeckSummary(deck) {
  const { deckShape, archetypeResolution, ...summary } = deck;
  return summary;
}

function loopConfigFromBody(body) {
  const seed = integer(body.seed, 15001);
  const trainingMode = normalizeTrainingMode(body.trainingMode ?? "deck");
  const defaults = sharedDashboardTrainingDefaults(trainingMode);
  const resourcePlan = dashboardTrainingResourcePlan(body);
  const exploration = explorationConfigFromBody(body, defaults);
  const deck = text(body.deck, "carnerr-spear");
  const deckRow = allSavedDecks().find((candidate) => candidate.id === deck);
  const ownKey = deckRow?.ownKey || text(body.ownKey, "eva-purple");
  const matchupFilters = trainingMode === "matchup"
    ? matchupFiltersFromBody(body)
    : { opponentKey: "", opponentSet: "", opponentColor: "" };
  return {
    trainingMode,
    trainingFocus: text(body.trainingFocus, defaults.trainingFocus),
    deck,
    ownKey,
    seed,
    session: text(body.session, `${policyKeySegment(deck)}-${trainingMode}-${seed}`),
    cycles: integer(body.cycles, 3),
    parallelRuns: resourcePlan.parallelRuns,
    parallelConcurrency: resourcePlan.parallelConcurrency,
    resourcePlan,
    games: integer(body.games, defaults.games),
    generations: integer(body.generations, defaults.generations),
    population: integer(body.population, defaults.population),
    mlStrength: decimal(body.mlStrength, defaults.mlStrength),
    finalGames: integer(body.finalGames, 20),
    parallelFinalGames: integer(body.parallelFinalGames, defaults.parallelFinalGames),
    parallelFinalTopPercent: integer(body.parallelFinalTopPercent, defaults.parallelFinalTopPercent),
    parallelFinalCandidates: text(body.parallelFinalCandidates, defaults.parallelFinalCandidates),
    parallelOpponentCountPerRun: integer(body.parallelOpponentCountPerRun, defaults.parallelOpponentCountPerRun),
    opponentMode: "random",
    opponentCount: integer(body.opponentCount, 20),
    opponents: "",
    opponentDeck: "",
    opponentKey: trainingMode === "matchup" ? matchupFilters.opponentKey : "",
    opponentSet: trainingMode === "matchup" ? matchupFilters.opponentSet : "",
    opponentColor: trainingMode === "matchup" ? matchupFilters.opponentColor : "",
    opponentTop: trainingMode === "matchup" ? text(body.opponentTop, "") : "",
    regions: trainingMode === "matchup" ? text(body.regions, "") : "",
    decisionLogMode: text(body.decisionLogMode, "learning"),
    knowledgeMode: text(body.knowledgeMode, defaults.knowledgeMode),
    knowledgeInputs: text(body.knowledgeInputs, ""),
    ...exploration,
    progressMinutes: integer(body.progressMinutes, 2),
    bootstrapBaselineIfMissing: trainingMode !== "deck"
  };
}

function matchupFiltersFromBody(body) {
  const opponentKey = text(body.matchupKey ?? body.opponentKey, "");
  let opponentSet = text(body.opponentSet, "");
  let opponentColor = text(body.opponentColor, "");

  if ((!opponentSet || !opponentColor) && opponentKey) {
    const matchingDeck = allSavedDecks().find((deck) => deck.isRegional && deck.ownKey === opponentKey);
    if (matchingDeck) {
      opponentSet ||= matchingDeck.sourceCode ?? "";
      opponentColor ||= matchingDeck.colors?.[0] ?? "";
    }
  }

  if ((!opponentSet || !opponentColor) && opponentKey.includes("-")) {
    const [source, ...colorParts] = opponentKey.split("-");
    opponentSet ||= source.toUpperCase();
    opponentColor ||= colorParts.join("-");
  }

  return {
    opponentKey,
    opponentSet,
    opponentColor
  };
}

function baselineSuiteConfigFromBody(body) {
  const seed = integer(body.seed, 17001);
  const resourcePlan = dashboardTrainingResourcePlan(body, { suite: true });
  const defaults = {
    games: 8,
    generations: 2,
    population: 4,
    finalGames: 8,
    parallelFinalTopPercent: 35,
    ...sharedExplorationDefaults("deck")
  };
  const exploration = explorationConfigFromBody(body, defaults);
  return {
    kind: "baseline-suite",
    seed,
    session: text(body.session, `missing-baselines-${seed}`),
    parallelRuns: resourcePlan.parallelRuns,
    parallelConcurrency: resourcePlan.parallelConcurrency,
    suiteConcurrency: resourcePlan.suiteConcurrency,
    resourcePlan,
    games: Math.max(8, integer(body.games, defaults.games)),
    generations: integer(body.generations, defaults.generations),
    population: integer(body.population, defaults.population),
    finalGames: integer(body.finalGames, defaults.finalGames),
    opponentCount: Math.max(84, integer(body.opponentCount, 84)),
    parallelOpponentCountPerRun: Math.max(6, integer(body.parallelOpponentCountPerRun, 6)),
    parallelFinalGames: 0,
    parallelFinalTopPercent: integer(body.parallelFinalTopPercent, defaults.parallelFinalTopPercent),
    parallelFinalCandidates: "best-baseline",
    decisionLogMode: text(body.decisionLogMode, "learning"),
    ...exploration,
    progressMinutes: integer(body.progressMinutes, 2)
  };
}

function deckExperimentConfigFromBody(body) {
  const seed = integer(body.seed, 18001);
  const deck = text(body.deck, "carnerr-spear");
  const matchupFilters = matchupFiltersFromBody(body);
  const focused = Boolean(matchupFilters.opponentSet || matchupFilters.opponentColor);
  const session = text(body.session, `${policyKeySegment(deck)}-deck-experiment-${seed}`);
  return {
    kind: "deck-experiment",
    deck,
    seed,
    session,
    outDir: join(DECK_EXPERIMENT_ROOT, session),
    opponentMode: "random",
    opponents: "",
    opponentKey: focused ? matchupFilters.opponentKey : "",
    opponentSet: focused ? matchupFilters.opponentSet : "",
    opponentColor: focused ? matchupFilters.opponentColor : "",
    opponentCount: integer(body.opponentCount, 8),
    games: Math.max(4, integer(body.games, 12)),
    generations: Math.max(1, integer(body.generations, 2)),
    population: Math.max(4, integer(body.population, 8)),
    mutationSwaps: Math.max(1, integer(body.mutationSwaps, 2)),
    progressMinutes: integer(body.progressMinutes, 2)
  };
}

function matchupSweepConfigFromBody(body) {
  const seed = integer(body.seed, 19001);
  const defaults = sharedDashboardTrainingDefaults("matchup");
  const resourcePlan = dashboardTrainingResourcePlan(body);
  const exploration = explorationConfigFromBody(body, defaults);
  const deck = text(body.deck, "carnerr-spear");
  const deckRow = allSavedDecks().find((candidate) => candidate.id === deck);
  const session = text(body.session, `${policyKeySegment(deck)}-matchup-sweep-${seed}`);
  return {
    kind: "matchup-sweep",
    deck,
    ownKey: deckRow?.ownKey ?? text(body.ownKey, ""),
    seed,
    session,
    limit: Math.max(1, integer(body.cycles, 3)),
    targetGames: Math.max(20, integer(body.targetMatchupGames, 60)),
    parallelRuns: resourcePlan.parallelRuns,
    parallelConcurrency: resourcePlan.parallelConcurrency,
    resourcePlan,
    games: Math.max(4, integer(body.games, 8)),
    generations: Math.max(1, integer(body.generations, 1)),
    population: Math.max(4, integer(body.population, 4)),
    parallelOpponentCountPerRun: 1,
    parallelFinalGames: 0,
    decisionLogMode: text(body.decisionLogMode, "learning"),
    knowledgeMode: "full",
    ...exploration,
    progressMinutes: integer(body.progressMinutes, 2)
  };
}

function autoRefineConfigFromBody(body) {
  const seed = integer(body.seed, 20001);
  const defaults = sharedDashboardTrainingDefaults("matchup");
  const resourcePlan = dashboardTrainingResourcePlan(body, { suite: true });
  const exploration = explorationConfigFromBody(body, defaults);
  const deckOrder = text(body.deckOrder, "");
  const session = text(body.session, `auto-refine-${seed}`);
  return {
    kind: "auto-refiner",
    seed,
    session,
    deckOrder,
    startDeck: text(body.startDeck, "carnerr-spear"),
    maxJobs: Math.max(1, integer(body.autoMaxJobs, 48)),
    targetGames: Math.max(20, integer(body.targetMatchupGames, 60)),
    matchupLimit: Math.max(1, integer(body.matchupLimit, 1)),
    deckAdvanceMode: text(body.deckAdvanceMode, "complete"),
    baselineRefreshMode: text(body.baselineRefreshMode, "missing-and-round-robin"),
    missingBaselineBatchSize: Math.max(1, integer(body.missingBaselineBatchSize, resourcePlan.parallelRuns)),
    baselineRefreshBatchSize: Math.max(1, integer(body.baselineRefreshBatchSize, 2)),
    priorityShape: text(body.priorityShape, ""),
    parallelRuns: resourcePlan.parallelRuns,
    parallelConcurrency: resourcePlan.parallelConcurrency,
    baselineSuiteConcurrency: resourcePlan.suiteConcurrency,
    actionModelSuiteConcurrency: resourcePlan.suiteConcurrency,
    resourcePlan,
    progressMinutes: integer(body.progressMinutes, 2),
    maxRetries: Math.max(0, integer(body.maxRetries, 1)),
    plateauPasses: Math.max(1, integer(body.plateauPasses, 1)),
    ...exploration,
    stages: text(body.stages, "light,deep,long")
  };
}

function dashboardTrainingResourcePlan(_body, { suite = false } = {}) {
  const requestedSuiteConcurrency = suite ? BASELINE_SUITE_CONCURRENCY_DEFAULT : 1;
  return trainingResourcePlan({
    logicalProcessors: TRAINING_LOGICAL_PROCESSORS,
    workerBudget: TRAINING_WORKER_BUDGET,
    parallelRuns: TRAINING_WORKER_BUDGET,
    parallelConcurrency: TRAINING_WORKER_BUDGET,
    suiteConcurrency: requestedSuiteConcurrency
  });
}

function loopArgs(config) {
  const defaults = sharedDashboardTrainingDefaults(config.trainingMode);
  const args = [
    "tools/pilot-loop-overseer.mjs",
    "--training-mode", config.trainingMode,
    "--deck", config.deck,
    "--own-key", config.ownKey,
    "--seed", String(config.seed),
    "--session", config.session,
    "--cycles", String(config.cycles),
    "--opponent-mode", config.opponentMode,
    "--opponent-count", String(config.opponentCount),
    "--training-focus", config.trainingFocus,
    "--ml-strength", String(config.mlStrength),
    "--parallel-runs", String(config.parallelRuns),
    "--parallel-concurrency", String(config.parallelConcurrency),
    "--parallel-opponent-count-per-run", String(config.parallelOpponentCountPerRun),
    "--games", String(config.games),
    "--generations", String(config.generations),
    "--population", String(config.population),
    "--final-games", String(config.finalGames),
    "--parallel-final-games", String(config.parallelFinalGames),
    "--parallel-final-top-percent", String(config.parallelFinalTopPercent),
    "--parallel-final-candidates", config.parallelFinalCandidates,
    "--decision-log-mode", config.decisionLogMode,
    "--knowledge-mode", config.knowledgeMode,
    "--progress-minutes", String(config.progressMinutes)
  ];
  pushValueIfChanged(args, "--agent-root", AGENT_ROOT, "work/private/pilot-agent");
  pushValueIfChanged(args, "--policy-dir", POLICY_DIR, "work/private/pilot-agent/policies");
  pushValueIfChanged(args, "--baseline-root", BASELINE_ROOT, "work/private/pilot-agent/baselines");
  pushValueIfChanged(args, "--runs-root", RUNS_ROOT, "work/private/pilot-agent/runs");
  appendExplorationArgs(args, config, defaults, { force: true });
  if (config.opponentSet) args.push("--opponent-set", config.opponentSet);
  if (config.opponentColor) args.push("--opponent-color", config.opponentColor);
  if (config.opponentTop) args.push("--opponent-top", config.opponentTop);
  if (config.regions) args.push("--regions", config.regions);
  if (config.opponents) args.push("--opponents", config.opponents);
  if (config.knowledgeInputs) args.push("--knowledge-inputs", config.knowledgeInputs);
  if (config.bootstrapBaselineIfMissing) args.push("--bootstrap-baseline-if-missing");
  return args;
}

function baselineSuiteArgs(config) {
  const args = [
    "tools/pilot-baseline-suite.mjs",
    "--deck-prefix", DASHBOARD_DECK_PREFIX,
    "--missing-only",
    "--seed", String(config.seed),
    "--session", config.session,
    "--out-root", join(AGENT_ROOT, "loops", config.session),
    "--agent-root", AGENT_ROOT,
    "--policy-dir", POLICY_DIR,
    "--baseline-root", BASELINE_ROOT,
    "--runs-root", RUNS_ROOT,
    "--suite-concurrency", String(config.suiteConcurrency),
    "--opponent-count", String(config.opponentCount)
  ];
  pushValueIfChanged(args, "--parallel-runs", String(config.parallelRuns), "14");
  pushValueIfChanged(args, "--parallel-concurrency", String(config.parallelConcurrency), "14");
  pushValueIfChanged(args, "--parallel-opponent-count-per-run", String(config.parallelOpponentCountPerRun), "6");
  pushValueIfChanged(args, "--games", String(config.games), "8");
  pushValueIfChanged(args, "--generations", String(config.generations), "2");
  pushValueIfChanged(args, "--population", String(config.population), "4");
  pushValueIfChanged(args, "--final-games", String(config.finalGames), "8");
  pushValueIfChanged(args, "--parallel-final-games", String(config.parallelFinalGames), "0");
  pushValueIfChanged(args, "--parallel-final-candidates", config.parallelFinalCandidates, "best-baseline");
  pushValueIfChanged(args, "--decision-log-mode", config.decisionLogMode, "learning");
  appendExplorationArgs(args, config, sharedExplorationDefaults("deck"));
  pushValueIfChanged(args, "--progress-minutes", String(config.progressMinutes), "2");
  return args;
}

function appendExplorationArgs(args, config, defaults, { force = false } = {}) {
  const value = (key) => config[key] ?? defaults[key];
  const push = (flag, key) => {
    const resolved = String(value(key));
    if (force) args.push(flag, resolved);
    else pushValueIfChanged(args, flag, resolved, String(defaults[key]));
  };
  push("--exploration-mode", "explorationMode");
  push("--exploration-rate", "explorationRate");
  push("--exploration-max-per-game", "explorationMaxPerGame");
  push("--exploration-score-window", "explorationScoreWindow");
  push("--exploration-max-rank", "explorationMaxRank");
  push("--exploration-min-score", "explorationMinScore");
  push("--raid-normal-play-exploration-rate", "raidNormalPlayExplorationRate");
  push("--raid-normal-play-score-window", "raidNormalPlayScoreWindow");
  push("--raid-normal-play-heuristic-window", "raidNormalPlayHeuristicWindow");
  push("--raid-normal-play-min-heuristic-score", "raidNormalPlayMinHeuristicScore");
  push("--counterfactual-exploration-rate", "counterfactualExplorationRate");
  push("--counterfactual-max-per-game", "counterfactualMaxPerGame");
  push("--counterfactual-rollout-actions", "counterfactualRolloutActions");
  push("--counterfactual-rollout-player-turns", "counterfactualRolloutPlayerTurns");
}

function pushValueIfChanged(args, flag, value, defaultValue) {
  if (String(value ?? "") === String(defaultValue ?? "")) return;
  args.push(flag, String(value));
}

function deckExperimentArgs(config) {
  const args = [
    "tools/deck-agent.mjs",
    "optimize",
    "--base", config.deck,
    "--seed", String(config.seed),
    "--out-dir", config.outDir,
    "--opponent-mode", config.opponentMode,
    "--opponent-count", String(config.opponentCount),
    "--games", String(config.games),
    "--generations", String(config.generations),
    "--population", String(config.population),
    "--mutation-swaps", String(config.mutationSwaps),
    "--pilot-mulligan",
    "--pilot-policy", "auto",
    "--opponent-pilot-policy", "auto"
  ];
  if (config.opponentSet) args.push("--opponent-set", config.opponentSet);
  if (config.opponentColor) args.push("--opponent-color", config.opponentColor);
  if (config.opponents) args.push("--opponents", config.opponents);
  return args;
}

function matchupSweepArgs(config) {
  const args = [
    "tools/pilot-matchup-sweep.mjs",
    "--deck", config.deck,
    "--agent-root", AGENT_ROOT,
    "--policy-dir", POLICY_DIR,
    "--baseline-root", BASELINE_ROOT,
    "--runs-root", RUNS_ROOT,
    "--seed", String(config.seed),
    "--session", config.session,
    "--limit", String(config.limit),
    "--target-games", String(config.targetGames),
    "--parallel-runs", String(config.parallelRuns),
    "--parallel-concurrency", String(config.parallelConcurrency),
    "--parallel-opponent-count-per-run", String(config.parallelOpponentCountPerRun),
    "--games", String(config.games),
    "--generations", String(config.generations),
    "--population", String(config.population),
    "--parallel-final-games", String(config.parallelFinalGames),
    "--decision-log-mode", config.decisionLogMode,
    "--knowledge-mode", config.knowledgeMode,
    "--progress-minutes", String(config.progressMinutes)
  ];
  appendExplorationArgs(args, config, sharedExplorationDefaults("matchup"));
  return args;
}

function autoRefineArgs(config) {
  const args = [
    "tools/pilot-auto-refiner.mjs",
    "--seed", String(config.seed),
    "--session", config.session,
    "--baseline-suite-concurrency", String(config.baselineSuiteConcurrency),
    "--action-model-suite-concurrency", String(config.actionModelSuiteConcurrency)
  ];
  pushValueIfChanged(args, "--agent-root", AGENT_ROOT, "work/private/pilot-agent");
  pushValueIfChanged(args, "--policy-dir", POLICY_DIR, "work/private/pilot-agent/policies");
  pushValueIfChanged(args, "--baseline-root", BASELINE_ROOT, "work/private/pilot-agent/baselines");
  pushValueIfChanged(args, "--runs-root", RUNS_ROOT, "work/private/pilot-agent/runs");
  if (config.deckOrder) args.push("--deck-order", config.deckOrder);
  pushValueIfChanged(args, "--start-deck", config.startDeck, "carnerr-spear");
  pushValueIfChanged(args, "--max-jobs", String(config.maxJobs), "48");
  pushValueIfChanged(args, "--target-games", String(config.targetGames), "60");
  pushValueIfChanged(args, "--matchup-limit", String(config.matchupLimit), "1");
  pushValueIfChanged(args, "--deck-advance-mode", config.deckAdvanceMode, "complete");
  pushValueIfChanged(args, "--baseline-refresh-mode", config.baselineRefreshMode, "missing-and-round-robin");
  pushValueIfChanged(args, "--missing-baseline-batch-size", String(config.missingBaselineBatchSize), String(config.parallelRuns));
  pushValueIfChanged(args, "--baseline-refresh-batch-size", String(config.baselineRefreshBatchSize), "2");
  pushValueIfChanged(args, "--parallel-runs", String(config.parallelRuns), "14");
  pushValueIfChanged(args, "--parallel-concurrency", String(config.parallelConcurrency), String(config.parallelRuns));
  pushValueIfChanged(args, "--max-retries", String(config.maxRetries), "1");
  pushValueIfChanged(args, "--plateau-passes", String(config.plateauPasses), "1");
  pushValueIfChanged(args, "--stages", config.stages, "light,deep,long");
  pushValueIfChanged(args, "--progress-minutes", String(config.progressMinutes), "2");
  if (config.priorityShape) args.push("--priority-shape", config.priorityShape);
  appendExplorationArgs(args, config, sharedExplorationDefaults("matchup"));
  return args;
}

function activeFiles() {
  return {
    currentPolicy: fileInfo(join(AGENT_ROOT, "current-best-policy.json")),
    actionModel: fileInfo(join(AGENT_ROOT, "current-action-model.json")),
    baselines: fileInfo(BASELINE_ROOT),
    legacyPolicies: fileInfo(POLICY_DIR),
    legacyProfileActionModels: fileInfo(join(AGENT_ROOT, "action-models")),
    routedEvaPurple: fileInfo(baselinePolicyPathForKey("eva-purple", { policyDir: POLICY_DIR, baselineRoot: BASELINE_ROOT }))
      ?? fileInfo(join(POLICY_DIR, "eva-purple.json")),
    deckExperiments: fileInfo(DECK_EXPERIMENT_ROOT),
    deckLibrary: fileInfo(DECK_LIBRARY),
    cardCatalog: fileInfo(CATALOG_PATH),
    dashboardLog: fileInfo(LOG_PATH)
  };
}

function savedDecks() {
  return allSavedDecks().filter((deck) => dashboardDeckVisible(deck));
}

function allSavedDecks() {
  if (!existsSync(DECK_LIBRARY)) return [];
  return readdirSync(DECK_LIBRARY, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => deckOptionFromFile(join(DECK_LIBRARY, entry.name), entry.name))
    .filter(Boolean)
    .sort(compareDeckOptions);
}

function dashboardDeckVisible(deck) {
  const prefixes = dashboardDeckPrefixes();
  if (prefixes.length === 0) return true;
  const id = String(deck.id ?? "").toLowerCase();
  const name = String(deck.name ?? "").toLowerCase();
  return prefixes.some((prefix) => id.startsWith(prefix)
    || name.startsWith(prefix.replace(/-$/u, " ")));
}

function dashboardDeckPrefixes() {
  return String(DASHBOARD_DECK_PREFIX ?? "")
    .split(",")
    .map((prefix) => prefix.trim().toLowerCase())
    .filter(Boolean);
}

function deckOptionFromFile(path, fileName) {
  const raw = readJsonIfExists(path);
  if (!raw || !Array.isArray(raw.cards)) return null;
  const id = raw.id ?? fileName.replace(/\.json$/u, "");
  const name = raw.name ?? id;
  const archetypeResolution = resolveArchetypeProfile({
    deck: raw.cards,
    savedDeck: raw,
    deckId: id,
    catalog: catalogCards(),
    deckLibrary: DECK_LIBRARY,
    deckPrefixes: dashboardDeckPrefixes()
  });
  const profile = archetypeResolution.profile;
  const colors = profile.colors ?? [];
  const sourceCode = profile.sourceCode ?? raw.validation?.sourceCode ?? raw.summary?.sourceCode ?? raw.summary?.sourceCodes?.[0] ?? null;
  const ownKey = profile.key;
  const source = raw.source ?? {};
  const archetype = source.archetype ?? archetypeNameFromPolicyKey(profile.key, profile.setColorKey) ?? null;
  const labelParts = [
    name,
    sourceCode && colors.length > 0 ? `${sourceCode} ${colors.join("/")}` : null,
    source.location ? source.location : null
  ].filter(Boolean);
  return {
    id,
    name,
    path,
    ownKey,
    label: labelParts.join(" - "),
    sourceCode,
    colors,
    archetype,
    setColorKey: profile.setColorKey,
    archetypeResolution: profile.archetypeResolution,
    deckShape: deckShape(raw, catalogCards()),
    isRegional: id.startsWith("regional-") || Boolean(source.location || source.manifestPath),
    location: source.location ?? null,
    player: source.player ?? null,
    placement: Number.isFinite(Number(source.placement)) ? Number(source.placement) : null,
    updatedAt: safeStat(path)?.mtime?.toISOString() ?? null
  };
}

function deckShape(raw, catalog) {
  const cards = Array.isArray(raw.cards) ? raw.cards : [];
  const summary = raw.summary ?? {};
  const size = Number(summary.size ?? cards.reduce((total, card) => total + Number(card.count ?? 0), 0));
  const entries = cards
    .map((card) => cardShapeEntry(card, catalog))
    .sort(compareCardShapeEntries);
  const coreCards = entries
    .filter((card) => Number(card.count ?? 0) >= 4)
    .sort(compareCardShapeEntries);
  const flexCards = entries
    .filter((card) => Number(card.count ?? 0) > 0 && Number(card.count ?? 0) <= 2)
    .sort(compareCardShapeEntries);
  const singletonCards = entries
    .filter((card) => Number(card.count ?? 0) === 1)
    .sort(compareCardShapeEntries);
  const triggerCounts = summary.triggerCounts ?? countCopies(entries, (card) => card.triggerType ?? "none");
  const openingRequiredEnergy = (card) => Number.isFinite(card.openingRequiredEnergy) ? card.openingRequiredEnergy : card.requiredEnergy;
  const openers = entries.filter((card) => card.type === "character" && Number(openingRequiredEnergy(card)) === 0);
  const naturalZeroCostUnits = entries.filter((card) => card.type === "character" && Number(card.requiredEnergy) === 0);
  const reducedOpeners = entries.filter((card) => card.type === "character" && card.reducedOnEmptyField && Number(card.openingRequiredEnergy) === 0);
  const lowCostUnits = entries.filter((card) => card.type === "character" && Number(openingRequiredEnergy(card)) <= 1);
  const highCostCards = entries.filter((card) => Number(card.requiredEnergy) >= 4);
  const raidCards = entries.filter((card) => card.raidNames.length > 0 || card.triggerType === "raid");
  const searchCards = entries.filter((card) => card.effectKinds.includes("searchTopDeck"));
  const drawCards = entries.filter((card) => card.effectKinds.includes("draw") || card.triggerType === "draw");
  const abilityCards = entries.filter((card) => card.abilityTimings.length > 0);
  const topBpCards = entries
    .filter((card) => Number.isFinite(card.bp))
    .sort((a, b) => Number(b.bp) - Number(a.bp) || compareCardShapeEntries(a, b))
    .slice(0, 8);
  return {
    size,
    uniqueCards: Number(summary.uniqueCardNumbers ?? cards.length),
    colors: summary.colors ?? (summary.color ? [summary.color] : []),
    cards: entries,
    triggerCounts,
    typeCounts: countCopies(entries, (card) => card.type ?? "unknown"),
    curveCounts: countCopies(entries, (card) => Number.isFinite(card.requiredEnergy) ? String(card.requiredEnergy) : "unknown"),
    openingCurveCounts: countCopies(entries, (card) => Number.isFinite(openingRequiredEnergy(card)) ? String(openingRequiredEnergy(card)) : "unknown"),
    catalogMissing: entries.filter((card) => !card.catalogFound).length,
    openers,
    naturalZeroCostUnits,
    reducedOpeners,
    lowCostUnits,
    highCostCards,
    raidCards,
    searchCards,
    drawCards,
    abilityCards,
    topBpCards,
    coreCards,
    flexCards,
    singletonCards
  };
}

function cardShapeEntry(card, catalog) {
  const catalogCard = catalogCardForDeckCard(card, catalog);
  const requiredEnergy = finiteNumber(catalogCard?.requiredEnergy?.amount);
  const emptyFieldReduction = emptyFieldRequiredEnergyReduction(catalogCard);
  const openingRequiredEnergy = Number.isFinite(requiredEnergy)
    ? Math.max(0, requiredEnergy - emptyFieldReduction)
    : null;
  const keywords = Object.entries(catalogCard?.keywords ?? {})
    .map(([keyword, value]) => value === true ? keyword : `${keyword} ${value}`)
    .sort((a, b) => a.localeCompare(b));
  const abilityTimings = [...new Set((catalogCard?.abilities ?? []).map((ability) => ability.timing).filter(Boolean))];
  const effectKinds = [...collectEffectKinds(catalogCard)].sort((a, b) => a.localeCompare(b));
  return {
    id: card.id ?? null,
    number: card.number ?? card.id ?? "",
    name: card.name ?? card.id ?? "",
    count: Number(card.count ?? 0),
    catalogFound: Boolean(catalogCard),
    sourceCode: catalogCard?.sourceCode ?? null,
    color: catalogCard?.color ?? null,
    type: catalogCard?.type ?? null,
    requiredEnergy,
    openingRequiredEnergy,
    reducedOnEmptyField: emptyFieldReduction > 0,
    emptyFieldReduction,
    apCost: finiteNumber(catalogCard?.apCost),
    bp: finiteNumber(catalogCard?.bp),
    triggerType: catalogCard?.trigger?.type ?? "none",
    keywords,
    abilityTimings,
    effectKinds,
    raidNames: Array.isArray(catalogCard?.raid?.names) ? catalogCard.raid.names : [],
    rarity: catalogCard?.rarity ?? null
  };
}

function compareCardShapeEntries(a, b) {
  return Number(b.count ?? 0) - Number(a.count ?? 0)
    || String(a.number ?? "").localeCompare(String(b.number ?? ""));
}

function catalogCards() {
  if (catalogCache) return catalogCache;
  const catalog = readJsonIfExists(CATALOG_PATH);
  const rows = Array.isArray(catalog?.cards)
    ? catalog.cards
    : Object.values(catalog?.cards ?? {});
  const byKey = new Map();
  for (const card of rows) {
    for (const value of [card.id, card.number, card.cardNumber, card.code]) {
      const key = normalizeToken(value);
      if (key && !byKey.has(key)) byKey.set(key, card);
    }
  }
  catalogCache = {
    path: CATALOG_PATH,
    rows,
    byKey
  };
  return catalogCache;
}

function catalogCardForDeckCard(card, catalog) {
  if (!catalog?.byKey) return null;
  for (const value of [card.id, card.number, card.cardNumber, card.code]) {
    const key = normalizeToken(value);
    if (key && catalog.byKey.has(key)) return catalog.byKey.get(key);
  }
  return null;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function emptyFieldRequiredEnergyReduction(card) {
  const modifiers = [
    ...(Array.isArray(card?.useCostModifiers) ? card.useCostModifiers : []),
    ...(Array.isArray(card?.staticUseCostModifiers) ? card.staticUseCostModifiers : [])
  ];
  return modifiers
    .filter((modifier) => modifier.kind === "requiredEnergy"
      && modifier.sourceZone === "hand"
      && modifier.condition?.emptyField)
    .reduce((best, modifier) => Math.max(best, Number(modifier.amount ?? 0)), 0);
}

function collectEffectKinds(card) {
  const kinds = new Set();
  for (const ability of card?.abilities ?? []) collectEffectKindsFromValue(ability.effect, kinds);
  collectEffectKindsFromValue(card?.trigger?.effect, kinds);
  return kinds;
}

function collectEffectKindsFromValue(value, kinds) {
  if (!value || typeof value !== "object") return;
  if (typeof value.kind === "string") kinds.add(value.kind);
  if (Array.isArray(value)) {
    for (const item of value) collectEffectKindsFromValue(item, kinds);
    return;
  }
  for (const child of Object.values(value)) collectEffectKindsFromValue(child, kinds);
}

function countCopies(entries, keyFn) {
  const counts = new Map();
  for (const entry of entries) {
    const key = String(keyFn(entry) ?? "unknown");
    counts.set(key, (counts.get(key) ?? 0) + Number(entry.count ?? 0));
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => naturalKeySort(a[0], b[0])));
}

function naturalKeySort(a, b) {
  const aNumber = Number(a);
  const bNumber = Number(b);
  if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) return aNumber - bNumber;
  return String(a).localeCompare(String(b));
}

function compareDeckOptions(a, b) {
  return Number(a.isRegional) - Number(b.isRegional)
    || a.name.localeCompare(b.name)
    || a.id.localeCompare(b.id);
}

function policyState() {
  const currentPath = join(AGENT_ROOT, "current-best-policy.json");
  const actionPath = join(AGENT_ROOT, "current-action-model.json");
  const current = readJsonIfExists(currentPath);
  const action = readJsonIfExists(actionPath);
  return {
    current: current ? {
      path: currentPath,
      name: current.name ?? null,
      weights: Object.keys(current.weights ?? {}).length,
      hash: fileHash(currentPath)
    } : null,
    actionModel: action ? {
      path: actionPath,
      name: action.name ?? null,
      examples: Number(action.examples ?? 0),
      features: Object.keys(action.weights ?? {}).length,
      trainedAt: action.trainedAt ?? null
    } : null,
    actionModels: actionModels()
  };
}

function actionModels() {
  const rows = [];
  const seen = new Set();
  const organizedDeckRoot = join(BASELINE_ROOT, "decks");
  if (existsSync(organizedDeckRoot)) {
    for (const entry of readdirSync(organizedDeckRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const ownKey = entry.name;
      const path = actionModelPathForKey(ownKey, { agentRoot: AGENT_ROOT, baselineRoot: BASELINE_ROOT });
      const row = actionModelRow({ ownKey, path, layout: "organized" });
      if (!row) continue;
      rows.push(row);
      seen.add(ownKey);
    }
  }

  const legacyDir = join(AGENT_ROOT, "action-models");
  if (existsSync(legacyDir)) {
    for (const entry of readdirSync(legacyDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const ownKey = entry.name.replace(/\.json$/u, "");
      if (seen.has(ownKey)) continue;
      const row = actionModelRow({ ownKey, path: join(legacyDir, entry.name), layout: "legacy" });
      if (row) rows.push(row);
    }
  }

  return rows.sort((a, b) => a.ownKey.localeCompare(b.ownKey));
}

function actionModelRow({ ownKey, path, layout }) {
  const model = readJsonIfExists(path);
  if (!model) return null;
  const stats = safeStat(path);
  const runtimeReadiness = modelRuntimeReadiness(model);
  return {
    ownKey,
    path,
    layout,
    name: model?.name ?? null,
    learningMode: model?.learningMode ?? null,
    sourceRows: Number(model?.sourceRows ?? 0),
    examples: Number(model?.examples ?? 0),
    selectedExamples: Number(model?.selectedExamples ?? 0),
    pairwiseExamples: Number(model?.pairwiseExamples ?? 0),
    effectiveExamples: Number(model?.exampleWeightTotal ?? model?.examples ?? 0),
    learningSignalVersion: Number(model?.learningSignalVersion ?? 1),
    learningSignalTrust: Number(model?.learningSignalVersion ?? 1) >= 2 ? Number(model?.learningSignalTrust ?? 1) : 0.25,
    runtimeReadiness,
    features: Object.keys(model?.weights ?? {}).length,
    trainedAt: model?.trainedAt ?? null,
    updatedAt: stats?.mtime?.toISOString() ?? null
  };
}

function deckProfiles(decks, { overlays, runs, deckExperiments, statsByOwnKey, cardEvidenceByOwnKey }) {
  return decks.map((deck) => {
    const policyPath = baselinePolicyPathForKey(deck.ownKey, { policyDir: POLICY_DIR, baselineRoot: BASELINE_ROOT });
    const originPath = baselineOriginPathForKey(deck.ownKey, { policyDir: POLICY_DIR, baselineRoot: BASELINE_ROOT });
    const legacyPolicyPath = join(POLICY_DIR, `${deck.ownKey}.json`);
    const modelPath = profileActionModelPath(deck.ownKey);
    const legacyModelPath = actionModelPathForKey(deck.ownKey, { agentRoot: AGENT_ROOT, legacy: true });
    const deckOverlays = overlays.filter((overlay) => overlay.ownKey === deck.ownKey);
    const activeDeckOverlays = deckOverlays.filter((overlay) => !overlay.candidate);
    const candidateDeckOverlays = deckOverlays.filter((overlay) => overlay.candidate);
    const deckRuns = runs.filter((run) => run.ownKey === deck.ownKey || run.deckId === deck.id);
    const experiments = (deckExperiments ?? []).filter((experiment) => experiment.baseDeckId === deck.id);
    const latestRun = deckRuns.find((run) => run.complete && run.result) ?? null;
    const matchupStats = statsByOwnKey[deck.ownKey] ?? [];
    const cardEvidence = currentDeckCardEvidence(deck, cardEvidenceByOwnKey?.[deck.ownKey]);
    const baselinePolicy = policyFileSummaryFromCandidates([
      { path: policyPath, layout: "organized" },
      { path: legacyPolicyPath, layout: "legacy" }
    ]);
    attachBaselineOrigin(baselinePolicy, originPath);
    const actionModel = modelFileSummaryFromCandidates([
      { path: modelPath, source: "profile", layout: "organized" },
      { path: legacyModelPath, source: "profile", layout: "legacy" },
      { path: join(AGENT_ROOT, "current-action-model.json"), source: "fallback", layout: "legacy", fallbackFor: modelPath }
    ]);
    return {
      ...deck,
      baselinePolicy,
      actionModel,
      overlayCount: activeDeckOverlays.length,
      matchupCandidateCount: candidateDeckOverlays.length,
      validatedOverlayCount: activeDeckOverlays.filter((overlay) => Number(overlay.runtimeTrust ?? 0) > 0).length,
      quarantinedOverlayCount: activeDeckOverlays.filter((overlay) => Number(overlay.runtimeTrust ?? 0) === 0).length,
      overlayExamples: activeDeckOverlays.reduce((total, overlay) => total + Number(overlay.examples ?? 0), 0),
      latestRun,
      matchupStats,
      cardEvidence,
      deckExperiments: experiments,
      latestDeckExperiment: experiments[0] ?? null,
      advice: deckAdvice({
        deck,
        baselinePolicy,
        actionModel,
        overlays: deckOverlays,
        latestRun,
        matchupStats,
        deckRuns,
        deckExperiments: experiments,
        cardEvidence
      })
    };
  });
}

function deckAdvice({ deck, baselinePolicy, actionModel, overlays, latestRun, matchupStats, deckRuns, deckExperiments, cardEvidence }) {
  const priorities = [];
  const strengths = [];
  const concerns = [];
  const nextActions = [];
  const deckNotes = [];
  const cardNotes = [];
  const editNotes = [];
  const cardPackageNotes = [];
  const cardEvidenceNotes = [];
  const learningNotes = [];
  const performanceNotes = [];
  const deckExperimentNotes = [];
  const archetypeResolution = deck.archetypeResolution ?? null;
  const badMatchups = matchupStats
    .filter((row) => matchupCompletedGames(row) >= 5 && row.winRate < 0.45)
    .slice(0, 5);
  const strongMatchups = matchupStats
    .filter((row) => matchupCompletedGames(row) >= 5 && row.winRate >= 0.6)
    .sort((a, b) => Number(b.winRate) - Number(a.winRate) || matchupCompletedGames(b) - matchupCompletedGames(a))
    .slice(0, 3);
  const editReadiness = deckEditReadiness({
    baselinePolicy,
    actionModel,
    matchupStats,
    badMatchups,
    strongMatchups,
    deckRuns
  });
  editNotes.push(...editReadiness.notes);
  if (editReadiness.status === "not-ready") {
    concerns.push("Deck-edit advice is not ready yet; the dashboard will prioritize more evidence first.");
    if (editReadiness.nextAction) nextActions.push(editReadiness.nextAction);
  } else {
    strengths.push(`Deck-edit readiness: ${editReadiness.label}.`);
  }

  if (archetypeResolution?.status === "matched") {
    const nearest = archetypeResolution.nearest;
    strengths.push(`Decklist routes to ${deck.ownKey} by archetype match${Number.isFinite(Number(archetypeResolution.distance)) ? ` (${Number(archetypeResolution.distance).toFixed(0)} slot(s) from ${nearest?.name ?? nearest?.id ?? "nearest representative"})` : ""}.`);
  } else if (archetypeResolution?.status === "exact") {
    strengths.push(`Deck has an explicit archetype policy key: ${deck.ownKey}.`);
  } else if (archetypeResolution?.status === "ambiguous") {
    priorities.push("Decklist matches multiple archetype representatives equally.");
    concerns.push("Set an explicit source.policyKey before training so learning does not land in the wrong baseline.");
    nextActions.push("Choose the intended archetype and save it as source.policyKey on the deck file.");
  } else if (archetypeResolution?.status === "new-archetype-needed") {
    priorities.push("Decklist is 10+ slots away from known archetype representatives.");
    concerns.push("This likely needs a new Engine archetype baseline before matchup training.");
    nextActions.push("Create or tag an Engine archetype representative for this list family, then train its baseline.");
  }

  if (!baselinePolicy.exists) {
    priorities.push("Baseline policy is missing for this deck.");
    nextActions.push("Run All Baselines or Deck Training before trusting matchup advice.");
  } else if (baselinePolicy.needsTraining) {
    priorities.push("Baseline policy is only a bootstrap seed for this deck.");
    concerns.push("This profile has a starting policy file, but it has not yet proven an improvement over its fallback.");
    nextActions.push("Run Deck Training for this profile before trusting matchup or deck-edit advice.");
  } else {
    strengths.push("Baseline policy exists for this deck profile.");
  }

  if (!actionModel.exists) {
    priorities.push("No action model is available yet.");
    nextActions.push("Run deck training with decision logs so the knowledge updater can create a profile action model.");
  } else if (actionModel.source === "fallback") {
    concerns.push(`Using the global action model until ${deck.ownKey} has its own profile model.`);
    nextActions.push("Run one knowledge-producing deck or matchup cycle to create the profile action model.");
  } else {
    strengths.push(`Profile action model has ${formatCount(actionModel.examples)} examples across ${formatCount(actionModel.features)} features.`);
    if (actionModel.runtimeReadiness?.ready) {
      strengths.push("Profile action model is runtime-ready for pilot decisions.");
    } else if (actionModel.runtimeReadiness?.blockers?.length > 0) {
      concerns.push(`Profile action model is still collecting evidence: ${actionModel.runtimeReadiness.blockers[0]}.`);
      nextActions.push("Keep deck training or matchup training running until the action model reaches runtime readiness.");
    }
  }
  const modelLearningHealth = actionModel.learningHealth ?? null;
  if (modelLearningHealth) {
    const healthStatus = String(modelLearningHealth.status ?? "unknown").toLowerCase();
    const firstBlocker = modelLearningHealth.blockers?.[0];
    const firstWarning = modelLearningHealth.warnings?.[0];
    if (healthStatus === "blocked") {
      concerns.push(`Pilot learning is quarantined: ${firstBlocker ?? "the latest evidence failed a learning-safety gate"}.`);
      nextActions.push("Resolve the blocked learning-health finding before increasing ML steering strength.");
    } else if (healthStatus === "watch" && firstWarning) {
      learningNotes.push(`Learning health is on watch: ${firstWarning}`);
    } else if (healthStatus === "healthy") {
      strengths.push("The latest pilot learning-health audit passed without blockers or warnings.");
    }
    const sampling = modelLearningHealth.sampling ?? {};
    const explorationAttempts = Number(sampling.explorationAttempts ?? 0);
    if (explorationAttempts > 0) {
      learningNotes.push(
        `Exploration produced ${Number(sampling.explorationActionable ?? 0)}/${explorationAttempts} directional comparison(s) across ${Number(sampling.explorationUniqueContextualFeatures ?? 0)} contextual feature(s), including ${Number(sampling.explorationCoverageGaps ?? 0)} coverage-gap probe(s).`
      );
    }
    const adaptiveCounterfactuals = Number(sampling.adaptiveCounterfactuals ?? 0);
    if (adaptiveCounterfactuals > 0) {
      const audits = Number(sampling.adaptiveAudits ?? 0);
      const disagreements = Number(sampling.adaptiveAuditDisagreements ?? 0);
      learningNotes.push(
        `Adaptive counterfactual depth stopped ${Number(sampling.adaptiveEarlyStops ?? 0)}/${adaptiveCounterfactuals} comparison(s) early, saved about ${Number(sampling.counterfactualEstimatedPlayerTurnsSaved ?? 0)} player-turn(s), and recorded ${audits} full-horizon audit(s) with ${disagreements} disagreement(s).`
      );
    }
  }
  const modelValidation = actionModel.validation ?? actionModel.learning?.validation ?? null;
  if (modelValidation) {
    const heldoutGames = Number(modelValidation.heldoutPlayerGames ?? 0);
    const anchorPositiveExamples = Number(modelValidation.anchorPositiveExamples ?? 0);
    const anchorNegativeExamples = Number(modelValidation.anchorNegativeExamples ?? 0);
    const pairwiseAccuracy = modelValidation.pairwiseSignAccuracy === null || modelValidation.pairwiseSignAccuracy === undefined
      ? null
      : Number(modelValidation.pairwiseSignAccuracy);
    if (heldoutGames < 8) {
      learningNotes.push(`ML validation is provisional: ${heldoutGames}/8 independent held-out player-games.`);
      nextActions.push("Collect more decision-logged games before increasing ML steering strength.");
    }
    if (heldoutGames >= 8 && (anchorPositiveExamples < 3 || anchorNegativeExamples < 3) && pairwiseAccuracy === null) {
      concerns.push(`ML validation is one-sided (${anchorPositiveExamples} positive / ${anchorNegativeExamples} negative anchors), so raw accuracy is not evidence of generalization.`);
      nextActions.push("Collect both wins and losses before treating the action model as reliable.");
    }
    if (pairwiseAccuracy !== null && Number.isFinite(pairwiseAccuracy)) {
      learningNotes.push(`Held-out pairwise direction accuracy is ${formatPercent(pairwiseAccuracy)}.`);
      if (heldoutGames >= 8 && pairwiseAccuracy < 0.55) concerns.push("The action model is not generalizing reliably on held-out action comparisons.");
      if (heldoutGames >= 8 && pairwiseAccuracy >= 0.65) strengths.push("The action model generalizes well on held-out action comparisons.");
    }
    const inputConsistency = modelValidation.inputConsistency ?? null;
    if (inputConsistency?.unsafe) {
      concerns.push(`Held-out repeated inputs contain ${formatPercent(inputConsistency.conflictRate)} irreconcilable label weight, so runtime ML is quarantined.`);
      nextActions.push("Review counterfactual evidence for repeated states before trusting this action model.");
    } else if (inputConsistency?.gateEligible) {
      learningNotes.push(
        `Held-out repeated-input consistency is ${formatPercent(1 - Number(inputConsistency.conflictRate ?? 0))}; the evidence-imposed accuracy ceiling is ${formatPercent(inputConsistency.maximumAttainableRepeatedAccuracy ?? 1)}.`
      );
    } else if (Number(inputConsistency?.repeatedExamples ?? 0) > 0) {
      learningNotes.push(
        `Input-consistency diagnostics are collecting repeats (${Number(inputConsistency.repeatedExamples)}/${MIN_ML_RUNTIME_VALIDATION_CONSISTENCY_REPEATED_EXAMPLES} examples).`
      );
    }
  }
  for (const theme of actionModel.learning?.themes ?? []) learningNotes.push(theme);
  const strongestGroup = actionModel.learning?.groups?.[0];
  if (strongestGroup?.strongest) {
    learningNotes.push(`Most pronounced learning area is ${strongestGroup.group}, led by ${humanizeFeature(strongestGroup.strongest.feature)} (${Number(strongestGroup.strongest.weight).toFixed(0)}).`);
  }

  if (matchupStats.length === 0) {
    priorities.push("No matchup stats have been recorded for this deck yet.");
    nextActions.push("After the baseline is credible, run Matchup Training into one regional archetype at a time.");
  } else {
    strengths.push(`${matchupStats.length} matchup bucket(s) have data.`);
    const totalGames = matchupStats.reduce((total, row) => total + matchupCompletedGames(row), 0);
    const totalRecorded = matchupStats.reduce((total, row) => total + Number(row.games ?? 0), 0);
    const totalWins = matchupStats.reduce((total, row) => total + Number(row.wins ?? 0), 0);
    const totalLosses = matchupStats.reduce((total, row) => total + Number(row.losses ?? 0), 0);
    const totalIncomplete = matchupStats.reduce((total, row) => total + Number(row.incomplete ?? 0), 0);
    const totalKnown = Math.max(1, totalWins + totalLosses);
    const weightedTurnCycles = matchupStats.reduce((total, row) => total + Number(row.avgTurnCycles ?? 0) * matchupCompletedGames(row), 0) / Math.max(1, totalGames);
    performanceNotes.push(`Recorded matchup sample: ${totalWins}/${totalLosses}/${totalIncomplete} over ${totalRecorded} games (${formatPercent(totalWins / totalKnown)} completed-game win rate).`);
    performanceNotes.push(`Average turn cycle across ${totalGames} completed matchup games is ${weightedTurnCycles.toFixed(2)}.`);
  }

  if (badMatchups.length > 0) {
    concerns.push(`Weakest known matchup is ${badMatchups[0].opponentLabel} at ${formatPercent(badMatchups[0].winRate)} over ${matchupCompletedGames(badMatchups[0])} completed games.`);
    performanceNotes.push(`Bad-matchup watchlist: ${badMatchups.slice(0, 3).map((row) => `${row.opponentLabel} ${formatPercent(row.winRate)}`).join(", ")}.`);
    nextActions.push(`Focus the next matchup cycle on ${badMatchups[0].opponentLabel}.`);
  }
  if (strongMatchups.length > 0) {
    strengths.push(`Best known matchup is ${strongMatchups[0].opponentLabel} at ${formatPercent(strongMatchups[0].winRate)}.`);
    performanceNotes.push(`Strong-matchup evidence: ${strongMatchups.slice(0, 3).map((row) => `${row.opponentLabel} ${formatPercent(row.winRate)}`).join(", ")}.`);
  }

  if (latestRun?.result) {
    const result = latestRun.result;
    if (Number(result.winRate) < 0.45) concerns.push(`Latest completed run is below break-even at ${formatPercent(result.winRate)}.`);
    else if (Number(result.winRate) >= 0.55) strengths.push(`Latest completed run is positive at ${formatPercent(result.winRate)}.`);
    performanceNotes.push(`Latest run: ${result.wins}/${result.losses}/${result.incomplete}, ${formatPercent(result.winRate)} win rate.`);
    if (Number(latestRun.avgTurnCycles ?? 0) > 8) concerns.push(`Latest games are running long at ${Number(latestRun.avgTurnCycles).toFixed(2)} turn cycles.`);
  }

  const latestExperiment = deckExperiments?.[0];
  if (latestExperiment) {
    const result = latestExperiment.result;
    const delta = latestExperiment.baseComparison?.winRateDelta;
    if (Number.isFinite(Number(delta))) {
      const deltaText = `${Number(delta) >= 0 ? "+" : ""}${(Number(delta) * 100).toFixed(1)} pts`;
      deckExperimentNotes.push(`Latest deck experiment changed final win rate by ${deltaText}.`);
      if (Number(delta) > 0) strengths.push(`Latest deck experiment improved over the original list by ${deltaText}.`);
      if (Number(delta) < 0) concerns.push(`Latest deck experiment underperformed the original list by ${deltaText}.`);
    } else if (result) {
      deckExperimentNotes.push(`Latest deck experiment finished ${result.wins}/${result.losses}/${result.incomplete} at ${formatPercent(result.winRate)}.`);
    }
    if (latestExperiment.cardChanges?.length > 0) {
      deckExperimentNotes.push(`Candidate changes: ${latestExperiment.cardChanges.slice(0, 6).map(formatCardChange).join(", ")}.`);
      deckExperimentNotes.push("Deck experiment candidates are legality-checked before testing; counts are shown as candidate change with original -> candidate copies.");
    }
    if (latestExperiment.analysis?.recommendations?.length > 0) {
      deckExperimentNotes.push(latestExperiment.analysis.recommendations[0]);
    }
  } else if (editReadiness.status !== "not-ready") {
    deckExperimentNotes.push("No deck experiments have been run yet; start with a focused weak matchup and small mutation swaps.");
  }

  const shape = deck.deckShape ?? {};
  const construction = deckConstructionNotes(shape);
  deckNotes.push(...construction.deckNotes);
  cardNotes.push(...construction.cardNotes);
  cardPackageNotes.push(...construction.cardPackageNotes);
  cardEvidenceNotes.push(...deckCardEvidenceNotes(cardEvidence));
  if (Number(shape.size) === 50) strengths.push("Deck is saved as a 50-card list.");
  else concerns.push(`Deck size is ${shape.size || "unknown"}; verify legality before testing.`);
  if (Number(shape.uniqueCards) > 22) deckNotes.push("High unique-card count may indicate a flexible toolbox, but can reduce consistency.");
  else if (Number(shape.uniqueCards) > 0 && Number(shape.uniqueCards) <= 18) deckNotes.push("Compact unique-card count suggests a focused core.");

  const triggers = shape.triggerCounts ?? {};
  const specialTriggers = Number(triggers.special ?? 0);
  const finalTriggers = Number(triggers.final ?? 0);
  const colorTriggers = Number(triggers.color ?? 0);
  if (specialTriggers > 0) deckNotes.push(`${specialTriggers} special trigger card(s) in the list.`);
  if (finalTriggers > 0) deckNotes.push(`${finalTriggers} final trigger card(s) in the list.`);
  if (colorTriggers > 0) deckNotes.push(`${colorTriggers} color trigger card(s) in the list.`);

  const coreCards = shape.coreCards ?? [];
  const flexCards = shape.flexCards ?? [];
  if (coreCards.length > 0) cardNotes.push(`Core 4-of cards: ${coreCards.slice(0, 6).map(formatCardName).join(", ")}${coreCards.length > 6 ? "..." : ""}.`);
  if (flexCards.length > 0) cardNotes.push(`Flex/singleton candidates to watch: ${flexCards.slice(0, 8).map(formatCardName).join(", ")}${flexCards.length > 8 ? "..." : ""}.`);
  const validatedOverlays = overlays.filter((overlay) => Number(overlay.runtimeTrust ?? 0) > 0);
  const quarantinedOverlays = overlays.filter((overlay) => Number(overlay.runtimeTrust ?? 0) === 0);
  if (validatedOverlays.length > 0) strengths.push(`${validatedOverlays.length} positively validated matchup overlay(s) are active for this deck.`);
  const evidencePendingOverlays = quarantinedOverlays.filter((overlay) => ![
    "unvalidated",
    "low-impact-validation",
    "stale-impact-validation"
  ].includes(overlay.readinessStatus));
  const validationPendingOverlays = quarantinedOverlays.filter((overlay) => [
    "unvalidated",
    "low-impact-validation",
    "stale-impact-validation"
  ].includes(overlay.readinessStatus));
  if (evidencePendingOverlays.length > 0) concerns.push(`${evidencePendingOverlays.length} matchup overlay(s) need more causal weight or decision breadth before they can affect play.`);
  if (validationPendingOverlays.length > 0) concerns.push(`${validationPendingOverlays.length} causally ready matchup overlay(s) are quarantined pending positive paired validation.`);

  if (nextActions.length === 0) {
    nextActions.push(badMatchups.length > 0
      ? `Continue focused matchup training into ${badMatchups[0].opponentLabel}.`
      : "Keep collecting matchup data; deck-edit advice becomes more reliable after repeated archetype runs.");
  }

  return {
    health: adviceHealth({ baselinePolicy, actionModel, matchupStats, badMatchups, latestRun }),
    priorities,
    strengths: uniqueStrings(strengths).slice(0, 6),
    concerns: uniqueStrings(concerns).slice(0, 6),
    nextActions: uniqueStrings(nextActions).slice(0, 5),
    badMatchups,
    strongMatchups,
    learningNotes: uniqueStrings(learningNotes).slice(0, 8),
    performanceNotes: uniqueStrings(performanceNotes).slice(0, 8),
    deckExperimentNotes: uniqueStrings(deckExperimentNotes).slice(0, 8),
    learningWeights: {
      positive: actionModel.learning?.positive ?? [],
      negative: actionModel.learning?.negative ?? [],
      groups: actionModel.learning?.groups ?? []
    },
    editReadiness,
    editNotes: uniqueStrings(editNotes).slice(0, 6),
    deckNotes: uniqueStrings(deckNotes).slice(0, 6),
    cardNotes: uniqueStrings(cardNotes).slice(0, 4),
    cardPackageNotes: uniqueStrings(cardPackageNotes).slice(0, 6),
    cardEvidenceNotes: uniqueStrings(cardEvidenceNotes).slice(0, 6),
    evidence: {
      completedRuns: deckRuns.filter((run) => run.complete).length,
      deckExperiments: deckExperiments?.length ?? 0,
      matchupBuckets: matchupStats.length,
      overlayCount: overlays.length,
      validatedOverlayCount: validatedOverlays.length,
      quarantinedOverlayCount: quarantinedOverlays.length,
      cardEvidenceRows: Number(cardEvidence?.chosenRows ?? 0),
      cardEvidenceCards: Number(cardEvidence?.cards?.length ?? 0),
      baselineReady: baselinePolicy.exists,
      actionModelReady: actionModelIsTrusted(actionModel),
      actionModelExists: actionModel.exists,
      actionModelSource: actionModel.source ?? null
    }
  };
}

function adviceHealth({ baselinePolicy, actionModel, matchupStats, badMatchups, latestRun }) {
  let score = 0;
  if (baselinePolicy.exists) score += baselinePolicy.needsTraining ? 12 : 30;
  if (actionModel.exists) {
    const modelPoints = actionModel.source === "profile" ? 25 : 12;
    score += Math.round(modelPoints * (actionModelIsTrusted(actionModel) ? 1 : 0.35));
  }
  score += Math.min(25, matchupStats.length * 3);
  if (latestRun?.result?.winRate >= 0.5) score += 10;
  score -= Math.min(20, badMatchups.length * 5);
  if (score >= 70) return "healthy";
  if (score >= 40) return "developing";
  return "needs-data";
}

function deckEditReadiness({ baselinePolicy, actionModel, matchupStats, badMatchups, strongMatchups, deckRuns }) {
  const totalGames = matchupStats.reduce((total, row) => total + matchupCompletedGames(row), 0);
  const confidentMatchups = matchupStats.filter((row) => matchupCompletedGames(row) >= 50);
  const blockers = [];
  if (!baselinePolicy.exists) blockers.push("baseline policy missing");
  else if (baselinePolicy.needsTraining) blockers.push("baseline policy is only a bootstrap seed");
  if (!actionModel.exists || actionModel.source !== "profile") blockers.push("profile action model missing");
  else if (!actionModelIsTrusted(actionModel)) blockers.push("profile action model is still provisional");
  if (totalGames < 200) blockers.push(`only ${totalGames} matchup games recorded`);
  if (confidentMatchups.length < 2) blockers.push("fewer than 2 matchup buckets have 50+ games");

  if (blockers.length > 0) {
    return {
      status: "not-ready",
      label: "Needs More Evidence",
      totalGames,
      confidentMatchups: confidentMatchups.length,
      notes: [
        `Not ready for deck edits: ${blockers.join(", ")}.`,
        "Use this stage to build baseline play skill and matchup evidence before changing cards."
      ],
      nextAction: !baselinePolicy.exists
        ? "Run Deck Training or All Baselines before deck-edit testing."
        : baselinePolicy.needsTraining
          ? "Run Deck Training until the bootstrap seed becomes a trained baseline."
        : "Run focused Matchup Training until at least two archetypes have 50+ recorded games."
    };
  }

  const weakLabel = badMatchups[0]?.opponentLabel ?? null;
  const strongLabel = strongMatchups[0]?.opponentLabel ?? null;
  const notes = [
    `${totalGames} matchup games and ${confidentMatchups.length} confident matchup bucket(s) are available.`,
    weakLabel
      ? `Ready for targeted tests against ${weakLabel}; try small 1-3 card experiments and compare the same matchup.`
      : "Ready for validation tests; no clearly weak matchup is proven by current data."
  ];
  if (strongLabel) notes.push(`Protect the current strength into ${strongLabel} while testing changes.`);
  return {
    status: weakLabel ? "targeted-tests" : "validation-ready",
    label: weakLabel ? "Targeted Tests Ready" : "Validation Ready",
    totalGames,
    confidentMatchups: confidentMatchups.length,
    completedRuns: deckRuns.filter((run) => run.complete).length,
    notes,
    nextAction: weakLabel
      ? `Run matchup-only tests after any list change into ${weakLabel}.`
      : "Collect one more focused matchup cycle before making broad card swaps."
  };
}

function actionModelIsTrusted(actionModel) {
  if (!actionModel?.exists || actionModel.source !== "profile") return false;
  return actionModel.runtimeReadiness?.ready === true
    || actionModel.learning?.runtimeReadiness?.ready === true;
}

function deckConstructionNotes(shape) {
  const deckNotes = [];
  const cardNotes = [];
  const cardPackageNotes = [];
  if (!shape || Object.keys(shape).length === 0) return { deckNotes, cardNotes, cardPackageNotes };

  if (Number(shape.catalogMissing ?? 0) > 0) {
    deckNotes.push(`${shape.catalogMissing} card slot(s) could not be matched to catalog metadata.`);
  }

  const openerCopies = sumCopies(shape.openers);
  const naturalZeroCopies = sumCopies(shape.naturalZeroCostUnits);
  const reducedOpenerCopies = sumCopies(shape.reducedOpeners);
  if (openerCopies > 0) {
    deckNotes.push(`Opening access: ${openerCopies} opener copies (${naturalZeroCopies} natural 0-cost, ${reducedOpenerCopies} empty-field reducer).`);
  }
  if (openerCopies > 0 && openerCopies < 8) {
    deckNotes.push("Opening access looks thin; mulligan and brick data should be watched closely.");
  } else if (openerCopies >= 12) {
    deckNotes.push("Opening access looks healthy on raw counts.");
  }

  if (shape.openingCurveCounts) {
    deckNotes.push(`Opening-adjusted curve: ${formatCopyCountMap(shape.openingCurveCounts, ["0", "1", "2", "3", "4", "5", "6", "7", "unknown"])}.`);
  } else if (shape.curveCounts) {
    deckNotes.push(`Required-energy curve: ${formatCopyCountMap(shape.curveCounts, ["0", "1", "2", "3", "4", "5", "6", "7", "unknown"])}.`);
  }

  if (shape.typeCounts) cardPackageNotes.push(`Card types: ${formatCopyCountMap(shape.typeCounts, ["character", "event", "site", "unknown"])}.`);
  if (shape.triggerCounts) cardPackageNotes.push(`Trigger package: ${formatCopyCountMap(shape.triggerCounts, ["draw", "active", "color", "raid", "special", "final", "get", "none"])}.`);

  const raidCopies = sumCopies(shape.raidCards);
  if (raidCopies > 0) {
    cardPackageNotes.push(`Raid package: ${raidCopies} copies, led by ${formatCardList(shape.raidCards, 4)}.`);
  }
  const searchCopies = sumCopies(shape.searchCards);
  if (searchCopies > 0) cardPackageNotes.push(`Search effects appear on ${searchCopies} copy/copies: ${formatCardList(shape.searchCards, 4)}.`);
  const drawCopies = sumCopies(shape.drawCards);
  if (drawCopies > 0) cardPackageNotes.push(`Draw access appears on ${drawCopies} copy/copies: ${formatCardList(shape.drawCards, 4)}.`);

  const lowCostCopies = sumCopies(shape.lowCostUnits);
  const highCostCopies = sumCopies(shape.highCostCards);
  if (lowCostCopies > 0 || highCostCopies > 0) {
    cardNotes.push(`Low-cost unit copies: ${lowCostCopies}; 4+ energy card copies: ${highCostCopies}.`);
  }
  if (shape.topBpCards?.length > 0) {
    cardNotes.push(`Largest BP bodies: ${formatCardList(shape.topBpCards, 4)}.`);
  }
  if (shape.reducedOpeners?.length > 0) {
    cardNotes.push(`Field-empty reducers counted as openers: ${formatCardList(shape.reducedOpeners, 4)}.`);
  }

  return { deckNotes, cardNotes, cardPackageNotes };
}

function sumCopies(cards) {
  return (cards ?? []).reduce((total, card) => total + Number(card.count ?? 0), 0);
}

function formatCopyCountMap(counts, preferredOrder = []) {
  const entries = [];
  for (const key of preferredOrder) {
    if (counts[key] !== undefined) entries.push([key, counts[key]]);
  }
  for (const [key, value] of Object.entries(counts)) {
    if (!preferredOrder.includes(key)) entries.push([key, value]);
  }
  return entries
    .filter(([, value]) => Number(value) > 0)
    .map(([key, value]) => `${key} ${value}`)
    .join(", ") || "none";
}

function formatCardList(cards, limit) {
  const rows = [...(cards ?? [])]
    .sort(compareCardShapeEntries)
    .slice(0, limit)
    .map(formatCardName);
  if ((cards ?? []).length > limit) rows.push(`+${cards.length - limit} more`);
  return rows.join(", ") || "none";
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function formatCardName(card) {
  const count = Number(card.count ?? 0);
  const number = card.number || card.id || "";
  const name = card.name || number;
  return `${count}x ${name}`;
}

function formatCardChange(change) {
  const delta = Number(change.delta ?? 0);
  const sign = delta > 0 ? "+" : "";
  const before = Number(change.before ?? 0);
  const after = Number(change.after ?? 0);
  const copyText = Number.isFinite(before) && Number.isFinite(after) ? ` (${before} -> ${after})` : "";
  return `${sign}${delta} ${change.name || change.number || change.id}${copyText}`;
}

function formatCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString() : "0";
}

function formatPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${(number * 100).toFixed(1)}%` : "-";
}

function signedNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return `${number >= 0 ? "+" : ""}${number.toFixed(2)}`;
}

function regionalArchetypes(decks) {
  const rows = [...groupBy(decks.filter((deck) => deck.isRegional && deck.ownKey), (deck) => deck.ownKey).entries()]
    .map(([ownKey, group]) => {
      const first = group[0];
      return {
        key: ownKey,
        label: archetypeLabel(first),
        sourceCode: first.sourceCode ?? null,
        colors: first.colors ?? [],
        count: group.length,
        deckIds: group.map((deck) => deck.id).sort((a, b) => a.localeCompare(b)),
        topPlacements: group
          .map((deck) => deck.placement)
          .filter((placement) => Number.isFinite(Number(placement)))
          .sort((a, b) => Number(a) - Number(b))
          .slice(0, 5),
        locations: [...new Set(group.map((deck) => deck.location).filter(Boolean))]
          .sort((a, b) => a.localeCompare(b))
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
  return rows;
}

function regionalDeckOptions(decks) {
  return decks
    .filter((deck) => deck.isRegional && deck.ownKey)
    .map((deck) => ({
      id: deck.id,
      name: deck.name,
      label: regionalDeckLabel(deck),
      archetypeLabel: archetypeLabel(deck),
      ownKey: deck.ownKey,
      sourceCode: deck.sourceCode ?? null,
      colors: deck.colors ?? [],
      archetype: deck.archetype ?? null,
      location: deck.location ?? null,
      player: deck.player ?? null,
      placement: deck.placement ?? null,
      path: deck.path,
      updatedAt: deck.updatedAt ?? null
    }))
    .sort((a, b) => a.archetypeLabel.localeCompare(b.archetypeLabel)
      || Number(a.placement ?? 999) - Number(b.placement ?? 999)
      || a.label.localeCompare(b.label)
      || a.id.localeCompare(b.id));
}

function regionalDeckLabel(deck) {
  const placement = Number.isFinite(Number(deck.placement)) ? `#${deck.placement}` : null;
  return [
    archetypeLabel(deck),
    deck.player || deck.name || deck.id,
    placement,
    deck.location
  ].filter(Boolean).join(" - ");
}

function matchupStatsByOwnKey(decks) {
  const deckById = new Map(decks.map((deck) => [deck.id, deck]));
  const buckets = new Map();
  const seenGames = new Set();
  for (const entry of reportEntries(RUNS_ROOT)) {
    const report = entry.report;
    if (report?.config?.parallelFinalSkipped && hasChildReports(entry.dir)) continue;
    const ownKey = reportOwnKey(report);
    if (!ownKey || !Array.isArray(report.games)) continue;
    const policyFingerprint = matchupReportPolicyFingerprint(report);
    for (const game of report.games) {
      const gameKey = matchupGameFingerprint(ownKey, game, policyFingerprint);
      if (gameKey && seenGames.has(gameKey)) continue;
      if (gameKey) seenGames.add(gameKey);
      const opponentId = game.opponent;
      const opponentDeck = deckById.get(opponentId);
      const opponentKey = opponentDeck?.ownKey ?? opponentId ?? "unknown";
      const key = `${ownKey}||${opponentKey}`;
      const bucket = buckets.get(key) ?? {
        ownKey,
        opponentKey,
        opponentLabel: opponentDeck ? archetypeLabel(opponentDeck) : opponentKey,
        opponentDecks: new Set(),
        runs: new Set(),
        games: 0,
        wins: 0,
        losses: 0,
        incomplete: 0,
        lifeDiffTotal: 0,
        turnCyclesTotal: 0,
        playerTurnsTotal: 0,
        completedLifeDiffTotal: 0,
        completedTurnCyclesTotal: 0,
        completedPlayerTurnsTotal: 0,
        mulligans: 0,
        bricks: 0
      };
      bucket.opponentDecks.add(opponentId);
      bucket.runs.add(entry.dir);
      bucket.games += 1;
      const lifeDiff = Number(game.p1LifeRemaining ?? 0) - Number(game.p2LifeRemaining ?? 0);
      const turnCycles = Number(game.turnCyclesTaken ?? 0);
      const playerTurns = Number(game.turnsTaken ?? 0);
      const completed = game.winner === "P1" || game.winner === "P2";
      if (game.winner === "P1") bucket.wins += 1;
      else if (game.winner === "P2") bucket.losses += 1;
      else bucket.incomplete += 1;
      bucket.lifeDiffTotal += lifeDiff;
      bucket.turnCyclesTotal += turnCycles;
      bucket.playerTurnsTotal += playerTurns;
      if (completed) {
        bucket.completedLifeDiffTotal += lifeDiff;
        bucket.completedTurnCyclesTotal += turnCycles;
        bucket.completedPlayerTurnsTotal += playerTurns;
      }
      if (game.p1Mulliganed) bucket.mulligans += 1;
      if (game.p1Bricked || game.p1InitialBricked) bucket.bricks += 1;
      buckets.set(key, bucket);
    }
  }

  const byOwnKey = {};
  for (const bucket of buckets.values()) {
    const total = Math.max(1, bucket.games);
    const completed = completedMatchupMetricSummary({
      wins: bucket.wins,
      losses: bucket.losses,
      incomplete: bucket.incomplete,
      completedLifeDiffTotal: bucket.completedLifeDiffTotal,
      completedTurnCyclesTotal: bucket.completedTurnCyclesTotal,
      completedPlayerTurnsTotal: bucket.completedPlayerTurnsTotal
    });
      const row = {
        ownKey: bucket.ownKey,
        opponentKey: bucket.opponentKey,
        opponentLabel: bucket.opponentLabel,
        games: bucket.games,
        completedGames: completed.completedGames,
        runs: bucket.runs.size,
        opponentDeckCount: bucket.opponentDecks.size,
        opponentDeckIds: [...bucket.opponentDecks].sort((a, b) => String(a).localeCompare(String(b))),
        runIds: [...bucket.runs].sort((a, b) => String(a).localeCompare(String(b))).slice(0, 10),
        wins: bucket.wins,
        losses: bucket.losses,
        incomplete: bucket.incomplete,
        winRate: completed.winRate,
        completionRate: completed.completionRate,
        incompleteRate: completed.incompleteRate,
        avgLifeDiff: completed.avgLifeDiff,
        avgTurnCycles: completed.avgTurnCycles,
        avgPlayerTurns: completed.avgPlayerTurns,
        incompleteAvgLifeDiff: bucket.incomplete > 0
          ? (bucket.lifeDiffTotal - bucket.completedLifeDiffTotal) / bucket.incomplete
          : null,
        incompleteAvgTurnCycles: bucket.incomplete > 0
          ? (bucket.turnCyclesTotal - bucket.completedTurnCyclesTotal) / bucket.incomplete
          : null,
        mulliganRate: bucket.mulligans / total,
        brickRate: bucket.bricks / total
      };
      Object.assign(row, matchupEvidenceSummary(row));
      byOwnKey[bucket.ownKey] ??= [];
      byOwnKey[bucket.ownKey].push(row);
  }

  for (const rows of Object.values(byOwnKey)) {
    rows.sort((a, b) => Number(a.winRate) - Number(b.winRate)
      || matchupCompletedGames(b) - matchupCompletedGames(a)
      || a.opponentLabel.localeCompare(b.opponentLabel));
  }
  return byOwnKey;
}

function matchupCompletedGames(row = {}) {
  if (row.completedGames !== undefined && row.completedGames !== null) {
    return Math.max(0, Number(row.completedGames) || 0);
  }
  if (row.wins !== undefined || row.losses !== undefined) {
    return Math.max(0, Number(row.wins ?? 0) + Number(row.losses ?? 0));
  }
  return Math.max(0, Number(row.games ?? 0) - Number(row.incomplete ?? 0));
}

function matchupEvidenceSummary(row) {
  const notes = [];
  const nextActions = [];
  const games = matchupCompletedGames(row);
  const totalGames = Number(row.games ?? games);
  const incomplete = Number(row.incomplete ?? Math.max(0, totalGames - games));
  const incompleteRate = totalGames > 0 ? incomplete / totalGames : 0;
  const winRate = Number(row.winRate ?? 0);
  const lifeDiff = Number(row.avgLifeDiff ?? 0);
  const turnCycles = Number(row.avgTurnCycles ?? 0);
  let evidenceTier = "early";
  let evidenceLabel = "Early Read";
  if (games >= 100) {
    evidenceTier = "strong";
    evidenceLabel = "Strong Sample";
  } else if (games >= 50) {
    evidenceTier = "usable";
    evidenceLabel = "Usable Sample";
  } else if (games >= 20) {
    evidenceTier = "developing";
    evidenceLabel = "Developing Sample";
  }
  if (incompleteRate > 0) {
    notes.push(`${formatPercent(incompleteRate)} of recorded games were incomplete and are excluded from strategic outcome averages.`);
  }
  if (incompleteRate > 0.2) {
    evidenceTier = "unstable";
    evidenceLabel = "Unreliable Completion";
    nextActions.push("Resolve incomplete-game causes before treating this matchup as strategically measured.");
  }

  if (games === 0) {
    notes.push("No games recorded for this matchup yet.");
    nextActions.push("Run focused Matchup Training before drawing conclusions.");
  } else if (games < 20) {
    notes.push(`Only ${games} game(s) recorded; treat the win rate as directional.`);
    nextActions.push("Collect at least 20 games for a first read and 50+ before deck-change testing.");
  } else if (games < 50) {
    notes.push(`${games} games gives a first read, but it is still below the 50-game confidence target.`);
    nextActions.push("Run another focused cycle before promoting this to a confident matchup read.");
  } else {
    notes.push(`${games} games is enough to use this as matchup evidence.`);
  }

  if (winRate < 0.4) {
    notes.push(`The pilot is clearly behind here at ${formatPercent(winRate)}.`);
    nextActions.push("Prioritize this matchup for overlay learning and later side-by-side deck experiments.");
  } else if (winRate < 0.5) {
    notes.push(`The pilot is slightly behind here at ${formatPercent(winRate)}.`);
    nextActions.push("Keep this matchup in the next training rotation to see whether the gap persists.");
  } else if (winRate >= 0.6) {
    notes.push(`This is currently a strong matchup at ${formatPercent(winRate)}.`);
    nextActions.push("Use this matchup as a guardrail when testing changes for weaker pairings.");
  } else {
    notes.push(`This matchup is near even at ${formatPercent(winRate)}.`);
  }

  if (Number.isFinite(lifeDiff) && Math.abs(lifeDiff) >= 1) {
    notes.push(`Average life spread is ${lifeDiff.toFixed(2)}, which suggests the result is not only coin-flip noise.`);
  }
  if (Number.isFinite(turnCycles) && turnCycles > 8) {
    notes.push(`Games are long at ${turnCycles.toFixed(2)} turn cycles; pilot decisions may still be inefficient.`);
    nextActions.push("Review action-model learning for attack, block, and ability timing if this stays high.");
  } else if (Number.isFinite(turnCycles) && turnCycles > 0 && turnCycles <= 6.5) {
    notes.push(`Game length is in a realistic band at ${turnCycles.toFixed(2)} turn cycles.`);
  }

  return {
    evidenceTier,
    evidenceLabel,
    readNotes: uniqueStrings(notes).slice(0, 6),
    nextActions: uniqueStrings(nextActions).slice(0, 5)
  };
}

function reportEntries(root) {
  if (!existsSync(root)) return [];
  const entries = [];
  const queue = [root];
  while (queue.length > 0 && entries.length < 1000) {
    const dir = queue.shift();
    const reportPath = join(dir, "report.json");
    const report = readJsonIfExists(reportPath);
    if (report) entries.push({ dir, path: reportPath, report, updatedAt: safeStat(reportPath)?.mtime?.toISOString() ?? null });
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) queue.push(join(dir, entry.name));
    }
  }
  return entries.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function hasChildReports(dir) {
  const childRoot = join(dir, "runs");
  if (!existsSync(childRoot)) return false;
  return readdirSync(childRoot, { withFileTypes: true })
    .some((entry) => entry.isDirectory() && existsSync(join(childRoot, entry.name, "report.json")));
}

function matchupReportPolicyFingerprint(report = {}) {
  const weights = Object.entries(report.bestPolicy?.weights ?? {})
    .map(([feature, value]) => [feature, Number(value)])
    .filter(([, value]) => Number.isFinite(value))
    .sort(([left], [right]) => left.localeCompare(right));
  return weights.length > 0 ? JSON.stringify(weights) : null;
}

function matchupGameFingerprint(ownKey, game = {}, policyFingerprint = null) {
  const seed = game.seed ?? game.gameSeed;
  const candidate = game.candidateId ?? game.policyId ?? game.policyName;
  if (seed === null || seed === undefined || !candidate || !policyFingerprint) return null;
  return [ownKey, seed, game.opponent ?? "unknown", game.firstPlayer ?? "unknown", candidate, policyFingerprint].join("|");
}

function reportOwnKey(report) {
  return report?.config?.policySelection?.profile?.key
    ?? report?.config?.matchupOverlaySelection?.profile?.key
    ?? report?.analysis?.deckProfile?.key
    ?? report?.bestPolicy?.profile?.key
    ?? null;
}

function policyFileSummary(path) {
  const policy = readJsonIfExists(path);
  const stats = safeStat(path);
  return policy ? {
    path,
    exists: true,
    name: policy.name ?? null,
    weights: Object.keys(policy.weights ?? {}).length,
    updatedAt: stats?.mtime?.toISOString() ?? null,
    hash: fileHash(path)
  } : {
    path,
    exists: false
  };
}

function policyFileSummaryFromCandidates(candidates) {
  const rows = candidates.map((candidate) => ({
    ...policyFileSummary(candidate.path),
    layout: candidate.layout ?? null
  }));
  const found = rows.find((row) => row.exists);
  return found ?? rows[0] ?? { exists: false };
}

function attachBaselineOrigin(summary, originPath) {
  if (!summary || !summary.exists) return summary;
  const origin = readJsonIfExists(originPath);
  summary.originPath = originPath;
  summary.origin = origin;
  summary.quality = baselineQuality(origin, summary);
  summary.needsTraining = summary.quality === "seed" || summary.quality === "unknown" || Boolean(origin?.needsTraining);
  summary.validatedImprovement = Boolean(origin?.validatedImprovement);
  summary.promotionType = origin?.promotionType ?? (summary.layout === "legacy" ? "legacy" : "unknown");
  return summary;
}

function baselineQuality(origin, summary = {}) {
  if (origin?.quality) return origin.quality;
  if (origin?.promotionType === "missing-seed" || origin?.promotionType === "implicit-seed" || origin?.needsTraining) return "seed";
  if (origin?.promotionType === "improved" || origin?.promotionType === "missing-improved" || origin?.promotionType === "forced") return "trained";
  if (summary.layout === "legacy") return "legacy";
  return origin ? "unknown" : "unknown";
}

function modelRuntimeReadiness(model = null) {
  const readiness = mlActionModelReadiness(model || null);
  const healthStatus = String(model?.learningHealth?.status ?? model?.learningHealthStatus ?? "").toLowerCase();
  return {
    ...readiness,
    label: readiness.ready ? "Runtime Ready" : model ? "Collecting Evidence" : "No Model",
    signalTrust: readiness.learningSignalTrust,
    learningHealthStatus: healthStatus || null,
    thresholds: runtimeReadinessThresholds()
  };
}

function runtimeReadinessThresholds() {
  return {
    signalTrust: MIN_ML_RUNTIME_TRUST,
    heldoutPlayerGames: MIN_ML_RUNTIME_HELDOUT_GAMES,
    pairwiseExamples: MIN_ML_RUNTIME_PAIRWISE_EXAMPLES,
    pairwiseEffectiveWeightVersion: MIN_ML_PAIRWISE_EFFECTIVE_WEIGHT_VERSION,
    pairwiseEffectiveWeight: MIN_ML_RUNTIME_PAIRWISE_EFFECTIVE_WEIGHT,
    evidenceDiversityVersion: MIN_ML_EVIDENCE_DIVERSITY_VERSION,
    diversityExamples: MIN_ML_RUNTIME_DIVERSITY_EXAMPLES,
    distinctPhases: MIN_ML_RUNTIME_DISTINCT_PHASES,
    distinctActionPairs: MIN_ML_RUNTIME_DISTINCT_ACTION_PAIRS,
    distinctOpponents: MIN_ML_RUNTIME_DISTINCT_OPPONENTS,
    maxDominantActionPairRate: MAX_ML_RUNTIME_DOMINANT_ACTION_PAIR_RATE,
    maxHistoricalUnclassifiedExamples: MAX_ML_RUNTIME_HISTORICAL_UNCLASSIFIED_EXAMPLES,
    sourceDigestVersion: MIN_LEARNING_SOURCE_DIGEST_VERSION,
    learningEvidenceFilterVersion: MIN_LEARNING_EVIDENCE_FILTER_VERSION,
    pairwiseOrientationVersion: MIN_ML_PAIRWISE_ORIENTATION_VERSION,
    regressionVersion: MIN_ML_REGRESSION_VERSION,
    trainingPipelineVersion: MIN_ML_TRAINING_PIPELINE_VERSION,
    validationAssignmentVersion: MIN_ML_VALIDATION_ASSIGNMENT_VERSION,
    validationStateVersion: MIN_ML_VALIDATION_STATE_VERSION,
    validationDiversityVersion: MIN_ML_VALIDATION_DIVERSITY_VERSION,
    validationDistinctPhases: MIN_ML_RUNTIME_VALIDATION_DISTINCT_PHASES,
    validationDistinctActionPairs: MIN_ML_RUNTIME_VALIDATION_DISTINCT_ACTION_PAIRS,
    validationDistinctOpponents: MIN_ML_RUNTIME_VALIDATION_DISTINCT_OPPONENTS,
    validationActionPairExamples: MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_EXAMPLES,
    validationActionPairGames: MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_GAMES,
    validationActionPairSignExamples: MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_SIGN_EXAMPLES,
    validationActionPairAccuracy: MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_ACCURACY,
    validationBalancedAccuracy: MIN_ML_RUNTIME_VALIDATION_BALANCED_ACCURACY,
    validationPairwiseEffectiveWeight: MIN_ML_RUNTIME_VALIDATION_PAIRWISE_EFFECTIVE_WEIGHT,
    maxValidationDominantActionPairRate: MAX_ML_RUNTIME_VALIDATION_DOMINANT_ACTION_PAIR_RATE,
    pairwiseInputConsistencyVersion: MIN_ML_PAIRWISE_INPUT_CONSISTENCY_VERSION,
    validationConsistencyRepeatedContexts: MIN_ML_RUNTIME_VALIDATION_CONSISTENCY_REPEATED_CONTEXTS,
    validationConsistencyRepeatedExamples: MIN_ML_RUNTIME_VALIDATION_CONSISTENCY_REPEATED_EXAMPLES,
    maxValidationInputConflictRate: MAX_ML_RUNTIME_VALIDATION_INPUT_CONFLICT_RATE,
    counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION
  };
}

function modelFileSummary(path, { fallbackPath = null } = {}) {
  const model = readJsonIfExists(path);
  const stats = safeStat(path);
  const runtimeReadiness = modelRuntimeReadiness(model);
  if (model) return {
    path,
    exists: true,
    source: "profile",
    name: model.name ?? null,
    learningMode: model.learningMode ?? null,
    sourceRows: Number(model.sourceRows ?? 0),
    examples: Number(model.examples ?? 0),
    selectedExamples: Number(model.selectedExamples ?? 0),
    pairwiseExamples: Number(model.pairwiseExamples ?? 0),
    pairwiseEffectiveWeightVersion: Number(model.pairwiseEffectiveWeightVersion ?? 0),
    pairwiseEffectiveWeight: Number(model.pairwiseEffectiveWeight ?? 0),
    uniqueLearningUnits: Number(model.uniqueLearningUnits ?? 0),
    duplicateLearningUnitsSkipped: Number(model.duplicateLearningUnitsSkipped ?? 0),
    effectiveExamples: Number(model.exampleWeightTotal ?? model.examples ?? 0),
    learningSignalVersion: Number(model.learningSignalVersion ?? 1),
    sourceDigestVersion: Number(model.sourceDigestVersion ?? 0),
    learningEvidenceFilterVersion: Number(model.learningEvidenceFilterVersion ?? 0),
    validationStateVersion: Number(model.validationStateVersion ?? 0),
    pairwiseOrientationVersion: Number(model.pairwiseOrientationVersion ?? 1),
    pairwiseInputConsistencyVersion: Number(model.pairwiseInputConsistencyVersion ?? 0),
    regressionVersion: Number(model.regressionVersion ?? 1),
    counterfactualStateEvaluationVersion: Number(model.counterfactualStateEvaluationVersion ?? 1),
    learningSignalTrust: Number(model.learningSignalVersion ?? 1) >= 2 ? Number(model.learningSignalTrust ?? 1) : 0.25,
    evidenceSignalTrust: Number(model.evidenceSignalTrust ?? 1),
    validationSignalTrust: Number(model.validationSignalTrust ?? 1),
    learningHealth: model.learningHealth ?? null,
    runtimeReadiness,
    evidenceDiversity: runtimeReadiness.evidenceDiversity,
    validation: modelValidationSummary(model),
    features: Object.keys(model.weights ?? {}).length,
    learning: modelLearningSummary(model),
    trainedAt: model.trainedAt ?? null,
    updatedAt: stats?.mtime?.toISOString() ?? null
  };
  if (fallbackPath) {
    const fallback = modelFileSummary(fallbackPath);
    if (fallback.exists) {
      return {
        ...fallback,
        source: "fallback",
        fallbackFor: path
      };
    }
  }
  return {
    path,
    exists: false
  };
}

function modelFileSummaryFromCandidates(candidates) {
  const rows = candidates.map((candidate) => {
    const model = readJsonIfExists(candidate.path);
    const stats = safeStat(candidate.path);
    if (!model) return {
      path: candidate.path,
      exists: false,
      source: candidate.source ?? "profile",
      layout: candidate.layout ?? null,
      fallbackFor: candidate.fallbackFor ?? null
    };
    const runtimeReadiness = modelRuntimeReadiness(model);
    return {
      path: candidate.path,
      exists: true,
      source: candidate.source ?? "profile",
      layout: candidate.layout ?? null,
      fallbackFor: candidate.fallbackFor ?? null,
      name: model.name ?? null,
      learningMode: model.learningMode ?? null,
      sourceRows: Number(model.sourceRows ?? 0),
      examples: Number(model.examples ?? 0),
      selectedExamples: Number(model.selectedExamples ?? 0),
      pairwiseExamples: Number(model.pairwiseExamples ?? 0),
      pairwiseEffectiveWeightVersion: Number(model.pairwiseEffectiveWeightVersion ?? 0),
      pairwiseEffectiveWeight: Number(model.pairwiseEffectiveWeight ?? 0),
      uniqueLearningUnits: Number(model.uniqueLearningUnits ?? 0),
      duplicateLearningUnitsSkipped: Number(model.duplicateLearningUnitsSkipped ?? 0),
      effectiveExamples: Number(model.exampleWeightTotal ?? model.examples ?? 0),
      learningSignalVersion: Number(model.learningSignalVersion ?? 1),
      sourceDigestVersion: Number(model.sourceDigestVersion ?? 0),
      learningEvidenceFilterVersion: Number(model.learningEvidenceFilterVersion ?? 0),
      validationStateVersion: Number(model.validationStateVersion ?? 0),
      pairwiseOrientationVersion: Number(model.pairwiseOrientationVersion ?? 1),
      pairwiseInputConsistencyVersion: Number(model.pairwiseInputConsistencyVersion ?? 0),
      regressionVersion: Number(model.regressionVersion ?? 1),
      counterfactualStateEvaluationVersion: Number(model.counterfactualStateEvaluationVersion ?? 1),
      learningSignalTrust: Number(model.learningSignalVersion ?? 1) >= 2 ? Number(model.learningSignalTrust ?? 1) : 0.25,
      evidenceSignalTrust: Number(model.evidenceSignalTrust ?? 1),
      validationSignalTrust: Number(model.validationSignalTrust ?? 1),
      learningHealth: model.learningHealth ?? null,
      runtimeReadiness,
      evidenceDiversity: runtimeReadiness.evidenceDiversity,
      validation: modelValidationSummary(model),
      features: Object.keys(model.weights ?? {}).length,
      featureSelection: model.featureSelection ?? null,
      learning: modelLearningSummary(model),
      trainedAt: model.trainedAt ?? null,
      updatedAt: stats?.mtime?.toISOString() ?? null
    };
  });
  const found = rows.find((row) => row.exists);
  return found ?? rows[0] ?? { exists: false };
}

function modelLearningSummary(model) {
  const weights = Object.entries(model?.weights ?? {})
    .map(([feature, weight]) => ({ feature, weight: Number(weight) }))
    .filter((row) => Number.isFinite(row.weight));
  const positive = weights
    .filter((row) => row.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.feature.localeCompare(b.feature))
    .slice(0, 8);
  const negative = weights
    .filter((row) => row.weight < 0)
    .sort((a, b) => a.weight - b.weight || a.feature.localeCompare(b.feature))
    .slice(0, 8);
  const groups = [...groupBy(weights, (row) => learningFeatureGroup(row.feature)).entries()]
    .map(([group, rows]) => ({
      group,
      features: rows.length,
      avgAbsWeight: average(rows, (row) => Math.abs(row.weight)),
      strongest: [...rows].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))[0] ?? null
    }))
    .sort((a, b) => b.avgAbsWeight - a.avgAbsWeight || a.group.localeCompare(b.group));
  const runtimeReadiness = modelRuntimeReadiness(model);
  return {
    examples: Number(model?.examples ?? 0),
    selectedExamples: Number(model?.selectedExamples ?? 0),
    pairwiseExamples: Number(model?.pairwiseExamples ?? 0),
    pairwiseEffectiveWeight: Number(model?.pairwiseEffectiveWeight ?? 0),
    uniqueLearningUnits: Number(model?.uniqueLearningUnits ?? 0),
    duplicateLearningUnitsSkipped: Number(model?.duplicateLearningUnitsSkipped ?? 0),
    sourceRows: Number(model?.sourceRows ?? 0),
    learningMode: model?.learningMode ?? null,
    runtimeReadiness,
    evidenceDiversity: runtimeReadiness.evidenceDiversity,
    validation: modelValidationSummary(model),
    featureSelection: model?.featureSelection ?? null,
    averageTarget: numberOrNull(model?.averageTarget),
    positive,
    negative,
    groups,
    themes: learningThemes({ positive, negative, weights })
  };
}

function modelValidationSummary(model) {
  const validation = model?.validation;
  if (!validation) return null;
  return {
    strategy: validation.strategy ?? null,
    cumulative: Boolean(validation.cumulative),
    reservoir: validation.reservoir ?? null,
    fraction: numberOrNull(validation.fraction),
    heldoutPlayerGames: Number(validation.heldoutPlayerGames ?? 0),
    assignedHeldoutPlayerGames: Number(validation.assignedHeldoutPlayerGames ?? validation.heldoutPlayerGames ?? 0),
    heldoutDecisions: Number(validation.heldoutDecisions ?? 0),
    sampledExamples: Number(validation.sampledExamples ?? 0),
    overallSignAccuracy: numberOrNull(validation.overall?.signAccuracy),
    anchorSignAccuracy: numberOrNull(validation.anchor?.signAccuracy),
    anchorBalancedSignAccuracy: numberOrNull(validation.anchor?.balancedSignAccuracy),
    anchorPositiveExamples: Number(validation.anchor?.positiveExamples ?? 0),
    anchorNegativeExamples: Number(validation.anchor?.negativeExamples ?? 0),
    anchorMajoritySignBaseline: numberOrNull(validation.anchor?.majoritySignBaseline),
    pairwiseSignAccuracy: numberOrNull(validation.pairwise?.signAccuracy),
    pairwiseBalancedSignAccuracy: numberOrNull(validation.pairwise?.balancedSignAccuracy),
    pairwiseEffectiveWeight: numberOrNull(validation.pairwise?.weightTotal),
    pairwiseValidationDiversity: validation.pairwise?.validationDiversity ?? null,
    inputConsistency: mlValidationInputConsistency(model),
    overallMeanAbsoluteError: numberOrNull(validation.overall?.meanAbsoluteError),
    pairwiseMeanAbsoluteError: numberOrNull(validation.pairwise?.meanAbsoluteError)
  };
}

function learningFeatureGroup(feature) {
  const contextGroup = contextualLearningFeatureGroup(feature);
  if (contextGroup) return contextGroup;
  if (feature.startsWith("setup")) return "opening hand";
  if (feature.startsWith("attack") || feature.startsWith("snipe") || feature.includes("lethal")) return "attack";
  if (feature.startsWith("block") || feature.startsWith("decline") || feature.includes("Damage")) return "defense";
  if (feature.startsWith("ability") || feature === "activateMain") return "abilities";
  if (feature.startsWith("role")) return "card roles";
  if (feature.includes("Energy") || feature.includes("energy") || feature === "playToEnergy") return "energy";
  if (feature === "playCard" || feature === "playToFront" || feature === "performRaid" || feature === "moveToFront") return "development";
  return "general";
}

function contextualLearningFeatureGroup(feature) {
  const value = String(feature ?? "");
  if (!value.startsWith("context.")) return null;
  const [, family, , actionId] = value.split(".");
  if (family === "setup") return "opening hand cards";
  if (family === "attack") return "specific attackers";
  if (family === "block") return "specific blockers";
  if (family === "ability") return "specific abilities";
  if (family === "raid") return "specific Raid lines";
  if (family === "move") return "specific movement";
  if (family === "play") return "specific card plays";
  if (family === "discard") return "specific discards";
  if (family === "choice") return actionId === "raid" ? "specific Raid choices" : actionId === "play" ? "specific play choices" : "specific ability choices";
  return "card-specific context";
}

function learningThemes({ positive, negative, weights }) {
  const byFeature = new Map(weights.map((row) => [row.feature, row.weight]));
  const themes = [];
  if (["setupZeroCostUnit", "setupPlayableOpener", "setupEnergyPathToThree", "setupLowCostUnit"].some((feature) => Number(byFeature.get(feature) ?? 0) > 0)) {
    themes.push("Opening hands with playable low-cost units and energy paths are rewarded.");
  }
  if (Number(byFeature.get("energyShortage") ?? 0) > 0 || Number(byFeature.get("playToEnergy") ?? 0) > 0) {
    themes.push("The pilot is learning to respect energy development and shortage risk.");
  }
  if (Number(byFeature.get("passMissedLethal") ?? 0) < 0 || Number(byFeature.get("passMissedDamage") ?? 0) < 0 || Number(byFeature.get("advancePhase") ?? 0) < 0) {
    themes.push("The pilot penalizes passing or advancing when pressure is available.");
  }
  if (Number(byFeature.get("lethalAttack") ?? 0) > 0 || Number(byFeature.get("openLaneDamage") ?? 0) > 0) {
    themes.push("The pilot values closing windows and open-lane damage.");
  }
  if (Number(byFeature.get("lethalBlock") ?? 0) > 0 || Number(byFeature.get("declineLethal") ?? 0) < 0) {
    themes.push("The pilot recognizes lethal-defense situations.");
  }
  if (Number(byFeature.get("abilityRemoval") ?? 0) > 0 || Number(byFeature.get("roleRemoval") ?? 0) > 0) {
    themes.push("Removal and interaction are currently valued by the model.");
  }
  if (positive.length > 0) themes.push(`Strongest positive signal: ${humanizeFeature(positive[0].feature)} (${positive[0].weight}).`);
  if (negative.length > 0) themes.push(`Strongest negative signal: ${humanizeFeature(negative[0].feature)} (${negative[0].weight}).`);
  return uniqueStrings(themes).slice(0, 8);
}

function humanizeFeature(feature) {
  if (String(feature ?? "").startsWith("context.")) return humanizeContextFeature(feature);
  return String(feature ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();
}

function humanizeContextFeature(feature) {
  const parts = String(feature ?? "").split(".").slice(1);
  return `card-specific ${parts.join(" ").replace(/_/g, " ")}`;
}

function profileActionModelPath(ownKey) {
  return actionModelPathForKey(ownKey, { agentRoot: AGENT_ROOT, baselineRoot: BASELINE_ROOT });
}

function policyKeySegment(value) {
  return routePolicyKeySegment(value);
}

function archetypeLabel(deck) {
  const set = deck.sourceCode ?? "Unknown";
  const colorList = Array.isArray(deck.colors) ? deck.colors : [];
  const colors = colorList.length ? colorList.join("/") : "unknown";
  const archetype = displayArchetypeName(deck.archetype, { set, colors: colorList });
  return [set, colors, archetype].filter(Boolean).join(" ");
}

function archetypeNameFromPolicyKey(key, setColorKey) {
  const normalizedKey = policyKeySegment(key);
  const normalizedSetColor = policyKeySegment(setColorKey);
  if (!normalizedKey || !normalizedSetColor || normalizedKey === normalizedSetColor) return null;
  const suffix = normalizedKey.startsWith(`${normalizedSetColor}-`)
    ? normalizedKey.slice(normalizedSetColor.length + 1)
    : normalizedKey;
  if (!suffix || suffix === normalizedKey) return null;
  return suffix.split("-")
    .filter(Boolean)
    .map((part) => {
      if (/^(?:eva|rnk|slg|smd|tkg|kgr|jjk|blc)$/iu.test(part)) return part.toUpperCase();
      if (/^\d+$/u.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function displayArchetypeName(archetype, { set, colors } = {}) {
  const words = String(archetype ?? "").trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return null;
  const redundant = new Set([
    policyKeySegment(set),
    ...(colors ?? []).map((color) => policyKeySegment(color))
  ].filter(Boolean));
  while (words.length > 0 && redundant.has(policyKeySegment(words[0]))) {
    words.shift();
  }
  return words.join(" ") || null;
}

function recentRuns(limit) {
  if (!existsSync(RUNS_ROOT)) return [];
  const rows = [];
  for (const entry of readdirSync(RUNS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(RUNS_ROOT, entry.name);
    rows.push(runSummary(dir, entry.name));
    rows.push(...childRunSummaries(dir, entry.name));
  }
  return rows
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, limit);
}

function childRunSummaries(parentPath, parentId) {
  const childRoot = join(parentPath, "runs");
  if (!existsSync(childRoot)) return [];
  return readdirSync(childRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const childPath = join(childRoot, entry.name);
      if (!existsSync(join(childPath, "report.json"))) return null;
      return runSummary(childPath, `${parentId}/${entry.name}`, {
        parentId,
        childRun: true
      });
    })
    .filter(Boolean);
}

function recentDeckExperiments(limit, decks) {
  const roots = [DECK_EXPERIMENT_ROOT, "work/private/deck-agent"];
  const deckById = new Map((decks ?? []).map((deck) => [deck.id, deck]));
  const rows = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      const report = readJsonIfExists(join(dir, "report.json"));
      if (!report || report.schema !== "union-arena-local-engine/deck-agent-report@1") continue;
      const baseDeckId = report.config?.base ?? report.deck?.id ?? null;
      if (!baseDeckId) continue;
      const baseDeck = deckById.get(baseDeckId);
      const bestDeck = readJsonIfExists(join(dir, "best-deck.json"));
      const stats = safeStat(join(dir, "report.json")) ?? safeStat(dir);
      const result = report.best?.finalEvaluation ?? report.result ?? report.analysis?.testingBreakdown ?? null;
      const cardChanges = Array.isArray(report.deckComparison?.changes)
        ? report.deckComparison.changes
        : baseDeck && bestDeck?.cards
          ? deckDiff(baseDeck.cards, bestDeck.cards, catalogById())
          : [];
      rows.push({
        id: entry.name,
        path: dir,
        root,
        updatedAt: stats?.mtime?.toISOString() ?? null,
        mode: report.mode,
        baseDeckId,
        baseDeckName: baseDeck?.name ?? report.baseDeck?.id ?? baseDeckId,
        opponentIds: report.config?.opponents ?? report.opponents ?? [],
        result: result ? summaryResult(result) : null,
        searchScore: numberOrNull(report.best?.searchScore),
        analysis: report.analysis ? {
          positives: report.analysis.positives ?? [],
          negatives: report.analysis.negatives ?? [],
          recommendations: report.analysis.recommendations ?? [],
          confidenceNotes: report.analysis.confidenceNotes ?? [],
          deckShape: report.analysis.deckShape ?? null
        } : null,
        baseComparison: baseDeck && bestDeck?.cards ? deckExperimentBaseComparison(baseDeck.cards, bestDeck.cards, report) : null,
        cardChanges,
        bestDeckPath: existsSync(join(dir, "best-deck.txt")) ? join(dir, "best-deck.txt") : null,
        reportPath: join(dir, "report.json")
      });
    }
  }
  return rows
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, limit);
}

function deckExperimentBaseComparison(baseCards, bestCards, report) {
  const paired = report.deckComparison;
  if (paired && typeof paired === "object") {
    const changes = Array.isArray(paired.changes) ? paired.changes : deckDiff(baseCards, bestCards, catalogById());
    return {
      baseCandidateScore: numberOrNull(paired.base?.score),
      bestSearchScore: numberOrNull(report.best?.searchScore),
      baseCandidateWinRate: numberOrNull(paired.base?.winRate),
      finalWinRate: numberOrNull(paired.candidate?.winRate),
      scoreDelta: numberOrNull(paired.scoreDelta),
      winRateDelta: numberOrNull(paired.winRateDelta),
      lifeDiffDelta: numberOrNull(paired.lifeDiffDelta),
      brickRateDelta: numberOrNull(paired.brickRateDelta),
      changedCopies: numberOrNull(paired.changedCopies) ?? changes.reduce((total, row) => total + Math.abs(Number(row.delta ?? 0)), 0),
      usesPairedFinal: true
    };
  }

  const baselineCandidate = (report.rankings ?? []).find((row) => row.generation === 0 && row.candidateId === "g0-c0");
  const final = report.best?.finalEvaluation ?? report.result ?? null;
  return {
    baseCandidateScore: numberOrNull(baselineCandidate?.score),
    bestSearchScore: numberOrNull(report.best?.searchScore),
    baseCandidateWinRate: numberOrNull(baselineCandidate?.winRate),
    finalWinRate: numberOrNull(final?.winRate),
    scoreDelta: Number.isFinite(Number(report.best?.searchScore)) && Number.isFinite(Number(baselineCandidate?.score))
      ? Number(report.best.searchScore) - Number(baselineCandidate.score)
      : null,
    winRateDelta: Number.isFinite(Number(final?.winRate)) && Number.isFinite(Number(baselineCandidate?.winRate))
      ? Number(final.winRate) - Number(baselineCandidate.winRate)
      : null,
    changedCopies: deckDiff(baseCards, bestCards, catalogById()).reduce((total, row) => total + Math.abs(Number(row.delta ?? 0)), 0),
    usesPairedFinal: false
  };
}

function deckDiff(baseCards, bestCards, catalogJson) {
  const base = countCards(baseCards);
  const best = countCards(bestCards);
  const ids = [...new Set([...base.keys(), ...best.keys()])].sort((a, b) => {
    const aCard = catalogJson[a];
    const bCard = catalogJson[b];
    return String(aCard?.number ?? a).localeCompare(String(bCard?.number ?? b));
  });
  return ids
    .map((id) => {
      const before = Number(base.get(id) ?? 0);
      const after = Number(best.get(id) ?? 0);
      const delta = after - before;
      const card = catalogJson[id];
      return {
        id,
        before,
        after,
        delta,
        number: card?.number ?? id,
        name: card?.name ?? id,
        trigger: card?.trigger?.type ?? "none",
        type: card?.type ?? "unknown",
        requiredEnergy: numberOrNull(card?.requiredEnergy?.amount)
      };
    })
    .filter((row) => row.delta !== 0);
}

function countCards(cards) {
  const counts = new Map();
  for (const entry of cards ?? []) {
    if (typeof entry === "string") counts.set(entry, (counts.get(entry) ?? 0) + 1);
    else if (entry?.id) counts.set(entry.id, (counts.get(entry.id) ?? 0) + Number(entry.count ?? 0));
  }
  return counts;
}

function catalogById() {
  const rows = catalogCards().rows ?? [];
  return Object.fromEntries(rows.flatMap((card) => {
    const values = [card.id, card.number, card.cardNumber, card.code].filter(Boolean);
    return values.map((value) => [value, card]);
  }));
}

function decisionCardEvidenceByOwnKey({ allowColdScan = false } = {}) {
  const now = Date.now();
  const sourceSignature = cardEvidenceSourceSignature();
  if (cardEvidenceCacheIsFresh(cardEvidenceCache, now, sourceSignature)) return cardEvidenceCache.data;

  const diskCache = readJsonIfExists(CARD_EVIDENCE_CACHE_PATH);
  if (diskCache?.schema === CARD_EVIDENCE_CACHE_SCHEMA
    && diskCache?.data
    && Number.isFinite(Number(diskCache.generatedAt))) {
    cardEvidenceCache = {
      generatedAt: Number(diskCache.generatedAt),
      sourceSignature: diskCache.sourceSignature ?? null,
      data: diskCache.data
    };
    if (cardEvidenceCacheIsFresh(cardEvidenceCache, now, sourceSignature)) return cardEvidenceCache.data;
    if (!allowColdScan) {
      scheduleCardEvidenceWarm();
      return cardEvidenceCache.data;
    }
  }

  if (!allowColdScan) {
    scheduleCardEvidenceWarm();
    return cardEvidenceCache?.data ?? {};
  }

  return buildDecisionCardEvidenceByOwnKey();
}

function buildDecisionCardEvidenceByOwnKey() {
  const started = Date.now();
  const sourceSignature = cardEvidenceSourceSignature();
  runtimeLog("card evidence warm start");

  const evidence = {};
  const modelSources = actionModelCardEvidenceSources();
  if (modelSources.size > 0) {
    for (const [ownKey, source] of modelSources) {
      const profile = emptyCardEvidenceProfile({
        sourceMode: "action-model-source-files",
        modelPath: source.modelPath,
        modelExamples: source.examples,
        selectedExamples: source.selectedExamples,
        pairwiseExamples: source.pairwiseExamples,
        learningMode: source.learningMode,
        modelSourceFiles: source.files.length
      });
      for (const filePath of source.files.slice(0, CARD_EVIDENCE_MAX_FILES)) {
        if (profile.scannedRows >= CARD_EVIDENCE_MAX_ROWS) break;
        const stats = safeStat(filePath);
        if (!stats?.isFile()) {
          profile.missingFiles += 1;
          continue;
        }
        if (stats.size > CARD_EVIDENCE_MAX_FILE_BYTES) {
          profile.skippedLargeFiles += 1;
          continue;
        }
        profile.files += 1;
        profile.sourceFiles.push(filePath);
        const rows = readJsonlRows(filePath, CARD_EVIDENCE_MAX_ROWS - profile.scannedRows);
        profile.scannedRows += rows.length;
        for (const row of rows) processCardEvidenceRow(profile, row);
      }
      profile.capped = profile.scannedRows >= CARD_EVIDENCE_MAX_ROWS || source.files.length > CARD_EVIDENCE_MAX_FILES;
      evidence[ownKey] = profile;
    }

    const data = Object.fromEntries(Object.entries(evidence).map(([ownKey, profile]) => [ownKey, finalizeCardEvidenceProfile(profile)]));
    writeCardEvidenceCache(data, started, sourceSignature);
    return data;
  }

  const files = decisionLogFiles(RUNS_ROOT)
    .filter((file) => file.size <= CARD_EVIDENCE_MAX_FILE_BYTES)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, CARD_EVIDENCE_MAX_FILES);
  let rowsRead = 0;
  for (const file of files) {
    if (rowsRead >= CARD_EVIDENCE_MAX_ROWS) break;
    const report = readJsonIfExists(join(file.dir, "report.json"));
    const ownKey = reportOwnKey(report);
    if (!ownKey) continue;
    const profile = evidence[ownKey] ?? emptyCardEvidenceProfile({ sourceMode: "latest-run-sample" });
    profile.files += 1;
    profile.sourceFiles.push(file.path);
    const rows = readJsonlRows(file.path, CARD_EVIDENCE_MAX_ROWS - rowsRead);
    rowsRead += rows.length;
    profile.scannedRows += rows.length;
    for (const row of rows) processCardEvidenceRow(profile, row);
    evidence[ownKey] = profile;
  }

  const data = Object.fromEntries(Object.entries(evidence).map(([ownKey, profile]) => [ownKey, finalizeCardEvidenceProfile(profile)]));
  writeCardEvidenceCache(data, started, sourceSignature);
  return data;
}

function cardEvidenceCacheIsFresh(cache, now, sourceSignature) {
  return Boolean(
    cache?.sourceSignature
    && cache.sourceSignature === sourceSignature
    && now - Number(cache.generatedAt ?? 0) < CARD_EVIDENCE_CACHE_MS
  );
}

function cardEvidenceSourceSignature() {
  const models = actionModels().map((row) => ({
    ownKey: row.ownKey,
    path: row.path,
    updatedAt: row.updatedAt,
    sourceRows: row.sourceRows,
    examples: row.examples,
    selectedExamples: row.selectedExamples,
    pairwiseExamples: row.pairwiseExamples,
    learningMode: row.learningMode
  }));
  if (models.length > 0) {
    return `models:${createHash("sha256").update(JSON.stringify(models)).digest("hex")}`;
  }

  const logs = decisionLogFiles(RUNS_ROOT)
    .map((file) => ({ path: file.path, size: file.size, updatedAt: file.updatedAt }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return `runs:${createHash("sha256").update(JSON.stringify(logs)).digest("hex")}`;
}

function scheduleCardEvidenceWarm() {
  if (cardEvidenceWarmScheduled || cardEvidenceWarming) return;
  cardEvidenceWarmScheduled = true;
  const timer = setTimeout(() => {
    cardEvidenceWarmScheduled = false;
    if (cardEvidenceWarming) return;
    cardEvidenceWarming = true;
    const child = spawn(process.execPath, cardEvidenceWarmProcessArgs(), {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: "ignore"
    });
    child.on("error", (error) => {
      cardEvidenceWarming = false;
      runtimeLog(`card evidence background warm failed ${error.stack || error.message || error}`);
    });
    child.on("exit", (code, signal) => {
      cardEvidenceWarming = false;
      if (code === 0) {
        const diskCache = readJsonIfExists(CARD_EVIDENCE_CACHE_PATH);
        if (diskCache?.schema === CARD_EVIDENCE_CACHE_SCHEMA && diskCache?.data) {
          cardEvidenceCache = {
            generatedAt: Number(diskCache.generatedAt ?? Date.now()),
            sourceSignature: diskCache.sourceSignature ?? null,
            data: diskCache.data
          };
          invalidateDashboardAnalyticsCache();
        }
        runtimeLog("card evidence background warm complete");
      } else {
        runtimeLog(`card evidence background warm exited code=${code} signal=${signal ?? ""}`);
      }
    });
    child.unref();
  }, CARD_EVIDENCE_WARM_DELAY_MS);
  if (typeof timer.unref === "function") timer.unref();
}

function cardEvidenceWarmProcessArgs() {
  return [
    process.argv[1],
    "--build-card-evidence-cache",
    "--agent-root", AGENT_ROOT,
    "--library", DECK_LIBRARY,
    "--catalog", CATALOG_PATH,
    "--runs-root", RUNS_ROOT,
    "--policy-dir", POLICY_DIR,
    "--baseline-root", BASELINE_ROOT,
    "--dashboard-dir", DASHBOARD_DIR,
    "--card-evidence-max-files", String(CARD_EVIDENCE_MAX_FILES),
    "--card-evidence-max-rows", String(CARD_EVIDENCE_MAX_ROWS),
    "--card-evidence-max-file-mb", String(CARD_EVIDENCE_MAX_FILE_BYTES / (1024 * 1024))
  ];
}

function writeCardEvidenceCache(data, startedAtMs, sourceSignature) {
  const generatedAt = Date.now();
  cardEvidenceCache = { generatedAt, sourceSignature, data };
  try {
    writeJsonAtomicSync(CARD_EVIDENCE_CACHE_PATH, {
      schema: CARD_EVIDENCE_CACHE_SCHEMA,
      generatedAt,
      generatedAtIso: new Date(generatedAt).toISOString(),
      durationMs: generatedAt - startedAtMs,
      profileCount: Object.keys(data ?? {}).length,
      sourceSignature,
      data
    });
  } catch (error) {
    runtimeLog(`card evidence cache write failed ${error.message || error}`);
  }
  invalidateDashboardAnalyticsCache();
  runtimeLog(`card evidence warm complete profiles=${Object.keys(data ?? {}).length} durationMs=${generatedAt - startedAtMs}`);
}

function actionModelCardEvidenceSources() {
  const sources = new Map();
  for (const row of actionModels()) {
    if (!row?.ownKey || !row.path) continue;
    const model = readJsonIfExists(row.path);
    const files = [...new Set((model?.sourceFiles ?? []).map((file) => String(file ?? "").trim()).filter(Boolean))];
    if (files.length === 0) continue;
    const current = sources.get(row.ownKey);
    if (current && Number(current.examples ?? 0) >= Number(model.examples ?? 0)) continue;
    sources.set(row.ownKey, {
      ownKey: row.ownKey,
      modelPath: row.path,
      files,
      examples: Number(model.examples ?? 0),
      selectedExamples: Number(model.selectedExamples ?? 0),
      pairwiseExamples: Number(model.pairwiseExamples ?? 0),
      learningMode: model.learningMode ?? null
    });
  }
  return sources;
}

function emptyCardEvidenceProfile({
  sourceMode = "unknown",
  modelPath = null,
  modelExamples = null,
  selectedExamples = null,
  pairwiseExamples = null,
  learningMode = null,
  modelSourceFiles = 0
} = {}) {
  return {
    sourceMode,
    modelPath,
    modelExamples,
    selectedExamples,
    pairwiseExamples,
    learningMode,
    modelSourceFiles,
    scannedRows: 0,
    files: 0,
    sourceFiles: [],
    missingFiles: 0,
    skippedLargeFiles: 0,
    capped: false,
    chosenRows: 0,
    uncardedRows: 0,
    cards: new Map()
  };
}

function processCardEvidenceRow(profile, row) {
  if (row?.schema !== "union-arena-local-engine/pilot-decision@1") return;
  if (row.player !== "P1" || row.chosen !== true) return;
  profile.chosenRows += 1;
  const cardId = row.action?.cardId ?? row.action?.sourceCardId ?? null;
  if (!cardId) {
    profile.uncardedRows += 1;
    return;
  }
  const key = cardEvidenceKey(cardId);
  const card = profile.cards.get(key) ?? {
    key,
    cardId,
    decisions: 0,
    wins: 0,
    losses: 0,
    incomplete: 0,
    shapedRewardTotal: 0,
    lifeDiffTotal: 0,
    turnCyclesTotal: 0,
    actionTypes: new Map(),
    destinations: new Map(),
    matchups: new Map(),
    matchupEvidence: new Map()
  };
  card.decisions += 1;
  if (row.outcome === "win") card.wins += 1;
  else if (row.outcome === "loss") card.losses += 1;
  else card.incomplete += 1;
  card.shapedRewardTotal += Number(row.shapedReward ?? row.reward ?? 0);
  card.lifeDiffTotal += Number(row.finalLifeDiffForPlayer ?? 0);
  card.turnCyclesTotal += Number(row.finalTurnCycles ?? 0);
  incrementMap(card.actionTypes, cardEvidenceActionLabel(row.action));
  if (row.action?.destination) incrementMap(card.destinations, row.action.destination);
  if (row.matchupProfileKey && row.matchupProfileKey !== "unknown") {
    incrementMap(card.matchups, row.matchupProfileKey);
    addCardMatchupEvidence(card.matchupEvidence, row.matchupProfileKey, row);
  }
  profile.cards.set(key, card);
}

function finalizeCardEvidenceProfile(profile) {
  const cards = [...profile.cards.values()]
    .map((card) => {
      const total = Math.max(1, card.decisions);
      return {
        key: card.key,
        cardId: card.cardId,
        decisions: card.decisions,
        wins: card.wins,
        losses: card.losses,
        incomplete: card.incomplete,
        winRate: card.wins / total,
        avgShapedReward: card.shapedRewardTotal / total,
        avgLifeDiff: card.lifeDiffTotal / total,
        avgTurnCycles: card.turnCyclesTotal / total,
        actionTypes: sortedMapEntries(card.actionTypes),
        destinations: topMapEntries(card.destinations, 3),
        matchups: topMapEntries(card.matchups, 5),
        matchupEvidence: [...card.matchupEvidence.values()]
          .map((bucket) => {
            const matchupTotal = Math.max(1, bucket.decisions);
            return {
              key: bucket.key,
              decisions: bucket.decisions,
              wins: bucket.wins,
              losses: bucket.losses,
              incomplete: bucket.incomplete,
              winRate: bucket.wins / matchupTotal,
              avgShapedReward: bucket.shapedRewardTotal / matchupTotal,
              avgLifeDiff: bucket.lifeDiffTotal / matchupTotal,
              avgTurnCycles: bucket.turnCyclesTotal / matchupTotal,
              actionTypes: sortedMapEntries(bucket.actionTypes)
            };
          })
          .sort((a, b) => Number(b.decisions) - Number(a.decisions) || String(a.key).localeCompare(String(b.key)))
      };
    })
    .sort((a, b) => b.decisions - a.decisions || a.cardId.localeCompare(b.cardId));
  return {
    sourceMode: profile.sourceMode,
    modelPath: profile.modelPath,
    modelExamples: profile.modelExamples,
    selectedExamples: profile.selectedExamples,
    pairwiseExamples: profile.pairwiseExamples,
    learningMode: profile.learningMode,
    modelSourceFiles: profile.modelSourceFiles,
    scannedRows: profile.scannedRows,
    files: profile.files,
    sourceFiles: profile.sourceFiles.slice(0, 12),
    missingFiles: profile.missingFiles,
    skippedLargeFiles: profile.skippedLargeFiles,
    capped: profile.capped,
    chosenRows: profile.chosenRows,
    uncardedRows: profile.uncardedRows,
    cardLinkedRows: cards.reduce((total, card) => total + card.decisions, 0),
    cards
  };
}

function currentDeckCardEvidence(deck, evidence) {
  const deckCards = deck?.deckShape?.cards ?? [];
  const cardByKey = new Map(deckCards.flatMap((card) => [
    [cardEvidenceKey(card.id ?? card.number), card],
    [cardEvidenceKey(card.number ?? card.id), card]
  ]));
  if (!evidence) {
    return {
      sourceMode: null,
      modelPath: null,
      modelExamples: 0,
      selectedExamples: 0,
      pairwiseExamples: 0,
      learningMode: null,
      modelSourceFiles: 0,
      scannedRows: 0,
      files: 0,
      sourceFiles: [],
      missingFiles: 0,
      skippedLargeFiles: 0,
      capped: false,
      chosenRows: 0,
      uncardedRows: 0,
      cardLinkedRows: 0,
      outOfDeckRows: 0,
      cards: []
    };
  }
  let outOfDeckRows = 0;
  const cards = [];
  for (const row of evidence.cards ?? []) {
    const deckCard = cardByKey.get(cardEvidenceKey(row.cardId));
    if (!deckCard) {
      outOfDeckRows += Number(row.decisions ?? 0);
      continue;
    }
    cards.push({
      ...row,
      name: deckCard.name ?? row.cardId,
      number: deckCard.number ?? row.cardId,
      count: deckCard.count ?? 0,
      type: deckCard.type ?? null,
      requiredEnergy: deckCard.requiredEnergy,
      triggerType: deckCard.triggerType ?? null
    });
  }
  return {
    sourceMode: evidence.sourceMode ?? null,
    modelPath: evidence.modelPath ?? null,
    modelExamples: Number(evidence.modelExamples ?? 0),
    selectedExamples: Number(evidence.selectedExamples ?? 0),
    pairwiseExamples: Number(evidence.pairwiseExamples ?? 0),
    learningMode: evidence.learningMode ?? null,
    modelSourceFiles: Number(evidence.modelSourceFiles ?? 0),
    scannedRows: Number(evidence.scannedRows ?? 0),
    files: evidence.files,
    sourceFiles: evidence.sourceFiles ?? [],
    missingFiles: Number(evidence.missingFiles ?? 0),
    skippedLargeFiles: Number(evidence.skippedLargeFiles ?? 0),
    capped: Boolean(evidence.capped),
    chosenRows: evidence.chosenRows,
    uncardedRows: evidence.uncardedRows,
    cardLinkedRows: cards.reduce((total, card) => total + Number(card.decisions ?? 0), 0),
    outOfDeckRows,
    cards
  };
}

function deckCardEvidenceNotes(evidence) {
  if (!evidence || Number(evidence.cardLinkedRows ?? 0) === 0) {
    return ["No current-list card evidence yet; run with decision logging to populate card behavior notes."];
  }
  const notes = [];
  const pairwiseText = Number(evidence.pairwiseExamples ?? 0) > 0
    ? `, including ${formatCount(evidence.pairwiseExamples)} pairwise comparison(s)`
    : "";
  const modelContext = Number(evidence.modelExamples ?? 0) > 0
    ? ` The profile ML model has ${formatCount(evidence.modelExamples)} total action example(s)${pairwiseText}; ${formatCount(evidence.chosenRows)} chosen card-linkable decision(s) were scanned for this card evidence.`
    : "";
  notes.push(`Card evidence: ${formatCount(evidence.cardLinkedRows)} chosen current-list card-linked decisions across ${formatCount(evidence.cards.length)} current-list cards from ${formatCount(evidence.files)} log file(s).${modelContext}`);
  if (Number(evidence.uncardedRows ?? 0) > 0) {
    notes.push(`${formatCount(evidence.uncardedRows)} chosen decision(s) had no direct card id, so they inform ML but not card pros/cons.`);
  }
  if (Number(evidence.outOfDeckRows ?? 0) > 0) {
    notes.push(`Ignored ${formatCount(evidence.outOfDeckRows)} card-linked decision(s) from older or different lists in this policy profile.`);
  }
  if (evidence.capped) {
    notes.push("Card evidence is capped by dashboard scan limits; raise --card-evidence-max-rows if this profile grows beyond the current window.");
  }
  const topUsed = evidence.cards
    .filter((card) => Number(card.decisions) >= 5)
    .sort((a, b) => b.decisions - a.decisions)
    .slice(0, 3);
  if (topUsed.length > 0) {
    notes.push(`Most-used cards in pilot decisions: ${topUsed.map((card) => `${card.name} (${formatCount(card.decisions)})`).join(", ")}.`);
  }
  const positive = evidence.cards
    .filter((card) => Number(card.decisions) >= 8)
    .sort((a, b) => Number(b.avgShapedReward) - Number(a.avgShapedReward))
    .slice(0, 2);
  if (positive.length > 0) {
    notes.push(`Best outcome association: ${positive.map((card) => `${card.name} ${signedNumber(card.avgShapedReward)}`).join(", ")} avg reward.`);
  }
  const negative = evidence.cards
    .filter((card) => Number(card.decisions) >= 8)
    .sort((a, b) => Number(a.avgShapedReward) - Number(b.avgShapedReward))
    .slice(0, 2);
  if (negative.length > 0) {
    notes.push(`Worst outcome association to investigate: ${negative.map((card) => `${card.name} ${signedNumber(card.avgShapedReward)}`).join(", ")} avg reward.`);
  }
  notes.push("These are pilot-decision associations, not proof that a card should be cut or added.");
  return notes;
}

function decisionLogFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  const queue = [root];
  while (queue.length > 0 && files.length < CARD_EVIDENCE_MAX_FILES * 4) {
    const dir = queue.shift();
    const direct = join(dir, "decision-log.jsonl");
    const stats = safeStat(direct);
    if (stats?.isFile()) files.push({ path: direct, dir, size: stats.size, updatedAt: stats.mtime.toISOString() });
    for (const entry of safeReadDir(dir)) {
      if (entry.isDirectory()) queue.push(join(dir, entry.name));
    }
  }
  return files;
}

function readJsonlRows(path, limit) {
  if (!existsSync(path) || limit <= 0) return [];
  const rows = [];
  const lines = readFileSync(path, "utf8").split(/\r?\n/u);
  for (const line of lines) {
    if (rows.length >= limit) break;
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // Ignore partial or corrupt JSONL lines; the rest of the file may still be useful.
    }
  }
  return rows;
}

function safeReadDir(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function cardEvidenceKey(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function cardEvidenceActionLabel(action = {}) {
  if (action.type === "playCard" && action.destination) return `play to ${action.destination.replace(/Line$/u, "")}`;
  if (action.type === "performRaid") return "raid";
  if (action.type === "declareAttack") return action.targetType === "character" ? "snipe attack" : "attack";
  if (action.type === "declareBlock") return "block";
  if (action.type === "activateMainAbility") return "active main";
  return action.type ?? "unknown";
}

function incrementMap(map, key) {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + 1);
}

function topMapEntries(map, limit) {
  return sortedMapEntries(map).slice(0, limit);
}

function sortedMapEntries(map) {
  return [...map.entries()]
    .sort((a, b) => Number(b[1]) - Number(a[1]) || String(a[0]).localeCompare(String(b[0])))
    .map(([key, count]) => ({ key, count }));
}

function addCardMatchupEvidence(map, matchupKey, row) {
  const key = String(matchupKey ?? "unknown");
  if (!key || key === "unknown") return;
  const bucket = map.get(key) ?? {
    key,
    decisions: 0,
    wins: 0,
    losses: 0,
    incomplete: 0,
    shapedRewardTotal: 0,
    lifeDiffTotal: 0,
    turnCyclesTotal: 0,
    actionTypes: new Map()
  };
  bucket.decisions += 1;
  if (row.outcome === "win") bucket.wins += 1;
  else if (row.outcome === "loss") bucket.losses += 1;
  else bucket.incomplete += 1;
  bucket.shapedRewardTotal += Number(row.shapedReward ?? row.reward ?? 0);
  bucket.lifeDiffTotal += Number(row.finalLifeDiffForPlayer ?? 0);
  bucket.turnCyclesTotal += Number(row.finalTurnCycles ?? 0);
  incrementMap(bucket.actionTypes, cardEvidenceActionLabel(row.action));
  map.set(key, bucket);
}

function runSummary(path, id, { parentId = null, childRun = false } = {}) {
  const report = readJsonIfExists(join(path, "report.json"));
  const promotion = readJsonIfExists(join(path, "policy-promotion.json"));
  const routedPromotion = readJsonIfExists(join(path, "routed-policy-promotion.json"));
  const stats = safeStat(path);
  const childDeckIds = [...new Set((report?.config?.childDecks ?? [])
    .map((deck) => deck.id)
    .filter(Boolean))];
  const multiDeckSuite = !childRun && report?.mode === "parallel-train" && childDeckIds.length > 1;
  return {
    id,
    parentId,
    childRun,
    suite: multiDeckSuite,
    path,
    updatedAt: stats?.mtime?.toISOString() ?? null,
    complete: Boolean(report),
    deckId: multiDeckSuite ? null : report?.deck?.id ?? report?.config?.policySelection?.profile?.deckId ?? null,
    ownKey: multiDeckSuite ? null : reportOwnKey(report),
    mode: report?.mode ?? null,
    selectedPolicy: report?.bestPolicy?.name ?? null,
    result: report?.result ? summaryResult(report.result) : null,
    baseline: report?.baselineSummary ? summaryResult(report.baselineSummary) : null,
    avgTurnCycles: numberOrNull(report?.analysis?.summary?.avgTurnCycles ?? report?.result?.avgTurnCycles),
    games: Number(report?.analysis?.summary?.total ?? report?.result?.total ?? 0),
    promotion: promotion ? {
      promote: promotion.promote === true,
      reason: promotion.reason ?? null
    } : null,
    routedPromotion: routedPromotion ? {
      promote: routedPromotion.promote === true,
      reason: routedPromotion.reason ?? null
    } : null
  };
}

function recentKnowledgeUpdates(limit) {
  const root = join(AGENT_ROOT, "knowledge-updates");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const path = join(root, entry.name);
      const manifest = readJsonIfExists(join(path, "knowledge-update.json"));
      const stats = safeStat(path);
      return {
        id: entry.name,
        path,
        updatedAt: stats?.mtime?.toISOString() ?? null,
        ownKey: manifest?.ownKey ?? null,
        decisionFiles: manifest?.decisionFiles?.length ?? 0,
        chosenRows: Number(manifest?.decisions?.chosenRows ?? 0),
        overlays: Array.isArray(manifest?.overlays) ? manifest.overlays.filter((overlay) => !overlay.candidate).length : 0,
        overlayCandidates: Array.isArray(manifest?.overlays) ? manifest.overlays.filter((overlay) => overlay.candidate).length : 0,
        overlayChanges: manifest?.overlayChanges ?? null,
        modelExamples: Number(manifest?.mlModel?.examples ?? 0),
        modelFeatures: Number(manifest?.mlModel?.features ?? 0),
        learningHealth: manifest?.learningHealth ?? null
      };
    })
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, limit);
}

function matchupOverlays() {
  const keys = new Set(allSavedDecks().map((deck) => deck.ownKey).filter(Boolean));
  const organizedRoot = join(BASELINE_ROOT, "decks");
  if (existsSync(organizedRoot)) {
    for (const entry of readdirSync(organizedRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) keys.add(entry.name);
    }
  }
  const legacyDir = join(POLICY_DIR, "matchups");
  if (existsSync(legacyDir)) {
    for (const entry of readdirSync(legacyDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const match = entry.name.match(/^(.+)-vs-.+\.json$/u);
      if (match) keys.add(match[1]);
    }
  }

  const rows = [];
  const seen = new Set();
  for (const ownKey of [...keys].sort((a, b) => a.localeCompare(b))) {
    const files = [
      ...matchupOverlayFilesForKey(ownKey, { policyDir: POLICY_DIR, baselineRoot: BASELINE_ROOT }),
      ...matchupOverlayCandidateFilesForKey(ownKey, { policyDir: POLICY_DIR, baselineRoot: BASELINE_ROOT })
    ];
    for (const file of files) {
      const overlay = readJsonIfExists(file.path);
      const rowOwnKey = overlay?.ownKey ?? file.ownKey ?? ownKey;
      const opponentKey = overlay?.opponentKey ?? file.opponentKey ?? "unknown";
      const candidate = file.layout === "candidate";
      const key = `${rowOwnKey}||${opponentKey}${candidate ? "||candidate" : ""}`;
      if (seen.has(key) && file.layout === "legacy") continue;
      seen.add(key);
      const stats = safeStat(file.path);
      const readiness = matchupOverlayReadiness(overlay, { requireImpactValidation: !candidate });
      rows.push({
        id: `${rowOwnKey}-vs-${opponentKey}${candidate ? "-candidate" : ""}`,
        file: file.path.split(/[\\/]/u).at(-1),
        path: file.path,
        layout: file.layout,
        ownKey: rowOwnKey,
        opponentKey,
        candidate,
        examples: Number(overlay?.examples ?? 0),
        pairwiseExamples: Number(overlay?.pairwiseExamples ?? 0),
        pairwiseEffectiveWeight: Number(overlay?.pairwiseEffectiveWeight ?? 0),
        evidenceDiversity: readiness.evidenceDiversity,
        sourceDigestVersion: Number(overlay?.sourceDigestVersion ?? 0),
        learningEvidenceFilterVersion: Number(overlay?.learningEvidenceFilterVersion ?? 0),
        regressionVersion: Number(overlay?.regressionVersion ?? 1),
        features: Object.keys(overlay?.weights ?? {}).length,
        averageTarget: numberOrNull(overlay?.averageTarget),
        runtimeTrust: candidate ? 0 : matchupOverlayRuntimeTrust(overlay ?? {}),
        runtimeActive: !candidate && matchupOverlayRuntimeTrust(overlay ?? {}) > 0,
        readinessStatus: candidate && overlay?.matchupCandidate?.status ? overlay.matchupCandidate.status : readiness.status,
        readinessReason: candidate && overlay?.matchupCandidate?.reason ? overlay.matchupCandidate.reason : readiness.reason,
        readinessBlockers: readiness.blockers,
        impactValidation: overlay?.impactValidation ?? null,
        trainedAt: overlay?.trainedAt ?? null,
        updatedAt: stats?.mtime?.toISOString() ?? null
      });
    }
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id) || a.layout.localeCompare(b.layout));
}

function summaryResult(result) {
  return {
    wins: Number(result.wins ?? 0),
    losses: Number(result.losses ?? 0),
    incomplete: Number(result.incomplete ?? 0),
    winRate: Number(result.winRate ?? 0),
    scoreVersion: Number(result.scoreVersion ?? 1),
    score: numberOrNull(result.score),
    avgLifeDiff: numberOrNull(result.avgLifeDiff)
  };
}

function controllerState() {
  const state = readJsonIfExists(STATE_PATH);
  return state ?? {
    running: false,
    pid: null,
    startedAt: null,
    endedAt: null,
    exitCode: null,
    signal: null,
    command: null,
    config: null,
    logPath: LOG_PATH
  };
}

function lightweightControllerState() {
  const state = controllerState();
  return {
    running: Boolean(state.running),
    pid: state.pid ?? null,
    startedAt: state.startedAt ?? null,
    endedAt: state.endedAt ?? null,
    exitCode: state.exitCode ?? null,
    signal: state.signal ?? null,
    kind: state.config?.kind ?? state.config?.trainingMode ?? null,
    deck: state.config?.deck ?? null,
    session: state.config?.session ?? null
  };
}

function dashboardPrefs() {
  const prefs = readJsonIfExists(PREFS_PATH) ?? {};
  const nextSeed = Number(prefs.nextSeed);
  return {
    nextSeed: Number.isFinite(nextSeed) ? nextSeed : 1,
    lastSeed: numberOrNull(prefs.lastSeed),
    seedStep: 1,
    updatedAt: prefs.updatedAt ?? null,
    lastContext: prefs.lastContext ?? null
  };
}

function writeDashboardPrefs(prefs) {
  mkdirSync(DASHBOARD_DIR, { recursive: true });
  writeJsonAtomicSync(PREFS_PATH, prefs);
}

function advanceDashboardSeed(seed, context = {}) {
  const usedSeed = Number(seed);
  const current = dashboardPrefs();
  if (!Number.isFinite(usedSeed)) return current;
  const next = {
    ...current,
    lastSeed: usedSeed,
    nextSeed: usedSeed + 1,
    seedStep: 1,
    updatedAt: new Date().toISOString(),
    lastContext: context
  };
  writeDashboardPrefs(next);
  return next;
}

function loopHealth(controller) {
  const session = controller?.config?.session ?? null;
  const kind = controller?.config?.kind ?? "loop";
  const loopStatePath = session
    ? kind === "auto-refiner"
      ? join(AGENT_ROOT, "auto-refiner", session, "auto-refiner-state.json")
      : join(AGENT_ROOT, "loops", session, "loop-state.json")
    : null;
  const loopState = loopStatePath ? readJsonIfExists(loopStatePath) : null;
  const alive = Boolean(controller?.running && controller?.pid && isProcessAlive(controller.pid));
  const staleControllerMetadata = Boolean(session && loopStatePath && !loopState && !alive && !controller?.running);
  const rawCurrentCycle = loopState?.currentCycle ?? loopState?.currentJob ?? null;
  const logInfo = loopLogHealth();
  const autoRefinerRoot = kind === "auto-refiner" && loopStatePath ? dirname(loopStatePath) : null;
  const failure = latestFailureArtifact(rawCurrentCycle?.runDir ?? controller?.config?.outDir ?? null)
    ?? latestAutoRefinerFailure(autoRefinerRoot);
  const childHealth = parallelChildHealth(rawCurrentCycle?.runDir ?? null);
  const lastMatchupImpact = latestLoopMatchupImpact(loopState, { kind, autoRefinerRoot });
  const lastLearningHealth = latestLoopLearningHealth(loopState, { kind });
  const status = failure
    ? "failed"
    : childHealth?.stale > 0
      ? "stale"
    : alive && logInfo.stale
      ? "stale"
      : alive
        ? "running"
        : loopState?.stopReason
          ? "stopped"
          : controller?.running
            ? "lost"
            : "idle";
  const currentCycle = displayedCurrentCycle(rawCurrentCycle, {
    alive,
    controllerEnded: Boolean(controller?.endedAt),
    status
  });
  const notes = [];
  if (alive) notes.push(`Process ${controller.pid} is alive.`);
  const resourcePlan = controller?.config?.resourcePlan;
  if (resourcePlan) {
    const suiteText = Number(resourcePlan.suiteConcurrency ?? 1) > 1
      ? ` across ${resourcePlan.suiteConcurrency} concurrent deck jobs`
      : " on one deck job at a time";
    notes.push(`CPU plan: ${resourcePlan.parallelConcurrency}/${resourcePlan.workerBudget} active worker slots, ${resourcePlan.parallelRuns} search runs${suiteText} (${resourcePlan.logicalProcessors} logical processors).`);
  }
  if (currentCycle?.cycle) notes.push(`Cycle ${currentCycle.cycle} is ${currentCycle.status}.`);
  if (currentCycle?.job) notes.push(`Job ${currentCycle.job} (${currentCycle.taskType ?? "task"}) is ${currentCycle.status}.`);
  if (childHealth?.total > 0) {
    notes.push(`Parallel children: ${childHealth.completed}/${childHealth.total} complete, ${childHealth.running} running, ${childHealth.empty} empty, ${childHealth.stale} stale.`);
    const staleRows = childHealth.rows.filter((row) => row.stale).slice(0, 3);
    for (const row of staleRows) notes.push(`Stale child ${row.name}: ${row.reason}`);
  }
  if (logInfo.lastLine) notes.push(`Latest log line: ${logInfo.lastLine}`);
  if (logInfo.stale) notes.push(`No fresh dashboard log line in ${Math.round(logInfo.ageMs / 60000)} minute(s).`);
  if (loopState?.stopReason?.reason) notes.push(loopState.stopReason.reason);
  if (failure) notes.push(`${failure.file} exists: ${failure.message}`);
  if (lastMatchupImpact?.summary?.updates > 0) {
    notes.push(`Last matchup impact: ${lastMatchupImpact.summary.positive} positive, ${lastMatchupImpact.summary.negative} negative, ${lastMatchupImpact.summary.inconclusive} inconclusive, ${lastMatchupImpact.summary.rolledBack ?? 0} rolled back.`);
  }
  if (lastLearningHealth?.status === "blocked") {
    notes.push(`Learning health blocked in ${lastLearningHealth.title}: ${lastLearningHealth.blocked} blocked update(s). ${lastLearningHealth.firstBlocker ?? ""}`.trim());
  } else if (lastLearningHealth?.status === "watch") {
    notes.push(`Learning health is on watch in ${lastLearningHealth.title}: ${lastLearningHealth.watch} watch update(s). ${lastLearningHealth.firstWarning ?? ""}`.trim());
  } else if (lastLearningHealth?.updates > 0) {
    notes.push(`Learning health latest: ${lastLearningHealth.healthy} healthy, ${lastLearningHealth.watch} watch, ${lastLearningHealth.blocked} blocked.`);
  }
  return {
    status,
    label: loopHealthLabel(status),
    alive,
    pid: staleControllerMetadata ? null : controller?.pid ?? null,
    session: staleControllerMetadata ? null : session,
    startedAt: staleControllerMetadata ? null : controller?.startedAt ?? null,
    endedAt: staleControllerMetadata ? null : controller?.endedAt ?? null,
    currentCycle,
    stopReason: loopState?.stopReason ?? controller?.stopReason ?? null,
    loopStatePath: staleControllerMetadata ? null : loopStatePath,
    latestHandoffPath: !staleControllerMetadata && session && kind !== "auto-refiner" ? join(AGENT_ROOT, "loops", session, "latest-handoff.md") : null,
    log: logInfo,
    failure,
    childHealth,
    lastMatchupImpact,
    lastLearningHealth,
    notes: uniqueStrings(notes).slice(0, 8)
  };
}

function parallelChildHealth(runDir) {
  if (!runDir) return null;
  const childRoot = join(runDir, "runs");
  if (!existsSync(childRoot)) return null;
  const now = Date.now();
  const rows = readdirSync(childRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^run-\d+$/u.test(entry.name))
    .map((entry) => {
      const dir = join(childRoot, entry.name);
      const status = readJsonIfExists(join(dir, "child-status.json"));
      const reportExists = existsSync(join(dir, "report.json"));
      const failureExists = existsSync(join(dir, "failure.json"));
      const dirStats = safeStat(dir);
      const updatedAt = status?.updatedAt ?? dirStats?.mtime?.toISOString() ?? null;
      const lastActivityAt = status?.lastActivityAt ?? updatedAt;
      const staleMinutes = Number(status?.staleMinutes ?? 20);
      const ageMs = lastActivityAt ? now - new Date(lastActivityAt).getTime() : Infinity;
      const empty = !reportExists && !failureExists && !status;
      const statusText = reportExists ? "complete" : failureExists ? "failed" : status?.status ?? (empty ? "empty" : "unknown");
      const stale = !reportExists && !failureExists && (
        (statusText === "running" && staleMinutes > 0 && ageMs > staleMinutes * 60_000)
        || (empty && ageMs > 10 * 60_000)
      );
      return {
        name: entry.name,
        path: dir,
        status: statusText,
        reportExists,
        failureExists,
        empty,
        stale,
        ageMinutes: Number.isFinite(ageMs) ? Math.round(ageMs / 60000) : null,
        reason: stale
          ? empty
            ? `no files written for ${Number.isFinite(ageMs) ? Math.round(ageMs / 60000) : "unknown"} minute(s)`
            : `no child activity for ${Number.isFinite(ageMs) ? Math.round(ageMs / 60000) : "unknown"} minute(s)`
          : null,
        killedReason: status?.killedReason ?? null,
        exitCode: status?.exitCode ?? null,
        pid: status?.pid ?? null,
        updatedAt,
        lastActivityAt
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  if (rows.length === 0) return null;
  return {
    total: rows.length,
    completed: rows.filter((row) => row.reportExists).length,
    failed: rows.filter((row) => row.failureExists || row.status === "failed").length,
    running: rows.filter((row) => row.status === "running").length,
    empty: rows.filter((row) => row.empty).length,
    stale: rows.filter((row) => row.stale).length,
    rows
  };
}

function latestLoopLearningHealth(loopState, { kind } = {}) {
  if (!loopState) return null;
  if (kind === "auto-refiner") return latestAutoRefinerLearningHealth(loopState);
  return latestCycleLearningHealth(loopState);
}

function latestAutoRefinerLearningHealth(loopState) {
  const jobs = Array.isArray(loopState?.jobs) ? loopState.jobs : [];
  for (let index = jobs.length - 1; index >= 0; index -= 1) {
    const job = jobs[index];
    const health = job?.learningProgress?.health ?? null;
    const summary = normalizeLearningHealthSummary(health);
    if (!summary || summary.updates <= 0) continue;
    return {
      source: "auto-refiner",
      title: `job ${job.job ?? "-"}${job.deckName ? ` / ${job.deckName}` : ""}`,
      job: job.job ?? null,
      deckId: job.deckId ?? null,
      deckName: job.deckName ?? null,
      ownKey: job.ownKey ?? null,
      updatedAt: job.endedAt ?? job.startedAt ?? null,
      ...summary
    };
  }
  return null;
}

function latestCycleLearningHealth(loopState) {
  const cycles = Array.isArray(loopState?.cycles) ? loopState.cycles : [];
  for (let index = cycles.length - 1; index >= 0; index -= 1) {
    const cycle = cycles[index];
    const raw = cycle?.knowledgeSummary?.learningHealth ?? null;
    const summary = normalizeLearningHealthSummary(raw);
    if (!summary || summary.updates <= 0) continue;
    return {
      source: "loop",
      title: `cycle ${cycle.cycle ?? "-"}`,
      cycle: cycle.cycle ?? null,
      updatedAt: cycle.knowledgeResult?.endedAt ?? cycle.trainResult?.endedAt ?? null,
      ...summary
    };
  }
  return null;
}

function normalizeLearningHealthSummary(raw) {
  if (!raw) return null;
  if (Array.isArray(raw.rows) || raw.healthy !== undefined || raw.watch !== undefined || raw.blocked !== undefined) {
    const rows = Array.isArray(raw.rows) ? raw.rows : [];
    const blocked = Number(raw.blocked ?? rows.filter((row) => row.status === "blocked").length ?? 0);
    const watch = Number(raw.watch ?? rows.filter((row) => row.status === "watch").length ?? 0);
    const healthy = Number(raw.healthy ?? rows.filter((row) => row.status === "healthy").length ?? 0);
    const unknown = Number(raw.unknown ?? rows.filter((row) => !["healthy", "watch", "blocked"].includes(String(row.status))).length ?? 0);
    return learningHealthSummaryFromCounts({ blocked, watch, healthy, unknown, rows });
  }
  const status = String(raw.status ?? "unknown").toLowerCase();
  const rows = [{
    status,
    label: raw.label ?? status,
    blockers: Array.isArray(raw.blockers) ? raw.blockers : [],
    warnings: Array.isArray(raw.warnings) ? raw.warnings : []
  }];
  return learningHealthSummaryFromCounts({
    blocked: status === "blocked" ? 1 : 0,
    watch: status === "watch" ? 1 : 0,
    healthy: status === "healthy" ? 1 : 0,
    unknown: ["blocked", "watch", "healthy"].includes(status) ? 0 : 1,
    rows
  });
}

function learningHealthSummaryFromCounts({ blocked, watch, healthy, unknown, rows }) {
  const status = blocked > 0 ? "blocked" : watch > 0 ? "watch" : healthy > 0 ? "healthy" : "unknown";
  const blockedRow = rows.find((row) => row.status === "blocked");
  const watchRow = rows.find((row) => row.status === "watch");
  return {
    status,
    label: status === "blocked" ? "Blocked" : status === "watch" ? "Watch" : status === "healthy" ? "Healthy" : "Unknown",
    updates: blocked + watch + healthy + unknown,
    blocked,
    watch,
    healthy,
    unknown,
    firstBlocker: blockedRow?.blockers?.[0] ?? "",
    firstWarning: watchRow?.warnings?.[0] ?? "",
    rows
  };
}

function displayedCurrentCycle(currentCycle, { alive, controllerEnded, status } = {}) {
  if (!currentCycle) return null;
  const cycleStatus = String(currentCycle.status ?? "").toLowerCase();
  const looksRunning = !cycleStatus || ["running", "started", "in-progress", "in_progress"].includes(cycleStatus);
  if (alive || !looksRunning) return currentCycle;
  return {
    ...currentCycle,
    status: controllerEnded || status === "idle" ? "interrupted" : "not running"
  };
}

function loopLogHealth() {
  const stats = safeStat(LOG_PATH);
  const tail = tailFile(LOG_PATH, 40).split(/\r?\n/u).filter(Boolean);
  const lastLine = tail.at(-1) ?? "";
  const ageMs = stats ? Date.now() - stats.mtime.getTime() : Infinity;
  return {
    path: LOG_PATH,
    exists: Boolean(stats),
    updatedAt: stats?.mtime?.toISOString() ?? null,
    ageMs,
    stale: Boolean(stats) && ageMs > 10 * 60 * 1000,
    lastLine
  };
}

function latestFailureArtifact(runDir) {
  if (!runDir || !existsSync(runDir)) return null;
  const names = [
    "failure.json",
    "report-write-error.json",
    "report.json.write-error.json",
    "decision-log.jsonl.write-error.json",
    "games.csv.write-error.json",
    "rankings.csv.write-error.json"
  ];
  const failures = names
    .map((name) => {
      const path = join(runDir, name);
      const data = readJsonIfExists(path);
      const stats = safeStat(path);
      return data || stats ? {
        file: name,
        path,
        updatedAt: stats?.mtime?.toISOString() ?? null,
        message: data?.message ?? data?.writeFailure?.message ?? "failure artifact written"
      } : null;
    })
    .filter(Boolean);
  return failures.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0] ?? null;
}

function latestAutoRefinerFailure(root) {
  if (!root || !existsSync(root)) return null;
  const failures = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^failed-job-.*\.json$/u.test(entry.name))
    .map((entry) => {
      const path = join(root, entry.name);
      const data = readJsonIfExists(path);
      const stats = safeStat(path);
      return {
        file: entry.name,
        path,
        updatedAt: stats?.mtime?.toISOString() ?? null,
        message: data?.message ?? `Auto-refiner failed job artifact written (${data?.taskType ?? "task"}, status ${data?.status ?? "unknown"})`
      };
    });
  return failures.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0] ?? null;
}

function latestLoopMatchupImpact(loopState, { kind, autoRefinerRoot } = {}) {
  if (!loopState) return null;
  if (kind === "auto-refiner") return latestAutoRefinerMatchupImpact(loopState, autoRefinerRoot);
  return latestCycleMatchupImpact(loopState);
}

function latestAutoRefinerMatchupImpact(loopState, autoRefinerRoot) {
  const jobs = Array.isArray(loopState?.jobs) ? loopState.jobs : [];
  for (let index = jobs.length - 1; index >= 0; index -= 1) {
    const job = jobs[index];
    const validation = job?.matchupValidation ?? null;
    const rollback = job?.matchupValidationRollback ?? null;
    const rows = Array.isArray(validation?.rows) ? validation.rows : [];
    if (Number(validation?.updates ?? 0) <= 0 && rows.length === 0) continue;
    return {
      source: "auto-refiner",
      title: `${job.deckName ?? job.deckId ?? "Deck"} matchup impact`,
      subtitle: `Job ${job.job ?? "-"}${job.stage ? ` / ${job.stage}` : ""}${job.taskType ? ` / ${job.taskType}` : ""}`,
      deckId: job.deckId ?? null,
      deckName: job.deckName ?? null,
      ownKey: job.ownKey ?? null,
      job: job.job ?? null,
      stage: job.stage ?? null,
      taskType: job.taskType ?? null,
      updatedAt: job.endedAt ?? job.startedAt ?? null,
      path: autoRefinerRoot ? join(autoRefinerRoot, "auto-refiner-state.json") : null,
      summary: normalizeMatchupImpactSummary(validation, rollback),
      rows: normalizeMatchupImpactRows(rows, rollback?.rows)
    };
  }
  return null;
}

function latestCycleMatchupImpact(loopState) {
  const cycles = Array.isArray(loopState?.cycles) ? loopState.cycles : [];
  for (let index = cycles.length - 1; index >= 0; index -= 1) {
    const cycle = cycles[index];
    const validation = cycle?.matchupValidationSummary ?? null;
    if (!validation) continue;
    const detail = validation.path ? readJsonIfExists(validation.path) : null;
    const opponents = Array.isArray(detail?.opponents)
      ? detail.opponents.map((opponent) => opponent.name ?? opponent.id ?? opponent.ownKey).filter(Boolean)
      : [];
    return {
      source: "loop",
      title: `Cycle ${cycle.cycle ?? "-"} matchup impact`,
      subtitle: cycle.trainingMode ? `${cycle.trainingMode}${cycle.trainingFocus ? ` / ${cycle.trainingFocus}` : ""}` : "pilot loop",
      deckId: detail?.deck?.id ?? null,
      deckName: detail?.deck?.name ?? null,
      ownKey: detail?.deck?.ownKey ?? null,
      cycle: cycle.cycle ?? null,
      updatedAt: cycle.matchupValidationResult?.endedAt ?? cycle.knowledgeResult?.endedAt ?? cycle.trainResult?.endedAt ?? null,
      path: validation.path ?? null,
      summary: normalizeMatchupImpactSummary({
        updates: 1,
        positive: validation.verdict === "positive" ? 1 : 0,
        negative: validation.verdict === "negative" ? 1 : 0,
        safeNoRuntimeChange: validation.verdict === "safe-no-runtime-change" ? 1 : 0,
        inconclusive: !["positive", "negative", "safe-no-runtime-change"].includes(validation.verdict) ? 1 : 0,
        avgWinRateDelta: validation.winRateDelta,
        avgLifeDiffDelta: validation.avgLifeDiffDelta,
        avgScoreDelta: validation.scoreDelta
      }, cycle.matchupValidationRollback ? {
        updates: 1,
        rolledBack: cycle.matchupValidationRollback.rolledBack ? 1 : 0,
        failed: cycle.matchupValidationRollback.rolledBack ? 0 : 1,
        rows: [cycle.matchupValidationRollback]
      } : null),
      rows: normalizeMatchupImpactRows([{
        path: validation.path,
        deckId: detail?.deck?.id ?? null,
        ownKey: detail?.deck?.ownKey ?? null,
        opponents,
        games: Number(detail?.config?.games ?? validation.after?.total ?? validation.before?.total ?? 0),
        comparedArtifact: detail?.comparison?.comparedArtifact ?? validation.comparedArtifact ?? "unknown",
        verdict: validation.verdict,
        actionVerdict: detail?.comparison?.actionVerdict ?? validation.actionComparison?.verdict ?? null,
        overlayVerdict: detail?.comparison?.overlayVerdict ?? validation.overlayComparison?.verdict ?? null,
        candidateOverlayDecisionCount: Number(detail?.comparison?.candidateOverlayDecisionCount ?? validation.candidateOverlayDecisionCount ?? 0),
        minimumCandidateOverlayDecisions: Number(detail?.comparison?.minimumCandidateOverlayDecisions ?? validation.minimumCandidateOverlayDecisions ?? 0),
        winRateDelta: validation.winRateDelta,
        avgLifeDiffDelta: validation.avgLifeDiffDelta,
        scoreDelta: validation.scoreDelta
      }], cycle.matchupValidationRollback ? [cycle.matchupValidationRollback] : [])
    };
  }
  return null;
}

function normalizeMatchupImpactSummary(validation, rollback = null) {
  const rows = Array.isArray(validation?.rows) ? validation.rows : [];
  const rollbackRows = Array.isArray(rollback?.rows) ? rollback.rows : [];
  const updates = Number(validation?.updates ?? rows.length ?? 0);
  return {
    updates,
    positive: Number(validation?.positive ?? rows.filter((row) => row.verdict === "positive").length ?? 0),
    negative: Number(validation?.negative ?? rows.filter((row) => row.verdict === "negative").length ?? 0),
    safeNoRuntimeChange: Number(validation?.safeNoRuntimeChange ?? rows.filter((row) => row.verdict === "safe-no-runtime-change").length ?? 0),
    inconclusive: Number(validation?.inconclusive ?? rows.filter((row) => !["positive", "negative"].includes(row.verdict)).length ?? 0),
    rolledBack: Number(rollback?.rolledBack ?? rollbackRows.filter((row) => row.rolledBack).length ?? 0),
    rollbackFailed: Number(rollback?.failed ?? rollbackRows.filter((row) => !row.rolledBack).length ?? 0),
    avgWinRateDelta: Number(validation?.avgWinRateDelta ?? 0),
    avgLifeDiffDelta: Number(validation?.avgLifeDiffDelta ?? 0),
    avgScoreDelta: Number(validation?.avgScoreDelta ?? 0)
  };
}

function normalizeMatchupImpactRows(rows, rollbackRows = []) {
  const rollbacks = Array.isArray(rollbackRows) ? rollbackRows : [];
  return rows.map((row, index) => {
    const rollback = rollbacks[index] ?? null;
    return ({
    path: row.path ?? null,
    deckId: row.deckId ?? null,
    ownKey: row.ownKey ?? null,
    opponents: Array.isArray(row.opponents) ? row.opponents.filter(Boolean) : [],
    games: Number(row.games ?? 0),
    comparedArtifact: row.comparedArtifact ?? "unknown",
    verdict: row.verdict ?? "unknown",
    actionVerdict: row.actionVerdict ?? null,
    overlayVerdict: row.overlayVerdict ?? null,
    candidateOverlayDecisionCount: Number(row.candidateOverlayDecisionCount ?? 0),
    minimumCandidateOverlayDecisions: Number(row.minimumCandidateOverlayDecisions ?? 0),
    winRateDelta: Number(row.winRateDelta ?? 0),
    avgLifeDiffDelta: Number(row.avgLifeDiffDelta ?? 0),
    scoreDelta: Number(row.scoreDelta ?? 0),
    rolledBack: Boolean(rollback?.rolledBack),
    rollbackReason: rollback?.reason ?? ""
    });
  });
}

function loopHealthLabel(status) {
  return {
    running: "Running",
    stale: "Running, Log Stale",
    stopped: "Stopped",
    failed: "Failed",
    lost: "Process Missing",
    idle: "Idle"
  }[status] ?? "Unknown";
}

function reconcileControllerState(state) {
  if (!state.running || !state.pid) return state;
  if (isProcessAlive(state.pid)) return state;
  const next = {
    ...state,
    running: false,
    endedAt: state.endedAt ?? new Date().toISOString(),
    stopReason: state.stopReason ?? "process was not alive during dashboard state reconciliation"
  };
  writeControllerState(next);
  return next;
}

function writeControllerState(state) {
  mkdirSync(DASHBOARD_DIR, { recursive: true });
  writeJsonAtomicSync(STATE_PATH, state);
}

function isProcessAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function sendHtml(response, html) {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}

function sendJson(response, payload, status = 200) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("Request body too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`));
      }
    });
    request.on("error", reject);
  });
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readJsonFromString(text) {
  if (!String(text ?? "").trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function runtimeLog(message) {
  try {
    appendFileSync(RUNTIME_LOG_PATH, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // stdout/stderr remain the fallback if the runtime log cannot be written.
  }
}

function fileInfo(path) {
  const stats = safeStat(path);
  if (!stats) return null;
  return {
    path,
    size: stats.size,
    updatedAt: stats.mtime.toISOString(),
    hash: stats.isFile() ? fileHash(path) : null
  };
}

function safeStat(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function fileHash(path) {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function tailFile(path, lines) {
  if (!existsSync(path)) return "";
  const text = readFileSync(path, "utf8");
  return text.split(/\r?\n/u).slice(-lines).join("\n");
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function groupBy(items, keyFn) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

function average(items, valueFn) {
  if (!items || items.length === 0) return 0;
  return items.reduce((total, item) => total + Number(valueFn(item) ?? 0), 0) / items.length;
}

function text(value, fallback) {
  const string = String(value ?? "").trim();
  return string || fallback;
}

function integer(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : fallback;
}

function decimal(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeTrainingMode(value) {
  const normalized = normalizeToken(value || "deck");
  const aliases = new Map([
    ["matchups", "matchup"],
    ["matchupbased", "matchup"],
    ["matchuptraining", "matchup"],
    ["overlay", "matchup"],
    ["overlays", "matchup"],
    ["deckbased", "deck"],
    ["decktraining", "deck"],
    ["policy", "deck"],
    ["base", "deck"]
  ]);
  const mode = aliases.get(normalized) ?? normalized;
  if (!new Set(["matchup", "deck"]).has(mode)) {
    throw new Error(`Unknown training mode: ${value}. Use matchup or deck.`);
  }
  return mode;
}

function explorationConfigFromBody(body, defaults) {
  return {
    explorationMode: text(body.explorationMode, defaults.explorationMode),
    explorationRate: decimal(body.explorationRate, defaults.explorationRate),
    explorationMaxPerGame: integer(body.explorationMaxPerGame, defaults.explorationMaxPerGame),
    explorationScoreWindow: integer(body.explorationScoreWindow, defaults.explorationScoreWindow),
    explorationMaxRank: integer(body.explorationMaxRank, defaults.explorationMaxRank),
    explorationMinScore: decimal(body.explorationMinScore, defaults.explorationMinScore),
    raidNormalPlayExplorationRate: decimal(body.raidNormalPlayExplorationRate, defaults.raidNormalPlayExplorationRate),
    raidNormalPlayScoreWindow: integer(body.raidNormalPlayScoreWindow, defaults.raidNormalPlayScoreWindow),
    raidNormalPlayHeuristicWindow: integer(body.raidNormalPlayHeuristicWindow, defaults.raidNormalPlayHeuristicWindow),
    raidNormalPlayMinHeuristicScore: decimal(body.raidNormalPlayMinHeuristicScore, defaults.raidNormalPlayMinHeuristicScore),
    counterfactualExplorationRate: decimal(body.counterfactualExplorationRate, defaults.counterfactualExplorationRate),
    counterfactualMaxPerGame: integer(body.counterfactualMaxPerGame, defaults.counterfactualMaxPerGame),
    counterfactualRolloutActions: integer(body.counterfactualRolloutActions, defaults.counterfactualRolloutActions),
    counterfactualRolloutPlayerTurns: integer(
      body.counterfactualRolloutPlayerTurns,
      defaults.counterfactualRolloutPlayerTurns
    )
  };
}

function normalizeToken(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
}

function option(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function dashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Union Arena Pilot Dashboard</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f7f8;
      --panel: #ffffff;
      --line: #d9e0e4;
      --text: #1b252b;
      --muted: #5f6f78;
      --green: #22724c;
      --red: #b23a3a;
      --amber: #9a6a12;
      --blue: #246a9b;
    }
    * { box-sizing: border-box; }
    html {
      min-height: 100%;
      overflow-y: auto;
      scrollbar-gutter: stable;
      overflow-anchor: none;
    }
    body {
      margin: 0;
      font-family: "Segoe UI", Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      font-size: 14px;
      min-height: 100vh;
      overflow-x: hidden;
      overflow-anchor: none;
    }
    header {
      display: grid;
      grid-template-columns: minmax(220px, 280px) minmax(280px, 1fr) auto;
      align-items: center;
      gap: 10px;
      padding: 10px 16px;
      border-bottom: 1px solid var(--line);
      background: #ffffff;
      position: sticky;
      top: 0;
      z-index: 10;
      min-height: 64px;
    }
    h1 { font-size: 16px; margin: 0; font-weight: 700; }
    h2 { font-size: 15px; margin: 0 0 12px; }
    .header-brand {
      min-width: 0;
    }
    .header-brand .path {
      overflow-wrap: anywhere;
    }
    .current-run-strip {
      min-width: 0;
      display: grid;
      gap: 4px;
      padding: 3px 12px;
      border-inline: 1px solid var(--line);
      line-height: 1.25;
    }
    .current-run-title {
      display: grid;
      grid-template-columns: auto auto minmax(0, 1fr);
      align-items: center;
      gap: 7px;
      min-width: 0;
    }
    .current-run-label {
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }
    .current-run-name {
      min-width: 0;
      font-size: 12px;
      font-weight: 750;
      overflow-wrap: anywhere;
    }
    .current-run-badge {
      display: inline-flex;
      align-items: center;
      min-height: 20px;
      padding: 2px 6px;
      border: 1px solid #a8b8c0;
      border-radius: 999px;
      background: #f5f8f9;
      color: var(--blue);
      font-size: 11px;
      font-weight: 850;
      white-space: nowrap;
    }
    .current-run-badge.idle {
      color: var(--muted);
    }
    .current-run-metrics {
      display: flex;
      align-items: baseline;
      flex-wrap: wrap;
      gap: 3px 6px;
      color: var(--muted);
      font-size: 11px;
    }
    .current-run-metrics strong {
      color: var(--text);
      font-variant-numeric: tabular-nums;
    }
    .current-run-delta {
      font-weight: 750;
      font-variant-numeric: tabular-nums;
    }
    .current-run-delta.positive { color: var(--green); }
    .current-run-delta.negative { color: var(--red); }
    .current-run-delta.neutral,
    .current-run-delta.unknown { color: var(--muted); }
    main {
      max-width: none;
      margin: 0;
      padding: 18px 18px 22px;
    }
    .dashboard-layout {
      display: grid;
      grid-template-columns: 190px minmax(0, 1fr);
      gap: 16px;
      align-items: start;
    }
    .deck-rail {
      position: sticky;
      top: 96px;
      align-self: start;
      max-height: calc(100vh - 112px);
      overflow-y: auto;
      padding-right: 4px;
      scrollbar-gutter: stable;
      overflow-anchor: none;
    }
    .deck-tabs {
      display: grid;
      gap: 10px;
      align-content: start;
    }
    .deck-tab-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 26px;
      gap: 6px;
      align-items: stretch;
      cursor: grab;
    }
    .deck-tab-row:active { cursor: grabbing; }
    .deck-tab-row.dragging {
      opacity: 0.55;
    }
    .deck-tab-row.drop-target {
      outline: 3px solid var(--blue);
      outline-offset: 2px;
      border-radius: 4px;
    }
    .deck-tab-row.drop-before {
      box-shadow: inset 0 3px 0 var(--blue);
    }
    .deck-tab-row.drop-after {
      box-shadow: inset 0 -3px 0 var(--blue);
    }
    .deck-tab {
      width: 100%;
      min-height: 58px;
      white-space: normal;
      border: 2px solid #1b252b;
      border-radius: 4px;
      background: #ffffff;
      padding: 9px 10px;
      font-weight: 750;
      color: var(--text);
      text-align: left;
      cursor: pointer;
      display: grid;
      gap: 6px;
      align-content: center;
      line-height: 1.2;
    }
    .deck-tab.active {
      border-color: var(--blue);
      background: #e5f2fa;
      color: #154b70;
    }
    .deck-tab .name {
      display: block;
      overflow-wrap: anywhere;
    }
    .deck-tab .sub {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .deck-tab .status-badges {
      display: flex;
      gap: 5px;
      flex-wrap: wrap;
      align-items: center;
    }
    .deck-tab .baseline-marker,
    .deck-tab .status-marker {
      display: inline-block;
      font-size: 11px;
      font-weight: 900;
      letter-spacing: 0;
      text-transform: uppercase;
      border-radius: 999px;
      padding: 2px 7px;
      border: 1px solid currentColor;
      background: #ffffff;
    }
    .deck-tab .baseline-marker.ready { color: var(--green); background: #eef8f3; }
    .deck-tab .baseline-marker.seed { color: var(--amber); background: #fff8e8; }
    .deck-tab .baseline-marker.needed { color: var(--red); background: #fff0f0; }
    .deck-tab .status-marker.ready { color: var(--green); background: #eef8f3; }
    .deck-tab .status-marker.seed { color: var(--amber); background: #fff8e8; }
    .deck-tab .status-marker.needed { color: var(--red); background: #fff0f0; }
    .deck-move {
      display: grid;
      gap: 4px;
    }
    .deck-move-btn {
      min-height: 20px;
      height: 20px;
      padding: 0;
      border-radius: 4px;
      font-size: 11px;
      line-height: 1;
      cursor: pointer;
    }
    .workspace {
      display: grid;
      gap: 16px;
      min-width: 0;
    }
    .loop-strip {
      display: grid;
      grid-template-columns: minmax(180px, 240px) minmax(240px, 1fr) minmax(90px, 120px);
      gap: 10px;
      align-items: end;
      min-height: 72px;
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #ffffff;
      order: 1;
    }
    .readiness-grid {
      display: grid;
      grid-template-columns: repeat(5, minmax(120px, 1fr));
      gap: 10px;
      margin-bottom: 12px;
    }
    .readiness-stage {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fbfcfd;
      padding: 12px;
      margin-bottom: 12px;
      display: grid;
      grid-template-columns: minmax(180px, auto) minmax(0, 1fr);
      gap: 10px;
      align-items: center;
    }
    .readiness-stage .stage-label {
      font-size: 18px;
      font-weight: 850;
    }
    .readiness-stage .stage-note {
      color: var(--muted);
      line-height: 1.35;
    }
    .dashboard-issues {
      display: none;
      order: 2;
      border: 1px solid #d9a0a0;
      border-radius: 8px;
      background: #fff0f0;
      color: var(--red);
      padding: 10px 12px;
      font-weight: 700;
    }
    .dashboard-issues.visible {
      display: block;
    }
    .loop-log-drawer {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #ffffff;
      padding: 10px 12px;
      order: 3;
    }
    .loop-log-drawer summary {
      cursor: pointer;
      font-weight: 800;
      color: var(--blue);
    }
    .loop-log-drawer[open] summary {
      margin-bottom: 10px;
    }
    .loop-log-drawer pre {
      max-height: 260px;
    }
    .hidden-loop-settings {
      display: none;
    }
    .dashboard-panel[data-panel-id="training-readiness"] { order: 5; }
    .dashboard-panel[data-panel-id="baseline-tracker"] { order: 6; }
    .dashboard-panel[data-panel-id="advice"] { order: 7; }
    .dashboard-panel[data-panel-id="matchups"] { order: 20; }
    .dashboard-panel[data-panel-id="matchup-notes"] { order: 21; }
    .dashboard-panel[data-panel-id="bad-matchup-radar"] { order: 22; }
    .dashboard-panel[data-panel-id="matchup-card-readout"] { order: 23; }
    .dashboard-panel[data-panel-id="card-readout"] { order: 30; }
    .dashboard-panel[data-panel-id="experiment-planner"] { order: 40; }
    .dashboard-panel[data-panel-id="deck-edit-lab"] { order: 41; }
    .dashboard-panel[data-panel-id="loop-health"] { order: 4; }
    .evidence-drawer { order: 90; }
    .content-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 16px;
    }
    .panel {
      background: var(--panel);
      border: 2px solid #1b252b;
      border-radius: 4px;
      padding: 14px;
      min-width: 0;
    }
    .dashboard-panel {
      max-width: 100%;
      overflow: visible;
    }
    .panel-titlebar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin: 0 0 12px;
      user-select: none;
    }
    .panel-titlebar h2 {
      margin: 0;
    }
    .drag-handle {
      display: none;
    }
    .toolbar {
      display: flex;
      gap: 6px;
      align-items: center;
      justify-content: flex-end;
      flex-wrap: wrap;
      min-width: 0;
    }
    button {
      border: 1px solid var(--line);
      background: #ffffff;
      color: var(--text);
      border-radius: 5px;
      padding: 6px 9px;
      cursor: pointer;
      font-weight: 650;
      min-height: 32px;
      font-size: 12px;
    }
    button:hover { border-color: #9caab2; }
    button.primary { background: var(--green); color: #ffffff; border-color: var(--green); }
    button.danger { background: var(--red); color: #ffffff; border-color: var(--red); }
    button.danger-quiet { color: var(--red); border-color: #dfb4b4; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .action-menu {
      position: relative;
      min-width: 0;
    }
    .action-menu > summary {
      list-style: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 32px;
      padding: 6px 10px;
      border: 1px solid var(--line);
      border-radius: 5px;
      background: #ffffff;
      color: var(--text);
      cursor: pointer;
      font-size: 12px;
      font-weight: 650;
      user-select: none;
    }
    .action-menu > summary::-webkit-details-marker { display: none; }
    .action-menu > summary:hover,
    .action-menu[open] > summary { border-color: #9caab2; }
    .action-menu-popover {
      position: absolute;
      top: calc(100% + 6px);
      right: 0;
      z-index: 40;
      width: 230px;
      padding: 6px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #ffffff;
      box-shadow: 0 12px 28px rgba(24, 39, 48, 0.16);
    }
    .action-menu-popover button {
      width: 100%;
      border-color: transparent;
      text-align: left;
      background: transparent;
    }
    .action-menu-popover button:hover:not(:disabled) { background: #f2f5f6; }
    .action-menu-label {
      padding: 7px 9px 3px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 750;
      text-transform: uppercase;
    }
    .action-menu-separator {
      height: 1px;
      margin: 5px 4px;
      background: var(--line);
    }
    label { display: grid; gap: 5px; color: var(--muted); font-size: 12px; }
    input, select, textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 8px;
      background: #fff;
      color: var(--text);
      min-height: 36px;
      font: inherit;
    }
    textarea { min-height: 68px; resize: vertical; }
    .form-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(120px, 1fr));
      gap: 10px;
    }
    .wide { grid-column: 1 / -1; }
    .cards {
      display: grid;
      grid-template-columns: repeat(4, minmax(130px, 1fr));
      gap: 10px;
    }
    .profile-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(150px, 1fr));
      gap: 10px;
      margin-bottom: 12px;
    }
    .advice-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
    }
    .advice-box {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      background: #fbfcfd;
      min-width: 0;
    }
    .advice-box h3 {
      margin: 0 0 8px;
      font-size: 13px;
    }
    .advice-box ul {
      margin: 0;
      padding-left: 18px;
    }
    .advice-box li {
      margin: 0 0 6px;
      line-height: 1.35;
    }
    .matchup-impact {
      border-top: 1px solid var(--line);
      margin-top: 12px;
      padding-top: 12px;
    }
    .matchup-impact-header {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
      margin-bottom: 10px;
    }
    .matchup-impact-header h3 {
      margin: 0 0 3px;
      font-size: 14px;
    }
    .matchup-impact-header .path {
      display: block;
    }
    .matchup-impact-grid {
      grid-template-columns: repeat(6, minmax(105px, 1fr));
    }
    .matchup-impact .scroll {
      max-height: 180px;
      margin-top: 10px;
    }
    .health {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      border: 1px solid var(--line);
      padding: 4px 8px;
      font-size: 12px;
      font-weight: 800;
      margin-left: 8px;
    }
    .health.healthy { color: var(--green); border-color: #9fcab5; background: #eef8f3; }
    .health.developing { color: var(--amber); border-color: #d8bd7e; background: #fff8e8; }
    .health.needs-data { color: var(--red); border-color: #d9a0a0; background: #fff0f0; }
    .health.strong,
    .health.usable { color: var(--green); border-color: #9fcab5; background: #eef8f3; }
    .health.early,
    .health.unstable { color: var(--red); border-color: #d9a0a0; background: #fff0f0; }
    .metric {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      background: #fbfcfd;
      min-height: 76px;
    }
    .metric .label { color: var(--muted); font-size: 12px; }
    .metric .value { font-size: 20px; font-weight: 750; margin-top: 6px; }
    .matchup-stats-panel .detail-grid {
      margin-bottom: 0;
    }
    .matchup-notes-panel .detail-notes {
      grid-template-columns: 1.2fr 1fr 1fr;
    }
    .coach-readout-panel .scroll {
      max-height: none;
    }
    .dashboard-panel.compact-empty .scroll {
      display: none;
    }
    .empty-panel-note {
      display: none;
      border: 1px dashed #b7c4cb;
      border-radius: 8px;
      background: #fbfcfd;
      color: var(--muted);
      padding: 12px;
      line-height: 1.35;
    }
    .dashboard-panel.compact-empty > .empty-panel-note {
      display: block;
    }
    .general-deck-panel .advice-grid {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .hidden-metrics {
      display: none;
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      border-radius: 999px;
      padding: 5px 8px;
      border: 1px solid var(--line);
      font-weight: 700;
      font-size: 12px;
    }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); }
    .running .dot { background: var(--green); }
    .stopped .dot { background: var(--red); }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: auto;
      min-width: 900px;
    }
    th, td {
      padding: 8px 7px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
      white-space: normal;
      overflow: visible;
      text-overflow: clip;
      overflow-wrap: anywhere;
      line-height: 1.35;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      background: #fbfcfd;
      position: sticky;
      top: 0;
    }
    th.sortable-header {
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
    }
    th.sortable-header:hover {
      color: var(--text);
      background: #f2f6f8;
    }
    th.sortable-header::after {
      content: " \\2195";
      color: #a6b3ba;
      font-size: 10px;
      margin-left: 5px;
    }
    th.sortable-header.sort-asc::after {
      content: " \\25B2";
      color: var(--blue);
    }
    th.sortable-header.sort-desc::after {
      content: " \\25BC";
      color: var(--blue);
    }
    .scroll {
      overflow-x: auto;
      overflow-y: visible;
      max-height: none;
      border: 1px solid var(--line);
      border-radius: 8px;
      scrollbar-gutter: stable;
      overflow-anchor: none;
    }
    .dashboard-panel[data-panel-id="matchups"] .scroll { max-height: none; }
    #deckRankings { min-width: 1480px; }
    #matchupStats { min-width: 1120px; }
    #badMatchupRadar { min-width: 1120px; }
    #matchupCardReadout { min-width: 1160px; }
    #experimentPlanner { min-width: 1180px; }
    #cardReadout { min-width: 1420px; }
    #cardReadout th:nth-child(4),
    #cardReadout td:nth-child(4) { min-width: 210px; }
    .action-frequency {
      display: grid;
      gap: 3px;
      min-width: 190px;
    }
    .action-frequency-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: baseline;
      gap: 12px;
      line-height: 1.3;
    }
    .action-frequency-row strong {
      color: var(--text);
      font-variant-numeric: tabular-nums;
    }
    .action-frequency-row.zero,
    .action-frequency-row.zero strong {
      color: var(--bad);
    }
    #matchupStats th:first-child,
    #matchupStats td:first-child { min-width: 260px; }
    #matchupStats tbody tr {
      cursor: pointer;
    }
    #matchupStats tbody tr:hover {
      background: #f4f8fa;
    }
    #matchupStats tbody tr.selected {
      background: #e5f2fa;
      outline: 2px solid #b4d8ec;
      outline-offset: -2px;
    }
    #deckBaselineTracker tbody tr {
      cursor: pointer;
    }
    #deckBaselineTracker tbody tr:hover {
      background: #f4f8fa;
    }
    #deckBaselineTracker tbody tr.selected {
      background: #e5f2fa;
      outline: 2px solid #b4d8ec;
      outline-offset: -2px;
    }
    #deckRankings tbody tr {
      cursor: pointer;
    }
    #deckRankings tbody tr:hover {
      background: #f4f8fa;
    }
    #deckRankings tbody tr.selected {
      background: #e5f2fa;
      outline: 2px solid #b4d8ec;
      outline-offset: -2px;
    }
    #deckRankings th:first-child,
    #deckRankings td:first-child {
      width: 52px;
      text-align: center;
    }
    #deckRankings th:nth-child(2),
    #deckRankings td:nth-child(2) {
      min-width: 230px;
    }
    .detail-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      margin-bottom: 12px;
    }
    .detail-header h3 {
      margin: 0 0 4px;
      font-size: 15px;
    }
    .detail-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(120px, 1fr));
      gap: 10px;
      margin-bottom: 12px;
    }
    .detail-notes {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
    }
    .evidence-drawer {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #ffffff;
      padding: 10px 12px;
    }
    .evidence-drawer summary {
      cursor: pointer;
      font-weight: 800;
      color: var(--blue);
    }
    .evidence-drawer[open] summary {
      margin-bottom: 10px;
    }
    .path { color: var(--muted); font-family: Consolas, monospace; font-size: 12px; }
    .good { color: var(--green); font-weight: 700; }
    .bad { color: var(--red); font-weight: 700; }
    .warn { color: var(--amber); font-weight: 700; }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      background: #11181d;
      color: #d7e4ea;
      border-radius: 8px;
      padding: 12px;
      max-height: 320px;
      overflow: auto;
      font-size: 12px;
      line-height: 1.45;
      scrollbar-gutter: stable;
      overflow-anchor: none;
    }
    @media (max-width: 1220px) {
      header {
        grid-template-columns: minmax(220px, 1fr) auto;
        align-items: start;
      }
      .current-run-strip {
        grid-column: 1 / -1;
        grid-row: 2;
        padding: 8px 0 2px;
        border-inline: 0;
        border-top: 1px solid var(--line);
      }
      header .toolbar {
        grid-column: 2;
        grid-row: 1;
      }
      .deck-rail {
        top: 132px;
        max-height: calc(100vh - 148px);
      }
    }
    @media (max-width: 980px) {
      .dashboard-layout, .loop-strip, .cards, .profile-grid, .advice-grid, .detail-notes, .readiness-grid, .readiness-stage, .general-deck-panel .advice-grid { grid-template-columns: 1fr; }
      .deck-rail {
        position: static;
        max-height: none;
        overflow-x: auto;
        overflow-y: hidden;
        padding: 0 0 8px;
      }
      .deck-tabs {
        display: flex;
        gap: 10px;
        align-items: stretch;
      }
      .deck-tab-row {
        grid-template-columns: minmax(0, 1fr) 28px;
        flex: 0 0 180px;
      }
      header { grid-template-columns: 1fr; align-items: flex-start; position: static; }
      .header-brand { grid-column: 1; grid-row: 1; }
      .current-run-strip {
        grid-column: 1;
        grid-row: 2;
        width: 100%;
      }
      header .toolbar {
        grid-column: 1;
        grid-row: 3;
        flex: 0 1 auto;
        width: 100%;
        justify-content: flex-start;
        align-content: flex-start;
      }
      main { padding: 14px 12px 20px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="header-brand">
      <h1>Union Arena Pilot Dashboard</h1>
      <div class="path" id="cwd"></div>
    </div>
    <section class="current-run-strip" id="currentRunStrip" aria-label="Current training run">
      <div class="current-run-title">
        <span class="current-run-badge idle" id="currentRunBadge">IDLE</span>
        <span class="current-run-label">Current Run:</span>
        <span class="current-run-name" id="currentRunName" aria-live="polite">No active training run</span>
      </div>
      <div class="current-run-metrics">
        <span>Latest Win Rate: <strong id="currentRunWinRate">-</strong></span>
        <span class="current-run-delta unknown" id="currentRunDelta">No active matchup</span>
        <span>Time Running: <strong id="currentRunElapsed">00:00:00</strong></span>
      </div>
    </section>
    <div class="toolbar">
      <span class="status stopped" id="status"><span class="dot"></span><span>Loading</span></span>
      <button class="primary" id="start" title="Train the selected deck with one CPU worker per physical core.">Train Deck</button>
      <button id="startAllBaselines" title="Queue every missing baseline and train one full-strength deck at a time.">Build Needed Baselines</button>
      <button class="primary" id="startAutoRefine" title="Refine baselines, deck ML, and matchups without overlapping full-strength deck jobs.">Auto Refine</button>
      <button class="danger" id="stop">Stop Training</button>
      <details class="action-menu" id="moreActions">
        <summary aria-label="More dashboard actions">More</summary>
        <div class="action-menu-popover">
          <div class="action-menu-label">Advanced Training</div>
          <button id="startMatchupSweep">Sweep All Matchups</button>
          <button id="startDeckExperiment">Run Deck Experiment</button>
          <div class="action-menu-separator"></div>
          <div class="action-menu-label">Dashboard</div>
          <button id="refresh">Refresh Data</button>
          <button id="resetLayout">Reset Layout</button>
          <button id="clearLog">Clear Log</button>
          <div class="action-menu-separator"></div>
          <div class="action-menu-label">Recovery</div>
          <button class="danger-quiet" id="deleteBaseline">Delete Selected Baseline</button>
          <button class="danger-quiet" id="forceStop">Force Stop Agent</button>
        </div>
      </details>
    </div>
  </header>
  <main id="dashboardLayout" class="dashboard-layout">
    <aside class="deck-rail">
      <nav class="deck-tabs" id="deckTabs"></nav>
    </aside>
    <section class="workspace">
      <section class="loop-strip" data-panel-id="controls">
          <label>Training Mode
            <select id="trainingMode">
              <option value="deck" selected>Deck Training</option>
              <option value="matchup">Matchup Training</option>
            </select>
          </label>
          <label id="matchupSelectorLabel">Opponent Deck <select id="matchupKey"></select></label>
          <label>Cycles <input id="cycles" type="number" value="3"></label>
          <label class="hidden-metrics">Deck <select id="deck"></select></label>
      </section>
      <div id="dashboardIssues" class="dashboard-issues"></div>
      <details class="loop-log-drawer">
        <summary>Loop Log</summary>
        <pre id="log"></pre>
      </details>
      <section class="panel dashboard-panel" data-panel-id="loop-health">
        <div class="panel-titlebar">
          <h2>Loop Health</h2>
          <span class="path" id="loopHealthCaption"></span>
        </div>
        <div class="profile-grid">
          <div class="metric"><div class="label">State</div><div class="value" id="loopHealthStatus">-</div></div>
          <div class="metric"><div class="label">Session</div><div class="value" id="loopHealthSession">-</div></div>
          <div class="metric"><div class="label">Cycle</div><div class="value" id="loopHealthCycle">-</div></div>
        </div>
        <div class="detail-notes">
          <div class="advice-box"><h3>Read</h3><ul id="loopHealthNotes"></ul></div>
          <div class="advice-box"><h3>Artifacts</h3><ul id="loopHealthArtifacts"></ul></div>
        </div>
        <div class="matchup-impact" id="lastMatchupImpact">
          <div class="matchup-impact-header">
            <div>
              <h3 id="matchupImpactTitle">Last Matchup Impact</h3>
              <span class="path" id="matchupImpactSub">No completed matchup validation yet.</span>
            </div>
            <span id="matchupImpactVerdict" class="warn">No Data</span>
          </div>
          <div class="profile-grid matchup-impact-grid">
            <div class="metric"><div class="label">Updates</div><div class="value" id="matchupImpactUpdates">-</div></div>
            <div class="metric"><div class="label">Positive</div><div class="value good" id="matchupImpactPositive">-</div></div>
            <div class="metric"><div class="label">Negative</div><div class="value bad" id="matchupImpactNegative">-</div></div>
            <div class="metric"><div class="label">Inconclusive</div><div class="value warn" id="matchupImpactInconclusive">-</div></div>
            <div class="metric"><div class="label">Rollbacks</div><div class="value bad" id="matchupImpactRollbacks">-</div></div>
            <div class="metric"><div class="label">Avg Win Delta</div><div class="value" id="matchupImpactWinDelta">-</div></div>
            <div class="metric"><div class="label">Avg Life Delta</div><div class="value" id="matchupImpactLifeDelta">-</div></div>
          </div>
          <div class="scroll"><table id="matchupImpactRows"></table></div>
        </div>
      </section>
      <section class="panel dashboard-panel training-readiness-panel" data-panel-id="training-readiness">
        <div class="panel-titlebar">
          <h2>Training Readiness</h2>
          <span class="path" id="trainingReadinessCaption"></span>
        </div>
        <div class="readiness-stage">
          <div class="stage-label" id="trainingStage">-</div>
          <div class="stage-note" id="trainingStageNote">Waiting for dashboard state.</div>
        </div>
        <div class="readiness-grid">
          <div class="metric"><div class="label">Baselines</div><div class="value" id="readinessBaselines">-</div></div>
          <div class="metric"><div class="label">Profile ML</div><div class="value" id="readinessMl">-</div></div>
          <div class="metric"><div class="label">Matchup Data</div><div class="value" id="readinessMatchups">-</div></div>
          <div class="metric"><div class="label">Deck Experiments</div><div class="value" id="readinessExperiments">-</div></div>
          <div class="metric"><div class="label">Loop</div><div class="value" id="readinessLoop">-</div></div>
        </div>
        <div class="detail-notes">
          <div class="advice-box"><h3>Immediate Queue</h3><ul id="readinessQueue"></ul></div>
          <div class="advice-box"><h3>Learning Gates</h3><ul id="readinessGates"></ul></div>
          <div class="advice-box"><h3>Warnings</h3><ul id="readinessWarnings"></ul></div>
        </div>
      </section>
      <section class="panel dashboard-panel deck-rankings-panel" data-panel-id="deck-rankings">
        <div class="panel-titlebar">
          <h2>Overall Deck Rankings</h2>
          <span class="path" id="deckRankingCaption"></span>
        </div>
        <div class="scroll"><table id="deckRankings"></table></div>
      </section>
      <div class="hidden-loop-settings" aria-hidden="true">
        <input id="seed" type="hidden" value="1">
        <input id="ownKey" value="eva-purple" readonly>
        <input id="opponentSet" readonly>
        <input id="opponentColor" readonly>
        <input id="opponentTop" readonly>
        <input id="regions" readonly>
        <input id="parallelOpponentCountPerRun" type="number" value="6">
        <input id="mutationSwaps" type="number" value="2">
        <input id="parallelFinalGames" type="number" value="10">
        <input id="parallelFinalTopPercent" type="number" value="35">
        <select id="parallelFinalCandidates">
          <option value="merged-baseline">merged-baseline</option>
          <option value="best-baseline">best-baseline</option>
          <option value="best-merged-baseline" selected>best-merged-baseline</option>
          <option value="all">all</option>
        </select>
        <input id="generations" type="number" value="3">
        <input id="population" type="number" value="8">
        <input id="mlStrength" type="number" step="0.05" value="0.20">
        <input id="opponentCount" type="number" value="84">
        <input id="targetMatchupGames" type="number" value="60">
        <select id="decisionLogMode">
          <option value="learning" selected>learning</option>
          <option value="final">final</option>
          <option value="parallel-final">parallel-final</option>
          <option value="all">all</option>
          <option value="none">none</option>
        </select>
        <select id="knowledgeMode">
          <option value="full">full</option>
          <option value="action" selected>action-only</option>
          <option value="matchup">matchup-only</option>
          <option value="none">none</option>
        </select>
        <textarea id="knowledgeInputs"></textarea>
      </div>

      <section class="panel dashboard-panel" data-panel-id="baseline-tracker">
        <div class="panel-titlebar">
          <h2>Pilot Baseline Tracker</h2>
          <span class="path" id="baselineTrackerCaption"></span>
        </div>
        <div class="scroll"><table id="deckBaselineTracker"></table></div>
      </section>

      <section class="panel dashboard-panel coach-readout-panel" data-panel-id="bad-matchup-radar">
        <div class="panel-titlebar">
          <h2>Bad Matchup Radar</h2>
          <span class="path" id="badMatchupRadarCaption"></span>
        </div>
        <div class="scroll"><table id="badMatchupRadar"></table></div>
      </section>

      <section class="panel dashboard-panel matchup-stats-panel" data-panel-id="matchups">
        <div class="detail-header">
          <div>
            <h2 id="matchupDetailTitle">Select a matchup</h2>
            <div class="path" id="matchupDetailSub">Click a matchup row to inspect the current evidence.</div>
          </div>
          <span id="matchupEvidence" class="health needs-data">Needs Data</span>
        </div>
        <div class="detail-grid">
          <div class="metric"><div class="label">W/L/I</div><div class="value" id="matchupGames">-</div></div>
          <div class="metric"><div class="label">Completed Win Rate</div><div class="value" id="matchupWinRate">-</div></div>
          <div class="metric"><div class="label">Life Diff</div><div class="value" id="matchupLifeDiff">-</div></div>
          <div class="metric"><div class="label">Turn Cycles</div><div class="value" id="matchupTurnCycles">-</div></div>
        </div>
      </section>

      <section class="panel dashboard-panel matchup-notes-panel" data-panel-id="matchup-notes">
        <div class="panel-titlebar"><h2>Matchup Notes / Details / Suggestions</h2></div>
        <div class="detail-notes">
          <div class="advice-box"><h3>Read</h3><ul id="matchupReadNotes"></ul></div>
          <div class="advice-box"><h3>Next Tests</h3><ul id="matchupNextTests"></ul></div>
          <div class="advice-box"><h3>Opponent Lists</h3><ul id="matchupDeckLists"></ul></div>
        </div>
      </section>

      <section class="panel dashboard-panel coach-readout-panel" data-panel-id="matchup-card-readout">
        <div class="panel-titlebar">
          <h2>Selected Matchup Card Evidence</h2>
          <span class="path" id="matchupCardReadoutCaption"></span>
        </div>
        <div class="scroll"><table id="matchupCardReadout"></table></div>
      </section>

      <section class="panel dashboard-panel coach-readout-panel" data-panel-id="experiment-planner">
        <div class="panel-titlebar">
          <h2>Deck Experiment Planner</h2>
          <span class="path" id="experimentPlannerCaption"></span>
        </div>
        <div class="scroll"><table id="experimentPlanner"></table></div>
      </section>

      <section class="panel dashboard-panel coach-readout-panel" data-panel-id="deck-edit-lab">
        <div class="panel-titlebar">
          <h2>Deck Edit Lab</h2>
          <span class="path" id="deckEditLabCaption"></span>
        </div>
        <div class="scroll"><table id="deckEditLab"></table></div>
      </section>

      <section class="panel dashboard-panel general-deck-panel" data-panel-id="advice">
        <div class="panel-titlebar"><h2>General Deck Notes / Suggestions / Possible Changes <span id="adviceHealth" class="health needs-data">Needs Data</span></h2></div>
        <div class="profile-grid">
          <div class="metric"><div class="label">Baseline Policy</div><div class="value" id="deckPolicyStatus">-</div></div>
          <div class="metric"><div class="label">Deck ML Model</div><div class="value" id="deckModelStatus">-</div></div>
          <div class="metric"><div class="label">Matchup Data</div><div class="value" id="deckMatchupStatus">-</div></div>
        </div>
        <div class="cards">
          <div class="metric"><div class="label">Policy</div><div class="value" id="policyName">-</div></div>
          <div class="metric"><div class="label">Action Examples</div><div class="value" id="modelExamples">-</div></div>
          <div class="metric"><div class="label">Matchups</div><div class="value" id="overlayCount">-</div></div>
          <div class="metric"><div class="label">Latest Win Rate</div><div class="value" id="latestWinRate">-</div></div>
        </div>
        <div class="path" id="selectedDeckPath"></div>
        <div class="advice-grid">
          <div class="advice-box"><h3>Priorities</h3><ul id="advicePriorities"></ul></div>
          <div class="advice-box"><h3>Next Actions</h3><ul id="adviceActions"></ul></div>
          <div class="advice-box"><h3>Strengths</h3><ul id="adviceStrengths"></ul></div>
          <div class="advice-box"><h3>Concerns</h3><ul id="adviceConcerns"></ul></div>
          <div class="advice-box"><h3>Performance</h3><ul id="advicePerformance"></ul></div>
          <div class="advice-box"><h3>Pilot Learning</h3><ul id="adviceLearning"></ul></div>
          <div class="advice-box"><h3>Edit Readiness</h3><ul id="adviceEditReadiness"></ul></div>
          <div class="advice-box"><h3>Deck Shape</h3><ul id="adviceDeckNotes"></ul></div>
          <div class="advice-box"><h3>Card Packages</h3><ul id="adviceCardPackages"></ul></div>
          <div class="advice-box"><h3>Card Evidence</h3><ul id="adviceCardEvidence"></ul></div>
          <div class="advice-box"><h3>Deck Experiments</h3><ul id="adviceDeckExperiments"></ul></div>
          <div class="advice-box"><h3>Card Slots</h3><ul id="adviceCardNotes"></ul></div>
        </div>
      </section>

      <section class="panel dashboard-panel coach-readout-panel" data-panel-id="card-readout">
        <div class="panel-titlebar">
          <h2>Card Pros / Cons Readout</h2>
          <span class="path" id="cardReadoutCaption"></span>
        </div>
        <div class="scroll"><table id="cardReadout"></table></div>
      </section>

      <details class="evidence-drawer">
        <summary>Evidence Tables</summary>
        <div class="content-grid">
          <section class="panel dashboard-panel" data-panel-id="raw-matchups">
            <div class="panel-titlebar"><h2>All Matchup Rows</h2></div>
            <div class="scroll"><table id="matchupStats"></table></div>
          </section>
          <section class="panel dashboard-panel" data-panel-id="card-evidence">
            <div class="panel-titlebar">
              <h2>Card Decision Evidence</h2>
              <span class="path" id="cardEvidenceCaption"></span>
            </div>
            <div class="scroll"><table id="cardEvidence"></table></div>
          </section>
          <section class="panel dashboard-panel" data-panel-id="deck-cards">
            <div class="panel-titlebar">
              <h2>Deck Card Matrix</h2>
              <span class="path" id="deckCardsCaption"></span>
            </div>
            <div class="scroll"><table id="deckCards"></table></div>
          </section>
          <section class="panel dashboard-panel" data-panel-id="learning-signals">
            <div class="panel-titlebar">
              <h2>Pilot Learning Signals</h2>
              <span class="path" id="learningSignalsCaption"></span>
            </div>
            <div class="scroll"><table id="learningSignals"></table></div>
          </section>
          <section class="panel dashboard-panel" data-panel-id="performance-trend">
            <div class="panel-titlebar">
              <h2>Performance Trend</h2>
              <span class="path" id="performanceTrendCaption"></span>
            </div>
            <div class="scroll"><table id="performanceTrend"></table></div>
          </section>
          <section class="panel dashboard-panel" data-panel-id="runs">
            <div class="panel-titlebar"><h2>Recent Runs</h2></div>
            <div class="scroll"><table id="runs"></table></div>
          </section>
          <section class="panel dashboard-panel" data-panel-id="overlays">
            <div class="panel-titlebar"><h2>Matchup Overlays</h2></div>
            <div class="scroll"><table id="overlays"></table></div>
          </section>
          <section class="panel dashboard-panel" data-panel-id="knowledge">
            <div class="panel-titlebar"><h2>Knowledge Updates</h2></div>
            <div class="scroll"><table id="knowledge"></table></div>
          </section>
        </div>
      </details>
    </section>
  </main>
  <script>
    const ids = ["trainingMode","deck","ownKey","matchupKey","opponentSet","opponentColor","opponentTop","regions","seed","cycles","parallelOpponentCountPerRun","mutationSwaps","parallelFinalGames","parallelFinalTopPercent","parallelFinalCandidates","generations","population","mlStrength","opponentCount","targetMatchupGames","decisionLogMode","knowledgeMode","knowledgeInputs"];
    const $ = (id) => document.getElementById(id);
    const layoutStorageKey = "union-arena-pilot-dashboard-layout-v7";
    const deckOrderStorageKey = "union-arena-pilot-dashboard-deck-order-v1";
    let latestDecks = [];
    let latestProfiles = [];
    let latestDeckRankings = null;
    let latestArchetypes = [];
    let latestRegionalDecks = [];
    let latestRuns = [];
    let latestDeckExperiments = [];
    let lastDeckValue = "";
    let selectedDeckId = "";
    let selectedMatchupKey = "";
    let draggedDeckId = "";
    let deckDragMoved = false;
    let ownKeyTouched = false;
    let draggedPanel = null;
    let layoutSaveTimer = null;
    let refreshInFlight = false;
    let refreshQueued = false;
    let refreshTimer = null;
    let lastAnalyticsVersion = "";
    let lastRunning = false;
    let lastLogText = "";
    let latestLoopHealth = null;
    let latestCurrentRunStatus = null;
    let scrollMutationVersion = 0;
    let suppressScrollMutation = false;
    let suppressScrollMutationTimer = null;
    const runningRefreshIntervalMs = 10000;
    const idleRefreshIntervalMs = 30000;
    const scrollableSelector = ".scroll, .deck-rail, #log";
    const htmlCache = new WeakMap();
    const tableSortState = {};
    $("refresh").onclick = () => refresh({ manual: true });
    $("resetLayout").onclick = resetPanelLayout;
    $("clearLog").onclick = clearLog;
    $("deleteBaseline").onclick = deleteBaseline;
    $("start").onclick = startLoop;
    $("startAllBaselines").onclick = startAllBaselines;
    $("startMatchupSweep").onclick = startMatchupSweep;
    $("startAutoRefine").onclick = startAutoRefine;
    $("startDeckExperiment").onclick = startDeckExperiment;
    $("stop").onclick = stopLoop;
    $("forceStop").onclick = forceStopLoop;
    for (const button of $("moreActions").querySelectorAll("button")) {
      button.addEventListener("click", closeActionMenu);
    }
    document.addEventListener("click", (event) => {
      const menu = $("moreActions");
      if (menu.open && !menu.contains(event.target)) menu.open = false;
    });
    $("trainingMode").onchange = applyTrainingModeDefaults;
    $("deck").onchange = () => {
      ownKeyTouched = false;
      selectDeck($("deck").value);
    };
    $("matchupKey").onchange = syncMatchupFilters;
    $("ownKey").oninput = () => { ownKeyTouched = true; };
    installScrollMutationTracker();
    initPanelLayout();
    setInterval(updateCurrentRunElapsed, 1000);
    scheduleRefresh(0);

    function scheduleRefresh(delay = lastRunning ? runningRefreshIntervalMs : idleRefreshIntervalMs) {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => refresh({ manual: false }), delay);
    }

    async function refresh(options = {}) {
      const manual = Boolean(options.manual);
      if (!manual && draggedDeckId) {
        scheduleRefresh(1000);
        return;
      }
      if (refreshInFlight) {
        refreshQueued = true;
        return;
      }
      clearTimeout(refreshTimer);
      refreshTimer = null;
      refreshInFlight = true;
      const scrollState = snapshotScrollState();
      $("refresh").disabled = true;
      try {
        const stateUrl = manual || !lastAnalyticsVersion
          ? "/api/state"
          : "/api/state?analyticsVersion=" + encodeURIComponent(lastAnalyticsVersion);
        const data = await fetchJson(stateUrl);
        $("cwd").textContent = data.cwd;
        const running = Boolean(data.controller.running);
        lastRunning = running;
        latestLoopHealth = data.loopHealth || null;
        $("status").className = "status " + (running ? "running" : "stopped");
        $("status").lastElementChild.textContent = running ? "Running PID " + data.controller.pid : "Stopped";
        $("startMatchupSweep").disabled = running;
        $("startDeckExperiment").disabled = running;
        $("deleteBaseline").disabled = running;
        $("stop").disabled = !running;
        $("forceStop").disabled = false;
        const analyticsChanged = !data.analyticsUnchanged;
        if (analyticsChanged) {
          lastAnalyticsVersion = data.analyticsVersion || lastAnalyticsVersion;
          latestDecks = data.decks || [];
          latestProfiles = data.deckProfiles || [];
          latestDeckRankings = data.deckRankings || null;
          latestArchetypes = data.regionalArchetypes || [];
          latestRegionalDecks = data.regionalDecks || [];
          latestRuns = data.runs || [];
          latestDeckExperiments = data.deckExperiments || [];
          applySeedPreference(data.dashboardPrefs);
        }
        updatePrimaryActions(running);
        const renderIssues = [];
        const safeRender = (label, renderFn) => {
          try {
            return renderFn();
          } catch (error) {
            console.error("Dashboard section failed:", label, error);
            renderIssues.push({ label, message: error?.message || String(error) });
            return null;
          }
        };
        const profile = selectedProfile();
        const profileRuns = latestRunsForProfile(profile);
        const latest = profileRuns.find((run) => run.complete && run.result);
        safeRender("Current run", () => renderCurrentRunStatus(data.currentRunStatus));
        safeRender("Loop log", () => renderLoopLog(data.logTail || ""));
        safeRender("Loop health", () => renderLoopHealth(data.loopHealth));
        safeRender("Training readiness", () => renderTrainingReadiness(latestProfiles, data.loopHealth));
        if (analyticsChanged) {
          safeRender("Deck selector", () => renderDeckOptions(latestDecks, data.controller.config?.deck));
          safeRender("Deck rail", () => renderDeckTabs(latestProfiles));
          safeRender("Overall deck rankings", () => renderOverallDeckRankings(latestDeckRankings));
          safeRender("Baseline tracker", () => renderBaselineTracker(latestProfiles));
          safeRender("Matchup selector", () => renderMatchupOptions(latestRegionalDecks, latestArchetypes));
          safeRender("Loop controls", () => syncLoopModeUi());
          $("policyName").textContent = data.policies.current?.name || "current";
          $("modelExamples").textContent = modelExampleText(profile?.actionModel ?? data.policies.actionModel);
          const overlayTotal = Number(profile?.overlayCount ?? data.matchupOverlays.length);
          const overlayCandidates = Number(profile?.matchupCandidateCount ?? data.matchupOverlays.filter((overlay) => overlay.candidate).length);
          const overlayReady = Number(profile?.validatedOverlayCount ?? data.matchupOverlays.filter((overlay) => overlay.runtimeActive).length);
          $("overlayCount").textContent = (overlayReady === overlayTotal
            ? fmt(overlayTotal)
            : fmt(overlayReady) + "/" + fmt(overlayTotal) + " ready")
            + (overlayCandidates > 0 ? " + " + fmt(overlayCandidates) + " collecting" : "");
          $("latestWinRate").textContent = latest ? pct(latest.result.winRate) : "-";
          safeRender("Selected deck", () => renderSelectedProfile(profile));
          safeRender("Deck advice", () => renderAdvice(profile));
          safeRender("Bad matchup radar", () => renderBadMatchupRadar(profile));
          safeRender("Card readout", () => renderCardReadout(profile));
          safeRender("Experiment planner", () => renderExperimentPlanner(profile));
          safeRender("Deck edit lab", () => renderDeckEditLab(profile));
          safeRender("Card evidence", () => renderCardEvidence(profile));
          safeRender("Deck cards", () => renderDeckCards(profile));
          safeRender("Learning signals", () => renderLearningSignals(profile));
          safeRender("Matchup stats", () => renderMatchupStats(profile?.matchupStats || []));
          safeRender("Performance trend", () => renderPerformanceTrend(profileRuns));
          safeRender("Recent runs", () => renderRuns(profileRuns));
          safeRender("Matchup overlays", () => renderOverlays(data.matchupOverlays.filter((row) => !profile || row.ownKey === profile.ownKey)));
          safeRender("Knowledge updates", () => renderKnowledge(data.knowledgeUpdates.filter((row) => !profile || row.ownKey === profile.ownKey)));
          safeRender("Sortable tables", () => wireSortableTables());
        }
        renderDashboardIssues(renderIssues);
        safeRender("Scroll restore", () => restoreScrollState(scrollState));
      } catch (error) {
        console.error(error);
        renderDashboardIssues([{ label: "State refresh", message: error?.message || String(error) }]);
        if (manual) alert("Dashboard refresh failed: " + error.message);
      } finally {
        refreshInFlight = false;
        $("refresh").disabled = false;
        if (refreshQueued) {
          refreshQueued = false;
          scheduleRefresh(0);
        } else {
          scheduleRefresh();
        }
      }
    }

    async function startLoop() {
      syncOwnKeyFromDeck();
      syncMatchupFilters();
      const body = Object.fromEntries(ids.map((id) => [id, $(id).value]));
      if (body.trainingMode === "deck") {
        body.matchupKey = "";
        body.opponentSet = "";
        body.opponentColor = "";
        body.opponentTop = "";
        body.regions = "";
      }
      const result = await fetchJson("/api/loop/start", { method: "POST", body: JSON.stringify(body) });
      if (!result.ok) alert(result.message || result.error || "Could not start loop.");
      else consumeNextSeed(result);
      await refresh({ manual: true });
    }

    async function startAllBaselines() {
      const body = Object.fromEntries(ids.map((id) => [id, $(id).value]));
      body.baselineAll = true;
      body.trainingMode = "deck";
      body.knowledgeMode = "action";
      body.games = "8";
      body.generations = "2";
      body.population = "4";
      body.finalGames = "8";
      body.parallelOpponentCountPerRun = "6";
      body.parallelFinalGames = "0";
      body.matchupKey = "";
      body.opponentSet = "";
      body.opponentColor = "";
      body.opponentTop = "";
      body.regions = "";
      const result = await fetchJson("/api/loop/start", { method: "POST", body: JSON.stringify(body) });
      if (!result.ok) alert(result.message || result.error || "Could not start baseline suite.");
      else consumeNextSeed(result);
      await refresh({ manual: true });
    }

    async function startMatchupSweep() {
      syncOwnKeyFromDeck();
      const body = Object.fromEntries(ids.map((id) => [id, $(id).value]));
      body.matchupSweep = true;
      body.trainingMode = "matchup";
      body.deck = selectedDeckId || $("deck").value;
      body.games = "8";
      body.generations = "1";
      body.population = "4";
      body.parallelOpponentCountPerRun = "1";
      body.parallelFinalGames = "0";
      body.decisionLogMode = "learning";
      body.knowledgeMode = "full";
      const result = await fetchJson("/api/loop/start", { method: "POST", body: JSON.stringify(body) });
      if (!result.ok) alert(result.message || result.error || "Could not start matchup sweep.");
      else consumeNextSeed(result);
      await refresh({ manual: true });
    }

    async function startAutoRefine() {
      const orderedDeckIds = applySavedDeckOrder(latestProfiles).map((profile) => profile.id);
      const body = Object.fromEntries(ids.map((id) => [id, $(id).value]));
      body.autoRefine = true;
      body.deckOrder = orderedDeckIds.join(",");
      body.startDeck = orderedDeckIds[0] || selectedDeckId || "carnerr-spear";
      body.autoMaxJobs = "48";
      body.targetMatchupGames = $("targetMatchupGames").value || "60";
      body.stages = "light,deep,long";
      body.maxRetries = "1";
      body.plateauPasses = "1";
      const result = await fetchJson("/api/loop/start", { method: "POST", body: JSON.stringify(body) });
      if (!result.ok) alert(result.message || result.error || "Could not start auto refiner.");
      else consumeNextSeed(result);
      await refresh({ manual: true });
    }

    async function startDeckExperiment() {
      syncOwnKeyFromDeck();
      syncMatchupFilters();
      const body = Object.fromEntries(ids.map((id) => [id, $(id).value]));
      body.deckExperiment = true;
      body.deck = selectedDeckId || $("deck").value;
      const result = await fetchJson("/api/loop/start", { method: "POST", body: JSON.stringify(body) });
      if (!result.ok) alert(result.message || result.error || "Could not start deck experiment.");
      else consumeNextSeed(result);
      await refresh({ manual: true });
    }

    async function stopLoop() {
      const result = await fetchJson("/api/loop/stop", { method: "POST", body: "{}" });
      if (!result.ok) alert(result.message || result.error || "No loop stopped.");
      await refresh({ manual: true });
    }

    async function forceStopLoop() {
      const confirmed = confirm("Force stop all local Node agent processes except this dashboard?\\n\\nUse this when Stop Loop says stopped but training games are still running. This can stop other Node scripts launched from your normal Node install.");
      if (!confirmed) return;
      const result = await fetchJson("/api/loop/force-stop", { method: "POST", body: "{}" });
      alert(result.message || "Force stop finished.");
      await refresh({ manual: true });
    }

    async function clearLog() {
      const result = await fetchJson("/api/log/clear", { method: "POST", body: "{}" });
      if (!result.ok) alert(result.message || result.error || "Could not clear dashboard log.");
      await refresh({ manual: true });
    }

    async function deleteBaseline() {
      syncOwnKeyFromDeck();
      const profile = selectedProfile();
      const deck = selectedDeckId || $("deck").value;
      const ownKey = profile?.ownKey || $("ownKey").value;
      if (!deck || !ownKey) {
        alert("Select a pilot deck first.");
        return;
      }

      const label = profile?.name || profile?.label || deck;
      const confirmed = confirm("Delete the specialist baseline policy for " + label + " (" + ownKey + ")?\\n\\nThis does not delete saved decks or raw game history.");
      if (!confirmed) return;

      const includeLearning = confirm("Also reset profile learning for " + label + "?\\n\\nOK deletes the profile action model and matchup overlays for this set/color. Cancel deletes only the baseline policy.");
      const includeGlobalLearning = includeLearning && confirm("Also delete the global fallback ML action model?\\n\\nUse OK only when you want the next run to rebuild from fresh post-fix games. Cancel keeps the global fallback for other decks.");
      const result = await fetchJson("/api/baseline/delete", {
        method: "POST",
        body: JSON.stringify({ deck, ownKey, includeLearning, includeGlobalLearning })
      });
      alert(result.message || "Baseline delete finished.");
      await refresh({ manual: true });
    }

    async function fetchJson(url, options = {}) {
      const response = await fetch(url, { headers: { "content-type": "application/json" }, ...options });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || response.statusText);
      return data;
    }

    function closeActionMenu() {
      $("moreActions").open = false;
    }

    function updatePrimaryActions(running = lastRunning) {
      const deckMode = $("trainingMode").value === "deck";
      const baselineNeeded = latestProfiles.filter((profile) => {
        const status = baselineStatusForProfile(profile).label;
        return status === "Needed" || status === "Seed";
      }).length;
      $("start").textContent = deckMode ? "Train Deck" : "Train Matchup";
      $("start").disabled = running;
      $("startAllBaselines").textContent = baselineNeeded > 0
        ? "Build Needed Baselines (" + baselineNeeded + ")"
        : "Baselines Complete";
      $("startAllBaselines").disabled = running || baselineNeeded === 0;
      $("startAllBaselines").title = baselineNeeded > 0
        ? "Queue every needed baseline and train one deck at a time."
        : "Every saved deck profile has a trained baseline.";
      $("startAutoRefine").disabled = running || baselineNeeded > 0;
      $("startAutoRefine").title = baselineNeeded > 0
        ? "Available after every deck profile has a trained baseline."
        : "Continuously refine deck and matchup policies.";
    }

    function applySeedPreference(prefs) {
      const nextSeed = Number(prefs?.nextSeed);
      if (!Number.isFinite(nextSeed)) return;
      setSeedValue(nextSeed);
    }

    function consumeNextSeed(result) {
      const nextSeed = Number(result?.nextSeed);
      if (Number.isFinite(nextSeed)) setSeedValue(nextSeed);
    }

    function setSeedValue(value) {
      $("seed").value = String(value);
      const preview = $("seedPreview");
      if (preview) preview.textContent = String(value);
    }

    function renderLoopLog(text) {
      const log = $("log");
      if (!log || text === lastLogText) return;
      const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 32;
      log.textContent = text;
      lastLogText = text;
      if (nearBottom) {
        withProgrammaticScroll(() => {
          log.scrollTop = log.scrollHeight;
        });
      }
    }

    function renderCurrentRunStatus(status) {
      latestCurrentRunStatus = status || null;
      const active = Boolean(status?.active);
      const phase = String(status?.phase || "idle");
      const badge = $("currentRunBadge");
      badge.textContent = status?.badge || "IDLE";
      badge.className = "current-run-badge" + (active ? "" : " idle");
      $("currentRunName").textContent = status?.title || "No active training run";

      const hasWinRate = status?.latestWinRate !== null && status?.latestWinRate !== undefined
        && Number.isFinite(Number(status.latestWinRate));
      const winRate = $("currentRunWinRate");
      winRate.textContent = hasWinRate ? pct(status.latestWinRate) : "-";
      winRate.title = hasWinRate
        ? fmt(status.completedGames || 0) + " completed matchup game(s)"
        : phase === "matchup" ? "No completed matchup result is available yet." : "Not a matchup phase.";

      const delta = $("currentRunDelta");
      const deltaValue = status?.winRateDelta;
      const hasDelta = deltaValue !== null && deltaValue !== undefined && Number.isFinite(Number(deltaValue));
      const deltaTone = hasDelta ? String(status.deltaTone || "neutral") : "unknown";
      delta.className = "current-run-delta " + deltaTone;
      if (hasDelta) {
        const points = Number(deltaValue) * 100;
        delta.textContent = Math.abs(points) < 0.05
          ? "No change since start"
          : (points > 0 ? "+" : "") + points.toFixed(1) + " pts since start";
        delta.title = "Starting win rate: " + pct(status.startingWinRate)
          + "; latest completed win rate: " + pct(status.latestWinRate) + ".";
      } else if (phase === "matchup") {
        delta.textContent = status?.startingWinRate === null || status?.startingWinRate === undefined
          ? "No starting sample"
          : "Awaiting completed games";
        delta.title = "A comparison appears after both a starting and latest completed matchup sample exist.";
      } else {
        delta.textContent = active ? "Current phase" : "No active matchup";
        delta.title = active ? "Win-rate movement is shown during matchup refinement." : "";
      }

      $("currentRunStrip").classList.toggle("active", active);
      updateCurrentRunElapsed();
    }

    function updateCurrentRunElapsed() {
      const target = $("currentRunElapsed");
      const startedAt = latestCurrentRunStatus?.startedAt;
      const startedMs = startedAt ? new Date(startedAt).getTime() : NaN;
      if (!latestCurrentRunStatus?.active || !Number.isFinite(startedMs)) {
        target.textContent = "00:00:00";
        target.title = "";
        return;
      }
      target.textContent = elapsedTime(Date.now() - startedMs);
      target.title = "Started " + new Date(startedMs).toLocaleString();
    }

    function elapsedTime(durationMs) {
      const totalSeconds = Math.max(0, Math.floor(Number(durationMs || 0) / 1000));
      const days = Math.floor(totalSeconds / 86400);
      const hours = Math.floor((totalSeconds % 86400) / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      const clock = [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
      return days > 0 ? days + "d " + clock : clock;
    }

    function snapshotScrollState() {
      const containers = [...document.querySelectorAll(scrollableSelector)];
      return {
        windowX: window.scrollX,
        windowY: window.scrollY,
        scrollMutationVersion,
        activeElementId: document.activeElement?.id || "",
        containers: containers.map((element, index) => ({
          index,
          key: scrollContainerKey(element, index),
          id: element.id || "",
          scrollLeft: element.scrollLeft,
          scrollTop: element.scrollTop
        }))
      };
    }

    function restoreScrollState(snapshot) {
      if (!snapshot) return;
      const restore = () => {
        if (snapshot.scrollMutationVersion !== scrollMutationVersion) return;
        withProgrammaticScroll(() => {
          restoreScrollableContainers(snapshot);
          restoreWindowScroll(snapshot);
        });
      };
      requestAnimationFrame(() => requestAnimationFrame(() => {
        restore();
        setTimeout(restore, 80);
      }));
    }

    function restoreScrollableContainers(snapshot) {
      for (const item of snapshot.containers || []) {
        const element = scrollContainerForKey(item.key, item.index) || (item.id ? document.getElementById(item.id) : null);
        if (!element) continue;
        element.scrollLeft = clampScrollPosition(item.scrollLeft, element.scrollWidth - element.clientWidth);
        element.scrollTop = clampScrollPosition(item.scrollTop, element.scrollHeight - element.clientHeight);
      }
    }

    function restoreWindowScroll(snapshot) {
      const activeId = document.activeElement?.id || "";
      if (!snapshot.activeElementId || !activeId || activeId === snapshot.activeElementId) {
        const doc = document.documentElement;
        window.scrollTo(
          clampScrollPosition(snapshot.windowX, doc.scrollWidth - window.innerWidth),
          clampScrollPosition(snapshot.windowY, doc.scrollHeight - window.innerHeight)
        );
      }
    }

    function scrollContainerKey(element, index) {
      if (element.id) return "id:" + element.id;
      const table = element.querySelector("table[id]");
      if (table?.id) return "table:" + table.id;
      if (element.classList.contains("deck-rail")) return "deck-rail";
      const panel = element.closest("[data-panel-id]");
      if (panel?.dataset?.panelId) return "panel:" + panel.dataset.panelId + ":" + index;
      return "index:" + index;
    }

    function scrollContainerForKey(key, index) {
      if (!key) return document.querySelectorAll(scrollableSelector)[index];
      if (key.startsWith("id:")) return document.getElementById(key.slice(3));
      if (key.startsWith("table:")) return document.getElementById(key.slice(6))?.closest(scrollableSelector);
      if (key === "deck-rail") return document.querySelector(".deck-rail");
      if (key.startsWith("panel:")) {
        const panelId = key.split(":")[1] || "";
        const panel = [...document.querySelectorAll("[data-panel-id]")].find((element) => element.dataset.panelId === panelId);
        return panel?.querySelector(scrollableSelector);
      }
      return document.querySelectorAll(scrollableSelector)[index];
    }

    function clampScrollPosition(value, maxValue) {
      const number = Number(value) || 0;
      return Math.max(0, Math.min(number, Math.max(0, Number(maxValue) || 0)));
    }

    function installScrollMutationTracker() {
      const noteScroll = () => {
        if (!suppressScrollMutation) scrollMutationVersion += 1;
      };
      window.addEventListener("scroll", noteScroll, { passive: true });
      document.addEventListener("scroll", noteScroll, { capture: true, passive: true });
    }

    function withProgrammaticScroll(callback) {
      suppressScrollMutation = true;
      clearTimeout(suppressScrollMutationTimer);
      try {
        callback();
      } finally {
        suppressScrollMutationTimer = setTimeout(() => {
          suppressScrollMutation = false;
        }, 140);
      }
    }

    function setHtml(id, html) {
      const element = $(id);
      if (!element || htmlCache.get(element) === html) return false;
      htmlCache.set(element, html);
      element.innerHTML = html;
      if (element.tagName === "TABLE") wireSortableTable(element);
      return true;
    }

    function renderDashboardIssues(issues = []) {
      const element = $("dashboardIssues");
      if (!element) return;
      if (!Array.isArray(issues) || issues.length === 0) {
        element.classList.remove("visible");
        element.textContent = "";
        return;
      }
      element.classList.add("visible");
      element.innerHTML = "Some dashboard sections did not refresh: "
        + issues.slice(0, 4).map((issue) => "<strong>" + esc(issue.label) + "</strong> (" + esc(issue.message) + ")").join("; ")
        + (issues.length > 4 ? "; +" + fmt(issues.length - 4) + " more" : "");
    }

    function wireSortableTables(root = document) {
      for (const tableElement of root.querySelectorAll("table")) {
        wireSortableTable(tableElement);
      }
    }

    function wireSortableTable(tableElement) {
      if (!tableElement?.id) return;
      const headers = sortableHeaders(tableElement);
      if (!headers.length) return;
      headers.forEach((header, columnIndex) => {
        header.classList.add("sortable-header");
        header.tabIndex = 0;
        header.setAttribute("role", "button");
        header.title = "Sort by " + (header.textContent || "this column").trim();
        header.onclick = () => sortTableByColumn(tableElement, columnIndex);
        header.onkeydown = (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          sortTableByColumn(tableElement, columnIndex);
        };
      });
      const state = tableSortState[tableElement.id];
      if (state) {
        sortTableByColumn(tableElement, state.columnIndex, state.direction, { remember: false });
      } else {
        updateSortIndicators(tableElement, -1, "");
      }
    }

    function sortableHeaders(tableElement) {
      const headerRow = tableElement.tHead?.rows?.[0] || tableElement.rows?.[0];
      if (!headerRow) return [];
      return [...headerRow.cells].filter((cell) => cell.tagName === "TH");
    }

    function sortableRows(tableElement) {
      const body = tableElement.tBodies?.[0];
      if (body) return { container: body, rows: [...body.rows] };
      const rows = [...(tableElement.rows || [])];
      return { container: tableElement, rows: rows.slice(1) };
    }

    function sortTableByColumn(tableElement, columnIndex, forcedDirection = "", options = {}) {
      if (!tableElement?.id) return;
      const previous = tableSortState[tableElement.id];
      const direction = forcedDirection || (
        previous?.columnIndex === columnIndex && previous.direction === "asc" ? "desc" : "asc"
      );
      const { container, rows } = sortableRows(tableElement);
      const sortable = rows.filter((row) => row.cells.length > columnIndex);
      if (sortable.length > 1) {
        sortable
          .map((row, index) => ({ row, index, value: sortValueForCell(row.cells[columnIndex]) }))
          .sort((left, right) => compareSortValues(left.value, right.value, direction) || left.index - right.index)
          .forEach((item) => container.appendChild(item.row));
      }
      if (options.remember !== false) {
        tableSortState[tableElement.id] = { columnIndex, direction };
      }
      updateSortIndicators(tableElement, columnIndex, direction);
    }

    function sortValueForCell(cellElement) {
      const raw = String(cellElement?.dataset?.sortValue || cellElement?.textContent || "").trim();
      const text = raw.replace(/\\s+/g, " ");
      if (!text || text === "-") return { empty: true, type: "text", value: "" };
      const normalizedNumber = text.replace(/,/g, "");
      const percent = normalizedNumber.match(/^(-?\\d+(?:\\.\\d+)?)%$/);
      if (percent) return { empty: false, type: "number", value: Number(percent[1]) };
      const leadingNumber = normalizedNumber.match(/^-?\\d+(?:\\.\\d+)?/);
      if (leadingNumber) return { empty: false, type: "number", value: Number(leadingNumber[0]) };
      const parsedDate = Date.parse(text);
      if (Number.isFinite(parsedDate) && /\\d{1,4}[-/]\\d{1,2}|\\d{1,2}:\\d{2}|AM|PM/i.test(text)) {
        return { empty: false, type: "date", value: parsedDate };
      }
      return { empty: false, type: "text", value: text.toLowerCase() };
    }

    function compareSortValues(left, right, direction) {
      if (left.empty || right.empty) {
        if (left.empty && right.empty) return 0;
        return left.empty ? 1 : -1;
      }
      let result = 0;
      if (left.type === right.type) {
        if (left.type === "text") result = left.value.localeCompare(right.value);
        else result = left.value - right.value;
      } else {
        result = String(left.value).localeCompare(String(right.value));
      }
      return direction === "desc" ? -result : result;
    }

    function updateSortIndicators(tableElement, columnIndex, direction) {
      sortableHeaders(tableElement).forEach((header, index) => {
        const active = index === columnIndex && direction;
        header.classList.toggle("sort-asc", active && direction === "asc");
        header.classList.toggle("sort-desc", active && direction === "desc");
        header.setAttribute("aria-sort", active ? (direction === "asc" ? "ascending" : "descending") : "none");
      });
    }

    function initPanelLayout() {
      // The coach-hub layout is intentionally fixed around deck, matchup, and deck-advice zones.
    }

    function dashboardPanels() {
      return [...$("dashboardLayout").querySelectorAll(".dashboard-panel")];
    }

    function applySavedPanelLayout() {
      const layout = loadPanelLayout();
      if (!layout) return;
      const panelsById = Object.fromEntries(dashboardPanels().map((panel) => [panel.dataset.panelId, panel]));
      for (const id of layout.order || []) {
        if (panelsById[id]) $("dashboardLayout").appendChild(panelsById[id]);
      }
      for (const [id, size] of Object.entries(layout.sizes || {})) {
        const panel = panelsById[id];
        if (!panel) continue;
        if (size.width) panel.style.width = size.width;
        if (size.height) panel.style.height = size.height;
      }
    }

    function loadPanelLayout() {
      try {
        const raw = localStorage.getItem(layoutStorageKey);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    }

    function schedulePanelLayoutSave() {
      clearTimeout(layoutSaveTimer);
      layoutSaveTimer = setTimeout(savePanelLayout, 250);
    }

    function savePanelLayout() {
      const layout = {
        order: dashboardPanels().map((panel) => panel.dataset.panelId),
        sizes: Object.fromEntries(dashboardPanels().map((panel) => [
          panel.dataset.panelId,
          panelSize(panel)
        ]))
      };
      try {
        localStorage.setItem(layoutStorageKey, JSON.stringify(layout));
      } catch {
        // Layout persistence is best-effort.
      }
    }

    function resetPanelLayout() {
      try {
        localStorage.removeItem(layoutStorageKey);
        localStorage.removeItem(deckOrderStorageKey);
      } catch {
        // Layout persistence is best-effort.
      }
      location.reload();
    }

    function clearDropTargets() {
      for (const panel of dashboardPanels()) panel.classList.remove("drop-target", "dragging");
    }

    function panelSize(panel) {
      const rect = panel.getBoundingClientRect();
      return {
        width: rect.width ? Math.round(rect.width) + "px" : "",
        height: rect.height ? Math.round(rect.height) + "px" : ""
      };
    }

    function renderRuns(rows) {
      table("runs", ["Run","Mode","W/L/I","Win","Score","Base","Promote","Updated"], rows.map((run) => [
        cell(run.id, run.path),
        esc(run.mode || "-"),
        run.result ? run.result.wins + "/" + run.result.losses + "/" + run.result.incomplete : "-",
        run.result ? pct(run.result.winRate) : "-",
        run.result?.score?.toFixed ? run.result.score.toFixed(1) : "-",
        run.baseline?.score?.toFixed ? run.baseline.score.toFixed(1) : "-",
        promoteText(run),
        shortDate(run.updatedAt)
      ]));
    }

    function renderLoopHealth(health) {
      if (!health) return;
      $("loopHealthStatus").innerHTML = statusCell(health.label || "Unknown", loopHealthClass(health.status));
      $("loopHealthSession").textContent = health.session || "-";
      $("loopHealthCycle").textContent = health.currentCycle
        ? health.currentCycle.job
          ? "Job " + health.currentCycle.job + " / " + (health.currentCycle.taskType || "task") + " / " + (health.currentCycle.status || "running")
          : "Cycle " + health.currentCycle.cycle + " / " + (health.currentCycle.status || "running")
        : "-";
      $("loopHealthCaption").textContent = health.log?.updatedAt
        ? "log updated " + shortDate(health.log.updatedAt)
        : "no dashboard log";
      list("loopHealthNotes", health.notes, "No active loop health notes.");
      const artifacts = [
        health.loopStatePath ? "Loop state: " + health.loopStatePath : "",
        health.latestHandoffPath ? "Latest handoff: " + health.latestHandoffPath : "",
        health.lastMatchupImpact?.path ? "Last matchup impact: " + health.lastMatchupImpact.path : "",
        health.failure?.path ? "Failure: " + health.failure.path : "",
        health.log?.path ? "Log: " + health.log.path : ""
      ].filter(Boolean);
      list("loopHealthArtifacts", artifacts, "No loop artifacts yet.");
      renderMatchupImpact(health.lastMatchupImpact);
    }

    function renderTrainingReadiness(profiles, health) {
      const summary = trainingReadinessSummary(profiles, health);
      $("trainingReadinessCaption").textContent = fmt(summary.total) + " deck profile(s), "
        + fmt(summary.trainedBaselines) + " trained baseline(s), "
        + fmt(summary.readyMl) + " trusted ML model(s)";
      $("trainingStage").textContent = summary.stage;
      $("trainingStage").className = "stage-label " + summary.tone;
      $("trainingStageNote").textContent = summary.note;
      setMetric("readinessBaselines", fmt(summary.trainedBaselines) + "/" + fmt(summary.total), summary.baselineTone);
      setMetric("readinessMl", fmt(summary.readyMl) + "/" + fmt(summary.total), summary.mlTone);
      setMetric("readinessMatchups", fmt(summary.matchupGames) + " games", summary.matchupTone);
      setMetric("readinessExperiments", fmt(summary.deckExperiments), summary.experimentTone);
      setMetric("readinessLoop", summary.loopLabel, loopHealthClass(health?.status || "idle"));
      list("readinessQueue", summary.queue, "No deck profiles are loaded.");
      list("readinessGates", summary.gates, "No training gates available.");
      list("readinessWarnings", summary.warnings, "No current dashboard warnings.");
    }

    function trainingReadinessSummary(profiles, health) {
      const rows = Array.isArray(profiles) ? profiles : [];
      const total = rows.length;
      const trainedBaselines = rows.filter(profileHasTrainedBaseline).length;
      const seededBaselines = rows.filter(profileHasSeedBaseline).length;
      const missingBaselines = Math.max(0, total - trainedBaselines - seededBaselines);
      const readyMl = rows.filter(profileActionModelReady).length;
      const profileMl = rows.filter((profile) => profile?.actionModel?.exists && profile.actionModel.source === "profile").length;
      const matchupGames = rows.reduce((sum, profile) => sum + profileMatchupGames(profile), 0);
      const matchupBuckets = rows.reduce((sum, profile) => sum + Number(profile?.matchupStats?.length || 0), 0);
      const matchupReadyProfiles = rows.filter((profile) => profileMatchupGames(profile) >= 50).length;
      const deckExperiments = rows.reduce((sum, profile) => sum + Number(profile?.deckExperiments?.length || 0), 0);
      const selected = selectedProfile();
      const warnings = [];
      let stage = "No Deck Profiles";
      let tone = "warn";
      let note = "Load saved decks before starting training.";
      if (total > 0 && (missingBaselines > 0 || seededBaselines > 0)) {
        stage = "Baseline Building";
        tone = missingBaselines > 0 ? "bad" : "warn";
        note = fmt(missingBaselines) + " deck(s) need a baseline and " + fmt(seededBaselines) + " seed baseline(s) need real training.";
      } else if (total > 0 && readyMl < total) {
        stage = "Profile ML Building";
        tone = "warn";
        note = fmt(total - readyMl) + " deck(s) need trusted profile ML before matchup/deck-edit reads are reliable.";
      } else if (total > 0 && matchupReadyProfiles < total) {
        stage = "Matchup Refinement";
        tone = "warn";
        note = fmt(total - matchupReadyProfiles) + " deck(s) need at least a first credible matchup sample.";
      } else if (total > 0) {
        stage = "Deck Experiment Ready";
        tone = "good";
        note = "Baselines, trusted ML, and matchup samples are in place. Controlled deck experiments are now the next high-value layer.";
      }

      if (missingBaselines > 0) warnings.push(fmt(missingBaselines) + " deck profile(s) have no trained baseline.");
      if (readyMl === 0 && total > 0) warnings.push("No selected deck has a trusted profile ML model yet, so card pros/cons are still early.");
      if (matchupGames === 0 && total > 0) warnings.push("Matchup panels are setup-only until focused matchup games are recorded.");
      if (selected && !profileHasTrainedBaseline(selected)) warnings.push((selected.name || selected.id) + " is selected, but its baseline is not trained.");
      if (health?.status === "error" || health?.status === "failed") warnings.push("The loop health panel is reporting a failed state. Review the log before starting another run.");
      if (health?.log?.stale && !health?.alive) warnings.push("The loop is idle and the log is stale; that is normal after a stopped run, but not during active training.");

      return {
        total,
        trainedBaselines,
        seededBaselines,
        missingBaselines,
        readyMl,
        profileMl,
        matchupGames,
        matchupBuckets,
        matchupReadyProfiles,
        deckExperiments,
        stage,
        tone,
        note,
        baselineTone: total > 0 && trainedBaselines === total ? "good" : missingBaselines > 0 ? "bad" : "warn",
        mlTone: total > 0 && readyMl === total ? "good" : readyMl > 0 ? "warn" : "bad",
        matchupTone: matchupGames > 0 ? "warn" : "bad",
        experimentTone: deckExperiments > 0 ? "good" : "warn",
        loopLabel: health?.label || (lastRunning ? "Running" : "Idle"),
        queue: trainingReadinessQueue(rows),
        gates: [
          "Baselines: " + fmt(trainedBaselines) + "/" + fmt(total) + " trained, " + fmt(seededBaselines) + " seed, " + fmt(missingBaselines) + " missing.",
          "Profile ML: " + fmt(readyMl) + "/" + fmt(total) + " trusted, " + fmt(profileMl) + " profile model file(s) present.",
          "Matchups: " + fmt(matchupGames) + " game(s) across " + fmt(matchupBuckets) + " archetype bucket(s).",
          "Deck experiments: wait for trained baseline, trusted profile ML, and credible matchup evidence."
        ],
        warnings
      };
    }

    function trainingReadinessQueue(profiles) {
      return [...(profiles || [])]
        .sort((a, b) => baselinePriorityRank(a) - baselinePriorityRank(b)
          || String(a.name || a.id).localeCompare(String(b.name || b.id)))
        .slice(0, 6)
        .map((profile) => deckRailLabel(profile) + ": " + profileNextTrainingAction(profile));
    }

    function setMetric(id, value, tone = "") {
      const element = $(id);
      element.textContent = value;
      element.className = "value " + (tone || "");
    }

    function profileHasTrainedBaseline(profile) {
      const status = baselineStatusForProfile(profile);
      return status.label === "Ready";
    }

    function profileHasSeedBaseline(profile) {
      const status = baselineStatusForProfile(profile);
      return status.label === "Seed" || status.label === "Legacy";
    }

    function profileActionModelReady(profile) {
      return profileActionModelSummary(profile).ready;
    }

    function profileActionModelSummary(profile) {
      const model = profile?.actionModel;
      if (!model?.exists) return { label: "Needed", tone: "warn", ready: false, exists: false };
      const label = modelExampleText(model);
      if (model.source === "fallback") return { label: label + " global", tone: "warn", ready: false, exists: true };
      const runtime = model.runtimeReadiness || model.learning?.runtimeReadiness;
      if (runtime && !runtime.ready) {
        return { label: (runtime.label || "Collecting Evidence") + " / " + label, tone: "warn", ready: false, exists: true };
      }
      const validation = model?.validation || model?.learning?.validation;
      const heldoutGames = Number(validation?.heldoutPlayerGames || 0);
      const signalTrust = Number(model?.learningSignalTrust ?? model?.learning?.learningSignalTrust ?? (Number(model?.learningSignalVersion ?? 1) >= 2 ? 1 : 0.25));
      if (!validation || heldoutGames < 8 || signalTrust < 0.75) {
        return { label: "Provisional / " + label, tone: "warn", ready: false, exists: true };
      }
      return { label, tone: "good", ready: true, exists: true };
    }

    function setPanelEmpty(panelId, empty, message) {
      const panel = document.querySelector("[data-panel-id='" + panelId + "']");
      if (!panel) return;
      panel.classList.toggle("compact-empty", Boolean(empty));
      let note = [...panel.children].find((child) => child.classList?.contains("empty-panel-note"));
      if (!note) {
        note = document.createElement("div");
        note.className = "empty-panel-note";
        panel.appendChild(note);
      }
      note.textContent = message || "";
    }

    function renderMatchupImpact(impact) {
      const summary = impact?.summary;
      $("matchupImpactTitle").textContent = impact?.title || "Last Matchup Impact";
      $("matchupImpactSub").textContent = impact
        ? [impact.subtitle, impact.ownKey, impact.updatedAt ? "updated " + shortDate(impact.updatedAt) : ""].filter(Boolean).join(" / ")
        : "No completed matchup validation yet.";
      $("matchupImpactVerdict").innerHTML = statusCell(matchupImpactLabel(summary), matchupImpactClass(summary));
      $("matchupImpactUpdates").textContent = fmt(summary?.updates);
      $("matchupImpactPositive").textContent = fmt(summary?.positive);
      $("matchupImpactNegative").textContent = fmt(summary?.negative);
      $("matchupImpactInconclusive").textContent = fmt(summary?.inconclusive);
      $("matchupImpactRollbacks").textContent = fmt(summary?.rolledBack);
      $("matchupImpactWinDelta").innerHTML = signedValueCell(summary?.avgWinRateDelta, { percent: true });
      $("matchupImpactLifeDelta").innerHTML = signedValueCell(summary?.avgLifeDiffDelta);
      const rows = Array.isArray(impact?.rows) ? impact.rows : [];
      table("matchupImpactRows", ["Matchup","Verdict","Layer Review","Exposure","Profile","Games","Win Delta","Life Delta","Score Delta","File"], rows.map((row) => [
        esc(row.opponents?.join(", ") || row.ownKey || "-"),
        statusCell(row.verdict || "unknown", row.verdict === "positive" ? "good" : row.verdict === "negative" ? "bad" : "warn"),
        esc([row.actionVerdict ? "Action " + row.actionVerdict : "", row.overlayVerdict ? "Overlay " + row.overlayVerdict : ""].filter(Boolean).join(" / ") || row.comparedArtifact || "-"),
        Number(row.minimumCandidateOverlayDecisions ?? 0) > 0
          ? fmt(row.candidateOverlayDecisionCount) + "/" + fmt(row.minimumCandidateOverlayDecisions)
          : "-",
        row.rolledBack ? statusCell("Rolled Back", "bad") : statusCell("Kept", row.verdict === "positive" ? "good" : "warn"),
        fmt(row.games),
        signedValueCell(row.winRateDelta, { percent: true }),
        signedValueCell(row.avgLifeDiffDelta),
        signedValueCell(row.scoreDelta),
        row.path ? cell("json", row.path) : "-"
      ]));
    }

    function matchupImpactLabel(summary) {
      if (!summary || Number(summary.updates ?? 0) <= 0) return "No Data";
      if (Number(summary.rolledBack ?? 0) > 0 && Number(summary.positive ?? 0) === 0) return "Rolled Back";
      if (Number(summary.negative ?? 0) > 0 && Number(summary.positive ?? 0) === 0) return "Regressed";
      if (Number(summary.positive ?? 0) > Number(summary.negative ?? 0)) return "Improved";
      if (Number(summary.negative ?? 0) > Number(summary.positive ?? 0)) return "Mixed Down";
      if (Number(summary.safeNoRuntimeChange ?? 0) > 0) return "Evidence Retained";
      return "Inconclusive";
    }

    function matchupImpactClass(summary) {
      const label = matchupImpactLabel(summary);
      if (label === "Improved") return "good";
      if (label === "Regressed" || label === "Mixed Down" || label === "Rolled Back") return "bad";
      return "warn";
    }

    function signedValueCell(value, { percent = false } = {}) {
      const number = Number(value);
      if (!Number.isFinite(number)) return "-";
      const label = percent
        ? (number >= 0 ? "+" : "") + (number * 100).toFixed(1) + "%"
        : (number >= 0 ? "+" : "") + number.toFixed(Math.abs(number) >= 100 ? 1 : 2);
      const className = number > 0 ? "good" : number < 0 ? "bad" : "warn";
      return "<span class=\\\"" + className + "\\\">" + esc(label) + "</span>";
    }

    function loopHealthClass(status) {
      if (status === "running") return "good";
      if (status === "stopped" || status === "idle") return "warn";
      return "bad";
    }

    function renderOverallDeckRankings(ranking) {
      const rows = Array.isArray(ranking?.rows) ? ranking.rows : [];
      const leader = rows.find((row) => row.rank === 1);
      const leaderText = leader
        ? " Leader: " + leader.deckName + " (" + pct(leader.rankScore) + ")."
        : "";
      $("deckRankingCaption").textContent = fmt(ranking?.rankedDecks || 0) + "/" + fmt(ranking?.totalDecks || rows.length)
        + " ranked, " + fmt(ranking?.completedGames || 0) + " completed games, "
        + fmt(ranking?.coverageTarget || 0) + " matchup coverage target." + leaderText
        + " Rank Score uses a 95% confidence floor.";
      const headers = [
        "Rank",
        "Deck",
        "Type",
        "Baseline",
        "Rank Score",
        "Completed Win",
        "W/L/I",
        "Completion",
        "Avg Life",
        "Turn Cycles",
        "Matchups",
        "Best Matchup",
        "Worst Matchup",
        "Evidence"
      ];
      const head = "<thead><tr>" + headers.map((header) => "<th>" + esc(header) + "</th>").join("") + "</tr></thead>";
      const body = "<tbody>" + rows.map((row) => {
        const selected = row.deckId === selectedDeckId ? ' class="selected"' : "";
        const rankScoreTone = row.rankScore === null
          ? "warn"
          : row.rankScore >= 0.5 ? "good" : row.rankScore >= 0.35 ? "warn" : "bad";
        const winTone = row.winRate === null
          ? "warn"
          : row.winRate >= 0.5 ? "good" : row.winRate >= 0.4 ? "warn" : "bad";
        const baselineTone = row.baselineReady ? "good" : "warn";
        const evidenceTitle = row.evidenceReason ? ' title="' + esc(row.evidenceReason) + '"' : "";
        return '<tr data-deck-id="' + esc(row.deckId) + '"' + selected + ">"
          + '<td data-sort-value="' + (row.rank ?? 999999) + '"><strong>' + (row.rank ?? "-") + "</strong></td>"
          + '<td>' + esc(row.deckName) + '<div class="path">' + esc(row.ownKey) + "</div></td>"
          + "<td>" + esc(row.deckType || "-") + "</td>"
          + "<td>" + statusCell(row.baselineStatus || "Needed", baselineTone) + "</td>"
          + '<td data-sort-value="' + (row.rankScore ?? -1) + '">' + statusCell(row.rankScore === null ? "Unranked" : pct(row.rankScore), rankScoreTone) + "</td>"
          + '<td data-sort-value="' + (row.winRate ?? -1) + '">' + statusCell(row.winRate === null ? "-" : pct(row.winRate), winTone) + "</td>"
          + '<td data-sort-value="' + Number(row.completedGames || 0) + '">' + fmt(row.wins) + "/" + fmt(row.losses) + "/" + fmt(row.incomplete) + "</td>"
          + '<td data-sort-value="' + Number(row.completionRate || 0) + '">' + pct(row.completionRate || 0) + "</td>"
          + '<td data-sort-value="' + (row.avgLifeDiff ?? -999) + '">' + signedValueCell(row.avgLifeDiff) + "</td>"
          + '<td data-sort-value="' + (row.avgTurnCycles ?? 999) + '">' + (Number.isFinite(Number(row.avgTurnCycles)) ? Number(row.avgTurnCycles).toFixed(2) : "-") + "</td>"
          + '<td data-sort-value="' + Number(row.coverageRate || 0) + '">' + fmt(row.matchupBuckets) + "/" + fmt(row.coverageTarget) + "</td>"
          + '<td data-sort-value="' + (row.strongestMatchup?.winRate ?? -1) + '">' + rankingMatchupCell(row.strongestMatchup) + "</td>"
          + '<td data-sort-value="' + (row.weakestMatchup?.winRate ?? -1) + '">' + rankingMatchupCell(row.weakestMatchup) + "</td>"
          + '<td data-sort-value="' + Number(row.completedGames || 0) + '"><span class="' + esc(row.evidenceTone || "warn") + '"' + evidenceTitle + ">" + esc(row.evidenceLabel || "Unranked") + "</span></td>"
          + "</tr>";
      }).join("") + "</tbody>";
      if (setHtml("deckRankings", head + body)) {
        for (const row of $("deckRankings").querySelectorAll("tbody tr")) {
          row.onclick = () => selectDeck(row.dataset.deckId);
        }
      }
    }

    function rankingMatchupCell(matchup) {
      if (!matchup) return "-";
      return esc(matchup.label || matchup.key || "Unknown")
        + " <strong>" + pct(matchup.winRate) + "</strong>"
        + '<div class="path">' + fmt(matchup.completedGames) + " completed</div>";
    }

    function renderBaselineTracker(profiles) {
      const rows = [...(profiles || [])].sort((a, b) => {
        const aPriority = baselinePriorityRank(a);
        const bPriority = baselinePriorityRank(b);
        return aPriority - bPriority
          || String(a.name || a.id).localeCompare(String(b.name || b.id));
      });
      const ready = rows.filter((profile) => profile.baselinePolicy?.exists && !profile.baselinePolicy?.needsTraining).length;
      const seeded = rows.filter((profile) => profile.baselinePolicy?.needsTraining).length;
      const profileModels = rows.filter((profile) => profile.actionModel?.exists && profile.actionModel?.source === "profile").length;
      const totalMatchupGames = rows.reduce((total, profile) => total + profileMatchupGames(profile), 0);
      $("baselineTrackerCaption").textContent = fmt(ready) + "/" + fmt(rows.length) + " trained baselines, "
        + (seeded ? fmt(seeded) + " seed(s), " : "")
        + fmt(profileModels) + " profile ML models, " + fmt(totalMatchupGames) + " matchup games";
      const headers = ["Deck","Profile","Baseline","ML","Runs","Matchups","Weakest","Card Evidence","Next Action"];
      const head = "<thead><tr>" + headers.map((h) => "<th>" + esc(h) + "</th>").join("") + "</tr></thead>";
      const body = "<tbody>" + rows.map((profile) => {
        const selected = profile.id === selectedDeckId ? " class=\\"selected\\"" : "";
        const weakest = weakestMatchup(profile);
        const baselineStatus = baselineStatusForProfile(profile);
        return "<tr data-deck-id=\\"" + esc(profile.id) + "\\"" + selected + ">"
          + "<td>" + cell(profile.name || profile.id, profile.path) + "</td>"
          + "<td>" + esc(profile.ownKey || "-") + "</td>"
          + "<td>" + statusCell(baselineStatus.label, baselineStatus.tone) + "</td>"
          + "<td>" + profileModelStatusCell(profile) + "</td>"
          + "<td>" + fmt(profileRunCount(profile)) + "</td>"
          + "<td>" + fmt(profileMatchupGames(profile)) + " / " + fmt((profile.matchupStats || []).length) + " buckets</td>"
          + "<td>" + (weakest ? esc(weakest.opponentLabel || weakest.opponentKey) + " " + pct(weakest.winRate) : "-") + "</td>"
          + "<td>" + fmt(profile.cardEvidence?.cardLinkedRows || 0) + " decisions</td>"
          + "<td>" + esc(profileNextTrainingAction(profile)) + "</td>"
          + "</tr>";
      }).join("") + "</tbody>";
      if (setHtml("deckBaselineTracker", head + body)) {
        for (const row of $("deckBaselineTracker").querySelectorAll("tbody tr")) {
          row.onclick = () => selectDeck(row.dataset.deckId);
        }
      }
    }

    function baselinePriorityRank(profile) {
      if (!profile?.baselinePolicy?.exists) return 0;
      if (profile?.baselinePolicy?.needsTraining) return 1;
      if (!profileActionModelReady(profile)) return 2;
      if (profileMatchupGames(profile) < 50) return 3;
      if (weakestMatchup(profile)?.winRate < 0.45) return 4;
      if (profile?.advice?.editReadiness?.status === "not-ready") return 5;
      return 6;
    }

    function profileNextTrainingAction(profile) {
      if (baselineStatusForProfile(profile).label === "Review") return "Review archetype routing before training";
      if (!profile?.baselinePolicy?.exists) return "Run Deck Training or All Baselines";
      if (profile?.baselinePolicy?.needsTraining) return "Train seeded baseline";
      if (!profileActionModelReady(profile)) return "Run Deck Training for profile ML";
      const matchupGames = profileMatchupGames(profile);
      if (matchupGames < 50) return "Run focused Matchup Training";
      const weak = weakestMatchup(profile);
      if (weak && Number(weak.winRate) < 0.45) return "Train weakest matchup: " + (weak.opponentLabel || weak.opponentKey);
      if (profile?.advice?.editReadiness?.status === "not-ready") return "Collect more matchup evidence";
      return "Ready for controlled deck-change tests";
    }

    function baselineStatusForProfile(profile) {
      const resolutionStatus = profile?.archetypeResolution?.status || "";
      if (resolutionStatus === "new-archetype-needed" || resolutionStatus === "ambiguous") {
        return { label: "Review", tone: "warn" };
      }
      const baseline = profile?.baselinePolicy;
      if (!baseline?.exists) return { label: "Needed", tone: "warn" };
      if (baseline.layout === "legacy") return { label: "Legacy", tone: "warn" };
      if (baseline.needsTraining) return { label: "Seed", tone: "warn" };
      return { label: "Ready", tone: "good" };
    }

    function profileModelStatusCell(profile) {
      const summary = profileActionModelSummary(profile);
      return statusCell(summary.label, summary.tone);
    }

    function modelExampleText(model) {
      if (!model?.exists && model?.examples === undefined) return "-";
      const examples = Number(model?.examples ?? 0);
      const pairwise = Number(model?.pairwiseExamples ?? model?.learning?.pairwiseExamples ?? 0);
      const pairwiseMass = Number(model?.pairwiseEffectiveWeight ?? model?.learning?.pairwiseEffectiveWeight ?? 0);
      const effective = Number(model?.effectiveExamples ?? model?.exampleWeightTotal ?? model?.learning?.effectiveExamples ?? 0);
      const selected = Number(model?.selectedExamples ?? model?.learning?.selectedExamples ?? 0);
      const mode = model?.learningMode || model?.learning?.learningMode || "";
      const signalTrust = Number(model?.learningSignalTrust ?? model?.learning?.learningSignalTrust ?? (Number(model?.learningSignalVersion ?? 1) >= 2 ? 1 : 0.25));
      const pairwiseTarget = Number(model?.runtimeReadiness?.thresholds?.pairwiseExamples ?? model?.learning?.runtimeReadiness?.thresholds?.pairwiseExamples ?? 30);
      const parts = [fmt(examples) + " examples"];
      if (effective > 0 && Math.abs(effective - examples) >= 1) parts.push(fmt(Math.round(effective)) + " effective");
      if (signalTrust < 0.999) parts.push(Math.round(signalTrust * 100) + "% signal trust");
      const validation = model?.validation || model?.learning?.validation;
      if (Number(validation?.heldoutPlayerGames || 0) > 0) {
        parts.push(fmt(validation.heldoutPlayerGames) + " held-out games");
      }
      const pairwiseAccuracy = validation?.pairwiseSignAccuracy;
      if (pairwiseAccuracy !== null && pairwiseAccuracy !== undefined && Number.isFinite(Number(pairwiseAccuracy))) {
        parts.push(Math.round(Number(pairwiseAccuracy) * 100) + "% pairwise accuracy");
      } else {
        const balancedAccuracy = validation?.anchorBalancedSignAccuracy;
        if (balancedAccuracy !== null && balancedAccuracy !== undefined && Number.isFinite(Number(balancedAccuracy))) {
          parts.push(Math.round(Number(balancedAccuracy) * 100) + "% balanced accuracy");
        }
      }
      const inputConsistency = validation?.inputConsistency
        || validation?.pairwise?.inputConsistency
        || model?.runtimeReadiness?.validationInputConsistency
        || model?.learning?.runtimeReadiness?.validationInputConsistency;
      if (inputConsistency?.gateEligible) {
        parts.push(Math.round(Number(inputConsistency.conflictRate ?? 0) * 100) + "% irreducible input conflict");
      } else if (Number(inputConsistency?.repeatedExamples ?? 0) > 0) {
        parts.push(fmt(inputConsistency.repeatedExamples) + " repeated inputs collecting");
      }
      const validationDiversity = validation?.pairwiseValidationDiversity;
      if (Number(validationDiversity?.trackedExamples ?? 0) > 0) {
        const validationPairMinimum = Number(
          model?.runtimeReadiness?.thresholds?.validationActionPairExamples
          ?? model?.learning?.runtimeReadiness?.thresholds?.validationActionPairExamples
          ?? 5
        );
        const reliability = (validationDiversity.actionPairReliability || [])
          .filter((row) => Number(row.examples || 0) >= validationPairMinimum)
          .map((row) => Number(row.signAccuracy))
          .filter(Number.isFinite);
        parts.push(
          fmt(validationDiversity.trackedExamples) + " held-out breadth: "
          + fmt(Object.keys(validationDiversity.playerGameCounts || {}).filter((key) => key !== "unknown").length) + " games, "
          + fmt(Object.keys(validationDiversity.phaseCounts || {}).filter((key) => key !== "unknown").length) + " phases, "
          + fmt(Object.keys(validationDiversity.actionPairCounts || {}).length) + " pairs, "
          + fmt(Object.keys(validationDiversity.opponentProfileCounts || {}).filter((key) => key !== "unknown").length) + " opponents"
        );
        if (reliability.length > 0) {
          const supportedRows = (validationDiversity.actionPairReliability || [])
            .filter((row) => Number(row.examples || 0) >= validationPairMinimum);
          const fewestGames = Math.min(...supportedRows.map((row) => Number(row.distinctPlayerGames || 0)));
          parts.push(Math.round(Math.min(...reliability) * 100) + "% weakest supported pair");
          parts.push(fmt(fewestGames) + " minimum games per supported pair");
        }
      }
      if (pairwiseTarget > 0 && pairwise < pairwiseTarget) parts.push(fmt(pairwise) + "/" + fmt(pairwiseTarget) + " pairwise");
      else if (pairwise > 0) parts.push(fmt(pairwise) + " pairwise");
      else if (selected > 0 && selected !== examples) parts.push(fmt(selected) + " chosen");
      if (pairwise > 0) parts.push(pairwiseMass.toFixed(2) + " effective pairwise weight");
      const diversity = model?.evidenceDiversity
        || model?.runtimeReadiness?.evidenceDiversity
        || model?.learning?.evidenceDiversity
        || model?.learning?.runtimeReadiness?.evidenceDiversity;
      if (Number(diversity?.trackedExamples ?? 0) > 0) {
        parts.push(
          fmt(diversity.trackedExamples) + " breadth-tracked: "
          + fmt(diversity.distinctPhases) + " phases, "
          + fmt(diversity.distinctActionPairs) + " pairs, "
          + fmt(diversity.distinctOpponentProfiles) + " opponents"
        );
      }
      const duplicatesSkipped = Number(model?.duplicateLearningUnitsSkipped ?? model?.learning?.duplicateLearningUnitsSkipped ?? 0);
      if (duplicatesSkipped > 0) parts.push(fmt(duplicatesSkipped) + " duplicates ignored");
      if (mode) parts.push(mode);
      return parts.join(" / ");
    }

    function statusCell(label, className) {
      return "<span class=\\"" + esc(className) + "\\">" + esc(label) + "</span>";
    }

    function profileRunCount(profile) {
      return Number(profile?.advice?.evidence?.completedRuns ?? 0);
    }

    function profileMatchupGames(profile) {
      return (profile?.matchupStats ?? []).reduce((total, row) => total + completedMatchupGames(row), 0);
    }

    function completedMatchupGames(row = {}) {
      if (row.completedGames !== undefined && row.completedGames !== null) {
        return Math.max(0, Number(row.completedGames) || 0);
      }
      if (row.wins !== undefined || row.losses !== undefined) {
        return Math.max(0, Number(row.wins ?? 0) + Number(row.losses ?? 0));
      }
      return Math.max(0, Number(row.games ?? 0) - Number(row.incomplete ?? 0));
    }

    function weakestMatchup(profile) {
      const rows = (profile?.matchupStats ?? []).filter((row) => completedMatchupGames(row) > 0);
      if (rows.length === 0) return null;
      return [...rows].sort((a, b) => Number(a.winRate ?? 1) - Number(b.winRate ?? 1)
        || completedMatchupGames(b) - completedMatchupGames(a))[0];
    }

    function renderDeckOptions(decks, controllerDeck) {
      const select = $("deck");
      const selected = select.value || controllerDeck || "carnerr-spear";
      const signature = decks.map((deck) => deck.id + ":" + (deck.updatedAt || "")).join("|");
      if (select.dataset.signature !== signature) {
        select.innerHTML = decks.map((deck) => {
          const label = deck.label || deck.name || deck.id;
          const title = [deck.id, deck.path].filter(Boolean).join(" | ");
          return "<option value=\\"" + esc(deck.id) + "\\" title=\\"" + esc(title) + "\\" data-own-key=\\"" + esc(deck.ownKey || "") + "\\">" + esc(label) + "</option>";
        }).join("");
        select.dataset.signature = signature;
      }
      if ([...select.options].some((option) => option.value === selected)) {
        select.value = selected;
      } else if (select.options.length > 0) {
        select.selectedIndex = 0;
      }
      selectedDeckId = select.value;
      if (!ownKeyTouched && select.value !== lastDeckValue) syncOwnKeyFromDeck();
      lastDeckValue = select.value;
    }

    function renderDeckTabs(profiles) {
      if (!selectedDeckId && profiles.length > 0) selectedDeckId = profiles[0].id;
      const orderedProfiles = applySavedDeckOrder(profiles);
      const html = orderedProfiles.map((profile, index) => {
        const active = profile.id === selectedDeckId ? " active" : "";
        const resolutionStatus = profile.archetypeResolution?.status || "";
        const archetypeNeedsDecision = resolutionStatus === "new-archetype-needed" || resolutionStatus === "ambiguous";
        const hasBaseline = Boolean(profile.baselinePolicy?.exists) && !archetypeNeedsDecision;
        const baselineSeed = hasBaseline && Boolean(profile.baselinePolicy?.needsTraining);
        const baselineClass = hasBaseline ? baselineSeed ? "seed" : "ready" : "needed";
        const baselineLabel = hasBaseline ? baselineSeed ? "SEED" : "BASELINE" : "BASELINE";
        const mlStatus = deckRailMlStatus(profile);
        const matchupStatus = deckRailMatchupStatus(profile);
        const upDisabled = index === 0 ? " disabled" : "";
        const downDisabled = index === orderedProfiles.length - 1 ? " disabled" : "";
        const label = deckRailLabel(profile);
        const title = [
          profile.name || profile.id,
          profile.ownKey ? "Set/color: " + profile.ownKey : null,
          archetypeNeedsDecision ? "Archetype needs review" : hasBaseline ? baselineSeed ? "Baseline seed needs training" : "Baseline ready" : "Baseline needed",
          mlStatus.title,
          matchupStatus.title
        ].filter(Boolean).join(" | ");
        return "<div class=\\"deck-tab-row\\" draggable=\\"true\\" data-deck-id=\\"" + esc(profile.id) + "\\">"
          + "<button type=\\"button\\" class=\\"deck-tab" + active + "\\" data-deck-id=\\"" + esc(profile.id) + "\\" title=\\"" + esc(title) + "\\">"
          + "<span class=\\"name\\">" + esc(label) + "</span>"
          + "<span class=\\"sub status-badges\\">"
          + "<span class=\\"baseline-marker " + baselineClass + "\\">" + baselineLabel + "</span>"
          + "<span class=\\"status-marker " + mlStatus.className + "\\">" + esc(mlStatus.label) + "</span>"
          + "<span class=\\"status-marker " + matchupStatus.className + "\\">" + esc(matchupStatus.label) + "</span>"
          + "</span></button>"
          + "<span class=\\"deck-move\\">"
          + "<button type=\\"button\\" class=\\"deck-move-btn\\" data-move=\\"-1\\" data-deck-id=\\"" + esc(profile.id) + "\\"" + upDisabled + " title=\\"Move up\\">^</button>"
          + "<button type=\\"button\\" class=\\"deck-move-btn\\" data-move=\\"1\\" data-deck-id=\\"" + esc(profile.id) + "\\"" + downDisabled + " title=\\"Move down\\">v</button>"
          + "</span></div>";
      }).join("");
      if (!setHtml("deckTabs", html)) return;
      for (const button of $("deckTabs").querySelectorAll(".deck-tab")) {
        button.onclick = () => {
          if (deckDragMoved) {
            deckDragMoved = false;
            return;
          }
          selectDeck(button.dataset.deckId);
        };
      }
      for (const button of $("deckTabs").querySelectorAll(".deck-move-btn")) {
        button.onclick = (event) => {
          event.stopPropagation();
          moveDeckRail(button.dataset.deckId, Number(button.dataset.move));
        };
      }
      for (const row of $("deckTabs").querySelectorAll(".deck-tab-row")) {
        row.addEventListener("dragstart", (event) => {
          draggedDeckId = row.dataset.deckId || "";
          deckDragMoved = false;
          row.classList.add("dragging");
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", draggedDeckId);
        });
        row.addEventListener("dragover", (event) => {
          if (!draggedDeckId || draggedDeckId === row.dataset.deckId) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          const after = deckDropAfter(row, event);
          row.classList.add("drop-target");
          row.classList.toggle("drop-before", !after);
          row.classList.toggle("drop-after", after);
        });
        row.addEventListener("dragleave", () => row.classList.remove("drop-target", "drop-before", "drop-after"));
        row.addEventListener("drop", (event) => {
          event.preventDefault();
          const targetDeckId = row.dataset.deckId || "";
          reorderDeckRail(draggedDeckId, targetDeckId, deckDropAfter(row, event));
          deckDragMoved = true;
          setTimeout(() => { deckDragMoved = false; }, 250);
          clearDeckDragState();
        });
        row.addEventListener("dragend", clearDeckDragState);
      }
    }

    function deckRailLabel(profile) {
      const raw = String(profile?.name || profile?.id || "").trim();
      const normalized = raw.toLowerCase();
      if (normalized.startsWith("engine - ") || normalized.startsWith("engine-")) {
        const cleaned = raw
          .replace(/^engine[-_ ]*/iu, "")
          .replace(/^[-: ]+/u, "")
          .trim();
        return "Engine - " + (cleaned || raw || "Deck");
      }
      const cleaned = raw
        .replace(/^carnerr[-_ ]*/iu, "")
        .replace(/^[-: ]+/u, "")
        .trim();
      return "Carnerr - " + (cleaned || raw || "Deck");
    }

    function deckRailMlStatus(profile) {
      const summary = profileActionModelSummary(profile);
      if (summary.ready) return { label: "ML", className: "ready", title: "Trusted profile ML ready" };
      if (summary.exists) return { label: "ML", className: "seed", title: "Profile ML exists but needs more trusted evidence" };
      return { label: "ML", className: "needed", title: "Profile ML needed" };
    }

    function deckRailMatchupStatus(profile) {
      const games = profileMatchupGames(profile);
      const buckets = Number(profile?.matchupStats?.length || 0);
      if (games >= 50) return { label: "MU " + fmt(buckets), className: "ready", title: fmt(games) + " matchup games across " + fmt(buckets) + " bucket(s)" };
      if (games > 0) return { label: "MU " + fmt(buckets), className: "seed", title: fmt(games) + " early matchup games across " + fmt(buckets) + " bucket(s)" };
      return { label: "MU 0", className: "needed", title: "No matchup games recorded" };
    }

    function applySavedDeckOrder(profiles) {
      const order = savedDeckOrder();
      if (order.length === 0) return profiles;
      const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
      const ordered = order.map((id) => profileById.get(id)).filter(Boolean);
      const rest = profiles.filter((profile) => !order.includes(profile.id));
      return [...ordered, ...rest];
    }

    function deckDropAfter(button, event) {
      const rect = button.getBoundingClientRect();
      return event.clientY > rect.top + rect.height / 2;
    }

    function reorderDeckRail(sourceId, targetId, dropAfter = false) {
      if (!sourceId || !targetId || sourceId === targetId) return;
      const current = applySavedDeckOrder(latestProfiles).map((profile) => profile.id);
      const withoutSource = current.filter((id) => id !== sourceId);
      const targetIndex = withoutSource.indexOf(targetId);
      if (targetIndex === -1) return;
      withoutSource.splice(targetIndex + (dropAfter ? 1 : 0), 0, sourceId);
      saveDeckOrder(withoutSource);
      renderDeckTabs(latestProfiles);
    }

    function moveDeckRail(deckId, delta) {
      if (!deckId || !Number.isFinite(delta) || delta === 0) return;
      const current = applySavedDeckOrder(latestProfiles).map((profile) => profile.id);
      const index = current.indexOf(deckId);
      if (index === -1) return;
      const nextIndex = Math.max(0, Math.min(current.length - 1, index + delta));
      if (nextIndex === index) return;
      const next = [...current];
      const [deck] = next.splice(index, 1);
      next.splice(nextIndex, 0, deck);
      saveDeckOrder(next);
      renderDeckTabs(latestProfiles);
    }

    function savedDeckOrder() {
      try {
        const raw = localStorage.getItem(deckOrderStorageKey);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
      } catch {
        return [];
      }
    }

    function saveDeckOrder(order) {
      try {
        localStorage.setItem(deckOrderStorageKey, JSON.stringify(order));
      } catch {
        // Deck rail ordering is best-effort.
      }
    }

    function clearDeckDragState() {
      draggedDeckId = "";
      for (const row of $("deckTabs").querySelectorAll(".deck-tab-row")) {
        row.classList.remove("dragging", "drop-target", "drop-before", "drop-after");
      }
    }

    function selectDeck(deckId) {
      selectedDeckId = deckId;
      selectedMatchupKey = "";
      if ([...$("deck").options].some((option) => option.value === deckId)) $("deck").value = deckId;
      syncOwnKeyFromDeck();
      lastDeckValue = $("deck").value;
      renderDeckTabs(latestProfiles);
      renderBaselineTracker(latestProfiles);
      renderTrainingReadiness(latestProfiles, latestLoopHealth);
      renderMatchupOptions(latestRegionalDecks, latestArchetypes);
      renderSelectedProfile(selectedProfile());
      renderAdvice(selectedProfile());
      renderBadMatchupRadar(selectedProfile());
      renderCardReadout(selectedProfile());
      renderExperimentPlanner(selectedProfile());
      renderDeckEditLab(selectedProfile());
      renderCardEvidence(selectedProfile());
      renderDeckCards(selectedProfile());
      renderLearningSignals(selectedProfile());
      renderMatchupStats(selectedProfile()?.matchupStats || []);
      renderPerformanceTrend(latestRunsForSelectedProfile());
    }

    function selectedProfile() {
      return latestProfiles.find((profile) => profile.id === selectedDeckId)
        || latestProfiles.find((profile) => profile.id === $("deck").value)
        || latestProfiles[0]
        || null;
    }

    function latestRunsForSelectedProfile() {
      return latestRunsForProfile(selectedProfile());
    }

    function latestRunsForProfile(profile) {
      return (latestRuns || []).filter((run) => !profile || run.ownKey === profile.ownKey || run.deckId === profile.id);
    }

    function syncOwnKeyFromDeck() {
      const deck = latestDecks.find((candidate) => candidate.id === $("deck").value);
      if (deck?.ownKey) $("ownKey").value = deck.ownKey;
    }

    function renderSelectedProfile(profile) {
      if (!profile) {
        $("deckPolicyStatus").textContent = "-";
        $("deckModelStatus").textContent = "-";
        $("deckMatchupStatus").textContent = "-";
        $("selectedDeckPath").textContent = "";
        return;
      }
      const baselineStatus = baselineStatusForProfile(profile);
      $("deckPolicyStatus").textContent = baselineStatus.label;
      $("deckPolicyStatus").className = "value " + baselineStatus.tone;
      const modelStatus = profileActionModelSummary(profile);
      $("deckModelStatus").textContent = modelStatus.label;
      $("deckModelStatus").className = "value " + modelStatus.tone;
      $("deckMatchupStatus").textContent = fmt(profile.matchupStats?.length || 0) + " matchups";
      $("selectedDeckPath").textContent = [profile.label || profile.name || profile.id, profile.path].filter(Boolean).join(" | ");
    }

    function renderAdvice(profile) {
      const advice = profile?.advice || {};
      const health = advice.health || "needs-data";
      $("adviceHealth").className = "health " + health;
      $("adviceHealth").textContent = healthLabel(health);
      list("advicePriorities", advice.priorities, "No urgent priorities from current evidence.");
      list("adviceActions", advice.nextActions, "Keep collecting training data.");
      list("adviceStrengths", advice.strengths, "No strengths proven yet.");
      list("adviceConcerns", advice.concerns, "No major concerns proven yet.");
      list("advicePerformance", advice.performanceNotes, "Performance notes will appear after completed run data is available.");
      list("adviceLearning", advice.learningNotes, "Pilot learning notes will appear after an action model is available.");
      list("adviceEditReadiness", advice.editNotes, "Edit-readiness notes will appear after baseline and matchup evidence is available.");
      list("adviceDeckNotes", advice.deckNotes, "Deck-shape notes will appear after deck metadata is available.");
      list("adviceCardPackages", advice.cardPackageNotes, "Card-package notes will appear after catalog metadata is available.");
      list("adviceCardEvidence", advice.cardEvidenceNotes, "Card decision evidence will appear after runs with decision logs.");
      list("adviceDeckExperiments", advice.deckExperimentNotes, "Deck experiment notes will appear after a legal optimization run.");
      list("adviceCardNotes", advice.cardNotes, "Card-slot notes will appear after deck metadata is available.");
    }

    function renderBadMatchupRadar(profile) {
      const rows = [...(profile?.matchupStats ?? [])]
        .filter((row) => completedMatchupGames(row) > 0)
        .sort((a, b) => matchupRiskScore(b) - matchupRiskScore(a)
          || Number(a.winRate ?? 0) - Number(b.winRate ?? 0)
          || String(a.opponentLabel || a.opponentKey || "").localeCompare(String(b.opponentLabel || b.opponentKey || "")))
        .slice(0, 12);
      const totalGames = (profile?.matchupStats ?? []).reduce((total, row) => total + completedMatchupGames(row), 0);
      const weakCount = (profile?.matchupStats ?? []).filter((row) => completedMatchupGames(row) >= 20 && Number(row.winRate ?? 0) < 0.45).length;
      $("badMatchupRadarCaption").textContent = totalGames > 0
        ? fmt(totalGames) + " matchup games, " + fmt(weakCount) + " proven weak bucket(s)"
        : "No matchup games yet";
      setPanelEmpty("bad-matchup-radar", rows.length === 0, "No matchup evidence yet. Run focused matchup training after this deck has a trained baseline and trusted profile ML.");
      table("badMatchupRadar", ["Matchup","Risk","Completed","W/L/I","Completed Win","Life","Turn Cycles","Evidence","Next Step"], rows.map((row) => [
        cell(row.opponentLabel || row.opponentKey, row.opponentKey),
        matchupRiskBadge(row),
        fmt(completedMatchupGames(row)),
        row.wins + "/" + row.losses + "/" + row.incomplete,
        pct(row.winRate),
        numberText(row.avgLifeDiff),
        numberText(row.avgTurnCycles),
        esc(row.evidenceLabel || "-"),
        esc(matchupNextStep(row))
      ]));
    }

    function renderCardReadout(profile) {
      const deckCards = profile?.deckShape?.cards ?? [];
      const evidenceByKey = new Map();
      for (const evidence of profile?.cardEvidence?.cards ?? []) {
        if (evidence.number) evidenceByKey.set(String(evidence.number), evidence);
        if (evidence.cardId) evidenceByKey.set(String(evidence.cardId), evidence);
      }
      const rows = deckCards.map((card) => {
        const evidence = evidenceByKey.get(String(card.number || card.id || ""))
          || evidenceByKey.get(String(card.id || card.number || ""));
        return { card, evidence };
      }).sort((a, b) => cardReadoutPriority(b) - cardReadoutPriority(a)
        || Number(b.card.count ?? 0) - Number(a.card.count ?? 0)
        || String(a.card.number || a.card.id || "").localeCompare(String(b.card.number || b.card.id || "")));
      const withEvidence = rows.filter((row) => row.evidence).length;
      const currentEvidence = profile?.cardEvidence;
      $("cardReadoutCaption").textContent = deckCards.length > 0
        ? fmt(withEvidence) + "/" + fmt(deckCards.length) + " current cards with chosen card-linked evidence, "
          + fmt(currentEvidence?.cardLinkedRows || 0) + " linked decisions"
          + (currentEvidence?.modelExamples ? " from " + fmt(currentEvidence.modelExamples) + " total ML examples" : "")
          + ". Selected Actions shows every recorded path; 0 flags a basic card path with no selected evidence"
        : "No saved deck cards found";
      setPanelEmpty("card-readout", deckCards.length === 0, "No saved deck cards were found for the selected profile.");
      table("cardReadout", ["Card","Role","Evidence","Selected Actions","Pros","Concerns","Next Check"], rows.slice(0, 60).map(({ card, evidence }) => [
        cell((card.count || 0) + "x " + (card.name || card.number || card.id), card.number || card.id),
        esc(deckCardRoleText(card)),
        esc(cardEvidenceSummaryText(evidence)),
        cardSelectedActionsCell(card, evidence),
        esc(cardProsText(card, evidence)),
        esc(cardConcernsText(card, evidence)),
        esc(cardNextCheckText(card, evidence))
      ]));
    }

    function renderExperimentPlanner(profile) {
      const rows = deckExperimentRows(profile);
      const readiness = profile?.advice?.editReadiness;
      const totalGames = profileMatchupGames(profile);
      const confident = (profile?.matchupStats ?? []).filter((row) => completedMatchupGames(row) >= 50).length;
      $("experimentPlannerCaption").textContent = profile
        ? (readiness?.label || "Needs Evidence") + ": " + fmt(totalGames) + " matchup games, " + fmt(confident) + " confident bucket(s)"
        : "No deck selected";
      setPanelEmpty("experiment-planner", !profile, "Select a deck to see its deck-edit gates and experiment plan.");
      table("experimentPlanner", ["Focus","Status","Evidence","Next Step","Guardrail"], rows);
    }

    function renderDeckEditLab(profile) {
      const rows = profile?.deckExperiments ?? [];
      const latest = rows[0];
      $("deckEditLabCaption").textContent = profile
        ? rows.length + " experiment run(s)" + (latest?.updatedAt ? ", latest " + shortDate(latest.updatedAt) : "")
        : "No deck selected";
      setPanelEmpty("deck-edit-lab", rows.length === 0, "No legal deck experiment runs yet. Keep this parked until baseline, ML, and matchup evidence are credible.");
      table("deckEditLab", ["Run","Opponents","Result","Delta","Changes","Recommendation"], rows.slice(0, 12).map((run) => [
        cell(run.id, run.path),
        esc((run.opponentIds || []).slice(0, 3).join(", ") + ((run.opponentIds || []).length > 3 ? " +" + ((run.opponentIds || []).length - 3) : "")),
        run.result ? run.result.wins + "/" + run.result.losses + "/" + run.result.incomplete + " (" + pct(run.result.winRate) + ")" : "-",
        experimentDeltaCell(run),
        esc(experimentChangeText(run)),
        esc(experimentRecommendationText(run))
      ]));
    }

    function experimentDeltaCell(run) {
      const delta = Number(run?.baseComparison?.winRateDelta);
      if (!Number.isFinite(delta)) return "-";
      const label = (delta >= 0 ? "+" : "") + (delta * 100).toFixed(1) + " pts";
      return statusCell(label, delta > 0 ? "good" : delta < 0 ? "bad" : "warn");
    }

    function experimentChangeText(run) {
      const changes = run?.cardChanges ?? [];
      if (changes.length === 0) return "No card-count changes recorded.";
      return changes.slice(0, 8).map((change) => {
        const delta = Number(change.delta || 0);
        const sign = delta > 0 ? "+" : "";
        const before = Number(change.before);
        const after = Number(change.after);
        const copyText = Number.isFinite(before) && Number.isFinite(after) ? " (" + before + " -> " + after + ")" : "";
        return sign + delta + " " + (change.name || change.number || change.id) + copyText;
      }).join("; ") + (changes.length > 8 ? "; +" + (changes.length - 8) + " more" : "");
    }

    function experimentRecommendationText(run) {
      const recs = run?.analysis?.recommendations ?? [];
      if (recs.length > 0) return recs[0];
      const delta = Number(run?.baseComparison?.winRateDelta);
      if (Number.isFinite(delta) && delta > 0) return "Promising candidate; rerun the same matchup with more games before changing the saved list.";
      if (Number.isFinite(delta) && delta < 0) return "Reject or retest with a smaller change set.";
      return "Run a focused deck experiment after matchup evidence is credible.";
    }

    function deckExperimentRows(profile) {
      if (!profile) return [];
      const rows = [];
      const readiness = profile.advice?.editReadiness || {};
      const totalGames = profileMatchupGames(profile);
      const confident = (profile.matchupStats ?? []).filter((row) => completedMatchupGames(row) >= 50).length;
      const baselineReady = Boolean(profile.baselinePolicy?.exists);
      const profileModelReady = Boolean(profile.actionModel?.exists && profile.actionModel?.source === "profile");
      const cardEvidenceRows = Number(profile.cardEvidence?.cardLinkedRows ?? 0);
      rows.push(experimentRow(
        "Deck-edit gate",
        readiness.status === "not-ready" ? statusCell("Blocked", "warn") : statusCell("Ready", "good"),
        readiness.notes?.[0] || "No edit-readiness note available.",
        readiness.nextAction || "Use small, matchup-locked experiments.",
        "Do not change the list until baseline, ML, and matchup samples are credible."
      ));
      rows.push(experimentRow(
        "Baseline policy",
        baselineReady ? statusCell("Ready", "good") : statusCell("Needed", "warn"),
        baselineReady ? "Specialist policy exists for " + (profile.ownKey || profile.id) + "." : "No specialist baseline policy exists yet.",
        baselineReady ? "Keep this as the comparison pilot." : "Run Deck Training or All Baselines.",
        "Deck experiments need the same pilot baseline on both sides."
      ));
      rows.push(experimentRow(
        "Profile ML model",
        profileModelReady
          ? statusCell("Ready", "good")
          : profile.actionModel?.exists
            ? statusCell("Fallback", "warn")
            : statusCell("Needed", "warn"),
        profile.actionModel?.exists ? fmt(profile.actionModel.examples) + " action examples available." : "No action model is available.",
        profileModelReady ? "Use the profile model for future matchup tests." : "Run a knowledge-producing cycle to create a profile model.",
        "Avoid judging card slots from the global fallback model alone."
      ));
      rows.push(experimentRow(
        "Matchup sample",
        totalGames >= 200 && confident >= 2 ? statusCell("Usable", "good") : statusCell("Developing", "warn"),
        fmt(totalGames) + " total matchup games; " + fmt(confident) + " bucket(s) have 50+ games.",
        totalGames >= 200 && confident >= 2 ? "Start with one matchup-locked hypothesis." : "Collect focused matchup cycles before deck edits.",
        "Use the same opponent bucket before and after any list test."
      ));
      rows.push(experimentRow(
        "Card evidence",
        cardEvidenceRows >= 200 ? statusCell("Usable", "good") : statusCell("Thin", "warn"),
        fmt(cardEvidenceRows) + " current-list card-linked decisions.",
        cardEvidenceRows >= 200 ? "Use card evidence as a watchlist." : "Keep decision logging on during runs.",
        "Card evidence is association, not proof of a bad card."
      ));

      const selectedMatchup = selectedOrWeakMatchup(profile);
      if (selectedMatchup) {
        rows.push(experimentRow(
          "Focused matchup test",
          Number(selectedMatchup.winRate ?? 0) < 0.45 ? statusCell("Priority", "bad") : statusCell("Benchmark", "good"),
          (selectedMatchup.opponentLabel || selectedMatchup.opponentKey) + ": " + fmt(selectedMatchup.games) + " games, " + pct(selectedMatchup.winRate) + " win, " + numberText(selectedMatchup.avgLifeDiff) + " life.",
          "Run the next matchup cycle here before changing multiple cards.",
          "Keep deck, pilot, seed range, and opponent bucket controlled."
        ));
        for (const item of matchupExperimentCards(profile, selectedMatchup.opponentKey, "negative").slice(0, 3)) {
          rows.push(experimentRow(
            "Review weak-pattern card",
            statusCell("Watch", "warn"),
            item.label + ": " + cardMatchupEvidenceText(item.evidence),
            cardMatchupNextCheckText(item.evidence, selectedMatchup),
            "Inspect decisions first; avoid cutting a role the matchup still needs."
          ));
        }
        for (const item of matchupExperimentCards(profile, selectedMatchup.opponentKey, "positive").slice(0, 2)) {
          rows.push(experimentRow(
            "Protect useful role",
            statusCell("Protect", "good"),
            item.label + ": " + cardMatchupEvidenceText(item.evidence),
            "Keep this role intact while testing fixes.",
            "A weak matchup can still have cards that are carrying the plan."
          ));
        }
      }

      for (const item of globalExperimentCards(profile, "negative").slice(0, 2)) {
        rows.push(experimentRow(
          "Global card watch",
          statusCell("Watch", "warn"),
          item.label + ": " + cardEvidenceSummaryText(item.evidence),
          cardNextCheckText(item.deckCard, item.evidence),
          "Confirm whether the issue is global or matchup-specific."
        ));
      }
      return rows;
    }

    function experimentRow(focus, status, evidence, nextStep, guardrail) {
      return [
        esc(focus),
        status,
        esc(evidence),
        esc(nextStep),
        esc(guardrail)
      ];
    }

    function selectedOrWeakMatchup(profile) {
      const rows = profile?.matchupStats ?? [];
      return rows.find((row) => row.opponentKey === selectedMatchupKey)
        || [...rows].filter((row) => completedMatchupGames(row) > 0)
          .sort((a, b) => matchupRiskScore(b) - matchupRiskScore(a))[0]
        || null;
    }

    function matchupExperimentCards(profile, matchupKey, direction) {
      const cards = profile?.cardEvidence?.cards ?? [];
      return cards.map((card) => {
        const evidence = combinedCardMatchupEvidence(card.matchupEvidence ?? [], matchupKey);
        if (!evidence) return null;
        return {
          card,
          deckCard: deckCardForEvidence(profile, card),
          evidence,
          label: card.name || card.number || card.cardId
        };
      }).filter(Boolean).filter((item) => {
        if (direction === "positive") return Number(item.evidence.decisions ?? 0) >= 8
          && (Number(item.evidence.avgShapedReward ?? 0) > 0.2 || Number(item.evidence.winRate ?? 0) >= 0.55);
        return Number(item.evidence.decisions ?? 0) >= 8
          && (Number(item.evidence.avgShapedReward ?? 0) < -0.25 || Number(item.evidence.winRate ?? 0) < 0.45 || Number(item.evidence.avgLifeDiff ?? 0) < -0.5);
      }).sort((a, b) => {
        if (direction === "positive") {
          return Number(b.evidence.avgShapedReward ?? 0) - Number(a.evidence.avgShapedReward ?? 0)
            || Number(b.evidence.decisions ?? 0) - Number(a.evidence.decisions ?? 0);
        }
        return Number(a.evidence.avgShapedReward ?? 0) - Number(b.evidence.avgShapedReward ?? 0)
          || Number(a.evidence.winRate ?? 0) - Number(b.evidence.winRate ?? 0);
      });
    }

    function globalExperimentCards(profile, direction) {
      return (profile?.cardEvidence?.cards ?? []).map((evidence) => ({
        evidence,
        deckCard: deckCardForEvidence(profile, evidence),
        label: evidence.name || evidence.number || evidence.cardId
      })).filter((item) => {
        const decisions = Number(item.evidence.decisions ?? 0);
        if (direction === "positive") return decisions >= 8
          && (Number(item.evidence.avgShapedReward ?? 0) > 0.25 || Number(item.evidence.winRate ?? 0) >= 0.55);
        return decisions >= 8
          && (Number(item.evidence.avgShapedReward ?? 0) < -0.25 || Number(item.evidence.winRate ?? 0) < 0.45 || Number(item.evidence.avgLifeDiff ?? 0) < -0.5);
      }).sort((a, b) => {
        if (direction === "positive") return Number(b.evidence.avgShapedReward ?? 0) - Number(a.evidence.avgShapedReward ?? 0);
        return Number(a.evidence.avgShapedReward ?? 0) - Number(b.evidence.avgShapedReward ?? 0);
      });
    }

    function deckCardForEvidence(profile, evidence) {
      const key = String(evidence?.number || evidence?.cardId || "");
      return (profile?.deckShape?.cards ?? []).find((card) => String(card.number || card.id || "") === key || String(card.id || card.number || "") === key)
        || evidence
        || {};
    }

    function renderCardEvidence(profile) {
      const evidence = profile?.cardEvidence;
      const cards = [...(evidence?.cards ?? [])]
        .sort((a, b) => Number(b.decisions ?? 0) - Number(a.decisions ?? 0)
          || Number(b.avgShapedReward ?? 0) - Number(a.avgShapedReward ?? 0)
          || String(a.number ?? a.cardId ?? "").localeCompare(String(b.number ?? b.cardId ?? "")))
        .slice(0, 120);
      $("cardEvidenceCaption").textContent = evidence
        ? fmt(evidence.cardLinkedRows) + " current-list chosen card-linked decisions from "
          + fmt(evidence.chosenRows) + " scanned chosen decisions"
          + (evidence.modelExamples ? " / " + fmt(evidence.modelExamples) + " ML examples" : "")
          + (evidence.pairwiseExamples ? " / " + fmt(evidence.pairwiseExamples) + " pairwise comparisons" : "")
          + ", " + fmt(evidence.uncardedRows) + " uncarded, " + fmt(evidence.outOfDeckRows) + " old-list"
          + (evidence.capped ? " (scan capped)" : "")
        : "";
      table("cardEvidence", ["Card","Type","Energy","Trigger","Decisions","Win","Reward","Life","Actions","Matchups"], cards.map((card) => [
        cell((card.count || 0) + "x " + (card.name || card.cardId), card.number || card.cardId),
        esc(card.type || "-"),
        esc(energyText(card)),
        esc(card.triggerType || "-"),
        fmt(card.decisions),
        pct(card.winRate),
        numberText(card.avgShapedReward),
        numberText(card.avgLifeDiff),
        esc(topEntryText(card.actionTypes, 3)),
        esc(topEntryText(card.matchups, 2))
      ]));
    }

    function renderDeckCards(profile) {
      const cards = profile?.deckShape?.cards ?? [];
      const evidenceByNumber = new Map((profile?.cardEvidence?.cards ?? []).flatMap((card) => [
        [String(card.number || card.cardId || ""), card],
        [String(card.cardId || card.number || ""), card]
      ]));
      $("deckCardsCaption").textContent = cards.length > 0
        ? fmt(cards.reduce((total, card) => total + Number(card.count ?? 0), 0)) + " cards, " + fmt(cards.length) + " unique"
        : "";
      table("deckCards", ["Card","Count","Type","Energy","AP","BP","Trigger","Roles","Evidence"], cards.map((card) => {
        const evidence = evidenceByNumber.get(String(card.number || card.id || ""));
        return [
          cell(card.name || card.number || card.id, card.number || card.id),
          fmt(card.count),
          esc(card.type || "-"),
          esc(energyText(card)),
          valueOrDash(card.apCost),
          valueOrDash(card.bp),
          esc(card.triggerType || "-"),
          esc(deckCardRoleText(card)),
          evidence ? fmt(evidence.decisions) + " chosen decisions, " + pct(evidence.winRate) + " win" : "<span class=\\"warn\\">no chosen card evidence</span>"
        ];
      }));
    }

    function renderLearningSignals(profile) {
      const model = profile?.actionModel;
      const learning = model?.learning;
      const signals = [
        ...((learning?.positive ?? []).map((row) => ({ ...row, direction: "Reward" }))),
        ...((learning?.negative ?? []).map((row) => ({ ...row, direction: "Penalty" })))
      ]
        .filter((row) => row.feature)
        .sort((a, b) => Math.abs(Number(b.weight ?? 0)) - Math.abs(Number(a.weight ?? 0))
          || String(a.feature).localeCompare(String(b.feature)))
        .slice(0, 18);
      if (!model?.exists) {
        $("learningSignalsCaption").textContent = "No action model yet";
      } else {
        const source = model.source === "fallback" ? "global fallback" : "profile model";
        const runtime = model.runtimeReadiness || learning?.runtimeReadiness;
        const health = model.learningHealth;
        const healthRead = health?.label || health?.status;
        const readiness = runtime
          ? ", " + (runtime.ready ? "runtime ready" : "not runtime ready: " + ((runtime.blockers || [])[0] || "needs more evidence"))
          : "";
        $("learningSignalsCaption").textContent = modelExampleText(model) + ", "
          + fmt(model.features) + " features" + featureSelectionText(model.featureSelection || learning?.featureSelection)
          + ", " + source + readiness + (healthRead ? ", learning health " + healthRead : "");
      }
      table("learningSignals", ["Signal","Area","Direction","Weight","Read"], signals.map((signal) => [
        esc(humanizeClientFeature(signal.feature)),
        esc(learningFeatureGroupName(signal.feature)),
        signal.direction === "Reward" ? "<span class=\\"good\\">reward</span>" : "<span class=\\"warn\\">penalty</span>",
        numberText(signal.weight),
        esc(learningSignalRead(signal))
      ]));
    }

    function renderPerformanceTrend(rows) {
      const completed = [...(rows || [])]
        .filter((run) => run.complete && run.result)
        .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
      if (completed.length === 0) {
        $("performanceTrendCaption").textContent = "No completed runs yet";
        table("performanceTrend", ["Run","Mode","W/L/I","Win","Score","Life","Turn Cycles","Promote","Updated"], []);
        return;
      }
      const latest = completed[0]?.result;
      const scoreVersion = Number(latest?.scoreVersion || 1);
      const comparable = completed.filter((run) => Number(run.result?.scoreVersion || 1) === scoreVersion);
      const best = [...comparable].sort((a, b) => Number(b.result?.score ?? -Infinity) - Number(a.result?.score ?? -Infinity))[0]?.result;
      $("performanceTrendCaption").textContent = fmt(completed.length) + " completed runs, latest "
        + pct(latest?.winRate) + ", best score v" + scoreVersion + " " + numberText(best?.score);
      table("performanceTrend", ["Run","Mode","W/L/I","Win","Score v" + scoreVersion,"Life","Turn Cycles","Promote","Updated"], completed.slice(0, 20).map((run) => [
        cell(run.id, run.path),
        esc(run.mode || "-"),
        run.result ? run.result.wins + "/" + run.result.losses + "/" + run.result.incomplete : "-",
        run.result ? pct(run.result.winRate) : "-",
        numberText(run.result?.score) + (Number(run.result?.scoreVersion || 1) === scoreVersion
          ? ""
          : " <span class='muted'>v" + esc(run.result?.scoreVersion || 1) + "</span>"),
        numberText(run.result?.avgLifeDiff),
        numberText(run.avgTurnCycles),
        promoteText(run),
        shortDate(run.updatedAt)
      ]));
    }

    function energyText(card) {
      const required = valueOrDash(card.requiredEnergy);
      if (card.reducedOnEmptyField && card.openingRequiredEnergy !== card.requiredEnergy) {
        return required + " -> " + valueOrDash(card.openingRequiredEnergy) + " opener";
      }
      return required;
    }

    function deckCardRoleText(card) {
      const roles = [];
      if (Number(card.openingRequiredEnergy) === 0 && card.type === "character") roles.push("opener");
      if (card.reducedOnEmptyField) roles.push("empty-field reducer");
      if ((card.raidNames || []).length > 0 || card.triggerType === "raid") roles.push("raid");
      if ((card.effectKinds || []).includes("searchTopDeck")) roles.push("search");
      if ((card.effectKinds || []).includes("draw") || card.triggerType === "draw") roles.push("draw");
      if ((card.abilityTimings || []).length > 0) roles.push(card.abilityTimings.slice(0, 2).join("/"));
      if (Number(card.count) >= 4) roles.push("core");
      if (Number(card.count) <= 2) roles.push("flex");
      return roles.join(", ") || "-";
    }

    function topEntryText(entries, limit) {
      const rows = Array.isArray(entries) ? entries.slice(0, limit) : [];
      return rows.map((entry) => entry.key + " " + fmt(entry.count)).join(", ") || "-";
    }

    function valueOrDash(value) {
      return value === null || value === undefined || value === "" ? "-" : esc(value);
    }

    function list(id, rows, emptyText) {
      const items = Array.isArray(rows) && rows.length > 0 ? rows : [emptyText];
      $(id).innerHTML = items.map((item) => "<li>" + esc(item) + "</li>").join("");
    }

    function healthLabel(value) {
      if (value === "healthy") return "Healthy";
      if (value === "developing") return "Developing";
      return "Needs Data";
    }

    function matchupRiskScore(row) {
      const games = completedMatchupGames(row);
      const winRate = Number(row.winRate ?? 0);
      const lifeDiff = Number(row.avgLifeDiff ?? 0);
      const turnCycles = Number(row.avgTurnCycles ?? 0);
      const sampleWeight = 0.55 + Math.min(1, games / 50) * 0.45;
      return ((1 - winRate) * 70 + Math.max(0, -lifeDiff) * 8 + Math.max(0, turnCycles - 7) * 3) * sampleWeight;
    }

    function matchupRiskBadge(row) {
      const games = completedMatchupGames(row);
      const incompleteRate = Number(row.incompleteRate ?? 0);
      const winRate = Number(row.winRate ?? 0);
      const lifeDiff = Number(row.avgLifeDiff ?? 0);
      if (incompleteRate > 0.2) return statusCell("Unreliable", "bad");
      if (games < 20) return statusCell("Early", "warn");
      if (winRate < 0.4 || lifeDiff < -1.5) return statusCell("Critical", "bad");
      if (winRate < 0.5 || lifeDiff < 0) return statusCell("Watch", "warn");
      return statusCell("Benchmark", "good");
    }

    function matchupNextStep(row) {
      const games = completedMatchupGames(row);
      const incompleteRate = Number(row.incompleteRate ?? 0);
      const winRate = Number(row.winRate ?? 0);
      const lifeDiff = Number(row.avgLifeDiff ?? 0);
      if (incompleteRate > 0.2) return "Resolve incomplete games before strategic refinement.";
      if (games < 20) return "Collect a first 20-game read.";
      if (winRate < 0.4 || lifeDiff < -1.5) return "Run focused matchup training and inspect decisions.";
      if (winRate < 0.5 || lifeDiff < 0) return "Validate with another focused cycle.";
      return "Use as a benchmark while testing changes.";
    }

    function cardReadoutPriority(row) {
      const card = row.card || {};
      const evidence = row.evidence;
      if (!evidence) return Number(card.count ?? 0) >= 3 ? 30 : 16;
      const decisions = Number(evidence.decisions ?? 0);
      const reward = Number(evidence.avgShapedReward ?? 0);
      const winRate = Number(evidence.winRate ?? 0);
      const lifeDiff = Number(evidence.avgLifeDiff ?? 0);
      let score = Math.min(30, decisions);
      if (decisions < 8) score += 14;
      if (reward < -0.25) score += 35 + Math.abs(reward) * 5;
      if (winRate < 0.45) score += 18;
      if (lifeDiff < -0.5) score += 10;
      if (reward > 0.25) score += 15 + reward * 3;
      if (Number(card.count ?? 0) <= 2) score += 4;
      return score;
    }

    function cardEvidenceSummaryText(evidence) {
      if (!evidence) return "no current-list evidence";
      return fmt(evidence.decisions) + " decisions, " + pct(evidence.winRate) + " win, "
        + numberText(evidence.avgShapedReward) + " reward";
    }

    function cardSelectedActionsCell(card, evidence) {
      const counts = new Map((evidence?.actionTypes || []).map((entry) => [String(entry.key), Number(entry.count || 0)]));
      const orderedLabels = [];
      const addLabel = (label) => {
        if (!orderedLabels.includes(label)) orderedLabels.push(label);
      };
      if (card.type === "character") {
        addLabel("play to front");
        addLabel("play to energy");
        if ((card.raidNames || []).length > 0 || card.triggerType === "raid") addLabel("raid");
        if ((card.abilityTimings || []).includes("activateMain")) addLabel("active main");
        addLabel("attack");
        addLabel("block");
      } else if ((card.abilityTimings || []).includes("activateMain")) {
        addLabel("active main");
      }
      for (const entry of evidence?.actionTypes || []) addLabel(String(entry.key));
      if (orderedLabels.length === 0) return '<span class="muted">no linked selections</span>';
      return '<div class="action-frequency">' + orderedLabels.map((label) => {
        const count = counts.get(label) || 0;
        return '<div class="action-frequency-row' + (count === 0 ? " zero" : "") + '"><span>'
          + esc(label) + "</span><strong>" + fmt(count) + "</strong></div>";
      }).join("") + "</div>";
    }

    function cardProsText(card, evidence) {
      const pros = [];
      if (Number(card.count ?? 0) >= 4) pros.push("core count");
      if (Number(card.openingRequiredEnergy) === 0 && card.type === "character") pros.push("setup opener");
      if (card.reducedOnEmptyField) pros.push("empty-field reducer");
      if (card.triggerType) pros.push(card.triggerType + " trigger");
      if ((card.effectKinds || []).includes("searchTopDeck")) pros.push("search utility");
      if ((card.effectKinds || []).includes("draw") || card.triggerType === "draw") pros.push("card flow");
      if (evidence && Number(evidence.decisions ?? 0) >= 8) {
        if (Number(evidence.avgShapedReward ?? 0) > 0.25) pros.push("positive reward association");
        if (Number(evidence.winRate ?? 0) >= 0.55) pros.push("positive win association");
        if (Number(evidence.avgLifeDiff ?? 0) > 0.5) pros.push("positive life spread");
      }
      return pros.slice(0, 4).join("; ") || "-";
    }

    function cardConcernsText(card, evidence) {
      const concerns = [];
      if (!evidence) concerns.push("no logged decisions yet");
      else {
        const decisions = Number(evidence.decisions ?? 0);
        if (decisions < 8) concerns.push("small sample");
        if (Number(evidence.avgShapedReward ?? 0) < -0.25) concerns.push("negative reward association");
        if (Number(evidence.winRate ?? 0) < 0.45) concerns.push("low win association");
        if (Number(evidence.avgLifeDiff ?? 0) < -0.5) concerns.push("negative life spread");
      }
      if (Number(card.count ?? 0) <= 1) concerns.push("single-slot purpose should stay clear");
      return concerns.slice(0, 4).join("; ") || "-";
    }

    function cardNextCheckText(card, evidence) {
      if (!evidence) return "Collect decision evidence before changing.";
      const decisions = Number(evidence.decisions ?? 0);
      const reward = Number(evidence.avgShapedReward ?? 0);
      const winRate = Number(evidence.winRate ?? 0);
      if (decisions < 8) return "Run more logged games for sample size.";
      if (reward < -0.25 && winRate < 0.45) return "Review in weak matchups before testing cuts.";
      if (reward > 0.25 && Number(card.count ?? 0) <= 2) return "Possible increase candidate after matchup proof.";
      if (reward < 0 && Number(card.count ?? 0) >= 3) return "Core slot needs matchup-specific review.";
      return "Keep role stable while testing matchups.";
    }

    function matchupCardPriority(row) {
      const evidence = row.evidence || {};
      const decisions = Number(evidence.decisions ?? 0);
      const reward = Number(evidence.avgShapedReward ?? 0);
      const winRate = Number(evidence.winRate ?? 0);
      const life = Number(evidence.avgLifeDiff ?? 0);
      let score = Math.min(40, decisions);
      if (decisions < 8) score += 12;
      if (reward < -0.25) score += 32 + Math.abs(reward) * 5;
      if (winRate < 0.45) score += 20;
      if (life < -0.5) score += 12;
      if (reward > 0.25 || winRate >= 0.55) score += 16;
      return score;
    }

    function cardMatchupEvidenceText(evidence) {
      if (!evidence) return "no matchup evidence";
      return fmt(evidence.decisions) + " decisions, " + evidence.wins + "/" + evidence.losses + "/" + evidence.incomplete
        + ", " + pct(evidence.winRate) + " win, " + numberText(evidence.avgShapedReward) + " reward, "
        + numberText(evidence.avgLifeDiff) + " life";
    }

    function cardMatchupReadText(evidence) {
      if (!evidence) return "No card-linked decisions in this matchup.";
      const decisions = Number(evidence.decisions ?? 0);
      const reward = Number(evidence.avgShapedReward ?? 0);
      const winRate = Number(evidence.winRate ?? 0);
      const life = Number(evidence.avgLifeDiff ?? 0);
      if (decisions < 8) return "Small sample; use as a flag, not a conclusion.";
      if (reward < -0.25 && winRate < 0.45) return "Negative association in this matchup.";
      if (reward > 0.25 && winRate >= 0.55) return "Positive association in this matchup.";
      if (life < -0.75) return "Associated with poor life spread here.";
      if (life > 0.75) return "Associated with better life spread here.";
      return "Mixed or neutral matchup association.";
    }

    function cardMatchupNextCheckText(evidence, matchup) {
      if (!evidence) return "Collect logged games in this matchup.";
      const decisions = Number(evidence.decisions ?? 0);
      const reward = Number(evidence.avgShapedReward ?? 0);
      const winRate = Number(evidence.winRate ?? 0);
      const matchupWinRate = Number(matchup?.winRate ?? 0);
      if (decisions < 8) return "Get more samples before acting.";
      if (matchupWinRate < 0.45 && reward < -0.25 && winRate < 0.45) return "Review play pattern before cut testing.";
      if (matchupWinRate < 0.45 && reward > 0.25) return "Protect this role during matchup experiments.";
      if (reward < -0.25) return "Check if this is matchup-specific or global.";
      return "Keep watching across the next focused cycle.";
    }

    function renderMatchupOptions(regionalDecks, archetypes) {
      const select = $("matchupKey");
      const selected = select.value;
      const profile = selectedProfile();
      const statRows = profile?.matchupStats ?? [];
      const statsByOpponentKey = new Map(statRows.map((row) => [row.opponentKey, row]));
      const archetypeRows = [...(archetypes || [])];
      const archetypeKeys = new Set(archetypeRows.map((row) => row.key));
      for (const stat of statRows) {
        if (stat.opponentKey && !archetypeKeys.has(stat.opponentKey)) {
          const parsed = parseMatchupKey(stat.opponentKey);
          archetypeRows.push({
            key: stat.opponentKey,
            label: stat.opponentLabel || stat.opponentKey,
            sourceCode: parsed.sourceCode,
            colors: parsed.colors,
            count: stat.opponentDeckCount || 0,
            deckIds: stat.opponentDeckIds || [],
            locations: []
          });
          archetypeKeys.add(stat.opponentKey);
        }
      }
      const optionRows = archetypeRows.map((archetype) => {
        const stat = statsByOpponentKey.get(archetype.key);
        const colors = archetype.colors?.length ? archetype.colors : parseMatchupKey(archetype.key).colors;
        return {
          key: archetype.key,
          opponentKey: archetype.key,
          label: archetype.label || archetype.key,
          suffix: stat ? pct(stat.winRate) + ", " + fmt(stat.games) + " matchup games" : fmt(archetype.count || 0) + " regional list(s)",
          sourceCode: archetype.sourceCode ?? parseMatchupKey(archetype.key).sourceCode,
          colors,
          count: stat?.games ?? 0,
          winRate: stat?.winRate ?? 1,
          deckIds: archetype.deckIds ?? [],
          listCount: archetype.count ?? 0,
          locations: archetype.locations ?? []
        };
      }).filter((row) => row.key).sort((a, b) => Number(a.winRate) - Number(b.winRate)
        || Number(b.count) - Number(a.count)
        || a.label.localeCompare(b.label)
        || a.key.localeCompare(b.key));
      const signature = optionRows.map((row) => row.key + ":" + row.count + ":" + row.listCount).join("|");
      if (select.dataset.signature !== signature) {
        select.innerHTML = optionRows.map((row) => {
          const title = [
            row.key,
            fmt(row.listCount) + " regional list(s)",
            row.locations?.length ? row.locations.join(", ") : "",
            row.deckIds?.length ? row.deckIds.slice(0, 8).join(", ") : ""
          ].filter(Boolean).join(" | ");
          const suffix = row.suffix ?? fmt(row.count);
          return "<option value=\\"" + esc(row.key) + "\\" data-opponent-key=\\"" + esc(row.opponentKey || "") + "\\" data-set=\\"" + esc(row.sourceCode || "") + "\\" data-color=\\"" + esc((row.colors || []).join(",")) + "\\" title=\\"" + esc(title) + "\\">"
            + esc(row.label) + " (" + esc(suffix) + ")</option>";
        }).join("");
        select.dataset.signature = signature;
      }
      if ([...select.options].some((option) => option.value === selected)) select.value = selected;
      else if ([...select.options].some((option) => option.value === selectedMatchupKey)) select.value = selectedMatchupKey;
      else if ([...select.options].some((option) => option.dataset.opponentKey === selectedMatchupKey)) {
        select.value = [...select.options].find((option) => option.dataset.opponentKey === selectedMatchupKey).value;
      }
      else if (select.options.length > 0) select.selectedIndex = 0;
      syncMatchupFilters();
    }

    function parseMatchupKey(key) {
      const parts = String(key || "").split("-").filter(Boolean);
      return {
        sourceCode: parts[0] ? parts[0].toUpperCase() : "",
        colors: parts.length > 1 ? [parts.slice(1).join("-")] : []
      };
    }

    function syncMatchupFilters() {
      const option = $("matchupKey").selectedOptions[0];
      if (!option) return;
      selectedMatchupKey = option.dataset.opponentKey || option.value || selectedMatchupKey;
      $("opponentSet").value = option.dataset.set || "";
      $("opponentColor").value = option.dataset.color || "";
      $("opponentTop").value = "";
      renderMatchupStats(selectedProfile()?.matchupStats || []);
    }

    function applyTrainingModeDefaults() {
      if ($("trainingMode").value === "deck") {
        $("generations").value = "3";
        $("population").value = "8";
        $("mlStrength").value = "0.20";
        $("parallelOpponentCountPerRun").value = "6";
        $("parallelFinalGames").value = "10";
        $("parallelFinalTopPercent").value = "35";
        $("parallelFinalCandidates").value = "best-merged-baseline";
        $("knowledgeMode").value = "action";
        $("knowledgeInputs").value = "";
      } else {
        $("generations").value = "1";
        $("population").value = "4";
        $("mlStrength").value = "0.35";
        $("parallelOpponentCountPerRun").value = "1";
        $("parallelFinalGames").value = "0";
        $("parallelFinalTopPercent").value = "25";
        $("parallelFinalCandidates").value = "merged-baseline";
        $("knowledgeMode").value = "full";
        $("knowledgeInputs").value = "";
      }
      syncLoopModeUi();
    }

    function syncLoopModeUi() {
      const deckMode = $("trainingMode").value === "deck";
      $("matchupKey").disabled = deckMode;
      $("matchupSelectorLabel").style.opacity = deckMode ? "0.55" : "1";
      updatePrimaryActions(lastRunning);
    }

    function renderOverlays(rows) {
      table("overlays", ["Opponent","Pairs","Causal Mass","Breadth","Status","Features","Trained"], rows.map((row) => [
        cell((row.candidate ? "Candidate: " : "") + (row.opponentKey || row.id), row.path),
        fmt(row.pairwiseExamples),
        Number(row.pairwiseEffectiveWeight ?? 0).toFixed(3),
        fmt(row.evidenceDiversity?.distinctPhases ?? 0) + " phases / " + fmt(row.evidenceDiversity?.distinctActionPairs ?? 0) + " action pairs",
        cell(row.runtimeActive ? "Active" : row.candidate && row.readinessStatus === "ready" ? "Ready for validation" : (row.readinessStatus || "Collecting"), row.readinessReason || ""),
        fmt(row.features),
        shortDate(row.trainedAt || row.updatedAt)
      ]));
    }

    function renderMatchupStats(rows) {
      if (!Array.isArray(rows) || rows.length === 0) {
        setPanelEmpty("matchups", true, "No matchup rows yet. Run matchup training after the selected deck has a baseline and profile ML.");
        table("matchupStats", ["Archetype","Completed / Recorded","W/L/I","Completed Win","Life","Turn Cycles","Mull","Brick","Evidence"], []);
        renderMatchupDetail(null);
        renderMatchupCardReadout(null);
        return;
      }
      setPanelEmpty("matchups", false);
      if (!rows.some((row) => row.opponentKey === selectedMatchupKey)) {
        const weakest = [...rows].sort((a, b) => Number(a.winRate) - Number(b.winRate)
          || completedMatchupGames(b) - completedMatchupGames(a))[0];
        selectedMatchupKey = weakest?.opponentKey || rows[0].opponentKey;
      }
      const head = "<thead><tr>"
        + ["Archetype","Completed / Recorded","W/L/I","Completed Win","Life","Turn Cycles","Mull","Brick","Evidence"].map((h) => "<th>" + esc(h) + "</th>").join("")
        + "</tr></thead>";
      const body = "<tbody>" + rows.map((row) => {
        const selected = row.opponentKey === selectedMatchupKey ? " class=\\"selected\\"" : "";
        return "<tr data-opponent-key=\\"" + esc(row.opponentKey) + "\\"" + selected + ">"
          + "<td>" + cell(row.opponentLabel || row.opponentKey, row.opponentKey) + "</td>"
          + "<td>" + fmt(completedMatchupGames(row)) + " / " + fmt(row.games) + " in " + fmt(row.runs) + " runs</td>"
          + "<td>" + row.wins + "/" + row.losses + "/" + row.incomplete + "</td>"
          + "<td>" + pct(row.winRate) + "</td>"
          + "<td>" + numberText(row.avgLifeDiff) + "</td>"
          + "<td>" + numberText(row.avgTurnCycles) + "</td>"
          + "<td>" + pct(row.mulliganRate) + "</td>"
          + "<td>" + pct(row.brickRate) + "</td>"
          + "<td>" + esc(row.evidenceLabel || "-") + "</td>"
          + "</tr>";
      }).join("") + "</tbody>";
      if (setHtml("matchupStats", head + body)) {
        for (const tableRow of $("matchupStats").querySelectorAll("tbody tr")) {
          tableRow.onclick = () => {
            selectedMatchupKey = tableRow.dataset.opponentKey || "";
            selectOpponentDeckForMatchupKey(selectedMatchupKey);
            renderMatchupStats(rows);
          };
        }
      }
      renderMatchupDetail(rows.find((row) => row.opponentKey === selectedMatchupKey) || rows[0]);
      renderMatchupCardReadout(selectedProfile());
    }

    function selectOpponentDeckForMatchupKey(opponentKey) {
      const option = [...$("matchupKey").options].find((candidate) => candidate.dataset.opponentKey === opponentKey);
      if (!option) return;
      $("matchupKey").value = option.value;
      $("opponentSet").value = option.dataset.set || "";
      $("opponentColor").value = option.dataset.color || "";
      $("opponentTop").value = "";
    }

    function renderMatchupDetail(row) {
      if (!row) {
        setPanelEmpty("matchup-notes", true, "Select a matchup after matchup games are recorded to see notes, next tests, and opponent list coverage.");
        $("matchupDetailTitle").textContent = "Select a matchup";
        $("matchupDetailSub").textContent = "Click a matchup row to inspect the current evidence.";
        $("matchupEvidence").className = "health needs-data";
        $("matchupEvidence").textContent = "Needs Data";
        $("matchupGames").textContent = "-";
        $("matchupWinRate").textContent = "-";
        $("matchupLifeDiff").textContent = "-";
        $("matchupTurnCycles").textContent = "-";
        list("matchupReadNotes", [], "No matchup selected.");
        list("matchupNextTests", [], "Select a matchup to see suggested next tests.");
        list("matchupDeckLists", [], "Opponent deck IDs will appear after games are recorded.");
        return;
      }
      setPanelEmpty("matchup-notes", false);
      $("matchupDetailTitle").textContent = row.opponentLabel || row.opponentKey || "Matchup";
      $("matchupDetailSub").textContent = [
        row.opponentKey,
        fmt(row.opponentDeckCount) + " opponent list(s)",
        fmt(row.runs) + " run(s)"
      ].filter(Boolean).join(" | ");
      $("matchupEvidence").className = "health " + (row.evidenceTier || "needs-data");
      $("matchupEvidence").textContent = row.evidenceLabel || "Needs Data";
      $("matchupGames").textContent = row.wins + "/" + row.losses + "/" + row.incomplete;
      $("matchupWinRate").textContent = pct(row.winRate);
      $("matchupLifeDiff").textContent = numberText(row.avgLifeDiff);
      $("matchupTurnCycles").textContent = numberText(row.avgTurnCycles);
      list("matchupReadNotes", row.readNotes, "No matchup read available yet.");
      list("matchupNextTests", row.nextActions, "No matchup-specific next test yet.");
      list("matchupDeckLists", (row.opponentDeckIds || []).slice(0, 12), "No opponent deck IDs recorded yet.");
    }

    function renderMatchupCardReadout(profile) {
      const matchupKey = selectedMatchupKey || "";
      const matchup = (profile?.matchupStats ?? []).find((row) => row.opponentKey === matchupKey);
      if (!profile || !matchupKey) {
        setPanelEmpty("matchup-card-readout", true, "Select a matchup to see card-level evidence for that matchup.");
        $("matchupCardReadoutCaption").textContent = "Select a matchup";
        table("matchupCardReadout", ["Card","Role","Matchup Evidence","Read","Actions","Next Check"], []);
        return;
      }
      const deckCardsByNumber = new Map((profile.deckShape?.cards ?? []).flatMap((card) => [
        [String(card.number || card.id || ""), card],
        [String(card.id || card.number || ""), card]
      ]));
      const rows = (profile.cardEvidence?.cards ?? [])
        .map((card) => {
          const evidence = combinedCardMatchupEvidence(card.matchupEvidence ?? [], matchupKey);
          const deckCard = deckCardsByNumber.get(String(card.number || card.cardId || ""))
            || deckCardsByNumber.get(String(card.cardId || card.number || ""))
            || card;
          return evidence ? { card, deckCard, evidence } : null;
        })
        .filter(Boolean)
        .sort((a, b) => matchupCardPriority(b) - matchupCardPriority(a)
          || Number(b.evidence.decisions ?? 0) - Number(a.evidence.decisions ?? 0)
          || String(a.card.number || a.card.cardId || "").localeCompare(String(b.card.number || b.card.cardId || "")));
      const totalDecisions = rows.reduce((total, row) => total + Number(row.evidence.decisions ?? 0), 0);
      $("matchupCardReadoutCaption").textContent = (matchup?.opponentLabel || matchupKey)
        + ": " + fmt(rows.length) + " cards, " + fmt(totalDecisions) + " chosen matchup-linked card decisions"
        + (profile?.cardEvidence?.modelExamples ? " from " + fmt(profile.cardEvidence.modelExamples) + " ML examples" : "");
      setPanelEmpty("matchup-card-readout", rows.length === 0, "No card-level decisions have been linked to this matchup yet. Use record-decisions during focused matchup runs.");
      table("matchupCardReadout", ["Card","Role","Matchup Evidence","Read","Actions","Next Check"], rows.slice(0, 40).map(({ card, deckCard, evidence }) => [
        cell((card.count || deckCard.count || 0) + "x " + (card.name || deckCard.name || card.cardId), card.number || card.cardId),
        esc(deckCardRoleText(deckCard)),
        esc(cardMatchupEvidenceText(evidence)),
        esc(cardMatchupReadText(evidence)),
        esc(topEntryText(evidence.actionTypes, 3)),
        esc(cardMatchupNextCheckText(evidence, matchup))
      ]));
    }

    function combinedCardMatchupEvidence(rows, matchupKey) {
      const matches = (rows || []).filter((row) => matchupEvidenceKeyMatches(row.key, matchupKey));
      if (matches.length === 0) return null;
      const total = matches.reduce((sum, row) => sum + Number(row.decisions ?? 0), 0);
      const actionTypes = new Map();
      for (const row of matches) {
        for (const entry of row.actionTypes || []) {
          actionTypes.set(entry.key, (actionTypes.get(entry.key) || 0) + Number(entry.count || 0));
        }
      }
      return {
        key: matchupKey,
        sourceKeys: matches.map((row) => row.key),
        decisions: total,
        wins: matches.reduce((sum, row) => sum + Number(row.wins ?? 0), 0),
        losses: matches.reduce((sum, row) => sum + Number(row.losses ?? 0), 0),
        incomplete: matches.reduce((sum, row) => sum + Number(row.incomplete ?? 0), 0),
        winRate: matches.reduce((sum, row) => sum + Number(row.wins ?? 0), 0) / Math.max(1, total),
        avgShapedReward: matches.reduce((sum, row) => sum + Number(row.avgShapedReward ?? 0) * Number(row.decisions ?? 0), 0) / Math.max(1, total),
        avgLifeDiff: matches.reduce((sum, row) => sum + Number(row.avgLifeDiff ?? 0) * Number(row.decisions ?? 0), 0) / Math.max(1, total),
        avgTurnCycles: matches.reduce((sum, row) => sum + Number(row.avgTurnCycles ?? 0) * Number(row.decisions ?? 0), 0) / Math.max(1, total),
        actionTypes: [...actionTypes.entries()]
          .sort((a, b) => Number(b[1]) - Number(a[1]) || String(a[0]).localeCompare(String(b[0])))
          .slice(0, 4)
          .map(([key, count]) => ({ key, count }))
      };
    }

    function matchupEvidenceKeyMatches(candidate, selected) {
      const key = String(candidate || "");
      const target = String(selected || "");
      return Boolean(key && target && (key === target || key.startsWith(target + "__")));
    }

    function renderKnowledge(rows) {
      table("knowledge", ["Update","Health","Rows","Model","Overlays","Changes","Updated"], rows.map((row) => [
        cell(row.id, row.path),
        knowledgeHealthCell(row.learningHealth),
        fmt(row.chosenRows),
        fmt(row.modelExamples) + " / " + fmt(row.modelFeatures),
        fmt(row.overlays) + (row.overlayCandidates ? " + " + fmt(row.overlayCandidates) + " collecting" : ""),
        row.overlayChanges
          ? row.overlayChanges.created + "c " + row.overlayChanges.updated + "u / "
            + fmt(row.overlayChanges.candidateCreated) + " candidate-c " + fmt(row.overlayChanges.candidateUpdated) + " candidate-u"
          : "-",
        shortDate(row.updatedAt)
      ]));
    }

    function knowledgeHealthCell(health) {
      if (!health) return statusCell("Unknown", "warn");
      const status = String(health.status || "").toLowerCase();
      const klass = status === "healthy" ? "good" : status === "blocked" ? "bad" : "warn";
      const details = []
        .concat(health.blockers || [])
        .concat(health.warnings || [])
        .slice(0, 4)
        .join(" | ");
      return "<span title=\\"" + esc(details || health.label || status || "Unknown") + "\\">"
        + statusCell(health.label || status || "Unknown", klass)
        + "</span>";
    }

    function learningFeatureGroupName(feature) {
      const value = String(feature ?? "");
      if (value.startsWith("context.")) {
        const parts = value.split(".");
        const family = parts[1] || "";
        const actionId = parts[3] || "";
        if (family === "setup") return "opening hand cards";
        if (family === "attack") return "specific attackers";
        if (family === "block") return "specific blockers";
        if (family === "ability") return "specific abilities";
        if (family === "raid") return "specific Raid lines";
        if (family === "move") return "specific movement";
        if (family === "play") return "specific card plays";
        if (family === "discard") return "specific discards";
        if (family === "choice") return actionId === "raid" ? "specific Raid choices" : actionId === "play" ? "specific play choices" : "specific ability choices";
        return "card-specific context";
      }
      if (value.startsWith("setup")) return "opening hand";
      if (value.startsWith("attack") || value.startsWith("snipe") || value.includes("lethal")) return "attack";
      if (value.startsWith("block") || value.startsWith("decline") || value.includes("Damage")) return "defense";
      if (value.startsWith("ability") || value === "activateMain") return "abilities";
      if (value.startsWith("role")) return "card roles";
      if (value.includes("Energy") || value.includes("energy") || value === "playToEnergy") return "energy";
      if (value === "playCard" || value === "playToFront" || value === "performRaid" || value === "moveToFront") return "development";
      return "general";
    }

    function humanizeClientFeature(feature) {
      const value = String(feature ?? "");
      if (value.startsWith("context.")) {
        return "card-specific " + value.split(".").slice(1).join(" ").replace(/_/g, " ");
      }
      return value
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/_/g, " ")
        .toLowerCase();
    }

    function learningSignalRead(signal) {
      const feature = String(signal?.feature ?? "");
      const direction = signal?.direction === "Reward" ? "rewards" : "punishes";
      if (feature.startsWith("context.")) return "Model " + direction + " this exact card, ability, or line after repeated causal comparisons.";
      if (feature.startsWith("setup")) return "Model " + direction + " this opening-hand pattern.";
      if (feature.includes("lethal")) return "Model " + direction + " lethal pressure or defense.";
      if (feature.startsWith("block")) return "Model " + direction + " this blocking pattern.";
      if (feature.startsWith("decline")) return "Model " + direction + " choosing not to block here.";
      if (feature.startsWith("attack") || feature.startsWith("snipe")) return "Model " + direction + " this attack-pressure cue.";
      if (feature.startsWith("ability") || feature === "activateMain") return "Model " + direction + " this ability timing or payoff.";
      if (feature.includes("Energy") || feature.includes("energy") || feature === "playToEnergy") return "Model " + direction + " this energy-development cue.";
      if (feature.startsWith("role")) return "Model " + direction + " this card-role contribution.";
      return "Model " + direction + " this game-state feature.";
    }

    function featureSelectionText(selection) {
      if (!selection) return "";
      const selected = Number(selection.contextualSelected || 0);
      const eligible = Number(selection.contextualEligible || 0);
      const dropped = Number(selection.contextualDropped || 0);
      const deferred = Number(selection.contextualDeferredForSupport || 0);
      return ", " + fmt(selected) + "/" + fmt(eligible) + " card-specific"
        + (dropped > 0 ? " (" + fmt(dropped) + " below feature budget)" : "")
        + (deferred > 0 ? ", " + fmt(deferred) + " collecting evidence" : "");
    }

    function table(id, headers, rows) {
      const head = "<thead><tr>" + headers.map((h) => "<th>" + esc(h) + "</th>").join("") + "</tr></thead>";
      const body = "<tbody>" + rows.map((row) => "<tr>" + row.map((value) => "<td>" + value + "</td>").join("") + "</tr>").join("") + "</tbody>";
      return setHtml(id, head + body);
    }

    function cell(label, title) {
      return "<span title=\\"" + esc(title || "") + "\\">" + esc(label || "-") + "</span>";
    }

    function promoteText(run) {
      if (run.promotion?.promote || run.routedPromotion?.promote) return "<span class=\\"good\\">yes</span>";
      if (run.promotion || run.routedPromotion) return "<span class=\\"warn\\">no</span>";
      return "-";
    }

    function pct(value) {
      return value === null || value === undefined ? "-" : (Number(value) * 100).toFixed(1) + "%";
    }

    function fmt(value) {
      const number = Number(value);
      return Number.isFinite(number) ? number.toLocaleString() : "-";
    }

    function numberText(value) {
      const number = Number(value);
      return Number.isFinite(number) ? number.toFixed(2) : "-";
    }

    function shortDate(value) {
      if (!value) return "-";
      return new Date(value).toLocaleString();
    }

    function esc(value) {
      const div = document.createElement("div");
      div.textContent = String(value ?? "");
      return div.innerHTML;
    }
  </script>
</body>
</html>`;
}

function assertDashboardHtmlScripts(html) {
  const scripts = [...String(html).matchAll(/<script[^>]*>([\s\S]*?)<\/script>/giu)].map((match) => match[1]);
  if (scripts.length === 0) throw new Error("Dashboard HTML did not contain an embedded script.");
  for (let index = 0; index < scripts.length; index += 1) {
    new Script(scripts[index], { filename: `pilot-dashboard-inline-${index + 1}.js` });
  }
}
