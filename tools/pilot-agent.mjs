#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  DEFAULT_PILOT_POLICY,
  analyzeSetupHand,
  applyAction,
  catalogGameResult,
  createSimulationGame,
  describePilotPolicy,
  loadCatalogJson,
  loadDeckJson,
  makeRng,
  normalizePilotPolicy,
  runAutoplayGame
} from "../src/index.js";

const DEFAULT_CATALOG = "work/private/egman-unionarena-catalog.json";
const DEFAULT_LIBRARY = "work/private/decks";
const DEFAULT_OUT_DIR = "work/private/pilot-agent";

const command = process.argv[2];

try {
  switch (command) {
    case "evaluate":
      await evaluateCommand();
      break;
    case "train":
      await trainCommand();
      break;
    case "help":
    case "--help":
    case undefined:
      usage();
      process.exit(command ? 0 : 1);
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(error.message);
  if (error.details) console.error(JSON.stringify(error.details, null, 2));
  process.exit(1);
}

async function evaluateCommand() {
  const config = readConfig({
    outDir: option("--out-dir") ?? join(DEFAULT_OUT_DIR, `${timestamp()}-evaluate`)
  });
  const deckId = await deckOptionOrPrompt(config.libraryDir);
  const deck = loadSavedDeck(config.libraryDir, deckId);
  const opponents = loadOpponents(config.libraryDir, opponentsText(deckId));
  const policy = loadPolicyOption("--policy") ?? normalizePilotPolicy();
  const opponentPolicy = loadPolicyOption("--opponent-policy") ?? normalizePilotPolicy();
  const progress = createProgressReporter(config.progressIntervalMs);
  const evaluation = evaluatePolicy({
    catalog: config.catalog,
    deck: deck.cards,
    opponents,
    games: config.games,
    seed: config.seed,
    validateDecks: config.validateDecks,
    autoMulliganBricks: config.autoMulliganBricks,
    maxTurns: config.maxTurns,
    maxActions: config.maxActions,
    policy,
    opponentPolicy,
    candidateId: policy.name ?? "policy",
    progress,
    progressContext: {
      phase: "evaluate",
      generation: null,
      candidateIndex: 0,
      populationSize: 1,
      generationGameOffset: 0,
      generationTotalGames: config.games * opponents.length
    }
  });

  const report = buildReport({
    mode: "evaluate",
    config,
    deck,
    opponents,
    bestPolicy: policy,
    rankings: [{
      generation: 0,
      candidateId: policy.name ?? "policy",
      ...evaluation.summary
    }],
    games: evaluation.rows,
    baselineSummary: null
  });

  writePilotReport(config.outDir, report);
  console.log(`Evaluated pilot policy into ${config.outDir}`);
  printSummary(evaluation.summary);
}

async function trainCommand() {
  const config = readConfig({
    outDir: option("--out-dir") ?? join(DEFAULT_OUT_DIR, `${timestamp()}-train`)
  });
  const deckId = await deckOptionOrPrompt(config.libraryDir);
  const deck = loadSavedDeck(config.libraryDir, deckId);
  const opponents = loadOpponents(config.libraryDir, opponentsText(deckId));
  const generations = Number(option("--generations") ?? 4);
  const populationSize = Number(option("--population") ?? 8);
  const eliteCount = Math.max(1, Number(option("--elite") ?? 2));
  const mutationScale = Number(option("--mutation-scale") ?? 80);
  const mutationRate = Number(option("--mutation-rate") ?? 0.35);
  const finalGames = Number(option("--final-games") ?? config.games);
  const rng = makeRng(config.seed);
  const startingPolicy = loadPolicyOption("--policy") ?? normalizePilotPolicy();
  const opponentPolicy = loadPolicyOption("--opponent-policy") ?? normalizePilotPolicy();
  const progress = createProgressReporter(config.progressIntervalMs);

  let population = seedPolicyPopulation(startingPolicy, rng, {
    populationSize,
    mutationScale,
    mutationRate
  });
  const rankings = [];
  const trainingRows = [];
  let best = null;

  for (let generation = 0; generation <= generations; generation += 1) {
    const generationTotalGames = population.length * config.games * opponents.length;
    progress.startGeneration(generation, generationTotalGames, population.length);
    const evaluated = population.map((policy, index) => {
      const candidateId = `g${generation}-p${index}`;
      const evaluation = evaluatePolicy({
        catalog: config.catalog,
        deck: deck.cards,
        opponents,
        games: config.games,
        seed: config.seed + generation * 1000000 + index * 10000,
        validateDecks: config.validateDecks,
        autoMulliganBricks: config.autoMulliganBricks,
        maxTurns: config.maxTurns,
        maxActions: config.maxActions,
        policy: { ...policy, name: candidateId },
        opponentPolicy,
        candidateId,
        progress,
        progressContext: {
          phase: "train",
          generation,
          candidateIndex: index,
          populationSize: population.length,
          generationGameOffset: index * config.games * opponents.length,
          generationTotalGames
        }
      });
      const row = {
        generation,
        candidateId,
        policySignature: policySignature(policy),
        ...evaluation.summary,
        policy
      };
      rankings.push(withoutPolicy(row));
      trainingRows.push(...evaluation.rows.map((gameRow) => ({
        ...gameRow,
        generation,
        candidateId
      })));
      if (!best || row.score > best.score) best = row;
      return row;
    }).sort((a, b) => b.score - a.score);

    console.log(`Generation ${generation}: best score ${evaluated[0].score.toFixed(2)} (${formatPercent(evaluated[0].winRate)} win rate)`);
    if (generation === generations) break;

    const elites = evaluated.slice(0, eliteCount);
    population = elites.map((candidate) => candidate.policy);
    const seen = new Set(population.map(policySignature));

    while (population.length < populationSize) {
      const parent = elites[Math.floor(rng() * elites.length)].policy;
      const scale = mutationScale * Math.max(0.35, 1 - generation / Math.max(1, generations));
      const child = mutatePolicy(parent, rng, { mutationScale: scale, mutationRate });
      const signature = policySignature(child);
      if (seen.has(signature)) continue;
      seen.add(signature);
      population.push(child);
    }
  }

  const baseline = evaluatePolicy({
    catalog: config.catalog,
    deck: deck.cards,
    opponents,
    games: finalGames,
    seed: config.seed + 700000000,
    validateDecks: config.validateDecks,
    autoMulliganBricks: config.autoMulliganBricks,
    maxTurns: config.maxTurns,
    maxActions: config.maxActions,
    policy: startingPolicy,
    opponentPolicy,
    candidateId: "baseline",
    progress,
    progressContext: {
      phase: "final-baseline",
      generation: "final",
      candidateIndex: 0,
      populationSize: 2,
      generationGameOffset: 0,
      generationTotalGames: finalGames * opponents.length * 2
    }
  });
  const finalEvaluation = evaluatePolicy({
    catalog: config.catalog,
    deck: deck.cards,
    opponents,
    games: finalGames,
    seed: config.seed + 800000000,
    validateDecks: config.validateDecks,
    autoMulliganBricks: config.autoMulliganBricks,
    maxTurns: config.maxTurns,
    maxActions: config.maxActions,
    policy: { ...best.policy, name: "best-policy" },
    opponentPolicy,
    candidateId: "best-policy",
    progress,
    progressContext: {
      phase: "final-best",
      generation: "final",
      candidateIndex: 1,
      populationSize: 2,
      generationGameOffset: finalGames * opponents.length,
      generationTotalGames: finalGames * opponents.length * 2
    }
  });

  const finalRankings = [
    ...rankings,
    {
      generation: "final",
      candidateId: "baseline",
      policySignature: policySignature(startingPolicy),
      ...baseline.summary
    },
    {
      generation: "final",
      candidateId: "best-policy",
      policySignature: policySignature(best.policy),
      ...finalEvaluation.summary
    }
  ];

  const report = buildReport({
    mode: "train",
    config: {
      ...config,
      generations,
      populationSize,
      eliteCount,
      mutationScale,
      mutationRate,
      finalGames
    },
    deck,
    opponents,
    bestPolicy: { ...best.policy, name: "best-policy" },
    rankings: finalRankings,
    games: finalEvaluation.rows,
    trainingGames: trainingRows,
    baselineSummary: baseline.summary
  });

  writePilotReport(config.outDir, report);
  console.log(`Trained pilot policy into ${config.outDir}`);
  printSummary(finalEvaluation.summary);
  console.log(`Baseline final win rate: ${formatPercent(baseline.summary.winRate)}`);
}

function readConfig({ outDir }) {
  const catalogPath = option("--catalog") ?? DEFAULT_CATALOG;
  const libraryDir = option("--library") ?? DEFAULT_LIBRARY;
  return {
    catalogPath,
    libraryDir,
    outDir,
    catalog: loadCatalogJson(catalogPath),
    games: Number(option("--games") ?? 12),
    seed: Number(option("--seed") ?? 20260706),
    validateDecks: !hasFlag("--no-validate"),
    autoMulliganBricks: hasFlag("--auto-mulligan-bricks"),
    maxTurns: Number(option("--max-turns") ?? 80),
    maxActions: Number(option("--max-actions") ?? 1000),
    progressIntervalMs: progressIntervalMs()
  };
}

function evaluatePolicy({
  catalog,
  deck,
  opponents,
  games,
  seed,
  validateDecks,
  autoMulliganBricks,
  maxTurns,
  maxActions,
  policy,
  opponentPolicy,
  candidateId,
  progress,
  progressContext = {}
}) {
  const rows = [];
  let index = 0;
  let wins = 0;
  let losses = 0;
  let incomplete = 0;
  const normalizedPolicy = normalizePilotPolicy(policy);
  const normalizedOpponentPolicy = normalizePilotPolicy(opponentPolicy);
  const totalEvaluationGames = games * opponents.length;

  for (const opponent of opponents) {
    for (let game = 0; game < games; game += 1) {
      const firstPlayer = game % 2 === 0 ? "P1" : "P2";
      const gameSeed = seed + index;
      const simulation = createSimulationGame({
        catalog,
        decks: { P1: deck, P2: opponent.cards },
        seed: gameSeed,
        firstPlayer,
        validateDecks,
        setupMode: autoMulliganBricks ? "manual" : "auto"
      });
      const setupState = autoMulliganBricks ? resolveBrickMulligans(simulation.state) : simulation.state;
      const playout = runAutoplayGame(setupState, {
        maxTurns,
        maxActions,
        policy: {
          P1: normalizedPolicy,
          P2: normalizedOpponentPolicy
        }
      });
      const result = catalogGameResult(playout.state, {
        index: index + 1,
        seed: gameSeed
      });
      if (result.winner === "P1") wins += 1;
      else if (result.winner === "P2") losses += 1;
      else incomplete += 1;
      rows.push({
        ...result,
        opponent: opponent.id,
        candidatePlayer: "P1",
        policyId: candidateId,
        playoutSteps: playout.steps,
        playoutStoppedReason: playout.stoppedReason
      });
      index += 1;
      progress?.maybe({
        ...progressContext,
        candidateId,
        opponent: opponent.id,
        gameInCandidate: index,
        totalCandidateGames: totalEvaluationGames,
        generationGame: Number(progressContext.generationGameOffset ?? 0) + index,
        generationTotalGames: progressContext.generationTotalGames ?? totalEvaluationGames,
        wins,
        losses,
        incomplete
      });
    }
  }

  return {
    rows,
    summary: summarizeRows(rows)
  };
}

function resolveBrickMulligans(state) {
  let nextState = state;
  for (const playerId of ["P1", "P2"]) {
    const actionType = analyzeSetupHand(nextState, playerId).initialBricked ? "mulligan" : "keepHand";
    nextState = applyAction(nextState, { type: actionType, player: playerId });
  }
  return nextState;
}

function progressIntervalMs() {
  if (hasFlag("--no-progress")) return 0;
  const explicitMs = option("--progress-interval-ms");
  if (explicitMs !== undefined) return Math.max(0, Number(explicitMs));
  const seconds = option("--progress-seconds");
  if (seconds !== undefined) return Math.max(0, Number(seconds) * 1000);
  const minutes = option("--progress-minutes");
  if (minutes !== undefined) return Math.max(0, Number(minutes) * 60_000);
  return 120_000;
}

function createProgressReporter(intervalMs) {
  const enabled = Number.isFinite(intervalMs) && intervalMs > 0;
  const startedAt = Date.now();
  let nextAt = startedAt + intervalMs;

  return {
    startGeneration(generation, totalGames, populationSize) {
      if (!enabled) return;
      nextAt = Date.now() + intervalMs;
      console.log(`[${clockTime()}] Generation ${generation}: started 0/${totalGames} games (${populationSize} policies)`);
    },
    maybe(event) {
      if (!enabled) return;
      const now = Date.now();
      const generationGame = Number(event.generationGame ?? event.gameInCandidate ?? 0);
      const generationTotalGames = Number(event.generationTotalGames ?? event.totalCandidateGames ?? 0);
      if (now < nextAt && generationGame !== generationTotalGames) return;
      nextAt = now + intervalMs;
      const candidate = event.candidateId
        ? ` | Candidate ${event.candidateId} (${Number(event.candidateIndex ?? 0) + 1}/${event.populationSize ?? 1})`
        : "";
      const candidateGame = event.totalCandidateGames
        ? ` | Candidate game ${event.gameInCandidate}/${event.totalCandidateGames}`
        : "";
      const opponent = event.opponent ? ` | Opponent ${event.opponent}` : "";
      const record = ` | W/L/I ${event.wins}/${event.losses}/${event.incomplete}`;
      console.log(`[${clockTime(now)}] ${progressLabel(event)}: Game ${generationGame}/${generationTotalGames}${candidate}${candidateGame}${opponent}${record} | elapsed ${durationText(now - startedAt)}`);
    }
  };
}

function progressLabel(event) {
  if (event.phase === "evaluate") return "Evaluate";
  if (event.phase === "final-baseline") return "Final baseline";
  if (event.phase === "final-best") return "Final best policy";
  return `Generation ${event.generation}`;
}

function clockTime(date = Date.now()) {
  return new Date(date).toLocaleTimeString();
}

function durationText(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function summarizeRows(rows) {
  const total = rows.length;
  const wins = rows.filter((row) => row.winner === "P1").length;
  const losses = rows.filter((row) => row.winner === "P2").length;
  const incomplete = total - wins - losses;
  const winRate = total === 0 ? 0 : wins / total;
  const nonLossRate = total === 0 ? 0 : (wins + incomplete * 0.5) / total;
  const incompleteRate = total === 0 ? 0 : incomplete / total;
  const avgLifeDiff = average(rows, (row) => row.p1LifeRemaining - row.p2LifeRemaining);
  const avgTurns = average(rows, (row) => row.turnsTaken);
  const brickRate = average(rows, (row) => row.p1Bricked ? 1 : 0);
  const mulliganRate = average(rows, (row) => row.p1Mulliganed ? 1 : 0);
  const score = nonLossRate * 1000 + avgLifeDiff * 12 - incompleteRate * 150 - avgTurns * 0.5;

  return {
    total,
    wins,
    losses,
    incomplete,
    winRate,
    nonLossRate,
    incompleteRate,
    avgLifeDiff,
    avgTurns,
    brickRate,
    mulliganRate,
    score
  };
}

function seedPolicyPopulation(startingPolicy, rng, { populationSize, mutationScale, mutationRate }) {
  const population = [normalizePilotPolicy(startingPolicy)];
  const seen = new Set(population.map(policySignature));
  while (population.length < populationSize) {
    const child = mutatePolicy(startingPolicy, rng, { mutationScale, mutationRate });
    const signature = policySignature(child);
    if (seen.has(signature)) continue;
    seen.add(signature);
    population.push(child);
  }
  return population;
}

function mutatePolicy(policy, rng, { mutationScale, mutationRate }) {
  const normalized = normalizePilotPolicy(policy);
  const weights = {};
  for (const [feature, value] of Object.entries(normalized.weights)) {
    const shouldMutate = rng() < mutationRate || feature === "baseScore" && rng() < 0.1;
    const delta = shouldMutate ? normalish(rng) * mutationScale : 0;
    weights[feature] = clamp(Math.round(Number(value) + delta), -1600, 1600);
  }
  return {
    schema: DEFAULT_PILOT_POLICY.schema,
    name: "mutated-policy",
    weights
  };
}

function normalish(rng) {
  let total = 0;
  for (let i = 0; i < 6; i += 1) total += rng();
  return total - 3;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function policySignature(policy) {
  const normalized = normalizePilotPolicy(policy);
  return Object.entries(normalized.weights)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([feature, weight]) => `${feature}:${Number(weight).toFixed(0)}`)
    .join("|");
}

function buildReport({ mode, config, deck, opponents, bestPolicy, rankings, games, trainingGames = [], baselineSummary }) {
  const printableConfig = {
    ...config,
    catalog: undefined
  };
  delete printableConfig.catalog;
  const summary = summarizeRows(games);
  return {
    schema: "union-arena-local-engine/pilot-agent-report@1",
    mode,
    createdAt: new Date().toISOString(),
    config: printableConfig,
    deck: {
      id: deck.id,
      name: deck.name,
      path: deck.path
    },
    opponents: opponents.map((opponent) => ({
      id: opponent.id,
      name: opponent.name,
      path: opponent.path
    })),
    bestPolicy: normalizePilotPolicy(bestPolicy),
    baselineSummary,
    result: summary,
    analysis: buildPilotAnalysis({
      mode,
      summary,
      baselineSummary,
      rankings,
      games,
      bestPolicy
    }),
    rankings,
    games,
    trainingGames
  };
}

function buildPilotAnalysis({ mode, summary, baselineSummary, rankings, games, bestPolicy }) {
  const matchups = matchupBreakdown(games);
  const stopReasons = countBy(games, (row) => row.playoutStoppedReason ?? "unknown");
  const policyDeltas = describePilotPolicy(bestPolicy).filter((item) => item.deltaFromBaseline !== 0);
  const positives = [];
  const negatives = [];
  const recommendations = [];

  if (summary.winRate >= 0.55) positives.push(`Pilot won ${formatPercent(summary.winRate)} of final evaluation games.`);
  if (summary.avgLifeDiff > 0) positives.push(`Average life differential was positive at ${summary.avgLifeDiff.toFixed(2)}.`);
  if (summary.incompleteRate <= 0.03) positives.push(`Most games completed cleanly (${summary.incomplete} incomplete of ${summary.total}).`);
  if (baselineSummary) {
    const winRateGain = summary.winRate - baselineSummary.winRate;
    const lifeGain = summary.avgLifeDiff - baselineSummary.avgLifeDiff;
    if (winRateGain > 0) positives.push(`Training improved win rate over the starting policy by ${formatPercent(winRateGain)}.`);
    if (lifeGain > 0) positives.push(`Training improved average life differential by ${lifeGain.toFixed(2)}.`);
    if (winRateGain <= 0 && lifeGain <= 0) negatives.push("The learned policy did not beat the starting policy in the final check.");
  }
  if (policyDeltas.length > 0) {
    const topPositive = policyDeltas.filter((item) => item.deltaFromBaseline > 0).slice(0, 5);
    const topNegative = policyDeltas.filter((item) => item.deltaFromBaseline < 0).slice(0, 5);
    if (topPositive.length > 0) positives.push(`Learned to value more: ${topPositive.map((item) => `${item.feature} (${signed(item.deltaFromBaseline)})`).join(", ")}.`);
    if (topNegative.length > 0) positives.push(`Learned to value less: ${topNegative.map((item) => `${item.feature} (${signed(item.deltaFromBaseline)})`).join(", ")}.`);
  }

  if (summary.winRate < 0.5) negatives.push(`Final win rate is still below break-even at ${formatPercent(summary.winRate)}.`);
  if (summary.avgLifeDiff < 0) negatives.push(`Average life differential is negative at ${summary.avgLifeDiff.toFixed(2)}.`);
  if (summary.incomplete > 0) negatives.push(`${summary.incomplete} final game(s) stopped before a winner; inspect stop reasons and game rows.`);
  const weak = matchups.filter((matchup) => matchup.winRate < 0.45).sort((a, b) => a.winRate - b.winRate || a.avgLifeDiff - b.avgLifeDiff);
  if (weak.length > 0) negatives.push(`Weakest matchup in final evaluation was ${weak[0].opponent} at ${formatPercent(weak[0].winRate)}.`);

  if (summary.total < 50) recommendations.push("Use more `--games` for the next serious run; this result is directional.");
  if (weak.length > 0) recommendations.push(`Run a focused training session against ${weak[0].opponent}.`);
  recommendations.push("Run several sessions in parallel with different `--seed` values and compare their `best-policy.json` files.");
  recommendations.push("Feed the strongest policy back into `tools/deck-agent.mjs` after pilot quality improves, so deck changes are judged by better play.");

  return {
    mode,
    generatedAt: new Date().toISOString(),
    summary,
    baselineSummary,
    stopReasons,
    matchups,
    topRankings: [...rankings]
      .sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0))
      .slice(0, 10),
    learnedWeightDeltas: policyDeltas,
    positives: positives.length > 0 ? positives : ["No strong positive signal yet; this run is mainly a baseline for later pilot training."],
    negatives: negatives.length > 0 ? negatives : ["No major warning appeared in this run, though more games can still change the result."],
    recommendations
  };
}

function writePilotReport(outDir, report) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(outDir, "best-policy.json"), `${JSON.stringify(report.bestPolicy, null, 2)}\n`);
  writeFileSync(join(outDir, "analysis.md"), analysisMarkdown(report.analysis));
  writeFileSync(join(outDir, "rankings.csv"), csvFromRows(report.rankings.map(flattenRow)));
  writeFileSync(join(outDir, "games.csv"), csvFromRows(report.games.map(flattenRow)));
  if (report.trainingGames?.length > 0) {
    writeFileSync(join(outDir, "training-games.csv"), csvFromRows(report.trainingGames.map(flattenRow)));
  }
}

function analysisMarkdown(analysis) {
  const lines = [
    "# Pilot Agent Analysis",
    "",
    `Mode: ${analysis.mode}`,
    `Generated: ${analysis.generatedAt}`,
    "",
    "## Final Evaluation",
    "",
    `- Games: ${analysis.summary.total}`,
    `- Wins / losses / incomplete: ${analysis.summary.wins} / ${analysis.summary.losses} / ${analysis.summary.incomplete}`,
    `- Win rate: ${formatPercent(analysis.summary.winRate)}`,
    `- Average life differential: ${analysis.summary.avgLifeDiff.toFixed(2)}`,
    `- Average turns: ${analysis.summary.avgTurns.toFixed(2)}`,
    `- Stop reasons: ${JSON.stringify(analysis.stopReasons)}`,
    "",
    "## Positives",
    "",
    ...analysis.positives.map((item) => `- ${item}`),
    "",
    "## Negatives",
    "",
    ...analysis.negatives.map((item) => `- ${item}`),
    "",
    "## Recommendations",
    "",
    ...analysis.recommendations.map((item) => `- ${item}`),
    "",
    "## Matchups",
    "",
    ...analysis.matchups.map((matchup) => `- ${matchup.opponent}: ${matchup.wins}/${matchup.losses}/${matchup.incomplete}, ${formatPercent(matchup.winRate)} win rate, ${matchup.avgLifeDiff.toFixed(2)} average life diff`),
    "",
    "## Learned Weight Deltas",
    "",
    ...analysis.learnedWeightDeltas.slice(0, 20).map((item) => `- ${item.feature}: ${signed(item.deltaFromBaseline)} (weight ${item.weight})`)
  ];
  return `${lines.join("\n")}\n`;
}

function matchupBreakdown(rows) {
  return [...groupBy(rows, (row) => row.opponent ?? "unknown").entries()]
    .map(([opponent, matchupRows]) => {
      const summary = summarizeRows(matchupRows);
      return {
        opponent,
        total: summary.total,
        wins: summary.wins,
        losses: summary.losses,
        incomplete: summary.incomplete,
        winRate: summary.winRate,
        avgLifeDiff: summary.avgLifeDiff
      };
    })
    .sort((a, b) => a.winRate - b.winRate || a.avgLifeDiff - b.avgLifeDiff);
}

function loadPolicyOption(flag) {
  const path = option(flag);
  if (!path) return null;
  if (!existsSync(path)) throw new Error(`Policy file not found: ${path}`);
  return normalizePilotPolicy(JSON.parse(readFileSync(path, "utf8")));
}

function loadOpponents(libraryDir, text) {
  return text.split(/[,\r\n]+/)
    .map((id) => id.trim())
    .filter((id) => id && !id.startsWith("#"))
    .map((id) => loadSavedDeck(libraryDir, id));
}

async function deckOptionOrPrompt(libraryDir) {
  const explicit = option("--deck");
  if (explicit) return explicit;

  const decks = readSavedDeckIndex(libraryDir);
  if (decks.length === 0) throw new Error(`No saved decks found in ${libraryDir}.`);

  console.log("Saved decks:");
  decks.forEach((deck, index) => {
    console.log(`${String(index + 1).padStart(2, " ")}. ${deck.id} - ${deck.name}`);
  });

  const rl = createInterface({ input, output });
  try {
    while (true) {
      const answer = (await rl.question("Deck to use (number, deck ID, or search text): ")).trim();
      const selected = resolveDeckAnswer(answer, decks);
      if (selected) return selected.id;

      const matches = deckSearchMatches(answer, decks);
      if (matches.length > 1) {
        console.log(`Matched ${matches.length} decks. Narrow it down or choose one of these numbers:`);
        matches.slice(0, 20).forEach((deck) => {
          const index = decks.findIndex((candidate) => candidate.id === deck.id);
          console.log(`${String(index + 1).padStart(2, " ")}. ${deck.id} - ${deck.name}`);
        });
        if (matches.length > 20) console.log(`...and ${matches.length - 20} more.`);
      } else {
        console.log("I couldn't match that deck. Try a number from the list or paste the deck ID.");
      }
    }
  } finally {
    rl.close();
  }
}

function readSavedDeckIndex(libraryDir) {
  if (!existsSync(libraryDir)) return [];
  return readdirSync(libraryDir)
    .filter((file) => file.toLowerCase().endsWith(".json"))
    .map((file) => {
      try {
        const raw = JSON.parse(readFileSync(join(libraryDir, file), "utf8"));
        if (!raw.id || !Array.isArray(raw.cards)) return null;
        return {
          id: raw.id,
          name: raw.name ?? raw.id,
          path: join(libraryDir, file)
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function resolveDeckAnswer(answer, decks) {
  if (!answer) return null;
  const numeric = Number(answer);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= decks.length) {
    return decks[numeric - 1];
  }

  const normalized = normalizeSearch(answer);
  const exact = decks.find((deck) => {
    return normalizeSearch(deck.id) === normalized || normalizeSearch(deck.name) === normalized;
  });
  if (exact) return exact;

  const matches = deckSearchMatches(answer, decks);
  return matches.length === 1 ? matches[0] : null;
}

function deckSearchMatches(answer, decks) {
  const terms = normalizeSearch(answer).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  return decks.filter((deck) => {
    const text = normalizeSearch(`${deck.id} ${deck.name}`);
    return terms.every((term) => text.includes(term));
  });
}

function normalizeSearch(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function opponentsText(fallback) {
  const file = option("--opponents-file");
  if (file) return readFileSync(file, "utf8");
  return option("--opponents") ?? fallback;
}

function loadSavedDeck(libraryDir, id) {
  const path = join(libraryDir, `${id}.json`);
  if (!existsSync(path)) throw new Error(`Saved deck not found: ${path}`);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return {
    id: raw.id ?? id,
    name: raw.name ?? id,
    path,
    cards: loadDeckJson(path)
  };
}

function countBy(items, keyFn) {
  return Object.fromEntries([...groupBy(items, keyFn).entries()].map(([key, values]) => [key, values.length]));
}

function groupBy(items, keyFn) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function average(rows, fn) {
  if (rows.length === 0) return 0;
  return rows.reduce((total, row) => total + Number(fn(row) ?? 0), 0) / rows.length;
}

function withoutPolicy(row) {
  const { policy, ...rest } = row;
  return rest;
}

function flattenRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    typeof value === "object" && value !== null ? JSON.stringify(value) : value
  ]));
}

function csvFromRows(rows) {
  const headers = Object.keys(rows[0] ?? { index: "", candidateId: "" });
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((key) => csvCell(row[key])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

function printSummary(summary) {
  console.log(`Score: ${summary.score.toFixed(2)}`);
  console.log(`Wins/losses/incomplete: ${summary.wins}/${summary.losses}/${summary.incomplete}`);
  console.log(`Win rate: ${formatPercent(summary.winRate)}`);
  console.log(`Average life diff: ${summary.avgLifeDiff.toFixed(2)}`);
  console.log(`Average turns: ${summary.avgTurns.toFixed(2)}`);
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function signed(value) {
  return `${value >= 0 ? "+" : ""}${Number(value).toFixed(0)}`;
}

function option(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function usage() {
  console.log(`Usage:
  node tools/pilot-agent.mjs evaluate [--deck deck-id] --opponents opp-a,opp-b [--policy path] [--games 50]
  node tools/pilot-agent.mjs train [--deck deck-id] --opponents opp-a,opp-b [--generations 4] [--population 8] [--games 12]
  node tools/pilot-agent.mjs train --deck deck-id --opponents-file work/private/deck-gauntlets/regional-q1-2026.txt --seed 1001 --out-dir work/private/pilot-agent/session-1001

Leave out --deck to choose from a numbered list of saved decks before the run starts.

Useful options:
  --auto-mulligan-bricks
  --policy path/to/starting-policy.json
  --opponent-policy path/to/opponent-policy.json
  --progress-minutes 2
  --progress-seconds 30
  --no-progress
  --final-games 50
  --mutation-scale 80
  --mutation-rate 0.35
  --max-turns 80
  --max-actions 1000

Outputs:
  report.json
  best-policy.json
  analysis.md
  rankings.csv
  games.csv
  training-games.csv`);
}
