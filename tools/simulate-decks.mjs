#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  catalogGameResult,
  createSimulationGame,
  legalActions,
  loadCatalogJson,
  loadDeckJson,
  summarizeGameState
} from "../src/index.js";

const DEFAULT_CATALOG = "work/private/egman-unionarena-catalog.json";
const DEFAULT_LIBRARY = "work/private/decks";

const p1 = option("--p1");
const p2 = option("--p2");

if (process.argv.includes("--help") || !p1 || !p2) {
  console.log(`Usage:
  node tools/simulate-decks.mjs --p1 deck-id --p2 deck-id [--catalog path] [--library dir] [--out path] [--seed n] [--random-seed] [--skip-shuffle] [--no-validate]

Loads saved decks from the deck library and creates an initial game state.`);
  process.exit(p1 && p2 ? 0 : 1);
}

const catalogPath = option("--catalog") ?? DEFAULT_CATALOG;
const libraryDir = option("--library") ?? DEFAULT_LIBRARY;
const out = option("--out") ?? `work/private/simulations/${timestamp()}-${p1}-vs-${p2}.json`;
const seed = option("--seed") === undefined ? undefined : Number(option("--seed"));
const randomize = process.argv.includes("--random-seed");
const validateDecks = !process.argv.includes("--no-validate");
const skipShuffle = process.argv.includes("--skip-shuffle");

const catalog = loadCatalogJson(catalogPath);
const p1Path = deckPath(libraryDir, p1);
const p2Path = deckPath(libraryDir, p2);
const decks = {
  P1: loadDeckJson(p1Path),
  P2: loadDeckJson(p2Path)
};

const simulation = createSimulationGame({
  catalog,
  decks,
  seed,
  randomize,
  skipShuffle,
  validateDecks
});
const game = simulation.state;

const payload = {
  createdAt: new Date().toISOString(),
  catalogPath,
  decks: {
    P1: p1Path,
    P2: p2Path
  },
  seed: simulation.seed,
  summary: summarizeGameState(game),
  gameCatalog: catalogGameResult(game, { seed: simulation.seed, statePath: out }),
  state: game
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);

console.log(`Created game: ${p1} vs ${p2}`);
console.log(`Seed: ${simulation.seed}`);
console.log(`Phase: ${game.phase}; active player: ${game.activePlayer}`);
console.log(`P1 hand/life/deck: ${game.players.P1.hand.length}/${game.players.P1.life.length}/${game.players.P1.deck.length}`);
console.log(`P2 hand/life/deck: ${game.players.P2.hand.length}/${game.players.P2.life.length}/${game.players.P2.deck.length}`);
console.log(`P1 legal actions: ${legalActions(game, "P1").length}`);
console.log(`P2 legal actions: ${legalActions(game, "P2").length}`);
console.log(`Saved state: ${out}`);

function deckPath(libraryDir, id) {
  const path = join(libraryDir, `${id}.json`);
  if (!existsSync(path)) throw new Error(`Saved deck not found: ${path}`);
  return path;
}

function option(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
