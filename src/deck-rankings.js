const DEFAULT_Z_SCORE = 1.96;
const DEFAULT_MIN_COMPLETED_GAMES = 20;
const DEFAULT_MIN_MATCHUP_BUCKETS = 3;
const DEFAULT_MIN_MATCHUP_DISPLAY_GAMES = 20;
const DEFAULT_MAX_INCOMPLETE_RATE = 0.2;
const DEFAULT_COVERAGE_PENALTY = 0.1;
const DEFAULT_INCOMPLETE_PENALTY = 0.1;

export function wilsonLowerBound(wins, losses, { z = DEFAULT_Z_SCORE } = {}) {
  const safeWins = Math.max(0, Number(wins) || 0);
  const safeLosses = Math.max(0, Number(losses) || 0);
  const total = safeWins + safeLosses;
  if (total <= 0) return null;
  const probability = safeWins / total;
  const zSquared = z * z;
  const denominator = 1 + zSquared / total;
  const center = probability + zSquared / (2 * total);
  const margin = z * Math.sqrt((probability * (1 - probability) + zSquared / (4 * total)) / total);
  return clamp((center - margin) / denominator, 0, 1);
}

export function buildOverallDeckRankings(profiles = [], options = {}) {
  const minimumCompletedGames = Math.max(1, Number(options.minimumCompletedGames ?? DEFAULT_MIN_COMPLETED_GAMES));
  const minimumMatchupBuckets = Math.max(1, Number(options.minimumMatchupBuckets ?? DEFAULT_MIN_MATCHUP_BUCKETS));
  const minimumMatchupDisplayGames = Math.max(
    1,
    Number(options.minimumMatchupDisplayGames ?? DEFAULT_MIN_MATCHUP_DISPLAY_GAMES)
  );
  const maximumIncompleteRate = clamp(
    Number(options.maximumIncompleteRate ?? DEFAULT_MAX_INCOMPLETE_RATE),
    0,
    1
  );
  const coveragePenalty = Math.max(0, Number(options.coveragePenalty ?? DEFAULT_COVERAGE_PENALTY));
  const incompletePenalty = Math.max(0, Number(options.incompletePenalty ?? DEFAULT_INCOMPLETE_PENALTY));
  const baseRows = profiles.map((profile) => profileRankingBase(profile, { minimumMatchupDisplayGames }));
  const coverageTarget = Math.max(1, ...baseRows.map((row) => row.matchupBuckets));

  const rows = baseRows.map((row) => {
    const coverageRate = clamp(row.matchupBuckets / coverageTarget, 0, 1);
    const lowerBound = wilsonLowerBound(row.wins, row.losses, options);
    const rankable = row.completedGames >= minimumCompletedGames
      && row.matchupBuckets >= minimumMatchupBuckets
      && row.incompleteRate <= maximumIncompleteRate;
    const rankScore = rankable && lowerBound !== null
      ? clamp(
        lowerBound
          - (1 - coverageRate) * coveragePenalty
          - row.incompleteRate * incompletePenalty,
        0,
        1
      )
      : null;
    const evidence = rankingEvidence({
      ...row,
      coverageRate,
      rankable,
      minimumCompletedGames,
      minimumMatchupBuckets,
      maximumIncompleteRate
    });
    return {
      ...row,
      coverageTarget,
      coverageRate,
      confidenceLowerBound: lowerBound,
      rankScore,
      rankable,
      evidenceLabel: evidence.label,
      evidenceTone: evidence.tone,
      evidenceReason: evidence.reason
    };
  }).sort(compareRankingRows);

  let nextRank = 1;
  for (const row of rows) {
    row.rank = row.rankable ? nextRank++ : null;
  }

  return {
    schema: "union-arena-local-engine/deck-rankings@1",
    method: "95% Wilson lower win bound minus coverage and incomplete-game penalties",
    coverageTarget,
    minimumCompletedGames,
    minimumMatchupBuckets,
    minimumMatchupDisplayGames,
    maximumIncompleteRate,
    rankedDecks: rows.filter((row) => row.rankable).length,
    totalDecks: rows.length,
    completedGames: rows.reduce((total, row) => total + row.completedGames, 0),
    recordedGames: rows.reduce((total, row) => total + row.recordedGames, 0),
    rows
  };
}

function profileRankingBase(profile = {}, { minimumMatchupDisplayGames = DEFAULT_MIN_MATCHUP_DISPLAY_GAMES } = {}) {
  const matchupRows = Array.isArray(profile.matchupStats) ? profile.matchupStats : [];
  let wins = 0;
  let losses = 0;
  let incomplete = 0;
  let recordedGames = 0;
  let lifeDiffTotal = 0;
  let turnCyclesTotal = 0;

  for (const row of matchupRows) {
    const rowWins = Math.max(0, Number(row.wins) || 0);
    const rowLosses = Math.max(0, Number(row.losses) || 0);
    const rowIncomplete = Math.max(0, Number(row.incomplete) || 0);
    const completed = rowWins + rowLosses;
    const outcomes = completed + rowIncomplete;
    wins += rowWins;
    losses += rowLosses;
    incomplete += rowIncomplete;
    recordedGames += Math.max(outcomes, Math.max(0, Number(row.games) || 0));
    lifeDiffTotal += Number(row.avgLifeDiff || 0) * completed;
    turnCyclesTotal += Number(row.avgTurnCycles || 0) * completed;
  }

  const completedGames = wins + losses;
  const outcomeTotal = completedGames + incomplete;
  const normalizedRecordedGames = Math.max(recordedGames, outcomeTotal);
  const rankedMatchups = matchupRows
    .map(matchupRankingSummary)
    .filter((row) => row.completedGames > 0);
  const supportedMatchups = rankedMatchups.filter((row) => row.completedGames >= minimumMatchupDisplayGames);
  const headlineMatchups = supportedMatchups.length > 0 ? supportedMatchups : rankedMatchups;
  const strongestMatchup = [...headlineMatchups].sort((left, right) => (
    right.winRate - left.winRate
      || right.completedGames - left.completedGames
      || left.label.localeCompare(right.label)
  ))[0] ?? null;
  const weakestMatchup = [...headlineMatchups].sort((left, right) => (
    left.winRate - right.winRate
      || right.completedGames - left.completedGames
      || left.label.localeCompare(right.label)
  ))[0] ?? null;

  return {
    deckId: profile.id ?? "unknown",
    deckName: profile.name ?? profile.label ?? profile.id ?? "Unknown deck",
    ownKey: profile.ownKey ?? "unknown",
    deckType: String(profile.id ?? "").startsWith("carnerr-")
      ? "Carnerr"
      : String(profile.id ?? "").startsWith("engine-") ? "Engine" : "Other",
    baselineReady: Boolean(profile.baselinePolicy?.exists && !profile.baselinePolicy?.needsTraining),
    baselineStatus: !profile.baselinePolicy?.exists
      ? "Needed"
      : profile.baselinePolicy?.needsTraining ? "Seed" : "Ready",
    matchupBuckets: rankedMatchups.length,
    wins,
    losses,
    incomplete,
    completedGames,
    recordedGames: normalizedRecordedGames,
    winRate: completedGames > 0 ? wins / completedGames : null,
    completionRate: normalizedRecordedGames > 0 ? completedGames / normalizedRecordedGames : 0,
    incompleteRate: normalizedRecordedGames > 0 ? incomplete / normalizedRecordedGames : 0,
    avgLifeDiff: completedGames > 0 ? lifeDiffTotal / completedGames : null,
    avgTurnCycles: completedGames > 0 ? turnCyclesTotal / completedGames : null,
    strongestMatchup,
    weakestMatchup
  };
}

function matchupRankingSummary(row = {}) {
  const wins = Math.max(0, Number(row.wins) || 0);
  const losses = Math.max(0, Number(row.losses) || 0);
  const completedGames = wins + losses;
  return {
    key: row.opponentKey ?? "unknown",
    label: row.opponentLabel ?? row.opponentKey ?? "Unknown matchup",
    completedGames,
    wins,
    losses,
    winRate: completedGames > 0 ? wins / completedGames : 0,
    avgLifeDiff: completedGames > 0 ? Number(row.avgLifeDiff ?? 0) : null
  };
}

function rankingEvidence({
  completedGames,
  matchupBuckets,
  coverageRate,
  incompleteRate,
  rankable,
  minimumCompletedGames,
  minimumMatchupBuckets,
  maximumIncompleteRate
}) {
  if (incompleteRate > maximumIncompleteRate) {
    return {
      label: "Unreliable",
      tone: "bad",
      reason: `${(incompleteRate * 100).toFixed(1)}% incomplete games exceeds the ranking limit.`
    };
  }
  if (!rankable) {
    const reason = completedGames < minimumCompletedGames
      ? `${completedGames}/${minimumCompletedGames} completed games.`
      : `${matchupBuckets}/${minimumMatchupBuckets} matchup buckets.`;
    return { label: "Unranked", tone: "warn", reason };
  }
  if (completedGames >= 500 && coverageRate >= 0.8 && incompleteRate <= 0.02) {
    return { label: "Strong", tone: "good", reason: "Broad, high-volume completed-game sample." };
  }
  if (completedGames >= 200 && coverageRate >= 0.5 && incompleteRate <= 0.05) {
    return { label: "Usable", tone: "good", reason: "Usable completed-game sample with matchup breadth." };
  }
  if (completedGames >= 50) {
    return { label: "Developing", tone: "warn", reason: "Ranked provisionally while evidence grows." };
  }
  return { label: "Early", tone: "warn", reason: "Minimum ranking evidence only." };
}

function compareRankingRows(left, right) {
  if (left.rankable !== right.rankable) return left.rankable ? -1 : 1;
  if (left.rankable) {
    return Number(right.rankScore) - Number(left.rankScore)
      || Number(right.winRate) - Number(left.winRate)
      || Number(right.avgLifeDiff) - Number(left.avgLifeDiff)
      || right.completedGames - left.completedGames
      || left.deckName.localeCompare(right.deckName);
  }
  return right.completedGames - left.completedGames
    || right.matchupBuckets - left.matchupBuckets
    || left.deckName.localeCompare(right.deckName);
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}
