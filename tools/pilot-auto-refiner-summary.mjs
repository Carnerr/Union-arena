#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeJsonAtomicSync, writeTextAtomicSync } from "../src/artifact-io.js";

const statePath = option("--state") ?? "work/private/pilot-agent/auto-refiner/auto-refine/auto-refiner-state.json";
const reason = option("--reason") ?? "summary";
const outDir = option("--out-dir") ?? dirname(statePath);

if (hasFlag("--help")) {
  usage();
  process.exit(0);
}

if (!existsSync(statePath)) {
  throw new Error(`Auto Refine state file not found: ${statePath}`);
}

const state = readJson(statePath);
const summary = buildSummary(state, { statePath, outDir, reason });
mkdirSync(outDir, { recursive: true });
const jsonPath = join(outDir, "auto-refiner-summary.json");
const markdownPath = join(outDir, "auto-refiner-summary.md");
writeJsonAtomicSync(jsonPath, summary);
writeTextAtomicSync(markdownPath, summaryMarkdown(summary));

console.log(`Auto Refine summary written: ${markdownPath}`);
console.log(`Summary JSON: ${jsonPath}`);

function buildSummary(state, { statePath, outDir, reason }) {
  const jobs = Array.isArray(state.jobs) ? state.jobs : [];
  const schedulerSkips = jobs.filter((job) => job.taskType === "readiness-skip" || job.attempts?.every((attempt) => attempt.skipped));
  const trainingJobs = jobs.filter((job) => !schedulerSkips.includes(job));
  const taskRows = jobs.flatMap((job) => taskRowsForJob(job));
  const completedTaskRows = taskRows.filter((row) => row.result);
  const deckRows = summarizeBy(completedTaskRows, (row) => row.deckName ?? row.deckId ?? "unknown deck");
  const matchupRows = summarizeBy(completedTaskRows, (row) => `${row.deckName ?? row.deckId ?? "unknown"} vs ${row.opponentLabel ?? row.opponentKey ?? "unknown"}`);
  const learning = summarizeLearning(jobs, completedTaskRows);
  const artifactChanges = summarizeArtifactChanges(jobs, completedTaskRows);
  const baselinePromotions = summarizeBaselinePromotions(jobs);
  const validationRollbacks = summarizeValidationRollbacks(jobs);
  const currentJob = state.currentJob ?? null;
  return {
    schema: "union-arena-local-engine/auto-refiner-summary@1",
    createdAt: new Date().toISOString(),
    reason,
    statePath,
    outDir,
    session: state.session ?? null,
    startedAt: state.startedAt ?? null,
    completedAt: state.completedAt ?? null,
    stopReason: state.stopReason ?? null,
    currentJob: currentJob ? {
      job: currentJob.job ?? null,
      stage: currentJob.stage ?? null,
      deckId: currentJob.deckId ?? null,
      deckName: currentJob.deckName ?? null,
      ownKey: currentJob.ownKey ?? null,
      taskType: currentJob.taskType ?? null,
      startedAt: currentJob.startedAt ?? null,
      status: currentJob.status ?? null,
      command: currentJob.command ?? null
    } : null,
    config: state.config ?? {},
    totals: {
      schedulerSteps: jobs.length,
      schedulerSkips: schedulerSkips.length,
      jobs: trainingJobs.length,
      successfulJobs: trainingJobs.filter((job) => Number(job.status ?? 0) === 0).length,
      failedJobs: trainingJobs.filter((job) => Number(job.status ?? 0) !== 0).length,
      taskRows: taskRows.length,
      completedTaskRows: completedTaskRows.length,
      games: sum(completedTaskRows, (row) => row.result?.total),
      wins: sum(completedTaskRows, (row) => row.result?.wins),
      losses: sum(completedTaskRows, (row) => row.result?.losses),
      incomplete: sum(completedTaskRows, (row) => row.result?.incomplete),
      averageWinRate: weightedAverage(completedTaskRows, (row) => row.result?.winRate, (row) => row.result?.total),
      averageLifeDiff: weightedAverage(completedTaskRows, (row) => row.result?.avgLifeDiff, (row) => row.result?.total),
      averageTurnCycles: weightedAverage(completedTaskRows, (row) => row.result?.avgTurnCycles, (row) => row.result?.total)
    },
    learning,
    artifactChanges,
    baselinePromotions,
    validationRollbacks,
    decks: deckRows,
    matchups: matchupRows,
    biggestWinRateIncreases: sortedDeltas(completedTaskRows, "winRateDelta", "desc").slice(0, 12),
    biggestWinRateDecreases: sortedDeltas(completedTaskRows, "winRateDelta", "asc").slice(0, 12),
    biggestLifeDiffIncreases: sortedDeltas(completedTaskRows, "lifeDiffDelta", "desc").slice(0, 12),
    biggestLifeDiffDecreases: sortedDeltas(completedTaskRows, "lifeDiffDelta", "asc").slice(0, 12),
    jobs: jobs.map((job) => summarizeJob(job, taskRows.filter((row) => row.job === job.job)))
  };
}

function taskRowsForJob(job) {
  if (!job?.outRoot) return [];
  const sweep = readJsonIfExists(join(job.outRoot, "matchup-sweep-state.json"));
  const tasks = Array.isArray(sweep?.results) && sweep.results.length > 0
    ? sweep.results
    : Array.isArray(sweep?.selectedTasks)
      ? sweep.selectedTasks
      : [];
  return tasks.map((task) => {
    const taskOutRoot = extractArg(task.command, "--out-root");
    const loopState = taskOutRoot ? readJsonIfExists(join(taskOutRoot, "loop-state.json")) : null;
    const cycle = Array.isArray(loopState?.cycles) ? loopState.cycles.at(-1) : null;
    const report = cycle?.runDir ? readJsonIfExists(join(cycle.runDir, "report.json")) : null;
    const knowledgeDir = cycle?.knowledgeDir
      ?? extractArg(cycle?.knowledgeResult?.command, "--out-dir")
      ?? (taskOutRoot ? join(taskOutRoot, `cycle-${String(cycle?.cycle ?? 1).padStart(2, "0")}`, "knowledge") : null);
    const knowledgeUpdate = knowledgeDir ? readJsonIfExists(join(knowledgeDir, "knowledge-update.json")) : null;
    const result = report?.result ?? cycle?.result ?? null;
    const baseline = report?.baselineSummary ?? cycle?.baselineSummary ?? null;
    const priorWinRate = finiteNumber(task.currentWinRate);
    const priorLifeDiff = finiteNumber(task.currentAvgLifeDiff);
    const runWinRate = finiteNumber(result?.winRate);
    const runLifeDiff = finiteNumber(result?.avgLifeDiff);
    return {
      job: job.job ?? null,
      stage: job.stage ?? null,
      deckId: task.deckId ?? job.deckId ?? null,
      deckName: task.deckName ?? job.deckName ?? null,
      ownKey: task.ownKey ?? job.ownKey ?? null,
      opponentKey: task.opponentKey ?? null,
      opponentLabel: task.opponentLabel ?? task.opponentKey ?? null,
      opponentListCount: Number(task.opponentListCount ?? 0),
      opponentSampleSize: Number(task.opponentSampleSize ?? 0),
      prior: {
        games: Number(task.currentGames ?? 0),
        winRate: priorWinRate,
        avgLifeDiff: priorLifeDiff
      },
      result,
      baseline,
      deltas: {
        winRateDelta: runWinRate !== null && priorWinRate !== null ? runWinRate - priorWinRate : null,
        lifeDiffDelta: runLifeDiff !== null && priorLifeDiff !== null ? runLifeDiff - priorLifeDiff : null,
        scoreDeltaVsBaseline: finiteNumber(result?.score) !== null && finiteNumber(baseline?.score) !== null
          ? Number(result.score) - Number(baseline.score)
          : null
      },
      runDir: cycle?.runDir ?? null,
      knowledgeDir,
      stopDecision: cycle?.stopDecision ?? null,
      promotion: cycle?.promotion ?? null,
      routedPromotion: cycle?.routedPromotion ?? null,
      knowledgeSummary: cycle?.knowledgeSummary ?? summarizeKnowledgeUpdate(knowledgeUpdate)
    };
  });
}

function summarizeJob(job, rows) {
  return {
    job: job.job ?? null,
    stage: job.stage ?? null,
    deckId: job.deckId ?? null,
    deckName: job.deckName ?? null,
    ownKey: job.ownKey ?? null,
    taskType: job.taskType ?? null,
    status: job.status ?? null,
    startedAt: job.startedAt ?? null,
    endedAt: job.endedAt ?? null,
    selectedTasks: job.selectedTasks ?? rows.length,
    games: sum(rows, (row) => row.result?.total),
    winRate: weightedAverage(rows, (row) => row.result?.winRate, (row) => row.result?.total),
    avgLifeDiff: weightedAverage(rows, (row) => row.result?.avgLifeDiff, (row) => row.result?.total),
    artifactChanged: Boolean(job.artifactChanged),
    artifactProgressAccepted: job.artifactProgressAccepted ?? null,
    learningEvidenceQuality: job.learningEvidenceQuality ?? null,
    baselinePromotions: job.baselinePromotions ?? null,
    learningProgress: job.learningProgress ?? null,
    matchupValidation: job.matchupValidation ?? null,
    matchupValidationRollback: job.matchupValidationRollback ?? null,
    stopReason: job.stopReason ?? null,
    outRoot: job.outRoot ?? null
  };
}

function summarizeBy(rows, keyFn) {
  const grouped = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const bucket = grouped.get(key) ?? [];
    bucket.push(row);
    grouped.set(key, bucket);
  }
  return [...grouped.entries()]
    .map(([label, group]) => ({
      label,
      games: sum(group, (row) => row.result?.total),
      wins: sum(group, (row) => row.result?.wins),
      losses: sum(group, (row) => row.result?.losses),
      incomplete: sum(group, (row) => row.result?.incomplete),
      winRate: weightedAverage(group, (row) => row.result?.winRate, (row) => row.result?.total),
      avgLifeDiff: weightedAverage(group, (row) => row.result?.avgLifeDiff, (row) => row.result?.total),
      avgTurnCycles: weightedAverage(group, (row) => row.result?.avgTurnCycles, (row) => row.result?.total),
      avgWinRateDelta: average(group.map((row) => row.deltas.winRateDelta).filter((value) => value !== null)),
      avgLifeDiffDelta: average(group.map((row) => row.deltas.lifeDiffDelta).filter((value) => value !== null)),
      bestScoreDeltaVsBaseline: max(group, (row) => row.deltas.scoreDeltaVsBaseline),
      tasks: group.length
    }))
    .sort((a, b) => Number(b.games ?? 0) - Number(a.games ?? 0) || a.label.localeCompare(b.label));
}

function summarizeLearning(jobs, rows = []) {
  const totals = jobs.reduce((accumulator, job) => {
    const progress = job.learningProgress ?? {};
    accumulator.updates += Number(progress.updates ?? 0);
    accumulator.modelExamples = Math.max(accumulator.modelExamples, Number(progress.modelExamples ?? 0));
    accumulator.modelFeatures = Math.max(accumulator.modelFeatures, Number(progress.modelFeatures ?? 0));
    accumulator.modelPairwiseExamples = Math.max(accumulator.modelPairwiseExamples, Number(progress.modelPairwiseExamples ?? 0));
    accumulator.overlays = Math.max(accumulator.overlays, Number(progress.overlays ?? 0));
    accumulator.overlayCandidates = Math.max(accumulator.overlayCandidates, Number(progress.overlayCandidates ?? 0));
    accumulator.overlayCreated += Number(progress.overlayCreated ?? 0);
    accumulator.overlayUpdated += Number(progress.overlayUpdated ?? 0);
    accumulator.overlayRemoved += Number(progress.overlayRemoved ?? 0);
    accumulator.overlayUnchanged += Number(progress.overlayUnchanged ?? 0);
    accumulator.overlayCandidateCreated += Number(progress.overlayCandidateCreated ?? 0);
    accumulator.overlayCandidateUpdated += Number(progress.overlayCandidateUpdated ?? 0);
    accumulator.overlayCandidateRemoved += Number(progress.overlayCandidateRemoved ?? 0);
    accumulator.overlayCandidateUnchanged += Number(progress.overlayCandidateUnchanged ?? 0);
    accumulator.chosenRows += Number(progress.chosenRows ?? 0);
    accumulator.counterfactualRows += Number(progress.counterfactualRows ?? 0);
    mergeLearningHealth(accumulator.health, progress.health, { job: job.job, deckName: job.deckName, source: "job" });
    mergeEvidenceQuality(
      accumulator.evidenceQuality,
      job.learningEvidenceQuality ?? progress.evidenceQuality ?? evidenceQualityFromHealth(progress.health),
      { job: job.job, deckName: job.deckName, source: "job" }
    );
    return accumulator;
  }, {
    updates: 0,
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
    health: emptyLearningHealth(),
    evidenceQuality: emptyEvidenceQuality()
  });
  const jobsWithProgress = new Set(
    jobs
      .filter((job) => Number(job.learningProgress?.updates ?? 0) > 0 || Number(job.learningProgress?.chosenRows ?? 0) > 0)
      .map((job) => job.job)
  );
  for (const row of rows) {
    if (jobsWithProgress.has(row.job)) continue;
    const progress = row.knowledgeSummary;
    if (!progress) continue;
    totals.updates += Number(progress.updates ?? 0);
    totals.modelExamples = Math.max(totals.modelExamples, Number(progress.modelExamples ?? 0));
    totals.modelFeatures = Math.max(totals.modelFeatures, Number(progress.modelFeatures ?? 0));
    totals.modelPairwiseExamples = Math.max(totals.modelPairwiseExamples, Number(progress.modelPairwiseExamples ?? 0));
    totals.overlays = Math.max(totals.overlays, Number(progress.overlays ?? 0));
    totals.overlayCandidates = Math.max(totals.overlayCandidates, Number(progress.overlayCandidates ?? 0));
    totals.overlayCreated += Number(progress.overlayCreated ?? 0);
    totals.overlayUpdated += Number(progress.overlayUpdated ?? 0);
    totals.overlayRemoved += Number(progress.overlayRemoved ?? 0);
    totals.overlayUnchanged += Number(progress.overlayUnchanged ?? 0);
    totals.overlayCandidateCreated += Number(progress.overlayCandidateCreated ?? 0);
    totals.overlayCandidateUpdated += Number(progress.overlayCandidateUpdated ?? 0);
    totals.overlayCandidateRemoved += Number(progress.overlayCandidateRemoved ?? 0);
    totals.overlayCandidateUnchanged += Number(progress.overlayCandidateUnchanged ?? 0);
    totals.chosenRows += Number(progress.chosenRows ?? 0);
    totals.counterfactualRows += Number(progress.counterfactualRows ?? 0);
    mergeLearningHealth(totals.health, progress.health, { job: row.job, deckName: row.deckName, source: "task" });
    mergeEvidenceQuality(
      totals.evidenceQuality,
      progress.evidenceQuality ?? evidenceQualityFromHealth(progress.health),
      { job: row.job, deckName: row.deckName, source: "task" }
    );
  }
  return totals;
}

function summarizeKnowledgeUpdate(update) {
  if (!update) return null;
  return {
    updates: 1,
    modelExamples: Number(update.mlModel?.examples ?? 0),
    modelFeatures: Number(update.mlModel?.features ?? 0),
    modelPairwiseExamples: Number(update.mlModel?.pairwiseExamples ?? 0),
    overlays: Array.isArray(update.overlays) ? update.overlays.filter((overlay) => !overlay.candidate).length : 0,
    overlayCandidates: Array.isArray(update.overlays) ? update.overlays.filter((overlay) => overlay.candidate).length : 0,
    overlayCreated: Number(update.overlayChanges?.created ?? 0),
    overlayUpdated: Number(update.overlayChanges?.updated ?? 0),
    overlayRemoved: Number(update.overlayChanges?.removed ?? 0),
    overlayUnchanged: Number(update.overlayChanges?.unchanged ?? 0),
    overlayCandidateCreated: Number(update.overlayChanges?.candidateCreated ?? 0),
    overlayCandidateUpdated: Number(update.overlayChanges?.candidateUpdated ?? 0),
    overlayCandidateRemoved: Number(update.overlayChanges?.candidateRemoved ?? 0),
    overlayCandidateUnchanged: Number(update.overlayChanges?.candidateUnchanged ?? 0),
    chosenRows: Number(update.decisions?.chosenRows ?? 0),
    counterfactualRows: Number(update.decisions?.counterfactual ?? 0),
    health: update.learningHealth ? normalizeSingleLearningHealth(update.learningHealth, {
      ownKey: update.ownKey ?? null,
      deckId: update.deckId ?? null
    }) : emptyLearningHealth(),
    evidenceQuality: update.learningHealth
      ? evidenceQualityFromHealth(normalizeSingleLearningHealth(update.learningHealth, {
        ownKey: update.ownKey ?? null,
        deckId: update.deckId ?? null
      }))
      : emptyEvidenceQuality()
  };
}

function emptyEvidenceQuality() {
  return {
    healthy: 0,
    watch: 0,
    thin: 0,
    blocked: 0,
    unknown: 0,
    none: 0,
    needsRicherSampling: 0,
    rows: []
  };
}

function emptyLearningHealth() {
  return {
    healthy: 0,
    watch: 0,
    blocked: 0,
    unknown: 0,
    rows: []
  };
}

function normalizeSingleLearningHealth(health, extra = {}) {
  const result = emptyLearningHealth();
  const status = learningHealthStatus(health?.status);
  result[status] += 1;
  result.rows.push({
    ...extra,
    status,
    label: health?.label ?? status,
    blockers: Array.isArray(health?.blockers) ? health.blockers.slice(0, 5) : [],
    warnings: Array.isArray(health?.warnings) ? health.warnings.slice(0, 5) : [],
    incompleteRate: Number(health?.rates?.incomplete ?? 0),
    forcedRate: Number(health?.rates?.forced ?? 0),
    explorationRate: Number(health?.rates?.exploration ?? 0),
    counterfactualRate: Number(health?.rates?.counterfactual ?? 0)
  });
  return result;
}

function mergeLearningHealth(target, source, extra = {}) {
  if (!source) return target;
  if (source.status) {
    return mergeLearningHealth(target, normalizeSingleLearningHealth(source, extra));
  }
  for (const key of ["healthy", "watch", "blocked", "unknown"]) {
    target[key] += Number(source[key] ?? 0);
  }
  for (const row of Array.isArray(source.rows) ? source.rows : []) {
    target.rows.push({ ...extra, ...row });
  }
  return target;
}

function mergeEvidenceQuality(target, source, extra = {}) {
  if (!source) return target;
  if (source.status) {
    const status = evidenceQualityStatus(source.status);
    target[status] += 1;
    if (source.needsRicherSampling) target.needsRicherSampling += 1;
    target.rows.push({
      ...extra,
      status,
      needsRicherSampling: Boolean(source.needsRicherSampling),
      reason: source.reason ?? null,
      chosenRows: Number(source.chosenRows ?? 0),
      counterfactualRows: Number(source.counterfactualRows ?? 0),
      minCounterfactualRate: source.minCounterfactualRate ?? null
    });
    return target;
  }
  for (const key of ["healthy", "watch", "thin", "blocked", "unknown", "none", "needsRicherSampling"]) {
    target[key] += Number(source[key] ?? 0);
  }
  for (const row of Array.isArray(source.rows) ? source.rows : []) {
    target.rows.push({ ...extra, ...row });
  }
  return target;
}

function evidenceQualityFromHealth(health) {
  const result = emptyEvidenceQuality();
  const rows = Array.isArray(health?.rows) ? health.rows : [];
  if (rows.length === 0) {
    mergeEvidenceQuality(result, {
      status: Number(health?.healthy ?? 0) > 0 ? "healthy" : Number(health?.watch ?? 0) > 0 ? "watch" : "none",
      needsRicherSampling: false
    });
    return result;
  }
  for (const row of rows) {
    const needsRicherSampling = rowNeedsRicherSampling(row);
    mergeEvidenceQuality(result, {
      status: row.status === "blocked" ? "blocked" : needsRicherSampling ? "thin" : evidenceQualityStatus(row.status),
      needsRicherSampling,
      reason: row.blockers?.[0] ?? row.warnings?.[0] ?? null,
      chosenRows: Number(row.chosenRows ?? 0),
      counterfactualRows: Number(row.counterfactualRows ?? 0),
      minCounterfactualRate: Number.isFinite(Number(row.counterfactualRate)) ? Number(row.counterfactualRate) : null
    });
  }
  return result;
}

function rowNeedsRicherSampling(row) {
  const chosenRows = Number(row?.chosenRows ?? 0);
  const counterfactualRows = Number(row?.counterfactualRows ?? 0);
  if (chosenRows >= 80 && counterfactualRows === 0) return true;
  const counterfactualRate = Number(row?.counterfactualRate ?? 0);
  if (chosenRows >= 80 && Number.isFinite(counterfactualRate) && counterfactualRate > 0 && counterfactualRate < 0.03) return true;
  const text = [
    ...(Array.isArray(row?.blockers) ? row.blockers : []),
    ...(Array.isArray(row?.warnings) ? row.warnings : [])
  ].join(" ").toLowerCase();
  return /counterfactual|pairwise/.test(text)
    && /(thin|starved|only|no reliable|no counterfactual|no pairwise|converge slowly)/.test(text);
}

function evidenceQualityStatus(value) {
  const status = String(value ?? "unknown").toLowerCase();
  if (["healthy", "watch", "thin", "blocked", "unknown", "none"].includes(status)) return status;
  return "unknown";
}

function learningHealthStatus(value) {
  const status = String(value ?? "unknown").toLowerCase();
  if (status === "healthy" || status === "watch" || status === "blocked") return status;
  return "unknown";
}

function summarizeArtifactChanges(jobs, taskRows = []) {
  const artifactRows = jobs.flatMap((job) => job.profileChange?.changedArtifacts ?? []);
  const jobsWithProgress = new Set(
    jobs
      .filter((job) => Number(job.learningProgress?.updates ?? 0) > 0 || Number(job.learningProgress?.chosenRows ?? 0) > 0)
      .map((job) => job.job)
  );
  let recoveredActionModels = 0;
  let recoveredMatchupOverlays = 0;
  for (const taskRow of taskRows) {
    if (jobsWithProgress.has(taskRow.job)) continue;
    const progress = taskRow.knowledgeSummary;
    if (!progress) continue;
    recoveredActionModels += Number(progress.modelExamples ?? 0) > 0 ? 1 : 0;
    recoveredMatchupOverlays += Number(progress.overlayCreated ?? 0)
      + Number(progress.overlayUpdated ?? 0)
      + Number(progress.overlayRemoved ?? 0);
  }
  return {
    total: artifactRows.length + recoveredActionModels + recoveredMatchupOverlays,
    baselinePolicies: artifactRows.filter((row) => String(row.kind ?? "").includes("baseline-policy")).length,
    actionModels: artifactRows.filter((row) => String(row.kind ?? "").includes("action-model")).length + recoveredActionModels,
    matchupOverlays: artifactRows.filter((row) => String(row.kind ?? "").includes("matchup-overlay")).length + recoveredMatchupOverlays,
    rows: artifactRows.slice(0, 80)
  };
}

function summarizeBaselinePromotions(jobs) {
  const rows = jobs.flatMap((job) => Array.isArray(job.baselinePromotions?.rows)
    ? job.baselinePromotions.rows.map((row) => ({ ...row, job: job.job, stage: job.stage }))
    : []);
  return {
    updates: rows.length,
    promoted: rows.filter((row) => row.promote).length,
    rejected: rows.filter((row) => !row.promote).length,
    missingSeeded: rows.filter((row) => row.promote && row.missingSpecialist).length,
    rows: rows.slice(0, 80)
  };
}

function summarizeValidationRollbacks(jobs) {
  const rows = jobs.flatMap((job) => Array.isArray(job.matchupValidationRollback?.rows)
    ? job.matchupValidationRollback.rows.map((row) => ({ ...row, job: job.job, stage: job.stage, deckName: job.deckName }))
    : []);
  return {
    updates: rows.length,
    rolledBack: rows.filter((row) => row.rolledBack).length,
    failed: rows.filter((row) => !row.rolledBack).length,
    rows: rows.slice(0, 80)
  };
}

function sortedDeltas(rows, key, direction) {
  return rows
    .filter((row) => row.deltas?.[key] !== null && Number.isFinite(Number(row.deltas[key])))
    .filter((row) => direction === "asc" ? Number(row.deltas[key]) < 0 : Number(row.deltas[key]) > 0)
    .map((row) => ({
      deck: row.deckName ?? row.deckId,
      ownKey: row.ownKey,
      opponent: row.opponentLabel ?? row.opponentKey,
      priorGames: row.prior.games,
      priorWinRate: row.prior.winRate,
      resultGames: Number(row.result?.total ?? 0),
      resultWinRate: finiteNumber(row.result?.winRate),
      resultLifeDiff: finiteNumber(row.result?.avgLifeDiff),
      winRateDelta: row.deltas.winRateDelta,
      lifeDiffDelta: row.deltas.lifeDiffDelta,
      scoreDeltaVsBaseline: row.deltas.scoreDeltaVsBaseline,
      runDir: row.runDir
    }))
    .sort((a, b) => direction === "asc"
      ? Number(a[key] ?? 0) - Number(b[key] ?? 0)
      : Number(b[key] ?? 0) - Number(a[key] ?? 0));
}

function summaryMarkdown(summary) {
  const lines = [
    "# Auto Refine Summary",
    "",
    `Session: ${summary.session ?? "unknown"}`,
    `Created: ${summary.createdAt}`,
    `Reason: ${summary.reason}`,
    `State: \`${summary.statePath}\``,
    summary.currentJob ? `Interrupted/current job: ${summary.currentJob.stage} ${summary.currentJob.deckName} (${summary.currentJob.status})` : null,
    "",
    "## Totals",
    `- Training jobs completed: ${summary.totals.jobs} (${summary.totals.successfulJobs} successful, ${summary.totals.failedJobs} failed)`,
    `- Scheduler steps: ${summary.totals.schedulerSteps} (${summary.totals.schedulerSkips} readiness skips)`,
    `- Completed matchup tasks: ${summary.totals.completedTaskRows}`,
    `- Games summarized: ${summary.totals.games} (${summary.totals.wins}/${summary.totals.losses}/${summary.totals.incomplete})`,
    `- Average win rate: ${percent(summary.totals.averageWinRate)}`,
    `- Average life diff: ${number(summary.totals.averageLifeDiff, 2)}`,
    `- Average turn cycles: ${number(summary.totals.averageTurnCycles, 2)}`,
    "",
    "## Learning",
    `- Knowledge updates: ${summary.learning.updates}`,
    `- Action model: ${summary.learning.modelExamples} examples, ${summary.learning.modelPairwiseExamples} pairwise examples, ${summary.learning.modelFeatures} features`,
    `- Active overlays: ${summary.learning.overlayCreated} created, ${summary.learning.overlayUpdated} updated, ${summary.learning.overlayRemoved} removed, ${summary.learning.overlayUnchanged} unchanged`,
    `- Inactive matchup candidates: ${summary.learning.overlayCandidateCreated} created, ${summary.learning.overlayCandidateUpdated} updated, ${summary.learning.overlayCandidateRemoved} removed, ${summary.learning.overlayCandidateUnchanged} unchanged`,
    `- Chosen decision rows consumed: ${summary.learning.chosenRows}; counterfactual decisions: ${summary.learning.counterfactualRows}`,
    `- Learning health: ${summary.learning.health.healthy} healthy, ${summary.learning.health.watch} watch, ${summary.learning.health.blocked} blocked, ${summary.learning.health.unknown} unknown`,
    `- Evidence quality: ${summary.learning.evidenceQuality.healthy} healthy, ${summary.learning.evidenceQuality.watch} watch, ${summary.learning.evidenceQuality.thin} thin, ${summary.learning.evidenceQuality.blocked} blocked; ${summary.learning.evidenceQuality.needsRicherSampling} need richer sampling`,
    ...(summary.learning.health.blocked > 0 || summary.learning.health.watch > 0
      ? summary.learning.health.rows
        .filter((row) => row.status === "blocked" || row.status === "watch")
        .slice(0, 8)
        .map((row) => `- ${String(row.status).toUpperCase()} ${row.deckName ?? row.deckId ?? row.ownKey ?? "profile"}: ${row.blockers?.[0] ?? row.warnings?.[0] ?? "review learning-health details"}`)
      : []),
    `- Baseline promotions: ${summary.baselinePromotions.promoted}/${summary.baselinePromotions.updates} kept (${summary.baselinePromotions.rejected} rejected)`,
    `- Matchup validation rollbacks: ${summary.validationRollbacks.rolledBack}/${summary.validationRollbacks.updates} rolled back (${summary.validationRollbacks.failed} rollback failures)`,
    `- Artifact changes: ${summary.artifactChanges.total} (${summary.artifactChanges.baselinePolicies} baseline, ${summary.artifactChanges.actionModels} action model, ${summary.artifactChanges.matchupOverlays} matchup overlay)`,
    "",
    "## Decks",
    ...tableLines(summary.decks.slice(0, 20), ["label", "games", "winRate", "avgLifeDiff", "avgWinRateDelta", "tasks"], {
      winRate: percent,
      avgLifeDiff: (value) => number(value, 2),
      avgWinRateDelta: signedPercent,
      games: String,
      tasks: String
    }),
    "",
    "## Biggest Win-Rate Increases",
    ...deltaLines(summary.biggestWinRateIncreases.slice(0, 10), "winRateDelta"),
    "",
    "## Biggest Win-Rate Decreases",
    ...deltaLines(summary.biggestWinRateDecreases.slice(0, 10), "winRateDelta"),
    "",
    "## Biggest Life-Diff Increases",
    ...deltaLines(summary.biggestLifeDiffIncreases.slice(0, 10), "lifeDiffDelta"),
    "",
    "## Biggest Life-Diff Decreases",
    ...deltaLines(summary.biggestLifeDiffDecreases.slice(0, 10), "lifeDiffDelta"),
    "",
    "## Files",
    `- JSON: \`${join(summary.outDir, "auto-refiner-summary.json")}\``,
    `- Markdown: \`${join(summary.outDir, "auto-refiner-summary.md")}\``,
    ""
  ].filter((line) => line !== null);
  return `${lines.join("\n")}\n`;
}

function tableLines(rows, columns, formatters = {}) {
  if (rows.length === 0) return ["- No completed rows yet."];
  const header = `| ${columns.join(" | ")} |`;
  const divider = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${columns.map((column) => {
    const formatter = formatters[column] ?? String;
    return escapeTable(formatter(row[column] ?? ""));
  }).join(" | ")} |`);
  return [header, divider, ...body];
}

function deltaLines(rows, key) {
  if (rows.length === 0) return ["- No completed rows with prior evidence yet."];
  return rows.map((row) => {
    const delta = key === "winRateDelta" ? signedPercent(row[key]) : signedNumber(row[key], 2);
    return `- ${row.deck} vs ${row.opponent}: ${delta} (${row.resultGames} games, win ${percent(row.resultWinRate)}, life ${number(row.resultLifeDiff, 2)}, prior ${row.priorGames} games)`;
  });
}

function extractArg(command, flag) {
  if (!command) return null;
  const parts = String(command).match(/"[^"]*"|\S+/gu) ?? [];
  const clean = parts.map((part) => part.startsWith("\"") && part.endsWith("\"") ? part.slice(1, -1).replace(/\\"/g, "\"") : part);
  const index = clean.indexOf(flag);
  return index === -1 ? null : clean[index + 1] ?? null;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonIfExists(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return readJson(path);
  } catch {
    return null;
  }
}

function sum(rows, fn) {
  return rows.reduce((total, row) => total + (finiteNumber(fn(row)) ?? 0), 0);
}

function average(values) {
  const clean = values.map(finiteNumber).filter((value) => value !== null);
  return clean.length ? clean.reduce((total, value) => total + value, 0) / clean.length : null;
}

function weightedAverage(rows, valueFn, weightFn) {
  const weighted = rows
    .map((row) => ({ value: finiteNumber(valueFn(row)), weight: finiteNumber(weightFn(row)) }))
    .filter((row) => row.value !== null && row.weight !== null && row.weight > 0);
  const weight = weighted.reduce((total, row) => total + row.weight, 0);
  if (weight <= 0) return null;
  return weighted.reduce((total, row) => total + row.value * row.weight, 0) / weight;
}

function max(rows, fn) {
  const values = rows.map((row) => finiteNumber(fn(row))).filter((value) => value !== null);
  return values.length ? Math.max(...values) : null;
}

function min(rows, fn) {
  const values = rows.map((row) => finiteNumber(fn(row))).filter((value) => value !== null);
  return values.length ? Math.min(...values) : null;
}

function finiteNumber(value) {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function percent(value) {
  const parsed = finiteNumber(value);
  return parsed === null ? "-" : `${(parsed * 100).toFixed(1)}%`;
}

function signedPercent(value) {
  const parsed = finiteNumber(value);
  if (parsed === null) return "-";
  const sign = parsed > 0 ? "+" : "";
  return `${sign}${(parsed * 100).toFixed(1)} pts`;
}

function number(value, digits = 2) {
  const parsed = finiteNumber(value);
  return parsed === null ? "-" : parsed.toFixed(digits);
}

function signedNumber(value, digits = 2) {
  const parsed = finiteNumber(value);
  if (parsed === null) return "-";
  const sign = parsed > 0 ? "+" : "";
  return `${sign}${parsed.toFixed(digits)}`;
}

function escapeTable(value) {
  return String(value).replace(/\|/gu, "\\|");
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
  node tools/pilot-auto-refiner-summary.mjs --state work/private/pilot-agent/auto-refiner/session/auto-refiner-state.json

Writes:
  auto-refiner-summary.md
  auto-refiner-summary.json`);
}
