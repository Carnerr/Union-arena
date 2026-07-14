#!/usr/bin/env node
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import {
  COUNTERFACTUAL_STATE_EVALUATION_VERSION,
  DEFAULT_CONTEXTUAL_MIN_OBSERVATIONS,
  DEFAULT_LINEAR_MODEL_MAX_FEATURES,
  MIN_LEARNING_EVIDENCE_FILTER_VERSION,
  MIN_LEARNING_SOURCE_DIGEST_VERSION,
  MIN_ML_EVIDENCE_DIVERSITY_VERSION,
  MIN_ML_FEATURE_SELECTION_VERSION,
  MIN_ML_PAIRWISE_EFFECTIVE_WEIGHT_VERSION,
  MIN_ML_PAIRWISE_INPUT_CONSISTENCY_VERSION,
  MIN_ML_PAIRWISE_ORIENTATION_VERSION,
  MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_ACCURACY,
  MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_EXAMPLES,
  MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_GAMES,
  MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_SIGN_EXAMPLES,
  MIN_ML_RUNTIME_VALIDATION_DISTINCT_ACTION_PAIRS,
  MIN_ML_RUNTIME_VALIDATION_DISTINCT_OPPONENTS,
  MIN_ML_RUNTIME_VALIDATION_DISTINCT_PHASES,
  MIN_ML_RUNTIME_VALIDATION_PAIRWISE_EFFECTIVE_WEIGHT,
  MIN_ML_RUNTIME_CONTEXTUAL_FEATURE_OBSERVATIONS,
  MIN_ML_RUNTIME_HELDOUT_GAMES,
  MAX_ML_RUNTIME_VALIDATION_DOMINANT_ACTION_PAIR_RATE,
  MAX_ML_RUNTIME_VALIDATION_INPUT_CONFLICT_RATE,
  MIN_ML_RUNTIME_VALIDATION_CONSISTENCY_REPEATED_CONTEXTS,
  MIN_ML_RUNTIME_VALIDATION_CONSISTENCY_REPEATED_EXAMPLES,
  MIN_ML_VALIDATION_DIVERSITY_VERSION,
  MIN_ML_VALIDATION_STATE_VERSION,
  MULTIVARIATE_RIDGE_VERSION,
  ML_ACTION_MODEL_SCHEMA,
  addLinearFeatureExample,
  counterfactualAlternativeRows,
  counterfactualPairwiseLearningEvidence,
  createLearningEvidenceFilter,
  createLearningSamplingSafetyLedger,
  learningDecisionGroupFingerprint,
  learningEvidenceFilterAdd,
  learningEvidenceFilterHas,
  learningEvidenceFilterStats,
  isLearningGameTelemetry,
  learningHealthWithSamplingSafety,
  learningValidationGameKey,
  linearFeatureAccumulatorMap,
  linearFeatureCrossMap,
  normalizeMlActionModel,
  pairwiseEvidenceDiversityKeys,
  pairwiseInputConsistencySummary,
  recordLearningSamplingTelemetry,
  serializeLearningEvidenceFilter,
  summarizeLearningSamplingSafety,
  fitMultivariateRidge,
  fileContentDigest,
  writeJsonAtomicSync
} from "../src/index.js";

const LEARNING_SIGNAL_VERSION = 2;
const TRAINING_PIPELINE_VERSION = 2;
const VALIDATION_ASSIGNMENT_VERSION = 2;
const ACTION_EVIDENCE_FILTER_INITIAL_CAPACITY = 131_072;

const inputs = inputPaths();
const outPath = option("--out") ?? "work/private/pilot-agent/current-action-model.json";
const scale = Number(option("--scale") ?? 120);
const l2 = Number(option("--l2") ?? 8);
const minObservations = Number(option("--min-observations") ?? 12);
const minContextualObservations = Math.max(minObservations, Number(
  option("--min-contextual-observations") ?? DEFAULT_CONTEXTUAL_MIN_OBSERVATIONS
));
const maxWeight = Number(option("--max-weight") ?? 260);
const maxModelFeatures = Math.max(1, Math.floor(Number(
  option("--max-model-features") ?? DEFAULT_LINEAR_MODEL_MAX_FEATURES
)));
const playerFilter = option("--player") ?? "all";
const learningMode = normalizeLearningMode(
  option("--learning-mode")
  ?? option("--candidate-mode")
  ?? (hasFlag("--include-unchosen") ? "all" : "pairwise")
);
const pairwiseScale = Number(option("--pairwise-scale") ?? 0.7);
const includeChosenAnchor = learningMode === "selected"
  || learningMode === "all"
  || (!hasFlag("--no-chosen-anchor")
    && (hasFlag("--include-chosen-anchor") || option("--chosen-anchor-scale") !== undefined));
const chosenAnchorScale = Math.max(0, Number(option("--chosen-anchor-scale") ?? 0.25));
const legacyWeightCap = Math.max(0, Number(option("--legacy-weight-cap") ?? 5000));
const validationFraction = clamp(Number(option("--validation-fraction") ?? 0.2), 0, 0.5);
const validationMaxExamples = Math.max(100, Number(option("--validation-max-examples") ?? 5000));
const validationMinTrainingExamples = Math.max(1, Number(option("--validation-min-training-examples") ?? 4));

if (hasFlag("--help") || inputs.length === 0) {
  usage();
  process.exit(inputs.length === 0 ? 1 : 0);
}

const requestedInputFiles = [...new Set(inputs.flatMap(decisionLogFiles))];
if (requestedInputFiles.length === 0) throw new Error(`No decision-log.jsonl files found under: ${inputs.join(", ")}`);
const existingModel = readJsonIfExists(outPath);
const existingIsLegacySignal = Boolean(existingModel && Number(existingModel.learningSignalVersion ?? 1) < LEARNING_SIGNAL_VERSION);
const incrementalRequested = hasFlag("--incremental") && Boolean(existingModel);
const validationStateUpgradeNeeded = Boolean(incrementalRequested
  && Number(existingModel?.validationStateVersion ?? 0) < MIN_ML_VALIDATION_STATE_VERSION);
const diversityUpgradeNeeded = Boolean(incrementalRequested
  && Number(existingModel?.evidenceDiversityVersion ?? existingModel?.pairwiseEvidenceDiversity?.version ?? 0) < MIN_ML_EVIDENCE_DIVERSITY_VERSION);
const effectiveWeightUpgradeNeeded = Boolean(incrementalRequested
  && Number(existingModel?.pairwiseEffectiveWeightVersion ?? 0) < MIN_ML_PAIRWISE_EFFECTIVE_WEIGHT_VERSION);
const regressionUpgradeNeeded = Boolean(incrementalRequested
  && Number(existingModel?.regressionVersion ?? 1) < MULTIVARIATE_RIDGE_VERSION);
const featureSelectionUpgradeNeeded = Boolean(incrementalRequested
  && contextualArtifactEvidencePresent(existingModel)
  && (
    Number(existingModel?.featureSelection?.version ?? 0) < MIN_ML_FEATURE_SELECTION_VERSION
    || Number(existingModel?.minContextualObservations ?? 0) < MIN_ML_RUNTIME_CONTEXTUAL_FEATURE_OBSERVATIONS
  ));
const causalMetadataUpgradeNeeded = diversityUpgradeNeeded || effectiveWeightUpgradeNeeded;
const retainedCausalMetadataSources = causalMetadataUpgradeNeeded || regressionUpgradeNeeded
  ? [...new Set(existingModel?.sourceFiles ?? [])]
      .filter((path) => String(path).endsWith(".jsonl") && existsSync(path) && statSync(path).isFile())
  : [];
const requestedFiles = [...new Set([...retainedCausalMetadataSources, ...requestedInputFiles])];
const incrementalCompatible = !existingModel || (
  String(existingModel.learningMode ?? learningMode) === learningMode
  && Boolean(existingModel.includeChosenAnchor ?? true) === includeChosenAnchor
  && Number(existingModel.pairwiseScale ?? pairwiseScale) === pairwiseScale
  && (existingIsLegacySignal || Number(existingModel.trainingPipelineVersion ?? 1) === TRAINING_PIPELINE_VERSION)
  && (existingIsLegacySignal || Number(existingModel.sourceDigestVersion ?? 0) === MIN_LEARNING_SOURCE_DIGEST_VERSION)
  && (existingIsLegacySignal || Number(existingModel.learningEvidenceFilterVersion ?? 0) === MIN_LEARNING_EVIDENCE_FILTER_VERSION)
  && (existingIsLegacySignal || Number(existingModel.validationAssignmentVersion ?? 1) === VALIDATION_ASSIGNMENT_VERSION)
  && (existingIsLegacySignal
    || Number(existingModel.validationStateVersion ?? 0) === MIN_ML_VALIDATION_STATE_VERSION
    || validationStateUpgradeNeeded)
  && (existingIsLegacySignal || Number(existingModel.pairwiseOrientationVersion ?? 1) === MIN_ML_PAIRWISE_ORIENTATION_VERSION)
  && (existingIsLegacySignal || Number(existingModel.counterfactualStateEvaluationVersion ?? 1) === COUNTERFACTUAL_STATE_EVALUATION_VERSION)
  && Number(existingModel.evidenceDiversityVersion ?? existingModel.pairwiseEvidenceDiversity?.version ?? 0) === MIN_ML_EVIDENCE_DIVERSITY_VERSION
  && Number(existingModel.pairwiseEffectiveWeightVersion ?? 0) === MIN_ML_PAIRWISE_EFFECTIVE_WEIGHT_VERSION
  && Number(existingModel.regressionVersion ?? 1) === MULTIVARIATE_RIDGE_VERSION
);
const incremental = incrementalRequested && (incrementalCompatible || hasFlag("--allow-incompatible-incremental"));
if (incrementalRequested && !incremental) {
  if (diversityUpgradeNeeded) {
    console.log(`Rebuilding ML action-model statistics for evidence-diversity v${MIN_ML_EVIDENCE_DIVERSITY_VERSION}; replaying ${retainedCausalMetadataSources.length} retained source log(s).`);
  }
  if (effectiveWeightUpgradeNeeded) {
    console.log(`Rebuilding ML action-model statistics for effective pairwise-weight v${MIN_ML_PAIRWISE_EFFECTIVE_WEIGHT_VERSION}; replaying ${retainedCausalMetadataSources.length} retained source log(s).`);
  }
  if (regressionUpgradeNeeded) {
    console.log(`Rebuilding ML action-model statistics for regression v${MULTIVARIATE_RIDGE_VERSION}; replaying ${retainedCausalMetadataSources.length} retained source log(s).`);
  }
  console.log("Reset ML action-model statistics because the requested learning configuration differs from the existing model.");
} else if (validationStateUpgradeNeeded) {
  console.log(`Migrating held-out validation state to v${MIN_ML_VALIDATION_STATE_VERSION}; preserving learned training statistics and rebuilding classified validation evidence from new games.`);
}
if (featureSelectionUpgradeNeeded) {
  console.log(`Migrating contextual feature selection to v${MIN_ML_FEATURE_SELECTION_VERSION} with a ${minContextualObservations}-observation support floor; preserving accumulated feature statistics.`);
}
const previousSourceFiles = incremental ? new Set(existingModel.sourceFiles ?? []) : new Set();
const previousSourceContentDigests = incremental ? new Set(existingModel.sourceContentDigests ?? []) : new Set();
const requestedSources = await Promise.all(requestedFiles.map(async (path) => ({
  path,
  digest: await fileContentDigest(path)
})));
const acceptedSourceContentDigests = new Set();
const skippedSources = [];
const sources = [];
for (const source of requestedSources) {
  const alreadyConsumed = incremental
    && (previousSourceFiles.has(source.path) || previousSourceContentDigests.has(source.digest));
  if (alreadyConsumed || acceptedSourceContentDigests.has(source.digest)) {
    skippedSources.push(source);
    continue;
  }
  sources.push(source);
  acceptedSourceContentDigests.add(source.digest);
}
const files = sources.map((source) => source.path);
if (files.length === 0 && incremental && !featureSelectionUpgradeNeeded) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeJsonAtomicSync(outPath, {
    ...existingModel,
    incremental: true,
    newSourceFiles: [],
    newSourceContentDigests: [],
    sourceDigestVersion: MIN_LEARNING_SOURCE_DIGEST_VERSION,
    duplicateSourceFilesSkipped: Number(existingModel.duplicateSourceFilesSkipped ?? 0) + skippedSources.length,
    newDuplicateSourceFilesSkipped: skippedSources.length,
    lastSourceScanAt: new Date().toISOString()
  });
  console.log(`Kept existing ML action model at ${outPath}: no new decision logs were supplied.`);
  if (skippedSources.length > 0) console.log(`Skipped ${skippedSources.length} previously consumed or content-identical source file(s).`);
  process.exit(0);
}

const existingSignalVersion = Number(existingModel?.learningSignalVersion ?? 1);
const existingEffectiveWeight = incremental ? Number(existingModel.exampleWeightTotal ?? existingModel.examples ?? 0) : 0;
const legacyScale = incremental && existingSignalVersion < 2 && existingEffectiveWeight > legacyWeightCap
  ? legacyWeightCap / existingEffectiveWeight
  : 1;
const accumulators = linearFeatureAccumulatorMap(incremental ? existingModel : null, legacyScale);
const crossAccumulators = linearFeatureCrossMap(incremental ? existingModel : null, legacyScale);
let targetTotal = incremental
  ? Number(existingModel.targetTotal ?? Number(existingModel.averageTarget ?? 0) * existingEffectiveWeight) * legacyScale
  : 0;
let sourceRows = incremental ? Number(existingModel.sourceRows ?? 0) : 0;
let selectedExamples = incremental ? Number(existingModel.selectedExamples ?? 0) : 0;
let examples = incremental ? Number(existingModel.examples ?? 0) : 0;
let pairwiseExamples = incremental ? Number(existingModel.pairwiseExamples ?? 0) : 0;
const pairwiseEffectiveWeightStatsComplete = !incremental
  || Number(existingModel?.pairwiseEffectiveWeightVersion ?? 0) >= MIN_ML_PAIRWISE_EFFECTIVE_WEIGHT_VERSION;
let pairwiseEffectiveWeight = incremental && pairwiseEffectiveWeightStatsComplete
  ? Number(existingModel.pairwiseEffectiveWeight ?? 0)
  : 0;
const evidenceDiversityLedger = initializeEvidenceDiversityLedger(incremental ? existingModel : null);
let exampleWeightTotal = existingEffectiveWeight * legacyScale;
let legacyExampleWeight = incremental
  ? Number(existingModel.legacyExampleWeight ?? (existingSignalVersion < 2 ? existingEffectiveWeight : 0)) * legacyScale
  : 0;
let trustedExampleWeight = incremental
  ? Number(existingModel.trustedExampleWeight ?? (Number(existingModel.learningSignalVersion ?? 1) >= 2 ? exampleWeightTotal : 0))
  : 0;
const existingValidationState = incremental && !validationStateUpgradeNeeded
  ? existingModel?.validationState ?? null
  : null;
const validationSamples = persistedValidationSamples(existingValidationState);
const validationSampleKeys = new Set(validationSamples.map((sample) => sample.key));
const validationAssignments = new Map();
const validationPlayerGames = new Set((existingValidationState?.heldoutPlayerGameKeys ?? [])
  .map((key) => String(key))
  .filter(Boolean)
  .slice(0, validationMaxExamples));
const learningEvidenceFilter = createLearningEvidenceFilter(incremental ? existingModel?.learningEvidenceFilter : null, {
  initialCapacity: ACTION_EVIDENCE_FILTER_INITIAL_CAPACITY
});
const samplingSafetyLedger = createLearningSamplingSafetyLedger(incremental ? existingModel?.samplingSafety : null);
let uniqueLearningUnits = incremental ? Number(existingModel.uniqueLearningUnits ?? 0) : 0;
let duplicateLearningUnitsSkipped = incremental ? Number(existingModel.duplicateLearningUnitsSkipped ?? 0) : 0;
let validationExamplesSeen = incremental ? Number(existingValidationState?.examplesSeen ?? 0) : 0;
let validationHeldoutDecisions = incremental ? Number(existingValidationState?.heldoutDecisions ?? 0) : 0;

for (const file of files) {
  let currentDecisionKey = null;
  let currentDecisionGroup = [];
  for await (const row of readJsonlRows(file)) {
    if (isLearningGameTelemetry(row)) {
      if (playerFilter === "all" || row.player === playerFilter) {
        recordLearningSamplingTelemetry(samplingSafetyLedger, row);
      }
      continue;
    }
    if (playerFilter !== "all" && row.player !== playerFilter) continue;
    sourceRows += 1;
    if (learningMode === "selected") {
      if (!row.chosen) continue;
      if (addUniqueRowExample(row) === "train") selectedExamples += 1;
    } else if (learningMode === "all") {
      if (addUniqueRowExample(row) === "train" && row.chosen) selectedExamples += 1;
    } else {
      const key = row.decisionKey ?? fallbackDecisionKey(row);
      if (currentDecisionKey !== null && key !== currentDecisionKey) {
        addDecisionGroupExamples(currentDecisionGroup, file);
        currentDecisionGroup = [];
      }
      currentDecisionKey = key;
      currentDecisionGroup.push(row);
    }
  }
  if (currentDecisionGroup.length > 0) {
    addDecisionGroupExamples(currentDecisionGroup, file);
  }
}

if (examples === 0) {
  throw new Error("No eligible causal decision examples found. Use selected/all learning only for runtime-quarantined diagnostics.");
}

const {
  weights,
  featureStats,
  trainingStats,
  featureCrossStats,
  featureSelection
} = fitMultivariateRidge({
  accumulators,
  crossAccumulators,
  scale,
  l2,
  minObservations,
  maxWeight,
  maxFeatures: maxModelFeatures,
  minContextualObservations
});

const validation = validationSummary(weights);
const pairwiseEvidenceDiversity = summarizeEvidenceDiversityLedger(evidenceDiversityLedger);
const samplingSafety = summarizeLearningSamplingSafety(samplingSafetyLedger);
const evidenceSignalTrust = trustedExampleWeight / Math.max(1, legacyExampleWeight + trustedExampleWeight);
const validationSignalTrust = validationTrust(validation);
const model = normalizeMlActionModel({
  schema: ML_ACTION_MODEL_SCHEMA,
  name: option("--name") ?? "local-linear-action-model",
  trainedAt: new Date().toISOString(),
  sourceFiles: [...new Set([...(incremental ? existingModel.sourceFiles ?? [] : []), ...files])],
  sourceDigestVersion: MIN_LEARNING_SOURCE_DIGEST_VERSION,
  sourceContentDigests: [...new Set([
    ...(incremental ? existingModel.sourceContentDigests ?? [] : []),
    ...sources.map((source) => source.digest)
  ])],
  incremental,
  newSourceFiles: files,
  newSourceContentDigests: sources.map((source) => source.digest),
  duplicateSourceFilesSkipped: Number(incremental ? existingModel.duplicateSourceFilesSkipped ?? 0 : 0) + skippedSources.length,
  newDuplicateSourceFilesSkipped: skippedSources.length,
  learningEvidenceFilterVersion: MIN_LEARNING_EVIDENCE_FILTER_VERSION,
  learningEvidenceFilter: serializeLearningEvidenceFilter(learningEvidenceFilter),
  learningEvidenceFilterStats: learningEvidenceFilterStats(learningEvidenceFilter),
  samplingSafety,
  learningHealth: learningHealthWithSamplingSafety(incremental ? existingModel?.learningHealth : null, samplingSafety),
  examples,
  sourceRows,
  selectedExamples,
  pairwiseExamples,
  pairwiseEffectiveWeightVersion: pairwiseEffectiveWeightStatsComplete
    ? MIN_ML_PAIRWISE_EFFECTIVE_WEIGHT_VERSION
    : Number(existingModel?.pairwiseEffectiveWeightVersion ?? 0),
  pairwiseEffectiveWeight: Number(pairwiseEffectiveWeight.toFixed(6)),
  evidenceDiversityVersion: MIN_ML_EVIDENCE_DIVERSITY_VERSION,
  pairwiseEvidenceDiversity,
  trainingPipelineVersion: TRAINING_PIPELINE_VERSION,
  validationAssignmentVersion: VALIDATION_ASSIGNMENT_VERSION,
  validationStateVersion: MIN_ML_VALIDATION_STATE_VERSION,
  pairwiseOrientationVersion: MIN_ML_PAIRWISE_ORIENTATION_VERSION,
  pairwiseInputConsistencyVersion: MIN_ML_PAIRWISE_INPUT_CONSISTENCY_VERSION,
  regressionVersion: MULTIVARIATE_RIDGE_VERSION,
  regressionMode: "multivariate-ridge",
  counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION,
  uniqueLearningUnits,
  duplicateLearningUnitsSkipped,
  learningSignalVersion: LEARNING_SIGNAL_VERSION,
  learningSignalTrust: evidenceSignalTrust * validationSignalTrust,
  evidenceSignalTrust,
  validationSignalTrust,
  legacyExampleWeight,
  trustedExampleWeight,
  legacyWeightCap,
  legacyScaleApplied: legacyScale,
  selectedOnly: learningMode === "selected",
  learningMode,
  pairwiseScale,
  includeChosenAnchor,
  anchorEvidenceMode: includeChosenAnchor ? "raw-outcome-experimental" : "counterfactual-only",
  chosenAnchorScale,
  scale,
  l2,
  minObservations,
  minContextualObservations,
  maxWeight,
  maxModelFeatures,
  featureSelection,
  validation,
  validationState: validationStateArtifact(),
  averageTarget: targetTotal / Math.max(1, exampleWeightTotal),
  targetTotal,
  exampleWeightTotal,
  weights,
  featureStats,
  trainingStats,
  featureCrossStats
});

mkdirSync(dirname(outPath), { recursive: true });
if (!hasFlag("--allow-shrink") && incremental && Number(existingModel?.examples ?? 0) > Number(model.examples ?? 0)) {
  console.log(`Kept existing ML action model at ${outPath}: existing examples ${existingModel.examples} exceed candidate examples ${model.examples}. Pass --allow-shrink to replace it.`);
  process.exit(0);
}
backupIfExists(outPath);
writeJsonAtomicSync(outPath, model);
console.log(`${incremental ? "Updated" : "Trained"} ML action model from ${files.length} new decision log file(s).`);
console.log(`Player filter: ${playerFilter}`);
console.log(`Learning mode: ${learningMode}`);
console.log(`Examples: ${examples}; selected examples: ${selectedExamples}; pairwise examples: ${pairwiseExamples}; features: ${Object.keys(weights).length}`);
console.log(`Feature budget: ${featureSelection.selected}/${featureSelection.maxFeatures ?? "unlimited"}; contextual ${featureSelection.contextualSelected}/${featureSelection.contextualEligible}; ${featureSelection.contextualDeferredForSupport} collecting evidence.`);
console.log(`Effective pairwise weight: ${pairwiseEffectiveWeight.toFixed(3)}.`);
console.log(`Unique learning units: ${uniqueLearningUnits}; duplicate units skipped: ${duplicateLearningUnitsSkipped}.`);
console.log(`Sampling safety: ${samplingSafety.label}; ${samplingSafety.adaptiveAudits} adaptive audit(s), ${samplingSafety.adaptiveAuditDisagreements} disagreement(s).`);
if (skippedSources.length > 0) console.log(`Skipped ${skippedSources.length} previously consumed or content-identical source file(s).`);
console.log(`Saved model: ${outPath}`);

function addUniqueRowExample(row) {
  const fingerprint = learningDecisionGroupFingerprint([row]);
  if (learningEvidenceFilterHas(learningEvidenceFilter, fingerprint)) {
    duplicateLearningUnitsSkipped += 1;
    return "none";
  }
  const result = addRowExample(row, fingerprint);
  if (result !== "none") {
    learningEvidenceFilterAdd(learningEvidenceFilter, fingerprint);
    uniqueLearningUnits += 1;
  }
  return result;
}

function addRowExample(row, fingerprint = learningDecisionGroupFingerprint([row])) {
  const target = Number(row.shapedReward ?? row.reward ?? 0);
  if (!Number.isFinite(target)) return "none";
  const weight = rowLearningWeight(row);
  if (weight <= 0) return "none";
  if (isValidationDecision(row)) {
    return addValidationExample(
      row.features,
      target,
      weight,
      "anchor",
      `${fingerprint}|anchor`,
      validationMetadataForPair(row, { action: { type: "anchor" } }, null)
    ) ? "validation" : "none";
  }
  return addFeatureExample(row.features, target, weight * chosenAnchorScale) ? "train" : "none";
}

function addDecisionGroupExamples(group, sourceFile) {
  if (!(learningMode === "pairwise" || learningMode === "regret")) return;
  const chosen = group.find((row) => row.chosen);
  if (!chosen) return;
  const chosenWeight = rowLearningWeight(chosen);
  if (chosenWeight <= 0) return;
  const chosenTarget = Number(chosen.shapedReward ?? chosen.reward ?? 0);
  if (!Number.isFinite(chosenTarget)) return;
  const pairwiseEvidence = counterfactualPairwiseLearningEvidence(chosen);
  const alternatives = pairwiseEvidence ? counterfactualAlternativeRows(group, chosen) : [];
  if (!includeChosenAnchor && alternatives.length === 0) return;
  const fingerprint = learningDecisionGroupFingerprint(group);
  if (learningEvidenceFilterHas(learningEvidenceFilter, fingerprint)) {
    duplicateLearningUnitsSkipped += 1;
    return;
  }
  learningEvidenceFilterAdd(learningEvidenceFilter, fingerprint);
  uniqueLearningUnits += 1;
  const holdout = isValidationDecision(chosen);
  if (holdout) validationHeldoutDecisions += 1;
  if (includeChosenAnchor) {
    const route = holdout
      ? addValidationExample(
          chosen.features,
          chosenTarget,
          chosenWeight * chosenAnchorScale,
          "anchor",
          `${fingerprint}|anchor`,
          validationMetadataForPair(chosen, { action: { type: "anchor" } }, null)
        ) ? "validation" : "none"
      : addFeatureExample(chosen.features, chosenTarget, chosenWeight * chosenAnchorScale) ? "train" : "none";
    if (route === "train") selectedExamples += 1;
  }

  if (!pairwiseEvidence) return;
  for (const alternative of alternatives) {
    const orientation = pairwiseExampleOrientation(chosen, alternative);
    const diff = featureDifference(chosen.features, alternative.features, orientation);
    if (Object.keys(diff).length === 0) continue;
    const weight = chosenWeight * pairwiseEvidence.magnitude * pairwiseScale * pairwiseEvidence.confidence;
    const target = pairwiseEvidence.direction * orientation;
    let accepted = false;
    if (holdout) {
      const alternativeKey = alternative.actionIndex ?? JSON.stringify(alternative.action ?? null);
      accepted = addValidationExample(
        diff,
        target,
        weight,
        "pairwise",
        `${fingerprint}|pairwise|${alternativeKey}`,
        validationMetadataForPair(chosen, alternative, pairwiseEvidence)
      );
    } else if (addFeatureExample(diff, target, weight)) {
      pairwiseExamples += 1;
      pairwiseEffectiveWeight += weight;
      accepted = true;
    }
    if (accepted) recordEvidenceDiversityPair(evidenceDiversityLedger, chosen, alternative, pairwiseEvidence);
  }
}

function initializeEvidenceDiversityLedger(model = null) {
  const raw = model?.pairwiseEvidenceDiversity ?? {};
  const current = Number(model?.evidenceDiversityVersion ?? raw.version ?? 0) >= MIN_ML_EVIDENCE_DIVERSITY_VERSION;
  if (!current) {
    return {
      trackedExamples: 0,
      historicalUnclassifiedExamples: Math.max(
        0,
        Number(model?.pairwiseExamples ?? 0) + Number(model?.validation?.pairwise?.examples ?? 0)
      ),
      phaseCounts: {},
      actionPairCounts: {},
      opponentProfileCounts: {},
      evidenceKindCounts: {}
    };
  }
  return {
    trackedExamples: Math.max(0, Number(raw.trackedExamples ?? 0)),
    historicalUnclassifiedExamples: Math.max(0, Number(raw.historicalUnclassifiedExamples ?? 0)),
    phaseCounts: normalizedCountMap(raw.phaseCounts),
    actionPairCounts: normalizedCountMap(raw.actionPairCounts),
    opponentProfileCounts: normalizedCountMap(raw.opponentProfileCounts),
    evidenceKindCounts: normalizedCountMap(raw.evidenceKindCounts)
  };
}

function recordEvidenceDiversityPair(ledger, chosen, alternative, evidence) {
  const keys = pairwiseEvidenceDiversityKeys(chosen, alternative, evidence);
  ledger.trackedExamples += 1;
  incrementCount(ledger.phaseCounts, keys.phase);
  incrementCount(ledger.actionPairCounts, keys.actionPair);
  incrementCount(ledger.opponentProfileCounts, keys.opponentProfile);
  incrementCount(ledger.evidenceKindCounts, keys.evidenceKind);
}

function summarizeEvidenceDiversityLedger(ledger) {
  const phaseCounts = sortedCountMap(ledger.phaseCounts);
  const actionPairCounts = sortedCountMap(ledger.actionPairCounts);
  const opponentProfileCounts = sortedCountMap(ledger.opponentProfileCounts);
  const evidenceKindCounts = sortedCountMap(ledger.evidenceKindCounts);
  const actionPairTotal = countMapTotal(actionPairCounts);
  const dominantActionPair = dominantCountEntry(actionPairCounts);
  const dominantPhase = dominantCountEntry(phaseCounts);
  const dominantOpponentProfile = dominantCountEntry(opponentProfileCounts);
  return {
    version: MIN_ML_EVIDENCE_DIVERSITY_VERSION,
    trackedExamples: Math.max(0, Math.floor(Number(ledger.trackedExamples ?? 0))),
    historicalUnclassifiedExamples: Math.max(0, Math.floor(Number(ledger.historicalUnclassifiedExamples ?? 0))),
    phaseCounts,
    actionPairCounts,
    opponentProfileCounts,
    evidenceKindCounts,
    distinctPhases: knownCountKeys(phaseCounts).length,
    distinctActionPairs: Object.keys(actionPairCounts).length,
    distinctOpponentProfiles: knownCountKeys(opponentProfileCounts).length,
    dominantPhase: dominantPhase?.key ?? null,
    dominantPhaseRate: ratio(dominantPhase?.count ?? 0, countMapTotal(phaseCounts)),
    dominantActionPair: dominantActionPair?.key ?? null,
    dominantActionPairRate: ratio(dominantActionPair?.count ?? 0, actionPairTotal),
    dominantOpponentProfile: dominantOpponentProfile?.key ?? null,
    dominantOpponentProfileRate: ratio(dominantOpponentProfile?.count ?? 0, countMapTotal(opponentProfileCounts))
  };
}

function normalizedCountMap(raw = {}) {
  return Object.fromEntries(Object.entries(raw ?? {})
    .map(([key, value]) => [String(key), Math.max(0, Math.floor(Number(value ?? 0)))])
    .filter(([key, value]) => key && Number.isFinite(value) && value > 0));
}

function sortedCountMap(raw = {}) {
  return Object.fromEntries(Object.entries(normalizedCountMap(raw))
    .sort(([left], [right]) => left.localeCompare(right)));
}

function incrementCount(counts, key) {
  counts[key] = Number(counts[key] ?? 0) + 1;
}

function countMapTotal(counts = {}) {
  return Object.values(counts).reduce((total, count) => total + Number(count ?? 0), 0);
}

function knownCountKeys(counts = {}) {
  return Object.keys(counts).filter((key) => key !== "unknown");
}

function dominantCountEntry(counts = {}) {
  return Object.entries(counts).reduce((best, [key, count]) => {
    if (!best || count > best.count || (count === best.count && key.localeCompare(best.key) < 0)) {
      return { key, count };
    }
    return best;
  }, null);
}

function isValidationDecision(row) {
  if (validationFraction <= 0) return false;
  const key = learningValidationGameKey(row);
  if (!validationAssignments.has(key)) {
    validationAssignments.set(key, examples >= validationMinTrainingExamples && deterministicUnitInterval(key) < validationFraction);
  }
  const heldout = validationAssignments.get(key);
  if (heldout && (validationPlayerGames.has(key) || validationPlayerGames.size < validationMaxExamples)) {
    validationPlayerGames.add(key);
  }
  return heldout;
}

function addValidationExample(features = {}, target, weight, kind, sampleKey, metadata = null) {
  if (!Number.isFinite(Number(weight)) || Number(weight) <= 0) return false;
  const cleanFeatures = Object.fromEntries(Object.entries(features ?? {})
    .filter(([feature, rawValue]) => feature !== "baseScore" && Number.isFinite(Number(rawValue)) && Number(rawValue) !== 0)
    .map(([feature, rawValue]) => [feature, Number(rawValue)]));
  if (Object.keys(cleanFeatures).length === 0) return false;
  const key = String(sampleKey ?? "");
  if (!key) return false;
  if (validationSampleKeys.has(key)) return true;
  validationExamplesSeen += 1;
  const sample = {
    key,
    priority: deterministicUnitInterval(`validation-reservoir|${key}`),
    features: cleanFeatures,
    target: Number(target),
    weight: Number(weight),
    kind,
    metadata: normalizedValidationMetadata(metadata)
  };
  if (validationSamples.length < validationMaxExamples) {
    validationSamples.push(sample);
    validationSampleKeys.add(key);
  } else {
    let worstIndex = 0;
    for (let index = 1; index < validationSamples.length; index += 1) {
      const current = validationSamples[index];
      const worst = validationSamples[worstIndex];
      if (current.priority > worst.priority || (current.priority === worst.priority && current.key > worst.key)) {
        worstIndex = index;
      }
    }
    const worst = validationSamples[worstIndex];
    if (sample.priority < worst.priority || (sample.priority === worst.priority && sample.key < worst.key)) {
      validationSampleKeys.delete(worst.key);
      validationSamples[worstIndex] = sample;
      validationSampleKeys.add(key);
    }
  }
  return true;
}

function validationMetadataForPair(chosen, alternative, evidence) {
  return normalizedValidationMetadata({
    ...pairwiseEvidenceDiversityKeys(chosen, alternative, evidence),
    playerGame: learningValidationGameKey(chosen)
  });
}

function normalizedValidationMetadata(metadata = null) {
  return {
    phase: String(metadata?.phase ?? "unknown").toLowerCase() || "unknown",
    actionPair: String(metadata?.actionPair ?? "unknown").toLowerCase() || "unknown",
    opponentProfile: String(metadata?.opponentProfile ?? "unknown").toLowerCase() || "unknown",
    evidenceKind: String(metadata?.evidenceKind ?? "unknown").toLowerCase() || "unknown",
    playerGame: String(metadata?.playerGame ?? "unknown") || "unknown"
  };
}

function validationSummary(modelWeights) {
  const summarize = (samples) => {
    if (samples.length === 0) return null;
    let weightTotal = 0;
    let correctWeight = 0;
    let absoluteErrorTotal = 0;
    let predictionTotal = 0;
    let targetTotalValue = 0;
    let positiveWeight = 0;
    let negativeWeight = 0;
    let positiveCorrectWeight = 0;
    let negativeCorrectWeight = 0;
    let positiveExamples = 0;
    let negativeExamples = 0;
    for (const sample of samples) {
      const weight = Number(sample.weight ?? 1);
      const prediction = Object.entries(sample.features).reduce((total, [feature, value]) => {
        return total + Number(modelWeights[feature] ?? 0) * Number(value);
      }, 0) / Math.max(1, Math.abs(scale));
      weightTotal += weight;
      predictionTotal += prediction * weight;
      targetTotalValue += sample.target * weight;
      absoluteErrorTotal += Math.abs(prediction - sample.target) * weight;
      if (Math.sign(prediction) === Math.sign(sample.target)) correctWeight += weight;
      if (sample.target > 0) {
        positiveExamples += 1;
        positiveWeight += weight;
        if (prediction > 0) positiveCorrectWeight += weight;
      } else if (sample.target < 0) {
        negativeExamples += 1;
        negativeWeight += weight;
        if (prediction < 0) negativeCorrectWeight += weight;
      }
    }
    const balancedSignAccuracy = positiveWeight > 0 && negativeWeight > 0
      ? (ratio(positiveCorrectWeight, positiveWeight) + ratio(negativeCorrectWeight, negativeWeight)) / 2
      : null;
    return {
      examples: samples.length,
      weightTotal: Number(weightTotal.toFixed(6)),
      signAccuracy: ratio(correctWeight, weightTotal),
      balancedSignAccuracy,
      majoritySignBaseline: ratio(Math.max(positiveWeight, negativeWeight), positiveWeight + negativeWeight),
      positiveExamples,
      negativeExamples,
      positiveWeight: Number(positiveWeight.toFixed(6)),
      negativeWeight: Number(negativeWeight.toFixed(6)),
      meanAbsoluteError: ratio(absoluteErrorTotal, weightTotal),
      averagePrediction: ratio(predictionTotal, weightTotal),
      averageTarget: ratio(targetTotalValue, weightTotal)
    };
  };
  const pairwiseSamples = validationSamples.filter((sample) => sample.kind === "pairwise");
  const pairwiseSummary = summarize(pairwiseSamples);
  if (pairwiseSummary) {
    pairwiseSummary.validationDiversity = validationDiversitySummary(pairwiseSamples, summarize);
    pairwiseSummary.inputConsistency = pairwiseInputConsistencySummary(pairwiseSamples);
  }
  return {
    strategy: "deterministic-player-game-holdout",
    cumulative: true,
    reservoir: "deterministic-priority",
    assignmentKeyVersion: VALIDATION_ASSIGNMENT_VERSION,
    fraction: validationFraction,
    maxExamples: validationMaxExamples,
    minTrainingExamples: validationMinTrainingExamples,
    heldoutDecisions: validationHeldoutDecisions,
    heldoutPlayerGames: sampledValidationPlayerGameKeys().length,
    assignedHeldoutPlayerGames: validationPlayerGames.size,
    examplesSeen: validationExamplesSeen,
    sampledExamples: validationSamples.length,
    overall: summarize(validationSamples),
    anchor: summarize(validationSamples.filter((sample) => sample.kind === "anchor")),
    pairwise: pairwiseSummary
  };
}

function validationDiversitySummary(samples, summarize) {
  const phaseCounts = {};
  const actionPairCounts = {};
  const opponentProfileCounts = {};
  const evidenceKindCounts = {};
  const playerGameCounts = {};
  const actionPairGroups = new Map();
  for (const sample of samples) {
    const metadata = normalizedValidationMetadata(sample.metadata);
    incrementCount(phaseCounts, metadata.phase);
    incrementCount(actionPairCounts, metadata.actionPair);
    incrementCount(opponentProfileCounts, metadata.opponentProfile);
    incrementCount(evidenceKindCounts, metadata.evidenceKind);
    incrementCount(playerGameCounts, metadata.playerGame);
    const group = actionPairGroups.get(metadata.actionPair) ?? [];
    group.push(sample);
    actionPairGroups.set(metadata.actionPair, group);
  }
  const actionPairReliability = [...actionPairGroups.entries()]
    .map(([key, rows]) => {
      const summary = summarize(rows);
      return {
        key,
        examples: rows.length,
        signAccuracy: Number(summary?.signAccuracy ?? 0),
        balancedSignAccuracy: summary?.balancedSignAccuracy ?? null,
        positiveExamples: Number(summary?.positiveExamples ?? 0),
        negativeExamples: Number(summary?.negativeExamples ?? 0),
        weightTotal: Number(summary?.weightTotal ?? 0),
        distinctPlayerGames: new Set(rows
          .map((row) => normalizedValidationMetadata(row.metadata).playerGame)
          .filter((key) => key !== "unknown")).size
      };
    })
    .sort((left, right) => right.examples - left.examples || left.key.localeCompare(right.key));
  return {
    version: MIN_ML_VALIDATION_DIVERSITY_VERSION,
    trackedExamples: samples.length,
    phaseCounts: sortedCountMap(phaseCounts),
    actionPairCounts: sortedCountMap(actionPairCounts),
    opponentProfileCounts: sortedCountMap(opponentProfileCounts),
    evidenceKindCounts: sortedCountMap(evidenceKindCounts),
    playerGameCounts: sortedCountMap(playerGameCounts),
    actionPairReliability
  };
}

function sampledValidationPlayerGameKeys() {
  return [...new Set(validationSamples
    .map((sample) => normalizedValidationMetadata(sample.metadata).playerGame)
    .filter((key) => key !== "unknown"))]
    .sort();
}

function persistedValidationSamples(state) {
  if (Number(state?.version ?? 0) !== MIN_ML_VALIDATION_STATE_VERSION) return [];
  return (state.samples ?? [])
    .map((sample) => {
      const key = String(sample?.key ?? "");
      const features = Object.fromEntries(Object.entries(sample?.features ?? {})
        .filter(([feature, rawValue]) => feature !== "baseScore" && Number.isFinite(Number(rawValue)) && Number(rawValue) !== 0)
        .map(([feature, rawValue]) => [feature, Number(rawValue)]));
      if (!key || Object.keys(features).length === 0 || !Number.isFinite(Number(sample?.target)) || !Number.isFinite(Number(sample?.weight))) {
        return null;
      }
      return {
        key,
        priority: Number.isFinite(Number(sample?.priority))
          ? Number(sample.priority)
          : deterministicUnitInterval(`validation-reservoir|${key}`),
        features,
        target: Number(sample.target),
        weight: Number(sample.weight),
        kind: sample.kind === "pairwise" ? "pairwise" : "anchor",
        metadata: normalizedValidationMetadata(sample.metadata)
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.priority - right.priority || left.key.localeCompare(right.key))
    .slice(0, validationMaxExamples);
}

function validationStateArtifact() {
  return {
    version: MIN_ML_VALIDATION_STATE_VERSION,
    reservoir: "deterministic-priority",
    sampleCapacity: validationMaxExamples,
    samples: [...validationSamples]
      .sort((left, right) => left.priority - right.priority || left.key.localeCompare(right.key)),
    heldoutPlayerGameKeys: sampledValidationPlayerGameKeys(),
    heldoutDecisions: validationHeldoutDecisions,
    examplesSeen: validationExamplesSeen
  };
}

function validationTrust(validation) {
  if (Number(validation?.fraction ?? 0) <= 0) return 0.25;
  const hasCounterfactualPairs = Number(validation?.pairwise?.examples ?? 0) >= 30;
  const preferred = hasCounterfactualPairs ? validation.pairwise : validation?.anchor;
  if (!preferred || preferred.examples < 30) return 0.25;
  if (hasCounterfactualPairs
    && Number(preferred.weightTotal ?? 0) < MIN_ML_RUNTIME_VALIDATION_PAIRWISE_EFFECTIVE_WEIGHT) return 0.25;
  if (Number(preferred.positiveExamples ?? 0) < 3 || Number(preferred.negativeExamples ?? 0) < 3) return 0.25;
  const accuracy = Number(preferred.balancedSignAccuracy);
  if (!Number.isFinite(accuracy)) return 0.25;
  if (hasCounterfactualPairs) {
    const diversity = preferred.validationDiversity ?? {};
    const consistency = preferred.inputConsistency ?? {};
    const phaseCounts = normalizedCountMap(diversity.phaseCounts);
    const actionPairCounts = normalizedCountMap(diversity.actionPairCounts);
    const opponentProfileCounts = normalizedCountMap(diversity.opponentProfileCounts);
    const playerGameCounts = normalizedCountMap(diversity.playerGameCounts);
    const actionPairTotal = Object.values(actionPairCounts).reduce((total, count) => total + count, 0);
    const dominant = dominantCountEntry(actionPairCounts);
    const reliability = (diversity.actionPairReliability ?? [])
      .filter((row) => Number(row?.examples ?? 0) >= MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_EXAMPLES);
    if (Number(diversity.version ?? 0) < MIN_ML_VALIDATION_DIVERSITY_VERSION) return 0.25;
    if (Object.keys(phaseCounts).filter((key) => key !== "unknown").length < MIN_ML_RUNTIME_VALIDATION_DISTINCT_PHASES) return 0.25;
    if (Object.keys(actionPairCounts).length < MIN_ML_RUNTIME_VALIDATION_DISTINCT_ACTION_PAIRS) return 0.25;
    if (Object.keys(opponentProfileCounts).filter((key) => key !== "unknown").length < MIN_ML_RUNTIME_VALIDATION_DISTINCT_OPPONENTS) return 0.25;
    if (Object.keys(playerGameCounts).filter((key) => key !== "unknown").length < MIN_ML_RUNTIME_HELDOUT_GAMES) return 0.25;
    if (actionPairTotal <= 0 || Number(dominant?.count ?? 0) / actionPairTotal > MAX_ML_RUNTIME_VALIDATION_DOMINANT_ACTION_PAIR_RATE) return 0.25;
    if (reliability.length < MIN_ML_RUNTIME_VALIDATION_DISTINCT_ACTION_PAIRS) return 0.25;
    if (reliability.some((row) => Number(row.signAccuracy ?? 0) < MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_ACCURACY)) return 0.25;
    if (reliability.some((row) => Number(row.distinctPlayerGames ?? 0) < MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_GAMES)) return 0.25;
    if (reliability.some((row) => (
      Number(row.positiveExamples ?? 0) < MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_SIGN_EXAMPLES
      || Number(row.negativeExamples ?? 0) < MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_SIGN_EXAMPLES
    ))) return 0.25;
    if (Number(consistency.version ?? 0) < MIN_ML_PAIRWISE_INPUT_CONSISTENCY_VERSION) return 0.25;
    if (consistency.complete === false) return 0.25;
    const consistencyGateEligible = Number(consistency.repeatedContexts ?? 0) >= MIN_ML_RUNTIME_VALIDATION_CONSISTENCY_REPEATED_CONTEXTS
      && Number(consistency.repeatedExamples ?? 0) >= MIN_ML_RUNTIME_VALIDATION_CONSISTENCY_REPEATED_EXAMPLES;
    if (consistencyGateEligible
      && Number(consistency.conflictRate ?? 0) > MAX_ML_RUNTIME_VALIDATION_INPUT_CONFLICT_RATE) return 0.25;
  }
  const accuracyTrust = clamp(0.25 + Math.max(0, accuracy - 0.5) * 3, 0.25, 1);
  const independentGameTrust = clamp(Number(validation?.heldoutPlayerGames ?? 0) / 8, 0.25, 1);
  return Math.min(accuracyTrust, independentGameTrust);
}

function deterministicUnitInterval(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 0x100000000;
}

function pairwiseExampleOrientation(chosen, alternative) {
  const identity = JSON.stringify({
    game: learningValidationGameKey(chosen),
    player: chosen.player ?? "player",
    step: chosen.step ?? "step",
    phase: chosen.creditPhase ?? chosen.phase ?? "unknown",
    chosenAction: chosen.action ?? null,
    alternativeAction: alternative.action ?? null
  });
  return deterministicUnitInterval(`${identity}|pairwise-orientation-v${MIN_ML_PAIRWISE_ORIENTATION_VERSION}`) < 0.5 ? -1 : 1;
}

function addFeatureExample(features = {}, target, weight = 1) {
  const exampleWeight = Number(weight ?? 1);
  if (!Number.isFinite(exampleWeight) || exampleWeight <= 0) return false;
  const numericTarget = Number(target ?? 0);
  if (!Number.isFinite(numericTarget)) return false;
  const used = addLinearFeatureExample({
    accumulators,
    crossAccumulators,
    features,
    target: numericTarget,
    weight: exampleWeight
  });
  if (!used) return false;
  examples += 1;
  targetTotal += numericTarget * exampleWeight;
  exampleWeightTotal += exampleWeight;
  trustedExampleWeight += exampleWeight;
  return true;
}

function rowLearningWeight(row) {
  if (Number(row.learningSignalVersion ?? 1) < LEARNING_SIGNAL_VERSION) return 0;
  if (row.learningEligible === false) return 0;
  if (String(row.outcome ?? "").toLowerCase() === "incomplete") return 0;
  if (Number(row.candidateCount ?? 2) <= 1) return 0;
  const weight = Number(row.creditWeight ?? 1);
  return Number.isFinite(weight) && weight > 0 ? weight : 0;
}

function featureDifference(chosenFeatures = {}, alternativeFeatures = {}, direction = 1) {
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

function fallbackDecisionKey(row) {
  return [
    row.candidateId ?? "candidate",
    row.gameIndex ?? "game",
    row.player ?? "player",
    row.step ?? "step"
  ].join(":");
}

function normalizeLearningMode(value) {
  const normalized = String(value ?? "pairwise").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const aliases = new Map([
    ["chosen", "selected"],
    ["selected-only", "selected"],
    ["all-candidates", "all"],
    ["candidate", "all"],
    ["candidates", "all"],
    ["counterfactual", "pairwise"],
    ["regret-pairwise", "pairwise"]
  ]);
  const mode = aliases.get(normalized) ?? normalized;
  if (!new Set(["selected", "all", "pairwise", "regret"]).has(mode)) {
    throw new Error(`Unknown --learning-mode: ${value}. Use selected, all, pairwise, or regret.`);
  }
  return mode;
}

function inputPaths() {
  const values = [];
  const inline = option("--input") ?? option("--inputs");
  if (inline) values.push(...splitList(inline));
  const inputFile = option("--inputs-file") ?? option("--input-file");
  if (inputFile) values.push(...readInputListFile(inputFile));
  const run = option("--run") ?? option("--runs");
  if (run) values.push(...splitList(run));
  const positional = process.argv.slice(2).filter((arg, index, args) => {
    if (arg.startsWith("--")) return false;
    const previous = args[index - 1];
    return !previous?.startsWith("--");
  });
  values.push(...positional);
  return values.filter(Boolean);
}

function readInputListFile(path) {
  if (!existsSync(path)) throw new Error(`Inputs file not found: ${path}`);
  return splitList(readFileSync(path, "utf8"));
}

function decisionLogFiles(path) {
  if (!existsSync(path)) throw new Error(`Input path not found: ${path}`);
  const stats = statSync(path);
  if (stats.isFile()) return path.endsWith(".jsonl") ? [path] : [];
  const direct = join(path, "decision-log.jsonl");
  const files = existsSync(direct) ? [direct] : [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    files.push(...decisionLogFiles(join(path, entry.name)));
  }
  return files;
}

async function* readJsonlRows(path) {
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const rawLine of lines) {
    const line = rawLine.trim();
    if (line) yield JSON.parse(line);
  }
}

function splitList(value) {
  return String(value).split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}

function option(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function backupIfExists(path) {
  if (!existsSync(path) || hasFlag("--no-backup")) return null;
  const backupPath = `${path}.bak-${artifactTimestamp()}`;
  copyFileSync(path, backupPath);
  return backupPath;
}

function artifactTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function contextualArtifactEvidencePresent(artifact = {}) {
  return [artifact?.weights, artifact?.trainingStats, artifact?.featureStats]
    .some((rows) => Object.keys(rows ?? {}).some((feature) => feature.startsWith("context.")));
}

function usage() {
  console.log(`Usage:
  node tools/train-ml-scorer.mjs --input work/private/pilot-agent/runs/session --out work/private/pilot-agent/baselines/decks/eva-purple/action-model.json

Inputs may be a decision-log.jsonl file or any run folder containing decision-log.jsonl files.

Options:
  --scale 120
  --l2 8
  --min-observations 12
  --min-contextual-observations 24
  --max-weight 260
  --max-model-features 512
  --player P1|P2|all
  --include-unchosen (legacy alias for quarantined --learning-mode all)
  --learning-mode selected|all|pairwise|regret (default: pairwise)
  --pairwise-scale 0.7
  --include-chosen-anchor
  --chosen-anchor-scale 0.25
  --validation-fraction 0.2
  --validation-max-examples 5000
  --validation-min-training-examples 4
  --no-chosen-anchor
  --incremental
  --allow-shrink
  --inputs-file work/private/pilot-agent/knowledge-updates/session/ml-inputs.txt
  --name local-linear-action-model`);
}
