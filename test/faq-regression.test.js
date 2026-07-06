import test from "node:test";
import assert from "node:assert/strict";
import {
  CARD_TYPES,
  LINES,
  TIMINGS,
  applyAction,
  createGame,
  encodeEgmanCardText,
  internals
} from "../src/index.js";
import { sampleCatalog, sampleDeckList } from "../data/sample-cards.js";

function mainPhaseGame(catalog = sampleCatalog) {
  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  return applyAction(game, { type: "advancePhase", player: "P1" });
}

test("FAQ regression: choose-two effects require distinct choices and resolve in printed order", () => {
  const catalog = {
    ...sampleCatalog,
    private_choose_two_event: {
      id: "private_choose_two_event",
      number: "FAQ-1-001",
      sourceCode: "FAQ",
      name: "Private Choose Two",
      type: CARD_TYPES.EVENT,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      affinities: [],
      eventEffect: {
        kind: "chooseN",
        min: 1,
        max: 2,
        defaultCount: 1,
        choiceKey: "effectChoices",
        choices: [
          { id: "choice-1", effect: { kind: "moveTopDeck", count: 1, destination: "hand" } },
          { id: "choice-2", effect: { kind: "readyAp", amount: 1 } },
          { id: "choice-3", effect: { kind: "moveTopDeck", count: 1, destination: "sideline" } }
        ]
      }
    }
  };

  let game = mainPhaseGame(catalog);
  game.players.P1.hand.unshift({ uid: "choose-two-ref", owner: "P1", defId: "private_choose_two_event", faceUp: true });
  game.players.P1.deck = [
    { uid: "faq-a", owner: "P1", defId: "demo_rookie", faceUp: true },
    { uid: "faq-b", owner: "P1", defId: "demo_stepper", faceUp: true }
  ];

  game = applyAction(game, {
    type: "playCard",
    player: "P1",
    handIndex: 0,
    choices: { effectChoices: [2, 0] }
  });

  assert.equal(game.players.P1.hand.at(-1).uid, "faq-a");
  assert.equal(game.players.P1.sideline.at(-2).uid, "faq-b");

  const duplicateGame = mainPhaseGame(catalog);
  duplicateGame.players.P1.hand.unshift({ uid: "choose-two-ref-2", owner: "P1", defId: "private_choose_two_event", faceUp: true });
  assert.throws(() => applyAction(duplicateGame, {
    type: "playCard",
    player: "P1",
    handIndex: 0,
    choices: { effectChoices: [0, 0] }
  }), /same effect branch cannot be chosen/i);
});

test("FAQ regression: removing a top Raid card leaves the base on field without firing played or sidelined abilities", () => {
  const catalog = {
    ...sampleCatalog,
    private_raid_top: {
      id: "private_raid_top",
      number: "FAQ-1-002",
      sourceCode: "FAQ",
      name: "Private Raid Top",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 1 },
      apCost: 1,
      bp: 4000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      abilities: [
        {
          id: "should-not-fire",
          timing: TIMINGS.WHEN_SIDELINED,
          effect: { kind: "draw", amount: 1 }
        }
      ]
    },
    private_pop_raid: {
      id: "private_pop_raid",
      number: "FAQ-1-003",
      sourceCode: "FAQ",
      name: "Private Pop Raid",
      type: CARD_TYPES.EVENT,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      affinities: [],
      eventEffect: {
        kind: "moveTopRaidCardToZone",
        destination: "sideline",
        target: { controller: "opponent", line: "field", max: 1 }
      }
    }
  };

  let game = mainPhaseGame(catalog);
  game.players.P1.hand.unshift({ uid: "pop-raid-event", owner: "P1", defId: "private_pop_raid", faceUp: true });
  game.players.P2.frontLine.push({
    pid: "faq-raid-stack",
    owner: "P2",
    controller: "P2",
    cards: [
      { uid: "faq-base", owner: "P2", defId: "demo_rookie", faceUp: true },
      { uid: "faq-raid", owner: "P2", defId: "private_raid_top", faceUp: true }
    ],
    rested: true,
    bpDelta: 1000,
    bpModifiers: [{ amount: 2000, expires: "endOfTurn" }],
    keywordModifiers: [{ keyword: "damage", value: 2, expires: "endOfTurn" }],
    energyModifiers: [{ color: "green", amount: 1, expires: "endOfTurn" }],
    readyLocks: 1,
    attacksThisTurn: 0,
    blocksThisTurn: 0,
    usedOncePerTurn: ["should-clear"]
  });

  const p2HandBefore = game.players.P2.hand.length;
  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0 });

  const remaining = game.players.P2.frontLine[0];
  assert.equal(remaining.cards.length, 1);
  assert.equal(remaining.cards[0].uid, "faq-base");
  assert.equal(remaining.rested, true);
  assert.equal(internals.battlePower(game, remaining), 1500);
  assert.deepEqual(remaining.keywordModifiers, []);
  assert.deepEqual(remaining.energyModifiers, []);
  assert.equal(remaining.readyLocks, 0);
  assert.deepEqual(remaining.usedOncePerTurn, []);
  assert.equal(game.players.P2.sideline.at(-1).uid, "faq-raid");
  assert.equal(game.players.P2.hand.length, p2HandBefore);
});

test("FAQ audit parser: official choose-two wording encodes to chooseN", () => {
  const encoded = encodeEgmanCardText({
    name: "Private FAQ Event",
    category: "Event",
    effect: "{Choose one} of the abilities listed below. If a named card is on your field, you may {Choose two} instead.\n- Draw two cards.\n- Choose up to one of your AP cards and switch it to active.",
    trigger: ""
  });

  assert.equal(encoded.fields.eventEffect.kind, "chooseN");
  assert.equal(encoded.fields.eventEffect.max, 2);
});

test("FAQ regression: repeated independent target instructions may choose same or different characters", () => {
  const encoded = encodeEgmanCardText({
    name: "Senbonzakura Kageyoshi",
    category: "Event",
    effect: "If <Byakuya Kuchiki> is on your field, reduce this card's AP cost by 1 while in your hand. Choose up to one character on your opponent's front line. It loses 3000 BP until the end of the turn. Choose up to one character on your opponent's front line. It loses 1000 BP until the end of the turn.",
    trigger: ""
  }).fields;
  const catalog = {
    ...sampleCatalog,
    byakuya: {
      id: "byakuya",
      number: "FAQ-1-014",
      sourceCode: "FAQ",
      name: "Byakuya Kuchiki",
      type: CARD_TYPES.CHARACTER,
      color: "purple",
      requiredEnergy: { color: "purple", amount: 0 },
      apCost: 0,
      bp: 2500,
      energy: [{ color: "purple", amount: 1 }],
      affinities: []
    },
    senbonzakura: {
      id: "senbonzakura",
      number: "FAQ-1-015",
      sourceCode: "FAQ",
      name: "Senbonzakura Kageyoshi",
      type: CARD_TYPES.EVENT,
      color: "purple",
      requiredEnergy: { color: "purple", amount: 0 },
      apCost: 1,
      affinities: [],
      useCostModifiers: encoded.useCostModifiers,
      eventEffect: encoded.eventEffect
    }
  };

  let game = mainPhaseGame(catalog);
  game.players.P1.frontLine.push({
    pid: "byakuya",
    owner: "P1",
    controller: "P1",
    cards: [{ uid: "byakuya-card", owner: "P1", defId: "byakuya", faceUp: true }],
    rested: false,
    bpDelta: 0,
    bpModifiers: [],
    keywordModifiers: [],
    energyModifiers: [],
    gainedAbilities: [],
    readyLocks: 0,
    attacksThisTurn: 0,
    blocksThisTurn: 0,
    usedOncePerTurn: []
  });
  game.players.P2.frontLine.push({
    pid: "target-a",
    owner: "P2",
    controller: "P2",
    cards: [{ uid: "target-a-card", owner: "P2", defId: "demo_guardian", faceUp: true }],
    rested: false,
    bpDelta: 0,
    bpModifiers: [],
    keywordModifiers: [],
    energyModifiers: [],
    gainedAbilities: [],
    readyLocks: 0,
    attacksThisTurn: 0,
    blocksThisTurn: 0,
    usedOncePerTurn: []
  }, {
    pid: "target-b",
    owner: "P2",
    controller: "P2",
    cards: [{ uid: "target-b-card", owner: "P2", defId: "demo_blocker", faceUp: true }],
    rested: false,
    bpDelta: 0,
    bpModifiers: [],
    keywordModifiers: [],
    energyModifiers: [],
    gainedAbilities: [],
    readyLocks: 0,
    attacksThisTurn: 0,
    blocksThisTurn: 0,
    usedOncePerTurn: []
  });
  game.players.P1.hand.unshift({ uid: "senbonzakura-card", owner: "P1", defId: "senbonzakura", faceUp: true });
  assert.equal(internals.apCostForCardUse(game, "P1", catalog.senbonzakura), 0);

  game = applyAction(game, {
    type: "playCard",
    player: "P1",
    handIndex: 0,
    choices: {
      bpLossTarget1: [{ player: "P2", lineName: LINES.FRONT, index: 0 }],
      bpLossTarget2: [{ player: "P2", lineName: LINES.FRONT, index: 1 }]
    }
  });
  assert.equal(internals.battlePower(game, game.players.P2.frontLine[0]), 0);
  assert.equal(internals.battlePower(game, game.players.P2.frontLine[1]), 1500);

  game = mainPhaseGame(catalog);
  game.players.P2.frontLine.push({
    pid: "target-c",
    owner: "P2",
    controller: "P2",
    cards: [{ uid: "target-c-card", owner: "P2", defId: "demo_guardian", faceUp: true }],
    rested: false,
    bpDelta: 0,
    bpModifiers: [],
    keywordModifiers: [],
    energyModifiers: [],
    gainedAbilities: [],
    readyLocks: 0,
    attacksThisTurn: 0,
    blocksThisTurn: 0,
    usedOncePerTurn: []
  });
  game.players.P1.hand.unshift({ uid: "senbonzakura-card-2", owner: "P1", defId: "senbonzakura", faceUp: true });
  game = applyAction(game, {
    type: "playCard",
    player: "P1",
    handIndex: 0,
    choices: {
      bpLossTarget1: [{ player: "P2", lineName: LINES.FRONT, index: 0 }],
      bpLossTarget2: [{ player: "P2", lineName: LINES.FRONT, index: 0 }]
    }
  });
  assert.equal(internals.battlePower(game, game.players.P2.frontLine[0]), -1000);
});

test("FAQ regression: field assist changes choose-one into two distinct choices", () => {
  const catalog = {
    ...sampleCatalog,
    choice_helper: {
      id: "choice_helper",
      number: "FAQ-1-016",
      sourceCode: "FAQ",
      name: "Choice Helper",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      choiceModeAssists: [{
        mode: "chooseN",
        max: 2,
        sourceType: CARD_TYPES.CHARACTER,
        during: "controllerTurn",
        cost: { restSelf: true, underCardsToSideline: 1 }
      }]
    },
    choose_source: {
      id: "choose_source",
      number: "FAQ-1-017",
      sourceCode: "FAQ",
      name: "Choose Source",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      abilities: [{
        id: "choose-main",
        timing: TIMINGS.ACTIVATE_MAIN,
        effect: {
          kind: "chooseOne",
          choices: [
            { id: "choice-1", effect: { kind: "moveTopDeck", count: 1, destination: "hand" } },
            { id: "choice-2", effect: { kind: "moveTopDeck", count: 1, destination: "sideline" } }
          ]
        }
      }]
    }
  };
  let game = mainPhaseGame(catalog);
  game.players.P1.frontLine = [{
    pid: "choose-source",
    owner: "P1",
    controller: "P1",
    cards: [{ uid: "choose-source-card", owner: "P1", defId: "choose_source", faceUp: true }],
    rested: false,
    bpDelta: 0,
    bpModifiers: [],
    keywordModifiers: [],
    energyModifiers: [],
    gainedAbilities: [],
    readyLocks: 0,
    attacksThisTurn: 0,
    blocksThisTurn: 0,
    usedOncePerTurn: []
  }, {
    pid: "choice-helper",
    owner: "P1",
    controller: "P1",
    cards: [
      { uid: "helper-under", owner: "P1", defId: "demo_rookie", faceUp: false },
      { uid: "helper-top", owner: "P1", defId: "choice_helper", faceUp: true }
    ],
    rested: false,
    bpDelta: 0,
    bpModifiers: [],
    keywordModifiers: [],
    energyModifiers: [],
    gainedAbilities: [],
    readyLocks: 0,
    attacksThisTurn: 0,
    blocksThisTurn: 0,
    usedOncePerTurn: []
  }];
  game.players.P1.deck = [
    { uid: "faq-order-a", owner: "P1", defId: "demo_rookie", faceUp: true },
    { uid: "faq-order-b", owner: "P1", defId: "demo_stepper", faceUp: true }
  ];

  game = applyAction(game, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: "choose-main",
    choices: { effectChoices: [1, 0] }
  });

  assert.equal(game.players.P1.frontLine[1].rested, true);
  assert.equal(game.players.P1.frontLine[1].cards.length, 1);
  assert.equal(game.players.P1.sideline.at(-2).uid, "helper-under");
  assert.equal(game.players.P1.hand.at(-1).uid, "faq-order-a");
  assert.equal(game.players.P1.sideline.at(-1).uid, "faq-order-b");

  const duplicateGame = mainPhaseGame(catalog);
  duplicateGame.players.P1.frontLine = structuredClone(game.players.P1.frontLine);
  duplicateGame.players.P1.frontLine[1].rested = false;
  duplicateGame.players.P1.frontLine[1].cards.unshift({ uid: "helper-under-2", owner: "P1", defId: "demo_rookie", faceUp: false });
  assert.throws(() => applyAction(duplicateGame, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: "choose-main",
    choices: { effectChoices: [0, 0] }
  }), /same effect branch cannot be chosen/i);
});

test("FAQ regression: optional cost choose-two upgrade requires distinct choices", () => {
  const encoded = encodeEgmanCardText({
    name: "Lelouch Lamperouge",
    category: "Character",
    effect: "[When Played] {Choose one} of the following. You may place one card with 2 AP cost from your hand into your sideline. If you do, {Choose two} instead. - Draw a card. - Choose up to one of your AP cards and switch it to active.",
    trigger: ""
  }).fields.abilities[0].effect;
  assert.equal(encoded.kind, "optionalChoiceUpgrade");

  const catalog = {
    ...sampleCatalog,
    ap2_cost: {
      id: "ap2_cost",
      number: "FAQ-1-018",
      sourceCode: "FAQ",
      name: "AP2 Cost",
      type: CARD_TYPES.CHARACTER,
      color: "purple",
      requiredEnergy: { color: "purple", amount: 0 },
      apCost: 2,
      bp: 1000,
      energy: [{ color: "purple", amount: 1 }],
      affinities: []
    },
    optional_upgrade_source: {
      id: "optional_upgrade_source",
      number: "FAQ-1-019",
      sourceCode: "FAQ",
      name: "Optional Upgrade Source",
      type: CARD_TYPES.CHARACTER,
      color: "purple",
      requiredEnergy: { color: "purple", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "purple", amount: 1 }],
      affinities: [],
      abilities: [{ id: "when-played-upgrade", timing: TIMINGS.WHEN_PLAYED, effect: encoded }]
    }
  };
  let game = mainPhaseGame(catalog);
  game.players.P1.hand.unshift(
    { uid: "upgrade-source-card", owner: "P1", defId: "optional_upgrade_source", faceUp: true },
    { uid: "ap2-cost-card", owner: "P1", defId: "ap2_cost", faceUp: true }
  );
  const handBefore = game.players.P1.hand.length;

  game = applyAction(game, {
    type: "playCard",
    player: "P1",
    handIndex: 0,
    destination: LINES.FRONT,
    choices: { effectChoices: [1, 0] }
  });

  assert.equal(game.players.P1.sideline.at(-1).uid, "ap2-cost-card");
  assert.equal(game.players.P1.hand.length, handBefore - 1);

  const duplicateGame = mainPhaseGame(catalog);
  duplicateGame.players.P1.hand.unshift(
    { uid: "upgrade-source-card-2", owner: "P1", defId: "optional_upgrade_source", faceUp: true },
    { uid: "ap2-cost-card-2", owner: "P1", defId: "ap2_cost", faceUp: true }
  );
  assert.throws(() => applyAction(duplicateGame, {
    type: "playCard",
    player: "P1",
    handIndex: 0,
    destination: LINES.FRONT,
    choices: { effectChoices: [0, 0] }
  }), /same effect branch cannot be chosen/i);
});

test("FAQ regression: color-trigger replacement happens once even with multiple copies", () => {
  const catalog = {
    ...sampleCatalog,
    green_color_life: {
      id: "green_color_life",
      number: "FAQ-1-020",
      sourceCode: "FAQ",
      name: "Green Color Life",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      trigger: {
        type: "color",
        effect: { kind: "modifyBp", amount: 3000, duration: "turn", target: { controller: "self", line: "field", max: 1 } }
      }
    },
    nano_replacer: {
      id: "nano_replacer",
      number: "FAQ-1-021",
      sourceCode: "FAQ",
      name: "Nano Replacer",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      triggerReplacements: [{
        triggerType: "color",
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
              rested: false,
              destinationLine: LINES.FRONT,
              filter: { type: CARD_TYPES.CHARACTER, requiredEnergyFulfilled: true, apCost: 1 }
            }
          ]
        }
      }]
    },
    replacement_play: {
      id: "replacement_play",
      number: "FAQ-1-022",
      sourceCode: "FAQ",
      name: "Replacement Play",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 1,
      bp: 1500,
      energy: [{ color: "green", amount: 1 }],
      affinities: []
    }
  };
  const game = mainPhaseGame(catalog);
  game.activePlayer = "P2";
  game.players.P1.frontLine = [0, 1].map((index) => ({
    pid: `nano-${index}`,
    owner: "P1",
    controller: "P1",
    cards: [{ uid: `nano-card-${index}`, owner: "P1", defId: "nano_replacer", faceUp: true }],
    rested: false,
    bpDelta: 0,
    bpModifiers: [],
    keywordModifiers: [],
    energyModifiers: [],
    gainedAbilities: [],
    readyLocks: 0,
    attacksThisTurn: 0,
    blocksThisTurn: 0,
    usedOncePerTurn: []
  }));
  game.players.P1.life = [{ uid: "green-trigger-life", owner: "P1", defId: "green_color_life", faceUp: false }];
  game.players.P1.deck = [{ uid: "replacement-draw", owner: "P1", defId: "demo_rookie", faceUp: true }];
  game.players.P1.hand = [
    { uid: "replacement-play-a", owner: "P1", defId: "replacement_play", faceUp: true },
    { uid: "replacement-play-b", owner: "P1", defId: "replacement_play", faceUp: true }
  ];

  internals.dealDamage(game, "P1", 1, { sourcePlayer: "P2", lifeIndices: [0], triggerChoices: [true] });

  assert.equal(game.players.P1.frontLine.length, 3);
  assert.equal(game.players.P1.frontLine[2].cards[0].uid, "replacement-play-a");
  assert.equal(game.players.P1.hand.some((card) => card.uid === "replacement-play-b"), true);
  assert.equal(game.players.P1.hand.some((card) => card.uid === "replacement-draw"), true);
  assert.equal(internals.battlePower(game, game.players.P1.frontLine[0]), 1000);
});

test("FAQ regression: normal color triggers play Raid cards normally instead of performing Raid", () => {
  const catalog = {
    ...sampleCatalog,
    normal_color_trigger: {
      id: "normal_color_trigger",
      number: "FAQ-1-023",
      sourceCode: "FAQ",
      name: "Normal Color Trigger",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      trigger: {
        type: "color",
        effect: {
          kind: "playCardFromZone",
          zones: ["hand"],
          rested: false,
          destinationLine: LINES.FRONT,
          filter: { type: CARD_TYPES.CHARACTER, color: "green", requiredEnergyMax: 3, apCost: 1 }
        }
      }
    },
    color_raid_base: {
      id: "color_raid_base",
      number: "FAQ-1-024",
      sourceCode: "FAQ",
      name: "Color Raid Base",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: []
    },
    color_raid_card: {
      id: "color_raid_card",
      number: "FAQ-1-025",
      sourceCode: "FAQ",
      name: "Color Raid Card",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 3 },
      apCost: 1,
      bp: 4000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      raid: { names: ["Color Raid Base"], affinities: [] }
    }
  };
  const game = mainPhaseGame(catalog);
  game.activePlayer = "P2";
  game.players.P1.frontLine = [{
    pid: "color-raid-base",
    owner: "P1",
    controller: "P1",
    cards: [{ uid: "color-raid-base-card", owner: "P1", defId: "color_raid_base", faceUp: true }],
    rested: true,
    bpDelta: 0,
    bpModifiers: [],
    keywordModifiers: [],
    energyModifiers: [],
    gainedAbilities: [],
    readyLocks: 0,
    attacksThisTurn: 0,
    blocksThisTurn: 0,
    usedOncePerTurn: []
  }];
  game.players.P1.life = [{ uid: "normal-color-life", owner: "P1", defId: "normal_color_trigger", faceUp: false }];
  game.players.P1.hand = [{ uid: "color-raid-card", owner: "P1", defId: "color_raid_card", faceUp: true }];

  internals.dealDamage(game, "P1", 1, { sourcePlayer: "P2", lifeIndices: [0], triggerChoices: [true] });

  assert.equal(game.players.P1.frontLine.length, 2);
  assert.equal(game.players.P1.frontLine[0].cards.length, 1);
  assert.equal(game.players.P1.frontLine[0].rested, true);
  assert.equal(game.players.P1.frontLine[1].cards.length, 1);
  assert.equal(game.players.P1.frontLine[1].cards[0].uid, "color-raid-card");
  assert.equal(game.players.P1.frontLine[1].rested, false);
});

test("FAQ regression: shared once-per-turn attack restriction applies only to the first attacking copy", () => {
  const catalog = {
    ...sampleCatalog,
    private_restrict_attacker: {
      id: "private_restrict_attacker",
      number: "FAQ-1-004",
      sourceCode: "FAQ",
      name: "Private Restrict Attacker",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 1 },
      apCost: 1,
      bp: 2500,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      abilities: [
        {
          id: "shared-restriction",
          timing: TIMINGS.WHEN_ATTACKING,
          oncePerTurnKey: "Private Restrict Attacker:shared-ability",
          effect: {
            kind: "grantKeyword",
            keyword: "cantBeBlockedByRequiredEnergyMin",
            value: 4,
            duration: "attack",
            target: "self"
          }
        }
      ]
    },
    private_big_blocker: {
      id: "private_big_blocker",
      number: "FAQ-1-005",
      sourceCode: "FAQ",
      name: "Private Big Blocker",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 4 },
      apCost: 1,
      bp: 5000,
      energy: [{ color: "green", amount: 1 }],
      affinities: []
    }
  };

  let game = mainPhaseGame(catalog);
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game.players.P1.frontLine = [0, 1].map((index) => ({
    pid: `restrict-attacker-${index}`,
    owner: "P1",
    controller: "P1",
    cards: [{ uid: `restrict-card-${index}`, owner: "P1", defId: "private_restrict_attacker", faceUp: true }],
    rested: false,
    bpDelta: 0,
    bpModifiers: [],
    keywordModifiers: [],
    energyModifiers: [],
    readyLocks: 0,
    attacksThisTurn: 0,
    blocksThisTurn: 0,
    usedOncePerTurn: []
  }));
  game.players.P2.frontLine = [{
    pid: "big-blocker",
    owner: "P2",
    controller: "P2",
    cards: [{ uid: "big-blocker-card", owner: "P2", defId: "private_big_blocker", faceUp: true }],
    rested: false,
    bpDelta: 0,
    bpModifiers: [],
    keywordModifiers: [],
    energyModifiers: [],
    readyLocks: 0,
    attacksThisTurn: 0,
    blocksThisTurn: 0,
    usedOncePerTurn: []
  }];

  game = applyAction(game, { type: "declareAttack", player: "P1", attackerIndex: 0, target: { type: "player" } });
  assert.throws(() => applyAction(game, { type: "declareBlock", player: "P2", blockerIndex: 0 }), /not allowed to block/i);
  game = applyAction(game, { type: "declineBlock", player: "P2", lifeIndices: [0] });

  game = applyAction(game, { type: "declareAttack", player: "P1", attackerIndex: 1, target: { type: "player" } });
  game = applyAction(game, { type: "declareBlock", player: "P2", blockerIndex: 0 });

  assert.equal(game.pendingAttack, null);
  assert.equal(game.players.P2.frontLine.length, 1);
});

test("EVA-1-033 style play effect cannot play Raid characters from hand", () => {
  const catalog = {
    ...sampleCatalog,
    private_spear: {
      id: "private_spear",
      number: "FAQ-1-006",
      sourceCode: "FAQ",
      name: "Private Spear",
      type: CARD_TYPES.CHARACTER,
      color: "purple",
      requiredEnergy: { color: "purple", amount: 0 },
      apCost: 0,
      bp: 5000,
      energy: [{ color: "purple", amount: 1 }],
      affinities: [],
      abilities: [
        {
          id: "when-played-play-non-raid",
          timing: TIMINGS.WHEN_PLAYED,
          effect: {
            kind: "playCardFromZone",
            zone: "hand",
            rested: false,
            filter: { type: CARD_TYPES.CHARACTER, color: "purple", apCost: 1, withoutRaid: true }
          }
        }
      ]
    },
    private_raid_option: {
      id: "private_raid_option",
      number: "FAQ-1-007",
      sourceCode: "FAQ",
      name: "Private Raid Option",
      type: CARD_TYPES.CHARACTER,
      color: "purple",
      requiredEnergy: { color: "purple", amount: 0 },
      apCost: 1,
      bp: 4000,
      energy: [{ color: "purple", amount: 1 }],
      affinities: [],
      raid: { names: ["Private Base"], affinities: [] }
    },
    private_non_raid_option: {
      id: "private_non_raid_option",
      number: "FAQ-1-008",
      sourceCode: "FAQ",
      name: "Private Non-Raid Option",
      type: CARD_TYPES.CHARACTER,
      color: "purple",
      requiredEnergy: { color: "purple", amount: 0 },
      apCost: 1,
      bp: 3000,
      energy: [{ color: "purple", amount: 1 }],
      affinities: []
    }
  };

  let game = mainPhaseGame(catalog);
  game.players.P1.hand.unshift(
    { uid: "private-spear", owner: "P1", defId: "private_spear", faceUp: true },
    { uid: "private-raid-option", owner: "P1", defId: "private_raid_option", faceUp: true }
  );

  assert.throws(() => applyAction(game, {
    type: "playCard",
    player: "P1",
    handIndex: 0,
    destination: LINES.FRONT,
    choices: { handIndex: 0 }
  }), /does not match effect filter/i);

  game.players.P1.hand[1] = { uid: "private-non-raid-option", owner: "P1", defId: "private_non_raid_option", faceUp: true };
  game = applyAction(game, {
    type: "playCard",
    player: "P1",
    handIndex: 0,
    destination: LINES.FRONT,
    choices: { handIndex: 0 }
  });

  assert.equal(game.players.P1.frontLine.length, 2);
  assert.equal(game.players.P1.frontLine[1].cards[0].defId, "private_non_raid_option");
  assert.equal(game.players.P1.frontLine[1].rested, false);
});

test("EVA-1-033 style text encodes draw-before-play and Activate Main timing choice", () => {
  const encoded = encodeEgmanCardText({
    name: "Private Spear",
    category: "Character",
    effect: "[When Played] Draw a card, then play up to one purple character card with 1 AP cost and without [Raid] from your hand set to active onto your field. [Activate: Main] [If on the Front Line] [Once Per Turn] Sideline one other character on your front line. If you do, activate this character's [When Played] ability.",
    trigger: ""
  }).fields;

  const whenPlayed = encoded.abilities.find((ability) => ability.timing === TIMINGS.WHEN_PLAYED);
  const activateMain = encoded.abilities.find((ability) => ability.timing === TIMINGS.ACTIVATE_MAIN);

  assert.equal(whenPlayed.effect.effects[0].kind, "draw");
  assert.equal(whenPlayed.effect.effects[1].kind, "playCardFromZone");
  assert.equal(whenPlayed.effect.effects[1].filter.withoutRaid, true);
  assert.equal(activateMain.conditions.line, LINES.FRONT);
  assert.equal(activateMain.effect.kind, "sidelineTargetsThenActivateSourceWhenPlayed");
});


test("FAQ regression: EVA-1-033 style Activate Main lets controller order source When Played and target When Sidelined", () => {
  const catalog = {
    ...sampleCatalog,
    high_a: {
      id: "high_a",
      number: "FAQ-1-009",
      sourceCode: "FAQ",
      name: "High A",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 5 },
      apCost: 1,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: []
    },
    high_b: {
      id: "high_b",
      number: "FAQ-1-010",
      sourceCode: "FAQ",
      name: "High B",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 6 },
      apCost: 1,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: []
    },
    low_a: {
      id: "low_a",
      number: "FAQ-1-011",
      sourceCode: "FAQ",
      name: "Low A",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 1 },
      apCost: 1,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: []
    },
    private_source_033: {
      id: "private_source_033",
      number: "FAQ-1-012",
      sourceCode: "FAQ",
      name: "Private Source 033",
      type: CARD_TYPES.CHARACTER,
      color: "purple",
      requiredEnergy: { color: "purple", amount: 0 },
      apCost: 0,
      bp: 5000,
      energy: [{ color: "purple", amount: 1 }],
      affinities: [],
      abilities: [
        {
          id: "when-played-draw",
          timing: TIMINGS.WHEN_PLAYED,
          effect: { kind: "draw", amount: 1 }
        },
        {
          id: "activate-main-order",
          timing: TIMINGS.ACTIVATE_MAIN,
          effect: {
            kind: "sidelineTargetsThenActivateSourceWhenPlayed",
            target: {
              controller: "self",
              line: LINES.FRONT,
              type: CARD_TYPES.CHARACTER,
              max: 1,
              otherThanSource: true,
              choiceKey: "sidelineTarget"
            }
          }
        }
      ]
    },
    private_target_053: {
      id: "private_target_053",
      number: "FAQ-1-013",
      sourceCode: "FAQ",
      name: "Private Target 053",
      type: CARD_TYPES.CHARACTER,
      color: "purple",
      requiredEnergy: { color: "purple", amount: 0 },
      apCost: 0,
      bp: 4000,
      energy: [{ color: "purple", amount: 1 }],
      affinities: [],
      abilities: [
        {
          id: "when-sidelined-search",
          timing: TIMINGS.WHEN_SIDELINED,
          effect: {
            kind: "searchTopDeck",
            count: 5,
            max: 2,
            filter: { requiredEnergyMin: 5 }
          }
        }
      ]
    }
  };

  const makeGameWithField = () => {
    const game = mainPhaseGame(catalog);
    game.players.P1.frontLine = [
      {
        pid: "source-033",
        owner: "P1",
        controller: "P1",
        cards: [{ uid: "source-033-card", owner: "P1", defId: "private_source_033", faceUp: true }],
        rested: false,
        bpDelta: 0,
        bpModifiers: [],
        keywordModifiers: [],
        energyModifiers: [],
        readyLocks: 0,
        attacksThisTurn: 0,
        blocksThisTurn: 0,
        usedOncePerTurn: []
      },
      {
        pid: "target-053",
        owner: "P1",
        controller: "P1",
        cards: [{ uid: "target-053-card", owner: "P1", defId: "private_target_053", faceUp: true }],
        rested: false,
        bpDelta: 0,
        bpModifiers: [],
        keywordModifiers: [],
        energyModifiers: [],
        readyLocks: 0,
        attacksThisTurn: 0,
        blocksThisTurn: 0,
        usedOncePerTurn: []
      }
    ];
    game.players.P1.deck = [
      { uid: "high-a", owner: "P1", defId: "high_a", faceUp: true },
      { uid: "low-a", owner: "P1", defId: "low_a", faceUp: true },
      { uid: "high-b", owner: "P1", defId: "high_b", faceUp: true }
    ];
    game.players.P1.hand = [];
    return game;
  };

  let game = makeGameWithField();
  game = applyAction(game, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: "activate-main-order",
    choices: {
      sidelineTarget: [{ player: "P1", lineName: LINES.FRONT, index: 1 }],
      simultaneousAbilityOrder: ["whenPlayed", "whenSidelined"]
    }
  });
  assert.deepEqual(game.players.P1.hand.map((card) => card.defId), ["high_a", "high_b"]);

  game = makeGameWithField();
  game = applyAction(game, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: "activate-main-order",
    choices: {
      sidelineTarget: [{ player: "P1", lineName: LINES.FRONT, index: 1 }],
      simultaneousAbilityOrder: ["whenSidelined", "whenPlayed"]
    }
  });
  assert.deepEqual(game.players.P1.hand.map((card) => card.defId), ["high_a", "high_b", "low_a"]);
});
