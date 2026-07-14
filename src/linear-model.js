export const MULTIVARIATE_RIDGE_VERSION = 3;
export const DEFAULT_LINEAR_MODEL_MAX_FEATURES = 512;
export const DEFAULT_CONTEXTUAL_FEATURE_PREFIX = "context.";
export const DEFAULT_CONTEXTUAL_MIN_OBSERVATIONS = 24;

const FEATURE_PAIR_SEPARATOR = "\u0000";

export function linearFeatureAccumulatorMap(artifact = null, valueScale = 1) {
  const rows = artifact?.trainingStats ?? artifact?.featureStats ?? {};
  return new Map(Object.entries(rows).map(([feature, stats]) => [feature, {
    dot: Number(stats?.dot ?? 0) * valueScale,
    norm: Number(stats?.norm ?? 0) * valueScale,
    count: Number(stats?.observations ?? stats?.count ?? 0) * valueScale
  }]));
}

export function linearFeatureCrossMap(artifact = null, valueScale = 1) {
  const result = new Map();
  for (const row of artifact?.featureCrossStats ?? []) {
    const left = String(row?.left ?? "");
    const right = String(row?.right ?? "");
    const value = Number(row?.value ?? 0) * valueScale;
    if (!left || !right || left === right || !Number.isFinite(value) || value === 0) continue;
    result.set(featurePairKey(left, right), value);
  }
  return result;
}

export function addLinearFeatureExample({
  accumulators,
  crossAccumulators,
  features = {},
  target,
  weight = 1
}) {
  const exampleWeight = Number(weight ?? 1);
  const numericTarget = Number(target ?? 0);
  if (!Number.isFinite(exampleWeight) || exampleWeight <= 0 || !Number.isFinite(numericTarget)) return false;
  const entries = Object.entries(features ?? {})
    .filter(([feature, rawValue]) => feature !== "baseScore" && Number.isFinite(Number(rawValue)) && Number(rawValue) !== 0)
    .map(([feature, rawValue]) => [feature, Number(rawValue)])
    .sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return false;

  for (const [feature, value] of entries) {
    const current = accumulators.get(feature) ?? { dot: 0, norm: 0, count: 0 };
    current.dot += value * numericTarget * exampleWeight;
    current.norm += value * value * exampleWeight;
    current.count += 1;
    accumulators.set(feature, current);
  }
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const [leftFeature, leftValue] = entries[leftIndex];
      const [rightFeature, rightValue] = entries[rightIndex];
      const key = featurePairKey(leftFeature, rightFeature);
      crossAccumulators.set(key, Number(crossAccumulators.get(key) ?? 0) + leftValue * rightValue * exampleWeight);
    }
  }
  return true;
}

export function fitMultivariateRidge({
  accumulators,
  crossAccumulators,
  scale = 120,
  l2 = 8,
  minObservations = 12,
  maxWeight = 260,
  maxFeatures = DEFAULT_LINEAR_MODEL_MAX_FEATURES,
  contextualFeaturePrefix = DEFAULT_CONTEXTUAL_FEATURE_PREFIX,
  minContextualObservations = DEFAULT_CONTEXTUAL_MIN_OBSERVATIONS
}) {
  const trainingStats = {};
  for (const [feature, stats] of [...accumulators.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    trainingStats[feature] = linearFeatureStat(stats);
  }
  const prefix = String(contextualFeaturePrefix ?? DEFAULT_CONTEXTUAL_FEATURE_PREFIX);
  const structuralMinimum = Number.isFinite(Number(minObservations))
    ? Math.max(0, Number(minObservations))
    : 0;
  const requestedContextualMinimum = Number.isFinite(Number(minContextualObservations))
    ? Math.max(0, Number(minContextualObservations))
    : DEFAULT_CONTEXTUAL_MIN_OBSERVATIONS;
  const contextualMinimum = Math.max(
    structuralMinimum,
    requestedContextualMinimum
  );
  const observedContextualEntries = [...accumulators.entries()]
    .filter(([feature, stats]) => String(feature).startsWith(prefix) && Number(stats.count ?? 0) > 0);
  const deferredContextualEntries = observedContextualEntries
    .filter(([, stats]) => Number(stats.count ?? 0) < contextualMinimum)
    .sort(compareContextualFeatureSupport);
  const eligibleEntries = [...accumulators.entries()]
    .filter(([feature, stats]) => {
      const observations = Number(stats.count ?? 0);
      const threshold = String(feature).startsWith(prefix) ? contextualMinimum : structuralMinimum;
      return observations >= threshold;
    })
    .sort(([left], [right]) => left.localeCompare(right));
  const { features, featureSelection } = selectLinearModelFeatures(eligibleEntries, {
    maxFeatures,
    contextualFeaturePrefix: prefix
  });
  Object.assign(featureSelection, {
    contextualMinObservations: contextualMinimum,
    contextualObserved: observedContextualEntries.length,
    contextualDeferredForSupport: deferredContextualEntries.length,
    deferredContextualFeatures: deferredContextualEntries.map(([feature, stats]) => ({
      feature,
      observations: Number(stats.count ?? 0)
    }))
  });
  if (features.length === 0) {
    return {
      weights: {},
      featureStats: {},
      trainingStats,
      featureCrossStats: serializeLinearFeatureCrossStats(crossAccumulators),
      featureSelection
    };
  }

  const indexes = new Map(features.map((feature, index) => [feature, index]));
  const matrix = Array.from({ length: features.length }, () => Array(features.length).fill(0));
  const target = Array(features.length).fill(0);
  const ridge = Math.max(1e-9, Number(l2 ?? 0));
  for (let index = 0; index < features.length; index += 1) {
    const stats = accumulators.get(features[index]);
    matrix[index][index] = Number(stats?.norm ?? 0) + ridge;
    target[index] = Number(stats?.dot ?? 0);
  }
  for (const [key, value] of crossAccumulators.entries()) {
    const [left, right] = featurePairFromKey(key);
    const leftIndex = indexes.get(left);
    const rightIndex = indexes.get(right);
    if (leftIndex === undefined || rightIndex === undefined) continue;
    matrix[leftIndex][rightIndex] = Number(value);
    matrix[rightIndex][leftIndex] = Number(value);
  }

  const coefficients = solveSymmetricPositiveDefinite(matrix, target);
  const weights = {};
  const featureStats = {};
  for (let index = 0; index < features.length; index += 1) {
    const feature = features[index];
    const stats = accumulators.get(feature);
    weights[feature] = Math.round(clamp(Number(scale) * Number(coefficients[index] ?? 0), -Number(maxWeight), Number(maxWeight)));
    featureStats[feature] = linearFeatureStat(stats);
  }
  return {
    weights,
    featureStats,
    trainingStats,
    featureCrossStats: serializeLinearFeatureCrossStats(crossAccumulators),
    featureSelection
  };
}

function selectLinearModelFeatures(entries, {
  maxFeatures,
  contextualFeaturePrefix
}) {
  const prefix = String(contextualFeaturePrefix ?? DEFAULT_CONTEXTUAL_FEATURE_PREFIX);
  const structural = entries
    .filter(([feature]) => !String(feature).startsWith(prefix))
    .sort(([left], [right]) => left.localeCompare(right));
  const contextual = entries
    .filter(([feature]) => String(feature).startsWith(prefix))
    .sort(compareContextualFeatureSupport);
  const finiteLimit = Number.isFinite(Number(maxFeatures))
    ? Math.max(1, Math.floor(Number(maxFeatures)))
    : null;
  const contextualSlots = finiteLimit === null
    ? contextual.length
    : Math.max(0, finiteLimit - structural.length);
  const selectedContextual = contextual.slice(0, contextualSlots);
  const droppedContextual = contextual.slice(contextualSlots);
  const features = [...structural, ...selectedContextual]
    .map(([feature]) => feature)
    .sort((left, right) => left.localeCompare(right));

  return {
    features,
    featureSelection: {
      version: 2,
      rule: "retain-structural-then-most-observed-contextual",
      contextualFeaturePrefix: prefix,
      maxFeatures: finiteLimit,
      eligible: entries.length,
      selected: features.length,
      dropped: droppedContextual.length,
      structuralEligible: structural.length,
      structuralSelected: structural.length,
      contextualEligible: contextual.length,
      contextualSelected: selectedContextual.length,
      contextualDropped: droppedContextual.length,
      selectedContextualFeatures: selectedContextual.map(([feature]) => feature),
      droppedContextualFeatures: droppedContextual.map(([feature]) => feature)
    }
  };
}

function compareContextualFeatureSupport(left, right) {
  const countDifference = Number(right[1]?.count ?? 0) - Number(left[1]?.count ?? 0);
  if (countDifference !== 0) return countDifference;
  const normDifference = Number(right[1]?.norm ?? 0) - Number(left[1]?.norm ?? 0);
  if (normDifference !== 0) return normDifference;
  return left[0].localeCompare(right[0]);
}

export function serializeLinearFeatureCrossStats(crossAccumulators) {
  return [...crossAccumulators.entries()]
    .map(([key, value]) => {
      const [left, right] = featurePairFromKey(key);
      return { left, right, value: Number(Number(value ?? 0).toFixed(6)) };
    })
    .filter((row) => row.value !== 0)
    .sort((a, b) => a.left.localeCompare(b.left) || a.right.localeCompare(b.right));
}

function linearFeatureStat(stats = {}) {
  return {
    observations: Number(stats.count ?? 0),
    dot: Number(Number(stats.dot ?? 0).toFixed(4)),
    norm: Number(Number(stats.norm ?? 0).toFixed(4))
  };
}

function featurePairKey(left, right) {
  return left.localeCompare(right) <= 0
    ? `${left}${FEATURE_PAIR_SEPARATOR}${right}`
    : `${right}${FEATURE_PAIR_SEPARATOR}${left}`;
}

function featurePairFromKey(key) {
  const index = key.indexOf(FEATURE_PAIR_SEPARATOR);
  return index === -1 ? [key, ""] : [key.slice(0, index), key.slice(index + FEATURE_PAIR_SEPARATOR.length)];
}

function solveSymmetricPositiveDefinite(matrix, target) {
  const size = target.length;
  const lower = Array.from({ length: size }, () => Array(size).fill(0));
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column <= row; column += 1) {
      let value = Number(matrix[row][column] ?? 0);
      for (let offset = 0; offset < column; offset += 1) {
        value -= lower[row][offset] * lower[column][offset];
      }
      if (row === column) lower[row][column] = Math.sqrt(Math.max(value, 1e-12));
      else lower[row][column] = value / Math.max(lower[column][column], 1e-12);
    }
  }
  const intermediate = Array(size).fill(0);
  for (let row = 0; row < size; row += 1) {
    let value = Number(target[row] ?? 0);
    for (let column = 0; column < row; column += 1) value -= lower[row][column] * intermediate[column];
    intermediate[row] = value / Math.max(lower[row][row], 1e-12);
  }
  const result = Array(size).fill(0);
  for (let row = size - 1; row >= 0; row -= 1) {
    let value = intermediate[row];
    for (let column = row + 1; column < size; column += 1) value -= lower[column][row] * result[column];
    result[row] = value / Math.max(lower[row][row], 1e-12);
  }
  return result;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
