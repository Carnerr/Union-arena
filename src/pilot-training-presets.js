const EXPLORATION_DEFAULTS = Object.freeze({
  deck: Object.freeze({
    explorationMode: "counterfactual-probe",
    explorationRate: 0.02,
    explorationMaxPerGame: 1,
    explorationScoreWindow: 220,
    explorationMaxRank: 8,
    explorationMinScore: -300,
    evidenceAwareExploration: true,
    explorationNoveltyStrength: 1.5,
    raidNormalPlayExplorationRate: 0.34,
    raidNormalPlayScoreWindow: 1200,
    raidNormalPlayHeuristicWindow: 1400,
    raidNormalPlayMinHeuristicScore: -200,
    counterfactualExplorationRate: 0.35,
    counterfactualMaxPerGame: 1,
    counterfactualRolloutActions: 64,
    counterfactualRolloutPlayerTurns: 3
  }),
  matchup: Object.freeze({
    explorationMode: "counterfactual-probe",
    explorationRate: 0.025,
    explorationMaxPerGame: 1,
    explorationScoreWindow: 240,
    explorationMaxRank: 8,
    explorationMinScore: -300,
    evidenceAwareExploration: true,
    explorationNoveltyStrength: 1.5,
    raidNormalPlayExplorationRate: 0.24,
    raidNormalPlayScoreWindow: 1000,
    raidNormalPlayHeuristicWindow: 1200,
    raidNormalPlayMinHeuristicScore: -200,
    counterfactualExplorationRate: 0.4,
    counterfactualMaxPerGame: 1,
    counterfactualRolloutActions: 64,
    counterfactualRolloutPlayerTurns: 3
  })
});

const AGENT_PRESET_DEFAULTS = Object.freeze({
  matchup: Object.freeze({
    games: 8,
    generations: 1,
    population: 4,
    finalGames: 20,
    parallelRuns: 14,
    parallelConcurrency: 14,
    parallelFinalGames: 0,
    parallelFinalTopPercent: 25,
    parallelFinalCandidates: "merged-baseline",
    parallelSkipSelection: "best-child",
    parallelOpponentsPerRun: true,
    parallelOpponentDiversity: "set-color",
    parallelOpponentCountPerRun: 1,
    parallelChildTimeoutMinutes: 90,
    parallelChildStaleMinutes: 20,
    skipParallelFinal: true,
    updateReusablePolicy: false,
    updateRoutedPolicy: false,
    routedPolicyUpdatesEnabled: false,
    pilotMulligan: true,
    recordTrainingGames: false,
    recordDecisions: true,
    decisionLogMode: "learning",
    decisionLogMaxCandidates: 2,
    mlStrength: 0.35,
    matchupOverlayStrength: 1,
    matchupMinConfidence: 0.6,
    matchupVariantMinDeckConfidence: 0.55,
    matchupVariantMinCoverage: 0.75,
    matchupUnknownMinEvidence: 4,
    ...EXPLORATION_DEFAULTS.matchup
  }),
  deck: Object.freeze({
    games: 12,
    generations: 3,
    population: 8,
    finalGames: 20,
    parallelRuns: 14,
    parallelConcurrency: 14,
    parallelFinalGames: 10,
    parallelFinalTopPercent: 35,
    parallelFinalCandidates: "best-merged-baseline",
    parallelSkipSelection: "best-child",
    parallelOpponentsPerRun: true,
    parallelOpponentDiversity: "set-color",
    parallelOpponentCountPerRun: 2,
    parallelChildTimeoutMinutes: 90,
    parallelChildStaleMinutes: 20,
    skipParallelFinal: false,
    updateReusablePolicy: true,
    updateRoutedPolicy: true,
    routedPolicyUpdatesEnabled: true,
    pilotMulligan: true,
    recordTrainingGames: false,
    recordDecisions: true,
    decisionLogMode: "learning",
    decisionLogMaxCandidates: 2,
    mlStrength: 0.2,
    matchupOverlayStrength: 1,
    matchupMinConfidence: 0.6,
    matchupVariantMinDeckConfidence: 0.55,
    matchupVariantMinCoverage: 0.75,
    matchupUnknownMinEvidence: 4,
    ...EXPLORATION_DEFAULTS.deck
  }),
  "baseline-suite": Object.freeze({
    games: 12,
    generations: 3,
    population: 6,
    finalGames: 20,
    parallelRuns: 14,
    parallelConcurrency: 14,
    parallelFinalGames: 0,
    parallelFinalTopPercent: 35,
    parallelFinalCandidates: "best-baseline",
    parallelSkipSelection: "best-child",
    parallelOpponentsPerRun: true,
    parallelOpponentDiversity: "set-color",
    parallelOpponentCountPerRun: 6,
    parallelChildTimeoutMinutes: 90,
    parallelChildStaleMinutes: 20,
    skipParallelFinal: true,
    updateReusablePolicy: false,
    updateRoutedPolicy: false,
    routedPolicyUpdatesEnabled: false,
    pilotMulligan: true,
    recordTrainingGames: false,
    recordDecisions: true,
    decisionLogMode: "learning",
    decisionLogMaxCandidates: 2,
    updateParallelChildRoutedPolicies: true,
    mlStrength: 0.2,
    matchupOverlayStrength: 1,
    matchupMinConfidence: 0.6,
    matchupVariantMinDeckConfidence: 0.55,
    matchupVariantMinCoverage: 0.75,
    matchupUnknownMinEvidence: 4,
    ...EXPLORATION_DEFAULTS.deck
  })
});

export function pilotExplorationDefaults(mode) {
  return { ...(EXPLORATION_DEFAULTS[mode] ?? EXPLORATION_DEFAULTS.matchup) };
}

export function pilotAgentPresetDefaults(preset) {
  return { ...(AGENT_PRESET_DEFAULTS[preset] ?? {}) };
}

export function pilotTrainingModeDefaults(mode) {
  const preset = pilotAgentPresetDefaults(mode === "deck" ? "deck" : "matchup");
  return {
    ...preset,
    trainingFocus: mode === "deck" ? "policy" : "hybrid",
    knowledgeMode: mode === "deck" ? "action" : "full",
    updateReusablePolicy: mode === "deck",
    updateRoutedPolicy: mode === "deck"
  };
}

export function pilotDashboardTrainingDefaults(mode) {
  const defaults = pilotTrainingModeDefaults(mode);
  if (mode !== "deck") return defaults;
  return {
    ...defaults,
    games: 20,
    parallelOpponentCountPerRun: 6
  };
}
