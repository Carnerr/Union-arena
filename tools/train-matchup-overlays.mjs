#!/usr/bin/env node
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
  MIN_ML_RUNTIME_CONTEXTUAL_FEATURE_OBSERVATIONS,
  MATCHUP_OVERLAY_SCHEMA,
  MULTIVARIATE_RIDGE_VERSION,
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
  linearFeatureAccumulatorMap,
  linearFeatureCrossMap,
  matchupOverlayReadiness,
  normalizeMatchupOverlay,
  pairwiseEvidenceDiversityKeys,
  recordLearningSamplingTelemetry,
  serializeLearningEvidenceFilter,
  summarizeLearningSamplingSafety,
  fitMultivariateRidge,
  fileContentDigest,
  writeJsonAtomicSync
} from "../src/index.js";
import {
  matchupOverlayCandidatePathForKeys,
  matchupOverlayCandidatesDirForKey,
  matchupOverlayPathForKeys,
  matchupOverlaysDirForKey
} from "../src/policy-router.js";

const LEARNING_SIGNAL_VERSION = 2;
const TRAINING_PIPELINE_VERSION = 2;

const inputs = inputPaths();
const ownKey = option("--own-key") ?? option("--pilot-key") ?? requiredOption("--own");
const policyDir = option("--policy-dir") ?? "work/private/pilot-agent/policies";
const baselineRoot = option("--baseline-root");
const outDir = option("--out-dir") ?? matchupOverlaysDirForKey(ownKey, { policyDir, baselineRoot });
const candidateDir = option("--candidate-dir") ?? (option("--out-dir")
  ? join(dirname(outDir), "matchup-candidates")
  : matchupOverlayCandidatesDirForKey(ownKey, { policyDir, baselineRoot }));
const playerFilter = option("--player") ?? "P1";
const scale = Number(option("--scale") ?? 120);
const l2 = Number(option("--l2") ?? 8);
const minExamples = Number(option("--min-examples") ?? 80);
const minObservations = Number(option("--min-observations") ?? 12);
const minContextualObservations = Math.max(minObservations, Number(
  option("--min-contextual-observations") ?? DEFAULT_CONTEXTUAL_MIN_OBSERVATIONS
));
const maxWeight = Number(option("--max-weight") ?? 260);
const maxModelFeatures = Math.max(1, Math.floor(Number(
  option("--max-model-features") ?? DEFAULT_LINEAR_MODEL_MAX_FEATURES
)));
const groupByMode = normalizeGroupByMode(option("--group-by") ?? "profile");
const learningMode = normalizeLearningMode(option("--learning-mode") ?? option("--candidate-mode") ?? "pairwise");
const pairwiseScale = Number(option("--pairwise-scale") ?? 0.7);
const includeChosenAnchor = learningMode === "selected"
  || learningMode === "all"
  || (!hasFlag("--no-chosen-anchor")
    && (hasFlag("--include-chosen-anchor") || option("--chosen-anchor-scale") !== undefined));
const chosenAnchorScale = Math.max(0, Number(option("--chosen-anchor-scale") ?? 0.25));
const legacyWeightCap = Math.max(0, Number(option("--legacy-weight-cap") ?? 5000));

if (hasFlag("--help") || inputs.length === 0) {
  usage();
  process.exit(inputs.length === 0 ? 1 : 0);
}

const incremental = hasFlag("--incremental");
const requestedInputFiles = [...new Set(inputs.flatMap(decisionLogFiles))];
const causalMetadataUpgradeArtifacts = incremental
  ? [...existingOverlayArtifacts(outDir), ...existingOverlayArtifacts(candidateDir)].filter(({ overlay }) => (
      Number(overlay?.evidenceDiversityVersion ?? overlay?.pairwiseEvidenceDiversity?.version ?? 0) < MIN_ML_EVIDENCE_DIVERSITY_VERSION
      || Number(overlay?.pairwiseEffectiveWeightVersion ?? 0) < MIN_ML_PAIRWISE_EFFECTIVE_WEIGHT_VERSION
      || Number(overlay?.regressionVersion ?? 1) < MULTIVARIATE_RIDGE_VERSION
      || contextualArtifactNeedsSelectionUpgrade(overlay)
    ))
  : [];
const retainedCausalMetadataSources = [...new Set(causalMetadataUpgradeArtifacts.flatMap(({ overlay }) => (
  overlay?.sourceFiles ?? []
)))].filter((path) => String(path).endsWith(".jsonl") && existsSync(path) && statSync(path).isFile());
const requestedFiles = [...new Set([...retainedCausalMetadataSources, ...requestedInputFiles])];
if (requestedFiles.length === 0) throw new Error(`No decision-log.jsonl files found under: ${inputs.join(", ")}`);
const requestedSources = await Promise.all(requestedFiles.map(async (path) => ({
  path,
  digest: await fileContentDigest(path)
})));
const currentSourceContentDigests = new Set();
const duplicateRequestedSources = [];
const sources = [];
for (const source of requestedSources) {
  if (currentSourceContentDigests.has(source.digest)) {
    duplicateRequestedSources.push(source);
    continue;
  }
  currentSourceContentDigests.add(source.digest);
  sources.push(source);
}
const files = sources.map((source) => source.path);
const sourceContentDigestByPath = new Map(sources.map((source) => [source.path, source.digest]));
if (causalMetadataUpgradeArtifacts.length > 0) {
  console.log(
    `Rebuilding ${causalMetadataUpgradeArtifacts.length} matchup overlay artifact(s) for causal evidence metadata; replaying ${retainedCausalMetadataSources.length} retained source log(s).`
  );
}

const grouped = new Map();
const samplingTelemetryByFile = new Map(files.map((file) => [file, []]));
let selectedRows = 0;
let sourceRows = 0;
let trainingExamples = 0;
let pairwiseExamples = 0;
let uniqueLearningUnits = 0;
let duplicateLearningUnitsSkipped = 0;
for (const file of files) {
  let currentDecisionKey = null;
  let currentDecisionGroup = [];
  for await (const row of readJsonlRows(file)) {
    if (isLearningGameTelemetry(row)) {
      if (playerFilter === "all" || row.player === playerFilter) {
        samplingTelemetryByFile.get(file).push(row);
      }
      continue;
    }
    if (playerFilter !== "all" && row.player !== playerFilter) continue;
    if (learningMode === "selected" || learningMode === "all") {
      if (learningMode === "selected" && !row.chosen) continue;
      const opponentKey = opponentKeyForRow(row, groupByMode);
      if (opponentKey === "unknown") continue;
      const stats = overlayStatsForKey(opponentKey);
      if (overlaySourceAlreadyConsumed(stats, file)) continue;
      const fingerprint = learningDecisionGroupFingerprint([row]);
      if (learningEvidenceFilterHas(stats.learningEvidenceFilter, fingerprint)) {
        duplicateLearningUnitsSkipped += 1;
        stats.duplicateLearningUnitsSkipped += 1;
        continue;
      }
      stats.sourceRows += 1;
      sourceRows += 1;
      if (addOverlayRow(stats, row, file)) {
        learningEvidenceFilterAdd(stats.learningEvidenceFilter, fingerprint);
        uniqueLearningUnits += 1;
        stats.uniqueLearningUnits += 1;
        grouped.set(opponentKey, stats);
        trainingExamples += 1;
        stats.trainingExamples += 1;
        stats.newExamples += 1;
        if (row.chosen) {
          selectedRows += 1;
          stats.selectedRows += 1;
        }
      }
    } else {
      const key = row.decisionKey ?? fallbackDecisionKey(row);
      if (currentDecisionKey !== null && key !== currentDecisionKey) {
        addOverlayDecisionGroup(currentDecisionGroup, file);
        currentDecisionGroup = [];
      }
      currentDecisionKey = key;
      currentDecisionGroup.push(row);
    }
  }
  if (currentDecisionGroup.length > 0) {
    addOverlayDecisionGroup(currentDecisionGroup, file);
  }
}
const outputs = [];

mkdirSync(outDir, { recursive: true });
for (const [opponentKey, stats] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  if (stats.newExamples === 0) continue;
  recordSamplingTelemetryForStats(stats);
  const trainedModel = trainOverlayForGroup({ ownKey, opponentKey, stats });
  const causalReadiness = matchupOverlayReadiness(trainedModel, { requireImpactValidation: false });
  const provisional = stats.examples < minExamples || !causalReadiness.ready;
  const candidateReason = stats.examples < minExamples
    ? `matchup overlay has ${stats.examples}/${minExamples} required training examples`
    : causalReadiness.reason;
  const model = provisional
    ? {
        ...trainedModel,
        matchupCandidate: {
          status: "collecting-evidence",
          examples: stats.examples,
          minimumExamples: minExamples,
          causalReady: causalReadiness.ready,
          causalStatus: causalReadiness.status,
          reason: candidateReason
        }
      }
    : trainedModel;
  const activePath = option("--out-dir")
    ? join(outDir, `${ownKey}-vs-${opponentKey}.json`)
    : matchupOverlayPathForKeys(ownKey, opponentKey, { policyDir, baselineRoot });
  const path = provisional ? overlayCandidatePath(opponentKey) : activePath;
  const existing = readJsonIfExists(path);
  if (!hasFlag("--allow-shrink") && Number(existing?.examples ?? 0) > Number(model.examples ?? 0)) {
    outputs.push({
      opponentKey,
      path,
      examples: stats.examples,
      features: Object.keys(model.weights).length,
      featureSelection: model.featureSelection,
      commonLowCostCards: model.commonLowCostCards,
      provisional,
      keptExisting: true,
      existingExamples: Number(existing.examples ?? 0)
    });
    continue;
  }
  backupIfExists(path);
  writeJsonAtomicSync(path, model);
  outputs.push({
    opponentKey,
    path,
    examples: stats.examples,
    pairwiseExamples: stats.pairwiseExamples,
    pairwiseEffectiveWeight: stats.pairwiseEffectiveWeight,
    evidenceDiversity: model.pairwiseEvidenceDiversity,
    causalReadiness,
    samplingSafety: model.samplingSafety,
    features: Object.keys(model.weights).length,
    featureSelection: model.featureSelection,
    commonLowCostCards: model.commonLowCostCards,
    provisional
  });
}

console.log(`Read ${files.length} decision log file(s).`);
console.log(`Selected ${selectedRows} chosen decision row(s) for player ${playerFilter}.`);
console.log(`Learning mode: ${learningMode}; source rows: ${sourceRows}; training examples: ${trainingExamples}; pairwise examples: ${pairwiseExamples}.`);
console.log(`Unique learning units: ${uniqueLearningUnits}; duplicate units skipped: ${duplicateLearningUnitsSkipped}.`);
const previouslyConsumedSources = [...grouped.values()].reduce((total, stats) => total + stats.skippedSourceFiles.size, 0);
if (duplicateRequestedSources.length + previouslyConsumedSources > 0) {
  console.log(`Skipped ${duplicateRequestedSources.length} content-identical requested source(s) and ${previouslyConsumedSources} previously consumed overlay source(s).`);
}
console.log(`Grouped by ${groupByMode}.`);
console.log(`Wrote ${outputs.length} matchup overlay artifact file(s).`);
for (const output of outputs) {
  if (output.keptExisting) {
    console.log(`${output.opponentKey}: kept existing ${output.existingExamples} example overlay; candidate had ${output.examples} examples -> ${output.path}`);
  } else {
    console.log(
      `${output.opponentKey}: ${output.examples} examples, ${output.pairwiseExamples} causal pairs, ${Number(output.pairwiseEffectiveWeight ?? 0).toFixed(3)} effective pairwise weight, ${output.evidenceDiversity?.distinctPhases ?? 0} phases, ${output.evidenceDiversity?.distinctActionPairs ?? 0} action-pair families, ${output.features} features, ${output.featureSelection?.contextualDeferredForSupport ?? 0} contextual signal(s) collecting evidence, sampling ${output.samplingSafety?.label ?? "Unknown"}${output.provisional ? " (inactive candidate)" : ""} -> ${output.path}`
    );
  }
}

function createOverlayStats(existing = null) {
  const compatible = !existing || (
    String(existing.learningMode ?? learningMode) === learningMode
    && Boolean(existing.includeChosenAnchor ?? true) === includeChosenAnchor
    && Number(existing.pairwiseScale ?? pairwiseScale) === pairwiseScale
    && Number(existing.trainingPipelineVersion ?? 1) === TRAINING_PIPELINE_VERSION
    && Number(existing.sourceDigestVersion ?? 0) === MIN_LEARNING_SOURCE_DIGEST_VERSION
    && Number(existing.learningEvidenceFilterVersion ?? 0) === MIN_LEARNING_EVIDENCE_FILTER_VERSION
    && Number(existing.evidenceDiversityVersion ?? existing.pairwiseEvidenceDiversity?.version ?? 0) === MIN_ML_EVIDENCE_DIVERSITY_VERSION
    && Number(existing.pairwiseEffectiveWeightVersion ?? 0) === MIN_ML_PAIRWISE_EFFECTIVE_WEIGHT_VERSION
    && Number(existing.counterfactualStateEvaluationVersion ?? 1) === COUNTERFACTUAL_STATE_EVALUATION_VERSION
    && Number(existing.regressionVersion ?? 1) === MULTIVARIATE_RIDGE_VERSION
    && !contextualArtifactNeedsSelectionUpgrade(existing)
  );
  if (existing && !compatible && !hasFlag("--allow-incompatible-incremental")) existing = null;
  const existingEffectiveWeight = Number(existing?.exampleWeightTotal ?? existing?.examples ?? 0);
  const existingVersion = Number(existing?.learningSignalVersion ?? 1);
  const legacyScale = existingVersion < 2 && existingEffectiveWeight > legacyWeightCap
    ? legacyWeightCap / existingEffectiveWeight
    : 1;
  return {
    accumulators: linearFeatureAccumulatorMap(existing, legacyScale),
    crossAccumulators: linearFeatureCrossMap(existing, legacyScale),
    targetTotal: Number(existing?.targetTotal ?? Number(existing?.averageTarget ?? 0) * existingEffectiveWeight) * legacyScale,
    lowCostCounts: new Map((existing?.commonLowCostCards ?? []).map((row) => [row.cardId, Number(row.count ?? 0)])),
    examples: Number(existing?.examples ?? 0),
    sourceRows: Number(existing?.sourceRows ?? 0),
    trainingExamples: Number(existing?.trainingExamples ?? existing?.examples ?? 0),
    selectedRows: Number(existing?.selectedRows ?? 0),
    pairwiseExamples: Number(existing?.pairwiseExamples ?? 0),
    pairwiseEffectiveWeight: Number(existing?.pairwiseEffectiveWeight ?? 0),
    evidenceDiversityLedger: initializeEvidenceDiversityLedger(existing),
    uniqueLearningUnits: Number(existing?.uniqueLearningUnits ?? 0),
    duplicateLearningUnitsSkipped: Number(existing?.duplicateLearningUnitsSkipped ?? 0),
    exampleWeightTotal: existingEffectiveWeight * legacyScale,
    legacyExampleWeight: Number(existing?.legacyExampleWeight ?? (existingVersion < 2 ? existingEffectiveWeight : 0)) * legacyScale,
    trustedExampleWeight: Number(existing?.trustedExampleWeight ?? (existingVersion >= 2 ? existingEffectiveWeight : 0)),
    previousSourceFiles: new Set(existing?.sourceFiles ?? []),
    previousSourceContentDigests: new Set(existing?.sourceContentDigests ?? []),
    sourceFiles: new Set(existing?.sourceFiles ?? []),
    sourceContentDigests: new Set(existing?.sourceContentDigests ?? []),
    skippedSourceFiles: new Set(),
    previousDuplicateSourceFilesSkipped: Number(existing?.duplicateSourceFilesSkipped ?? 0),
    learningEvidenceFilter: createLearningEvidenceFilter(existing?.learningEvidenceFilter ?? null),
    samplingSafetyLedger: createLearningSamplingSafetyLedger(existing?.samplingSafety ?? null),
    existingLearningHealth: existing?.learningHealth ?? null,
    newSourceFiles: new Set(),
    samplingTelemetryRecorded: false,
    newExamples: 0,
    legacyScale
  };
}

function overlayStatsForKey(opponentKey) {
  const current = grouped.get(opponentKey);
  if (current) return current;
  const created = createOverlayStats(incremental ? existingOverlayForKey(opponentKey) : null);
  grouped.set(opponentKey, created);
  return created;
}

function overlayPath(opponentKey) {
  return option("--out-dir")
    ? join(outDir, `${ownKey}-vs-${opponentKey}.json`)
    : matchupOverlayPathForKeys(ownKey, opponentKey, { policyDir, baselineRoot });
}

function overlayCandidatePath(opponentKey) {
  return option("--out-dir")
    ? join(candidateDir, basename(overlayPath(opponentKey)))
    : matchupOverlayCandidatePathForKeys(ownKey, opponentKey, { policyDir, baselineRoot });
}

function existingOverlayForKey(opponentKey) {
  const active = readJsonIfExists(overlayPath(opponentKey));
  const candidate = readJsonIfExists(overlayCandidatePath(opponentKey));
  if (!candidate) return active;
  if (!active) return candidate;
  const candidateExamples = Number(candidate.examples ?? 0);
  const activeExamples = Number(active.examples ?? 0);
  return candidateExamples >= activeExamples ? candidate : active;
}

function overlaySourceAlreadyConsumed(stats, sourceFile) {
  if (!incremental) return false;
  const digest = sourceContentDigestByPath.get(sourceFile);
  const consumed = stats.previousSourceFiles.has(sourceFile)
    || (digest && stats.previousSourceContentDigests.has(digest));
  if (consumed) stats.skippedSourceFiles.add(sourceFile);
  return consumed;
}

function addOverlayRow(stats, row, sourceFile) {
  const target = Number(row.shapedReward ?? row.reward ?? 0);
  if (!Number.isFinite(target)) return false;
  const weight = rowLearningWeight(row) * chosenAnchorScale;
  if (weight <= 0) return false;
  if (!addOverlayFeatureExample(stats, row.features, target, weight, { countExample: false })) return false;
  stats.examples += 1;
  stats.targetTotal += target * weight;
  stats.exampleWeightTotal += weight;
  stats.trustedExampleWeight += weight;
  stats.sourceFiles.add(sourceFile);
  stats.sourceContentDigests.add(sourceContentDigestByPath.get(sourceFile));
  stats.newSourceFiles.add(sourceFile);
  for (const cardId of row.matchupObservedLowCostCardIds ?? []) {
    stats.lowCostCounts.set(cardId, (stats.lowCostCounts.get(cardId) ?? 0) + 1);
  }
  return true;
}

function addOverlayDecisionGroup(group, sourceFile) {
  if (!(learningMode === "pairwise" || learningMode === "regret")) return;
  const chosen = group.find((row) => row.chosen);
  if (!chosen) return;
  const chosenWeight = rowLearningWeight(chosen);
  if (chosenWeight <= 0) return;
  const opponentKey = opponentKeyForRow(chosen, groupByMode);
  if (opponentKey === "unknown") return;
  const chosenTarget = Number(chosen.shapedReward ?? chosen.reward ?? 0);
  if (!Number.isFinite(chosenTarget)) return;
  const stats = overlayStatsForKey(opponentKey);
  if (overlaySourceAlreadyConsumed(stats, sourceFile)) return;
  const pairwiseEvidence = counterfactualPairwiseLearningEvidence(chosen);
  const alternatives = pairwiseEvidence ? counterfactualAlternativeRows(group, chosen) : [];
  if (!includeChosenAnchor && alternatives.length === 0) return;
  const fingerprint = learningDecisionGroupFingerprint(group);
  if (learningEvidenceFilterHas(stats.learningEvidenceFilter, fingerprint)) {
    duplicateLearningUnitsSkipped += 1;
    stats.duplicateLearningUnitsSkipped += 1;
    return;
  }
  stats.sourceRows += group.length;
  sourceRows += group.length;
  let addedLearning = false;
  if (includeChosenAnchor && addOverlayRow(stats, chosen, sourceFile)) {
    addedLearning = true;
    trainingExamples += 1;
    selectedRows += 1;
    stats.trainingExamples += 1;
    stats.selectedRows += 1;
    stats.newExamples += 1;
  }
  if (pairwiseEvidence) {
    for (const alternative of alternatives) {
      const diff = featureDifference(chosen.features, alternative.features, pairwiseEvidence.direction);
      if (Object.keys(diff).length === 0) continue;
      const weight = chosenWeight * pairwiseEvidence.magnitude * pairwiseScale * pairwiseEvidence.confidence;
      if (addOverlayFeatureExample(stats, diff, 1, weight)) {
        addedLearning = true;
        trainingExamples += 1;
        pairwiseExamples += 1;
        stats.trainingExamples += 1;
        stats.pairwiseExamples += 1;
        stats.pairwiseEffectiveWeight += weight;
        recordEvidenceDiversityPair(stats.evidenceDiversityLedger, chosen, alternative, pairwiseEvidence);
        stats.newExamples += 1;
        stats.sourceFiles.add(sourceFile);
        stats.sourceContentDigests.add(sourceContentDigestByPath.get(sourceFile));
        stats.newSourceFiles.add(sourceFile);
      }
    }
  }
  if (addedLearning) {
    learningEvidenceFilterAdd(stats.learningEvidenceFilter, fingerprint);
    uniqueLearningUnits += 1;
    stats.uniqueLearningUnits += 1;
  }
  grouped.set(opponentKey, stats);
}

function addOverlayFeatureExample(stats, features = {}, target, weight = 1, { countExample = true } = {}) {
  const exampleWeight = Number(weight ?? 1);
  if (!Number.isFinite(exampleWeight) || exampleWeight <= 0) return false;
  const numericTarget = Number(target ?? 0);
  if (!Number.isFinite(numericTarget)) return false;
  const used = addLinearFeatureExample({
    accumulators: stats.accumulators,
    crossAccumulators: stats.crossAccumulators,
    features,
    target: numericTarget,
    weight: exampleWeight
  });
  if (!used) return false;
  if (countExample) {
    stats.examples += 1;
    stats.targetTotal += numericTarget * exampleWeight;
    stats.exampleWeightTotal += exampleWeight;
    stats.trustedExampleWeight += exampleWeight;
  }
  return true;
}

function trainOverlayForGroup({ ownKey, opponentKey, stats }) {
  const {
    weights,
    featureStats,
    trainingStats,
    featureCrossStats,
    featureSelection
  } = fitMultivariateRidge({
    accumulators: stats.accumulators,
    crossAccumulators: stats.crossAccumulators,
    scale,
    l2,
    minObservations,
    maxWeight,
    maxFeatures: maxModelFeatures,
    minContextualObservations
  });
  const pairwiseEvidenceDiversity = summarizeEvidenceDiversityLedger(stats.evidenceDiversityLedger);
  const samplingSafety = summarizeLearningSamplingSafety(stats.samplingSafetyLedger);

  return normalizeMatchupOverlay({
    schema: MATCHUP_OVERLAY_SCHEMA,
    name: `${ownKey}-vs-${opponentKey}`,
    ownKey,
    opponentKey,
    trainedAt: new Date().toISOString(),
    sourceFiles: [...stats.sourceFiles],
    sourceDigestVersion: MIN_LEARNING_SOURCE_DIGEST_VERSION,
    sourceContentDigests: [...stats.sourceContentDigests].filter(Boolean),
    duplicateSourceFilesSkipped: stats.previousDuplicateSourceFilesSkipped + stats.skippedSourceFiles.size,
    learningEvidenceFilterVersion: MIN_LEARNING_EVIDENCE_FILTER_VERSION,
    learningEvidenceFilter: serializeLearningEvidenceFilter(stats.learningEvidenceFilter),
    learningEvidenceFilterStats: learningEvidenceFilterStats(stats.learningEvidenceFilter),
    samplingSafety,
    learningHealth: learningHealthWithSamplingSafety(stats.existingLearningHealth, samplingSafety),
    examples: stats.examples,
    sourceRows: stats.sourceRows,
    trainingExamples: stats.trainingExamples,
    selectedRows: stats.selectedRows,
    pairwiseExamples: stats.pairwiseExamples,
    pairwiseEffectiveWeightVersion: MIN_ML_PAIRWISE_EFFECTIVE_WEIGHT_VERSION,
    pairwiseEffectiveWeight: Number(stats.pairwiseEffectiveWeight.toFixed(6)),
    evidenceDiversityVersion: MIN_ML_EVIDENCE_DIVERSITY_VERSION,
    pairwiseEvidenceDiversity,
    trainingPipelineVersion: TRAINING_PIPELINE_VERSION,
    counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION,
    regressionVersion: MULTIVARIATE_RIDGE_VERSION,
    regressionMode: "multivariate-ridge",
    uniqueLearningUnits: stats.uniqueLearningUnits,
    duplicateLearningUnitsSkipped: stats.duplicateLearningUnitsSkipped,
    learningSignalVersion: LEARNING_SIGNAL_VERSION,
    learningSignalTrust: stats.trustedExampleWeight / Math.max(1, stats.legacyExampleWeight + stats.trustedExampleWeight),
    legacyExampleWeight: stats.legacyExampleWeight,
    trustedExampleWeight: stats.trustedExampleWeight,
    legacyWeightCap,
    legacyScaleApplied: stats.legacyScale,
    incremental,
    learningMode,
    pairwiseScale,
    includeChosenAnchor,
    anchorEvidenceMode: includeChosenAnchor ? "raw-outcome-experimental" : "counterfactual-only",
    chosenAnchorScale,
    averageTarget: stats.targetTotal / Math.max(1, stats.exampleWeightTotal),
    targetTotal: stats.targetTotal,
    exampleWeightTotal: stats.exampleWeightTotal,
    scale,
    l2,
    minExamples,
    minObservations,
    minContextualObservations,
    maxWeight,
    maxModelFeatures,
    featureSelection,
    commonLowCostCards: [...stats.lowCostCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 20)
      .map(([cardId, count]) => ({ cardId, count })),
    weights,
    featureStats,
    trainingStats,
    featureCrossStats
  });
}

function recordSamplingTelemetryForStats(stats) {
  if (stats.samplingTelemetryRecorded) return;
  for (const sourceFile of stats.newSourceFiles) {
    for (const row of samplingTelemetryByFile.get(sourceFile) ?? []) {
      recordLearningSamplingTelemetry(stats.samplingSafetyLedger, row);
    }
  }
  stats.samplingTelemetryRecorded = true;
}

function opponentKeyForRow(row, mode = "profile") {
  if (mode === "variant") {
    const variantKey = String(row.matchupVariantKey ?? "");
    const status = String(row.matchupVariantStatus ?? "");
    if (variantKey && variantKey !== "unknown" && status === "unknown-variant") return variantKey;
    return "unknown";
  }
  if (mode === "all-variant") {
    const variantKey = String(row.matchupVariantKey ?? "");
    if (variantKey && variantKey !== "unknown") return variantKey;
    return "unknown";
  }
  if (mode === "known-variant") {
    const variantKey = String(row.matchupVariantKey ?? "");
    const status = String(row.matchupVariantStatus ?? "");
    if (variantKey && variantKey !== "unknown" && status === "known-deck") return variantKey;
    return "unknown";
  }
  const profileKey = String(row.matchupProfileKey ?? "");
  if (profileKey && profileKey !== "unknown") return profileKey;
  const match = String(row.opponent ?? "").match(/^regional-([^-]+)-([^-]+)-/);
  return match ? `${match[1].toLowerCase()}-${match[2].toLowerCase()}` : "unknown";
}

function normalizeGroupByMode(value) {
  const normalized = String(value ?? "profile").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const aliases = new Map([
    ["set-color", "profile"],
    ["profile-key", "profile"],
    ["deck", "known-variant"],
    ["saved-deck", "known-variant"],
    ["known-deck", "known-variant"],
    ["all-variants", "all-variant"],
    ["all-variant", "all-variant"],
    ["variant-key", "variant"],
    ["variants", "variant"]
  ]);
  const mode = aliases.get(normalized) ?? normalized;
  const allowed = new Set(["profile", "variant", "known-variant", "all-variant"]);
  if (!allowed.has(mode)) throw new Error(`Unknown --group-by: ${value}. Use profile, variant, known-variant, or all-variant.`);
  return mode;
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

function rowLearningWeight(row) {
  if (Number(row.learningSignalVersion ?? 1) < LEARNING_SIGNAL_VERSION) return 0;
  if (row.learningEligible === false) return 0;
  if (String(row.outcome ?? "").toLowerCase() === "incomplete") return 0;
  if (Number(row.candidateCount ?? 2) <= 1) return 0;
  const weight = Number(row.creditWeight ?? 1);
  return Number.isFinite(weight) && weight > 0 ? weight : 0;
}

function initializeEvidenceDiversityLedger(overlay = null) {
  const raw = overlay?.pairwiseEvidenceDiversity ?? {};
  const current = Number(overlay?.evidenceDiversityVersion ?? raw.version ?? 0) >= MIN_ML_EVIDENCE_DIVERSITY_VERSION;
  if (!current) {
    return {
      trackedExamples: 0,
      historicalUnclassifiedExamples: Math.max(0, Number(overlay?.pairwiseExamples ?? 0)),
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
    dominantActionPair: dominantActionPair?.key ?? null,
    dominantActionPairCount: dominantActionPair?.count ?? 0,
    dominantActionPairRate: actionPairTotal > 0 ? (dominantActionPair?.count ?? 0) / actionPairTotal : 1,
    dominantOpponentProfile: dominantOpponentProfile?.key ?? null
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
  const normalized = String(key ?? "unknown") || "unknown";
  counts[normalized] = Number(counts[normalized] ?? 0) + 1;
}

function countMapTotal(counts = {}) {
  return Object.values(counts).reduce((total, count) => total + Number(count ?? 0), 0);
}

function dominantCountEntry(counts = {}) {
  return Object.entries(counts).reduce((best, [key, count]) => {
    if (!best || count > best.count || (count === best.count && key.localeCompare(best.key) < 0)) {
      return { key, count };
    }
    return best;
  }, null);
}

function knownCountKeys(counts = {}) {
  return Object.keys(counts).filter((key) => key !== "unknown");
}

function existingOverlayArtifacts(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !entry.name.includes(".bak-"))
    .map((entry) => {
      const path = join(directory, entry.name);
      return { path, overlay: readJsonIfExists(path) };
    })
    .filter(({ overlay }) => overlay?.schema === MATCHUP_OVERLAY_SCHEMA && String(overlay.ownKey ?? "") === String(ownKey));
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
  const inline = option("--input") ?? option("--inputs") ?? option("--run") ?? option("--runs");
  if (inline) values.push(...splitList(inline));
  const inputFile = option("--inputs-file") ?? option("--input-file");
  if (inputFile) values.push(...readInputListFile(inputFile));
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

function groupBy(values, keyFn) {
  const groups = new Map();
  for (const value of values) {
    const key = keyFn(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
}

function splitList(value) {
  return String(value).split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}

function option(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function requiredOption(flag) {
  const value = option(flag);
  if (!value) throw new Error(`Missing required option: ${flag}`);
  return value;
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

function contextualArtifactNeedsSelectionUpgrade(artifact = {}) {
  const hasContext = [artifact?.weights, artifact?.trainingStats, artifact?.featureStats]
    .some((rows) => Object.keys(rows ?? {}).some((feature) => feature.startsWith("context.")));
  return hasContext && (
    Number(artifact?.featureSelection?.version ?? 0) < MIN_ML_FEATURE_SELECTION_VERSION
    || Number(artifact?.minContextualObservations ?? 0) < MIN_ML_RUNTIME_CONTEXTUAL_FEATURE_OBSERVATIONS
  );
}

function usage() {
  console.log(`Usage:
  node tools/train-matchup-overlays.mjs --input work/private/pilot-agent/runs/session --own-key eva-purple

Inputs may be a decision-log.jsonl file or a run folder containing decision logs.

Options:
  --own-key eva-purple
  --player P1
  --policy-dir work/private/pilot-agent/policies
  --baseline-root work/private/pilot-agent/baselines
  --out-dir work/private/pilot-agent/baselines/decks/eva-purple/matchups
  --candidate-dir work/private/pilot-agent/baselines/decks/eva-purple/matchup-candidates
  --inputs-file work/private/pilot-agent/knowledge-updates/session/overlay-inputs.txt
  --allow-shrink
  --scale 120
  --l2 8
  --min-examples 80
  --min-observations 12
  --min-contextual-observations 24
  --max-weight 260
  --max-model-features 512
  --learning-mode selected|all|pairwise|regret (default: pairwise)
  --pairwise-scale 0.7
  --chosen-anchor-scale 0.25
  --no-chosen-anchor
  --incremental
  --group-by profile|variant|known-variant|all-variant`);
}
