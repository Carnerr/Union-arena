#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomicSync } from "../src/artifact-io.js";
import { matchupOverlayReadiness, mlActionModelReadiness } from "../src/index.js";
import {
  actionModelCandidatePathsForKey,
  baselinePolicyPathForKey,
  matchupOverlayCandidateFilesForKey,
  matchupOverlayFilesForKey,
  policyKeySegment,
  resolveArchetypeProfile
} from "../src/policy-router.js";

const agentRoot = option("--agent-root") ?? "work/private/pilot-agent";
const libraryDir = option("--library") ?? "work/private/decks";
const policyDir = option("--policy-dir") ?? join(agentRoot, "policies");
const runsRoot = option("--runs-root") ?? join(agentRoot, "runs");
const baselineRoot = option("--baseline-root") ?? join(agentRoot, "baselines");
const catalogPath = option("--catalog") ?? "work/private/egman-unionarena-catalog.json";
const deckPrefix = option("--deck-prefix") ?? "carnerr-,engine-";
const deckPrefixes = splitList(deckPrefix);
const seed = Number(option("--seed") ?? 19001);
const seedStep = Number(option("--seed-step") ?? 1009);
const session = option("--session") ?? `matchup-sweep-${seed}`;
const outRoot = option("--out-root") ?? join(agentRoot, "matchup-sweeps", session);
const mode = normalizeMode(option("--mode") ?? "priority");
const limit = Math.max(1, Number(option("--limit") ?? option("--tasks") ?? 3));
const targetGames = Math.max(1, Number(option("--target-games") ?? 60));
const minGames = Math.max(0, Number(option("--min-games") ?? 20));
const matchupMinExamples = Math.max(1, Number(option("--matchup-min-examples") ?? 80));
const weakWinRate = Number(option("--weak-win-rate") ?? 0.45);
const weakLifeDiff = Number(option("--weak-life-diff") ?? -1);
const priorityShape = normalizePriorityShape(option("--priority-shape") ?? "coverage");
const cyclesPerTask = Math.max(1, Number(option("--cycles-per-task") ?? 1));
const opponentSampleSize = Math.max(1, Number(option("--opponent-sample-size") ?? option("--opponent-count") ?? option("--parallel-opponent-count-per-run") ?? 1));
const finalGames = Math.max(1, Number(option("--final-games") ?? 8));
const dryRun = hasFlag("--dry-run");
const failFast = hasFlag("--fail-fast");
const includeMirror = hasFlag("--include-mirror");
const bootstrapBaselineIfMissing = hasFlag("--bootstrap-baseline-if-missing");
const allowUnreadyActionModel = hasFlag("--allow-unready-action-model") || hasFlag("--allow-missing-action-model");
const catalog = readJsonIfExists(catalogPath) ?? {};

if (hasFlag("--help")) {
  usage();
  process.exit(0);
}

mkdirSync(outRoot, { recursive: true });

const allDecks = savedDecks();
const requestedPilotDecks = selectedPilotDeckCandidates(allDecks);
const pilotDecks = selectedPilotDecks(allDecks);
const regionalBuckets = regionalArchetypeBuckets(allDecks);
const stats = matchupStatsByOwnKey(allDecks);
const tasks = prioritizedTasks({ pilotDecks, regionalBuckets, stats }).slice(0, limit);
const state = {
  schema: "union-arena-local-engine/pilot-matchup-sweep@1",
  startedAt: new Date().toISOString(),
  session,
  mode,
  config: {
    agentRoot,
    libraryDir,
    policyDir,
    runsRoot,
    baselineRoot,
    deckPrefix,
    seed,
    seedStep,
    limit,
    targetGames,
    minGames,
    matchupMinExamples,
    weakWinRate,
    weakLifeDiff,
    priorityShape,
    cyclesPerTask,
    dryRun,
    includeMirror,
    bootstrapBaselineIfMissing,
    allowUnreadyActionModel,
    games: option("--games") ?? "8",
    generations: option("--generations") ?? "1",
    population: option("--population") ?? "4",
    finalGames,
    matchupValidationGames: option("--matchup-validation-games") ?? "20",
    opponentSampleSize,
    parallelRuns: option("--parallel-runs") ?? "14",
    parallelConcurrency: option("--parallel-concurrency") ?? option("--parallel-runs") ?? "14",
    failFast
  },
  pilotDecks: pilotDecks.map((deck) => ({
    id: deck.id,
    name: deck.name,
    ownKey: deck.ownKey,
    baselineReady: deck.baselineReady,
    actionModelReady: deck.actionModelReady,
    actionModelStatus: deck.actionModelStatus,
    actionModelReason: deck.actionModelReason
  })),
  excludedPilotDecks: requestedPilotDecks
    .filter((deck) => !pilotDecks.some((selected) => selected.id === deck.id))
    .map((deck) => ({
      id: deck.id,
      name: deck.name,
      ownKey: deck.ownKey,
      baselineReady: deck.baselineReady,
      actionModelReady: deck.actionModelReady,
      actionModelStatus: deck.actionModelStatus,
      reason: !deck.baselineReady && !bootstrapBaselineIfMissing
        ? "specialist baseline is not ready"
        : !deck.actionModelReady && !allowUnreadyActionModel && !(bootstrapBaselineIfMissing && !deck.baselineReady)
          ? deck.actionModelReason
          : "excluded by matchup sweep filters"
    })),
  regionalArchetypes: regionalBuckets.map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    count: bucket.deckIds.length,
    deckIds: bucket.deckIds
  })),
  selectedTasks: tasks.map(taskSummary),
  currentTask: null,
  results: []
};

writeState(state);
writeCommands(tasks);

if (tasks.length === 0) {
  state.completedAt = new Date().toISOString();
  const readinessReasons = (state.excludedPilotDecks ?? [])
    .map((deck) => `${deck.name}: ${deck.reason}`)
    .slice(0, 4);
  state.stopReason = readinessReasons.length > 0
    ? `No matchup sweep tasks were ready. ${readinessReasons.join("; ")}.`
    : "No matchup sweep tasks matched the current filters.";
  writeState(state);
  console.log(state.stopReason);
  process.exit(0);
}

console.log(`Matchup sweep ${session}: ${tasks.length} task(s) selected.`);
console.log(`State: ${join(outRoot, "matchup-sweep-state.json")}`);
console.log(`Commands: ${join(outRoot, "commands.ps1")}`);

for (let index = 0; index < tasks.length; index += 1) {
  const task = tasks[index];
  const args = taskArgs(task, index);
  const command = commandText(args);
  const startedAt = new Date().toISOString();
  state.currentTask = {
    ...taskSummary(task),
    index: index + 1,
    seed: seed + index * seedStep,
    command,
    startedAt,
    status: "running"
  };
  writeState(state);
  console.log(`\n=== Sweep task ${index + 1}/${tasks.length}: ${task.ownKey} vs ${task.opponentKey} ===`);
  console.log(command);
  const result = dryRun
    ? { status: 0, signal: null }
    : spawnSync(process.execPath, args, {
        cwd: process.cwd(),
        windowsHide: true,
        stdio: "inherit"
      });
  const row = {
    ...taskSummary(task),
    index: index + 1,
    seed: seed + index * seedStep,
    command,
    status: result.status,
    signal: result.signal,
    startedAt,
    endedAt: new Date().toISOString()
  };
  state.results.push(row);
  state.currentTask = null;
  writeState(state);
  if (result.status !== 0) {
    state.failedTasks ??= [];
    state.failedTasks.push(row);
    state.stopReason = `Sweep task failed: ${task.ownKey} vs ${task.opponentKey}.`;
    writeState(state);
    console.log(`${state.stopReason} Continuing to the next selected matchup.`);
    if (failFast) {
      state.completedAt = new Date().toISOString();
      state.stopReason = `${state.stopReason} --fail-fast was supplied.`;
      writeState(state);
      throw new Error(state.stopReason);
    }
  }
}

state.completedAt = new Date().toISOString();
const failedTaskCount = state.results.filter((row) => Number(row.status ?? 0) !== 0).length;
const succeededTaskCount = state.results.length - failedTaskCount;
state.stopReason = failedTaskCount > 0
  ? `Matchup sweep completed with ${succeededTaskCount} succeeded and ${failedTaskCount} failed task(s).`
  : "Matchup sweep completed.";
writeState(state);
console.log(`\n${state.stopReason}`);

function selectedPilotDecks(decks) {
  return selectedPilotDeckCandidates(decks)
    .filter((deck) => bootstrapBaselineIfMissing || deck.baselineReady)
    .filter((deck) => allowUnreadyActionModel || deck.actionModelReady || (bootstrapBaselineIfMissing && !deck.baselineReady));
}

function selectedPilotDeckCandidates(decks) {
  const requested = splitList(option("--deck") ?? option("--decks") ?? "carnerr-spear");
  const allRequested = requested.some((value) => ["all", "all-decks", "all-visible"].includes(policyKeySegment(value)));
  return decks
    .filter((deck) => !deck.isRegional)
    .filter((deck) => deckPrefixes.length === 0 || deckPrefixes.some((prefix) => deck.id.startsWith(prefix)))
    .filter((deck) => allRequested || requested.includes(deck.id) || requested.includes(deck.ownKey))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function regionalArchetypeBuckets(decks) {
  const requestedOpponentKeys = new Set(splitList(option("--opponent-keys") ?? option("--matchups") ?? "").map(policyKeySegment));
  const excludedOpponentKeys = new Set(splitList(option("--exclude-opponent-keys") ?? "").map(policyKeySegment));
  const buckets = new Map();
  for (const deck of decks) {
    if (!deck.isRegional || !deck.ownKey) continue;
    if (requestedOpponentKeys.size > 0 && !requestedOpponentKeys.has(deck.ownKey)) continue;
    if (excludedOpponentKeys.has(deck.ownKey)) continue;
    const bucket = buckets.get(deck.ownKey) ?? {
      key: deck.ownKey,
      label: archetypeLabel(deck),
      sourceCode: deck.sourceCode,
      colors: deck.colors,
      deckIds: [],
      placements: [],
      locations: new Set()
    };
    bucket.deckIds.push(deck.id);
    if (Number.isFinite(Number(deck.placement))) bucket.placements.push(Number(deck.placement));
    if (deck.location) bucket.locations.add(deck.location);
    buckets.set(deck.ownKey, bucket);
  }
  return [...buckets.values()]
    .map((bucket) => ({
      ...bucket,
      deckIds: bucket.deckIds.sort((a, b) => a.localeCompare(b)),
      placements: bucket.placements.sort((a, b) => a - b),
      locations: [...bucket.locations].sort((a, b) => a.localeCompare(b))
    }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
}

function prioritizedTasks({ pilotDecks, regionalBuckets, stats }) {
  const rows = [];
  for (const deck of pilotDecks) {
    for (const opponent of regionalBuckets) {
      if (!includeMirror && deck.ownKey === opponent.key) continue;
      const stat = stats.get(`${deck.ownKey}||${opponent.key}`) ?? null;
      const games = Number(stat?.games ?? 0);
      const winRate = Number(stat?.winRate ?? 0);
      const lifeDiff = Number(stat?.avgLifeDiff ?? 0);
      const weak = games >= minGames && (winRate < weakWinRate || lifeDiff <= weakLifeDiff);
      const missing = games === 0;
      const lowSample = games < targetGames;
      const matchupLearning = matchupLearningStatus(deck.ownKey, opponent.key);
      const knowledgeGap = !matchupLearning.runtimeReady;
      if (mode === "missing" && !missing && matchupLearning.evidenceExamples > 0) continue;
      if (mode === "low-sample" && !lowSample && !knowledgeGap) continue;
      if (mode === "weak" && !weak) continue;
      if (mode === "all" || mode === "priority" || missing || lowSample || weak || knowledgeGap) {
        rows.push({
          deckId: deck.id,
          deckName: deck.name,
          ownKey: deck.ownKey,
          opponentKey: opponent.key,
          opponentLabel: opponent.label,
          opponentDeckIds: opponent.deckIds,
          opponentListCount: opponent.deckIds.length,
          opponentTopPlacement: opponent.placements[0] ?? null,
          stat,
          games,
          winRate: stat ? winRate : null,
          avgLifeDiff: stat ? lifeDiff : null,
          matchupLearning,
          priority: taskPriority({ games, winRate, lifeDiff, missing, lowSample, weak, opponent, matchupLearning }),
          priorityDetails: taskPriorityDetails({ games, winRate, lifeDiff, missing, lowSample, weak, opponent, matchupLearning })
        });
      }
    }
  }
  return rows.sort((a, b) => b.priority - a.priority
    || a.deckName.localeCompare(b.deckName)
    || a.opponentLabel.localeCompare(b.opponentLabel));
}

function taskPriority(args) {
  return taskPriorityDetails(args).score;
}

function taskPriorityDetails({ games, winRate, lifeDiff, missing, lowSample, weak, opponent, matchupLearning }) {
  let score = 0;
  const details = [];
  const target = Math.max(1, targetGames);
  const saturation = Math.max(1, games / target);
  const decay = priorityShape === "exploit"
    ? 1
    : priorityShape === "balanced"
      ? 1 / Math.sqrt(saturation)
      : 1 / saturation;

  if (missing) {
    score += 12000;
    details.push("missing");
  }
  if (games < minGames) {
    const minScore = Math.max(0, minGames - games) * 140;
    score += minScore;
    if (minScore > 0) details.push(`below-min:+${Math.round(minScore)}`);
  }
  if (lowSample) {
    const coverageScore = Math.max(0, targetGames - games) * 110;
    score += coverageScore;
    if (coverageScore > 0) details.push(`coverage:+${Math.round(coverageScore)}`);
  }
  if (weak) score += 5000 + Math.max(0, weakWinRate - winRate) * 4000 + Math.max(0, -lifeDiff) * 250;
  if (weak) {
    const rawWeakScore = 5000 + Math.max(0, weakWinRate - winRate) * 4000 + Math.max(0, -lifeDiff) * 250;
    const weakScore = rawWeakScore * decay;
    score += weakScore - rawWeakScore;
    details.push(`weak:${priorityShape}:x${decay.toFixed(2)}`);
  }
  if (!matchupLearning.runtimeReady) {
    const readiness = matchupLearning.causalReadiness;
    const thresholds = readiness.thresholds;
    if (matchupLearning.evidenceExamples === 0) {
      score += 12000;
      details.push("matchup-evidence-missing:+12000");
    } else if (matchupLearning.causalReady) {
      score += 9000;
      details.push("matchup-validation-ready:+9000");
    } else {
      const exampleDeficit = Math.max(0, matchupMinExamples - matchupLearning.evidenceExamples) * 50;
      const pairDeficit = Math.max(0, thresholds.pairwiseExamples - readiness.pairwiseExamples) * 200;
      const massDeficit = Math.max(0, thresholds.pairwiseEffectiveWeight - readiness.pairwiseEffectiveWeight) * 1200;
      const phaseDeficit = Math.max(0, thresholds.distinctPhases - readiness.evidenceDiversity.distinctPhases) * 1800;
      const actionPairDeficit = Math.max(0, thresholds.distinctActionPairs - readiness.evidenceDiversity.distinctActionPairs) * 1400;
      const causalScore = exampleDeficit + pairDeficit + massDeficit + phaseDeficit + actionPairDeficit;
      score += causalScore;
      if (causalScore > 0) details.push(`causal-deficit:+${Math.round(causalScore)}`);
      if (readiness.blockerCodes.some((code) => code.startsWith("stale") || code === "unclassified-evidence")) {
        score += 8000;
        details.push("causal-migration:+8000");
      }
      if (readiness.blockerCodes.includes("concentrated-action-pairs")) {
        score += 4000;
        details.push("action-breadth:+4000");
      }
    }
  }
  const populationScore = Math.min(2000, opponent.deckIds.length * 120);
  score += populationScore;
  if (populationScore > 0) details.push(`lists:+${Math.round(populationScore)}`);
  const placementScore = Number.isFinite(Number(opponent.placements[0]))
    ? Math.max(0, 500 - Number(opponent.placements[0]) * 10)
    : 0;
  score += placementScore;
  if (placementScore > 0) details.push(`top:+${Math.round(placementScore)}`);
  return {
    score,
    priorityShape,
    saturation: Number(saturation.toFixed(3)),
    decay: Number(decay.toFixed(3)),
    reasons: details
  };
}

function matchupLearningStatus(ownKey, opponentKey) {
  const active = strongestOverlayArtifact(
    matchupOverlayFilesForKey(ownKey, { policyDir, baselineRoot })
      .filter((file) => file.opponentKey === opponentKey)
  );
  const candidate = strongestOverlayArtifact(
    matchupOverlayCandidateFilesForKey(ownKey, { policyDir, baselineRoot })
      .filter((file) => file.opponentKey === opponentKey)
  );
  const evidence = strongestOverlay([active, candidate].filter(Boolean));
  const runtimeReadiness = matchupOverlayReadiness(active?.overlay ?? null);
  const causalReadiness = matchupOverlayReadiness(evidence?.overlay ?? null, { requireImpactValidation: false });
  return {
    runtimeReady: runtimeReadiness.ready,
    runtimeStatus: runtimeReadiness.status,
    runtimeReason: runtimeReadiness.reason,
    activePath: active?.path ?? null,
    candidatePath: candidate?.path ?? null,
    evidencePath: evidence?.path ?? null,
    evidenceExamples: Number(evidence?.overlay?.examples ?? 0),
    causalReady: causalReadiness.ready && (active !== null || Number(evidence?.overlay?.examples ?? 0) >= matchupMinExamples),
    causalReadiness
  };
}

function strongestOverlayArtifact(files) {
  return strongestOverlay(files
    .map((file) => ({ ...file, overlay: readJsonIfExists(file.path) }))
    .filter((file) => file.overlay));
}

function strongestOverlay(rows) {
  return [...rows].sort((left, right) => (
    Number(right.overlay?.pairwiseEffectiveWeight ?? 0) - Number(left.overlay?.pairwiseEffectiveWeight ?? 0)
    || Number(right.overlay?.pairwiseExamples ?? 0) - Number(left.overlay?.pairwiseExamples ?? 0)
    || Number(right.overlay?.examples ?? 0) - Number(left.overlay?.examples ?? 0)
  ))[0] ?? null;
}

function taskArgs(task, index) {
  const taskSeed = seed + index * seedStep;
  const taskSession = `${session}-${policyKeySegment(task.deckId)}-vs-${policyKeySegment(task.opponentKey)}`;
  const taskOutRoot = join(outRoot, policyKeySegment(task.deckId), policyKeySegment(task.opponentKey));
  const args = [
    "tools/pilot-loop-overseer.mjs",
    "--training-mode", "matchup",
    "--deck", task.deckId,
    "--own-key", task.ownKey,
    "--seed", String(taskSeed),
    "--session", taskSession,
    "--cycles", String(cyclesPerTask),
    "--out-root", taskOutRoot,
    "--opponent-mode", "explicit",
    "--opponents", task.opponentDeckIds.join(","),
    "--opponent-count", String(Math.min(opponentSampleSize, task.opponentDeckIds.length))
  ];
  appendSharedOverseerArgs(args);
  pushValueIfChanged(args, "--parallel-runs", option("--parallel-runs") ?? "14", "14");
  pushValueIfChanged(args, "--parallel-concurrency", option("--parallel-concurrency") ?? option("--parallel-runs") ?? "14", option("--parallel-runs") ?? "14");
  pushValueIfChanged(args, "--parallel-opponent-count-per-run", option("--parallel-opponent-count-per-run") ?? "1", "1");
  pushValueIfChanged(args, "--games", option("--games") ?? "8", "8");
  pushValueIfChanged(args, "--generations", option("--generations") ?? "1", "1");
  pushValueIfChanged(args, "--population", option("--population") ?? "4", "4");
  pushValueIfChanged(args, "--final-games", option("--final-games") ?? String(finalGames), "8");
  pushValueIfChanged(args, "--matchup-validation-games", option("--matchup-validation-games") ?? "20", "20");
  pushValueIfChanged(args, "--parallel-final-games", option("--parallel-final-games") ?? "0", "0");
  pushValueIfChanged(args, "--parallel-final-top-percent", option("--parallel-final-top-percent") ?? "25", "25");
  pushValueIfChanged(args, "--parallel-final-candidates", option("--parallel-final-candidates") ?? "merged-baseline", "merged-baseline");
  pushValueIfChanged(args, "--decision-log-mode", option("--decision-log-mode") ?? "learning", "learning");
  pushValueIfChanged(args, "--knowledge-mode", option("--knowledge-mode") ?? "full", "full");
  pushValueIfChanged(args, "--progress-minutes", option("--progress-minutes") ?? "2", "2");
  appendExplorationArgs(args);
  if (bootstrapBaselineIfMissing) args.push("--bootstrap-baseline-if-missing");
  if (hasFlag("--no-ml")) args.push("--no-ml");
  if (dryRun) args.push("--dry-run");
  return args;
}

function savedDecks() {
  if (!existsSync(libraryDir)) return [];
  return readdirSync(libraryDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => deckOptionFromFile(join(libraryDir, entry.name), entry.name))
    .filter(Boolean);
}

function deckOptionFromFile(path, fileName) {
  const raw = readJsonIfExists(path);
  if (!raw || !Array.isArray(raw.cards)) return null;
  const id = raw.id ?? fileName.replace(/\.json$/u, "");
  const source = raw.source ?? {};
  const archetypeResolution = resolveArchetypeProfile({
    deck: raw.cards,
    savedDeck: raw,
    deckId: id,
    catalog,
    deckLibrary: libraryDir,
    deckPrefixes
  });
  const profile = archetypeResolution.profile;
  const colors = profile.colors ?? [];
  const sourceCode = profile.sourceCode ?? raw.validation?.sourceCode ?? raw.summary?.sourceCode ?? raw.summary?.sourceCodes?.[0] ?? null;
  const actionModelPaths = actionModelCandidatePathsForKey(profile.key, { agentRoot, baselineRoot });
  const actionModelPath = actionModelPaths.find((candidate) => existsSync(candidate)) ?? actionModelPaths[0] ?? null;
  const actionModel = actionModelPath ? readJsonIfExists(actionModelPath) : null;
  const actionModelReadiness = mlActionModelReadiness(actionModel);
  return {
    id,
    name: raw.name ?? id,
    path,
    ownKey: profile.key,
    sourceCode,
    colors,
    archetype: source.archetype ?? profile.archetypeResolution?.nearest?.archetype ?? null,
    isRegional: id.startsWith("regional-") || Boolean(source.location || source.manifestPath),
    location: source.location ?? null,
    player: source.player ?? null,
    placement: Number.isFinite(Number(source.placement)) ? Number(source.placement) : null,
    baselineReady: existsSync(baselinePolicyPathForKey(profile.key, { policyDir, baselineRoot })),
    actionModelReady: actionModelReadiness.ready,
    actionModelStatus: actionModelReadiness.status,
    actionModelReason: actionModelReadiness.reason,
    actionModelPath
  };
}

function matchupStatsByOwnKey(decks) {
  const deckById = new Map(decks.map((deck) => [deck.id, deck]));
  const buckets = new Map();
  const seenGames = new Set();
  for (const entry of reportEntries(runsRoot)) {
    const report = entry.report;
    if (report?.config?.parallelFinalSkipped && hasChildReports(entry.dir)) continue;
    const ownKey = reportOwnKey(report);
    if (!ownKey || !Array.isArray(report.games)) continue;
    const policyFingerprint = matchupReportPolicyFingerprint(report);
    for (const game of report.games) {
      const gameKey = matchupGameFingerprint(ownKey, game, policyFingerprint);
      if (gameKey && seenGames.has(gameKey)) continue;
      if (gameKey) seenGames.add(gameKey);
      const opponentDeck = deckById.get(game.opponent);
      const opponentKey = opponentDeck?.ownKey ?? game.opponent ?? "unknown";
      const key = `${ownKey}||${opponentKey}`;
      const bucket = buckets.get(key) ?? {
        ownKey,
        opponentKey,
        games: 0,
        wins: 0,
        losses: 0,
        incomplete: 0,
        lifeDiffTotal: 0
      };
      bucket.games += 1;
      if (game.winner === "P1") bucket.wins += 1;
      else if (game.winner === "P2") bucket.losses += 1;
      else bucket.incomplete += 1;
      bucket.lifeDiffTotal += Number(game.p1LifeRemaining ?? 0) - Number(game.p2LifeRemaining ?? 0);
      buckets.set(key, bucket);
    }
  }
  for (const bucket of buckets.values()) {
    const total = Math.max(1, bucket.games);
    bucket.winRate = bucket.wins / total;
    bucket.avgLifeDiff = bucket.lifeDiffTotal / total;
  }
  return buckets;
}

function reportEntries(root) {
  if (!existsSync(root)) return [];
  const entries = [];
  const queue = [root];
  while (queue.length > 0 && entries.length < 10000) {
    const dir = queue.shift();
    const reportPath = join(dir, "report.json");
    const report = readJsonIfExists(reportPath);
    if (report) entries.push({ dir, path: reportPath, report });
    const childDirs = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name))
      .sort((a, b) => Number(fileMtimeMs(b)) - Number(fileMtimeMs(a)) || a.localeCompare(b));
    queue.push(...childDirs);
  }
  return entries;
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

function fileMtimeMs(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function reportOwnKey(report) {
  return report?.config?.policySelection?.profile?.key
    ?? report?.config?.matchupOverlaySelection?.profile?.key
    ?? report?.analysis?.deckProfile?.key
    ?? report?.bestPolicy?.profile?.key
    ?? null;
}

function taskSummary(task) {
  return {
    deckId: task.deckId,
    deckName: task.deckName,
    ownKey: task.ownKey,
    opponentKey: task.opponentKey,
    opponentLabel: task.opponentLabel,
    opponentListCount: task.opponentListCount,
    opponentTopPlacement: task.opponentTopPlacement,
    currentGames: task.games,
    currentWinRate: task.winRate,
    currentAvgLifeDiff: task.avgLifeDiff,
    priority: task.priority,
    priorityDetails: task.priorityDetails,
    matchupLearning: task.matchupLearning,
    opponentSampleSize: Math.min(opponentSampleSize, task.opponentDeckIds.length),
    opponentDeckIds: task.opponentDeckIds
  };
}

function archetypeLabel(deck) {
  const set = deck.sourceCode ?? "unknown";
  const colors = deck.colors?.length ? deck.colors.join("/") : "unknown";
  return [set, colors, deck.archetype].filter(Boolean).join(" ");
}

function appendSharedOverseerArgs(args) {
  pushValueIfChanged(args, "--agent-root", agentRoot, "work/private/pilot-agent");
  pushValueIfChanged(args, "--policy-dir", policyDir, join(agentRoot, "policies"));
  pushValueIfChanged(args, "--baseline-root", baselineRoot, join(agentRoot, "baselines"));
  pushValueIfChanged(args, "--runs-root", runsRoot, join(agentRoot, "runs"));
}

function appendExplorationArgs(args) {
  pushValueIfChanged(args, "--exploration-mode", option("--exploration-mode") ?? option("--action-exploration-mode") ?? "", "");
  pushValueIfChanged(args, "--exploration-rate", option("--exploration-rate") ?? option("--action-exploration-rate") ?? "", "");
  pushValueIfChanged(args, "--exploration-score-window", option("--exploration-score-window") ?? "", "");
  pushValueIfChanged(args, "--exploration-max-rank", option("--exploration-max-rank") ?? "", "");
  pushValueIfChanged(args, "--exploration-min-score", option("--exploration-min-score") ?? "", "");
  pushValueIfChanged(args, "--raid-normal-play-exploration-rate", option("--raid-normal-play-exploration-rate") ?? option("--raid-exploration-rate") ?? "", "");
  pushValueIfChanged(args, "--raid-normal-play-score-window", option("--raid-normal-play-score-window") ?? "", "");
  pushValueIfChanged(args, "--raid-normal-play-heuristic-window", option("--raid-normal-play-heuristic-window") ?? "", "");
  pushValueIfChanged(args, "--raid-normal-play-min-heuristic-score", option("--raid-normal-play-min-heuristic-score") ?? "", "");
  pushValueIfChanged(args, "--counterfactual-exploration-rate", option("--counterfactual-exploration-rate") ?? option("--counterfactual-rate") ?? "", "");
  pushValueIfChanged(args, "--counterfactual-max-per-game", option("--counterfactual-max-per-game") ?? "", "");
  pushValueIfChanged(args, "--counterfactual-rollout-actions", option("--counterfactual-rollout-actions") ?? "", "");
  pushValueIfChanged(args, "--counterfactual-rollout-player-turns", option("--counterfactual-rollout-player-turns") ?? "", "");
}

function pushValueIfChanged(args, flag, value, defaultValue) {
  if (String(value ?? "") === String(defaultValue ?? "")) return;
  args.push(flag, String(value));
}

function writeState(state) {
  mkdirSync(outRoot, { recursive: true });
  writeJsonAtomicSync(join(outRoot, "matchup-sweep-state.json"), state);
}

function writeCommands(tasks) {
  const commands = tasks.map((task, index) => commandText(taskArgs(task, index))).join("\n");
  writeFileSync(join(outRoot, "commands.ps1"), `${commands}${commands ? "\n" : ""}`);
}

function commandText(args) {
  return `node ${args.map(quoteArg).join(" ")}`;
}

function quoteArg(value) {
  const text = String(value);
  return /[\s"]/u.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function option(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function splitList(value) {
  return String(value ?? "")
    .split(/[,\r\n]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeMode(value) {
  const mode = policyKeySegment(value || "priority");
  const aliases = new Map([
    ["prioritized", "priority"],
    ["scout", "priority"],
    ["scouting", "priority"],
    ["low", "low-sample"],
    ["low-sample", "low-sample"],
    ["missing-only", "missing"],
    ["weak-only", "weak"]
  ]);
  const normalized = aliases.get(mode) ?? mode;
  if (!new Set(["priority", "missing", "low-sample", "weak", "all"]).has(normalized)) {
    throw new Error(`Unknown --mode: ${value}. Use priority, missing, low-sample, weak, or all.`);
  }
  return normalized;
}

function normalizePriorityShape(value) {
  const normalized = policyKeySegment(value || "coverage");
  const aliases = new Map([
    ["breadth", "coverage"],
    ["scout", "coverage"],
    ["scouting", "coverage"],
    ["fast", "coverage"],
    ["standard", "balanced"],
    ["mixed", "balanced"],
    ["depth", "exploit"],
    ["deep", "exploit"],
    ["greedy", "exploit"]
  ]);
  const shape = aliases.get(normalized) ?? normalized;
  if (!new Set(["coverage", "balanced", "exploit"]).has(shape)) {
    throw new Error(`Unknown --priority-shape: ${value}. Use coverage, balanced, or exploit.`);
  }
  return shape;
}

function usage() {
  console.log(`Usage:
  node tools/pilot-matchup-sweep.mjs --deck carnerr-spear --limit 3 --seed 19001

Runs fast matchup-learning tasks for selected pilot deck(s). Each task picks one
opponent archetype bucket, runs a skipped-final matchup pass, then lets the
overseer update the profile action model and matchup overlays.

Useful options:
  --deck carnerr-spear             selected pilot deck; use --deck all for every visible deck
  --mode priority|missing|low-sample|weak|all
  --priority-shape coverage|balanced|exploit
  --limit 3                        number of archetype tasks this sweep should run
  --target-games 60                low-sample threshold per own-vs-opponent bucket
  --opponent-sample-size 1         regional deck lists sampled per child run
  --games 8 --generations 1 --population 4
  --final-games 8
  --matchup-validation-games 20    paired old-vs-new validation games per task
  --parallel-runs 14 --parallel-concurrency 14
  --allow-unready-action-model     permit matchup work before profile ML exists
  --exploration-mode counterfactual-probe|action
  --counterfactual-exploration-rate 0.4
  --counterfactual-max-per-game 1
  --counterfactual-rollout-actions 64
  --counterfactual-rollout-player-turns 3
  --fail-fast                      stop on the first failed matchup task
  --dry-run`);
}
