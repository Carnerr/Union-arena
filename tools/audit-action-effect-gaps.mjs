#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { cleanUnionArenaText } from "../src/effect-text.js";

const rawIn = valueAfter("--raw-in") ?? "work/private/egman-unionarena-raw.json";
const catalogIn = valueAfter("--catalog-in") ?? "work/private/egman-unionarena-catalog.json";
const out = valueAfter("--out") ?? "work/private/audits/action-effect-gap-audit.json";

if (process.argv.includes("--help")) {
  console.log(`Usage:
  node tools/audit-action-effect-gaps.mjs [--raw-in path] [--catalog-in path] [--out path]

Audits raw Union Arena text for broad action classes: timing tags, triggers,
choice trees, targeting/zone movement, damage, BP changes, and activation clauses.
It reports raw text patterns that do not appear to have a matching structured
runtime effect kind.`);
  process.exit(0);
}

const rawCards = JSON.parse(readFileSync(rawIn, "utf8"));
const catalogPayload = JSON.parse(readFileSync(catalogIn, "utf8"));
const catalog = catalogPayload.cards ?? catalogPayload;

const TIMING_MAP = new Map([
  ["when played", "whenPlayed"],
  ["when attacking", "whenAttacking"],
  ["when blocking", "whenBlocking"],
  ["when sidelined", "whenSidelined"],
  ["activate: main", "activateMain"],
  ["start of end phase", "startOfEndPhase"]
]);

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
  const effectText = normalizeText(raw.effect);
  const triggerText = normalizeText(raw.trigger);
  const categories = [
    ...classifyTimings(effectText),
    ...classifyActions(effectText),
    ...classifyTrigger(triggerText)
  ];
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
    snippets: snippetsFor(`${effectText} ${triggerText}`, gaps.map((gap) => gap.pattern))
  });
}

const report = { summary, cards };
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

console.log(`Audited ${summary.cardCount} non-AP cards.`);
console.log(`Detected action/timing/trigger text on ${Object.values(summary.categoryCounts).reduce((a, b) => a + b, 0)} category hit(s).`);
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
    .replace(/\]\s*(?=[a-z[])/gi, "] ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function classifyTimings(text) {
  const categories = [];
  for (const match of text.matchAll(/\[(when played|when attacking|when blocking|when sidelined|activate: main|start of end phase)\]/g)) {
    if (isEmbeddedTimingTag(text, match.index)) continue;
    categories.push({
      kind: "abilityTiming",
      timing: TIMING_MAP.get(match[1]),
      pattern: `[${match[1]}]`
    });
  }
  return categories;
}

function isEmbeddedTimingTag(text, index) {
  const prefix = text.slice(Math.max(0, index - 45), index).toLowerCase();
  const suffix = text.slice(index).toLowerCase();
  return /(?:['’]s|its|one|all|and|next|an?|the chosen character's|this character's|activate(?:s)?(?: all of)?\s*)\s*$/.test(prefix)
    || /^\[[^\]]+\]\s+abilities on\b/.test(suffix);
}

function classifyTrigger(text) {
  if (!text) return [];
  const categories = [];
  for (const [label, type] of [
    ["get", "get"],
    ["draw", "draw"],
    ["active", "active"],
    ["color", "color"],
    ["special", "special"],
    ["final", "final"],
    ["raid", "raid"]
  ]) {
    if (text.includes(`[${label}]`)) categories.push({ kind: "triggerType", triggerType: type, pattern: `[${label}]` });
  }
  return categories;
}

function classifyActions(text) {
  if (!text) return [];
  const categories = [];
  const unquotedText = text.replace(/"[^"]*"/g, "");
  const rulesText = unquotedText.replace(/\([^)]*\)/g, "");
  const add = (kind, pattern, extra = {}, sourceText = text) => {
    const matched = pattern instanceof RegExp ? pattern.test(sourceText) : sourceText.includes(pattern);
    if (matched) {
      categories.push({ kind, pattern: String(pattern).replace(/^\/|\/[gimuy]*$/g, ""), ...extra });
    }
  };

  add("choiceTree", /choose (?:one|two|all) of (?:the )?(?:following|abilities listed below)|\{choose (?:one|two|all)\}/);
  add("optionalEffect", /you may\b|up to/);
  add("draw", /\bdraw(?:s)?\s+(?:up to\s+)?(?:a|one|two|three|four|five|\d+)/);
  add("searchTopDeck", /look at the top[^.]+of your deck[^.]+add (?:it|them|that card|those cards|up to)/);
  add("lookTopDeck", /look at the top[^.]+of your deck/);
  add("revealTopDeck", /reveal the top (?:card|two cards|three cards|four cards|five cards)/);
  add("playFromZone", /play(?: up to)? (?:one|two|a|\{?one\}?|\{?two\}?)[^.]+ from your (?:hand|sideline|hand or sideline)/);
  add("useFromSideline", /use up to one <[^>]+> card[^.]+from your sideline/);
  add("activateTriggerFromZone", /from your sideline and activate its \[trigger\]/);
  add("activateTargetAbility", /activate(?:s)? (?:its|this character's|this site's|all of the chosen character's)[^.]+abilit/);
  add("returnToHand", /return(?:s)? [^.]+ to (?:your|their|its owner's) hand|add this card to your hand|add this card from your sideline to your hand/);
  add("sidelineTarget", /(?:sideline|sidelines) (?:it|them|that character|the chosen character|one character|all characters|this character|this site)|place [^.]+ into (?:your|their) sideline/, {}, rulesText);
  add("removeTarget", /(?:place|placed|move|moved|add|added)[^.]+(?:into|to|in) (?:your|their|its|the)? ?removal area|removal area instead of (?:your|their|the)? ?sideline|into your removal area instead|used with this ability into your removal area/, {}, rulesText);
  add("readyTarget", /switch(?:es)? [^.]+ to active|switch all [^.]+ to active/);
  if (/switch(?:es)? [^.]+ to resting|set to resting/.test(rulesText)) {
    categories.push({ kind: "restTarget", pattern: "switch(?:es)? [^.]+ to resting|set to resting" });
  }
  add("moveLine", /move [^.]+ to (?:your|their) (?:front line|energy line)|move them to your front line/);
  add("swapLines", /swap (?:it|them)|swap them|swap it/);
  add("bottomDeck", /bottom of (?:your|their|its owner's|your opponent's) deck/);
  add("topDeckMove", /top of (?:your|their|its owner's|your opponent's) deck/);
  add("lifeMove", /(?:add|place|move) [^.]+ from your life area|from your life into your sideline|place [^.]+ into (?:your|their) life area/, {}, rulesText);
  add("underCard", /under (?:this|it|the chosen|another)|under-card|raided card|base card/);
  add("damage", /deal (?:one|two|three|\d+) damage/);
  add("bpModify", /(?:gains?|loses?|reduce [^.]+ bp|give it) \{?\d+ bp\}?/);
  add("energyGrant", /(?:gains?|gain) [^."]*(?:\[(?:red|blue|green|yellow|purple)\]\s*)+energy generation|(?:gains?|gain) "[^"]*energy generation|generates energy even/);
  add("keywordGrant", /\[(?:impact|damage|snipe|step|double attack|double block|nullify impact)[^\]]*\]|gains? \[(?:impact|damage|snipe|step|double attack|double block|nullify impact)/);
  add("handToZone", /place [^.]+ from your hand (?:into|on top of)/);
  add("opponentHandToZone", /opponent places [^.]+ from their hand|opponent reveals all the cards in their hand/);
  add("deckToZone", /(?:place|move|add) (?:the )?top [^.]+(?:of your deck|from your deck)/);
  add("faceUpDeck", /face-up card|turn (?:the )?top card of your deck face up/);
  return dedupeCategories(categories);
}

function dedupeCategories(categories) {
  const seen = new Set();
  return categories.filter((category) => {
    const key = `${category.kind}:${category.pattern}:${category.timing ?? category.triggerType ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function describeEncoding(def) {
  const effects = [];
  const abilityTimings = new Set();
  const addEffect = (effect) => {
    effects.push(effect);
    if (effect.kind === "grantAbility" && effect.ability?.timing) abilityTimings.add(effect.ability.timing);
  };
  walkEffectTree(def?.eventEffect, addEffect);
  walkEffectTree(def?.whenUsingEffect, addEffect);
  walkEffectTree(def?.trigger?.effect, addEffect);
  for (const timing of def?.gainsBaseAbilityTimings ?? []) abilityTimings.add(timing);
  for (const ability of def?.abilities ?? []) {
    abilityTimings.add(ability.timing);
    if (ability.cost?.restSelf) effects.push({ kind: "restSelf" });
    if (ability.cost?.ap) effects.push({ kind: "payAp" });
    if (ability.cost?.discardFromHand) effects.push({ kind: "moveHandToZone", destination: "sideline" });
    if (ability.cost?.sidelineSelf) effects.push({ kind: "moveSelfCardToZone", destination: "sideline" });
    walkEffectTree(ability.effect, addEffect);
  }
  for (const replacement of def?.triggerReplacements ?? []) {
    walkEffectTree(replacement.effect, addEffect);
  }
  return {
    hasDefinition: Boolean(def),
    triggerType: def?.trigger?.type,
    abilityTimings: [...abilityTimings],
    effectKinds: [...new Set(effects.map((effect) => effect.kind).filter(Boolean))],
    effectDetails: effects.map((effect) => ({
      kind: effect.kind,
      destination: effect.destination,
      remainingDestination: effect.remainingDestination,
      remainingDestinations: effect.remainingDestinations,
      source: effect.source,
      player: effect.player,
      destinationLine: effect.destinationLine,
      destinations: effect.destinations,
      defaultDestination: effect.defaultDestination,
      faceUpOnTop: effect.faceUpOnTop,
      timing: effect.timing,
      targetLine: effect.target?.line,
      targetController: effect.target?.controller,
      condition: effect.condition,
      conditionAttackingKeyword: effect.condition?.attackingKeyword
    })),
    whenUsingEffect: Boolean(def?.whenUsingEffect),
    choiceModeAssists: (def?.choiceModeAssists ?? []).length,
    triggerReplacements: (def?.triggerReplacements ?? []).length,
    staticModifiers: (def?.staticModifiers ?? []).length,
    staticFieldModifiers: (def?.staticFieldModifiers ?? []).length,
    staticEnergyModifiers: (def?.staticEnergyModifiers ?? []).length,
    staticKeywordModifiers: (def?.staticKeywordModifiers ?? []).length,
    staticFieldKeywordModifiers: (def?.staticFieldKeywordModifiers ?? []).length,
    useCostModifiers: (def?.useCostModifiers ?? []).length,
    staticUseCostModifiers: (def?.staticUseCostModifiers ?? []).length,
    gainsBaseAbilityTimings: (def?.gainsBaseAbilityTimings ?? []).length,
    returnRaidStackToHandOnReturn: Boolean(def?.returnRaidStackToHandOnReturn),
    sidelineTopRaidCardInstead: Boolean(def?.sidelineTopRaidCardInstead),
    battleLosersToRemovalInstead: Boolean(def?.battleLosersToRemovalInstead),
    returnToHandHandSidelineInstead: Boolean(def?.returnToHandHandSidelineInstead),
    topRaidCardToSidelineInsteadOnOpponentLeave: Boolean(def?.topRaidCardToSidelineInsteadOnOpponentLeave),
    sidelineInsteadForFrontGoreinu: Boolean(def?.sidelineInsteadForFrontGoreinu),
    moveToEnergyInsteadOnOpponentAbilityLeave: Boolean(def?.moveToEnergyInsteadOnOpponentAbilityLeave),
    moveToEnergyInsteadOnOpponentAbilityBpReduction: Boolean(def?.moveToEnergyInsteadOnOpponentAbilityBpReduction),
    hasFaceDownUnderCondition: (def?.abilities ?? []).some((ability) => conditionContains(ability.conditions, "hasFaceDownUnder")),
    keywords: def?.keywords ?? {},
    raid: Boolean(def?.raid),
    entersActive: Boolean(def?.entersActive || def?.entersActiveCondition)
  };
}

function categoryEncoded(category, encoded) {
  switch (category.kind) {
    case "abilityTiming":
      return encoded.abilityTimings.includes(category.timing);
    case "triggerType":
      return encoded.triggerType === category.triggerType;
    case "choiceTree":
      return hasAnyKind(encoded, ["chooseOne", "chooseN", "optionalChoiceUpgrade", "choiceModeModifier"])
        || encoded.choiceModeAssists > 0;
    case "optionalEffect":
      return true;
    case "draw":
      return hasAnyKind(encoded, ["draw", "drawUntilHandSize", "drawOpponent", "drawLastMovedFromHandCount", "drawLastRestedTargetControllers", "sidelineTargetsAndDraw", "grantKeyword", "grantAbility", "watchTargetSidelinedForEffect", "opponentMaySidelineChosenTargetsElse", "opponentMayMoveCardsBetweenZonesElse"]);
    case "searchTopDeck":
      return hasAnyKind(encoded, ["searchTopDeck"]);
    case "lookTopDeck":
      return hasAnyKind(encoded, ["lookTopDeck", "lookTopDeckAndMove", "lookTopDeckPlayOneAndMoveRest", "revealTopDeckOptionalPlayOrRaidInstead", "searchTopDeck"]);
    case "revealTopDeck":
      return hasAnyKind(encoded, ["searchTopDeck", "moveTopDeck", "turnTopDeckFaceUp", "lookTopDeck", "lookTopDeckAndMove", "revealTopDeckOptionalPlayOrRaidInstead"]);
    case "playFromZone":
      return hasAnyKind(encoded, ["playCardFromZone", "playOrRaidCardFromZone", "playSourceFromZone", "playBaseCardFromSelf", "playSomeNamedFromSidelineAddRest", "revealTopDeckOptionalPlayOrRaidInstead", "useEventFromZone"]);
    case "useFromSideline":
      return hasAnyKind(encoded, ["useEventFromZone"]);
    case "activateTriggerFromZone":
      return hasAnyKind(encoded, ["activateTriggerFromZone"]);
    case "activateTargetAbility":
      return hasAnyKind(encoded, ["activateTargetAbility", "activateTargetTrigger", "activateTriggerFromZone", "sidelineTargetsThenActivateSourceWhenPlayed"]);
    case "returnToHand":
      return hasAnyKind(encoded, ["returnTargetsToHand", "returnTargetsToHandOrSelf", "moveSelfCardToZone", "moveSourceCardBetweenZones", "moveCardBetweenZones", "moveContextCardToZone", "moveTopRaidCardToZone", "moveBaseCardFromSelf", "scheduleReturnTargetsToHand", "scheduleLastPlayedPermanentToZone", "grantAbility", "targetConditional"])
        || encoded.returnRaidStackToHandOnReturn
        || encoded.returnToHandHandSidelineInstead;
    case "sidelineTarget":
      return hasAnyKind(encoded, ["sidelineTargets", "sidelineTargetsAndDraw", "sidelineTargetsByUniqueAffinityReveal", "moveHandToZone", "moveAllHandToZone", "moveSelfCardToZone", "moveCardBetweenZones", "moveContextCardToZone", "moveUnderCardsToZone", "moveTopDeck", "moveTopRaidCardToZone", "moveBaseCardFromSelf", "sidelineTargetsThenActivateSourceWhenPlayed", "scheduleSidelineSelfAtEndOfMain", "scheduleSidelineTargetsAndMoveSelfToEnergy", "scheduleLastPlayedPermanentToZone", "lookTopDeckAndMove", "opponentMaySidelineChosenTargetsElse", "grantAbility", "grantKeyword", "replayTargets"])
        || hasEffectDetail(encoded, (effect) => effect.kind === "searchTopDeck" && effect.remainingDestination === "sideline")
        || hasEffectDetail(encoded, (effect) => effect.kind === "searchTopDeck" && effect.destinations?.includes?.("sideline"))
        || hasEffectDetail(encoded, (effect) => effect.kind === "searchTopDeck" && effect.remainingDestinations?.includes?.("sideline"))
        || encoded.staticKeywordModifiers > 0
        || encoded.staticFieldKeywordModifiers > 0
        || encoded.sidelineTopRaidCardInstead
        || encoded.topRaidCardToSidelineInsteadOnOpponentLeave
        || encoded.sidelineInsteadForFrontGoreinu
        || encoded.choiceModeAssists > 0;
    case "removeTarget":
      return hasAnyKind(encoded, ["removeTargets", "replacementOrUseRestriction", "moveEqualCountsBetweenZones", "opponentMayMoveCardsBetweenZonesElse"])
        || encoded.battleLosersToRemovalInstead
        || hasAnyKind(encoded, ["moveTargetsToLine"])
        || hasEffectDetail(encoded, (effect) => (
          (effect.kind === "moveSelfCardToZone"
            || effect.kind === "moveCardBetweenZones"
            || effect.kind === "moveHandToZone"
            || effect.kind === "moveAllHandToZone"
            || effect.kind === "useEventFromZone")
          && effect.destination === "removal"
        ));
    case "readyTarget":
      return hasAnyKind(encoded, ["readyTargets", "readySelf", "readyAp", "opponentMaySidelineChosenTargetsElse", "lookTopDeckPlayOneAndMoveRest", "readyLastPlayedPermanent", "playCardFromZone", "playOrRaidCardFromZone", "playSourceFromZone"]) || encoded.entersActive
        || hasKeywordAny(encoded, ["doubleAttack", "doubleBlock"]);
    case "restTarget":
      return hasAnyKind(encoded, ["restTargets", "restTargetsThen", "restSelf", "restEnergyLineForRequiredEnergyTotal", "playCardFromZone", "playOrRaidCardFromZone", "playSourceFromZone", "playSomeNamedFromSidelineAddRest", "playBaseCardFromSelf", "lookTopDeckPlayOneAndMoveRest", "revealTopDeckOptionalPlayOrRaidInstead", "moveTargetsToLine", "payAp", "replacementOrUseRestriction"]);
    case "moveLine":
      return hasAnyKind(encoded, ["moveTargetsToLine", "moveTargetsToOtherLine", "moveOrSwapTargetsToOtherLine", "swapOwnFrontAndEnergy", "swapChosenTargets", "swapSourceWithOtherLine", "swapTargetsWithOtherLine", "scheduleSidelineTargetsAndMoveSelfToEnergy", "restrictMovement"])
        || encoded.sidelineInsteadForFrontGoreinu
        || encoded.moveToEnergyInsteadOnOpponentAbilityLeave
        || encoded.moveToEnergyInsteadOnOpponentAbilityBpReduction
        || hasKeywordAny(encoded, ["step"]);
    case "swapLines":
      return hasAnyKind(encoded, ["swapOwnFrontAndEnergy", "swapChosenTargets", "swapSourceWithOtherLine", "swapTargetsWithOtherLine", "moveOrSwapTargetsToOtherLine"]);
    case "bottomDeck":
      return hasAnyKind(encoded, ["moveTargetsToBottomDeck", "moveTargetsToDeck", "moveSelfCardToZone", "searchTopDeck", "moveCardBetweenZones", "lookTopDeckAndMove", "lookTopDeckPlayOneAndMoveRest", "moveHandToZone"]);
    case "topDeckMove":
      return hasAnyKind(encoded, ["moveTopDeck", "moveTargetsToDeck", "moveSelfCardToDeckTop", "moveCardBetweenZones", "placeTopDeckUnderSelf", "placeTopDeckUnderTargets", "searchTopDeck", "lookTopDeck", "lookTopDeckAndMove", "lookTopDeckPlayOneAndMoveRest", "moveHandToZone", "moveTopRaidCardToZone"]);
    case "lifeMove":
      return hasAnyKind(encoded, ["moveTargetsToLife", "moveBaseCardFromSelf", "moveCardBetweenZones", "moveTopDeck", "damage", "damageOpponent", "recoverLifeIfEmpty", "replacementOrUseRestriction"])
        || encoded.abilityTimings.includes("whenLifeToSidelineNoTrigger");
    case "underCard":
      return hasAnyKind(encoded, ["placeTopDeckUnderSelf", "placeTopDeckUnderTargets", "lookTopDeckAndMove", "moveUnderCardsToZone", "moveHandCardsUnderSelf", "moveHandCardsUnderTargets", "moveZoneCardsUnderSelf", "moveZoneCardsUnderTargets", "moveSelfCardUnderTarget", "moveTopRaidCardToZone", "moveBaseCardFromSelf", "playBaseCardFromSelf"])
        || encoded.gainsBaseAbilityTimings > 0
        || encoded.returnRaidStackToHandOnReturn
        || encoded.sidelineTopRaidCardInstead
        || encoded.topRaidCardToSidelineInsteadOnOpponentLeave
        || encoded.staticModifiers > 0
        || encoded.staticKeywordModifiers > 0
        || encoded.useCostModifiers > 0
        || encoded.choiceModeAssists > 0
        || encoded.hasFaceDownUnderCondition;
    case "damage":
      return hasAnyKind(encoded, ["damageOpponent", "damage"])
        || hasKeywordAny(encoded, ["impact", "impactPlus", "damage", "damagePlus"]);
    case "bpModify":
      return hasAnyKind(encoded, ["modifyBp", "modifyBpForHandReveal", "modifyNextBpRange", "applyTieredAbilityGrants"]) || encoded.staticModifiers > 0 || encoded.staticFieldModifiers > 0;
    case "energyGrant":
      return hasAnyKind(encoded, ["grantEnergy", "grantKeyword", "applyTieredAbilityGrants"]) || encoded.staticEnergyModifiers > 0
        || encoded.staticKeywordModifiers > 0
        || hasKeywordAny(encoded, ["frontLineEnergyGeneration"])
        || encoded.staticUseCostModifiers > 0 || encoded.useCostModifiers > 0;
    case "keywordGrant":
      return hasAnyKind(encoded, ["grantKeyword", "applyTieredAbilityGrants"]) || encoded.raid
        || encoded.staticKeywordModifiers > 0
        || encoded.staticFieldKeywordModifiers > 0
        || hasEffectDetail(encoded, (effect) => Boolean(effect.conditionAttackingKeyword))
        || hasKeywordAny(encoded, [
          "impact",
          "impactPlus",
          "damage",
          "damagePlus",
          "snipe",
          "step",
          "doubleAttack",
          "doubleBlock",
          "nullifyImpact"
        ]);
    case "handToZone":
      return hasAnyKind(encoded, ["moveHandToZone", "moveAllHandToZone", "moveCardBetweenZones", "replacementOrUseRestriction", "optionalChoiceUpgrade", "opponentMayMoveCardsBetweenZonesElse"])
        || encoded.whenUsingEffect
        || encoded.returnToHandHandSidelineInstead
        || encoded.topRaidCardToSidelineInsteadOnOpponentLeave
        || encoded.abilityTimings.includes("whenHandToSidelineByAbility");
    case "opponentHandToZone":
      return hasAnyKind(encoded, ["discardOpponentFromHand", "moveCardBetweenZones", "revealOpponentHand"]);
    case "deckToZone":
      return hasAnyKind(encoded, ["moveTopDeck", "searchTopDeck", "placeTopDeckUnderSelf", "placeTopDeckUnderTargets", "turnTopDeckFaceUp", "moveTopRaidCardToZone"]);
    case "faceUpDeck":
      return hasAnyKind(encoded, ["turnTopDeckFaceUp", "moveTargetsToLife", "moveTopDeck"])
        || hasEffectDetail(encoded, (effect) => effect.kind === "lookTopDeckAndMove" && effect.faceUpOnTop)
        || hasEffectDetail(encoded, (effect) => effect.condition?.anyFaceUpDeckOrLife || effect.condition?.faceUpDeckOrLifeCountMin !== undefined);
    default:
      return false;
  }
}

function hasAnyKind(encoded, kinds) {
  return kinds.some((kind) => encoded.effectKinds.includes(kind));
}

function hasKeywordAny(encoded, names) {
  return names.some((name) => encoded.keywords?.[name] !== undefined);
}

function hasEffectDetail(encoded, predicate) {
  return encoded.effectDetails.some(predicate);
}

function conditionContains(condition, key) {
  if (!condition || typeof condition !== "object") return false;
  if (Object.hasOwn(condition, key)) return true;
  return [...(condition.allOf ?? []), ...(condition.anyOf ?? [])].some((child) => conditionContains(child, key));
}

function walkEffectTree(effect, callback) {
  if (!effect || typeof effect !== "object") return;
  callback(effect);
  if (effect.ability?.effect) walkEffectTree(effect.ability.effect, callback);
  if (effect.effect) walkEffectTree(effect.effect, callback);
  if (effect.elseEffect) walkEffectTree(effect.elseEffect, callback);
  if (effect.baseEffect) walkEffectTree(effect.baseEffect, callback);
  if (effect.costEffect) walkEffectTree(effect.costEffect, callback);
  if (effect.insteadEffect) walkEffectTree(effect.insteadEffect, callback);
  if (effect.upgradedEffect) walkEffectTree(effect.upgradedEffect, callback);
  if (effect.ifMovedEffect) walkEffectTree(effect.ifMovedEffect, callback);
  for (const child of effect.effects ?? []) walkEffectTree(child, callback);
  for (const choice of effect.choices ?? []) walkEffectTree(choice.effect, callback);
}

function snippetsFor(text, patterns) {
  const sentences = text.split(/(?<=\.)\s+/);
  return [...new Set(patterns.flatMap((pattern) => {
    const regex = safeRegex(pattern);
    const found = regex ? sentences.filter((sentence) => regex.test(sentence)) : sentences.filter((sentence) => sentence.includes(pattern));
    if (found.length > 0) return found;
    const plain = String(pattern).replace(/\\/g, "");
    const index = text.indexOf(plain);
    if (index === -1) return [];
    return [text.slice(Math.max(0, index - 120), Math.min(text.length, index + 240)).trim()];
  }))];
}

function safeRegex(pattern) {
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}

function increment(record, key) {
  record[key] = (record[key] ?? 0) + 1;
}
