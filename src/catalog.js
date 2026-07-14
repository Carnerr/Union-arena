import { CARD_TYPES, LINES, TIMINGS, TRIGGER_TYPES } from "./constants.js";
import { sourceCodeFromNumber } from "./deck.js";
import { assertRule } from "./errors.js";

const COLOR_MAP = new Map([
  ["red", "red"],
  ["blue", "blue"],
  ["yellow", "yellow"],
  ["green", "green"],
  ["purple", "purple"]
]);

const TYPE_MAP = new Map([
  ["character", CARD_TYPES.CHARACTER],
  ["site", CARD_TYPES.SITE],
  ["event", CARD_TYPES.EVENT],
  ["action point", "actionPoint"],
  ["ap", "actionPoint"]
]);

const TRIGGER_MAP = new Map([
  ["get", TRIGGER_TYPES.GET],
  ["draw", TRIGGER_TYPES.DRAW],
  ["active", TRIGGER_TYPES.ACTIVE],
  ["color", TRIGGER_TYPES.COLOR],
  ["final", TRIGGER_TYPES.FINAL],
  ["special", TRIGGER_TYPES.SPECIAL],
  ["raid", "raid"],
  ["none", TRIGGER_TYPES.NONE],
  ["", TRIGGER_TYPES.NONE]
]);

const TIMING_MAP = new Map([
  ["when played", TIMINGS.WHEN_PLAYED],
  ["when sideline", TIMINGS.WHEN_SIDELINED],
  ["when sidelined", TIMINGS.WHEN_SIDELINED],
  ["when attacking", TIMINGS.WHEN_ATTACKING],
  ["when blocking", TIMINGS.WHEN_BLOCKING],
  ["activate main", TIMINGS.ACTIVATE_MAIN],
  ["activate: main", TIMINGS.ACTIVATE_MAIN],
  ["start of end phase", TIMINGS.START_OF_END_PHASE]
]);

function compactString(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return compactString(value).toLowerCase();
}

function firstDefined(record, aliases) {
  for (const alias of aliases) {
    if (record[alias] !== undefined && record[alias] !== "") return record[alias];
  }
  return undefined;
}

function splitList(value) {
  if (Array.isArray(value)) return value.map(compactString).filter(Boolean);
  return compactString(value)
    .split(/[;,|]/)
    .map(compactString)
    .filter(Boolean);
}

function parseInteger(value, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;
  const match = String(value).match(/-?\d+/);
  return match ? Number(match[0]) : fallback;
}

function parseOptionalInteger(value) {
  if (value === undefined || value === null || value === "") return undefined;
  return parseInteger(value);
}

export function normalizeColor(value) {
  const normalized = COLOR_MAP.get(lower(value));
  assertRule(normalized || !value, "CARD_COLOR", `Unknown card color: ${value}`);
  return normalized;
}

export function normalizeCardType(value) {
  const normalized = TYPE_MAP.get(lower(value));
  assertRule(normalized, "CARD_TYPE", `Unknown card type: ${value}`);
  return normalized;
}

export function parseEnergyIcons(value, fallbackColor) {
  if (Array.isArray(value)) {
    return value
      .map((icon) => ({
        color: normalizeColor(icon.color ?? fallbackColor),
        amount: parseInteger(icon.amount, 1)
      }))
      .filter((icon) => icon.color && icon.amount > 0);
  }

  const text = compactString(value);
  if (!text) return fallbackColor ? [{ color: fallbackColor, amount: 1 }] : [];

  return text
    .split(/[;,|]/)
    .map((part) => {
      const color = [...COLOR_MAP.keys()].find((candidate) => lower(part).includes(candidate));
      const amount = parseInteger(part, 1);
      return color ? { color: COLOR_MAP.get(color), amount } : null;
    })
    .filter(Boolean);
}

export function parseRequiredEnergy(value, fallbackColor) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const color = normalizeColor(value.color ?? fallbackColor);
    return {
      color,
      amount: parseInteger(value.amount, 0)
    };
  }

  return {
    color: fallbackColor,
    amount: parseInteger(value, 0)
  };
}

export function parseKeywordEffects(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return { ...value };

  const keywords = {};
  const parts = splitList(value);
  for (const part of parts) {
    const text = lower(part);
    if (text.includes("step")) keywords.step = true;
    if (text.includes("snipe")) keywords.snipe = true;
    if (text.includes("double block")) keywords.doubleBlock = true;
    if (text.includes("double attack")) keywords.doubleAttack = true;
    if (text.includes("nullify impact")) keywords.nullifyImpact = true;

    let match = text.match(/impact\s*\(\s*\+\s*(\d+)\s*\)/);
    if (match) keywords.impactPlus = Number(match[1]);
    else {
      match = text.match(/impact\s*\(\s*(\d+)\s*\)/);
      if (match) keywords.impact = Number(match[1]);
    }

    match = text.match(/damage\s*\(\s*\+\s*(\d+)\s*\)/);
    if (match) keywords.damagePlus = Number(match[1]);
    else {
      match = text.match(/damage\s*\(\s*(\d+)\s*\)/);
      if (match) keywords.damage = Number(match[1]);
    }
  }
  return keywords;
}

export function parseTrigger(value) {
  if (!value) return undefined;
  if (typeof value === "object" && !Array.isArray(value)) return value;

  const text = compactString(value);
  const type = TRIGGER_MAP.get(lower(text));
  if (!type || type === TRIGGER_TYPES.NONE) return undefined;
  return { type };
}

export function parseAbilityJson(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  const parsed = JSON.parse(String(value));
  return Array.isArray(parsed) ? parsed : [parsed];
}

function parseJsonArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  const parsed = JSON.parse(String(value));
  return Array.isArray(parsed) ? parsed : [parsed];
}

export function normalizeAbility(ability) {
  const timing = TIMING_MAP.get(lower(ability.timing)) ?? ability.timing;
  return {
    ...ability,
    timing,
    conditions: normalizeConditions(ability.conditions),
    effect: normalizeEffect(ability.effect)
  };
}

export function normalizeConditions(conditions = {}) {
  if (!conditions.line) return conditions;
  return {
    ...conditions,
    line: conditions.line === "front" ? LINES.FRONT : conditions.line === "energy" ? LINES.ENERGY : conditions.line
  };
}

export function normalizeEffect(effect) {
  if (!effect || effect.kind === "none") return effect;
  if (effect.kind === "sequence") {
    return { ...effect, effects: (effect.effects ?? []).map(normalizeEffect) };
  }
  if (effect.kind === "conditional") {
    return { ...effect, effect: normalizeEffect(effect.effect), elseEffect: normalizeEffect(effect.elseEffect) };
  }
  if (effect.kind === "targetConditional") {
    return { ...effect, effect: normalizeEffect(effect.effect), elseEffect: normalizeEffect(effect.elseEffect) };
  }
  if (effect.kind === "optional") {
    return { ...effect, effect: normalizeEffect(effect.effect) };
  }
  if (effect.kind === "optionalInstead") {
    return {
      ...effect,
      costEffect: normalizeEffect(effect.costEffect),
      baseEffect: normalizeEffect(effect.baseEffect),
      insteadEffect: normalizeEffect(effect.insteadEffect)
    };
  }
  if (effect.kind === "opponentMayMoveCardsBetweenZonesElse") {
    return {
      ...effect,
      ifMovedEffect: normalizeEffect(effect.ifMovedEffect),
      elseEffect: normalizeEffect(effect.elseEffect)
    };
  }
  if (effect.kind === "chooseOne" || effect.kind === "chooseN") {
    return {
      ...effect,
      choices: (effect.choices ?? []).map((choice) => ({ ...choice, effect: normalizeEffect(choice.effect) }))
    };
  }
  if (effect.kind === "optionalChoiceUpgrade") {
    return {
      ...effect,
      costEffect: normalizeEffect(effect.costEffect),
      baseEffect: normalizeEffect(effect.baseEffect),
      upgradedEffect: normalizeEffect(effect.upgradedEffect)
    };
  }
  if (effect.kind === "grantAbility") {
    return {
      ...effect,
      ability: effect.ability ? normalizeAbility(effect.ability) : effect.ability
    };
  }
  if (effect.kind === "predictTopDeckRequiredEnergy") {
    return {
      ...effect,
      successEffect: normalizeEffect(effect.successEffect)
    };
  }
  return effect;
}

export function normalizeCardDefinition(record) {
  const number = compactString(firstDefined(record, ["number", "cardNumber", "card_no", "cardNo"]));
  const id = compactString(firstDefined(record, ["id", "cardId", "card_id"])) || number;
  const type = normalizeCardType(firstDefined(record, ["type", "cardType", "category", "card_category"]));
  const color = normalizeColor(firstDefined(record, ["color", "cardColor", "card_color"]));
  const requiredEnergy = parseRequiredEnergy(firstDefined(record, ["requiredEnergy", "required_energy", "needEnergy", "need_energy"]), color);
  const generatedEnergy = firstDefined(record, ["energy", "generatedEnergy", "generated_energy", "energyIcons"]);
  const bp = type === CARD_TYPES.CHARACTER ? parseInteger(firstDefined(record, ["bp", "BP"]), 0) : undefined;
  const abilities = parseAbilityJson(firstDefined(record, ["abilities", "abilitiesJson", "effectJson"])).map(normalizeAbility);
  const staticModifiers = parseJsonArray(firstDefined(record, ["staticModifiers", "static_modifiers"]));
  const staticFieldModifiers = parseJsonArray(firstDefined(record, ["staticFieldModifiers", "static_field_modifiers"]));
  const staticEnergyModifiers = parseJsonArray(firstDefined(record, ["staticEnergyModifiers", "static_energy_modifiers"]));
  const staticKeywordModifiers = parseJsonArray(firstDefined(record, ["staticKeywordModifiers", "static_keyword_modifiers"]));
  const staticFieldKeywordModifiers = parseJsonArray(firstDefined(record, ["staticFieldKeywordModifiers", "static_field_keyword_modifiers"]));
  const useCostModifiers = parseJsonArray(firstDefined(record, ["useCostModifiers", "use_cost_modifiers"]));
  const staticUseCostModifiers = parseJsonArray(firstDefined(record, ["staticUseCostModifiers", "static_use_cost_modifiers"]));
  const choiceModeAssists = parseJsonArray(firstDefined(record, ["choiceModeAssists", "choice_mode_assists"]));
  const triggerReplacements = parseJsonArray(firstDefined(record, ["triggerReplacements", "trigger_replacements"]))
    .map((replacement) => ({ ...replacement, effect: normalizeEffect(replacement.effect) }));
  const rawWhenUsingEffect = firstDefined(record, ["whenUsingEffect", "when_using_effect"]);
  const whenUsingEffect = rawWhenUsingEffect
    ? normalizeEffect(typeof rawWhenUsingEffect === "string" ? JSON.parse(rawWhenUsingEffect) : rawWhenUsingEffect)
    : undefined;

  const card = {
    id,
    number,
    sourceCode: compactString(firstDefined(record, ["sourceCode", "source_code"])) || sourceCodeFromNumber(number),
    name: compactString(firstDefined(record, ["name", "cardName", "card_name"])),
    alternateNames: parseJsonArray(firstDefined(record, ["alternateNames", "alternate_names"])),
    type,
    title: compactString(firstDefined(record, ["title", "sourceTitle", "source_title"])),
    color,
    requiredEnergy,
    apCost: parseInteger(firstDefined(record, ["apCost", "ap_cost", "actionPointCost"]), 0),
    bp,
    energy: parseEnergyIcons(generatedEnergy, type !== CARD_TYPES.EVENT ? color : undefined),
    affinities: splitList(firstDefined(record, ["affinities", "affinity"])),
    keywords: parseKeywordEffects(firstDefined(record, ["keywords", "keywordEffect", "keyword_effect"])),
    trigger: parseTrigger(firstDefined(record, ["trigger", "triggerEffect", "trigger_effect"])),
    whenUsingEffect,
    entersActiveOnUseEffect: Boolean(firstDefined(record, ["entersActiveOnUseEffect", "enters_active_on_use_effect"])),
    abilities,
    staticModifiers,
    staticFieldModifiers,
    staticEnergyModifiers,
    staticKeywordModifiers,
    staticFieldKeywordModifiers,
    useCostModifiers,
    staticUseCostModifiers,
    choiceModeAssists,
    triggerReplacements,
    gainsBaseAbilityTimings: parseJsonArray(firstDefined(record, ["gainsBaseAbilityTimings", "gains_base_ability_timings"])),
    deckCopyLimit: parseOptionalInteger(firstDefined(record, ["deckCopyLimit", "deck_copy_limit"])),
    maximumHandSize: parseOptionalInteger(firstDefined(record, ["maximumHandSize", "maximum_hand_size"])),
    lineCapacityModifiers: parseJsonArray(firstDefined(record, ["lineCapacityModifiers", "line_capacity_modifiers"])),
    targetingRestrictions: parseJsonArray(firstDefined(record, ["targetingRestrictions", "targeting_restrictions"])),
    abilityProtections: parseJsonArray(firstDefined(record, ["abilityProtections", "ability_protections"])),
    raidTargetPermissions: parseJsonArray(firstDefined(record, ["raidTargetPermissions", "raid_target_permissions"])),
    raidUseCondition: firstDefined(record, ["raidUseCondition", "raid_use_condition"]),
    raidOnlyPlay: Boolean(firstDefined(record, ["raidOnlyPlay", "raid_only_play"])),
    returnRaidStackToHandOnReturn: Boolean(firstDefined(record, ["returnRaidStackToHandOnReturn", "return_raid_stack_to_hand_on_return"])),
    sidelineTopRaidCardInstead: Boolean(firstDefined(record, ["sidelineTopRaidCardInstead", "sideline_top_raid_card_instead"])),
    battleLosersToRemovalInstead: Boolean(firstDefined(record, ["battleLosersToRemovalInstead", "battle_losers_to_removal_instead"])),
    battleLosersToEnergyInstead: Boolean(firstDefined(record, ["battleLosersToEnergyInstead", "battle_losers_to_energy_instead"])),
    freeExtraDrawFromFrontLine: Boolean(firstDefined(record, ["freeExtraDrawFromFrontLine", "free_extra_draw_from_front_line"])),
    selfTriggerAlternatives: parseJsonArray(firstDefined(record, ["selfTriggerAlternatives", "self_trigger_alternatives"]))
      .map((alternative) => ({ ...alternative, effect: normalizeEffect(alternative.effect) })),
    opponentAbilityLeaveReplacement: firstDefined(record, ["opponentAbilityLeaveReplacement", "opponent_ability_leave_replacement"]),
    returnToHandHandSidelineInstead: Boolean(firstDefined(record, ["returnToHandHandSidelineInstead", "return_to_hand_hand_sideline_instead"])),
    topRaidCardToSidelineInsteadOnOpponentLeave: Boolean(firstDefined(record, ["topRaidCardToSidelineInsteadOnOpponentLeave", "top_raid_card_to_sideline_instead_on_opponent_leave"])),
    topRaidReplacementBaseRequiredEnergyMin: parseOptionalInteger(firstDefined(record, ["topRaidReplacementBaseRequiredEnergyMin", "top_raid_replacement_base_required_energy_min"])),
    sidelineInsteadForFrontGoreinu: Boolean(firstDefined(record, ["sidelineInsteadForFrontGoreinu", "sideline_instead_for_front_goreinu"])),
    moveToEnergyInsteadOnOpponentAbilityLeave: Boolean(firstDefined(record, ["moveToEnergyInsteadOnOpponentAbilityLeave", "move_to_energy_instead_on_opponent_ability_leave"])),
    moveToEnergyInsteadOnOpponentAbilityBpReduction: Boolean(firstDefined(record, ["moveToEnergyInsteadOnOpponentAbilityBpReduction", "move_to_energy_instead_on_opponent_ability_bp_reduction"])),
    cannotEnterFrontLine: Boolean(firstDefined(record, ["cannotEnterFrontLine", "cannot_enter_front_line"])),
    cannotEnterEnergyLine: Boolean(firstDefined(record, ["cannotEnterEnergyLine", "cannot_enter_energy_line"])),
    cannotPlayToFrontLine: Boolean(firstDefined(record, ["cannotPlayToFrontLine", "cannot_play_to_front_line"])),
    cannotPlayToEnergyLine: Boolean(firstDefined(record, ["cannotPlayToEnergyLine", "cannot_play_to_energy_line"])),
    cannotMoveDuringMovementPhase: Boolean(firstDefined(record, ["cannotMoveDuringMovementPhase", "cannot_move_during_movement_phase"])),
    frontLineMoveByOwnAbilityOnly: Boolean(firstDefined(record, ["frontLineMoveByOwnAbilityOnly", "front_line_move_by_own_ability_only"])),
    frontLineEntryCondition: firstDefined(record, ["frontLineEntryCondition", "front_line_entry_condition"]),
    opponentAbilityRemovalProtection: Boolean(firstDefined(record, ["opponentAbilityRemovalProtection", "opponent_ability_removal_protection"])),
    abilityReturnToHandProtection: Boolean(firstDefined(record, ["abilityReturnToHandProtection", "ability_return_to_hand_protection"])),
    entersActive: Boolean(firstDefined(record, ["entersActive", "enters_active"])),
    entersActiveCondition: firstDefined(record, ["entersActiveCondition", "enters_active_condition"]),
    rarity: compactString(firstDefined(record, ["rarity", "rare"])),
    product: compactString(firstDefined(record, ["product", "series"]))
  };

  const raid = firstDefined(record, ["raid", "raidJson"]);
  if (raid) {
    card.raid = typeof raid === "string" ? JSON.parse(raid) : raid;
  }

  const eventEffect = firstDefined(record, ["eventEffect", "eventEffectJson"]);
  if (eventEffect) {
    card.eventEffect = normalizeEffect(typeof eventEffect === "string" ? JSON.parse(eventEffect) : eventEffect);
  }

  return pruneUndefined(card);
}

export function normalizeCatalog(input) {
  const records = Array.isArray(input) ? input : Object.values(input);
  const catalog = {};
  for (const record of records) {
    const card = normalizeCardDefinition(record);
    if (card.type === "actionPoint") continue;
    catalog[card.id] = card;
  }
  return catalog;
}

export function validateCardDefinition(card) {
  assertRule(card.id, "CARD_ID", "Card definition requires an id.");
  assertRule(card.number, "CARD_NUMBER", `Card ${card.id} requires a card number.`);
  assertRule(card.name, "CARD_NAME", `Card ${card.id} requires a name.`);
  assertRule(Object.values(CARD_TYPES).includes(card.type), "CARD_TYPE", `Card ${card.id} has an unsupported type.`);
  assertRule(card.requiredEnergy?.amount >= 0, "REQUIRED_ENERGY", `Card ${card.id} needs required energy data.`);
  assertRule(card.apCost >= 0, "AP_COST", `Card ${card.id} needs AP cost data.`);
  if (card.type === CARD_TYPES.CHARACTER) {
    assertRule(Number.isFinite(card.bp), "BP", `Character ${card.id} needs BP.`);
  }
  return true;
}

export function validateCatalog(catalog) {
  for (const card of Object.values(catalog)) validateCardDefinition(card);
  return true;
}

function pruneUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== ""));
}
