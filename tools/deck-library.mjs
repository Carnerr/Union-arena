#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { loadCatalogJson } from "../src/loaders.js";
import { displayCardCode, makeSavedDeck, parseDeckText, slugifyDeckName } from "../src/deck-import.js";

const DEFAULT_CATALOG = "work/private/egman-unionarena-catalog.json";
const DEFAULT_LIBRARY = "work/private/decks";

const [, , command, ...rest] = process.argv;

if (!command || command === "--help" || command === "help") {
  usage();
  process.exit(command ? 0 : 1);
}

try {
  if (command === "import") importDeck(rest);
  else if (command === "list") listDecks(rest);
  else if (command === "show") showDeck(rest);
  else {
    console.error(`Unknown command: ${command}`);
    usage();
    process.exit(1);
  }
} catch (error) {
  console.error(error.message);
  if (error.details) console.error(JSON.stringify(error.details, null, 2));
  process.exit(1);
}

function importDeck(args) {
  const inputPath = firstPositional(args);
  if (!inputPath) throw new Error("Usage: node tools/deck-library.mjs import <deck.txt> --name \"Deck Name\"");

  const catalogPath = option(args, "--catalog") ?? DEFAULT_CATALOG;
  const libraryDir = option(args, "--library") ?? DEFAULT_LIBRARY;
  const name = option(args, "--name") ?? nameFromPath(inputPath);
  const id = option(args, "--id") ?? slugifyDeckName(name);
  const outputPath = option(args, "--out") ?? join(libraryDir, `${id}.json`);
  const validate = !args.includes("--no-validate");

  const catalog = loadCatalogJson(catalogPath);
  const text = readFileSync(inputPath, "utf8");
  const parsed = parseDeckText(text, catalog, { validate });
  const saved = makeSavedDeck({
    id,
    name,
    cards: parsed.cards,
    summary: parsed.summary,
    validation: parsed.validation,
    source: {
      inputPath,
      catalogPath
    }
  });

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(saved, null, 2)}\n`);

  console.log(`Saved deck "${saved.name}" as ${saved.id}.`);
  console.log(`Cards: ${saved.validation?.size ?? saved.summary?.size ?? parsed.cards.reduce((total, card) => total + card.count, 0)}`);
  if (saved.validation) {
    console.log(`Source code: ${saved.validation.sourceCode}`);
    console.log(`Unique card numbers: ${saved.validation.uniqueCardNumbers}`);
  }
  console.log(`Path: ${outputPath}`);
}

function listDecks(args) {
  const libraryDir = option(args, "--library") ?? DEFAULT_LIBRARY;
  if (!existsSync(libraryDir)) {
    console.log(`No deck library found at ${libraryDir}`);
    return;
  }

  const decks = readSavedDecks(libraryDir);
  if (decks.length === 0) {
    console.log(`No saved decks in ${libraryDir}`);
    return;
  }

  for (const deck of decks) {
    const size = deck.validation?.size ?? deck.summary?.size ?? deck.cards?.reduce((total, card) => total + card.count, 0) ?? 0;
    const source = deck.validation?.sourceCode ?? deck.summary?.sourceCode ?? "unknown";
    const status = deck.validation ? "valid" : "not validated";
    console.log(`${deck.id}\t${deck.name}\t${size} cards\t${source}\t${status}`);
  }
}

function showDeck(args) {
  const deckId = firstPositional(args);
  if (!deckId) throw new Error("Usage: node tools/deck-library.mjs show <deck-id>");
  const libraryDir = option(args, "--library") ?? DEFAULT_LIBRARY;
  const path = join(libraryDir, `${deckId}.json`);
  if (!existsSync(path)) throw new Error(`Saved deck not found: ${path}`);

  const deck = JSON.parse(readFileSync(path, "utf8"));
  console.log(`${deck.name} (${deck.id})`);
  const summary = deck.validation ?? deck.summary;
  if (summary) {
    console.log(`${summary.size} cards, source ${summary.sourceCode ?? "unknown"}, ${summary.uniqueCardNumbers} unique card numbers`);
  }
  if (!deck.validation) console.log("Not validated for deck construction rules.");
  for (const card of deck.cards ?? []) {
    console.log(`${card.count} x ${displayCardCode(card.number ?? card.id)}\t${card.name ?? card.id}`);
  }
}

function readSavedDecks(libraryDir) {
  return readdirSync(libraryDir)
    .filter((file) => file.toLowerCase().endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(join(libraryDir, file), "utf8")))
    .filter((deck) => deck.schema === "union-arena-local-engine/deck@1" || (deck.id && Array.isArray(deck.cards)))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function option(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function firstPositional(args) {
  return args.find((arg, index) => {
    if (arg.startsWith("--")) return false;
    if (index > 0 && args[index - 1].startsWith("--")) return false;
    return true;
  });
}

function nameFromPath(path) {
  return basename(path, extname(path))
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function usage() {
  console.log(`Usage:
  node tools/deck-library.mjs import <deck.txt> --name "Deck Name" [--id deck-id] [--catalog path] [--library dir] [--out path] [--no-validate]
  node tools/deck-library.mjs list [--library dir]
  node tools/deck-library.mjs show <deck-id> [--library dir]

Default catalog: ${DEFAULT_CATALOG}
Default library: ${DEFAULT_LIBRARY}`);
}
