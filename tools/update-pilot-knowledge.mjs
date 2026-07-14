#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { writeJsonAtomicSync, writeTextAtomicSync } from "../src/artifact-io.js";
import {
  COUNTERFACTUAL_STATE_EVALUATION_VERSION,
  DEFAULT_PILOT_POLICY,
  MAX_ADAPTIVE_AUDIT_DISAGREEMENT_RATE,
  MIN_LEARNING_EVIDENCE_FILTER_VERSION,
  MIN_LEARNING_SOURCE_DIGEST_VERSION,
  MIN_ADAPTIVE_AUDIT_BLOCK_SAMPLES,
  MIN_ML_EVIDENCE_DIVERSITY_VERSION,
  MIN_ML_PAIRWISE_INPUT_CONSISTENCY_VERSION,
  MIN_ML_PAIRWISE_EFFECTIVE_WEIGHT_VERSION,
  MIN_ML_RUNTIME_DISTINCT_ACTION_PAIRS,
  MIN_ML_RUNTIME_DISTINCT_OPPONENTS,
  MIN_ML_RUNTIME_DISTINCT_PHASES,
  MIN_ML_RUNTIME_DIVERSITY_EXAMPLES,
  MIN_ML_RUNTIME_PAIRWISE_EFFECTIVE_WEIGHT,
  MIN_ML_RUNTIME_HELDOUT_GAMES,
  MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_GAMES,
  MIN_ML_RUNTIME_VALIDATION_PAIRWISE_EFFECTIVE_WEIGHT,
  MIN_ML_PAIRWISE_ORIENTATION_VERSION,
  MIN_ML_REGRESSION_VERSION,
  MIN_ML_VALIDATION_DIVERSITY_VERSION,
  MIN_ML_VALIDATION_STATE_VERSION,
  counterfactualAlternativeRows,
  counterfactualPairwiseLearningEvidence,
  counterfactualTestedActionFamilies,
  createPairwiseInputConsistencyLedger,
  decisionActionFamilies,
  isLearningGameTelemetry,
  learningDecisionGroupFingerprint,
  learningGameTelemetryFingerprint,
  mlActionModelRuntimeTrust,
  mlPairwiseEvidenceDiversity,
  mlValidationInputConsistency,
  mlValidationEvidenceDiversity,
  pairwiseEvidenceDiversityKeys,
  pairwiseActionFamily,
  pairwiseFeatureDifference,
  matchupOverlayReadiness,
  matchupOverlayRuntimeTrust,
  pilotPolicyFeatureGroup,
  recordPairwiseInputConsistency,
  summarizePairwiseInputConsistencyLedger
} from "../src/index.js";
import {
  actionModelPathForKey,
  matchupOverlayCandidateFilesForKey,
  matchupOverlayFilesForKey,
  policyKeySegment
} from "../src/policy-router.js";

const DEFAULT_AGENT_ROOT = "work/private/pilot-agent";
const DEFAULT_POLICY_DIR = "work/private/pilot-agent/policies";

const inputs = inputPaths();

if (hasFlag("--help") || inputs.length === 0) {
  usage();
  process.exit(inputs.length === 0 ? 1 : 0);
}

const agentRoot = option("--agent-root") ?? DEFAULT_AGENT_ROOT;
const policyDir = option("--policy-dir") ?? DEFAULT_POLICY_DIR;
const baselineRoot = option("--baseline-root") ?? join(agentRoot, "baselines");
const outDir = option("--out-dir") ?? join(agentRoot, "knowledge-updates", timestamp());
const player = option("--player") ?? "P1";
const ownKey = option("--own-key") ?? inferOwnKey(inputs);
const deckId = option("--deck") ?? inferDeckId(inputs) ?? "carnerr-spear";
const learningMode = option("--learning-mode") ?? option("--candidate-mode") ?? "pairwise";
const legacyWeightCap = option("--legacy-weight-cap") ?? "5000";
const pairwiseScale = option("--pairwise-scale") ?? "0.7";
const maxModelFeatures = option("--max-model-features") ?? "512";
const minContextualObservations = option("--min-contextual-observations") ?? "24";
const serialArtifactTraining = hasFlag("--serial-artifact-training");

if (!ownKey) {
  throw new Error("Could not infer --own-key from report.json. Pass --own-key eva-purple or another policy profile key.");
}

const decisionFiles = [...new Set(inputs.flatMap(decisionLogFiles))];
if (decisionFiles.length === 0) throw new Error(`No decision-log.jsonl files found under: ${inputs.join(", ")}`);

mkdirSync(outDir, { recursive: true });

const commands = [];
const trainingJobs = [];
const overlayBefore = overlaySnapshot(policyDir, ownKey, baselineRoot);
const mlOut = option("--ml-out") ?? profileActionModelPath(agentRoot, ownKey, baselineRoot);
const mergeExisting = !hasFlag("--no-merge-existing");
const previousMlSourceFiles = existingSourceFiles(mlOut);
const previousOverlaySourceFiles = existingOverlaySourceFiles(policyDir, ownKey, baselineRoot);
const mlInputPaths = inputs;
const overlayInputPaths = inputs;
const summary = await summarizeDecisionFiles(decisionFiles, { player, pairwiseScale: Number(pairwiseScale) });
const preflightLearningHealth = learningHealthSummary({
  decisions: summary,
  mlModel: null,
  overlays: null,
  overlayChanges: null,
  preflight: true
});
const preflightBlocked = preflightLearningHealth.status === "blocked" && !hasFlag("--force-knowledge-training");
let prunedKnownDeckOverlays = [];
if (preflightBlocked) {
  console.log(`Knowledge preflight blocked training: ${(preflightLearningHealth.blockers ?? []).join("; ") || "unknown blocker"}.`);
} else {
  const mlInputsFile = writeInputListFile(join(outDir, "ml-inputs.txt"), mlInputPaths);
  const overlayInputsFile = writeInputListFile(join(outDir, "overlay-inputs.txt"), overlayInputPaths);
  if (!hasFlag("--skip-ml")) {
    const args = [
      "tools/train-ml-scorer.mjs",
      "--inputs-file", mlInputsFile,
      "--out", mlOut,
      "--name", option("--ml-name") ?? `${ownKey}-action-model`,
      "--player", option("--ml-player") ?? player,
      "--min-observations", option("--ml-min-observations") ?? option("--min-observations") ?? "12",
      "--scale", option("--ml-scale") ?? option("--scale") ?? "120",
      "--l2", option("--ml-l2") ?? option("--l2") ?? "8",
      "--max-weight", option("--ml-max-weight") ?? option("--max-weight") ?? "260",
      "--max-model-features", option("--ml-max-model-features") ?? maxModelFeatures,
      "--min-contextual-observations", option("--ml-min-contextual-observations") ?? minContextualObservations,
      "--learning-mode", option("--ml-learning-mode") ?? learningMode,
      "--pairwise-scale", pairwiseScale,
      "--validation-fraction", option("--validation-fraction") ?? "0.2",
      "--validation-max-examples", option("--validation-max-examples") ?? "5000",
      "--legacy-weight-cap", legacyWeightCap
    ];
    appendChosenAnchorArgs(args);
    if (mergeExisting) args.push("--incremental");
    trainingJobs.push({ label: "ml-action-model", args });
  }

  if (!hasFlag("--skip-profile-overlays")) {
    const args = [
      "tools/train-matchup-overlays.mjs",
      "--inputs-file", overlayInputsFile,
      "--own-key", ownKey,
      "--player", player,
      "--policy-dir", policyDir,
      "--baseline-root", baselineRoot,
      "--group-by", "profile",
      "--min-examples", option("--profile-min-examples") ?? option("--min-examples") ?? "80",
      "--min-observations", option("--profile-min-observations") ?? option("--min-observations") ?? "12",
      "--scale", option("--profile-scale") ?? option("--scale") ?? "120",
      "--l2", option("--profile-l2") ?? option("--l2") ?? "8",
      "--max-weight", option("--profile-max-weight") ?? option("--max-weight") ?? "260",
      "--max-model-features", option("--profile-max-model-features") ?? maxModelFeatures,
      "--min-contextual-observations", option("--profile-min-contextual-observations") ?? minContextualObservations,
      "--learning-mode", option("--overlay-learning-mode") ?? learningMode,
      "--pairwise-scale", pairwiseScale,
      "--legacy-weight-cap", legacyWeightCap
    ];
    appendChosenAnchorArgs(args);
    if (mergeExisting) args.push("--incremental");
    trainingJobs.push({ label: "profile-matchup-overlays", args });
  }

  if (!hasFlag("--skip-variant-overlays")) {
    const args = [
      "tools/train-matchup-overlays.mjs",
      "--inputs-file", overlayInputsFile,
      "--own-key", ownKey,
      "--player", player,
      "--policy-dir", policyDir,
      "--baseline-root", baselineRoot,
      "--group-by", "variant",
      "--min-examples", option("--variant-min-examples") ?? option("--min-examples") ?? "80",
      "--min-observations", option("--variant-min-observations") ?? option("--min-observations") ?? "12",
      "--scale", option("--variant-scale") ?? option("--scale") ?? "120",
      "--l2", option("--variant-l2") ?? option("--l2") ?? "8",
      "--max-weight", option("--variant-max-weight") ?? option("--max-weight") ?? "260",
      "--max-model-features", option("--variant-max-model-features") ?? maxModelFeatures,
      "--min-contextual-observations", option("--variant-min-contextual-observations") ?? minContextualObservations,
      "--learning-mode", option("--overlay-learning-mode") ?? learningMode,
      "--pairwise-scale", pairwiseScale,
      "--legacy-weight-cap", legacyWeightCap
    ];
    appendChosenAnchorArgs(args);
    if (mergeExisting) args.push("--incremental");
    trainingJobs.push({ label: "variant-matchup-overlays", args });
  }

  commands.push(...await runNodeTools(trainingJobs, { serial: serialArtifactTraining }));
  prunedKnownDeckOverlays = hasFlag("--keep-known-deck-overlays")
    ? []
    : pruneKnownDeckOverlays(policyDir, ownKey, baselineRoot);
}
let mlModel = modelSummary(mlOut);
let overlays = overlaySummary(policyDir, ownKey, baselineRoot);
const overlayChangeSummary = overlayChanges(overlayBefore, overlaySnapshot(policyDir, ownKey, baselineRoot));
const learningHealth = preflightBlocked
  ? preflightLearningHealth
  : learningHealthSummary({
    decisions: summary,
    mlModel,
    overlays,
    overlayChanges: overlayChangeSummary
  });
const stampedLearningArtifacts = stampLearningHealthOnArtifacts({
  mlOut: hasFlag("--skip-ml") ? null : mlOut,
  previousMlSourceFiles,
  overlayChangeSummary,
  learningHealth
});
mlModel = modelSummary(mlOut);
overlays = overlaySummary(policyDir, ownKey, baselineRoot);
const manifest = {
  schema: "union-arena-local-engine/pilot-knowledge-update@1",
  createdAt: new Date().toISOString(),
  ownKey,
  player,
  inputs,
  learningInputs: {
    mergeExisting,
    incremental: mergeExisting,
    learningMode,
    artifactTraining: {
      mode: serialArtifactTraining ? "serial" : "parallel",
      jobs: commands.map((command) => command.label),
      concurrency: serialArtifactTraining ? Math.min(1, commands.length) : commands.length
    },
    legacyWeightCap: Number(legacyWeightCap),
    ml: mlInputPaths,
    overlays: overlayInputPaths,
    previousMlSourceFiles: previousMlSourceFiles.length,
    previousOverlaySourceFiles: previousOverlaySourceFiles.length,
    preflight: {
      blocked: preflightBlocked,
      forced: hasFlag("--force-knowledge-training"),
      status: preflightLearningHealth.status,
      blockers: preflightLearningHealth.blockers ?? []
    }
  },
  decisionFiles,
  commandResults: commands,
  mlModel,
  overlays,
  overlayChanges: overlayChangeSummary,
  stampedLearningArtifacts,
  prunedKnownDeckOverlays,
  decisions: summary,
  learningHealth,
  deckId,
  nextRun: recommendedNextRun({ ownKey, mlOut, deckId, agentRoot, policyDir, baselineRoot })
};

writeJsonAtomicSync(join(outDir, "knowledge-update.json"), manifest);
writeTextAtomicSync(join(outDir, "summary.md"), summaryMarkdown(manifest));
writeTextAtomicSync(join(outDir, "next-run.ps1"), `${manifest.nextRun}\n`);

console.log(`Updated pilot knowledge for ${ownKey}.`);
console.log(`Decision logs: ${decisionFiles.length}; chosen rows for ${player}: ${summary.chosenRows}.`);
console.log(`Action model: ${manifest.mlModel?.path ?? "skipped"}`);
console.log(`Overlay files for ${ownKey}: ${manifest.overlays.length}`);
console.log(`Manifest: ${join(outDir, "knowledge-update.json")}`);
console.log(`Summary: ${join(outDir, "summary.md")}`);

async function runNodeTools(jobs, { serial = false } = {}) {
  const records = serial
    ? await runNodeToolsSerial(jobs)
    : await Promise.all(jobs.map((job) => runNodeTool(job.label, job.args)));
  const failed = records.find((record) => record.status !== 0);
  if (failed) {
    throw new Error(`${failed.label} failed with exit code ${failed.status}.\n${failed.stderr || failed.stdout}`);
  }
  return records;
}

async function runNodeToolsSerial(jobs) {
  const records = [];
  for (const job of jobs) records.push(await runNodeTool(job.label, job.args));
  return records;
}

function runNodeTool(label, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const finish = (record) => {
      if (settled) return;
      settled = true;
      resolve(record);
    };
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      finish({
        label,
        command: `node ${args.join(" ")}`,
        status: 1,
        signal: null,
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: [Buffer.concat(stderr).toString("utf8").trim(), error.message].filter(Boolean).join("\n")
      });
    });
    child.on("exit", (status, signal) => {
      finish({
        label,
        command: `node ${args.join(" ")}`,
        status: status ?? (signal ? 1 : 0),
        signal: signal ?? null,
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim()
      });
    });
  });
}

function appendChosenAnchorArgs(args) {
  const explicitScale = option("--chosen-anchor-scale");
  if (explicitScale !== undefined || hasFlag("--include-chosen-anchor")) {
    args.push("--chosen-anchor-scale", explicitScale ?? "0.25");
    return;
  }
  args.push("--no-chosen-anchor");
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

function reportFiles(path) {
  if (!existsSync(path)) return [];
  const stats = statSync(path);
  if (stats.isFile()) return path.endsWith("report.json") ? [path] : [];
  const direct = join(path, "report.json");
  const files = existsSync(direct) ? [direct] : [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    files.push(...reportFiles(join(path, entry.name)));
  }
  return files;
}

function inferOwnKey(paths) {
  for (const file of [...new Set(paths.flatMap(reportFiles))]) {
    try {
      const report = JSON.parse(readFileSync(file, "utf8"));
      const key = report.config?.policySelection?.profile?.key
        ?? report.config?.matchupOverlaySelection?.profile?.key
        ?? report.analysis?.deckProfile?.key;
      if (key) return key;
    } catch {
      // Keep looking through child reports.
    }
  }
  return null;
}

function inferDeckId(paths) {
  for (const file of [...new Set(paths.flatMap(reportFiles))]) {
    try {
      const report = JSON.parse(readFileSync(file, "utf8"));
      const deckId = report.deck?.id
        ?? report.config?.policySelection?.profile?.deckId
        ?? report.config?.matchupOverlaySelection?.profile?.deckId;
      if (deckId) return deckId;
    } catch {
      // Keep looking through child reports.
    }
  }
  return null;
}

function existingSourceFiles(path) {
  const artifact = readJsonIfExists(path);
  return Array.isArray(artifact?.sourceFiles) ? artifact.sourceFiles.filter(Boolean) : [];
}

function existingOverlaySourceFiles(policyDir, ownKey, baselineRoot) {
  const files = [];
  const artifacts = [
    ...matchupOverlayFilesForKey(ownKey, { policyDir, baselineRoot }),
    ...matchupOverlayCandidateFilesForKey(ownKey, { policyDir, baselineRoot })
  ];
  for (const file of artifacts) {
    const overlay = readJsonIfExists(file.path);
    if (Array.isArray(overlay?.sourceFiles)) files.push(...overlay.sourceFiles.filter(Boolean));
  }
  return [...new Set(files)];
}

function mergedInputPaths(currentInputs, previousFiles) {
  const existingPrevious = previousFiles.filter((path) => {
    try {
      return existsSync(path);
    } catch {
      return false;
    }
  });
  return [...new Set([...existingPrevious, ...currentInputs])];
}

function writeInputListFile(path, rows) {
  writeTextAtomicSync(path, `${rows.join("\n")}\n`);
  return path;
}

function readJsonIfExists(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function stampLearningHealthOnArtifacts({
  mlOut,
  previousMlSourceFiles = [],
  overlayChangeSummary,
  learningHealth
} = {}) {
  const stamped = [];
  if (mlOut && modelHasNewSourceFiles(mlOut, previousMlSourceFiles)) {
    const row = stampLearningHealthOnJson(mlOut, learningHealth, "action-model");
    if (row) stamped.push(row);
  }
  for (const row of overlayChangeSummary?.rows ?? []) {
    if (!["created", "updated"].includes(row.status) || !row.path) continue;
    const stampedRow = stampLearningHealthOnJson(row.path, learningHealth, "matchup-overlay");
    if (stampedRow) stamped.push({ ...stampedRow, opponentKey: row.opponentKey, changeStatus: row.status });
  }
  return stamped;
}

function stampLearningHealthOnJson(path, learningHealth, artifactType) {
  const artifact = readJsonIfExists(path);
  if (!artifact) return null;
  const stamp = learningHealthStamp(learningHealth);
  writeJsonAtomicSync(path, {
    ...artifact,
    learningHealth: stamp
  });
  return {
    path,
    artifactType,
    learningHealthStatus: stamp.status,
    stampedAt: stamp.stampedAt
  };
}

function learningHealthStamp(learningHealth = {}) {
  return {
    status: learningHealth.status ?? "unknown",
    label: learningHealth.label ?? "Unknown",
    blockers: Array.isArray(learningHealth.blockers) ? learningHealth.blockers : [],
    warnings: Array.isArray(learningHealth.warnings) ? learningHealth.warnings : [],
    stampedAt: new Date().toISOString(),
    source: "update-pilot-knowledge"
  };
}

function modelHasNewSourceFiles(path, previousSourceFiles = []) {
  const artifact = readJsonIfExists(path);
  if (!artifact) return false;
  const previous = new Set(previousSourceFiles);
  return (artifact.sourceFiles ?? []).some((sourceFile) => !previous.has(sourceFile));
}

async function summarizeDecisionFiles(files, { player, pairwiseScale = 0.7 }) {
  const seenRowFingerprints = new Set();
  const seenTelemetryFingerprints = new Set();
  const seenPairwiseDecisionFingerprints = new Set();
  const pairwiseInputConsistencyLedger = createPairwiseInputConsistencyLedger({ maxContexts: 100_000 });
  const playerGameKeys = new Set();
  const profileCounts = new Map();
  const variantStatusCounts = new Map();
  const variantCounts = new Map();
  const phaseCounts = new Map();
  const actionCounts = new Map();
  const candidateActionCounts = new Map();
  const causallyTestedActionCounts = new Map();
  const phaseCredit = new Map();
  const actionCredit = new Map();
  const counterfactualTargetPhaseCounts = new Map();
  const counterfactualDecisionPhaseCounts = new Map();
  const counterfactualAlternativeSelectionCounts = new Map();
  const counterfactualSamplingReasonCounts = new Map();
  const counterfactualStateEvaluationVersionCounts = new Map();
  const candidateFeatureUses = new Map();
  const chosenFeatureUses = new Map();
  const featureCredit = new Map();
  const resolutionChoiceCoverage = new Map();
  const raidNormalPlayCoverage = { available: 0, chosen: 0, causallyTested: 0, covered: 0 };
  const raidPlacementCoverage = { decisions: 0, options: new Map() };
  const fieldReplacementCoverage = { available: 0, chosen: 0, causallyTested: 0, covered: 0 };
  const unknownVariants = new Map();
  const knownDeckVariants = new Map();
  let totalRows = 0;
  let uniqueRows = 0;
  let duplicateRowsSkipped = 0;
  let telemetryRows = 0;
  let duplicateTelemetryRowsSkipped = 0;
  let telemetryPlayerGames = 0;
  let telemetryCompleteGames = 0;
  let telemetryEnabledGames = 0;
  let telemetryDecisionOpportunities = 0;
  let telemetryExplorations = 0;
  let telemetryExplorationProbes = 0;
  let telemetryExplorationActions = 0;
  let telemetryExplorationCoverageGaps = 0;
  let telemetryExplorationEvidenceAware = 0;
  let telemetryExplorationScoreWeighted = 0;
  let telemetryExplorationPreviouslyAttempted = 0;
  let telemetryExplorationUnseen = 0;
  let telemetryExplorationEvidenceAttemptsAdded = 0;
  let telemetryExplorationEvidenceActionableAdded = 0;
  let telemetryExplorationEvidenceFeaturesAdded = 0;
  const telemetryExplorationEvidenceFeatureKeys = new Set();
  let telemetryCounterfactuals = 0;
  let telemetryActionableCounterfactuals = 0;
  let telemetryCounterfactualTies = 0;
  let telemetryUnsynchronizedCounterfactuals = 0;
  let telemetryLowInformationSkips = 0;
  let telemetryGamesWithCounterfactual = 0;
  let telemetryGamesWithActionableCounterfactual = 0;
  let telemetryAdaptiveCounterfactuals = 0;
  let telemetryAdaptiveEarlyStops = 0;
  let telemetryAdaptiveAuditEligible = 0;
  let telemetryAdaptiveAudits = 0;
  let telemetryAdaptiveAuditAgreements = 0;
  let telemetryAdaptiveAuditDisagreements = 0;
  let telemetryCounterfactualRequestedPlayerTurns = 0;
  let telemetryCounterfactualEvaluatedPlayerTurns = 0;
  let telemetryCounterfactualEstimatedPlayerTurnsSaved = 0;
  let chosenRows = 0;
  let wins = 0;
  let losses = 0;
  let incomplete = 0;
  let forced = 0;
  let eligible = 0;
  let credited = 0;
  let exploration = 0;
  let counterfactual = 0;
  let counterfactualFallbacks = 0;
  let setup = 0;
  let version2 = 0;
  let creditWeightTotal = 0;
  let loggedChoiceRows = 0;
  let raidNormalPlayOptions = 0;
  let chosenRaidNormalPlay = 0;
  let chosenRaidActions = 0;
  let chosenRaidNormalExploration = 0;

  for (const file of files) {
    let currentPairwiseKey = null;
    let currentPairwiseGroup = [];
    let currentCoverageGroup = [];
    const flushPairwiseGroup = () => {
      recordPairwiseConsistencyGroup(currentPairwiseGroup, {
        player,
        pairwiseScale,
        ledger: pairwiseInputConsistencyLedger,
        seenFingerprints: seenPairwiseDecisionFingerprints
      });
      recordResolutionChoiceCoverage(currentCoverageGroup, {
        player,
        coverage: resolutionChoiceCoverage
      });
      recordStrategicActionCoverage(currentCoverageGroup, {
        player,
        causallyTestedActionCounts,
        raidNormalPlayCoverage,
        raidPlacementCoverage,
        fieldReplacementCoverage
      });
      currentPairwiseKey = null;
      currentPairwiseGroup = [];
      currentCoverageGroup = [];
    };
    for await (const row of readJsonlRows(file)) {
      totalRows += 1;
      if (isLearningGameTelemetry(row)) {
        flushPairwiseGroup();
        if (player !== "all" && row.player !== player) continue;
        const telemetryFingerprint = learningGameTelemetryFingerprint(row);
        if (seenTelemetryFingerprints.has(telemetryFingerprint)) {
          duplicateTelemetryRowsSkipped += 1;
          continue;
        }
        seenTelemetryFingerprints.add(telemetryFingerprint);
        telemetryRows += 1;
        telemetryPlayerGames += 1;
        if (row.complete !== false && String(row.outcome ?? "incomplete") !== "incomplete") telemetryCompleteGames += 1;
        if (row.counterfactualEnabled) telemetryEnabledGames += 1;
        const gameCounterfactuals = Math.max(0, Number(row.counterfactualsEvaluated ?? 0));
        const gameActionableCounterfactuals = Math.max(0, Number(row.actionableCounterfactuals ?? 0));
        telemetryDecisionOpportunities += Math.max(0, Number(row.decisionOpportunities ?? 0));
        telemetryExplorations += Math.max(0, Number(row.explorationDecisions ?? 0));
        telemetryExplorationProbes += Math.max(0, Number(row.explorationProbeDecisions ?? 0));
        telemetryExplorationActions += Math.max(0, Number(row.explorationActionDecisions ?? 0));
        telemetryExplorationCoverageGaps += Math.max(0, Number(row.explorationCoverageGapDecisions ?? 0));
        telemetryExplorationEvidenceAware += Math.max(0, Number(row.explorationEvidenceAwareDecisions ?? 0));
        telemetryExplorationScoreWeighted += Math.max(0, Number(row.explorationScoreWeightedDecisions ?? 0));
        telemetryExplorationPreviouslyAttempted += Math.max(0, Number(row.explorationPreviouslyAttemptedDecisions ?? 0));
        telemetryExplorationUnseen += Math.max(0, Number(row.explorationUnseenDecisions ?? 0));
        telemetryExplorationEvidenceAttemptsAdded += Math.max(0, Number(row.explorationEvidenceAttemptsAdded ?? 0));
        telemetryExplorationEvidenceActionableAdded += Math.max(0, Number(row.explorationEvidenceActionableAdded ?? 0));
        telemetryExplorationEvidenceFeaturesAdded += Math.max(0, Number(row.explorationEvidenceFeaturesAdded ?? 0));
        for (const feature of row.explorationEvidenceFeatureKeys ?? []) {
          if (String(feature).startsWith("context.")) telemetryExplorationEvidenceFeatureKeys.add(String(feature));
        }
        telemetryCounterfactuals += gameCounterfactuals;
        telemetryActionableCounterfactuals += gameActionableCounterfactuals;
        telemetryCounterfactualTies += Math.max(0, Number(row.counterfactualTies ?? 0));
        telemetryUnsynchronizedCounterfactuals += Math.max(0, Number(row.unsynchronizedCounterfactuals ?? 0));
        telemetryLowInformationSkips += Math.max(0, Number(row.counterfactualLowInformationSkips ?? 0));
        telemetryAdaptiveCounterfactuals += Math.max(0, Number(row.counterfactualAdaptiveDecisions ?? 0));
        telemetryAdaptiveEarlyStops += Math.max(0, Number(row.counterfactualAdaptiveEarlyStops ?? 0));
        telemetryAdaptiveAuditEligible += Math.max(0, Number(row.counterfactualAdaptiveAuditEligible ?? 0));
        telemetryAdaptiveAudits += Math.max(0, Number(row.counterfactualAdaptiveAudits ?? 0));
        telemetryAdaptiveAuditAgreements += Math.max(0, Number(row.counterfactualAdaptiveAuditAgreements ?? 0));
        telemetryAdaptiveAuditDisagreements += Math.max(0, Number(row.counterfactualAdaptiveAuditDisagreements ?? 0));
        telemetryCounterfactualRequestedPlayerTurns += Math.max(0, Number(row.counterfactualRequestedPlayerTurns ?? 0));
        telemetryCounterfactualEvaluatedPlayerTurns += Math.max(0, Number(row.counterfactualEvaluatedPlayerTurns ?? 0));
        telemetryCounterfactualEstimatedPlayerTurnsSaved += Math.max(0, Number(row.counterfactualEstimatedPlayerTurnsSaved ?? 0));
        if (gameCounterfactuals > 0) telemetryGamesWithCounterfactual += 1;
        if (gameActionableCounterfactuals > 0) telemetryGamesWithActionableCounterfactual += 1;
        continue;
      }
      const pairwiseKey = decisionGroupKey(row);
      if (currentPairwiseKey !== null && pairwiseKey !== currentPairwiseKey) flushPairwiseGroup();
      currentPairwiseKey = pairwiseKey;
      currentPairwiseGroup.push(row);
      const rowFingerprint = learningDecisionGroupFingerprint([row]);
      if (seenRowFingerprints.has(rowFingerprint)) {
        duplicateRowsSkipped += 1;
        continue;
      }
      seenRowFingerprints.add(rowFingerprint);
      uniqueRows += 1;
      currentCoverageGroup.push(row);
      if (player === "all" || row.player === player) {
        loggedChoiceRows += 1;
        incrementFeatureUses(candidateFeatureUses, row.features);
        incrementCount(candidateActionCounts, decisionActionKey(row));
        if (featurePositive(row.features, "playRaidCardNormally")) raidNormalPlayOptions += 1;
      }
      if (!row.chosen || (player !== "all" && row.player !== player)) continue;
      chosenRows += 1;
      playerGameKeys.add([
        file,
        row.seed ?? row.gameIndex ?? "game",
        row.candidateId ?? "candidate",
        row.player ?? "player"
      ].join("|"));
      const outcome = String(row.outcome ?? "incomplete").toLowerCase();
      if (outcome === "win") wins += 1;
      else if (outcome === "loss") losses += 1;
      else incomplete += 1;
      const candidateCount = Number(row.candidateCount ?? 2);
      if (candidateCount <= 1) forced += 1;
      const rowEligible = row.learningEligible === true
        || (row.learningEligible !== false && outcome !== "incomplete" && candidateCount > 1);
      if (rowEligible) eligible += 1;
      const creditWeight = Number(row.creditWeight ?? 0);
      if (Number.isFinite(creditWeight) && creditWeight > 0) {
        credited += 1;
        creditWeightTotal += creditWeight;
      }
      incrementFeatureUses(chosenFeatureUses, row.features);
      incrementFeatureCredit(featureCredit, row.features, creditWeight);
      if (row.explorationReason || row.action?.explorationReason) exploration += 1;
      if (row.counterfactualPreference || row.counterfactual?.preference) {
        counterfactual += 1;
        incrementCount(
          counterfactualStateEvaluationVersionCounts,
          row.counterfactualStateEvaluationVersion ?? row.counterfactual?.stateEvaluationVersion ?? 1
        );
        incrementCount(counterfactualTargetPhaseCounts, row.counterfactualTargetPhase ?? row.counterfactual?.targetPhase ?? "unknown");
        incrementCount(counterfactualDecisionPhaseCounts, row.counterfactualDecisionPhase ?? row.counterfactual?.decisionPhase ?? decisionPhaseKey(row));
        incrementCount(
          counterfactualAlternativeSelectionCounts,
          row.counterfactualAlternativeSelection ?? row.counterfactual?.alternativeSelection ?? "unknown"
        );
        incrementCount(
          counterfactualSamplingReasonCounts,
          row.counterfactualSamplingReason ?? row.counterfactual?.samplingReason ?? "unknown"
        );
        if (row.counterfactualFallbackUsed || row.counterfactual?.fallbackUsed) counterfactualFallbacks += 1;
      }
      if (row.actionType === "keepHand" || row.actionType === "mulligan" || String(row.step ?? "").startsWith("setup-")) setup += 1;
      if (Number(row.learningSignalVersion ?? 1) >= 2) version2 += 1;
      const phaseKey = decisionPhaseKey(row);
      const actionKey = decisionActionKey(row);
      if (featurePositive(row.features, "playRaidCardNormally")) {
        chosenRaidNormalPlay += 1;
        if (row.explorationReason === "raid-normal-play" || row.action?.explorationReason === "raid-normal-play") chosenRaidNormalExploration += 1;
      }
      if (actionKey === "performRaid") chosenRaidActions += 1;
      incrementCount(phaseCounts, phaseKey);
      incrementCount(actionCounts, actionKey);
      if (Number.isFinite(creditWeight) && creditWeight > 0) {
        incrementWeight(phaseCredit, phaseKey, creditWeight);
        incrementWeight(actionCredit, actionKey, creditWeight);
      }
      incrementCount(profileCounts, row.matchupProfileKey ?? "unknown");
      incrementCount(variantStatusCounts, row.matchupVariantStatus ?? "unknown");
      incrementCount(variantCounts, row.matchupVariantKey ?? "unknown");

      if (row.matchupVariantStatus === "unknown-variant") {
        const key = row.matchupVariantKey ?? "unknown";
        const item = unknownVariants.get(key) ?? {
          key,
          examples: 0,
          profileKey: row.matchupProfileKey ?? "unknown",
          reason: row.matchupVariantReason ?? null,
          cardCounts: new Map(),
          opponentCounts: new Map()
        };
        item.examples += 1;
        for (const card of row.matchupVariantCardIds ?? []) incrementCount(item.cardCounts, card);
        incrementCount(item.opponentCounts, row.opponent ?? "unknown");
        unknownVariants.set(key, item);
      }

      if (row.matchupVariantStatus === "known-deck") {
        const key = row.matchupVariantKey ?? "unknown";
        const item = knownDeckVariants.get(key) ?? {
          key,
          examples: 0,
          profileKey: row.matchupProfileKey ?? "unknown",
          deckCandidateId: row.matchupDeckCandidateId ?? null,
          deckCandidateName: row.matchupDeckCandidateName ?? null,
          confidenceTotal: 0
        };
        item.examples += 1;
        item.confidenceTotal += Number(row.matchupDeckCandidateConfidence ?? 0);
        knownDeckVariants.set(key, item);
      }
    }
    flushPairwiseGroup();
  }

  return {
    totalRows,
    uniqueRows,
    duplicateRowsSkipped,
    samplingTelemetry: {
      available: telemetryRows > 0,
      rows: telemetryRows,
      duplicateRowsSkipped: duplicateTelemetryRowsSkipped,
      playerGames: telemetryPlayerGames,
      completeGames: telemetryCompleteGames,
      enabledGames: telemetryEnabledGames,
      decisionOpportunities: telemetryDecisionOpportunities,
      explorations: telemetryExplorations,
      explorationProbes: telemetryExplorationProbes,
      explorationActions: telemetryExplorationActions,
      explorationCoverageGaps: telemetryExplorationCoverageGaps,
      explorationEvidenceAware: telemetryExplorationEvidenceAware,
      explorationScoreWeighted: telemetryExplorationScoreWeighted,
      explorationPreviouslyAttempted: telemetryExplorationPreviouslyAttempted,
      explorationUnseen: telemetryExplorationUnseen,
      explorationEvidenceAttemptsAdded: telemetryExplorationEvidenceAttemptsAdded,
      explorationEvidenceActionableAdded: telemetryExplorationEvidenceActionableAdded,
      explorationEvidenceFeaturesAdded: telemetryExplorationEvidenceFeaturesAdded,
      explorationEvidenceFeatureKeys: [...telemetryExplorationEvidenceFeatureKeys]
        .sort((left, right) => left.localeCompare(right)),
      counterfactualsEvaluated: telemetryCounterfactuals,
      actionableCounterfactuals: telemetryActionableCounterfactuals,
      counterfactualTies: telemetryCounterfactualTies,
      unsynchronizedCounterfactuals: telemetryUnsynchronizedCounterfactuals,
      lowInformationSkips: telemetryLowInformationSkips,
      gamesWithCounterfactual: telemetryGamesWithCounterfactual,
      gamesWithActionableCounterfactual: telemetryGamesWithActionableCounterfactual,
      adaptiveCounterfactuals: telemetryAdaptiveCounterfactuals,
      adaptiveEarlyStops: telemetryAdaptiveEarlyStops,
      adaptiveAuditEligible: telemetryAdaptiveAuditEligible,
      adaptiveAudits: telemetryAdaptiveAudits,
      adaptiveAuditAgreements: telemetryAdaptiveAuditAgreements,
      adaptiveAuditDisagreements: telemetryAdaptiveAuditDisagreements,
      counterfactualRequestedPlayerTurns: telemetryCounterfactualRequestedPlayerTurns,
      counterfactualEvaluatedPlayerTurns: telemetryCounterfactualEvaluatedPlayerTurns,
      counterfactualEstimatedPlayerTurnsSaved: telemetryCounterfactualEstimatedPlayerTurnsSaved,
      rates: {
        complete: ratio(telemetryCompleteGames, telemetryPlayerGames),
        enabled: ratio(telemetryEnabledGames, telemetryPlayerGames),
        explorationPerGame: ratio(telemetryExplorations, telemetryPlayerGames),
        explorationProbeRate: ratio(telemetryExplorationProbes, telemetryExplorations),
        explorationActionRate: ratio(telemetryExplorationActions, telemetryExplorations),
        explorationCoverageGapRate: ratio(telemetryExplorationCoverageGaps, telemetryExplorations),
        explorationPreviouslyAttemptedRate: ratio(telemetryExplorationPreviouslyAttempted, telemetryExplorations),
        explorationActionableYield: ratio(
          telemetryExplorationEvidenceActionableAdded,
          telemetryExplorationEvidenceAttemptsAdded
        ),
        counterfactualPerGame: ratio(telemetryCounterfactuals, telemetryPlayerGames),
        actionableCounterfactualPerGame: ratio(telemetryActionableCounterfactuals, telemetryPlayerGames),
        unsynchronizedCounterfactualRate: ratio(telemetryUnsynchronizedCounterfactuals, telemetryCounterfactuals),
        adaptiveEarlyStopRate: ratio(telemetryAdaptiveEarlyStops, telemetryAdaptiveCounterfactuals),
        adaptiveAuditAgreementRate: ratio(telemetryAdaptiveAuditAgreements, telemetryAdaptiveAudits),
        adaptivePlayerTurnSavingsRate: ratio(
          telemetryCounterfactualEstimatedPlayerTurnsSaved,
          telemetryCounterfactualRequestedPlayerTurns
        ),
        counterfactualGameCoverage: ratio(telemetryGamesWithCounterfactual, telemetryPlayerGames),
        actionableCounterfactualGameCoverage: ratio(telemetryGamesWithActionableCounterfactual, telemetryPlayerGames)
      }
    },
    chosenRows,
    playerGames: playerGameKeys.size,
    wins,
    losses,
    incomplete,
    forced,
    eligible,
    credited,
    exploration,
    counterfactual,
    counterfactualFallbacks,
    counterfactualTargetPhaseCounts: topCountMap(counterfactualTargetPhaseCounts, 12),
    counterfactualDecisionPhaseCounts: topCountMap(counterfactualDecisionPhaseCounts, 12),
    counterfactualAlternativeSelectionCounts: topCountMap(counterfactualAlternativeSelectionCounts, 12),
    counterfactualSamplingReasonCounts: topCountMap(counterfactualSamplingReasonCounts, 12),
    counterfactualStateEvaluationVersionCounts: topCountMap(counterfactualStateEvaluationVersionCounts, 12),
    pairwiseInputConsistency: summarizePairwiseInputConsistencyLedger(pairwiseInputConsistencyLedger),
    setup,
    version2,
    creditWeightTotal: Number(creditWeightTotal.toFixed(6)),
    rates: {
      win: ratio(wins, chosenRows),
      loss: ratio(losses, chosenRows),
      incomplete: ratio(incomplete, chosenRows),
      forced: ratio(forced, chosenRows),
      eligible: ratio(eligible, chosenRows),
      credited: ratio(credited, chosenRows),
      exploration: ratio(exploration, chosenRows),
      counterfactual: ratio(counterfactual, chosenRows),
      explorationPerPlayerGame: ratio(exploration, playerGameKeys.size),
      counterfactualPerPlayerGame: ratio(counterfactual, playerGameKeys.size),
      setup: ratio(setup, chosenRows),
      version2: ratio(version2, chosenRows)
    },
    profileCounts: topCountMap(profileCounts, 30),
    phaseCounts: topCountMap(phaseCounts, 12),
    actionCounts: topCountMap(actionCounts, 20),
    candidateActionCounts: topCountMap(candidateActionCounts, 20),
    phaseCredit: topWeightMap(phaseCredit, creditWeightTotal, 12),
    actionCredit: topWeightMap(actionCredit, creditWeightTotal, 20),
    policyFeatureCoverage: {
      candidates: summarizePolicyFeatureCoverage(candidateFeatureUses),
      chosen: summarizePolicyFeatureCoverage(chosenFeatureUses),
      credit: summarizePolicyFeatureCredit(featureCredit)
    },
    coverage: coverageSummary({
      chosenRows,
      phaseCounts,
      actionCounts,
      loggedChoiceRows,
      candidateActionCounts,
      causallyTestedActionCounts,
      phaseCredit,
      actionCredit,
      creditWeightTotal,
      opportunityCounts: {
        raidNormalPlayOptions,
        chosenRaidNormalPlay,
        chosenRaidActions,
        chosenRaidNormalExploration,
        raidNormalPlayCoverage: {
          ...raidNormalPlayCoverage,
          chosenRate: ratio(raidNormalPlayCoverage.chosen, raidNormalPlayCoverage.available),
          causalRate: ratio(raidNormalPlayCoverage.causallyTested, raidNormalPlayCoverage.available),
          coverageRate: ratio(raidNormalPlayCoverage.covered, raidNormalPlayCoverage.available)
        },
        resolutionChoiceCoverage: summarizeResolutionChoiceCoverage(resolutionChoiceCoverage),
        raidPlacementCoverage: summarizeBranchCoverage(raidPlacementCoverage),
      fieldReplacementCoverage: {
        ...fieldReplacementCoverage,
        chosenRate: ratio(fieldReplacementCoverage.chosen, fieldReplacementCoverage.available),
        causalRate: ratio(fieldReplacementCoverage.causallyTested, fieldReplacementCoverage.available),
        coverageRate: ratio(fieldReplacementCoverage.covered, fieldReplacementCoverage.available)
        }
      }
    }),
    variantStatusCounts: topCountMap(variantStatusCounts, 20),
    variantCounts: topCountMap(variantCounts, 40),
    unknownVariants: [...unknownVariants.values()]
      .map((item) => ({
        key: item.key,
        examples: item.examples,
        profileKey: item.profileKey,
        reason: item.reason,
        cardIds: topCountMap(item.cardCounts, 12).map(({ key, count }) => ({ key, count })),
        opponents: topCountMap(item.opponentCounts, 8)
      }))
      .sort((a, b) => b.examples - a.examples || a.key.localeCompare(b.key))
      .slice(0, 30),
    knownDeckVariants: [...knownDeckVariants.values()]
      .map((item) => ({
        key: item.key,
        examples: item.examples,
        profileKey: item.profileKey,
        deckCandidateId: item.deckCandidateId,
        deckCandidateName: item.deckCandidateName,
        avgConfidence: item.examples > 0 ? item.confidenceTotal / item.examples : 0
      }))
      .sort((a, b) => b.examples - a.examples || a.key.localeCompare(b.key))
      .slice(0, 40)
  };
}

function recordPairwiseConsistencyGroup(group, {
  player,
  pairwiseScale,
  ledger,
  seenFingerprints
}) {
  if (!Array.isArray(group) || group.length === 0) return;
  const chosen = group.find((row) => row.chosen && (player === "all" || row.player === player));
  if (!chosen) return;
  const playerGroup = group.filter((row) => row.player === chosen.player);
  const fingerprint = learningDecisionGroupFingerprint(playerGroup);
  if (seenFingerprints.has(fingerprint)) return;
  seenFingerprints.add(fingerprint);
  const evidence = counterfactualPairwiseLearningEvidence(chosen);
  if (!evidence) return;
  const alternatives = counterfactualAlternativeRows(playerGroup, chosen);
  if (alternatives.length === 0) return;
  const weight = knowledgePairwiseWeight(chosen, evidence, pairwiseScale);
  for (const alternative of alternatives) {
    const keys = pairwiseEvidenceDiversityKeys(chosen, alternative, evidence);
    recordPairwiseInputConsistency(ledger, {
      features: pairwiseFeatureDifference(chosen.features, alternative.features),
      target: evidence.direction,
      weight,
      metadata: {
        ...keys,
        playerGame: [
          chosen.ownKey ?? chosen.deckId ?? "deck",
          chosen.opponent ?? chosen.matchupProfileKey ?? "opponent",
          chosen.seed ?? chosen.gameIndex ?? "game"
        ].join("|")
      }
    });
  }
}

function knowledgePairwiseWeight(row, evidence, pairwiseScale) {
  if (Number(row.learningSignalVersion ?? 1) < 2) return 0;
  if (row.learningEligible === false || String(row.outcome ?? "").toLowerCase() === "incomplete") return 0;
  if (Number(row.candidateCount ?? 2) <= 1) return 0;
  const creditWeight = Number(row.creditWeight ?? 1);
  const scale = Number(pairwiseScale);
  if (!Number.isFinite(creditWeight) || creditWeight <= 0 || !Number.isFinite(scale) || scale <= 0) return 0;
  return creditWeight * Number(evidence.magnitude ?? 1) * Number(evidence.confidence ?? 1) * scale;
}

function decisionGroupKey(row = {}) {
  return String(row.decisionKey ?? [
    row.candidateId ?? "candidate",
    row.gameIndex ?? row.seed ?? "game",
    row.player ?? "player",
    row.step ?? row.decisionIndex ?? "step"
  ].join(":"));
}

function learningHealthSummary({ decisions, mlModel, overlays, overlayChanges, preflight = false }) {
  const chosenRows = Number(decisions?.chosenRows ?? 0);
  const rates = decisions?.rates ?? {};
  const sampling = decisions?.samplingTelemetry ?? {};
  const blockers = [];
  const warnings = [];
  const strengths = [];

  if (chosenRows === 0) blockers.push("No chosen decision rows were available for learning.");
  else strengths.push(`${chosenRows} chosen decision row(s) were available.`);
  if (Number(decisions?.duplicateRowsSkipped ?? 0) > 0) {
    strengths.push(`${Number(decisions.duplicateRowsSkipped)} duplicate decision row(s) were excluded from health and coverage metrics.`);
  }

  if (chosenRows >= 20 && Number(rates.incomplete ?? 0) > 0.2) {
    blockers.push(`Incomplete chosen decisions are too high at ${formatPercent(rates.incomplete)}.`);
  } else if (chosenRows >= 20 && Number(rates.incomplete ?? 0) > 0.05) {
    warnings.push(`Incomplete chosen decisions are elevated at ${formatPercent(rates.incomplete)}.`);
  }

  if (chosenRows >= 20 && Number(rates.version2 ?? 0) < 0.8) {
    blockers.push(`Only ${formatPercent(rates.version2)} of chosen rows use current learning signals.`);
  } else if (chosenRows >= 20 && Number(rates.version2 ?? 0) < 0.95) {
    warnings.push(`Current learning-signal coverage is ${formatPercent(rates.version2)}.`);
  }

  const sourceInputConsistency = decisions?.pairwiseInputConsistency ?? {};
  if (Number(sourceInputConsistency.version ?? 0) < MIN_ML_PAIRWISE_INPUT_CONSISTENCY_VERSION) {
    blockers.push("Pairwise source evidence lacks canonical input-consistency accounting.");
  } else if (sourceInputConsistency.complete === false) {
    warnings.push("Pairwise source input-consistency accounting exceeded its context capacity; conflict diagnostics are incomplete.");
  }
  if (sourceInputConsistency.unsafe) {
    blockers.push(
      `Repeated model-visible inputs carry ${formatPercent(sourceInputConsistency.conflictRate)} irreconcilable minority-weight labels; training is quarantined until the evidence source is reviewed.`
    );
  } else if (sourceInputConsistency.gateEligible && Number(sourceInputConsistency.conflictRate ?? 0) > 0.1) {
    warnings.push(
      `Repeated model-visible inputs carry ${formatPercent(sourceInputConsistency.conflictRate)} minority-weight disagreement; maximum attainable repeated-input accuracy is ${formatPercent(sourceInputConsistency.maximumAttainableRepeatedAccuracy)}.`
    );
  } else if (Number(sourceInputConsistency.repeatedExamples ?? 0) > 0) {
    strengths.push(
      `Pairwise source consistency is ${formatPercent(1 - Number(sourceInputConsistency.conflictRate ?? 0))} across ${Number(sourceInputConsistency.repeatedExamples)} repeated input(s).`
    );
  }

  if (chosenRows >= 20 && Number(rates.eligible ?? 0) < 0.2) {
    blockers.push(`Only ${formatPercent(rates.eligible)} of chosen rows are learning-eligible.`);
  } else if (chosenRows >= 20 && Number(rates.eligible ?? 0) < 0.5) {
    warnings.push(`Learning-eligible chosen rows are low at ${formatPercent(rates.eligible)}.`);
  }

  if (chosenRows >= 20 && Number(rates.credited ?? 0) < 0.2) {
    blockers.push(`Only ${formatPercent(rates.credited)} of chosen rows have positive learning credit.`);
  } else if (chosenRows >= 20 && Number(rates.credited ?? 0) < 0.5) {
    warnings.push(`Positive-credit chosen rows are low at ${formatPercent(rates.credited)}.`);
  }

  if (chosenRows >= 50 && Number(rates.forced ?? 0) > 0.45) {
    warnings.push(`Forced decisions are high at ${formatPercent(rates.forced)}; the agent may not be seeing enough meaningful choices.`);
  }

  const coverage = decisions?.coverage ?? {};
  if (chosenRows >= 80 && Number(coverage.significantPhaseCount ?? 0) < 3) {
    warnings.push(`Decision coverage is narrow: only ${Number(coverage.significantPhaseCount ?? 0)} phase(s) supplied at least 5% of chosen decisions.`);
  }
  if (chosenRows >= 80 && Number(coverage.topActionRate ?? 0) > 0.7) {
    warnings.push(`Action coverage is concentrated: ${coverage.topAction ?? "one action"} accounts for ${formatPercent(coverage.topActionRate)} of chosen decisions.`);
  }
  const opportunity = coverage.actionOpportunityCoverage ?? {};
  const uncoveredCandidateActions = opportunity.candidateOnlyUncoveredActions
    ?? opportunity.candidateOnlyActions
    ?? [];
  const uncoveredCandidateActionCount = Number(
    opportunity.candidateOnlyUncoveredActionCount
      ?? opportunity.candidateOnlyActionCount
      ?? uncoveredCandidateActions.length
  );
  if (chosenRows >= 80 && uncoveredCandidateActionCount >= 2) {
    warnings.push(`Logged candidate actions include ${uncoveredCandidateActionCount} action type(s) the agent neither chose nor causally tested: ${uncoveredCandidateActions.slice(0, 4).join(", ")}.`);
  }
  const raidNormal = opportunity.raidNormalPlay ?? {};
  const raidNormalCausalComparisons = Math.max(
    Number(raidNormal.causallyTested ?? 0),
    countForMetric(decisions?.counterfactualAlternativeSelectionCounts, "raid-vs-normal-play")
  );
  if (chosenRows >= 80 && Number(raidNormal.available ?? 0) >= 10
    && Number(raidNormal.covered ?? raidNormal.chosen ?? 0) === 0 && raidNormalCausalComparisons === 0) {
    warnings.push(`Raid normal-play options were logged ${Number(raidNormal.available)} time(s), but the agent never chose or causally tested one; run deck training with raid-normal-play exploration before trusting raid-line learning.`);
  } else if (chosenRows >= 80 && Number(raidNormal.available ?? 0) >= 20
    && Number(raidNormal.coverageRate ?? raidNormal.chosenRate ?? 0) < 0.02 && raidNormalCausalComparisons === 0) {
    warnings.push(`Raid normal-play options are under-sampled at ${formatPercent(raidNormal.coverageRate ?? raidNormal.chosenRate)} causal coverage despite ${Number(raidNormal.available)} logged opportunities.`);
  }
  if (raidNormalCausalComparisons > 0) {
    strengths.push(`${raidNormalCausalComparisons} direct Raid-versus-normal-play comparison(s) tested the alternate line without requiring an off-policy game trajectory.`);
  }
  if (Number(raidNormal.chosen ?? 0) > 0) {
    strengths.push(`${Number(raidNormal.chosen)} raid normal-play decision(s) were chosen from logged opportunities.`);
  }
  const resolutionChoices = opportunity.resolutionChoices ?? { decisions: 0, kinds: [] };
  const criticalResolutionKinds = new Set([
    "optionaleffect",
    "playsourcefromzone",
    "raidsourcefromzone",
    "raidtrigger"
  ]);
  for (const kind of resolutionChoices.kinds ?? []) {
    if (!criticalResolutionKinds.has(String(kind.kind ?? "").toLowerCase())) continue;
    const uncovered = (kind.options ?? [])
      .filter((option) => Number(option.available ?? 0) >= 10 && branchCoveredCount(option) === 0);
    const underSampled = (kind.options ?? [])
      .filter((option) => Number(option.available ?? 0) >= 40
        && branchCoveredCount(option) > 0
        && branchCoveredCount(option) < minimumBranchSamples(option.available));
    if (chosenRows >= 80 && uncovered.length > 0) {
      warnings.push(
        `Nested ${kind.kind} opportunity sampling never played or causally tested ${uncovered.map((option) => option.option).join(", ")} across ${Number(kind.decisions ?? 0)} logged decision(s); keep these branches in causal probe coverage before trusting the learned preference.`
      );
    } else if (chosenRows >= 80 && underSampled.length > 0) {
      warnings.push(
        `Nested ${kind.kind} opportunity sampling remains thin for ${underSampled.map((option) => `${option.option} ${branchCoveredCount(option)}/${Number(option.available ?? 0)}`).join(", ")}; retain bounded causal probes without forcing the branch into live play.`
      );
    } else if (Number(kind.decisions ?? 0) >= 10 && (kind.options ?? []).every((option) => branchCoveredCount(option) > 0)) {
      strengths.push(`Nested ${kind.kind} choices played or causally tested every logged branch across ${Number(kind.decisions)} decision(s).`);
    }
  }
  const raidPlacement = opportunity.raidPlacement ?? { decisions: 0, options: [] };
  const uncoveredRaidPlacements = (raidPlacement.options ?? [])
    .filter((option) => Number(option.available ?? 0) >= 10 && branchCoveredCount(option) === 0);
  const underSampledRaidPlacements = (raidPlacement.options ?? [])
    .filter((option) => Number(option.available ?? 0) >= 40
      && branchCoveredCount(option) > 0
      && branchCoveredCount(option) < minimumBranchSamples(option.available));
  if (chosenRows >= 80 && uncoveredRaidPlacements.length > 0) {
    warnings.push(
      `Raid placement opportunity sampling never played or causally tested ${uncoveredRaidPlacements.map((option) => option.option).join(", ")} across ${Number(raidPlacement.decisions ?? 0)} logged stay/move decision(s).`
    );
  } else if (chosenRows >= 80 && underSampledRaidPlacements.length > 0) {
    warnings.push(
      `Raid placement opportunity sampling remains thin for ${underSampledRaidPlacements.map((option) => `${option.option} ${branchCoveredCount(option)}/${Number(option.available ?? 0)}`).join(", ")}; retain bounded causal probes without forcing the placement.`
    );
  } else if (Number(raidPlacement.decisions ?? 0) >= 10
    && (raidPlacement.options ?? []).length > 1
    && raidPlacement.options.every((option) => branchCoveredCount(option) > 0)) {
    strengths.push(`Raid stay/move choices played or causally tested every logged placement branch across ${Number(raidPlacement.decisions)} decision(s).`);
  }
  const fieldReplacement = opportunity.fieldReplacement ?? {};
  const replacementCoverage = branchCoveredCount(fieldReplacement);
  if (chosenRows >= 80 && Number(fieldReplacement.available ?? 0) >= 20
    && replacementCoverage === 0) {
    warnings.push(
      `Field-replacement opportunity sampling logged ${Number(fieldReplacement.available)} decision(s), but no replacement line was played or causally tested; replacement preferences remain untested.`
    );
  } else if (chosenRows >= 80 && Number(fieldReplacement.available ?? 0) >= 40
    && replacementCoverage < minimumBranchSamples(fieldReplacement.available)) {
    warnings.push(
      `Field-replacement opportunity sampling remains thin at ${replacementCoverage}/${Number(fieldReplacement.available)} covered decision(s) (${Number(fieldReplacement.chosen ?? 0)} played, ${Number(fieldReplacement.causallyTested ?? 0)} causal); retain bounded replacement probes without forcing them into live play.`
    );
  } else if (replacementCoverage > 0) {
    strengths.push(`${replacementCoverage} field-replacement opportunity sample(s) were covered (${Number(fieldReplacement.chosen ?? 0)} played, ${Number(fieldReplacement.causallyTested ?? 0)} causal).`);
  }
  if (chosenRows >= 80 && Number(rates.setup ?? 0) < 0.02) {
    warnings.push("Setup/mulligan decision evidence is thin; opening-hand learning may lag behind gameplay learning.");
  }
  if (chosenRows >= 80 && !hasCoverage(decisions?.phaseCounts, "attack") && !hasActionPrefix(decisions?.actionCounts, "declareAttack")) {
    warnings.push("Attack-phase decision evidence is missing; combat timing and swing/pass learning may be undertrained.");
  }
  const candidateFeatureCoverage = decisions?.policyFeatureCoverage?.candidates ?? {};
  const featureCreditCoverage = decisions?.policyFeatureCoverage?.credit ?? {};
  if (chosenRows >= 80 && Number(candidateFeatureCoverage.observedGroupCount ?? 0) < 5) {
    warnings.push(`Strategic feature coverage is narrow: ${Number(candidateFeatureCoverage.observedGroupCount ?? 0)}/${Number(candidateFeatureCoverage.totalGroupCount ?? 0)} policy feature group(s) appeared in candidate choices.`);
  }
  const missingStrategicGroups = importantMissingFeatureGroups(candidateFeatureCoverage.missingGroups);
  if (chosenRows >= 80 && missingStrategicGroups.length > 0) {
    warnings.push(`Missing strategic feature groups: ${missingStrategicGroups.join(", ")}.`);
  }
  const topCreditGroup = featureCreditCoverage.topGroups?.[0] ?? null;
  if (chosenRows >= 80 && Number(topCreditGroup?.share ?? 0) > 0.65) {
    warnings.push(`Learning credit is concentrated in ${topCreditGroup.key} features at ${formatPercent(topCreditGroup.share)}.`);
  }

  if (chosenRows >= 50 && Number(rates.exploration ?? 0) < 0.01) {
    warnings.push("No meaningful exploration evidence was recorded; alternate-line coverage will be thin.");
  } else if (Number(decisions?.exploration ?? 0) > 0) {
    strengths.push(`${decisions.exploration} exploratory experiment(s) sampled alternate lines.`);
  }
  const explorationPriorityComparisons = countForMetric(
    decisions?.counterfactualSamplingReasonCounts,
    "explored-action-priority"
  ) + countForMetric(
    decisions?.counterfactualSamplingReasonCounts,
    "explored-alternative-priority"
  ) + countForMetric(
    decisions?.counterfactualSamplingReasonCounts,
    "explored-action-fallback"
  ) + countForMetric(
    decisions?.counterfactualSamplingReasonCounts,
    "explored-alternative-fallback"
  );
  const unpairedExplorations = Math.max(0, Number(decisions?.exploration ?? 0) - explorationPriorityComparisons);
  if (unpairedExplorations > 0) {
    warnings.push(`${unpairedExplorations} exploratory experiment(s) lacked an immediate causal comparison; exploration should stay within the per-game counterfactual budget.`);
  } else if (explorationPriorityComparisons > 0) {
    strengths.push(`All ${explorationPriorityComparisons} exploratory experiment(s) received immediate counterfactual comparisons.`);
  }
  const telemetryAvailable = Boolean(sampling.available && Number(sampling.playerGames ?? 0) > 0);
  const playerGames = telemetryAvailable
    ? Number(sampling.playerGames ?? 0)
    : Number(decisions?.playerGames ?? 0);
  const sampledCounterfactuals = telemetryAvailable
    ? Number(sampling.counterfactualsEvaluated ?? 0)
    : Number(decisions?.counterfactual ?? 0);
  const actionableCounterfactuals = telemetryAvailable
    ? Number(sampling.actionableCounterfactuals ?? 0)
    : Number(decisions?.counterfactual ?? 0);
  const counterfactualsPerPlayerGame = ratio(sampledCounterfactuals, playerGames);
  const actionableCounterfactualsPerPlayerGame = ratio(actionableCounterfactuals, playerGames);
  const unsynchronizedCounterfactuals = telemetryAvailable
    ? Number(sampling.unsynchronizedCounterfactuals ?? 0)
    : 0;
  const unsynchronizedCounterfactualRate = ratio(unsynchronizedCounterfactuals, sampledCounterfactuals);
  if (telemetryAvailable) {
    strengths.push(`${playerGames} training game(s) reported causal-sampling telemetry.`);
    if (Number(sampling.explorationProbes ?? 0) > 0 && Number(sampling.explorationActions ?? 0) === 0) {
      strengths.push(`${Number(sampling.explorationProbes)} novel line(s) were tested as fitness-safe counterfactual probes.`);
    }
    if (Number(sampling.explorationActions ?? 0) > 0) {
      warnings.push(`${Number(sampling.explorationActions)} exploratory move(s) changed the training-game trajectory; use counterfactual-probe mode for production policy search.`);
    }
    const explorationAttempts = Number(sampling.explorationEvidenceAttemptsAdded ?? 0);
    const explorationActionable = Number(sampling.explorationEvidenceActionableAdded ?? 0);
    const explorationYield = ratio(explorationActionable, explorationAttempts);
    const uniqueExplorationFeatures = Number(sampling.explorationEvidenceFeatureKeys?.length ?? 0);
    const coverageGapExplorations = Number(sampling.explorationCoverageGaps ?? 0);
    const repeatedExplorationRate = Number(sampling.rates?.explorationPreviouslyAttemptedRate ?? 0);
    if (coverageGapExplorations > 0) {
      strengths.push(`${coverageGapExplorations} exploration probe(s) targeted under-supported contextual features.`);
    }
    if (explorationAttempts >= 8 && explorationYield < 0.5) {
      warnings.push(`Only ${formatPercent(explorationYield)} of exploration probes produced directional causal labels; alternate-line sampling is spending too much time on ties.`);
    } else if (explorationAttempts >= 8 && explorationYield >= 0.75) {
      strengths.push(`${formatPercent(explorationYield)} of ${explorationAttempts} exploration probe(s) produced actionable causal labels.`);
    }
    const minimumFeatureBreadth = Math.min(8, Math.ceil(explorationAttempts / 2));
    if (explorationAttempts >= 12 && uniqueExplorationFeatures < minimumFeatureBreadth) {
      warnings.push(`Exploration touched only ${uniqueExplorationFeatures} distinct contextual feature(s) across ${explorationAttempts} probe(s); repeated lines may be crowding out blind spots.`);
    }
    if (Number(sampling.explorations ?? 0) >= 8 && repeatedExplorationRate > 0.75
      && ratio(coverageGapExplorations, Number(sampling.explorations ?? 0)) < 0.25) {
      warnings.push(`${formatPercent(repeatedExplorationRate)} of exploration choices had already been attempted and few probes targeted coverage gaps; novelty rotation may be stalled.`);
    }

    const adaptiveEarlyStops = Number(sampling.adaptiveEarlyStops ?? 0);
    const adaptiveAudits = Number(sampling.adaptiveAudits ?? 0);
    const adaptiveAuditDisagreements = Number(sampling.adaptiveAuditDisagreements ?? 0);
    const adaptiveAuditDisagreementRate = ratio(adaptiveAuditDisagreements, adaptiveAudits);
    const adaptiveTurnsSaved = Number(sampling.counterfactualEstimatedPlayerTurnsSaved ?? 0);
    if (adaptiveEarlyStops > 0) {
      strengths.push(`${adaptiveEarlyStops} stable counterfactual comparison(s) stopped early, saving an estimated ${adaptiveTurnsSaved} branch player-turn(s).`);
    }
    if (adaptiveAudits >= MIN_ADAPTIVE_AUDIT_BLOCK_SAMPLES
      && adaptiveAuditDisagreementRate > MAX_ADAPTIVE_AUDIT_DISAGREEMENT_RATE) {
      blockers.push(`${formatPercent(adaptiveAuditDisagreementRate)} of ${adaptiveAudits} adaptive-depth audits reversed the early preference; shortened horizon evidence is quarantined until the evaluator is corrected.`);
    } else if (adaptiveAudits >= 3 && adaptiveAuditDisagreementRate > 0.1) {
      warnings.push(`${formatPercent(adaptiveAuditDisagreementRate)} of ${adaptiveAudits} adaptive-depth audits disagreed with the full horizon; monitor before increasing shortcut use.`);
    } else if (adaptiveAudits >= 3 && adaptiveAuditDisagreements === 0) {
      strengths.push(`All ${adaptiveAudits} adaptive-depth audit(s) agreed with the full-horizon preference.`);
    } else if (adaptiveEarlyStops >= 20 && adaptiveAudits === 0) {
      warnings.push(`${adaptiveEarlyStops} counterfactual comparisons stopped early without a retained full-horizon audit; efficiency claims are not yet calibrated.`);
    }
  }
  if ((chosenRows >= 80 || playerGames >= 20) && sampledCounterfactuals === 0) {
    blockers.push("No counterfactual decision evidence was recorded in a substantial run; pairwise learning would be starved.");
  } else if (playerGames >= 4 && counterfactualsPerPlayerGame < 0.3) {
    warnings.push(`Counterfactual coverage is thin at ${counterfactualsPerPlayerGame.toFixed(2)} comparison(s) per pilot game; pairwise learning may converge slowly.`);
  } else if (playerGames > 0 && sampledCounterfactuals > 0) {
    strengths.push(`${sampledCounterfactuals} counterfactual comparison(s) across ${playerGames} pilot game(s) (${counterfactualsPerPlayerGame.toFixed(2)} per game).`);
  }
  if (telemetryAvailable && playerGames >= 8 && actionableCounterfactualsPerPlayerGame < 0.2) {
    warnings.push(`Actionable counterfactual yield is thin at ${actionableCounterfactualsPerPlayerGame.toFixed(2)} comparison(s) per training game; causal labels are accumulating too slowly.`);
  }
  if (telemetryAvailable && sampledCounterfactuals >= 8 && unsynchronizedCounterfactualRate > 0.2) {
    warnings.push(`${formatPercent(unsynchronizedCounterfactualRate)} of counterfactual branches hit the action safety cap before their shared player-turn horizon; raise the rollout action cap or shorten the turn horizon.`);
  } else if (telemetryAvailable && sampledCounterfactuals > 0 && unsynchronizedCounterfactuals === 0) {
    strengths.push("All sampled counterfactual branches reached a comparable player-turn horizon.");
  }
  if (Number(decisions?.counterfactual ?? 0) > 0) strengths.push(`${decisions.counterfactual} chosen decision(s) include direct counterfactual evidence.`);
  if (Number(decisions?.counterfactual ?? 0) >= 20) {
    const currentEvaluatorComparisons = countForMetric(
      decisions.counterfactualStateEvaluationVersionCounts,
      String(COUNTERFACTUAL_STATE_EVALUATION_VERSION)
    );
    const currentEvaluatorRate = ratio(currentEvaluatorComparisons, Number(decisions.counterfactual ?? 0));
    if (chosenRows >= 80 && currentEvaluatorComparisons === 0) {
      blockers.push("Counterfactual evidence predates the current public-safe state evaluator; stale nonterminal labels are quarantined until fresh evidence is collected.");
    } else if (currentEvaluatorRate < 0.8) {
      warnings.push(`Only ${formatPercent(currentEvaluatorRate)} of counterfactual comparisons use state evaluator v${COUNTERFACTUAL_STATE_EVALUATION_VERSION}; stale nonterminal labels will be ignored.`);
    } else {
      strengths.push(`${currentEvaluatorComparisons} counterfactual comparison(s) use state evaluator v${COUNTERFACTUAL_STATE_EVALUATION_VERSION}.`);
    }
    const combatCounterfactuals = countForMetric(decisions.counterfactualDecisionPhaseCounts, "attack")
      + countForMetric(decisions.counterfactualDecisionPhaseCounts, "block");
    if (combatCounterfactuals === 0) {
      warnings.push("Counterfactual evidence still contains no attack or block decisions; combat learning remains under-sampled.");
    } else {
      strengths.push(`${combatCounterfactuals} counterfactual comparison(s) evaluated attack or block decisions.`);
    }
    const fallbackRate = ratio(Number(decisions.counterfactualFallbacks ?? 0), Number(decisions.counterfactual ?? 0));
    if (fallbackRate > 0.35) {
      warnings.push(`Counterfactual phase fallback was used for ${formatPercent(fallbackRate)} of comparisons; one or more target phases may be too rare for this deck.`);
    }
    const knownAlternativeSelections = Number(decisions.counterfactual ?? 0)
      - countForMetric(decisions.counterfactualAlternativeSelectionCounts, "unknown");
    const strategicAlternativeSelections = [
      "attack-vs-pass",
      "block-vs-life",
      "diverse-action-family",
      "field-replacement-choice",
      "information-priority-diverse",
      "nested-resolution-diversity",
      "raid-placement",
      "raid-vs-normal-play",
      "setup-keep-vs-mulligan"
    ].reduce((total, key) => (
      total + countForMetric(decisions.counterfactualAlternativeSelectionCounts, key)
    ), 0);
    if (knownAlternativeSelections > 0 && ratio(strategicAlternativeSelections, knownAlternativeSelections) < 0.35) {
      warnings.push("Counterfactual alternatives are concentrated on same-family, highest-score choices; strategic branch coverage remains narrow.");
    } else if (strategicAlternativeSelections > 0) {
      strengths.push(`${strategicAlternativeSelections} counterfactual comparison(s) tested a paired or strategically different action line.`);
    }
  }

  if (preflight) {
    strengths.push("Preflight checked raw decision-log quality before artifact training.");
  } else if (!mlModel) {
    warnings.push("No action model summary was produced.");
  } else {
    const signalTrust = Number(mlModel.learningSignalTrust ?? 0);
    if (Number(mlModel.trainingPipelineVersion ?? 1) < 2) {
      blockers.push("Action model predates duplicate-safe learning and cannot influence runtime play until rebuilt.");
    }
    if (Number(mlModel.sourceDigestVersion ?? 0) < MIN_LEARNING_SOURCE_DIGEST_VERSION) {
      blockers.push("Action model cannot identify copied decision logs across cycles and cannot influence runtime play until rebuilt.");
    }
    if (Number(mlModel.learningEvidenceFilterVersion ?? 0) < MIN_LEARNING_EVIDENCE_FILTER_VERSION) {
      blockers.push("Action model cannot identify overlapping decisions across cycles and cannot influence runtime play until rebuilt.");
    }
    if (Number(mlModel.counterfactualStateEvaluationVersion ?? 1) < COUNTERFACTUAL_STATE_EVALUATION_VERSION) {
      blockers.push("Action model predates the current public-safe state evaluator and cannot influence runtime play until rebuilt.");
    }
    if (Number(mlModel.validationAssignmentVersion ?? 1) < 2) {
      blockers.push("Action model predates game-level validation grouping and cannot influence runtime play until rebuilt.");
    }
    if (Number(mlModel.validationStateVersion ?? 0) < MIN_ML_VALIDATION_STATE_VERSION) {
      blockers.push("Action model does not retain cumulative held-out evidence and cannot influence runtime play until rebuilt.");
    }
    if (Number(mlModel.pairwiseOrientationVersion ?? 1) < MIN_ML_PAIRWISE_ORIENTATION_VERSION) {
      blockers.push("Action model predates balanced pairwise validation and cannot influence runtime play until rebuilt.");
    }
    if (Number(mlModel.regressionVersion ?? 1) < MIN_ML_REGRESSION_VERSION) {
      blockers.push("Action model predates covariance-aware regression and cannot influence runtime play until rebuilt.");
    }
    const validationInputConsistency = mlModel.validationInputConsistency ?? {};
    if (Number(validationInputConsistency.version ?? 0) < MIN_ML_PAIRWISE_INPUT_CONSISTENCY_VERSION) {
      blockers.push("Action model lacks canonical held-out input-consistency diagnostics and cannot influence runtime play until rebuilt.");
    } else if (validationInputConsistency.complete === false) {
      blockers.push("Action-model held-out input-consistency diagnostics are incomplete.");
    } else if (validationInputConsistency.unsafe) {
      blockers.push(
        `Held-out repeated inputs carry ${formatPercent(validationInputConsistency.conflictRate)} irreconcilable minority-weight labels; runtime ML remains inactive.`
      );
    } else if (validationInputConsistency.gateEligible) {
      strengths.push(
        `Held-out repeated-input consistency is ${formatPercent(1 - Number(validationInputConsistency.conflictRate ?? 0))}.`
      );
    }
    if (Number(mlModel.examples ?? 0) >= 100 && signalTrust < 0.2) {
      blockers.push(`Action-model signal trust is critically low at ${formatPercent(signalTrust)}.`);
    } else if (Number(mlModel.examples ?? 0) >= 100 && signalTrust < 0.45) {
      warnings.push(`Action-model signal trust is low at ${formatPercent(signalTrust)}.`);
    } else if (Number(mlModel.examples ?? 0) > 0) {
      strengths.push(`Action model has ${mlModel.examples} example(s) and ${mlModel.features} feature(s).`);
    }

    const heldoutGames = Number(mlModel.validation?.heldoutPlayerGames ?? 0);
    if (Number(mlModel.examples ?? 0) >= 100 && heldoutGames < 4) {
      warnings.push(`Only ${heldoutGames} held-out player-game(s) were available for validation diagnostics.`);
    }
    const anchorValidation = mlModel.validation?.anchor;
    const validationDiversity = mlModel.validationDiversity ?? {};
    if (Number(mlModel.validation?.fraction ?? 0) <= 0) {
      blockers.push("Action model was trained with held-out validation disabled and cannot influence runtime play.");
    }
    if (Number(validationDiversity.version ?? 0) < MIN_ML_VALIDATION_DIVERSITY_VERSION && Number(mlModel.pairwiseExamples ?? 0) >= 30) {
      warnings.push("Held-out action comparisons lack current game, phase, action-pair, and opponent classification; new games must rebuild validation breadth.");
    } else if (Number(validationDiversity.trackedExamples ?? 0) > 0) {
      if (Number(validationDiversity.distinctPlayerGames ?? 0) < MIN_ML_RUNTIME_HELDOUT_GAMES) {
        warnings.push(`Retained held-out evidence spans only ${Number(validationDiversity.distinctPlayerGames ?? 0)}/${MIN_ML_RUNTIME_HELDOUT_GAMES} required player-games.`);
      }
      if (Number(validationDiversity.distinctPhases ?? 0) < 2
        || Number(validationDiversity.distinctActionPairs ?? 0) < 3
        || Number(validationDiversity.distinctOpponentProfiles ?? 0) < 2) {
        warnings.push(`Held-out breadth is narrow: ${Number(validationDiversity.distinctPhases ?? 0)} phase(s), ${Number(validationDiversity.distinctActionPairs ?? 0)} action-pair family(s), and ${Number(validationDiversity.distinctOpponentProfiles ?? 0)} opponent archetype(s).`);
      }
      if (Number(validationDiversity.weakSupportedActionPairs ?? 0) > 0) {
        warnings.push(`${Number(validationDiversity.weakSupportedActionPairs)} supported held-out action family/families are below chance directional accuracy; runtime ML remains inactive while corrective evidence accumulates.`);
      }
      if (Number(validationDiversity.singleGameSupportedActionPairs ?? 0) > 0) {
        warnings.push(`${Number(validationDiversity.singleGameSupportedActionPairs)} supported held-out action family/families appear in fewer than ${MIN_ML_RUNTIME_VALIDATION_ACTION_PAIR_GAMES} player-games; runtime ML remains inactive.`);
      }
      if (Number(validationDiversity.oneSidedSupportedActionPairs ?? 0) > 0) {
        warnings.push(`${Number(validationDiversity.oneSidedSupportedActionPairs)} supported held-out action family/families have one-sided oriented evidence; runtime ML remains inactive.`);
      }
    }
    const validationPairwiseWeight = Number(mlModel.validation?.pairwise?.weightTotal ?? 0);
    if (Number(mlModel.validation?.pairwise?.examples ?? 0) >= 30
      && validationPairwiseWeight < MIN_ML_RUNTIME_VALIDATION_PAIRWISE_EFFECTIVE_WEIGHT) {
      warnings.push(`Held-out pairwise evidence has only ${validationPairwiseWeight.toFixed(3)}/${MIN_ML_RUNTIME_VALIDATION_PAIRWISE_EFFECTIVE_WEIGHT.toFixed(3)} required effective weight.`);
    }
    if (Number(mlModel.examples ?? 0) >= 100 && heldoutGames >= 8 && Number(mlModel.pairwiseExamples ?? 0) < 30
      && (Number(anchorValidation?.positiveExamples ?? 0) < 3 || Number(anchorValidation?.negativeExamples ?? 0) < 3)) {
      warnings.push(`Provisional action model has one-sided held-out outcome anchors (${Number(anchorValidation?.positiveExamples ?? 0)} positive / ${Number(anchorValidation?.negativeExamples ?? 0)} negative) and no reliable counterfactual pairs; it will remain inactive while evidence accumulates.`);
    }
    if (Number(mlModel.pairwiseExamples ?? 0) === 0 && Number(decisions?.counterfactual ?? 0) > 0) {
      warnings.push("Counterfactual decisions were present, but no pairwise examples were learned.");
    } else if (Number(mlModel.examples ?? 0) >= 100 && Number(mlModel.pairwiseExamples ?? 0) < 30) {
      warnings.push(`Action model has only ${Number(mlModel.pairwiseExamples ?? 0)} pairwise example(s); runtime ML remains inactive until it has at least 30.`);
    }
    if (Number(mlModel.pairwiseEffectiveWeightVersion ?? 0) < MIN_ML_PAIRWISE_EFFECTIVE_WEIGHT_VERSION) {
      warnings.push("Action model does not have complete effective pairwise-weight accounting and must be rebuilt from retained source logs.");
    } else if (Number(mlModel.pairwiseExamples ?? 0) > 0
      && Number(mlModel.pairwiseEffectiveWeight ?? 0) < MIN_ML_RUNTIME_PAIRWISE_EFFECTIVE_WEIGHT) {
      warnings.push(`Action model has ${Number(mlModel.pairwiseEffectiveWeight ?? 0).toFixed(3)}/${MIN_ML_RUNTIME_PAIRWISE_EFFECTIVE_WEIGHT.toFixed(3)} required effective pairwise weight; weak horizon comparisons will not activate runtime ML by count alone.`);
    }
    const diversity = mlModel.evidenceDiversity ?? {};
    const diversityReady = Number(diversity.version ?? 0) >= MIN_ML_EVIDENCE_DIVERSITY_VERSION
      && Number(diversity.historicalUnclassifiedExamples ?? 0) === 0
      && Number(diversity.trackedExamples ?? 0) >= MIN_ML_RUNTIME_DIVERSITY_EXAMPLES
      && Number(diversity.distinctPhases ?? 0) >= MIN_ML_RUNTIME_DISTINCT_PHASES
      && Number(diversity.distinctActionPairs ?? 0) >= MIN_ML_RUNTIME_DISTINCT_ACTION_PAIRS
      && Number(diversity.distinctOpponentProfiles ?? 0) >= MIN_ML_RUNTIME_DISTINCT_OPPONENTS;
    if (Number(diversity.historicalUnclassifiedExamples ?? 0) > 0) {
      warnings.push(`Action model contains ${Number(diversity.historicalUnclassifiedExamples)} historical pairwise example(s) without diversity classification and must be rebuilt from retained source logs before runtime use.`);
    } else if (!diversityReady && Number(mlModel.pairwiseExamples ?? 0) > 0) {
      warnings.push(
        `Action-model evidence breadth is still collecting: ${Number(diversity.trackedExamples ?? 0)} tracked pair(s), ${Number(diversity.distinctPhases ?? 0)} phase(s), ${Number(diversity.distinctActionPairs ?? 0)} action-pair family(s), and ${Number(diversity.distinctOpponentProfiles ?? 0)} opponent archetype(s).`
      );
    } else if (diversityReady) {
      strengths.push(
        `Action-model evidence spans ${Number(diversity.distinctPhases)} phase(s), ${Number(diversity.distinctActionPairs)} action-pair family(s), and ${Number(diversity.distinctOpponentProfiles)} opponent archetype(s).`
      );
    }
    if (Number(mlModel.duplicateLearningUnitsSkipped ?? 0) > 0) {
      strengths.push(`${Number(mlModel.duplicateLearningUnitsSkipped)} duplicate learning unit(s) were ignored.`);
    }
  }

  if (!preflight) {
    const overlayLearning = Number(overlayChanges?.created ?? 0) + Number(overlayChanges?.updated ?? 0);
    const candidateLearning = Number(overlayChanges?.candidateCreated ?? 0) + Number(overlayChanges?.candidateUpdated ?? 0);
    if (overlayLearning > 0) strengths.push(`${overlayLearning} matchup overlay file(s) changed.`);
    if (candidateLearning > 0) strengths.push(`${candidateLearning} inactive matchup candidate(s) accumulated new causal evidence.`);
    else if (chosenRows >= 50 && Array.isArray(overlays) && overlays.length === 0) warnings.push("No matchup overlays exist yet for this profile.");
    const inactiveLegacyOverlays = (overlays ?? []).filter((overlay) => Number(overlay.trainingPipelineVersion ?? 1) < 2).length;
    if (inactiveLegacyOverlays > 0) {
      warnings.push(`${inactiveLegacyOverlays} matchup overlay(s) predate duplicate-safe learning and remain inactive until rebuilt.`);
    }
    const staleSourceDigestOverlays = (overlays ?? []).filter((overlay) => Number(overlay.sourceDigestVersion ?? 0) < MIN_LEARNING_SOURCE_DIGEST_VERSION).length;
    if (staleSourceDigestOverlays > 0) {
      warnings.push(`${staleSourceDigestOverlays} matchup overlay(s) cannot identify copied logs across cycles and remain inactive until rebuilt.`);
    }
    const staleEvidenceFilterOverlays = (overlays ?? []).filter((overlay) => Number(overlay.learningEvidenceFilterVersion ?? 0) < MIN_LEARNING_EVIDENCE_FILTER_VERSION).length;
    if (staleEvidenceFilterOverlays > 0) {
      warnings.push(`${staleEvidenceFilterOverlays} matchup overlay(s) cannot identify overlapping decisions across cycles and remain inactive until rebuilt.`);
    }
    const staleEvaluatorOverlays = (overlays ?? []).filter((overlay) => Number(overlay.counterfactualStateEvaluationVersion ?? 1) < COUNTERFACTUAL_STATE_EVALUATION_VERSION).length;
    if (staleEvaluatorOverlays > 0) {
      warnings.push(`${staleEvaluatorOverlays} matchup overlay(s) predate state evaluator v${COUNTERFACTUAL_STATE_EVALUATION_VERSION} and remain inactive until rebuilt.`);
    }
    const staleRegressionOverlays = (overlays ?? []).filter((overlay) => Number(overlay.regressionVersion ?? 1) < MIN_ML_REGRESSION_VERSION).length;
    if (staleRegressionOverlays > 0) {
      warnings.push(`${staleRegressionOverlays} matchup overlay(s) predate covariance-aware regression and remain inactive until rebuilt.`);
    }
    const causalEvidenceStatuses = new Set([
      "collecting-evidence",
      "low-trust",
      "low-pairwise",
      "stale-pairwise-mass",
      "low-pairwise-mass",
      "stale-diversity",
      "unclassified-evidence",
      "low-diversity-examples",
      "narrow-phase-diversity",
      "narrow-action-diversity",
      "concentrated-action-pairs"
    ]);
    const causalPendingOverlays = (overlays ?? []).filter((overlay) => causalEvidenceStatuses.has(overlay.readinessStatus)).length;
    if (causalPendingOverlays > 0) {
      warnings.push(`${causalPendingOverlays} matchup overlay(s) remain inactive while causal weight and decision breadth accumulate.`);
    }
    const validationPendingOverlays = (overlays ?? []).filter((overlay) => [
      "unvalidated",
      "low-impact-validation",
      "stale-impact-validation"
    ].includes(overlay.readinessStatus)).length;
    if (validationPendingOverlays > 0) {
      warnings.push(`${validationPendingOverlays} causally ready matchup overlay(s) remain quarantined pending positive paired-impact validation.`);
    }
  }

  const status = blockers.length > 0 ? "blocked" : warnings.length > 0 ? "watch" : "healthy";
  const label = status === "blocked" ? "Blocked" : status === "watch" ? "Watch" : "Healthy";
  return {
    status,
    label,
    blockers,
    warnings,
    strengths: strengths.slice(0, 16),
    rates: {
      incomplete: Number(rates.incomplete ?? 0),
      forced: Number(rates.forced ?? 0),
      eligible: Number(rates.eligible ?? 0),
      credited: Number(rates.credited ?? 0),
      exploration: Number(rates.exploration ?? 0),
      counterfactual: Number(rates.counterfactual ?? 0),
      setup: Number(rates.setup ?? 0),
      version2: Number(rates.version2 ?? 0)
    },
    sampling: {
      telemetryAvailable,
      playerGames,
      counterfactualsEvaluated: sampledCounterfactuals,
      actionableCounterfactuals,
      counterfactualsPerPlayerGame,
      actionableCounterfactualsPerPlayerGame,
      unsynchronizedCounterfactuals,
      unsynchronizedCounterfactualRate,
      counterfactualGameCoverage: telemetryAvailable
        ? Number(sampling.rates?.counterfactualGameCoverage ?? 0)
        : ratio(sampledCounterfactuals, playerGames),
      actionableCounterfactualGameCoverage: telemetryAvailable
        ? Number(sampling.rates?.actionableCounterfactualGameCoverage ?? 0)
        : ratio(actionableCounterfactuals, playerGames),
      lowInformationSkips: telemetryAvailable ? Number(sampling.lowInformationSkips ?? 0) : 0,
      explorationAttempts: telemetryAvailable ? Number(sampling.explorationEvidenceAttemptsAdded ?? 0) : 0,
      explorationActionable: telemetryAvailable ? Number(sampling.explorationEvidenceActionableAdded ?? 0) : 0,
      explorationActionableYield: telemetryAvailable
        ? Number(sampling.rates?.explorationActionableYield ?? 0)
        : 0,
      explorationCoverageGaps: telemetryAvailable ? Number(sampling.explorationCoverageGaps ?? 0) : 0,
      explorationUniqueContextualFeatures: telemetryAvailable
        ? Number(sampling.explorationEvidenceFeatureKeys?.length ?? 0)
        : 0,
      explorationPreviouslyAttemptedRate: telemetryAvailable
        ? Number(sampling.rates?.explorationPreviouslyAttemptedRate ?? 0)
        : 0,
      adaptiveCounterfactuals: telemetryAvailable ? Number(sampling.adaptiveCounterfactuals ?? 0) : 0,
      adaptiveEarlyStops: telemetryAvailable ? Number(sampling.adaptiveEarlyStops ?? 0) : 0,
      adaptiveAudits: telemetryAvailable ? Number(sampling.adaptiveAudits ?? 0) : 0,
      adaptiveAuditAgreements: telemetryAvailable ? Number(sampling.adaptiveAuditAgreements ?? 0) : 0,
      adaptiveAuditDisagreements: telemetryAvailable ? Number(sampling.adaptiveAuditDisagreements ?? 0) : 0,
      adaptiveAuditAgreementRate: telemetryAvailable
        ? Number(sampling.rates?.adaptiveAuditAgreementRate ?? 0)
        : 0,
      counterfactualEstimatedPlayerTurnsSaved: telemetryAvailable
        ? Number(sampling.counterfactualEstimatedPlayerTurnsSaved ?? 0)
        : 0
    },
    coverage
  };
}

async function* readJsonlRows(path) {
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const rawLine of lines) {
    const line = rawLine.trim();
    if (line) yield JSON.parse(line);
  }
}

function incrementCount(map, key) {
  const normalized = String(key ?? "unknown");
  if (!normalized) return;
  map.set(normalized, (map.get(normalized) ?? 0) + 1);
}

function incrementWeight(map, key, weight) {
  const normalized = String(key ?? "unknown");
  if (!normalized) return;
  map.set(normalized, Number(map.get(normalized) ?? 0) + Number(weight ?? 0));
}

function incrementFeatureUses(map, features = {}) {
  for (const [feature, rawValue] of Object.entries(features ?? {})) {
    if (feature === "baseScore") continue;
    const value = Number(rawValue ?? 0);
    if (!Number.isFinite(value) || value === 0) continue;
    incrementCount(map, feature);
  }
}

function featurePositive(features = {}, feature) {
  const value = Number(features?.[feature] ?? 0);
  return Number.isFinite(value) && value > 0;
}

function incrementFeatureCredit(map, features = {}, weight = 0) {
  const credit = Number(weight ?? 0);
  if (!Number.isFinite(credit) || credit <= 0) return;
  for (const [feature, rawValue] of Object.entries(features ?? {})) {
    if (feature === "baseScore") continue;
    const value = Number(rawValue ?? 0);
    if (!Number.isFinite(value) || value === 0) continue;
    incrementWeight(map, feature, credit);
  }
}

function topCountMap(map, limit) {
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit);
}

function topWeightMap(map, totalWeight, limit) {
  return [...map.entries()]
    .map(([key, weight]) => ({
      key,
      weight: Number(Number(weight ?? 0).toFixed(6)),
      share: ratio(Number(weight ?? 0), totalWeight)
    }))
    .sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key))
    .slice(0, limit);
}

function summarizePolicyFeatureCoverage(featureUses) {
  const policyFeatures = Object.keys(DEFAULT_PILOT_POLICY.weights).filter((feature) => feature !== "baseScore");
  const observed = policyFeatures.filter((feature) => Number(featureUses.get(feature) ?? 0) > 0);
  const unobserved = policyFeatures.filter((feature) => Number(featureUses.get(feature) ?? 0) === 0);
  const groups = policyFeatureGroups(policyFeatures);
  for (const feature of policyFeatures) {
    const group = pilotPolicyFeatureGroup(feature);
    const stats = groups[group];
    const uses = Number(featureUses.get(feature) ?? 0);
    stats.uses += uses;
    if (uses > 0) stats.observed += 1;
    else stats.unobserved.push(feature);
  }
  const groupRows = Object.entries(groups)
    .map(([key, row]) => ({
      key,
      total: row.total,
      observed: row.observed,
      coverageRate: ratio(row.observed, row.total),
      uses: row.uses,
      unobserved: row.unobserved
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const additionalFeatures = [...featureUses.keys()]
    .filter((feature) => feature !== "baseScore" && !Object.hasOwn(DEFAULT_PILOT_POLICY.weights, feature))
    .sort((a, b) => a.localeCompare(b));
  const contextualFeatures = additionalFeatures.filter((feature) => feature.startsWith("context."));
  return {
    totalBehavioralFeatures: policyFeatures.length,
    observedBehavioralFeatures: observed.length,
    coverageRate: ratio(observed.length, policyFeatures.length),
    observedGroupCount: groupRows.filter((row) => row.observed > 0).length,
    totalGroupCount: groupRows.length,
    missingGroups: groupRows.filter((row) => row.observed === 0).map((row) => row.key),
    topGroups: groupRows
      .filter((row) => row.uses > 0)
      .sort((a, b) => b.uses - a.uses || a.key.localeCompare(b.key))
      .slice(0, 8),
    groups: Object.fromEntries(groupRows.map((row) => [row.key, row])),
    unobservedPolicyFeatures: unobserved,
    observedContextualFeatureCount: contextualFeatures.length,
    observedContextualFeatures: contextualFeatures,
    observedAdditionalFeatures: additionalFeatures.filter((feature) => !feature.startsWith("context.")),
    observedNonPolicyFeatures: additionalFeatures
  };
}

function summarizePolicyFeatureCredit(featureCredit) {
  const groupCredit = new Map();
  let contextualFeatureCredit = 0;
  let contextualFeatureCount = 0;
  for (const [feature, rawCredit] of featureCredit.entries()) {
    if (feature === "baseScore") continue;
    const credit = Number(rawCredit ?? 0);
    if (credit <= 0) continue;
    incrementWeight(groupCredit, pilotPolicyFeatureGroup(feature), credit);
    if (feature.startsWith("context.")) {
      contextualFeatureCredit += credit;
      contextualFeatureCount += 1;
    }
  }
  const totalFeatureCredit = sumMapValues(featureCredit);
  return {
    totalFeatureCredit: Number(totalFeatureCredit.toFixed(6)),
    contextualFeatureCount,
    contextualFeatureCredit: Number(contextualFeatureCredit.toFixed(6)),
    contextualFeatureCreditShare: ratio(contextualFeatureCredit, totalFeatureCredit),
    topFeatures: topWeightMap(featureCredit, totalFeatureCredit, 12),
    topGroups: topWeightMap(groupCredit, totalFeatureCredit, 10)
  };
}

function sumMapValues(map) {
  return [...map.values()].reduce((total, value) => total + Number(value ?? 0), 0);
}

function policyFeatureGroups(policyFeatures) {
  const groups = {};
  for (const feature of policyFeatures) {
    const group = pilotPolicyFeatureGroup(feature);
    groups[group] ??= { total: 0, observed: 0, uses: 0, unobserved: [] };
    groups[group].total += 1;
  }
  return groups;
}

function coverageSummary({
  chosenRows,
  phaseCounts,
  actionCounts,
  loggedChoiceRows,
  candidateActionCounts,
  causallyTestedActionCounts,
  phaseCredit,
  actionCredit,
  creditWeightTotal,
  opportunityCounts = {}
}) {
  const significantPhaseCount = [...phaseCounts.values()]
    .filter((count) => ratio(count, chosenRows) >= 0.05).length;
  const significantActionCount = [...actionCounts.values()]
    .filter((count) => ratio(count, chosenRows) >= 0.05).length;
  const topAction = topEntry(actionCounts);
  const topPhase = topEntry(phaseCounts);
  const topCreditAction = topEntry(actionCredit);
  const topCreditPhase = topEntry(phaseCredit);
  const chosenActionKeys = new Set(actionCounts.keys());
  const candidateOnlyActions = [...candidateActionCounts.keys()]
    .filter((key) => !chosenActionKeys.has(key))
    .sort((a, b) => Number(candidateActionCounts.get(b) ?? 0) - Number(candidateActionCounts.get(a) ?? 0) || a.localeCompare(b));
  const causallyTestedActionKeys = new Set([...causallyTestedActionCounts.entries()]
    .filter(([, count]) => Number(count) > 0)
    .map(([key]) => key));
  const candidateOnlyUncoveredActions = candidateOnlyActions
    .filter((key) => !causallyTestedActionKeys.has(key));
  const groupRaidNormal = opportunityCounts.raidNormalPlayCoverage;
  const raidNormalPlay = {
    available: Number(groupRaidNormal?.available ?? opportunityCounts.raidNormalPlayOptions ?? 0),
    chosen: Number(groupRaidNormal?.chosen ?? opportunityCounts.chosenRaidNormalPlay ?? 0),
    causallyTested: Number(groupRaidNormal?.causallyTested ?? 0),
    covered: Number(groupRaidNormal?.covered ?? opportunityCounts.chosenRaidNormalPlay ?? 0),
    chosenRate: ratio(
      Number(groupRaidNormal?.chosen ?? opportunityCounts.chosenRaidNormalPlay ?? 0),
      Number(groupRaidNormal?.available ?? opportunityCounts.raidNormalPlayOptions ?? 0)
    ),
    causalRate: ratio(groupRaidNormal?.causallyTested, groupRaidNormal?.available),
    coverageRate: ratio(groupRaidNormal?.covered, groupRaidNormal?.available),
    chosenExploration: Number(opportunityCounts.chosenRaidNormalExploration ?? 0),
    chosenRaidActions: Number(opportunityCounts.chosenRaidActions ?? 0)
  };
  return {
    significantPhaseCount,
    significantActionCount,
    loggedChoiceRows: Number(loggedChoiceRows ?? 0),
    topPhase: topPhase?.key ?? null,
    topPhaseRate: ratio(topPhase?.value ?? 0, chosenRows),
    topAction: topAction?.key ?? null,
    topActionRate: ratio(topAction?.value ?? 0, chosenRows),
    topCreditPhase: topCreditPhase?.key ?? null,
    topCreditPhaseShare: ratio(topCreditPhase?.value ?? 0, creditWeightTotal),
    topCreditAction: topCreditAction?.key ?? null,
    topCreditActionShare: ratio(topCreditAction?.value ?? 0, creditWeightTotal),
    actionOpportunityCoverage: {
      loggedActionTypes: candidateActionCounts.size,
      chosenActionTypes: actionCounts.size,
      causallyTestedActionTypes: causallyTestedActionKeys.size,
      causallyTestedActions: topCountMap(causallyTestedActionCounts, 12),
      candidateOnlyActionCount: candidateOnlyActions.length,
      candidateOnlyActions: candidateOnlyActions.slice(0, 12),
      candidateOnlyUncoveredActionCount: candidateOnlyUncoveredActions.length,
      candidateOnlyUncoveredActions: candidateOnlyUncoveredActions.slice(0, 12),
      topCandidateActions: topCountMap(candidateActionCounts, 12),
      raidNormalPlay,
      resolutionChoices: opportunityCounts.resolutionChoiceCoverage ?? {
        decisions: 0,
        kinds: []
      },
      raidPlacement: opportunityCounts.raidPlacementCoverage ?? {
        decisions: 0,
        options: []
      },
      fieldReplacement: opportunityCounts.fieldReplacementCoverage ?? {
        available: 0,
        chosen: 0,
        causallyTested: 0,
        covered: 0,
        chosenRate: 0,
        causalRate: 0,
        coverageRate: 0
      }
    }
  };
}

function recordResolutionChoiceCoverage(group, { player, coverage }) {
  if (!Array.isArray(group) || group.length === 0) return;
  const scoped = group.filter((row) => player === "all" || row.player === player);
  const chosen = scoped.find((row) => row.chosen);
  if (!chosen || String(chosen.action?.type ?? chosen.actionType) !== "resolutionChoice") return;
  const chosenFamily = resolutionChoiceFamily(chosen);
  if (!chosenFamily) return;
  const prefix = `resolutionChoice:${chosenFamily.kind}:`;
  const causalFamilies = new Set(counterfactualTestedActionFamilies(scoped, chosen));
  const options = new Set(decisionActionFamilies(scoped)
    .filter((family) => family.startsWith(prefix))
    .map((family) => family.slice(prefix.length))
    .filter(Boolean));
  if (options.size <= 1) return;
  const item = coverage.get(chosenFamily.kind) ?? {
    kind: chosenFamily.kind,
    decisions: 0,
    options: new Map()
  };
  item.decisions += 1;
  for (const option of options) {
    const optionRow = item.options.get(option) ?? { option, available: 0, chosen: 0, causallyTested: 0, covered: 0 };
    const chosenOption = option === chosenFamily.option;
    const causallyTested = causalFamilies.has(`${prefix}${option}`);
    optionRow.available += 1;
    if (chosenOption) optionRow.chosen += 1;
    if (causallyTested) optionRow.causallyTested += 1;
    if (chosenOption || causallyTested) optionRow.covered += 1;
    item.options.set(option, optionRow);
  }
  coverage.set(chosenFamily.kind, item);
}

function resolutionChoiceFamily(row) {
  const family = pairwiseActionFamily(row);
  if (!family.startsWith("resolutionChoice:")) return null;
  const [, kind, ...optionParts] = family.split(":");
  return {
    kind: kind || "unknown",
    option: optionParts.join(":") || "choice"
  };
}

function summarizeResolutionChoiceCoverage(coverage) {
  const kinds = [...coverage.values()]
    .map((item) => ({
      kind: item.kind,
      decisions: item.decisions,
      options: [...item.options.values()]
        .map((option) => ({
          ...option,
          chosenRate: ratio(option.chosen, option.available),
          causalRate: ratio(option.causallyTested, option.available),
          coverageRate: ratio(option.covered, option.available)
        }))
        .sort((left, right) => right.available - left.available || left.option.localeCompare(right.option))
    }))
    .sort((left, right) => right.decisions - left.decisions || left.kind.localeCompare(right.kind));
  return {
    decisions: kinds.reduce((total, item) => total + item.decisions, 0),
    kinds
  };
}

function recordStrategicActionCoverage(group, {
  player,
  causallyTestedActionCounts,
  raidNormalPlayCoverage,
  raidPlacementCoverage,
  fieldReplacementCoverage
}) {
  if (!Array.isArray(group) || group.length === 0) return;
  const scoped = group.filter((row) => player === "all" || row.player === player);
  const chosen = scoped.find((row) => row.chosen);
  if (!chosen) return;

  for (const alternative of counterfactualAlternativeRows(scoped, chosen)) {
    incrementCount(causallyTestedActionCounts, decisionActionKey(alternative));
  }

  const families = decisionActionFamilies(scoped);
  const causalFamilies = new Set(counterfactualTestedActionFamilies(scoped, chosen));
  const raidNormalAvailable = scoped.some((row) => featurePositive(row.features, "playRaidCardNormally"));
  const raidAvailable = families.some((family) => family === "performRaid" || family.startsWith("performRaid:"));
  if (raidNormalAvailable && raidAvailable) {
    const chosenNormal = featurePositive(chosen.features, "playRaidCardNormally");
    const causallyTestedNormal = counterfactualAlternativeRows(scoped, chosen)
      .some((row) => featurePositive(row.features, "playRaidCardNormally"));
    raidNormalPlayCoverage.available += 1;
    if (chosenNormal) raidNormalPlayCoverage.chosen += 1;
    if (causallyTestedNormal) raidNormalPlayCoverage.causallyTested += 1;
    if (chosenNormal || causallyTestedNormal) raidNormalPlayCoverage.covered += 1;
  }
  const raidOptions = new Set(families
    .filter((family) => family.startsWith("performRaid:"))
    .map((family) => family.slice("performRaid:".length)));
  if (raidOptions.size > 1) {
    raidPlacementCoverage.decisions += 1;
    const chosenFamily = pairwiseActionFamily(chosen);
    const chosenOption = chosenFamily.startsWith("performRaid:")
      ? chosenFamily.slice("performRaid:".length)
      : null;
    for (const option of raidOptions) {
      const row = raidPlacementCoverage.options.get(option) ?? { option, available: 0, chosen: 0, causallyTested: 0, covered: 0 };
      const chosenOptionMatch = option === chosenOption;
      const causallyTested = causalFamilies.has(`performRaid:${option}`);
      row.available += 1;
      if (chosenOptionMatch) row.chosen += 1;
      if (causallyTested) row.causallyTested += 1;
      if (chosenOptionMatch || causallyTested) row.covered += 1;
      raidPlacementCoverage.options.set(option, row);
    }
  }

  const hasReplacement = families.some(isReplacementActionFamily)
    || scoped.some((row) => row.action?.replacesPermanent === true || featurePositive(row.features, "replacementValue"));
  if (hasReplacement) {
    const chosenReplacement = isReplacementActionFamily(pairwiseActionFamily(chosen))
      || chosen.action?.replacesPermanent === true
      || featurePositive(chosen.features, "replacementValue");
    const causallyTestedReplacement = [...causalFamilies].some(isReplacementActionFamily);
    fieldReplacementCoverage.available += 1;
    if (chosenReplacement) fieldReplacementCoverage.chosen += 1;
    if (causallyTestedReplacement) fieldReplacementCoverage.causallyTested += 1;
    if (chosenReplacement || causallyTestedReplacement) fieldReplacementCoverage.covered += 1;
  }
}

function isReplacementActionFamily(family) {
  return family === "performRaid:move-front-replace"
    || (family.startsWith("playCard:") && family.endsWith(":replace"));
}

function summarizeBranchCoverage(coverage) {
  return {
    decisions: Number(coverage.decisions ?? 0),
    options: [...coverage.options.values()]
      .map((option) => ({
        ...option,
        chosenRate: ratio(option.chosen, option.available),
        causalRate: ratio(option.causallyTested, option.available),
        coverageRate: ratio(option.covered, option.available)
      }))
      .sort((left, right) => right.available - left.available || left.option.localeCompare(right.option))
  };
}

function topEntry(map) {
  return [...map.entries()]
    .map(([key, value]) => ({ key, value: Number(value ?? 0) }))
    .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key))[0] ?? null;
}

function decisionPhaseKey(row) {
  const action = decisionActionKey(row);
  if (action === "keepHand" || action === "mulligan" || String(row.step ?? "").startsWith("setup-")) return "setup";
  return normalizeMetricKey(row.creditPhase ?? row.phase ?? "unknown");
}

function decisionActionKey(row) {
  return normalizeMetricKey(row.actionType ?? row.action?.type ?? "unknown");
}

function normalizeMetricKey(value) {
  const normalized = String(value ?? "unknown").trim();
  return normalized || "unknown";
}

function hasCoverage(rows = [], key) {
  return rows.some((row) => row.key === key && Number(row.count ?? 0) > 0);
}

function countForMetric(rows = [], key) {
  return Number(rows.find((row) => row.key === key)?.count ?? 0);
}

function hasActionPrefix(rows = [], prefix) {
  return rows.some((row) => String(row.key ?? "").startsWith(prefix) && Number(row.count ?? 0) > 0);
}

function importantMissingFeatureGroups(missingGroups = []) {
  const important = new Set(["setup", "attack", "block", "ability", "raid", "movement", "development"]);
  return (missingGroups ?? []).filter((group) => important.has(group));
}

function summarizeDecisionRows(rows, { player }) {
  const selected = rows.filter((row) => row.chosen && (player === "all" || row.player === player));
  return {
    totalRows: rows.length,
    chosenRows: selected.length,
    profileCounts: topCounts(selected, (row) => row.matchupProfileKey ?? "unknown", 30),
    variantStatusCounts: topCounts(selected, (row) => row.matchupVariantStatus ?? "unknown", 20),
    variantCounts: topCounts(selected, (row) => row.matchupVariantKey ?? "unknown", 40),
    unknownVariants: summarizeUnknownVariants(selected),
    knownDeckVariants: summarizeKnownDeckVariants(selected)
  };
}

function summarizeUnknownVariants(rows) {
  return [...groupBy(rows.filter((row) => row.matchupVariantStatus === "unknown-variant"), (row) => row.matchupVariantKey).entries()]
    .map(([key, group]) => ({
      key,
      examples: group.length,
      profileKey: group[0]?.matchupProfileKey ?? "unknown",
      reason: group[0]?.matchupVariantReason ?? null,
      cardIds: mostCommon(group.flatMap((row) => row.matchupVariantCardIds ?? []), 12),
      opponents: topCounts(group, (row) => row.opponent ?? "unknown", 8)
    }))
    .sort((a, b) => b.examples - a.examples || a.key.localeCompare(b.key))
    .slice(0, 30);
}

function summarizeKnownDeckVariants(rows) {
  return [...groupBy(rows.filter((row) => row.matchupVariantStatus === "known-deck"), (row) => row.matchupVariantKey).entries()]
    .map(([key, group]) => ({
      key,
      examples: group.length,
      profileKey: group[0]?.matchupProfileKey ?? "unknown",
      deckCandidateId: group[0]?.matchupDeckCandidateId ?? null,
      deckCandidateName: group[0]?.matchupDeckCandidateName ?? null,
      avgConfidence: average(group, (row) => Number(row.matchupDeckCandidateConfidence ?? 0))
    }))
    .sort((a, b) => b.examples - a.examples || a.key.localeCompare(b.key))
    .slice(0, 40);
}

function modelSummary(path) {
  if (!existsSync(path)) return null;
  const model = JSON.parse(readFileSync(path, "utf8"));
  const evidenceDiversity = mlPairwiseEvidenceDiversity(model);
  return {
    path,
    name: model.name ?? null,
    trainedAt: model.trainedAt ?? null,
    examples: Number(model.examples ?? 0),
    effectiveExamples: Number(model.exampleWeightTotal ?? model.examples ?? 0),
    selectedExamples: Number(model.selectedExamples ?? 0),
    pairwiseExamples: Number(model.pairwiseExamples ?? 0),
    pairwiseEffectiveWeightVersion: Number(model.pairwiseEffectiveWeightVersion ?? 0),
    pairwiseEffectiveWeight: Number(model.pairwiseEffectiveWeight ?? 0),
    evidenceDiversityVersion: Number(model.evidenceDiversityVersion ?? 0),
    evidenceDiversity,
    trainingPipelineVersion: Number(model.trainingPipelineVersion ?? 1),
    sourceDigestVersion: Number(model.sourceDigestVersion ?? 0),
    learningEvidenceFilterVersion: Number(model.learningEvidenceFilterVersion ?? 0),
    validationAssignmentVersion: Number(model.validationAssignmentVersion ?? model.validation?.assignmentKeyVersion ?? 1),
    validationStateVersion: Number(model.validationStateVersion ?? 0),
    pairwiseOrientationVersion: Number(model.pairwiseOrientationVersion ?? 1),
    pairwiseInputConsistencyVersion: Number(model.pairwiseInputConsistencyVersion ?? 0),
    regressionVersion: Number(model.regressionVersion ?? 1),
    counterfactualStateEvaluationVersion: Number(model.counterfactualStateEvaluationVersion ?? 1),
    uniqueLearningUnits: Number(model.uniqueLearningUnits ?? 0),
    duplicateLearningUnitsSkipped: Number(model.duplicateLearningUnitsSkipped ?? 0),
    newSourceFiles: Array.isArray(model.newSourceFiles) ? model.newSourceFiles.length : 0,
    learningSignalVersion: Number(model.learningSignalVersion ?? 1),
    learningSignalTrust: Number(model.learningSignalVersion ?? 1) >= 2 ? Number(model.learningSignalTrust ?? 1) : 0.25,
    evidenceSignalTrust: Number(model.evidenceSignalTrust ?? 1),
    validationSignalTrust: Number(model.validationSignalTrust ?? 1),
    runtimeTrust: mlActionModelRuntimeTrust(model),
    validationDiversity: mlValidationEvidenceDiversity(model),
    validationInputConsistency: mlValidationInputConsistency(model),
    validation: model.validation ?? null,
    features: Object.keys(model.weights ?? {}).length,
    learningHealth: model.learningHealth ?? null
  };
}

function profileActionModelPath(agentRoot, ownKey, baselineRoot) {
  return actionModelPathForKey(ownKey, { agentRoot, baselineRoot });
}

function overlaySummary(policyDir, ownKey, baselineRoot) {
  const seen = new Set();
  const rows = [];
  const files = [
    ...matchupOverlayFilesForKey(ownKey, { policyDir, baselineRoot }),
    ...matchupOverlayCandidateFilesForKey(ownKey, { policyDir, baselineRoot })
  ];
  for (const file of files) {
    const candidate = file.layout === "candidate";
    const seenKey = `${file.opponentKey}${candidate ? "||candidate" : ""}`;
    if (seen.has(seenKey) && file.layout === "legacy") continue;
    seen.add(seenKey);
      const path = file.path;
      const overlay = JSON.parse(readFileSync(path, "utf8"));
      const readiness = matchupOverlayReadiness(overlay, { requireImpactValidation: !candidate });
      rows.push({
        path,
        layout: file.layout,
        opponentKey: overlay.opponentKey ?? file.opponentKey,
        candidate,
        trainedAt: overlay.trainedAt ?? null,
        examples: Number(overlay.examples ?? 0),
        pairwiseExamples: Number(overlay.pairwiseExamples ?? 0),
        pairwiseEffectiveWeightVersion: Number(overlay.pairwiseEffectiveWeightVersion ?? 0),
        pairwiseEffectiveWeight: Number(overlay.pairwiseEffectiveWeight ?? 0),
        evidenceDiversityVersion: Number(overlay.evidenceDiversityVersion ?? overlay.pairwiseEvidenceDiversity?.version ?? 0),
        evidenceDiversity: readiness.evidenceDiversity,
        trainingPipelineVersion: Number(overlay.trainingPipelineVersion ?? 1),
        sourceDigestVersion: Number(overlay.sourceDigestVersion ?? 0),
        learningEvidenceFilterVersion: Number(overlay.learningEvidenceFilterVersion ?? 0),
        counterfactualStateEvaluationVersion: Number(overlay.counterfactualStateEvaluationVersion ?? 1),
        regressionVersion: Number(overlay.regressionVersion ?? 1),
        uniqueLearningUnits: Number(overlay.uniqueLearningUnits ?? 0),
        duplicateLearningUnitsSkipped: Number(overlay.duplicateLearningUnitsSkipped ?? 0),
        runtimeTrust: candidate ? 0 : matchupOverlayRuntimeTrust(overlay),
        readinessStatus: candidate && overlay.matchupCandidate?.status ? overlay.matchupCandidate.status : readiness.status,
        readinessReason: candidate && overlay.matchupCandidate?.reason ? overlay.matchupCandidate.reason : readiness.reason,
        readinessBlockers: readiness.blockers,
        impactValidation: overlay.impactValidation ?? null,
        features: Object.keys(overlay.weights ?? {}).length,
        variant: String(overlay.opponentKey ?? "").includes("__"),
        learningHealth: overlay.learningHealth ?? null
      });
  }
  return rows.sort((a, b) => Number(b.examples ?? 0) - Number(a.examples ?? 0) || a.opponentKey.localeCompare(b.opponentKey));
}

function overlaySnapshot(policyDir, ownKey, baselineRoot) {
  const rows = [];
  const seen = new Set();
  const files = [
    ...matchupOverlayFilesForKey(ownKey, { policyDir, baselineRoot }),
    ...matchupOverlayCandidateFilesForKey(ownKey, { policyDir, baselineRoot })
  ];
  for (const file of files) {
    const candidate = file.layout === "candidate";
    const seenKey = `${file.opponentKey}${candidate ? "||candidate" : ""}`;
    if (seen.has(seenKey) && file.layout === "legacy") continue;
    seen.add(seenKey);
    const path = file.path;
    const overlay = JSON.parse(readFileSync(path, "utf8"));
    const opponentKey = overlay.opponentKey ?? file.opponentKey;
    rows.push([candidate ? `candidate:${opponentKey}` : opponentKey, {
        path,
        layout: file.layout,
        opponentKey,
        candidate,
        examples: Number(overlay.examples ?? 0),
        pairwiseExamples: Number(overlay.pairwiseExamples ?? 0),
        pairwiseEffectiveWeight: Number(overlay.pairwiseEffectiveWeight ?? 0),
        features: Object.keys(overlay.weights ?? {}).length,
        digest: overlayDigest(overlay)
    }]);
  }
  return Object.fromEntries(rows);
}

function overlayDigest(overlay) {
  const stable = {
    opponentKey: overlay.opponentKey ?? null,
    examples: Number(overlay.examples ?? 0),
    pairwiseExamples: Number(overlay.pairwiseExamples ?? 0),
    pairwiseEffectiveWeightVersion: Number(overlay.pairwiseEffectiveWeightVersion ?? 0),
    pairwiseEffectiveWeight: Number(overlay.pairwiseEffectiveWeight ?? 0),
    evidenceDiversityVersion: Number(overlay.evidenceDiversityVersion ?? overlay.pairwiseEvidenceDiversity?.version ?? 0),
    pairwiseEvidenceDiversity: overlay.pairwiseEvidenceDiversity ?? null,
    averageTarget: Number(overlay.averageTarget ?? 0),
    weights: Object.fromEntries(Object.entries(overlay.weights ?? {}).sort(([a], [b]) => a.localeCompare(b)))
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function overlayChanges(before, after) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort((a, b) => a.localeCompare(b));
  const rows = keys.map((key) => {
    const previous = before[key] ?? null;
    const current = after[key] ?? null;
    const status = !previous && current
      ? "created"
      : previous && !current
        ? "removed"
        : previous?.digest !== current?.digest
          ? "updated"
          : "unchanged";
    return {
      opponentKey: current?.opponentKey ?? previous?.opponentKey ?? key.replace(/^candidate:/u, ""),
      candidate: Boolean(current?.candidate ?? previous?.candidate),
      status,
      previousExamples: previous?.examples ?? 0,
      currentExamples: current?.examples ?? 0,
      previousPairwiseExamples: previous?.pairwiseExamples ?? 0,
      currentPairwiseExamples: current?.pairwiseExamples ?? 0,
      previousPairwiseEffectiveWeight: previous?.pairwiseEffectiveWeight ?? 0,
      currentPairwiseEffectiveWeight: current?.pairwiseEffectiveWeight ?? 0,
      previousFeatures: previous?.features ?? 0,
      currentFeatures: current?.features ?? 0,
      path: current?.path ?? previous?.path ?? null
    };
  });
  const activeRows = rows.filter((row) => !row.candidate);
  const candidateRows = rows.filter((row) => row.candidate);
  return {
    created: activeRows.filter((row) => row.status === "created").length,
    updated: activeRows.filter((row) => row.status === "updated").length,
    removed: activeRows.filter((row) => row.status === "removed").length,
    unchanged: activeRows.filter((row) => row.status === "unchanged").length,
    candidateCreated: candidateRows.filter((row) => row.status === "created").length,
    candidateUpdated: candidateRows.filter((row) => row.status === "updated").length,
    candidateRemoved: candidateRows.filter((row) => row.status === "removed").length,
    candidateUnchanged: candidateRows.filter((row) => row.status === "unchanged").length,
    rows
  };
}

function pruneKnownDeckOverlays(policyDir, ownKey, baselineRoot) {
  const pruned = [];
  for (const file of matchupOverlayFilesForKey(ownKey, { policyDir, baselineRoot })) {
    if (!String(file.opponentKey ?? "").includes("__deck-") && !file.path.includes("__deck-")) continue;
    const path = file.path;
    rmSync(path);
    pruned.push(path);
  }
  return pruned.sort((a, b) => a.localeCompare(b));
}

function recommendedNextRun({ ownKey, mlOut, deckId, agentRoot, policyDir, baselineRoot }) {
  return [
    "node tools/pilot-loop-overseer.mjs",
    "--training-mode matchup",
    `--deck ${deckId}`,
    `--ml-model ${mlOut}`,
    `--agent-root ${agentRoot}`,
    `--policy-dir ${policyDir}`,
    `--baseline-root ${baselineRoot}`,
    "--ml-strength 0.35",
    `--own-key ${ownKey}`,
    "--opponent-mode random",
    "--opponent-count 20",
    "--parallel-opponent-count-per-run 1",
    "--parallel-runs 14",
    "--parallel-concurrency 14",
    "--games 20",
    "--generations 2",
    "--population 6",
    "--parallel-final-games 5",
    "--parallel-final-top-percent 25",
    "--parallel-final-candidates merged-baseline",
    "--knowledge-mode full",
    "--seed 13201",
    "--decision-log-mode learning",
    "--matchup-overlay-strength 1",
    "--matchup-min-confidence 0.6",
    "--matchup-variant-min-deck-confidence 0.55",
    "--matchup-variant-min-coverage 0.75",
    "--matchup-unknown-min-evidence 4",
    "--out-root work/private/pilot-agent/loops/spear-knowledge-iter-13201",
    "--runs-root work/private/pilot-agent/runs"
  ].join(" ");
}

function summaryMarkdown(manifest) {
  const lines = [
    `# Pilot Knowledge Update`,
    ``,
    `Own key: \`${manifest.ownKey}\``,
    `Deck: \`${manifest.deckId}\``,
    `Decision files: ${manifest.decisionFiles.length}`,
    `ML input paths: ${manifest.learningInputs?.ml?.length ?? manifest.inputs.length}`,
    `Overlay input paths: ${manifest.learningInputs?.overlays?.length ?? manifest.inputs.length}`,
    `Learning mode: ${manifest.learningInputs?.learningMode ?? "pairwise"}`,
    `Preflight: ${manifest.learningInputs?.preflight?.blocked ? "blocked artifact training" : "passed"}${manifest.learningInputs?.preflight?.forced ? " (forced)" : ""}`,
    `Chosen decision rows: ${manifest.decisions.chosenRows}`,
    `Pilot player-games: ${manifest.decisions.playerGames ?? 0}`,
    `Training games observed by sampling telemetry: ${manifest.decisions.samplingTelemetry?.playerGames ?? 0}`,
    `Exploration path: ${Number(manifest.decisions.samplingTelemetry?.explorationProbes ?? 0)} counterfactual probe(s) / ${Number(manifest.decisions.samplingTelemetry?.explorationActions ?? 0)} trajectory-changing action(s)`,
    `Exploration coverage: ${Number(manifest.learningHealth?.sampling?.explorationCoverageGaps ?? 0)} coverage-gap probe(s), ${Number(manifest.learningHealth?.sampling?.explorationUniqueContextualFeatures ?? 0)} contextual feature(s), ${formatPercent(manifest.learningHealth?.sampling?.explorationActionableYield ?? 0)} actionable yield`,
    `Causal sampling yield: ${Number(manifest.decisions.samplingTelemetry?.counterfactualsEvaluated ?? 0)} evaluated / ${Number(manifest.decisions.samplingTelemetry?.actionableCounterfactuals ?? 0)} actionable (${Number(manifest.learningHealth?.sampling?.actionableCounterfactualsPerPlayerGame ?? 0).toFixed(2)} actionable per game)`,
    `Adaptive rollout depth: ${Number(manifest.learningHealth?.sampling?.adaptiveEarlyStops ?? 0)} early stop(s), ${Number(manifest.learningHealth?.sampling?.counterfactualEstimatedPlayerTurnsSaved ?? 0)} estimated player-turn(s) saved, ${Number(manifest.learningHealth?.sampling?.adaptiveAudits ?? 0)} audit(s), ${Number(manifest.learningHealth?.sampling?.adaptiveAuditDisagreements ?? 0)} disagreement(s)`,
    `Pairwise repeated-input conflict: ${formatPercent(manifest.decisions.pairwiseInputConsistency?.conflictRate ?? 0)} across ${Number(manifest.decisions.pairwiseInputConsistency?.repeatedExamples ?? 0)} repeated example(s)`,
    `Unsynchronized counterfactuals rejected: ${Number(manifest.decisions.samplingTelemetry?.unsynchronizedCounterfactuals ?? 0)} (${formatPercent(manifest.learningHealth?.sampling?.unsynchronizedCounterfactualRate ?? 0)})`,
    `Raw log rows / unique decision rows: ${manifest.decisions.totalRows}/${manifest.decisions.uniqueRows}; decision duplicates ignored: ${manifest.decisions.duplicateRowsSkipped}`,
    `Learning health: ${manifest.learningHealth?.label ?? "Unknown"}`,
    ``,
    `## Learning Health`,
    ...(manifest.learningHealth?.blockers?.length > 0
      ? manifest.learningHealth.blockers.map((item) => `- BLOCKED: ${item}`)
      : [`- Blockers: none`]),
    ...(manifest.learningHealth?.warnings?.length > 0
      ? manifest.learningHealth.warnings.map((item) => `- Watch: ${item}`)
      : [`- Warnings: none`]),
    ...(manifest.learningHealth?.strengths?.length > 0
      ? manifest.learningHealth.strengths.map((item) => `- ${item}`)
      : []),
    ``,
    `## Decision Coverage`,
    `Significant phases: ${manifest.decisions.coverage?.significantPhaseCount ?? 0}; significant actions: ${manifest.decisions.coverage?.significantActionCount ?? 0}`,
    `Top phase: ${manifest.decisions.coverage?.topPhase ?? "none"} (${formatPercent(manifest.decisions.coverage?.topPhaseRate ?? 0)})`,
    `Top action: ${manifest.decisions.coverage?.topAction ?? "none"} (${formatPercent(manifest.decisions.coverage?.topActionRate ?? 0)})`,
    `Top credit phase: ${manifest.decisions.coverage?.topCreditPhase ?? "none"} (${formatPercent(manifest.decisions.coverage?.topCreditPhaseShare ?? 0)})`,
    `Top credit action: ${manifest.decisions.coverage?.topCreditAction ?? "none"} (${formatPercent(manifest.decisions.coverage?.topCreditActionShare ?? 0)})`,
    `Logged action types: ${manifest.decisions.coverage?.actionOpportunityCoverage?.loggedActionTypes ?? 0}; chosen action types: ${manifest.decisions.coverage?.actionOpportunityCoverage?.chosenActionTypes ?? 0}`,
    `Candidate-only actions: ${(manifest.decisions.coverage?.actionOpportunityCoverage?.candidateOnlyActions ?? []).slice(0, 8).join(", ") || "none"}`,
    `Candidate-only actions without causal coverage: ${(manifest.decisions.coverage?.actionOpportunityCoverage?.candidateOnlyUncoveredActions ?? []).slice(0, 8).join(", ") || "none"}`,
    `Raid normal-play opportunities: ${manifest.decisions.coverage?.actionOpportunityCoverage?.raidNormalPlay?.available ?? 0}; chosen: ${manifest.decisions.coverage?.actionOpportunityCoverage?.raidNormalPlay?.chosen ?? 0}; causal alternatives: ${manifest.decisions.coverage?.actionOpportunityCoverage?.raidNormalPlay?.causallyTested ?? 0}; covered: ${formatPercent(manifest.decisions.coverage?.actionOpportunityCoverage?.raidNormalPlay?.coverageRate ?? manifest.decisions.coverage?.actionOpportunityCoverage?.raidNormalPlay?.chosenRate ?? 0)}`,
    `Raid placement choices: ${formatBranchCoverage(manifest.decisions.coverage?.actionOpportunityCoverage?.raidPlacement)}`,
    `Field replacements: ${formatCoveredBranch(manifest.decisions.coverage?.actionOpportunityCoverage?.fieldReplacement)}`,
    `Nested resolution choices: ${formatResolutionChoiceCoverage(manifest.decisions.coverage?.actionOpportunityCoverage?.resolutionChoices)}`,
    `Counterfactual target phases: ${formatCountMetrics(manifest.decisions.counterfactualTargetPhaseCounts)}`,
    `Counterfactual decision phases: ${formatCountMetrics(manifest.decisions.counterfactualDecisionPhaseCounts)}`,
    `Counterfactual alternative selection: ${formatCountMetrics(manifest.decisions.counterfactualAlternativeSelectionCounts)}`,
    `Counterfactual sampling reasons: ${formatCountMetrics(manifest.decisions.counterfactualSamplingReasonCounts)}`,
    ``,
    `Top phases:`,
    ...manifest.decisions.phaseCounts.slice(0, 8).map((item) => `- ${item.key}: ${item.count}`),
    ``,
    `Top actions:`,
    ...manifest.decisions.actionCounts.slice(0, 10).map((item) => `- ${item.key}: ${item.count}`),
    ``,
    `## Strategic Feature Coverage`,
    `Candidate policy features: ${manifest.decisions.policyFeatureCoverage?.candidates?.observedBehavioralFeatures ?? 0}/${manifest.decisions.policyFeatureCoverage?.candidates?.totalBehavioralFeatures ?? 0} (${formatPercent(manifest.decisions.policyFeatureCoverage?.candidates?.coverageRate ?? 0)})`,
    `Candidate feature groups: ${manifest.decisions.policyFeatureCoverage?.candidates?.observedGroupCount ?? 0}/${manifest.decisions.policyFeatureCoverage?.candidates?.totalGroupCount ?? 0}`,
    `Missing important groups: ${importantMissingFeatureGroups(manifest.decisions.policyFeatureCoverage?.candidates?.missingGroups).join(", ") || "none"}`,
    `Top feature credit groups:`,
    ...(manifest.decisions.policyFeatureCoverage?.credit?.topGroups?.length > 0
      ? manifest.decisions.policyFeatureCoverage.credit.topGroups.slice(0, 8).map((item) => `- ${item.key}: ${formatPercent(item.share)} credit share`)
      : [`- none`]),
    ``,
    `## Action Model`,
    manifest.mlModel
      ? `- ${manifest.mlModel.path}: ${manifest.mlModel.examples} examples, ${manifest.mlModel.features} features, ${manifest.mlModel.uniqueLearningUnits ?? 0} unique learning units, ${manifest.mlModel.duplicateLearningUnitsSkipped ?? 0} duplicates ignored`
      : `- skipped`,
    ``,
    `## Matchup Profiles`,
    ...manifest.decisions.profileCounts.slice(0, 20).map((item) => `- ${item.key}: ${item.count}`),
    ``,
    `## Variant Status`,
    ...manifest.decisions.variantStatusCounts.map((item) => `- ${item.key}: ${item.count}`),
    ``,
    `## Unknown Variants`,
    ...(manifest.decisions.unknownVariants.length > 0
      ? manifest.decisions.unknownVariants.slice(0, 20).map((item) => `- ${item.key}: ${item.examples} examples; cards ${item.cardIds.map((card) => card.key).join(", ")}`)
      : [`- none`]),
    ``,
    `## Overlay Files`,
    `Active overlays for ${manifest.ownKey}: ${manifest.overlays.filter((item) => !item.candidate).length}`,
    `Inactive matchup candidates: ${manifest.overlays.filter((item) => item.candidate).length}`,
    `Variant overlays: ${manifest.overlays.filter((item) => !item.candidate && item.variant).length}`,
    `Active overlay changes: ${manifest.overlayChanges.created} created, ${manifest.overlayChanges.updated} updated, ${manifest.overlayChanges.unchanged} unchanged`,
    `Candidate changes: ${manifest.overlayChanges.candidateCreated} created, ${manifest.overlayChanges.candidateUpdated} updated, ${manifest.overlayChanges.candidateUnchanged} unchanged`,
    `Pruned saved-deck overlays: ${manifest.prunedKnownDeckOverlays.length}`,
    ``,
    `## Next Run`,
    ``,
    "```powershell",
    manifest.nextRun,
    "```",
    ``
  ];
  return `${lines.join("\n")}\n`;
}

function topCounts(rows, keyFn, limit) {
  return mostCommon(rows.map(keyFn), limit);
}

function formatCountMetrics(rows = []) {
  return rows.map((item) => `${item.key} ${item.count}`).join(", ") || "none";
}

function formatResolutionChoiceCoverage(summary = {}) {
  const kinds = summary?.kinds ?? [];
  if (kinds.length === 0) return "none";
  return kinds.map((kind) => {
    const options = (kind.options ?? [])
      .map((option) => `${option.option} ${formatCoveredBranch(option)}`)
      .join(", ");
    return `${kind.kind} (${options})`;
  }).join("; ");
}

function formatBranchCoverage(summary = {}) {
  const options = summary?.options ?? [];
  if (options.length === 0) return "none";
  return options.map((option) => `${option.option} ${formatCoveredBranch(option)}`).join(", ");
}

function formatCoveredBranch(branch = {}) {
  return `${Number(branch.chosen ?? 0)} played + ${Number(branch.causallyTested ?? 0)} causal / ${Number(branch.available ?? 0)} available`;
}

function branchCoveredCount(branch = {}) {
  if (branch.covered !== undefined && branch.covered !== null) return Number(branch.covered ?? 0);
  return Math.min(
    Number(branch.available ?? Number.MAX_SAFE_INTEGER),
    Number(branch.chosen ?? 0) + Number(branch.causallyTested ?? 0)
  );
}

function minimumBranchSamples(available) {
  return Math.max(2, Math.ceil(Number(available ?? 0) * 0.02));
}

function mostCommon(values, limit) {
  return [...groupBy(values.filter(Boolean), (value) => String(value)).entries()]
    .map(([key, group]) => ({ key, count: group.length }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit);
}

function groupBy(values, keyFn) {
  const groups = new Map();
  for (const value of values) {
    const key = keyFn(value);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(value);
  }
  return groups;
}

function average(rows, fn) {
  if (rows.length === 0) return 0;
  return rows.reduce((total, row) => total + Number(fn(row) ?? 0), 0) / rows.length;
}

function ratio(numerator, denominator) {
  const divisor = Number(denominator ?? 0);
  return divisor > 0 ? Number(numerator ?? 0) / divisor : 0;
}

function formatPercent(value) {
  return `${(Number(value ?? 0) * 100).toFixed(1)}%`;
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

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function usage() {
  console.log(`Usage:
  node tools/update-pilot-knowledge.mjs --input work/private/pilot-agent/runs/session [--own-key eva-purple]

This is the post-run learning step. It turns decision logs into:
  - work/private/pilot-agent/baselines/decks/<own-key>/action-model.json
  - broad matchup overlays
  - variant matchup overlays
  - a knowledge-update manifest and next-run.ps1

Options:
  --own-key eva-purple
  --player P1
  --policy-dir work/private/pilot-agent/policies
  --baseline-root work/private/pilot-agent/baselines
  --agent-root work/private/pilot-agent
  --out-dir work/private/pilot-agent/knowledge-updates/session
  --ml-out work/private/pilot-agent/baselines/decks/eva-purple/action-model.json
  --skip-ml
  --skip-profile-overlays
  --skip-variant-overlays
  --serial-artifact-training
  --keep-known-deck-overlays
  --force-knowledge-training
  --learning-mode selected|all|pairwise|regret
  --ml-learning-mode selected|all|pairwise|regret
  --overlay-learning-mode selected|all|pairwise|regret
  --pairwise-scale 0.7
  --min-examples 80
  --variant-min-examples 80
  --min-observations 12
  --min-contextual-observations 24
  --max-model-features 512`);
}
