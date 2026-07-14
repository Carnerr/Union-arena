import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeJsonAtomicSync } from "./artifact-io.js";
import { normalizeDeckList, sourceCodeFromNumber, validateDeck } from "./deck.js";
import { normalizeMatchupOverlay, normalizePilotPolicy } from "./simulation.js";

export const DEFAULT_POLICY_ROOT = "work/private/pilot-agent";
export const DEFAULT_POLICY_DIR = "work/private/pilot-agent/policies";
export const DEFAULT_BASELINE_ROOT = "work/private/pilot-agent/baselines";
export const DEFAULT_FALLBACK_POLICY_PATH = "work/private/pilot-agent/current-best-policy.json";
export const DEFAULT_DECK_LIBRARY = "work/private/decks";
export const DEFAULT_ARCHETYPE_DISTANCE_THRESHOLD = 10;
export const DEFAULT_ARCHETYPE_DECK_PREFIXES = ["carnerr-", "engine-"];
export const BASELINE_POLICY_FILE = "baseline-policy.json";
export const BASELINE_ORIGIN_FILE = "baseline-origin.json";
export const ACTION_MODEL_FILE = "action-model.json";

export function deckPolicyProfile({ deck, catalog, savedDeck = null, deckId = null } = {}) {
  const summary = savedDeck?.summary ?? {};
  const validation = savedDeck?.validation ?? {};
  const cards = deck ?? savedDeck?.cards ?? [];
  const explicitKey = explicitDeckPolicyKey(savedDeck);
  const sourceCode = validation.sourceCode
    ?? summary.sourceCode
    ?? inferSourceCode(cards, catalog);
  const colors = normalizeColors(summary.colors ?? (summary.color ? [summary.color] : inferColors(cards, catalog)));
  const colorKey = colors.length > 0 ? colors.join("-") : "unknown";
  const setKey = policyKeySegment(sourceCode ?? "unknown");
  const setColorKey = `${setKey}-${policyKeySegment(colorKey)}`;
  const key = explicitKey ? policyKeySegment(explicitKey) : setColorKey;

  return {
    deckId,
    sourceCode: sourceCode ?? null,
    colors,
    colorKey,
    setColorKey,
    explicitKey: explicitKey ?? null,
    key,
    policyFileName: `${key}.json`
  };
}

export function resolvePolicyForDeck({
  deck,
  catalog,
  savedDeck = null,
  deckId = null,
  policyDir = DEFAULT_POLICY_DIR,
  baselineRoot = undefined,
  fallbackPolicyPath = DEFAULT_FALLBACK_POLICY_PATH,
  deckLibrary = DEFAULT_DECK_LIBRARY,
  archetypeDistanceThreshold = DEFAULT_ARCHETYPE_DISTANCE_THRESHOLD,
  archetypeDeckPrefixes = DEFAULT_ARCHETYPE_DECK_PREFIXES,
  inferArchetype = true
} = {}) {
  const profile = inferArchetype
    ? resolveArchetypeProfile({
      deck,
      catalog,
      savedDeck,
      deckId,
      deckLibrary,
      threshold: archetypeDistanceThreshold,
      deckPrefixes: archetypeDeckPrefixes
    }).profile
    : deckPolicyProfile({ deck, catalog, savedDeck, deckId });
  const candidates = [
    deckId ? {
      kind: "deck",
      layout: "organized",
      path: deckSpecificPolicyPathForProfile(profile, deckId, { policyDir, baselineRoot })
    } : null,
    deckId ? {
      kind: "deck",
      layout: "legacy",
      path: join(policyDir, "decks", `${policyKeySegment(deckId)}.json`)
    } : null,
    {
      kind: "set-color",
      layout: "organized",
      path: policyPathForProfile(profile, { policyDir, baselineRoot })
    },
    {
      kind: "set-color",
      layout: "legacy",
      path: legacyPolicyPathForProfile(profile, { policyDir })
    },
    {
      kind: "fallback",
      layout: "legacy",
      path: fallbackPolicyPath
    }
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue;
    return {
      profile,
      path: candidate.path,
      kind: candidate.kind,
      layout: candidate.layout,
      policy: normalizePilotPolicy(JSON.parse(readFileSync(candidate.path, "utf8"))),
      foundSpecialist: candidate.kind !== "fallback"
    };
  }

  return {
    profile,
    path: null,
    kind: "none",
    policy: normalizePilotPolicy(),
    foundSpecialist: false
  };
}

export function resolveArchetypeProfile({
  deck,
  catalog,
  savedDeck = null,
  deckId = null,
  deckLibrary = DEFAULT_DECK_LIBRARY,
  threshold = DEFAULT_ARCHETYPE_DISTANCE_THRESHOLD,
  deckPrefixes = DEFAULT_ARCHETYPE_DECK_PREFIXES
} = {}) {
  const baseProfile = deckPolicyProfile({ deck, catalog, savedDeck, deckId });
  const cards = deck ?? savedDeck?.cards ?? [];
  const baseCounts = deckCardCounts(cards);
  const baseMatch = {
    profile: baseProfile,
    method: baseProfile.explicitKey ? "explicit-policy-key" : "set-color",
    status: baseProfile.explicitKey ? "exact" : "unresolved",
    threshold,
    nearest: null,
    candidates: [],
    candidateCount: 0,
    setColorKey: baseProfile.setColorKey,
    distance: null
  };

  if (baseProfile.explicitKey) {
    return {
      ...baseMatch,
      profile: profileWithArchetypeResolution(baseProfile, baseMatch)
    };
  }

  const candidates = knownArchetypeDecks({ deckLibrary, deckPrefixes, catalog })
    .filter((candidate) => candidate.profile.setColorKey === baseProfile.setColorKey)
    .map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      key: candidate.profile.key,
      setColorKey: candidate.profile.setColorKey,
      sourceCode: candidate.profile.sourceCode,
      colors: candidate.profile.colors,
      explicitKey: candidate.profile.explicitKey,
      archetype: candidate.raw?.source?.archetype ?? null,
      distance: deckDistanceSlots(baseCounts, candidate.counts)
    }))
    .sort(compareArchetypeMatches);

  const nearest = candidates[0] ?? null;
  if (!nearest) {
    const resolution = {
      ...baseMatch,
      method: "no-known-archetype",
      status: "new-archetype-needed",
      candidates,
      candidateCount: 0
    };
    return {
      ...resolution,
      profile: profileWithArchetypeResolution(baseProfile, resolution)
    };
  }

  const bestMatches = candidates.filter((candidate) => candidate.distance === nearest.distance);
  const bestKeys = new Set(bestMatches.map((candidate) => candidate.key));
  const inferred = nearest.distance < threshold && bestKeys.size === 1;
  const ambiguous = nearest.distance < threshold && bestKeys.size > 1;
  const inferredProfile = inferred
    ? {
      ...baseProfile,
      key: nearest.key,
      inferredKey: nearest.key,
      policyFileName: `${nearest.key}.json`
    }
    : baseProfile;
  const resolution = {
    ...baseMatch,
    method: inferred ? "deck-distance" : ambiguous ? "ambiguous-deck-distance" : "nearest-too-far",
    status: inferred ? "matched" : ambiguous ? "ambiguous" : "new-archetype-needed",
    nearest,
    candidates: candidates.slice(0, 8),
    candidateCount: candidates.length,
    distance: nearest.distance
  };

  return {
    ...resolution,
    profile: profileWithArchetypeResolution(inferredProfile, resolution)
  };
}

export function knownArchetypeDecks({
  deckLibrary = DEFAULT_DECK_LIBRARY,
  deckPrefixes = DEFAULT_ARCHETYPE_DECK_PREFIXES,
  catalog = null
} = {}) {
  if (!existsSync(deckLibrary)) return [];
  const prefixes = normalizeDeckPrefixes(deckPrefixes);
  return readdirSync(deckLibrary, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      const path = join(deckLibrary, entry.name);
      let raw;
      try {
        raw = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        return null;
      }
      if (!Array.isArray(raw.cards)) return null;
      const id = raw.id ?? entry.name.replace(/\.json$/u, "");
      if (!prefixes.some((prefix) => id.startsWith(prefix))) return null;
      const profile = deckPolicyProfile({ deck: raw.cards, catalog, savedDeck: raw, deckId: id });
      return {
        id,
        name: raw.name ?? id,
        path,
        raw,
        profile,
        counts: deckCardCounts(raw.cards)
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function deckDistanceSlots(left, right) {
  const leftCounts = left instanceof Map ? left : deckCardCounts(left);
  const rightCounts = right instanceof Map ? right : deckCardCounts(right);
  const keys = new Set([...leftCounts.keys(), ...rightCounts.keys()]);
  let total = 0;
  for (const key of keys) {
    total += Math.abs(Number(leftCounts.get(key) ?? 0) - Number(rightCounts.get(key) ?? 0));
  }
  return total / 2;
}

export function deckCardCounts(deckList = []) {
  const counts = new Map();
  for (const entry of normalizeDeckList(deckList)) {
    const key = deckCardIdentity(entry);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + Number(entry.count ?? 1));
  }
  return counts;
}

export function policyPathForProfile(profile, { policyDir = DEFAULT_POLICY_DIR, baselineRoot = undefined } = {}) {
  return baselinePolicyPathForProfile(profile, { policyDir, baselineRoot });
}

export function legacyPolicyPathForProfile(profile, { policyDir = DEFAULT_POLICY_DIR } = {}) {
  return join(policyDir, profile.policyFileName ?? `${policyKeySegment(profile?.key)}.json`);
}

export function writePolicyForProfile(policy, profile, { policyDir = DEFAULT_POLICY_DIR, baselineRoot = undefined } = {}) {
  const path = policyPathForProfile(profile, { policyDir, baselineRoot });
  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomicSync(path, normalizePilotPolicy(policy));
  return path;
}

export function ensurePolicyForProfile(policy, profile, { policyDir = DEFAULT_POLICY_DIR, baselineRoot = undefined } = {}) {
  const path = policyPathForProfile(profile, { policyDir, baselineRoot });
  if (existsSync(path)) return path;
  return writePolicyForProfile(policy, profile, { policyDir, baselineRoot });
}

export function matchupOverlayKey({ ownProfile, opponentProfile }) {
  return `${ownProfile.key}-vs-${opponentProfile.key}`;
}

export function matchupOverlayPath({ ownProfile, opponentProfile, policyDir = DEFAULT_POLICY_DIR } = {}) {
  return matchupOverlayPathForKeys(ownProfile.key, opponentProfile.key, { policyDir });
}

export function loadMatchupOverlaysForProfile(profile, { policyDir = DEFAULT_POLICY_DIR, baselineRoot = undefined } = {}) {
  const overlays = {};
  for (const file of matchupOverlayFilesForKey(profile.key, { policyDir, baselineRoot })) {
    if (overlays[file.opponentKey] && file.layout === "legacy") continue;
    const path = file.path;
    const overlay = normalizeMatchupOverlay(JSON.parse(readFileSync(path, "utf8")));
    const opponentKey = overlay.opponentKey ?? file.opponentKey;
    overlays[opponentKey] = {
      path,
      layout: file.layout,
      overlay
    };
  }
  return overlays;
}

export function writeMatchupOverlay({ ownProfile, opponentProfile, overlay, policyDir = DEFAULT_POLICY_DIR } = {}) {
  const path = matchupOverlayPath({ ownProfile, opponentProfile, policyDir });
  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomicSync(path, normalizeMatchupOverlay({
    ...overlay,
    ownKey: ownProfile.key,
    opponentKey: opponentProfile.key
  }));
  return path;
}

export function baselineRootForPolicyDir(policyDir = DEFAULT_POLICY_DIR) {
  const normalized = String(policyDir ?? DEFAULT_POLICY_DIR).replace(/[\\/]+$/u, "");
  return /[\\/]policies$/u.test(normalized)
    ? join(dirname(normalized), "baselines")
    : join(dirname(normalized), "baselines");
}

export function baselineDeckDirForKey(ownKey, { policyDir = DEFAULT_POLICY_DIR, baselineRoot = undefined } = {}) {
  return join(resolvedBaselineRoot({ policyDir, baselineRoot }), "decks", policyKeySegment(ownKey));
}

export function baselineDeckDirForProfile(profile, options = {}) {
  return baselineDeckDirForKey(profile?.key, options);
}

export function baselinePolicyPathForKey(ownKey, options = {}) {
  return join(baselineDeckDirForKey(ownKey, options), BASELINE_POLICY_FILE);
}

export function baselinePolicyPathForProfile(profile, options = {}) {
  return baselinePolicyPathForKey(profile?.key, options);
}

export function baselineOriginPathForKey(ownKey, options = {}) {
  return join(baselineDeckDirForKey(ownKey, options), BASELINE_ORIGIN_FILE);
}

export function baselineOriginPathForProfile(profile, options = {}) {
  return baselineOriginPathForKey(profile?.key, options);
}

export function writeBaselineOriginForProfile(origin, profile, options = {}) {
  const path = baselineOriginPathForProfile(profile, options);
  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomicSync(path, origin);
  return path;
}

export function deckSpecificPolicyPathForProfile(profile, deckId, options = {}) {
  return join(baselineDeckDirForProfile(profile, options), "deck-policies", `${artifactFileSegment(deckId)}.json`);
}

export function actionModelPathForKey(ownKey, { agentRoot = DEFAULT_POLICY_ROOT, baselineRoot = undefined, legacy = false } = {}) {
  return legacy
    ? join(agentRoot, "action-models", `${policyKeySegment(ownKey)}.json`)
    : join(baselineRoot ?? join(agentRoot, "baselines"), "decks", policyKeySegment(ownKey), ACTION_MODEL_FILE);
}

export function actionModelCandidatePathsForKey(ownKey, { agentRoot = DEFAULT_POLICY_ROOT, baselineRoot = undefined } = {}) {
  return [
    actionModelPathForKey(ownKey, { agentRoot, baselineRoot }),
    actionModelPathForKey(ownKey, { agentRoot, legacy: true })
  ];
}

export function matchupOverlaysDirForKey(ownKey, options = {}) {
  return join(baselineDeckDirForKey(ownKey, options), "matchups");
}

export function matchupOverlayCandidatesDirForKey(ownKey, options = {}) {
  return join(baselineDeckDirForKey(ownKey, options), "matchup-candidates");
}

export function matchupOverlayPathForKeys(ownKey, opponentKey, options = {}) {
  return join(matchupOverlaysDirForKey(ownKey, options), `${artifactFileSegment(opponentKey)}.json`);
}

export function matchupOverlayCandidatePathForKeys(ownKey, opponentKey, options = {}) {
  return join(matchupOverlayCandidatesDirForKey(ownKey, options), `${artifactFileSegment(opponentKey)}.json`);
}

export function matchupOverlayCandidateFilesForKey(ownKey, options = {}) {
  const files = [];
  const directory = matchupOverlayCandidatesDirForKey(ownKey, options);
  if (!existsSync(directory)) return files;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(directory, entry.name);
    let opponentKey = entry.name.replace(/\.json$/u, "");
    try {
      const overlay = JSON.parse(readFileSync(path, "utf8"));
      opponentKey = overlay.opponentKey ?? opponentKey;
    } catch {
      // Callers still receive the file so parse failures remain visible.
    }
    files.push({ path, ownKey: policyKeySegment(ownKey), opponentKey, layout: "candidate" });
  }
  return files.sort(compareOverlayFiles);
}

export function legacyMatchupOverlayPathForKeys(ownKey, opponentKey, { policyDir = DEFAULT_POLICY_DIR } = {}) {
  return join(policyDir, "matchups", `${policyKeySegment(ownKey)}-vs-${artifactFileSegment(opponentKey)}.json`);
}

export function matchupOverlayFilesForKey(ownKey, { policyDir = DEFAULT_POLICY_DIR, baselineRoot = undefined, includeLegacy = true } = {}) {
  const files = [];
  const key = policyKeySegment(ownKey);
  const organizedDir = matchupOverlaysDirForKey(key, { policyDir, baselineRoot });
  if (existsSync(organizedDir)) {
    for (const entry of readdirSync(organizedDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = join(organizedDir, entry.name);
      let opponentKey = entry.name.replace(/\.json$/u, "");
      try {
        const overlay = JSON.parse(readFileSync(path, "utf8"));
        opponentKey = overlay.opponentKey ?? opponentKey;
      } catch {
        // Leave the filename-derived key so callers can surface parse errors if needed.
      }
      files.push({ path, ownKey: key, opponentKey, layout: "organized" });
    }
  }

  if (!includeLegacy) return files.sort(compareOverlayFiles);

  const legacyDir = join(policyDir, "matchups");
  const legacyPrefix = `${key}-vs-`;
  if (existsSync(legacyDir)) {
    for (const entry of readdirSync(legacyDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(legacyPrefix) || !entry.name.endsWith(".json")) continue;
      const path = join(legacyDir, entry.name);
      let opponentKey = entry.name.slice(legacyPrefix.length, -".json".length);
      try {
        const overlay = JSON.parse(readFileSync(path, "utf8"));
        opponentKey = overlay.opponentKey ?? opponentKey;
      } catch {
        // Leave the filename-derived key so callers can surface parse errors if needed.
      }
      files.push({ path, ownKey: key, opponentKey, layout: "legacy" });
    }
  }

  return files.sort(compareOverlayFiles);
}

export function policyKeySegment(value) {
  return String(value ?? "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

export function artifactFileSegment(value) {
  return String(value ?? "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

function resolvedBaselineRoot({ policyDir = DEFAULT_POLICY_DIR, baselineRoot = undefined } = {}) {
  return baselineRoot ?? baselineRootForPolicyDir(policyDir);
}

function explicitDeckPolicyKey(savedDeck) {
  const source = savedDeck?.source ?? {};
  const candidates = [
    savedDeck?.policyKey,
    savedDeck?.profileKey,
    savedDeck?.trainingProfile?.key,
    savedDeck?.trainingProfile?.policyKey,
    source.policyKey,
    source.profileKey,
    source.trainingProfileKey
  ];
  return candidates
    .map((value) => String(value ?? "").trim())
    .find(Boolean) ?? null;
}

function profileWithArchetypeResolution(profile, resolution) {
  return {
    ...profile,
    archetypeResolution: {
      method: resolution.method,
      status: resolution.status,
      threshold: resolution.threshold,
      setColorKey: resolution.setColorKey,
      distance: resolution.distance,
      candidateCount: resolution.candidateCount,
      nearest: resolution.nearest ? compactArchetypeMatch(resolution.nearest) : null,
      candidates: (resolution.candidates ?? []).map(compactArchetypeMatch)
    }
  };
}

function compactArchetypeMatch(match) {
  return {
    id: match.id,
    name: match.name,
    key: match.key,
    setColorKey: match.setColorKey,
    distance: match.distance,
    archetype: match.archetype ?? null
  };
}

function compareArchetypeMatches(a, b) {
  return Number(a.distance) - Number(b.distance)
    || Number(!a.explicitKey) - Number(!b.explicitKey)
    || String(a.key).localeCompare(String(b.key))
    || String(a.name).localeCompare(String(b.name))
    || String(a.id).localeCompare(String(b.id));
}

function normalizeDeckPrefixes(value) {
  const rows = Array.isArray(value)
    ? value
    : String(value ?? "")
      .split(",");
  return rows.map((prefix) => String(prefix).trim()).filter(Boolean);
}

function deckCardIdentity(entry) {
  const raw = entry?.number ?? entry?.cardNumber ?? entry?.code ?? entry?.id ?? entry;
  const text = String(raw ?? "").trim();
  if (!text) return "";
  if (text.includes("/")) return text.split("/").at(-1).toUpperCase();
  if (text.includes("_")) {
    const parts = text.split("_").filter(Boolean);
    if (/^ue\d+/iu.test(parts[0] ?? "") && parts.length >= 4) {
      return `${parts[1]}-${parts[2]}-${parts.slice(3).join("-")}`.toUpperCase();
    }
    return parts.at(-1).toUpperCase();
  }
  return text.toUpperCase();
}

function compareOverlayFiles(a, b) {
  return Number(a.layout === "legacy") - Number(b.layout === "legacy")
    || String(a.opponentKey).localeCompare(String(b.opponentKey))
    || a.path.localeCompare(b.path);
}

function inferSourceCode(deck, catalog) {
  if (!deck || !catalog) return null;
  try {
    return validateDeck(deck, catalog).sourceCode;
  } catch {
    const codes = new Set();
    for (const entry of normalizeDeckList(deck)) {
      const def = catalog[entry.id];
      if (def?.sourceCode) codes.add(def.sourceCode);
      else if (def?.number) codes.add(sourceCodeFromNumber(def.number));
    }
    return codes.size === 1 ? [...codes][0] : null;
  }
}

function inferColors(deck, catalog) {
  if (!deck || !catalog) return [];
  const counts = new Map();
  for (const entry of normalizeDeckList(deck)) {
    const color = catalog[entry.id]?.color;
    if (!color) continue;
    counts.set(color, (counts.get(color) ?? 0) + Number(entry.count ?? 1));
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([color]) => color);
}

function normalizeColors(colors) {
  return [...new Set((colors ?? [])
    .map((color) => String(color).trim().toLowerCase())
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}
