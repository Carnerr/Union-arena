import { createHash } from "node:crypto";
import {
  COUNTERFACTUAL_STATE_EVALUATION_VERSION,
  MAX_MATCHUP_RUNTIME_DOMINANT_ACTION_PAIR_RATE,
  MAX_ML_RUNTIME_DOMINANT_ACTION_PAIR_RATE,
  MAX_ML_RUNTIME_HISTORICAL_UNCLASSIFIED_EXAMPLES,
  MAX_ML_RUNTIME_VALIDATION_INPUT_CONFLICT_RATE,
  MAX_ML_RUNTIME_VALIDATION_DOMINANT_ACTION_PAIR_RATE,
  MIN_LEARNING_EVIDENCE_FILTER_VERSION,
  MIN_LEARNING_SOURCE_DIGEST_VERSION,
  MIN_MATCHUP_IMPACT_VALIDATION_GAMES,
  MIN_MATCHUP_RUNTIME_DISTINCT_ACTION_PAIRS,
  MIN_MATCHUP_RUNTIME_DISTINCT_PHASES,
  MIN_MATCHUP_RUNTIME_DIVERSITY_EXAMPLES,
  MIN_MATCHUP_RUNTIME_PAIRWISE_EFFECTIVE_WEIGHT,
  MIN_MATCHUP_RUNTIME_PAIRWISE_EXAMPLES,
  MIN_ML_EVIDENCE_DIVERSITY_VERSION,
  MIN_ML_FEATURE_SELECTION_VERSION,
  MIN_ML_PAIRWISE_EFFECTIVE_WEIGHT_VERSION,
  MIN_ML_PAIRWISE_INPUT_CONSISTENCY_VERSION,
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
  MIN_ML_RUNTIME_VALIDATION_DISTINCT_ACTION_PAIRS,
  MIN_ML_RUNTIME_VALIDATION_DISTINCT_OPPONENTS,
  MIN_ML_RUNTIME_VALIDATION_DISTINCT_PHASES,
  MIN_ML_RUNTIME_VALIDATION_PAIRWISE_EFFECTIVE_WEIGHT,
  MIN_ML_RUNTIME_VALIDATION_CONSISTENCY_REPEATED_CONTEXTS,
  MIN_ML_RUNTIME_VALIDATION_CONSISTENCY_REPEATED_EXAMPLES,
  MIN_ML_PAIRWISE_ORIENTATION_VERSION,
  MIN_ML_REGRESSION_VERSION,
  MIN_ML_TRAINING_PIPELINE_VERSION,
  MIN_ML_VALIDATION_ASSIGNMENT_VERSION,
  MIN_ML_VALIDATION_DIVERSITY_VERSION,
  MIN_ML_VALIDATION_STATE_VERSION,
  boundedContextualFeatureSelectionValid,
  mlActionModelRuntimeTrust,
  mlPairwiseEvidenceDiversity,
  mlValidationEvidenceDiversity,
  mlValidationInputConsistency,
  matchupOverlayArtifactSignature,
  matchupOverlayRuntimeTrust,
  matchupPairwiseEvidenceDiversity
} from "./simulation.js";

const PHASE_CREDIT_PRIORS = Object.freeze({
  setup: 1.5,
  start: 0.5,
  movement: 1.5,
  main: 4,
  attack: 5,
  block: 5,
  end: 1.5,
  unknown: 1
});

export const LEARNING_GAME_TELEMETRY_SCHEMA = "union-arena-local-engine/pilot-learning-game@1";
export const LEARNING_SAMPLING_SAFETY_VERSION = 1;
export const MIN_ADAPTIVE_AUDIT_BLOCK_SAMPLES = 8;
export const MAX_ADAPTIVE_AUDIT_DISAGREEMENT_RATE = 0.15;

export function isLearningGameTelemetry(row = {}) {
  return row?.schema === LEARNING_GAME_TELEMETRY_SCHEMA || row?.recordType === "learning-game";
}

export function learningGameTelemetryFingerprint(row = {}) {
  if (!isLearningGameTelemetry(row)) return null;
  return createHash("sha256")
    .update(JSON.stringify(stableLearningValue(row)))
    .digest("hex");
}

export function createLearningSamplingSafetyLedger(existing = null) {
  const source = existing ?? {};
  return {
    telemetryRows: nonnegativeNumber(source.telemetryRows),
    explorationDecisions: nonnegativeNumber(source.explorationDecisions),
    explorationCoverageGaps: nonnegativeNumber(source.explorationCoverageGaps),
    explorationPreviouslyAttempted: nonnegativeNumber(source.explorationPreviouslyAttempted),
    explorationEvidenceAttempts: nonnegativeNumber(source.explorationEvidenceAttempts),
    explorationEvidenceActionable: nonnegativeNumber(source.explorationEvidenceActionable),
    explorationEvidenceFeatureKeys: new Set((source.explorationEvidenceFeatureKeys ?? [])
      .map((feature) => String(feature))
      .filter((feature) => feature.startsWith("context."))),
    adaptiveCounterfactuals: nonnegativeNumber(source.adaptiveCounterfactuals),
    adaptiveEarlyStops: nonnegativeNumber(source.adaptiveEarlyStops),
    adaptiveAuditEligible: nonnegativeNumber(source.adaptiveAuditEligible),
    adaptiveAudits: nonnegativeNumber(source.adaptiveAudits),
    adaptiveAuditAgreements: nonnegativeNumber(source.adaptiveAuditAgreements),
    adaptiveAuditDisagreements: nonnegativeNumber(source.adaptiveAuditDisagreements),
    counterfactualRequestedPlayerTurns: nonnegativeNumber(source.counterfactualRequestedPlayerTurns),
    counterfactualEvaluatedPlayerTurns: nonnegativeNumber(source.counterfactualEvaluatedPlayerTurns),
    counterfactualEstimatedPlayerTurnsSaved: nonnegativeNumber(source.counterfactualEstimatedPlayerTurnsSaved)
  };
}

export function recordLearningSamplingTelemetry(ledger, row = {}) {
  if (!isLearningGameTelemetry(row)) return false;
  ledger.telemetryRows += 1;
  ledger.explorationDecisions += nonnegativeNumber(row.explorationDecisions);
  ledger.explorationCoverageGaps += nonnegativeNumber(row.explorationCoverageGapDecisions);
  ledger.explorationPreviouslyAttempted += nonnegativeNumber(row.explorationPreviouslyAttemptedDecisions);
  ledger.explorationEvidenceAttempts += nonnegativeNumber(row.explorationEvidenceAttemptsAdded);
  ledger.explorationEvidenceActionable += nonnegativeNumber(row.explorationEvidenceActionableAdded);
  for (const feature of row.explorationEvidenceFeatureKeys ?? []) {
    const key = String(feature);
    if (key.startsWith("context.")) ledger.explorationEvidenceFeatureKeys.add(key);
  }
  ledger.adaptiveCounterfactuals += nonnegativeNumber(row.counterfactualAdaptiveDecisions);
  ledger.adaptiveEarlyStops += nonnegativeNumber(row.counterfactualAdaptiveEarlyStops);
  ledger.adaptiveAuditEligible += nonnegativeNumber(row.counterfactualAdaptiveAuditEligible);
  ledger.adaptiveAudits += nonnegativeNumber(row.counterfactualAdaptiveAudits);
  ledger.adaptiveAuditAgreements += nonnegativeNumber(row.counterfactualAdaptiveAuditAgreements);
  ledger.adaptiveAuditDisagreements += nonnegativeNumber(row.counterfactualAdaptiveAuditDisagreements);
  ledger.counterfactualRequestedPlayerTurns += nonnegativeNumber(row.counterfactualRequestedPlayerTurns);
  ledger.counterfactualEvaluatedPlayerTurns += nonnegativeNumber(row.counterfactualEvaluatedPlayerTurns);
  ledger.counterfactualEstimatedPlayerTurnsSaved += nonnegativeNumber(row.counterfactualEstimatedPlayerTurnsSaved);
  return true;
}

export function summarizeLearningSamplingSafety(ledger) {
  const telemetryRows = nonnegativeNumber(ledger?.telemetryRows);
  const explorationDecisions = nonnegativeNumber(ledger?.explorationDecisions);
  const explorationEvidenceAttempts = nonnegativeNumber(ledger?.explorationEvidenceAttempts);
  const explorationEvidenceActionable = nonnegativeNumber(ledger?.explorationEvidenceActionable);
  const explorationCoverageGaps = nonnegativeNumber(ledger?.explorationCoverageGaps);
  const explorationPreviouslyAttempted = nonnegativeNumber(ledger?.explorationPreviouslyAttempted);
  const adaptiveEarlyStops = nonnegativeNumber(ledger?.adaptiveEarlyStops);
  const adaptiveAudits = nonnegativeNumber(ledger?.adaptiveAudits);
  const adaptiveAuditAgreements = nonnegativeNumber(ledger?.adaptiveAuditAgreements);
  const adaptiveAuditDisagreements = nonnegativeNumber(ledger?.adaptiveAuditDisagreements);
  const actionableYield = safeRatio(explorationEvidenceActionable, explorationEvidenceAttempts);
  const repeatedAttemptRate = safeRatio(explorationPreviouslyAttempted, explorationDecisions);
  const coverageGapRate = safeRatio(explorationCoverageGaps, explorationDecisions);
  const adaptiveAuditDisagreementRate = safeRatio(adaptiveAuditDisagreements, adaptiveAudits);
  const blockers = [];
  const warnings = [];
  if (adaptiveAudits >= MIN_ADAPTIVE_AUDIT_BLOCK_SAMPLES
    && adaptiveAuditDisagreementRate > MAX_ADAPTIVE_AUDIT_DISAGREEMENT_RATE) {
    blockers.push(`${percentText(adaptiveAuditDisagreementRate)} of ${adaptiveAudits} adaptive-depth audits reversed the early preference.`);
  } else if (adaptiveAudits >= 3 && adaptiveAuditDisagreementRate > 0.1) {
    warnings.push(`${percentText(adaptiveAuditDisagreementRate)} of ${adaptiveAudits} adaptive-depth audits disagreed with the full horizon.`);
  }
  if (adaptiveEarlyStops >= 20 && adaptiveAudits === 0) {
    warnings.push(`${adaptiveEarlyStops} adaptive early stops have no retained full-horizon audit.`);
  }
  if (explorationEvidenceAttempts >= 8 && actionableYield < 0.5) {
    warnings.push(`Exploration actionable yield is only ${percentText(actionableYield)} across ${explorationEvidenceAttempts} probes.`);
  }
  if (explorationDecisions >= 8 && repeatedAttemptRate > 0.75 && coverageGapRate < 0.25) {
    warnings.push(`${percentText(repeatedAttemptRate)} of exploration decisions repeated attempted lines while coverage-gap sampling remained low.`);
  }
  const status = blockers.length > 0
    ? "blocked"
    : warnings.length > 0 ? "watch" : telemetryRows > 0 ? "healthy" : "unknown";
  return {
    version: LEARNING_SAMPLING_SAFETY_VERSION,
    status,
    label: status === "blocked" ? "Blocked" : status === "watch" ? "Watch" : status === "healthy" ? "Healthy" : "Unknown",
    blockers,
    warnings,
    telemetryRows,
    explorationDecisions,
    explorationCoverageGaps,
    explorationPreviouslyAttempted,
    explorationEvidenceAttempts,
    explorationEvidenceActionable,
    explorationEvidenceFeatureKeys: [...(ledger?.explorationEvidenceFeatureKeys ?? [])]
      .sort((left, right) => left.localeCompare(right)),
    adaptiveCounterfactuals: nonnegativeNumber(ledger?.adaptiveCounterfactuals),
    adaptiveEarlyStops,
    adaptiveAuditEligible: nonnegativeNumber(ledger?.adaptiveAuditEligible),
    adaptiveAudits,
    adaptiveAuditAgreements,
    adaptiveAuditDisagreements,
    counterfactualRequestedPlayerTurns: nonnegativeNumber(ledger?.counterfactualRequestedPlayerTurns),
    counterfactualEvaluatedPlayerTurns: nonnegativeNumber(ledger?.counterfactualEvaluatedPlayerTurns),
    counterfactualEstimatedPlayerTurnsSaved: nonnegativeNumber(ledger?.counterfactualEstimatedPlayerTurnsSaved),
    rates: {
      explorationActionableYield: actionableYield,
      explorationPreviouslyAttemptedRate: repeatedAttemptRate,
      explorationCoverageGapRate: coverageGapRate,
      adaptiveAuditAgreementRate: safeRatio(adaptiveAuditAgreements, adaptiveAudits),
      adaptiveAuditDisagreementRate,
      adaptivePlayerTurnSavingsRate: safeRatio(
        nonnegativeNumber(ledger?.counterfactualEstimatedPlayerTurnsSaved),
        nonnegativeNumber(ledger?.counterfactualRequestedPlayerTurns)
      )
    }
  };
}

export function learningHealthWithSamplingSafety(existingHealth = null, samplingSafety = null) {
  const existing = existingHealth && typeof existingHealth === "object" ? existingHealth : {};
  const sampling = samplingSafety && typeof samplingSafety === "object"
    ? samplingSafety
    : summarizeLearningSamplingSafety(createLearningSamplingSafetyLedger());
  const existingStatus = normalizedLearningHealthStatus(existing.status);
  const samplingStatus = normalizedLearningHealthStatus(sampling.status);
  const status = learningHealthSeverity(existingStatus) >= learningHealthSeverity(samplingStatus)
    ? existingStatus
    : samplingStatus;
  const blockers = uniqueStrings([
    ...(existing.blockers ?? []),
    ...(samplingStatus === "blocked" ? sampling.blockers ?? [] : [])
  ]);
  const warnings = uniqueStrings([
    ...(existing.warnings ?? []),
    ...(sampling.warnings ?? [])
  ]);
  return {
    ...existing,
    status,
    label: learningHealthLabel(status),
    blockers,
    warnings,
    strengths: uniqueStrings(existing.strengths ?? []),
    samplingSafety: sampling
  };
}

function nonnegativeNumber(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function safeRatio(numerator, denominator) {
  return Number(denominator ?? 0) > 0 ? Number(numerator ?? 0) / Number(denominator) : 0;
}

function percentText(value) {
  return `${(Number(value ?? 0) * 100).toFixed(1)}%`;
}

function normalizedLearningHealthStatus(value) {
  const status = String(value ?? "").toLowerCase();
  return ["blocked", "watch", "healthy"].includes(status) ? status : "unknown";
}

function learningHealthSeverity(status) {
  return status === "blocked" ? 3 : status === "watch" ? 2 : status === "healthy" ? 1 : 0;
}

function learningHealthLabel(status) {
  return status === "blocked" ? "Blocked" : status === "watch" ? "Watch" : status === "healthy" ? "Healthy" : "Unknown";
}

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value)).filter(Boolean))];
}

export function allocateDecisionCredits(decisions = [], { complete = true, maxCredit = 24 } = {}) {
  const rows = decisions.map((decision, ordinal) => {
    const eligible = Boolean(complete && Number(decision?.candidates?.length ?? 0) > 1);
    return {
      decision,
      ordinal,
      eligible,
      phase: decisionCreditPhase(decision),
      rawWeight: 0
    };
  });
  const eligibleRows = rows.filter((row) => row.eligible);
  const phaseCounts = countBy(eligibleRows, (row) => row.phase);

  for (const row of eligibleRows) {
    const phaseCount = Math.max(1, phaseCounts.get(row.phase) ?? 1);
    const phasePrior = PHASE_CREDIT_PRIORS[row.phase] ?? PHASE_CREDIT_PRIORS.unknown;
    const progress = eligibleRows.length > 0 ? (row.ordinal + 1) / rows.length : 1;
    let multiplier = 0.85 + progress * 0.3;
    if (row.decision?.chosenAction?.type === "advancePhase") multiplier *= 0.55;
    if (row.decision?.exploration) multiplier *= 1.35;
    row.phasePrior = phasePrior;
    row.phaseDecisionCount = phaseCount;
    row.rawWeight = phasePrior / phaseCount * multiplier;
  }

  const rawTotal = eligibleRows.reduce((total, row) => total + row.rawWeight, 0);
  const creditBudget = Math.min(Math.max(0, Number(maxCredit ?? 24)), eligibleRows.length);
  const scale = rawTotal > 0 ? creditBudget / rawTotal : 0;
  return new Map(rows.map((row) => [row.decision, {
    eligible: row.eligible && row.rawWeight > 0,
    weight: row.rawWeight * scale,
    ordinal: row.ordinal,
    playerDecisionCount: rows.length,
    eligibleDecisionCount: eligibleRows.length,
    phase: row.phase,
    phaseDecisionCount: row.phaseDecisionCount ?? 0,
    phasePrior: row.phasePrior ?? 0,
    creditBudget
  }]));
}

export function decisionCreditPhase(decision) {
  const actionType = decision?.chosenAction?.type;
  if (actionType === "keepHand" || actionType === "mulligan" || String(decision?.step ?? "").startsWith("setup-")) {
    return "setup";
  }
  if (actionType === "declareBlock" || actionType === "declineBlock" || decision?.state?.pendingAttack) {
    return "block";
  }
  const phase = String(decision?.state?.phase ?? "unknown").toLowerCase();
  return Object.hasOwn(PHASE_CREDIT_PRIORS, phase) ? phase : "unknown";
}

export function learningValidationGameKey(row = {}) {
  const ownDeck = row.ownKey ?? row.deckId ?? row.ownDeckId ?? "deck";
  const opponent = row.opponent ?? row.matchupProfileKey ?? "opponent";
  const seedIdentity = row.seed !== undefined && row.seed !== null
    ? `seed:${row.seed}`
    : `game:${row.gameIndex ?? row.gameId ?? "unknown"}`;
  return [ownDeck, opponent, seedIdentity].map((value) => String(value)).join("|");
}

export function learningDecisionGroupFingerprint(group = []) {
  const chosen = group.find((row) => row?.chosen) ?? group[0] ?? {};
  const trainingEvidence = {
    game: learningValidationGameKey(chosen),
    player: chosen.player ?? "player",
    step: chosen.step ?? "step",
    phase: chosen.creditPhase ?? chosen.phase ?? "unknown",
    state: {
      turnCycles: chosen.turnCyclesAtDecision ?? null,
      playerLife: chosen.playerLifeAtDecision ?? null,
      opponentLife: chosen.opponentLifeAtDecision ?? null,
      playerFront: chosen.playerFrontAtDecision ?? null,
      opponentFront: chosen.opponentFrontAtDecision ?? null,
      playerEnergy: chosen.playerEnergyAtDecision ?? null,
      opponentEnergy: chosen.opponentEnergyAtDecision ?? null
    },
    outcome: chosen.outcome ?? null,
    reward: chosen.reward ?? null,
    shapedReward: chosen.shapedReward ?? null,
    learningEligible: chosen.learningEligible ?? null,
    creditWeight: chosen.creditWeight ?? null,
    counterfactual: {
      preference: chosen.counterfactualPreference ?? chosen.counterfactual?.preference ?? null,
      advantage: chosen.counterfactualAdvantage ?? chosen.counterfactual?.advantage ?? null,
      confidence: chosen.counterfactualConfidence ?? chosen.counterfactual?.confidence ?? null,
      evidenceKind: chosen.counterfactualEvidenceKind ?? chosen.counterfactual?.evidenceKind ?? null,
      stateEvaluationVersion: chosen.counterfactualStateEvaluationVersion ?? chosen.counterfactual?.stateEvaluationVersion ?? null,
      chosenEvaluation: chosen.counterfactualChosenEvaluation ?? chosen.counterfactual?.chosenEvaluation ?? null,
      alternativeEvaluation: chosen.counterfactualAlternativeEvaluation ?? chosen.counterfactual?.alternativeEvaluation ?? null,
      alternativeIndex: chosen.counterfactualAlternativeIndex ?? chosen.counterfactual?.alternativeIndex ?? null,
      alternativeAction: chosen.counterfactualAlternativeAction ?? chosen.counterfactual?.alternativeAction ?? null
    },
    candidates: [...group]
      .sort((left, right) => Number(left.actionIndex ?? 0) - Number(right.actionIndex ?? 0))
      .map((row) => ({
        actionIndex: row.actionIndex ?? null,
        chosen: Boolean(row.chosen),
        action: row.action ?? null,
        features: row.features ?? {}
      }))
  };
  return createHash("sha256")
    .update(JSON.stringify(stableLearningValue(trainingEvidence)))
    .digest("hex");
}

export function counterfactualPairwiseLearningEvidence(row = {}) {
  const preference = String(row.counterfactualPreference ?? row.counterfactual?.preference ?? "").toLowerCase();
  const direction = ["chosen", "selected", "action"].includes(preference)
    ? 1
    : ["alternative", "other", "baseline"].includes(preference) ? -1 : 0;
  if (direction === 0) return null;
  const evidenceKind = String(row.counterfactualEvidenceKind ?? row.counterfactual?.evidenceKind ?? "").toLowerCase();
  const evaluatorVersion = Number(
    row.counterfactualStateEvaluationVersion ?? row.counterfactual?.stateEvaluationVersion ?? 1
  );
  if (evidenceKind !== "terminal-winner-change"
    && evaluatorVersion < COUNTERFACTUAL_STATE_EVALUATION_VERSION) return null;
  const magnitude = clamp(Math.abs(Number(row.counterfactualAdvantage ?? row.counterfactual?.advantage ?? 1)), 0.01, 1);
  const confidence = clamp(Number(row.counterfactualConfidence ?? row.counterfactual?.confidence ?? 1), 0.1, 1);
  return { direction, magnitude, confidence, evidenceKind, evaluatorVersion };
}

export function pairwiseEvidenceDiversityKeys(chosen = {}, alternative = {}, evidence = null) {
  const actionType = String(chosen?.action?.type ?? chosen?.actionType ?? "");
  const phase = actionType === "keepHand" || actionType === "mulligan"
    ? "setup"
    : String(chosen.creditPhase ?? chosen.phase ?? "unknown").toLowerCase() || "unknown";
  const actionPair = [pairwiseActionFamily(chosen), pairwiseActionFamily(alternative)]
    .sort()
    .join(" <-> ");
  return {
    phase,
    actionPair,
    opponentProfile: String(chosen.matchupProfileKey ?? "unknown").toLowerCase() || "unknown",
    evidenceKind: String(evidence?.evidenceKind ?? chosen.counterfactualEvidenceKind ?? "unknown").toLowerCase() || "unknown"
  };
}

export function pairwiseFeatureDifference(chosenFeatures = {}, alternativeFeatures = {}, direction = 1) {
  const keys = new Set([
    ...Object.keys(chosenFeatures ?? {}),
    ...Object.keys(alternativeFeatures ?? {})
  ]);
  const diff = {};
  for (const key of keys) {
    const value = (Number(chosenFeatures?.[key] ?? 0) - Number(alternativeFeatures?.[key] ?? 0)) * direction;
    if (Number.isFinite(value) && value !== 0) diff[key] = value;
  }
  return diff;
}

export function canonicalPairwiseInput(features = {}, target = 0) {
  const entries = Object.entries(features ?? {})
    .filter(([feature, rawValue]) => feature !== "baseScore" && Number.isFinite(Number(rawValue)) && Number(rawValue) !== 0)
    .sort(([left], [right]) => left.localeCompare(right));
  const targetSign = Math.sign(Number(target));
  if (entries.length === 0 || targetSign === 0) return null;
  const orientation = Number(entries[0][1]) < 0 ? -1 : 1;
  const normalized = entries.map(([feature, rawValue]) => {
    const value = normalizedPairwiseFeatureValue(Number(rawValue) * orientation);
    return [feature, value];
  });
  const key = JSON.stringify(normalized);
  return {
    contextId: createHash("sha256").update(key).digest("hex"),
    targetSign: targetSign * orientation
  };
}

export function createPairwiseInputConsistencyLedger({ maxContexts = Number.POSITIVE_INFINITY } = {}) {
  return {
    version: MIN_ML_PAIRWISE_INPUT_CONSISTENCY_VERSION,
    maxContexts: Number.isFinite(Number(maxContexts)) ? Math.max(1, Math.floor(Number(maxContexts))) : Number.POSITIVE_INFINITY,
    contexts: new Map(),
    observedExamples: 0,
    observedWeight: 0,
    trackedExamples: 0,
    trackedWeight: 0,
    untrackedExamples: 0,
    untrackedWeight: 0
  };
}

export function recordPairwiseInputConsistency(ledger, {
  features = {},
  target = 0,
  weight = 1,
  metadata = null
} = {}) {
  if (!ledger?.contexts || !(ledger.contexts instanceof Map)) return false;
  const numericWeight = Number(weight);
  const canonical = canonicalPairwiseInput(features, target);
  if (!canonical || !Number.isFinite(numericWeight) || numericWeight <= 0) return false;
  ledger.observedExamples += 1;
  ledger.observedWeight += numericWeight;
  let context = ledger.contexts.get(canonical.contextId);
  if (!context && ledger.contexts.size >= ledger.maxContexts) {
    ledger.untrackedExamples += 1;
    ledger.untrackedWeight += numericWeight;
    return false;
  }
  if (!context) {
    context = {
      contextId: canonical.contextId,
      positiveExamples: 0,
      negativeExamples: 0,
      positiveWeight: 0,
      negativeWeight: 0,
      phases: new Set(),
      actionPairs: new Set(),
      opponentProfiles: new Set(),
      playerGames: new Set()
    };
    ledger.contexts.set(canonical.contextId, context);
  }
  if (canonical.targetSign > 0) {
    context.positiveExamples += 1;
    context.positiveWeight += numericWeight;
  } else {
    context.negativeExamples += 1;
    context.negativeWeight += numericWeight;
  }
  addConsistencyMetadata(context.phases, metadata?.phase);
  addConsistencyMetadata(context.actionPairs, metadata?.actionPair);
  addConsistencyMetadata(context.opponentProfiles, metadata?.opponentProfile);
  addConsistencyMetadata(context.playerGames, metadata?.playerGame);
  ledger.trackedExamples += 1;
  ledger.trackedWeight += numericWeight;
  return true;
}

export function summarizePairwiseInputConsistencyLedger(ledger, { topConflicts = 8 } = {}) {
  const contexts = [...(ledger?.contexts?.values?.() ?? [])];
  const repeated = contexts.filter((row) => row.positiveExamples + row.negativeExamples >= 2);
  const conflicting = repeated.filter((row) => row.positiveExamples > 0 && row.negativeExamples > 0);
  const repeatedExamples = sumConsistency(repeated, (row) => row.positiveExamples + row.negativeExamples);
  const repeatedWeight = sumConsistency(repeated, (row) => row.positiveWeight + row.negativeWeight);
  const conflictingExamples = sumConsistency(conflicting, (row) => row.positiveExamples + row.negativeExamples);
  const conflictingWeight = sumConsistency(conflicting, (row) => row.positiveWeight + row.negativeWeight);
  const minorityWeight = sumConsistency(conflicting, (row) => Math.min(row.positiveWeight, row.negativeWeight));
  const conflictRate = repeatedWeight > 0 ? minorityWeight / repeatedWeight : 0;
  const gateEligible = repeated.length >= MIN_ML_RUNTIME_VALIDATION_CONSISTENCY_REPEATED_CONTEXTS
    && repeatedExamples >= MIN_ML_RUNTIME_VALIDATION_CONSISTENCY_REPEATED_EXAMPLES;
  return {
    version: MIN_ML_PAIRWISE_INPUT_CONSISTENCY_VERSION,
    complete: Number(ledger?.untrackedExamples ?? 0) === 0,
    contextCapacity: Number.isFinite(Number(ledger?.maxContexts)) ? Number(ledger.maxContexts) : null,
    observedExamples: Math.max(0, Number(ledger?.observedExamples ?? 0)),
    observedWeight: roundedConsistencyNumber(ledger?.observedWeight),
    trackedExamples: Math.max(0, Number(ledger?.trackedExamples ?? 0)),
    trackedWeight: roundedConsistencyNumber(ledger?.trackedWeight),
    untrackedExamples: Math.max(0, Number(ledger?.untrackedExamples ?? 0)),
    untrackedWeight: roundedConsistencyNumber(ledger?.untrackedWeight),
    contexts: contexts.length,
    repeatedContexts: repeated.length,
    repeatedExamples,
    repeatedWeight: roundedConsistencyNumber(repeatedWeight),
    conflictingContexts: conflicting.length,
    conflictingExamples,
    conflictingWeight: roundedConsistencyNumber(conflictingWeight),
    minorityWeight: roundedConsistencyNumber(minorityWeight),
    conflictRate,
    maximumAttainableRepeatedAccuracy: 1 - conflictRate,
    conflictAdjustedWeight: roundedConsistencyNumber(Math.max(0, Number(ledger?.trackedWeight ?? 0) - minorityWeight * 2)),
    gateEligible,
    unsafe: gateEligible && conflictRate > MAX_ML_RUNTIME_VALIDATION_INPUT_CONFLICT_RATE,
    thresholds: {
      repeatedContexts: MIN_ML_RUNTIME_VALIDATION_CONSISTENCY_REPEATED_CONTEXTS,
      repeatedExamples: MIN_ML_RUNTIME_VALIDATION_CONSISTENCY_REPEATED_EXAMPLES,
      maxConflictRate: MAX_ML_RUNTIME_VALIDATION_INPUT_CONFLICT_RATE
    },
    topConflicts: conflicting
      .map((row) => consistencyConflictRow(row))
      .sort((left, right) => right.minorityWeight - left.minorityWeight
        || right.examples - left.examples
        || left.contextId.localeCompare(right.contextId))
      .slice(0, Math.max(0, Number(topConflicts ?? 8)))
  };
}

export function pairwiseInputConsistencySummary(samples = [], options = {}) {
  const ledger = createPairwiseInputConsistencyLedger({ maxContexts: options.maxContexts });
  for (const sample of samples ?? []) recordPairwiseInputConsistency(ledger, sample);
  return summarizePairwiseInputConsistencyLedger(ledger, options);
}

function normalizedPairwiseFeatureValue(value) {
  const rounded = Math.round(value * 1e9) / 1e9;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function addConsistencyMetadata(values, value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized && normalized !== "unknown") values.add(normalized);
}

function sumConsistency(rows, selector) {
  return rows.reduce((total, row) => total + Number(selector(row) ?? 0), 0);
}

function roundedConsistencyNumber(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? Number(number.toFixed(6)) : 0;
}

function consistencyConflictRow(row) {
  const weight = row.positiveWeight + row.negativeWeight;
  const minorityWeight = Math.min(row.positiveWeight, row.negativeWeight);
  return {
    contextId: row.contextId.slice(0, 16),
    examples: row.positiveExamples + row.negativeExamples,
    positiveExamples: row.positiveExamples,
    negativeExamples: row.negativeExamples,
    weight: roundedConsistencyNumber(weight),
    minorityWeight: roundedConsistencyNumber(minorityWeight),
    conflictRate: weight > 0 ? minorityWeight / weight : 0,
    phases: [...row.phases].sort(),
    actionPairs: [...row.actionPairs].sort(),
    opponentProfiles: [...row.opponentProfiles].sort(),
    playerGames: row.playerGames.size
  };
}

export function pairwiseActionFamily(row = {}) {
  const action = row.action ?? {};
  const type = String(action.type ?? row.actionType ?? "unknown") || "unknown";
  if (type === "playCard") {
    const destination = String(action.destination ?? action.line ?? "unspecified");
    return action.replacesPermanent ? `${type}:${destination}:replace` : `${type}:${destination}`;
  }
  if (type === "moveCard") {
    return `${type}:${String(action.destination ?? action.toLine ?? "unspecified")}`;
  }
  if (type === "resolutionChoice") {
    const decisionKind = String(action.decisionKind ?? "unknown").toLowerCase() || "unknown";
    const option = String(action.resolutionOption ?? inferredResolutionOption(row, decisionKind) ?? "choice")
      .toLowerCase();
    return `${type}:${decisionKind}:${option}`;
  }
  if (type === "performRaid" && action.moveToFront !== undefined) {
    if (action.moveToFront) return action.replacesPermanent ? `${type}:move-front-replace` : `${type}:move-front`;
    return `${type}:stay-${String(action.targetLine ?? "field")}`;
  }
  return type;
}

export function decisionActionFamilies(rows = []) {
  const families = new Set();
  for (const row of rows ?? []) {
    const family = pairwiseActionFamily(row);
    if (family && family !== "unknown") families.add(family);
    for (const candidateFamily of row?.candidateActionFamilies ?? []) {
      const normalized = String(candidateFamily ?? "").trim();
      if (normalized && normalized !== "unknown") families.add(normalized);
    }
  }
  return [...families];
}

function inferredResolutionOption(row, decisionKind) {
  const featureKeys = Object.entries(row.features ?? {})
    .filter(([, value]) => Number(value ?? 0) !== 0)
    .map(([feature]) => String(feature).toLowerCase());
  const has = (pattern) => featureKeys.some((feature) => pattern.test(feature));
  if (decisionKind === "optionaleffect") {
    if (has(/\.optionaleffect\.accept(?:\.|$)/u) || has(/resolution-optionaleffect\.[^.]+\.true(?:\.|$)/u)) return "accept";
    if (has(/\.optionaleffect\.decline(?:\.|$)/u) || has(/resolution-optionaleffect\.[^.]+\.false(?:\.|$)/u)) return "decline";
  }
  if (decisionKind === "raidtrigger") {
    if (has(/\.raidtrigger\.decline(?:\.|$)/u) || has(/resolution-raidtrigger\.performraid\.false(?:\.|$)/u)) return "decline";
    const moves = has(/resolution-raidtrigger\.movetofront\.true(?:\.|$)/u);
    const replaces = has(/\.raidtrigger\.replace(?:\.|$)/u) || has(/resolution-raidtrigger\.replaceindex\./u);
    if (moves && replaces) return "raid-move-replace";
    if (moves) return "raid-move-front";
    if (has(/\.raidtrigger\.raid(?:\.|$)/u) || has(/resolution-raidtrigger\.performraid\.true(?:\.|$)/u)) return "raid-stay";
  }
  return null;
}

export function mlActionModelReadiness(model = null, {
  minExamples = 0,
  minTrust = MIN_ML_RUNTIME_TRUST,
  minHeldoutGames = MIN_ML_RUNTIME_HELDOUT_GAMES,
  minPairwiseExamples = MIN_ML_RUNTIME_PAIRWISE_EXAMPLES,
  minPairwiseEffectiveWeightVersion = MIN_ML_PAIRWISE_EFFECTIVE_WEIGHT_VERSION,
  minPairwiseEffectiveWeight = MIN_ML_RUNTIME_PAIRWISE_EFFECTIVE_WEIGHT,
  minEvidenceDiversityVersion = MIN_ML_EVIDENCE_DIVERSITY_VERSION,
  minDiversityExamples = MIN_ML_RUNTIME_DIVERSITY_EXAMPLES,
  minDistinctPhases = MIN_ML_RUNTIME_DISTINCT_PHASES,
  minDistinctActionPairs = MIN_ML_RUNTIME_DISTINCT_ACTION_PAIRS,
  minDistinctOpponents = MIN_ML_RUNTIME_DISTINCT_OPPONENTS,
  maxDominantActionPairRate = MAX_ML_RUNTIME_DOMINANT_ACTION_PAIR_RATE,
  minSourceDigestVersion = MIN_LEARNING_SOURCE_DIGEST_VERSION,
  minLearningEvidenceFilterVersion = MIN_LEARNING_EVIDENCE_FILTER_VERSION,
  minTrainingPipelineVersion = MIN_ML_TRAINING_PIPELINE_VERSION,
  minValidationAssignmentVersion = MIN_ML_VALIDATION_ASSIGNMENT_VERSION,
  minValidationStateVersion = MIN_ML_VALIDATION_STATE_VERSION,
  minValidationDiversityVersion = MIN_ML_VALIDATION_DIVERSITY_VERSION,
  minValidationDistinctPhases = MIN_ML_RUNTIME_VALIDATION_DISTINCT_PHASES,
  minValidationDistinctActionPairs = MIN_ML_RUNTIME_VALIDATION_DISTINCT_ACTION_PAIRS,
  minValidationDistinctOpponents = MIN_ML_RUNTIME_VALIDATION_DISTINCT_OPPONENTS,
  minValidationActionPairExamples = MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_EXAMPLES,
  minValidationActionPairGames = MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_GAMES,
  minValidationActionPairSignExamples = MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_SIGN_EXAMPLES,
  minValidationActionPairAccuracy = MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_ACCURACY,
  minValidationBalancedAccuracy = MIN_ML_RUNTIME_VALIDATION_BALANCED_ACCURACY,
  minValidationPairwiseEffectiveWeight = MIN_ML_RUNTIME_VALIDATION_PAIRWISE_EFFECTIVE_WEIGHT,
  maxValidationDominantActionPairRate = MAX_ML_RUNTIME_VALIDATION_DOMINANT_ACTION_PAIR_RATE,
  minPairwiseInputConsistencyVersion = MIN_ML_PAIRWISE_INPUT_CONSISTENCY_VERSION,
  minValidationConsistencyRepeatedContexts = MIN_ML_RUNTIME_VALIDATION_CONSISTENCY_REPEATED_CONTEXTS,
  minValidationConsistencyRepeatedExamples = MIN_ML_RUNTIME_VALIDATION_CONSISTENCY_REPEATED_EXAMPLES,
  maxValidationInputConflictRate = MAX_ML_RUNTIME_VALIDATION_INPUT_CONFLICT_RATE,
  minPairwiseOrientationVersion = MIN_ML_PAIRWISE_ORIENTATION_VERSION,
  minRegressionVersion = MIN_ML_REGRESSION_VERSION,
  minCounterfactualStateEvaluationVersion = COUNTERFACTUAL_STATE_EVALUATION_VERSION
} = {}) {
  const thresholds = {
    examples: Math.max(0, Number(minExamples ?? 0)),
    signalTrust: Math.max(MIN_ML_RUNTIME_TRUST, Number(minTrust ?? MIN_ML_RUNTIME_TRUST)),
    heldoutPlayerGames: Math.max(MIN_ML_RUNTIME_HELDOUT_GAMES, Number(minHeldoutGames ?? MIN_ML_RUNTIME_HELDOUT_GAMES)),
    pairwiseExamples: Math.max(MIN_ML_RUNTIME_PAIRWISE_EXAMPLES, Number(minPairwiseExamples ?? MIN_ML_RUNTIME_PAIRWISE_EXAMPLES)),
    pairwiseEffectiveWeightVersion: Math.max(
      MIN_ML_PAIRWISE_EFFECTIVE_WEIGHT_VERSION,
      Number(minPairwiseEffectiveWeightVersion ?? MIN_ML_PAIRWISE_EFFECTIVE_WEIGHT_VERSION)
    ),
    pairwiseEffectiveWeight: Math.max(
      MIN_ML_RUNTIME_PAIRWISE_EFFECTIVE_WEIGHT,
      Number(minPairwiseEffectiveWeight ?? MIN_ML_RUNTIME_PAIRWISE_EFFECTIVE_WEIGHT)
    ),
    evidenceDiversityVersion: Math.max(MIN_ML_EVIDENCE_DIVERSITY_VERSION, Number(minEvidenceDiversityVersion ?? MIN_ML_EVIDENCE_DIVERSITY_VERSION)),
    diversityExamples: Math.max(MIN_ML_RUNTIME_DIVERSITY_EXAMPLES, Number(minDiversityExamples ?? MIN_ML_RUNTIME_DIVERSITY_EXAMPLES)),
    distinctPhases: Math.max(MIN_ML_RUNTIME_DISTINCT_PHASES, Number(minDistinctPhases ?? MIN_ML_RUNTIME_DISTINCT_PHASES)),
    distinctActionPairs: Math.max(MIN_ML_RUNTIME_DISTINCT_ACTION_PAIRS, Number(minDistinctActionPairs ?? MIN_ML_RUNTIME_DISTINCT_ACTION_PAIRS)),
    distinctOpponents: Math.max(MIN_ML_RUNTIME_DISTINCT_OPPONENTS, Number(minDistinctOpponents ?? MIN_ML_RUNTIME_DISTINCT_OPPONENTS)),
    maxDominantActionPairRate: Math.min(MAX_ML_RUNTIME_DOMINANT_ACTION_PAIR_RATE, Number(maxDominantActionPairRate ?? MAX_ML_RUNTIME_DOMINANT_ACTION_PAIR_RATE)),
    maxHistoricalUnclassifiedExamples: MAX_ML_RUNTIME_HISTORICAL_UNCLASSIFIED_EXAMPLES,
    sourceDigestVersion: Math.max(MIN_LEARNING_SOURCE_DIGEST_VERSION, Number(minSourceDigestVersion ?? MIN_LEARNING_SOURCE_DIGEST_VERSION)),
    learningEvidenceFilterVersion: Math.max(MIN_LEARNING_EVIDENCE_FILTER_VERSION, Number(minLearningEvidenceFilterVersion ?? MIN_LEARNING_EVIDENCE_FILTER_VERSION)),
    trainingPipelineVersion: Math.max(MIN_ML_TRAINING_PIPELINE_VERSION, Number(minTrainingPipelineVersion ?? MIN_ML_TRAINING_PIPELINE_VERSION)),
    validationAssignmentVersion: Math.max(MIN_ML_VALIDATION_ASSIGNMENT_VERSION, Number(minValidationAssignmentVersion ?? MIN_ML_VALIDATION_ASSIGNMENT_VERSION)),
    validationStateVersion: Math.max(MIN_ML_VALIDATION_STATE_VERSION, Number(minValidationStateVersion ?? MIN_ML_VALIDATION_STATE_VERSION)),
    validationDiversityVersion: Math.max(MIN_ML_VALIDATION_DIVERSITY_VERSION, Number(minValidationDiversityVersion ?? MIN_ML_VALIDATION_DIVERSITY_VERSION)),
    validationDistinctPhases: Math.max(MIN_ML_RUNTIME_VALIDATION_DISTINCT_PHASES, Number(minValidationDistinctPhases ?? MIN_ML_RUNTIME_VALIDATION_DISTINCT_PHASES)),
    validationDistinctActionPairs: Math.max(MIN_ML_RUNTIME_VALIDATION_DISTINCT_ACTION_PAIRS, Number(minValidationDistinctActionPairs ?? MIN_ML_RUNTIME_VALIDATION_DISTINCT_ACTION_PAIRS)),
    validationDistinctOpponents: Math.max(MIN_ML_RUNTIME_VALIDATION_DISTINCT_OPPONENTS, Number(minValidationDistinctOpponents ?? MIN_ML_RUNTIME_VALIDATION_DISTINCT_OPPONENTS)),
    validationActionPairExamples: Math.max(MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_EXAMPLES, Number(minValidationActionPairExamples ?? MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_EXAMPLES)),
    validationActionPairGames: Math.max(MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_GAMES, Number(minValidationActionPairGames ?? MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_GAMES)),
    validationActionPairSignExamples: Math.max(MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_SIGN_EXAMPLES, Number(minValidationActionPairSignExamples ?? MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_SIGN_EXAMPLES)),
    validationActionPairAccuracy: Math.max(MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_ACCURACY, Number(minValidationActionPairAccuracy ?? MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_ACCURACY)),
    validationBalancedAccuracy: Math.max(MIN_ML_RUNTIME_VALIDATION_BALANCED_ACCURACY, Number(minValidationBalancedAccuracy ?? MIN_ML_RUNTIME_VALIDATION_BALANCED_ACCURACY)),
    validationPairwiseEffectiveWeight: Math.max(MIN_ML_RUNTIME_VALIDATION_PAIRWISE_EFFECTIVE_WEIGHT, Number(minValidationPairwiseEffectiveWeight ?? MIN_ML_RUNTIME_VALIDATION_PAIRWISE_EFFECTIVE_WEIGHT)),
    maxValidationDominantActionPairRate: Math.min(MAX_ML_RUNTIME_VALIDATION_DOMINANT_ACTION_PAIR_RATE, Number(maxValidationDominantActionPairRate ?? MAX_ML_RUNTIME_VALIDATION_DOMINANT_ACTION_PAIR_RATE)),
    pairwiseInputConsistencyVersion: Math.max(MIN_ML_PAIRWISE_INPUT_CONSISTENCY_VERSION, Number(minPairwiseInputConsistencyVersion ?? MIN_ML_PAIRWISE_INPUT_CONSISTENCY_VERSION)),
    validationConsistencyRepeatedContexts: Math.max(MIN_ML_RUNTIME_VALIDATION_CONSISTENCY_REPEATED_CONTEXTS, Number(minValidationConsistencyRepeatedContexts ?? MIN_ML_RUNTIME_VALIDATION_CONSISTENCY_REPEATED_CONTEXTS)),
    validationConsistencyRepeatedExamples: Math.max(MIN_ML_RUNTIME_VALIDATION_CONSISTENCY_REPEATED_EXAMPLES, Number(minValidationConsistencyRepeatedExamples ?? MIN_ML_RUNTIME_VALIDATION_CONSISTENCY_REPEATED_EXAMPLES)),
    maxValidationInputConflictRate: Math.min(MAX_ML_RUNTIME_VALIDATION_INPUT_CONFLICT_RATE, Number(maxValidationInputConflictRate ?? MAX_ML_RUNTIME_VALIDATION_INPUT_CONFLICT_RATE)),
    pairwiseOrientationVersion: Math.max(MIN_ML_PAIRWISE_ORIENTATION_VERSION, Number(minPairwiseOrientationVersion ?? MIN_ML_PAIRWISE_ORIENTATION_VERSION)),
    regressionVersion: Math.max(MIN_ML_REGRESSION_VERSION, Number(minRegressionVersion ?? MIN_ML_REGRESSION_VERSION)),
    counterfactualStateEvaluationVersion: Math.max(
      COUNTERFACTUAL_STATE_EVALUATION_VERSION,
      Number(minCounterfactualStateEvaluationVersion ?? COUNTERFACTUAL_STATE_EVALUATION_VERSION)
    )
  };
  const evidenceDiversity = mlPairwiseEvidenceDiversity(model ?? {});
  const validationDiversity = mlValidationEvidenceDiversity(model ?? {});
  const validationInputConsistency = mlValidationInputConsistency(model ?? {});
  const supportedValidationActionPairs = validationDiversity.actionPairReliability
    .filter((row) => row.examples >= thresholds.validationActionPairExamples);
  const weakValidationActionPairs = supportedValidationActionPairs
    .filter((row) => row.signAccuracy < thresholds.validationActionPairAccuracy);
  const singleGameValidationActionPairs = supportedValidationActionPairs
    .filter((row) => row.distinctPlayerGames < thresholds.validationActionPairGames);
  const oneSidedValidationActionPairs = supportedValidationActionPairs
    .filter((row) => (
      row.positiveExamples < thresholds.validationActionPairSignExamples
      || row.negativeExamples < thresholds.validationActionPairSignExamples
    ));
  const summary = {
    examples: Number(model?.examples ?? 0),
    learningSignalVersion: Number(model?.learningSignalVersion ?? 0),
    trainingPipelineVersion: Number(model?.trainingPipelineVersion ?? 1),
    validationAssignmentVersion: Number(model?.validationAssignmentVersion ?? model?.validation?.assignmentKeyVersion ?? 1),
    validationStateVersion: Number(model?.validationStateVersion ?? 0),
    pairwiseOrientationVersion: Number(model?.pairwiseOrientationVersion ?? 1),
    regressionVersion: Number(model?.regressionVersion ?? 1),
    featureSelectionVersion: Number(model?.featureSelection?.version ?? 0),
    contextualFeatureSelection: model?.featureSelection ?? null,
    counterfactualStateEvaluationVersion: Number(model?.counterfactualStateEvaluationVersion ?? 1),
    learningSignalTrust: Number(model?.learningSignalTrust ?? 0),
    heldoutGames: Number(model?.validation?.heldoutPlayerGames ?? 0),
    validationFraction: Number(model?.validation?.fraction ?? 0),
    validationPairwiseExamples: Number(model?.validation?.pairwise?.examples ?? 0),
    validationPairwiseEffectiveWeight: Number(model?.validation?.pairwise?.weightTotal ?? 0),
    validationPairwisePositiveExamples: Number(model?.validation?.pairwise?.positiveExamples ?? 0),
    validationPairwiseNegativeExamples: Number(model?.validation?.pairwise?.negativeExamples ?? 0),
    validationPairwiseBalancedAccuracy: Number(model?.validation?.pairwise?.balancedSignAccuracy),
    pairwiseExamples: Number(model?.pairwiseExamples ?? 0),
    pairwiseEffectiveWeightVersion: Number(model?.pairwiseEffectiveWeightVersion ?? 0),
    pairwiseEffectiveWeight: Number(model?.pairwiseEffectiveWeight ?? 0),
    evidenceDiversity,
    validationDiversity,
    validationInputConsistency,
    supportedValidationActionPairs: supportedValidationActionPairs.length,
    weakValidationActionPairs: weakValidationActionPairs.length,
    singleGameValidationActionPairs: singleGameValidationActionPairs.length,
    oneSidedValidationActionPairs: oneSidedValidationActionPairs.length
  };
  summary.sourceDigestVersion = Number(model?.sourceDigestVersion ?? 0);
  summary.learningEvidenceFilterVersion = Number(model?.learningEvidenceFilterVersion ?? 0);
  const failures = [];
  const fail = (status, message) => failures.push({ status, message });
  if (!model) fail("missing", "profile action model missing");
  if (model) {
    const healthStatus = String(model.learningHealth?.status ?? model.learningHealthStatus ?? "").toLowerCase();
    const samplingStatus = String(model.samplingSafety?.status ?? model.learningHealth?.samplingSafety?.status ?? "").toLowerCase();
    if (healthStatus === "blocked" || samplingStatus === "blocked") {
      fail("blocked", samplingStatus === "blocked"
        ? "profile action model sampling safety is blocked"
        : "profile action model learning health is blocked");
    }
    if (model.includeChosenAnchor === true) {
      fail("unsafe-outcome-anchor", "profile action model contains experimental raw outcome anchors");
    }
    if (summary.learningSignalVersion < 2) fail("stale", "profile action model uses legacy learning signals");
    if (summary.trainingPipelineVersion < thresholds.trainingPipelineVersion) {
      fail("stale-pipeline", `profile action model training pipeline is ${summary.trainingPipelineVersion}/${thresholds.trainingPipelineVersion}`);
    }
    if (summary.sourceDigestVersion < thresholds.sourceDigestVersion) {
      fail("stale-source-digest", `profile action model source digest is ${summary.sourceDigestVersion}/${thresholds.sourceDigestVersion}`);
    }
    if (summary.learningEvidenceFilterVersion < thresholds.learningEvidenceFilterVersion) {
      fail("stale-evidence-filter", `profile action model learning evidence filter is ${summary.learningEvidenceFilterVersion}/${thresholds.learningEvidenceFilterVersion}`);
    }
    if (summary.validationAssignmentVersion < thresholds.validationAssignmentVersion) {
      fail("stale-validation", `profile action model validation assignment is ${summary.validationAssignmentVersion}/${thresholds.validationAssignmentVersion}`);
    }
    if (summary.validationStateVersion < thresholds.validationStateVersion) {
      fail("stale-validation-state", `profile action model cumulative validation state is ${summary.validationStateVersion}/${thresholds.validationStateVersion}`);
    }
    if (validationInputConsistency.version < thresholds.pairwiseInputConsistencyVersion) {
      fail("stale-input-consistency", `profile action model pairwise-input consistency is ${validationInputConsistency.version}/${thresholds.pairwiseInputConsistencyVersion}`);
    }
    if (!validationInputConsistency.complete) {
      fail("incomplete-input-consistency", "profile action model did not retain complete held-out pairwise-input consistency evidence");
    }
    const consistencyGateEligible = validationInputConsistency.repeatedContexts >= thresholds.validationConsistencyRepeatedContexts
      && validationInputConsistency.repeatedExamples >= thresholds.validationConsistencyRepeatedExamples;
    if (consistencyGateEligible && validationInputConsistency.conflictRate > thresholds.maxValidationInputConflictRate) {
      fail(
        "conflicting-pairwise-inputs",
        `held-out pairwise inputs contain ${(validationInputConsistency.conflictRate * 100).toFixed(1)}% irreducible minority weight; maximum is ${(thresholds.maxValidationInputConflictRate * 100).toFixed(1)}%`
      );
    }
    if (summary.pairwiseOrientationVersion < thresholds.pairwiseOrientationVersion) {
      fail("stale-pairwise", `profile action model pairwise orientation is ${summary.pairwiseOrientationVersion}/${thresholds.pairwiseOrientationVersion}`);
    }
    if (summary.regressionVersion < thresholds.regressionVersion) {
      fail("stale-regression", `profile action model regression solver is ${summary.regressionVersion}/${thresholds.regressionVersion}`);
    }
    if (!boundedContextualFeatureSelectionValid(model)) {
      fail("unsafe-feature-selection", `profile action model has unbounded or inconsistent card-specific features (selection v${summary.featureSelectionVersion}/${MIN_ML_FEATURE_SELECTION_VERSION})`);
    }
    if (summary.counterfactualStateEvaluationVersion < thresholds.counterfactualStateEvaluationVersion) {
      fail("stale-evaluator", `profile action model state evaluator is ${summary.counterfactualStateEvaluationVersion}/${thresholds.counterfactualStateEvaluationVersion}`);
    }
    if (summary.examples < thresholds.examples) {
      fail("low-examples", `profile action model has ${summary.examples}/${thresholds.examples} required examples`);
    }
    if (summary.learningSignalTrust < thresholds.signalTrust) {
      fail("low-trust", `profile action model trust ${summary.learningSignalTrust.toFixed(3)} is below ${thresholds.signalTrust.toFixed(3)}`);
    }
    if (summary.heldoutGames < thresholds.heldoutPlayerGames) {
      fail("low-validation", `profile action model has ${summary.heldoutGames}/${thresholds.heldoutPlayerGames} required held-out player-games`);
    }
    if (summary.validationFraction <= 0) {
      fail("disabled-validation", "profile action model was trained with held-out validation disabled");
    }
    if (summary.validationPairwiseExamples < thresholds.pairwiseExamples) {
      fail("low-pairwise-validation", `profile action model has ${summary.validationPairwiseExamples}/${thresholds.pairwiseExamples} required held-out pairwise comparisons`);
    }
    if (summary.validationPairwiseEffectiveWeight < thresholds.validationPairwiseEffectiveWeight) {
      fail("low-pairwise-validation-mass", `held-out pairwise evidence has ${summary.validationPairwiseEffectiveWeight.toFixed(3)}/${thresholds.validationPairwiseEffectiveWeight.toFixed(3)} required effective weight`);
    }
    if (summary.validationPairwisePositiveExamples < 3 || summary.validationPairwiseNegativeExamples < 3) {
      fail("one-sided-pairwise-validation", `held-out pairwise evidence has ${summary.validationPairwisePositiveExamples} positive and ${summary.validationPairwiseNegativeExamples} negative target(s)`);
    }
    if (!Number.isFinite(summary.validationPairwiseBalancedAccuracy)
      || summary.validationPairwiseBalancedAccuracy < thresholds.validationBalancedAccuracy) {
      const accuracyText = Number.isFinite(summary.validationPairwiseBalancedAccuracy)
        ? `${(summary.validationPairwiseBalancedAccuracy * 100).toFixed(1)}%`
        : "unavailable";
      fail("weak-pairwise-validation", `held-out balanced directional accuracy is ${accuracyText}; requires ${(thresholds.validationBalancedAccuracy * 100).toFixed(1)}%`);
    }
    if (summary.pairwiseExamples < thresholds.pairwiseExamples) {
      fail("low-pairwise", `profile action model has ${summary.pairwiseExamples}/${thresholds.pairwiseExamples} required pairwise examples`);
    }
    if (summary.pairwiseEffectiveWeightVersion < thresholds.pairwiseEffectiveWeightVersion) {
      fail(
        "stale-pairwise-mass",
        `profile action model effective pairwise weight is unversioned (${summary.pairwiseEffectiveWeightVersion}/${thresholds.pairwiseEffectiveWeightVersion})`
      );
    }
    if (summary.pairwiseEffectiveWeight < thresholds.pairwiseEffectiveWeight) {
      fail(
        "low-pairwise-mass",
        `profile action model has ${summary.pairwiseEffectiveWeight.toFixed(3)}/${thresholds.pairwiseEffectiveWeight.toFixed(3)} required effective pairwise weight`
      );
    }
    if (evidenceDiversity.version < thresholds.evidenceDiversityVersion) {
      fail("stale-diversity", `profile action model evidence diversity is ${evidenceDiversity.version}/${thresholds.evidenceDiversityVersion}`);
    }
    if (evidenceDiversity.historicalUnclassifiedExamples > thresholds.maxHistoricalUnclassifiedExamples) {
      fail(
        "unclassified-evidence",
        `profile action model contains ${evidenceDiversity.historicalUnclassifiedExamples} historical pairwise example(s) without diversity classification; rebuild from retained source logs`
      );
    }
    if (evidenceDiversity.trackedExamples < thresholds.diversityExamples) {
      fail("low-diversity-examples", `profile action model has ${evidenceDiversity.trackedExamples}/${thresholds.diversityExamples} diversity-tracked pairwise examples`);
    }
    if (evidenceDiversity.distinctPhases < thresholds.distinctPhases) {
      fail("narrow-phase-diversity", `profile action model covers ${evidenceDiversity.distinctPhases}/${thresholds.distinctPhases} required decision phases`);
    }
    if (evidenceDiversity.distinctActionPairs < thresholds.distinctActionPairs) {
      fail("narrow-action-diversity", `profile action model covers ${evidenceDiversity.distinctActionPairs}/${thresholds.distinctActionPairs} required action-pair families`);
    }
    if (evidenceDiversity.distinctOpponentProfiles < thresholds.distinctOpponents) {
      fail("narrow-opponent-diversity", `profile action model covers ${evidenceDiversity.distinctOpponentProfiles}/${thresholds.distinctOpponents} required opponent archetypes`);
    }
    if (evidenceDiversity.dominantActionPairRate > thresholds.maxDominantActionPairRate) {
      fail(
        "concentrated-action-pairs",
        `profile action model's dominant action pair is ${(evidenceDiversity.dominantActionPairRate * 100).toFixed(1)}% of evidence; maximum is ${(thresholds.maxDominantActionPairRate * 100).toFixed(1)}%`
      );
    }
    if (validationDiversity.version < thresholds.validationDiversityVersion) {
      fail("stale-validation-diversity", "profile action model held-out evidence lacks phase, action-pair, and opponent classification");
    }
    if (validationDiversity.distinctPlayerGames < thresholds.heldoutPlayerGames) {
      fail("narrow-validation-game-diversity", `retained held-out evidence covers ${validationDiversity.distinctPlayerGames}/${thresholds.heldoutPlayerGames} required player-games`);
    }
    if (validationDiversity.distinctPhases < thresholds.validationDistinctPhases) {
      fail("narrow-validation-phase-diversity", `held-out evidence covers ${validationDiversity.distinctPhases}/${thresholds.validationDistinctPhases} required decision phases`);
    }
    if (validationDiversity.distinctActionPairs < thresholds.validationDistinctActionPairs) {
      fail("narrow-validation-action-diversity", `held-out evidence covers ${validationDiversity.distinctActionPairs}/${thresholds.validationDistinctActionPairs} required action-pair families`);
    }
    if (validationDiversity.distinctOpponentProfiles < thresholds.validationDistinctOpponents) {
      fail("narrow-validation-opponent-diversity", `held-out evidence covers ${validationDiversity.distinctOpponentProfiles}/${thresholds.validationDistinctOpponents} required opponent archetypes`);
    }
    if (validationDiversity.trackedExamples > 0
      && validationDiversity.dominantActionPairRate > thresholds.maxValidationDominantActionPairRate) {
      fail("concentrated-validation-action-pairs", `held-out evidence's dominant action pair is ${(validationDiversity.dominantActionPairRate * 100).toFixed(1)}%; maximum is ${(thresholds.maxValidationDominantActionPairRate * 100).toFixed(1)}%`);
    }
    if (supportedValidationActionPairs.length < thresholds.validationDistinctActionPairs) {
      fail("sparse-validation-action-pairs", `held-out evidence has ${supportedValidationActionPairs.length}/${thresholds.validationDistinctActionPairs} action-pair families with at least ${thresholds.validationActionPairExamples} examples`);
    }
    if (weakValidationActionPairs.length > 0) {
      fail("weak-validation-action-pair", `at least one supported held-out action family is below ${(thresholds.validationActionPairAccuracy * 100).toFixed(1)}% directional accuracy`);
    }
    if (singleGameValidationActionPairs.length > 0) {
      fail("single-game-validation-action-pair", `at least one supported held-out action family appears in fewer than ${thresholds.validationActionPairGames} player-games`);
    }
    if (oneSidedValidationActionPairs.length > 0) {
      fail("one-sided-validation-action-pair", `at least one supported held-out action family lacks both positive and negative oriented comparisons`);
    }
    if (failures.length === 0 && mlActionModelRuntimeTrust(model) <= 0) {
      fail("runtime-inactive", "profile action model does not satisfy the engine runtime trust contract");
    }
  }
  return {
    ready: failures.length === 0,
    status: failures[0]?.status ?? "ready",
    reason: failures[0]?.message ?? "profile action model is ready",
    blockers: failures.map((failure) => failure.message),
    blockerCodes: failures.map((failure) => failure.status),
    runtimeTrust: model ? mlActionModelRuntimeTrust(model) : 0,
    thresholds,
    ...summary
  };
}

export function matchupOverlayReadiness(overlay = null, {
  requireImpactValidation = true,
  minTrust = MIN_ML_RUNTIME_TRUST,
  minPairwiseExamples = MIN_MATCHUP_RUNTIME_PAIRWISE_EXAMPLES,
  minPairwiseEffectiveWeight = MIN_MATCHUP_RUNTIME_PAIRWISE_EFFECTIVE_WEIGHT,
  minDiversityExamples = MIN_MATCHUP_RUNTIME_DIVERSITY_EXAMPLES,
  minDistinctPhases = MIN_MATCHUP_RUNTIME_DISTINCT_PHASES,
  minDistinctActionPairs = MIN_MATCHUP_RUNTIME_DISTINCT_ACTION_PAIRS,
  maxDominantActionPairRate = MAX_MATCHUP_RUNTIME_DOMINANT_ACTION_PAIR_RATE
} = {}) {
  const thresholds = {
    signalTrust: Math.max(MIN_ML_RUNTIME_TRUST, Number(minTrust ?? MIN_ML_RUNTIME_TRUST)),
    pairwiseExamples: Math.max(MIN_MATCHUP_RUNTIME_PAIRWISE_EXAMPLES, Number(minPairwiseExamples ?? MIN_MATCHUP_RUNTIME_PAIRWISE_EXAMPLES)),
    pairwiseEffectiveWeightVersion: MIN_ML_PAIRWISE_EFFECTIVE_WEIGHT_VERSION,
    pairwiseEffectiveWeight: Math.max(
      MIN_MATCHUP_RUNTIME_PAIRWISE_EFFECTIVE_WEIGHT,
      Number(minPairwiseEffectiveWeight ?? MIN_MATCHUP_RUNTIME_PAIRWISE_EFFECTIVE_WEIGHT)
    ),
    evidenceDiversityVersion: MIN_ML_EVIDENCE_DIVERSITY_VERSION,
    diversityExamples: Math.max(MIN_MATCHUP_RUNTIME_DIVERSITY_EXAMPLES, Number(minDiversityExamples ?? MIN_MATCHUP_RUNTIME_DIVERSITY_EXAMPLES)),
    distinctPhases: Math.max(MIN_MATCHUP_RUNTIME_DISTINCT_PHASES, Number(minDistinctPhases ?? MIN_MATCHUP_RUNTIME_DISTINCT_PHASES)),
    distinctActionPairs: Math.max(MIN_MATCHUP_RUNTIME_DISTINCT_ACTION_PAIRS, Number(minDistinctActionPairs ?? MIN_MATCHUP_RUNTIME_DISTINCT_ACTION_PAIRS)),
    maxDominantActionPairRate: Math.min(
      MAX_MATCHUP_RUNTIME_DOMINANT_ACTION_PAIR_RATE,
      Number(maxDominantActionPairRate ?? MAX_MATCHUP_RUNTIME_DOMINANT_ACTION_PAIR_RATE)
    ),
    impactValidationGames: MIN_MATCHUP_IMPACT_VALIDATION_GAMES
  };
  const diversity = matchupPairwiseEvidenceDiversity(overlay ?? {});
  const validation = overlay?.impactValidation ?? null;
  const summary = {
    examples: Number(overlay?.examples ?? 0),
    pairwiseExamples: Number(overlay?.pairwiseExamples ?? 0),
    pairwiseEffectiveWeightVersion: Number(overlay?.pairwiseEffectiveWeightVersion ?? 0),
    pairwiseEffectiveWeight: Number(overlay?.pairwiseEffectiveWeight ?? 0),
    learningSignalTrust: Number(overlay?.learningSignalTrust ?? 0),
    evidenceDiversity: diversity,
    impactValidation: validation
  };
  const failures = [];
  const fail = (status, message) => failures.push({ status, message });
  if (!overlay) fail("missing", "matchup overlay missing");
  if (overlay) {
    const healthStatus = String(overlay.learningHealth?.status ?? overlay.learningHealthStatus ?? "").toLowerCase();
    const samplingStatus = String(overlay.samplingSafety?.status ?? overlay.learningHealth?.samplingSafety?.status ?? "").toLowerCase();
    if (healthStatus === "blocked" || samplingStatus === "blocked") {
      fail("blocked", samplingStatus === "blocked"
        ? "matchup overlay sampling safety is blocked"
        : "matchup overlay learning health is blocked");
    }
    if (overlay.includeChosenAnchor === true) fail("unsafe-outcome-anchor", "matchup overlay contains experimental raw outcome anchors");
    if (Number(overlay.learningSignalVersion ?? 1) < 2) fail("stale", "matchup overlay uses legacy learning signals");
    if (Number(overlay.trainingPipelineVersion ?? 1) < MIN_ML_TRAINING_PIPELINE_VERSION) fail("stale-pipeline", "matchup overlay uses the legacy training pipeline");
    if (Number(overlay.sourceDigestVersion ?? 0) < MIN_LEARNING_SOURCE_DIGEST_VERSION) fail("stale-source-digest", "matchup overlay lacks source-content digest accounting");
    if (Number(overlay.learningEvidenceFilterVersion ?? 0) < MIN_LEARNING_EVIDENCE_FILTER_VERSION) fail("stale-evidence-filter", "matchup overlay lacks the current evidence deduplication filter");
    if (Number(overlay.regressionVersion ?? 1) < MIN_ML_REGRESSION_VERSION) fail("stale-regression", "matchup overlay uses the legacy regression solver");
    if (!boundedContextualFeatureSelectionValid(overlay)) fail("unsafe-feature-selection", "matchup overlay has unbounded or inconsistent card-specific features");
    if (Number(overlay.counterfactualStateEvaluationVersion ?? 1) < COUNTERFACTUAL_STATE_EVALUATION_VERSION) fail("stale-evaluator", "matchup overlay uses stale nonterminal counterfactual labels");
    if (summary.learningSignalTrust < thresholds.signalTrust) fail("low-trust", `matchup overlay trust ${summary.learningSignalTrust.toFixed(3)} is below ${thresholds.signalTrust.toFixed(3)}`);
    if (summary.pairwiseExamples < thresholds.pairwiseExamples) fail("low-pairwise", `matchup overlay has ${summary.pairwiseExamples}/${thresholds.pairwiseExamples} required causal pairs`);
    if (summary.pairwiseEffectiveWeightVersion < thresholds.pairwiseEffectiveWeightVersion) fail("stale-pairwise-mass", "matchup overlay lacks complete effective pairwise-weight accounting");
    if (summary.pairwiseEffectiveWeight < thresholds.pairwiseEffectiveWeight) fail("low-pairwise-mass", `matchup overlay has ${summary.pairwiseEffectiveWeight.toFixed(3)}/${thresholds.pairwiseEffectiveWeight.toFixed(3)} required effective pairwise weight`);
    if (diversity.version < thresholds.evidenceDiversityVersion) fail("stale-diversity", "matchup overlay lacks current causal-evidence diversity accounting");
    if (diversity.historicalUnclassifiedExamples > MAX_ML_RUNTIME_HISTORICAL_UNCLASSIFIED_EXAMPLES) fail("unclassified-evidence", `matchup overlay contains ${diversity.historicalUnclassifiedExamples} unclassified historical pair(s)`);
    if (diversity.trackedExamples < thresholds.diversityExamples) fail("low-diversity-examples", `matchup overlay has ${diversity.trackedExamples}/${thresholds.diversityExamples} diversity-tracked causal pairs`);
    if (diversity.distinctPhases < thresholds.distinctPhases) fail("narrow-phase-diversity", `matchup overlay covers ${diversity.distinctPhases}/${thresholds.distinctPhases} required decision phases`);
    if (diversity.distinctActionPairs < thresholds.distinctActionPairs) fail("narrow-action-diversity", `matchup overlay covers ${diversity.distinctActionPairs}/${thresholds.distinctActionPairs} required action-pair families`);
    if (diversity.dominantActionPairRate > thresholds.maxDominantActionPairRate) fail("concentrated-action-pairs", `matchup overlay's dominant action pair is ${(diversity.dominantActionPairRate * 100).toFixed(1)}% of causal evidence`);
    if (requireImpactValidation) {
      if (String(validation?.verdict ?? "").toLowerCase() !== "positive") fail("unvalidated", "matchup overlay has not passed paired gameplay validation");
      else if (Number(validation?.pairedGames ?? 0) < thresholds.impactValidationGames) fail("low-impact-validation", `matchup overlay has ${Number(validation?.pairedGames ?? 0)}/${thresholds.impactValidationGames} required paired validation games`);
      else if (validation?.artifactSignature !== matchupOverlayArtifactSignature(overlay)) fail("stale-impact-validation", "matchup overlay changed after its paired gameplay validation");
    }
    if (failures.length === 0 && matchupOverlayRuntimeTrust(overlay, { allowUnvalidated: !requireImpactValidation }) <= 0) {
      fail("runtime-inactive", "matchup overlay does not satisfy the engine runtime trust contract");
    }
  }
  return {
    ready: failures.length === 0,
    status: failures[0]?.status ?? "ready",
    reason: failures[0]?.message ?? "matchup overlay is ready",
    blockers: failures.map((failure) => failure.message),
    blockerCodes: failures.map((failure) => failure.status),
    runtimeTrust: overlay ? matchupOverlayRuntimeTrust(overlay, { allowUnvalidated: !requireImpactValidation }) : 0,
    thresholds,
    ...summary
  };
}

export function pilotPolicyFeatureGroup(feature) {
  const name = String(feature ?? "");
  if (name === "baseScore") return "constant";
  if (name.startsWith("context.")) {
    const [, family, , actionId] = name.split(".");
    if (family === "setup") return "setup";
    if (family === "attack") return "attack";
    if (family === "block") return "block";
    if (family === "ability") return "ability";
    if (family === "raid") return "raid";
    if (family === "move") return "movement";
    if (family === "play") return "development";
    if (family === "discard") return "sequencing";
    if (family === "choice") {
      if (actionId === "raid") return "raid";
      if (actionId === "play") return "development";
      return "ability";
    }
  }
  if (name.startsWith("setup")) return "setup";
  if (/^(attack|snipe|pass|attacker|lethalAttack|damageThreat|lifePressure|openLane|forceBlock|lowLifePressure|removalTarget)/u.test(name)) return "attack";
  if (/^(block|decline|savedDamage|safeDecline|lowLifeDecline|preserveFrontLine|desperateBlock|earlyChump|lethalBlock|favorableBlock|highValueBlocker|impactLeak|damageTaken)/u.test(name)) return "block";
  if (/^(activateMain|ability)/u.test(name)) return "ability";
  if (/^(performRaid|raid|moveRaid|playRaid)/u.test(name)) return "raid";
  if (name.startsWith("role")) return "role";
  if (/^(moveTo|moved|lineCrowding)/u.test(name)) return "movement";
  if (/^(play|earlyEnergy|energyShortage|lowCostUnit|highBpUnit|event)/u.test(name)) return "development";
  return "sequencing";
}

export function mutablePolicyFeatureGroups(weights = {}) {
  const groups = new Map();
  for (const feature of Object.keys(weights)) {
    const group = pilotPolicyFeatureGroup(feature);
    if (group === "constant") continue;
    const features = groups.get(group) ?? [];
    features.push(feature);
    groups.set(group, features);
  }
  return groups;
}

export function mutatePilotPolicyWeights(weights = {}, rng, {
  mutationScale = 80,
  mutationRate = 0.35,
  groupsPerChild = 2,
  maxFeatures = 12
} = {}) {
  if (typeof rng !== "function") throw new TypeError("mutatePilotPolicyWeights requires a seeded RNG function.");
  const nextWeights = { ...weights };
  const groups = mutablePolicyFeatureGroups(weights);
  const selectedGroups = shuffled([...groups.keys()], rng).slice(0, Math.min(groups.size, Math.max(1, groupsPerChild)));
  const candidates = shuffled(selectedGroups.flatMap((group) => groups.get(group) ?? []), rng);
  let selectedFeatures = candidates
    .filter(() => rng() < mutationRate)
    .slice(0, Math.max(1, maxFeatures));
  if (selectedFeatures.length === 0 && candidates.length > 0) selectedFeatures = [candidates[0]];
  for (const feature of selectedFeatures) {
    let delta = Math.round(normalish(rng) * mutationScale);
    if (delta === 0) delta = rng() < 0.5 ? -1 : 1;
    nextWeights[feature] = clamp(Math.round(Number(nextWeights[feature] ?? 0) + delta), -1600, 1600);
  }
  return {
    weights: nextWeights,
    selectedGroups,
    selectedFeatures
  };
}

export function counterfactualAlternativeRows(group = [], chosen = null) {
  if (!chosen) return [];
  const rawAlternativeIndex = chosen.counterfactualAlternativeIndex;
  const alternativeIndex = Number(rawAlternativeIndex);
  if (rawAlternativeIndex !== null && rawAlternativeIndex !== undefined
    && Number.isInteger(alternativeIndex) && alternativeIndex >= 0) {
    return group.filter((row) => !row.chosen && Number(row.actionIndex) === alternativeIndex);
  }

  const expectedSignature = actionSignature(chosen.counterfactualAlternativeAction);
  if (!expectedSignature) return [];
  const matches = group.filter((row) => !row.chosen && actionSignature(row.action) === expectedSignature);
  return matches.length === 1 ? matches : [];
}

export function counterfactualTestedActionFamilies(group = [], chosen = null) {
  const selected = chosen ?? group.find((row) => row?.chosen) ?? null;
  if (!selected) return [];
  const evidenceKind = String(
    selected.counterfactualEvidenceKind ?? selected.counterfactual?.evidenceKind ?? ""
  ).toLowerCase();
  const evaluatorVersion = Number(
    selected.counterfactualStateEvaluationVersion ?? selected.counterfactual?.stateEvaluationVersion ?? 0
  );
  if (!evidenceKind) return [];
  if (evidenceKind !== "terminal-winner-change"
    && evaluatorVersion < COUNTERFACTUAL_STATE_EVALUATION_VERSION) return [];

  let alternatives = counterfactualAlternativeRows(group, selected);
  if (alternatives.length === 0 && selected.counterfactualAlternativeAction) {
    alternatives = [{ action: selected.counterfactualAlternativeAction }];
  }
  return [...new Set(alternatives
    .map((row) => pairwiseActionFamily(row))
    .filter((family) => family && family !== "unknown"))];
}

export function selectDecisionLogCandidates(candidates = [], {
  maxCandidates = 24,
  counterfactualAlternativeIndex = null,
  requiredCandidateFilter = null,
  maxRequiredCandidates = 2
} = {}) {
  const limit = Math.max(1, Number(maxCandidates ?? 24));
  const sorted = [...candidates]
    .sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0) || Number(a.index ?? 0) - Number(b.index ?? 0));
  const chosen = candidates.find((candidate) => candidate.chosen) ?? null;
  const counterfactualAlternative = Number.isInteger(counterfactualAlternativeIndex)
    ? candidates.find((candidate) => Number(candidate.index) === counterfactualAlternativeIndex) ?? null
    : null;
  const requiredByFilter = typeof requiredCandidateFilter === "function"
    ? sorted
      .filter((candidate) => candidate && !candidate.chosen && requiredCandidateFilter(candidate))
      .slice(0, Math.max(0, Number(maxRequiredCandidates ?? 2)))
    : [];
  const required = [...new Set([chosen, counterfactualAlternative, ...requiredByFilter].filter(Boolean))];
  const optional = sorted
    .filter((candidate) => !required.includes(candidate))
    .slice(0, Math.max(0, limit - required.length));
  return [...required, ...optional]
    .sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
}

export function provisionalActionLearningEligible({
  knowledgeMode,
  learningHealth,
  model
} = {}) {
  if (!["action", "full"].includes(knowledgeMode) || !model) return false;
  if (learningHealth?.status === "blocked") return false;
  if (Number(model.learningSignalVersion ?? 1) < 2 || Number(model.examples ?? 0) <= 0) return false;
  const newSourceCount = Array.isArray(model.newSourceFiles)
    ? model.newSourceFiles.length
    : Number(model.newSourceFiles ?? 0);
  if (!Number.isFinite(newSourceCount) || newSourceCount <= 0) return false;
  return mlActionModelRuntimeTrust(model) === 0;
}

export function knowledgeArtifactValidationPlan({
  knowledgeMode = "full",
  model = null,
  overlayChanges = null,
  actionRuntimeBehaviorChanged = null
} = {}) {
  const actionModeEnabled = knowledgeMode === "action" || knowledgeMode === "full";
  const overlayModeEnabled = knowledgeMode === "matchup" || knowledgeMode === "full";
  const actionChanged = actionModeEnabled && Number(model?.newSourceFiles ?? 0) > 0;
  const actionRuntimeReady = actionChanged && Number(
    model?.runtimeTrust ?? mlActionModelRuntimeTrust(model)
  ) > 0;
  const actionBehaviorChanged = actionRuntimeReady && actionRuntimeBehaviorChanged !== false;
  const activeOverlayChanges = overlayModeEnabled
    ? Number(overlayChanges?.created ?? 0) + Number(overlayChanges?.updated ?? 0)
    : 0;
  const candidateOverlayChanges = overlayModeEnabled
    ? Number(overlayChanges?.candidateCreated ?? 0) + Number(overlayChanges?.candidateUpdated ?? 0)
    : 0;
  const activeOverlayChanged = activeOverlayChanges > 0;
  const candidateOverlayChanged = candidateOverlayChanges > 0;
  const inactiveActionChanged = actionChanged && !actionRuntimeReady;
  const runtimeNeutralActionChanged = actionRuntimeReady && !actionBehaviorChanged;
  const inactiveEvidenceChanged = inactiveActionChanged || runtimeNeutralActionChanged || candidateOverlayChanged;
  const target = actionBehaviorChanged && activeOverlayChanged
    ? "full"
    : actionBehaviorChanged
      ? "action"
      : activeOverlayChanged ? "overlay" : "none";

  let reason;
  if (target === "full") {
    reason = "Action-model and matchup-overlay runtime candidates changed; validating both layers in one paired three-variant review.";
  } else if (target === "action") {
    reason = "Only the runtime-ready action model changed; matchup overlays remain held constant.";
  } else if (target === "overlay") {
    reason = inactiveActionChanged
      ? "The matchup overlay changed while new action-model evidence remains runtime-inactive; validating only the overlay."
      : "Only the matchup-overlay runtime candidate changed; policy and action model remain held constant.";
  } else if (inactiveEvidenceChanged) {
    const parts = [];
    if (inactiveActionChanged) parts.push("action-model evidence remains below runtime readiness");
    if (runtimeNeutralActionChanged) parts.push("action-model evidence did not change effective runtime weights");
    if (candidateOverlayChanged) parts.push("matchup evidence is still accumulating in the inactive candidate store");
    reason = `Skipped paired gameplay validation because ${parts.join(" and ")}; no gameplay behavior changed.`;
  } else {
    reason = "Skipped paired gameplay validation because the knowledge update did not change any runtime artifact.";
  }

  return {
    target,
    actionChanged,
    actionRuntimeReady,
    actionBehaviorChanged,
    inactiveActionChanged,
    runtimeNeutralActionChanged,
    activeOverlayChanged,
    activeOverlayChanges,
    candidateOverlayChanged,
    candidateOverlayChanges,
    inactiveEvidenceChanged,
    reason
  };
}

function countBy(rows, keyFn) {
  const counts = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function shuffled(values, rng) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function normalish(rng) {
  let total = 0;
  for (let index = 0; index < 6; index += 1) total += rng();
  return total - 3;
}

function actionSignature(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) return null;
  return JSON.stringify(Object.fromEntries(Object.entries(action)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))));
}

function stableLearningValue(value) {
  if (Array.isArray(value)) return value.map(stableLearningValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => [key, stableLearningValue(value[key])]));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
