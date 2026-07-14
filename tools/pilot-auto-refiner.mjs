#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomicSync } from "../src/artifact-io.js";
import { shouldAdvanceAutoRefinerDeck } from "../src/auto-refiner-scheduling.js";
import {
  MIN_ML_RUNTIME_HELDOUT_GAMES,
  MIN_ML_RUNTIME_PAIRWISE_EXAMPLES,
  MIN_ML_RUNTIME_TRUST,
  mlActionModelReadiness
} from "../src/index.js";
import {
  actionModelCandidatePathsForKey,
  baselineOriginPathForKey,
  baselinePolicyPathForKey,
  matchupOverlayCandidateFilesForKey,
  matchupOverlayFilesForKey,
  policyKeySegment,
  resolveArchetypeProfile
} from "../src/policy-router.js";

const agentRoot = option("--agent-root") ?? "work/private/pilot-agent";
const libraryDir = option("--library") ?? "work/private/decks";
const policyDir = option("--policy-dir") ?? join(agentRoot, "policies");
const baselineRoot = option("--baseline-root") ?? join(agentRoot, "baselines");
const runsRoot = option("--runs-root") ?? join(agentRoot, "runs");
const catalogPath = option("--catalog") ?? "work/private/egman-unionarena-catalog.json";
const deckPrefix = option("--deck-prefix") ?? "carnerr-,engine-";
const deckPrefixes = splitList(deckPrefix);
const seed = Number(option("--seed") ?? 20001);
const seedStep = Number(option("--seed-step") ?? 1009);
const retrySeedStep = Number(option("--retry-seed-step") ?? 100003);
const session = option("--session") ?? `pilot-auto-refine-${seed}`;
const outRoot = option("--out-root") ?? join(agentRoot, "auto-refiner", session);
const maxJobs = Math.max(1, Number(option("--max-jobs") ?? option("--cycles") ?? 48));
const maxRetries = Math.max(0, Number(option("--max-retries") ?? 1));
const plateauPassesToEscalate = Math.max(1, Number(option("--plateau-passes") ?? 1));
const parallelRuns = option("--parallel-runs") ?? "14";
const parallelConcurrency = option("--parallel-concurrency") ?? parallelRuns;
const progressMinutes = option("--progress-minutes") ?? "2";
const explorationMode = option("--exploration-mode") ?? option("--action-exploration-mode") ?? "";
const explorationRate = option("--exploration-rate") ?? option("--action-exploration-rate") ?? "";
const explorationMaxPerGame = option("--exploration-max-per-game") ?? option("--action-exploration-max-per-game") ?? "";
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
const adaptiveLearningEvidence = !hasFlag("--no-adaptive-learning-evidence");
const adaptiveCounterfactualExplorationRate = option("--adaptive-counterfactual-exploration-rate")
  ?? option("--adaptive-counterfactual-rate")
  ?? "0.55";
const adaptiveCounterfactualMaxPerGame = option("--adaptive-counterfactual-max-per-game") ?? "1";
const adaptiveCounterfactualRolloutActions = option("--adaptive-counterfactual-rollout-actions") ?? "64";
const adaptiveCounterfactualRolloutPlayerTurns = option("--adaptive-counterfactual-rollout-player-turns") ?? "3";
const adaptiveExplorationRate = option("--adaptive-exploration-rate") ?? "0.08";
const adaptiveRaidNormalPlayExplorationRate = option("--adaptive-raid-normal-play-exploration-rate")
  ?? option("--adaptive-raid-exploration-rate")
  ?? "0.55";
const adaptiveRaidNormalPlayScoreWindow = option("--adaptive-raid-normal-play-score-window") ?? "1400";
const adaptiveRaidNormalPlayHeuristicWindow = option("--adaptive-raid-normal-play-heuristic-window") ?? "1600";
const adaptiveRaidNormalPlayMinHeuristicScore = option("--adaptive-raid-normal-play-min-heuristic-score") ?? "-260";
const defaultMatchupLimit = parseMatchupLimit(option("--matchup-limit") ?? "1");
const deckAdvanceMode = normalizeDeckAdvanceMode(option("--deck-advance-mode") ?? "complete");
const allowUnreadyActionModelMatchups = hasFlag("--allow-unready-action-model")
  || !hasFlag("--require-ready-action-model");
const baselineRefreshMode = normalizeBaselineRefreshMode(option("--baseline-refresh-mode") ?? "missing-and-round-robin");
const explicitBaselineRefreshBatchSize = option("--baseline-refresh-batch-size") ?? option("--baseline-batch-size");
const baselineRefreshBatchSize = Math.max(1, Number(explicitBaselineRefreshBatchSize ?? 2));
const missingBaselineBatchSize = Math.max(1, Number(
  option("--missing-baseline-batch-size") ?? explicitBaselineRefreshBatchSize ?? parallelRuns
));
const baselineSuiteConcurrency = Math.max(1, Number(option("--baseline-suite-concurrency") ?? option("--suite-concurrency") ?? 1));
const baselineSuiteRetryRounds = Math.max(1, Number(option("--baseline-suite-retry-rounds") ?? option("--baseline-retry-rounds") ?? 2));
const minActionModelExamples = Math.max(0, Number(option("--min-action-model-examples") ?? option("--action-model-min-examples") ?? 80));
const minActionModelTrust = Math.max(
  MIN_ML_RUNTIME_TRUST,
  clamp(Number(option("--min-action-model-trust") ?? option("--action-model-min-trust") ?? MIN_ML_RUNTIME_TRUST), 0, 1)
);
const minActionModelHeldoutGames = Math.max(
  MIN_ML_RUNTIME_HELDOUT_GAMES,
  Number(option("--min-action-model-heldout-games") ?? MIN_ML_RUNTIME_HELDOUT_GAMES)
);
const minActionModelPairwiseExamples = Math.max(
  MIN_ML_RUNTIME_PAIRWISE_EXAMPLES,
  Number(option("--min-action-model-pairwise-examples") ?? MIN_ML_RUNTIME_PAIRWISE_EXAMPLES)
);
const actionModelSuiteBatchSize = Math.max(1, Number(option("--action-model-suite-batch-size") ?? option("--profile-suite-batch-size") ?? missingBaselineBatchSize));
const actionModelSuiteConcurrency = Math.max(1, Number(option("--action-model-suite-concurrency") ?? option("--profile-suite-concurrency") ?? 1));
const actionModelSuiteRetryRounds = Math.max(1, Number(option("--action-model-suite-retry-rounds") ?? option("--profile-suite-retry-rounds") ?? 1));
const explicitPriorityShape = option("--priority-shape");
const priorityShape = normalizePriorityShape(explicitPriorityShape ?? "coverage");
const dryRun = hasFlag("--dry-run");
const failFast = hasFlag("--fail-fast");
const catalog = readJsonIfExists(catalogPath) ?? {};

if (hasFlag("--help")) {
  usage();
  process.exit(0);
}

mkdirSync(outRoot, { recursive: true });

const stages = configuredStages();
const decks = selectedDecks(savedPilotDecks());
if (decks.length === 0) throw new Error(`No pilot decks matched ${deckPrefix} in ${libraryDir}.`);

const state = {
  schema: "union-arena-local-engine/pilot-auto-refiner@1",
  startedAt: new Date().toISOString(),
  session,
  config: {
    agentRoot,
    libraryDir,
    policyDir,
    baselineRoot,
    runsRoot,
    deckPrefix,
    deckOrder: splitList(option("--deck-order") ?? ""),
    startDeck: option("--start-deck") ?? "carnerr-spear",
    seed,
    seedStep,
    maxJobs,
    maxRetries,
    plateauPassesToEscalate,
    parallelRuns,
    parallelConcurrency,
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
    adaptiveLearningEvidence,
    adaptiveCounterfactualExplorationRate,
    adaptiveCounterfactualMaxPerGame,
    adaptiveCounterfactualRolloutActions,
    adaptiveCounterfactualRolloutPlayerTurns,
    adaptiveRaidNormalPlayExplorationRate,
    adaptiveRaidNormalPlayScoreWindow,
    adaptiveRaidNormalPlayHeuristicWindow,
    adaptiveRaidNormalPlayMinHeuristicScore,
    matchupLimit: defaultMatchupLimit,
    deckAdvanceMode,
    allowUnreadyActionModelMatchups,
    baselineRefreshMode,
    baselineRefreshBatchSize,
    missingBaselineBatchSize,
    baselineSuiteConcurrency,
    baselineSuiteRetryRounds,
    minActionModelExamples,
    minActionModelTrust,
    minActionModelHeldoutGames,
    minActionModelPairwiseExamples,
    actionModelSuiteBatchSize,
    actionModelSuiteConcurrency,
    actionModelSuiteRetryRounds,
    priorityShape,
    dryRun,
    failFast,
    stages: stages.map(publicStage)
  },
  decks: decks.map((deck) => ({
    id: deck.id,
    name: deck.name,
    ownKey: deck.ownKey,
    baselineReady: deck.baselineReady,
    baselineStatus: deck.baselineStatus,
    actionModelReady: deck.actionModelReady,
    actionModelStatus: deck.actionModelStatus
  })),
  stageIndex: 0,
  nextDeckIndex: 0,
  pass: newPass(0),
  learningEvidenceBoost: null,
  jobs: [],
  stopReason: null
};

writeState(state);
console.log(`Auto refiner ${session}: ${decks.length} deck(s), ${stages.length} stage(s), max ${maxJobs} job(s).`);
console.log(`State: ${join(outRoot, "auto-refiner-state.json")}`);

let executedJobs = 0;
let schedulerStep = 0;
const maxSchedulerSteps = maxJobs + Math.max(
  100,
  decks.length * (stages.length + 2) * (plateauPassesToEscalate + 1) * 2
);
while (executedJobs < maxJobs && schedulerStep < maxSchedulerSteps) {
  schedulerStep += 1;
  const jobNumber = executedJobs + 1;
  const stage = stages[state.stageIndex];
  const deck = decks[state.nextDeckIndex % decks.length];
  const jobSeed = seed + (jobNumber - 1) * seedStep;
  const task = taskForState({ deck, stage, jobNumber, jobSeed });
  const before = profileSnapshotForTask(task);
  state.currentJob = {
    job: schedulerStep,
    trainingJob: task.skip ? null : jobNumber,
    stage: stage.name,
    deckId: task.deck?.id ?? task.deckId ?? "baseline-suite",
    deckName: task.deck?.name ?? task.deckName ?? "Baseline Suite",
    ownKey: task.deck?.ownKey ?? task.ownKey ?? null,
    taskType: task.type,
    evidenceMode: Boolean(task.evidenceMode),
    deckIds: task.deckIds ?? null,
    profileKeys: task.profileKeys ?? null,
    outRoot: task.outRoot ?? null,
    runDir: task.runDir ?? null,
    seed: jobSeed,
    status: "running",
    startedAt: new Date().toISOString(),
    command: taskCommandText(task)
  };
  writeState(state);
  writeFileSync(join(outRoot, "latest-command.ps1"), `${taskCommandText(task)}\n`);

  console.log(`\n=== Auto refiner step ${schedulerStep}: ${stage.name} ${state.currentJob.deckName} (${task.type})${task.skip ? "" : ` | training job ${jobNumber}/${maxJobs}`} ===`);
  console.log(taskCommandText(task));
  const result = runWithRetries(task, { jobNumber, jobSeed });
  const after = profileSnapshotForTask(task);
  const profileChange = profileChangeSummary(before, after);
  const artifactChanged = profileChange.changed;
  const detail = taskDetail(task);
  const evidenceQuality = learningEvidenceQuality(detail.learningProgress ?? {});
  const artifactProgressAccepted = artifactProgressAcceptedForJob({
    artifactChanged,
    learningProgress: detail.learningProgress,
    evidenceQuality
  });
  const jobRow = {
    job: schedulerStep,
    trainingJob: task.skip ? null : jobNumber,
    stage: stage.name,
    deckId: state.currentJob.deckId,
    deckName: state.currentJob.deckName,
    ownKey: state.currentJob.ownKey,
    taskType: task.type,
    evidenceMode: Boolean(task.evidenceMode),
    deckIds: task.deckIds ?? null,
    seed: jobSeed,
    outRoot: task.outRoot,
    runDir: task.runDir ?? null,
    command: taskCommandText(task),
    profileKeys: task.profileKeys ?? null,
    baselineStatuses: task.baselineStatuses ?? null,
    baselineSuiteMode: task.baselineSuiteMode ?? null,
    status: result.status,
    signal: result.signal ?? null,
    attempts: result.attempts,
    artifactChanged,
    artifactProgressAccepted,
    learningEvidenceQuality: evidenceQuality,
    profileChange,
    baselinePromotions: detail.baselinePromotions ?? null,
    learningProgress: detail.learningProgress ?? null,
    matchupValidation: detail.matchupValidation ?? null,
    matchupValidationRollback: detail.matchupValidationRollback ?? null,
    selectedTasks: detail.selectedTasks ?? null,
    actionModelStatuses: task.actionModelStatuses ?? null,
    stopReason: detail.stopReason ?? null,
    startedAt: state.currentJob.startedAt,
    endedAt: new Date().toISOString()
  };
  state.jobs.push(jobRow);
  state.currentJob = null;
  if (!task.skip) executedJobs += 1;
  state.executedJobs = executedJobs;
  state.schedulerSteps = schedulerStep;

  if (result.status !== 0) {
    state.failedJobs ??= [];
    state.failedJobs.push(jobRow);
    console.log(`${task.type} failed for ${deck.id} after ${result.attempts.length} attempt(s); recording it and continuing.`);
    if (failFast) {
      state.stopReason = {
        type: "job-failed",
        job: schedulerStep,
        trainingJob: jobNumber,
        reason: `${task.type} failed for ${deck.id} after ${result.attempts.length} attempt(s). --fail-fast was supplied.`
      };
      state.completedAt = new Date().toISOString();
      writeState(state);
      throw new Error(state.stopReason.reason);
    }
  }

  if (result.status === 0 && artifactProgressAccepted) {
    state.pass.progress = true;
    for (const key of task.profileKeys ?? [deck.ownKey]) {
      if (key && !state.pass.changedProfiles.includes(key)) state.pass.changedProfiles.push(key);
    }
  } else if (result.status === 0 && artifactChanged && !artifactProgressAccepted) {
    console.log(`Profile artifacts changed, but learning evidence was ${evidenceQuality.status}; not counting it as clean pass progress yet.`);
  }
  if (!task.skip) updateLearningEvidenceBoost(evidenceQuality, jobRow);
  if (task.skip) state.pass.schedulerSkips += 1;
  else state.pass.jobs += 1;
  if (task.type === "baseline-suite") {
    if (task.baselineSuiteMode === "missing") {
      state.pass.baselineAttemptedProfileKeys ??= [];
      state.pass.baselineRoundAttemptedProfileKeys ??= [];
      for (const key of task.profileKeys ?? []) {
        if (key && !state.pass.baselineAttemptedProfileKeys.includes(key)) state.pass.baselineAttemptedProfileKeys.push(key);
        if (key && !state.pass.baselineRoundAttemptedProfileKeys.includes(key)) state.pass.baselineRoundAttemptedProfileKeys.push(key);
      }
      const unresolvedKeys = readinessScopeDecks(decks
        .filter((candidate) => !baselineReady(candidate.ownKey)))
        .map((candidate) => candidate.ownKey);
      const attempted = new Set(state.pass.baselineRoundAttemptedProfileKeys);
      const roundComplete = unresolvedKeys.length > 0 && unresolvedKeys.every((key) => attempted.has(key));
      if (roundComplete) {
        state.pass.baselineSuiteRounds = Number(state.pass.baselineSuiteRounds ?? 0) + 1;
        if (state.pass.baselineSuiteRounds < baselineSuiteRetryRounds) {
          state.pass.baselineRoundAttemptedProfileKeys = [];
          console.log(`Baseline suite round ${state.pass.baselineSuiteRounds}/${baselineSuiteRetryRounds} finished; retrying unresolved baselines in parallel.`);
        } else {
          console.log(`Baseline suite retry limit reached for this pass (${state.pass.baselineSuiteRounds}/${baselineSuiteRetryRounds}).`);
        }
      }
    } else {
      state.pass.baselineRefreshDone = true;
    }
    state.pass.baselineRefreshJobs = Number(state.pass.baselineRefreshJobs ?? 0) + 1;
    if (Number.isFinite(Number(task.refreshCursorNext))) state.baselineRefreshCursor = task.refreshCursorNext;
  } else if (task.type === "action-model-suite") {
    state.pass.actionModelAttemptedProfileKeys ??= [];
    state.pass.actionModelRoundAttemptedProfileKeys ??= [];
    for (const key of task.profileKeys ?? []) {
      if (key && !state.pass.actionModelAttemptedProfileKeys.includes(key)) state.pass.actionModelAttemptedProfileKeys.push(key);
      if (key && !state.pass.actionModelRoundAttemptedProfileKeys.includes(key)) state.pass.actionModelRoundAttemptedProfileKeys.push(key);
    }
    const unresolvedKeys = readinessScopeDecks(uniqueDecksByOwnKey(decks
      .filter((candidate) => baselineReady(candidate.ownKey) && !actionModelReady(candidate.ownKey))))
      .map((candidate) => candidate.ownKey);
    const attempted = new Set(state.pass.actionModelRoundAttemptedProfileKeys);
    const roundComplete = unresolvedKeys.length > 0 && unresolvedKeys.every((key) => attempted.has(key));
    if (roundComplete) {
      state.pass.actionModelSuiteRounds = Number(state.pass.actionModelSuiteRounds ?? 0) + 1;
      if (state.pass.actionModelSuiteRounds < actionModelSuiteRetryRounds) {
        state.pass.actionModelRoundAttemptedProfileKeys = [];
        console.log(`Profile ML suite round ${state.pass.actionModelSuiteRounds}/${actionModelSuiteRetryRounds} finished; retrying unresolved profile models in parallel.`);
      } else {
        console.log(`Profile ML suite retry limit reached for this pass (${state.pass.actionModelSuiteRounds}/${actionModelSuiteRetryRounds}).`);
      }
    }
    state.pass.actionModelSuiteJobs = Number(state.pass.actionModelSuiteJobs ?? 0) + 1;
  } else if (task.type === "baseline") {
    const attemptKey = readinessAttemptKey(deck.ownKey, task.readinessTarget);
    if (!state.pass.readinessAttemptKeys.includes(attemptKey)) state.pass.readinessAttemptKeys.push(attemptKey);
    state.pass.decksVisited.push(deck.id);
  } else {
    state.pass.decksVisited.push(deck.id);
  }
  if (result.status !== 0) state.pass.failedJobs = Number(state.pass.failedJobs ?? 0) + 1;
  const advanceDeck = shouldAdvanceAutoRefinerDeck({
    deckAdvanceMode,
    taskType: task.type,
    resultStatus: result.status,
    selectedTasks: detail?.selectedTasks,
    matchupLimit: task.stage?.matchupLimit
  });
  if (advanceDeck) {
    if (!state.pass.completedDecks.includes(deck.id)) state.pass.completedDecks.push(deck.id);
    state.nextDeckIndex += 1;
  } else if (task.type === "baseline-suite" || task.type === "action-model-suite") {
    console.log(`${task.type === "baseline-suite" ? "Baseline" : "Profile ML"} suite finished; checking remaining baseline and matchup work.`);
  } else {
    console.log(`Continuing ${deck.name}; current ${stage.name} stage still has matchup work before moving to the next deck.`);
  }

  if (state.pass.completedDecks.length >= decks.length) {
    const completedPass = { ...state.pass, completedAt: new Date().toISOString() };
    state.completedPasses ??= [];
    state.completedPasses.push(completedPass);
    if (completedPass.progress) {
      state.pass = newPass(state.stageIndex);
      state.plateauPasses = 0;
    } else {
      state.plateauPasses = Number(state.plateauPasses ?? 0) + 1;
      if (state.plateauPasses >= plateauPassesToEscalate) {
        if (state.stageIndex < stages.length - 1) {
          state.stageIndex += 1;
          state.plateauPasses = 0;
          state.pass = newPass(state.stageIndex);
          console.log(`Stage plateaued; escalating to ${stages[state.stageIndex].name}.`);
        } else {
          state.stopReason = {
            type: "plateau",
            job: schedulerStep,
            reason: `All decks completed a full pass without profile artifact changes at the ${stage.name} stage.`
          };
          state.completedAt = new Date().toISOString();
          writeState(state);
          console.log(`Stopping auto refiner: ${state.stopReason.reason}`);
          break;
        }
      } else {
        state.pass = newPass(state.stageIndex);
      }
    }
  }

  writeState(state);
}

if (!state.stopReason && schedulerStep >= maxSchedulerSteps && executedJobs < maxJobs) {
  state.stopReason = {
    type: "scheduler-guard",
    reason: `Stopped after ${schedulerStep} scheduler steps to prevent a no-work loop; ${executedJobs}/${maxJobs} training jobs ran.`
  };
}
if (!state.stopReason) {
  state.stopReason = {
    type: "max-jobs",
    reason: `Reached max training jobs (${maxJobs}); scheduler-only skips did not count against this limit.`
  };
}
state.currentJob = null;
state.completedAt = new Date().toISOString();
writeState(state);
console.log(`\nAuto refiner finished: ${state.stopReason.reason}`);

function taskForState({ deck, stage, jobNumber, jobSeed }) {
  const baselineSuite = baselineSuiteTaskForState({ stage, jobNumber, jobSeed });
  if (baselineSuite) return baselineSuite;
  return taskForDeck({ deck, stage, jobNumber, jobSeed });
}

function baselineSuiteTaskForState({ stage, jobNumber, jobSeed }) {
  if (baselineRefreshMode === "never") return null;

  const missingDecks = readinessScopeDecks(decks.filter((deck) => !baselineReady(deck.ownKey)));
  if (missingDecks.length > 0 && baselineRefreshModeAllows("missing")) {
    const attempted = new Set(state.pass.baselineRoundAttemptedProfileKeys ?? []);
    const batch = missingDecks
      .filter((deck) => !attempted.has(deck.ownKey))
      .slice(0, missingBaselineBatchSize);
    if (batch.length > 0) {
      return baselineSuiteTask({
        stage,
        jobNumber,
        jobSeed,
        mode: "missing",
        deckIds: batch.map((deck) => deck.id),
        seedDeckId: batch[0]?.id ?? decks[0]?.id,
        profileKeys: [...new Set(batch.map((deck) => deck.ownKey))],
        baselineStatuses: Object.fromEntries(batch.map((deck) => [deck.ownKey, deck.baselineStatus ?? "missing"]))
      });
    }
  }

  const missingModelDecks = readinessScopeDecks(uniqueDecksByOwnKey(decks
    .map((deck) => ({ ...deck, baseline: baselineStatus(deck.ownKey), model: actionModelStatus(deck.ownKey) }))
    .filter((deck) => deck.baseline.ready && !deck.model.ready)));
  if (missingModelDecks.length > 0 && baselineRefreshModeAllows("missing")) {
    const attempted = new Set(state.pass.actionModelRoundAttemptedProfileKeys ?? []);
    const batch = missingModelDecks
      .filter((deck) => !attempted.has(deck.ownKey))
      .slice(0, actionModelSuiteBatchSize);
    if (batch.length > 0) {
      return actionModelSuiteTask({
        stage,
        jobNumber,
        jobSeed,
        deckIds: batch.map((deck) => deck.id),
        profileKeys: batch.map((deck) => deck.ownKey),
        actionModelStatuses: Object.fromEntries(batch.map((deck) => [deck.ownKey, deck.model.status ?? "missing"]))
      });
    }
  }

  if (missingDecks.length > 0) return null;
  if (state.pass.baselineRefreshDone) return null;
  if (!baselineRefreshModeAllows("round-robin")) return null;
  const batch = baselineRefreshBatch();
  if (batch.length === 0) return null;
  return baselineSuiteTask({
    stage,
    jobNumber,
    jobSeed,
    mode: "refresh",
    deckIds: batch.map((deck) => deck.id),
    seedDeckId: batch[0]?.id ?? decks[0]?.id,
    profileKeys: [...new Set(batch.map((deck) => deck.ownKey))],
    refreshCursorNext: (Number(state.baselineRefreshCursor ?? 0) + batch.length) % decks.length
  });
}

function actionModelSuiteTask({ stage, jobNumber, jobSeed, deckIds, profileKeys, actionModelStatuses }) {
  const label = `job-${String(jobNumber).padStart(3, "0")}-action-model-suite`;
  const taskOutRoot = join(outRoot, stage.name, label);
  const args = [
    "tools/pilot-baseline-suite.mjs",
    "--deck-prefix", deckPrefix,
    "--decks", deckIds.join(","),
    "--seed", String(jobSeed),
    "--session", `${session}-${label}`,
    "--out-root", taskOutRoot,
    "--agent-root", agentRoot,
    "--policy-dir", policyDir,
    "--baseline-root", baselineRoot,
    "--runs-root", runsRoot,
    "--suite-concurrency", String(Math.min(actionModelSuiteConcurrency, deckIds.length)),
    "--opponent-count", String(stage.baselineOpponentCount),
    "--parallel-runs", parallelRuns,
    "--parallel-concurrency", parallelConcurrency,
    "--parallel-opponent-count-per-run", String(stage.baselineOpponentCountPerRun),
    "--parallel-final-games", String(stage.baselineParallelFinalGames),
    "--parallel-final-top-percent", String(stage.baselineFinalTopPercent),
    "--parallel-final-candidates", stage.baselineFinalCandidates,
    "--progress-minutes", progressMinutes
  ];
  pushValueIfChanged(args, "--games", String(stage.baselineGames), "8");
  pushValueIfChanged(args, "--generations", String(stage.baselineGenerations), "2");
  pushValueIfChanged(args, "--population", String(stage.baselinePopulation), "4");
  pushValueIfChanged(args, "--final-games", String(stage.baselineFinalGames), "8");
  appendExplorationArgs(args);
  if (dryRun) args.push("--dry-run");
  return {
    type: "action-model-suite",
    deckId: "action-model-suite",
    deckName: "Profile ML Suite",
    ownKey: null,
    stage,
    outRoot: taskOutRoot,
    runDir: taskOutRoot,
    args,
    deckIds,
    profileKeys,
    actionModelStatuses
  };
}

function baselineSuiteTask({ stage, jobNumber, jobSeed, mode, deckIds, profileKeys, baselineStatuses = null, refreshCursorNext = null }) {
  const label = `job-${String(jobNumber).padStart(3, "0")}-baseline-suite-${mode}`;
  const taskOutRoot = join(outRoot, stage.name, label);
  const args = [
    "tools/pilot-baseline-suite.mjs",
    "--deck-prefix", deckPrefix,
    "--decks", deckIds.join(","),
    "--seed", String(jobSeed),
    "--session", `${session}-${label}`,
    "--out-root", taskOutRoot,
    "--agent-root", agentRoot,
    "--policy-dir", policyDir,
    "--baseline-root", baselineRoot,
    "--runs-root", runsRoot,
    "--suite-concurrency", String(Math.min(baselineSuiteConcurrency, deckIds.length)),
    "--opponent-count", String(stage.baselineOpponentCount),
    "--parallel-runs", parallelRuns,
    "--parallel-concurrency", parallelConcurrency,
    "--parallel-opponent-count-per-run", String(stage.baselineOpponentCountPerRun),
    "--parallel-final-games", String(stage.baselineParallelFinalGames),
    "--parallel-final-top-percent", String(stage.baselineFinalTopPercent),
    "--parallel-final-candidates", stage.baselineFinalCandidates,
    "--progress-minutes", progressMinutes
  ];
  pushValueIfChanged(args, "--games", String(stage.baselineGames), "8");
  pushValueIfChanged(args, "--generations", String(stage.baselineGenerations), "2");
  pushValueIfChanged(args, "--population", String(stage.baselinePopulation), "4");
  pushValueIfChanged(args, "--final-games", String(stage.baselineFinalGames), "8");
  appendExplorationArgs(args);
  if (dryRun) args.push("--dry-run");
  return {
    type: "baseline-suite",
    deckId: `baseline-suite-${mode}`,
    deckName: mode === "missing" ? "Missing Baseline Suite" : "Baseline Refresh Suite",
    ownKey: null,
    stage,
    outRoot: taskOutRoot,
    runDir: taskOutRoot,
    args,
    deckIds,
    profileKeys,
    baselineStatuses,
    baselineSuiteMode: mode,
    refreshCursorNext
  };
}

function taskForDeck({ deck, stage, jobNumber, jobSeed }) {
  const current = savedDeckById(deck.id) ?? deck;
  const baseline = baselineStatus(deck.ownKey);
  const model = actionModelStatus(deck.ownKey);
  const refreshed = {
    ...deck,
    baselineReady: baseline.ready,
    baselineStatus: baseline.status,
    baselineOrigin: baseline.origin,
    actionModelReady: model.ready,
    actionModelStatus: model.status
  };
  if (!refreshed.baselineReady) {
    const attempted = state.pass.baselineAttemptedProfileKeys.includes(deck.ownKey)
      || state.pass.readinessAttemptKeys.includes(readinessAttemptKey(deck.ownKey, "baseline"));
    return attempted
      ? readinessSkipTask({ deck: refreshed, stage, target: "baseline", status: baseline })
      : baselineTask({ deck: refreshed, stage, jobNumber, jobSeed, readinessTarget: "baseline" });
  }
  if (!refreshed.actionModelReady) {
    const attempted = state.pass.actionModelAttemptedProfileKeys.includes(deck.ownKey)
      || state.pass.readinessAttemptKeys.includes(readinessAttemptKey(deck.ownKey, "action-model"));
    if (!attempted) {
      return baselineTask({ deck: refreshed, stage, jobNumber, jobSeed, readinessTarget: "action-model" });
    }
    if (!allowUnreadyActionModelMatchups) {
      return readinessSkipTask({ deck: refreshed, stage, target: "action-model", status: model });
    }
    return matchupTask({
      deck: current,
      stage,
      jobNumber,
      jobSeed,
      allowUnreadyActionModel: true,
      actionModelStatus: model
    });
  }
  return matchupTask({ deck: current, stage, jobNumber, jobSeed });
}

function baselineTask({ deck, stage, jobNumber, jobSeed, readinessTarget = "baseline" }) {
  const label = `job-${String(jobNumber).padStart(3, "0")}-${policyKeySegment(deck.id)}-baseline`;
  const childSession = `${session}-${label}`;
  const taskOutRoot = join(outRoot, stage.name, label);
  const runDir = join(runsRoot, `${childSession}-cycle-01`);
  const args = [
    "tools/pilot-loop-overseer.mjs",
    "--training-mode", "deck",
    "--agent-preset", "baseline-suite",
    "--deck", deck.id,
    "--own-key", deck.ownKey,
    "--seed", String(jobSeed),
    "--session", childSession,
    "--cycles", "1",
    "--out-root", taskOutRoot,
    "--opponent-count", String(stage.baselineOpponentCount),
    "--knowledge-mode", "action",
  ];
  appendSharedOverseerArgs(args);
  pushValueIfChanged(args, "--parallel-runs", parallelRuns, "14");
  pushValueIfChanged(args, "--parallel-concurrency", parallelConcurrency, parallelRuns);
  pushValueIfChanged(args, "--games", String(stage.baselineGames), "12");
  pushValueIfChanged(args, "--generations", String(stage.baselineGenerations), "3");
  pushValueIfChanged(args, "--population", String(stage.baselinePopulation), "6");
  pushValueIfChanged(args, "--final-games", String(stage.baselineFinalGames), "20");
  pushValueIfChanged(args, "--parallel-opponent-count-per-run", String(stage.baselineOpponentCountPerRun), "2");
  pushValueIfChanged(args, "--parallel-final-games", String(stage.baselineParallelFinalGames), "0");
  pushValueIfChanged(args, "--parallel-final-top-percent", String(stage.baselineFinalTopPercent), "35");
  pushValueIfChanged(args, "--parallel-final-candidates", stage.baselineFinalCandidates, "best-baseline");
  pushValueIfChanged(args, "--progress-minutes", progressMinutes, "2");
  appendExplorationArgs(args);
  if (dryRun) args.push("--dry-run");
  return { type: "baseline", deck, stage, outRoot: taskOutRoot, runDir, args, readinessTarget };
}

function readinessSkipTask({ deck, stage, target, status }) {
  const reason = `${deck.name} remains ${target} unready after this pass's scheduled attempt: ${status.reason ?? status.status ?? "unknown reason"}.`;
  return {
    type: "readiness-skip",
    skip: true,
    skipReason: reason,
    readinessTarget: target,
    deck,
    ownKey: deck.ownKey,
    stage,
    outRoot,
    args: []
  };
}

function matchupTask({
  deck,
  stage,
  jobNumber,
  jobSeed,
  allowUnreadyActionModel = false,
  actionModelStatus = null
}) {
  const label = `job-${String(jobNumber).padStart(3, "0")}-${policyKeySegment(deck.id)}-matchups`;
  const taskOutRoot = join(outRoot, stage.name, label);
  const args = [
    "tools/pilot-matchup-sweep.mjs",
    "--deck", deck.id,
    "--seed", String(jobSeed),
    "--session", `${session}-${label}`,
    "--out-root", taskOutRoot,
    "--agent-root", agentRoot,
    "--policy-dir", policyDir,
    "--baseline-root", baselineRoot,
    "--runs-root", runsRoot,
    "--mode", "priority",
    "--limit", String(stage.matchupLimit),
    "--target-games", String(stage.targetGames),
    "--min-games", String(stage.minGames),
    "--weak-win-rate", String(stage.weakWinRate),
    "--weak-life-diff", String(stage.weakLifeDiff),
    "--priority-shape", stage.priorityShape,
    "--parallel-runs", parallelRuns,
    "--parallel-concurrency", parallelConcurrency,
    "--parallel-opponent-count-per-run", "1",
    "--games", String(stage.games),
    "--generations", String(stage.generations),
    "--population", String(stage.population),
    "--final-games", String(stage.finalGames),
    "--matchup-validation-games", String(stage.validationGames),
    "--parallel-final-games", String(stage.parallelFinalGames),
    "--knowledge-mode", "full"
  ];
  if (allowUnreadyActionModel) args.push("--allow-unready-action-model");
  pushValueIfChanged(args, "--progress-minutes", progressMinutes, "2");
  appendExplorationArgs(args);
  if (dryRun) args.push("--dry-run");
  return {
    type: "matchup-sweep",
    deck,
    stage,
    outRoot: taskOutRoot,
    args,
    evidenceMode: allowUnreadyActionModel,
    actionModelStatus: actionModelStatus?.status ?? null,
    actionModelReason: actionModelStatus?.reason ?? null
  };
}

function runWithRetries(task, { jobNumber, jobSeed }) {
  const attempts = [];
  if (task.skip) {
    console.log(`Scheduler skip: ${task.skipReason}`);
    return {
      status: 0,
      signal: null,
      skipped: true,
      attempts: [{
        attempt: 0,
        seed: jobSeed,
        status: 0,
        signal: null,
        skipped: true,
        reason: task.skipReason,
        endedAt: new Date().toISOString()
      }]
    };
  }
  if (dryRun) {
    const command = commandText(task.args);
    console.log(`Dry run: skipped child process for ${task.type}.`);
    return {
      status: 0,
      signal: null,
      attempts: [{
        attempt: 1,
        seed: jobSeed,
        status: 0,
        signal: null,
        dryRun: true,
        command,
        endedAt: new Date().toISOString()
      }]
    };
  }
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const args = attempt === 0 ? task.args : retryArgs(task.args, jobSeed + attempt * retrySeedStep);
    if (attempt > 0) console.log(`Retry ${attempt}/${maxRetries}: ${commandText(args)}`);
    const result = spawnSync(process.execPath, args, {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: "inherit"
    });
    attempts.push({
      attempt: attempt + 1,
      seed: jobSeed + attempt * retrySeedStep,
      status: result.status,
      signal: result.signal ?? null,
      command: commandText(args),
      endedAt: new Date().toISOString()
    });
    if (result.status === 0) return { status: 0, signal: null, attempts };
    writeFileSync(join(outRoot, `failed-job-${String(jobNumber).padStart(3, "0")}-attempt-${attempt + 1}.json`), `${JSON.stringify({
      taskType: task.type,
      command: commandText(args),
      status: result.status,
      signal: result.signal ?? null,
      attempts
    }, null, 2)}\n`);
  }
  const last = attempts.at(-1) ?? {};
  return { status: last.status ?? 1, signal: last.signal ?? null, attempts };
}

function retryArgs(args, nextSeed) {
  const copy = [...args];
  const index = copy.indexOf("--seed");
  if (index !== -1) copy[index + 1] = String(nextSeed);
  return copy;
}

function taskDetail(task) {
  if (task.skip) {
    return {
      schedulerSkip: true,
      skipReason: task.skipReason,
      learningProgress: null,
      matchupValidation: null,
      matchupValidationRollback: null,
      baselinePromotions: null
    };
  }
  const knowledgeUpdates = knowledgeUpdateFiles(task.outRoot)
    .map((path) => ({ path, data: readJsonIfExists(path) }))
    .filter((row) => row.data);
  const learningProgress = summarizeKnowledgeProgress(knowledgeUpdates);
  const matchupValidation = summarizeMatchupValidations(matchupValidationFiles(task.outRoot)
    .map((path) => ({ path, data: readJsonIfExists(path) }))
    .filter((row) => row.data));
  const matchupValidationRollback = summarizeMatchupValidationRollbacks(loopStateFiles(task.outRoot)
    .map((path) => ({ path, data: readJsonIfExists(path) }))
    .filter((row) => row.data));
  const baselinePromotions = summarizeBaselinePromotions(readJsonIfExists(join(task.outRoot, "parallel-child-routed-policy-promotions.json")));
  if (task.type === "baseline-suite") return { learningProgress, matchupValidation, matchupValidationRollback, baselinePromotions };
  if (task.type !== "matchup-sweep") return { learningProgress, matchupValidation, matchupValidationRollback };
  const statePath = join(task.outRoot, "matchup-sweep-state.json");
  const sweep = readJsonIfExists(statePath);
  return {
    selectedTasks: Array.isArray(sweep?.selectedTasks) ? sweep.selectedTasks.length : null,
    stopReason: sweep?.stopReason ?? null,
    learningProgress,
    matchupValidation,
    matchupValidationRollback
  };
}

function baselineRefreshBatch() {
  if (decks.length === 0) return [];
  const batch = [];
  const cursor = Number(state.baselineRefreshCursor ?? 0);
  const count = Math.min(baselineRefreshBatchSize, decks.length);
  for (let offset = 0; offset < count; offset += 1) {
    batch.push(decks[(cursor + offset) % decks.length]);
  }
  return batch;
}

function uniqueDecksByOwnKey(rows) {
  const seen = new Set();
  const unique = [];
  for (const row of rows) {
    if (!row?.ownKey || seen.has(row.ownKey)) continue;
    seen.add(row.ownKey);
    unique.push(row);
  }
  return unique;
}

function readinessScopeDecks(rows) {
  if (deckAdvanceMode !== "complete" || decks.length === 0) return rows;
  const current = decks[state.nextDeckIndex % decks.length];
  return rows.filter((row) => row.id === current.id || row.ownKey === current.ownKey);
}

function baselineRefreshModeAllows(kind) {
  if (baselineRefreshMode === "missing-and-round-robin") return kind === "missing" || kind === "round-robin";
  return baselineRefreshMode === kind;
}

function profileSnapshotForTask(task) {
  const keys = task.profileKeys?.length ? task.profileKeys : task.deck?.ownKey ? [task.deck.ownKey] : task.ownKey ? [task.ownKey] : decks.map((deck) => deck.ownKey);
  return profileSnapshotForKeys(keys);
}

function profileSnapshotForKeys(keys) {
  const seen = new Set();
  return [...new Set(keys.filter(Boolean))]
    .flatMap((key) => profileSnapshot(key))
    .filter((row) => {
      if (seen.has(row.path)) return false;
      seen.add(row.path);
      return true;
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

function profileSnapshot(ownKey) {
  const files = [
    { kind: "baseline-policy", path: baselinePolicyPathForKey(ownKey, { policyDir, baselineRoot }) },
    { kind: "baseline-origin", path: baselineOriginPathForKey(ownKey, { policyDir, baselineRoot }) },
    { kind: "legacy-baseline-policy", path: join(policyDir, `${policyKeySegment(ownKey)}.json`) },
    ...actionModelCandidatePathsForKey(ownKey, { agentRoot, baselineRoot }).map((path) => ({ kind: "action-model", path })),
    ...matchupOverlayFilesForKey(ownKey, { policyDir, baselineRoot }).map((file) => ({ kind: `matchup-overlay:${file.opponentKey}`, path: file.path })),
    ...matchupOverlayCandidateFilesForKey(ownKey, { policyDir, baselineRoot }).map((file) => ({ kind: `matchup-overlay-candidate:${file.opponentKey}`, path: file.path }))
  ];
  const seen = new Set();
  return files
    .filter((file) => {
      if (!file.path || seen.has(file.path)) return false;
      seen.add(file.path);
      return true;
    })
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => ({
      ...file,
      exists: existsSync(file.path),
      digest: stableArtifactDigest(file.path)
    }));
}

function profileChangeSummary(beforeRows, afterRows) {
  const before = new Map(beforeRows.map((row) => [row.path, row]));
  const after = new Map(afterRows.map((row) => [row.path, row]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a.localeCompare(b));
  const changedArtifacts = paths
    .map((path) => {
      const previous = before.get(path) ?? { path, exists: false, digest: null, kind: after.get(path)?.kind ?? "unknown" };
      const current = after.get(path) ?? { path, exists: false, digest: null, kind: previous.kind ?? "unknown" };
      if (previous.exists === current.exists && previous.digest === current.digest) return null;
      return {
        kind: current.kind ?? previous.kind,
        path,
        before: previous.exists ? previous.digest : "missing",
        after: current.exists ? current.digest : "missing"
      };
    })
    .filter(Boolean);
  return {
    changed: changedArtifacts.length > 0,
    changedArtifacts: changedArtifacts.slice(0, 20)
  };
}

function appendSharedOverseerArgs(args) {
  pushValueIfChanged(args, "--agent-root", agentRoot, "work/private/pilot-agent");
  pushValueIfChanged(args, "--policy-dir", policyDir, join(agentRoot, "policies"));
  pushValueIfChanged(args, "--baseline-root", baselineRoot, join(agentRoot, "baselines"));
  pushValueIfChanged(args, "--runs-root", runsRoot, join(agentRoot, "runs"));
}

function appendExplorationArgs(args) {
  const boost = activeLearningEvidenceBoost();
  pushValueIfChanged(args, "--exploration-mode", explorationMode, "");
  pushValueIfChanged(args, "--exploration-rate", explorationRate || boost?.explorationRate, "");
  pushValueIfChanged(args, "--exploration-max-per-game", explorationMaxPerGame, "");
  pushValueIfChanged(args, "--exploration-score-window", explorationScoreWindow, "");
  pushValueIfChanged(args, "--exploration-max-rank", explorationMaxRank, "");
  pushValueIfChanged(args, "--exploration-min-score", explorationMinScore, "");
  pushValueIfChanged(args, "--raid-normal-play-exploration-rate", raidNormalPlayExplorationRate || boost?.raidNormalPlayExplorationRate, "");
  pushValueIfChanged(args, "--raid-normal-play-score-window", raidNormalPlayScoreWindow || boost?.raidNormalPlayScoreWindow, "");
  pushValueIfChanged(args, "--raid-normal-play-heuristic-window", raidNormalPlayHeuristicWindow || boost?.raidNormalPlayHeuristicWindow, "");
  pushValueIfChanged(args, "--raid-normal-play-min-heuristic-score", raidNormalPlayMinHeuristicScore || boost?.raidNormalPlayMinHeuristicScore, "");
  pushValueIfChanged(args, "--counterfactual-exploration-rate", counterfactualExplorationRate || boost?.counterfactualExplorationRate, "");
  pushValueIfChanged(args, "--counterfactual-max-per-game", counterfactualMaxPerGame || boost?.counterfactualMaxPerGame, "");
  pushValueIfChanged(args, "--counterfactual-rollout-actions", counterfactualRolloutActions || boost?.counterfactualRolloutActions, "");
  pushValueIfChanged(args, "--counterfactual-rollout-player-turns", counterfactualRolloutPlayerTurns || boost?.counterfactualRolloutPlayerTurns, "");
}

function activeLearningEvidenceBoost() {
  if (!adaptiveLearningEvidence) return null;
  const boost = state.learningEvidenceBoost;
  return boost?.active ? boost : null;
}

function updateLearningEvidenceBoost(evidenceQuality, jobRow) {
  if (!adaptiveLearningEvidence || !evidenceQuality || Number(jobRow?.status ?? 0) !== 0) return;
  const previous = state.learningEvidenceBoost ?? null;
  if (evidenceQuality.needsRicherSampling) {
    const level = Math.min(3, Number(previous?.level ?? 0) + 1);
    const nextBoost = {
      active: true,
      level,
      sourceJob: jobRow.job ?? null,
      sourceDeck: jobRow.deckName ?? jobRow.deckId ?? null,
      reason: evidenceQuality.reason,
      setAt: new Date().toISOString()
    };
    const rate = boostedCounterfactualRate(level);
    const maxPerGame = level >= 3 ? String(Math.max(2, Number(adaptiveCounterfactualMaxPerGame ?? 1))) : String(adaptiveCounterfactualMaxPerGame);
    Object.assign(nextBoost, {
      counterfactualExplorationRate: rate,
      counterfactualMaxPerGame: maxPerGame,
      counterfactualRolloutActions: boostedCounterfactualRolloutActions(level),
      counterfactualRolloutPlayerTurns: String(adaptiveCounterfactualRolloutPlayerTurns)
    });
    if (evidenceQuality.needsOpportunitySampling) {
      Object.assign(nextBoost, {
        explorationRate: boostedExplorationRate(level),
        raidNormalPlayExplorationRate: boostedRaidNormalPlayRate(level),
        raidNormalPlayScoreWindow: String(adaptiveRaidNormalPlayScoreWindow),
        raidNormalPlayHeuristicWindow: String(adaptiveRaidNormalPlayHeuristicWindow),
        raidNormalPlayMinHeuristicScore: String(adaptiveRaidNormalPlayMinHeuristicScore)
      });
    }
    state.learningEvidenceBoost = {
      ...nextBoost,
      modes: [
        evidenceQuality.needsCounterfactualSampling ? "counterfactual" : null,
        evidenceQuality.needsOpportunitySampling ? "opportunity" : null
      ].filter(Boolean)
    };
    console.log(`Learning evidence needs richer sampling; next jobs will use ${learningEvidenceBoostDescription(state.learningEvidenceBoost)}.`);
    return;
  }
  if (previous?.active && (evidenceQuality.status === "healthy" || evidenceQuality.status === "watch")) {
    state.learningEvidenceBoost = {
      ...previous,
      active: false,
      clearedAt: new Date().toISOString(),
      clearedByJob: jobRow.job ?? null,
      clearedReason: "learning evidence recovered"
    };
    console.log("Learning evidence recovered; adaptive counterfactual boost is cleared.");
  }
}

function boostedCounterfactualRate(level) {
  const base = clamp(Number(adaptiveCounterfactualExplorationRate ?? 0.55), 0, 1);
  return String(Number(Math.min(0.85, base + Math.max(0, Number(level ?? 1) - 1) * 0.1).toFixed(3)));
}

function boostedCounterfactualRolloutActions(level) {
  const base = Math.max(1, Number(adaptiveCounterfactualRolloutActions ?? 64));
  return String(Math.min(160, Math.ceil(base + Math.max(0, Number(level ?? 1) - 1) * 24)));
}

function boostedExplorationRate(level) {
  const base = clamp(Number(adaptiveExplorationRate ?? 0.08), 0, 0.25);
  return String(Number(Math.min(0.2, base + Math.max(0, Number(level ?? 1) - 1) * 0.04).toFixed(3)));
}

function boostedRaidNormalPlayRate(level) {
  const base = clamp(Number(adaptiveRaidNormalPlayExplorationRate ?? 0.55), 0, 1);
  return String(Number(Math.min(0.9, base + Math.max(0, Number(level ?? 1) - 1) * 0.1).toFixed(3)));
}

function learningEvidenceBoostDescription(boost) {
  const parts = [];
  if (boost?.counterfactualExplorationRate) {
    parts.push(`counterfactual rate ${boost.counterfactualExplorationRate}, max ${boost.counterfactualMaxPerGame}/game, rollout ${boost.counterfactualRolloutActions} actions / ${boost.counterfactualRolloutPlayerTurns} player-turns`);
  }
  if (boost?.explorationRate) parts.push(`general exploration rate ${boost.explorationRate}`);
  if (boost?.raidNormalPlayExplorationRate) {
    parts.push(`raid normal-play rate ${boost.raidNormalPlayExplorationRate}, windows ${boost.raidNormalPlayScoreWindow}/${boost.raidNormalPlayHeuristicWindow}`);
  }
  return parts.join("; ") || "adaptive evidence settings";
}

function pushValueIfChanged(args, flag, value, defaultValue) {
  if (String(value ?? "") === String(defaultValue ?? "")) return;
  args.push(flag, String(value));
}

function stableArtifactDigest(path) {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    return createHash("sha256").update(stableStringify(removeVolatileFields(parsed))).digest("hex");
  } catch {
    try {
      return createHash("sha256").update(readFileSync(path)).digest("hex");
    } catch {
      return null;
    }
  }
}

function removeVolatileFields(value) {
  if (Array.isArray(value)) return value.map(removeVolatileFields);
  if (!value || typeof value !== "object") return value;
  const volatile = new Set(["createdAt", "updatedAt", "trainedAt", "generatedAt", "startedAt", "endedAt"]);
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (volatile.has(key)) continue;
    result[key] = removeVolatileFields(child);
  }
  return result;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort((a, b) => a.localeCompare(b)).map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function knowledgeUpdateFiles(root) {
  if (!root || !existsSync(root)) return [];
  const files = [];
  const queue = [root];
  while (queue.length > 0 && files.length < 100) {
    const dir = queue.shift();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile() && entry.name === "knowledge-update.json") files.push(path);
    }
  }
  return files.sort((a, b) => fileMtimeMs(b) - fileMtimeMs(a) || a.localeCompare(b));
}

function matchupValidationFiles(root) {
  if (!root || !existsSync(root)) return [];
  const files = [];
  const queue = [root];
  while (queue.length > 0 && files.length < 100) {
    const dir = queue.shift();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile() && entry.name === "matchup-validation.json") files.push(path);
    }
  }
  return files.sort((a, b) => fileMtimeMs(b) - fileMtimeMs(a) || a.localeCompare(b));
}

function loopStateFiles(root) {
  if (!root || !existsSync(root)) return [];
  const files = [];
  const queue = [root];
  while (queue.length > 0 && files.length < 100) {
    const dir = queue.shift();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile() && entry.name === "loop-state.json") files.push(path);
    }
  }
  return files.sort((a, b) => fileMtimeMs(b) - fileMtimeMs(a) || a.localeCompare(b));
}

function summarizeMatchupValidationRollbacks(rows) {
  const rollbacks = [];
  for (const row of rows) {
    for (const cycle of row.data?.cycles ?? []) {
      if (!cycle.matchupValidationRollback) continue;
      rollbacks.push({
        path: row.path,
        cycle: cycle.cycle ?? null,
        deckId: cycle.deck ?? null,
        rolledBack: Boolean(cycle.matchupValidationRollback.rolledBack),
        reason: cycle.matchupValidationRollback.reason ?? "",
        verdict: cycle.matchupValidationRollback.verdict ?? "unknown",
        winRateDelta: Number(cycle.matchupValidationRollback.winRateDelta ?? 0),
        avgLifeDiffDelta: Number(cycle.matchupValidationRollback.avgLifeDiffDelta ?? 0),
        scoreDelta: Number(cycle.matchupValidationRollback.scoreDelta ?? 0),
        rolledBackAt: cycle.matchupValidationRollback.rolledBackAt ?? null
      });
    }
  }
  return {
    updates: rollbacks.length,
    rolledBack: rollbacks.filter((row) => row.rolledBack).length,
    failed: rollbacks.filter((row) => !row.rolledBack).length,
    rows: rollbacks
  };
}

function summarizeBaselinePromotions(summary) {
  const promotions = Array.isArray(summary?.promotions) ? summary.promotions : [];
  return {
    updates: promotions.length,
    promoted: promotions.filter((row) => row.promote).length,
    rejected: promotions.filter((row) => !row.promote).length,
    missingSeeded: promotions.filter((row) => row.promote && row.missingSpecialist).length,
    rows: promotions.map((row) => ({
      deckId: row.deckId ?? null,
      deckName: row.deckName ?? null,
      ownKey: row.ownKey ?? null,
      promote: Boolean(row.promote),
      missingSpecialist: Boolean(row.missingSpecialist),
      reason: row.reason ?? "",
      candidateScore: Number(row.candidateScore ?? 0),
      baselineScore: row.baselineScore === null ? null : Number(row.baselineScore ?? 0),
      scoreDelta: Number(row.scoreDelta ?? 0),
      writtenPath: row.writtenPath ?? null
    }))
  };
}

function summarizeKnowledgeProgress(rows) {
  const totals = {
    updates: rows.length,
    modelExamples: 0,
    modelFeatures: 0,
    modelPairwiseExamples: 0,
    overlays: 0,
    overlayCandidates: 0,
    overlayCreated: 0,
    overlayUpdated: 0,
    overlayRemoved: 0,
    overlayUnchanged: 0,
    overlayCandidateCreated: 0,
    overlayCandidateUpdated: 0,
    overlayCandidateRemoved: 0,
    overlayCandidateUnchanged: 0,
    chosenRows: 0,
    counterfactualRows: 0,
    health: {
      healthy: 0,
      watch: 0,
      blocked: 0,
      unknown: 0,
      rows: []
    }
  };
  for (const row of rows) {
    const data = row.data;
    totals.modelExamples += Number(data?.mlModel?.examples ?? 0);
    totals.modelFeatures += Number(data?.mlModel?.features ?? 0);
    totals.modelPairwiseExamples += Number(data?.mlModel?.pairwiseExamples ?? 0);
    totals.overlays += Array.isArray(data?.overlays) ? data.overlays.filter((overlay) => !overlay.candidate).length : 0;
    totals.overlayCandidates += Array.isArray(data?.overlays) ? data.overlays.filter((overlay) => overlay.candidate).length : 0;
    totals.overlayCreated += Number(data?.overlayChanges?.created ?? 0);
    totals.overlayUpdated += Number(data?.overlayChanges?.updated ?? 0);
    totals.overlayRemoved += Number(data?.overlayChanges?.removed ?? 0);
    totals.overlayUnchanged += Number(data?.overlayChanges?.unchanged ?? 0);
    totals.overlayCandidateCreated += Number(data?.overlayChanges?.candidateCreated ?? 0);
    totals.overlayCandidateUpdated += Number(data?.overlayChanges?.candidateUpdated ?? 0);
    totals.overlayCandidateRemoved += Number(data?.overlayChanges?.candidateRemoved ?? 0);
    totals.overlayCandidateUnchanged += Number(data?.overlayChanges?.candidateUnchanged ?? 0);
    totals.chosenRows += Number(data?.decisions?.chosenRows ?? 0);
    totals.counterfactualRows += Number(data?.decisions?.counterfactual ?? 0);
    const health = data?.learningHealth ?? null;
    const status = learningHealthStatus(health);
    const sampling = health?.sampling ?? data?.decisions?.samplingTelemetry ?? null;
    totals.health[status] += 1;
    totals.health.rows.push({
      path: row.path,
      ownKey: data?.ownKey ?? null,
      deckId: data?.deckId ?? null,
      status,
      label: health?.label ?? status,
      blockers: Array.isArray(health?.blockers) ? health.blockers.slice(0, 5) : [],
      warnings: Array.isArray(health?.warnings) ? health.warnings.slice(0, 5) : [],
      chosenRows: Number(data?.decisions?.chosenRows ?? 0),
      counterfactualRows: Number(data?.decisions?.counterfactual ?? 0),
      incompleteRate: Number(health?.rates?.incomplete ?? data?.decisions?.rates?.incomplete ?? 0),
      forcedRate: Number(health?.rates?.forced ?? data?.decisions?.rates?.forced ?? 0),
      explorationRate: Number(health?.rates?.exploration ?? data?.decisions?.rates?.exploration ?? 0),
      counterfactualRate: Number(health?.rates?.counterfactual ?? data?.decisions?.rates?.counterfactual ?? 0),
      samplingTelemetryAvailable: Boolean(sampling?.telemetryAvailable ?? sampling?.available),
      sampledPlayerGames: Number(sampling?.playerGames ?? 0),
      sampledCounterfactuals: Number(sampling?.counterfactualsEvaluated ?? 0),
      sampledActionableCounterfactuals: Number(sampling?.actionableCounterfactuals ?? 0),
      sampledUnsynchronizedCounterfactuals: Number(sampling?.unsynchronizedCounterfactuals ?? 0),
      counterfactualsPerPlayerGame: Number(sampling?.counterfactualsPerPlayerGame ?? sampling?.rates?.counterfactualPerGame ?? 0),
      actionableCounterfactualsPerPlayerGame: Number(
        sampling?.actionableCounterfactualsPerPlayerGame ?? sampling?.rates?.actionableCounterfactualPerGame ?? 0
      ),
      unsynchronizedCounterfactualRate: Number(
        sampling?.unsynchronizedCounterfactualRate ?? sampling?.rates?.unsynchronizedCounterfactualRate ?? 0
      )
    });
  }
  totals.evidenceQuality = learningEvidenceQuality(totals);
  return totals;
}

function artifactProgressAcceptedForJob({ artifactChanged, learningProgress, evidenceQuality }) {
  if (!artifactChanged) return false;
  const hasLearningUpdate = Number(learningProgress?.updates ?? 0) > 0 || Number(learningProgress?.chosenRows ?? 0) > 0;
  if (!hasLearningUpdate) return true;
  if (evidenceQuality?.status === "blocked") return false;
  if (evidenceQuality?.needsRicherSampling) return false;
  return true;
}

function learningEvidenceQuality(progress = {}) {
  const health = progress.health ?? {};
  const rows = Array.isArray(health.rows) ? health.rows : [];
  const blockedRows = rows.filter((row) => row.status === "blocked");
  const richerSamplingRows = rows.filter(rowNeedsRicherSampling);
  const counterfactualRates = rows
    .map((row) => Number(row.counterfactualRate ?? 0))
    .filter((value) => Number.isFinite(value));
  const minCounterfactualRate = counterfactualRates.length > 0 ? Math.min(...counterfactualRates) : null;
  const status = blockedRows.length > 0
    ? "blocked"
    : richerSamplingRows.length > 0
      ? "thin"
      : Number(health.healthy ?? 0) > 0
        ? "healthy"
        : Number(health.watch ?? 0) > 0
          ? "watch"
          : Number(progress.updates ?? 0) > 0
            ? "unknown"
            : "none";
  const reasonRow = richerSamplingRows[0] ?? blockedRows[0] ?? rows[0] ?? null;
  const needsCounterfactualSampling = richerSamplingRows.some((row) => (
    /counterfactual|pairwise|held-out action|held-out breadth|retained held-out/.test(learningHealthRowText(row))
  ));
  const needsOpportunitySampling = richerSamplingRows.some((row) => (
    /raid normal-play|opportunity sampling|candidate-only action/.test(learningHealthRowText(row))
  ));
  return {
    status,
    needsRicherSampling: richerSamplingRows.length > 0,
    needsCounterfactualSampling,
    needsOpportunitySampling,
    blockedUpdates: blockedRows.length,
    thinCounterfactualUpdates: richerSamplingRows.length,
    minCounterfactualRate,
    counterfactualRows: Number(progress.counterfactualRows ?? 0),
    chosenRows: Number(progress.chosenRows ?? 0),
    reason: reasonRow
      ? reasonRow.blockers?.[0] ?? reasonRow.warnings?.[0] ?? `${status} learning evidence`
      : "no knowledge update evidence found"
  };
}

function rowNeedsRicherSampling(row) {
  const chosenRows = Number(row?.chosenRows ?? 0);
  const counterfactualRows = Number(row?.counterfactualRows ?? 0);
  const sampledPlayerGames = Number(row?.sampledPlayerGames ?? 0);
  if (row?.samplingTelemetryAvailable && sampledPlayerGames >= 20) {
    if (Number(row?.counterfactualsPerPlayerGame ?? 0) < 0.3) return true;
    if (Number(row?.actionableCounterfactualsPerPlayerGame ?? 0) < 0.2) return true;
    if (Number(row?.unsynchronizedCounterfactualRate ?? 0) > 0.2) return true;
  }
  if (chosenRows >= 80 && counterfactualRows === 0) return true;
  const counterfactualRate = Number(row?.counterfactualRate ?? 0);
  if (chosenRows >= 80 && Number.isFinite(counterfactualRate) && counterfactualRate > 0 && counterfactualRate < 0.03) return true;
  const text = learningHealthRowText(row);
  if (/raid normal-play|opportunity sampling|candidate-only action/.test(text)) return true;
  if (/supported held-out action family|held-out breadth is narrow|retained held-out|one-sided oriented evidence/.test(text)) return true;
  return /counterfactual|pairwise/.test(text)
    && /(thin|starved|only|no reliable|no counterfactual|no pairwise|converge slowly)/.test(text);
}

function learningHealthRowText(row) {
  return [
    ...(Array.isArray(row?.blockers) ? row.blockers : []),
    ...(Array.isArray(row?.warnings) ? row.warnings : [])
  ].join(" ").toLowerCase();
}

function learningHealthStatus(health) {
  const status = String(health?.status ?? "unknown").toLowerCase();
  if (status === "healthy" || status === "watch" || status === "blocked") return status;
  return "unknown";
}

function summarizeMatchupValidations(rows) {
  const totals = {
    updates: rows.length,
    positive: 0,
    negative: 0,
    inconclusive: 0,
    safeNoRuntimeChange: 0,
    winRateDeltaTotal: 0,
    avgLifeDiffDeltaTotal: 0,
    scoreDeltaTotal: 0,
    rows: rows.map((row) => ({
      path: row.path,
      deckId: row.data?.deck?.id ?? null,
      ownKey: row.data?.deck?.ownKey ?? null,
      opponents: (row.data?.opponents ?? []).map((opponent) => opponent.ownKey ?? opponent.id),
      games: Number(row.data?.config?.games ?? 0),
      comparedArtifact: row.data?.comparison?.comparedArtifact ?? "unknown",
      verdict: row.data?.comparison?.verdict ?? "unknown",
      actionVerdict: row.data?.comparison?.actionVerdict ?? row.data?.comparisons?.action?.verdict ?? null,
      overlayVerdict: row.data?.comparison?.overlayVerdict ?? row.data?.comparisons?.overlay?.verdict ?? null,
      candidateOverlayDecisionCount: Number(row.data?.comparison?.candidateOverlayDecisionCount ?? 0),
      minimumCandidateOverlayDecisions: Number(row.data?.comparison?.minimumCandidateOverlayDecisions ?? 0),
      exposureReady: row.data?.comparison?.exposureReady === true,
      winRateDelta: Number(row.data?.comparison?.winRateDelta ?? 0),
      avgLifeDiffDelta: Number(row.data?.comparison?.avgLifeDiffDelta ?? 0),
      scoreDelta: Number(row.data?.comparison?.scoreDelta ?? 0)
    }))
  };
  for (const row of totals.rows) {
    if (row.verdict === "positive") totals.positive += 1;
    else if (row.verdict === "negative") totals.negative += 1;
    else if (row.verdict === "safe-no-runtime-change") totals.safeNoRuntimeChange += 1;
    else totals.inconclusive += 1;
    totals.winRateDeltaTotal += row.winRateDelta;
    totals.avgLifeDiffDeltaTotal += row.avgLifeDiffDelta;
    totals.scoreDeltaTotal += row.scoreDelta;
  }
  totals.avgWinRateDelta = rows.length === 0 ? 0 : totals.winRateDeltaTotal / rows.length;
  totals.avgLifeDiffDelta = rows.length === 0 ? 0 : totals.avgLifeDiffDeltaTotal / rows.length;
  totals.avgScoreDelta = rows.length === 0 ? 0 : totals.scoreDeltaTotal / rows.length;
  return totals;
}

function fileMtimeMs(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function baselineReady(ownKey) {
  return baselineStatus(ownKey).ready;
}

function baselineStatus(ownKey) {
  const organizedPath = baselinePolicyPathForKey(ownKey, { policyDir, baselineRoot });
  const legacyPath = join(policyDir, `${policyKeySegment(ownKey)}.json`);
  if (existsSync(organizedPath)) {
    const originPath = baselineOriginPathForKey(ownKey, { policyDir, baselineRoot });
    const origin = readJsonIfExists(originPath);
    const quality = baselineOriginQuality(origin);
    const needsTraining = baselineOriginNeedsTraining(origin, quality);
    return {
      ready: !needsTraining,
      status: needsTraining ? quality === "unknown" ? "unknown" : "seed" : "trained",
      policyPath: organizedPath,
      originPath,
      origin: origin ? {
        quality,
        promotionType: origin.promotionType ?? null,
        needsTraining: Boolean(origin.needsTraining),
        acceptedForLearning: Boolean(origin.acceptedForLearning)
      } : null
    };
  }
  if (existsSync(legacyPath)) {
    return {
      ready: false,
      status: "legacy",
      policyPath: legacyPath,
      originPath: null,
      origin: null,
      reason: "legacy flat baseline needs organized retraining"
    };
  }
  return {
    ready: false,
    status: "missing",
    policyPath: organizedPath,
    originPath: baselineOriginPathForKey(ownKey, { policyDir, baselineRoot }),
    origin: null
  };
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
  if (quality === "seed" || quality === "unknown") return true;
  return false;
}

function actionModelReady(ownKey) {
  return actionModelStatus(ownKey).ready;
}

function actionModelStatus(ownKey) {
  const candidates = actionModelCandidatePathsForKey(ownKey, { agentRoot, baselineRoot });
  const path = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0] ?? null;
  const model = path && existsSync(path) ? readJsonIfExists(path) : null;
  const legacyPath = candidates[1] ?? null;
  const readiness = mlActionModelReadiness(model, {
    minExamples: minActionModelExamples,
    minTrust: minActionModelTrust,
    minHeldoutGames: minActionModelHeldoutGames,
    minPairwiseExamples: minActionModelPairwiseExamples
  });
  if (legacyPath && path === legacyPath) {
    return {
      ...readiness,
      ready: false,
      status: "legacy",
      path,
      reason: "legacy profile action model needs organized retraining"
    };
  }
  return {
    ...readiness,
    path
  };
}

function savedPilotDecks() {
  if (!existsSync(libraryDir)) return [];
  return readdirSync(libraryDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => deckFromFile(join(libraryDir, entry.name), entry.name))
    .filter(Boolean);
}

function savedDeckById(deckId) {
  const path = join(libraryDir, `${deckId}.json`);
  if (!existsSync(path)) return null;
  return deckFromFile(path, `${deckId}.json`);
}

function deckFromFile(path, fileName) {
  const raw = readJsonIfExists(path);
  if (!raw || !Array.isArray(raw.cards)) return null;
  const id = raw.id ?? fileName.replace(/\.json$/u, "");
  if (!deckPrefixes.some((prefix) => id.startsWith(prefix))) return null;
  const resolution = resolveArchetypeProfile({
    deck: raw.cards,
    savedDeck: raw,
    deckId: id,
    catalog,
    deckLibrary: libraryDir,
    deckPrefixes
  });
  const ownKey = resolution.profile.key;
  const baseline = baselineStatus(ownKey);
  const model = actionModelStatus(ownKey);
  return {
    id,
    name: raw.name ?? id,
    path,
    ownKey,
    sourceCode: resolution.profile.sourceCode ?? null,
    colors: resolution.profile.colors ?? [],
    baselineReady: baseline.ready,
    baselineStatus: baseline.status,
    baselineOrigin: baseline.origin,
    actionModelReady: model.ready,
    actionModelStatus: model.status
  };
}

function selectedDecks(decks) {
  const requested = splitList(option("--decks") ?? "");
  const allRequested = requested.length === 0 || requested.some((value) => ["all", "all-decks", "all-visible"].includes(policyKeySegment(value)));
  const filtered = decks.filter((deck) => allRequested
    || requested.includes(deck.id)
    || requested.includes(deck.ownKey)
    || requested.map(policyKeySegment).includes(policyKeySegment(deck.id))
    || requested.map(policyKeySegment).includes(policyKeySegment(deck.ownKey)));
  const ordered = sortDecks(filtered);
  const startDeck = option("--start-deck") ?? "carnerr-spear";
  const startIndex = ordered.findIndex((deck) => deck.id === startDeck || deck.ownKey === startDeck);
  if (startIndex <= 0) return ordered;
  return [...ordered.slice(startIndex), ...ordered.slice(0, startIndex)];
}

function sortDecks(decks) {
  const order = splitList(option("--deck-order") ?? "");
  const orderKey = new Map(order.map((id, index) => [id, index]));
  const segmentOrderKey = new Map(order.map((id, index) => [policyKeySegment(id), index]));
  return [...decks].sort((a, b) => {
    const aOrder = orderKey.get(a.id) ?? orderKey.get(a.ownKey) ?? segmentOrderKey.get(policyKeySegment(a.id)) ?? segmentOrderKey.get(policyKeySegment(a.ownKey)) ?? 999999;
    const bOrder = orderKey.get(b.id) ?? orderKey.get(b.ownKey) ?? segmentOrderKey.get(policyKeySegment(b.id)) ?? segmentOrderKey.get(policyKeySegment(b.ownKey)) ?? 999999;
    return aOrder - bOrder || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
}

function configuredStages() {
  const requested = splitList(option("--stages") ?? "light,deep,long");
  const baseTarget = Math.max(20, Number(option("--target-games") ?? 60));
  const catalog = {
    light: {
      name: "light",
      targetGames: baseTarget,
      minGames: 20,
      weakWinRate: 0.45,
      weakLifeDiff: -1,
      priorityShape,
      matchupLimit: parseMatchupLimit(option("--light-matchup-limit") ?? defaultMatchupLimit),
      games: Number(option("--light-games") ?? 8),
      generations: Number(option("--light-generations") ?? 1),
      population: Number(option("--light-population") ?? 4),
      finalGames: Number(option("--light-final-games") ?? 8),
      validationGames: Number(option("--light-matchup-validation-games") ?? option("--matchup-validation-games") ?? 20),
      parallelFinalGames: 0,
      baselineGames: Number(option("--light-baseline-games") ?? 8),
      baselineGenerations: Number(option("--light-baseline-generations") ?? 2),
      baselinePopulation: Number(option("--light-baseline-population") ?? 4),
      baselineOpponentCount: Number(option("--light-baseline-opponents") ?? 20),
      baselineOpponentCountPerRun: Number(option("--light-baseline-opponents-per-run") ?? 6),
      baselineFinalGames: Number(option("--light-baseline-final-games") ?? 8),
      baselineParallelFinalGames: Number(option("--light-baseline-parallel-final-games") ?? 0),
      baselineFinalTopPercent: Number(option("--light-baseline-final-top-percent") ?? 35),
      baselineFinalCandidates: option("--light-baseline-final-candidates") ?? "best-baseline"
    },
    deep: {
      name: "deep",
      targetGames: Math.max(baseTarget * 2, 120),
      minGames: 50,
      weakWinRate: 0.48,
      weakLifeDiff: -0.5,
      priorityShape: normalizePriorityShape(option("--deep-priority-shape") ?? explicitPriorityShape ?? "balanced"),
      matchupLimit: parseMatchupLimit(option("--deep-matchup-limit") ?? defaultMatchupLimit),
      games: Number(option("--deep-games") ?? 12),
      generations: Number(option("--deep-generations") ?? 2),
      population: Number(option("--deep-population") ?? 6),
      finalGames: Number(option("--deep-final-games") ?? 10),
      validationGames: Number(option("--deep-matchup-validation-games") ?? option("--matchup-validation-games") ?? 24),
      parallelFinalGames: 0,
      baselineGames: Number(option("--deep-baseline-games") ?? 12),
      baselineGenerations: Number(option("--deep-baseline-generations") ?? 3),
      baselinePopulation: Number(option("--deep-baseline-population") ?? 6),
      baselineOpponentCount: Number(option("--deep-baseline-opponents") ?? 20),
      baselineOpponentCountPerRun: Number(option("--deep-baseline-opponents-per-run") ?? 6),
      baselineFinalGames: Number(option("--deep-baseline-final-games") ?? 10),
      baselineParallelFinalGames: Number(option("--deep-baseline-parallel-final-games") ?? 0),
      baselineFinalTopPercent: Number(option("--deep-baseline-final-top-percent") ?? 35),
      baselineFinalCandidates: option("--deep-baseline-final-candidates") ?? "best-baseline"
    },
    long: {
      name: "long",
      targetGames: Math.max(baseTarget * 3, 200),
      minGames: 80,
      weakWinRate: 0.5,
      weakLifeDiff: 0,
      priorityShape: normalizePriorityShape(option("--long-priority-shape") ?? option("--deep-priority-shape") ?? explicitPriorityShape ?? "exploit"),
      matchupLimit: parseMatchupLimit(option("--long-matchup-limit") ?? defaultMatchupLimit),
      games: Number(option("--long-games") ?? 20),
      generations: Number(option("--long-generations") ?? 3),
      population: Number(option("--long-population") ?? 8),
      finalGames: Number(option("--long-final-games") ?? 12),
      validationGames: Number(option("--long-matchup-validation-games") ?? option("--matchup-validation-games") ?? 30),
      parallelFinalGames: 0,
      baselineGames: Number(option("--long-baseline-games") ?? 16),
      baselineGenerations: Number(option("--long-baseline-generations") ?? 4),
      baselinePopulation: Number(option("--long-baseline-population") ?? 8),
      baselineOpponentCount: Number(option("--long-baseline-opponents") ?? 20),
      baselineOpponentCountPerRun: Number(option("--long-baseline-opponents-per-run") ?? 6),
      baselineFinalGames: Number(option("--long-baseline-final-games") ?? 12),
      baselineParallelFinalGames: Number(option("--long-baseline-parallel-final-games") ?? 0),
      baselineFinalTopPercent: Number(option("--long-baseline-final-top-percent") ?? 35),
      baselineFinalCandidates: option("--long-baseline-final-candidates") ?? "best-baseline"
    }
  };
  const stages = requested.map((name) => catalog[policyKeySegment(name)]).filter(Boolean);
  return stages.length > 0 ? stages : [catalog.light, catalog.deep, catalog.long];
}

function publicStage(stage) {
  const matchupGameSlotsPerChild = stage.games * stage.generations * stage.population + stage.finalGames;
  const baselineGameSlotsPerChild = stage.baselineGames * stage.baselineGenerations * stage.baselinePopulation
    + stage.baselineFinalGames;
  return {
    name: stage.name,
    targetGames: stage.targetGames,
    minGames: stage.minGames,
    priorityShape: stage.priorityShape,
    matchupLimit: stage.matchupLimit,
    games: stage.games,
    generations: stage.generations,
    population: stage.population,
    finalGames: stage.finalGames,
    validationGames: stage.validationGames,
    baselineGames: stage.baselineGames,
    baselineGenerations: stage.baselineGenerations,
    baselinePopulation: stage.baselinePopulation,
    baselineOpponentCount: stage.baselineOpponentCount,
    baselineOpponentCountPerRun: stage.baselineOpponentCountPerRun,
    baselineFinalGames: stage.baselineFinalGames,
    baselineParallelFinalGames: stage.baselineParallelFinalGames,
    baselineFinalTopPercent: stage.baselineFinalTopPercent,
    baselineFinalCandidates: stage.baselineFinalCandidates,
    nominalWork: {
      matchupGameSlotsPerChild,
      matchupGameSlotsAcrossChildren: matchupGameSlotsPerChild * Number(parallelRuns),
      baselineGameSlotsPerChild,
      baselineGameSlotsAcrossChildren: baselineGameSlotsPerChild * Number(parallelRuns)
    }
  };
}

function newPass(stageIndex) {
  return {
    stageIndex,
    stage: stages[stageIndex]?.name ?? "unknown",
    startedAt: new Date().toISOString(),
    jobs: 0,
    schedulerSkips: 0,
    progress: false,
    decksVisited: [],
    completedDecks: [],
    changedProfiles: [],
    baselineAttemptedProfileKeys: [],
    baselineRoundAttemptedProfileKeys: [],
    baselineSuiteRounds: 0,
    baselineRefreshDone: false,
    baselineRefreshJobs: 0,
    actionModelAttemptedProfileKeys: [],
    actionModelRoundAttemptedProfileKeys: [],
    actionModelSuiteRounds: 0,
    actionModelSuiteJobs: 0,
    readinessAttemptKeys: []
  };
}

function readinessAttemptKey(ownKey, target) {
  return `${policyKeySegment(ownKey)}:${policyKeySegment(target)}`;
}

function parseMatchupLimit(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text || text === "all" || text === "full" || text === "deck") return 999;
  const number = Number(text);
  return Number.isFinite(number) ? Math.max(1, Math.floor(number)) : 999;
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function normalizeDeckAdvanceMode(value) {
  const mode = policyKeySegment(value || "batch");
  const aliases = new Map([
    ["balanced", "batch"],
    ["breadth", "batch"],
    ["round-robin", "batch"],
    ["deck", "complete"],
    ["full", "complete"],
    ["exhaustive", "complete"]
  ]);
  const normalized = aliases.get(mode) ?? mode;
  if (!new Set(["batch", "complete"]).has(normalized)) {
    throw new Error(`Unknown --deck-advance-mode: ${value}. Use batch or complete.`);
  }
  return normalized;
}

function normalizeBaselineRefreshMode(value) {
  const normalized = policyKeySegment(value || "missing-and-round-robin");
  const aliases = new Map([
    ["off", "never"],
    ["none", "never"],
    ["false", "never"],
    ["disabled", "never"],
    ["missing-only", "missing"],
    ["needed", "missing"],
    ["needs-baseline", "missing"],
    ["refresh", "round-robin"],
    ["roundrobin", "round-robin"],
    ["periodic", "round-robin"],
    ["baseline", "round-robin"],
    ["both", "missing-and-round-robin"],
    ["safe", "missing-and-round-robin"],
    ["weekend", "missing-and-round-robin"]
  ]);
  const mode = aliases.get(normalized) ?? normalized;
  if (!new Set(["never", "missing", "round-robin", "missing-and-round-robin"]).has(mode)) {
    throw new Error(`Unknown --baseline-refresh-mode: ${value}. Use never, missing, round-robin, or missing-and-round-robin.`);
  }
  return mode;
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

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeState(state) {
  mkdirSync(outRoot, { recursive: true });
  writeJsonAtomicSync(join(outRoot, "auto-refiner-state.json"), state);
}

function commandText(args) {
  return `node ${args.map(quoteArg).join(" ")}`;
}

function taskCommandText(task) {
  return task.skip ? `# ${task.skipReason}` : commandText(task.args);
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

function usage() {
  console.log(`Usage:
  node tools/pilot-auto-refiner.mjs --deck-order carnerr-spear,carnerr-blue-slime --max-jobs 48 --seed 20001

Runs unattended baseline/matchup refinement across pilot deck profiles. It first
repairs baseline and profile-ML readiness, then locks onto one deck's matchup
queue. It escalates after a full no-progress pass, retries failed jobs, and
writes state after every job.

Useful options:
  --decks all|deck-a,deck-b          deck subset; default is all Carnerr/Engine decks
  --deck-order deck-a,deck-b         priority order, usually from the dashboard rail
  --start-deck carnerr-spear         first deck to visit
  --max-jobs 48                     safety ceiling for unattended work
  --stages light,deep,long           escalation ladder
  --target-games 60                 light-stage target per matchup bucket
  --matchup-limit all|N              matchup buckets per recoverable job; default 1
  --matchup-validation-games 20      old-vs-new validation games per matchup update
  --baseline-refresh-mode never|missing|round-robin|missing-and-round-robin
                                    default runs missing baselines first, then rotates compact baseline batches
  --missing-baseline-batch-size 14   missing profiles grouped into each initial catch-up job
  --baseline-refresh-batch-size 2    trained profiles rotated through each routine refresh job
  --baseline-suite-concurrency 1     full-strength baseline deck loops to run at once
  --baseline-suite-retry-rounds 2    parallel missing-baseline sweeps before single-deck fallback
  --min-action-model-examples 80     profile ML runtime-activation evidence threshold
  --min-action-model-trust 0.75      profile ML runtime-activation trust threshold
  --min-action-model-heldout-games 8 profile ML independent validation threshold
  --min-action-model-pairwise-examples 30
                                    profile ML direct paired-decision threshold
  --require-ready-action-model       block matchup evidence until profile ML is runtime-ready;
                                    default safely uses baseline play while untrusted ML remains inactive
  --action-model-suite-batch-size 14 batch profile-ML catch-up after baselines exist
  --action-model-suite-concurrency 1 full-strength deck loops to run at once inside profile-ML catch-up
  --deck-advance-mode batch|complete complete exhausts one deck's matchup queue first; batch rotates decks
  --priority-shape coverage|balanced|exploit default ladder is coverage -> balanced -> exploit
  --light-final-games 8              quick final candidate check per child run
  --light-baseline-games 8           first-tier baseline games per candidate
  --light-baseline-generations 2     first-tier policy-search generations
  --light-baseline-population 4      first-tier candidates per generation
  --light-baseline-opponents 20      baseline opponent pool size
  --light-baseline-final-games 8     per-child baseline final candidate checks
  --light-baseline-parallel-final-games 0
                                    skip hidden master baseline final selection by default
  --exploration-mode counterfactual-probe|action
  --counterfactual-exploration-rate 0.4
  --exploration-max-per-game 1
  --counterfactual-max-per-game 1
  --counterfactual-rollout-actions 64
  --counterfactual-rollout-player-turns 3
  --adaptive-exploration-rate 0.08
  --adaptive-counterfactual-exploration-rate 0.55
  --adaptive-counterfactual-max-per-game 1
  --adaptive-counterfactual-rollout-actions 64
  --adaptive-counterfactual-rollout-player-turns 3
  --no-adaptive-learning-evidence
  --parallel-runs 14 --parallel-concurrency 14
  --max-retries 1
  --fail-fast                       stop on the first failed deck job instead of recording and continuing
  --dry-run`);
}
