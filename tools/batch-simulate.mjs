#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  analyzeSetupHand,
  applyAction,
  catalogGameResult,
  createSimulationGame,
  DEFAULT_POLICY_DIR,
  loadCatalogJson,
  loadDeckJson,
  normalizePilotPolicy,
  resolvePolicyForDeck,
  resolvePilotSetup,
  runAutoplayGame,
  summarizeGameState
} from "../src/index.js";

const DEFAULT_CATALOG = "work/private/egman-unionarena-catalog.json";
const DEFAULT_LIBRARY = "work/private/decks";
const DEFAULT_OUT_DIR = "work/private/batch-simulations";
const CURRENT_POLICY_PATH = "work/private/pilot-agent/current-best-policy.json";

const p1 = requiredOption("--p1");
const p2 = requiredOption("--p2");
const games = Number(option("--games") ?? 100);
const catalogPath = option("--catalog") ?? DEFAULT_CATALOG;
const libraryDir = option("--library") ?? DEFAULT_LIBRARY;
const outDir = option("--out-dir") ?? join(DEFAULT_OUT_DIR, `${timestamp()}-${p1}-vs-${p2}`);
const seed = option("--seed") === undefined ? undefined : Number(option("--seed"));
const randomize = hasFlag("--random-seed");
const saveStates = hasFlag("--save-states");
const skipShuffle = hasFlag("--skip-shuffle");
const validateDecks = !hasFlag("--no-validate");
const playout = hasFlag("--playout") || hasFlag("--auto-play");
const maxTurns = Number(option("--max-turns") ?? 100);
const maxActions = Number(option("--max-actions") ?? 1000);
const autoMulliganBricks = hasFlag("--auto-mulligan-bricks");
const pilotMulligan = hasFlag("--pilot-mulligan") || hasFlag("--agent-mulligan");
const alternateFirst = hasFlag("--alternate-first");
const firstPlayer = option("--first-player") ?? "P1";
const useCurrentPolicy = hasFlag("--use-current-policy") || hasFlag("--current-policy");
const p1PolicyPath = resolvePolicyPath(option("--pilot-policy") ?? option("--p1-policy") ?? (useCurrentPolicy ? "current" : undefined));
const p2PolicyPath = resolvePolicyPath(option("--opponent-policy") ?? option("--opponent-pilot-policy") ?? option("--p2-policy") ?? (useCurrentPolicy ? "current" : undefined));
const policyDir = option("--policy-dir") ?? DEFAULT_POLICY_DIR;
const fallbackPolicyPath = resolvePolicyPath(option("--fallback-policy") ?? "current");

if (hasFlag("--help")) {
  usage();
  process.exit(0);
}

const catalog = loadCatalogJson(catalogPath);
const decks = {
  P1: loadDeckJson(deckPath(p1)),
  P2: loadDeckJson(deckPath(p2))
};
const savedDecks = {
  P1: loadSavedDeck(deckPath(p1)),
  P2: loadSavedDeck(deckPath(p2))
};
const policySelection = policySelectionForDecks();
const policyConfig = {
  P1: policySelection.P1.policy,
  P2: policySelection.P2.policy
};

mkdirSync(outDir, { recursive: true });

const rows = [];
const gameCatalogRows = [];
for (let index = 0; index < games; index += 1) {
  const simulation = createSimulationGame({
    catalog,
    decks,
    seed,
    randomize,
    iteration: index,
    skipShuffle,
    validateDecks,
    firstPlayer: firstPlayerForGame(index),
    setupMode: autoMulliganBricks || pilotMulligan ? "manual" : "auto"
  });
  const setupState = resolveSetupState(simulation.state, policyConfig);
  const playoutResult = playout
    ? runAutoplayGame(setupState, { maxTurns, maxActions, policy: policyConfig })
    : { state: setupState, steps: 0, stoppedReason: "notRun" };
  const finalState = playoutResult.state;
  const playoutMeta = {
    steps: playoutResult.steps,
    stoppedReason: playoutResult.stoppedReason
  };
  const summary = summarizeGameState(finalState);
  const statePath = saveStates ? join(outDir, `game-${String(index + 1).padStart(5, "0")}.json`) : undefined;
  const gameCatalog = {
    ...catalogGameResult(finalState, {
      index: index + 1,
      seed: simulation.seed,
      statePath: statePath ?? null
    }),
    playoutSteps: playoutMeta.steps,
    playoutStoppedReason: playoutMeta.stoppedReason,
    playoutFailureCode: playoutResult.failureDiagnostics?.candidateFailures?.[0]?.code ?? "",
    playoutFailureMessage: playoutResult.failureDiagnostics?.candidateFailures?.[0]?.message ?? "",
    playoutFailureDiagnostics: playoutResult.failureDiagnostics
      ? JSON.stringify(playoutResult.failureDiagnostics)
      : ""
  };
  if (statePath) {
    writeFileSync(statePath, `${JSON.stringify({
      schema: "union-arena-local-engine/batch-game@1",
      index: index + 1,
      seed: simulation.seed,
      decks: { P1: p1, P2: p2 },
      summary,
      playout: playoutMeta,
      gameCatalog,
      state: finalState
    }, null, 2)}\n`);
  }
  gameCatalogRows.push(gameCatalog);

  rows.push({
    index: index + 1,
    seed: simulation.seed,
    statePath,
    phase: summary.phase,
    activePlayer: summary.activePlayer,
    p1Hand: summary.players.P1.hand,
    p1Life: summary.players.P1.life,
    p1Deck: summary.players.P1.deck,
    p1LegalActions: summary.players.P1.legalActions,
    p2Hand: summary.players.P2.hand,
    p2Life: summary.players.P2.life,
    p2Deck: summary.players.P2.deck,
    p2LegalActions: summary.players.P2.legalActions,
    playoutSteps: playoutMeta.steps,
    playoutStoppedReason: playoutMeta.stoppedReason
  });
}

const summaryPath = join(outDir, "summary.json");
const csvPath = join(outDir, "summary.csv");
const gameCatalogPath = join(outDir, "game-catalog.json");
const gameCatalogCsvPath = join(outDir, "game-catalog.csv");
writeFileSync(summaryPath, `${JSON.stringify({
  createdAt: new Date().toISOString(),
  catalogPath,
  decks: { P1: p1, P2: p2 },
  games,
  seed,
  randomize,
  skipShuffle,
  validateDecks,
  saveStates,
  playout,
  maxTurns,
  maxActions,
  autoMulliganBricks,
  pilotMulligan,
  alternateFirst,
  firstPlayer,
  policyPaths: {
    P1: policySelection.P1.path ?? null,
    P2: policySelection.P2.path ?? null
  },
  rows
}, null, 2)}\n`);
writeFileSync(csvPath, csvFromRows(rows));
writeFileSync(gameCatalogPath, `${JSON.stringify({
  schema: "union-arena-local-engine/game-catalog@1",
  createdAt: new Date().toISOString(),
  catalogPath,
  decks: { P1: p1, P2: p2 },
  games,
  seed,
  randomize,
  skipShuffle,
  validateDecks,
  saveStates,
  playout,
  maxTurns,
  maxActions,
  autoMulliganBricks,
  pilotMulligan,
  alternateFirst,
  firstPlayer,
  policyPaths: {
    P1: policySelection.P1.path ?? null,
    P2: policySelection.P2.path ?? null
  },
  brickDefinition: "A player is marked bricked when their final setup hand contains no setup-valid opener: a literal 0-cost character or a character whose hand-only setup cost is reduced to 0 on an empty field.",
  rows: gameCatalogRows
}, null, 2)}\n`);
writeFileSync(gameCatalogCsvPath, csvFromRows(gameCatalogRows));

console.log(`Created ${games} game(s): ${p1} vs ${p2}`);
console.log(`Random seed mode: ${randomize ? "random" : seed === undefined ? "deterministic sequential from 1" : `deterministic sequential from ${seed}`}`);
console.log(`Auto mulligan bricks: ${autoMulliganBricks ? "enabled" : "disabled"}`);
console.log(`Pilot mulligan: ${pilotMulligan ? "enabled" : "disabled"}`);
console.log(`First player mode: ${alternateFirst ? `alternating from ${firstPlayer}` : firstPlayer}`);
console.log(`Autoplay playout: ${playout ? `enabled, max ${maxTurns} turn(s) / ${maxActions} action(s)` : "disabled"}`);
console.log(`Autoplay policy: P1=${policySelection.P1.path ?? "baseline"}; P2=${policySelection.P2.path ?? "baseline"}`);
console.log(`Saved summary: ${summaryPath}`);
console.log(`Saved CSV: ${csvPath}`);
console.log(`Saved game catalog: ${gameCatalogPath}`);
console.log(`Saved game catalog CSV: ${gameCatalogCsvPath}`);
if (saveStates) console.log(`Saved states in: ${outDir}`);

function deckPath(id) {
  const path = join(libraryDir, `${id}.json`);
  if (!existsSync(path)) throw new Error(`Saved deck not found: ${path}`);
  return path;
}

function loadSavedDeck(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return Array.isArray(raw) ? { cards: raw } : raw;
}

function resolveSetupState(state, policy) {
  if (pilotMulligan) {
    const baseline = normalizePilotPolicy();
    return resolvePilotSetup(state, {
      P1: policy?.P1 ?? baseline,
      P2: policy?.P2 ?? policy?.P1 ?? baseline
    });
  }
  if (autoMulliganBricks) return resolveBrickMulligans(state);
  return state;
}

function policySelectionForDecks() {
  const p1Selection = policySelectionForDeck({
    player: "P1",
    deckId: p1,
    deck: decks.P1,
    savedDeck: savedDecks.P1,
    explicitPath: p1PolicyPath
  });
  const p2Selection = policySelectionForDeck({
    player: "P2",
    deckId: p2,
    deck: decks.P2,
    savedDeck: savedDecks.P2,
    explicitPath: p2PolicyPath
  });
  return { P1: p1Selection, P2: p2Selection };
}

function policySelectionForDeck({ deckId, deck, savedDeck, explicitPath }) {
  if (explicitPath) {
    return {
      path: explicitPath,
      policy: normalizePilotPolicy(loadPolicy(explicitPath)),
      kind: "explicit"
    };
  }
  const routed = resolvePolicyForDeck({
    deck,
    catalog,
    savedDeck,
    deckId,
    policyDir,
    fallbackPolicyPath,
    deckLibrary: libraryDir
  });
  return {
    path: routed.path,
    policy: routed.policy,
    kind: routed.kind,
    profile: routed.profile
  };
}

function loadPolicy(path) {
  if (!path) return undefined;
  if (!existsSync(path)) throw new Error(`Policy file not found: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function resolvePolicyPath(value) {
  if (!value) return undefined;
  const normalized = normalizeSearch(value);
  if (["auto", "routed", "route", "deck", "deck policy", "specialist"].includes(normalized)) return undefined;
  if (["current", "current best", "current policy", "champion", "best"].includes(normalized)) {
    return CURRENT_POLICY_PATH;
  }
  return value;
}

function normalizeSearch(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function csvFromRows(rows) {
  const headers = Object.keys(rows[0] ?? { index: "", seed: "" });
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((key) => csvCell(row[key])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

function resolveBrickMulligans(state) {
  let nextState = state;
  for (const playerId of ["P1", "P2"]) {
    const actionType = analyzeSetupHand(nextState, playerId).initialBricked ? "mulligan" : "keepHand";
    nextState = applyAction(nextState, { type: actionType, player: playerId });
  }
  return nextState;
}

function firstPlayerForGame(index) {
  if (!alternateFirst) return firstPlayer;
  if (firstPlayer === "P1") return index % 2 === 0 ? "P1" : "P2";
  if (firstPlayer === "P2") return index % 2 === 0 ? "P2" : "P1";
  throw new Error(`Invalid --first-player value: ${firstPlayer}`);
}

function option(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function requiredOption(flag) {
  const value = option(flag);
  if (!value) {
    usage();
    throw new Error(`Missing required option: ${flag}`);
  }
  return value;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function usage() {
  console.log(`Usage:
  node tools/batch-simulate.mjs --p1 deck-id --p2 deck-id [--games 100] [--seed n] [--random-seed] [--save-states] [--auto-mulligan-bricks] [--pilot-mulligan] [--playout] [--pilot-policy current|auto] [--opponent-policy current|auto] [--max-turns 100] [--first-player P1|P2] [--alternate-first] [--no-validate]

By default this creates many shuffled opening game states with deterministic sequential seeds and writes summary.json, summary.csv, game-catalog.json, and game-catalog.csv.

Policy shortcuts:
  --use-current-policy       Use work/private/pilot-agent/current-best-policy.json for both players.
  --pilot-policy current     Use the current champion for P1 autoplay and pilot mulligan choices.
  --opponent-policy current  Use the current champion for P2 autoplay and pilot mulligan choices.
  --pilot-policy auto        Route P1 by deck set/color; this is also the default when omitted.
  --opponent-policy auto     Route P2 by deck set/color; this is also the default when omitted.`);
}
