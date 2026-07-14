#!/usr/bin/env node
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { writeJsonAtomicSync } from "../src/artifact-io.js";
import {
  DEFAULT_PILOT_POLICY,
  counterfactualAlternativeRows,
  counterfactualPairwiseLearningEvidence,
  counterfactualTestedActionFamilies,
  createPairwiseInputConsistencyLedger,
  decisionActionFamilies,
  isLearningGameTelemetry,
  learningDecisionGroupFingerprint,
  learningGameTelemetryFingerprint,
  pairwiseActionFamily,
  pairwiseEvidenceDiversityKeys,
  pairwiseFeatureDifference,
  pilotPolicyFeatureGroup,
  recordPairwiseInputConsistency,
  summarizePairwiseInputConsistencyLedger
} from "../src/index.js";

const inputs = inputPaths();
if (hasFlag("--help") || inputs.length === 0) {
  usage();
  process.exit(inputs.length === 0 ? 1 : 0);
}

const maxFiles = Math.max(1, Number(option("--max-files") ?? Number.MAX_SAFE_INTEGER));
const files = [...new Set(inputs.flatMap(decisionLogFiles))]
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs || a.localeCompare(b))
  .slice(0, maxFiles);
const metrics = {
  schema: "union-arena-local-engine/learning-data-audit@1",
  auditedAt: new Date().toISOString(),
  files,
  bytes: 0,
  rows: 0,
  parseErrors: 0,
  decisions: 0,
  wins: 0,
  losses: 0,
  incomplete: 0,
  forced: 0,
  eligible: 0,
  exploration: 0,
  explorationModes: {},
  counterfactual: 0,
  actionableCounterfactual: 0,
  counterfactualPreferences: {},
  counterfactualEvidenceKinds: {},
  counterfactualStateEvaluationVersions: {},
  counterfactualTargetPhases: {},
  counterfactualDecisionPhases: {},
  counterfactualAlternativeSelections: {},
  counterfactualInformationReasons: {},
  counterfactualSamplingReasons: {},
  counterfactualInformationScoreCount: 0,
  counterfactualInformationScoreTotal: 0,
  counterfactualInformationScoreMin: null,
  counterfactualInformationScoreMax: null,
  counterfactualFallbacks: 0,
  pairwiseEvidenceTracked: 0,
  pairwiseEvidencePhases: {},
  pairwiseEvidenceActionPairs: {},
  pairwiseEvidenceOpponentProfiles: {},
  pairwiseEvidenceKinds: {},
  decisionGroups: 0,
  uniqueDecisionGroups: 0,
  duplicateDecisionGroups: 0,
  duplicateDecisionRows: 0,
  setup: 0,
  signContradictions: 0,
  version2: 0,
  credited: 0,
  creditWeightTotal: 0,
  phases: {},
  actions: {},
  candidateActionUses: {},
  causallyTestedActionUses: {},
  candidateFeatureUses: {},
  chosenFeatureUses: {},
  phaseCredit: {},
  actionCredit: {},
  raidNormalPlayOptions: 0,
  chosenRaidNormalPlay: 0,
  chosenRaidNormalPlayExploration: 0,
  chosenRaidActions: 0,
  raidNormalPlayCoverage: { available: 0, chosen: 0, causallyTested: 0, covered: 0 },
  resolutionChoiceCoverage: {},
  raidPlacementCoverage: { decisions: 0, options: {} },
  fieldReplacementCoverage: { available: 0, chosen: 0, causallyTested: 0, covered: 0 },
  telemetryRows: 0,
  duplicateTelemetryRows: 0,
  telemetryCounterfactuals: 0,
  telemetryActionableCounterfactuals: 0,
  telemetryUnsynchronizedCounterfactuals: 0,
  telemetryGamesWithCounterfactual: 0,
  telemetryGamesWithActionableCounterfactual: 0,
  telemetryDecisionOpportunities: 0,
  telemetryExplorations: 0,
  telemetryExplorationProbes: 0,
  telemetryExplorationActions: 0,
  telemetryLowInformationSkips: 0,
  gameDecisionCounts: new Map()
};
const seenDecisionFingerprints = new Set();
const seenTelemetryFingerprints = new Set();
const pairwiseInputConsistencyLedger = createPairwiseInputConsistencyLedger({ maxContexts: 100_000 });

for (const file of files) await auditFile(file);

const gameCounts = [...metrics.gameDecisionCounts.values()];
const playerGames = gameCounts.length;
const explorationPriorityComparisons = Number(metrics.counterfactualSamplingReasons["explored-action-priority"] ?? 0)
  + Number(metrics.counterfactualSamplingReasons["explored-alternative-priority"] ?? 0)
  + Number(metrics.counterfactualSamplingReasons["explored-action-fallback"] ?? 0)
  + Number(metrics.counterfactualSamplingReasons["explored-alternative-fallback"] ?? 0);
const unpairedExplorations = Math.max(0, metrics.exploration - explorationPriorityComparisons);
const policyFeatureCoverage = summarizePolicyFeatureCoverage(metrics.candidateFeatureUses);
const output = {
  ...metrics,
  gameDecisionCounts: undefined,
  fileCount: files.length,
  playerGames,
  averageDecisionsPerPlayerGame: average(gameCounts),
  maxDecisionsPerPlayerGame: gameCounts.length > 0 ? Math.max(...gameCounts) : 0,
  incompleteRate: ratio(metrics.incomplete, metrics.decisions),
  forcedRate: ratio(metrics.forced, metrics.decisions),
  eligibleRate: ratio(metrics.eligible, metrics.decisions),
  explorationRate: ratio(metrics.exploration, metrics.decisions),
  explorationPriorityComparisons,
  unpairedExplorations,
  unpairedExplorationRate: ratio(unpairedExplorations, metrics.exploration),
  counterfactualRate: ratio(metrics.counterfactual, metrics.decisions),
  actionableCounterfactualRate: ratio(metrics.actionableCounterfactual, metrics.decisions),
  counterfactualActionableRate: ratio(metrics.actionableCounterfactual, metrics.counterfactual),
  actionableCounterfactualsPerPlayerGame: ratio(metrics.actionableCounterfactual, playerGames),
  actionableCounterfactualsPer100Decisions: ratio(metrics.actionableCounterfactual * 100, metrics.decisions),
  explorationPriorityComparisonsPerPlayerGame: ratio(
    explorationPriorityComparisons,
    playerGames
  ),
  duplicateDecisionGroupRate: ratio(metrics.duplicateDecisionGroups, metrics.decisionGroups),
  setupRate: ratio(metrics.setup, metrics.decisions),
  signContradictionRate: ratio(metrics.signContradictions, metrics.decisions),
  version2Rate: ratio(metrics.version2, metrics.decisions),
  averageCreditWeight: ratio(metrics.creditWeightTotal, metrics.credited),
  policyFeatureCoverage,
  phaseCredit: summarizeCredit(metrics.phaseCredit, metrics.creditWeightTotal),
  actionCredit: summarizeCredit(metrics.actionCredit, metrics.creditWeightTotal),
  actionOpportunityCoverage: summarizeActionOpportunityCoverage(metrics),
  samplingTelemetry: {
    available: metrics.telemetryRows > 0,
    playerGames: metrics.telemetryRows,
    duplicateRows: metrics.duplicateTelemetryRows,
    decisionOpportunities: metrics.telemetryDecisionOpportunities,
    explorations: metrics.telemetryExplorations,
    explorationProbes: metrics.telemetryExplorationProbes,
    explorationActions: metrics.telemetryExplorationActions,
    counterfactualsEvaluated: metrics.telemetryCounterfactuals,
    actionableCounterfactuals: metrics.telemetryActionableCounterfactuals,
    unsynchronizedCounterfactuals: metrics.telemetryUnsynchronizedCounterfactuals,
    lowInformationSkips: metrics.telemetryLowInformationSkips,
    counterfactualsPerPlayerGame: ratio(metrics.telemetryCounterfactuals, metrics.telemetryRows),
    actionableCounterfactualsPerPlayerGame: ratio(metrics.telemetryActionableCounterfactuals, metrics.telemetryRows),
    unsynchronizedCounterfactualRate: ratio(metrics.telemetryUnsynchronizedCounterfactuals, metrics.telemetryCounterfactuals),
    counterfactualGameCoverage: ratio(metrics.telemetryGamesWithCounterfactual, metrics.telemetryRows),
    actionableCounterfactualGameCoverage: ratio(metrics.telemetryGamesWithActionableCounterfactual, metrics.telemetryRows)
  },
  counterfactualInformation: {
    averageScore: ratio(metrics.counterfactualInformationScoreTotal, metrics.counterfactualInformationScoreCount),
    minScore: metrics.counterfactualInformationScoreMin,
    maxScore: metrics.counterfactualInformationScoreMax,
    reasons: metrics.counterfactualInformationReasons,
    samplingReasons: metrics.counterfactualSamplingReasons,
    explorationPriorityCount: explorationPriorityComparisons
  },
  pairwiseEvidenceDiversity: summarizePairwiseEvidenceDiversity(metrics),
  pairwiseInputConsistency: summarizePairwiseInputConsistencyLedger(pairwiseInputConsistencyLedger)
};

const outPath = option("--out");
if (outPath) writeJsonAtomicSync(outPath, output);
console.log(JSON.stringify(output, null, 2));

async function auditFile(file) {
  metrics.bytes += statSync(file).size;
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let currentDecisionKey = null;
  let currentDecisionGroup = [];
  for await (const line of lines) {
    if (!line.trim()) continue;
    metrics.rows += 1;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      metrics.parseErrors += 1;
      continue;
    }
    if (isLearningGameTelemetry(row)) {
      if (currentDecisionGroup.length > 0) auditDecisionGroup(currentDecisionGroup);
      currentDecisionKey = null;
      currentDecisionGroup = [];
      const fingerprint = learningGameTelemetryFingerprint(row);
      if (seenTelemetryFingerprints.has(fingerprint)) {
        metrics.duplicateTelemetryRows += 1;
        continue;
      }
      seenTelemetryFingerprints.add(fingerprint);
      metrics.telemetryRows += 1;
      const counterfactuals = Math.max(0, Number(row.counterfactualsEvaluated ?? 0));
      const actionable = Math.max(0, Number(row.actionableCounterfactuals ?? 0));
      metrics.telemetryCounterfactuals += counterfactuals;
      metrics.telemetryActionableCounterfactuals += actionable;
      metrics.telemetryUnsynchronizedCounterfactuals += Math.max(0, Number(row.unsynchronizedCounterfactuals ?? 0));
      metrics.telemetryDecisionOpportunities += Math.max(0, Number(row.decisionOpportunities ?? 0));
      metrics.telemetryExplorations += Math.max(0, Number(row.explorationDecisions ?? 0));
      metrics.telemetryExplorationProbes += Math.max(0, Number(row.explorationProbeDecisions ?? 0));
      metrics.telemetryExplorationActions += Math.max(0, Number(row.explorationActionDecisions ?? 0));
      metrics.telemetryLowInformationSkips += Math.max(0, Number(row.counterfactualLowInformationSkips ?? 0));
      if (counterfactuals > 0) metrics.telemetryGamesWithCounterfactual += 1;
      if (actionable > 0) metrics.telemetryGamesWithActionableCounterfactual += 1;
      continue;
    }
    const decisionKey = row.decisionKey ?? fallbackDecisionKey(row);
    if (currentDecisionKey !== null && decisionKey !== currentDecisionKey) {
      auditDecisionGroup(currentDecisionGroup);
      currentDecisionGroup = [];
    }
    currentDecisionKey = decisionKey;
    currentDecisionGroup.push(row);
    for (const [feature, rawValue] of Object.entries(row.features ?? {})) {
      const value = Number(rawValue ?? 0);
      if (Number.isFinite(value) && value !== 0) increment(metrics.candidateFeatureUses, feature);
    }
    increment(metrics.candidateActionUses, row.actionType ?? row.action?.type ?? "unknown");
    if (featurePositive(row.features, "playRaidCardNormally")) metrics.raidNormalPlayOptions += 1;
    if (!row.chosen) continue;
    metrics.decisions += 1;
    const outcome = String(row.outcome ?? "incomplete").toLowerCase();
    if (outcome === "win") metrics.wins += 1;
    else if (outcome === "loss") metrics.losses += 1;
    else metrics.incomplete += 1;
    if (Number(row.candidateCount ?? 2) <= 1) metrics.forced += 1;
    const eligible = row.learningEligible === true
      || (row.learningEligible !== false && outcome !== "incomplete" && Number(row.candidateCount ?? 2) > 1);
    if (eligible) metrics.eligible += 1;
    if (row.explorationReason || row.action?.explorationReason) {
      metrics.exploration += 1;
      increment(metrics.explorationModes, row.explorationMode ?? "legacy-action");
    }
    if (featurePositive(row.features, "playRaidCardNormally")) {
      metrics.chosenRaidNormalPlay += 1;
      if (row.explorationReason === "raid-normal-play" || row.action?.explorationReason === "raid-normal-play") {
        metrics.chosenRaidNormalPlayExploration += 1;
      }
    }
    if ((row.actionType ?? row.action?.type) === "performRaid") metrics.chosenRaidActions += 1;
    const counterfactualPreference = String(row.counterfactualPreference ?? row.counterfactual?.preference ?? "").toLowerCase();
    if (counterfactualPreference) {
      metrics.counterfactual += 1;
      increment(metrics.counterfactualPreferences, counterfactualPreference);
      increment(metrics.counterfactualEvidenceKinds, row.counterfactualEvidenceKind ?? row.counterfactual?.evidenceKind ?? "legacy-unknown");
      increment(metrics.counterfactualStateEvaluationVersions, row.counterfactualStateEvaluationVersion ?? row.counterfactual?.stateEvaluationVersion ?? 1);
      increment(metrics.counterfactualTargetPhases, row.counterfactualTargetPhase ?? row.counterfactual?.targetPhase ?? "unknown");
      increment(metrics.counterfactualDecisionPhases, row.counterfactualDecisionPhase ?? row.counterfactual?.decisionPhase ?? row.creditPhase ?? row.phase ?? "unknown");
      increment(metrics.counterfactualAlternativeSelections, row.counterfactualAlternativeSelection ?? row.counterfactual?.alternativeSelection ?? "unknown");
      increment(metrics.counterfactualInformationReasons, row.counterfactualInformationReason ?? row.counterfactual?.informationReason ?? "unknown");
      increment(metrics.counterfactualSamplingReasons, row.counterfactualSamplingReason ?? row.counterfactual?.samplingReason ?? "unknown");
      const rawInformationScore = row.counterfactualInformationScore ?? row.counterfactual?.informationScore;
      const informationScore = Number(rawInformationScore);
      if (rawInformationScore !== undefined && rawInformationScore !== null && Number.isFinite(informationScore)) {
        metrics.counterfactualInformationScoreCount += 1;
        metrics.counterfactualInformationScoreTotal += informationScore;
        metrics.counterfactualInformationScoreMin = metrics.counterfactualInformationScoreMin === null
          ? informationScore
          : Math.min(metrics.counterfactualInformationScoreMin, informationScore);
        metrics.counterfactualInformationScoreMax = metrics.counterfactualInformationScoreMax === null
          ? informationScore
          : Math.max(metrics.counterfactualInformationScoreMax, informationScore);
      }
      if (row.counterfactualFallbackUsed || row.counterfactual?.fallbackUsed) metrics.counterfactualFallbacks += 1;
    }
    if (row.actionType === "keepHand" || row.actionType === "mulligan" || String(row.step ?? "").startsWith("setup-")) metrics.setup += 1;
    const target = Number(row.shapedReward ?? row.reward ?? 0);
    if ((outcome === "win" && target <= 0) || (outcome === "loss" && target >= 0)) metrics.signContradictions += 1;
    if (Number(row.learningSignalVersion ?? 1) >= 2) metrics.version2 += 1;
    const creditWeight = Number(row.creditWeight);
    if (Number.isFinite(creditWeight) && creditWeight > 0) {
      metrics.credited += 1;
      metrics.creditWeightTotal += creditWeight;
      add(metrics.phaseCredit, row.creditPhase ?? row.phase ?? "unknown", creditWeight);
      add(metrics.actionCredit, row.actionType ?? row.action?.type ?? "unknown", creditWeight);
    }
    for (const [feature, rawValue] of Object.entries(row.features ?? {})) {
      const value = Number(rawValue ?? 0);
      if (Number.isFinite(value) && value !== 0) increment(metrics.chosenFeatureUses, feature);
    }
    increment(metrics.phases, row.phase ?? "unknown");
    increment(metrics.actions, row.actionType ?? row.action?.type ?? "unknown");
    const gameKey = [file, row.seed, row.candidateId, row.player].join(":");
    metrics.gameDecisionCounts.set(gameKey, (metrics.gameDecisionCounts.get(gameKey) ?? 0) + 1);
  }
  if (currentDecisionGroup.length > 0) auditDecisionGroup(currentDecisionGroup);
}

function auditDecisionGroup(group) {
  if (!group.some((row) => row.chosen)) return;
  metrics.decisionGroups += 1;
  const fingerprint = learningDecisionGroupFingerprint(group);
  if (seenDecisionFingerprints.has(fingerprint)) {
    metrics.duplicateDecisionGroups += 1;
    metrics.duplicateDecisionRows += group.length;
    return;
  }
  seenDecisionFingerprints.add(fingerprint);
  metrics.uniqueDecisionGroups += 1;
  auditResolutionChoiceCoverage(group);
  auditStrategicActionCoverage(group);
  const chosen = group.find((row) => row.chosen);
  const evidence = counterfactualPairwiseLearningEvidence(chosen);
  if (!evidence) return;
  const alternatives = counterfactualAlternativeRows(group, chosen);
  if (alternatives.length === 0) return;
  metrics.actionableCounterfactual += 1;
  for (const alternative of alternatives) {
    increment(metrics.causallyTestedActionUses, alternative.actionType ?? alternative.action?.type ?? "unknown");
    const keys = pairwiseEvidenceDiversityKeys(chosen, alternative, evidence);
    metrics.pairwiseEvidenceTracked += 1;
    increment(metrics.pairwiseEvidencePhases, keys.phase);
    increment(metrics.pairwiseEvidenceActionPairs, keys.actionPair);
    increment(metrics.pairwiseEvidenceOpponentProfiles, keys.opponentProfile);
    increment(metrics.pairwiseEvidenceKinds, keys.evidenceKind);
    recordPairwiseInputConsistency(pairwiseInputConsistencyLedger, {
      features: pairwiseFeatureDifference(chosen.features, alternative.features),
      target: evidence.direction,
      weight: pairwiseAuditWeight(chosen, evidence),
      metadata: {
        ...keys,
        playerGame: [chosen.ownKey ?? chosen.deckId ?? "deck", chosen.opponent ?? chosen.matchupProfileKey ?? "opponent", chosen.seed ?? chosen.gameIndex ?? "game"].join("|")
      }
    });
  }
}

function pairwiseAuditWeight(row, evidence) {
  if (Number(row.learningSignalVersion ?? 1) < 2) return 0;
  if (row.learningEligible === false || String(row.outcome ?? "").toLowerCase() === "incomplete") return 0;
  if (Number(row.candidateCount ?? 2) <= 1) return 0;
  const creditWeight = Number(row.creditWeight ?? 1);
  if (!Number.isFinite(creditWeight) || creditWeight <= 0) return 0;
  return creditWeight * Number(evidence.magnitude ?? 1) * Number(evidence.confidence ?? 1) * 0.7;
}

function decisionLogFiles(path) {
  if (!existsSync(path)) throw new Error(`Input path not found: ${path}`);
  const stats = statSync(path);
  if (stats.isFile()) return path.endsWith(".jsonl") ? [path] : [];
  const files = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...decisionLogFiles(child));
    else if (entry.isFile() && entry.name === "decision-log.jsonl") files.push(child);
  }
  return files;
}

function inputPaths() {
  const value = option("--input") ?? option("--inputs");
  return String(value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
}

function fallbackDecisionKey(row) {
  return [
    row.candidateId ?? "candidate",
    row.gameIndex ?? "game",
    row.player ?? "player",
    row.step ?? "step"
  ].join(":");
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function increment(record, key) {
  record[key] = (record[key] ?? 0) + 1;
}

function featurePositive(features = {}, feature) {
  const value = Number(features?.[feature] ?? 0);
  return Number.isFinite(value) && value > 0;
}

function add(record, key, value) {
  record[key] = (record[key] ?? 0) + Number(value ?? 0);
}

function summarizePolicyFeatureCoverage(featureUses) {
  const policyFeatures = Object.keys(DEFAULT_PILOT_POLICY.weights).filter((feature) => feature !== "baseScore");
  const observed = policyFeatures.filter((feature) => Number(featureUses[feature] ?? 0) > 0);
  const unobserved = policyFeatures.filter((feature) => Number(featureUses[feature] ?? 0) === 0);
  const groups = {};
  for (const feature of policyFeatures) {
    const group = pilotPolicyFeatureGroup(feature);
    groups[group] ??= { total: 0, observed: 0, uses: 0, unobserved: [] };
    groups[group].total += 1;
    groups[group].uses += Number(featureUses[feature] ?? 0);
    if (Number(featureUses[feature] ?? 0) > 0) groups[group].observed += 1;
    else groups[group].unobserved.push(feature);
  }
  return {
    totalBehavioralFeatures: policyFeatures.length,
    observedBehavioralFeatures: observed.length,
    coverageRate: ratio(observed.length, policyFeatures.length),
    unobservedPolicyFeatures: unobserved,
    observedNonPolicyFeatures: Object.keys(featureUses)
      .filter((feature) => feature !== "baseScore" && !Object.hasOwn(DEFAULT_PILOT_POLICY.weights, feature))
      .sort((a, b) => a.localeCompare(b)),
    groups
  };
}

function summarizeCredit(record, total) {
  return Object.entries(record)
    .map(([key, credit]) => ({ key, credit: Number(credit.toFixed(6)), share: ratio(credit, total) }))
    .sort((a, b) => b.credit - a.credit || a.key.localeCompare(b.key));
}

function summarizeActionOpportunityCoverage(data) {
  const chosenActionKeys = new Set(Object.keys(data.actions ?? {}));
  const causallyTestedActionKeys = new Set(Object.entries(data.causallyTestedActionUses ?? {})
    .filter(([, count]) => Number(count) > 0)
    .map(([key]) => key));
  const candidateOnlyActions = Object.keys(data.candidateActionUses ?? {})
    .filter((key) => !chosenActionKeys.has(key))
    .sort((a, b) => Number(data.candidateActionUses[b] ?? 0) - Number(data.candidateActionUses[a] ?? 0) || a.localeCompare(b));
  const candidateOnlyUncoveredActions = candidateOnlyActions
    .filter((key) => !causallyTestedActionKeys.has(key));
  return {
    loggedActionTypes: Object.keys(data.candidateActionUses ?? {}).length,
    chosenActionTypes: Object.keys(data.actions ?? {}).length,
    causallyTestedActionTypes: causallyTestedActionKeys.size,
    causallyTestedActions: data.causallyTestedActionUses ?? {},
    candidateOnlyActionCount: candidateOnlyActions.length,
    candidateOnlyActions: candidateOnlyActions.slice(0, 12),
    candidateOnlyUncoveredActionCount: candidateOnlyUncoveredActions.length,
    candidateOnlyUncoveredActions: candidateOnlyUncoveredActions.slice(0, 12),
    raidNormalPlay: {
      available: Number(data.raidNormalPlayCoverage?.available ?? data.raidNormalPlayOptions ?? 0),
      chosen: Number(data.raidNormalPlayCoverage?.chosen ?? data.chosenRaidNormalPlay ?? 0),
      causallyTested: Number(data.raidNormalPlayCoverage?.causallyTested ?? 0),
      covered: Number(data.raidNormalPlayCoverage?.covered ?? data.chosenRaidNormalPlay ?? 0),
      chosenRate: ratio(
        Number(data.raidNormalPlayCoverage?.chosen ?? data.chosenRaidNormalPlay ?? 0),
        Number(data.raidNormalPlayCoverage?.available ?? data.raidNormalPlayOptions ?? 0)
      ),
      causalRate: ratio(data.raidNormalPlayCoverage?.causallyTested, data.raidNormalPlayCoverage?.available),
      coverageRate: ratio(data.raidNormalPlayCoverage?.covered, data.raidNormalPlayCoverage?.available),
      chosenExploration: Number(data.chosenRaidNormalPlayExploration ?? 0),
      chosenRaidActions: Number(data.chosenRaidActions ?? 0)
    },
    resolutionChoices: summarizeResolutionChoiceCoverage(data.resolutionChoiceCoverage),
    raidPlacement: summarizeAuditBranchCoverage(data.raidPlacementCoverage),
    fieldReplacement: {
      available: Number(data.fieldReplacementCoverage?.available ?? 0),
      chosen: Number(data.fieldReplacementCoverage?.chosen ?? 0),
      causallyTested: Number(data.fieldReplacementCoverage?.causallyTested ?? 0),
      covered: Number(data.fieldReplacementCoverage?.covered ?? 0),
      chosenRate: ratio(data.fieldReplacementCoverage?.chosen, data.fieldReplacementCoverage?.available),
      causalRate: ratio(data.fieldReplacementCoverage?.causallyTested, data.fieldReplacementCoverage?.available),
      coverageRate: ratio(data.fieldReplacementCoverage?.covered, data.fieldReplacementCoverage?.available)
    }
  };
}

function auditResolutionChoiceCoverage(group) {
  const chosen = group.find((row) => row.chosen);
  if (!chosen || String(chosen.action?.type ?? chosen.actionType) !== "resolutionChoice") return;
  const chosenFamily = resolutionChoiceFamily(chosen);
  if (!chosenFamily) return;
  const prefix = `resolutionChoice:${chosenFamily.kind}:`;
  const causalFamilies = new Set(counterfactualTestedActionFamilies(group, chosen));
  const options = new Set(decisionActionFamilies(group)
    .filter((family) => family.startsWith(prefix))
    .map((family) => family.slice(prefix.length))
    .filter(Boolean));
  if (options.size <= 1) return;
  const item = metrics.resolutionChoiceCoverage[chosenFamily.kind] ?? {
    decisions: 0,
    options: {}
  };
  item.decisions += 1;
  for (const option of options) {
    const optionRow = item.options[option] ?? { available: 0, chosen: 0, causallyTested: 0, covered: 0 };
    const chosenOption = option === chosenFamily.option;
    const causallyTested = causalFamilies.has(`${prefix}${option}`);
    optionRow.available += 1;
    if (chosenOption) optionRow.chosen += 1;
    if (causallyTested) optionRow.causallyTested += 1;
    if (chosenOption || causallyTested) optionRow.covered += 1;
    item.options[option] = optionRow;
  }
  metrics.resolutionChoiceCoverage[chosenFamily.kind] = item;
}

function resolutionChoiceFamily(row) {
  const family = pairwiseActionFamily(row);
  if (!family.startsWith("resolutionChoice:")) return null;
  const [, kind, ...optionParts] = family.split(":");
  return { kind: kind || "unknown", option: optionParts.join(":") || "choice" };
}

function summarizeResolutionChoiceCoverage(coverage = {}) {
  const kinds = Object.entries(coverage)
    .map(([kind, item]) => ({
      kind,
      decisions: Number(item.decisions ?? 0),
      options: Object.entries(item.options ?? {})
        .map(([option, counts]) => ({
          option,
          available: Number(counts.available ?? 0),
          chosen: Number(counts.chosen ?? 0),
          causallyTested: Number(counts.causallyTested ?? 0),
          covered: Number(counts.covered ?? 0),
          chosenRate: ratio(counts.chosen, counts.available),
          causalRate: ratio(counts.causallyTested, counts.available),
          coverageRate: ratio(counts.covered, counts.available)
        }))
        .sort((left, right) => right.available - left.available || left.option.localeCompare(right.option))
    }))
    .sort((left, right) => right.decisions - left.decisions || left.kind.localeCompare(right.kind));
  return {
    decisions: kinds.reduce((total, item) => total + item.decisions, 0),
    kinds
  };
}

function auditStrategicActionCoverage(group) {
  const chosen = group.find((row) => row.chosen);
  if (!chosen) return;
  const families = decisionActionFamilies(group);
  const causalFamilies = new Set(counterfactualTestedActionFamilies(group, chosen));
  const raidNormalAvailable = group.some((row) => featurePositive(row.features, "playRaidCardNormally"));
  const raidAvailable = families.some((family) => family === "performRaid" || family.startsWith("performRaid:"));
  if (raidNormalAvailable && raidAvailable) {
    const chosenNormal = featurePositive(chosen.features, "playRaidCardNormally");
    const causallyTestedNormal = counterfactualAlternativeRows(group, chosen)
      .some((row) => featurePositive(row.features, "playRaidCardNormally"));
    metrics.raidNormalPlayCoverage.available += 1;
    if (chosenNormal) metrics.raidNormalPlayCoverage.chosen += 1;
    if (causallyTestedNormal) metrics.raidNormalPlayCoverage.causallyTested += 1;
    if (chosenNormal || causallyTestedNormal) metrics.raidNormalPlayCoverage.covered += 1;
  }
  const raidOptions = new Set(families
    .filter((family) => family.startsWith("performRaid:"))
    .map((family) => family.slice("performRaid:".length)));
  if (raidOptions.size > 1) {
    metrics.raidPlacementCoverage.decisions += 1;
    const chosenFamily = pairwiseActionFamily(chosen);
    const chosenOption = chosenFamily.startsWith("performRaid:")
      ? chosenFamily.slice("performRaid:".length)
      : null;
    for (const option of raidOptions) {
      const row = metrics.raidPlacementCoverage.options[option] ?? { available: 0, chosen: 0, causallyTested: 0, covered: 0 };
      const chosenOptionMatch = option === chosenOption;
      const causallyTested = causalFamilies.has(`performRaid:${option}`);
      row.available += 1;
      if (chosenOptionMatch) row.chosen += 1;
      if (causallyTested) row.causallyTested += 1;
      if (chosenOptionMatch || causallyTested) row.covered += 1;
      metrics.raidPlacementCoverage.options[option] = row;
    }
  }

  const hasReplacement = families.some(isReplacementActionFamily)
    || group.some((row) => row.action?.replacesPermanent === true || featurePositive(row.features, "replacementValue"));
  if (hasReplacement) {
    const chosenReplacement = isReplacementActionFamily(pairwiseActionFamily(chosen))
      || chosen.action?.replacesPermanent === true
      || featurePositive(chosen.features, "replacementValue");
    const causallyTestedReplacement = [...causalFamilies].some(isReplacementActionFamily);
    metrics.fieldReplacementCoverage.available += 1;
    if (chosenReplacement) metrics.fieldReplacementCoverage.chosen += 1;
    if (causallyTestedReplacement) metrics.fieldReplacementCoverage.causallyTested += 1;
    if (chosenReplacement || causallyTestedReplacement) metrics.fieldReplacementCoverage.covered += 1;
  }
}

function isReplacementActionFamily(family) {
  return family === "performRaid:move-front-replace"
    || (family.startsWith("playCard:") && family.endsWith(":replace"));
}

function summarizeAuditBranchCoverage(coverage = {}) {
  return {
    decisions: Number(coverage.decisions ?? 0),
    options: Object.entries(coverage.options ?? {})
      .map(([option, counts]) => ({
        option,
        available: Number(counts.available ?? 0),
        chosen: Number(counts.chosen ?? 0),
        causallyTested: Number(counts.causallyTested ?? 0),
        covered: Number(counts.covered ?? 0),
        chosenRate: ratio(counts.chosen, counts.available),
        causalRate: ratio(counts.causallyTested, counts.available),
        coverageRate: ratio(counts.covered, counts.available)
      }))
      .sort((left, right) => right.available - left.available || left.option.localeCompare(right.option))
  };
}

function summarizePairwiseEvidenceDiversity(data) {
  const dominantActionPair = dominantCountEntry(data.pairwiseEvidenceActionPairs);
  const dominantPhase = dominantCountEntry(data.pairwiseEvidencePhases);
  const dominantOpponentProfile = dominantCountEntry(data.pairwiseEvidenceOpponentProfiles);
  return {
    trackedExamples: Number(data.pairwiseEvidenceTracked ?? 0),
    distinctPhases: knownKeys(data.pairwiseEvidencePhases).length,
    distinctActionPairs: Object.keys(data.pairwiseEvidenceActionPairs ?? {}).length,
    distinctOpponentProfiles: knownKeys(data.pairwiseEvidenceOpponentProfiles).length,
    phaseCounts: data.pairwiseEvidencePhases,
    actionPairCounts: data.pairwiseEvidenceActionPairs,
    opponentProfileCounts: data.pairwiseEvidenceOpponentProfiles,
    evidenceKindCounts: data.pairwiseEvidenceKinds,
    dominantPhase: dominantPhase?.key ?? null,
    dominantPhaseRate: ratio(dominantPhase?.count ?? 0, countTotal(data.pairwiseEvidencePhases)),
    dominantActionPair: dominantActionPair?.key ?? null,
    dominantActionPairRate: ratio(dominantActionPair?.count ?? 0, countTotal(data.pairwiseEvidenceActionPairs)),
    dominantOpponentProfile: dominantOpponentProfile?.key ?? null,
    dominantOpponentProfileRate: ratio(dominantOpponentProfile?.count ?? 0, countTotal(data.pairwiseEvidenceOpponentProfiles))
  };
}

function knownKeys(counts = {}) {
  return Object.keys(counts ?? {}).filter((key) => key !== "unknown");
}

function countTotal(counts = {}) {
  return Object.values(counts ?? {}).reduce((total, count) => total + Number(count ?? 0), 0);
}

function dominantCountEntry(counts = {}) {
  return Object.entries(counts ?? {}).reduce((best, [key, count]) => {
    if (!best || count > best.count || (count === best.count && key.localeCompare(best.key) < 0)) {
      return { key, count };
    }
    return best;
  }, null);
}

function average(values) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function usage() {
  console.log(`Usage:
  node tools/audit-learning-data.mjs --input <run-or-log>[,<run-or-log>...] [options]

Options:
  --max-files <n>   Audit only the newest n matching decision logs.
  --out <path>      Write the JSON audit report atomically.`);
}
