const STATUS_SCHEMA = "union-arena-local-engine/dashboard-current-run@1";

export function buildDashboardCurrentRunStatus({
  controller = {},
  loopHealth = {},
  profiles = [],
  regionalArchetypes = [],
  sweepState = null
} = {}) {
  if (!runIsActive(controller, loopHealth)) return idleStatus();

  const config = controller.config ?? {};
  const current = loopHealth.currentCycle ?? {};
  const kind = config.kind ?? "loop";
  const sweepTask = activeSweepTask(sweepState);

  if (sweepTask) {
    return matchupStatus({
      controller,
      current,
      task: sweepTask,
      profiles,
      regionalArchetypes
    });
  }

  if (kind === "matchup-sweep" || current.taskType === "matchup-sweep") {
    const deck = profileForRun(profiles, {
      deckId: current.deckId ?? config.deck,
      ownKey: current.ownKey ?? config.ownKey
    });
    return baseStatus({
      active: true,
      phase: "matchup",
      badge: "MATCHUP",
      title: `${deck?.name ?? current.deckName ?? "Matchup training"} - preparing matchup`,
      startedAt: current.startedAt ?? controller.startedAt,
      deckId: deck?.id ?? current.deckId ?? config.deck ?? null,
      ownKey: deck?.ownKey ?? current.ownKey ?? config.ownKey ?? null
    });
  }

  if (config.trainingMode === "matchup" && config.opponentKey) {
    return matchupStatus({
      controller,
      current,
      task: {
        deckId: config.deck,
        ownKey: config.ownKey,
        opponentKey: config.opponentKey,
        opponentLabel: config.currentRunBaseline?.opponentLabel ?? null,
        currentWinRate: config.currentRunBaseline?.winRate ?? null,
        currentGames: config.currentRunBaseline?.completedGames ?? null,
        startedAt: phaseStartedAt(current, controller.startedAt)
      },
      profiles,
      regionalArchetypes
    });
  }

  return nonMatchupStatus({ controller, current, config, profiles });
}

export function activeSweepTask(sweepState = null) {
  if (!sweepState) return null;
  if (sweepState.currentTask) return sweepState.currentTask;
  if (sweepState.completedAt) return null;
  const selected = Array.isArray(sweepState.selectedTasks) ? sweepState.selectedTasks : [];
  const completed = Array.isArray(sweepState.results) ? sweepState.results.length : 0;
  const task = selected[completed] ?? null;
  if (!task) return null;
  return {
    ...task,
    index: completed + 1,
    startedAt: sweepState.startedAt ?? null
  };
}

function matchupStatus({ controller, current, task, profiles, regionalArchetypes }) {
  const deck = profileForRun(profiles, task);
  const deckName = deck?.name ?? task.deckName ?? "Selected deck";
  const opponentKey = task.opponentKey ?? null;
  const opponentName = opponentDisplayName(opponentKey, {
    profiles,
    regionalArchetypes,
    fallback: task.opponentLabel
  });
  const matchup = deck?.matchupStats?.find((row) => row.opponentKey === opponentKey) ?? null;
  const latestWinRate = numberOrNull(matchup?.winRate);
  const startingWinRate = numberOrNull(task.currentWinRate);
  const winRateDelta = latestWinRate !== null && startingWinRate !== null
    ? latestWinRate - startingWinRate
    : null;

  return baseStatus({
    active: true,
    phase: "matchup",
    badge: "MATCHUP",
    title: `${deckName} vs ${opponentName}`,
    startedAt: task.startedAt ?? current.startedAt ?? controller.startedAt,
    deckId: deck?.id ?? task.deckId ?? null,
    deckName,
    ownKey: deck?.ownKey ?? task.ownKey ?? null,
    opponentKey,
    opponentName,
    latestWinRate,
    startingWinRate,
    winRateDelta,
    deltaTone: deltaTone(winRateDelta),
    completedGames: completedGames(matchup),
    startingGames: numberOrNull(task.currentGames)
  });
}

function nonMatchupStatus({ controller, current, config, profiles }) {
  const routedDeck = profileForRun(profiles, {
    deckId: current.deckId ?? config.deck,
    ownKey: current.ownKey ?? config.ownKey
  });
  const suiteDeck = focusedSuiteDeck(profiles, current);
  const deck = suiteDeck ?? routedDeck;
  const phase = nonMatchupPhase({ current, config });
  const defaultTitle = deck?.name ?? current.deckName ?? config.deck ?? "Training session";
  const title = phase.phase === "profile-ml" && current.taskType === "action-model-suite"
    ? suiteDeck
      ? `Profile ML: ${suiteDeck.name}`
      : "All Deck Profiles"
    : phase.phase === "baseline" && current.taskType === "baseline-suite"
      ? suiteDeck
        ? `${String(current.deckName ?? "").toLowerCase().includes("refresh") ? "Baseline Refresh" : "Building Baseline"}: ${suiteDeck.name}`
        : "Building Needed Baselines"
      : defaultTitle;
  return baseStatus({
    active: true,
    ...phase,
    title,
    startedAt: phaseStartedAt(current, controller.startedAt),
    deckId: deck?.id ?? current.deckId ?? config.deck ?? null,
    deckName: deck?.name ?? current.deckName ?? null,
    ownKey: deck?.ownKey ?? current.ownKey ?? config.ownKey ?? null
  });
}

function focusedSuiteDeck(profiles, current = {}) {
  if (!new Set(["action-model-suite", "baseline-suite"]).has(current.taskType)) return null;
  const deckIds = uniqueStrings([
    ...(Array.isArray(current.deckIds) ? current.deckIds : []),
    ...commandListOption(current.command, "--decks")
  ]);
  if (deckIds.length === 1) {
    const byId = profiles.find((profile) => profile.id === deckIds[0]);
    if (byId) return byId;
  }
  const profileKeys = uniqueStrings(Array.isArray(current.profileKeys) ? current.profileKeys : []);
  if (profileKeys.length !== 1) return null;
  return profileForRun(profiles, { ownKey: profileKeys[0] });
}

function commandListOption(command, flag) {
  const text = String(command ?? "");
  if (!text) return [];
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = text.match(new RegExp(`(?:^|\\s)${escaped}\\s+([^\\s]+)`, "u"));
  return match ? match[1].split(",").map((value) => value.trim()).filter(Boolean) : [];
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function nonMatchupPhase({ current, config }) {
  const status = String(current.status ?? "").toLowerCase();
  const taskType = String(current.taskType ?? config.kind ?? "").toLowerCase();
  if (status === "matchup-validation") return { phase: "validation", badge: "VALIDATION" };
  if (status === "knowledge" || taskType === "action-model-suite") {
    return { phase: "profile-ml", badge: "PROFILE ML" };
  }
  if (status === "summarizing") return { phase: "summary", badge: "SUMMARY" };
  if (taskType === "baseline-suite") return { phase: "baseline", badge: "BASELINES" };
  if (taskType === "deck-experiment") return { phase: "deck-test", badge: "DECK TEST" };
  if (config.trainingMode === "deck") return { phase: "deck", badge: "DECK TRAINING" };
  return { phase: "training", badge: "TRAINING" };
}

function phaseStartedAt(current, fallback) {
  const status = String(current.status ?? "").toLowerCase();
  if (status === "matchup-validation") return current.validationStartedAt ?? current.startedAt ?? fallback;
  if (status === "knowledge" || status === "summarizing") {
    return current.trainingEndedAt ?? current.startedAt ?? fallback;
  }
  return current.startedAt ?? fallback ?? null;
}

function profileForRun(profiles, { deckId, ownKey } = {}) {
  return profiles.find((profile) => profile.id === deckId)
    ?? profiles.find((profile) => profile.ownKey === ownKey && String(profile.id ?? "").startsWith("carnerr-"))
    ?? profiles.find((profile) => profile.ownKey === ownKey)
    ?? null;
}

function opponentDisplayName(opponentKey, { profiles, regionalArchetypes, fallback } = {}) {
  const profile = profiles.find((row) => row.ownKey === opponentKey && String(row.id ?? "").startsWith("engine-"))
    ?? profiles.find((row) => row.ownKey === opponentKey);
  if (profile?.name) return profile.name;
  const archetype = regionalArchetypes.find((row) => row.key === opponentKey);
  return archetype?.label ?? fallback ?? opponentKey ?? "Unknown opponent";
}

function completedGames(matchup) {
  if (!matchup) return null;
  if (matchup.completedGames !== undefined && matchup.completedGames !== null) {
    return Math.max(0, Number(matchup.completedGames) || 0);
  }
  return Math.max(0, Number(matchup.wins ?? 0) + Number(matchup.losses ?? 0));
}

function deltaTone(delta) {
  if (delta === null || !Number.isFinite(delta)) return "unknown";
  if (delta > 0.0005) return "positive";
  if (delta < -0.0005) return "negative";
  return "neutral";
}

function runIsActive(controller, loopHealth) {
  if (!controller?.running) return false;
  if (loopHealth?.alive === false) return false;
  return !new Set(["failed", "lost", "stopped", "idle"]).has(String(loopHealth?.status ?? "").toLowerCase());
}

function idleStatus() {
  return baseStatus({
    active: false,
    phase: "idle",
    badge: "IDLE",
    title: "No active training run",
    startedAt: null
  });
}

function baseStatus(values) {
  return {
    schema: STATUS_SCHEMA,
    active: false,
    phase: "idle",
    badge: "IDLE",
    title: "No active training run",
    startedAt: null,
    deckId: null,
    deckName: null,
    ownKey: null,
    opponentKey: null,
    opponentName: null,
    latestWinRate: null,
    startingWinRate: null,
    winRateDelta: null,
    deltaTone: "unknown",
    completedGames: null,
    startingGames: null,
    ...values
  };
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
