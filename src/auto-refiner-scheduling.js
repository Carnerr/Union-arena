export function shouldAdvanceAutoRefinerDeck({
  deckAdvanceMode = "complete",
  taskType = "",
  resultStatus = 0,
  selectedTasks = null,
  matchupLimit = 1
} = {}) {
  if (taskType === "baseline-suite" || taskType === "action-model-suite") return false;
  if (Number(resultStatus) !== 0) return true;
  if (deckAdvanceMode === "batch") return true;
  if (taskType === "baseline") return false;
  if (taskType !== "matchup-sweep") return true;

  const selected = Number(selectedTasks);
  if (!Number.isFinite(selected) || selected <= 0) return true;
  return selected < Math.max(1, Number(matchupLimit) || 1);
}
