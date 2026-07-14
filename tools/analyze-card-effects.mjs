#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { encodeEgmanCardText } from "../src/effect-text.js";

const rawIn = valueAfter("--raw-in") ?? "work/private/egman-unionarena-raw.json";
const out = valueAfter("--out") ?? "work/private/effect-coverage.json";

if (process.argv.includes("--help")) {
  console.log(`Usage:
  node tools/analyze-card-effects.mjs [--raw-in path] [--out path]

Reads private EGM raw card data, runs the local text encoder, and writes a private coverage report.`);
  process.exit(0);
}

const rawCards = JSON.parse(readFileSync(rawIn, "utf8"));
const cards = rawCards.filter((card) => String(card.category).toLowerCase() !== "action point");

const summary = {
  source: rawIn,
  analyzedAt: new Date().toISOString(),
  cardCount: cards.length,
  cardsWithEffectText: 0,
  cardsWithTriggerText: 0,
  cardsWithEncodedAbilities: 0,
  cardsWithEncodedEvents: 0,
  cardsWithStaticModifiers: 0,
  cardsWithRaid: 0,
  cardsWithUnsupportedFragments: 0,
  effectKinds: {},
  triggerTypes: {},
  unsupportedReasons: {}
};

const unsupportedCards = [];

for (const card of cards) {
  const encoded = encodeEgmanCardText(card);
  const fields = encoded.fields;
  const coverage = encoded.coverage;

  if (coverage.hasEffectText) summary.cardsWithEffectText += 1;
  if (coverage.hasTriggerText) summary.cardsWithTriggerText += 1;
  if ((fields.abilities ?? []).length > 0) summary.cardsWithEncodedAbilities += 1;
  if (fields.eventEffect) summary.cardsWithEncodedEvents += 1;
  if ((fields.staticModifiers ?? []).length > 0) summary.cardsWithStaticModifiers += 1;
  if (fields.raid) summary.cardsWithRaid += 1;
  if (fields.triggerEffect?.type) increment(summary.triggerTypes, fields.triggerEffect.type);

  for (const ability of fields.abilities ?? []) collectEffectKinds(ability.effect, summary.effectKinds);
  if (fields.eventEffect) collectEffectKinds(fields.eventEffect, summary.effectKinds);
  if (fields.triggerEffect?.effect) collectEffectKinds(fields.triggerEffect.effect, summary.effectKinds);

  if (coverage.unsupported.length > 0) {
    summary.cardsWithUnsupportedFragments += 1;
    for (const item of coverage.unsupported) increment(summary.unsupportedReasons, item.reason ?? "unknown");
    unsupportedCards.push({
      code: card.card_code,
      name: card.name,
      category: card.category,
      unsupported: coverage.unsupported
    });
  }
}

const report = {
  summary,
  unsupportedCards
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

console.log(`Analyzed ${summary.cardCount} non-AP cards.`);
console.log(`Encoded abilities on ${summary.cardsWithEncodedAbilities} cards and event effects on ${summary.cardsWithEncodedEvents} cards.`);
console.log(`Encoded ${summary.cardsWithRaid} Raid definitions and ${summary.cardsWithStaticModifiers} static modifier card(s).`);
console.log(`Cards with unsupported fragments: ${summary.cardsWithUnsupportedFragments}.`);
console.log(`Report: ${out}`);

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function collectEffectKinds(effect, counts) {
  if (!effect) return;
  increment(counts, effect.kind ?? "unknown");
  for (const key of ["effect", "elseEffect", "baseEffect", "costEffect", "insteadEffect", "upgradedEffect", "ifMovedEffect", "successEffect"]) {
    collectEffectKinds(effect[key], counts);
  }
  for (const child of effect.effects ?? []) collectEffectKinds(child, counts);
  for (const choice of effect.choices ?? []) collectEffectKinds(choice.effect, counts);
}

function increment(record, key) {
  record[key] = (record[key] ?? 0) + 1;
}
