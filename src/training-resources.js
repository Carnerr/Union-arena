function positiveInteger(value, fallback) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function recommendedTrainingWorkerBudget(logicalProcessors) {
  const logical = positiveInteger(logicalProcessors, 1);
  return Math.max(1, Math.floor(logical / 2));
}

export function trainingResourcePlan({
  logicalProcessors,
  workerBudget,
  parallelRuns,
  parallelConcurrency,
  suiteConcurrency
} = {}) {
  const logical = positiveInteger(logicalProcessors, 1);
  const recommendedBudget = recommendedTrainingWorkerBudget(logical);
  const budget = Math.min(logical, positiveInteger(workerBudget, recommendedBudget));
  const runs = positiveInteger(parallelRuns, budget);
  const requestedConcurrency = positiveInteger(parallelConcurrency, Math.min(runs, budget));
  const concurrency = Math.min(runs, budget, requestedConcurrency);
  const maxSuiteConcurrency = Math.max(1, Math.floor(budget / concurrency));
  const requestedSuiteConcurrency = positiveInteger(suiteConcurrency, maxSuiteConcurrency);

  return {
    logicalProcessors: logical,
    workerBudget: budget,
    parallelRuns: runs,
    parallelConcurrency: concurrency,
    maxSuiteConcurrency,
    suiteConcurrency: Math.min(requestedSuiteConcurrency, maxSuiteConcurrency)
  };
}
