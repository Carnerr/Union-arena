#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { restoreDirectorySnapshotSync, writeJsonAtomicSync, writeTextAtomicSync } from "../src/artifact-io.js";
import {
  blendPilotPolicyWithMlModel,
  mlActionModelRuntimeTrust,
  normalizePilotPolicy,
  stampMatchupOverlayImpactValidation
} from "../src/index.js";
import { knowledgeArtifactValidationPlan, provisionalActionLearningEligible } from "../src/learning-signals.js";
import {
  pilotAgentPresetDefaults as sharedAgentPresetDefaults,
  pilotTrainingModeDefaults as sharedTrainingModeDefaults
} from "../src/pilot-training-presets.js";
import {
  actionModelCandidatePathsForKey,
  actionModelPathForKey,
  baselineDeckDirForKey,
  baselinePolicyPathForKey,
  matchupOverlayCandidatePathForKeys,
  policyKeySegment as routePolicyKeySegment
} from "../src/policy-router.js";

const DEFAULT_AGENT_ROOT = "work/private/pilot-agent";
const DEFAULT_POLICY_DIR = "work/private/pilot-agent/policies";
const DEFAULT_RUNS_ROOT = "work/private/pilot-agent/runs";

if (hasFlag("--help")) {
  usage();
  process.exit(0);
}

const config = readConfig();
mkdirSync(config.outRoot, { recursive: true });

if (config.promoteFrom) {
  promotePolicyFromRun(config.promoteFrom, config);
}

const state = {
  schema: "union-arena-local-engine/pilot-loop-overseer@1",
  startedAt: new Date().toISOString(),
  config: publicConfig(config),
  cycles: [],
  stopReason: null
};

writeJsonAtomicSync(join(config.outRoot, "launch-plan.json"), launchPlan(config));

maybeBootstrapBaseline(config, state);

for (let cycleIndex = 0; cycleIndex < config.cycles; cycleIndex += 1) {
  const cycleNumber = cycleIndex + 1;
  const seed = config.seed + cycleIndex * config.seedStep;
  const cycleLabel = `cycle-${String(cycleNumber).padStart(2, "0")}`;
  const runDir = join(config.runsRoot, `${config.session}-${cycleLabel}`);
  const knowledgeDir = join(config.outRoot, cycleLabel, "knowledge");
  const matchupValidationDir = join(config.outRoot, cycleLabel, "matchup-validation");
  const handoffPath = join(config.outRoot, cycleLabel, "handoff.md");
  mkdirSync(join(config.outRoot, cycleLabel), { recursive: true });
  let matchupValidationBeforeBaselineRoot = null;
  const trainingBeforeBaselineRoot = !config.dryRun
    ? snapshotMatchupValidationBaseline(config, join(config.outRoot, cycleLabel, "training-rollback"))
    : null;

  console.log(`\n=== Pilot loop ${cycleLabel}/${config.cycles} ===`);
  console.log(`Run dir: ${runDir}`);
  console.log(`Knowledge evidence: ${config.cumulativeKnowledge ? "current run plus accepted-cycle replay" : "current run only (incremental artifacts retain prior learning)"}.`);

  const trainArgs = trainArgsForCycle(config, { seed, runDir });
  const trainCommand = commandText(trainArgs);
  writeTextAtomicSync(join(config.outRoot, cycleLabel, "train-command.ps1"), `${trainCommand}\n`);
  state.currentCycle = {
    cycle: cycleNumber,
    seed,
    runDir,
    status: "training",
    startedAt: new Date().toISOString(),
    trainCommand
  };
  writeState(config.outRoot, state);

  const trainResult = runNodeCommand("training", trainArgs, { dryRun: config.dryRun });
  if (trainResult.status !== 0) {
    const trainingFailureRollback = !config.dryRun
      ? rollbackMatchupValidationBaseline(config, trainingBeforeBaselineRoot, null, {
          reason: `Training subprocess failed in ${cycleLabel}; restored the pre-cycle profile before retry or shutdown.`,
          context: "training failure"
        })
      : null;
    const failed = {
      cycle: cycleNumber,
      seed,
      runDir,
      trainCommand,
      trainResult,
      trainingFailureRollback,
      stopDecision: {
        type: "training-failed",
        stopNow: true,
        cycle: cycleNumber,
        reason: `Training failed in ${cycleLabel}.`
      }
    };
    state.currentCycle = { ...state.currentCycle, status: "failed", endedAt: new Date().toISOString() };
    state.stopReason = failed.stopDecision;
    state.cycles.push(failed);
    writeState(config.outRoot, state);
    throw new Error(`Training failed in ${cycleLabel}. See terminal output and ${join(config.outRoot, cycleLabel)}.`);
  }
  state.currentCycle = {
    ...state.currentCycle,
    status: config.skipKnowledge ? "summarizing" : "knowledge",
    trainingEndedAt: new Date().toISOString()
  };
  writeState(config.outRoot, state);

  // Preserve successful policy training while isolating the knowledge update for validation.
  matchupValidationBeforeBaselineRoot = !config.skipKnowledge
    ? snapshotMatchupValidationBaseline(config, matchupValidationDir)
    : null;

  let knowledgeResult = null;
  let knowledgeCommand = null;
  if (!config.skipKnowledge) {
    const knowledgeInputs = [
      ...config.knowledgeInputs,
      ...(config.cumulativeKnowledge ? acceptedKnowledgeRunDirs(state.cycles, config) : []),
      runDir
    ];
    const knowledgeArgs = [
      "tools/update-pilot-knowledge.mjs",
      "--input", [...new Set(knowledgeInputs)].join(","),
      "--own-key", config.ownKey,
      "--deck", config.deck,
      "--out-dir", knowledgeDir,
      "--agent-root", config.agentRoot,
      "--policy-dir", config.policyDir,
      "--baseline-root", config.baselineRoot,
      "--ml-out", config.mlOut
    ];
    if (config.knowledgeMode === "action") {
      knowledgeArgs.push("--skip-profile-overlays", "--skip-variant-overlays");
    } else if (config.knowledgeMode === "matchup") {
      knowledgeArgs.push("--skip-ml");
    }
    knowledgeCommand = commandText(knowledgeArgs);
    writeTextAtomicSync(join(config.outRoot, cycleLabel, "knowledge-command.ps1"), `${knowledgeCommand}\n`);
    knowledgeResult = runNodeCommand("knowledge update", knowledgeArgs, { dryRun: config.dryRun });
    if (knowledgeResult.status !== 0) {
      const knowledgeFailureRollback = !config.dryRun
        ? rollbackMatchupValidationBaseline(config, matchupValidationBeforeBaselineRoot, null, {
            reason: `Knowledge update subprocess failed in ${cycleLabel}; restored the post-training, pre-knowledge profile.`,
            context: "knowledge update failure"
          })
        : null;
      const failed = {
        cycle: cycleNumber,
        seed,
        runDir,
        trainResult,
        knowledgeResult,
        knowledgeFailureRollback,
        stopDecision: {
          type: "knowledge-failed",
          stopNow: true,
          cycle: cycleNumber,
          reason: `Knowledge update failed in ${cycleLabel}.`
        }
      };
      state.currentCycle = { ...state.currentCycle, status: "failed", endedAt: new Date().toISOString() };
      state.stopReason = failed.stopDecision;
      state.cycles.push(failed);
      writeState(config.outRoot, state);
      throw new Error(`Knowledge update failed in ${cycleLabel}.`);
    }
  }

  let matchupValidationResult = null;
  let matchupValidationCommand = null;
  let matchupValidation = null;
  const report = readJsonIfExists(join(runDir, "report.json"));
  const knowledge = readJsonIfExists(join(knowledgeDir, "knowledge-update.json"));
  const learningHealthBlocked = knowledge?.learningHealth?.status === "blocked";
  const knowledgeValidationPlan = validationPlanForCycle(config, knowledge, matchupValidationBeforeBaselineRoot);
  const retainProvisionalActionLearning = knowledgeValidationPlan.target === "none" && provisionalActionLearningEligible({
    knowledgeMode: config.knowledgeMode,
    learningHealth: knowledge?.learningHealth,
    model: knowledge?.mlModel
  });
  const matchupValidationOpponents = validationOpponentIds(config, report);
  if (shouldRunMatchupValidation(config) && !config.skipKnowledge && learningHealthBlocked) {
    matchupValidationResult = {
      status: 1,
      skipped: true,
      reason: `Learning health blocked paired validation: ${(knowledge.learningHealth.blockers ?? []).join("; ") || "unknown blocker"}.`
    };
    console.log(`${matchupValidationResult.reason} The pre-knowledge profile will be restored without spending validation games.`);
  } else if (shouldRunMatchupValidation(config) && !config.skipKnowledge && knowledgeValidationPlan.target === "none") {
    matchupValidationResult = {
      status: 0,
      skipped: true,
      reason: knowledgeValidationPlan.reason
    };
    console.log(matchupValidationResult.reason);
  } else if (shouldRunMatchupValidation(config) && !config.skipKnowledge) {
    state.currentCycle = {
      ...state.currentCycle,
      status: "matchup-validation",
      validationStartedAt: new Date().toISOString()
    };
    writeState(config.outRoot, state);
    if (matchupValidationOpponents.length === 0) {
      matchupValidationResult = {
        status: 1,
        skipped: true,
        reason: "No opponents were available from the cycle report for paired knowledge validation."
      };
      console.log(`${matchupValidationResult.reason} The pre-knowledge profile will be restored.`);
    } else {
      const validationArgs = matchupValidationArgsForCycle(config, {
        seed: seed + config.matchupValidationSeedOffset,
        outDir: matchupValidationDir,
        beforeBaselineRoot: matchupValidationBeforeBaselineRoot,
        opponentIds: matchupValidationOpponents,
        validationTarget: knowledgeValidationPlan.target
      });
      matchupValidationCommand = commandText(validationArgs);
      writeTextAtomicSync(join(config.outRoot, cycleLabel, "matchup-validation-command.ps1"), `${matchupValidationCommand}\n`);
      matchupValidationResult = runNodeCommand("matchup impact validation", validationArgs, { dryRun: config.dryRun });
      matchupValidation = readJsonIfExists(join(matchupValidationDir, "matchup-validation.json"));
      if (matchupValidationResult.status !== 0) {
        console.log(`Matchup impact validation failed in ${cycleLabel}; the pre-knowledge profile will be restored.`);
      }
    }
  }
  const matchupValidationSummaryValue = matchupValidationSummary(matchupValidation);
  const actionModelRetention = actionModelRetentionAfterRollbackCandidate(config, {
    knowledge,
    learningHealthBlocked,
    matchupValidation: matchupValidationSummaryValue
  });
  const matchupOverlayCandidateRetention = matchupOverlayCandidateRetentionAfterRollback(config, {
    knowledge,
    learningHealthBlocked,
    matchupValidation: matchupValidationSummaryValue
  });
  const matchupValidationRollback = !config.dryRun
    && (learningHealthBlocked || (!retainProvisionalActionLearning
      && knowledgeValidationPlan.target !== "none"
      && shouldRollbackMatchupValidation(config, matchupValidationSummaryValue, matchupValidationBeforeBaselineRoot)))
    ? rollbackMatchupValidationBaseline(config, matchupValidationBeforeBaselineRoot, matchupValidationSummaryValue, {
        reason: learningHealthBlocked
          ? `Learning health blocked the knowledge update: ${(knowledge.learningHealth.blockers ?? []).join("; ") || "unknown blocker"}.`
          : null,
        actionModelRetention,
        matchupOverlayCandidateRetention
      })
    : null;

  const promotion = readJsonIfExists(join(runDir, "policy-promotion.json"));
  const routedPromotion = readJsonIfExists(join(runDir, "routed-policy-promotion.json"));
  const learningAcceptance = learningAcceptanceForCycle(config, {
    trainResult,
    knowledgeResult,
    knowledge,
    matchupValidation: matchupValidationSummaryValue,
    matchupValidationRollback,
    retainProvisionalActionLearning,
    knowledgeValidationPlan
  });
  const validatedOverlayStamps = !config.dryRun
    && learningAcceptance.accepted
    && matchupValidationSummaryValue?.verdict === "positive"
    && ["matchup-overlay-only", "action-model-and-matchup-overlay-sequential"].includes(matchupValidationSummaryValue?.comparedArtifact)
    ? stampPositivelyValidatedOverlays(config, knowledge, matchupValidationSummaryValue)
    : [];
  const cycleSummary = {
    cycle: cycleNumber,
    trainingMode: config.trainingMode,
    trainingFocus: config.trainingFocus,
    knowledgeMode: config.knowledgeMode,
    seed,
    runDir,
    knowledgeDir,
    matchupValidationDir,
    handoffPath,
    trainCommand,
    knowledgeCommand,
    matchupValidationCommand,
    trainResult,
    knowledgeResult,
    matchupValidationResult,
    knowledgeValidationPlan,
    result: report?.result ?? null,
    baselineSummary: report?.baselineSummary ?? null,
    selectedPolicy: report?.bestPolicy?.name ?? null,
    promotion,
    routedPromotion,
    knowledgeSummary: knowledgeSummary(knowledge),
    matchupValidationSummary: matchupValidationSummaryValue,
    matchupValidationRollback,
    retainedProvisionalActionLearning: retainProvisionalActionLearning,
    retainedMatchupOverlayCandidates: matchupValidationRollback?.matchupOverlayCandidateRetention ?? null,
    learningAccepted: learningAcceptance.accepted,
    learningAcceptedReason: learningAcceptance.reason,
    validatedOverlayStamps,
    stopDecision: null
  };
  const stopDecision = stopDecisionForCycle(config, {
    cycleIndex,
    promotion,
    routedPromotion,
    knowledge,
    matchupValidation: matchupValidationSummaryValue,
    matchupValidationRollback,
    learningAcceptance
  });
  if (stopDecision) {
    cycleSummary.stopDecision = stopDecision;
    state.stopReason = stopDecision;
  }
  state.cycles.push(cycleSummary);
  state.currentCycle = null;
  writeState(config.outRoot, state);
  writeTextAtomicSync(handoffPath, handoffMarkdown(cycleSummary, report, knowledge));
  writeTextAtomicSync(join(config.outRoot, "latest-handoff.md"), handoffMarkdown(cycleSummary, report, knowledge));

  console.log(`Cycle ${cycleNumber} handoff: ${handoffPath}`);
  if (stopDecision?.stopNow) {
    console.log(`Stopping loop: ${stopDecision.reason}`);
    break;
  }
}

if (!state.stopReason) {
  state.stopReason = {
    type: "completed",
    stopNow: true,
    reason: "Loop completed without an explicit stop condition."
  };
}
state.completedAt = new Date().toISOString();
writeState(config.outRoot, state);
console.log(`\nPilot overseer finished: ${state.stopReason.reason}`);
console.log(`Latest handoff: ${join(config.outRoot, "latest-handoff.md")}`);

function readConfig() {
  const seed = Number(option("--seed") ?? 13201);
  const trainingMode = normalizeTrainingMode(option("--training-mode") ?? option("--mode") ?? inferTrainingMode(option("--training-focus") ?? option("--focus")));
  const agentPreset = normalizeAgentPreset(option("--agent-preset") ?? option("--preset") ?? trainingMode);
  const defaults = {
    ...sharedTrainingModeDefaults(trainingMode),
    ...sharedAgentPresetDefaults(agentPreset)
  };
  const trainingFocus = normalizeTrainingFocus(option("--training-focus") ?? option("--focus") ?? defaults.trainingFocus);
  const session = option("--session") ?? `spear-overseer-${seed}`;
  const agentRoot = option("--agent-root") ?? DEFAULT_AGENT_ROOT;
  const runsRoot = option("--runs-root") ?? DEFAULT_RUNS_ROOT;
  const cycleCeiling = option("--cycles") ?? option("--max-cycles") ?? 3;
  const ownKey = option("--own-key") ?? "eva-purple";
  const explicitUpdatePolicy = option("--update-policy");
  const updatePolicy = explicitUpdatePolicy
    ?? (defaults.updateReusablePolicy && ownKey === "eva-purple" ? join(agentRoot, "current-best-policy.json") : null);
  const knowledgeMode = normalizeKnowledgeMode(option("--knowledge-mode") ?? defaults.knowledgeMode);
  return {
    trainingMode,
    trainingFocus,
    agentPreset,
    deck: option("--deck") ?? "carnerr-spear",
    ownKey,
    cycles: Math.max(1, Number(cycleCeiling)),
    seed,
    seedStep: Number(option("--seed-step") ?? 101),
    session,
    agentRoot,
    policyDir: option("--policy-dir") ?? DEFAULT_POLICY_DIR,
    baselineRoot: option("--baseline-root") ?? join(agentRoot, "baselines"),
    runsRoot,
    outRoot: option("--out-root") ?? join(agentRoot, "loops", session),
    promoteFrom: option("--promote-from") ?? null,
    mlModel: option("--ml-model") ?? defaultMlModelPath(agentRoot, ownKey, option("--baseline-root") ?? join(agentRoot, "baselines")),
    mlOut: option("--ml-out") ?? profileActionModelPath(agentRoot, ownKey, option("--baseline-root") ?? join(agentRoot, "baselines")),
    mlStrength: option("--ml-strength") ?? defaults.mlStrength,
    opponentMode: option("--opponent-mode") ?? "random",
    opponentCount: option("--opponent-count") ?? "20",
    opponents: option("--opponents") ?? option("--opponent-deck") ?? "",
    opponentSet: option("--opponent-set") ?? option("--opponent-sets") ?? "",
    opponentColor: option("--opponent-color") ?? option("--opponent-colors") ?? "",
    opponentTop: option("--opponent-top") ?? "",
    regions: option("--regions") ?? option("--regionals") ?? option("--opponent-regions") ?? "",
    parallelRuns: option("--parallel-runs") ?? "14",
    parallelConcurrency: option("--parallel-concurrency") ?? option("--parallel-runs") ?? "14",
    games: option("--games") ?? defaults.games,
    generations: option("--generations") ?? defaults.generations,
    population: option("--population") ?? defaults.population,
    finalGames: option("--final-games") ?? "20",
    parallelFinalGames: option("--parallel-final-games") ?? defaults.parallelFinalGames,
    parallelFinalTopPercent: option("--parallel-final-top-percent") ?? defaults.parallelFinalTopPercent,
    parallelFinalCandidates: option("--parallel-final-candidates") ?? option("--parallel-final-candidate-mode") ?? defaults.parallelFinalCandidates,
    parallelOpponentCountPerRun: option("--parallel-opponent-count-per-run") ?? defaults.parallelOpponentCountPerRun,
    decisionLogMode: option("--decision-log-mode") ?? "learning",
    matchupOverlayStrength: option("--matchup-overlay-strength") ?? "1",
    matchupMinConfidence: option("--matchup-min-confidence") ?? "0.6",
    matchupVariantMinDeckConfidence: option("--matchup-variant-min-deck-confidence") ?? "0.55",
    matchupVariantMinCoverage: option("--matchup-variant-min-coverage") ?? "0.75",
    matchupUnknownMinEvidence: option("--matchup-unknown-min-evidence") ?? "4",
    explorationMode: option("--exploration-mode") ?? option("--action-exploration-mode") ?? defaults.explorationMode,
    explorationRate: option("--exploration-rate") ?? option("--action-exploration-rate") ?? defaults.explorationRate,
    explorationMaxPerGame: option("--exploration-max-per-game") ?? option("--action-exploration-max-per-game") ?? defaults.explorationMaxPerGame,
    explorationScoreWindow: option("--exploration-score-window") ?? defaults.explorationScoreWindow,
    explorationMaxRank: option("--exploration-max-rank") ?? defaults.explorationMaxRank,
    explorationMinScore: option("--exploration-min-score") ?? defaults.explorationMinScore,
    raidNormalPlayExplorationRate: option("--raid-normal-play-exploration-rate") ?? option("--raid-exploration-rate") ?? defaults.raidNormalPlayExplorationRate,
    raidNormalPlayScoreWindow: option("--raid-normal-play-score-window") ?? defaults.raidNormalPlayScoreWindow,
    raidNormalPlayHeuristicWindow: option("--raid-normal-play-heuristic-window") ?? defaults.raidNormalPlayHeuristicWindow,
    raidNormalPlayMinHeuristicScore: option("--raid-normal-play-min-heuristic-score") ?? defaults.raidNormalPlayMinHeuristicScore,
    counterfactualExplorationRate: option("--counterfactual-exploration-rate") ?? option("--counterfactual-rate") ?? defaults.counterfactualExplorationRate,
    counterfactualMaxPerGame: option("--counterfactual-max-per-game") ?? defaults.counterfactualMaxPerGame,
    counterfactualRolloutActions: option("--counterfactual-rollout-actions") ?? defaults.counterfactualRolloutActions,
    counterfactualRolloutPlayerTurns: option("--counterfactual-rollout-player-turns") ?? defaults.counterfactualRolloutPlayerTurns,
    progressMinutes: option("--progress-minutes") ?? "2",
    updatePolicy,
    updateRoutedPolicy: hasFlag("--update-routed-policy") || (!hasFlag("--no-update-routed-policy") && defaults.updateRoutedPolicy),
    knowledgeMode,
    skipKnowledge: hasFlag("--skip-knowledge") || knowledgeMode === "none",
    cumulativeKnowledge: !hasFlag("--no-cumulative-knowledge")
      && (hasFlag("--cumulative-knowledge") || hasFlag("--replay-accepted-knowledge")),
    knowledgeInputMode: !hasFlag("--no-cumulative-knowledge")
      && (hasFlag("--cumulative-knowledge") || hasFlag("--replay-accepted-knowledge"))
      ? "replay-accepted"
      : "incremental",
    knowledgeInputs: splitList(option("--knowledge-inputs") ?? option("--knowledge-history") ?? ""),
    matchupValidation: !hasFlag("--no-matchup-validation") && !hasFlag("--skip-matchup-validation"),
    matchupValidationGames: option("--matchup-validation-games") ?? "20",
    matchupValidationOpponentCount: option("--matchup-validation-opponent-count")
      ?? option("--validation-opponent-count")
      ?? (trainingMode === "deck" ? "6" : "1"),
    matchupValidationSeedOffset: Number(option("--matchup-validation-seed-offset") ?? 730_000_000),
    matchupValidationGate: matchupValidationGate(),
    dryRun: hasFlag("--dry-run"),
    bootstrapBaselineIfMissing: hasFlag("--bootstrap-baseline-if-missing"),
    stopAfterEachCycle: hasFlag("--stop-after-each-cycle"),
    stopIfNoPromotion: !hasFlag("--no-stop-if-no-promotion"),
    stopIfNoLearning: !hasFlag("--no-stop-if-no-learning"),
    noMl: hasFlag("--no-ml"),
    skipParallelFinal: hasFlag("--skip-parallel-final") || Boolean(defaults.skipParallelFinal && !hasFlag("--no-skip-parallel-final"))
  };
}

function trainArgsForCycle(config, { seed, runDir }) {
  const defaults = sharedTrainingModeDefaults(config.trainingMode);
  const agentDefaults = sharedAgentPresetDefaults(config.agentPreset);
  const args = [
    "tools/pilot-agent.mjs",
    "train",
    "--preset", config.agentPreset,
    "--deck", config.deck,
    "--opponent-mode", config.opponentMode,
    "--opponent-count", config.opponentCount,
    "--seed", String(seed),
    "--out-dir", runDir
  ];
  if (config.agentRoot !== DEFAULT_AGENT_ROOT) {
    args.push("--agent-root", config.agentRoot);
  }
  if (config.policyDir !== DEFAULT_POLICY_DIR || config.agentRoot !== DEFAULT_AGENT_ROOT) {
    args.push("--policy-dir", config.policyDir);
  }
  if (config.baselineRoot !== join(config.agentRoot, "baselines") || config.agentRoot !== DEFAULT_AGENT_ROOT) {
    args.push("--baseline-root", config.baselineRoot);
  }
  if (!config.noMl && config.mlModel && existsSync(config.mlModel)) {
    args.push("--ml-model", config.mlModel);
    pushValueIfChanged(args, "--ml-strength", config.mlStrength, agentDefaults.mlStrength ?? defaults.mlStrength);
  }
  pushValueIfChanged(args, "--parallel-runs", config.parallelRuns, agentDefaults.parallelRuns ?? "14");
  pushValueIfChanged(args, "--parallel-concurrency", config.parallelConcurrency, agentDefaults.parallelConcurrency ?? config.parallelRuns);
  pushValueIfChanged(args, "--parallel-opponent-count-per-run", config.parallelOpponentCountPerRun, agentDefaults.parallelOpponentCountPerRun ?? defaults.parallelOpponentCountPerRun);
  pushValueIfChanged(args, "--games", config.games, agentDefaults.games ?? defaults.games);
  pushValueIfChanged(args, "--generations", config.generations, agentDefaults.generations ?? defaults.generations);
  pushValueIfChanged(args, "--population", config.population, agentDefaults.population ?? defaults.population);
  pushValueIfChanged(args, "--final-games", config.finalGames, agentDefaults.finalGames ?? "20");
  pushValueIfChanged(args, "--parallel-final-games", config.parallelFinalGames, agentDefaults.parallelFinalGames ?? defaults.parallelFinalGames);
  pushValueIfChanged(args, "--parallel-final-top-percent", config.parallelFinalTopPercent, agentDefaults.parallelFinalTopPercent ?? defaults.parallelFinalTopPercent);
  pushValueIfChanged(args, "--parallel-final-candidates", config.parallelFinalCandidates, agentDefaults.parallelFinalCandidates ?? defaults.parallelFinalCandidates);
  pushValueIfChanged(args, "--decision-log-mode", config.decisionLogMode, agentDefaults.decisionLogMode ?? "learning");
  pushValueIfChanged(args, "--matchup-overlay-strength", config.matchupOverlayStrength, agentDefaults.matchupOverlayStrength ?? "1");
  pushValueIfChanged(args, "--matchup-min-confidence", config.matchupMinConfidence, agentDefaults.matchupMinConfidence ?? "0.6");
  pushValueIfChanged(args, "--matchup-variant-min-deck-confidence", config.matchupVariantMinDeckConfidence, agentDefaults.matchupVariantMinDeckConfidence ?? "0.55");
  pushValueIfChanged(args, "--matchup-variant-min-coverage", config.matchupVariantMinCoverage, agentDefaults.matchupVariantMinCoverage ?? "0.75");
  pushValueIfChanged(args, "--matchup-unknown-min-evidence", config.matchupUnknownMinEvidence, agentDefaults.matchupUnknownMinEvidence ?? "4");
  pushValueIfChanged(args, "--exploration-mode", config.explorationMode, agentDefaults.explorationMode ?? defaults.explorationMode);
  pushValueIfChanged(args, "--exploration-rate", config.explorationRate, agentDefaults.explorationRate ?? defaults.explorationRate);
  pushValueIfChanged(args, "--exploration-max-per-game", config.explorationMaxPerGame, agentDefaults.explorationMaxPerGame ?? defaults.explorationMaxPerGame);
  pushValueIfChanged(args, "--exploration-score-window", config.explorationScoreWindow, agentDefaults.explorationScoreWindow ?? defaults.explorationScoreWindow);
  pushValueIfChanged(args, "--exploration-max-rank", config.explorationMaxRank, agentDefaults.explorationMaxRank ?? defaults.explorationMaxRank);
  pushValueIfChanged(args, "--exploration-min-score", config.explorationMinScore, agentDefaults.explorationMinScore ?? defaults.explorationMinScore);
  pushValueIfChanged(args, "--raid-normal-play-exploration-rate", config.raidNormalPlayExplorationRate, agentDefaults.raidNormalPlayExplorationRate ?? defaults.raidNormalPlayExplorationRate);
  pushValueIfChanged(args, "--raid-normal-play-score-window", config.raidNormalPlayScoreWindow, agentDefaults.raidNormalPlayScoreWindow ?? defaults.raidNormalPlayScoreWindow);
  pushValueIfChanged(args, "--raid-normal-play-heuristic-window", config.raidNormalPlayHeuristicWindow, agentDefaults.raidNormalPlayHeuristicWindow ?? defaults.raidNormalPlayHeuristicWindow);
  pushValueIfChanged(args, "--raid-normal-play-min-heuristic-score", config.raidNormalPlayMinHeuristicScore, agentDefaults.raidNormalPlayMinHeuristicScore ?? defaults.raidNormalPlayMinHeuristicScore);
  pushValueIfChanged(args, "--counterfactual-exploration-rate", config.counterfactualExplorationRate, agentDefaults.counterfactualExplorationRate ?? defaults.counterfactualExplorationRate);
  pushValueIfChanged(args, "--counterfactual-max-per-game", config.counterfactualMaxPerGame, agentDefaults.counterfactualMaxPerGame ?? defaults.counterfactualMaxPerGame);
  pushValueIfChanged(args, "--counterfactual-rollout-actions", config.counterfactualRolloutActions, agentDefaults.counterfactualRolloutActions ?? defaults.counterfactualRolloutActions);
  pushValueIfChanged(args, "--counterfactual-rollout-player-turns", config.counterfactualRolloutPlayerTurns, agentDefaults.counterfactualRolloutPlayerTurns ?? defaults.counterfactualRolloutPlayerTurns);
  pushValueIfChanged(args, "--progress-minutes", config.progressMinutes, "2");
  if (config.opponentSet) args.push("--opponent-set", config.opponentSet);
  if (config.opponentColor) args.push("--opponent-color", config.opponentColor);
  if (config.opponentTop) args.push("--opponent-top", config.opponentTop);
  if (config.regions) args.push("--regions", config.regions);
  if (config.opponents) args.push("--opponents", config.opponents);
  if (config.updatePolicy) args.push("--update-policy", config.updatePolicy);
  if (config.updateRoutedPolicy === false && agentDefaults.routedPolicyUpdatesEnabled !== false) args.push("--no-update-routed-policy");
  if (config.updateRoutedPolicy === true && agentDefaults.routedPolicyUpdatesEnabled === false) args.push("--update-routed-policy");
  if (config.skipParallelFinal && !agentDefaults.skipParallelFinal) args.push("--skip-parallel-final");
  if (!config.skipParallelFinal && agentDefaults.skipParallelFinal) args.push("--no-skip-parallel-final");
  return args;
}

function shouldRunMatchupValidation(config) {
  return Boolean(
    config.matchupValidation
    && !config.skipKnowledge
  );
}

function acceptedKnowledgeRunDirs(cycles, config) {
  return cycles
    .filter((cycle) => cycleLearningAccepted(cycle, config))
    .map((cycle) => cycle.runDir)
    .filter(Boolean);
}

function launchPlan(config) {
  return {
    schema: "union-arena-local-engine/pilot-launch-plan@1",
    createdAt: new Date().toISOString(),
    session: config.session,
    trainingMode: config.trainingMode,
    trainingFocus: config.trainingFocus,
    deck: config.deck,
    ownKey: config.ownKey,
    cycles: config.cycles,
    seed: config.seed,
    seedStep: config.seedStep,
    workers: {
      parallelRuns: Number(config.parallelRuns),
      parallelConcurrency: Number(config.parallelConcurrency),
      opponentsPerRun: Number(config.parallelOpponentCountPerRun)
    },
    opponents: {
      mode: config.opponentMode,
      poolSize: Number(config.opponentCount),
      explicit: config.opponents,
      set: config.opponentSet,
      color: config.opponentColor,
      top: config.opponentTop,
      regions: config.regions
    },
    training: {
      preset: config.agentPreset,
      games: Number(config.games),
      generations: Number(config.generations),
      population: Number(config.population),
      finalGames: Number(config.finalGames),
      parallelFinalGames: Number(config.parallelFinalGames),
      parallelFinalTopPercent: Number(config.parallelFinalTopPercent),
      parallelFinalCandidates: config.parallelFinalCandidates,
      skipParallelFinal: config.skipParallelFinal,
      decisionLogMode: config.decisionLogMode,
      mlStrength: Number(config.mlStrength)
    },
    exploration: {
      actionRate: Number(config.explorationRate),
      maxPerGame: Number(config.explorationMaxPerGame),
      scoreWindow: Number(config.explorationScoreWindow),
      maxRank: Number(config.explorationMaxRank),
      minScore: Number(config.explorationMinScore),
      raidNormalPlayRate: Number(config.raidNormalPlayExplorationRate),
      raidNormalPlayScoreWindow: Number(config.raidNormalPlayScoreWindow),
      raidNormalPlayHeuristicWindow: Number(config.raidNormalPlayHeuristicWindow),
      raidNormalPlayMinHeuristicScore: Number(config.raidNormalPlayMinHeuristicScore),
      counterfactualRate: Number(config.counterfactualExplorationRate),
      counterfactualMaxPerGame: Number(config.counterfactualMaxPerGame),
      counterfactualRolloutActions: Number(config.counterfactualRolloutActions),
      counterfactualRolloutPlayerTurns: Number(config.counterfactualRolloutPlayerTurns)
    },
    knowledge: {
      mode: config.knowledgeMode,
      inputMode: config.knowledgeInputMode,
      explicitInputs: config.knowledgeInputs,
      incrementalArtifactsRetainHistory: true,
      matchupValidation: shouldRunMatchupValidation(config),
      matchupValidationGames: Number(config.matchupValidationGames),
      validationLaunch: "conditional-on-runtime-artifact-change"
    },
    phases: [
      "train",
      ...(config.skipKnowledge ? [] : ["incremental-knowledge-update"]),
      ...(shouldRunMatchupValidation(config) && !config.skipKnowledge ? ["conditional-paired-artifact-validation"] : []),
      "promotion-or-rollback"
    ]
  };
}

function cycleLearningAccepted(cycle, config) {
  if (!cycle?.runDir) return false;
  if (cycle.learningAccepted === true) return true;
  if (cycle.learningAccepted === false) return false;
  if (cycle.matchupValidationSummary) {
    return validationVerdictAccepted(cycle.matchupValidationSummary.verdict) && cycle.matchupValidationRollback?.rolledBack !== true;
  }
  if (shouldRunMatchupValidation(config)) return false;
  return cycle.trainResult?.status === 0 && (cycle.knowledgeResult?.status === 0 || cycle.knowledgeResult === null);
}

function learningAcceptanceForCycle(config, {
  trainResult,
  knowledgeResult,
  knowledge,
  matchupValidation,
  matchupValidationRollback,
  retainProvisionalActionLearning,
  knowledgeValidationPlan
}) {
  if (trainResult?.status !== 0) {
    return { accepted: false, reason: "training failed" };
  }
  if (config.skipKnowledge) {
    return { accepted: false, reason: "knowledge update was skipped" };
  }
  if (knowledgeResult?.status !== 0) {
    return { accepted: false, reason: "knowledge update failed" };
  }
  if (knowledge?.learningHealth?.status === "blocked") {
    return {
      accepted: false,
      reason: `learning health blocked cumulative use: ${(knowledge.learningHealth.blockers ?? []).join("; ") || "unknown blocker"}`
    };
  }
  if (retainProvisionalActionLearning) {
    return {
      accepted: true,
      reason: "healthy provisional action-model evidence retained inactive until runtime readiness"
    };
  }
  if (knowledgeValidationPlan?.target === "none") {
    if (knowledgeValidationPlan.inactiveEvidenceChanged) {
      return {
        accepted: true,
        reason: knowledgeValidationPlan.reason
      };
    }
    return {
      accepted: false,
      reason: "knowledge update produced no new runtime artifact or inactive evidence"
    };
  }
  if (shouldRunMatchupValidation(config)) {
    if (!matchupValidation) {
      return { accepted: false, reason: "matchup validation was unavailable" };
    }
    if (matchupValidationRollback?.rolledBack) {
      const retainedAction = matchupValidationRollback.actionModelRetention?.retained === true;
      const retainedOverlays = matchupValidationRollback.matchupOverlayCandidateRetention?.retained === true;
      if (retainedAction || retainedOverlays) {
        return {
          accepted: true,
          partial: true,
          reason: `active profile rollback retained ${retainedAction ? "action-model evidence" : ""}${retainedAction && retainedOverlays ? " and " : ""}${retainedOverlays ? "inactive matchup-overlay candidates" : ""}`
        };
      }
      return { accepted: false, reason: `matchup validation rolled back ${matchupValidation.verdict}` };
    }
    if (!validationVerdictAccepted(matchupValidation.verdict)) {
      return { accepted: false, reason: `matchup validation was ${matchupValidation.verdict}` };
    }
    return { accepted: true, reason: `matchup validation was ${matchupValidation.verdict}` };
  }
  return { accepted: true, reason: "knowledge update completed without matchup validation gate" };
}

function stampPositivelyValidatedOverlays(config, knowledge, validation) {
  const observedCandidateOverlayPaths = new Set((validation.observedCandidateOverlayPaths ?? []).map(normalizedArtifactPath));
  const changed = (knowledge?.overlayChanges?.rows ?? [])
    .filter((row) => ["created", "updated"].includes(row.status))
    .filter((row) => row.path && existsSync(row.path))
    .filter((row) => observedCandidateOverlayPaths.has(normalizedArtifactPath(row.path)));
  const stamped = [];
  for (const row of changed) {
    const overlay = readJsonIfExists(row.path);
    if (!overlay) continue;
    const stampedOverlay = stampMatchupOverlayImpactValidation(overlay, {
      verdict: "positive",
      validatedAt: new Date().toISOString(),
      pairedGames: Number(validation.pairedGames ?? 0),
      winRateDelta: Number(validation.winRateDelta ?? 0),
      avgLifeDiffDelta: Number(validation.avgLifeDiffDelta ?? 0),
      scoreDelta: Number(validation.scoreDelta ?? 0),
      directionalOutcomeP: Number(validation.directionalOutcomeP ?? 1),
      gate: config.matchupValidationGate,
      validationPath: validation.path ?? null
    });
    writeJsonAtomicSync(row.path, stampedOverlay);
    const candidatePath = matchupOverlayCandidatePathForKeys(config.ownKey, row.opponentKey, {
      policyDir: config.policyDir,
      baselineRoot: config.baselineRoot
    });
    if (existsSync(candidatePath)) rmSync(candidatePath, { force: true });
    stamped.push({ path: row.path, opponentKey: row.opponentKey, impactValidation: stampedOverlay.impactValidation });
  }
  if (stamped.length > 0) {
    console.log(`Stamped ${stamped.length} positively validated matchup overlay(s) for runtime use.`);
  }
  return stamped;
}

function validationOpponentIds(config, report) {
  const configured = splitList(config.opponents);
  if (configured.length > 0) return [...new Set(configured)];
  return [...new Set((report?.opponents ?? [])
    .map((opponent) => String(opponent?.id ?? "").trim())
    .filter(Boolean))];
}

function snapshotMatchupValidationBaseline(config, validationDir) {
  const beforeBaselineRoot = join(validationDir, "before-baselines");
  const source = baselineDeckDirForKey(config.ownKey, {
    policyDir: config.policyDir,
    baselineRoot: config.baselineRoot
  });
  const target = baselineDeckDirForKey(config.ownKey, {
    policyDir: join(dirname(beforeBaselineRoot), "policies"),
    baselineRoot: beforeBaselineRoot
  });
  restoreDirectorySnapshotSync({ source, target });
  return beforeBaselineRoot;
}

function shouldRollbackMatchupValidation(config, summary, beforeBaselineRoot) {
  if (config.dryRun) return false;
  if (!beforeBaselineRoot || config.matchupValidationGate === "off") return false;
  if (!summary) return true;
  if (config.matchupValidationGate === "positive") return !validationVerdictAccepted(summary.verdict);
  if (config.matchupValidationGate === "non-negative") return summary.verdict === "negative";
  return !validationVerdictAccepted(summary.verdict);
}

function validationVerdictAccepted(verdict) {
  return ["positive", "safe-no-runtime-change"].includes(String(verdict ?? ""));
}

function actionModelRetentionAfterRollbackCandidate(config, { knowledge, learningHealthBlocked, matchupValidation }) {
  if (learningHealthBlocked || config.knowledgeMode !== "full") return null;
  if (!config.mlOut || !existsSync(config.mlOut)) return null;
  const model = readJsonIfExists(config.mlOut);
  if (!model) return null;
  const newSourceCount = Array.isArray(model.newSourceFiles)
    ? model.newSourceFiles.length
    : Number(model.newSourceFiles ?? knowledge?.mlModel?.newSourceFiles ?? 0);
  if (!Number.isFinite(newSourceCount) || newSourceCount <= 0) return null;
  if (Number(model.learningSignalVersion ?? 1) < 2) return null;
  const runtimeTrust = mlActionModelRuntimeTrust(model);
  const actionVerdict = matchupValidation?.actionComparison?.verdict
    ?? (matchupValidation?.comparedArtifact === "action-model-only" ? matchupValidation.verdict : null);
  const pairedActionImprovement = validationVerdictAccepted(actionVerdict);
  if (runtimeTrust > 0 && !pairedActionImprovement) return null;
  return {
    path: config.mlOut,
    model,
    newSourceFiles: newSourceCount,
    runtimeTrust,
    pairedActionValidation: matchupValidation?.actionComparison ?? null,
    reason: pairedActionImprovement
      ? actionVerdict === "safe-no-runtime-change"
        ? "the action model accumulated evidence without changing runtime weights and can survive matchup-overlay rollback"
        : "the action model passed isolated paired validation and can survive matchup-overlay rollback"
      : "inactive profile action-model evidence can keep accumulating after matchup-overlay rollback"
  };
}

function matchupOverlayCandidateRetentionAfterRollback(config, {
  knowledge,
  learningHealthBlocked,
  matchupValidation
}) {
  if (learningHealthBlocked || config.knowledgeMode === "action") return null;
  const rows = (knowledge?.overlayChanges?.rows ?? [])
    .filter((row) => ["created", "updated"].includes(row.status))
    .filter((row) => row.path && existsSync(row.path))
    .map((row) => ({
      opponentKey: row.opponentKey,
      activePath: row.path,
      candidatePath: matchupOverlayCandidatePathForKeys(config.ownKey, row.opponentKey, {
        policyDir: config.policyDir,
        baselineRoot: config.baselineRoot
      }),
      overlay: readJsonIfExists(row.path)
    }))
    .filter((row) => row.overlay);
  if (rows.length === 0) return null;
  return {
    rows,
    validationVerdict: matchupValidation?.overlayComparison?.verdict ?? matchupValidation?.verdict ?? "unverified",
    reason: "inactive matchup candidate retains deduplicated causal evidence across validation rollback"
  };
}

function rollbackMatchupValidationBaseline(config, beforeBaselineRoot, summary, {
  reason = null,
  actionModelRetention = null,
  matchupOverlayCandidateRetention = null,
  context = "matchup validation gate"
} = {}) {
  if (!beforeBaselineRoot) {
    const result = {
      rolledBack: false,
      reason: reason ?? "Could not rollback because no pre-cycle profile snapshot was created.",
      source: null,
      target: null,
      gate: config.matchupValidationGate,
      verdict: summary?.verdict ?? "unverified",
      winRateDelta: Number(summary?.winRateDelta ?? 0),
      avgLifeDiffDelta: Number(summary?.avgLifeDiffDelta ?? 0),
      scoreDelta: Number(summary?.scoreDelta ?? 0),
      actionModelRetention: null,
      matchupOverlayCandidateRetention: null,
      rolledBackAt: new Date().toISOString()
    };
    console.log(result.reason);
    return result;
  }
  const source = baselineDeckDirForKey(config.ownKey, {
    policyDir: join(dirname(beforeBaselineRoot), "policies"),
    baselineRoot: beforeBaselineRoot
  });
  const target = baselineDeckDirForKey(config.ownKey, {
    policyDir: config.policyDir,
    baselineRoot: config.baselineRoot
  });
  const verdict = summary?.verdict ?? "unverified";
  const winRateDelta = Number(summary?.winRateDelta ?? 0);
  const avgLifeDiffDelta = Number(summary?.avgLifeDiffDelta ?? 0);
  const scoreDelta = Number(summary?.scoreDelta ?? 0);
  const result = {
    rolledBack: false,
    reason: reason ?? matchupRollbackReason(verdict, winRateDelta, avgLifeDiffDelta, scoreDelta),
    source,
    target,
    gate: config.matchupValidationGate,
    verdict,
    winRateDelta,
    avgLifeDiffDelta,
    scoreDelta,
    actionModelRetention: null,
    matchupOverlayCandidateRetention: null,
    rolledBackAt: new Date().toISOString()
  };
  const restore = restoreDirectorySnapshotSync({ source, target });
  result.rolledBack = true;
  result.actionModelRetention = retainActionModelAfterRollback(actionModelRetention);
  result.matchupOverlayCandidateRetention = retainMatchupOverlayCandidatesAfterRollback(matchupOverlayCandidateRetention);
  if (restore.restored) {
    console.log(`Rolled back ${config.ownKey} after ${context}: ${result.reason}`);
  } else if (restore.removedTarget) {
    result.reason = `${result.reason} No pre-cycle profile existed, so the post-cycle profile was removed.`;
    console.log(`Rolled back ${config.ownKey} by removing newly-created profile artifacts: ${result.reason}`);
  } else {
    result.reason = `${result.reason} No pre-cycle or post-cycle profile existed.`;
    console.log(`Rollback for ${config.ownKey} had no profile artifacts to restore: ${result.reason}`);
  }
  return result;
}

function retainMatchupOverlayCandidatesAfterRollback(retention) {
  if (!Array.isArray(retention?.rows) || retention.rows.length === 0) {
    return { retained: false, count: 0, reason: "no matchup-overlay candidate retention artifacts" };
  }
  const retained = [];
  for (const row of retention.rows) {
    const artifact = {
      ...row.overlay,
      retainedAfterMatchupRollback: {
        retainedAt: new Date().toISOString(),
        reason: retention.reason,
        validationVerdict: retention.validationVerdict,
        activePath: row.activePath
      }
    };
    writeJsonAtomicSync(row.candidatePath, artifact);
    retained.push({
      opponentKey: row.opponentKey,
      path: row.candidatePath,
      examples: Number(artifact.examples ?? 0),
      pairwiseExamples: Number(artifact.pairwiseExamples ?? 0),
      pairwiseEffectiveWeight: Number(artifact.pairwiseEffectiveWeight ?? 0)
    });
  }
  console.log(`Retained ${retained.length} inactive matchup-overlay candidate(s) after rollback.`);
  return {
    retained: true,
    count: retained.length,
    reason: retention.reason,
    validationVerdict: retention.validationVerdict,
    rows: retained
  };
}

function retainActionModelAfterRollback(retention) {
  if (!retention?.path || !retention.model) return {
    retained: false,
    reason: "no inactive action-model retention candidate"
  };
  const stamped = {
    ...retention.model,
    retainedAfterMatchupRollback: {
      retainedAt: new Date().toISOString(),
      reason: retention.reason,
      runtimeTrust: retention.runtimeTrust,
      newSourceFiles: retention.newSourceFiles,
      pairedActionValidation: retention.pairedActionValidation ?? null
    }
  };
  writeJsonAtomicSync(retention.path, stamped);
  console.log(`Retained inactive action-model evidence after matchup rollback: ${retention.path}`);
  return {
    retained: true,
    path: retention.path,
    reason: retention.reason,
    runtimeTrust: retention.runtimeTrust,
    newSourceFiles: retention.newSourceFiles,
    pairedActionValidation: retention.pairedActionValidation ?? null
  };
}

function matchupValidationGate() {
  const raw = option("--matchup-validation-gate") ?? option("--validation-gate") ?? "";
  if (hasFlag("--accept-negative-matchup-validation") || hasFlag("--no-matchup-validation-rollback")) return "off";
  if (hasFlag("--accept-inconclusive-matchup-validation")) return "non-negative";
  if (!raw) return "positive";
  const normalized = String(raw).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const aliases = new Map([
    ["strict", "positive"],
    ["positive-only", "positive"],
    ["proven", "positive"],
    ["safe", "positive"],
    ["negative-only", "non-negative"],
    ["rollback-negative", "non-negative"],
    ["none", "off"],
    ["false", "off"],
    ["disabled", "off"]
  ]);
  const gate = aliases.get(normalized) ?? normalized;
  if (!new Set(["positive", "non-negative", "off"]).has(gate)) {
    throw new Error(`Unknown --matchup-validation-gate: ${raw}. Use positive, non-negative, or off.`);
  }
  return gate;
}

function matchupRollbackReason(verdict, winRateDelta, avgLifeDiffDelta, scoreDelta) {
  if (verdict === "negative") {
    return `Negative matchup validation (${formatSignedPercent(winRateDelta)} win rate, ${signed(avgLifeDiffDelta)} life, ${signed(scoreDelta)} score).`;
  }
  if (verdict === "positive") {
    return `Positive validation unexpectedly requested rollback (${formatSignedPercent(winRateDelta)} win rate, ${signed(avgLifeDiffDelta)} life, ${signed(scoreDelta)} score).`;
  }
  if (verdict === "unverified") {
    return "Matchup validation did not produce a usable comparison, so the pre-cycle profile snapshot was restored.";
  }
  return `Matchup validation was not positive (${verdict}: ${formatSignedPercent(winRateDelta)} win rate, ${signed(avgLifeDiffDelta)} life, ${signed(scoreDelta)} score).`;
}

function matchupValidationArgsForCycle(config, { seed, outDir, beforeBaselineRoot, opponentIds, validationTarget }) {
  const args = [
    "tools/validate-matchup-impact.mjs",
    "--validation-target", validationTarget,
    "--deck", config.deck,
    "--own-key", config.ownKey,
    "--opponents", opponentIds.join(","),
    "--opponent-count", String(config.matchupValidationOpponentCount),
    "--games", String(config.matchupValidationGames),
    "--seed", String(seed),
    "--out-dir", outDir,
    "--before-baseline-root", beforeBaselineRoot,
    "--agent-root", config.agentRoot,
    "--policy-dir", config.policyDir,
    "--baseline-root", config.baselineRoot,
    "--ml-strength", String(config.mlStrength),
    "--opponent-ml-strength", String(config.mlStrength),
    "--matchup-overlay-strength", String(config.matchupOverlayStrength),
    "--matchup-min-confidence", String(config.matchupMinConfidence),
    "--matchup-variant-min-deck-confidence", String(config.matchupVariantMinDeckConfidence),
    "--matchup-variant-min-coverage", String(config.matchupVariantMinCoverage),
    "--matchup-unknown-min-evidence", String(config.matchupUnknownMinEvidence)
  ];
  if (config.validateDecks === false) args.push("--no-validate");
  return args;
}

function validationTargetForCycle(config, knowledge) {
  return validationPlanForCycle(config, knowledge).target;
}

function validationPlanForCycle(config, knowledge, beforeBaselineRoot = null) {
  if (!knowledge) {
    const target = config.knowledgeMode === "action"
      ? "action"
      : config.knowledgeMode === "full" ? "full" : "overlay";
    return {
      target,
      actionChanged: false,
      actionRuntimeReady: false,
      activeOverlayChanged: false,
      candidateOverlayChanged: false,
      inactiveEvidenceChanged: false,
      reason: `Dry-run validation target follows ${config.knowledgeMode} knowledge mode.`
    };
  }

  return knowledgeArtifactValidationPlan({
    knowledgeMode: config.knowledgeMode,
    model: knowledge.mlModel,
    overlayChanges: knowledge.overlayChanges,
    actionRuntimeBehaviorChanged: actionRuntimeBehaviorChangedSinceSnapshot(config, beforeBaselineRoot)
  });
}

function actionRuntimeBehaviorChangedSinceSnapshot(config, beforeBaselineRoot) {
  if (!beforeBaselineRoot) return null;
  const beforeSignature = profileRuntimePolicySignature(config, beforeBaselineRoot);
  const afterSignature = profileRuntimePolicySignature(config, config.baselineRoot);
  if (!beforeSignature || !afterSignature) return null;
  return beforeSignature !== afterSignature;
}

function profileRuntimePolicySignature(config, baselineRoot) {
  const policyPath = baselinePolicyPathForKey(config.ownKey, {
    policyDir: config.policyDir,
    baselineRoot
  });
  const rawPolicy = readJsonIfExists(policyPath);
  if (!rawPolicy) return null;
  const modelPath = actionModelPathForKey(config.ownKey, {
    agentRoot: config.agentRoot,
    baselineRoot
  });
  const model = readJsonIfExists(modelPath);
  const policy = model
    ? blendPilotPolicyWithMlModel(normalizePilotPolicy(rawPolicy), model, {
        strength: Number(config.mlStrength ?? 1),
        name: "validation-plan-signature"
      })
    : normalizePilotPolicy(rawPolicy);
  const stable = JSON.stringify(Object.fromEntries(Object.entries(policy.weights ?? {})
    .sort(([left], [right]) => left.localeCompare(right))));
  let hash = 2166136261;
  for (let index = 0; index < stable.length; index += 1) {
    hash ^= stable.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function maybeBootstrapBaseline(config, state) {
  if (!config.bootstrapBaselineIfMissing || config.trainingMode === "deck") return;
  const specialistPath = baselinePolicyPathForKey(config.ownKey, { policyDir: config.policyDir, baselineRoot: config.baselineRoot });
  const legacySpecialistPath = join(config.policyDir, `${policyKeySegment(config.ownKey)}.json`);
  if (existsSync(specialistPath)) return;
  if (existsSync(legacySpecialistPath)) return;

  const defaults = sharedTrainingModeDefaults("deck");
  const bootstrapLabel = "bootstrap-baseline";
  const runDir = join(config.runsRoot, `${config.session}-${bootstrapLabel}`);
  const cycleRoot = join(config.outRoot, bootstrapLabel);
  const knowledgeDir = join(cycleRoot, "knowledge");
  const handoffPath = join(cycleRoot, "handoff.md");
  mkdirSync(cycleRoot, { recursive: true });
  const bootstrapBeforeBaselineRoot = !config.dryRun
    ? snapshotMatchupValidationBaseline(config, join(cycleRoot, "training-rollback"))
    : null;

  const bootstrapConfig = {
    ...config,
    trainingMode: "deck",
    trainingFocus: "policy",
    opponentMode: "random",
    opponents: "",
    opponentSet: "",
    opponentColor: "",
    opponentTop: "",
    regions: "",
    games: defaults.games,
    generations: defaults.generations,
    population: defaults.population,
    mlStrength: defaults.mlStrength,
    parallelOpponentCountPerRun: defaults.parallelOpponentCountPerRun,
    parallelFinalGames: defaults.parallelFinalGames,
    parallelFinalTopPercent: defaults.parallelFinalTopPercent,
    parallelFinalCandidates: defaults.parallelFinalCandidates,
    knowledgeMode: "action",
    skipKnowledge: false,
    updateRoutedPolicy: true,
    bootstrapBaselineIfMissing: false
  };

  console.log(`\n=== Baseline bootstrap for ${config.ownKey} ===`);
  console.log(`No specialist policy found at ${specialistPath} or ${legacySpecialistPath}.`);
  console.log(`Run dir: ${runDir}`);

  const trainArgs = trainArgsForCycle(bootstrapConfig, { seed: config.seed, runDir });
  const trainCommand = commandText(trainArgs);
  writeTextAtomicSync(join(cycleRoot, "train-command.ps1"), `${trainCommand}\n`);
  const trainResult = runNodeCommand("baseline bootstrap", trainArgs, { dryRun: config.dryRun });
  if (trainResult.status !== 0) {
    const trainingFailureRollback = !config.dryRun
      ? rollbackMatchupValidationBaseline(config, bootstrapBeforeBaselineRoot, null, {
          reason: "Baseline bootstrap training failed; restored the pre-bootstrap profile.",
          context: "bootstrap training failure"
        })
      : null;
    const failed = { cycle: 0, bootstrap: true, seed: config.seed, runDir, trainResult, trainingFailureRollback };
    state.cycles.push(failed);
    writeState(config.outRoot, state);
    throw new Error(`Baseline bootstrap failed. See terminal output and ${cycleRoot}.`);
  }

  const bootstrapKnowledgeBeforeBaselineRoot = !config.dryRun
    ? snapshotMatchupValidationBaseline(config, join(cycleRoot, "knowledge-rollback"))
    : null;

  const knowledgeArgs = [
    "tools/update-pilot-knowledge.mjs",
    "--input", runDir,
    "--own-key", config.ownKey,
    "--deck", config.deck,
    "--out-dir", knowledgeDir,
    "--agent-root", config.agentRoot,
    "--policy-dir", config.policyDir,
    "--baseline-root", config.baselineRoot,
    "--ml-out", bootstrapConfig.mlOut,
    "--skip-profile-overlays",
    "--skip-variant-overlays"
  ];
  const knowledgeCommand = commandText(knowledgeArgs);
  writeTextAtomicSync(join(cycleRoot, "knowledge-command.ps1"), `${knowledgeCommand}\n`);
  const knowledgeResult = runNodeCommand("baseline bootstrap knowledge update", knowledgeArgs, { dryRun: config.dryRun });
  if (knowledgeResult.status !== 0) {
    const knowledgeFailureRollback = !config.dryRun
      ? rollbackMatchupValidationBaseline(config, bootstrapKnowledgeBeforeBaselineRoot, null, {
          reason: "Baseline bootstrap knowledge update failed; restored the trained baseline without partial ML artifacts.",
          context: "bootstrap knowledge failure"
        })
      : null;
    const failed = {
      cycle: 0,
      bootstrap: true,
      seed: config.seed,
      runDir,
      trainResult,
      knowledgeResult,
      knowledgeFailureRollback
    };
    state.cycles.push(failed);
    writeState(config.outRoot, state);
    throw new Error("Baseline bootstrap knowledge update failed.");
  }

  const report = readJsonIfExists(join(runDir, "report.json"));
  const promotion = readJsonIfExists(join(runDir, "policy-promotion.json"));
  const routedPromotion = readJsonIfExists(join(runDir, "routed-policy-promotion.json"));
  const knowledge = readJsonIfExists(join(knowledgeDir, "knowledge-update.json"));
  const cycleSummary = {
    cycle: 0,
    bootstrap: true,
    trainingMode: "deck",
    trainingFocus: "policy",
    knowledgeMode: "action",
    seed: config.seed,
    runDir,
    knowledgeDir,
    handoffPath,
    trainCommand,
    knowledgeCommand,
    trainResult,
    knowledgeResult,
    result: report?.result ?? null,
    baselineSummary: report?.baselineSummary ?? null,
    selectedPolicy: report?.bestPolicy?.name ?? null,
    promotion,
    routedPromotion,
    knowledgeSummary: knowledgeSummary(knowledge),
    stopDecision: null
  };
  state.cycles.push(cycleSummary);
  writeState(config.outRoot, state);
  writeTextAtomicSync(handoffPath, handoffMarkdown(cycleSummary, report, knowledge));
  writeTextAtomicSync(join(config.outRoot, "latest-handoff.md"), handoffMarkdown(cycleSummary, report, knowledge));
  console.log(`Baseline bootstrap handoff: ${handoffPath}`);
}

function promotePolicyFromRun(runDir, config) {
  const source = join(runDir, "best-policy.json");
  if (!existsSync(source)) throw new Error(`Cannot promote; best-policy.json not found in ${runDir}`);
  const currentPath = join(config.agentRoot, "current-best-policy.json");
  const specialistPath = baselinePolicyPathForKey(config.ownKey, { policyDir: config.policyDir, baselineRoot: config.baselineRoot });
  mkdirSync(config.agentRoot, { recursive: true });
  mkdirSync(dirname(specialistPath), { recursive: true });
  copyFileSync(source, currentPath);
  copyFileSync(source, specialistPath);
  console.log(`Promoted ${source} to ${currentPath} and ${specialistPath}.`);
}

function stopDecisionForCycle(config, {
  cycleIndex,
  promotion,
  routedPromotion,
  knowledge,
  matchupValidation,
  matchupValidationRollback,
  learningAcceptance
}) {
  const cycleNumber = cycleIndex + 1;
  const reusableImproved = promotion?.promote === true;
  const routedImproved = routedPromotion?.promote === true;
  const reusableReason = promotion?.reason ?? "no reusable promotion audit was written";
  const routedReason = routedPromotion?.reason ?? "no routed promotion audit was written";
  const overlayChanges = knowledge?.overlayChanges ?? null;
  const overlayLearning = Number(overlayChanges?.created ?? 0) + Number(overlayChanges?.updated ?? 0);
  const candidateOverlayLearning = Number(overlayChanges?.candidateCreated ?? 0) + Number(overlayChanges?.candidateUpdated ?? 0);
  const learningHealthBlocked = knowledge?.learningHealth?.status === "blocked";
  const knowledgeImproved = !learningHealthBlocked && learningAcceptance?.accepted === true;
  const learnedThisCycle = reusableImproved || routedImproved || knowledgeImproved;
  const knowledgeReason = `${learningAcceptance?.reason ?? `Knowledge validation: ${matchupValidation?.verdict ?? "unavailable"}`}. ${overlayLearning} active overlay file(s), ${candidateOverlayLearning} inactive matchup candidate(s), ${Number(knowledge?.mlModel?.newSourceFiles ?? 0)} new action-model source(s).${matchupValidationRollback?.reason ? ` ${matchupValidationRollback.reason}` : ""}${learningHealthBlocked ? ` Learning health blocked: ${(knowledge?.learningHealth?.blockers ?? []).join("; ")}` : ""}`;

  if (config.stopAfterEachCycle && cycleIndex < config.cycles - 1) {
    return {
      type: "manual-review",
      stopNow: true,
      cycle: cycleNumber,
      reason: "--stop-after-each-cycle was supplied, so the overseer paused for review."
    };
  }

  if (config.trainingFocus === "hybrid" && config.stopIfNoLearning && !learnedThisCycle) {
    return {
      type: "no-learning-increase",
      stopNow: true,
      cycle: cycleNumber,
      reason: `No base policy or validated knowledge improved in cycle ${cycleNumber}. Reusable policy: ${reusableReason}. Routed policy: ${routedReason}. ${knowledgeReason}`
    };
  }

  if (config.trainingFocus === "policy" && config.stopIfNoPromotion && !learnedThisCycle) {
    return {
      type: "no-performance-increase",
      stopNow: true,
      cycle: cycleNumber,
      reason: `No policy or validated action model improved in cycle ${cycleNumber}. Reusable policy: ${reusableReason}. Routed policy: ${routedReason}. ${knowledgeReason}`
    };
  }

  if (cycleIndex >= config.cycles - 1) {
    return {
      type: "cycle-ceiling",
      stopNow: true,
      cycle: cycleNumber,
      reason: `Reached the configured cycle ceiling (${config.cycles}) before a no-improvement stop.`
    };
  }

  return null;
}

function runNodeCommand(label, args, { dryRun }) {
  console.log(`\n[${label}] ${commandText(args)}`);
  if (dryRun) return { label, status: 0, dryRun: true, command: commandText(args) };
  const startedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: "inherit"
  });
  return {
    label,
    status: result.status,
    signal: result.signal,
    startedAt,
    endedAt: new Date().toISOString(),
    command: commandText(args)
  };
}

function handoffMarkdown(cycle, report, knowledge) {
  const result = report?.result;
  const baseline = report?.baselineSummary;
  const matchups = report?.analysis?.matchups ?? [];
  const weak = [...matchups]
    .sort((a, b) => Number(a.winRate ?? 0) - Number(b.winRate ?? 0) || Number(a.avgLifeDiff ?? 0) - Number(b.avgLifeDiff ?? 0))
    .slice(0, 8);
  const strong = [...matchups]
    .sort((a, b) => Number(b.winRate ?? 0) - Number(a.winRate ?? 0) || Number(b.avgLifeDiff ?? 0) - Number(a.avgLifeDiff ?? 0))
    .slice(0, 8);
  const knowledgeStats = knowledgeSummary(knowledge);
  const overlayChanges = knowledge?.overlayChanges ?? null;
  const validation = cycle.matchupValidationSummary ?? null;
  const lines = [
    `# Pilot Loop Handoff`,
    ``,
    `Cycle: ${cycle.cycle}`,
    `Mode: ${cycle.trainingMode ?? "matchup"}`,
    `Focus: ${cycle.trainingFocus ?? "hybrid"}`,
    `Knowledge mode: ${cycle.knowledgeMode ?? "full"}`,
    `Seed: ${cycle.seed}`,
    `Run: \`${cycle.runDir}\``,
    `Knowledge: \`${cycle.knowledgeDir}\``,
    ``,
    `## Result`,
    result
      ? `- Selected policy result: ${result.wins}/${result.losses}/${result.incomplete}, ${(Number(result.winRate ?? 0) * 100).toFixed(1)}%, score ${Number(result.score ?? 0).toFixed(2)}`
      : `- No report result found.`,
    baseline
      ? `- Baseline: ${baseline.wins}/${baseline.losses}/${baseline.incomplete}, ${(Number(baseline.winRate ?? 0) * 100).toFixed(1)}%, score ${Number(baseline.score ?? 0).toFixed(2)}`
      : `- Baseline: unavailable`,
    cycle.promotion
      ? `- Reusable policy promotion: ${cycle.promotion.promote ? "yes" : "no"} (${cycle.promotion.reason})`
      : `- Reusable policy promotion: no audit file`,
    cycle.routedPromotion
      ? `- Routed policy promotion: ${cycle.routedPromotion.promote ? "yes" : "no"} (${cycle.routedPromotion.reason})`
      : `- Routed policy promotion: no audit file`,
    cycle.stopDecision
      ? `- Loop stop decision: ${cycle.stopDecision.reason}`
      : `- Loop stop decision: continue`,
    ``,
    `## Knowledge Update`,
    knowledgeStats
      ? `- Action model: ${knowledgeStats.modelExamples} examples, ${knowledgeStats.modelEffectiveExamples.toFixed(1)} effective, ${knowledgeStats.modelFeatures} features`
      : `- Knowledge update: unavailable`,
    knowledgeStats
      ? `- Signal trust: ${formatPercent(knowledgeStats.modelSignalTrust)} (${knowledgeStats.modelHeldoutPlayerGames} held-out player-games; ${knowledgeStats.modelPairwiseExamples} pairwise example(s); ${knowledgeStats.decisionCounterfactuals} counterfactual decision(s); ${knowledgeStats.modelPairwiseAccuracy === null ? "pairwise accuracy unavailable" : `${formatPercent(knowledgeStats.modelPairwiseAccuracy)} pairwise accuracy`})`
      : ``,
    knowledgeStats
      ? `- Learning health: ${knowledgeStats.learningHealthLabel}${knowledgeStats.learningHealthWarnings > 0 || knowledgeStats.learningHealthBlockers > 0 ? ` (${knowledgeStats.learningHealthBlockers} blocker(s), ${knowledgeStats.learningHealthWarnings} warning(s))` : ""}`
      : ``,
    knowledgeStats
      ? `- Active overlays: ${knowledgeStats.overlayCount} total, ${knowledgeStats.variantOverlayCount} variant; inactive matchup candidates: ${knowledgeStats.candidateOverlayCount}`
      : ``,
    overlayChanges
      ? `- Overlay changes: ${overlayChanges.created} active created, ${overlayChanges.updated} active updated; ${overlayChanges.candidateCreated ?? 0} candidate created, ${overlayChanges.candidateUpdated ?? 0} candidate updated`
      : `- Overlay changes: unavailable`,
    cycle.knowledgeValidationPlan
      ? `- Validation launch plan: ${cycle.knowledgeValidationPlan.target} (${cycle.knowledgeValidationPlan.reason})`
      : ``,
    `- Provisional action learning retained inactive: ${cycle.retainedProvisionalActionLearning ? "yes" : "no"}`,
    `- Learning accepted for future cumulative updates: ${cycle.learningAccepted ? "yes" : "no"} (${cycle.learningAcceptedReason ?? "unknown"})`,
    knowledgeStats?.unknownVariants > 0
      ? `- Unknown variants seen: ${knowledgeStats.unknownVariants}`
      : `- Unknown variants seen: 0`,
    ``,
    `## Matchup Impact Validation`,
    validation
      ? `- Before: ${validation.before.wins}/${validation.before.losses}/${validation.before.incomplete}, ${formatPercent(validation.before.winRate)}`
      : `- Validation: unavailable`,
    validation
      ? `- After: ${validation.after.wins}/${validation.after.losses}/${validation.after.incomplete}, ${formatPercent(validation.after.winRate)}`
      : ``,
    validation
      ? `- Impact: ${formatSignedPercent(validation.winRateDelta)} win rate, ${signed(validation.avgLifeDiffDelta)} life, ${signed(validation.scoreDelta)} score (${validation.verdict})`
      : ``,
    validation?.actionComparison
      ? `- Action-model review: ${validation.actionComparison.verdict} (${formatSignedPercent(validation.actionComparison.winRateDelta)} win rate, ${signed(validation.actionComparison.avgLifeDiffDelta)} life)`
      : ``,
    validation?.overlayComparison
      ? `- Matchup-overlay review: ${validation.overlayComparison.verdict} (${validation.candidateOverlayDecisionCount}/${validation.minimumCandidateOverlayDecisions} candidate-overlay decisions)`
      : ``,
    cycle.matchupValidationRollback
      ? `- Validation rollback: ${cycle.matchupValidationRollback.rolledBack ? "yes" : "no"} (${cycle.matchupValidationRollback.reason})`
      : ``,
    ``,
    `## Weakest Matchups`,
    ...(weak.length > 0
      ? weak.map((item) => `- ${item.opponent}: ${item.wins}/${item.losses}/${item.incomplete}, ${(Number(item.winRate ?? 0) * 100).toFixed(1)}%, life ${Number(item.avgLifeDiff ?? 0).toFixed(2)}`)
      : [`- none`]),
    ``,
    `## Strongest Matchups`,
    ...(strong.length > 0
      ? strong.map((item) => `- ${item.opponent}: ${item.wins}/${item.losses}/${item.incomplete}, ${(Number(item.winRate ?? 0) * 100).toFixed(1)}%, life ${Number(item.avgLifeDiff ?? 0).toFixed(2)}`)
      : [`- none`]),
    ``,
    `## Paste To Codex`,
    ``,
    `Review this pilot loop cycle: \`${cycle.runDir}\`. Knowledge update: \`${cycle.knowledgeDir}\`. Tell me whether to continue, tune parameters, or focus a matchup.`,
    ``
  ];
  return `${lines.join("\n")}\n`;
}

function knowledgeSummary(knowledge) {
  if (!knowledge) return null;
  const model = knowledge.mlModel ?? {};
  const validation = model.validation ?? {};
  const pairwiseAccuracy = validation.pairwise?.signAccuracy;
  return {
    modelExamples: Number(model.examples ?? 0),
    modelEffectiveExamples: Number(model.effectiveExamples ?? model.exampleWeightTotal ?? model.examples ?? 0),
    modelFeatures: Number(model.features ?? 0),
    modelPairwiseExamples: Number(model.pairwiseExamples ?? 0),
    modelSignalTrust: Number(model.learningSignalTrust ?? (Number(model.learningSignalVersion ?? 1) >= 2 ? 1 : 0.25)),
    modelHeldoutPlayerGames: Number(validation.heldoutPlayerGames ?? 0),
    modelPairwiseAccuracy: pairwiseAccuracy === null || pairwiseAccuracy === undefined ? null : Number(pairwiseAccuracy),
    decisionCounterfactuals: Number(knowledge.decisions?.counterfactual ?? 0),
    learningHealthStatus: knowledge.learningHealth?.status ?? "unknown",
    learningHealthLabel: knowledge.learningHealth?.label ?? "Unknown",
    learningHealthBlockers: Array.isArray(knowledge.learningHealth?.blockers) ? knowledge.learningHealth.blockers.length : 0,
    learningHealthWarnings: Array.isArray(knowledge.learningHealth?.warnings) ? knowledge.learningHealth.warnings.length : 0,
    learningHealth: knowledge.learningHealth ?? null,
    overlayCount: Array.isArray(knowledge.overlays) ? knowledge.overlays.filter((item) => !item.candidate).length : 0,
    candidateOverlayCount: Array.isArray(knowledge.overlays) ? knowledge.overlays.filter((item) => item.candidate).length : 0,
    variantOverlayCount: Array.isArray(knowledge.overlays) ? knowledge.overlays.filter((item) => !item.candidate && item.variant).length : 0,
    unknownVariants: Array.isArray(knowledge.decisions?.unknownVariants) ? knowledge.decisions.unknownVariants.length : 0
  };
}

function matchupValidationSummary(validation) {
  if (!validation?.comparison) return null;
  const before = validation.evaluations?.find((row) => row.id === "before")?.summary ?? null;
  const after = validation.evaluations?.find((row) => row.id === "after")?.summary ?? null;
  if (!before || !after) return null;
  return {
    before,
    after,
    winRateDelta: Number(validation.comparison.winRateDelta ?? 0),
    avgLifeDiffDelta: Number(validation.comparison.avgLifeDiffDelta ?? 0),
    scoreDelta: Number(validation.comparison.scoreDelta ?? 0),
    avgTurnCyclesDelta: Number(validation.comparison.avgTurnCyclesDelta ?? 0),
    incompleteRateDelta: Number(validation.comparison.incompleteRateDelta ?? 0),
    pairedGames: Number(validation.comparison.pairedGames ?? 0),
    directionalOutcomeP: Number(validation.comparison.directionalOutcomeP ?? 1),
    comparedArtifact: validation.comparison.comparedArtifact ?? "unknown",
    policyAndActionModelHeldConstant: validation.comparison.policyAndActionModelHeldConstant === true,
    changedOverlayCount: Number(validation.comparison.changedOverlayCount ?? 0),
    candidateOverlayDecisionCount: Number(validation.comparison.candidateOverlayDecisionCount ?? 0),
    candidateOverlayDecisionRate: Number(validation.comparison.candidateOverlayDecisionRate ?? 0),
    minimumCandidateOverlayDecisions: Number(validation.comparison.minimumCandidateOverlayDecisions ?? 0),
    exposureReady: validation.comparison.exposureReady === true,
    observedCandidateOverlayPaths: Array.isArray(validation.comparison.observedCandidateOverlayPaths)
      ? validation.comparison.observedCandidateOverlayPaths
      : [],
    actionComparison: validation.comparisons?.action ?? validation.comparison.actionComparison ?? null,
    overlayComparison: validation.comparisons?.overlay ?? validation.comparison.overlayComparison ?? null,
    verdict: validation.comparison.verdict ?? "unknown",
    path: validation.config?.outDir ? join(validation.config.outDir, "matchup-validation.json") : null
  };
}

function normalizedArtifactPath(path) {
  return String(path ?? "").replace(/\\/gu, "/").toLowerCase();
}

function formatPercent(value) {
  return `${(Number(value ?? 0) * 100).toFixed(1)}%`;
}

function formatSignedPercent(value) {
  const number = Number(value ?? 0);
  return `${number >= 0 ? "+" : ""}${(number * 100).toFixed(1)}%`;
}

function signed(value) {
  const number = Number(value ?? 0);
  return `${number >= 0 ? "+" : ""}${number.toFixed(2)}`;
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeState(outRoot, state) {
  writeJsonAtomicSync(join(outRoot, "loop-state.json"), state);
}

function publicConfig(config) {
  const { dryRun, ...rest } = config;
  return { ...rest, dryRun };
}

function normalizeTrainingFocus(value) {
  const normalized = String(value ?? "hybrid").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const aliases = new Map([
    ["both", "hybrid"],
    ["base-and-matchups", "hybrid"],
    ["policy-and-matchups", "hybrid"],
    ["main-policy", "policy"],
    ["pilot", "policy"]
  ]);
  const focus = aliases.get(normalized) ?? normalized;
  if (!new Set(["hybrid", "policy"]).has(focus)) {
    throw new Error(`Unknown --training-focus: ${value}. Use hybrid or policy.`);
  }
  return focus;
}

function normalizeTrainingMode(value) {
  const normalized = String(value ?? "matchup").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const aliases = new Map([
    ["matchups", "matchup"],
    ["matchup-based", "matchup"],
    ["matchup-training", "matchup"],
    ["overlay", "matchup"],
    ["overlays", "matchup"],
    ["deck-based", "deck"],
    ["deck-training", "deck"],
    ["policy", "deck"],
    ["base", "deck"]
  ]);
  const mode = aliases.get(normalized) ?? normalized;
  if (!new Set(["matchup", "deck"]).has(mode)) {
    throw new Error(`Unknown --training-mode: ${value}. Use matchup or deck.`);
  }
  return mode;
}

function normalizeKnowledgeMode(value) {
  const normalized = String(value ?? "full").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const aliases = new Map([
    ["off", "none"],
    ["false", "none"],
    ["no", "none"],
    ["skip", "none"],
    ["ml", "action"],
    ["action-model", "action"],
    ["action-only", "action"],
    ["model", "action"],
    ["model-only", "action"],
    ["overlays", "matchup"],
    ["matchups", "matchup"],
    ["overlay-only", "matchup"],
    ["matchup-only", "matchup"],
    ["all", "full"],
    ["both", "full"]
  ]);
  const mode = aliases.get(normalized) ?? normalized;
  if (!new Set(["none", "action", "matchup", "full"]).has(mode)) {
    throw new Error(`Unknown --knowledge-mode: ${value}. Use none, action, matchup, or full.`);
  }
  return mode;
}

function inferTrainingMode(trainingFocus) {
  const focus = trainingFocus ? normalizeTrainingFocus(trainingFocus) : "hybrid";
  return focus === "policy" ? "deck" : "matchup";
}

function normalizeAgentPreset(value) {
  const normalized = String(value ?? "custom").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const aliases = new Map([
    ["policy", "deck"],
    ["deck-training", "deck"],
    ["base", "deck"],
    ["baseline", "deck"],
    ["matchups", "matchup"],
    ["matchup-training", "matchup"],
    ["overlay", "matchup"],
    ["overlays", "matchup"],
    ["all-baselines", "baseline-suite"],
    ["missing-baselines", "baseline-suite"]
  ]);
  const preset = aliases.get(normalized) ?? normalized;
  if (!new Set(["custom", "deck", "matchup", "baseline-suite"]).has(preset)) {
    throw new Error(`Unknown --agent-preset: ${value}. Use deck, matchup, baseline-suite, or custom.`);
  }
  return preset;
}

function pushValueIfChanged(args, flag, value, defaultValue) {
  if (String(value ?? "") === String(defaultValue ?? "")) return;
  args.push(flag, String(value));
}

function splitList(value) {
  return String(value ?? "")
    .split(/[\r\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function profileActionModelPath(agentRoot, ownKey, baselineRoot) {
  return actionModelPathForKey(ownKey, { agentRoot, baselineRoot });
}

function defaultMlModelPath(agentRoot, ownKey, baselineRoot) {
  for (const profilePath of actionModelCandidatePathsForKey(ownKey, { agentRoot, baselineRoot })) {
    if (existsSync(profilePath)) return profilePath;
  }
  return join(agentRoot, "current-action-model.json");
}

function policyKeySegment(value) {
  return routePolicyKeySegment(value);
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

function usage() {
  console.log(`Usage:
  node tools/pilot-loop-overseer.mjs --training-mode matchup --deck carnerr-spear --own-key eva-purple-spear-eva-13 --opponent-set RNK --opponent-color red --seed 13201
  node tools/pilot-loop-overseer.mjs --training-mode deck --deck carnerr-spear --own-key eva-purple-spear-eva-13 --seed 13201

Runs a base pilot training cycle, updates matchup/action knowledge, writes a handoff,
then repeats. Hybrid focus keeps improving the deck pilot while accumulating broad
set/color matchup overlays from the decision logs. --cycles is a safety ceiling.
The overseer launches pilot-agent with --preset matchup or --preset deck, so most
low-level pilot-agent tuning flags are no longer needed on normal runs.

Useful options:
  --training-mode matchup|deck
  --training-focus hybrid|policy
  --agent-preset matchup|deck|baseline-suite|custom
  --cycles 12
  --max-cycles 12
  --deck carnerr-spear
  --own-key eva-purple-spear-eva-13
  --seed 13201
  --promote-from work/private/pilot-agent/runs/spear-matchup-iter-13101
  --baseline-root work/private/pilot-agent/baselines
  --opponent-set EVA
  --opponent-color yellow
  --opponents regional-eva-yellow-example-1
  --bootstrap-baseline-if-missing

Preset override options:
  --parallel-runs 14
  --parallel-concurrency 14
  --parallel-opponent-count-per-run 1
  --games 8
  --generations 1
  --ml-strength 0.35
  --parallel-final-games 0
  --parallel-final-top-percent 25
  --parallel-final-candidates merged-baseline
  --decision-log-mode learning|final|all
  --exploration-mode counterfactual-probe|action
  --counterfactual-rollout-actions 64
  --counterfactual-rollout-player-turns 3
  --knowledge-mode full|action|matchup|none
  --matchup-validation-games 20
  --matchup-validation-gate positive|non-negative|off
  --no-matchup-validation
  --no-matchup-validation-rollback
  --accept-inconclusive-matchup-validation
  --accept-negative-matchup-validation
  --skip-parallel-final
  --no-skip-parallel-final
  --knowledge-inputs old-run-a,old-run-b
  --cumulative-knowledge             replay accepted cycle folders for an explicit rebuild/audit
  --no-cumulative-knowledge          force the default incremental-only input mode
  --stop-after-each-cycle
  --no-stop-if-no-promotion
  --no-stop-if-no-learning
  --dry-run

Outputs:
  work/private/pilot-agent/loops/<session>/loop-state.json
  work/private/pilot-agent/loops/<session>/latest-handoff.md
  work/private/pilot-agent/loops/<session>/cycle-01/handoff.md`);
}
