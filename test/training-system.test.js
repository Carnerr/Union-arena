import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { shouldAdvanceAutoRefinerDeck } from "../src/auto-refiner-scheduling.js";
import {
  COUNTERFACTUAL_STATE_EVALUATION_VERSION,
  DEFAULT_PILOT_POLICY,
  LEARNING_GAME_TELEMETRY_SCHEMA,
  MAX_ML_RUNTIME_VALIDATION_INPUT_CONFLICT_RATE,
  MIN_LEARNING_EVIDENCE_FILTER_VERSION,
  MIN_LEARNING_SOURCE_DIGEST_VERSION,
  MIN_ML_EVIDENCE_DIVERSITY_VERSION,
  MIN_ML_FEATURE_SELECTION_VERSION,
  MIN_ML_PAIRWISE_EFFECTIVE_WEIGHT_VERSION,
  MIN_ML_PAIRWISE_INPUT_CONSISTENCY_VERSION,
  MIN_ML_PAIRWISE_ORIENTATION_VERSION,
  MIN_ML_REGRESSION_VERSION,
  MIN_ML_VALIDATION_DIVERSITY_VERSION,
  MIN_ML_VALIDATION_STATE_VERSION,
  PILOT_PERFORMANCE_SCORE_VERSION,
  addLinearFeatureExample,
  allocateDecisionCredits,
  actionModelPathForKey,
  applyActionModelRuntimeChangeGate,
  applyMatchupOverlayExposureGate,
  baselineOriginPathForKey,
  baselinePolicyPathForKey,
  comparePairedMatchupEvaluations,
  combineKnowledgeArtifactComparisons,
  completedMatchupMetricSummary,
  createLearningEvidenceFilter,
  counterfactualAlternativeRows,
  counterfactualPairwiseLearningEvidence,
  counterfactualTestedActionFamilies,
  fitMultivariateRidge,
  learningDecisionGroupFingerprint,
  learningEvidenceFilterAdd,
  learningEvidenceFilterHas,
  learningEvidenceFilterStats,
  learningValidationGameKey,
  knowledgeArtifactValidationPlan,
  makeRng,
  mlActionModelReadiness,
  matchupOverlayCandidatePathForKeys,
  matchupOverlayReadiness,
  mutablePolicyFeatureGroups,
  mutatePilotPolicyWeights,
  pairwiseEvidenceDiversityKeys,
  pairwiseInputConsistencySummary,
  pilotPolicyFeatureGroup,
  pilotPerformanceScore,
  pilotAgentPresetDefaults,
  pilotDashboardTrainingDefaults,
  pilotTrainingModeDefaults,
  provisionalActionLearningEligible,
  promotionEvidenceGate,
  promotionQualityGate,
  restoreDirectorySnapshotSync,
  recommendedTrainingWorkerBudget,
  serializeLearningEvidenceFilter,
  selectDecisionLogCandidates,
  trainingResourcePlan,
  writeBaselineOriginForProfile,
  writeJsonAtomicSync
} from "../src/index.js";

function trustedMlEvidenceDiversity() {
  return {
    pairwiseEffectiveWeightVersion: MIN_ML_PAIRWISE_EFFECTIVE_WEIGHT_VERSION,
    pairwiseEffectiveWeight: 12,
    evidenceDiversityVersion: MIN_ML_EVIDENCE_DIVERSITY_VERSION,
    pairwiseEvidenceDiversity: {
      version: MIN_ML_EVIDENCE_DIVERSITY_VERSION,
      trackedExamples: 40,
      historicalUnclassifiedExamples: 0,
      phaseCounts: { attack: 13, block: 13, main: 14 },
      actionPairCounts: {
        "advancePhase <-> playCard:energyLine": 14,
        "declareAttack <-> advancePhase": 13,
        "declareBlock <-> declineBlock": 13
      },
      opponentProfileCounts: { "rnk-red": 20, "tsk-blue": 20 },
      evidenceKindCounts: { "bounded-state-evaluation": 40 }
    }
  };
}

function trustedMlValidation(heldoutPlayerGames = 8) {
  const retainedGameCount = Math.max(1, Math.min(30, heldoutPlayerGames));
  const playerGameCounts = {};
  for (let index = 0; index < 30; index += 1) {
    const key = `heldout-game-${index % retainedGameCount}`;
    playerGameCounts[key] = Number(playerGameCounts[key] ?? 0) + 1;
  }
  return {
    fraction: 0.2,
    heldoutPlayerGames,
    pairwise: {
      examples: 30,
      weightTotal: 12,
      signAccuracy: 0.75,
      balancedSignAccuracy: 0.75,
      positiveExamples: 15,
      negativeExamples: 15,
      inputConsistency: {
        version: MIN_ML_PAIRWISE_INPUT_CONSISTENCY_VERSION,
        complete: true,
        trackedExamples: 30,
        contexts: 12,
        repeatedContexts: 6,
        repeatedExamples: 18,
        repeatedWeight: 7.2,
        conflictingContexts: 0,
        minorityWeight: 0,
        conflictRate: 0
      },
      validationDiversity: {
        version: MIN_ML_VALIDATION_DIVERSITY_VERSION,
        trackedExamples: 30,
        phaseCounts: { main: 10, attack: 10, block: 10 },
        actionPairCounts: {
          "advancephase <-> playcard:energyline": 10,
          "advancephase <-> declareattack": 10,
          "declineblock <-> declareblock": 10
        },
        opponentProfileCounts: { "rnk-red": 15, "tsk-blue": 15 },
        playerGameCounts,
        evidenceKindCounts: { horizon: 30 },
        actionPairReliability: [
          { key: "advancephase <-> playcard:energyline", examples: 10, weightTotal: 4, signAccuracy: 0.7, balancedSignAccuracy: 0.7, positiveExamples: 5, negativeExamples: 5, distinctPlayerGames: Math.min(retainedGameCount, 8) },
          { key: "advancephase <-> declareattack", examples: 10, weightTotal: 4, signAccuracy: 0.8, balancedSignAccuracy: 0.8, positiveExamples: 5, negativeExamples: 5, distinctPlayerGames: Math.min(retainedGameCount, 8) },
          { key: "declineblock <-> declareblock", examples: 10, weightTotal: 4, signAccuracy: 0.7, balancedSignAccuracy: 0.7, positiveExamples: 5, negativeExamples: 5, distinctPlayerGames: Math.min(retainedGameCount, 8) }
        ]
      }
    }
  };
}

function causallyReadyMatchupOverlay(overrides = {}) {
  return {
    ...trustedMlEvidenceDiversity(),
    schema: "union-arena-local-engine/matchup-overlay@1",
    learningSignalVersion: 2,
    trainingPipelineVersion: 2,
    sourceDigestVersion: MIN_LEARNING_SOURCE_DIGEST_VERSION,
    learningEvidenceFilterVersion: MIN_LEARNING_EVIDENCE_FILTER_VERSION,
    regressionVersion: MIN_ML_REGRESSION_VERSION,
    counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION,
    learningSignalTrust: 1,
    includeChosenAnchor: false,
    examples: 40,
    pairwiseExamples: 40,
    weights: { playCard: 10 },
    ...overrides
  };
}

function causallyReadyActionModel(overrides = {}) {
  return {
    ...trustedMlEvidenceDiversity(),
    schema: "union-arena-local-engine/ml-action-model@1",
    learningSignalVersion: 2,
    trainingPipelineVersion: 2,
    sourceDigestVersion: MIN_LEARNING_SOURCE_DIGEST_VERSION,
    learningEvidenceFilterVersion: MIN_LEARNING_EVIDENCE_FILTER_VERSION,
    validationAssignmentVersion: 2,
    validationStateVersion: MIN_ML_VALIDATION_STATE_VERSION,
    pairwiseOrientationVersion: MIN_ML_PAIRWISE_ORIENTATION_VERSION,
    regressionVersion: MIN_ML_REGRESSION_VERSION,
    counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION,
    learningSignalTrust: 0.8,
    includeChosenAnchor: false,
    examples: 100,
    pairwiseExamples: 40,
    validation: trustedMlValidation(8),
    weights: { playCard: 100 },
    ...overrides
  };
}

test("atomic JSON artifacts replace complete files", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-artifact-"));
  try {
    const path = join(root, "nested", "state.json");
    writeJsonAtomicSync(path, { version: 1, rows: [1, 2] });
    writeJsonAtomicSync(path, { version: 2, rows: [3] });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { version: 2, rows: [3] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pairwise evidence treats nested resolution branches as distinct action families", () => {
  const common = {
    actionType: "resolutionChoice",
    phase: "attack",
    matchupProfileKey: "rnk-red"
  };
  const accept = {
    ...common,
    action: {
      type: "resolutionChoice",
      decisionKind: "optionalEffect",
      resolutionOption: "accept"
    }
  };
  const decline = {
    ...common,
    action: {
      type: "resolutionChoice",
      decisionKind: "optionalEffect",
      resolutionOption: "decline"
    }
  };

  assert.equal(
    pairwiseEvidenceDiversityKeys(accept, decline).actionPair,
    "resolutionChoice:optionaleffect:accept <-> resolutionChoice:optionaleffect:decline"
  );

  const legacyRaidMove = {
    ...common,
    action: { type: "resolutionChoice", decisionKind: "raidTrigger" },
    features: {
      "context.choice.raid-card.resolution-raidtrigger.performraid.true": 1,
      "context.choice.raid-card.resolution-raidtrigger.movetofront.true": 1,
      "context.resolution.raid-card.raidtrigger.replace.card.old-front": 1
    }
  };
  const legacyRaidStay = {
    ...common,
    action: { type: "resolutionChoice", decisionKind: "raidTrigger" },
    features: {
      "context.choice.raid-card.resolution-raidtrigger.performraid.true": 1,
      "context.choice.raid-card.resolution-raidtrigger.movetofront.false": 1
    }
  };
  assert.equal(
    pairwiseEvidenceDiversityKeys(legacyRaidMove, legacyRaidStay).actionPair,
    "resolutionChoice:raidtrigger:raid-move-replace <-> resolutionChoice:raidtrigger:raid-stay"
  );

  const raidMove = {
    ...common,
    action: { type: "performRaid", moveToFront: true, replacesPermanent: true }
  };
  const raidStay = {
    ...common,
    action: { type: "performRaid", moveToFront: false, targetLine: "energyLine" }
  };
  assert.equal(
    pairwiseEvidenceDiversityKeys(raidMove, raidStay).actionPair,
    "performRaid:move-front-replace <-> performRaid:stay-energyLine"
  );
});

test("branch coverage recognizes a causal alternative without changing the live action", () => {
  const group = [
    {
      chosen: true,
      actionIndex: 0,
      action: { type: "performRaid", moveToFront: true },
      counterfactualAlternativeIndex: 1,
      counterfactualPreference: "tie",
      counterfactualEvidenceKind: "horizon",
      counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION
    },
    {
      chosen: false,
      actionIndex: 1,
      action: { type: "performRaid", moveToFront: false, targetLine: "energyLine" }
    }
  ];

  assert.deepEqual(
    counterfactualTestedActionFamilies(group, group[0]),
    ["performRaid:stay-energyLine"]
  );
});

test("directory snapshot restore removes post-cycle artifacts when no snapshot existed", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-restore-absent-"));
  try {
    const source = join(root, "snapshot", "missing-profile");
    const target = join(root, "live", "profile");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "action-model.json"), "{}\n");

    const result = restoreDirectorySnapshotSync({ source, target });

    assert.equal(result.sourceExists, false);
    assert.equal(result.targetExisted, true);
    assert.equal(result.removedTarget, true);
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("directory snapshot restore replaces live artifacts with the snapshot", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-restore-present-"));
  try {
    const source = join(root, "snapshot", "profile");
    const target = join(root, "live", "profile");
    mkdirSync(source, { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(source, "policy.json"), "{\"name\":\"before\"}\n");
    writeFileSync(join(target, "policy.json"), "{\"name\":\"after\"}\n");
    writeFileSync(join(target, "extra.json"), "{}\n");

    const result = restoreDirectorySnapshotSync({ source, target });

    assert.equal(result.sourceExists, true);
    assert.equal(result.restored, true);
    assert.equal(readFileSync(join(target, "policy.json"), "utf8"), "{\"name\":\"before\"}\n");
    assert.equal(existsSync(join(target, "extra.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("organized baselines keep origin metadata beside the policy", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-baseline-origin-"));
  try {
    const baselineRoot = join(root, "baselines");
    const profile = { key: "Eva Purple" };
    const policyPath = baselinePolicyPathForKey("Eva Purple", { baselineRoot });
    const originPath = baselineOriginPathForKey("Eva Purple", { baselineRoot });
    assert.equal(dirname(originPath), dirname(policyPath));
    assert.match(originPath, /baseline-origin\.json$/u);

    const writtenPath = writeBaselineOriginForProfile({
      schema: "union-arena-local-engine/baseline-origin@1",
      promotionType: "missing-seed",
      quality: "seed",
      needsTraining: true
    }, profile, { baselineRoot });
    assert.equal(writtenPath, originPath);
    assert.equal(JSON.parse(readFileSync(originPath, "utf8")).quality, "seed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dashboard HTML embeds syntactically valid client JavaScript", () => {
  const result = runTool("tools/pilot-dashboard.mjs", ["--check-html"]);
  assert.match(result.stdout, /syntactically valid/u);
});

test("dashboard all-baselines keeps deck-suite concurrency separate and CPU-safe", () => {
  const source = readFileSync("tools/pilot-dashboard.mjs", "utf8");
  assert.match(source, /BASELINE_SUITE_CONCURRENCY_DEFAULT = .*1/u);
  assert.match(source, /suiteConcurrency:\s*resourcePlan\.suiteConcurrency/u);
  assert.match(source, /function dashboardTrainingResourcePlan/u);
  assert.doesNotMatch(source, /suiteConcurrency:[^\n]*body\.parallelConcurrency/u);
  assert.doesNotMatch(source, /body\.baselineSuiteConcurrency = "1";/u);
  assert.match(source, /body\.games = "8";/u);
  assert.match(source, /body\.generations = "2";/u);
  assert.match(source, /body\.population = "4";/u);
  assert.match(source, /body\.finalGames = "8";/u);
});

test("dashboard keeps training budgets automatic and exposes only user decisions", () => {
  const source = readFileSync("tools/pilot-dashboard.mjs", "utf8");
  assert.match(source, /Opponent Deck <select id="matchupKey">/u);
  assert.doesNotMatch(source, /id="parallelRuns"/u);
  assert.doesNotMatch(source, /id="parallelConcurrency"/u);
  assert.doesNotMatch(source, /id="games"/u);
  assert.match(source, /parallelRuns: TRAINING_WORKER_BUDGET/u);
  assert.match(source, /parallelConcurrency: TRAINING_WORKER_BUDGET/u);
  assert.equal(pilotDashboardTrainingDefaults("deck").games, 20);
  assert.equal(pilotDashboardTrainingDefaults("matchup").games, 8);
});

test("training resource plans use physical-core-scale workers without oversubscribing deck suites", () => {
  assert.equal(recommendedTrainingWorkerBudget(32), 16);
  assert.equal(recommendedTrainingWorkerBudget(16), 8);

  const fullDeck = trainingResourcePlan({ logicalProcessors: 32 });
  assert.equal(fullDeck.workerBudget, 16);
  assert.equal(fullDeck.parallelRuns, 16);
  assert.equal(fullDeck.parallelConcurrency, 16);
  assert.equal(fullDeck.suiteConcurrency, 1);

  const splitSuite = trainingResourcePlan({
    logicalProcessors: 32,
    parallelRuns: 16,
    parallelConcurrency: 8
  });
  assert.equal(splitSuite.suiteConcurrency, 2);

  const capped = trainingResourcePlan({
    logicalProcessors: 32,
    workerBudget: 16,
    parallelRuns: 24,
    parallelConcurrency: 24,
    suiteConcurrency: 4
  });
  assert.equal(capped.parallelRuns, 24);
  assert.equal(capped.parallelConcurrency, 16);
  assert.equal(capped.suiteConcurrency, 1);
});

test("dashboard Auto Refine keeps baseline and profile-ML suites inside one worker budget", () => {
  const dashboard = readFileSync("tools/pilot-dashboard.mjs", "utf8");
  const refiner = readFileSync("tools/pilot-auto-refiner.mjs", "utf8");
  assert.match(dashboard, /--baseline-suite-concurrency", String\(config\.baselineSuiteConcurrency\)/u);
  assert.match(dashboard, /--action-model-suite-concurrency", String\(config\.actionModelSuiteConcurrency\)/u);
  assert.match(refiner, /--suite-concurrency"\) \?\? 1/u);
  assert.match(refiner, /--profile-suite-concurrency"\) \?\? 1/u);
});

test("Auto Refine training subprocesses stay hidden on Windows", () => {
  for (const path of [
    "tools/pilot-agent.mjs",
    "tools/pilot-auto-refiner.mjs",
    "tools/pilot-baseline-suite.mjs",
    "tools/pilot-loop-overseer.mjs",
    "tools/pilot-matchup-sweep.mjs"
  ]) {
    const source = readFileSync(path, "utf8");
    assert.match(source, /windowsHide:\s*true/u, `${path} must hide worker terminals`);
  }
});

test("auto-refiner complete mode keeps one deck locked until its matchup queue is exhausted", () => {
  assert.equal(shouldAdvanceAutoRefinerDeck({
    deckAdvanceMode: "complete",
    taskType: "matchup-sweep",
    resultStatus: 0,
    selectedTasks: 1,
    matchupLimit: 1
  }), false);
  assert.equal(shouldAdvanceAutoRefinerDeck({
    deckAdvanceMode: "complete",
    taskType: "matchup-sweep",
    resultStatus: 0,
    selectedTasks: 0,
    matchupLimit: 1
  }), true);
  assert.equal(shouldAdvanceAutoRefinerDeck({
    deckAdvanceMode: "batch",
    taskType: "matchup-sweep",
    resultStatus: 0,
    selectedTasks: 1,
    matchupLimit: 1
  }), true);
  assert.equal(shouldAdvanceAutoRefinerDeck({
    deckAdvanceMode: "complete",
    taskType: "action-model-suite",
    resultStatus: 0
  }), false);
});

test("dashboard card evidence invalidates when baseline action models change", () => {
  const source = readFileSync("tools/pilot-dashboard.mjs", "utf8");
  assert.match(source, /function cardEvidenceSourceSignature/u);
  assert.match(source, /cache\.sourceSignature === sourceSignature/u);
  assert.match(source, /dashboard-card-evidence-cache@3/u);
  assert.match(source, /diskCache\?\.schema === CARD_EVIDENCE_CACHE_SCHEMA/u);
  assert.match(source, /invalidateDashboardAnalyticsCache\(\);\s*runtimeLog\(`card evidence warm complete/u);
  assert.match(source, /CARD_EVIDENCE_WARM_DELAY_MS = .*750/u);
  assert.doesNotMatch(source, /\}, 60_000\);/u);
});

test("dashboard card pros and cons shows complete selected action counts", () => {
  const source = readFileSync("tools/pilot-dashboard.mjs", "utf8");
  assert.match(source, /actionTypes: sortedMapEntries\(card\.actionTypes\)/u);
  assert.match(source, /\["Card","Role","Evidence","Selected Actions","Pros","Concerns","Next Check"\]/u);
  assert.match(source, /function cardSelectedActionsCell/u);
  assert.match(source, /addLabel\("play to front"\)/u);
  assert.match(source, /addLabel\("raid"\)/u);
  assert.match(source, /count === 0 \? " zero"/u);
});

test("dashboard launch args preserve counterfactual learning settings", () => {
  const source = readFileSync("tools/pilot-dashboard.mjs", "utf8");
  assert.match(source, /--counterfactual-exploration-rate/u);
  assert.match(source, /counterfactualExplorationRate:\s*decimal\(body\.counterfactualExplorationRate/u);
  assert.match(source, /counterfactualMaxPerGame:\s*integer\(body\.counterfactualMaxPerGame/u);
  assert.match(source, /counterfactualRolloutActions:\s*integer\(body\.counterfactualRolloutActions/u);
  assert.match(source, /counterfactualRolloutPlayerTurns:\s*integer\(/u);
  assert.match(source, /--counterfactual-rollout-player-turns/u);
  assert.match(source, /explorationMode:\s*text\(body\.explorationMode/u);
  assert.match(source, /--exploration-mode/u);
  assert.match(source, /explorationMaxPerGame:\s*integer\(body\.explorationMaxPerGame/u);
  assert.equal(pilotDashboardTrainingDefaults("deck").counterfactualExplorationRate, 0.35);
  assert.equal(pilotDashboardTrainingDefaults("matchup").counterfactualExplorationRate, 0.4);
  assert.equal(pilotDashboardTrainingDefaults("matchup").counterfactualRolloutActions, 64);
  assert.equal(pilotDashboardTrainingDefaults("matchup").counterfactualRolloutPlayerTurns, 3);
  assert.equal(pilotDashboardTrainingDefaults("deck").explorationMode, "counterfactual-probe");
  assert.equal(pilotDashboardTrainingDefaults("matchup").explorationMode, "counterfactual-probe");
});

test("dashboard launch contracts pass every visible training default to the overseer", () => {
  const lowLevelDeck = pilotAgentPresetDefaults("deck");
  const overseerDeck = pilotTrainingModeDefaults("deck");
  const dashboardDeck = pilotDashboardTrainingDefaults("deck");
  assert.equal(overseerDeck.games, lowLevelDeck.games);
  assert.equal(overseerDeck.parallelOpponentCountPerRun, lowLevelDeck.parallelOpponentCountPerRun);
  assert.equal(dashboardDeck.games, 20);
  assert.equal(dashboardDeck.parallelOpponentCountPerRun, 6);

  const contract = JSON.parse(runTool("tools/pilot-dashboard.mjs", ["--check-launch-contract"]).stdout);
  const optionValue = (args, flag) => args[args.indexOf(flag) + 1];
  assert.equal(contract.deck.config.games, 20);
  assert.equal(contract.deck.config.parallelOpponentCountPerRun, 6);
  assert.equal(optionValue(contract.deck.args, "--games"), "20");
  assert.equal(optionValue(contract.deck.args, "--parallel-opponent-count-per-run"), "6");
  assert.equal(optionValue(contract.deck.args, "--exploration-max-per-game"), "1");
  assert.equal(optionValue(contract.deck.args, "--exploration-mode"), "counterfactual-probe");
  assert.equal(optionValue(contract.deck.args, "--counterfactual-rollout-player-turns"), "3");
  assert.equal(contract.matchup.config.games, 8);
  assert.equal(contract.matchup.config.parallelOpponentCountPerRun, 1);
  assert.equal(optionValue(contract.matchup.args, "--games"), "8");
  assert.equal(optionValue(contract.matchup.args, "--parallel-opponent-count-per-run"), "1");
  assert.equal(optionValue(contract.matchup.args, "--exploration-mode"), "counterfactual-probe");
  assert.equal(contract.deck.config.parallelConcurrency, contract.deck.config.resourcePlan.workerBudget);
  assert.equal(contract.baselines.config.suiteConcurrency, 1);
  assert.equal(contract.baselines.config.parallelConcurrency, contract.baselines.config.resourcePlan.workerBudget);
  assert.equal(optionValue(contract.autoRefine.args, "--baseline-suite-concurrency"), "1");
  assert.equal(optionValue(contract.autoRefine.args, "--action-model-suite-concurrency"), "1");
  assert.equal(contract.autoRefine.config.parallelConcurrency, contract.autoRefine.config.resourcePlan.workerBudget);

  const dashboardSource = readFileSync("tools/pilot-dashboard.mjs", "utf8");
  assert.match(dashboardSource, /child\.on\("error"/u);
  assert.match(dashboardSource, /signal:\s*"spawn-error"/u);
});

test("auto-refiner adapts after weak counterfactual learning evidence", () => {
  const source = readFileSync("tools/pilot-auto-refiner.mjs", "utf8");
  assert.match(source, /--no-adaptive-learning-evidence/u);
  assert.match(source, /learningEvidenceQuality/u);
  assert.match(source, /artifactProgressAccepted/u);
  assert.match(source, /needsRicherSampling/u);
  assert.match(source, /needsCounterfactualSampling/u);
  assert.match(source, /supported held-out action family/u);
  assert.match(source, /counterfactualExplorationRate \|\| boost\?\.counterfactualExplorationRate/u);
  assert.match(source, /explorationRate \|\| boost\?\.explorationRate/u);
  assert.match(source, /opportunity sampling/u);
  assert.match(source, /boostedExplorationRate/u);
  assert.match(source, /--exploration-max-per-game/u);
  assert.match(source, /samplingTelemetryAvailable/u);
  assert.match(source, /actionableCounterfactualsPerPlayerGame/u);
  assert.match(source, /unsynchronizedCounterfactualRate/u);
  assert.match(source, /boostedCounterfactualRolloutActions/u);
});

test("matchup sweep waits for profile ML and forwards rich evidence settings", () => {
  const source = readFileSync("tools/pilot-matchup-sweep.mjs", "utf8");
  assert.match(source, /allowUnreadyActionModel/u);
  assert.match(source, /deck\.actionModelReady/u);
  assert.match(source, /--allow-unready-action-model/u);
  assert.match(source, /--counterfactual-exploration-rate/u);
  assert.match(source, /--counterfactual-max-per-game/u);
  assert.match(source, /--counterfactual-rollout-actions/u);
  assert.match(source, /--counterfactual-rollout-player-turns/u);
});

test("matchup sweep reports unready profiles and permits explicit missing-baseline bootstrap", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-matchup-bootstrap-"));
  try {
    const agentRoot = join(root, "pilot-agent");
    const library = join(root, "decks");
    const blockedOut = join(root, "blocked");
    const bootstrapOut = join(root, "bootstrap");
    mkdirSync(library, { recursive: true });
    writeFileSync(join(root, "catalog.json"), "{}\n");
    writeSavedDeck(join(library, "carnerr-a.json"), {
      id: "carnerr-a",
      name: "Carnerr A",
      summary: { sourceCode: "EVA", colors: ["purple"] },
      cards: [{ id: "card-a", count: 50 }]
    });
    writeSavedDeck(join(library, "regional-b.json"), {
      id: "regional-b",
      name: "Regional B",
      summary: { sourceCode: "TSK", colors: ["blue"] },
      cards: [{ id: "card-b", count: 50 }]
    });
    const common = [
      "--dry-run",
      "--agent-root", agentRoot,
      "--library", library,
      "--catalog", join(root, "catalog.json"),
      "--baseline-root", join(agentRoot, "baselines"),
      "--runs-root", join(agentRoot, "runs"),
      "--deck", "carnerr-a",
      "--limit", "1"
    ];

    runTool("tools/pilot-matchup-sweep.mjs", [...common, "--out-root", blockedOut]);
    const blocked = readJson(join(blockedOut, "matchup-sweep-state.json"));
    assert.equal(blocked.selectedTasks.length, 0);
    assert.equal(blocked.excludedPilotDecks[0].actionModelStatus, "missing");
    assert.match(blocked.stopReason, /specialist baseline is not ready/u);

    runTool("tools/pilot-matchup-sweep.mjs", [
      ...common,
      "--out-root", bootstrapOut,
      "--bootstrap-baseline-if-missing"
    ]);
    const bootstrap = readJson(join(bootstrapOut, "matchup-sweep-state.json"));
    assert.equal(bootstrap.selectedTasks.length, 1);
    assert.match(bootstrap.results[0].command, /--bootstrap-baseline-if-missing/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("matchup sweep deduplicates copied seeded games for the same policy", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-matchup-game-dedup-"));
  try {
    const agentRoot = join(root, "pilot-agent");
    const library = join(root, "decks");
    const runsRoot = join(agentRoot, "runs");
    const baselineRoot = join(agentRoot, "baselines");
    const outRoot = join(root, "sweep");
    mkdirSync(library, { recursive: true });
    writeFileSync(join(root, "catalog.json"), "{}\n");
    writeSavedDeck(join(library, "carnerr-a.json"), {
      id: "carnerr-a",
      name: "Carnerr A",
      summary: { sourceCode: "EVA", colors: ["purple"] },
      cards: [{ id: "card-a", count: 50 }]
    });
    writeSavedDeck(join(library, "regional-b.json"), {
      id: "regional-b",
      name: "Regional B",
      summary: { sourceCode: "TSK", colors: ["blue"] },
      cards: [{ id: "card-b", count: 50 }]
    });
    writeJsonAtomicSync(baselinePolicyPathForKey("eva-purple", { baselineRoot }), { name: "trained", weights: { playCard: 10 } });
    writeJsonAtomicSync(baselineOriginPathForKey("eva-purple", { baselineRoot }), {
      quality: "trained",
      promotionType: "improved",
      needsTraining: false
    });
    writeJsonAtomicSync(actionModelPathForKey("eva-purple", { agentRoot, baselineRoot }), {
      ...trustedMlEvidenceDiversity(),
      learningSignalVersion: 2,
      trainingPipelineVersion: 2,
      sourceDigestVersion: MIN_LEARNING_SOURCE_DIGEST_VERSION,
      learningEvidenceFilterVersion: MIN_LEARNING_EVIDENCE_FILTER_VERSION,
      validationAssignmentVersion: 2,
      validationStateVersion: MIN_ML_VALIDATION_STATE_VERSION,
      pairwiseOrientationVersion: MIN_ML_PAIRWISE_ORIENTATION_VERSION,
      regressionVersion: MIN_ML_REGRESSION_VERSION,
      counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION,
      learningSignalTrust: 1,
      examples: 100,
      pairwiseExamples: 30,
      validation: trustedMlValidation(8),
      weights: {}
    });
    const copiedReport = {
      config: { policySelection: { profile: { key: "eva-purple" } } },
      bestPolicy: { name: "best-policy", weights: { playCard: 10 } },
      games: [{
        seed: 444,
        candidateId: "best-policy",
        opponent: "regional-b",
        firstPlayer: "P1",
        winner: "P1",
        p1LifeRemaining: 1,
        p2LifeRemaining: 0
      }]
    };
    writeJsonAtomicSync(join(runsRoot, "run-a", "report.json"), copiedReport);
    writeJsonAtomicSync(join(runsRoot, "run-b", "report.json"), copiedReport);

    runTool("tools/pilot-matchup-sweep.mjs", [
      "--dry-run",
      "--agent-root", agentRoot,
      "--library", library,
      "--catalog", join(root, "catalog.json"),
      "--baseline-root", baselineRoot,
      "--runs-root", runsRoot,
      "--out-root", outRoot,
      "--deck", "carnerr-a",
      "--limit", "1"
    ]);
    const state = readJson(join(outRoot, "matchup-sweep-state.json"));
    assert.equal(state.selectedTasks[0].currentGames, 1);
    assert.equal(state.selectedTasks[0].currentWinRate, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("matchup sweep does not treat raw game saturation as a learned matchup policy", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-matchup-causal-priority-"));
  try {
    const agentRoot = join(root, "pilot-agent");
    const library = join(root, "decks");
    const runsRoot = join(agentRoot, "runs");
    const baselineRoot = join(agentRoot, "baselines");
    const outRoot = join(root, "sweep");
    mkdirSync(library, { recursive: true });
    writeFileSync(join(root, "catalog.json"), "{}\n");
    writeSavedDeck(join(library, "carnerr-a.json"), {
      id: "carnerr-a",
      name: "Carnerr A",
      summary: { sourceCode: "EVA", colors: ["purple"] },
      cards: [{ id: "card-a", count: 50 }]
    });
    writeSavedDeck(join(library, "regional-b.json"), {
      id: "regional-b",
      name: "Regional B",
      summary: { sourceCode: "TSK", colors: ["blue"] },
      cards: [{ id: "card-b", count: 50 }]
    });
    writeJsonAtomicSync(baselinePolicyPathForKey("eva-purple", { baselineRoot }), {
      name: "trained",
      weights: { playCard: 10 }
    });
    writeJsonAtomicSync(baselineOriginPathForKey("eva-purple", { baselineRoot }), {
      quality: "trained",
      promotionType: "improved",
      needsTraining: false
    });
    writeJsonAtomicSync(actionModelPathForKey("eva-purple", { agentRoot, baselineRoot }), {
      ...trustedMlEvidenceDiversity(),
      learningSignalVersion: 2,
      trainingPipelineVersion: 2,
      sourceDigestVersion: MIN_LEARNING_SOURCE_DIGEST_VERSION,
      learningEvidenceFilterVersion: MIN_LEARNING_EVIDENCE_FILTER_VERSION,
      validationAssignmentVersion: 2,
      validationStateVersion: MIN_ML_VALIDATION_STATE_VERSION,
      pairwiseOrientationVersion: MIN_ML_PAIRWISE_ORIENTATION_VERSION,
      regressionVersion: MIN_ML_REGRESSION_VERSION,
      counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION,
      learningSignalTrust: 1,
      examples: 100,
      pairwiseExamples: 30,
      validation: trustedMlValidation(8),
      weights: {}
    });
    writeJsonAtomicSync(join(runsRoot, "saturated", "report.json"), {
      config: { policySelection: { profile: { key: "eva-purple" } } },
      bestPolicy: { name: "best-policy", weights: { playCard: 10 } },
      games: Array.from({ length: 60 }, (_, index) => ({
        seed: 8000 + index,
        candidateId: "best-policy",
        opponent: "regional-b",
        firstPlayer: index % 2 === 0 ? "P1" : "P2",
        winner: "P1",
        p1LifeRemaining: 2,
        p2LifeRemaining: 0
      }))
    });

    runTool("tools/pilot-matchup-sweep.mjs", [
      "--dry-run",
      "--mode", "low-sample",
      "--target-games", "60",
      "--agent-root", agentRoot,
      "--library", library,
      "--catalog", join(root, "catalog.json"),
      "--baseline-root", baselineRoot,
      "--runs-root", runsRoot,
      "--out-root", outRoot,
      "--deck", "carnerr-a",
      "--limit", "1"
    ]);
    const state = readJson(join(outRoot, "matchup-sweep-state.json"));
    assert.equal(state.selectedTasks.length, 1);
    assert.equal(state.selectedTasks[0].currentGames, 60);
    assert.equal(state.selectedTasks[0].matchupLearning.runtimeReady, false);
    assert.equal(state.selectedTasks[0].matchupLearning.runtimeStatus, "missing");
    assert.ok(state.selectedTasks[0].priorityDetails.reasons.includes("matchup-evidence-missing:+12000"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("matchup validation quarantines candidates until the overseer stamps a positive result", () => {
  const validator = readFileSync("tools/validate-matchup-impact.mjs", "utf8");
  const overseer = readFileSync("tools/pilot-loop-overseer.mjs", "utf8");
  assert.match(validator, /allowUnvalidated:\s*variant\.allowUnvalidatedOverlays === true/u);
  assert.match(validator, /policyBaselineRoot:\s*config\.baselineRoot[\s\S]*overlayBaselineRoot:\s*config\.beforeBaselineRoot/u);
  assert.match(validator, /applyMatchupOverlayExposureGate/u);
  assert.match(validator, /combineKnowledgeArtifactComparisons/u);
  assert.match(validator, /id:\s*"action-only"/u);
  assert.match(validator, /candidateOverlayDecisionCount/u);
  assert.match(overseer, /stampPositivelyValidatedOverlays/u);
  assert.match(overseer, /learningAcceptance\.accepted[\s\S]*matchupValidationSummaryValue\?\.verdict === "positive"/u);
  assert.match(overseer, /stampMatchupOverlayImpactValidation/u);
  assert.match(overseer, /observedCandidateOverlayPaths\.has/u);
  assert.match(overseer, /--validation-target/u);
  assert.match(overseer, /validationTargetForCycle/u);
});

test("dashboard surfaces ML runtime readiness using engine thresholds", () => {
  const source = readFileSync("tools/pilot-dashboard.mjs", "utf8");
  assert.match(source, /MIN_ML_RUNTIME_PAIRWISE_EXAMPLES/u);
  assert.match(source, /MIN_ML_RUNTIME_PAIRWISE_EFFECTIVE_WEIGHT/u);
  assert.match(source, /MIN_ML_RUNTIME_DISTINCT_ACTION_PAIRS/u);
  assert.match(source, /function modelRuntimeReadiness/u);
  assert.match(source, /runtimeReadiness/u);
  assert.match(source, /Collecting Evidence/u);
  assert.match(source, /pairwiseTarget/u);
  assert.match(source, /breadth-tracked/u);
  assert.match(source, /effective pairwise weight/u);
});

test("parallel child watchdog and dashboard stale-child health are wired", () => {
  const agentSource = readFileSync("tools/pilot-agent.mjs", "utf8");
  const dashboardSource = readFileSync("tools/pilot-dashboard.mjs", "utf8");
  assert.match(agentSource, /child-status\.json/u);
  assert.match(agentSource, /parallelChildTimeoutMinutes/u);
  assert.match(agentSource, /parallelChildStaleMinutes/u);
  assert.match(agentSource, /exceeded \$\{reason\}; terminating child process/u);
  assert.match(dashboardSource, /function parallelChildHealth/u);
  assert.match(dashboardSource, /Parallel children:/u);
  assert.match(dashboardSource, /Stale child/u);
});

test("pilot learning decision filter keeps counterfactual evidence rows", () => {
  const source = readFileSync("tools/pilot-agent.mjs", "utf8");
  assert.match(
    source,
    /decisionFilter === "exploration"\s*\?\s*decisions\.filter\(\(decision\) => Boolean\(decision\.exploration \|\| decision\.counterfactual\)\)/u
  );
});

test("compact learning logs retain the chosen and exact counterfactual actions", () => {
  const candidates = Array.from({ length: 6 }, (_, index) => ({
    index,
    score: 600 - index * 100,
    chosen: index === 5,
    features: index === 2 ? { playRaidCardNormally: 1 } : {}
  }));
  const selected = selectDecisionLogCandidates(candidates, {
    maxCandidates: 2,
    counterfactualAlternativeIndex: 4
  });
  assert.deepEqual(selected.map((candidate) => candidate.index), [4, 5]);
  const chosenOnly = selectDecisionLogCandidates(candidates, { maxCandidates: 1 });
  assert.deepEqual(chosenOnly.map((candidate) => candidate.index), [5]);
  const withRequiredOpportunity = selectDecisionLogCandidates(candidates, {
    maxCandidates: 1,
    requiredCandidateFilter: (candidate) => Number(candidate.features?.playRaidCardNormally ?? 0) > 0
  });
  assert.deepEqual(withRequiredOpportunity.map((candidate) => candidate.index), [2, 5]);
});

test("policy promotion quality rejects tiny or incomplete final evaluations", () => {
  assert.equal(promotionQualityGate({ total: 7, wins: 7 }, { minGames: 8 }).ok, false);
  assert.match(
    promotionQualityGate({ total: 8, wins: 7, incomplete: 2 }, { maxIncompleteRate: 0.2 }).reason,
    /incomplete rate/u
  );
  assert.equal(
    promotionQualityGate({ total: 8, wins: 0, incomplete: 0 }, { initialBaseline: false }).ok,
    true
  );
});

test("pilot performance scoring does not reward fast losses or punish deliberate long games", () => {
  const common = { total: 20, wins: 10, incomplete: 0, avgLifeDiff: 0.5 };
  const fast = pilotPerformanceScore({ ...common, avgTurns: 6, avgTurnCycles: 3, longGameRate: 0 });
  const slow = pilotPerformanceScore({ ...common, avgTurns: 20, avgTurnCycles: 10, longGameRate: 1 });
  assert.equal(PILOT_PERFORMANCE_SCORE_VERSION, 2);
  assert.equal(fast, slow);
  assert.ok(pilotPerformanceScore({ ...common, wins: 11 }) > fast);
  assert.ok(pilotPerformanceScore({ ...common, incomplete: 2 }) < fast);
});

test("dashboard matchup metrics separate strategic outcomes from incomplete simulations", () => {
  const summary = completedMatchupMetricSummary({
    wins: 5,
    losses: 3,
    incomplete: 2,
    completedLifeDiffTotal: 8,
    completedTurnCyclesTotal: 48,
    completedPlayerTurnsTotal: 96
  });
  assert.equal(summary.games, 10);
  assert.equal(summary.completedGames, 8);
  assert.equal(summary.winRate, 5 / 8);
  assert.equal(summary.incompleteRate, 2 / 10);
  assert.equal(summary.avgLifeDiff, 1);
  assert.equal(summary.avgTurnCycles, 6);
  assert.equal(summary.avgPlayerTurns, 12);
});

test("initial baseline promotion needs real win evidence", () => {
  const rejected = promotionQualityGate({
    total: 20,
    wins: 0,
    incomplete: 0
  }, {
    initialBaseline: true,
    minInitialWinRate: 0.05
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /initial baseline win rate/u);

  const accepted = promotionQualityGate({
    total: 20,
    wins: 1,
    incomplete: 0
  }, {
    initialBaseline: true,
    minInitialWinRate: 0.05
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.winRate, 0.05);
});

test("promotion quality derives rates from raw counts when summaries omit percentages", () => {
  const quality = promotionQualityGate({
    total: 10,
    wins: 4,
    incomplete: 1
  }, {
    maxIncompleteRate: 0.2
  });
  assert.equal(quality.ok, true);
  assert.equal(quality.winRate, 0.4);
  assert.equal(quality.incompleteRate, 0.1);

  const misleading = promotionQualityGate({
    total: 8,
    wins: 5,
    incomplete: 3,
    winRate: 1,
    incompleteRate: 0
  }, {
    maxIncompleteRate: 0.2
  });
  assert.equal(misleading.ok, false);
  assert.equal(misleading.winRate, 0.625);
  assert.equal(misleading.incompleteRate, 0.375);
  assert.match(misleading.reason, /incomplete rate/u);
});

test("trusted baseline promotion requires positive paired evidence", () => {
  const candidateSummary = { score: 101, winRate: 0.55 };
  const baselineSummary = { score: 100, winRate: 0.5 };
  const inconclusive = promotionEvidenceGate({
    candidateSummary,
    baselineSummary,
    comparison: {
      verdict: "inconclusive-small-sample",
      verdictReason: "paired evidence was mixed"
    }
  });
  assert.equal(inconclusive.promote, false);
  assert.match(inconclusive.reason, /paired promotion evidence was not positive/u);

  const positive = promotionEvidenceGate({
    candidateSummary,
    baselineSummary,
    comparison: {
      verdict: "positive",
      verdictReason: "paired games improved 5 and regressed 1"
    }
  });
  assert.equal(positive.promote, true);
  assert.equal(positive.comparison.verdict, "positive");
});

test("policy promotion rejects scores produced by different objective versions", () => {
  const decision = promotionEvidenceGate({
    candidateSummary: { score: 600, scoreVersion: 2 },
    baselineSummary: { score: 500, scoreVersion: 1 },
    comparison: { verdict: "positive" },
    requirePaired: true
  });
  assert.equal(decision.promote, false);
  assert.match(decision.reason, /cannot be compared/u);
});

test("parallel child routed baseline promotions require paired evidence", () => {
  const source = readFileSync("tools/pilot-agent.mjs", "utf8");
  const start = source.indexOf("function writeParallelChildRoutedPolicyUpdates");
  const end = source.indexOf("function baselineOriginArtifact", start);
  assert.ok(start >= 0 && end > start, "expected child routed promotion helper");
  const helper = source.slice(start, end);
  assert.match(helper, /promotionEvidenceGate/u);
  assert.match(helper, /comparison:\s*candidate\.report\?\.promotionComparison/u);
  assert.match(helper, /validatedImprovement:\s*Boolean\(promote && !writeFallbackSeed && promotionEvidence\.promote\)/u);
  assert.doesNotMatch(helper, /quality\.ok && \(missingSpecialist \|\| improved\)/u);
});

test("policy search validates the final generation champion instead of a cross-generation score high", () => {
  const source = readFileSync("tools/pilot-agent.mjs", "utf8");
  const start = source.indexOf("async function trainCommand");
  const end = source.indexOf("async function parallelTrainCommand", start);
  assert.ok(start >= 0 && end > start, "expected single-run training command");
  const command = source.slice(start, end);
  assert.match(command, /best = generationBest;/u);
  assert.match(command, /method: "last-generation-champion"/u);
  assert.doesNotMatch(command, /if \(!best \|\| row\.score > best\.score\) best = row;/u);
});

test("learning credit is phase-balanced, capped, and excludes invalid choices", () => {
  const decisions = [
    creditDecision("setup", "keepHand"),
    ...Array.from({ length: 2 }, () => creditDecision("main", "playCard")),
    ...Array.from({ length: 10 }, () => creditDecision("attack", "declareAttack"))
  ];
  const credits = allocateDecisionCredits(decisions, { complete: true });
  const total = [...credits.values()].reduce((sum, credit) => sum + credit.weight, 0);
  assert.ok(Math.abs(total - decisions.length) < 1e-9);
  assert.ok(credits.get(decisions[0]).weight > credits.get(decisions.at(-1)).weight);
  assert.equal(credits.get(decisions[0]).phase, "setup");

  const forced = creditDecision("main", "advancePhase", 1);
  assert.equal(allocateDecisionCredits([forced], { complete: true }).get(forced).weight, 0);
  assert.equal(allocateDecisionCredits([decisions[0]], { complete: false }).get(decisions[0]).weight, 0);
});

test("block choices receive a separate learning-credit phase", () => {
  const blockDecision = {
    ...creditDecision("attack", "declineBlock"),
    state: { phase: "attack", pendingAttack: true }
  };

  const credit = allocateDecisionCredits([blockDecision], { complete: true }).get(blockDecision);

  assert.equal(credit.phase, "block");
  assert.ok(credit.weight > 0);
});

test("policy mutation groups cover behavioral weights and isolate the constant score", () => {
  const groups = mutablePolicyFeatureGroups(DEFAULT_PILOT_POLICY.weights);
  const groupedFeatures = new Set([...groups.values()].flat());
  assert.equal(pilotPolicyFeatureGroup("baseScore"), "constant");
  assert.equal(groupedFeatures.has("baseScore"), false);
  for (const feature of Object.keys(DEFAULT_PILOT_POLICY.weights).filter((feature) => feature !== "baseScore")) {
    assert.ok(groupedFeatures.has(feature), `missing mutation group for ${feature}`);
  }
  assert.ok(groups.size >= 8);

  const mutation = mutatePilotPolicyWeights(DEFAULT_PILOT_POLICY.weights, makeRng(4401), {
    mutationScale: 80,
    mutationRate: 1,
    groupsPerChild: 2,
    maxFeatures: 12
  });
  const changed = Object.keys(DEFAULT_PILOT_POLICY.weights)
    .filter((feature) => mutation.weights[feature] !== DEFAULT_PILOT_POLICY.weights[feature]);
  assert.ok(changed.length >= 1 && changed.length <= 12);
  assert.equal(mutation.weights.baseScore, DEFAULT_PILOT_POLICY.weights.baseScore);
  assert.ok(new Set(changed.map(pilotPolicyFeatureGroup)).size <= 2);
});

test("healthy provisional action learning can accumulate without steering runtime play", () => {
  const provisionalModel = {
    learningSignalVersion: 2,
    trainingPipelineVersion: 2,
    sourceDigestVersion: MIN_LEARNING_SOURCE_DIGEST_VERSION,
    learningEvidenceFilterVersion: MIN_LEARNING_EVIDENCE_FILTER_VERSION,
    validationAssignmentVersion: 2,
    validationStateVersion: MIN_ML_VALIDATION_STATE_VERSION,
    pairwiseOrientationVersion: MIN_ML_PAIRWISE_ORIENTATION_VERSION,
    regressionVersion: MIN_ML_REGRESSION_VERSION,
    counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION,
    learningSignalTrust: 0.25,
    examples: 500,
    newSourceFiles: ["run-a/decision-log.jsonl"],
    validation: { ...trustedMlValidation(12), heldoutPlayerGames: 12 }
  };
  assert.equal(provisionalActionLearningEligible({
    knowledgeMode: "action",
    learningHealth: { status: "watch" },
    model: provisionalModel
  }), true);
  assert.equal(provisionalActionLearningEligible({
    knowledgeMode: "matchup",
    learningHealth: { status: "watch" },
    model: provisionalModel
  }), false);
  assert.equal(provisionalActionLearningEligible({
    knowledgeMode: "full",
    learningHealth: { status: "watch" },
    model: provisionalModel
  }), true);
  assert.equal(provisionalActionLearningEligible({
    knowledgeMode: "action",
    learningHealth: { status: "blocked" },
    model: provisionalModel
  }), false);
  assert.equal(provisionalActionLearningEligible({
    knowledgeMode: "action",
    learningHealth: { status: "healthy" },
    model: {
      ...provisionalModel,
      ...trustedMlEvidenceDiversity(),
      learningSignalTrust: 0.8,
      pairwiseExamples: 30,
      validation: trustedMlValidation(8)
    }
  }), false);
});

test("knowledge validation launches only for layers that can change runtime play", () => {
  const provisionalModel = {
    learningSignalVersion: 2,
    newSourceFiles: 1,
    runtimeTrust: 0
  };
  const readyModel = {
    ...provisionalModel,
    runtimeTrust: 0.8
  };
  const candidateChanges = {
    created: 0,
    updated: 0,
    candidateCreated: 1,
    candidateUpdated: 0
  };
  const activeChanges = {
    ...candidateChanges,
    created: 1,
    candidateCreated: 0
  };

  const inactive = knowledgeArtifactValidationPlan({
    knowledgeMode: "full",
    model: provisionalModel,
    overlayChanges: candidateChanges
  });
  assert.equal(inactive.target, "none");
  assert.equal(inactive.inactiveEvidenceChanged, true);
  assert.match(inactive.reason, /no gameplay behavior changed/u);

  const overlayOnly = knowledgeArtifactValidationPlan({
    knowledgeMode: "full",
    model: provisionalModel,
    overlayChanges: activeChanges
  });
  assert.equal(overlayOnly.target, "overlay");

  const both = knowledgeArtifactValidationPlan({
    knowledgeMode: "full",
    model: readyModel,
    overlayChanges: activeChanges
  });
  assert.equal(both.target, "full");

  const runtimeNeutral = knowledgeArtifactValidationPlan({
    knowledgeMode: "full",
    model: readyModel,
    overlayChanges: candidateChanges,
    actionRuntimeBehaviorChanged: false
  });
  assert.equal(runtimeNeutral.target, "none");
  assert.equal(runtimeNeutral.runtimeNeutralActionChanged, true);
  assert.equal(runtimeNeutral.inactiveEvidenceChanged, true);
  assert.match(runtimeNeutral.reason, /did not change effective runtime weights/u);

  const actionOnly = knowledgeArtifactValidationPlan({
    knowledgeMode: "action",
    model: readyModel,
    overlayChanges: activeChanges
  });
  assert.equal(actionOnly.target, "action");
  assert.equal(actionOnly.activeOverlayChanged, false);

  const matchupOnlyIgnoresStaleActionMetadata = knowledgeArtifactValidationPlan({
    knowledgeMode: "matchup",
    model: readyModel,
    overlayChanges: candidateChanges
  });
  assert.equal(matchupOnlyIgnoresStaleActionMetadata.target, "none");
  assert.equal(matchupOnlyIgnoresStaleActionMetadata.actionChanged, false);
  assert.equal(matchupOnlyIgnoresStaleActionMetadata.candidateOverlayChanged, true);
});

test("pairwise input consistency canonicalizes orientation and measures irreducible disagreement", () => {
  const summary = pairwiseInputConsistencySummary([
    { features: { advancePhase: -1, playCard: 1 }, target: 1, weight: 1 },
    { features: { advancePhase: 1, playCard: -1 }, target: -1, weight: 1 },
    { features: { advancePhase: -1, playCard: 1 }, target: -1, weight: 1 }
  ]);

  assert.equal(summary.contexts, 1);
  assert.equal(summary.repeatedContexts, 1);
  assert.equal(summary.conflictingContexts, 1);
  assert.equal(summary.repeatedExamples, 3);
  assert.equal(summary.minorityWeight, 1);
  assert.equal(summary.conflictRate, 1 / 3);
  assert.ok(Math.abs(summary.maximumAttainableRepeatedAccuracy - 2 / 3) < 1e-12);
  assert.equal(summary.gateEligible, false);
});

test("all launchers can share the engine action-model readiness contract", () => {
  const readyArtifact = {
    ...trustedMlEvidenceDiversity(),
    learningSignalVersion: 2,
    trainingPipelineVersion: 2,
    sourceDigestVersion: MIN_LEARNING_SOURCE_DIGEST_VERSION,
    learningEvidenceFilterVersion: MIN_LEARNING_EVIDENCE_FILTER_VERSION,
    validationAssignmentVersion: 2,
    validationStateVersion: MIN_ML_VALIDATION_STATE_VERSION,
    pairwiseOrientationVersion: MIN_ML_PAIRWISE_ORIENTATION_VERSION,
    regressionVersion: MIN_ML_REGRESSION_VERSION,
    counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION,
    learningSignalTrust: 0.8,
    examples: 100,
    pairwiseExamples: 30,
    validation: trustedMlValidation(8)
  };
  const ready = mlActionModelReadiness(readyArtifact, { minExamples: 80 });
  assert.equal(ready.ready, true);
  assert.equal(ready.runtimeTrust, 0.8);

  const samplingBlocked = mlActionModelReadiness({
    ...readyArtifact,
    samplingSafety: { status: "blocked" }
  }, { minExamples: 80 });
  assert.equal(samplingBlocked.ready, false);
  assert.equal(samplingBlocked.runtimeTrust, 0);
  assert.ok(samplingBlocked.blockerCodes.includes("blocked"));

  const conflictedValidation = trustedMlValidation(8);
  Object.assign(conflictedValidation.pairwise.inputConsistency, {
    repeatedContexts: 5,
    repeatedExamples: 20,
    repeatedWeight: 8,
    conflictingContexts: 3,
    minorityWeight: 8 * (MAX_ML_RUNTIME_VALIDATION_INPUT_CONFLICT_RATE + 0.05),
    conflictRate: MAX_ML_RUNTIME_VALIDATION_INPUT_CONFLICT_RATE + 0.05
  });
  const conflicted = mlActionModelReadiness({
    ...readyArtifact,
    learningSignalTrust: 1,
    validation: conflictedValidation
  });
  assert.equal(conflicted.ready, false);
  assert.equal(conflicted.runtimeTrust, 0);
  assert.ok(conflicted.blockerCodes.includes("conflicting-pairwise-inputs"));

  const sparseConflictValidation = trustedMlValidation(8);
  Object.assign(sparseConflictValidation.pairwise.inputConsistency, {
    repeatedContexts: 2,
    repeatedExamples: 10,
    repeatedWeight: 4,
    conflictingContexts: 2,
    minorityWeight: 2,
    conflictRate: 0.5
  });
  const sparseConflict = mlActionModelReadiness({
    ...readyArtifact,
    validation: sparseConflictValidation
  });
  assert.equal(sparseConflict.ready, true);

  const staleConsistencyValidation = trustedMlValidation(8);
  delete staleConsistencyValidation.pairwise.inputConsistency;
  const staleConsistency = mlActionModelReadiness({
    ...readyArtifact,
    validation: staleConsistencyValidation
  });
  assert.equal(staleConsistency.ready, false);
  assert.equal(staleConsistency.runtimeTrust, 0);
  assert.ok(staleConsistency.blockerCodes.includes("stale-input-consistency"));

  const disabledValidation = mlActionModelReadiness({
    ...readyArtifact,
    validation: { ...trustedMlValidation(8), fraction: 0 }
  });
  assert.equal(disabledValidation.ready, false);
  assert.ok(disabledValidation.blockerCodes.includes("disabled-validation"));

  const weakFamilyValidation = trustedMlValidation(8);
  weakFamilyValidation.pairwise.validationDiversity.actionPairReliability[1].signAccuracy = 0.4;
  const weakFamily = mlActionModelReadiness({
    ...readyArtifact,
    learningSignalTrust: 1,
    validation: weakFamilyValidation
  });
  assert.equal(weakFamily.ready, false);
  assert.ok(weakFamily.blockerCodes.includes("weak-validation-action-pair"));

  const weakGlobalValidation = trustedMlValidation(8);
  weakGlobalValidation.pairwise.balancedSignAccuracy = 0.5;
  const weakGlobal = mlActionModelReadiness({
    ...readyArtifact,
    learningSignalTrust: 1,
    validation: weakGlobalValidation
  });
  assert.equal(weakGlobal.ready, false);
  assert.equal(weakGlobal.runtimeTrust, 0);
  assert.ok(weakGlobal.blockerCodes.includes("weak-pairwise-validation"));

  const oneSidedValidation = trustedMlValidation(8);
  oneSidedValidation.pairwise.positiveExamples = 30;
  oneSidedValidation.pairwise.negativeExamples = 0;
  const oneSided = mlActionModelReadiness({
    ...readyArtifact,
    learningSignalTrust: 1,
    validation: oneSidedValidation
  });
  assert.equal(oneSided.ready, false);
  assert.equal(oneSided.runtimeTrust, 0);
  assert.ok(oneSided.blockerCodes.includes("one-sided-pairwise-validation"));

  const lowMassValidation = trustedMlValidation(8);
  lowMassValidation.pairwise.weightTotal = 0.1;
  const lowMass = mlActionModelReadiness({
    ...readyArtifact,
    learningSignalTrust: 1,
    validation: lowMassValidation
  });
  assert.equal(lowMass.ready, false);
  assert.equal(lowMass.runtimeTrust, 0);
  assert.ok(lowMass.blockerCodes.includes("low-pairwise-validation-mass"));

  const singleGameValidation = trustedMlValidation(8);
  singleGameValidation.pairwise.validationDiversity.playerGameCounts = { "one-heldout-game": 30 };
  for (const row of singleGameValidation.pairwise.validationDiversity.actionPairReliability) {
    row.distinctPlayerGames = 1;
  }
  const singleGame = mlActionModelReadiness({
    ...readyArtifact,
    learningSignalTrust: 1,
    validation: singleGameValidation
  });
  assert.equal(singleGame.ready, false);
  assert.equal(singleGame.runtimeTrust, 0);
  assert.ok(singleGame.blockerCodes.includes("narrow-validation-game-diversity"));
  assert.ok(singleGame.blockerCodes.includes("single-game-validation-action-pair"));

  const oneSidedFamilyValidation = trustedMlValidation(8);
  oneSidedFamilyValidation.pairwise.validationDiversity.actionPairReliability[0].positiveExamples = 10;
  oneSidedFamilyValidation.pairwise.validationDiversity.actionPairReliability[0].negativeExamples = 0;
  const oneSidedFamily = mlActionModelReadiness({
    ...readyArtifact,
    learningSignalTrust: 1,
    validation: oneSidedFamilyValidation
  });
  assert.equal(oneSidedFamily.ready, false);
  assert.equal(oneSidedFamily.runtimeTrust, 0);
  assert.ok(oneSidedFamily.blockerCodes.includes("one-sided-validation-action-pair"));

  const stale = mlActionModelReadiness({
    learningSignalVersion: 2,
    trainingPipelineVersion: 2,
    sourceDigestVersion: MIN_LEARNING_SOURCE_DIGEST_VERSION,
    learningEvidenceFilterVersion: MIN_LEARNING_EVIDENCE_FILTER_VERSION,
    validationAssignmentVersion: 2,
    validationStateVersion: MIN_ML_VALIDATION_STATE_VERSION,
    pairwiseOrientationVersion: MIN_ML_PAIRWISE_ORIENTATION_VERSION,
    regressionVersion: MIN_ML_REGRESSION_VERSION,
    counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION - 1,
    learningSignalTrust: 1,
    examples: 1000,
    pairwiseExamples: 100,
    validation: trustedMlValidation(100)
  });
  assert.equal(stale.ready, false);
  assert.equal(stale.status, "stale-evaluator");

  const stalePairwise = mlActionModelReadiness({
    learningSignalVersion: 2,
    trainingPipelineVersion: 2,
    sourceDigestVersion: MIN_LEARNING_SOURCE_DIGEST_VERSION,
    learningEvidenceFilterVersion: MIN_LEARNING_EVIDENCE_FILTER_VERSION,
    validationAssignmentVersion: 2,
    validationStateVersion: MIN_ML_VALIDATION_STATE_VERSION,
    pairwiseOrientationVersion: MIN_ML_PAIRWISE_ORIENTATION_VERSION - 1,
    regressionVersion: MIN_ML_REGRESSION_VERSION,
    counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION,
    learningSignalTrust: 1,
    examples: 1000,
    pairwiseExamples: 100,
    validation: trustedMlValidation(100)
  });
  assert.equal(stalePairwise.ready, false);
  assert.equal(stalePairwise.status, "stale-pairwise");

  const staleRegression = mlActionModelReadiness({
    learningSignalVersion: 2,
    trainingPipelineVersion: 2,
    sourceDigestVersion: MIN_LEARNING_SOURCE_DIGEST_VERSION,
    learningEvidenceFilterVersion: MIN_LEARNING_EVIDENCE_FILTER_VERSION,
    validationAssignmentVersion: 2,
    validationStateVersion: MIN_ML_VALIDATION_STATE_VERSION,
    pairwiseOrientationVersion: MIN_ML_PAIRWISE_ORIENTATION_VERSION,
    regressionVersion: MIN_ML_REGRESSION_VERSION - 1,
    counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION,
    learningSignalTrust: 1,
    examples: 1000,
    pairwiseExamples: 100,
    validation: trustedMlValidation(100)
  });
  assert.equal(staleRegression.ready, false);
  assert.equal(staleRegression.status, "stale-regression");

  const staleValidationState = mlActionModelReadiness({
    learningSignalVersion: 2,
    trainingPipelineVersion: 2,
    sourceDigestVersion: MIN_LEARNING_SOURCE_DIGEST_VERSION,
    learningEvidenceFilterVersion: MIN_LEARNING_EVIDENCE_FILTER_VERSION,
    validationAssignmentVersion: 2,
    validationStateVersion: MIN_ML_VALIDATION_STATE_VERSION - 1,
    pairwiseOrientationVersion: MIN_ML_PAIRWISE_ORIENTATION_VERSION,
    regressionVersion: MIN_ML_REGRESSION_VERSION,
    counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION,
    learningSignalTrust: 1,
    examples: 1000,
    pairwiseExamples: 100,
    validation: trustedMlValidation(100)
  });
  assert.equal(staleValidationState.ready, false);
  assert.equal(staleValidationState.status, "stale-validation-state");

  const staleSourceDigest = mlActionModelReadiness({
    learningSignalVersion: 2,
    trainingPipelineVersion: 2,
    sourceDigestVersion: MIN_LEARNING_SOURCE_DIGEST_VERSION - 1,
    learningEvidenceFilterVersion: MIN_LEARNING_EVIDENCE_FILTER_VERSION,
    validationAssignmentVersion: 2,
    validationStateVersion: MIN_ML_VALIDATION_STATE_VERSION,
    pairwiseOrientationVersion: MIN_ML_PAIRWISE_ORIENTATION_VERSION,
    regressionVersion: MIN_ML_REGRESSION_VERSION,
    counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION,
    learningSignalTrust: 1,
    examples: 1000,
    pairwiseExamples: 100,
    validation: trustedMlValidation(100)
  });
  assert.equal(staleSourceDigest.ready, false);
  assert.equal(staleSourceDigest.status, "stale-source-digest");

  const staleEvidenceFilter = mlActionModelReadiness({
    learningSignalVersion: 2,
    trainingPipelineVersion: 2,
    sourceDigestVersion: MIN_LEARNING_SOURCE_DIGEST_VERSION,
    learningEvidenceFilterVersion: MIN_LEARNING_EVIDENCE_FILTER_VERSION - 1,
    validationAssignmentVersion: 2,
    validationStateVersion: MIN_ML_VALIDATION_STATE_VERSION,
    pairwiseOrientationVersion: MIN_ML_PAIRWISE_ORIENTATION_VERSION,
    regressionVersion: MIN_ML_REGRESSION_VERSION,
    counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION,
    learningSignalTrust: 1,
    examples: 1000,
    pairwiseExamples: 100,
    validation: trustedMlValidation(100)
  });
  assert.equal(staleEvidenceFilter.ready, false);
  assert.equal(staleEvidenceFilter.status, "stale-evidence-filter");
});

test("runtime ML rejects concentrated evidence even when volume and validation look strong", () => {
  const concentrated = mlActionModelReadiness({
    ...trustedMlEvidenceDiversity(),
    learningSignalVersion: 2,
    trainingPipelineVersion: 2,
    sourceDigestVersion: MIN_LEARNING_SOURCE_DIGEST_VERSION,
    learningEvidenceFilterVersion: MIN_LEARNING_EVIDENCE_FILTER_VERSION,
    validationAssignmentVersion: 2,
    validationStateVersion: MIN_ML_VALIDATION_STATE_VERSION,
    pairwiseOrientationVersion: MIN_ML_PAIRWISE_ORIENTATION_VERSION,
    regressionVersion: MIN_ML_REGRESSION_VERSION,
    counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION,
    learningSignalTrust: 1,
    examples: 10_000,
    pairwiseExamples: 1_000,
    validation: trustedMlValidation(100),
    pairwiseEvidenceDiversity: {
      version: MIN_ML_EVIDENCE_DIVERSITY_VERSION,
      trackedExamples: 1_000,
      distinctPhases: 99,
      distinctActionPairs: 99,
      distinctOpponentProfiles: 99,
      phaseCounts: { main: 1_000 },
      actionPairCounts: { "advancePhase <-> playCard:energyLine": 1_000 },
      opponentProfileCounts: { "rnk-red": 1_000 }
    }
  });

  assert.equal(concentrated.ready, false);
  assert.equal(concentrated.runtimeTrust, 0);
  assert.equal(concentrated.evidenceDiversity.distinctPhases, 1);
  assert.equal(concentrated.evidenceDiversity.distinctActionPairs, 1);
  assert.equal(concentrated.evidenceDiversity.distinctOpponentProfiles, 1);
  assert.equal(concentrated.evidenceDiversity.dominantActionPairRate, 1);
  assert.ok(concentrated.blockerCodes.includes("narrow-phase-diversity"));
  assert.ok(concentrated.blockerCodes.includes("narrow-action-diversity"));
  assert.ok(concentrated.blockerCodes.includes("narrow-opponent-diversity"));
  assert.ok(concentrated.blockerCodes.includes("concentrated-action-pairs"));

  const broadEvidence = trustedMlEvidenceDiversity();
  const broadArtifact = {
    ...broadEvidence,
    learningSignalVersion: 2,
    trainingPipelineVersion: 2,
    sourceDigestVersion: MIN_LEARNING_SOURCE_DIGEST_VERSION,
    learningEvidenceFilterVersion: MIN_LEARNING_EVIDENCE_FILTER_VERSION,
    validationAssignmentVersion: 2,
    validationStateVersion: MIN_ML_VALIDATION_STATE_VERSION,
    pairwiseOrientationVersion: MIN_ML_PAIRWISE_ORIENTATION_VERSION,
    regressionVersion: MIN_ML_REGRESSION_VERSION,
    counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION,
    learningSignalTrust: 1,
    examples: 100,
    pairwiseExamples: 100,
    validation: trustedMlValidation(20)
  };
  const unclassified = mlActionModelReadiness({
    ...broadArtifact,
    pairwiseEvidenceDiversity: {
      ...broadEvidence.pairwiseEvidenceDiversity,
      historicalUnclassifiedExamples: 1
    }
  });
  assert.equal(unclassified.ready, false);
  assert.equal(unclassified.runtimeTrust, 0);
  assert.ok(unclassified.blockerCodes.includes("unclassified-evidence"));

  const lowMass = mlActionModelReadiness({
    ...broadArtifact,
    pairwiseEffectiveWeight: 0.5
  });
  assert.equal(lowMass.ready, false);
  assert.equal(lowMass.runtimeTrust, 0);
  assert.ok(lowMass.blockerCodes.includes("low-pairwise-mass"));

  const unboundedContext = mlActionModelReadiness({
    ...broadArtifact,
    weights: { "context.play.card.card-a": 10 }
  });
  assert.equal(unboundedContext.ready, false);
  assert.equal(unboundedContext.runtimeTrust, 0);
  assert.ok(unboundedContext.blockerCodes.includes("unsafe-feature-selection"));

  const boundedContextArtifact = {
    ...broadArtifact,
    weights: { "context.play.card.card-a": 10 },
    featureSelection: {
      version: MIN_ML_FEATURE_SELECTION_VERSION,
      maxFeatures: 512,
      eligible: 1,
      selected: 1,
      structuralSelected: 0,
      contextualSelected: 1,
      contextualMinObservations: 24,
      selectedContextualFeatures: ["context.play.card.card-a"]
    },
    minContextualObservations: 24,
    featureStats: {
      "context.play.card.card-a": { observations: 24, dot: 10, norm: 24 }
    }
  };
  const boundedContext = mlActionModelReadiness(boundedContextArtifact);
  assert.equal(boundedContext.ready, true);
  assert.equal(boundedContext.runtimeTrust, 1);

  const underSupportedContext = mlActionModelReadiness({
    ...boundedContextArtifact,
    featureStats: {
      "context.play.card.card-a": { observations: 23, dot: 10, norm: 23 }
    }
  });
  assert.equal(underSupportedContext.ready, false);
  assert.equal(underSupportedContext.runtimeTrust, 0);
  assert.ok(underSupportedContext.blockerCodes.includes("unsafe-feature-selection"));
});

test("matchup overlays require causal mass and within-matchup decision breadth before validation", () => {
  const ready = matchupOverlayReadiness(causallyReadyMatchupOverlay(), {
    requireImpactValidation: false
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.runtimeTrust, 1);

  const samplingBlocked = matchupOverlayReadiness(causallyReadyMatchupOverlay({
    samplingSafety: { status: "blocked" }
  }), { requireImpactValidation: false });
  assert.equal(samplingBlocked.ready, false);
  assert.equal(samplingBlocked.runtimeTrust, 0);
  assert.ok(samplingBlocked.blockerCodes.includes("blocked"));

  const lowMass = matchupOverlayReadiness(causallyReadyMatchupOverlay({
    pairwiseEffectiveWeight: 0.5
  }), { requireImpactValidation: false });
  assert.equal(lowMass.ready, false);
  assert.ok(lowMass.blockerCodes.includes("low-pairwise-mass"));

  const narrow = matchupOverlayReadiness(causallyReadyMatchupOverlay({
    pairwiseEvidenceDiversity: {
      version: MIN_ML_EVIDENCE_DIVERSITY_VERSION,
      trackedExamples: 100,
      historicalUnclassifiedExamples: 0,
      phaseCounts: { main: 100 },
      actionPairCounts: { "advancePhase <-> playCard:frontLine": 100 },
      opponentProfileCounts: { "rnk-red": 100 }
    }
  }), { requireImpactValidation: false });
  assert.equal(narrow.ready, false);
  assert.equal(narrow.runtimeTrust, 0);
  assert.ok(narrow.blockerCodes.includes("narrow-phase-diversity"));
  assert.ok(narrow.blockerCodes.includes("narrow-action-diversity"));
  assert.ok(narrow.blockerCodes.includes("concentrated-action-pairs"));
});

test("paired matchup comparison uses matching game seeds", () => {
  const beforeRows = Array.from({ length: 20 }, (_, index) => gameRow({
    index: index + 1,
    seed: 10 + index,
    winner: "P2",
    p1: 0,
    p2: 1
  }));
  const afterRows = beforeRows.map((row, index) => index < 4
    ? { ...row, winner: "P1", p1LifeRemaining: 2, p2LifeRemaining: 0 }
    : row);
  const comparison = comparePairedMatchupEvaluations({
    beforeRows,
    afterRows,
    beforeSummary: summary({ winRate: 0, score: -20, life: -1.5 }),
    afterSummary: summary({ winRate: 0.2, score: 220, life: -0.6 })
  });
  assert.equal(comparison.comparisonMethod, "paired-common-random-numbers");
  assert.equal(comparison.pairedGames, 20);
  assert.equal(comparison.improvedGames, 4);
  assert.equal(comparison.regressedGames, 0);
  assert.equal(comparison.directionalOutcomeP, 0.0625);
  assert.equal(comparison.verdict, "positive");

  const weakAfterRows = beforeRows.map((row, index) => index < 2
    ? { ...row, winner: "P1", p1LifeRemaining: 1, p2LifeRemaining: 0 }
    : row);
  const weak = comparePairedMatchupEvaluations({
    beforeRows,
    afterRows: weakAfterRows,
    beforeSummary: summary({ winRate: 0, score: -20, life: -1 }),
    afterSummary: summary({ winRate: 0.1, score: 80, life: -0.8 })
  });
  assert.equal(weak.directionalOutcomeP, 0.25);
  assert.equal(weak.verdict, "inconclusive-small-sample");

  const unpaired = comparePairedMatchupEvaluations({
    beforeRows,
    afterRows: afterRows.map((row) => ({ ...row, seed: row.seed + 100 })),
    beforeSummary: summary({ winRate: 0, score: -20, life: -1.5 }),
    afterSummary: summary({ winRate: 0.5, score: 520, life: 0.5 })
  });
  assert.equal(unpaired.pairedGames, 0);
  assert.equal(unpaired.verdict, "inconclusive-small-sample");

  const noExposure = applyMatchupOverlayExposureGate(comparison, {
    before: { pilotOverlayDecisionCount: 40 },
    after: { pilotOverlayDecisionCount: 0, candidateOverlayDecisionCount: 0 },
    overlayDelta: { changedCount: 1 },
    requiredCandidateDecisions: 10
  });
  assert.equal(noExposure.verdict, "inconclusive-no-overlay-exposure");
  assert.equal(noExposure.policyAndActionModelHeldConstant, true);

  const exposed = applyMatchupOverlayExposureGate(comparison, {
    before: { pilotOverlayDecisionCount: 40 },
    after: {
      pilotOverlayDecisionCount: 36,
      candidateOverlayDecisionCount: 24,
      candidateOverlayDecisionRate: 0.6,
      observedCandidateOverlayPaths: { "candidate.json": 24 }
    },
    overlayDelta: { changedCount: 1 },
    requiredCandidateDecisions: 10
  });
  assert.equal(exposed.verdict, "positive");
  assert.equal(exposed.exposureReady, true);
  assert.deepEqual(exposed.observedCandidateOverlayPaths, ["candidate.json"]);

  const unchangedAction = applyActionModelRuntimeChangeGate(weak, {
    before: { policyRuntimeSignature: "same" },
    after: { policyRuntimeSignature: "same" }
  });
  assert.equal(unchangedAction.verdict, "safe-no-runtime-change");
  assert.equal(unchangedAction.behaviorChanged, false);
  const changedAction = applyActionModelRuntimeChangeGate(comparison, {
    before: { policyRuntimeSignature: "before" },
    after: { policyRuntimeSignature: "after" }
  });
  assert.equal(changedAction.verdict, "positive");
  assert.equal(changedAction.behaviorChanged, true);

  const combined = combineKnowledgeArtifactComparisons({
    totalComparison: comparison,
    actionComparison: unchangedAction,
    overlayComparison: exposed
  });
  assert.equal(combined.verdict, "positive");
  assert.equal(combined.actionVerdict, "safe-no-runtime-change");
  assert.equal(combined.overlayVerdict, "positive");

  const mixed = combineKnowledgeArtifactComparisons({
    totalComparison: comparison,
    actionComparison: weak,
    overlayComparison: exposed
  });
  assert.equal(mixed.verdict, "inconclusive-composite");
});

test("ML and matchup trainers merge only new decision logs", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-learning-"));
  try {
    const first = join(root, "first.jsonl");
    const second = join(root, "second.jsonl");
    const third = join(root, "third.jsonl");
    writeDecisionFile(first, "d1", 1, { counterfactualPreference: "chosen" });
    writeDecisionFile(second, "d2", -1, { counterfactualPreference: "alternative" });
    writeDecisionFile(third, "d3", 1, { counterfactualPreference: "chosen", alternativeGap: 60, chosenCardId: "card-b" });

    const modelPath = join(root, "model.json");
    runTool("tools/train-ml-scorer.mjs", [
      "--input", first,
      "--out", modelPath,
      "--player", "P1",
      "--learning-mode", "pairwise",
      "--min-observations", "1",
      "--validation-fraction", "0"
    ]);
    assert.equal(readJson(modelPath).examples, 1);
    runTool("tools/train-ml-scorer.mjs", [
      "--input", second,
      "--out", modelPath,
      "--player", "P1",
      "--learning-mode", "pairwise",
      "--min-observations", "1",
      "--validation-fraction", "0",
      "--incremental"
    ]);
    const updatedModel = readJson(modelPath);
    assert.equal(updatedModel.examples, 2);
    assert.equal(updatedModel.pairwiseExamples, 2);
    assert.equal(updatedModel.pairwiseEffectiveWeightVersion, MIN_ML_PAIRWISE_EFFECTIVE_WEIGHT_VERSION);
    assert.equal(updatedModel.pairwiseEffectiveWeight, 1.4);
    assert.equal(updatedModel.validationSignalTrust, 0.25);
    assert.equal(updatedModel.sourceFiles.length, 2);
    assert.ok(updatedModel.trainingStats.playCard);
    assert.equal(updatedModel.trainingStats.baseScore, undefined);
    runTool("tools/train-ml-scorer.mjs", [
      "--input", second,
      "--out", modelPath,
      "--player", "P1",
      "--learning-mode", "pairwise",
      "--min-observations", "1",
      "--validation-fraction", "0",
      "--incremental"
    ]);
    assert.equal(readJson(modelPath).examples, 2);

    const baselineRoot = join(root, "baselines");
    const policyDir = join(root, "policies");
    const overlayArgs = (input, incremental = false) => [
      "--input", input,
      "--own-key", "test-own",
      "--baseline-root", baselineRoot,
      "--policy-dir", policyDir,
      "--player", "P1",
      "--group-by", "profile",
      "--learning-mode", "pairwise",
      "--min-examples", "1",
      "--min-observations", "1",
      ...(incremental ? ["--incremental"] : [])
    ];
    const activeOverlayPath = join(baselineRoot, "decks", "test-own", "matchups", "test-opponent.json");
    const overlayPath = matchupOverlayCandidatePathForKeys("test-own", "test-opponent", {
      baselineRoot,
      policyDir
    });
    runTool("tools/train-matchup-overlays.mjs", overlayArgs(first));
    const firstOverlay = readJson(overlayPath);
    assert.equal(firstOverlay.examples, 1);
    runTool("tools/train-matchup-overlays.mjs", overlayArgs(second, true));
    const updatedOverlay = readJson(overlayPath);
    assert.equal(updatedOverlay.examples, 2);
    assert.equal(updatedOverlay.pairwiseExamples, 2);
    assert.equal(updatedOverlay.pairwiseEffectiveWeightVersion, MIN_ML_PAIRWISE_EFFECTIVE_WEIGHT_VERSION);
    assert.equal(updatedOverlay.pairwiseEffectiveWeight, 1.4);
    assert.equal(updatedOverlay.evidenceDiversityVersion, MIN_ML_EVIDENCE_DIVERSITY_VERSION);
    assert.equal(updatedOverlay.pairwiseEvidenceDiversity.trackedExamples, 2);
    assert.equal(updatedOverlay.sourceFiles.length, 2);
    runTool("tools/train-matchup-overlays.mjs", overlayArgs(second, true));
    assert.equal(readJson(overlayPath).examples, 2);

    writeJsonAtomicSync(overlayPath, updatedOverlay);
    writeJsonAtomicSync(activeOverlayPath, firstOverlay);
    runTool("tools/train-matchup-overlays.mjs", overlayArgs(third, true));
    const resumedOverlay = readJson(overlayPath);
    assert.equal(resumedOverlay.examples, 3);
    assert.equal(resumedOverlay.pairwiseExamples, 3);
    assert.equal(resumedOverlay.pairwiseEffectiveWeight, 2.1);
    assert.equal(resumedOverlay.sourceFiles.length, 3);

    const provisionalRoot = join(root, "provisional-baselines");
    const provisionalArgs = (input, incremental = false) => [
      "--input", input,
      "--own-key", "test-own",
      "--baseline-root", provisionalRoot,
      "--policy-dir", policyDir,
      "--player", "P1",
      "--group-by", "profile",
      "--learning-mode", "pairwise",
      "--min-examples", "4",
      "--min-observations", "1",
      ...(incremental ? ["--incremental"] : [])
    ];
    const provisionalActivePath = join(provisionalRoot, "decks", "test-own", "matchups", "test-opponent.json");
    const provisionalCandidatePath = matchupOverlayCandidatePathForKeys("test-own", "test-opponent", {
      baselineRoot: provisionalRoot,
      policyDir
    });
    runTool("tools/train-matchup-overlays.mjs", provisionalArgs(first));
    assert.equal(existsSync(provisionalActivePath), false);
    assert.equal(readJson(provisionalCandidatePath).examples, 1);
    runTool("tools/train-matchup-overlays.mjs", provisionalArgs(second, true));
    assert.equal(existsSync(provisionalActivePath), false);
    assert.equal(readJson(provisionalCandidatePath).examples, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct ML and matchup trainers cumulatively quarantine adaptive-depth audit disagreement", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-direct-sampling-safety-"));
  try {
    const first = join(root, "first.jsonl");
    const second = join(root, "second.jsonl");
    writeFileSync(first, `${adaptiveAuditTrainingRows("first", 120_000).map((row) => JSON.stringify(row)).join("\n")}\n`);
    writeFileSync(second, `${adaptiveAuditTrainingRows("second", 121_000).map((row) => JSON.stringify(row)).join("\n")}\n`);

    const modelPath = join(root, "model.json");
    const modelArgs = (input, incremental = false) => [
      "--input", input,
      "--out", modelPath,
      "--player", "P1",
      "--learning-mode", "pairwise",
      "--min-observations", "1",
      "--validation-fraction", "0",
      ...(incremental ? ["--incremental"] : [])
    ];
    runTool("tools/train-ml-scorer.mjs", modelArgs(first));
    const firstModel = readJson(modelPath);
    assert.equal(firstModel.samplingSafety.status, "watch");
    assert.equal(firstModel.samplingSafety.adaptiveAudits, 4);
    assert.equal(firstModel.samplingSafety.adaptiveAuditDisagreements, 1);

    runTool("tools/train-ml-scorer.mjs", modelArgs(second, true));
    const blockedModel = readJson(modelPath);
    assert.equal(blockedModel.samplingSafety.status, "blocked");
    assert.equal(blockedModel.samplingSafety.adaptiveAudits, 8);
    assert.equal(blockedModel.samplingSafety.adaptiveAuditDisagreements, 2);
    assert.equal(blockedModel.learningHealth.status, "blocked");
    assert.equal(mlActionModelReadiness(blockedModel, { minExamples: 1 }).status, "blocked");

    const baselineRoot = join(root, "baselines");
    const policyDir = join(root, "policies");
    const overlayArgs = (input, incremental = false) => [
      "--input", input,
      "--own-key", "test-own",
      "--baseline-root", baselineRoot,
      "--policy-dir", policyDir,
      "--player", "P1",
      "--group-by", "profile",
      "--learning-mode", "pairwise",
      "--min-examples", "1",
      "--min-observations", "1",
      ...(incremental ? ["--incremental"] : [])
    ];
    const overlayPath = matchupOverlayCandidatePathForKeys("test-own", "test-opponent", {
      baselineRoot,
      policyDir
    });
    runTool("tools/train-matchup-overlays.mjs", overlayArgs(first));
    const firstOverlay = readJson(overlayPath);
    assert.equal(firstOverlay.samplingSafety.status, "watch");
    assert.equal(firstOverlay.samplingSafety.adaptiveAudits, 4);

    runTool("tools/train-matchup-overlays.mjs", overlayArgs(second, true));
    const blockedOverlay = readJson(overlayPath);
    assert.equal(blockedOverlay.samplingSafety.status, "blocked");
    assert.equal(blockedOverlay.samplingSafety.adaptiveAudits, 8);
    assert.equal(blockedOverlay.samplingSafety.adaptiveAuditDisagreements, 2);
    assert.equal(blockedOverlay.learningHealth.status, "blocked");
    assert.equal(matchupOverlayReadiness(blockedOverlay, { requireImpactValidation: false }).status, "blocked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("matchup trainer promotes only causally ready candidates to validation", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-matchup-causal-promotion-"));
  try {
    const input = join(root, "decisions.jsonl");
    const actionFamilies = [
      {
        phase: "main",
        chosenAction: { type: "playCard", destination: "energyLine" },
        alternativeAction: { type: "advancePhase" },
        chosenFeatures: { playCard: 1 },
        alternativeFeatures: { advancePhase: 1 }
      },
      {
        phase: "attack",
        chosenAction: { type: "declareAttack" },
        alternativeAction: { type: "advancePhase" },
        chosenFeatures: { attack: 1 },
        alternativeFeatures: { advancePhase: 1 }
      },
      {
        phase: "block",
        chosenAction: { type: "declareBlock" },
        alternativeAction: { type: "declineBlock" },
        chosenFeatures: { block: 1 },
        alternativeFeatures: { declineBlock: 1 }
      }
    ];
    const rows = [];
    for (let index = 0; index < 45; index += 1) {
      const family = actionFamilies[index % actionFamilies.length];
      const common = {
        schema: "union-arena-local-engine/pilot-decision@1",
        decisionKey: `causal-ready-${index}`,
        gameIndex: index + 1,
        seed: 90_000 + index,
        opponent: "regional-test-opponent",
        candidateId: "candidate",
        step: index + 1,
        player: "P1",
        phase: family.phase,
        creditPhase: family.phase,
        matchupProfileKey: "test-opponent",
        outcome: "win",
        reward: 1,
        shapedReward: 1,
        learningSignalVersion: 2,
        learningEligible: true,
        candidateCount: 2,
        creditWeight: 1,
        counterfactualPreference: "chosen",
        counterfactualEvidenceKind: "horizon",
        counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION,
        counterfactualAdvantage: 1,
        counterfactualConfidence: 1,
        counterfactualAlternativeIndex: 1,
        counterfactualAlternativeAction: family.alternativeAction
      };
      rows.push(
        { ...common, actionIndex: 0, chosen: true, action: family.chosenAction, features: family.chosenFeatures },
        { ...common, actionIndex: 1, chosen: false, action: family.alternativeAction, features: family.alternativeFeatures }
      );
    }
    writeFileSync(input, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const baselineRoot = join(root, "baselines");
    const policyDir = join(root, "policies");
    runTool("tools/train-matchup-overlays.mjs", [
      "--input", input,
      "--own-key", "test-own",
      "--baseline-root", baselineRoot,
      "--policy-dir", policyDir,
      "--player", "P1",
      "--group-by", "profile",
      "--learning-mode", "pairwise",
      "--min-examples", "30",
      "--min-observations", "1"
    ]);
    const activePath = join(baselineRoot, "decks", "test-own", "matchups", "test-opponent.json");
    const candidatePath = matchupOverlayCandidatePathForKeys("test-own", "test-opponent", {
      baselineRoot,
      policyDir
    });
    const overlay = readJson(activePath);
    assert.equal(existsSync(candidatePath), false);
    assert.equal(overlay.examples, 45);
    assert.equal(overlay.pairwiseExamples, 45);
    assert.equal(matchupOverlayReadiness(overlay, { requireImpactValidation: false }).ready, true);
    assert.equal(matchupOverlayReadiness(overlay).status, "unvalidated");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ML trainer persists diverse causal evidence and safely rebuilds pre-ledger statistics", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-learning-diversity-"));
  try {
    const first = join(root, "first.jsonl");
    const second = join(root, "second.jsonl");
    const pairRows = ({ key, phase, profile, chosenAction, alternativeAction, chosenFeatures, alternativeFeatures }) => {
      const common = {
        schema: "union-arena-local-engine/pilot-decision@1",
        decisionKey: key,
        gameIndex: key,
        seed: key,
        opponent: `regional-${profile}`,
        candidateId: "candidate",
        step: 1,
        player: "P1",
        phase,
        creditPhase: phase,
        matchupProfileKey: profile,
        outcome: "win",
        reward: 1,
        shapedReward: 1,
        learningSignalVersion: 2,
        learningEligible: true,
        candidateCount: 2,
        creditWeight: 1,
        counterfactualPreference: "chosen",
        counterfactualEvidenceKind: "horizon",
        counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION,
        counterfactualAdvantage: 1,
        counterfactualConfidence: 1,
        counterfactualAlternativeIndex: 1,
        counterfactualAlternativeAction: alternativeAction
      };
      return [
        { ...common, actionIndex: 0, chosen: true, action: chosenAction, features: chosenFeatures },
        { ...common, actionIndex: 1, chosen: false, action: alternativeAction, features: alternativeFeatures }
      ];
    };
    const firstRows = [
      ...pairRows({
        key: "main-pair",
        phase: "main",
        profile: "rnk-red",
        chosenAction: { type: "playCard", destination: "energyLine" },
        alternativeAction: { type: "advancePhase" },
        chosenFeatures: { playCard: 1 },
        alternativeFeatures: { advancePhase: 1 }
      }),
      ...pairRows({
        key: "attack-pair",
        phase: "attack",
        profile: "rnk-red",
        chosenAction: { type: "declareAttack" },
        alternativeAction: { type: "advancePhase" },
        chosenFeatures: { attack: 1 },
        alternativeFeatures: { advancePhase: 1 }
      }),
      ...pairRows({
        key: "block-pair",
        phase: "block",
        profile: "tsk-blue",
        chosenAction: { type: "declareBlock" },
        alternativeAction: { type: "declineBlock" },
        chosenFeatures: { block: 1 },
        alternativeFeatures: { declineBlock: 1 }
      })
    ];
    const secondRows = pairRows({
      key: "movement-pair",
      phase: "movement",
      profile: "slg-purple",
      chosenAction: { type: "moveCard", destination: "frontLine" },
      alternativeAction: { type: "advancePhase" },
      chosenFeatures: { moveToFront: 1 },
      alternativeFeatures: { advancePhase: 1 }
    });
    writeFileSync(first, `${firstRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    writeFileSync(second, `${secondRows.map((row) => JSON.stringify(row)).join("\n")}\n`);

    const trainArgs = (input, out, incremental = false) => [
      "--input", input,
      "--out", out,
      "--player", "P1",
      "--learning-mode", "pairwise",
      "--min-observations", "1",
      "--validation-fraction", "0",
      ...(incremental ? ["--incremental"] : [])
    ];
    const modelPath = join(root, "model.json");
    runTool("tools/train-ml-scorer.mjs", trainArgs(first, modelPath));
    let model = readJson(modelPath);
    assert.equal(model.evidenceDiversityVersion, MIN_ML_EVIDENCE_DIVERSITY_VERSION);
    assert.equal(model.pairwiseEvidenceDiversity.trackedExamples, 3);
    assert.equal(model.pairwiseEvidenceDiversity.distinctPhases, 3);
    assert.equal(model.pairwiseEvidenceDiversity.distinctActionPairs, 3);
    assert.equal(model.pairwiseEvidenceDiversity.distinctOpponentProfiles, 2);
    assert.equal(model.pairwiseEvidenceDiversity.actionPairCounts["declareBlock <-> declineBlock"], 1);
    assert.equal(model.pairwiseEffectiveWeight, 2.1);
    const preDiversityMigrationModel = structuredClone(model);

    runTool("tools/train-ml-scorer.mjs", trainArgs(second, modelPath, true));
    model = readJson(modelPath);
    assert.equal(model.pairwiseEvidenceDiversity.trackedExamples, 4);
    assert.equal(model.pairwiseEvidenceDiversity.distinctPhases, 4);
    assert.equal(model.pairwiseEvidenceDiversity.distinctActionPairs, 4);
    assert.equal(model.pairwiseEvidenceDiversity.distinctOpponentProfiles, 3);
    assert.equal(model.pairwiseEffectiveWeight, 2.8);

    const migrationPath = join(root, "migration-model.json");
    const legacyModel = preDiversityMigrationModel;
    delete legacyModel.evidenceDiversityVersion;
    delete legacyModel.pairwiseEvidenceDiversity;
    writeJsonAtomicSync(migrationPath, legacyModel);
    const migration = runTool("tools/train-ml-scorer.mjs", trainArgs(second, migrationPath, true));
    const migrated = readJson(migrationPath);
    assert.match(migration.stdout, /Rebuilding ML action-model statistics for evidence-diversity/u);
    assert.match(migration.stdout, /replaying 1 retained source log/u);
    assert.equal(migrated.pairwiseEvidenceDiversity.historicalUnclassifiedExamples, 0);
    assert.equal(migrated.pairwiseEvidenceDiversity.trackedExamples, 4);
    assert.equal(migrated.pairwiseEvidenceDiversity.distinctPhases, 4);
    assert.equal(migrated.pairwiseExamples, 4);
    assert.equal(migrated.pairwiseEffectiveWeight, 2.8);

    const massMigrationPath = join(root, "mass-migration-model.json");
    const preMassModel = structuredClone(preDiversityMigrationModel);
    delete preMassModel.pairwiseEffectiveWeightVersion;
    delete preMassModel.pairwiseEffectiveWeight;
    writeJsonAtomicSync(massMigrationPath, preMassModel);
    const massMigration = runTool("tools/train-ml-scorer.mjs", trainArgs(second, massMigrationPath, true));
    const massMigrated = readJson(massMigrationPath);
    assert.match(massMigration.stdout, /effective pairwise-weight/u);
    assert.match(massMigration.stdout, /replaying 1 retained source log/u);
    assert.equal(massMigrated.pairwiseEffectiveWeightVersion, MIN_ML_PAIRWISE_EFFECTIVE_WEIGHT_VERSION);
    assert.equal(massMigrated.pairwiseEffectiveWeight, 2.8);
    assert.equal(massMigrated.pairwiseEvidenceDiversity.trackedExamples, 4);

    const overlayFirst = join(root, "overlay-first.jsonl");
    const overlaySecond = join(root, "overlay-second.jsonl");
    const oneMatchup = (rows) => rows.map((row) => ({
      ...row,
      opponent: "regional-test-opponent",
      matchupProfileKey: "test-opponent"
    }));
    writeFileSync(overlayFirst, `${oneMatchup(firstRows).map((row) => JSON.stringify(row)).join("\n")}\n`);
    writeFileSync(overlaySecond, `${oneMatchup(secondRows).map((row) => JSON.stringify(row)).join("\n")}\n`);
    const baselineRoot = join(root, "overlay-baselines");
    const policyDir = join(root, "overlay-policies");
    const overlayPath = matchupOverlayCandidatePathForKeys("test-own", "test-opponent", {
      baselineRoot,
      policyDir
    });
    const overlayArgs = (input, incremental = false) => [
      "--input", input,
      "--own-key", "test-own",
      "--baseline-root", baselineRoot,
      "--policy-dir", policyDir,
      "--player", "P1",
      "--group-by", "profile",
      "--learning-mode", "pairwise",
      "--min-examples", "1",
      "--min-observations", "1",
      ...(incremental ? ["--incremental"] : [])
    ];
    runTool("tools/train-matchup-overlays.mjs", overlayArgs(overlayFirst));
    let overlay = readJson(overlayPath);
    assert.equal(overlay.pairwiseExamples, 3);
    assert.equal(overlay.pairwiseEffectiveWeight, 2.1);
    assert.equal(overlay.pairwiseEvidenceDiversity.distinctPhases, 3);
    assert.equal(overlay.pairwiseEvidenceDiversity.distinctActionPairs, 3);
    const preOverlayMigration = structuredClone(overlay);

    runTool("tools/train-matchup-overlays.mjs", overlayArgs(overlaySecond, true));
    overlay = readJson(overlayPath);
    assert.equal(overlay.pairwiseExamples, 4);
    assert.equal(overlay.pairwiseEffectiveWeight, 2.8);
    assert.equal(overlay.pairwiseEvidenceDiversity.distinctPhases, 4);
    assert.equal(overlay.pairwiseEvidenceDiversity.distinctActionPairs, 4);

    delete preOverlayMigration.pairwiseEffectiveWeightVersion;
    delete preOverlayMigration.pairwiseEffectiveWeight;
    delete preOverlayMigration.evidenceDiversityVersion;
    delete preOverlayMigration.pairwiseEvidenceDiversity;
    writeJsonAtomicSync(overlayPath, preOverlayMigration);
    const overlayMigration = runTool("tools/train-matchup-overlays.mjs", overlayArgs(overlaySecond, true));
    overlay = readJson(overlayPath);
    assert.match(overlayMigration.stdout, /Rebuilding 1 matchup overlay artifact/u);
    assert.match(overlayMigration.stdout, /replaying 1 retained source log/u);
    assert.equal(overlay.pairwiseExamples, 4);
    assert.equal(overlay.pairwiseEffectiveWeight, 2.8);
    assert.equal(overlay.pairwiseEvidenceDiversity.historicalUnclassifiedExamples, 0);
    assert.equal(overlay.pairwiseEvidenceDiversity.trackedExamples, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("learning trainers and audits deduplicate copied decision evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-learning-dedup-"));
  try {
    const first = join(root, "first.jsonl");
    const copied = join(root, "copied.jsonl");
    writeDecisionFile(first, "copied-decision", 1, { counterfactualPreference: "chosen" });
    writeFileSync(copied, readFileSync(first, "utf8"));

    const modelPath = join(root, "model.json");
    runTool("tools/train-ml-scorer.mjs", [
      "--input", `${first},${copied}`,
      "--out", modelPath,
      "--player", "P1",
      "--learning-mode", "pairwise",
      "--min-observations", "1",
      "--validation-fraction", "0"
    ]);
    const model = readJson(modelPath);
    assert.equal(model.examples, 1);
    assert.equal(model.uniqueLearningUnits, 1);
    assert.equal(model.duplicateLearningUnitsSkipped, 0);
    assert.equal(model.duplicateSourceFilesSkipped, 1);
    assert.equal(model.sourceFiles.length, 1);
    assert.equal(model.sourceContentDigests.length, 1);

    const baselineRoot = join(root, "baselines");
    runTool("tools/train-matchup-overlays.mjs", [
      "--input", `${first},${copied}`,
      "--own-key", "test-own",
      "--baseline-root", baselineRoot,
      "--policy-dir", join(root, "policies"),
      "--player", "P1",
      "--group-by", "profile",
      "--learning-mode", "pairwise",
      "--min-examples", "1",
      "--min-observations", "1"
    ]);
    const overlay = readJson(matchupOverlayCandidatePathForKeys("test-own", "test-opponent", {
      baselineRoot,
      policyDir: join(root, "policies")
    }));
    assert.equal(overlay.examples, 1);
    assert.equal(overlay.uniqueLearningUnits, 1);
    assert.equal(overlay.duplicateLearningUnitsSkipped, 0);
    assert.equal(overlay.sourceFiles.length, 1);
    assert.equal(overlay.sourceContentDigests.length, 1);

    const auditPath = join(root, "audit.json");
    runTool("tools/audit-learning-data.mjs", ["--input", `${first},${copied}`, "--out", auditPath]);
    const audit = readJson(auditPath);
    assert.equal(audit.decisionGroups, 2);
    assert.equal(audit.uniqueDecisionGroups, 1);
    assert.equal(audit.duplicateDecisionGroups, 1);
    assert.equal(audit.duplicateDecisionGroupRate, 0.5);
    assert.equal(audit.pairwiseEvidenceDiversity.trackedExamples, 1);
    assert.equal(audit.pairwiseEvidenceDiversity.distinctPhases, 1);
    assert.equal(audit.pairwiseEvidenceDiversity.distinctActionPairs, 1);
    assert.equal(audit.pairwiseEvidenceDiversity.distinctOpponentProfiles, 1);
    assert.equal(audit.pairwiseEvidenceDiversity.dominantActionPairRate, 1);
    assert.equal(audit.pairwiseInputConsistency.version, MIN_ML_PAIRWISE_INPUT_CONSISTENCY_VERSION);
    assert.equal(audit.pairwiseInputConsistency.observedExamples, 1);
    assert.equal(audit.pairwiseInputConsistency.conflictRate, 0);
    assert.equal(audit.playerGames, 2);
    assert.equal(audit.actionableCounterfactualsPerPlayerGame, 0.5);
    assert.equal(audit.counterfactualActionableRate, 0.5);

    const knowledgeDir = join(root, "knowledge");
    runTool("tools/update-pilot-knowledge.mjs", [
      "--input", `${first},${copied}`,
      "--own-key", "test-own",
      "--deck", "carnerr-spear",
      "--out-dir", knowledgeDir,
      "--agent-root", join(root, "agent"),
      "--baseline-root", join(root, "agent", "baselines"),
      "--policy-dir", join(root, "agent", "policies"),
      "--skip-ml",
      "--skip-profile-overlays",
      "--skip-variant-overlays"
    ]);
    const knowledge = readJson(join(knowledgeDir, "knowledge-update.json"));
    assert.equal(knowledge.decisions.totalRows, 4);
    assert.equal(knowledge.decisions.uniqueRows, 2);
    assert.equal(knowledge.decisions.duplicateRowsSkipped, 2);
    assert.equal(knowledge.decisions.chosenRows, 1);
    assert.equal(knowledge.decisions.pairwiseInputConsistency.version, MIN_ML_PAIRWISE_INPUT_CONSISTENCY_VERSION);
    assert.equal(knowledge.decisions.pairwiseInputConsistency.observedExamples, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("incremental trainers reject renamed prior logs while accepting genuinely new evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-learning-source-digest-"));
  try {
    const first = join(root, "first.jsonl");
    const renamedCopy = join(root, "renamed-copy.jsonl");
    const second = join(root, "second.jsonl");
    writeDecisionFile(first, "source-first", 1, { counterfactualPreference: "chosen" });
    writeFileSync(renamedCopy, readFileSync(first, "utf8"));
    writeDecisionFile(second, "source-second", -1, { counterfactualPreference: "alternative" });

    const modelPath = join(root, "model.json");
    const modelArgs = (input, incremental = false) => [
      "--input", input,
      "--out", modelPath,
      "--player", "P1",
      "--learning-mode", "pairwise",
      "--min-observations", "1",
      "--validation-fraction", "0",
      ...(incremental ? ["--incremental"] : [])
    ];
    runTool("tools/train-ml-scorer.mjs", modelArgs(first));
    const mixedUpdate = runTool("tools/train-ml-scorer.mjs", modelArgs(`${renamedCopy},${second}`, true));
    let model = readJson(modelPath);
    assert.match(mixedUpdate.stdout, /Skipped 1 previously consumed or content-identical source file/u);
    assert.equal(model.examples, 2);
    assert.equal(model.pairwiseExamples, 2);
    assert.deepEqual(model.sourceFiles, [first, second]);
    assert.deepEqual(model.newSourceFiles, [second]);
    assert.equal(model.sourceContentDigests.length, 2);
    assert.equal(model.duplicateSourceFilesSkipped, 1);

    const noOpUpdate = runTool("tools/train-ml-scorer.mjs", modelArgs(renamedCopy, true));
    model = readJson(modelPath);
    assert.match(noOpUpdate.stdout, /no new decision logs were supplied/u);
    assert.equal(model.examples, 2);
    assert.deepEqual(model.newSourceFiles, []);
    assert.equal(model.duplicateSourceFilesSkipped, 2);

    const baselineRoot = join(root, "baselines");
    const overlayPath = matchupOverlayCandidatePathForKeys("test-own", "test-opponent", {
      baselineRoot,
      policyDir: join(root, "policies")
    });
    const overlayArgs = (input, incremental = false) => [
      "--input", input,
      "--own-key", "test-own",
      "--baseline-root", baselineRoot,
      "--policy-dir", join(root, "policies"),
      "--player", "P1",
      "--group-by", "profile",
      "--learning-mode", "pairwise",
      "--min-examples", "1",
      "--min-observations", "1",
      ...(incremental ? ["--incremental"] : [])
    ];
    runTool("tools/train-matchup-overlays.mjs", overlayArgs(first));
    const overlayUpdate = runTool("tools/train-matchup-overlays.mjs", overlayArgs(`${renamedCopy},${second}`, true));
    let overlay = readJson(overlayPath);
    assert.match(overlayUpdate.stdout, /1 previously consumed overlay source/u);
    assert.equal(overlay.examples, 2);
    assert.equal(overlay.pairwiseExamples, 2);
    assert.deepEqual(overlay.sourceFiles, [first, second]);
    assert.equal(overlay.sourceContentDigests.length, 2);
    assert.equal(overlay.duplicateSourceFilesSkipped, 1);

    const noOpOverlay = runTool("tools/train-matchup-overlays.mjs", overlayArgs(renamedCopy, true));
    overlay = readJson(overlayPath);
    assert.match(noOpOverlay.stdout, /Wrote 0 matchup overlay (?:artifact )?file/u);
    assert.equal(overlay.examples, 2);
    assert.deepEqual(overlay.sourceFiles, [first, second]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("incremental trainers learn only unseen decisions from partially overlapping corpora", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-learning-overlap-"));
  try {
    const first = join(root, "first.jsonl");
    const newOnly = join(root, "new-only.jsonl");
    const combined = join(root, "combined.jsonl");
    writeDecisionFile(first, "overlap-first", 1, { counterfactualPreference: "chosen" });
    writeDecisionFile(newOnly, "overlap-second", -1, { counterfactualPreference: "alternative" });
    writeFileSync(combined, `${readFileSync(first, "utf8")}${readFileSync(newOnly, "utf8")}`);

    const modelPath = join(root, "model.json");
    const modelArgs = (input, incremental = false) => [
      "--input", input,
      "--out", modelPath,
      "--player", "P1",
      "--learning-mode", "pairwise",
      "--min-observations", "1",
      "--validation-fraction", "0",
      ...(incremental ? ["--incremental"] : [])
    ];
    runTool("tools/train-ml-scorer.mjs", modelArgs(first));
    runTool("tools/train-ml-scorer.mjs", modelArgs(combined, true));
    const model = readJson(modelPath);
    assert.equal(model.examples, 2);
    assert.equal(model.uniqueLearningUnits, 2);
    assert.equal(model.duplicateLearningUnitsSkipped, 1);
    assert.equal(model.learningEvidenceFilterStats.inserted, 2);
    assert.deepEqual(model.sourceFiles, [first, combined]);

    const baselineRoot = join(root, "baselines");
    const overlayPath = matchupOverlayCandidatePathForKeys("test-own", "test-opponent", {
      baselineRoot,
      policyDir: join(root, "policies")
    });
    const overlayArgs = (input, incremental = false) => [
      "--input", input,
      "--own-key", "test-own",
      "--baseline-root", baselineRoot,
      "--policy-dir", join(root, "policies"),
      "--player", "P1",
      "--group-by", "profile",
      "--learning-mode", "pairwise",
      "--min-examples", "1",
      "--min-observations", "1",
      ...(incremental ? ["--incremental"] : [])
    ];
    runTool("tools/train-matchup-overlays.mjs", overlayArgs(first));
    runTool("tools/train-matchup-overlays.mjs", overlayArgs(combined, true));
    const overlay = readJson(overlayPath);
    assert.equal(overlay.examples, 2);
    assert.equal(overlay.uniqueLearningUnits, 2);
    assert.equal(overlay.duplicateLearningUnitsSkipped, 1);
    assert.equal(overlay.learningEvidenceFilterStats.inserted, 2);
    assert.deepEqual(overlay.sourceFiles, [first, combined]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validation keeps correlated policy trajectories from one seeded game together", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-learning-holdout-group-"));
  try {
    const policyA = join(root, "policy-a.jsonl");
    const policyB = join(root, "policy-b.jsonl");
    const rowsA = [];
    const rowsB = [];
    for (let index = 0; index < 40; index += 1) {
      const common = {
        gameIndex: index + 1,
        seed: 91_000 + index,
        opponent: "same-opponent",
        outcome: index % 2 === 0 ? "win" : "loss",
        reward: index % 2 === 0 ? 1 : -1,
        shapedReward: index % 2 === 0 ? 1 : -1,
        candidateCount: 2,
        learningEligible: true,
        creditWeight: 1,
        learningSignalVersion: 2,
        counterfactualPreference: "chosen",
        counterfactualAdvantage: 0.5,
        counterfactualConfidence: 1,
        counterfactualAlternativeIndex: 1,
        counterfactualAlternativeAction: { type: "advancePhase" }
      };
      rowsA.push(...decisionRows(`a-${index}`, { ...common, candidateId: "policy-a" }));
      rowsB.push(...decisionRows(`b-${index}`, { ...common, candidateId: "policy-b" }).map((row) => ({
        ...row,
        action: row.chosen
          ? { type: "playCard", cardId: "card-b" }
          : { type: "advancePhase", variant: "policy-b" },
        features: row.chosen
          ? { playCard: 1, highBpUnit: 2 }
          : { advancePhase: 1, passMissedDamage: 1 }
      })));
    }
    writeFileSync(policyA, `${rowsA.map((row) => JSON.stringify(row)).join("\n")}\n`);
    writeFileSync(policyB, `${rowsB.map((row) => JSON.stringify(row)).join("\n")}\n`);

    const modelPath = join(root, "model.json");
    runTool("tools/train-ml-scorer.mjs", [
      "--input", `${policyA},${policyB}`,
      "--out", modelPath,
      "--player", "P1",
      "--learning-mode", "pairwise",
      "--no-chosen-anchor",
      "--min-observations", "1",
      "--validation-fraction", "0.5",
      "--validation-min-training-examples", "1"
    ]);
    const model = readJson(modelPath);
    assert.equal(model.validation.assignmentKeyVersion, 2);
    assert.equal(model.uniqueLearningUnits, 80);
    assert.equal(model.duplicateLearningUnitsSkipped, 0);
    assert.equal(model.validation.heldoutDecisions, model.validation.heldoutPlayerGames * 2);
    assert.equal(model.pairwiseExamples + model.validation.pairwise.examples, 80);

    assert.equal(
      learningValidationGameKey(rowsA[0]),
      learningValidationGameKey(rowsB[0])
    );
    assert.notEqual(
      learningDecisionGroupFingerprint(rowsA.slice(0, 2)),
      learningDecisionGroupFingerprint(rowsB.slice(0, 2))
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ML incremental updates reset incompatible chosen-anchor statistics", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-learning-config-"));
  try {
    const input = join(root, "decisions.jsonl");
    const modelPath = join(root, "model.json");
    writeDecisionFile(input, "d1", 1, { counterfactualPreference: "chosen" });
    runTool("tools/train-ml-scorer.mjs", [
      "--input", input,
      "--out", modelPath,
      "--player", "P1",
      "--learning-mode", "pairwise",
      "--include-chosen-anchor",
      "--min-observations", "1",
      "--validation-fraction", "0"
    ]);
    assert.equal(readJson(modelPath).examples, 2);

    const result = runTool("tools/train-ml-scorer.mjs", [
      "--input", input,
      "--out", modelPath,
      "--player", "P1",
      "--learning-mode", "pairwise",
      "--no-chosen-anchor",
      "--min-observations", "1",
      "--validation-fraction", "0",
      "--incremental"
    ]);
    const reset = readJson(modelPath);
    assert.match(result.stdout, /Reset ML action-model statistics/u);
    assert.equal(reset.includeChosenAnchor, false);
    assert.equal(reset.examples, 1);
    assert.equal(reset.pairwiseExamples, 1);
    assert.equal(reset.sourceFiles.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("automatic knowledge updates use direct counterfactual pairs by default", () => {
  const source = readFileSync("tools/update-pilot-knowledge.mjs", "utf8");
  assert.match(source, /args\.push\("--no-chosen-anchor"\)/u);
});

test("direct learning trainers default to causal pairs and quarantine outcome-anchor experiments", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-causal-default-"));
  try {
    const input = join(root, "decisions.jsonl");
    const modelPath = join(root, "model.json");
    const baselineRoot = join(root, "baselines");
    const causalRows = decisionRows("setup-causal", {
      phase: "setup",
      step: "setup-P1",
      outcome: "win",
      reward: 1,
      shapedReward: 1,
      candidateCount: 2,
      learningSignalVersion: 2,
      learningEligible: true,
      creditWeight: 1,
      counterfactualPreference: "chosen",
      counterfactualAdvantage: 1,
      counterfactualConfidence: 1,
      counterfactualAlternativeIndex: 1,
      counterfactualAlternativeAction: { type: "keepHand" }
    }).map((row) => row.chosen
      ? { ...row, action: { type: "mulligan" }, features: {} }
      : { ...row, action: { type: "keepHand" }, features: { setupBrick: 1 } });
    const outcomeOnlyRows = decisionRows("outcome-only", {
      outcome: "win",
      reward: 1,
      shapedReward: 1,
      candidateCount: 2,
      learningSignalVersion: 2,
      learningEligible: true,
      creditWeight: 1
    }).map((row) => row.chosen
      ? { ...row, features: { spuriousWinningAction: 1 } }
      : row);
    writeFileSync(input, `${[...causalRows, ...outcomeOnlyRows].map((row) => JSON.stringify(row)).join("\n")}\n`);

    runTool("tools/train-ml-scorer.mjs", [
      "--input", input,
      "--out", modelPath,
      "--player", "P1",
      "--min-observations", "1",
      "--validation-fraction", "0"
    ]);
    const model = readJson(modelPath);
    assert.equal(model.learningMode, "pairwise");
    assert.equal(model.includeChosenAnchor, false);
    assert.equal(model.anchorEvidenceMode, "counterfactual-only");
    assert.equal(model.pairwiseExamples, 1);
    assert.ok(model.weights.setupBrick < 0);
    assert.equal(model.weights.spuriousWinningAction, undefined);

    runTool("tools/train-matchup-overlays.mjs", [
      "--input", input,
      "--own-key", "test-own",
      "--baseline-root", baselineRoot,
      "--policy-dir", join(root, "policies"),
      "--player", "P1",
      "--group-by", "profile",
      "--min-examples", "1",
      "--min-observations", "1"
    ]);
    const overlay = readJson(matchupOverlayCandidatePathForKeys("test-own", "test-opponent", {
      baselineRoot,
      policyDir: join(root, "policies")
    }));
    assert.equal(overlay.learningMode, "pairwise");
    assert.equal(overlay.includeChosenAnchor, false);
    assert.equal(overlay.anchorEvidenceMode, "counterfactual-only");
    assert.equal(overlay.weights.spuriousWinningAction, undefined);

    const outcomeModelPath = join(root, "outcome-model.json");
    runTool("tools/train-ml-scorer.mjs", [
      "--input", input,
      "--out", outcomeModelPath,
      "--player", "P1",
      "--learning-mode", "selected",
      "--min-observations", "1",
      "--validation-fraction", "0"
    ]);
    const outcomeModel = readJson(outcomeModelPath);
    assert.equal(outcomeModel.learningMode, "selected");
    assert.equal(outcomeModel.includeChosenAnchor, true);
    assert.equal(outcomeModel.anchorEvidenceMode, "raw-outcome-experimental");
    assert.ok(outcomeModel.weights.spuriousWinningAction > 0);
    const outcomeModelReadiness = mlActionModelReadiness(outcomeModel, { minExamples: 1 });
    assert.equal(outcomeModelReadiness.runtimeTrust, 0);
    assert.ok(outcomeModelReadiness.blockerCodes.includes("unsafe-outcome-anchor"));

    const outcomeBaselineRoot = join(root, "outcome-baselines");
    runTool("tools/train-matchup-overlays.mjs", [
      "--input", input,
      "--own-key", "test-own",
      "--baseline-root", outcomeBaselineRoot,
      "--policy-dir", join(root, "policies"),
      "--player", "P1",
      "--group-by", "profile",
      "--learning-mode", "selected",
      "--min-examples", "1",
      "--min-observations", "1"
    ]);
    const outcomeOverlay = readJson(matchupOverlayCandidatePathForKeys("test-own", "test-opponent", {
      baselineRoot: outcomeBaselineRoot,
      policyDir: join(root, "policies")
    }));
    assert.equal(outcomeOverlay.learningMode, "selected");
    assert.equal(outcomeOverlay.includeChosenAnchor, true);
    assert.equal(outcomeOverlay.anchorEvidenceMode, "raw-outcome-experimental");
    assert.ok(outcomeOverlay.weights.spuriousWinningAction > 0);
    const outcomeOverlayReadiness = matchupOverlayReadiness(outcomeOverlay, { requireImpactValidation: false });
    assert.equal(outcomeOverlayReadiness.runtimeTrust, 0);
    assert.ok(outcomeOverlayReadiness.blockerCodes.includes("unsafe-outcome-anchor"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parallel knowledge artifact training matches the serial fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-parallel-knowledge-"));
  try {
    const input = join(root, "decisions.jsonl");
    const rows = Array.from({ length: 8 }, (_, index) => decisionRows(`parallel-${index}`, {
      gameIndex: index + 1,
      seed: 61_000 + index,
      outcome: index % 2 === 0 ? "win" : "loss",
      reward: index % 2 === 0 ? 1 : -1,
      shapedReward: index % 2 === 0 ? 1 : -1,
      candidateCount: 2,
      learningSignalVersion: 2,
      learningEligible: true,
      creditWeight: 1,
      matchupProfileKey: "test-opponent",
      matchupVariantKey: "test-opponent__unknown-a",
      matchupVariantStatus: "unknown-variant",
      counterfactualPreference: index % 3 === 0 ? "alternative" : "chosen",
      counterfactualAdvantage: 1,
      counterfactualConfidence: 1,
      counterfactualAlternativeIndex: 1,
      counterfactualAlternativeAction: { type: "advancePhase" }
    })).flat();
    writeFileSync(input, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

    const runUpdate = (name, serial) => {
      const agentRoot = join(root, name);
      const outDir = join(agentRoot, "update");
      runTool("tools/update-pilot-knowledge.mjs", [
        "--input", input,
        "--own-key", "test-own",
        "--deck", "carnerr-spear",
        "--agent-root", agentRoot,
        "--baseline-root", join(agentRoot, "baselines"),
        "--policy-dir", join(agentRoot, "policies"),
        "--out-dir", outDir,
        "--force-knowledge-training",
        "--min-examples", "1",
        "--variant-min-examples", "1",
        "--min-observations", "1",
        ...(serial ? ["--serial-artifact-training"] : [])
      ]);
      return { agentRoot, manifest: readJson(join(outDir, "knowledge-update.json")) };
    };

    const parallel = runUpdate("parallel", false);
    const serial = runUpdate("serial", true);
    const artifact = (run, relative) => readJson(join(run.agentRoot, "baselines", "decks", "test-own", relative));
    const parallelModel = artifact(parallel, "action-model.json");
    const serialModel = artifact(serial, "action-model.json");
    assert.deepEqual(parallelModel.weights, serialModel.weights);
    for (const file of ["matchup-candidates/test-opponent.json", "matchup-candidates/test-opponent__unknown-a.json"]) {
      assert.deepEqual(artifact(parallel, file).weights, artifact(serial, file).weights);
    }
    assert.equal(parallel.manifest.learningInputs.artifactTraining.mode, "parallel");
    assert.equal(parallel.manifest.learningInputs.artifactTraining.concurrency, 3);
    assert.equal(serial.manifest.learningInputs.artifactTraining.mode, "serial");
    assert.equal(serial.manifest.learningInputs.artifactTraining.concurrency, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("learning trainers ignore incomplete and forced decisions and honor credit weights", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-credit-"));
  try {
    const input = join(root, "decisions.jsonl");
    const eligible = decisionRows("eligible", {
      outcome: "win",
      reward: 1,
      shapedReward: 1.1,
      candidateCount: 2,
      learningEligible: true,
      creditWeight: 0.5,
      learningSignalVersion: 2
    });
    const incomplete = decisionRows("incomplete", {
      outcome: "incomplete",
      reward: 0,
      shapedReward: -0.5,
      candidateCount: 2,
      learningEligible: false,
      creditWeight: 0
    });
    const forced = [decisionRows("forced", {
      outcome: "win",
      reward: 1,
      shapedReward: 1,
      candidateCount: 1,
      learningEligible: false,
      creditWeight: 0
    })[0]];
    writeFileSync(input, `${[...eligible, ...incomplete, ...forced].map((row) => JSON.stringify(row)).join("\n")}\n`);

    const modelPath = join(root, "model.json");
    runTool("tools/train-ml-scorer.mjs", [
      "--input", input,
      "--out", modelPath,
      "--player", "P1",
      "--learning-mode", "pairwise",
      "--include-chosen-anchor",
      "--min-observations", "1",
      "--validation-fraction", "0"
    ]);
    const model = readJson(modelPath);
    assert.equal(model.examples, 1);
    assert.equal(model.pairwiseExamples, 0);
    assert.equal(model.learningSignalVersion, 2);
    assert.ok(model.exampleWeightTotal > 0.1 && model.exampleWeightTotal < 0.5);

    const baselineRoot = join(root, "baselines");
    runTool("tools/train-matchup-overlays.mjs", [
      "--input", input,
      "--own-key", "test-own",
      "--baseline-root", baselineRoot,
      "--policy-dir", join(root, "policies"),
      "--player", "P1",
      "--group-by", "profile",
      "--learning-mode", "pairwise",
      "--include-chosen-anchor",
      "--min-examples", "1",
      "--min-observations", "1"
    ]);
    const overlay = readJson(matchupOverlayCandidatePathForKeys("test-own", "test-opponent", {
      baselineRoot,
      policyDir: join(root, "policies")
    }));
    assert.equal(overlay.examples, 1);
    assert.equal(overlay.pairwiseExamples, 0);
    assert.equal(overlay.learningSignalVersion, 2);
    assert.ok(overlay.exampleWeightTotal > 0.1 && overlay.exampleWeightTotal < 0.5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("counterfactual pairwise evidence learns the proven direction despite prior score distance", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-counterfactual-direction-"));
  try {
    const input = join(root, "decisions.jsonl");
    writeDecisionFile(input, "alternative-better", 1, {
      counterfactualPreference: "alternative",
      alternativeGap: 5000
    });
    const modelPath = join(root, "model.json");
    runTool("tools/train-ml-scorer.mjs", [
      "--input", input,
      "--out", modelPath,
      "--player", "P1",
      "--learning-mode", "pairwise",
      "--no-chosen-anchor",
      "--min-observations", "1",
      "--validation-fraction", "0"
    ]);
    const model = readJson(modelPath);
    assert.equal(model.pairwiseExamples, 1);
    assert.ok(model.weights.advancePhase > 0);
    assert.ok(model.weights.playCard < 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pairwise validation balances target orientation without changing the learned direction", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-pairwise-orientation-"));
  try {
    const input = join(root, "decisions.jsonl");
    const rows = [];
    for (let index = 0; index < 160; index += 1) {
      const preference = index % 3 === 0 ? "alternative" : "chosen";
      const common = {
        schema: "union-arena-local-engine/pilot-decision@1",
        decisionKey: `balanced-pair-${index}`,
        gameIndex: index + 1,
        seed: 600_000 + index,
        opponent: "regional-test-blue",
        candidateId: `policy-${index % 4}`,
        step: 2,
        player: "P1",
        phase: "main",
        outcome: "win",
        reward: 1,
        shapedReward: 1,
        learningSignalVersion: 2,
        learningEligible: true,
        candidateCount: 2,
        creditWeight: 1,
        counterfactualPreference: preference,
        counterfactualEvidenceKind: "horizon",
        counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION,
        counterfactualAdvantage: 1,
        counterfactualConfidence: 1,
        counterfactualAlternativeIndex: 1,
        counterfactualAlternativeAction: { type: "advancePhase" }
      };
      const chosenBetter = preference === "chosen";
      rows.push({
        ...common,
        chosen: true,
        actionIndex: 0,
        action: { type: "playCard", cardId: "good-line" },
        features: chosenBetter ? { strategicGood: 1 } : { strategicBad: 1 }
      }, {
        ...common,
        chosen: false,
        actionIndex: 1,
        action: { type: "advancePhase" },
        features: chosenBetter ? { strategicBad: 1 } : { strategicGood: 1 }
      });
    }
    writeFileSync(input, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const modelPath = join(root, "model.json");
    runTool("tools/train-ml-scorer.mjs", [
      "--input", input,
      "--out", modelPath,
      "--player", "P1",
      "--learning-mode", "pairwise",
      "--no-chosen-anchor",
      "--min-observations", "1",
      "--validation-fraction", "0.5"
    ]);
    const model = readJson(modelPath);
    assert.equal(model.pairwiseOrientationVersion, MIN_ML_PAIRWISE_ORIENTATION_VERSION);
    assert.equal(model.pairwiseInputConsistencyVersion, MIN_ML_PAIRWISE_INPUT_CONSISTENCY_VERSION);
    assert.equal(model.validationStateVersion, MIN_ML_VALIDATION_STATE_VERSION);
    assert.equal(model.regressionVersion, MIN_ML_REGRESSION_VERSION);
    assert.ok(model.featureCrossStats.length > 0);
    assert.ok(model.weights.strategicGood > 0);
    assert.ok(model.weights.strategicBad < 0);
    assert.ok(model.validation.pairwise.positiveExamples >= 10);
    assert.ok(model.validation.pairwise.negativeExamples >= 10);
    assert.ok(model.validation.pairwise.majoritySignBaseline < 0.7);
    assert.equal(model.validation.pairwise.balancedSignAccuracy, 1);
    assert.equal(model.validation.pairwise.inputConsistency.version, MIN_ML_PAIRWISE_INPUT_CONSISTENCY_VERSION);
    assert.equal(model.validation.pairwise.inputConsistency.complete, true);
    assert.equal(model.validation.pairwise.inputConsistency.conflictRate, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("multivariate ridge splits credit between perfectly correlated action signals", () => {
  const accumulators = new Map();
  const crossAccumulators = new Map();
  for (let index = 0; index < 100; index += 1) {
    addLinearFeatureExample({
      accumulators,
      crossAccumulators,
      features: { performRaid: 1, roleRaidPayoff: 1 },
      target: 1,
      weight: 1
    });
  }

  const fitted = fitMultivariateRidge({
    accumulators,
    crossAccumulators,
    scale: 120,
    l2: 8,
    minObservations: 1,
    maxWeight: 260
  });

  assert.equal(fitted.weights.performRaid, 58);
  assert.equal(fitted.weights.roleRaidPayoff, 58);
  assert.equal(fitted.weights.performRaid + fitted.weights.roleRaidPayoff, 116);
  assert.deepEqual(fitted.featureCrossStats, [{
    left: "performRaid",
    right: "roleRaidPayoff",
    value: 100
  }]);
});

test("card-specific action features learn opposite preferences for otherwise identical plays", () => {
  const accumulators = new Map();
  const crossAccumulators = new Map();
  for (let index = 0; index < 40; index += 1) {
    addLinearFeatureExample({
      accumulators,
      crossAccumulators,
      features: {
        "context.play.card.card-a": 1,
        "context.play.card.card-b": -1
      },
      target: 1,
      weight: 1
    });
    addLinearFeatureExample({
      accumulators,
      crossAccumulators,
      features: {
        "context.play.card.card-a": -1,
        "context.play.card.card-b": 1
      },
      target: -1,
      weight: 1
    });
  }

  const fitted = fitMultivariateRidge({
    accumulators,
    crossAccumulators,
    scale: 120,
    l2: 8,
    minObservations: 1,
    maxWeight: 260
  });

  assert.ok(fitted.weights["context.play.card.card-a"] > 0);
  assert.ok(fitted.weights["context.play.card.card-b"] < 0);
});

test("multivariate ridge retains structural features and caps sparse contextual features deterministically", () => {
  const accumulators = new Map([
    ["playCard", { dot: 8, norm: 20, count: 20 }],
    ["playToFront", { dot: 6, norm: 18, count: 18 }],
    ["context.play.card.card-a", { dot: 5, norm: 12, count: 12 }],
    ["context.play.card.card-b", { dot: 4, norm: 11, count: 11 }],
    ["context.play.card.card-c", { dot: 3, norm: 10, count: 10 }],
    ["context.play.card.card-d", { dot: 2, norm: 9, count: 9 }]
  ]);
  const options = {
    accumulators,
    crossAccumulators: new Map(),
    minObservations: 1,
    minContextualObservations: 1,
    maxFeatures: 4
  };
  const first = fitMultivariateRidge(options);
  const second = fitMultivariateRidge(options);

  assert.deepEqual(Object.keys(first.weights), [
    "context.play.card.card-a",
    "context.play.card.card-b",
    "playCard",
    "playToFront"
  ]);
  assert.deepEqual(first.weights, second.weights);
  assert.equal(first.featureSelection.selected, 4);
  assert.equal(first.featureSelection.structuralSelected, 2);
  assert.equal(first.featureSelection.contextualSelected, 2);
  assert.deepEqual(first.featureSelection.droppedContextualFeatures, [
    "context.play.card.card-c",
    "context.play.card.card-d"
  ]);
});

test("card-specific features collect evidence until the runtime support threshold", () => {
  const accumulators = new Map([
    ["playCard", { dot: 10, norm: 30, count: 30 }],
    ["context.play.card.graduated", { dot: 8, norm: 24, count: 24 }],
    ["context.play.card.collecting", { dot: 7, norm: 23, count: 23 }]
  ]);
  const fitted = fitMultivariateRidge({
    accumulators,
    crossAccumulators: new Map(),
    minObservations: 12,
    minContextualObservations: 24
  });

  assert.ok(Object.hasOwn(fitted.weights, "playCard"));
  assert.ok(Object.hasOwn(fitted.weights, "context.play.card.graduated"));
  assert.equal(Object.hasOwn(fitted.weights, "context.play.card.collecting"), false);
  assert.equal(fitted.featureSelection.contextualMinObservations, 24);
  assert.equal(fitted.featureSelection.contextualObserved, 2);
  assert.equal(fitted.featureSelection.contextualDeferredForSupport, 1);
  assert.deepEqual(fitted.featureSelection.deferredContextualFeatures, [{
    feature: "context.play.card.collecting",
    observations: 23
  }]);
});

test("incremental action models re-fit stale contextual support without new logs", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-contextual-refit-"));
  try {
    const input = join(root, "decisions.jsonl");
    const rows = [];
    for (let index = 0; index < 30; index += 1) {
      const common = {
        schema: "union-arena-local-engine/pilot-decision@1",
        decisionKey: `context-refit-${index}`,
        gameIndex: index + 1,
        seed: 910_000 + index,
        opponent: "regional-rnk-red-test",
        matchupProfileKey: "rnk-red",
        candidateId: "context-refit",
        step: 4,
        player: "P1",
        phase: "main",
        outcome: "win",
        reward: 1,
        shapedReward: 1,
        learningSignalVersion: 2,
        learningEligible: true,
        candidateCount: 2,
        creditWeight: 1,
        counterfactualPreference: "chosen",
        counterfactualEvidenceKind: "horizon",
        counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION,
        counterfactualAdvantage: 1,
        counterfactualConfidence: 1,
        counterfactualAlternativeIndex: 1,
        counterfactualAlternativeAction: { type: "playCard", cardId: "card-b" }
      };
      rows.push({
        ...common,
        chosen: true,
        actionIndex: 0,
        action: { type: "playCard", cardId: "card-a" },
        features: { "context.play.card.card-a": 1 }
      }, {
        ...common,
        chosen: false,
        actionIndex: 1,
        action: { type: "playCard", cardId: "card-b" },
        features: { "context.play.card.card-b": 1 }
      });
    }
    writeFileSync(input, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const modelPath = join(root, "model.json");
    const baseArgs = [
      "--input", input,
      "--out", modelPath,
      "--player", "P1",
      "--learning-mode", "pairwise",
      "--no-chosen-anchor",
      "--min-observations", "1",
      "--validation-fraction", "0"
    ];
    runTool("tools/train-ml-scorer.mjs", [...baseArgs, "--min-contextual-observations", "1"]);
    const provisional = readJson(modelPath);
    assert.equal(provisional.featureSelection.contextualMinObservations, 1);
    assert.equal(provisional.featureSelection.contextualSelected, 2);

    const migration = runTool("tools/train-ml-scorer.mjs", [...baseArgs, "--incremental"]);
    const migrated = readJson(modelPath);
    assert.match(migration.stdout, /Migrating contextual feature selection/u);
    assert.equal(migrated.featureSelection.version, MIN_ML_FEATURE_SELECTION_VERSION);
    assert.equal(migrated.minContextualObservations, 24);
    assert.equal(migrated.featureSelection.contextualMinObservations, 24);
    assert.equal(migrated.featureSelection.contextualSelected, 2);
    assert.equal(migrated.pairwiseExamples, provisional.pairwiseExamples);
    assert.deepEqual(migrated.newSourceFiles, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("incremental matchup overlays rebuild stale contextual support from retained logs", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-contextual-overlay-refit-"));
  try {
    const input = join(root, "decisions.jsonl");
    const rows = [];
    for (let index = 0; index < 30; index += 1) {
      const common = {
        schema: "union-arena-local-engine/pilot-decision@1",
        decisionKey: `overlay-context-refit-${index}`,
        gameIndex: index + 1,
        seed: 920_000 + index,
        opponent: "regional-rnk-red-test",
        matchupProfileKey: "rnk-red",
        candidateId: "overlay-context-refit",
        step: 4,
        player: "P1",
        phase: "main",
        outcome: "win",
        reward: 1,
        shapedReward: 1,
        learningSignalVersion: 2,
        learningEligible: true,
        candidateCount: 2,
        creditWeight: 1,
        counterfactualPreference: "chosen",
        counterfactualEvidenceKind: "horizon",
        counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION,
        counterfactualAdvantage: 1,
        counterfactualConfidence: 1,
        counterfactualAlternativeIndex: 1,
        counterfactualAlternativeAction: { type: "playCard", cardId: "card-b" }
      };
      rows.push({
        ...common,
        chosen: true,
        actionIndex: 0,
        action: { type: "playCard", cardId: "card-a" },
        features: { "context.play.card.card-a": 1 }
      }, {
        ...common,
        chosen: false,
        actionIndex: 1,
        action: { type: "playCard", cardId: "card-b" },
        features: { "context.play.card.card-b": 1 }
      });
    }
    writeFileSync(input, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const outDir = join(root, "overlays");
    const candidateDir = join(root, "candidates");
    const artifactPath = join(candidateDir, "eva-purple-vs-rnk-red.json");
    const baseArgs = [
      "--input", input,
      "--own-key", "eva-purple",
      "--out-dir", outDir,
      "--candidate-dir", candidateDir,
      "--player", "P1",
      "--group-by", "profile",
      "--learning-mode", "pairwise",
      "--no-chosen-anchor",
      "--min-examples", "1",
      "--min-observations", "1"
    ];
    runTool("tools/train-matchup-overlays.mjs", [...baseArgs, "--min-contextual-observations", "1"]);
    const provisional = readJson(artifactPath);
    assert.equal(provisional.featureSelection.contextualMinObservations, 1);
    assert.equal(provisional.featureSelection.contextualSelected, 2);

    runTool("tools/train-matchup-overlays.mjs", [...baseArgs, "--incremental"]);
    const migrated = readJson(artifactPath);
    assert.equal(migrated.featureSelection.version, MIN_ML_FEATURE_SELECTION_VERSION);
    assert.equal(migrated.minContextualObservations, 24);
    assert.equal(migrated.featureSelection.contextualMinObservations, 24);
    assert.equal(migrated.featureSelection.contextualSelected, 2);
    assert.equal(migrated.pairwiseExamples, provisional.pairwiseExamples);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("learning evidence filter persists membership with bounded memory", () => {
  const fingerprints = Array.from({ length: 10_000 }, (_, index) => learningDecisionGroupFingerprint([{
    chosen: true,
    ownKey: "filter-test",
    opponent: "filter-opponent",
    seed: index,
    step: index,
    player: "P1",
    phase: "main",
    actionIndex: 0,
    action: { type: "playCard", cardId: `card-${index}` },
    features: { playCard: 1, sequence: index % 7 }
  }]));
  const filter = createLearningEvidenceFilter();
  for (const fingerprint of fingerprints) assert.equal(learningEvidenceFilterAdd(filter, fingerprint), true);
  assert.equal(learningEvidenceFilterAdd(filter, fingerprints[0]), false);

  const restored = createLearningEvidenceFilter(serializeLearningEvidenceFilter(filter));
  for (const fingerprint of fingerprints) assert.equal(learningEvidenceFilterHas(restored, fingerprint), true);
  let falsePositives = 0;
  for (let index = 10_000; index < 20_000; index += 1) {
    const fingerprint = learningDecisionGroupFingerprint([{
      chosen: true,
      ownKey: "filter-test",
      opponent: "unseen-opponent",
      seed: index,
      step: index,
      player: "P1",
      actionIndex: 0,
      action: { type: "advancePhase" },
      features: { advancePhase: 1 }
    }]);
    if (learningEvidenceFilterHas(restored, fingerprint)) falsePositives += 1;
  }
  const stats = learningEvidenceFilterStats(restored);
  assert.equal(stats.inserted, 10_000);
  assert.equal(stats.levels, 2);
  assert.ok(stats.bytes < 100_000);
  assert.ok(stats.estimatedFalsePositiveRate < 1e-6);
  assert.ok(falsePositives <= 1);
});

test("incremental action training validates against cumulative held-out evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-cumulative-validation-"));
  try {
    const first = join(root, "first.jsonl");
    const second = join(root, "second.jsonl");
    writeFileSync(first, `${balancedPairDecisionRows({
      count: 160,
      keyPrefix: "historical",
      seedBase: 710_000
    }).map((row) => JSON.stringify(row)).join("\n")}\n`);
    writeFileSync(second, `${balancedPairDecisionRows({
      count: 1,
      keyPrefix: "incremental",
      seedBase: 720_000
    }).map((row) => JSON.stringify(row)).join("\n")}\n`);
    const modelPath = join(root, "model.json");
    const args = [
      "--out", modelPath,
      "--player", "P1",
      "--learning-mode", "pairwise",
      "--no-chosen-anchor",
      "--min-observations", "1",
      "--validation-fraction", "0.5"
    ];

    runTool("tools/train-ml-scorer.mjs", ["--input", first, ...args]);
    const initial = readJson(modelPath);
    assert.equal(initial.validationStateVersion, MIN_ML_VALIDATION_STATE_VERSION);
    assert.equal(initial.validation.cumulative, true);
    assert.ok(initial.validation.heldoutPlayerGames >= 8);
    assert.ok(initial.validation.sampledExamples >= 30);
    assert.equal(initial.validationSignalTrust, 1);

    const update = runTool("tools/train-ml-scorer.mjs", ["--input", second, ...args, "--incremental"]);
    const cumulative = readJson(modelPath);
    assert.doesNotMatch(update.stdout, /Reset ML action-model statistics/u);
    assert.ok(cumulative.validation.heldoutPlayerGames >= initial.validation.heldoutPlayerGames);
    assert.ok(cumulative.validation.sampledExamples >= initial.validation.sampledExamples);
    assert.ok(cumulative.validation.examplesSeen >= initial.validation.examplesSeen);
    assert.equal(cumulative.validationSignalTrust, 1);
    assert.equal(cumulative.sourceFiles.length, 2);
    assert.equal(cumulative.validationState.samples.length, cumulative.validation.sampledExamples);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("held-out game counts reflect games retained in the validation reservoir", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-validation-retained-games-"));
  try {
    const input = join(root, "decisions.jsonl");
    const rows = balancedPairDecisionRows({
      count: 400,
      keyPrefix: "retained-games",
      seedBase: 725_000
    }).map((row, rowIndex) => {
      const decisionIndex = Math.floor(rowIndex / 2);
      const gameIndex = Math.floor(decisionIndex / 4);
      return {
        ...row,
        gameIndex: gameIndex + 1,
        seed: 725_000 + gameIndex,
        opponent: "regional-shared-opponent"
      };
    });
    writeFileSync(input, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const modelPath = join(root, "model.json");
    runTool("tools/train-ml-scorer.mjs", [
      "--input", input,
      "--out", modelPath,
      "--player", "P1",
      "--learning-mode", "pairwise",
      "--no-chosen-anchor",
      "--min-observations", "1",
      "--validation-fraction", "0.5",
      "--validation-max-examples", "100"
    ]);
    const model = readJson(modelPath);
    const retainedGameKeys = new Set(model.validationState.samples
      .map((sample) => sample.metadata?.playerGame)
      .filter((key) => key && key !== "unknown"));
    assert.equal(model.validationState.samples.length, 100);
    assert.equal(model.validation.heldoutPlayerGames, retainedGameKeys.size);
    assert.deepEqual(model.validationState.heldoutPlayerGameKeys, [...retainedGameKeys].sort());
    assert.equal(
      Object.keys(model.validation.pairwise.validationDiversity.playerGameCounts).length,
      retainedGameKeys.size
    );
    assert.ok(model.validation.assignedHeldoutPlayerGames >= model.validation.heldoutPlayerGames);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validation-state migration preserves learned statistics while rebuilding classified holdouts", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-validation-migration-"));
  try {
    const historical = join(root, "historical.jsonl");
    const fresh = join(root, "fresh.jsonl");
    writeFileSync(historical, `${balancedPairDecisionRows({
      count: 120,
      keyPrefix: "migration-historical",
      seedBase: 730_000
    }).map((row) => JSON.stringify(row)).join("\n")}\n`);
    writeFileSync(fresh, `${balancedPairDecisionRows({
      count: 90,
      keyPrefix: "migration-fresh",
      seedBase: 740_000
    }).map((row) => JSON.stringify(row)).join("\n")}\n`);
    const modelPath = join(root, "model.json");
    const args = [
      "--out", modelPath,
      "--player", "P1",
      "--learning-mode", "pairwise",
      "--no-chosen-anchor",
      "--min-observations", "1",
      "--validation-fraction", "0.5"
    ];
    runTool("tools/train-ml-scorer.mjs", ["--input", historical, ...args]);
    const current = readJson(modelPath);
    const historicalExamples = current.examples;
    const legacy = structuredClone(current);
    legacy.validationStateVersion = MIN_ML_VALIDATION_STATE_VERSION - 1;
    legacy.validationState.version = MIN_ML_VALIDATION_STATE_VERSION - 1;
    for (const sample of legacy.validationState.samples) delete sample.metadata;
    writeJsonAtomicSync(modelPath, legacy);

    const migration = runTool("tools/train-ml-scorer.mjs", ["--input", fresh, ...args, "--incremental"]);
    const migrated = readJson(modelPath);
    assert.match(migration.stdout, /Migrating held-out validation state/u);
    assert.doesNotMatch(migration.stdout, /Reset ML action-model statistics/u);
    assert.ok(migrated.examples >= historicalExamples);
    assert.equal(migrated.validationStateVersion, MIN_ML_VALIDATION_STATE_VERSION);
    assert.equal(migrated.validationState.version, MIN_ML_VALIDATION_STATE_VERSION);
    assert.ok(migrated.validationState.samples.length >= 30);
    assert.ok(migrated.validationState.samples.every((sample) => (
      sample.metadata?.phase && sample.metadata?.actionPair && sample.metadata?.playerGame
    )));
    assert.equal(migrated.validation.pairwise.validationDiversity.version, MIN_ML_VALIDATION_DIVERSITY_VERSION);
    assert.ok(migrated.validation.pairwise.validationDiversity.actionPairReliability.length >= 3);
    assert.ok(Object.keys(migrated.validation.pairwise.validationDiversity.playerGameCounts).length >= 8);
    assert.ok(migrated.validation.pairwise.validationDiversity.actionPairReliability.every((row) => (
      row.distinctPlayerGames >= 2 && row.positiveExamples > 0 && row.negativeExamples > 0
    )));
    assert.equal(migrated.sourceFiles.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("counterfactual evidence applies only to the alternative that was rolled out", () => {
  const group = [
    {
      chosen: true,
      actionIndex: 0,
      counterfactualAlternativeIndex: 2,
      counterfactualAlternativeAction: { type: "performRaid", cardId: "raid-a" }
    },
    { chosen: false, actionIndex: 1, action: { type: "advancePhase" } },
    { chosen: false, actionIndex: 2, action: { type: "performRaid", cardId: "raid-a" } }
  ];
  assert.deepEqual(counterfactualAlternativeRows(group, group[0]), [group[2]]);

  const legacyChosen = {
    chosen: true,
    counterfactualAlternativeAction: { cardId: "raid-a", type: "performRaid" }
  };
  assert.deepEqual(counterfactualAlternativeRows([legacyChosen, ...group.slice(1)], legacyChosen), [group[2]]);
  assert.deepEqual(counterfactualAlternativeRows([
    legacyChosen,
    group[2],
    { ...group[2], actionIndex: 3 }
  ], legacyChosen), []);
});

test("pairwise learning quarantines stale nonterminal state labels", () => {
  assert.equal(counterfactualPairwiseLearningEvidence({
    counterfactualPreference: "chosen",
    counterfactualEvidenceKind: "horizon",
    counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION - 1
  }), null);

  const current = counterfactualPairwiseLearningEvidence({
    counterfactualPreference: "alternative",
    counterfactualEvidenceKind: "horizon",
    counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION,
    counterfactualAdvantage: 0.5,
    counterfactualConfidence: 0.8
  });
  assert.equal(current.direction, -1);
  assert.equal(current.evaluatorVersion, COUNTERFACTUAL_STATE_EVALUATION_VERSION);

  const terminal = counterfactualPairwiseLearningEvidence({
    counterfactualPreference: "chosen",
    counterfactualEvidenceKind: "terminal-winner-change",
    counterfactualStateEvaluationVersion: 1
  });
  assert.equal(terminal.direction, 1);
});

test("ML trainer reserves deterministic decision groups for validation diagnostics", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-holdout-"));
  try {
    const input = join(root, "decisions.jsonl");
    const rows = Array.from({ length: 24 }, (_, index) => decisionRows(`holdout-${index}`, {
      gameIndex: index + 1,
      seed: 8100 + index,
      outcome: index % 2 === 0 ? "win" : "loss",
      reward: index % 2 === 0 ? 1 : -1,
      shapedReward: index % 2 === 0 ? 1 : -1,
      candidateCount: 2,
      learningEligible: true,
      creditWeight: 1,
      learningSignalVersion: 2,
      counterfactualPreference: "chosen",
      counterfactualAlternativeIndex: 1,
      counterfactualAlternativeAction: { type: "advancePhase" }
    })).flat();
    writeFileSync(input, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const modelPath = join(root, "model.json");
    runTool("tools/train-ml-scorer.mjs", [
      "--input", input,
      "--out", modelPath,
      "--player", "P1",
      "--learning-mode", "pairwise",
      "--include-chosen-anchor",
      "--min-observations", "1",
      "--validation-fraction", "0.5"
    ]);
    const model = readJson(modelPath);
    assert.equal(model.validation.strategy, "deterministic-player-game-holdout");
    assert.ok(model.validation.heldoutPlayerGames > 0 && model.validation.heldoutPlayerGames < 24);
    assert.ok(model.validation.heldoutDecisions > 0 && model.validation.heldoutDecisions < 24);
    assert.ok(model.validation.sampledExamples > 0);
    assert.ok(model.validation.anchor?.examples > 0);
    assert.ok(model.validation.pairwise?.examples > 0);
    assert.ok(model.examples > 0 && model.examples < 48);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ML validation does not trust majority-class accuracy from an all-loss holdout", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-holdout-class-balance-"));
  try {
    const input = join(root, "decisions.jsonl");
    const rows = Array.from({ length: 24 }, (_, index) => decisionRows(`loss-${index}`, {
      gameIndex: index + 1,
      seed: 9100 + index,
      outcome: "loss",
      reward: -1,
      shapedReward: -1,
      candidateCount: 2,
      learningEligible: true,
      creditWeight: 1,
      learningSignalVersion: 2
    })).flat();
    writeFileSync(input, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const modelPath = join(root, "model.json");
    runTool("tools/train-ml-scorer.mjs", [
      "--input", input,
      "--out", modelPath,
      "--player", "P1",
      "--learning-mode", "pairwise",
      "--include-chosen-anchor",
      "--min-observations", "1",
      "--validation-fraction", "0.5"
    ]);
    const model = readJson(modelPath);
    assert.ok(model.validation.anchor.negativeExamples > 0);
    assert.equal(model.validation.anchor.positiveExamples, 0);
    assert.equal(model.validation.anchor.balancedSignAccuracy, null);
    assert.equal(model.validationSignalTrust, 0.25);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("incremental learning resets diagonal-only legacy statistics before covariance-aware fitting", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-legacy-"));
  try {
    const input = join(root, "new.jsonl");
    writeDecisionFile(input, "new-decision", 1, { counterfactualPreference: "chosen" });
    const modelPath = join(root, "model.json");
    writeFileSync(modelPath, `${JSON.stringify({
      schema: "union-arena-local-engine/ml-action-model@1",
      name: "legacy",
      examples: 100000,
      sourceRows: 150000,
      selectedExamples: 50000,
      pairwiseExamples: 50000,
      sourceFiles: [],
      targetTotal: 10000,
      averageTarget: 0.1,
      weights: { playCard: 120 },
      trainingStats: {
        playCard: { observations: 100000, dot: 1000, norm: 1000 }
      }
    })}\n`);

    const result = runTool("tools/train-ml-scorer.mjs", [
      "--input", input,
      "--out", modelPath,
      "--player", "P1",
      "--learning-mode", "pairwise",
      "--min-observations", "1",
      "--legacy-weight-cap", "5000",
      "--validation-fraction", "0",
      "--incremental"
    ]);
    const migrated = readJson(modelPath);
    assert.match(result.stdout, /Reset ML action-model statistics/u);
    assert.equal(migrated.learningSignalVersion, 2);
    assert.equal(migrated.regressionVersion, MIN_ML_REGRESSION_VERSION);
    assert.equal(migrated.legacyExampleWeight, 0);
    assert.equal(migrated.legacyScaleApplied, 1);
    assert.ok(migrated.trustedExampleWeight > 0);
    assert.ok(migrated.learningSignalTrust > 0 && migrated.learningSignalTrust < 1);
    assert.equal(migrated.validationSignalTrust, 0.25);
    assert.equal(migrated.learningSignalTrust, migrated.evidenceSignalTrust * migrated.validationSignalTrust);
    assert.ok(migrated.exampleWeightTotal > 0 && migrated.exampleWeightTotal < 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto-refiner dry-run starts fresh learning with a missing-baseline batch without spawning children", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-auto-refine-"));
  try {
    const agentRoot = join(root, "pilot-agent");
    const library = join(root, "decks");
    const outRoot = join(agentRoot, "auto-refiner", "smoke");
    mkdirSync(library, { recursive: true });
    writeFileSync(join(root, "catalog.json"), "{}\n");
    writeSavedDeck(join(library, "carnerr-a.json"), {
      id: "carnerr-a",
      name: "Carnerr A",
      summary: { sourceCode: "EVA", colors: ["purple"] },
      cards: [{ id: "card-a", count: 50 }]
    });
    writeSavedDeck(join(library, "carnerr-b.json"), {
      id: "carnerr-b",
      name: "Carnerr B",
      summary: { sourceCode: "TSK", colors: ["blue"] },
      cards: [{ id: "card-b", count: 50 }]
    });

    const result = runTool("tools/pilot-auto-refiner.mjs", [
      "--dry-run",
      "--agent-root", agentRoot,
      "--library", library,
      "--catalog", join(root, "catalog.json"),
      "--policy-dir", join(agentRoot, "policies"),
      "--baseline-root", join(agentRoot, "baselines"),
      "--runs-root", join(agentRoot, "runs"),
      "--out-root", outRoot,
      "--session", "smoke",
      "--decks", "carnerr-a,carnerr-b",
      "--deck-advance-mode", "batch",
      "--max-jobs", "1",
      "--stages", "light",
      "--parallel-runs", "2",
      "--parallel-concurrency", "2",
      "--baseline-refresh-batch-size", "2",
      "--counterfactual-exploration-rate", "0.44",
      "--counterfactual-max-per-game", "3",
      "--counterfactual-rollout-actions", "55"
    ]);

    assert.match(result.stdout, /Missing Baseline Suite/u);
    assert.match(result.stdout, /Dry run: skipped child process for baseline-suite/u);
    assert.doesNotMatch(result.stdout, /Starting \d+ parallel training run/u);

    const state = readJson(join(outRoot, "auto-refiner-state.json"));
    assert.equal(state.jobs.length, 1);
    assert.equal(state.jobs[0].taskType, "baseline-suite");
    assert.match(state.jobs[0].command, /tools\/pilot-baseline-suite\.mjs|tools\\pilot-baseline-suite\.mjs/u);
    assert.match(state.jobs[0].command, /--decks carnerr-a,carnerr-b/u);
    assert.match(state.jobs[0].command, /--suite-concurrency 1/u);
    assert.equal(state.config.stages[0].baselineGames, 8);
    assert.equal(state.config.stages[0].baselineGenerations, 2);
    assert.equal(state.config.stages[0].baselinePopulation, 4);
    assert.equal(state.config.stages[0].baselineFinalGames, 8);
    assert.equal(state.config.stages[0].nominalWork.baselineGameSlotsPerChild, 72);
    assert.equal(state.config.stages[0].nominalWork.baselineGameSlotsAcrossChildren, 144);
    assert.match(state.jobs[0].command, /--counterfactual-exploration-rate 0\.44/u);
    assert.match(state.jobs[0].command, /--counterfactual-max-per-game 3/u);
    assert.match(state.jobs[0].command, /--counterfactual-rollout-actions 55/u);
    assert.equal(state.jobs[0].attempts[0].dryRun, true);
    assert.equal(existsSync(join(outRoot, "light", "job-001-baseline-suite-missing", "report.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto-refiner dry-run treats seed baselines as baseline work", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-auto-refine-seed-"));
  try {
    const agentRoot = join(root, "pilot-agent");
    const library = join(root, "decks");
    const outRoot = join(agentRoot, "auto-refiner", "seed");
    const baselineRoot = join(agentRoot, "baselines");
    mkdirSync(library, { recursive: true });
    writeFileSync(join(root, "catalog.json"), "{}\n");
    writeSavedDeck(join(library, "carnerr-a.json"), {
      id: "carnerr-a",
      name: "Carnerr A",
      summary: { sourceCode: "EVA", colors: ["purple"] },
      cards: [{ id: "card-a", count: 50 }]
    });
    writeSavedDeck(join(library, "carnerr-b.json"), {
      id: "carnerr-b",
      name: "Carnerr B",
      summary: { sourceCode: "TSK", colors: ["blue"] },
      cards: [{ id: "card-b", count: 50 }]
    });
    writeJsonAtomicSync(baselinePolicyPathForKey("eva-purple", { baselineRoot }), {
      name: "seed-policy",
      weights: {}
    });
    writeJsonAtomicSync(baselineOriginPathForKey("eva-purple", { baselineRoot }), {
      schema: "union-arena-local-engine/baseline-origin@1",
      quality: "seed",
      promotionType: "missing-seed",
      needsTraining: true,
      acceptedForLearning: false
    });
    writeJsonAtomicSync(baselinePolicyPathForKey("tsk-blue", { baselineRoot }), {
      name: "trained-policy",
      weights: {}
    });
    writeJsonAtomicSync(baselineOriginPathForKey("tsk-blue", { baselineRoot }), {
      schema: "union-arena-local-engine/baseline-origin@1",
      quality: "trained",
      promotionType: "improved",
      needsTraining: false,
      acceptedForLearning: true
    });

    const result = runTool("tools/pilot-auto-refiner.mjs", [
      "--dry-run",
      "--agent-root", agentRoot,
      "--library", library,
      "--catalog", join(root, "catalog.json"),
      "--policy-dir", join(agentRoot, "policies"),
      "--baseline-root", baselineRoot,
      "--runs-root", join(agentRoot, "runs"),
      "--out-root", outRoot,
      "--session", "seed",
      "--decks", "carnerr-a,carnerr-b",
      "--max-jobs", "1",
      "--stages", "light",
      "--parallel-runs", "2",
      "--parallel-concurrency", "2",
      "--baseline-refresh-batch-size", "2"
    ]);

    assert.match(result.stdout, /Missing Baseline Suite/u);
    const state = readJson(join(outRoot, "auto-refiner-state.json"));
    assert.equal(state.jobs[0].taskType, "baseline-suite");
    assert.deepEqual(state.jobs[0].baselineStatuses, { "eva-purple": "seed" });
    assert.equal(state.decks.find((deck) => deck.ownKey === "eva-purple").baselineReady, false);
    assert.equal(state.decks.find((deck) => deck.ownKey === "tsk-blue").baselineReady, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto-refiner dry-run treats legacy flat baselines as baseline work", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-auto-refine-legacy-baseline-"));
  try {
    const agentRoot = join(root, "pilot-agent");
    const library = join(root, "decks");
    const outRoot = join(agentRoot, "auto-refiner", "legacy-baseline");
    const policyDir = join(agentRoot, "policies");
    mkdirSync(library, { recursive: true });
    writeFileSync(join(root, "catalog.json"), "{}\n");
    writeSavedDeck(join(library, "carnerr-a.json"), {
      id: "carnerr-a",
      name: "Carnerr A",
      summary: { sourceCode: "EVA", colors: ["purple"] },
      cards: [{ id: "card-a", count: 50 }]
    });
    writeJsonAtomicSync(join(policyDir, "eva-purple.json"), {
      name: "legacy-policy",
      weights: {}
    });

    runTool("tools/pilot-auto-refiner.mjs", [
      "--dry-run",
      "--agent-root", agentRoot,
      "--library", library,
      "--catalog", join(root, "catalog.json"),
      "--policy-dir", policyDir,
      "--baseline-root", join(agentRoot, "baselines"),
      "--runs-root", join(agentRoot, "runs"),
      "--out-root", outRoot,
      "--session", "legacy-baseline",
      "--decks", "carnerr-a",
      "--max-jobs", "1",
      "--stages", "light"
    ]);

    const state = readJson(join(outRoot, "auto-refiner-state.json"));
    assert.equal(state.jobs[0].taskType, "baseline-suite");
    assert.deepEqual(state.jobs[0].baselineStatuses, { "eva-purple": "legacy" });
    assert.equal(state.decks[0].baselineReady, false);
    assert.equal(state.decks[0].baselineStatus, "legacy");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto-refiner dry-run treats legacy action models as profile ML work", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-auto-refine-legacy-model-"));
  try {
    const agentRoot = join(root, "pilot-agent");
    const library = join(root, "decks");
    const outRoot = join(agentRoot, "auto-refiner", "legacy-model");
    const baselineRoot = join(agentRoot, "baselines");
    mkdirSync(library, { recursive: true });
    writeFileSync(join(root, "catalog.json"), "{}\n");
    writeSavedDeck(join(library, "carnerr-a.json"), {
      id: "carnerr-a",
      name: "Carnerr A",
      summary: { sourceCode: "EVA", colors: ["purple"] },
      cards: [{ id: "card-a", count: 50 }]
    });
    writeJsonAtomicSync(baselinePolicyPathForKey("eva-purple", { baselineRoot }), {
      name: "trained-policy",
      weights: {}
    });
    writeJsonAtomicSync(baselineOriginPathForKey("eva-purple", { baselineRoot }), {
      schema: "union-arena-local-engine/baseline-origin@1",
      quality: "trained",
      promotionType: "improved",
      needsTraining: false,
      acceptedForLearning: true
    });
    writeJsonAtomicSync(actionModelPathForKey("eva-purple", { agentRoot, legacy: true }), {
      schema: "union-arena-local-engine/ml-action-model@1",
      name: "legacy-model",
      learningSignalVersion: 2,
      learningSignalTrust: 0.99,
      examples: 1000,
      validation: trustedMlValidation(100),
      weights: {}
    });

    runTool("tools/pilot-auto-refiner.mjs", [
      "--dry-run",
      "--agent-root", agentRoot,
      "--library", library,
      "--catalog", join(root, "catalog.json"),
      "--policy-dir", join(agentRoot, "policies"),
      "--baseline-root", baselineRoot,
      "--runs-root", join(agentRoot, "runs"),
      "--out-root", outRoot,
      "--session", "legacy-model",
      "--decks", "carnerr-a",
      "--max-jobs", "1",
      "--stages", "light"
    ]);

    const state = readJson(join(outRoot, "auto-refiner-state.json"));
    assert.equal(state.decks[0].actionModelReady, false);
    assert.equal(state.decks[0].actionModelStatus, "legacy");
    assert.equal(state.jobs[0].taskType, "action-model-suite");
    assert.deepEqual(state.jobs[0].actionModelStatuses, { "eva-purple": "legacy" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto-refiner dry-run routes trained baselines without profile ML back to deck learning", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-auto-refine-no-ml-"));
  try {
    const agentRoot = join(root, "pilot-agent");
    const library = join(root, "decks");
    const outRoot = join(agentRoot, "auto-refiner", "no-ml");
    const baselineRoot = join(agentRoot, "baselines");
    mkdirSync(library, { recursive: true });
    writeFileSync(join(root, "catalog.json"), "{}\n");
    writeSavedDeck(join(library, "carnerr-a.json"), {
      id: "carnerr-a",
      name: "Carnerr A",
      summary: { sourceCode: "EVA", colors: ["purple"] },
      cards: [{ id: "card-a", count: 50 }]
    });
    writeJsonAtomicSync(baselinePolicyPathForKey("eva-purple", { baselineRoot }), {
      name: "trained-policy",
      weights: {}
    });
    writeJsonAtomicSync(baselineOriginPathForKey("eva-purple", { baselineRoot }), {
      schema: "union-arena-local-engine/baseline-origin@1",
      quality: "trained",
      promotionType: "improved",
      needsTraining: false,
      acceptedForLearning: true
    });

    runTool("tools/pilot-auto-refiner.mjs", [
      "--dry-run",
      "--agent-root", agentRoot,
      "--library", library,
      "--catalog", join(root, "catalog.json"),
      "--policy-dir", join(agentRoot, "policies"),
      "--baseline-root", baselineRoot,
      "--runs-root", join(agentRoot, "runs"),
      "--out-root", outRoot,
      "--session", "no-ml",
      "--decks", "carnerr-a",
      "--max-jobs", "1",
      "--stages", "light",
      "--baseline-refresh-mode", "never"
    ]);

    const state = readJson(join(outRoot, "auto-refiner-state.json"));
    assert.equal(state.decks[0].baselineReady, true);
    assert.equal(state.decks[0].actionModelReady, false);
    assert.equal(state.decks[0].actionModelStatus, "missing");
    assert.equal(state.jobs[0].taskType, "baseline");
    assert.match(state.jobs[0].command, /tools\/pilot-loop-overseer\.mjs|tools\\pilot-loop-overseer\.mjs/u);
    assert.match(state.jobs[0].command, /--knowledge-mode action/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto-refiner collects matchup evidence after one unready profile-ML attempt", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-auto-refine-readiness-skip-"));
  try {
    const agentRoot = join(root, "pilot-agent");
    const library = join(root, "decks");
    const outRoot = join(agentRoot, "auto-refiner", "readiness-skip");
    const baselineRoot = join(agentRoot, "baselines");
    mkdirSync(library, { recursive: true });
    writeFileSync(join(root, "catalog.json"), "{}\n");
    writeSavedDeck(join(library, "carnerr-a.json"), {
      id: "carnerr-a",
      name: "Carnerr A",
      summary: { sourceCode: "EVA", colors: ["purple"] },
      cards: [{ id: "card-a", count: 50 }]
    });
    writeJsonAtomicSync(baselinePolicyPathForKey("eva-purple", { baselineRoot }), { name: "trained", weights: {} });
    writeJsonAtomicSync(baselineOriginPathForKey("eva-purple", { baselineRoot }), {
      schema: "union-arena-local-engine/baseline-origin@1",
      quality: "trained",
      promotionType: "improved",
      needsTraining: false
    });

    runTool("tools/pilot-auto-refiner.mjs", [
      "--dry-run",
      "--agent-root", agentRoot,
      "--library", library,
      "--catalog", join(root, "catalog.json"),
      "--baseline-root", baselineRoot,
      "--out-root", outRoot,
      "--decks", "carnerr-a",
      "--max-jobs", "2",
      "--stages", "light",
      "--baseline-refresh-mode", "never"
    ]);

    const state = readJson(join(outRoot, "auto-refiner-state.json"));
    assert.deepEqual(state.jobs.map((job) => job.taskType), ["baseline", "matchup-sweep"]);
    assert.equal(state.jobs[1].evidenceMode, true);
    assert.match(state.jobs[1].command, /--allow-unready-action-model/u);
    assert.equal(state.executedJobs, 2);
    assert.equal(state.schedulerSteps, 2);
    assert.equal(state.completedPasses.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unresolved baseline batches do not starve ready profiles of ML catch-up", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-auto-refine-no-starvation-"));
  try {
    const agentRoot = join(root, "pilot-agent");
    const library = join(root, "decks");
    const outRoot = join(agentRoot, "auto-refiner", "no-starvation");
    const baselineRoot = join(agentRoot, "baselines");
    mkdirSync(library, { recursive: true });
    writeFileSync(join(root, "catalog.json"), "{}\n");
    writeSavedDeck(join(library, "carnerr-a.json"), {
      id: "carnerr-a",
      name: "Carnerr A Missing",
      summary: { sourceCode: "EVA", colors: ["purple"] },
      cards: [{ id: "card-a", count: 50 }]
    });
    writeSavedDeck(join(library, "carnerr-b.json"), {
      id: "carnerr-b",
      name: "Carnerr B Ready",
      summary: { sourceCode: "TSK", colors: ["blue"] },
      cards: [{ id: "card-b", count: 50 }]
    });
    writeJsonAtomicSync(baselinePolicyPathForKey("tsk-blue", { baselineRoot }), { name: "trained", weights: {} });
    writeJsonAtomicSync(baselineOriginPathForKey("tsk-blue", { baselineRoot }), {
      schema: "union-arena-local-engine/baseline-origin@1",
      quality: "trained",
      promotionType: "improved",
      needsTraining: false
    });

    runTool("tools/pilot-auto-refiner.mjs", [
      "--dry-run",
      "--agent-root", agentRoot,
      "--library", library,
      "--catalog", join(root, "catalog.json"),
      "--baseline-root", baselineRoot,
      "--out-root", outRoot,
      "--decks", "carnerr-a,carnerr-b",
      "--deck-advance-mode", "batch",
      "--max-jobs", "2",
      "--stages", "light",
      "--baseline-suite-retry-rounds", "1",
      "--baseline-refresh-batch-size", "1"
    ]);

    const state = readJson(join(outRoot, "auto-refiner-state.json"));
    assert.deepEqual(state.jobs.map((job) => job.taskType), ["baseline-suite", "action-model-suite"]);
    assert.deepEqual(state.jobs[1].profileKeys, ["tsk-blue"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto-refiner scopes profile ML catch-up to the locked deck unless batch mode is requested", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-auto-refine-ml-suite-"));
  try {
    const agentRoot = join(root, "pilot-agent");
    const library = join(root, "decks");
    const outRoot = join(agentRoot, "auto-refiner", "ml-suite");
    const baselineRoot = join(agentRoot, "baselines");
    mkdirSync(library, { recursive: true });
    writeFileSync(join(root, "catalog.json"), "{}\n");
    writeSavedDeck(join(library, "carnerr-a.json"), {
      id: "carnerr-a",
      name: "Carnerr A",
      summary: { sourceCode: "EVA", colors: ["purple"] },
      cards: [{ id: "card-a", count: 50 }]
    });
    writeSavedDeck(join(library, "carnerr-b.json"), {
      id: "carnerr-b",
      name: "Carnerr B",
      summary: { sourceCode: "TSK", colors: ["blue"] },
      cards: [{ id: "card-b", count: 50 }]
    });
    for (const key of ["eva-purple", "tsk-blue"]) {
      writeJsonAtomicSync(baselinePolicyPathForKey(key, { baselineRoot }), {
        name: `${key}-trained-policy`,
        weights: {}
      });
      writeJsonAtomicSync(baselineOriginPathForKey(key, { baselineRoot }), {
        schema: "union-arena-local-engine/baseline-origin@1",
        quality: "trained",
        promotionType: "improved",
        needsTraining: false,
        acceptedForLearning: true
      });
    }

    runTool("tools/pilot-auto-refiner.mjs", [
      "--dry-run",
      "--agent-root", agentRoot,
      "--library", library,
      "--catalog", join(root, "catalog.json"),
      "--policy-dir", join(agentRoot, "policies"),
      "--baseline-root", baselineRoot,
      "--runs-root", join(agentRoot, "runs"),
      "--out-root", outRoot,
      "--session", "ml-suite",
      "--decks", "carnerr-a,carnerr-b",
      "--deck-advance-mode", "batch",
      "--max-jobs", "1",
      "--stages", "light",
      "--parallel-runs", "2",
      "--parallel-concurrency", "2",
      "--baseline-refresh-batch-size", "2",
      "--action-model-suite-concurrency", "2"
    ]);

    const state = readJson(join(outRoot, "auto-refiner-state.json"));
    assert.equal(state.jobs[0].taskType, "action-model-suite");
    assert.deepEqual(state.jobs[0].profileKeys, ["eva-purple", "tsk-blue"]);
    assert.deepEqual(state.jobs[0].actionModelStatuses, { "eva-purple": "missing", "tsk-blue": "missing" });
    assert.match(state.jobs[0].command, /tools\/pilot-baseline-suite\.mjs|tools\\pilot-baseline-suite\.mjs/u);
    assert.match(state.jobs[0].command, /--decks carnerr-a,carnerr-b/u);
    assert.match(state.jobs[0].command, /--suite-concurrency 2/u);

    const focusedOutRoot = join(agentRoot, "auto-refiner", "ml-focused");
    runTool("tools/pilot-auto-refiner.mjs", [
      "--dry-run",
      "--agent-root", agentRoot,
      "--library", library,
      "--catalog", join(root, "catalog.json"),
      "--policy-dir", join(agentRoot, "policies"),
      "--baseline-root", baselineRoot,
      "--runs-root", join(agentRoot, "runs"),
      "--out-root", focusedOutRoot,
      "--session", "ml-focused",
      "--decks", "carnerr-a,carnerr-b",
      "--max-jobs", "2",
      "--stages", "light",
      "--baseline-refresh-mode", "missing"
    ]);

    const focused = readJson(join(focusedOutRoot, "auto-refiner-state.json"));
    assert.deepEqual(focused.jobs.map((job) => job.taskType), ["action-model-suite", "matchup-sweep"]);
    assert.deepEqual(focused.jobs[0].profileKeys, ["eva-purple"]);
    assert.equal(focused.jobs[1].deckId, "carnerr-a");
    assert.equal(focused.jobs[1].evidenceMode, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto-refiner dry-run allows matchup work only after profile ML is trusted", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-auto-refine-trusted-ml-"));
  try {
    const agentRoot = join(root, "pilot-agent");
    const library = join(root, "decks");
    const outRoot = join(agentRoot, "auto-refiner", "trusted-ml");
    const baselineRoot = join(agentRoot, "baselines");
    mkdirSync(library, { recursive: true });
    writeFileSync(join(root, "catalog.json"), "{}\n");
    writeSavedDeck(join(library, "carnerr-a.json"), {
      id: "carnerr-a",
      name: "Carnerr A",
      summary: { sourceCode: "EVA", colors: ["purple"] },
      cards: [{ id: "card-a", count: 50 }]
    });
    writeJsonAtomicSync(baselinePolicyPathForKey("eva-purple", { baselineRoot }), {
      name: "trained-policy",
      weights: {}
    });
    writeJsonAtomicSync(baselineOriginPathForKey("eva-purple", { baselineRoot }), {
      schema: "union-arena-local-engine/baseline-origin@1",
      quality: "trained",
      promotionType: "improved",
      needsTraining: false,
      acceptedForLearning: true
    });
    writeJsonAtomicSync(actionModelPathForKey("eva-purple", { agentRoot, baselineRoot }), {
      ...trustedMlEvidenceDiversity(),
      schema: "union-arena-local-engine/ml-action-model@1",
      name: "trusted-model",
      learningSignalVersion: 2,
      trainingPipelineVersion: 2,
      sourceDigestVersion: MIN_LEARNING_SOURCE_DIGEST_VERSION,
      learningEvidenceFilterVersion: MIN_LEARNING_EVIDENCE_FILTER_VERSION,
      validationAssignmentVersion: 2,
      validationStateVersion: MIN_ML_VALIDATION_STATE_VERSION,
      pairwiseOrientationVersion: MIN_ML_PAIRWISE_ORIENTATION_VERSION,
      regressionVersion: MIN_ML_REGRESSION_VERSION,
      counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION,
      learningSignalTrust: 0.75,
      examples: 120,
      pairwiseExamples: 30,
      validation: trustedMlValidation(8),
      weights: {}
    });

    runTool("tools/pilot-auto-refiner.mjs", [
      "--dry-run",
      "--agent-root", agentRoot,
      "--library", library,
      "--catalog", join(root, "catalog.json"),
      "--policy-dir", join(agentRoot, "policies"),
      "--baseline-root", baselineRoot,
      "--runs-root", join(agentRoot, "runs"),
      "--out-root", outRoot,
      "--session", "trusted-ml",
      "--decks", "carnerr-a",
      "--max-jobs", "1",
      "--stages", "light",
      "--baseline-refresh-mode", "never"
    ]);

    const state = readJson(join(outRoot, "auto-refiner-state.json"));
    assert.equal(state.config.deckAdvanceMode, "complete");
    assert.equal(state.decks[0].actionModelReady, true);
    assert.equal(state.decks[0].actionModelStatus, "ready");
    assert.equal(state.jobs[0].taskType, "matchup-sweep");
    assert.match(state.jobs[0].command, /tools\/pilot-matchup-sweep\.mjs|tools\\pilot-matchup-sweep\.mjs/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto-refiner dry-run schedules multiple missing-baseline batches before matchup work", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-auto-refine-batches-"));
  try {
    const agentRoot = join(root, "pilot-agent");
    const library = join(root, "decks");
    const outRoot = join(agentRoot, "auto-refiner", "batches");
    mkdirSync(library, { recursive: true });
    writeFileSync(join(root, "catalog.json"), "{}\n");
    writeSavedDeck(join(library, "carnerr-a.json"), {
      id: "carnerr-a",
      name: "Carnerr A",
      summary: { sourceCode: "EVA", colors: ["purple"] },
      cards: [{ id: "card-a", count: 50 }]
    });
    writeSavedDeck(join(library, "carnerr-b.json"), {
      id: "carnerr-b",
      name: "Carnerr B",
      summary: { sourceCode: "TSK", colors: ["blue"] },
      cards: [{ id: "card-b", count: 50 }]
    });
    writeSavedDeck(join(library, "carnerr-c.json"), {
      id: "carnerr-c",
      name: "Carnerr C",
      summary: { sourceCode: "KGR", colors: ["red"] },
      cards: [{ id: "card-c", count: 50 }]
    });

    runTool("tools/pilot-auto-refiner.mjs", [
      "--dry-run",
      "--agent-root", agentRoot,
      "--library", library,
      "--catalog", join(root, "catalog.json"),
      "--policy-dir", join(agentRoot, "policies"),
      "--baseline-root", join(agentRoot, "baselines"),
      "--runs-root", join(agentRoot, "runs"),
      "--out-root", outRoot,
      "--session", "batches",
      "--decks", "carnerr-a,carnerr-b,carnerr-c",
      "--deck-advance-mode", "batch",
      "--max-jobs", "2",
      "--stages", "light",
      "--parallel-runs", "2",
      "--parallel-concurrency", "2",
      "--baseline-refresh-batch-size", "2"
    ]);

    const state = readJson(join(outRoot, "auto-refiner-state.json"));
    assert.equal(state.jobs.length, 2);
    assert.equal(state.jobs[0].taskType, "baseline-suite");
    assert.equal(state.jobs[1].taskType, "baseline-suite");
    assert.deepEqual(state.jobs[0].profileKeys, ["eva-purple", "tsk-blue"]);
    assert.deepEqual(state.jobs[1].profileKeys, ["kgr-red"]);
    assert.match(state.jobs[0].command, /tools\/pilot-baseline-suite\.mjs|tools\\pilot-baseline-suite\.mjs/u);
    assert.match(state.jobs[0].command, /--decks carnerr-a,carnerr-b/u);
    assert.match(state.jobs[1].command, /--decks carnerr-c/u);
    assert.match(state.jobs[1].command, /--suite-concurrency 1/u);
    assert.deepEqual(state.pass.baselineAttemptedProfileKeys, ["eva-purple", "tsk-blue", "kgr-red"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto-refiner dry-run retries unresolved missing baselines in parallel before fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-auto-refine-retry-batches-"));
  try {
    const agentRoot = join(root, "pilot-agent");
    const library = join(root, "decks");
    const outRoot = join(agentRoot, "auto-refiner", "retry-batches");
    mkdirSync(library, { recursive: true });
    writeFileSync(join(root, "catalog.json"), "{}\n");
    writeSavedDeck(join(library, "carnerr-a.json"), {
      id: "carnerr-a",
      name: "Carnerr A",
      summary: { sourceCode: "EVA", colors: ["purple"] },
      cards: [{ id: "card-a", count: 50 }]
    });
    writeSavedDeck(join(library, "carnerr-b.json"), {
      id: "carnerr-b",
      name: "Carnerr B",
      summary: { sourceCode: "TSK", colors: ["blue"] },
      cards: [{ id: "card-b", count: 50 }]
    });
    writeSavedDeck(join(library, "carnerr-c.json"), {
      id: "carnerr-c",
      name: "Carnerr C",
      summary: { sourceCode: "KGR", colors: ["red"] },
      cards: [{ id: "card-c", count: 50 }]
    });

    runTool("tools/pilot-auto-refiner.mjs", [
      "--dry-run",
      "--agent-root", agentRoot,
      "--library", library,
      "--catalog", join(root, "catalog.json"),
      "--policy-dir", join(agentRoot, "policies"),
      "--baseline-root", join(agentRoot, "baselines"),
      "--runs-root", join(agentRoot, "runs"),
      "--out-root", outRoot,
      "--session", "retry-batches",
      "--decks", "carnerr-a,carnerr-b,carnerr-c",
      "--deck-advance-mode", "batch",
      "--max-jobs", "3",
      "--stages", "light",
      "--parallel-runs", "2",
      "--parallel-concurrency", "2",
      "--baseline-refresh-batch-size", "2",
      "--baseline-suite-retry-rounds", "2"
    ]);

    const state = readJson(join(outRoot, "auto-refiner-state.json"));
    assert.equal(state.jobs.length, 3);
    assert.deepEqual(state.jobs.map((job) => job.taskType), ["baseline-suite", "baseline-suite", "baseline-suite"]);
    assert.deepEqual(state.jobs[0].profileKeys, ["eva-purple", "tsk-blue"]);
    assert.deepEqual(state.jobs[1].profileKeys, ["kgr-red"]);
    assert.deepEqual(state.jobs[2].profileKeys, ["eva-purple", "tsk-blue"]);
    assert.equal(state.pass.baselineSuiteRounds, 1);
    assert.deepEqual(state.pass.baselineRoundAttemptedProfileKeys, ["eva-purple", "tsk-blue"]);
    assert.deepEqual(state.pass.baselineAttemptedProfileKeys, ["eva-purple", "tsk-blue", "kgr-red"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pilot baseline-suite dry-run does not pre-create missing routed baselines", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-baseline-suite-dry-"));
  try {
    const agentRoot = join(root, "pilot-agent");
    const library = join(root, "decks");
    const catalog = join(root, "catalog.json");
    const baselineRoot = join(agentRoot, "baselines");
    const policyDir = join(agentRoot, "policies");
    const outDir = join(root, "out");
    mkdirSync(library, { recursive: true });
    writeFileSync(catalog, "{}\n");
    writeSavedDeck(join(library, "carnerr-a.json"), {
      id: "carnerr-a",
      name: "Carnerr A",
      summary: { sourceCode: "EVA", colors: ["purple"] },
      cards: [{ id: "card-a", count: 50 }]
    });

    const result = runTool("tools/pilot-agent.mjs", [
      "train",
      "--preset", "baseline-suite",
      "--parallel-decks", "missing-baselines",
      "--opponent-mode", "mirror",
      "--parallel-opponent-diversity", "none",
      "--parallel-runs", "2",
      "--parallel-concurrency", "2",
      "--library", library,
      "--catalog", catalog,
      "--policy-dir", policyDir,
      "--baseline-root", baselineRoot,
      "--out-dir", outDir,
      "--dry-run",
      "--no-validate"
    ]);

    assert.match(result.stdout, /Baseline training selector found 1\/1/u);
    assert.match(result.stdout, /Dry run: skipped 1 parallel training run/u);
    const manifest = readJson(join(outDir, "parallel-dry-run.json"));
    const ownKey = manifest.parallelDeckSelection.selectedDecks[0].ownKey;
    assert.equal(ownKey, "eva-purple");
    assert.equal(existsSync(baselinePolicyPathForKey(ownKey, { baselineRoot })), false);
    assert.equal(existsSync(baselineOriginPathForKey(ownKey, { baselineRoot })), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pilot baseline-suite dry-run can target selected decks and pass baseline root", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-baseline-suite-select-"));
  try {
    const agentRoot = join(root, "pilot-agent");
    const library = join(root, "decks");
    const catalog = join(root, "catalog.json");
    const baselineRoot = join(agentRoot, "baselines");
    const outRoot = join(root, "baseline-suite");
    mkdirSync(library, { recursive: true });
    writeFileSync(catalog, "{}\n");
    writeSavedDeck(join(library, "carnerr-a.json"), {
      id: "carnerr-a",
      name: "Carnerr A",
      summary: { sourceCode: "EVA", colors: ["purple"] },
      cards: [{ id: "card-a", count: 50 }]
    });
    writeSavedDeck(join(library, "carnerr-b.json"), {
      id: "carnerr-b",
      name: "Carnerr B",
      summary: { sourceCode: "TSK", colors: ["blue"] },
      cards: [{ id: "card-b", count: 50 }]
    });

    runTool("tools/pilot-baseline-suite.mjs", [
      "--dry-run",
      "--agent-root", agentRoot,
      "--library", library,
      "--policy-dir", join(agentRoot, "policies"),
      "--baseline-root", baselineRoot,
      "--runs-root", join(agentRoot, "runs"),
      "--out-root", outRoot,
      "--session", "select",
      "--decks", "carnerr-b",
      "--suite-concurrency", "2",
      "--counterfactual-exploration-rate", "0.44",
      "--counterfactual-max-per-game", "3",
      "--counterfactual-rollout-actions", "55"
    ]);

    const state = readJson(join(outRoot, "baseline-suite-state.json"));
    assert.deepEqual(state.decks.map((deck) => deck.id), ["carnerr-b"]);
    assert.equal(state.config.baselineRoot, baselineRoot);
    assert.equal(state.config.suiteConcurrency, 2);
    assert.equal(state.results.length, 1);
    assert.match(state.results[0].command, escapedRegExp(`--baseline-root ${baselineRoot}`));
    assert.match(state.results[0].command, /--agent-preset baseline-suite/u);
    assert.match(state.results[0].command, /--games 8/u);
    assert.match(state.results[0].command, /--generations 2/u);
    assert.match(state.results[0].command, /--population 4/u);
    assert.match(state.results[0].command, /--final-games 8/u);
    assert.match(state.results[0].command, /--parallel-opponent-count-per-run 6/u);
    assert.match(state.results[0].command, /--parallel-final-games 0/u);
    assert.match(state.results[0].command, /--parallel-final-candidates best-baseline/u);
    assert.match(state.results[0].command, /--counterfactual-exploration-rate 0\.44/u);
    assert.match(state.results[0].command, /--counterfactual-max-per-game 3/u);
    assert.match(state.results[0].command, /--counterfactual-rollout-actions 55/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pilot loop baseline-suite preset starts lean baseline cycles", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-loop-baseline-suite-preset-"));
  try {
    runTool("tools/pilot-loop-overseer.mjs", [
      "--training-mode", "deck",
      "--agent-preset", "baseline-suite",
      "--deck", "carnerr-a",
      "--own-key", "eva-purple",
      "--cycles", "1",
      "--out-root", root,
      "--runs-root", join(root, "runs"),
      "--baseline-root", join(root, "baselines"),
      "--policy-dir", join(root, "policies"),
      "--agent-root", join(root, "agent"),
      "--exploration-max-per-game", "2",
      "--dry-run"
    ]);

    const state = readJson(join(root, "loop-state.json"));
    assert.equal(state.config.agentPreset, "baseline-suite");
    assert.equal(state.config.population, 6);
    assert.equal(state.config.parallelFinalGames, 0);
    assert.equal(state.config.parallelFinalCandidates, "best-baseline");
    assert.equal(state.config.updateRoutedPolicy, false);
    assert.equal(state.config.skipParallelFinal, true);
    assert.equal(state.config.explorationMaxPerGame, "2");
    assert.match(state.cycles[0].trainCommand, /--preset baseline-suite/u);
    assert.match(state.cycles[0].trainCommand, /--exploration-max-per-game 2/u);
    assert.doesNotMatch(state.cycles[0].trainCommand, /--parallel-final-games/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pilot baseline-suite missing-only schedules only missing or seed baselines", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-baseline-suite-missing-only-"));
  try {
    const agentRoot = join(root, "pilot-agent");
    const library = join(root, "decks");
    const baselineRoot = join(agentRoot, "baselines");
    const outRoot = join(root, "baseline-suite");
    mkdirSync(library, { recursive: true });
    writeSavedDeck(join(library, "carnerr-a.json"), {
      id: "carnerr-a",
      name: "Carnerr A",
      summary: { sourceCode: "EVA", colors: ["purple"] },
      cards: [{ id: "card-a", count: 50 }]
    });
    writeSavedDeck(join(library, "carnerr-b.json"), {
      id: "carnerr-b",
      name: "Carnerr B",
      summary: { sourceCode: "TSK", colors: ["blue"] },
      cards: [{ id: "card-b", count: 50 }]
    });
    writeSavedDeck(join(library, "carnerr-c.json"), {
      id: "carnerr-c",
      name: "Carnerr C",
      summary: { sourceCode: "KGR", colors: ["red"] },
      cards: [{ id: "card-c", count: 50 }]
    });
    writeJsonAtomicSync(baselinePolicyPathForKey("eva-purple", { baselineRoot }), {
      name: "trained-policy",
      weights: {}
    });
    writeJsonAtomicSync(baselineOriginPathForKey("eva-purple", { baselineRoot }), {
      schema: "union-arena-local-engine/baseline-origin@1",
      quality: "trained",
      promotionType: "improved",
      needsTraining: false,
      acceptedForLearning: true
    });
    writeJsonAtomicSync(baselinePolicyPathForKey("tsk-blue", { baselineRoot }), {
      name: "seed-policy",
      weights: {}
    });
    writeJsonAtomicSync(baselineOriginPathForKey("tsk-blue", { baselineRoot }), {
      schema: "union-arena-local-engine/baseline-origin@1",
      quality: "seed",
      promotionType: "missing-seed",
      needsTraining: true,
      acceptedForLearning: false
    });
    writeJsonAtomicSync(join(agentRoot, "policies", "kgr-red.json"), {
      name: "legacy-policy",
      weights: {}
    });

    runTool("tools/pilot-baseline-suite.mjs", [
      "--dry-run",
      "--missing-only",
      "--agent-root", agentRoot,
      "--library", library,
      "--policy-dir", join(agentRoot, "policies"),
      "--baseline-root", baselineRoot,
      "--runs-root", join(agentRoot, "runs"),
      "--out-root", outRoot,
      "--session", "missing-only",
      "--suite-concurrency", "2"
    ]);

    const state = readJson(join(outRoot, "baseline-suite-state.json"));
    assert.deepEqual(state.decks.map((deck) => deck.id), ["carnerr-b", "carnerr-c"]);
    assert.deepEqual(state.decks.map((deck) => deck.baselineStatus), ["seed", "legacy"]);
    assert.equal(state.config.missingOnly, true);
    assert.equal(state.results.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pilot baseline-suite retries seed routed baselines until trained", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-baseline-seed-retry-"));
  try {
    const agentRoot = join(root, "pilot-agent");
    const library = join(root, "decks");
    const catalog = join(root, "catalog.json");
    const baselineRoot = join(agentRoot, "baselines");
    const policyDir = join(agentRoot, "policies");
    const outDir = join(root, "out");
    mkdirSync(library, { recursive: true });
    writeFileSync(catalog, "{}\n");
    writeSavedDeck(join(library, "carnerr-a.json"), {
      id: "carnerr-a",
      name: "Carnerr A",
      summary: { sourceCode: "EVA", colors: ["purple"] },
      cards: [{ id: "card-a", count: 50 }]
    });
    writeJsonAtomicSync(baselinePolicyPathForKey("eva-purple", { baselineRoot }), {
      name: "seed-policy",
      weights: {}
    });
    writeJsonAtomicSync(baselineOriginPathForKey("eva-purple", { baselineRoot }), {
      schema: "union-arena-local-engine/baseline-origin@1",
      quality: "seed",
      promotionType: "missing-seed",
      needsTraining: true,
      acceptedForLearning: false
    });

    const result = runTool("tools/pilot-agent.mjs", [
      "train",
      "--preset", "baseline-suite",
      "--parallel-decks", "missing-baselines",
      "--opponent-mode", "mirror",
      "--parallel-opponent-diversity", "none",
      "--parallel-runs", "2",
      "--parallel-concurrency", "2",
      "--library", library,
      "--catalog", catalog,
      "--policy-dir", policyDir,
      "--baseline-root", baselineRoot,
      "--out-dir", outDir,
      "--dry-run",
      "--no-validate"
    ]);

    assert.match(result.stdout, /Baseline training selector found 1\/1/u);
    const manifest = readJson(join(outDir, "parallel-dry-run.json"));
    const selected = manifest.parallelDeckSelection.selectedDecks[0];
    assert.equal(selected.ownKey, "eva-purple");
    assert.equal(selected.baselineStatus, "seed");
    assert.equal(selected.baselineOrigin.quality, "seed");
    assert.equal(selected.baselineOrigin.needsTraining, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("custom pilot runs cannot update routed baselines without explicit opt-in", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-custom-route-safety-"));
  try {
    const library = join(root, "decks");
    const catalog = join(root, "catalog.json");
    const baselineRoot = join(root, "baselines");
    const outDir = join(root, "out");
    mkdirSync(library, { recursive: true });
    writeFileSync(catalog, "{}\n");
    writeSavedDeck(join(library, "carnerr-a.json"), {
      id: "carnerr-a",
      name: "Carnerr A",
      summary: { sourceCode: "EVA", colors: ["purple"] },
      cards: [{ id: "card-a", count: 50 }]
    });

    runTool("tools/pilot-agent.mjs", [
      "train",
      "--preset", "custom",
      "--deck", "carnerr-a",
      "--opponent-mode", "mirror",
      "--games", "0",
      "--final-games", "0",
      "--generations", "0",
      "--population", "1",
      "--library", library,
      "--catalog", catalog,
      "--baseline-root", baselineRoot,
      "--out-dir", outDir,
      "--no-create-routed-policy",
      "--no-validate"
    ]);

    const report = readJson(join(outDir, "report.json"));
    const promotion = readJson(join(outDir, "routed-policy-promotion.json"));
    assert.equal(report.config.routedPolicyUpdatesEnabled, false);
    assert.equal(promotion.promote, false);
    assert.match(promotion.reason, /disabled/u);
    assert.equal(existsSync(baselinePolicyPathForKey("eva-purple", { baselineRoot })), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deck preset records efficient learning evidence without an explicit mode flag", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-deck-preset-learning-"));
  try {
    const library = join(root, "decks");
    const catalog = join(root, "catalog.json");
    const baselineRoot = join(root, "baselines");
    const outDir = join(root, "out");
    mkdirSync(library, { recursive: true });
    writeFileSync(catalog, "{}\n");
    writeSavedDeck(join(library, "carnerr-a.json"), {
      id: "carnerr-a",
      name: "Carnerr A",
      summary: { sourceCode: "EVA", colors: ["purple"] },
      cards: [{ id: "card-a", count: 50 }]
    });

    runTool("tools/pilot-agent.mjs", [
      "train",
      "--preset", "deck",
      "--deck", "carnerr-a",
      "--opponent-mode", "mirror",
      "--parallel-runs", "1",
      "--games", "0",
      "--final-games", "0",
      "--generations", "0",
      "--population", "1",
      "--library", library,
      "--catalog", catalog,
      "--baseline-root", baselineRoot,
      "--out-dir", outDir,
      "--no-create-routed-policy",
      "--no-update-routed-policy",
      "--no-validate"
    ]);

    const report = readJson(join(outDir, "report.json"));
    assert.equal(report.config.decisionLogMode, "learning");
    assert.equal(report.config.actionExploration.rate, 0.02);
    assert.equal(report.config.actionExploration.maxPerGame, 1);
    assert.equal(report.config.counterfactualExploration.rate, 0.35);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quarantined ML history cannot suppress action exploration coverage", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-exploration-quarantine-"));
  try {
    const library = join(root, "decks");
    const catalog = join(root, "catalog.json");
    const blockedModelPath = join(root, "blocked-model.json");
    const healthyModelPath = join(root, "healthy-model.json");
    mkdirSync(library, { recursive: true });
    writeFileSync(catalog, "{}\n");
    writeSavedDeck(join(library, "carnerr-a.json"), {
      id: "carnerr-a",
      name: "Carnerr A",
      summary: { sourceCode: "EVA", colors: ["purple"] },
      cards: [{ id: "card-a", count: 50 }]
    });
    const model = {
      schema: "union-arena-local-engine/ml-action-model@1",
      learningSignalVersion: 2,
      includeChosenAnchor: false,
      minContextualObservations: 24,
      trainingStats: {
        "context.play.card.card-a": { observations: 99 }
      },
      weights: {
        "context.play.card.card-a": 100
      }
    };
    writeJsonAtomicSync(blockedModelPath, {
      ...model,
      samplingSafety: { status: "blocked" }
    });
    writeJsonAtomicSync(healthyModelPath, {
      ...model,
      samplingSafety: { status: "watch" }
    });

    const run = (modelPath, outDir) => runTool("tools/pilot-agent.mjs", [
      "train",
      "--preset", "custom",
      "--deck", "carnerr-a",
      "--opponent-mode", "mirror",
      "--games", "0",
      "--final-games", "0",
      "--generations", "0",
      "--population", "1",
      "--library", library,
      "--catalog", catalog,
      "--ml-model", modelPath,
      "--out-dir", outDir,
      "--no-create-routed-policy",
      "--no-update-routed-policy",
      "--no-validate"
    ]);

    const blockedOut = join(root, "blocked-out");
    run(blockedModelPath, blockedOut);
    const blockedEvidence = readJson(join(blockedOut, "report.json")).config.actionExploration.evidence;
    assert.equal(blockedEvidence.source, "session-bootstrap");
    assert.equal(blockedEvidence.ignoredSource, blockedModelPath);
    assert.equal(blockedEvidence.ignoredReason, "blocked-sampling-safety");
    assert.equal(blockedEvidence.contextualFeatures, 0);
    assert.equal(blockedEvidence.evidenceObservations, 0);

    const healthyOut = join(root, "healthy-out");
    run(healthyModelPath, healthyOut);
    const healthyEvidence = readJson(join(healthyOut, "report.json")).config.actionExploration.evidence;
    assert.equal(healthyEvidence.source, healthyModelPath);
    assert.equal(healthyEvidence.ignoredReason, null);
    assert.equal(healthyEvidence.contextualFeatures, 1);
    assert.equal(healthyEvidence.evidenceObservations, 99);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("saved pilot baselines do not compound the ML correction across runs", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-policy-layering-"));
  try {
    const library = join(root, "decks");
    const catalog = join(root, "catalog.json");
    const basePolicyPath = join(root, "base-policy.json");
    const modelPath = join(root, "model.json");
    mkdirSync(library, { recursive: true });
    writeFileSync(catalog, "{}\n");
    writeSavedDeck(join(library, "carnerr-a.json"), {
      id: "carnerr-a",
      name: "Carnerr A",
      summary: { sourceCode: "EVA", colors: ["purple"] },
      cards: [{ id: "card-a", count: 50 }]
    });
    writeJsonAtomicSync(basePolicyPath, {
      schema: DEFAULT_PILOT_POLICY.schema,
      name: "base-policy",
      weights: { ...DEFAULT_PILOT_POLICY.weights, playCard: 10 }
    });
    writeJsonAtomicSync(modelPath, causallyReadyActionModel());

    const run = (policyPath, outDir) => runTool("tools/pilot-agent.mjs", [
      "train",
      "--preset", "custom",
      "--deck", "carnerr-a",
      "--opponent-mode", "mirror",
      "--policy", policyPath,
      "--ml-model", modelPath,
      "--ml-strength", "1",
      "--games", "0",
      "--final-games", "0",
      "--generations", "0",
      "--population", "1",
      "--library", library,
      "--catalog", catalog,
      "--out-dir", outDir,
      "--no-validate"
    ]);

    const firstOut = join(root, "first");
    run(basePolicyPath, firstOut);
    const firstReport = readJson(join(firstOut, "report.json"));
    const firstStoredPolicy = readJson(join(firstOut, "best-policy.json"));
    assert.equal(firstReport.config.policySelection.storedPolicyLayer, "base-policy-without-ml");
    assert.equal(firstStoredPolicy.weights.playCard, 10);

    const secondOut = join(root, "second");
    run(join(firstOut, "best-policy.json"), secondOut);
    const secondStoredPolicy = readJson(join(secondOut, "best-policy.json"));
    assert.equal(secondStoredPolicy.weights.playCard, 10);
    assert.deepEqual(secondStoredPolicy.weights, firstStoredPolicy.weights);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pilot evaluation can select the untouched default policy explicitly", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-default-policy-selector-"));
  try {
    const library = join(root, "decks");
    const catalog = join(root, "catalog.json");
    const outDir = join(root, "out");
    mkdirSync(library, { recursive: true });
    writeFileSync(catalog, "{}\n");
    writeSavedDeck(join(library, "carnerr-a.json"), {
      id: "carnerr-a",
      name: "Carnerr A",
      summary: { sourceCode: "EVA", colors: ["purple"] },
      cards: [{ id: "card-a", count: 50 }]
    });

    runTool("tools/pilot-agent.mjs", [
      "evaluate",
      "--deck", "carnerr-a",
      "--opponent-mode", "mirror",
      "--policy", "default",
      "--games", "0",
      "--library", library,
      "--catalog", catalog,
      "--out-dir", outDir,
      "--no-validate"
    ]);

    const report = readJson(join(outDir, "report.json"));
    assert.equal(report.config.policySelection.mode, "explicit");
    assert.equal(report.config.policySelection.path, "default");
    assert.equal(report.config.evaluationExplorationEnabled, false);

    const diagnosticOut = join(root, "diagnostic-out");
    runTool("tools/pilot-agent.mjs", [
      "evaluate",
      "--deck", "carnerr-a",
      "--opponent-mode", "mirror",
      "--policy", "default",
      "--games", "0",
      "--library", library,
      "--catalog", catalog,
      "--out-dir", diagnosticOut,
      "--no-validate",
      "--explore-evaluation",
      "--exploration-rate", "0.2"
    ]);
    const diagnostic = readJson(join(diagnosticOut, "report.json"));
    assert.equal(diagnostic.config.evaluationExplorationEnabled, true);
    assert.equal(diagnostic.config.actionExploration.rate, 0.2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pilot loop dry-run keeps strict matchup validation gate without rollback side effects", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-loop-dry-"));
  try {
    const result = runTool("tools/pilot-loop-overseer.mjs", [
      "--training-mode", "matchup",
      "--deck", "carnerr-spear",
      "--own-key", "test-own",
      "--opponents", "test-opponent",
      "--cycles", "1",
      "--out-root", root,
      "--runs-root", join(root, "runs"),
      "--baseline-root", join(root, "baselines"),
      "--policy-dir", join(root, "policies"),
      "--agent-root", join(root, "agent"),
      "--counterfactual-exploration-rate", "0.44",
      "--counterfactual-max-per-game", "3",
      "--counterfactual-rollout-actions", "55",
      "--counterfactual-rollout-player-turns", "4",
      "--dry-run"
    ]);

    assert.doesNotMatch(result.stdout, /Rolled back|Could not rollback/u);
    const state = readJson(join(root, "loop-state.json"));
    assert.equal(state.config.matchupValidationGate, "positive");
    assert.equal(state.config.dryRun, true);
    assert.equal(state.config.counterfactualExplorationRate, "0.44");
    assert.equal(state.config.counterfactualMaxPerGame, "3");
    assert.equal(state.config.counterfactualRolloutActions, "55");
    assert.equal(state.config.counterfactualRolloutPlayerTurns, "4");
    assert.match(state.cycles[0].trainCommand, /--counterfactual-exploration-rate 0\.44/u);
    assert.match(state.cycles[0].trainCommand, /--counterfactual-max-per-game 3/u);
    assert.match(state.cycles[0].trainCommand, /--counterfactual-rollout-actions 55/u);
    assert.match(state.cycles[0].trainCommand, /--counterfactual-rollout-player-turns 4/u);
    assert.equal(state.cycles[0].matchupValidationRollback, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pilot loop rollback preserves inactive or independently accepted action-model evidence", () => {
  const source = readFileSync("tools/pilot-loop-overseer.mjs", "utf8");
  assert.match(source, /function actionModelRetentionAfterRollbackCandidate/u);
  assert.match(source, /config\.knowledgeMode !== "full"/u);
  assert.match(source, /runtimeTrust > 0 && !pairedActionImprovement/u);
  assert.match(source, /retainActionModelAfterRollback/u);
  assert.match(source, /pairedActionValidation/u);
  assert.match(source, /retainedAfterMatchupRollback/u);
  assert.match(source, /matchupOverlayCandidateRetentionAfterRollback/u);
  assert.match(source, /retainMatchupOverlayCandidatesAfterRollback/u);
  assert.match(source, /matchupOverlayCandidatePathForKeys/u);
});

test("pilot loop restores profile snapshots after failed training or knowledge subprocesses", () => {
  const source = readFileSync("tools/pilot-loop-overseer.mjs", "utf8");
  assert.match(source, /trainingBeforeBaselineRoot/u);
  assert.match(source, /trainingFailureRollback/u);
  assert.match(source, /knowledgeFailureRollback/u);
  assert.match(source, /restored the post-training, pre-knowledge profile/u);
  assert.match(source, /restoreDirectorySnapshotSync\(\{ source, target \}\)/u);
});

test("pilot loop excludes rejected cycles from cumulative knowledge inputs", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-loop-cumulative-"));
  try {
    runTool("tools/pilot-loop-overseer.mjs", [
      "--training-mode", "matchup",
      "--deck", "carnerr-spear",
      "--own-key", "test-own",
      "--opponents", "test-opponent",
      "--cycles", "2",
      "--no-stop-if-no-learning",
      "--out-root", root,
      "--runs-root", join(root, "runs"),
      "--baseline-root", join(root, "baselines"),
      "--policy-dir", join(root, "policies"),
      "--agent-root", join(root, "agent"),
      "--dry-run"
    ]);

    const state = readJson(join(root, "loop-state.json"));
    const launchPlan = readJson(join(root, "launch-plan.json"));
    assert.equal(state.cycles.length, 2);
    assert.equal(state.config.cumulativeKnowledge, false);
    assert.equal(state.config.knowledgeInputMode, "incremental");
    assert.equal(launchPlan.knowledge.inputMode, "incremental");
    assert.equal(launchPlan.knowledge.incrementalArtifactsRetainHistory, true);
    assert.equal(state.cycles[0].learningAccepted, false);
    assert.equal(state.cycles[1].learningAccepted, false);

    const cycleOneRun = state.cycles[0].runDir;
    const cycleTwoRun = state.cycles[1].runDir;
    const cycleTwoKnowledgeCommand = readFileSync(join(root, "cycle-02", "knowledge-command.ps1"), "utf8");
    assert.doesNotMatch(cycleTwoKnowledgeCommand, escapedRegExp(cycleOneRun));
    assert.match(cycleTwoKnowledgeCommand, escapedRegExp(cycleTwoRun));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("knowledge update flags poisoned decision logs as blocked learning health", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-knowledge-health-"));
  try {
    const agentRoot = join(root, "pilot-agent");
    const baselineRoot = join(agentRoot, "baselines");
    const runDir = join(root, "run");
    const outDir = join(root, "knowledge");
    mkdirSync(runDir, { recursive: true });
    const rows = Array.from({ length: 24 }, (_, index) => decisionRows(`poisoned-${index}`, {
      gameIndex: index + 1,
      seed: 71_000 + index,
      outcome: "incomplete",
      reward: 0,
      shapedReward: 0,
      learningEligible: false,
      learningSignalVersion: 1,
      candidateCount: 1,
      creditWeight: 0
    })).flat();
    writeFileSync(join(runDir, "decision-log.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

    runTool("tools/update-pilot-knowledge.mjs", [
      "--input", runDir,
      "--own-key", "eva-purple",
      "--deck", "carnerr-spear",
      "--out-dir", outDir,
      "--agent-root", agentRoot,
      "--policy-dir", join(agentRoot, "policies"),
      "--baseline-root", baselineRoot,
      "--skip-ml",
      "--skip-profile-overlays",
      "--skip-variant-overlays"
    ]);

    const manifest = readJson(join(outDir, "knowledge-update.json"));
    assert.equal(manifest.learningHealth.status, "blocked");
    assert.ok(manifest.learningHealth.blockers.some((item) => item.includes("Incomplete chosen decisions")));
    assert.ok(manifest.learningHealth.blockers.some((item) => item.includes("current learning signals")));
    assert.equal(manifest.decisions.rates.incomplete, 1);
    assert.equal(manifest.decisions.rates.forced, 1);
    assert.equal(manifest.decisions.rates.version2, 0);
    assert.equal(manifest.learningInputs.preflight.blocked, true);
    assert.equal(manifest.commandResults.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("blocked knowledge updates skip artifact training during preflight", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-knowledge-artifact-health-"));
  try {
    const agentRoot = join(root, "pilot-agent");
    const baselineRoot = join(agentRoot, "baselines");
    const policyDir = join(agentRoot, "policies");
    const runDir = join(root, "run");
    const outDir = join(root, "knowledge");
    mkdirSync(runDir, { recursive: true });
    const currentRows = Array.from({ length: 6 }, (_, index) => decisionRows(`current-${index}`, {
      gameIndex: index + 1,
      seed: 10_000 + index,
      candidateId: `current-${index}`,
      outcome: index % 2 === 0 ? "win" : "loss",
      reward: index % 2 === 0 ? 1 : -1,
      shapedReward: index % 2 === 0 ? 1 : -1,
      learningSignalVersion: 2,
      learningEligible: true,
      candidateCount: 2,
      creditWeight: 1
    })).flat();
    const staleRows = Array.from({ length: 18 }, (_, index) => decisionRows(`stale-${index}`, {
      gameIndex: 100 + index,
      seed: 20_000 + index,
      candidateId: `stale-${index}`,
      outcome: "loss",
      reward: -1,
      shapedReward: -1,
      learningSignalVersion: 1,
      learningEligible: true,
      candidateCount: 2,
      creditWeight: 1
    })).flat();
    writeFileSync(join(runDir, "decision-log.jsonl"), `${[...currentRows, ...staleRows].map((row) => JSON.stringify(row)).join("\n")}\n`);

    runTool("tools/update-pilot-knowledge.mjs", [
      "--input", runDir,
      "--own-key", "eva-purple",
      "--deck", "carnerr-spear",
      "--out-dir", outDir,
      "--agent-root", agentRoot,
      "--policy-dir", policyDir,
      "--baseline-root", baselineRoot,
      "--ml-min-observations", "1",
      "--profile-min-examples", "1",
      "--profile-min-observations", "1",
      "--validation-fraction", "0",
      "--skip-variant-overlays"
    ]);

    const manifest = readJson(join(outDir, "knowledge-update.json"));
    assert.equal(manifest.learningHealth.status, "blocked");
    assert.ok(manifest.learningHealth.blockers.some((item) => item.includes("current learning signals")));
    assert.equal(manifest.learningInputs.preflight.blocked, true);
    assert.equal(manifest.commandResults.length, 0);
    assert.deepEqual(manifest.stampedLearningArtifacts, []);
    assert.equal(existsSync(actionModelPathForKey("eva-purple", { agentRoot, baselineRoot })), false);
    assert.equal(existsSync(join(baselineRoot, "decks", "eva-purple", "matchups", "test-opponent.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("knowledge health warns when decision coverage is too narrow", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-knowledge-coverage-"));
  try {
    const agentRoot = join(root, "pilot-agent");
    const runDir = join(root, "run");
    const outDir = join(root, "knowledge");
    mkdirSync(runDir, { recursive: true });
    const rows = Array.from({ length: 100 }, (_, index) => decisionRows(`main-only-${index}`, {
      gameIndex: index + 1,
      seed: 30_000 + index,
      candidateId: `main-only-${index}`,
      outcome: "win",
      reward: 1,
      shapedReward: 1,
      learningEligible: true,
      learningSignalVersion: 2,
      candidateCount: 2,
      creditWeight: 1,
      creditPhase: "main",
      phase: "main",
      counterfactualPreference: "chosen"
    })).flat();
    writeFileSync(join(runDir, "decision-log.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

    runTool("tools/update-pilot-knowledge.mjs", [
      "--input", runDir,
      "--own-key", "eva-purple",
      "--deck", "carnerr-spear",
      "--out-dir", outDir,
      "--agent-root", agentRoot,
      "--policy-dir", join(agentRoot, "policies"),
      "--baseline-root", join(agentRoot, "baselines"),
      "--skip-ml",
      "--skip-profile-overlays",
      "--skip-variant-overlays"
    ]);

    const manifest = readJson(join(outDir, "knowledge-update.json"));
    assert.equal(manifest.learningInputs.preflight.blocked, false);
    assert.equal(manifest.learningHealth.status, "watch");
    assert.equal(manifest.decisions.playerGames, 100);
    assert.equal(manifest.decisions.coverage.significantPhaseCount, 1);
    assert.equal(manifest.decisions.coverage.topAction, "playCard");
    assert.equal(manifest.decisions.coverage.topActionRate, 1);
    assert.equal(manifest.decisions.policyFeatureCoverage.candidates.observedGroupCount, 2);
    assert.ok(manifest.decisions.policyFeatureCoverage.candidates.missingGroups.includes("raid"));
    assert.equal(manifest.decisions.policyFeatureCoverage.credit.topGroups[0].key, "development");
    assert.equal(manifest.decisions.policyFeatureCoverage.credit.topGroups[0].share, 1);
    assert.ok(manifest.learningHealth.warnings.some((item) => item.includes("Decision coverage is narrow")));
    assert.ok(manifest.learningHealth.warnings.some((item) => item.includes("Action coverage is concentrated")));
    assert.ok(manifest.learningHealth.warnings.some((item) => item.includes("Setup/mulligan decision evidence is thin")));
    assert.ok(manifest.learningHealth.warnings.some((item) => item.includes("Attack-phase decision evidence is missing")));
    assert.ok(manifest.learningHealth.warnings.some((item) => item.includes("Strategic feature coverage is narrow")));
    assert.ok(manifest.learningHealth.warnings.some((item) => item.includes("Missing strategic feature groups")));
    assert.ok(manifest.learningHealth.warnings.some((item) => item.includes("Learning credit is concentrated")));
    assert.equal(manifest.learningHealth.warnings.some((item) => item.includes("Counterfactual coverage is thin")), false);
    assert.match(readFileSync(join(outDir, "summary.md"), "utf8"), /## Decision Coverage/u);
    assert.match(readFileSync(join(outDir, "summary.md"), "utf8"), /## Strategic Feature Coverage/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("knowledge health recognizes causally tested raid normal-play options without live deviations", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-knowledge-raid-opportunity-"));
  try {
    const agentRoot = join(root, "pilot-agent");
    const runDir = join(root, "run");
    const outDir = join(root, "knowledge");
    mkdirSync(runDir, { recursive: true });
    const rows = Array.from({ length: 90 }, (_, index) => {
      const common = {
        schema: "union-arena-local-engine/pilot-decision@1",
        decisionKey: `raid-only-${index}`,
        gameIndex: index + 1,
        seed: 40_000 + index,
        opponent: "opponent",
        candidateId: `raid-only-${index}`,
        step: 1,
        player: "P1",
        phase: "main",
        matchupProfileKey: "test-opponent",
        matchupVariantKey: "test-opponent",
        matchupVariantStatus: "profile",
        outcome: "win",
        reward: 1,
        shapedReward: 1,
        finalLifeDiffForPlayer: 1,
        finalTurnCycles: 6,
        learningEligible: true,
        learningSignalVersion: 2,
        candidateCount: 2,
        creditWeight: 1,
        counterfactualPreference: "chosen",
        counterfactualEvidenceKind: "horizon",
        counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION,
        counterfactualAlternativeIndex: 1,
        counterfactualAlternativeAction: { type: "playCard", cardId: "raid-payoff", destination: "front" }
      };
      return [
        {
          ...common,
          actionIndex: 0,
          chosen: true,
          actionType: "performRaid",
          policyRank: 1,
          heuristicScore: 500,
          scoreDeltaFromChosen: 0,
          action: { type: "performRaid", cardId: "raid-payoff" },
          features: { baseScore: 1, performRaid: 1, playCard: 1, roleRaidPayoff: 1 }
        },
        {
          ...common,
          actionIndex: 1,
          chosen: false,
          actionType: "playCard",
          policyRank: 2,
          heuristicScore: 420,
          scoreDeltaFromChosen: -80,
          action: { type: "playCard", cardId: "raid-payoff", destination: "front" },
          features: { baseScore: 1, playCard: 1, playRaidCardNormally: 1, playRaidNormallyToFront: 1, roleRaidPayoff: 1 }
        }
      ];
    }).flat();
    writeFileSync(join(runDir, "decision-log.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

    runTool("tools/update-pilot-knowledge.mjs", [
      "--input", runDir,
      "--own-key", "eva-purple",
      "--deck", "carnerr-spear",
      "--out-dir", outDir,
      "--agent-root", agentRoot,
      "--policy-dir", join(agentRoot, "policies"),
      "--baseline-root", join(agentRoot, "baselines"),
      "--skip-ml",
      "--skip-profile-overlays",
      "--skip-variant-overlays"
    ]);

    const manifest = readJson(join(outDir, "knowledge-update.json"));
    const opportunity = manifest.decisions.coverage.actionOpportunityCoverage;
    assert.equal(opportunity.raidNormalPlay.available, 90);
    assert.equal(opportunity.raidNormalPlay.chosen, 0);
    assert.equal(opportunity.raidNormalPlay.causallyTested, 90);
    assert.equal(opportunity.raidNormalPlay.covered, 90);
    assert.equal(opportunity.raidNormalPlay.coverageRate, 1);
    assert.equal(opportunity.raidNormalPlay.chosenRaidActions, 90);
    assert.ok(opportunity.candidateOnlyActions.includes("playCard"));
    assert.ok(opportunity.causallyTestedActions.some((item) => item.key === "playCard" && item.count === 90));
    assert.equal(opportunity.candidateOnlyUncoveredActions.includes("playCard"), false);
    assert.equal(manifest.learningHealth.warnings.some((item) => item.includes("Raid normal-play options were logged")), false);
    assert.ok(manifest.learningHealth.strengths.some((item) => item.includes("90 direct Raid-versus-normal-play comparison(s)")));
    assert.match(readFileSync(join(outDir, "summary.md"), "utf8"), /Raid normal-play opportunities: 90; chosen: 0; causal alternatives: 90; covered: 100\.0%/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("knowledge health reports unsampled nested and Raid placement branches", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-knowledge-nested-opportunity-"));
  try {
    const agentRoot = join(root, "pilot-agent");
    const runDir = join(root, "run");
    const outDir = join(root, "knowledge");
    mkdirSync(runDir, { recursive: true });
    const nestedRows = Array.from({ length: 90 }, (_, index) => {
      const common = {
        schema: "union-arena-local-engine/pilot-decision@1",
        decisionKey: `nested-only-${index}`,
        gameIndex: index + 1,
        seed: 45_000 + index,
        opponent: "opponent",
        candidateId: `nested-only-${index}`,
        step: 1.001,
        player: "P1",
        phase: "main",
        matchupProfileKey: "test-opponent",
        matchupVariantKey: "test-opponent",
        matchupVariantStatus: "profile",
        outcome: "win",
        reward: 1,
        shapedReward: 1,
        finalLifeDiffForPlayer: 1,
        finalTurnCycles: 6,
        learningEligible: true,
        learningSignalVersion: 2,
        candidateCount: 2,
        creditWeight: 1
      };
      return {
        ...common,
        actionIndex: 0,
        chosen: true,
        actionType: "resolutionChoice",
        action: {
          type: "resolutionChoice",
          decisionKind: "optionalEffect",
          resolutionOption: "accept",
          sourceCardId: "optional-card"
        },
        candidateActionFamilies: [
          "resolutionChoice:optionaleffect:accept",
          "resolutionChoice:optionaleffect:decline"
        ],
        features: {
          baseScore: 1,
          resolutionChoice: 1,
          "context.resolution.optional-card.optionaleffect.accept": 1
        }
      };
    });
    const raidRows = Array.from({ length: 90 }, (_, index) => {
      const common = {
        ...nestedRows[index],
        decisionKey: `raid-placement-${index}`,
        gameIndex: 100 + index,
        seed: 46_000 + index,
        candidateId: `raid-placement-${index}`
      };
      delete common.chosen;
      delete common.actionIndex;
      delete common.actionType;
      delete common.action;
      delete common.candidateActionFamilies;
      delete common.features;
      return {
        ...common,
        actionIndex: 0,
        chosen: true,
        actionType: "performRaid",
        action: {
          type: "performRaid",
          moveToFront: false,
          targetLine: "energyLine",
          cardId: "raid-card"
        },
        candidateActionFamilies: [
          "performRaid:stay-energyLine",
          "performRaid:move-front-replace"
        ],
        features: { baseScore: 1, performRaid: 1, playCard: 1 }
      };
    });
    const rows = [...nestedRows, ...raidRows];
    writeFileSync(join(runDir, "decision-log.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

    runTool("tools/update-pilot-knowledge.mjs", [
      "--input", runDir,
      "--own-key", "eva-purple",
      "--deck", "carnerr-spear",
      "--out-dir", outDir,
      "--agent-root", agentRoot,
      "--policy-dir", join(agentRoot, "policies"),
      "--baseline-root", join(agentRoot, "baselines"),
      "--skip-ml",
      "--skip-profile-overlays",
      "--skip-variant-overlays"
    ]);

    const manifest = readJson(join(outDir, "knowledge-update.json"));
    const resolution = manifest.decisions.coverage.actionOpportunityCoverage.resolutionChoices;
    const optional = resolution.kinds.find((row) => row.kind === "optionaleffect");
    assert.equal(resolution.decisions, 90);
    assert.equal(optional.decisions, 90);
    assert.deepEqual(optional.options, [
      { option: "accept", available: 90, chosen: 90, causallyTested: 0, covered: 90, chosenRate: 1, causalRate: 0, coverageRate: 1 },
      { option: "decline", available: 90, chosen: 0, causallyTested: 0, covered: 0, chosenRate: 0, causalRate: 0, coverageRate: 0 }
    ]);
    assert.ok(manifest.learningHealth.warnings.some((item) => (
      item.includes("Nested optionaleffect opportunity sampling never played or causally tested decline")
    )));
    const opportunity = manifest.decisions.coverage.actionOpportunityCoverage;
    assert.deepEqual(opportunity.raidPlacement, {
      decisions: 90,
      options: [
        { option: "move-front-replace", available: 90, chosen: 0, causallyTested: 0, covered: 0, chosenRate: 0, causalRate: 0, coverageRate: 0 },
        { option: "stay-energyLine", available: 90, chosen: 90, causallyTested: 0, covered: 90, chosenRate: 1, causalRate: 0, coverageRate: 1 }
      ]
    });
    assert.deepEqual(opportunity.fieldReplacement, {
      available: 90,
      chosen: 0,
      causallyTested: 0,
      covered: 0,
      chosenRate: 0,
      causalRate: 0,
      coverageRate: 0
    });
    assert.ok(manifest.learningHealth.warnings.some((item) => (
      item.includes("Raid placement opportunity sampling never played or causally tested move-front-replace")
    )));
    assert.ok(manifest.learningHealth.warnings.some((item) => (
      item.includes("Field-replacement opportunity sampling logged 90 decision(s)")
    )));
    assert.match(readFileSync(join(outDir, "summary.md"), "utf8"), /optionaleffect \(accept 90 played \+ 0 causal \/ 90 available, decline 0 played \+ 0 causal \/ 90 available\)/u);
    assert.match(readFileSync(join(outDir, "summary.md"), "utf8"), /move-front-replace 0 played \+ 0 causal \/ 90 available, stay-energyLine 90 played \+ 0 causal \/ 90 available/u);

    const auditPath = join(root, "nested-audit.json");
    runTool("tools/audit-learning-data.mjs", ["--input", runDir, "--out", auditPath]);
    const audit = readJson(auditPath);
    assert.deepEqual(
      audit.actionOpportunityCoverage.resolutionChoices,
      resolution
    );
    assert.deepEqual(audit.actionOpportunityCoverage.raidPlacement, opportunity.raidPlacement);
    assert.deepEqual(audit.actionOpportunityCoverage.fieldReplacement, opportunity.fieldReplacement);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("learning game telemetry exposes sparse causal yield hidden by compact decision logs", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-knowledge-sampling-telemetry-"));
  try {
    const agentRoot = join(root, "pilot-agent");
    const runDir = join(root, "run");
    const outDir = join(root, "knowledge");
    mkdirSync(runDir, { recursive: true });
    const telemetry = Array.from({ length: 40 }, (_, index) => ({
      schema: LEARNING_GAME_TELEMETRY_SCHEMA,
      recordType: "learning-game",
      gameIndex: index + 1,
      seed: 80_000 + index,
      opponent: "regional-test-opponent",
      candidateId: `candidate-${index % 4}`,
      player: "P1",
      outcome: index % 2 === 0 ? "win" : "loss",
      complete: true,
      decisionOpportunities: 24,
      explorationDecisions: 0,
      counterfactualEnabled: true,
      counterfactualsEvaluated: index < 8 ? 1 : 0,
      actionableCounterfactuals: index < 4 ? 1 : 0,
      counterfactualTies: index >= 4 && index < 8 ? 1 : 0,
      unsynchronizedCounterfactuals: index >= 4 && index < 8 ? 1 : 0,
      counterfactualLowInformationSkips: 0
    }));
    const causalRows = Array.from({ length: 4 }, (_, index) => decisionRows(`telemetry-causal-${index}`, {
      gameIndex: index + 1,
      seed: 80_000 + index,
      candidateId: `candidate-${index}`,
      outcome: index % 2 === 0 ? "win" : "loss",
      reward: index % 2 === 0 ? 1 : -1,
      shapedReward: index % 2 === 0 ? 1 : -1,
      learningEligible: true,
      learningSignalVersion: 2,
      candidateCount: 2,
      creditWeight: 1,
      counterfactualPreference: index % 2 === 0 ? "chosen" : "alternative",
      counterfactualAdvantage: 0.5,
      counterfactualConfidence: 0.35,
      counterfactualAlternativeIndex: 1,
      counterfactualAlternativeAction: { type: "advancePhase" }
    })).flat();
    writeFileSync(
      join(runDir, "decision-log.jsonl"),
      `${[...telemetry, ...causalRows].map((row) => JSON.stringify(row)).join("\n")}\n`
    );

    runTool("tools/update-pilot-knowledge.mjs", [
      "--input", runDir,
      "--own-key", "eva-purple",
      "--deck", "carnerr-spear",
      "--out-dir", outDir,
      "--agent-root", agentRoot,
      "--policy-dir", join(agentRoot, "policies"),
      "--baseline-root", join(agentRoot, "baselines"),
      "--skip-ml",
      "--skip-profile-overlays",
      "--skip-variant-overlays"
    ]);

    const manifest = readJson(join(outDir, "knowledge-update.json"));
    assert.equal(manifest.decisions.chosenRows, 4);
    assert.equal(manifest.decisions.samplingTelemetry.playerGames, 40);
    assert.equal(manifest.decisions.samplingTelemetry.counterfactualsEvaluated, 8);
    assert.equal(manifest.decisions.samplingTelemetry.actionableCounterfactuals, 4);
    assert.equal(manifest.decisions.samplingTelemetry.unsynchronizedCounterfactuals, 4);
    assert.equal(manifest.learningHealth.sampling.telemetryAvailable, true);
    assert.equal(manifest.learningHealth.sampling.counterfactualsPerPlayerGame, 0.2);
    assert.equal(manifest.learningHealth.sampling.actionableCounterfactualsPerPlayerGame, 0.1);
    assert.equal(manifest.learningHealth.sampling.unsynchronizedCounterfactualRate, 0.5);
    assert.ok(manifest.learningHealth.warnings.some((item) => item.includes("Counterfactual coverage is thin")));
    assert.ok(manifest.learningHealth.warnings.some((item) => item.includes("Actionable counterfactual yield is thin")));
    assert.ok(manifest.learningHealth.warnings.some((item) => item.includes("action safety cap")));
    assert.match(readFileSync(join(outDir, "summary.md"), "utf8"), /Training games observed by sampling telemetry: 40/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("learning telemetry reports exploration breadth, actionable yield, and adaptive savings", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-knowledge-exploration-health-"));
  try {
    const agentRoot = join(root, "pilot-agent");
    const runDir = join(root, "run");
    const outDir = join(root, "knowledge");
    mkdirSync(runDir, { recursive: true });
    const telemetry = Array.from({ length: 12 }, (_, index) => ({
      schema: LEARNING_GAME_TELEMETRY_SCHEMA,
      recordType: "learning-game",
      gameIndex: index + 1,
      seed: 90_000 + index,
      opponent: "regional-test-opponent",
      candidateId: `candidate-${index % 4}`,
      player: "P1",
      outcome: index % 2 === 0 ? "win" : "loss",
      complete: true,
      decisionOpportunities: 20,
      explorationDecisions: 1,
      explorationProbeDecisions: 1,
      explorationActionDecisions: 0,
      explorationCoverageGapDecisions: index < 9 ? 1 : 0,
      explorationEvidenceAwareDecisions: index >= 9 ? 1 : 0,
      explorationScoreWeightedDecisions: 0,
      explorationPreviouslyAttemptedDecisions: index >= 9 ? 1 : 0,
      explorationUnseenDecisions: index < 6 ? 1 : 0,
      explorationEvidenceFeatureKeys: [
        `context.play.card-${index}`,
        `context.choice.line-${index % 4}`
      ],
      explorationEvidenceAttemptsAdded: 1,
      explorationEvidenceActionableAdded: index < 10 ? 1 : 0,
      explorationEvidenceFeaturesAdded: 2,
      counterfactualEnabled: true,
      counterfactualsEvaluated: 1,
      actionableCounterfactuals: index < 10 ? 1 : 0,
      counterfactualTies: index < 10 ? 0 : 1,
      unsynchronizedCounterfactuals: 0,
      counterfactualAdaptiveDecisions: 1,
      counterfactualAdaptiveEarlyStops: index < 4 ? 1 : 0,
      counterfactualAdaptiveAuditEligible: index < 5 ? 1 : 0,
      counterfactualAdaptiveAudits: index < 3 ? 1 : 0,
      counterfactualAdaptiveAuditAgreements: index < 3 ? 1 : 0,
      counterfactualAdaptiveAuditDisagreements: 0,
      counterfactualRequestedPlayerTurns: 3,
      counterfactualEvaluatedPlayerTurns: index < 4 ? 2 : 3,
      counterfactualEstimatedPlayerTurnsSaved: index < 4 ? 1 : 0,
      counterfactualLowInformationSkips: 0
    }));
    const decisions = Array.from({ length: 12 }, (_, index) => decisionRows(`exploration-health-${index}`, {
      gameIndex: index + 1,
      seed: 90_000 + index,
      candidateId: `candidate-${index % 4}`,
      outcome: index % 2 === 0 ? "win" : "loss",
      reward: index % 2 === 0 ? 1 : -1,
      shapedReward: index % 2 === 0 ? 1 : -1,
      learningEligible: true,
      learningSignalVersion: 2,
      candidateCount: 2,
      creditWeight: 1,
      counterfactualPreference: "chosen",
      counterfactualAdvantage: 0.5,
      counterfactualConfidence: 0.3,
      counterfactualAlternativeIndex: 1,
      counterfactualAlternativeAction: { type: "advancePhase" }
    })).flat();
    writeFileSync(
      join(runDir, "decision-log.jsonl"),
      `${[...telemetry, ...decisions].map((row) => JSON.stringify(row)).join("\n")}\n`
    );

    runTool("tools/update-pilot-knowledge.mjs", [
      "--input", runDir,
      "--own-key", "eva-purple",
      "--deck", "carnerr-spear",
      "--out-dir", outDir,
      "--agent-root", agentRoot,
      "--policy-dir", join(agentRoot, "policies"),
      "--baseline-root", join(agentRoot, "baselines"),
      "--skip-ml",
      "--skip-profile-overlays",
      "--skip-variant-overlays"
    ]);

    const manifest = readJson(join(outDir, "knowledge-update.json"));
    assert.equal(manifest.decisions.samplingTelemetry.explorationCoverageGaps, 9);
    assert.equal(manifest.decisions.samplingTelemetry.explorationEvidenceFeatureKeys.length, 16);
    assert.equal(manifest.learningHealth.sampling.explorationAttempts, 12);
    assert.equal(manifest.learningHealth.sampling.explorationActionable, 10);
    assert.equal(manifest.learningHealth.sampling.explorationActionableYield, 10 / 12);
    assert.equal(manifest.learningHealth.sampling.adaptiveEarlyStops, 4);
    assert.equal(manifest.learningHealth.sampling.adaptiveAudits, 3);
    assert.equal(manifest.learningHealth.sampling.adaptiveAuditDisagreements, 0);
    assert.equal(manifest.learningHealth.sampling.counterfactualEstimatedPlayerTurnsSaved, 4);
    assert.ok(manifest.learningHealth.strengths.some((item) => item.includes("under-supported contextual features")));
    assert.ok(manifest.learningHealth.strengths.some((item) => item.includes("actionable causal labels")));
    assert.ok(manifest.learningHealth.strengths.some((item) => item.includes("adaptive-depth audit(s) agreed")));
    assert.match(readFileSync(join(outDir, "summary.md"), "utf8"), /Adaptive rollout depth: 4 early stop\(s\)/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adaptive-depth audit disagreement blocks unsafe learning promotion", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-knowledge-adaptive-audit-"));
  try {
    const agentRoot = join(root, "pilot-agent");
    const runDir = join(root, "run");
    const outDir = join(root, "knowledge");
    mkdirSync(runDir, { recursive: true });
    const telemetry = Array.from({ length: 8 }, (_, index) => ({
      schema: LEARNING_GAME_TELEMETRY_SCHEMA,
      recordType: "learning-game",
      gameIndex: index + 1,
      seed: 91_000 + index,
      opponent: "regional-test-opponent",
      candidateId: `candidate-${index}`,
      player: "P1",
      outcome: "win",
      complete: true,
      decisionOpportunities: 20,
      explorationDecisions: 1,
      explorationProbeDecisions: 1,
      explorationActionDecisions: 0,
      explorationEvidenceAttemptsAdded: 1,
      explorationEvidenceActionableAdded: 1,
      explorationEvidenceFeatureKeys: [`context.play.card-${index}`],
      counterfactualEnabled: true,
      counterfactualsEvaluated: 1,
      actionableCounterfactuals: 1,
      counterfactualTies: 0,
      unsynchronizedCounterfactuals: 0,
      counterfactualAdaptiveDecisions: 1,
      counterfactualAdaptiveEarlyStops: 0,
      counterfactualAdaptiveAuditEligible: 1,
      counterfactualAdaptiveAudits: 1,
      counterfactualAdaptiveAuditAgreements: index < 6 ? 1 : 0,
      counterfactualAdaptiveAuditDisagreements: index >= 6 ? 1 : 0,
      counterfactualRequestedPlayerTurns: 3,
      counterfactualEvaluatedPlayerTurns: 3,
      counterfactualEstimatedPlayerTurnsSaved: 0,
      counterfactualLowInformationSkips: 0
    }));
    const decisions = Array.from({ length: 8 }, (_, index) => decisionRows(`adaptive-audit-${index}`, {
      gameIndex: index + 1,
      seed: 91_000 + index,
      candidateId: `candidate-${index}`,
      outcome: "win",
      reward: 1,
      shapedReward: 1,
      learningEligible: true,
      learningSignalVersion: 2,
      candidateCount: 2,
      creditWeight: 1,
      counterfactualPreference: "chosen",
      counterfactualAdvantage: 0.5,
      counterfactualConfidence: 0.3,
      counterfactualAlternativeIndex: 1,
      counterfactualAlternativeAction: { type: "advancePhase" }
    })).flat();
    writeFileSync(
      join(runDir, "decision-log.jsonl"),
      `${[...telemetry, ...decisions].map((row) => JSON.stringify(row)).join("\n")}\n`
    );

    runTool("tools/update-pilot-knowledge.mjs", [
      "--input", runDir,
      "--own-key", "eva-purple",
      "--deck", "carnerr-spear",
      "--out-dir", outDir,
      "--agent-root", agentRoot,
      "--policy-dir", join(agentRoot, "policies"),
      "--baseline-root", join(agentRoot, "baselines"),
      "--skip-ml",
      "--skip-profile-overlays",
      "--skip-variant-overlays"
    ]);

    const manifest = readJson(join(outDir, "knowledge-update.json"));
    assert.equal(manifest.learningHealth.status, "blocked");
    assert.equal(manifest.learningInputs.preflight.blocked, true);
    assert.ok(manifest.learningHealth.blockers.some((item) => item.includes("adaptive-depth audits reversed")));
    assert.equal(manifest.commandResults.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("substantial action evidence without counterfactuals is blocked before artifact training", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-knowledge-counterfactual-block-"));
  try {
    const agentRoot = join(root, "pilot-agent");
    const baselineRoot = join(agentRoot, "baselines");
    const runDir = join(root, "run");
    const outDir = join(root, "knowledge");
    mkdirSync(runDir, { recursive: true });
    const rows = Array.from({ length: 160 }, (_, index) => decisionRows(`loss-${index}`, {
      gameIndex: index + 1,
      seed: 50_000 + index,
      candidateId: `candidate-${index}`,
      outcome: "loss",
      reward: -1,
      shapedReward: -1,
      learningEligible: true,
      learningSignalVersion: 2,
      candidateCount: 2,
      creditWeight: 1
    })).flat();
    writeFileSync(join(runDir, "decision-log.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

    runTool("tools/update-pilot-knowledge.mjs", [
      "--input", runDir,
      "--own-key", "eva-purple",
      "--deck", "carnerr-spear",
      "--out-dir", outDir,
      "--agent-root", agentRoot,
      "--policy-dir", join(agentRoot, "policies"),
      "--baseline-root", baselineRoot,
      "--skip-profile-overlays",
      "--skip-variant-overlays"
    ]);

    const manifest = readJson(join(outDir, "knowledge-update.json"));
    assert.equal(manifest.learningHealth.status, "blocked");
    assert.equal(manifest.learningInputs.preflight.blocked, true);
    assert.ok(manifest.learningHealth.blockers.some((item) => item.includes("No counterfactual decision evidence")));
    assert.equal(manifest.commandResults.length, 0);
    assert.equal(existsSync(actionModelPathForKey("eva-purple", { agentRoot, baselineRoot })), false);
    assert.equal(provisionalActionLearningEligible({
      knowledgeMode: "action",
      learningHealth: manifest.learningHealth,
      model: manifest.mlModel
    }), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto-refiner summary preserves learning-health warnings", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-auto-summary-health-"));
  try {
    const statePath = join(root, "auto-refiner-state.json");
    const outDir = join(root, "summary");
    writeJsonAtomicSync(statePath, {
      schema: "union-arena-local-engine/pilot-auto-refiner@1",
      session: "health-test",
      startedAt: "2026-07-09T00:00:00.000Z",
      completedAt: "2026-07-09T00:10:00.000Z",
      config: {},
      jobs: [{
        job: 1,
        stage: "light",
        deckName: "Carnerr Spear",
        taskType: "matchup-sweep",
        status: 0,
        learningProgress: {
          updates: 2,
          modelExamples: 120,
          modelPairwiseExamples: 31,
          modelFeatures: 8,
          overlays: 1,
          overlayCreated: 0,
          overlayUpdated: 1,
          overlayRemoved: 0,
          overlayUnchanged: 0,
          chosenRows: 200,
          counterfactualRows: 44,
          health: {
            healthy: 0,
            watch: 1,
            blocked: 1,
            unknown: 0,
            rows: [
              { status: "blocked", deckName: "Carnerr Spear", blockers: ["Incomplete chosen decisions are too high at 35.0%."] },
              {
                status: "watch",
                deckName: "Carnerr Spear",
                warnings: ["Counterfactual decision coverage is thin at 1.1%; pairwise learning may converge slowly."],
                chosenRows: 200,
                counterfactualRows: 2,
                counterfactualRate: 0.011
              }
            ]
          }
        }
      }, {
        job: 2,
        stage: "light",
        deckName: "Blocked Profile",
        taskType: "readiness-skip",
        status: 0,
        attempts: [{ skipped: true, reason: "profile ML remains unready" }]
      }],
      stopReason: { type: "max-jobs", reason: "Reached max jobs (1)." }
    });

    runTool("tools/pilot-auto-refiner-summary.mjs", [
      "--state", statePath,
      "--out-dir", outDir,
      "--reason", "test"
    ]);

    const summary = readJson(join(outDir, "auto-refiner-summary.json"));
    const markdown = readFileSync(join(outDir, "auto-refiner-summary.md"), "utf8");
    assert.equal(summary.learning.modelPairwiseExamples, 31);
    assert.equal(summary.learning.counterfactualRows, 44);
    assert.equal(summary.learning.health.blocked, 1);
    assert.equal(summary.learning.health.watch, 1);
    assert.equal(summary.learning.evidenceQuality.thin, 1);
    assert.equal(summary.learning.evidenceQuality.needsRicherSampling, 1);
    assert.equal(summary.totals.jobs, 1);
    assert.equal(summary.totals.successfulJobs, 1);
    assert.equal(summary.totals.schedulerSteps, 2);
    assert.equal(summary.totals.schedulerSkips, 1);
    assert.match(markdown, /31 pairwise examples/u);
    assert.match(markdown, /counterfactual decisions: 44/u);
    assert.match(markdown, /Learning health: 0 healthy, 1 watch, 1 blocked, 0 unknown/u);
    assert.match(markdown, /Evidence quality: .*1 thin/u);
    assert.match(markdown, /Scheduler steps: 2 \(1 readiness skips\)/u);
    assert.match(markdown, /Average win rate: -/u);
    assert.match(markdown, /Incomplete chosen decisions/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto-refiner summary does not invent improvement from missing prior evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "ua-auto-summary-null-prior-"));
  try {
    const statePath = join(root, "auto-refiner-state.json");
    const sweepRoot = join(root, "sweep");
    const taskRoot = join(root, "task");
    const runDir = join(root, "run");
    const outDir = join(root, "summary");
    writeJsonAtomicSync(join(sweepRoot, "matchup-sweep-state.json"), {
      results: [{
        deckId: "carnerr-a",
        deckName: "Carnerr A",
        ownKey: "eva-purple",
        opponentKey: "tsk-blue",
        opponentLabel: "TSK Blue",
        currentGames: 0,
        currentWinRate: null,
        currentAvgLifeDiff: null,
        command: `node tools/pilot-loop-overseer.mjs --out-root "${taskRoot}"`
      }]
    });
    writeJsonAtomicSync(join(taskRoot, "loop-state.json"), { cycles: [{ cycle: 1, runDir }] });
    writeJsonAtomicSync(join(runDir, "report.json"), {
      result: {
        total: 10,
        wins: 5,
        losses: 5,
        incomplete: 0,
        winRate: 0.5,
        avgLifeDiff: 0.2,
        avgTurnCycles: 6
      }
    });
    writeJsonAtomicSync(statePath, {
      session: "null-prior",
      jobs: [{
        job: 1,
        stage: "light",
        deckId: "carnerr-a",
        deckName: "Carnerr A",
        ownKey: "eva-purple",
        taskType: "matchup-sweep",
        status: 0,
        outRoot: sweepRoot
      }]
    });

    runTool("tools/pilot-auto-refiner-summary.mjs", ["--state", statePath, "--out-dir", outDir]);
    const summary = readJson(join(outDir, "auto-refiner-summary.json"));
    assert.equal(summary.totals.averageWinRate, 0.5);
    assert.equal(summary.matchups[0].avgWinRateDelta, null);
    assert.deepEqual(summary.biggestWinRateIncreases, []);
    assert.deepEqual(summary.biggestWinRateDecreases, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function gameRow({ index, seed, winner, p1, p2 }) {
  return { index, seed, opponent: "opponent", firstPlayer: index % 2 ? "P1" : "P2", winner, p1LifeRemaining: p1, p2LifeRemaining: p2 };
}

function summary({ winRate, score, life }) {
  return { winRate, score, avgLifeDiff: life, avgTurnCycles: 6, incompleteRate: 0, incomplete: 0 };
}

function writeDecisionFile(path, decisionKey, reward, {
  counterfactualPreference = null,
  alternativeGap = 80,
  chosenCardId = "card-a"
} = {}) {
  const common = {
    schema: "union-arena-local-engine/pilot-decision@1",
    decisionKey,
    gameIndex: 1,
    seed: 1,
    opponent: "opponent",
    candidateId: "candidate",
    step: 1,
    player: "P1",
    phase: "main",
    matchupProfileKey: "test-opponent",
    matchupVariantKey: "test-opponent",
    matchupVariantStatus: "profile",
    outcome: reward > 0 ? "win" : "loss",
    reward,
    shapedReward: reward,
    finalLifeDiffForPlayer: reward,
    finalTurnCycles: 6,
    learningSignalVersion: 2,
    learningEligible: true,
    candidateCount: 2,
    creditWeight: 1
  };
  if (counterfactualPreference) {
    common.counterfactualPreference = counterfactualPreference;
    common.counterfactualEvidenceKind = "horizon";
    common.counterfactualStateEvaluationVersion = COUNTERFACTUAL_STATE_EVALUATION_VERSION;
    common.counterfactualAlternativeIndex = 1;
    common.counterfactualAlternativeAction = { type: "advancePhase" };
  }
  const rows = [
    { ...common, actionIndex: 0, chosen: true, policyRank: 1, heuristicScore: 100, scoreDeltaFromChosen: 0, action: { type: "playCard", cardId: chosenCardId }, features: { baseScore: 1, playCard: 1, preserveEnergy: 1 } },
    { ...common, actionIndex: 1, chosen: false, policyRank: 2, heuristicScore: 100 - alternativeGap, scoreDeltaFromChosen: -alternativeGap, action: { type: "advancePhase" }, features: { baseScore: 1, advancePhase: 1 } }
  ];
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function decisionRows(decisionKey, overrides = {}) {
  const common = {
    schema: "union-arena-local-engine/pilot-decision@1",
    decisionKey,
    gameIndex: 1,
    seed: 1,
    opponent: "opponent",
    candidateId: "candidate",
    step: 1,
    player: "P1",
    phase: "main",
    matchupProfileKey: "test-opponent",
    matchupVariantKey: "test-opponent",
    matchupVariantStatus: "profile",
    finalLifeDiffForPlayer: 1,
    finalTurnCycles: 6,
    ...overrides
  };
  if (common.counterfactualPreference && common.counterfactualStateEvaluationVersion === undefined) {
    common.counterfactualEvidenceKind ??= "horizon";
    common.counterfactualStateEvaluationVersion = COUNTERFACTUAL_STATE_EVALUATION_VERSION;
  }
  return [
    { ...common, actionIndex: 0, chosen: true, policyRank: 1, heuristicScore: 100, scoreDeltaFromChosen: 0, action: { type: "playCard", cardId: "card-a" }, features: { playCard: 1 } },
    { ...common, actionIndex: 1, chosen: false, policyRank: 2, heuristicScore: 20, scoreDeltaFromChosen: -80, action: { type: "advancePhase" }, features: { advancePhase: 1 } }
  ];
}

function adaptiveAuditTrainingRows(keyPrefix, seedBase, count = 4) {
  const telemetry = Array.from({ length: count }, (_, index) => ({
    schema: LEARNING_GAME_TELEMETRY_SCHEMA,
    recordType: "learning-game",
    gameIndex: index + 1,
    seed: seedBase + index,
    opponent: "regional-test-opponent",
    candidateId: `${keyPrefix}-candidate-${index}`,
    player: "P1",
    outcome: "win",
    complete: true,
    decisionOpportunities: 20,
    explorationDecisions: 1,
    explorationCoverageGapDecisions: 1,
    explorationEvidenceAttemptsAdded: 1,
    explorationEvidenceActionableAdded: 1,
    explorationEvidenceFeatureKeys: [`context.play.${keyPrefix}-${index}`],
    counterfactualEnabled: true,
    counterfactualsEvaluated: 1,
    actionableCounterfactuals: 1,
    unsynchronizedCounterfactuals: 0,
    counterfactualAdaptiveDecisions: 1,
    counterfactualAdaptiveEarlyStops: 0,
    counterfactualAdaptiveAuditEligible: 1,
    counterfactualAdaptiveAudits: 1,
    counterfactualAdaptiveAuditAgreements: index < count - 1 ? 1 : 0,
    counterfactualAdaptiveAuditDisagreements: index === count - 1 ? 1 : 0,
    counterfactualRequestedPlayerTurns: 3,
    counterfactualEvaluatedPlayerTurns: 3,
    counterfactualEstimatedPlayerTurnsSaved: 0
  }));
  const decisions = Array.from({ length: count }, (_, index) => decisionRows(`${keyPrefix}-${index}`, {
    gameIndex: index + 1,
    seed: seedBase + index,
    opponent: "regional-test-opponent",
    candidateId: `${keyPrefix}-candidate-${index}`,
    matchupProfileKey: "test-opponent",
    outcome: "win",
    reward: 1,
    shapedReward: 1,
    learningSignalVersion: 2,
    learningEligible: true,
    candidateCount: 2,
    creditWeight: 1,
    counterfactualPreference: index % 2 === 0 ? "chosen" : "alternative",
    counterfactualAdvantage: 0.5,
    counterfactualConfidence: 0.5,
    counterfactualAlternativeIndex: 1,
    counterfactualAlternativeAction: { type: "advancePhase" }
  })).flat();
  return [...telemetry, ...decisions];
}

function balancedPairDecisionRows({ count, keyPrefix, seedBase }) {
  const rows = [];
  const families = [
    {
      phase: "main",
      opponent: "rnk-red",
      chosenAction: { type: "playCard", destination: "energyLine", cardId: "good-line" },
      alternativeAction: { type: "advancePhase" }
    },
    {
      phase: "attack",
      opponent: "tsk-blue",
      chosenAction: { type: "declareAttack" },
      alternativeAction: { type: "advancePhase" }
    },
    {
      phase: "block",
      opponent: "rnk-red",
      chosenAction: { type: "declareBlock" },
      alternativeAction: { type: "declineBlock" }
    }
  ];
  for (let index = 0; index < count; index += 1) {
    const preference = index % 3 === 0 ? "alternative" : "chosen";
    const family = families[index % families.length];
    const common = {
      schema: "union-arena-local-engine/pilot-decision@1",
      decisionKey: `${keyPrefix}-${index}`,
      gameIndex: index + 1,
      seed: seedBase + index,
      opponent: `regional-${family.opponent}`,
      candidateId: `policy-${index % 4}`,
      step: 2,
      player: "P1",
      phase: family.phase,
      creditPhase: family.phase,
      matchupProfileKey: family.opponent,
      outcome: "win",
      reward: 1,
      shapedReward: 1,
      learningSignalVersion: 2,
      learningEligible: true,
      candidateCount: 2,
      creditWeight: 1,
      counterfactualPreference: preference,
      counterfactualEvidenceKind: "horizon",
      counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION,
      counterfactualAdvantage: 1,
      counterfactualConfidence: 1,
      counterfactualAlternativeIndex: 1,
      counterfactualAlternativeAction: family.alternativeAction
    };
    const chosenBetter = preference === "chosen";
    rows.push({
      ...common,
      chosen: true,
      actionIndex: 0,
      action: family.chosenAction,
      features: chosenBetter ? { strategicGood: 1 } : { strategicBad: 1 }
    }, {
      ...common,
      chosen: false,
      actionIndex: 1,
      action: family.alternativeAction,
      features: chosenBetter ? { strategicBad: 1 } : { strategicGood: 1 }
    });
  }
  return rows;
}

function creditDecision(phase, actionType, candidateCount = 2) {
  return {
    player: "P1",
    step: phase === "setup" ? "setup-P1" : 1,
    state: { phase },
    chosenAction: { type: actionType },
    candidates: Array.from({ length: candidateCount }, (_, index) => ({ index }))
  };
}

function writeSavedDeck(path, deck) {
  writeFileSync(path, `${JSON.stringify(deck, null, 2)}\n`);
}

function runTool(tool, args) {
  const result = spawnSync(process.execPath, [tool, ...args], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(result.status, 0, `${tool} failed:\n${result.stdout}\n${result.stderr}`);
  return result;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function escapedRegExp(value) {
  return new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u");
}
