#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const rawIn = valueAfter("--raw-in") ?? "work/private/egman-unionarena-raw.json";
const catalogIn = valueAfter("--catalog-in") ?? "work/private/egman-unionarena-catalog.json";
const out = valueAfter("--out") ?? "work/private/audits/play-choice-semantics-audit.json";

const rawCards = JSON.parse(readFileSync(rawIn, "utf8"));
const catalogPayload = JSON.parse(readFileSync(catalogIn, "utf8"));
const catalog = Object.values(catalogPayload.cards ?? catalogPayload);
const byNumber = new Map(catalog.map((card) => [String(card.number ?? "").toUpperCase(), card]));
const destinationGaps = [];
const optionalCountGaps = [];

for (const raw of rawCards) {
  const card = byNumber.get(String(raw.card_code ?? "").toUpperCase());
  if (!card) continue;
  const text = relevantPlayText(raw.effect);
  if (!text) continue;
  const playEffects = cardEffects(card).filter((effect) => [
    "playCardFromZone",
    "playCardFromZoneMatchingTargetName",
    "playOrRaidCardFromZone",
    "playSourceFromZone"
  ].includes(effect.kind));
  if (/\bplay(?:s)?(?: up to)?\b[^.]{0,500}\bonto (?:your|their) field\b/i.test(text)
    && playEffects.length > 0
    && !playEffects.some((effect) => effect.destinationLines?.includes("frontLine") && effect.destinationLines?.includes("energyLine"))) {
    destinationGaps.push(example(raw, card, playEffects));
  }
  if (/\bplay(?:s)? up to (?:one|two)\b/i.test(text)
    && playEffects.length > 0
    && !playEffects.some((effect) => Number(effect.min) === 0)) {
    optionalCountGaps.push(example(raw, card, playEffects));
  }
}

const report = {
  auditedAt: new Date().toISOString(),
  rawIn,
  catalogIn,
  summary: {
    rawCards: rawCards.length,
    catalogCards: catalog.length,
    destinationGaps: destinationGaps.length,
    optionalCountGaps: optionalCountGaps.length
  },
  destinationGaps,
  optionalCountGaps
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Audited play-choice semantics across ${catalog.length} cards.`);
console.log(`Field-destination gaps: ${destinationGaps.length}. Optional-count gaps: ${optionalCountGaps.length}.`);
console.log(`Report: ${out}`);
if (destinationGaps.length > 0 || optionalCountGaps.length > 0) process.exitCode = 1;

function relevantPlayText(value) {
  return String(value ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\bplay this (?:character|site) set to (?:active|resting) onto your field\.?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function example(raw, card, effects) {
  return {
    number: card.number,
    id: card.id,
    name: card.name,
    encodedPlayEffects: effects.map((effect) => ({
      kind: effect.kind,
      min: effect.min,
      max: effect.max,
      count: effect.count,
      destinationLine: effect.destinationLine,
      destinationLines: effect.destinationLines
    }))
  };
}

function cardEffects(card) {
  const effects = [];
  const visit = (effect) => {
    if (!effect || typeof effect !== "object") return;
    effects.push(effect);
    for (const child of [
      ...(effect.effects ?? []),
      ...(effect.choices ?? []).map((choice) => choice.effect),
      effect.effect,
      effect.elseEffect,
      effect.costEffect,
      effect.baseEffect,
      effect.insteadEffect,
      effect.upgradedEffect,
      effect.ifMovedEffect,
      effect.successEffect,
      effect.selectedAlternative
    ]) visit(child);
  };
  visit(card.eventEffect);
  visit(card.whenUsingEffect);
  visit(card.trigger?.effect);
  for (const ability of card.abilities ?? []) visit(ability.effect);
  for (const replacement of card.triggerReplacements ?? []) visit(replacement.effect);
  return effects;
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}
