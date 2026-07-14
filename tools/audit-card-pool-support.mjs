#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { cleanUnionArenaText } from "../src/effect-text.js";

const catalogIn = valueAfter("--catalog-in") ?? "work/private/egman-unionarena-catalog.json";
const rawIn = valueAfter("--raw-in") ?? "work/private/egman-unionarena-raw.json";
const gameSource = valueAfter("--game-source") ?? "src/game.js";
const simulationSource = valueAfter("--simulation-source") ?? "src/simulation.js";
const out = valueAfter("--out") ?? "work/private/audits/card-pool-support-audit.json";
const allowUnsupported = process.argv.includes("--allow-unsupported");

if (process.argv.includes("--help")) {
  console.log(`Usage:
  node tools/audit-card-pool-support.mjs [--raw-in path] [--catalog-in path] [--out path] [--allow-unsupported]

Scans the normalized private card catalog and fails if an encoded effect kind lacks
runtime support in src/game.js or pilot scoring support in src/simulation.js. It also
fails when meaningful printed effect text has no structured card representation.`);
  process.exit(0);
}

const catalogPayload = JSON.parse(readFileSync(catalogIn, "utf8"));
const catalog = catalogPayload.cards ?? catalogPayload;
const rawCards = JSON.parse(readFileSync(rawIn, "utf8"));
const gameJs = readFileSync(gameSource, "utf8");
const simulationJs = readFileSync(simulationSource, "utf8");

const effectKinds = {};
const cardsByEffectKind = {};
for (const card of Object.values(catalog)) {
  const kinds = new Set();
  collectCardEffectKinds(card, kinds);
  for (const kind of kinds) {
    effectKinds[kind] = (effectKinds[kind] ?? 0) + 1;
    cardsByEffectKind[kind] = cardsByEffectKind[kind] ?? [];
    if (cardsByEffectKind[kind].length < 25) {
      cardsByEffectKind[kind].push({
        id: card.id,
        number: card.number,
        name: card.name
      });
    }
  }
}

const runtimeCases = switchCases(
  functionBody(gameJs, gameJs.includes("function resolveEffectBody(") ? "resolveEffectBody" : "resolveEffect")
);
const pilotScoreCases = switchCases(functionBody(simulationJs, "effectScore"));
const encodedKinds = Object.keys(effectKinds).filter((kind) => kind !== "none").sort();
const runtimeMissing = encodedKinds.filter((kind) => !runtimeCases.has(kind));
const pilotScoreMissing = encodedKinds.filter((kind) => !pilotScoreCases.has(kind));
const unsupportedCards = cardsByEffectKind.unsupported ?? [];
const textWithoutStructure = rawCards
  .filter((card) => String(card.category).toLowerCase() !== "action point")
  .filter((card) => cleanUnionArenaText(card.effect))
  .map((card) => ({ card, def: catalog[sanitizeId(card.card_code ?? card.id)] }))
  .filter(({ def }) => !hasStructuredEffectRepresentation(def))
  .map(({ card }) => ({
    id: sanitizeId(card.card_code ?? card.id),
    number: card.card_code,
    name: card.name
  }));

const report = {
  summary: {
    catalogIn,
    rawIn,
    auditedAt: new Date().toISOString(),
    cardCount: Object.keys(catalog).length,
    encodedEffectKinds: encodedKinds.length,
    runtimeCaseCount: runtimeCases.size,
    pilotScoreCaseCount: pilotScoreCases.size,
    runtimeMissingCount: runtimeMissing.length,
    pilotScoreMissingCount: pilotScoreMissing.length,
    unsupportedCardCount: unsupportedCards.length,
    textWithoutStructureCount: textWithoutStructure.length
  },
  effectKinds,
  runtimeMissing: withExamples(runtimeMissing),
  pilotScoreMissing: withExamples(pilotScoreMissing),
  unsupportedCards,
  textWithoutStructure
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

console.log(`Audited ${report.summary.cardCount} cards and ${report.summary.encodedEffectKinds} encoded effect kind(s).`);
console.log(`Runtime missing: ${runtimeMissing.length}. Pilot scoring missing: ${pilotScoreMissing.length}. Unsupported cards: ${unsupportedCards.length}. Text-only cards: ${textWithoutStructure.length}.`);
console.log(`Report: ${out}`);

if (runtimeMissing.length > 0 || pilotScoreMissing.length > 0 || textWithoutStructure.length > 0 || (!allowUnsupported && unsupportedCards.length > 0)) {
  process.exitCode = 1;
}

function sanitizeId(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function hasStructuredEffectRepresentation(def) {
  if (!def) return false;
  const arrays = [
    "alternateNames",
    "abilities",
    "staticModifiers",
    "staticFieldModifiers",
    "staticEnergyModifiers",
    "staticKeywordModifiers",
    "staticFieldKeywordModifiers",
    "useCostModifiers",
    "staticUseCostModifiers",
    "choiceModeAssists",
    "triggerReplacements",
    "gainsBaseAbilityTimings",
    "lineCapacityModifiers",
    "targetingRestrictions",
    "abilityProtections",
    "raidTargetPermissions",
    "selfTriggerAlternatives"
  ];
  if (arrays.some((key) => def[key]?.length > 0)) return true;
  if (def.eventEffect || def.whenUsingEffect || def.raid || def.raidUseCondition
    || def.frontLineEntryCondition || def.entersActiveCondition || def.opponentAbilityLeaveReplacement) return true;
  if (Object.keys(def.keywords ?? {}).length > 0) return true;
  return [
    "raidOnlyPlay",
    "returnRaidStackToHandOnReturn",
    "sidelineTopRaidCardInstead",
    "battleLosersToRemovalInstead",
    "battleLosersToEnergyInstead",
    "freeExtraDrawFromFrontLine",
    "returnToHandHandSidelineInstead",
    "topRaidCardToSidelineInsteadOnOpponentLeave",
    "sidelineInsteadForFrontGoreinu",
    "moveToEnergyInsteadOnOpponentAbilityLeave",
    "moveToEnergyInsteadOnOpponentAbilityBpReduction",
    "cannotEnterFrontLine",
    "cannotEnterEnergyLine",
    "cannotPlayToFrontLine",
    "cannotPlayToEnergyLine",
    "cannotMoveDuringMovementPhase",
    "frontLineMoveByOwnAbilityOnly",
    "opponentAbilityRemovalProtection",
    "abilityReturnToHandProtection",
    "entersActive"
  ].some((key) => def[key]);
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function collectCardEffectKinds(card, kinds) {
  walkEffect(card.eventEffect, kinds);
  walkEffect(card.whenUsingEffect, kinds);
  walkEffect(card.trigger?.effect, kinds);
  for (const ability of card.abilities ?? []) walkEffect(ability.effect, kinds);
  for (const replacement of card.triggerReplacements ?? []) walkEffect(replacement.effect, kinds);
}

function walkEffect(effect, kinds) {
  if (!effect || typeof effect !== "object") return;
  if (effect.kind) kinds.add(effect.kind);
  for (const key of ["effect", "elseEffect", "costEffect", "baseEffect", "upgradedEffect", "ifMovedEffect", "insteadEffect"]) {
    walkEffect(effect[key], kinds);
  }
  for (const child of effect.effects ?? []) walkEffect(child, kinds);
  for (const choice of effect.choices ?? []) walkEffect(choice.effect, kinds);
  for (const tier of effect.tiers ?? []) {
    for (const child of tier.effects ?? []) walkEffect(child, kinds);
  }
  walkEffect(effect.ability?.effect, kinds);
}

function functionBody(source, functionName) {
  const declaration = new RegExp(`function\\s+${functionName}\\s*\\([^)]*\\)\\s*\\{`).exec(source);
  if (!declaration) throw new Error(`Could not find function ${functionName}.`);
  const open = declaration.index + declaration[0].lastIndexOf("{");
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  throw new Error(`Could not parse function ${functionName}.`);
}

function switchCases(source) {
  return new Set([...source.matchAll(/case\s+["']([^"']+)["']/g)].map((match) => match[1]));
}

function withExamples(kinds) {
  return kinds.map((kind) => ({
    kind,
    cardCount: effectKinds[kind] ?? 0,
    examples: cardsByEffectKind[kind] ?? []
  }));
}
