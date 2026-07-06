#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  applyAction,
  catalogGameResult,
  createSimulationGame,
  legalActions,
  loadCatalogJson,
  loadDeckJson,
  summarizeGameState
} from "../src/index.js";

const DEFAULT_CATALOG = "work/private/egman-unionarena-catalog.json";
const DEFAULT_DECK_LIBRARY = "work/private/decks";
const DEFAULT_GAME_DIR = "work/private/ai-games";

const command = process.argv[2];

try {
  switch (command) {
    case "help":
    case "--help":
    case undefined:
      printHelp();
      process.exit(command ? 0 : 1);
      break;
    case "cards":
      output(cardsCommand());
      break;
    case "card":
      output(cardCommand());
      break;
    case "decks":
      output(decksCommand());
      break;
    case "deck":
      output(deckCommand());
      break;
    case "new-game":
      output(newGameCommand());
      break;
    case "state":
      output(stateCommand());
      break;
    case "legal-actions":
      output(legalActionsCommand());
      break;
    case "apply-action":
      output(applyActionCommand());
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  output({
    ok: false,
    error: error.message,
    details: error.details
  });
  process.exit(1);
}

function cardsCommand() {
  const catalog = loadCatalog();
  const query = option("--query")?.toLowerCase();
  const source = option("--source")?.toUpperCase();
  const limit = Number(option("--limit") ?? 20);
  const cards = Object.values(catalog)
    .filter((card) => !query || [
      card.id,
      card.number,
      card.name,
      card.title
    ].some((value) => String(value ?? "").toLowerCase().includes(query)))
    .filter((card) => !source || card.sourceCode === source || String(card.number).startsWith(`${source}_`))
    .slice(0, limit)
    .map(cardSummary);

  return { ok: true, cards };
}

function cardCommand() {
  const catalog = loadCatalog();
  const idOrCode = requiredOption("--id");
  const card = findCard(catalog, idOrCode);
  if (!card) throw new Error(`Card not found: ${idOrCode}`);
  return { ok: true, card };
}

function decksCommand() {
  const library = option("--library") ?? DEFAULT_DECK_LIBRARY;
  if (!existsSync(library)) return { ok: true, decks: [] };
  const decks = readdirSync(library)
    .filter((file) => file.toLowerCase().endsWith(".json"))
    .map((file) => {
      const path = join(library, file);
      const deck = JSON.parse(readFileSync(path, "utf8"));
      return {
        id: deck.id,
        name: deck.name,
        path,
        size: deck.validation?.size ?? deck.summary?.size ?? deck.cards?.reduce((total, card) => total + card.count, 0),
        sourceCode: deck.validation?.sourceCode ?? deck.summary?.sourceCode,
        validated: Boolean(deck.validation)
      };
    });
  return { ok: true, decks };
}

function deckCommand() {
  const deck = loadSavedDeck(requiredOption("--id"));
  return { ok: true, deck };
}

function newGameCommand() {
  const catalogPath = option("--catalog") ?? DEFAULT_CATALOG;
  const catalog = loadCatalogJson(catalogPath);
  const p1 = requiredOption("--p1");
  const p2 = requiredOption("--p2");
  const seed = option("--seed") === undefined ? undefined : Number(option("--seed"));
  const randomize = hasFlag("--random-seed");
  const validateDecks = !hasFlag("--no-validate");
  const skipShuffle = hasFlag("--skip-shuffle");
  const out = option("--out") ?? join(DEFAULT_GAME_DIR, `${timestamp()}-${p1}-vs-${p2}.json`);

  const simulation = createSimulationGame({
    catalog,
    decks: {
      P1: loadDeckJson(savedDeckPath(p1)),
      P2: loadDeckJson(savedDeckPath(p2))
    },
    seed,
    randomize,
    validateDecks,
    skipShuffle
  });
  const state = simulation.state;

  writeGame(out, {
    schema: "union-arena-local-engine/ai-game@1",
    createdAt: new Date().toISOString(),
    catalogPath,
    seed: simulation.seed,
    decks: { P1: p1, P2: p2 },
    gameCatalog: catalogGameResult(state, { seed: simulation.seed, statePath: out }),
    state
  });

  return {
    ok: true,
    path: out,
    seed: simulation.seed,
    summary: summarizeGameState(state),
    gameCatalog: catalogGameResult(state, { seed: simulation.seed, statePath: out })
  };
}

function stateCommand() {
  const statePath = requiredOption("--state");
  const game = readGame(statePath);
  return {
    ok: true,
    summary: summarizeGameState(game.state),
    gameCatalog: catalogGameResult(game.state, { seed: game.seed, statePath }),
    state: hasFlag("--full") ? game.state : undefined
  };
}

function legalActionsCommand() {
  const game = readGame(requiredOption("--state"));
  const player = requiredOption("--player");
  return {
    ok: true,
    player,
    phase: game.state.phase,
    activePlayer: game.state.activePlayer,
    actions: legalActions(game.state, player)
  };
}

function applyActionCommand() {
  const statePath = requiredOption("--state");
  const out = option("--out") ?? statePath;
  const actionText = option("--action") ?? readFileSync(requiredOption("--action-file"), "utf8");
  const action = JSON.parse(actionText);
  const game = readGame(statePath);
  const nextState = applyAction(game.state, action);
  const nextGame = {
    ...game,
    updatedAt: new Date().toISOString(),
    gameCatalog: catalogGameResult(nextState, { seed: game.seed, statePath: out }),
    state: nextState
  };
  writeGame(out, nextGame);
  return {
    ok: true,
    path: out,
    action,
    summary: summarizeGameState(nextState),
    gameCatalog: catalogGameResult(nextState, { seed: game.seed, statePath: out })
  };
}

function loadCatalog() {
  return loadCatalogJson(option("--catalog") ?? DEFAULT_CATALOG);
}

function findCard(catalog, idOrCode) {
  const key = normalizeCode(idOrCode);
  return catalog[key]
    ?? Object.values(catalog).find((card) => normalizeCode(card.number) === key)
    ?? Object.values(catalog).find((card) => normalizeCode(displayCode(card.number)) === key)
    ?? Object.values(catalog).find((card) => normalizeCode(localCode(card.number)) === key);
}

function cardSummary(card) {
  return {
    id: card.id,
    number: displayCode(card.number),
    name: card.name,
    type: card.type,
    color: card.color,
    requiredEnergy: card.requiredEnergy?.amount,
    apCost: card.apCost,
    bp: card.bp,
    hasRaid: Boolean(card.raid),
    trigger: card.trigger?.type
  };
}

function loadSavedDeck(id) {
  return JSON.parse(readFileSync(savedDeckPath(id), "utf8"));
}

function savedDeckPath(id) {
  const library = option("--library") ?? DEFAULT_DECK_LIBRARY;
  const path = join(library, `${id}.json`);
  if (!existsSync(path)) throw new Error(`Saved deck not found: ${path}`);
  return path;
}

function readGame(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return raw.state ? raw : { state: raw };
}

function writeGame(path, game) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(game, null, 2)}\n`);
}

function displayCode(number) {
  const text = String(number ?? "");
  if (!text.includes("_")) return text;
  const [product, local] = text.split(/_(.+)/);
  return `${product}/${local}`;
}

function localCode(number) {
  return String(number ?? "").split("_").at(-1).split("/").at(-1);
}

function normalizeCode(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[\\/]+/g, "_")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function option(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function requiredOption(flag) {
  const value = option(flag);
  if (!value) throw new Error(`Missing required option: ${flag}`);
  return value;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function output(value) {
  console.log(JSON.stringify(value, null, 2));
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function printHelp() {
  console.log(`Usage:
  node tools/ai-engine.mjs cards [--query text] [--source UE15BT] [--limit 20]
  node tools/ai-engine.mjs card --id UE15BT/EVA-1-033
  node tools/ai-engine.mjs decks
  node tools/ai-engine.mjs deck --id eva-user-main
  node tools/ai-engine.mjs new-game --p1 deck-id --p2 deck-id [--seed n] [--random-seed] [--no-validate] [--out path]
  node tools/ai-engine.mjs state --state path [--full]
  node tools/ai-engine.mjs legal-actions --state path --player P1
  node tools/ai-engine.mjs apply-action --state path --action '{"type":"advancePhase","player":"P1"}'

All command output is JSON.`);
}
