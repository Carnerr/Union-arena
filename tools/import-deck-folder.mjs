#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadCatalogJson } from "../src/loaders.js";
import { makeSavedDeck, parseDeckText, slugifyDeckName } from "../src/deck-import.js";

const DEFAULT_CATALOG = "work/private/egman-unionarena-catalog.json";
const DEFAULT_LIBRARY = "work/private/decks";

const manifestPath = requiredOption("--manifest");
const rootDir = option("--root") ?? dirname(manifestPath);
const catalogPath = option("--catalog") ?? DEFAULT_CATALOG;
const libraryDir = option("--library") ?? DEFAULT_LIBRARY;
const reportPath = option("--report") ?? join(libraryDir, "import-report.json");
const gauntletPath = option("--gauntlet");
const idPrefix = option("--id-prefix") ?? "";
const validate = !hasFlag("--no-validate");
const fallbackInvalid = hasFlag("--fallback-invalid");
const locationFilter = parseListOption("--locations");

const catalog = loadCatalogJson(catalogPath);
const rows = filterRowsByLocation(readCsv(manifestPath), locationFilter);
const imported = [];
const failed = [];

for (const row of rows) {
  const fallbackName = row.deck_name || row.name || row.file;
  const fallbackId = slugifyDeckName(`${idPrefix}${row.suggested_id || fallbackName}`);
  const inputPath = join(rootDir, row.file);

  try {
    const text = readFileSync(inputPath, "utf8");
    const parsed = parseDeckText(text, catalog, { validate });
    const { id, name } = deckIdentityForImport({ row, parsed, idPrefix, fallbackName, fallbackId });
    const outputPath = join(libraryDir, `${id}.json`);
    saveImportedDeck({ id, name, parsed, row, inputPath, outputPath });
  } catch (error) {
    if (fallbackInvalid && validate) {
      try {
        const text = readFileSync(inputPath, "utf8");
        const parsed = parseDeckText(text, catalog, { validate: false });
        const { id, name } = deckIdentityForImport({ row, parsed, idPrefix, fallbackName, fallbackId });
        const outputPath = join(libraryDir, `${id}.json`);
        saveImportedDeck({
          id,
          name,
          parsed,
          row,
          inputPath,
          outputPath,
          warning: {
            message: error.message,
            details: error.details
          }
        });
        continue;
      } catch (fallbackError) {
        failed.push({
          id: fallbackId,
          name: fallbackName,
          inputPath,
          message: fallbackError.message,
          details: fallbackError.details,
          validationMessage: error.message,
          validationDetails: error.details
        });
        console.error(`Failed ${fallbackId}: ${fallbackError.message}`);
        continue;
      }
    }

    failed.push({
      id: fallbackId,
      name: fallbackName,
      inputPath,
      message: error.message,
      details: error.details
    });
    console.error(`Failed ${fallbackId}: ${error.message}`);
  }
}

const report = {
  schema: "union-arena-local-engine/deck-folder-import@1",
  createdAt: new Date().toISOString(),
  manifestPath,
  rootDir,
  catalogPath,
  libraryDir,
  locations: locationFilter,
  validate,
  fallbackInvalid,
  importedCount: imported.length,
  importedValidatedCount: imported.filter((entry) => entry.validated).length,
  importedUnvalidatedCount: imported.filter((entry) => !entry.validated).length,
  failedCount: failed.length,
  imported,
  failed
};

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
if (gauntletPath) {
  mkdirSync(dirname(gauntletPath), { recursive: true });
  writeFileSync(gauntletPath, `${imported.map((entry) => entry.id).join("\n")}\n`);
}
console.log(`Imported: ${imported.length}`);
console.log(`Imported validated: ${report.importedValidatedCount}`);
console.log(`Imported unvalidated: ${report.importedUnvalidatedCount}`);
console.log(`Failed: ${failed.length}`);
console.log(`Report: ${reportPath}`);
if (gauntletPath) console.log(`Gauntlet: ${gauntletPath}`);

if (failed.length > 0) process.exitCode = 1;

function saveImportedDeck({ id, name, parsed, row, inputPath, outputPath, warning }) {
  const saved = makeSavedDeck({
    id,
    name,
    cards: parsed.cards,
    summary: parsed.summary,
    validation: parsed.validation,
    source: {
      inputPath,
      manifestPath,
      catalogPath,
        player: row.player,
        placement: row.placement,
        location: row.location,
        event: row.event,
        eventDate: row.event_date,
        deckType: row.deck_type,
        deckListUrl: row.deck_list_url,
        tournamentId: row.tournament_id,
        importWarning: warning
      }
  });

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(saved, null, 2)}\n`);
  imported.push({
    id,
    name,
    outputPath,
    sourceCode: saved.validation?.sourceCode ?? saved.summary?.sourceCode,
    colors: saved.summary?.colors,
    color: saved.summary?.color,
    size: saved.validation?.size ?? saved.summary?.size,
    event: row.event,
    location: row.location,
    placement: row.placement,
    deckType: row.deck_type,
    tournamentId: row.tournament_id,
    validated: Boolean(saved.validation),
    warning
  });
  console.log(`${warning ? "Imported unvalidated" : "Imported"} ${id}: ${name}`);
}

function deckIdentityForImport({ row, parsed, idPrefix, fallbackName, fallbackId }) {
  const setCode = parsed.validation?.sourceCode ?? parsed.summary?.sourceCode;
  const colorCode = deckColorCode(parsed.summary);
  const colorLabel = deckColorLabel(parsed.summary);

  if (!row.player || !row.placement || !row.location) {
    const tags = [setCode, colorLabel].filter(Boolean).join(" ");
    return {
      id: fallbackId,
      name: tags ? `[${tags}] ${fallbackName}` : fallbackName
    };
  }

  const id = slugifyDeckName(`${idPrefix}${[
    setCode,
    colorCode,
    row.player,
    row.placement,
    row.location
  ].filter(Boolean).join(" ")}`);
  const tags = [setCode, colorLabel].filter(Boolean).join(" ");
  return {
    id,
    name: `${tags ? `[${tags}] ` : ""}${row.player} ${row.placement} ${formatLocation(row.location)}`
  };
}

function deckColorCode(summary) {
  return (summary?.colors ?? []).join("-");
}

function deckColorLabel(summary) {
  return (summary?.colors ?? []).map(capitalize).join("/");
}

function capitalize(value) {
  const text = String(value ?? "");
  return text ? text[0].toUpperCase() + text.slice(1) : "";
}

function formatLocation(value) {
  return String(value ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

function filterRowsByLocation(rows, locations) {
  if (!locations || locations.length === 0) return rows;
  const allowed = new Set(locations.map(normalizeLocation));
  return rows.filter((row) => allowed.has(normalizeLocation(row.location)));
}

function readCsv(path) {
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines.shift());
  return lines.map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\"") {
      if (quoted && line[index + 1] === "\"") {
        current += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current);
  return values;
}

function option(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function parseListOption(flag) {
  const value = option(flag);
  if (!value) return undefined;
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function normalizeLocation(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
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

function usage() {
  console.log(`Usage:
  node tools/import-deck-folder.mjs --manifest path\\to\\manifest.csv [--root folder] [--library work\\private\\decks] [--id-prefix regional-] [--locations Virginia,PeoriaIllinois,OrlandoFlorida] [--gauntlet work\\private\\deck-gauntlets\\regional-last3.txt] [--fallback-invalid]

The manifest must include at least deck_name,file,suggested_id columns. Imports are validated by default.`);
}
