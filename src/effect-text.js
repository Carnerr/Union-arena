import { CARD_TYPES, LINES, TIMINGS, TRIGGER_TYPES } from "./constants.js";

const NUMBER_WORDS = new Map([
  ["zero", 0],
  ["a", 1],
  ["an", 1],
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
  ["eleven", 11],
  ["twelve", 12],
  ["thirteen", 13],
  ["fourteen", 14],
  ["fifteen", 15]
]);

const TIMING_MAP = new Map([
  ["when played", TIMINGS.WHEN_PLAYED],
  ["when attacking", TIMINGS.WHEN_ATTACKING],
  ["when blocking", TIMINGS.WHEN_BLOCKING],
  ["when sidelined", TIMINGS.WHEN_SIDELINED],
  ["activate: main", TIMINGS.ACTIVATE_MAIN],
  ["start of end phase", TIMINGS.START_OF_END_PHASE]
]);

const KEYWORD_TAGS = [
  "step",
  "snipe",
  "double block",
  "double attack",
  "nullify impact"
];

export function cleanUnionArenaText(value) {
  if (!value || value === "-") return "";
  return String(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/&nbsp;/gi, " ")
    .replace(/Ã£ÂƒÂ»/g, "\n- ")
    .replace(/ãƒ»/g, "\n- ")
    .replace(/\u30fb/g, "\n- ")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
}

export function compactEffectText(value) {
  return cleanUnionArenaText(value)
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function encodeEgmanCardText(card) {
  const effectText = cleanUnionArenaText(card.effect);
  const triggerText = cleanUnionArenaText(card.trigger);
  const unsupported = [];
  const encoded = {};

  const trigger = encodeTriggerText(triggerText);
  if (trigger.trigger) encoded.triggerEffect = trigger.trigger;
  unsupported.push(...trigger.unsupported);

  const raid = parseRaidDefinition(effectText);
  if (raid) encoded.raid = raid;

  if (/if this character is returned from your field to your hand,\s*return this raided character and its base card to your hand instead/i.test(effectText)) {
    encoded.returnRaidStackToHandOnReturn = true;
  }

  if (/when this character is sidelined,\s*you may place this top raided card into your sideline instead/i.test(effectText)) {
    encoded.sidelineTopRaidCardInstead = true;
  }

  if (/opponent's characters that lose to this character in battle are placed into their removal area instead of being sidelined/i.test(effectText)) {
    encoded.battleLosersToRemovalInstead = true;
  }

  if (/\[during your turn\]\s*if this character is returned from your field to your hand,\s*you may place one card from your hand into your sideline instead/i.test(effectText)) {
    encoded.returnToHandHandSidelineInstead = true;
  }

  if (/if the base card of this raided character has 4 or more required energy,\s*this character gains all abilities listed below/i.test(effectText)
    && /if this character leaves the field due to one of your opponent's abilities or battle,\s*you may place one card from your hand into your sideline instead/i.test(effectText)
    && /if you do,\s*place the top card from this raided character into your sideline/i.test(effectText)) {
    encoded.topRaidCardToSidelineInsteadOnOpponentLeave = true;
    encoded.topRaidReplacementBaseRequiredEnergyMin = 4;
  }

  if (/\[#?if on (?:the )?energy line#?\]\s*if a <goreinu> with 500 or more bp on your front line would be sidelined,\s*you may sideline this character instead/i.test(effectText)
    && /if you do,\s*move that <goreinu> to your energy line/i.test(effectText)) {
    encoded.sidelineInsteadForFrontGoreinu = true;
  }

  if (/\[if on (?:the )?front line\]\s*if this character leaves the field or has its bp reduced due to one of your opponent's abilities,\s*you may move it to your energy line instead/i.test(effectText)) {
    encoded.moveToEnergyInsteadOnOpponentAbilityLeave = true;
    encoded.moveToEnergyInsteadOnOpponentAbilityBpReduction = true;
  }

  if (/this card cannot be played onto or moved to your front line/i.test(effectText)) {
    encoded.cannotEnterFrontLine = true;
  }

  const whenUsingActive = compactEffectText(effectText).match(/when using this card,\s*you may (?<cost>place one .+? from your hand into your sideline)\.\s*if you do,\s*play this character set to active onto your field/i);
  if (whenUsingActive) {
    const cost = encodeEffectBody(whenUsingActive.groups.cost, { cardName: card.name });
    if (cost.effect && cost.effect.kind !== "none" && cost.effect.kind !== "unsupported") {
      encoded.whenUsingEffect = {
        kind: "optional",
        choiceKey: "optionalWhenUsingEffect",
        default: true,
        effect: cost.effect
      };
      encoded.entersActiveOnUseEffect = true;
    }
    unsupported.push(...cost.unsupported);
  }

  const staticKeywords = parseStaticKeywords(effectText);
  if (/not affected by bp-reducing abilities/i.test(effectText)) {
    staticKeywords.bpReductionProtection = true;
  }
  if (Object.keys(staticKeywords).length > 0) encoded.keywords = staticKeywords;

  const baseAbilityTimings = parseBaseAbilityTimingGrants(effectText);
  if (baseAbilityTimings.length > 0) encoded.gainsBaseAbilityTimings = baseAbilityTimings;

  const staticKeywordModifiers = parseStaticKeywordModifiers(effectText);
  if (staticKeywordModifiers.length > 0) encoded.staticKeywordModifiers = staticKeywordModifiers;

  const staticModifiers = parseStaticModifiers(effectText);
  if (staticModifiers.length > 0) encoded.staticModifiers = staticModifiers;

  const staticFieldModifiers = parseStaticFieldModifiers(effectText);
  if (staticFieldModifiers.length > 0) encoded.staticFieldModifiers = staticFieldModifiers;

  const staticFieldKeywordModifiers = parseStaticFieldKeywordModifiers(effectText);
  if (staticFieldKeywordModifiers.length > 0) encoded.staticFieldKeywordModifiers = staticFieldKeywordModifiers;

  const staticEnergyModifiers = parseStaticEnergyModifiers(effectText);
  if (staticEnergyModifiers.length > 0) encoded.staticEnergyModifiers = staticEnergyModifiers;

  const useCostModifiers = parseUseCostModifiersV2(effectText);
  if (useCostModifiers.length > 0) encoded.useCostModifiers = useCostModifiers;

  const staticUseCostModifiers = parseStaticUseCostModifiers(effectText);
  if (staticUseCostModifiers.length > 0) encoded.staticUseCostModifiers = staticUseCostModifiers;

  const choiceModeAssists = parseChoiceModeAssists(effectText);
  if (choiceModeAssists.length > 0) encoded.choiceModeAssists = choiceModeAssists;

  const triggerReplacements = parseTriggerReplacements(effectText);
  if (triggerReplacements.length > 0) encoded.triggerReplacements = triggerReplacements;

  const entersActiveCondition = parseConditionalEntersActive(effectText);
  if (entersActiveCondition) {
    encoded.entersActiveCondition = entersActiveCondition;
  } else if (/play this (?:character|site|card) set to active/i.test(effectText) && !encoded.entersActiveOnUseEffect) {
    encoded.entersActive = true;
  }

  if (String(card.category).toLowerCase() === "event") {
    const event = encodeEffectBody(effectText, { cardName: card.name, source: "event" });
    if (event.effect && event.effect.kind !== "none") encoded.eventEffect = event.effect;
    unsupported.push(...event.unsupported);
  } else {
    const abilities = parseAbilitySections(effectText, { cardName: card.name });
    abilities.abilities.push(...parseLeaveFieldCostReductionAbilities(effectText, { cardName: card.name }));
    abilities.abilities.push(...parseLeaveFieldTriggeredAbilities(effectText, { cardName: card.name, unsupported }));
    abilities.abilities.push(...parseDeckToSidelineTriggeredAbilities(effectText, { cardName: card.name, unsupported }));
    abilities.abilities.push(...parseHandToSidelineTriggeredAbilities(effectText, { cardName: card.name, unsupported }));
    abilities.abilities.push(...parseFieldHandToSidelineTriggeredAbilities(effectText, { cardName: card.name, unsupported }));
    abilities.abilities.push(...parseRestedByAbilityTriggeredAbilities(effectText, { cardName: card.name, unsupported }));
    abilities.abilities.push(...parseSidelineToHandTriggeredAbilities(effectText, { cardName: card.name, unsupported }));
    abilities.abilities.push(...parseChosenByAbilityTriggeredAbilities(effectText, { cardName: card.name, unsupported }));
    abilities.abilities.push(...parseFieldMovementTriggeredAbilities(effectText, { cardName: card.name, unsupported }));
    abilities.abilities.push(...parseOpponentActivateMainTriggeredAbilities(effectText, { cardName: card.name, unsupported }));
    abilities.abilities.push(...parseCharacterSidelinedTriggeredAbilities(effectText, { cardName: card.name, unsupported }));
    abilities.abilities.push(...parseReturnedToHandTriggeredAbilities(effectText, { cardName: card.name, unsupported }));
    abilities.abilities.push(...parseStartOfTurnTriggeredAbilities(effectText, { cardName: card.name, unsupported }));
    abilities.abilities.push(...parseRaidedTriggeredAbilities(effectText, { cardName: card.name, unsupported }));
    abilities.abilities.push(...parseCombatTriggeredAbilities(effectText, { cardName: card.name, unsupported }));
    abilities.abilities.push(...parseFieldAttackTriggeredAbilities(effectText, { cardName: card.name, unsupported }));
    abilities.abilities.push(...parseAttackPhaseTriggeredAbilities(effectText, { cardName: card.name, unsupported }));
    abilities.abilities.push(...parseHandStartAttackPhaseTriggeredAbilities(effectText, { cardName: card.name, unsupported }));
    abilities.abilities.push(...parseLifeToSidelineTriggeredAbilities(effectText, { cardName: card.name, unsupported }));
    if (abilities.abilities.length > 0) encoded.abilities = abilities.abilities;
    unsupported.push(...abilities.unsupported);
  }

  return {
    fields: encoded,
    coverage: {
      hasEffectText: Boolean(effectText),
      hasTriggerText: Boolean(triggerText),
      unsupported
    }
  };
}

export function encodeTriggerText(rawText) {
  const text = compactEffectText(rawText);
  const unsupported = [];
  if (!text) return { trigger: undefined, unsupported };

  const lower = text.toLowerCase();
  if (lower.includes("[get]")) return { trigger: { type: TRIGGER_TYPES.GET }, unsupported };
  if (lower.includes("[draw]")) return { trigger: { type: TRIGGER_TYPES.DRAW, amount: 1 }, unsupported };
  if (lower.includes("[raid]")) return { trigger: { type: "raid" }, unsupported };

  if (lower.includes("[active]")) {
    return {
      trigger: {
        type: TRIGGER_TYPES.ACTIVE,
        effect: {
          kind: "sequence",
          effects: [
            {
              kind: "readyTargets",
              target: {
                controller: "self",
                line: "field",
                type: CARD_TYPES.CHARACTER,
                max: 1,
                choiceKey: "activeTarget"
              }
            },
            {
              kind: "modifyBp",
              amount: 3000,
              duration: "turn",
              target: {
                controller: "self",
                line: "field",
                type: CARD_TYPES.CHARACTER,
                max: 1,
                choiceKey: "activeTarget"
              }
            }
          ]
        }
      },
      unsupported
    };
  }

  if (lower.includes("[special]")) {
    return {
      trigger: {
        type: TRIGGER_TYPES.SPECIAL,
        effect: {
          kind: "sidelineTargets",
          target: opponentFrontCharacter({ max: 1, choiceKey: "specialTarget" })
        }
      },
      unsupported
    };
  }

  if (lower.includes("[final]")) {
    return {
      trigger: {
        type: TRIGGER_TYPES.FINAL,
        effect: { kind: "recoverLifeIfEmpty", amount: 1 }
      },
      unsupported
    };
  }

  if (lower.includes("[color]")) {
    const colorEffect = encodeColorTrigger(text);
    unsupported.push(...colorEffect.unsupported);
    return {
      trigger: {
        type: TRIGGER_TYPES.COLOR,
        effect: colorEffect.effect
      },
      unsupported
    };
  }

  unsupported.push({ kind: "trigger", reason: "unrecognized-trigger", sample: clip(text) });
  return {
    trigger: { type: TRIGGER_TYPES.NONE },
    unsupported
  };
}

function encodeColorTrigger(text) {
  const lower = text.toLowerCase();
  const unsupported = [];

  const bpReturnMatch = lower.match(/character with (\d+) or less bp .* return it to their hand/);
  if (bpReturnMatch) {
    return {
      effect: {
        kind: "returnTargetsToHand",
        target: opponentFrontCharacter({
          max: 1,
          bpMax: Number(bpReturnMatch[1]),
          choiceKey: "colorTarget"
        })
      },
      unsupported
    };
  }

  const bpSidelineMatch = lower.match(/character with (\d+) or less bp .* sideline it/);
  if (bpSidelineMatch) {
    return {
      effect: {
        kind: "sidelineTargets",
        target: opponentFrontCharacter({
          max: 1,
          bpMax: Number(bpSidelineMatch[1]),
          choiceKey: "colorTarget"
        })
      },
      unsupported
    };
  }

  if (lower.includes("switch it to resting")) {
    return {
      effect: {
        kind: "restTargets",
        preventNextReady: true,
        target: opponentFrontCharacter({ max: 1, choiceKey: "colorTarget" })
      },
      unsupported
    };
  }

  const playEffect = encodePlayCharacterFromZone(lower, "colorZoneIndex");
  if (playEffect) return { effect: playEffect, unsupported };

  unsupported.push({ kind: "trigger", reason: "color-play-from-zone", sample: clip(text) });
  return { effect: { kind: "unsupported", reason: "color-play-from-zone" }, unsupported };
}

function parseRaidDefinition(text) {
  const match = text.match(/\[Raid\]\s*<([^>]+)>/i);
  if (!match) return undefined;
  return {
    names: match[1]
      .split(/[,/]/)
      .map((name) => name.trim())
      .filter(Boolean),
    affinities: []
  };
}

function parseAbilitySections(rawText, context = {}) {
  const text = cleanUnionArenaText(rawText);
  const unsupported = [];
  const abilities = [];
  if (!text) return { abilities, unsupported };

  const matches = [...text.matchAll(/\[(When Played|When Attacking|When Blocking|When Sidelined|Activate: Main|Start of End Phase)\]/gi)]
    .filter((match) => !isEmbeddedTimingTag(text, match.index));
  const pendingTimings = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const label = match[1].toLowerCase();
    const timing = TIMING_MAP.get(label);
    if (!timing) continue;

    const next = matches[index + 1]?.index ?? text.length;
    let body = text.slice(match.index + match[0].length, next).trim();
    if (!body) {
      pendingTimings.push(timing);
      continue;
    }
    const timings = [...pendingTimings, timing];
    pendingTimings.length = 0;

    const parsedCost = parseAbilityCost(body);
    body = parsedCost.body;
    const parsedLimit = parseSharedOncePerTurn(body, context);
    body = parsedLimit.body;

    const encoded = encodeEffectBody(body, context);
    unsupported.push(...encoded.unsupported);
    if (!encoded.effect || encoded.effect.kind === "none") continue;

    for (const abilityTiming of timings) {
      abilities.push({
        id: `${abilityTiming}-${abilities.length + 1}`,
        timing: abilityTiming,
        oncePerTurn: parsedCost.oncePerTurn,
        oncePerTurnKey: parsedLimit.oncePerTurnKey,
        conditions: structuredClone(parsedCost.conditions),
        cost: structuredClone(parsedCost.cost),
        effect: structuredClone(encoded.effect)
      });
    }
  }

  return { abilities, unsupported };
}

function isEmbeddedTimingTag(text, index) {
  const prefix = text.slice(Math.max(0, index - 40), index).toLowerCase();
  return /(?:['’]s|its|one|all|an?|the chosen character's|this character's)\s*$/.test(prefix);
}

function parseAbilityCost(body) {
  const cost = {};
  const conditions = {};
  let oncePerTurn = false;
  let remaining = body;

  if (/\[#?If on (?:the )?Front Line#?\]/i.test(remaining)) {
    conditions.line = LINES.FRONT;
    remaining = remaining.replace(/\[#?If on (?:the )?Front Line#?\]/gi, "");
  }

  if (/\[#?If on (?:the )?Energy Line#?\]/i.test(remaining)) {
    conditions.line = LINES.ENERGY;
    remaining = remaining.replace(/\[#?If on (?:the )?Energy Line#?\]/gi, "");
  }

  if (/\[#?If in (?:the )?Sideline#?\]/i.test(remaining)) {
    conditions.zone = "sideline";
    remaining = remaining.replace(/\[#?If in (?:the )?Sideline#?\]/gi, "");
  }

  const sidelineTextCondition = remaining.match(/This ability can only be activated when this card is in your sideline\.?/i);
  if (sidelineTextCondition) {
    conditions.zone = "sideline";
    remaining = remaining.replace(sidelineTextCondition[0], "");
  }

  const ownFieldNameOrAffinity = remaining.match(/You can only activate this ability if <([^>]+)> or a \[([^\]]+)\] affinity card is on your field\.?/i);
  if (ownFieldNameOrAffinity) {
    conditions.fieldAnyOf = [
      { name: ownFieldNameOrAffinity[1] },
      { affinity: ownFieldNameOrAffinity[2] }
    ];
    remaining = remaining.replace(ownFieldNameOrAffinity[0], "");
  }

  const ownFieldName = remaining.match(/You can only activate this ability if <([^>]+)> is on your field\.?/i);
  if (ownFieldName) {
    conditions.fieldAnyOf = [{ name: ownFieldName[1] }];
    remaining = remaining.replace(ownFieldName[0], "");
  }

  const energyGeneration = remaining.match(/You can only activate this ability if you have\s+(\w+|\d+)\s+or more energy generation\.?/i);
  if (energyGeneration) {
    conditions.energyGenerationMin = numberFromText(energyGeneration[1], 0);
    remaining = remaining.replace(energyGeneration[0], "");
  }

  const selfFaceDownUnderCondition = remaining.match(/You can only activate this ability if this (?:character|site|card) has a face-down card under it\.?/i);
  if (selfFaceDownUnderCondition) {
    conditions.hasFaceDownUnder = true;
    remaining = remaining.replace(selfFaceDownUnderCondition[0], "");
  }

  const historyCondition = remaining.match(/You can only activate this ability if (?:a character on (?:your|your opponent's) field has been sidelined this turn|you have paid an AP cost for an ability on one of your characters this turn)\.?/i);
  if (historyCondition) {
    conditions.history = "notTracked";
    remaining = remaining.replace(historyCondition[0], "");
  }

  const playedThisTurnCondition = remaining.match(/You can only activate this ability on the turn this character is played\.?/i);
  if (playedThisTurnCondition) {
    conditions.playedThisTurn = true;
    remaining = remaining.replace(playedThisTurnCondition[0], "");
  }

  if (/\[Switch to Resting\]/i.test(remaining)) {
    cost.restSelf = true;
    remaining = remaining.replace(/\[Switch to Resting\]/gi, "");
  }

  if (/\[Sideline This Card\]/i.test(remaining)) {
    cost.sidelineSelf = true;
    remaining = remaining.replace(/\[Sideline This Card\]/gi, "");
  }

  const apCostMatch = remaining.match(/\[Pay\s+(\w+|\d+)\s+AP\]/i);
  if (apCostMatch) {
    cost.ap = numberFromText(apCostMatch[1], 1);
    remaining = remaining.replace(apCostMatch[0], "");
  }

  const discardCostMatch = remaining.match(/\[Place\s+(\w+|\d+)\s+Cards?\s+From Hand Into Sideline\]/i);
  if (discardCostMatch) {
    cost.discardFromHand = numberFromText(discardCostMatch[1], 1);
    remaining = remaining.replace(discardCostMatch[0], "");
  }

  if (/\[Once Per Turn\]/i.test(remaining)) {
    oncePerTurn = true;
    remaining = remaining.replace(/\[Once Per Turn\]/gi, "");
  }

  return {
    body: remaining.trim(),
    oncePerTurn,
    conditions: Object.keys(conditions).length > 0 ? conditions : undefined,
    cost: Object.keys(cost).length > 0 ? cost : undefined
  };
}

function parseSharedOncePerTurn(body, context = {}) {
  const match = body.match(/you can only activate this <([^>]+)> ability one time each turn\.?/i);
  if (!match) return { body };
  return {
    body: body.replace(match[0], "").trim(),
    oncePerTurnKey: `${match[1] || context.cardName}:shared-ability`
  };
}

function parseLeaveFieldCostReductionAbilities(rawText, context = {}) {
  const text = normalizeCostText(rawText);
  const match = text.match(/\[during your turn\]\s*when this character is sidelined or returned to your hand from your field,\s*reduce the required energy of all <([^>]+)> cards in your hand by\s*\[(red|blue|green|yellow|purple)\s*x\s*(\d+)\]\s*this turn until the next <[^>]+> is played onto your field/);
  if (!match) return [];

  const effect = {
    kind: "conditional",
    condition: { turn: "controller" },
    effect: {
      kind: "reduceRequiredEnergy",
      amount: Number(match[3]),
      sourceZone: "hand",
      expires: "endOfTurn",
      consumeOnUse: true,
      filter: { name: match[1] }
    }
  };

  return [
    {
      id: `${TIMINGS.WHEN_SIDELINED}-${context.cardName ?? "card"}-cost-reduction`,
      timing: TIMINGS.WHEN_SIDELINED,
      oncePerTurn: false,
      effect: structuredClone(effect)
    },
    {
      id: `${TIMINGS.WHEN_RETURNED_TO_HAND}-${context.cardName ?? "card"}-cost-reduction`,
      timing: TIMINGS.WHEN_RETURNED_TO_HAND,
      oncePerTurn: false,
      effect
    }
  ];
}

function parseLeaveFieldTriggeredAbilities(rawText, context = {}) {
  const text = compactEffectText(rawText);
  const unsupported = context.unsupported ?? [];
  const abilities = [];
  if (!text) return abilities;

  const pattern = /when this character leaves the field due to (?:battle|one of your or your opponent's abilities|battle or one of your or your opponent's abilities),\s*(?<body>.*?)(?=(?:\s+\[(?:Raid|When Played|When Attacking|When Blocking|When Sidelined|Activate: Main|Start of End Phase)\])|$)/gi;
  for (const match of text.matchAll(pattern)) {
    const parsedLimit = parseSharedOncePerTurn(match.groups.body.replace(/\.$/, "").trim(), context);
    const encoded = encodeEffectBody(parsedLimit.body, { ...context, allowChoice: true });
    unsupported.push(...encoded.unsupported);
    if (!encoded.effect || encoded.effect.kind === "none" || encoded.effect.kind === "unsupported") continue;

    abilities.push({
      id: `${TIMINGS.WHEN_LEAVES_FIELD}-${abilities.length + 1}`,
      timing: TIMINGS.WHEN_LEAVES_FIELD,
      oncePerTurn: false,
      effect: encoded.effect,
      ...(parsedLimit.oncePerTurnKey ? { oncePerTurnKey: parsedLimit.oncePerTurnKey } : {})
    });
  }

  const selfPattern = /(?<prefix>(?:\[[^\]]+\]\s*)*)when this character moves outside of your movement phase,\s*(?<body>.*?)(?=(?:\s+\[(?:Raid|When Played|When Attacking|When Blocking|When Sidelined|Activate: Main|Start of End Phase)\])|$)/gi;
  for (const match of text.matchAll(selfPattern)) {
    const prefix = match.groups.prefix ?? "";
    const parsedCost = parseAbilityCost(`${prefix} ${match.groups.body ?? ""}`.trim());
    const conditions = { movedPermanentSelf: true, ...(parsedCost.conditions ?? {}) };
    if (/\[During Your Turn\]/i.test(prefix)) conditions.turn = "controller";
    if (/\[During Opponent's Turn\]/i.test(prefix)) conditions.turn = "opponent";

    const encoded = encodeEffectBody(parsedCost.body.replace(/\.$/, "").trim(), { ...context, allowChoice: true });
    unsupported.push(...encoded.unsupported);
    if (!encoded.effect || encoded.effect.kind === "none" || encoded.effect.kind === "unsupported") continue;

    abilities.push({
      id: `${TIMINGS.WHEN_OWN_CHARACTER_MOVES_OUTSIDE_MOVEMENT_PHASE}-${abilities.length + 1}`,
      timing: TIMINGS.WHEN_OWN_CHARACTER_MOVES_OUTSIDE_MOVEMENT_PHASE,
      oncePerTurn: parsedCost.oncePerTurn,
      conditions,
      cost: structuredClone(parsedCost.cost),
      effect: encoded.effect
    });
  }

  return abilities;
}

function parseDeckToSidelineTriggeredAbilities(rawText, context = {}) {
  const text = compactEffectText(rawText);
  const unsupported = context.unsupported ?? [];
  const abilities = [];
  if (!text) return abilities;

  const pattern = /when this card is placed from your deck into your sideline by one of your abilities,\s*(?<body>.*?)(?=(?:\s+\[(?:Raid|When Played|When Attacking|When Blocking|When Sidelined|Activate: Main|Start of End Phase)\])|$)/gi;
  for (const match of text.matchAll(pattern)) {
    const parsedLimit = parseSharedOncePerTurn(match.groups.body.replace(/\.$/, "").trim(), context);
    let body = parsedLimit.body.trim();
    if (/^you may add it to your hand\.?$/i.test(body)) {
      body = "you may add this card to your hand";
    }

    const sidelineRaid = body.match(/^if you have the required energy for it,\s*you may perform raid with it from your sideline\.?$/i);
    if (sidelineRaid) {
      abilities.push({
        id: `${TIMINGS.WHEN_SELF_DECK_TO_SIDELINE_BY_ABILITY}-${abilities.length + 1}`,
        timing: TIMINGS.WHEN_SELF_DECK_TO_SIDELINE_BY_ABILITY,
        oncePerTurn: false,
        conditions: { zone: "sideline" },
        effect: {
          kind: "optional",
          choiceKey: "optionalEffect",
          default: true,
          effect: { kind: "raidSourceFromZone", source: "sideline" }
        },
        ...(parsedLimit.oncePerTurnKey ? { oncePerTurnKey: parsedLimit.oncePerTurnKey } : {})
      });
      continue;
    }

    const encoded = encodeEffectBody(body, { ...context, allowChoice: true });
    unsupported.push(...encoded.unsupported);
    if (!encoded.effect || encoded.effect.kind === "none" || encoded.effect.kind === "unsupported") continue;

    abilities.push({
      id: `${TIMINGS.WHEN_SELF_DECK_TO_SIDELINE_BY_ABILITY}-${abilities.length + 1}`,
      timing: TIMINGS.WHEN_SELF_DECK_TO_SIDELINE_BY_ABILITY,
      oncePerTurn: false,
      conditions: { zone: "sideline" },
      effect: encoded.effect,
      ...(parsedLimit.oncePerTurnKey ? { oncePerTurnKey: parsedLimit.oncePerTurnKey } : {})
    });
  }

  return abilities;
}

function parseHandToSidelineTriggeredAbilities(rawText, context = {}) {
  const text = compactEffectText(rawText);
  const unsupported = context.unsupported ?? [];
  const abilities = [];
  if (!text) return abilities;

  const pattern = /when this card is placed from your hand into your sideline(?<source>[^,]*),\s*(?<body>.*?)(?=(?:\s+\[(?:Raid|When Played|When Attacking|When Blocking|When Sidelined|Activate: Main|Start of End Phase)\])|$)/gi;
  for (const match of text.matchAll(pattern)) {
    let body = match.groups.body.replace(/\.$/, "").trim();
    const conditions = { zone: "sideline" };
    const sourceFilter = parseHandToSidelineSourceFilter(match.groups.source);
    if (sourceFilter) conditions.handToSidelineSource = sourceFilter;

    const conditional = body.match(/^if (.+?),\s*(.+)$/i);
    if (conditional) {
      const condition = parseConditionOnly(`if ${conditional[1].toLowerCase()}`);
      if (!condition || condition.history) {
        unsupported.push(clip(match[0]));
        continue;
      }
      Object.assign(conditions, condition);
      body = conditional[2].trim();
    }

    const encoded = encodeEffectBody(body, { ...context, allowChoice: true });
    unsupported.push(...encoded.unsupported);
    if (!encoded.effect || encoded.effect.kind === "none" || encoded.effect.kind === "unsupported") continue;

    abilities.push({
      id: `${TIMINGS.WHEN_HAND_TO_SIDELINE_BY_ABILITY}-${abilities.length + 1}`,
      timing: TIMINGS.WHEN_HAND_TO_SIDELINE_BY_ABILITY,
      oncePerTurn: false,
      conditions,
      effect: encoded.effect
    });
  }

  return abilities;
}

function parseSidelineToHandTriggeredAbilities(rawText, context = {}) {
  const text = compactEffectText(rawText);
  const unsupported = context.unsupported ?? [];
  const abilities = [];
  if (!text) return abilities;

  const pattern = /when this card is added from (?:your )?sideline to your hand by one of your abilities,\s*(?<body>.*?)(?=(?:\s+this card cannot)|(?:\s+\[(?:Raid|When Played|When Attacking|When Blocking|When Sidelined|Activate: Main|Start of End Phase)\])|$)/gi;
  for (const match of text.matchAll(pattern)) {
    const parsedLimit = parseSharedOncePerTurn(match.groups.body.replace(/\.$/, "").trim(), context);
    let effect;
    if (/^you may play it set to resting onto your energy line\.?$/i.test(parsedLimit.body)) {
      effect = {
        kind: "optional",
        choiceKey: "optionalEffect",
        default: true,
        effect: {
          kind: "playSourceFromZone",
          source: "hand",
          rested: true,
          destinationLine: LINES.ENERGY
        }
      };
    }
    const encoded = effect ? { effect, unsupported: [] } : encodeEffectBody(parsedLimit.body, { ...context, allowChoice: true, contextCard: true });
    unsupported.push(...encoded.unsupported);
    if (!encoded.effect || encoded.effect.kind === "none" || encoded.effect.kind === "unsupported") continue;

    abilities.push({
      id: `${TIMINGS.WHEN_SIDELINE_TO_HAND_BY_ABILITY}-${abilities.length + 1}`,
      timing: TIMINGS.WHEN_SIDELINE_TO_HAND_BY_ABILITY,
      oncePerTurn: false,
      conditions: { zone: "hand" },
      effect: encoded.effect,
      ...(parsedLimit.oncePerTurnKey ? { oncePerTurnKey: parsedLimit.oncePerTurnKey } : {})
    });
  }

  return abilities;
}

function parseChosenByAbilityTriggeredAbilities(rawText, context = {}) {
  const text = compactEffectText(rawText);
  const unsupported = context.unsupported ?? [];
  const abilities = [];
  if (!text) return abilities;

  const pattern = /(?<prefix>(?:\[[^\]]+\]\s*)*)when this character is chosen by an ability on one of your \[(?<affinity>[^\]]+)\] affinity cards,\s*(?<body>.*?)(?=(?:\s+\[(?:Raid|When Played|When Attacking|When Blocking|When Sidelined|Activate: Main|Start of End Phase)\])|$)/gi;
  for (const match of text.matchAll(pattern)) {
    const prefix = match.groups.prefix ?? "";
    const parsedLimit = parseSharedOncePerTurn(match.groups.body.replace(/\.$/, "").trim(), context);
    const encoded = encodeEffectBody(parsedLimit.body, { ...context, allowChoice: true });
    unsupported.push(...encoded.unsupported);
    if (!encoded.effect || encoded.effect.kind === "none" || encoded.effect.kind === "unsupported") continue;

    const conditions = {
      chosenPermanentSelf: true,
      chosenBySource: { affinity: match.groups.affinity }
    };
    if (/\[During Your Turn\]/i.test(prefix)) conditions.turn = "controller";
    if (/\[During Opponent's Turn\]/i.test(prefix)) conditions.turn = "opponent";

    abilities.push({
      id: `${TIMINGS.WHEN_CHOSEN_BY_ABILITY}-${abilities.length + 1}`,
      timing: TIMINGS.WHEN_CHOSEN_BY_ABILITY,
      oncePerTurn: parsedLimit.oncePerTurn,
      oncePerTurnKey: parsedLimit.oncePerTurnKey,
      conditions,
      effect: encoded.effect
    });
  }

  return abilities;
}

function parseFieldMovementTriggeredAbilities(rawText, context = {}) {
  const text = compactEffectText(rawText);
  const unsupported = context.unsupported ?? [];
  const abilities = [];
  if (!text) return abilities;

  const pattern = /(?<prefix>(?:\[[^\]]+\]\s*)*)when a character on your field moves outside of your movement phase,\s*(?<body>.*?)(?=(?:\s+\[(?:Raid|When Played|When Attacking|When Blocking|When Sidelined|Activate: Main|Start of End Phase)\])|$)/gi;
  for (const match of text.matchAll(pattern)) {
    const prefix = match.groups.prefix ?? "";
    const parsedCost = parseAbilityCost(`${prefix} ${match.groups.body ?? ""}`.trim());
    const conditions = { ...(parsedCost.conditions ?? {}) };
    if (/\[During Your Turn\]/i.test(prefix)) conditions.turn = "controller";
    if (/\[During Opponent's Turn\]/i.test(prefix)) conditions.turn = "opponent";

    const encoded = encodeEffectBody(parsedCost.body.replace(/\.$/, "").trim(), { ...context, allowChoice: true });
    unsupported.push(...encoded.unsupported);
    if (!encoded.effect || encoded.effect.kind === "none" || encoded.effect.kind === "unsupported") continue;

    abilities.push({
      id: `${TIMINGS.WHEN_OWN_CHARACTER_MOVES_OUTSIDE_MOVEMENT_PHASE}-${abilities.length + 1}`,
      timing: TIMINGS.WHEN_OWN_CHARACTER_MOVES_OUTSIDE_MOVEMENT_PHASE,
      oncePerTurn: parsedCost.oncePerTurn,
      conditions: Object.keys(conditions).length > 0 ? conditions : undefined,
      cost: structuredClone(parsedCost.cost),
      effect: encoded.effect
    });
  }

  return abilities;
}

function parseOpponentActivateMainTriggeredAbilities(rawText, context = {}) {
  const text = compactEffectText(rawText);
  const unsupported = context.unsupported ?? [];
  const abilities = [];
  if (!text) return abilities;

  const pattern = /(?<prefix>(?:\[[^\]]+\]\s*)*)when your opponent activates an \[activate: main\] ability,\s*(?<body>.*?)(?=(?:\s+\[(?:Raid|When Played|When Attacking|When Blocking|When Sidelined|Activate: Main|Start of End Phase)\])|$)/gi;
  for (const match of text.matchAll(pattern)) {
    const prefix = match.groups.prefix ?? "";
    const parsedCost = parseAbilityCost(`${prefix} ${match.groups.body ?? ""}`.trim());
    let body = parsedCost.body.replace(/\.$/, "").trim();
    const conditions = { ...(parsedCost.conditions ?? {}) };
    if (/\[During Your Turn\]/i.test(prefix)) conditions.turn = "controller";
    if (/\[During Opponent's Turn\]/i.test(prefix)) conditions.turn = "opponent";

    const conditional = body.match(/^if you have another \[([^\]]+)\] affinity card on your field,\s*(.+)$/i);
    if (conditional) {
      conditions.fieldCountMin = 1;
      conditions.otherThanSource = true;
      conditions.filter = { affinity: conditional[1] };
      body = conditional[2].trim();
    }

    const encoded = encodeEffectBody(body, { ...context, allowChoice: true });
    unsupported.push(...encoded.unsupported);
    if (!encoded.effect || encoded.effect.kind === "none" || encoded.effect.kind === "unsupported") continue;

    abilities.push({
      id: `${TIMINGS.WHEN_OPPONENT_ACTIVATE_MAIN_ABILITY}-${abilities.length + 1}`,
      timing: TIMINGS.WHEN_OPPONENT_ACTIVATE_MAIN_ABILITY,
      oncePerTurn: parsedCost.oncePerTurn,
      conditions: Object.keys(conditions).length > 0 ? conditions : undefined,
      cost: structuredClone(parsedCost.cost),
      effect: encoded.effect
    });
  }

  return abilities;
}

function parseHandToSidelineSourceFilter(value = "") {
  const text = value.toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return undefined;

  let match = text.match(/event or <([^>]+)>/);
  if (match) return { anyOf: [{ type: CARD_TYPES.EVENT }, { name: match[1] }] };

  match = text.match(/(red|blue|green|yellow|purple)\s+<([^>]+)>/);
  if (match) return { color: match[1], name: match[2] };

  match = text.match(/<([^>]+)>\s+or\s+<([^>]+)>/);
  if (match) return { anyOf: [{ name: match[1] }, { name: match[2] }] };

  match = text.match(/<([^>]+)>/);
  if (match) return { name: match[1] };

  if (text.includes("event")) return { type: CARD_TYPES.EVENT };
  return undefined;
}

function parseFieldHandToSidelineTriggeredAbilities(rawText, context = {}) {
  const text = compactEffectText(rawText);
  const unsupported = context.unsupported ?? [];
  const abilities = [];
  if (!text) return abilities;

  const pattern = /(?<prefix>(?:\[[^\]]+\]\s*)*)when (?:you place (?<cardSubject>.+?) from your hand into your sideline with an ability on one of your (?<sourceSubject>.+?) cards|cards are placed from your hand into your sideline by an ability on a (?<sourceSubjectAlt>.+?) on your field),\s*(?<body>.*?)(?=(?:\s+\[(?:Raid|When Played|When Attacking|When Blocking|When Sidelined|Activate: Main|Start of End Phase)\])|$)/gi;
  for (const match of text.matchAll(pattern)) {
    const prefix = match.groups.prefix ?? "";
    const conditions = {
      active: true,
      handToSidelineSource: parseHandToSidelineSourceFilter(match.groups.sourceSubject ?? match.groups.sourceSubjectAlt ?? "") ?? {}
    };
    if (match.groups.cardSubject) {
      conditions.handToSidelineCardFilter = parseHandToSidelineSourceFilter(match.groups.cardSubject) ?? {};
    }
    if (/\[During Your Turn\]/i.test(prefix)) conditions.turn = "controller";
    if (/\[During Opponent's Turn\]/i.test(prefix)) conditions.turn = "opponent";

    const parsedLimit = parseSharedOncePerTurn(match.groups.body.replace(/\.$/, "").trim(), context);
    let body = parsedLimit.body;
    let effect;
    if (/^you may switch this active character to resting\. if you do, add up to one of those cards placed into your sideline to your hand\.?/i.test(body)) {
      effect = {
        kind: "optional",
        choiceKey: "optionalEffect",
        default: true,
        effect: {
          kind: "sequence",
          effects: [
            { kind: "restSelf" },
            { kind: "moveContextCardToZone", source: "sideline", destination: "hand" }
          ]
        }
      };
    } else {
      const encoded = encodeEffectBody(body, { ...context, allowChoice: true });
      unsupported.push(...encoded.unsupported);
      if (!encoded.effect || encoded.effect.kind === "none" || encoded.effect.kind === "unsupported") continue;
      effect = encoded.effect;
    }

    abilities.push({
      id: `${TIMINGS.WHEN_HAND_TO_SIDELINE_BY_ABILITY}-${abilities.length + 1}`,
      timing: TIMINGS.WHEN_HAND_TO_SIDELINE_BY_ABILITY,
      oncePerTurn: false,
      oncePerTurnKey: parsedLimit.oncePerTurnKey,
      conditions,
      effect
    });
  }

  return abilities;
}

function parseRestedByAbilityTriggeredAbilities(rawText, context = {}) {
  const text = compactEffectText(rawText);
  const unsupported = context.unsupported ?? [];
  const abilities = [];
  if (!text) return abilities;

  const pattern = /(?<tags>(?:\[(?:During Your Turn|During Opponent's Turn|Once Per Turn)\]\s*)*)when an active character on your front line is switched to resting by one of your abilities,\s*(?<body>.*?)(?=(?:\s+\[(?:Raid|When Played|When Attacking|When Blocking|When Sidelined|Activate: Main|Start of End Phase)\])|$)/gi;
  for (const match of text.matchAll(pattern)) {
    const tags = `${match.groups.tags ?? ""}`;
    const body = match.groups.body.replace(/\.$/, "").trim();
    const encoded = encodeEffectBody(body, { ...context, allowChoice: true });
    unsupported.push(...encoded.unsupported);
    if (!encoded.effect || encoded.effect.kind === "none" || encoded.effect.kind === "unsupported") continue;

    const conditions = {};
    if (/\[During Your Turn\]/i.test(tags)) conditions.turn = "controller";
    if (/\[During Opponent's Turn\]/i.test(tags)) conditions.turn = "opponent";

    abilities.push({
      id: `${TIMINGS.WHEN_OWN_FRONT_CHARACTER_RESTED_BY_ABILITY}-${abilities.length + 1}`,
      timing: TIMINGS.WHEN_OWN_FRONT_CHARACTER_RESTED_BY_ABILITY,
      oncePerTurn: /\[Once Per Turn\]/i.test(tags),
      conditions: Object.keys(conditions).length > 0 ? conditions : undefined,
      effect: encoded.effect
    });
  }

  return abilities;
}

function parseCharacterSidelinedTriggeredAbilities(rawText, context = {}) {
  const text = compactEffectText(rawText);
  const unsupported = context.unsupported ?? [];
  const abilities = [];
  if (!text) return abilities;

  const pattern = /(?<tags>(?:\[(?:During Your Turn|During Opponent's Turn|Once Per Turn)\]\s*)*)when a character on your opponent's front line is sidelined,\s*(?<body>.*?)(?=(?:\s+\[(?:Raid|When Played|When Attacking|When Blocking|When Sidelined|Activate: Main|Start of End Phase)\])|$)/gi;
  for (const match of text.matchAll(pattern)) {
    const tags = match.groups.tags ?? "";
    const body = match.groups.body.replace(/\.$/, "").trim();
    const conditions = { sidelinedLine: LINES.FRONT };
    if (/\[During Your Turn\]/i.test(tags)) conditions.turn = "controller";
    if (/\[During Opponent's Turn\]/i.test(tags)) conditions.turn = "opponent";

    let effect;
    if (/^you may draw a card\. if you do, place one card from your hand into your sideline$/i.test(body)) {
      effect = {
        kind: "optional",
        choiceKey: "optionalEffect",
        default: true,
        effect: {
          kind: "sequence",
          effects: [
            { kind: "draw", amount: 1 },
            { kind: "moveHandToZone", amount: 1, destination: "sideline" }
          ]
        }
      };
    } else {
      const encoded = encodeEffectBody(body, { ...context, allowChoice: true });
      unsupported.push(...encoded.unsupported);
      if (!encoded.effect || encoded.effect.kind === "none" || encoded.effect.kind === "unsupported") continue;
      effect = encoded.effect;
    }

    abilities.push({
      id: `${TIMINGS.WHEN_OPPONENT_CHARACTER_SIDELINED}-${abilities.length + 1}`,
      timing: TIMINGS.WHEN_OPPONENT_CHARACTER_SIDELINED,
      oncePerTurn: /\[Once Per Turn\]/i.test(tags),
      conditions,
      effect
    });
  }

  return abilities;
}

function parseReturnedToHandTriggeredAbilities(rawText, context = {}) {
  const text = compactEffectText(rawText);
  const unsupported = context.unsupported ?? [];
  const abilities = [];
  if (!text) return abilities;

  const pattern = /when this character is returned to your hand from your field,\s*(?<body>.*?)(?=(?:\s+\[(?:Raid|When Played|When Attacking|When Blocking|When Sidelined|Activate: Main|Start of End Phase)\])|$)/gi;
  for (const match of text.matchAll(pattern)) {
    const body = match.groups.body.replace(/\.$/, "").trim();
    let effect;

    const optionalNamedHandCost = body.match(/^you may place one (?:(red|blue|green|yellow|purple) )?<([^>]+)> card with (\d+) required energy from your hand into your sideline\. if you do,\s*(.+)$/i);
    if (optionalNamedHandCost) {
      const followUp = encodeEffectBody(optionalNamedHandCost[4], { ...context, allowChoice: true });
      unsupported.push(...followUp.unsupported);
      if (!followUp.effect || followUp.effect.kind === "none" || followUp.effect.kind === "unsupported") continue;
      effect = {
        kind: "optional",
        choiceKey: "optionalEffect",
        default: true,
        effect: {
          kind: "sequence",
          effects: [
            {
              kind: "moveHandToZone",
              amount: 1,
              destination: "sideline",
              filter: {
                color: optionalNamedHandCost[1] || undefined,
                name: optionalNamedHandCost[2],
                requiredEnergyMin: Number(optionalNamedHandCost[3]),
                requiredEnergyMax: Number(optionalNamedHandCost[3])
              }
            },
            followUp.effect
          ]
        }
      };
    } else {
      const encoded = encodeEffectBody(body, { ...context, allowChoice: true });
      unsupported.push(...encoded.unsupported);
      if (!encoded.effect || encoded.effect.kind === "none" || encoded.effect.kind === "unsupported") continue;
      effect = encoded.effect;
    }

    abilities.push({
      id: `${TIMINGS.WHEN_RETURNED_TO_HAND}-${abilities.length + 1}`,
      timing: TIMINGS.WHEN_RETURNED_TO_HAND,
      oncePerTurn: false,
      effect
    });
  }

  return abilities;
}

function parseStartOfTurnTriggeredAbilities(rawText, context = {}) {
  const text = compactEffectText(rawText);
  const unsupported = context.unsupported ?? [];
  const abilities = [];
  if (!text) return abilities;

  const pattern = /at the start of your turn,\s*(?<body>.*?)(?=(?:\s+\[(?:Raid|When Played|When Attacking|When Blocking|When Sidelined|Activate: Main|Start of End Phase|During Your Turn|During Opponent's Turn)\])|$)/gi;
  for (const match of text.matchAll(pattern)) {
    const body = match.groups.body.replace(/\.$/, "").trim();
    let effect;
    if (/^place the top card from this raided character into your sideline, then draw a card$/i.test(body)) {
      effect = {
        kind: "sequence",
        effects: [
          { kind: "moveTopRaidCardToZone", destination: "sideline", target: "self" },
          { kind: "draw", amount: 1 }
        ]
      };
    } else {
      const encoded = encodeEffectBody(body, { ...context, allowChoice: true });
      unsupported.push(...encoded.unsupported);
      if (!encoded.effect || encoded.effect.kind === "none" || encoded.effect.kind === "unsupported") continue;
      effect = encoded.effect;
    }

    abilities.push({
      id: `${TIMINGS.START_OF_TURN}-${abilities.length + 1}`,
      timing: TIMINGS.START_OF_TURN,
      oncePerTurn: false,
      effect
    });
  }

  return abilities;
}

function parseRaidedTriggeredAbilities(rawText, context = {}) {
  const text = compactEffectText(rawText)
    .replace(/\(resolve the raided character's \[when played\] abilities? and this ability in any order(?: you want)?\.\)/ig, "");
  const unsupported = context.unsupported ?? [];
  const abilities = [];
  if (!text) return abilities;

  const pattern = /when (?:this character is raided|performing raid on this character),\s*(?<body>.*?)(?=(?:\s+\[(?:Raid|When Played|When Attacking|When Blocking|When Sidelined|Activate: Main|Start of End Phase)\])|$)/gi;
  for (const match of text.matchAll(pattern)) {
    let body = match.groups.body
      .replace(/\(resolve the raided character's \[when played\] abilities and this ability in any order\.\)/ig, "")
      .replace(/\(resolve the raided character's \[when played\] ability and this ability in any order you want\.\)/ig, "")
      .replace(/\.$/, "")
      .trim();
    const conditions = {};
    const conditional = body.match(/^if (.+?),\s*(.+)$/i);
    if (conditional) {
      const parsedCondition = parseConditionOnly(`if ${conditional[1].toLowerCase()}`);
      if (!parsedCondition || parsedCondition.history) {
        unsupported.push(clip(match[0]));
        continue;
      }
      Object.assign(conditions, parsedCondition);
      body = conditional[2].trim();
    }
    const encoded = encodeEffectBody(body, { ...context, allowChoice: true });
    unsupported.push(...encoded.unsupported);
    if (!encoded.effect || encoded.effect.kind === "none" || encoded.effect.kind === "unsupported") continue;

    abilities.push({
      id: `${TIMINGS.WHEN_RAIDED}-${abilities.length + 1}`,
      timing: TIMINGS.WHEN_RAIDED,
      oncePerTurn: false,
      conditions: Object.keys(conditions).length > 0 ? conditions : undefined,
      effect: encoded.effect
    });
  }

  return abilities;
}

function parseCombatTriggeredAbilities(rawText, context = {}) {
  const text = compactEffectText(rawText);
  const unsupported = context.unsupported ?? [];
  const abilities = [];
  if (!text) return abilities;

  const garouReady = text.match(/(?:^|\s)(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|\d+) or more:\s*this character gains \d+ bp and "\s*\[once per turn\]\s*when this character attacks and is not blocked,\s*switch it to active/i);
  if (garouReady) {
    abilities.push({
      id: `${TIMINGS.WHEN_ATTACK_UNBLOCKED}-${abilities.length + 1}`,
      timing: TIMINGS.WHEN_ATTACK_UNBLOCKED,
      oncePerTurn: true,
      conditions: { sidelineCountMin: numberFromText(garouReady[1], 0) },
      effect: { kind: "readySelf" }
    });
  }

  const hiyukiAttackWin = text.match(/if you have (one|two|three|four|five|six|seven|\d+) or more \[([^\]]+)\] affinity cards? on your field,\s*this character gains "\s*\[once per turn\]\s*when this character attacks and wins a battle,\s*if your opponent has 4 or more life,\s*draw a card\.\s*if your opponent has 3 or less life,\s*switch this character to active/i);
  if (hiyukiAttackWin) {
    abilities.push({
      id: `${TIMINGS.WHEN_ATTACK_WINS_BATTLE}-${abilities.length + 1}`,
      timing: TIMINGS.WHEN_ATTACK_WINS_BATTLE,
      oncePerTurn: true,
      conditions: {
        fieldCountMin: numberFromText(hiyukiAttackWin[1], 0),
        filter: { affinity: hiyukiAttackWin[2] }
      },
      effect: {
        kind: "sequence",
        effects: [
          {
            kind: "conditional",
            condition: { opponentLifeMin: 4 },
            effect: { kind: "draw", amount: 1 }
          },
          {
            kind: "conditional",
            condition: { opponentLifeMax: 3 },
            effect: { kind: "readySelf" }
          }
        ]
      }
    });
  }

  const sentences = text
    .split(/(?:(?<=\.)|(?<=\.\)))\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  for (let index = 0; index < sentences.length; index += 1) {
    let sentence = sentences[index];
    if (/\byou may pay \d+ ap\.?$/i.test(sentence) && /^if you do\b/i.test(sentences[index + 1] ?? "")) {
      sentence = `${sentence} ${sentences[index + 1]}`;
      index += 1;
    }
    if (/\byou may\b/i.test(sentence) && /^if you do\b/i.test(sentences[index + 1] ?? "")) {
      sentence = `${sentence} ${sentences[index + 1]}`;
      index += 1;
    }
    if (/^(?:\[[^\]]+\]\s*)*at the end of .*you may\b/i.test(sentence) && /^if you do\b/i.test(sentences[index + 1] ?? "")) {
      sentence = `${sentence} ${sentences[index + 1]}`;
      index += 1;
    }
    if (/^(?:\[[^\]]+\]\s*)*at the end of this character's attack,\s*look at the face-down cards under this character\.?$/i.test(sentence)
      && /^reveal up to two cards among them and add them to your hand\.?$/i.test(sentences[index + 1] ?? "")) {
      sentence = `${sentence} ${sentences[index + 1]}`;
      index += 1;
      if (/^if you add two cards to your hand,\s*switch this character to active\.?$/i.test(sentences[index + 1] ?? "")) {
        sentence = `${sentence} ${sentences[index + 1]}`;
        index += 1;
      }
    }
    if (/^when .*look at the top/i.test(stripEffectTags(sentence)) && /^place /i.test(sentences[index + 1] ?? "")) {
      sentence = `${sentence} ${sentences[index + 1]}`;
      index += 1;
      if (/^choose /i.test(sentences[index + 1] ?? "")) {
        sentence = `${sentence} ${sentences[index + 1]}`;
        index += 1;
      }
      if (/^(?:it|this character) gains /i.test(sentences[index + 1] ?? "")) {
        sentence = `${sentence} ${sentences[index + 1]}`;
        index += 1;
      }
    }

    if (sentence.includes("\"")) {
      if (/when this character attacks and is not blocked/i.test(sentence)
        && /or more:\s*this character gains/i.test(sentence)) continue;
      if (/when this character attacks and wins a battle/i.test(sentence)
        && /affinity cards? on your field/i.test(sentence)) continue;
      const trailingTriggeredSentence = sentence.match(/(?:^|\s)(when this character attacks and is not blocked,\s*[^"]+)$/i)
        ?? sentence.match(/(?:^|\s)(when this character attacks and wins a battle,\s*[^"]+)$/i);
      if (trailingTriggeredSentence) sentence = trailingTriggeredSentence[1].trim();
      else continue;
    }
    if (/^\[(?:When Played|When Attacking|When Blocking|When Sidelined|Activate: Main|Start of End Phase)\]/i.test(sentence)) continue;

    const parsedCost = parseAbilityCost(sentence.replace(/^-\s*/, "").trim());
    let body = parsedCost.body
      .replace(/^\[During Your Turn\]\s*/i, "")
      .replace(/^\[During Opponent's Turn\]\s*/i, "")
      .trim();

    let match = body.match(/^at the end of the battle, if this character was blocking,\s*return it to your hand\.?$/i);
    if (match) {
      abilities.push({
        id: `${TIMINGS.WHEN_BLOCKING}-${abilities.length + 1}`,
        timing: TIMINGS.WHEN_BLOCKING,
        oncePerTurn: parsedCost.oncePerTurn,
        conditions: structuredClone(parsedCost.conditions),
        cost: structuredClone(parsedCost.cost),
        effect: {
          kind: "scheduleReturnTargetsToHand",
          timing: TIMINGS.END_OF_ATTACK,
          target: "self"
        }
      });
      continue;
    }

    let timing;
    let triggeredCondition;
    let triggeredBody;
    match = body.match(/^when this character attacks and wins a battle,\s*(.+)$/i);
    if (match) {
      timing = TIMINGS.WHEN_ATTACK_WINS_BATTLE;
      triggeredBody = match[1];
    } else {
      match = body.match(/^when this character attacks and is blocked,\s*(.+)$/i);
      if (match) {
        timing = TIMINGS.WHEN_ATTACK_BLOCKED;
        triggeredBody = match[1];
      }
    }
    if (!timing) {
      match = body.match(/^when this character attacks and is not blocked,\s*(.+)$/i);
      if (match) {
        timing = TIMINGS.WHEN_ATTACK_UNBLOCKED;
        triggeredBody = match[1];
      }
    }
    if (!timing) {
      match = body.match(/^when (?:a character on your field|one of your characters) attacks and wins a battle,\s*(.+)$/i);
      if (match) {
        timing = TIMINGS.WHEN_OWN_CHARACTER_ATTACK_WINS_BATTLE;
        triggeredBody = match[1];
      }
    }
    if (!timing) {
      match = body.match(/^when (?:a character on your field|one of your characters) attacks and loses a battle,\s*(.+)$/i);
      if (match) {
        timing = TIMINGS.WHEN_OWN_CHARACTER_ATTACK_LOSES_BATTLE;
        triggeredBody = match[1];
      }
    }
    if (!timing) {
      match = body.match(/^when one of your \[([^\]]+)\] affinity cards attacks and wins a battle,\s*(.+)$/i);
      if (match) {
        timing = TIMINGS.WHEN_OWN_CHARACTER_ATTACK_WINS_BATTLE;
        triggeredCondition = { attackingCharacter: { affinity: match[1] } };
        triggeredBody = match[2];
      }
    }
    if (!timing) {
      match = body.match(/^when (?:a character on your field|one of your characters) attacks and is not blocked,\s*(.+)$/i);
      if (match) {
        timing = TIMINGS.WHEN_OWN_CHARACTER_ATTACK_UNBLOCKED;
        triggeredBody = match[1];
      }
    }

    if (!timing) continue;

    body = triggeredBody.replace(/\.$/, "").trim();
    const encoded = encodeEffectBody(body, context);
    unsupported.push(...encoded.unsupported);
    if (!encoded.effect || encoded.effect.kind === "none") continue;

    abilities.push({
      id: `${timing}-${abilities.length + 1}`,
      timing,
      oncePerTurn: parsedCost.oncePerTurn,
      conditions: { ...(structuredClone(parsedCost.conditions) ?? {}), ...(triggeredCondition ?? {}) },
      cost: structuredClone(parsedCost.cost),
      effect: encoded.effect
    });
  }

  return abilities;
}

function parseLifeToSidelineTriggeredAbilities(rawText, context = {}) {
  const text = compactEffectText(rawText);
  const unsupported = context.unsupported ?? [];
  const abilities = [];
  if (!text) return abilities;

  const pattern = /(?<prefix>(?:\[[^\]]+\]\s*)*)(?:(?:when a card without a \[trigger\] ability is placed from your life area into your sideline)|(?:if a card without a \[trigger\] ability is placed from your life area into your sideline when you have (?<fieldCount>\w+|\d+) or more cards without \[trigger\] abilities on your field)),\s*(?<body>.*?)(?=(?:\s+\[(?:Raid|When Played|When Attacking|When Blocking|When Sidelined|Activate: Main|Start of End Phase)\])|$)/gi;

  for (const match of text.matchAll(pattern)) {
    const prefix = match.groups.prefix ?? "";
    const parsedCost = parseAbilityCost(`${prefix} ${match.groups.body ?? ""}`.trim());
    const conditions = { ...(parsedCost.conditions ?? {}) };
    if (/\[During Your Turn\]/i.test(prefix)) conditions.turn = "controller";
    if (/\[During Opponent's Turn\]/i.test(prefix)) conditions.turn = "opponent";
    if (match.groups.fieldCount) {
      conditions.noTriggerFieldCountMin = numberFromText(match.groups.fieldCount, 0);
    }

    const parsedLimit = parseSharedOncePerTurn(
      parsedCost.body
        .replace(/\[During Your Turn\]/gi, "")
        .replace(/\[During Opponent's Turn\]/gi, "")
        .trim(),
      context
    );
    const body = parsedLimit.body.trim();
    const encoded = encodeEffectBody(body, context);
    unsupported.push(...encoded.unsupported);
    if (!encoded.effect || encoded.effect.kind === "none") continue;

    abilities.push({
      id: `${TIMINGS.WHEN_LIFE_TO_SIDELINE_NO_TRIGGER}-${abilities.length + 1}`,
      timing: TIMINGS.WHEN_LIFE_TO_SIDELINE_NO_TRIGGER,
      oncePerTurn: parsedCost.oncePerTurn,
      oncePerTurnKey: parsedLimit.oncePerTurnKey,
      conditions: Object.keys(conditions).length > 0 ? conditions : undefined,
      cost: structuredClone(parsedCost.cost),
      effect: encoded.effect
    });
  }

  return abilities;
}

function parseFieldAttackTriggeredAbilities(rawText, context = {}) {
  const text = compactEffectText(rawText);
  const unsupported = context.unsupported ?? [];
  const abilities = [];
  if (!text) return abilities;

  const timingBoundary = String.raw`(?=(?:\s+\[(?:Raid|When Played|When Attacking|When Blocking|When Sidelined|Activate: Main|Start of End Phase)\])|$)`;
  const patterns = [
    {
      regex: new RegExp(String.raw`(?<prefix>(?:\[[^\]]+\]\s*)*)when a <(?<name>[^>]+)> on your field attacks,\s*(?<body>.*?)${timingBoundary}`, "gi"),
      filter: (groups) => ({ name: groups.name })
    },
    {
      regex: new RegExp(String.raw`(?<prefix>(?:\[[^\]]+\]\s*)*)when one of your \[(?<affinity>[^\]]+)\] affinity cards(?: with (?<bpMax>\d+) or less base bp)? attacks,\s*(?<body>.*?)${timingBoundary}`, "gi"),
      filter: (groups) => ({
        affinity: groups.affinity,
        bpMax: groups.bpMax ? Number(groups.bpMax) : undefined
      })
    }
  ];

  for (const { regex, filter } of patterns) {
    for (const match of text.matchAll(regex)) {
      const prefix = match.groups.prefix ?? "";
      const parsedCost = parseAbilityCost(`${prefix} ${match.groups.body ?? ""}`.trim());
      const conditions = { ...(parsedCost.conditions ?? {}), attackingCharacter: filter(match.groups) };
      if (/\[During Your Turn\]/i.test(prefix)) conditions.turn = "controller";
      if (/\[During Opponent's Turn\]/i.test(prefix)) conditions.turn = "opponent";

      const parsedLimit = parseSharedOncePerTurn(
        parsedCost.body
          .replace(/\[During Your Turn\]/gi, "")
          .replace(/\[During Opponent's Turn\]/gi, "")
          .trim(),
        context
      );
      const body = parsedLimit.body.trim();
      const encoded = encodeEffectBody(body, context);
      unsupported.push(...encoded.unsupported);
      if (!encoded.effect || encoded.effect.kind === "none") continue;

      abilities.push({
        id: `${TIMINGS.WHEN_OWN_CHARACTER_ATTACKS}-${abilities.length + 1}`,
        timing: TIMINGS.WHEN_OWN_CHARACTER_ATTACKS,
        oncePerTurn: parsedCost.oncePerTurn,
        oncePerTurnKey: parsedLimit.oncePerTurnKey,
        conditions,
        cost: structuredClone(parsedCost.cost),
        effect: encoded.effect
      });
    }
  }

  return abilities;
}

function parseAttackPhaseTriggeredAbilities(rawText, context = {}) {
  const text = compactEffectText(rawText);
  const unsupported = context.unsupported ?? [];
  const abilities = [];
  if (!text) return abilities;

  if (/at the end of this character's attack,\s*look at the face-down cards under this character\.\s*reveal up to two cards among them and add them to your hand\.\s*if you add two cards to your hand,\s*switch this character to active/i.test(text)) {
    abilities.push({
      id: `${TIMINGS.END_OF_ATTACK}-${abilities.length + 1}`,
      timing: TIMINGS.END_OF_ATTACK,
      oncePerTurn: false,
      effect: {
        kind: "sequence",
        effects: [
          { kind: "moveUnderCardsToZone", count: 2, destination: "hand", faceUp: true, target: "self" },
          {
            kind: "conditional",
            condition: { lastMovedUnderCardMin: 2 },
            effect: { kind: "readySelf" }
          }
        ]
      }
    });
  }

  const sentences = text
    .split(/(?:(?<=\.)|(?<=\.\)))\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  for (let index = 0; index < sentences.length; index += 1) {
    let sentence = sentences[index];
    if (/\byou may pay \d+ ap\.?$/i.test(sentence) && /^if you do\b/i.test(sentences[index + 1] ?? "")) {
      sentence = `${sentence} ${sentences[index + 1]}`;
      index += 1;
    }
    if (/^(?:\[[^\]]+\]\s*)*at the end of .*you may\b/i.test(sentence) && /^if you do\b/i.test(sentences[index + 1] ?? "")) {
      sentence = `${sentence} ${sentences[index + 1]}`;
      index += 1;
    }
    if (/^(?:\[[^\]]+\]\s*)*at the (?:start|end) of .*choose\b/i.test(sentence)
      && /^you may swap it with this character\.?$/i.test(sentences[index + 1] ?? "")) {
      sentence = `${sentence} ${sentences[index + 1]}`;
      index += 1;
    }
    if (/\bif you do,\s*choose\b/i.test(sentence)
      && /^you may swap it with this character\.?$/i.test(sentences[index + 1] ?? "")) {
      sentence = `${sentence} ${sentences[index + 1]}`;
      index += 1;
    }
    while (/choose one of (?:the )?(?:following|abilities listed below)/i.test(sentence) && /^-\s*/.test(sentences[index + 1] ?? "")) {
      sentence = `${sentence} ${sentences[index + 1]}`;
      index += 1;
    }

    if (sentence.includes("\"")
      && !/at the end of .*attack phase,\s*perform:/i.test(sentence)
      && !/at the end of .*attack phase,.*swap it with this character/i.test(sentence)
      && !/at the end of this character's attack,/i.test(sentence)) continue;
    if (/^\[(?:When Played|When Attacking|When Blocking|When Sidelined|Activate: Main|Start of End Phase)\]/i.test(sentence)) continue;

    const parsedCost = parseAbilityCost(sentence.replace(/^-\s*/, "").trim());
    let body = stripEffectTags(parsedCost.body)
      .replace(/^(?:\[(?:Damage|Impact)\s*\([^)]+\)\]\s*)+/i, "")
      .trim();
    const embeddedTimingIndex = body.search(/\bat the (?:start|end) /i);
    if (embeddedTimingIndex > 0 && !/^if this character is active at the end/i.test(body)) {
      body = body.slice(embeddedTimingIndex).trim();
    }
    if (!body) continue;

    const conditions = { ...(parsedCost.conditions ?? {}) };
    if (/\[During Your Turn\]/i.test(sentence)) conditions.turn = "controller";
    if (/\[During Opponent's Turn\]/i.test(sentence)) conditions.turn = "opponent";

    let timing;
    let match = body.match(/^if this character is active at the end of your attack phase,\s*(.+)$/i);
    if (match) {
      timing = TIMINGS.END_OF_ATTACK_PHASE;
      conditions.turn = "controller";
      conditions.active = true;
    }

    if (!timing) {
      match = body.match(/^at the start of your attack phase,\s*(.+)$/i);
      if (match) {
        timing = TIMINGS.START_OF_ATTACK_PHASE;
        conditions.turn = "controller";
      }
    }

    if (!timing) {
      match = body.match(/^at the end of your attack phase,\s*(.+)$/i)
        ?? body.match(/^at the end of the attack phase,\s*(.+)$/i);
      if (match) {
        timing = TIMINGS.END_OF_ATTACK_PHASE;
        conditions.turn = "controller";
      }
    }

    if (!timing) {
      match = body.match(/^at the end of your opponent's attack phase,\s*(.+)$/i);
      if (match) {
        timing = TIMINGS.END_OF_ATTACK_PHASE;
        conditions.turn = "opponent";
      }
    }

    if (!timing) {
      match = body.match(/^at the end of your attack phase and your opponent's attack phase,\s*(.+)$/i);
      if (match) {
        timing = TIMINGS.END_OF_ATTACK_PHASE;
      }
    }

    if (!timing) {
      match = body.match(/^at the end of this character's attack,\s*(.+)$/i);
      if (match) timing = TIMINGS.END_OF_ATTACK;
    }

    if (!timing) {
      match = body.match(/^at the end of an attack by a character on your field,\s*(.+)$/i);
      if (match) timing = TIMINGS.WHEN_OWN_CHARACTER_ATTACK_ENDS;
    }

    if (!timing) continue;

    body = match[1].replace(/\.$/, "").trim();
    const parsedLimit = parseSharedOncePerTurn(body, context);
    body = parsedLimit.body.trim();
    let effect;
    let unsupportedForBody = [];
    if (/^perform:\s*"add one card from your life to your hand"\s+or\s+"sideline this character,\s*then draw a card\.?"$/i.test(body)) {
      effect = {
        kind: "chooseOne",
        choiceKey: "effectChoice",
        choices: [
          {
            id: "life-to-hand",
            effect: { kind: "moveCardBetweenZones", source: "life", destination: "hand", count: 1 }
          },
          {
            id: "sideline-self-draw",
            effect: {
              kind: "sequence",
              effects: [
                { kind: "sidelineSelf" },
                { kind: "draw", amount: 1 }
              ]
            }
          }
        ]
      };
    } else {
      const encoded = encodeEffectBody(body, context);
      unsupportedForBody = encoded.unsupported;
      effect = encoded.effect;
    }
    if (unsupportedForBody.length > 0) continue;
    if (!effect || effect.kind === "none" || effect.kind === "unsupported") continue;

    abilities.push({
      id: `${timing}-${abilities.length + 1}`,
      timing,
      oncePerTurn: parsedCost.oncePerTurn,
      oncePerTurnKey: parsedLimit.oncePerTurnKey,
      conditions: Object.keys(conditions).length > 0 ? conditions : undefined,
      cost: structuredClone(parsedCost.cost),
      effect
    });
  }

  return abilities;
}

function parseHandStartAttackPhaseTriggeredAbilities(rawText, context = {}) {
  const text = compactEffectText(rawText);
  const abilities = [];
  if (!text) return abilities;

  const match = text.match(/at the start of your attack phase,\s*if <(?<first>[^>]+)> and <(?<second>[^>]+)> are on your front line and you have (?<energy>\d+) or more (?<color>red|blue|green|yellow|purple) energy generation,\s*you may play this card from your hand set to active onto your front line\. if you do,\s*place one other card on your field on the top or bottom of your deck\.?(?<limit>.*)$/i);
  if (!match) return abilities;

  const parsedLimit = parseSharedOncePerTurn(match.groups.limit?.trim() ?? "", context);
  abilities.push({
    id: `${TIMINGS.START_OF_ATTACK_PHASE}-${abilities.length + 1}`,
    timing: TIMINGS.START_OF_ATTACK_PHASE,
    oncePerTurn: false,
    oncePerTurnKey: parsedLimit.oncePerTurnKey,
    conditions: {
      zone: "hand",
      allOf: [
        { namedOnFrontLine: match.groups.first },
        { namedOnFrontLine: match.groups.second },
        { energyAvailableMin: { color: match.groups.color.toLowerCase(), amount: Number(match.groups.energy) } }
      ]
    },
    effect: {
      kind: "optional",
      choiceKey: "optionalEffect",
      default: true,
      effect: {
        kind: "sequence",
        effects: [
          {
            kind: "playSourceFromZone",
            source: "hand",
            rested: false,
            destinationLine: LINES.FRONT
          },
          {
            kind: "moveTargetsToDeck",
            positions: ["top", "bottom"],
            position: "top",
            target: {
              controller: "self",
              line: "field",
              max: 1,
              otherThanLastPlayed: true
            }
          }
        ]
      }
    }
  });

  return abilities;
}

function parseStaticModifiers(rawText) {
  const text = compactEffectText(rawText);
  const modifiers = [];
  for (const sentence of text.split(/(?:(?<=\.)|(?<=\.\)))\s+/)) {
    const modifier = parseStaticBpModifierSentence(sentence);
    if (modifier) modifiers.push(modifier);
  }
  for (const match of text.matchAll(/\[During Your Turn\]\s*\[#?If on (?:the )?Front Line#?\]\s*if <(?<sameLine>[^>]+)> is on the same line,\s*this character and all <(?<targetName>[^>]+)> characters on your front line gain (?<bp>\d+) bp/gi)) {
    const condition = combineConditions([
      { turn: "controller" },
      { line: LINES.FRONT },
      {
        sameLineCountMin: 1,
        otherThanSource: true,
        filter: { name: match.groups.sameLine }
      }
    ]);
    modifiers.push({
      bp: Number(match.groups.bp),
      condition
    });
  }
  modifiers.push(...parseTieredStaticBpModifiers(rawText));
  return modifiers;
}

function parseStaticFieldModifiers(rawText) {
  const text = staticTextBeforeAbilities(rawText);
  const modifiers = [];
  for (const match of text.matchAll(/(?<prefix>(?:\[(?:During Your Turn|During Opponent's Turn|#?If on (?:the )?(?:Front Line|Energy Line)#?)\]\s*)*)all \[(?<affinity>[^\]]+)\] affinity cards on your field gain\s+(?<bp>\d+)\s+bp/gi)) {
    modifiers.push({
      bp: Number(match.groups.bp),
      target: {
        controller: "self",
        line: "field",
        affinity: match.groups.affinity
      },
      condition: conditionFromStaticPrefix(match.groups.prefix ?? "")
    });
  }

  for (const match of text.matchAll(/\[During Your Turn\]\s*\[#?If on (?:the )?Front Line#?\]\s*if <(?<sameLine>[^>]+)> is on the same line,\s*this character and all <(?<targetName>[^>]+)> characters on your front line gain (?<bp>\d+) bp/gi)) {
    modifiers.push({
      bp: Number(match.groups.bp),
      target: {
        controller: "self",
        line: LINES.FRONT,
        name: match.groups.targetName
      },
      condition: combineConditions([
        { turn: "controller" },
        { line: LINES.FRONT },
        {
          sameLineCountMin: 1,
          otherThanSource: true,
          filter: { name: match.groups.sameLine }
        }
      ])
    });
  }

  for (const match of text.matchAll(/(?<turn>\[During Your Turn\]\s*)?if <(?<name>[^>]+)> is on your field,\s*all characters on your field gain\s+(?<bp>\d+)\s+bp/gi)) {
    const conditions = [{ namedOnField: match.groups.name }];
    if (match.groups.turn) conditions.unshift({ turn: "controller" });
    modifiers.push({
      bp: Number(match.groups.bp),
      target: {
        controller: "self",
        line: "field",
        type: CARD_TYPES.CHARACTER
      },
      condition: combineConditions(conditions)
    });
  }
  return modifiers;
}

function parseStaticFieldKeywordModifiers(rawText) {
  const text = staticTextBeforeAbilities(rawText);
  const modifiers = [];
  const pattern = /(?<prefix>(?:\[(?:During Your Turn|During Opponent's Turn|#?If on (?:the )?(?:Front Line|Energy Line)#?)\]\s*)*)(?<subject>\[[^\]]+\] affinity cards|characters|(?:(?:<[^>]+>,\s*)*(?:and\s*)?<[^>]+>) cards) on your field(?: other than <(?<other>[^>]+)>)? gain "\s*(?<quotedTurn>\[During Opponent's Turn\]\s*)?your opponent cannot choose this character with (?:an? )?abilit[^"]+unless they place one card from their hand into their sideline as an additional cost\.?"/gi;

  for (const match of text.matchAll(pattern)) {
    const condition = conditionFromStaticPrefix(`${match.groups.prefix ?? ""}${match.groups.quotedTurn ?? ""}`);
    const subject = match.groups.subject.toLowerCase();
    const target = {
      controller: "self",
      line: "field"
    };

    const affinity = subject.match(/\[([^\]]+)\] affinity cards/);
    if (affinity) target.affinity = affinity[1];

    const names = [...subject.matchAll(/<([^>]+)>/g)].map((nameMatch) => ({ name: nameMatch[1] }));
    if (names.length === 1) target.name = names[0].name;
    if (names.length > 1) target.anyOf = names;

    if (subject === "characters") target.type = CARD_TYPES.CHARACTER;
    if (match.groups.other) target.otherThanName = match.groups.other;

    modifiers.push({
      keyword: "opponentAbilityTargetTax",
      value: true,
      target,
      condition
    });
  }

  return modifiers;
}

function conditionFromStaticPrefix(prefix) {
  const conditions = [];
  const lower = prefix.toLowerCase();
  if (lower.includes("[during your turn]")) conditions.push({ turn: "controller" });
  if (lower.includes("[during opponent's turn]")) conditions.push({ turn: "opponent" });
  if (/\[#?if on (?:the )?front line#?\]/.test(lower)) conditions.push({ line: LINES.FRONT });
  if (/\[#?if on (?:the )?energy line#?\]/.test(lower)) conditions.push({ line: LINES.ENERGY });
  return combineConditions(conditions);
}

function parseStaticBpModifierSentence(sentence) {
  let lower = sentence
    .replace(/^-\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!lower || /^(?:one|two|three|four|five|six|seven|\d+) or more:/.test(lower)) return undefined;
  if (/^\[(?:when played|when attacking|when blocking|when sidelined|activate: main|start of end phase)\]/.test(lower)) return undefined;

  const conditions = [];
  let changed = true;
  while (changed) {
    changed = false;
    if (lower.startsWith("[during your turn]")) {
      conditions.push({ turn: "controller" });
      lower = lower.replace(/^\[during your turn\]\s*/, "");
      changed = true;
    }
    if (lower.startsWith("[during opponent's turn]")) {
      conditions.push({ turn: "opponent" });
      lower = lower.replace(/^\[during opponent's turn\]\s*/, "");
      changed = true;
    }
    if (/^\[#?if on (?:the )?front line#?\]/.test(lower)) {
      conditions.push({ line: LINES.FRONT });
      lower = lower.replace(/^\[#?if on (?:the )?front line#?\]\s*/, "");
      changed = true;
    }
    if (/^\[#?if on (?:the )?energy line#?\]/.test(lower)) {
      conditions.push({ line: LINES.ENERGY });
      lower = lower.replace(/^\[#?if on (?:the )?energy line#?\]\s*/, "");
      changed = true;
    }
  }

  let match = lower.match(/^if (.+?),\s*(?:this character|it) gains\s+(\d+)\s+bp\b/);
  if (match) {
    const condition = parseStaticBpCondition(`if ${match[1]}`);
    if (!condition) return undefined;
    return {
      bp: Number(match[2]),
      condition: combineConditions([...conditions, condition])
    };
  }

  match = lower.match(/^(?:this character|it) gains\s+(\d+)\s+bp\b(?:[^.]*?)\s+if (.+)$/);
  if (match) {
    const condition = parseStaticBpCondition(`if ${match[2]}`);
    if (!condition) return undefined;
    return {
      bp: Number(match[1]),
      condition: combineConditions([...conditions, condition])
    };
  }

  match = lower.match(/^(?:this character|it) gains\s+(\d+)\s+bp\b(?:\s+for each ([^.]+))?/);
  if (!match) {
    match = lower.match(/^for each ([^.]+),\s*this character gains\s+(\d+)\s+bp\b/);
    if (match) {
      const amountPer = parseStaticBpAmountPer(match[1]);
      if (!amountPer) return undefined;
      return {
        bp: Number(match[2]),
        condition: combineConditions(conditions),
        amountPer
      };
    }
    match = lower.match(/^this character loses\s+(\d+)\s+bp\b/);
    if (!match) return undefined;
    return {
      bp: -Number(match[1]),
      condition: combineConditions(conditions)
    };
  }
  const amountPer = match[2] ? parseStaticBpAmountPer(match[2]) : undefined;
  if (match[2] && !amountPer) return undefined;
  return {
    bp: Number(match[1]),
    condition: combineConditions(conditions),
    ...(amountPer ? { amountPer } : {})
  };
}

function parseStaticBpCondition(value) {
  const lower = value.toLowerCase().replace(/\.$/, "").trim();
  if (/^if this character has a face-down card under it$/.test(lower)) return { hasFaceDownUnder: true };
  if (/^if this character has \d+ or more bp$/.test(lower)) return undefined;
  return parseConditionOnly(lower);
}

function parseStaticBpAmountPer(value) {
  const lower = value.toLowerCase().replace(/\.$/, "").trim();
  if (lower === "resting character on your opponent's front line") {
    return {
      kind: "fieldCount",
      controller: "opponent",
      line: LINES.FRONT,
      rested: true,
      filter: { type: CARD_TYPES.CHARACTER }
    };
  }
  if (lower === "other character on your front line") {
    return {
      kind: "fieldCount",
      controller: "self",
      line: LINES.FRONT,
      otherThanSource: true,
      filter: { type: CARD_TYPES.CHARACTER }
    };
  }
  let match = lower.match(/^resting \[([^\]]+)\] affinity card with (\d+) or less base bp on your field$/);
  if (match) {
    return {
      kind: "fieldCount",
      controller: "self",
      rested: true,
      filter: {
        affinity: match[1],
        bpMax: Number(match[2])
      }
    };
  }
  if (lower === "face-down card under it") {
    return {
      kind: "underCardCount",
      faceDown: true
    };
  }
  if (lower === "event card you have used this turn") {
    return {
      kind: "eventUsedCount"
    };
  }
  return undefined;
}

function parseStaticKeywords(rawText) {
  const text = staticTextBeforeAbilities(rawText).toLowerCase();
  const keywords = {};
  if (/(?:^|[.]\s+)this (?:character|site|card) generates energy even (?:if it is )?on the front line\./.test(text)) {
    keywords.frontLineEnergyGeneration = true;
  }
  if (/(?:^|[.]\s+)this (?:character|site|card) cannot be chosen by your opponent's abilities\./.test(text)) {
    keywords.opponentAbilityProtection = true;
  }
  return keywords;
}

function parseBaseAbilityTimingGrants(rawText) {
  const text = cleanUnionArenaText(rawText).toLowerCase();
  const match = text.match(/this character gains all ([^.]+?) abilities on its base card/);
  if (!match) return [];
  return [...match[1].matchAll(/\[(when played|when attacking|when blocking|when sidelined|activate: main|start of end phase)\]/g)]
    .map((timingMatch) => TIMING_MAP.get(timingMatch[1]))
    .filter(Boolean);
}

function parseStaticKeywordModifiers(rawText) {
  const modifiers = parseTieredAbilityEntries(rawText)
    .flatMap((entry) => parseStaticKeywordModifiersFromTierBody(sanitizeTierStaticBody(entry.body), entry.condition));
  const text = staticTextBeforeAbilities(rawText);

  for (const match of text.matchAll(/(?<condition>if [^.]+?),\s*(?:this character|it) gains\s*(?<body>(?:\[[^\]]+\]\s*(?:and\s*)?)+)/gi)) {
    const condition = parseConditionOnly(match.groups.condition.toLowerCase());
    if (!condition || hasUnsupportedStaticKeywordCondition(condition)) continue;
    modifiers.push(...parseStaticKeywordModifiersFromTierBody(match.groups.body, condition));
  }

  for (const match of text.matchAll(/(?<condition>if [^.]+?),\s*this character gains \d+ bp and (?<body>(?:\[[^\]]+\]\s*(?:and\s*)?)+)/gi)) {
    const condition = parseConditionOnly(match.groups.condition.toLowerCase());
    if (!condition || hasUnsupportedStaticKeywordCondition(condition)) continue;
    modifiers.push(...parseStaticKeywordModifiersFromTierBody(match.groups.body, condition));
  }

  for (const match of text.matchAll(/(?<condition>if [^.]+?),\s*this character gains \d+ bp and "this character cannot be blocked by a character with (?<bp>\d+) or more bp"/gi)) {
    const condition = parseConditionOnly(match.groups.condition.toLowerCase());
    if (!condition || hasUnsupportedStaticKeywordCondition(condition)) continue;
    modifiers.push({
      keyword: "cantBeBlockedByBpMin",
      value: Number(match.groups.bp),
      condition
    });
  }

  for (const match of text.matchAll(/(?<condition>if [^.]+?),\s*this character gains "this character generates energy even if it is on the front line\.?"/gi)) {
    const condition = parseConditionOnly(match.groups.condition.toLowerCase());
    if (!condition || hasUnsupportedStaticKeywordCondition(condition)) continue;
    modifiers.push({
      keyword: "frontLineEnergyGeneration",
      value: true,
      condition
    });
  }

  for (const match of text.matchAll(/(?<prefix>(?:\[(?:During Your Turn|During Opponent's Turn|#?If on (?:the )?(?:Front Line|Energy Line)#?)\]\s*)*)your opponent cannot choose this character with (?:an? )?abilit[^.]+unless they place one card from their hand into their sideline as an additional cost/gi)) {
    modifiers.push({
      keyword: "opponentAbilityTargetTax",
      value: true,
      condition: conditionFromStaticPrefix(match.groups.prefix ?? "")
    });
  }

  return modifiers;
}

function parseStaticEnergyModifiers(rawText) {
  const text = staticTextBeforeAbilities(rawText);
  const modifiers = [];

  for (const match of text.matchAll(/(?<turn>\[During Your Turn\]\s*)?(?<condition>if [^.]+?),\s*(?:it|this (?:character|site|card)) gains\s*(?<energy>(?:\[(?:red|blue|green|yellow|purple)\]\s*)+)energy generation/gi)) {
    let condition = parseStaticEnergyCondition(match.groups.condition);
    if (!condition || hasUnsupportedStaticEnergyCondition(condition)) continue;
    if (match.groups.turn) condition = combineConditions([{ turn: "controller" }, condition]);
    modifiers.push(staticEnergyModifier(match.groups.energy, condition));
  }

  for (const match of text.matchAll(/(?:^|[.]\s+)(?:this (?:character|site|card)) gains\s*((?:\[(?:red|blue|green|yellow|purple)\]\s*)+)energy generation\./gi)) {
    modifiers.push(staticEnergyModifier(match[1], {}));
  }

  modifiers.push(...parseTieredStaticEnergyModifiers(rawText));
  return modifiers;
}

function parseTieredStaticBpModifiers(rawText) {
  const modifiers = [];
  for (const entry of parseTieredAbilityEntries(rawText)) {
    const body = sanitizeTierStaticBody(entry.body);
    for (const sentence of body.split(/(?:(?<=\.)|(?<=\.\)))\s+/)) {
      const modifier = parseStaticBpModifierSentence(sentence);
      if (!modifier) continue;
      modifiers.push({
        ...modifier,
        condition: combineConditions([entry.condition, modifier.condition ?? {}])
      });
    }
  }
  return modifiers;
}

function parseTieredStaticEnergyModifiers(rawText) {
  const modifiers = [];
  for (const entry of parseTieredAbilityEntries(rawText)) {
    const body = sanitizeTierStaticBody(entry.body);
    for (const match of body.matchAll(/(?<turn>\[During Your Turn\]\s*)?(?:this (?:character|site|card)|it) gains\s*(?<energy>(?:\[(?:red|blue|green|yellow|purple)\]\s*)+)energy generation/gi)) {
      const conditions = [entry.condition];
      if (match.groups.turn) conditions.push({ turn: "controller" });
      modifiers.push(staticEnergyModifier(match.groups.energy, combineConditions(conditions)));
    }
  }
  return modifiers;
}

function parseConditionalEntersActive(rawText) {
  for (const entry of parseTieredAbilityEntries(rawText)) {
    const body = sanitizeTierStaticBody(entry.body).toLowerCase();
    if (/play this (?:character|site|card) set to active/.test(body)) return entry.condition;
  }
  return undefined;
}

function parseTieredAbilityEntries(rawText) {
  const text = cleanUnionArenaText(rawText)
    .replace(/\s+/g, " ")
    .trim();
  if (!/gains (?:all )?(?:the )?abilities listed below/i.test(text)) return [];

  const entries = [];
  const headerRegex = /(?:this character|it) gains (?:all )?(?:the )?abilities listed below(?: until the end of the turn)? (?:if you have|based on) (?:the )?([^.]+)\./gi;
  for (const header of text.matchAll(headerRegex)) {
    if (/until the end of the turn/i.test(header[0]) || headerIsInsideAbility(text, header.index)) continue;
    const conditionForThreshold = parseTieredConditionFactory(header[1]);
    if (!conditionForThreshold) continue;

    const following = text.slice(header.index + header[0].length);
    const bulletRegex = /(?:^|\s)-\s*((?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|\d+)(?:\s+or (?:more|less))?):\s*([\s\S]*?)(?=(?:\s-\s*(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|\d+)(?:\s+or (?:more|less))?:)|$)/gi;
    for (const bullet of following.matchAll(bulletRegex)) {
      const mode = /\s+or less$/i.test(bullet[1]) ? "max" : "min";
      const thresholdText = bullet[1].replace(/\s+or (?:more|less)$/i, "");
      entries.push({
        condition: conditionForThreshold(numberFromText(thresholdText, 0), mode),
        body: bullet[2].trim()
      });
    }
    if (entries.length > 0) break;
  }
  return entries;
}

function headerIsInsideAbility(text, headerIndex) {
  const prefix = text.slice(Math.max(0, headerIndex - 90), headerIndex).toLowerCase();
  return /\[(?:when played|when attacking|when blocking|when sidelined|activate: main|start of end phase)\][^.]*$/.test(prefix);
}

function parseTieredConditionFactory(rawConditionText) {
  const text = rawConditionText.toLowerCase().replace(/\s+/g, " ").trim();
  let match = text.match(/^required number of cards in your sideline$/);
  if (match) return (minimum) => ({ sidelineCountMin: minimum });

  match = text.match(/^required number of event cards in your sideline$/);
  if (match) return (minimum) => ({ zone: "sideline", zoneCountMin: minimum, filter: { type: CARD_TYPES.EVENT } });

  match = text.match(/^required number of \[([^\]]+)\] affinity cards in your sideline$/);
  if (match) return (minimum) => ({ zone: "sideline", zoneCountMin: minimum, filter: { affinity: match[1] } });

  match = text.match(/^required combined total number of (.+?) cards in your sideline$/);
  if (match) {
    const names = [...match[1].matchAll(/<([^>]+)>/g)].map((nameMatch) => ({ name: nameMatch[1] }));
    if (names.length > 0) {
      return (minimum) => ({ zone: "sideline", zoneCountMin: minimum, filter: { anyOf: names } });
    }
  }

  match = text.match(/^required amount of energy generation$/);
  if (match) return (minimum) => ({ energyGenerationMin: minimum });

  match = text.match(/^required amount of life$/);
  if (match) return (threshold, mode) => (mode === "max" ? { lifeMax: threshold } : { lifeMin: threshold });

  match = text.match(/^required number of cards without \[trigger\] abilities on your field$/);
  if (match) return (minimum) => ({ fieldCountMin: minimum, filter: { noTrigger: true } });

  match = text.match(/^required number of face-down cards under (?:this character|it)$/);
  if (match) return (minimum) => ({ underFaceDownCountMin: minimum });

  match = text.match(/^required number of cards with unique card names on your field from among the following: (.+)$/);
  if (match) {
    const names = [...match[1].matchAll(/<([^>]+)>/g)].map((nameMatch) => ({ name: nameMatch[1] }));
    if (names.length > 0) {
      return (minimum) => ({ uniqueFieldNameCountMin: minimum, filter: { anyOf: names } });
    }
  }

  return undefined;
}

function sanitizeTierStaticBody(value) {
  let text = String(value ?? "").trim();
  if (/^\[(?:when played|when attacking|when blocking|when sidelined|activate: main|start of end phase)\]/i.test(text)) return "";
  text = text.replace(/\.\s+\[(?:When Played|When Attacking|When Blocking|When Sidelined|Activate: Main|Start of End Phase)\][\s\S]*$/i, ".");
  return text.trim();
}

function parseStaticKeywordModifiersFromTierBody(body, condition) {
  let text = body.toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return [];

  const conditions = [condition];
  if (text.startsWith("[during your turn]")) {
    conditions.push({ turn: "controller" });
    text = text.replace(/^\[during your turn\]\s*/, "");
  } else if (text.startsWith("[during opponent's turn]")) {
    conditions.push({ turn: "opponent" });
    text = text.replace(/^\[during opponent's turn\]\s*/, "");
  }
  const combinedCondition = combineConditions(conditions);
  const modifiers = [];
  const add = (keyword, value = true) => {
    modifiers.push({ keyword, value, condition: combinedCondition });
  };

  for (const match of text.matchAll(/\[(damage|impact)\s*\(\s*(\+?)(\d+)\s*\)\]/g)) {
    const keyword = match[1] === "damage"
      ? (match[2] ? "damagePlus" : "damage")
      : (match[2] ? "impactPlus" : "impact");
    add(keyword, Number(match[3]));
  }
  if (text.includes("[snipe]")) add("snipe");
  if (text.includes("[step]")) add("step");
  if (text.includes("[double attack]")) add("doubleAttack");
  if (text.includes("[double block]")) add("doubleBlock");
  if (text.includes("[nullify impact]")) add("nullifyImpact");
  if (text.includes("generates energy even if it is on the front line")) add("frontLineEnergyGeneration");
  if (/cannot be chosen by your opponent's (?:character abilities|event card abilities|trigger abilities|abilities)/.test(text)) {
    add("opponentAbilityProtection");
  }
  let match = text.match(/cannot be blocked by a character with\s+(\d+)\s+or less bp/);
  if (match) add("cantBeBlockedByBpMax", Number(match[1]));
  match = text.match(/cannot be blocked by a character with\s+(\d+)\s+or more bp/);
  if (match) add("cantBeBlockedByBpMin", Number(match[1]));
  if (text.includes("opponent must block this character")) add("mustBlock");

  return modifiers;
}

function staticTextBeforeAbilities(rawText) {
  return compactEffectText(rawText)
    .split(/\[(?:When Played|When Attacking|When Blocking|When Sidelined|Activate: Main|Start of End Phase)\]|when this character is raided|when this card is placed from your hand into your sideline|when a character on your opponent's front line is sidelined|when this character is returned to your hand from your field|at the start of your turn/i)[0];
}

function parseStaticEnergyCondition(value) {
  const text = value.toLowerCase().trim();
  if (/^if this (?:character|site|card) is active$/.test(text)) return { active: true };
  if (/^if this (?:character|site|card) has a face-down card under it$/.test(text)) return { hasFaceDownUnder: true };
  if (/^if there is a face-down card under this (?:character|site|card)$/.test(text)) return { hasFaceDownUnder: true };
  if (/^if there is a face-up card on the top of your deck$/.test(text)) return { topDeckFaceUp: true };
  if (/^if there is a face-up card in your or your opponent's deck or life area$/.test(text)) return { anyFaceUpDeckOrLife: true };
  return parseConditionOnly(text);
}

function staticEnergyModifier(energyText, condition) {
  const colors = [...energyText.toLowerCase().matchAll(/\[(red|blue|green|yellow|purple)\]/g)].map((match) => match[1]);
  return {
    color: colors[0],
    amount: colors.length || 1,
    condition
  };
}

function hasUnsupportedStaticEnergyCondition(condition) {
  if (!condition || Object.keys(condition).length === 0) return false;
  if (condition.allOf) return condition.allOf.some(hasUnsupportedStaticEnergyCondition);
  if (condition.anyOf) return condition.anyOf.some(hasUnsupportedStaticEnergyCondition);
  return condition.history || condition.energyGenerationMin !== undefined;
}

function hasUnsupportedStaticKeywordCondition(condition) {
  if (!condition || Object.keys(condition).length === 0) return false;
  if (condition.allOf) return condition.allOf.some(hasUnsupportedStaticKeywordCondition);
  if (condition.anyOf) return condition.anyOf.some(hasUnsupportedStaticKeywordCondition);
  return condition.history;
}

function parseUseCostModifiers(rawText) {
  const text = compactEffectText(rawText).toLowerCase();
  const modifiers = [];
  for (const match of text.matchAll(/if <([^>]+)> is on your field,\s*reduce this card's ap cost by (\d+) while in your hand\.?/g)) {
    modifiers.push({
      kind: "apCost",
      amount: Number(match[2]),
      sourceZone: "hand",
      condition: { namedOnField: match[1] }
    });
  }
  for (const match of text.matchAll(/if you have no cards on your field,\s*reduce this card's required energy by\s*\[(red|blue|green|yellow|purple)\s*[×x]\s*(\d+)\]\s*while in your hand\.?/g)) {
    modifiers.push({
      kind: "requiredEnergy",
      color: match[1],
      amount: Number(match[2]),
      sourceZone: "hand",
      condition: { emptyField: true }
    });
  }
  return modifiers;
}

function parseUseCostModifiersV2(rawText) {
  const text = normalizeCostText(rawText);
  const modifiers = [];

  for (const match of text.matchAll(/(?:^|[.]\s+)(?<prefix>[^.]*?)reduce this card's required energy by\s*\[(?<color>red|blue|green|yellow|purple)\s*x\s*(?<amount>\d+)\]\s*while\s+(?<zone>[^.]+?)(?:\.|$)/g)) {
    const prefix = match.groups.prefix.trim();
    modifiers.push({
      kind: "requiredEnergy",
      color: match.groups.color,
      amount: Number(match.groups.amount),
      ...sourceZonesFromText(match.groups.zone),
      ...amountScalingFromPrefix(prefix),
      condition: parseCostCondition(prefix)
    });
  }

  for (const match of text.matchAll(/(?:^|[.]\s+)(?<prefix>[^.]*?)reduce this card's ap cost by\s+(?<amount>\d+)(?:\s+while\s+(?<zone>[^.]+?))?(?:\.|$)/g)) {
    const prefix = match.groups.prefix.trim();
    modifiers.push({
      kind: "apCost",
      amount: Number(match.groups.amount),
      ...sourceZonesFromText(match.groups.zone ?? "in your hand"),
      condition: parseCostCondition(prefix)
    });
  }

  return modifiers;
}

function parseStaticUseCostModifiers(rawText) {
  const text = normalizeCostText(rawText);
  const modifiers = [];

  for (const match of text.matchAll(/(?:^|[.]\s+)(?<prefix>(?:\[[^\]]+\]\s*)*)(?<condition>if [^.]*?,\s*)?reduce the required energy of all <(?<name>[^>]+)> cards in your hand by\s*\[(?<color>red|blue|green|yellow|purple)\s*x\s*(?<amount>\d+)\]/g)) {
    modifiers.push({
      kind: "requiredEnergy",
      amount: Number(match.groups.amount),
      sourceZone: "hand",
      filter: { name: match.groups.name },
      condition: combineConditions([
        parseStaticCostCondition(match.groups.prefix),
        match.groups.condition ? parseCostCondition(match.groups.condition.trim()) : {}
      ])
    });
  }

  for (const match of text.matchAll(/(?:^|[.]\s+)(?<prefix>(?:\[[^\]]+\]\s*)*)(?<condition>if [^.]*?,\s*)?reduce the required energy of all \[(?<affinity>[^\]]+)\] affinity cards with (?<min>\d+) or more base required energy in your hand by\s*\[(?<color>red|blue|green|yellow|purple)\s*x\s*(?<amount>\d+)\]/g)) {
    modifiers.push({
      kind: "requiredEnergy",
      amount: Number(match.groups.amount),
      sourceZone: "hand",
      filter: {
        affinity: match.groups.affinity,
        requiredEnergyMin: Number(match.groups.min)
      },
      condition: combineConditions([
        parseStaticCostCondition(match.groups.prefix),
        match.groups.condition ? parseCostCondition(match.groups.condition.trim()) : {}
      ])
    });
  }

  return modifiers;
}

function normalizeCostText(rawText) {
  return compactEffectText(rawText)
    .replace(/ÃƒÂ—|Ã—|×/g, "x")
    .replace(/\]\s*while/g, "] while")
    .replace(/\]\s*(?=reduce|if|when)/g, "] ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function sourceZonesFromText(zoneText) {
  const zone = String(zoneText ?? "").toLowerCase();
  if (zone.includes("hand or sideline")) return { sourceZones: ["hand", "sideline"] };
  if (zone.includes("sideline") && !zone.includes("other than")) return { sourceZone: "sideline" };
  if (zone.includes("anywhere other than on your field or in your sideline")) return { sourceZone: "hand" };
  if (zone.includes("anywhere other than on your field")) return { sourceZones: ["hand", "sideline", "removal"] };
  return { sourceZone: "hand" };
}

function amountScalingFromPrefix(prefix) {
  let match = prefix.match(/for every (one|two|three|four|five|six|seven|\d+) cards? in your sideline,?\s*$/);
  if (match) {
    return {
      amountPer: {
        kind: "zoneCountFloor",
        zone: "sideline",
        every: numberFromText(match[1], 1)
      }
    };
  }

  match = prefix.match(/for each (?:card with )?\[([^\]]+)\] affinity card on your field,?\s*$/);
  if (match) {
    return {
      amountPer: {
        kind: "fieldCount",
        filter: { affinity: match[1] }
      }
    };
  }

  return {};
}

function parseStaticCostCondition(prefix) {
  const tags = [...String(prefix ?? "").matchAll(/\[([^\]]+)\]/g)].map((match) => match[1].trim().toLowerCase());
  const conditions = [];
  if (tags.includes("during your turn")) conditions.push({ turn: "controller" });
  if (tags.includes("if on the front line")) conditions.push({ sourceLine: LINES.FRONT });
  if (tags.includes("if on the energy line")) conditions.push({ sourceLine: LINES.ENERGY });
  return combineConditions(conditions);
}

function parseCostCondition(prefix) {
  let text = String(prefix ?? "")
    .replace(/\[[^\]]+\]/g, "")
    .replace(/^when you perform raid with this card from your hand,\s*/i, "if performing raid, ")
    .replace(/^if\s+/, "")
    .replace(/,$/, "")
    .trim();

  if (!text || text.startsWith("for every ") || text.startsWith("for each ")) return {};

  const conditions = [];

  let match = text.match(/^this (?:character|site|card) has a face-down card under it$/);
  if (match) return { hasFaceDownUnder: true };

  match = text.match(/^there is a face-down card under this (?:character|site|card)$/);
  if (match) return { hasFaceDownUnder: true };

  if (text.startsWith("performing raid")) {
    conditions.push({ performingRaid: true });
    text = text.replace(/^performing raid,?\s*(?:if\s*)?/, "").trim();
    if (!text) return combineConditions(conditions);
  }

  const andParts = splitTopLevel(text, "and");
  if (andParts.length > 1) {
    return combineConditions(andParts.map((part) => parseCostCondition(`if ${part}`)).filter((condition) => Object.keys(condition).length > 0));
  }

  match = text.match(/^you have no cards on your field$/);
  if (match) return combineConditions([...conditions, { emptyField: true }]);

  match = text.match(/^there is a (red|blue|green|yellow|purple) or (red|blue|green|yellow|purple) card on your opponent's field$/);
  if (match) return combineConditions([...conditions, { opponentFieldAnyColor: [match[1], match[2]] }]);

  match = text.match(/^<([^>]+)> is on your field$/);
  if (match) return combineConditions([...conditions, { namedOnField: match[1] }]);

  match = text.match(/^<([^>]+)> is on your front line$/);
  if (match) return combineConditions([...conditions, { namedOnFrontLine: match[1] }]);

  match = text.match(/^<([^>]+)> or <([^>]+)> is on your field$/);
  if (match) return combineConditions([...conditions, { anyOf: [{ namedOnField: match[1] }, { namedOnField: match[2] }] }]);

  match = text.match(/^there is a character with "([^"]+)" in its card name on your field$/);
  if (match) return combineConditions([...conditions, { nameContainsOnField: match[1] }]);

  match = text.match(/^a character on your field has bp higher than its base bp$/);
  if (match) return combineConditions([...conditions, { fieldBpAboveBase: true }]);

  match = text.match(/^you have (one|two|three|four|five|six|seven|\d+) or more characters on your field$/);
  if (match) {
    return combineConditions([...conditions, {
      fieldCountMin: numberFromText(match[1], 0),
      filter: { type: CARD_TYPES.CHARACTER }
    }]);
  }

  match = text.match(/^you have (one|two|three|four|five|six|seven|\d+) or more resting characters on your front line$/);
  if (match) return combineConditions([...conditions, { restingFrontCharactersMin: numberFromText(match[1], 0) }]);

  match = text.match(/^you have (one|two|three|four|five|six|seven|\d+) or more characters without \[trigger\] abilities on your field$/);
  if (match) {
    return combineConditions([...conditions, {
      fieldCountMin: numberFromText(match[1], 0),
      filter: { type: CARD_TYPES.CHARACTER, noTrigger: true }
    }]);
  }

  match = text.match(/^you have (one|two|three|four|five|six|seven|\d+) or more \[([^\]]+)\] affinity cards? on your field$/);
  if (match) {
    return combineConditions([...conditions, {
      fieldCountMin: numberFromText(match[1], 0),
      filter: { affinity: match[2] }
    }]);
  }

  match = text.match(/^you have a <([^>]+)> card in your (sideline|removal area)$/);
  if (match) {
    return combineConditions([...conditions, {
      zone: match[2] === "removal area" ? "removal" : "sideline",
      zoneCountMin: 1,
      filter: { name: match[1] }
    }]);
  }

  match = text.match(/^you have (one|two|three|four|five|six|seven|\d+) or more <([^>]+)> cards? in your (sideline|removal area)$/);
  if (match) {
    return combineConditions([...conditions, {
      zone: match[3] === "removal area" ? "removal" : "sideline",
      zoneCountMin: numberFromText(match[1], 0),
      filter: { name: match[2] }
    }]);
  }

  match = text.match(/^you have (one|two|three|four|five|six|seven|\d+) or more cards with different required energy values in your sideline$/);
  if (match) return combineConditions([...conditions, { differentRequiredEnergyValuesInSidelineMin: numberFromText(match[1], 0) }]);

  match = text.match(/^the combined total of your life and your opponent's life is (one|two|three|four|five|six|seven|\d+) or less$/);
  if (match) return combineConditions([...conditions, { combinedLifeMax: numberFromText(match[1], 0) }]);

  match = text.match(/^you have (one|two|three|four|five|six|seven|\d+) or more other cards in your hand$/);
  if (match) return combineConditions([...conditions, { handOtherCardsMin: numberFromText(match[1], 0) }]);

  match = text.match(/^you have a combined total of (one|two|three|four|five|six|seven|\d+) or more <([^>]+)> or other \[([^\]]+)\] affinity cards? on your field$/);
  if (match) {
    return combineConditions([...conditions, {
      fieldCountMin: numberFromText(match[1], 0),
      filter: {
        anyOf: [
          { name: match[2] },
          { affinity: match[3], otherThanName: match[2] }
        ]
      }
    }]);
  }

  match = text.match(/^you have a combined total of (one|two|three|four|five|six|seven|\d+) or more \[([^\]]+)\] or \[([^\]]+)\] affinity cards? on your front line or <([^>]+)> is on your front line$/);
  if (match) {
    return combineConditions([...conditions, {
      anyOf: [
        {
          frontLineCountMin: numberFromText(match[1], 0),
          filter: { anyOf: [{ affinity: match[2] }, { affinity: match[3] }] }
        },
        { namedOnFrontLine: match[4] }
      ]
    }]);
  }

  if (text === "your or your opponent's deck or life area has a face-up card") {
    return combineConditions([...conditions, { anyFaceUpDeckOrLife: true }]);
  }

  return combineConditions(conditions);
}

function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let quote = false;
  let start = 0;
  const needle = ` ${separator} `;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\"") quote = !quote;
    if (!quote && char === "<") depth += 1;
    if (!quote && char === ">") depth = Math.max(0, depth - 1);
    if (!quote && depth === 0 && text.slice(index, index + needle.length) === needle) {
      parts.push(text.slice(start, index).trim());
      start = index + needle.length;
      index += needle.length - 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

function combineConditions(conditions) {
  const filtered = conditions.filter((condition) => condition && Object.keys(condition).length > 0);
  if (filtered.length === 0) return {};
  if (filtered.length === 1) return filtered[0];
  return { allOf: filtered };
}

function parseChoiceModeAssists(rawText) {
  const text = compactEffectText(rawText).toLowerCase();
  if (!text.includes("when a character on your field activates a \"choose one of the following\" ability")) return [];
  if (!text.includes("that ability becomes \"choose two of the following\" instead")) return [];
  return [{
    mode: "chooseN",
    max: 2,
    sourceType: CARD_TYPES.CHARACTER,
    during: "controllerTurn",
    cost: {
      restSelf: true,
      underCardsToSideline: 1
    }
  }];
}

function parseTriggerReplacements(rawText) {
  const lower = compactEffectText(rawText).toLowerCase();
  const replacements = [];
  if (lower.includes("if you activate a [get trigger] ability on a character card with fulfilled required energy")
    && lower.includes("you may play that card set to resting onto your field instead")) {
    replacements.push({
      triggerType: TRIGGER_TYPES.GET,
      during: "opponentTurn",
      optional: true,
      requiredEnergyFulfilled: true,
      filter: { type: CARD_TYPES.CHARACTER },
      effect: {
        kind: "sequence",
        effects: [
          {
            kind: "playSourceFromZone",
            source: "sideline",
            rested: true,
            destinationLine: LINES.FRONT
          },
          { kind: "moveHandToZone", amount: 1, destination: "sideline" }
        ]
      }
    });
  }

  if (!lower.includes("if you activate a green[color trigger]ability") || !lower.includes("you may instead perform")) return replacements;
  replacements.push({
    triggerType: TRIGGER_TYPES.COLOR,
    color: "green",
    during: "opponentTurn",
    line: LINES.FRONT,
    optional: true,
    effect: {
      kind: "sequence",
      effects: [
        { kind: "draw", amount: 1 },
        {
          kind: "playOrRaidCardFromZone",
          zones: ["hand"],
          count: 1,
          rested: false,
          destinationLine: LINES.FRONT,
          choiceKey: "replacementZoneIndex",
          allowRaid: true,
          filter: {
            type: CARD_TYPES.CHARACTER,
            requiredEnergyFulfilled: true,
            apCost: 1
          }
        }
      ]
    }
  });
  return replacements;
}

function encodeRestThenEffect(lower, context = {}) {
  const patterns = [
    {
      optional: true,
      match: lower.match(/^you may switch one active (.+?) on your (front line|field) to resting\. if you do,?\s*(.+)$/)
    },
    {
      optional: false,
      match: lower.match(/^switch one active (.+?) on your (front line|field) to resting\. if you do,?\s*(.+)$/)
    },
    {
      optional: false,
      match: lower.match(/^switch one other active (.+?) on your (front line|field) to resting\. if you do,?\s*(.+)$/),
      otherThanSource: true
    },
    {
      optional: false,
      match: lower.match(/^switch to resting one active (.+?) on your (front line|field)\. if you do,?\s*(.+)$/)
    }
  ];
  const selected = patterns.find((item) => item.match);
  if (!selected) return undefined;

  const [, subject, lineText, followUpText] = selected.match;
  const target = restThenTargetFromSubject(subject, lineText);
  if (!target) return undefined;
  if (selected.otherThanSource) target.otherThanSource = true;
  const encoded = encodeEffectBody(followUpText, { ...context, allowChoice: true });
  return {
    effect: {
      kind: "restTargetsThen",
      optional: selected.optional,
      target,
      effect: encoded.effect
    },
    unsupported: encoded.unsupported
  };
}

function restThenTargetFromSubject(subjectText, lineText) {
  const subject = subjectText.trim();
  const target = {
    controller: "self",
    line: lineText === "front line" ? LINES.FRONT : "field",
    max: 1,
    rested: false
  };
  if (subject.includes("character")) target.type = CARD_TYPES.CHARACTER;
  if (subject.includes("other active") || subject.startsWith("other ")) target.otherThanSource = true;

  const name = subject.match(/<([^>]+)>/);
  if (name) {
    target.type = CARD_TYPES.CHARACTER;
    target.name = name[1];
  }

  const requiredEnergyMax = subject.match(/(\d+) or less required energy/);
  if (requiredEnergyMax) target.requiredEnergyMax = Number(requiredEnergyMax[1]);

  const affinityPair = subject.match(/\[([^\]]+)\] or \[([^\]]+)\] affinity/);
  if (affinityPair) {
    target.affinities = [affinityPair[1], affinityPair[2]];
  } else {
    const affinity = subject.match(/\[([^\]]+)\] affinity/);
    if (affinity) target.affinity = affinity[1];
  }

  if (!target.type && (target.name || target.affinity || target.affinities)) target.type = CARD_TYPES.CHARACTER;
  return target.name || target.affinity || target.affinities || target.type ? target : undefined;
}

function fieldTargetFromMoveOrSwapSubject(subjectText) {
  const subject = subjectText.trim();
  const target = {
    controller: "self",
    line: "field",
    type: CARD_TYPES.CHARACTER,
    max: subject.includes("any number") ? undefined : 1
  };
  const names = [...subject.matchAll(/<([^>]+)>/g)].map((match) => ({ name: match[1] }));
  const affinity = subject.match(/\[([^\]]+)\] affinity/);
  const anyOf = [...names];
  if (affinity) anyOf.push({ affinity: affinity[1] });
  if (anyOf.length > 0) target.anyOf = anyOf;
  return target;
}

export function encodeEffectBody(rawText, context = {}) {
  const originalLower = compactEffectText(rawText).toLowerCase();
  const text = stripEffectTags(compactEffectText(rawText));
  if (!text) return { effect: { kind: "none" }, unsupported: [] };

  const preChoiceRestriction = encodeReplacementOrUseRestriction(text.toLowerCase());
  const choice = context.allowChoice === false ? undefined : encodeChoiceEffect(text, context);
  if (choice) {
    return preChoiceRestriction
      ? {
        effect: {
          kind: "sequence",
          effects: [preChoiceRestriction, choice.effect]
        },
        unsupported: choice.unsupported
      }
      : choice;
  }

  const effects = [];
  const unsupported = [];
  const preStripLower = text.toLowerCase();
  let lower = preStripLower;
  lower = lower
    .replace(/^-\s*/, "")
    .replace(/^if <[^>]+> is on your field,\s*reduce this card's ap cost by \d+ while in your hand\.?\s*/i, "")
    .replace(/you can only activate this ability[^.]*\./g, "")
    .replace(/you can only use this card[^.]*\./g, "")
    .trim();
  const lowerWithoutQuotedText = lower.replace(/"[^"]*"/g, "");

  if (lower === "ability." || lower === "and" || lower === "abilities on its base card." || lower === "this character gains \"") {
    return { effect: { kind: "none" }, unsupported };
  }

  const restrictOpponentEnergyToFront = lower.match(/during the movement phase of your opponent's next turn,\s*they cannot move characters on their energy line to their front line,\s*but they can move characters on their front line to their energy line\.?/);
  if (restrictOpponentEnergyToFront) {
    effects.push({
      kind: "restrictMovement",
      player: "opponent",
      from: LINES.ENERGY,
      to: LINES.FRONT,
      expires: "endOfOpponentTurn"
    });
  }

  const restNamedDrawCost = lower.match(/^choose up to one <(?<name>[^>]+)> or one character with "(?<partA>[^"]+)" and "(?<partB>[^"]+)" in its card name on your field\. it gains (?<bp>\d+) bp until the start of your next turn\. you may switch one active <(?<restName>[^>]+)> on your field to resting\. if you do,\s*draw a card\.?$/);
  if (restNamedDrawCost) {
    return {
      effect: {
        kind: "sequence",
        effects: [
          {
            kind: "modifyBp",
            amount: Number(restNamedDrawCost.groups.bp),
            duration: "startOfNextTurn",
            target: {
              controller: "self",
              line: "field",
              type: CARD_TYPES.CHARACTER,
              max: 1,
              anyOf: [
                { name: restNamedDrawCost.groups.name },
                { nameIncludesAll: [restNamedDrawCost.groups.partA, restNamedDrawCost.groups.partB] }
              ]
            }
          },
          {
            kind: "restTargetsThen",
            optional: true,
            target: {
              controller: "self",
              line: "field",
              type: CARD_TYPES.CHARACTER,
              name: restNamedDrawCost.groups.restName,
              active: true,
              min: 1,
              max: 1
            },
            effect: { kind: "draw", amount: 1 }
          }
        ]
      },
      unsupported
    };
  }

  const revealTopPlayOrRaidInstead = lower.match(/^reveal the top card of your deck,\s*\{?then place it on the top or bottom of your deck\}?\. if the revealed card is a green character or site card with 3 required energy and 1 ap cost,\s*you may \{?place one card from your hand into your sideline,\s*then play the revealed card set to resting onto your field,\s*or perform raid with it\}? instead\.?$/);
  if (revealTopPlayOrRaidInstead) {
    return {
      effect: {
        kind: "revealTopDeckOptionalPlayOrRaidInstead",
        filter: {
          color: "green",
          requiredEnergyMin: 3,
          requiredEnergyMax: 3,
          apCost: 1,
          anyOf: [
            { type: CARD_TYPES.CHARACTER },
            { type: CARD_TYPES.SITE }
          ]
        },
        costEffect: { kind: "moveHandToZone", amount: 1, destination: "sideline" },
        allowRaid: true,
        rested: true,
        destinationLine: LINES.FRONT,
        destinations: ["top", "bottom"],
        defaultDestination: "top"
      },
      unsupported
    };
  }

  const kanekiOpponentMayRemove = lower.match(/^your opponent may place seven cards from their sideline into their removal area\. if they do,\s*draw two cards,\s*then place one card from your hand into your sideline\. if they don't,\s*choose up to one character with (?<bp>\d+) or less bp on your opponent's front line and sideline it\.?$/);
  if (kanekiOpponentMayRemove) {
    return {
      effect: {
        kind: "opponentMayMoveCardsBetweenZonesElse",
        source: "sideline",
        destination: "removal",
        count: 7,
        ifMovedEffect: {
          kind: "sequence",
          effects: [
            { kind: "draw", amount: 2 },
            { kind: "moveHandToZone", amount: 1, destination: "sideline" }
          ]
        },
        elseEffect: {
          kind: "sidelineTargets",
          target: opponentFrontCharacter({ max: 1, bpMax: Number(kanekiOpponentMayRemove.groups.bp) })
        }
      },
      unsupported
    };
  }

  const dmsUnderToHandReady = lower.match(/^look at the face-down cards under this character\. reveal up to two cards among them and add them to your hand\. if you add two cards to your hand,\s*switch this character to active\.?$/);
  if (dmsUnderToHandReady) {
    return {
      effect: {
        kind: "sequence",
        effects: [
          { kind: "moveUnderCardsToZone", count: 2, destination: "hand", faceUp: true, target: "self" },
          {
            kind: "conditional",
            condition: { lastMovedUnderCardMin: 2 },
            effect: { kind: "readySelf" }
          }
        ]
      },
      unsupported
    };
  }

  const cursedBlueMoveDraw = lower.match(/^(?:you can only use one <cursed technique lapse: blue> card per turn\.\s*)?choose one character with 1 or less energy generation on your opponent's energy line and move it to their front line\. then,\s*if none of your opponent's characters were placed into their removal area due to this move,\s*draw a card\.?/);
  if (cursedBlueMoveDraw) {
    return {
      effect: {
        kind: "sequence",
        effects: [
          {
            kind: "moveTargetsToLine",
            destinationLine: LINES.FRONT,
            target: {
              type: CARD_TYPES.CHARACTER,
              max: 1,
              controller: "opponent",
              line: LINES.ENERGY,
              energyGenerationMax: 1
            }
          },
          {
            kind: "conditional",
            condition: { lastMoveToLineRemovalCountMax: 0 },
            effect: { kind: "draw", amount: 1 }
          }
        ]
      },
      unsupported
    };
  }

  const restTargetThenReadySelf = lower.match(/^choose up to one character with (?<bp>\d+) or more bp on your opponent's front line and switch it to resting\. switch this character to active\.?$/);
  if (restTargetThenReadySelf) {
    return {
      effect: {
        kind: "sequence",
        effects: [
          {
            kind: "restTargets",
            target: {
              type: CARD_TYPES.CHARACTER,
              max: 1,
              controller: "opponent",
              line: LINES.FRONT,
              bpMin: Number(restTargetThenReadySelf.groups.bp)
            }
          },
          { kind: "readySelf" }
        ]
      },
      unsupported
    };
  }

  const optionalReduceSelfBpReady = lower.match(/^you may reduce this character's bp by (?<bp>\d+) until the end of the turn\. if you do,\s*switch it to active\.?$/);
  if (optionalReduceSelfBpReady) {
    return {
      effect: {
        kind: "optional",
        choiceKey: "optionalEffect",
        default: true,
        effect: {
          kind: "sequence",
          effects: [
            { kind: "modifyBp", amount: -Number(optionalReduceSelfBpReady.groups.bp), duration: "turn", target: "self" },
            { kind: "readySelf" }
          ]
        }
      },
      unsupported
    };
  }

  const optionalRestNamedSelfBuff = lower.match(/^you may switch to resting one active <(?<name>[^>]+)> on your front line\. if you do,\s*this character gains (?<bp>\d+) bp and \[impact\s*\((?<impact>\d+)\)\] until the end of the turn\.?$/);
  if (optionalRestNamedSelfBuff) {
    return {
      effect: {
        kind: "restTargetsThen",
        optional: true,
        target: {
          controller: "self",
          line: LINES.FRONT,
          type: CARD_TYPES.CHARACTER,
          name: optionalRestNamedSelfBuff.groups.name,
          active: true,
          min: 1,
          max: 1
        },
        effect: {
          kind: "sequence",
          effects: [
            { kind: "modifyBp", amount: Number(optionalRestNamedSelfBuff.groups.bp), duration: "turn", target: "self" },
            { kind: "grantKeyword", keyword: "impact", value: Number(optionalRestNamedSelfBuff.groups.impact), duration: "turn", target: "self" }
          ]
        }
      },
      unsupported
    };
  }

  if (lower.includes("you may perform: \"draw a card and give this character 1000 bp until the end of the turn.\" if you do, place one base card of this raided character into your sideline")) {
    return {
      effect: {
        kind: "optional",
        choiceKey: "optionalEffect",
        default: true,
        effect: {
          kind: "sequence",
          effects: [
            { kind: "draw", amount: 1 },
            { kind: "modifyBp", amount: 1000, duration: "turn", target: "self" },
            { kind: "moveBaseCardFromSelf", destination: "sideline" }
          ]
        }
      },
      unsupported
    };
  }

  const hasSuppressPlayedAbilities = lower.includes("abilities on characters played with this ability do not activate")
    || lower.includes("abilities on characters you and your opponent play with this ability do not activate")
    || lower.includes("[when played] abilities on characters played with this ability do not activate")
    || lower.includes("[when played] abilities on characters you and your opponent play with this ability do not activate");

  const replacementOrUseRestriction = encodeReplacementOrUseRestriction(preStripLower);
  if (replacementOrUseRestriction) effects.push(replacementOrUseRestriction);

  const targetingModifier = encodeTargetingModifier(lower);
  if (targetingModifier) effects.push(targetingModifier);

  const choiceModeModifier = encodeChoiceModeModifier(lower);
  if (choiceModeModifier) effects.push(choiceModeModifier);

  if (lower.includes("your opponent reveals all the cards in their hand")) {
    effects.push({ kind: "revealOpponentHand" });
  }

  const opponentFrontEnergyRestSwap = lower.match(
    /^choose up to one character on your opponent's front line and up to one character with (\d+) or less energy generation on (?:their|your opponent's) energy line and switch them to resting\. if you chose two cards, (?:\{?you may swap them\}?)(?:\. if you also have (\d+) or less life, \{?you may swap them\. they each gain "this character cannot move" until the start of your next turn\}? instead)?\.?$/
  );
  if (opponentFrontEnergyRestSwap) {
    const frontTarget = {
      type: CARD_TYPES.CHARACTER,
      max: 1,
      controller: "opponent",
      line: LINES.FRONT,
      choiceKey: "frontRestTarget"
    };
    const energyTarget = {
      type: CARD_TYPES.CHARACTER,
      max: 1,
      controller: "opponent",
      line: LINES.ENERGY,
      energyGenerationMax: Number(opponentFrontEnergyRestSwap[1]),
      choiceKey: "energyRestTarget"
    };
    const baseSwap = {
      kind: "optional",
      choiceKey: "optionalSwap",
      default: true,
      effect: { kind: "swapChosenTargets", firstTarget: frontTarget, secondTarget: energyTarget }
    };
    const upgradedSwap = opponentFrontEnergyRestSwap[2]
      ? {
        kind: "conditional",
        condition: { lifeMax: Number(opponentFrontEnergyRestSwap[2]) },
        effect: {
          kind: "optional",
          choiceKey: "optionalSwap",
          default: true,
          effect: {
            kind: "sequence",
            effects: [
              { kind: "swapChosenTargets", firstTarget: frontTarget, secondTarget: energyTarget },
              {
                kind: "grantKeyword",
                keyword: "cannotMove",
                duration: "startOfNextTurn",
                target: frontTarget
              },
              {
                kind: "grantKeyword",
                keyword: "cannotMove",
                duration: "startOfNextTurn",
                target: energyTarget
              }
            ]
          }
        },
        elseEffect: baseSwap
      }
      : baseSwap;
    return {
      effect: {
        kind: "sequence",
        effects: [
          { kind: "restTargets", target: frontTarget },
          { kind: "restTargets", target: energyTarget },
          upgradedSwap
        ]
      },
      unsupported
    };
  }

  const faceUpTopDeckAddThen = lower.match(/^(?<before>.+?)if there is a face-up card on the top of your deck, you may add it to your hand\. if you do, switch this character to active and turn the top card of your deck face up\.?$/);
  if (faceUpTopDeckAddThen) {
    const beforeText = faceUpTopDeckAddThen.groups.before.trim().replace(/\.$/, "");
    const before = beforeText ? encodeEffectBody(beforeText, { ...context, allowChoice: true }) : { effect: { kind: "none" }, unsupported: [] };
    const conditional = {
      kind: "conditional",
      condition: { topDeckFaceUp: true },
      effect: {
        kind: "optional",
        choiceKey: "optionalTopDeckAdd",
        default: true,
        effect: {
          kind: "sequence",
          effects: [
            { kind: "moveTopDeck", count: 1, destination: "hand" },
            { kind: "readySelf" },
            { kind: "turnTopDeckFaceUp" }
          ]
        }
      }
    };
    const beforeEffects = before.effect?.kind === "sequence"
      ? before.effect.effects
      : before.effect?.kind && before.effect.kind !== "none" ? [before.effect] : [];
    return {
      effect: { kind: "sequence", effects: [...beforeEffects, conditional] },
      unsupported: [...unsupported, ...before.unsupported]
    };
  }

  const optionalRevealHandToTopThen = lower.match(/^you may reveal one (?<subject>.+?) from your hand and place it on the top of your deck\. if you do,?\s*(?<followUp>.+)$/);
  if (optionalRevealHandToTopThen) {
    const subject = optionalRevealHandToTopThen.groups.subject;
    const names = [...subject.matchAll(/<([^>]+)>/g)].map((match) => ({ name: match[1] }));
    const affinities = [...subject.matchAll(/\[([^\]]+)\] affinity/g)].map((match) => ({ affinity: match[1] }));
    const filter = names.length + affinities.length > 1
      ? { anyOf: [...names, ...affinities] }
      : names[0] ?? affinities[0] ?? {};
    const followUp = encodeEffectBody(optionalRevealHandToTopThen.groups.followUp, { ...context, allowChoice: true });
    return {
      effect: {
        kind: "optional",
        choiceKey: "optionalEffect",
        default: true,
        effect: {
          kind: "sequence",
          effects: [
            {
              kind: "moveHandToZone",
              amount: 1,
              destination: "deck",
              position: "top",
              filter
            },
            followUp.effect
          ]
        }
      },
      unsupported: [...unsupported, ...followUp.unsupported]
    };
  }

  const hasCopyOrGainAbilities = lower.includes("gains all abilities listed below")
    || lower.includes("gains all abilities on the cards placed into the removal area by this ability")
    || lower.includes("gains one") && lower.includes("ability that includes")
    || lower.includes("ability this turn, you can activate it without performing")
    || lower.includes("can perform raid on this character");

  const attackingKeywordCondition = lower.match(/^if your opponent's attacking character has \[(impact|damage|snipe|step|double attack|double block|nullify impact)(?:\s*\([^)]+\))?\]\s*,\s*(.+)$/);
  if (attackingKeywordCondition) {
    const encoded = encodeEffectBody(attackingKeywordCondition[2], { ...context, allowChoice: true });
    return {
      effect: {
        kind: "conditional",
        condition: { attackingKeyword: keywordNameFromText(attackingKeywordCondition[1]) },
        effect: encoded.effect
      },
      unsupported: encoded.unsupported
    };
  }

  const optionalPayAp = lower.match(/^you may pay (\d+) ap\. if you do,?\s*(.*)$/);
  if (optionalPayAp) {
    const encoded = encodeEffectBody(optionalPayAp[2], { ...context, allowChoice: true });
    return {
      effect: {
        kind: "optional",
        choiceKey: "optionalPayAp",
        default: true,
        effect: {
          kind: "sequence",
          effects: [
            { kind: "payAp", amount: Number(optionalPayAp[1]) },
            encoded.effect
          ]
        }
      },
      unsupported: encoded.unsupported
    };
  }

  const optionalPayApOnly = lower.match(/^you may pay (\d+) ap\.?$/);
  if (optionalPayApOnly) {
    return {
      effect: {
        kind: "optional",
        choiceKey: "optionalPayAp",
        default: true,
        effect: { kind: "payAp", amount: Number(optionalPayApOnly[1]) }
      },
      unsupported
    };
  }

  const optionalRestSelfThen = lower.match(/^you may switch this active (?:character|site|card) to resting\. if you do,?\s*(.*)$/);
  if (optionalRestSelfThen) {
    const encoded = encodeEffectBody(optionalRestSelfThen[1].trim(), { ...context, allowChoice: true });
    return {
      effect: {
        kind: "optional",
        choiceKey: "optionalEffect",
        default: true,
        effect: {
          kind: "sequence",
          effects: [
            { kind: "restSelf" },
            encoded.effect
          ]
        }
      },
      unsupported: encoded.unsupported
    };
  }

  const optionalDrawThenHandMove = lower.match(/^you may draw (a|one|two|three|\d+) cards?\. if you do,?\s*place (one|two|three|\d+) cards? from your hand into your sideline\.?$/);
  if (optionalDrawThenHandMove) {
    return {
      effect: {
        kind: "optional",
        choiceKey: "optionalEffect",
        default: true,
        effect: {
          kind: "sequence",
          effects: [
            { kind: "draw", amount: numberFromText(optionalDrawThenHandMove[1], 1) },
            {
              kind: "moveHandToZone",
              amount: numberFromText(optionalDrawThenHandMove[2], 1),
              destination: "sideline"
            }
          ]
        }
      },
      unsupported
    };
  }

  const optionalHandMove = lower.match(/^you may place (one|two|three|\d+)(?: (red|blue|green|yellow|purple))? cards? from your hand into your (sideline|removal area)\. if you do,?\s*(.*)$/);
  if (optionalHandMove) {
    const moved = {
      kind: "moveHandToZone",
      amount: numberFromText(optionalHandMove[1], 1),
      destination: optionalHandMove[3] === "removal area" ? "removal" : "sideline",
      filter: optionalHandMove[2] ? { color: optionalHandMove[2] } : undefined
    };
    const followUp = optionalHandMove[4].trim();
    const drawThen = followUp.match(/^draw a card(?:, then| and)\s*(.*)$/);
    const encoded = encodeEffectBody(drawThen ? drawThen[1] : followUp, { ...context, allowChoice: true });
    const optionalEffect = {
      kind: "optional",
      choiceKey: "optionalEffect",
      default: true,
      effect: {
        kind: "sequence",
        effects: drawThen
          ? [moved, { kind: "draw", amount: 1 }, encoded.effect]
          : [moved, encoded.effect]
      }
    };
    return {
      effect: effects.length > 0 ? { kind: "sequence", effects: [...effects, optionalEffect] } : optionalEffect,
      unsupported: encoded.unsupported
    };
  }

  const optionalAffinitySidelineRemovalReady = lower.match(/^you may place (one|two|three|four|five|six|seven|\d+) \[([^\]]+)\] affinity cards? from your sideline into your removal area\. if you do, switch this character to active, give it (\d+) bp and "this character cannot be blocked by a character with (\d+) or less bp" until the end of the turn, and place the base card of this raided character into your sideline\.?$/);
  if (optionalAffinitySidelineRemovalReady) {
    return {
      effect: {
        kind: "optional",
        choiceKey: "optionalEffect",
        default: true,
        effect: {
          kind: "sequence",
          effects: [
            {
              kind: "moveCardBetweenZones",
              source: "sideline",
              destination: "removal",
              count: numberFromText(optionalAffinitySidelineRemovalReady[1], 1),
              filter: { affinity: optionalAffinitySidelineRemovalReady[2] }
            },
            { kind: "readySelf" },
            { kind: "modifyBp", amount: Number(optionalAffinitySidelineRemovalReady[3]), duration: "turn", target: "self" },
            {
              kind: "grantKeyword",
              keyword: "cantBeBlockedByBpMax",
              value: Number(optionalAffinitySidelineRemovalReady[4]),
              duration: "turn",
              target: "self"
            },
            { kind: "moveBaseCardFromSelf", destination: "sideline" }
          ]
        }
      },
      unsupported
    };
  }

  const optionalEqualTypeSidelineRemovalImpact = lower.match(/^you may place one character card and one event card from your sideline into your removal area\. if you do, this character gains \[impact \((\d+)\)\] until the end of the turn\.?$/);
  if (optionalEqualTypeSidelineRemovalImpact) {
    return {
      effect: {
        kind: "optional",
        choiceKey: "optionalEffect",
        default: true,
        effect: {
          kind: "sequence",
          effects: [
            {
              kind: "moveEqualCountsBetweenZones",
              source: "sideline",
              destination: "removal",
              minEach: 1,
              countEach: 1,
              filters: [
                { type: CARD_TYPES.CHARACTER },
                { type: CARD_TYPES.EVENT }
              ],
              countChoiceKey: "equalZoneMoveCount"
            },
            {
              kind: "grantKeyword",
              keyword: "impact",
              value: Number(optionalEqualTypeSidelineRemovalImpact[1]),
              duration: "turn",
              target: "self"
            }
          ]
        }
      },
      unsupported
    };
  }

  const targetBpThenEqualTypeSidelineRemoval = lower.match(/^choose up to one character on your opponent's front line\. it loses (\d+) bp until the end of the turn\. you may place any number of character cards and an equal number of event cards from your sideline into your removal area\. for each card placed into your removal area with this ability, the chosen character loses an additional (\d+) bp until the end of the turn\.?$/);
  if (targetBpThenEqualTypeSidelineRemoval) {
    const target = {
      type: CARD_TYPES.CHARACTER,
      max: 1,
      controller: "opponent",
      line: LINES.FRONT,
      choiceKey: "bpTarget"
    };
    return {
      effect: {
        kind: "sequence",
        effects: [
          { kind: "modifyBp", amount: -Number(targetBpThenEqualTypeSidelineRemoval[1]), duration: "turn", target },
          {
            kind: "optional",
            choiceKey: "optionalEffect",
            default: true,
            effect: {
              kind: "sequence",
              effects: [
                {
                  kind: "moveEqualCountsBetweenZones",
                  source: "sideline",
                  destination: "removal",
                  filters: [
                    { type: CARD_TYPES.CHARACTER },
                    { type: CARD_TYPES.EVENT }
                  ],
                  countChoiceKey: "equalZoneMoveCount"
                },
                {
                  kind: "modifyBpForLastMovedCards",
                  amountPerCard: -Number(targetBpThenEqualTypeSidelineRemoval[2]),
                  duration: "turn",
                  target
                }
              ]
            }
          }
        ]
      },
      unsupported
    };
  }

  const handMoveThen = lower.match(/^place (one|two|three|four|five|\d+)(?: (red|blue|green|yellow|purple))? cards? from your hand into your (sideline|removal area)\. if you do,?\s*(.*)$/);
  if (handMoveThen) {
    const moved = {
      kind: "moveHandToZone",
      amount: numberFromText(handMoveThen[1], 1),
      destination: handMoveThen[3] === "removal area" ? "removal" : "sideline",
      filter: handMoveThen[2] ? { color: handMoveThen[2] } : undefined
    };
    const encoded = encodeEffectBody(handMoveThen[4].trim(), { ...context, allowChoice: true });
    return {
      effect: {
        kind: "sequence",
        effects: [moved, encoded.effect]
      },
      unsupported: encoded.unsupported
    };
  }

  const allFieldBpThenHandScale = lower.match(/^all characters on your field gain (\d+) bp until the end of the turn\. you may place any number of cards? from your hand into your sideline\. if you do, all characters on your field also gain (\d+) bp for each card placed from your hand into your sideline with this ability until the end of the turn\.?$/);
  if (allFieldBpThenHandScale) {
    const target = {
      controller: "self",
      line: "field",
      type: CARD_TYPES.CHARACTER
    };
    return {
      effect: {
        kind: "sequence",
        effects: [
          { kind: "modifyBp", amount: Number(allFieldBpThenHandScale[1]), duration: "turn", target },
          {
            kind: "optional",
            choiceKey: "optionalEffect",
            default: true,
            effect: {
              kind: "sequence",
              effects: [
                { kind: "moveAllHandToZone", destination: "sideline" },
                {
                  kind: "modifyBpForLastMovedFromHandCards",
                  amountPerCard: Number(allFieldBpThenHandScale[2]),
                  duration: "turn",
                  target
                }
              ]
            }
          }
        ]
      },
      unsupported
    };
  }

  const anyHandBpRangeSideline = lower.match(/^place any number of cards? from your hand into your sideline\. choose up to one character with \{?(\d+)\}? or less bp on your opponent's front line and sideline it\. for each card placed from your hand into your sideline with this ability, add (\d+) to the bp range of the character you may choose with this ability(?<suffix>\..*)?$/);
  if (anyHandBpRangeSideline) {
    const target = {
      type: CARD_TYPES.CHARACTER,
      max: 1,
      controller: "opponent",
      line: LINES.FRONT,
      bpMax: Number(anyHandBpRangeSideline[1]),
      bpMaxPerLastMovedFromHand: Number(anyHandBpRangeSideline[2])
    };
    const baseEffect = { kind: "sidelineTargets", target };
    const removalInstead = /if you sideline a character with this ability,\s*you may also place one card from your hand into your sideline\. if you do,\s*that character is placed into the removal area instead/i.test(anyHandBpRangeSideline.groups.suffix ?? "")
      ? {
        kind: "optionalInstead",
        choiceKey: "optionalRemovalInstead",
        default: true,
        requiredMovedFromHand: 1,
        costEffect: { kind: "moveHandToZone", amount: 1, destination: "sideline" },
        baseEffect,
        insteadEffect: { kind: "removeTargets", target }
      }
      : baseEffect;
    return {
      effect: {
        kind: "sequence",
        effects: [
          { kind: "moveAllHandToZone", destination: "sideline" },
          removalInstead
        ]
      },
      unsupported
    };
  }

  const rizeSidelineUnderTarget = lower.match(/^choose one <([^>]+)> with no face-down cards under it on your field\. place this card from your sideline face down under the chosen character\. you may place one card from your hand into your sideline\. if you do, switch the character chosen with this ability to active\. it loses (\d+) bp until the end of the turn\.?$/);
  if (rizeSidelineUnderTarget) {
    const target = {
      controller: "self",
      line: "field",
      type: CARD_TYPES.CHARACTER,
      name: rizeSidelineUnderTarget[1],
      noFaceDownUnder: true,
      max: 1,
      choiceKey: "underTarget"
    };
    return {
      effect: {
        kind: "sequence",
        effects: [
          { kind: "moveSelfCardUnderTarget", faceUp: false, target },
          {
            kind: "optional",
            choiceKey: "optionalEffect",
            default: true,
            effect: {
              kind: "sequence",
              effects: [
                { kind: "moveHandToZone", amount: 1, destination: "sideline" },
                { kind: "readyTargets", target },
                { kind: "modifyBp", amount: -Number(rizeSidelineUnderTarget[2]), duration: "turn", target }
              ]
            }
          }
        ]
      },
      unsupported
    };
  }

  const anyHandMove = lower.match(/^(?:you may )?place any number of cards? from your hand into your (sideline|removal area)\.?$/);
  if (anyHandMove) {
    return {
      effect: {
        kind: "moveAllHandToZone",
        destination: anyHandMove[1] === "removal area" ? "removal" : "sideline"
      },
      unsupported
    };
  }

  const optionalNoTriggerHandMove = lower.match(/^you may place (one|two|three|\d+) cards? without \[trigger\] abilities from your hand into your sideline\. if you do,?\s*(.*)$/);
  if (optionalNoTriggerHandMove) {
    const moved = {
      kind: "moveHandToZone",
      amount: numberFromText(optionalNoTriggerHandMove[1], 1),
      destination: "sideline",
      filter: { noTrigger: true }
    };
    const encoded = encodeEffectBody(optionalNoTriggerHandMove[2].trim(), { ...context, allowChoice: true });
    const optionalEffect = {
      kind: "optional",
      choiceKey: "optionalEffect",
      default: true,
      effect: {
        kind: "sequence",
        effects: [moved, encoded.effect]
      }
    };
    return {
      effect: effects.length > 0 ? { kind: "sequence", effects: [...effects, optionalEffect] } : optionalEffect,
      unsupported: encoded.unsupported
    };
  }

  const fieldUnderToSidelineThen = lower.match(/^you may place one face-down card under a (?:character|card) on your field into your sideline\. if you do,?\s*(.*)$/);
  if (fieldUnderToSidelineThen) {
    const encoded = encodeEffectBody(fieldUnderToSidelineThen[1].trim(), { ...context, allowChoice: true });
    return {
      effect: {
        kind: "optional",
        choiceKey: "optionalEffect",
        default: true,
        effect: {
          kind: "sequence",
          effects: [
            {
              kind: "moveUnderCardsToZone",
              count: 1,
              destination: "sideline",
              target: {
                controller: "self",
                line: "field",
                max: 1,
                hasFaceDownUnder: true
              }
            },
            encoded.effect
          ]
        }
      },
      unsupported: encoded.unsupported
    };
  }

  const allUnderSelfToSidelineThen = lower.match(/^you may place all face-down cards under this character into your sideline\. if you do,?\s*for each card placed into your sideline with this ability, this character gains (\d+) bp until the end of the turn\. if you place two or more cards into your sideline, this character also gains \[damage \((\d+)\)\][^.]* until the end of the turn\.?$/);
  if (allUnderSelfToSidelineThen) {
    return {
      effect: {
        kind: "optional",
        choiceKey: "optionalEffect",
        default: true,
        effect: {
          kind: "sequence",
          effects: [
            { kind: "moveUnderCardsToZone", all: true, faceUp: false, destination: "sideline", target: "self" },
            {
              kind: "modifyBpForLastMovedUnderCards",
              amountPerCard: Number(allUnderSelfToSidelineThen[1]),
              duration: "turn",
              target: "self"
            },
            {
              kind: "conditional",
              condition: { lastMovedUnderCardMin: 2 },
              effect: {
                kind: "grantKeyword",
                keyword: "damage",
                value: Number(allUnderSelfToSidelineThen[2]),
                duration: "turn",
                target: "self"
              }
            }
          ]
        }
      },
      unsupported
    };
  }

  if (/^look at the face-down cards under this character\. reveal up to two cards among them and add them to your hand\. if you add two cards to your hand, switch this character to active\.?$/.test(lower)) {
    return {
      effect: {
        kind: "sequence",
        effects: [
          { kind: "moveUnderCardsToZone", count: 2, faceUp: true, destination: "hand", target: "self" },
          {
            kind: "conditional",
            condition: { lastMovedUnderCardMin: 2 },
            effect: { kind: "readySelf" }
          }
        ]
      },
      unsupported
    };
  }

  const sidelineOwnThen = lower.match(/^(you may )?sideline one(?<affinity> \[[^\]]+\] affinity)? character on your field(?<trailingAffinity> with \[[^\]]+\] affinity)?(?<other> other than <[^>]+>)?\. if you do,?\s*(?<followUp>.+)$/);
  if (sidelineOwnThen
    && !sidelineOwnThen.groups.followUp.includes("play that card set to active onto your field")
    && !sidelineOwnThen.groups.followUp.includes("activate this site's [when played] ability")
    && !sidelineOwnThen.groups.followUp.includes("activate this character's [when played] ability")
    && !sidelineOwnThen.groups.followUp.includes("activate this site's ability")
    && !sidelineOwnThen.groups.followUp.includes("activate this character's ability")) {
    const target = {
      controller: "self",
      line: "field",
      type: CARD_TYPES.CHARACTER,
      min: 1,
      max: 1,
      choiceKey: "sidelineTarget"
    };
    const affinity = (sidelineOwnThen.groups.affinity ?? sidelineOwnThen.groups.trailingAffinity)?.match(/\[([^\]]+)\]/);
    if (affinity) target.affinity = affinity[1];
    const other = sidelineOwnThen.groups.other?.match(/<([^>]+)>/);
    if (other) target.otherThanName = other[1];
    const encoded = encodeEffectBody(sidelineOwnThen.groups.followUp.trim(), { ...context, allowChoice: true });
    const effect = {
      kind: "sequence",
      effects: [
        { kind: "sidelineTargets", target },
        encoded.effect
      ]
    };
    return {
      effect: sidelineOwnThen[1]
        ? { kind: "optional", choiceKey: "optionalEffect", default: true, effect }
        : effect,
      unsupported: encoded.unsupported
    };
  }

  const restThen = encodeRestThenEffect(lower, context);
  if (restThen) {
    return {
      effect: effects.length > 0 ? { kind: "sequence", effects: [...effects, restThen.effect] } : restThen.effect,
      unsupported: restThen.unsupported
    };
  }

  const leadingCondition = parseLeadingCondition(lower);
  if (leadingCondition) {
    if (!leadingCondition.body) return { effect: { kind: "none" }, unsupported };
    const encoded = encodeEffectBody(leadingCondition.body, { ...context, allowChoice: false });
    return {
      effect: {
        kind: "conditional",
        condition: leadingCondition.condition,
        effect: encoded.effect
      },
      unsupported: encoded.unsupported
    };
  }

  const playSourceMatch = lower.match(/play this card(?: from your sideline)? set to (active|resting) onto your (front line|field)/);
  if (playSourceMatch) {
    effects.push({
      kind: "playSourceFromZone",
      source: "sideline",
      rested: playSourceMatch[1] !== "active",
      destinationLine: LINES.FRONT
    });
  }

  if (/^move this character to the other line or swap it with a character on the other line\.?$/.test(lower)) {
    return {
      effect: {
        kind: "chooseOne",
        choiceKey: "moveOrSwapChoice",
        choices: [
          { id: "move", effect: { kind: "moveTargetsToOtherLine", target: "self" } },
          { id: "swap", effect: { kind: "swapSourceWithOtherLine" } }
        ]
      },
      unsupported
    };
  }

  const chooseMoveOrSwap = lower.match(/^choose(?: up to)? one (.+?) on your field and move it to the other line or swap it with a character on the other line\.?$/);
  if (chooseMoveOrSwap) {
    const target = fieldTargetFromMoveOrSwapSubject(chooseMoveOrSwap[1]);
    return {
      effect: {
        kind: "chooseOne",
        choiceKey: "moveOrSwapChoice",
        choices: [
          { id: "move", effect: { kind: "moveTargetsToOtherLine", target } },
          { id: "swap", effect: { kind: "swapTargetsWithOtherLine", target } }
        ]
      },
      unsupported
    };
  }

  if (/^choose any number of characters on your field and move them to or swap them with characters on the other line\./.test(lower)) {
    return {
      effect: {
        kind: "sequence",
        effects: [
          {
            kind: "moveOrSwapTargetsToOtherLine",
            target: { controller: "self", line: "field", type: CARD_TYPES.CHARACTER }
          },
          { kind: "draw", amount: 1 }
        ]
      },
      unsupported
    };
  }

  const apReduction = encodeApCostReduction(lower);
  if (apReduction) effects.push(apReduction);

  const combinedRequiredEnergyAndApReduction = encodeCombinedRequiredEnergyAndApReduction(lower);
  if (combinedRequiredEnergyAndApReduction) effects.push(combinedRequiredEnergyAndApReduction);

  const namedRequiredEnergyUntilNext = encodeNamedRequiredEnergyUntilNextUse(lower);
  if (namedRequiredEnergyUntilNext) effects.push(namedRequiredEnergyUntilNext);

  const requiredEnergyReduction = lower.match(/reduce the required energy of all \[([^\]]+)\] affinity character cards by\s*\[[^\]×x]+[×x](\d+)\]\s*while in your hand until the end of the turn/);
  if (requiredEnergyReduction) {
    effects.push({
      kind: "reduceRequiredEnergy",
      amount: Number(requiredEnergyReduction[2]),
      sourceZone: "hand",
      expires: "endOfTurn",
      filter: {
        type: CARD_TYPES.CHARACTER,
        affinity: requiredEnergyReduction[1]
      }
    });
  }

  const raidRequiredEnergyReduction = lower.match(/reduce the required energy of the next <([^>]+)> card you perform raid with from your hand this turn by \[[^\]×x]+[×x](\d+)\]/);
  if (raidRequiredEnergyReduction) {
    effects.push({
      kind: "reduceRequiredEnergy",
      amount: Number(raidRequiredEnergyReduction[2]),
      sourceZone: "hand",
      expires: "endOfTurn",
      consumeOnUse: true,
      filter: { name: raidRequiredEnergyReduction[1] }
    });
  }

  const bpRangeBonus = lower.match(/the next time you choose a character with an ability that specifies a bp range this turn, add (\d+) to the specified bp/);
  if (bpRangeBonus) {
    effects.push({
      kind: "modifyNextBpRange",
      amount: Number(bpRangeBonus[1]),
      expires: "endOfTurn"
    });
  }

  const useEventFromSidelineMatch = lower.match(/use up to one <([^>]+)> card(?: with fulfilled required energy)? from your sideline/);
  if (useEventFromSidelineMatch) {
    effects.push({
      kind: "useEventFromZone",
      source: "sideline",
      destination: lower.includes("removal area instead of your sideline") ? "removal" : "sideline",
      filter: {
        type: CARD_TYPES.EVENT,
        name: useEventFromSidelineMatch[1]
      }
    });
  }

  if (lower.includes("from your sideline and activate its [trigger]")) {
    effects.push({
      kind: "activateTriggerFromZone",
      source: "sideline",
      filter: {
        color: lower.match(/(red|blue|green|yellow|purple) character card/)?.[1],
        type: CARD_TYPES.CHARACTER,
        triggerTypes: lower.includes("[color trigger]") ? [TRIGGER_TYPES.COLOR] : undefined,
        withTrigger: true
      }
    });
  }

  if (lower.includes("activate its [trigger] ability")) {
    effects.push({
      kind: "activateTargetTrigger",
      target: targetFromText(lower) ?? {
        controller: "self",
        line: LINES.FRONT,
        type: CARD_TYPES.CHARACTER,
        max: 1
      }
    });
  }

  if ((lower.includes("choose one of your characters on the other line from this character")
    || /choose one of your \[[^\]]+\] affinity characters on the other line from this character/.test(lower))
    && lower.includes("swap it with this character")) {
    effects.push({
      kind: "swapSourceWithOtherLine",
      choiceKey: "swapTargetIndex"
    });
  }

  if (lower.includes("sideline one character on your field")
    && lower.includes("if you do, play that card set to active onto your field")) {
    effects.push({
      kind: "replayTargets",
      rested: false,
      destinationLine: LINES.FRONT,
      target: {
        controller: "self",
        line: "field",
        type: CARD_TYPES.CHARACTER,
        max: 1,
        choiceKey: "replayTarget"
      }
    });
  }

  if (lower.includes("sideline one character on your field")
    && (originalLower.includes("activate this site's [when played] ability")
      || originalLower.includes("activate this character's [when played] ability"))) {
    return {
      effect: {
        kind: "sidelineTargetsThenActivateSourceWhenPlayed",
        orderChoiceKey: "simultaneousAbilityOrder",
        target: {
          controller: "self",
          line: "field",
          type: CARD_TYPES.CHARACTER,
          min: 1,
          max: 1,
          choiceKey: "sidelineTarget"
        }
      },
      unsupported
    };
  }

  const sidelineOwnThenReadyApDraw = lower.match(/^sideline one character on your field\. if you do, choose up to one of your ap cards and switch it to active\. draw (one|two|three|\d+) cards?\.?$/);
  if (sidelineOwnThenReadyApDraw) {
    return {
      effect: {
        kind: "sequence",
        effects: [
          {
            kind: "sidelineTargets",
            target: {
              controller: "self",
              line: "field",
              type: CARD_TYPES.CHARACTER,
              min: 1,
              max: 1,
              choiceKey: "sidelineTarget"
            }
          },
          { kind: "readyAp", amount: 1 },
          { kind: "draw", amount: numberFromText(sidelineOwnThenReadyApDraw[1], 1) }
        ]
      },
      unsupported
    };
  }

  const restOpponentReadyNamed = lower.match(/^choose one character on your opponent's front line and switch it to resting\. choose up to one <([^>]+)> on your field and switch it to active\.?$/);
  if (restOpponentReadyNamed) {
    return {
      effect: {
        kind: "sequence",
        effects: [
          { kind: "restTargets", target: opponentFrontCharacter({ min: 1, max: 1 }) },
          {
            kind: "readyTargets",
            target: {
              controller: "self",
              line: "field",
              type: CARD_TYPES.CHARACTER,
              name: restOpponentReadyNamed[1],
              max: 1
            }
          }
        ]
      },
      unsupported
    };
  }

  const returnOpponentThenReadyEnergyNamed = lower.match(/^choose up to one character with (\d+) or less bp on your opponent's front line and return it to their hand\. choose up to one <([^>]+)> on your energy line and switch it to active\.?$/);
  if (returnOpponentThenReadyEnergyNamed) {
    return {
      effect: {
        kind: "sequence",
        effects: [
          {
            kind: "returnTargetsToHand",
            target: opponentFrontCharacter({
              max: 1,
              bpMax: Number(returnOpponentThenReadyEnergyNamed[1]),
              choiceKey: "returnTarget"
            })
          },
          {
            kind: "readyTargets",
            target: {
              controller: "self",
              line: LINES.ENERGY,
              type: CARD_TYPES.CHARACTER,
              name: returnOpponentThenReadyEnergyNamed[2],
              max: 1
            }
          }
        ]
      },
      unsupported
    };
  }

  const restLockThenConditionalReady = lower.match(/^choose up to one character on your opponent's front line and switch it to resting\. it will remain set to resting the next time it would be switched to active\. if (.+?), choose up to one character on your field and switch it to active\.?$/);
  if (restLockThenConditionalReady) {
    const condition = parseConditionOnly(`if ${restLockThenConditionalReady[1].trim()}`);
    if (condition) {
      return {
        effect: {
          kind: "sequence",
          effects: [
            { kind: "restTargets", preventNextReady: true, target: opponentFrontCharacter({ max: 1 }) },
            {
              kind: "conditional",
              condition,
              effect: {
                kind: "readyTargets",
                target: {
                  controller: "self",
                  line: "field",
                  type: CARD_TYPES.CHARACTER,
                  max: 1
                }
              }
            }
          ]
        },
        unsupported
      };
    }
  }

  const readyLockedOwnAndSelf = lower.match(/^choose up to one character on your front line that "will remain set to resting the next time it would be switched to active\.?"\.?\s*switch that character and this character to active\.?$/);
  if (readyLockedOwnAndSelf) {
    return {
      effect: {
        kind: "sequence",
        effects: [
          {
            kind: "readyTargets",
            target: {
              controller: "self",
              line: LINES.FRONT,
              type: CARD_TYPES.CHARACTER,
              hasReadyLock: true,
              max: 1
            }
          },
          { kind: "readySelf" }
        ]
      },
      unsupported
    };
  }

  const moveOwnThenRestOpponent = lower.match(/^choose up to one character on your field and move it to the other line, then choose up to one character with (\d+) or less bp on your opponent's front line and switch it to resting\.?$/);
  if (moveOwnThenRestOpponent) {
    return {
      effect: {
        kind: "sequence",
        effects: [
          {
            kind: "moveTargetsToOtherLine",
            target: {
              controller: "self",
              line: "field",
              type: CARD_TYPES.CHARACTER,
              max: 1,
              choiceKey: "moveTarget"
            }
          },
          {
            kind: "restTargets",
            target: opponentFrontCharacter({
              max: 1,
              bpMax: Number(moveOwnThenRestOpponent[1]),
              choiceKey: "restTarget"
            })
          }
        ]
      },
      unsupported
    };
  }

  const restBpMinThenReadySelf = lower.match(/^choose up to one character with (\d+) or more bp on your opponent's front line and switch it to resting\. switch this character to active\.?$/);
  if (restBpMinThenReadySelf) {
    return {
      effect: {
        kind: "sequence",
        effects: [
          {
            kind: "restTargets",
            target: opponentFrontCharacter({
              max: 1,
              bpMin: Number(restBpMinThenReadySelf[1]),
              choiceKey: "restTarget"
            })
          },
          { kind: "readySelf" }
        ]
      },
      unsupported
    };
  }

  const restTargetOptionalReturnInstead = lower.match(/^choose up to one character with (\d+) or more required energy on your opponent's front line and \{?switch it to resting\}?\. if (there are .+?), you may place one card from your hand into your sideline\. if you do, \{?return it to their hand\}? instead\.?$/);
  if (restTargetOptionalReturnInstead) {
    const target = opponentFrontCharacter({
      max: 1,
      requiredEnergyMin: Number(restTargetOptionalReturnInstead[1]),
      choiceKey: "insteadTarget"
    });
    const condition = parseConditionOnly(`if ${restTargetOptionalReturnInstead[2].trim()}`);
    return {
      effect: {
        kind: "optionalInstead",
        choiceKey: "optionalInstead",
        default: true,
        condition,
        requiredMovedFromHand: 1,
        costEffect: {
          kind: "moveHandToZone",
          amount: 1,
          destination: "sideline"
        },
        baseEffect: { kind: "restTargets", target },
        insteadEffect: { kind: "returnTargetsToHand", target }
      },
      unsupported
    };
  }

  if (lower.includes("choose one character on both your opponent's front line and energy line")
    && lower.includes("your opponent may sideline one of the chosen characters")
    && lower.includes("if they do not, draw a card and switch up to one of your ap cards to active")) {
    return {
      effect: {
        kind: "opponentMaySidelineChosenTargetsElse",
        targets: [
          {
            controller: "opponent",
            line: LINES.FRONT,
            type: CARD_TYPES.CHARACTER,
            min: 1,
            max: 1,
            choiceKey: "frontTarget"
          },
          {
            controller: "opponent",
            line: LINES.ENERGY,
            type: CARD_TYPES.CHARACTER,
            min: 1,
            max: 1,
            choiceKey: "energyTarget"
          }
        ],
        elseEffect: {
          kind: "sequence",
          effects: [
            { kind: "draw", amount: 1 },
            { kind: "readyAp", amount: 1 }
          ]
        }
      },
      unsupported
    };
  }

  const otherAffinityToTopDeck = lower.match(/place up to one other \[([^\]]+)\] affinity card on your front line on the top of your deck/);
  if (otherAffinityToTopDeck) {
    effects.push({
      kind: "moveTargetsToDeck",
      position: "top",
      target: {
        controller: "self",
        line: LINES.FRONT,
        type: CARD_TYPES.CHARACTER,
        affinity: otherAffinityToTopDeck[1],
        otherThanSource: true,
        max: 1
      }
    });
  }

  if (lower.includes("place one other card on your field on the top or bottom of your deck")) {
    effects.push({
      kind: "moveTargetsToDeck",
      positions: ["top", "bottom"],
      positionChoiceKey: "deckPosition",
      target: {
        controller: "self",
        line: "field",
        max: 1,
        otherThanSource: true
      }
    });
  }

  const target = targetFromText(lower, originalLower) ?? context.defaultTarget;
  if (target
    && lower.includes("switch it to resting")
    && lower.includes("the player whose character was switched to resting with this ability draws a card")) {
    return {
      effect: {
        kind: "restTargetsThen",
        optional: lower.startsWith("you may"),
        target,
        effect: { kind: "drawLastRestedTargetControllers", amount: 1 }
      },
      unsupported
    };
  }

  if (target
    && lower.includes("if your opponent has 3 or less life")
    && lower.includes("when this character's attack is not blocked, draw a card")) {
    effects.push({
      kind: "conditional",
      condition: { opponentLifeMax: 3 },
      effect: {
        kind: "grantKeyword",
        keyword: "drawOnUnblockedAttack",
        value: 1,
        duration: "turn",
        target
      }
    });
  }

  if (target
    && lower.includes("return it to their hand")
    && lower.includes("if the chosen character is resting")
    && /sideline it\}?\s+instead/.test(lower)) {
    return {
      effect: {
        kind: "targetConditional",
        target,
        condition: { rested: true },
        effect: { kind: "sidelineTargets" },
        elseEffect: { kind: "returnTargetsToHand" }
      },
      unsupported
    };
  }

  if (target && /place the top card of your deck face down under the chosen character/.test(lower)) {
    effects.push({
      kind: "placeTopDeckUnderTargets",
      count: 1,
      faceUp: false,
      target
    });
  }

  if (/^switch this character to active\.?(?:\s*\[[^\]]+\]\s*)*$/.test(lower)) {
    return { effect: { kind: "readySelf" }, unsupported };
  }

  const readyAndBp = lower.match(/^switch (?:this character|it) to active and (?:give it|this character gains) (\d+) bp until the end of the turn\.?$/);
  if (readyAndBp) {
    return {
      effect: {
        kind: "sequence",
        effects: [
          { kind: target ? "readyTargets" : "readySelf", target: target ?? undefined },
          { kind: "modifyBp", amount: Number(readyAndBp[1]), duration: "turn", target: target ?? "self" }
        ]
      },
      unsupported
    };
  }

  const readyPlayedAndBp = lower.match(/^switch the character you played to active and give it (\d+) bp until the end of the turn\.?$/);
  if (readyPlayedAndBp) {
    return {
      effect: {
        kind: "sequence",
        effects: [
          { kind: "readyLastPlayedPermanent" },
          { kind: "modifyBpLastPlayedPermanent", amount: Number(readyPlayedAndBp[1]), duration: "turn" }
        ]
      },
      unsupported
    };
  }

  if (lower === "switch it to active." || lower === "switch it to active" || lower === "switch this character to active") {
    effects.push({
      kind: "readyTargets",
      target: target ?? "self"
    });
  }

  const repeatedBpLoss = encodeRepeatedBpLoss(lower);
  if (repeatedBpLoss) return { effect: repeatedBpLoss, unsupported };

  if (hasSuppressPlayedAbilities) effects.push({ kind: "suppressPlayedAbilities" });
  const grantedTimingAbility = encodeGrantedTimingAbility(originalLower, target);
  if (grantedTimingAbility) {
    effects.push(grantedTimingAbility.effect);
    unsupported.push(...grantedTimingAbility.unsupported);
  }
  if (lower.includes("gains \"this character cannot attack\"")
    && lower.includes("\"if this character is active at the end of your attack phase, sideline it\"")) {
    effects.push({
      kind: "grantAbility",
      target: target ?? "self",
      duration: "turn",
      ability: {
        id: "granted-end-attack-phase-sideline",
        timing: TIMINGS.END_OF_ATTACK_PHASE,
        oncePerTurn: false,
        conditions: { active: true, turn: "controller" },
        effect: { kind: "moveSelfCardToZone", destination: "sideline" }
      }
    });
  }
  const copyOrGainAbilities = encodeCopyOrGainAbilities(lower, target);
  if (copyOrGainAbilities) {
    effects.push(copyOrGainAbilities);
  } else if (hasCopyOrGainAbilities) {
    effects.push({ kind: "copyOrGainAbilities" });
  }

  const drawThenPlayWithoutRaid = encodeDrawThenPlayWithoutRaid(lower);
  if (drawThenPlayWithoutRaid) return { effect: drawThenPlayWithoutRaid, unsupported };

  const bpInstead = encodeBpInstead(lower, target);
  if (bpInstead) return { effect: wrapOptionalIfNeeded(lower, bpInstead), unsupported };

  const drawInstead = encodeDrawInstead(lower);
  if (drawInstead) return { effect: wrapOptionalIfNeeded(lower, drawInstead), unsupported };

  if (lower.includes("it gains \"at the end of your opponent's attack phase, this character returns to your hand\"")
    || lower.includes("this character returns to your hand\" until the start of your next turn")) {
    return {
      effect: {
        kind: "scheduleReturnTargetsToHand",
        timing: "endOfAttack",
        activePlayer: "opponent",
        target: "self"
      },
      unsupported
    };
  }

  if (target
    && lower.includes("at the start of your opponent's next turn")
    && lower.includes("sideline that character")
    && lower.includes("move it to your energy line")) {
    return {
      effect: {
        kind: "scheduleSidelineTargetsAndMoveSelfToEnergy",
        target
      },
      unsupported
    };
  }

  const namedMustBlock = lower.match(/opponent must block the chosen <([^>]+)> character's attacks if able this turn/);
  if (namedMustBlock) {
    return {
      effect: {
        kind: "grantKeyword",
        keyword: "mustBlock",
        duration: "turn",
        target: {
          controller: "self",
          line: LINES.FRONT,
          type: CARD_TYPES.CHARACTER,
          name: namedMustBlock[1],
          max: 1
        }
      },
      unsupported
    };
  }

  const targetSidelinedWatcher = lower.match(/you gain "if the chosen character is sidelined, add up to one \[([^\]]+)\] affinity card other than <([^>]+)> from your sideline to your hand"/);
  if (targetSidelinedWatcher) {
    return {
      effect: {
        kind: "watchTargetSidelinedForZoneMove",
        target,
        source: "sideline",
        destination: "hand",
        filter: {
          affinity: targetSidelinedWatcher[1],
          otherThanName: targetSidelinedWatcher[2]
        }
      },
      unsupported
    };
  }

  const targetSidelinedDrawWatcher = lower.match(/you gain "(?:draw (a|one|two|three|\d+) cards? if the chosen character is sidelined|if the chosen character is sidelined, draw (a|one|two|three|\d+) cards?)"/);
  if (targetSidelinedDrawWatcher && target) {
    return {
      effect: {
        kind: "watchTargetSidelinedForEffect",
        target,
        effect: {
          kind: "draw",
          amount: numberFromText(targetSidelinedDrawWatcher[1] ?? targetSidelinedDrawWatcher[2], 1)
        }
      },
      unsupported
    };
  }

  const revealSidelineByUniqueAffinity = lower.match(/reveal any number of cards in your hand\. choose up to one character on your opponent's front line with bp equal to or less than (\d+) multiplied by the number of \[([^\]]+)\] affinity cards with unique names among the revealed cards and on your field\. sideline that character/);
  if (revealSidelineByUniqueAffinity) {
    return {
      effect: {
        kind: "sidelineTargetsByUniqueAffinityReveal",
        amountPerCard: Number(revealSidelineByUniqueAffinity[1]),
        filter: { affinity: revealSidelineByUniqueAffinity[2] },
        target: opponentFrontCharacter({ max: 1 })
      },
      unsupported
    };
  }

  if (/switch this (?:character|card|site) to active/.test(lower)) {
    effects.push({ kind: "readySelf" });
  }

  if (/switch this active (?:character|card|site) to resting/.test(lower)
    || /switch this (?:character|card|site) to resting/.test(lower)) {
    effects.push({ kind: "restSelf" });
  }

  if (/move this character to your front line/.test(lower)) {
    effects.push({
      kind: "moveTargetsToLine",
      destinationLine: LINES.FRONT,
      target: "self"
    });
  }

  if (/move this character to your energy line/.test(lower)) {
    effects.push({
      kind: "moveTargetsToLine",
      destinationLine: LINES.ENERGY,
      target: "self"
    });
  }

  if (/move this character to the other line/.test(lower)) {
    effects.push({
      kind: "moveTargetsToOtherLine",
      target: "self"
    });
  }

  if (lower.includes("sideline one other character on your field")) {
    effects.push({
      kind: "sidelineTargets",
      target: {
        controller: "self",
        line: "field",
        type: CARD_TYPES.CHARACTER,
        max: 1,
        otherThanSource: true
      }
    });
  }

  const sidelineCharacterOtherThanName = lower.match(/sideline one character on your field other than <([^>]+)>/);
  if (sidelineCharacterOtherThanName) {
    effects.push({
      kind: "sidelineTargets",
      target: {
        controller: "self",
        line: "field",
        type: CARD_TYPES.CHARACTER,
        max: 1,
        otherThanName: sidelineCharacterOtherThanName[1]
      }
    });
  }

  const sidelineCharacterOnField = lower.match(/^(?:you may )?sideline one character on your field(?: with \[([^\]]+)\] affinity)?\.?$/);
  if (sidelineCharacterOnField) {
    effects.push({
      kind: "sidelineTargets",
      target: {
        controller: "self",
        line: "field",
        type: CARD_TYPES.CHARACTER,
        max: 1,
        affinity: sidelineCharacterOnField[1] || undefined
      }
    });
  }

  if (lower.includes("you may sideline any number of other characters on your field")
    && lower.includes("draw a number of cards equal to the number of characters sidelined by this ability")) {
    effects.push({
      kind: "sidelineTargetsAndDraw",
      optional: true,
      target: {
        controller: "self",
        line: "field",
        type: CARD_TYPES.CHARACTER,
        otherThanSource: true
      }
    });
  }

  const sidelineAffinityCharacter = lower.match(/sideline one \[([^\]]+)\] affinity character on your field/);
  if (sidelineAffinityCharacter) {
    effects.push({
      kind: "sidelineTargets",
      target: {
        controller: "self",
        line: "field",
        type: CARD_TYPES.CHARACTER,
        affinity: sidelineAffinityCharacter[1],
        max: 1
      }
    });
  }

  const lifeToHandMatch = lower.match(/add(?: up to)? (one|two|\d+) cards? from your life area to your hand/);
  if (lifeToHandMatch) {
    effects.push({
      kind: "moveCardBetweenZones",
      source: "life",
      destination: "hand",
      count: numberFromText(lifeToHandMatch[1], 1),
      choiceKey: "lifeIndices"
    });
  }

  const lifeToSidelineMatch = lower.match(/(?:place|add)(?: up to)? (one|two|\d+) cards? from your life (?:area )?(?:into|to) your sideline/);
  if (lifeToSidelineMatch) {
    effects.push({
      kind: "moveCardBetweenZones",
      source: "life",
      destination: "sideline",
      count: numberFromText(lifeToSidelineMatch[1], 1),
      choiceKey: "lifeIndices"
    });
  }

  const revealSearch = encodeRevealTopDeck(lower);
  if (revealSearch) effects.push(revealSearch);

  const search = encodeSearchTopDeck(lower, context);
  if (search) effects.push(search);
  else {
    const lookAndMove = encodeLookTopDeckAndMove(lower);
    if (lookAndMove) effects.push(lookAndMove);
    else {
      const lookMatch = lower.match(/look at the top(?:\s+\{?(\w+|\d+)(?: cards?)?\}?)?\s*(?:cards?)?\s+of your deck/);
      if (lookMatch) {
        effects.push({ kind: "lookTopDeck", count: numberFromText(lookMatch[1] ?? "one", 1) });
      }
    }
  }

  const readyApMatch = lower.match(/choose up to\s+(\w+|\d+)\s+of your ap cards and switch (?:it|them) to active/);
  if (readyApMatch) {
    effects.push({ kind: "readyAp", amount: numberFromText(readyApMatch[1], 1) });
  }

  if (lower.includes("switch all of your ap cards to active")) {
    effects.push({ kind: "readyAp", amount: 3 });
  }

  if (lower.includes("choose one to two of your resting ap cards and switch them to active")) {
    effects.push({ kind: "readyAp", amount: 2 });
  }

  if (lower.includes("switch one of your ap cards to active")) {
    effects.push({ kind: "readyAp", amount: 1 });
  }

  const returnOtherMatch = lower.match(/return one other character on your field with\s+(\d+)\s+or less required energy to your hand/);
  if (returnOtherMatch) {
    effects.push({
      kind: "returnTargetsToHandOrSelf",
      target: {
        controller: "self",
        line: "field",
        type: CARD_TYPES.CHARACTER,
        max: 1,
        otherThanSource: true,
        requiredEnergyMax: Number(returnOtherMatch[1])
      }
    });
  }

  if (lower.includes("return one other character on your field to your hand")) {
    effects.push({
      kind: "returnTargetsToHandOrSelf",
      target: {
        controller: "self",
        line: "field",
        type: CARD_TYPES.CHARACTER,
        max: 1,
        otherThanSource: true
      }
    });
  }

  const returnOtherAffinityMatch = lower.match(/return one other \[([^\]]+)\] affinity card on your field to your hand/);
  if (returnOtherAffinityMatch) {
    effects.push({
      kind: "returnTargetsToHandOrSelf",
      target: {
        controller: "self",
        line: "field",
        affinity: returnOtherAffinityMatch[1],
        max: 1,
        otherThanSource: true
      }
    });
  }

  const returnOtherAffinityRequiredMatch = lower.match(/return one other \[([^\]]+)\] affinity card on your field with (\d+) or less required energy to your hand/);
  if (returnOtherAffinityRequiredMatch) {
    effects.push({
      kind: "returnTargetsToHandOrSelf",
      target: {
        controller: "self",
        line: "field",
        affinity: returnOtherAffinityRequiredMatch[1],
        requiredEnergyMax: Number(returnOtherAffinityRequiredMatch[2]),
        max: 1,
        otherThanSource: true
      }
    });
  }

  const returnOwnNamed = lower.match(/return one <([^>]+)> on your field to your hand/);
  if (returnOwnNamed) {
    effects.push({
      kind: "returnTargetsToHand",
      target: {
        controller: "self",
        line: "field",
        type: CARD_TYPES.CHARACTER,
        name: returnOwnNamed[1],
        min: 1,
        max: 1
      }
    });
  }

  const returnOwnNamedList = lower.match(/return one <([^>]+)> or <([^>]+)>, or one other <([^>]+)> on your front line to your hand/);
  if (returnOwnNamedList) {
    effects.push({
      kind: "returnTargetsToHand",
      target: {
        controller: "self",
        line: LINES.FRONT,
        type: CARD_TYPES.CHARACTER,
        names: [returnOwnNamedList[1], returnOwnNamedList[2], returnOwnNamedList[3]],
        otherThanSource: true,
        min: 1,
        max: 1
      }
    });
  }

  const returnOwnFieldAffinity = lower.match(/return one (?:character|card) (?:from|on) your field with \[([^\]]+)\] affinity to your hand/);
  if (returnOwnFieldAffinity) {
    effects.push({
      kind: "returnTargetsToHand",
      target: {
        controller: "self",
        line: "field",
        type: CARD_TYPES.CHARACTER,
        affinity: returnOwnFieldAffinity[1],
        min: 1,
        max: 1
      }
    });
  }

  const returnOwnFieldRequired = lower.match(/return one (?:character|card) on your field with (\d+) or less required energy to your hand/);
  if (returnOwnFieldRequired) {
    effects.push({
      kind: "returnTargetsToHand",
      target: {
        controller: "self",
        line: "field",
        type: CARD_TYPES.CHARACTER,
        requiredEnergyMax: Number(returnOwnFieldRequired[1]),
        min: 1,
        max: 1
      }
    });
  }

  if (/return one (?:character|card) from your field to your hand/.test(lower)
    || /return one (?:character|card) on your field to your hand/.test(lower)) {
    effects.push({
      kind: "returnTargetsToHand",
      target: {
        controller: "self",
        line: "field",
        type: CARD_TYPES.CHARACTER,
        min: 1,
        max: 1
      }
    });
  }

  const topDeckToSidelineMatch = lower.match(/place(?: up to)?\s+(\w+|\d+)?\s*cards? from the top of your deck into your sideline|place the top\s+(\w+|\d+)?\s*cards? of your deck into your sideline/);
  if (topDeckToSidelineMatch) {
    effects.push({
      kind: "moveTopDeck",
      count: numberFromText(topDeckToSidelineMatch[1] ?? topDeckToSidelineMatch[2] ?? "one", 1),
      destination: "sideline"
    });
  }

  if (lower.includes("turn the top card of your deck face up")) {
    effects.push({ kind: "turnTopDeckFaceUp" });
  }

  if (lower.includes("your opponent reveals the top card of their deck")
    && lower.includes("into their sideline")) {
    effects.push({ kind: "moveTopDeck", player: "opponent", count: 1, destination: "sideline" });
  }

  const underSelfMatch = lower.match(/place(?: the)? top\s+(\w+|\d+)?\s*cards? of your deck face down under this character/);
  if (underSelfMatch) {
    effects.push({
      kind: "placeTopDeckUnderSelf",
      count: numberFromText(underSelfMatch[1] ?? "one", 1)
    });
  }

  const underAnySelfMatch = lower.match(/place(?: the)? top\s+(\w+|\d+)?\s*cards? of your deck face down under this (?:character|site|card)/);
  if (underAnySelfMatch && !underSelfMatch) {
    effects.push({
      kind: "placeTopDeckUnderSelf",
      count: numberFromText(underAnySelfMatch[1] ?? "one", 1)
    });
  }

  if (lower.includes("add one face-down card under this character to your hand")
    || lower.includes("add up to one face-down card under this character to your hand")) {
    effects.push({
      kind: "moveUnderCardsToZone",
      count: 1,
      destination: "hand",
      target: "self"
    });
  }

  if (lower.includes("look at the face-down cards under this character. add up to one card among them to your hand")
    || lower.includes("look at the cards under this character. add up to one of those cards to your hand")) {
    effects.push({
      kind: "moveUnderCardsToZone",
      count: 1,
      destination: "hand",
      target: "self"
    });
  }

  if (lower.includes("add the cards under this site to your hand")) {
    effects.push({
      kind: "moveUnderCardsToZone",
      all: true,
      destination: "hand",
      target: "self"
    });
  }

  const handUnderSelfMatch = lower.match(/place(?: up to)?\s+(one|a|two|three|four|\d+)\s+cards? from your hand face down under this (?:character|site|card)/);
  if (handUnderSelfMatch) {
    const count = numberFromText(handUnderSelfMatch[1], 1);
    effects.push({
      kind: "moveHandCardsUnderSelf",
      count,
      faceUp: false,
      ...(lower.includes("place up to") ? { min: 0 } : {})
    });
  }

  const handUnderTargetMatch = lower.match(/place(?: up to)?\s+(one|a|two|three|four|\d+)\s+cards? from your hand face down under (?:it|the chosen character)/);
  if (handUnderTargetMatch && target) {
    const count = numberFromText(handUnderTargetMatch[1], 1);
    effects.push({
      kind: "moveHandCardsUnderTargets",
      count,
      faceUp: false,
      target,
      ...(lower.includes("place up to") ? { min: 0 } : {})
    });
  }

  const fieldUnderCardsToSideline = lower.match(/place(?: a combined total of)?\s+(one|two|three|four|\d+)\s+face-down cards? under (?:characters|cards) on your field(?: and the top card from this character)? into your sideline/);
  if (fieldUnderCardsToSideline) {
    effects.push({
      kind: "moveUnderCardsToZone",
      count: numberFromText(fieldUnderCardsToSideline[1], 1),
      destination: "sideline",
      target: {
        controller: "self",
        line: "field",
        hasFaceDownUnder: true
      }
    });
  }

  if (lower.includes("place all cards under it into their owner's sideline")
    || lower.includes("place all cards under the chosen character into their owner's sideline")) {
    effects.push({
      kind: "moveUnderCardsToZone",
      all: true,
      destination: "sideline",
      target: target ?? { controller: "both", line: "field", max: 1, hasUnderCards: true }
    });
  }

  if (lower.includes("face-down card under a card on your field into your sideline")
    || lower.includes("face-down card under a character on your field into your sideline")) {
    effects.push({
      kind: "moveUnderCardsToZone",
      count: 1,
      destination: "sideline",
      target: {
        controller: "self",
        line: "field",
        max: 1,
        hasFaceDownUnder: true
      }
    });
  }

  if (lower.includes("face-down card under this character into your sideline")
    || lower.includes("face-down card under this site into your sideline")) {
    effects.push({
      kind: "moveUnderCardsToZone",
      count: 1,
      destination: "sideline",
      target: "self"
    });
  }

  const sidelineUnderSelf = lower.match(/place(?: up to)? one\s+(red|blue|green|yellow|purple)?\s*<([^>]+)>[^.]*from your sideline face down under this character/);
  if (sidelineUnderSelf) {
    effects.push({
      kind: "moveZoneCardsUnderSelf",
      source: "sideline",
      count: 1,
      faceUp: false,
      filter: {
        type: CARD_TYPES.CHARACTER,
        color: sidelineUnderSelf[1] || undefined,
        name: sidelineUnderSelf[2]
      }
    });
  }

  const sidelineAffinityUnderSelf = lower.match(/place(?: up to)? one\s+\[([^\]]+)\] affinity card from your sideline face down under this character/);
  if (sidelineAffinityUnderSelf) {
    effects.push({
      kind: "moveZoneCardsUnderSelf",
      source: "sideline",
      count: 1,
      faceUp: false,
      filter: { affinity: sidelineAffinityUnderSelf[1] }
    });
  }

  const sidelineAffinityUnderTarget = lower.match(/place(?: up to)? one\s+\[([^\]]+)\] affinity card from your sideline face down under a \[([^\]]+)\] affinity card on your field/);
  if (sidelineAffinityUnderTarget) {
    effects.push({
      kind: "moveZoneCardsUnderTargets",
      source: "sideline",
      count: 1,
      faceUp: false,
      filter: { affinity: sidelineAffinityUnderTarget[1] },
      target: {
        controller: "self",
        line: "field",
        affinity: sidelineAffinityUnderTarget[2],
        max: 1
      }
    });
  }

  const sidelineNamedUnderFaceDownTarget = lower.match(/place(?: up to)? one\s+<([^>]+)>(?: card)? from your sideline face down under a <([^>]+)> with no face-down cards under it on your field/);
  if (sidelineNamedUnderFaceDownTarget) {
    effects.push({
      kind: "moveZoneCardsUnderTargets",
      source: "sideline",
      count: 1,
      faceUp: false,
      filter: { name: sidelineNamedUnderFaceDownTarget[1] },
      target: {
        controller: "self",
        line: "field",
        name: sidelineNamedUnderFaceDownTarget[2],
        max: 1,
        noFaceDownUnder: true
      }
    });
  }

  const sidelineNamedUnderTarget = lower.match(/place(?: up to)? one\s+<([^>]+)> card.*from your sideline face up under a non-raided <([^>]+)>.*on your front line/);
  if (sidelineNamedUnderTarget) {
    effects.push({
      kind: "moveZoneCardsUnderTargets",
      source: "sideline",
      count: 1,
      faceUp: true,
      filter: { name: sidelineNamedUnderTarget[1] },
      target: {
        controller: "self",
        line: LINES.FRONT,
        name: sidelineNamedUnderTarget[2],
        max: 1
      }
    });
  }

  const sidelineToHand = encodeMoveCardFromSidelineToHand(lower);
  if (sidelineToHand) effects.push(sidelineToHand);

  const playFromZone = encodePlayCharacterFromZone(lower, "playZoneIndex");
  if (playFromZone) {
    effects.push(playFromZone);
    if (grantsLastPlayedReturnToHand(originalLower)) {
      effects.push({
        kind: "scheduleLastPlayedPermanentToZone",
        timing: TIMINGS.END_OF_ATTACK_PHASE,
        zone: "hand",
        sidelined: false
      });
    } else if (lower.includes("at the start of the end phase, sideline that character")) {
      effects.push({
        kind: "scheduleLastPlayedPermanentToZone",
        timing: TIMINGS.START_OF_END_PHASE,
        zone: "sideline"
      });
    } else if (lower.includes("at the end of the attack phase, sideline that character")) {
      effects.push({
        kind: "scheduleLastPlayedPermanentToZone",
        timing: TIMINGS.END_OF_ATTACK_PHASE,
        zone: "sideline"
      });
    }
  }

  const opponentPlayFromHand = lower.match(/your opponent plays(?: up to)? one character card(?: with \{?(\d+) or less\}? required energy)?(?: and (\d+) ap cost)? from their hand set to\s+\{?(active|resting)\}?.*onto their front line/);
  if (opponentPlayFromHand) {
    effects.push({
      kind: "playCardFromZone",
      player: "opponent",
      zone: "hand",
      rested: opponentPlayFromHand[3] !== "active",
      destinationLine: LINES.FRONT,
      choiceKey: "opponentPlayHandIndex",
      filter: {
        type: CARD_TYPES.CHARACTER,
        requiredEnergyMax: opponentPlayFromHand[1] ? Number(opponentPlayFromHand[1]) : undefined,
        apCost: opponentPlayFromHand[2] ? Number(opponentPlayFromHand[2]) : undefined
      }
    });
  }

  const sameNamePlay = lower.match(/play(?: up to)? (one|two) (?:(red|blue|green|yellow|purple) )?character card with \{?(\d+) or less\}? required energy,?\s+(\d+) ap cost, and the same card name as the chosen character from your (hand or sideline|hand|sideline).*set to\s+\{?(active|resting)\}?.*onto your\s+(front line|field)/);
  if (sameNamePlay && target) {
    effects.push({
      kind: "playCardFromZoneMatchingTargetName",
      zones: zoneListFromText(sameNamePlay[5]),
      count: numberFromText(sameNamePlay[1], 1),
      rested: sameNamePlay[6] !== "active",
      destinationLine: LINES.FRONT,
      choiceKey: "playZoneIndex",
      target,
      filter: {
        type: CARD_TYPES.CHARACTER,
        color: sameNamePlay[2] || undefined,
        requiredEnergyMax: Number(sameNamePlay[3]),
        apCost: Number(sameNamePlay[4])
      }
    });
    if (lower.includes("at the end of the attack phase, sideline that character")) {
      effects.push({
        kind: "scheduleLastPlayedPermanentToZone",
        timing: TIMINGS.END_OF_ATTACK_PHASE,
        zone: "sideline"
      });
    }
  }

  const namedSplitPlay = lower.match(/choose up to one of each of the following cards from your sideline:\s*<([^>]+)>,\s*<([^>]+)>,\s*<([^>]+)>, and <([^>]+)>\. play up to two among them set to\s+\{?(active|resting)\}?.*onto your field\. add any remaining cards to your hand/);
  if (namedSplitPlay) {
    effects.push({
      kind: "playSomeNamedFromSidelineAddRest",
      names: [namedSplitPlay[1], namedSplitPlay[2], namedSplitPlay[3], namedSplitPlay[4]],
      playCount: 2,
      rested: namedSplitPlay[5] !== "active",
      destinationLine: LINES.FRONT
    });
  }

  const sidelineToDeckTop = encodeMoveCardFromSidelineToDeckTop(lower);
  if (sidelineToDeckTop) effects.push(sidelineToDeckTop);

  const namedSidelineToDeckBottom = lower.match(/place(?: up to)? (one|two|three|four|five|\d+) <([^>]+)> cards? from your sideline on the bottom of your deck/);
  if (namedSidelineToDeckBottom) {
    effects.push({
      kind: "moveCardBetweenZones",
      source: "sideline",
      destination: "deck",
      position: "bottom",
      count: numberFromText(namedSidelineToDeckBottom[1], 1),
      filter: { name: namedSidelineToDeckBottom[2] }
    });
  }

  const sidelineToDeckBottom = lower.match(/place(?: up to)? (one|two|three|four|five|\d+) cards? from your sideline on the bottom of your deck/);
  if (sidelineToDeckBottom) {
    effects.push({
      kind: "moveCardBetweenZones",
      source: "sideline",
      destination: "deck",
      position: "bottom",
      count: numberFromText(sidelineToDeckBottom[1], 1)
    });
  }

  const sidelineToRemovalMatch = lower.match(/place(?: up to)? (one|two|three|four|five|six|seven|\d+) cards? from your sideline into your removal area/);
  if (sidelineToRemovalMatch) {
    effects.push({
      kind: "moveCardBetweenZones",
      source: "sideline",
      destination: "removal",
      count: numberFromText(sidelineToRemovalMatch[1], 1)
    });
  }

  const anySidelineToRemovalMatch = lower.match(/place any number of cards? from your sideline into your removal area/);
  if (anySidelineToRemovalMatch) {
    effects.push({
      kind: "moveCardBetweenZones",
      source: "sideline",
      destination: "removal",
      all: true
    });
  }

  const typedSidelineToRemovalMatch = lower.match(/place(?: up to)? (one|two|three|four|five|six|seven|\d+) (character|event|site) cards? from your sideline into your removal area/);
  if (typedSidelineToRemovalMatch) {
    effects.push({
      kind: "moveCardBetweenZones",
      source: "sideline",
      destination: "removal",
      count: numberFromText(typedSidelineToRemovalMatch[1], 1),
      filter: { type: CARD_TYPES[typedSidelineToRemovalMatch[2].toUpperCase()] }
    });
  }

  const namedSidelineToRemoval = lower.match(/place(?: up to)? (one|two|three|four|five|six|seven|\d+) <([^>]+)> cards? from your sideline into your removal area/);
  if (namedSidelineToRemoval) {
    effects.push({
      kind: "moveCardBetweenZones",
      source: "sideline",
      destination: "removal",
      count: numberFromText(namedSidelineToRemoval[1], 1),
      filter: { name: namedSidelineToRemoval[2] }
    });
  }

  const namedSidelineToRemovalMatch = lower.match(/place(?: up to)? (one|two|three|four|five|six|seven|\d+) other <([^>]+)> cards? from your sideline into your removal area/);
  if (namedSidelineToRemovalMatch) {
    effects.push({
      kind: "moveCardBetweenZones",
      source: "sideline",
      destination: "removal",
      count: numberFromText(namedSidelineToRemovalMatch[1], 1),
      filter: { name: namedSidelineToRemovalMatch[2] }
    });
  }

  const affinitySidelineToRemovalMatch = lower.match(/place(?: up to)? (one|two|three|four|five|six|seven|\d+) (red|blue|green|yellow|purple)?\s*\[([^\]]+)\] affinity cards?.*from your sideline into your removal area/);
  if (affinitySidelineToRemovalMatch) {
    effects.push({
      kind: "moveCardBetweenZones",
      source: "sideline",
      destination: "removal",
      count: numberFromText(affinitySidelineToRemovalMatch[1], 1),
      filter: {
        color: affinitySidelineToRemovalMatch[2] || undefined,
        affinity: affinitySidelineToRemovalMatch[3]
      }
    });
  }

  const removalToSidelineMatch = lower.match(/place(?: up to)? (one|two|three|four|\d+) cards? from your removal area into your sideline/);
  if (removalToSidelineMatch) {
    effects.push({
      kind: "moveCardBetweenZones",
      source: "removal",
      destination: "sideline",
      count: numberFromText(removalToSidelineMatch[1], 1)
    });
  }

  const opponentSidelineToBottomDeckMatch = lower.match(/your opponent places (one|two|three|four|\d+|\{one card\}) cards? from their sideline on the bottom of their deck/);
  if (opponentSidelineToBottomDeckMatch) {
    effects.push({
      kind: "moveCardBetweenZones",
      player: "opponent",
      source: "sideline",
      destination: "deck",
      count: numberFromText(String(opponentSidelineToBottomDeckMatch[1]).replace(/[{}]/g, "").replace(" card", ""), 1)
    });
  }

  const opponentSidelineToRemovalMatch = lower.match(/your opponent places (one|two|three|four|five|six|seven|\d+|\{one card\}|\{two cards\})(?: cards?)? from their sideline into their removal area/);
  if (opponentSidelineToRemovalMatch) {
    effects.push({
      kind: "moveCardBetweenZones",
      player: "opponent",
      source: "sideline",
      destination: "removal",
      count: numberFromText(String(opponentSidelineToRemovalMatch[1]).replace(/[{}]/g, "").replace(/ cards?/, ""), 1)
    });
  }

  const affinityFieldBp = lower.match(/all \[([^\]]+)\] affinity cards on your field gain \{?(\d+) bp\}? until the end of the turn/);
  if (affinityFieldBp) {
    effects.push({
      kind: "modifyBp",
      amount: Number(affinityFieldBp[2]),
      duration: "turn",
      target: {
        controller: "self",
        line: "field",
        affinity: affinityFieldBp[1]
      }
    });
  }

  if (lower.includes("sideline one other character on your front line")
    && (lower.includes("activate this character's [when played] ability") || lower.includes("activate this character's ability"))) {
    effects.push({
      kind: "sidelineTargetsThenActivateSourceWhenPlayed",
      orderChoiceKey: "simultaneousAbilityOrder",
      target: {
        controller: "self",
        line: LINES.FRONT,
        type: CARD_TYPES.CHARACTER,
        max: 1,
        otherThanSource: true,
        choiceKey: "sidelineTarget"
      }
    });
  }

  if (lower.includes("activate this character's ability") && !lower.includes("sideline one other character on your front line")) {
    effects.push({
      kind: "activateTargetAbility",
      timing: TIMINGS.WHEN_PLAYED,
      target: "self"
    });
  }

  if (lower.includes("activate this site's ability")) {
    effects.push({
      kind: "activateTargetAbility",
      timing: TIMINGS.ACTIVATE_MAIN,
      target: "self"
    });
  }

  if (lower.includes("move it to the other line") || lower.includes("move it to their other line")) {
    effects.push({
      kind: "moveTargetsToOtherLine",
      target: target ?? { controller: "self", line: "field", type: CARD_TYPES.CHARACTER, max: 1 }
    });
  }

  if (lower.includes("move it to their energy line")) {
    effects.push({
      kind: "moveTargetsToLine",
      destinationLine: LINES.ENERGY,
      target: target ?? opponentFrontCharacter({ max: 1 })
    });
  }

  if (lower.includes("moves that character to their energy line")
    || lower.includes("move that character to their energy line")) {
    effects.push({
      kind: "moveTargetsToLine",
      destinationLine: LINES.ENERGY,
      target: target ?? opponentFrontCharacter({ max: 1 })
    });
  }

  if (lower.includes("move it to your front line")) {
    effects.push({
      kind: "moveTargetsToLine",
      destinationLine: LINES.FRONT,
      target: target ?? { controller: "self", line: LINES.ENERGY, type: CARD_TYPES.CHARACTER, max: 1 }
    });
  }

  if (lower.includes("move it to their front line")) {
    effects.push({
      kind: "moveTargetsToLine",
      destinationLine: LINES.FRONT,
      target: target ?? { controller: "opponent", line: LINES.ENERGY, type: CARD_TYPES.CHARACTER, max: 1 }
    });
  }

  if (lower.includes("character on both your front line and energy line and swap them")) {
    effects.push({ kind: "swapOwnFrontAndEnergy" });
  }

  if (lower.includes("character on both your opponent's front line and energy line and swap them")
    || lower.includes("character on both their front line and energy line and swap them")) {
    effects.push({ kind: "swapOwnFrontAndEnergy", player: "opponent" });
  }

  if (lower.includes("on your front line and one other character on your energy line and swap them")
    || lower.includes("affinity card on your front line and one <")
    || lower.includes("on your front line and one <")) {
    effects.push({ kind: "swapOwnFrontAndEnergy" });
  }

  if (lower.includes("choose one of your characters on your front line and swap it with this character")
    || lower.includes("choose one active character on your front line and swap it with this character")
    || (lower.includes("swap it with this character") && !lower.includes("other line from this character"))) {
    const swapEffect = { kind: "swapSourceWithOtherLine" };
    effects.push(lower.includes("you may swap it with this character")
      ? {
        kind: "optional",
        choiceKey: "optionalSwap",
        default: true,
        effect: swapEffect
      }
      : swapEffect);
  }

  const readyAffinityAll = lower.match(/switch all \[([^\]]+)\] affinity cards on your field to active/);
  if (readyAffinityAll) {
    effects.push({
      kind: "readyTargets",
      target: {
        controller: "self",
        line: "field",
        affinity: readyAffinityAll[1]
      }
    });
  }

  const moveAnyAffinityEnergyToFront = lower.match(/choose any number of \[([^\]]+)\] affinity cards on your energy line and move them to your front line/);
  if (moveAnyAffinityEnergyToFront) {
    effects.push({
      kind: "moveTargetsToLine",
      destinationLine: LINES.FRONT,
      target: {
        controller: "self",
        line: LINES.ENERGY,
        affinity: moveAnyAffinityEnergyToFront[1]
      }
    });
  }

  if (lower.includes("add one character card from your sideline to your hand")) {
    effects.push({
      kind: "moveCardBetweenZones",
      source: "sideline",
      destination: "hand",
      filter: { type: CARD_TYPES.CHARACTER }
    });
  }

  if (lower.includes("place it on the bottom of their deck") || lower.includes("place it on the bottom of your opponent's deck")) {
    effects.push({
      kind: "moveTargetsToBottomDeck",
      target: target ?? { controller: "opponent", line: "field", max: 1 }
    });
  }

  if (lower.includes("top raided card into their sideline")
    || lower.includes("top raided card into its owner's sideline")) {
    effects.push({
      kind: "moveTopRaidCardToZone",
      destination: "sideline",
      target: target ?? opponentFrontCharacter({ max: 1 })
    });
  }

  if (lower.includes("return its top raided card to your hand")) {
    effects.push({
      kind: "moveTopRaidCardToZone",
      destination: "hand",
      target: target ?? { controller: "self", line: "field", max: 1 }
    });
  }

  if (lower.includes("return up to one base card of this raided character to your hand")) {
    effects.push({ kind: "moveBaseCardFromSelf", destination: "hand" });
  }

  if (lower.includes("return the bottom card of this raided character to your hand")) {
    effects.push({ kind: "moveBaseCardFromSelf", destination: "hand" });
  }

  if (lower.includes("place one base card of this raided character into your sideline")
    || lower.includes("place the base card of this raided character into your sideline")) {
    effects.push({ kind: "moveBaseCardFromSelf", destination: "sideline" });
  }

  if (lower.includes("place up to one base card of this raided character face up into your life area")
    || lower.includes("place one base card of this raided character face up into your life area")) {
    effects.push({ kind: "moveBaseCardFromSelf", destination: "life", faceUp: true });
  }

  if (lower.includes("play up to one base card of this raided character set to resting onto your front line")
    || lower.includes("play one base card of this raided character set to resting onto your front line")) {
    effects.push({ kind: "playBaseCardFromSelf", rested: true, destinationLine: LINES.FRONT });
  }

  if (lower.includes("play the base card of this raided character set to active onto your field")
    || lower.includes("play up to one base card of this raided character set to active onto your field")) {
    effects.push({ kind: "playBaseCardFromSelf", rested: false, destinationLine: LINES.FRONT });
  }

  if (lower.includes("play the bottom card of this raided character")) {
    effects.push({ kind: "playBaseCardFromSelf", rested: true, destinationLine: LINES.FRONT });
  }

  if (lower.includes("place the top card from this raided character on the top of your deck")) {
    effects.push({ kind: "moveTopRaidCardToZone", destination: "deck", position: "top", target: "self" });
  }

  if (lower.includes("place the top card from this raided character into your sideline")) {
    effects.push({ kind: "moveTopRaidCardToZone", destination: "sideline", target: "self" });
  }

  const energyMatch = lower.match(/this (?:character|site|card) gains\s*((?:\[(?:red|blue|green|yellow|purple)\]\s*)+)energy generation/);
  if (energyMatch) {
    const colors = [...energyMatch[1].matchAll(/\[(red|blue|green|yellow|purple)\]/g)].map((match) => match[1]);
    const color = colors[0];
    effects.push({
      kind: "grantEnergy",
      color,
      amount: colors.length || 1,
      duration: lower.includes("until the end of the turn") ? "turn" : "permanent",
      target: "self"
    });
    if (lower.includes("at the end of the main phase, sideline this character")) {
      effects.push({ kind: "scheduleSidelineSelfAtEndOfMain" });
    }
  }

  const drawUntilMatch = lowerWithoutQuotedText.match(/draw cards until you have (one|two|three|four|five|six|seven|\d+) cards? in your hand/);
  if (drawUntilMatch) {
    effects.push({
      kind: "drawUntilHandSize",
      handSize: numberFromText(drawUntilMatch[1], 0)
    });
  }

  if (lowerWithoutQuotedText.includes("draw cards until you have the same number of cards in your hand as your opponent")) {
    effects.push({
      kind: "drawUntilHandSize",
      sameAsOpponent: true
    });
  }

  const drawMatch = lowerWithoutQuotedText.match(/\bdraw(?: up to)?\s+\{?(a|one|two|three|four|five|\d+)(?: card)?\}?\s+cards?\b/)
    ?? lowerWithoutQuotedText.match(/\bdraw\s+\{?(a|one|two|three|four|five|\d+)\s+cards?\}?/);
  if (drawMatch) {
    effects.push({ kind: "draw", amount: numberFromText(drawMatch[1], 1) });
  }

  const handToSidelineMatch = lower.match(/place\s+(?:up to\s+)?\{?(one|a|two|three|four|five|six|\d+)\}?\s+cards?\s+from your hand into your sideline/);
  if (handToSidelineMatch) {
    effects.push({
      kind: "moveHandToZone",
      amount: numberFromText(handToSidelineMatch[1], 1),
      destination: "sideline"
    });
  }

  const typedHandToSidelineMatch = lower.match(/place\s+(?:up to\s+)?\{?(one|a|two|three|four|five|six|\d+)\}?\s+(character|event|site)\s+cards?\s+from your hand into your sideline/);
  if (typedHandToSidelineMatch) {
    effects.push({
      kind: "moveHandToZone",
      amount: numberFromText(typedHandToSidelineMatch[1], 1),
      destination: "sideline",
      filter: { type: CARD_TYPES[typedHandToSidelineMatch[2].toUpperCase()] }
    });
  }

  const handToRemovalMatch = lower.match(/place\s+(?:up to\s+)?\{?(one|a|two|three|four|five|six|seven|\d+)\}?\s+cards?\s+from your hand into your removal area/);
  if (handToRemovalMatch) {
    effects.push({
      kind: "moveHandToZone",
      amount: numberFromText(handToRemovalMatch[1], 1),
      destination: "removal"
    });
  }

  const handToTopDeckMatch = lower.match(/place\s+(?:up to\s+)?\{?(one|a|two|three|four|five|six|\d+)\}?\s+cards?\s+from your hand on top of your deck/);
  if (handToTopDeckMatch) {
    effects.push({
      kind: "moveHandToZone",
      amount: numberFromText(handToTopDeckMatch[1], 1),
      destination: "deck",
      position: "top"
    });
  }

  const handToBottomDeckMatch = lower.match(/place\s+(up to\s+)?\{?(one|a|two|three|four|five|six|\d+)\}?\s+cards?\s+from your hand on the bottom of your deck/);
  if (handToBottomDeckMatch) {
    effects.push({
      kind: "moveHandToZone",
      amount: numberFromText(handToBottomDeckMatch[2], 1),
      destination: "deck",
      position: "bottom",
      ...(handToBottomDeckMatch[1] ? { min: 0 } : {})
    });
  }

  const handToTopOrBottomDeckMatch = lower.match(/place\s+(up to\s+)?\{?(one|a|two|three|four|five|six|\d+)\}?\s+cards?\s+from your hand on the top or bottom of your deck/);
  if (handToTopOrBottomDeckMatch) {
    effects.push({
      kind: "moveHandToZone",
      amount: numberFromText(handToTopOrBottomDeckMatch[2], 1),
      destination: "deck",
      positions: ["top", "bottom"],
      defaultPosition: "bottom",
      ...(handToTopOrBottomDeckMatch[1] ? { min: 0 } : {})
    });
  }

  if (lower.includes("draw a number of cards equal to the number of cards placed on the bottom of your deck with this ability")
    && effects.some((effect) => effect.kind === "moveHandToZone" && effect.destination === "deck" && (effect.position === "bottom" || effect.defaultPosition === "bottom"))) {
    effects.push({ kind: "drawLastMovedFromHandCount" });
  }

  if (lower.includes("place all the cards in your hand into your sideline")) {
    effects.push({ kind: "moveAllHandToZone", destination: "sideline" });
  }

  const anyAffinityHandToZoneMatch = lower.match(/place any number of \[([^\]]+)\] affinity cards? from your hand into your (sideline|removal area)/);
  if (anyAffinityHandToZoneMatch) {
    effects.push({
      kind: "moveAllHandToZone",
      destination: anyAffinityHandToZoneMatch[2] === "removal area" ? "removal" : "sideline",
      filter: { affinity: anyAffinityHandToZoneMatch[1] }
    });
  }

  const affinityHandToSidelineMatch = lower.match(/place\s+(?:up to\s+)?\{?(one|a|two|three|four|five|six|\d+)\}?\s+\[([^\]]+)\] affinity cards?\s+from your hand into your sideline/);
  if (affinityHandToSidelineMatch) {
    effects.push({
      kind: "moveHandToZone",
      amount: numberFromText(affinityHandToSidelineMatch[1], 1),
      destination: "sideline",
      filter: { affinity: affinityHandToSidelineMatch[2] }
    });
  }

  const affinityHandToRemovalMatch = lower.match(/place\s+(?:up to\s+)?\{?(one|a|two|three|four|five|six|seven|\d+)\}?\s+\[([^\]]+)\] affinity cards?\s+from your hand into your removal area/);
  if (affinityHandToRemovalMatch) {
    effects.push({
      kind: "moveHandToZone",
      amount: numberFromText(affinityHandToRemovalMatch[1], 1),
      destination: "removal",
      filter: { affinity: affinityHandToRemovalMatch[2] }
    });
  }

  const namedHandToSidelineMatch = lower.match(/place\s+(?:up to\s+)?\{?(one|a|two|three|four|five|six|\d+)\}?\s+<([^>]+)>\s+cards?\s+from your hand into your sideline/);
  if (namedHandToSidelineMatch) {
    effects.push({
      kind: "moveHandToZone",
      amount: numberFromText(namedHandToSidelineMatch[1], 1),
      destination: "sideline",
      filter: { name: namedHandToSidelineMatch[2] }
    });
  }

  const namedOrAffinityHandToSidelineMatch = lower.match(/place\s+(?:up to\s+)?\{?(one|a|two|three|four|five|six|\d+)\}?\s+((?:<[^>]+>,?\s*)+)or\s+\[([^\]]+)\] affinity cards?\s+from your hand into your sideline/);
  if (namedOrAffinityHandToSidelineMatch) {
    const names = [...namedOrAffinityHandToSidelineMatch[2].matchAll(/<([^>]+)>/g)].map((match) => ({ name: match[1] }));
    effects.push({
      kind: "moveHandToZone",
      amount: numberFromText(namedOrAffinityHandToSidelineMatch[1], 1),
      destination: "sideline",
      filter: { anyOf: [...names, { affinity: namedOrAffinityHandToSidelineMatch[3] }] }
    });
  }

  const nameIncludesHandToSidelineMatch = lower.match(/place\s+(?:up to\s+)?\{?(one|a|two|three|four|five|six|\d+)\}?\s+card with "([^"]+)" or "([^"]+)" in its card name from your hand into your sideline/);
  if (nameIncludesHandToSidelineMatch) {
    effects.push({
      kind: "moveHandToZone",
      amount: numberFromText(nameIncludesHandToSidelineMatch[1], 1),
      destination: "sideline",
      filter: {
        type: CARD_TYPES.CHARACTER,
        anyOf: [
          { nameIncludesAll: [nameIncludesHandToSidelineMatch[2]] },
          { nameIncludesAll: [nameIncludesHandToSidelineMatch[3]] }
        ]
      }
    });
  }

  if (lower.includes("add this card from your sideline to your hand")) {
    effects.push({
      kind: "moveSourceCardBetweenZones",
      source: "sideline",
      destination: "hand"
    });
  }

  if (lower === "add this card to your hand" || lower.includes("add this card to your hand") || lower.includes("you may add this card to your hand") || lower.includes("return this card to your hand")) {
    effects.push({
      kind: "moveSelfCardToZone",
      destination: "hand"
    });
  }

  if (lower.includes("add the card that was placed into your sideline to your hand")) {
    effects.push({
      kind: "moveContextCardToZone",
      source: "sideline",
      destination: "hand"
    });
  }

  if (target) {
    const sidelineInsteadIfAffinityField = lower.match(/if you have (one|two|three|four|five|six|seven|\d+) or more \[([^\]]+)\] affinity cards? on your field,\s*\{?sideline it\}?\s+instead/);
    if (sidelineInsteadIfAffinityField && lower.includes("switch it to resting")) {
      return {
        effect: {
          kind: "conditional",
          condition: {
            fieldCountMin: numberFromText(sidelineInsteadIfAffinityField[1], 1),
            filter: { affinity: sidelineInsteadIfAffinityField[2] }
          },
          effect: { kind: "sidelineTargets", target },
          elseEffect: { kind: "restTargets", target }
        },
        unsupported
      };
    }

    const sidelineInsteadIfNamed = lower.match(/if <([^>]+)> is on your field,\s*\{?sideline it\}?\s+instead/);
    if (sidelineInsteadIfNamed && lower.includes("return it to their hand")) {
      return {
        effect: {
          kind: "conditional",
          condition: { namedOnField: sidelineInsteadIfNamed[1] },
          effect: { kind: "sidelineTargets", target },
          elseEffect: { kind: "returnTargetsToHand", target }
        },
        unsupported
      };
    }

    const sidelineInsteadIfSidelineNames = lower.match(/if you have a combined total of (one|two|three|four|five|\d+) or more <([^>]+)> or <([^>]+)> cards in your sideline,\s*\{?sideline it\}?\s+instead/);
    if (sidelineInsteadIfSidelineNames && lower.includes("return it to their hand")) {
      return {
        effect: {
          kind: "conditional",
          condition: {
            zoneCountMin: numberFromText(sidelineInsteadIfSidelineNames[1], 1),
            zone: "sideline",
            filter: {
              anyOf: [
                { name: sidelineInsteadIfSidelineNames[2] },
                { name: sidelineInsteadIfSidelineNames[3] }
              ]
            }
          },
          effect: { kind: "sidelineTargets", target },
          elseEffect: { kind: "returnTargetsToHand", target }
        },
        unsupported
      };
    }

    if (lower.includes("place this card face down under the chosen character")
      || lower.includes("place this card face down under another")) {
      effects.push({
        kind: "moveSelfCardUnderTarget",
        faceUp: false,
        target
      });
    }

    if (lower.includes("place this character face up under it")
      || lower.includes("place this card face up under it")) {
      effects.push({
        kind: "moveSelfCardUnderTarget",
        faceUp: true,
        target
      });
    }

    if (originalLower.includes("activate its [when played] ability")
      || originalLower.includes("activate its [when played]")) {
      effects.push({
        kind: "activateTargetAbility",
        timing: TIMINGS.WHEN_PLAYED,
        target
      });
    }

    if (originalLower.includes("activate its [activate: main] ability")
      || originalLower.includes("activate its [activate: main]")) {
      effects.push({
        kind: "activateTargetAbility",
        timing: TIMINGS.ACTIVATE_MAIN,
        target
      });
    }

    if (lower.includes("activate its") && !originalLower.includes("activate its [")) {
      effects.push({
        kind: "activateTargetAbility",
        timing: TIMINGS.WHEN_PLAYED,
        target
      });
    }

    if (lower.includes("activates all of the chosen character's [when played] abilities")
      || lower.includes("activates all of the chosen character's abilities")) {
      effects.push({
        kind: "activateTargetAbility",
        timing: TIMINGS.WHEN_PLAYED,
        all: true,
        target
      });
    }

    if (lower.includes("place the top card of your deck face down under it")
      || lower.includes("place up to one card from the top of your deck face down under it")) {
      effects.push({
        kind: "placeTopDeckUnderTargets",
        count: 1,
        faceUp: false,
        target
      });
    }

    if (lower.includes("sideline it") || lower.includes("sideline them")) {
      effects.push({ kind: "sidelineTargets", target });
    } else if (lower.includes("return it to their hand") || lower.includes("return it to your hand")) {
      effects.push({ kind: "returnTargetsToHand", target });
    } else if (lower.includes("switch it to resting") || lower.includes("switch them to resting")) {
      effects.push({ kind: "restTargets", target });
    } else if (lower.includes("switch it to active") || lower.includes("switch them to active")) {
      effects.push({ kind: "readyTargets", target });
    }

    if (lower.includes("place it into their removal area")) {
      effects.push({ kind: "removeTargets", target });
    }

    if (lower.includes("place it face up into their life area")) {
      effects.push({ kind: "moveTargetsToLife", faceUp: true, target });
    }

    if (lower.includes("loses abilities") || lower.includes("loses all base abilities")) {
      effects.push({
        kind: "grantKeyword",
        keyword: "lostAbilities",
        duration: lower.includes("until the start of your next turn") ? "startOfNextTurn" : "turn",
        target
      });
    }

    if (lower.includes("at the start of your opponent's next turn") && lower.includes("return it to their hand")) {
      effects.push({
        kind: "scheduleReturnTargetsToHand",
        timing: "startOfTurn",
        activePlayer: "opponent",
        target
      });
    }
  }

  const selfUnderAnotherAffinity = lower.match(/place this card face down under another \[([^\]]+)\] affinity card on your field/);
  if (selfUnderAnotherAffinity) {
    effects.push({
      kind: "moveSelfCardUnderTarget",
      faceUp: false,
      target: {
        controller: "self",
        line: "field",
        affinity: selfUnderAnotherAffinity[1],
        otherThanSource: true,
        max: 1
      }
    });
  }

  if (lower.includes("your opponent returns one character on their front line to their hand")
    || lower.includes("your opponent returns {one} character on their front line to their hand")) {
    effects.push({ kind: "returnTargetsToHand", target: opponentFrontCharacter({ max: 1 }) });
  }

  if (lower.includes("your opponent switches to resting one active character on their front line")) {
    effects.push({ kind: "restTargets", target: opponentFrontCharacter({ max: 1, rested: false }) });
  }

  if (lower.includes("place it on {your opponent's choice} of the top or bottom of their deck")) {
    effects.push({ kind: "moveTargetsToBottomDeck", target: target ?? opponentFrontCharacter({ max: 1 }) });
  }

  const selfNamedRestMatch = lower.match(/switch to resting one active <([^>]+)> on your field/);
  if (selfNamedRestMatch) {
    effects.push({
      kind: "restTargets",
      target: {
        controller: "self",
        line: "field",
        type: CARD_TYPES.CHARACTER,
        name: selfNamedRestMatch[1],
        max: 1,
        rested: false
      }
    });
  }

  if (lower.includes("switch one active character on your front line to resting")) {
    effects.push({
      kind: "restTargets",
      target: {
        controller: "self",
        line: LINES.FRONT,
        type: CARD_TYPES.CHARACTER,
        max: 1,
        rested: false
      }
    });
  }

  if (/^(?:sideline|place into your sideline) this (?:character|site|card)$/.test(lower)
    || lower === "sideline it"
    || lower.includes("sideline this character")
    || lower.includes("sideline this card")
    || lower.includes("sideline this site")) {
    effects.push({ kind: "moveSelfCardToZone", destination: "sideline" });
  }

  if (/place this (?:character|card) into your removal area/.test(lower)) {
    effects.push({ kind: "moveSelfCardToZone", destination: "removal" });
  }

  if (/place this (?:active )?(?:character|card) on the bottom of your deck/.test(lower)) {
    effects.push({ kind: "moveSelfCardToZone", destination: "deck" });
  }

  const bpMatch = lower.match(/(?:gains?|give it|give this character)\s+\{?(\d+)\s+bp\}?/);
  if (bpMatch && !affinityFieldBp) {
    effects.push({
      kind: "modifyBp",
      amount: Number(bpMatch[1]),
      duration: lower.includes("until the end of the turn") ? "turn" : "permanent",
      target: target ?? "self"
    });
  }

  const bpLossMatch = lower.match(/loses?\s+\{?(\d+)\s+bp\}?/);
  if (bpLossMatch) {
    effects.push({
      kind: "modifyBp",
      amount: -Number(bpLossMatch[1]),
      duration: lower.includes("until the end of the turn") ? "turn" : "permanent",
      target: target ?? "self"
    });
  }

  const reduceSelfBpMatch = lower.match(/reduce this character's bp by (\d+)/);
  if (reduceSelfBpMatch) {
    effects.push({
      kind: "modifyBp",
      amount: -Number(reduceSelfBpMatch[1]),
      duration: lower.includes("until the end of the turn") ? "turn" : "permanent",
      target: "self"
    });
  }

  const revealHandBpMatch = lower.match(/reveal any number of cards in your hand\. this character gains bp equal to (\d+) multiplied by the number of \[([^\]]+)\] affinity cards(?: with unique names)? revealed(?: and on your field)?/);
  if (revealHandBpMatch) {
    effects.push({
      kind: "modifyBpForHandReveal",
      amountPerCard: Number(revealHandBpMatch[1]),
      filter: { affinity: revealHandBpMatch[2] },
      uniqueNames: lower.includes("unique names"),
      includeField: lower.includes("on your field"),
      target: "self"
    });
  }

  const damageMatch = lower.match(/deal\s+(one|two|three|\d+)\s+damage to your opponent/);
  if (damageMatch) {
    effects.push({ kind: "damageOpponent", amount: numberFromText(damageMatch[1], 1) });
  }

  const damageThemMatch = lower.match(/deal\s+(one|two|three|\d+)\s+damage to them/);
  if (damageThemMatch) {
    effects.push({ kind: "damageOpponent", amount: numberFromText(damageThemMatch[1], 1) });
  }

  if (lower.includes("your opponent places one card from their hand into their sideline")) {
    effects.push({ kind: "discardOpponentFromHand", amount: 1 });
  }

  if (lower.includes("your opponent reveals all the cards in their hand")
    && lower.includes("place up to one card among them face-up on the top of their deck")) {
    effects.push({
      kind: "moveCardBetweenZones",
      player: "opponent",
      source: "hand",
      destination: "deck",
      position: "top",
      count: 1
    });
  }

  if (lower.includes("your opponent draws a card")) {
    effects.push({ kind: "drawOpponent", amount: 1 });
  }

  if (lowerWithoutQuotedText.includes("remains set to resting the next time it would be switched to active")
    || lowerWithoutQuotedText.includes("remain set to resting the next time it would be switched to active")) {
    effects.push({
      kind: "restTargets",
      preventNextReady: true,
      target: target ?? "self"
    });
  }

  if (lower.includes("place this card on the top of your deck")) {
    effects.push({ kind: "moveSelfCardToDeckTop" });
  }

  if (lower.includes("your opponent sidelines one character on their front line")) {
    effects.push({ kind: "sidelineTargets", target: opponentFrontCharacter({ max: 1 }) });
  }

  if (lower.includes("your opponent sidelines one character on their field")) {
    effects.push({
      kind: "sidelineTargets",
      target: { controller: "opponent", line: "field", type: CARD_TYPES.CHARACTER, max: 1 }
    });
  }

  if (lower.includes("sideline the chosen character")) {
    effects.push({ kind: "sidelineTargets", target: target ?? opponentFrontCharacter({ max: 1 }) });
  }

  const sidelineAllRequiredEnergy = lower.match(/sideline all characters with (\d+) required energy on your opponent's front line/);
  if (sidelineAllRequiredEnergy) {
    effects.push({
      kind: "sidelineTargets",
      target: {
        controller: "opponent",
        line: LINES.FRONT,
        type: CARD_TYPES.CHARACTER,
        requiredEnergyMax: Number(sidelineAllRequiredEnergy[1]),
        requiredEnergyMin: Number(sidelineAllRequiredEnergy[1])
      }
    });
  }

  const keywordGrant = encodeKeywordGrant(originalLower);
  if (keywordGrant) {
    effects.push(target && keywordGrant.target === "self" && lower.includes("choose")
      ? { ...keywordGrant, target }
      : keywordGrant);
  }

  if (effects.length === 0) {
    unsupported.push({ kind: "effect", reason: "unrecognized-effect", sample: clip(text) });
    return {
      effect: { kind: "unsupported", reason: "unrecognized-effect" },
      unsupported
    };
  }

  const copyMovedIndex = effects.findIndex((effect) => effect.kind === "copyActivatedAbilitiesFromMovedCards");
  const copyMoved = copyMovedIndex === -1 ? undefined : effects[copyMovedIndex];
  const sourceMoveIndex = copyMoved
    ? effects.findIndex((effect) => effect.kind === "moveCardBetweenZones"
      && effect.destination === (copyMoved.sourceDestination ?? effect.destination))
    : -1;
  if (copyMovedIndex !== -1 && sourceMoveIndex !== -1 && copyMovedIndex < sourceMoveIndex) {
    effects.splice(copyMovedIndex, 1);
    effects.splice(sourceMoveIndex, 0, copyMoved);
  }

  if (/draw (?:a|one|two|three|\d+) cards?, then place .+ from your hand face down under/i.test(lower)) {
    const drawIndex = effects.findIndex((candidate) => candidate.kind === "draw");
    const handUnderIndex = effects.findIndex((candidate) => candidate.kind === "moveHandCardsUnderSelf" || candidate.kind === "moveHandCardsUnderTargets");
    if (drawIndex !== -1 && handUnderIndex !== -1 && handUnderIndex < drawIndex) {
      const [drawEffect] = effects.splice(drawIndex, 1);
      effects.splice(handUnderIndex, 0, drawEffect);
    }
  }

  const effect = effects.length === 1 ? effects[0] : { kind: "sequence", effects };
  return {
    effect: wrapOptionalIfNeeded(lower, effect),
    unsupported
  };
}

function encodeChoiceEffect(text, context) {
  if (/change .*"choose one of the following"/i.test(text)) return undefined;
  const match = /choose (?:up to )?one of (?:the )?(?:following|abilities listed below)[:.]?\s*/i.exec(text);
  const chooseTwoCostMatch = /\{choose one\} of (?:the )?(?:following|abilities listed below)\.\s*you may place one card with (\d+) ap cost from your hand into your sideline\. if you do,\s*\{choose two\} instead\.\s*/i.exec(text);
  const chooseNMatch = /\{choose one\} of (?:the )?(?:following|abilities listed below).*?\{choose two\} instead\.\s*/i.exec(text);
  const chooseAllMatch = /\{choose one\} of (?:the )?(?:following|abilities listed below)\. if (.+?),\s*(you may\s*)?\{choose all\} instead\.?\s*:?\s*/i.exec(text);
  const chooseTwoAllMatch = /\{choose one\} of (?:the )?(?:following|abilities listed below)\. if (.+?),\s*\{choose two\} instead\. if (.+?),\s*\{choose all\} instead\.?\s*:?\s*/i.exec(text);
  if (!match && !chooseTwoCostMatch && !chooseNMatch && !chooseAllMatch && !chooseTwoAllMatch) return undefined;

  const activeMatch = chooseTwoAllMatch ?? chooseAllMatch ?? chooseTwoCostMatch ?? chooseNMatch ?? match;
  const prefix = text.slice(0, activeMatch.index).trim();
  let branchText = text.slice(activeMatch.index + activeMatch[0].length);
  const postChoiceTexts = [];
  branchText = branchText.replace(/^if you do,\s*([^-]+?\.)\s*/i, (_, sentence) => {
    postChoiceTexts.push(sentence.trim());
    return "";
  });
  branchText = branchText.replace(/^you cannot choose one of the abilities on <[^>]+> that you have already chosen this turn\.\s*/i, "");
  const branches = branchText
    .split(/\s+-\s+|\s*-\s*(?=choose\b|if\b|draw\b|place\b|play\b|switch\b|move\b|sideline\b|return\b)|\s*・\s*|\s*\?\s*/i)
    .map((branch) => branch.replace(/^-\s*/, "").trim())
    .filter(Boolean);

  if (branches.length === 0) return undefined;

  const insteadChoice = encodeInsteadChoice(prefix, branches, context);
  if (insteadChoice) return insteadChoice;

  const unsupported = [];
  const effects = [];
  let prefixCondition;
  const actionablePrefix = prefix
    .replace(/you can only use this card[^.]*\.\s*/i, "")
    .replace(/\s*if you do,?\s*$/i, "")
    .trim();
  const optionalPayApPrefix = actionablePrefix.match(/^you may pay (\d+) ap\.?$/i);
  const optionalPayApPrefixAmount = optionalPayApPrefix ? Number(optionalPayApPrefix[1]) : undefined;
  const prefixTarget = targetFromText(actionablePrefix.toLowerCase());
  if (prefix && !optionalPayApPrefix && !/^you may\.?$/i.test(actionablePrefix)) {
    prefixCondition = parseConditionOnly(actionablePrefix.toLowerCase());
    if (!prefixCondition) {
      const targetOnlyPrefix = prefixTarget && /^\s*choose\b/i.test(actionablePrefix) && !/\b(it|that character|the chosen character|sideline|return|switch|gains?|loses?|draw|place|play|add)\b/i.test(actionablePrefix.replace(/^choose[^.]+\.?\s*/i, ""));
      const prefixEffect = targetOnlyPrefix
        ? { effect: { kind: "none" }, unsupported: [] }
        : encodeEffectBody(actionablePrefix, { ...context, allowChoice: false });
      unsupported.push(...prefixEffect.unsupported);
      if (prefixEffect.effect.kind !== "none") effects.push(prefixEffect.effect);
    }
  }

  const choices = branches.map((branch, index) => {
    const encoded = encodeEffectBody(branch, { ...context, allowChoice: false, defaultTarget: prefixTarget ?? context.defaultTarget });
    unsupported.push(...encoded.unsupported);
    return {
      id: `choice-${index + 1}`,
      effect: encoded.effect
    };
  });
  const postChoiceEffects = postChoiceTexts
    .map((postChoiceText) => {
      const encoded = encodeEffectBody(postChoiceText, { ...context, allowChoice: false });
      unsupported.push(...encoded.unsupported);
      return encoded.effect;
    })
    .filter((effect) => effect.kind !== "none");

  if (chooseTwoAllMatch) {
    const chooseTwoCondition = parseConditionOnly(`if ${chooseTwoAllMatch[1].trim()}`);
    const chooseAllCondition = parseConditionOnly(`if ${chooseTwoAllMatch[2].trim()}`);
    effects.push({
      kind: "conditional",
      condition: chooseAllCondition,
      effect: {
        kind: "chooseN",
        choiceKey: "effectChoices",
        min: choices.length,
        max: choices.length,
        defaultCount: choices.length,
        choices
      },
      elseEffect: {
        kind: "conditional",
        condition: chooseTwoCondition,
        effect: {
          kind: "chooseN",
          choiceKey: "effectChoices",
          min: 1,
          max: 2,
          defaultCount: 2,
          choices
        },
        elseEffect: {
          kind: "chooseOne",
          choiceKey: "effectChoice",
          choices
        }
      }
    });
  } else if (chooseAllMatch) {
    const chooseAllCondition = parseConditionOnly(`if ${chooseAllMatch[1].trim()}`);
    effects.push({
      kind: "conditional",
      condition: chooseAllCondition,
      effect: {
        kind: "chooseN",
        choiceKey: "effectChoices",
        min: chooseAllMatch[2] ? 1 : choices.length,
        max: choices.length,
        defaultCount: choices.length,
        choices
      },
      elseEffect: {
        kind: "chooseOne",
        choiceKey: "effectChoice",
        choices
      }
    });
  } else if (chooseTwoCostMatch) {
    const chooseOneEffect = {
      kind: "chooseOne",
      choiceKey: "effectChoice",
      choices
    };
    effects.push({
      kind: "optionalChoiceUpgrade",
      choiceKey: "chooseTwoUpgrade",
      default: true,
      costEffect: {
        kind: "moveHandToZone",
        amount: 1,
        destination: "sideline",
        filter: { apCost: Number(chooseTwoCostMatch[1]) }
      },
      baseEffect: chooseOneEffect,
      upgradedEffect: {
        kind: "chooseN",
        choiceKey: "effectChoices",
        min: 1,
        max: 2,
        defaultCount: 2,
        choices
      },
      requiredMovedFromHand: 1
    });
  } else if (chooseNMatch) {
    effects.push({
      kind: "chooseN",
      choiceKey: "effectChoices",
      min: 1,
      max: 2,
      defaultCount: 1,
      choices
    });
  } else {
    effects.push({
      kind: "chooseOne",
      choiceKey: "effectChoice",
      choices
    });
  }

  effects.push(...postChoiceEffects);

  let effect = effects.length === 1 ? effects[0] : { kind: "sequence", effects };
  if (prefixCondition) {
    effect = {
      kind: "conditional",
      condition: prefixCondition,
      effect
    };
  }
  if (optionalPayApPrefixAmount !== undefined) {
    effect = {
      kind: "optional",
      choiceKey: "optionalPayAp",
      default: true,
      effect: {
        kind: "sequence",
        effects: [
          { kind: "payAp", amount: optionalPayApPrefixAmount },
          effect
        ]
      }
    };
    return {
      effect,
      unsupported
    };
  }
  return {
    effect: wrapOptionalIfNeeded(text.toLowerCase(), effect),
    unsupported
  };
}

function encodeRepeatedBpLoss(lower) {
  const match = lower.match(/choose up to one character on your opponent's front line\. it loses (\d+) bp until the end of the turn\. choose up to one character on your opponent's front line\. it loses (\d+) bp until the end of the turn\.?/);
  if (!match) return undefined;
  return {
    kind: "sequence",
    effects: [
      {
        kind: "modifyBp",
        amount: -Number(match[1]),
        duration: "turn",
        target: {
          type: CARD_TYPES.CHARACTER,
          max: 1,
          controller: "opponent",
          line: LINES.FRONT,
          choiceKey: "bpLossTarget1"
        }
      },
      {
        kind: "modifyBp",
        amount: -Number(match[2]),
        duration: "turn",
        target: {
          type: CARD_TYPES.CHARACTER,
          max: 1,
          controller: "opponent",
          line: LINES.FRONT,
          choiceKey: "bpLossTarget2"
        }
      }
    ]
  };
}

function conditionAtEndOfPrefix(prefixLower) {
  const match = prefixLower.match(/\bif\s+(.+?)\s*,?$/);
  if (!match) return undefined;
  return parseConditionOnly(`if ${match[1].trim()}`);
}

function encodeInsteadChoice(prefix, branches, context) {
  const prefixLower = prefix.toLowerCase();
  const target = targetFromText(prefixLower) ?? context.defaultTarget;
  const condition = conditionAtEndOfPrefix(prefixLower);
  if (!target || !condition) return undefined;

  const baseBpLoss = prefixLower.match(/\bloses?\s+\{?(\d+)\s+bp\}?/);
  if (baseBpLoss) {
    const unsupported = [];
    const baseEffect = {
      kind: "modifyBp",
      amount: -Number(baseBpLoss[1]),
      duration: prefixLower.includes("until the end of the turn") ? "turn" : "permanent",
      target
    };
    const choices = branches.map((branch, index) => {
      const lowerBranch = branch.toLowerCase();
      const instead = lowerBranch.match(/^\{?(\d+)\s+bp\}?\s+instead\.?$/);
      if (instead) {
        return {
          id: `choice-${index + 1}`,
          effect: {
            kind: "modifyBp",
            amount: -Number(instead[1]),
            duration: prefixLower.includes("until the end of the turn") ? "turn" : "permanent",
            target
          }
        };
      }
      const encoded = encodeEffectBody(branch, { ...context, allowChoice: false, defaultTarget: target });
      unsupported.push(...encoded.unsupported);
      return {
        id: `choice-${index + 1}`,
        effect: encoded.effect.kind === "none"
          ? baseEffect
          : { kind: "sequence", effects: [baseEffect, encoded.effect] }
      };
    });
    return {
      effect: {
        kind: "conditional",
        condition,
        effect: { kind: "chooseOne", choiceKey: "effectChoice", choices },
        elseEffect: baseEffect
      },
      unsupported
    };
  }

  if (prefixLower.includes("sideline it")) {
    const unsupported = [];
    const baseEffect = { kind: "sidelineTargets", target };
    const choices = branches.map((branch, index) => {
      const lowerBranch = branch.toLowerCase();
      const instead = lowerBranch.match(/^\{?(\d+)\s+or less bp\}?\s+instead\.?$/);
      if (instead) {
        return {
          id: `choice-${index + 1}`,
          effect: {
            kind: "sidelineTargets",
            target: { ...target, bpMax: Number(instead[1]) }
          }
        };
      }
      const encoded = encodeEffectBody(branch, { ...context, allowChoice: false, defaultTarget: target });
      unsupported.push(...encoded.unsupported);
      return {
        id: `choice-${index + 1}`,
        effect: encoded.effect.kind === "none"
          ? baseEffect
          : { kind: "sequence", effects: [baseEffect, encoded.effect] }
      };
    });
    return {
      effect: {
        kind: "conditional",
        condition,
        effect: { kind: "chooseOne", choiceKey: "effectChoice", choices },
        elseEffect: baseEffect
      },
      unsupported
    };
  }

  return undefined;
}

function encodeBpInstead(lower, target) {
  if (!target || !lower.includes(" instead")) return undefined;
  const match = lower.match(/\bloses?\s+\{?(\d+)\s+bp\}?[^.]*\.\s*if ([^.]+),\s*\{?(\d+)\s+bp\}?\s+instead/);
  if (!match) return undefined;
  const condition = parseConditionOnly(`if ${match[2].trim()}`);
  if (!condition) return undefined;
  return {
    kind: "conditional",
    condition,
    effect: {
      kind: "modifyBp",
      amount: -Number(match[3]),
      duration: lower.includes("until the end of the turn") ? "turn" : "permanent",
      target
    },
    elseEffect: {
      kind: "modifyBp",
      amount: -Number(match[1]),
      duration: lower.includes("until the end of the turn") ? "turn" : "permanent",
      target
    }
  };
}

function encodeDrawInstead(lower) {
  if (!lower.includes(" instead")) return undefined;
  const match = lower.match(/\bdraw\s+\{?(a|one|two|three|four|five|\d+)(?: card| cards)?\}?\s*\.?\s*if ([^.]+),\s*\{?(a|one|two|three|four|five|\d+)(?: card| cards)?\}?\s+instead/);
  if (!match) return undefined;
  const condition = parseConditionOnly(`if ${match[2].trim()}`);
  if (!condition) return undefined;
  return {
    kind: "conditional",
    condition,
    effect: { kind: "draw", amount: numberFromText(match[3], 1) },
    elseEffect: { kind: "draw", amount: numberFromText(match[1], 1) }
  };
}

function encodeReplacementOrUseRestriction(lower) {
  const useRestrictions = [];

  const onlyUseCondition = parseOnlyUseRestrictionCondition(lower);
  if (onlyUseCondition) useRestrictions.push({ kind: "condition", condition: onlyUseCondition });

  const simpleUnlessName = lower.match(/you cannot use this card unless <([^>]+)> is on your field/);
  if (simpleUnlessName) useRestrictions.push({ kind: "condition", condition: { namedOnField: simpleUnlessName[1] } });

  if (lower.includes("you cannot use this card unless you place one card from your life into your sideline")
    && lower.includes("switch one active <yuji itadori> card on your field to resting")) {
    useRestrictions.push({
      kind: "condition",
      condition: {
        anyOf: [
          { lifeMin: 1 },
          { activeNamedOnField: "yuji itadori" }
        ]
      },
      costAlternatives: [
        { kind: "lifeToSideline", amount: 1 },
        { kind: "restNamed", name: "yuji itadori", line: "field", amount: 1 }
      ]
    });
  }

  const restTwoNamed = lower.match(/you cannot use this card unless you switch one active <([^>]+)> card and one active <([^>]+)> card on your front line to resting/);
  if (restTwoNamed) {
    useRestrictions.push({
      kind: "condition",
      condition: {
        allOf: [
          { activeNamedOnFrontLine: restTwoNamed[1] },
          { activeNamedOnFrontLine: restTwoNamed[2] }
        ]
      },
      cost: {
        kind: "restNamedAll",
        line: LINES.FRONT,
        names: [restTwoNamed[1], restTwoNamed[2]]
      }
    });
  }

  const namedSideline = lower.match(/you cannot use this card if you have a <([^>]+)> card in your sideline/);
  if (namedSideline) useRestrictions.push({ kind: "namedNotInSideline", name: namedSideline[1] });
  if (lower.includes("you cannot use this card if your energy line is full")) {
    useRestrictions.push({ kind: "energyLineHasRoom" });
  }
  const selfSidelineReplacement = lower.includes("if this card would be placed into your sideline besides when using it from your hand")
    ? "removal"
    : undefined;
  if (useRestrictions.length === 0 && !selfSidelineReplacement) return undefined;
  return {
    kind: "replacementOrUseRestriction",
    useRestrictions,
    selfSidelineReplacement
  };
}

function parseOnlyUseRestrictionCondition(lower) {
  const match = lower.match(/you can only use this card if ([^.]+)\.?/);
  if (!match) return undefined;
  const text = match[1].trim();

  let conditionMatch = text.match(/^both <([^>]+)> and <([^>]+)> are on your field$/);
  if (conditionMatch) {
    return {
      allOf: [
        { namedOnField: conditionMatch[1] },
        { namedOnField: conditionMatch[2] }
      ]
    };
  }

  conditionMatch = text.match(/^<([^>]+)> is on your field$/);
  if (conditionMatch) return { namedOnField: conditionMatch[1] };

  conditionMatch = text.match(/^<([^>]+)> or a character with "([^"]+)" and "([^"]+)" in its card name is on your field$/);
  if (conditionMatch) {
    return {
      anyOf: [
        { namedOnField: conditionMatch[1] },
        { nameContainsAllOnField: [conditionMatch[2], conditionMatch[3]] }
      ]
    };
  }

  return parseCostCondition(`if ${text}`);
}

function encodeTargetingModifier(lower) {
  if (!lower.includes("choose a character on your opponent's front line instead of a character on your field for the next ability")) {
    return undefined;
  }
  const sourceName = lower.match(/on a <([^>]+)> card/)?.[1];
  return {
    kind: "targetingModifier",
    sourceName,
    timing: TIMINGS.ACTIVATE_MAIN,
    from: { controller: "self", line: "field", type: CARD_TYPES.CHARACTER },
    targetOverride: { controller: "opponent", line: LINES.FRONT, type: CARD_TYPES.CHARACTER, max: 1 },
    once: true,
    expires: "endOfTurn"
  };
}

function encodeChoiceModeModifier(lower) {
  if (!lower.includes("change") || !lower.includes("choose one of the following") || !lower.includes("choose all of the following")) {
    return undefined;
  }
  return {
    kind: "choiceModeModifier",
    mode: "chooseAll",
    color: lower.includes("purple") ? "purple" : undefined,
    once: lower.includes("next \"choose one of the following\""),
    expires: "endOfTurn"
  };
}

function encodeGrantedTimingAbility(originalLower, target) {
  const match = originalLower
    .replace(/\s+/g, " ")
    .match(/(?:it|that character|those characters|this character) gains?\s+"\s*\[(when played|when attacking|when blocking|when sidelined|activate: main|start of end phase)\]\s*([^"]+?)"\s+until (the end of the turn|the start of your next turn)/i);
  if (!match) return undefined;

  const timing = TIMING_MAP.get(match[1].toLowerCase());
  if (!timing) return undefined;

  const encoded = encodeEffectBody(match[2].replace(/\.$/, "").trim(), { allowChoice: false });
  if (!encoded.effect || encoded.effect.kind === "none" || encoded.effect.kind === "unsupported") return undefined;

  return {
    effect: {
      kind: "grantAbility",
      target: target ?? "self",
      duration: match[3].toLowerCase().includes("start of your next turn") ? "startOfNextTurn" : "turn",
      ability: {
        id: `granted-${timing}`,
        timing,
        oncePerTurn: false,
        effect: encoded.effect
      }
    },
    unsupported: encoded.unsupported
  };
}

function grantsLastPlayedReturnToHand(originalLower) {
  return /(?:that character|those characters) gains?\s+"\s*at the end of (?:the|your) attack phase,\s*return this character to your hand/.test(originalLower);
}

function encodeCopyOrGainAbilities(lower, target) {
  if (lower.includes("gains all abilities on the cards placed into the removal area by this ability")) {
    return {
      kind: "copyActivatedAbilitiesFromMovedCards",
      timing: TIMINGS.ACTIVATE_MAIN,
      target: "self",
      sourceDestination: "removal",
      expires: "endOfTurn"
    };
  }

  if (lower.includes("ability this turn, you can activate it without performing")) {
    return {
      kind: "waiveAbilityCostForTargets",
      timing: TIMINGS.ACTIVATE_MAIN,
      costKey: "ap",
      target: target ?? { controller: "self", line: "field", max: 1 }
    };
  }

  if (lower.includes("gains one") && lower.includes("ability that includes")) {
    return {
      kind: "copyActivatedAbility",
      timing: TIMINGS.ACTIVATE_MAIN,
      requiresCostKey: "ap",
      target: target ?? { controller: "self", line: "field", max: 1 }
    };
  }

  if (lower.includes("can perform raid on this character")) {
    return {
      kind: "grantKeyword",
      keyword: "raidTargetForAnyRaid",
      duration: "turn",
      target: target ?? "self"
    };
  }

  const tiered = encodeTieredAbilityGrants(lower, target);
  if (tiered) return tiered;
  return undefined;
}

function encodeTieredAbilityGrants(lower, target) {
  const grantTarget = target ?? "self";
  if (!lower.includes("gains all abilities listed below")) return undefined;

  if (lower.includes("required number of <sukuna's finger> cards in your sideline")) {
    return {
      kind: "applyTieredAbilityGrants",
      tiers: [
        {
          condition: { zone: "sideline", zoneCountMin: 2, filter: { name: "sukuna's finger" } },
          effects: [{ kind: "grantKeyword", keyword: "damage", value: 2, duration: "turn", target: grantTarget }]
        },
        {
          condition: { zone: "sideline", zoneCountMin: 3, filter: { name: "sukuna's finger" } },
          effects: [{ kind: "grantKeyword", keyword: "snipe", duration: "turn", target: grantTarget }]
        },
        {
          condition: { zone: "sideline", zoneCountMin: 4, filter: { name: "sukuna's finger" } },
          effects: [{ kind: "grantKeyword", keyword: "impactPlus", value: 1, duration: "turn", target: grantTarget }]
        }
      ]
    };
  }

  if (lower.includes("required number of event cards in your sideline")) {
    return {
      kind: "applyTieredAbilityGrants",
      tiers: [
        {
          condition: { zone: "sideline", zoneCountMin: 2, filter: { type: CARD_TYPES.EVENT } },
          effects: [{ kind: "grantKeyword", keyword: "cantBeBlockedByBpMax", value: 3000, duration: "turn", target: grantTarget }]
        },
        {
          condition: { zone: "sideline", zoneCountMin: 4, filter: { type: CARD_TYPES.EVENT } },
          effects: [{ kind: "grantKeyword", keyword: "mustBlock", duration: "turn", target: grantTarget }]
        }
      ]
    };
  }

  if (lower.includes("if you have no cards with affinities on your field")) {
    return {
      kind: "conditional",
      condition: { noAffinitiesOnField: true },
      effect: {
        kind: "sequence",
        effects: [
          { kind: "modifyBp", amount: 1000, duration: "turn", target: grantTarget },
          { kind: "grantKeyword", keyword: "canAttackFromEnergyLine", duration: "turn", target: grantTarget },
          { kind: "grantKeyword", keyword: "moveToFrontOnEnergyAttack", duration: "turn", target: grantTarget }
        ]
      }
    };
  }

  if (lower.includes("required number of characters with 4000 or more bp on their front line")) {
    return {
      kind: "applyTieredAbilityGrants",
      tiers: [
        {
          condition: { fieldController: "opponent", fieldCountMin: 2, filter: { type: CARD_TYPES.CHARACTER, bpMin: 4000 } },
          effects: [{ kind: "modifyBp", amount: 1000, duration: "turn", target: grantTarget }]
        },
        {
          condition: { fieldController: "opponent", fieldCountMin: 4, filter: { type: CARD_TYPES.CHARACTER, bpMin: 4000 } },
          effects: [{ kind: "grantKeyword", keyword: "impact", value: 1, duration: "turn", target: grantTarget }]
        }
      ]
    };
  }

  if (lower.includes("required number of face-down cards under this character")) {
    return {
      kind: "applyTieredAbilityGrants",
      tiers: [
        {
          condition: { selfUnderCardsMin: 1 },
          effects: [{ kind: "grantKeyword", keyword: "playSelfWhenSidelined", duration: "permanent", target: grantTarget }]
        },
        {
          condition: { selfUnderCardsMin: 2 },
          effects: [
            { kind: "grantKeyword", keyword: "damage", value: 2, duration: "permanent", target: grantTarget },
            { kind: "grantKeyword", keyword: "doubleBlock", duration: "permanent", target: grantTarget }
          ]
        },
        {
          condition: { selfUnderCardsMin: 3 },
          effects: [
            { kind: "modifyBp", amount: 500, duration: "permanent", target: grantTarget },
            { kind: "grantKeyword", keyword: "doubleAttack", duration: "permanent", target: grantTarget }
          ]
        }
      ]
    };
  }

  if (lower.includes("required number of cards into your sideline with this ability")) {
    return {
      kind: "applyTieredAbilityGrants",
      tiers: [
        {
          condition: { lastMovedFromHandMin: 1 },
          effects: [{ kind: "grantKeyword", keyword: "drawOnAttack", value: 1, duration: "turn", target: grantTarget }]
        },
        {
          condition: { lastMovedFromHandMin: 2 },
          effects: [{ kind: "modifyBp", amount: 1000, duration: "turn", target: grantTarget }]
        },
        {
          condition: { lastMovedFromHandMin: 3 },
          effects: [{ kind: "grantKeyword", keyword: "doubleAttack", duration: "turn", target: grantTarget }]
        }
      ]
    };
  }

  if (lower.includes("combined total required energy of the cards you switched to resting with this ability")) {
    return {
      kind: "sequence",
      effects: [
        { kind: "restEnergyLineForRequiredEnergyTotal" },
        {
          kind: "applyTieredAbilityGrants",
          tiers: [
            {
              condition: { lastRestedRequiredEnergyMin: 4 },
              effects: [{ kind: "modifyBp", amount: 3000, duration: "turn", target: grantTarget }]
            },
            {
              condition: { lastRestedRequiredEnergyMin: 8 },
              effects: [{ kind: "grantKeyword", keyword: "damage", value: 2, duration: "turn", target: grantTarget }]
            }
          ]
        }
      ]
    };
  }

  return undefined;
}

function parseLeadingCondition(lower) {
  if (!lower.startsWith("if ")) return undefined;
  const playedByAbility = lower.match(/^(if this character is played with one of your character, event card, or trigger abilities),\s*(.+)$/);
  if (playedByAbility) {
    return {
      condition: { playedByAbility: true },
      body: playedByAbility[2].trim()
    };
  }
  const commaIndex = lower.indexOf(",");
  if (commaIndex === -1) return undefined;
  const conditionText = lower.slice(0, commaIndex + 1);
  const condition = parseConditionOnly(conditionText);
  if (!condition) return undefined;
  return {
    condition,
    body: lower.slice(commaIndex + 1).trim()
  };
}

function parseConditionOnly(lower) {
  const text = lower
    .replace(/,$/, "")
    .replace(/\.$/, "")
    .trim();

  if (/^if this (?:character|site|card) is active$/.test(text)) return { active: true };
  if (/^if this (?:character|site|card) has a face-down card under it$/.test(text)) return { hasFaceDownUnder: true };
  if (/^if there is a face-down card under this (?:character|site|card)$/.test(text)) return { hasFaceDownUnder: true };
  if (/^if there is a face-up card on the top of your deck$/.test(text)) return { topDeckFaceUp: true };
  if (text === "if one of your or your opponent's [trigger] abilities has been activated this turn") {
    return { anyTriggerAbilityActivatedThisTurn: true };
  }

  let match = text.match(/^if you have (one|two|three|four|five|six|seven|\d+) or more \[([^\]]+)\] affinity cards? or (one|two|three|four|five|six|seven|\d+) or more event cards? in your sideline$/);
  if (!match) {
    match = text.match(/^if this (?:character|site|card) has (one|two|three|four|five|six|seven|\d+) or more face-down cards? under it$/);
    if (match) return { selfUnderFaceDownCardsMin: numberFromText(match[1], 0) };
  }
  if (match) {
    return {
      anyOf: [
        {
          zone: "sideline",
          zoneCountMin: numberFromText(match[1], 0),
          filter: { affinity: match[2] }
        },
        {
          zone: "sideline",
          zoneCountMin: numberFromText(match[3], 0),
          filter: { type: CARD_TYPES.EVENT }
        }
      ]
    };
  }

  match = text.match(/^if you have a (red|blue|green|yellow|purple) card on your field and (one|two|three|four|five|six|seven|\d+) or less remaining cards? in your hand$/);
  if (match) {
    return {
      allOf: [
        { fieldCountMin: 1, filter: { color: match[1] } },
        { handSizeMax: numberFromText(match[2], 0) }
      ]
    };
  }

  match = text.match(/^if you have a (red|blue|green|yellow|purple) card on your field$/);
  if (match) return { fieldCountMin: 1, filter: { color: match[1] } };

  match = text.match(/^if you have (one|two|three|four|five|six|seven|\d+) or less remaining cards? in your hand$/);
  if (match) return { handSizeMax: numberFromText(match[1], 0) };

  match = text.match(/^if (one|two|three|four|five|six|seven|\d+) or more other \[([^\]]+)\] affinity cards? are on your field$/);
  if (match) {
    return {
      fieldCountMin: numberFromText(match[1], 0),
      otherThanSource: true,
      filter: { affinity: match[2] }
    };
  }

  match = text.match(/^if (one|two|three|four|five|six|seven|\d+) or more copies of <([^>]+)> are in your sideline$/);
  if (match) {
    return {
      zone: "sideline",
      zoneCountMin: numberFromText(match[1], 0),
      filter: { name: match[2] }
    };
  }

  match = text.match(/^if the combined total of your life and your opponent's life is (one|two|three|four|five|six|seven|\d+) or less$/);
  if (match) return { combinedLifeMax: numberFromText(match[1], 0) };

  match = text.match(/^if you have the same number or more characters on your front line than your opponent$/);
  if (match) return { frontLineCountAtLeastOpponent: true, filter: { type: CARD_TYPES.CHARACTER } };

  match = text.match(/^if <([^>]+)> and <([^>]+)> are on your field$/);
  if (match) return { allOf: [{ namedOnField: match[1] }, { namedOnField: match[2] }] };

  match = text.match(/^if <([^>]+)> and <([^>]+)> are on your front line$/);
  if (match) return { allOf: [{ namedOnFrontLine: match[1] }, { namedOnFrontLine: match[2] }] };

  match = text.match(/^if <([^>]+)> or <([^>]+)> is on your field$/);
  if (match) return { anyOf: [{ namedOnField: match[1] }, { namedOnField: match[2] }] };

  match = text.match(/^if <([^>]+)> or <([^>]+)> is on your front line$/);
  if (match) return { anyOf: [{ namedOnFrontLine: match[1] }, { namedOnFrontLine: match[2] }] };

  match = text.match(/^if neither <([^>]+)> nor <([^>]+)> are on your front line$/);
  if (match) {
    return {
      frontLineCountMax: 0,
      filter: { names: [match[1], match[2]] }
    };
  }

  match = text.match(/^if <([^>]+)> is on the same line$/);
  if (match) {
    return {
      sameLineCountMin: 1,
      otherThanSource: true,
      filter: { name: match[1] }
    };
  }

  match = text.match(/^if <([^>]+)> is on the same line or <([^>]+)> is on your field or in your sideline$/);
  if (match) {
    return {
      anyOf: [
        {
          sameLineCountMin: 1,
          otherThanSource: true,
          filter: { name: match[1] }
        },
        { namedOnField: match[2] },
        { zone: "sideline", zoneCountMin: 1, filter: { name: match[2] } }
      ]
    };
  }

  match = text.match(/^if another character with (\d+) required energy is on the same line$/);
  if (match) {
    return {
      sameLineCountMin: 1,
      otherThanSource: true,
      filter: { type: CARD_TYPES.CHARACTER, requiredEnergyMax: Number(match[1]), requiredEnergyMin: Number(match[1]) }
    };
  }

  if (text === "if your opponent's front line is not full") {
    return { opponentFrontLineNotFull: true };
  }

  match = text.match(/^if there (?:are|is) a combined total of (one|two|three|four|five|six|seven|\d+) or more face-up cards? in your and your opponent's decks and life areas$/);
  if (match) return { faceUpDeckOrLifeCountMin: numberFromText(match[1], 0) };

  if (text === "if you have no cards with [trigger] abilities on your field") {
    return {
      fieldCountMax: 0,
      filter: { withTrigger: true }
    };
  }

  match = text.match(/^if you have another \[([^\]]+)\] affinity card with (\d+) or more bp on your front line$/);
  if (match) {
    return {
      frontLineCountMin: 1,
      otherThanSource: true,
      filter: { affinity: match[1], bpMin: Number(match[2]) }
    };
  }

  match = text.match(/^if you have (one|two|three|four|five|six|seven|\d+) or more cards? in your hand$/);
  if (match) return { handSizeMin: numberFromText(match[1], 0) };

  match = text.match(/^if you have a combined total of (one|two|three|four|five|six|seven|\d+) or more cards? in your sideline and your removal area$/);
  if (match) return { combinedZoneCountMin: numberFromText(match[1], 0), zones: ["sideline", "removal"] };

  match = text.match(/^if you have a combined total of (one|two|three|four|five|six|seven|\d+) or more \[([^\]]+)\] affinity cards and face-down cards under characters on your field$/);
  if (match) {
    return {
      combinedFieldAndUnderFaceDownCountMin: numberFromText(match[1], 0),
      filter: { affinity: match[2] }
    };
  }

  match = text.match(/^if you have (one|two|three|four|five|six|seven|\d+) or more \[([^\]]+)\] affinity cards? with unique card names on your field$/);
  if (match) {
    return {
      uniqueFieldNameCountMin: numberFromText(match[1], 0),
      filter: { affinity: match[2] }
    };
  }

  match = text.match(/^if (?:there is )?a character (?:is )?on your opponent's front line$/);
  if (match) {
    return {
      fieldController: "opponent",
      frontLineCountMin: 1,
      filter: { type: CARD_TYPES.CHARACTER }
    };
  }

  match = text.match(/^if a character with "([^"]+)" in its card name is on your field$/);
  if (match) return { nameContainsOnField: match[1] };

  match = text.match(/^if a raided <([^>]+)> or <([^>]+)> is on your field$/);
  if (match) {
    return {
      fieldCountMin: 1,
      filter: { names: [match[1], match[2]] }
    };
  }

  const orParts = text.split(/\s+or\s+/);
  if (orParts.length > 1) {
    const anyOf = orParts
      .map((part, index) => parseConditionOnly(index === 0 && part.startsWith("if ") ? part : `if ${part}`))
      .filter(Boolean);
    if (anyOf.length === orParts.length) return { anyOf };
  }

  match = text.match(/^if <([^>]+)> is on your field$/);
  if (match) return { namedOnField: match[1] };

  match = text.match(/^if <([^>]+)> is on your front line$/);
  if (match) return { namedOnFrontLine: match[1] };

  match = text.match(/^if there is a character with "([^"]+)" in its card name on your field$/);
  if (match) return { nameContainsOnField: match[1] };

  match = text.match(/^if there is a character with (\d+) or more bp on your opponent's front line$/);
  if (match) {
    return {
      fieldController: "opponent",
      frontLineCountMin: 1,
      filter: { type: CARD_TYPES.CHARACTER, bpMin: Number(match[1]) }
    };
  }

  match = text.match(/^if there are (one|two|three|four|five|six|seven|\d+) or more characters? with (\d+) or more bp on your opponent's field$/);
  if (match) {
    return {
      fieldController: "opponent",
      fieldCountMin: numberFromText(match[1], 0),
      filter: { type: CARD_TYPES.CHARACTER, bpMin: Number(match[2]) }
    };
  }

  match = text.match(/^if there are no other characters on your front line$/);
  if (match) {
    return {
      frontLineCountMax: 0,
      otherThanSource: true,
      filter: { type: CARD_TYPES.CHARACTER }
    };
  }

  match = text.match(/^if there are (one|two|three|four|five|six|seven|\d+) or more other characters on your field with (\d+) or less required energy$/);
  if (match) {
    return {
      fieldCountMin: numberFromText(match[1], 0),
      otherThanSource: true,
      filter: {
        type: CARD_TYPES.CHARACTER,
        requiredEnergyMax: Number(match[2])
      }
    };
  }

  match = text.match(/^if you have a combined total of (one|two|three|four|five|six|seven|\d+) or more ((?:<[^>]+>,?\s*)+)or other \[([^\]]+)\] affinity cards? on your field$/);
  if (match) {
    const names = [...match[2].matchAll(/<([^>]+)>/g)].map((nameMatch) => ({ name: nameMatch[1] }));
    return {
      fieldCountMin: numberFromText(match[1], 0),
      filter: { anyOf: [...names, { affinity: match[3] }] }
    };
  }

  match = text.match(/^if you have a combined total of (one|two|three|four|five|six|seven|\d+) or more <([^>]+)> or other \[([^\]]+)\] affinity cards? on your field$/);
  if (match) {
    return {
      fieldCountMin: numberFromText(match[1], 0),
      filter: {
        anyOf: [
          { name: match[2] },
          { affinity: match[3], otherThanName: match[2] }
        ]
      }
    };
  }

  match = text.match(/^if you have a combined total of (one|two|three|four|five|six|seven|\d+) or more other \[([^\]]+)\] affinity cards? on your field$/);
  if (match) {
    return {
      fieldCountMin: numberFromText(match[1], 0),
      otherThanSource: true,
      filter: { affinity: match[2] }
    };
  }

  match = text.match(/^if you have (?:a|an|one) <([^>]+)> cards? in your sideline$/);
  if (match) {
    return {
      zone: "sideline",
      zoneCountMin: 1,
      filter: { name: match[1] }
    };
  }

  match = text.match(/^if you have (one|two|three|four|five|six|seven|\d+) cards? on your energy line$/);
  if (match) return { energyLineCountMin: numberFromText(match[1], 0) };

  match = text.match(/^if you have (one|two|three|four|five|six|seven|\d+) <([^>]+)> cards? in your sideline$/);
  if (match) {
    return {
      zone: "sideline",
      zoneCountMin: numberFromText(match[1], 0),
      filter: { name: match[2] }
    };
  }

  match = text.match(/^if you have (one|two|three|four|five|six|seven|\d+) or more <([^>]+)> cards? in your sideline$/);
  if (match) {
    return {
      zone: "sideline",
      zoneCountMin: numberFromText(match[1], 0),
      filter: { name: match[2] }
    };
  }

  match = text.match(/^if you have (one|two|three|four|five|six|seven|\d+) <([^>]+)> cards? in your sideline$/);
  if (match) {
    return {
      zone: "sideline",
      zoneCountMin: numberFromText(match[1], 0),
      filter: { name: match[2] }
    };
  }

  match = text.match(/^if you have (one|two|three|four|five|six|seven|\d+) or more character cards? with (\d+) or more bp or (one|two|three|four|five|six|seven|\d+) or more event cards? in your sideline$/);
  if (match) {
    return {
      anyOf: [
        {
          zone: "sideline",
          zoneCountMin: numberFromText(match[1], 0),
          filter: { type: CARD_TYPES.CHARACTER, bpMin: Number(match[2]) }
        },
        {
          zone: "sideline",
          zoneCountMin: numberFromText(match[3], 0),
          filter: { type: CARD_TYPES.EVENT }
        }
      ]
    };
  }

  match = text.match(/^if you have (one|two|three|four|five|six|seven|\d+) or more energy generation$/);
  if (match) return { energyGenerationMin: numberFromText(match[1], 0) };

  match = text.match(/^if there is a character on your opponent's front line or one of their characters has been sidelined this turn$/);
  if (match) {
    return {
      anyOf: [
        { fieldController: "opponent", frontLineCountMin: 1, filter: { type: CARD_TYPES.CHARACTER } },
        { characterSidelinedThisTurn: "opponent" }
      ]
    };
  }

  match = text.match(/^if (?:a character on your field|one of your characters) has been sidelined this turn$/);
  if (match) return { characterSidelinedThisTurn: "self" };

  match = text.match(/^if (?:a character on your opponent's field|one of your opponent's characters|one of their characters) has been sidelined this turn$/);
  if (match) return { characterSidelinedThisTurn: "opponent" };

  match = text.match(/^if you have (?:used|played) an? event card this turn$/);
  if (match) return { eventUsedThisTurn: "self" };

  match = text.match(/^if a character with a \[(get|draw|active|color|special|final|raid) trigger\] ability has been played onto your field this turn$/);
  if (match) return { playedCharacterWithTriggerTypeThisTurn: match[1] };

  match = text.match(/^if you have (one|two|three|four|five|six|seven|\d+) or less life$/);
  if (match) return { lifeMax: numberFromText(match[1], 0) };

  match = text.match(/^if you have (one|two|three|four|five|six|seven|\d+) or more event cards? in your sideline$/);
  if (match) return { zone: "sideline", zoneCountMin: numberFromText(match[1], 0), filter: { type: CARD_TYPES.EVENT } };

  match = text.match(/^if you have (one|two|three|four|five|six|seven|\d+) or more \[([^\]]+)\] affinity cards? in your sideline$/);
  if (match) return { zone: "sideline", zoneCountMin: numberFromText(match[1], 0), filter: { affinity: match[2] } };

  match = text.match(/^if you have (one|two|three|four|five|six|seven|\d+) or more character cards? with (\d+) or more bp in your sideline$/);
  if (match) {
    return {
      zone: "sideline",
      zoneCountMin: numberFromText(match[1], 0),
      filter: { type: CARD_TYPES.CHARACTER, bpMin: Number(match[2]) }
    };
  }

  match = text.match(/^if you have (one|two|three|four|five|six|seven|\d+) or more cards? in your sideline$/);
  if (match) return { sidelineCountMin: numberFromText(match[1], 0) };

  match = text.match(/^if you have (one|two|three|four|five|six|seven|\d+) or less cards? in your hand$/);
  if (match) return { handSizeMax: numberFromText(match[1], 0) };

  match = text.match(/^if you have (one|two|three|four|five|six|seven|\d+) or less cards? in your deck$/);
  if (match) return { deckCountMax: numberFromText(match[1], 0) };

  if (text === "if you have no cards in your hand" || text === "if you have no cards in hand") {
    return { noCardsInHand: true };
  }

  if (text === "if you have less cards in your hand than your opponent") {
    return { lessCardsInHandThanOpponent: true };
  }

  match = text.match(/^if your opponent has (one|two|three|four|five|six|seven|\d+) or more life$/);
  if (match) return { opponentLifeMin: numberFromText(match[1], 0) };

  match = text.match(/^if your opponent has (one|two|three|four|five|six|seven|\d+) or less life$/);
  if (match) return { opponentLifeMax: numberFromText(match[1], 0) };

  match = text.match(/^if this character has (\d+) or more bp$/);
  if (match) return { selfBpMin: Number(match[1]) };

  if (text === "if this character has moved this turn") {
    return { selfMovedThisTurn: true };
  }

  if (text === "if this character was played this turn" || text === "if this character is played this turn") {
    return { playedThisTurn: true };
  }

  if (text === "if this character is played with one of your character, event card, or trigger abilities") {
    return { playedByAbility: true };
  }

  if (text === "if this character has activated an [activate: main] ability that includes [pay 1 ap] this turn") {
    return { apPaidAbilityUsedThisTurn: true };
  }

  if (text === "if you have performed an extra draw this turn") {
    return { extraDrawUsedThisTurn: true };
  }

  match = text.match(/^if you have used a \[([^\]]+)\] affinity card(?: from your hand)? this turn$/);
  if (match) return { usedFromHandThisTurn: { affinity: match[1] } };

  match = text.match(/^if you have placed a card from your hand into your sideline with an ability on one of your (.+?) cards this turn$/);
  if (match) {
    return {
      handToSidelineSourceThisTurn: parseHandToSidelineSourceFilter(match[1]) ?? {}
    };
  }

  if (text === "if a card from your hand has been placed into your sideline by one of your abilities or a card from your sideline has been added to your hand by one of your abilities this turn") {
    return {
      anyOf: [
        { handToSidelineByAbilityThisTurn: true },
        { sidelineToHandByAbilityThisTurn: true }
      ]
    };
  }

  if (text === "if a card from your hand or your deck has been placed into your sideline by one of your abilities this turn") {
    return {
      anyOf: [
        { handToSidelineByAbilityThisTurn: true },
        { deckToSidelineByAbilityThisTurn: true }
      ]
    };
  }

  if (text === "if you have placed a card from your hand into your sideline with an ability this turn") {
    return { handToSidelineByAbilityThisTurn: true };
  }

  if (/^if (?:you have placed a card from your hand into your sideline|a character has been sidelined this turn|this character has been chosen by an ability|this character has been sidelined by one of your abilities|this character was not played with one of your abilities)/.test(text)) {
    return { history: "notTracked" };
  }

  if (/^if (?:one|two|three|four|five|six|seven|\d+) or more characters have been sidelined this turn$/.test(text)) {
    return { history: "notTracked" };
  }

  match = text.match(/^if you have (one|two|three|four|five|six|seven|\d+) or more other \[([^\]]+)\] affinity cards? on your field$/);
  if (match) {
    return {
      fieldCountMin: numberFromText(match[1], 0),
      otherThanSource: true,
      filter: { affinity: match[2] }
    };
  }

  match = text.match(/^if you have (one|two|three|four|five|six|seven|\d+) or more \[([^\]]+)\] affinity cards? on your field$/);
  if (match) {
    return {
      fieldCountMin: numberFromText(match[1], 0),
      filter: { affinity: match[2] }
    };
  }

  if (/^if (?:it|this character) has been sidelined by an ability on one of your <[^>]+> cards$/.test(text)) {
    return { history: "notTracked" };
  }

  match = text.match(/^if all the cards on your field have \[([^\]]+)\] affinity$/);
  if (match) return { allFieldHaveAffinity: match[1] };

  return undefined;
}

function encodeCombinedRequiredEnergyAndApReduction(lower) {
  const normalized = lower.replace(/ÃƒÂ—|Ã—|×/g, "x");
  const match = normalized.match(/reduce the required energy and ap cost of the next (.+?) you use from your (hand or sideline|hand|sideline) this turn by\s*\[(red|blue|green|yellow|purple)\s*x\s*(\d+)\]\s*and\s*(\d+)/);
  if (!match) return undefined;

  const subject = match[1].trim();
  const filter = {};
  if (subject.includes("event card")) filter.type = CARD_TYPES.EVENT;
  if (subject.includes("character card")) filter.type = CARD_TYPES.CHARACTER;

  const names = [...subject.matchAll(/<([^>]+)>/g)].map((nameMatch) => nameMatch[1]);
  const nameContains = [...subject.matchAll(/"([^"]+)"/g)].map((nameMatch) => nameMatch[1]);
  if (names.length > 0 && nameContains.length >= 2) {
    filter.anyOf = [
      ...names.map((name) => ({ name })),
      { type: CARD_TYPES.CHARACTER, nameIncludesAll: nameContains }
    ];
  } else if (names.length === 1) {
    filter.name = names[0];
  }

  return {
    kind: "sequence",
    effects: [
      {
        kind: "reduceRequiredEnergy",
        amount: Number(match[4]),
        sourceZones: zoneListFromText(match[2]),
        expires: "endOfTurn",
        consumeOnUse: true,
        filter
      },
      {
        kind: "reduceNextUseApCost",
        amount: Number(match[5]),
        sourceZones: zoneListFromText(match[2]),
        expires: "endOfTurn",
        filter
      }
    ]
  };
}

function encodeNamedRequiredEnergyUntilNextUse(lower) {
  const normalized = lower.replace(/ÃƒÂ—|Ã—|×/g, "x");
  const match = normalized.match(/reduce the required energy of all <([^>]+)> cards in your hand by\s*\[(red|blue|green|yellow|purple)\s*x\s*(\d+)\]\s*this turn until the next <[^>]+> is played/);
  if (!match) return undefined;
  return {
    kind: "reduceRequiredEnergy",
    amount: Number(match[3]),
    sourceZone: "hand",
    expires: "endOfTurn",
    consumeOnUse: true,
    filter: { name: match[1] }
  };
}

function encodeApCostReduction(lower) {
  const generic = lower.match(/reduce the ap cost of the next (.+?) you use from your (hand or sideline|hand|sideline) this turn(?: other than <([^>]+)>)? by\s+(\d+)/);
  if (!generic) return undefined;

  const subject = generic[1].trim();
  const filter = {};
  if (subject.includes("event card")) filter.type = CARD_TYPES.EVENT;
  if (subject.includes("character card")) filter.type = CARD_TYPES.CHARACTER;

  const name = subject.match(/<([^>]+)>/);
  if (name) filter.name = name[1];
  if (generic[3]) filter.otherThanName = generic[3];
  const affinity = subject.match(/\[([^\]]+)\] affinity/);
  if (affinity) filter.affinity = affinity[1];
  const requiredEnergyMax = subject.match(/(\d+)\s+or less required energy/);
  if (requiredEnergyMax) filter.requiredEnergyMax = Number(requiredEnergyMax[1]);
  const baseBp = subject.match(/(\d+)\s+base bp/);
  if (baseBp) filter.baseBp = Number(baseBp[1]);

  return {
    kind: "reduceNextUseApCost",
    amount: Number(generic[4]),
    sourceZones: zoneListFromText(generic[2]),
    expires: "endOfTurn",
    filter
  };
}

function encodeSearchTopDeck(lower, context) {
  const lookMatch = lower.match(/look at the top(?:\s+\{?(\w+|\d+)(?: cards?)?\}?)?\s*(?:cards?)?\s+of your deck/);
  if (!lookMatch || !(lower.includes("add it to your hand")
    || lower.includes("add them to your hand")
    || lower.includes("add up to one")
    || lower.includes("add one"))) return undefined;
  if (/add (?:one|up to one) card among them to your hand and place (?:one|up to one) card among them into your sideline/.test(lower)) {
    return undefined;
  }

  if (lower.includes("up to one character card")
    && lower.includes("up to one event card")
    && lower.includes("up to one site card")) {
    const namedCondition = lower.match(/if <([^>]+)> is on your field,\s+\{?(\w+|\d+)(?: cards?)?\}?\s+instead/);
    return {
      kind: "searchTopDeck",
      count: numberFromText(lookMatch[1] ?? "one", 1),
      countIf: namedCondition ? {
        condition: { namedOnField: namedCondition[1] },
        count: numberFromText(namedCondition[2], 1)
      } : undefined,
      max: 3,
      destination: "hand",
      remainingDestination: lower.includes("remaining cards into your sideline") ? "sideline" : undefined,
      filter: {
        anyOf: [
          { type: CARD_TYPES.CHARACTER },
          { type: CARD_TYPES.EVENT },
          { type: CARD_TYPES.SITE }
        ]
      }
    };
  }

  const filter = {};
  if (lower.includes("character card")) filter.type = CARD_TYPES.CHARACTER;
  if (lower.includes("other than <") && context.cardName) filter.otherThanName = context.cardName;
  const names = [...lower.matchAll(/<([^>]+)>/g)].map((match) => match[1]);
  const affinities = [...lower.matchAll(/\[([^\]]+)\] affinity/g)].map((match) => match[1]);
  if (names.length > 0 && affinities.length > 0) {
    filter.anyOf = [
      ...names.map((name) => ({ name })),
      ...affinities.map((affinity) => ({ affinity }))
    ];
  } else if (names.length === 1) {
    filter.name = names[0];
  } else if (names.length > 1) {
    filter.names = names;
  } else if (affinities.length === 1) {
    filter.affinity = affinities[0];
  } else if (affinities.length > 1) {
    filter.anyOf = affinities.map((affinity) => ({ affinity }));
  }
  const requiredEnergyMin = lower.match(/(\d+)\s+or more required energy/);
  if (requiredEnergyMin) filter.requiredEnergyMin = Number(requiredEnergyMin[1]);
  const requiredEnergyMax = lower.match(/(\d+)\s+or less required energy/);
  if (requiredEnergyMax) filter.requiredEnergyMax = Number(requiredEnergyMax[1]);
  const maxMatch = lower.match(/up to\s+(one|two|three|four|\d+)/);
  const topOrSidelineRemainder = lower.includes("top of your deck or into your sideline");
  const remainingTop = lower.includes("remaining cards on the top of your deck")
    || lower.includes("remaining card on the top of your deck");
  if (lower.includes("if you added a card to your hand, place one card from your hand on the top of your deck or into your sideline")) {
    return {
      kind: "sequence",
      effects: [
        {
          kind: "searchTopDeck",
          count: numberFromText(lookMatch[1] ?? "one", 1),
          max: maxMatch ? numberFromText(maxMatch[1], 1) : 1,
          destination: "hand",
          remainingDestination: "top",
          filter
        },
        {
          kind: "conditional",
          condition: { lastSearchSelectedMin: 1 },
          effect: {
            kind: "moveHandToZone",
            amount: 1,
            destinations: ["deck", "sideline"],
            destination: "deck",
            position: "top"
          }
        }
      ]
    };
  }

  return {
    kind: "searchTopDeck",
    count: numberFromText(lookMatch[1] ?? "one", 1),
    max: maxMatch ? numberFromText(maxMatch[1], 1) : 1,
    destination: "hand",
    remainingDestinations: topOrSidelineRemainder ? ["top", "sideline"] : undefined,
    defaultRemainingDestination: topOrSidelineRemainder ? "top" : undefined,
    remainingDestination: topOrSidelineRemainder
      ? undefined
      : remainingTop ? "top"
      : lower.includes("remaining cards into your sideline")
      || lower.includes("remaining card into your sideline")
      ? "sideline"
      : undefined,
    filter
  };
}

function encodeLookTopDeckAndMove(lower) {
  const lookMatch = lower.match(/look at the top(?:\s+\{?(\w+|\d+)(?: cards?)?\}?)?\s*(?:cards?)?\s+of your deck/);
  if (!lookMatch) return undefined;
  const count = numberFromText(lookMatch[1] ?? "one", 1);

  if (/look at the top card of your deck,\s*then place it on the top or bottom of your deck\. if you place it on top,\s*turn it face up/.test(lower)) {
    return {
      kind: "lookTopDeckAndMove",
      count: 1,
      destinations: ["top", "bottom"],
      defaultDestination: "top",
      faceUpOnTop: true
    };
  }

  const playAmongThem = lower.match(/play up to one (?<subject>.+?) among them set to (?<state>active|resting) onto your (?<line>front line|field)(?:, or perform raid with it)?\. place the remaining cards on the (?<rest>top|bottom) of your deck/);
  const playLookedThenRest = playAmongThem
    ?? lower.match(/play up to one (?<subject>.+?) set to (?<state>active|resting) onto your (?<line>front line|field), or perform raid with it\. place the remaining cards on the (?<rest>top|bottom) of your deck/)
    ?? lower.match(/play up to one (?<subject>.+?) set to (?<state>active|resting) onto your (?<line>front line|field)\. place the remaining cards on the (?<rest>top|bottom) of your deck/);
  if (playLookedThenRest) {
    const subject = playLookedThenRest.groups.subject;
    let filter = {};
    if (subject.includes("character card") || subject.includes("character")) filter.type = CARD_TYPES.CHARACTER;
    if (subject.includes("event card")) filter.type = CARD_TYPES.EVENT;
    if (subject.includes("site card")) filter.type = CARD_TYPES.SITE;
    const color = subject.match(/\b(red|blue|green|yellow|purple)\b/);
    if (color) filter.color = color[1];
    const names = [...subject.matchAll(/<([^>]+)>/g)].map((match) => match[1]);
    const affinity = subject.match(/\[([^\]]+)\] affinity/);
    if (affinity) filter.affinity = affinity[1];
    const requiredEnergyMax = subject.match(/(\d+) or less required energy/);
    if (requiredEnergyMax) filter.requiredEnergyMax = Number(requiredEnergyMax[1]);
    if (subject.includes("fulfilled required energy")) filter.requiredEnergyFulfilled = true;
    const apCost = subject.match(/(\d+) ap cost/);
    if (apCost) filter.apCost = Number(apCost[1]);
    const bpMax = subject.match(/(\d+) or less bp/);
    if (bpMax) filter.bpMax = Number(bpMax[1]);
    if (names.length > 0 && /\bor\b/.test(subject)) {
      const nonNameFilter = { ...filter };
      filter = {
        anyOf: [
          ...names.map((name) => ({ name })),
          nonNameFilter
        ]
      };
    } else if (names.length === 1) {
      filter.name = names[0];
    } else if (names.length > 1) {
      filter.names = names;
    }

    return {
      kind: "lookTopDeckPlayOneAndMoveRest",
      count,
      filter,
      rested: playLookedThenRest.groups.state !== "active",
      destinationLine: LINES.FRONT,
      remainingDestination: playLookedThenRest.groups.rest,
      allowRaid: lower.includes("or perform raid with it")
    };
  }

  if (/add (?:one|up to one) card among them to your hand and place (?:one|up to one) card among them into your sideline.*place the remaining cards on the bottom of your deck/.test(lower)) {
    return {
      kind: "lookTopDeckAndMove",
      count,
      destinations: ["hand", "sideline", "bottom"],
      defaultDestination: "bottom",
      defaultPlacements: [
        { index: 0, destination: "hand" },
        { index: 1, destination: "sideline" }
      ],
      minDestinations: lower.includes("up to one") ? undefined : { hand: 1, sideline: 1 },
      maxDestinations: { hand: 1, sideline: 1 }
    };
  }

  if (/add (?:one|up to one) (?:card|of those cards|of them) (?:among them )?to your hand.*place (?:the )?remaining cards? into your sideline/.test(lower)
    || /add (?:one|up to one) of those cards to your hand and place (?:the )?remaining cards? into your sideline/.test(lower)) {
    return {
      kind: "lookTopDeckAndMove",
      count,
      destinations: ["hand", "sideline"],
      defaultDestination: "sideline",
      defaultPlacements: [{ index: 0, destination: "hand" }],
      ...(lower.includes("up to one") ? {} : { minDestinations: { hand: 1 } }),
      maxDestinations: { hand: 1 }
    };
  }

  if (/add (?:one|up to one) card among them to your hand.*place the remaining cards on the bottom of your deck/.test(lower)) {
    return {
      kind: "lookTopDeckAndMove",
      count,
      destinations: ["hand", "bottom"],
      defaultDestination: "bottom",
      defaultPlacements: [{ index: 0, destination: "hand" }],
      ...(lower.includes("up to one") ? {} : { minDestinations: { hand: 1 } }),
      maxDestinations: { hand: 1 }
    };
  }

  const underSelfMove = lower.match(/place (up to )?(one|two|three|four|five|\d+) cards? face down under this character.*place the remaining cards on the (top|bottom) of your deck/);
  if (underSelfMove) {
    const moveCount = numberFromText(underSelfMove[2], 1);
    return {
      kind: "lookTopDeckAndMove",
      count,
      destinations: ["underSelf", underSelfMove[3]],
      defaultDestination: underSelfMove[3],
      nonDefaultDestination: "underSelf",
      defaultNonDefaultCount: moveCount,
      maxNonDefault: moveCount,
      ...(underSelfMove[1] ? {} : { minNonDefault: moveCount })
    };
  }

  if (/place (?:it|them) on the top or bottom of your deck/.test(lower)
    || /place them on the top and\/or bottom of your deck/.test(lower)) {
    return {
      kind: "lookTopDeckAndMove",
      count,
      destinations: ["top", "bottom"],
      defaultDestination: "top"
    };
  }

  if (/place (?:it|them) on the top of your deck or into your sideline/.test(lower)) {
    return {
      kind: "lookTopDeckAndMove",
      count,
      destinations: ["top", "sideline"],
      defaultDestination: "top"
    };
  }

  if (/place any number of them on the top of your deck.*remaining cards (?:on the bottom of your deck|into your sideline)/.test(lower)) {
    return {
      kind: "lookTopDeckAndMove",
      count,
      destinations: lower.includes("remaining cards into your sideline") ? ["top", "sideline"] : ["top", "bottom"],
      defaultDestination: "top"
    };
  }

  if (/place any number of .+ affinity cards among them into your sideline\. place the remaining cards on the top of your deck/.test(lower)) {
    return {
      kind: "lookTopDeckAndMove",
      count,
      destinations: ["top", "sideline"],
      defaultDestination: "top"
    };
  }

  if (/place up to one of them into your sideline.*remaining cards on the top of your deck/.test(lower)) {
    return {
      kind: "lookTopDeckAndMove",
      count,
      destinations: ["top", "sideline"],
      defaultDestination: "top",
      maxNonDefault: 1
    };
  }

  if (/place up to one .+ into your sideline(?:, then|\.| then)?\s*place the remaining cards on the top of your deck/.test(lower)
    || /place up to one card into your sideline, then place the remaining cards on the top of your deck/.test(lower)) {
    return {
      kind: "lookTopDeckAndMove",
      count,
      destinations: ["top", "sideline"],
      defaultDestination: "top",
      maxNonDefault: 1
    };
  }

  if (/place up to one .+ into your sideline(?:, then|\.| then)?\s*place the remaining cards on the bottom of your deck/.test(lower)
    || /place up to one card into your sideline\. place the remaining cards on the bottom of your deck/.test(lower)) {
    return {
      kind: "lookTopDeckAndMove",
      count,
      destinations: ["sideline", "bottom"],
      defaultDestination: "bottom",
      maxNonDefault: 1
    };
  }

  if (/place up to one (?:of them|card) on the top of your deck.*remaining cards on the bottom of your deck/.test(lower)) {
    return {
      kind: "lookTopDeckAndMove",
      count,
      destinations: ["top", "bottom"],
      defaultDestination: "bottom",
      maxNonDefault: 1
    };
  }

  return undefined;
}

function encodeRevealTopDeck(lower) {
  const revealCount = lower.match(/reveal the top (?:(card)|(?:(one|two|three|four|five|\d+) cards?)) of your deck/);
  if (!revealCount) {
    return undefined;
  }

  if (/place the revealed card on the top or bottom of your deck/.test(lower)
    || /then place it on the top or bottom of your deck/.test(lower)) {
    return {
      kind: "lookTopDeckAndMove",
      count: 1,
      destinations: ["top", "bottom"],
      defaultDestination: "top"
    };
  }

  if (!lower.includes("add it to your hand") && !lower.includes("add up to one")) return undefined;

  const count = revealCount[1] ? 1 : numberFromText(revealCount[2], 1);
  const filter = {};
  const names = [...lower.matchAll(/<([^>]+)>/g)].map((match) => match[1]);
  const affinities = [...lower.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]);
  if (names.length > 0 && affinities.length > 0) {
    filter.anyOf = [
      ...affinities.map((affinity) => ({ affinity })),
      ...names.map((name) => ({ name }))
    ];
  } else {
    if (names.length === 1) filter.name = names[0];
    if (names.length > 1) filter.names = names;

    if (affinities.length === 1) filter.affinity = affinities[0];
    if (affinities.length > 1) filter.anyOf = affinities.map((affinity) => ({ affinity }));
  }
  const color = lower.match(/(red|blue|green|yellow|purple) character card/);
  if (color) filter.color = color[1];
  if (lower.includes("character card")) filter.type = CARD_TYPES.CHARACTER;
  if (lower.includes("event card")) filter.type = CARD_TYPES.EVENT;
  if (lower.includes("site card")) filter.type = CARD_TYPES.SITE;
  const requiredEnergyMax = lower.match(/(\d+) or less required energy/);
  if (requiredEnergyMax) filter.requiredEnergyMax = Number(requiredEnergyMax[1]);

  return {
    kind: "searchTopDeck",
    count,
    max: 1,
    destination: "hand",
    remainingDestination: lower.includes("remaining cards into your sideline")
      || lower.includes("remaining card into your sideline")
      ? "sideline"
      : undefined,
    filter
  };
}

function targetFromText(lower, originalLower = lower) {
  if (!lower.includes("choose")) return undefined;
  const target = {
    type: lower.includes("character") ? CARD_TYPES.CHARACTER : undefined,
    max: lower.includes("up to one") || lower.includes("choose one") ? 1 : undefined
  };

  if (lower.includes("attacking character")) {
    target.attacking = true;
  }

  if (lower.includes("your field or your opponent's field")
    || lower.includes("your opponent's field or your field")) {
    target.controller = "both";
    target.line = "field";
  } else if (lower.includes("opponent's front line")) {
    target.controller = "opponent";
    target.line = LINES.FRONT;
  } else if (lower.includes("opponent's characters")) {
    target.controller = "opponent";
    target.line = "field";
  } else if (lower.includes("opponent's field")) {
    target.controller = "opponent";
    target.line = "field";
  } else if (lower.includes("your front line")) {
    target.controller = "self";
    target.line = LINES.FRONT;
  } else if (lower.includes("your energy line")) {
    target.controller = "self";
    target.line = LINES.ENERGY;
  } else if (lower.includes("your field")) {
    target.controller = "self";
    target.line = "field";
  }

  if (lower.includes("one other character")) target.otherThanSource = true;
  if (lower.includes("not raided")) target.notRaided = true;
  const otherThanNameMatch = lower.match(/other than <([^>]+)>/);
  if (otherThanNameMatch) target.otherThanName = otherThanNameMatch[1];
  if (lower.includes("resting character")) target.rested = true;
  if (lower.includes("active character")) target.rested = false;

  const nameMatch = lower.match(/choose(?: up to)? one(?: non-raided| raided)? <([^>]+)>/);
  if (nameMatch) target.name = nameMatch[1];
  const chosenNames = [...lower.matchAll(/<([^>]+)>/g)].map((match) => match[1]);
  if (chosenNames.length > 1) {
    delete target.name;
    target.names = chosenNames;
  }

  const affinityMatch = lower.match(/choose(?: up to)? one(?: other)? \[([^\]]+)\] affinity/);
  if (affinityMatch) target.affinity = affinityMatch[1];
  const affinityPairMatch = lower.match(/choose(?: up to)? one(?: active| resting)? \[([^\]]+)\] or \[([^\]]+)\] affinity/);
  if (affinityPairMatch) {
    delete target.affinity;
    target.affinities = [affinityPairMatch[1], affinityPairMatch[2]];
  }
  const oneOfYourAffinityMatch = lower.match(/choose one of your \[([^\]]+)\] affinity characters?/);
  if (oneOfYourAffinityMatch) target.affinity = oneOfYourAffinityMatch[1];
  const characterWithAffinityMatch = lower.match(/choose(?: up to)? one(?: other)? character with \[([^\]]+)\] affinity/);
  if (characterWithAffinityMatch) target.affinity = characterWithAffinityMatch[1];

  const colorCharacterMatch = lower.match(/choose(?: up to)? one (red|blue|green|yellow|purple) character/);
  if (colorCharacterMatch) target.color = colorCharacterMatch[1];

  const bpMatch = lower.match(/with\s+\{?(\d+)\s+or less\}?\s+bp/);
  if (bpMatch) target.bpMax = Number(bpMatch[1]);

  const requiredEnergyMatch = lower.match(/with\s+(\d+)\s+or less required energy/);
  if (requiredEnergyMatch) target.requiredEnergyMax = Number(requiredEnergyMatch[1]);

  const requiredEnergyMinMatch = lower.match(/with\s+(\d+)\s+or more required energy/);
  if (requiredEnergyMinMatch) target.requiredEnergyMin = Number(requiredEnergyMinMatch[1]);

  const energyGenerationMatch = lower.match(/with\s+(\d+)\s+or less energy generation/);
  if (energyGenerationMatch) target.energyGenerationMax = Number(energyGenerationMatch[1]);

  if (lower.includes("character with an ability")) target.hasAbilityTiming = TIMINGS.ACTIVATE_MAIN;
  if (lower.includes("raided card") || lower.includes("raided character")) target.raided = true;
  if (lower.includes("non-raided")) target.notRaided = true;
  if (originalLower.includes("with [raid]")) target.hasRaid = true;
  if (lower.includes("with no face-down cards under it")) target.noFaceDownUnder = true;
  if (lower.includes("with a face-down card under it")) target.hasFaceDownUnder = true;

  return target.controller || target.attacking ? target : undefined;
}

function encodeMoveCardFromSidelineToHand(lower) {
  if (!lower.includes("from your sideline") || !lower.includes("add")) return undefined;

  const templatedAdd = lower.match(/\{add to your hand\} up to one(?: (red|blue|green|yellow|purple))? (?:(character|event|site) )?card with (\d+) or less required energy and (\d+) ap cost from your sideline/);
  if (templatedAdd) {
    return {
      kind: "moveCardBetweenZones",
      source: "sideline",
      destination: "hand",
      filter: {
        color: templatedAdd[1] || undefined,
        type: templatedAdd[2] ? CARD_TYPES[templatedAdd[2].toUpperCase()] : undefined,
        requiredEnergyMax: Number(templatedAdd[3]),
        apCost: Number(templatedAdd[4])
      }
    };
  }

  const anyNamed = lower.match(/add any number of <([^>]+)> cards from your sideline to your hand/);
  if (anyNamed) {
    return {
      kind: "moveCardBetweenZones",
      source: "sideline",
      destination: "hand",
      all: true,
      filter: { name: anyNamed[1] }
    };
  }

  const namedPair = lower.match(/add(?: up to)? one <([^>]+)> or <([^>]+)> card from your sideline to your hand/);
  if (namedPair) {
    return {
      kind: "moveCardBetweenZones",
      source: "sideline",
      destination: "hand",
      filter: {
        anyOf: [
          { name: namedPair[1] },
          { name: namedPair[2] }
        ]
      }
    };
  }

  const namedPairRequiredEnergy = lower.match(/add(?: up to)? one <([^>]+)> or <([^>]+)> card with (\d+) or less required energy from your sideline to your hand/);
  if (namedPairRequiredEnergy) {
    return {
      kind: "moveCardBetweenZones",
      source: "sideline",
      destination: "hand",
      filter: {
        requiredEnergyMax: Number(namedPairRequiredEnergy[3]),
        anyOf: [
          { name: namedPairRequiredEnergy[1] },
          { name: namedPairRequiredEnergy[2] }
        ]
      }
    };
  }

  const affinityOrTwoNames = lower.match(/add(?: up to)? one \[([^\]]+)\] affinity, <([^>]+)>, or <([^>]+)> card from your sideline to your hand/);
  if (affinityOrTwoNames) {
    return {
      kind: "moveCardBetweenZones",
      source: "sideline",
      destination: "hand",
      filter: {
        anyOf: [
          { affinity: affinityOrTwoNames[1] },
          { name: affinityOrTwoNames[2] },
          { name: affinityOrTwoNames[3] }
        ]
      }
    };
  }

  const namedOrAffinity = lower.match(/add(?: up to)? one <([^>]+)> or \[([^\]]+)\] affinity card from your sideline to your hand/);
  if (namedOrAffinity) {
    return {
      kind: "moveCardBetweenZones",
      source: "sideline",
      destination: "hand",
      filter: {
        anyOf: [
          { name: namedOrAffinity[1] },
          { affinity: namedOrAffinity[2] }
        ]
      }
    };
  }

  const coloredNamedOrAffinity = lower.match(/add(?: up to)? one (red|blue|green|yellow|purple)?\s*<([^>]+)> or \[([^\]]+)\] affinity card(?: with (\d+) or less required energy)? from your sideline to your hand/);
  if (coloredNamedOrAffinity) {
    return {
      kind: "moveCardBetweenZones",
      source: "sideline",
      destination: "hand",
      filter: {
        color: coloredNamedOrAffinity[1] || undefined,
        requiredEnergyMax: coloredNamedOrAffinity[4] ? Number(coloredNamedOrAffinity[4]) : undefined,
        anyOf: [
          { name: coloredNamedOrAffinity[2] },
          { affinity: coloredNamedOrAffinity[3] }
        ]
      }
    };
  }

  const affinityOrNamed = lower.match(/add(?: up to)? one \[([^\]]+)\] affinity or <([^>]+)> card(?: with (\d+) or less required energy)? from your sideline to your hand/);
  if (affinityOrNamed) {
    return {
      kind: "moveCardBetweenZones",
      source: "sideline",
      destination: "hand",
      filter: {
        requiredEnergyMax: affinityOrNamed[3] ? Number(affinityOrNamed[3]) : undefined,
        anyOf: [
          { affinity: affinityOrNamed[1] },
          { name: affinityOrNamed[2] }
        ]
      }
    };
  }

  const named = lower.match(/add(?: up to)? one <([^>]+)> card(?: without)?(?: with (\d+) or less required energy)?(?: and (\d+) ap cost)? from your sideline to your hand/)
    ?? lower.match(/add(?: up to)? one <([^>]+)> card withoutfrom your sideline to your hand/);
  if (named) {
    return {
      kind: "moveCardBetweenZones",
      source: "sideline",
      destination: "hand",
      filter: {
        name: named[1],
        requiredEnergyMax: named[2] ? Number(named[2]) : undefined,
        apCost: named[3] ? Number(named[3]) : undefined
      }
    };
  }

  const affinity = lower.match(/add(?: up to)? one \[([^\]]+)\] affinity card(?: with (\d+) or less required energy)? from your sideline to your hand/);
  if (affinity) {
    return {
      kind: "moveCardBetweenZones",
      source: "sideline",
      destination: "hand",
      filter: {
        affinity: affinity[1],
        requiredEnergyMax: affinity[2] ? Number(affinity[2]) : undefined
      }
    };
  }

  const countMatch = lower.match(/add(?: up to)? (one|two|three|\d+)/);
  const count = countMatch ? numberFromText(countMatch[1], 1) : 1;

  const typedWithApOnly = lower.match(/add(?: up to)? one(?: (red|blue|green|yellow|purple))? (?:(character|event|site) )?card with (\d+) ap cost from your sideline to your hand/);
  if (typedWithApOnly) {
    return {
      kind: "moveCardBetweenZones",
      source: "sideline",
      destination: "hand",
      count,
      filter: {
        color: typedWithApOnly[1] || undefined,
        type: typedWithApOnly[2] ? CARD_TYPES[typedWithApOnly[2].toUpperCase()] : undefined,
        apCost: Number(typedWithApOnly[3])
      }
    };
  }

  const otherThanWithBp = lower.match(/add(?: up to)? one(?: (red|blue|green|yellow|purple))? character card with \{?(\d+)\}?\s+or less bp other than <([^>]+)> from your sideline to your hand/);
  if (otherThanWithBp) {
    return {
      kind: "moveCardBetweenZones",
      source: "sideline",
      destination: "hand",
      count,
      filter: {
        color: otherThanWithBp[1] || undefined,
        type: CARD_TYPES.CHARACTER,
        bpMax: Number(otherThanWithBp[2]),
        otherThanName: otherThanWithBp[3]
      }
    };
  }

  const otherThan = lower.match(/add(?: up to)? one(?: (red|blue|green|yellow|purple))? character card other than <([^>]+)> from your sideline to your hand/);
  if (otherThan) {
    return {
      kind: "moveCardBetweenZones",
      source: "sideline",
      destination: "hand",
      count,
      filter: {
        color: otherThan[1] || undefined,
        type: CARD_TYPES.CHARACTER,
        otherThanName: otherThan[2]
      }
    };
  }

  const otherThanWithRequiredEnergy = lower.match(/add(?: up to)? one(?: (red|blue|green|yellow|purple))? character card with (\d+) or less required energy other than <([^>]+)> from your sideline to your hand/);
  if (otherThanWithRequiredEnergy) {
    return {
      kind: "moveCardBetweenZones",
      source: "sideline",
      destination: "hand",
      count,
      filter: {
        color: otherThanWithRequiredEnergy[1] || undefined,
        type: CARD_TYPES.CHARACTER,
        requiredEnergyMax: Number(otherThanWithRequiredEnergy[2]),
        otherThanName: otherThanWithRequiredEnergy[3]
      }
    };
  }

  const eventWithoutTriggers = lower.match(/add(?: up to)? one event card with(?: neither \[special trigger\] nor \[final trigger\]|out a \[special trigger\]) from your sideline to your hand/);
  if (eventWithoutTriggers) {
    return {
      kind: "moveCardBetweenZones",
      source: "sideline",
      destination: "hand",
      filter: {
        type: CARD_TYPES.EVENT,
        excludeTriggerTypes: lower.includes("final trigger") ? ["special", "final"] : ["special"]
      }
    };
  }

  const typed = lower.match(/add(?: up to)? (?:one|two|three|\d+)(?: (red|blue|green|yellow|purple))? (?:(character|event|site) )?cards?(?: with (\d+) or less required energy)?(?: and (\d+) ap cost)?(?: with \[([^\]]+)\] affinity)? from your sideline to your hand/)
    ?? lower.match(/add(?: up to)? (?:one|two|three|\d+)(?: (red|blue|green|yellow|purple))? (?:(character|event|site) )?cards? with \[([^\]]+)\] affinity(?: with (\d+) or less required energy)?(?: and (\d+) ap cost)? from your sideline to your hand/);
  if (!typed) return undefined;
  const alternateAffinityForm = typed.length === 6 && typed[3] && !/^\d+$/.test(String(typed[3]));
  return {
    kind: "moveCardBetweenZones",
    source: "sideline",
    destination: "hand",
    count,
    filter: {
      color: typed[1] || undefined,
      type: typed[2] ? CARD_TYPES[typed[2].toUpperCase()] : undefined,
      requiredEnergyMax: alternateAffinityForm ? (typed[4] ? Number(typed[4]) : undefined) : (typed[3] ? Number(typed[3]) : undefined),
      apCost: alternateAffinityForm ? (typed[5] ? Number(typed[5]) : undefined) : (typed[4] ? Number(typed[4]) : undefined),
      affinity: alternateAffinityForm ? typed[3] : typed[5]
    }
  };
}

function encodeMoveCardFromSidelineToDeckTop(lower) {
  if (!lower.includes("from your sideline") || !(lower.includes("top of your deck") || lower.includes("on top of your deck"))) {
    return undefined;
  }

  const filter = {};
  const countMatch = lower.match(/place(?: up to)? (one|two|three|\d+)/);
  const count = countMatch ? numberFromText(countMatch[1], 1) : 1;

  const name = lower.match(/<([^>]+)>/);
  const affinity = lower.match(/\[([^\]]+)\] affinity/);
  const type = lower.match(/(character|event|site) card/);
  const color = lower.match(/(red|blue|green|yellow|purple) (?:character|event|site|card)/);
  const requiredEnergyMax = lower.match(/(\d+) or less required energy/);

  if (name && affinity) {
    filter.anyOf = [
      { name: name[1] },
      { affinity: affinity[1] }
    ];
  } else if (name) {
    filter.name = name[1];
  } else if (affinity) {
    filter.affinity = affinity[1];
  }

  if (type) filter.type = CARD_TYPES[type[1].toUpperCase()];
  if (color) filter.color = color[1];
  if (requiredEnergyMax) filter.requiredEnergyMax = Number(requiredEnergyMax[1]);

  return {
    kind: "moveCardBetweenZones",
    source: "sideline",
    destination: "deck",
    position: "top",
    count,
    filter
  };
}

function encodePlayCharacterFromZone(lower, choiceKey) {
  const destinationLineFromMatch = (value) => value === "energy line" ? LINES.ENERGY : LINES.FRONT;

  const namedPairSeparatePlay = lower.match(/play up to one <([^>]+)> and up to one <([^>]+)> card from your (hand or sideline|hand|sideline).*set to\s+\{?(active|resting)\}?.*onto your\s+(front line|field|energy line)/);
  if (namedPairSeparatePlay) {
    return {
      kind: "playCardFromZone",
      zones: zoneListFromText(namedPairSeparatePlay[3]),
      count: 2,
      rested: namedPairSeparatePlay[4] !== "active",
      destinationLine: destinationLineFromMatch(namedPairSeparatePlay[5]),
      choiceKey,
      filter: {
        type: CARD_TYPES.CHARACTER,
        names: [namedPairSeparatePlay[1], namedPairSeparatePlay[2]]
      }
    };
  }

  const fulfilledNamedOrAffinityPlay = lower.match(/play(?: up to)? (one|two) (?:(red|blue|green|yellow|purple) )?character cards? with fulfilled required energy and (\d+) ap cost that are either <([^>]+)> or have \[([^\]]+)\] affinity from your (hand or sideline|hand|sideline).*set to\s+\{?(active|resting)\}?.*onto your\s+(front line|field|energy line)/);
  if (fulfilledNamedOrAffinityPlay) {
    return {
      kind: "playCardFromZone",
      zones: zoneListFromText(fulfilledNamedOrAffinityPlay[6]),
      count: numberFromText(fulfilledNamedOrAffinityPlay[1], 1),
      rested: fulfilledNamedOrAffinityPlay[7] !== "active",
      destinationLine: destinationLineFromMatch(fulfilledNamedOrAffinityPlay[8]),
      choiceKey,
      filter: {
        type: CARD_TYPES.CHARACTER,
        color: fulfilledNamedOrAffinityPlay[2] || undefined,
        requiredEnergyFulfilled: true,
        apCost: Number(fulfilledNamedOrAffinityPlay[3]),
        anyOf: [
          { name: fulfilledNamedOrAffinityPlay[4] },
          { affinity: fulfilledNamedOrAffinityPlay[5] }
        ]
      }
    };
  }

  const fulfilledAffinityOrNamedPlay = lower.match(/play(?: up to)? (one|two) \[([^\]]+)\] affinity or <([^>]+)> card with fulfilled required energy and (\d+) ap cost from your (hand or sideline|hand|sideline).*set to\s+\{?(active|resting)\}?.*onto your\s+(front line|field|energy line)/);
  if (fulfilledAffinityOrNamedPlay) {
    return {
      kind: lower.includes("perform raid with it") ? "playOrRaidCardFromZone" : "playCardFromZone",
      zones: zoneListFromText(fulfilledAffinityOrNamedPlay[5]),
      count: numberFromText(fulfilledAffinityOrNamedPlay[1], 1),
      rested: fulfilledAffinityOrNamedPlay[6] !== "active",
      destinationLine: destinationLineFromMatch(fulfilledAffinityOrNamedPlay[7]),
      choiceKey,
      allowRaid: lower.includes("perform raid with it"),
      filter: {
        type: CARD_TYPES.CHARACTER,
        requiredEnergyFulfilled: true,
        apCost: Number(fulfilledAffinityOrNamedPlay[4]),
        anyOf: [
          { affinity: fulfilledAffinityOrNamedPlay[2] },
          { name: fulfilledAffinityOrNamedPlay[3] }
        ]
      }
    };
  }

  const affinityFulfilledApPlay = lower.match(/play(?: up to)? (one|two) (?:(red|blue|green|yellow|purple) )?character card with \[([^\]]+)\] affinity, fulfilled required energy, and (\d+) ap cost from your (hand or sideline|hand|sideline).*set to\s+\{?(active|resting)\}?.*onto your\s+(front line|field|energy line)/);
  if (affinityFulfilledApPlay) {
    return {
      kind: "playCardFromZone",
      zones: zoneListFromText(affinityFulfilledApPlay[5]),
      count: numberFromText(affinityFulfilledApPlay[1], 1),
      rested: affinityFulfilledApPlay[6] !== "active",
      destinationLine: destinationLineFromMatch(affinityFulfilledApPlay[7]),
      choiceKey,
      filter: {
        type: CARD_TYPES.CHARACTER,
        color: affinityFulfilledApPlay[2] || undefined,
        affinity: affinityFulfilledApPlay[3],
        requiredEnergyFulfilled: true,
        apCost: Number(affinityFulfilledApPlay[4])
      }
    };
  }

  const noTriggerRequiredEnergyPlay = lower.match(/play(?: up to)? (one|two) (?:(red|blue|green|yellow|purple) )?character card with \{?(\d+)\}?\s+or less required energy and without a \[trigger\] ability from your (hand or sideline|hand|sideline).*set to\s+\{?(active|resting)\}?.*onto your\s+(front line|field|energy line)/);
  if (noTriggerRequiredEnergyPlay) {
    return {
      kind: "playCardFromZone",
      zones: zoneListFromText(noTriggerRequiredEnergyPlay[4]),
      count: numberFromText(noTriggerRequiredEnergyPlay[1], 1),
      rested: noTriggerRequiredEnergyPlay[5] !== "active",
      destinationLine: destinationLineFromMatch(noTriggerRequiredEnergyPlay[6]),
      choiceKey,
      filter: {
        type: CARD_TYPES.CHARACTER,
        color: noTriggerRequiredEnergyPlay[2] || undefined,
        requiredEnergyMax: Number(noTriggerRequiredEnergyPlay[3]),
        noTrigger: true
      }
    };
  }

  const genericAffinityPlay = lower.match(/play(?: up to)? (one|two) (?:(red|blue|green|yellow|purple) )?(?:character )?card with \[([^\]]+)\] affinity(?: and (\d+) or less required energy)?(?: and (\d+) ap cost)? from your (hand or sideline|hand|sideline).*set to\s+\{?(active|resting)\}?.*onto your\s+(front line|field|energy line)/);
  if (genericAffinityPlay) {
    return {
      kind: "playCardFromZone",
      zones: zoneListFromText(genericAffinityPlay[6]),
      count: numberFromText(genericAffinityPlay[1], 1),
      rested: genericAffinityPlay[7] !== "active",
      destinationLine: destinationLineFromMatch(genericAffinityPlay[8]),
      choiceKey,
      filter: {
        type: CARD_TYPES.CHARACTER,
        color: genericAffinityPlay[2] || undefined,
        affinity: genericAffinityPlay[3],
        requiredEnergyMax: genericAffinityPlay[4] ? Number(genericAffinityPlay[4]) : undefined,
        apCost: genericAffinityPlay[5] ? Number(genericAffinityPlay[5]) : undefined
      }
    };
  }

  const affinityApPlay = lower.match(/play(?: up to)? (one|two) (?:(red|blue|green|yellow|purple) )?\[([^\]]+)\] affinity card with (\d+) ap cost from your (hand or sideline|hand|sideline).*set to\s+\{?(active|resting)\}?.*onto your\s+(front line|field|energy line)/);
  if (affinityApPlay) {
    return {
      kind: "playCardFromZone",
      zones: zoneListFromText(affinityApPlay[5]),
      count: numberFromText(affinityApPlay[1], 1),
      rested: affinityApPlay[6] !== "active",
      destinationLine: destinationLineFromMatch(affinityApPlay[7]),
      choiceKey,
      filter: {
        type: CARD_TYPES.CHARACTER,
        color: affinityApPlay[2] || undefined,
        affinity: affinityApPlay[3],
        apCost: Number(affinityApPlay[4])
      }
    };
  }

  const affinityCard = lower.match(/play(?: up to)? (one|two) (?:(red|blue|green|yellow|purple) )?\[([^\]]+)\] affinity card(?: with (\d+) or less required energy)?(?: and (\d+) ap cost)? from your (hand or sideline|hand|sideline).*set to\s+\{?(active|resting)\}?.*onto your\s+(front line|field)/);
  if (affinityCard) {
    return {
      kind: "playCardFromZone",
      zones: zoneListFromText(affinityCard[6]),
      count: numberFromText(affinityCard[1], 1),
      rested: affinityCard[7] !== "active",
      destinationLine: LINES.FRONT,
      choiceKey,
      filter: {
        type: CARD_TYPES.CHARACTER,
        color: affinityCard[2] || undefined,
        affinity: affinityCard[3],
        requiredEnergyMax: affinityCard[4] ? Number(affinityCard[4]) : undefined,
        apCost: affinityCard[5] ? Number(affinityCard[5]) : undefined
      }
    };
  }

  const namedPairFulfilledPlay = lower.match(/play(?: up to)? (one|two) (?:(red|blue|green|yellow|purple) )?<([^>]+)> or <([^>]+)> card with fulfilled required energy and (\d+) ap cost from your (hand or sideline|hand|sideline).*set to\s+\{?(active|resting)\}?.*onto your\s+(front line|field|energy line)/);
  if (namedPairFulfilledPlay) {
    return {
      kind: lower.includes("perform raid with it") ? "playOrRaidCardFromZone" : "playCardFromZone",
      zones: zoneListFromText(namedPairFulfilledPlay[6]),
      count: numberFromText(namedPairFulfilledPlay[1], 1),
      rested: namedPairFulfilledPlay[7] !== "active",
      destinationLine: destinationLineFromMatch(namedPairFulfilledPlay[8]),
      choiceKey,
      allowRaid: lower.includes("perform raid with it"),
      filter: {
        type: CARD_TYPES.CHARACTER,
        color: namedPairFulfilledPlay[2] || undefined,
        names: [namedPairFulfilledPlay[3], namedPairFulfilledPlay[4]],
        requiredEnergyFulfilled: true,
        apCost: Number(namedPairFulfilledPlay[5])
      }
    };
  }

  const namedPairPlay = lower.match(/play(?: up to)? (one|two) (?:(red|blue|green|yellow|purple) )?<([^>]+)> or <([^>]+)> card(?: with (\d+) or less required energy)?(?: and (\d+) ap cost)? from your (hand or sideline|hand|sideline).*set to\s+\{?(active|resting)\}?.*onto your\s+(front line|field)/);
  if (namedPairPlay) {
    return {
      kind: "playCardFromZone",
      zones: zoneListFromText(namedPairPlay[7]),
      count: numberFromText(namedPairPlay[1], 1),
      rested: namedPairPlay[8] !== "active",
      destinationLine: LINES.FRONT,
      choiceKey,
      filter: {
        type: CARD_TYPES.CHARACTER,
        color: namedPairPlay[2] || undefined,
        names: [namedPairPlay[3], namedPairPlay[4]],
        requiredEnergyMax: namedPairPlay[5] ? Number(namedPairPlay[5]) : undefined,
        apCost: namedPairPlay[6] ? Number(namedPairPlay[6]) : undefined
      }
    };
  }

  const fulfilledAffinityOtherThanPlay = lower.match(/play(?: up to)? (one|two) (?:(red|blue|green|yellow|purple) )?character card with fulfilled required energy,?\s+(\d+) ap cost, and \[([^\]]+)\] affinity other than <([^>]+)> from your (hand or sideline|hand|sideline).*set to\s+\{?(active|resting)\}?.*onto your\s+(front line|field|energy line)/);
  if (fulfilledAffinityOtherThanPlay) {
    return {
      kind: "playCardFromZone",
      zones: zoneListFromText(fulfilledAffinityOtherThanPlay[6]),
      count: numberFromText(fulfilledAffinityOtherThanPlay[1], 1),
      rested: fulfilledAffinityOtherThanPlay[7] !== "active",
      destinationLine: destinationLineFromMatch(fulfilledAffinityOtherThanPlay[8]),
      choiceKey,
      filter: {
        type: CARD_TYPES.CHARACTER,
        color: fulfilledAffinityOtherThanPlay[2] || undefined,
        requiredEnergyFulfilled: true,
        apCost: Number(fulfilledAffinityOtherThanPlay[3]),
        affinity: fulfilledAffinityOtherThanPlay[4],
        otherThanName: fulfilledAffinityOtherThanPlay[5]
      }
    };
  }

  const sameAffinityOtherThanPlay = lower.match(/play(?: up to)? (one|two) (?:(red|blue|green|yellow|purple) )?character card with \{?(\d+) or less\}? required energy,?\s+(\d+) ap cost, and \[([^\]]+)\] affinity other than <([^>]+)> from your (hand or sideline|hand|sideline).*set to\s+\{?(active|resting)\}?.*onto your\s+(front line|field)/);
  if (sameAffinityOtherThanPlay) {
    return {
      kind: "playCardFromZone",
      zones: zoneListFromText(sameAffinityOtherThanPlay[7]),
      count: numberFromText(sameAffinityOtherThanPlay[1], 1),
      rested: sameAffinityOtherThanPlay[8] !== "active",
      destinationLine: LINES.FRONT,
      choiceKey,
      filter: {
        type: CARD_TYPES.CHARACTER,
        color: sameAffinityOtherThanPlay[2] || undefined,
        requiredEnergyMax: Number(sameAffinityOtherThanPlay[3]),
        apCost: Number(sameAffinityOtherThanPlay[4]),
        affinity: sameAffinityOtherThanPlay[5],
        otherThanName: sameAffinityOtherThanPlay[6]
      }
    };
  }

  const namedRequiredEnergyPlay = lower.match(/play(?: up to)? (one|two) (?:(red|blue|green|yellow|purple) )?<([^>]+)> card with (\d+) or less required energy(?: and (\d+) ap cost)? from your (hand or sideline|hand|sideline).*set to\s+\{?(active|resting)\}?.*onto your\s+(front line|field|energy line)/);
  if (namedRequiredEnergyPlay) {
    return {
      kind: lower.includes("perform raid with it") ? "playOrRaidCardFromZone" : "playCardFromZone",
      zones: zoneListFromText(namedRequiredEnergyPlay[6]),
      count: numberFromText(namedRequiredEnergyPlay[1], 1),
      rested: namedRequiredEnergyPlay[7] !== "active",
      destinationLine: destinationLineFromMatch(namedRequiredEnergyPlay[8]),
      choiceKey,
      allowRaid: lower.includes("perform raid with it"),
      filter: {
        type: CARD_TYPES.CHARACTER,
        color: namedRequiredEnergyPlay[2] || undefined,
        name: namedRequiredEnergyPlay[3],
        requiredEnergyMax: Number(namedRequiredEnergyPlay[4]),
        apCost: namedRequiredEnergyPlay[5] ? Number(namedRequiredEnergyPlay[5]) : undefined
      }
    };
  }

  const namedListOrSitePlay = lower.match(/play(?: up to)? (one|two) (?:(red|blue|green|yellow|purple) )?<([^>]+)>, <([^>]+)>, or site card with (\d+) or less required energy from your (hand or sideline|hand|sideline).*set to\s+\{?(active|resting)\}?.*onto your\s+(front line|field|energy line)/);
  if (namedListOrSitePlay) {
    return {
      kind: "playCardFromZone",
      zones: zoneListFromText(namedListOrSitePlay[6]),
      count: numberFromText(namedListOrSitePlay[1], 1),
      rested: namedListOrSitePlay[7] !== "active",
      destinationLine: destinationLineFromMatch(namedListOrSitePlay[8]),
      choiceKey,
      filter: {
        color: namedListOrSitePlay[2] || undefined,
        requiredEnergyMax: Number(namedListOrSitePlay[5]),
        anyOf: [
          { type: CARD_TYPES.CHARACTER, name: namedListOrSitePlay[3] },
          { type: CARD_TYPES.CHARACTER, name: namedListOrSitePlay[4] },
          { type: CARD_TYPES.SITE }
        ]
      }
    };
  }

  const characterOrSiteAffinityPlay = lower.match(/play(?: up to)? (one|two)?\s*(?:character or site|character or site card|one character or site card) card? with \[([^\]]+)\] affinity from your (hand or sideline|hand|sideline).*set to\s+\{?(active|resting)\}?.*onto your\s+(front line|field|energy line)/);
  if (characterOrSiteAffinityPlay) {
    return {
      kind: "playCardFromZone",
      zones: zoneListFromText(characterOrSiteAffinityPlay[3]),
      count: numberFromText(characterOrSiteAffinityPlay[1] ?? "one", 1),
      rested: characterOrSiteAffinityPlay[4] !== "active",
      destinationLine: destinationLineFromMatch(characterOrSiteAffinityPlay[5]),
      choiceKey,
      filter: {
        affinity: characterOrSiteAffinityPlay[2],
        anyOf: [
          { type: CARD_TYPES.CHARACTER },
          { type: CARD_TYPES.SITE }
        ]
      }
    };
  }

  const bpAndRequiredEnergyPlay = lower.match(/play(?: up to)? (one|two) (?:(red|blue|green|yellow|purple) )?character card with (\d+) or less bp and (\d+) or less required energy(?: and (\d+) ap cost)? from your (hand or sideline|hand|sideline).*set to\s+\{?(active|resting)\}?.*onto your\s+(front line|field|energy line)/);
  if (bpAndRequiredEnergyPlay) {
    return {
      kind: "playCardFromZone",
      zones: zoneListFromText(bpAndRequiredEnergyPlay[6]),
      count: numberFromText(bpAndRequiredEnergyPlay[1], 1),
      rested: bpAndRequiredEnergyPlay[7] !== "active",
      destinationLine: destinationLineFromMatch(bpAndRequiredEnergyPlay[8]),
      choiceKey,
      filter: {
        type: CARD_TYPES.CHARACTER,
        color: bpAndRequiredEnergyPlay[2] || undefined,
        bpMax: Number(bpAndRequiredEnergyPlay[3]),
        requiredEnergyMax: Number(bpAndRequiredEnergyPlay[4]),
        apCost: bpAndRequiredEnergyPlay[5] ? Number(bpAndRequiredEnergyPlay[5]) : undefined
      }
    };
  }

  const namedOrAffinityPlayChoice = lower.match(/play (one|two) (?:(red|blue|green|yellow|purple) )?<([^>]+)> card with (\d+) ap cost or one (?:red|blue|green|yellow|purple)?\s*character card with \[([^\]]+)\] affinity from your (hand or sideline|hand|sideline).*set to\s+\{?(active|resting)\}?.*onto your\s+(front line|field)/);
  if (namedOrAffinityPlayChoice) {
    return {
      kind: "playCardFromZone",
      zones: zoneListFromText(namedOrAffinityPlayChoice[6]),
      count: numberFromText(namedOrAffinityPlayChoice[1], 1),
      rested: namedOrAffinityPlayChoice[7] !== "active",
      destinationLine: LINES.FRONT,
      choiceKey,
      filter: {
        type: CARD_TYPES.CHARACTER,
        color: namedOrAffinityPlayChoice[2] || undefined,
        anyOf: [
          { name: namedOrAffinityPlayChoice[3], apCost: Number(namedOrAffinityPlayChoice[4]) },
          { affinity: namedOrAffinityPlayChoice[5] }
        ]
      }
    };
  }

  const namedOrAffinitySameApPlay = lower.match(/play (one|two) (?:(red|blue|green|yellow|purple) )?<([^>]+)> card with (\d+) ap cost or one (?:(red|blue|green|yellow|purple) )?character card with \[([^\]]+)\] affinity and (\d+) ap cost from your (hand or sideline|hand|sideline).*set to\s+\{?(active|resting)\}?.*onto your\s+(front line|field)/);
  if (namedOrAffinitySameApPlay) {
    return {
      kind: "playCardFromZone",
      zones: zoneListFromText(namedOrAffinitySameApPlay[8]),
      count: numberFromText(namedOrAffinitySameApPlay[1], 1),
      rested: namedOrAffinitySameApPlay[9] !== "active",
      destinationLine: LINES.FRONT,
      choiceKey,
      filter: {
        type: CARD_TYPES.CHARACTER,
        color: namedOrAffinitySameApPlay[2] || namedOrAffinitySameApPlay[5] || undefined,
        anyOf: [
          { name: namedOrAffinitySameApPlay[3], apCost: Number(namedOrAffinitySameApPlay[4]) },
          { affinity: namedOrAffinitySameApPlay[6], apCost: Number(namedOrAffinitySameApPlay[7]) }
        ]
      }
    };
  }

  const affinityBpPlay = lower.match(/play(?: up to)? (one|two) (?:(red|blue|green|yellow|purple) )?\[([^\]]+)\] or \[([^\]]+)\] affinity card with (\d+) or less bp and (\d+) ap cost from your (hand or sideline|hand|sideline).*set to\s+\{?(active|resting)\}?.*onto your\s+(front line|field)/);
  if (affinityBpPlay) {
    return {
      kind: "playCardFromZone",
      zones: zoneListFromText(affinityBpPlay[7]),
      count: numberFromText(affinityBpPlay[1], 1),
      rested: affinityBpPlay[8] !== "active",
      destinationLine: LINES.FRONT,
      choiceKey,
      filter: {
        type: CARD_TYPES.CHARACTER,
        color: affinityBpPlay[2] || undefined,
        affinities: [affinityBpPlay[3], affinityBpPlay[4]],
        bpMax: Number(affinityBpPlay[5]),
        apCost: Number(affinityBpPlay[6])
      }
    };
  }

  const noAffinitiesPlay = lower.match(/play(?: up to)? (one|two) (?:(red|blue|green|yellow|purple) )?character card with \{?(\d+) or less\}? required energy,?\s+(\d+) ap cost, and no affinities from your (hand or sideline|hand|sideline).*set to\s+\{?(active|resting)\}?.*onto your\s+(front line|field)/);
  if (noAffinitiesPlay) {
    return {
      kind: "playCardFromZone",
      zones: zoneListFromText(noAffinitiesPlay[5]),
      count: numberFromText(noAffinitiesPlay[1], 1),
      rested: noAffinitiesPlay[6] !== "active",
      destinationLine: LINES.FRONT,
      choiceKey,
      filter: {
        type: CARD_TYPES.CHARACTER,
        color: noAffinitiesPlay[2] || undefined,
        requiredEnergyMax: Number(noAffinitiesPlay[3]),
        apCost: Number(noAffinitiesPlay[4]),
        noAffinities: true
      }
    };
  }

  const requiredEnergyMinPlay = lower.match(/play(?: up to)? (one|two) (?:(red|blue|green|yellow|purple) )?character cards? with \{?(\d+) or more\}? required energy and (\d+) ap cost from your (hand or sideline|hand|sideline).*set to\s+\{?(active|resting)\}?.*onto your\s+(front line|field)/);
  if (requiredEnergyMinPlay) {
    return {
      kind: "playCardFromZone",
      zones: zoneListFromText(requiredEnergyMinPlay[5]),
      count: numberFromText(requiredEnergyMinPlay[1], 1),
      rested: requiredEnergyMinPlay[6] !== "active",
      destinationLine: LINES.FRONT,
      choiceKey,
      filter: {
        type: CARD_TYPES.CHARACTER,
        color: requiredEnergyMinPlay[2] || undefined,
        requiredEnergyMin: Number(requiredEnergyMinPlay[3]),
        apCost: Number(requiredEnergyMinPlay[4])
      }
    };
  }

  const broad = lower.match(/play(?: up to)? (one|two) (?:(red|blue|green|yellow|purple) )?(?:<([^>]+)>(?: card)?|character cards?|cards?)(?: other than <([^>]+)>)?(?: with \{?(fulfilled|\{?\d+\}?\s+or less) required energy\}?)?(?:,? ?(?:and )?(\d+) ap cost)?(?:,? ?(?:and )?(?:no \[trigger\] ability|\[([^\]]+)\] affinity))?(?: from your (hand or sideline|hand|sideline)).*set to\s+\{?(active|resting)\}?.*onto your\s+(front line|field)/);
  if (broad) {
    const requiredEnergyText = broad[5]?.replace(/[{}]/g, "");
    return {
      kind: "playCardFromZone",
      zones: zoneListFromText(broad[8]),
      count: numberFromText(broad[1], 1),
      rested: broad[9] !== "active",
      destinationLine: LINES.FRONT,
      choiceKey,
      filter: {
        type: CARD_TYPES.CHARACTER,
        color: broad[2] || undefined,
        name: broad[3] || undefined,
        otherThanName: broad[4] || undefined,
        requiredEnergyMax: requiredEnergyText && requiredEnergyText !== "fulfilled" ? Number(requiredEnergyText.match(/\d+/)?.[0]) : undefined,
        apCost: broad[6] ? Number(broad[6]) : undefined,
        affinity: broad[7] || undefined,
        noTrigger: lower.includes("no [trigger] ability")
      }
    };
  }

  const namedOrAffinityPlay = lower.match(/play(?: up to)? (one|two) (?:(red|blue|green|yellow|purple) )?<([^>]+)> or \[([^\]]+)\] affinity card(?: with (\d+) or less required energy)? from your (hand or sideline|hand|sideline).*set to\s+(active|resting).*onto your\s+(front line|field)/);
  if (namedOrAffinityPlay) {
    return {
      kind: "playCardFromZone",
      zones: zoneListFromText(namedOrAffinityPlay[6]),
      count: numberFromText(namedOrAffinityPlay[1], 1),
      rested: namedOrAffinityPlay[7] !== "active",
      destinationLine: LINES.FRONT,
      choiceKey,
      filter: {
        type: CARD_TYPES.CHARACTER,
        color: namedOrAffinityPlay[2] || undefined,
        requiredEnergyMax: namedOrAffinityPlay[5] ? Number(namedOrAffinityPlay[5]) : undefined,
        anyOf: [
          { name: namedOrAffinityPlay[3] },
          { affinity: namedOrAffinityPlay[4] }
        ]
      }
    };
  }

  const affinityOrAffinityPlay = lower.match(/play(?: up to)? (one|two) (?:(red|blue|green|yellow|purple) )?card with (\d+) or less required energy,?\s+(\d+) ap cost, and \[([^\]]+)\] or \[([^\]]+)\] affinity from your (hand or sideline|hand|sideline).*set to\s+(active|resting).*onto your\s+(front line|field)/);
  if (affinityOrAffinityPlay) {
    return {
      kind: "playCardFromZone",
      zones: zoneListFromText(affinityOrAffinityPlay[7]),
      count: numberFromText(affinityOrAffinityPlay[1], 1),
      rested: affinityOrAffinityPlay[8] !== "active",
      destinationLine: LINES.FRONT,
      choiceKey,
      filter: {
        type: CARD_TYPES.CHARACTER,
        color: affinityOrAffinityPlay[2] || undefined,
        requiredEnergyMax: Number(affinityOrAffinityPlay[3]),
        apCost: Number(affinityOrAffinityPlay[4]),
        affinities: [affinityOrAffinityPlay[5], affinityOrAffinityPlay[6]]
      }
    };
  }

  const namedMultiZone = lower.match(/play(?: up to)? (one|two) <([^>]+)> from your (hand or sideline|hand|sideline).*set to\s+(active|resting).*onto your\s+(front line|field)/);
  if (namedMultiZone) {
    return {
      kind: "playCardFromZone",
      zones: zoneListFromText(namedMultiZone[3]),
      count: numberFromText(namedMultiZone[1], 1),
      rested: namedMultiZone[4] !== "active",
      destinationLine: LINES.FRONT,
      choiceKey,
      filter: {
        type: CARD_TYPES.CHARACTER,
        name: namedMultiZone[2]
      }
    };
  }

  const affinityOnly = lower.match(/play(?: up to)? (one|two) (?:(red|blue|green|yellow|purple) )?character cards?(?: with (\d+) or less required energy)?(?: (?:and|with))? \[([^\]]+)\] affinity from your (hand or sideline|hand|sideline).*set to\s+(active|resting).*onto your\s+(front line|field)/);
  if (affinityOnly) {
    return {
      kind: "playCardFromZone",
      zones: zoneListFromText(affinityOnly[5]),
      count: numberFromText(affinityOnly[1], 1),
      rested: affinityOnly[6] !== "active",
      destinationLine: LINES.FRONT,
      choiceKey,
      filter: {
        type: CARD_TYPES.CHARACTER,
        color: affinityOnly[2] || undefined,
        requiredEnergyMax: affinityOnly[3] ? Number(affinityOnly[3]) : undefined,
        affinity: affinityOnly[4]
      }
    };
  }

  const withoutRaidMatch = lower.match(/play(?: up to)? one\s+(red|blue|green|yellow|purple)\s+character card with\s+(\d+)\s+ap cost and without(?:\s+\[?raid\]?)?\s+from your\s+(hand|sideline).*set to\s+(active|resting).*onto your\s+(front line|field)/);
  if (withoutRaidMatch) {
    return {
      kind: "playCardFromZone",
      zone: withoutRaidMatch[3],
      rested: withoutRaidMatch[4] !== "active",
      destinationLine: LINES.FRONT,
      choiceKey,
      filter: {
        type: CARD_TYPES.CHARACTER,
        color: withoutRaidMatch[1],
        apCost: Number(withoutRaidMatch[2]),
        withoutRaid: true
      }
    };
  }

  const match = lower.match(/play(?: up to)? one\s+(?:(red|blue|green|yellow|purple)\s+)?(?:character )?card with\s+\{?(\d+)\s+or less\}?\s+required energy,?\s+(\d+)\s+ap cost(?:, and \[([^\]]+)\] affinity)? from your\s+(hand|sideline).*set to\s+\{?(active|resting)\}?.*onto your\s+(front line|field)/)
    ?? lower.match(/play(?: up to)? one\s+(red|blue|green|yellow|purple)\s+character card with\s+\{?(\d+)\s+or less\}?\s+required energy and\s+(\d+)\s+ap cost from your\s+(hand|sideline).*set to\s+\{?(active|resting)\}?.*onto your\s+(front line|field)/);
  if (!match) return undefined;
  const hasAffinityForm = match.length === 8;
  return {
    kind: "playCardFromZone",
    zone: hasAffinityForm ? match[5] : match[4],
    rested: (hasAffinityForm ? match[6] : match[5]) !== "active",
    destinationLine: LINES.FRONT,
    choiceKey,
    filter: {
      type: CARD_TYPES.CHARACTER,
      color: match[1] || undefined,
      requiredEnergyMax: Number(match[2]),
      apCost: Number(match[3]),
      affinity: hasAffinityForm ? match[4] : undefined
    }
  };
}

function zoneListFromText(value) {
  return value === "hand or sideline" ? ["hand", "sideline"] : [value];
}

function encodeDrawThenPlayWithoutRaid(lower) {
  if (!lower.includes("draw a card") || !lower.includes("without") || !lower.includes("play up to one")) return undefined;
  const playEffect = encodePlayCharacterFromZone(lower, "playZoneIndex");
  if (!playEffect?.filter?.withoutRaid) return undefined;
  return {
    kind: "sequence",
    effects: [
      { kind: "draw", amount: 1 },
      playEffect
    ]
  };
}

function keywordNameFromText(value) {
  const text = value.toLowerCase().trim();
  if (text === "double attack") return "doubleAttack";
  if (text === "double block") return "doubleBlock";
  if (text === "nullify impact") return "nullifyImpact";
  return text;
}

function encodeKeywordGrant(originalLower) {
  const duration = originalLower.includes("until the start of your next turn")
    ? "startOfNextTurn"
    : originalLower.includes("until the end of the turn") ? "turn" : "permanent";
  if (originalLower.includes("opponent must block this character's attacks if able")) {
    return { kind: "grantKeyword", keyword: "mustBlock", duration, target: "self" };
  }
  if (originalLower.includes("opponent must block this character's first attack if able")) {
    return { kind: "grantKeyword", keyword: "mustBlock", duration, target: "self" };
  }
  if (originalLower.includes("when this character attacks and is not blocked, draw")) {
    return { kind: "grantKeyword", keyword: "drawOnUnblockedAttack", value: 1, duration, target: "self" };
  }
  if (originalLower.includes("when this character's attack is not blocked, draw")) {
    return { kind: "grantKeyword", keyword: "drawOnUnblockedAttack", value: 1, duration, target: "self" };
  }
  if (originalLower.includes("when this character attacks and is blocked, draw")) {
    return { kind: "grantKeyword", keyword: "drawOnBlockedAttack", value: 1, duration, target: "self" };
  }
  if (originalLower.includes("this character cannot attack")) {
    return { kind: "grantKeyword", keyword: "cantAttack", duration, target: "self" };
  }
  if (originalLower.includes("this character cannot block") || originalLower.includes("it cannot block")) {
    return { kind: "grantKeyword", keyword: "cantBlock", duration, target: "self" };
  }
  if (originalLower.includes("cannot be sidelined or affected by bp-reducing abilities")
    || originalLower.includes("cannot be sidelined by abilities on your opponent")) {
    return { kind: "grantKeyword", keyword: "abilityProtection", duration, target: "self" };
  }
  if (originalLower.includes("generates energy even if it is on the front line")
    || originalLower.includes("generates energy even on the front line")) {
    return { kind: "grantKeyword", keyword: "frontLineEnergyGeneration", duration, target: "self" };
  }
  if (originalLower.includes("this character can attack from the energy line")) {
    return { kind: "grantKeyword", keyword: "canAttackFromEnergyLine", duration, target: "self" };
  }
  if (originalLower.includes("your opponent cannot choose this character with abilities")) {
    return { kind: "grantKeyword", keyword: "opponentAbilityTargetTax", duration: "turn", target: "self" };
  }
  if (originalLower.includes("cannot be chosen by your opponent's abilities")) {
    return { kind: "grantKeyword", keyword: "opponentAbilityProtection", duration, target: "self" };
  }
  if (originalLower.includes("cannot be chosen by your opponent's character abilities")
    || originalLower.includes("cannot be chosen by your opponent's character or trigger abilities")
    || originalLower.includes("cannot be chosen by your opponent's event card abilities")
    || originalLower.includes("cannot be chosen by your opponent's trigger")) {
    return { kind: "grantKeyword", keyword: "opponentAbilityTargetTax", duration, target: "self" };
  }
  if (originalLower.includes("gains [snipe]")) {
    return { kind: "grantKeyword", keyword: "snipe", duration, target: "self" };
  }
  if (originalLower.includes("gains [double block]")) {
    return { kind: "grantKeyword", keyword: "doubleBlock", duration, target: "self" };
  }
  if (originalLower.includes("gains [double attack]")) {
    return { kind: "grantKeyword", keyword: "doubleAttack", duration, target: "self" };
  }
  if (originalLower.includes("gains [nullify impact]")) {
    return { kind: "grantKeyword", keyword: "nullifyImpact", duration, target: "self" };
  }
  const unblockableRequiredEnergy = originalLower.match(/cannot be blocked by a character with\s+(\d+)\s+or more required energy/);
  if (unblockableRequiredEnergy) {
    return {
      kind: "grantKeyword",
      keyword: "cantBeBlockedByRequiredEnergyMin",
      value: Number(unblockableRequiredEnergy[1]),
      duration: originalLower.includes("until the end of the attack") ? "attack" : duration,
      target: "self"
    };
  }
  const unblockableBp = originalLower.match(/cannot be blocked by a character with\s+(\d+)\s+or more bp/);
  if (unblockableBp) {
    return {
      kind: "grantKeyword",
      keyword: "cantBeBlockedByBpMin",
      value: Number(unblockableBp[1]),
      duration: originalLower.includes("until the end of the attack") ? "attack" : duration,
      target: "self"
    };
  }
  const unblockableLowBp = originalLower.match(/cannot be blocked by a character with\s+(\d+)\s+or less bp/);
  if (unblockableLowBp) {
    return {
      kind: "grantKeyword",
      keyword: "cantBeBlockedByBpMax",
      value: Number(unblockableLowBp[1]),
      duration: originalLower.includes("until the end of the attack") ? "attack" : duration,
      target: "self"
    };
  }
  const damage = originalLower.match(/(?:gains.*)?\[damage\s*\(\+?(\d+)\)\]/);
  if (damage) {
    return { kind: "grantKeyword", keyword: "damage", value: Number(damage[1]), duration, target: "self" };
  }
  const impact = originalLower.match(/(?:gains.*)?\[impact\s*\(\+?(\d+)\)\]/);
  if (impact) {
    return { kind: "grantKeyword", keyword: "impact", value: Number(impact[1]), duration, target: "self" };
  }
  return undefined;
}

function opponentFrontCharacter(extra = {}) {
  return {
    controller: "opponent",
    line: LINES.FRONT,
    type: CARD_TYPES.CHARACTER,
    ...extra
  };
}

function stripEffectTags(value) {
  let text = value;
  text = text.replace(/\[(When Played|When Attacking|When Blocking|When Sidelined|Activate: Main|Start of End Phase|Switch to Resting|Sideline This Card|Once Per Turn|During Your Turn|Raid|#?If on (?:the )?Front Line#?|#?If on (?:the )?Energy Line#?|#?If in (?:the )?Sideline#?|Pay\s+\w+\s+AP|Place\s+\w+\s+Cards?\s+From Hand Into Sideline)\]/gi, "");
  text = text.replace(/\[(Damage|Impact)\s*\([^)]+\)\]\([^)]*\)/gi, "");
  for (const tag of KEYWORD_TAGS) {
    text = text.replace(new RegExp(`\\[${tag}\\]\\([^)]*\\)`, "gi"), "");
  }
  return text.replace(/\s+/g, " ").trim();
}

function wrapOptionalIfNeeded(lower, effect) {
  if (lower.startsWith("you may") || lower.includes(" you may choose")) {
    return {
      kind: "optional",
      choiceKey: "optionalEffect",
      default: true,
      effect
    };
  }
  return effect;
}

function numberFromText(value, fallback = 0) {
  const cleaned = String(value ?? "")
    .toLowerCase()
    .replace(/[{}]/g, "")
    .trim();
  if (/^\d+$/.test(cleaned)) return Number(cleaned);
  return NUMBER_WORDS.get(cleaned) ?? fallback;
}

function clip(value, length = 120) {
  const text = compactEffectText(value);
  return text.length <= length ? text : `${text.slice(0, length - 3)}...`;
}
