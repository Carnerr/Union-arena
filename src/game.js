import {
  CARD_TYPES,
  LINES,
  MAX_AP_CARDS,
  MAX_HAND_AT_END,
  MAX_LINE_SIZE,
  PHASES,
  PLAYERS,
  STARTING_HAND_SIZE,
  STARTING_LIFE,
  TIMINGS,
  TRIGGER_TYPES,
  opponentOf,
  requiredApCards
} from "./constants.js";
import { validateCatalog } from "./catalog.js";
import { expandDeckList, validateDeck } from "./deck.js";
import { assertRule } from "./errors.js";
import { deriveSeed, shuffled } from "./random.js";

const resolutionChoiceResolvers = new WeakMap();

function cloneState(state) {
  const { catalog, ...mutableState } = state;
  return {
    ...structuredClone(mutableState),
    catalog
  };
}

function getPlayer(state, playerId) {
  assertRule(PLAYERS.includes(playerId), "PLAYER", `Unknown player: ${playerId}`);
  return state.players[playerId];
}

function getOpponent(state, playerId) {
  return getPlayer(state, opponentOf(playerId));
}

function resolveRuntimeChoices(state, playerId, effect, context, request) {
  const resolver = resolutionChoiceResolvers.get(state);
  if (!resolver) return;
  const resolved = resolver({ state, playerId, effect, context, request });
  if (resolved === undefined || resolved === null) return;
  assertRule(resolved && typeof resolved === "object" && !Array.isArray(resolved), "EFFECT_CHOICE", "A resolution choice resolver must return a choices object.");
  context.choices ??= {};
  Object.assign(context.choices, resolved);
}

function defOf(state, cardOrId) {
  const cardId = typeof cardOrId === "string" ? cardOrId : cardOrId.defId;
  const def = state.catalog[cardId];
  assertRule(def, "UNKNOWN_CARD", `Unknown card definition: ${cardId}`, { cardId });
  return def;
}

function lineOf(player, lineName) {
  assertRule(lineName === LINES.FRONT || lineName === LINES.ENERGY, "LINE", `Unknown line: ${lineName}`);
  return player[lineName];
}

function topCard(permanent) {
  return permanent.cards.at(-1);
}

function topDef(state, permanent) {
  return defOf(state, topCard(permanent));
}

function baseAbilitiesLost(permanent) {
  return (permanent.keywordModifiers ?? [])
    .some((modifier) => modifier.keyword === "lostBaseAbilities");
}

function abilitiesOfPermanent(state, permanent) {
  const top = topDef(state, permanent);
  const baseCard = permanent.cards.at(-2);
  const baseAbilityTimings = top.gainsBaseAbilityTimings ?? [];
  const printedAbilities = baseAbilitiesLost(permanent) ? [] : (top.abilities ?? []);
  const baseAbilities = !baseAbilitiesLost(permanent) && baseCard && baseAbilityTimings.length > 0
    ? (defOf(state, baseCard).abilities ?? [])
      .filter((ability) => baseAbilityTimings.includes(ability.timing))
      .map((ability) => ({
        ...structuredClone(ability),
        id: `base:${baseCard.uid}:${ability.id}`
      }))
    : [];
  return [
    ...printedAbilities,
    ...baseAbilities,
    ...(permanent.gainedAbilities ?? [])
  ];
}

function isCharacter(state, permanent) {
  return topDef(state, permanent).type === CARD_TYPES.CHARACTER;
}

function hasKeyword(state, permanent, keyword) {
  const printedAbilitiesActive = !baseAbilitiesLost(permanent);
  const base = printedAbilitiesActive ? topDef(state, permanent).keywords?.[keyword] : undefined;
  const staticKeyword = printedAbilitiesActive && (topDef(state, permanent).staticKeywordModifiers ?? [])
    .some((modifier) => modifier.keyword === keyword && staticModifierApplies(state, permanent, modifier));
  const staticFieldKeyword = staticFieldKeywordModifiersForPermanent(state, permanent)
    .some(({ modifier }) => modifier.keyword === keyword);
  const dynamic = permanent.keywordModifiers?.some((modifier) => modifier.keyword === keyword);
  return Boolean(base || staticKeyword || staticFieldKeyword || dynamic);
}

function keywordValue(state, permanent, keyword, fallback = 0) {
  const printedAbilitiesActive = !baseAbilitiesLost(permanent);
  const value = printedAbilitiesActive ? topDef(state, permanent).keywords?.[keyword] : undefined;
  const base = value === true ? 1 : Number(value ?? fallback);
  const staticValues = (printedAbilitiesActive ? topDef(state, permanent).staticKeywordModifiers ?? [] : [])
    .filter((modifier) => modifier.keyword === keyword && staticModifierApplies(state, permanent, modifier))
    .map((modifier) => modifier.value === true ? 1 : Number(modifier.value ?? 1));
  const dynamicValues = (permanent.keywordModifiers ?? [])
    .filter((modifier) => modifier.keyword === keyword)
    .map((modifier) => modifier.value === true ? 1 : Number(modifier.value ?? 1));
  const staticFieldValues = staticFieldKeywordModifiersForPermanent(state, permanent)
    .filter(({ modifier }) => modifier.keyword === keyword)
    .map(({ modifier }) => modifier.value === true ? 1 : Number(modifier.value ?? 1));

  if (keyword.endsWith("Plus")) {
    return [...staticValues, ...staticFieldValues, ...dynamicValues].reduce((total, current) => total + current, base);
  }

  return Math.max(base, ...staticValues, ...staticFieldValues, ...dynamicValues, fallback);
}

function permanentEnergyGeneration(state, permanent) {
  const def = topDef(state, permanent);
  return [
    ...(def.energy ?? []),
    ...(permanent.energyModifiers ?? []),
    ...(baseAbilitiesLost(permanent) ? [] : (def.staticEnergyModifiers ?? [])
      .filter((modifier) => staticModifierApplies(state, permanent, modifier)))
  ].reduce((total, icon) => total + Number(icon.amount ?? 0), 0);
}

function sameText(left, right) {
  return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
}

function includesText(values = [], value) {
  return values.some((item) => sameText(item, value));
}

function namesOfCardDef(def) {
  return [def?.name, ...(def?.alternateNames ?? [])].filter(Boolean);
}

function cardDefHasName(def, name) {
  return namesOfCardDef(def).some((candidate) => sameText(candidate, name));
}

function cardDefNameIncludesAll(def, parts = []) {
  const needles = parts.map((part) => String(part).toLowerCase());
  return namesOfCardDef(def).some((name) => {
    const normalized = String(name).toLowerCase();
    return needles.every((needle) => normalized.includes(needle));
  });
}

function hasTriggerAbility(def) {
  return Boolean(def.trigger?.type && def.trigger.type !== TRIGGER_TYPES.NONE);
}

function cardDefMatchesFilter(def, filter = {}) {
  if (filter.anyOf && !filter.anyOf.some((childFilter) => cardDefMatchesFilter(def, childFilter))) return false;
  if (filter.type && def.type !== filter.type) return false;
  if (filter.color && def.color !== filter.color) return false;
  if (filter.name && !cardDefHasName(def, filter.name)) return false;
  if (filter.nameIncludesAll && !cardDefNameIncludesAll(def, filter.nameIncludesAll)) return false;
  if (filter.names && !filter.names.some((name) => cardDefHasName(def, name))) return false;
  if (filter.otherThanName && cardDefHasName(def, filter.otherThanName)) return false;
  if (filter.requiredEnergyMax !== undefined && (def.requiredEnergy?.amount ?? 0) > filter.requiredEnergyMax) return false;
  if (filter.requiredEnergyMin !== undefined && (def.requiredEnergy?.amount ?? 0) < filter.requiredEnergyMin) return false;
  if (filter.apCost !== undefined && (def.apCost ?? 0) !== filter.apCost) return false;
  if (filter.apCostMin !== undefined && (def.apCost ?? 0) < filter.apCostMin) return false;
  if (filter.apCostMax !== undefined && (def.apCost ?? 0) > filter.apCostMax) return false;
  if (filter.affinity && !includesText(def.affinities, filter.affinity)) return false;
  if (filter.affinities && !def.affinities?.some((affinity) => includesText(filter.affinities, affinity))) return false;
  if (filter.withoutAffinity && includesText(def.affinities, filter.withoutAffinity)) return false;
  if (filter.withoutRaid && def.raid) return false;
  if (filter.noAffinities && (def.affinities ?? []).length > 0) return false;
  if (filter.baseBp !== undefined && (def.bp ?? 0) !== filter.baseBp) return false;
  if (filter.bpMax !== undefined && (def.bp ?? 0) > filter.bpMax) return false;
  if (filter.bpMin !== undefined && (def.bp ?? 0) < filter.bpMin) return false;
  if (filter.noTrigger && hasTriggerAbility(def)) return false;
  if (filter.withTrigger && !hasTriggerAbility(def)) return false;
  if (filter.excludeTriggerTypes?.some((type) => sameText(def.trigger?.type, type))) return false;
  if (filter.triggerTypes && !filter.triggerTypes.some((type) => sameText(def.trigger?.type, type))) return false;
  return true;
}

function activeAp(player) {
  return player.apCards.filter((ap) => !ap.rested).length;
}

function payAp(state, playerId, amount) {
  const player = getPlayer(state, playerId);
  assertRule(activeAp(player) >= amount, "AP_COST", "Not enough active AP cards to pay this cost.", {
    required: amount,
    active: activeAp(player)
  });

  let remaining = amount;
  for (const ap of player.apCards) {
    if (!ap.rested && remaining > 0) {
      ap.rested = true;
      remaining -= 1;
    }
  }
  if (amount > 0 && state.phase === PHASES.ATTACK) {
    state.turnFlags ??= freshTurnFlags();
    state.turnFlags[playerId].apPaidDuringAttackPhase = true;
  }
}

function createCardRef(owner, defId, nextId) {
  return {
    uid: `${owner}-card-${nextId}`,
    owner,
    defId,
    faceUp: true
  };
}

function createPermanent(state, playerId, cardRef, rested = true) {
  const permanent = {
    pid: `perm-${state.nextPermanentId}`,
    owner: cardRef.owner,
    controller: playerId,
    cards: [cardRef],
    rested,
    bpDelta: 0,
    bpModifiers: [],
    keywordModifiers: [],
    energyModifiers: [],
    gainedAbilities: [],
    readyLocks: 0,
    playedThisTurn: true,
    attacksThisTurn: 0,
    blocksThisTurn: 0,
    usedOncePerTurn: []
  };
  state.nextPermanentId += 1;
  return permanent;
}

function rememberPlayedPermanent(context, permanent, playerId) {
  context.lastPlayedPermanent = permanent;
  context.lastPlayedPlayerId = playerId;
  context.lastPlayedPermanents = [...(context.lastPlayedPermanents ?? []), permanent];
  context.lastPlayedPlayerIds = [...(context.lastPlayedPlayerIds ?? []), playerId];
}

function drawCards(state, playerId, count, { startPhaseDraw = false } = {}) {
  const player = getPlayer(state, playerId);
  for (let i = 0; i < count; i += 1) {
    if (player.deck.length === 0) {
      if (startPhaseDraw) {
        state.winner = opponentOf(playerId);
        state.phase = PHASES.GAME_OVER;
        state.log.push(`${playerId} could not draw during the start phase. ${opponentOf(playerId)} wins.`);
        return;
      }
      state.log.push(`${playerId} attempted to draw from an empty deck.`);
      return;
    }
    player.hand.push(player.deck.shift());
  }
}

function cardDefIds(cards) {
  return cards.map((card) => card.defId);
}

function setApForCurrentTurn(state, playerId) {
  const player = getPlayer(state, playerId);
  const required = requiredApCards(playerId, player.turnsTaken);

  while (player.apCards.length < required && player.apCards.length < MAX_AP_CARDS) {
    player.apCards.push({
      id: `${playerId}-ap-${player.apCards.length + 1}`,
      rested: false
    });
  }

  if (player.apCards.length > required) {
    player.apCards = player.apCards.slice(0, required);
  }
}

function readyPermanent(permanent) {
  if ((permanent.readyLocks ?? 0) > 0) {
    permanent.readyLocks -= 1;
    permanent.rested = true;
    return false;
  }
  permanent.rested = false;
  return true;
}

function restPermanentByAbility(state, playerId, permanent, context = {}) {
  if (context.byAbilityEffect
    && abilityActionPreventedByAbility(state, playerId, permanent, "rest", context)) return false;
  const wasActive = !permanent.rested;
  const location = findPermanentLocation(getPlayer(state, playerId), permanent.pid);
  permanent.rested = true;
  if (wasActive && location?.lineName === LINES.FRONT && isCharacter(state, permanent) && !context.suppressRestedByAbility) {
    resolveFieldPermanentAbilities(state, playerId, TIMINGS.WHEN_OWN_FRONT_CHARACTER_RESTED_BY_ABILITY, {
      ...context,
      restedPermanent: permanent
    });
  }
  return true;
}

function readyField(player, { includeAp = false } = {}) {
  for (const permanent of [...player.frontLine, ...player.energyLine]) readyPermanent(permanent);
  if (includeAp) {
    for (const ap of player.apCards) {
      ap.rested = false;
    }
  }
}

function readyAp(player) {
  for (const ap of player.apCards) {
    ap.rested = false;
  }
}

function resetTurnTracking(player) {
  player.extraDrawUsed = false;
  player.usedTurnAbilityKeys = [];
  for (const permanent of [...player.frontLine, ...player.energyLine]) {
    permanent.attacksThisTurn = 0;
    permanent.blocksThisTurn = 0;
    permanent.playedThisTurn = false;
    permanent.usedOncePerTurn = [];
  }
}

function freshTurnFlags() {
  return Object.fromEntries(PLAYERS.map((playerId) => [playerId, {
    characterSidelined: false,
    eventUsed: false,
    eventUsedCount: 0,
    extraDrawUsed: false,
    handToSidelineByAbility: false,
    handToSidelineSources: [],
    deckToSidelineByAbility: false,
    sidelineToHandByAbility: false,
    movedPermanentIds: [],
    movedOutsideMovementPermanentIds: [],
    movementActionUsed: false,
    apPaidAbilityUsed: false,
    apPaidDuringAttackPhase: false,
    usedFromHandCardIds: [],
    triggerAbilityActivated: false,
    playedCharacterTriggerTypes: [],
    chosenPermanentIdsBySourceAffinity: {},
    restrictedCardUseSourceZones: []
  }]));
}

function freshPublicKnowledge() {
  return Object.fromEntries(PLAYERS.map((viewerId) => [viewerId, {
    players: Object.fromEntries(PLAYERS.map((observedPlayerId) => [observedPlayerId, {
      revealedCards: []
    }]))
  }]));
}

function ensurePublicKnowledge(state) {
  state.publicKnowledge ??= freshPublicKnowledge();
  for (const viewerId of PLAYERS) {
    state.publicKnowledge[viewerId] ??= { players: {} };
    state.publicKnowledge[viewerId].players ??= {};
    for (const observedPlayerId of PLAYERS) {
      state.publicKnowledge[viewerId].players[observedPlayerId] ??= { revealedCards: [] };
      state.publicKnowledge[viewerId].players[observedPlayerId].revealedCards ??= [];
    }
  }
  return state.publicKnowledge;
}

function turnsTaken(state) {
  return PLAYERS.reduce((total, playerId) => total + (state.players[playerId]?.turnsTaken ?? 0), 0);
}

function recordCardsRevealedToPlayer(state, viewerId, observedPlayerId, cards, { zone = "unknown", source = "effect" } = {}) {
  if (!PLAYERS.includes(viewerId) || !PLAYERS.includes(observedPlayerId)) return;
  const entry = ensurePublicKnowledge(state)[viewerId].players[observedPlayerId];
  const turn = turnsTaken(state);
  for (const card of cards.filter(Boolean)) {
    if (!card.defId) continue;
    const existing = entry.revealedCards.find((item) => item.uid === card.uid);
    if (existing) {
      existing.lastKnownZone = zone;
      existing.lastSeenTurn = turn;
      existing.lastRevealSource = source;
      continue;
    }
    entry.revealedCards.push({
      uid: card.uid,
      owner: card.owner ?? observedPlayerId,
      defId: card.defId,
      firstKnownZone: zone,
      lastKnownZone: zone,
      firstSeenTurn: turn,
      lastSeenTurn: turn,
      firstRevealSource: source,
      lastRevealSource: source
    });
  }
}

function recordCardsRevealedToOpponent(state, observedPlayerId, cards, options = {}) {
  recordCardsRevealedToPlayer(state, opponentOf(observedPlayerId), observedPlayerId, cards, options);
}

export function publicKnownCardDefIds(state, viewerId, observedPlayerId) {
  const revealed = ensurePublicKnowledge(state)[viewerId]?.players?.[observedPlayerId]?.revealedCards ?? [];
  return revealed
    .map((card) => card.defId)
    .filter(Boolean);
}

function resetTurnFlags(state) {
  state.turnFlags = freshTurnFlags();
}

function expireStartOfTurnModifiers(state, playerId) {
  for (const currentPlayerId of PLAYERS) {
    const currentPlayer = getPlayer(state, currentPlayerId);
    for (const permanent of [...currentPlayer.frontLine, ...currentPlayer.energyLine]) {
      if (permanent.controller !== playerId) continue;
      permanent.bpModifiers = (permanent.bpModifiers ?? []).filter((modifier) => modifier.expires !== "startOfControllerTurn");
      permanent.keywordModifiers = (permanent.keywordModifiers ?? []).filter((modifier) => modifier.expires !== "startOfControllerTurn");
      permanent.energyModifiers = (permanent.energyModifiers ?? []).filter((modifier) => modifier.expires !== "startOfControllerTurn");
      permanent.gainedAbilities = (permanent.gainedAbilities ?? []).filter((ability) => ability.expires !== "startOfControllerTurn");
    }
  }
}

function flagCharacterSidelined(state, playerId) {
  state.turnFlags ??= freshTurnFlags();
  state.turnFlags[playerId].characterSidelined = true;
}

function flagEventUsed(state, playerId) {
  state.turnFlags ??= freshTurnFlags();
  state.turnFlags[playerId].eventUsed = true;
  state.turnFlags[playerId].eventUsedCount = (state.turnFlags[playerId].eventUsedCount ?? 0) + 1;
}

function flagExtraDrawUsed(state, playerId) {
  state.turnFlags ??= freshTurnFlags();
  state.turnFlags[playerId].extraDrawUsed = true;
}

function flagHandToSidelineByAbility(state, playerId, sourceDef) {
  state.turnFlags ??= freshTurnFlags();
  const flags = state.turnFlags[playerId];
  flags.handToSidelineByAbility = true;
  if (sourceDef?.id && !flags.handToSidelineSources.includes(sourceDef.id)) flags.handToSidelineSources.push(sourceDef.id);
}

function flagDeckToSidelineByAbility(state, playerId) {
  state.turnFlags ??= freshTurnFlags();
  state.turnFlags[playerId].deckToSidelineByAbility = true;
}

function flagSidelineToHandByAbility(state, playerId) {
  state.turnFlags ??= freshTurnFlags();
  state.turnFlags[playerId].sidelineToHandByAbility = true;
}

function flagCharacterMoved(state, playerId, permanent, { outsideMovement = false } = {}) {
  state.turnFlags ??= freshTurnFlags();
  const flags = state.turnFlags[playerId];
  if (!flags.movedPermanentIds.includes(permanent.pid)) flags.movedPermanentIds.push(permanent.pid);
  if (outsideMovement && !flags.movedOutsideMovementPermanentIds.includes(permanent.pid)) {
    flags.movedOutsideMovementPermanentIds.push(permanent.pid);
  }
}

function flagApPaidAbilityUsed(state, playerId) {
  state.turnFlags ??= freshTurnFlags();
  state.turnFlags[playerId].apPaidAbilityUsed = true;
}

function flagCharacterPlayed(state, playerId, cardDef) {
  state.turnFlags ??= freshTurnFlags();
  if (cardDef.type !== CARD_TYPES.CHARACTER) return;
  const triggerType = cardDef.trigger?.type;
  if (!triggerType || triggerType === TRIGGER_TYPES.NONE) return;
  const list = state.turnFlags[playerId].playedCharacterTriggerTypes;
  if (!list.includes(triggerType)) list.push(triggerType);
}

function flagCardUsedFromHand(state, playerId, cardDef) {
  state.turnFlags ??= freshTurnFlags();
  const flags = state.turnFlags[playerId];
  if (cardDef?.id && !flags.usedFromHandCardIds.includes(cardDef.id)) flags.usedFromHandCardIds.push(cardDef.id);
}

function flagTriggerAbilityActivated(state, playerId) {
  state.turnFlags ??= freshTurnFlags();
  state.turnFlags[playerId].triggerAbilityActivated = true;
}

function enterStartPhase(state, playerId) {
  state.activePlayer = playerId;
  state.phase = PHASES.START;
  state.pendingAttack = null;
  resetTurnFlags(state);
  expireStartOfTurnModifiers(state, playerId);
  runStartOfTurnDelayedEffects(state, playerId);
  resolveFieldPermanentAbilities(state, playerId, TIMINGS.START_OF_TURN);

  const player = getPlayer(state, playerId);
  player.turnsTaken += 1;
  resetTurnTracking(player);

  // "Until the start of your next turn" modifiers expire before cards ready.
  state.continuousEffects = state.continuousEffects.filter((effect) => {
    return !(effect.expires === "startOfControllerTurn" && effect.controller === playerId);
  });

  readyField(player, { includeAp: true });
  setApForCurrentTurn(state, playerId);
  readyAp(player);

  const isFirstTurnOfGame = playerId === state.firstPlayer && player.turnsTaken === 1;
  if (!isFirstTurnOfGame) {
    drawCards(state, playerId, 1, { startPhaseDraw: true });
  }

  if (!state.winner) {
    state.log.push(`${playerId} begins turn ${player.turnsTaken}.`);
  }
}

function finishSetup(state) {
  for (const playerId of PLAYERS) {
    const player = getPlayer(state, playerId);
    assertRule(player.hand.length === STARTING_HAND_SIZE, "SETUP_HAND", "Each player must have a starting hand before life is placed.");
    assertRule(player.deck.length >= STARTING_LIFE, "SETUP_LIFE", "Not enough cards to place starting life.");
    player.keptHandDefIds = player.keptHandDefIds ?? cardDefIds(player.hand);
    for (let i = 0; i < STARTING_LIFE; i += 1) {
      const lifeCard = player.deck.shift();
      lifeCard.faceUp = false;
      player.life.push(lifeCard);
    }
    player.startingLifeDefIds = cardDefIds(player.life);
  }

  state.setupComplete = true;
  enterStartPhase(state, state.firstPlayer);
}

function energyAvailable(state, playerId) {
  const player = getPlayer(state, playerId);
  const totals = {};
  const energySources = [
    ...player.energyLine,
    ...player.frontLine.filter((permanent) => hasKeyword(state, permanent, "frontLineEnergyGeneration"))
  ];
  for (const permanent of energySources) {
    const def = topDef(state, permanent);
    const generated = [
      ...(def.energy ?? []),
      ...(permanent.energyModifiers ?? []),
      ...(baseAbilitiesLost(permanent) ? [] : (def.staticEnergyModifiers ?? [])
        .filter((modifier) => staticModifierApplies(state, permanent, modifier)))
    ];
    for (const icon of generated) {
      totals[icon.color] = (totals[icon.color] ?? 0) + icon.amount;
    }
  }
  return totals;
}

function hasRequiredEnergy(state, playerId, cardDef, options = {}) {
  const required = cardDef.requiredEnergy;
  if (!required || required.amount === 0) return true;
  return (energyAvailable(state, playerId)[required.color] ?? 0) >= requiredEnergyForCardUse(state, playerId, cardDef, options);
}

function staticRequiredEnergyReduction(state, playerId, cardDef, options = {}) {
  const sourceZone = options.sourceZone ?? "hand";
  return [
    ...(cardDef.useCostModifiers ?? []).map((modifier) => ({ modifier })),
    ...fieldStaticUseCostModifiers(state, playerId, cardDef, "requiredEnergy", options)
  ]
    .filter(({ modifier }) => modifier.kind === "requiredEnergy")
    .filter(({ modifier }) => !modifier.sourceZone || modifier.sourceZone === sourceZone)
    .filter(({ modifier }) => !modifier.sourceZones || modifier.sourceZones.includes(sourceZone))
    .filter(({ modifier }) => !modifier.color || modifier.color === cardDef.requiredEnergy?.color)
    .filter(({ modifier, sourcePermanent }) => conditionMet(state, playerId, modifier.condition ?? {}, { ...options, cardDef, permanent: sourcePermanent }))
    .reduce((total, { modifier, sourcePermanent }) => total + costModifierAmount(state, playerId, modifier, { ...options, cardDef, permanent: sourcePermanent }), 0);
}

function fieldStaticUseCostModifiers(state, playerId, cardDef, kind, options = {}) {
  const player = getPlayer(state, playerId);
  const sourceZone = options.sourceZone ?? "hand";
  const matches = [];
  for (const permanent of [...player.frontLine, ...player.energyLine]) {
    if (baseAbilitiesLost(permanent)) continue;
    for (const modifier of topDef(state, permanent).staticUseCostModifiers ?? []) {
      if (modifier.kind !== kind) continue;
      if (modifier.sourceZone && modifier.sourceZone !== sourceZone) continue;
      if (modifier.sourceZones && !modifier.sourceZones.includes(sourceZone)) continue;
      if (!cardDefMatchesFilter(cardDef, modifier.filter ?? {})) continue;
      matches.push({ modifier, sourcePermanent: permanent });
    }
  }
  return matches;
}

function costModifierAmount(state, playerId, modifier, context = {}) {
  const base = Number(modifier.amount ?? 0);
  if (!modifier.amountPer) return base;

  if (modifier.amountPer.kind === "zoneCountFloor") {
    const zoneName = modifier.amountPer.zone ?? "sideline";
    const every = Math.max(1, Number(modifier.amountPer.every ?? 1));
    const count = countZoneMatches(state, playerId, zoneName, modifier.amountPer.filter ?? {});
    return Math.floor(count / every) * base;
  }

  if (modifier.amountPer.kind === "fieldCount") {
    const count = countFieldMatches(state, playerId, modifier.amountPer.filter ?? {}, {
      otherThanPermanent: modifier.amountPer.otherThanSource ? context.permanent : undefined
    });
    return count * base;
  }

  return base;
}

function requiredEnergyForCardUse(state, playerId, cardDef, options = {}) {
  const required = cardDef.requiredEnergy;
  if (!required || required.amount === 0) return 0;
  const reduction = staticRequiredEnergyReduction(state, playerId, cardDef, options)
    + (state.continuousEffects ?? [])
    .filter((effect) => effect.kind === "requiredEnergyReduction"
      && effect.controller === playerId
      && (!effect.sourceZone || effect.sourceZone === (options.sourceZone ?? "hand"))
      && (!effect.sourceZones || effect.sourceZones.includes(options.sourceZone ?? "hand"))
      && cardDefMatchesFilter(cardDef, effect.filter))
    .reduce((total, effect) => total + Number(effect.amount ?? 1), 0);
  return Math.max(0, required.amount - reduction);
}

function matchingRequiredEnergyReductions(state, playerId, cardDef, { sourceZone = "hand" } = {}) {
  return (state.continuousEffects ?? []).filter((effect) => {
    return effect.kind === "requiredEnergyReduction"
      && effect.controller === playerId
      && (!effect.sourceZone || effect.sourceZone === sourceZone)
      && (!effect.sourceZones || effect.sourceZones.includes(sourceZone))
      && cardDefMatchesFilter(cardDef, effect.filter);
  });
}

function consumeRequiredEnergyReductions(state, playerId, cardDef, options = {}) {
  const matching = new Set(matchingRequiredEnergyReductions(state, playerId, cardDef, options)
    .filter((effect) => effect.consumeOnUse));
  if (matching.size === 0) return;
  state.continuousEffects = (state.continuousEffects ?? []).filter((effect) => !matching.has(effect));
}

function matchingApCostReductions(state, playerId, cardDef, { sourceZone = "hand" } = {}) {
  return (state.continuousEffects ?? []).filter((effect) => {
    return effect.kind === "apCostReduction"
      && effect.controller === playerId
      && (!effect.sourceZone || effect.sourceZone === sourceZone)
      && (!effect.sourceZones || effect.sourceZones.includes(sourceZone))
      && cardDefMatchesFilter(cardDef, effect.filter);
  });
}

function staticApCostReduction(state, playerId, cardDef, options = {}) {
  const sourceZone = options.sourceZone ?? "hand";
  return (cardDef.useCostModifiers ?? [])
    .filter((modifier) => modifier.kind === "apCost")
    .filter((modifier) => !modifier.sourceZone || modifier.sourceZone === sourceZone)
    .filter((modifier) => !modifier.sourceZones || modifier.sourceZones.includes(sourceZone))
    .filter((modifier) => conditionMet(state, playerId, modifier.condition ?? {}, { ...options, cardDef }))
    .reduce((total, modifier) => total + costModifierAmount(state, playerId, modifier, { ...options, cardDef }), 0);
}

function apCostForCardUse(state, playerId, cardDef, options = {}) {
  const baseCost = Number(cardDef.apCost ?? 0);
  const reduction = staticApCostReduction(state, playerId, cardDef, options)
    + matchingApCostReductions(state, playerId, cardDef, options)
    .reduce((total, effect) => total + Number(effect.amount ?? 1), 0);
  return Math.max(0, baseCost - reduction);
}

function consumeApCostReductions(state, playerId, cardDef, options = {}) {
  const printedCost = Number(cardDef.apCost ?? 0);
  const actualCost = apCostForCardUse(state, playerId, cardDef, options);
  let reductionToConsume = printedCost - actualCost;
  if (reductionToConsume <= 0) return;

  state.continuousEffects = (state.continuousEffects ?? []).filter((effect) => {
    if (reductionToConsume <= 0) return true;
    const applies = effect.kind === "apCostReduction"
      && effect.controller === playerId
      && (!effect.sourceZone || effect.sourceZone === (options.sourceZone ?? "hand"))
      && (!effect.sourceZones || effect.sourceZones.includes(options.sourceZone ?? "hand"))
      && cardDefMatchesFilter(cardDef, effect.filter);
    if (!applies) return true;
    reductionToConsume -= Number(effect.amount ?? 1);
    return false;
  });
}

function assertCanUseCard(state, playerId, cardDef, options = {}) {
  const sourceZone = options.sourceZone ?? "hand";
  assertRule(!cardDef.raidOnlyPlay || options.performingRaid, "RAID_ONLY", `${cardDef.name} can only be played by performing Raid with it.`, {
    card: cardDef.id
  });
  if (options.performingRaid && cardDef.raidUseCondition) {
    assertRule(conditionMet(state, playerId, cardDef.raidUseCondition, { ...options, cardDef, performingRaid: true }), "RAID_CONDITION", `${cardDef.name} cannot perform Raid because its Raid condition is not satisfied.`, {
      card: cardDef.id,
      condition: cardDef.raidUseCondition
    });
  }
  assertRule(!state.turnFlags?.[playerId]?.restrictedCardUseSourceZones?.includes(sourceZone), "USE_RESTRICTION", `Cards cannot be used from ${sourceZone} for the rest of this turn.`, {
    card: cardDef.id,
    sourceZone
  });
  assertRule(hasRequiredEnergy(state, playerId, cardDef, options), "ENERGY", "Required energy is not satisfied.", {
    card: cardDef.id,
    required: cardDef.requiredEnergy,
    available: energyAvailable(state, playerId)
  });
  const apCost = apCostForCardUse(state, playerId, cardDef, options);
  assertRule(activeAp(getPlayer(state, playerId)) >= apCost, "AP_COST", "Not enough AP to use this card.", {
    card: cardDef.id,
    apCost
  });
  for (const restriction of useRestrictionsForCard(cardDef)) {
    if (restriction.kind === "namedNotInSideline") {
      const hasNamed = getPlayer(state, playerId).sideline.some((card) => cardDefHasName(defOf(state, card), restriction.name));
      assertRule(!hasNamed, "USE_RESTRICTION", `${cardDef.name} cannot be used while ${restriction.name} is in your sideline.`, {
        card: cardDef.id,
        name: restriction.name
      });
    }
    if (restriction.kind === "energyLineHasRoom") {
      assertRule(getPlayer(state, playerId).energyLine.length < lineCapacity(state, playerId, LINES.ENERGY), "USE_RESTRICTION", `${cardDef.name} cannot be used while your energy line is full.`, {
        card: cardDef.id
      });
    }
    if (restriction.kind === "condition") {
      assertRule(conditionMet(state, playerId, restriction.condition ?? {}, { cardDef }), "USE_RESTRICTION", `${cardDef.name} cannot be used because its use condition is not satisfied.`, {
        card: cardDef.id,
        condition: restriction.condition
      });
    }
  }
}

function canUseCard(state, playerId, cardDef, options = {}) {
  try {
    assertCanUseCard(state, playerId, cardDef, options);
    return true;
  } catch {
    return false;
  }
}

function payUseRestrictionCosts(state, playerId, cardDef, choices = {}) {
  for (const restriction of useRestrictionsForCard(cardDef)) {
    if (restriction.cost) payUseRestrictionCost(state, playerId, restriction.cost, choices);
    if (restriction.costAlternatives) {
      const selected = choices.useRestrictionCostAlternative;
      const alternatives = selected !== undefined
        ? [restriction.costAlternatives[selected]]
        : restriction.costAlternatives;
      const cost = alternatives.find((candidate) => candidate && canPayUseRestrictionCost(state, playerId, candidate));
      assertRule(cost, "USE_RESTRICTION_COST", "No use restriction cost can be paid.", {
        card: cardDef.id,
        alternatives: restriction.costAlternatives
      });
      payUseRestrictionCost(state, playerId, cost, choices);
    }
  }
}

function canPayUseRestrictionCost(state, playerId, cost) {
  const player = getPlayer(state, playerId);
  if (cost.kind === "lifeToSideline") return player.life.length >= (cost.amount ?? 1);
  if (cost.kind === "restNamed") return findActiveNamedPermanents(state, playerId, cost.name, cost.line).length >= (cost.amount ?? 1);
  if (cost.kind === "restNamedAll") {
    return (cost.names ?? []).every((name) => findActiveNamedPermanents(state, playerId, name, cost.line).length > 0);
  }
  return false;
}

function payUseRestrictionCost(state, playerId, cost, choices = {}) {
  const player = getPlayer(state, playerId);
  if (cost.kind === "lifeToSideline") {
    const amount = cost.amount ?? 1;
    const indices = choices.useRestrictionLifeIndices ?? [...Array(amount).keys()];
    assertRule(indices.length === amount, "USE_RESTRICTION_COST", "Life cost requires one index per card.", { amount, indices });
    for (const index of [...indices].sort((a, b) => b - a)) {
      assertRule(index >= 0 && index < player.life.length, "USE_RESTRICTION_COST", "Life cost index is out of range.", { index });
      const card = player.life.splice(index, 1)[0];
      card.faceUp = true;
      recordCardsRevealedToOpponent(state, playerId, [card], {
        zone: "life",
        source: "lifeToSidelineCost"
      });
      placeCardInZone(state, player, "sideline", card);
    }
    return;
  }

  if (cost.kind === "restNamed") {
    const amount = cost.amount ?? 1;
    const targets = findActiveNamedPermanents(state, playerId, cost.name, cost.line).slice(0, amount);
    assertRule(targets.length === amount, "USE_RESTRICTION_COST", "Not enough active named cards to rest.", { name: cost.name, amount });
    for (const target of targets) restPermanentByAbility(state, playerId, target.permanent);
    return;
  }

  if (cost.kind === "restNamedAll") {
    for (const name of cost.names ?? []) {
      const target = findActiveNamedPermanents(state, playerId, name, cost.line)[0];
      assertRule(target, "USE_RESTRICTION_COST", "Missing active named card to rest.", { name });
      restPermanentByAbility(state, playerId, target.permanent);
    }
  }
}

function findActiveNamedPermanents(state, playerId, name, line = "field") {
  const player = getPlayer(state, playerId);
  const lines = line === LINES.FRONT ? [LINES.FRONT] : line === LINES.ENERGY ? [LINES.ENERGY] : [LINES.FRONT, LINES.ENERGY];
  const targets = [];
  for (const lineName of lines) {
    lineOf(player, lineName).forEach((permanent, index) => {
      if (!permanent.rested && cardDefHasName(topDef(state, permanent), name)) {
        targets.push({ lineName, index, permanent });
      }
    });
  }
  return targets;
}

function walkEffectTree(effect, callback) {
  if (!effect) return;
  callback(effect);
  for (const key of ["effect", "elseEffect", "baseEffect", "costEffect", "insteadEffect", "upgradedEffect", "ifMovedEffect", "successEffect"]) {
    if (effect[key]) walkEffectTree(effect[key], callback);
  }
  for (const child of effect.effects ?? []) walkEffectTree(child, callback);
  for (const choice of effect.choices ?? []) walkEffectTree(choice.effect, callback);
}

function useRestrictionsForCard(cardDef) {
  const restrictions = [];
  walkEffectTree(cardDef.eventEffect, (effect) => {
    if (effect.kind === "replacementOrUseRestriction") restrictions.push(...(effect.useRestrictions ?? []));
  });
  return restrictions;
}

function cardReplacesSidelineWithRemoval(cardDef) {
  let replaces = false;
  walkEffectTree(cardDef.eventEffect, (effect) => {
    if (effect.kind === "replacementOrUseRestriction" && effect.selfSidelineReplacement === "removal") replaces = true;
  });
  return replaces;
}

function placeCardInZone(state, player, zoneName, card, options = {}) {
  const destination = zoneOf(player, zoneName);
  const cardDef = defOf(state, card);
  if (zoneName === "sideline" && !options.fromHandUse && cardReplacesSidelineWithRemoval(cardDef)) {
    player.removal.push(card);
    return;
  }
  if (options.position === "top") destination.unshift(card);
  else destination.push(card);
}

function placeHandCardInZone(state, playerId, player, zoneName, card, options = {}, context = {}) {
  placeCardInZone(state, player, zoneName, card, options);
  if (zoneName !== "sideline") return;
  if (!player.sideline.some((candidate) => candidate.uid === card.uid)) return;
  flagHandToSidelineByAbility(state, playerId, context.sourceDef);
  resolveZoneCardAbilities(state, playerId, "sideline", card, TIMINGS.WHEN_HAND_TO_SIDELINE_BY_ABILITY, {
    ...context,
    card
  });
  resolveFieldPermanentAbilities(state, playerId, TIMINGS.WHEN_HAND_TO_SIDELINE_BY_ABILITY, {
    ...context,
    card
  });
}

function resolveSidelineToHandByAbility(state, playerId, card, sourceName, destinationName, sourcePlayerId, destinationPlayerId, context = {}) {
  if (sourceName !== "sideline" || destinationName !== "hand") return;
  if (sourcePlayerId !== playerId || destinationPlayerId !== playerId) return;
  const player = getPlayer(state, playerId);
  if (!player.hand.some((candidate) => candidate.uid === card.uid)) return;
  flagSidelineToHandByAbility(state, playerId);
  resolveZoneCardAbilities(state, playerId, "hand", card, TIMINGS.WHEN_SIDELINE_TO_HAND_BY_ABILITY, {
    ...context,
    triggerSourceDef: context.triggerSourceDef ?? context.sourceDef,
    card
  });
}

function resolveCharacterMovedOutsideMovementPhase(state, playerId, permanent, fromLine, toLine, context = {}) {
  if (fromLine === toLine || state.phase === PHASES.MOVEMENT) return;
  if (!isCharacter(state, permanent)) return;
  flagCharacterMoved(state, playerId, permanent, { outsideMovement: true });
  resolveFieldPermanentAbilities(state, playerId, TIMINGS.WHEN_OWN_CHARACTER_MOVES_OUTSIDE_MOVEMENT_PHASE, {
    ...context,
    movedPermanent: permanent,
    fromLine,
    toLine
  });
}

function removeFromLine(player, lineName, index) {
  const line = lineOf(player, lineName);
  assertRule(index >= 0 && index < line.length, "LINE_INDEX", "Line index is out of range.", { lineName, index });
  return line.splice(index, 1)[0];
}

function findPermanentLocation(player, permanentId) {
  for (const lineName of [LINES.FRONT, LINES.ENERGY]) {
    const index = player[lineName].findIndex((permanent) => permanent.pid === permanentId);
    if (index !== -1) return { lineName, index };
  }
  return null;
}

function lineNamesForSelector(line) {
  if (!line || line === "field") return [LINES.FRONT, LINES.ENERGY];
  if (line === "front") return [LINES.FRONT];
  if (line === "energy") return [LINES.ENERGY];
  return [line];
}

function playerIdsForSelector(playerId, selector = {}) {
  const controller = selector.controller ?? selector.player ?? "self";
  if (controller === "self") return [playerId];
  if (controller === "opponent") return [opponentOf(playerId)];
  if (controller === "any" || controller === "both") return [playerId, opponentOf(playerId)];
  return [controller];
}

function selectorMatchesForOverride(selector = {}, expected = {}) {
  if (expected.controller && (selector.controller ?? selector.player ?? "self") !== expected.controller) return false;
  if (expected.line && (selector.line ?? "field") !== expected.line) return false;
  if (expected.type && selector.type !== expected.type) return false;
  return true;
}

function legacyTargetingRestriction(keyword) {
  if (keyword === "opponentAbilityProtection") {
    return { mode: "prohibit", sourceTypes: [CARD_TYPES.CHARACTER, CARD_TYPES.EVENT, CARD_TYPES.SITE, "trigger"] };
  }
  if (keyword === "opponentAbilityTargetTax") {
    return {
      mode: "tax",
      sourceTypes: [CARD_TYPES.CHARACTER, CARD_TYPES.EVENT, CARD_TYPES.SITE, "trigger"],
      payment: { kind: "handToSideline", amount: 1 }
    };
  }
  return undefined;
}

function targetingRestrictionsForPermanent(state, permanent) {
  const restrictions = [];
  const def = topDef(state, permanent);
  if (!baseAbilitiesLost(permanent)) {
    restrictions.push(...(def.targetingRestrictions ?? []));
    for (const keyword of ["opponentAbilityProtection", "opponentAbilityTargetTax"]) {
      if (def.keywords?.[keyword]) restrictions.push(legacyTargetingRestriction(keyword));
    }
    for (const modifier of def.staticKeywordModifiers ?? []) {
      if (!staticModifierApplies(state, permanent, modifier)) continue;
      if (modifier.keyword === "targetingRestriction") restrictions.push(modifier.value);
      else if (legacyTargetingRestriction(modifier.keyword)) restrictions.push(legacyTargetingRestriction(modifier.keyword));
    }
  }
  for (const { modifier } of staticFieldKeywordModifiersForPermanent(state, permanent)) {
    if (modifier.keyword === "targetingRestriction") restrictions.push(modifier.value);
    else if (legacyTargetingRestriction(modifier.keyword)) restrictions.push(legacyTargetingRestriction(modifier.keyword));
  }
  for (const modifier of permanent.keywordModifiers ?? []) {
    if (modifier.keyword === "targetingRestriction") restrictions.push(modifier.value);
    else if (legacyTargetingRestriction(modifier.keyword)) restrictions.push(legacyTargetingRestriction(modifier.keyword));
  }
  return restrictions.filter(Boolean);
}

function abilitySourceType(context = {}) {
  if (context.sourceKind === "trigger") return "trigger";
  return context.sourceDef?.type;
}

function targetingRestrictionApplies(state, restriction, context = {}, targetPermanent) {
  const sourceType = abilitySourceType(context);
  if (restriction.sourceTypes?.length > 0 && sourceType && !restriction.sourceTypes.includes(sourceType)) return false;
  if (restriction.sourceTypes?.length > 0 && !sourceType) return true;
  if (restriction.sourceZone && context.sourceZone !== restriction.sourceZone) return false;
  if (restriction.during === "opponentTurn" && targetPermanent && state.activePlayer === targetPermanent.controller) return false;
  if (restriction.during === "controllerTurn" && targetPermanent && state.activePlayer !== targetPermanent.controller) return false;
  if (restriction.sourceRaided !== undefined) {
    const source = context.permanent;
    if (!source || (source.cards.length > 1) !== restriction.sourceRaided) return false;
  }
  if (restriction.sourceBpMin !== undefined) {
    const source = context.permanent;
    if (!source || battlePower(state, source) < restriction.sourceBpMin) return false;
  }
  return true;
}

function applicableTargetingRestrictions(state, permanent, context = {}) {
  return targetingRestrictionsForPermanent(state, permanent)
    .filter((restriction) => targetingRestrictionApplies(state, restriction, context, permanent));
}

function targetingTaxPaymentsForTarget(state, playerId, targetPlayerId, permanent, context = {}) {
  if (targetPlayerId === playerId || !permanent) return {};
  const payments = new Map();
  for (const restriction of applicableTargetingRestrictions(state, permanent, context)) {
    if (restriction.mode !== "tax") continue;
    const kind = restriction.payment?.kind;
    if (!kind) continue;
    payments.set(kind, Math.max(payments.get(kind) ?? 0, Number(restriction.payment?.amount ?? 1)));
  }
  return Object.fromEntries(payments);
}

function canPayTargetingTax(state, playerId, restriction) {
  const amount = restriction.payment?.amount ?? 1;
  if (restriction.payment?.kind === "ap") return activeAp(getPlayer(state, playerId)) >= amount;
  if (restriction.payment?.kind === "handToSideline") return getPlayer(state, playerId).hand.length >= amount;
  return false;
}

function protectedFromOpposingAbility(state, playerId, targetPlayerId, permanent, selector = {}, context = {}) {
  if (targetPlayerId === playerId || selector.ignoreProtection) return false;
  const restrictions = applicableTargetingRestrictions(state, permanent, context);
  return restrictions.some((restriction) => restriction.mode === "prohibit")
    || restrictions.some((restriction) => restriction.mode === "tax" && !canPayTargetingTax(state, playerId, restriction));
}

function payTargetingTaxes(state, playerId, targets, selector, context = {}) {
  if (selector?.ignoreProtection) return;
  const player = getPlayer(state, playerId);
  for (const target of targets) {
    if (target.playerId === playerId) continue;
    const payments = targetingTaxPaymentsForTarget(state, playerId, target.playerId, target.permanent, context);
    for (const [kind, amount] of Object.entries(payments)) {
      if (kind === "ap") {
        payAp(state, playerId, amount);
        continue;
      }
      if (kind === "handToSideline") {
        for (let paid = 0; paid < amount; paid += 1) {
          const paymentNumber = context.targetTaxPaymentCount ?? 0;
          const requestedChoice = context.choices?.targetTaxHandIndices?.[paymentNumber]
            ?? context.choices?.targetTaxHandIndex
            ?? 0;
          const requested = requestedChoice && typeof requestedChoice === "object"
            ? requestedChoice.uid
              ? player.hand.findIndex((card) => card.uid === requestedChoice.uid)
              : Number(requestedChoice.index)
            : requestedChoice;
          assertRule(requested >= 0 && requested < player.hand.length, "TARGET_TAX", "Targeting-tax hand index is out of range.", { requested });
          const card = player.hand.splice(requested, 1)[0];
          placeHandCardInZone(state, playerId, player, "sideline", card, {}, context);
          context.targetTaxPaymentCount = paymentNumber + 1;
        }
      }
    }
  }
}

function selectorBpMaximum(state, playerId, selector, context = {}) {
  let maximum = selector.bpMax;
  if (selector.bpMaxFromLastSidelined) maximum = context.lastSidelinedBp ?? -Infinity;
  if (selector.bpMaxFromChoiceKey) {
    const permanent = context.chosenTargetsByKey?.[selector.bpMaxFromChoiceKey]?.[0];
    if (permanent) maximum = battlePower(state, permanent);
  }

  for (const bonus of selector.bpMaxBonuses ?? []) {
    if (bonus.condition && !conditionMet(state, playerId, bonus.condition, context)) continue;
    if (bonus.amountPerFieldMatch !== undefined) {
      const countPlayerId = bonus.controller === "opponent" ? opponentOf(playerId) : playerId;
      const countPlayer = getPlayer(state, countPlayerId);
      const count = lineNamesForSelector(bonus.line ?? "field")
        .flatMap((lineName) => lineOf(countPlayer, lineName))
        .filter((permanent) => cardDefMatchesFilter(topDef(state, permanent), bonus.filter ?? {}))
        .length;
      maximum = Number(maximum ?? 0) + Number(bonus.amountPerFieldMatch) * count;
    } else {
      maximum = Number(maximum ?? 0) + Number(bonus.amount ?? 0);
    }
  }
  return maximum;
}

function permanentMatchesSelector(state, playerId, selector = {}, targetPlayerId, lineName, permanent, context = {}) {
  if (protectedFromOpposingAbility(state, playerId, targetPlayerId, permanent, selector, context)) return false;
  if (selector.anyOf && !selector.anyOf.some((childSelector) => permanentMatchesSelector(
    state,
    playerId,
    { ...childSelector, controller: selector.controller, line: selector.line, type: selector.type, ignoreProtection: true },
    targetPlayerId,
    lineName,
    permanent,
    context
  ))) return false;
  const def = topDef(state, permanent);
  if (!lineNamesForSelector(selector.line).includes(lineName)) return false;
  if (selector.type && def.type !== selector.type) return false;
  if (selector.rested !== undefined && permanent.rested !== selector.rested) return false;
  if (selector.active !== undefined && permanent.rested === selector.active) return false;
  if (selector.name && !cardDefHasName(def, selector.name)) return false;
  if (selector.nameIncludesAll && !cardDefNameIncludesAll(def, selector.nameIncludesAll)) return false;
  if (selector.names && !selector.names.some((name) => cardDefHasName(def, name))) return false;
  if (selector.otherThanName && cardDefHasName(def, selector.otherThanName)) return false;
  if (selector.affinity && !includesText(def.affinities, selector.affinity)) return false;
  if (selector.affinities && !def.affinities?.some((affinity) => includesText(selector.affinities, affinity))) return false;
  if (selector.withoutAffinity && includesText(def.affinities, selector.withoutAffinity)) return false;
  if (selector.hasAbilityTiming && !abilitiesOfPermanent(state, permanent).some((ability) => ability.timing === selector.hasAbilityTiming)) return false;
  if (selector.hasUnderCards && permanent.cards.length <= 1) return false;
  if (selector.hasFaceDownUnder && !permanent.cards.slice(0, -1).some((card) => card.faceUp === false)) return false;
  if (selector.noFaceDownUnder && permanent.cards.slice(0, -1).some((card) => card.faceUp === false)) return false;
  if (selector.hasReadyLock && (permanent.readyLocks ?? 0) <= 0) return false;
  if (selector.raided && permanent.cards.length <= 1) return false;
  if (selector.notRaided && permanent.cards.length > 1) return false;
  if (selector.hasRaid && !topDef(state, permanent).raid) return false;
  if (selector.withoutRaid && topDef(state, permanent).raid) return false;
  if (selector.notChosenBySourceAffinityThisTurn) {
    const affinityKey = String(selector.notChosenBySourceAffinityThisTurn).toLowerCase();
    const chosenIds = state.turnFlags?.[playerId]?.chosenPermanentIdsBySourceAffinity?.[affinityKey] ?? [];
    if (chosenIds.includes(permanent.pid)) return false;
  }
  if (selector.otherThanSource && context.permanent?.pid === permanent.pid) return false;
  if (selector.otherThanLastPlayed && context.lastPlayedPermanent?.pid === permanent.pid) return false;
  const baseBpMax = selectorBpMaximum(state, playerId, selector, context);
  const bpMax = baseBpMax !== undefined
    ? baseBpMax + Number(selector.bpMaxPerLastMovedFromHand ?? 0) * (context.lastEffectMovedFromHandCount ?? context.lastMovedFromHandCount ?? 0)
    : undefined;
  if (bpMax !== undefined && battlePower(state, permanent) > bpMax) return false;
  if (selector.bpMin !== undefined && battlePower(state, permanent) < selector.bpMin) return false;
  if (selector.energyGenerationMax !== undefined && permanentEnergyGeneration(state, permanent) > selector.energyGenerationMax) return false;
  if (selector.energyGenerationMin !== undefined && permanentEnergyGeneration(state, permanent) < selector.energyGenerationMin) return false;
  if (selector.requiredEnergyMax !== undefined && (def.requiredEnergy?.amount ?? 0) > selector.requiredEnergyMax) return false;
  if (selector.requiredEnergyMin !== undefined && (def.requiredEnergy?.amount ?? 0) < selector.requiredEnergyMin) return false;
  if (selector.color && def.color !== selector.color) return false;
  return true;
}

function notifyTargetsChosenByAbility(state, playerId, selector, targets, context = {}) {
  if (!context.sourceDef || context.suppressChosenByAbility || context.resolvingChosenByAbility) return;
  if (!selector || selector === "self" || selector.scope === "self" || selector.attacking) return;

  context.chosenByAbilityNotified ??= [];
  for (const target of targets) {
    const key = `${context.sourceDef.id ?? "source"}:${target.permanent.pid}`;
    if (context.chosenByAbilityNotified.includes(key)) continue;
    context.chosenByAbilityNotified.push(key);
    state.turnFlags ??= freshTurnFlags();
    const chosenByAffinity = state.turnFlags[playerId].chosenPermanentIdsBySourceAffinity ??= {};
    for (const affinity of context.sourceDef.affinities ?? []) {
      const affinityKey = String(affinity).toLowerCase();
      chosenByAffinity[affinityKey] ??= [];
      if (!chosenByAffinity[affinityKey].includes(target.permanent.pid)) {
        chosenByAffinity[affinityKey].push(target.permanent.pid);
      }
    }
    resolvePermanentAbilities(state, target.playerId, target.permanent, TIMINGS.WHEN_CHOSEN_BY_ABILITY, {
      ...context,
      chosenPermanent: target.permanent,
      chosenByPlayer: playerId,
      chosenBySourceDef: context.sourceDef,
      resolvingChosenByAbility: true
    });
  }
}

function selectPermanentTargets(state, playerId, selector = "self", context = {}) {
  if (context.targetingModifier?.targetOverride && typeof selector === "object"
    && selectorMatchesForOverride(selector, context.targetingModifier.from ?? {})) {
    selector = {
      ...selector,
      ...context.targetingModifier.targetOverride,
      choiceKey: selector.choiceKey
    };
  }

  if (selector === "self" || selector?.scope === "self") {
    assertRule(context.permanent, "TARGET", "This effect requires a source permanent.");
    return [{
      playerId: context.permanent.controller,
      lineName: findPermanentLocation(getPlayer(state, context.permanent.controller), context.permanent.pid)?.lineName,
      index: findPermanentLocation(getPlayer(state, context.permanent.controller), context.permanent.pid)?.index,
      permanent: context.permanent
    }];
  }

  if (selector?.attacking) {
    if (!context.attacker) return [];
    const targetPlayer = getPlayer(state, context.attacker.controller);
    const location = findPermanentLocation(targetPlayer, context.attacker.pid);
    if (!location) return [];
    const attacker = targetPlayer[location.lineName][location.index];
    if (!permanentMatchesSelector(state, playerId, selector, context.attacker.controller, location.lineName, attacker, context)) return [];
    return [{
      playerId: context.attacker.controller,
      lineName: location.lineName,
      index: location.index,
      permanent: attacker
    }];
  }

  const choiceKey = selector.choiceKey ?? "targets";
  const chosen = context.choices?.[choiceKey] ?? selector.targets;
  const min = selector.min ?? 0;
  const max = selector.max ?? selector.amount ?? Number.POSITIVE_INFINITY;
  if (Array.isArray(chosen)) {
    assertRule(chosen.length >= min && chosen.length <= max, "TARGET", "Chosen target count is outside the allowed range.", {
      choiceKey,
      selected: chosen.length,
      min,
      max
    });
    if (chosen.length === 0) {
      rememberChosenTargets(state, context, choiceKey, []);
      return [];
    }
    const targets = chosen.map((target) => {
      const targetPlayerId = target.player ?? target.playerId ?? playerId;
      const targetLineName = target.lineName ?? target.line;
      const targetPlayer = getPlayer(state, targetPlayerId);
      const targetPermanent = lineOf(targetPlayer, targetLineName)[target.index];
      assertRule(targetPermanent, "TARGET", "Chosen target does not exist.", target);
      assertRule(permanentMatchesSelector(state, playerId, selector, targetPlayerId, targetLineName, targetPermanent, context), "TARGET", "Chosen target is not legal for this effect.", {
        selector,
        target
      });
      return {
        playerId: targetPlayerId,
        lineName: targetLineName,
        index: target.index,
        permanent: targetPermanent
      };
    });
    if (selector.uniqueNames) {
      const names = new Set(targets.map((target) => topDef(state, target.permanent).name.toLowerCase()));
      assertRule(names.size === targets.length, "TARGET", "Chosen targets must have unique card names.", { choiceKey, chosen });
    }
    payTargetingTaxes(state, playerId, targets, selector, context);
    notifyTargetsChosenByAbility(state, playerId, selector, targets, context);
    rememberChosenTargets(state, context, choiceKey, targets);
    return targets;
  }

  const candidates = [];
  for (const targetPlayerId of playerIdsForSelector(playerId, selector)) {
    const targetPlayer = getPlayer(state, targetPlayerId);
    for (const lineName of lineNamesForSelector(selector.line)) {
      lineOf(targetPlayer, lineName).forEach((permanent, index) => {
        if (!permanentMatchesSelector(state, playerId, selector, targetPlayerId, lineName, permanent, context)) return;
        candidates.push({ playerId: targetPlayerId, lineName, index, permanent });
      });
    }
  }

  const legalCandidates = selector.uniqueNames
    ? candidates.filter((candidate, index) => candidates.findIndex((other) => sameText(topDef(state, other.permanent).name, topDef(state, candidate.permanent).name)) === index)
    : candidates;
  const automaticMax = Number.isFinite(max) ? max : candidates.length;
  assertRule(legalCandidates.length >= min, "TARGET", "Not enough legal targets for effect.", { selector, candidates: legalCandidates.length });
  const targets = legalCandidates.slice(0, automaticMax);
  payTargetingTaxes(state, playerId, targets, selector, context);
  notifyTargetsChosenByAbility(state, playerId, selector, targets, context);
  rememberChosenTargets(state, context, choiceKey, targets);
  return targets;
}

function rememberChosenTargets(state, context, choiceKey, targets) {
  context.chosenTargetsByKey ??= {};
  context.chosenTargetNamesByKey ??= {};
  context.chosenTargetsByKey[choiceKey] = targets.map((target) => target.permanent);
  context.chosenTargetNamesByKey[choiceKey] = targets.map((target) => topDef(state, target.permanent).name);
  context.lastChosenTargets = targets.map((target) => target.permanent);
}

function zoneOf(player, zoneName) {
  switch (zoneName) {
    case "deck":
    case "hand":
    case "life":
    case "sideline":
    case "removal":
      return player[zoneName];
    default:
      throw new Error(`Unknown zone: ${zoneName}`);
  }
}

function moveTopDeckCards(state, playerId, effect, context = {}) {
  const sourcePlayerId = effect.player === "opponent" ? opponentOf(playerId) : effect.player ?? playerId;
  const sourcePlayer = getPlayer(state, sourcePlayerId);
  const destinationPlayerId = effect.destinationPlayer === "opponent" ? opponentOf(playerId) : effect.destinationPlayer ?? sourcePlayerId;
  const destinationPlayer = getPlayer(state, destinationPlayerId);
  const destination = zoneOf(destinationPlayer, effect.destination ?? "hand");
  const count = effect.count ?? effect.amount ?? 1;

  const moved = [];
  for (let i = 0; i < count; i += 1) {
    if (sourcePlayer.deck.length === 0) break;
    const card = sourcePlayer.deck.shift();
    moved.push(card);
    if (effect.publicReveal) {
      recordCardsRevealedToOpponent(state, sourcePlayerId, [card], {
        zone: "deck",
        source: effect.kind ?? "moveTopDeck"
      });
    }
    if (effect.destination === "life") card.faceUp = Boolean(effect.faceUp);
    placeCardInZone(state, destinationPlayer, effect.destination ?? "hand", card);
    if ((effect.destination ?? "hand") === "sideline"
      && sourcePlayerId === playerId
      && destinationPlayerId === sourcePlayerId) {
      flagDeckToSidelineByAbility(state, sourcePlayerId);
      resolveZoneCardAbilities(state, sourcePlayerId, "sideline", card, TIMINGS.WHEN_SELF_DECK_TO_SIDELINE_BY_ABILITY, {
        ...context,
        card
      });
    }
  }
  context.lastMovedCards = moved;
  context.lastMovedCardCount = (context.lastMovedCardCount ?? 0) + moved.length;
}

function lookTopDeckAndMove(state, playerId, effect, context = {}) {
  const ownerId = effect.player === "opponent" ? opponentOf(playerId) : effect.player ?? playerId;
  const player = getPlayer(state, ownerId);
  const count = Math.min(effect.count ?? effect.amount ?? 1, player.deck.length);
  const looked = player.deck.splice(0, count);
  if (effect.publicReveal) {
    recordCardsRevealedToOpponent(state, ownerId, looked, {
      zone: "deck",
      source: effect.kind ?? "lookTopDeckAndMove"
    });
  }
  resolveRuntimeChoices(state, playerId, effect, context, {
    kind: "lookTopDeckAndMove",
    cards: looked,
    ownerId
  });
  const choiceKey = effect.choiceKey ?? "lookTopDeckPlacements";
  const explicitPlacements = context.choices?.[choiceKey] ?? effect.placements ?? [];
  const placements = [...(effect.defaultPlacements ?? []), ...explicitPlacements];
  const placementByIndex = new Map(placements.map((placement) => [placement.index, placement.destination]));
  if (placements.length === 0 && effect.defaultNonDefaultCount && effect.nonDefaultDestination) {
    const autoCount = Math.min(effect.defaultNonDefaultCount, looked.length);
    for (let index = 0; index < autoCount; index += 1) placementByIndex.set(index, effect.nonDefaultDestination);
  }
  const allowed = new Set(effect.destinations ?? ["top"]);
  const defaultDestination = effect.defaultDestination ?? "top";
  const topCards = [];
  const bottomCards = [];
  const destinationCounts = {};
  let nonDefaultCount = 0;

  for (const [index, card] of looked.entries()) {
    const destination = placementByIndex.get(index) ?? defaultDestination;
    assertRule(allowed.has(destination), "DECK_PLACEMENT", "Deck placement destination is not allowed.", {
      destination,
      allowed: [...allowed]
    });
    destinationCounts[destination] = (destinationCounts[destination] ?? 0) + 1;
    if (destination !== defaultDestination) nonDefaultCount += 1;
    if (destination === "top") {
      if (effect.faceUpOnTop) card.faceUp = true;
      topCards.push(card);
    }
    else if (destination === "bottom") bottomCards.push(card);
    else if (destination === "underSelf") {
      assertRule(context.permanent, "EFFECT_SOURCE", "Placing looked cards under self requires a source permanent.");
      card.faceUp = effect.faceUp ?? false;
      const topIndex = Math.max(0, context.permanent.cards.length - 1);
      context.permanent.cards.splice(topIndex, 0, card);
    }
    else {
      placeCardInZone(state, player, destination, card);
      if (destination === "sideline" && ownerId === playerId) {
        flagDeckToSidelineByAbility(state, ownerId);
        resolveZoneCardAbilities(state, ownerId, "sideline", card, TIMINGS.WHEN_SELF_DECK_TO_SIDELINE_BY_ABILITY, {
          ...context,
          card
        });
      }
    }
  }

  if (effect.maxNonDefault !== undefined) {
    assertRule(nonDefaultCount <= effect.maxNonDefault, "DECK_PLACEMENT", "Too many cards placed outside the default destination.", {
      max: effect.maxNonDefault,
      count: nonDefaultCount
    });
  }
  if (effect.minNonDefault !== undefined) {
    const min = Math.min(effect.minNonDefault, looked.length);
    assertRule(nonDefaultCount >= min, "DECK_PLACEMENT", "Not enough cards placed outside the default destination.", {
      min,
      count: nonDefaultCount
    });
  }
  for (const [destination, max] of Object.entries(effect.maxDestinations ?? {})) {
    assertRule((destinationCounts[destination] ?? 0) <= max, "DECK_PLACEMENT", "Too many cards placed in a destination.", {
      destination,
      max,
      count: destinationCounts[destination] ?? 0
    });
  }
  const minEntries = Object.entries(effect.minDestinations ?? {});
  const totalMinimum = minEntries.reduce((sum, [, min]) => sum + min, 0);
  if (looked.length >= totalMinimum) {
    for (const [destination, min] of minEntries) {
      assertRule((destinationCounts[destination] ?? 0) >= min, "DECK_PLACEMENT", "Not enough cards placed in a destination.", {
        destination,
        min,
        count: destinationCounts[destination] ?? 0
      });
    }
  }

  const orderedTop = orderCardsByChoice(
    topCards,
    context.choices?.[effect.topOrderChoiceKey ?? "lookTopOrder"],
    { code: "DECK_PLACEMENT", label: "looked-card top order" }
  );
  const orderedBottom = orderCardsByChoice(
    bottomCards,
    context.choices?.[effect.bottomOrderChoiceKey ?? "lookBottomOrder"],
    { code: "DECK_PLACEMENT", label: "looked-card bottom order" }
  );
  player.deck.unshift(...orderedTop);
  player.deck.push(...orderedBottom);
}

function lookTopDeckPlayOneAndMoveRest(state, playerId, effect, context = {}) {
  const player = getPlayer(state, playerId);
  const count = Math.min(effect.count ?? effect.amount ?? 1, player.deck.length);
  const looked = player.deck.splice(0, count);
  resolveRuntimeChoices(state, playerId, effect, context, {
    kind: "lookTopDeckPlayOneAndMoveRest",
    cards: looked,
    ownerId: playerId
  });
  const choice = context.choices?.[effect.choiceKey ?? "lookPlayIndex"];
  const selectedIndex = Number.isInteger(choice)
    ? choice
    : looked.findIndex((card) => zoneCardMatchesPlayFilter(state, playerId, card, effect.filter ?? {}));
  let selected;

  if (selectedIndex >= 0 && selectedIndex < looked.length) {
    const card = looked[selectedIndex];
    if (zoneCardMatchesPlayFilter(state, playerId, card, effect.filter ?? {})) {
      selected = looked.splice(selectedIndex, 1)[0];
    }
  }

  if (selected) {
    const cardDef = defOf(state, selected);
    const raidChoice = context.choices?.[effect.raidChoiceKey ?? "performRaid"];
    const raidTarget = context.choices?.[effect.raidTargetChoiceKey ?? "raidTarget"] ?? defaultRaidTargetForCard(state, playerId, cardDef, { sourceKind: context.sourceKind });
    const shouldRaid = effect.allowRaid && cardDef.raid && raidTarget && raidChoice !== false
      && raidUseConditionMet(state, playerId, cardDef, { sourceKind: context.sourceKind });
    if (shouldRaid) {
      const lineName = raidTarget.lineName ?? raidTarget.line ?? LINES.FRONT;
      const target = lineOf(player, lineName)[raidTarget.index];
      assertRule(target, "RAID_TARGET", "Raid target does not exist.");
      assertRule(matchesRaidRequirement(state, cardDef.raid, target, { raidCardDef: cardDef, sourceKind: context.sourceKind }), "RAID_TARGET", "Raid target does not match this card's Raid requirement.");
      const raidedDef = topDef(state, target);
      resetPermanentForRaid(target);
      target.cards.push(selected);
      readyPermanent(target);
      rememberPlayedPermanent(context, target, playerId);
      resolvePermanentAbilities(state, playerId, target, TIMINGS.WHEN_PLAYED, { permanent: target, raid: true, choices: context.choices, playedByAbility: true });
      resolveRaidedAbilities(state, playerId, target, raidedDef, { permanent: target, raid: true, choices: context.choices });
    } else {
      const permanent = createPermanent(state, playerId, selected, effect.rested ?? true);
      insertPermanent(state, playerId, effect.destinationLine ?? LINES.FRONT, permanent, context.choices?.[effect.replaceChoiceKey ?? "replaceIndex"], {
        operation: "play",
        choices: context.choices
      });
      rememberPlayedPermanent(context, permanent, playerId);
      if (!context.suppressPlayedAbilities && !effect.suppressPlayedAbilities) {
        resolvePermanentAbilities(state, playerId, permanent, TIMINGS.WHEN_PLAYED, { permanent, choices: context.choices, playedByAbility: true });
      }
    }
  }

  const remainingDestination = effect.remainingDestination ?? "bottom";
  const orderedRemaining = orderCardsByChoice(
    looked,
    context.choices?.[effect.remainingOrderChoiceKey ?? "lookRemainingOrder"],
    { code: "DECK_PLACEMENT", label: "remaining looked-card order" }
  );
  if (remainingDestination === "top") {
    player.deck.unshift(...orderedRemaining);
  } else if (remainingDestination === "bottom") {
    player.deck.push(...orderedRemaining);
  } else {
    for (const card of orderedRemaining) {
      placeCardInZone(state, player, remainingDestination, card);
      if (remainingDestination === "sideline") {
        flagDeckToSidelineByAbility(state, playerId);
        resolveZoneCardAbilities(state, playerId, "sideline", card, TIMINGS.WHEN_SELF_DECK_TO_SIDELINE_BY_ABILITY, {
          ...context,
          card
        });
      }
    }
  }
}

function revealTopDeckOptionalPlayOrRaidInstead(state, playerId, effect, context = {}) {
  const player = getPlayer(state, playerId);
  if (player.deck.length === 0) return;
  const card = player.deck.shift();
  card.faceUp = true;
  recordCardsRevealedToOpponent(state, playerId, [card], {
    zone: "deck",
    source: effect.kind ?? "revealTopDeckOptionalPlayOrRaidInstead"
  });
  resolveRuntimeChoices(state, playerId, effect, context, {
    kind: "revealTopDeckOptionalPlayOrRaidInstead",
    cards: [card],
    ownerId: playerId
  });
  const matches = zoneCardMatchesPlayFilter(state, playerId, card, effect.filter ?? {});
  const choice = context.choices?.[effect.choiceKey ?? "optionalRevealPlay"];
  const canPay = !effect.costEffect || canPayEffectCost(state, playerId, effect.costEffect);

  if (matches && choice !== false && canPay) {
    if (effect.costEffect) resolveEffect(state, playerId, effect.costEffect, context);
    card.faceUp = true;
    const cardDef = defOf(state, card);
    const raidChoice = context.choices?.[effect.raidChoiceKey ?? "performRaid"];
    const raidTarget = context.choices?.[effect.raidTargetChoiceKey ?? "raidTarget"] ?? defaultRaidTargetForCard(state, playerId, cardDef, { sourceKind: context.sourceKind });
    const shouldRaid = effect.allowRaid && cardDef.raid && raidTarget && raidChoice !== false
      && raidUseConditionMet(state, playerId, cardDef, { sourceKind: context.sourceKind });

    if (shouldRaid) {
      const lineName = raidTarget.lineName ?? raidTarget.line ?? LINES.FRONT;
      const target = lineOf(player, lineName)[raidTarget.index];
      assertRule(target, "RAID_TARGET", "Raid target does not exist.");
      assertRule(matchesRaidRequirement(state, cardDef.raid, target, { raidCardDef: cardDef, sourceKind: context.sourceKind }), "RAID_TARGET", "Raid target does not match this card's Raid requirement.");
      const raidedDef = topDef(state, target);
      resetPermanentForRaid(target);
      target.cards.push(card);
      readyPermanent(target);
      rememberPlayedPermanent(context, target, playerId);
      resolvePermanentAbilities(state, playerId, target, TIMINGS.WHEN_PLAYED, { permanent: target, raid: true, choices: context.choices, playedByAbility: true });
      resolveRaidedAbilities(state, playerId, target, raidedDef, { permanent: target, raid: true, choices: context.choices });
      return;
    }

    const permanent = createPermanent(state, playerId, card, effect.rested ?? true);
    insertPermanent(state, playerId, effect.destinationLine ?? LINES.FRONT, permanent, context.choices?.[effect.replaceChoiceKey ?? "replaceIndex"], {
      operation: "play",
      choices: context.choices
    });
    rememberPlayedPermanent(context, permanent, playerId);
    if (!context.suppressPlayedAbilities && !effect.suppressPlayedAbilities) {
      resolvePermanentAbilities(state, playerId, permanent, TIMINGS.WHEN_PLAYED, { permanent, choices: context.choices, playedByAbility: true });
    }
    return;
  }

  const destination = context.choices?.[effect.placementChoiceKey ?? "revealedPlacement"] ?? effect.defaultDestination ?? "top";
  assertRule((effect.destinations ?? ["top", "bottom"]).includes(destination), "DECK_PLACEMENT", "Deck placement destination is not allowed.", {
    destination,
    allowed: effect.destinations ?? ["top", "bottom"]
  });
  if (destination === "bottom") player.deck.push(card);
  else player.deck.unshift(card);
}

function moveHandCardsToZone(state, playerId, effect, context = {}) {
  context.lastEffectMovedFromHandCount = 0;
  const player = getPlayer(state, playerId);
  const count = effect.count ?? effect.amount ?? 1;
  const indices = context.choices?.[effect.choiceKey ?? "handIndices"] ?? effect.indices ?? (
    effect.filter
      ? player.hand
        .map((card, index) => ({ card, index }))
        .filter(({ card }) => cardMatchesFilter(state, card, effect.filter))
        .slice(0, count)
        .map(({ index }) => index)
      : [...Array(count).keys()]
  );
  const min = effect.min ?? count;
  assertRule(indices.length >= min && indices.length <= count, "HAND_SELECTION", "Effect requires a legal hand selection count.", { min, count, indices });
  const positionChoices = context.choices?.[effect.positionChoiceKey ?? "handDeckPositions"];
  const allowedPositions = effect.positions ? new Set(effect.positions) : undefined;

  const sortedSelections = indices
    .map((index, selectionOffset) => ({ index, selectionOffset }))
    .sort((a, b) => b.index - a.index);
  for (const { selectionOffset, index } of sortedSelections) {
    assertRule(index >= 0 && index < player.hand.length, "HAND_INDEX", "Hand index is out of range.", { index });
    assertRule(!effect.filter || cardMatchesFilter(state, player.hand[index], effect.filter), "HAND_SELECTION", "Selected hand card does not match effect filter.", {
      index,
      filter: effect.filter
    });
    const moved = player.hand.splice(index, 1)[0];
    const choicePosition = Array.isArray(positionChoices)
      ? positionChoices[selectionOffset]
      : typeof positionChoices === "string" ? positionChoices : undefined;
    const position = choicePosition ?? effect.defaultPosition ?? effect.position;
    const destinationChoices = context.choices?.[effect.destinationChoiceKey ?? "handDestinations"];
    const destinationName = Array.isArray(destinationChoices)
      ? destinationChoices[selectionOffset] ?? effect.destination ?? "sideline"
      : typeof destinationChoices === "string" ? destinationChoices : effect.destination ?? "sideline";
    const allowedDestinations = effect.destinations ? new Set(effect.destinations) : undefined;
    assertRule(!allowedDestinations || allowedDestinations.has(destinationName), "HAND_SELECTION", "Selected hand destination is not legal for this effect.", {
      destination: destinationName,
      allowed: allowedDestinations ? [...allowedDestinations] : undefined
    });
    assertRule(!allowedPositions || allowedPositions.has(position), "HAND_SELECTION", "Selected deck position is not legal for this effect.", {
      position,
      allowed: allowedPositions ? [...allowedPositions] : undefined
    });
    placeHandCardInZone(state, playerId, player, destinationName, moved, { position }, context);
  }
  context.lastMovedFromHandCount = (context.lastMovedFromHandCount ?? 0) + indices.length;
  context.lastEffectMovedFromHandCount = indices.length;
}

function cardMatchesFilter(state, cardRef, filter = {}) {
  return cardDefMatchesFilter(defOf(state, cardRef), filter);
}

function cardMatchesEffectFilter(state, cardRef, filter = {}, context = {}) {
  if (!cardMatchesFilter(state, cardRef, filter)) return false;
  if (filter.differentNameFromChoiceKey) {
    const names = context.chosenTargetNamesByKey?.[filter.differentNameFromChoiceKey] ?? [];
    if (names.some((name) => cardDefHasName(defOf(state, cardRef), name))) return false;
  }
  return true;
}

function orderCardsByChoice(cards, order, { code = "DECK_ORDER", label = "deck-card order" } = {}) {
  if (!Array.isArray(order)) return cards;
  assertRule(order.length === cards.length, code, `The ${label} must include every card exactly once.`, {
    expected: cards.length,
    order
  });
  const indices = order.map((choice) => {
    if (choice?.uid) return cards.findIndex((card) => card.uid === choice.uid);
    if (choice && typeof choice === "object") return Number(choice.index);
    return Number(choice);
  });
  assertRule(indices.every((index) => Number.isInteger(index) && index >= 0 && index < cards.length), code, `The ${label} contains an unknown card.`, {
    cards: cards.length,
    order
  });
  assertRule(new Set(indices).size === cards.length, code, `The ${label} cannot repeat a card.`, { order });
  return indices.map((index) => cards[index]);
}

function searchTopDeckCards(state, playerId, effect, context = {}) {
  const player = getPlayer(state, playerId);
  const rawCount = effect.countIf && conditionMet(state, playerId, effect.countIf.condition, context)
    ? effect.countIf.count
    : effect.count ?? effect.amount ?? 1;
  const count = Math.min(rawCount, player.deck.length);
  const looked = player.deck.splice(0, count);
  resolveRuntimeChoices(state, playerId, effect, context, {
    kind: "searchTopDeck",
    cards: looked,
    ownerId: playerId
  });
  const max = effect.max ?? effect.amount ?? 1;
  const choiceKey = effect.choiceKey ?? "searchIndices";
  const selectedIndices = context.choices?.[choiceKey] ?? looked
    .map((card, index) => ({ card, index }))
    .filter(({ card }) => cardMatchesFilter(state, card, effect.filter))
    .slice(0, max)
    .map(({ index }) => index);

  assertRule(selectedIndices.length <= max, "SEARCH_SELECTION", "Too many cards selected from top-deck search.", {
    max,
    selectedIndices
  });
  assertRule(new Set(selectedIndices).size === selectedIndices.length, "SEARCH_SELECTION", "A top-deck search card cannot be selected more than once.", {
    selectedIndices
  });
  for (const index of selectedIndices) {
    assertRule(Number.isInteger(index) && index >= 0 && index < looked.length, "SEARCH_SELECTION", "Selected top-deck search index is out of range.", {
      index,
      looked: looked.length
    });
  }
  if (effect.uniqueNames) {
    const names = new Set(selectedIndices.map((index) => defOf(state, looked[index]).name.toLowerCase()));
    assertRule(names.size === selectedIndices.length, "SEARCH_SELECTION", "Selected search cards must have unique card names.", {
      selectedIndices
    });
  }

  const selected = new Set(selectedIndices);
  const destination = zoneOf(player, effect.destination ?? "hand");
  const remaining = [];
  context.lastSearchSelectedCount = selectedIndices.length;
  context.lastSearchSelectedCards = selectedIndices.map((index) => looked[index]).filter(Boolean);
  if (effect.publicReveal) {
    recordCardsRevealedToOpponent(state, playerId, looked, {
      zone: "deck",
      source: effect.kind ?? "searchTopDeck"
    });
  }
  looked.forEach((card, index) => {
    if (selected.has(index)) {
      assertRule(cardMatchesFilter(state, card, effect.filter), "SEARCH_SELECTION", "Selected card does not match search filter.", {
        index,
        filter: effect.filter
      });
      if (effect.revealSelected && !effect.publicReveal) {
        recordCardsRevealedToOpponent(state, playerId, [card], {
          zone: "deck",
          source: effect.kind ?? "searchTopDeck"
        });
      }
      destination.push(card);
      const alternative = effect.selectedAlternative;
      const alternativeChoice = context.choices?.[alternative?.choiceKey ?? "searchPlayInstead"];
      if (alternative
        && alternativeChoice !== false
        && zoneCardMatchesPlayFilter(state, playerId, card, alternative.filter ?? {})) {
        const selectedIndex = destination.length - 1;
        const internalChoiceKey = `__searchAlternativeIndex${index}`;
        playOrRaidCardFromZone(state, playerId, {
          ...alternative,
          zones: [effect.destination ?? "hand"],
          choiceKey: internalChoiceKey,
          keepInZoneIfCannotPlay: true
        }, {
          ...context,
          choices: { ...context.choices, [internalChoiceKey]: selectedIndex }
        });
      }
    } else {
      remaining.push(card);
    }
  });

  if (effect.remainingDestinations || (effect.remainingDestination && effect.remainingDestination !== "bottom")) {
    const allowed = effect.remainingDestinations ? new Set(effect.remainingDestinations) : undefined;
    const choices = context.choices?.[effect.remainingDestinationChoiceKey ?? "searchRemainingDestinations"];
    const topCards = [];
    const bottomCards = [];
    for (const [index, card] of remaining.entries()) {
      const remainingDestination = Array.isArray(choices)
        ? choices[index] ?? effect.remainingDestination ?? effect.defaultRemainingDestination ?? "bottom"
        : typeof choices === "string" ? choices : effect.remainingDestination ?? effect.defaultRemainingDestination ?? "bottom";
      assertRule(!allowed || allowed.has(remainingDestination), "SEARCH_REMAINING_DESTINATION", "Remaining search-card destination is not allowed.", {
        destination: remainingDestination,
        allowed: allowed ? [...allowed] : undefined
      });
      if (remainingDestination === "top") {
        topCards.push(card);
      } else if (remainingDestination === "bottom") {
        bottomCards.push(card);
      } else {
        placeCardInZone(state, player, remainingDestination, card);
      }
      if (remainingDestination === "sideline") {
        flagDeckToSidelineByAbility(state, playerId);
        resolveZoneCardAbilities(state, playerId, "sideline", card, TIMINGS.WHEN_SELF_DECK_TO_SIDELINE_BY_ABILITY, {
          ...context,
          card
        });
      }
    }
    const orderedTop = orderCardsByChoice(
      topCards,
      context.choices?.[effect.topOrderChoiceKey ?? "searchTopOrder"],
      { code: "SEARCH_ORDER", label: "top-deck search order" }
    );
    const orderedBottom = orderCardsByChoice(
      bottomCards,
      context.choices?.[effect.bottomOrderChoiceKey ?? "bottomOrder"],
      { code: "SEARCH_ORDER", label: "bottom-deck search order" }
    );
    player.deck.unshift(...orderedTop);
    player.deck.push(...orderedBottom);
  } else {
    const order = context.choices?.[effect.bottomOrderChoiceKey ?? "bottomOrder"];
    player.deck.push(...orderCardsByChoice(remaining, order, {
      code: "SEARCH_ORDER",
      label: "bottom-deck search order"
    }));
  }
}

function mutateTargetsInReverse(targets, callback) {
  const sorted = [...targets].sort((a, b) => {
    if (a.playerId !== b.playerId) return a.playerId.localeCompare(b.playerId);
    if (a.lineName !== b.lineName) return a.lineName.localeCompare(b.lineName);
    return b.index - a.index;
  });
  for (const target of sorted) callback(target);
}

function movePermanentCardsToZone(state, permanent, zoneName, { sidelined = false } = {}) {
  const owner = getPlayer(state, permanent.owner);
  const top = topCard(permanent);
  const underCards = permanent.cards.slice(0, -1);
  const returnUnderCardsToHand = zoneName === "hand" && Boolean(topDef(state, permanent).returnRaidStackToHandOnReturn);
  if (sidelined && topDef(state, permanent).type === CARD_TYPES.CHARACTER) {
    flagCharacterSidelined(state, permanent.controller);
  }

  placeCardInZone(state, owner, zoneName, top);
  if (underCards.length > 0 && zoneName !== "sideline" && !returnUnderCardsToHand) {
    for (const underCard of underCards) placeCardInZone(state, owner, "sideline", underCard);
    state.log.push(`Underlying raid cards from ${permanent.pid} were placed into ${permanent.owner}'s sideline.`);
  } else {
    for (const underCard of underCards) placeCardInZone(state, owner, zoneName, underCard);
  }

  resolvePermanentAbilities(state, permanent.controller, permanent, TIMINGS.WHEN_LEAVES_FIELD, { permanent });
  if (sidelined) {
    resolvePermanentAbilities(state, permanent.controller, permanent, TIMINGS.WHEN_SIDELINED, { permanent });
  }
  if (zoneName === "hand") {
    resolvePermanentAbilities(state, permanent.controller, permanent, TIMINGS.WHEN_RETURNED_TO_HAND, { permanent });
  }
}

function totalRemovalCount(state) {
  return PLAYERS.reduce((total, playerId) => total + getPlayer(state, playerId).removal.length, 0);
}

function moveReplacementHandCardToSideline(state, playerId, sourceDef, choices = {}, choiceKey = "replacementHandIndex") {
  const player = getPlayer(state, playerId);
  if (player.hand.length === 0) return false;
  const selectedIndex = choices[choiceKey] ?? 0;
  assertRule(selectedIndex >= 0 && selectedIndex < player.hand.length, "HAND_INDEX", "Replacement hand index is out of range.", {
    selectedIndex
  });
  const card = player.hand.splice(selectedIndex, 1)[0];
  placeHandCardInZone(state, playerId, player, "sideline", card, {}, { sourceDef });
  return true;
}

function resetPermanentAfterRaidTopLeaves(permanent) {
  permanent.bpDelta = 0;
  permanent.bpModifiers = [];
  permanent.keywordModifiers = [];
  permanent.energyModifiers = [];
  permanent.gainedAbilities = [];
  permanent.readyLocks = 0;
  permanent.usedOncePerTurn = [];
}

function resetPermanentForRaid(permanent) {
  resetPermanentAfterRaidTopLeaves(permanent);
  permanent.attacksThisTurn = 0;
  permanent.blocksThisTurn = 0;
  permanent.playedThisTurn = true;
}

function sourceIsOpponent(sourcePlayer, playerId) {
  return sourcePlayer && sourcePlayer !== playerId;
}

function permanentZoneMovePreventedByAbility(state, playerId, permanent, zoneName, options = {}) {
  if (!options.byAbility) return false;
  const def = topDef(state, permanent);
  if (sourceIsOpponent(options.sourcePlayer, playerId) && def.opponentAbilityRemovalProtection) return true;
  if (zoneName === "hand" && def.abilityReturnToHandProtection) return true;
  const action = zoneName === "hand" ? "returnToHand" : zoneName === "sideline" ? "sideline" : "leaveField";
  if (abilityActionPreventedByAbility(state, playerId, permanent, action, options)) return true;
  return false;
}

function abilityProtectionRulesForPermanent(state, permanent) {
  const rules = baseAbilitiesLost(permanent) ? [] : [...(topDef(state, permanent).abilityProtections ?? [])];
  for (const modifier of permanent.keywordModifiers ?? []) {
    if (modifier.keyword !== "abilityProtection") continue;
    rules.push(modifier.value ?? { actions: ["sideline", "bpReduction"], source: "any" });
  }
  return rules;
}

function abilityActionPreventedByAbility(state, targetPlayerId, permanent, action, context = {}) {
  const sourcePlayer = context.sourcePlayer;
  const sourceType = context.sourceKind === "trigger" ? "trigger" : context.sourceDef?.type;
  return abilityProtectionRulesForPermanent(state, permanent).some((rule) => {
    if (!(rule.actions ?? []).includes(action) && !(rule.actions ?? []).includes("leaveField")) return false;
    if (rule.source === "opponent" && (!sourcePlayer || sourcePlayer === targetPlayerId)) return false;
    if (rule.sourceTypes?.length > 0 && sourceType && !rule.sourceTypes.includes(sourceType)) return false;
    if (rule.during === "opponentTurn" && state.activePlayer === targetPlayerId) return false;
    if (rule.during === "controllerTurn" && state.activePlayer !== targetPlayerId) return false;
    return true;
  });
}

function resolveTargetSidelinedWatchers(state, permanent) {
  const consumed = new Set();
  for (const effect of state.continuousEffects ?? []) {
    if (effect.kind !== "targetSidelinedZoneMove" && effect.kind !== "targetSidelinedEffect") continue;
    if (!(effect.targetPermanentIds ?? []).includes(permanent.pid)) continue;
    if (effect.kind === "targetSidelinedZoneMove") {
      const controller = getPlayer(state, effect.controller);
      const source = zoneOf(controller, effect.source ?? "sideline");
      const index = source.findIndex((card) => cardMatchesFilter(state, card, effect.filter ?? {}));
      if (index !== -1) {
        const sourceName = effect.source ?? "sideline";
        const destinationName = effect.destination ?? "hand";
        const moved = source.splice(index, 1)[0];
        zoneOf(controller, destinationName).push(moved);
        resolveSidelineToHandByAbility(state, effect.controller, moved, sourceName, destinationName, effect.controller, effect.controller);
      }
    } else if (effect.effect) {
      resolveEffect(state, effect.controller, effect.effect);
    }
    consumed.add(effect.id);
  }
  if (consumed.size > 0) {
    state.continuousEffects = state.continuousEffects.filter((effect) => !consumed.has(effect.id));
  }
}

function removePermanentToZone(state, playerId, lineName, index, zoneName, options) {
  const player = getPlayer(state, playerId);
  const current = lineOf(player, lineName)[index];
  if (!current) return undefined;
  const currentDef = topDef(state, current);
  const choices = options?.choices ?? {};
  const sourcePlayer = options?.sourcePlayer ?? state.activePlayer;

  if (permanentZoneMovePreventedByAbility(state, playerId, current, zoneName, options)) {
    state.log.push(`${currentDef.name} remained on the field because it is protected from that ability.`);
    return undefined;
  }

  if (zoneName === "hand"
    && currentDef.returnToHandHandSidelineInstead
    && state.activePlayer === playerId
    && moveReplacementHandCardToSideline(state, playerId, currentDef, choices)) {
    state.log.push(`${playerId} kept ${currentDef.name} on the field by placing a card from hand into sideline instead.`);
    return current;
  }

  if (currentDef.topRaidCardToSidelineInsteadOnOpponentLeave
    && sourceIsOpponent(sourcePlayer, playerId)
    && current.cards.length > 1) {
    const baseCard = current.cards.at(-2);
    const baseRequiredEnergy = baseCard ? (defOf(state, baseCard).requiredEnergy?.amount ?? 0) : 0;
    if (baseRequiredEnergy >= (currentDef.topRaidReplacementBaseRequiredEnergyMin ?? 0)
      && moveReplacementHandCardToSideline(state, playerId, currentDef, choices)) {
      const card = current.cards.pop();
      placeCardInZone(state, getPlayer(state, card.owner), "sideline", card);
      resetPermanentAfterRaidTopLeaves(current);
      state.log.push(`${playerId} placed the top Raid card from ${currentDef.name} into sideline instead of it leaving the field.`);
      return current;
    }
  }

  if (options?.byAbility
    && !options?.suppressNamedLeaveReplacement
    && sourceIsOpponent(sourcePlayer, playerId)) {
    const candidates = [];
    for (const candidateLine of [LINES.FRONT, LINES.ENERGY]) {
      lineOf(player, candidateLine).forEach((permanent, candidateIndex) => {
        if (permanent.pid === current.pid || baseAbilitiesLost(permanent)) return;
        const replacement = topDef(state, permanent).opponentAbilityLeaveReplacement;
        if (!replacement || !cardDefHasName(currentDef, replacement.protectedName)) return;
        if (replacement.line && replacement.line !== candidateLine) return;
        if (replacement.requiresActive && permanent.rested) return;
        if (replacement.during === "controllerTurn" && state.activePlayer !== playerId) return;
        candidates.push({ lineName: candidateLine, index: candidateIndex, permanent });
      });
    }
    const replacementChoice = choices.namedLeaveReplacement;
    if (candidates.length > 0 && replacementChoice !== false && replacementChoice !== "decline") {
      const selected = Number.isInteger(replacementChoice) ? candidates[replacementChoice] : candidates[0];
      if (selected) {
        removePermanentToZone(state, playerId, selected.lineName, selected.index, "sideline", {
          sidelined: true,
          sourcePlayer: playerId,
          byAbility: true,
          suppressNamedLeaveReplacement: true,
          choices
        });
        state.log.push(`${playerId} sidelined ${topDef(state, selected.permanent).name} instead of ${currentDef.name} leaving the field.`);
        return current;
      }
    }
  }

  if (zoneName === "sideline"
    && options?.sidelined
    && lineName === LINES.FRONT
    && !options?.suppressGoreinuReplacement
    && currentDef.name?.toLowerCase().includes("goreinu")
    && battlePower(state, current) >= 500) {
    const replacementIndex = player.energyLine.findIndex((permanent) => topDef(state, permanent).sidelineInsteadForFrontGoreinu);
    if (replacementIndex !== -1) {
      removePermanentToZone(state, playerId, LINES.ENERGY, replacementIndex, "sideline", {
        sidelined: true,
        sourcePlayer,
        byAbility: options?.byAbility,
        suppressGoreinuReplacement: true,
        choices
      });
      const moved = removeFromLine(player, lineName, index);
      insertPermanent(state, playerId, LINES.ENERGY, moved, undefined, { operation: "move", choices });
      resolveCharacterMovedOutsideMovementPhase(state, playerId, moved, LINES.FRONT, LINES.ENERGY, { choices });
      state.log.push(`${playerId} sidelined White Goreinu instead and moved ${currentDef.name} to the energy line.`);
      return moved;
    }
  }

  if (currentDef.moveToEnergyInsteadOnOpponentAbilityLeave
    && options?.byAbility
    && lineName === LINES.FRONT
    && zoneName !== LINES.ENERGY
    && sourceIsOpponent(sourcePlayer, playerId)
    && player.energyLine.length < lineCapacity(state, playerId, LINES.ENERGY)) {
    const moved = removeFromLine(player, lineName, index);
    insertPermanent(state, playerId, LINES.ENERGY, moved, undefined, { operation: "move", choices });
    resolveCharacterMovedOutsideMovementPhase(state, playerId, moved, LINES.FRONT, LINES.ENERGY, { choices });
    state.log.push(`${playerId} moved ${currentDef.name} to the energy line instead of it leaving the field.`);
    return moved;
  }

  if (zoneName === "sideline"
    && options?.sidelined
    && current?.cards.length > 1
    && currentDef.sidelineTopRaidCardInstead) {
    const card = current.cards.pop();
    placeCardInZone(state, getPlayer(state, card.owner), "sideline", card);
    resetPermanentAfterRaidTopLeaves(current);
    return current;
  }
  const permanent = removeFromLine(player, lineName, index);
  movePermanentCardsToZone(state, permanent, zoneName, options);
  if (zoneName === "sideline" && options?.sidelined && topDef(state, permanent).type === CARD_TYPES.CHARACTER) {
    resolveFieldPermanentAbilities(state, playerId, TIMINGS.WHEN_OWN_CHARACTER_SIDELINED, {
      sidelinedPermanent: permanent,
      sidelinedLine: lineName
    });
    resolveFieldPermanentAbilities(state, opponentOf(playerId), TIMINGS.WHEN_OPPONENT_CHARACTER_SIDELINED, {
      sidelinedPermanent: permanent,
      sidelinedLine: lineName
    });
  }
  if (zoneName === "sideline") resolveTargetSidelinedWatchers(state, permanent);
  return permanent;
}

function makeRoomOnLine(state, playerId, lineName, replaceIndex) {
  const player = getPlayer(state, playerId);
  const line = lineOf(player, lineName);
  const capacity = lineCapacity(state, playerId, lineName);
  if (line.length < capacity) return { removed: undefined, removalDelta: 0 };

  const selectedIndex = replaceIndex === undefined ? undefined : overflowChoiceIndex(line, replaceIndex);
  assertRule(Number.isInteger(selectedIndex), "LINE_FULL", "A full line requires a replacement index.", {
    playerId,
    lineName,
    capacity
  });
  assertRule(line.length > 0, "LINE_FULL", "No cards can be placed on this line while its capacity is zero.", {
    playerId,
    lineName,
    capacity
  });
  const removalBefore = totalRemovalCount(state);
  assertRule(selectedIndex >= 0 && selectedIndex < line.length, "LINE_FULL", "The chosen line replacement does not exist.", {
    playerId,
    lineName,
    selectedIndex
  });
  const removed = removePermanentToZone(state, playerId, lineName, selectedIndex, "removal", { sidelined: false });
  return { removed, removalDelta: totalRemovalCount(state) - removalBefore };
}

function lineCapacity(state, playerId, lineName) {
  const player = getPlayer(state, playerId);
  let capacity = MAX_LINE_SIZE;
  for (const source of [...player.frontLine, ...player.energyLine]) {
    if (baseAbilitiesLost(source)) continue;
    for (const modifier of topDef(state, source).lineCapacityModifiers ?? []) {
      if (modifier.line !== lineName || !staticModifierApplies(state, source, modifier)) continue;
      capacity += Number(modifier.amount ?? 0);
    }
  }
  return Math.max(0, capacity);
}

function maximumHandSize(state, playerId) {
  const player = getPlayer(state, playerId);
  let maximum = MAX_HAND_AT_END;
  for (const source of [...player.frontLine, ...player.energyLine]) {
    if (baseAbilitiesLost(source)) continue;
    maximum = Math.max(maximum, Number(topDef(state, source).maximumHandSize ?? maximum));
  }
  return maximum;
}

function hasFreeExtraDraw(state, playerId) {
  return getPlayer(state, playerId).frontLine.some((permanent) => (
    !baseAbilitiesLost(permanent) && topDef(state, permanent).freeExtraDrawFromFrontLine
  ));
}

function cardCanEnterLine(state, playerId, cardDef, lineName, options = {}) {
  const operation = options.operation ?? "place";
  if (operation === "play" && cardDef.raidOnlyPlay) return false;
  if (lineName === LINES.FRONT) {
    if (cardDef.frontLineEntryCondition
      && !conditionMet(state, playerId, cardDef.frontLineEntryCondition, { permanent: options.permanent })) return false;
    if (cardDef.cannotEnterFrontLine) return false;
    if (operation === "play" && cardDef.cannotPlayToFrontLine) return false;
    if ((operation === "move" || operation === "movementPhase") && cardDef.frontLineMoveByOwnAbilityOnly
      && options.sourcePermanent?.pid !== options.permanent?.pid) return false;
  }
  if (lineName === LINES.ENERGY) {
    if (cardDef.cannotEnterEnergyLine) return false;
    if (operation === "play" && cardDef.cannotPlayToEnergyLine) return false;
  }
  if (operation === "movementPhase" && cardDef.cannotMoveDuringMovementPhase) return false;
  return true;
}

function permanentCanEnterLine(state, playerId, permanent, lineName, options = {}) {
  return cardCanEnterLine(state, playerId, topDef(state, permanent), lineName, { ...options, permanent });
}

function overflowChoiceIndex(line, rawChoice) {
  if (Number.isInteger(rawChoice)) return rawChoice;
  const permanentId = rawChoice?.permanentId ?? rawChoice?.pid;
  return permanentId ? line.findIndex((permanent) => permanent.pid === permanentId) : 0;
}

function enforceLineCapacity(state, playerId, lineName, options = {}) {
  const player = getPlayer(state, playerId);
  const line = lineOf(player, lineName);
  const choices = options.choices?.[options.overflowChoiceKey ?? "lineOverflowChoices"] ?? [];
  let removalDelta = 0;
  let choiceIndex = 0;
  while (line.length > lineCapacity(state, playerId, lineName)) {
    const selected = overflowChoiceIndex(line, Array.isArray(choices) ? choices[choiceIndex] : choices);
    assertRule(selected >= 0 && selected < line.length, "LINE_OVERFLOW", "Line overflow choice is out of range.", {
      playerId,
      lineName,
      selected
    });
    const removalBefore = totalRemovalCount(state);
    removePermanentToZone(state, playerId, lineName, selected, "removal", {
      sidelined: false,
      sourcePlayer: undefined,
      stateBased: true
    });
    removalDelta += totalRemovalCount(state) - removalBefore;
    choiceIndex += 1;
  }
  return removalDelta;
}

function insertPermanent(state, playerId, lineName, permanent, replaceIndex, options = {}) {
  assertRule(permanentCanEnterLine(state, playerId, permanent, lineName, options), "LINE_RESTRICTION", "This card cannot enter that line this way.", {
    card: topDef(state, permanent).id,
    lineName,
    operation: options.operation
  });
  const player = getPlayer(state, playerId);
  const roomResult = makeRoomOnLine(state, playerId, lineName, replaceIndex);
  lineOf(player, lineName).push(permanent);
  const overflowRemovalDelta = enforceLineCapacity(state, playerId, lineName, options);
  return {
    ...roomResult,
    removalDelta: (roomResult.removalDelta ?? 0) + overflowRemovalDelta
  };
}

function findPermanentById(state, playerId, permanentId) {
  const player = getPlayer(state, playerId);
  const location = findPermanentLocation(player, permanentId);
  if (!location) return undefined;
  return {
    ...location,
    permanent: player[location.lineName][location.index]
  };
}

function findPermanentByIdAnyPlayer(state, permanentId) {
  for (const playerId of PLAYERS) {
    const found = findPermanentById(state, playerId, permanentId);
    if (found) return { ...found, playerId };
  }
  return undefined;
}

function zoneCardMatches(state, cardRef, filter = {}) {
  return cardDefMatchesFilter(defOf(state, cardRef), filter);
}

function destinationLineForEffect(effect, context = {}, ordinal = 0) {
  const allowed = effect.destinationLines?.length
    ? effect.destinationLines
    : [effect.destinationLine ?? LINES.FRONT];
  const rawChoice = context.choices?.[effect.destinationLineChoiceKey ?? "destinationLine"];
  const requested = Array.isArray(rawChoice) ? rawChoice[ordinal] : rawChoice;
  const destinationLine = requested ?? allowed[0];
  assertRule(allowed.includes(destinationLine), "LINE", "Chosen play destination is not allowed by this effect.", {
    destinationLine,
    allowed
  });
  return destinationLine;
}

function playCardsFromZoneSimultaneously(state, playerId, effect, context = {}) {
  const sourcePlayerId = effect.player === "opponent" ? opponentOf(playerId) : effect.player ?? playerId;
  const player = getPlayer(state, sourcePlayerId);
  const zones = effect.zones ?? [effect.zone ?? "hand"];
  const count = effect.count ?? effect.amount ?? effect.max ?? 1;
  const choiceKey = effect.choiceKey ?? `${zones[0]}Index`;
  const chosen = context.choices?.[choiceKey];
  if (Array.isArray(chosen)) {
    assertRule(chosen.length <= count, "ZONE_SELECTION", "Too many cards selected for simultaneous play.", {
      selected: chosen.length,
      count
    });
    if (chosen.length === 0) return;
  }

  const selected = [];
  const selectedUids = new Set();
  const requestedCount = Array.isArray(chosen) ? chosen.length : count;
  for (let played = 0; played < requestedCount; played += 1) {
    const requested = Array.isArray(chosen) ? chosen[played] : played === 0 ? chosen : undefined;
    let found;
    if (requested && typeof requested === "object") {
      found = findZoneCard(state, player, zones, effect.filter, requested, (card) => {
        return zoneCardMatchesPlayFilter(state, sourcePlayerId, card, effect.filter ?? {});
      });
    } else if (Number.isInteger(requested)) {
      const zoneName = zones[0];
      found = { zoneName, zone: zoneOf(player, zoneName), index: requested };
    } else {
      for (const zoneName of zones) {
        const zone = zoneOf(player, zoneName);
        const index = zone.findIndex((card) => !selectedUids.has(card.uid)
          && zoneCardMatchesPlayFilter(state, sourcePlayerId, card, effect.filter ?? {}));
        if (index !== -1) {
          found = { zoneName, zone, index };
          break;
        }
      }
    }
    if (!found || !found.zone[found.index]) {
      if (requested !== undefined) assertRule(false, "ZONE_SELECTION", "Chosen simultaneous-play card does not exist.", { requested });
      break;
    }
    const cardRef = found.zone[found.index];
    assertRule(!selectedUids.has(cardRef.uid), "ZONE_SELECTION", "The same card cannot be selected twice.", { card: cardRef.uid });
    assertRule(zoneCardMatchesPlayFilter(state, sourcePlayerId, cardRef, effect.filter ?? {}), "ZONE_SELECTION", "Chosen card does not match effect filter.", {
      zone: found.zoneName,
      index: found.index,
      filter: effect.filter
    });
    selected.push({ ...found, cardRef });
    selectedUids.add(cardRef.uid);
  }
  if (selected.length === 0) return;

  const destinationLines = selected.map((_, index) => destinationLineForEffect(effect, context, index));
  selected.forEach(({ cardRef }, index) => {
    const destinationLine = destinationLines[index];
    assertRule(cardCanEnterLine(state, sourcePlayerId, defOf(state, cardRef), destinationLine, { operation: "play" }), "LINE_RESTRICTION", "A selected card cannot be played to that line.", {
      card: cardRef.defId,
      destinationLine
    });
  });

  const rawReplacements = context.choices?.[effect.replaceChoiceKey ?? "replaceIndices"]
    ?? context.choices?.replaceIndices
    ?? context.choices?.replaceIndex;
  const pendingByLine = new Map();
  destinationLines.forEach((destinationLine, ordinal) => {
    const destination = lineOf(player, destinationLine);
    const pending = Number(pendingByLine.get(destinationLine) ?? 0) + 1;
    pendingByLine.set(destinationLine, pending);
    if (destination.length + pending <= lineCapacity(state, sourcePlayerId, destinationLine)) return;
    assertRule(destination.length > 0, "LINE_FULL", "The destination line cannot make enough room for simultaneous play.");
    const rawChoice = Array.isArray(rawReplacements) ? rawReplacements[ordinal] : rawReplacements;
    const replaceIndex = rawChoice === undefined ? 0 : overflowChoiceIndex(destination, rawChoice);
    assertRule(replaceIndex >= 0 && replaceIndex < destination.length, "LINE_FULL", "Simultaneous-play replacement index is out of range.", {
      replaceIndex
    });
    removePermanentToZone(state, sourcePlayerId, destinationLine, replaceIndex, "removal", {
      sidelined: false,
      sourcePlayer: sourcePlayerId,
      stateBased: true
    });
  });

  const selectedByZone = new Map();
  for (const item of selected) {
    if (!selectedByZone.has(item.zoneName)) selectedByZone.set(item.zoneName, []);
    selectedByZone.get(item.zoneName).push(item);
  }
  for (const items of selectedByZone.values()) {
    items.sort((left, right) => right.index - left.index);
    for (const item of items) item.zone.splice(item.index, 1);
  }

  const permanents = selected.map(({ cardRef }) => createPermanent(state, sourcePlayerId, cardRef, effect.rested ?? true));
  permanents.forEach((permanent, index) => {
    lineOf(player, destinationLines[index]).push(permanent);
    rememberPlayedPermanent(context, permanent, sourcePlayerId);
    flagCharacterPlayed(state, sourcePlayerId, topDef(state, permanent));
  });
  for (const destinationLine of new Set(destinationLines)) {
    enforceLineCapacity(state, sourcePlayerId, destinationLine, { choices: context.choices });
  }
  context.lastEffectPlayedCount = permanents.length;

  if (context.suppressPlayedAbilities || effect.suppressPlayedAbilities) return;
  const requestedOrder = context.choices?.[effect.abilityOrderChoiceKey ?? "simultaneousPlayedOrder"]
    ?? permanents.map((_, index) => index);
  assertRule(Array.isArray(requestedOrder) && requestedOrder.length === permanents.length, "EFFECT_CHOICE", "Simultaneous played-ability order must include every played card.", {
    requestedOrder,
    count: permanents.length
  });
  assertRule(new Set(requestedOrder).size === permanents.length, "EFFECT_CHOICE", "Simultaneous played-ability order cannot repeat a card.");
  for (const index of requestedOrder) {
    const permanent = permanents[index];
    assertRule(permanent, "EFFECT_CHOICE", "Simultaneous played-ability order index is out of range.", { index });
    resolvePermanentAbilities(state, sourcePlayerId, permanent, TIMINGS.WHEN_PLAYED, {
      permanent,
      choices: context.choices,
      playedByAbility: true
    });
  }
}

function resolveOpponentHandPlayChoice(state, playerId, effect, context, zones, count, choiceKey) {
  if (effect.player !== "opponent" || zones.length !== 1 || zones[0] !== "hand") return;
  const sourcePlayerId = opponentOf(playerId);
  const hand = getPlayer(state, sourcePlayerId).hand;
  const matchingIndices = hand
    .map((card, index) => ({ card, index }))
    .filter(({ card }) => zoneCardMatchesPlayFilter(state, sourcePlayerId, card, effect.filter ?? {}))
    .map(({ index }) => index);
  const maximum = Math.min(count, matchingIndices.length);
  const minimum = Math.min(maximum, Math.max(0, Number(effect.min ?? count)));
  resolveRuntimeChoices(state, sourcePlayerId, effect, context, {
    kind: "opponentMayPlayCardFromHand",
    initiatingPlayerId: playerId,
    cards: hand,
    ownerId: sourcePlayerId,
    matchingIndices,
    min: minimum,
    max: maximum,
    choiceKey,
    destinationLine: effect.destinationLine ?? effect.destinationLines?.[0] ?? LINES.FRONT,
    destinationLines: effect.destinationLines,
    destinationLineChoiceKey: effect.destinationLineChoiceKey ?? "destinationLine"
  });
}

function playCardFromZone(state, playerId, effect, context = {}) {
  context.lastEffectPlayedCount = 0;
  const zones = effect.zones ?? [effect.zone ?? "hand"];
  const count = effect.count ?? effect.amount ?? effect.max ?? 1;
  const choiceKey = effect.choiceKey ?? `${zones[0]}Index`;
  resolveOpponentHandPlayChoice(state, playerId, effect, context, zones, count, choiceKey);
  if (effect.simultaneous) {
    playCardsFromZoneSimultaneously(state, playerId, effect, context);
    return;
  }
  const sourcePlayerId = effect.player === "opponent" ? opponentOf(playerId) : effect.player ?? playerId;
  const player = getPlayer(state, sourcePlayerId);
  const availableCount = zones.reduce((total, zoneName) => total + zoneOf(player, zoneName)
    .filter((card) => zoneCardMatchesPlayFilter(state, sourcePlayerId, card, effect.filter ?? {})).length, 0);
  const minimum = Math.min(availableCount, Math.max(0, Number(effect.min ?? count)));
  let chosen = context.choices?.[choiceKey];
  const destinationChoiceKey = effect.destinationLineChoiceKey ?? "destinationLine";
  const replaceChoiceKey = effect.replaceChoiceKey ?? "replaceIndex";
  const destinationChoiceMissing = Boolean(effect.destinationLines?.length)
    && context.choices?.[destinationChoiceKey] === undefined;
  const replacementChoiceMissing = context.choices?.[replaceChoiceKey] === undefined
    && (effect.destinationLines ?? [effect.destinationLine ?? LINES.FRONT]).some((lineName) => (
      lineOf(player, lineName).length >= lineCapacity(state, sourcePlayerId, lineName)
    ));
  if (chosen === undefined || destinationChoiceMissing || replacementChoiceMissing) {
    resolveRuntimeChoices(state, playerId, effect, context, {
      kind: "playCardFromZone",
      ownerId: sourcePlayerId,
      zones,
      count,
      minimum,
      choiceKey,
      destinationChoiceKey,
      replaceChoiceKey
    });
    chosen = context.choices?.[choiceKey];
  }
  if (chosen === undefined && effect.player === "opponent" && zones.length === 1 && zones[0] === "hand" && minimum === 0) {
    chosen = [];
  }
  if (Array.isArray(chosen)) {
    assertRule(chosen.length >= minimum && chosen.length <= count, "ZONE_SELECTION", "A legal number of cards must be selected to play.", {
      selected: chosen.length,
      minimum,
      count
    });
    if (chosen.length === 0) return;
  }
  const plannedSelections = Array.isArray(chosen)
    ? chosen.map((selection) => {
      if (selection?.uid) return selection;
      const zoneName = selection && typeof selection === "object"
        ? selection.zone ?? selection.zoneName ?? zones[0]
        : zones[0];
      const index = selection && typeof selection === "object" ? selection.index : selection;
      const card = Number.isInteger(index) ? zoneOf(player, zoneName)[index] : undefined;
      return card ? { zone: zoneName, uid: card.uid } : selection;
    })
    : undefined;
  const replaceChoices = context.choices?.[effect.replaceChoiceKey ?? "replaceIndex"];
  const requestedCount = plannedSelections ? plannedSelections.length : count;

  for (let played = 0; played < requestedCount; played += 1) {
    const selected = plannedSelections ? plannedSelections[played] : played === 0 ? chosen : undefined;
    const found = findZoneCard(state, player, zones, effect.filter, selected, (card) => {
      return zoneCardMatchesPlayFilter(state, sourcePlayerId, card, effect.filter ?? {});
    });
    if (!found) return;

    const { zoneName, zone, index } = found;
    assertRule(index >= 0 && index < zone.length, "ZONE_INDEX", "Chosen zone card index is out of range.", {
      zone: zoneName,
      chosenIndex: index
    });
    const cardRef = zone[index];
    assertRule(zoneCardMatchesPlayFilter(state, sourcePlayerId, cardRef, effect.filter ?? {}), "ZONE_SELECTION", "Chosen card does not match effect filter.", {
      zone: zoneName,
      chosenIndex: index,
      filter: effect.filter
    });
    const destinationLine = destinationLineForEffect(effect, context, played);
    assertRule(cardCanEnterLine(state, sourcePlayerId, defOf(state, cardRef), destinationLine, { operation: "play" }), "LINE_RESTRICTION", "The chosen card cannot be played to that line.", {
      card: cardRef.defId,
      destinationLine
    });
    zone.splice(index, 1);
    const permanent = createPermanent(state, sourcePlayerId, cardRef, effect.rested ?? true);
    insertPermanent(state, sourcePlayerId, destinationLine, permanent, Array.isArray(replaceChoices) ? replaceChoices[played] : replaceChoices, {
      operation: "play",
      choices: context.choices
    });
    rememberPlayedPermanent(context, permanent, sourcePlayerId);
    flagCharacterPlayed(state, sourcePlayerId, topDef(state, permanent));
    if (!context.suppressPlayedAbilities && !effect.suppressPlayedAbilities) {
      resolvePermanentAbilities(state, sourcePlayerId, permanent, TIMINGS.WHEN_PLAYED, { permanent, choices: context.choices, playedByAbility: true });
    }
    context.lastEffectPlayedCount += 1;
  }
}

function zoneCardMatchesPlayFilter(state, playerId, cardRef, filter = {}) {
  if (!cardMatchesFilter(state, cardRef, filter)) return false;
  if (filter.requiredEnergyFulfilled && !hasRequiredEnergy(state, playerId, defOf(state, cardRef))) return false;
  return true;
}

function defaultRaidTargetForCard(state, playerId, cardDef, options = {}) {
  return raidTargetsForCard(state, playerId, cardDef, options)[0];
}

function raidTargetsForCard(state, playerId, cardDef, options = {}) {
  if (!cardDef?.raid) return [];
  if (!raidUseConditionMet(state, playerId, cardDef, options)) return [];
  const player = getPlayer(state, playerId);
  const targets = [];
  for (const lineName of [LINES.FRONT, LINES.ENERGY]) {
    const line = lineOf(player, lineName);
    line.forEach((permanent, index) => {
      if (!isCharacter(state, permanent)
        || permanent.pid === options.excludePermanentId
        || topDef(state, permanent).raid
        || !matchesRaidRequirement(state, cardDef.raid, permanent, {
          raidCardDef: cardDef,
          sourceKind: options.sourceKind
        })) return;
      targets.push({ lineName, index });
    });
  }
  return targets;
}

function playOrRaidCardFromZone(state, playerId, effect, context = {}) {
  context.lastEffectPlayedCount = 0;
  const player = getPlayer(state, playerId);
  const zones = effect.zones ?? [effect.zone ?? "hand"];
  const count = effect.count ?? effect.amount ?? effect.max ?? 1;
  const choiceKey = effect.choiceKey ?? `${zones[0]}Index`;
  const selectedChoices = context.choices?.[choiceKey];
  if (Array.isArray(selectedChoices)) {
    assertRule(selectedChoices.length <= count, "ZONE_SELECTION", "Too many cards selected to play or Raid.", {
      selected: selectedChoices.length,
      count
    });
    if (selectedChoices.length === 0) return;
  }

  // Preserve selected identities while earlier cards are removed from their zones.
  const plannedSelections = Array.isArray(selectedChoices)
    ? selectedChoices.map((selection) => {
      if (selection?.uid) return selection;
      const zoneName = selection && typeof selection === "object"
        ? selection.zone ?? selection.zoneName ?? zones[0]
        : zones[0];
      const index = selection && typeof selection === "object" ? selection.index : selection;
      const card = Number.isInteger(index) ? zoneOf(player, zoneName)[index] : undefined;
      return card ? { uid: card.uid } : selection;
    })
    : undefined;
  const raidChoices = context.choices?.[effect.raidChoiceKey ?? "performRaid"];
  const raidTargets = context.choices?.[effect.raidTargetChoiceKey ?? "raidTarget"];
  const replaceChoices = context.choices?.[effect.replaceChoiceKey ?? "replaceIndex"];
  const raidMoveChoices = context.choices?.[effect.raidMoveChoiceKey ?? "moveRaidToFront"];
  const raidMoveReplaceChoices = context.choices?.[effect.raidMoveReplaceChoiceKey ?? "raidMoveReplaceIndex"];
  const requestedCount = plannedSelections ? plannedSelections.length : count;
  const deferred = requestedCount > 1 || effect.simultaneous ? [] : undefined;

  for (let index = 0; index < requestedCount; index += 1) {
    const resolved = playOrRaidSingleCardFromZone(state, playerId, effect, context, {
      selected: plannedSelections ? plannedSelections[index] : index === 0 ? selectedChoices : undefined,
      raidChoice: Array.isArray(raidChoices) ? raidChoices[index] : raidChoices,
      raidTarget: Array.isArray(raidTargets) ? raidTargets[index] : raidTargets,
      replaceIndex: Array.isArray(replaceChoices) ? replaceChoices[index] : replaceChoices,
      moveToFront: Array.isArray(raidMoveChoices) ? raidMoveChoices[index] : raidMoveChoices,
      moveReplaceIndex: Array.isArray(raidMoveReplaceChoices) ? raidMoveReplaceChoices[index] : raidMoveReplaceChoices,
      destinationLine: destinationLineForEffect(effect, context, index),
      deferred
    });
    if (!resolved) break;
    context.lastEffectPlayedCount += 1;
  }

  if (deferred?.length) {
    const requestedOrder = context.choices?.[effect.abilityOrderChoiceKey ?? "simultaneousPlayedOrder"]
      ?? deferred.map((_, index) => index);
    assertRule(Array.isArray(requestedOrder) && requestedOrder.length === deferred.length, "EFFECT_CHOICE", "Simultaneous play-or-Raid ability order must include every played card.", {
      requestedOrder,
      count: deferred.length
    });
    assertRule(new Set(requestedOrder).size === deferred.length, "EFFECT_CHOICE", "Simultaneous play-or-Raid ability order cannot repeat a card.");
    for (const index of requestedOrder) {
      const entry = deferred[index];
      assertRule(entry, "EFFECT_CHOICE", "Simultaneous play-or-Raid ability order index is out of range.", { index });
      if (!context.suppressPlayedAbilities && !effect.suppressPlayedAbilities) {
        resolvePermanentAbilities(state, playerId, entry.permanent, TIMINGS.WHEN_PLAYED, {
          permanent: entry.permanent,
          raid: entry.raid,
          choices: context.choices,
          playedByAbility: true
        });
      }
      if (entry.raid) {
        resolveRaidedAbilities(state, playerId, entry.permanent, entry.raidedDef, {
          permanent: entry.permanent,
          raid: true,
          choices: context.choices
        });
      }
    }
  }
}

function playOrRaidSingleCardFromZone(state, playerId, effect, context, options = {}) {
  const player = getPlayer(state, playerId);
  const zones = effect.zones ?? [effect.zone ?? "hand"];
  const selected = options.selected;
  let found;

  if (selected?.uid) {
    for (const zoneName of zones) {
      const zone = zoneOf(player, zoneName);
      const index = zone.findIndex((card) => card.uid === selected.uid);
      if (index !== -1) {
        found = { zoneName, zone, index };
        break;
      }
    }
  } else {
    found = findZoneCard(state, player, zones, effect.filter, selected, (card) => {
      return zoneCardMatchesPlayFilter(state, playerId, card, effect.filter ?? {});
    });
  }
  if (!found || !found.zone[found.index]) return false;

  const cardRef = found.zone[found.index];
  assertRule(zoneCardMatchesPlayFilter(state, playerId, cardRef, effect.filter ?? {}), "ZONE_SELECTION", "Chosen card does not match the play-or-Raid filter.", {
    zone: found.zoneName,
    index: found.index,
    filter: effect.filter
  });
  const cardDef = defOf(state, cardRef);
  const raidChoice = options.raidChoice;
  const excludedRaidTarget = effect.raidTargetOtherThanSource ? context.permanent?.pid : undefined;
  const raidTarget = options.raidTarget ?? defaultRaidTargetForCard(state, playerId, cardDef, {
    excludePermanentId: excludedRaidTarget,
    sourceKind: context.sourceKind
  });
  const shouldRaid = effect.allowRaid && cardDef.raid && raidTarget && raidChoice !== false
    && raidUseConditionMet(state, playerId, cardDef, { sourceKind: context.sourceKind });

  if (!shouldRaid) {
    if (effect.forceRaid) return false;
    if (effect.nonRaidDestination) {
      found.zone.splice(found.index, 1);
      placeCardInZone(state, player, effect.nonRaidDestination, cardRef);
      context.lastMovedCards = [cardRef];
      context.lastMovedCardCount = (context.lastMovedCardCount ?? 0) + 1;
      return true;
    }
    const destinationLine = options.destinationLine ?? destinationLineForEffect(effect, context);
    const canEnterLine = cardCanEnterLine(state, playerId, cardDef, destinationLine, { operation: "play" });
    if (!canEnterLine && effect.keepInZoneIfCannotPlay) return false;
    assertRule(canEnterLine, "LINE_RESTRICTION", "The chosen card cannot be played without performing Raid.", {
      card: cardDef.id,
      destinationLine
    });
  }

  found.zone.splice(found.index, 1);
  if (shouldRaid) {
    const lineName = raidTarget.lineName ?? raidTarget.line ?? LINES.FRONT;
    const target = lineOf(player, lineName)[raidTarget.index];
    assertRule(target, "RAID_TARGET", "Raid target does not exist.");
    assertRule(target.pid !== excludedRaidTarget, "RAID_TARGET", "This ability cannot perform Raid on its source character.");
    assertRule(matchesRaidRequirement(state, cardDef.raid, target, { raidCardDef: cardDef, sourceKind: context.sourceKind }), "RAID_TARGET", "Raid target does not match this card's Raid requirement.");
    const raidedDef = topDef(state, target);
    resetPermanentForRaid(target);
    target.cards.push(cardRef);
    readyPermanent(target);
    const location = findPermanentLocation(player, target.pid);
    const moveToFront = options.moveToFront
      ?? effect.moveRaidToFrontDefault
      ?? (location?.lineName === LINES.ENERGY
        && player.frontLine.length < lineCapacity(state, playerId, LINES.FRONT));
    if (location?.lineName === LINES.ENERGY && moveToFront) {
      assertRule(permanentCanEnterLine(state, playerId, target, LINES.FRONT, { operation: "move" }), "LINE_RESTRICTION", "This raided character cannot move to the front line.");
      const moved = removeFromLine(player, LINES.ENERGY, location.index);
      insertPermanent(state, playerId, LINES.FRONT, moved, options.moveReplaceIndex, {
        operation: "move",
        sourcePermanent: moved,
        choices: context.choices
      });
      resolveCharacterMovedOutsideMovementPhase(state, playerId, moved, LINES.ENERGY, LINES.FRONT, context);
    }
    rememberPlayedPermanent(context, target, playerId);
    flagCharacterPlayed(state, playerId, cardDef);
    if (options.deferred) {
      options.deferred.push({ permanent: target, raid: true, raidedDef });
    } else {
      if (!context.suppressPlayedAbilities && !effect.suppressPlayedAbilities) {
        resolvePermanentAbilities(state, playerId, target, TIMINGS.WHEN_PLAYED, { permanent: target, raid: true, choices: context.choices, playedByAbility: true });
      }
      resolveRaidedAbilities(state, playerId, target, raidedDef, { permanent: target, raid: true, choices: context.choices });
    }
    return true;
  }

  const permanent = createPermanent(state, playerId, cardRef, effect.rested ?? true);
  insertPermanent(state, playerId, options.destinationLine ?? destinationLineForEffect(effect, context), permanent, options.replaceIndex, {
    operation: "play",
    choices: context.choices
  });
  rememberPlayedPermanent(context, permanent, playerId);
  flagCharacterPlayed(state, playerId, cardDef);
  if (options.deferred) {
    options.deferred.push({ permanent, raid: false });
  } else if (!context.suppressPlayedAbilities && !effect.suppressPlayedAbilities) {
    resolvePermanentAbilities(state, playerId, permanent, TIMINGS.WHEN_PLAYED, { permanent, choices: context.choices, playedByAbility: true });
  }
  return true;
}

function playCardFromZoneMatchingTargetName(state, playerId, effect, context = {}) {
  const targets = selectPermanentTargets(state, playerId, effect.target, context);
  if (targets.length === 0) return;
  const name = topDef(state, targets[0].permanent).name;
  playCardFromZone(state, playerId, {
    ...effect,
    filter: {
      ...(effect.filter ?? {}),
      name
    }
  }, context);
}

function playSomeNamedFromSidelineAddRest(state, playerId, effect, context = {}) {
  const player = getPlayer(state, playerId);
  const chosen = [];
  for (const name of effect.names ?? []) {
    const index = player.sideline.findIndex((card) => cardDefHasName(defOf(state, card), name));
    if (index !== -1) chosen.push(player.sideline.splice(index, 1)[0]);
  }

  const playCount = Math.min(effect.playCount ?? 0, chosen.length);
  const playChoices = context.choices?.[effect.choiceKey ?? "playNamedIndices"] ?? [...Array(playCount).keys()];
  assertRule(Array.isArray(playChoices) && playChoices.length === playCount, "ZONE_SELECTION", "Named sideline play requires the correct number of cards.", {
    selected: playChoices?.length,
    playCount
  });
  const playUids = new Set(playChoices
    .filter((choice) => choice && typeof choice === "object" && choice.uid)
    .map((choice) => choice.uid));
  const playSet = new Set(playChoices.filter((choice) => Number.isInteger(choice)));
  const replaceChoices = context.choices?.[effect.replaceChoiceKey ?? "replaceIndex"];
  let playedOrdinal = 0;
  chosen.forEach((card, index) => {
    if (playSet.has(index) || playUids.has(card.uid)) {
      const permanent = createPermanent(state, playerId, card, effect.rested ?? true);
      insertPermanent(state, playerId, effect.destinationLine ?? LINES.FRONT, permanent, Array.isArray(replaceChoices) ? replaceChoices[playedOrdinal] : replaceChoices, {
        operation: "play",
        choices: context.choices
      });
      playedOrdinal += 1;
      rememberPlayedPermanent(context, permanent, playerId);
      resolvePermanentAbilities(state, playerId, permanent, TIMINGS.WHEN_PLAYED, { permanent, choices: context.choices, playedByAbility: true });
    } else {
      player.hand.push(card);
    }
  });
}

function findZoneCard(state, player, zoneNames, filter, selected, matcher = (card) => zoneCardMatches(state, card, filter)) {
  if (selected && typeof selected === "object") {
    const selectedZone = selected.zone ?? selected.zoneName;
    const candidateZones = selectedZone ? [selectedZone] : zoneNames;
    for (const zoneName of candidateZones) {
      const zone = zoneOf(player, zoneName);
      const index = selected.uid ? zone.findIndex((card) => card.uid === selected.uid) : selected.index;
      if (index !== -1 && index !== undefined) return { zoneName, zone, index };
    }
    const zoneName = selectedZone ?? zoneNames[0];
    return { zoneName, zone: zoneOf(player, zoneName), index: -1 };
  }

  if (Number.isInteger(selected)) {
    const zoneName = zoneNames[0];
    const zone = zoneOf(player, zoneName);
    return { zoneName, zone, index: selected };
  }

  for (const zoneName of zoneNames) {
    const zone = zoneOf(player, zoneName);
    const index = zone.findIndex((card) => matcher(card));
    if (index !== -1) return { zoneName, zone, index };
  }
  return undefined;
}

function findSourceCardInZone(state, playerId, context = {}, fallbackZone = "sideline") {
  const player = getPlayer(state, playerId);
  const zoneName = context.zone ?? context.sourceZone ?? fallbackZone;
  const zone = zoneOf(player, zoneName);
  const sourceCard = context.card;
  const chosenIndex = context.zoneIndex;

  if (Number.isInteger(chosenIndex) && zone[chosenIndex]?.uid === sourceCard?.uid) {
    return { zoneName, zone, index: chosenIndex, card: zone[chosenIndex] };
  }

  const index = sourceCard
    ? zone.findIndex((candidate) => candidate.uid === sourceCard.uid)
    : -1;
  if (index === -1) return undefined;
  return { zoneName, zone, index, card: zone[index] };
}

function playSourceFromZone(state, playerId, effect, context = {}) {
  const found = findSourceCardInZone(state, playerId, context, effect.source ?? "sideline");
  if (!found) return;

  const cardDef = defOf(state, found.card);
  if (effect.requiredEnergyFulfilled
    && !hasRequiredEnergy(state, playerId, cardDef, { sourceZone: found.zoneName })) return;
  const destinationChoiceKey = effect.destinationLineChoiceKey ?? "destinationLine";
  if (effect.destinationLines?.length && context.choices?.[destinationChoiceKey] === undefined) {
    resolveRuntimeChoices(state, playerId, effect, context, {
      kind: "playSourceFromZone",
      cards: [found.card],
      sourceName: found.zoneName,
      destinationLines: effect.destinationLines,
      destinationLineChoiceKey: destinationChoiceKey,
      replaceChoiceKey: effect.replaceChoiceKey ?? "replaceIndex"
    });
  }
  const destinationLine = destinationLineForEffect(effect, context);
  assertRule(cardCanEnterLine(state, playerId, cardDef, destinationLine, { operation: "play" }), "LINE_RESTRICTION", "The source card cannot be played to the chosen line.", {
    card: cardDef.id,
    destinationLine
  });

  const cardRef = found.zone.splice(found.index, 1)[0];
  const entersActive = effect.activeIfTriggerSourceName
    && cardDefHasName(context.triggerSourceDef, effect.activeIfTriggerSourceName);
  const permanent = createPermanent(state, playerId, cardRef, entersActive ? false : effect.rested ?? true);
  insertPermanent(state, playerId, destinationLine, permanent, context.choices?.[effect.replaceChoiceKey ?? "replaceIndex"], {
    operation: "play",
    choices: context.choices
  });
  rememberPlayedPermanent(context, permanent, playerId);
  if (!context.suppressPlayedAbilities && !effect.suppressPlayedAbilities) {
    resolvePermanentAbilities(state, playerId, permanent, TIMINGS.WHEN_PLAYED, { permanent, choices: context.choices, playedByAbility: true });
  }
}

function raidSourceFromZone(state, playerId, effect, context = {}) {
  const found = findSourceCardInZone(state, playerId, context, effect.source ?? "sideline");
  if (!found) return;

  const cardRef = found.card;
  const cardDef = defOf(state, cardRef);
  if (cardDef.type !== CARD_TYPES.CHARACTER || !cardDef.raid) return;
  if (!hasRequiredEnergy(state, playerId, cardDef, { sourceZone: effect.source ?? "sideline", performingRaid: true })) return;
  if (!raidUseConditionMet(state, playerId, cardDef, { sourceKind: context.sourceKind })) return;

  const player = getPlayer(state, playerId);
  const candidates = [];
  for (const lineName of [LINES.FRONT, LINES.ENERGY]) {
    lineOf(player, lineName).forEach((permanent, index) => {
      if (!isCharacter(state, permanent)) return;
      if (topDef(state, permanent).raid) return;
      if (!matchesRaidRequirement(state, cardDef.raid, permanent, { raidCardDef: cardDef, sourceKind: context.sourceKind })) return;
      candidates.push({ lineName, index, permanent });
    });
  }
  if (candidates.length === 0) return;

  resolveRuntimeChoices(state, playerId, effect, context, {
    kind: "raidSourceFromZone",
    cards: [cardRef],
    ownerId: playerId,
    raidTargets: candidates.map((candidate) => ({
      player: playerId,
      line: candidate.lineName,
      index: candidate.index,
      permanentId: candidate.permanent.pid
    }))
  });

  const chosen = context.choices?.[effect.choiceKey ?? "raidTarget"];
  const target = Number.isInteger(chosen)
    ? candidates[chosen]
    : candidates.find((candidate) => {
      return candidate.lineName === chosen?.line && candidate.index === chosen?.index;
    }) ?? candidates[0];
  if (!target) return;

  found.zone.splice(found.index, 1);
  const raidedDef = topDef(state, target.permanent);
  resetPermanentForRaid(target.permanent);
  target.permanent.cards.push(cardRef);
  readyPermanent(target.permanent);

  const moveReplaceChoiceKey = effect.moveReplaceChoiceKey ?? effect.replaceChoiceKey ?? "replaceIndex";
  const moveToFront = context.choices?.[effect.moveChoiceKey ?? "moveToFront"]
    ?? effect.moveToFrontDefault
    ?? (player.frontLine.length < lineCapacity(state, playerId, LINES.FRONT));
  if (target.lineName === LINES.ENERGY && moveToFront) {
    assertRule(permanentCanEnterLine(state, playerId, target.permanent, LINES.FRONT, { operation: "move" }), "LINE_RESTRICTION", "This raided character cannot move to the front line.");
    const currentLocation = findPermanentLocation(player, target.permanent.pid);
    if (currentLocation?.lineName === LINES.ENERGY) {
      const moved = removeFromLine(player, LINES.ENERGY, currentLocation.index);
      insertPermanent(state, playerId, LINES.FRONT, moved, context.choices?.[moveReplaceChoiceKey], {
        operation: "move",
        sourcePermanent: target.permanent,
        choices: context.choices
      });
      resolveCharacterMovedOutsideMovementPhase(state, playerId, moved, LINES.ENERGY, LINES.FRONT, context);
    }
  }

  resolvePermanentAbilities(state, playerId, target.permanent, TIMINGS.WHEN_PLAYED, {
    permanent: target.permanent,
    raid: true,
    choices: context.choices,
    playedByAbility: true
  });
  resolveRaidedAbilities(state, playerId, target.permanent, raidedDef, {
    permanent: target.permanent,
    raid: true,
    choices: context.choices
  });
}

function moveSourceCardBetweenZones(state, playerId, effect, context = {}) {
  const found = findSourceCardInZone(state, playerId, context, effect.source ?? "sideline");
  if (!found) return;

  const sourceName = effect.source ?? "sideline";
  const destinationName = effect.destination ?? "hand";
  const cardRef = found.zone.splice(found.index, 1)[0];
  placeCardInZone(state, getPlayer(state, cardRef.owner), destinationName, cardRef, { position: effect.position });
  resolveSidelineToHandByAbility(state, playerId, cardRef, sourceName, destinationName, cardRef.owner, cardRef.owner, context);
}

function moveContextCardToZone(state, playerId, effect, context = {}) {
  const cardRef = context.card ?? context.lastMovedCards?.[0];
  if (!cardRef) return;

  const owner = getPlayer(state, cardRef.owner);
  const sourceNames = effect.source ? [effect.source] : ["sideline", "removal", "hand", "deck", "life"];
  for (const sourceName of sourceNames) {
    const source = zoneOf(owner, sourceName);
    const index = source.findIndex((card) => card.uid === cardRef.uid);
    if (index === -1) continue;
    const moved = source.splice(index, 1)[0];
    const destinationPlayer = effect.player === "opponent" ? getPlayer(state, opponentOf(playerId)) : owner;
    const destinationName = effect.destination ?? "hand";
    const destinationPlayerId = effect.player === "opponent" ? opponentOf(playerId) : cardRef.owner;
    placeCardInZone(state, destinationPlayer, destinationName, moved, { position: effect.position });
    resolveSidelineToHandByAbility(state, playerId, moved, sourceName, destinationName, cardRef.owner, destinationPlayerId, context);
    return;
  }
}

function useEventFromZone(state, playerId, effect, context = {}) {
  const player = getPlayer(state, playerId);
  const sourceZone = effect.source ?? "sideline";
  const source = zoneOf(player, sourceZone);
  const choiceKey = effect.choiceKey ?? `${sourceZone}Index`;
  const chosenIndex = context.choices?.[choiceKey] ?? source.findIndex((card) => cardMatchesFilter(state, card, effect.filter));
  if (chosenIndex === -1 || chosenIndex === undefined) return;

  assertRule(chosenIndex >= 0 && chosenIndex < source.length, "ZONE_INDEX", "Chosen event index is out of range.", {
    source: sourceZone,
    chosenIndex
  });
  const cardRef = source[chosenIndex];
  const cardDef = defOf(state, cardRef);
  assertRule(cardDef.type === CARD_TYPES.EVENT, "EVENT_USE", "Only event cards can be used by this effect.", {
    card: cardDef.id
  });
  assertRule(cardMatchesFilter(state, cardRef, effect.filter), "ZONE_SELECTION", "Chosen event does not match effect filter.", {
    chosenIndex,
    filter: effect.filter
  });

  assertCanUseCard(state, playerId, cardDef, { sourceZone });
  const apCost = apCostForCardUse(state, playerId, cardDef, { sourceZone });
  payAp(state, playerId, apCost);
  payUseRestrictionCosts(state, playerId, cardDef, context.choices);
  consumeRequiredEnergyReductions(state, playerId, cardDef, { sourceZone });
  consumeApCostReductions(state, playerId, cardDef, { sourceZone });
  source.splice(chosenIndex, 1);
  flagEventUsed(state, playerId);
  resolveEffect(state, playerId, cardDef.eventEffect, {
    card: cardRef,
    choices: context.choices,
    sourceDef: cardDef,
    sourceZone
  });
  placeCardInZone(state, player, effect.destination ?? "removal", cardRef);
}

function resolveTriggerAbilityOnly(state, playerId, cardRef, trigger, choices) {
  const sourceDef = defOf(state, cardRef);
  switch (trigger.type) {
    case TRIGGER_TYPES.GET: {
      const owner = getPlayer(state, cardRef.owner);
      for (const zoneName of ["sideline", "removal"]) {
        const zone = zoneOf(owner, zoneName);
        const index = zone.findIndex((card) => card.uid === cardRef.uid);
        if (index !== -1) {
          owner.hand.push(zone.splice(index, 1)[0]);
          return;
        }
      }
      owner.hand.push(cardRef);
      break;
    }
    case TRIGGER_TYPES.DRAW:
      drawCards(state, playerId, trigger.amount ?? 1);
      break;
    case TRIGGER_TYPES.ACTIVE:
    case TRIGGER_TYPES.COLOR:
    case TRIGGER_TYPES.SPECIAL:
    case TRIGGER_TYPES.FINAL:
    case "raid":
      if (trigger.effect) resolveEffect(state, playerId, trigger.effect, { card: cardRef, choices, sourceDef, sourceKind: "trigger" });
      break;
    default:
      if (trigger.effect) resolveEffect(state, playerId, trigger.effect, { card: cardRef, choices, sourceDef, sourceKind: "trigger" });
      break;
  }
}

function activateTriggerFromZone(state, playerId, effect, context = {}) {
  const player = getPlayer(state, playerId);
  const source = zoneOf(player, effect.source ?? "sideline");
  const choiceKey = effect.choiceKey ?? `${effect.source ?? "sideline"}TriggerIndex`;
  const chosenIndex = context.choices?.[choiceKey] ?? source.findIndex((card) => cardMatchesFilter(state, card, effect.filter ?? {}));
  if (chosenIndex === -1 || chosenIndex === undefined) return;
  assertRule(chosenIndex >= 0 && chosenIndex < source.length, "ZONE_INDEX", "Chosen trigger card index is out of range.", {
    source: effect.source,
    chosenIndex
  });
  const cardRef = source[chosenIndex];
  const cardDef = defOf(state, cardRef);
  assertRule(cardMatchesFilter(state, cardRef, effect.filter ?? {}), "ZONE_SELECTION", "Chosen trigger card does not match filter.", {
    chosenIndex,
    filter: effect.filter
  });
  assertRule(cardDef.trigger?.type, "TRIGGER", "Chosen card does not have a trigger ability.", { card: cardDef.id });
  resolveTriggerAbilityOnly(state, playerId, cardRef, cardDef.trigger, context.choices);
}

function waiveAbilityCostForTargets(state, playerId, effect, context = {}) {
  const targets = selectPermanentTargets(state, playerId, effect.target ?? "self", context);
  state.continuousEffects.push({
    kind: "abilityCostWaiver",
    controller: playerId,
    targetPermanentIds: targets.map((target) => target.permanent.pid),
    timing: effect.timing ?? TIMINGS.ACTIVATE_MAIN,
    costKey: effect.costKey ?? "ap",
    expires: effect.expires ?? "endOfTurn"
  });
}

function copyActivatedAbility(state, playerId, effect, context = {}) {
  assertRule(context.permanent, "EFFECT_SOURCE", "This effect requires a source permanent.");
  const targets = selectPermanentTargets(state, playerId, effect.target, context);
  const sourcePermanent = targets[0]?.permanent;
  if (!sourcePermanent) return;
  const ability = abilitiesOfPermanent(state, sourcePermanent)
    .find((candidate) => candidate.timing === (effect.timing ?? TIMINGS.ACTIVATE_MAIN)
      && (!effect.requiresCostKey || candidate.cost?.[effect.requiresCostKey]));
  if (!ability) return;
  context.permanent.gainedAbilities.push({
    ...structuredClone(ability),
    id: `copied:${sourcePermanent.pid}:${ability.id}`,
    expires: effect.expires ?? "endOfTurn"
  });
}

function copyActivatedAbilitiesFromMovedCards(state, playerId, effect, context = {}) {
  assertRule(context.permanent, "EFFECT_SOURCE", "This effect requires a source permanent.");
  if (effect.sourceDestination && context.lastMovedDestination !== effect.sourceDestination) return;

  const timing = effect.timing ?? TIMINGS.ACTIVATE_MAIN;
  for (const card of context.lastMovedCards ?? []) {
    const cardDef = defOf(state, card);
    for (const ability of cardDef.abilities ?? []) {
      if (ability.timing !== timing) continue;
      context.permanent.gainedAbilities.push({
        ...structuredClone(ability),
        id: `copied:${card.uid}:${ability.id}`,
        expires: effect.expires ?? "endOfTurn"
      });
    }
  }
}

function restEnergyLineForRequiredEnergyTotal(state, playerId, effect, context = {}) {
  const player = getPlayer(state, playerId);
  const defaultIndices = player.energyLine
    .map((permanent, index) => ({ permanent, index }))
    .filter(({ permanent }) => !permanent.rested)
    .map(({ index }) => index);
  const requested = context.choices?.[effect.choiceKey ?? "energyRestIndices"] ?? defaultIndices;
  const indices = requested.map((choice) => choice && typeof choice === "object" ? choice.index : choice);
  let total = 0;
  for (const index of indices) {
    const permanent = player.energyLine[index];
    if (!permanent || permanent.rested) continue;
    permanent.rested = true;
    total += topDef(state, permanent).requiredEnergy?.amount ?? 0;
  }
  context.lastRestedRequiredEnergyTotal = (context.lastRestedRequiredEnergyTotal ?? 0) + total;
}

function applyTieredAbilityGrants(state, playerId, effect, context = {}) {
  for (const tier of effect.tiers ?? []) {
    if (!conditionMet(state, playerId, tier.condition, context)) continue;
    for (const grant of tier.effects ?? []) {
      resolveEffect(state, playerId, grant, context);
    }
  }
}

function targetConditionMet(target, condition = {}) {
  if (condition.rested !== undefined && target.permanent.rested !== condition.rested) return false;
  if (condition.active !== undefined && target.permanent.rested === condition.active) return false;
  return true;
}

function resolveEffectForChosenTarget(state, playerId, effect, target, context = {}) {
  if (!effect) return;
  resolveEffect(state, playerId, {
    ...effect,
    target: {
      targets: [{
        playerId: target.playerId,
        lineName: target.lineName,
        index: target.index
      }]
    }
  }, context);
}

function resolveTargetConditional(state, playerId, effect, context = {}) {
  const targets = selectPermanentTargets(state, playerId, effect.target ?? "self", context);
  mutateTargetsInReverse(targets, (target) => {
    const selectedEffect = targetConditionMet(target, effect.condition ?? {}) ? effect.effect : effect.elseEffect;
    resolveEffectForChosenTarget(state, playerId, selectedEffect, target, context);
  });
}

function expirationFromDuration(duration) {
  if (duration === "attack" || duration === "endOfAttack") return "endOfAttack";
  if (duration === "startOfNextTurn") return "startOfControllerTurn";
  if (duration === "turn" || duration === "endOfTurn") return "endOfTurn";
  return "permanent";
}

function grantAbility(state, playerId, effect, context = {}) {
  if (!effect.ability) return;
  const targets = selectPermanentTargets(state, playerId, effect.target ?? "self", context);
  for (const target of targets) {
    target.permanent.gainedAbilities.push({
      ...structuredClone(effect.ability),
      id: `granted:${context.permanent?.pid ?? "effect"}:${effect.ability.id ?? effect.ability.timing}:${target.permanent.gainedAbilities.length + 1}`,
      expires: expirationFromDuration(effect.duration)
    });
  }
}

function moveTargetsToLine(state, playerId, effect, context = {}) {
  const targets = selectPermanentTargets(state, playerId, effect.target ?? "self", context);
  let removalCount = 0;
  mutateTargetsInReverse(targets, (target) => {
    if (target.lineName === effect.destinationLine) return;
    if (abilityActionPreventedByAbility(state, target.playerId, target.permanent, "move", context)) return;
    const permanent = removeFromLine(getPlayer(state, target.playerId), target.lineName, target.index);
    const roomResult = insertPermanent(state, target.playerId, effect.destinationLine, permanent, context.choices?.[effect.replaceChoiceKey ?? "replaceIndex"], {
      operation: "move",
      sourcePermanent: context.permanent,
      choices: context.choices
    });
    removalCount += roomResult?.removalDelta ?? 0;
    resolveCharacterMovedOutsideMovementPhase(state, target.playerId, permanent, target.lineName, effect.destinationLine, context);
  });
  context.lastMoveToLineRemovalCount = removalCount;
}

function swapSourceWithOtherLine(state, playerId, effect, context = {}) {
  assertRule(context.permanent, "EFFECT_SOURCE", "This effect requires a source permanent.");
  const player = getPlayer(state, playerId);
  const sourceLocation = findPermanentLocation(player, context.permanent.pid);
  if (!sourceLocation) return;

  const otherLine = sourceLocation.lineName === LINES.FRONT ? LINES.ENERGY : LINES.FRONT;
  const rawTarget = context.choices?.[effect.choiceKey ?? "swapTargetIndex"];
  const targetIndex = (rawTarget && typeof rawTarget === "object" ? rawTarget.index : rawTarget) ?? player[otherLine]
    .findIndex((permanent) => isCharacter(state, permanent));
  if (targetIndex === -1 || targetIndex === undefined) return;

  const target = player[otherLine][targetIndex];
  if (!target || !isCharacter(state, target)) return;
  const sourcePermanent = context.permanent;
  if (abilityActionPreventedByAbility(state, playerId, sourcePermanent, "move", context)
    || abilityActionPreventedByAbility(state, playerId, target, "move", context)) return;
  assertRule(permanentCanEnterLine(state, playerId, sourcePermanent, otherLine, { operation: "move", sourcePermanent }), "LINE_RESTRICTION", "The source character cannot move to the other line.");
  assertRule(permanentCanEnterLine(state, playerId, target, sourceLocation.lineName, { operation: "move", sourcePermanent }), "LINE_RESTRICTION", "The chosen character cannot move to the other line.");
  player[otherLine][targetIndex] = context.permanent;
  player[sourceLocation.lineName][sourceLocation.index] = target;
  resolveCharacterMovedOutsideMovementPhase(state, playerId, sourcePermanent, sourceLocation.lineName, otherLine, context);
  resolveCharacterMovedOutsideMovementPhase(state, playerId, target, otherLine, sourceLocation.lineName, context);
}

function swapTargetsWithOtherLine(state, playerId, effect, context = {}) {
  const targets = selectPermanentTargets(state, playerId, effect.target ?? "self", context);
  for (const target of targets) {
    const player = getPlayer(state, target.playerId);
    const location = findPermanentLocation(player, target.permanent.pid);
    if (!location) continue;
    const otherLine = location.lineName === LINES.FRONT ? LINES.ENERGY : LINES.FRONT;
    const rawSwapTarget = context.choices?.[effect.swapChoiceKey ?? "swapTargetIndex"];
    const targetIndex = (rawSwapTarget && typeof rawSwapTarget === "object" ? rawSwapTarget.index : rawSwapTarget) ?? player[otherLine]
      .findIndex((permanent) => isCharacter(state, permanent));
    if (targetIndex === -1 || targetIndex === undefined) continue;
    const other = player[otherLine][targetIndex];
    if (!other || !isCharacter(state, other)) continue;
    const moved = player[location.lineName][location.index];
    if (abilityActionPreventedByAbility(state, target.playerId, moved, "move", context)
      || abilityActionPreventedByAbility(state, target.playerId, other, "move", context)) continue;
    assertRule(permanentCanEnterLine(state, target.playerId, moved, otherLine, { operation: "move", sourcePermanent: context.permanent }), "LINE_RESTRICTION", "The chosen character cannot move to the other line.");
    assertRule(permanentCanEnterLine(state, target.playerId, other, location.lineName, { operation: "move", sourcePermanent: context.permanent }), "LINE_RESTRICTION", "The other character cannot move to the chosen line.");
    player[otherLine][targetIndex] = moved;
    player[location.lineName][location.index] = other;
    resolveCharacterMovedOutsideMovementPhase(state, target.playerId, moved, location.lineName, otherLine, context);
    resolveCharacterMovedOutsideMovementPhase(state, target.playerId, other, otherLine, location.lineName, context);
  }
}

function moveOrSwapTargetsToOtherLine(state, playerId, effect, context = {}) {
  const targets = selectPermanentTargets(state, playerId, effect.target ?? { controller: "self", line: "field", type: CARD_TYPES.CHARACTER }, context);
  const rawMoveOrSwapChoices = context.choices?.[effect.swapChoiceKey ?? "moveOrSwapTargets"];
  for (let targetOrdinal = 0; targetOrdinal < targets.length; targetOrdinal += 1) {
    const target = targets[targetOrdinal];
    const player = getPlayer(state, target.playerId);
    const location = findPermanentLocation(player, target.permanent.pid);
    if (!location) continue;
    if (abilityActionPreventedByAbility(state, target.playerId, target.permanent, "move", context)) continue;
    const otherLine = location.lineName === LINES.FRONT ? LINES.ENERGY : LINES.FRONT;
    const rawChoice = Array.isArray(rawMoveOrSwapChoices)
      ? rawMoveOrSwapChoices[targetOrdinal]
      : rawMoveOrSwapChoices && typeof rawMoveOrSwapChoices === "object"
        && !rawMoveOrSwapChoices.operation && rawMoveOrSwapChoices.index === undefined && !rawMoveOrSwapChoices.permanentId
        ? rawMoveOrSwapChoices[target.permanent.pid]
        : rawMoveOrSwapChoices;
    const explicitlyMove = rawChoice === "move" || rawChoice?.operation === "move";
    const explicitlySwap = rawChoice === "swap" || rawChoice?.operation === "swap"
      || (rawChoice && typeof rawChoice === "object" && (rawChoice.index !== undefined || rawChoice.permanentId));
    if (!explicitlySwap && lineOf(player, otherLine).length < lineCapacity(state, target.playerId, otherLine)
      && permanentCanEnterLine(state, target.playerId, target.permanent, otherLine, { operation: "move", sourcePermanent: context.permanent })) {
      const permanent = removeFromLine(player, location.lineName, location.index);
      insertPermanent(state, target.playerId, otherLine, permanent, context.choices?.[effect.replaceChoiceKey ?? "replaceIndex"], {
        operation: "move",
        sourcePermanent: context.permanent,
        choices: context.choices
      });
      resolveCharacterMovedOutsideMovementPhase(state, target.playerId, permanent, location.lineName, otherLine, context);
      continue;
    }
    if (explicitlyMove) continue;
    const requestedPermanentId = rawChoice?.permanentId ?? rawChoice?.pid;
    const requestedIndex = rawChoice && typeof rawChoice === "object" ? Number(rawChoice.index) : undefined;
    const otherIndex = requestedPermanentId
      ? lineOf(player, otherLine).findIndex((permanent) => permanent.pid === requestedPermanentId)
      : Number.isInteger(requestedIndex)
        ? requestedIndex
        : lineOf(player, otherLine).findIndex((permanent) => isCharacter(state, permanent));
    if (otherIndex === -1) continue;
    const other = player[otherLine][otherIndex];
    const moved = player[location.lineName][location.index];
    if (abilityActionPreventedByAbility(state, target.playerId, other, "move", context)) continue;
    if (!permanentCanEnterLine(state, target.playerId, moved, otherLine, { operation: "move", sourcePermanent: context.permanent })) continue;
    if (!permanentCanEnterLine(state, target.playerId, other, location.lineName, { operation: "move", sourcePermanent: context.permanent })) continue;
    player[otherLine][otherIndex] = moved;
    player[location.lineName][location.index] = other;
    resolveCharacterMovedOutsideMovementPhase(state, target.playerId, moved, location.lineName, otherLine, context);
    resolveCharacterMovedOutsideMovementPhase(state, target.playerId, other, otherLine, location.lineName, context);
  }
}

function replayTargets(state, playerId, effect, context = {}) {
  const targets = selectPermanentTargets(state, playerId, effect.target ?? "self", context);
  mutateTargetsInReverse(targets, (target) => {
    if (permanentZoneMovePreventedByAbility(state, target.playerId, target.permanent, "sideline", {
      sourcePlayer: playerId,
      sourceDef: context.sourceDef,
      sourceKind: context.sourceKind,
      byAbility: true
    })) return;
    const permanent = removeFromLine(getPlayer(state, target.playerId), target.lineName, target.index);
    const sourceCard = topCard(permanent);
    movePermanentCardsToZone(state, permanent, "sideline", { sidelined: true });

    const owner = getPlayer(state, sourceCard.owner);
    const sidelineIndex = owner.sideline.findIndex((card) => card.uid === sourceCard.uid);
    if (sidelineIndex === -1) return;

    const cardRef = owner.sideline.splice(sidelineIndex, 1)[0];
    const newPermanent = createPermanent(state, target.playerId, cardRef, effect.rested ?? false);
    insertPermanent(state, target.playerId, effect.destinationLine ?? target.lineName, newPermanent, context.choices?.[effect.replaceChoiceKey ?? "replaceIndex"], {
      operation: "play",
      choices: context.choices
    });
    resolvePermanentAbilities(state, target.playerId, newPermanent, TIMINGS.WHEN_PLAYED, { permanent: newPermanent, choices: context.choices, playedByAbility: true });
  });
}

function swapOwnFrontAndEnergy(state, playerId, effect, context = {}) {
  const targetPlayerId = effect.player === "opponent" ? opponentOf(playerId) : effect.player ?? playerId;
  const player = getPlayer(state, targetPlayerId);
  const rawFront = context.choices?.[effect.frontChoiceKey ?? "frontIndex"];
  const rawEnergy = context.choices?.[effect.energyChoiceKey ?? "energyIndex"];
  const frontIndex = (rawFront && typeof rawFront === "object" ? rawFront.index : rawFront) ?? 0;
  const energyIndex = (rawEnergy && typeof rawEnergy === "object" ? rawEnergy.index : rawEnergy) ?? 0;
  const front = player.frontLine[frontIndex];
  const energy = player.energyLine[energyIndex];
  if (!front || !energy) return;
  if (abilityActionPreventedByAbility(state, targetPlayerId, front, "move", context)
    || abilityActionPreventedByAbility(state, targetPlayerId, energy, "move", context)) return;
  assertRule(permanentCanEnterLine(state, targetPlayerId, front, LINES.ENERGY, { operation: "move", sourcePermanent: context.permanent }), "LINE_RESTRICTION", "The front-line card cannot move to the energy line.");
  assertRule(permanentCanEnterLine(state, targetPlayerId, energy, LINES.FRONT, { operation: "move", sourcePermanent: context.permanent }), "LINE_RESTRICTION", "The energy-line card cannot move to the front line.");
  player.frontLine[frontIndex] = energy;
  player.energyLine[energyIndex] = front;
  resolveCharacterMovedOutsideMovementPhase(state, targetPlayerId, front, LINES.FRONT, LINES.ENERGY, context);
  resolveCharacterMovedOutsideMovementPhase(state, targetPlayerId, energy, LINES.ENERGY, LINES.FRONT, context);
}

function swapChosenTargets(state, playerId, effect, context = {}) {
  const first = selectPermanentTargets(state, playerId, effect.firstTarget ?? effect.targetA, context)[0];
  const second = selectPermanentTargets(state, playerId, effect.secondTarget ?? effect.targetB, context)[0];
  if (!first || !second) return;
  if (first.playerId !== second.playerId || first.lineName === second.lineName) return;

  const player = getPlayer(state, first.playerId);
  const firstLocation = findPermanentLocation(player, first.permanent.pid);
  const secondLocation = findPermanentLocation(player, second.permanent.pid);
  if (!firstLocation || !secondLocation || firstLocation.lineName === secondLocation.lineName) return;

  const firstPermanent = player[firstLocation.lineName][firstLocation.index];
  const secondPermanent = player[secondLocation.lineName][secondLocation.index];
  if (abilityActionPreventedByAbility(state, first.playerId, firstPermanent, "move", context)
    || abilityActionPreventedByAbility(state, first.playerId, secondPermanent, "move", context)) return;
  assertRule(permanentCanEnterLine(state, first.playerId, firstPermanent, secondLocation.lineName, { operation: "move", sourcePermanent: context.permanent }), "LINE_RESTRICTION", "The first chosen card cannot move to the other line.");
  assertRule(permanentCanEnterLine(state, first.playerId, secondPermanent, firstLocation.lineName, { operation: "move", sourcePermanent: context.permanent }), "LINE_RESTRICTION", "The second chosen card cannot move to the other line.");
  player[firstLocation.lineName][firstLocation.index] = secondPermanent;
  player[secondLocation.lineName][secondLocation.index] = firstPermanent;
  resolveCharacterMovedOutsideMovementPhase(state, first.playerId, firstPermanent, firstLocation.lineName, secondLocation.lineName, context);
  resolveCharacterMovedOutsideMovementPhase(state, first.playerId, secondPermanent, secondLocation.lineName, firstLocation.lineName, context);
}

function moveCardBetweenZones(state, playerId, effect, context = {}) {
  context.lastEffectMovedCardCount = 0;
  context.lastMovedCards = [];
  const sourcePlayerId = effect.player === "opponent" ? opponentOf(playerId) : effect.player ?? playerId;
  const destinationPlayerId = effect.destinationPlayer === "opponent" ? opponentOf(playerId) : effect.destinationPlayer ?? sourcePlayerId;
  const sourcePlayer = getPlayer(state, sourcePlayerId);
  const destinationPlayer = getPlayer(state, destinationPlayerId);
  const sourceName = effect.source ?? "sideline";
  const destinationName = effect.destination ?? "hand";
  const source = zoneOf(sourcePlayer, sourceName);
  const destination = zoneOf(destinationPlayer, destinationName);
  const count = effect.all ? source.filter((card) => cardMatchesEffectFilter(state, card, effect.filter, context)).length : effect.count ?? effect.amount ?? 1;
  const matchingEntries = source
    .map((card, index) => ({ card, index }))
    .filter(({ card }) => cardMatchesEffectFilter(state, card, effect.filter, context));
  const minimum = effect.all
    ? count
    : Math.min(matchingEntries.length, Number(effect.min ?? effect.requiredMovedCountForFollowing ?? count));
  const choiceKey = effect.choiceKey ?? `${sourceName}Index`;
  const revealedOpponentHandUids = new Set(context.revealedOpponentHandCardUids ?? []);
  const chooserKnowsSourceCards = sourceName === "hand"
    && sourcePlayerId === opponentOf(playerId)
    && matchingEntries.every(({ card }) => revealedOpponentHandUids.has(card.uid));
  if (!effect.all && matchingEntries.length > 0 && chooserKnowsSourceCards) {
    resolveRuntimeChoices(state, playerId, effect, context, {
      kind: "chooseRevealedZoneCards",
      cards: source,
      ownerId: sourcePlayerId,
      destinationPlayerId,
      sourceName,
      destinationName,
      position: effect.position,
      matchingIndices: matchingEntries.map(({ index }) => index),
      min: minimum,
      max: Math.min(count, matchingEntries.length),
      choiceKey
    });
  }
  const chosen = context.choices?.[choiceKey] ?? effect.indices;
  const defaultIndices = matchingEntries
    .slice(0, count)
    .map(({ index }) => index);
  const selectedRefs = Array.isArray(chosen) ? chosen : chosen !== undefined ? [chosen] : defaultIndices;
  assertRule(selectedRefs.length >= minimum && selectedRefs.length <= count, "ZONE_SELECTION", "A legal number of zone cards must be selected.", {
    minimum,
    count,
    selected: selectedRefs
  });
  if (selectedRefs.length === 0) return;
  const selectedIndices = selectedRefs.map((selected) => {
    if (selected?.uid) return source.findIndex((card) => card.uid === selected.uid);
    if (selected && typeof selected === "object") return selected.index;
    return selected;
  });
  assertRule(new Set(selectedIndices).size === selectedIndices.length, "ZONE_SELECTION", "The same zone card cannot be selected more than once.", {
    selected: selectedRefs
  });

  const moved = [];
  for (const chosenIndex of [...selectedIndices].sort((a, b) => b - a)) {
    assertRule(chosenIndex >= 0 && chosenIndex < source.length, "ZONE_INDEX", "Chosen zone card index is out of range.", {
      source: effect.source,
      chosenIndex
    });
    const card = source[chosenIndex];
    assertRule(cardMatchesEffectFilter(state, card, effect.filter, context), "ZONE_SELECTION", "Chosen card does not match effect filter.", {
      chosenIndex,
      filter: effect.filter
    });
    moved.unshift(source.splice(chosenIndex, 1)[0]);
  }

  if (effect.position === "top") {
    for (const card of [...moved].reverse()) {
      placeCardInZone(state, destinationPlayer, destinationName, card, { position: "top" });
      if (sourceName === "life" && destinationName === "sideline") {
        resolveLifeToSidelineNoTriggerAbilities(state, destinationPlayerId, card);
      }
      resolveSidelineToHandByAbility(state, playerId, card, sourceName, destinationName, sourcePlayerId, destinationPlayerId, context);
    }
  } else {
    for (const card of moved) {
      placeCardInZone(state, destinationPlayer, destinationName, card);
      if (sourceName === "life" && destinationName === "sideline") {
        resolveLifeToSidelineNoTriggerAbilities(state, destinationPlayerId, card);
      }
      resolveSidelineToHandByAbility(state, playerId, card, sourceName, destinationName, sourcePlayerId, destinationPlayerId, context);
    }
  }
  context.lastMovedCards = moved;
  context.lastMovedCardCount = (context.lastMovedCardCount ?? 0) + moved.length;
  context.lastEffectMovedCardCount = moved.length;
  context.lastMovedDestination = destinationName;
}

function moveEqualCountsBetweenZones(state, playerId, effect, context = {}) {
  const sourcePlayerId = effect.player === "opponent" ? opponentOf(playerId) : effect.player ?? playerId;
  const destinationPlayerId = effect.destinationPlayer === "opponent" ? opponentOf(playerId) : effect.destinationPlayer ?? sourcePlayerId;
  const sourcePlayer = getPlayer(state, sourcePlayerId);
  const destinationPlayer = getPlayer(state, destinationPlayerId);
  const sourceName = effect.source ?? "sideline";
  const destinationName = effect.destination ?? "removal";
  const source = zoneOf(sourcePlayer, sourceName);
  const filters = effect.filters ?? [];
  const counts = filters.map((filter) => source.filter((card) => cardMatchesFilter(state, card, filter)).length);
  const countEach = context.choices?.[effect.countChoiceKey ?? "equalZoneMoveCount"] ?? effect.countEach ?? Math.min(...counts);
  assertRule(countEach >= (effect.minEach ?? 0), "ZONE_SELECTION", "Not enough equal-count zone cards selected.", { countEach });
  assertRule(countEach <= Math.min(...counts), "ZONE_SELECTION", "Too many equal-count zone cards selected.", { countEach, counts });

  const moved = [];
  for (const filter of filters) {
    let movedForFilter = 0;
    for (let index = source.length - 1; index >= 0 && movedForFilter < countEach; index -= 1) {
      if (!cardMatchesFilter(state, source[index], filter)) continue;
      moved.unshift(source.splice(index, 1)[0]);
      movedForFilter += 1;
    }
  }

  for (const card of moved) {
    placeCardInZone(state, destinationPlayer, destinationName, card);
    resolveSidelineToHandByAbility(state, playerId, card, sourceName, destinationName, sourcePlayerId, destinationPlayerId, context);
  }
  context.lastMovedCards = moved;
  context.lastMovedCardCount = (context.lastMovedCardCount ?? 0) + moved.length;
  context.lastEffectMovedCardCount = moved.length;
  context.lastMovedDestination = destinationName;
}

function moveTargetsToBottomDeck(state, playerId, effect, context = {}) {
  const targets = selectPermanentTargets(state, playerId, effect.target ?? "self", context);
  mutateTargetsInReverse(targets, (target) => {
    if (permanentZoneMovePreventedByAbility(state, target.playerId, target.permanent, "deck", { sourcePlayer: playerId, byAbility: true })) return;
    const permanent = removeFromLine(getPlayer(state, target.playerId), target.lineName, target.index);
    getPlayer(state, permanent.owner).deck.push(...permanent.cards);
  });
}

function moveTargetsToDeck(state, playerId, effect, context = {}) {
  const targets = selectPermanentTargets(state, playerId, effect.target ?? "self", context);
  const position = context.choices?.[effect.positionChoiceKey ?? "deckPosition"] ?? effect.position ?? "top";
  if (effect.positions) {
    assertRule(effect.positions.includes(position), "DECK_POSITION", "Deck position is not allowed for this effect.", {
      position,
      allowed: effect.positions
    });
  }
  mutateTargetsInReverse(targets, (target) => {
    if (permanentZoneMovePreventedByAbility(state, target.playerId, target.permanent, "deck", { sourcePlayer: playerId, byAbility: true })) return;
    const permanent = removeFromLine(getPlayer(state, target.playerId), target.lineName, target.index);
    const owner = getPlayer(state, permanent.owner);
    if (position === "bottom") owner.deck.push(...permanent.cards);
    else owner.deck.unshift(...permanent.cards);
  });
}

function moveTargetsToLife(state, playerId, effect, context = {}) {
  const targets = selectPermanentTargets(state, playerId, effect.target ?? "self", context);
  mutateTargetsInReverse(targets, (target) => {
    if (permanentZoneMovePreventedByAbility(state, target.playerId, target.permanent, "life", { sourcePlayer: playerId, byAbility: true })) return;
    const permanent = removeFromLine(getPlayer(state, target.playerId), target.lineName, target.index);
    const owner = getPlayer(state, permanent.owner);
    for (const card of permanent.cards) {
      card.faceUp = effect.faceUp ?? true;
      if (effect.position === "top") owner.life.unshift(card);
      else owner.life.push(card);
    }
  });
}

function moveTopRaidCardToZone(state, playerId, effect, context = {}) {
  const targets = selectPermanentTargets(state, playerId, effect.target ?? "self", context);
  for (const target of targets) {
    if (target.permanent.cards.length <= 1) continue;
    const card = target.permanent.cards.pop();
    const destination = zoneOf(getPlayer(state, card.owner), effect.destination ?? "sideline");
    if (effect.position === "top") destination.unshift(card);
    else destination.push(card);
    target.permanent.bpDelta = 0;
    target.permanent.bpModifiers = [];
    target.permanent.keywordModifiers = [];
    target.permanent.energyModifiers = [];
    target.permanent.gainedAbilities = [];
    target.permanent.readyLocks = 0;
    target.permanent.usedOncePerTurn = [];
  }
}

function moveUnderCardsToZone(state, playerId, effect, context = {}) {
  const targets = selectPermanentTargets(state, playerId, effect.target ?? "self", context);
  let movedCount = 0;
  for (const target of targets) {
    const destination = zoneOf(getPlayer(state, target.permanent.owner), effect.destination ?? "hand");
    const count = effect.all ? Math.max(0, target.permanent.cards.length - 1) : effect.count ?? effect.amount ?? 1;
    const availableCount = Math.max(0, target.permanent.cards.length - 1);
    const moveCount = Math.min(count, availableCount);
    const choiceKey = effect.choiceKey ?? "underCardChoices";
    const requestedChoices = effect.all ? undefined : context.choices?.[choiceKey];
    const matchingChoices = Array.isArray(requestedChoices)
      ? requestedChoices.filter((choice) => !choice?.permanentId || choice.permanentId === target.permanent.pid)
      : requestedChoices !== undefined ? [requestedChoices] : undefined;
    const selectedIndices = matchingChoices
      ? matchingChoices.map((choice) => {
          if (choice && typeof choice === "object") {
            if (choice.uid) return target.permanent.cards.findIndex((card, index) => index < availableCount && card.uid === choice.uid);
            return Number(choice.underIndex ?? choice.index);
          }
          return Number(choice);
        })
      : [...Array(moveCount).keys()];
    assertRule(selectedIndices.length === moveCount, "UNDER_CARD_SELECTION", "Effect requires the correct number of under cards.", {
      selected: selectedIndices.length,
      moveCount,
      permanentId: target.permanent.pid
    });
    assertRule(new Set(selectedIndices).size === selectedIndices.length, "UNDER_CARD_SELECTION", "The same under card cannot be selected twice.", {
      selectedIndices,
      permanentId: target.permanent.pid
    });
    for (const index of selectedIndices) {
      assertRule(index >= 0 && index < availableCount, "UNDER_CARD_SELECTION", "Selected under-card index is out of range.", {
        index,
        availableCount,
        permanentId: target.permanent.pid
      });
    }
    const selectedCards = selectedIndices.map((index) => target.permanent.cards[index]);
    for (const index of [...selectedIndices].sort((left, right) => right - left)) {
      target.permanent.cards.splice(index, 1);
    }
    for (const card of selectedCards) {
      card.faceUp = effect.faceUp ?? true;
      destination.push(card);
      movedCount += 1;
    }
  }
  context.lastMovedUnderCardCount = (context.lastMovedUnderCardCount ?? 0) + movedCount;
  context.lastEffectMovedUnderCardCount = movedCount;
}

function moveHandCardsUnderPermanent(state, playerId, effect, permanent, context = {}) {
  const player = getPlayer(state, playerId);
  const count = effect.count ?? effect.amount ?? effect.max ?? 1;
  const min = effect.min ?? count;
  const chosen = context.choices?.[effect.choiceKey ?? "handIndices"] ?? effect.indices;
  const defaultIndices = player.hand
    .map((card, index) => ({ card, index }))
    .filter(({ card }) => cardMatchesFilter(state, card, effect.filter ?? {}))
    .slice(0, count)
    .map(({ index }) => index);
  const selectedRefs = Array.isArray(chosen) ? chosen : chosen !== undefined ? [chosen] : defaultIndices;
  const indices = selectedRefs.map((selected) => {
    if (selected?.uid) return player.hand.findIndex((card) => card.uid === selected.uid);
    if (selected && typeof selected === "object") return Number(selected.index);
    return Number(selected);
  });
  assertRule(indices.length >= min && indices.length <= count, "HAND_SELECTION", "Effect requires a legal hand selection count.", { min, count, indices });
  assertRule(new Set(indices).size === indices.length, "HAND_SELECTION", "The same hand card cannot be selected twice.", { indices });

  const moved = [];
  for (const index of [...indices].sort((a, b) => b - a)) {
    assertRule(index >= 0 && index < player.hand.length, "HAND_INDEX", "Hand index is out of range.", { index });
    assertRule(cardMatchesFilter(state, player.hand[index], effect.filter ?? {}), "HAND_SELECTION", "Selected hand card does not match effect filter.", {
      index,
      filter: effect.filter
    });
    moved.unshift(player.hand.splice(index, 1)[0]);
  }

  for (const card of moved) {
    card.faceUp = effect.faceUp ?? false;
    const topIndex = Math.max(0, permanent.cards.length - 1);
    permanent.cards.splice(topIndex, 0, card);
  }
  context.lastMovedFromHandCount = (context.lastMovedFromHandCount ?? 0) + moved.length;
  context.lastEffectMovedFromHandCount = moved.length;
}

function moveHandCardsUnderSelf(state, playerId, effect, context = {}) {
  assertRule(context.permanent, "EFFECT_SOURCE", "This effect requires a source permanent.");
  moveHandCardsUnderPermanent(state, playerId, effect, context.permanent, context);
}

function moveHandCardsUnderTargets(state, playerId, effect, context = {}) {
  const targets = selectPermanentTargets(state, playerId, effect.target, context);
  for (const target of targets) {
    moveHandCardsUnderPermanent(state, playerId, effect, target.permanent, context);
  }
}

function moveZoneCardsUnderSelf(state, playerId, effect, context = {}) {
  assertRule(context.permanent, "EFFECT_SOURCE", "This effect requires a source permanent.");
  for (const card of takeZoneCardsForUnder(state, playerId, effect, context)) {
    card.faceUp = effect.faceUp ?? false;
    const topIndex = Math.max(0, context.permanent.cards.length - 1);
    context.permanent.cards.splice(topIndex, 0, card);
  }
}

function moveZoneCardsUnderTargets(state, playerId, effect, context = {}) {
  const targets = selectPermanentTargets(state, playerId, effect.target, context);
  for (const target of targets) {
    for (const card of takeZoneCardsForUnder(state, playerId, effect, context)) {
      card.faceUp = effect.faceUp ?? false;
      const topIndex = Math.max(0, target.permanent.cards.length - 1);
      target.permanent.cards.splice(topIndex, 0, card);
    }
  }
}

function takeZoneCardsForUnder(state, playerId, effect, context = {}) {
  const player = getPlayer(state, playerId);
  const sourceName = effect.source ?? "sideline";
  const source = zoneOf(player, sourceName);
  const count = Math.min(
    Number(effect.count ?? effect.amount ?? 1),
    source.filter((card) => cardMatchesFilter(state, card, effect.filter ?? {})).length
  );
  const min = Math.min(count, Number(effect.min ?? count));
  const choiceKey = effect.choiceKey ?? `${sourceName}UnderCards`;
  const chosen = context.choices?.[choiceKey];
  const defaultSelections = source
    .map((card, index) => ({ card, index }))
    .filter(({ card }) => cardMatchesFilter(state, card, effect.filter ?? {}))
    .slice(0, count)
    .map(({ index }) => index);
  const selectedRefs = Array.isArray(chosen) ? chosen : chosen !== undefined ? [chosen] : defaultSelections;
  assertRule(selectedRefs.length >= min && selectedRefs.length <= count, "ZONE_SELECTION", "Effect requires a legal number of cards to move underneath.", {
    selected: selectedRefs.length,
    min,
    count,
    source: sourceName
  });
  const selectedIndices = selectedRefs.map((selected) => {
    if (selected?.uid) return source.findIndex((card) => card.uid === selected.uid);
    if (selected && typeof selected === "object") return Number(selected.index);
    return Number(selected);
  });
  assertRule(new Set(selectedIndices).size === selectedIndices.length, "ZONE_SELECTION", "The same zone card cannot be moved underneath twice.", {
    selectedIndices
  });
  for (const index of selectedIndices) {
    assertRule(index >= 0 && index < source.length, "ZONE_SELECTION", "Selected under-source card does not exist.", { index, source: sourceName });
    assertRule(cardMatchesFilter(state, source[index], effect.filter ?? {}), "ZONE_SELECTION", "Selected card does not match the under-card filter.", {
      index,
      filter: effect.filter
    });
  }
  const cards = selectedIndices.map((index) => source[index]);
  for (const index of [...selectedIndices].sort((left, right) => right - left)) source.splice(index, 1);
  return cards;
}

function placeTopDeckUnderTargets(state, playerId, effect, context = {}) {
  const player = getPlayer(state, playerId);
  const targets = selectPermanentTargets(state, playerId, effect.target ?? "self", context);
  const count = effect.count ?? effect.amount ?? 1;
  for (const target of targets) {
    for (let i = 0; i < count; i += 1) {
      if (player.deck.length === 0) break;
      const card = player.deck.shift();
      card.faceUp = effect.faceUp ?? false;
      const topIndex = Math.max(0, target.permanent.cards.length - 1);
      target.permanent.cards.splice(topIndex, 0, card);
    }
  }
}

function moveSelfCardToDeckTop(state, playerId, effect, context = {}) {
  assertRule(context.permanent, "EFFECT_SOURCE", "This effect requires a source permanent.");
  const card = topCard(context.permanent);
  const owner = getPlayer(state, card.owner);
  for (const zoneName of ["sideline", "removal", "hand"]) {
    const zone = zoneOf(owner, zoneName);
    const index = zone.findIndex((candidate) => candidate.uid === card.uid);
    if (index !== -1) {
      owner.deck.unshift(zone.splice(index, 1)[0]);
      return;
    }
  }
}

function moveSelfCardToZone(state, playerId, effect, context = {}) {
  const card = context.card ?? (context.permanent ? topCard(context.permanent) : undefined);
  assertRule(card, "EFFECT_SOURCE", "This effect requires a source card.");
  const owner = getPlayer(state, card.owner);

  if (context.permanent) {
    const location = findPermanentLocation(getPlayer(state, context.permanent.controller), context.permanent.pid);
    if (location) {
      removePermanentToZone(state, context.permanent.controller, location.lineName, location.index, effect.destination ?? "hand", {
        sidelined: effect.destination === "sideline",
        sourcePlayer: playerId,
        byAbility: true,
        sourceDef: context.sourceDef,
        sourceKind: context.sourceKind,
        choices: context.choices
      });
      return;
    }
  }

  for (const zoneName of ["sideline", "removal", "hand", "life"]) {
    const zone = zoneOf(owner, zoneName);
    const index = zone.findIndex((candidate) => candidate.uid === card.uid);
    if (index !== -1) {
      const destination = zoneOf(owner, effect.destination ?? "hand");
      const moved = zone.splice(index, 1)[0];
      if (effect.position === "top") destination.unshift(moved);
      else destination.push(moved);
      return;
    }
  }
}

function moveSelfCardUnderTarget(state, playerId, effect, context = {}) {
  const card = context.card ?? (context.permanent ? topCard(context.permanent) : undefined);
  assertRule(card, "EFFECT_SOURCE", "This effect requires a source card.");
  const targets = selectPermanentTargets(state, playerId, effect.target, context);
  if (targets.length === 0) return;
  const target = targets[0].permanent;

  if (context.permanent) {
    const location = findPermanentLocation(getPlayer(state, context.permanent.controller), context.permanent.pid);
    if (location) removeFromLine(getPlayer(state, context.permanent.controller), location.lineName, location.index);
  } else {
    const owner = getPlayer(state, card.owner);
    for (const zoneName of ["sideline", "hand", "removal"]) {
      const zone = zoneOf(owner, zoneName);
      const index = zone.findIndex((candidate) => candidate.uid === card.uid);
      if (index !== -1) {
        zone.splice(index, 1);
        break;
      }
    }
  }

  card.faceUp = effect.faceUp ?? false;
  const topIndex = Math.max(0, target.cards.length - 1);
  target.cards.splice(topIndex, 0, card);
}

function moveAllHandToZone(state, playerId, effect, context = {}) {
  const player = getPlayer(state, playerId);
  const destinationName = effect.destination ?? "sideline";
  let movedCount = 0;
  if (!effect.filter) {
    for (const card of player.hand.splice(0)) {
      placeHandCardInZone(state, playerId, player, destinationName, card, {}, context);
      movedCount += 1;
    }
    context.lastMovedFromHandCount = (context.lastMovedFromHandCount ?? 0) + movedCount;
    context.lastEffectMovedFromHandCount = movedCount;
    return;
  }
  for (let index = player.hand.length - 1; index >= 0; index -= 1) {
    if (!cardMatchesFilter(state, player.hand[index], effect.filter)) continue;
    const [card] = player.hand.splice(index, 1);
    placeHandCardInZone(state, playerId, player, destinationName, card, { position: "top" }, context);
    movedCount += 1;
  }
  context.lastMovedFromHandCount = (context.lastMovedFromHandCount ?? 0) + movedCount;
  context.lastEffectMovedFromHandCount = movedCount;
}

function moveBaseCardFromSelf(state, playerId, effect, context = {}) {
  assertRule(context.permanent, "EFFECT_SOURCE", "This effect requires a source permanent.");
  if (context.permanent.cards.length <= 1) return;
  const card = context.permanent.cards.splice(0, 1)[0];
  if (effect.faceUp !== undefined) card.faceUp = effect.faceUp;
  zoneOf(getPlayer(state, card.owner), effect.destination ?? "hand").push(card);
}

function playBaseCardFromSelf(state, playerId, effect, context = {}) {
  assertRule(context.permanent, "EFFECT_SOURCE", "This effect requires a source permanent.");
  if (context.permanent.cards.length <= 1) return;
  const card = context.permanent.cards.splice(0, 1)[0];
  const permanent = createPermanent(state, playerId, card, effect.rested ?? true);
  insertPermanent(state, playerId, effect.destinationLine ?? LINES.FRONT, permanent, context.choices?.[effect.replaceChoiceKey ?? "replaceIndex"], {
    operation: "play",
    choices: context.choices
  });
  resolvePermanentAbilities(state, playerId, permanent, TIMINGS.WHEN_PLAYED, { permanent, choices: context.choices, playedByAbility: true });
}

function sidelineTargetsThenActivateSourceWhenPlayed(state, playerId, effect, context = {}) {
  assertRule(context.permanent, "EFFECT_SOURCE", "This effect requires a source permanent.");
  const targets = selectPermanentTargets(state, playerId, effect.target ?? "self", context);
  const removed = [];
  mutateTargetsInReverse(targets, (target) => {
    removed.push(removePermanentToZone(state, target.playerId, target.lineName, target.index, "sideline", { sidelined: false, sourcePlayer: playerId, sourceDef: context.sourceDef, sourceKind: context.sourceKind, byAbility: true, choices: context.choices }));
  });
  if (removed.length === 0) return;

  const actions = {
    whenPlayed: () => resolvePermanentAbilities(state, playerId, context.permanent, TIMINGS.WHEN_PLAYED, {
      ...context,
      permanent: context.permanent
    }),
    whenSidelined: () => {
      for (const permanent of removed) {
        resolvePermanentAbilities(state, permanent.controller, permanent, TIMINGS.WHEN_SIDELINED, { permanent, choices: context.choices });
      }
    }
  };

  const order = context.choices?.[effect.orderChoiceKey ?? "simultaneousAbilityOrder"] ?? ["whenPlayed", "whenSidelined"];
  for (const item of order) {
    assertRule(actions[item], "EFFECT_CHOICE", `Unknown simultaneous ability order item: ${item}`, { order });
    actions[item]();
  }
}

function opponentMaySidelineChosenTargetsElse(state, playerId, effect, context = {}) {
  const chosenTargets = [];
  for (const selector of effect.targets ?? []) {
    chosenTargets.push(...selectPermanentTargets(state, playerId, selector, context));
  }

  if (chosenTargets.length === 0) {
    if (effect.elseEffect) resolveEffect(state, playerId, effect.elseEffect, context);
    return;
  }

  resolveRuntimeChoices(state, opponentOf(playerId), effect, context, {
    kind: "opponentMaySidelineChosenTargetsElse",
    cards: [],
    ownerId: opponentOf(playerId),
    initiatingPlayerId: playerId,
    targets: chosenTargets.map((target) => ({
      player: target.playerId,
      line: target.lineName,
      index: target.index,
      permanentId: target.permanent.pid
    }))
  });

  const choice = context.choices?.[effect.choiceKey ?? "opponentSidelineChoice"];
  if (choice === false || choice === null || choice === "decline") {
    if (effect.elseEffect) resolveEffect(state, playerId, effect.elseEffect, context);
    return;
  }

  const defaultChoice = chosenTargets
    .map((target, index) => ({ index, score: battlePower(state, target.permanent) + (target.lineName === LINES.FRONT ? 500 : 0) }))
    .sort((a, b) => a.score - b.score)[0]?.index ?? 0;
  const target = chosenTargets[Number.isInteger(choice) ? choice : defaultChoice];
  if (!target) {
    if (effect.elseEffect) resolveEffect(state, playerId, effect.elseEffect, context);
    return;
  }
  removePermanentToZone(state, target.playerId, target.lineName, target.index, "sideline", {
    sidelined: true,
    sourcePlayer: playerId,
    sourceDef: context.sourceDef,
    sourceKind: context.sourceKind,
    byAbility: true,
    choices: context.choices
  });
}

function opponentMayMoveCardsBetweenZonesElse(state, playerId, effect, context = {}) {
  const opponentId = opponentOf(playerId);
  const opponent = getPlayer(state, opponentId);
  const sourceName = effect.source ?? "sideline";
  const destinationName = effect.destination ?? "removal";
  const source = zoneOf(opponent, sourceName);
  const count = effect.count ?? effect.amount ?? 1;
  const matching = source
    .map((card, index) => ({ card, index }))
    .filter(({ card }) => cardMatchesFilter(state, card, effect.filter ?? {}));
  const canMove = matching.length >= count;
  resolveRuntimeChoices(state, opponentId, effect, context, {
    kind: "opponentMayMoveCardsBetweenZonesElse",
    cards: source,
    ownerId: opponentId,
    initiatingPlayerId: playerId,
    sourceName,
    destinationName,
    matchingIndices: matching.map(({ index }) => index),
    count,
    canMove
  });
  const choice = context.choices?.[effect.choiceKey ?? "opponentZoneMoveChoice"];

  if (canMove && choice !== false && choice !== "decline") {
    const chosenRefs = context.choices?.[effect.indicesChoiceKey ?? "opponentZoneMoveIndices"]
      ?? matching.slice(0, count).map(({ index }) => index);
    const chosenIndices = chosenRefs.map((selected) => {
      if (selected?.uid) return source.findIndex((card) => card.uid === selected.uid);
      if (selected && typeof selected === "object") return Number(selected.index);
      return Number(selected);
    });
    assertRule(chosenIndices.length === count, "ZONE_SELECTION", "Opponent zone move requires the exact card count.", {
      count,
      chosenIndices
    });
    const moved = [];
    for (const index of [...chosenIndices].sort((a, b) => b - a)) {
      assertRule(index >= 0 && index < source.length, "ZONE_SELECTION", "Chosen opponent zone card index is out of range.", {
        index,
        source: sourceName
      });
      assertRule(cardMatchesFilter(state, source[index], effect.filter ?? {}), "ZONE_SELECTION", "Chosen opponent zone card does not match filter.", {
        index,
        filter: effect.filter
      });
      moved.unshift(source.splice(index, 1)[0]);
    }
    const destinationPlayer = effect.destinationPlayer === "self" ? getPlayer(state, playerId) : opponent;
    zoneOf(destinationPlayer, destinationName).push(...moved);
    context.lastOpponentMovedCardCount = moved.length;
    resolveEffect(state, playerId, effect.ifMovedEffect, context);
    return;
  }

  resolveEffect(state, playerId, effect.elseEffect, context);
}

function reduceNextUseApCost(state, playerId, effect) {
  state.continuousEffects.push({
    kind: "apCostReduction",
    controller: playerId,
    amount: effect.amount ?? 1,
    filter: effect.filter ?? {},
    sourceZone: effect.sourceZone,
    sourceZones: effect.sourceZones,
    expires: effect.expires ?? "endOfTurn"
  });
}

function totalEnergyGeneration(state, playerId) {
  return getPlayer(state, playerId).energyLine
    .reduce((total, permanent) => total + permanentEnergyGeneration(state, permanent), 0);
}

function permanentMatchesConditionFilter(state, permanent, filter = {}) {
  const {
    anyOf,
    active,
    rested,
    raided,
    notRaided,
    bpMin,
    bpMax,
    ...definitionFilter
  } = filter;
  if (anyOf && !anyOf.some((child) => permanentMatchesConditionFilter(state, permanent, child))) return false;
  if (!cardDefMatchesFilter(topDef(state, permanent), definitionFilter)) return false;
  if (active !== undefined && permanent.rested === active) return false;
  if (rested !== undefined && permanent.rested !== rested) return false;
  if (raided && permanent.cards.length <= 1) return false;
  if (notRaided && permanent.cards.length > 1) return false;
  if (bpMin !== undefined && battlePower(state, permanent) < bpMin) return false;
  if (bpMax !== undefined && battlePower(state, permanent) > bpMax) return false;
  return true;
}

function countFieldMatches(state, playerId, filter = {}, { otherThanPermanent } = {}) {
  const player = getPlayer(state, playerId);
  return [...player.frontLine, ...player.energyLine].filter((permanent) => {
    if (otherThanPermanent && permanent.pid === otherThanPermanent.pid) return false;
    return permanentMatchesConditionFilter(state, permanent, filter);
  }).length;
}

function countZoneMatches(state, playerId, zoneName, filter = {}) {
  return zoneOf(getPlayer(state, playerId), zoneName).filter((card) => cardMatchesFilter(state, card, filter)).length;
}

export function conditionMet(state, playerId, condition = {}, context = {}) {
  if (!condition || Object.keys(condition).length === 0) return true;
  if (condition.allOf) return condition.allOf.every((childCondition) => conditionMet(state, playerId, childCondition, context));
  if (condition.anyOf) return condition.anyOf.some((childCondition) => conditionMet(state, playerId, childCondition, context));
  const player = getPlayer(state, playerId);
  const opponent = getOpponent(state, playerId);

  if (condition.turn === "controller" && state.activePlayer !== playerId) return false;
  if (condition.turn === "opponent" && state.activePlayer === playerId) return false;
  if (condition.performingRaid && !context.performingRaid) return false;
  if (condition.emptyField && player.frontLine.length + player.energyLine.length !== 0) return false;
  if (condition.sourceLine) {
    if (!context.permanent) return false;
    const location = findPermanentLocation(player, context.permanent.pid);
    if (location?.lineName !== condition.sourceLine) return false;
  }
  if (condition.playedThisTurn && !context.permanent?.playedThisTurn) return false;
  if (condition.playedByAbility && !context.playedByAbility) return false;
  if (condition.selfBpMin !== undefined && (!context.permanent || battlePower(state, context.permanent) < condition.selfBpMin)) return false;
  if (condition.lifeMax !== undefined && player.life.length > condition.lifeMax) return false;
  if (condition.lifeMin !== undefined && player.life.length < condition.lifeMin) return false;
  if (condition.combinedLifeMax !== undefined && player.life.length + opponent.life.length > condition.combinedLifeMax) return false;
  if (condition.handSizeMax !== undefined && player.hand.length > condition.handSizeMax) return false;
  if (condition.handSizeMin !== undefined && player.hand.length < condition.handSizeMin) return false;
  if (condition.handOtherCardsMin !== undefined && Math.max(0, player.hand.length - 1) < condition.handOtherCardsMin) return false;
  if (condition.deckCountMax !== undefined && player.deck.length > condition.deckCountMax) return false;
  if (condition.noCardsInHand && player.hand.length !== 0) return false;
  if (condition.lessCardsInHandThanOpponent && player.hand.length >= opponent.hand.length) return false;
  if (condition.opponentLifeMax !== undefined && opponent.life.length > condition.opponentLifeMax) return false;
  if (condition.opponentLifeMin !== undefined && opponent.life.length < condition.opponentLifeMin) return false;
  if (condition.energyGenerationMin !== undefined && totalEnergyGeneration(state, playerId) < condition.energyGenerationMin) return false;
  if (condition.equalEnergyGenerationWithOpponent
    && totalEnergyGeneration(state, playerId) !== totalEnergyGeneration(state, opponentOf(playerId))) return false;
  if (condition.energyAvailableMin) {
    const available = energyAvailable(state, playerId);
    const color = condition.energyAvailableMin.color;
    if ((available[color] ?? 0) < (condition.energyAvailableMin.amount ?? 0)) return false;
  }
  if (condition.characterSidelinedThisTurn) {
    const flagPlayerId = condition.characterSidelinedThisTurn === "opponent" ? opponentOf(playerId) : playerId;
    if (!state.turnFlags?.[flagPlayerId]?.characterSidelined) return false;
  }
  if (condition.sidelinedCharacter) {
    if (!context.sidelinedPermanent) return false;
    if (!cardDefMatchesFilter(topDef(state, context.sidelinedPermanent), condition.sidelinedCharacter)) return false;
  }
  if (condition.eventUsedThisTurn) {
    const flagPlayerId = condition.eventUsedThisTurn === "opponent" ? opponentOf(playerId) : playerId;
    if (!state.turnFlags?.[flagPlayerId]?.eventUsed) return false;
  }
  if (condition.eventUsedCountMin !== undefined && (state.turnFlags?.[playerId]?.eventUsedCount ?? 0) < condition.eventUsedCountMin) return false;
  if (condition.extraDrawUsedThisTurn && !state.turnFlags?.[playerId]?.extraDrawUsed) return false;
  if (condition.handToSidelineByAbilityThisTurn && !state.turnFlags?.[playerId]?.handToSidelineByAbility) return false;
  if (condition.deckToSidelineByAbilityThisTurn && !state.turnFlags?.[playerId]?.deckToSidelineByAbility) return false;
  if (condition.handToSidelineSourceThisTurn) {
    const sourceIds = state.turnFlags?.[playerId]?.handToSidelineSources ?? [];
    if (!sourceIds.some((id) => state.catalog[id] && cardDefMatchesFilter(state.catalog[id], condition.handToSidelineSourceThisTurn))) return false;
  }
  if (condition.sidelineToHandByAbilityThisTurn && !state.turnFlags?.[playerId]?.sidelineToHandByAbility) return false;
  if (condition.selfMovedThisTurn && (!context.permanent || !state.turnFlags?.[playerId]?.movedPermanentIds?.includes(context.permanent.pid))) return false;
  if (condition.movedSelfOutsideMovementThisTurn && (!context.permanent || !state.turnFlags?.[playerId]?.movedOutsideMovementPermanentIds?.includes(context.permanent.pid))) return false;
  if (condition.movedPermanentSelf && (!context.permanent || context.movedPermanent?.pid !== context.permanent.pid)) return false;
  if (condition.apPaidAbilityUsedThisTurn && !state.turnFlags?.[playerId]?.apPaidAbilityUsed) return false;
  if (condition.apPaidDuringAttackPhase && !state.turnFlags?.[playerId]?.apPaidDuringAttackPhase) return false;
  if (condition.usedFromHandThisTurn) {
    const usedIds = state.turnFlags?.[playerId]?.usedFromHandCardIds ?? [];
    if (!usedIds.some((id) => state.catalog[id] && cardDefMatchesFilter(state.catalog[id], condition.usedFromHandThisTurn))) return false;
  }
  if (condition.anyTriggerAbilityActivatedThisTurn
    && !state.turnFlags?.[playerId]?.triggerAbilityActivated
    && !state.turnFlags?.[opponentOf(playerId)]?.triggerAbilityActivated) return false;
  if (condition.lastSearchSelectedMin !== undefined && (context.lastSearchSelectedCount ?? 0) < condition.lastSearchSelectedMin) return false;
  if (condition.lastSearchSelectedCardFilter) {
    const selected = context.lastSearchSelectedCards ?? [];
    if (selected.length === 0 || !selected.every((card) => cardMatchesFilter(state, card, condition.lastSearchSelectedCardFilter))) return false;
  }
  if (condition.lastMovedCardFilter) {
    const moved = context.lastMovedCards ?? [];
    if (moved.length === 0 || !moved.some((card) => cardMatchesFilter(state, card, condition.lastMovedCardFilter))) return false;
  }
  if (condition.lastRevealedHandCountMin !== undefined && (context.lastRevealedHandCount ?? 0) < condition.lastRevealedHandCountMin) return false;
  if (condition.lastSidelinedTargetCountMin !== undefined && (context.lastSidelinedTargetCount ?? 0) < condition.lastSidelinedTargetCountMin) return false;
  if (condition.lastSidelinedBpMin !== undefined && (context.lastSidelinedBp ?? 0) < condition.lastSidelinedBpMin) return false;
  if (condition.playedCharacterWithTriggerTypeThisTurn) {
    const triggerType = String(condition.playedCharacterWithTriggerTypeThisTurn).toLowerCase();
    if (!state.turnFlags?.[playerId]?.playedCharacterTriggerTypes?.some((type) => String(type).toLowerCase() === triggerType)) return false;
  }
  if (condition.attackingKeyword) {
    if (!context.attacker || !hasKeyword(state, context.attacker, condition.attackingKeyword)) return false;
  }
  if (condition.hasFaceDownUnder) {
    if (!context.permanent || !context.permanent.cards.slice(0, -1).some((card) => card.faceUp === false)) return false;
  }
  if (condition.sidelineCountMin !== undefined && player.sideline.length < condition.sidelineCountMin) return false;
  if (condition.energyLineCountMin !== undefined && player.energyLine.length < condition.energyLineCountMin) return false;
  if (condition.fieldCountMin !== undefined) {
    const countPlayerId = condition.fieldController === "opponent" ? opponentOf(playerId) : playerId;
    const count = countFieldMatches(state, countPlayerId, condition.filter ?? {}, {
      otherThanPermanent: condition.otherThanSource ? context.permanent : undefined
    });
    if (count < condition.fieldCountMin) return false;
  }
  if (condition.frontLineCountMin !== undefined) {
    const countPlayerId = condition.fieldController === "opponent" ? opponentOf(playerId) : playerId;
    const count = getPlayer(state, countPlayerId).frontLine
      .filter((permanent) => !(condition.otherThanSource && context.permanent?.pid === permanent.pid))
      .filter((permanent) => permanentMatchesConditionFilter(state, permanent, condition.filter ?? {}))
      .length;
    if (count < condition.frontLineCountMin) return false;
  }
  if (condition.frontLineCountMax !== undefined) {
    const countPlayerId = condition.fieldController === "opponent" ? opponentOf(playerId) : playerId;
    const count = getPlayer(state, countPlayerId).frontLine
      .filter((permanent) => !(condition.otherThanSource && context.permanent?.pid === permanent.pid))
      .filter((permanent) => permanentMatchesConditionFilter(state, permanent, condition.filter ?? {}))
      .length;
    if (count > condition.frontLineCountMax) return false;
  }
  if (condition.fieldCountMax !== undefined) {
    const countPlayerId = condition.fieldController === "opponent" ? opponentOf(playerId) : playerId;
    const count = countFieldMatches(state, countPlayerId, condition.filter ?? {}, {
      otherThanPermanent: condition.otherThanSource ? context.permanent : undefined
    });
    if (count > condition.fieldCountMax) return false;
  }
  if (condition.frontLineCountAtLeastOpponent) {
    const selfCount = player.frontLine.filter((permanent) => cardDefMatchesFilter(topDef(state, permanent), condition.filter ?? {})).length;
    const opponentCount = opponent.frontLine.filter((permanent) => cardDefMatchesFilter(topDef(state, permanent), condition.filter ?? {})).length;
    if (selfCount < opponentCount) return false;
  }
  if (condition.sameLineCountMin !== undefined) {
    if (!context.permanent) return false;
    const location = findPermanentLocation(player, context.permanent.pid);
    if (!location) return false;
    const count = lineOf(player, location.lineName)
      .filter((permanent) => !(condition.otherThanSource && permanent.pid === context.permanent.pid))
      .filter((permanent) => permanentMatchesConditionFilter(state, permanent, condition.filter ?? {}))
      .length;
    if (count < condition.sameLineCountMin) return false;
  }
  if (condition.zoneCountMin !== undefined) {
    const count = countZoneMatches(state, playerId, condition.zone ?? "sideline", condition.filter ?? {});
    if (count < condition.zoneCountMin) return false;
  }
  if (condition.uniqueZoneNameCountMin !== undefined) {
    const zone = zoneOf(player, condition.zone ?? "sideline");
    const names = new Set(zone
      .filter((card) => cardDefMatchesFilter(defOf(state, card), condition.filter ?? {}))
      .map((card) => defOf(state, card).name.toLowerCase()));
    if (names.size < condition.uniqueZoneNameCountMin) return false;
  }
  if (condition.combinedZoneCountMin !== undefined) {
    const count = (condition.zones ?? ["sideline", "removal"])
      .reduce((total, zoneName) => total + countZoneMatches(state, playerId, zoneName, condition.filter ?? {}), 0);
    if (count < condition.combinedZoneCountMin) return false;
  }
  if (condition.combinedFieldAndUnderFaceDownCountMin !== undefined) {
    const field = [...player.frontLine, ...player.energyLine];
    const fieldCount = field.filter((permanent) => cardDefMatchesFilter(topDef(state, permanent), condition.filter ?? {})).length;
    const underCount = field.reduce((total, permanent) => {
      if (!isCharacter(state, permanent)) return total;
      return total + permanent.cards.slice(0, -1).filter((card) => card.faceUp === false).length;
    }, 0);
    if (fieldCount + underCount < condition.combinedFieldAndUnderFaceDownCountMin) return false;
  }
  if (condition.uniqueFieldNameCountMin !== undefined) {
    const names = new Set([...player.frontLine, ...player.energyLine]
      .filter((permanent) => permanentMatchesConditionFilter(state, permanent, condition.filter ?? {}))
      .map((permanent) => topDef(state, permanent).name.toLowerCase()));
    if (names.size < condition.uniqueFieldNameCountMin) return false;
  }
  if (condition.differentRequiredEnergyValuesInSidelineMin !== undefined) {
    const values = new Set(player.sideline.map((card) => defOf(state, card).requiredEnergy?.amount ?? 0));
    if (values.size < condition.differentRequiredEnergyValuesInSidelineMin) return false;
  }
  if (condition.namedOnField && countFieldMatches(state, playerId, { name: condition.namedOnField }) === 0) return false;
  if (condition.namedOnFrontLine && !player.frontLine.some((permanent) => cardDefHasName(topDef(state, permanent), condition.namedOnFrontLine))) return false;
  if (condition.namedNotOnField && countFieldMatches(state, playerId, { name: condition.namedNotOnField }) > 0) return false;
  if (condition.activeNamedOnField) {
    const field = [...player.frontLine, ...player.energyLine];
    if (!field.some((permanent) => !permanent.rested && cardDefHasName(topDef(state, permanent), condition.activeNamedOnField))) return false;
  }
  if (condition.activeNamedOnFrontLine && !player.frontLine.some((permanent) => !permanent.rested && cardDefHasName(topDef(state, permanent), condition.activeNamedOnFrontLine))) return false;
  if (condition.opponentFieldAnyColor) {
    const colors = condition.opponentFieldAnyColor.map((color) => String(color).toLowerCase());
    const opponentField = [...opponent.frontLine, ...opponent.energyLine];
    if (!opponentField.some((permanent) => colors.includes(topDef(state, permanent).color))) return false;
  }
  if (condition.restingFrontCharactersMin !== undefined) {
    const count = player.frontLine.filter((permanent) => permanent.rested && isCharacter(state, permanent)).length;
    if (count < condition.restingFrontCharactersMin) return false;
  }
  if (condition.opponentFrontLineNotFull
    && opponent.frontLine.length >= lineCapacity(state, opponentOf(playerId), LINES.FRONT)) return false;
  if (condition.fieldBpAboveBase) {
    const field = [...player.frontLine, ...player.energyLine];
    if (!field.some((permanent) => battlePower(state, permanent) > (topDef(state, permanent).bp ?? 0))) return false;
  }
  if (condition.anyFaceUpDeckOrLife) {
    const zones = [player.deck, player.life, opponent.deck, opponent.life];
    if (!zones.some((zone) => zone.some((card) => card.faceUp))) return false;
  }
  if (condition.topDeckFaceUp && !player.deck[0]?.faceUp) return false;
  if (condition.faceUpDeckOrLifeCountMin !== undefined) {
    const zones = [player.deck, player.life, opponent.deck, opponent.life];
    const count = zones.reduce((total, zone) => total + zone.filter((card) => card.faceUp).length, 0);
    if (count < condition.faceUpDeckOrLifeCountMin) return false;
  }
  if (condition.nameContainsOnField) {
    const field = [...player.frontLine, ...player.energyLine];
    if (!field.some((permanent) => namesOfCardDef(topDef(state, permanent))
      .some((name) => name.toLowerCase().includes(String(condition.nameContainsOnField).toLowerCase())))) return false;
  }
  if (condition.nameContainsAllOnField) {
    const needles = condition.nameContainsAllOnField.map((item) => String(item).toLowerCase());
    const field = [...player.frontLine, ...player.energyLine];
    if (!field.some((permanent) => {
      return namesOfCardDef(topDef(state, permanent)).some((name) => {
        const normalized = name.toLowerCase();
        return needles.every((needle) => normalized.includes(needle));
      });
    })) return false;
  }
  if (condition.noAffinitiesOnField) {
    const field = [...player.frontLine, ...player.energyLine];
    if (field.some((permanent) => (topDef(state, permanent).affinities ?? []).length > 0)) return false;
  }
  if (condition.selfUnderFaceDownCardsMin !== undefined
    && (!context.permanent || context.permanent.cards.slice(0, -1).filter((card) => card.faceUp === false).length < condition.selfUnderFaceDownCardsMin)) return false;
  if (condition.selfUnderCardsMin !== undefined && (!context.permanent || Math.max(0, context.permanent.cards.length - 1) < condition.selfUnderCardsMin)) return false;
  if (condition.lastMovedUnderCardMin !== undefined && (context.lastEffectMovedUnderCardCount ?? context.lastMovedUnderCardCount ?? 0) < condition.lastMovedUnderCardMin) return false;
  if (condition.lastMovedFromHandMin !== undefined && (context.lastMovedFromHandCount ?? 0) < condition.lastMovedFromHandMin) return false;
  if (condition.lastRestedRequiredEnergyMin !== undefined && (context.lastRestedRequiredEnergyTotal ?? 0) < condition.lastRestedRequiredEnergyMin) return false;
  if (condition.lastMoveToLineRemovalCountMax !== undefined && (context.lastMoveToLineRemovalCount ?? 0) > condition.lastMoveToLineRemovalCountMax) return false;
  if (condition.lastMoveToLineRemovalCountMin !== undefined && (context.lastMoveToLineRemovalCount ?? 0) < condition.lastMoveToLineRemovalCountMin) return false;
  if (condition.allFieldHaveAffinity) {
    const field = [...player.frontLine, ...player.energyLine];
    if (field.length === 0 || field.some((permanent) => !includesText(topDef(state, permanent).affinities, condition.allFieldHaveAffinity))) return false;
  }
  return true;
}

function canPayEffectCost(state, playerId, effect) {
  if (!effect) return true;
  if (effect.kind === "sequence") return (effect.effects ?? []).every((childEffect) => canPayEffectCost(state, playerId, childEffect));
  if (effect.kind === "payAp") return activeAp(getPlayer(state, playerId)) >= (effect.amount ?? 1);
  if (effect.kind !== "moveHandToZone") return true;
  const player = getPlayer(state, playerId);
  const count = effect.count ?? effect.amount ?? 1;
  const matching = effect.filter
    ? player.hand.filter((card) => cardMatchesFilter(state, card, effect.filter)).length
    : player.hand.length;
  return matching >= (effect.min ?? count);
}

function canStartOptionalEffect(state, playerId, effect, context = {}) {
  const first = effect?.kind === "sequence" ? effect.effects?.[0] : effect;
  if (!first) return true;
  if (first.kind === "playSourceFromZone") {
    const found = findSourceCardInZone(state, playerId, context, first.source ?? "sideline");
    if (!found) return false;
    const cardDef = defOf(state, found.card);
    if (first.requiredEnergyFulfilled
      && !hasRequiredEnergy(state, playerId, cardDef, { sourceZone: found.zoneName })) return false;
    const allowedLines = first.destinationLines?.length
      ? first.destinationLines
      : [first.destinationLine ?? LINES.FRONT];
    return allowedLines.some((lineName) => cardCanEnterLine(state, playerId, cardDef, lineName, { operation: "play" }));
  }
  if (!["moveHandToZone", "payAp"].includes(first.kind)) return true;
  return canPayEffectCost(state, playerId, first);
}

function drawUntilHandSize(state, playerId, effect) {
  const targetPlayerId = effect.player === "opponent" ? opponentOf(playerId) : playerId;
  const player = getPlayer(state, targetPlayerId);
  const targetSize = effect.sameAsOpponent ? getPlayer(state, opponentOf(targetPlayerId)).hand.length : effect.handSize ?? 0;
  const amount = Math.max(0, targetSize - player.hand.length);
  drawCards(state, targetPlayerId, amount);
}

function scheduleSidelineTargetsAndMoveSelfToEnergy(state, playerId, effect, context = {}) {
  const targets = selectPermanentTargets(state, playerId, effect.target ?? opponentFrontCharacter({ max: 1 }), context);
  state.delayedEffects.push({
    timing: "startOfTurn",
    activePlayer: opponentOf(playerId),
    kind: "sidelinePermanentsAndMoveSourceToEnergy",
    controller: playerId,
    permanentIds: targets.map((target) => target.permanent.pid),
    sourcePermanentId: context.permanent?.pid
  });
}

function scheduleReturnTargetsToHand(state, playerId, effect, context = {}) {
  const targets = selectPermanentTargets(state, playerId, effect.target ?? "self", context);
  const activePlayer = effect.activePlayer === "opponent"
    ? opponentOf(playerId)
    : effect.activePlayer === "controller" ? playerId : effect.activePlayer ?? state.activePlayer;
  state.delayedEffects.push({
    timing: effect.timing ?? "endOfAttack",
    activePlayer,
    kind: "returnPermanentsToHand",
    controller: playerId,
    permanentIds: targets.map((target) => target.permanent.pid)
  });
}

function scheduleLastPlayedPermanentToZone(state, playerId, effect, context = {}) {
  const permanents = context.lastPlayedPermanents?.length > 0
    ? context.lastPlayedPermanents
    : context.lastPlayedPermanent ? [context.lastPlayedPermanent] : [];
  if (permanents.length === 0) return;
  state.delayedEffects.push({
    timing: effect.timing ?? TIMINGS.START_OF_END_PHASE,
    activePlayer: effect.activePlayer === "opponent" ? opponentOf(playerId) : effect.activePlayer ?? state.activePlayer,
    kind: "movePermanentsToZone",
    controller: playerId,
    zone: effect.zone ?? "sideline",
    sidelined: effect.sidelined ?? (effect.zone ?? "sideline") === "sideline",
    permanentIds: permanents.map((permanent) => permanent.pid)
  });
}

function uniqueRevealedAndFieldNameCount(state, playerId, effect, context = {}) {
  const player = getPlayer(state, playerId);
  const names = new Set();

  for (const card of revealHandCardsForEffect(state, playerId, effect, context)) {
    names.add(defOf(state, card).name.toLowerCase());
  }

  if (effect.includeField !== false) {
    for (const permanent of [...player.frontLine, ...player.energyLine]) {
      const def = topDef(state, permanent);
      if (cardDefMatchesFilter(def, effect.filter ?? {})) names.add(def.name.toLowerCase());
    }
  }

  return names.size;
}

function revealHandCardsForEffect(state, playerId, effect, context = {}) {
  const player = getPlayer(state, playerId);
  const choiceKey = effect.choiceKey ?? "revealHandIndices";
  const maximum = effect.max ?? effect.count ?? effect.amount ?? player.hand.length;
  const defaultIndices = player.hand
    .map((card, index) => ({ card, index }))
    .filter(({ card }) => cardMatchesFilter(state, card, effect.filter ?? {}))
    .map(({ index }) => index)
    .slice(0, maximum);
  const chosen = context.choices?.[choiceKey];
  const selections = Array.isArray(chosen)
    ? chosen
    : chosen !== undefined ? [chosen] : defaultIndices;
  const indices = selections.map((selection) => {
    if (selection && typeof selection === "object") {
      if (selection.uid) return player.hand.findIndex((card) => card.uid === selection.uid);
      return Number(selection.index);
    }
    return selection;
  });
  const revealed = [];
  assertRule(indices.length <= maximum, "HAND_SELECTION", "Too many hand cards were revealed.", {
    indices,
    maximum
  });
  assertRule(new Set(indices).size === indices.length, "HAND_SELECTION", "The same hand card cannot be revealed more than once.", {
    indices
  });

  for (const index of indices) {
    assertRule(index >= 0 && index < player.hand.length, "HAND_INDEX", "Reveal index is out of range.", { index });
    const card = player.hand[index];
    assertRule(cardMatchesFilter(state, card, effect.filter ?? {}), "HAND_SELECTION", "Revealed card does not match filter.", {
      index,
      filter: effect.filter
    });
    revealed.push(card);
  }

  if (revealed.length > 0) {
    recordCardsRevealedToOpponent(state, playerId, revealed, {
      zone: "hand",
      source: effect.kind ?? "handReveal"
    });
  }

  return revealed;
}

function activateTargetAbility(state, playerId, effect, context = {}) {
  const targets = selectPermanentTargets(state, playerId, effect.target ?? "self", context);
  for (const target of targets) {
    const abilities = abilitiesOfPermanent(state, target.permanent)
      .filter((candidate) => {
        if (candidate.timing !== (effect.timing ?? TIMINGS.WHEN_PLAYED)) return false;
        return !(context.permanent?.pid === target.permanent.pid && context.ability?.id === candidate.id);
      });
    const selectedAbilities = effect.all ? abilities : abilities.slice(0, 1);
    for (const ability of selectedAbilities) {
      resolveEffect(state, target.playerId, ability.effect, {
      ...context,
      permanent: target.permanent,
      ability
      });
    }
  }
}

function activateTargetTrigger(state, playerId, effect, context = {}) {
  const targets = selectPermanentTargets(state, playerId, effect.target ?? "self", context);
  for (const target of targets) {
    const cardRef = topCard(target.permanent);
    const cardDef = defOf(state, cardRef);
    assertRule(cardDef.trigger?.type, "TRIGGER", "Chosen target does not have a trigger ability.", { card: cardDef.id });
    resolveTriggerAbilityOnly(state, target.playerId, cardRef, cardDef.trigger, context.choices);
  }
}

function sourceDefForContext(state, context = {}) {
  if (context.permanent) return topDef(state, context.permanent);
  if (context.card) return defOf(state, context.card);
  return undefined;
}

function choiceModeModifierForContext(state, playerId, context = {}) {
  const sourceDef = sourceDefForContext(state, context);
  return (state.continuousEffects ?? []).find((effect) => {
    if (effect.kind !== "choiceModeModifier" || effect.controller !== playerId) return false;
    if (effect.color && sourceDef?.color !== effect.color) return false;
    return effect.mode === "chooseAll";
  });
}

function choiceModeAssistApplies(state, playerId, permanent, assist, context = {}) {
  if (assist.during === "controllerTurn" && state.activePlayer !== playerId) return false;
  const sourceDef = sourceDefForContext(state, context);
  if (assist.sourceType && sourceDef?.type !== assist.sourceType) return false;
  if (!context.permanent) return false;
  const sourceLocation = findPermanentLocation(getPlayer(state, playerId), context.permanent.pid);
  if (!sourceLocation) return false;
  if (assist.cost?.restSelf && permanent.rested) return false;
  if (assist.cost?.underCardsToSideline && Math.max(0, permanent.cards.length - 1) < assist.cost.underCardsToSideline) return false;
  return true;
}

function applyChoiceModeAssistCost(state, playerId, permanent, assist) {
  const owner = getPlayer(state, permanent.owner);
  if (assist.cost?.restSelf) restPermanentByAbility(state, playerId, permanent);
  const underCardsToSideline = assist.cost?.underCardsToSideline ?? 0;
  for (let moved = 0; moved < underCardsToSideline; moved += 1) {
    if (permanent.cards.length <= 1) break;
    const card = permanent.cards.splice(0, 1)[0];
    placeCardInZone(state, owner, "sideline", card);
  }
}

function takeChoiceModeModifierForContext(state, playerId, context = {}, choiceCount = 0) {
  const continuous = choiceModeModifierForContext(state, playerId, context);
  if (continuous) {
    if (continuous.once) consumeContinuousEffect(state, continuous);
    return continuous;
  }

  const assistChoice = context.choices?.choiceModeAssist;
  if (assistChoice === false) return undefined;

  const player = getPlayer(state, playerId);
  const candidates = [];
  for (const lineName of [LINES.FRONT, LINES.ENERGY]) {
    lineOf(player, lineName).forEach((permanent, index) => {
      for (const assist of topDef(state, permanent).choiceModeAssists ?? []) {
        if (!choiceModeAssistApplies(state, playerId, permanent, assist, context)) continue;
        candidates.push({ permanent, lineName, index, assist });
      }
    });
  }
  if (candidates.length === 0) return undefined;

  const selected = Number.isInteger(assistChoice) ? candidates[assistChoice] : candidates[0];
  if (!selected) return undefined;
    applyChoiceModeAssistCost(state, playerId, selected.permanent, selected.assist);
  return {
    kind: "choiceModeModifier",
    mode: selected.assist.mode ?? "chooseN",
    max: Math.min(selected.assist.max ?? 2, choiceCount),
    sourcePermanentId: selected.permanent.pid
  };
}

function consumeContinuousEffect(state, effectToConsume) {
  state.continuousEffects = (state.continuousEffects ?? []).filter((effect) => effect !== effectToConsume);
}

function raidUseConditionMet(state, playerId, cardDef, context = {}) {
  return !cardDef.raidUseCondition || conditionMet(state, playerId, cardDef.raidUseCondition, {
    ...context,
    cardDef,
    performingRaid: true
  });
}

function matchesRaidRequirement(state, raid, targetPermanent, options = {}) {
  if (hasKeyword(state, targetPermanent, "raidTargetForAnyRaid")) return true;
  const targetDef = topDef(state, targetPermanent);
  if (!baseAbilitiesLost(targetPermanent)) {
    const permitted = (targetDef.raidTargetPermissions ?? []).some((permission) => {
      if (permission.sourceKind && permission.sourceKind !== options.sourceKind) return false;
      return options.raidCardDef && cardDefMatchesFilter(options.raidCardDef, permission.sourceFilter ?? {});
    });
    if (permitted) return true;
  }
  const names = raid?.names ?? [];
  const affinities = raid?.affinities ?? [];
  if (names.some((name) => cardDefHasName(targetDef, name))) return true;
  return targetDef.affinities?.some((affinity) => includesText(affinities, affinity)) ?? false;
}

function effectChoiceMaximum(state, playerId, effect, context = {}) {
  if (effect.maxIf?.condition && conditionMet(state, playerId, effect.maxIf.condition, context)) {
    return effect.maxIf.value ?? effect.maxIf.max ?? effect.max ?? effect.choices?.length ?? 1;
  }
  return effect.max ?? effect.choices?.length ?? 1;
}

function resolvedEffectAmount(state, playerId, effect) {
  const base = Number(effect.amount ?? 0);
  if (effect.amountPer?.kind === "eventUsedCount") {
    return base * Number(state.turnFlags?.[playerId]?.eventUsedCount ?? 0);
  }
  return base;
}

function choiceTurnKey(effect, choice, index) {
  if (!effect.uniqueChoicesPerTurn) return undefined;
  return `choice:${effect.choiceUsageKey ?? "effect"}:${choice?.id ?? index}`;
}

function assertAndRecordTurnChoices(player, effect, selectedChoices) {
  const keys = selectedChoices
    .map(({ choice, index }) => choiceTurnKey(effect, choice, index))
    .filter(Boolean);
  for (const key of keys) {
    assertRule(!player.usedTurnAbilityKeys.includes(key), "EFFECT_CHOICE", "That effect branch has already been chosen this turn.", { key });
  }
  for (const key of keys) player.usedTurnAbilityKeys.push(key);
}

function defaultChoiceIndexForTurn(player, effect) {
  const preferred = effect.defaultIndex ?? 0;
  if (!effect.uniqueChoicesPerTurn) return preferred;
  const choices = effect.choices ?? [];
  const available = choices.findIndex((choice, index) => !player.usedTurnAbilityKeys.includes(choiceTurnKey(effect, choice, index)));
  return available;
}

function applyBpModifier(state, targetPlayerId, permanent, amount, duration = "permanent", context = {}) {
  if (duration && duration !== "permanent") {
    permanent.bpModifiers.push({ amount, expires: expirationFromDuration(duration) });
  } else {
    permanent.bpDelta += amount;
  }
  if (amount <= 0) return;
  const location = findPermanentLocation(getPlayer(state, targetPlayerId), permanent.pid);
  if (!location) return;
  resolvePermanentAbilities(state, targetPlayerId, permanent, TIMINGS.WHEN_BP_INCREASED, {
    ...context,
    permanent,
    bpIncreaseAmount: amount
  });
}

function resolveEffectBody(state, playerId, effect, context = {}) {
  if (!effect || effect.kind === "none") return;

  const player = getPlayer(state, playerId);
  switch (effect.kind) {
    case "sequence":
      for (const childEffect of effect.effects ?? []) {
        resolveEffect(state, playerId, childEffect, context);
        if (childEffect.requiredMovedCountForFollowing !== undefined) {
          const moved = childEffect.kind === "moveHandToZone"
            ? context.lastEffectMovedFromHandCount ?? 0
            : context.lastEffectMovedCardCount ?? 0;
          if (moved < childEffect.requiredMovedCountForFollowing) break;
        }
        if (childEffect.requiredPlayedCountForFollowing !== undefined
          && Number(context.lastEffectPlayedCount ?? 0) < Number(childEffect.requiredPlayedCountForFollowing)) break;
      }
      break;
    case "optional": {
      const choiceKey = effect.choiceKey ?? "optionalEffect";
      let choice = context.choices?.[choiceKey];
      if (choice === undefined) {
        resolveRuntimeChoices(state, playerId, effect, context, {
          kind: "optionalEffect",
          choiceKey,
          canResolve: canStartOptionalEffect(state, playerId, effect.effect, context)
        });
        choice = context.choices?.[choiceKey];
      }
      if (choice === false || (choice === undefined && effect.default === false)) return;
      if (!canStartOptionalEffect(state, playerId, effect.effect, context)) return;
      resolveEffect(state, playerId, effect.effect, context);
      break;
    }
    case "optionalInstead": {
      const choice = context.choices?.[effect.choiceKey ?? "optionalInstead"];
      const conditionOk = !effect.condition || conditionMet(state, playerId, effect.condition, context);
      if (choice === false || (choice === undefined && effect.default === false) || !conditionOk || !canPayEffectCost(state, playerId, effect.costEffect)) {
        resolveEffect(state, playerId, effect.baseEffect, context);
        break;
      }
      const movedBefore = context.lastMovedFromHandCount ?? 0;
      resolveEffect(state, playerId, effect.costEffect, context);
      const movedByCost = (context.lastMovedFromHandCount ?? 0) - movedBefore;
      if (movedByCost >= (effect.requiredMovedFromHand ?? 0)) {
        resolveEffect(state, playerId, effect.insteadEffect, context);
      } else {
        resolveEffect(state, playerId, effect.baseEffect, context);
      }
      break;
    }
    case "optionalChoiceUpgrade": {
      const choice = context.choices?.[effect.choiceKey ?? "optionalChoiceUpgrade"];
      if (choice === false
        || (choice === undefined && effect.default === false)
        || !canPayEffectCost(state, playerId, effect.costEffect)) {
        resolveEffect(state, playerId, effect.baseEffect, context);
        break;
      }
      const movedBefore = context.lastMovedFromHandCount ?? 0;
      resolveEffect(state, playerId, effect.costEffect, context);
      const movedByCost = (context.lastMovedFromHandCount ?? 0) - movedBefore;
      if (movedByCost >= (effect.requiredMovedFromHand ?? 0)) {
        resolveEffect(state, playerId, effect.upgradedEffect, context);
      } else {
        resolveEffect(state, playerId, effect.baseEffect, context);
      }
      break;
    }
    case "chooseOne": {
      const modifier = takeChoiceModeModifierForContext(state, playerId, context, effect.choices?.length ?? 0);
      if (modifier) {
        if (modifier.mode === "chooseAll") {
          for (const choice of effect.choices ?? []) resolveEffect(state, playerId, choice.effect, context);
          break;
        }

        const max = modifier.max ?? 2;
        const selected = context.choices?.[effect.chooseNChoiceKey ?? "effectChoices"] ?? [...Array(max).keys()];
        assertRule(Array.isArray(selected), "EFFECT_CHOICE", "Choice-mode upgrades require an array of selected branches.", {
          selected
        });
        const unique = new Set(selected);
        assertRule(unique.size === selected.length, "EFFECT_CHOICE", "The same effect branch cannot be chosen more than once.", {
          selected
        });
        assertRule(selected.length >= 1 && selected.length <= max, "EFFECT_CHOICE", "Invalid number of selected effect branches.", {
          selected,
          max
        });
        const selectedChoices = selected
          .map((choiceId) => {
            const index = typeof choiceId === "number"
              ? choiceId
              : effect.choices?.findIndex((item) => item.id === choiceId);
            const choice = effect.choices?.[index];
            assertRule(choice, "EFFECT_CHOICE", "Chosen effect branch does not exist.", { choiceId });
            return { index, choice };
          })
          .sort((a, b) => a.index - b.index);
        assertAndRecordTurnChoices(player, effect, selectedChoices);
        for (const item of selectedChoices) resolveEffect(state, playerId, item.choice.effect, context);
        break;
      }
      const choiceKey = effect.choiceKey ?? "effectChoice";
      const selected = context.choices?.[choiceKey] ?? defaultChoiceIndexForTurn(player, effect);
      if (selected === -1 && effect.uniqueChoicesPerTurn) break;
      const index = typeof selected === "number" ? selected : effect.choices?.findIndex((item) => item.id === selected);
      const choice = effect.choices?.[index];
      assertRule(choice, "EFFECT_CHOICE", "Chosen effect branch does not exist.", { choiceKey, selected });
      assertAndRecordTurnChoices(player, effect, [{ index, choice }]);
      resolveEffect(state, playerId, choice.effect, context);
      break;
    }
    case "chooseN": {
      const choiceKey = effect.choiceKey ?? "effectChoices";
      const defaultCount = effect.defaultCount ?? effect.min ?? 1;
      const selected = context.choices?.[choiceKey] ?? [...Array(defaultCount).keys()];
      const maximum = effectChoiceMaximum(state, playerId, effect, context);
      assertRule(Array.isArray(selected), "EFFECT_CHOICE", "ChooseN effects require an array of selected branches.", {
        choiceKey,
        selected
      });
      const unique = new Set(selected);
      assertRule(unique.size === selected.length, "EFFECT_CHOICE", "The same effect branch cannot be chosen more than once.", {
        selected
      });
      assertRule(selected.length >= (effect.min ?? 0) && selected.length <= maximum, "EFFECT_CHOICE", "Invalid number of selected effect branches.", {
        selected,
        min: effect.min,
        max: maximum
      });
      const selectedChoices = selected
        .map((choiceId) => {
          const index = typeof choiceId === "number"
            ? choiceId
            : effect.choices?.findIndex((item) => item.id === choiceId);
          const choice = effect.choices?.[index];
          assertRule(choice, "EFFECT_CHOICE", "Chosen effect branch does not exist.", { choiceKey, choiceId });
          return { index, choice };
        })
        .sort((a, b) => a.index - b.index);
      assertAndRecordTurnChoices(player, effect, selectedChoices);
      for (const item of selectedChoices) {
        resolveEffect(state, playerId, item.choice.effect, context);
      }
      break;
    }
    case "conditional":
      if (conditionMet(state, playerId, effect.condition, context)) {
        resolveEffect(state, playerId, effect.effect, context);
      } else if (effect.elseEffect) {
        resolveEffect(state, playerId, effect.elseEffect, context);
      }
      break;
    case "targetConditional":
      resolveTargetConditional(state, playerId, effect, context);
      break;
    case "draw":
      drawCards(state, playerId, effect.amount ?? 1);
      break;
    case "opponentMayDraw": {
      const maximum = effect.amountIf?.condition && conditionMet(state, playerId, effect.amountIf.condition, context)
        ? effect.amountIf.amount
        : effect.amount ?? 1;
      resolveRuntimeChoices(state, opponentOf(playerId), effect, context, {
        kind: "opponentMayDraw",
        cards: [],
        ownerId: opponentOf(playerId),
        initiatingPlayerId: playerId,
        maximum
      });
      const rawChoice = context.choices?.[effect.choiceKey ?? "opponentDrawAmount"];
      const amount = rawChoice === false ? 0 : rawChoice === true || rawChoice === undefined ? maximum : Number(rawChoice);
      assertRule(Number.isInteger(amount) && amount >= 0 && amount <= maximum, "EFFECT_CHOICE", "Opponent draw choice is outside the allowed range.", {
        amount,
        maximum
      });
      drawCards(state, opponentOf(playerId), amount);
      break;
    }
    case "revealHandCards": {
      const revealed = revealHandCardsForEffect(state, playerId, effect, context);
      context.lastRevealedHandCards = revealed;
      context.lastRevealedHandCount = revealed.length;
      break;
    }
    case "predictTopDeckRequiredEnergy": {
      const prediction = Number(context.choices?.[effect.choiceKey ?? "requiredEnergyPrediction"] ?? 0);
      assertRule(Number.isInteger(prediction) && prediction >= 0, "EFFECT_CHOICE", "Required-energy prediction must be a non-negative integer.", {
        prediction
      });
      if (player.deck.length === 0) break;
      const card = player.deck.shift();
      recordCardsRevealedToOpponent(state, playerId, [card], { zone: "deck", source: effect.kind });
      player.hand.push(card);
      context.lastPredictedRequiredEnergy = prediction;
      context.lastPredictionCard = card;
      context.lastPredictionMatched = (defOf(state, card).requiredEnergy?.amount ?? 0) === prediction;
      if (context.lastPredictionMatched) resolveEffect(state, playerId, effect.successEffect, context);
      break;
    }
    case "drawLastMovedFromHandCount":
      drawCards(state, playerId, context.lastEffectMovedFromHandCount ?? 0);
      break;
    case "drawLastRestedTargetControllers": {
      const amount = effect.amount ?? 1;
      for (const target of context.lastRestedTargets ?? []) {
        drawCards(state, target.playerId, amount);
      }
      break;
    }
    case "drawUntilHandSize":
      drawUntilHandSize(state, playerId, effect);
      break;
    case "scheduleSidelineTargetsAndMoveSelfToEnergy":
      scheduleSidelineTargetsAndMoveSelfToEnergy(state, playerId, effect, context);
      break;
    case "drawOpponent":
      drawCards(state, opponentOf(playerId), effect.amount ?? 1);
      break;
    case "gainBp":
      applyBpModifier(state, context.permanent.controller, context.permanent, effect.amount ?? 0, "permanent", context);
      break;
    case "modifyBp": {
      const targets = selectPermanentTargets(state, playerId, effect.target ?? "self", context);
      const amount = resolvedEffectAmount(state, playerId, effect);
      for (const target of targets) {
        if (amount < 0 && (hasKeyword(state, target.permanent, "bpReductionProtection")
          || abilityActionPreventedByAbility(state, target.playerId, target.permanent, "bpReduction", context))) continue;
        if (amount < 0
          && target.lineName === LINES.FRONT
          && sourceIsOpponent(playerId, target.playerId)
          && topDef(state, target.permanent).moveToEnergyInsteadOnOpponentAbilityBpReduction
          && getPlayer(state, target.playerId).energyLine.length < lineCapacity(state, target.playerId, LINES.ENERGY)) {
          const moved = removeFromLine(getPlayer(state, target.playerId), target.lineName, target.index);
          insertPermanent(state, target.playerId, LINES.ENERGY, moved, undefined, {
            operation: "move",
            sourcePermanent: context.permanent,
            choices: context.choices
          });
          resolveCharacterMovedOutsideMovementPhase(state, target.playerId, moved, LINES.FRONT, LINES.ENERGY, context);
          state.log.push(`${target.playerId} moved ${topDef(state, moved).name} to the energy line instead of reducing its BP.`);
          continue;
        }
        applyBpModifier(state, target.playerId, target.permanent, amount, effect.duration ?? "permanent", context);
      }
      break;
    }
    case "modifyBpLastPlayedPermanent": {
      for (const permanent of context.lastPlayedPermanents ?? (context.lastPlayedPermanent ? [context.lastPlayedPermanent] : [])) {
        applyBpModifier(
          state,
          permanent.controller,
          permanent,
          effect.amount ?? 0,
          effect.duration ?? "turn",
          context
        );
      }
      break;
    }
    case "modifyBpForHandReveal": {
      const matching = player.hand.filter((card) => cardMatchesFilter(state, card, effect.filter ?? {}));
      let count;
      if (effect.uniqueNames) {
        count = uniqueRevealedAndFieldNameCount(state, playerId, effect, context);
      } else {
        const chosenCount = context.choices?.[effect.choiceKey ?? "revealHandCount"];
        if (chosenCount !== undefined) {
          count = chosenCount;
        } else {
          count = revealHandCardsForEffect(state, playerId, effect, context).length || matching.length;
        }
      }
      const amount = Number(effect.amountPerCard ?? 0) * count;
      const targets = selectPermanentTargets(state, playerId, effect.target ?? "self", context);
      for (const target of targets) applyBpModifier(state, target.playerId, target.permanent, amount, "turn", context);
      break;
    }
    case "modifyBpForLastMovedUnderCards": {
      const amount = Number(effect.amountPerCard ?? 0) * (context.lastEffectMovedUnderCardCount ?? 0);
      const targets = selectPermanentTargets(state, playerId, effect.target ?? "self", context);
      for (const target of targets) {
        applyBpModifier(state, target.playerId, target.permanent, amount, effect.duration ?? "turn", context);
      }
      break;
    }
    case "modifyBpForLastMovedFromHandCards": {
      const amount = Number(effect.amountPerCard ?? 0) * (context.lastEffectMovedFromHandCount ?? 0);
      const targets = selectPermanentTargets(state, playerId, effect.target ?? "self", context);
      for (const target of targets) {
        applyBpModifier(state, target.playerId, target.permanent, amount, effect.duration ?? "turn", context);
      }
      break;
    }
    case "modifyBpForLastMovedCards": {
      const amount = Number(effect.amountPerCard ?? 0) * (context.lastEffectMovedCardCount ?? 0);
      const targets = selectPermanentTargets(state, playerId, effect.target ?? "self", context);
      for (const target of targets) {
        applyBpModifier(state, target.playerId, target.permanent, amount, effect.duration ?? "turn", context);
      }
      break;
    }
    case "sidelineTargetsByUniqueAffinityReveal": {
      const count = uniqueRevealedAndFieldNameCount(state, playerId, effect, context);
      const bpMax = Number(effect.amountPerCard ?? 0) * count;
      const targets = selectPermanentTargets(state, playerId, {
        ...(effect.target ?? opponentFrontCharacter({ max: 1 })),
        bpMax
      }, context);
      mutateTargetsInReverse(targets, (target) => {
        removePermanentToZone(state, target.playerId, target.lineName, target.index, "sideline", { sidelined: true, sourcePlayer: playerId, sourceDef: context.sourceDef, sourceKind: context.sourceKind, byAbility: true, choices: context.choices });
      });
      break;
    }
    case "readySelf":
      readyPermanent(context.permanent);
      break;
    case "readyLastPlayedPermanent":
      for (const permanent of context.lastPlayedPermanents ?? (context.lastPlayedPermanent ? [context.lastPlayedPermanent] : [])) {
        readyPermanent(permanent);
      }
      break;
    case "restSelf":
      restPermanentByAbility(state, playerId, context.permanent, context);
      break;
    case "readyTargets": {
      const targets = selectPermanentTargets(state, playerId, effect.target ?? "self", context);
      for (const target of targets) readyPermanent(target.permanent);
      break;
    }
    case "restTargets": {
      const targets = selectPermanentTargets(state, playerId, effect.target ?? "self", context);
      for (const target of targets) {
        const rested = restPermanentByAbility(state, target.playerId, target.permanent, context);
        if (rested && effect.preventNextReady) {
          target.permanent.readyLocks = (target.permanent.readyLocks ?? 0) + 1;
        }
      }
      break;
    }
    case "restTargetsThen": {
      const choice = context.choices?.[effect.choiceKey ?? "optionalRestTargets"];
      if (effect.optional && choice === false) break;
      const targets = selectPermanentTargets(state, playerId, effect.target ?? "self", context);
      if (targets.length === 0) break;
      context.lastRestedTargets = targets.filter((target) => restPermanentByAbility(state, target.playerId, target.permanent, context));
      if (context.lastRestedTargets.length === 0) break;
      resolveEffect(state, playerId, effect.effect, context);
      break;
    }
    case "readyAp": {
      const count = effect.amount ?? effect.count ?? 1;
      const apCards = player.apCards.filter((ap) => ap.rested).slice(0, count);
      for (const ap of apCards) ap.rested = false;
      break;
    }
    case "payAp":
      payAp(state, playerId, effect.amount ?? 1);
      break;
    case "restrictCardUse": {
      state.turnFlags ??= freshTurnFlags();
      const restricted = state.turnFlags[playerId].restrictedCardUseSourceZones;
      for (const zone of effect.sourceZones ?? [effect.sourceZone ?? "hand"]) {
        if (!restricted.includes(zone)) restricted.push(zone);
      }
      break;
    }
    case "grantKeyword": {
      const targets = selectPermanentTargets(state, playerId, effect.target ?? "self", context);
      for (const target of targets) {
        target.permanent.keywordModifiers.push({
          keyword: effect.keyword,
          value: effect.value ?? true,
          expires: expirationFromDuration(effect.duration)
        });
      }
      break;
    }
    case "grantMandatoryBlockLink": {
      const blockers = selectPermanentTargets(state, playerId, effect.blockerTarget, context);
      const attackers = selectPermanentTargets(state, playerId, effect.attackerTarget, context);
      const attacker = attackers[0]?.permanent;
      if (!attacker) break;
      for (const blocker of blockers) {
        blocker.permanent.keywordModifiers.push({
          keyword: "mustBlockAttacker",
          value: attacker.pid,
          expires: expirationFromDuration(effect.duration ?? "turn")
        });
      }
      break;
    }
    case "grantAbility":
      grantAbility(state, playerId, effect, context);
      break;
    case "grantEnergy": {
      const targets = selectPermanentTargets(state, playerId, effect.target ?? "self", context);
      for (const target of targets) {
        target.permanent.energyModifiers.push({
          color: effect.color,
          amount: effect.amount ?? 1,
          expires: effect.duration === "turn" || effect.duration === "endOfTurn" ? "endOfTurn" : "permanent"
        });
      }
      break;
    }
    case "sidelineSelf": {
      const location = findPermanentLocation(player, context.permanent.pid);
      if (location) {
        removePermanentToZone(state, playerId, location.lineName, location.index, "sideline", { sidelined: true, sourcePlayer: playerId, sourceDef: context.sourceDef, sourceKind: context.sourceKind, byAbility: true, choices: context.choices });
      }
      break;
    }
    case "sidelineTargets": {
      const targets = selectPermanentTargets(state, playerId, effect.target ?? "self", context);
      context.lastSidelinedTargetCount = targets.length;
      context.lastSidelinedPermanent = targets[0]?.permanent;
      context.lastSidelinedBp = targets[0] ? battlePower(state, targets[0].permanent) : 0;
      mutateTargetsInReverse(targets, (target) => {
        removePermanentToZone(state, target.playerId, target.lineName, target.index, "sideline", { sidelined: true, sourcePlayer: playerId, sourceDef: context.sourceDef, sourceKind: context.sourceKind, byAbility: true, choices: context.choices });
      });
      break;
    }
    case "sidelineTargetsAndDraw": {
      const targets = selectPermanentTargets(state, playerId, effect.target ?? "self", context);
      mutateTargetsInReverse(targets, (target) => {
        removePermanentToZone(state, target.playerId, target.lineName, target.index, "sideline", { sidelined: true, sourcePlayer: playerId, sourceDef: context.sourceDef, sourceKind: context.sourceKind, byAbility: true, choices: context.choices });
      });
      drawCards(state, playerId, targets.length);
      break;
    }
    case "removeTargets": {
      const targets = selectPermanentTargets(state, playerId, effect.target ?? "self", context);
      mutateTargetsInReverse(targets, (target) => {
        removePermanentToZone(state, target.playerId, target.lineName, target.index, "removal", { sidelined: false, sourcePlayer: playerId, sourceDef: context.sourceDef, sourceKind: context.sourceKind, byAbility: true, choices: context.choices });
      });
      break;
    }
    case "moveTargetsToLife":
      moveTargetsToLife(state, playerId, effect, context);
      break;
    case "returnTargetsToHand": {
      const targets = selectPermanentTargets(state, playerId, effect.target ?? "self", context);
      mutateTargetsInReverse(targets, (target) => {
        removePermanentToZone(state, target.playerId, target.lineName, target.index, "hand", { sidelined: false, sourcePlayer: playerId, sourceDef: context.sourceDef, sourceKind: context.sourceKind, byAbility: true, choices: context.choices });
      });
      break;
    }
    case "returnTargetsToHandOrSelf": {
      const targets = selectPermanentTargets(state, playerId, effect.target ?? "self", context);
      if (targets.length > 0) {
        mutateTargetsInReverse(targets, (target) => {
          removePermanentToZone(state, target.playerId, target.lineName, target.index, "hand", { sidelined: false, sourcePlayer: playerId, sourceDef: context.sourceDef, sourceKind: context.sourceKind, byAbility: true, choices: context.choices });
        });
      } else if (context.permanent) {
        const location = findPermanentLocation(player, context.permanent.pid);
        if (location) removePermanentToZone(state, playerId, location.lineName, location.index, "hand", { sidelined: false, sourcePlayer: playerId, sourceDef: context.sourceDef, sourceKind: context.sourceKind, byAbility: true, choices: context.choices });
      }
      break;
    }
    case "damageOpponent":
      dealDamage(state, opponentOf(playerId), effect.amount ?? 1, {
        sourcePlayer: playerId,
        sourcePermanent: context.permanent,
        lifeIndices: effect.lifeIndices
      });
      break;
    case "damage": {
      const damagedPlayerId = effect.player === "self" ? playerId : effect.player === "opponent" || !effect.player ? opponentOf(playerId) : effect.player;
      dealDamage(state, damagedPlayerId, effect.amount ?? 1, {
        sourcePlayer: playerId,
        sourcePermanent: context.permanent,
        lifeIndices: effect.lifeIndices ?? context.choices?.[effect.lifeChoiceKey ?? "lifeIndices"],
        triggerChoices: context.choices?.triggerChoices
      });
      break;
    }
    case "moveTopDeck":
      moveTopDeckCards(state, playerId, effect, context);
      break;
    case "turnTopDeckFaceUp": {
      const owner = effect.player === "opponent" ? opponentOf(playerId) : playerId;
      const deck = getPlayer(state, owner).deck;
      if (deck[0]) {
        deck[0].faceUp = true;
        recordCardsRevealedToOpponent(state, owner, [deck[0]], {
          zone: "deck",
          source: effect.kind ?? "turnTopDeckFaceUp"
        });
      }
      break;
    }
    case "searchTopDeck":
      searchTopDeckCards(state, playerId, effect, context);
      break;
    case "placeTopDeckUnderSelf": {
      assertRule(context.permanent, "EFFECT_SOURCE", "This effect requires a source permanent.");
      const count = effect.amount ?? effect.count ?? 1;
      for (let i = 0; i < count; i += 1) {
        if (player.deck.length === 0) break;
        const card = player.deck.shift();
        card.faceUp = false;
        const topIndex = Math.max(0, context.permanent.cards.length - 1);
        context.permanent.cards.splice(topIndex, 0, card);
      }
      break;
    }
    case "playCardFromZone":
      playCardFromZone(state, playerId, effect, context);
      break;
    case "playOrRaidCardFromZone":
      playOrRaidCardFromZone(state, playerId, effect, context);
      break;
    case "playCardFromZoneMatchingTargetName":
      playCardFromZoneMatchingTargetName(state, playerId, effect, context);
      break;
    case "playSomeNamedFromSidelineAddRest":
      playSomeNamedFromSidelineAddRest(state, playerId, effect, context);
      break;
    case "playSourceFromZone":
      playSourceFromZone(state, playerId, effect, context);
      break;
    case "raidSourceFromZone":
      raidSourceFromZone(state, playerId, effect, context);
      break;
    case "moveSourceCardBetweenZones":
      moveSourceCardBetweenZones(state, playerId, effect, context);
      break;
    case "moveContextCardToZone":
      moveContextCardToZone(state, playerId, effect, context);
      break;
    case "useEventFromZone":
      useEventFromZone(state, playerId, effect, context);
      break;
    case "reduceNextUseApCost":
      reduceNextUseApCost(state, playerId, effect);
      break;
    case "reduceRequiredEnergy":
      state.continuousEffects.push({
        kind: "requiredEnergyReduction",
        controller: playerId,
        amount: effect.amount ?? 1,
        filter: effect.filter ?? {},
        sourceZone: effect.sourceZone,
        sourceZones: effect.sourceZones,
        consumeOnUse: effect.consumeOnUse,
        expires: effect.expires ?? "endOfTurn"
      });
      break;
    case "modifyNextBpRange":
      state.continuousEffects.push({
        kind: "bpRangeBonus",
        controller: playerId,
        amount: effect.amount ?? 1000,
        expires: effect.expires ?? "endOfTurn"
      });
      break;
    case "moveTargetsToLine":
      moveTargetsToLine(state, playerId, effect, context);
      break;
    case "moveTargetsToOtherLine": {
      const targets = selectPermanentTargets(state, playerId, effect.target ?? "self", context);
      for (const target of targets) {
        moveTargetsToLine(state, playerId, {
          ...effect,
          target: { targets: [{ playerId: target.playerId, lineName: target.lineName, index: target.index }] },
          destinationLine: target.lineName === LINES.FRONT ? LINES.ENERGY : LINES.FRONT
        }, context);
      }
      break;
    }
    case "swapOwnFrontAndEnergy":
      swapOwnFrontAndEnergy(state, playerId, effect, context);
      break;
    case "swapChosenTargets":
      swapChosenTargets(state, playerId, effect, context);
      break;
    case "swapSourceWithOtherLine":
      swapSourceWithOtherLine(state, playerId, effect, context);
      break;
    case "swapTargetsWithOtherLine":
      swapTargetsWithOtherLine(state, playerId, effect, context);
      break;
    case "moveOrSwapTargetsToOtherLine":
      moveOrSwapTargetsToOtherLine(state, playerId, effect, context);
      break;
    case "replayTargets":
      replayTargets(state, playerId, effect, context);
      break;
    case "moveCardBetweenZones":
      moveCardBetweenZones(state, playerId, effect, context);
      break;
    case "moveEqualCountsBetweenZones":
      moveEqualCountsBetweenZones(state, playerId, effect, context);
      break;
    case "moveSelfCardToZone":
      moveSelfCardToZone(state, playerId, effect, context);
      break;
    case "moveSelfCardUnderTarget":
      moveSelfCardUnderTarget(state, playerId, effect, context);
      break;
    case "moveTargetsToBottomDeck":
      moveTargetsToBottomDeck(state, playerId, effect, context);
      break;
    case "moveTargetsToDeck":
      moveTargetsToDeck(state, playerId, effect, context);
      break;
    case "moveTopRaidCardToZone":
      moveTopRaidCardToZone(state, playerId, effect, context);
      break;
    case "moveUnderCardsToZone":
      moveUnderCardsToZone(state, playerId, effect, context);
      break;
    case "moveHandCardsUnderSelf":
      moveHandCardsUnderSelf(state, playerId, effect, context);
      break;
    case "moveHandCardsUnderTargets":
      moveHandCardsUnderTargets(state, playerId, effect, context);
      break;
    case "moveZoneCardsUnderSelf":
      moveZoneCardsUnderSelf(state, playerId, effect, context);
      break;
    case "moveZoneCardsUnderTargets":
      moveZoneCardsUnderTargets(state, playerId, effect, context);
      break;
    case "placeTopDeckUnderTargets":
      placeTopDeckUnderTargets(state, playerId, effect, context);
      break;
    case "moveSelfCardToDeckTop":
      moveSelfCardToDeckTop(state, playerId, effect, context);
      break;
    case "moveBaseCardFromSelf":
      moveBaseCardFromSelf(state, playerId, effect, context);
      break;
    case "playBaseCardFromSelf":
      playBaseCardFromSelf(state, playerId, effect, context);
      break;
    case "sidelineTargetsThenActivateSourceWhenPlayed":
      sidelineTargetsThenActivateSourceWhenPlayed(state, playerId, effect, context);
      break;
    case "opponentMaySidelineChosenTargetsElse":
      opponentMaySidelineChosenTargetsElse(state, playerId, effect, context);
      break;
    case "opponentMayMoveCardsBetweenZonesElse":
      opponentMayMoveCardsBetweenZonesElse(state, playerId, effect, context);
      break;
    case "moveHandToZone":
      moveHandCardsToZone(state, playerId, effect, context);
      break;
    case "moveAllHandToZone":
      moveAllHandToZone(state, playerId, effect, context);
      break;
    case "activateTargetAbility":
      activateTargetAbility(state, playerId, effect, context);
      break;
    case "activateTargetTrigger":
      activateTargetTrigger(state, playerId, effect, context);
      break;
    case "waiveAbilityCostForTargets":
      waiveAbilityCostForTargets(state, playerId, effect, context);
      break;
    case "copyActivatedAbility":
      copyActivatedAbility(state, playerId, effect, context);
      break;
    case "copyActivatedAbilitiesFromMovedCards":
      copyActivatedAbilitiesFromMovedCards(state, playerId, effect, context);
      break;
    case "restEnergyLineForRequiredEnergyTotal":
      restEnergyLineForRequiredEnergyTotal(state, playerId, effect, context);
      break;
    case "applyTieredAbilityGrants":
      applyTieredAbilityGrants(state, playerId, effect, context);
      break;
    case "suppressPlayedAbilities":
      context.suppressPlayedAbilities = true;
      break;
    case "copyOrGainAbilities":
      state.log.push(`${playerId} applied an ability-copy/gain marker.`);
      break;
    case "watchTargetSidelinedForZoneMove": {
      const targets = selectPermanentTargets(state, playerId, effect.target ?? opponentFrontCharacter({ max: 1 }), context);
      state.continuousEffects.push({
        id: `watch:${state.continuousEffects.length + 1}:${state.nextPermanentId}`,
        kind: "targetSidelinedZoneMove",
        controller: playerId,
        targetPermanentIds: targets.map((target) => target.permanent.pid),
        source: effect.source ?? "sideline",
        destination: effect.destination ?? "hand",
        filter: effect.filter ?? {},
        expires: "endOfTurn"
      });
      break;
    }
    case "watchTargetSidelinedForEffect": {
      const targets = selectPermanentTargets(state, playerId, effect.target ?? opponentFrontCharacter({ max: 1 }), context);
      state.continuousEffects.push({
        id: `watch:${state.continuousEffects.length + 1}:${state.nextPermanentId}`,
        kind: "targetSidelinedEffect",
        controller: playerId,
        targetPermanentIds: targets.map((target) => target.permanent.pid),
        effect: structuredClone(effect.effect),
        expires: effect.expires ?? "endOfTurn"
      });
      break;
    }
    case "activateTriggerFromZone":
      activateTriggerFromZone(state, playerId, effect, context);
      break;
    case "replacementOrUseRestriction":
      state.log.push(`${playerId} applied a replacement/use-restriction effect.`);
      break;
    case "revealOpponentHand":
      recordCardsRevealedToPlayer(state, playerId, opponentOf(playerId), getOpponent(state, playerId).hand, {
        zone: "hand",
        source: effect.kind ?? "revealOpponentHand"
      });
      context.revealedOpponentHandCardUids = getOpponent(state, playerId).hand.map((card) => card.uid);
      state.log.push(`${opponentOf(playerId)} revealed ${getOpponent(state, playerId).hand.length} card(s) in hand.`);
      break;
    case "targetingModifier":
      state.continuousEffects.push({
        kind: "targetingModifier",
        controller: playerId,
        sourceName: effect.sourceName,
        timing: effect.timing,
        from: effect.from,
        targetOverride: effect.targetOverride,
        once: effect.once ?? true,
        expires: effect.expires ?? "endOfTurn"
      });
      break;
    case "choiceModeModifier":
      state.continuousEffects.push({
        kind: "choiceModeModifier",
        controller: playerId,
        mode: effect.mode ?? "chooseAll",
        color: effect.color,
        once: effect.once ?? false,
        expires: effect.expires ?? "endOfTurn"
      });
      break;
    case "restrictMovement":
      state.continuousEffects.push({
        kind: "movementRestriction",
        controller: playerId,
        player: effect.player === "opponent" ? opponentOf(playerId) : effect.player ?? playerId,
        from: effect.from,
        to: effect.to,
        expires: effect.expires ?? "endOfOpponentTurn"
      });
      break;
    case "lookTopDeck": {
      const owner = effect.player === "opponent" ? opponentOf(playerId) : effect.player ?? playerId;
      const count = Math.min(effect.count ?? effect.amount ?? 1, getPlayer(state, owner).deck.length);
      state.log.push(`${playerId} looked at ${count} card(s) from ${owner}'s deck.`);
      break;
    }
    case "lookTopDeckAndMove":
      lookTopDeckAndMove(state, playerId, effect, context);
      break;
    case "lookTopDeckPlayOneAndMoveRest":
      lookTopDeckPlayOneAndMoveRest(state, playerId, effect, context);
      break;
    case "revealTopDeckOptionalPlayOrRaidInstead":
      revealTopDeckOptionalPlayOrRaidInstead(state, playerId, effect, context);
      break;
    case "discardFromHand": {
      const count = effect.amount ?? 1;
      assertRule(player.hand.length >= count, "HAND_COST", "Not enough cards in hand.", { count });
      for (const card of player.hand.splice(0, count)) placeHandCardInZone(state, playerId, player, "sideline", card, {}, context);
      break;
    }
    case "discardOpponentFromHand": {
      const opponent = getOpponent(state, playerId);
      const opponentId = opponentOf(playerId);
      const count = Math.min(effect.amount ?? 1, opponent.hand.length);
      for (const card of opponent.hand.splice(0, count)) placeHandCardInZone(state, opponentId, opponent, "sideline", card, {}, context);
      break;
    }
    case "recoverLifeIfEmpty": {
      if (player.life.length === 0) {
        moveTopDeckCards(state, playerId, {
          count: effect.amount ?? 1,
          destination: "life",
          faceUp: false
        });
      }
      break;
    }
    case "scheduleSidelineSelfAtEndOfMain":
      assertRule(context.permanent, "EFFECT_SOURCE", "This effect requires a source permanent.");
      state.delayedEffects.push({
        timing: "endOfMain",
        kind: "sidelinePermanent",
        controller: playerId,
        permanentId: context.permanent.pid
      });
      break;
    case "scheduleReturnTargetsToHand":
      scheduleReturnTargetsToHand(state, playerId, effect, context);
      break;
    case "scheduleLastPlayedPermanentToZone":
      scheduleLastPlayedPermanentToZone(state, playerId, effect, context);
      break;
    case "unsupported":
      state.log.push(`Unsupported effect skipped: ${effect.reason ?? "unrecognized"}.`);
      break;
    default:
      throw new Error(`Unknown effect kind: ${effect.kind}`);
  }
}

function resolveStateBasedActions(state) {
  if (state._resolvingStateBasedActions || state.winner) return;
  state._resolvingStateBasedActions = true;
  try {
    let changed = true;
    while (changed && !state.winner) {
      changed = false;
      for (const playerId of PLAYERS) {
        const player = getPlayer(state, playerId);
        for (const lineName of [LINES.FRONT, LINES.ENERGY]) {
          if (player[lineName].length > lineCapacity(state, playerId, lineName)) {
            enforceLineCapacity(state, playerId, lineName);
            changed = true;
          }
          for (let index = player[lineName].length - 1; index >= 0; index -= 1) {
            const permanent = player[lineName][index];
            if (!isCharacter(state, permanent) || battlePower(state, permanent) > 0) continue;
            const name = topDef(state, permanent).name;
            removePermanentToZone(state, playerId, lineName, index, "sideline", {
              sidelined: true,
              sourcePlayer: undefined,
              stateBased: true
            });
            state.log.push(`${playerId}'s ${name} was sidelined because its BP was 0 or less.`);
            changed = true;
          }
        }
      }
    }

    if (!state.winner && !state._damageResolutionDepth) {
      const defeated = PLAYERS.filter((playerId) => getPlayer(state, playerId).life.length === 0);
      if (defeated.length === 1) {
        state.winner = opponentOf(defeated[0]);
        state.phase = PHASES.GAME_OVER;
        state.log.push(`${state.winner} wins because ${defeated[0]} has no life remaining.`);
      }
    }
  } finally {
    delete state._resolvingStateBasedActions;
  }
}

function resolveEffect(state, playerId, effect, context = {}) {
  if (!effect || effect.kind === "none") return;
  context.sourcePlayer ??= playerId;
  context.byAbilityEffect = true;
  const resolution = context.effectResolution ?? { depth: 0 };
  context.effectResolution = resolution;
  resolution.depth += 1;
  try {
    return resolveEffectBody(state, playerId, effect, context);
  } finally {
    resolution.depth -= 1;
    if (resolution.depth === 0) resolveStateBasedActions(state);
  }
}

function sourcePermanent(source) {
  if (!source) return undefined;
  return source.cards ? source : source.permanent;
}

function sourceDefinition(state, source) {
  const permanent = sourcePermanent(source);
  if (permanent) return topDef(state, permanent);
  if (source?.card) return defOf(state, source.card);
  return undefined;
}

function sourceAbilityTurnKey(source, ability) {
  if (source?.card) return `zone:${source.zone}:${source.card.uid}:${ability.id}`;
  return undefined;
}

function abilityCostWaiverApplies(state, playerId, source, ability, costKey) {
  const permanent = sourcePermanent(source);
  return (state.continuousEffects ?? []).some((effect) => {
    if (effect.kind !== "abilityCostWaiver" || effect.controller !== playerId) return false;
    if (effect.timing && ability.timing !== effect.timing) return false;
    if (effect.costKey && effect.costKey !== costKey) return false;
    if (effect.targetPermanentIds && (!permanent || !effect.targetPermanentIds.includes(permanent.pid))) return false;
    return true;
  });
}

function effectiveAbilityCost(state, playerId, source, ability) {
  const cost = { ...(ability.cost ?? {}) };
  if (cost.ap && abilityCostWaiverApplies(state, playerId, source, ability, "ap")) delete cost.ap;
  return cost;
}

function payAbilityCost(state, playerId, source, ability, choices = {}) {
  const player = getPlayer(state, playerId);
  const cost = effectiveAbilityCost(state, playerId, source, ability);
  const permanent = sourcePermanent(source);
  const sourceDef = sourceDefinition(state, source);

  if (cost.restSelf) {
    assertRule(permanent, "ABILITY_COST", "This ability requires a fielded source.");
    assertRule(!permanent.rested, "ABILITY_COST", "This ability requires an active card.");
    restPermanentByAbility(state, playerId, permanent, { sourceDef, ability });
  }

  if (cost.ap) {
    payAp(state, playerId, cost.ap);
    flagApPaidAbilityUsed(state, playerId);
  }

  if (cost.discardFromHand) {
    const eligibleIndexes = player.hand
      .map((card, index) => ({ card, index }))
      .filter(({ card }) => !cost.discardFromHandFilter || cardMatchesFilter(state, card, cost.discardFromHandFilter))
      .map(({ index }) => index);
    assertRule(eligibleIndexes.length >= cost.discardFromHand, "ABILITY_COST", "Not enough matching cards in hand to pay this cost.");
    const requested = choices[cost.discardChoiceKey ?? "abilityDiscardHandIndexes"];
    const selectedIndexes = (Array.isArray(requested) ? requested : eligibleIndexes)
      .filter((index, position, indexes) => eligibleIndexes.includes(index) && indexes.indexOf(index) === position)
      .slice(0, cost.discardFromHand)
      .sort((a, b) => b - a);
    assertRule(selectedIndexes.length === cost.discardFromHand, "ABILITY_COST", "Ability discard choices do not satisfy the cost.");
    for (const index of selectedIndexes) {
      const [card] = player.hand.splice(index, 1);
      placeHandCardInZone(state, playerId, player, "sideline", card, {}, { sourceDef, ability });
    }
  }

  if (cost.sidelineSelf) {
    assertRule(permanent, "ABILITY_COST", "This ability requires a fielded source.");
    const location = findPermanentLocation(player, permanent.pid);
    assertRule(location, "ABILITY_COST", "Source card is no longer on the field.");
    removePermanentToZone(state, playerId, location.lineName, location.index, "sideline", { sidelined: true, sourcePlayer: playerId });
  }
}

function canPayAbilityCost(state, playerId, source, ability) {
  const player = getPlayer(state, playerId);
  const cost = effectiveAbilityCost(state, playerId, source, ability);
  const permanent = sourcePermanent(source);
  if ((cost.restSelf || cost.sidelineSelf) && !permanent) return false;
  if (cost.restSelf && permanent.rested) return false;
  if (cost.ap && activeAp(player) < cost.ap) return false;
  if (cost.discardFromHand) {
    const eligibleCount = cost.discardFromHandFilter
      ? player.hand.filter((card) => cardMatchesFilter(state, card, cost.discardFromHandFilter)).length
      : player.hand.length;
    if (eligibleCount < cost.discardFromHand) return false;
  }
  if (cost.sidelineSelf && !findPermanentLocation(player, permanent.pid)) return false;
  return true;
}

function abilityConditionsMet(state, playerId, source, ability, context = {}) {
  const conditions = ability.conditions ?? {};
  const permanent = sourcePermanent(source);
  if (conditions.turn === "controller" && state.activePlayer !== playerId) return false;
  if (conditions.turn === "opponent" && state.activePlayer === playerId) return false;
  if (conditions.zone && source?.zone !== conditions.zone) return false;
  if (conditions.active !== undefined && (!permanent || permanent.rested === conditions.active)) return false;
  if (conditions.rested !== undefined && (!permanent || permanent.rested !== conditions.rested)) return false;
  if (conditions.fieldAnyOf) {
    const player = getPlayer(state, playerId);
    const hasMatch = [...player.frontLine, ...player.energyLine].some((candidate) => {
      const def = topDef(state, candidate);
      return conditions.fieldAnyOf.some((filter) => cardDefMatchesFilter(def, filter));
    });
    if (!hasMatch) return false;
  }
  if (conditions.handToSidelineSource) {
    if (!context.sourceDef || !cardDefMatchesFilter(context.sourceDef, conditions.handToSidelineSource)) return false;
  }
  if (conditions.handToSidelineCardFilter) {
    if (!context.card || !cardMatchesFilter(state, context.card, conditions.handToSidelineCardFilter)) return false;
  }
  if (conditions.energyGenerationMin !== undefined && totalEnergyGeneration(state, playerId) < conditions.energyGenerationMin) return false;
  if (conditions.noTriggerFieldCountMin !== undefined
    && countFieldMatches(state, playerId, { noTrigger: true }) < conditions.noTriggerFieldCountMin) return false;
  if (conditions.attackingCharacter) {
    if (!context.attacker) return false;
    if (!cardDefMatchesFilter(topDef(state, context.attacker), conditions.attackingCharacter)) return false;
  }
  if (conditions.sidelinedLine && context.sidelinedLine !== conditions.sidelinedLine) return false;
  if (conditions.chosenPermanentSelf) {
    if (!permanent || context.chosenPermanent?.pid !== permanent.pid) return false;
  }
  if (conditions.chosenBySource) {
    if (!context.chosenBySourceDef || !cardDefMatchesFilter(context.chosenBySourceDef, conditions.chosenBySource)) return false;
  }
  if (conditions.line) {
    if (!permanent) return false;
    const player = getPlayer(state, playerId);
    const location = findPermanentLocation(player, permanent.pid);
    if (location?.lineName !== conditions.line) return false;
  }
  const delegatedConditions = { ...conditions };
  for (const key of [
    "turn",
    "zone",
    "active",
    "rested",
    "fieldAnyOf",
    "handToSidelineSource",
    "handToSidelineCardFilter",
    "energyGenerationMin",
    "noTriggerFieldCountMin",
    "attackingCharacter",
    "sidelinedLine",
    "chosenPermanentSelf",
    "chosenBySource",
    "line"
  ]) {
    delete delegatedConditions[key];
  }
  if (Object.keys(delegatedConditions).length > 0 && !conditionMet(state, playerId, delegatedConditions, { ...context, permanent })) return false;
  return true;
}

function canActivateMainAbility(state, playerId, permanent, ability) {
  if (ability.timing !== TIMINGS.ACTIVATE_MAIN) return false;
  const player = getPlayer(state, playerId);
  if (!abilityConditionsMet(state, playerId, permanent, ability)) return false;
  if (ability.oncePerTurn && permanent.usedOncePerTurn.includes(ability.id)) return false;
  if (ability.oncePerTurnKey && player.usedTurnAbilityKeys.includes(ability.oncePerTurnKey)) return false;
  return canPayAbilityCost(state, playerId, permanent, ability);
}

function canActivateMainZoneAbility(state, playerId, zoneName, card, ability) {
  if (ability.timing !== TIMINGS.ACTIVATE_MAIN) return false;
  if (ability.conditions?.zone !== zoneName) return false;
  const player = getPlayer(state, playerId);
  const source = { zone: zoneName, card };
  if (!abilityConditionsMet(state, playerId, source, ability)) return false;
  const turnKey = sourceAbilityTurnKey(source, ability);
  if (ability.oncePerTurn && player.usedTurnAbilityKeys.includes(turnKey)) return false;
  if (ability.oncePerTurnKey && player.usedTurnAbilityKeys.includes(ability.oncePerTurnKey)) return false;
  return canPayAbilityCost(state, playerId, source, ability);
}

function takeTargetingModifierForAbility(state, playerId, sourceDef, ability) {
  const modifier = (state.continuousEffects ?? []).find((effect) => {
    if (effect.kind !== "targetingModifier" || effect.controller !== playerId) return false;
    if (effect.sourceName && !cardDefHasName(sourceDef, effect.sourceName)) return false;
    if (effect.timing && ability.timing !== effect.timing) return false;
    return true;
  });
  if (modifier?.once) consumeContinuousEffect(state, modifier);
  return modifier;
}

function resolveZoneCardAbilities(state, playerId, zoneName, card, timing, context = {}) {
  const player = getPlayer(state, playerId);
  const source = { zone: zoneName, card };
  for (const ability of defOf(state, card).abilities ?? []) {
    if (ability.timing !== timing) continue;
    if (!abilityConditionsMet(state, playerId, source, ability, context)) continue;
    const turnKey = sourceAbilityTurnKey(source, ability);
    if (ability.oncePerTurn && turnKey && player.usedTurnAbilityKeys.includes(turnKey)) continue;
    if (ability.oncePerTurnKey && player.usedTurnAbilityKeys.includes(ability.oncePerTurnKey)) continue;
    if (!canPayAbilityCost(state, playerId, source, ability)) continue;

    payAbilityCost(state, playerId, source, ability);
    if (ability.oncePerTurn && turnKey) player.usedTurnAbilityKeys.push(turnKey);
    if (ability.oncePerTurnKey) player.usedTurnAbilityKeys.push(ability.oncePerTurnKey);
    resolveEffect(state, playerId, ability.effect, {
      ...context,
      zone: zoneName,
      card,
      ability,
      sourceDef: defOf(state, card)
    });
  }
}

function resolvePermanentAbilities(state, playerId, permanent, timing, context = {}) {
  const sourceDef = topDef(state, permanent);
  const player = getPlayer(state, playerId);
  for (const ability of abilitiesOfPermanent(state, permanent)) {
    if (ability.timing !== timing) continue;
    if (!abilityConditionsMet(state, playerId, permanent, ability, context)) continue;
    if (ability.oncePerTurn && permanent.usedOncePerTurn.includes(ability.id)) continue;
    if (ability.oncePerTurnKey && player.usedTurnAbilityKeys.includes(ability.oncePerTurnKey)) continue;
    if (ability.cost) payAbilityCost(state, playerId, permanent, ability);
    if (ability.oncePerTurn) permanent.usedOncePerTurn.push(ability.id);
    if (ability.oncePerTurnKey) player.usedTurnAbilityKeys.push(ability.oncePerTurnKey);
    resolveEffect(state, playerId, ability.effect, { ...context, permanent, ability, sourceDef });
  }
}

function resolveRaidedAbilities(state, playerId, permanent, raidedDef, context = {}) {
  const player = getPlayer(state, playerId);
  for (const ability of raidedDef.abilities ?? []) {
    if (ability.timing !== TIMINGS.WHEN_RAIDED) continue;
    if (!abilityConditionsMet(state, playerId, permanent, ability, context)) continue;
    if (ability.oncePerTurn && permanent.usedOncePerTurn.includes(ability.id)) continue;
    if (ability.oncePerTurnKey && player.usedTurnAbilityKeys.includes(ability.oncePerTurnKey)) continue;
    if (ability.cost) payAbilityCost(state, playerId, permanent, ability);
    if (ability.oncePerTurn) permanent.usedOncePerTurn.push(ability.id);
    if (ability.oncePerTurnKey) player.usedTurnAbilityKeys.push(ability.oncePerTurnKey);
    resolveEffect(state, playerId, ability.effect, { ...context, permanent, ability, sourceDef: raidedDef });
  }
}

function resolveFieldPermanentAbilities(state, playerId, timing, context = {}) {
  const player = getPlayer(state, playerId);
  const permanents = [...player.frontLine, ...player.energyLine];
  for (const permanent of permanents) {
    const location = findPermanentLocation(player, permanent.pid);
    if (!location) continue;
    resolvePermanentAbilities(state, playerId, player[location.lineName][location.index], timing, context);
  }
}

function resolveLifeToSidelineNoTriggerAbilities(state, playerId, cardRef) {
  const player = getPlayer(state, playerId);
  if (!player.sideline.some((card) => card.uid === cardRef.uid)) return;
  if (hasTriggerAbility(defOf(state, cardRef))) return;
  resolveFieldPermanentAbilities(state, playerId, TIMINGS.WHEN_LIFE_TO_SIDELINE_NO_TRIGGER, { card: cardRef });
}

function resolveWhenUsingEffect(state, playerId, cardDef, cardRef, choices = {}) {
  const context = { card: cardRef, choices, sourceDef: cardDef, sourceZone: "hand" };
  if (cardDef.whenUsingEffect) resolveEffect(state, playerId, cardDef.whenUsingEffect, context);
  return context;
}

function playCard(state, action) {
  const player = getPlayer(state, action.player);
  assertRule(state.activePlayer === action.player && state.phase === PHASES.MAIN, "PHASE", "Cards can be used from hand during your main phase.");
  assertRule(action.handIndex >= 0 && action.handIndex < player.hand.length, "HAND_INDEX", "Hand index is out of range.");

  const cardRef = player.hand[action.handIndex];
  const cardDef = defOf(state, cardRef);
  const useOptions = { sourceZone: "hand" };
  assertCanUseCard(state, action.player, cardDef, useOptions);
  const apCost = apCostForCardUse(state, action.player, cardDef, useOptions);
  payAp(state, action.player, apCost);
  payUseRestrictionCosts(state, action.player, cardDef, action.choices);
  consumeRequiredEnergyReductions(state, action.player, cardDef, useOptions);
  consumeApCostReductions(state, action.player, cardDef, useOptions);
  player.hand.splice(action.handIndex, 1);
  flagCardUsedFromHand(state, action.player, cardDef);
  const whenUsingContext = resolveWhenUsingEffect(state, action.player, cardDef, cardRef, action.choices);

  if (cardDef.type === CARD_TYPES.EVENT) {
    flagEventUsed(state, action.player);
    resolveEffect(state, action.player, cardDef.eventEffect, {
      card: cardRef,
      choices: action.choices,
      sourceDef: cardDef,
      sourceZone: "hand"
    });
    placeCardInZone(state, player, "sideline", cardRef, { fromHandUse: true });
    state.log.push(`${action.player} used event ${cardDef.name}.`);
    return;
  }

  if (cardDef.type === CARD_TYPES.SITE) {
    assertRule(action.destination === LINES.ENERGY, "SITE_LINE", "Site cards can only be played to the energy line.");
  } else {
    assertRule(action.destination === LINES.FRONT || action.destination === LINES.ENERGY, "CHARACTER_LINE", "Character cards must be played to a field line.");
  }
  assertRule(cardCanEnterLine(state, action.player, cardDef, action.destination, { operation: "play" }), "LINE_RESTRICTION", "This card cannot be played to that line.", {
    card: cardDef.id,
    destination: action.destination
  });

  const entersActive = cardDef.entersActive
    || (cardDef.entersActiveOnUseEffect && (whenUsingContext.lastEffectMovedFromHandCount ?? 0) > 0)
    || (cardDef.entersActiveCondition
      ? conditionMet(state, action.player, cardDef.entersActiveCondition, { cardDef, sourceZone: action.from ?? "hand" })
      : false);
  const permanent = createPermanent(state, action.player, cardRef, !entersActive);
  insertPermanent(state, action.player, action.destination, permanent, action.replaceIndex, {
    operation: "play",
    choices: action.choices
  });
  flagCharacterPlayed(state, action.player, cardDef);
  resolvePermanentAbilities(state, action.player, permanent, TIMINGS.WHEN_PLAYED, { permanent, choices: action.choices });
  state.log.push(`${action.player} played ${cardDef.name} to ${action.destination}.`);
}

function performRaid(state, action) {
  const player = getPlayer(state, action.player);
  assertRule(state.activePlayer === action.player && state.phase === PHASES.MAIN, "PHASE", "Raid can be performed during your main phase.");
  assertRule(action.handIndex >= 0 && action.handIndex < player.hand.length, "HAND_INDEX", "Hand index is out of range.");

  const cardRef = player.hand[action.handIndex];
  const cardDef = defOf(state, cardRef);
  assertRule(cardDef.type === CARD_TYPES.CHARACTER && cardDef.raid, "RAID", "This card cannot perform Raid.");

  const targetLine = lineOf(player, action.targetLine);
  const target = targetLine[action.targetIndex];
  assertRule(target, "RAID_TARGET", "Raid target does not exist.");
  assertRule(isCharacter(state, target), "RAID_TARGET", "Raid target must be a character.");
  assertRule(!topDef(state, target).raid, "RAID_TARGET", "Raid target must not possess Raid.");
  assertRule(matchesRaidRequirement(state, cardDef.raid, target, { raidCardDef: cardDef, sourceKind: "cardUse" }), "RAID_TARGET", "Raid target does not match this card's Raid requirement.");

  const useOptions = { sourceZone: "hand", performingRaid: true };
  assertCanUseCard(state, action.player, cardDef, useOptions);
  const apCost = apCostForCardUse(state, action.player, cardDef, useOptions);
  payAp(state, action.player, apCost);
  consumeRequiredEnergyReductions(state, action.player, cardDef, useOptions);
  consumeApCostReductions(state, action.player, cardDef, useOptions);
  player.hand.splice(action.handIndex, 1);
  flagCardUsedFromHand(state, action.player, cardDef);
  resolveWhenUsingEffect(state, action.player, cardDef, cardRef, action.choices);
  const raidedDef = topDef(state, target);
  resetPermanentForRaid(target);
  target.cards.push(cardRef);
  readyPermanent(target);

  if (action.targetLine === LINES.ENERGY && action.moveToFront) {
    assertRule(permanentCanEnterLine(state, action.player, target, LINES.FRONT, { operation: "move" }), "LINE_RESTRICTION", "This raided character cannot move to the front line.");
    const moved = removeFromLine(player, LINES.ENERGY, action.targetIndex);
    insertPermanent(state, action.player, LINES.FRONT, moved, action.replaceIndex, {
      operation: "move",
      sourcePermanent: moved,
      choices: action.choices
    });
    resolveCharacterMovedOutsideMovementPhase(state, action.player, moved, LINES.ENERGY, LINES.FRONT, { choices: action.choices });
  }

  resolvePermanentAbilities(state, action.player, target, TIMINGS.WHEN_PLAYED, { permanent: target, raid: true, choices: action.choices });
  resolveRaidedAbilities(state, action.player, target, raidedDef, { permanent: target, raid: true, choices: action.choices });
  state.log.push(`${action.player} performed Raid with ${cardDef.name}.`);
}

function addLegalLinePlacementActions(state, playerId, lineName, baseAction, actions) {
  const line = lineOf(getPlayer(state, playerId), lineName);
  const capacity = lineCapacity(state, playerId, lineName);
  if (line.length < capacity) {
    actions.push(baseAction);
    return;
  }
  if (capacity <= 0 || line.length === 0) return;
  line.forEach((_, replaceIndex) => actions.push({ ...baseAction, replaceIndex }));
}

function movementRestricted(state, playerId, move) {
  return (state.continuousEffects ?? []).some((effect) => {
    if (effect.kind !== "movementRestriction") return false;
    if (effect.player && effect.player !== playerId) return false;
    if (effect.from && effect.from !== move.from) return false;
    if (effect.to && effect.to !== move.to) return false;
    return true;
  });
}

function moveCharacters(state, action) {
  const player = getPlayer(state, action.player);
  assertRule(state.activePlayer === action.player && state.phase === PHASES.MOVEMENT, "PHASE", "Characters move during your movement phase.");
  assertRule(Array.isArray(action.moves), "MOVE", "Movement action requires a moves array.");
  state.turnFlags ??= freshTurnFlags();
  assertRule(!state.turnFlags[action.player].movementActionUsed, "MOVE_COMPLETE", "Characters can only be moved once during a movement phase.");
  assertRule(action.moves.length > 0, "MOVE", "At least one character must be selected for movement.");

  const sourceKeys = new Set();
  const sourcePermanentIds = new Set();
  const selected = action.moves.map((move) => {
    const sourceLine = lineOf(player, move.from);
    const permanent = sourceLine[move.index];
    assertRule(permanent, "MOVE_SOURCE", "Movement source does not exist.", move);
    assertRule(isCharacter(state, permanent), "MOVE_SOURCE", "Only characters can move.", move);
    assertRule(!hasKeyword(state, permanent, "cannotMove"), "MOVE_RESTRICTED", "This character cannot move.", move);
    assertRule(!movementRestricted(state, action.player, move), "MOVE_RESTRICTED", "This movement direction is currently restricted.", move);
    assertRule(move.to === LINES.FRONT || move.to === LINES.ENERGY, "MOVE_DESTINATION", "Unknown movement destination.", move);
    assertRule(move.from !== move.to, "MOVE_DESTINATION", "Movement must change lines.", move);
    assertRule(permanentCanEnterLine(state, action.player, permanent, move.to, { operation: "movementPhase" }), "LINE_RESTRICTION", "This character cannot move to that line during the movement phase.", move);

    if (move.from === LINES.FRONT) {
      assertRule(hasKeyword(state, permanent, "step"), "STEP", "Only characters with Step can move from front line to energy line.");
    }

    const key = `${move.from}:${move.index}`;
    assertRule(!sourceKeys.has(key), "MOVE_DUPLICATE", "A character cannot be moved twice in one movement action.", move);
    assertRule(!sourcePermanentIds.has(permanent.pid), "MOVE_DUPLICATE", "A character cannot be moved twice in one movement action.", move);
    sourceKeys.add(key);
    sourcePermanentIds.add(permanent.pid);
    return { ...move, permanent };
  });

  const replacements = action.movementReplacements ?? [];
  assertRule(Array.isArray(replacements), "MOVE_REPLACEMENT", "Movement replacements must be an array.");
  const replacementIds = new Set();
  for (const lineName of [LINES.FRONT, LINES.ENERGY]) {
    const outgoing = selected.filter((move) => move.from === lineName).length;
    const incoming = selected.filter((move) => move.to === lineName).length;
    const overflow = Math.max(0, player[lineName].length - outgoing + incoming - lineCapacity(state, action.player, lineName));
    const lineReplacements = replacements.filter((replacement) => replacement.line === lineName || replacement.lineName === lineName);
    assertRule(lineReplacements.length === overflow, "MOVE_REPLACEMENT", "Movement requires one existing destination-line card for each overflow slot.", {
      lineName,
      overflow,
      selected: lineReplacements.length
    });
    for (const replacement of lineReplacements) {
      const permanentId = replacement.permanentId
        ?? player[lineName][overflowChoiceIndex(player[lineName], replacement)]?.pid;
      const permanent = player[lineName].find((candidate) => candidate.pid === permanentId);
      assertRule(permanent && !sourcePermanentIds.has(permanent.pid), "MOVE_REPLACEMENT", "A movement replacement must be an existing destination-line card that is not moving.", {
        lineName,
        permanentId
      });
      assertRule(!replacementIds.has(permanent.pid), "MOVE_REPLACEMENT", "The same card cannot be removed twice for movement overflow.", {
        permanentId
      });
      replacementIds.add(permanent.pid);
    }
  }

  for (const lineName of [LINES.FRONT, LINES.ENERGY]) {
    const removals = [...replacementIds]
      .map((permanentId) => player[lineName].findIndex((permanent) => permanent.pid === permanentId))
      .filter((index) => index !== -1)
      .sort((a, b) => b - a);
    for (const index of removals) {
      removePermanentToZone(state, action.player, lineName, index, "removal", { sidelined: false });
    }
  }

  for (const lineName of [LINES.FRONT, LINES.ENERGY]) {
    const removals = selected
      .filter((move) => move.from === lineName)
      .map((move) => player[lineName].findIndex((permanent) => permanent.pid === move.permanent.pid))
      .filter((index) => index !== -1)
      .sort((a, b) => b - a);
    for (const index of removals) {
      lineOf(player, lineName).splice(index, 1);
    }
  }

  for (const move of selected) {
    insertPermanent(state, action.player, move.to, move.permanent, undefined, {
      operation: "movementPhase",
      choices: action.choices
    });
    flagCharacterMoved(state, action.player, move.permanent);
  }
  state.turnFlags[action.player].movementActionUsed = true;
  state.log.push(`${action.player} moved ${selected.length} character(s).`);
}

function activateMainAbility(state, action) {
  const player = getPlayer(state, action.player);
  assertRule(state.activePlayer === action.player && state.phase === PHASES.MAIN, "PHASE", "Activate: Main abilities can be used during your main phase.");
  if (action.zone) {
    const zone = zoneOf(player, action.zone);
    const zoneIndex = action.zoneIndex ?? action.index;
    const card = zone[zoneIndex];
    assertRule(card, "ABILITY_SOURCE", "Zone ability source does not exist.", {
      zone: action.zone,
      zoneIndex
    });
    const sourceDef = defOf(state, card);
    const ability = (sourceDef.abilities ?? []).find((item) => item.id === action.abilityId);
    assertRule(ability && ability.timing === TIMINGS.ACTIVATE_MAIN, "ABILITY", "That Activate: Main ability does not exist.");
    assertRule(ability.conditions?.zone === action.zone, "ABILITY_CONDITION", "This ability cannot be activated from that zone.", {
      zone: action.zone
    });
    const source = { zone: action.zone, card };
    assertRule(abilityConditionsMet(state, action.player, source, ability), "ABILITY_CONDITION", "Ability conditions are not fulfilled.");
    const turnKey = sourceAbilityTurnKey(source, ability);
    if (ability.oncePerTurn) {
      assertRule(!player.usedTurnAbilityKeys.includes(turnKey), "ONCE_PER_TURN", "This ability has already been used this turn.");
    }
    if (ability.oncePerTurnKey) {
      assertRule(!player.usedTurnAbilityKeys.includes(ability.oncePerTurnKey), "ONCE_PER_TURN", "This ability has already been used this turn.");
    }

    payAbilityCost(state, action.player, source, ability, action.choices);
    if (ability.oncePerTurn && turnKey) player.usedTurnAbilityKeys.push(turnKey);
    if (ability.oncePerTurnKey) player.usedTurnAbilityKeys.push(ability.oncePerTurnKey);
    resolveEffect(state, action.player, ability.effect, {
      zone: action.zone,
      zoneIndex,
      card,
      ability,
      sourceDef,
      sourceZone: action.zone,
      targetingModifier: takeTargetingModifierForAbility(state, action.player, sourceDef, ability),
      choices: action.choices
    });
    resolveFieldPermanentAbilities(state, opponentOf(action.player), TIMINGS.WHEN_OPPONENT_ACTIVATE_MAIN_ABILITY, {
      activatedPlayer: action.player,
      activatedAbility: ability,
      activatedSourceDef: sourceDef
    });
    return;
  }

  const permanent = lineOf(player, action.line)[action.index];
  assertRule(permanent, "ABILITY_SOURCE", "Ability source does not exist.");
  const sourceDef = topDef(state, permanent);
  const ability = abilitiesOfPermanent(state, permanent).find((item) => item.id === action.abilityId);
  assertRule(ability && ability.timing === TIMINGS.ACTIVATE_MAIN, "ABILITY", "That Activate: Main ability does not exist.");
  assertRule(abilityConditionsMet(state, action.player, permanent, ability), "ABILITY_CONDITION", "Ability conditions are not fulfilled.");
  if (ability.oncePerTurn) {
    assertRule(!permanent.usedOncePerTurn.includes(ability.id), "ONCE_PER_TURN", "This ability has already been used this turn.");
  }
  if (ability.oncePerTurnKey) {
    assertRule(!player.usedTurnAbilityKeys.includes(ability.oncePerTurnKey), "ONCE_PER_TURN", "This ability has already been used this turn.");
  }

  payAbilityCost(state, action.player, permanent, ability, action.choices);
  if (ability.oncePerTurn) permanent.usedOncePerTurn.push(ability.id);
  if (ability.oncePerTurnKey) player.usedTurnAbilityKeys.push(ability.oncePerTurnKey);
  resolveEffect(state, action.player, ability.effect, {
    permanent,
    ability,
    sourceDef,
    targetingModifier: takeTargetingModifierForAbility(state, action.player, sourceDef, ability),
    choices: action.choices
  });
  resolveFieldPermanentAbilities(state, opponentOf(action.player), TIMINGS.WHEN_OPPONENT_ACTIVATE_MAIN_ABILITY, {
    activatedPlayer: action.player,
    activatedAbility: ability,
    activatedSourceDef: sourceDef
  });
}

function battlePower(state, permanent) {
  const temporary = (permanent.bpModifiers ?? []).reduce((total, modifier) => total + modifier.amount, 0);
  const staticPower = (baseAbilitiesLost(permanent) ? [] : topDef(state, permanent).staticModifiers ?? [])
    .filter((modifier) => staticModifierApplies(state, permanent, modifier))
    .reduce((total, modifier) => total + staticModifierAmount(state, permanent, modifier), 0);
  const fieldPower = staticFieldModifiersForPermanent(state, permanent)
    .reduce((total, { modifier }) => total + staticModifierAmount(state, permanent, modifier), 0);
  return (topDef(state, permanent).bp ?? 0) + (permanent.bpDelta ?? 0) + temporary + staticPower + fieldPower;
}

function staticFieldModifiersForPermanent(state, permanent) {
  const modifiers = [];
  for (const playerId of PLAYERS) {
    const player = getPlayer(state, playerId);
    for (const source of [...player.frontLine, ...player.energyLine]) {
      if (baseAbilitiesLost(source)) continue;
      for (const modifier of topDef(state, source).staticFieldModifiers ?? []) {
        if (!staticModifierApplies(state, source, modifier)) continue;
        if (!staticFieldModifierTargetsPermanent(state, source, permanent, modifier.target ?? {})) continue;
        modifiers.push({ source, modifier });
      }
    }
  }
  return modifiers;
}

function staticFieldKeywordModifiersForPermanent(state, permanent) {
  const modifiers = [];
  for (const playerId of PLAYERS) {
    const player = getPlayer(state, playerId);
    for (const source of [...player.frontLine, ...player.energyLine]) {
      if (baseAbilitiesLost(source)) continue;
      for (const modifier of topDef(state, source).staticFieldKeywordModifiers ?? []) {
        if (!staticModifierApplies(state, source, modifier)) continue;
        if (!staticFieldModifierTargetsPermanent(state, source, permanent, modifier.target ?? {})) continue;
        modifiers.push({ source, modifier });
      }
    }
  }
  return modifiers;
}

function staticFieldModifierTargetsPermanent(state, source, permanent, target = {}) {
  if (target.controller === "self" && permanent.controller !== source.controller) return false;
  if (target.controller === "opponent" && permanent.controller === source.controller) return false;
  if (target.line) {
    const controller = getPlayer(state, permanent.controller);
    const location = findPermanentLocation(controller, permanent.pid);
    if (target.line === "field") {
      if (!location) return false;
    } else if (location?.lineName !== target.line) {
      return false;
    }
  }
  return cardDefMatchesFilter(topDef(state, permanent), target);
}

function staticModifierApplies(state, permanent, modifier) {
  return staticConditionApplies(state, permanent, modifier.condition ?? {});
}

function staticModifierAmount(state, permanent, modifier) {
  const base = Number(modifier.bp ?? 0);
  if (!modifier.amountPer) return base;

  if (modifier.amountPer.kind === "underCardCount") {
    const underCards = permanent.cards.slice(0, -1);
    const count = modifier.amountPer.faceDown
      ? underCards.filter((card) => card.faceUp === false).length
      : underCards.length;
    return base * count;
  }

  if (modifier.amountPer.kind === "fieldCount") {
    const controller = modifier.amountPer.controller === "opponent"
      ? opponentOf(permanent.controller)
      : permanent.controller;
    const owner = getPlayer(state, controller);
    const lines = modifier.amountPer.line ? [modifier.amountPer.line] : [LINES.FRONT, LINES.ENERGY];
    let count = 0;
    for (const lineName of lines) {
      for (const candidate of lineOf(owner, lineName)) {
        if (modifier.amountPer.otherThanSource && candidate.pid === permanent.pid) continue;
        if (modifier.amountPer.rested !== undefined && candidate.rested !== modifier.amountPer.rested) continue;
        if (modifier.amountPer.active !== undefined && candidate.rested === modifier.amountPer.active) continue;
        if (!cardDefMatchesFilter(topDef(state, candidate), modifier.amountPer.filter ?? {})) continue;
        count += 1;
      }
    }
    return base * count;
  }

  if (modifier.amountPer.kind === "eventUsedCount") {
    return base * (state.turnFlags?.[permanent.controller]?.eventUsedCount ?? 0);
  }

  return base;
}

function staticConditionApplies(state, permanent, condition = {}) {
  if (!condition || Object.keys(condition).length === 0) return true;
  if (condition.allOf) return condition.allOf.every((childCondition) => staticConditionApplies(state, permanent, childCondition));
  if (condition.anyOf) return condition.anyOf.some((childCondition) => staticConditionApplies(state, permanent, childCondition));

  if (condition.turn === "controller" && state.activePlayer !== permanent.controller) return false;
  if (condition.turn === "opponent" && state.activePlayer === permanent.controller) return false;
  if (condition.rested !== undefined && permanent.rested !== condition.rested) return false;
  if (condition.active !== undefined && permanent.rested === condition.active) return false;
  if (condition.hasFaceDownUnder && !permanent.cards.slice(0, -1).some((card) => card.faceUp === false)) return false;
  if (condition.underFaceDownCountMin !== undefined) {
    const count = permanent.cards.slice(0, -1).filter((card) => card.faceUp === false).length;
    if (count < condition.underFaceDownCountMin) return false;
  }
  if (condition.baseCardRequiredEnergyMin !== undefined) {
    const baseCard = permanent.cards.at(-2);
    const baseRequiredEnergy = baseCard ? (defOf(state, baseCard).requiredEnergy?.amount ?? 0) : 0;
    if (baseRequiredEnergy < condition.baseCardRequiredEnergyMin) return false;
  }
  if (condition.line) {
    const controller = getPlayer(state, permanent.controller);
    const location = findPermanentLocation(controller, permanent.pid);
    if (location?.lineName !== condition.line) return false;
  }
  const delegatedCondition = { ...condition };
  delete delegatedCondition.turn;
  delete delegatedCondition.rested;
  delete delegatedCondition.active;
  delete delegatedCondition.hasFaceDownUnder;
  delete delegatedCondition.underFaceDownCountMin;
  delete delegatedCondition.baseCardRequiredEnergyMin;
  delete delegatedCondition.line;
  if (Object.keys(delegatedCondition).length > 0 && !conditionMet(state, permanent.controller, delegatedCondition, { permanent })) return false;
  return true;
}

function directDamageAmount(state, permanent) {
  const damageKeyword = keywordValue(state, permanent, "damage", 0);
  const damagePlus = keywordValue(state, permanent, "damagePlus", 0);
  return Math.max(1, damageKeyword) + damagePlus;
}

function clearEndOfAttackModifiers(permanent) {
  permanent.keywordModifiers = (permanent.keywordModifiers ?? []).filter((modifier) => modifier.expires !== "endOfAttack");
  permanent.bpModifiers = (permanent.bpModifiers ?? []).filter((modifier) => modifier.expires !== "endOfAttack");
}

function resolveAttackPhaseTiming(state, timing, choices) {
  for (const playerId of PLAYERS) {
    resolveFieldPermanentAbilities(state, playerId, timing, { activePlayer: state.activePlayer, choices });
    if (timing === TIMINGS.START_OF_ATTACK_PHASE && playerId === state.activePlayer) {
      for (const card of [...getPlayer(state, playerId).hand]) {
        resolveZoneCardAbilities(state, playerId, "hand", card, timing, { activePlayer: state.activePlayer, choices });
      }
    }
  }
}

function finishAttack(state, attackerPlayerId, attacker) {
  const attackerPlayer = getPlayer(state, attackerPlayerId);
  const location = findPermanentLocation(attackerPlayer, attacker.pid);
  if (!location) {
    state.pendingAttack = null;
    return;
  }

  const currentAttacker = attackerPlayer[location.lineName][location.index];
  resolvePermanentAbilities(state, attackerPlayerId, currentAttacker, TIMINGS.END_OF_ATTACK, { permanent: currentAttacker, attacker: currentAttacker });
  resolveFieldPermanentAbilities(state, attackerPlayerId, TIMINGS.WHEN_OWN_CHARACTER_ATTACK_ENDS, { attacker: currentAttacker });
  clearEndOfAttackModifiers(currentAttacker);
  runEndOfAttackDelayedEffects(state, attackerPlayerId);
  state.pendingAttack = null;
}

function impactDamageAmount(state, attacker, defender) {
  if (hasKeyword(state, defender, "nullifyImpact")) return 0;
  const impact = keywordValue(state, attacker, "impact", 0);
  const impactPlus = keywordValue(state, attacker, "impactPlus", 0);
  if (impact === 0 && impactPlus === 0) return 0;
  if (impact === 0) return Math.max(1, impactPlus);
  return impact + impactPlus;
}

function normalizeLifeIndices(player, amount, lifeIndices) {
  if (lifeIndices) {
    assertRule(lifeIndices.length === amount, "DAMAGE_SELECTION", "One life card index is required for each point of damage.", {
      amount,
      lifeIndices
    });
    return lifeIndices;
  }
  return [...Array(Math.min(amount, player.life.length)).keys()];
}

function triggerReplacementApplies(state, playerId, replacement, trigger, triggerCardDef) {
  if (replacement.triggerType && replacement.triggerType !== trigger.type) return false;
  if (replacement.color && replacement.color !== triggerCardDef.color) return false;
  if (replacement.filter && !cardDefMatchesFilter(triggerCardDef, replacement.filter)) return false;
  if (replacement.requiredEnergyFulfilled && !hasRequiredEnergy(state, playerId, triggerCardDef)) return false;
  if (replacement.during === "opponentTurn" && state.activePlayer !== opponentOf(playerId)) return false;
  if (replacement.effect && !canPayEffectCost(state, playerId, replacement.effect)) return false;
  return true;
}

function takeTriggerReplacement(state, playerId, trigger, triggerCardDef, choices) {
  if (choices?.triggerReplacement === false) return undefined;
  const player = getPlayer(state, playerId);
  const candidates = [];
  for (const lineName of [LINES.FRONT, LINES.ENERGY]) {
    lineOf(player, lineName).forEach((permanent, index) => {
      if (baseAbilitiesLost(permanent)) return;
      const cardDef = topDef(state, permanent);
      for (const replacement of cardDef.triggerReplacements ?? []) {
        if (replacement.line && replacement.line !== lineName) continue;
        if (!triggerReplacementApplies(state, playerId, replacement, trigger, triggerCardDef)) continue;
        candidates.push({ permanent, index, lineName, replacement });
      }
    });
  }
  if (candidates.length === 0) return undefined;
  const selected = Number.isInteger(choices?.triggerReplacement) ? candidates[choices.triggerReplacement] : candidates[0];
  return selected?.replacement;
}

function resolveRaidTrigger(state, playerId, cardRef, choices = {}) {
  const player = getPlayer(state, playerId);
  const cardDef = defOf(state, cardRef);
  const useOptions = { sourceZone: "life", performingRaid: true, sourceKind: "trigger" };
  const raidTargets = cardDef.type === CARD_TYPES.CHARACTER
    && cardDef.raid
    && hasRequiredEnergy(state, playerId, cardDef, useOptions)
    && raidUseConditionMet(state, playerId, cardDef, useOptions)
    ? raidTargetsForCard(state, playerId, cardDef, { sourceKind: "trigger" })
    : [];
  const resolutionContext = {
    choices: { ...(choices ?? {}) },
    card: cardRef,
    sourceDef: cardDef,
    sourceKind: "trigger"
  };
  resolveRuntimeChoices(state, playerId, { kind: "raidTrigger" }, resolutionContext, {
    kind: "raidTrigger",
    cards: [cardRef],
    ownerId: playerId,
    raidTargets: raidTargets.map((target) => ({
      player: playerId,
      line: target.lineName,
      index: target.index,
      permanentId: player[target.lineName]?.[target.index]?.pid
    }))
  });
  choices = resolutionContext.choices;
  const raidTarget = choices?.raidTarget
    ?? raidTargets[0];
  const canRaid = choices?.performRaid !== false
    && cardDef.type === CARD_TYPES.CHARACTER
    && Boolean(cardDef.raid)
    && hasRequiredEnergy(state, playerId, cardDef, useOptions)
    && raidUseConditionMet(state, playerId, cardDef, useOptions)
    && Boolean(raidTarget);

  if (!canRaid) {
    player.hand.push(cardRef);
    return;
  }

  const lineName = raidTarget.lineName ?? raidTarget.line ?? LINES.FRONT;
  const target = lineOf(player, lineName)[raidTarget.index];
  assertRule(target && isCharacter(state, target), "RAID_TARGET", "Raid-trigger target must be a character.");
  assertRule(!topDef(state, target).raid, "RAID_TARGET", "Raid-trigger target must not possess Raid.");
  assertRule(matchesRaidRequirement(state, cardDef.raid, target, {
    raidCardDef: cardDef,
    sourceKind: "trigger"
  }), "RAID_TARGET", "Raid-trigger target does not match this card's Raid requirement.");

  const raidedDef = topDef(state, target);
  resetPermanentForRaid(target);
  target.cards.push(cardRef);
  readyPermanent(target);

  const moveToFront = choices?.moveToFront
    ?? (player.frontLine.length < lineCapacity(state, playerId, LINES.FRONT));
  if (lineName === LINES.ENERGY && moveToFront) {
    assertRule(permanentCanEnterLine(state, playerId, target, LINES.FRONT, { operation: "move" }), "LINE_RESTRICTION", "This raided character cannot move to the front line.");
    const location = findPermanentLocation(player, target.pid);
    if (location?.lineName === LINES.ENERGY) {
      const moved = removeFromLine(player, LINES.ENERGY, location.index);
      insertPermanent(state, playerId, LINES.FRONT, moved, choices?.replaceIndex, {
        operation: "move",
        sourcePermanent: moved,
        choices
      });
      resolveCharacterMovedOutsideMovementPhase(state, playerId, moved, LINES.ENERGY, LINES.FRONT, { choices });
    }
  }

  resolvePermanentAbilities(state, playerId, target, TIMINGS.WHEN_PLAYED, {
    permanent: target,
    raid: true,
    choices,
    playedByAbility: true,
    sourceKind: "trigger"
  });
  resolveRaidedAbilities(state, playerId, target, raidedDef, {
    permanent: target,
    raid: true,
    choices,
    sourceKind: "trigger"
  });
  state.log.push(`${playerId} performed Raid with ${cardDef.name} from its Raid trigger.`);
}

function resolveTrigger(state, playerId, cardRef, triggerChoice = true) {
  const player = getPlayer(state, playerId);
  const def = defOf(state, cardRef);
  const printedTrigger = def.trigger;
  cardRef.faceUp = true;

  if (!printedTrigger || printedTrigger.type === TRIGGER_TYPES.NONE || triggerChoice === false) {
    placeCardInZone(state, player, "sideline", cardRef);
    if (!hasTriggerAbility(def)) {
      resolveLifeToSidelineNoTriggerAbilities(state, playerId, cardRef);
    }
    return;
  }

  flagTriggerAbilityActivated(state, playerId);
  const choices = typeof triggerChoice === "object" ? triggerChoice.choices ?? triggerChoice : undefined;
  const requestedSelfTrigger = choices?.selfTriggerType;
  const triggerOptions = [printedTrigger, ...(def.selfTriggerAlternatives ?? [])];
  const trigger = requestedSelfTrigger
    ? triggerOptions.find((candidate) => candidate.type === requestedSelfTrigger) ?? printedTrigger
    : printedTrigger;
  const replacement = takeTriggerReplacement(state, playerId, trigger, def, choices);
  if (replacement) {
    placeCardInZone(state, player, "sideline", cardRef);
      resolveEffect(state, playerId, replacement.effect, { card: cardRef, choices, sourceDef: def, sourceKind: "trigger" });
    return;
  }

  switch (trigger.type) {
    case TRIGGER_TYPES.GET:
      player.hand.push(cardRef);
      break;
    case TRIGGER_TYPES.DRAW:
      placeCardInZone(state, player, "sideline", cardRef);
      resolveEffect(state, playerId, { kind: "draw", amount: trigger.amount ?? 1 }, { card: cardRef, sourceDef: def, sourceKind: "trigger" });
      break;
    case TRIGGER_TYPES.ACTIVE:
      placeCardInZone(state, player, "sideline", cardRef);
      if (trigger.effect) {
        resolveEffect(state, playerId, trigger.effect, { card: cardRef, choices, sourceDef: def, sourceKind: "trigger" });
      } else {
        for (const permanent of [...player.frontLine, ...player.energyLine]) {
          readyPermanent(permanent);
        }
      }
      break;
    case "raid":
      resolveRaidTrigger(state, playerId, cardRef, choices);
      break;
    default:
      placeCardInZone(state, player, "sideline", cardRef);
      resolveEffect(state, playerId, trigger.effect, { card: cardRef, choices, sourceDef: def, sourceKind: "trigger" });
      break;
  }
}

function dealDamage(state, damagedPlayerId, amount, { sourcePlayer, sourcePermanent, lifeIndices, triggerChoices = [] } = {}) {
  const damagedPlayer = getPlayer(state, damagedPlayerId);
  const chosen = normalizeLifeIndices(damagedPlayer, amount, lifeIndices);
  const unique = new Set(chosen);
  assertRule(unique.size === chosen.length, "DAMAGE_SELECTION", "Damage selections must be unique.", { chosen });

  const selectedCards = chosen
    .map((index) => {
      assertRule(index >= 0 && index < damagedPlayer.life.length, "DAMAGE_SELECTION", "Selected life index is out of range.", {
        index,
        life: damagedPlayer.life.length
      });
      return damagedPlayer.life[index];
    });

  const sorted = [...chosen].sort((a, b) => b - a);
  for (const index of sorted) {
    damagedPlayer.life.splice(index, 1);
  }

  recordCardsRevealedToOpponent(state, damagedPlayerId, selectedCards, {
    zone: "life",
    source: "damage"
  });
  state._damageResolutionDepth = (state._damageResolutionDepth ?? 0) + 1;
  try {
    selectedCards.forEach((card, idx) => {
      const triggerType = defOf(state, card).trigger?.type;
      const suppressed = sourcePermanent
        && ((triggerType === TRIGGER_TYPES.DRAW && hasKeyword(state, sourcePermanent, "suppressDrawTriggersOnDamage"))
          || (triggerType === TRIGGER_TYPES.ACTIVE && hasKeyword(state, sourcePermanent, "suppressActiveTriggersOnDamage")));
      resolveTrigger(state, damagedPlayerId, card, suppressed ? false : triggerChoices[idx] ?? state.settings.autoActivateTriggers);
    });
  } finally {
    state._damageResolutionDepth -= 1;
    if (state._damageResolutionDepth === 0) delete state._damageResolutionDepth;
  }
  state.log.push(`${damagedPlayerId} took ${selectedCards.length} damage.`);

  if (damagedPlayer.life.length === 0 && !state.winner) {
    state.winner = sourcePlayer ?? opponentOf(damagedPlayerId);
    state.phase = PHASES.GAME_OVER;
    state.log.push(`${state.winner} wins because ${damagedPlayerId} has no life remaining.`);
  }
}

function attackableCharacters(state, playerId) {
  const player = getPlayer(state, playerId);
  const candidates = [];
  for (const lineName of [LINES.FRONT, LINES.ENERGY]) {
    player[lineName].forEach((permanent, index) => {
      if (!isCharacter(state, permanent) || permanent.rested || hasKeyword(state, permanent, "cantAttack")) return;
      if (lineName === LINES.ENERGY && !hasKeyword(state, permanent, "canAttackFromEnergyLine")) return;
      candidates.push({ lineName, index, permanent });
    });
  }
  return candidates;
}

function mandatoryAttackers(state, playerId) {
  return attackableCharacters(state, playerId)
    .filter(({ permanent }) => hasKeyword(state, permanent, "mustAttack"));
}

function blockerCanBlockAttacker(state, blocker, attacker) {
  if (!isCharacter(state, blocker) || blocker.rested || hasKeyword(state, blocker, "cantBlock")) return false;
  if (hasKeyword(state, blocker, "cantBlockBelowBaseBp") && battlePower(state, blocker) < (topDef(state, blocker).bp ?? 0)) return false;
  const attackerBpBlockMax = keywordValue(state, blocker, "cantBlockAttackerBpMax", 0);
  if (attackerBpBlockMax !== 0 && battlePower(state, attacker) <= attackerBpBlockMax) return false;
  if (hasKeyword(state, attacker, "cantBeBlockedByRaided") && blocker.cards.length > 1) return false;
  const requiredEnergyBlockMin = keywordValue(state, attacker, "cantBeBlockedByRequiredEnergyMin", 0);
  if (requiredEnergyBlockMin !== 0 && (topDef(state, blocker).requiredEnergy?.amount ?? 0) >= requiredEnergyBlockMin) return false;
  const bpBlockMin = keywordValue(state, attacker, "cantBeBlockedByBpMin", 0);
  if (bpBlockMin !== 0 && battlePower(state, blocker) >= bpBlockMin) return false;
  const bpBlockMax = keywordValue(state, attacker, "cantBeBlockedByBpMax", 0);
  if (bpBlockMax !== 0 && battlePower(state, blocker) <= bpBlockMax) return false;
  return true;
}

function canBeTargetedBySnipe(state, attacker, defender) {
  if (hasKeyword(state, defender, "snipeProtection")) return false;
  const forbiddenBpMin = keywordValue(state, attacker, "snipeCannotTargetBpMin", 0);
  if (forbiddenBpMin !== 0 && battlePower(state, defender) >= forbiddenBpMin) return false;
  return true;
}

function blockerMustBlockAttacker(state, blocker, attacker) {
  if (hasKeyword(state, blocker, "mustBlockAttacks")) return true;
  return (blocker.keywordModifiers ?? [])
    .some((modifier) => modifier.keyword === "mustBlockAttacker" && modifier.value === attacker.pid);
}

function eligibleBlockers(state, defenderPlayerId, attacker) {
  return getPlayer(state, defenderPlayerId).frontLine
    .map((permanent, index) => ({ permanent, index }))
    .filter(({ permanent }) => blockerCanBlockAttacker(state, permanent, attacker));
}

function attackMustBeBlocked(state, attacker) {
  return hasKeyword(state, attacker, "mustBlock")
    || (hasKeyword(state, attacker, "mustBlockFirstAttack") && attacker.attacksThisTurn === 1);
}

function declareAttack(state, action) {
  const player = getPlayer(state, action.player);
  assertRule(state.activePlayer === action.player && state.phase === PHASES.ATTACK, "PHASE", "Attacks can be declared during your attack phase.");
  assertRule(!state.pendingAttack, "ATTACK_PENDING", "Resolve the current attack before declaring another.");
  const attackerLine = action.attackerLine ?? LINES.FRONT;
  let attacker = lineOf(player, attackerLine)[action.attackerIndex];
  assertRule(attacker, "ATTACKER", "Attacker does not exist.");
  assertRule(isCharacter(state, attacker), "ATTACKER", "Only characters can attack.");
  assertRule(!attacker.rested, "ATTACKER_RESTED", "Only active characters can attack.");
  assertRule(!hasKeyword(state, attacker, "cantAttack"), "ATTACKER", "This character cannot attack.");
  assertRule(attackerLine === LINES.FRONT || hasKeyword(state, attacker, "canAttackFromEnergyLine"), "ATTACKER", "Only front-line characters can attack unless an ability allows otherwise.");
  const requiredAttackers = mandatoryAttackers(state, action.player);
  assertRule(requiredAttackers.length === 0 || requiredAttackers.some((candidate) => candidate.permanent.pid === attacker.pid), "MUST_ATTACK", "A character that must attack must be used before other attackers.");

  attacker.rested = true;
  attacker.attacksThisTurn += 1;
  resolvePermanentAbilities(state, action.player, attacker, TIMINGS.WHEN_ATTACKING, { permanent: attacker, choices: action.choices });
  resolveFieldPermanentAbilities(state, action.player, TIMINGS.WHEN_OWN_CHARACTER_ATTACKS, { attacker, choices: action.choices });
  if (state.winner) {
    state.pendingAttack = null;
    return;
  }
  let attackerLocation = findPermanentLocation(player, attacker.pid);
  if (!attackerLocation) {
    state.pendingAttack = null;
    state.log.push(`${action.player}'s attack ended because the attacker left the field.`);
    return;
  }
  attacker = player[attackerLocation.lineName][attackerLocation.index];

  if (hasKeyword(state, attacker, "drawOnAttack")) {
    drawCards(state, action.player, keywordValue(state, attacker, "drawOnAttack", 1));
  }
  if (attackerLine === LINES.ENERGY && hasKeyword(state, attacker, "moveToFrontOnEnergyAttack")) {
    attacker.keywordModifiers.push({ keyword: "snipe", value: true, expires: "endOfTurn" });
    const location = findPermanentLocation(player, attacker.pid);
    if (location?.lineName === LINES.ENERGY && player.frontLine.length < lineCapacity(state, action.player, LINES.FRONT)) {
      const moved = removeFromLine(player, LINES.ENERGY, location.index);
      insertPermanent(state, action.player, LINES.FRONT, moved, undefined, {
        operation: "move",
        sourcePermanent: moved
      });
      resolveCharacterMovedOutsideMovementPhase(state, action.player, moved, LINES.ENERGY, LINES.FRONT);
    }
  }
  attackerLocation = findPermanentLocation(player, attacker.pid);
  if (!attackerLocation) {
    state.pendingAttack = null;
    state.log.push(`${action.player}'s attack ended because the attacker left the field.`);
    return;
  }
  attacker = player[attackerLocation.lineName][attackerLocation.index];

  if (hasKeyword(state, attacker, "doubleAttack") && attacker.attacksThisTurn === 1) {
    readyPermanent(attacker);
  }

  if (action.target?.type === "character") {
    assertRule(hasKeyword(state, attacker, "snipe"), "SNIPE", "Only characters with Snipe can target opposing characters.");
    const defender = getOpponent(state, action.player).frontLine[action.target.index];
    assertRule(defender, "ATTACK_TARGET", "Snipe target does not exist.");
    assertRule(canBeTargetedBySnipe(state, attacker, defender), "SNIPE_TARGET", "That character cannot be targeted by this Snipe attack.");
    resolveBattle(state, action.player, attacker.pid, defender.pid, {
      lifeIndices: action.lifeIndices,
      triggerChoices: action.triggerChoices,
      energyLineReplaceIndex: action.energyLineReplaceIndex,
      choices: action.choices
    });
    return;
  }

  state.pendingAttack = {
    attackerPlayer: action.player,
    defenderPlayer: opponentOf(action.player),
    attackerPermanentId: attacker.pid
  };
  state.log.push(`${action.player} attacked ${opponentOf(action.player)}.`);
}

function declareBlock(state, action) {
  assertRule(state.pendingAttack, "ATTACK_PENDING", "There is no attack to block.");
  assertRule(action.player === state.pendingAttack.defenderPlayer, "BLOCK_PLAYER", "Only the attacked player can block.");
  const defender = getPlayer(state, action.player);
  const blocker = defender.frontLine[action.blockerIndex];
  assertRule(blocker, "BLOCKER", "Blocker does not exist.");
  const attackerPlayer = getPlayer(state, state.pendingAttack.attackerPlayer);
  const attackerLocation = findPermanentLocation(attackerPlayer, state.pendingAttack.attackerPermanentId);
  if (!attackerLocation) {
    state.pendingAttack = null;
    state.log.push("The attack ended because the attacker left the field.");
    return;
  }
  const attacker = attackerPlayer[attackerLocation.lineName][attackerLocation.index];
  assertRule(blockerCanBlockAttacker(state, blocker, attacker), "BLOCK_RESTRICTION", "This blocker is not allowed to block this attacker.");
  const mandatory = eligibleBlockers(state, action.player, attacker)
    .filter(({ permanent }) => blockerMustBlockAttacker(state, permanent, attacker));
  assertRule(mandatory.length === 0 || mandatory.some((candidate) => candidate.permanent.pid === blocker.pid), "MUST_BLOCK", "A character required to block this attack must be chosen if able.");

  blocker.rested = true;
  blocker.blocksThisTurn += 1;
  resolvePermanentAbilities(state, action.player, blocker, TIMINGS.WHEN_BLOCKING, { permanent: blocker, attacker, choices: action.choices });
  if (state.winner) {
    state.pendingAttack = null;
    return;
  }

  if (hasKeyword(state, blocker, "doubleBlock") && blocker.blocksThisTurn === 1) {
    readyPermanent(blocker);
  }

  let currentAttackerLocation = findPermanentLocation(attackerPlayer, state.pendingAttack.attackerPermanentId);
  let currentBlockerLocation = findPermanentLocation(defender, blocker.pid);
  if (!currentAttackerLocation || !currentBlockerLocation) {
    finishAttack(state, state.pendingAttack.attackerPlayer, attacker);
    state.log.push("The attack ended before battle because a battling character left the field.");
    return;
  }

  if (currentAttackerLocation) {
    const currentAttacker = attackerPlayer[currentAttackerLocation.lineName][currentAttackerLocation.index];
    resolvePermanentAbilities(state, state.pendingAttack.attackerPlayer, currentAttacker, TIMINGS.WHEN_ATTACK_BLOCKED, { permanent: currentAttacker, blocker });
  }
  if (state.winner) {
    state.pendingAttack = null;
    return;
  }
  currentAttackerLocation = findPermanentLocation(attackerPlayer, state.pendingAttack.attackerPermanentId);
  currentBlockerLocation = findPermanentLocation(defender, blocker.pid);
  if (!currentAttackerLocation || !currentBlockerLocation) {
    finishAttack(state, state.pendingAttack.attackerPlayer, attacker);
    state.log.push("The attack ended before battle because a battling character left the field.");
    return;
  }

  resolveBattle(state, state.pendingAttack.attackerPlayer, state.pendingAttack.attackerPermanentId, blocker.pid, {
    lifeIndices: action.lifeIndices,
    triggerChoices: action.triggerChoices,
    energyLineReplaceIndex: action.energyLineReplaceIndex,
    choices: action.choices
  });
}

function declineBlock(state, action) {
  assertRule(state.pendingAttack, "ATTACK_PENDING", "There is no attack to resolve.");
  assertRule(action.player === state.pendingAttack.defenderPlayer, "BLOCK_PLAYER", "Only the attacked player can decline to block.");
  const attackerPlayerId = state.pendingAttack.attackerPlayer;
  const attackerPlayer = getPlayer(state, attackerPlayerId);
  const location = findPermanentLocation(attackerPlayer, state.pendingAttack.attackerPermanentId);
  if (!location) {
    state.pendingAttack = null;
    state.log.push("The attack ended because the attacker left the field.");
    return;
  }
  const attacker = attackerPlayer[location.lineName][location.index];
  const availableBlockers = eligibleBlockers(state, action.player, attacker);
  const mandatory = availableBlockers.filter(({ permanent }) => blockerMustBlockAttacker(state, permanent, attacker));
  assertRule(mandatory.length === 0, "MUST_BLOCK", "A character must block this attack if able.");
  assertRule(!attackMustBeBlocked(state, attacker) || availableBlockers.length === 0, "MUST_BLOCK", "This attack must be blocked if able.");
  dealDamage(state, action.player, directDamageAmount(state, attacker), {
    sourcePlayer: attackerPlayerId,
    sourcePermanent: attacker,
    lifeIndices: action.lifeIndices,
    triggerChoices: action.triggerChoices
  });
  resolvePermanentAbilities(state, attackerPlayerId, attacker, TIMINGS.WHEN_ATTACK_UNBLOCKED, { permanent: attacker });
  resolveFieldPermanentAbilities(state, attackerPlayerId, TIMINGS.WHEN_OWN_CHARACTER_ATTACK_UNBLOCKED, { attacker });
  if (hasKeyword(state, attacker, "drawOnUnblockedAttack")) {
    drawCards(state, attackerPlayerId, keywordValue(state, attacker, "drawOnUnblockedAttack", 1));
  }
  finishAttack(state, attackerPlayerId, attacker);
}

function resolveBattle(state, attackerPlayerId, attackerPermanentId, defenderPermanentId, options = {}) {
  const attackerPlayer = getPlayer(state, attackerPlayerId);
  const defenderPlayerId = opponentOf(attackerPlayerId);
  const defenderPlayer = getPlayer(state, defenderPlayerId);
  const attackerLocation = findPermanentLocation(attackerPlayer, attackerPermanentId);
  const defenderLocation = findPermanentLocation(defenderPlayer, defenderPermanentId);

  assertRule(attackerLocation, "BATTLE", "Attacker is no longer on the field.");
  assertRule(defenderLocation, "BATTLE", "Defender is no longer on the field.");

  const attacker = attackerPlayer[attackerLocation.lineName][attackerLocation.index];
  const defender = defenderPlayer[defenderLocation.lineName][defenderLocation.index];

  if (battlePower(state, attacker) >= battlePower(state, defender)) {
    const attackerDef = topDef(state, attacker);
    if (attackerDef.battleLosersToEnergyInstead) {
      const moved = removeFromLine(defenderPlayer, defenderLocation.lineName, defenderLocation.index);
      const replaceIndex = defenderPlayer.energyLine.length >= lineCapacity(state, defenderPlayerId, LINES.ENERGY)
        ? options.energyLineReplaceIndex ?? 0
        : undefined;
      insertPermanent(state, defenderPlayerId, LINES.ENERGY, moved, replaceIndex, {
        operation: "move",
        sourcePermanent: attacker,
        choices: options.choices
      });
      resolveCharacterMovedOutsideMovementPhase(state, defenderPlayerId, moved, defenderLocation.lineName, LINES.ENERGY, {
        sourceDef: attackerDef,
        sourceKind: "character",
        permanent: attacker,
        choices: options.choices
      });
    } else {
      const defeatedZone = attackerDef.battleLosersToRemovalInstead ? "removal" : "sideline";
      removePermanentToZone(state, defenderPlayerId, defenderLocation.lineName, defenderLocation.index, defeatedZone, {
        sidelined: defeatedZone === "sideline",
        sourcePlayer: attackerPlayerId
      });
    }
    const impactDamage = impactDamageAmount(state, attacker, defender);
    if (impactDamage > 0) {
      dealDamage(state, defenderPlayerId, impactDamage, {
        sourcePlayer: attackerPlayerId,
        sourcePermanent: attacker,
        lifeIndices: options.lifeIndices,
        triggerChoices: options.triggerChoices
      });
    }
    state.log.push(`${attackerPlayerId}'s attacker won the battle.`);
    resolvePermanentAbilities(state, attackerPlayerId, attacker, TIMINGS.WHEN_ATTACK_WINS_BATTLE, { permanent: attacker, defeatedPermanent: defender });
    resolveFieldPermanentAbilities(state, attackerPlayerId, TIMINGS.WHEN_OWN_CHARACTER_ATTACK_WINS_BATTLE, { attacker, defeatedPermanent: defender });
  } else {
    state.log.push(`${attackerPlayerId}'s attacker lost the battle and remains on the field.`);
    resolvePermanentAbilities(state, attackerPlayerId, attacker, TIMINGS.WHEN_ATTACK_LOSES_BATTLE, { permanent: attacker, defender });
    resolveFieldPermanentAbilities(state, attackerPlayerId, TIMINGS.WHEN_OWN_CHARACTER_ATTACK_LOSES_BATTLE, { attacker, defender });
  }

  if (hasKeyword(state, attacker, "drawOnBlockedAttack")) {
    drawCards(state, attackerPlayerId, keywordValue(state, attacker, "drawOnBlockedAttack", 1));
  }

  finishAttack(state, attackerPlayerId, attacker);
}

function discardForHandLimit(state, action) {
  const player = getPlayer(state, action.player);
  assertRule(state.activePlayer === action.player && state.phase === PHASES.END, "PHASE", "Hand limit cleanup happens during your end phase.");
  assertRule(Array.isArray(action.handIndices), "HAND_LIMIT", "Provide hand indices to remove.");
  const maximum = maximumHandSize(state, action.player);
  const excess = Math.max(0, player.hand.length - maximum);
  assertRule(action.handIndices.length === excess, "HAND_LIMIT", `Discard exactly enough cards to keep ${maximum}.`, {
    hand: player.hand.length,
    excess,
    maximum
  });

  const sorted = [...action.handIndices].sort((a, b) => b - a);
  for (const index of sorted) {
    assertRule(index >= 0 && index < player.hand.length, "HAND_INDEX", "Hand index is out of range.", { index });
    player.removal.push(player.hand.splice(index, 1)[0]);
  }
}

function runZoneMoveDelayedEffects(state, timing, playerId) {
  const remaining = [];
  for (const effect of state.delayedEffects ?? []) {
    if (effect.timing !== timing || effect.activePlayer !== playerId) {
      remaining.push(effect);
      continue;
    }

    if (effect.kind === "movePermanentsToZone") {
      for (const permanentId of effect.permanentIds ?? []) {
        const location = findPermanentByIdAnyPlayer(state, permanentId);
        if (location) {
          removePermanentToZone(state, location.playerId, location.lineName, location.index, effect.zone ?? "sideline", {
            sidelined: effect.sidelined ?? (effect.zone ?? "sideline") === "sideline",
            sourcePlayer: effect.controller,
            byAbility: true
          });
        }
      }
      continue;
    }

    remaining.push(effect);
  }
  state.delayedEffects = remaining;
}

function runStartOfEndPhaseSteps(state) {
  const player = getPlayer(state, state.activePlayer);
  for (const permanent of [...player.frontLine, ...player.energyLine]) {
    resolvePermanentAbilities(state, state.activePlayer, permanent, TIMINGS.START_OF_END_PHASE, { permanent });
  }
  runZoneMoveDelayedEffects(state, TIMINGS.START_OF_END_PHASE, state.activePlayer);
}

function runEndPhaseSteps(state) {
  const player = getPlayer(state, state.activePlayer);
  readyField(player, { includeAp: false });
  assertRule(player.hand.length <= maximumHandSize(state, state.activePlayer), "HAND_LIMIT", "Choose cards to keep before ending the turn.");
  state.continuousEffects = state.continuousEffects.filter((effect) => {
    if (effect.expires === "endOfTurn" && effect.controller === state.activePlayer) return false;
    if (effect.expires === "endOfOpponentTurn" && opponentOf(effect.controller) === state.activePlayer) return false;
    return true;
  });
  for (const playerId of PLAYERS) {
    const currentPlayer = getPlayer(state, playerId);
    for (const permanent of [...currentPlayer.frontLine, ...currentPlayer.energyLine]) {
      permanent.bpModifiers = (permanent.bpModifiers ?? []).filter((modifier) => modifier.expires !== "endOfTurn");
      permanent.keywordModifiers = (permanent.keywordModifiers ?? []).filter((modifier) => modifier.expires !== "endOfTurn");
      permanent.energyModifiers = (permanent.energyModifiers ?? []).filter((modifier) => modifier.expires !== "endOfTurn");
      permanent.gainedAbilities = (permanent.gainedAbilities ?? []).filter((ability) => ability.expires !== "endOfTurn");
    }
  }
}

function runEndOfMainPhaseSteps(state) {
  const remaining = [];
  for (const effect of state.delayedEffects ?? []) {
    if (effect.timing !== "endOfMain" || effect.controller !== state.activePlayer) {
      remaining.push(effect);
      continue;
    }

    if (effect.kind === "sidelinePermanent") {
      const location = findPermanentById(state, effect.controller, effect.permanentId);
      if (location) {
        removePermanentToZone(state, effect.controller, location.lineName, location.index, "sideline", { sidelined: true, sourcePlayer: effect.controller, byAbility: true });
      }
    }
  }
  state.delayedEffects = remaining;
}

function runStartOfTurnDelayedEffects(state, playerId) {
  const remaining = [];
  for (const effect of state.delayedEffects ?? []) {
    if (effect.timing !== "startOfTurn" || effect.activePlayer !== playerId) {
      remaining.push(effect);
      continue;
    }

    if (effect.kind === "sidelinePermanentsAndMoveSourceToEnergy") {
      for (const permanentId of effect.permanentIds ?? []) {
        const location = findPermanentByIdAnyPlayer(state, permanentId);
        if (location) {
          removePermanentToZone(state, location.playerId, location.lineName, location.index, "sideline", { sidelined: true, sourcePlayer: effect.controller, byAbility: true });
        }
      }

      const source = effect.sourcePermanentId ? findPermanentByIdAnyPlayer(state, effect.sourcePermanentId) : undefined;
      if (source) {
        source.permanent.rested = true;
        if (source.lineName !== LINES.ENERGY) {
          const permanent = removeFromLine(getPlayer(state, source.playerId), source.lineName, source.index);
          insertPermanent(state, source.playerId, LINES.ENERGY, permanent, undefined, {
            operation: "move",
            sourcePermanent: permanent
          });
          resolveCharacterMovedOutsideMovementPhase(state, source.playerId, permanent, source.lineName, LINES.ENERGY);
        }
      }
    }

    if (effect.kind === "returnPermanentsToHand") {
      for (const permanentId of effect.permanentIds ?? []) {
        const location = findPermanentByIdAnyPlayer(state, permanentId);
        if (location) {
          removePermanentToZone(state, location.playerId, location.lineName, location.index, "hand", { sidelined: false, sourcePlayer: effect.controller, byAbility: true });
        }
      }
    }
  }
  state.delayedEffects = remaining;
}

function runEndOfAttackDelayedEffects(state, playerId) {
  const remaining = [];
  for (const effect of state.delayedEffects ?? []) {
    if (effect.timing !== "endOfAttack" || effect.activePlayer !== playerId) {
      remaining.push(effect);
      continue;
    }

    if (effect.kind === "returnPermanentsToHand") {
      for (const permanentId of effect.permanentIds ?? []) {
        const location = findPermanentByIdAnyPlayer(state, permanentId);
        if (location) {
          removePermanentToZone(state, location.playerId, location.lineName, location.index, "hand", { sidelined: false, sourcePlayer: effect.controller, byAbility: true });
        }
      }
    }
  }
  state.delayedEffects = remaining;
}

function advancePhase(state, action) {
  assertRule(action.player === state.activePlayer, "TURN_PLAYER", "Only the active player can advance phases.");
  assertRule(!state.pendingAttack, "ATTACK_PENDING", "Resolve the current attack before advancing phases.");

  switch (state.phase) {
    case PHASES.START:
      state.phase = PHASES.MOVEMENT;
      break;
    case PHASES.MOVEMENT:
      state.phase = PHASES.MAIN;
      break;
    case PHASES.MAIN:
      runEndOfMainPhaseSteps(state);
      state.phase = PHASES.ATTACK;
      resolveAttackPhaseTiming(state, TIMINGS.START_OF_ATTACK_PHASE, action.choices);
      break;
    case PHASES.ATTACK:
      assertRule(mandatoryAttackers(state, state.activePlayer).length === 0, "MUST_ATTACK", "A character that must attack is still able to attack.");
      resolveAttackPhaseTiming(state, TIMINGS.END_OF_ATTACK_PHASE, action.choices);
      runZoneMoveDelayedEffects(state, TIMINGS.END_OF_ATTACK_PHASE, state.activePlayer);
      runEndOfAttackDelayedEffects(state, state.activePlayer);
      state.phase = PHASES.END;
      runStartOfEndPhaseSteps(state);
      break;
    case PHASES.END:
      runEndPhaseSteps(state);
      if (!state.winner) enterStartPhase(state, opponentOf(state.activePlayer));
      break;
    default:
      throw new Error(`Cannot advance from phase ${state.phase}.`);
  }
}

function extraDraw(state, action) {
  const player = getPlayer(state, action.player);
  assertRule(action.player === state.activePlayer && state.phase === PHASES.START, "PHASE", "Extra draw can only be taken during your start phase.");
  assertRule(!player.extraDrawUsed, "EXTRA_DRAW", "Extra draw is once per turn.");
  if (!hasFreeExtraDraw(state, action.player)) payAp(state, action.player, 1);
  player.extraDrawUsed = true;
  flagExtraDrawUsed(state, action.player);
  drawCards(state, action.player, 1);
}

export function createGame(options) {
  const {
    catalog,
    decks,
    firstPlayer = "P1",
    seed = 1,
    skipShuffle = false,
    setupMode = "auto",
    validateDecks = true,
    autoActivateTriggers = true
  } = options;

  assertRule(catalog, "CATALOG", "A card catalog is required.");
  assertRule(decks?.P1 && decks?.P2, "DECKS", "Both P1 and P2 decks are required.");
  assertRule(PLAYERS.includes(firstPlayer), "FIRST_PLAYER", "First player must be P1 or P2.");

  if (validateDecks) {
    validateCatalog(catalog);
    validateDeck(decks.P1, catalog);
    validateDeck(decks.P2, catalog);
  }

  const state = {
    version: 1,
    seed,
    catalog,
    firstPlayer,
    activePlayer: firstPlayer,
    phase: PHASES.SETUP,
    winner: null,
    nextCardId: 1,
    nextPermanentId: 1,
    pendingAttack: null,
    setupComplete: false,
    settings: { autoActivateTriggers },
    continuousEffects: [],
    delayedEffects: [],
    publicKnowledge: freshPublicKnowledge(),
    shuffleCounter: 0,
    turnFlags: freshTurnFlags(),
    players: {},
    log: []
  };

  for (const playerId of PLAYERS) {
    const expanded = expandDeckList(decks[playerId]);
    const refs = expanded.map((defId) => {
      const ref = createCardRef(playerId, defId, state.nextCardId);
      state.nextCardId += 1;
      return ref;
    });
    const deck = skipShuffle ? refs : shuffled(refs, deriveSeed(seed, playerId, "initial-deck"));
    state.players[playerId] = {
      id: playerId,
      deck,
      hand: [],
      life: [],
      frontLine: [],
      energyLine: [],
      apCards: [],
      sideline: [],
      removal: [],
      turnsTaken: 0,
      mulliganUsed: false,
      shuffleCounter: 0,
      setupKept: false,
      extraDrawUsed: false,
      usedTurnAbilityKeys: []
    };
    drawCards(state, playerId, STARTING_HAND_SIZE);
    state.players[playerId].initialHandDefIds = cardDefIds(state.players[playerId].hand);
  }

  if (setupMode === "auto") {
    for (const playerId of PLAYERS) {
      state.players[playerId].setupKept = true;
    }
    finishSetup(state);
  }

  return state;
}

export function applyAction(inputState, action) {
  const state = cloneState(inputState);
  if (typeof action.resolutionChoiceResolver === "function") {
    resolutionChoiceResolvers.set(state, action.resolutionChoiceResolver);
  }
  if (state.winner) return state;

  switch (action.type) {
    case "mulligan": {
      assertRule(state.phase === PHASES.SETUP && !state.setupComplete, "SETUP", "Mulligan is only available during setup.");
      const player = getPlayer(state, action.player);
      assertRule(!player.mulliganUsed && !player.setupKept, "MULLIGAN", "This player cannot mulligan again.");
      player.deck.push(...player.hand.splice(0));
      state.shuffleCounter += 1;
      player.shuffleCounter = Number(player.shuffleCounter ?? 0) + 1;
      player.deck = shuffled(player.deck, deriveSeed(state.seed, action.player, "mulligan", player.shuffleCounter));
      drawCards(state, action.player, STARTING_HAND_SIZE);
      player.mulliganHandDefIds = cardDefIds(player.hand);
      player.keptHandDefIds = cardDefIds(player.hand);
      player.mulliganUsed = true;
      player.setupKept = true;
      if (PLAYERS.every((playerId) => state.players[playerId].setupKept)) finishSetup(state);
      break;
    }
    case "keepHand": {
      assertRule(state.phase === PHASES.SETUP && !state.setupComplete, "SETUP", "Keeping a hand is only available during setup.");
      const player = getPlayer(state, action.player);
      player.keptHandDefIds = cardDefIds(player.hand);
      player.setupKept = true;
      if (PLAYERS.every((playerId) => state.players[playerId].setupKept)) finishSetup(state);
      break;
    }
    case "extraDraw":
      extraDraw(state, action);
      break;
    case "advancePhase":
      advancePhase(state, action);
      break;
    case "moveCharacters":
      moveCharacters(state, action);
      break;
    case "playCard":
      playCard(state, action);
      break;
    case "performRaid":
      performRaid(state, action);
      break;
    case "activateMainAbility":
      activateMainAbility(state, action);
      break;
    case "declareAttack":
      declareAttack(state, action);
      break;
    case "declareBlock":
      declareBlock(state, action);
      break;
    case "declineBlock":
      declineBlock(state, action);
      break;
    case "discardForHandLimit":
      discardForHandLimit(state, action);
      break;
    default:
      throw new Error(`Unknown action type: ${action.type}`);
  }

  if (state.setupComplete) resolveStateBasedActions(state);
  return state;
}

function addLegalMovementActions(state, playerId, player, actions) {
  if (state.turnFlags?.[playerId]?.movementActionUsed) return;
  const eligible = [];
  player.energyLine.forEach((permanent, index) => {
    const move = { from: LINES.ENERGY, index, to: LINES.FRONT, permanentId: permanent.pid };
    if (isCharacter(state, permanent)
      && permanentCanEnterLine(state, playerId, permanent, LINES.FRONT, { operation: "movementPhase" })
      && !hasKeyword(state, permanent, "cannotMove")
      && !movementRestricted(state, playerId, move)) {
      eligible.push(move);
    }
  });
  player.frontLine.forEach((permanent, index) => {
    const move = { from: LINES.FRONT, index, to: LINES.ENERGY, permanentId: permanent.pid };
    if (isCharacter(state, permanent)
      && hasKeyword(state, permanent, "step")
      && permanentCanEnterLine(state, playerId, permanent, LINES.ENERGY, { operation: "movementPhase" })
      && !hasKeyword(state, permanent, "cannotMove")
      && !movementRestricted(state, playerId, move)) {
      eligible.push(move);
    }
  });

  for (let mask = 1; mask < 2 ** eligible.length; mask += 1) {
    const moves = eligible.filter((_, index) => (mask & (2 ** index)) !== 0);
    for (const movementReplacements of movementReplacementPlans(state, playerId, moves)) {
      actions.push({
        type: "moveCharacters",
        player: playerId,
        moves: moves.map(({ permanentId, ...move }) => move),
        ...(movementReplacements.length > 0 ? { movementReplacements } : {})
      });
    }
  }
}

function movementReplacementPlans(state, playerId, moves) {
  const player = getPlayer(state, playerId);
  const movingIds = new Set(moves.map((move) => move.permanentId));
  const choicesByLine = [];
  for (const lineName of [LINES.FRONT, LINES.ENERGY]) {
    const outgoing = moves.filter((move) => move.from === lineName).length;
    const incoming = moves.filter((move) => move.to === lineName).length;
    const overflow = Math.max(0, player[lineName].length - outgoing + incoming - lineCapacity(state, playerId, lineName));
    const eligible = player[lineName]
      .map((permanent, index) => ({ line: lineName, index, permanentId: permanent.pid }))
      .filter((replacement) => !movingIds.has(replacement.permanentId));
    if (overflow > eligible.length) return [];
    choicesByLine.push(movementReplacementCombinations(eligible, overflow));
  }

  const plans = [];
  for (const frontChoices of choicesByLine[0]) {
    for (const energyChoices of choicesByLine[1]) {
      plans.push([...frontChoices, ...energyChoices]);
    }
  }
  return plans;
}

function movementReplacementCombinations(entries, count) {
  if (count === 0) return [[]];
  const combinations = [];
  const visit = (start, selected) => {
    if (selected.length === count) {
      combinations.push([...selected]);
      return;
    }
    for (let index = start; index <= entries.length - (count - selected.length); index += 1) {
      selected.push(entries[index]);
      visit(index + 1, selected);
      selected.pop();
    }
  };
  visit(0, []);
  return combinations;
}

function addLegalRaidActions(state, playerId, player, handIndex, cardDef, actions) {
  if (!cardDef.raid) return;
  const useOptions = { sourceZone: "hand", performingRaid: true };
  if (!canUseCard(state, playerId, cardDef, useOptions)) return;

  for (const targetLine of [LINES.FRONT, LINES.ENERGY]) {
    lineOf(player, targetLine).forEach((permanent, targetIndex) => {
      if (!isCharacter(state, permanent)) return;
      if (topDef(state, permanent).raid) return;
      if (!matchesRaidRequirement(state, cardDef.raid, permanent, { raidCardDef: cardDef, sourceKind: "cardUse" })) return;

      actions.push({
        type: "performRaid",
        player: playerId,
        handIndex,
        targetLine,
        targetIndex
      });

      if (targetLine === LINES.ENERGY
        && cardCanEnterLine(state, playerId, cardDef, LINES.FRONT, { operation: "move", permanent })) {
        addLegalLinePlacementActions(state, playerId, LINES.FRONT, {
          type: "performRaid",
          player: playerId,
          handIndex,
          targetLine,
          targetIndex,
          moveToFront: true
        }, actions);
      }
    });
  }
}

function addLegalActivateMainActions(state, playerId, player, actions) {
  for (const lineName of [LINES.FRONT, LINES.ENERGY]) {
    lineOf(player, lineName).forEach((permanent, index) => {
      for (const ability of abilitiesOfPermanent(state, permanent)) {
        if (!canActivateMainAbility(state, playerId, permanent, ability)) continue;
        actions.push({
          type: "activateMainAbility",
          player: playerId,
          line: lineName,
          index,
          abilityId: ability.id
        });
      }
    });
  }

  player.sideline.forEach((card, zoneIndex) => {
    for (const ability of defOf(state, card).abilities ?? []) {
      if (!canActivateMainZoneAbility(state, playerId, "sideline", card, ability)) continue;
      actions.push({
        type: "activateMainAbility",
        player: playerId,
        zone: "sideline",
        zoneIndex,
        abilityId: ability.id
      });
    }
  });
}

export function legalActions(state, playerId) {
  if (state.winner) return [];
  const player = getPlayer(state, playerId);
  const actions = [];

  if (state.phase === PHASES.SETUP && !player.setupKept) {
    actions.push({ type: "keepHand", player: playerId });
    if (!player.mulliganUsed) actions.push({ type: "mulligan", player: playerId });
    return actions;
  }

  if (state.pendingAttack?.defenderPlayer === playerId) {
    const attackerPlayer = getPlayer(state, state.pendingAttack.attackerPlayer);
    const attackerLocation = findPermanentLocation(attackerPlayer, state.pendingAttack.attackerPermanentId);
    if (!attackerLocation) return [{ type: "declineBlock", player: playerId }];
    const attacker = attackerPlayer[attackerLocation.lineName][attackerLocation.index];
    const eligible = eligibleBlockers(state, playerId, attacker);
    const mandatory = eligible.filter(({ permanent }) => blockerMustBlockAttacker(state, permanent, attacker));
    const blockers = mandatory.length > 0 ? mandatory : eligible;
    if (mandatory.length === 0 && (!attackMustBeBlocked(state, attacker) || eligible.length === 0)) {
      actions.push({ type: "declineBlock", player: playerId });
    }
    for (const blocker of blockers) {
      const attackerMovesBattleLosersToEnergy = Boolean(topDef(state, attacker).battleLosersToEnergyInstead);
      const fullEnergyLine = player.energyLine.length >= lineCapacity(state, playerId, LINES.ENERGY);
      if (attackerMovesBattleLosersToEnergy && fullEnergyLine && player.energyLine.length > 0) {
        player.energyLine.forEach((_, energyLineReplaceIndex) => {
          actions.push({
            type: "declareBlock",
            player: playerId,
            blockerIndex: blocker.index,
            energyLineReplaceIndex
          });
        });
      } else {
        actions.push({ type: "declareBlock", player: playerId, blockerIndex: blocker.index });
      }
    }
    return actions;
  }

  if (state.activePlayer !== playerId) return actions;

  if (state.phase === PHASES.START) {
    if (!player.extraDrawUsed && (activeAp(player) >= 1 || hasFreeExtraDraw(state, playerId))) {
      actions.push({ type: "extraDraw", player: playerId });
    }
    actions.push({ type: "advancePhase", player: playerId });
  } else if (state.phase === PHASES.MOVEMENT) {
    addLegalMovementActions(state, playerId, player, actions);
    actions.push({ type: "advancePhase", player: playerId });
  } else if (state.phase === PHASES.MAIN) {
    actions.push({ type: "advancePhase", player: playerId });
    addLegalActivateMainActions(state, playerId, player, actions);
    player.hand.forEach((card, handIndex) => {
      const def = defOf(state, card);
      const normalUseOptions = { sourceZone: "hand" };
      if (canUseCard(state, playerId, def, normalUseOptions)) {
        if (def.type === CARD_TYPES.EVENT) actions.push({ type: "playCard", player: playerId, handIndex });
        if (def.type === CARD_TYPES.SITE && cardCanEnterLine(state, playerId, def, LINES.ENERGY, { operation: "play" })) {
          addLegalLinePlacementActions(state, playerId, LINES.ENERGY, {
            type: "playCard",
            player: playerId,
            handIndex,
            destination: LINES.ENERGY
          }, actions);
        }
        if (def.type === CARD_TYPES.CHARACTER) {
          if (cardCanEnterLine(state, playerId, def, LINES.FRONT, { operation: "play" })) {
            addLegalLinePlacementActions(state, playerId, LINES.FRONT, {
              type: "playCard",
              player: playerId,
              handIndex,
              destination: LINES.FRONT
            }, actions);
          }
          if (cardCanEnterLine(state, playerId, def, LINES.ENERGY, { operation: "play" })) {
            addLegalLinePlacementActions(state, playerId, LINES.ENERGY, {
              type: "playCard",
              player: playerId,
              handIndex,
              destination: LINES.ENERGY
            }, actions);
          }
        }
      }
      if (def.type === CARD_TYPES.CHARACTER) addLegalRaidActions(state, playerId, player, handIndex, def, actions);
    });
  } else if (state.phase === PHASES.ATTACK) {
    const opponent = getOpponent(state, playerId);
    const available = attackableCharacters(state, playerId);
    const mandatory = available.filter(({ permanent }) => hasKeyword(state, permanent, "mustAttack"));
    const attackers = mandatory.length > 0 ? mandatory : available;
    if (mandatory.length === 0) actions.push({ type: "advancePhase", player: playerId });
    for (const { lineName, index: attackerIndex, permanent } of attackers) {
      const baseAction = {
        type: "declareAttack",
        player: playerId,
        ...(lineName === LINES.ENERGY ? { attackerLine: LINES.ENERGY } : {}),
        attackerIndex
      };
      actions.push({ ...baseAction, target: { type: "player" } });
      if (hasKeyword(state, permanent, "snipe")) {
        opponent.frontLine.forEach((target, targetIndex) => {
          if (isCharacter(state, target) && canBeTargetedBySnipe(state, permanent, target)) {
            actions.push({ ...baseAction, target: { type: "character", index: targetIndex } });
          }
        });
      }
    }
  } else if (state.phase === PHASES.END) {
    if (player.hand.length > maximumHandSize(state, playerId)) {
      actions.push({ type: "discardForHandLimit", player: playerId });
    } else {
      actions.push({ type: "advancePhase", player: playerId });
    }
  }

  return actions;
}

export const internals = {
  activeAp,
  apCostForCardUse,
  battlePower,
  cardDefMatchesFilter,
  cardCanEnterLine,
  dealDamage,
  energyAvailable,
  directDamageAmount,
  hasRequiredEnergy,
  hasKeyword,
  impactDamageAmount,
  keywordValue,
  lineCapacity,
  permanentCanEnterLine,
  raidTargetsForCard,
  requiredEnergyForCardUse,
  targetingTaxPaymentsForTarget
};
