import test from "node:test";
import assert from "node:assert/strict";
import {
  CARD_TYPES,
  LINES,
  applyAction,
  createGame,
  encodeEgmanCardText,
  internals,
  legalActions
} from "../src/index.js";
import { sampleCatalog, sampleDeckList } from "../data/sample-cards.js";

function idFor(code) {
  return code.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function rlyDefinition(code, name, {
  type = CARD_TYPES.CHARACTER,
  color = "green",
  requiredEnergy = 0,
  apCost = 0,
  bp = 3000,
  affinities = []
} = {}) {
  const fields = encodeEgmanCardText({
    card_code: code,
    name,
    category: type === CARD_TYPES.EVENT ? "Event" : type === CARD_TYPES.SITE ? "Site" : "Character",
    effect: "-",
    trigger: ""
  }).fields;
  const definition = {
    id: idFor(code),
    number: code,
    sourceCode: "RLY",
    name,
    type,
    color,
    requiredEnergy: { color, amount: requiredEnergy },
    apCost,
    bp: type === CARD_TYPES.CHARACTER ? bp : undefined,
    energy: type === CARD_TYPES.EVENT ? [] : [{ color, amount: 1 }],
    affinities,
    keywords: {},
    abilities: [],
    staticModifiers: [],
    staticFieldModifiers: [],
    staticEnergyModifiers: [],
    staticKeywordModifiers: [],
    staticFieldKeywordModifiers: [],
    useCostModifiers: [],
    staticUseCostModifiers: [],
    choiceModeAssists: [],
    triggerReplacements: [],
    ...fields
  };
  if (fields.triggerEffect) definition.trigger = fields.triggerEffect;
  delete definition.triggerEffect;
  delete definition.replaceParsedKeywords;
  return definition;
}

function card(uid, owner, defId) {
  return { uid, owner, defId, faceUp: true };
}

function permanent(pid, owner, defId, { rested = false } = {}) {
  return {
    pid,
    owner,
    controller: owner,
    cards: [card(`${pid}-card`, owner, defId)],
    rested,
    bpDelta: 0,
    bpModifiers: [],
    keywordModifiers: [],
    energyModifiers: [],
    gainedAbilities: [],
    readyLocks: 0,
    playedThisTurn: false,
    attacksThisTurn: 0,
    blocksThisTurn: 0,
    usedOncePerTurn: []
  };
}

function makeGame(extraCatalog = {}) {
  return createGame({
    catalog: { ...sampleCatalog, ...extraCatalog },
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
}

function mainPhase(game, playerId = "P1") {
  let next = applyAction(game, { type: "advancePhase", player: playerId });
  next = applyAction(next, { type: "advancePhase", player: playerId });
  return next;
}

function eventAction(game, choices = {}) {
  return {
    type: "playCard",
    player: "P1",
    handIndex: 0,
    choices
  };
}

test("RLY exact definitions preserve the set's complex printed behavior", () => {
  const get = (code, name = "RLY Card", type = CARD_TYPES.CHARACTER) => rlyDefinition(code, name, { type });

  const rentaro = get("RLY-1-001", "Rentaro Aijo");
  assert.deepEqual(rentaro.abilities[0].effect.effects[0].filter, {
    type: CARD_TYPES.CHARACTER,
    otherThanName: "Rentaro Aijo"
  });
  assert.equal(rentaro.abilities[0].effect.effects[1].condition.lastSearchSelectedMin, 1);

  const rentaroFinisher = get("RLY-1-002", "Rentaro Aijo");
  assert.deepEqual(rentaroFinisher.keywords, {});
  assert.equal(rentaroFinisher.staticModifiers[0].condition.allOf[1].uniqueFieldNameCountMin, 3);
  assert.deepEqual(rentaroFinisher.staticKeywordModifiers.map((modifier) => modifier.keyword), ["impact", "damage"]);

  const karaneRaid = get("RLY-1-009", "Karane Inda");
  assert.equal(karaneRaid.abilities[0].effect.effect.effects[1].effect.kind, "opponentMayDraw");
  assert.equal(karaneRaid.abilities[0].effect.effect.effects[1].effect.amountIf.amount, 2);

  const shizukaEnergy = get("RLY-1-016", "Shizuka Yoshimoto");
  assert.deepEqual(shizukaEnergy.abilities[0].effect.effects.map((effect) => effect.kind), [
    "grantEnergy",
    "scheduleSidelineSelfAtEndOfMain"
  ]);

  const prediction = get("RLY-1-038", "Prediction", CARD_TYPES.EVENT);
  assert.equal(prediction.eventEffect.kind, "predictTopDeckRequiredEnergy");

  const conditionalChoice = get("RLY-1-037", "Conditional Choice", CARD_TYPES.EVENT);
  assert.equal(conditionalChoice.eventEffect.max, 1);
  assert.equal(conditionalChoice.eventEffect.maxIf.value, 2);

  const handLock = get("RLY-1-066", "Shizuka Yoshimoto");
  assert.equal(handLock.abilities[0].effect.effect.upgradedEffect.effects[1].kind, "restrictCardUse");

  const unblockable = get("RLY-1-067", "Shizuka Yoshimoto");
  assert.equal(unblockable.keywords.cantBeBlockedByRequiredEnergyMin, 4);

  const upgradedSearch = get("RLY-1-075", "Pi", CARD_TYPES.EVENT);
  assert.equal(upgradedSearch.eventEffect.effect.count, 9);
  assert.equal(upgradedSearch.eventEffect.effect.max, 2);
  assert.equal(upgradedSearch.eventEffect.elseEffect.count, 4);

  const teamBuff = get("RLY-1-078", "Circlet Love Story", CARD_TYPES.EVENT);
  assert.equal(teamBuff.eventEffect.effects[0].target.all, true);
  assert.equal(teamBuff.eventEffect.effects[1].keyword, "impactPlus");

  const magnet = get("RLY-1-079", "Human Magnet Medicine", CARD_TYPES.EVENT);
  assert.equal(magnet.eventEffect.effects[1].filter.differentNameFromChoiceKey, "rly079Target");

  const scalingRemoval = get("RLY-1-081", "She Gave a Hearty Laugh", CARD_TYPES.EVENT);
  assert.equal(scalingRemoval.eventEffect.target.bpMaxBonuses[0].amountPerFieldMatch, 1000);
});

test("RLY delayed energy generators remain in play until the main phase ends", () => {
  const source = rlyDefinition("RLY-1-016", "Shizuka Yoshimoto", { requiredEnergy: 0, bp: 1000 });
  let game = mainPhase(makeGame({ [source.id]: source }));
  game.players.P1.energyLine = [permanent("rly016", "P1", source.id)];

  game = applyAction(game, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.ENERGY,
    index: 0,
    abilityId: "activateMain-1"
  });

  assert.equal(game.players.P1.energyLine.length, 1);
  assert.equal(game.players.P1.energyLine[0].energyModifiers[0].amount, 1);
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  assert.equal(game.players.P1.energyLine.length, 0);
  assert.equal(game.players.P1.sideline.some((item) => item.defId === source.id), true);
});

test("RLY Karane compensates the opponent based on the sidelined character's BP", () => {
  const karane = rlyDefinition("RLY-1-009", "Karane Inda", { requiredEnergy: 0, bp: 4000 });
  const target = {
    ...sampleCatalog.demo_guardian,
    id: "rly-draw-target",
    number: "TST-1-901",
    name: "Large Target",
    bp: 3500
  };
  let game = mainPhase(makeGame({ [karane.id]: karane, [target.id]: target }));
  game.players.P1.hand = [card("karane-hand", "P1", karane.id)];
  game.players.P2.frontLine = [permanent("large-target", "P2", target.id)];
  game.players.P2.hand = [];
  game.players.P2.deck = [
    card("draw-1", "P2", "demo_rookie"),
    card("draw-2", "P2", "demo_stepper"),
    card("draw-3", "P2", "demo_guardian")
  ];

  game = applyAction(game, {
    type: "playCard",
    player: "P1",
    handIndex: 0,
    destination: LINES.FRONT,
    choices: {
      rly009Sideline: true,
      rly009Target: [{ player: "P2", lineName: LINES.FRONT, index: 0 }],
      rly009OpponentDraw: 2
    }
  });

  assert.equal(game.players.P2.frontLine.length, 0);
  assert.equal(game.players.P2.hand.length, 2);
});

test("RLY prediction reveals and draws before applying the successful payoff", () => {
  const prediction = rlyDefinition("RLY-1-038", "Prediction", { type: CARD_TYPES.EVENT });
  const costTwo = {
    ...sampleCatalog.demo_guardian,
    id: "rly-cost-two",
    number: "TST-1-902",
    name: "Cost Two",
    requiredEnergy: { color: "green", amount: 2 }
  };
  let game = mainPhase(makeGame({ [prediction.id]: prediction, [costTwo.id]: costTwo }));
  game.players.P1.hand = [card("prediction", "P1", prediction.id)];
  game.players.P1.deck = [card("cost-two", "P1", costTwo.id)];
  game.players.P1.frontLine = [permanent("prediction-target", "P1", "demo_guardian", { rested: true })];
  game.players.P1.apCards[0].rested = true;

  game = applyAction(game, eventAction(game, {
    rly038Prediction: 2,
    rly038Character: [{ player: "P1", lineName: LINES.FRONT, index: 0 }]
  }));

  assert.equal(game.players.P1.hand.some((item) => item.defId === costTwo.id), true);
  assert.equal(game.players.P1.frontLine[0].rested, false);
  assert.equal(internals.battlePower(game, game.players.P1.frontLine[0]), 4000);
  assert.equal(game.players.P1.apCards[0].rested, false);
  assert.equal(game.publicKnowledge.P2.players.P1.revealedCards.some((item) => item.defId === costTwo.id), true);
});

test("RLY Shizuka's catch-up draw prevents further hand card use that turn", () => {
  const shizuka = rlyDefinition("RLY-1-066", "Shizuka Yoshimoto", { requiredEnergy: 0, bp: 2500 });
  let game = mainPhase(makeGame({ [shizuka.id]: shizuka }));
  game.players.P1.hand = [
    card("shizuka", "P1", shizuka.id),
    card("spare", "P1", "demo_rookie")
  ];
  game.players.P1.deck = [
    card("catch-up-1", "P1", "demo_rookie"),
    card("catch-up-2", "P1", "demo_stepper"),
    card("catch-up-3", "P1", "demo_guardian")
  ];
  game.players.P2.hand = [
    card("opponent-1", "P2", "demo_rookie"),
    card("opponent-2", "P2", "demo_rookie"),
    card("opponent-3", "P2", "demo_rookie"),
    card("opponent-4", "P2", "demo_rookie")
  ];

  game = applyAction(game, {
    type: "playCard",
    player: "P1",
    handIndex: 0,
    destination: LINES.FRONT,
    choices: { rly066PayAp: true }
  });

  assert.equal(game.players.P1.hand.length, 4);
  assert.equal(game.turnFlags.P1.restrictedCardUseSourceZones.includes("hand"), true);
  assert.equal(legalActions(game, "P1").some((action) => action.type === "playCard" || action.type === "performRaid"), false);
});

test("RLY Circlet Love Story buffs every eligible character and grants Impact plus separately", () => {
  const event = rlyDefinition("RLY-1-078", "Circlet Love Story", { type: CARD_TYPES.EVENT });
  const shizuka = {
    ...sampleCatalog.demo_guardian,
    id: "rly-shizuka-low",
    number: "TST-1-903",
    name: "Shizuka Yoshimoto",
    requiredEnergy: { color: "green", amount: 3 },
    bp: 3000,
    keywords: {}
  };
  const highCost = {
    ...sampleCatalog.demo_finisher,
    id: "rly-high-cost",
    number: "TST-1-904",
    name: "High Cost",
    requiredEnergy: { color: "green", amount: 4 },
    bp: 4000,
    keywords: {}
  };
  let game = mainPhase(makeGame({ [event.id]: event, [shizuka.id]: shizuka, [highCost.id]: highCost }));
  game.players.P1.hand = [card("circlet", "P1", event.id)];
  game.players.P1.frontLine = [
    permanent("shizuka", "P1", shizuka.id),
    permanent("rookie", "P1", "demo_rookie"),
    permanent("high", "P1", highCost.id)
  ];

  game = applyAction(game, eventAction(game, {
    rly078Target: [{ player: "P1", lineName: LINES.FRONT, index: 0 }]
  }));

  assert.equal(internals.battlePower(game, game.players.P1.frontLine[0]), 4500);
  assert.equal(internals.battlePower(game, game.players.P1.frontLine[1]), 3000);
  assert.equal(internals.battlePower(game, game.players.P1.frontLine[2]), 4000);
  assert.equal(internals.keywordValue(game, game.players.P1.frontLine[0], "impactPlus", 0), 1);
});

test("RLY Human Magnet Medicine cannot retrieve the chosen character's name", () => {
  const event = rlyDefinition("RLY-1-079", "Human Magnet Medicine", { type: CARD_TYPES.EVENT });
  let game = mainPhase(makeGame({ [event.id]: event }));
  game.players.P1.hand = [card("magnet", "P1", event.id)];
  game.players.P1.frontLine = [permanent("chosen", "P1", "demo_rookie")];
  game.players.P1.sideline = [
    card("same-name", "P1", "demo_rookie"),
    card("different-name", "P1", "demo_guardian")
  ];
  const choices = {
    rly079Target: [{ player: "P1", lineName: LINES.FRONT, index: 0 }]
  };

  assert.throws(() => applyAction(game, eventAction(game, { ...choices, rly079SidelineIndex: 0 })), /does not match effect filter/i);

  game = applyAction(game, eventAction(game, { ...choices, rly079SidelineIndex: 1 }));
  assert.equal(game.players.P1.hand.some((item) => item.uid === "different-name"), true);
  assert.equal(internals.battlePower(game, game.players.P1.frontLine[0]), 2500);
});

test("RLY scaling removal counts low-cost front-line characters only when Shizuka is present", () => {
  const event = rlyDefinition("RLY-1-081", "She Gave a Hearty Laugh", { type: CARD_TYPES.EVENT });
  const shizuka = {
    ...sampleCatalog.demo_rookie,
    id: "rly-shizuka-scaling",
    number: "TST-1-905",
    name: "Shizuka Yoshimoto",
    requiredEnergy: { color: "green", amount: 2 }
  };
  const target = {
    ...sampleCatalog.demo_finisher,
    id: "rly-five-thousand",
    number: "TST-1-906",
    name: "Five Thousand Target",
    bp: 5000
  };
  let game = mainPhase(makeGame({ [event.id]: event, [shizuka.id]: shizuka, [target.id]: target }));
  game.players.P1.hand = [card("laugh", "P1", event.id)];
  game.players.P1.frontLine = [
    permanent("scaling-shizuka", "P1", shizuka.id),
    permanent("scaling-rookie", "P1", "demo_rookie")
  ];
  game.players.P2.frontLine = [permanent("five-thousand", "P2", target.id)];

  game = applyAction(game, eventAction(game, {
    rly081Target: [{ player: "P2", lineName: LINES.FRONT, index: 0 }]
  }));
  assert.equal(game.players.P2.frontLine.length, 0);
});

test("RLY Pink Four-Leaf Clover enforces unique selected character names", () => {
  const event = rlyDefinition("RLY-1-040", "Pink Four-Leaf Clover", { type: CARD_TYPES.EVENT });
  const karaneA = {
    ...sampleCatalog.demo_rookie,
    id: "rly-karane-a",
    number: "TST-1-907",
    name: "Karane Inda"
  };
  const karaneB = { ...karaneA, id: "rly-karane-b", number: "TST-1-908" };
  let game = mainPhase(makeGame({ [event.id]: event, [karaneA.id]: karaneA, [karaneB.id]: karaneB }));
  game.players.P1.hand = [card("clover", "P1", event.id)];
  game.players.P1.deck = [
    card("karane-a", "P1", karaneA.id),
    card("karane-b", "P1", karaneB.id)
  ];

  assert.throws(() => applyAction(game, eventAction(game, { searchIndices: [0, 1] })), /unique card names/i);
});
