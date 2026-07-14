#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const catalogIn = valueAfter("--catalog-in") ?? "work/private/egman-unionarena-catalog.json";
const gameSource = valueAfter("--game-source") ?? "src/game.js";
const simulationSource = valueAfter("--simulation-source") ?? "src/simulation.js";
const out = valueAfter("--out") ?? "work/private/audits/policy-choice-coverage-audit.json";

if (process.argv.includes("--help")) {
  console.log(`Usage:
  node tools/audit-policy-choice-coverage.mjs [--catalog-in path] [--game-source path] [--simulation-source path] [--out path]

Checks that every known public card-choice family represented in the catalog has
both policy-choice keys and candidate alternatives. It also inventories choices
that must move to nested post-reveal or opponent-owned decision points.`);
  process.exit(0);
}

const catalogPayload = JSON.parse(readFileSync(catalogIn, "utf8"));
const catalog = catalogPayload.cards ?? catalogPayload;
const gameJs = readFileSync(gameSource, "utf8");
const simulationJs = readFileSync(simulationSource, "utf8");
const choiceKeyBody = functionBody(simulationJs, "collectEffectChoiceKeys");
const alternativesBody = functionBody(simulationJs, "collectAutoplayChoiceAlternatives");
const nestedResolutionBody = functionBody(simulationJs, "nestedResolutionCandidates");

const publicChoiceKinds = [
  "optional",
  "restTargetsThen",
  "optionalChoiceUpgrade",
  "optionalInstead",
  "chooseOne",
  "chooseN",
  "revealTopDeckOptionalPlayOrRaidInstead",
  "playCardFromZone",
  "playCardFromZoneMatchingTargetName",
  "playOrRaidCardFromZone",
  "playSourceFromZone",
  "useEventFromZone",
  "activateTriggerFromZone",
  "moveCardBetweenZones",
  "moveHandToZone",
  "moveHandCardsUnderSelf",
  "moveHandCardsUnderTargets",
  "moveEqualCountsBetweenZones",
  "moveUnderCardsToZone",
  "moveZoneCardsUnderSelf",
  "moveZoneCardsUnderTargets",
  "swapSourceWithOtherLine",
  "swapChosenTargets",
  "swapTargetsWithOtherLine",
  "swapOwnFrontAndEnergy",
  "moveOrSwapTargetsToOtherLine",
  "restEnergyLineForRequiredEnergyTotal",
  "moveTargetsToDeck",
  "sidelineTargetsThenActivateSourceWhenPlayed",
  "revealHandCards",
  "modifyBpForHandReveal",
  "playSomeNamedFromSidelineAddRest"
];

const pairedChoiceRequirements = [
  { kind: "playCardFromZoneMatchingTargetName", marker: "matchingTargetPlayPlans" },
  { kind: "moveHandCardsUnderTargets", marker: "handUnderMovePlans" },
  { kind: "moveZoneCardsUnderTargets", marker: "zoneUnderMovePlans" },
  { kind: "moveUnderCardsToZone", marker: "underCardMovePlans" },
  { kind: "swapTargetsWithOtherLine", marker: "swapTargetPlans" },
  { kind: "swapChosenTargets", marker: "swapChosenTargetPlans" },
  { kind: "moveOrSwapTargetsToOtherLine", marker: "moveOrSwapTargetPlans" },
  { kind: "playCardFromZone", marker: "choicesWithLineReplacements" },
  { kind: "playOrRaidCardFromZone", marker: "choicesWithDestinationLineReplacements" }
];

const nestedDecisionKinds = new Set([
  "searchTopDeck",
  "lookTopDeckAndMove",
  "lookTopDeckPlayOneAndMoveRest",
  "revealTopDeckOptionalPlayOrRaidInstead",
  "raidSourceFromZone",
  "playSourceFromZone"
]);

const nestedSemanticRequirements = [
  {
    id: "search-selected-alternative",
    applies: (effect) => effect.kind === "searchTopDeck" && Boolean(effect.selectedAlternative),
    gameMarkers: ["selectedAlternative", "searchPlayInstead"],
    simulationMarkers: ["nestedSearchAlternativePlans", "alternative_keep", "alternative_play", "alternative_raid"]
  },
  {
    id: "search-card-ordering",
    applies: (effect) => effect.kind === "searchTopDeck" && Number(effect.count ?? effect.amount ?? 1) >= 2,
    gameMarkers: ["orderCardsByChoice", "searchTopOrder", "bottomOrder"],
    simulationMarkers: ["nestedSearchOrderPlans", "addOrderedCards(\"bottom\""]
  },
  {
    id: "look-card-ordering",
    applies: (effect) => effect.kind === "lookTopDeckAndMove" && Number(effect.count ?? effect.amount ?? 1) >= 2,
    gameMarkers: ["lookTopOrder", "lookBottomOrder"],
    simulationMarkers: ["nestedCardOrderPlans", "lookTopOrder", "lookBottomOrder"]
  },
  {
    id: "look-play-remaining-ordering",
    applies: (effect) => effect.kind === "lookTopDeckPlayOneAndMoveRest" && Number(effect.count ?? effect.amount ?? 1) >= 3,
    gameMarkers: ["lookRemainingOrder"],
    simulationMarkers: ["nestedCardOrderPlans", "lookRemainingOrder", "addOrderedCards(\"remaining\""]
  },
  {
    id: "revealed-opponent-hand-selection",
    applies: (effect) => effect.kind === "moveCardBetweenZones" && effect.player === "opponent" && effect.source === "hand",
    gameMarkers: ["revealedOpponentHandCardUids", "chooseRevealedZoneCards"],
    simulationMarkers: ["nestedRevealedZoneCardCandidates", "chooseRevealedZoneCards"]
  },
  {
    id: "opponent-optional-hand-play",
    applies: (effect) => effect.kind === "playCardFromZone"
      && effect.player === "opponent"
      && (effect.zone === "hand" || effect.zones?.includes("hand")),
    gameMarkers: ["resolveOpponentHandPlayChoice", "opponentMayPlayCardFromHand"],
    simulationMarkers: ["nestedOpponentHandPlayCandidates", "opponentMayPlayCardFromHand"]
  },
  {
    id: "raid-energy-line-movement",
    applies: (effect) => effect.kind === "playOrRaidCardFromZone" && Boolean(effect.allowRaid),
    gameMarkers: ["moveRaidToFront", "raidMoveReplaceIndex"],
    simulationMarkers: ["raidMovementPlansForTargets", "raidMoveReplaceIndex"]
  },
  {
    id: "dynamic-triggered-optional",
    applies: (effect) => effect.kind === "optional",
    gameMarkers: ["kind: \"optionalEffect\"", "resolveRuntimeChoices"],
    simulationMarkers: ["nestedOptionalEffectCandidates", "case \"optionalEffect\""]
  }
];

const effectsByKind = new Map();
const semanticExamples = new Map(nestedSemanticRequirements.map((requirement) => [requirement.id, []]));
for (const card of Object.values(catalog)) {
  walkCardEffects(card, (effect, path) => {
    if (!effect.kind) return;
    const entries = effectsByKind.get(effect.kind) ?? [];
    if (entries.length < 25) entries.push({ id: card.id, number: card.number, name: card.name, path });
    effectsByKind.set(effect.kind, entries);
    for (const requirement of nestedSemanticRequirements) {
      if (!requirement.applies(effect)) continue;
      const examples = semanticExamples.get(requirement.id);
      if (examples.length < 25) examples.push({ id: card.id, number: card.number, name: card.name, path });
    }
  });
}

const publicCoverage = publicChoiceKinds
  .filter((kind) => effectsByKind.has(kind))
  .map((kind) => ({
    kind,
    cardCount: uniqueCardCount(effectsByKind.get(kind)),
    choiceKeys: sourceMentionsKind(choiceKeyBody, kind),
    alternatives: sourceMentionsKind(alternativesBody, kind),
    examples: effectsByKind.get(kind).slice(0, 8)
  }));
const publicMissing = publicCoverage.filter((entry) => !entry.choiceKeys || !entry.alternatives);

const pairedChoiceCoverage = pairedChoiceRequirements
  .filter(({ kind }) => effectsByKind.has(kind))
  .map(({ kind, marker }) => ({
    kind,
    marker,
    covered: alternativesBody.includes(marker),
    cardCount: uniqueCardCount(effectsByKind.get(kind)),
    examples: effectsByKind.get(kind).slice(0, 8)
  }));
const pairedChoiceMissing = pairedChoiceCoverage.filter((entry) => !entry.covered);

const nestedDecisionCoverage = [...nestedDecisionKinds]
  .filter((kind) => effectsByKind.has(kind))
  .map((kind) => ({
    kind,
    cardCount: uniqueCardCount(effectsByKind.get(kind)),
    runtimeHook: gameJs.includes("resolveRuntimeChoices") && sourceMentionsKind(gameJs, kind),
    policyHandler: simulationJs.includes("resolveAutoplayResolutionChoice") && sourceMentionsKind(simulationJs, kind),
    status: gameJs.includes("resolveRuntimeChoices") && sourceMentionsKind(gameJs, kind)
      && simulationJs.includes("resolveAutoplayResolutionChoice") && sourceMentionsKind(simulationJs, kind)
      ? "covered"
      : "nested-resolution-policy-required",
    examples: effectsByKind.get(kind).slice(0, 8)
  }));
const nestedDecisionMissing = nestedDecisionCoverage.filter((entry) => entry.status !== "covered");

const nestedSemanticCoverage = nestedSemanticRequirements
  .filter((requirement) => semanticExamples.get(requirement.id).length > 0)
  .map((requirement) => {
    const examples = semanticExamples.get(requirement.id);
    const gameCovered = requirement.gameMarkers.every((marker) => gameJs.includes(marker));
    const simulationCovered = requirement.simulationMarkers.every((marker) => simulationJs.includes(marker));
    return {
      id: requirement.id,
      cardCount: uniqueCardCount(examples),
      gameCovered,
      simulationCovered,
      status: gameCovered && simulationCovered ? "covered" : "nested-semantic-policy-required",
      examples: examples.slice(0, 8)
    };
  });
const nestedSemanticMissing = nestedSemanticCoverage.filter((entry) => entry.status !== "covered");

const opponentDecisionCoverage = [...effectsByKind.keys()]
  .filter((kind) => kind.startsWith("opponentMay") || kind.startsWith("opponentChoose"))
  .sort()
  .map((kind) => ({
    kind,
    cardCount: uniqueCardCount(effectsByKind.get(kind)),
    runtimeHook: gameJs.includes("resolveRuntimeChoices") && sourceMentionsKind(gameJs, kind),
    responderPolicyHandler: sourceMentionsKind(nestedResolutionBody, kind),
    status: gameJs.includes("resolveRuntimeChoices") && sourceMentionsKind(gameJs, kind)
      && sourceMentionsKind(nestedResolutionBody, kind)
      ? "covered"
      : "opponent-owned-policy-required",
    examples: effectsByKind.get(kind).slice(0, 8)
  }));
const opponentDecisionMissing = opponentDecisionCoverage.filter((entry) => entry.status !== "covered");

const report = {
  summary: {
    catalogIn,
    auditedAt: new Date().toISOString(),
    cardCount: Object.keys(catalog).length,
    publicChoiceKindsPresent: publicCoverage.length,
    publicChoiceMissing: publicMissing.length,
    pairedChoiceKindsPresent: pairedChoiceCoverage.length,
    pairedChoiceMissing: pairedChoiceMissing.length,
    nestedDecisionKinds: nestedDecisionCoverage.length,
    nestedDecisionCards: uniqueEntriesCardCount(nestedDecisionCoverage),
    nestedDecisionMissing: nestedDecisionMissing.length,
    nestedSemanticRequirements: nestedSemanticCoverage.length,
    nestedSemanticMissing: nestedSemanticMissing.length,
    opponentDecisionKinds: opponentDecisionCoverage.length,
    opponentDecisionCards: uniqueEntriesCardCount(opponentDecisionCoverage),
    opponentDecisionMissing: opponentDecisionMissing.length
  },
  publicCoverage,
  publicMissing,
  pairedChoiceCoverage,
  pairedChoiceMissing,
  nestedDecisionCoverage,
  nestedDecisionMissing,
  nestedSemanticCoverage,
  nestedSemanticMissing,
  opponentDecisionCoverage,
  opponentDecisionMissing
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

console.log(`Audited policy choices across ${report.summary.cardCount} cards.`);
console.log(`Public choice gaps: ${publicMissing.length}. Paired-choice gaps: ${pairedChoiceMissing.length}.`);
console.log(`Nested decision gaps: ${nestedDecisionMissing.length} across ${nestedDecisionCoverage.length} audited kind(s).`);
console.log(`Nested semantic gaps: ${nestedSemanticMissing.length} across ${nestedSemanticCoverage.length} post-reveal requirement(s).`);
console.log(`Opponent-owned decision gaps: ${opponentDecisionMissing.length} across ${opponentDecisionCoverage.length} audited kind(s) affecting ${report.summary.opponentDecisionCards} card(s).`);
console.log(`Report: ${out}`);

if (publicMissing.length > 0 || pairedChoiceMissing.length > 0 || nestedDecisionMissing.length > 0
  || nestedSemanticMissing.length > 0 || opponentDecisionMissing.length > 0) process.exitCode = 1;

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function sourceMentionsKind(source, kind) {
  return source.includes(`"${kind}"`) || source.includes(`'${kind}'`);
}

function uniqueCardCount(entries = []) {
  return new Set(entries.map((entry) => entry.id)).size;
}

function uniqueEntriesCardCount(groups) {
  return new Set(groups.flatMap((group) => group.examples.map((entry) => entry.id))).size;
}

function walkCardEffects(card, visit) {
  walkEffect(card.eventEffect, "eventEffect", visit);
  walkEffect(card.whenUsingEffect, "whenUsingEffect", visit);
  walkEffect(card.trigger?.effect, "trigger.effect", visit);
  for (const [index, ability] of (card.abilities ?? []).entries()) {
    walkEffect(ability.effect, `abilities.${index}.effect`, visit);
  }
  for (const [index, replacement] of (card.triggerReplacements ?? []).entries()) {
    walkEffect(replacement.effect, `triggerReplacements.${index}.effect`, visit);
  }
}

function walkEffect(effect, path, visit) {
  if (!effect || typeof effect !== "object") return;
  visit(effect, path);
  const childKeys = [
    "effect",
    "elseEffect",
    "costEffect",
    "baseEffect",
    "insteadEffect",
    "upgradedEffect",
    "ifMovedEffect",
    "successEffect",
    "selectedAlternative"
  ];
  for (const key of childKeys) walkEffect(effect[key], `${path}.${key}`, visit);
  for (const [index, child] of (effect.effects ?? []).entries()) walkEffect(child, `${path}.effects.${index}`, visit);
  for (const [index, choice] of (effect.choices ?? []).entries()) walkEffect(choice.effect, `${path}.choices.${index}.effect`, visit);
  for (const [tierIndex, tier] of (effect.tiers ?? []).entries()) {
    for (const [effectIndex, child] of (tier.effects ?? []).entries()) {
      walkEffect(child, `${path}.tiers.${tierIndex}.effects.${effectIndex}`, visit);
    }
  }
  walkEffect(effect.ability?.effect, `${path}.ability.effect`, visit);
}

function functionBody(source, functionName) {
  const declaration = new RegExp(`function\\s+${functionName}\\s*\\([^)]*\\)\\s*\\{`).exec(source);
  if (!declaration) throw new Error(`Could not find function ${functionName}.`);
  const open = declaration.index + declaration[0].lastIndexOf("{");
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  throw new Error(`Could not parse function ${functionName}.`);
}
