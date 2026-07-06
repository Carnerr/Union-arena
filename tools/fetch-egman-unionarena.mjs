#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { normalizeCatalog, parseKeywordEffects, validateCatalog } from "../src/catalog.js";
import { cleanUnionArenaText, encodeEgmanCardText } from "../src/effect-text.js";

const ENDPOINT = "https://deckbuilder.egmanevents.com/api/cards/unionarena";
const IMAGE_BASE = "https://deckbuilder.egmanevents.com/assets/cards/unionarena";

const args = new Set(process.argv.slice(2));
const rawIn = valueAfter("--raw-in");
const rawOut = valueAfter("--raw-out") ?? "work/private/egman-unionarena-raw.json";
const catalogOut = valueAfter("--catalog-out") ?? "work/private/egman-unionarena-catalog.json";
const includeImageUrls = args.has("--include-image-urls");

if (args.has("--help")) {
  console.log(`Usage:
  node tools/fetch-egman-unionarena.mjs [--include-image-urls] [--raw-in path] [--raw-out path] [--catalog-out path]

Fetches Union Arena card JSON from:
  ${ENDPOINT}

Use --raw-in to rebuild an encoded catalog from a previously saved raw JSON file without network access.

Outputs:
  Raw source JSON:       ${rawOut}
  Engine catalog JSON:   ${catalogOut}

Notes:
  - This fetches text/card metadata only by default.
  - Image files are not downloaded.
  - Use the output privately and respect the source site's terms and the underlying card IP.`);
  process.exit(0);
}

const rawCards = rawIn ? JSON.parse(readFileSync(rawIn, "utf8")) : await fetchCards();
if (!Array.isArray(rawCards)) {
  throw new Error("Expected EGM card endpoint to return an array.");
}

const rows = rawCards.map(toImportRow);
const catalog = normalizeCatalog(rows);
validateCatalog(catalog);

writeJson(rawOut, rawCards);
writeJson(catalogOut, {
  source: ENDPOINT,
  fetchedAt: new Date().toISOString(),
  cardCount: Object.keys(catalog).length,
  cards: catalog
});

const sets = new Set(rawCards.map((card) => card.set).filter(Boolean));
console.log(`Fetched ${rawCards.length} EGM Union Arena rows.`);
console.log(`Normalized ${Object.keys(catalog).length} engine cards across ${sets.size} set labels.`);
console.log(`Raw: ${rawOut}`);
console.log(`Catalog: ${catalogOut}`);

async function fetchCards() {
  const response = await fetch(ENDPOINT, {
    headers: {
      "accept": "application/json",
      "user-agent": "union-arena-local-engine/0.1 private catalog importer"
    }
  });

  if (!response.ok) {
    throw new Error(`EGM fetch failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function toImportRow(card) {
  const color = firstValue(card.color);
  const affinity = Array.isArray(card.affinity) ? card.affinity.join("; ") : card.affinity ?? "";
  const effect = cleanUnionArenaText(card.effect);
  const trigger = cleanUnionArenaText(card.trigger);
  const keywordEffect = [effect, trigger].join(" ");
  const encoded = encodeEgmanCardText(card).fields;
  const keywords = { ...parseKeywordEffects(keywordEffect), ...(encoded.keywords ?? {}) };
  const row = {
    id: sanitizeId(card.card_code ?? card.id),
    cardNumber: card.card_code,
    cardName: card.name,
    cardType: card.category ?? card.type,
    title: card.set,
    sourceCode: card.set_code ?? sourceCodeFromCardCode(card.card_code),
    cardColor: color,
    requiredEnergy: card.energy ?? 0,
    apCost: card.ap_cost ?? 0,
    BP: card.bp ?? 0,
    generatedEnergy: color && card.generated_energy ? `${color}:${card.generated_energy}` : "",
    affinity,
    keywords,
    keywordEffect,
    triggerEffect: encoded.triggerEffect ?? trigger,
    rarity: card.rarity,
    product: card.set,
    eventEffect: encoded.eventEffect ?? "",
    whenUsingEffect: encoded.whenUsingEffect,
    entersActiveOnUseEffect: encoded.entersActiveOnUseEffect ?? false,
    abilities: encoded.abilities ?? [],
    staticModifiers: encoded.staticModifiers ?? [],
    staticFieldModifiers: encoded.staticFieldModifiers ?? [],
    staticEnergyModifiers: encoded.staticEnergyModifiers ?? [],
    staticKeywordModifiers: encoded.staticKeywordModifiers ?? [],
    staticFieldKeywordModifiers: encoded.staticFieldKeywordModifiers ?? [],
    useCostModifiers: encoded.useCostModifiers ?? [],
    staticUseCostModifiers: encoded.staticUseCostModifiers ?? [],
    choiceModeAssists: encoded.choiceModeAssists ?? [],
    triggerReplacements: encoded.triggerReplacements ?? [],
    gainsBaseAbilityTimings: encoded.gainsBaseAbilityTimings ?? [],
    returnRaidStackToHandOnReturn: encoded.returnRaidStackToHandOnReturn ?? false,
    sidelineTopRaidCardInstead: encoded.sidelineTopRaidCardInstead ?? false,
    battleLosersToRemovalInstead: encoded.battleLosersToRemovalInstead ?? false,
    returnToHandHandSidelineInstead: encoded.returnToHandHandSidelineInstead ?? false,
    topRaidCardToSidelineInsteadOnOpponentLeave: encoded.topRaidCardToSidelineInsteadOnOpponentLeave ?? false,
    topRaidReplacementBaseRequiredEnergyMin: encoded.topRaidReplacementBaseRequiredEnergyMin,
    sidelineInsteadForFrontGoreinu: encoded.sidelineInsteadForFrontGoreinu ?? false,
    moveToEnergyInsteadOnOpponentAbilityLeave: encoded.moveToEnergyInsteadOnOpponentAbilityLeave ?? false,
    moveToEnergyInsteadOnOpponentAbilityBpReduction: encoded.moveToEnergyInsteadOnOpponentAbilityBpReduction ?? false,
    cannotEnterFrontLine: encoded.cannotEnterFrontLine ?? false,
    entersActive: encoded.entersActive ?? false,
    entersActiveCondition: encoded.entersActiveCondition,
    raid: encoded.raid
  };

  if (includeImageUrls) {
    row.imageUrls = (card._imagePaths ?? [])
      .map((imagePath) => `${IMAGE_BASE}/${imagePath}`);
  }

  return row;
}

function firstValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function cleanText(value) {
  if (!value || value === "-") return "";
  return String(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/ã»/g, "- ")
    .replace(/Ã/g, "x")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function sanitizeId(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function sourceCodeFromCardCode(value) {
  const text = String(value ?? "");
  const local = text.includes("_") ? text.split("_").at(-1) : text;
  return local.slice(0, 3).toUpperCase();
}
