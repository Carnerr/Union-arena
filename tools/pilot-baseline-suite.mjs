#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  baselineOriginPathForKey,
  baselinePolicyPathForKey,
  policyKeySegment,
  resolveArchetypeProfile
} from "../src/policy-router.js";

const agentRoot = option("--agent-root") ?? "work/private/pilot-agent";
const libraryDir = option("--library") ?? "work/private/decks";
const policyDir = option("--policy-dir") ?? join(agentRoot, "policies");
const baselineRoot = option("--baseline-root") ?? join(agentRoot, "baselines");
const runsRoot = option("--runs-root") ?? join(agentRoot, "runs");
const deckPrefix = option("--deck-prefix") ?? "carnerr-,engine-";
const deckPrefixes = deckPrefix.split(",").map((prefix) => prefix.trim()).filter(Boolean);
const seed = Number(option("--seed") ?? 17001);
const seedStep = Number(option("--seed-step") ?? 1009);
const cyclesPerDeck = Math.max(1, Number(option("--cycles-per-deck") ?? option("--cycles") ?? 1));
const suiteConcurrency = Math.max(1, Number(option("--suite-concurrency") ?? option("--baseline-suite-concurrency") ?? 1));
const opponentCount = option("--opponent-count") ?? "20";
const finalGames = option("--final-games") ?? "8";
const parallelRuns = option("--parallel-runs") ?? "14";
const parallelConcurrency = option("--parallel-concurrency") ?? option("--parallel-runs") ?? "14";
const games = option("--games") ?? "8";
const generations = option("--generations") ?? "2";
const population = option("--population") ?? "4";
const parallelOpponentCountPerRun = option("--parallel-opponent-count-per-run") ?? "6";
const parallelFinalGames = option("--parallel-final-games") ?? "0";
const parallelFinalTopPercent = option("--parallel-final-top-percent") ?? "35";
const parallelFinalCandidates = option("--parallel-final-candidates") ?? "best-baseline";
const decisionLogMode = option("--decision-log-mode") ?? "learning";
const progressMinutes = option("--progress-minutes") ?? "2";
const explorationMode = option("--exploration-mode") ?? option("--action-exploration-mode") ?? "";
const explorationRate = option("--exploration-rate") ?? option("--action-exploration-rate") ?? "";
const explorationScoreWindow = option("--exploration-score-window") ?? "";
const explorationMaxRank = option("--exploration-max-rank") ?? "";
const explorationMinScore = option("--exploration-min-score") ?? "";
const raidNormalPlayExplorationRate = option("--raid-normal-play-exploration-rate") ?? option("--raid-exploration-rate") ?? "";
const raidNormalPlayScoreWindow = option("--raid-normal-play-score-window") ?? "";
const raidNormalPlayHeuristicWindow = option("--raid-normal-play-heuristic-window") ?? "";
const raidNormalPlayMinHeuristicScore = option("--raid-normal-play-min-heuristic-score") ?? "";
const counterfactualExplorationRate = option("--counterfactual-exploration-rate") ?? option("--counterfactual-rate") ?? "";
const counterfactualMaxPerGame = option("--counterfactual-max-per-game") ?? "";
const counterfactualRolloutActions = option("--counterfactual-rollout-actions") ?? "";
const counterfactualRolloutPlayerTurns = option("--counterfactual-rollout-player-turns") ?? "";
const session = option("--session") ?? `pilot-baselines-${seed}`;
const outRoot = option("--out-root") ?? join(agentRoot, "loops", session);
const dryRun = hasFlag("--dry-run");
const missingOnly = hasFlag("--missing-only") || hasFlag("--missing-baselines");

if (hasFlag("--help")) {
  usage();
  process.exit(0);
}

const decks = selectedDecks(savedPilotDecks());
if (decks.length === 0) throw new Error(`No decks matching ${deckPrefix} found in ${libraryDir}.`);

mkdirSync(outRoot, { recursive: true });

const state = {
  schema: "union-arena-local-engine/pilot-baseline-suite@1",
  startedAt: new Date().toISOString(),
  session,
  config: {
    agentRoot,
    libraryDir,
    policyDir,
    baselineRoot,
    runsRoot,
    deckPrefix,
    requestedDecks: splitList(option("--decks") ?? option("--deck-ids") ?? ""),
    seed,
    seedStep,
    cyclesPerDeck,
    suiteConcurrency,
    opponentCount,
    finalGames,
    parallelRuns,
    parallelConcurrency,
    games,
    generations,
    population,
    parallelOpponentCountPerRun,
    parallelFinalGames,
    parallelFinalTopPercent,
    parallelFinalCandidates,
    decisionLogMode,
    progressMinutes,
    explorationMode,
    explorationRate,
    explorationScoreWindow,
    explorationMaxRank,
    explorationMinScore,
    raidNormalPlayExplorationRate,
    raidNormalPlayScoreWindow,
    raidNormalPlayHeuristicWindow,
    raidNormalPlayMinHeuristicScore,
    counterfactualExplorationRate,
    counterfactualMaxPerGame,
    counterfactualRolloutActions,
    counterfactualRolloutPlayerTurns,
    missingOnly,
    dryRun
  },
  decks: decks.map(({ id, name, ownKey, archetypeStatus, archetypeMethod, archetypeDistance, baselineStatus }) => ({
    id,
    name,
    ownKey,
    archetypeStatus,
    archetypeMethod,
    archetypeDistance,
    baselineStatus
  })),
  results: []
};

await runSuite();

state.completedAt = new Date().toISOString();
state.stopReason = "All pilot baseline decks completed.";
writeState(state);
console.log(`\nBaseline suite complete: ${join(outRoot, "baseline-suite-state.json")}`);

async function runSuite() {
  let nextIndex = 0;
  let failed = null;
  const workerCount = dryRun ? 1 : Math.min(suiteConcurrency, decks.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (!failed) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= decks.length) return;
      const row = await runDeck(decks[index], index);
      state.results.push(row);
      writeState(state);
      if (row.status !== 0) {
        failed = row;
        return;
      }
    }
  });
  await Promise.all(workers);
  if (failed) {
    state.completedAt = new Date().toISOString();
    state.stopReason = `Baseline failed for ${failed.deckId}.`;
    writeState(state);
    throw new Error(state.stopReason);
  }
}

function runDeck(deck, index) {
  const deckSeed = seed + index * seedStep;
  const deckSession = `${session}-${deck.id}`;
  const deckOutRoot = join(outRoot, deck.id);
  const args = [
    "tools/pilot-loop-overseer.mjs",
    "--training-mode", "deck",
    "--agent-preset", "baseline-suite",
    "--deck", deck.id,
    "--own-key", deck.ownKey,
    "--seed", String(deckSeed),
    "--session", deckSession,
    "--cycles", String(cyclesPerDeck),
    "--opponent-count", opponentCount,
    "--agent-root", agentRoot,
    "--policy-dir", policyDir,
    "--baseline-root", baselineRoot,
    "--runs-root", runsRoot,
    "--out-root", deckOutRoot,
    "--parallel-runs", parallelRuns,
    "--parallel-concurrency", parallelConcurrency,
    "--games", games,
    "--generations", generations,
    "--population", population,
    "--parallel-opponent-count-per-run", parallelOpponentCountPerRun,
    "--final-games", finalGames,
    "--parallel-final-games", parallelFinalGames,
    "--parallel-final-top-percent", parallelFinalTopPercent,
    "--parallel-final-candidates", parallelFinalCandidates,
    "--decision-log-mode", decisionLogMode,
    "--knowledge-mode", "action",
    "--progress-minutes", progressMinutes
  ];
  appendExplorationArgs(args);
  if (dryRun) args.push("--dry-run");

  const command = commandText(args);
  console.log(`\n=== Baseline ${index + 1}/${decks.length}: ${deck.name} (${deck.ownKey}) ===`);
  console.log(command);
  const startedAt = new Date().toISOString();
  if (dryRun) {
    return Promise.resolve({
      deckId: deck.id,
      deckName: deck.name,
      ownKey: deck.ownKey,
      seed: deckSeed,
      outRoot: deckOutRoot,
      command,
      status: 0,
      signal: null,
      dryRun: true,
      startedAt,
      endedAt: new Date().toISOString()
    });
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: "inherit"
    });
    child.on("exit", (status, signal) => {
      resolve({
        deckId: deck.id,
        deckName: deck.name,
        ownKey: deck.ownKey,
        seed: deckSeed,
        outRoot: deckOutRoot,
        command,
        status,
        signal,
        startedAt,
        endedAt: new Date().toISOString()
      });
    });
    child.on("error", (error) => {
      resolve({
        deckId: deck.id,
        deckName: deck.name,
        ownKey: deck.ownKey,
        seed: deckSeed,
        outRoot: deckOutRoot,
        command,
        status: 1,
        signal: null,
        error: error.message,
        startedAt,
        endedAt: new Date().toISOString()
      });
    });
  });
}

function savedPilotDecks() {
  if (!existsSync(libraryDir)) return [];
  return readdirSync(libraryDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      const path = join(libraryDir, entry.name);
      const raw = JSON.parse(readFileSync(path, "utf8"));
      const id = raw.id ?? entry.name.replace(/\.json$/u, "");
      if (!deckPrefixes.some((prefix) => id.startsWith(prefix))) return null;
      const archetypeResolution = resolveArchetypeProfile({
        savedDeck: raw,
        deck: raw.cards,
        deckId: id,
        deckLibrary: libraryDir,
        deckPrefixes
      });
      return {
        id,
        name: raw.name ?? id,
        path,
        ownKey: archetypeResolution.profile.key,
        archetypeStatus: archetypeResolution.status,
        archetypeMethod: archetypeResolution.method,
        archetypeDistance: archetypeResolution.distance,
        baselineStatus: baselineStatus(archetypeResolution.profile.key).status
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function selectedDecks(decks) {
  const requested = splitList(option("--decks") ?? option("--deck-ids") ?? "");
  const allRequested = requested.length === 0 || requested.some((value) => ["all", "all-decks"].includes(value));
  const selectable = missingOnly ? decks.filter((deck) => !baselineReady(deck.ownKey)) : decks;
  if (allRequested) return selectable;
  const requestedSet = new Set(requested);
  const requestedSegments = new Set(requested.map(policySegment));
  return selectable.filter((deck) => requestedSet.has(deck.id)
    || requestedSet.has(deck.ownKey)
    || requestedSegments.has(policySegment(deck.id))
    || requestedSegments.has(policySegment(deck.ownKey)));
}

function baselineReady(ownKey) {
  return baselineStatus(ownKey).ready;
}

function baselineStatus(ownKey) {
  const organizedPath = baselinePolicyPathForKey(ownKey, { policyDir, baselineRoot });
  if (existsSync(organizedPath)) {
    const origin = readJsonIfExists(baselineOriginPathForKey(ownKey, { policyDir, baselineRoot }));
    const quality = baselineOriginQuality(origin);
    const needsTraining = baselineOriginNeedsTraining(origin, quality);
    return {
      ready: !needsTraining,
      status: needsTraining ? quality === "unknown" ? "unknown" : "seed" : "trained"
    };
  }
  const legacyPath = join(policyDir, `${policyKeySegment(ownKey)}.json`);
  if (existsSync(legacyPath)) return { ready: false, status: "legacy" };
  return { ready: false, status: "missing" };
}

function baselineOriginQuality(origin) {
  if (!origin) return "unknown";
  if (origin.quality) return String(origin.quality);
  if (origin.promotionType === "missing-seed" || origin.promotionType === "implicit-seed" || origin.needsTraining) return "seed";
  if (["improved", "missing-improved", "forced", "initial-trained"].includes(origin.promotionType)) return "trained";
  return "unknown";
}

function baselineOriginNeedsTraining(origin, quality) {
  if (!origin) return true;
  if (origin.needsTraining === true) return true;
  return quality === "seed" || quality === "unknown";
}

function readJsonIfExists(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeState(state) {
  mkdirSync(outRoot, { recursive: true });
  writeFileSync(join(outRoot, "baseline-suite-state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

function commandText(args) {
  return `node ${args.map(quoteArg).join(" ")}`;
}

function quoteArg(value) {
  const text = String(value);
  return /[\s"]/u.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
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

function policySegment(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function appendExplorationArgs(args) {
  pushValueIfChanged(args, "--exploration-mode", explorationMode, "");
  pushValueIfChanged(args, "--exploration-rate", explorationRate, "");
  pushValueIfChanged(args, "--exploration-score-window", explorationScoreWindow, "");
  pushValueIfChanged(args, "--exploration-max-rank", explorationMaxRank, "");
  pushValueIfChanged(args, "--exploration-min-score", explorationMinScore, "");
  pushValueIfChanged(args, "--raid-normal-play-exploration-rate", raidNormalPlayExplorationRate, "");
  pushValueIfChanged(args, "--raid-normal-play-score-window", raidNormalPlayScoreWindow, "");
  pushValueIfChanged(args, "--raid-normal-play-heuristic-window", raidNormalPlayHeuristicWindow, "");
  pushValueIfChanged(args, "--raid-normal-play-min-heuristic-score", raidNormalPlayMinHeuristicScore, "");
  pushValueIfChanged(args, "--counterfactual-exploration-rate", counterfactualExplorationRate, "");
  pushValueIfChanged(args, "--counterfactual-max-per-game", counterfactualMaxPerGame, "");
  pushValueIfChanged(args, "--counterfactual-rollout-actions", counterfactualRolloutActions, "");
  pushValueIfChanged(args, "--counterfactual-rollout-player-turns", counterfactualRolloutPlayerTurns, "");
}

function pushValueIfChanged(args, flag, value, defaultValue) {
  if (String(value ?? "") === String(defaultValue ?? "")) return;
  args.push(flag, String(value));
}

function usage() {
  console.log(`Usage:
  node tools/pilot-baseline-suite.mjs --seed 17001 --cycles-per-deck 1

Runs deck-baseline training once for each saved pilot deck.

Useful options:
  --deck-prefix carnerr-,engine-
  --parallel-runs 14
  --parallel-concurrency 14
  --cycles-per-deck 1
  --suite-concurrency 1
  --decks deck-a,deck-b
  --missing-only
  --games 8
  --generations 2
  --population 4
  --opponent-count 20
  --parallel-opponent-count-per-run 6
  --final-games 8
  --parallel-final-games 0
  --exploration-mode counterfactual-probe|action
  --counterfactual-exploration-rate 0.35
  --counterfactual-max-per-game 1
  --counterfactual-rollout-actions 64
  --counterfactual-rollout-player-turns 3
  --dry-run`);
}
