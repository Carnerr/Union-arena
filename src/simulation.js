import { CARD_TYPES, LINES, MAX_LINE_SIZE, PHASES, TRIGGER_TYPES, opponentOf } from "./constants.js";
import { applyAction, createGame, internals, legalActions } from "./game.js";

export const DEFAULT_PILOT_POLICY = Object.freeze({
  schema: "union-arena-local-engine/pilot-policy@1",
  name: "baseline-pilot",
  weights: Object.freeze({
    baseScore: 100,
    advancePhase: 0,
    extraDraw: 55,
    moveToFront: 65,
    movedBp: 6,
    activateMain: 35,
    abilityEffect: 20,
    performRaid: 90,
    raidBpUpgrade: 12,
    moveRaidToFront: 80,
    playCard: 10,
    playToEnergy: 70,
    earlyEnergy: 45,
    energyShortage: 45,
    playToFront: 45,
    lowCostUnit: 45,
    highBpUnit: 8,
    event: 20,
    lineCrowdingPenalty: -110,
    attackPlayer: 90,
    attackCharacter: 40,
    lethalAttack: 900,
    damageThreat: 80,
    attackerBp: 7,
    removalTargetBp: 18,
    attackBpAdvantage: 90,
    block: 100,
    declineBlock: 0,
    savedDamage: 140,
    lethalBlock: 900,
    favorableBlock: 220,
    blockerDies: -150,
    highValueBlocker: -12,
    impactLeak: -80,
    declineLethal: -950,
    damageTaken: -135,
    discard: 20
  })
});

export function normalizePilotPolicy(policy = {}) {
  const raw = policy?.weights ? policy : { weights: policy ?? {} };
  return {
    schema: raw.schema ?? DEFAULT_PILOT_POLICY.schema,
    name: raw.name ?? DEFAULT_PILOT_POLICY.name,
    weights: {
      ...DEFAULT_PILOT_POLICY.weights,
      ...(raw.weights ?? {})
    }
  };
}

export function describePilotPolicy(policy = {}) {
  const normalized = normalizePilotPolicy(policy);
  return Object.entries(normalized.weights)
    .map(([feature, weight]) => ({
      feature,
      weight,
      deltaFromBaseline: Number(weight) - Number(DEFAULT_PILOT_POLICY.weights[feature] ?? 0)
    }))
    .sort((a, b) => Math.abs(b.deltaFromBaseline) - Math.abs(a.deltaFromBaseline) || a.feature.localeCompare(b.feature));
}

export function randomSeed() {
  return Math.floor(Math.random() * 0x100000000);
}

export function resolveSeed({ seed, randomize = false, iteration = 0 } = {}) {
  if (randomize) return randomSeed();
  if (seed !== undefined && seed !== null) return Number(seed) + iteration;
  return 1 + iteration;
}

export function createSimulationGame({
  catalog,
  decks,
  seed,
  randomize = false,
  iteration = 0,
  skipShuffle = false,
  validateDecks = true,
  firstPlayer = "P1",
  setupMode = "auto"
}) {
  const resolvedSeed = resolveSeed({ seed, randomize, iteration });
  return {
    seed: resolvedSeed,
    state: createGame({
      catalog,
      decks,
      firstPlayer,
      seed: resolvedSeed,
      skipShuffle,
      validateDecks,
      setupMode
    })
  };
}

export function summarizeGameState(state) {
  return {
    phase: state.phase,
    activePlayer: state.activePlayer,
    winner: state.winner,
    pendingAttack: state.pendingAttack,
    players: Object.fromEntries(Object.entries(state.players).map(([playerId, player]) => [
      playerId,
      {
        hand: player.hand.length,
        life: player.life.length,
        deck: player.deck.length,
        frontLine: player.frontLine.length,
        energyLine: player.energyLine.length,
        sideline: player.sideline.length,
        removal: player.removal.length,
        apCards: player.apCards.length,
        activeAp: player.apCards.filter((ap) => !ap.rested).length,
        legalActions: legalActions(state, playerId).length
      }
    ]))
  };
}

export function analyzeSetupHand(state, playerId) {
  const player = state.players[playerId];
  const initialDefIds = player.initialHandDefIds ?? player.hand.map((card) => card.defId);
  const finalDefIds = player.keptHandDefIds
    ?? player.mulliganHandDefIds
    ?? initialDefIds;
  const initialZeroCostUnits = countSetupZeroCostUnits(state, initialDefIds);
  const finalZeroCostUnits = countSetupZeroCostUnits(state, finalDefIds);

  return {
    initialHandSize: initialDefIds.length,
    finalHandSize: finalDefIds.length,
    initialZeroCostUnitsSeen: initialZeroCostUnits,
    finalZeroCostUnitsSeen: finalZeroCostUnits,
    initialBricked: initialZeroCostUnits === 0,
    bricked: finalZeroCostUnits === 0
  };
}

export function countLifeTriggers(state, playerId, triggerType = TRIGGER_TYPES.SPECIAL) {
  const player = state.players[playerId];
  const lifeDefIds = player.startingLifeDefIds ?? player.life.map((card) => card.defId);
  return lifeDefIds.filter((defId) => state.catalog[defId]?.trigger?.type === triggerType).length;
}

export function catalogGameResult(state, { index = null, seed = null, statePath = null } = {}) {
  const p1Hand = analyzeSetupHand(state, "P1");
  const p2Hand = analyzeSetupHand(state, "P2");
  const p1 = state.players.P1;
  const p2 = state.players.P2;
  const turnsTaken = p1.turnsTaken + p2.turnsTaken;

  return {
    index,
    seed,
    statePath,
    complete: Boolean(state.winner) || state.phase === PHASES.GAME_OVER,
    winner: state.winner,
    p1Won: state.winner === "P1",
    p2Won: state.winner === "P2",
    firstPlayer: state.firstPlayer,
    secondPlayer: opponentOf(state.firstPlayer),
    turnsTaken,
    turnCyclesTaken: Math.max(p1.turnsTaken, p2.turnsTaken),
    p1TurnsTaken: p1.turnsTaken,
    p2TurnsTaken: p2.turnsTaken,
    p1LifeRemaining: p1.life.length,
    p2LifeRemaining: p2.life.length,
    p1Mulliganed: p1.mulliganUsed,
    p2Mulliganed: p2.mulliganUsed,
    p1Bricked: p1Hand.bricked,
    p2Bricked: p2Hand.bricked,
    p1InitialBricked: p1Hand.initialBricked,
    p2InitialBricked: p2Hand.initialBricked,
    p1ZeroCostUnitsSeen: p1Hand.finalZeroCostUnitsSeen,
    p2ZeroCostUnitsSeen: p2Hand.finalZeroCostUnitsSeen,
    p1InitialZeroCostUnitsSeen: p1Hand.initialZeroCostUnitsSeen,
    p2InitialZeroCostUnitsSeen: p2Hand.initialZeroCostUnitsSeen,
    p1SpecialTriggersInLife: countLifeTriggers(state, "P1", TRIGGER_TYPES.SPECIAL),
    p2SpecialTriggersInLife: countLifeTriggers(state, "P2", TRIGGER_TYPES.SPECIAL)
  };
}

export function runAutoplayGame(initialState, { maxActions = 1000, maxTurns = 100, policy } = {}) {
  let state = initialState;
  let steps = 0;
  let stoppedReason = null;
  const activatedThisTurn = new Set();
  const policies = normalizePilotPolicyConfig(policy);

  while (!state.winner && steps < maxActions) {
    if (turnsTaken(state) >= maxTurns) {
      stoppedReason = "maxTurns";
      break;
    }

    const playerId = state.pendingAttack?.defenderPlayer ?? state.activePlayer;
    const candidates = autoplayActionCandidates(state, playerId, {
      activatedThisTurn,
      policy: policies[playerId] ?? normalizePilotPolicy()
    });
    let nextState = null;

    for (const action of candidates) {
      try {
        const abilityKey = autoplayAbilityActionKey(state, action);
        nextState = applyAction(state, action);
        if (abilityKey) activatedThisTurn.add(abilityKey);
        break;
      } catch {
        nextState = null;
      }
    }

    if (!nextState) {
      stoppedReason = "noLegalAutoplayAction";
      break;
    }

    state = nextState;
    steps += 1;
  }

  stoppedReason ??= state.winner ? "winner" : "maxActions";
  state.log.push(`Autoplay stopped after ${steps} action(s): ${stoppedReason}.`);
  return { state, steps, stoppedReason };
}

function countSetupZeroCostUnits(state, defIds) {
  return defIds.filter((defId) => {
    const def = state.catalog[defId];
    return def?.type === CARD_TYPES.CHARACTER && setupRequiredEnergyForCardUse(def) === 0;
  }).length;
}

function setupRequiredEnergyForCardUse(def) {
  const base = Number(def?.requiredEnergy?.amount ?? 0);
  if (base === 0) return 0;
  const reduction = (def.useCostModifiers ?? [])
    .filter((modifier) => modifier.kind === "requiredEnergy")
    .filter((modifier) => !modifier.sourceZone || modifier.sourceZone === "hand")
    .filter((modifier) => !modifier.sourceZones || modifier.sourceZones.includes("hand"))
    .filter((modifier) => !modifier.color || modifier.color === def.requiredEnergy?.color)
    .filter((modifier) => setupCostConditionApplies(modifier.condition))
    .reduce((total, modifier) => total + Number(modifier.amount ?? 0), 0);
  return Math.max(0, base - reduction);
}

function setupCostConditionApplies(condition) {
  if (!condition || Object.keys(condition).length === 0) return true;
  if (condition.emptyField) return true;
  if (Array.isArray(condition.all)) return condition.all.every(setupCostConditionApplies);
  if (Array.isArray(condition.any)) return condition.any.some(setupCostConditionApplies);
  return false;
}

function turnsTaken(state) {
  return state.players.P1.turnsTaken + state.players.P2.turnsTaken;
}

function autoplayActionCandidates(state, playerId, memory = {}) {
  const policy = normalizePilotPolicy(memory.policy);
  const actions = legalActions(state, playerId);
  if (actions.length === 0) return [];

  if (state.pendingAttack?.defenderPlayer === playerId) {
    return actions
      .map((action) => withAutoplayChoices(state, playerId, action, policy))
      .sort((a, b) => pilotActionScore(state, playerId, b, policy) - pilotActionScore(state, playerId, a));
  }

  if (state.phase === PHASES.START) {
    return actions
      .sort((a, b) => pilotActionScore(state, playerId, b, policy) - pilotActionScore(state, playerId, a));
  }

  if (state.phase === PHASES.MOVEMENT) {
    const forwardMoves = actions.filter((action) => {
      return action.type === "moveCharacters"
        && action.moves.every((move) => move.from === LINES.ENERGY && move.to === LINES.FRONT);
    });
    return [
      ...forwardMoves.sort((a, b) => pilotActionScore(state, playerId, b, policy) - pilotActionScore(state, playerId, a)),
      ...actions.filter((action) => action.type === "advancePhase")
    ];
  }

  if (state.phase === PHASES.MAIN) {
    const player = state.players[playerId];
    const abilityActions = actions
      .filter((action) => action.type === "activateMainAbility")
      .filter((action) => !memory.activatedThisTurn?.has(autoplayAbilityActionKey(state, action)))
      .map((action) => withAutoplayChoices(state, playerId, action, policy))
      .filter((action) => pilotActionScore(state, playerId, action, policy) > 0)
      .sort((a, b) => pilotActionScore(state, playerId, b, policy) - pilotActionScore(state, playerId, a));
    const raidActions = actions
      .filter((action) => action.type === "performRaid")
      .filter((action) => !action.moveToFront || player.frontLine.length < MAX_LINE_SIZE)
      .map((action) => withAutoplayChoices(state, playerId, action, policy))
      .sort((a, b) => pilotActionScore(state, playerId, b, policy) - pilotActionScore(state, playerId, a));
    const playActions = actions
      .filter((action) => action.type === "playCard")
      .filter((action) => action.destination !== LINES.ENERGY || player.energyLine.length < MAX_LINE_SIZE)
      .filter((action) => action.destination !== LINES.FRONT || player.frontLine.length < MAX_LINE_SIZE)
      .map((action) => withAutoplayChoices(state, playerId, action, policy))
      .sort((a, b) => pilotActionScore(state, playerId, b, policy) - pilotActionScore(state, playerId, a));
    return [
      ...abilityActions,
      ...raidActions,
      ...playActions,
      ...actions.filter((action) => action.type === "advancePhase")
    ];
  }

  if (state.phase === PHASES.ATTACK) {
    return [
      ...actions
        .filter((action) => action.type === "declareAttack")
        .map((action) => withAutoplayChoices(state, playerId, action, policy))
        .sort((a, b) => pilotActionScore(state, playerId, b, policy) - pilotActionScore(state, playerId, a)),
      ...actions.filter((action) => action.type === "advancePhase")
    ];
  }

  if (state.phase === PHASES.END) {
    return actions.map((action) => {
      if (action.type !== "discardForHandLimit") return action;
      const excess = Math.max(0, state.players[playerId].hand.length - 8);
      return {
        ...action,
        handIndices: [...Array(excess).keys()]
      };
    });
  }

  return actions;
}

function normalizePilotPolicyConfig(policy) {
  if (!policy) {
    const baseline = normalizePilotPolicy();
    return { P1: baseline, P2: baseline };
  }
  if (policy.P1 || policy.P2) {
    const baseline = normalizePilotPolicy();
    return {
      P1: normalizePilotPolicy(policy.P1 ?? baseline),
      P2: normalizePilotPolicy(policy.P2 ?? baseline)
    };
  }
  const normalized = normalizePilotPolicy(policy);
  return { P1: normalized, P2: normalized };
}

export function scorePilotAction(state, playerId, action, policy = {}) {
  const normalized = normalizePilotPolicy(policy);
  const features = pilotActionFeatures(state, playerId, action);
  return Object.entries(features).reduce((total, [feature, value]) => {
    return total + Number(normalized.weights[feature] ?? 0) * Number(value ?? 0);
  }, 0);
}

export function pilotActionFeatures(state, playerId, action) {
  const features = { baseScore: 1 };
  const player = state.players[playerId];

  if (action.type === "advancePhase") {
    features.advancePhase = 1;
    return features;
  }

  if (action.type === "extraDraw") {
    features.extraDraw = 1;
    return features;
  }

  if (action.type === "moveCharacters") {
    const moves = action.moves ?? [];
    const forwardMoves = moves.filter((move) => move.from === LINES.ENERGY && move.to === LINES.FRONT);
    features.moveToFront = forwardMoves.length;
    features.movedBp = forwardMoves.reduce((total, move) => {
      return total + permanentBattlePower(state, player.energyLine[move.index]) / 1000;
    }, 0);
    features.lineCrowdingPenalty = Math.max(0, player.frontLine.length + forwardMoves.length - MAX_LINE_SIZE);
    return features;
  }

  if (action.type === "activateMainAbility") {
    const source = action.zone ? undefined : player[action.line]?.[action.index];
    const ability = sourceAbility(state, playerId, action);
    features.activateMain = 1;
    features.abilityEffect = ability
      ? (effectScore(state, playerId, ability.effect, source) - abilityCostPenalty(state, playerId, source, ability)) / 100
      : -10;
    return features;
  }

  if (action.type === "performRaid") {
    const card = player.hand[action.handIndex];
    const def = state.catalog[card?.defId];
    const targetLine = action.targetLine === LINES.FRONT ? player.frontLine : player.energyLine;
    const target = targetLine[action.targetIndex];
    const targetDef = state.catalog[target?.cards?.at(-1)?.defId];
    features.performRaid = 1;
    features.raidBpUpgrade = Math.max(0, Number(def?.bp ?? 0) - Number(targetDef?.bp ?? 0)) / 1000;
    features.moveRaidToFront = action.moveToFront ? 1 : 0;
    features.highBpUnit = Number(def?.bp ?? 0) / 1000;
    features.lineCrowdingPenalty = action.moveToFront && player.frontLine.length >= MAX_LINE_SIZE ? 1 : 0;
    features.playCard = 1;
    return features;
  }

  if (action.type === "playCard") {
    const card = player.hand[action.handIndex];
    const def = state.catalog[card?.defId];
    const requiredEnergy = def ? internals.requiredEnergyForCardUse(state, playerId, def, { sourceZone: "hand" }) : 0;
    const available = def?.requiredEnergy?.color ? internals.energyAvailable(state, playerId)[def.requiredEnergy.color] ?? 0 : 0;
    features.playCard = 1;
    features.lowCostUnit = def?.type === CARD_TYPES.CHARACTER && requiredEnergy <= 1 ? 1 : 0;
    features.highBpUnit = Number(def?.bp ?? 0) / 1000;
    features.event = def?.type === CARD_TYPES.EVENT ? 1 : 0;
    if (action.destination === LINES.ENERGY) {
      features.playToEnergy = 1;
      features.earlyEnergy = Math.max(0, MAX_LINE_SIZE - player.energyLine.length) / MAX_LINE_SIZE;
      features.energyShortage = Math.max(0, requiredEnergy + 1 - available);
      features.lineCrowdingPenalty = player.energyLine.length >= MAX_LINE_SIZE ? 1 : 0;
    }
    if (action.destination === LINES.FRONT) {
      features.playToFront = 1;
      features.lineCrowdingPenalty = player.frontLine.length >= MAX_LINE_SIZE ? 1 : 0;
    }
    return features;
  }

  if (action.type === "declareAttack") {
    const attacker = attackerPermanentForAction(state, playerId, action);
    const damage = attacker ? directDamageAmount(state, attacker) : 1;
    const opponent = state.players[opponentOf(playerId)];
    features.damageThreat = damage;
    features.attackerBp = permanentBattlePower(state, attacker) / 1000;
    if (action.target?.type === "character") {
      const defender = opponent.frontLine[action.target.index];
      features.attackCharacter = 1;
      features.removalTargetBp = permanentBattlePower(state, defender) / 1000;
      features.attackBpAdvantage = attacker && defender && permanentBattlePower(state, attacker) >= permanentBattlePower(state, defender) ? 1 : -1;
    } else {
      features.attackPlayer = 1;
      features.lethalAttack = opponent.life.length <= damage ? 1 : 0;
    }
    return features;
  }

  if (action.type === "declareBlock") {
    const context = pendingAttackContext(state, playerId);
    const blocker = player.frontLine[action.blockerIndex];
    const damage = context.attacker ? directDamageAmount(state, context.attacker) : 1;
    const impactDamage = context.attacker && blocker ? impactDamageAmount(state, context.attacker, blocker) : 0;
    const blockerBp = permanentBattlePower(state, blocker);
    const attackerBp = permanentBattlePower(state, context.attacker);
    features.block = 1;
    features.savedDamage = Math.max(0, damage - impactDamage);
    features.lethalBlock = player.life.length <= damage ? 1 : 0;
    features.favorableBlock = blockerBp > attackerBp ? 1 : 0;
    features.blockerDies = attackerBp >= blockerBp ? 1 : 0;
    features.highValueBlocker = blockerBp / 1000;
    features.impactLeak = impactDamage;
    return features;
  }

  if (action.type === "declineBlock") {
    const context = pendingAttackContext(state, playerId);
    const damage = context.attacker ? directDamageAmount(state, context.attacker) : 1;
    features.declineBlock = 1;
    features.damageTaken = damage;
    features.declineLethal = player.life.length <= damage ? 1 : 0;
    return features;
  }

  if (action.type === "discardForHandLimit") {
    features.discard = 1;
    return features;
  }

  return features;
}

function pilotActionScore(state, playerId, action, policy) {
  return scorePilotAction(state, playerId, action, policy);
}

function mainActionScore(state, playerId, action) {
  const player = state.players[playerId];
  if (action.type === "activateMainAbility") {
    const source = action.zone ? undefined : player[action.line]?.[action.index];
    const ability = sourceAbility(state, playerId, action);
    if (!ability) return 0;
    return 500 + effectScore(state, playerId, ability.effect, source) - abilityCostPenalty(state, playerId, source, ability);
  }

  const card = player.hand[action.handIndex];
  const def = state.catalog[card?.defId];
  if (!def) return 0;

  const requiredEnergy = Number(def.requiredEnergy?.amount ?? 0);
  const apCost = Number(def.apCost ?? 0);
  const efficiencyPenalty = requiredEnergy * 10 + apCost * 20;

  if (action.type === "performRaid") {
    const targetLine = action.targetLine === LINES.FRONT ? state.players[playerId].frontLine : state.players[playerId].energyLine;
    const target = targetLine[action.targetIndex];
    const targetDef = state.catalog[target?.cards?.at(-1)?.defId];
    const upgrade = Math.max(0, Number(def.bp ?? 0) - Number(targetDef?.bp ?? 0)) / 10;
    return 1200 + upgrade + (action.moveToFront ? 100 : 0) - efficiencyPenalty;
  }

  if (action.destination === LINES.ENERGY) {
    return 1000 - player.energyLine.length * 50 - efficiencyPenalty;
  }

  if (action.destination === LINES.FRONT && def.type === CARD_TYPES.CHARACTER) {
    return 600 + Number(def.bp ?? 0) / 10 - efficiencyPenalty;
  }

  if (def.type === CARD_TYPES.EVENT) {
    return 250 - efficiencyPenalty;
  }

  return 100 - efficiencyPenalty;
}

function autoplayAbilityActionKey(state, action) {
  if (action.type !== "activateMainAbility") return undefined;
  const player = state.players[action.player];
  if (action.zone) {
    const card = player?.[action.zone]?.[action.zoneIndex ?? action.index];
    if (!player || !card) return undefined;
    return `${action.player}:${player.turnsTaken}:${action.zone}:${card.uid}:${action.abilityId}`;
  }
  const permanent = player?.[action.line]?.[action.index];
  if (!player || !permanent) return undefined;
  return `${action.player}:${player.turnsTaken}:${permanent.pid}:${action.abilityId}`;
}

function sourceAbility(state, playerId, action) {
  if (action.zone) {
    const card = state.players[playerId]?.[action.zone]?.[action.zoneIndex ?? action.index];
    const def = state.catalog[card?.defId];
    return (def?.abilities ?? []).find((ability) => ability.id === action.abilityId);
  }
  const permanent = state.players[playerId]?.[action.line]?.[action.index];
  return permanentAbilities(state, permanent).find((ability) => ability.id === action.abilityId);
}

function permanentAbilities(state, permanent) {
  if (!permanent) return [];
  const def = state.catalog[permanent.cards?.at(-1)?.defId];
  return [
    ...(def?.abilities ?? []),
    ...(permanent.gainedAbilities ?? [])
  ];
}

function withAutoplayChoices(state, playerId, action) {
  const choices = {};
  if (action.type === "activateMainAbility") {
    const permanent = action.zone ? undefined : state.players[playerId]?.[action.line]?.[action.index];
    const ability = sourceAbility(state, playerId, action);
    if (ability) addChoicesForEffect(choices, state, playerId, ability.effect, permanent);
  } else if (action.type === "playCard") {
    const card = state.players[playerId].hand[action.handIndex];
    const def = state.catalog[card?.defId];
    if (def?.type === CARD_TYPES.EVENT) addChoicesForEffect(choices, state, playerId, def.eventEffect);
  }

  return Object.keys(choices).length > 0 ? { ...action, choices } : action;
}

function addChoicesForEffect(choices, state, playerId, effect, sourcePermanent) {
  if (!effect) return;

  if (effect.kind === "sequence") {
    for (const child of effect.effects ?? []) addChoicesForEffect(choices, state, playerId, child, sourcePermanent);
    return;
  }

  if (effect.kind === "optional") {
    const choiceKey = effect.choiceKey ?? "optionalEffect";
    choices[choiceKey] = effectScore(state, playerId, effect.effect, sourcePermanent) > 0;
    if (choices[choiceKey]) addChoicesForEffect(choices, state, playerId, effect.effect, sourcePermanent);
    return;
  }

  if (effect.kind === "optionalChoiceUpgrade") {
    const upgradedScore = effectScore(state, playerId, effect.upgradedEffect, sourcePermanent)
      + effectScore(state, playerId, effect.costEffect, sourcePermanent);
    const baseScore = effectScore(state, playerId, effect.baseEffect, sourcePermanent);
    choices[effect.choiceKey ?? "optionalChoiceUpgrade"] = upgradedScore >= baseScore;
    addChoicesForEffect(choices, state, playerId, upgradedScore >= baseScore ? effect.upgradedEffect : effect.baseEffect, sourcePermanent);
    if (upgradedScore >= baseScore) addChoicesForEffect(choices, state, playerId, effect.costEffect, sourcePermanent);
    return;
  }

  if (effect.kind === "conditional") {
    addChoicesForEffect(choices, state, playerId, effect.effect, sourcePermanent);
    addChoicesForEffect(choices, state, playerId, effect.elseEffect, sourcePermanent);
    return;
  }

  if (effect.kind === "targetConditional") {
    addChoicesForEffect(choices, state, playerId, effect.effect, sourcePermanent);
    addChoicesForEffect(choices, state, playerId, effect.elseEffect, sourcePermanent);
  }

  if (effect.kind === "chooseOne") {
    const scored = (effect.choices ?? []).map((choice, index) => ({
      index,
      score: effectScore(state, playerId, choice.effect, sourcePermanent)
    }));
    scored.sort((a, b) => b.score - a.score);
    if (scored[0]) {
      choices[effect.choiceKey ?? "effectChoice"] = scored[0].index;
      addChoicesForEffect(choices, state, playerId, effect.choices[scored[0].index]?.effect, sourcePermanent);
    }
    return;
  }

  if (effect.kind === "chooseN") {
    const min = effect.min ?? 0;
    const max = effect.max ?? effect.choices?.length ?? 1;
    const scored = (effect.choices ?? []).map((choice, index) => ({
      index,
      score: effectScore(state, playerId, choice.effect, sourcePermanent)
    })).sort((a, b) => b.score - a.score);
    const selected = scored
      .filter((item, index) => item.score > 0 || index < min)
      .slice(0, max)
      .map((item) => item.index);
    choices[effect.choiceKey ?? "effectChoices"] = selected;
    for (const index of selected) addChoicesForEffect(choices, state, playerId, effect.choices[index]?.effect, sourcePermanent);
    return;
  }

  if (effect.kind === "playCardFromZone") {
    const selected = bestZoneCardChoice(state, playerId, effect);
    if (selected !== undefined) choices[effect.choiceKey ?? `${effect.zone ?? effect.zones?.[0] ?? "hand"}Index`] = selected;
    return;
  }

  if (effect.kind === "lookTopDeckPlayOneAndMoveRest") {
    const count = Math.min(effect.count ?? effect.amount ?? 1, state.players[playerId].deck.length);
    const candidates = state.players[playerId].deck
      .slice(0, count)
      .map((card, index) => ({ card, index, score: cardValue(state, card) }))
      .filter(({ card }) => zoneCardMatches(state, card, effect.filter ?? {}))
      .sort((a, b) => b.score - a.score);
    if (candidates[0]) choices[effect.choiceKey ?? "lookPlayIndex"] = candidates[0].index;
    return;
  }

  if (effect.kind === "playCardFromZoneMatchingTargetName") {
    const selector = targetSelectorForEffect(effect);
    const selectedTargets = selector ? bestTargetsForEffect(state, playerId, effect, selector, sourcePermanent) : [];
    if (selectedTargets.length > 0) choices[selector.choiceKey ?? "targets"] = selectedTargets;
    return;
  }

  if (effect.kind === "useEventFromZone") {
    const selected = bestZoneCardChoice(state, playerId, effect);
    if (selected !== undefined) choices[effect.choiceKey ?? `${effect.source ?? "sideline"}Index`] = selected;
    return;
  }

  if (effect.kind === "moveHandToZone") {
    const count = effect.count ?? effect.amount ?? 1;
    const indices = lowestValueHandIndices(state, playerId, count, effect.filter);
    const min = effect.min ?? count;
    if (indices.length >= min) choices[effect.choiceKey ?? "handIndices"] = indices.slice(0, count);
    return;
  }

  if (effect.kind === "moveHandCardsUnderSelf" || effect.kind === "moveHandCardsUnderTargets") {
    const count = effect.count ?? effect.amount ?? effect.max ?? 1;
    const indices = lowestValueHandIndices(state, playerId, count, effect.filter);
    const min = effect.min ?? count;
    if (indices.length >= min) choices[effect.choiceKey ?? "handIndices"] = indices.slice(0, count);
    return;
  }

  if (effect.kind === "opponentMaySidelineChosenTargetsElse") {
    const selected = [];
    for (const selector of effect.targets ?? []) {
      const targets = bestTargetsForEffect(state, playerId, { kind: "sidelineTargets", target: selector }, selector, sourcePermanent);
      if (targets.length > 0) {
        choices[selector.choiceKey ?? "targets"] = targets;
        selected.push(targets[0]);
      }
    }
    if (selected.length > 0) {
      const lowest = selected
        .map((target, index) => {
          const permanent = state.players[target.player]?.[target.lineName]?.[target.index];
          return {
            index,
            score: permanent ? permanentBattlePower(state, permanent) + (target.lineName === LINES.FRONT ? 500 : 0) : 0
          };
        })
        .sort((a, b) => a.score - b.score)[0];
      choices[effect.choiceKey ?? "opponentSidelineChoice"] = lowest?.index ?? 0;
    }
    return;
  }

  const selector = targetSelectorForEffect(effect);
  if (!selector) return;
  const selectedTargets = bestTargetsForEffect(state, playerId, effect, selector, sourcePermanent);
  if (selectedTargets.length > 0) {
    choices[selector.choiceKey ?? "targets"] = selectedTargets;
  }
}

function targetSelectorForEffect(effect) {
  if (!effect || effect.target === "self") return undefined;
  return typeof effect.target === "object" ? effect.target : undefined;
}

function bestTargetsForEffect(state, playerId, effect, selector, sourcePermanent) {
  const candidates = targetCandidates(state, playerId, selector, sourcePermanent)
    .sort((a, b) => targetScore(state, playerId, effect, b) - targetScore(state, playerId, effect, a));
  const max = selector.max ?? selector.amount ?? 1;
  const min = selector.min ?? 0;
  if (candidates.length < min) return [];
  return candidates.slice(0, max).map((candidate) => ({
    player: candidate.playerId,
    lineName: candidate.lineName,
    index: candidate.index
  }));
}

function targetCandidates(state, playerId, selector, sourcePermanent) {
  const candidates = [];
  for (const targetPlayerId of selectorPlayerIds(playerId, selector)) {
    const targetPlayer = state.players[targetPlayerId];
    for (const lineName of selectorLineNames(selector.line)) {
      targetPlayer[lineName].forEach((permanent, index) => {
        const def = state.catalog[permanent.cards.at(-1).defId];
        if (selector.type && def.type !== selector.type) return;
        if (selector.rested !== undefined && permanent.rested !== selector.rested) return;
        if (selector.active !== undefined && permanent.rested === selector.active) return;
        if (selector.name && !sameText(def.name, selector.name)) return;
        if (selector.names && !selector.names.some((name) => sameText(def.name, name))) return;
        if (selector.otherThanName && sameText(def.name, selector.otherThanName)) return;
        if (selector.affinity && !includesText(def.affinities, selector.affinity)) return;
        if (selector.affinities && !def.affinities?.some((affinity) => includesText(selector.affinities, affinity))) return;
        if (selector.hasAbilityTiming && !permanentAbilities(state, permanent).some((ability) => ability.timing === selector.hasAbilityTiming)) return;
        if (selector.hasUnderCards && permanent.cards.length <= 1) return;
        if (selector.hasFaceDownUnder && !permanent.cards.slice(0, -1).some((card) => card.faceUp === false)) return;
        if (selector.noFaceDownUnder && permanent.cards.slice(0, -1).some((card) => card.faceUp === false)) return;
        if (selector.raided && permanent.cards.length <= 1) return;
        if (selector.notRaided && permanent.cards.length > 1) return;
        if (selector.hasRaid && !def.raid) return;
        if (selector.otherThanSource && sourcePermanent?.pid === permanent.pid) return;
        if (selector.bpMax !== undefined && permanentBattlePower(state, permanent) > selector.bpMax) return;
        if (selector.bpMin !== undefined && permanentBattlePower(state, permanent) < selector.bpMin) return;
        if (selector.energyGenerationMax !== undefined && permanentEnergyGeneration(state, permanent) > selector.energyGenerationMax) return;
        if (selector.energyGenerationMin !== undefined && permanentEnergyGeneration(state, permanent) < selector.energyGenerationMin) return;
        if (selector.requiredEnergyMax !== undefined && (def.requiredEnergy?.amount ?? 0) > selector.requiredEnergyMax) return;
        if (selector.requiredEnergyMin !== undefined && (def.requiredEnergy?.amount ?? 0) < selector.requiredEnergyMin) return;
        if (selector.color && def.color !== selector.color) return;
        candidates.push({ playerId: targetPlayerId, lineName, index, permanent });
      });
    }
  }
  return candidates;
}

function selectorPlayerIds(playerId, selector) {
  const controller = selector.controller ?? selector.player ?? "self";
  if (controller === "self") return [playerId];
  if (controller === "opponent") return [opponentOf(playerId)];
  if (controller === "any" || controller === "both") return [playerId, opponentOf(playerId)];
  return [controller];
}

function selectorLineNames(line) {
  if (!line || line === "field") return [LINES.FRONT, LINES.ENERGY];
  if (line === "front") return [LINES.FRONT];
  if (line === "energy") return [LINES.ENERGY];
  return [line];
}

function targetScore(state, playerId, effect, target) {
  const isOpponent = target.playerId !== playerId;
  const bp = permanentBattlePower(state, target.permanent);
  const frontBonus = target.lineName === LINES.FRONT ? 200 : 0;
  const activeBonus = target.permanent.rested ? 0 : 100;

  if (["sidelineTargets", "returnTargetsToHand", "moveTargetsToBottomDeck", "moveTargetsToDeck", "moveTargetsToLife", "moveTopRaidCardToZone"].includes(effect.kind)) {
    return isOpponent ? bp + frontBonus : -bp;
  }
  if (effect.kind === "restTargets") return isOpponent ? bp + activeBonus + frontBonus : -bp;
  if (effect.kind === "readyTargets") return !isOpponent ? (target.permanent.rested ? 400 : 0) + bp : -bp;
  if (effect.kind === "modifyBp") {
    const amount = effect.amount ?? 0;
    if (amount >= 0) return !isOpponent ? bp + frontBonus : -bp;
    return isOpponent ? bp + frontBonus : -bp;
  }
  if (effect.kind === "grantKeyword" || effect.kind === "grantAbility") return !isOpponent ? bp + frontBonus : -bp;
  if (effect.kind === "targetConditional") return bp + frontBonus;
  if (effect.kind === "moveTargetsToLine" || effect.kind === "moveTargetsToOtherLine") return isOpponent ? bp + frontBonus : 100 - bp;
  return bp + frontBonus;
}

function effectScore(state, playerId, effect, sourcePermanent) {
  if (!effect || effect.kind === "none") return 0;
  switch (effect.kind) {
    case "sequence":
      return (effect.effects ?? []).reduce((total, child) => total + effectScore(state, playerId, child, sourcePermanent), 0);
    case "optional":
      return Math.max(0, effectScore(state, playerId, effect.effect, sourcePermanent));
    case "optionalChoiceUpgrade":
      return Math.max(
        effectScore(state, playerId, effect.baseEffect, sourcePermanent),
        effectScore(state, playerId, effect.upgradedEffect, sourcePermanent) + effectScore(state, playerId, effect.costEffect, sourcePermanent)
      );
    case "chooseOne":
      return Math.max(0, ...(effect.choices ?? []).map((choice) => effectScore(state, playerId, choice.effect, sourcePermanent)));
    case "chooseN": {
      const min = effect.min ?? 0;
      const max = effect.max ?? effect.choices?.length ?? 1;
      const scores = (effect.choices ?? []).map((choice) => effectScore(state, playerId, choice.effect, sourcePermanent)).sort((a, b) => b - a);
      return scores.filter((score, index) => score > 0 || index < min).slice(0, max).reduce((sum, score) => sum + score, 0);
    }
    case "conditional":
      return Math.max(
        effectScore(state, playerId, effect.effect, sourcePermanent),
        effectScore(state, playerId, effect.elseEffect, sourcePermanent)
      );
    case "targetConditional":
      return Math.max(
        effectScore(state, playerId, effect.effect, sourcePermanent),
        effectScore(state, playerId, effect.elseEffect, sourcePermanent)
      ) + bestTargetScore(state, playerId, effect, sourcePermanent) / 40;
    case "draw":
      return 120 * (effect.amount ?? 1);
    case "drawLastMovedFromHandCount":
      return 120;
    case "drawUntilHandSize": {
      const target = effect.sameAsOpponent ? state.players[opponentOf(playerId)].hand.length : effect.handSize ?? 0;
      return 100 * Math.max(0, target - state.players[playerId].hand.length);
    }
    case "scheduleSidelineTargetsAndMoveSelfToEnergy":
      return 260 + bestTargetScore(state, playerId, effect, sourcePermanent) / 25;
    case "searchTopDeck":
      return 120 * (effect.max ?? effect.amount ?? 1);
    case "lookTopDeck":
      return 10 * (effect.count ?? effect.amount ?? 1);
    case "lookTopDeckAndMove":
      return 50 * (effect.count ?? effect.amount ?? 1);
    case "lookTopDeckPlayOneAndMoveRest":
      return 360 + 20 * (effect.count ?? effect.amount ?? 1);
    case "moveTopDeck":
      return effect.destination === "sideline" ? 30 * (effect.count ?? effect.amount ?? 1) : 20;
    case "placeTopDeckUnderSelf":
      return 80 * (effect.count ?? effect.amount ?? 1);
    case "placeTopDeckUnderTargets":
      return 80 * (effect.count ?? effect.amount ?? 1) + bestTargetScore(state, playerId, effect, sourcePermanent) / 40;
    case "readyAp":
      return 100 * (effect.amount ?? effect.count ?? 1);
    case "payAp":
      return -180 * (effect.amount ?? 1);
    case "grantEnergy":
      return sourcePermanent?.rested ? 80 : 160;
    case "scheduleSidelineSelfAtEndOfMain":
      return -140;
    case "modifyBp":
      return Math.abs(effect.amount ?? 0) / 5 + bestTargetScore(state, playerId, effect, sourcePermanent) / 20;
    case "modifyBpLastPlayedPermanent":
      return Math.abs(effect.amount ?? 0) / 5 + 80;
    case "modifyBpForHandReveal":
      return (effect.amountPerCard ?? 0) * state.players[playerId].hand.length / 5;
    case "modifyBpForLastMovedUnderCards":
      return (effect.amountPerCard ?? 0) / 5;
    case "modifyBpForLastMovedFromHandCards":
      return (effect.amountPerCard ?? 0) * Math.max(1, state.players[playerId].hand.length) / 5;
    case "modifyBpForLastMovedCards":
      return (effect.amountPerCard ?? 0) / 5;
    case "sidelineTargetsByUniqueAffinityReveal":
      return 360 + bestTargetScore(state, playerId, effect, sourcePermanent) / 20;
    case "readyTargets":
      return 120 + bestTargetScore(state, playerId, effect, sourcePermanent) / 20;
    case "readyLastPlayedPermanent":
      return 140;
    case "restTargets":
      return 220 + bestTargetScore(state, playerId, effect, sourcePermanent) / 20;
    case "grantKeyword":
      return keywordScore(effect.keyword, effect.value) + bestTargetScore(state, playerId, effect, sourcePermanent) / 30;
    case "grantAbility":
      return effectScore(state, playerId, effect.ability?.effect, sourcePermanent)
        + bestTargetScore(state, playerId, effect, sourcePermanent) / 30;
    case "sidelineTargets":
      return 450 + bestTargetScore(state, playerId, effect, sourcePermanent) / 20;
    case "sidelineTargetsAndDraw":
      return 180;
    case "returnTargetsToHand":
    case "moveTargetsToBottomDeck":
    case "moveTargetsToDeck":
    case "moveTargetsToLife":
      return 320 + bestTargetScore(state, playerId, effect, sourcePermanent) / 25;
    case "moveTopRaidCardToZone":
      return 300 + bestTargetScore(state, playerId, effect, sourcePermanent) / 25;
    case "damageOpponent":
      return damageScore(state, playerId, effect.amount ?? 1);
    case "damage":
      return damageScore(state, playerId, effect.amount ?? 1);
    case "discardOpponentFromHand":
      return 100 * Math.min(effect.amount ?? 1, state.players[opponentOf(playerId)].hand.length);
    case "revealOpponentHand":
      return 20 * state.players[opponentOf(playerId)].hand.length;
    case "moveHandToZone":
      return -70 * (effect.amount ?? effect.count ?? 1);
    case "moveAllHandToZone":
      return -70 * state.players[playerId].hand.length;
    case "playCardFromZone":
      return bestZoneCardChoice(state, playerId, effect) !== undefined ? 380 : 0;
    case "playOrRaidCardFromZone":
      return bestZoneCardChoice(state, playerId, effect) !== undefined ? 420 : 0;
    case "playCardFromZoneMatchingTargetName":
      return 300 + bestTargetScore(state, playerId, effect, sourcePermanent) / 30;
    case "playSomeNamedFromSidelineAddRest":
      return 500;
    case "playSourceFromZone":
      return 420;
    case "moveSourceCardBetweenZones":
      return effect.destination === "hand" ? 180 : 60;
    case "useEventFromZone":
      return bestZoneCardChoice(state, playerId, effect) !== undefined ? 260 : 0;
    case "reduceNextUseApCost":
      return hasMatchingHandCard(state, playerId, effect.filter) ? 260 * (effect.amount ?? 1) : 80 * (effect.amount ?? 1);
    case "reduceRequiredEnergy":
      return hasMatchingHandCard(state, playerId, effect.filter) ? 180 * (effect.amount ?? 1) : 60;
    case "modifyNextBpRange":
      return 80;
    case "moveCardBetweenZones":
      return 140 * (effect.count ?? effect.amount ?? 1);
    case "moveEqualCountsBetweenZones":
      return 100;
    case "moveUnderCardsToZone":
      return 160;
    case "moveHandCardsUnderSelf":
      return 80 * (effect.count ?? effect.amount ?? effect.max ?? 1);
    case "moveHandCardsUnderTargets":
      return 80 * (effect.count ?? effect.amount ?? effect.max ?? 1) + bestTargetScore(state, playerId, effect, sourcePermanent) / 40;
    case "moveZoneCardsUnderSelf":
      return 120;
    case "moveZoneCardsUnderTargets":
      return 120 + bestTargetScore(state, playerId, effect, sourcePermanent) / 40;
    case "moveSelfCardToDeckTop":
      return 40;
    case "moveSelfCardToZone":
      return effect.destination === "hand" ? 160 : 60;
    case "moveSelfCardUnderTarget":
      return 120 + bestTargetScore(state, playerId, effect, sourcePermanent) / 40;
    case "playBaseCardFromSelf":
      return 260;
    case "swapOwnFrontAndEnergy":
      return 40;
    case "swapChosenTargets":
      return 60;
    case "swapSourceWithOtherLine":
      return 80;
    case "replayTargets":
      return 260 + bestTargetScore(state, playerId, effect, sourcePermanent) / 25;
    case "activateTargetAbility":
      return 220 + bestTargetScore(state, playerId, effect, sourcePermanent) / 30;
    case "waiveAbilityCostForTargets":
      return 180 + bestTargetScore(state, playerId, effect, sourcePermanent) / 40;
    case "copyActivatedAbility":
      return 220 + bestTargetScore(state, playerId, effect, sourcePermanent) / 35;
    case "copyActivatedAbilitiesFromMovedCards":
      return 220;
    case "restEnergyLineForRequiredEnergyTotal":
      return 90;
    case "applyTieredAbilityGrants":
      return (effect.tiers ?? [])
        .flatMap((tier) => tier.effects ?? [])
        .reduce((total, child) => total + effectScore(state, playerId, child, sourcePermanent), 0);
    case "suppressPlayedAbilities":
      return 50;
    case "activateTriggerFromZone":
      return bestZoneCardChoice(state, playerId, effect) !== undefined ? 240 : 0;
    case "targetingModifier":
      return 120;
    case "choiceModeModifier":
      return 220;
    case "replacementOrUseRestriction":
      return 0;
    case "watchTargetSidelinedForZoneMove":
      return 120 + bestTargetScore(state, playerId, effect, sourcePermanent) / 40;
    case "watchTargetSidelinedForEffect":
      return effectScore(state, playerId, effect.effect, sourcePermanent)
        + bestTargetScore(state, playerId, effect, sourcePermanent) / 40;
    case "moveTargetsToLine":
    case "moveTargetsToOtherLine":
      return 100 + bestTargetScore(state, playerId, effect, sourcePermanent) / 30;
    case "sidelineTargetsThenActivateSourceWhenPlayed":
      return 250;
    case "opponentMaySidelineChosenTargetsElse":
      return Math.max(120, effectScore(state, playerId, effect.elseEffect, sourcePermanent) - 120);
    case "unsupported":
      return -1000;
    default:
      return 0;
  }
}

function bestTargetScore(state, playerId, effect, sourcePermanent) {
  const selector = targetSelectorForEffect(effect);
  if (!selector) return 0;
  const scores = targetCandidates(state, playerId, selector, sourcePermanent)
    .map((target) => targetScore(state, playerId, effect, target));
  return scores.length === 0 ? 0 : Math.max(...scores);
}

function keywordScore(keyword, value = 1) {
  if (keyword === "damage") return 280 * Number(value ?? 1);
  if (keyword === "impact") return 220 * Number(value ?? 1);
  if (keyword === "doubleAttack") return 260;
  if (keyword === "doubleBlock") return 120;
  if (keyword === "snipe") return 180;
  if (keyword === "mustBlock") return 120;
  if (keyword === "drawOnAttack") return 170;
  if (keyword === "raidTargetForAnyRaid") return 140;
  if (keyword === "moveToFrontOnEnergyAttack") return 130;
  if (keyword === "playSelfWhenSidelined") return 100;
  if (keyword === "drawOnUnblockedAttack") return 180;
  if (keyword === "cantBeBlockedByBpMin") return 170;
  if (keyword === "cantBeBlockedByBpMax") return 150;
  if (keyword === "frontLineEnergyGeneration") return 160;
  if (keyword === "cantAttack") return -300;
  if (keyword === "opponentAbilityTargetTax") return 80;
  return 80;
}

function damageScore(state, playerId, amount) {
  const opponent = state.players[opponentOf(playerId)];
  const lethalBonus = opponent.life.length <= amount ? 1000 : 0;
  return lethalBonus + 360 * amount;
}

function abilityCostPenalty(state, playerId, sourcePermanent, ability) {
  const cost = ability.cost ?? {};
  let penalty = 0;
  if (cost.restSelf) penalty += sourcePermanent && sourcePermanent.rested ? 1000 : 120;
  if (cost.sidelineSelf) penalty += 260 + permanentBattlePower(state, sourcePermanent) / 30;
  if (cost.ap) penalty += 180 * cost.ap;
  if (cost.discardFromHand) penalty += 90 * cost.discardFromHand;
  if (ability.oncePerTurn || ability.oncePerTurnKey) penalty += 20;
  return penalty;
}

function bestZoneCardChoice(state, playerId, effect) {
  const zones = effect.zones ?? [effect.zone ?? effect.source ?? "hand"];
  const zonePlayerId = effect.player === "opponent" ? opponentOf(playerId) : effect.player ?? playerId;
  let bestChoice = undefined;
  let bestScore = -Infinity;
  for (const zoneName of zones) {
    const zone = state.players[zonePlayerId]?.[zoneName] ?? [];
    zone.forEach((card, index) => {
      if (!zoneCardMatches(state, card, effect.filter)) return;
      const score = cardValue(state, card) + (zoneName === "sideline" ? 50 : 0);
      if (score > bestScore) {
        bestScore = score;
        bestChoice = zones.length === 1 ? index : { zone: zoneName, index };
      }
    });
  }
  return bestChoice;
}

function hasMatchingHandCard(state, playerId, filter = {}) {
  return state.players[playerId].hand.some((card) => zoneCardMatches(state, card, filter));
}

function lowestValueHandIndices(state, playerId, count, filter) {
  return state.players[playerId].hand
    .map((card, index) => ({ index, score: cardValue(state, card) }))
    .filter(({ index }) => !filter || zoneCardMatches(state, state.players[playerId].hand[index], filter))
    .sort((a, b) => a.score - b.score)
    .slice(0, count)
    .map((item) => item.index);
}

function zoneCardMatches(state, cardRef, filter = {}) {
  const def = state.catalog[cardRef.defId];
  if (filter.anyOf && !filter.anyOf.some((childFilter) => zoneCardMatches(state, cardRef, childFilter))) return false;
  if (filter.type && def.type !== filter.type) return false;
  if (filter.color && def.color !== filter.color) return false;
  if (filter.requiredEnergyMax !== undefined && (def.requiredEnergy?.amount ?? 0) > filter.requiredEnergyMax) return false;
  if (filter.requiredEnergyMin !== undefined && (def.requiredEnergy?.amount ?? 0) < filter.requiredEnergyMin) return false;
  if (filter.apCost !== undefined && (def.apCost ?? 0) !== filter.apCost) return false;
  if (filter.name && !sameText(def.name, filter.name)) return false;
  if (filter.names && !filter.names.some((name) => sameText(def.name, name))) return false;
  if (filter.affinity && !includesText(def.affinities, filter.affinity)) return false;
  if (filter.affinities && !def.affinities?.some((affinity) => includesText(filter.affinities, affinity))) return false;
  if (filter.withoutRaid && def.raid) return false;
  if (filter.requiredEnergyFulfilled && !internals.hasRequiredEnergy(state, cardRef.owner, def)) return false;
  return true;
}

function cardValue(state, cardRef) {
  const def = state.catalog[cardRef.defId];
  if (!def) return 0;
  const bp = Number(def.bp ?? 0) / 10;
  const energy = Number(def.requiredEnergy?.amount ?? 0) * 20;
  const ap = Number(def.apCost ?? 0) * 30;
  const trigger = def.trigger?.type && def.trigger.type !== TRIGGER_TYPES.NONE ? 40 : 0;
  return bp + energy - ap + trigger;
}

function permanentBattlePower(state, permanent) {
  if (!permanent) return 0;
  return internals.battlePower(state, permanent);
}

function directDamageAmount(state, permanent) {
  if (!permanent) return 1;
  return internals.directDamageAmount(state, permanent);
}

function impactDamageAmount(state, attacker, defender) {
  if (!attacker || !defender) return 0;
  return internals.impactDamageAmount(state, attacker, defender);
}

function attackerPermanentForAction(state, playerId, action) {
  const player = state.players[playerId];
  const lineName = action.attackerLine ?? LINES.FRONT;
  return player?.[lineName]?.[action.attackerIndex];
}

function pendingAttackContext(state, defenderPlayerId) {
  const attack = state.pendingAttack;
  if (!attack || attack.defenderPlayer !== defenderPlayerId) return {};
  const attackerPlayer = state.players[attack.attackerPlayer];
  for (const lineName of [LINES.FRONT, LINES.ENERGY]) {
    const index = attackerPlayer[lineName].findIndex((permanent) => permanent.pid === attack.attackerPermanentId);
    if (index !== -1) {
      return {
        attack,
        attacker: attackerPlayer[lineName][index],
        attackerLine: lineName,
        attackerIndex: index
      };
    }
  }
  return { attack };
}

function permanentEnergyGeneration(state, permanent) {
  if (!permanent) return 0;
  const def = state.catalog[permanent.cards.at(-1).defId];
  return [...(def.energy ?? []), ...(permanent.energyModifiers ?? [])]
    .reduce((total, icon) => total + Number(icon.amount ?? 0), 0);
}

function sameText(left, right) {
  return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
}

function includesText(values = [], value) {
  return values.some((item) => sameText(item, value));
}
