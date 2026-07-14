import { CARD_TYPES, LINES, MAX_LINE_SIZE, PHASES, STARTING_LIFE, TIMINGS, TRIGGER_TYPES, opponentOf } from "./constants.js";
import { sourceCodeFromNumber } from "./deck.js";
import { applyAction, conditionMet, createGame, internals, legalActions, publicKnownCardDefIds } from "./game.js";
import { LEARNING_EVIDENCE_FILTER_VERSION } from "./learning-evidence-filter.js";
import { DEFAULT_CONTEXTUAL_MIN_OBSERVATIONS, MULTIVARIATE_RIDGE_VERSION } from "./linear-model.js";
import { deriveSeed, makeRng } from "./random.js";

export const DEFAULT_PILOT_POLICY = Object.freeze({
  schema: "union-arena-local-engine/pilot-policy@1",
  name: "baseline-pilot",
  weights: Object.freeze({
    baseScore: 100,
    advancePhase: 0,
    extraDraw: 55,
    moveToFront: 65,
    movedBp: 6,
    moveToEnergy: -85,
    movedToEnergyBp: -6,
    activateMain: 35,
    abilityEffect: 20,
    performRaid: 90,
    raidBpUpgrade: 12,
    moveRaidToFront: 80,
    playCard: 10,
    playRaidCardNormally: 0,
    playRaidNormallyToFront: 0,
    playRaidNormallyToEnergy: 0,
    playToEnergy: 70,
    earlyEnergy: 45,
    energyShortage: 45,
    playToFront: 45,
    lowCostUnit: 45,
    highBpUnit: 8,
    event: 20,
    lineCrowdingPenalty: -110,
    replacementValue: -80,
    attackPlayer: 90,
    attackCharacter: 40,
    lethalAttack: 900,
    damageThreat: 80,
    lifePressure: 90,
    openLaneDamage: 120,
    forceBlockPressure: 70,
    lowLifePressure: 80,
    attackIntoBlockers: 15,
    attackCanBeatBlocker: 70,
    attackIntoWall: -65,
    attackUsesLastBlocker: -95,
    attackCrackbackLethalRisk: -420,
    attackTwoTurnClock: 95,
    attackTriggerExposure: -25,
    snipeAttack: 30,
    snipeThreatRemoval: 95,
    snipeOverFaceWhenLethal: -500,
    passWithReadyAttackers: -120,
    passMissedDamage: -90,
    passMissedLethal: -1000,
    attackerBp: 7,
    removalTargetBp: 18,
    attackBpAdvantage: 90,
    block: 100,
    declineBlock: 0,
    savedDamage: 140,
    safeDeclineBlock: 90,
    lowLifeDecline: -220,
    preserveFrontLine: 55,
    blockWithLowValue: 50,
    blockWithHighValueAtRisk: -140,
    blockStopsImpact: 85,
    declineTriggerWindow: 25,
    declineToCrackback: 80,
    desperateBlock: 180,
    earlyChumpBlock: -180,
    lethalBlock: 900,
    favorableBlock: 220,
    blockerDies: -150,
    highValueBlocker: -12,
    impactLeak: -80,
    declineLethal: -950,
    damageTaken: -135,
    discard: 20,
    setupKeepBias: -80,
    setupPlayableOpener: 260,
    setupZeroCostUnit: 130,
    setupReducerOpener: 100,
    setupLowCostUnit: 55,
    setupEarlyCharacter: 35,
    setupEnergyPotential: 35,
    setupEnergyPathToThree: 180,
    setupTurnThreePlan: 150,
    setupGreedyPayoff: 55,
    setupGreedyRisk: -240,
    setupCharacterCount: 20,
    setupEnergySource: 20,
    setupMatchedColor: 25,
    setupRaidPair: 90,
    setupBrick: -750,
    setupNoCharacter: -260,
    setupEventClutter: -35,
    setupHighCostClutter: -65,
    setupApCostClutter: -55,
    roleOpener: 30,
    roleEnergyBuilder: 35,
    roleRaidBase: 40,
    roleRaidPayoff: 70,
    roleRemoval: 80,
    roleDrawSearch: 60,
    roleFinisher: 85,
    roleDefender: 35,
    roleTempo: 45,
    roleSynergyPiece: 35,
    abilityRestsPotentialAttacker: -160,
    abilityConsumesAp: -70,
    abilityCardAdvantage: 70,
    abilityRemoval: 130,
    abilityBoardDevelopment: 95,
    abilitySearch: 65,
    abilityTempo: 60
  })
});

export const DEFAULT_ACTION_EXPLORATION = Object.freeze({
  mode: "action",
  rate: 0,
  maxPerGame: 1,
  scoreWindow: 240,
  maxRank: 8,
  minScore: -300,
  raidNormalPlayRate: 0,
  raidNormalPlayScoreWindow: 900,
  raidNormalPlayHeuristicWindow: 1100,
  raidNormalPlayMinHeuristicScore: -200,
  noveltyStrength: 1.5,
  evidence: null
});

export const DEFAULT_COUNTERFACTUAL_EXPLORATION = Object.freeze({
  rate: 0,
  setupRate: 0,
  maxPerGame: 1,
  rolloutMaxActions: 80,
  rolloutMaxPlayerTurns: 3,
  adaptiveRollout: true,
  adaptiveAuditRate: 0.1,
  decisionWindow: 12,
  minimumInformationScore: 0.52,
  lowInformationExplorationRate: 0.15,
  phaseWeights: Object.freeze({
    main: 0.3,
    attack: 0.3,
    block: 0.3,
    movement: 0.1
  }),
  fallbackAfterEligible: 40,
  alternativeDiversityRate: 0.75
});

const COUNTERFACTUAL_PHASE_ORDER = Object.freeze(["main", "attack", "block", "movement"]);
const COUNTERFACTUAL_PHASE_WINDOW_SCALE = Object.freeze({
  main: 1,
  attack: 0.5,
  block: 0.25,
  movement: 0.35
});
const COUNTERFACTUAL_HORIZON_TIE_MARGIN = 100;
const COUNTERFACTUAL_NONTERMINAL_SCALE = 2500;
export const COUNTERFACTUAL_ADAPTIVE_ROLLOUT_VERSION = 1;
const COUNTERFACTUAL_ADAPTIVE_STAGE_PLAYER_TURNS = 2;
const COUNTERFACTUAL_ADAPTIVE_MIN_INITIAL_DELTA = 100;
const COUNTERFACTUAL_ADAPTIVE_MIN_STAGE_DELTA = 1250;
const MAX_AUTOPLAY_CHOICE_VARIANTS_PER_ACTION = 16;
const MAX_NESTED_RESOLUTION_CANDIDATES = 16;
const MAX_NESTED_RAW_CANDIDATES = 256;

export const ML_ACTION_MODEL_SCHEMA = "union-arena-local-engine/ml-action-model@1";
export const MATCHUP_OVERLAY_SCHEMA = "union-arena-local-engine/matchup-overlay@1";
export const CONTEXTUAL_ACTION_FEATURE_PREFIX = "context.";
export const MIN_ML_FEATURE_SELECTION_VERSION = 2;
export const MAX_ML_RUNTIME_MODEL_FEATURES = 512;
export const MIN_ML_RUNTIME_CONTEXTUAL_FEATURE_OBSERVATIONS = DEFAULT_CONTEXTUAL_MIN_OBSERVATIONS;
export const MIN_ML_RUNTIME_TRUST = 0.75;
export const MIN_ML_RUNTIME_HELDOUT_GAMES = 8;
export const MIN_ML_RUNTIME_PAIRWISE_EXAMPLES = 30;
export const MIN_ML_PAIRWISE_EFFECTIVE_WEIGHT_VERSION = 1;
export const MIN_ML_RUNTIME_PAIRWISE_EFFECTIVE_WEIGHT = 4;
export const MIN_ML_EVIDENCE_DIVERSITY_VERSION = 2;
export const MIN_ML_RUNTIME_DIVERSITY_EXAMPLES = 30;
export const MIN_ML_RUNTIME_DISTINCT_PHASES = 3;
export const MIN_ML_RUNTIME_DISTINCT_ACTION_PAIRS = 3;
export const MIN_ML_RUNTIME_DISTINCT_OPPONENTS = 2;
export const MAX_ML_RUNTIME_DOMINANT_ACTION_PAIR_RATE = 0.85;
export const MAX_ML_RUNTIME_HISTORICAL_UNCLASSIFIED_EXAMPLES = 0;
export const MIN_ML_TRAINING_PIPELINE_VERSION = 2;
export const MIN_ML_VALIDATION_ASSIGNMENT_VERSION = 2;
export const MIN_ML_VALIDATION_STATE_VERSION = 3;
export const MIN_ML_VALIDATION_DIVERSITY_VERSION = 2;
export const MIN_ML_RUNTIME_VALIDATION_DISTINCT_PHASES = 2;
export const MIN_ML_RUNTIME_VALIDATION_DISTINCT_ACTION_PAIRS = 3;
export const MIN_ML_RUNTIME_VALIDATION_DISTINCT_OPPONENTS = 2;
export const MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_EXAMPLES = 5;
export const MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_GAMES = 2;
export const MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_SIGN_EXAMPLES = 1;
export const MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_ACCURACY = 0.5;
export const MIN_ML_RUNTIME_VALIDATION_BALANCED_ACCURACY = 2 / 3;
export const MIN_ML_RUNTIME_VALIDATION_PAIRWISE_EFFECTIVE_WEIGHT = 1;
export const MAX_ML_RUNTIME_VALIDATION_DOMINANT_ACTION_PAIR_RATE = 0.85;
export const MIN_ML_PAIRWISE_INPUT_CONSISTENCY_VERSION = 1;
export const MIN_ML_RUNTIME_VALIDATION_CONSISTENCY_REPEATED_CONTEXTS = 3;
export const MIN_ML_RUNTIME_VALIDATION_CONSISTENCY_REPEATED_EXAMPLES = 12;
export const MAX_ML_RUNTIME_VALIDATION_INPUT_CONFLICT_RATE = 0.25;
export const MIN_ML_PAIRWISE_ORIENTATION_VERSION = 2;
export const MIN_ML_REGRESSION_VERSION = MULTIVARIATE_RIDGE_VERSION;
export const MIN_LEARNING_SOURCE_DIGEST_VERSION = 1;
export const MIN_LEARNING_EVIDENCE_FILTER_VERSION = LEARNING_EVIDENCE_FILTER_VERSION;
export const MIN_MATCHUP_IMPACT_VALIDATION_GAMES = 12;
export const MIN_MATCHUP_RUNTIME_PAIRWISE_EXAMPLES = 30;
export const MIN_MATCHUP_RUNTIME_PAIRWISE_EFFECTIVE_WEIGHT = 4;
export const MIN_MATCHUP_RUNTIME_DIVERSITY_EXAMPLES = 30;
export const MIN_MATCHUP_RUNTIME_DISTINCT_PHASES = 2;
export const MIN_MATCHUP_RUNTIME_DISTINCT_ACTION_PAIRS = 3;
export const MAX_MATCHUP_RUNTIME_DOMINANT_ACTION_PAIR_RATE = 0.85;
export const COUNTERFACTUAL_STATE_EVALUATION_VERSION = 3;

export function normalizePilotPolicy(policy = {}) {
  const raw = policy?.weights ? policy : { weights: policy ?? {} };
  return {
    schema: raw.schema ?? DEFAULT_PILOT_POLICY.schema,
    name: raw.name ?? DEFAULT_PILOT_POLICY.name,
    weights: {
      ...DEFAULT_PILOT_POLICY.weights,
      ...(raw.weights ?? {})
    }
  };
}

export function normalizeMlActionModel(model = {}) {
  return {
    ...model,
    schema: model.schema ?? ML_ACTION_MODEL_SCHEMA,
    name: model.name ?? "ml-action-model",
    trainedAt: model.trainedAt ?? null,
    examples: Number(model.examples ?? 0),
    selectedExamples: Number(model.selectedExamples ?? 0),
    weights: Object.fromEntries(Object.entries(model.weights ?? {})
      .map(([feature, value]) => [feature, Number(value)])
      .filter(([, value]) => Number.isFinite(value)))
  };
}

function learningSignalTrust(artifact = {}) {
  if (learningArtifactBlocked(artifact)) return 0;
  if (artifact.includeChosenAnchor === true) return 0;
  const version = Number(artifact.learningSignalVersion ?? 1);
  if (version < 2) return 0;
  if (Number(artifact.trainingPipelineVersion ?? 1) < MIN_ML_TRAINING_PIPELINE_VERSION) return 0;
  if (Number(artifact.sourceDigestVersion ?? 0) < MIN_LEARNING_SOURCE_DIGEST_VERSION) return 0;
  if (Number(artifact.learningEvidenceFilterVersion ?? 0) < MIN_LEARNING_EVIDENCE_FILTER_VERSION) return 0;
  if (Number(artifact.regressionVersion ?? 1) < MIN_ML_REGRESSION_VERSION) return 0;
  if (!boundedContextualFeatureSelectionValid(artifact)) return 0;
  if (Number(artifact.counterfactualStateEvaluationVersion ?? 1) < COUNTERFACTUAL_STATE_EVALUATION_VERSION) return 0;
  const trust = Number(artifact.learningSignalTrust ?? 1);
  return clampNumber(trust, 0, 1);
}

export function mlActionModelRuntimeTrust(model = {}) {
  if (learningArtifactBlocked(model)) return 0;
  if (model.includeChosenAnchor === true) return 0;
  if (Number(model.learningSignalVersion ?? 1) < 2) return 0;
  if (Number(model.trainingPipelineVersion ?? 1) < MIN_ML_TRAINING_PIPELINE_VERSION) return 0;
  if (Number(model.sourceDigestVersion ?? 0) < MIN_LEARNING_SOURCE_DIGEST_VERSION) return 0;
  if (Number(model.learningEvidenceFilterVersion ?? 0) < MIN_LEARNING_EVIDENCE_FILTER_VERSION) return 0;
  if (Number(model.regressionVersion ?? 1) < MIN_ML_REGRESSION_VERSION) return 0;
  if (!boundedContextualFeatureSelectionValid(model)) return 0;
  if (Number(model.counterfactualStateEvaluationVersion ?? 1) < COUNTERFACTUAL_STATE_EVALUATION_VERSION) return 0;
  if (Number(model.pairwiseOrientationVersion ?? 1) < MIN_ML_PAIRWISE_ORIENTATION_VERSION) return 0;
  if (Number(model.validationStateVersion ?? 0) < MIN_ML_VALIDATION_STATE_VERSION) return 0;
  const validationAssignmentVersion = Number(
    model.validationAssignmentVersion ?? model.validation?.assignmentKeyVersion ?? 1
  );
  if (validationAssignmentVersion < MIN_ML_VALIDATION_ASSIGNMENT_VERSION) return 0;
  const trust = clampNumber(Number(model.learningSignalTrust ?? 0), 0, 1);
  const heldoutGames = Number(model.validation?.heldoutPlayerGames ?? 0);
  const pairwiseExamples = Number(model.pairwiseExamples ?? 0);
  if (trust < MIN_ML_RUNTIME_TRUST || heldoutGames < MIN_ML_RUNTIME_HELDOUT_GAMES) return 0;
  if (pairwiseExamples < MIN_ML_RUNTIME_PAIRWISE_EXAMPLES) return 0;
  if (Number(model.pairwiseEffectiveWeightVersion ?? 0) < MIN_ML_PAIRWISE_EFFECTIVE_WEIGHT_VERSION) return 0;
  if (Number(model.pairwiseEffectiveWeight ?? 0) < MIN_ML_RUNTIME_PAIRWISE_EFFECTIVE_WEIGHT) return 0;
  const diversity = mlPairwiseEvidenceDiversity(model);
  if (diversity.version < MIN_ML_EVIDENCE_DIVERSITY_VERSION) return 0;
  if (diversity.historicalUnclassifiedExamples > MAX_ML_RUNTIME_HISTORICAL_UNCLASSIFIED_EXAMPLES) return 0;
  if (diversity.trackedExamples < MIN_ML_RUNTIME_DIVERSITY_EXAMPLES) return 0;
  if (diversity.distinctPhases < MIN_ML_RUNTIME_DISTINCT_PHASES) return 0;
  if (diversity.distinctActionPairs < MIN_ML_RUNTIME_DISTINCT_ACTION_PAIRS) return 0;
  if (diversity.distinctOpponentProfiles < MIN_ML_RUNTIME_DISTINCT_OPPONENTS) return 0;
  if (diversity.dominantActionPairRate > MAX_ML_RUNTIME_DOMINANT_ACTION_PAIR_RATE) return 0;
  const validationDiversity = mlValidationEvidenceDiversity(model);
  const validationConsistency = mlValidationInputConsistency(model);
  const pairwiseValidation = model.validation?.pairwise ?? {};
  if (Number(model.validation?.fraction ?? 0) <= 0) return 0;
  if (Number(pairwiseValidation.examples ?? 0) < MIN_ML_RUNTIME_PAIRWISE_EXAMPLES) return 0;
  if (Number(pairwiseValidation.weightTotal ?? 0) < MIN_ML_RUNTIME_VALIDATION_PAIRWISE_EFFECTIVE_WEIGHT) return 0;
  if (Number(pairwiseValidation.positiveExamples ?? 0) < 3 || Number(pairwiseValidation.negativeExamples ?? 0) < 3) return 0;
  if (Number(pairwiseValidation.balancedSignAccuracy) < MIN_ML_RUNTIME_VALIDATION_BALANCED_ACCURACY) return 0;
  if (validationDiversity.version < MIN_ML_VALIDATION_DIVERSITY_VERSION) return 0;
  if (validationDiversity.distinctPlayerGames < MIN_ML_RUNTIME_HELDOUT_GAMES) return 0;
  if (validationDiversity.distinctPhases < MIN_ML_RUNTIME_VALIDATION_DISTINCT_PHASES) return 0;
  if (validationDiversity.distinctActionPairs < MIN_ML_RUNTIME_VALIDATION_DISTINCT_ACTION_PAIRS) return 0;
  if (validationDiversity.distinctOpponentProfiles < MIN_ML_RUNTIME_VALIDATION_DISTINCT_OPPONENTS) return 0;
  if (validationDiversity.dominantActionPairRate > MAX_ML_RUNTIME_VALIDATION_DOMINANT_ACTION_PAIR_RATE) return 0;
  if (validationDiversity.supportedActionPairs < MIN_ML_RUNTIME_VALIDATION_DISTINCT_ACTION_PAIRS) return 0;
  if (validationDiversity.weakSupportedActionPairs > 0) return 0;
  if (validationDiversity.singleGameSupportedActionPairs > 0) return 0;
  if (validationDiversity.oneSidedSupportedActionPairs > 0) return 0;
  if (validationConsistency.version < MIN_ML_PAIRWISE_INPUT_CONSISTENCY_VERSION) return 0;
  if (!validationConsistency.complete) return 0;
  if (validationConsistency.gateEligible
    && validationConsistency.conflictRate > MAX_ML_RUNTIME_VALIDATION_INPUT_CONFLICT_RATE) return 0;
  return trust;
}

export function mlPairwiseEvidenceDiversity(model = {}) {
  return pairwiseEvidenceDiversitySummary(model, { requireOpponentCounts: true });
}

export function matchupPairwiseEvidenceDiversity(overlay = {}) {
  return pairwiseEvidenceDiversitySummary(overlay, { requireOpponentCounts: false });
}

export function mlValidationEvidenceDiversity(model = {}) {
  const raw = model?.validation?.pairwise?.validationDiversity ?? {};
  const phaseCounts = normalizedEvidenceCounts(raw.phaseCounts);
  const actionPairCounts = normalizedEvidenceCounts(raw.actionPairCounts);
  const opponentProfileCounts = normalizedEvidenceCounts(raw.opponentProfileCounts);
  const playerGameCounts = normalizedEvidenceCounts(raw.playerGameCounts);
  const phaseTotal = evidenceCountTotal(phaseCounts);
  const actionPairTotal = evidenceCountTotal(actionPairCounts);
  const opponentTotal = evidenceCountTotal(opponentProfileCounts);
  const playerGameTotal = evidenceCountTotal(playerGameCounts);
  const declaredTracked = Math.max(0, Math.floor(Number(raw.trackedExamples ?? 0)));
  const trackedExamples = Math.min(declaredTracked, phaseTotal, actionPairTotal, opponentTotal, playerGameTotal);
  const dominantActionPair = dominantEvidenceEntry(actionPairCounts);
  const dominantPlayerGame = dominantEvidenceEntry(playerGameCounts);
  const actionPairReliability = (raw.actionPairReliability ?? [])
    .map((row) => ({
      key: String(row?.key ?? ""),
      examples: Math.max(0, Math.floor(Number(row?.examples ?? 0))),
      weightTotal: Math.max(0, Number(row?.weightTotal ?? 0)),
      signAccuracy: Number(row?.signAccuracy),
      balancedSignAccuracy: row?.balancedSignAccuracy === null || row?.balancedSignAccuracy === undefined
        ? null
        : Number(row.balancedSignAccuracy),
      positiveExamples: Math.max(0, Math.floor(Number(row?.positiveExamples ?? 0))),
      negativeExamples: Math.max(0, Math.floor(Number(row?.negativeExamples ?? 0))),
      distinctPlayerGames: Math.max(0, Math.floor(Number(row?.distinctPlayerGames ?? 0)))
    }))
    .filter((row) => row.key && row.examples > 0 && Number.isFinite(row.signAccuracy));
  const supported = actionPairReliability.filter((row) => row.examples >= MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_EXAMPLES);
  return {
    version: Number(raw.version ?? 0),
    trackedExamples,
    distinctPlayerGames: distinctKnownEvidenceCount(playerGameCounts),
    distinctPhases: distinctKnownEvidenceCount(phaseCounts),
    distinctActionPairs: Object.keys(actionPairCounts).length,
    distinctOpponentProfiles: distinctKnownEvidenceCount(opponentProfileCounts),
    dominantActionPair: dominantActionPair?.key ?? null,
    dominantActionPairCount: dominantActionPair?.count ?? 0,
    dominantActionPairRate: actionPairTotal > 0 ? (dominantActionPair?.count ?? 0) / actionPairTotal : 1,
    dominantPlayerGame: dominantPlayerGame?.key ?? null,
    dominantPlayerGameCount: dominantPlayerGame?.count ?? 0,
    dominantPlayerGameRate: playerGameTotal > 0 ? (dominantPlayerGame?.count ?? 0) / playerGameTotal : 1,
    supportedActionPairs: supported.length,
    weakSupportedActionPairs: supported.filter((row) => row.signAccuracy < MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_ACCURACY).length,
    singleGameSupportedActionPairs: supported.filter((row) => row.distinctPlayerGames < MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_GAMES).length,
    oneSidedSupportedActionPairs: supported.filter((row) => (
      row.positiveExamples < MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_SIGN_EXAMPLES
      || row.negativeExamples < MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_SIGN_EXAMPLES
    )).length,
    weakestSupportedActionPairAccuracy: supported.length > 0
      ? Math.min(...supported.map((row) => row.signAccuracy))
      : null,
    phaseCounts,
    actionPairCounts,
    opponentProfileCounts,
    playerGameCounts,
    actionPairReliability
  };
}

export function mlValidationInputConsistency(model = {}) {
  const raw = model?.validation?.pairwise?.inputConsistency ?? {};
  const repeatedContexts = Math.max(0, Math.floor(Number(raw.repeatedContexts ?? 0)));
  const repeatedExamples = Math.max(0, Math.floor(Number(raw.repeatedExamples ?? 0)));
  const repeatedWeight = Math.max(0, Number(raw.repeatedWeight ?? 0));
  const minorityWeight = Math.max(0, Number(raw.minorityWeight ?? 0));
  const declaredConflictRate = Number(raw.conflictRate);
  const conflictRate = Number.isFinite(declaredConflictRate)
    ? clampNumber(declaredConflictRate, 0, 0.5)
    : repeatedWeight > 0 ? clampNumber(minorityWeight / repeatedWeight, 0, 0.5) : 0;
  const gateEligible = repeatedContexts >= MIN_ML_RUNTIME_VALIDATION_CONSISTENCY_REPEATED_CONTEXTS
    && repeatedExamples >= MIN_ML_RUNTIME_VALIDATION_CONSISTENCY_REPEATED_EXAMPLES;
  return {
    version: Number(raw.version ?? model?.pairwiseInputConsistencyVersion ?? 0),
    complete: raw.complete !== false,
    trackedExamples: Math.max(0, Math.floor(Number(raw.trackedExamples ?? 0))),
    contexts: Math.max(0, Math.floor(Number(raw.contexts ?? 0))),
    repeatedContexts,
    repeatedExamples,
    repeatedWeight,
    conflictingContexts: Math.max(0, Math.floor(Number(raw.conflictingContexts ?? 0))),
    minorityWeight,
    conflictRate,
    maximumAttainableRepeatedAccuracy: 1 - conflictRate,
    gateEligible,
    unsafe: gateEligible && conflictRate > MAX_ML_RUNTIME_VALIDATION_INPUT_CONFLICT_RATE
  };
}

function pairwiseEvidenceDiversitySummary(model = {}, { requireOpponentCounts = true } = {}) {
  const raw = model?.pairwiseEvidenceDiversity ?? {};
  const phaseCounts = normalizedEvidenceCounts(raw.phaseCounts);
  const actionPairCounts = normalizedEvidenceCounts(raw.actionPairCounts);
  const opponentProfileCounts = normalizedEvidenceCounts(raw.opponentProfileCounts);
  const phaseTotal = evidenceCountTotal(phaseCounts);
  const actionPairTotal = evidenceCountTotal(actionPairCounts);
  const opponentTotal = evidenceCountTotal(opponentProfileCounts);
  const declaredTracked = Math.max(0, Math.floor(Number(raw.trackedExamples ?? 0)));
  const trackedExamples = Math.min(
    declaredTracked,
    phaseTotal,
    actionPairTotal,
    requireOpponentCounts ? opponentTotal : declaredTracked
  );
  const dominantActionPair = dominantEvidenceEntry(actionPairCounts);
  return {
    version: Number(model?.evidenceDiversityVersion ?? raw.version ?? 0),
    trackedExamples,
    historicalUnclassifiedExamples: Math.max(0, Math.floor(Number(raw.historicalUnclassifiedExamples ?? 0))),
    distinctPhases: distinctKnownEvidenceCount(phaseCounts),
    distinctActionPairs: Object.keys(actionPairCounts).length,
    distinctOpponentProfiles: distinctKnownEvidenceCount(opponentProfileCounts),
    dominantActionPair: dominantActionPair?.key ?? null,
    dominantActionPairCount: dominantActionPair?.count ?? 0,
    dominantActionPairRate: actionPairTotal > 0 ? (dominantActionPair?.count ?? 0) / actionPairTotal : 1,
    phaseCounts,
    actionPairCounts,
    opponentProfileCounts
  };
}

function normalizedEvidenceCounts(raw = {}) {
  return Object.fromEntries(Object.entries(raw ?? {})
    .map(([key, value]) => [String(key), Math.max(0, Math.floor(Number(value ?? 0)))])
    .filter(([key, value]) => key && Number.isFinite(value) && value > 0));
}

function evidenceCountTotal(counts = {}) {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}

function distinctKnownEvidenceCount(counts = {}) {
  return Object.keys(counts).filter((key) => key !== "unknown").length;
}

function dominantEvidenceEntry(counts = {}) {
  return Object.entries(counts).reduce((best, [key, count]) => {
    if (!best || count > best.count || (count === best.count && key.localeCompare(best.key) < 0)) {
      return { key, count };
    }
    return best;
  }, null);
}

function learningArtifactBlocked(artifact = {}) {
  const status = String(artifact.learningHealth?.status ?? artifact.learningHealthStatus ?? "").toLowerCase();
  const samplingStatus = String(
    artifact.samplingSafety?.status ?? artifact.learningHealth?.samplingSafety?.status ?? ""
  ).toLowerCase();
  return status === "blocked" || samplingStatus === "blocked";
}

export function blendPilotPolicyWithMlModel(policy = {}, model = {}, { strength = 1, name = null } = {}) {
  const normalizedPolicy = normalizePilotPolicy(policy);
  const normalizedModel = normalizeMlActionModel(model);
  const trustedStrength = Number(strength ?? 1) * mlActionModelRuntimeTrust(normalizedModel);
  const featureNames = new Set([
    ...Object.keys(normalizedPolicy.weights),
    ...Object.keys(normalizedModel.weights)
  ]);
  const weights = {};
  for (const feature of featureNames) {
    weights[feature] = Number(normalizedPolicy.weights[feature] ?? 0)
      + Math.round(Number(normalizedModel.weights[feature] ?? 0) * trustedStrength);
  }
  return {
    schema: DEFAULT_PILOT_POLICY.schema,
    name: name ?? `${normalizedPolicy.name}+${normalizedModel.name}`,
    weights
  };
}

export function removeMlModelFromPilotPolicy(policy = {}, model = {}, { strength = 1, name = null } = {}) {
  const normalizedPolicy = normalizePilotPolicy(policy);
  const normalizedModel = normalizeMlActionModel(model);
  const trustedStrength = Number(strength ?? 1) * mlActionModelRuntimeTrust(normalizedModel);
  const featureNames = new Set([
    ...Object.keys(normalizedPolicy.weights),
    ...Object.keys(normalizedModel.weights)
  ]);
  const weights = {};
  for (const feature of featureNames) {
    weights[feature] = Number(normalizedPolicy.weights[feature] ?? 0)
      - Math.round(Number(normalizedModel.weights[feature] ?? 0) * trustedStrength);
  }
  return {
    schema: DEFAULT_PILOT_POLICY.schema,
    name: name ?? normalizedPolicy.name,
    weights
  };
}

export function normalizeMatchupOverlay(overlay = {}) {
  return {
    ...overlay,
    schema: overlay.schema ?? MATCHUP_OVERLAY_SCHEMA,
    name: overlay.name ?? "matchup-overlay",
    ownKey: overlay.ownKey ?? null,
    opponentKey: overlay.opponentKey ?? null,
    weights: Object.fromEntries(Object.entries(overlay.weights ?? {})
      .map(([feature, value]) => [feature, Number(value)])
      .filter(([, value]) => Number.isFinite(value)))
  };
}

export function normalizeMatchupDeckFingerprints(fingerprints = []) {
  return (fingerprints ?? [])
    .map((fingerprint) => {
      const rawCounts = fingerprint.cardCounts ?? Object.fromEntries((fingerprint.cards ?? [])
        .map((entry) => [entry.id, Number(entry.count ?? 1)]));
      const cardCounts = Object.fromEntries(Object.entries(rawCounts)
        .map(([cardId, count]) => [cardId, Number(count)])
        .filter(([cardId, count]) => cardId && Number.isFinite(count) && count > 0));
      const totalCards = Object.values(cardCounts).reduce((total, count) => total + count, 0);
      if (!fingerprint.id || totalCards === 0) return null;
      return {
        id: fingerprint.id,
        name: fingerprint.name ?? fingerprint.id,
        key: normalizeProfileSegment(fingerprint.key ?? `${fingerprint.sourceCode ?? "unknown"}-${fingerprint.colorKey ?? "unknown"}`),
        setColorKey: normalizeProfileSegment(fingerprint.setColorKey ?? `${fingerprint.sourceCode ?? "unknown"}-${fingerprint.colorKey ?? "unknown"}`),
        sourceCode: fingerprint.sourceCode ?? null,
        colors: [...new Set(fingerprint.colors ?? [])].map(normalizeProfileSegment).filter(Boolean),
        colorKey: normalizeProfileSegment(fingerprint.colorKey ?? (fingerprint.colors ?? []).join("-") ?? "unknown"),
        cardCounts,
        totalCards
      };
    })
    .filter(Boolean);
}

export function blendPilotPolicyWithMatchupOverlay(policy = {}, overlay = {}, {
  strength = 1,
  confidence = 1,
  name = null,
  allowUnvalidated = false
} = {}) {
  const normalizedPolicy = normalizePilotPolicy(policy);
  const normalizedOverlay = normalizeMatchupOverlay(overlay);
  const multiplier = Number(strength ?? 1)
    * Number(confidence ?? 1)
    * matchupOverlayRuntimeTrust(normalizedOverlay, { allowUnvalidated });
  const weights = { ...normalizedPolicy.weights };
  for (const [feature, value] of Object.entries(normalizedOverlay.weights)) {
    weights[feature] = Math.round(Number(weights[feature] ?? 0) + Number(value) * multiplier);
  }
  return {
    schema: DEFAULT_PILOT_POLICY.schema,
    name: name ?? `${normalizedPolicy.name}+${normalizedOverlay.name}`,
    weights
  };
}

export function matchupOverlayArtifactSignature(overlay = {}) {
  const stable = JSON.stringify({
    trainedAt: overlay.trainedAt ?? null,
    ownKey: overlay.ownKey ?? null,
    opponentKey: overlay.opponentKey ?? null,
    examples: Number(overlay.examples ?? 0),
    pairwiseExamples: Number(overlay.pairwiseExamples ?? 0),
    trainingPipelineVersion: Number(overlay.trainingPipelineVersion ?? 1),
    sourceDigestVersion: Number(overlay.sourceDigestVersion ?? 0),
    learningEvidenceFilterVersion: Number(overlay.learningEvidenceFilterVersion ?? 0),
    regressionVersion: Number(overlay.regressionVersion ?? 1),
    counterfactualStateEvaluationVersion: Number(overlay.counterfactualStateEvaluationVersion ?? 1),
    pairwiseEffectiveWeightVersion: Number(overlay.pairwiseEffectiveWeightVersion ?? 0),
    pairwiseEffectiveWeight: Number(overlay.pairwiseEffectiveWeight ?? 0),
    evidenceDiversityVersion: Number(overlay.evidenceDiversityVersion ?? overlay.pairwiseEvidenceDiversity?.version ?? 0),
    pairwiseEvidenceDiversity: overlay.pairwiseEvidenceDiversity ?? null,
    featureSelection: overlay.featureSelection ?? null,
    weights: Object.fromEntries(Object.entries(overlay.weights ?? {}).sort(([left], [right]) => left.localeCompare(right)))
  });
  let hash = 2166136261;
  for (let index = 0; index < stable.length; index += 1) {
    hash ^= stable.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function boundedContextualFeatureSelectionValid(artifact = {}) {
  const featureNames = Object.keys(artifact?.weights ?? {});
  const contextualFeatures = featureNames
    .filter((feature) => feature.startsWith(CONTEXTUAL_ACTION_FEATURE_PREFIX))
    .sort((left, right) => left.localeCompare(right));
  if (contextualFeatures.length === 0) return featureNames.length <= MAX_ML_RUNTIME_MODEL_FEATURES;
  const selection = artifact?.featureSelection;
  if (Number(selection?.version ?? 0) < MIN_ML_FEATURE_SELECTION_VERSION) return false;
  const maxFeatures = Number(selection?.maxFeatures);
  if (!Number.isFinite(maxFeatures) || maxFeatures < 1 || maxFeatures > MAX_ML_RUNTIME_MODEL_FEATURES) return false;
  if (featureNames.length > MAX_ML_RUNTIME_MODEL_FEATURES) return false;
  if (Number(selection.selected ?? -1) !== featureNames.length) return false;
  if (Number(selection.contextualSelected ?? -1) !== contextualFeatures.length) return false;
  if (Number(selection.structuralSelected ?? -1) !== featureNames.length - contextualFeatures.length) return false;
  if (Number(selection.eligible ?? -1) < featureNames.length) return false;
  const contextualMinimum = Number(artifact?.minContextualObservations ?? selection?.contextualMinObservations ?? 0);
  if (contextualMinimum < MIN_ML_RUNTIME_CONTEXTUAL_FEATURE_OBSERVATIONS) return false;
  if (Number(selection.contextualMinObservations ?? 0) !== contextualMinimum) return false;
  if (contextualFeatures.some((feature) => (
    Number(artifact?.featureStats?.[feature]?.observations ?? 0) < contextualMinimum
  ))) return false;
  const declaredContextual = [...new Set(selection.selectedContextualFeatures ?? [])]
    .sort((left, right) => left.localeCompare(right));
  return declaredContextual.length === contextualFeatures.length
    && declaredContextual.every((feature, index) => feature === contextualFeatures[index]);
}

export function matchupOverlayRuntimeTrust(overlay = {}, { allowUnvalidated = false } = {}) {
  const trust = learningSignalTrust(overlay);
  if (trust < MIN_ML_RUNTIME_TRUST) return 0;
  if (Number(overlay.pairwiseExamples ?? 0) < MIN_MATCHUP_RUNTIME_PAIRWISE_EXAMPLES) return 0;
  if (Number(overlay.pairwiseEffectiveWeightVersion ?? 0) < MIN_ML_PAIRWISE_EFFECTIVE_WEIGHT_VERSION) return 0;
  if (Number(overlay.pairwiseEffectiveWeight ?? 0) < MIN_MATCHUP_RUNTIME_PAIRWISE_EFFECTIVE_WEIGHT) return 0;
  const diversity = matchupPairwiseEvidenceDiversity(overlay);
  if (diversity.version < MIN_ML_EVIDENCE_DIVERSITY_VERSION) return 0;
  if (diversity.historicalUnclassifiedExamples > MAX_ML_RUNTIME_HISTORICAL_UNCLASSIFIED_EXAMPLES) return 0;
  if (diversity.trackedExamples < MIN_MATCHUP_RUNTIME_DIVERSITY_EXAMPLES) return 0;
  if (diversity.distinctPhases < MIN_MATCHUP_RUNTIME_DISTINCT_PHASES) return 0;
  if (diversity.distinctActionPairs < MIN_MATCHUP_RUNTIME_DISTINCT_ACTION_PAIRS) return 0;
  if (diversity.dominantActionPairRate > MAX_MATCHUP_RUNTIME_DOMINANT_ACTION_PAIR_RATE) return 0;
  if (allowUnvalidated) return trust;
  const validation = overlay.impactValidation;
  if (String(validation?.verdict ?? "").toLowerCase() !== "positive") return 0;
  if (Number(validation?.pairedGames ?? 0) < MIN_MATCHUP_IMPACT_VALIDATION_GAMES) return 0;
  if (validation?.artifactSignature !== matchupOverlayArtifactSignature(overlay)) return 0;
  return trust;
}

export function stampMatchupOverlayImpactValidation(overlay = {}, validation = {}) {
  if (String(validation.verdict ?? "").toLowerCase() !== "positive") {
    throw new Error("Only a positive matchup-impact result can validate an overlay.");
  }
  if (Number(validation.pairedGames ?? 0) < MIN_MATCHUP_IMPACT_VALIDATION_GAMES) {
    throw new Error(`Matchup overlay validation requires at least ${MIN_MATCHUP_IMPACT_VALIDATION_GAMES} paired games.`);
  }
  if (matchupOverlayRuntimeTrust(overlay, { allowUnvalidated: true }) <= 0) {
    throw new Error("Matchup overlay does not have enough causal evidence breadth and effective weight for runtime validation.");
  }
  return {
    ...overlay,
    impactValidation: {
      schema: "union-arena-local-engine/matchup-overlay-impact-validation@1",
      verdict: "positive",
      validatedAt: validation.validatedAt ?? new Date().toISOString(),
      pairedGames: Number(validation.pairedGames),
      winRateDelta: Number(validation.winRateDelta ?? 0),
      avgLifeDiffDelta: Number(validation.avgLifeDiffDelta ?? 0),
      scoreDelta: Number(validation.scoreDelta ?? 0),
      directionalOutcomeP: Number(validation.directionalOutcomeP ?? 1),
      gate: validation.gate ?? null,
      validationPath: validation.validationPath ?? validation.path ?? null,
      artifactSignature: matchupOverlayArtifactSignature(overlay)
    }
  };
}

export function publicOpponentProfile(state, playerId, {
  deckFingerprints = [],
  knownDeckVariants = false,
  variantMinDeckConfidence = 0.55,
  variantMinObservedCoverage = 0.75,
  unknownVariantMinEvidence = 4
} = {}) {
  const opponentId = opponentOf(playerId);
  const evidence = publicCardDefIdsForPlayer(state, playerId, opponentId)
    .map((defId) => state.catalog[defId])
    .filter(Boolean)
    .map((def) => ({
      id: def.id,
      sourceCode: sourceCodeForDef(def),
      color: normalizeProfileSegment(def.color ?? def.requiredEnergy?.color ?? "unknown"),
      requiredEnergy: Number(def.requiredEnergy?.amount ?? 0),
      type: def.type
    }))
    .filter((item) => item.sourceCode && item.color);
  const counts = new Map();
  for (const item of evidence) {
    const key = `${normalizeProfileSegment(item.sourceCode)}-${normalizeProfileSegment(item.color)}`;
    const current = counts.get(key) ?? {
      key,
      sourceCode: normalizeProfileSegment(item.sourceCode).toUpperCase(),
      colors: [normalizeProfileSegment(item.color)],
      colorKey: normalizeProfileSegment(item.color),
      count: 0
    };
    current.count += 1;
    counts.set(key, current);
  }

  const candidates = [...counts.values()]
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const best = candidates[0] ?? null;
  const totalEvidence = evidence.length;
  const confidence = best && totalEvidence > 0 ? best.count / totalEvidence : 0;
  const observedCardIds = [...new Set(evidence.map((item) => item.id).filter(Boolean))].sort();
  const observedLowCostCardIds = [...new Set(evidence
    .filter((item) => item.type === CARD_TYPES.CHARACTER && item.requiredEnergy <= 1)
    .map((item) => item.id)
    .filter(Boolean))]
    .sort();
  const deckCandidates = inferDeckCandidatesFromEvidence(evidence, deckFingerprints, best?.key ?? "unknown");
  const bestDeck = deckCandidates[0] ?? null;
  const variant = inferOpponentVariantFromEvidence({
    profileKey: best?.key ?? "unknown",
    evidence,
    observedCardIds,
    observedLowCostCardIds,
    bestDeck,
    knownDeckVariants,
    variantMinDeckConfidence,
    variantMinObservedCoverage,
    unknownVariantMinEvidence
  });

  return {
    playerId,
    opponentId,
    known: Boolean(best),
    sourceCode: best?.sourceCode ?? null,
    colors: best?.colors ?? [],
    colorKey: best?.colorKey ?? "unknown",
    key: best?.key ?? "unknown",
    confidence,
    evidenceCount: totalEvidence,
    observedCardIds,
    observedLowCostCardIds,
    deckCandidateId: bestDeck?.id ?? null,
    deckCandidateName: bestDeck?.name ?? null,
    deckCandidateConfidence: bestDeck?.confidence ?? 0,
    deckCandidates,
    variantKey: variant.key,
    variantStatus: variant.status,
    variantConfidence: variant.confidence,
    variantSignature: variant.signature,
    variantCardIds: variant.cardIds,
    variantReason: variant.reason,
    candidates: candidates.map((candidate) => ({
      ...candidate,
      confidence: totalEvidence > 0 ? candidate.count / totalEvidence : 0
    }))
  };
}

function inferOpponentVariantFromEvidence({
  profileKey,
  evidence,
  observedCardIds,
  observedLowCostCardIds,
  bestDeck,
  knownDeckVariants,
  variantMinDeckConfidence,
  variantMinObservedCoverage,
  unknownVariantMinEvidence
}) {
  if (!profileKey || profileKey === "unknown") {
    return {
      key: "unknown",
      status: "unknown",
      confidence: 0,
      signature: null,
      cardIds: [],
      reason: "no-public-profile"
    };
  }

  const knownDeckConfidence = Number(bestDeck?.confidence ?? 0);
  const knownDeckCoverage = Number(bestDeck?.observedCoverage ?? 0);
  if (bestDeck
    && bestDeck.setColorKey === profileKey
    && bestDeck.key
    && bestDeck.key !== profileKey
    && Number(bestDeck.missing ?? 0) === 0
    && knownDeckConfidence >= Number(variantMinDeckConfidence ?? 0.55)
    && knownDeckCoverage >= Number(variantMinObservedCoverage ?? 0.75)) {
    return {
      key: bestDeck.key,
      status: "known-archetype",
      confidence: Math.min(1, knownDeckConfidence * knownDeckCoverage),
      signature: normalizeProfileSegment(bestDeck.key),
      cardIds: bestDeck.matchedCardIds ?? observedCardIds,
      reason: "saved-archetype-fingerprint"
    };
  }

  if (bestDeck
    && bestDeck.key === profileKey
    && Number(bestDeck.missing ?? 0) === 0
    && knownDeckConfidence >= Number(variantMinDeckConfidence ?? 0.55)
    && knownDeckCoverage >= Number(variantMinObservedCoverage ?? 0.75)) {
    if (!knownDeckVariants) {
      return {
        key: profileKey,
        status: "broad",
        confidence: 0,
        signature: null,
        cardIds: bestDeck.matchedCardIds ?? observedCardIds,
        reason: "saved-deck-fingerprint-not-distinct"
      };
    }
    return {
      key: `${profileKey}__deck-${normalizeProfileSegment(bestDeck.id)}`,
      status: "known-deck",
      confidence: Math.min(1, knownDeckConfidence * knownDeckCoverage),
      signature: normalizeProfileSegment(bestDeck.id),
      cardIds: bestDeck.matchedCardIds ?? observedCardIds,
      reason: "saved-deck-fingerprint"
    };
  }

  const signatureCardIds = variantSignatureCardIds(evidence, observedLowCostCardIds, observedCardIds);
  if (bestDeck
    && Number(bestDeck.missing ?? 0) > 0
    && evidence.length >= Number(unknownVariantMinEvidence ?? 4)
    && signatureCardIds.length > 0) {
    const signature = shortStableHash(signatureCardIds);
    return {
      key: `${profileKey}__unknown-${signature}`,
      status: "unknown-variant",
      confidence: 0.5,
      signature,
      cardIds: signatureCardIds,
      reason: "observed-cards-do-not-fit-saved-fingerprint"
    };
  }

  return {
    key: profileKey,
    status: "broad",
    confidence: 0,
    signature: null,
    cardIds: [],
    reason: "insufficient-variant-evidence"
  };
}

function variantSignatureCardIds(evidence, observedLowCostCardIds, observedCardIds) {
  const lowCost = [...new Set(observedLowCostCardIds)].sort();
  const distinctive = [...new Set(evidence
    .filter((item) => item.requiredEnergy >= 2 || item.type !== CARD_TYPES.CHARACTER)
    .map((item) => item.id)
    .filter(Boolean))]
    .sort();
  const fallback = [...new Set(observedCardIds)].sort();
  const selected = lowCost.length > 0
    ? [...lowCost, ...distinctive.filter((id) => !lowCost.includes(id))]
    : fallback;
  return selected.slice(0, 8);
}

function shortStableHash(values) {
  let hash = 2166136261;
  const text = values.join("|");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function inferDeckCandidatesFromEvidence(evidence, fingerprints, profileKey) {
  const normalizedFingerprints = normalizeMatchupDeckFingerprints(fingerprints);
  if (evidence.length === 0 || normalizedFingerprints.length === 0) return [];
  const observedCounts = new Map();
  for (const item of evidence) {
    if (!item.id) continue;
    observedCounts.set(item.id, (observedCounts.get(item.id) ?? 0) + 1);
  }
  const observedTotal = [...observedCounts.values()].reduce((total, count) => total + count, 0);
  if (observedTotal === 0) return [];

  const scored = normalizedFingerprints.map((fingerprint) => {
    let matched = 0;
    let missing = 0;
    const matchedCardIds = [];
    const missingCardIds = [];
    for (const [cardId, count] of observedCounts) {
      const available = Number(fingerprint.cardCounts[cardId] ?? 0);
      if (available > 0) {
        matched += Math.min(count, available);
        matchedCardIds.push(cardId);
      } else {
        missing += count;
        missingCardIds.push(cardId);
      }
    }
    const profileBonus = profileKey !== "unknown" && (fingerprint.key === profileKey || fingerprint.setColorKey === profileKey) ? 0.25 : 0;
    const score = matched - missing * 2 + profileBonus;
    return {
      id: fingerprint.id,
      name: fingerprint.name,
      key: fingerprint.key,
      setColorKey: fingerprint.setColorKey,
      sourceCode: fingerprint.sourceCode,
      colors: fingerprint.colors,
      colorKey: fingerprint.colorKey,
      matched,
      missing,
      observedCoverage: observedTotal > 0 ? matched / observedTotal : 0,
      score,
      matchedCardIds: matchedCardIds.sort(),
      missingCardIds: missingCardIds.sort()
    };
  })
    .sort((a, b) => b.score - a.score
      || b.observedCoverage - a.observedCoverage
      || a.missing - b.missing
      || a.id.localeCompare(b.id));

  const topScore = scored[0]?.score ?? 0;
  const weights = scored.map((candidate) => Math.exp(Math.max(-20, Math.min(20, candidate.score - topScore))));
  const totalWeight = weights.reduce((total, weight) => total + weight, 0) || 1;

  return scored.slice(0, 8).map((candidate, index) => ({
    ...candidate,
    confidence: weights[index] / totalWeight
  }));
}

export function describePilotPolicy(policy = {}) {
  const normalized = normalizePilotPolicy(policy);
  return Object.entries(normalized.weights)
    .map(([feature, weight]) => ({
      feature,
      weight,
      deltaFromBaseline: Number(weight) - Number(DEFAULT_PILOT_POLICY.weights[feature] ?? 0)
    }))
    .sort((a, b) => Math.abs(b.deltaFromBaseline) - Math.abs(a.deltaFromBaseline) || a.feature.localeCompare(b.feature));
}

export function randomSeed() {
  return Math.floor(Math.random() * 0x100000000);
}

export function resolveSeed({ seed, randomize = false, iteration = 0 } = {}) {
  if (randomize) return randomSeed();
  if (seed !== undefined && seed !== null) return Number(seed) + iteration;
  return 1 + iteration;
}

export function createSimulationGame({
  catalog,
  decks,
  seed,
  randomize = false,
  iteration = 0,
  skipShuffle = false,
  validateDecks = true,
  firstPlayer = "P1",
  setupMode = "auto"
}) {
  const resolvedSeed = resolveSeed({ seed, randomize, iteration });
  return {
    seed: resolvedSeed,
    state: createGame({
      catalog,
      decks,
      firstPlayer,
      seed: resolvedSeed,
      skipShuffle,
      validateDecks,
      setupMode
    })
  };
}

export function summarizeGameState(state) {
  return {
    phase: state.phase,
    activePlayer: state.activePlayer,
    winner: state.winner,
    pendingAttack: state.pendingAttack,
    players: Object.fromEntries(Object.entries(state.players).map(([playerId, player]) => [
      playerId,
      {
        hand: player.hand.length,
        life: player.life.length,
        deck: player.deck.length,
        frontLine: player.frontLine.length,
        energyLine: player.energyLine.length,
        sideline: player.sideline.length,
        removal: player.removal.length,
        apCards: player.apCards.length,
        activeAp: player.apCards.filter((ap) => !ap.rested).length,
        legalActions: legalActions(state, playerId).length
      }
    ]))
  };
}

export function analyzeSetupHand(state, playerId) {
  const player = state.players[playerId];
  const initialDefIds = player.initialHandDefIds ?? player.hand.map((card) => card.defId);
  const finalDefIds = player.keptHandDefIds
    ?? player.mulliganHandDefIds
    ?? initialDefIds;
  const initialZeroCostUnits = countSetupZeroCostUnits(state, initialDefIds);
  const finalZeroCostUnits = countSetupZeroCostUnits(state, finalDefIds);

  return {
    initialHandSize: initialDefIds.length,
    finalHandSize: finalDefIds.length,
    initialSetupOpenersSeen: initialZeroCostUnits,
    finalSetupOpenersSeen: finalZeroCostUnits,
    initialZeroCostUnitsSeen: initialZeroCostUnits,
    finalZeroCostUnitsSeen: finalZeroCostUnits,
    initialBricked: initialZeroCostUnits === 0,
    bricked: finalZeroCostUnits === 0
  };
}

export function setupHandFeatures(state, playerId) {
  const player = state.players[playerId];
  const cards = player.hand
    .map((card) => ({ card, def: state.catalog[card.defId] }))
    .filter(({ def }) => Boolean(def));
  const characters = cards.filter(({ def }) => def.type === CARD_TYPES.CHARACTER);
  const setupCosts = characters.map(({ def }) => ({
    def,
    baseCost: Number(def.requiredEnergy?.amount ?? 0),
    setupCost: setupRequiredEnergyForCardUse(def)
  }));
  const zeroCostUnits = setupCosts.filter(({ setupCost }) => setupCost === 0);
  const reducerOpeners = setupCosts.filter(({ baseCost, setupCost }) => baseCost > 0 && setupCost === 0);
  const lowCostUnits = setupCosts.filter(({ setupCost }) => setupCost <= 1);
  const earlyCharacters = setupCosts.filter(({ setupCost }) => setupCost <= 2);
  const events = cards.filter(({ def }) => def.type === CARD_TYPES.EVENT);
  const highCostCards = cards.filter(({ def }) => {
    return Number(def.requiredEnergy?.amount ?? 0) >= 4 || Number(def.apCost ?? 0) >= 2;
  });
  const energyColors = new Set(cards.flatMap(({ def }) => {
    return (def.energy ?? []).filter((icon) => Number(icon.amount ?? 0) > 0).map((icon) => icon.color).filter(Boolean);
  }));
  const requiredColors = new Set(cards.map(({ def }) => def.requiredEnergy?.color).filter(Boolean));
  const matchedColors = [...requiredColors].filter((color) => energyColors.has(color)).length;
  const apCostTotal = cards.reduce((total, { def }) => total + Number(def.apCost ?? 0), 0);
  const energyPotential = setupEnergyPotential(cards);
  const hasEnergyPathToThree = zeroCostUnits.length > 0 && energyPotential >= 3 && earlyCharacters.length >= 2;
  const raidPairs = setupRaidPairCount(cards);
  const greedyPayoff = setupGreedyPayoff(cards, raidPairs);
  const turnThreePlan = hasEnergyPathToThree && greedyPayoff > 0;

  const features = {
    setupKeepBias: 1,
    setupPlayableOpener: zeroCostUnits.length > 0 ? 1 : 0,
    setupZeroCostUnit: zeroCostUnits.length,
    setupReducerOpener: reducerOpeners.length,
    setupLowCostUnit: lowCostUnits.length,
    setupEarlyCharacter: earlyCharacters.length,
    setupEnergyPotential: energyPotential,
    setupEnergyPathToThree: hasEnergyPathToThree ? 1 : 0,
    setupTurnThreePlan: turnThreePlan ? 1 : 0,
    setupGreedyPayoff: greedyPayoff,
    setupGreedyRisk: greedyPayoff > 0 && !hasEnergyPathToThree ? 1 : 0,
    setupCharacterCount: characters.length,
    setupEnergySource: energyColors.size,
    setupMatchedColor: matchedColors,
    setupRaidPair: raidPairs,
    setupBrick: zeroCostUnits.length === 0 ? 1 : 0,
    setupNoCharacter: characters.length === 0 ? 1 : 0,
    setupEventClutter: events.length,
    setupHighCostClutter: highCostCards.length,
    setupApCostClutter: Math.max(0, apCostTotal - 3)
  };
  for (const { def } of cards) addContextFeature(features, "setup", "card", def.id);
  return features;
}

export function scoreSetupHand(state, playerId, policy = {}) {
  const normalized = normalizePilotPolicy(policy);
  const features = setupHandFeatures(state, playerId);
  return Object.entries(features).reduce((total, [feature, value]) => {
    return total + Number(normalized.weights[feature] ?? 0) * Number(value ?? 0);
  }, 0);
}

export function chooseSetupAction(state, playerId, policy = {}) {
  const player = state.players[playerId];
  if (player.mulliganUsed) {
    return {
      type: "keepHand",
      score: scoreSetupHand(state, playerId, policy),
      features: setupHandFeatures(state, playerId)
    };
  }
  const score = scoreSetupHand(state, playerId, policy);
  return {
    type: score < 0 ? "mulligan" : "keepHand",
    score,
    features: setupHandFeatures(state, playerId)
  };
}

export function resolvePilotSetup(state, policy, {
  decisionRecorder = null,
  counterfactual = null,
  maxTurns = 100,
  matchupOverlays = null,
  matchupDeckFingerprints = null,
  diagnostics = null
} = {}) {
  let nextState = state;
  const policies = normalizePilotPolicyConfig(policy);
  const counterfactualConfigs = normalizePlayerTrainingConfigs(counterfactual, normalizeCounterfactualExplorationConfig);
  const counterfactualRng = makeRng(deriveSeed(state.seed ?? 1, state.firstPlayer ?? "P1", "setup-counterfactual"));
  const playerIds = ["P1", "P2"];
  for (let playerIndex = 0; playerIndex < playerIds.length; playerIndex += 1) {
    const playerId = playerIds[playerIndex];
    const decision = chooseSetupAction(nextState, playerId, policies[playerId] ?? normalizePilotPolicy());
    const chosenState = applyAction(nextState, { type: decision.type, player: playerId });
    const config = counterfactualConfigs[playerId];
    const counterfactualEvidence = decisionRecorder
      && config.setupRate > 0
      && config.maxPerGame > 0
      && counterfactualRng() < config.setupRate
      ? evaluateSetupCounterfactual({
          state: nextState,
          chosenState,
          playerId,
          playerIndex,
          decision,
          policies,
          matchupOverlays,
          matchupDeckFingerprints,
          maxTurns,
          config
        })
      : null;
    if (counterfactualEvidence) recordSetupCounterfactualDiagnostic(diagnostics, playerId);
    if (decisionRecorder) recordSetupDecision(nextState, playerId, decision, decisionRecorder, counterfactualEvidence);
    nextState = chosenState;
  }
  return nextState;
}

function evaluateSetupCounterfactual({
  state,
  chosenState,
  playerId,
  playerIndex,
  decision,
  policies,
  matchupOverlays,
  matchupDeckFingerprints,
  maxTurns,
  config
}) {
  const alternativeType = decision.type === "mulligan" ? "keepHand" : "mulligan";
  let alternativeState;
  try {
    alternativeState = applyAction(state, { type: alternativeType, player: playerId });
  } catch {
    return null;
  }
  const chosenReadyState = completeSetupBranch(chosenState, policies, playerIndex + 1);
  const alternativeReadyState = completeSetupBranch(alternativeState, policies, playerIndex + 1);
  const evidence = evaluateCounterfactualRolloutPair({
    chosenState: chosenReadyState,
    alternativeState: alternativeReadyState,
    playerId,
    maxTurns,
    config,
    allowAdaptive: false,
    policy: policies,
    matchupOverlays,
    matchupDeckFingerprints,
    chosenActivated: [],
    alternativeActivated: [],
    auditSample: 1
  });
  return {
    ...evidence,
    confidence: Number(Math.min(evidence.confidence, 0.45).toFixed(6)),
    evidenceKind: `setup-${evidence.evidenceKind}`,
    targetPhase: "setup",
    decisionPhase: "setup",
    phaseEligibleOrdinal: 0,
    targetPhaseOrdinal: 0,
    fallbackUsed: false,
    alternativeIndex: alternativeType === "keepHand" ? 0 : 1,
    alternativeSelection: "setup-keep-vs-mulligan",
    alternativeAction: { type: alternativeType }
  };
}

function completeSetupBranch(state, policies, startIndex) {
  let nextState = state;
  const playerIds = ["P1", "P2"];
  for (let index = startIndex; index < playerIds.length; index += 1) {
    const playerId = playerIds[index];
    const decision = chooseSetupAction(nextState, playerId, policies[playerId] ?? normalizePilotPolicy());
    nextState = applyAction(nextState, { type: decision.type, player: playerId });
  }
  return nextState;
}

function recordSetupCounterfactualDiagnostic(diagnostics, playerId) {
  if (!diagnostics || typeof diagnostics !== "object") return;
  diagnostics.counterfactualsEvaluated = Number(diagnostics.counterfactualsEvaluated ?? 0) + 1;
  diagnostics.evaluatedByPlayer ??= { P1: 0, P2: 0 };
  diagnostics.evaluatedByPlayer[playerId] = Number(diagnostics.evaluatedByPlayer[playerId] ?? 0) + 1;
}

function recordSetupDecision(state, playerId, decision, recorder, counterfactualEvidence = null) {
  const candidates = [
    {
      index: 0,
      chosen: decision.type === "keepHand",
      action: { type: "keepHand" },
      score: Number(decision.score ?? 0),
      features: structuredClone(decision.features ?? {})
    },
    {
      index: 1,
      chosen: decision.type === "mulligan",
      action: { type: "mulligan" },
      score: 0,
      features: {}
    }
  ];
  recorder({
    step: `setup-${playerId}`,
    player: playerId,
    opponent: opponentOf(playerId),
    state: decisionStateSummary(state, playerId),
    matchupProfile: null,
    matchupOverlayPath: null,
    exploration: null,
    counterfactual: counterfactualEvidence,
    chosenIndex: decision.type === "keepHand" ? 0 : 1,
    chosenAction: { type: decision.type },
    candidates
  });
}

function setupRaidPairCount(cards) {
  let pairs = 0;
  for (const { def } of cards) {
    if (!def.raid) continue;
    const raidNames = def.raid.names ?? (def.raid.name ? [def.raid.name] : []);
    const raidAffinities = def.raid.affinities ?? (def.raid.affinity ? [def.raid.affinity] : []);
    const hasBase = cards.some(({ def: baseDef }) => {
      if (baseDef.id === def.id) return false;
      if (raidNames.some((name) => cardDefHasName(baseDef, name))) return true;
      return raidAffinities.some((affinity) => includesText(baseDef.affinities, affinity));
    });
    if (hasBase) pairs += 1;
  }
  return pairs;
}

function setupEnergyPotential(cards) {
  const sourceCards = cards.filter(({ def }) => {
    return (def.energy ?? []).some((icon) => Number(icon.amount ?? 0) > 0);
  });
  return Math.min(3, sourceCards.length);
}

function setupGreedyPayoff(cards, raidPairs) {
  const highImpactCards = cards.filter(({ def }) => {
    const requiredEnergy = Number(def.requiredEnergy?.amount ?? 0);
    const bp = Number(def.bp ?? 0);
    const hasImpactKeyword = Boolean(def.keywords?.impact || def.keywords?.damage || def.keywords?.doubleAttack || def.keywords?.snipe);
    const hasRelevantAbility = (def.abilities ?? []).some((ability) => {
      return [TIMINGS.WHEN_PLAYED, TIMINGS.ACTIVATE_MAIN, TIMINGS.WHEN_ATTACKING].includes(ability.timing);
    });
    return requiredEnergy >= 3 || bp >= 3500 || hasImpactKeyword || hasRelevantAbility || Boolean(def.raid);
  });
  return Math.min(3, highImpactCards.length + raidPairs);
}

export function countLifeTriggers(state, playerId, triggerType = TRIGGER_TYPES.SPECIAL) {
  const player = state.players[playerId];
  const lifeDefIds = player.startingLifeDefIds ?? player.life.map((card) => card.defId);
  return lifeDefIds.filter((defId) => state.catalog[defId]?.trigger?.type === triggerType).length;
}

export function catalogGameResult(state, { index = null, seed = null, statePath = null } = {}) {
  const p1Hand = analyzeSetupHand(state, "P1");
  const p2Hand = analyzeSetupHand(state, "P2");
  const p1 = state.players.P1;
  const p2 = state.players.P2;
  const turnsTaken = p1.turnsTaken + p2.turnsTaken;

  return {
    index,
    seed,
    statePath,
    complete: Boolean(state.winner) || state.phase === PHASES.GAME_OVER,
    winner: state.winner,
    p1Won: state.winner === "P1",
    p2Won: state.winner === "P2",
    firstPlayer: state.firstPlayer,
    secondPlayer: opponentOf(state.firstPlayer),
    turnsTaken,
    turnCyclesTaken: Math.max(p1.turnsTaken, p2.turnsTaken),
    p1TurnsTaken: p1.turnsTaken,
    p2TurnsTaken: p2.turnsTaken,
    p1LifeRemaining: p1.life.length,
    p2LifeRemaining: p2.life.length,
    p1Mulliganed: p1.mulliganUsed,
    p2Mulliganed: p2.mulliganUsed,
    p1Bricked: p1Hand.bricked,
    p2Bricked: p2Hand.bricked,
    p1InitialBricked: p1Hand.initialBricked,
    p2InitialBricked: p2Hand.initialBricked,
    p1SetupOpenersSeen: p1Hand.finalSetupOpenersSeen,
    p2SetupOpenersSeen: p2Hand.finalSetupOpenersSeen,
    p1InitialSetupOpenersSeen: p1Hand.initialSetupOpenersSeen,
    p2InitialSetupOpenersSeen: p2Hand.initialSetupOpenersSeen,
    p1ZeroCostUnitsSeen: p1Hand.finalZeroCostUnitsSeen,
    p2ZeroCostUnitsSeen: p2Hand.finalZeroCostUnitsSeen,
    p1InitialZeroCostUnitsSeen: p1Hand.initialZeroCostUnitsSeen,
    p2InitialZeroCostUnitsSeen: p2Hand.initialZeroCostUnitsSeen,
    p1SpecialTriggersInLife: countLifeTriggers(state, "P1", TRIGGER_TYPES.SPECIAL),
    p2SpecialTriggersInLife: countLifeTriggers(state, "P2", TRIGGER_TYPES.SPECIAL)
  };
}

export function runAutoplayGame(initialState, {
  maxActions = 1000,
  maxTurns = 100,
  policy,
  matchupOverlays = null,
  matchupDeckFingerprints = null,
  exploration = null,
  counterfactual = null,
  initialActivatedThisTurn = null,
  decisionRecorder = null,
  appendStoppedLog = true
} = {}) {
  let state = initialState;
  let steps = 0;
  let stoppedReason = null;
  let failureDiagnostics = null;
  const activatedThisTurn = new Set(initialActivatedThisTurn ?? []);
  const policies = normalizePilotPolicyConfig(policy);
  const matchupConfigs = normalizeMatchupOverlayConfig(matchupOverlays);
  const matchupFingerprintConfigs = normalizeMatchupFingerprintConfig(matchupDeckFingerprints);
  const explorationConfigs = normalizePlayerTrainingConfigs(exploration, normalizeActionExplorationConfig);
  const explorationRng = makeRng(deriveSeed(state.seed ?? 1, state.firstPlayer ?? "P1", "autoplay-exploration"));
  const counterfactualConfigs = normalizePlayerTrainingConfigs(counterfactual, normalizeCounterfactualExplorationConfig);
  const counterfactualRng = makeRng(deriveSeed(state.seed ?? 1, state.firstPlayer ?? "P1", "autoplay-counterfactual"));
  const counterfactualGameEnabled = Object.fromEntries(["P1", "P2"].map((playerId) => [
    playerId,
    counterfactualConfigs[playerId].rate > 0 && counterfactualRng() < counterfactualConfigs[playerId].rate
  ]));
  const counterfactualProbeTargetingEnabled = Object.fromEntries(["P1", "P2"].map((playerId) => [
    playerId,
    Boolean(decisionRecorder)
      && explorationConfigs[playerId].enabled
      && explorationConfigs[playerId].mode === "counterfactual-probe"
      && counterfactualConfigs[playerId].maxPerGame > 0
  ]));
  const counterfactualTargetingEnabled = Object.fromEntries(["P1", "P2"].map((playerId) => [
    playerId,
    counterfactualGameEnabled[playerId] || counterfactualProbeTargetingEnabled[playerId]
  ]));
  const counterfactualEligibleByPhase = Object.fromEntries(["P1", "P2"].map((playerId) => [
    playerId,
    Object.fromEntries(COUNTERFACTUAL_PHASE_ORDER.map((phase) => [phase, 0]))
  ]));
  const counterfactualEligibleDecisions = { P1: 0, P2: 0 };
  const counterfactualTargets = Object.fromEntries(["P1", "P2"].map((playerId) => [
    playerId,
    counterfactualTargetingEnabled[playerId]
      ? sampleCounterfactualTarget(counterfactualRng, counterfactualConfigs[playerId], counterfactualEligibleByPhase[playerId])
      : null
  ]));
  const counterfactualTargetPhaseCounts = Object.fromEntries(COUNTERFACTUAL_PHASE_ORDER.map((phase) => [phase, 0]));
  for (const target of Object.values(counterfactualTargets)) {
    if (target && Object.hasOwn(counterfactualTargetPhaseCounts, target.phase)) counterfactualTargetPhaseCounts[target.phase] += 1;
  }
  const counterfactualEvaluatedPhaseCounts = Object.fromEntries(COUNTERFACTUAL_PHASE_ORDER.map((phase) => [phase, 0]));
  let counterfactualFallbacks = 0;
  let counterfactualExplorationPriorityEvaluations = 0;
  let counterfactualLowInformationSkips = 0;
  const counterfactualsByPlayer = { P1: 0, P2: 0 };
  const explorationsByPlayer = { P1: 0, P2: 0 };
  const explorationProbesByPlayer = { P1: 0, P2: 0 };
  const explorationActionsByPlayer = { P1: 0, P2: 0 };
  let counterfactualsEvaluated = 0;

  while (!state.winner && steps < maxActions) {
    if (turnsTaken(state) >= maxTurns) {
      stoppedReason = "maxTurns";
      break;
    }

    const playerId = state.pendingAttack?.defenderPlayer ?? state.activePlayer;
    const explorationConfig = explorationConfigs[playerId];
    const counterfactualConfig = counterfactualConfigs[playerId];
    const dynamicPolicy = policyForDecision(
      state,
      playerId,
      policies[playerId] ?? normalizePilotPolicy(),
      matchupConfigs[playerId],
      matchupFingerprintConfigs[playerId]
    );
    let candidates = autoplayActionCandidates(state, playerId, {
      activatedThisTurn,
      policy: dynamicPolicy
    });
    const explorationBudgetAvailable = explorationsByPlayer[playerId] < explorationConfig.maxPerGame
      && (!decisionRecorder || counterfactualsByPlayer[playerId] < counterfactualConfig.maxPerGame);
    const counterfactualProbeMode = explorationConfig.mode === "counterfactual-probe"
      && Boolean(decisionRecorder)
      && counterfactualConfig.maxPerGame > 0;
    if (explorationBudgetAvailable && !counterfactualProbeMode) {
      candidates = reorderCandidatesForExploration(state, playerId, candidates, dynamicPolicy, explorationConfig, explorationRng);
    }
    let nextState = null;
    let selectedAction = null;
    let selectedIndex = -1;
    let selectedNestedDecisionRecords = [];
    let explorationProbe = null;
    const candidateFailures = [];
    const activatedBeforeDecision = new Set(activatedThisTurn);

    for (let actionIndex = 0; actionIndex < candidates.length; actionIndex += 1) {
      const action = candidates[actionIndex];
      const nestedDecisionRecords = [];
      const nestedExploredPlayers = new Set();
      const resolutionChoiceResolver = (resolution) => {
        const resolutionPlayerId = resolution.playerId;
        const resolutionExploration = explorationConfigs[resolutionPlayerId];
        const canExploreTrajectory = !action.autoplayExploration
          && resolutionExploration.mode !== "counterfactual-probe"
          && !nestedExploredPlayers.has(resolutionPlayerId)
          && explorationsByPlayer[resolutionPlayerId] < resolutionExploration.maxPerGame;
        const resolutionPolicy = policyForDecision(
          resolution.state,
          resolutionPlayerId,
          policies[resolutionPlayerId] ?? normalizePilotPolicy(),
          matchupConfigs[resolutionPlayerId],
          matchupFingerprintConfigs[resolutionPlayerId]
        );
        const choices = resolveAutoplayResolutionChoice({
          ...resolution,
          policy: resolutionPolicy,
          explorationConfig: canExploreTrajectory
            ? resolutionExploration
            : { ...resolutionExploration, rate: 0, raidNormalPlayRate: 0 },
          explorationRng,
          step: steps + (nestedDecisionRecords.length + 1) / 1000,
          matchupConfig: matchupConfigs[resolutionPlayerId],
          matchupDeckFingerprints: matchupFingerprintConfigs[resolutionPlayerId],
          records: nestedDecisionRecords
        });
        if (nestedDecisionRecords.at(-1)?.exploration) nestedExploredPlayers.add(resolutionPlayerId);
        return choices;
      };
      try {
        const abilityKey = autoplayAbilityActionKey(state, action);
        nextState = applyAction(state, {
          ...action,
          choices: structuredClone(action.choices ?? {}),
          resolutionChoiceResolver
        });
        if (abilityKey) activatedThisTurn.add(abilityKey);
        selectedAction = action;
        selectedIndex = actionIndex;
        selectedNestedDecisionRecords = nestedDecisionRecords;
        break;
      } catch (error) {
        candidateFailures.push(autoplayCandidateFailure(action, error, {
          resolutionChoices: autoplayResolutionFailureChoices(nestedDecisionRecords)
        }));
        const retryAction = actionWithLineFullFallbackChoice(state, playerId, action, error);
        if (retryAction) {
          try {
            nestedDecisionRecords.length = 0;
            nestedExploredPlayers.clear();
            const abilityKey = autoplayAbilityActionKey(state, retryAction);
            nextState = applyAction(state, {
              ...retryAction,
              choices: structuredClone(retryAction.choices ?? {}),
              resolutionChoiceResolver
            });
            if (abilityKey) activatedThisTurn.add(abilityKey);
            selectedAction = retryAction;
            selectedIndex = actionIndex;
            selectedNestedDecisionRecords = nestedDecisionRecords;
            break;
          } catch (retryError) {
            candidateFailures.push(autoplayCandidateFailure(retryAction, retryError, {
              retry: true,
              resolutionChoices: autoplayResolutionFailureChoices(nestedDecisionRecords)
            }));
            nextState = null;
          }
        }
        nextState = null;
      }
    }

    if (!nextState) {
      nextState = fallbackAdvancePhaseWithReplacement(state, playerId);
    }

    if (!nextState) {
      failureDiagnostics = {
        step: steps,
        player: playerId,
        phase: state.phase,
        activePlayer: state.activePlayer,
        pendingAttack: structuredClone(state.pendingAttack ?? null),
        candidateCount: candidates.length,
        candidateFailures
      };
      stoppedReason = "noLegalAutoplayAction";
      break;
    }

    if (selectedAction && selectedIndex >= 0 && candidates[selectedIndex] !== selectedAction) {
      candidates = candidates.map((candidate, index) => index === selectedIndex ? selectedAction : candidate);
    }
    for (const record of selectedNestedDecisionRecords) {
      if (!record.exploration) continue;
      explorationsByPlayer[record.player] += 1;
      explorationActionsByPlayer[record.player] += 1;
    }

    let counterfactualEvidence = null;
    const nestedCounterfactual = selectedAction && selectedNestedDecisionRecords.length > 0
      ? evaluateNestedResolutionCounterfactual({
          state,
          nextState,
          selectedAction,
          records: selectedNestedDecisionRecords,
          policies,
          matchupConfigs,
          matchupFingerprintConfigs,
          counterfactualConfigs,
          counterfactualGameEnabled,
          counterfactualsByPlayer,
          counterfactualTargets,
          counterfactualEligibleByPhase,
          counterfactualEligibleDecisions,
          policy,
          matchupOverlays,
          matchupDeckFingerprints,
          maxTurns,
          activatedBeforeDecision,
          rng: counterfactualRng
        })
      : null;
    if (nestedCounterfactual) {
      const {
        record,
        playerId: resolutionPlayerId,
        decisionPhase,
        explorationPriority,
        target,
        phaseEligibleOrdinal,
        targetMatched,
        fallbackUsed,
        evidence
      } = nestedCounterfactual;
      record.counterfactual = {
        ...evidence,
        targetPhase: target?.phase ?? decisionPhase,
        decisionPhase,
        phaseEligibleOrdinal,
        targetPhaseOrdinal: target?.ordinal ?? phaseEligibleOrdinal,
        fallbackUsed,
        informationScore: nestedCounterfactual.informationScore,
        informationReason: "nested-resolution-choice",
        samplingReason: explorationPriority
          ? fallbackUsed ? "explored-alternative-fallback" : "explored-alternative-priority"
          : fallbackUsed ? "nested-resolution-fallback" : "nested-resolution-priority"
      };
      counterfactualsByPlayer[resolutionPlayerId] += 1;
      counterfactualsEvaluated += 1;
      counterfactualEvaluatedPhaseCounts[decisionPhase] = Number(counterfactualEvaluatedPhaseCounts[decisionPhase] ?? 0) + 1;
      if (explorationPriority) counterfactualExplorationPriorityEvaluations += 1;
      if (fallbackUsed) counterfactualFallbacks += 1;
      if (counterfactualsByPlayer[resolutionPlayerId] < counterfactualConfigs[resolutionPlayerId].maxPerGame
        && counterfactualTargetingEnabled[resolutionPlayerId]
      ) {
        const nextTarget = sampleCounterfactualTarget(
          counterfactualRng,
          counterfactualConfigs[resolutionPlayerId],
          counterfactualEligibleByPhase[resolutionPlayerId],
          { excludePhase: target?.phase ?? decisionPhase }
        );
        counterfactualTargets[resolutionPlayerId] = nextTarget;
        if (Object.hasOwn(counterfactualTargetPhaseCounts, nextTarget.phase)) {
          counterfactualTargetPhaseCounts[nextTarget.phase] += 1;
        }
      } else {
        counterfactualTargets[resolutionPlayerId] = null;
      }
    }

    const currentExplorationBudgetAvailable = explorationsByPlayer[playerId] < explorationConfig.maxPerGame
      && counterfactualsByPlayer[playerId] < counterfactualConfig.maxPerGame;
    if (selectedAction?.autoplayExploration) {
      explorationsByPlayer[playerId] += 1;
      explorationActionsByPlayer[playerId] += 1;
    }

    const counterfactualEligible = Boolean(decisionRecorder && selectedAction && candidates.length > 1);
    if (counterfactualEligible) {
      const decisionPhase = counterfactualDecisionPhase(state, playerId);
      const target = counterfactualTargets[playerId];
      const phaseEligible = Object.hasOwn(counterfactualEligibleByPhase[playerId], decisionPhase);
      const phaseEligibleOrdinal = phaseEligible
        ? counterfactualEligibleByPhase[playerId][decisionPhase]
        : Number.POSITIVE_INFINITY;
      const totalEligibleOrdinal = counterfactualEligibleDecisions[playerId];
      if (phaseEligible) counterfactualEligibleByPhase[playerId][decisionPhase] += 1;
      counterfactualEligibleDecisions[playerId] += 1;
      const targetMatched = Boolean(target
        && phaseEligible
        && decisionPhase === target.phase
        && phaseEligibleOrdinal >= target.ordinal);
      const fallbackMatched = Boolean(target
        && phaseEligible
        && totalEligibleOrdinal >= counterfactualConfig.fallbackAfterEligible);
      const fallbackUsed = !targetMatched && fallbackMatched;
      const probeSamplingMatched = targetMatched || fallbackMatched;
      if (currentExplorationBudgetAvailable
        && counterfactualProbeMode
        && probeSamplingMatched
      ) {
        explorationProbe = selectCounterfactualExplorationProbe(
          state,
          playerId,
          candidates,
          selectedIndex,
          dynamicPolicy,
          explorationConfig,
          explorationRng
        );
        if (explorationProbe) {
          explorationsByPlayer[playerId] += 1;
          explorationProbesByPlayer[playerId] += 1;
        }
      }
      const explorationPriority = Boolean(selectedAction.autoplayExploration || explorationProbe);
      const opportunity = explorationProbe
        ? {
            score: 1,
            reason: `counterfactual-probe:${explorationProbe.reason}`,
            alternativeIndex: explorationProbe.alternativeIndex
          }
        : counterfactualOpportunityScore({
            state,
            playerId,
            selectedAction,
            selectedIndex,
            candidates,
            decisionPolicy: dynamicPolicy,
            explorationConfig
          });
      const lowInformation = opportunity.score < counterfactualConfig.minimumInformationScore;
      const lowInformationExploration = !explorationPriority
        && (targetMatched || fallbackMatched)
        && lowInformation
        && counterfactualRng() < counterfactualConfig.lowInformationExplorationRate;
      const samplingMatched = explorationPriority || targetMatched || fallbackMatched;
      const informationAccepted = explorationPriority || !lowInformation || lowInformationExploration;
      if ((counterfactualGameEnabled[playerId] || explorationPriority)
        && counterfactualsByPlayer[playerId] < counterfactualConfig.maxPerGame
        && samplingMatched
        && informationAccepted
      ) {
        counterfactualEvidence = evaluateExplorationCounterfactual({
          state,
          nextState,
          playerId,
          selectedAction,
          selectedIndex,
          candidates,
          decisionPolicy: dynamicPolicy,
          policy,
          matchupOverlays,
          matchupDeckFingerprints,
          maxTurns,
          activatedBeforeDecision,
          config: counterfactualConfig,
          rng: counterfactualRng,
          preferredAlternativeIndex: opportunity.alternativeIndex
        });
        if (counterfactualEvidence) {
          counterfactualEvidence = {
            ...counterfactualEvidence,
            targetPhase: target?.phase ?? decisionPhase,
            decisionPhase,
            phaseEligibleOrdinal,
            targetPhaseOrdinal: target?.ordinal ?? phaseEligibleOrdinal,
            fallbackUsed,
            informationScore: opportunity.score,
            informationReason: opportunity.reason,
            samplingReason: explorationPriority
              ? explorationProbe
                ? fallbackUsed ? "explored-alternative-fallback" : "explored-alternative-priority"
                : fallbackUsed ? "explored-action-fallback" : "explored-action-priority"
              : fallbackUsed
                ? "eligible-fallback"
                : lowInformationExploration
                  ? "low-information-exploration"
                  : "information-priority"
          };
          counterfactualsByPlayer[playerId] += 1;
          counterfactualsEvaluated += 1;
          counterfactualEvaluatedPhaseCounts[decisionPhase] = Number(counterfactualEvaluatedPhaseCounts[decisionPhase] ?? 0) + 1;
          if (explorationPriority) counterfactualExplorationPriorityEvaluations += 1;
          if (fallbackUsed) counterfactualFallbacks += 1;
          if (counterfactualsByPlayer[playerId] < counterfactualConfig.maxPerGame && counterfactualTargetingEnabled[playerId]) {
            const nextTarget = sampleCounterfactualTarget(
              counterfactualRng,
              counterfactualConfig,
              counterfactualEligibleByPhase[playerId],
              { excludePhase: target?.phase ?? decisionPhase }
            );
            counterfactualTargets[playerId] = nextTarget;
            if (Object.hasOwn(counterfactualTargetPhaseCounts, nextTarget.phase)) counterfactualTargetPhaseCounts[nextTarget.phase] += 1;
          } else {
            counterfactualTargets[playerId] = null;
          }
        }
      } else if (samplingMatched && !informationAccepted) {
        counterfactualLowInformationSkips += 1;
      }
    }

    if (decisionRecorder && selectedAction) {
      recordAutoplayDecision({
        recorder: decisionRecorder,
        state,
        playerId,
        step: steps,
        candidates,
        policy: dynamicPolicy,
        matchupProfile: publicOpponentProfile(state, playerId, matchupProfileOptions(matchupConfigs[playerId], matchupFingerprintConfigs[playerId])),
        matchupOverlayPath: selectedMatchupOverlay(
          state,
          playerId,
          matchupConfigs[playerId],
          matchupFingerprintConfigs[playerId]
        )?.path ?? null,
        counterfactualEvidence,
        explorationEvidence: explorationProbe ?? selectedAction.autoplayExploration ?? null,
        selectedAction,
        selectedIndex
      });
      for (const record of selectedNestedDecisionRecords) decisionRecorder(record);
    }

    state = nextState;
    steps += 1;
  }

  stoppedReason ??= state.winner ? "winner" : "maxActions";
  if (appendStoppedLog) state.log.push(`Autoplay stopped after ${steps} action(s): ${stoppedReason}.`);
  return {
    state,
    steps,
    stoppedReason,
    failureDiagnostics,
    activatedThisTurn: [...activatedThisTurn],
    counterfactualsEvaluated,
    counterfactualDiagnostics: {
      enabledPlayers: Object.values(counterfactualGameEnabled).filter(Boolean).length,
      probeTargetedPlayers: Object.values(counterfactualProbeTargetingEnabled).filter(Boolean).length,
      targetedPlayers: Object.values(counterfactualTargetingEnabled).filter(Boolean).length,
      eligibleByPhase: counterfactualEligibleByPhase,
      targetPhaseCounts: counterfactualTargetPhaseCounts,
      evaluatedPhaseCounts: counterfactualEvaluatedPhaseCounts,
      fallbacks: counterfactualFallbacks,
      explorationPriorityEvaluations: counterfactualExplorationPriorityEvaluations,
      lowInformationSkips: counterfactualLowInformationSkips
    },
    explorationDiagnostics: {
      byPlayer: explorationsByPlayer,
      probesByPlayer: explorationProbesByPlayer,
      actionsByPlayer: explorationActionsByPlayer,
      total: Number(explorationsByPlayer.P1 ?? 0) + Number(explorationsByPlayer.P2 ?? 0),
      maxPerGameByPlayer: Object.fromEntries(["P1", "P2"].map((playerId) => [
        playerId,
        explorationConfigs[playerId].maxPerGame
      ]))
    }
  };
}

function autoplayCandidateFailure(action, error, extra = {}) {
  return {
    ...extra,
    action: structuredClone(action),
    name: error?.name ?? "Error",
    code: error?.code ?? null,
    message: error?.message ?? String(error),
    details: error?.details === undefined ? null : structuredClone(error.details)
  };
}

function autoplayResolutionFailureChoices(records) {
  return records.map((record) => ({
    player: record.player,
    decisionKind: record.chosenAction?.decisionKind ?? null,
    sourceCardId: record.chosenAction?.sourceCardId ?? null,
    resolutionOption: record.chosenAction?.resolutionOption ?? null,
    choices: structuredClone(record.selectedChoices ?? {})
  }));
}

function countSetupZeroCostUnits(state, defIds) {
  return defIds.filter((defId) => {
    const def = state.catalog[defId];
    return def?.type === CARD_TYPES.CHARACTER && setupRequiredEnergyForCardUse(def) === 0;
  }).length;
}

function setupRequiredEnergyForCardUse(def) {
  const base = Number(def?.requiredEnergy?.amount ?? 0);
  if (base === 0) return 0;
  const reduction = (def.useCostModifiers ?? [])
    .filter((modifier) => modifier.kind === "requiredEnergy")
    .filter((modifier) => !modifier.sourceZone || modifier.sourceZone === "hand")
    .filter((modifier) => !modifier.sourceZones || modifier.sourceZones.includes("hand"))
    .filter((modifier) => !modifier.color || modifier.color === def.requiredEnergy?.color)
    .filter((modifier) => setupCostConditionApplies(modifier.condition))
    .reduce((total, modifier) => total + Number(modifier.amount ?? 0), 0);
  return Math.max(0, base - reduction);
}

function setupCostConditionApplies(condition) {
  if (!condition || Object.keys(condition).length === 0) return true;
  if (condition.emptyField) return true;
  if (Array.isArray(condition.all)) return condition.all.every(setupCostConditionApplies);
  if (Array.isArray(condition.any)) return condition.any.some(setupCostConditionApplies);
  return false;
}

function publicCardDefIdsForPlayer(state, viewerId, observedPlayerId) {
  const player = state.players[observedPlayerId];
  const fieldCards = [...player.frontLine, ...player.energyLine]
    .flatMap((permanent) => permanent.cards ?? [])
    .filter((card) => card.faceUp !== false)
    .map((card) => card.defId);
  const zoneCards = [
    ...player.sideline,
    ...player.removal,
    ...player.life.filter((card) => card.faceUp)
  ].map((card) => card.defId);
  const rememberedReveals = publicKnownCardDefIds(state, viewerId, observedPlayerId);
  return [...fieldCards, ...zoneCards, ...rememberedReveals].filter(Boolean);
}

function sourceCodeForDef(def) {
  const localSourceCode = sourceCodeFromNumber(def.number);
  return normalizeProfileSegment(localSourceCode || def.sourceCode);
}

function normalizeProfileSegment(value) {
  return String(value ?? "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

function turnsTaken(state) {
  return state.players.P1.turnsTaken + state.players.P2.turnsTaken;
}

export function autoplayActionCandidates(state, playerId, memory = {}) {
  const policy = normalizePilotPolicy(memory.policy);
  const actions = legalActions(state, playerId);
  if (actions.length === 0) return [];

  if (state.pendingAttack?.defenderPlayer === playerId) {
    return sortedPilotActions(state, playerId, actions
      .flatMap((action) => withAutoplayChoiceVariants(state, playerId, action)), policy);
  }

  if (state.phase === PHASES.START) {
    return sortedPilotActions(state, playerId, actions, policy);
  }

  if (state.phase === PHASES.MOVEMENT) {
    return sortedPilotActions(state, playerId, [
      ...actions.filter((action) => action.type === "moveCharacters"),
      ...actions.filter((action) => action.type === "advancePhase")
    ], policy);
  }

  if (state.phase === PHASES.MAIN) {
    const player = state.players[playerId];
    const abilityCandidates = actions
      .filter((action) => action.type === "activateMainAbility")
      .filter((action) => !memory.activatedThisTurn?.has(autoplayAbilityActionKey(state, action)))
      .flatMap((action) => withAutoplayChoiceVariants(state, playerId, action));
    const raidCandidates = actions
      .filter((action) => action.type === "performRaid")
      .flatMap((action) => withAutoplayChoiceVariants(state, playerId, action));
    const playCandidates = actions
      .filter((action) => action.type === "playCard")
      .flatMap((action) => withAutoplayChoiceVariants(state, playerId, action));
    return sortedPilotActions(state, playerId, [
      ...abilityCandidates,
      ...raidCandidates,
      ...playCandidates,
      ...actions
        .filter((action) => action.type === "advancePhase")
        .flatMap((action) => withAutoplayChoiceVariants(state, playerId, action))
    ], policy);
  }

  if (state.phase === PHASES.ATTACK) {
    const attackCandidates = actions
      .filter((action) => action.type === "declareAttack")
      .flatMap((action) => withAutoplayChoiceVariants(state, playerId, action));
    return sortedPilotActions(state, playerId, [
      ...attackCandidates,
      ...actions
        .filter((action) => action.type === "advancePhase")
        .flatMap((action) => withAutoplayChoiceVariants(state, playerId, action))
    ], policy);
  }

  if (state.phase === PHASES.END) {
    return actions.map((action) => {
      if (action.type !== "discardForHandLimit") return action;
      const excess = Math.max(0, state.players[playerId].hand.length - 8);
      return {
        ...action,
        handIndices: lowestValueHandIndices(state, playerId, excess)
      };
    });
  }

  return actions;
}

function rankedPilotActions(state, playerId, actions, policy) {
  return actions
    .map((action, index) => ({
      action,
      index,
      score: pilotActionScore(state, playerId, action, policy)
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
}

function sortedPilotActions(state, playerId, actions, policy) {
  return rankedPilotActions(state, playerId, actions, policy)
    .map((item) => item.action);
}

function normalizeActionExplorationConfig(config) {
  if (!config) return { ...DEFAULT_ACTION_EXPLORATION, enabled: false };
  const normalized = {
    mode: normalizeActionExplorationMode(config.mode ?? config.explorationMode),
    rate: clampNumber(Number(config.rate ?? config.actionExplorationRate ?? 0), 0, 1),
    maxPerGame: Math.max(0, Math.floor(Number(config.maxPerGame ?? DEFAULT_ACTION_EXPLORATION.maxPerGame))),
    scoreWindow: Math.max(1, Number(config.scoreWindow ?? DEFAULT_ACTION_EXPLORATION.scoreWindow)),
    maxRank: Math.max(1, Math.floor(Number(config.maxRank ?? DEFAULT_ACTION_EXPLORATION.maxRank))),
    minScore: Number(config.minScore ?? DEFAULT_ACTION_EXPLORATION.minScore),
    raidNormalPlayRate: clampNumber(Number(config.raidNormalPlayRate ?? config.raidNormalRate ?? 0), 0, 1),
    raidNormalPlayScoreWindow: Math.max(1, Number(config.raidNormalPlayScoreWindow ?? DEFAULT_ACTION_EXPLORATION.raidNormalPlayScoreWindow)),
    raidNormalPlayHeuristicWindow: Math.max(1, Number(config.raidNormalPlayHeuristicWindow ?? DEFAULT_ACTION_EXPLORATION.raidNormalPlayHeuristicWindow)),
    raidNormalPlayMinHeuristicScore: Number(config.raidNormalPlayMinHeuristicScore ?? DEFAULT_ACTION_EXPLORATION.raidNormalPlayMinHeuristicScore),
    noveltyStrength: clampNumber(Number(config.noveltyStrength ?? DEFAULT_ACTION_EXPLORATION.noveltyStrength), 0, 5),
    evidence: normalizeActionExplorationEvidence(config.evidence)
  };
  normalized.enabled = normalized.maxPerGame > 0 && (normalized.rate > 0 || normalized.raidNormalPlayRate > 0);
  return normalized;
}

function normalizeActionExplorationMode(value) {
  const normalized = String(value ?? DEFAULT_ACTION_EXPLORATION.mode)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ["counterfactual", "counterfactual-probe", "probe", "probe-only"].includes(normalized)
    ? "counterfactual-probe"
    : "action";
}

function normalizePlayerTrainingConfigs(config, normalizer) {
  if (config && (Object.hasOwn(config, "P1") || Object.hasOwn(config, "P2"))) {
    return {
      P1: normalizer(config.P1),
      P2: normalizer(config.P2)
    };
  }
  const normalized = normalizer(config);
  return { P1: normalized, P2: normalized };
}

function normalizeCounterfactualExplorationConfig(config) {
  if (!config) return { ...DEFAULT_COUNTERFACTUAL_EXPLORATION };
  return {
    rate: clampNumber(Number(config.rate ?? config.sampleRate ?? 0), 0, 1),
    setupRate: clampNumber(Number(config.setupRate ?? config.setupSampleRate ?? DEFAULT_COUNTERFACTUAL_EXPLORATION.setupRate), 0, 1),
    maxPerGame: Math.max(0, Math.floor(Number(config.maxPerGame ?? DEFAULT_COUNTERFACTUAL_EXPLORATION.maxPerGame))),
    rolloutMaxActions: Math.max(1, Math.floor(Number(config.rolloutMaxActions ?? DEFAULT_COUNTERFACTUAL_EXPLORATION.rolloutMaxActions))),
    rolloutMaxPlayerTurns: Math.max(1, Math.floor(Number(
      config.rolloutMaxPlayerTurns
        ?? config.rolloutPlayerTurns
        ?? DEFAULT_COUNTERFACTUAL_EXPLORATION.rolloutMaxPlayerTurns
    ))),
    adaptiveRollout: config.adaptiveRollout !== false,
    adaptiveAuditRate: clampNumber(Number(
      config.adaptiveAuditRate ?? DEFAULT_COUNTERFACTUAL_EXPLORATION.adaptiveAuditRate
    ), 0, 1),
    decisionWindow: Math.max(1, Math.floor(Number(config.decisionWindow ?? DEFAULT_COUNTERFACTUAL_EXPLORATION.decisionWindow))),
    minimumInformationScore: clampNumber(Number(
      config.minimumInformationScore ?? config.minInformationScore ?? DEFAULT_COUNTERFACTUAL_EXPLORATION.minimumInformationScore
    ), 0, 1),
    lowInformationExplorationRate: clampNumber(Number(
      config.lowInformationExplorationRate ?? DEFAULT_COUNTERFACTUAL_EXPLORATION.lowInformationExplorationRate
    ), 0, 1),
    phaseWeights: normalizeCounterfactualPhaseWeights(config.phaseWeights ?? DEFAULT_COUNTERFACTUAL_EXPLORATION.phaseWeights),
    fallbackAfterEligible: Math.max(0, Math.floor(Number(config.fallbackAfterEligible ?? DEFAULT_COUNTERFACTUAL_EXPLORATION.fallbackAfterEligible))),
    alternativeDiversityRate: clampNumber(Number(
      config.alternativeDiversityRate ?? DEFAULT_COUNTERFACTUAL_EXPLORATION.alternativeDiversityRate
    ), 0, 1)
  };
}

export function sampleCounterfactualTargetOrdinal(rng, decisionWindow = DEFAULT_COUNTERFACTUAL_EXPLORATION.decisionWindow) {
  const window = Math.max(1, Math.floor(Number(decisionWindow ?? 1)));
  return Math.min(window - 1, Math.floor(clampNumber(Number(rng?.() ?? 0), 0, 0.999999999) * window));
}

export function sampleCounterfactualTargetPhase(rng, phaseWeights = DEFAULT_COUNTERFACTUAL_EXPLORATION.phaseWeights) {
  const weights = normalizeCounterfactualPhaseWeights(phaseWeights);
  const total = COUNTERFACTUAL_PHASE_ORDER.reduce((sum, phase) => sum + weights[phase], 0);
  let roll = clampNumber(Number(rng?.() ?? 0), 0, 0.999999999) * total;
  for (const phase of COUNTERFACTUAL_PHASE_ORDER) {
    roll -= weights[phase];
    if (roll < 0) return phase;
  }
  return COUNTERFACTUAL_PHASE_ORDER.at(-1);
}

function normalizeCounterfactualPhaseWeights(value = {}) {
  const weights = Object.fromEntries(COUNTERFACTUAL_PHASE_ORDER.map((phase) => [
    phase,
    Math.max(0, Number(value?.[phase] ?? 0))
  ]));
  if (Object.values(weights).some((weight) => weight > 0)) return weights;
  return { ...DEFAULT_COUNTERFACTUAL_EXPLORATION.phaseWeights };
}

function counterfactualDecisionPhase(state, playerId) {
  if (state.pendingAttack?.defenderPlayer === playerId) return "block";
  return state.phase;
}

function counterfactualDecisionWindow(config, phase) {
  const scale = COUNTERFACTUAL_PHASE_WINDOW_SCALE[phase] ?? 1;
  return Math.max(1, Math.ceil(config.decisionWindow * scale));
}

function sampleCounterfactualTarget(rng, config, eligibleByPhase, { excludePhase = null } = {}) {
  const phaseWeights = { ...config.phaseWeights };
  if (excludePhase && COUNTERFACTUAL_PHASE_ORDER.some((phase) => phase !== excludePhase && phaseWeights[phase] > 0)) {
    phaseWeights[excludePhase] = 0;
  }
  const phase = sampleCounterfactualTargetPhase(rng, phaseWeights);
  return {
    phase,
    ordinal: Number(eligibleByPhase[phase] ?? 0)
      + sampleCounterfactualTargetOrdinal(rng, counterfactualDecisionWindow(config, phase))
  };
}

export function counterfactualOpportunityScore({
  state,
  playerId,
  selectedAction,
  selectedIndex,
  candidates,
  decisionPolicy,
  explorationConfig = null
}) {
  if (selectedAction?.autoplayExploration) {
    return { score: 1, reason: "explored-action", alternativeIndex: null };
  }
  const selectedScore = scorePilotAction(state, playerId, selectedAction, decisionPolicy);
  const selectedFamily = counterfactualActionFamily(selectedAction);
  const selectedFeatures = explorationConfig
    ? pilotActionFeatures(state, playerId, selectedAction)
    : null;
  const alternatives = candidates
    .map((action, index) => {
      const features = explorationConfig
        ? pilotActionFeatures(state, playerId, action)
        : null;
      return {
        action,
        index,
        score: scorePilotAction(state, playerId, action, decisionPolicy),
        family: counterfactualActionFamily(action),
        pairKind: counterfactualPairKind(selectedAction, action),
        explorationEvidence: explorationConfig
          ? pairwiseActionExplorationEvidence(
              selectedFeatures,
              features,
              explorationConfig.evidence,
              explorationConfig.noveltyStrength
            )
          : null
      };
    })
    .filter((entry) => entry.index !== selectedIndex)
    .sort((left, right) => Math.abs(left.score - selectedScore) - Math.abs(right.score - selectedScore) || left.index - right.index);
  if (alternatives.length === 0) return { score: 0, reason: "no-alternative", alternativeIndex: null };
  const strategicPair = alternatives
    .filter((entry) => entry.pairKind)
    .sort((left, right) => compareCounterfactualStrategicAlternatives(left, right, selectedScore))[0];
  if (strategicPair) {
    return { score: 1, reason: strategicPair.pairKind, alternativeIndex: strategicPair.index };
  }
  const attackPassPair = alternatives.find((entry) => {
    const types = new Set([selectedAction?.type, entry.action?.type]);
    return types.has("declareAttack") && types.has("advancePhase");
  });
  if (attackPassPair) {
    return { score: 0.98, reason: "attack-vs-pass", alternativeIndex: attackPassPair.index };
  }
  const closest = alternatives[0];
  const scoreGap = Math.abs(Number(closest.score ?? 0) - Number(selectedScore ?? 0));
  const closeness = Math.exp(Math.max(-8, -scoreGap / 600));
  const distinctFamily = closest.family !== selectedFamily;
  const candidateBonus = Math.min(0.1, Math.log2(Math.max(2, candidates.length)) * 0.025);
  const informationScore = clampNumber((distinctFamily ? 0.55 : 0.3) + closeness * 0.4 + candidateBonus, 0, 1);
  return {
    score: Number(informationScore.toFixed(6)),
    reason: distinctFamily ? "distinct-action-family" : "close-same-family",
    alternativeIndex: closest.index,
    scoreGap: Number(scoreGap.toFixed(3))
  };
}

function compareCounterfactualStrategicAlternatives(left, right, selectedScore) {
  const leftEvidence = counterfactualEvidenceCoveragePriority(left.explorationEvidence);
  const rightEvidence = counterfactualEvidenceCoveragePriority(right.explorationEvidence);
  return rightEvidence - leftEvidence
    || Number(left.explorationEvidence?.attempts ?? 0) - Number(right.explorationEvidence?.attempts ?? 0)
    || Number(right.explorationEvidence?.noveltyMultiplier ?? 1) - Number(left.explorationEvidence?.noveltyMultiplier ?? 1)
    || counterfactualPairPriority(right.pairKind) - counterfactualPairPriority(left.pairKind)
    || Math.abs(left.score - selectedScore) - Math.abs(right.score - selectedScore)
    || left.index - right.index;
}

function counterfactualEvidenceCoveragePriority(evidence) {
  switch (evidence?.status) {
    case "unseen": return 4;
    case "collecting": return 3;
    case "unavailable": return 2;
    case "no-context": return 1;
    default: return 0;
  }
}

function counterfactualPairPriority(pairKind) {
  switch (pairKind) {
    case "block-vs-life": return 5;
    case "raid-placement": return 4;
    case "field-replacement-choice": return 3;
    case "raid-vs-normal-play": return 2;
    default: return 1;
  }
}

function evaluateExplorationCounterfactual({
  state,
  nextState,
  playerId,
  selectedAction,
  selectedIndex,
  candidates,
  decisionPolicy,
  policy,
  matchupOverlays,
  matchupDeckFingerprints,
  maxTurns,
  activatedBeforeDecision,
  config,
  rng,
  preferredAlternativeIndex = null
}) {
  const alternativeEntry = selectCounterfactualAlternative({
    state,
    playerId,
    selectedAction,
    selectedIndex,
    candidates,
    decisionPolicy,
    diversityRate: config.alternativeDiversityRate,
    rng,
    preferredAlternativeIndex
  });
  if (!alternativeEntry) return null;

  const alternativeApplied = alternativeEntry.applied;
  const chosenActivated = new Set(activatedBeforeDecision);
  const chosenAbilityKey = autoplayAbilityActionKey(state, selectedAction);
  if (chosenAbilityKey) chosenActivated.add(chosenAbilityKey);
  const alternativeActivated = new Set(activatedBeforeDecision);
  const alternativeAbilityKey = autoplayAbilityActionKey(state, alternativeApplied.action);
  if (alternativeAbilityKey) alternativeActivated.add(alternativeAbilityKey);

  const evidence = evaluateCounterfactualRolloutPair({
    chosenState: nextState,
    alternativeState: alternativeApplied.state,
    playerId,
    maxTurns,
    config,
    allowAdaptive: true,
    policy,
    matchupOverlays,
    matchupDeckFingerprints,
    chosenActivated,
    alternativeActivated,
    auditSample: counterfactualAdaptiveAuditSample(
      state,
      playerId,
      selectedAction,
      alternativeApplied.action
    )
  });
  return {
    ...evidence,
    alternativeIndex: alternativeEntry.index,
    alternativeSelection: alternativeEntry.selection,
    alternativeAction: summarizePilotAction(state, playerId, alternativeApplied.action)
  };
}

function evaluateNestedResolutionCounterfactual({
  state,
  nextState,
  selectedAction,
  records,
  policies,
  matchupConfigs,
  matchupFingerprintConfigs,
  counterfactualConfigs,
  counterfactualGameEnabled,
  counterfactualsByPlayer,
  counterfactualTargets,
  counterfactualEligibleByPhase,
  counterfactualEligibleDecisions,
  policy,
  matchupOverlays,
  matchupDeckFingerprints,
  maxTurns,
  activatedBeforeDecision,
  rng
}) {
  const opportunities = [];
  records.forEach((record, recordIndex) => {
    const resolutionPlayerId = record.player;
    const config = counterfactualConfigs[resolutionPlayerId];
    const explorationPriority = Boolean(record.exploration);
    if (!config || Number(counterfactualsByPlayer[resolutionPlayerId] ?? 0) >= config.maxPerGame) return;
    const chosen = record.candidates?.find((candidate) => candidate.chosen)
      ?? record.candidates?.[record.chosenIndex];
    if (!chosen) return;
    if (!(record.candidates ?? []).some((candidate) => candidate !== chosen && !candidate.chosen)) return;
    const decisionPhase = record.state?.decisionPhase
      ?? record.state?.phase
      ?? counterfactualDecisionPhase(state, resolutionPlayerId);
    const phaseCounts = counterfactualEligibleByPhase[resolutionPlayerId];
    const phaseEligible = Boolean(phaseCounts && Object.hasOwn(phaseCounts, decisionPhase));
    const phaseEligibleOrdinal = phaseEligible
      ? phaseCounts[decisionPhase]
      : Number.POSITIVE_INFINITY;
    const totalEligibleOrdinal = Number(counterfactualEligibleDecisions[resolutionPlayerId] ?? 0);
    if (phaseEligible) phaseCounts[decisionPhase] += 1;
    counterfactualEligibleDecisions[resolutionPlayerId] = totalEligibleOrdinal + 1;
    const target = counterfactualTargets[resolutionPlayerId];
    const targetMatched = Boolean(target
      && phaseEligible
      && decisionPhase === target.phase
      && phaseEligibleOrdinal >= target.ordinal);
    const fallbackMatched = Boolean(target
      && phaseEligible
      && totalEligibleOrdinal >= config.fallbackAfterEligible);
    const fallbackUsed = !targetMatched && fallbackMatched;
    if (!counterfactualGameEnabled[resolutionPlayerId] && !explorationPriority) return;
    if (!explorationPriority && !targetMatched && !fallbackMatched) return;
    for (const alternative of record.candidates ?? []) {
      if (alternative === chosen || alternative.chosen) continue;
      const distinctOption = alternative.action?.resolutionOption !== chosen.action?.resolutionOption;
      const evidence = alternative.counterfactualExplorationEvidence
        ?? alternative.explorationEvidence
        ?? {};
      const coverageGap = Boolean(
        evidence.evidenceAvailable
        && evidence.hasContext
        && evidence.status !== "graduated"
      );
      const scoreGap = Math.abs(Number(chosen.score ?? 0) - Number(alternative.score ?? 0));
      const closeness = Math.exp(Math.max(-8, -scoreGap / 600));
      const informationScore = clampNumber(
        0.25 + (distinctOption ? 0.35 : 0.15) + closeness * 0.3 + (coverageGap ? 0.1 : 0),
        0,
        1
      );
      opportunities.push({
        record,
        recordIndex,
        resolutionPlayerId,
        chosen,
        alternative,
        explorationEvidence: evidence,
        explorationPriority,
        coverageGap,
        informationScore,
        decisionPhase,
        target,
        phaseEligibleOrdinal,
        targetMatched,
        fallbackUsed
      });
    }
  });
  opportunities.sort((left, right) => (
    Number(right.explorationPriority) - Number(left.explorationPriority)
    || Number(right.coverageGap) - Number(left.coverageGap)
    || Number(left.explorationEvidence?.attempts ?? 0)
      - Number(right.explorationEvidence?.attempts ?? 0)
    || Number(right.explorationEvidence?.noveltyMultiplier ?? 1)
      - Number(left.explorationEvidence?.noveltyMultiplier ?? 1)
    || right.informationScore - left.informationScore
    || Number(left.alternative.index ?? 0) - Number(right.alternative.index ?? 0)
  ));

  for (const opportunity of opportunities) {
    const alternativeState = replayActionWithNestedResolutionAlternative({
      state,
      selectedAction,
      records,
      targetRecordIndex: opportunity.recordIndex,
      alternativeChoices: opportunity.alternative.choices,
      policies,
      matchupConfigs,
      matchupFingerprintConfigs
    });
    if (!alternativeState) continue;
    const activated = new Set(activatedBeforeDecision);
    const abilityKey = autoplayAbilityActionKey(state, selectedAction);
    if (abilityKey) activated.add(abilityKey);
    const evidence = evaluateCounterfactualRolloutPair({
      chosenState: nextState,
      alternativeState,
      playerId: opportunity.resolutionPlayerId,
      maxTurns,
      config: counterfactualConfigs[opportunity.resolutionPlayerId],
      allowAdaptive: true,
      policy,
      matchupOverlays,
      matchupDeckFingerprints,
      chosenActivated: activated,
      alternativeActivated: activated,
      auditSample: counterfactualAdaptiveAuditSample(
        state,
        opportunity.resolutionPlayerId,
        opportunity.chosen.action,
        opportunity.alternative.action
      )
    });
    return {
      record: opportunity.record,
      playerId: opportunity.resolutionPlayerId,
      decisionPhase: opportunity.decisionPhase,
      explorationPriority: opportunity.explorationPriority,
      target: opportunity.target,
      phaseEligibleOrdinal: opportunity.phaseEligibleOrdinal,
      targetMatched: opportunity.targetMatched,
      fallbackUsed: opportunity.fallbackUsed,
      informationScore: Number(opportunity.informationScore.toFixed(6)),
      evidence: {
        ...evidence,
        alternativeIndex: opportunity.alternative.index,
        alternativeSelection: "nested-resolution-diversity",
        alternativeAction: opportunity.alternative.action
      }
    };
  }
  return null;
}

function replayActionWithNestedResolutionAlternative({
  state,
  selectedAction,
  records,
  targetRecordIndex,
  alternativeChoices,
  policies,
  matchupConfigs,
  matchupFingerprintConfigs
}) {
  let replayIndex = 0;
  const resolutionChoiceResolver = (resolution) => {
    const expected = records[replayIndex];
    if (nestedResolutionRecordMatches(expected, resolution)) {
      const currentIndex = replayIndex;
      replayIndex += 1;
      return structuredClone(
        currentIndex === targetRecordIndex
          ? alternativeChoices
          : expected.selectedChoices
      );
    }
    const resolutionPlayerId = resolution.playerId;
    const resolutionPolicy = policyForDecision(
      resolution.state,
      resolutionPlayerId,
      policies[resolutionPlayerId] ?? normalizePilotPolicy(),
      matchupConfigs[resolutionPlayerId],
      matchupFingerprintConfigs[resolutionPlayerId]
    );
    return resolveAutoplayResolutionChoice({
      ...resolution,
      policy: resolutionPolicy,
      explorationConfig: { ...normalizeActionExplorationConfig(null), rate: 0, raidNormalPlayRate: 0 },
      explorationRng: () => 0.5,
      step: 0,
      matchupConfig: matchupConfigs[resolutionPlayerId],
      matchupDeckFingerprints: matchupFingerprintConfigs[resolutionPlayerId],
      records: null
    });
  };
  try {
    return applyAction(state, {
      ...selectedAction,
      choices: structuredClone(selectedAction.choices ?? {}),
      resolutionChoiceResolver
    });
  } catch {
    return null;
  }
}

function nestedResolutionRecordMatches(record, resolution) {
  if (!record || record.player !== resolution.playerId) return false;
  if (record.chosenAction?.decisionKind !== resolution.request?.kind) return false;
  const expectedSource = record.chosenAction?.sourceCardId;
  const actualSource = resolution.context?.sourceDef?.id
    ?? resolution.context?.card?.defId
    ?? resolution.request?.cards?.[0]?.defId;
  return !expectedSource || !actualSource || expectedSource === actualSource;
}

function evaluateCounterfactualRolloutPair({
  chosenState,
  alternativeState,
  playerId,
  maxTurns,
  config,
  allowAdaptive,
  policy,
  matchupOverlays,
  matchupDeckFingerprints,
  chosenActivated = [],
  alternativeActivated = [],
  auditSample = 1
}) {
  const requestedHorizon = counterfactualRolloutHorizon(
    chosenState,
    alternativeState,
    maxTurns,
    config.rolloutMaxPlayerTurns
  );
  const stageCandidate = counterfactualRolloutHorizon(
    chosenState,
    alternativeState,
    maxTurns,
    Math.min(
      requestedHorizon.playerTurnBudget,
      COUNTERFACTUAL_ADAPTIVE_STAGE_PLAYER_TURNS
    )
  );
  const adaptive = Boolean(
    allowAdaptive
    && config.adaptiveRollout
    && stageCandidate.targetPlayerTurns < requestedHorizon.targetPlayerTurns
  );
  const stageHorizon = adaptive ? stageCandidate : requestedHorizon;
  const rolloutOptions = {
    policy,
    matchupOverlays,
    matchupDeckFingerprints,
    exploration: null,
    counterfactual: null,
    decisionRecorder: null,
    appendStoppedLog: false
  };
  const maxActions = Math.max(1, Number(config.rolloutMaxActions ?? 1));
  const initialChosenScore = counterfactualStateEvaluation(chosenState, playerId).score;
  const initialAlternativeScore = counterfactualStateEvaluation(alternativeState, playerId).score;
  const initialScoreDelta = initialChosenScore - initialAlternativeScore;

  let chosenRollout = runAutoplayGame(chosenState, {
    ...rolloutOptions,
    maxActions,
    maxTurns: stageHorizon.targetPlayerTurns,
    initialActivatedThisTurn: chosenActivated
  });
  let alternativeRollout = runAutoplayGame(alternativeState, {
    ...rolloutOptions,
    maxActions,
    maxTurns: stageHorizon.targetPlayerTurns,
    initialActivatedThisTurn: alternativeActivated
  });
  const stageEvidence = counterfactualRolloutEvidence(
    chosenRollout,
    alternativeRollout,
    playerId,
    stageHorizon
  );
  const earlyStop = counterfactualAdaptiveStopDecision({
    adaptive,
    initialScoreDelta,
    requestedHorizon,
    stageHorizon,
    stageEvidence
  });
  const auditRate = clampNumber(Number(config.adaptiveAuditRate ?? 0), 0, 1);
  const auditPerformed = Boolean(
    earlyStop.eligible
    && !earlyStop.terminal
    && Number(auditSample) < auditRate
  );
  const continueToFullHorizon = adaptive && (!earlyStop.eligible || auditPerformed);

  if (continueToFullHorizon) {
    chosenRollout = continueCounterfactualRollout(chosenRollout, {
      ...rolloutOptions,
      maxActions,
      maxTurns: requestedHorizon.targetPlayerTurns
    });
    alternativeRollout = continueCounterfactualRollout(alternativeRollout, {
      ...rolloutOptions,
      maxActions,
      maxTurns: requestedHorizon.targetPlayerTurns
    });
  }

  const finalHorizon = continueToFullHorizon ? requestedHorizon : stageHorizon;
  const evidence = counterfactualRolloutEvidence(
    chosenRollout,
    alternativeRollout,
    playerId,
    finalHorizon
  );
  const earlyStopped = Boolean(adaptive && earlyStop.eligible && !auditPerformed);
  const auditAgreement = auditPerformed && evidence.rolloutHorizon.comparable
    ? evidence.preference === stageEvidence.preference
    : null;
  return {
    ...evidence,
    rolloutHorizon: {
      ...evidence.rolloutHorizon,
      adaptiveVersion: COUNTERFACTUAL_ADAPTIVE_ROLLOUT_VERSION,
      adaptive,
      requestedPlayerTurnBudget: requestedHorizon.playerTurnBudget,
      stagePlayerTurnBudget: stageHorizon.playerTurnBudget,
      evaluatedPlayerTurnBudget: finalHorizon.playerTurnBudget,
      stagesEvaluated: continueToFullHorizon ? 2 : 1,
      earlyStopEligible: earlyStop.eligible,
      earlyStopped,
      earlyStopReason: earlyStopped
        ? earlyStop.reason
        : auditPerformed
          ? "audited-full-horizon"
          : adaptive
            ? "full-horizon-required"
            : "single-horizon",
      adaptiveAuditRate: auditRate,
      adaptiveAuditPerformed: auditPerformed,
      adaptiveAuditPreferenceAtStage: auditPerformed ? stageEvidence.preference : null,
      adaptiveAuditAgreement: auditAgreement,
      initialScoreDelta: Number(initialScoreDelta.toFixed(3)),
      stageScoreDelta: Number((stageEvidence.chosenScore - stageEvidence.alternativeScore).toFixed(3)),
      estimatedPlayerTurnsSaved: earlyStopped
        ? Math.max(0, requestedHorizon.targetPlayerTurns - stageHorizon.targetPlayerTurns)
        : 0
    }
  };
}

function continueCounterfactualRollout(previous, options) {
  if (previous.state.winner || previous.stoppedReason !== "maxTurns") return previous;
  const remainingActions = Math.max(0, Number(options.maxActions ?? 0) - Number(previous.steps ?? 0));
  if (remainingActions === 0) return previous;
  const resumed = runAutoplayGame(previous.state, {
    ...options,
    maxActions: remainingActions,
    initialActivatedThisTurn: previous.activatedThisTurn,
    appendStoppedLog: false
  });
  return {
    ...resumed,
    steps: Number(previous.steps ?? 0) + Number(resumed.steps ?? 0)
  };
}

export function counterfactualAdaptiveStopDecision({
  adaptive,
  initialScoreDelta,
  requestedHorizon,
  stageHorizon,
  stageEvidence
}) {
  if (!adaptive || requestedHorizon.targetPlayerTurns <= stageHorizon.targetPlayerTurns) {
    return { eligible: false, terminal: false, reason: "single-horizon" };
  }
  if (!stageEvidence.rolloutHorizon.comparable) {
    return { eligible: false, terminal: false, reason: "incomparable-stage" };
  }
  const chosenComplete = Boolean(stageEvidence.chosenWinner);
  const alternativeComplete = Boolean(stageEvidence.alternativeWinner);
  if (chosenComplete && alternativeComplete) {
    return { eligible: true, terminal: true, reason: "both-branches-terminal" };
  }
  if (chosenComplete || alternativeComplete || stageEvidence.preference === "tie") {
    return { eligible: false, terminal: false, reason: "uncertain-stage" };
  }
  const stageScoreDelta = stageEvidence.chosenScore - stageEvidence.alternativeScore;
  const sameDirection = Math.sign(initialScoreDelta) === Math.sign(stageScoreDelta);
  const retainedStrength = Math.abs(stageScoreDelta) >= Math.abs(initialScoreDelta) * 0.5;
  const stable = sameDirection
    && Math.abs(initialScoreDelta) >= COUNTERFACTUAL_ADAPTIVE_MIN_INITIAL_DELTA
    && Math.abs(stageScoreDelta) >= COUNTERFACTUAL_ADAPTIVE_MIN_STAGE_DELTA
    && retainedStrength;
  return {
    eligible: stable,
    terminal: false,
    reason: stable ? "stable-strong-stage" : "unstable-or-thin-stage"
  };
}

function counterfactualAdaptiveAuditSample(state, playerId, chosenAction, alternativeAction) {
  const actionKey = (action) => [
    action?.type,
    action?.handIndex,
    action?.destination,
    action?.line,
    action?.index,
    action?.abilityId,
    action?.targetLine,
    action?.targetIndex,
    action?.moveToFront,
    action?.replaceIndex?.permanentId ?? action?.replaceIndex?.index ?? action?.replaceIndex
  ].join(":");
  return makeRng(deriveSeed(
    state.seed ?? 1,
    playerId,
    state.phase,
    turnsTaken(state),
    actionKey(chosenAction),
    actionKey(alternativeAction),
    "counterfactual-adaptive-audit"
  ))();
}

function counterfactualRolloutHorizon(chosenState, alternativeState, maxTurns, rolloutMaxPlayerTurns) {
  const chosenStartPlayerTurns = turnsTaken(chosenState);
  const alternativeStartPlayerTurns = turnsTaken(alternativeState);
  const startPlayerTurns = Math.max(chosenStartPlayerTurns, alternativeStartPlayerTurns);
  const playerTurnBudget = Math.max(1, Math.floor(Number(
    rolloutMaxPlayerTurns ?? DEFAULT_COUNTERFACTUAL_EXPLORATION.rolloutMaxPlayerTurns
  )));
  const absoluteTurnLimit = Math.max(startPlayerTurns, Math.floor(Number(maxTurns ?? 100)));
  return {
    version: 1,
    playerTurnBudget,
    chosenStartPlayerTurns,
    alternativeStartPlayerTurns,
    targetPlayerTurns: Math.min(absoluteTurnLimit, startPlayerTurns + playerTurnBudget)
  };
}

function counterfactualRolloutEvidence(chosenRollout, alternativeRollout, playerId, horizon = null) {
  const chosenEvaluation = counterfactualStateEvaluation(chosenRollout.state, playerId);
  const alternativeEvaluation = counterfactualStateEvaluation(alternativeRollout.state, playerId);
  const chosenScore = chosenEvaluation.score;
  const alternativeScore = alternativeEvaluation.score;
  const delta = chosenScore - alternativeScore;
  const chosenComplete = Boolean(chosenRollout.state.winner);
  const alternativeComplete = Boolean(alternativeRollout.state.winner);
  const bothComplete = chosenComplete && alternativeComplete;
  const decisiveWinnerChange = bothComplete && chosenRollout.state.winner !== alternativeRollout.state.winner;
  const oneComplete = chosenComplete !== alternativeComplete;
  const horizonOnly = !chosenComplete && !alternativeComplete;
  const rolloutHorizon = counterfactualRolloutResult(horizon, chosenRollout, alternativeRollout);
  const comparable = rolloutHorizon.comparable;
  const preference = !comparable
    ? "tie"
    : horizonOnly && Math.abs(delta) < COUNTERFACTUAL_HORIZON_TIE_MARGIN
    ? "tie"
    : delta > 0 ? "chosen" : delta < 0 ? "alternative" : "tie";
  const evidenceKind = !comparable
    ? "unsynchronized-horizon"
    : decisiveWinnerChange
    ? "terminal-winner-change"
    : bothComplete ? "terminal-same-winner"
      : oneComplete ? "terminal-vs-horizon"
        : "horizon";
  const confidence = !comparable
    ? 0
    : decisiveWinnerChange
    ? 1
    : oneComplete ? 0.6
      : bothComplete ? 0.5
        : 0.15 + clampNumber(Math.abs(delta) / COUNTERFACTUAL_NONTERMINAL_SCALE, 0, 1) * 0.2;
  const advantageScale = decisiveWinnerChange || oneComplete ? 100000 : COUNTERFACTUAL_NONTERMINAL_SCALE;
  return {
    preference,
    advantage: preference === "tie" ? 0 : Number(clampNumber(Math.abs(delta) / advantageScale, 0, 1).toFixed(6)),
    confidence,
    evidenceKind,
    stateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION,
    chosenScore: Number(chosenScore.toFixed(3)),
    alternativeScore: Number(alternativeScore.toFixed(3)),
    chosenEvaluation: chosenEvaluation.components,
    alternativeEvaluation: alternativeEvaluation.components,
    chosenWinner: chosenRollout.state.winner ?? null,
    alternativeWinner: alternativeRollout.state.winner ?? null,
    chosenStoppedReason: chosenRollout.stoppedReason,
    alternativeStoppedReason: alternativeRollout.stoppedReason,
    rolloutHorizon
  };
}

function counterfactualRolloutResult(horizon, chosenRollout, alternativeRollout) {
  const chosenEndPlayerTurns = turnsTaken(chosenRollout.state);
  const alternativeEndPlayerTurns = turnsTaken(alternativeRollout.state);
  const chosenComplete = Boolean(chosenRollout.state.winner);
  const alternativeComplete = Boolean(alternativeRollout.state.winner);
  const chosenReachedHorizon = chosenComplete || chosenRollout.stoppedReason === "maxTurns";
  const alternativeReachedHorizon = alternativeComplete || alternativeRollout.stoppedReason === "maxTurns";
  return {
    version: Number(horizon?.version ?? 1),
    playerTurnBudget: Number(horizon?.playerTurnBudget ?? 0),
    targetPlayerTurns: Number(horizon?.targetPlayerTurns ?? Math.max(chosenEndPlayerTurns, alternativeEndPlayerTurns)),
    chosenStartPlayerTurns: Number(horizon?.chosenStartPlayerTurns ?? 0),
    alternativeStartPlayerTurns: Number(horizon?.alternativeStartPlayerTurns ?? 0),
    chosenEndPlayerTurns,
    alternativeEndPlayerTurns,
    chosenSteps: Number(chosenRollout.steps ?? 0),
    alternativeSteps: Number(alternativeRollout.steps ?? 0),
    chosenReachedHorizon,
    alternativeReachedHorizon,
    comparable: chosenReachedHorizon && alternativeReachedHorizon
  };
}

function selectCounterfactualAlternative({
  state,
  playerId,
  selectedAction,
  selectedIndex,
  candidates,
  decisionPolicy,
  diversityRate,
  rng,
  preferredAlternativeIndex = null
}) {
  if (Number.isInteger(preferredAlternativeIndex)
    && preferredAlternativeIndex !== selectedIndex
    && candidates[preferredAlternativeIndex]
  ) {
    const preferredAction = candidates[preferredAlternativeIndex];
    const applied = applyCounterfactualAction(state, playerId, preferredAction);
    if (applied) {
      return {
        action: preferredAction,
        index: preferredAlternativeIndex,
        selection: preferredCounterfactualSelection(selectedAction, preferredAction),
        applied
      };
    }
  }
  const alternatives = candidates
    .map((action, index) => ({ action, index, score: scorePilotAction(state, playerId, action, decisionPolicy) }))
    .filter((entry) => entry.index !== selectedIndex)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  if (alternatives.length === 0) return null;

  const paired = alternatives
    .map((entry) => ({ ...entry, selection: counterfactualPairKind(selectedAction, entry.action) }))
    .filter((entry) => entry.selection);
  const selectedFamily = counterfactualActionFamily(selectedAction);
  const diverse = alternatives.filter((entry) => counterfactualActionFamily(entry.action) !== selectedFamily);
  const preferDiverse = diverse.length > 0 && Number(rng?.() ?? 1) < diversityRate;
  const ranked = [
    ...paired,
    ...(preferDiverse ? diverse.map((entry) => ({ ...entry, selection: "diverse-action-family" })) : []),
    ...alternatives.map((entry) => ({ ...entry, selection: "highest-score" }))
  ];
  const seen = new Set();
  for (const entry of ranked) {
    if (seen.has(entry.index)) continue;
    seen.add(entry.index);
    const applied = applyCounterfactualAction(state, playerId, entry.action);
    if (applied) return { ...entry, applied };
  }
  return null;
}

function preferredCounterfactualSelection(selectedAction, preferredAction) {
  const pairKind = counterfactualPairKind(selectedAction, preferredAction);
  if (pairKind) return pairKind;
  const types = new Set([selectedAction?.type, preferredAction?.type]);
  if (types.has("declareAttack") && types.has("advancePhase")) return "attack-vs-pass";
  return counterfactualActionFamily(preferredAction) !== counterfactualActionFamily(selectedAction)
    ? "information-priority-diverse"
    : "information-priority-close";
}

function counterfactualPairKind(selectedAction, alternativeAction) {
  const selectedType = selectedAction?.type;
  const alternativeType = alternativeAction?.type;
  if ((selectedType === "declareBlock" && alternativeType === "declineBlock")
    || (selectedType === "declineBlock" && alternativeType === "declareBlock")) {
    return "block-vs-life";
  }
  const raidAndNormal = (selectedType === "performRaid" && alternativeType === "playCard")
    || (selectedType === "playCard" && alternativeType === "performRaid");
  if (raidAndNormal && selectedAction.handIndex === alternativeAction.handIndex) {
    return "raid-vs-normal-play";
  }
  if (selectedType === "performRaid"
    && alternativeType === "performRaid"
    && sameRaidTarget(selectedAction, alternativeAction)
    && Boolean(selectedAction.moveToFront) !== Boolean(alternativeAction.moveToFront)
  ) {
    return "raid-placement";
  }
  if (sameReplacementPlan(selectedAction, alternativeAction)
    && replacementChoiceIdentity(selectedAction.replaceIndex) !== replacementChoiceIdentity(alternativeAction.replaceIndex)
  ) {
    return "field-replacement-choice";
  }
  return null;
}

function sameRaidTarget(left, right) {
  return left?.handIndex === right?.handIndex
    && left?.targetLine === right?.targetLine
    && left?.targetIndex === right?.targetIndex;
}

function sameReplacementPlan(left, right) {
  if (left?.type !== right?.type) return false;
  if (left?.replaceIndex === undefined || right?.replaceIndex === undefined) return false;
  if (left.type === "playCard") {
    return left.handIndex === right.handIndex && left.destination === right.destination;
  }
  if (left.type === "performRaid") {
    return Boolean(left.moveToFront)
      && Boolean(right.moveToFront)
      && sameRaidTarget(left, right);
  }
  return false;
}

function replacementChoiceIdentity(choice) {
  if (choice && typeof choice === "object") {
    return choice.permanentId ?? choice.pid ?? `${choice.line ?? "line"}:${choice.index ?? "index"}`;
  }
  return choice;
}

function counterfactualActionFamily(action) {
  if (action?.type === "declareBlock" || action?.type === "declineBlock") return action.type;
  if (action?.type === "advancePhase") return "pass";
  if (action?.type === "playCard") {
    return `playCard:${action.destination ?? "unknown"}${action.replaceIndex !== undefined ? ":replace" : ""}`;
  }
  if (action?.type === "performRaid") {
    if (action.moveToFront) return `performRaid:move-front${action.replaceIndex !== undefined ? ":replace" : ""}`;
    return `performRaid:stay-${action.targetLine ?? "field"}`;
  }
  return action?.type ?? "unknown";
}

function applyCounterfactualAction(state, playerId, action) {
  try {
    return { state: applyAction(state, action), action };
  } catch (error) {
    const retryAction = actionWithLineFullFallbackChoice(state, playerId, action, error);
    if (!retryAction) return null;
    try {
      return { state: applyAction(state, retryAction), action: retryAction };
    } catch {
      return null;
    }
  }
}

export function counterfactualStateEvaluation(state, playerId) {
  const opponentId = opponentOf(playerId);
  const player = state.players[playerId];
  const opponent = state.players[opponentId];
  const components = {
    terminal: state.winner === playerId ? 100000 : state.winner === opponentId ? -100000 : 0,
    life: (Number(player.life?.length ?? 0) - Number(opponent.life?.length ?? 0)) * 900,
    hand: counterfactualOwnHandStrength(state, playerId) - Number(opponent.hand?.length ?? 0) * 55,
    front: counterfactualFrontStrength(state, playerId) - counterfactualFrontStrength(state, opponentId),
    energy: counterfactualEnergyStrength(state, playerId) - counterfactualEnergyStrength(state, opponentId),
    ap: (internals.activeAp(player) - internals.activeAp(opponent)) * 120,
    pressure: counterfactualAttackPressure(state, playerId, opponentId)
      - counterfactualAttackPressure(state, opponentId, playerId),
    deck: (Number(player.deck?.length ?? 0) - Number(opponent.deck?.length ?? 0)) * 2
  };
  return {
    score: Object.values(components).reduce((total, value) => total + Number(value ?? 0), 0),
    components
  };
}

function counterfactualFrontStrength(state, playerId) {
  return (state.players[playerId]?.frontLine ?? []).reduce((total, permanent) => {
    const def = state.catalog[permanent.cards?.at(-1)?.defId];
    if (!def) return total;
    const battlePower = permanentBattlePower(state, permanent);
    const activeValue = permanent.rested ? 0 : 110;
    const stackValue = Math.max(0, Number(permanent.cards?.length ?? 1) - 1) * 35;
    const abilityValue = Number(def.abilities?.length ?? 0) * 25;
    const combatValue = internals.directDamageAmount(state, permanent) * 90
      + (internals.hasKeyword(state, permanent, "doubleBlock") ? 90 : 0)
      + (internals.hasKeyword(state, permanent, "snipe") ? 45 : 0);
    return total + battlePower / 5 + activeValue + stackValue + abilityValue + combatValue;
  }, 0);
}

function counterfactualEnergyStrength(state, playerId) {
  const player = state.players[playerId];
  const availableEnergy = Object.values(internals.energyAvailable(state, playerId))
    .reduce((total, value) => total + Number(value ?? 0), 0);
  const linePotential = (player.energyLine ?? []).reduce((total, permanent) => {
    const def = state.catalog[permanent.cards?.at(-1)?.defId];
    if (!def) return total;
    const movableBody = def.type === CARD_TYPES.CHARACTER ? permanentBattlePower(state, permanent) / 25 : 0;
    const stackValue = Math.max(0, Number(permanent.cards?.length ?? 1) - 1) * 20;
    return total + movableBody + stackValue + (permanent.rested ? 0 : 30);
  }, 0);
  return availableEnergy * 220 + linePotential;
}

function counterfactualOwnHandStrength(state, playerId) {
  const player = state.players[playerId];
  const energy = internals.energyAvailable(state, playerId);
  const activeAp = internals.activeAp(player);
  return (player.hand ?? []).reduce((total, card) => {
    const def = state.catalog[card.defId];
    if (!def) return total + 55;
    const required = Number(def.requiredEnergy?.amount ?? 0);
    const available = Number(energy[def.requiredEnergy?.color] ?? 0);
    const energyGap = Math.max(0, required - available);
    const apGap = Math.max(0, Number(def.apCost ?? 0) - activeAp);
    const immediatelyUsable = energyGap === 0 && apGap === 0 ? 35 : 0;
    return total + 55 + cardValue(state, card) * 0.08 + immediatelyUsable - energyGap * 28 - apGap * 20;
  }, 0);
}

function counterfactualAttackPressure(state, attackerId, defenderId) {
  if (state.winner || state.phase !== PHASES.ATTACK || state.activePlayer !== attackerId) return 0;
  const attacker = state.players[attackerId];
  const defender = state.players[defenderId];
  const attackers = [
    ...(attacker.frontLine ?? []).filter((permanent) => !permanent.rested
      && state.catalog[permanent.cards?.at(-1)?.defId]?.type === CARD_TYPES.CHARACTER
      && !internals.hasKeyword(state, permanent, "cantAttack")),
    ...(attacker.energyLine ?? []).filter((permanent) => !permanent.rested
      && state.catalog[permanent.cards?.at(-1)?.defId]?.type === CARD_TYPES.CHARACTER
      && internals.hasKeyword(state, permanent, "canAttackFromEnergyLine")
      && !internals.hasKeyword(state, permanent, "cantAttack"))
  ];
  const blockers = (defender.frontLine ?? []).filter((permanent) => !permanent.rested
    && state.catalog[permanent.cards?.at(-1)?.defId]?.type === CARD_TYPES.CHARACTER
    && !internals.hasKeyword(state, permanent, "cantBlock")).length;
  const openAttackCount = Math.max(0, attackers.length - blockers);
  const damage = attackers
    .map((permanent) => internals.directDamageAmount(state, permanent))
    .sort((left, right) => left - right)
    .slice(0, openAttackCount)
    .reduce((total, value) => total + value, 0);
  const lethal = damage >= Number(defender.life?.length ?? 0) && damage > 0 ? 1400 : 0;
  return attackers.length * 55 + openAttackCount * 150 + damage * 180 + lethal;
}

function selectCounterfactualExplorationProbe(state, playerId, candidates, selectedIndex, policy, explorationConfig, rng) {
  const reordered = reorderCandidatesForExploration(
    state,
    playerId,
    candidates,
    policy,
    explorationConfig,
    rng
  );
  const metadata = reordered[0]?.autoplayExploration;
  const alternativeIndex = Number(metadata?.alternativeIndex);
  if (!metadata || !Number.isInteger(alternativeIndex) || alternativeIndex === selectedIndex) return null;
  return {
    ...metadata,
    mode: "counterfactual-probe",
    alternativeIndex
  };
}

function reorderCandidatesForExploration(state, playerId, candidates, policy, explorationConfig, rng) {
  if (!explorationConfig.enabled || candidates.length <= 1) return candidates;
  const scored = candidates.map((action, index) => {
    const features = pilotActionFeatures(state, playerId, action);
    return {
      action,
      index,
      features,
      score: pilotActionScore(state, playerId, action, policy),
      baselineScore: pilotActionScore(state, playerId, action, DEFAULT_PILOT_POLICY),
      raidNormalPlay: isRaidNormalPlayAlternative(state, playerId, action, candidates),
      explorationEvidence: actionExplorationEvidence(features, explorationConfig.evidence, explorationConfig.noveltyStrength)
    };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const best = scored[0];
  if (!best) return candidates;
  for (const candidate of scored) {
    if (candidate === best) continue;
    candidate.explorationEvidence = pairwiseActionExplorationEvidence(
      best.features,
      candidate.features,
      explorationConfig.evidence,
      explorationConfig.noveltyStrength
    );
  }
  const bestBaselineScore = Math.max(...scored.map((candidate) => Number(candidate.baselineScore ?? -Infinity)));
  const baselineRankByIndex = new Map([...scored]
    .sort((left, right) => right.baselineScore - left.baselineScore || left.index - right.index)
    .map((candidate, index) => [candidate.index, index + 1]));

  const raidNormalPool = scored.filter((candidate) => {
    const withinPolicyWindow = candidate.score >= best.score - explorationConfig.raidNormalPlayScoreWindow
      && candidate.score >= explorationConfig.minScore;
    const withinBaselineWindow = candidate.baselineScore >= bestBaselineScore - explorationConfig.raidNormalPlayHeuristicWindow
      && candidate.baselineScore >= explorationConfig.raidNormalPlayMinHeuristicScore;
    return candidate.raidNormalPlay
      && candidate.index !== best.index
      && (withinPolicyWindow || withinBaselineWindow)
      && (withinBaselineWindow || rankedIndex(scored, candidate) <= explorationConfig.maxRank);
  });
  const generalPool = scored.filter((candidate) => {
    return candidate.index !== best.index
      && (isExplorableAction(candidate.action)
        || isCounterfactualProbePassAlternative(state, best.action, candidate.action, explorationConfig))
      && candidate.score >= best.score - explorationConfig.scoreWindow
      && candidate.score >= explorationConfig.minScore
      && rankedIndex(scored, candidate) <= explorationConfig.maxRank;
  });
  const strategicCombatPool = scored.filter((candidate) => {
    const pairKind = counterfactualProbeStrategicPairKind(state, best.action, candidate.action, explorationConfig);
    return candidate.index !== best.index
      && pairKind
      && candidate.score >= best.score - Math.max(explorationConfig.scoreWindow, 720)
      && candidate.score >= explorationConfig.minScore
      && rankedIndex(scored, candidate) <= explorationConfig.maxRank;
  });

  const coveragePool = scored.filter((candidate) => {
    const evidence = candidate.explorationEvidence;
    return candidate.index !== best.index
      && isExplorableAction(candidate.action)
      && evidence.evidenceAvailable
      && evidence.hasContext
      && evidence.status !== "graduated"
      && candidate.baselineScore >= bestBaselineScore - explorationConfig.raidNormalPlayHeuristicWindow
      && candidate.baselineScore >= explorationConfig.raidNormalPlayMinHeuristicScore
      && Number(baselineRankByIndex.get(candidate.index) ?? Number.POSITIVE_INFINITY) <= explorationConfig.maxRank;
  });

  const coverageRate = coveragePool.some((candidate) => candidate.raidNormalPlay)
    ? Math.max(explorationConfig.rate, explorationConfig.raidNormalPlayRate)
    : explorationConfig.rate;
  const coverageChoice = coveragePool.length > 0 && rng() < coverageRate
    ? weightedExplorationChoice(coveragePool, bestBaselineScore, rng, { useBaselineScore: true })
    : null;
  const strategicCombatChoice = !coverageChoice && strategicCombatPool.length > 0 && rng() < explorationConfig.rate
    ? weightedExplorationChoice(strategicCombatPool, best.score, rng)
    : null;
  const raidNormalChoice = !strategicCombatChoice && !coverageChoice && raidNormalPool.length > 0 && rng() < explorationConfig.raidNormalPlayRate
    ? weightedExplorationChoice(raidNormalPool, best.score, rng, { raidNormalBias: 1.75 })
    : null;
  const generalChoice = !strategicCombatChoice && !coverageChoice && !raidNormalChoice && generalPool.length > 0 && rng() < explorationConfig.rate
    ? weightedExplorationChoice(generalPool, best.score, rng)
    : null;
  const selected = strategicCombatChoice ?? coverageChoice ?? raidNormalChoice ?? generalChoice;
  if (!selected) return candidates;
  const reason = strategicCombatChoice
    ? counterfactualProbeStrategicPairKind(state, best.action, selected.action, explorationConfig)
    : selected.raidNormalPlay ? "raid-normal-play" : "general";
  return [
    {
      ...selected.action,
      autoplayExploration: {
        reason,
        mode: "action",
        alternativeIndex: selected.index,
        originalRank: rankedIndex(scored, selected),
        score: selected.score,
        baselineScore: selected.baselineScore,
        bestScore: best.score,
        bestBaselineScore,
        evidenceStatus: selected.explorationEvidence.status,
        evidenceObservations: selected.explorationEvidence.observations,
        evidenceAttempts: selected.explorationEvidence.attempts,
        evidenceTarget: selected.explorationEvidence.targetObservations,
        evidenceFeatureCount: selected.explorationEvidence.featureCount,
        evidenceFeatures: selected.explorationEvidence.features,
        noveltyMultiplier: selected.explorationEvidence.noveltyMultiplier,
        selectionMode: strategicCombatChoice
          ? "strategic-combat"
          : coverageChoice
            ? "coverage-gap"
            : selected.explorationEvidence.evidenceAvailable && selected.explorationEvidence.hasContext
              ? "evidence-aware"
              : "score-weighted"
      }
    },
    ...candidates.filter((_, index) => index !== selected.index)
  ];
}

function rankedIndex(scored, candidate) {
  return scored.findIndex((item) => item.index === candidate.index) + 1;
}

function weightedExplorationChoice(pool, bestScore, rng, { raidNormalBias = 1, useBaselineScore = false } = {}) {
  const weighted = pool.map((candidate) => {
    const candidateScore = Number(useBaselineScore ? candidate.baselineScore : candidate.score) || 0;
    const closeness = Math.exp(Math.max(-8, (candidateScore - bestScore) / 90));
    const novelty = Number(candidate.explorationEvidence?.noveltyMultiplier ?? 1);
    const attempts = Math.max(0, Number(candidate.explorationEvidence?.attempts ?? 0));
    const attemptRotation = 1 / (1 + attempts);
    const weight = closeness * novelty * attemptRotation * (candidate.raidNormalPlay ? raidNormalBias : 1);
    return { ...candidate, weight };
  });
  const total = weighted.reduce((sum, candidate) => sum + candidate.weight, 0);
  let roll = rng() * total;
  for (const candidate of weighted) {
    roll -= candidate.weight;
    if (roll <= 0) return candidate;
  }
  return weighted.at(-1) ?? null;
}

function pairwiseActionExplorationEvidence(
  selectedFeatures = {},
  alternativeFeatures = {},
  evidence = null,
  noveltyStrength = DEFAULT_ACTION_EXPLORATION.noveltyStrength
) {
  const featureNames = new Set([
    ...Object.keys(selectedFeatures ?? {}),
    ...Object.keys(alternativeFeatures ?? {})
  ]);
  const contextualDifferences = {};
  for (const feature of featureNames) {
    if (!feature.startsWith(CONTEXTUAL_ACTION_FEATURE_PREFIX)) continue;
    if (Number(selectedFeatures?.[feature] ?? 0) === Number(alternativeFeatures?.[feature] ?? 0)) continue;
    contextualDifferences[feature] = 1;
  }
  return actionExplorationEvidence(contextualDifferences, evidence, noveltyStrength);
}

export function actionExplorationEvidence(features = {}, evidence = null, noveltyStrength = DEFAULT_ACTION_EXPLORATION.noveltyStrength) {
  const contextualFeatures = Object.entries(features ?? {})
    .filter(([feature, value]) => feature.startsWith(CONTEXTUAL_ACTION_FEATURE_PREFIX) && Number(value ?? 0) !== 0)
    .map(([feature]) => feature)
    .sort((left, right) => left.localeCompare(right));
  const normalizedEvidence = normalizeActionExplorationEvidence(evidence);
  if (contextualFeatures.length === 0) {
    return {
      evidenceAvailable: Boolean(normalizedEvidence),
      hasContext: false,
      status: "no-context",
      observations: null,
      attempts: null,
      targetObservations: normalizedEvidence?.targetObservations ?? MIN_ML_RUNTIME_CONTEXTUAL_FEATURE_OBSERVATIONS,
      featureCount: 0,
      features: [],
      noveltyMultiplier: 1
    };
  }
  if (!normalizedEvidence) {
    return {
      evidenceAvailable: false,
      hasContext: true,
      status: "unavailable",
      observations: null,
      attempts: null,
      targetObservations: MIN_ML_RUNTIME_CONTEXTUAL_FEATURE_OBSERVATIONS,
      featureCount: contextualFeatures.length,
      features: contextualFeatures.slice(0, 8),
      noveltyMultiplier: 1
    };
  }
  const observations = Math.min(...contextualFeatures.map((feature) => (
    Number(normalizedEvidence.featureObservations[feature] ?? 0)
  )));
  const attempts = Math.min(...contextualFeatures.map((feature) => (
    Number(normalizedEvidence.featureAttempts[feature] ?? 0)
  )));
  const targetObservations = normalizedEvidence.targetObservations;
  const supportRate = clampNumber(observations / Math.max(1, targetObservations), 0, 1);
  const strength = clampNumber(Number(noveltyStrength ?? 0), 0, 5);
  return {
    evidenceAvailable: true,
    hasContext: true,
    status: observations <= 0 ? "unseen" : observations < targetObservations ? "collecting" : "graduated",
    observations,
    attempts,
    targetObservations,
    featureCount: contextualFeatures.length,
    features: contextualFeatures.slice(0, 8),
    noveltyMultiplier: Number((1 + strength * (1 - supportRate)).toFixed(6))
  };
}

function normalizeActionExplorationEvidence(evidence) {
  if (!evidence || typeof evidence !== "object") return null;
  if (evidence.normalized === true) return evidence;
  const rawObservations = evidence.featureObservations ?? evidence.observations ?? {};
  const rawAttempts = evidence.featureAttempts ?? evidence.attempts ?? {};
  const featureObservations = Object.fromEntries(Object.entries(rawObservations)
    .filter(([feature]) => String(feature).startsWith(CONTEXTUAL_ACTION_FEATURE_PREFIX))
    .map(([feature, observations]) => [feature, Math.max(0, Number(observations ?? 0))])
    .filter(([, observations]) => Number.isFinite(observations)));
  const featureAttempts = Object.fromEntries(Object.entries(rawAttempts)
    .filter(([feature]) => String(feature).startsWith(CONTEXTUAL_ACTION_FEATURE_PREFIX))
    .map(([feature, attempts]) => [feature, Math.max(0, Number(attempts ?? 0))])
    .filter(([, attempts]) => Number.isFinite(attempts)));
  return {
    normalized: true,
    version: Number(evidence.version ?? 1),
    source: evidence.source ?? null,
    targetObservations: Math.max(
      MIN_ML_RUNTIME_CONTEXTUAL_FEATURE_OBSERVATIONS,
      Number(evidence.targetObservations ?? MIN_ML_RUNTIME_CONTEXTUAL_FEATURE_OBSERVATIONS)
    ),
    featureObservations,
    featureAttempts
  };
}

function isExplorableAction(action) {
  return [
    "activateMainAbility",
    "playCard",
    "performRaid",
    "declareAttack",
    "declareBlock",
    "declineBlock",
    "moveCharacters"
  ].includes(action?.type);
}

function isCounterfactualProbePassAlternative(state, selectedAction, alternativeAction, explorationConfig) {
  return counterfactualProbeStrategicPairKind(state, selectedAction, alternativeAction, explorationConfig) === "attack-vs-pass";
}

function counterfactualProbeStrategicPairKind(state, selectedAction, alternativeAction, explorationConfig) {
  if (explorationConfig?.mode !== "counterfactual-probe") return null;
  const selectedType = selectedAction?.type;
  const alternativeType = alternativeAction?.type;
  if (state.pendingAttack
    && ((selectedType === "declareBlock" && alternativeType === "declineBlock")
      || (selectedType === "declineBlock" && alternativeType === "declareBlock"))) {
    return "block-vs-life";
  }
  if (state.phase === PHASES.ATTACK
    && !state.pendingAttack
    && ((selectedType === "declareAttack" && alternativeType === "advancePhase")
      || (selectedType === "advancePhase" && alternativeType === "declareAttack"))) {
    return "attack-vs-pass";
  }
  const branchPair = counterfactualPairKind(selectedAction, alternativeAction);
  if (["raid-placement", "field-replacement-choice"].includes(branchPair)) return branchPair;
  return null;
}

function isRaidNormalPlayAlternative(state, playerId, action, candidates) {
  if (action?.type !== "playCard" || !Number.isInteger(action.handIndex)) return false;
  const card = state.players[playerId]?.hand?.[action.handIndex];
  const def = state.catalog[card?.defId];
  if (!def?.raid) return false;
  return candidates.some((candidate) => {
    return candidate?.type === "performRaid"
      && candidate.handIndex === action.handIndex;
  });
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function policyForDecision(state, playerId, basePolicy, matchupConfig, deckFingerprints = []) {
  const selected = selectedMatchupOverlay(state, playerId, matchupConfig, deckFingerprints);
  if (!selected) return basePolicy;
  return blendPilotPolicyWithMatchupOverlay(basePolicy, selected.overlay, {
    strength: matchupConfig.strength,
    confidence: selected.confidence,
    name: `${basePolicy.name}+${selected.overlay.name}`,
    allowUnvalidated: matchupConfig.allowUnvalidated
  });
}

function selectedMatchupOverlay(state, playerId, matchupConfig, deckFingerprints = []) {
  if (!matchupConfig?.enabled) return null;
  const profile = publicOpponentProfile(state, playerId, matchupProfileOptions(matchupConfig, deckFingerprints));
  if (!profile.known || profile.confidence < matchupConfig.minConfidence) return null;
  const selection = matchupOverlaySelectionForProfile(profile, matchupConfig);
  if (!selection) return null;
  return {
    ...selection.entry,
    profile,
    opponentKey: selection.key,
    confidence: selection.confidence
  };
}

function matchupProfileOptions(matchupConfig, deckFingerprints = []) {
  return {
    deckFingerprints,
    knownDeckVariants: matchupConfig?.knownDeckVariants === true,
    variantMinDeckConfidence: matchupConfig?.variantMinDeckConfidence ?? 0.55,
    variantMinObservedCoverage: matchupConfig?.variantMinObservedCoverage ?? 0.75,
    unknownVariantMinEvidence: matchupConfig?.unknownVariantMinEvidence ?? 4
  };
}

function matchupOverlaySelectionForProfile(profile, matchupConfig) {
  const keys = [
    profile.variantKey && profile.variantKey !== profile.key ? {
      key: profile.variantKey,
      confidence: Math.max(profile.confidence, profile.variantConfidence ?? 0)
    } : null,
    {
      key: profile.key,
      confidence: profile.confidence
    }
  ].filter(Boolean);

  const seen = new Set();
  for (const candidate of keys) {
    if (!candidate.key || seen.has(candidate.key)) continue;
    seen.add(candidate.key);
    const entry = matchupConfig.overlays[candidate.key];
    if (entry && matchupOverlayRuntimeTrust(entry.overlay, {
      allowUnvalidated: matchupConfig.allowUnvalidated
    }) > 0) return { ...candidate, entry };
  }
  return null;
}

function resolveAutoplayResolutionChoice({
  state,
  playerId,
  effect,
  context,
  request,
  policy,
  explorationConfig,
  explorationRng,
  step,
  matchupConfig,
  matchupDeckFingerprints,
  records
}) {
  const rawCandidates = nestedResolutionCandidates(state, playerId, effect, context, request);
  if (rawCandidates.length === 0) return {};
  const sourceCardId = context.sourceDef?.id ?? context.card?.defId ?? request.cards?.[0]?.defId ?? "unknown";
  const candidates = dedupeNestedResolutionCandidates(rawCandidates)
    .slice(0, MAX_NESTED_RESOLUTION_CANDIDATES)
    .map((candidate, index) => {
      const features = nestedResolutionFeatures(state, playerId, effect, context, request, candidate.choices, sourceCardId);
      const learnedScore = Object.entries(features).reduce((total, [feature, value]) => {
        return total + Number(policy?.weights?.[feature] ?? 0) * Number(value ?? 0);
      }, 0);
      return {
        ...candidate,
        index,
        features,
        action: nestedResolutionAction(effect, request, candidate.choices, sourceCardId),
        explorationEvidence: actionExplorationEvidence(
          features,
          explorationConfig?.evidence,
          explorationConfig?.noveltyStrength
        ),
        score: Number(candidate.heuristic ?? 0) + learnedScore
      };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index);
  for (const candidate of candidates) {
    if (candidate === candidates[0]) continue;
    candidate.explorationEvidence = pairwiseActionExplorationEvidence(
      candidates[0].features,
      candidate.features,
      explorationConfig?.evidence,
      explorationConfig?.noveltyStrength
    );
  }
  let selected = candidates[0];
  let explorationEvidence = null;
  const explorationRate = Math.min(0.25, Math.max(0, Number(explorationConfig?.rate ?? 0)));
  const explorationPool = nestedResolutionExplorationPool(candidates, explorationConfig);
  if (explorationPool.length > 0 && explorationRate > 0 && explorationRng() < explorationRate) {
    selected = weightedExplorationChoice(explorationPool, Number(candidates[0]?.score ?? 0), explorationRng);
    explorationEvidence = {
      reason: "nested-resolution-exploration",
      mode: "action",
      decisionKind: request.kind,
      alternativeIndex: candidates.indexOf(selected),
      evidenceStatus: selected.explorationEvidence.status,
      evidenceObservations: selected.explorationEvidence.observations,
      evidenceAttempts: selected.explorationEvidence.attempts,
      evidenceTarget: selected.explorationEvidence.targetObservations,
      evidenceFeatureCount: selected.explorationEvidence.featureCount,
      evidenceFeatures: selected.explorationEvidence.features,
      noveltyMultiplier: selected.explorationEvidence.noveltyMultiplier,
      selectionMode: selected.explorationEvidence.evidenceAvailable
        && selected.explorationEvidence.hasContext
        && selected.explorationEvidence.status !== "graduated"
        ? "coverage-gap"
        : "score-weighted"
    };
  }

  for (const candidate of candidates) {
    candidate.counterfactualExplorationEvidence = pairwiseActionExplorationEvidence(
      selected.features,
      candidate.features,
      explorationConfig?.evidence,
      explorationConfig?.noveltyStrength
    );
  }

  if (records) {
    const profileOptions = matchupProfileOptions(matchupConfig, matchupDeckFingerprints);
    const profile = publicOpponentProfile(state, playerId, profileOptions);
    records.push({
      step,
      player: playerId,
      opponent: opponentOf(playerId),
      state: decisionStateSummary(state, playerId),
      matchupProfile: profile,
      matchupOverlayPath: matchupOverlaySelectionForProfile(profile, matchupConfig)?.entry?.path ?? null,
      counterfactual: null,
      exploration: explorationEvidence,
      chosenIndex: candidates.indexOf(selected),
      chosenAction: selected.action,
      selectedChoices: structuredClone(selected.choices),
      candidates: candidates.map((candidate, index) => ({
        index,
        chosen: candidate === selected,
        action: candidate.action,
        choices: structuredClone(candidate.choices),
        score: candidate.score,
        features: candidate.features,
        explorationEvidence: candidate.explorationEvidence,
        counterfactualExplorationEvidence: candidate.counterfactualExplorationEvidence
      }))
    });
  }
  return selected.choices;
}

function nestedResolutionAction(effect, request, choices, sourceCardId) {
  return {
    type: "resolutionChoice",
    decisionKind: request.kind,
    resolutionOption: nestedResolutionOption(effect, request, choices),
    sourceCardId
  };
}

function nestedResolutionOption(effect, request, choices = {}) {
  const kind = request.kind;
  if (kind === "optionalEffect") {
    return choices[request.choiceKey ?? "optionalEffect"] ? "accept" : "decline";
  }
  if (kind === "raidTrigger") {
    if (choices.performRaid === false) return "decline";
    if (choices.moveToFront && choices.replaceIndex) return "raid-move-replace";
    if (choices.moveToFront) return "raid-move-front";
    return "raid-stay";
  }
  if (kind === "playSourceFromZone") {
    const destination = choices[request.destinationLineChoiceKey ?? effect.destinationLineChoiceKey ?? "destinationLine"] ?? "field";
    return choices[request.replaceChoiceKey ?? effect.replaceChoiceKey ?? "replaceIndex"]
      ? `play-${destination}-replace`
      : `play-${destination}`;
  }
  if (kind === "raidSourceFromZone") {
    const moves = choices[effect.moveChoiceKey ?? "moveToFront"];
    const replaces = choices[effect.moveReplaceChoiceKey ?? effect.replaceChoiceKey ?? "replaceIndex"];
    if (moves && replaces) return "raid-move-replace";
    if (moves) return "raid-move-front";
    return "raid-stay";
  }
  if (kind === "searchTopDeck") {
    const selected = choices[effect.choiceKey ?? "searchIndices"] ?? [];
    const selectedCount = Array.isArray(selected) ? selected.length : selected === undefined ? 0 : 1;
    const alternative = effect.selectedAlternative;
    if (alternative && choices[alternative.choiceKey ?? "searchPlayInstead"]) {
      return choices[alternative.raidChoiceKey ?? "performRaid"]
        ? `select-${selectedCount}-raid`
        : `select-${selectedCount}-play`;
    }
    return `select-${selectedCount}`;
  }
  if (kind === "lookTopDeckAndMove") {
    const placements = choices[effect.choiceKey ?? "lookTopDeckPlacements"] ?? [];
    return `place-${nestedDestinationCountOption(placements.map((placement) => placement.destination))}`;
  }
  if (kind === "lookTopDeckPlayOneAndMoveRest") {
    const selected = Number(choices[effect.choiceKey ?? "lookPlayIndex"] ?? -1);
    if (selected < 0) return "decline";
    return choices[effect.raidChoiceKey ?? "performRaid"] ? "raid" : "play";
  }
  if (kind === "revealTopDeckOptionalPlayOrRaidInstead") {
    const accepts = choices[effect.choiceKey ?? "optionalRevealPlay"];
    if (!accepts) return `decline-${choices[effect.placementChoiceKey ?? "revealedPlacement"] ?? "default"}`;
    return choices[effect.raidChoiceKey ?? "performRaid"] ? "raid" : "play";
  }
  if (kind === "opponentMayDraw") {
    const amount = Number(choices[effect.choiceKey ?? "opponentDrawAmount"] ?? 0);
    return amount > 0 ? `draw-${amount}` : "decline";
  }
  if (kind === "opponentMayMoveCardsBetweenZonesElse") {
    return choices[effect.choiceKey ?? "opponentZoneMoveChoice"] ? "move" : "decline";
  }
  if (kind === "opponentMaySidelineChosenTargetsElse") {
    return choices[effect.choiceKey ?? "opponentSidelineChoice"] === false ? "decline" : "sideline";
  }
  if (kind === "chooseRevealedZoneCards") {
    const selected = choices[request.choiceKey];
    return `select-${Array.isArray(selected) ? selected.length : selected ? 1 : 0}`;
  }
  if (kind === "opponentMayPlayCardFromHand") {
    const selected = choices[request.choiceKey];
    const count = Array.isArray(selected) ? selected.length : selected ? 1 : 0;
    if (count === 0) return "decline";
    const destination = choices[effect.destinationLineChoiceKey ?? "destinationLine"] ?? effect.destinationLine ?? "field";
    return choices[effect.replaceChoiceKey ?? "replaceIndex"]
      ? `play-${destination}-replace`
      : `play-${destination}`;
  }
  return "choice";
}

function nestedDestinationCountOption(destinations = []) {
  if (destinations.length === 0) return "none";
  const counts = new Map();
  for (const destination of destinations) counts.set(destination, Number(counts.get(destination) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([left], [right]) => String(left).localeCompare(String(right)))
    .map(([destination, count]) => `${destination}-${count}`)
    .join("-");
}

function nestedResolutionExplorationPool(candidates, explorationConfig = {}) {
  const best = candidates[0];
  if (!best) return [];
  const scoreWindow = Math.max(1, Number(explorationConfig?.scoreWindow ?? DEFAULT_ACTION_EXPLORATION.scoreWindow));
  const minScore = Number(explorationConfig?.minScore ?? DEFAULT_ACTION_EXPLORATION.minScore);
  const maxRank = Math.max(1, Number(explorationConfig?.maxRank ?? DEFAULT_ACTION_EXPLORATION.maxRank));
  const eligible = candidates.filter((candidate, index) => (
    candidate !== best
    && index < maxRank
    && candidate.score >= best.score - scoreWindow
    && candidate.score >= minScore
  ));
  const coverage = eligible.filter((candidate) => (
    candidate.explorationEvidence?.evidenceAvailable
    && candidate.explorationEvidence?.hasContext
    && candidate.explorationEvidence?.status !== "graduated"
  ));
  return coverage.length > 0 ? coverage : eligible;
}

function nestedResolutionCandidates(state, playerId, effect, context, request) {
  switch (request.kind) {
    case "optionalEffect":
      return nestedOptionalEffectCandidates(state, playerId, effect, request);
    case "playSourceFromZone":
      return nestedPlaySourceCandidates(state, playerId, effect, request);
    case "playCardFromZone":
      return nestedPlayCardFromZoneCandidates(state, playerId, effect, context, request);
    case "raidTrigger":
      return nestedRaidTriggerCandidates(state, playerId, request);
    case "searchTopDeck":
      return nestedSearchCandidates(state, playerId, effect, request);
    case "lookTopDeckAndMove":
      return nestedLookPlacementCandidates(state, effect, request);
    case "lookTopDeckPlayOneAndMoveRest":
      return nestedLookPlayCandidates(state, playerId, effect, request);
    case "revealTopDeckOptionalPlayOrRaidInstead":
      return nestedRevealPlayCandidates(state, playerId, effect, context, request);
    case "raidSourceFromZone":
      return nestedRaidSourceCandidates(state, playerId, effect, request);
    case "opponentMayDraw":
      return nestedOpponentDrawCandidates(effect, request);
    case "opponentMayMoveCardsBetweenZonesElse":
      return nestedOpponentZoneMoveCandidates(state, playerId, effect, request);
    case "opponentMaySidelineChosenTargetsElse":
      return nestedOpponentSidelineCandidates(state, playerId, effect, request);
    case "chooseRevealedZoneCards":
      return nestedRevealedZoneCardCandidates(state, playerId, request);
    case "opponentMayPlayCardFromHand":
      return nestedOpponentHandPlayCandidates(state, playerId, effect, request);
    default:
      return [];
  }
}

function nestedOptionalEffectCandidates(state, playerId, effect, request) {
  const choiceKey = request.choiceKey ?? effect.choiceKey ?? "optionalEffect";
  const candidates = [{ choices: { [choiceKey]: false }, heuristic: 0 }];
  if (request.canResolve !== false) {
    candidates.push({
      choices: { [choiceKey]: true },
      heuristic: effectScore(state, playerId, effect.effect)
    });
  }
  return candidates;
}

function nestedPlaySourceCandidates(state, playerId, effect, request) {
  const destinationLines = request.destinationLines?.length
    ? request.destinationLines
    : effect.destinationLines?.length ? effect.destinationLines : [effect.destinationLine ?? LINES.FRONT];
  const candidates = [];
  for (const destinationLine of destinationLines) {
    const baseChoices = {
      [request.destinationLineChoiceKey ?? effect.destinationLineChoiceKey ?? "destinationLine"]: destinationLine
    };
    for (const choices of choicesWithDestinationLineReplacements(
      state,
      playerId,
      effect,
      baseChoices,
      [destinationLine]
    )) {
      const card = request.cards?.[0];
      const def = card ? state.catalog[card.defId] : undefined;
      const lineValue = destinationLine === LINES.ENERGY
        ? 100 + 80 * Number(def?.energy?.reduce((total, entry) => total + Number(entry.amount ?? 0), 0) ?? 0)
        : 120 + Number(def?.bp ?? 0) / 20;
      candidates.push({ choices, heuristic: lineValue });
    }
  }
  return candidates;
}

function nestedPlayCardFromZoneCandidates(state, playerId, effect, context, request) {
  const entries = zoneCardChoiceEntries(state, playerId, effect, context.choices ?? {});
  const maximum = Math.min(entries.length, Number(request.count ?? effect.count ?? effect.amount ?? effect.max ?? 1));
  const minimum = Math.min(maximum, Math.max(0, Number(request.minimum ?? effect.min ?? maximum)));
  const indexed = entries.map((entry, index) => ({ card: entry.card, index }));
  const destinationPlayerId = effect.player === "opponent" ? opponentOf(playerId) : effect.player ?? playerId;
  const candidates = [];

  for (const positions of boundedCardIndexSelections(indexed, {
    min: minimum,
    max: maximum,
    uniqueNames: Boolean(effect.uniqueNames),
    state
  })) {
    const selected = positions.map((position) => stableZoneCardChoice(entries[position]));
    if (selected.length === 0) {
      candidates.push({
        choices: {
          ...(context.choices ?? {}),
          [request.choiceKey ?? effect.choiceKey ?? `${effect.zone ?? effect.zones?.[0] ?? "hand"}Index`]: []
        },
        heuristic: 0
      });
      continue;
    }

    for (const destinationLines of playDestinationLinePlans(effect, selected.length)) {
      const baseChoices = structuredClone(context.choices ?? {});
      baseChoices[request.choiceKey ?? effect.choiceKey ?? `${effect.zone ?? effect.zones?.[0] ?? "hand"}Index`] = maximum > 1 || effect.simultaneous
        ? selected
        : selected[0];
      assignPlayDestinationLineChoice(baseChoices, effect, destinationLines);
      for (const choices of choicesWithDestinationLineReplacements(
        state,
        destinationPlayerId,
        effect,
        baseChoices,
        destinationLines
      )) {
        const replacementKey = request.replaceChoiceKey ?? effect.replaceChoiceKey ?? "replaceIndex";
        const rawReplacements = choices[replacementKey];
        const replacements = Array.isArray(rawReplacements) ? rawReplacements : [rawReplacements];
        const selectedValue = positions.reduce((total, position) => total + cardValue(state, entries[position].card), 0);
        const lineValue = positions.reduce((total, position, index) => {
          const def = state.catalog[entries[position].card.defId];
          const lineName = destinationLines[index];
          if (lineName === LINES.ENERGY) {
            const energy = (def?.energy ?? []).reduce((sum, icon) => sum + Number(icon.amount ?? 0), 0);
            return total + 80 + energy * 120;
          }
          return total + 140 + Number(def?.bp ?? 0) / 20;
        }, 0);
        const replacementCost = destinationLines.reduce((total, lineName, index) => {
          const permanent = actionReplacementPermanent(state, destinationPlayerId, lineName, replacements[index]);
          return total + replacementPermanentValue(state, permanent);
        }, 0);
        candidates.push({ choices, heuristic: selectedValue + lineValue - replacementCost });
        if (candidates.length >= MAX_NESTED_RAW_CANDIDATES) return candidates;
      }
    }
  }
  return candidates;
}

function nestedRaidTriggerCandidates(state, playerId, request) {
  const card = request.cards?.[0];
  const def = state.catalog[card?.defId];
  const candidates = [{
    choices: { performRaid: false },
    heuristic: cardValue(state, card)
  }];
  for (const target of request.raidTargets ?? []) {
    const permanent = state.players[playerId]?.[target.line]?.[target.index];
    for (const movement of raidMovementPlansForTargets(state, playerId, [def], [true], [target])) {
      const choices = {
        performRaid: true,
        raidTarget: target,
        moveToFront: movement.moves[0]
      };
      if (movement.replacements[0]) choices.replaceIndex = movement.replacements[0];
      const replaced = actionReplacementPermanent(state, playerId, LINES.FRONT, movement.replacements[0]);
      candidates.push({
        choices,
        heuristic: cardValue(state, card)
          + 220
          + Math.max(0, Number(def?.bp ?? 0) - permanentBattlePower(state, permanent)) / 5
          + (movement.moves[0] ? 100 : 0)
          - replacementPermanentValue(state, replaced)
      });
    }
  }
  return candidates;
}

function nestedSearchCandidates(state, playerId, effect, request) {
  const cards = request.cards ?? [];
  const max = Math.min(cards.length, Number(effect.max ?? effect.amount ?? 1));
  const min = Math.min(max, Number(effect.min ?? 0));
  const eligible = cards
    .map((card, index) => ({ card, index }))
    .filter(({ card }) => zoneCardMatches(state, card, effect.filter ?? {}));
  const selections = nestedBoundedCardIndexSelections(eligible, { min, max, uniqueNames: Boolean(effect.uniqueNames), state });
  const candidates = [];
  for (const selected of selections) {
    const baseChoices = { [effect.choiceKey ?? "searchIndices"]: selected };
    const remainingIndices = cards.map((_, index) => index).filter((index) => !selected.includes(index));
    const destinationPlans = nestedRemainingDestinationPlans(state, effect, cards, remainingIndices);
    const alternativePlans = nestedSearchAlternativePlans(state, playerId, effect, cards, selected);
    for (const destinations of destinationPlans) {
      const placementChoices = structuredClone(baseChoices);
      if (destinations) placementChoices[effect.remainingDestinationChoiceKey ?? "searchRemainingDestinations"] = destinations;
      const orderPlans = nestedSearchOrderPlans(state, effect, cards, remainingIndices, destinations);
      const placementValue = destinations
        ? destinations.reduce((total, destination, offset) => total + nestedDestinationUtility(state, cards[remainingIndices[offset]], destination), 0)
        : 0;
      const selectedValue = selected.reduce((total, index) => total + cardValue(state, cards[index]), 0);
      for (const orderPlan of orderPlans) {
        for (const alternativePlan of alternativePlans) {
          candidates.push({
            choices: {
              ...placementChoices,
              ...orderPlan.choices,
              ...alternativePlan.choices
            },
            heuristic: selectedValue + placementValue + orderPlan.heuristic + alternativePlan.heuristic
          });
          if (candidates.length >= MAX_NESTED_RAW_CANDIDATES) return candidates;
        }
      }
    }
  }
  return candidates;
}

function nestedBoundedCardIndexSelections(entries, { min = 0, max = 1, uniqueNames = false, state } = {}) {
  const selections = [];
  const visit = (offset, selected, names) => {
    if (selections.length >= 128) return;
    if (selected.length >= min) selections.push([...selected].sort((left, right) => left - right));
    if (selected.length >= max) return;
    for (let index = offset; index < entries.length; index += 1) {
      const entry = entries[index];
      const name = state.catalog[entry.card?.defId]?.name?.toLowerCase() ?? null;
      if (uniqueNames && name && names.has(name)) continue;
      selected.push(entry.index);
      if (name) names.add(name);
      visit(index + 1, selected, names);
      if (name) names.delete(name);
      selected.pop();
      if (selections.length >= 128) return;
    }
  };
  visit(0, [], new Set());
  return selections;
}

function nestedSearchAlternativePlans(state, playerId, effect, cards, selected) {
  const alternative = effect.selectedAlternative;
  if (!alternative) return [{ choices: {}, heuristic: 0 }];
  const choiceKey = alternative.choiceKey ?? "searchPlayInstead";
  const decline = { choices: { [choiceKey]: false }, heuristic: 0 };
  if (selected.length !== 1) return [decline];
  const card = cards[selected[0]];
  if (!card || !zoneCardMatches(state, card, alternative.filter ?? {}, { playerId })) return [decline];
  const cardBaseline = cardValue(state, card);
  const playPlans = nestedPlayCardCandidates(state, playerId, alternative, card, { [choiceKey]: true })
    .map((plan) => ({
      choices: plan.choices,
      heuristic: Number(plan.heuristic ?? cardBaseline) - cardBaseline
    }));
  return [decline, ...playPlans];
}

function nestedSearchOrderPlans(state, effect, cards, remainingIndices, destinations) {
  const topIndices = [];
  const bottomIndices = [];
  remainingIndices.forEach((cardIndex, offset) => {
    const destination = destinations?.[offset]
      ?? effect.remainingDestination
      ?? effect.defaultRemainingDestination
      ?? "bottom";
    if (destination === "top") topIndices.push(cardIndex);
    if (destination === "bottom") bottomIndices.push(cardIndex);
  });
  const topPlans = nestedCardOrderPlans(state, cards, topIndices);
  const bottomPlans = nestedCardOrderPlans(state, cards, bottomIndices);
  const plans = [];
  for (const topPlan of topPlans) {
    for (const bottomPlan of bottomPlans) {
      const choices = {};
      if (topIndices.length > 1) choices[effect.topOrderChoiceKey ?? "searchTopOrder"] = topPlan.order;
      if (bottomIndices.length > 1) choices[effect.bottomOrderChoiceKey ?? "bottomOrder"] = bottomPlan.order;
      plans.push({ choices, heuristic: topPlan.heuristic + bottomPlan.heuristic });
    }
  }
  return plans;
}

function nestedCardOrderPlans(state, cards, indices) {
  if (indices.length <= 1) return [{ order: indices.map((index) => stableNestedCardChoice(cards[index], index)), heuristic: 0 }];
  const variants = [
    [...indices],
    [...indices].sort((left, right) => cardValue(state, cards[right]) - cardValue(state, cards[left]) || left - right),
    [...indices].sort((left, right) => cardValue(state, cards[left]) - cardValue(state, cards[right]) || left - right),
    [...indices].reverse()
  ];
  const seen = new Set();
  return variants.filter((order) => {
    const key = order.join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((order) => ({
    order: order.map((index) => stableNestedCardChoice(cards[index], index)),
    heuristic: order.reduce((total, index, offset) => (
      total + cardValue(state, cards[index]) * (order.length - offset) / order.length * 0.02
    ), 0)
  }));
}

function stableNestedCardChoice(card, index) {
  return { index, uid: card?.uid };
}

function nestedRemainingDestinationPlans(state, effect, cards, remainingIndices) {
  if (!effect.remainingDestinations) return [undefined];
  const allowed = effect.remainingDestinations;
  const preferred = remainingIndices.map((index) => [...allowed]
    .sort((left, right) => nestedDestinationUtility(state, cards[index], right) - nestedDestinationUtility(state, cards[index], left))[0]);
  const plans = [preferred];
  for (let offset = 0; offset < remainingIndices.length && plans.length < MAX_NESTED_RESOLUTION_CANDIDATES; offset += 1) {
    for (const destination of allowed) {
      if (destination === preferred[offset]) continue;
      const alternate = [...preferred];
      alternate[offset] = destination;
      plans.push(alternate);
      if (plans.length >= MAX_NESTED_RESOLUTION_CANDIDATES) break;
    }
  }
  return plans;
}

function nestedLookPlacementCandidates(state, effect, request) {
  const cards = request.cards ?? [];
  const destinations = effect.destinations ?? [effect.defaultDestination ?? "top"];
  const defaultDestination = effect.defaultDestination ?? "top";
  const plans = [];
  const visit = (index, placements, counts, nonDefaultCount) => {
    if (plans.length >= MAX_NESTED_RESOLUTION_CANDIDATES) return;
    if (index >= cards.length) {
      if (effect.maxNonDefault !== undefined && nonDefaultCount > effect.maxNonDefault) return;
      if (effect.minNonDefault !== undefined && nonDefaultCount < Math.min(effect.minNonDefault, cards.length)) return;
      for (const [destination, max] of Object.entries(effect.maxDestinations ?? {})) {
        if (Number(counts[destination] ?? 0) > Number(max)) return;
      }
      const minimums = Object.entries(effect.minDestinations ?? {});
      if (cards.length >= minimums.reduce((sum, [, min]) => sum + Number(min), 0)
        && minimums.some(([destination, min]) => Number(counts[destination] ?? 0) < Number(min))) return;
      plans.push([...placements]);
      return;
    }
    const ranked = [...destinations].sort((left, right) => (
      nestedDestinationUtility(state, cards[index], right) - nestedDestinationUtility(state, cards[index], left)
    ));
    for (const destination of ranked) {
      placements.push({ index, destination });
      counts[destination] = Number(counts[destination] ?? 0) + 1;
      visit(index + 1, placements, counts, nonDefaultCount + (destination === defaultDestination ? 0 : 1));
      counts[destination] -= 1;
      placements.pop();
      if (plans.length >= MAX_NESTED_RESOLUTION_CANDIDATES) return;
    }
  };
  visit(0, [], {}, 0);
  const candidates = [];
  for (const placements of plans) {
    const topIndices = placements.filter((placement) => placement.destination === "top").map((placement) => placement.index);
    const bottomIndices = placements.filter((placement) => placement.destination === "bottom").map((placement) => placement.index);
    for (const topPlan of nestedCardOrderPlans(state, cards, topIndices)) {
      for (const bottomPlan of nestedCardOrderPlans(state, cards, bottomIndices)) {
        const choices = { [effect.choiceKey ?? "lookTopDeckPlacements"]: placements };
        if (topIndices.length > 1) choices[effect.topOrderChoiceKey ?? "lookTopOrder"] = topPlan.order;
        if (bottomIndices.length > 1) choices[effect.bottomOrderChoiceKey ?? "lookBottomOrder"] = bottomPlan.order;
        candidates.push({
          choices,
          heuristic: placements.reduce((total, placement) => total + nestedDestinationUtility(state, cards[placement.index], placement.destination), 0)
            + topPlan.heuristic + bottomPlan.heuristic
        });
        if (candidates.length >= MAX_NESTED_RAW_CANDIDATES) return candidates;
      }
    }
  }
  return candidates;
}

function nestedLookPlayCandidates(state, playerId, effect, request) {
  const cards = request.cards ?? [];
  const playPlans = [{
    choices: { [effect.choiceKey ?? "lookPlayIndex"]: -1 },
    heuristic: cards.reduce((total, card) => total + nestedDestinationUtility(state, card, effect.remainingDestination ?? "bottom"), 0)
  }];
  cards.forEach((card, index) => {
    if (!zoneCardMatches(state, card, effect.filter ?? {})) return;
    playPlans.push(...nestedPlayCardCandidates(state, playerId, effect, card, {
      [effect.choiceKey ?? "lookPlayIndex"]: index
    }));
  });
  const candidates = [];
  for (const playPlan of playPlans) {
    const selectedIndex = Number(playPlan.choices[effect.choiceKey ?? "lookPlayIndex"]);
    const remainingIndices = cards.map((_, index) => index).filter((index) => index !== selectedIndex);
    for (const orderPlan of nestedCardOrderPlans(state, cards, remainingIndices)) {
      const choices = { ...playPlan.choices };
      if (remainingIndices.length > 1) choices[effect.remainingOrderChoiceKey ?? "lookRemainingOrder"] = orderPlan.order;
      candidates.push({ choices, heuristic: Number(playPlan.heuristic ?? 0) + orderPlan.heuristic });
      if (candidates.length >= MAX_NESTED_RAW_CANDIDATES) return candidates;
    }
  }
  return candidates;
}

function nestedRevealPlayCandidates(state, playerId, effect, context, request) {
  const card = request.cards?.[0];
  if (!card) return [];
  const candidates = (effect.destinations ?? [effect.defaultDestination ?? "top"]).map((destination) => ({
    choices: {
      [effect.choiceKey ?? "optionalRevealPlay"]: false,
      [effect.placementChoiceKey ?? "revealedPlacement"]: destination
    },
    heuristic: nestedDestinationUtility(state, card, destination)
  }));
  if (!zoneCardMatches(state, card, effect.filter ?? {}) || !canAutoplayPayEffectCost(state, playerId, effect.costEffect)) return candidates;
  const baseChoices = { [effect.choiceKey ?? "optionalRevealPlay"]: true };
  addChoicesForEffect(baseChoices, state, playerId, effect.costEffect, context.permanent);
  candidates.push(...nestedPlayCardCandidates(state, playerId, effect, card, baseChoices));
  return candidates;
}

function nestedPlayCardCandidates(state, playerId, effect, card, baseChoices) {
  const candidates = [];
  for (const destinationLines of playDestinationLinePlans(effect, 1)) {
    const normalChoices = { ...baseChoices, [effect.raidChoiceKey ?? "performRaid"]: false };
    assignPlayDestinationLineChoice(normalChoices, effect, destinationLines);
    for (const choices of choicesWithDestinationLineReplacements(state, playerId, effect, normalChoices, destinationLines)) {
      candidates.push({ choices, heuristic: cardValue(state, card) + 120 });
    }
  }
  if (!effect.allowRaid) return candidates;
  const def = state.catalog[card.defId];
  for (const target of internals.raidTargetsForCard(state, playerId, def, { sourceKind: "ability" })) {
    const targetPermanent = state.players[playerId]?.[target.lineName]?.[target.index];
    const targetChoice = {
      player: playerId,
      line: target.lineName,
      index: target.index,
      permanentId: targetPermanent?.pid
    };
    for (const movement of raidMovementPlansForTargets(state, playerId, [def], [true], [targetChoice])) {
      const choices = {
        ...baseChoices,
        [effect.raidChoiceKey ?? "performRaid"]: true,
        [effect.raidTargetChoiceKey ?? "raidTarget"]: targetChoice,
        [effect.raidMoveChoiceKey ?? "moveRaidToFront"]: movement.moves[0]
      };
      if (movement.replacements[0]) {
        choices[effect.raidMoveReplaceChoiceKey ?? "raidMoveReplaceIndex"] = movement.replacements[0];
      }
      const replaced = actionReplacementPermanent(state, playerId, LINES.FRONT, movement.replacements[0]);
      const upgrade = Math.max(0, Number(def?.bp ?? 0) - permanentBattlePower(state, targetPermanent));
      candidates.push({
        choices,
        heuristic: cardValue(state, card) + 220 + upgrade / 5 + (movement.moves[0] ? 100 : 0) - replacementPermanentValue(state, replaced)
      });
    }
  }
  return candidates;
}

function nestedRaidSourceCandidates(state, playerId, effect, request) {
  const card = request.cards?.[0];
  const def = state.catalog[card?.defId];
  const candidates = [];
  for (const target of request.raidTargets ?? []) {
    const permanent = state.players[playerId]?.[target.line]?.[target.index];
    for (const movement of raidMovementPlansForTargets(state, playerId, [def], [true], [target])) {
      const choices = {
        [effect.choiceKey ?? "raidTarget"]: target,
        [effect.moveChoiceKey ?? "moveToFront"]: movement.moves[0]
      };
      if (movement.replacements[0]) {
        choices[effect.moveReplaceChoiceKey ?? effect.replaceChoiceKey ?? "replaceIndex"] = movement.replacements[0];
      }
      const replaced = actionReplacementPermanent(state, playerId, LINES.FRONT, movement.replacements[0]);
      candidates.push({
        choices,
        heuristic: Math.max(0, Number(def?.bp ?? 0) - permanentBattlePower(state, permanent)) / 5
          + (movement.moves[0] ? 100 : 0)
          - replacementPermanentValue(state, replaced)
      });
    }
  }
  return candidates;
}

function nestedOpponentDrawCandidates(effect, request) {
  const maximum = Math.max(0, Number(request.maximum ?? effect.amount ?? 1));
  return [...Array(maximum + 1).keys()].map((amount) => ({
    choices: { [effect.choiceKey ?? "opponentDrawAmount"]: amount },
    heuristic: amount * 180
  }));
}

function nestedOpponentZoneMoveCandidates(state, playerId, effect, request) {
  const initiatingPlayerId = request.initiatingPlayerId ?? opponentOf(playerId);
  const declineValue = -effectScore(state, initiatingPlayerId, effect.elseEffect);
  const candidates = [{
    choices: { [effect.choiceKey ?? "opponentZoneMoveChoice"]: false },
    heuristic: declineValue
  }];
  if (!request.canMove) return candidates;
  const entries = (request.matchingIndices ?? []).map((index) => ({ card: request.cards[index], index }));
  for (const selection of boundedCardIndexSelections(entries, { min: request.count, max: request.count, state })) {
    const selectedCards = selection.map((index) => request.cards[index]);
    const movedValue = selectedCards.reduce((total, card) => total + cardValue(state, card), 0);
    candidates.push({
      choices: {
        [effect.choiceKey ?? "opponentZoneMoveChoice"]: true,
        [effect.indicesChoiceKey ?? "opponentZoneMoveIndices"]: selection.map((index) => ({
          player: playerId,
          zone: request.sourceName,
          index,
          uid: request.cards[index]?.uid
        }))
      },
      heuristic: -movedValue - effectScore(state, initiatingPlayerId, effect.ifMovedEffect)
    });
  }
  return candidates;
}

function nestedOpponentSidelineCandidates(state, playerId, effect, request) {
  const initiatingPlayerId = request.initiatingPlayerId ?? opponentOf(playerId);
  const candidates = [{
    choices: { [effect.choiceKey ?? "opponentSidelineChoice"]: false },
    heuristic: -effectScore(state, initiatingPlayerId, effect.elseEffect)
  }];
  (request.targets ?? []).forEach((target, index) => {
    const permanent = state.players[target.player]?.[target.line]?.[target.index];
    if (!permanent) return;
    candidates.push({
      choices: { [effect.choiceKey ?? "opponentSidelineChoice"]: index },
      heuristic: -threatScoreForPermanent(state, permanent)
    });
  });
  return candidates;
}

function nestedRevealedZoneCardCandidates(state, playerId, request) {
  const cards = request.cards ?? [];
  const entries = (request.matchingIndices ?? []).map((index) => ({ card: cards[index], index }));
  const selections = nestedBoundedCardIndexSelections(entries, {
    min: Number(request.min ?? request.max ?? 1),
    max: Number(request.max ?? 1),
    state
  });
  return selections.map((selection) => {
    const selected = selection.map((index) => ({
      player: request.ownerId,
      zone: request.sourceName,
      index,
      uid: cards[index]?.uid
    }));
    return {
      choices: {
        [request.choiceKey]: Number(request.max ?? 1) > 1 ? selected : selected[0]
      },
      heuristic: selection.reduce((total, index) => total + nestedZoneTransferUtility(state, playerId, cards[index], request), 0)
    };
  });
}

function nestedOpponentHandPlayCandidates(state, playerId, effect, request) {
  const cards = request.cards ?? [];
  const entries = (request.matchingIndices ?? []).map((index) => ({ card: cards[index], index }));
  const selections = nestedBoundedCardIndexSelections(entries, {
    min: Number(request.min ?? 0),
    max: Number(request.max ?? 1),
    state
  });
  const candidates = [];
  for (const selection of selections) {
    const selected = selection.map((index) => ({
      player: request.ownerId ?? playerId,
      zone: "hand",
      index,
      uid: cards[index]?.uid
    }));
    for (const destinationLines of playDestinationLinePlans(effect, selected.length)) {
      const baseChoices = {
        [request.choiceKey]: Number(request.max ?? 1) > 1 ? selected : selected[0] ?? []
      };
      assignPlayDestinationLineChoice(baseChoices, effect, destinationLines);
      for (const choices of choicesWithDestinationLineReplacements(state, playerId, effect, baseChoices, destinationLines)) {
        candidates.push({
          choices,
          heuristic: selection.reduce((total, index) => total + cardValue(state, cards[index]) + 120, 0)
        });
      }
    }
  }
  return candidates;
}

function nestedZoneTransferUtility(state, playerId, card, request) {
  const value = cardValue(state, card);
  const zoneFactor = (zone) => ({
    hand: 1,
    life: 0.65,
    sideline: 0.4,
    deck: request.position === "top" ? 0.3 : 0.15,
    removal: 0
  })[zone] ?? 0.25;
  const sourcePerspective = request.ownerId === playerId ? -1 : 1;
  const destinationPerspective = request.destinationPlayerId === playerId ? 1 : -1;
  return value * (
    sourcePerspective * zoneFactor(request.sourceName)
    + destinationPerspective * zoneFactor(request.destinationName)
  );
}

function nestedDestinationUtility(state, card, destination) {
  const value = cardValue(state, card);
  if (destination === "hand") return value;
  if (destination === "top") return value / 5;
  if (destination === "bottom") return (300 - value) / 5;
  if (destination === "sideline") return value / 8;
  if (destination === "removal") return -value / 4;
  if (destination === "underSelf") return value / 10;
  return 0;
}

function nestedResolutionFeatures(state, playerId, effect, context, request, choices, sourceCardId) {
  const features = { baseScore: 1, resolutionChoice: 1 };
  addContextFeature(features, "resolution", request.kind);
  addChoiceContextFeatures(features, choices, sourceCardId, `resolution-${request.kind}`, state, playerId, new Set());
  const cards = request.cards ?? [];
  const addCard = (role, index, destination) => {
    const cardId = cards[index]?.defId;
    if (!cardId) return;
    addContextFeature(features, "resolution", sourceCardId, request.kind, role, "card", cardId);
    if (destination) addContextFeature(features, "resolution", sourceCardId, request.kind, role, destination, "card", cardId);
  };
  const choiceCardIndex = (choice) => {
    if (choice?.uid) return cards.findIndex((card) => card.uid === choice.uid);
    return Number(choice?.index ?? choice);
  };
  const addOrderedCards = (role, order) => {
    (order ?? []).forEach((choice, offset) => addCard(`${role}_slot_${offset + 1}`, choiceCardIndex(choice)));
  };
  if (request.kind === "optionalEffect") {
    addContextFeature(
      features,
      "resolution",
      sourceCardId,
      request.kind,
      choices[request.choiceKey ?? effect.choiceKey ?? "optionalEffect"] ? "accept" : "decline"
    );
  } else if (request.kind === "playSourceFromZone") {
    const destination = choices[request.destinationLineChoiceKey ?? effect.destinationLineChoiceKey ?? "destinationLine"]
      ?? effect.destinationLine;
    addCard("play", 0, destination);
  } else if (request.kind === "raidTrigger") {
    if (choices.performRaid === false) {
      addCard("decline", 0, "hand");
    } else {
      addCard("raid", 0, choices.moveToFront ? LINES.FRONT : choices.raidTarget?.line);
      const replaced = actionReplacementPermanent(state, playerId, LINES.FRONT, choices.replaceIndex);
      const replacedCardId = permanentCardDefId(replaced);
      if (replacedCardId) addContextFeature(features, "resolution", sourceCardId, request.kind, "replace", "card", replacedCardId);
    }
  } else if (request.kind === "searchTopDeck") {
    for (const index of choices[effect.choiceKey ?? "searchIndices"] ?? []) addCard("selected", index);
    const selected = new Set(choices[effect.choiceKey ?? "searchIndices"] ?? []);
    const remaining = cards.map((_, index) => index).filter((index) => !selected.has(index));
    (choices[effect.remainingDestinationChoiceKey ?? "searchRemainingDestinations"] ?? []).forEach((destination, offset) => {
      addCard("remaining", remaining[offset], destination);
    });
    addOrderedCards("top", choices[effect.topOrderChoiceKey ?? "searchTopOrder"]);
    addOrderedCards("bottom", choices[effect.bottomOrderChoiceKey ?? "bottomOrder"]);
    if (effect.selectedAlternative) {
      const selectedIndex = choices[effect.choiceKey ?? "searchIndices"]?.[0];
      const role = choices[effect.selectedAlternative.choiceKey ?? "searchPlayInstead"]
        ? choices[effect.selectedAlternative.raidChoiceKey ?? "performRaid"] ? "alternative_raid" : "alternative_play"
        : "alternative_keep";
      if (Number.isInteger(selectedIndex)) addCard(role, selectedIndex);
    }
  } else if (request.kind === "lookTopDeckAndMove") {
    for (const placement of choices[effect.choiceKey ?? "lookTopDeckPlacements"] ?? []) addCard("placement", placement.index, placement.destination);
    addOrderedCards("top", choices[effect.topOrderChoiceKey ?? "lookTopOrder"]);
    addOrderedCards("bottom", choices[effect.bottomOrderChoiceKey ?? "lookBottomOrder"]);
  } else if (request.kind === "lookTopDeckPlayOneAndMoveRest") {
    const index = choices[effect.choiceKey ?? "lookPlayIndex"];
    if (Number.isInteger(index) && index >= 0) addCard(choices[effect.raidChoiceKey ?? "performRaid"] ? "raid" : "play", index);
    addOrderedCards("remaining", choices[effect.remainingOrderChoiceKey ?? "lookRemainingOrder"]);
  } else if (request.kind === "revealTopDeckOptionalPlayOrRaidInstead") {
    const role = choices[effect.choiceKey ?? "optionalRevealPlay"]
      ? choices[effect.raidChoiceKey ?? "performRaid"] ? "raid" : "play"
      : "decline";
    addCard(role, 0, choices[effect.placementChoiceKey ?? "revealedPlacement"]);
  } else if (request.kind === "raidSourceFromZone") {
    addCard("raid", 0, choices[effect.moveChoiceKey ?? "moveToFront"] ? LINES.FRONT : undefined);
    const replaceChoice = choices[effect.moveReplaceChoiceKey ?? effect.replaceChoiceKey ?? "replaceIndex"];
    const replaced = actionReplacementPermanent(state, playerId, LINES.FRONT, replaceChoice);
    const replacedCardId = permanentCardDefId(replaced);
    if (replacedCardId) addContextFeature(features, "resolution", sourceCardId, request.kind, "replace", "card", replacedCardId);
  } else if (request.kind === "opponentMayDraw") {
    addContextFeature(features, "resolution", sourceCardId, request.kind, "amount", choices[effect.choiceKey ?? "opponentDrawAmount"] ?? 0);
  } else if (request.kind === "opponentMayMoveCardsBetweenZonesElse") {
    for (const selected of choices[effect.indicesChoiceKey ?? "opponentZoneMoveIndices"] ?? []) {
      const index = selected?.uid
        ? cards.findIndex((card) => card.uid === selected.uid)
        : Number(selected?.index ?? selected);
      addCard("payment", index, request.destinationName);
    }
  } else if (request.kind === "opponentMaySidelineChosenTargetsElse") {
    const selected = choices[effect.choiceKey ?? "opponentSidelineChoice"];
    if (Number.isInteger(selected)) {
      const target = request.targets?.[selected];
      const permanent = state.players[target?.player]?.[target?.line]?.[target?.index];
      const cardId = permanentCardDefId(permanent);
      if (cardId) addContextFeature(features, "resolution", sourceCardId, request.kind, "sideline", "card", cardId);
    }
  } else if (request.kind === "chooseRevealedZoneCards") {
    const raw = choices[request.choiceKey];
    const selected = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const choice of selected) addCard("selected", choiceCardIndex(choice), request.destinationName);
  } else if (request.kind === "opponentMayPlayCardFromHand") {
    const raw = choices[request.choiceKey];
    const selected = Array.isArray(raw) ? raw : raw ? [raw] : [];
    if (selected.length === 0) {
      addContextFeature(features, "resolution", sourceCardId, request.kind, "decline");
    } else {
      const rawDestinations = choices[request.destinationLineChoiceKey ?? "destinationLine"];
      selected.forEach((choice, index) => {
        const destination = Array.isArray(rawDestinations)
          ? rawDestinations[index]
          : rawDestinations ?? request.destinationLine;
        addCard("play", choiceCardIndex(choice), destination);
      });
    }
  }
  return features;
}

function dedupeNestedResolutionCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = JSON.stringify(candidate.choices);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function recordAutoplayDecision({
  recorder,
  state,
  playerId,
  step,
  candidates,
  policy,
  matchupProfile,
  matchupOverlayPath,
  counterfactualEvidence,
  explorationEvidence = null,
  selectedAction,
  selectedIndex
}) {
  const record = {
    step,
    player: playerId,
    opponent: opponentOf(playerId),
    state: decisionStateSummary(state, playerId),
    matchupProfile,
    matchupOverlayPath,
    counterfactual: counterfactualEvidence ?? null,
    exploration: explorationEvidence ?? selectedAction.autoplayExploration ?? null,
    chosenIndex: selectedIndex,
    chosenAction: summarizePilotAction(state, playerId, selectedAction),
    candidates: candidates.map((action, index) => ({
      index,
      chosen: index === selectedIndex,
      action: summarizePilotAction(state, playerId, action),
      score: scorePilotAction(state, playerId, action, policy),
      features: pilotActionFeatures(state, playerId, action)
    }))
  };
  recorder(record);
}

function decisionStateSummary(state, playerId) {
  const player = state.players[playerId];
  const opponent = state.players[opponentOf(playerId)];
  return {
    phase: state.phase,
    decisionPhase: counterfactualDecisionPhase(state, playerId),
    activePlayer: state.activePlayer,
    turnPlayer: playerId,
    firstPlayer: state.firstPlayer,
    turnCyclesTaken: Math.max(state.players.P1.turnsTaken, state.players.P2.turnsTaken),
    playerLife: player.life.length,
    opponentLife: opponent.life.length,
    playerHand: player.hand.length,
    opponentHand: opponent.hand.length,
    playerFront: player.frontLine.length,
    opponentFront: opponent.frontLine.length,
    playerEnergy: player.energyLine.length,
    opponentEnergy: opponent.energyLine.length,
    playerActiveFront: player.frontLine.filter((permanent) => !permanent.rested).length,
    opponentActiveFront: opponent.frontLine.filter((permanent) => !permanent.rested).length,
    pendingAttack: Boolean(state.pendingAttack)
  };
}

function summarizePilotAction(state, playerId, action) {
  const summary = {
    type: action.type
  };
  if (action.destination) summary.destination = action.destination;
  if (action.line) summary.line = action.line;
  if (action.targetLine) summary.targetLine = action.targetLine;
  if (action.type === "performRaid") summary.moveToFront = Boolean(action.moveToFront);
  else if (action.moveToFront !== undefined) summary.moveToFront = Boolean(action.moveToFront);
  if (action.target?.type) summary.targetType = action.target.type;

  const player = state.players[playerId];
  if (Number.isInteger(action.handIndex)) {
    summary.cardId = player.hand[action.handIndex]?.defId ?? null;
  }
  if (Number.isInteger(action.index) && action.line && player[action.line]?.[action.index]) {
    summary.sourceCardId = player[action.line][action.index].cards?.at(-1)?.defId ?? null;
  }
  if (Number.isInteger(action.attackerIndex)) {
    summary.sourceCardId = player.frontLine[action.attackerIndex]?.cards?.at(-1)?.defId ?? null;
  }
  if (Number.isInteger(action.blockerIndex)) {
    summary.sourceCardId = player.frontLine[action.blockerIndex]?.cards?.at(-1)?.defId ?? null;
  }
  if (action.type === "performRaid" && action.moveToFront && action.replaceIndex !== undefined) {
    const replaced = actionReplacementPermanent(state, playerId, LINES.FRONT, action.replaceIndex);
    summary.replacesPermanent = Boolean(replaced);
    summary.replacementCardId = permanentCardDefId(replaced);
  }
  if (action.type === "playCard" && action.destination && action.replaceIndex !== undefined) {
    const replaced = actionReplacementPermanent(state, playerId, action.destination, action.replaceIndex);
    summary.replacesPermanent = Boolean(replaced);
    summary.replacementCardId = permanentCardDefId(replaced);
  }
  if (action.abilityId) summary.abilityId = action.abilityId;
  if (action.autoplayExploration?.reason) summary.explorationReason = action.autoplayExploration.reason;
  return summary;
}

function normalizePilotPolicyConfig(policy) {
  if (!policy) {
    const baseline = normalizePilotPolicy();
    return { P1: baseline, P2: baseline };
  }
  if (policy.P1 || policy.P2) {
    const baseline = normalizePilotPolicy();
    return {
      P1: normalizePilotPolicy(policy.P1 ?? baseline),
      P2: normalizePilotPolicy(policy.P2 ?? baseline)
    };
  }
  const normalized = normalizePilotPolicy(policy);
  return { P1: normalized, P2: normalized };
}

function normalizeMatchupOverlayConfig(config) {
  const empty = {
    enabled: false,
    strength: 1,
    minConfidence: 0.7,
    overlays: {}
  };
  if (!config) return { P1: empty, P2: empty };
  if (config.P1 || config.P2) {
    return {
      P1: normalizePlayerMatchupConfig(config.P1),
      P2: normalizePlayerMatchupConfig(config.P2)
    };
  }
  const normalized = normalizePlayerMatchupConfig(config);
  return { P1: normalized, P2: normalized };
}

function normalizeMatchupFingerprintConfig(config) {
  if (!config) return { P1: [], P2: [] };
  if (config.P1 || config.P2) {
    return {
      P1: normalizeMatchupDeckFingerprints(config.P1),
      P2: normalizeMatchupDeckFingerprints(config.P2)
    };
  }
  const normalized = normalizeMatchupDeckFingerprints(config);
  return { P1: normalized, P2: normalized };
}

function normalizePlayerMatchupConfig(config = {}) {
  config ??= {};
  const overlays = Object.fromEntries(Object.entries(config.overlays ?? {})
    .map(([key, value]) => {
      const entry = value?.overlay ? value : { overlay: value };
      return [key, {
        path: entry.path ?? null,
        overlay: normalizeMatchupOverlay(entry.overlay)
      }];
    }));
  return {
    enabled: config.enabled !== false && Object.keys(overlays).length > 0,
    strength: Number(config.strength ?? 1),
    minConfidence: Number(config.minConfidence ?? 0.7),
    knownDeckVariants: config.knownDeckVariants === true,
    variantMinDeckConfidence: Number(config.variantMinDeckConfidence ?? 0.55),
    variantMinObservedCoverage: Number(config.variantMinObservedCoverage ?? 0.75),
    unknownVariantMinEvidence: Number(config.unknownVariantMinEvidence ?? 4),
    allowUnvalidated: config.allowUnvalidated === true,
    overlays
  };
}

export function scorePilotAction(state, playerId, action, policy = {}) {
  const normalized = normalizePilotPolicy(policy);
  const features = pilotActionFeatures(state, playerId, action);
  return Object.entries(features).reduce((total, [feature, value]) => {
    return total + Number(normalized.weights[feature] ?? 0) * Number(value ?? 0);
  }, 0);
}

export function pilotActionFeatures(state, playerId, action) {
  const features = { baseScore: 1 };
  const player = state.players[playerId];

  if (action.type === "advancePhase") {
    features.advancePhase = 1;
    if (state.phase === PHASES.ATTACK) {
      const missed = readyAttackThreat(state, playerId);
      features.passWithReadyAttackers = missed.count;
      features.passMissedDamage = missed.damage;
      features.passMissedLethal = missed.lethal ? 1 : 0;
    }
    return features;
  }

  if (action.type === "extraDraw") {
    features.extraDraw = 1;
    return features;
  }

  if (action.type === "moveCharacters") {
    const moves = action.moves ?? [];
    const forwardMoves = moves.filter((move) => move.from === LINES.ENERGY && move.to === LINES.FRONT);
    const energyMoves = moves.filter((move) => move.from === LINES.FRONT && move.to === LINES.ENERGY);
    features.moveToFront = forwardMoves.length;
    features.movedBp = forwardMoves.reduce((total, move) => {
      return total + permanentBattlePower(state, player.energyLine[move.index]) / 1000;
    }, 0);
    features.moveToEnergy = energyMoves.length;
    features.movedToEnergyBp = energyMoves.reduce((total, move) => {
      return total + permanentBattlePower(state, player.frontLine[move.index]) / 1000;
    }, 0);
    features.lineCrowdingPenalty = Math.max(
      0,
      player.frontLine.length + forwardMoves.length - energyMoves.length - MAX_LINE_SIZE,
      player.energyLine.length + energyMoves.length - forwardMoves.length - MAX_LINE_SIZE
    );
    for (const move of moves) {
      const permanent = player[move.from]?.[move.index];
      const cardId = permanentCardDefId(permanent);
      if (cardId) addContextFeature(features, "move", move.to, "card", cardId);
    }
    return features;
  }

  if (action.type === "activateMainAbility") {
    const source = action.zone ? undefined : player[action.line]?.[action.index];
    const ability = sourceAbility(state, playerId, action);
    const sourceCardId = action.zone
      ? player[action.zone]?.[action.index]?.defId ?? null
      : permanentCardDefId(source);
    features.activateMain = 1;
    features.abilityConsumesAp = Number(ability?.cost?.ap ?? 0);
    features.abilityRestsPotentialAttacker = ability?.cost?.restSelf && sourceCanAttackSoon(state, playerId, source) ? 1 : 0;
    Object.assign(features, abilityRoleFeatures(ability?.effect));
    features.abilityEffect = ability
      ? (effectScore(state, playerId, ability.effect, source) - abilityCostPenalty(state, playerId, source, ability)) / 100
      : -10;
    if (sourceCardId) addContextFeature(features, "ability", "card", sourceCardId, action.abilityId ?? ability?.id ?? "unknown");
    addChoiceContextFeatures(
      features,
      action.choices,
      sourceCardId,
      action.abilityId ?? ability?.id ?? "activate",
      autoplayResolutionChoiceState(state, playerId, action),
      playerId,
      deferredChoiceContextKeysForAction(state, playerId, action)
    );
    return features;
  }

  if (action.type === "performRaid") {
    const card = player.hand[action.handIndex];
    const def = state.catalog[card?.defId];
    const targetLine = action.targetLine === LINES.FRONT ? player.frontLine : player.energyLine;
    const target = targetLine[action.targetIndex];
    const targetDef = state.catalog[target?.cards?.at(-1)?.defId];
    features.performRaid = 1;
    Object.assign(features, cardRoleFeatures(state, playerId, def));
    features.raidBpUpgrade = Math.max(0, Number(def?.bp ?? 0) - Number(targetDef?.bp ?? 0)) / 1000;
    features.moveRaidToFront = action.moveToFront ? 1 : 0;
    features.highBpUnit = Number(def?.bp ?? 0) / 1000;
    const replaced = action.moveToFront
      ? actionReplacementPermanent(state, playerId, LINES.FRONT, action.replaceIndex)
      : undefined;
    features.lineCrowdingPenalty = replaced ? 1 : 0;
    features.replacementValue = replaced ? replacementPermanentValue(state, replaced) / 100 : 0;
    features.playCard = 1;
    if (def?.id) {
      addContextFeature(features, "raid", "card", def.id);
      if (targetDef?.id) addContextFeature(features, "raid", "pair", def.id, targetDef.id);
      addContextFeature(features, "raid", action.moveToFront ? LINES.FRONT : action.targetLine ?? "field", "card", def.id);
      const replacedCardId = permanentCardDefId(replaced);
      if (replacedCardId) addContextFeature(features, "raid", "replace", "card", def.id, replacedCardId);
      addChoiceContextFeatures(
        features,
        action.choices,
        def.id,
        "raid",
        autoplayResolutionChoiceState(state, playerId, action),
        playerId,
        deferredChoiceContextKeysForAction(state, playerId, action)
      );
    }
    return features;
  }

  if (action.type === "playCard") {
    const card = player.hand[action.handIndex];
    const def = state.catalog[card?.defId];
    const requiredEnergy = def ? internals.requiredEnergyForCardUse(state, playerId, def, { sourceZone: "hand" }) : 0;
    const available = def?.requiredEnergy?.color ? internals.energyAvailable(state, playerId)[def.requiredEnergy.color] ?? 0 : 0;
    features.playCard = 1;
    const replaced = action.destination
      ? actionReplacementPermanent(state, playerId, action.destination, action.replaceIndex)
      : undefined;
    features.lineCrowdingPenalty = replaced ? 1 : 0;
    features.replacementValue = replaced ? replacementPermanentValue(state, replaced) / 100 : 0;
    Object.assign(features, cardRoleFeatures(state, playerId, def));
    if (def?.id) {
      addContextFeature(features, "play", "card", def.id);
      if (action.destination) addContextFeature(features, "play", action.destination, "card", def.id);
      const replacedCardId = permanentCardDefId(replaced);
      if (replacedCardId) addContextFeature(features, "play", "replace", "card", def.id, replacedCardId);
      addChoiceContextFeatures(
        features,
        action.choices,
        def.id,
        "play",
        autoplayResolutionChoiceState(state, playerId, action),
        playerId,
        deferredChoiceContextKeysForAction(state, playerId, action)
      );
    }
    if (def?.raid) {
      features.playRaidCardNormally = 1;
      if (action.destination === LINES.FRONT) features.playRaidNormallyToFront = 1;
      if (action.destination === LINES.ENERGY) features.playRaidNormallyToEnergy = 1;
    }
    features.lowCostUnit = def?.type === CARD_TYPES.CHARACTER && requiredEnergy <= 1 ? 1 : 0;
    features.highBpUnit = Number(def?.bp ?? 0) / 1000;
    features.event = def?.type === CARD_TYPES.EVENT ? 1 : 0;
    if (action.destination === LINES.ENERGY) {
      features.playToEnergy = 1;
      features.earlyEnergy = Math.max(0, MAX_LINE_SIZE - player.energyLine.length) / MAX_LINE_SIZE;
      features.energyShortage = Math.max(0, requiredEnergy + 1 - available);
      features.lineCrowdingPenalty = player.energyLine.length >= MAX_LINE_SIZE ? 1 : 0;
    }
    if (action.destination === LINES.FRONT) {
      features.playToFront = 1;
      features.lineCrowdingPenalty = player.frontLine.length >= MAX_LINE_SIZE ? 1 : 0;
    }
    return features;
  }

  if (action.type === "declareAttack") {
    const attacker = attackerPermanentForAction(state, playerId, action);
    const damage = attacker ? directDamageAmount(state, attacker) : 1;
    const opponent = state.players[opponentOf(playerId)];
    const activeBlockers = activeFrontBlockers(state, opponentOf(playerId));
    const activeBlockerCount = activeBlockers.length;
    const attackerBp = permanentBattlePower(state, attacker);
    const attackerCardId = permanentCardDefId(attacker);
    if (attackerCardId) {
      addContextFeature(features, "attack", "card", attackerCardId);
      addChoiceContextFeatures(
        features,
        action.choices,
        attackerCardId,
        "attack",
        state,
        playerId,
        deferredChoiceContextKeysForAction(state, playerId, action)
      );
    }
    features.damageThreat = damage;
    features.lifePressure = damage / Math.max(1, opponent.life.length);
    features.lowLifePressure = damage * Math.max(0, STARTING_LIFE - opponent.life.length) / STARTING_LIFE;
    features.attackerBp = attackerBp / 1000;
    if (action.target?.type === "character") {
      const defender = opponent.frontLine[action.target.index];
      features.attackCharacter = 1;
      features.snipeAttack = 1;
      features.snipeThreatRemoval = threatScoreForPermanent(state, defender) / 1000;
      features.snipeOverFaceWhenLethal = opponent.life.length <= damage ? 1 : 0;
      features.removalTargetBp = permanentBattlePower(state, defender) / 1000;
      features.attackBpAdvantage = attacker && defender && permanentBattlePower(state, attacker) >= permanentBattlePower(state, defender) ? 1 : -1;
    } else {
      features.attackPlayer = 1;
      features.lethalAttack = opponent.life.length <= damage ? 1 : 0;
      features.openLaneDamage = activeBlockerCount === 0 ? damage : 0;
      features.forceBlockPressure = activeBlockerCount > 0 ? damage / activeBlockerCount : 0;
      features.attackIntoBlockers = activeBlockerCount > 0 ? 1 : 0;
      features.attackTriggerExposure = damage;
      const weakestBlockerBp = activeBlockerCount > 0 ? Math.min(...activeBlockers.map((blocker) => permanentBattlePower(state, blocker))) : 0;
      features.attackCanBeatBlocker = activeBlockerCount > 0 && attackerBp >= weakestBlockerBp ? 1 : 0;
      features.attackIntoWall = activeBlockerCount > 0 && attackerBp < weakestBlockerBp ? 1 : 0;
      features.attackUsesLastBlocker = attackingWithLastActiveBlocker(state, playerId, attacker) ? 1 : 0;
      features.attackCrackbackLethalRisk = attackCouldOpenCrackbackLethal(state, playerId, attacker) ? 1 : 0;
      features.attackTwoTurnClock = damage + frontLineDamagePotential(state, playerId) >= opponent.life.length ? 1 : 0;
    }
    return features;
  }

  if (action.type === "declareBlock") {
    const context = pendingAttackContext(state, playerId);
    const blocker = player.frontLine[action.blockerIndex];
    const damage = context.attacker ? directDamageAmount(state, context.attacker) : 1;
    const impactDamage = context.attacker && blocker ? impactDamageAmount(state, context.attacker, blocker) : 0;
    const blockerBp = permanentBattlePower(state, blocker);
    const attackerBp = permanentBattlePower(state, context.attacker);
    const blockerCardId = permanentCardDefId(blocker);
    if (blockerCardId) {
      addContextFeature(features, "block", "card", blockerCardId);
      addChoiceContextFeatures(
        features,
        action.choices,
        blockerCardId,
        "block",
        state,
        playerId,
        deferredChoiceContextKeysForAction(state, playerId, action)
      );
    }
    features.block = 1;
    features.savedDamage = Math.max(0, damage - impactDamage);
    features.lethalBlock = player.life.length <= damage ? 1 : 0;
    features.desperateBlock = player.life.length <= damage + 1 ? 1 : 0;
    features.favorableBlock = blockerBp > attackerBp ? 1 : 0;
    features.blockerDies = attackerBp >= blockerBp ? 1 : 0;
    features.earlyChumpBlock = player.life.length > damage + 2 && attackerBp >= blockerBp ? 1 : 0;
    features.blockWithLowValue = cardValue(state, blocker?.cards?.at(-1)) <= 260 ? 1 : 0;
    features.blockWithHighValueAtRisk = attackerBp >= blockerBp && threatScoreForPermanent(state, blocker) >= 3500 ? 1 : 0;
    features.blockStopsImpact = Math.max(0, impactDamage);
    features.highValueBlocker = blockerBp / 1000;
    features.impactLeak = impactDamage;
    return features;
  }

  if (action.type === "declineBlock") {
    const context = pendingAttackContext(state, playerId);
    const damage = context.attacker ? directDamageAmount(state, context.attacker) : 1;
    features.declineBlock = 1;
    features.damageTaken = damage;
    features.declineLethal = player.life.length <= damage ? 1 : 0;
    features.safeDeclineBlock = player.life.length > damage + 2 ? 1 : 0;
    features.lowLifeDecline = player.life.length <= damage + 1 ? 1 : 0;
    features.preserveFrontLine = activeFrontBlockers(state, playerId).length > 0 ? 1 : 0;
    features.declineTriggerWindow = Math.max(0, Math.min(damage, player.life.length - 1));
    features.declineToCrackback = frontLineDamagePotential(state, playerId) >= state.players[opponentOf(playerId)].life.length ? 1 : 0;
    return features;
  }

  if (action.type === "discardForHandLimit") {
    features.discard = 1;
    for (const handIndex of action.handIndices ?? []) {
      const cardId = player.hand[handIndex]?.defId;
      if (cardId) addContextFeature(features, "discard", "card", cardId);
    }
    return features;
  }

  return features;
}

function addContextFeature(features, ...parts) {
  const segments = parts.map(contextFeatureSegment).filter(Boolean);
  if (segments.length === 0) return;
  const key = `${CONTEXTUAL_ACTION_FEATURE_PREFIX}${segments.join(".")}`;
  features[key] = Number(features[key] ?? 0) + 1;
}

function contextFeatureSegment(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function permanentCardDefId(permanent) {
  return permanent?.cards?.at(-1)?.defId ?? null;
}

function actionReplacementPermanent(state, playerId, lineName, choice) {
  if (choice === undefined || choice === null) return undefined;
  const line = state.players[playerId]?.[lineName] ?? [];
  if (Number.isInteger(choice)) return line[choice];
  if (choice?.permanentId) return line.find((permanent) => permanent.pid === choice.permanentId);
  return line[choice?.index];
}

function replacementPermanentValue(state, permanent) {
  if (!permanent) return 0;
  const top = permanent.cards?.at(-1);
  return cardValue(state, top) + Math.max(0, Number(permanent.cards?.length ?? 1) - 1) * 250;
}

function addChoiceContextFeatures(
  features,
  choices,
  sourceCardId,
  actionId,
  state,
  playerId,
  excludedKeys = new Set(),
  path = [],
  depth = 0
) {
  if (!choices || typeof choices !== "object" || depth > 2 || !sourceCardId) return;
  for (const [key, value] of Object.entries(choices).sort(([left], [right]) => left.localeCompare(right))) {
    if (excludedKeys.has(key) || /^opponent/iu.test(key)) continue;
    const nextPath = [...path, key];
    if (typeof value === "boolean" || typeof value === "string") {
      addContextFeature(features, "choice", sourceCardId, actionId, ...nextPath, String(value));
      continue;
    }
    if (typeof value === "number") {
      if (/choice|mode|option|prediction|amount|pay|instead/iu.test(key)) {
        addContextFeature(features, "choice", sourceCardId, actionId, ...nextPath, value);
      }
      const cardId = choiceReferencedCardId(state, playerId, nextPath, value);
      if (cardId) addContextFeature(features, "choice", sourceCardId, actionId, ...nextPath, "card", cardId);
      continue;
    }
    if (Array.isArray(value)) {
      if (/simultaneous.*order/iu.test(key)) {
        addSimultaneousOrderContextFeatures(features, state, playerId, sourceCardId, actionId, nextPath, choices, value);
      }
      for (const item of value) addChoiceArrayItemContext(features, state, playerId, sourceCardId, actionId, nextPath, item);
      continue;
    }
    if (!Array.isArray(value) && value && typeof value === "object") {
      const cardId = choiceReferencedCardId(state, playerId, nextPath, value);
      if (cardId) addContextFeature(features, "choice", sourceCardId, actionId, ...nextPath, "card", cardId);
      if (choiceReferenceObject(value)) continue;
      addChoiceContextFeatures(features, value, sourceCardId, actionId, state, playerId, excludedKeys, nextPath, depth + 1);
    }
  }
}

function addSimultaneousOrderContextFeatures(features, state, playerId, sourceCardId, actionId, path, choices, order) {
  const selectedCards = Object.entries(choices ?? {})
    .filter(([key]) => !/simultaneous.*order/iu.test(key))
    .map(([, value]) => value)
    .find((value) => Array.isArray(value)
      && value.length === order.length
      && value.every((item) => item && typeof item === "object" && (item.uid || item.zone)));
  if (!selectedCards) return;
  order.forEach((selectedIndex, orderIndex) => {
    const cardId = choiceReferencedCardId(state, playerId, path, selectedCards[selectedIndex]);
    if (cardId) addContextFeature(features, "choice", sourceCardId, actionId, ...path, `slot_${orderIndex + 1}`, "card", cardId);
  });
}

function choiceReferenceObject(value) {
  return Boolean(value && typeof value === "object" && (
    value.uid
    || (Number.isInteger(Number(value.index)) && (value.zone || value.line || value.lineName))
  ));
}

function addChoiceArrayItemContext(features, state, playerId, sourceCardId, actionId, path, item) {
  const cardId = choiceReferencedCardId(state, playerId, path, item);
  if (cardId) addContextFeature(features, "choice", sourceCardId, actionId, ...path, "card", cardId);
  if (typeof item === "boolean" || typeof item === "string" || typeof item === "number") {
    addContextFeature(features, "choice", sourceCardId, actionId, ...path, item);
  }
}

function choiceReferencedCardId(state, playerId, path, value) {
  if (!state || value === null || value === undefined) return null;
  if (typeof value === "object") {
    const targetPlayerId = value.player ?? value.playerId ?? playerId;
    const lineName = value.lineName ?? value.line;
    if (lineName && Number.isInteger(Number(value.index))) {
      const permanent = state.players[targetPlayerId]?.[lineName]?.[Number(value.index)];
      if (permanent?.cards && Number.isInteger(Number(value.underIndex))) {
        const underCard = permanent.cards[Number(value.underIndex)];
        return underCard?.faceUp === false ? null : underCard?.defId ?? null;
      }
      if (permanent?.cards) return permanentCardDefId(permanent);
      return state.players[targetPlayerId]?.[lineName]?.[Number(value.index)]?.defId ?? null;
    }
    if (value.zone && Number.isInteger(Number(value.index))) {
      if (["deck", "life"].includes(value.zone)) return null;
      if (targetPlayerId !== playerId && value.zone === "hand") return null;
      const zone = state.players[targetPlayerId]?.[value.zone] ?? [];
      const card = value.uid ? zone.find((candidate) => candidate.uid === value.uid) : zone[Number(value.index)];
      return card?.defId ?? null;
    }
    return null;
  }
  if (!Number.isInteger(Number(value))) return null;
  const key = path.join(".").toLowerCase();
  const zone = /hand|discard/u.test(key)
    ? "hand"
    : /sideline/u.test(key)
      ? "sideline"
      : /removal/u.test(key)
        ? "removal"
        : null;
  return zone ? state.players[playerId]?.[zone]?.[Number(value)]?.defId ?? null : null;
}

function deferredChoiceContextKeysForAction(state, playerId, action) {
  const keys = new Set();
  for (const { effect } of autoplayChoiceEffectContexts(state, playerId, action)) {
    collectDeferredChoiceContextKeys(effect, keys);
  }
  return keys;
}

function autoplayResolutionChoiceState(state, playerId, action) {
  if (!["playCard", "performRaid"].includes(action.type) || !Number.isInteger(action.handIndex)) return state;
  const player = state.players[playerId];
  if (!player?.hand?.[action.handIndex]) return state;
  return {
    ...state,
    players: {
      ...state.players,
      [playerId]: {
        ...player,
        hand: player.hand.filter((_, index) => index !== action.handIndex)
      }
    }
  };
}

function collectDeferredChoiceContextKeys(effect, keys, deferAll = false) {
  if (!effect || typeof effect !== "object") return;
  const deferred = deferAll || [
    "searchTopDeck",
    "lookTopDeckAndMove",
    "lookTopDeckPlayOneAndMoveRest",
    "revealTopDeckOptionalPlayOrRaidInstead",
    "raidSourceFromZone"
  ].includes(effect.kind);

  if (deferred) collectEffectChoiceKeys(effect, keys);
  if (effect.kind === "opponentMayDraw") keys.add(effect.choiceKey ?? "opponentDrawAmount");
  if (effect.kind === "opponentMaySidelineChosenTargetsElse") keys.add(effect.choiceKey ?? "opponentSidelineChoice");
  if (effect.kind === "opponentMayMoveCardsBetweenZonesElse") {
    keys.add(effect.choiceKey ?? "opponentZoneMoveChoice");
    keys.add(effect.indicesChoiceKey ?? "opponentZoneMoveIndices");
  }
  if (effect.kind === "moveCardBetweenZones"
    && effect.player === "opponent"
    && ["hand", "life", "deck"].includes(effect.source ?? "sideline")) {
    keys.add(effect.choiceKey ?? `${effect.source ?? "sideline"}Index`);
  }
  if (effect.kind === "playCardFromZone"
    && effect.player === "opponent"
    && (effect.zones ?? [effect.zone ?? "hand"]).includes("hand")) {
    keys.add(effect.choiceKey ?? `${effect.zone ?? effect.zones?.[0] ?? "hand"}Index`);
    keys.add(effect.replaceChoiceKey ?? "replaceIndex");
    keys.add(effect.abilityOrderChoiceKey ?? "simultaneousPlayedOrder");
  }

  for (const child of nestedEffects(effect)) collectDeferredChoiceContextKeys(child, keys, deferred);
}

function collectEffectChoiceKeys(effect, keys) {
  for (const [key, value] of Object.entries(effect ?? {})) {
    if ((key === "choiceKey" || key.endsWith("ChoiceKey")) && typeof value === "string") keys.add(value);
  }
  const add = (...values) => values.filter(Boolean).forEach((value) => keys.add(value));
  switch (effect.kind) {
    case "optional":
      add(effect.choiceKey ?? "optionalEffect");
      break;
    case "restTargetsThen":
      if (effect.optional) add(effect.choiceKey ?? "optionalRestTargets");
      break;
    case "optionalChoiceUpgrade":
      add(effect.choiceKey ?? "optionalChoiceUpgrade");
      break;
    case "optionalInstead":
      add(effect.choiceKey ?? "optionalInstead");
      break;
    case "chooseOne":
      add(effect.choiceKey ?? "effectChoice");
      break;
    case "chooseN":
      add(effect.choiceKey ?? "effectChoices");
      break;
    case "searchTopDeck":
      add(
        effect.choiceKey ?? "searchIndices",
        effect.remainingDestinationChoiceKey ?? "searchRemainingDestinations",
        effect.topOrderChoiceKey ?? "searchTopOrder",
        effect.bottomOrderChoiceKey ?? "bottomOrder"
      );
      if (effect.selectedAlternative) {
        add(
          effect.selectedAlternative.choiceKey ?? "searchPlayInstead",
          effect.selectedAlternative.raidChoiceKey ?? "performRaid",
          effect.selectedAlternative.raidTargetChoiceKey ?? "raidTarget",
          effect.selectedAlternative.replaceChoiceKey ?? "replaceIndex",
          effect.selectedAlternative.raidMoveChoiceKey ?? "moveRaidToFront",
          effect.selectedAlternative.raidMoveReplaceChoiceKey ?? "raidMoveReplaceIndex"
        );
      }
      break;
    case "lookTopDeckAndMove":
      add(
        effect.choiceKey ?? "lookTopDeckPlacements",
        effect.topOrderChoiceKey ?? "lookTopOrder",
        effect.bottomOrderChoiceKey ?? "lookBottomOrder"
      );
      break;
    case "lookTopDeckPlayOneAndMoveRest":
      add(
        effect.choiceKey ?? "lookPlayIndex",
        effect.raidChoiceKey ?? "performRaid",
        effect.raidTargetChoiceKey ?? "raidTarget",
        effect.replaceChoiceKey ?? "replaceIndex",
        effect.raidMoveChoiceKey ?? "moveRaidToFront",
        effect.raidMoveReplaceChoiceKey ?? "raidMoveReplaceIndex",
        effect.remainingOrderChoiceKey ?? "lookRemainingOrder"
      );
      break;
    case "revealTopDeckOptionalPlayOrRaidInstead":
      add(
        effect.choiceKey ?? "optionalRevealPlay",
        effect.raidChoiceKey ?? "performRaid",
        effect.placementChoiceKey ?? "revealedPlacement",
        effect.replaceChoiceKey ?? "replaceIndex",
        effect.raidMoveChoiceKey ?? "moveRaidToFront",
        effect.raidMoveReplaceChoiceKey ?? "raidMoveReplaceIndex"
      );
      break;
    case "playCardFromZone":
      add(
        effect.choiceKey ?? `${effect.zone ?? effect.zones?.[0] ?? "hand"}Index`,
        effect.abilityOrderChoiceKey ?? "simultaneousPlayedOrder",
        effect.replaceChoiceKey ?? "replaceIndex",
        effect.destinationLineChoiceKey ?? "destinationLine",
        effect.raidMoveChoiceKey ?? "moveRaidToFront",
        effect.raidMoveReplaceChoiceKey ?? "raidMoveReplaceIndex"
      );
      break;
    case "playCardFromZoneMatchingTargetName":
      add(
        effect.choiceKey ?? `${effect.zone ?? effect.zones?.[0] ?? "hand"}Index`,
        effect.replaceChoiceKey ?? "replaceIndex",
        effect.destinationLineChoiceKey ?? "destinationLine"
      );
      break;
    case "playOrRaidCardFromZone":
      add(
        effect.choiceKey ?? `${effect.zones?.[0] ?? effect.zone ?? "hand"}Index`,
        effect.raidChoiceKey ?? "performRaid",
        effect.raidTargetChoiceKey ?? "raidTarget",
        effect.abilityOrderChoiceKey ?? "simultaneousPlayedOrder",
        effect.replaceChoiceKey ?? "replaceIndex",
        effect.destinationLineChoiceKey ?? "destinationLine"
      );
      break;
    case "playSourceFromZone":
      add(
        effect.replaceChoiceKey ?? "replaceIndex",
        effect.destinationLineChoiceKey ?? "destinationLine"
      );
      break;
    case "useEventFromZone":
    case "activateTriggerFromZone":
      add(effect.choiceKey ?? `${effect.source ?? effect.zone ?? effect.zones?.[0] ?? "sideline"}Index`);
      break;
    case "moveCardBetweenZones":
      add(effect.choiceKey ?? `${effect.source ?? "sideline"}Index`);
      break;
    case "moveHandToZone":
    case "moveHandCardsUnderSelf":
    case "moveHandCardsUnderTargets":
      add(effect.choiceKey ?? "handIndices");
      if (effect.kind === "moveHandToZone") {
        if (effect.destinations?.length > 0) add(effect.destinationChoiceKey ?? "handDestinations");
        if (effect.positions?.length > 0) add(effect.positionChoiceKey ?? "handDeckPositions");
      }
      break;
    case "moveEqualCountsBetweenZones":
      add(effect.countChoiceKey ?? "equalZoneMoveCount");
      break;
    case "moveUnderCardsToZone":
      if (!effect.all) add(effect.choiceKey ?? "underCardChoices");
      break;
    case "moveZoneCardsUnderSelf":
    case "moveZoneCardsUnderTargets":
      add(effect.choiceKey ?? `${effect.source ?? "sideline"}UnderCards`);
      break;
    case "swapSourceWithOtherLine":
      add(effect.choiceKey ?? "swapTargetIndex");
      break;
    case "swapChosenTargets":
      add(
        (effect.firstTarget ?? effect.targetA)?.choiceKey ?? "firstTarget",
        (effect.secondTarget ?? effect.targetB)?.choiceKey ?? "secondTarget"
      );
      break;
    case "swapTargetsWithOtherLine":
      add(effect.swapChoiceKey ?? "swapTargetIndex");
      break;
    case "moveOrSwapTargetsToOtherLine":
      add(effect.swapChoiceKey ?? "moveOrSwapTargets");
      break;
    case "swapOwnFrontAndEnergy":
      add(effect.frontChoiceKey ?? "frontIndex", effect.energyChoiceKey ?? "energyIndex");
      break;
    case "restEnergyLineForRequiredEnergyTotal":
      add(effect.choiceKey ?? "energyRestIndices");
      break;
    case "moveTargetsToDeck":
      add(effect.positionChoiceKey ?? "deckPosition");
      break;
    case "sidelineTargetsThenActivateSourceWhenPlayed":
      add(effect.orderChoiceKey ?? "simultaneousAbilityOrder");
      break;
    case "revealHandCards":
      add(effect.choiceKey ?? "revealHandIndices");
      break;
    case "modifyBpForHandReveal":
      add(effect.choiceKey ?? (effect.uniqueNames ? "revealHandIndices" : "revealHandCount"));
      break;
    case "playSomeNamedFromSidelineAddRest":
      add(effect.choiceKey ?? "playNamedIndices");
      break;
    case "opponentMayDraw":
      add(effect.choiceKey ?? "opponentDrawAmount");
      break;
    case "opponentMaySidelineChosenTargetsElse":
      add(effect.choiceKey ?? "opponentSidelineChoice");
      break;
    case "opponentMayMoveCardsBetweenZonesElse":
      add(effect.choiceKey ?? "opponentZoneMoveChoice", effect.indicesChoiceKey ?? "opponentZoneMoveIndices");
      break;
    case "predictTopDeckRequiredEnergy":
      add(effect.choiceKey ?? "requiredEnergyPrediction");
      break;
    default:
      break;
  }
  const selector = targetSelectorForEffect(effect);
  if (selector && !selector.all) add(selector.choiceKey ?? "targets");
}

function deleteEffectChoiceKeys(choices, effects) {
  const keys = new Set();
  const visit = (effect) => {
    if (!effect) return;
    collectEffectChoiceKeys(effect, keys);
    for (const child of nestedEffects(effect)) visit(child);
  };
  for (const effect of effects ?? []) visit(effect);
  for (const key of keys) delete choices[key];
}

function nestedEffects(effect) {
  return [
    ...(effect.effects ?? []),
    ...(effect.choices ?? []).map((choice) => choice.effect),
    effect.effect,
    effect.elseEffect,
    effect.costEffect,
    effect.baseEffect,
    effect.insteadEffect,
    effect.upgradedEffect,
    effect.ifMovedEffect,
    effect.selectedAlternative
  ].filter(Boolean);
}

function pilotActionScore(state, playerId, action, policy) {
  return scorePilotAction(state, playerId, action, policy);
}

function mainActionScore(state, playerId, action) {
  const player = state.players[playerId];
  if (action.type === "activateMainAbility") {
    const source = action.zone ? undefined : player[action.line]?.[action.index];
    const ability = sourceAbility(state, playerId, action);
    if (!ability) return 0;
    return 500 + effectScore(state, playerId, ability.effect, source) - abilityCostPenalty(state, playerId, source, ability);
  }

  const card = player.hand[action.handIndex];
  const def = state.catalog[card?.defId];
  if (!def) return 0;

  const requiredEnergy = Number(def.requiredEnergy?.amount ?? 0);
  const apCost = Number(def.apCost ?? 0);
  const efficiencyPenalty = requiredEnergy * 10 + apCost * 20;

  if (action.type === "performRaid") {
    const targetLine = action.targetLine === LINES.FRONT ? state.players[playerId].frontLine : state.players[playerId].energyLine;
    const target = targetLine[action.targetIndex];
    const targetDef = state.catalog[target?.cards?.at(-1)?.defId];
    const upgrade = Math.max(0, Number(def.bp ?? 0) - Number(targetDef?.bp ?? 0)) / 10;
    const replaced = action.moveToFront
      ? actionReplacementPermanent(state, playerId, LINES.FRONT, action.replaceIndex)
      : undefined;
    return 1200 + upgrade + (action.moveToFront ? 100 : 0) - replacementPermanentValue(state, replaced) - efficiencyPenalty;
  }

  if (action.destination === LINES.ENERGY) {
    const replaced = actionReplacementPermanent(state, playerId, LINES.ENERGY, action.replaceIndex);
    return 1000 - player.energyLine.length * 50 - replacementPermanentValue(state, replaced) - efficiencyPenalty;
  }

  if (action.destination === LINES.FRONT && def.type === CARD_TYPES.CHARACTER) {
    const replaced = actionReplacementPermanent(state, playerId, LINES.FRONT, action.replaceIndex);
    return 600 + Number(def.bp ?? 0) / 10 - replacementPermanentValue(state, replaced) - efficiencyPenalty;
  }

  if (def.type === CARD_TYPES.EVENT) {
    return 250 - efficiencyPenalty;
  }

  return 100 - efficiencyPenalty;
}

function autoplayAbilityActionKey(state, action) {
  if (action.type !== "activateMainAbility") return undefined;
  const player = state.players[action.player];
  if (action.zone) {
    const card = player?.[action.zone]?.[action.zoneIndex ?? action.index];
    if (!player || !card) return undefined;
    return `${action.player}:${player.turnsTaken}:${action.zone}:${card.uid}:${action.abilityId}`;
  }
  const permanent = player?.[action.line]?.[action.index];
  if (!player || !permanent) return undefined;
  return `${action.player}:${player.turnsTaken}:${permanent.pid}:${action.abilityId}`;
}

function sourceAbility(state, playerId, action) {
  if (action.zone) {
    const card = state.players[playerId]?.[action.zone]?.[action.zoneIndex ?? action.index];
    const def = state.catalog[card?.defId];
    return (def?.abilities ?? []).find((ability) => ability.id === action.abilityId);
  }
  const permanent = state.players[playerId]?.[action.line]?.[action.index];
  return permanentAbilities(state, permanent).find((ability) => ability.id === action.abilityId);
}

function permanentAbilities(state, permanent) {
  if (!permanent) return [];
  const def = state.catalog[permanent.cards?.at(-1)?.defId];
  return [
    ...(def?.abilities ?? []),
    ...(permanent.gainedAbilities ?? [])
  ];
}

function withAutoplayChoices(state, playerId, action) {
  const choices = {};
  const choiceState = autoplayResolutionChoiceState(state, playerId, action);
  if (action.type === "activateMainAbility") {
    const permanent = action.zone ? undefined : choiceState.players[playerId]?.[action.line]?.[action.index];
    const ability = sourceAbility(state, playerId, action);
    if (ability) addChoicesForEffect(choices, choiceState, playerId, ability.effect, permanent);
  } else if (action.type === "advancePhase") {
    addChoicesForPhaseAdvance(choices, choiceState, playerId);
  } else if (action.type === "playCard") {
    const card = state.players[playerId].hand[action.handIndex];
    const def = state.catalog[card?.defId];
    if (def?.type === CARD_TYPES.EVENT) {
      addChoicesForEffect(choices, choiceState, playerId, def.eventEffect);
    } else {
      for (const ability of def?.abilities ?? []) {
        if (ability.timing === TIMINGS.WHEN_PLAYED) addChoicesForEffect(choices, choiceState, playerId, ability.effect);
      }
    }
  } else if (action.type === "performRaid") {
    const card = state.players[playerId].hand[action.handIndex];
    const def = state.catalog[card?.defId];
    const sourcePermanent = state.players[playerId]?.[action.targetLine]?.[action.targetIndex];
    for (const ability of def?.abilities ?? []) {
      if (ability.timing === TIMINGS.WHEN_PLAYED) addChoicesForEffect(choices, choiceState, playerId, ability.effect, sourcePermanent);
    }
  } else if (action.type === "declareAttack") {
    const lineName = action.attackerLine ?? LINES.FRONT;
    const attacker = state.players[playerId]?.[lineName]?.[action.attackerIndex];
    for (const ability of permanentAbilities(state, attacker)) {
      if (ability.timing === TIMINGS.WHEN_ATTACKING) addChoicesForEffect(choices, state, playerId, ability.effect, attacker);
    }
  } else if (action.type === "declareBlock") {
    const blocker = state.players[playerId]?.frontLine?.[action.blockerIndex];
    for (const ability of permanentAbilities(state, blocker)) {
      if (ability.timing === TIMINGS.WHEN_BLOCKING) addChoicesForEffect(choices, state, playerId, ability.effect, blocker);
    }
  }

  return Object.keys(choices).length > 0 ? { ...action, choices } : action;
}

function withAutoplayChoiceVariants(state, playerId, action) {
  const preferred = withAutoplayChoices(state, playerId, action);
  if (!preferred.choices) return [preferred];

  const variants = [];
  const seen = new Set();
  const addVariant = (choices) => {
    if (variants.length >= MAX_AUTOPLAY_CHOICE_VARIANTS_PER_ACTION) return false;
    const fingerprint = JSON.stringify(choices);
    if (seen.has(fingerprint)) return true;
    const candidate = { ...action, choices };
    try {
      applyAction(state, candidate);
    } catch {
      return true;
    }
    seen.add(fingerprint);
    variants.push(candidate);
    return variants.length < MAX_AUTOPLAY_CHOICE_VARIANTS_PER_ACTION;
  };

  addVariant(preferred.choices);

  for (const context of autoplayChoiceEffectContexts(state, playerId, action)) {
    collectAutoplayChoiceAlternatives({
      state: context.choiceState,
      playerId,
      effect: context.effect,
      sourcePermanent: context.sourcePermanent,
      sourceDef: context.sourceDef,
      sourceKind: context.sourceKind,
      preferredChoices: preferred.choices,
      addVariant
    });
    if (variants.length >= MAX_AUTOPLAY_CHOICE_VARIANTS_PER_ACTION) break;
  }
  const explicitTaxPlans = new Set(variants
    .filter((candidate) => candidate.choices?.targetTaxHandIndices)
    .map((candidate) => choicesWithoutTargetTaxFingerprint(candidate.choices)));
  const taxFiltered = variants.filter((candidate) => candidate.choices?.targetTaxHandIndices
    || !explicitTaxPlans.has(choicesWithoutTargetTaxFingerprint(candidate.choices)));
  const raidTargetChoiceKeys = new Set();
  for (const context of autoplayChoiceEffectContexts(state, playerId, action)) {
    collectRaidTargetChoiceKeys(context.effect, raidTargetChoiceKeys);
  }
  const explicitRaidPlans = new Set(taxFiltered.flatMap((candidate) => [...raidTargetChoiceKeys]
    .filter((key) => candidate.choices?.[key] !== undefined)
    .map((key) => choicesWithoutKeyFingerprint(candidate.choices, key))));
  return taxFiltered.filter((candidate) => [...raidTargetChoiceKeys].some((key) => candidate.choices?.[key] !== undefined)
    || ![...raidTargetChoiceKeys].some((key) => explicitRaidPlans.has(choicesWithoutKeyFingerprint(candidate.choices, key))));
}

function collectRaidTargetChoiceKeys(effect, keys) {
  if (!effect) return;
  if (effect.kind === "playOrRaidCardFromZone") keys.add(effect.raidTargetChoiceKey ?? "raidTarget");
  for (const child of nestedEffects(effect)) collectRaidTargetChoiceKeys(child, keys);
}

function choicesWithoutTargetTaxFingerprint(choices) {
  const rest = structuredClone(choices ?? {});
  delete rest.targetTaxHandIndices;
  delete rest.targetTaxHandIndex;
  return JSON.stringify(rest);
}

function choicesWithoutKeyFingerprint(choices, key) {
  const rest = structuredClone(choices ?? {});
  delete rest[key];
  return JSON.stringify(rest);
}

function autoplayChoiceEffectContexts(state, playerId, action) {
  const contexts = [];
  const choiceState = autoplayResolutionChoiceState(state, playerId, action);
  const add = (effect, sourcePermanent = undefined, sourceDef = undefined, sourceKind = undefined) => {
    if (effect) contexts.push({ effect, sourcePermanent, sourceDef, sourceKind, choiceState });
  };
  const player = state.players[playerId];
  if (action.type === "activateMainAbility") {
    const sourcePermanent = action.zone ? undefined : player?.[action.line]?.[action.index];
    const sourceDef = action.zone
      ? state.catalog[player?.[action.zone]?.[action.zoneIndex ?? action.index]?.defId]
      : state.catalog[sourcePermanent?.cards?.at(-1)?.defId];
    add(sourceAbility(state, playerId, action)?.effect, sourcePermanent, sourceDef);
  } else if (action.type === "advancePhase") {
    const timing = state.phase === PHASES.MAIN
      ? TIMINGS.START_OF_ATTACK_PHASE
      : state.phase === PHASES.ATTACK ? TIMINGS.END_OF_ATTACK_PHASE : undefined;
    if (timing) {
      for (const permanent of [...(player?.frontLine ?? []), ...(player?.energyLine ?? [])]) {
        for (const ability of permanentAbilities(state, permanent)) {
          if (ability.timing === timing) add(ability.effect, permanent, state.catalog[permanent.cards?.at(-1)?.defId]);
        }
      }
      if (timing === TIMINGS.START_OF_ATTACK_PHASE) {
        for (const card of player?.hand ?? []) {
          for (const ability of state.catalog[card.defId]?.abilities ?? []) {
            if (ability.timing === timing) add(ability.effect, undefined, state.catalog[card.defId]);
          }
        }
      }
    }
  } else if (action.type === "playCard") {
    const def = state.catalog[player?.hand?.[action.handIndex]?.defId];
    if (def?.type === CARD_TYPES.EVENT) add(def.eventEffect, undefined, def);
    else for (const ability of def?.abilities ?? []) {
      if (ability.timing === TIMINGS.WHEN_PLAYED) add(ability.effect, undefined, def);
    }
  } else if (action.type === "performRaid") {
    const def = state.catalog[player?.hand?.[action.handIndex]?.defId];
    const sourcePermanent = player?.[action.targetLine]?.[action.targetIndex];
    for (const ability of def?.abilities ?? []) {
      if (ability.timing === TIMINGS.WHEN_PLAYED) add(ability.effect, sourcePermanent, def);
    }
  } else if (action.type === "declareAttack") {
    const attacker = player?.[action.attackerLine ?? LINES.FRONT]?.[action.attackerIndex];
    for (const ability of permanentAbilities(state, attacker)) {
      if (ability.timing === TIMINGS.WHEN_ATTACKING) add(ability.effect, attacker, state.catalog[attacker?.cards?.at(-1)?.defId]);
    }
  } else if (action.type === "declareBlock") {
    const blocker = player?.frontLine?.[action.blockerIndex];
    for (const ability of permanentAbilities(state, blocker)) {
      if (ability.timing === TIMINGS.WHEN_BLOCKING) add(ability.effect, blocker, state.catalog[blocker?.cards?.at(-1)?.defId]);
    }
  }
  return contexts;
}

function collectAutoplayChoiceAlternatives({
  state,
  playerId,
  effect,
  sourcePermanent,
  sourceDef,
  sourceKind,
  preferredChoices,
  addVariant,
  depth = 0
}) {
  if (!effect || depth > 12) return;
  const recurse = (nextEffect, nextChoices = preferredChoices) => collectAutoplayChoiceAlternatives({
    state,
    playerId,
    effect: nextEffect,
    sourcePermanent,
    sourceDef,
    sourceKind,
    preferredChoices: nextChoices,
    addVariant,
    depth: depth + 1
  });
  const branchChoices = (choiceKey, value, branchEffects = [], resetEffects = branchEffects) => {
    const choices = structuredClone(preferredChoices);
    deleteEffectChoiceKeys(choices, resetEffects);
    choices[choiceKey] = value;
    for (const branchEffect of branchEffects) addChoicesForEffect(choices, state, playerId, branchEffect, sourcePermanent);
    return choices;
  };

  if (effect.kind === "sequence") {
    for (const child of effect.effects ?? []) recurse(child);
    return;
  }

  if (effect.kind === "optional") {
    const choiceKey = effect.choiceKey ?? "optionalEffect";
    const disabled = branchChoices(choiceKey, false, [], [effect.effect]);
    if (addVariant(disabled) === false) return;
    const enabled = branchChoices(choiceKey, true, [effect.effect], [effect.effect]);
    if (addVariant(enabled) === false) return;
    recurse(effect.effect, enabled);
    return;
  }

  if (effect.kind === "restTargetsThen" && effect.optional) {
    const choiceKey = effect.choiceKey ?? "optionalRestTargets";
    const selector = effect.target;
    const targetChoiceKey = selector?.choiceKey ?? "targets";
    const disabled = branchChoices(choiceKey, false, [], [effect.effect]);
    delete disabled[targetChoiceKey];
    if (addVariant(disabled) === false) return;
    const enabled = branchChoices(choiceKey, true, [effect.effect], [effect.effect]);
    delete enabled[targetChoiceKey];
    if (selector && !selector.all) {
      for (const targets of autoplayTargetSelections(state, playerId, effect, selector, sourcePermanent, enabled)) {
        const choices = structuredClone(enabled);
        choices[targetChoiceKey] = targets;
        if (addVariant(choices) === false) return;
        recurse(effect.effect, choices);
      }
    } else {
      if (addVariant(enabled) === false) return;
      recurse(effect.effect, enabled);
    }
    return;
  }

  if (effect.kind === "optionalChoiceUpgrade") {
    const choiceKey = effect.choiceKey ?? "optionalChoiceUpgrade";
    const resetEffects = [effect.baseEffect, effect.upgradedEffect, effect.costEffect];
    const base = branchChoices(choiceKey, false, [effect.baseEffect], resetEffects);
    if (addVariant(base) === false) return;
    recurse(effect.baseEffect, base);
    if (canAutoplayPayEffectCost(state, playerId, effect.costEffect)) {
      const upgraded = branchChoices(choiceKey, true, [effect.upgradedEffect, effect.costEffect], resetEffects);
      if (addVariant(upgraded) === false) return;
      recurse(effect.upgradedEffect, upgraded);
      recurse(effect.costEffect, upgraded);
    }
    return;
  }

  if (effect.kind === "optionalInstead") {
    const choiceKey = effect.choiceKey ?? "optionalInstead";
    const resetEffects = [effect.baseEffect, effect.costEffect, effect.insteadEffect];
    const base = branchChoices(choiceKey, false, [effect.baseEffect], resetEffects);
    if (addVariant(base) === false) return;
    const canUseInstead = (!effect.condition || conditionMet(state, playerId, effect.condition, { permanent: sourcePermanent }))
      && canAutoplayPayEffectCost(state, playerId, effect.costEffect);
    if (canUseInstead) {
      const instead = branchChoices(choiceKey, true, [effect.costEffect, effect.insteadEffect], resetEffects);
      if (addVariant(instead) === false) return;
      recurse(effect.costEffect, instead);
      recurse(effect.insteadEffect, instead);
    }
    recurse(effect.baseEffect, base);
    return;
  }

  if (effect.kind === "chooseOne") {
    const choiceKey = effect.choiceKey ?? "effectChoice";
    const resetEffects = (effect.choices ?? []).map((choice) => choice.effect);
    for (let index = 0; index < Number(effect.choices?.length ?? 0); index += 1) {
      const selectedEffect = effect.choices[index]?.effect;
      const choices = branchChoices(choiceKey, index, [selectedEffect], resetEffects);
      if (addVariant(choices) === false) return;
      recurse(selectedEffect, choices);
    }
    return;
  }

  if (effect.kind === "chooseN") {
    const choiceKey = effect.choiceKey ?? "effectChoices";
    const resetEffects = (effect.choices ?? []).map((choice) => choice.effect);
    for (const selected of autoplayChooseNSelections(state, playerId, effect, sourcePermanent)) {
      const selectedEffects = selected.map((index) => effect.choices?.[index]?.effect).filter(Boolean);
      const choices = branchChoices(choiceKey, selected, selectedEffects, resetEffects);
      if (addVariant(choices) === false) return;
      for (const selectedEffect of selectedEffects) recurse(selectedEffect, choices);
    }
    return;
  }

  if (["searchTopDeck", "lookTopDeckAndMove", "lookTopDeckPlayOneAndMoveRest", "revealTopDeckOptionalPlayOrRaidInstead", "raidSourceFromZone"].includes(effect.kind)) {
    // These decisions happen only after private deck cards have been seen. They
    // cannot be top-level action alternatives without leaking hidden information.
    return;
  }

  if (effect.kind === "revealTopDeckOptionalPlayOrRaidInstead") {
    const playChoiceKey = effect.choiceKey ?? "optionalRevealPlay";
    const raidChoiceKey = effect.raidChoiceKey ?? "performRaid";
    const placementChoiceKey = effect.placementChoiceKey ?? "revealedPlacement";
    const normalPlay = structuredClone(preferredChoices);
    normalPlay[playChoiceKey] = true;
    normalPlay[raidChoiceKey] = false;
    if (addVariant(normalPlay) === false) return;
    if (effect.allowRaid) {
      const raid = structuredClone(preferredChoices);
      raid[playChoiceKey] = true;
      raid[raidChoiceKey] = true;
      if (addVariant(raid) === false) return;
    }
    for (const destination of effect.destinations ?? [effect.defaultDestination ?? "top"]) {
      const decline = structuredClone(preferredChoices);
      decline[playChoiceKey] = false;
      decline[placementChoiceKey] = destination;
      if (addVariant(decline) === false) return;
    }
    return;
  }

  if (["useEventFromZone", "activateTriggerFromZone"].includes(effect.kind)) {
    const choiceKey = effect.choiceKey ?? `${effect.zone ?? effect.zones?.[0] ?? effect.source ?? "hand"}Index`;
    for (const selected of zoneCardChoices(state, playerId, effect, preferredChoices)) {
      const choices = structuredClone(preferredChoices);
      choices[choiceKey] = selected;
      if (addVariant(choices) === false) return;
    }
    return;
  }

  if (effect.kind === "playCardFromZoneMatchingTargetName") {
    let addedDecline = false;
    for (const plan of matchingTargetPlayPlans(state, playerId, effect, sourcePermanent, preferredChoices)) {
      const baseChoices = structuredClone(preferredChoices);
      baseChoices[plan.targetChoiceKey] = plan.targets;
      baseChoices[effect.choiceKey ?? `${effect.zone ?? effect.zones?.[0] ?? "hand"}Index`] = stableZoneCardChoice(plan.entry);
      if (!addedDecline && Number(effect.min ?? 1) === 0) {
        const decline = structuredClone(baseChoices);
        decline[effect.choiceKey ?? `${effect.zone ?? effect.zones?.[0] ?? "hand"}Index`] = [];
        delete decline[effect.destinationLineChoiceKey ?? "destinationLine"];
        delete decline[effect.replaceChoiceKey ?? "replaceIndex"];
        if (addVariant(decline) === false) return;
        addedDecline = true;
      }
      for (const destinationLines of playDestinationLinePlans(effect, 1)) {
        const destinationChoices = structuredClone(baseChoices);
        assignPlayDestinationLineChoice(destinationChoices, effect, destinationLines);
        for (const choices of choicesWithDestinationLineReplacements(state, playerId, effect, destinationChoices, destinationLines)) {
          if (addVariant(choices) === false) return;
        }
      }
    }
    return;
  }

  if (effect.kind === "playSourceFromZone") {
    for (const destinationLines of playDestinationLinePlans(effect, 1)) {
      const baseChoices = structuredClone(preferredChoices);
      assignPlayDestinationLineChoice(baseChoices, effect, destinationLines);
      for (const choices of choicesWithDestinationLineReplacements(state, playerId, effect, baseChoices, destinationLines)) {
        if (addVariant(choices) === false) return;
      }
    }
    return;
  }

  if (effect.kind === "playCardFromZone") {
    if (hiddenZoneSelectionOwnedOutsidePolicy(playerId, effect)) return;
    const entries = zoneCardChoiceEntries(state, playerId, effect, preferredChoices);
    const maximum = Math.min(entries.length, Number(effect.count ?? effect.amount ?? effect.max ?? 1));
    const minimum = Math.min(maximum, Number(effect.min ?? (maximum > 1 ? 0 : maximum)));
    const indexed = entries.map((entry, index) => ({ card: entry.card, index }));
    for (const positions of boundedCardIndexSelections(indexed, { min: minimum, max: maximum, state })) {
      const selected = positions.map((position) => stableZoneCardChoice(entries[position]));
      const orders = selected.length > 1 || effect.simultaneous
        ? boundedIndexOrders(selected.length)
        : [undefined];
      for (const order of orders) {
        for (const destinationLines of playDestinationLinePlans(effect, selected.length)) {
          const baseChoices = structuredClone(preferredChoices);
          baseChoices[effect.choiceKey ?? `${effect.zone ?? effect.zones?.[0] ?? "hand"}Index`] = maximum > 1 || effect.simultaneous
            ? selected
            : selected[0];
          assignPlayDestinationLineChoice(baseChoices, effect, destinationLines);
          if (order) baseChoices[effect.abilityOrderChoiceKey ?? "simultaneousPlayedOrder"] = order;
          for (const choices of choicesWithDestinationLineReplacements(state, playerId, effect, baseChoices, destinationLines)) {
            if (addVariant(choices) === false) return;
          }
        }
      }
    }
    return;
  }

  if (effect.kind === "moveCardBetweenZones") {
    if (effect.all || hiddenZoneSelectionOwnedOutsidePolicy(playerId, effect)) return;
    const entries = moveZoneCardChoiceEntries(state, playerId, effect, preferredChoices);
    const count = Math.min(entries.length, Number(effect.count ?? effect.amount ?? 1));
    const required = Math.min(count, Number(effect.requiredMovedCountForFollowing ?? effect.min ?? count));
    const indexed = entries.map((entry, index) => ({ card: entry.card, index }));
    for (const positions of boundedCardIndexSelections(indexed, { min: required, max: required, state })) {
      const selected = positions.map((position) => moveZoneCardChoice(entries[position]));
      const choices = structuredClone(preferredChoices);
      choices[effect.choiceKey ?? `${effect.source ?? "sideline"}Index`] = count > 1 ? selected : selected[0];
      if (addVariant(choices) === false) return;
    }
    return;
  }

  if (effect.kind === "playOrRaidCardFromZone") {
    const entries = zoneCardChoiceEntries(state, playerId, effect, preferredChoices);
    const count = Math.min(entries.length, Number(effect.count ?? effect.amount ?? effect.max ?? 1));
    const min = Math.min(count, Number(effect.min ?? (count > 1 ? 0 : count)));
    const selectionEntries = entries.map((entry, index) => ({ card: entry.card, index }));
    for (const positions of boundedCardIndexSelections(selectionEntries, { min, max: count, state })) {
      const selected = positions.map((position) => playOrRaidZoneChoice(entries[position]));
      const choiceValue = count > 1 || effect.simultaneous ? selected : selected[0];
      const raidPlans = effect.forceRaid || !effect.allowRaid
        ? [Array(selected.length).fill(Boolean(effect.forceRaid))]
        : raidBooleanPlans(selected.length);
      for (const raidPlan of raidPlans) {
        const targetPlans = raidTargetPlansForSelectedCards(state, playerId, effect, selected, raidPlan, sourcePermanent, sourceKind);
        if (targetPlans.length === 0) continue;
        const cardDefs = selected.map((choice) => {
          const card = state.players[choice.player ?? playerId]?.[choice.zone]?.find((candidate) => candidate.uid === choice.uid)
            ?? state.players[choice.player ?? playerId]?.[choice.zone]?.[choice.index];
          return state.catalog[card?.defId];
        });
        const normalPlayMask = raidPlan.map((raid) => !raid && !effect.nonRaidDestination);
        const orders = selected.length > 1 || effect.simultaneous
          ? boundedIndexOrders(selected.length)
          : [undefined];
        for (const targetPlan of targetPlans) {
          for (const movement of raidMovementPlansForTargets(state, playerId, cardDefs, raidPlan, targetPlan)) {
            for (const order of orders) {
              for (const destinationLines of playDestinationLinePlans(effect, selected.length, normalPlayMask)) {
                const baseChoices = structuredClone(preferredChoices);
                baseChoices[effect.choiceKey ?? `${effect.zones?.[0] ?? effect.zone ?? "hand"}Index`] = choiceValue;
                baseChoices[effect.raidChoiceKey ?? "performRaid"] = selected.length > 1 ? raidPlan : raidPlan[0];
                baseChoices[effect.raidMoveChoiceKey ?? "moveRaidToFront"] = selected.length > 1
                  ? movement.moves
                  : movement.moves[0];
                if (movement.replacements.some(Boolean)) {
                  baseChoices[effect.raidMoveReplaceChoiceKey ?? "raidMoveReplaceIndex"] = selected.length > 1
                    ? movement.replacements
                    : movement.replacements[0];
                } else {
                  delete baseChoices[effect.raidMoveReplaceChoiceKey ?? "raidMoveReplaceIndex"];
                }
                if (targetPlan !== undefined) {
                  baseChoices[effect.raidTargetChoiceKey ?? "raidTarget"] = selected.length > 1 ? targetPlan : targetPlan[0];
                } else {
                  delete baseChoices[effect.raidTargetChoiceKey ?? "raidTarget"];
                }
                assignPlayDestinationLineChoice(baseChoices, effect, destinationLines, normalPlayMask);
                if (order) baseChoices[effect.abilityOrderChoiceKey ?? "simultaneousPlayedOrder"] = order;
                for (const choices of choicesWithDestinationLineReplacements(
                  state,
                  playerId,
                  effect,
                  baseChoices,
                  destinationLines,
                  normalPlayMask
                )) {
                  if (addVariant(choices) === false) return;
                }
              }
            }
          }
        }
      }
    }
    return;
  }

  if (effect.kind === "moveHandToZone") {
    const count = Number(effect.count ?? effect.amount ?? effect.max ?? 1);
    const eligible = (state.players[playerId]?.hand ?? [])
      .map((card, index) => ({ card, index, score: cardValue(state, card) }))
      .filter(({ card }) => !effect.filter || zoneCardMatches(state, card, effect.filter))
      .sort((left, right) => left.score - right.score || left.index - right.index);
    const min = Math.min(eligible.length, Number(effect.min ?? count));
    const max = Math.min(eligible.length, Math.max(min, count));
    for (const selected of boundedCardIndexSelections(eligible, { min, max, state })) {
      const destinations = effect.kind === "moveHandToZone" && effect.destinations?.length > 0
        ? effect.destinations
        : [undefined];
      const positions = effect.kind === "moveHandToZone" && effect.positions?.length > 0
        ? effect.positions
        : [undefined];
      for (const destination of destinations) {
        for (const position of positions) {
          const choices = structuredClone(preferredChoices);
          choices[effect.choiceKey ?? "handIndices"] = selected;
          if (destination !== undefined) choices[effect.destinationChoiceKey ?? "handDestinations"] = destination;
          if (position !== undefined) choices[effect.positionChoiceKey ?? "handDeckPositions"] = position;
          if (addVariant(choices) === false) return;
        }
      }
    }
    return;
  }

  if (effect.kind === "moveHandCardsUnderSelf" || effect.kind === "moveHandCardsUnderTargets") {
    for (const plan of handUnderMovePlans(state, playerId, effect, sourcePermanent, preferredChoices)) {
      const choices = structuredClone(preferredChoices);
      if (plan.targetChoiceKey) choices[plan.targetChoiceKey] = plan.targets;
      choices[effect.choiceKey ?? "handIndices"] = plan.handCards;
      if (addVariant(choices) === false) return;
    }
    return;
  }

  if (["moveZoneCardsUnderSelf", "moveZoneCardsUnderTargets"].includes(effect.kind)) {
    for (const plan of zoneUnderMovePlans(state, playerId, effect, sourcePermanent, preferredChoices)) {
      const choices = structuredClone(preferredChoices);
      if (plan.targetChoiceKey) choices[plan.targetChoiceKey] = plan.targets;
      choices[effect.choiceKey ?? `${effect.source ?? "sideline"}UnderCards`] = plan.zoneCards;
      if (addVariant(choices) === false) return;
    }
    return;
  }

  if (effect.kind === "moveEqualCountsBetweenZones") {
    const sourcePlayerId = effect.player === "opponent" ? opponentOf(playerId) : effect.player ?? playerId;
    const source = state.players[sourcePlayerId]?.[effect.source ?? "sideline"] ?? [];
    const counts = (effect.filters ?? []).map((filter) => source.filter((card) => zoneCardMatches(state, card, filter)).length);
    const maximum = counts.length > 0 ? Math.min(...counts) : 0;
    const minimum = Number(effect.minEach ?? effect.countEach ?? 0);
    for (let count = minimum; count <= maximum; count += 1) {
      const choices = structuredClone(preferredChoices);
      choices[effect.countChoiceKey ?? "equalZoneMoveCount"] = count;
      if (addVariant(choices) === false) return;
    }
    return;
  }

  if (effect.kind === "swapSourceWithOtherLine" && sourcePermanent) {
    const player = state.players[playerId];
    const sourceLine = player.frontLine.some((permanent) => permanent.pid === sourcePermanent.pid) ? LINES.FRONT : LINES.ENERGY;
    const otherLine = sourceLine === LINES.FRONT ? LINES.ENERGY : LINES.FRONT;
    for (let index = 0; index < player[otherLine].length; index += 1) {
      const choices = structuredClone(preferredChoices);
      choices[effect.choiceKey ?? "swapTargetIndex"] = { player: playerId, line: otherLine, index };
      if (addVariant(choices) === false) return;
    }
    return;
  }

  if (effect.kind === "swapTargetsWithOtherLine") {
    for (const plan of swapTargetPlans(state, playerId, effect, sourcePermanent, preferredChoices)) {
      const choices = structuredClone(preferredChoices);
      choices[plan.targetChoiceKey] = plan.targets;
      choices[effect.swapChoiceKey ?? "swapTargetIndex"] = plan.swapTarget;
      if (addVariant(choices) === false) return;
    }
    return;
  }

  if (effect.kind === "swapChosenTargets") {
    for (const plan of swapChosenTargetPlans(state, playerId, effect, sourcePermanent, preferredChoices)) {
      const choices = structuredClone(preferredChoices);
      choices[plan.firstChoiceKey] = plan.firstTargets;
      choices[plan.secondChoiceKey] = plan.secondTargets;
      if (addVariant(choices) === false) return;
    }
    return;
  }

  if (effect.kind === "moveOrSwapTargetsToOtherLine") {
    for (const plan of moveOrSwapTargetPlans(state, playerId, effect, sourcePermanent, preferredChoices)) {
      const choices = structuredClone(preferredChoices);
      choices[plan.targetChoiceKey] = plan.targets;
      choices[effect.swapChoiceKey ?? "moveOrSwapTargets"] = plan.moveOrSwapChoices;
      if (addVariant(choices) === false) return;
    }
    return;
  }

  if (effect.kind === "sidelineTargetsThenActivateSourceWhenPlayed") {
    for (const order of [["whenPlayed", "whenSidelined"], ["whenSidelined", "whenPlayed"]]) {
      const choices = structuredClone(preferredChoices);
      choices[effect.orderChoiceKey ?? "simultaneousAbilityOrder"] = order;
      if (addVariant(choices) === false) return;
    }
  }

  if (effect.kind === "swapOwnFrontAndEnergy") {
    const targetPlayerId = effect.player === "opponent" ? opponentOf(playerId) : effect.player ?? playerId;
    const targetPlayer = state.players[targetPlayerId];
    for (let frontIndex = 0; frontIndex < targetPlayer.frontLine.length; frontIndex += 1) {
      for (let energyIndex = 0; energyIndex < targetPlayer.energyLine.length; energyIndex += 1) {
        const choices = structuredClone(preferredChoices);
        choices[effect.frontChoiceKey ?? "frontIndex"] = { player: targetPlayerId, line: LINES.FRONT, index: frontIndex };
        choices[effect.energyChoiceKey ?? "energyIndex"] = { player: targetPlayerId, line: LINES.ENERGY, index: energyIndex };
        if (addVariant(choices) === false) return;
      }
    }
    return;
  }

  if (effect.kind === "restEnergyLineForRequiredEnergyTotal") {
    const entries = state.players[playerId].energyLine
      .map((permanent, index) => ({ permanent, card: permanent.cards.at(-1), index }))
      .filter(({ permanent }) => !permanent.rested);
    const indexed = entries.map((entry, index) => ({ card: entry.card, index }));
    for (const positions of boundedCardIndexSelections(indexed, { min: 0, max: entries.length, state })) {
      const choices = structuredClone(preferredChoices);
      choices[effect.choiceKey ?? "energyRestIndices"] = positions.map((position) => ({
        player: playerId,
        line: LINES.ENERGY,
        index: entries[position].index
      }));
      if (addVariant(choices) === false) return;
    }
    return;
  }

  if (effect.kind === "moveTargetsToDeck" && effect.positions?.length > 0) {
    const selector = targetSelectorForEffect(effect);
    const targetSelections = selector && !selector.all
      ? autoplayTargetSelections(state, playerId, effect, selector, sourcePermanent, preferredChoices)
      : [null];
    for (const position of effect.positions) {
      for (const targets of targetSelections) {
        const choices = structuredClone(preferredChoices);
        choices[effect.positionChoiceKey ?? "deckPosition"] = position;
        if (targets) choices[selector.choiceKey ?? "targets"] = targets;
        if (addVariant(choices) === false) return;
      }
    }
    return;
  }

  if (effect.kind === "revealHandCards") {
    const eligible = (state.players[playerId]?.hand ?? [])
      .map((card, index) => ({ card, index, score: cardValue(state, card) }))
      .filter(({ card }) => zoneCardMatches(state, card, effect.filter ?? {}))
      .sort((left, right) => right.score - left.score || left.index - right.index);
    const min = Math.max(0, Number(effect.min ?? 0));
    const max = Math.min(eligible.length, Math.max(min, Number(effect.max ?? effect.count ?? effect.amount ?? 1)));
    for (const selected of boundedCardIndexSelections(eligible, { min, max, state })) {
      const choices = structuredClone(preferredChoices);
      choices[effect.choiceKey ?? "revealHandIndices"] = selected.map((index) => stableHandCardChoice(state, playerId, index));
      if (addVariant(choices) === false) return;
    }
    return;
  }

  if (effect.kind === "modifyBpForHandReveal") {
    if (effect.uniqueNames) {
      for (const selected of handRevealSelections(state, playerId, effect)) {
        const choices = structuredClone(preferredChoices);
        choices[effect.choiceKey ?? "revealHandIndices"] = selected;
        if (addVariant(choices) === false) return;
      }
    } else {
      const maximum = Math.min(
        state.players[playerId].hand.filter((card) => zoneCardMatches(state, card, effect.filter ?? {})).length,
        Number(effect.max ?? effect.count ?? effect.amount ?? state.players[playerId].hand.length)
      );
      for (let count = Number(effect.min ?? 0); count <= maximum; count += 1) {
        const choices = structuredClone(preferredChoices);
        choices[effect.choiceKey ?? "revealHandCount"] = count;
        if (addVariant(choices) === false) return;
      }
    }
    return;
  }

  if (effect.kind === "playSomeNamedFromSidelineAddRest") {
    const entries = namedSidelinePlayEntries(state, playerId, effect);
    const count = Math.min(entries.length, Number(effect.playCount ?? 0));
    const indexed = entries.map((entry, index) => ({ card: entry.card, index }));
    for (const selection of boundedCardIndexSelections(indexed, { min: count, max: count, state })) {
      const baseChoices = structuredClone(preferredChoices);
      baseChoices[effect.choiceKey ?? "playNamedIndices"] = selection.map((index) => stableZoneCardChoice(entries[index]));
      for (const choices of choicesWithLineReplacements(state, playerId, effect, baseChoices, selection.length, { mode: "sequential" })) {
        if (addVariant(choices) === false) return;
      }
    }
    return;
  }

  if (effect.kind === "moveUnderCardsToZone" && !effect.all) {
    for (const plan of underCardMovePlans(state, playerId, effect, sourcePermanent, preferredChoices)) {
      const choices = structuredClone(preferredChoices);
      if (plan.targetChoiceKey) choices[plan.targetChoiceKey] = plan.targets;
      choices[effect.choiceKey ?? "underCardChoices"] = plan.underCards;
      if (addVariant(choices) === false) return;
    }
    return;
  }

  if (effect.kind === "conditional") {
    if (conditionNeedsResolutionContext(effect.condition)) {
      recurse(effect.effect);
      recurse(effect.elseEffect);
    } else {
      recurse(conditionMet(state, playerId, effect.condition, { permanent: sourcePermanent })
        ? effect.effect
        : effect.elseEffect);
    }
    return;
  }

  if (effect.kind === "targetConditional") {
    recurse(effect.effect);
    recurse(effect.elseEffect);
  }

  const selector = targetSelectorForEffect(effect);
  if (selector && !selector.all) {
    for (const targets of autoplayTargetSelections(state, playerId, effect, selector, sourcePermanent, preferredChoices)) {
      const choices = structuredClone(preferredChoices);
      choices[selector.choiceKey ?? "targets"] = targets;
      const paymentCount = targetTaxHandPaymentCount(state, playerId, targets, sourcePermanent, sourceDef, sourceKind);
      if (paymentCount === 0) {
        if (addVariant(choices) === false) return;
        continue;
      }
      const eligible = state.players[playerId].hand.map((card, index) => ({ card, index }));
      for (const selection of boundedCardIndexSelections(eligible, { min: paymentCount, max: paymentCount, state })) {
        const paidChoices = structuredClone(choices);
        paidChoices.targetTaxHandIndices = selection.map((index) => stableHandCardChoice(state, playerId, index));
        if (addVariant(paidChoices) === false) return;
      }
    }
  }
}

function targetTaxHandPaymentCount(state, playerId, targets, sourcePermanent, sourceDef, sourceKind) {
  return targets.reduce((total, target) => {
    const targetPlayerId = target?.player ?? target?.playerId ?? playerId;
    const lineName = target?.lineName ?? target?.line;
    const permanent = state.players[targetPlayerId]?.[lineName]?.[target?.index];
    const payments = internals.targetingTaxPaymentsForTarget(state, playerId, targetPlayerId, permanent, {
      permanent: sourcePermanent,
      sourceDef,
      sourceKind
    });
    return total + Number(payments.handToSideline ?? 0);
  }, 0);
}

function autoplayChooseNSelections(state, playerId, effect, sourcePermanent) {
  const choiceCount = Number(effect.choices?.length ?? 0);
  const min = Math.max(0, Number(effect.min ?? 0));
  const max = Math.min(choiceCount, Math.max(min, Number(
    effect.maxIf?.condition && conditionMet(state, playerId, effect.maxIf.condition, { permanent: sourcePermanent })
      ? effect.maxIf.value ?? effect.maxIf.max ?? effect.max ?? choiceCount
      : effect.max ?? choiceCount
  )));
  const scoredIndices = (effect.choices ?? [])
    .map((choice, index) => ({ index, score: effectScore(state, playerId, choice.effect, sourcePermanent) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.index);
  const selections = [];
  const visit = (offset, selected) => {
    if (selections.length >= MAX_AUTOPLAY_CHOICE_VARIANTS_PER_ACTION * 2) return;
    if (selected.length >= min) selections.push([...selected].sort((left, right) => left - right));
    if (selected.length >= max) return;
    for (let index = offset; index < scoredIndices.length; index += 1) {
      selected.push(scoredIndices[index]);
      visit(index + 1, selected);
      selected.pop();
      if (selections.length >= MAX_AUTOPLAY_CHOICE_VARIANTS_PER_ACTION * 2) return;
    }
  };
  visit(0, []);
  return selections;
}

function boundedCardIndexSelections(entries, { min = 0, max = 1, uniqueNames = false, state } = {}) {
  const selections = [];
  const visit = (offset, selected, names) => {
    if (selections.length >= MAX_AUTOPLAY_CHOICE_VARIANTS_PER_ACTION * 2) return;
    if (selected.length >= min) selections.push([...selected].sort((left, right) => left - right));
    if (selected.length >= max) return;
    for (let index = offset; index < entries.length; index += 1) {
      const entry = entries[index];
      const name = state?.catalog?.[entry.card?.defId]?.name?.toLowerCase() ?? null;
      if (uniqueNames && name && names.has(name)) continue;
      selected.push(entry.index);
      if (name) names.add(name);
      visit(index + 1, selected, names);
      if (name) names.delete(name);
      selected.pop();
      if (selections.length >= MAX_AUTOPLAY_CHOICE_VARIANTS_PER_ACTION * 2) return;
    }
  };
  visit(0, [], new Set());
  return selections;
}

function boundedIndexOrders(count) {
  const orders = [];
  const visit = (remaining, selected) => {
    if (orders.length >= MAX_AUTOPLAY_CHOICE_VARIANTS_PER_ACTION * 2) return;
    if (remaining.length === 0) {
      orders.push([...selected]);
      return;
    }
    for (let index = 0; index < remaining.length; index += 1) {
      const [value] = remaining.splice(index, 1);
      selected.push(value);
      visit(remaining, selected);
      selected.pop();
      remaining.splice(index, 0, value);
      if (orders.length >= MAX_AUTOPLAY_CHOICE_VARIANTS_PER_ACTION * 2) return;
    }
  };
  visit([...Array(count).keys()], []);
  return orders;
}

function addSearchRemainingDestinationChoices(choices, state, effect, looked, selected) {
  if (!effect.remainingDestinations) return;
  const selectedSet = new Set(selected);
  const allowed = new Set(effect.remainingDestinations);
  choices[effect.remainingDestinationChoiceKey ?? "searchRemainingDestinations"] = looked
    .filter((_, index) => !selectedSet.has(index))
    .map((card) => {
      if (allowed.has("top") && allowed.has("bottom")) return cardValue(state, card) >= 180 ? "top" : "bottom";
      return effect.defaultRemainingDestination ?? effect.remainingDestinations[0];
    });
}

function zoneCardChoices(state, playerId, effect, choices = {}) {
  return zoneCardChoiceEntries(state, playerId, effect, choices).map((candidate) => candidate.choice);
}

function zoneCardChoiceEntries(state, playerId, effect, choices = {}) {
  const zones = effect.zones ?? [effect.zone ?? effect.source ?? "hand"];
  const zonePlayerId = effect.player === "opponent" ? opponentOf(playerId) : effect.player ?? playerId;
  const candidates = [];
  for (const zoneName of zones) {
    const zone = state.players[zonePlayerId]?.[zoneName] ?? [];
    zone.forEach((card, index) => {
      if (!zoneCardMatches(state, card, effect.filter, { playerId, choices })) return;
      candidates.push({
        choice: zones.length === 1 ? index : { zone: zoneName, index },
        zonePlayerId,
        zoneName,
        index,
        card,
        score: cardValue(state, card) + (zoneName === "sideline" ? 50 : 0)
      });
    });
  }
  return candidates
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_AUTOPLAY_CHOICE_VARIANTS_PER_ACTION * 2)
    .map((candidate) => candidate);
}

function playOrRaidZoneChoice(entry) {
  return { zone: entry.zoneName, index: entry.index, uid: entry.card.uid };
}

function stableZoneCardChoice(entry) {
  return {
    player: entry.zonePlayerId,
    zone: entry.zoneName,
    index: entry.index,
    uid: entry.card.uid
  };
}

function stableHandCardChoice(state, playerId, index) {
  const card = state.players[playerId]?.hand?.[index];
  return { player: playerId, zone: "hand", index, uid: card?.uid };
}

function namedSidelinePlayEntries(state, playerId, effect) {
  const remaining = state.players[playerId].sideline.map((card, index) => ({
    card,
    index,
    zoneName: "sideline",
    zonePlayerId: playerId
  }));
  const entries = [];
  for (const name of effect.names ?? []) {
    const index = remaining.findIndex((entry) => cardDefHasName(state.catalog[entry.card.defId], name));
    if (index !== -1) entries.push(remaining.splice(index, 1)[0]);
  }
  return entries;
}

function permanentChoiceLocation(state, permanent) {
  if (!permanent) return undefined;
  const playerId = permanent.controller ?? permanent.owner;
  for (const lineName of [LINES.FRONT, LINES.ENERGY]) {
    const index = state.players[playerId]?.[lineName]?.findIndex((candidate) => candidate.pid === permanent.pid) ?? -1;
    if (index !== -1) return { playerId, lineName, index, permanent };
  }
  return undefined;
}

function stableLinePermanentChoice(state, playerId, lineName, index) {
  const permanent = state.players[playerId]?.[lineName]?.[index];
  return {
    player: playerId,
    line: lineName,
    index,
    permanentId: permanent?.pid
  };
}

function lineReplacementChoicePlans(state, playerId, lineName, additions, { mode = "single" } = {}) {
  const line = state.players[playerId]?.[lineName] ?? [];
  const capacity = internals.lineCapacity(state, playerId, lineName);
  const replacementCount = Math.max(0, line.length + additions - capacity);
  if (replacementCount === 0) return [undefined];
  if (replacementCount > line.length) return [];
  const ranked = line
    .map((permanent, index) => ({
      card: permanent.cards?.at(-1),
      index,
      score: permanentBattlePower(state, permanent) + Math.max(0, permanent.cards.length - 1) * 250
    }))
    .sort((left, right) => left.score - right.score || left.index - right.index);
  return boundedCardIndexSelections(ranked, { min: replacementCount, max: replacementCount, state }).map((selection) => {
    const replacements = selection.map((index) => stableLinePermanentChoice(state, playerId, lineName, index));
    if (mode === "compact") return replacements;
    if (mode === "sequential" && additions > 1) {
      const choices = Array(additions).fill(null);
      const firstReplacement = Math.max(0, capacity - line.length);
      replacements.forEach((replacement, index) => {
        choices[firstReplacement + index] = replacement;
      });
      return choices;
    }
    return replacements[0];
  });
}

function choicesWithLineReplacements(state, playerId, effect, baseChoices, additions, options = {}) {
  const destinationChoice = baseChoices[effect.destinationLineChoiceKey ?? "destinationLine"];
  const lineName = Array.isArray(destinationChoice)
    ? destinationChoice[0] ?? effect.destinationLines?.[0] ?? effect.destinationLine ?? LINES.FRONT
    : destinationChoice ?? effect.destinationLines?.[0] ?? effect.destinationLine ?? LINES.FRONT;
  const key = effect.replaceChoiceKey ?? "replaceIndex";
  return lineReplacementChoicePlans(state, playerId, lineName, additions, options).map((replacementChoice) => {
    const choices = structuredClone(baseChoices);
    if (replacementChoice === undefined) delete choices[key];
    else choices[key] = replacementChoice;
    return choices;
  });
}

function playDestinationLinePlans(effect, count, normalPlayMask = Array(count).fill(true)) {
  const allowed = effect.destinationLines?.length
    ? effect.destinationLines
    : [effect.destinationLine ?? LINES.FRONT];
  const plans = [];
  const visit = (index, lines) => {
    if (plans.length >= MAX_AUTOPLAY_CHOICE_VARIANTS_PER_ACTION * 2) return;
    if (index >= count) {
      plans.push([...lines]);
      return;
    }
    if (!normalPlayMask[index]) {
      lines.push(null);
      visit(index + 1, lines);
      lines.pop();
      return;
    }
    for (const lineName of allowed) {
      lines.push(lineName);
      visit(index + 1, lines);
      lines.pop();
    }
  };
  visit(0, []);
  return plans;
}

function assignPlayDestinationLineChoice(choices, effect, destinationLines, normalPlayMask = Array(destinationLines.length).fill(true)) {
  if (!effect.destinationLines?.length) return;
  const selected = destinationLines.map((lineName, index) => normalPlayMask[index] ? lineName : null);
  const key = effect.destinationLineChoiceKey ?? "destinationLine";
  if (selected.length === 1) {
    if (selected[0]) choices[key] = selected[0];
    else delete choices[key];
  } else {
    choices[key] = selected;
  }
}

function choicesWithDestinationLineReplacements(
  state,
  playerId,
  effect,
  baseChoices,
  destinationLines,
  normalPlayMask = Array(destinationLines.length).fill(true)
) {
  const normalPlayIndices = normalPlayMask
    .map((normal, index) => ({ normal, index }))
    .filter(({ normal, index }) => normal && destinationLines[index])
    .map(({ index }) => index);
  if (normalPlayIndices.length === 0) {
    const choices = structuredClone(baseChoices);
    delete choices[effect.replaceChoiceKey ?? "replaceIndex"];
    return [choices];
  }

  const groups = new Map();
  for (const index of normalPlayIndices) {
    const lineName = destinationLines[index];
    if (!groups.has(lineName)) groups.set(lineName, []);
    groups.get(lineName).push(index);
  }
  let replacementPlans = [Array(destinationLines.length).fill(null)];
  for (const [lineName, selectedIndices] of groups) {
    const linePlans = lineReplacementChoicePlans(state, playerId, lineName, selectedIndices.length, { mode: "sequential" });
    const nextPlans = [];
    for (const replacementPlan of replacementPlans) {
      for (const linePlan of linePlans) {
        const next = [...replacementPlan];
        const localReplacements = Array.isArray(linePlan) ? linePlan : [linePlan];
        selectedIndices.forEach((selectedIndex, offset) => {
          next[selectedIndex] = localReplacements[offset] ?? null;
        });
        nextPlans.push(next);
      }
    }
    replacementPlans = nextPlans;
  }

  return replacementPlans.map((replacementPlan) => {
    const choices = structuredClone(baseChoices);
    const key = effect.replaceChoiceKey ?? "replaceIndex";
    if (replacementPlan.every((replacement) => replacement === null)) delete choices[key];
    else choices[key] = replacementPlan.length === 1 ? replacementPlan[0] : replacementPlan;
    return choices;
  });
}

function stableUnderCardChoice(target, underIndex) {
  const card = target.permanent.cards[underIndex];
  return {
    player: target.playerId,
    line: target.lineName,
    index: target.index,
    permanentId: target.permanent.pid,
    underIndex,
    uid: card?.uid
  };
}

function underCardMovePlans(state, playerId, effect, sourcePermanent, choices = {}) {
  const selector = targetSelectorForEffect(effect);
  const targetChoiceKey = selector?.choiceKey ?? "targets";
  const sourceTarget = permanentChoiceLocation(state, sourcePermanent);
  const targetSelections = selector
    ? autoplayTargetSelections(state, playerId, effect, selector, sourcePermanent, choices)
    : sourceTarget ? [[{ player: sourceTarget.playerId, lineName: sourceTarget.lineName, index: sourceTarget.index }]] : [];
  const plans = [];
  for (const targets of targetSelections) {
    if (targets.length === 0) {
      plans.push({ targetChoiceKey: selector ? targetChoiceKey : undefined, targets, underCards: [] });
      continue;
    }
    const target = targetPermanentForChoice(state, playerId, targets[0]);
    if (!target) continue;
    const underCards = target.permanent.cards.slice(0, -1);
    const count = Math.min(underCards.length, Number(effect.count ?? effect.amount ?? 1));
    const entries = underCards.map((card, index) => ({ card, index }));
    for (const selection of boundedCardIndexSelections(entries, { min: count, max: count, state })) {
      plans.push({
        targetChoiceKey: selector ? targetChoiceKey : undefined,
        targets,
        underCards: selection.map((index) => stableUnderCardChoice(target, index))
      });
      if (plans.length >= MAX_AUTOPLAY_CHOICE_VARIANTS_PER_ACTION * 2) return plans;
    }
  }
  return plans;
}

function zoneUnderMovePlans(state, playerId, effect, sourcePermanent, choices = {}) {
  if (hiddenZoneSelectionOwnedOutsidePolicy(playerId, effect)) return [];
  const selector = effect.kind === "moveZoneCardsUnderTargets" ? targetSelectorForEffect(effect) : undefined;
  const targetChoiceKey = selector?.choiceKey ?? "targets";
  const targetSelections = selector && !selector.all
    ? autoplayTargetSelections(state, playerId, effect, selector, sourcePermanent, choices)
    : [undefined];
  const entries = moveZoneCardChoiceEntries(state, playerId, effect, choices);
  const max = Math.min(entries.length, Number(effect.count ?? effect.amount ?? 1));
  const min = Math.min(max, Number(effect.min ?? max));
  const indexed = entries.map((entry, index) => ({ card: entry.card, index }));
  const plans = [];
  for (const targets of targetSelections) {
    for (const selection of boundedCardIndexSelections(indexed, { min, max, state })) {
      if (selection.length > 0 && selector && !selector.all && targets.length === 0) continue;
      if (selection.length === 0 && plans.some((plan) => plan.zoneCards.length === 0)) continue;
      plans.push({
        targetChoiceKey: selector && !selector.all ? targetChoiceKey : undefined,
        targets,
        zoneCards: selection.map((index) => moveZoneCardChoice(entries[index]))
      });
      if (plans.length >= MAX_AUTOPLAY_CHOICE_VARIANTS_PER_ACTION * 2) break;
    }
    if (plans.length >= MAX_AUTOPLAY_CHOICE_VARIANTS_PER_ACTION * 2) break;
  }
  return plans.sort((left, right) => right.zoneCards.length - left.zoneCards.length);
}

function handUnderMovePlans(state, playerId, effect, sourcePermanent, choices = {}) {
  const selector = effect.kind === "moveHandCardsUnderTargets" ? targetSelectorForEffect(effect) : undefined;
  const targetChoiceKey = selector?.choiceKey ?? "targets";
  const targetSelections = selector && !selector.all
    ? autoplayTargetSelections(state, playerId, effect, selector, sourcePermanent, choices)
    : [undefined];
  const eligible = (state.players[playerId]?.hand ?? [])
    .map((card, index) => ({ card, index, score: cardValue(state, card) }))
    .filter(({ card }) => !effect.filter || zoneCardMatches(state, card, effect.filter))
    .sort((left, right) => left.score - right.score || left.index - right.index);
  const max = Math.min(eligible.length, Number(effect.count ?? effect.amount ?? effect.max ?? 1));
  const min = Math.min(max, Number(effect.min ?? max));
  const plans = [];
  for (const targets of targetSelections) {
    for (const selection of boundedCardIndexSelections(eligible, { min, max, state })) {
      if (selection.length > 0 && selector && !selector.all && targets.length === 0) continue;
      if (selection.length === 0 && plans.some((plan) => plan.handCards.length === 0)) continue;
      plans.push({
        targetChoiceKey: selector && !selector.all ? targetChoiceKey : undefined,
        targets,
        handCards: selection.map((index) => stableHandCardChoice(state, playerId, index))
      });
      if (plans.length >= MAX_AUTOPLAY_CHOICE_VARIANTS_PER_ACTION * 2) break;
    }
    if (plans.length >= MAX_AUTOPLAY_CHOICE_VARIANTS_PER_ACTION * 2) break;
  }
  return plans.sort((left, right) => right.handCards.length - left.handCards.length);
}

function targetPermanentForChoice(state, playerId, target) {
  if (!target || typeof target !== "object") return undefined;
  const targetPlayerId = target.player ?? target.playerId ?? playerId;
  const lineName = target.lineName ?? target.line;
  const permanent = state.players[targetPlayerId]?.[lineName]?.[target.index];
  return permanent ? { playerId: targetPlayerId, lineName, index: target.index, permanent } : undefined;
}

function matchingTargetPlayPlans(state, playerId, effect, sourcePermanent, choices = {}) {
  const selector = targetSelectorForEffect(effect);
  if (!selector || selector.all) return [];
  const targetChoiceKey = selector.choiceKey ?? "targets";
  const plans = [];
  for (const targets of autoplayTargetSelections(state, playerId, effect, selector, sourcePermanent, choices)) {
    const target = targetPermanentForChoice(state, playerId, targets[0]);
    const name = state.catalog[target?.permanent?.cards?.at(-1)?.defId]?.name;
    if (!name) continue;
    const matchingEffect = {
      ...effect,
      filter: { ...(effect.filter ?? {}), name }
    };
    for (const entry of zoneCardChoiceEntries(state, playerId, matchingEffect, choices)) {
      plans.push({ targetChoiceKey, targets, entry });
      if (plans.length >= MAX_AUTOPLAY_CHOICE_VARIANTS_PER_ACTION * 2) return plans;
    }
  }
  return plans;
}

function swapTargetPlans(state, playerId, effect, sourcePermanent, choices = {}) {
  const selector = targetSelectorForEffect(effect);
  if (!selector || selector.all) return [];
  const targetChoiceKey = selector.choiceKey ?? "targets";
  const plans = [];
  for (const targets of autoplayTargetSelections(state, playerId, effect, selector, sourcePermanent, choices)) {
    const target = targetPermanentForChoice(state, playerId, targets[0]);
    if (!target) continue;
    const otherLine = target.lineName === LINES.FRONT ? LINES.ENERGY : LINES.FRONT;
    const counterparts = (state.players[target.playerId]?.[otherLine] ?? [])
      .map((permanent, index) => ({ permanent, index, score: permanentBattlePower(state, permanent) }))
      .filter(({ permanent }) => state.catalog[permanent.cards?.at(-1)?.defId]?.type === CARD_TYPES.CHARACTER)
      .sort((left, right) => target.lineName === LINES.FRONT
        ? right.score - left.score || left.index - right.index
        : left.score - right.score || left.index - right.index);
    for (const counterpart of counterparts) {
      plans.push({
        targetChoiceKey,
        targets,
        swapTarget: { player: target.playerId, line: otherLine, index: counterpart.index }
      });
      if (plans.length >= MAX_AUTOPLAY_CHOICE_VARIANTS_PER_ACTION * 2) return plans;
    }
  }
  return plans;
}

function swapChosenTargetPlans(state, playerId, effect, sourcePermanent, choices = {}) {
  const firstSelector = effect.firstTarget ?? effect.targetA;
  const secondSelector = effect.secondTarget ?? effect.targetB;
  if (!firstSelector || !secondSelector) return [];
  const firstChoiceKey = firstSelector.choiceKey ?? "firstTarget";
  const secondChoiceKey = secondSelector.choiceKey ?? "secondTarget";
  const plans = [];
  for (const firstTargets of autoplayTargetSelections(state, playerId, effect, firstSelector, sourcePermanent, choices)) {
    if (firstTargets.length === 0) continue;
    for (const secondTargets of autoplayTargetSelections(state, playerId, effect, secondSelector, sourcePermanent, choices)) {
      if (secondTargets.length === 0) continue;
      plans.push({ firstChoiceKey, secondChoiceKey, firstTargets, secondTargets });
      if (plans.length >= MAX_AUTOPLAY_CHOICE_VARIANTS_PER_ACTION * 2) return plans;
    }
  }
  return plans;
}

function moveOrSwapTargetPlans(state, playerId, effect, sourcePermanent, choices = {}) {
  const selector = targetSelectorForEffect(effect);
  if (!selector || selector.all) return [];
  const targetChoiceKey = selector.choiceKey ?? "targets";
  const plans = [];
  for (const targets of autoplayTargetSelections(state, playerId, effect, selector, sourcePermanent, choices)) {
    const targetPermanents = targets.map((target) => targetPermanentForChoice(state, playerId, target));
    if (targetPermanents.some((target) => !target)) continue;
    const lines = {
      [LINES.FRONT]: [...state.players[playerId].frontLine],
      [LINES.ENERGY]: [...state.players[playerId].energyLine]
    };
    const visit = (ordinal, currentLines, selectedChoices) => {
      if (plans.length >= MAX_AUTOPLAY_CHOICE_VARIANTS_PER_ACTION * 2) return;
      if (ordinal >= targetPermanents.length) {
        plans.push({ targetChoiceKey, targets, moveOrSwapChoices: { ...selectedChoices } });
        return;
      }
      const targetPermanent = targetPermanents[ordinal].permanent;
      const currentLine = [LINES.FRONT, LINES.ENERGY]
        .find((lineName) => currentLines[lineName].some((permanent) => permanent.pid === targetPermanent.pid));
      if (!currentLine) {
        visit(ordinal + 1, currentLines, selectedChoices);
        return;
      }
      const currentIndex = currentLines[currentLine].findIndex((permanent) => permanent.pid === targetPermanent.pid);
      const otherLine = currentLine === LINES.FRONT ? LINES.ENERGY : LINES.FRONT;
      if (currentLines[otherLine].length < MAX_LINE_SIZE) {
        const movedLines = {
          [LINES.FRONT]: [...currentLines[LINES.FRONT]],
          [LINES.ENERGY]: [...currentLines[LINES.ENERGY]]
        };
        movedLines[currentLine].splice(currentIndex, 1);
        movedLines[otherLine].push(targetPermanent);
        visit(ordinal + 1, movedLines, { ...selectedChoices, [targetPermanent.pid]: "move" });
      }
      currentLines[otherLine].forEach((counterpart, counterpartIndex) => {
        if (state.catalog[counterpart.cards?.at(-1)?.defId]?.type !== CARD_TYPES.CHARACTER) return;
        const swappedLines = {
          [LINES.FRONT]: [...currentLines[LINES.FRONT]],
          [LINES.ENERGY]: [...currentLines[LINES.ENERGY]]
        };
        swappedLines[currentLine][currentIndex] = counterpart;
        swappedLines[otherLine][counterpartIndex] = targetPermanent;
        const originalLocation = permanentChoiceLocation(state, counterpart);
        visit(ordinal + 1, swappedLines, {
          ...selectedChoices,
          [targetPermanent.pid]: {
            player: playerId,
            line: originalLocation?.lineName ?? otherLine,
            index: originalLocation?.index ?? counterpartIndex,
            permanentId: counterpart.pid
          }
        });
      });
    };
    visit(0, lines, {});
    if (plans.length >= MAX_AUTOPLAY_CHOICE_VARIANTS_PER_ACTION * 2) break;
  }
  return plans;
}

function handRevealSelections(state, playerId, effect) {
  const eligible = state.players[playerId].hand
    .map((card, index) => ({ card, index }))
    .filter(({ card }) => zoneCardMatches(state, card, effect.filter ?? {}));
  const min = Math.max(0, Number(effect.min ?? 0));
  const max = Math.min(eligible.length, Math.max(min, Number(effect.max ?? effect.count ?? effect.amount ?? eligible.length)));
  return boundedCardIndexSelections(eligible, { min, max, uniqueNames: Boolean(effect.uniqueNames), state })
    .map((selection) => selection.map((index) => stableHandCardChoice(state, playerId, index)));
}

function preferredHandRevealChoices(state, playerId, effect) {
  const representedNames = new Set();
  if (effect.uniqueNames && effect.includeField !== false) {
    for (const permanent of [...state.players[playerId].frontLine, ...state.players[playerId].energyLine]) {
      const def = state.catalog[permanent.cards?.at(-1)?.defId];
      if (def && zoneCardMatches(state, permanent.cards.at(-1), effect.filter ?? {})) {
        representedNames.add(def.name?.toLowerCase());
      }
    }
  }
  const selected = [];
  const maximum = Number(effect.max ?? effect.count ?? effect.amount ?? state.players[playerId].hand.length);
  for (let index = 0; index < state.players[playerId].hand.length && selected.length < maximum; index += 1) {
    const card = state.players[playerId].hand[index];
    if (!zoneCardMatches(state, card, effect.filter ?? {})) continue;
    const name = state.catalog[card.defId]?.name?.toLowerCase();
    if (effect.uniqueNames && name && representedNames.has(name)) continue;
    selected.push(index);
    if (name) representedNames.add(name);
  }
  return selected.map((index) => stableHandCardChoice(state, playerId, index));
}

function moveZoneCardChoiceEntries(state, playerId, effect, choices = {}) {
  const sourcePlayerId = effect.player === "opponent" ? opponentOf(playerId) : effect.player ?? playerId;
  const sourceName = effect.source ?? "sideline";
  const source = state.players[sourcePlayerId]?.[sourceName] ?? [];
  const ownSource = sourcePlayerId === playerId;
  const destination = effect.destination ?? "hand";
  const favorableOwnDestinations = new Set(["hand", "life", "deck"]);
  const destinationFavorsSource = favorableOwnDestinations.has(destination);
  return source
    .map((card, index) => {
      const value = cardValue(state, card);
      const utility = ownSource === destinationFavorsSource ? value : -value;
      return { card, index, sourceName, sourcePlayerId, utility };
    })
    .filter(({ card }) => zoneCardMatches(state, card, effect.filter ?? {}, { playerId, choices }))
    .sort((left, right) => {
      if (["life", "deck"].includes(sourceName) || (sourcePlayerId !== playerId && sourceName === "hand")) return left.index - right.index;
      return right.utility - left.utility || left.index - right.index;
    })
    .slice(0, MAX_AUTOPLAY_CHOICE_VARIANTS_PER_ACTION * 2);
}

function moveZoneCardChoice(entry) {
  return {
    player: entry.sourcePlayerId,
    zone: entry.sourceName,
    index: entry.index,
    uid: entry.card.uid
  };
}

function hiddenZoneSelectionOwnedOutsidePolicy(playerId, effect) {
  const sourcePlayerId = effect.player === "opponent" ? opponentOf(playerId) : effect.player ?? playerId;
  const sourceName = effect.source ?? effect.zone ?? effect.zones?.[0] ?? "sideline";
  return ["life", "deck"].includes(sourceName) || (sourcePlayerId !== playerId && sourceName === "hand");
}

function raidBooleanPlans(count) {
  if (count <= 0) return [[]];
  const plans = [];
  const visit = (index, values) => {
    if (plans.length >= MAX_AUTOPLAY_CHOICE_VARIANTS_PER_ACTION * 2) return;
    if (index >= count) {
      plans.push([...values]);
      return;
    }
    values.push(true);
    visit(index + 1, values);
    values.pop();
    values.push(false);
    visit(index + 1, values);
    values.pop();
  };
  visit(0, []);
  return plans;
}

function raidMovementPlansForTargets(state, playerId, cardDefs, raidPlan, targetPlan) {
  const targets = Array.isArray(targetPlan) ? targetPlan : targetPlan ? [targetPlan] : [];
  const eligible = raidPlan
    .map((raid, index) => ({ raid, index, target: targets[index], cardDef: cardDefs[index] }))
    .filter(({ raid, target, cardDef }) => raid
      && target?.line === LINES.ENERGY
      && internals.cardCanEnterLine(state, playerId, cardDef, LINES.FRONT, { operation: "move" }));
  if (eligible.length === 0) {
    return [{ moves: Array(raidPlan.length).fill(false), replacements: Array(raidPlan.length).fill(null) }];
  }

  const plans = [];
  for (const eligibleMoves of raidBooleanPlans(eligible.length)) {
    const moves = Array(raidPlan.length).fill(false);
    const movedIndices = [];
    eligible.forEach((entry, index) => {
      if (!eligibleMoves[index]) return;
      moves[entry.index] = true;
      movedIndices.push(entry.index);
    });
    const replacementPlans = lineReplacementChoicePlans(
      state,
      playerId,
      LINES.FRONT,
      movedIndices.length,
      { mode: "sequential" }
    );
    for (const replacementPlan of replacementPlans) {
      const replacements = Array(raidPlan.length).fill(null);
      const sequential = Array.isArray(replacementPlan)
        ? replacementPlan
        : replacementPlan === undefined ? [] : [replacementPlan];
      movedIndices.forEach((selectedIndex, moveIndex) => {
        replacements[selectedIndex] = sequential[moveIndex] ?? null;
      });
      plans.push({ moves, replacements });
      if (plans.length >= MAX_AUTOPLAY_CHOICE_VARIANTS_PER_ACTION * 2) return plans;
    }
  }
  return plans;
}

function raidTargetPlansForSelectedCards(state, playerId, effect, selected, raidPlan, sourcePermanent, sourceKind) {
  if (!raidPlan.some(Boolean)) return [undefined];
  const optionsByCard = selected.map((choice, index) => {
    if (!raidPlan[index]) return [null];
    const card = state.players[choice.player ?? playerId]?.[choice.zone]?.find((candidate) => candidate.uid === choice.uid)
      ?? state.players[choice.player ?? playerId]?.[choice.zone]?.[choice.index];
    const def = state.catalog[card?.defId];
    return internals.raidTargetsForCard(state, playerId, def, {
      excludePermanentId: effect.raidTargetOtherThanSource ? sourcePermanent?.pid : undefined,
      sourceKind
    }).map((target) => ({ player: playerId, line: target.lineName, index: target.index }));
  });
  if (optionsByCard.some((options, index) => raidPlan[index] && options.length === 0)) return [];
  const plans = [];
  const visit = (index, selectedTargets) => {
    if (plans.length >= MAX_AUTOPLAY_CHOICE_VARIANTS_PER_ACTION * 2) return;
    if (index >= optionsByCard.length) {
      plans.push([...selectedTargets]);
      return;
    }
    for (const target of optionsByCard[index]) {
      selectedTargets.push(target);
      visit(index + 1, selectedTargets);
      selectedTargets.pop();
      if (plans.length >= MAX_AUTOPLAY_CHOICE_VARIANTS_PER_ACTION * 2) return;
    }
  };
  visit(0, []);
  return plans;
}

function autoplayTargetSelections(state, playerId, effect, selector, sourcePermanent, choices) {
  let candidates = targetCandidates(state, playerId, selector, sourcePermanent, choices)
    .sort((left, right) => targetScore(state, playerId, effect, right) - targetScore(state, playerId, effect, left));
  if (selector.uniqueNames) {
    const names = new Set();
    candidates = candidates.filter((candidate) => {
      const name = state.catalog[candidate.permanent.cards.at(-1).defId]?.name?.toLowerCase();
      if (name && names.has(name)) return false;
      if (name) names.add(name);
      return true;
    });
  }
  const min = Math.max(0, Number(selector.min ?? 0));
  const max = Math.min(candidates.length, Math.max(min, Number(selector.max ?? selector.amount ?? 1)));
  const entries = candidates.map((candidate, index) => ({
    index,
    candidate,
    card: candidate.permanent.cards.at(-1)
  }));
  return boundedCardIndexSelections(entries, { min, max, uniqueNames: selector.uniqueNames, state })
    .map((selection) => selection.map((index) => {
      const candidate = candidates[index];
      return { player: candidate.playerId, lineName: candidate.lineName, index: candidate.index };
    }));
}

function addChoicesForPhaseAdvance(choices, state, playerId) {
  const timing = state.phase === PHASES.MAIN
    ? TIMINGS.START_OF_ATTACK_PHASE
    : state.phase === PHASES.ATTACK
      ? TIMINGS.END_OF_ATTACK_PHASE
      : undefined;
  if (!timing) return;

  const player = state.players[playerId];
  for (const permanent of [...player.frontLine, ...player.energyLine]) {
    for (const ability of permanentAbilities(state, permanent)) {
      if (ability.timing === timing) addChoicesForEffect(choices, state, playerId, ability.effect, permanent);
    }
  }

  if (timing === TIMINGS.START_OF_ATTACK_PHASE) {
    for (const card of player.hand) {
      const def = state.catalog[card.defId];
      for (const ability of def?.abilities ?? []) {
        if (ability.timing === timing) addChoicesForEffect(choices, state, playerId, ability.effect);
      }
    }
  }
}

function addChoicesForEffect(choices, state, playerId, effect, sourcePermanent) {
  if (!effect) return;

  if (effect.kind === "sequence") {
    for (const child of effect.effects ?? []) addChoicesForEffect(choices, state, playerId, child, sourcePermanent);
    return;
  }

  if (effect.kind === "optional") {
    const choiceKey = effect.choiceKey ?? "optionalEffect";
    choices[choiceKey] = effectScore(state, playerId, effect.effect, sourcePermanent) > 0;
    if (choices[choiceKey]) addChoicesForEffect(choices, state, playerId, effect.effect, sourcePermanent);
    return;
  }

  if (effect.kind === "restTargetsThen" && effect.optional) {
    const enabled = effectScore(state, playerId, effect.effect, sourcePermanent) > 0;
    choices[effect.choiceKey ?? "optionalRestTargets"] = enabled;
    if (!enabled) return;
    addChoicesForEffect(choices, state, playerId, effect.effect, sourcePermanent);
  }

  if (effect.kind === "optionalChoiceUpgrade") {
    const upgradedScore = effectScore(state, playerId, effect.upgradedEffect, sourcePermanent)
      + effectScore(state, playerId, effect.costEffect, sourcePermanent);
    const baseScore = effectScore(state, playerId, effect.baseEffect, sourcePermanent);
    const useUpgrade = canAutoplayPayEffectCost(state, playerId, effect.costEffect) && upgradedScore >= baseScore;
    choices[effect.choiceKey ?? "optionalChoiceUpgrade"] = useUpgrade;
    addChoicesForEffect(choices, state, playerId, useUpgrade ? effect.upgradedEffect : effect.baseEffect, sourcePermanent);
    if (useUpgrade) addChoicesForEffect(choices, state, playerId, effect.costEffect, sourcePermanent);
    return;
  }

  if (effect.kind === "optionalInstead") {
    const canUseInstead = (!effect.condition || conditionMet(state, playerId, effect.condition, { permanent: sourcePermanent }))
      && canAutoplayPayEffectCost(state, playerId, effect.costEffect);
    const insteadScore = effectScore(state, playerId, effect.insteadEffect, sourcePermanent)
      + effectScore(state, playerId, effect.costEffect, sourcePermanent);
    const baseScore = effectScore(state, playerId, effect.baseEffect, sourcePermanent);
    const useInstead = canUseInstead && insteadScore >= baseScore;
    choices[effect.choiceKey ?? "optionalInstead"] = useInstead;
    if (useInstead) {
      addChoicesForEffect(choices, state, playerId, effect.costEffect, sourcePermanent);
      addChoicesForEffect(choices, state, playerId, effect.insteadEffect, sourcePermanent);
    } else {
      addChoicesForEffect(choices, state, playerId, effect.baseEffect, sourcePermanent);
    }
    return;
  }

  if (effect.kind === "conditional") {
    if (conditionNeedsResolutionContext(effect.condition)) {
      addChoicesForEffect(choices, state, playerId, effect.effect, sourcePermanent);
      addChoicesForEffect(choices, state, playerId, effect.elseEffect, sourcePermanent);
    } else {
      const selectedEffect = conditionMet(state, playerId, effect.condition, { permanent: sourcePermanent })
        ? effect.effect
        : effect.elseEffect;
      addChoicesForEffect(choices, state, playerId, selectedEffect, sourcePermanent);
    }
    return;
  }

  if (effect.kind === "targetConditional") {
    addChoicesForEffect(choices, state, playerId, effect.effect, sourcePermanent);
    addChoicesForEffect(choices, state, playerId, effect.elseEffect, sourcePermanent);
  }

  if (effect.kind === "chooseOne") {
    const scored = (effect.choices ?? []).map((choice, index) => ({
      index,
      score: effectScore(state, playerId, choice.effect, sourcePermanent)
    }));
    scored.sort((a, b) => b.score - a.score);
    if (scored[0]) {
      choices[effect.choiceKey ?? "effectChoice"] = scored[0].index;
      addChoicesForEffect(choices, state, playerId, effect.choices[scored[0].index]?.effect, sourcePermanent);
    }
    return;
  }

  if (effect.kind === "chooseN") {
    const min = effect.min ?? 0;
    const max = effect.maxIf?.condition && conditionMet(state, playerId, effect.maxIf.condition, { permanent: sourcePermanent })
      ? effect.maxIf.value ?? effect.maxIf.max ?? effect.max ?? effect.choices?.length ?? 1
      : effect.max ?? effect.choices?.length ?? 1;
    const scored = (effect.choices ?? []).map((choice, index) => ({
      index,
      score: effectScore(state, playerId, choice.effect, sourcePermanent)
    })).sort((a, b) => b.score - a.score);
    const selected = scored
      .filter((item, index) => item.score > 0 || index < min)
      .slice(0, max)
      .map((item) => item.index);
    choices[effect.choiceKey ?? "effectChoices"] = selected;
    for (const index of selected) addChoicesForEffect(choices, state, playerId, effect.choices[index]?.effect, sourcePermanent);
    return;
  }

  if (effect.kind === "searchTopDeck") {
    const count = Math.min(effect.count ?? effect.amount ?? 1, state.players[playerId].deck.length);
    const max = effect.max ?? effect.amount ?? 1;
    const looked = state.players[playerId].deck.slice(0, count);
    const candidates = looked
      .map((card, index) => ({ card, index, score: cardValue(state, card) }))
      .filter(({ card }) => zoneCardMatches(state, card, effect.filter ?? {}))
      .sort((a, b) => b.score - a.score);
    const selected = [];
    const selectedNames = new Set();
    for (const candidate of candidates) {
      const name = state.catalog[candidate.card.defId]?.name?.toLowerCase();
      if (effect.uniqueNames && selectedNames.has(name)) continue;
      selected.push(candidate.index);
      if (name) selectedNames.add(name);
      if (selected.length >= max) break;
    }
    choices[effect.choiceKey ?? "searchIndices"] = selected;

    if (effect.remainingDestinations) {
      const selectedSet = new Set(selected);
      const allowed = new Set(effect.remainingDestinations);
      choices[effect.remainingDestinationChoiceKey ?? "searchRemainingDestinations"] = looked
        .filter((_, index) => !selectedSet.has(index))
        .map((card) => {
          if (allowed.has("top") && allowed.has("bottom")) return cardValue(state, card) >= 180 ? "top" : "bottom";
          return effect.defaultRemainingDestination ?? effect.remainingDestinations[0];
        });
    }
    return;
  }

  if (effect.kind === "revealHandCards") {
    const maximum = effect.max ?? effect.count ?? effect.amount ?? 1;
    const indices = state.players[playerId].hand
      .map((card, index) => ({ card, index }))
      .filter(({ card }) => zoneCardMatches(state, card, effect.filter ?? {}))
      .slice(0, maximum)
      .map(({ index }) => stableHandCardChoice(state, playerId, index));
    if (indices.length > 0) choices[effect.choiceKey ?? "revealHandIndices"] = indices;
    return;
  }

  if (effect.kind === "opponentMayDraw") {
    const opponent = state.players[opponentOf(playerId)];
    let maximum = effect.amount ?? 1;
    const sourceTarget = choices[effect.amountIf?.sourceChoiceKey]?.[0];
    const sourcePlayerId = sourceTarget?.player ?? sourceTarget?.playerId ?? playerId;
    const sourceLine = sourceTarget?.lineName ?? sourceTarget?.line;
    const sourcePermanent = state.players[sourcePlayerId]?.[sourceLine]?.[sourceTarget?.index];
    if (sourcePermanent && effect.amountIf?.condition?.lastSidelinedBpMin !== undefined
      && permanentBattlePower(state, sourcePermanent) >= effect.amountIf.condition.lastSidelinedBpMin) {
      maximum = effect.amountIf.amount;
    }
    choices[effect.choiceKey ?? "opponentDrawAmount"] = opponent.deck.length > 0 ? Math.min(maximum, opponent.deck.length) : 0;
    return;
  }

  if (effect.kind === "predictTopDeckRequiredEnergy") {
    choices[effect.choiceKey ?? "requiredEnergyPrediction"] = publicTopDeckRequiredEnergyPrediction(state, playerId);
    addChoicesForEffect(choices, state, playerId, effect.successEffect, sourcePermanent);
    return;
  }

  if (effect.kind === "playCardFromZone") {
    if (hiddenZoneSelectionOwnedOutsidePolicy(playerId, effect)) return;
    if (effect.destinationLines?.length) {
      choices[effect.destinationLineChoiceKey ?? "destinationLine"] = effect.destinationLines[0];
    }
    addReplacementChoiceForLine(choices, state, playerId, effect.destinationLine ?? effect.destinationLines?.[0] ?? LINES.FRONT, effect.replaceChoiceKey);
    const entries = zoneCardChoiceEntries(state, playerId, effect, choices);
    const count = Math.min(entries.length, Number(effect.count ?? effect.amount ?? effect.max ?? 1));
    if (count === 0) return;
    const selected = entries.slice(0, count).map(stableZoneCardChoice);
    const multiple = count > 1 || effect.simultaneous;
    choices[effect.choiceKey ?? `${effect.zone ?? effect.zones?.[0] ?? "hand"}Index`] = multiple ? selected : selected[0];
    if (multiple) choices[effect.abilityOrderChoiceKey ?? "simultaneousPlayedOrder"] = selected.map((_, index) => index);
    return;
  }

  if (effect.kind === "playOrRaidCardFromZone") {
    if (effect.destinationLines?.length) {
      choices[effect.destinationLineChoiceKey ?? "destinationLine"] = effect.destinationLines[0];
    }
    const entries = zoneCardChoiceEntries(state, playerId, effect, choices);
    const count = Math.min(entries.length, Number(effect.count ?? effect.amount ?? effect.max ?? 1));
    if (count === 0) return;
    const selected = entries.slice(0, count).map(playOrRaidZoneChoice);
    const multiple = count > 1 || effect.simultaneous;
    choices[effect.choiceKey ?? `${effect.zones?.[0] ?? effect.zone ?? "hand"}Index`] = multiple ? selected : selected[0];
    const cardDefs = entries.slice(0, count).map((entry) => state.catalog[entry.card.defId]);
    const raidPlan = cardDefs.map((def) => Boolean(effect.allowRaid)
      && internals.raidTargetsForCard(state, playerId, def, {
        excludePermanentId: effect.raidTargetOtherThanSource ? sourcePermanent?.pid : undefined,
        sourceKind: "ability"
      }).length > 0);
    choices[effect.raidChoiceKey ?? "performRaid"] = multiple ? raidPlan : raidPlan[0];
    const targetPlan = raidTargetPlansForSelectedCards(state, playerId, effect, selected, raidPlan, sourcePermanent, "ability")[0];
    if (targetPlan) {
      choices[effect.raidTargetChoiceKey ?? "raidTarget"] = multiple ? targetPlan : targetPlan[0];
      const movement = raidMovementPlansForTargets(state, playerId, cardDefs, raidPlan, targetPlan)[0];
      if (movement) {
        choices[effect.raidMoveChoiceKey ?? "moveRaidToFront"] = multiple ? movement.moves : movement.moves[0];
        if (movement.replacements.some(Boolean)) {
          choices[effect.raidMoveReplaceChoiceKey ?? "raidMoveReplaceIndex"] = multiple
            ? movement.replacements
            : movement.replacements[0];
        }
      }
    }
    if (multiple) choices[effect.abilityOrderChoiceKey ?? "simultaneousPlayedOrder"] = selected.map((_, index) => index);
    if (raidPlan.some((raid) => !raid)) {
      addReplacementChoiceForLine(
        choices,
        state,
        playerId,
        effect.destinationLine ?? effect.destinationLines?.[0] ?? LINES.FRONT,
        effect.replaceChoiceKey
      );
    }
    return;
  }

  if (effect.kind === "lookTopDeckPlayOneAndMoveRest") {
    const count = Math.min(effect.count ?? effect.amount ?? 1, state.players[playerId].deck.length);
    const candidates = state.players[playerId].deck
      .slice(0, count)
      .map((card, index) => ({ card, index, score: cardValue(state, card) }))
      .filter(({ card }) => zoneCardMatches(state, card, effect.filter ?? {}))
      .sort((a, b) => b.score - a.score);
    if (candidates[0]) choices[effect.choiceKey ?? "lookPlayIndex"] = candidates[0].index;
    return;
  }

  if (effect.kind === "revealTopDeckOptionalPlayOrRaidInstead") {
    choices[effect.choiceKey ?? "optionalRevealPlay"] = true;
    choices[effect.raidChoiceKey ?? "performRaid"] = Boolean(effect.allowRaid);
    choices[effect.placementChoiceKey ?? "revealedPlacement"] = effect.defaultDestination ?? effect.destinations?.[0] ?? "top";
    addReplacementChoiceForLine(choices, state, playerId, effect.destinationLine ?? LINES.FRONT, effect.replaceChoiceKey);
    addChoicesForEffect(choices, state, playerId, effect.costEffect, sourcePermanent);
    return;
  }

  if (effect.kind === "playCardFromZoneMatchingTargetName") {
    addReplacementChoiceForLine(choices, state, playerId, effect.destinationLine ?? LINES.FRONT, effect.replaceChoiceKey);
    const plan = matchingTargetPlayPlans(state, playerId, effect, sourcePermanent, choices)[0];
    if (plan) {
      choices[plan.targetChoiceKey] = plan.targets;
      choices[effect.choiceKey ?? `${effect.zone ?? effect.zones?.[0] ?? "hand"}Index`] = stableZoneCardChoice(plan.entry);
    }
    return;
  }

  if (effect.kind === "playSourceFromZone") {
    if (effect.destinationLines?.length) {
      choices[effect.destinationLineChoiceKey ?? "destinationLine"] = effect.destinationLines[0];
    }
    addReplacementChoiceForLine(
      choices,
      state,
      playerId,
      effect.destinationLine ?? effect.destinationLines?.[0] ?? LINES.FRONT,
      effect.replaceChoiceKey
    );
    return;
  }

  if (effect.kind === "raidSourceFromZone") {
    addReplacementChoiceForLine(choices, state, playerId, effect.destinationLine ?? LINES.FRONT, effect.replaceChoiceKey);
    return;
  }

  if (effect.kind === "useEventFromZone") {
    const selected = bestZoneCardChoice(state, playerId, effect, choices);
    if (selected !== undefined) choices[effect.choiceKey ?? `${effect.source ?? "sideline"}Index`] = selected;
    return;
  }

  if (effect.kind === "activateTriggerFromZone") {
    const selected = bestZoneCardChoice(state, playerId, effect, choices);
    if (selected !== undefined) choices[effect.choiceKey ?? `${effect.source ?? "sideline"}Index`] = selected;
    return;
  }

  if (effect.kind === "moveCardBetweenZones") {
    if (effect.all) return;
    const entries = moveZoneCardChoiceEntries(state, playerId, effect, choices);
    const count = Math.min(entries.length, Number(effect.count ?? effect.amount ?? 1));
    if (count === 0) return;
    const selected = entries.slice(0, count).map(moveZoneCardChoice);
    choices[effect.choiceKey ?? `${effect.source ?? "sideline"}Index`] = count > 1 ? selected : selected[0];
    return;
  }

  if (effect.kind === "moveHandToZone") {
    const count = effect.count ?? effect.amount ?? 1;
    const indices = lowestValueHandIndices(state, playerId, count, effect.filter);
    const min = effect.min ?? count;
    if (indices.length >= min) {
      choices[effect.choiceKey ?? "handIndices"] = indices.slice(0, count);
      if (effect.destinations?.length > 0) {
        choices[effect.destinationChoiceKey ?? "handDestinations"] = effect.destination ?? effect.destinations[0];
      }
      if (effect.positions?.length > 0) {
        choices[effect.positionChoiceKey ?? "handDeckPositions"] = effect.defaultPosition ?? effect.position ?? effect.positions[0];
      }
    }
    return;
  }

  if (effect.kind === "moveHandCardsUnderSelf" || effect.kind === "moveHandCardsUnderTargets") {
    const plan = handUnderMovePlans(state, playerId, effect, sourcePermanent, choices)[0];
    if (plan) {
      if (plan.targetChoiceKey) choices[plan.targetChoiceKey] = plan.targets;
      choices[effect.choiceKey ?? "handIndices"] = plan.handCards;
    }
    return;
  }

  if (effect.kind === "moveZoneCardsUnderSelf" || effect.kind === "moveZoneCardsUnderTargets") {
    const plan = zoneUnderMovePlans(state, playerId, effect, sourcePermanent, choices)[0];
    if (plan) {
      if (plan.targetChoiceKey) choices[plan.targetChoiceKey] = plan.targets;
      choices[effect.choiceKey ?? `${effect.source ?? "sideline"}UnderCards`] = plan.zoneCards;
    }
    return;
  }

  if (effect.kind === "moveEqualCountsBetweenZones") {
    const sourcePlayerId = effect.player === "opponent" ? opponentOf(playerId) : effect.player ?? playerId;
    const source = state.players[sourcePlayerId]?.[effect.source ?? "sideline"] ?? [];
    const counts = (effect.filters ?? []).map((filter) => source.filter((card) => zoneCardMatches(state, card, filter)).length);
    const maximum = counts.length > 0 ? Math.min(...counts) : 0;
    choices[effect.countChoiceKey ?? "equalZoneMoveCount"] = effect.countEach ?? maximum;
    return;
  }

  if (effect.kind === "swapSourceWithOtherLine" && sourcePermanent) {
    const player = state.players[playerId];
    const sourceLine = player.frontLine.some((permanent) => permanent.pid === sourcePermanent.pid) ? LINES.FRONT : LINES.ENERGY;
    const otherLine = sourceLine === LINES.FRONT ? LINES.ENERGY : LINES.FRONT;
    const ranked = player[otherLine]
      .map((permanent, index) => ({ index, score: permanentBattlePower(state, permanent) }))
      .sort((left, right) => sourceLine === LINES.FRONT ? right.score - left.score : left.score - right.score);
    if (ranked[0]) choices[effect.choiceKey ?? "swapTargetIndex"] = {
      player: playerId,
      line: otherLine,
      index: ranked[0].index
    };
    return;
  }

  if (effect.kind === "swapTargetsWithOtherLine") {
    const plan = swapTargetPlans(state, playerId, effect, sourcePermanent, choices)[0];
    if (plan) {
      choices[plan.targetChoiceKey] = plan.targets;
      choices[effect.swapChoiceKey ?? "swapTargetIndex"] = plan.swapTarget;
    }
    return;
  }

  if (effect.kind === "swapChosenTargets") {
    const plan = swapChosenTargetPlans(state, playerId, effect, sourcePermanent, choices)[0];
    if (plan) {
      choices[plan.firstChoiceKey] = plan.firstTargets;
      choices[plan.secondChoiceKey] = plan.secondTargets;
    }
    return;
  }

  if (effect.kind === "moveOrSwapTargetsToOtherLine") {
    const plan = moveOrSwapTargetPlans(state, playerId, effect, sourcePermanent, choices)[0];
    if (plan) {
      choices[plan.targetChoiceKey] = plan.targets;
      choices[effect.swapChoiceKey ?? "moveOrSwapTargets"] = plan.moveOrSwapChoices;
    }
    return;
  }

  if (effect.kind === "swapOwnFrontAndEnergy") {
    const targetPlayerId = effect.player === "opponent" ? opponentOf(playerId) : effect.player ?? playerId;
    const targetPlayer = state.players[targetPlayerId];
    const front = targetPlayer.frontLine
      .map((permanent, index) => ({ index, score: permanentBattlePower(state, permanent) }))
      .sort((left, right) => left.score - right.score)[0];
    const energy = targetPlayer.energyLine
      .map((permanent, index) => ({ index, score: permanentBattlePower(state, permanent) }))
      .sort((left, right) => right.score - left.score)[0];
    if (front && energy) {
      choices[effect.frontChoiceKey ?? "frontIndex"] = { player: targetPlayerId, line: LINES.FRONT, index: front.index };
      choices[effect.energyChoiceKey ?? "energyIndex"] = { player: targetPlayerId, line: LINES.ENERGY, index: energy.index };
    }
    return;
  }

  if (effect.kind === "restEnergyLineForRequiredEnergyTotal") {
    choices[effect.choiceKey ?? "energyRestIndices"] = state.players[playerId].energyLine
      .map((permanent, index) => ({ permanent, index }))
      .filter(({ permanent }) => !permanent.rested)
      .map(({ index }) => ({ player: playerId, line: LINES.ENERGY, index }));
    return;
  }

  if (effect.kind === "moveTargetsToDeck" && effect.positions?.length > 0) {
    choices[effect.positionChoiceKey ?? "deckPosition"] = effect.position ?? effect.positions[0];
  }

  if (effect.kind === "sidelineTargetsThenActivateSourceWhenPlayed") {
    choices[effect.orderChoiceKey ?? "simultaneousAbilityOrder"] = ["whenPlayed", "whenSidelined"];
  }

  if (effect.kind === "modifyBpForHandReveal") {
    if (effect.uniqueNames) {
      choices[effect.choiceKey ?? "revealHandIndices"] = preferredHandRevealChoices(state, playerId, effect);
    } else {
      choices[effect.choiceKey ?? "revealHandCount"] = Math.min(
        state.players[playerId].hand.filter((card) => zoneCardMatches(state, card, effect.filter ?? {})).length,
        Number(effect.max ?? effect.count ?? effect.amount ?? state.players[playerId].hand.length)
      );
    }
  }

  if (effect.kind === "playSomeNamedFromSidelineAddRest") {
    const entries = namedSidelinePlayEntries(state, playerId, effect);
    const count = Math.min(entries.length, Number(effect.playCount ?? 0));
    choices[effect.choiceKey ?? "playNamedIndices"] = entries.slice(0, count).map(stableZoneCardChoice);
    addReplacementChoiceForLine(choices, state, playerId, effect.destinationLine ?? LINES.FRONT, effect.replaceChoiceKey);
    return;
  }

  if (effect.kind === "moveUnderCardsToZone" && !effect.all) {
    const plan = underCardMovePlans(state, playerId, effect, sourcePermanent, choices)[0];
    if (plan) {
      if (plan.targetChoiceKey) choices[plan.targetChoiceKey] = plan.targets;
      choices[effect.choiceKey ?? "underCardChoices"] = plan.underCards;
    }
    return;
  }

  if (effect.kind === "opponentMaySidelineChosenTargetsElse") {
    const selected = [];
    for (const selector of effect.targets ?? []) {
      const targets = bestTargetsForEffect(state, playerId, { kind: "sidelineTargets", target: selector }, selector, sourcePermanent, choices);
      if (targets.length > 0) {
        choices[selector.choiceKey ?? "targets"] = targets;
        selected.push(targets[0]);
      }
    }
    if (selected.length > 0) {
      const lowest = selected
        .map((target, index) => {
          const permanent = state.players[target.player]?.[target.lineName]?.[target.index];
          return {
            index,
            score: permanent ? permanentBattlePower(state, permanent) + (target.lineName === LINES.FRONT ? 500 : 0) : 0
          };
        })
        .sort((a, b) => a.score - b.score)[0];
      choices[effect.choiceKey ?? "opponentSidelineChoice"] = lowest?.index ?? 0;
    }
    return;
  }

  if (effect.kind === "opponentMayMoveCardsBetweenZonesElse") {
    const opponentId = playerId === "P1" ? "P2" : "P1";
    const source = state.players[opponentId]?.[effect.source ?? "sideline"] ?? [];
    const count = effect.count ?? effect.amount ?? 1;
    const canMove = source.filter((card) => zoneCardMatches(state, card, effect.filter ?? {})).length >= count;
    const acceptScore = effectScore(state, playerId, effect.ifMovedEffect, sourcePermanent);
    const declineScore = effectScore(state, playerId, effect.elseEffect, sourcePermanent);
    choices[effect.choiceKey ?? "opponentZoneMoveChoice"] = canMove
      && effect.destinationPlayer !== "self"
      && acceptScore < declineScore;
    return;
  }

  const selector = targetSelectorForEffect(effect);
  if (!selector) return;
  if (selector.all) return;
  const selectedTargets = bestTargetsForEffect(state, playerId, effect, selector, sourcePermanent, choices);
  if (selectedTargets.length > 0) {
    choices[selector.choiceKey ?? "targets"] = selectedTargets;
  }
}

function canAutoplayPayEffectCost(state, playerId, effect) {
  if (!effect) return true;
  if (effect.kind === "sequence") {
    return (effect.effects ?? []).every((childEffect) => canAutoplayPayEffectCost(state, playerId, childEffect));
  }
  if (effect.kind === "payAp") {
    const active = state.players[playerId]?.apCards?.filter((card) => !card.rested).length ?? 0;
    return active >= (effect.amount ?? 1);
  }
  if (effect.kind !== "moveHandToZone") return true;
  const count = effect.count ?? effect.amount ?? 1;
  const matching = (state.players[playerId]?.hand ?? [])
    .filter((card) => !effect.filter || zoneCardMatches(state, card, effect.filter)).length;
  return matching >= (effect.min ?? count);
}

export function publicTopDeckRequiredEnergyPrediction(state, playerId) {
  const player = state.players[playerId];
  const counts = new Map();
  // Face-down life and the deck are one unknown pool for this prediction.
  for (const card of [...(player?.deck ?? []), ...(player?.life ?? [])]) {
    const amount = Number(state.catalog[card.defId]?.requiredEnergy?.amount ?? 0);
    counts.set(amount, Number(counts.get(amount) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])[0]?.[0] ?? 0;
}

function conditionNeedsResolutionContext(condition) {
  if (!condition || typeof condition !== "object") return false;
  return Object.entries(condition).some(([key, value]) => {
    if (key.startsWith("last")) return true;
    if (Array.isArray(value)) return value.some(conditionNeedsResolutionContext);
    return value && typeof value === "object" && conditionNeedsResolutionContext(value);
  });
}

function addReplacementChoiceForLine(choices, state, playerId, lineName, choiceKey = "replaceIndex") {
  const key = choiceKey ?? "replaceIndex";
  if (choices[key] !== undefined) return;
  const replacementIndex = replacementIndexForLine(state, playerId, lineName);
  if (replacementIndex !== undefined) choices[key] = stableLinePermanentChoice(state, playerId, lineName, replacementIndex);
}

function actionWithLineFullFallbackChoice(state, playerId, action, error) {
  if (error?.code !== "LINE_FULL") return undefined;
  const replacementPlayerId = error.details?.playerId ?? playerId;
  const replaceIndex = replacementIndexForLine(state, replacementPlayerId, error.details?.lineName);
  if (replaceIndex === undefined) return undefined;
  const triggerChoices = triggerChoicesWithLineReplacement(action.triggerChoices, replaceIndex);
  const nestedTriggerChoices = triggerChoicesWithLineReplacement(action.choices?.triggerChoices, replaceIndex);
  return {
    ...action,
    triggerChoices,
    choices: {
      ...(action.choices ?? {}),
      replaceIndex,
      triggerChoices: nestedTriggerChoices
    }
  };
}

function fallbackAdvancePhaseWithReplacement(state, playerId) {
  const advanceAction = legalActions(state, playerId).find((action) => action.type === "advancePhase");
  if (!advanceAction) return null;

  for (const lineName of [LINES.FRONT, LINES.ENERGY]) {
    const replaceIndex = replacementIndexForLine(state, playerId, lineName);
    if (replaceIndex === undefined) continue;
    try {
      return applyAction(state, {
        ...advanceAction,
        choices: {
          replaceIndex,
          triggerChoices: triggerChoicesWithLineReplacement(undefined, replaceIndex)
        }
      });
    } catch {
      // Try the other full line before giving up.
    }
  }

  return null;
}

function triggerChoicesWithLineReplacement(existingChoices, replaceIndex) {
  const choices = Array.isArray(existingChoices) ? [...existingChoices] : [];
  const count = Math.max(choices.length, STARTING_LIFE);
  for (let index = 0; index < count; index += 1) {
    const existing = choices[index];
    if (existing === false) {
      continue;
    }
    if (existing && typeof existing === "object") {
      const { choices: existingNestedChoices = {}, ...directChoices } = existing;
      choices[index] = {
        ...existing,
        choices: {
          ...directChoices,
          ...existingNestedChoices,
          replaceIndex: existingNestedChoices.replaceIndex ?? directChoices.replaceIndex ?? replaceIndex
        }
      };
      continue;
    }
    choices[index] = {
      choices: { replaceIndex }
    };
  }
  return choices;
}

function replacementIndexForLine(state, playerId, lineName) {
  if (lineName !== LINES.FRONT && lineName !== LINES.ENERGY) return undefined;
  const line = state.players[playerId]?.[lineName] ?? [];
  if (line.length < MAX_LINE_SIZE) return undefined;

  return line
    .map((permanent, index) => ({
      index,
      score: permanentBattlePower(state, permanent) + Math.max(0, permanent.cards.length - 1) * 250
    }))
    .sort((a, b) => a.score - b.score || a.index - b.index)[0]?.index ?? 0;
}

function targetSelectorForEffect(effect) {
  if (!effect || effect.target === "self") return undefined;
  return typeof effect.target === "object" ? effect.target : undefined;
}

function bestTargetsForEffect(state, playerId, effect, selector, sourcePermanent, choices = {}) {
  let candidates = targetCandidates(state, playerId, selector, sourcePermanent, choices)
    .sort((a, b) => targetScore(state, playerId, effect, b) - targetScore(state, playerId, effect, a));
  if (selector.uniqueNames) {
    const names = new Set();
    candidates = candidates.filter((candidate) => {
      const name = state.catalog[candidate.permanent.cards.at(-1).defId]?.name?.toLowerCase();
      if (names.has(name)) return false;
      names.add(name);
      return true;
    });
  }
  const max = selector.all ? candidates.length : selector.max ?? selector.amount ?? 1;
  const min = selector.min ?? 0;
  if (candidates.length < min) return [];
  return candidates.slice(0, max).map((candidate) => ({
    player: candidate.playerId,
    lineName: candidate.lineName,
    index: candidate.index
  }));
}

function targetCandidates(state, playerId, selector, sourcePermanent, choices = {}) {
  const candidates = [];
  for (const targetPlayerId of selectorPlayerIds(playerId, selector)) {
    const targetPlayer = state.players[targetPlayerId];
    for (const lineName of selectorLineNames(selector.line)) {
      targetPlayer[lineName].forEach((permanent, index) => {
        const def = state.catalog[permanent.cards.at(-1).defId];
        if (selector.type && def.type !== selector.type) return;
        if (selector.rested !== undefined && permanent.rested !== selector.rested) return;
        if (selector.active !== undefined && permanent.rested === selector.active) return;
        if (selector.name && !cardDefHasName(def, selector.name)) return;
        if (selector.nameIncludesAll && !cardDefNameIncludesAll(def, selector.nameIncludesAll)) return;
        if (selector.names && !selector.names.some((name) => cardDefHasName(def, name))) return;
        if (selector.otherThanName && cardDefHasName(def, selector.otherThanName)) return;
        if (selector.affinity && !includesText(def.affinities, selector.affinity)) return;
        if (selector.affinities && !def.affinities?.some((affinity) => includesText(selector.affinities, affinity))) return;
        if (selector.hasAbilityTiming && !permanentAbilities(state, permanent).some((ability) => ability.timing === selector.hasAbilityTiming)) return;
        if (selector.hasUnderCards && permanent.cards.length <= 1) return;
        if (selector.hasFaceDownUnder && !permanent.cards.slice(0, -1).some((card) => card.faceUp === false)) return;
        if (selector.noFaceDownUnder && permanent.cards.slice(0, -1).some((card) => card.faceUp === false)) return;
        if (selector.raided && permanent.cards.length <= 1) return;
        if (selector.notRaided && permanent.cards.length > 1) return;
        if (selector.hasRaid && !def.raid) return;
        if (selector.otherThanSource && sourcePermanent?.pid === permanent.pid) return;
        const bpMax = selectorBpMaximumForSimulation(state, playerId, selector, sourcePermanent, choices);
        if (bpMax !== undefined && permanentBattlePower(state, permanent) > bpMax) return;
        if (selector.bpMin !== undefined && permanentBattlePower(state, permanent) < selector.bpMin) return;
        if (selector.energyGenerationMax !== undefined && permanentEnergyGeneration(state, permanent) > selector.energyGenerationMax) return;
        if (selector.energyGenerationMin !== undefined && permanentEnergyGeneration(state, permanent) < selector.energyGenerationMin) return;
        if (selector.requiredEnergyMax !== undefined && (def.requiredEnergy?.amount ?? 0) > selector.requiredEnergyMax) return;
        if (selector.requiredEnergyMin !== undefined && (def.requiredEnergy?.amount ?? 0) < selector.requiredEnergyMin) return;
        if (selector.color && def.color !== selector.color) return;
        candidates.push({ playerId: targetPlayerId, lineName, index, permanent });
      });
    }
  }
  return candidates;
}

function selectorBpMaximumForSimulation(state, playerId, selector, sourcePermanent, choices = {}) {
  let maximum = selector.bpMax;
  if (selector.bpMaxFromChoiceKey) {
    const target = choices[selector.bpMaxFromChoiceKey]?.[0];
    const targetPlayerId = target?.player ?? target?.playerId ?? playerId;
    const targetLine = target?.lineName ?? target?.line;
    const permanent = state.players[targetPlayerId]?.[targetLine]?.[target?.index];
    if (permanent) maximum = permanentBattlePower(state, permanent);
  }
  for (const bonus of selector.bpMaxBonuses ?? []) {
    if (bonus.condition && !conditionMet(state, playerId, bonus.condition, { permanent: sourcePermanent })) continue;
    if (bonus.amountPerFieldMatch !== undefined) {
      const countPlayerId = bonus.controller === "opponent" ? opponentOf(playerId) : playerId;
      const count = selectorLineNames(bonus.line ?? "field")
        .flatMap((lineName) => state.players[countPlayerId]?.[lineName] ?? [])
        .filter((permanent) => zoneCardMatches(state, permanent.cards.at(-1), bonus.filter ?? {}))
        .length;
      maximum = Number(maximum ?? 0) + Number(bonus.amountPerFieldMatch) * count;
    } else {
      maximum = Number(maximum ?? 0) + Number(bonus.amount ?? 0);
    }
  }
  return maximum;
}

function selectorPlayerIds(playerId, selector) {
  const controller = selector.controller ?? selector.player ?? "self";
  if (controller === "self") return [playerId];
  if (controller === "opponent") return [opponentOf(playerId)];
  if (controller === "any" || controller === "both") return [playerId, opponentOf(playerId)];
  return [controller];
}

function selectorLineNames(line) {
  if (!line || line === "field") return [LINES.FRONT, LINES.ENERGY];
  if (line === "front") return [LINES.FRONT];
  if (line === "energy") return [LINES.ENERGY];
  return [line];
}

function targetScore(state, playerId, effect, target) {
  const isOpponent = target.playerId !== playerId;
  const bp = permanentBattlePower(state, target.permanent);
  const frontBonus = target.lineName === LINES.FRONT ? 200 : 0;
  const activeBonus = target.permanent.rested ? 0 : 100;

  if (["sidelineTargets", "returnTargetsToHand", "moveTargetsToBottomDeck", "moveTargetsToDeck", "moveTargetsToLife", "moveTopRaidCardToZone"].includes(effect.kind)) {
    return isOpponent ? bp + frontBonus : -bp;
  }
  if (effect.kind === "restTargets") return isOpponent ? bp + activeBonus + frontBonus : -bp;
  if (effect.kind === "readyTargets") return !isOpponent ? (target.permanent.rested ? 400 : 0) + bp : -bp;
  if (effect.kind === "modifyBp") {
    const amount = effect.amount ?? 0;
    if (amount >= 0) return !isOpponent ? bp + frontBonus : -bp;
    return isOpponent ? bp + frontBonus : -bp;
  }
  if (effect.kind === "grantKeyword" || effect.kind === "grantAbility") return !isOpponent ? bp + frontBonus : -bp;
  if (effect.kind === "targetConditional") return bp + frontBonus;
  if (effect.kind === "moveTargetsToLine" || effect.kind === "moveTargetsToOtherLine") return isOpponent ? bp + frontBonus : 100 - bp;
  return bp + frontBonus;
}

function effectScore(state, playerId, effect, sourcePermanent) {
  if (!effect || effect.kind === "none") return 0;
  switch (effect.kind) {
    case "sequence":
      return (effect.effects ?? []).reduce((total, child) => total + effectScore(state, playerId, child, sourcePermanent), 0);
    case "optional":
      return Math.max(0, effectScore(state, playerId, effect.effect, sourcePermanent));
    case "optionalInstead":
      return Math.max(
        effectScore(state, playerId, effect.baseEffect, sourcePermanent),
        effectScore(state, playerId, effect.insteadEffect, sourcePermanent) + effectScore(state, playerId, effect.costEffect, sourcePermanent)
      );
    case "optionalChoiceUpgrade":
      return Math.max(
        effectScore(state, playerId, effect.baseEffect, sourcePermanent),
        effectScore(state, playerId, effect.upgradedEffect, sourcePermanent) + effectScore(state, playerId, effect.costEffect, sourcePermanent)
      );
    case "chooseOne":
      return Math.max(0, ...(effect.choices ?? []).map((choice) => effectScore(state, playerId, choice.effect, sourcePermanent)));
    case "chooseN": {
      const min = effect.min ?? 0;
      const max = effect.maxIf?.condition && conditionMet(state, playerId, effect.maxIf.condition, { permanent: sourcePermanent })
        ? effect.maxIf.value ?? effect.maxIf.max ?? effect.max ?? effect.choices?.length ?? 1
        : effect.max ?? effect.choices?.length ?? 1;
      const scores = (effect.choices ?? []).map((choice) => effectScore(state, playerId, choice.effect, sourcePermanent)).sort((a, b) => b - a);
      return scores.filter((score, index) => score > 0 || index < min).slice(0, max).reduce((sum, score) => sum + score, 0);
    }
    case "conditional":
      return Math.max(
        effectScore(state, playerId, effect.effect, sourcePermanent),
        effectScore(state, playerId, effect.elseEffect, sourcePermanent)
      );
    case "targetConditional":
      return Math.max(
        effectScore(state, playerId, effect.effect, sourcePermanent),
        effectScore(state, playerId, effect.elseEffect, sourcePermanent)
      ) + bestTargetScore(state, playerId, effect, sourcePermanent) / 40;
    case "draw":
      return 120 * (effect.amount ?? 1);
    case "opponentMayDraw":
      return -100 * (effect.amountIf?.amount ?? effect.amount ?? 1);
    case "revealHandCards":
      return hasMatchingHandCard(state, playerId, effect.filter ?? {}) ? 15 : 0;
    case "predictTopDeckRequiredEnergy":
      return 120 + effectScore(state, playerId, effect.successEffect, sourcePermanent) / 4;
    case "drawOpponent":
      return -120 * (effect.amount ?? 1);
    case "drawLastMovedFromHandCount":
      return 120;
    case "drawLastRestedTargetControllers":
      return 80 * (effect.amount ?? 1);
    case "drawUntilHandSize": {
      const target = effect.sameAsOpponent ? state.players[opponentOf(playerId)].hand.length : effect.handSize ?? 0;
      return 100 * Math.max(0, target - state.players[playerId].hand.length);
    }
    case "scheduleSidelineTargetsAndMoveSelfToEnergy":
      return 260 + bestTargetScore(state, playerId, effect, sourcePermanent) / 25;
    case "searchTopDeck":
      return 120 * (effect.max ?? effect.amount ?? 1);
    case "lookTopDeck":
      return 10 * (effect.count ?? effect.amount ?? 1);
    case "lookTopDeckAndMove":
      return 50 * (effect.count ?? effect.amount ?? 1);
    case "lookTopDeckPlayOneAndMoveRest":
      return 360 + 20 * (effect.count ?? effect.amount ?? 1);
    case "revealTopDeckOptionalPlayOrRaidInstead":
      return 420 + effectScore(state, playerId, effect.costEffect, sourcePermanent);
    case "moveTopDeck":
      return effect.destination === "sideline" ? 30 * (effect.count ?? effect.amount ?? 1) : 20;
    case "turnTopDeckFaceUp":
      return 50;
    case "placeTopDeckUnderSelf":
      return 80 * (effect.count ?? effect.amount ?? 1);
    case "placeTopDeckUnderTargets":
      return 80 * (effect.count ?? effect.amount ?? 1) + bestTargetScore(state, playerId, effect, sourcePermanent) / 40;
    case "readyAp":
      return 100 * (effect.amount ?? effect.count ?? 1);
    case "payAp":
      return -180 * (effect.amount ?? 1);
    case "restrictCardUse":
      return -140;
    case "grantEnergy":
      return sourcePermanent?.rested ? 80 : 160;
    case "scheduleSidelineSelfAtEndOfMain":
      return -140;
    case "modifyBp": {
      const amount = effect.amountPer?.kind === "eventUsedCount"
        ? Number(effect.amount ?? 0) * Number(state.turnFlags?.[playerId]?.eventUsedCount ?? 0)
        : Number(effect.amount ?? 0);
      return Math.abs(amount) / 5 + bestTargetScore(state, playerId, effect, sourcePermanent) / 20;
    }
    case "modifyBpLastPlayedPermanent":
      return Math.abs(effect.amount ?? 0) / 5 + 80;
    case "modifyBpForHandReveal":
      return (effect.amountPerCard ?? 0) * state.players[playerId].hand.length / 5;
    case "modifyBpForLastMovedUnderCards":
      return (effect.amountPerCard ?? 0) / 5;
    case "modifyBpForLastMovedFromHandCards":
      return (effect.amountPerCard ?? 0) * Math.max(1, state.players[playerId].hand.length) / 5;
    case "modifyBpForLastMovedCards":
      return (effect.amountPerCard ?? 0) / 5;
    case "sidelineTargetsByUniqueAffinityReveal":
      return 360 + bestTargetScore(state, playerId, effect, sourcePermanent) / 20;
    case "readySelf":
      return sourcePermanent?.rested ? 180 : 30;
    case "readyTargets":
      return 120 + bestTargetScore(state, playerId, effect, sourcePermanent) / 20;
    case "readyLastPlayedPermanent":
      return 140;
    case "restSelf":
      return sourcePermanent?.rested ? 0 : -100;
    case "restTargets":
      return 220 + bestTargetScore(state, playerId, effect, sourcePermanent) / 20;
    case "restTargetsThen":
      return 180 + bestTargetScore(state, playerId, effect, sourcePermanent) / 20
        + effectScore(state, playerId, effect.effect, sourcePermanent);
    case "grantKeyword":
      return keywordScore(effect.keyword, effect.value) + bestTargetScore(state, playerId, effect, sourcePermanent) / 30;
    case "grantMandatoryBlockLink":
      return 180;
    case "grantAbility":
      return effectScore(state, playerId, effect.ability?.effect, sourcePermanent)
        + bestTargetScore(state, playerId, effect, sourcePermanent) / 30;
    case "sidelineTargets":
      return 450 + bestTargetScore(state, playerId, effect, sourcePermanent) / 20;
    case "sidelineTargetsAndDraw":
      return 180;
    case "removeTargets":
      return 520 + bestTargetScore(state, playerId, effect, sourcePermanent) / 20;
    case "returnTargetsToHand":
    case "moveTargetsToBottomDeck":
    case "moveTargetsToDeck":
    case "moveTargetsToLife":
      return 320 + bestTargetScore(state, playerId, effect, sourcePermanent) / 25;
    case "returnTargetsToHandOrSelf": {
      const targetScore = bestTargetScore(state, playerId, effect, sourcePermanent);
      return targetScore > 0 ? 300 + targetScore / 25 : 80;
    }
    case "moveTopRaidCardToZone":
      return 300 + bestTargetScore(state, playerId, effect, sourcePermanent) / 25;
    case "damageOpponent":
      return damageScore(state, playerId, effect.amount ?? 1);
    case "damage":
      return damageScore(state, playerId, effect.amount ?? 1);
    case "discardOpponentFromHand":
      return 100 * Math.min(effect.amount ?? 1, state.players[opponentOf(playerId)].hand.length);
    case "revealOpponentHand":
      return 20 * state.players[opponentOf(playerId)].hand.length;
    case "moveHandToZone":
      return -70 * (effect.amount ?? effect.count ?? 1);
    case "moveAllHandToZone":
      return -70 * state.players[playerId].hand.length;
    case "playCardFromZone":
      if (hiddenZoneSelectionOwnedOutsidePolicy(playerId, effect)) {
        return effect.player === "opponent" ? -220 : 0;
      }
      return bestZoneCardChoice(state, playerId, effect) !== undefined ? 380 : 0;
    case "playOrRaidCardFromZone":
      return bestZoneCardChoice(state, playerId, effect) !== undefined ? 420 : 0;
    case "playCardFromZoneMatchingTargetName":
      return 300 + bestTargetScore(state, playerId, effect, sourcePermanent) / 30;
    case "playSomeNamedFromSidelineAddRest":
      return 500;
    case "playSourceFromZone":
      return 420;
    case "raidSourceFromZone":
      return 460;
    case "moveSourceCardBetweenZones":
      return effect.destination === "hand" ? 180 : 60;
    case "moveContextCardToZone":
      return zoneMoveValue(effect.destination ?? "hand");
    case "useEventFromZone":
      return bestZoneCardChoice(state, playerId, effect) !== undefined ? 260 : 0;
    case "reduceNextUseApCost":
      return hasMatchingHandCard(state, playerId, effect.filter) ? 260 * (effect.amount ?? 1) : 80 * (effect.amount ?? 1);
    case "reduceRequiredEnergy":
      return hasMatchingHandCard(state, playerId, effect.filter) ? 180 * (effect.amount ?? 1) : 60;
    case "modifyNextBpRange":
      return 80;
    case "moveCardBetweenZones":
      return 140 * (effect.count ?? effect.amount ?? 1);
    case "moveEqualCountsBetweenZones":
      return 100;
    case "moveUnderCardsToZone":
      return 160;
    case "moveBaseCardFromSelf":
      return zoneMoveValue(effect.destination ?? "hand", { fromOwnStack: true });
    case "moveHandCardsUnderSelf":
      return 80 * (effect.count ?? effect.amount ?? effect.max ?? 1);
    case "moveHandCardsUnderTargets":
      return 80 * (effect.count ?? effect.amount ?? effect.max ?? 1) + bestTargetScore(state, playerId, effect, sourcePermanent) / 40;
    case "moveZoneCardsUnderSelf":
      return 120;
    case "moveZoneCardsUnderTargets":
      return 120 + bestTargetScore(state, playerId, effect, sourcePermanent) / 40;
    case "moveSelfCardToDeckTop":
      return 40;
    case "moveSelfCardToZone":
      return effect.destination === "hand" ? 160 : 60;
    case "moveSelfCardUnderTarget":
      return 120 + bestTargetScore(state, playerId, effect, sourcePermanent) / 40;
    case "sidelineSelf":
      return -220;
    case "playBaseCardFromSelf":
      return 260;
    case "swapOwnFrontAndEnergy":
      return 40;
    case "swapChosenTargets":
      return 60;
    case "swapSourceWithOtherLine":
      return 80;
    case "swapTargetsWithOtherLine":
      return 80 + bestTargetScore(state, playerId, effect, sourcePermanent) / 40;
    case "moveOrSwapTargetsToOtherLine":
      return 120 + bestTargetScore(state, playerId, effect, sourcePermanent) / 35;
    case "replayTargets":
      return 260 + bestTargetScore(state, playerId, effect, sourcePermanent) / 25;
    case "activateTargetAbility":
      return 220 + bestTargetScore(state, playerId, effect, sourcePermanent) / 30;
    case "activateTargetTrigger":
      return 220 + bestTargetScore(state, playerId, effect, sourcePermanent) / 30;
    case "waiveAbilityCostForTargets":
      return 180 + bestTargetScore(state, playerId, effect, sourcePermanent) / 40;
    case "copyActivatedAbility":
      return 220 + bestTargetScore(state, playerId, effect, sourcePermanent) / 35;
    case "copyActivatedAbilitiesFromMovedCards":
      return 220;
    case "restEnergyLineForRequiredEnergyTotal":
      return 90;
    case "applyTieredAbilityGrants":
      return (effect.tiers ?? [])
        .flatMap((tier) => tier.effects ?? [])
        .reduce((total, child) => total + effectScore(state, playerId, child, sourcePermanent), 0);
    case "suppressPlayedAbilities":
      return 50;
    case "activateTriggerFromZone":
      return bestZoneCardChoice(state, playerId, effect) !== undefined ? 240 : 0;
    case "targetingModifier":
      return 120;
    case "choiceModeModifier":
      return 220;
    case "replacementOrUseRestriction":
      return 0;
    case "restrictMovement":
      return 140;
    case "watchTargetSidelinedForZoneMove":
      return 120 + bestTargetScore(state, playerId, effect, sourcePermanent) / 40;
    case "watchTargetSidelinedForEffect":
      return effectScore(state, playerId, effect.effect, sourcePermanent)
        + bestTargetScore(state, playerId, effect, sourcePermanent) / 40;
    case "moveTargetsToLine":
    case "moveTargetsToOtherLine":
      return 100 + bestTargetScore(state, playerId, effect, sourcePermanent) / 30;
    case "sidelineTargetsThenActivateSourceWhenPlayed":
      return 250;
    case "opponentMaySidelineChosenTargetsElse":
      return Math.max(120, effectScore(state, playerId, effect.elseEffect, sourcePermanent) - 120);
    case "opponentMayMoveCardsBetweenZonesElse": {
      const opponentId = opponentOf(playerId);
      const source = state.players[opponentId]?.[effect.source ?? "sideline"] ?? [];
      const count = effect.count ?? effect.amount ?? 1;
      const canMove = source.filter((card) => zoneCardMatches(state, card, effect.filter ?? {})).length >= count;
      const movedScore = effectScore(state, playerId, effect.ifMovedEffect, sourcePermanent);
      const elseScore = effectScore(state, playerId, effect.elseEffect, sourcePermanent);
      return canMove ? Math.min(movedScore, elseScore) : elseScore;
    }
    case "recoverLifeIfEmpty":
      return state.players[playerId].life.length === 0 ? 650 * (effect.amount ?? 1) : 40;
    case "scheduleReturnTargetsToHand":
      return 180 + bestTargetScore(state, playerId, effect, sourcePermanent) / 35;
    case "scheduleLastPlayedPermanentToZone":
      return zoneMoveValue(effect.zone ?? "sideline", { delayed: true });
    case "unsupported":
      return -1000;
    default:
      return 0;
  }
}

function bestTargetScore(state, playerId, effect, sourcePermanent) {
  const selector = targetSelectorForEffect(effect);
  if (!selector) return 0;
  const scores = targetCandidates(state, playerId, selector, sourcePermanent)
    .map((target) => targetScore(state, playerId, effect, target));
  return scores.length === 0 ? 0 : Math.max(...scores);
}

function zoneMoveValue(destination = "hand", { fromOwnStack = false, delayed = false } = {}) {
  if (destination === "hand") return delayed ? 140 : 180;
  if (destination === "life") return 240;
  if (destination === "deck") return 60;
  if (destination === "removal") return fromOwnStack ? -80 : 80;
  if (destination === "sideline") return fromOwnStack || delayed ? -60 : 80;
  return 60;
}

function keywordScore(keyword, value = 1) {
  if (keyword === "damage") return 280 * Number(value ?? 1);
  if (keyword === "impact") return 220 * Number(value ?? 1);
  if (keyword === "doubleAttack") return 260;
  if (keyword === "doubleBlock") return 120;
  if (keyword === "snipe") return 180;
  if (keyword === "mustBlock") return 120;
  if (keyword === "drawOnAttack") return 170;
  if (keyword === "raidTargetForAnyRaid") return 140;
  if (keyword === "moveToFrontOnEnergyAttack") return 130;
  if (keyword === "playSelfWhenSidelined") return 100;
  if (keyword === "drawOnUnblockedAttack") return 180;
  if (keyword === "cantBeBlockedByBpMin") return 170;
  if (keyword === "cantBeBlockedByBpMax") return 150;
  if (keyword === "frontLineEnergyGeneration") return 160;
  if (keyword === "cantAttack") return -300;
  if (keyword === "opponentAbilityTargetTax") return 80;
  return 80;
}

function damageScore(state, playerId, amount) {
  const opponent = state.players[opponentOf(playerId)];
  const lethalBonus = opponent.life.length <= amount ? 1000 : 0;
  return lethalBonus + 360 * amount;
}

function abilityCostPenalty(state, playerId, sourcePermanent, ability) {
  const cost = ability.cost ?? {};
  let penalty = 0;
  if (cost.restSelf) penalty += sourcePermanent && sourcePermanent.rested ? 1000 : 120;
  if (cost.sidelineSelf) penalty += 260 + permanentBattlePower(state, sourcePermanent) / 30;
  if (cost.ap) penalty += 180 * cost.ap;
  if (cost.discardFromHand) penalty += 90 * cost.discardFromHand;
  if (ability.oncePerTurn || ability.oncePerTurnKey) penalty += 20;
  return penalty;
}

function bestZoneCardChoice(state, playerId, effect, choices = {}) {
  const zones = effect.zones ?? [effect.zone ?? effect.source ?? "hand"];
  const zonePlayerId = effect.player === "opponent" ? opponentOf(playerId) : effect.player ?? playerId;
  let bestChoice = undefined;
  let bestScore = -Infinity;
  for (const zoneName of zones) {
    const zone = state.players[zonePlayerId]?.[zoneName] ?? [];
    zone.forEach((card, index) => {
      if (!zoneCardMatches(state, card, effect.filter, { playerId, choices })) return;
      const score = cardValue(state, card) + (zoneName === "sideline" ? 50 : 0);
      if (score > bestScore) {
        bestScore = score;
        bestChoice = zones.length === 1 ? index : { zone: zoneName, index };
      }
    });
  }
  return bestChoice;
}

function hasMatchingHandCard(state, playerId, filter = {}) {
  return state.players[playerId].hand.some((card) => zoneCardMatches(state, card, filter));
}

function lowestValueHandIndices(state, playerId, count, filter) {
  return state.players[playerId].hand
    .map((card, index) => ({ index, score: cardValue(state, card) }))
    .filter(({ index }) => !filter || zoneCardMatches(state, state.players[playerId].hand[index], filter))
    .sort((a, b) => a.score - b.score)
    .slice(0, count)
    .map((item) => item.index);
}

function zoneCardMatches(state, cardRef, filter = {}, context = {}) {
  const def = state.catalog[cardRef.defId];
  if (!def) return false;
  if (filter.anyOf && !filter.anyOf.some((childFilter) => zoneCardMatches(state, cardRef, childFilter, context))) return false;
  const {
    anyOf: _anyOf,
    differentNameFromChoiceKey: _differentNameFromChoiceKey,
    requiredEnergyFulfilled: _requiredEnergyFulfilled,
    ...definitionFilter
  } = filter;
  if (!internals.cardDefMatchesFilter(def, definitionFilter)) return false;
  if (filter.differentNameFromChoiceKey) {
    const target = context.choices?.[filter.differentNameFromChoiceKey]?.[0];
    const targetPlayerId = target?.player ?? target?.playerId ?? context.playerId;
    const targetLine = target?.lineName ?? target?.line;
    const targetPermanent = state.players[targetPlayerId]?.[targetLine]?.[target?.index];
    const targetName = targetPermanent ? state.catalog[targetPermanent.cards.at(-1).defId]?.name : undefined;
    if (targetName && cardDefHasName(def, targetName)) return false;
  }
  if (filter.requiredEnergyFulfilled && !internals.hasRequiredEnergy(state, cardRef.owner, def)) return false;
  return true;
}

function cardValue(state, cardRef) {
  if (!cardRef) return 0;
  const def = state.catalog[cardRef.defId];
  if (!def) return 0;
  const bp = Number(def.bp ?? 0) / 10;
  const energy = Number(def.requiredEnergy?.amount ?? 0) * 20;
  const ap = Number(def.apCost ?? 0) * 30;
  const trigger = def.trigger?.type && def.trigger.type !== TRIGGER_TYPES.NONE ? 40 : 0;
  return bp + energy - ap + trigger;
}

function permanentBattlePower(state, permanent) {
  if (!permanent) return 0;
  return internals.battlePower(state, permanent);
}

function cardRoleFeatures(state, playerId, def) {
  const features = {};
  if (!def) return features;
  const categories = effectCategoryFeaturesForCard(def);
  const requiredEnergy = Number(def.requiredEnergy?.amount ?? 0);
  const bp = Number(def.bp ?? 0);

  if (def.type === CARD_TYPES.CHARACTER && setupRequiredEnergyForCardUse(def) === 0) features.roleOpener = 1;
  if ((def.energy ?? []).some((icon) => Number(icon.amount ?? 0) > 0)) features.roleEnergyBuilder = energyAmountOnDef(def);
  if (def.type === CARD_TYPES.CHARACTER && handHasRaidPayoffForBase(state, playerId, def)) features.roleRaidBase = 1;
  if (def.raid) features.roleRaidPayoff = 1;
  if (categories.removal > 0) features.roleRemoval = categories.removal;
  if (categories.drawSearch > 0) features.roleDrawSearch = categories.drawSearch;
  if (categories.tempo > 0) features.roleTempo = categories.tempo;
  if (categories.boardDevelopment > 0 || def.raid || (def.abilities ?? []).length > 0) features.roleSynergyPiece = Math.max(1, categories.boardDevelopment);
  if (def.keywords?.damage || def.keywords?.impact || def.keywords?.doubleAttack || bp >= 4000 || requiredEnergy >= 4 || categories.damage > 0) {
    features.roleFinisher = 1 + categories.damage;
  }
  if (def.keywords?.doubleBlock || bp >= 3500 || def.keywords?.cantBeBlockedByBpMin || def.keywords?.cantBeBlockedByBpMax) {
    features.roleDefender = 1;
  }
  return features;
}

function abilityRoleFeatures(effect) {
  const categories = effectCategoryFeatures(effect);
  return {
    abilityCardAdvantage: categories.cardAdvantage,
    abilityRemoval: categories.removal,
    abilityBoardDevelopment: categories.boardDevelopment,
    abilitySearch: categories.drawSearch,
    abilityTempo: categories.tempo
  };
}

function effectCategoryFeaturesForCard(def) {
  const effects = [
    def.eventEffect,
    ...(def.abilities ?? []).map((ability) => ability.effect),
    def.trigger?.effect
  ].filter(Boolean);
  return effects.reduce((total, effect) => addCategoryFeatures(total, effectCategoryFeatures(effect)), emptyCategoryFeatures());
}

function effectCategoryFeatures(effect) {
  const features = emptyCategoryFeatures();
  if (!effect || effect.kind === "none") return features;

  if (effect.kind === "sequence") {
    return (effect.effects ?? []).reduce((total, child) => addCategoryFeatures(total, effectCategoryFeatures(child)), features);
  }
  if (effect.kind === "optional") return effectCategoryFeatures(effect.effect);
  if (effect.kind === "optionalInstead") {
    return addCategoryFeatures(effectCategoryFeatures(effect.baseEffect), effectCategoryFeatures(effect.insteadEffect));
  }
  if (effect.kind === "optionalChoiceUpgrade") {
    return addCategoryFeatures(effectCategoryFeatures(effect.baseEffect), effectCategoryFeatures(effect.upgradedEffect));
  }
  if (effect.kind === "conditional" || effect.kind === "targetConditional") {
    return addCategoryFeatures(effectCategoryFeatures(effect.effect), effectCategoryFeatures(effect.elseEffect));
  }
  if (effect.kind === "chooseOne" || effect.kind === "chooseN") {
    return (effect.choices ?? [])
      .map((choice) => effectCategoryFeatures(choice.effect))
      .reduce(maxCategoryFeatures, features);
  }

  if (["sidelineTargets", "removeTargets", "returnTargetsToHand", "returnTargetsToHandOrSelf", "moveTargetsToBottomDeck", "moveTargetsToDeck", "moveTargetsToLife", "moveTopRaidCardToZone", "sidelineTargetsByUniqueAffinityReveal"].includes(effect.kind)) {
    features.removal += 1;
  }
  if (["draw", "drawLastMovedFromHandCount", "drawUntilHandSize", "searchTopDeck", "lookTopDeck", "lookTopDeckAndMove", "lookTopDeckPlayOneAndMoveRest", "revealTopDeckOptionalPlayOrRaidInstead", "turnTopDeckFaceUp", "revealOpponentHand"].includes(effect.kind)) {
    features.drawSearch += 1;
    features.cardAdvantage += ["draw", "drawLastMovedFromHandCount", "drawUntilHandSize", "searchTopDeck"].includes(effect.kind) ? 1 : 0;
  }
  if (["playCardFromZone", "playOrRaidCardFromZone", "playCardFromZoneMatchingTargetName", "playSomeNamedFromSidelineAddRest", "playSourceFromZone", "raidSourceFromZone", "readyLastPlayedPermanent", "playBaseCardFromSelf", "moveBaseCardFromSelf", "replayTargets", "activateTargetTrigger"].includes(effect.kind)) {
    features.boardDevelopment += 1;
  }
  if (["restSelf", "restTargets", "restTargetsThen", "readySelf", "readyTargets", "modifyBp", "modifyBpLastPlayedPermanent", "grantKeyword", "grantMandatoryBlockLink", "grantAbility", "moveTargetsToLine", "moveTargetsToOtherLine", "moveOrSwapTargetsToOtherLine", "swapOwnFrontAndEnergy", "swapChosenTargets", "swapSourceWithOtherLine", "swapTargetsWithOtherLine", "restrictMovement", "scheduleReturnTargetsToHand", "scheduleLastPlayedPermanentToZone", "reduceNextUseApCost", "reduceRequiredEnergy"].includes(effect.kind)) {
    features.tempo += 1;
  }
  if (["damageOpponent", "damage"].includes(effect.kind)) features.damage += Number(effect.amount ?? 1);
  if (effect.kind === "discardOpponentFromHand") features.cardAdvantage += 1;
  return capCategoryFeatures(features);
}

function emptyCategoryFeatures() {
  return { removal: 0, drawSearch: 0, boardDevelopment: 0, tempo: 0, cardAdvantage: 0, damage: 0 };
}

function addCategoryFeatures(left, right) {
  return capCategoryFeatures(Object.fromEntries(Object.keys(emptyCategoryFeatures()).map((key) => [
    key,
    Number(left?.[key] ?? 0) + Number(right?.[key] ?? 0)
  ])));
}

function maxCategoryFeatures(left, right) {
  return Object.fromEntries(Object.keys(emptyCategoryFeatures()).map((key) => [
    key,
    Math.max(Number(left?.[key] ?? 0), Number(right?.[key] ?? 0))
  ]));
}

function capCategoryFeatures(features) {
  return Object.fromEntries(Object.entries(features).map(([key, value]) => [key, Math.min(3, Number(value ?? 0))]));
}

function handHasRaidPayoffForBase(state, playerId, def) {
  return state.players[playerId].hand.some((card) => {
    const handDef = state.catalog[card.defId];
    if (!handDef?.raid) return false;
    return raidDefMatchesBaseDef(handDef, def);
  });
}

function raidDefMatchesBaseDef(raidDef, baseDef) {
  const raidNames = raidDef.raid?.names ?? (raidDef.raid?.name ? [raidDef.raid.name] : []);
  const raidAffinities = raidDef.raid?.affinities ?? (raidDef.raid?.affinity ? [raidDef.raid.affinity] : []);
  if (raidNames.some((name) => cardDefHasName(baseDef, name))) return true;
  return raidAffinities.some((affinity) => includesText(baseDef.affinities, affinity));
}

function energyAmountOnDef(def) {
  return Math.min(3, (def.energy ?? []).reduce((total, icon) => total + Number(icon.amount ?? 0), 0));
}

function sourceCanAttackSoon(state, playerId, source) {
  if (!source || !isCharacterPermanent(state, source) || source.rested || internals.hasKeyword(state, source, "cantAttack")) return false;
  const player = state.players[playerId];
  if (player.frontLine.some((permanent) => permanent.pid === source.pid)) return true;
  return player.energyLine.some((permanent) => permanent.pid === source.pid)
    && internals.hasKeyword(state, source, "canAttackFromEnergyLine");
}

function threatScoreForPermanent(state, permanent) {
  if (!permanent) return 0;
  const def = state.catalog[permanent.cards.at(-1).defId];
  let score = permanentBattlePower(state, permanent);
  score += directDamageAmount(state, permanent) * 500;
  if (def?.raid || permanent.cards.length > 1) score += 400;
  if (def?.keywords?.snipe) score += 350;
  if (def?.keywords?.doubleAttack) score += 450;
  if (def?.keywords?.impact) score += 250 * Number(def.keywords.impact === true ? 1 : def.keywords.impact);
  if ((def?.abilities ?? []).length > 0) score += 250;
  return score;
}

function attackingWithLastActiveBlocker(state, playerId, attacker) {
  if (!attacker) return false;
  const active = activeFrontBlockers(state, playerId);
  return active.length <= 1 && active.some((permanent) => permanent.pid === attacker.pid);
}

function attackCouldOpenCrackbackLethal(state, playerId, attacker) {
  if (!attackingWithLastActiveBlocker(state, playerId, attacker)) return false;
  return frontLineDamagePotential(state, opponentOf(playerId)) >= state.players[playerId].life.length;
}

function frontLineDamagePotential(state, playerId) {
  const player = state.players[playerId];
  return [...player.frontLine, ...player.energyLine.filter((permanent) => internals.hasKeyword(state, permanent, "canAttackFromEnergyLine"))]
    .filter((permanent) => isCharacterPermanent(state, permanent) && !internals.hasKeyword(state, permanent, "cantAttack"))
    .reduce((total, permanent) => total + directDamageAmount(state, permanent), 0);
}

function isCharacterPermanent(state, permanent) {
  const def = state.catalog[permanent?.cards?.at(-1)?.defId];
  return def?.type === CARD_TYPES.CHARACTER;
}

function activeFrontBlockers(state, playerId) {
  return state.players[playerId].frontLine.filter((permanent) => {
    return isCharacterPermanent(state, permanent)
      && !permanent.rested
      && !internals.hasKeyword(state, permanent, "cantBlock");
  });
}

function readyAttackThreat(state, playerId) {
  const player = state.players[playerId];
  const opponent = state.players[opponentOf(playerId)];
  const attackers = [
    ...player.frontLine,
    ...player.energyLine.filter((permanent) => internals.hasKeyword(state, permanent, "canAttackFromEnergyLine"))
  ].filter((permanent) => {
    return isCharacterPermanent(state, permanent)
      && !permanent.rested
      && !internals.hasKeyword(state, permanent, "cantAttack");
  });
  const damage = attackers.reduce((total, permanent) => total + directDamageAmount(state, permanent), 0);
  return {
    count: attackers.length,
    damage,
    lethal: damage >= opponent.life.length
  };
}

function directDamageAmount(state, permanent) {
  if (!permanent) return 1;
  return internals.directDamageAmount(state, permanent);
}

function impactDamageAmount(state, attacker, defender) {
  if (!attacker || !defender) return 0;
  return internals.impactDamageAmount(state, attacker, defender);
}

function attackerPermanentForAction(state, playerId, action) {
  const player = state.players[playerId];
  const lineName = action.attackerLine ?? LINES.FRONT;
  return player?.[lineName]?.[action.attackerIndex];
}

function pendingAttackContext(state, defenderPlayerId) {
  const attack = state.pendingAttack;
  if (!attack || attack.defenderPlayer !== defenderPlayerId) return {};
  const attackerPlayer = state.players[attack.attackerPlayer];
  for (const lineName of [LINES.FRONT, LINES.ENERGY]) {
    const index = attackerPlayer[lineName].findIndex((permanent) => permanent.pid === attack.attackerPermanentId);
    if (index !== -1) {
      return {
        attack,
        attacker: attackerPlayer[lineName][index],
        attackerLine: lineName,
        attackerIndex: index
      };
    }
  }
  return { attack };
}

function permanentEnergyGeneration(state, permanent) {
  if (!permanent) return 0;
  const def = state.catalog[permanent.cards.at(-1).defId];
  return [...(def.energy ?? []), ...(permanent.energyModifiers ?? [])]
    .reduce((total, icon) => total + Number(icon.amount ?? 0), 0);
}

function sameText(left, right) {
  return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
}

function namesOfCardDef(def) {
  return [def?.name, ...(def?.alternateNames ?? [])].filter(Boolean);
}

function cardDefHasName(def, name) {
  return namesOfCardDef(def).some((candidate) => sameText(candidate, name));
}

function cardDefNameIncludesAll(def, parts = []) {
  const needles = parts.map((part) => String(part).toLowerCase());
  return namesOfCardDef(def).some((name) => {
    const normalized = String(name).toLowerCase();
    return needles.every((needle) => normalized.includes(needle));
  });
}

function includesText(values = [], value) {
  return values.some((item) => sameText(item, value));
}
