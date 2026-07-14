function pilotOutcomeValue(row) {
  if (row?.winner === "P1") return 1;
  if (row?.winner === "P2") return 0;
  return 0.5;
}

function pilotLifeDiff(row) {
  return Number(row?.p1LifeRemaining ?? 0) - Number(row?.p2LifeRemaining ?? 0);
}

export const PILOT_PERFORMANCE_SCORE_VERSION = 2;

export function completedMatchupMetricSummary({
  wins = 0,
  losses = 0,
  incomplete = 0,
  completedLifeDiffTotal = 0,
  completedTurnCyclesTotal = 0,
  completedPlayerTurnsTotal = 0
} = {}) {
  const winCount = nonnegativeCount(wins);
  const lossCount = nonnegativeCount(losses);
  const incompleteCount = nonnegativeCount(incomplete);
  const completedGames = winCount + lossCount;
  const games = completedGames + incompleteCount;
  const completedDenominator = Math.max(1, completedGames);
  const gameDenominator = Math.max(1, games);
  return {
    games,
    completedGames,
    incomplete: incompleteCount,
    winRate: winCount / completedDenominator,
    completionRate: completedGames / gameDenominator,
    incompleteRate: incompleteCount / gameDenominator,
    avgLifeDiff: finiteNumber(completedLifeDiffTotal, 0) / completedDenominator,
    avgTurnCycles: finiteNumber(completedTurnCyclesTotal, 0) / completedDenominator,
    avgPlayerTurns: finiteNumber(completedPlayerTurnsTotal, 0) / completedDenominator
  };
}

export function pilotPerformanceScore(summary = {}) {
  const total = Math.max(0, finiteNumber(summary.total, 0));
  const rawWins = Number(summary.wins);
  const rawIncomplete = Number(summary.incomplete);
  const winRate = total > 0 && Number.isFinite(rawWins)
    ? clamp01(rawWins / total)
    : clamp01(summary.winRate ?? 0);
  const incompleteRate = total > 0 && Number.isFinite(rawIncomplete)
    ? clamp01(rawIncomplete / total)
    : clamp01(summary.incompleteRate ?? 0);
  const avgLifeDiff = finiteNumber(summary.avgLifeDiff, 0);
  return winRate * 1000 + avgLifeDiff * 12 - incompleteRate * 650;
}

function gamePairKey(row, index) {
  return [
    row?.seed ?? "seed",
    row?.opponent ?? "opponent",
    row?.firstPlayer ?? "first",
    row?.index ?? index
  ].join("|");
}

export function promotionQualityGate(summary, {
  initialBaseline = false,
  minGames = 8,
  maxIncompleteRate = 0.2,
  minInitialWinRate = 0.05
} = {}) {
  const total = Math.max(0, finiteNumber(summary?.total, 0));
  const rawIncomplete = Number(summary?.incomplete);
  const rawWins = Number(summary?.wins);
  const incompleteRate = clamp01(total > 0 && Number.isFinite(rawIncomplete)
    ? rawIncomplete / total
    : summary?.incompleteRate ?? 1);
  const winRate = clamp01(total > 0 && Number.isFinite(rawWins)
    ? rawWins / total
    : summary?.winRate ?? 0);
  const requiredGames = Math.max(0, finiteNumber(minGames, 8));
  const incompleteLimit = clamp01(maxIncompleteRate, 0.2);
  const initialWinFloor = clamp01(minInitialWinRate, 0.05);

  if (total < requiredGames) {
    return {
      ok: false,
      reason: `final evaluation had ${total}/${requiredGames} required games for promotion`,
      total,
      minGames: requiredGames,
      incompleteRate,
      maxIncompleteRate: incompleteLimit,
      winRate,
      minInitialWinRate: initialWinFloor,
      initialBaseline
    };
  }

  if (incompleteRate > incompleteLimit) {
    return {
      ok: false,
      reason: `final evaluation incomplete rate ${(incompleteRate * 100).toFixed(1)}% exceeded ${(incompleteLimit * 100).toFixed(1)}% promotion limit`,
      total,
      minGames: requiredGames,
      incompleteRate,
      maxIncompleteRate: incompleteLimit,
      winRate,
      minInitialWinRate: initialWinFloor,
      initialBaseline
    };
  }

  if (initialBaseline && winRate < initialWinFloor) {
    return {
      ok: false,
      reason: `initial baseline win rate ${(winRate * 100).toFixed(1)}% was below ${(initialWinFloor * 100).toFixed(1)}% promotion floor`,
      total,
      minGames: requiredGames,
      incompleteRate,
      maxIncompleteRate: incompleteLimit,
      winRate,
      minInitialWinRate: initialWinFloor,
      initialBaseline
    };
  }

  return {
    ok: true,
    reason: "final evaluation passed promotion quality gate",
    total,
    minGames: requiredGames,
    incompleteRate,
    maxIncompleteRate: incompleteLimit,
    winRate,
    minInitialWinRate: initialWinFloor,
    initialBaseline
  };
}

export function promotionEvidenceGate({
  candidateSummary,
  baselineSummary,
  comparison,
  margin = 0,
  requirePaired = true
} = {}) {
  const candidateScore = finiteNumber(candidateSummary?.score, 0);
  const baselineScore = finiteNumber(baselineSummary?.score, 0);
  const requiredMargin = finiteNumber(margin, 0);
  const candidateScoreVersion = Math.max(1, finiteNumber(candidateSummary?.scoreVersion, 1));
  const baselineScoreVersion = Math.max(1, finiteNumber(baselineSummary?.scoreVersion, 1));

  if (candidateScoreVersion !== baselineScoreVersion) {
    return {
      promote: false,
      reason: `candidate score v${candidateScoreVersion} cannot be compared with baseline score v${baselineScoreVersion}; re-evaluate both policies under the current scorer`,
      candidateScore,
      baselineScore,
      candidateScoreVersion,
      baselineScoreVersion,
      margin: requiredMargin,
      comparison: comparison ?? null
    };
  }

  if (!(candidateScore > baselineScore + requiredMargin)) {
    return {
      promote: false,
      reason: `candidate score ${candidateScore.toFixed(2)} did not beat baseline score ${baselineScore.toFixed(2)} by more than ${requiredMargin.toFixed(2)}`,
      candidateScore,
      baselineScore,
      margin: requiredMargin,
      comparison: comparison ?? null
    };
  }

  if (requirePaired && comparison?.verdict !== "positive") {
    const detail = comparison?.verdictReason
      ?? "the candidate and baseline did not have a paired common-random-number comparison";
    return {
      promote: false,
      reason: `candidate score improved, but paired promotion evidence was not positive: ${detail}`,
      candidateScore,
      baselineScore,
      margin: requiredMargin,
      comparison: comparison ?? null
    };
  }

  return {
    promote: true,
    reason: requirePaired
      ? `candidate score ${candidateScore.toFixed(2)} beat baseline score ${baselineScore.toFixed(2)} with positive paired evidence`
      : `candidate score ${candidateScore.toFixed(2)} beat baseline score ${baselineScore.toFixed(2)}`,
    candidateScore,
    baselineScore,
    margin: requiredMargin,
    comparison: comparison ?? null
  };
}

export function comparePairedMatchupEvaluations({
  beforeRows = [],
  afterRows = [],
  beforeSummary,
  afterSummary
} = {}) {
  if (!beforeSummary || !afterSummary) return null;

  const afterByKey = new Map(afterRows.map((row, index) => [gamePairKey(row, index), row]));
  const pairs = beforeRows
    .map((before, index) => ({ before, after: afterByKey.get(gamePairKey(before, index)) }))
    .filter((pair) => pair.after);
  let improvedGames = 0;
  let regressedGames = 0;
  let tiedOutcomeGames = 0;
  let lifeImprovedGames = 0;
  let lifeRegressedGames = 0;
  let pairedOutcomeDeltaTotal = 0;
  let pairedLifeDeltaTotal = 0;

  for (const pair of pairs) {
    const outcomeDelta = pilotOutcomeValue(pair.after) - pilotOutcomeValue(pair.before);
    const lifeDelta = pilotLifeDiff(pair.after) - pilotLifeDiff(pair.before);
    pairedOutcomeDeltaTotal += outcomeDelta;
    pairedLifeDeltaTotal += lifeDelta;
    if (outcomeDelta > 0) improvedGames += 1;
    else if (outcomeDelta < 0) regressedGames += 1;
    else tiedOutcomeGames += 1;
    if (lifeDelta > 0) lifeImprovedGames += 1;
    else if (lifeDelta < 0) lifeRegressedGames += 1;
  }

  const winRateDelta = Number(afterSummary.winRate ?? 0) - Number(beforeSummary.winRate ?? 0);
  const scoreDelta = Number(afterSummary.score ?? 0) - Number(beforeSummary.score ?? 0);
  const avgLifeDiffDelta = Number(afterSummary.avgLifeDiff ?? 0) - Number(beforeSummary.avgLifeDiff ?? 0);
  const avgTurnCyclesDelta = Number(afterSummary.avgTurnCycles ?? 0) - Number(beforeSummary.avgTurnCycles ?? 0);
  const incompleteRateDelta = Number(afterSummary.incompleteRate ?? 0) - Number(beforeSummary.incompleteRate ?? 0);
  const pairedNetWins = improvedGames - regressedGames;
  const pairedAverageLifeDelta = pairs.length === 0 ? 0 : pairedLifeDeltaTotal / pairs.length;
  const pairedLifeNet = lifeImprovedGames - lifeRegressedGames;
  const discordantOutcomeGames = improvedGames + regressedGames;
  const directionalOutcomeP = directionalBinomialTail(improvedGames, regressedGames);
  const hasPairedEvidence = pairs.length > 0;
  const hasEnoughPairedGames = pairs.length >= 12;
  const incompleteRegression = incompleteRateDelta > 0
    && Number(afterSummary.incomplete ?? 0) > Number(beforeSummary.incomplete ?? 0);
  const positiveOutcomeEvidence = pairedNetWins >= 3
    && winRateDelta >= 0.05
    && directionalOutcomeP <= 0.125;
  const positiveBoardEvidence = pairedNetWins >= 0
    && pairedLifeNet >= 4
    && scoreDelta >= 35
    && avgLifeDiffDelta >= 0.5;
  const negativeOutcomeEvidence = pairedNetWins <= -3
    && winRateDelta <= -0.05
    && directionalOutcomeP <= 0.125;
  const negativeBoardEvidence = pairedNetWins <= 0
    && pairedLifeNet <= -4
    && scoreDelta <= -35
    && avgLifeDiffDelta <= -0.5;
  const positive = hasEnoughPairedGames && !incompleteRegression && (
    positiveOutcomeEvidence || positiveBoardEvidence
  );
  const negative = hasPairedEvidence && (incompleteRegression || (hasEnoughPairedGames && (
    negativeOutcomeEvidence || negativeBoardEvidence
  )));
  const verdict = positive ? "positive" : negative ? "negative" : "inconclusive-small-sample";
  const verdictReason = positive
    ? `paired games improved ${improvedGames} and regressed ${regressedGames}; score changed ${formatSigned(scoreDelta)}`
    : negative
      ? incompleteRegression
        ? `incomplete rate increased by ${formatSigned(incompleteRateDelta * 100)} percentage points`
        : `paired games improved ${improvedGames} and regressed ${regressedGames}; score changed ${formatSigned(scoreDelta)}`
      : hasPairedEvidence
        ? `${hasEnoughPairedGames ? "paired evidence was mixed" : `only ${pairs.length}/12 minimum paired games were available`} (${improvedGames} improved, ${regressedGames} regressed; directional p ${formatProbability(directionalOutcomeP)})`
        : "before and after evaluations did not share matching game seeds";

  return {
    beforeId: "before",
    afterId: "after",
    comparisonMethod: "paired-common-random-numbers",
    pairedGames: pairs.length,
    improvedGames,
    regressedGames,
    tiedOutcomeGames,
    pairedNetWins,
    pairedLifeNet,
    discordantOutcomeGames,
    directionalOutcomeP,
    minimumPairedGames: 12,
    hasEnoughPairedGames,
    pairedOutcomeDelta: pairedOutcomeDeltaTotal,
    pairedAverageLifeDelta,
    lifeImprovedGames,
    lifeRegressedGames,
    winRateDelta,
    scoreDelta,
    avgLifeDiffDelta,
    avgTurnCyclesDelta,
    incompleteRateDelta,
    verdict,
    verdictReason,
    note: "Before and after policies use identical initial game seeds, opponent order, and first-player assignments."
  };
}

export function applyMatchupOverlayExposureGate(comparison, {
  before,
  after,
  overlayDelta,
  requiredCandidateDecisions = 4
} = {}) {
  if (!comparison) return null;
  const observedCandidateOverlayPaths = Object.keys(after?.observedCandidateOverlayPaths ?? {});
  const candidateOverlayDecisionCount = Number(after?.candidateOverlayDecisionCount ?? 0);
  const changedOverlayCount = Number(overlayDelta?.changedCount ?? 0);
  const minimumCandidateOverlayDecisions = Math.max(1, Number(requiredCandidateDecisions ?? 4));
  const exposureReady = changedOverlayCount > 0
    && observedCandidateOverlayPaths.length > 0
    && candidateOverlayDecisionCount >= minimumCandidateOverlayDecisions;
  const base = {
    ...comparison,
    comparedArtifact: "matchup-overlay-only",
    policyAndActionModelHeldConstant: true,
    changedOverlayCount,
    observedCandidateOverlayPaths,
    candidateOverlayDecisionCount,
    candidateOverlayDecisionRate: Number(after?.candidateOverlayDecisionRate ?? 0),
    minimumCandidateOverlayDecisions,
    beforeOverlayDecisionCount: Number(before?.pilotOverlayDecisionCount ?? 0),
    afterOverlayDecisionCount: Number(after?.pilotOverlayDecisionCount ?? 0),
    exposureReady,
    statisticalVerdict: comparison.verdict
  };
  if (exposureReady) return base;
  const reason = changedOverlayCount === 0
    ? "no changed matchup overlay artifact was available for validation"
    : observedCandidateOverlayPaths.length === 0
      ? "the changed matchup overlay was never selected during paired validation"
      : `the changed matchup overlay influenced only ${candidateOverlayDecisionCount}/${minimumCandidateOverlayDecisions} required pilot decisions`;
  return {
    ...base,
    verdict: "inconclusive-no-overlay-exposure",
    verdictReason: `${reason}; policy and action-model changes cannot be credited to the overlay`
  };
}

export function applyActionModelRuntimeChangeGate(comparison, { before, after } = {}) {
  if (!comparison) return null;
  const beforeSignature = String(before?.policyRuntimeSignature ?? "");
  const afterSignature = String(after?.policyRuntimeSignature ?? "");
  const behaviorChanged = Boolean(beforeSignature && afterSignature && beforeSignature !== afterSignature);
  if (behaviorChanged || !beforeSignature || !afterSignature) {
    return { ...comparison, behaviorChanged };
  }
  return {
    ...comparison,
    statisticalVerdict: comparison.verdict,
    verdict: "safe-no-runtime-change",
    verdictReason: "the action-model artifact accumulated evidence but produced the same runtime policy weights",
    behaviorChanged: false
  };
}

export function combineKnowledgeArtifactComparisons({
  totalComparison,
  actionComparison,
  overlayComparison
} = {}) {
  if (!totalComparison || !actionComparison || !overlayComparison) return null;
  const actionVerdict = String(actionComparison.verdict ?? "unknown");
  const overlayVerdict = String(overlayComparison.verdict ?? "unknown");
  const actionAccepted = ["positive", "safe-no-runtime-change"].includes(actionVerdict);
  const positive = actionAccepted && overlayVerdict === "positive";
  const negative = actionVerdict === "negative" || overlayVerdict === "negative";
  const verdict = positive ? "positive" : negative ? "negative" : "inconclusive-composite";
  const verdictReason = positive
    ? `action model and matchup overlay both passed isolated paired validation (${actionComparison.verdictReason}; ${overlayComparison.verdictReason})`
    : negative
      ? `at least one isolated artifact regressed (action: ${actionVerdict}; overlay: ${overlayVerdict})`
      : `both artifacts must pass independently (action: ${actionVerdict}; overlay: ${overlayVerdict})`;
  return {
    ...totalComparison,
    comparedArtifact: "action-model-and-matchup-overlay-sequential",
    policyHeldConstant: true,
    actionVerdict,
    overlayVerdict,
    actionComparison,
    overlayComparison,
    changedOverlayCount: Number(overlayComparison.changedOverlayCount ?? 0),
    observedCandidateOverlayPaths: overlayComparison.observedCandidateOverlayPaths ?? [],
    candidateOverlayDecisionCount: Number(overlayComparison.candidateOverlayDecisionCount ?? 0),
    candidateOverlayDecisionRate: Number(overlayComparison.candidateOverlayDecisionRate ?? 0),
    minimumCandidateOverlayDecisions: Number(overlayComparison.minimumCandidateOverlayDecisions ?? 0),
    exposureReady: overlayComparison.exposureReady === true,
    verdict,
    verdictReason
  };
}

function directionalBinomialTail(improved, regressed) {
  const trials = Number(improved ?? 0) + Number(regressed ?? 0);
  if (trials <= 0 || improved === regressed) return 1;
  const successes = Math.max(Number(improved ?? 0), Number(regressed ?? 0));
  let probability = 2 ** -trials;
  let tail = 0;
  for (let count = 0; count <= trials; count += 1) {
    if (count >= successes) tail += probability;
    if (count < trials) probability *= (trials - count) / (count + 1);
  }
  return Math.min(1, tail);
}

function clamp01(value, fallback = 0) {
  return Math.min(1, Math.max(0, finiteNumber(value, fallback)));
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nonnegativeCount(value) {
  return Math.max(0, Math.floor(finiteNumber(value, 0)));
}

function formatProbability(value) {
  return Number(value ?? 1).toFixed(3);
}

function formatSigned(value) {
  const number = Number(value ?? 0);
  return `${number >= 0 ? "+" : ""}${number.toFixed(2)}`;
}
