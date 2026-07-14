import test from "node:test";
import assert from "node:assert/strict";
import {
  CARD_TYPES,
  LINES,
  PHASES,
  TIMINGS,
  applyAction,
  createGame,
  encodeEgmanCardText,
  internals,
  legalActions
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

function faqPermanent(pid, owner, defId, rested = false) {
  return {
    pid,
    owner,
    controller: owner,
    cards: [{ uid: `${pid}-card`, owner, defId, faceUp: true }],
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
  assert.equal(game.players.P2.sideline.some((item) => item.uid === "target-a-card"), true);
  assert.equal(internals.battlePower(game, game.players.P2.frontLine[0]), 1500);

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
  assert.equal(game.players.P2.frontLine.length, 0);
  assert.equal(game.players.P2.sideline.some((item) => item.uid === "target-c-card"), true);
});

test("FAQ regression: BP state checks wait for a complete ability and then sideline zero-BP characters", () => {
  const catalog = {
    ...sampleCatalog,
    state_check_target: {
      ...sampleCatalog.demo_rookie,
      id: "state_check_target",
      number: "FAQ-1-060",
      name: "State Check Target",
      bp: 1000
    },
    state_check_event: {
      id: "state_check_event",
      number: "FAQ-1-061",
      sourceCode: "FAQ",
      name: "State Check Event",
      type: CARD_TYPES.EVENT,
      color: "red",
      requiredEnergy: { color: "red", amount: 0 },
      apCost: 0,
      affinities: [],
      eventEffect: {
        kind: "sequence",
        effects: [
          {
            kind: "modifyBp",
            amount: -1000,
            duration: "turn",
            target: { controller: "opponent", line: LINES.FRONT, max: 1, choiceKey: "stateTarget" }
          },
          {
            kind: "modifyBp",
            amount: 500,
            duration: "turn",
            target: { controller: "opponent", line: LINES.FRONT, max: 1, choiceKey: "stateTarget" }
          }
        ]
      }
    }
  };

  let game = mainPhaseGame(catalog);
  game.players.P2.frontLine = [{
    pid: "state-target",
    owner: "P2",
    controller: "P2",
    cards: [{ uid: "state-target-card", owner: "P2", defId: "state_check_target", faceUp: true }],
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
  game.players.P1.hand.unshift({ uid: "state-event-card", owner: "P1", defId: "state_check_event", faceUp: true });

  game = applyAction(game, {
    type: "playCard",
    player: "P1",
    handIndex: 0,
    choices: { stateTarget: [{ player: "P2", lineName: LINES.FRONT, index: 0 }] }
  });

  assert.equal(game.players.P2.frontLine.length, 1);
  assert.equal(internals.battlePower(game, game.players.P2.frontLine[0]), 500);

  game.players.P1.hand.unshift({ uid: "state-event-card-2", owner: "P1", defId: "state_check_event", faceUp: true });
  game.catalog.state_check_event.eventEffect.effects.pop();
  game = applyAction(game, {
    type: "playCard",
    player: "P1",
    handIndex: 0,
    choices: { stateTarget: [{ player: "P2", lineName: LINES.FRONT, index: 0 }] }
  });
  assert.equal(game.players.P2.frontLine.length, 0);
  assert.equal(game.players.P2.sideline.some((item) => item.uid === "state-target-card"), true);
});

test("FAQ regression: an ability that leaves a player with no life ends the game after resolving", () => {
  const catalog = {
    ...sampleCatalog,
    life_loss_event: {
      id: "life_loss_event",
      number: "FAQ-1-062",
      sourceCode: "FAQ",
      name: "Life Loss Event",
      type: CARD_TYPES.EVENT,
      color: "red",
      requiredEnergy: { color: "red", amount: 0 },
      apCost: 0,
      affinities: [],
      eventEffect: { kind: "moveCardBetweenZones", source: "life", destination: "hand", count: 1 }
    }
  };
  let game = mainPhaseGame(catalog);
  game.players.P1.life = [{ uid: "last-life", owner: "P1", defId: "demo_rookie", faceUp: false }];
  game.players.P1.hand.unshift({ uid: "life-loss-card", owner: "P1", defId: "life_loss_event", faceUp: true });

  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0 });

  assert.equal(game.players.P1.life.length, 0);
  assert.equal(game.winner, "P2");
  assert.equal(game.phase, PHASES.GAME_OVER);
});

test("FAQ regression: Raid clears effects on the base card while newly gained abilities remain distinct from base abilities", () => {
  const catalog = {
    ...sampleCatalog,
    raid_base: {
      ...sampleCatalog.demo_rookie,
      id: "raid_base",
      number: "FAQ-1-063",
      name: "Raid Base",
      requiredEnergy: { color: "red", amount: 0 },
      apCost: 0,
      abilities: [{ id: "printed-main", timing: TIMINGS.ACTIVATE_MAIN, effect: { kind: "draw", amount: 1 } }]
    },
    raid_top: {
      ...sampleCatalog.demo_raider,
      id: "raid_top",
      number: "FAQ-1-064",
      name: "Raid Top",
      requiredEnergy: { color: "red", amount: 0 },
      apCost: 0,
      raid: { names: ["Raid Base"] },
      abilities: []
    },
    lose_base_event: {
      id: "lose_base_event",
      number: "FAQ-1-065",
      sourceCode: "FAQ",
      name: "Lose Base Event",
      type: CARD_TYPES.EVENT,
      color: "red",
      requiredEnergy: { color: "red", amount: 0 },
      apCost: 0,
      affinities: [],
      eventEffect: {
        kind: "grantKeyword",
        keyword: "lostBaseAbilities",
        duration: "turn",
        target: { controller: "self", line: LINES.FRONT, max: 1, choiceKey: "loseTarget" }
      }
    }
  };
  let game = mainPhaseGame(catalog);
  const base = {
    pid: "raid-base",
    owner: "P1",
    controller: "P1",
    cards: [{ uid: "raid-base-card", owner: "P1", defId: "raid_base", faceUp: true }],
    rested: true,
    bpDelta: 700,
    bpModifiers: [{ amount: 300, expires: "endOfTurn" }],
    keywordModifiers: [{ keyword: "impact", value: 1, expires: "endOfTurn" }],
    energyModifiers: [{ color: "red", amount: 1, expires: "endOfTurn" }],
    gainedAbilities: [{ id: "gained-main", timing: TIMINGS.ACTIVATE_MAIN, effect: { kind: "draw", amount: 1 } }],
    readyLocks: 1,
    playedThisTurn: false,
    attacksThisTurn: 1,
    blocksThisTurn: 1,
    usedOncePerTurn: ["printed-main"]
  };
  game.players.P1.frontLine = [base];
  game.players.P1.hand.unshift({ uid: "raid-top-card", owner: "P1", defId: "raid_top", faceUp: true });

  game = applyAction(game, {
    type: "performRaid",
    player: "P1",
    handIndex: 0,
    targetLine: LINES.FRONT,
    targetIndex: 0
  });
  const raided = game.players.P1.frontLine[0];
  assert.equal(raided.bpDelta, 0);
  assert.deepEqual(raided.bpModifiers, []);
  assert.deepEqual(raided.keywordModifiers, []);
  assert.deepEqual(raided.energyModifiers, []);
  assert.deepEqual(raided.gainedAbilities, []);
  assert.equal(raided.readyLocks, 0);
  assert.equal(raided.attacksThisTurn, 0);
  assert.equal(raided.rested, false);

  raided.cards = [{ uid: "raid-base-card-2", owner: "P1", defId: "raid_base", faceUp: true }];
  raided.gainedAbilities = [{ id: "gained-main", timing: TIMINGS.ACTIVATE_MAIN, effect: { kind: "draw", amount: 1 } }];
  game.players.P1.hand.unshift({ uid: "lose-base-card", owner: "P1", defId: "lose_base_event", faceUp: true });
  game = applyAction(game, {
    type: "playCard",
    player: "P1",
    handIndex: 0,
    choices: { loseTarget: [{ player: "P1", lineName: LINES.FRONT, index: 0 }] }
  });
  const activateIds = legalActions(game, "P1")
    .filter((action) => action.type === "activateMainAbility" && action.line === LINES.FRONT)
    .map((action) => action.abilityId);
  assert.deepEqual(activateIds, ["gained-main"]);
});

test("FAQ combat rules encode mandatory attackers, blockers, first attacks, and linked blockers separately", () => {
  const mustAttack = encodeEgmanCardText({
    name: "Saitama",
    category: "Character",
    effect: "Play this character set to active onto your field. This character must attack if able. [Damage (2)]",
    trigger: ""
  }).fields;
  assert.equal(mustAttack.keywords.mustAttack, true);

  const mustBlock = encodeEgmanCardText({
    name: "Kasumi Miwa",
    category: "Character",
    effect: "[Double Attack] (When this character attacks for the first time this turn, switch it to active.) This character must block your opponent's attacks if able. [When Played] Draw a card.",
    trigger: ""
  }).fields;
  assert.equal(mustBlock.keywords.mustBlockAttacks, true);

  const firstAttack = encodeEgmanCardText({
    name: "Ken Kaneki",
    category: "Character",
    effect: "[When Played] This character gains \"Your opponent must block this character's first attack if able\" until the end of the turn.",
    trigger: ""
  }).fields;
  assert.equal(firstAttack.abilities[0].effect.keyword, "mustBlockFirstAttack");

  const linked = encodeEgmanCardText({
    name: "Tafuku Mihara",
    category: "Character",
    effect: "[Activate: Main] [Once Per Turn] Choose one character with 3000 or less BP on your opponent's front line and one <Hiyuki Kagari> on your front line. The chosen character of your opponent must block the chosen <Hiyuki Kagari> character's attacks if able this turn.",
    trigger: ""
  }).fields;
  assert.equal(linked.abilities[0].effect.kind, "grantMandatoryBlockLink");
});

test("FAQ regression: characters that must attack are required before optional attackers", () => {
  const catalog = {
    ...sampleCatalog,
    forced_attacker: {
      ...sampleCatalog.demo_rookie,
      id: "forced_attacker",
      number: "FAQ-1-066",
      name: "Forced Attacker",
      keywords: { mustAttack: true }
    }
  };
  let game = mainPhaseGame(catalog);
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game.players.P1.frontLine = [
    faqPermanent("forced", "P1", "forced_attacker"),
    faqPermanent("optional", "P1", "demo_rookie")
  ];

  let actions = legalActions(game, "P1");
  assert.equal(actions.some((action) => action.type === "advancePhase"), false);
  assert.deepEqual([...new Set(actions.filter((action) => action.type === "declareAttack").map((action) => action.attackerIndex))], [0]);
  assert.throws(() => applyAction(game, {
    type: "declareAttack",
    player: "P1",
    attackerIndex: 1,
    target: { type: "player" }
  }), /must attack/i);

  game = applyAction(game, {
    type: "declareAttack",
    player: "P1",
    attackerIndex: 0,
    target: { type: "player" }
  });
  game = applyAction(game, { type: "declineBlock", player: "P2" });
  actions = legalActions(game, "P1");
  assert.equal(actions.some((action) => action.type === "advancePhase"), true);
  assert.equal(actions.some((action) => action.type === "declareAttack" && action.attackerIndex === 1), true);
});

test("FAQ regression: a mandatory blocker is required only when it can legally block", () => {
  const catalog = {
    ...sampleCatalog,
    forced_blocker: {
      ...sampleCatalog.demo_blocker,
      id: "forced_blocker",
      number: "FAQ-1-067",
      name: "Forced Blocker",
      keywords: { mustBlockAttacks: true }
    }
  };
  let game = mainPhaseGame(catalog);
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game.players.P1.frontLine = [faqPermanent("attacker", "P1", "demo_rookie")];
  game.players.P2.frontLine = [
    faqPermanent("forced-blocker", "P2", "forced_blocker"),
    faqPermanent("other-blocker", "P2", "demo_blocker")
  ];
  game = applyAction(game, {
    type: "declareAttack",
    player: "P1",
    attackerIndex: 0,
    target: { type: "player" }
  });
  let actions = legalActions(game, "P2");
  assert.deepEqual(actions, [{ type: "declareBlock", player: "P2", blockerIndex: 0 }]);
  assert.throws(() => applyAction(game, { type: "declineBlock", player: "P2" }), /must block/i);

  game.players.P2.frontLine[0].rested = true;
  actions = legalActions(game, "P2");
  assert.equal(actions.some((action) => action.type === "declineBlock"), true);
  assert.equal(actions.some((action) => action.type === "declareBlock" && action.blockerIndex === 1), true);
});

test("FAQ regression: linked mandatory blockers apply only to the chosen attacker's attacks", () => {
  const catalog = {
    ...sampleCatalog,
    link_source: {
      ...sampleCatalog.demo_rookie,
      id: "link_source",
      number: "FAQ-1-068",
      name: "Link Source",
      abilities: [{
        id: "link-main",
        timing: TIMINGS.ACTIVATE_MAIN,
        effect: {
          kind: "grantMandatoryBlockLink",
          blockerTarget: { controller: "opponent", line: LINES.FRONT, max: 1, choiceKey: "mandatoryBlockerTarget" },
          attackerTarget: { controller: "self", line: LINES.FRONT, name: "Hiyuki Kagari", max: 1, choiceKey: "mandatoryAttackerTarget" },
          duration: "turn"
        }
      }]
    },
    hiyuki: {
      ...sampleCatalog.demo_rookie,
      id: "hiyuki",
      number: "FAQ-1-069",
      name: "Hiyuki Kagari"
    }
  };
  let game = mainPhaseGame(catalog);
  game.players.P1.frontLine = [
    faqPermanent("link-source", "P1", "link_source"),
    faqPermanent("hiyuki", "P1", "hiyuki")
  ];
  game.players.P2.frontLine = [
    faqPermanent("linked-blocker", "P2", "demo_blocker"),
    faqPermanent("free-blocker", "P2", "demo_blocker")
  ];
  game = applyAction(game, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: "link-main",
    choices: {
      mandatoryBlockerTarget: [{ player: "P2", lineName: LINES.FRONT, index: 0 }],
      mandatoryAttackerTarget: [{ player: "P1", lineName: LINES.FRONT, index: 1 }]
    }
  });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, {
    type: "declareAttack",
    player: "P1",
    attackerIndex: 1,
    target: { type: "player" }
  });
  assert.deepEqual(legalActions(game, "P2"), [{ type: "declareBlock", player: "P2", blockerIndex: 0 }]);
});

test("FAQ targeting taxes are payable additional costs and respect ability-source scope", () => {
  const catalog = {
    ...sampleCatalog,
    scoped_target: {
      ...sampleCatalog.demo_guardian,
      id: "scoped_target",
      number: "FAQ-1-070",
      name: "Scoped Target",
      targetingRestrictions: [{
        mode: "tax",
        sourceTypes: [CARD_TYPES.CHARACTER, CARD_TYPES.EVENT],
        payment: { kind: "ap", amount: 1 }
      }]
    },
    target_source: {
      ...sampleCatalog.demo_rookie,
      id: "target_source",
      number: "FAQ-1-071",
      name: "Target Source",
      abilities: [{
        id: "target-main",
        timing: TIMINGS.ACTIVATE_MAIN,
        effect: {
          kind: "modifyBp",
          amount: -500,
          duration: "turn",
          target: { controller: "opponent", line: LINES.FRONT, min: 1, max: 1, choiceKey: "taxedTarget" }
        }
      }]
    }
  };
  let game = mainPhaseGame(catalog);
  game.players.P1.frontLine = [faqPermanent("tax-source", "P1", "target_source")];
  game.players.P2.frontLine = [faqPermanent("tax-target", "P2", "scoped_target")];
  assert.equal(game.players.P1.apCards.filter((ap) => !ap.rested).length, 1);

  game = applyAction(game, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: "target-main",
    choices: { taxedTarget: [{ player: "P2", lineName: LINES.FRONT, index: 0 }] }
  });
  assert.equal(game.players.P1.apCards.filter((ap) => !ap.rested).length, 0);
  assert.equal(internals.battlePower(game, game.players.P2.frontLine[0]), 2500);
});

test("FAQ targeting prohibitions distinguish event abilities from character abilities and honor choosing zero", () => {
  const catalog = {
    ...sampleCatalog,
    event_protected: {
      ...sampleCatalog.demo_guardian,
      id: "event_protected",
      number: "FAQ-1-072",
      name: "Event Protected",
      targetingRestrictions: [{ mode: "prohibit", sourceTypes: [CARD_TYPES.EVENT] }]
    },
    character_targeter: {
      ...sampleCatalog.demo_rookie,
      id: "character_targeter",
      number: "FAQ-1-073",
      name: "Character Targeter",
      abilities: [{
        id: "character-target",
        timing: TIMINGS.ACTIVATE_MAIN,
        effect: {
          kind: "modifyBp",
          amount: -500,
          duration: "turn",
          target: { controller: "opponent", line: LINES.FRONT, min: 1, max: 1, choiceKey: "characterTarget" }
        }
      }]
    },
    event_targeter: {
      id: "event_targeter",
      number: "FAQ-1-074",
      sourceCode: "FAQ",
      name: "Event Targeter",
      type: CARD_TYPES.EVENT,
      color: "red",
      requiredEnergy: { color: "red", amount: 0 },
      apCost: 0,
      affinities: [],
      eventEffect: {
        kind: "modifyBp",
        amount: -500,
        duration: "turn",
        target: { controller: "opponent", line: LINES.FRONT, min: 0, max: 1, choiceKey: "eventTarget" }
      }
    }
  };
  let game = mainPhaseGame(catalog);
  game.players.P1.frontLine = [faqPermanent("character-targeter", "P1", "character_targeter")];
  game.players.P2.frontLine = [faqPermanent("event-protected", "P2", "event_protected")];
  game = applyAction(game, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: "character-target",
    choices: { characterTarget: [{ player: "P2", lineName: LINES.FRONT, index: 0 }] }
  });
  assert.equal(internals.battlePower(game, game.players.P2.frontLine[0]), 2500);

  game.players.P1.hand.unshift({ uid: "event-targeter-card", owner: "P1", defId: "event_targeter", faceUp: true });
  game = applyAction(game, {
    type: "playCard",
    player: "P1",
    handIndex: 0,
    choices: { eventTarget: [] }
  });
  assert.equal(internals.battlePower(game, game.players.P2.frontLine[0]), 2500);
});

test("FAQ removal protection stops opponent abilities but not zero-BP rules processing", () => {
  const catalog = {
    ...sampleCatalog,
    removal_protected: {
      ...sampleCatalog.demo_rookie,
      id: "removal_protected",
      number: "FAQ-1-075",
      name: "Removal Protected",
      opponentAbilityRemovalProtection: true
    },
    removal_source: {
      ...sampleCatalog.demo_rookie,
      id: "removal_source",
      number: "FAQ-1-076",
      name: "Removal Source",
      abilities: [{
        id: "remove-main",
        timing: TIMINGS.ACTIVATE_MAIN,
        effect: {
          kind: "sidelineTargets",
          target: { controller: "opponent", line: LINES.FRONT, min: 1, max: 1, choiceKey: "removeTarget" }
        }
      }, {
        id: "reduce-main",
        timing: TIMINGS.ACTIVATE_MAIN,
        effect: {
          kind: "modifyBp",
          amount: -2000,
          duration: "turn",
          target: { controller: "opponent", line: LINES.FRONT, min: 1, max: 1, choiceKey: "reduceTarget" }
        }
      }]
    }
  };
  let game = mainPhaseGame(catalog);
  game.players.P1.frontLine = [faqPermanent("removal-source", "P1", "removal_source")];
  game.players.P2.frontLine = [faqPermanent("removal-protected", "P2", "removal_protected")];
  game = applyAction(game, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: "remove-main",
    choices: { removeTarget: [{ player: "P2", lineName: LINES.FRONT, index: 0 }] }
  });
  assert.equal(game.players.P2.frontLine.length, 1);

  game = applyAction(game, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: "reduce-main",
    choices: { reduceTarget: [{ player: "P2", lineName: LINES.FRONT, index: 0 }] }
  });
  assert.equal(game.players.P2.frontLine.length, 0);
  assert.equal(game.players.P2.sideline.some((item) => item.uid === "removal-protected-card"), true);
});

test("FAQ return protection stops either player's abilities without preventing other zone removal", () => {
  const catalog = {
    ...sampleCatalog,
    return_protected: {
      ...sampleCatalog.demo_rookie,
      id: "return_protected",
      number: "FAQ-1-077",
      name: "Return Protected",
      abilityReturnToHandProtection: true
    },
    return_source: {
      ...sampleCatalog.demo_rookie,
      id: "return_source",
      number: "FAQ-1-078",
      name: "Return Source",
      abilities: [{
        id: "return-main",
        timing: TIMINGS.ACTIVATE_MAIN,
        effect: {
          kind: "returnTargetsToHand",
          target: { controller: "self", line: LINES.FRONT, min: 1, max: 1, choiceKey: "returnTarget" }
        }
      }, {
        id: "sideline-main",
        timing: TIMINGS.ACTIVATE_MAIN,
        effect: {
          kind: "sidelineTargets",
          target: { controller: "self", line: LINES.FRONT, min: 1, max: 1, choiceKey: "sidelineTarget" }
        }
      }]
    }
  };
  let game = mainPhaseGame(catalog);
  game.players.P1.frontLine = [
    faqPermanent("return-source", "P1", "return_source"),
    faqPermanent("return-protected", "P1", "return_protected")
  ];
  game = applyAction(game, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: "return-main",
    choices: { returnTarget: [{ player: "P1", lineName: LINES.FRONT, index: 1 }] }
  });
  assert.equal(game.players.P1.frontLine.some((item) => item.pid === "return-protected"), true);
  game = applyAction(game, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: "sideline-main",
    choices: { sidelineTarget: [{ player: "P1", lineName: LINES.FRONT, index: 1 }] }
  });
  assert.equal(game.players.P1.frontLine.some((item) => item.pid === "return-protected"), false);
  assert.equal(game.players.P1.sideline.some((item) => item.uid === "return-protected-card"), true);
});

test("FAQ regression: multi-card play effects make room first, play simultaneously, then order When Played abilities", () => {
  const encoded = encodeEgmanCardText({
    name: "Mini Mechamaru",
    category: "Event",
    effect: "Draw a card. Play up to two red character cards with 3 or less required energy, 1 AP cost, and [Jujutsu Sorcerer] affinity from your hand set to resting onto your field.",
    trigger: ""
  }).fields;
  const playEffect = encoded.eventEffect.effects.find((effect) => effect.kind === "playCardFromZone");
  assert.equal(playEffect.count, 2);
  assert.equal(playEffect.simultaneous, true);

  const catalog = {
    ...sampleCatalog,
    simultaneous_a: {
      ...sampleCatalog.demo_rookie,
      id: "simultaneous_a",
      number: "FAQ-1-079",
      name: "Simultaneous A",
      color: "red",
      requiredEnergy: { color: "red", amount: 0 },
      apCost: 1,
      affinities: ["Jujutsu Sorcerer"],
      abilities: [{
        id: "boost-b",
        timing: TIMINGS.WHEN_PLAYED,
        effect: {
          kind: "modifyBp",
          amount: 500,
          duration: "turn",
          target: { controller: "self", line: LINES.FRONT, name: "Simultaneous B", min: 1, max: 1 }
        }
      }]
    },
    simultaneous_b: {
      ...sampleCatalog.demo_rookie,
      id: "simultaneous_b",
      number: "FAQ-1-080",
      name: "Simultaneous B",
      color: "red",
      requiredEnergy: { color: "red", amount: 0 },
      apCost: 1,
      affinities: ["Jujutsu Sorcerer"]
    },
    simultaneous_event: {
      id: "simultaneous_event",
      number: "FAQ-1-081",
      sourceCode: "FAQ",
      name: "Simultaneous Event",
      type: CARD_TYPES.EVENT,
      color: "red",
      requiredEnergy: { color: "red", amount: 0 },
      apCost: 0,
      affinities: [],
      eventEffect: {
        kind: "playCardFromZone",
        zones: ["hand"],
        count: 2,
        simultaneous: true,
        rested: true,
        destinationLine: LINES.FRONT,
        choiceKey: "playZoneIndex",
        filter: { type: CARD_TYPES.CHARACTER, color: "red", affinity: "Jujutsu Sorcerer" }
      }
    }
  };
  let game = mainPhaseGame(catalog);
  game.players.P1.frontLine = [
    faqPermanent("existing-1", "P1", "demo_rookie"),
    faqPermanent("existing-2", "P1", "demo_rookie"),
    faqPermanent("existing-3", "P1", "demo_rookie"),
    faqPermanent("existing-4", "P1", "demo_rookie")
  ];
  game.players.P1.hand = [
    { uid: "sim-event", owner: "P1", defId: "simultaneous_event", faceUp: true },
    { uid: "sim-a", owner: "P1", defId: "simultaneous_a", faceUp: true },
    { uid: "sim-b", owner: "P1", defId: "simultaneous_b", faceUp: true }
  ];
  game = applyAction(game, {
    type: "playCard",
    player: "P1",
    handIndex: 0,
    choices: {
      playZoneIndex: [0, 1],
      replaceIndices: [0, 0],
      simultaneousPlayedOrder: [0, 1]
    }
  });
  assert.equal(game.players.P1.frontLine.length, 4);
  assert.equal(game.players.P1.removal.some((item) => item.uid === "existing-1-card"), true);
  assert.equal(game.players.P1.removal.some((item) => item.uid === "existing-2-card"), true);
  const playedB = game.players.P1.frontLine.find((permanent) => permanent.cards.at(-1).defId === "simultaneous_b");
  assert.ok(playedB);
  assert.equal(internals.battlePower(game, playedB), 2000);
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

  const noCostGame = mainPhaseGame(catalog);
  noCostGame.players.P1.hand = [
    { uid: "upgrade-source-card-3", owner: "P1", defId: "optional_upgrade_source", faceUp: true }
  ];
  assert.doesNotThrow(() => applyAction(noCostGame, {
    type: "playCard",
    player: "P1",
    handIndex: 0,
    destination: LINES.FRONT,
    choices: { effectChoice: 0 }
  }));
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

test("FAQ regression: Raid triggers may perform Raid and ready the matching base", () => {
  const catalog = {
    ...sampleCatalog,
    raid_trigger_base: {
      ...sampleCatalog.demo_rookie,
      id: "raid_trigger_base",
      number: "FAQ-RAID-BASE",
      name: "Raid Trigger Base",
      requiredEnergy: { color: "red", amount: 0 },
      apCost: 0
    },
    raid_trigger_card: {
      ...sampleCatalog.demo_raider,
      id: "raid_trigger_card",
      number: "FAQ-RAID-TRIGGER",
      name: "Raid Trigger Card",
      requiredEnergy: { color: "red", amount: 0 },
      apCost: 0,
      raid: { names: ["Raid Trigger Base"], affinities: [] },
      trigger: { type: "raid" }
    }
  };
  const game = mainPhaseGame(catalog);
  game.activePlayer = "P2";
  game.players.P1.frontLine = [faqPermanent("raid-trigger-base", "P1", "raid_trigger_base", true)];
  game.players.P1.life = [
    { uid: "raid-trigger-life", owner: "P1", defId: "raid_trigger_card", faceUp: false },
    { uid: "remaining-life", owner: "P1", defId: "demo_rookie", faceUp: false }
  ];

  internals.dealDamage(game, "P1", 1, {
    sourcePlayer: "P2",
    lifeIndices: [0],
    triggerChoices: [{
      choices: {
        performRaid: true,
        raidTarget: { lineName: LINES.FRONT, index: 0 }
      }
    }]
  });

  assert.equal(game.players.P1.frontLine[0].cards.length, 2);
  assert.equal(game.players.P1.frontLine[0].cards.at(-1).defId, "raid_trigger_card");
  assert.equal(game.players.P1.frontLine[0].rested, false);
  assert.equal(game.players.P1.hand.some((card) => card.uid === "raid-trigger-life"), false);
});

test("FAQ regression: next-ready prevention is consumed only by the next ready attempt", () => {
  const catalog = {
    ...sampleCatalog,
    active_trigger_life: {
      ...sampleCatalog.demo_rookie,
      id: "active_trigger_life",
      number: "FAQ-ACTIVE-TRIGGER",
      name: "Active Trigger Life",
      trigger: { type: "active" }
    }
  };
  let game = mainPhaseGame(catalog);
  const locked = faqPermanent("ready-locked", "P2", "demo_guardian", true);
  locked.readyLocks = 1;
  game.players.P2.frontLine = [locked];
  game.players.P2.life = [
    { uid: "active-trigger-life", owner: "P2", defId: "active_trigger_life", faceUp: false },
    { uid: "remaining-life", owner: "P2", defId: "demo_rookie", faceUp: false }
  ];

  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });

  assert.equal(game.activePlayer, "P2");
  assert.equal(game.players.P2.frontLine[0].rested, true);
  assert.equal(game.players.P2.frontLine[0].readyLocks, 0);

  internals.dealDamage(game, "P2", 1, {
    sourcePlayer: "P1",
    lifeIndices: [0],
    triggerChoices: [true]
  });
  assert.equal(game.players.P2.frontLine[0].rested, false);
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

test("FAQ regression: partial zone payment moves available cards but does not resolve If-you-do payoff", () => {
  const encoded = encodeEgmanCardText({
    category: "Event",
    name: "Partial Payment",
    effect: "You may place four cards from your sideline into your removal area. If you do, draw two cards.",
    trigger: ""
  }).fields;
  const event = {
    id: "partial_payment",
    number: "FAQ-PARTIAL-PAYMENT",
    sourceCode: "FAQ",
    name: "Partial Payment",
    type: CARD_TYPES.EVENT,
    color: "green",
    requiredEnergy: { color: "green", amount: 0 },
    apCost: 0,
    affinities: [],
    eventEffect: encoded.eventEffect
  };
  const catalog = { ...sampleCatalog, partial_payment: event };
  let game = mainPhaseGame(catalog);
  game.players.P1.hand = [{ uid: "partial-event", owner: "P1", defId: event.id, faceUp: true }];
  game.players.P1.sideline = [
    { uid: "partial-a", owner: "P1", defId: "demo_rookie", faceUp: true },
    { uid: "partial-b", owner: "P1", defId: "demo_rookie", faceUp: true },
    { uid: "partial-c", owner: "P1", defId: "demo_rookie", faceUp: true }
  ];
  const deckBefore = game.players.P1.deck.length;

  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0 });

  assert.equal(game.players.P1.removal.length, 3);
  assert.equal(game.players.P1.deck.length, deckBefore);
  assert.equal(game.players.P1.hand.length, 0);
});

test("FAQ regression: an optional hand payment that cannot be made declines without throwing", () => {
  const encoded = encodeEgmanCardText({
    category: "Event",
    name: "Unpayable Hand Cost",
    effect: "You may place two cards from your hand into your sideline. If you do, draw three cards.",
    trigger: ""
  }).fields;
  const event = {
    id: "unpayable_hand_cost",
    number: "FAQ-HAND-PAYMENT",
    sourceCode: "FAQ",
    name: "Unpayable Hand Cost",
    type: CARD_TYPES.EVENT,
    color: "green",
    requiredEnergy: { color: "green", amount: 0 },
    apCost: 0,
    affinities: [],
    eventEffect: encoded.eventEffect
  };
  const catalog = { ...sampleCatalog, unpayable_hand_cost: event };
  let game = mainPhaseGame(catalog);
  game.players.P1.hand = [{ uid: "hand-cost-event", owner: "P1", defId: event.id, faceUp: true }];
  const deckBefore = game.players.P1.deck.length;

  assert.doesNotThrow(() => {
    game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0 });
  });
  assert.equal(game.players.P1.deck.length, deckBefore);
  assert.equal(game.players.P1.hand.length, 0);
});
