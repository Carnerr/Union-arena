#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  analyzeSetupHand,
  applyAction,
  catalogGameResult,
  createSimulationGame,
  loadCatalogJson,
  loadDeckJson,
  runAutoplayGame,
  summarizeGameState
} from "../src/index.js";

const DEFAULT_CATALOG = "work/private/egman-unionarena-catalog.json";
const DEFAULT_LIBRARY = "work/private/decks";
const DEFAULT_OUT_DIR = "work/private/batch-simulations";

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
const alternateFirst = hasFlag("--alternate-first");
const firstPlayer = option("--first-player") ?? "P1";

if (hasFlag("--help")) {
  usage();
  process.exit(0);
}

const catalog = loadCatalogJson(catalogPath);
const decks = {
  P1: loadDeckJson(deckPath(p1)),
  P2: loadDeckJson(deckPath(p2))
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
    setupMode: autoMulliganBricks ? "manual" : "auto"
  });
  const setupState = autoMulliganBricks
    ? resolveBrickMulligans(simulation.state)
    : simulation.state;
  const playoutResult = playout
    ? runAutoplayGame(setupState, { maxTurns, maxActions })
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
    playoutStoppedReason: playoutMeta.stoppedReason
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
  alternateFirst,
  firstPlayer,
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
  alternateFirst,
  firstPlayer,
  brickDefinition: "A player is marked bricked when their final setup hand contains no character with requiredEnergy.amount equal to 0.",
  rows: gameCatalogRows
}, null, 2)}\n`);
writeFileSync(gameCatalogCsvPath, csvFromRows(gameCatalogRows));

console.log(`Created ${games} game(s): ${p1} vs ${p2}`);
console.log(`Random seed mode: ${randomize ? "random" : seed === undefined ? "deterministic sequential from 1" : `deterministic sequential from ${seed}`}`);
console.log(`Auto mulligan bricks: ${autoMulliganBricks ? "enabled" : "disabled"}`);
console.log(`First player mode: ${alternateFirst ? `alternating from ${firstPlayer}` : firstPlayer}`);
console.log(`Autoplay playout: ${playout ? `enabled, max ${maxTurns} turn(s) / ${maxActions} action(s)` : "disabled"}`);
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
  node tools/batch-simulate.mjs --p1 deck-id --p2 deck-id [--games 100] [--seed n] [--random-seed] [--save-states] [--auto-mulligan-bricks] [--playout] [--max-turns 100] [--first-player P1|P2] [--alternate-first] [--no-validate]

By default this creates many shuffled opening game states with deterministic sequential seeds and writes summary.json, summary.csv, game-catalog.json, and game-catalog.csv.`);
}
