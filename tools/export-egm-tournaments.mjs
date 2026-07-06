#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { slugifyDeckName } from "../src/deck-import.js";

const DEFAULT_GAME = "unionarena";
const DEFAULT_FORMAT = "Q1-2026";
const DEFAULT_OUT_ROOT = "work/private/deck-imports/egm-q1-2026-regionals";

const game = option("--game") ?? DEFAULT_GAME;
const format = option("--format") ?? DEFAULT_FORMAT;
const outRoot = option("--out-root") ?? DEFAULT_OUT_ROOT;
const manifestPath = option("--manifest") ?? join(outRoot, "manifest.csv");
const requestedIds = parseList(option("--ids"));

if (hasFlag("--help")) {
  usage();
  process.exit(0);
}

const endpoint = `https://deckbuilder.egmanevents.com/api/tournaments/${encodeURIComponent(game)}?format=${encodeURIComponent(format)}`;
const tournaments = await fetchJson(endpoint);
const selected = selectTournaments(tournaments, requestedIds);
const rows = [];

for (const tournament of selected) {
  const location = inferLocation(tournament);
  const results = [...(tournament.tournament_results ?? [])]
    .filter((result) => firstDeckUrl(result))
    .sort((a, b) => Number(a.result_order ?? a.placement ?? 9999) - Number(b.result_order ?? b.placement ?? 9999));

  for (const result of results) {
    const player = clean(result.player_name) || "Unknown Player";
    const placement = clean(result.placement ?? result.result_order) || String(rows.length + 1);
    const deckType = clean(result.deck_type);
    const deckUrl = firstDeckUrl(result);
    const entries = parseDeckUrl(deckUrl);
    const deckName = `${player} ${placement} ${location}`;
    const suggestedId = slugifyDeckName(`${player} ${placement} ${location}`);
    const file = join(safeFileName(location), `${safeFileName(`${placement}_${player}_${deckType || "deck"}`)}.txt`);
    const text = [
      `// Deck Name: ${deckName}`,
      `// Player: ${player}`,
      `// Placement: ${placement}`,
      `// Event Location: ${location}`,
      `// Event: ${clean(tournament.tournament_name)}`,
      `// Event Date: ${clean(tournament.start_date)}`,
      deckType ? `// Deck Type: ${deckType}` : undefined,
      `// Source URL: ${deckUrl}`,
      "",
      "// Main Deck",
      ...entries.map((entry) => `${entry.count} x ${entry.code}`)
    ].filter((line) => line !== undefined).join("\n");

    writeText(join(outRoot, file), `${text}\n`);
    rows.push({
      deck_name: deckName,
      player,
      placement,
      location,
      event: clean(tournament.tournament_name),
      event_date: clean(tournament.start_date),
      main_deck_count: String(entries.reduce((total, entry) => total + entry.count, 0)),
      file,
      suggested_id: suggestedId,
      deck_type: deckType,
      deck_list_url: deckUrl,
      tournament_id: clean(tournament.id)
    });
  }
}

writeCsv(manifestPath, rows);
console.log(`Exported ${rows.length} decklist(s) from ${selected.length} tournament(s).`);
console.log(`Manifest: ${manifestPath}`);
console.log(`Root: ${outRoot}`);

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "union-arena-local-engine/0.1 private tournament importer"
    }
  });
  if (!response.ok) throw new Error(`EGM tournament fetch failed: ${response.status} ${response.statusText}`);
  return response.json();
}

function selectTournaments(tournaments, ids) {
  const all = Array.isArray(tournaments) ? tournaments : [];
  if (!ids || ids.length === 0) return all;
  const allowed = new Set(ids);
  const selected = all.filter((tournament) => allowed.has(tournament.id));
  const found = new Set(selected.map((tournament) => tournament.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) throw new Error(`Tournament id(s) not found: ${missing.join(", ")}`);
  return selected;
}

function inferLocation(tournament) {
  const explicit = clean(tournament.location);
  if (explicit) return explicit;
  const name = clean(tournament.tournament_name).toLowerCase();
  if (name.includes("peoria")) return "Peoria Illinois";
  if (name.includes("florida") || name.includes("orlando")) return "Orlando Florida";
  if (name.includes("montreal")) return "Montreal";
  if (name.includes("virginia")) return "Virginia";
  return "Unknown";
}

function firstDeckUrl(result) {
  const urls = Array.isArray(result.deck_list_url) ? result.deck_list_url : [result.deck_list_url];
  return urls.find(Boolean);
}

function parseDeckUrl(url) {
  const deck = new URL(url).searchParams.get("deck");
  if (!deck) throw new Error(`Deck URL has no deck parameter: ${url}`);
  return deck.split(",").filter(Boolean).map((entry) => {
    const [code, count] = entry.split(":");
    const parsedCount = Number(count);
    if (!code || !Number.isInteger(parsedCount) || parsedCount <= 0) {
      throw new Error(`Invalid deck entry "${entry}" in ${url}`);
    }
    return { code, count: parsedCount };
  });
}

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function writeCsv(path, rows) {
  const headers = [
    "deck_name",
    "player",
    "placement",
    "location",
    "event",
    "event_date",
    "main_deck_count",
    "file",
    "suggested_id",
    "deck_type",
    "deck_list_url",
    "tournament_id"
  ];
  const lines = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))
  ];
  writeText(path, `${lines.join("\n")}\n`);
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

function safeFileName(value) {
  return String(value ?? "deck")
    .trim()
    .replace(/[^A-Za-z0-9._ -]+/g, "")
    .replace(/\s+/g, "_")
    .replace(/^_+|_+$/g, "")
    || "deck";
}

function clean(value) {
  return String(value ?? "").trim();
}

function parseList(value) {
  if (!value) return undefined;
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
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
  node tools/export-egm-tournaments.mjs --format Q1-2026 --ids id1,id2 [--out-root work/private/deck-imports/egm-q1-2026-regionals]

Exports EGM tournament deckbuilder URLs to local deck text files plus a manifest for tools/import-deck-folder.mjs.`);
}
