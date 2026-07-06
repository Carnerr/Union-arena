#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { cleanUnionArenaText } from "../src/effect-text.js";

const rawIn = valueAfter("--raw-in") ?? "work/private/egman-unionarena-raw.json";
const catalogIn = valueAfter("--catalog-in") ?? "work/private/egman-unionarena-catalog.json";
const out = valueAfter("--out") ?? "work/private/audits/cost-and-restriction-gap-audit.json";

if (process.argv.includes("--help")) {
  console.log(`Usage:
  node tools/audit-cost-restriction-gaps.mjs [--raw-in path] [--catalog-in path] [--out path]

Finds raw card text that mentions card-use cost modifiers or use restrictions but does
not appear to have a corresponding structured engine encoding.`);
  process.exit(0);
}

const rawCards = JSON.parse(readFileSync(rawIn, "utf8"));
const catalogPayload = JSON.parse(readFileSync(catalogIn, "utf8"));
const catalog = catalogPayload.cards ?? catalogPayload;

const summary = {
  source: { rawIn, catalogIn },
  auditedAt: new Date().toISOString(),
  rawCardCount: rawCards.length,
  cardCount: 0,
  categoryCounts: {},
  gapCounts: {}
};

const cards = [];

for (const raw of rawCards) {
  if (String(raw.category).toLowerCase() === "action point") continue;
  summary.cardCount += 1;

  const def = catalog[sanitizeId(raw.card_code ?? raw.id)];
  const effect = normalizeText(raw.effect);
  if (!effect) continue;

  const categories = classify(effect);
  if (categories.length === 0) continue;

  const encoded = describeEncoding(def);
  const gaps = categories.filter((category) => !categoryEncoded(category, encoded));
  for (const category of categories) increment(summary.categoryCounts, category.kind);
  for (const gap of gaps) increment(summary.gapCounts, gap.kind);
  if (gaps.length === 0) continue;

  cards.push({
    code: raw.card_code,
    name: raw.name,
    category: raw.category,
    color: firstValue(raw.color),
    categories,
    gaps,
    encoded,
    snippets: snippetsFor(effect, categories.map((category) => category.pattern))
  });
}

const report = {
  summary,
  cards
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

console.log(`Audited ${summary.cardCount} non-AP cards.`);
console.log(`Detected cost/restriction text on ${Object.values(summary.categoryCounts).reduce((a, b) => a + b, 0)} category hit(s).`);
console.log(`Cards with apparent gaps: ${cards.length}.`);
for (const [kind, count] of Object.entries(summary.gapCounts)) {
  console.log(`  ${kind}: ${count}`);
}
console.log(`Report: ${out}`);

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function firstValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function sanitizeId(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeText(value) {
  return cleanUnionArenaText(value)
    .replace(/ÃƒÂ—|Ã—|×/g, "x")
    .replace(/ÃƒÂ£Ã‚Æ’Ã‚Â»|Ã£ÂƒÂ»|・/g, "- ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function classify(text) {
  const categories = [];
  if (/reduce this card's required energy\b/.test(text)) {
    categories.push({ kind: "staticRequiredEnergyReduction", pattern: "reduce this card's required energy" });
  }
  if (/reduce this card's ap cost\b/.test(text)) {
    categories.push({ kind: "staticApCostReduction", pattern: "reduce this card's ap cost" });
  }
  if (/reduce the required energy\b/.test(text)) {
    categories.push({ kind: "effectRequiredEnergyReduction", pattern: "reduce the required energy" });
  }
  if (/reduce the ap cost\b/.test(text)) {
    categories.push({ kind: "effectApCostReduction", pattern: "reduce the ap cost" });
  }
  if (/you cannot use this card\b/.test(text)) {
    categories.push({ kind: "cannotUseRestriction", pattern: "you cannot use this card" });
  }
  if (/you can only use this card\b/.test(text)) {
    categories.push({ kind: "onlyUseRestriction", pattern: "you can only use this card" });
  }
  if (/can only be played from your hand\b/.test(text)) {
    categories.push({ kind: "onlyPlayedFromHandRestriction", pattern: "can only be played from your hand" });
  }
  return categories;
}

function describeEncoding(def) {
  const effectKinds = [];
  walkEffectTree(def?.eventEffect, (effect) => effectKinds.push(effect.kind));
  for (const ability of def?.abilities ?? []) walkEffectTree(ability.effect, (effect) => effectKinds.push(effect.kind));
  return {
    hasDefinition: Boolean(def),
    useCostModifiers: (def?.useCostModifiers ?? []).map((modifier) => ({
      kind: modifier.kind,
      amount: modifier.amount,
      sourceZone: modifier.sourceZone,
      sourceZones: modifier.sourceZones,
      condition: modifier.condition
    })),
    staticUseCostModifiers: (def?.staticUseCostModifiers ?? []).map((modifier) => ({
      kind: modifier.kind,
      amount: modifier.amount,
      sourceZone: modifier.sourceZone,
      sourceZones: modifier.sourceZones,
      filter: modifier.filter,
      condition: modifier.condition
    })),
    useRestrictionCount: effectKinds.filter((kind) => kind === "replacementOrUseRestriction").length,
    effectKinds
  };
}

function categoryEncoded(category, encoded) {
  switch (category.kind) {
    case "staticRequiredEnergyReduction":
      return encoded.useCostModifiers.some((modifier) => modifier.kind === "requiredEnergy");
    case "staticApCostReduction":
      return encoded.useCostModifiers.some((modifier) => modifier.kind === "apCost");
    case "effectRequiredEnergyReduction":
      return encoded.effectKinds.includes("reduceRequiredEnergy")
        || encoded.staticUseCostModifiers.some((modifier) => modifier.kind === "requiredEnergy");
    case "effectApCostReduction":
      return encoded.effectKinds.includes("reduceNextUseApCost");
    case "cannotUseRestriction":
    case "onlyUseRestriction":
    case "onlyPlayedFromHandRestriction":
      return encoded.useRestrictionCount > 0;
    default:
      return false;
  }
}

function walkEffectTree(effect, callback) {
  if (!effect || typeof effect !== "object") return;
  callback(effect);
  if (effect.effect) walkEffectTree(effect.effect, callback);
  if (effect.elseEffect) walkEffectTree(effect.elseEffect, callback);
  for (const child of effect.effects ?? []) walkEffectTree(child, callback);
  for (const choice of effect.choices ?? []) walkEffectTree(choice.effect, callback);
}

function snippetsFor(text, patterns) {
  const sentences = text.split(/(?<=\.)\s+/);
  return [...new Set(patterns.flatMap((pattern) => {
    const found = sentences.filter((sentence) => sentence.includes(pattern));
    if (found.length > 0) return found;
    const index = text.indexOf(pattern);
    if (index === -1) return [];
    return [text.slice(Math.max(0, index - 120), Math.min(text.length, index + 240)).trim()];
  }))];
}

function increment(record, key) {
  record[key] = (record[key] ?? 0) + 1;
}
