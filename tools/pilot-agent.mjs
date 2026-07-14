#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { pilotAgentPresetDefaults as sharedPilotAgentPresetDefaults } from "../src/pilot-training-presets.js";
import {
  DEFAULT_ACTION_EXPLORATION,
  DEFAULT_COUNTERFACTUAL_EXPLORATION,
  DEFAULT_PILOT_POLICY,
  LEARNING_GAME_TELEMETRY_SCHEMA,
  allocateDecisionCredits,
  analyzeSetupHand,
  applyAction,
  blendPilotPolicyWithMlModel,
  catalogGameResult,
  comparePairedMatchupEvaluations,
  createSimulationGame,
  describePilotPolicy,
  pairwiseActionFamily,
  loadCatalogJson,
  loadDeckJson,
  makeRng,
  mlActionModelRuntimeTrust,
  mutatePilotPolicyWeights,
  PILOT_PERFORMANCE_SCORE_VERSION,
  pilotPerformanceScore,
  promotionEvidenceGate,
  promotionQualityGate,
  DEFAULT_POLICY_DIR,
  actionModelCandidatePathsForKey,
  baselineOriginPathForProfile,
  ensurePolicyForProfile,
  loadMatchupOverlaysForProfile,
  normalizeDeckList,
  normalizePilotPolicy,
  policyPathForProfile,
  resolveArchetypeProfile,
  resolvePolicyForDeck,
  resolvePilotSetup,
  removeMlModelFromPilotPolicy,
  runAutoplayGame,
  selectDecisionLogCandidates,
  writeJsonAtomicSync,
  writeBaselineOriginForProfile,
  writePolicyForProfile
} from "../src/index.js";

const DEFAULT_CATALOG = "work/private/egman-unionarena-catalog.json";
const DEFAULT_LIBRARY = "work/private/decks";
const DEFAULT_OUT_DIR = "work/private/pilot-agent/runs";
const DEFAULT_AGENT_ROOT = "work/private/pilot-agent";
const CURRENT_POLICY_PATH = "work/private/pilot-agent/current-best-policy.json";

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
  writeFailureFileFromError(error);
  process.exit(1);
}

async function evaluateCommand() {
  const config = readConfig({
    outDir: option("--out-dir") ?? join(DEFAULT_OUT_DIR, `${timestamp()}-evaluate`)
  });
  const deckId = await deckOptionOrPrompt(config.libraryDir);
  const deck = loadSavedDeck(config.libraryDir, deckId);
  const opponentSelection = selectOpponents(config.libraryDir, deckId, config.seed);
  const opponents = opponentSelection.opponents;
  const opponentDeckFingerprints = matchupDeckFingerprintsForSavedDecks(opponents, config.catalog, config);
  const pilotDeckFingerprint = matchupDeckFingerprintForSavedDeck(deck, config.catalog, config);
  config.opponentSelection = opponentSelection.summary;
  printOpponentSelection(opponentSelection.summary);
  const policySelection = loadStartingPolicyForDeck(deck, config, { createIfMissing: false });
  config.policySelection = policySelection.summary;
  const pilotMatchupOverlays = matchupOverlayConfigForProfile(policySelection.summary.profile, config);
  config.matchupOverlaySelection = pilotMatchupOverlays.summary;
  const policy = policySelection.policy;
  const opponentPolicy = loadPolicyOption("--opponent-policy");
  const progress = createProgressReporter(config.progressIntervalMs);
  config.evaluationExplorationEnabled = hasFlag("--explore-evaluation");
  if (!config.evaluationExplorationEnabled && explicitExplorationOptionSupplied()) {
    console.log("Evaluation remains deterministic; exploration flags apply to training. Pass --explore-evaluation for a diagnostic exploratory evaluation.");
  }
  const evaluation = evaluatePolicy({
    catalog: config.catalog,
    deck: deck.cards,
    opponents,
    games: config.games,
    seed: config.seed,
    validateDecks: config.validateDecks,
    autoMulliganBricks: config.autoMulliganBricks,
    mulliganMode: config.mulliganMode,
    maxTurns: config.maxTurns,
    maxActions: config.maxActions,
    policy,
    opponentPolicy,
    opponentMlModel: config.opponentMlModel,
    opponentMlStrength: config.opponentMlStrength,
    pilotMatchupConfig: pilotMatchupOverlays.config,
    matchupOptions: config.evaluationExplorationEnabled ? config : finalEvaluationOptions(config),
    opponentDeckFingerprints,
    pilotDeckFingerprint,
    candidateId: policy.name ?? "policy",
    progress,
    progressContext: {
      phase: "evaluate",
      generation: null,
      candidateIndex: 0,
      populationSize: 1,
      generationGameOffset: 0,
      generationTotalGames: config.games * opponents.length
    },
    ...decisionLoggingOptions(config, "final")
  });

  const report = buildReport({
    mode: "evaluate",
    config,
    deck,
    opponents,
    bestPolicy: { ...policySelection.basePolicy, name: policy.name },
    rankings: [{
      generation: 0,
      candidateId: policy.name ?? "policy",
      ...evaluation.summary
    }],
    games: evaluation.rows,
    decisionLog: evaluation.decisionRows,
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
  const deckId = defaultDeckIdForParallelMissingBaselines(config) ?? await deckOptionOrPrompt(config.libraryDir);
  const deck = loadSavedDeck(config.libraryDir, deckId);
  const opponentSelection = selectOpponents(config.libraryDir, deckId, config.seed);
  const opponents = opponentSelection.opponents;
  const opponentDeckFingerprints = matchupDeckFingerprintsForSavedDecks(opponents, config.catalog, config);
  const pilotDeckFingerprint = matchupDeckFingerprintForSavedDeck(deck, config.catalog, config);
  config.opponentSelection = opponentSelection.summary;
  printOpponentSelection(opponentSelection.summary);
  const parallelRuns = config.parallelRuns;
  if (parallelRuns > 1) {
    await parallelTrainCommand({
      config,
      deck,
      deckId,
      opponentSelection,
      opponents,
      parallelRuns
    });
    return;
  }
  const generations = config.generations;
  const populationSize = config.populationSize;
  const eliteCount = config.eliteCount;
  const mutationScale = config.mutationScale;
  const mutationRate = config.mutationRate;
  const mutationGroupsPerChild = config.mutationGroupsPerChild;
  const mutationMaxFeatures = config.mutationMaxFeatures;
  const finalGames = config.finalGames;
  const rng = makeRng(config.seed);
  const policySelection = loadStartingPolicyForDeck(deck, config, { createIfMissing: false });
  config.policySelection = policySelection.summary;
  const pilotMatchupOverlays = matchupOverlayConfigForProfile(policySelection.summary.profile, config);
  config.matchupOverlaySelection = pilotMatchupOverlays.summary;
  const startingPolicy = policySelection.policy;
  const opponentPolicy = loadPolicyOption("--opponent-policy");
  const progress = createProgressReporter(config.progressIntervalMs);

  let population = seedPolicyPopulation(startingPolicy, rng, {
    populationSize,
    mutationScale,
    mutationRate,
    mutationGroupsPerChild,
    mutationMaxFeatures
  });
  const rankings = [];
  const trainingRows = [];
  const decisionLogRows = [];
  let best = null;
  let allTimeBest = null;

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
        seed: config.seed + generation * 1000000,
        validateDecks: config.validateDecks,
        autoMulliganBricks: config.autoMulliganBricks,
        mulliganMode: config.mulliganMode,
        maxTurns: config.maxTurns,
        maxActions: config.maxActions,
        policy: { ...policy, name: candidateId },
        opponentPolicy,
        opponentMlModel: config.opponentMlModel,
        opponentMlStrength: config.opponentMlStrength,
        pilotMatchupConfig: pilotMatchupOverlays.config,
        matchupOptions: config,
        opponentDeckFingerprints,
        pilotDeckFingerprint,
        candidateId,
        progress,
        progressContext: {
          phase: "train",
          generation,
          candidateIndex: index,
          populationSize: population.length,
          generationGameOffset: index * config.games * opponents.length,
          generationTotalGames
        },
        ...decisionLoggingOptions(config, "training")
      });
      const row = {
        generation,
        candidateId,
        policySignature: policySignature(policy),
        ...evaluation.summary,
        policy
      };
      rankings.push(withoutPolicy(row));
      if (config.recordTrainingGames) {
        trainingRows.push(...evaluation.rows.map((gameRow) => ({
          ...gameRow,
          generation,
          candidateId
        })));
      }
      decisionLogRows.push(...evaluation.decisionRows.map((row) => ({
        ...row,
        scope: "training",
        generation,
        candidateId
      })));
      if (!allTimeBest || row.score > allTimeBest.score) allTimeBest = row;
      return row;
    }).sort((a, b) => b.score - a.score);

    const generationBest = evaluated[0];
    best = generationBest;
    console.log(
      `Generation ${generation}: best ${generationBest.candidateId} score ${generationBest.score.toFixed(2)} `
      + `(${generationBest.wins}/${generationBest.losses}/${generationBest.incomplete} W/L/I, `
      + `${formatPercent(generationBest.winRate)} win rate, ${generationBest.avgTurnCycles.toFixed(2)} avg turn cycles)`
    );
    if (generation === generations) break;

    const elites = evaluated.slice(0, eliteCount);
    population = elites.map((candidate) => candidate.policy);
    const seen = new Set(population.map(policySignature));

    while (population.length < populationSize) {
      const parent = elites[Math.floor(rng() * elites.length)].policy;
      const scale = mutationScale * Math.max(0.35, 1 - generation / Math.max(1, generations));
      const child = mutatePolicy(parent, rng, {
        mutationScale: scale,
        mutationRate,
        mutationGroupsPerChild,
        mutationMaxFeatures
      });
      const signature = policySignature(child);
      if (seen.has(signature)) continue;
      seen.add(signature);
      population.push(child);
    }
  }

  if (allTimeBest && (allTimeBest.generation !== best.generation || allTimeBest.candidateId !== best.candidateId)) {
    console.log(
      `Final candidate uses the generation ${best.generation} champion ${best.candidateId}; `
      + `the all-time training high ${allTimeBest.candidateId} from generation ${allTimeBest.generation} remains diagnostic only.`
    );
  }

  const baseline = evaluatePolicy({
    catalog: config.catalog,
    deck: deck.cards,
    opponents,
    games: finalGames,
    seed: config.seed + 700000000,
    validateDecks: config.validateDecks,
    autoMulliganBricks: config.autoMulliganBricks,
    mulliganMode: config.mulliganMode,
    maxTurns: config.maxTurns,
    maxActions: config.maxActions,
    policy: startingPolicy,
    opponentPolicy,
    opponentMlModel: config.opponentMlModel,
    opponentMlStrength: config.opponentMlStrength,
    pilotMatchupConfig: pilotMatchupOverlays.config,
    matchupOptions: finalEvaluationOptions(config),
    opponentDeckFingerprints,
    pilotDeckFingerprint,
    candidateId: "baseline",
    progress,
    progressContext: {
      phase: "final-baseline",
      generation: "final",
      candidateIndex: 0,
      populationSize: 2,
      generationGameOffset: 0,
      generationTotalGames: finalGames * opponents.length * 2
    },
    ...decisionLoggingOptions(config, "final")
  });
  const finalEvaluation = evaluatePolicy({
    catalog: config.catalog,
    deck: deck.cards,
    opponents,
    games: finalGames,
    seed: config.seed + 700000000,
    validateDecks: config.validateDecks,
    autoMulliganBricks: config.autoMulliganBricks,
    mulliganMode: config.mulliganMode,
    maxTurns: config.maxTurns,
    maxActions: config.maxActions,
    policy: { ...best.policy, name: "best-policy" },
    opponentPolicy,
    opponentMlModel: config.opponentMlModel,
    opponentMlStrength: config.opponentMlStrength,
    pilotMatchupConfig: pilotMatchupOverlays.config,
    matchupOptions: finalEvaluationOptions(config),
    opponentDeckFingerprints,
    pilotDeckFingerprint,
    candidateId: "best-policy",
    progress,
    progressContext: {
      phase: "final-best",
      generation: "final",
      candidateIndex: 1,
      populationSize: 2,
      generationGameOffset: finalGames * opponents.length,
      generationTotalGames: finalGames * opponents.length * 2
    },
    ...decisionLoggingOptions(config, "final")
  });

  const finalRankings = [
    ...rankings.map((row) => ({
      ...row,
      selectedForFinal: row.generation === best.generation && row.candidateId === best.candidateId
    })),
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

  const promotionComparison = comparePairedMatchupEvaluations({
    beforeRows: baseline.rows,
    afterRows: finalEvaluation.rows,
    beforeSummary: baseline.summary,
    afterSummary: finalEvaluation.summary
  });
  const report = buildReport({
    mode: "train",
    config: {
      ...config,
      generations,
      populationSize,
      eliteCount,
      mutationScale,
      mutationRate,
      mutationGroupsPerChild,
      mutationMaxFeatures,
      finalGames,
      trainingCandidateSelection: {
        method: "last-generation-champion",
        selectedGeneration: best.generation,
        selectedCandidateId: best.candidateId,
        selectedTrainingScore: best.score,
        allTimeHighGeneration: allTimeBest?.generation ?? null,
        allTimeHighCandidateId: allTimeBest?.candidateId ?? null,
        allTimeHighTrainingScore: allTimeBest?.score ?? null
      }
    },
    deck,
    opponents,
    bestPolicy: policyForStorage(best.policy, config, "best-policy"),
    rankings: finalRankings,
    games: finalEvaluation.rows,
    trainingGames: trainingRows,
    decisionLog: [
      ...decisionLogRows,
      ...baseline.decisionRows.map((row) => ({ ...row, scope: "final-baseline" })),
      ...finalEvaluation.decisionRows.map((row) => ({ ...row, scope: "final-best" }))
    ],
    baselineSummary: baseline.summary,
    promotionComparison
  });

  writePilotReport(config.outDir, report);
  writeUpdatePolicyOption(report);
  writeRoutedPolicyOption(report);
  console.log(`Trained pilot policy into ${config.outDir}`);
  printSummary(finalEvaluation.summary);
  console.log(`Baseline final win rate: ${formatPercent(baseline.summary.winRate)}`);
}

async function parallelTrainCommand({
  config,
  deck,
  deckId,
  opponentSelection,
  opponents,
  parallelRuns
}) {
  const finalGames = config.parallelFinalGames;
  const policySelection = loadStartingPolicyForDeck(deck, config, { createIfMissing: false });
  config.policySelection = policySelection.summary;
  const pilotMatchupOverlays = matchupOverlayConfigForProfile(policySelection.summary.profile, config);
  config.matchupOverlaySelection = pilotMatchupOverlays.summary;
  const startingPolicy = policySelection.policy;
  const opponentPolicy = loadPolicyOption("--opponent-policy");
  const opponentIds = opponentSelection.summary.selectedIds;
  const parallelDeckSelection = parallelDeckIdsOption(deckId, config, parallelRuns);
  const parallelDeckIds = parallelDeckSelection.ids;
  const actualParallelRuns = parallelDeckSelection.summary?.mode === "missing-baselines"
    ? Math.min(parallelRuns, parallelDeckIds.length)
    : parallelRuns;
  const concurrency = Math.max(1, Math.min(actualParallelRuns, config.parallelConcurrency));
  const parallelDecks = parallelDeckIds.map((id) => loadSavedDeck(config.libraryDir, id));
  const deckAssignments = parallelDeckAssignments(parallelDeckIds, actualParallelRuns, config.seed);
  const perRunOpponents = config.parallelOpponentsPerRun;
  const opponentDiversity = config.parallelOpponentDiversity;
  const childSeeds = childRunSeeds(actualParallelRuns, config.seed);
  const childOpponentSeeds = perRunOpponents
    ? childRunSeeds(actualParallelRuns, Number(option("--parallel-opponent-seed") ?? option("--opponent-seed") ?? config.seed + 4049))
    : [];
  const diverseOpponentSelections = perRunOpponents && opponentDiversity !== "none"
    ? selectDiverseParallelOpponentSelections({
      libraryDir: config.libraryDir,
      fallbackDeckIds: deckAssignments,
      runCount: actualParallelRuns,
      seed: Number(option("--parallel-opponent-seed") ?? option("--opponent-seed") ?? config.seed + 4049),
      countPerRun: config.parallelOpponentCountPerRun,
      diversity: opponentDiversity
    })
    : [];
  const runs = Array.from({ length: actualParallelRuns }, (_, index) => {
    const runNumber = index + 1;
    const seed = childSeeds[index];
    const childDeckId = deckAssignments[index];
    const childOpponentSelection = perRunOpponents
      ? diverseOpponentSelections[index] ?? selectOpponents(config.libraryDir, childDeckId, seed, { opponentSeedOverride: childOpponentSeeds[index] })
      : opponentSelection;
    const childOpponentIds = childOpponentSelection.summary.selectedIds;
    const childBaseArgs = parallelChildArgs({ deckId: childDeckId, opponentIds: childOpponentIds });
    const outDir = join(config.outDir, "runs", `run-${padRunNumber(runNumber)}`);
    return {
      runNumber,
      seed,
      deckId: childDeckId,
      deckName: parallelDecks.find((candidate) => candidate.id === childDeckId)?.name ?? childDeckId,
      opponentSelection: childOpponentSelection.summary,
      opponentIds: childOpponentIds,
      outDir,
      args: [
        ...childBaseArgs,
        "--seed", String(seed),
        "--out-dir", outDir
      ]
    };
  });

  mkdirSync(config.outDir, { recursive: true });
  if (actualParallelRuns < parallelRuns) {
    console.log(`Only ${actualParallelRuns} missing baseline deck(s) were available, so the run count was reduced from ${parallelRuns}.`);
  }
  console.log(`Starting ${actualParallelRuns} parallel training run(s) with concurrency ${concurrency}.`);
  if (parallelDeckIds.length > 1) {
    console.log(`Parallel deck pool: ${summarizeOpponentIds(parallelDeckIds)}`);
  }
  if (parallelDeckSelection.summary?.mode === "missing-baselines") {
    console.log(`Baseline training selector found ${parallelDeckSelection.summary.selectedCount}/${parallelDeckSelection.summary.missingCount} deck(s) needing baseline work.`);
  }
  console.log(`Final comparison opponent pool: ${summarizeOpponentIds(opponentIds)}`);
  for (const run of runs) {
    console.log(`Run ${padRunNumber(run.runNumber)} training deck: ${run.deckId}`);
  }
  if (perRunOpponents) {
    console.log(opponentDiversity === "none"
      ? "Each child run will train on its own opponent sample."
      : `Each child run will train on a ${opponentDiversity} diverse opponent sample.`);
    for (const run of runs) {
      console.log(`Run ${padRunNumber(run.runNumber)} training opponents: ${summarizeOpponentIds(run.opponentIds)}`);
    }
  } else {
    console.log(`Shared child training opponent pool: ${summarizeOpponentIds(opponentIds)}`);
  }

  if (config.dryRun) {
    writeJsonFileSync(join(config.outDir, "parallel-dry-run.json"), {
      schema: "union-arena-local-engine/pilot-agent-parallel-dry-run@1",
      createdAt: new Date().toISOString(),
      preset: config.preset,
      parallelRuns: actualParallelRuns,
      concurrency,
      parallelDeckSelection: parallelDeckSelection.summary,
      runs: runs.map((run) => ({
        runNumber: run.runNumber,
        seed: run.seed,
        deckId: run.deckId,
        deckName: run.deckName,
        opponentSelection: run.opponentSelection,
        opponentIds: run.opponentIds,
        outDir: run.outDir,
        args: run.args
      }))
    });
    console.log(`Dry run: skipped ${actualParallelRuns} parallel training run(s).`);
    return;
  }

  const childResults = await runParallelTrainingQueue(runs, concurrency, config);
  const failed = childResults.filter((result) => result.exitCode !== 0);
  writeJsonFileSync(join(config.outDir, "parallel-child-processes.json"), childResults.map((result) => ({
    runNumber: result.runNumber,
    seed: result.seed,
    deckId: result.deckId,
    deckName: result.deckName,
    opponentSelection: result.opponentSelection,
    opponentIds: result.opponentIds,
    outDir: result.outDir,
    exitCode: result.exitCode,
    signal: result.signal,
    killedReason: result.killedReason ?? null,
    stdoutLog: join(result.outDir, "stdout.log"),
    stderrLog: join(result.outDir, "stderr.log")
  })));
  if (failed.length > 0) {
    throw new Error(`${failed.length} parallel training run(s) failed. See ${join(config.outDir, "parallel-child-processes.json")}.`);
  }

  const childReports = childResults.map(readParallelChildResult);
  const childRoutedPolicyPromotions = writeParallelChildRoutedPolicyUpdates(childReports, {
    config,
    enabled: shouldUpdateParallelChildRoutedPolicies(config)
  });
  const learnedCandidates = childReports.map(({ run, report, policy }) => ({
    candidateId: `run-${padRunNumber(run.runNumber)}-best`,
    source: "child-best",
    sourceRun: run.runNumber,
    childSeed: run.seed,
    childDeckId: run.deckId,
    childDeckName: run.deckName,
    childSummary: report.result,
    childBaselineSummary: report.baselineSummary ?? null,
    childReportPath: join(run.outDir, "report.json"),
    childPolicyPath: join(run.outDir, "best-policy.json"),
    policy: {
      ...applyMlModelToPilotPolicy(policy, config.mlModel, config.mlStrength),
      name: `run-${padRunNumber(run.runNumber)}-best`
    },
    scoreHint: parallelCandidateSelectionScore({
      childSummary: report.result,
      childBaselineSummary: report.baselineSummary ?? null
    })
  }));
  const finalChildCandidates = selectParallelFinalChildCandidates(learnedCandidates, config.parallelFinalTopPercent);
  writeParallelChildCandidateManifest(config, childReports, learnedCandidates, finalChildCandidates);
  const mergedPolicy = mergePilotPolicies(finalChildCandidates);
  const finalCandidateMode = parallelFinalCandidateMode(config.parallelFinalCandidates);
  const allFinalCandidates = [
    ...finalChildCandidates,
    {
      candidateId: "parallel-merged-policy",
      source: "merged",
      policy: mergedPolicy,
      scoreHint: average(finalChildCandidates, (candidate) => candidate.scoreHint)
    },
    {
      candidateId: "starting-policy",
      source: "starting-policy",
      policy: { ...startingPolicy, name: "starting-policy" },
      scoreHint: 0
    }
  ];
  const finalCandidates = selectParallelFinalCandidates(allFinalCandidates, finalCandidateMode);
  const skipParallelFinal = config.skipParallelFinal || finalGames <= 0;

  if (skipParallelFinal) {
    const skipSelection = parallelSkipSelectionMode(config.parallelSkipSelection);
    const skipCandidates = allFinalCandidates;
    const best = selectParallelCandidateWithoutFinal(skipCandidates, skipSelection);
    const bestChildReport = childReports.find(({ run }) => run.runNumber === best.sourceRun)?.report;
    const supportingGames = bestChildReport?.games
      ?? childReports.flatMap(({ run, report }) => (report.games ?? []).map((row) => ({
        ...row,
        sourceRun: run.runNumber,
        sourceDeckId: run.deckId
      })));
    const rankings = skipCandidates.map((candidate) => ({
      generation: "parallel-child-score",
      candidateId: candidate.candidateId,
      source: candidate.source,
      sourceRun: candidate.sourceRun ?? null,
      childSeed: candidate.childSeed ?? null,
      childDeckId: candidate.childDeckId ?? null,
      policySignature: policySignature(candidate.policy),
      score: Number(candidate.scoreHint ?? 0),
      childScore: Number(candidate.childSummary?.score ?? 0),
      childBaselineScore: Number(candidate.childBaselineSummary?.score ?? 0),
      childScoreDelta: candidate.childBaselineSummary
        ? Number(candidate.childSummary?.score ?? 0) - Number(candidate.childBaselineSummary?.score ?? 0)
        : null,
      total: Number(candidate.childSummary?.total ?? 0),
      wins: Number(candidate.childSummary?.wins ?? 0),
      losses: Number(candidate.childSummary?.losses ?? 0),
      incomplete: Number(candidate.childSummary?.incomplete ?? 0),
      winRate: Number(candidate.childSummary?.winRate ?? 0),
      avgLifeDiff: Number(candidate.childSummary?.avgLifeDiff ?? 0),
      avgTurns: Number(candidate.childSummary?.avgTurns ?? 0),
      avgTurnCycles: Number(candidate.childSummary?.avgTurnCycles ?? 0)
    })).sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0));
    const report = buildReport({
      mode: "parallel-train",
      config: parallelReportConfig({
        config,
        parallelRuns: actualParallelRuns,
        concurrency,
        finalGames: 0,
        perRunOpponents,
        parallelDeckIds,
        parallelDeckSelection: parallelDeckSelection.summary,
        finalChildCandidates,
        finalCandidates: skipCandidates,
        runs,
        childRoutedPolicyPromotions,
        parallelFinalSkipped: true,
        parallelSelection: skipSelection,
        parallelFinalCandidateMode: finalCandidateMode
      }),
      deck,
      opponents,
      bestPolicy: {
        ...policyForStorage(best.policy, config, "parallel-best-policy")
      },
      rankings,
      games: supportingGames,
      baselineSummary: combineSummaries(childReports
        .map(({ report: childReport }) => childReport.baselineSummary)
        .filter(Boolean))
    });

    writeParallelRunManifest({
      config,
      opponentSelection,
      parallelDecks,
      childReports,
      selectedBest: best.candidateId,
      finalEvaluations: [],
      parallelFinalSkipped: true,
      parallelFinalCandidateMode: finalCandidateMode
    });
    writePilotReport(config.outDir, report);
    writeUpdatePolicyOption(report);
    writeRoutedPolicyOption(report);
    console.log(`Parallel final comparison skipped; selected policy by ${skipSelection}.`);
    console.log(`Selected policy: ${best.candidateId}`);
    printSummary(report.result);
    return;
  }

  const progress = createProgressReporter(config.progressIntervalMs);
  const totalFinalGames = finalCandidates.length * finalGames * opponents.length * parallelDecks.length;
  progress.startGeneration("parallel-final", totalFinalGames, finalCandidates.length);
  const finalEvaluations = [];
  let best = null;

  for (let index = 0; index < finalCandidates.length; index += 1) {
    const candidate = finalCandidates[index];
    const evaluation = evaluatePolicyAcrossDecks({
      catalog: config.catalog,
      decks: parallelDecks,
      opponents,
      games: finalGames,
      seed: config.seed + 900_000_000,
      validateDecks: config.validateDecks,
      autoMulliganBricks: config.autoMulliganBricks,
      mulliganMode: config.mulliganMode,
      maxTurns: config.maxTurns,
      maxActions: config.maxActions,
      policy: candidate.policy,
      opponentPolicy,
      opponentMlModel: config.opponentMlModel,
      opponentMlStrength: config.opponentMlStrength,
      pilotMatchupConfig: pilotMatchupOverlays.config,
      matchupOptions: finalEvaluationOptions(config),
      opponentDeckFingerprints: matchupDeckFingerprintsForSavedDecks(opponents, config.catalog, config),
      candidateId: candidate.candidateId,
      progress,
      progressContext: {
        phase: "parallel-final",
        generation: "parallel-final",
        candidateIndex: index,
        populationSize: finalCandidates.length,
        generationGameOffset: index * finalGames * opponents.length * parallelDecks.length,
        generationTotalGames: totalFinalGames
      },
      ...decisionLoggingOptions(config, "parallel-final")
    });
    const row = {
      generation: "parallel-final",
      candidateId: candidate.candidateId,
      source: candidate.source,
      sourceRun: candidate.sourceRun ?? null,
      childSeed: candidate.childSeed ?? null,
      childDeckId: candidate.childDeckId ?? null,
      policySignature: policySignature(candidate.policy),
      ...evaluation.summary
    };
    finalEvaluations.push({
      ...candidate,
      evaluation,
      row
    });
    if (!best || row.score > best.row.score) best = finalEvaluations[finalEvaluations.length - 1];
  }

  const baseline = finalEvaluations.find((candidate) => candidate.candidateId === "starting-policy");
  const rankings = finalEvaluations.map((candidate) => candidate.row)
    .sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0));
  const promotionComparison = baseline && best.candidateId !== "starting-policy"
    ? comparePairedMatchupEvaluations({
      beforeRows: baseline.evaluation.rows,
      afterRows: best.evaluation.rows,
      beforeSummary: baseline.evaluation.summary,
      afterSummary: best.evaluation.summary
    })
    : null;
  const report = buildReport({
    mode: "parallel-train",
    config: parallelReportConfig({
      config,
      parallelRuns: actualParallelRuns,
      concurrency,
      finalGames,
      perRunOpponents,
      parallelDeckIds,
      parallelDeckSelection: parallelDeckSelection.summary,
      finalChildCandidates,
      finalCandidates,
      runs,
      childRoutedPolicyPromotions,
      parallelFinalCandidateMode: finalCandidateMode
    }),
    deck,
    opponents,
    bestPolicy: {
      ...policyForStorage(best.policy, config, "parallel-best-policy")
    },
    rankings,
    games: best.evaluation.rows,
    decisionLog: finalEvaluations.flatMap((candidate) => candidate.evaluation.decisionRows.map((row) => ({
      ...row,
      scope: "parallel-final",
      candidateId: candidate.candidateId
    }))),
    baselineSummary: baseline?.evaluation.summary ?? null,
    promotionComparison
  });

  writeParallelRunManifest({
    config,
    opponentSelection,
    parallelDecks,
    childReports,
    selectedBest: best.candidateId,
    finalEvaluations,
    parallelFinalCandidateMode: finalCandidateMode
  });
  writePilotReport(config.outDir, report);
  writeUpdatePolicyOption(report);
  writeRoutedPolicyOption(report);

  console.log(`Parallel training complete. Final policy written into ${config.outDir}`);
  console.log(`Selected policy: ${best.candidateId}`);
  printSummary(best.evaluation.summary);
}

function parallelReportConfig({
  config,
  parallelRuns,
  concurrency,
  finalGames,
  perRunOpponents,
  parallelDeckIds,
  parallelDeckSelection = null,
  finalChildCandidates,
  finalCandidates,
  runs,
  childRoutedPolicyPromotions = null,
  parallelFinalSkipped = false,
  parallelSelection = undefined,
  parallelFinalCandidateMode = undefined
}) {
  return {
    ...config,
    policySelection: config.policySelection ?? null,
    parallelRuns,
    parallelConcurrency: concurrency,
    parallelFinalGames: finalGames,
    parallelFinalSkipped,
    parallelSelection,
    parallelFinalCandidateMode,
    parallelOpponentMode: perRunOpponents ? "per-run" : "shared",
    parallelDeckMode: parallelDeckIds.length > 1 ? "pool" : "single",
    parallelDeckIds,
    parallelDeckSelection,
    childRoutedPolicyPromotions,
    parallelFinalChildPercent: parallelFinalChildPercent(config.parallelFinalTopPercent),
    parallelFinalChildCount: finalChildCandidates.length,
    parallelFinalCandidateCount: finalCandidates.length,
    childRunOutDirs: runs.map((run) => run.outDir),
    childSeeds: runs.map((run) => run.seed),
    childDecks: runs.map((run) => ({ id: run.deckId, name: run.deckName })),
    childOpponentSelections: runs.map((run) => run.opponentSelection)
  };
}

function parallelSkipSelectionMode(value = option("--parallel-skip-selection") ?? option("--skip-parallel-selection") ?? "best-child") {
  const raw = normalizeSearch(value)
    .replace(/\s+/g, "-");
  const aliases = new Map([
    ["child", "best-child"],
    ["child-score", "best-child"],
    ["best", "best-child"],
    ["best-child", "best-child"],
    ["merge", "merged"],
    ["merged", "merged"]
  ]);
  const mode = aliases.get(raw) ?? raw;
  if (!new Set(["best-child", "merged"]).has(mode)) {
    throw new Error(`Unknown parallel skip selection: ${raw}. Use best-child or merged.`);
  }
  return mode;
}

function parallelFinalChildPercent(value = option("--parallel-final-top-percent") ?? option("--parallel-final-child-percent") ?? 25) {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) {
    throw new Error(`Invalid --parallel-final-top-percent: ${raw}. Use a number from 1 to 100.`);
  }
  return Math.min(100, raw);
}

function selectParallelFinalChildCandidates(candidates, percentValue) {
  if (candidates.length === 0) return [];
  const percent = parallelFinalChildPercent(percentValue);
  const count = Math.max(1, Math.ceil(candidates.length * percent / 100));
  return [...candidates]
    .sort((a, b) => parallelCandidateSelectionScore(b) - parallelCandidateSelectionScore(a)
      || Number(a.sourceRun ?? 0) - Number(b.sourceRun ?? 0)
      || a.candidateId.localeCompare(b.candidateId))
    .slice(0, count);
}

function parallelFinalCandidateMode(value = option("--parallel-final-candidates") ?? option("--parallel-final-candidate-mode") ?? "all") {
  const raw = normalizeSearch(value)
    .replace(/\s+/g, "-");
  const aliases = new Map([
    ["full", "all"],
    ["everything", "all"],
    ["merged", "merged-baseline"],
    ["merged-vs-baseline", "merged-baseline"],
    ["merged-only", "merged-baseline"],
    ["best", "best-baseline"],
    ["best-child", "best-baseline"],
    ["best-vs-baseline", "best-baseline"],
    ["top", "best-baseline"],
    ["top-baseline", "best-baseline"],
    ["top-merged", "best-merged-baseline"],
    ["best-merged", "best-merged-baseline"],
    ["top-merged-baseline", "best-merged-baseline"]
  ]);
  const mode = aliases.get(raw) ?? raw;
  const allowed = new Set(["all", "merged-baseline", "best-baseline", "best-merged-baseline"]);
  if (!allowed.has(mode)) {
    throw new Error(`Unknown --parallel-final-candidates mode: ${raw}. Use all, merged-baseline, best-baseline, or best-merged-baseline.`);
  }
  return mode;
}

function selectParallelFinalCandidates(candidates, mode) {
  if (mode === "all") return candidates;
  const bySource = (source) => candidates.find((candidate) => candidate.source === source);
  const starting = candidates.find((candidate) => candidate.candidateId === "starting-policy");
  const merged = bySource("merged");
  const bestChild = candidates
    .filter((candidate) => candidate.source === "child-best")
    .sort((a, b) => parallelCandidateSelectionScore(b) - parallelCandidateSelectionScore(a)
      || Number(a.sourceRun ?? 0) - Number(b.sourceRun ?? 0)
      || a.candidateId.localeCompare(b.candidateId))[0];
  if (mode === "merged-baseline") return uniqueCandidates([merged, starting]);
  if (mode === "best-baseline") return uniqueCandidates([bestChild, starting]);
  if (mode === "best-merged-baseline") return uniqueCandidates([bestChild, merged, starting]);
  return candidates;
}

function uniqueCandidates(candidates) {
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate.candidateId)) continue;
    seen.add(candidate.candidateId);
    result.push(candidate);
  }
  return result;
}

function parallelCandidateSelectionScore(candidate) {
  if (candidate.childSummary && candidate.childBaselineSummary) {
    return Number(candidate.childSummary.score ?? 0) - Number(candidate.childBaselineSummary.score ?? 0);
  }
  return Number(candidate.scoreHint ?? candidate.childSummary?.score ?? 0);
}

function selectParallelCandidateWithoutFinal(candidates, mode) {
  if (mode === "merged") {
    return candidates.find((candidate) => candidate.source === "merged")
      ?? selectParallelCandidateWithoutFinal(candidates, "best-child");
  }
  const eligible = candidates.filter((candidate) => candidate.source === "child-best");
  return [...eligible].sort((a, b) => {
    return parallelCandidateSelectionScore(b) - parallelCandidateSelectionScore(a)
      || String(a.candidateId).localeCompare(String(b.candidateId));
  })[0] ?? candidates[0];
}

function writeParallelRunManifest({
  config,
  opponentSelection,
  parallelDecks,
  childReports,
  selectedBest,
  finalEvaluations,
  parallelFinalSkipped = false,
  parallelFinalCandidateMode = undefined
}) {
  writeJsonFileSync(join(config.outDir, "parallel-runs.json"), {
    schema: "union-arena-local-engine/pilot-agent-parallel@1",
    createdAt: new Date().toISOString(),
    selectedBest,
    parallelFinalSkipped,
    parallelFinalCandidateMode,
    opponentSelection: opponentSelection.summary,
    deckPool: parallelDecks.map((parallelDeck) => ({
      id: parallelDeck.id,
      name: parallelDeck.name,
      path: parallelDeck.path
    })),
    childRuns: childReports.map(({ run, report }) => ({
      runNumber: run.runNumber,
      seed: run.seed,
      deckId: run.deckId,
      deckName: run.deckName,
      opponentSelection: run.opponentSelection,
      opponentIds: run.opponentIds,
      outDir: run.outDir,
      result: report.result,
      analysis: compactAnalysisForManifest(report.analysis)
    })),
    finalEvaluations: finalEvaluations.map((candidate) => ({
      candidateId: candidate.candidateId,
      source: candidate.source,
      sourceRun: candidate.sourceRun ?? null,
      childSeed: candidate.childSeed ?? null,
      childDeckId: candidate.childDeckId ?? null,
      childDeckName: candidate.childDeckName ?? null,
      summary: candidate.evaluation?.summary ?? null,
      childSummary: candidate.childSummary ?? null,
      childReportPath: candidate.childReportPath ?? null,
      childPolicyPath: candidate.childPolicyPath ?? null
    }))
  });
}

function writeParallelChildCandidateManifest(config, childReports, learnedCandidates, finalChildCandidates) {
  writeJsonFileSync(join(config.outDir, "parallel-child-candidates.json"), {
    schema: "union-arena-local-engine/pilot-agent-parallel-candidates@1",
    createdAt: new Date().toISOString(),
    selectedForFinal: finalChildCandidates.map((candidate) => candidate.candidateId),
    candidates: learnedCandidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      source: candidate.source,
      sourceRun: candidate.sourceRun,
      childSeed: candidate.childSeed,
      childDeckId: candidate.childDeckId,
      childDeckName: candidate.childDeckName,
      childReportPath: candidate.childReportPath,
      childPolicyPath: candidate.childPolicyPath,
      scoreHint: Number(candidate.scoreHint ?? 0),
      childSummary: candidate.childSummary,
      childBaselineSummary: candidate.childBaselineSummary
    })),
    childRuns: childReports.map(({ run, report }) => ({
      runNumber: run.runNumber,
      seed: run.seed,
      deckId: run.deckId,
      deckName: run.deckName,
      opponentIds: run.opponentIds,
      outDir: run.outDir,
      result: report.result,
      analysis: compactAnalysisForManifest(report.analysis)
    }))
  });
}

function compactAnalysisForManifest(analysis) {
  if (!analysis) return null;
  return {
    generatedAt: analysis.generatedAt ?? null,
    summary: analysis.summary ?? null,
    baselineSummary: analysis.baselineSummary ?? null,
    stopReasons: analysis.stopReasons ?? null,
    matchups: Array.isArray(analysis.matchups) ? analysis.matchups.slice(0, 12) : [],
    topRankings: Array.isArray(analysis.topRankings) ? analysis.topRankings.slice(0, 8) : [],
    positives: Array.isArray(analysis.positives) ? analysis.positives.slice(0, 8) : [],
    negatives: Array.isArray(analysis.negatives) ? analysis.negatives.slice(0, 8) : [],
    recommendations: Array.isArray(analysis.recommendations) ? analysis.recommendations.slice(0, 8) : []
  };
}

function parallelChildArgs({ deckId, opponentIds }) {
  const valueFlags = new Set([
    "--deck",
    "--out-dir",
    "--seed",
    "--parallel-runs",
    "--parallel-concurrency",
    "--parallel-final-games",
    "--parallel-final-top-percent",
    "--parallel-final-child-percent",
    "--parallel-final-candidates",
    "--parallel-final-candidate-mode",
    "--update-policy",
    "--child-seed",
    "--parallel-opponent-seed",
    "--parallel-decks",
    "--parallel-decks-file",
    "--parallel-deck-mode",
    "--parallel-deck-seed",
    "--parallel-deck-prefix",
    "--deck-prefix",
    "--parallel-opponent-diversity",
    "--parallel-opponent-count-per-run",
    "--parallel-child-timeout-minutes",
    "--parallel-child-stale-minutes",
    "--parallel-skip-selection",
    "--skip-parallel-selection",
    "--opponents",
    "--opponents-file",
    "--opponent-mode",
    "--opponents-mode",
    "--opponent-count",
    "--regions",
    "--regionals",
    "--opponent-regions",
    "--opponent-top",
    "--opponent-color",
    "--opponent-colors",
    "--opponent-set",
    "--opponent-sets",
    "--opponent-seed"
  ]);
  const booleanFlags = new Set([
    "--opponent-include-self",
    "--random-child-seeds",
    "--no-create-routed-policy",
    "--no-update-routed-policy",
    "--parallel-opponents-per-run",
    "--different-opponents-per-run",
    "--parallel-diverse-opponents",
    "--update-parallel-child-routed-policies",
    "--parallel-update-child-routed-policies",
    "--update-child-routed-policies",
    "--update-child-baselines",
    "--force-update-child-routed-policies",
    "--skip-parallel-final"
  ]);
  return [
    "train",
    ...stripOptions(process.argv.slice(3), { valueFlags, booleanFlags }),
    "--no-create-routed-policy",
    "--no-update-routed-policy",
    "--parallel-runs", "1",
    "--deck", deckId,
    "--opponents", opponentIds.join(",")
  ];
}

function childRunSeeds(count, baseSeed) {
  if (hasFlag("--random-child-seeds")) {
    const seen = new Set();
    while (seen.size < count) {
      seen.add(Math.floor(Math.random() * 0x100000000));
    }
    return [...seen];
  }

  const rng = makeRng(Number(option("--child-seed") ?? baseSeed));
  const seen = new Set();
  while (seen.size < count) {
    seen.add(Math.floor(rng() * 0x100000000));
  }
  return [...seen];
}

function defaultDeckIdForParallelMissingBaselines(config) {
  if (!wantsMissingBaselineParallelDecks()) return null;
  const deck = missingBaselineDeckIds(config)[0];
  if (!deck) throw new Error("No saved Carnerr/Engine decks need routed baseline training.");
  return deck.id;
}

function parallelDeckIdsOption(defaultDeckId, config, runCount = 1) {
  const values = parallelDeckOptionValues();
  const wantsMissingBaselines = values.some((value) => isMissingBaselineDeckKeyword(value));
  if (wantsMissingBaselines) {
    const allMissingDecks = missingBaselineDeckIds(config);
    if (allMissingDecks.length === 0) {
      throw new Error("No saved Carnerr/Engine decks need routed baseline training.");
    }
    const decks = allMissingDecks.slice(0, Math.max(1, Number(runCount) || 1));
    return {
      ids: decks.map((deck) => deck.id),
      summary: {
        mode: "missing-baselines",
        selectedCount: decks.length,
        missingCount: allMissingDecks.length,
        selectedDecks: decks.map((deck) => ({
          id: deck.id,
          name: deck.name,
          ownKey: deck.ownKey,
          specialistPath: deck.specialistPath,
          baselineStatus: deck.baselineStatus,
          selectedKind: deck.selectedKind,
          selectedLayout: deck.selectedLayout,
          baselineOriginPath: deck.baselineOriginPath,
          baselineOrigin: deck.baselineOrigin
        })),
        prefixes: pilotDeckPrefixes()
      }
    };
  }
  const ids = values.length > 0 ? values : [defaultDeckId];
  return {
    ids: [...new Set(ids)],
    summary: {
      mode: values.length > 0 ? "explicit" : "default",
      selectedCount: new Set(ids).size,
      selectedDecks: [...new Set(ids)].map((id) => ({ id }))
    }
  };
}

function wantsMissingBaselineParallelDecks() {
  return parallelDeckOptionValues().some((value) => isMissingBaselineDeckKeyword(value));
}

function parallelDeckOptionValues() {
  const values = [];
  const inline = option("--parallel-decks");
  if (inline) values.push(...opponentIdsFromText(inline));
  const file = option("--parallel-decks-file");
  if (file) values.push(...opponentIdsFromText(readFileSync(file, "utf8")));
  return values;
}

function isMissingBaselineDeckKeyword(value) {
  const normalized = normalizeSearch(value).replace(/\s+/g, "-");
  return [
    "missing-baselines",
    "missing-baseline",
    "missing",
    "needs-baseline",
    "no-baseline",
    "without-baseline"
  ].includes(normalized);
}

function pilotDeckPrefixes() {
  return (option("--parallel-deck-prefix") ?? option("--deck-prefix") ?? "carnerr-,engine-")
    .split(",")
    .map((prefix) => prefix.trim())
    .filter(Boolean);
}

function missingBaselineDeckIds(config) {
  const prefixes = pilotDeckPrefixes();
  const policyDir = config.policyDir ?? option("--policy-dir") ?? DEFAULT_POLICY_DIR;
  const baselineRoot = config.baselineRoot ?? option("--baseline-root");
  const fallbackPolicyPath = resolvePolicyPath(option("--fallback-policy") ?? "current");
  return readSavedDeckIndex(config.libraryDir)
    .filter((deck) => prefixes.some((prefix) => deck.id.startsWith(prefix)))
    .map((deck) => {
      const saved = loadSavedDeck(config.libraryDir, deck.id);
      const routed = resolvePolicyForDeck({
        deck: saved.cards,
        catalog: config.catalog,
        savedDeck: saved.raw,
        deckId: saved.id,
        policyDir,
        baselineRoot,
        fallbackPolicyPath,
        deckLibrary: config.libraryDir
      });
      const specialistPath = policyPathForProfile(routed.profile, { policyDir, baselineRoot });
      const origin = readBaselineOriginForProfile(routed.profile, { policyDir, baselineRoot });
      const needsBaselineTraining = baselineNeedsTraining({ routed, origin, specialistPath });
      return {
        id: saved.id,
        name: saved.name,
        ownKey: routed.profile.key,
        specialistPath,
        foundSpecialist: routed.foundSpecialist,
        selectedKind: routed.kind,
        selectedPath: routed.path,
        selectedLayout: routed.layout ?? null,
        baselineOriginPath: origin.path,
        baselineOrigin: origin.data ? {
          quality: origin.data.quality ?? null,
          promotionType: origin.data.promotionType ?? null,
          needsTraining: Boolean(origin.data.needsTraining),
          acceptedForLearning: Boolean(origin.data.acceptedForLearning)
        } : null,
        needsBaselineTraining,
        baselineStatus: !routed.foundSpecialist
          ? "missing"
          : needsBaselineTraining
            ? "seed"
            : "trained"
      };
    })
    .filter((deck) => deck.needsBaselineTraining)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function readBaselineOriginForProfile(profile, { policyDir, baselineRoot } = {}) {
  const path = baselineOriginPathForProfile(profile, { policyDir, baselineRoot });
  if (!existsSync(path)) return { path, data: null };
  try {
    return { path, data: JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return { path, data: { quality: "unknown", needsTraining: true, parseError: true } };
  }
}

function baselineNeedsTraining({ routed, origin, specialistPath }) {
  if (!routed?.foundSpecialist) return true;
  const selectedPath = routed.path ? String(routed.path) : "";
  const organizedPath = specialistPath ? String(specialistPath) : "";
  if (organizedPath && selectedPath && selectedPath !== organizedPath) return false;
  const data = origin?.data ?? null;
  if (!data) return true;
  if (data.quality === "seed" || data.promotionType === "missing-seed" || data.promotionType === "implicit-seed") return true;
  if (data.needsTraining === true) return true;
  return false;
}

function parallelDeckAssignments(deckIds, runCount, seed) {
  if (deckIds.length === 0) throw new Error("Parallel deck pool is empty.");
  const mode = normalizeSearch(option("--parallel-deck-mode") ?? "round-robin").replace(/\s+/g, "-");
  if (mode === "round-robin" || mode === "roundrobin") {
    return Array.from({ length: runCount }, (_, index) => deckIds[index % deckIds.length]);
  }
  if (mode === "random") {
    const rng = makeRng(Number(option("--parallel-deck-seed") ?? seed + 8081));
    return Array.from({ length: runCount }, () => deckIds[Math.floor(rng() * deckIds.length)]);
  }
  throw new Error(`Unknown parallel deck mode: ${mode}. Use round-robin or random.`);
}

function parallelOpponentDiversityMode(defaultValue = "none") {
  const explicit = option("--parallel-opponent-diversity");
  if (!explicit && hasFlag("--parallel-diverse-opponents")) return "set-color";
  const raw = explicit ?? defaultValue;
  if (!raw) return "none";
  const normalized = normalizeSearch(raw).replace(/\s+/g, "-");
  const aliases = new Map([
    ["off", "none"],
    ["false", "none"],
    ["no", "none"],
    ["source-color", "set-color"],
    ["source-colors", "set-color"],
    ["set-colors", "set-color"],
    ["profile", "set-color"],
    ["archetype", "set-color"],
    ["deck-id", "deck"],
    ["saved-deck", "deck"]
  ]);
  const mode = aliases.get(normalized) ?? normalized;
  const allowed = new Set(["none", "set-color", "deck"]);
  if (!allowed.has(mode)) {
    throw new Error(`Unknown --parallel-opponent-diversity: ${raw}. Use set-color, deck, or none.`);
  }
  return mode;
}

function selectDiverseParallelOpponentSelections({
  libraryDir,
  fallbackDeckIds,
  runCount,
  seed,
  countPerRun,
  diversity
}) {
  const mode = opponentMode();
  if (mode === "mirror") {
    throw new Error("--parallel-opponent-diversity needs random, regional, all-regionals, or explicit opponent mode.");
  }

  const requestedPerRun = Math.max(1, Number(countPerRun) || 1);
  let candidates = [];
  let summaryExtra = {};

  if (mode === "explicit") {
    const text = opponentsText();
    if (!text) throw new Error("Explicit opponent mode needs --opponents deck-a,deck-b or --opponents-file path.");
    const ids = opponentIdsFromText(text);
    candidates = ids.map((id) => {
      const deck = loadSavedDeck(libraryDir, id);
      return deckIndexEntry(deck.raw, deck.path);
    });
    summaryExtra = {
      source: option("--opponents-file") ? option("--opponents-file") : "--opponents"
    };
  } else {
    if (hasExplicitOpponentList()) {
      throw new Error(`--opponents and --opponents-file can only be used with explicit opponent mode, not ${mode}.`);
    }

    const fallbackSet = new Set(fallbackDeckIds);
    const regionalCandidates = readSavedDeckIndex(libraryDir)
      .filter((deck) => deck.isRegional)
      .filter((deck) => hasFlag("--opponent-include-self") || !fallbackSet.has(deck.id));
    candidates = regionalCandidates;
    const requestedRegions = optionList("--regions", "--regionals", "--opponent-regions");

    if (mode === "regional") {
      if (requestedRegions.length === 0) {
        const locations = uniqueSorted(regionalCandidates.map((deck) => deck.location).filter(Boolean));
        throw new Error(`Regional opponent mode needs --regions "Peoria Illinois,Virginia". Available regions: ${locations.join(", ")}`);
      }
      candidates = candidates.filter((deck) => matchesRequestedRegion(deck.location, requestedRegions));
    } else if (requestedRegions.length > 0) {
      candidates = candidates.filter((deck) => matchesRequestedRegion(deck.location, requestedRegions));
    }

    candidates = applyOpponentFilters(candidates);
    summaryExtra = {
      availableRegionalDecks: regionalCandidates.length,
      candidateDecks: candidates.length,
      requestedCount: requestedPerRun,
      regions: requestedRegions,
      filters: opponentFilterSummary()
    };
  }

  return buildDiverseParallelOpponentSelections({
    libraryDir,
    mode,
    candidates,
    runCount,
    seed,
    countPerRun: requestedPerRun,
    diversity,
    summaryExtra
  });
}

function buildDiverseParallelOpponentSelections({
  libraryDir,
  mode,
  candidates,
  runCount,
  seed,
  countPerRun,
  diversity,
  summaryExtra
}) {
  if (candidates.length === 0) throw new Error(`Opponent mode ${mode} has no candidate decks after filters.`);
  const rng = makeRng(seed);
  const sorted = [...candidates].sort(compareOpponentDecks);
  const buckets = shuffleItems([...groupBy(sorted, (deck) => opponentDiversityKey(deck, diversity)).entries()]
    .map(([key, decks]) => ({
      key,
      decks: shuffleItems([...decks].sort(compareOpponentDecks), rng),
      cursor: 0
    })), rng);
  if (buckets.length === 0) throw new Error(`Opponent mode ${mode} has no ${diversity} buckets after filters.`);

  const usedIds = new Set();
  return Array.from({ length: runCount }, (_, runIndex) => {
    const ids = [];
    const keys = [];
    const primaryBucket = buckets[runIndex % buckets.length];
    takeOpponentFromBucket(primaryBucket, ids, keys, usedIds, { preferUnused: true });

    let offset = 1;
    while (ids.length < countPerRun && offset <= buckets.length * 2) {
      const bucket = buckets[(runIndex + offset) % buckets.length];
      takeOpponentFromBucket(bucket, ids, keys, usedIds, { preferUnused: true });
      offset += 1;
    }

    offset = 0;
    while (ids.length < countPerRun && offset < buckets.length * countPerRun) {
      const bucket = buckets[(runIndex + offset) % buckets.length];
      takeOpponentFromBucket(bucket, ids, keys, usedIds, { preferUnused: false });
      offset += 1;
    }

    return selectedOpponents({
      libraryDir,
      mode: `${mode}-parallel-diverse`,
      ids,
      seed: seed + runIndex,
      summaryExtra: {
        ...summaryExtra,
        diversity,
        diversityKeys: keys,
        availableDiversityBuckets: buckets.length,
        candidateDecks: candidates.length,
        requestedCount: countPerRun
      }
    });
  });
}

function takeOpponentFromBucket(bucket, ids, keys, usedIds, { preferUnused }) {
  if (!bucket || bucket.decks.length === 0) return false;
  const alreadySelected = new Set(ids);
  const candidates = preferUnused
    ? bucket.decks.filter((deck) => !usedIds.has(deck.id) && !alreadySelected.has(deck.id))
    : bucket.decks.filter((deck) => !alreadySelected.has(deck.id));
  if (candidates.length === 0) return false;

  const deck = candidates[bucket.cursor % candidates.length];
  bucket.cursor += 1;
  ids.push(deck.id);
  keys.push(bucket.key);
  usedIds.add(deck.id);
  return true;
}

function opponentDiversityKey(deck, diversity) {
  if (diversity === "deck") return deck.id;
  const source = normalizeSearch(deck.sourceCode ?? deck.deckType ?? "unknown").replace(/\s+/g, "-") || "unknown";
  const colors = [...new Set((deck.colors ?? []).map(normalizeSearch).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  return `${source}-${colors.length > 0 ? colors.join("-") : "unknown"}`;
}

function shuffleItems(items, rng) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function summarizeOpponentIds(ids, limit = 4) {
  if (ids.length <= limit) return ids.join(", ");
  return `${ids.slice(0, limit).join(", ")} ... +${ids.length - limit} more`;
}

function stripOptions(args, { valueFlags, booleanFlags }) {
  const stripped = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (booleanFlags.has(arg) || [...booleanFlags].some((flag) => arg.startsWith(`${flag}=`))) continue;
    if (valueFlags.has(arg)) {
      index += 1;
      continue;
    }
    if ([...valueFlags].some((flag) => arg.startsWith(`${flag}=`))) continue;
    stripped.push(arg);
  }
  return stripped;
}

async function runParallelTrainingQueue(runs, concurrency, config = {}) {
  const results = [];
  let nextIndex = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (nextIndex < runs.length) {
      const run = runs[nextIndex];
      nextIndex += 1;
      results.push(await runChildTrainingProcess(run, config));
    }
  });
  await Promise.all(workers);
  return results.sort((a, b) => a.runNumber - b.runNumber);
}

function runChildTrainingProcess(run, config = {}) {
  return new Promise((resolve) => {
    mkdirSync(run.outDir, { recursive: true });
    console.log(`Starting run ${padRunNumber(run.runNumber)} with seed ${run.seed}.`);
    const child = spawn(process.execPath, [process.argv[1], ...run.args], {
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    const stdoutPrefixer = createLinePrefixer(`run ${padRunNumber(run.runNumber)}`, console.log);
    const stderrPrefixer = createLinePrefixer(`run ${padRunNumber(run.runNumber)} err`, console.error);
    const startedAt = Date.now();
    const statusPath = join(run.outDir, "child-status.json");
    const command = `node ${[process.argv[1], ...run.args].join(" ")}`;
    const timeoutMs = Math.max(0, Number(config.parallelChildTimeoutMinutes ?? 0)) * 60_000;
    const staleMs = Math.max(0, Number(config.parallelChildStaleMinutes ?? 0)) * 60_000;
    let lastActivityAt = Date.now();
    let killedReason = null;
    let resolved = false;
    const recordActivity = () => {
      lastActivityAt = Date.now();
    };
    const writeStatus = (patch = {}) => {
      writeJsonFileSync(statusPath, {
        schema: "union-arena-local-engine/pilot-child-status@1",
        runNumber: run.runNumber,
        seed: run.seed,
        deckId: run.deckId,
        opponentIds: run.opponentIds,
        outDir: run.outDir,
        pid: child.pid ?? null,
        command,
        startedAt: new Date(startedAt).toISOString(),
        updatedAt: new Date().toISOString(),
        lastActivityAt: new Date(lastActivityAt).toISOString(),
        timeoutMinutes: Number(config.parallelChildTimeoutMinutes ?? 0),
        staleMinutes: Number(config.parallelChildStaleMinutes ?? 0),
        status: killedReason ? "terminating" : "running",
        ...patch
      });
    };
    const terminate = (reason) => {
      if (resolved || killedReason) return;
      killedReason = reason;
      console.error(`Run ${padRunNumber(run.runNumber)} exceeded ${reason}; terminating child process ${child.pid ?? "unknown"}.`);
      writeStatus({ status: "terminating", killedReason });
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!resolved) child.kill("SIGKILL");
      }, 10_000).unref?.();
    };
    writeStatus();
    const monitor = setInterval(() => {
      const now = Date.now();
      writeStatus();
      if (timeoutMs > 0 && now - startedAt > timeoutMs) {
        terminate(`timeout ${config.parallelChildTimeoutMinutes} minute(s)`);
      } else if (staleMs > 0 && now - lastActivityAt > staleMs) {
        terminate(`stale for ${config.parallelChildStaleMinutes} minute(s)`);
      }
    }, Math.max(15_000, Math.min(60_000, staleMs > 0 ? staleMs / 3 : 60_000)));
    monitor.unref?.();

    child.stdout.on("data", (chunk) => {
      recordActivity();
      stdoutChunks.push(chunk);
      stdoutPrefixer.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      recordActivity();
      stderrChunks.push(chunk);
      stderrPrefixer.write(chunk);
    });
    child.on("close", (exitCode, signal) => {
      resolved = true;
      clearInterval(monitor);
      stdoutPrefixer.flush();
      stderrPrefixer.flush();
      const stdoutText = Buffer.concat(stdoutChunks).toString("utf8");
      const stderrText = Buffer.concat(stderrChunks).toString("utf8");
      writeFileSync(join(run.outDir, "stdout.log"), stdoutText);
      writeFileSync(join(run.outDir, "stderr.log"), stderrText);
      writeStatus({
        status: exitCode === 0 && !killedReason ? "finished" : "failed",
        exitCode,
        signal,
        killedReason,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt
      });
      console.log(`Run ${padRunNumber(run.runNumber)} finished with exit code ${exitCode}.`);
      resolve({
        ...run,
        exitCode,
        signal,
        killedReason
      });
    });
  });
}

function createLinePrefixer(label, writer) {
  let buffer = "";
  return {
    write(chunk) {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line) writer(`[${label}] ${line}`);
      }
    },
    flush() {
      if (buffer) writer(`[${label}] ${buffer}`);
      buffer = "";
    }
  };
}

function readParallelChildResult(run) {
  const reportPath = join(run.outDir, "report.json");
  const policyPath = join(run.outDir, "best-policy.json");
  if (!existsSync(reportPath)) throw new Error(`Missing child report: ${reportPath}`);
  if (!existsSync(policyPath)) throw new Error(`Missing child policy: ${policyPath}`);
  return {
    run,
    report: JSON.parse(readFileSync(reportPath, "utf8")),
    policy: JSON.parse(readFileSync(policyPath, "utf8"))
  };
}

function shouldUpdateParallelChildRoutedPolicies(config = {}) {
  if (config.updateParallelChildRoutedPolicies) return true;
  return hasFlag("--update-parallel-child-routed-policies")
    || hasFlag("--parallel-update-child-routed-policies")
    || hasFlag("--update-child-routed-policies")
    || hasFlag("--update-child-baselines");
}

function writeParallelChildRoutedPolicyUpdates(childReports, { config, enabled }) {
  if (!enabled) return { enabled: false, promotions: [] };

  const policyDir = option("--policy-dir") ?? DEFAULT_POLICY_DIR;
  const baselineRoot = option("--baseline-root");
  const byProfile = new Map();
  for (const childReport of childReports) {
    const selection = childReport.report?.config?.policySelection;
    if (!selection?.routed || !selection.profile) continue;
    const key = selection.profile.key;
    const current = byProfile.get(key);
    const score = Number(childReport.report?.result?.score ?? 0);
    const baselineScore = Number(childReport.report?.baselineSummary?.score ?? 0);
    const scoreDelta = score - baselineScore;
    const candidate = {
      ...childReport,
      key,
      selection,
      score,
      baselineScore,
      scoreDelta
    };
    if (!current
      || Number(candidate.scoreDelta) > Number(current.scoreDelta)
      || Number(candidate.scoreDelta) === Number(current.scoreDelta) && Number(candidate.score) > Number(current.score)) {
      byProfile.set(key, candidate);
    }
  }

  const margin = Number(option("--policy-promotion-margin") ?? 0);
  const promotions = [...byProfile.values()].map((candidate) => {
    const missingSpecialist = !candidate.selection.foundSpecialist;
    const forced = hasFlag("--force-update-child-routed-policies");
    const quality = promotionQualityForSummary(candidate.report?.result, { initialBaseline: missingSpecialist });
    const promotionEvidence = quality.ok
      ? promotionEvidenceGate({
        candidateSummary: candidate.report?.result,
        baselineSummary: candidate.report?.baselineSummary,
        comparison: candidate.report?.promotionComparison,
        margin
      })
      : {
        promote: false,
        reason: quality.reason,
        candidateScore: candidate.score,
        baselineScore: candidate.baselineScore,
        margin
      };
    const improved = promotionEvidence.promote;
    const writeFallbackSeed = missingSpecialist && !improved && !forced;
    const promote = forced || writeFallbackSeed || improved;
    const promotionType = !promote
      ? "rejected"
      : writeFallbackSeed
        ? "missing-seed"
        : forced
          ? "forced"
          : missingSpecialist
            ? "missing-improved"
            : "improved";
    const policyToWrite = writeFallbackSeed
      ? loadSeedPolicyForMissingSpecialist(candidate)
      : candidate.policy;
    const row = {
      deckId: candidate.run.deckId,
      deckName: candidate.run.deckName,
      runNumber: candidate.run.runNumber,
      ownKey: candidate.key,
      specialistPath: candidate.selection.specialistPath,
      missingSpecialist,
      promote,
      promotionType,
      validatedImprovement: Boolean(promote && !writeFallbackSeed && promotionEvidence.promote),
      acceptedForLearning: Boolean(promote && !writeFallbackSeed && promotionEvidence.promote),
      needsTraining: writeFallbackSeed,
      reason: promote
        ? writeFallbackSeed
          ? quality.ok
            ? `specialist baseline was missing; seeded fallback because ${promotionEvidence.reason}`
            : `specialist baseline was missing; seeded fallback because ${quality.reason}`
          : forced
            ? "forced by --force-update-child-routed-policies"
            : missingSpecialist
              ? `specialist baseline was missing and child passed paired evidence: ${promotionEvidence.reason}`
              : promotionEvidence.reason
        : quality.ok
          ? promotionEvidence.reason
          : quality.reason,
      candidateScore: candidate.score,
      baselineScore: candidate.baselineScore,
      scoreDelta: candidate.scoreDelta,
      promotionQuality: quality,
      promotionEvidence,
      childReportPath: join(candidate.run.outDir, "report.json"),
      childPolicyPath: join(candidate.run.outDir, "best-policy.json"),
      writtenSource: promote ? writeFallbackSeed ? "fallback-seed-policy" : "child-best-policy" : null
    };
    if (promote) {
      row.writtenPath = writePolicyForProfile(policyToWrite, candidate.selection.profile, {
        policyDir,
        baselineRoot
      });
      row.originPath = writeBaselineOriginForProfile(baselineOriginArtifact({
        row,
        candidate,
        promotionType,
        writeFallbackSeed,
        policyToWrite
      }), candidate.selection.profile, { policyDir, baselineRoot });
    }
    return row;
  });

  const summary = { enabled: true, promotions };
  writeJsonFileSync(join(config.outDir, "parallel-child-routed-policy-promotions.json"), summary);
  for (const row of promotions) {
    if (row.promote) {
      console.log(`Updated child routed baseline for ${row.deckId} at ${row.writtenPath}.`);
    } else {
      console.log(`Did not update child routed baseline for ${row.deckId}: ${row.reason}.`);
    }
  }
  return summary;
}

function baselineOriginArtifact({ row, candidate, promotionType, writeFallbackSeed, policyToWrite }) {
  return {
    schema: "union-arena-local-engine/baseline-origin@1",
    createdAt: new Date().toISOString(),
    deckId: row.deckId,
    deckName: row.deckName,
    runNumber: row.runNumber,
    ownKey: row.ownKey,
    specialistPath: row.specialistPath,
    promotionType,
    quality: writeFallbackSeed ? "seed" : "trained",
    missingSpecialist: row.missingSpecialist,
    validatedImprovement: row.validatedImprovement,
    acceptedForLearning: row.acceptedForLearning,
    needsTraining: row.needsTraining,
    reason: row.reason,
    candidateScore: row.candidateScore,
    baselineScore: row.baselineScore,
    scoreDelta: row.scoreDelta,
    promotionQuality: row.promotionQuality ?? null,
    childReportPath: row.childReportPath,
    childPolicyPath: row.childPolicyPath,
    writtenSource: row.writtenSource,
    writtenPath: row.writtenPath,
    policyName: policyToWrite?.name ?? null,
    profile: candidate.selection.profile
  };
}

function loadSeedPolicyForMissingSpecialist(candidate) {
  const selectedPath = resolvePolicyPath(candidate.selection?.selectedPath);
  if (selectedPath && existsSync(selectedPath)) {
    return normalizePilotPolicy(JSON.parse(readFileSync(selectedPath, "utf8")));
  }
  return normalizePilotPolicy(candidate.policy);
}

function mergePilotPolicies(candidates) {
  if (candidates.length === 0) return normalizePilotPolicy();
  const normalized = candidates.map((candidate) => ({
    ...candidate,
    policy: normalizePilotPolicy(candidate.policy)
  }));
  const minScore = Math.min(...normalized.map((candidate) => Number(candidate.scoreHint ?? 0)));
  const weightsByCandidate = normalized.map((candidate) => Math.max(0.25, Number(candidate.scoreHint ?? 0) - minScore + 1));
  const totalWeight = weightsByCandidate.reduce((total, weight) => total + weight, 0);
  const featureNames = Object.keys(normalizePilotPolicy().weights);
  const weights = {};

  for (const feature of featureNames) {
    const weightedValue = normalized.reduce((total, candidate, index) => {
      return total + Number(candidate.policy.weights[feature] ?? 0) * weightsByCandidate[index];
    }, 0) / totalWeight;
    weights[feature] = Math.round(weightedValue);
  }

  return normalizePilotPolicy({
    schema: DEFAULT_PILOT_POLICY.schema,
    name: "parallel-merged-policy",
    weights
  });
}

function padRunNumber(value) {
  return String(value).padStart(2, "0");
}

function readConfig({ outDir }) {
  const preset = pilotAgentPreset();
  const defaults = sharedPilotAgentPresetDefaults(preset);
  const catalogPath = option("--catalog") ?? DEFAULT_CATALOG;
  const libraryDir = option("--library") ?? DEFAULT_LIBRARY;
  const mlModelPath = option("--ml-model") ?? option("--action-model");
  const opponentMlModelPath = option("--opponent-ml-model") ?? option("--opponent-action-model") ?? (hasFlag("--ml-model-all") ? mlModelPath : undefined);
  const mlModel = loadOptionalMlModel(mlModelPath);
  const opponentMlModel = loadOptionalMlModel(opponentMlModelPath);
  const games = Number(option("--games") ?? defaults.games ?? 12);
  const finalGames = Number(option("--final-games") ?? defaults.finalGames ?? games);
  const parallelFinalGames = Number(option("--parallel-final-games") ?? defaults.parallelFinalGames ?? finalGames);
  return {
    preset,
    catalogPath,
    libraryDir,
    outDir,
    catalog: loadCatalogJson(catalogPath),
    agentRoot: option("--agent-root") ?? DEFAULT_AGENT_ROOT,
    policyDir: option("--policy-dir") ?? DEFAULT_POLICY_DIR,
    baselineRoot: option("--baseline-root"),
    dryRun: hasFlag("--dry-run"),
    games,
    seed: Number(option("--seed") ?? 20260706),
    validateDecks: !hasFlag("--no-validate"),
    autoMulliganBricks: hasFlag("--auto-mulligan-bricks"),
    mulliganMode: mulliganMode(defaults),
    maxTurns: Number(option("--max-turns") ?? 80),
    maxActions: Number(option("--max-actions") ?? 1000),
    recordTrainingGames: recordTrainingGames(defaults),
    progressIntervalMs: progressIntervalMs(),
    decisionLogMode: decisionLogMode(defaults),
    updatePolicyPath: resolvePolicyPath(option("--update-policy")) ?? null,
    routedPolicyUpdatesEnabled: hasFlag("--update-routed-policy")
      || (!hasFlag("--no-update-routed-policy") && defaults.routedPolicyUpdatesEnabled === true),
    mlModelPath: mlModelPath ?? null,
    mlStrength: Number(option("--ml-strength") ?? option("--action-model-strength") ?? defaults.mlStrength ?? 1),
    mlModel,
    opponentMlModelPath: opponentMlModelPath ?? null,
    opponentMlStrength: Number(option("--opponent-ml-strength") ?? option("--opponent-action-model-strength") ?? option("--ml-strength") ?? defaults.mlStrength ?? 1),
    opponentMlModel,
    opponentProfileMlEnabled: !hasFlag("--no-opponent-profile-ml") && !hasFlag("--no-opponent-ml-routing"),
    matchupOverlaysEnabled: !hasFlag("--no-matchup-overlays"),
    matchupOverlayStrength: Number(option("--matchup-overlay-strength") ?? option("--matchup-strength") ?? defaults.matchupOverlayStrength ?? 1),
    matchupMinConfidence: Number(option("--matchup-min-confidence") ?? option("--matchup-confidence") ?? defaults.matchupMinConfidence ?? 0.7),
    matchupKnownDeckVariants: hasFlag("--matchup-known-deck-variants"),
    matchupVariantMinDeckConfidence: Number(option("--matchup-variant-min-deck-confidence") ?? defaults.matchupVariantMinDeckConfidence ?? 0.55),
    matchupVariantMinObservedCoverage: Number(option("--matchup-variant-min-coverage") ?? defaults.matchupVariantMinCoverage ?? 0.75),
    matchupUnknownVariantMinEvidence: Number(option("--matchup-unknown-min-evidence") ?? defaults.matchupUnknownMinEvidence ?? 4),
    deckInferenceEnabled: !hasFlag("--no-deck-inference"),
    actionExploration: actionExplorationConfig(defaults, { model: mlModel, path: mlModelPath }),
    counterfactualExploration: counterfactualExplorationConfig(defaults),
    parallelRuns: Number(option("--parallel-runs") ?? defaults.parallelRuns ?? 1),
    parallelConcurrency: Number(option("--parallel-concurrency") ?? option("--parallel-runs") ?? defaults.parallelConcurrency ?? defaults.parallelRuns ?? 1),
    generations: Number(option("--generations") ?? defaults.generations ?? 4),
    populationSize: Number(option("--population") ?? defaults.population ?? 8),
    eliteCount: Math.max(1, Number(option("--elite") ?? defaults.elite ?? 2)),
    mutationScale: Number(option("--mutation-scale") ?? defaults.mutationScale ?? 80),
    mutationRate: Number(option("--mutation-rate") ?? defaults.mutationRate ?? 0.35),
    mutationGroupsPerChild: Math.max(1, Number(option("--mutation-groups-per-child") ?? defaults.mutationGroupsPerChild ?? 2)),
    mutationMaxFeatures: Math.max(1, Number(option("--mutation-max-features") ?? defaults.mutationMaxFeatures ?? 12)),
    finalGames,
    parallelFinalGames,
    parallelFinalTopPercent: option("--parallel-final-top-percent") ?? option("--parallel-final-child-percent") ?? defaults.parallelFinalTopPercent ?? "25",
    parallelFinalCandidates: option("--parallel-final-candidates") ?? option("--parallel-final-candidate-mode") ?? defaults.parallelFinalCandidates ?? "all",
    parallelSkipSelection: option("--parallel-skip-selection") ?? option("--skip-parallel-selection") ?? defaults.parallelSkipSelection ?? "best-child",
    parallelOpponentsPerRun: hasFlag("--parallel-opponents-per-run") || hasFlag("--different-opponents-per-run") || Boolean(defaults.parallelOpponentsPerRun),
    parallelOpponentDiversity: parallelOpponentDiversityMode(defaults.parallelOpponentDiversity ?? "none"),
    parallelOpponentCountPerRun: Number(option("--parallel-opponent-count-per-run") ?? defaults.parallelOpponentCountPerRun ?? option("--opponent-count") ?? 1),
    parallelChildTimeoutMinutes: Number(option("--parallel-child-timeout-minutes") ?? defaults.parallelChildTimeoutMinutes ?? 90),
    parallelChildStaleMinutes: Number(option("--parallel-child-stale-minutes") ?? defaults.parallelChildStaleMinutes ?? 20),
    decisionLogMaxCandidates: Math.max(2, Number(option("--decision-log-max-candidates") ?? defaults.decisionLogMaxCandidates ?? 24)),
    trainingDecisionLogMaxCandidates: Math.max(2, Number(option("--training-decision-log-max-candidates") ?? defaults.trainingDecisionLogMaxCandidates ?? 2)),
    skipParallelFinal: hasFlag("--skip-parallel-final") || Boolean(defaults.skipParallelFinal && !hasFlag("--no-skip-parallel-final")),
    updateParallelChildRoutedPolicies: hasFlag("--update-parallel-child-routed-policies")
      || hasFlag("--parallel-update-child-routed-policies")
      || hasFlag("--update-child-routed-policies")
      || hasFlag("--update-child-baselines")
      || Boolean(defaults.updateParallelChildRoutedPolicies)
  };
}

function actionExplorationConfig(defaults = {}, { model = null, path = null } = {}) {
  const rate = Number(option("--exploration-rate") ?? option("--action-exploration-rate") ?? defaults.explorationRate ?? DEFAULT_ACTION_EXPLORATION.rate);
  const raidNormalPlayRate = Number(
    option("--raid-normal-play-exploration-rate")
      ?? option("--raid-exploration-rate")
      ?? defaults.raidNormalPlayExplorationRate
      ?? DEFAULT_ACTION_EXPLORATION.raidNormalPlayRate
  );
  return {
    mode: option("--exploration-mode") ?? option("--action-exploration-mode") ?? defaults.explorationMode ?? DEFAULT_ACTION_EXPLORATION.mode,
    rate: clamp(rate, 0, 1),
    maxPerGame: Math.max(0, Math.floor(Number(
      option("--exploration-max-per-game")
        ?? option("--action-exploration-max-per-game")
        ?? defaults.explorationMaxPerGame
        ?? DEFAULT_ACTION_EXPLORATION.maxPerGame
    ))),
    scoreWindow: Math.max(1, Number(option("--exploration-score-window") ?? defaults.explorationScoreWindow ?? DEFAULT_ACTION_EXPLORATION.scoreWindow)),
    maxRank: Math.max(1, Number(option("--exploration-max-rank") ?? defaults.explorationMaxRank ?? DEFAULT_ACTION_EXPLORATION.maxRank)),
    minScore: Number(option("--exploration-min-score") ?? defaults.explorationMinScore ?? DEFAULT_ACTION_EXPLORATION.minScore),
    raidNormalPlayRate: clamp(raidNormalPlayRate, 0, 1),
    raidNormalPlayScoreWindow: Math.max(
      1,
      Number(option("--raid-normal-play-score-window") ?? defaults.raidNormalPlayScoreWindow ?? DEFAULT_ACTION_EXPLORATION.raidNormalPlayScoreWindow)
    ),
    raidNormalPlayHeuristicWindow: Math.max(
      1,
      Number(option("--raid-normal-play-heuristic-window") ?? defaults.raidNormalPlayHeuristicWindow ?? DEFAULT_ACTION_EXPLORATION.raidNormalPlayHeuristicWindow)
    ),
    raidNormalPlayMinHeuristicScore: Number(
      option("--raid-normal-play-min-heuristic-score")
        ?? defaults.raidNormalPlayMinHeuristicScore
        ?? DEFAULT_ACTION_EXPLORATION.raidNormalPlayMinHeuristicScore
    ),
    noveltyStrength: clamp(Number(
      option("--exploration-novelty-strength")
        ?? defaults.explorationNoveltyStrength
        ?? DEFAULT_ACTION_EXPLORATION.noveltyStrength
    ), 0, 5),
    evidence: hasFlag("--no-evidence-aware-exploration")
      || defaults.evidenceAwareExploration === false
      ? null
      : explorationEvidenceFromModel(model, path)
  };
}

function explorationEvidenceFromModel(model, path) {
  const modelSafety = explorationEvidenceModelSafety(model);
  const stats = modelSafety.accepted
    ? model?.trainingStats ?? model?.featureStats ?? {}
    : {};
  const featureObservations = Object.fromEntries(Object.entries(stats)
    .filter(([feature]) => feature.startsWith("context."))
    .map(([feature, row]) => [feature, Math.max(0, Number(row?.observations ?? row?.count ?? 0))])
    .filter(([, observations]) => Number.isFinite(observations)));
  return {
    version: 2,
    source: modelSafety.accepted ? path ?? model?.name ?? "session-bootstrap" : "session-bootstrap",
    ignoredSource: model && !modelSafety.accepted ? path ?? model?.name ?? "supplied-model" : null,
    ignoredReason: modelSafety.reason,
    targetObservations: Math.max(24, Number(model?.minContextualObservations ?? model?.featureSelection?.contextualMinObservations ?? 24)),
    featureObservations,
    featureAttempts: {},
    sessionAttempts: 0,
    sessionActionable: 0
  };
}

function explorationEvidenceModelSafety(model) {
  if (!model) return { accepted: false, reason: null };
  if (model.includeChosenAnchor === true) {
    return { accepted: false, reason: "unsafe-outcome-anchor" };
  }
  const healthStatus = String(model.learningHealth?.status ?? model.learningHealthStatus ?? "").toLowerCase();
  const samplingStatus = String(
    model.samplingSafety?.status ?? model.learningHealth?.samplingSafety?.status ?? ""
  ).toLowerCase();
  if (healthStatus === "blocked" || samplingStatus === "blocked") {
    return { accepted: false, reason: samplingStatus === "blocked" ? "blocked-sampling-safety" : "blocked-learning-health" };
  }
  if (Number(model.learningSignalVersion ?? 0) < 2) {
    return { accepted: false, reason: "legacy-learning-signal" };
  }
  return { accepted: true, reason: null };
}

function updateSessionExplorationEvidence(config, decisions, { player = "P1" } = {}) {
  const evidence = config?.evidence;
  if (!evidence || typeof evidence !== "object" || !Array.isArray(decisions)) {
    return { attempts: 0, actionable: 0, features: 0 };
  }
  evidence.featureObservations ??= {};
  evidence.featureAttempts ??= {};
  let attempts = 0;
  let actionable = 0;
  const touchedFeatures = new Set();
  for (const decision of decisions) {
    if (decision?.player !== player || !decision?.counterfactual) continue;
    const probe = decision.exploration?.mode === "counterfactual-probe";
    const evaluatedAlternativeIndex = Number(decision.counterfactual?.alternativeIndex);
    if (!Number.isInteger(evaluatedAlternativeIndex)) continue;
    if (probe) {
      const requestedAlternativeIndex = Number(decision.exploration?.alternativeIndex);
      if (!Number.isInteger(requestedAlternativeIndex) || evaluatedAlternativeIndex !== requestedAlternativeIndex) continue;
    }
    const chosen = (decision.candidates ?? []).find((candidate) => candidate.chosen);
    const alternative = (decision.candidates ?? []).find((candidate) => Number(candidate.index) === evaluatedAlternativeIndex);
    if (!chosen || !alternative) continue;
    const featureNames = new Set([
      ...Object.keys(chosen.features ?? {}),
      ...Object.keys(alternative.features ?? {})
    ]);
    const contextualDifference = [...featureNames].filter((feature) => (
      feature.startsWith("context.")
      && Number(chosen.features?.[feature] ?? 0) !== Number(alternative.features?.[feature] ?? 0)
    ));
    if (contextualDifference.length === 0) continue;
    evidence.sessionCausalComparisons = Number(evidence.sessionCausalComparisons ?? 0) + 1;
    if (probe) {
      attempts += 1;
      evidence.sessionAttempts = Number(evidence.sessionAttempts ?? 0) + 1;
    }
    for (const feature of contextualDifference) {
      evidence.featureAttempts[feature] = Number(evidence.featureAttempts[feature] ?? 0) + 1;
      if (probe) touchedFeatures.add(feature);
    }
    const preference = String(decision.counterfactual?.preference ?? "").toLowerCase();
    if (!["chosen", "selected", "action", "alternative", "other", "baseline"].includes(preference)) continue;
    evidence.sessionCausalActionable = Number(evidence.sessionCausalActionable ?? 0) + 1;
    if (probe) {
      actionable += 1;
      evidence.sessionActionable = Number(evidence.sessionActionable ?? 0) + 1;
    }
    for (const feature of contextualDifference) {
      evidence.featureObservations[feature] = Number(evidence.featureObservations[feature] ?? 0) + 1;
    }
  }
  return { attempts, actionable, features: touchedFeatures.size };
}

function counterfactualExplorationConfig(defaults = {}) {
  const rate = clamp(Number(
    option("--counterfactual-exploration-rate")
      ?? option("--counterfactual-rate")
      ?? defaults.counterfactualExplorationRate
      ?? DEFAULT_COUNTERFACTUAL_EXPLORATION.rate
  ), 0, 1);
  const setupRate = clamp(Number(
    option("--counterfactual-setup-rate")
      ?? defaults.counterfactualSetupRate
      ?? Math.min(0.15, rate * 0.35)
  ), 0, 1);
  return {
    rate,
    setupRate,
    maxPerGame: Math.max(0, Math.floor(Number(
      option("--counterfactual-max-per-game")
        ?? defaults.counterfactualMaxPerGame
        ?? DEFAULT_COUNTERFACTUAL_EXPLORATION.maxPerGame
    ))),
    rolloutMaxActions: Math.max(1, Math.floor(Number(
      option("--counterfactual-rollout-actions")
        ?? defaults.counterfactualRolloutActions
        ?? DEFAULT_COUNTERFACTUAL_EXPLORATION.rolloutMaxActions
    ))),
    rolloutMaxPlayerTurns: Math.max(1, Math.floor(Number(
      option("--counterfactual-rollout-player-turns")
        ?? defaults.counterfactualRolloutPlayerTurns
        ?? DEFAULT_COUNTERFACTUAL_EXPLORATION.rolloutMaxPlayerTurns
    ))),
    decisionWindow: DEFAULT_COUNTERFACTUAL_EXPLORATION.decisionWindow,
    phaseWeights: { ...DEFAULT_COUNTERFACTUAL_EXPLORATION.phaseWeights },
    fallbackAfterEligible: DEFAULT_COUNTERFACTUAL_EXPLORATION.fallbackAfterEligible,
    alternativeDiversityRate: DEFAULT_COUNTERFACTUAL_EXPLORATION.alternativeDiversityRate
  };
}

function finalEvaluationOptions(config) {
  return config?.actionExploration || config?.counterfactualExploration
    ? { ...config, actionExploration: null, counterfactualExploration: null }
    : config;
}

function explicitExplorationOptionSupplied() {
  const prefixes = [
    "--exploration-",
    "--action-exploration-",
    "--raid-normal-play-",
    "--raid-exploration-",
    "--counterfactual-"
  ];
  return process.argv.some((argument) => prefixes.some((prefix) => argument.startsWith(prefix)));
}

function pilotAgentPreset() {
  const raw = option("--preset") ?? option("--training-preset") ?? option("--run-preset") ?? "custom";
  const normalized = normalizeSearch(raw).replace(/\s+/g, "-");
  const aliases = new Map([
    ["none", "custom"],
    ["manual", "custom"],
    ["default", "custom"],
    ["policy", "deck"],
    ["deck-training", "deck"],
    ["base", "deck"],
    ["baseline", "deck"],
    ["matchups", "matchup"],
    ["matchup-training", "matchup"],
    ["overlay", "matchup"],
    ["overlays", "matchup"],
    ["all-baselines", "baseline-suite"],
    ["missing-baselines", "baseline-suite"],
    ["baseline-suite", "baseline-suite"]
  ]);
  const preset = aliases.get(normalized) ?? normalized;
  if (!new Set(["custom", "deck", "matchup", "baseline-suite"]).has(preset)) {
    throw new Error(`Unknown --preset: ${raw}. Use deck, matchup, baseline-suite, or custom.`);
  }
  return preset;
}

function recordTrainingGames(defaults = {}) {
  if (hasFlag("--record-training-games")) return true;
  if (hasFlag("--no-training-games")) return false;
  return defaults.recordTrainingGames ?? true;
}

function evaluatePolicy({
  catalog,
  deck,
  opponents,
  games,
  seed,
  validateDecks,
  autoMulliganBricks,
  mulliganMode = autoMulliganBricks ? "bricks" : "auto",
  maxTurns,
  maxActions,
  policy,
  opponentPolicy,
  opponentMlModel = null,
  opponentMlStrength = 1,
  pilotMatchupConfig = null,
  matchupOptions = null,
  opponentDeckFingerprints = null,
  pilotDeckFingerprint = null,
  candidateId,
  progress,
  progressContext = {},
  recordDecisions = false,
  decisionFilter = "all",
  decisionLogMaxCandidates = 24,
  chosenOnlyWithoutCounterfactual = false,
  includeGameTelemetry = false
}) {
  const rows = [];
  const decisionRows = [];
  let index = 0;
  let wins = 0;
  let losses = 0;
  let incomplete = 0;
  const normalizedPolicy = normalizePilotPolicy(policy);
  const explicitOpponentPolicy = opponentPolicy ? normalizePilotPolicy(opponentPolicy) : null;
  const totalEvaluationGames = games * opponents.length;
  const opponentFingerprints = opponentDeckFingerprints ?? matchupDeckFingerprintsForSavedDecks(opponents, catalog, matchupOptions);
  const pilotFingerprints = pilotDeckFingerprint ? [pilotDeckFingerprint] : [];

  for (const opponent of opponents) {
    const opponentPolicySelection = opponentPilotPolicyForDeck({
      opponent,
      catalog,
      explicitOpponentPolicy,
      config: matchupOptions
    });
    const selectedOpponentMlModel = opponentMlModel ?? opponentPolicySelection.mlModel ?? null;
    const normalizedOpponentPolicy = applyMlModelToPilotPolicy(
      opponentPolicySelection.policy,
      selectedOpponentMlModel,
      opponentMlStrength
    );
    const opponentMatchupConfig = matchupOverlayConfigForProfile(opponentPolicySelection.profile, matchupOptions).config;
    for (let game = 0; game < games; game += 1) {
      const firstPlayer = game % 2 === 0 ? "P1" : "P2";
      const gameSeed = seed + index;
      const simulation = createSimulationGame({
        catalog,
        decks: { P1: deck, P2: opponent.cards },
        seed: gameSeed,
        firstPlayer,
        validateDecks,
        setupMode: mulliganMode === "auto" ? "auto" : "manual"
      });
      const gameDecisions = [];
      const setupDiagnostics = {};
      const pilotCounterfactual = matchupOptions?.counterfactualExploration ?? null;
      const setupState = resolveSetupForEvaluation(simulation.state, {
        mulliganMode,
        policy: normalizedPolicy,
        opponentPolicy: normalizedOpponentPolicy,
        decisionRecorder: recordDecisions ? (decision) => gameDecisions.push(decision) : null,
        counterfactual: { P1: pilotCounterfactual, P2: null },
        maxTurns,
        matchupOverlays: {
          P1: pilotMatchupConfig,
          P2: opponentMatchupConfig
        },
        matchupDeckFingerprints: {
          P1: opponentFingerprints,
          P2: pilotFingerprints
        },
        diagnostics: setupDiagnostics
      });
      const setupCounterfactualsEvaluated = Number(setupDiagnostics.counterfactualsEvaluated ?? 0);
      const playoutCounterfactual = pilotCounterfactual
        ? {
            ...pilotCounterfactual,
            maxPerGame: Math.max(0, Number(pilotCounterfactual.maxPerGame ?? 0) - setupCounterfactualsEvaluated)
          }
        : null;
      const playout = runAutoplayGame(setupState, {
        maxTurns,
        maxActions,
        policy: {
          P1: normalizedPolicy,
          P2: normalizedOpponentPolicy
        },
        exploration: {
          P1: matchupOptions?.actionExploration ?? null,
          P2: null
        },
        counterfactual: {
          P1: playoutCounterfactual,
          P2: null
        },
        matchupOverlays: {
          P1: pilotMatchupConfig,
          P2: opponentMatchupConfig
        },
        matchupDeckFingerprints: {
          P1: opponentFingerprints,
          P2: pilotFingerprints
        },
        decisionRecorder: recordDecisions ? (decision) => gameDecisions.push(decision) : null
      });
      const explorationEvidenceUpdate = updateSessionExplorationEvidence(
        matchupOptions?.actionExploration,
        gameDecisions,
        { player: "P1" }
      );
      const result = catalogGameResult(playout.state, {
        index: index + 1,
        seed: gameSeed
      });
      if (recordDecisions) {
        decisionRows.push(...decisionRowsFromGame(gameDecisions, result, {
          index: index + 1,
          seed: gameSeed,
          opponent: opponent.id,
          candidateId,
          opponentPolicyPath: opponentPolicySelection.path,
          opponentMlModelPath: opponentMlModel ? matchupOptions?.opponentMlModelPath : opponentPolicySelection.mlModelPath,
          maxCandidates: decisionLogMaxCandidates,
          decisionFilter,
          chosenOnlyWithoutCounterfactual,
          includeGameTelemetry,
          explorationEvidenceUpdate,
          counterfactualEnabled: Number(pilotCounterfactual?.rate ?? 0) > 0
            || Number(pilotCounterfactual?.setupRate ?? 0) > 0,
          counterfactualDiagnostics: playout.counterfactualDiagnostics ?? null
        }));
      }
      if (result.winner === "P1") wins += 1;
      else if (result.winner === "P2") losses += 1;
      else incomplete += 1;
      rows.push({
        ...result,
        opponent: opponent.id,
        candidatePlayer: "P1",
        policyId: candidateId,
        opponentPolicyPath: opponentPolicySelection.path,
        opponentMlModelPath: opponentMlModel ? matchupOptions?.opponentMlModelPath : opponentPolicySelection.mlModelPath,
        playoutSteps: playout.steps,
        explorationDecisions: Number(playout.explorationDiagnostics?.total ?? 0),
        explorationProbeDecisions: Number(playout.explorationDiagnostics?.probesByPlayer?.P1 ?? 0),
        explorationActionDecisions: Number(playout.explorationDiagnostics?.actionsByPlayer?.P1 ?? 0),
        explorationEvidenceAttemptsAdded: explorationEvidenceUpdate.attempts,
        explorationEvidenceActionableAdded: explorationEvidenceUpdate.actionable,
        explorationEvidenceFeaturesAdded: explorationEvidenceUpdate.features,
        counterfactualsEvaluated: Number(playout.counterfactualsEvaluated ?? 0) + setupCounterfactualsEvaluated,
        setupCounterfactualsEvaluated,
        playoutStoppedReason: playout.stoppedReason,
        playoutFailureCode: playout.failureDiagnostics?.candidateFailures?.[0]?.code ?? "",
        playoutFailureMessage: playout.failureDiagnostics?.candidateFailures?.[0]?.message ?? "",
        playoutFailureDiagnostics: playout.failureDiagnostics
          ? JSON.stringify(playout.failureDiagnostics)
          : ""
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
    decisionRows,
    summary: summarizeRows(rows)
  };
}

function evaluatePolicyAcrossDecks({
  catalog,
  decks,
  opponents,
  games,
  seed,
  validateDecks,
  autoMulliganBricks,
  mulliganMode = autoMulliganBricks ? "bricks" : "auto",
  maxTurns,
  maxActions,
  policy,
  opponentPolicy,
  opponentMlModel = null,
  opponentMlStrength = 1,
  pilotMatchupConfig = null,
  matchupOptions = null,
  opponentDeckFingerprints = null,
  candidateId,
  progress,
  progressContext = {},
  recordDecisions = false,
  decisionFilter = "all",
  decisionLogMaxCandidates = 24,
  chosenOnlyWithoutCounterfactual = false,
  includeGameTelemetry = false
}) {
  const rows = [];
  const decisionRows = [];
  for (let deckIndex = 0; deckIndex < decks.length; deckIndex += 1) {
    const pilotDeck = decks[deckIndex];
    const deckGameCount = games * opponents.length;
    const evaluation = evaluatePolicy({
      catalog,
      deck: pilotDeck.cards,
      opponents,
      games,
      seed: seed + deckIndex * 10_000_000,
      validateDecks,
      autoMulliganBricks,
      mulliganMode,
      maxTurns,
      maxActions,
      policy,
      opponentPolicy,
      opponentMlModel,
      opponentMlStrength,
      pilotMatchupConfig,
      matchupOptions,
      opponentDeckFingerprints,
      pilotDeckFingerprint: matchupDeckFingerprintForSavedDeck(pilotDeck, catalog, matchupOptions),
      candidateId,
      progress,
      progressContext: {
        ...progressContext,
        generationGameOffset: Number(progressContext.generationGameOffset ?? 0) + deckIndex * deckGameCount
      },
      recordDecisions,
      decisionFilter,
      decisionLogMaxCandidates,
      chosenOnlyWithoutCounterfactual,
      includeGameTelemetry
    });
    rows.push(...evaluation.rows.map((row) => ({
      ...row,
      pilotDeck: pilotDeck.id,
      pilotDeckName: pilotDeck.name
    })));
    decisionRows.push(...evaluation.decisionRows.map((row) => ({
      ...row,
      pilotDeck: pilotDeck.id,
      pilotDeckName: pilotDeck.name
    })));
  }

  return {
    rows,
    decisionRows,
    summary: summarizeRows(rows)
  };
}

function mulliganMode(defaults = {}) {
  if (hasFlag("--pilot-mulligan") || hasFlag("--agent-mulligan")) return "pilot";
  if (hasFlag("--auto-mulligan-bricks")) return "bricks";
  if (defaults.pilotMulligan) return "pilot";
  if (defaults.autoMulliganBricks) return "bricks";
  return "auto";
}

function resolveSetupForEvaluation(state, {
  mulliganMode,
  policy,
  opponentPolicy,
  decisionRecorder = null,
  counterfactual = null,
  maxTurns = 100,
  matchupOverlays = null,
  matchupDeckFingerprints = null,
  diagnostics = null
}) {
  if (mulliganMode === "pilot") {
    return resolvePilotSetup(
      state,
      { P1: policy, P2: opponentPolicy ?? policy },
      {
        decisionRecorder,
        counterfactual,
        maxTurns,
        matchupOverlays,
        matchupDeckFingerprints,
        diagnostics
      }
    );
  }
  if (mulliganMode === "bricks") return resolveBrickMulligans(state);
  return state;
}

function resolveBrickMulligans(state) {
  let nextState = state;
  for (const playerId of ["P1", "P2"]) {
    const actionType = analyzeSetupHand(nextState, playerId).initialBricked ? "mulligan" : "keepHand";
    nextState = applyAction(nextState, { type: actionType, player: playerId });
  }
  return nextState;
}

function decisionRowsFromGame(decisions, result, context) {
  const p1LifeDiff = Number(result.p1LifeRemaining ?? 0) - Number(result.p2LifeRemaining ?? 0);
  const turnCycles = Number(result.turnCyclesTaken ?? Math.ceil(Number(result.turnsTaken ?? 0) / 2));
  const scopedDecisions = context.decisionFilter === "exploration"
    ? decisions.filter((decision) => Boolean(decision.exploration || decision.counterfactual))
    : decisions;
  const filteredDecisions = scopedDecisions.filter((decision) => Number(decision.candidates?.length ?? 0) > 1);
  const credit = learningCreditByDecision(filteredDecisions, result);
  const decisionRows = filteredDecisions.flatMap((decision) => {
    const playerLifeDiff = decision.player === "P1" ? p1LifeDiff : -p1LifeDiff;
    const outcome = result.winner === decision.player
      ? "win"
      : result.winner ? "loss" : "incomplete";
    const reward = outcome === "win" ? 1 : outcome === "loss" ? -1 : 0;
    const shapedReward = reward === 0
      ? 0
      : clamp(reward + clamp(playerLifeDiff / 7, -1, 1) * 0.2, -1.2, 1.2);
    const chosenCandidate = decision.candidates.find((candidate) => candidate.chosen) ?? decision.candidates[decision.chosenIndex] ?? null;
    const chosenHeuristicScore = Number(chosenCandidate?.score ?? 0);
    const bestHeuristicScore = Math.max(...decision.candidates.map((candidate) => Number(candidate.score ?? -Infinity)));
    const sortedCandidates = [...decision.candidates]
      .sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0) || Number(a.index ?? 0) - Number(b.index ?? 0))
    const rankedCandidates = new Map(sortedCandidates.map((candidate, index) => [candidate.index, index + 1]));
    const exactAlternativeIndex = Number.isInteger(decision.counterfactual?.alternativeIndex)
      ? decision.counterfactual.alternativeIndex
      : null;
    const maxCandidates = context.chosenOnlyWithoutCounterfactual && exactAlternativeIndex === null
      ? 1
      : Math.max(2, Number(context.maxCandidates ?? 24));
    const loggedCandidates = selectDecisionLogCandidates(decision.candidates, {
      maxCandidates,
      counterfactualAlternativeIndex: exactAlternativeIndex,
      requiredCandidateFilter: importantLearningOpportunityCandidate,
      maxRequiredCandidates: 2
    });
    const candidateActionFamilies = [...new Set(decision.candidates.map((candidate) => (
      pairwiseActionFamily(candidate)
    )))].sort((left, right) => left.localeCompare(right));
    const decisionKey = [
      context.candidateId ?? "candidate",
      context.index,
      decision.player,
      decision.step
    ].join(":");
    const learningCredit = credit.get(decision) ?? {
      eligible: false,
      weight: 0,
      ordinal: 0,
      playerDecisionCount: 0,
      eligibleDecisionCount: 0
    };
    return loggedCandidates.map((candidate) => ({
      schema: "union-arena-local-engine/pilot-decision@1",
      decisionKey,
      gameIndex: context.index,
      seed: context.seed,
      opponent: context.opponent,
      candidateId: context.candidateId,
      step: decision.step,
      player: decision.player,
      phase: decision.state.phase,
      turnCyclesAtDecision: decision.state.turnCyclesTaken,
      playerLifeAtDecision: decision.state.playerLife,
      opponentLifeAtDecision: decision.state.opponentLife,
      playerFrontAtDecision: decision.state.playerFront,
      opponentFrontAtDecision: decision.state.opponentFront,
      playerEnergyAtDecision: decision.state.playerEnergy,
      opponentEnergyAtDecision: decision.state.opponentEnergy,
      matchupProfileKey: decision.matchupProfile?.key ?? "unknown",
      matchupConfidence: Number(decision.matchupProfile?.confidence ?? 0),
      matchupEvidenceCount: Number(decision.matchupProfile?.evidenceCount ?? 0),
      matchupObservedLowCostCardIds: decision.matchupProfile?.observedLowCostCardIds ?? [],
      matchupDeckCandidateId: decision.matchupProfile?.deckCandidateId ?? null,
      matchupDeckCandidateName: decision.matchupProfile?.deckCandidateName ?? null,
      matchupDeckCandidateConfidence: Number(decision.matchupProfile?.deckCandidateConfidence ?? 0),
      matchupVariantKey: decision.matchupProfile?.variantKey ?? decision.matchupProfile?.key ?? "unknown",
      matchupVariantStatus: decision.matchupProfile?.variantStatus ?? "unknown",
      matchupVariantConfidence: Number(decision.matchupProfile?.variantConfidence ?? 0),
      matchupVariantSignature: decision.matchupProfile?.variantSignature ?? null,
      matchupVariantCardIds: decision.matchupProfile?.variantCardIds ?? [],
      matchupVariantReason: decision.matchupProfile?.variantReason ?? null,
      matchupOverlayPath: decision.matchupOverlayPath ?? null,
      actionIndex: candidate.index,
      candidateCount: decision.candidates.length,
      loggedCandidateCount: loggedCandidates.length,
      candidatesTruncated: loggedCandidates.length < decision.candidates.length,
      chosen: candidate.chosen,
      policyRank: rankedCandidates.get(candidate.index) ?? candidate.index + 1,
      actionType: candidate.action.type,
      action: candidate.action,
      candidateActionFamilies: candidate.chosen ? candidateActionFamilies : undefined,
      heuristicScore: candidate.score,
      chosenHeuristicScore,
      bestHeuristicScore: Number.isFinite(bestHeuristicScore) ? bestHeuristicScore : chosenHeuristicScore,
      scoreDeltaFromChosen: Number(candidate.score ?? 0) - chosenHeuristicScore,
      scoreDeltaFromBest: Number(candidate.score ?? 0) - (Number.isFinite(bestHeuristicScore) ? bestHeuristicScore : chosenHeuristicScore),
      chosenScoreGapFromBest: (Number.isFinite(bestHeuristicScore) ? bestHeuristicScore : chosenHeuristicScore) - chosenHeuristicScore,
      learningSignalVersion: 2,
      learningEligible: learningCredit.eligible,
      creditWeight: Number(learningCredit.weight.toFixed(6)),
      creditPhase: learningCredit.phase ?? decision.state.phase ?? "unknown",
      phaseDecisionCount: Number(learningCredit.phaseDecisionCount ?? 0),
      phaseCreditPrior: Number(learningCredit.phasePrior ?? 0),
      playerCreditBudget: Number(learningCredit.creditBudget ?? 0),
      decisionOrdinal: learningCredit.ordinal,
      playerDecisionCount: learningCredit.playerDecisionCount,
      eligibleDecisionCount: learningCredit.eligibleDecisionCount,
      explorationReason: decision.exploration?.reason ?? null,
      explorationMode: decision.exploration?.mode ?? null,
      explorationSelectionMode: decision.exploration?.selectionMode ?? null,
      explorationEvidenceStatus: decision.exploration?.evidenceStatus ?? null,
      explorationEvidenceObservations: Number.isFinite(Number(decision.exploration?.evidenceObservations))
        ? Number(decision.exploration.evidenceObservations)
        : null,
      explorationEvidenceAttempts: Number.isFinite(Number(decision.exploration?.evidenceAttempts))
        ? Number(decision.exploration.evidenceAttempts)
        : null,
      explorationEvidenceTarget: Number.isFinite(Number(decision.exploration?.evidenceTarget))
        ? Number(decision.exploration.evidenceTarget)
        : null,
      explorationEvidenceFeatures: decision.exploration?.evidenceFeatures ?? [],
      explorationNoveltyMultiplier: Number.isFinite(Number(decision.exploration?.noveltyMultiplier))
        ? Number(decision.exploration.noveltyMultiplier)
        : null,
      counterfactualPreference: decision.counterfactual?.preference ?? null,
      counterfactualAdvantage: Number(decision.counterfactual?.advantage ?? 0),
      counterfactualConfidence: Number(decision.counterfactual?.confidence ?? 0),
      counterfactualEvidenceKind: decision.counterfactual?.evidenceKind ?? null,
      counterfactualStateEvaluationVersion: Number(decision.counterfactual?.stateEvaluationVersion ?? 0) || null,
      counterfactualChosenEvaluation: decision.counterfactual?.chosenEvaluation ?? null,
      counterfactualAlternativeEvaluation: decision.counterfactual?.alternativeEvaluation ?? null,
      counterfactualRolloutHorizon: decision.counterfactual?.rolloutHorizon ?? null,
      counterfactualChosenStoppedReason: decision.counterfactual?.chosenStoppedReason ?? null,
      counterfactualAlternativeStoppedReason: decision.counterfactual?.alternativeStoppedReason ?? null,
      counterfactualTargetPhase: decision.counterfactual?.targetPhase ?? null,
      counterfactualDecisionPhase: decision.counterfactual?.decisionPhase ?? null,
      counterfactualPhaseEligibleOrdinal: Number.isInteger(decision.counterfactual?.phaseEligibleOrdinal)
        ? decision.counterfactual.phaseEligibleOrdinal
        : null,
      counterfactualTargetPhaseOrdinal: Number.isInteger(decision.counterfactual?.targetPhaseOrdinal)
        ? decision.counterfactual.targetPhaseOrdinal
        : null,
      counterfactualFallbackUsed: Boolean(decision.counterfactual?.fallbackUsed),
      counterfactualInformationScore: Number(decision.counterfactual?.informationScore ?? 0),
      counterfactualInformationReason: decision.counterfactual?.informationReason ?? null,
      counterfactualSamplingReason: decision.counterfactual?.samplingReason ?? null,
      counterfactualAlternativeIndex: Number.isInteger(decision.counterfactual?.alternativeIndex)
        ? decision.counterfactual.alternativeIndex
        : null,
      counterfactualAlternativeSelection: decision.counterfactual?.alternativeSelection ?? null,
      counterfactualAlternativeAction: decision.counterfactual?.alternativeAction ?? null,
      counterfactualChosenWinner: decision.counterfactual?.chosenWinner ?? null,
      counterfactualAlternativeWinner: decision.counterfactual?.alternativeWinner ?? null,
      outcome,
      reward,
      shapedReward,
      finalLifeDiffForPlayer: playerLifeDiff,
      finalTurnCycles: turnCycles,
      features: candidate.features
    }));
  });
  if (!context.includeGameTelemetry) return decisionRows;
  return [learningGameTelemetryRow(decisions, result, context), ...decisionRows];
}

function learningGameTelemetryRow(decisions, result, context) {
  const player = "P1";
  const choiceDecisions = decisions.filter((decision) => (
    decision.player === player && Number(decision.candidates?.length ?? 0) > 1
  ));
  const counterfactualDecisions = choiceDecisions.filter((decision) => Boolean(decision.counterfactual));
  const explorationDecisions = choiceDecisions.filter((decision) => Boolean(decision.exploration));
  const explorationEvidenceFeatureKeys = [...new Set(explorationDecisions
    .flatMap((decision) => decision.exploration?.evidenceFeatures ?? [])
    .map((feature) => String(feature))
    .filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
  const counterfactualHorizons = counterfactualDecisions
    .map((decision) => decision.counterfactual?.rolloutHorizon)
    .filter(Boolean);
  const actionableCounterfactuals = counterfactualDecisions.filter((decision) => {
    const preference = String(decision.counterfactual?.preference ?? "").toLowerCase();
    return (preference === "chosen" || preference === "alternative")
      && Number.isInteger(decision.counterfactual?.alternativeIndex);
  }).length;
  const unsynchronizedCounterfactuals = counterfactualDecisions.filter((decision) => (
    String(decision.counterfactual?.evidenceKind ?? "").includes("unsynchronized-horizon")
  )).length;
  const outcome = result.winner === player
    ? "win"
    : result.winner ? "loss" : "incomplete";
  return {
    schema: LEARNING_GAME_TELEMETRY_SCHEMA,
    recordType: "learning-game",
    gameIndex: context.index,
    seed: context.seed,
    opponent: context.opponent,
    candidateId: context.candidateId,
    player,
    outcome,
    complete: outcome !== "incomplete",
    decisionOpportunities: choiceDecisions.length,
    explorationDecisions: explorationDecisions.length,
    explorationProbeDecisions: explorationDecisions.filter((decision) => decision.exploration?.mode === "counterfactual-probe").length,
    explorationActionDecisions: explorationDecisions.filter((decision) => decision.exploration?.mode !== "counterfactual-probe").length,
    explorationCoverageGapDecisions: explorationDecisions.filter((decision) => decision.exploration?.selectionMode === "coverage-gap").length,
    explorationEvidenceAwareDecisions: explorationDecisions.filter((decision) => decision.exploration?.selectionMode === "evidence-aware").length,
    explorationScoreWeightedDecisions: explorationDecisions.filter((decision) => decision.exploration?.selectionMode === "score-weighted").length,
    explorationPreviouslyAttemptedDecisions: explorationDecisions.filter((decision) => (
      Number(decision.exploration?.evidenceAttempts ?? 0) > 0
    )).length,
    explorationUnseenDecisions: explorationDecisions.filter((decision) => decision.exploration?.evidenceStatus === "unseen").length,
    explorationEvidenceFeatureKeys,
    explorationEvidenceAttemptsAdded: Number(context.explorationEvidenceUpdate?.attempts ?? 0),
    explorationEvidenceActionableAdded: Number(context.explorationEvidenceUpdate?.actionable ?? 0),
    explorationEvidenceFeaturesAdded: Number(context.explorationEvidenceUpdate?.features ?? 0),
    counterfactualEnabled: Boolean(context.counterfactualEnabled),
    counterfactualsEvaluated: counterfactualDecisions.length,
    actionableCounterfactuals,
    counterfactualTies: counterfactualDecisions.length - actionableCounterfactuals,
    unsynchronizedCounterfactuals,
    counterfactualAdaptiveDecisions: counterfactualHorizons.filter((horizon) => horizon.adaptive).length,
    counterfactualAdaptiveEarlyStops: counterfactualHorizons.filter((horizon) => horizon.earlyStopped).length,
    counterfactualAdaptiveAuditEligible: counterfactualHorizons.filter((horizon) => horizon.earlyStopEligible).length,
    counterfactualAdaptiveAudits: counterfactualHorizons.filter((horizon) => horizon.adaptiveAuditPerformed).length,
    counterfactualAdaptiveAuditAgreements: counterfactualHorizons.filter((horizon) => (
      horizon.adaptiveAuditPerformed && horizon.adaptiveAuditAgreement === true
    )).length,
    counterfactualAdaptiveAuditDisagreements: counterfactualHorizons.filter((horizon) => (
      horizon.adaptiveAuditPerformed && horizon.adaptiveAuditAgreement === false
    )).length,
    counterfactualRequestedPlayerTurns: counterfactualHorizons.reduce((total, horizon) => (
      total + Math.max(0, Number(horizon.requestedPlayerTurnBudget ?? horizon.playerTurnBudget ?? 0))
    ), 0),
    counterfactualEvaluatedPlayerTurns: counterfactualHorizons.reduce((total, horizon) => (
      total + Math.max(0, Number(horizon.evaluatedPlayerTurnBudget ?? horizon.playerTurnBudget ?? 0))
    ), 0),
    counterfactualEstimatedPlayerTurnsSaved: counterfactualHorizons.reduce((total, horizon) => (
      total + Math.max(0, Number(horizon.estimatedPlayerTurnsSaved ?? 0))
    ), 0),
    counterfactualLowInformationSkips: Number(context.counterfactualDiagnostics?.lowInformationSkips ?? 0)
  };
}

function importantLearningOpportunityCandidate(candidate) {
  return positiveFeature(candidate?.features, "playRaidCardNormally");
}

function positiveFeature(features = {}, feature) {
  const value = Number(features?.[feature] ?? 0);
  return Number.isFinite(value) && value > 0;
}

function learningCreditByDecision(decisions, result) {
  const credits = new Map();
  const complete = result.winner === "P1" || result.winner === "P2";
  for (const playerId of ["P1", "P2"]) {
    const playerDecisions = decisions.filter((decision) => decision.player === playerId);
    for (const [decision, credit] of allocateDecisionCredits(playerDecisions, { complete })) credits.set(decision, credit);
  }
  return credits;
}

function shouldRecordDecisions(config, scope) {
  const mode = config.decisionLogMode ?? "none";
  if (mode === "none") return false;
  if (mode === "all") return true;
  if (mode === "learning") return scope === "training" || scope === "final" || scope === "parallel-final";
  if (mode === "training") return scope === "training";
  if (mode === "final") return scope === "final";
  if (mode === "parallel-final") return scope === "parallel-final";
  return false;
}

function decisionLoggingOptions(config, scope) {
  const mode = config.decisionLogMode ?? "none";
  return {
    recordDecisions: shouldRecordDecisions(config, scope),
    decisionFilter: mode === "learning" && scope === "training" ? "exploration" : "all",
    chosenOnlyWithoutCounterfactual: mode === "learning",
    includeGameTelemetry: mode === "learning" && scope === "training",
    decisionLogMaxCandidates: scope === "training"
      ? config.trainingDecisionLogMaxCandidates ?? 2
      : config.decisionLogMaxCandidates ?? 24
  };
}

function decisionLogMode(defaults = {}) {
  const rawValue = option("--decision-log-mode") ?? option("--record-decision-mode");
  if (!rawValue && !hasFlag("--record-decisions") && !hasFlag("--record-decision-log") && !defaults.recordDecisions) return "none";
  const raw = normalizeSearch(rawValue ?? defaults.decisionLogMode ?? "final").replace(/\s+/g, "-");
  const aliases = new Map([
    ["off", "none"],
    ["false", "none"],
    ["no", "none"],
    ["none", "none"],
    ["final", "final"],
    ["finals", "final"],
    ["parallel-final", "parallel-final"],
    ["parallel-finals", "parallel-final"],
    ["parent-final", "parallel-final"],
    ["parent-finals", "parallel-final"],
    ["evaluate", "final"],
    ["evaluation", "final"],
    ["training", "training"],
    ["train", "training"],
    ["learning", "learning"],
    ["efficient", "learning"],
    ["all", "all"],
    ["everything", "all"]
  ]);
  const mode = aliases.get(raw) ?? raw;
  if (!new Set(["none", "final", "parallel-final", "training", "learning", "all"]).has(mode)) {
    throw new Error(`Unknown --decision-log-mode: ${raw}. Use none, final, parallel-final, training, learning, or all.`);
  }
  return mode;
}

function loadOptionalMlModel(path) {
  if (!path) return null;
  if (!existsSync(path)) throw new Error(`ML action model not found: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function applyMlModelToPilotPolicy(policy, model, strength = 1) {
  if (!model) return normalizePilotPolicy(policy);
  return blendPilotPolicyWithMlModel(policy, model, { strength });
}

function policyForStorage(effectivePolicy, config, name) {
  if (!config?.mlModel) return { ...normalizePilotPolicy(effectivePolicy), name };
  return removeMlModelFromPilotPolicy(effectivePolicy, config.mlModel, {
    strength: config.mlStrength,
    name
  });
}

function matchupOverlayConfigForProfile(profile, config = {}) {
  if (!config?.matchupOverlaysEnabled || !profile) {
    return {
      config: null,
      summary: {
        enabled: false,
        profile: profile ?? null,
        count: 0,
        paths: []
      }
    };
  }
  const overlays = loadMatchupOverlaysForProfile(profile, {
    policyDir: config.policyDir ?? DEFAULT_POLICY_DIR,
    baselineRoot: config.baselineRoot
  });
  const paths = Object.values(overlays).map((entry) => entry.path);
  return {
    config: {
      enabled: paths.length > 0,
      strength: config.matchupOverlayStrength ?? 1,
      minConfidence: config.matchupMinConfidence ?? 0.7,
      knownDeckVariants: config.matchupKnownDeckVariants === true,
      variantMinDeckConfidence: config.matchupVariantMinDeckConfidence ?? 0.55,
      variantMinObservedCoverage: config.matchupVariantMinObservedCoverage ?? 0.75,
      unknownVariantMinEvidence: config.matchupUnknownVariantMinEvidence ?? 4,
      overlays
    },
    summary: {
      enabled: paths.length > 0,
      profile,
      count: paths.length,
      minConfidence: config.matchupMinConfidence ?? 0.7,
      strength: config.matchupOverlayStrength ?? 1,
      knownDeckVariants: config.matchupKnownDeckVariants === true,
      variantMinDeckConfidence: config.matchupVariantMinDeckConfidence ?? 0.55,
      variantMinObservedCoverage: config.matchupVariantMinObservedCoverage ?? 0.75,
      unknownVariantMinEvidence: config.matchupUnknownVariantMinEvidence ?? 4,
      paths
    }
  };
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
  const nonLossRate = winRate;
  const incompleteRate = total === 0 ? 0 : incomplete / total;
  const avgLifeDiff = average(rows, (row) => row.p1LifeRemaining - row.p2LifeRemaining);
  const avgTurns = average(rows, (row) => row.turnsTaken);
  const avgTurnCycles = average(rows, (row) => row.turnCyclesTaken ?? Math.ceil((row.turnsTaken ?? 0) / 2));
  const avgWinTurnCycles = average(rows.filter((row) => row.winner === "P1"), (row) => row.turnCyclesTaken ?? Math.ceil((row.turnsTaken ?? 0) / 2));
  const longGameRate = average(rows, (row) => (row.turnCyclesTaken ?? Math.ceil((row.turnsTaken ?? 0) / 2)) > 8 ? 1 : 0);
  const brickRate = average(rows, (row) => row.p1Bricked ? 1 : 0);
  const mulliganRate = average(rows, (row) => row.p1Mulliganed ? 1 : 0);
  const explorationGameRate = average(rows, (row) => Number(row.explorationDecisions ?? 0) > 0 ? 1 : 0);
  const explorationProbeGameRate = average(rows, (row) => Number(row.explorationProbeDecisions ?? 0) > 0 ? 1 : 0);
  const explorationActionGameRate = average(rows, (row) => Number(row.explorationActionDecisions ?? 0) > 0 ? 1 : 0);
  const score = pilotPerformanceScore({ total, wins, incomplete, avgLifeDiff });

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
    avgTurnCycles,
    avgWinTurnCycles,
    longGameRate,
    brickRate,
    mulliganRate,
    explorationGameRate,
    explorationProbeGameRate,
    explorationActionGameRate,
    scoreVersion: PILOT_PERFORMANCE_SCORE_VERSION,
    score
  };
}

function combineSummaries(summaries) {
  const valid = summaries.filter((summary) => summary && Number(summary.total ?? 0) > 0);
  if (valid.length === 0) return null;

  const total = valid.reduce((sum, summary) => sum + Number(summary.total ?? 0), 0);
  const wins = valid.reduce((sum, summary) => sum + Number(summary.wins ?? 0), 0);
  const losses = valid.reduce((sum, summary) => sum + Number(summary.losses ?? 0), 0);
  const incomplete = valid.reduce((sum, summary) => sum + Number(summary.incomplete ?? 0), 0);
  const avgLifeDiff = weightedAverage(valid, (summary) => Number(summary.avgLifeDiff ?? 0), (summary) => Number(summary.total ?? 0));
  const avgTurns = weightedAverage(valid, (summary) => Number(summary.avgTurns ?? 0), (summary) => Number(summary.total ?? 0));
  const avgTurnCycles = weightedAverage(valid, (summary) => Number(summary.avgTurnCycles ?? 0), (summary) => Number(summary.total ?? 0));
  const avgWinTurnCycles = weightedAverage(valid, (summary) => Number(summary.avgWinTurnCycles ?? 0), (summary) => Number(summary.wins ?? 0));
  const longGameRate = weightedAverage(valid, (summary) => Number(summary.longGameRate ?? 0), (summary) => Number(summary.total ?? 0));
  const brickRate = weightedAverage(valid, (summary) => Number(summary.brickRate ?? 0), (summary) => Number(summary.total ?? 0));
  const mulliganRate = weightedAverage(valid, (summary) => Number(summary.mulliganRate ?? 0), (summary) => Number(summary.total ?? 0));
  const explorationGameRate = weightedAverage(valid, (summary) => Number(summary.explorationGameRate ?? 0), (summary) => Number(summary.total ?? 0));
  const explorationProbeGameRate = weightedAverage(valid, (summary) => Number(summary.explorationProbeGameRate ?? 0), (summary) => Number(summary.total ?? 0));
  const explorationActionGameRate = weightedAverage(valid, (summary) => Number(summary.explorationActionGameRate ?? 0), (summary) => Number(summary.total ?? 0));

  return scoreSummary({
    total,
    wins,
    losses,
    incomplete,
    avgLifeDiff,
    avgTurns,
    avgTurnCycles,
    avgWinTurnCycles,
    longGameRate,
    brickRate,
    mulliganRate,
    explorationGameRate,
    explorationProbeGameRate,
    explorationActionGameRate
  });
}

function scoreSummary(summary) {
  const total = Number(summary.total ?? 0);
  const wins = Number(summary.wins ?? 0);
  const losses = Number(summary.losses ?? 0);
  const incomplete = Number(summary.incomplete ?? Math.max(0, total - wins - losses));
  const winRate = total === 0 ? 0 : wins / total;
  const nonLossRate = winRate;
  const incompleteRate = total === 0 ? 0 : incomplete / total;
  const avgLifeDiff = Number(summary.avgLifeDiff ?? 0);
  const avgTurns = Number(summary.avgTurns ?? 0);
  const avgTurnCycles = Number(summary.avgTurnCycles ?? 0);
  const avgWinTurnCycles = Number(summary.avgWinTurnCycles ?? 0);
  const longGameRate = Number(summary.longGameRate ?? 0);
  const brickRate = Number(summary.brickRate ?? 0);
  const mulliganRate = Number(summary.mulliganRate ?? 0);
  const explorationGameRate = Number(summary.explorationGameRate ?? 0);
  const explorationProbeGameRate = Number(summary.explorationProbeGameRate ?? 0);
  const explorationActionGameRate = Number(summary.explorationActionGameRate ?? 0);
  const score = pilotPerformanceScore({ total, wins, incomplete, avgLifeDiff });

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
    avgTurnCycles,
    avgWinTurnCycles,
    longGameRate,
    brickRate,
    mulliganRate,
    explorationGameRate,
    explorationProbeGameRate,
    explorationActionGameRate,
    scoreVersion: PILOT_PERFORMANCE_SCORE_VERSION,
    score
  };
}

function seedPolicyPopulation(startingPolicy, rng, {
  populationSize,
  mutationScale,
  mutationRate,
  mutationGroupsPerChild,
  mutationMaxFeatures
}) {
  const population = [normalizePilotPolicy(startingPolicy)];
  const seen = new Set(population.map(policySignature));
  while (population.length < populationSize) {
    const child = mutatePolicy(startingPolicy, rng, {
      mutationScale,
      mutationRate,
      mutationGroupsPerChild,
      mutationMaxFeatures
    });
    const signature = policySignature(child);
    if (seen.has(signature)) continue;
    seen.add(signature);
    population.push(child);
  }
  return population;
}

function mutatePolicy(policy, rng, {
  mutationScale,
  mutationRate,
  mutationGroupsPerChild = 2,
  mutationMaxFeatures = 12
}) {
  const normalized = normalizePilotPolicy(policy);
  const mutation = mutatePilotPolicyWeights(normalized.weights, rng, {
    mutationScale,
    mutationRate,
    groupsPerChild: mutationGroupsPerChild,
    maxFeatures: mutationMaxFeatures
  });
  return {
    schema: DEFAULT_PILOT_POLICY.schema,
    name: "mutated-policy",
    weights: mutation.weights
  };
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

function buildReport({
  mode,
  config,
  deck,
  opponents,
  bestPolicy,
  rankings,
  games,
  trainingGames = [],
  decisionLog = [],
  baselineSummary,
  promotionComparison = null
}) {
  const printableConfig = {
    ...config,
    actionExploration: printableActionExploration(config.actionExploration),
    catalog: undefined,
    mlModel: undefined,
    opponentMlModel: undefined
  };
  delete printableConfig.catalog;
  delete printableConfig.mlModel;
  delete printableConfig.opponentMlModel;
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
    promotionComparison,
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
    trainingGames,
    decisionLog
  };
}

function printableActionExploration(config) {
  if (!config) return config;
  const evidence = config.evidence;
  const observations = Object.values(evidence?.featureObservations ?? {}).map(Number).filter(Number.isFinite);
  const attempts = Object.values(evidence?.featureAttempts ?? {}).map(Number).filter(Number.isFinite);
  return {
    ...config,
    evidence: evidence ? {
      version: Number(evidence.version ?? 1),
      source: evidence.source ?? null,
      ignoredSource: evidence.ignoredSource ?? null,
      ignoredReason: evidence.ignoredReason ?? null,
      targetObservations: Number(evidence.targetObservations ?? 24),
      contextualFeatures: observations.length,
      evidenceObservations: observations.reduce((total, value) => total + value, 0),
      graduatedFeatures: observations.filter((value) => value >= Number(evidence.targetObservations ?? 24)).length,
      attemptedContextualFeatures: attempts.length,
      sessionAttempts: Number(evidence.sessionAttempts ?? 0),
      sessionActionable: Number(evidence.sessionActionable ?? 0)
    } : null
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
  if (summary.avgTurnCycles > 0 && summary.avgTurnCycles <= 7.5) positives.push(`Average game length was in a realistic range at ${summary.avgTurnCycles.toFixed(2)} turn cycles.`);
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
  if (summary.longGameRate > 0.25) negatives.push(`${formatPercent(summary.longGameRate)} of games lasted more than 8 turn cycles, which can signal low-pressure piloting or stalled boards.`);
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
    openingHandSignals: describePilotPolicy(bestPolicy)
      .filter((item) => item.feature.startsWith("setup"))
      .sort((a, b) => Math.abs(b.deltaFromBaseline) - Math.abs(a.deltaFromBaseline)
        || Math.abs(b.weight) - Math.abs(a.weight)
        || a.feature.localeCompare(b.feature))
      .slice(0, 16),
    combatAbilitySignals: describePilotPolicy(bestPolicy)
      .filter((item) => isCombatAbilitySignal(item.feature))
      .sort((a, b) => Math.abs(b.deltaFromBaseline) - Math.abs(a.deltaFromBaseline)
        || Math.abs(b.weight) - Math.abs(a.weight)
        || a.feature.localeCompare(b.feature))
      .slice(0, 24),
    positives: positives.length > 0 ? positives : ["No strong positive signal yet; this run is mainly a baseline for later pilot training."],
    negatives: negatives.length > 0 ? negatives : ["No major warning appeared in this run, though more games can still change the result."],
    recommendations
  };
}

function isCombatAbilitySignal(feature) {
  return feature.startsWith("attack")
    || feature.startsWith("snipe")
    || feature.startsWith("block")
    || feature.startsWith("decline")
    || feature.startsWith("ability")
    || feature.startsWith("role");
}

function writePilotReport(outDir, report) {
  mkdirSync(outDir, { recursive: true });
  const { decisionLog = [], ...publicReport } = report;
  writeJsonFileSync(join(outDir, "best-policy.json"), report.bestPolicy);
  writePilotReportJson(outDir, publicReport);
  writeTextArtifact(outDir, "analysis.md", () => analysisMarkdown(report.analysis));
  writeTextArtifact(outDir, "rankings.csv", () => csvFromRows(report.rankings.map(flattenRow)));
  writeTextArtifact(outDir, "games.csv", () => csvFromRows(report.games.map(flattenRow)));
  if (decisionLog.length > 0) {
    writeArtifactFailureSafe(outDir, "decision-log.jsonl", () => writeJsonLinesFileSync(join(outDir, "decision-log.jsonl"), decisionLog));
  }
  if (report.trainingGames?.length > 0) {
    writeTextArtifact(outDir, "training-games.csv", () => csvFromRows(report.trainingGames.map(flattenRow)));
  }
}

function writePilotReportJson(outDir, publicReport) {
  try {
    writeJsonFileSync(join(outDir, "report.json"), publicReport);
  } catch (error) {
    writeJsonFileSync(join(outDir, "report-write-error.json"), artifactError(error, "report.json"));
    writeJsonFileSync(join(outDir, "report.json"), compactReportAfterWriteFailure(publicReport, error));
  }
}

function writeTextArtifact(outDir, name, buildText) {
  writeArtifactFailureSafe(outDir, name, () => {
    writeFileSync(join(outDir, name), buildText());
  });
}

function writeArtifactFailureSafe(outDir, name, writeFn) {
  try {
    writeFn();
  } catch (error) {
    writeJsonFileSync(join(outDir, `${name}.write-error.json`), artifactError(error, name));
  }
}

function writeJsonFileSync(path, value) {
  writeJsonAtomicSync(path, value);
}

function artifactError(error, artifact) {
  return {
    schema: "union-arena-local-engine/pilot-artifact-error@1",
    artifact,
    createdAt: new Date().toISOString(),
    message: error?.message ?? String(error),
    name: error?.name ?? "Error",
    stack: typeof error?.stack === "string" ? error.stack.split(/\r?\n/).slice(0, 12).join("\n") : null
  };
}

function compactReportAfterWriteFailure(report, error) {
  return {
    schema: report?.schema ?? "union-arena-local-engine/pilot-agent-report@1",
    compactAfterWriteFailure: true,
    createdAt: report?.createdAt ?? new Date().toISOString(),
    writeFailure: artifactError(error, "report.json"),
    mode: report?.mode ?? null,
    config: report?.config ?? null,
    deck: report?.deck ?? null,
    opponents: report?.opponents ?? [],
    bestPolicy: report?.bestPolicy ?? null,
    baselineSummary: report?.baselineSummary ?? null,
    result: report?.result ?? null,
    analysis: compactAnalysisForManifest(report?.analysis),
    rankings: Array.isArray(report?.rankings) ? report.rankings.slice(0, 40) : [],
    gameCount: Array.isArray(report?.games) ? report.games.length : 0,
    gamesSample: Array.isArray(report?.games) ? report.games.slice(0, 20) : [],
    trainingGameCount: Array.isArray(report?.trainingGames) ? report.trainingGames.length : 0
  };
}

function writeJsonLinesFileSync(path, rows) {
  const fd = openSync(path, "w");
  let buffer = "";
  try {
    for (const row of rows) {
      buffer += `${JSON.stringify(row)}\n`;
      if (buffer.length >= 1_000_000) {
        writeSync(fd, buffer);
        buffer = "";
      }
    }
    if (buffer.length > 0) writeSync(fd, buffer);
  } finally {
    closeSync(fd);
  }
}

function writeUpdatePolicyOption(report) {
  const rawPath = option("--update-policy");
  const path = resolvePolicyPath(rawPath);
  const decision = rawPath
    ? policyPromotionDecision(report)
    : {
      promote: false,
      reason: "no --update-policy supplied",
      candidateScore: Number(report.result?.score ?? 0),
      baselineScore: Number(report.baselineSummary?.score ?? 0)
    };
  writeJsonAtomicSync(join(report.config.outDir, "policy-promotion.json"), decision);
  if (!path) return;
  if (!decision.promote) {
    console.log(`Did not update reusable policy at ${path}: ${decision.reason}`);
    return;
  }

  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const previousPath = join(report.config.outDir, "previous-policy.json");
    copyFileSync(path, previousPath);
    console.log(`Saved previous reusable policy at ${previousPath}`);
  }
  writeJsonAtomicSync(path, normalizePilotPolicy(report.bestPolicy));
  console.log(`Updated reusable policy at ${path}`);
}

function writeRoutedPolicyOption(report) {
  const selection = report.config.policySelection;
  if (!selection?.routed || !selection.profile) return;
  const enabled = report.config?.routedPolicyUpdatesEnabled === true;

  const decision = !enabled
    ? {
      promote: false,
      reason: "routed policy updates are disabled for this preset/run",
      candidateScore: Number(report.result?.score ?? 0),
      baselineScore: Number(report.baselineSummary?.score ?? 0),
      specialistPath: selection.specialistPath,
      profile: selection.profile
    }
    : {
      ...policyPromotionDecision(report),
      specialistPath: selection.specialistPath,
      profile: selection.profile
    };
  writeJsonAtomicSync(join(report.config.outDir, "routed-policy-promotion.json"), decision);
  if (!enabled) return;
  if (!decision.promote) {
    console.log(`Did not update routed policy at ${selection.specialistPath}: ${decision.reason}`);
    return;
  }

  const policyDir = report.config?.policyDir ?? option("--policy-dir") ?? DEFAULT_POLICY_DIR;
  const baselineRoot = report.config?.baselineRoot ?? option("--baseline-root");
  const path = writePolicyForProfile(report.bestPolicy, selection.profile, {
    policyDir,
    baselineRoot
  });
  writeBaselineOriginForProfile(routedPromotionOriginArtifact({ report, decision, path, selection }), selection.profile, {
    policyDir,
    baselineRoot
  });
  console.log(`Updated routed policy at ${path}`);
}

function routedPromotionOriginArtifact({ report, decision, path, selection }) {
  const forced = String(decision.reason ?? "").startsWith("forced");
  const noBaseline = decision.baselineScore === null || decision.baselineScore === undefined;
  return {
    schema: "union-arena-local-engine/baseline-origin@1",
    createdAt: new Date().toISOString(),
    deckId: report.deck?.id ?? report.config?.policySelection?.profile?.deckId ?? null,
    deckName: report.deck?.name ?? null,
    ownKey: selection.profile?.key ?? null,
    specialistPath: selection.specialistPath,
    promotionType: forced ? "forced" : noBaseline ? "initial-trained" : "improved",
    quality: "trained",
    missingSpecialist: selection.foundSpecialist === false,
    validatedImprovement: Boolean(decision.promote && !forced && !noBaseline),
    acceptedForLearning: true,
    needsTraining: false,
    reason: decision.reason,
    candidateScore: decision.candidateScore,
    baselineScore: decision.baselineScore,
    promotionQuality: decision.promotionQuality ?? null,
    promotionComparison: decision.comparison ?? report.promotionComparison ?? null,
    margin: decision.margin ?? null,
    writtenSource: "run-best-policy",
    writtenPath: path,
    policyName: report.bestPolicy?.name ?? null,
    reportPath: join(report.config.outDir, "report.json"),
    profile: selection.profile
  };
}

function policyPromotionDecision(report) {
  if (hasFlag("--force-update-policy")) {
    return {
      promote: true,
      reason: "forced by --force-update-policy",
      candidateScore: Number(report.result?.score ?? 0),
      baselineScore: Number(report.baselineSummary?.score ?? 0)
    };
  }

  if (report.config?.parallelFinalSkipped && !hasFlag("--allow-skip-final-policy-promotion")) {
    return {
      promote: false,
      reason: "parallel final comparison was skipped; rerun with --parallel-final-games or pass --allow-skip-final-policy-promotion",
      candidateScore: Number(report.result?.score ?? 0),
      baselineScore: Number(report.baselineSummary?.score ?? 0)
    };
  }

  const quality = promotionQualityForSummary(report.result, { initialBaseline: !report.baselineSummary });
  if (!quality.ok) {
    return {
      promote: false,
      reason: quality.reason,
      candidateScore: Number(report.result?.score ?? 0),
      baselineScore: report.baselineSummary ? Number(report.baselineSummary.score ?? 0) : null,
      promotionQuality: quality
    };
  }

  if (!report.baselineSummary) {
    return {
      promote: true,
      reason: "no baseline was available",
      candidateScore: Number(report.result?.score ?? 0),
      baselineScore: null,
      promotionQuality: quality
    };
  }

  const margin = Number(option("--policy-promotion-margin") ?? 0);
  const evidence = promotionEvidenceGate({
    candidateSummary: report.result,
    baselineSummary: report.baselineSummary,
    comparison: report.promotionComparison,
    margin,
    requirePaired: !report.config?.parallelFinalSkipped
  });
  return {
    ...evidence,
    promotionQuality: quality
  };
}

function promotionQualityForSummary(summary, { initialBaseline = false } = {}) {
  const minGames = Math.max(0, Number(option("--min-promotion-games") ?? 8));
  const maxIncompleteRate = clamp(Number(option("--max-promotion-incomplete-rate") ?? 0.2), 0, 1);
  const minInitialWinRate = clamp(Number(option("--min-initial-promotion-win-rate") ?? 0.05), 0, 1);
  return promotionQualityGate(summary, {
    initialBaseline,
    minGames,
    maxIncompleteRate,
    minInitialWinRate
  });
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
    `- Average turn cycles: ${analysis.summary.avgTurnCycles.toFixed(2)}`,
    `- Average winning turn cycles: ${analysis.summary.avgWinTurnCycles.toFixed(2)}`,
    `- Long game rate: ${formatPercent(analysis.summary.longGameRate)}`,
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
    ...analysis.learnedWeightDeltas.slice(0, 20).map((item) => `- ${item.feature}: ${signed(item.deltaFromBaseline)} (weight ${item.weight})`),
    "",
    "## Opening Hand Signals",
    "",
    ...analysis.openingHandSignals.map((item) => `- ${item.feature}: ${signed(item.deltaFromBaseline)} (weight ${item.weight})`),
    "",
    "## Combat And Ability Signals",
    "",
    ...analysis.combatAbilitySignals.map((item) => `- ${item.feature}: ${signed(item.deltaFromBaseline)} (weight ${item.weight})`)
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
  const raw = option(flag);
  if (isRoutedPolicyValue(raw)) return null;
  if (isDefaultPolicyValue(raw)) return normalizePilotPolicy(DEFAULT_PILOT_POLICY);
  const path = resolvePolicyPath(raw);
  if (!path) return null;
  if (!existsSync(path)) {
    const initHint = flag === "--policy"
      ? " If this is your first run, remove --policy and add --update-policy with this same path so the run can create it."
      : "";
    throw new Error(`Policy file not found: ${path}.${initHint}`);
  }
  return normalizePilotPolicy(JSON.parse(readFileSync(path, "utf8")));
}

function loadStartingPolicyForDeck(deck, config, { createIfMissing = false } = {}) {
  const explicit = loadPolicyOption("--policy");
  if (explicit) {
    const basePolicy = normalizePilotPolicy(explicit);
    const explicitPath = isDefaultPolicyValue(option("--policy"))
      ? "default"
      : resolvePolicyPath(option("--policy"));
    return {
      basePolicy,
      policy: applyMlModelToPilotPolicy(basePolicy, config.mlModel, config.mlStrength),
      summary: {
        mode: "explicit",
        path: explicitPath,
        routed: false,
        storedPolicyLayer: "base-policy-without-ml",
        mlModelPath: config.mlModelPath,
        mlStrength: config.mlStrength
      }
    };
  }

  const policyDir = config.policyDir ?? option("--policy-dir") ?? DEFAULT_POLICY_DIR;
  const baselineRoot = config.baselineRoot ?? option("--baseline-root");
  const fallbackPolicyPath = resolvePolicyPath(option("--fallback-policy") ?? "current");
  const routed = resolvePolicyForDeck({
    deck: deck.cards,
    catalog: config.catalog,
    savedDeck: deck.raw,
    deckId: deck.id,
    policyDir,
    baselineRoot,
    fallbackPolicyPath,
    deckLibrary: config.libraryDir
  });
  const specialistPath = policyPathForProfile(routed.profile, { policyDir, baselineRoot });
  let createdPath = null;
  if (createIfMissing && !routed.foundSpecialist && !hasFlag("--no-create-routed-policy")) {
    createdPath = ensurePolicyForProfile(routed.policy, routed.profile, { policyDir, baselineRoot });
    writeBaselineOriginForProfile(implicitBaselineSeedOrigin({
      deck,
      routed,
      specialistPath,
      createdPath
    }), routed.profile, { policyDir, baselineRoot });
  }

  const basePolicy = normalizePilotPolicy(routed.policy);

  return {
    basePolicy,
    policy: applyMlModelToPilotPolicy(basePolicy, config.mlModel, config.mlStrength),
    summary: {
      mode: "routed",
      routed: true,
      foundSpecialist: routed.foundSpecialist,
      selectedKind: routed.kind,
      selectedPath: routed.path,
      specialistPath,
      createdPath,
      storedPolicyLayer: "base-policy-without-ml",
      mlModelPath: config.mlModelPath,
      mlStrength: config.mlStrength,
      profile: routed.profile
    }
  };
}

function implicitBaselineSeedOrigin({ deck, routed, specialistPath, createdPath }) {
  return {
    schema: "union-arena-local-engine/baseline-origin@1",
    createdAt: new Date().toISOString(),
    deckId: deck?.id ?? null,
    deckName: deck?.name ?? null,
    ownKey: routed?.profile?.key ?? null,
    specialistPath,
    promotionType: "implicit-seed",
    quality: "seed",
    missingSpecialist: true,
    validatedImprovement: false,
    acceptedForLearning: false,
    needsTraining: true,
    reason: "missing routed policy was initialized from the selected fallback/default policy before training",
    selectedKind: routed?.kind ?? null,
    selectedPath: routed?.path ?? null,
    writtenSource: routed?.kind === "fallback" ? "fallback-policy" : "default-policy",
    writtenPath: createdPath,
    policyName: routed?.policy?.name ?? null,
    profile: routed?.profile ?? null
  };
}

function opponentPilotPolicyForDeck({ opponent, catalog, explicitOpponentPolicy, config = {} }) {
  if (explicitOpponentPolicy) {
    return {
      policy: explicitOpponentPolicy,
      path: "explicit",
      kind: "explicit",
      foundSpecialist: true,
      mlModel: null,
      mlModelPath: null
    };
  }

  const policyDir = config?.policyDir ?? option("--policy-dir") ?? DEFAULT_POLICY_DIR;
  const baselineRoot = config?.baselineRoot ?? option("--baseline-root");
  const routed = resolvePolicyForDeck({
    deck: opponent.cards,
    catalog,
    savedDeck: opponent.raw,
    deckId: opponent.id,
    policyDir,
    baselineRoot,
    fallbackPolicyPath: resolvePolicyPath(option("--fallback-policy") ?? "current"),
    deckLibrary: option("--library") ?? DEFAULT_LIBRARY
  });
  const mlSelection = config?.opponentProfileMlEnabled === false
    ? { model: null, path: null }
    : loadOpponentProfileMlModel(routed.profile, config);
  return {
    policy: routed.policy,
    path: routed.path,
    kind: routed.kind,
    foundSpecialist: routed.foundSpecialist,
    profile: routed.profile,
    mlModel: mlSelection.model,
    mlModelPath: mlSelection.path
  };
}

function loadOpponentProfileMlModel(profile, config = {}) {
  const agentRoot = config?.agentRoot ?? option("--agent-root") ?? DEFAULT_AGENT_ROOT;
  const baselineRoot = config?.baselineRoot ?? option("--baseline-root");
  const profileKeys = [...new Set([profile?.key, profile?.setColorKey].filter(Boolean))];
  const candidates = [
    ...profileKeys.flatMap((key) => actionModelCandidatePathsForKey(key, { agentRoot, baselineRoot })),
    join(agentRoot, "current-action-model.json")
  ].filter(Boolean);
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const model = JSON.parse(readFileSync(path, "utf8"));
      if (mlActionModelRuntimeTrust(model) <= 0) continue;
      return {
        path,
        model
      };
    } catch {
      // Keep looking; a corrupt action model should not disable routed policy fallback.
    }
  }
  return { path: null, model: null };
}

function resolvePolicyPath(value) {
  if (!value) return null;
  const normalized = normalizeSearch(value);
  if (["current", "current best", "current policy", "champion", "best"].includes(normalized)) {
    return CURRENT_POLICY_PATH;
  }
  return value;
}

function isRoutedPolicyValue(value) {
  if (!value) return false;
  return ["auto", "routed", "route", "deck", "deck policy", "specialist"].includes(normalizeSearch(value));
}

function isDefaultPolicyValue(value) {
  if (!value) return false;
  return ["default", "engine default", "baseline default", "fresh"].includes(normalizeSearch(value));
}

function selectOpponents(libraryDir, fallbackDeckId, seed, { opponentSeedOverride } = {}) {
  const mode = opponentMode();
  if (mode === "explicit") {
    const text = opponentsText();
    if (!text) throw new Error("Explicit opponent mode needs --opponents deck-a,deck-b or --opponents-file path.");
    const ids = opponentIdsFromText(text);
    const opponentSeed = Number(opponentSeedOverride ?? option("--opponent-seed") ?? seed + 9176);
    const requestedCount = Number(option("--opponent-count") ?? 0);
    const selectedIds = chooseExplicitOpponentIds(ids, {
      count: requestedCount,
      seed: opponentSeed
    });
    return selectedOpponents({
      libraryDir,
      mode,
      ids: selectedIds,
      seed: opponentSeed,
      summaryExtra: {
        source: option("--opponents-file") ? option("--opponents-file") : "--opponents",
        availableExplicitDecks: ids.length,
        requestedCount: requestedCount || null
      }
    });
  }

  if (hasExplicitOpponentList()) {
    throw new Error(`--opponents and --opponents-file can only be used with explicit opponent mode, not ${mode}.`);
  }

  if (mode === "mirror") {
    return selectedOpponents({
      libraryDir,
      mode,
      ids: [fallbackDeckId],
      seed,
      summaryExtra: { source: "selected deck" }
    });
  }

  const regionalCandidates = readSavedDeckIndex(libraryDir)
    .filter((deck) => deck.isRegional)
    .filter((deck) => hasFlag("--opponent-include-self") || deck.id !== fallbackDeckId);
  let candidates = regionalCandidates;
  const requestedRegions = optionList("--regions", "--regionals", "--opponent-regions");

  if (mode === "regional") {
    if (requestedRegions.length === 0) {
      const locations = uniqueSorted(regionalCandidates.map((deck) => deck.location).filter(Boolean));
      throw new Error(`Regional opponent mode needs --regions "Peoria Illinois,Virginia". Available regions: ${locations.join(", ")}`);
    }
    candidates = candidates.filter((deck) => matchesRequestedRegion(deck.location, requestedRegions));
  } else if (requestedRegions.length > 0) {
    candidates = candidates.filter((deck) => matchesRequestedRegion(deck.location, requestedRegions));
  }

  candidates = applyOpponentFilters(candidates);

  const opponentSeed = Number(opponentSeedOverride ?? option("--opponent-seed") ?? seed + 9176);
  const requestedCount = Number(option("--opponent-count") ?? (mode === "random" ? 8 : 0));
  const ids = chooseOpponentIds(candidates, {
    mode,
    count: requestedCount,
    seed: opponentSeed
  });

  return selectedOpponents({
    libraryDir,
    mode,
    ids,
    seed: opponentSeed,
    summaryExtra: {
      availableRegionalDecks: regionalCandidates.length,
      candidateDecks: candidates.length,
      requestedCount: requestedCount || null,
      regions: requestedRegions,
      filters: opponentFilterSummary()
    }
  });
}

function selectedOpponents({ libraryDir, mode, ids, seed, summaryExtra = {} }) {
  if (ids.length === 0) throw new Error(`Opponent mode ${mode} did not select any decks.`);
  const opponents = ids.map((id) => loadSavedDeck(libraryDir, id));
  return {
    opponents,
    summary: {
      mode,
      seed,
      selectedCount: opponents.length,
      selectedIds: opponents.map((opponent) => opponent.id),
      ...summaryExtra
    }
  };
}

function opponentMode() {
  const explicit = option("--opponent-mode") ?? option("--opponents-mode");
  if (explicit) return normalizeOpponentMode(explicit);

  const opponentsValue = option("--opponents");
  if (opponentsValue && isOpponentModeKeyword(opponentsValue)) return normalizeOpponentMode(opponentsValue);
  if (hasExplicitOpponentList()) return "explicit";
  return "mirror";
}

function normalizeOpponentMode(value) {
  const normalized = normalizeSearch(value).replace(/\s+/g, "-");
  const aliases = new Map([
    ["list", "explicit"],
    ["ids", "explicit"],
    ["manual", "explicit"],
    ["self", "mirror"],
    ["self-play", "mirror"],
    ["all", "all-regionals"],
    ["all-regional", "all-regionals"],
    ["all-regionals", "all-regionals"],
    ["regional-all", "all-regionals"],
    ["regionals", "all-regionals"]
  ]);
  const mode = aliases.get(normalized) ?? normalized;
  const allowed = new Set(["explicit", "mirror", "random", "regional", "all-regionals"]);
  if (!allowed.has(mode)) {
    throw new Error(`Unknown opponent mode: ${value}. Use explicit, mirror, random, regional, or all-regionals.`);
  }
  return mode;
}

function isOpponentModeKeyword(value) {
  try {
    normalizeOpponentMode(value);
    return true;
  } catch {
    return false;
  }
}

function hasExplicitOpponentList() {
  const opponentsValue = option("--opponents");
  return Boolean(option("--opponents-file") || opponentsValue && !isOpponentModeKeyword(opponentsValue));
}

function opponentIdsFromText(text) {
  return text.split(/[,\r\n]+/)
    .map((id) => id.trim())
    .filter((id) => id && !id.startsWith("#"));
}

function chooseOpponentIds(candidates, { mode, count, seed }) {
  if (candidates.length === 0) throw new Error(`Opponent mode ${mode} has no candidate decks after filters.`);
  const sorted = [...candidates].sort(compareOpponentDecks);
  if (mode !== "random" && (!count || count >= sorted.length)) return sorted.map((deck) => deck.id);

  const rng = makeRng(seed);
  const shuffled = [...sorted];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  const limit = count > 0 ? Math.min(count, shuffled.length) : shuffled.length;
  return shuffled.slice(0, limit).map((deck) => deck.id);
}

function chooseExplicitOpponentIds(ids, { count, seed }) {
  const clean = [...new Set(ids.filter(Boolean))];
  const requested = Number(count ?? 0);
  if (!requested || requested >= clean.length) return clean;
  const rng = makeRng(seed);
  const shuffled = [...clean];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled.slice(0, Math.max(1, requested));
}

function applyOpponentFilters(decks) {
  let candidates = decks;
  const top = Number(option("--opponent-top") ?? 0);
  if (top > 0) {
    candidates = candidates.filter((deck) => deck.placement !== null && deck.placement <= top);
  }

  const colors = optionList("--opponent-color", "--opponent-colors").map(normalizeSearch);
  if (colors.length > 0) {
    candidates = candidates.filter((deck) => deck.colors.some((color) => colors.includes(normalizeSearch(color))));
  }

  const sets = optionList("--opponent-set", "--opponent-sets").map(normalizeSearch);
  if (sets.length > 0) {
    candidates = candidates.filter((deck) => sets.some((set) => deck.searchText.includes(set)));
  }

  return candidates;
}

function opponentFilterSummary() {
  return {
    top: Number(option("--opponent-top") ?? 0) || null,
    colors: optionList("--opponent-color", "--opponent-colors"),
    sets: optionList("--opponent-set", "--opponent-sets")
  };
}

function matchesRequestedRegion(location, requestedRegions) {
  const locationText = normalizeSearch(location);
  return requestedRegions.some((region) => {
    const terms = normalizeSearch(region).split(/\s+/).filter(Boolean);
    return terms.length > 0 && terms.every((term) => locationText.includes(term));
  });
}

function compareOpponentDecks(a, b) {
  return (a.location ?? "").localeCompare(b.location ?? "")
    || Number(a.placement ?? 9999) - Number(b.placement ?? 9999)
    || a.name.localeCompare(b.name)
    || a.id.localeCompare(b.id);
}

function printOpponentSelection(selection) {
  const label = selection.regions?.length > 0 ? ` (${selection.regions.join(", ")})` : "";
  console.log(`Selected ${selection.selectedCount} opponent deck(s) with ${selection.mode} mode${label}.`);
}

function optionList(...flags) {
  return flags.flatMap((flag) => {
    const value = option(flag);
    if (!value) return [];
    return value.split(/[,\r\n]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  });
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
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
        return deckIndexEntry(raw, join(libraryDir, file));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function deckIndexEntry(raw, path) {
  const source = raw.source ?? {};
  const summary = raw.summary ?? {};
  const validation = raw.validation ?? {};
  const archetypeResolution = resolveArchetypeProfile({
    deck: raw.cards,
    savedDeck: raw,
    deckId: raw.id,
    deckLibrary: dirname(path)
  });
  const profile = archetypeResolution.profile;
  const colors = [
    ...new Set([
      ...(profile.colors ?? []),
      ...(Array.isArray(summary.colors) ? summary.colors : []),
      summary.color
    ].filter(Boolean))
  ];
  const placement = Number(source.placement);
  const searchText = normalizeSearch([
    raw.id,
    raw.name,
    source.player,
    source.location,
    source.event,
    source.deckType,
    profile.key,
    profile.setColorKey,
    validation.sourceCode,
    summary.sourceCode,
    ...(Array.isArray(summary.sourceCodes) ? summary.sourceCodes : []),
    ...colors
  ].filter(Boolean).join(" "));

  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    path,
    isRegional: raw.id.startsWith("regional-") || Boolean(source.location || source.manifestPath),
    location: source.location ?? null,
    event: source.event ?? null,
    eventDate: source.eventDate ?? null,
    player: source.player ?? null,
    placement: Number.isFinite(placement) ? placement : null,
    deckType: source.deckType ?? null,
    colors,
    sourceCode: profile.sourceCode ?? validation.sourceCode ?? summary.sourceCode ?? null,
    ownKey: profile.key,
    setColorKey: profile.setColorKey,
    archetypeResolution: profile.archetypeResolution,
    searchText
  };
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

function opponentsText() {
  const file = option("--opponents-file");
  if (file) return readFileSync(file, "utf8");
  const opponentsValue = option("--opponents");
  return opponentsValue && !isOpponentModeKeyword(opponentsValue) ? opponentsValue : undefined;
}

function loadSavedDeck(libraryDir, id) {
  const path = join(libraryDir, `${id}.json`);
  if (!existsSync(path)) throw new Error(`Saved deck not found: ${path}`);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return {
    id: raw.id ?? id,
    name: raw.name ?? id,
    path,
    raw,
    summary: raw.summary ?? null,
    validation: raw.validation ?? null,
    cards: loadDeckJson(path)
  };
}

function matchupDeckFingerprintsForSavedDecks(decks, catalog, config = {}) {
  if (config?.deckInferenceEnabled === false) return [];
  return decks
    .map((deck) => matchupDeckFingerprintForSavedDeck(deck, catalog, config))
    .filter(Boolean);
}

function matchupDeckFingerprintForSavedDeck(deck, catalog, config = {}) {
  if (config?.deckInferenceEnabled === false || !deck?.cards) return null;
  const resolution = resolveArchetypeProfile({
    deck: deck.cards,
    catalog,
    savedDeck: deck.raw,
    deckId: deck.id,
    deckLibrary: config.libraryDir ?? dirname(deck.path ?? DEFAULT_LIBRARY)
  });
  const profile = resolution.profile;
  const cardCounts = Object.fromEntries(normalizeDeckList(deck.cards)
    .map((entry) => [entry.id, Number(entry.count ?? 1)])
    .filter(([id, count]) => id && count > 0));
  const totalCards = Object.values(cardCounts).reduce((total, count) => total + count, 0);
  if (totalCards === 0) return null;
  return {
    id: deck.id,
    name: deck.name ?? deck.id,
    key: profile.key,
    setColorKey: profile.setColorKey,
    sourceCode: profile.sourceCode,
    colors: profile.colors,
    colorKey: profile.colorKey,
    archetypeResolution: profile.archetypeResolution,
    cardCounts,
    totalCards
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

function weightedAverage(rows, valueFn, weightFn) {
  const totalWeight = rows.reduce((total, row) => total + Math.max(0, Number(weightFn(row) ?? 0)), 0);
  if (totalWeight === 0) return 0;
  return rows.reduce((total, row) => {
    const weight = Math.max(0, Number(weightFn(row) ?? 0));
    return total + Number(valueFn(row) ?? 0) * weight;
  }, 0) / totalWeight;
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
  console.log(`Average turn cycles: ${summary.avgTurnCycles.toFixed(2)}`);
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

function writeFailureFileFromError(error) {
  const outDir = option("--out-dir");
  if (!outDir) return;
  try {
    mkdirSync(outDir, { recursive: true });
    writeJsonFileSync(join(outDir, "failure.json"), {
      schema: "union-arena-local-engine/pilot-agent-failure@1",
      createdAt: new Date().toISOString(),
      command,
      message: error?.message ?? String(error),
      name: error?.name ?? "Error",
      stack: typeof error?.stack === "string" ? error.stack.split(/\r?\n/).slice(0, 20).join("\n") : null
    });
  } catch {
    // The console error remains the fallback if the failure artifact cannot be written.
  }
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function usage() {
  console.log(`Usage:
  node tools/pilot-agent.mjs train --preset matchup --deck carnerr-spear --opponent-mode random --opponent-count 20 --opponent-set RNK --opponent-color red
  node tools/pilot-agent.mjs train --preset deck --deck carnerr-spear --opponent-mode random --opponent-count 20
  node tools/pilot-agent.mjs train --preset baseline-suite --parallel-decks missing-baselines --opponent-mode random --opponent-count 84
  node tools/pilot-agent.mjs evaluate [--deck deck-id] --opponent-mode random --opponent-count 8 [--policy path] [--games 50]
  node tools/pilot-agent.mjs train [--deck deck-id] --opponent-mode regional --regions "Peoria Illinois,Virginia" [--generations 4] [--population 8] [--games 12]
  node tools/pilot-agent.mjs train --deck deck-id --opponent-mode random --opponent-count 8 --parallel-runs 4 --parallel-concurrency 4
  node tools/pilot-agent.mjs train --deck deck-id --opponents opp-a,opp-b --seed 1001 --out-dir work/private/pilot-agent/runs/session-1001

Leave out --deck to choose from a numbered list of saved decks before the run starts.

Presets:
  --preset matchup       Current matchup-learning path: 14 parallel runs, one opponent archetype per child, pilot mulligan, final decision logs, no routed baseline promotion, skips the master parallel-final.
  --preset deck          Current deck-baseline path: 14 parallel runs, small final comparison, pilot mulligan, final decision logs, routed baseline promotion enabled.
  --preset baseline-suite Multi-deck missing-baseline path for All Baselines.
  --preset custom        Legacy/manual behavior. Add explicit low-level flags as needed.

Opponent modes:
  --opponent-mode explicit      Use --opponents deck-a,deck-b or --opponents-file path. This is also the default when those are supplied.
  --opponent-mode mirror        Self-play against the selected deck. This is the default with no opponent options.
  --opponent-mode random        Sample regional decks. Use --opponent-count N, default 8.
  --opponent-mode regional      Use regionals named by --regions "Peoria Illinois,Orlando Florida".
  --opponent-mode all-regionals Use every saved regional deck, with optional filters.

Opponent filters:
  --opponent-count 8
  --regions "Peoria Illinois,Virginia"
  --opponent-top 16
  --opponent-color purple
  --opponent-set SLG
  --opponent-seed 1234
  --opponent-include-self

Useful options:
  --auto-mulligan-bricks
  --pilot-mulligan
  --policy current
  --opponent-policy current
  --baseline-root work/private/pilot-agent/baselines
  --progress-minutes 2
  --progress-seconds 30
  --no-progress
  --no-training-games
  --record-decisions
  --explore-evaluation
  --decision-log-mode learning|final|parallel-final|training|all|none
  --decision-log-max-candidates 24
  --training-decision-log-max-candidates 2
  --ml-model work/private/pilot-agent/current-action-model.json
  --ml-strength 0.5
  --opponent-ml-model work/private/pilot-agent/current-action-model.json
  --no-opponent-profile-ml
  --ml-model-all
  --matchup-overlay-strength 1
  --matchup-min-confidence 0.7
  --matchup-variant-min-deck-confidence 0.55
  --matchup-variant-min-coverage 0.75
  --matchup-unknown-min-evidence 4
  --no-matchup-overlays
  --no-deck-inference
  --final-games 50
  --parallel-runs 4
  --parallel-concurrency 4
  --parallel-final-games 100
  --parallel-final-top-percent 25
  --parallel-final-candidates all|merged-baseline|best-baseline|best-merged-baseline
  --no-skip-parallel-final
  --skip-parallel-final
  --parallel-skip-selection best-child|merged
  --parallel-opponents-per-run
  --parallel-opponent-diversity set-color|deck|none
  --parallel-opponent-count-per-run 1
  --parallel-child-timeout-minutes 90
  --parallel-child-stale-minutes 20
  --parallel-opponent-seed 1234
  --parallel-decks deck-a,deck-b
  --parallel-decks missing-baselines
  --parallel-decks-file path/to/deck-ids.txt
  --parallel-deck-mode round-robin
  --parallel-deck-prefix carnerr-,engine-
  --parallel-deck-seed 1234
  --update-parallel-child-routed-policies
  --force-update-child-routed-policies
  --child-seed 1234
  --random-child-seeds
  --update-policy work/private/pilot-agent/current-best-policy.json
  --policy-promotion-margin 0
  --min-promotion-games 8
  --max-promotion-incomplete-rate 0.2
  --min-initial-promotion-win-rate 0.05
  --allow-skip-final-policy-promotion
  --force-update-policy
  --dry-run
  --mutation-scale 80
  --mutation-rate 0.35
  --mutation-groups-per-child 2
  --mutation-max-features 12
  --exploration-mode counterfactual-probe|action
  --exploration-rate 0.02
  --exploration-max-per-game 1
  --exploration-score-window 220
  --exploration-max-rank 8
  --exploration-min-score -300
  --raid-normal-play-exploration-rate 0.34
  --raid-normal-play-score-window 1200
  --raid-normal-play-heuristic-window 1400
  --raid-normal-play-min-heuristic-score -200
  --counterfactual-exploration-rate 0.4
  --counterfactual-setup-rate 0.14
  --counterfactual-max-per-game 1
  --counterfactual-rollout-actions 64
  --counterfactual-rollout-player-turns 3
  --max-turns 80
  --max-actions 1000

Outputs:
  report.json
  best-policy.json
  analysis.md
  rankings.csv
  games.csv
  training-games.csv
  decision-log.jsonl

Parallel train also writes:
  parallel-runs.json
  parallel-child-processes.json
  runs/run-01/
  runs/run-02/`);
}
