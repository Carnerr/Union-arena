#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  actionModelCandidatePathsForKey,
  actionModelPathForKey,
  analyzeSetupHand,
  applyActionModelRuntimeChangeGate,
  applyMatchupOverlayExposureGate,
  applyAction,
  baselinePolicyPathForKey,
  blendPilotPolicyWithMlModel,
  catalogGameResult,
  combineKnowledgeArtifactComparisons,
  comparePairedMatchupEvaluations,
  createSimulationGame,
  loadCatalogJson,
  loadDeckJson,
  loadMatchupOverlaysForProfile,
  makeRng,
  matchupOverlayArtifactSignature,
  normalizeDeckList,
  normalizePilotPolicy,
  PILOT_PERFORMANCE_SCORE_VERSION,
  pilotPerformanceScore,
  policyKeySegment,
  resolveArchetypeProfile,
  resolvePilotSetup,
  resolvePolicyForDeck,
  runAutoplayGame,
  writeJsonAtomicSync
} from "../src/index.js";
import { writeTextAtomicSync } from "../src/artifact-io.js";

const DEFAULT_AGENT_ROOT = "work/private/pilot-agent";
const DEFAULT_LIBRARY = "work/private/decks";
const DEFAULT_CATALOG = "work/private/egman-unionarena-catalog.json";
const DEFAULT_POLICY_DIR = "work/private/pilot-agent/policies";
const DEFAULT_BASELINE_ROOT = "work/private/pilot-agent/baselines";
const DEFAULT_FALLBACK_POLICY = "work/private/pilot-agent/current-best-policy.json";

if (hasFlag("--help")) {
  usage();
  process.exit(0);
}

const config = readConfig();
mkdirSync(config.outDir, { recursive: true });

const catalog = loadCatalogJson(config.catalogPath);
const pilotDeck = loadSavedDeck(config.libraryDir, config.deckId);
const pilotProfile = profileForDeck(pilotDeck, config.ownKey);
const opponents = selectOpponents(config);
const opponentFingerprints = opponents.map((deck) => matchupDeckFingerprintForSavedDeck(deck, catalog, config)).filter(Boolean);
const pilotFingerprint = matchupDeckFingerprintForSavedDeck(pilotDeck, catalog, config);
const overlayDelta = matchupOverlayDeltaForProfile(pilotProfile);
const candidateOverlayPaths = new Set(overlayDelta.changed.map((row) => normalizedPath(row.afterPath)));

const variants = validationVariants(config.validationTarget);
if (config.includeNoOverlay) {
  variants.unshift({
    id: "baseline-only",
    label: "Current baseline without matchup overlay",
    policyBaselineRoot: config.baselineRoot,
    actionModelBaselineRoot: config.baselineRoot,
    policyDir: config.policyDir,
    overlayBaselineRoot: config.baselineRoot,
    overlayPolicyDir: config.policyDir,
    overlayEnabled: false
  });
}

const evaluations = variants.map((variant) => evaluateVariant(variant, {
  seed: config.seed,
  candidateOverlayPaths
}));
const before = evaluations.find((row) => row.id === "before");
const actionOnly = evaluations.find((row) => row.id === "action-only");
const after = evaluations.find((row) => row.id === "after");
const totalComparison = compareEvaluations(before, after);
const actionComparison = config.validationTarget === "full"
  ? applyActionModelRuntimeChangeGate(compareEvaluations(before, actionOnly), { before, after: actionOnly })
  : config.validationTarget === "action"
    ? applyActionModelRuntimeChangeGate(totalComparison, { before, after })
    : null;
const rawOverlayComparison = config.validationTarget === "full"
  ? compareEvaluations(actionOnly, after)
  : config.validationTarget === "overlay" ? totalComparison : null;
const overlayComparison = rawOverlayComparison
  ? applyMatchupOverlayExposureGate(rawOverlayComparison, {
      before: config.validationTarget === "full" ? actionOnly : before,
      after,
      overlayDelta,
      requiredCandidateDecisions: Math.max(4, Math.ceil(config.games / 2))
    })
  : null;
const comparison = config.validationTarget === "full"
  ? combineKnowledgeArtifactComparisons({ totalComparison, actionComparison, overlayComparison })
  : config.validationTarget === "overlay"
    ? overlayComparison
    : actionComparison && {
        ...actionComparison,
        comparedArtifact: "action-model-only",
        policyAndMatchupOverlayHeldConstant: true
      };
const comparisons = {
  total: totalComparison,
  action: actionComparison,
  overlay: overlayComparison
};
/*
 * Each comparison uses identical seeds and starts. Full mode changes one learned
 * layer at a time so a score improvement has an attributable owner.
 */
function compareEvaluations(left, right) {
  return comparePairedMatchupEvaluations({
    beforeRows: left?.games,
    afterRows: right?.games,
    beforeSummary: left?.summary,
    afterSummary: right?.summary
  });
}
const manifest = {
  schema: "union-arena-local-engine/matchup-impact-validation@1",
  createdAt: new Date().toISOString(),
  validationTarget: config.validationTarget,
  config: publicConfig(config),
  deck: {
    id: pilotDeck.id,
    name: pilotDeck.name,
    ownKey: pilotProfile.key
  },
  opponents: opponents.map((deck) => ({
    id: deck.id,
    name: deck.name,
    ownKey: profileForDeck(deck).key
  })),
  overlayDelta,
  evaluations,
  comparisons,
  comparison
};

writeJsonAtomicSync(join(config.outDir, "matchup-validation.json"), manifest);
writeTextAtomicSync(join(config.outDir, "matchup-validation.md"), validationMarkdown(manifest));

console.log(`Matchup validation written to ${config.outDir}`);
if (comparison) {
  console.log(`Win-rate delta: ${formatSignedPercent(comparison.winRateDelta)}; life delta: ${signed(comparison.avgLifeDiffDelta)}; verdict: ${comparison.verdict}`);
}

function validationVariants(target) {
  const currentPolicy = {
    policyBaselineRoot: config.baselineRoot,
    policyDir: config.policyDir,
    overlayEnabled: true
  };
  const previousOverlay = {
    overlayBaselineRoot: config.beforeBaselineRoot,
    overlayPolicyDir: config.beforePolicyDir,
    allowUnvalidatedOverlays: false
  };
  const candidateOverlay = {
    overlayBaselineRoot: config.baselineRoot,
    overlayPolicyDir: config.policyDir,
    allowUnvalidatedOverlays: true
  };
  if (target === "action") {
    return [
      { ...currentPolicy, ...previousOverlay, id: "before", label: "Previous action model", actionModelBaselineRoot: config.beforeBaselineRoot },
      { ...currentPolicy, ...previousOverlay, id: "after", label: "Candidate action model", actionModelBaselineRoot: config.baselineRoot }
    ];
  }
  if (target === "full") {
    return [
      { ...currentPolicy, ...previousOverlay, id: "before", label: "Previous action model and overlay", actionModelBaselineRoot: config.beforeBaselineRoot },
      { ...currentPolicy, ...previousOverlay, id: "action-only", label: "Candidate action model with previous overlay", actionModelBaselineRoot: config.baselineRoot },
      { ...currentPolicy, ...candidateOverlay, id: "after", label: "Candidate action model and overlay", actionModelBaselineRoot: config.baselineRoot }
    ];
  }
  return [
    { ...currentPolicy, ...previousOverlay, id: "before", label: "Previous matchup overlay", actionModelBaselineRoot: config.baselineRoot },
    { ...currentPolicy, ...candidateOverlay, id: "after", label: "Candidate matchup overlay", actionModelBaselineRoot: config.baselineRoot }
  ];
}

function evaluateVariant(variant, { seed, candidateOverlayPaths }) {
  const policyArtifacts = loadPilotArtifacts(variant);
  const rows = [];
  let pilotDecisionCount = 0;
  let pilotOverlayDecisionCount = 0;
  let candidateOverlayDecisionCount = 0;
  const observedCandidateOverlayPaths = new Map();

  for (let index = 0; index < config.games; index += 1) {
    const opponent = opponents[index % opponents.length];
    const opponentArtifacts = loadOpponentArtifacts(opponent);
    const gameSeed = seed + index;
    const firstPlayer = index % 2 === 0 ? "P1" : "P2";
    const simulation = createSimulationGame({
      catalog,
      decks: { P1: pilotDeck.cards, P2: opponent.cards },
      seed: gameSeed,
      firstPlayer,
      validateDecks: config.validateDecks,
      setupMode: config.mulliganMode === "auto" ? "auto" : "manual"
    });
    const setupState = resolveSetup(simulation.state, {
      policy: policyArtifacts.policy,
      opponentPolicy: opponentArtifacts.policy
    });
    const decisions = [];
    const playout = runAutoplayGame(setupState, {
      maxTurns: config.maxTurns,
      maxActions: config.maxActions,
      policy: {
        P1: policyArtifacts.policy,
        P2: opponentArtifacts.policy
      },
      matchupOverlays: {
        P1: policyArtifacts.matchupConfig,
        P2: opponentArtifacts.matchupConfig
      },
      matchupDeckFingerprints: {
        P1: opponentFingerprints,
        P2: pilotFingerprint ? [pilotFingerprint] : []
      },
      decisionRecorder: (decision) => decisions.push(decision)
    });
    const result = catalogGameResult(playout.state, {
      index: index + 1,
      seed: gameSeed
    });
    const pilotDecisions = decisions.filter((decision) => decision.player === "P1");
    const candidateOverlayDecisions = pilotDecisions.filter((decision) => (
      candidateOverlayPaths.has(normalizedPath(decision.matchupOverlayPath))
    ));
    pilotDecisionCount += pilotDecisions.length;
    pilotOverlayDecisionCount += pilotDecisions.filter((decision) => decision.matchupOverlayPath).length;
    candidateOverlayDecisionCount += candidateOverlayDecisions.length;
    for (const decision of candidateOverlayDecisions) {
      const path = normalizedPath(decision.matchupOverlayPath);
      observedCandidateOverlayPaths.set(path, Number(observedCandidateOverlayPaths.get(path) ?? 0) + 1);
    }
    rows.push({
      ...result,
      variant: variant.id,
      opponent: opponent.id,
      opponentName: opponent.name,
      firstPlayer,
      playoutSteps: playout.steps,
      playoutStoppedReason: playout.stoppedReason,
      playoutFailureCode: playout.failureDiagnostics?.candidateFailures?.[0]?.code ?? "",
      playoutFailureMessage: playout.failureDiagnostics?.candidateFailures?.[0]?.message ?? "",
      playoutFailureDiagnostics: playout.failureDiagnostics
        ? JSON.stringify(playout.failureDiagnostics)
        : "",
      pilotDecisions: pilotDecisions.length,
      pilotOverlayDecisions: pilotDecisions.filter((decision) => decision.matchupOverlayPath).length,
      candidateOverlayDecisions: candidateOverlayDecisions.length
    });
  }

  const summary = summarizeRows(rows);
  return {
    id: variant.id,
    label: variant.label,
    seed,
    policyPath: policyArtifacts.policyPath,
    policyRuntimeSignature: pilotPolicyRuntimeSignature(policyArtifacts.policy),
    actionModelPath: policyArtifacts.actionModelPath,
    matchupOverlayPaths: policyArtifacts.matchupOverlayPaths,
    overlayEnabled: variant.overlayEnabled,
    pilotDecisionCount,
    pilotOverlayDecisionCount,
    pilotOverlayDecisionRate: pilotDecisionCount === 0 ? 0 : pilotOverlayDecisionCount / pilotDecisionCount,
    candidateOverlayDecisionCount,
    candidateOverlayDecisionRate: pilotDecisionCount === 0 ? 0 : candidateOverlayDecisionCount / pilotDecisionCount,
    observedCandidateOverlayPaths: Object.fromEntries([...observedCandidateOverlayPaths.entries()].sort(([left], [right]) => left.localeCompare(right))),
    summary,
    games: rows
  };
}

function loadPilotArtifacts(variant) {
  const profile = { ...pilotProfile, key: policyKeySegment(config.ownKey), policyFileName: `${policyKeySegment(config.ownKey)}.json` };
  const policyPath = baselinePolicyPathForKey(config.ownKey, {
    policyDir: variant.policyDir,
    baselineRoot: variant.policyBaselineRoot
  });
  const fallbackPolicyPath = baselinePolicyPathForKey(config.ownKey, {
    policyDir: config.policyDir,
    baselineRoot: config.baselineRoot
  });
  const rawPolicy = readJsonIfExists(policyPath) ?? readJsonIfExists(fallbackPolicyPath) ?? {};
  const actionModelPath = actionModelPathForKey(config.ownKey, {
    agentRoot: config.agentRoot,
    baselineRoot: variant.actionModelBaselineRoot
  });
  const model = readJsonIfExists(actionModelPath);
  const policy = applyOptionalMlModel(normalizePilotPolicy(rawPolicy), model, {
    strength: config.mlStrength,
    name: `${variant.id}-validated-policy`
  });
  const matchupConfig = variant.overlayEnabled
    ? matchupConfigForProfile(profile, {
      policyDir: variant.overlayPolicyDir,
      baselineRoot: variant.overlayBaselineRoot,
      allowUnvalidated: variant.allowUnvalidatedOverlays === true
    })
    : null;
  return {
    policy,
    policyPath: existsSync(policyPath) ? policyPath : fallbackPolicyPath,
    actionModelPath: existsSync(actionModelPath) ? actionModelPath : null,
    matchupConfig,
    matchupOverlayPaths: Object.values(matchupConfig?.overlays ?? {}).map((entry) => entry.path)
  };
}

function loadOpponentArtifacts(opponent) {
  const routed = resolvePolicyForDeck({
    deck: opponent.cards,
    catalog,
    savedDeck: opponent.raw,
    deckId: opponent.id,
    policyDir: config.policyDir,
    baselineRoot: config.baselineRoot,
    fallbackPolicyPath: DEFAULT_FALLBACK_POLICY,
    deckLibrary: config.libraryDir
  });
  const modelSelection = loadActionModelForKey(routed.profile?.key);
  const policy = applyOptionalMlModel(routed.policy, modelSelection.model, {
    strength: config.opponentMlStrength,
    name: `${opponent.id}-opponent-policy`
  });
  return {
    policy,
    policyPath: routed.path,
    actionModelPath: modelSelection.path,
    matchupConfig: matchupConfigForProfile(routed.profile, {
      policyDir: config.policyDir,
      baselineRoot: config.baselineRoot
    })
  };
}

function matchupConfigForProfile(profile, { policyDir, baselineRoot, allowUnvalidated = false }) {
  if (!profile) return null;
  const overlays = loadMatchupOverlaysForProfile(profile, { policyDir, baselineRoot });
  const paths = Object.values(overlays).map((entry) => entry.path);
  return {
    enabled: paths.length > 0,
    strength: config.matchupOverlayStrength,
    minConfidence: config.matchupMinConfidence,
    knownDeckVariants: config.matchupKnownDeckVariants,
    variantMinDeckConfidence: config.matchupVariantMinDeckConfidence,
    variantMinObservedCoverage: config.matchupVariantMinCoverage,
    unknownVariantMinEvidence: config.matchupUnknownMinEvidence,
    allowUnvalidated,
    overlays
  };
}

function matchupOverlayDeltaForProfile(profile) {
  const before = loadMatchupOverlaysForProfile(profile, {
    policyDir: config.beforePolicyDir,
    baselineRoot: config.beforeBaselineRoot
  });
  const after = loadMatchupOverlaysForProfile(profile, {
    policyDir: config.policyDir,
    baselineRoot: config.baselineRoot
  });
  const changed = [];
  const removed = [];
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort((left, right) => left.localeCompare(right))) {
    const beforeEntry = before[key] ?? null;
    const afterEntry = after[key] ?? null;
    if (!afterEntry) {
      removed.push({ opponentKey: key, beforePath: beforeEntry?.path ?? null });
      continue;
    }
    const beforeSignature = beforeEntry ? matchupOverlayArtifactSignature(beforeEntry.overlay) : null;
    const afterSignature = matchupOverlayArtifactSignature(afterEntry.overlay);
    if (beforeSignature === afterSignature) continue;
    changed.push({
      opponentKey: key,
      status: beforeEntry ? "updated" : "created",
      beforePath: beforeEntry?.path ?? null,
      afterPath: afterEntry.path,
      beforeSignature,
      afterSignature
    });
  }
  return {
    changed,
    removed,
    changedCount: changed.length,
    removedCount: removed.length
  };
}

function normalizedPath(path) {
  return String(path ?? "").replace(/\\/gu, "/").toLowerCase();
}

function pilotPolicyRuntimeSignature(policy) {
  const stable = JSON.stringify(Object.fromEntries(Object.entries(policy?.weights ?? {})
    .sort(([left], [right]) => left.localeCompare(right))));
  let hash = 2166136261;
  for (let index = 0; index < stable.length; index += 1) {
    hash ^= stable.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function resolveSetup(state, { policy, opponentPolicy }) {
  if (config.mulliganMode === "pilot") {
    return resolvePilotSetup(state, { P1: policy, P2: opponentPolicy });
  }
  if (config.mulliganMode === "bricks") {
    let nextState = state;
    for (const playerId of ["P1", "P2"]) {
      const actionType = analyzeSetupHand(nextState, playerId).initialBricked ? "mulligan" : "keepHand";
      nextState = applyAction(nextState, { type: actionType, player: playerId });
    }
    return nextState;
  }
  return state;
}

function selectOpponents({ libraryDir, opponentsText, opponentCount, seed }) {
  const ids = opponentsText.split(/[,\r\n]+/u).map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) throw new Error("Matchup validation needs --opponents deck-a,deck-b.");
  const selected = sampleIds(ids, {
    count: opponentCount,
    seed: seed + 8719
  });
  return selected.map((id) => loadSavedDeck(libraryDir, id));
}

function sampleIds(ids, { count, seed }) {
  const clean = [...new Set(ids)];
  const requested = Math.max(0, Number(count ?? 0));
  if (!requested || requested >= clean.length) return clean;
  const rng = makeRng(seed);
  const shuffled = [...clean];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled.slice(0, requested);
}

function loadSavedDeck(libraryDir, deckId) {
  const path = join(libraryDir, `${deckId}.json`);
  if (!existsSync(path)) throw new Error(`Saved deck not found: ${path}`);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return {
    id: raw.id ?? deckId,
    name: raw.name ?? deckId,
    path,
    raw,
    cards: loadDeckJson(path)
  };
}

function profileForDeck(deck, fallbackKey = null) {
  const resolution = resolveArchetypeProfile({
    deck: deck.cards,
    catalog,
    savedDeck: deck.raw,
    deckId: deck.id,
    deckLibrary: config.libraryDir
  });
  if (!fallbackKey) return resolution.profile;
  return {
    ...resolution.profile,
    key: policyKeySegment(fallbackKey),
    policyFileName: `${policyKeySegment(fallbackKey)}.json`
  };
}

function matchupDeckFingerprintForSavedDeck(deck, catalog, config = {}) {
  const profile = profileForDeck(deck);
  const cardCounts = Object.fromEntries(normalizeDeckList(deck.cards)
    .map((entry) => [entry.id, Number(entry.count ?? 1)])
    .filter(([id, count]) => id && count > 0));
  const totalCards = Object.values(cardCounts).reduce((total, count) => total + count, 0);
  if (totalCards === 0) return null;
  return {
    id: deck.id,
    name: deck.name ?? deck.id,
    key: profile.key,
    setColorKey: profile.setColorKey,
    sourceCode: profile.sourceCode,
    colors: profile.colors,
    colorKey: profile.colorKey,
    archetypeResolution: profile.archetypeResolution,
    cardCounts,
    totalCards
  };
}

function loadActionModelForKey(key) {
  for (const path of actionModelCandidatePathsForKey(key, {
    agentRoot: config.agentRoot,
    baselineRoot: config.baselineRoot
  })) {
    const model = readJsonIfExists(path);
    if (model) return { path, model };
  }
  return { path: null, model: null };
}

function applyOptionalMlModel(policy, model, options = {}) {
  if (!model) return normalizePilotPolicy(policy);
  return blendPilotPolicyWithMlModel(policy, model, options);
}

function summarizeRows(rows) {
  const total = rows.length;
  const wins = rows.filter((row) => row.winner === "P1").length;
  const losses = rows.filter((row) => row.winner === "P2").length;
  const incomplete = total - wins - losses;
  const winRate = total === 0 ? 0 : wins / total;
  const incompleteRate = total === 0 ? 0 : incomplete / total;
  const avgLifeDiff = average(rows, (row) => Number(row.p1LifeRemaining ?? 0) - Number(row.p2LifeRemaining ?? 0));
  const avgTurns = average(rows, (row) => Number(row.turnsTaken ?? 0));
  const avgTurnCycles = average(rows, (row) => Number(row.turnCyclesTaken ?? Math.ceil(Number(row.turnsTaken ?? 0) / 2)));
  const winningRows = rows.filter((row) => row.winner === "P1");
  const avgWinTurnCycles = average(winningRows, (row) => Number(row.turnCyclesTaken ?? Math.ceil(Number(row.turnsTaken ?? 0) / 2)));
  const longGameRate = average(rows, (row) => Number(row.turnCyclesTaken ?? Math.ceil(Number(row.turnsTaken ?? 0) / 2)) > 8 ? 1 : 0);
  const score = pilotPerformanceScore({ total, wins, incomplete, avgLifeDiff });
  return {
    total,
    wins,
    losses,
    incomplete,
    winRate,
    incompleteRate,
    avgLifeDiff,
    avgTurns,
    avgTurnCycles,
    avgWinTurnCycles,
    longGameRate,
    scoreVersion: PILOT_PERFORMANCE_SCORE_VERSION,
    score
  };
}

function validationMarkdown(manifest) {
  const lines = [
    "# Matchup Impact Validation",
    "",
    `Deck: ${manifest.deck.name} (${manifest.deck.ownKey})`,
    `Games per variant: ${config.games}`,
    `Opponents: ${manifest.opponents.map((opponent) => opponent.name).join(", ")}`,
    "",
    "## Results",
    "",
    ...manifest.evaluations.map((row) => {
      const summary = row.summary;
      return `- ${row.label}: ${summary.wins}/${summary.losses}/${summary.incomplete}, ${formatPercent(summary.winRate)}, life ${summary.avgLifeDiff.toFixed(2)}, cycles ${summary.avgTurnCycles.toFixed(2)}, overlay decisions ${formatPercent(row.pilotOverlayDecisionRate)}`;
    }),
    "",
    "## Impact",
    "",
    manifest.comparison
      ? `- Win-rate delta: ${formatSignedPercent(manifest.comparison.winRateDelta)}`
      : "- Win-rate delta: unavailable",
    manifest.comparison
      ? `- Average life delta: ${signed(manifest.comparison.avgLifeDiffDelta)}`
      : "- Average life delta: unavailable",
    manifest.comparison
      ? `- Score delta: ${signed(manifest.comparison.scoreDelta)}`
      : "- Score delta: unavailable",
    manifest.comparison
      ? `- Verdict: ${manifest.comparison.verdict}`
      : "- Verdict: unavailable",
    manifest.comparison
      ? `- Paired outcomes: ${manifest.comparison.improvedGames} improved / ${manifest.comparison.regressedGames} regressed / ${manifest.comparison.tiedOutcomeGames} tied`
      : "- Paired outcomes: unavailable",
    manifest.comparison
      ? `- Directional outcome evidence: p=${Number(manifest.comparison.directionalOutcomeP ?? 1).toFixed(3)}; paired games ${manifest.comparison.pairedGames}/${manifest.comparison.minimumPairedGames} minimum`
      : "- Directional outcome evidence: unavailable",
    manifest.comparison && manifest.comparison.comparedArtifact !== "action-model-only"
      ? `- Candidate overlay exposure: ${manifest.comparison.candidateOverlayDecisionCount}/${manifest.comparison.minimumCandidateOverlayDecisions} required decisions across ${manifest.comparison.observedCandidateOverlayPaths?.length ?? 0} changed overlay file(s)`
      : "- Candidate overlay exposure: not applicable",
    manifest.comparison
      ? `- Isolation: ${comparisonIsolationLabel(manifest.comparison)}`
      : "- Isolation: unavailable",
    manifest.comparison
      ? `- Reason: ${manifest.comparison.verdictReason}`
      : "",
    "",
    "## Files",
    "",
    ...manifest.evaluations.map((row) => `- ${row.id}: policy ${row.policyPath ?? "missing"}, action model ${row.actionModelPath ?? "none"}, overlays ${row.matchupOverlayPaths.length}`),
    ""
  ];
  return `${lines.join("\n")}\n`;
}

function readConfig() {
  const agentRoot = option("--agent-root") ?? DEFAULT_AGENT_ROOT;
  const baselineRoot = option("--baseline-root") ?? DEFAULT_BASELINE_ROOT;
  const beforeBaselineRoot = option("--before-baseline-root") ?? option("--old-baseline-root");
  if (!beforeBaselineRoot) throw new Error("Missing --before-baseline-root for matchup impact validation.");
  return {
    validationTarget: validationTarget(),
    deckId: option("--deck") ?? "carnerr-spear",
    ownKey: option("--own-key") ?? "eva-purple-spear-eva-13",
    opponentsText: option("--opponents") ?? "",
    opponentCount: Number(option("--opponent-count") ?? 1),
    games: Math.max(1, Number(option("--games") ?? option("--matchup-validation-games") ?? 20)),
    seed: Number(option("--seed") ?? 73001),
    commonRandomNumbers: true,
    catalogPath: option("--catalog") ?? DEFAULT_CATALOG,
    libraryDir: option("--library") ?? DEFAULT_LIBRARY,
    agentRoot,
    policyDir: option("--policy-dir") ?? DEFAULT_POLICY_DIR,
    baselineRoot,
    beforeBaselineRoot,
    beforePolicyDir: option("--before-policy-dir") ?? join(dirname(beforeBaselineRoot), "policies"),
    outDir: option("--out-dir") ?? join(agentRoot, "matchup-validations", `validation-${Date.now()}`),
    validateDecks: !hasFlag("--no-validate"),
    mulliganMode: mulliganMode(),
    maxTurns: Number(option("--max-turns") ?? 80),
    maxActions: Number(option("--max-actions") ?? 1000),
    mlStrength: Number(option("--ml-strength") ?? option("--action-model-strength") ?? 0.35),
    opponentMlStrength: Number(option("--opponent-ml-strength") ?? option("--opponent-action-model-strength") ?? option("--ml-strength") ?? 0.35),
    matchupOverlayStrength: Number(option("--matchup-overlay-strength") ?? option("--matchup-strength") ?? 1),
    matchupMinConfidence: Number(option("--matchup-min-confidence") ?? option("--matchup-confidence") ?? 0.6),
    matchupKnownDeckVariants: hasFlag("--matchup-known-deck-variants"),
    matchupVariantMinDeckConfidence: Number(option("--matchup-variant-min-deck-confidence") ?? 0.55),
    matchupVariantMinCoverage: Number(option("--matchup-variant-min-coverage") ?? 0.75),
    matchupUnknownMinEvidence: Number(option("--matchup-unknown-min-evidence") ?? 4),
    includeNoOverlay: hasFlag("--include-baseline-only") || hasFlag("--include-no-overlay")
  };
}

function mulliganMode() {
  if (hasFlag("--pilot-mulligan") || hasFlag("--agent-mulligan")) return "pilot";
  if (hasFlag("--auto-mulligan-bricks")) return "bricks";
  if (hasFlag("--auto-setup") || hasFlag("--auto-mulligan")) return "auto";
  return "pilot";
}

function validationTarget() {
  const value = String(option("--validation-target") ?? "overlay").trim().toLowerCase();
  if (!new Set(["action", "overlay", "full"]).has(value)) {
    throw new Error(`Unknown --validation-target: ${value}. Use action, overlay, or full.`);
  }
  return value;
}

function publicConfig(raw) {
  return {
    validationTarget: raw.validationTarget,
    deckId: raw.deckId,
    ownKey: raw.ownKey,
    opponentCount: raw.opponentCount,
    games: raw.games,
    seed: raw.seed,
    commonRandomNumbers: raw.commonRandomNumbers,
    catalogPath: raw.catalogPath,
    libraryDir: raw.libraryDir,
    agentRoot: raw.agentRoot,
    policyDir: raw.policyDir,
    baselineRoot: raw.baselineRoot,
    beforeBaselineRoot: raw.beforeBaselineRoot,
    outDir: raw.outDir,
    mulliganMode: raw.mulliganMode,
    mlStrength: raw.mlStrength,
    opponentMlStrength: raw.opponentMlStrength,
    matchupOverlayStrength: raw.matchupOverlayStrength,
    matchupMinConfidence: raw.matchupMinConfidence,
    includeNoOverlay: raw.includeNoOverlay
  };
}

function readJsonIfExists(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function average(rows, fn) {
  if (rows.length === 0) return 0;
  return rows.reduce((total, row) => total + Number(fn(row) ?? 0), 0) / rows.length;
}

function comparisonIsolationLabel(comparison) {
  if (comparison.comparedArtifact === "action-model-and-matchup-overlay-sequential") {
    return `sequential action-model then overlay review (action ${comparison.actionVerdict}; overlay ${comparison.overlayVerdict})`;
  }
  if (comparison.policyAndActionModelHeldConstant) return "deck policy and action model held constant";
  if (comparison.policyAndMatchupOverlayHeldConstant) return "deck policy and matchup overlays held constant";
  return "not isolated";
}

function signed(value) {
  const number = Number(value ?? 0);
  return `${number >= 0 ? "+" : ""}${number.toFixed(2)}`;
}

function formatPercent(value) {
  return `${(Number(value ?? 0) * 100).toFixed(1)}%`;
}

function formatSignedPercent(value) {
  const number = Number(value ?? 0);
  return `${number >= 0 ? "+" : ""}${(number * 100).toFixed(1)}%`;
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
  node tools/validate-matchup-impact.mjs --validation-target overlay --deck carnerr-spear --own-key eva-purple-spear-eva-13 --opponents regional-a,regional-b --before-baseline-root work/private/pilot-agent/loops/session/cycle-01/validation/before-baselines --out-dir work/private/pilot-agent/loops/session/cycle-01/validation

Runs a paired isolated artifact validation. Overlay mode holds the current deck
policy and action model constant. Action mode holds the current deck policy and
previous validated matchup overlays constant. --games is total games per variant.`);
}
