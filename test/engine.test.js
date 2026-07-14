import test from "node:test";
import assert from "node:assert/strict";
import {
  CARD_TYPES,
  LINES,
  MAX_LINE_SIZE,
  PHASES,
  TIMINGS,
  applyAction,
  createGame,
  internals,
  legalActions,
  validateDeck
} from "../src/index.js";
import { sampleCatalog, sampleDeckList } from "../data/sample-cards.js";

function makeGame(overrides = {}) {
  return createGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    ...overrides
  });
}

function mainPhase(game, player = "P1") {
  let next = applyAction(game, { type: "advancePhase", player });
  next = applyAction(next, { type: "advancePhase", player });
  return next;
}

function permanent(pid, playerId, defId, { rested = false } = {}) {
  return {
    pid,
    owner: playerId,
    controller: playerId,
    cards: [{ uid: `${pid}-card`, owner: playerId, defId, faceUp: true }],
    rested,
    bpDelta: 0,
    bpModifiers: [],
    keywordModifiers: [],
    energyModifiers: [],
    gainedAbilities: [],
    readyLocks: 0,
    attacksThisTurn: 0,
    blocksThisTurn: 0,
    usedOncePerTurn: []
  };
}

function card(uid, owner, defId, faceUp = true) {
  return { uid, owner, defId, faceUp };
}

function topDefId(permanent) {
  return permanent.cards.at(-1).defId;
}

test("sample deck satisfies Union Arena construction constraints", () => {
  const result = validateDeck(sampleDeckList, sampleCatalog);
  assert.equal(result.size, 50);
  assert.equal(result.sourceCode, "DEM");
});

test("actions isolate mutable game state without cloning the immutable catalog", () => {
  const game = makeGame({ setupMode: "manual" });
  const originalCard = game.players.P1.hand[0];
  const next = applyAction(game, { type: "keepHand", player: "P1" });

  assert.notStrictEqual(next, game);
  assert.strictEqual(next.catalog, game.catalog);
  assert.notStrictEqual(next.players, game.players);
  assert.notStrictEqual(next.players.P1, game.players.P1);
  assert.notStrictEqual(next.players.P1.hand, game.players.P1.hand);
  assert.notStrictEqual(next.players.P1.hand[0], originalCard);
  assert.equal(game.players.P1.setupKept, false);
  assert.equal(next.players.P1.setupKept, true);

  next.players.P1.hand[0].faceUp = false;
  assert.equal(originalCard.faceUp, true);
});

test("filtered ability hand costs require and discard a matching card", () => {
  const catalog = {
    ...sampleCatalog,
    filtered_cost_source: {
      ...sampleCatalog.demo_rookie,
      id: "filtered_cost_source",
      number: "DEM-1-198",
      name: "Filtered Cost Source",
      abilities: [{
        id: "activateMain-1",
        timing: TIMINGS.ACTIVATE_MAIN,
        oncePerTurn: true,
        cost: {
          discardFromHand: 1,
          discardFromHandFilter: { anyOf: [{ nameIncludesAll: ["Zangetsu"] }, { nameIncludesAll: ["Getsuga"] }] },
          discardChoiceKey: "abilityDiscardHandIndexes"
        },
        effect: { kind: "draw", amount: 1 }
      }]
    },
    matching_cost: {
      ...sampleCatalog.demo_rookie,
      id: "matching_cost",
      number: "DEM-1-199",
      name: "Getsuga Tensho"
    }
  };
  let game = createGame({ catalog, decks: { P1: sampleDeckList, P2: sampleDeckList }, skipShuffle: true, validateDecks: false });
  game = mainPhase(game);
  game.players.P1.frontLine = [permanent("filtered-source", "P1", "filtered_cost_source")];
  game.players.P1.hand = [card("nonmatch", "P1", "demo_guardian")];

  assert.equal(legalActions(game, "P1").some((action) => action.type === "activateMainAbility"), false);

  game.players.P1.hand.push(card("matching", "P1", "matching_cost"));
  assert.equal(legalActions(game, "P1").some((action) => action.type === "activateMainAbility"), true);
  game = applyAction(game, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: "activateMain-1",
    choices: { abilityDiscardHandIndexes: [1] }
  });

  assert.equal(game.players.P1.sideline.some((item) => item.uid === "matching"), true);
  assert.equal(game.players.P1.hand.some((item) => item.uid === "nonmatch"), true);
});

test("return-to-hand replacement keeps the character on field after paying a hand card", () => {
  const catalog = {
    ...sampleCatalog,
    protected_returner: {
      ...sampleCatalog.demo_rookie,
      id: "protected_returner",
      number: "DEM-1-201",
      name: "Protected Returner",
      returnToHandHandSidelineInstead: true
    },
    self_bouncer: {
      ...sampleCatalog.demo_rookie,
      id: "self_bouncer",
      number: "DEM-1-202",
      name: "Self Bouncer",
      abilities: [{
        id: "whenPlayed-1",
        timing: TIMINGS.WHEN_PLAYED,
        effect: {
          kind: "returnTargetsToHand",
          target: { controller: "self", line: LINES.FRONT, type: CARD_TYPES.CHARACTER, max: 1, choiceKey: "bounceTarget" }
        }
      }]
    }
  };
  let game = createGame({ catalog, decks: { P1: sampleDeckList, P2: sampleDeckList }, skipShuffle: true, validateDecks: false });
  game = mainPhase(game);
  game.players.P1.frontLine = [permanent("protected", "P1", "protected_returner")];
  game.players.P1.hand = [card("bouncer-card", "P1", "self_bouncer"), card("replacement-cost", "P1", "demo_guardian")];

  game = applyAction(game, {
    type: "playCard",
    player: "P1",
    handIndex: 0,
    destination: LINES.FRONT,
    choices: { bounceTarget: [{ playerId: "P1", lineName: LINES.FRONT, index: 0 }] }
  });

  assert.equal(game.players.P1.frontLine.some((item) => item.pid === "protected"), true);
  assert.equal(game.players.P1.hand.some((item) => item.defId === "protected_returner"), false);
  assert.equal(game.players.P1.sideline.some((item) => item.uid === "replacement-cost"), true);
});

test("front-line rest-by-ability watchers trigger from ability effects", () => {
  const catalog = {
    ...sampleCatalog,
    jackal_like: {
      ...sampleCatalog.demo_rookie,
      id: "jackal_like",
      number: "DEM-1-203",
      name: "Jackal Like",
      bp: 2500,
      abilities: [{
        id: "whenOwnFrontCharacterRestedByAbility-1",
        timing: TIMINGS.WHEN_OWN_FRONT_CHARACTER_RESTED_BY_ABILITY,
        oncePerTurn: true,
        effect: { kind: "modifyBp", amount: 1000, duration: "turn", target: "self" }
      }]
    },
    rester: {
      ...sampleCatalog.demo_rookie,
      id: "rester",
      number: "DEM-1-204",
      name: "Rester",
      abilities: [{
        id: "whenPlayed-1",
        timing: TIMINGS.WHEN_PLAYED,
        effect: {
          kind: "restTargets",
          target: { controller: "self", line: LINES.FRONT, type: CARD_TYPES.CHARACTER, max: 1, choiceKey: "restTarget" }
        }
      }]
    }
  };
  let game = createGame({ catalog, decks: { P1: sampleDeckList, P2: sampleDeckList }, skipShuffle: true, validateDecks: false });
  game = mainPhase(game);
  game.players.P1.frontLine = [permanent("jackal", "P1", "jackal_like"), permanent("rest-me", "P1", "demo_rookie")];
  game.players.P1.hand = [card("rester-card", "P1", "rester")];

  game = applyAction(game, {
    type: "playCard",
    player: "P1",
    handIndex: 0,
    destination: LINES.FRONT,
    choices: { restTarget: [{ playerId: "P1", lineName: LINES.FRONT, index: 1 }] }
  });

  assert.equal(game.players.P1.frontLine.find((item) => item.pid === "rest-me").rested, true);
  assert.equal(internals.battlePower(game, game.players.P1.frontLine.find((item) => item.pid === "jackal")), 3500);
});

test("move-to-front effects draw only when no front-line card entered removal", () => {
  const catalog = {
    ...sampleCatalog,
    blue_like: {
      id: "blue_like",
      number: "DEM-1-205",
      sourceCode: "DEM",
      name: "Blue Like",
      type: CARD_TYPES.EVENT,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      affinities: [],
      eventEffect: {
        kind: "sequence",
        effects: [
          { kind: "moveTargetsToLine", destinationLine: LINES.FRONT, target: { controller: "opponent", line: LINES.ENERGY, type: CARD_TYPES.CHARACTER, max: 1 } },
          { kind: "conditional", condition: { lastMoveToLineRemovalCountMax: 0 }, effect: { kind: "draw", amount: 1 } }
        ]
      }
    }
  };
  let game = createGame({ catalog, decks: { P1: sampleDeckList, P2: sampleDeckList }, skipShuffle: true, validateDecks: false });
  game = mainPhase(game);
  game.players.P1.hand = [card("blue-card", "P1", "blue_like")];
  game.players.P1.deck = [card("draw-card", "P1", "demo_guardian")];
  game.players.P2.energyLine = [permanent("move-me", "P2", "demo_rookie")];

  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0 });
  assert.equal(game.players.P1.hand.length, 1);

  game = createGame({ catalog, decks: { P1: sampleDeckList, P2: sampleDeckList }, skipShuffle: true, validateDecks: false });
  game = mainPhase(game);
  game.players.P1.hand = [card("blue-card-2", "P1", "blue_like")];
  game.players.P1.deck = [card("draw-card-2", "P1", "demo_guardian")];
  game.players.P2.frontLine = [0, 1, 2, 3].map((index) => permanent(`front-${index}`, "P2", "demo_rookie"));
  game.players.P2.energyLine = [permanent("move-me-2", "P2", "demo_rookie")];

  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0, choices: { replaceIndex: 0 } });
  assert.equal(game.players.P1.hand.length, 0);
  assert.equal(game.players.P2.removal.length, 1);
});

test("opponent optional sideline-to-removal payment chooses the correct branch", () => {
  const catalog = {
    ...sampleCatalog,
    kaneki_like: {
      ...sampleCatalog.demo_guardian,
      id: "kaneki_like",
      number: "DEM-1-206",
      name: "Kaneki Like",
      bp: 5000,
      abilities: [{
        id: "whenAttacking-1",
        timing: TIMINGS.WHEN_ATTACKING,
        effect: {
          kind: "opponentMayMoveCardsBetweenZonesElse",
          source: "sideline",
          destination: "removal",
          count: 7,
          ifMovedEffect: { kind: "sequence", effects: [{ kind: "draw", amount: 2 }, { kind: "moveHandToZone", amount: 1, destination: "sideline" }] },
          elseEffect: { kind: "sidelineTargets", target: { controller: "opponent", line: LINES.FRONT, type: CARD_TYPES.CHARACTER, max: 1 } }
        }
      }]
    }
  };
  let game = createGame({ catalog, decks: { P1: sampleDeckList, P2: sampleDeckList }, skipShuffle: true, validateDecks: false });
  game.phase = PHASES.ATTACK;
  game.activePlayer = "P1";
  game.players.P1.frontLine = [permanent("attacker", "P1", "kaneki_like")];
  game.players.P1.hand = [card("discard", "P1", "demo_rookie")];
  game.players.P1.deck = [card("draw-1", "P1", "demo_rookie"), card("draw-2", "P1", "demo_guardian")];
  game.players.P2.frontLine = [permanent("victim", "P2", "demo_rookie")];
  game.players.P2.sideline = Array.from({ length: 7 }, (_, index) => card(`pay-${index}`, "P2", "demo_rookie"));

  game = applyAction(game, { type: "declareAttack", player: "P1", attackerIndex: 0 });
  assert.equal(game.players.P2.removal.length, 7);
  assert.equal(game.players.P2.frontLine.length, 1);
  assert.equal(game.players.P1.hand.length, 2);

  game = createGame({ catalog, decks: { P1: sampleDeckList, P2: sampleDeckList }, skipShuffle: true, validateDecks: false });
  game.phase = PHASES.ATTACK;
  game.activePlayer = "P1";
  game.players.P1.frontLine = [permanent("attacker-2", "P1", "kaneki_like")];
  game.players.P2.frontLine = [permanent("victim-2", "P2", "demo_rookie")];
  game.players.P2.sideline = Array.from({ length: 7 }, (_, index) => card(`decline-pay-${index}`, "P2", "demo_rookie"));

  game = applyAction(game, { type: "declareAttack", player: "P1", attackerIndex: 0, choices: { opponentZoneMoveChoice: false } });
  assert.equal(game.players.P2.removal.length, 0);
  assert.equal(game.players.P2.frontLine.length, 0);
});

test("opponent hand cards can move into the controller's sideline", () => {
  const catalog = {
    ...sampleCatalog,
    rakuzaichi_like: {
      ...sampleCatalog.demo_site,
      id: "rakuzaichi_like",
      number: "DEM-1-207",
      name: "Rakuzaichi Like",
      abilities: [{
        id: "activateMain-1",
        timing: TIMINGS.ACTIVATE_MAIN,
        effect: {
          kind: "opponentMayMoveCardsBetweenZonesElse",
          source: "hand",
          destination: "sideline",
          destinationPlayer: "self",
          count: 2
        }
      }]
    }
  };
  let game = createGame({ catalog, decks: { P1: sampleDeckList, P2: sampleDeckList }, skipShuffle: true, validateDecks: false });
  game = mainPhase(game);
  game.players.P1.energyLine = [permanent("site", "P1", "rakuzaichi_like")];
  game.players.P2.hand = [card("gift-1", "P2", "demo_rookie"), card("gift-2", "P2", "demo_guardian")];

  game = applyAction(game, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.ENERGY,
    index: 0,
    abilityId: "activateMain-1",
    choices: {
      opponentZoneMoveChoice: true,
      opponentZoneMoveIndices: [0, 1]
    }
  });
  assert.equal(game.players.P2.hand.length, 0);
  assert.deepEqual(game.players.P1.sideline.map((entry) => entry.uid), ["gift-1", "gift-2"]);
  assert.deepEqual(game.players.P1.sideline.map((entry) => entry.owner), ["P2", "P2"]);
});

test("activate-main face-down-under condition is enforced", () => {
  const catalog = {
    ...sampleCatalog,
    under_ready: {
      ...sampleCatalog.demo_guardian,
      id: "under_ready",
      number: "DEM-1-207",
      name: "Under Ready",
      abilities: [{
        id: "activateMain-1",
        timing: TIMINGS.ACTIVATE_MAIN,
        oncePerTurn: true,
        conditions: { line: LINES.FRONT, hasFaceDownUnder: true },
        effect: { kind: "readySelf" }
      }]
    }
  };
  let game = createGame({ catalog, decks: { P1: sampleDeckList, P2: sampleDeckList }, skipShuffle: true, validateDecks: false });
  game = mainPhase(game);
  game.players.P1.frontLine = [permanent("under-ready", "P1", "under_ready", { rested: true })];

  assert.throws(() => applyAction(game, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: "activateMain-1"
  }), /conditions are not fulfilled/i);

  game.players.P1.frontLine[0].cards.unshift(card("under-card", "P1", "demo_rookie", false));
  game = applyAction(game, { type: "activateMainAbility", player: "P1", line: LINES.FRONT, index: 0, abilityId: "activateMain-1" });
  assert.equal(game.players.P1.frontLine[0].rested, false);
});

test("setup creates hand, life, and first-player AP correctly", () => {
  const game = makeGame();
  assert.equal(game.phase, PHASES.START);
  assert.equal(game.activePlayer, "P1");
  assert.equal(game.players.P1.hand.length, 7);
  assert.equal(game.players.P1.life.length, 7);
  assert.equal(game.players.P1.apCards.length, 1);
  assert.equal(game.players.P1.deck.length, 36);
});

test("P1 can play a character to energy and generated energy ignores front line cards", () => {
  let game = makeGame();
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });

  game = applyAction(game, {
    type: "playCard",
    player: "P1",
    handIndex: 0,
    destination: LINES.ENERGY
  });
  assert.deepEqual(internals.energyAvailable(game, "P1"), { green: 1 });

  game = applyAction(game, {
    type: "playCard",
    player: "P1",
    handIndex: 0,
    destination: LINES.FRONT
  });
  assert.deepEqual(internals.energyAvailable(game, "P1"), { green: 1 });
});

test("front-line energy-generation keyword lets front-line characters produce energy", () => {
  const catalog = {
    ...sampleCatalog,
    front_generator: {
      id: "front_generator",
      number: "DEM-1-087",
      sourceCode: "DEM",
      name: "Front Generator",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      keywords: { frontLineEnergyGeneration: true }
    }
  };
  const game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game.players.P1.frontLine.push(permanent("front-generator", "P1", "front_generator"));

  assert.deepEqual(internals.energyAvailable(game, "P1"), { green: 1 });
});

test("static field keyword auras protect matching allied targets", () => {
  const catalog = {
    ...sampleCatalog,
    targeter: {
      id: "targeter",
      number: "DEM-1-117",
      sourceCode: "DEM",
      name: "Targeter",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      abilities: [{
        id: "whenPlayed-1",
        timing: TIMINGS.WHEN_PLAYED,
        effect: {
          kind: "sidelineTargets",
          target: {
            controller: "opponent",
            line: LINES.FRONT,
            type: CARD_TYPES.CHARACTER,
            max: 1,
            choiceKey: "sidelineTarget"
          }
        }
      }]
    },
    aura_source: {
      id: "aura_source",
      number: "DEM-1-118",
      sourceCode: "DEM",
      name: "Aura Source",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      staticFieldKeywordModifiers: [{
        keyword: "opponentAbilityTargetTax",
        value: true,
        target: {
          controller: "self",
          line: "field",
          affinity: "hero"
        },
        condition: {
          allOf: [
            { turn: "opponent" },
            { line: LINES.FRONT }
          ]
        }
      }]
    },
    hero_target: {
      id: "hero_target",
      number: "DEM-1-119",
      sourceCode: "DEM",
      name: "Hero Target",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: ["hero"]
    }
  };
  const game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game.phase = PHASES.MAIN;
  game.activePlayer = "P1";
  game.players.P1.hand = [{ uid: "targeter-card", owner: "P1", defId: "targeter", faceUp: true }];
  game.players.P2.frontLine = [
    permanent("aura-source", "P2", "aura_source"),
    permanent("hero-target", "P2", "hero_target")
  ];

  assert.throws(() => applyAction(game, {
    type: "playCard",
    player: "P1",
    handIndex: 0,
    destination: LINES.FRONT,
    choices: {
      sidelineTarget: [{ playerId: "P2", lineName: LINES.FRONT, index: 1 }]
    }
  }), /Chosen target is not legal/);
});

test("chosen front and energy targets can swap and movement locks prevent normal movement", () => {
  const catalog = {
    ...sampleCatalog,
    swapper: {
      id: "swapper",
      number: "DEM-1-120",
      sourceCode: "DEM",
      name: "Swapper",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      abilities: [{
        id: "whenPlayed-1",
        timing: TIMINGS.WHEN_PLAYED,
        effect: {
          kind: "sequence",
          effects: [
            {
              kind: "restTargets",
              target: {
                controller: "opponent",
                line: LINES.FRONT,
                type: CARD_TYPES.CHARACTER,
                max: 1,
                choiceKey: "frontRestTarget"
              }
            },
            {
              kind: "restTargets",
              target: {
                controller: "opponent",
                line: LINES.ENERGY,
                type: CARD_TYPES.CHARACTER,
                max: 1,
                choiceKey: "energyRestTarget"
              }
            },
            {
              kind: "swapChosenTargets",
              firstTarget: {
                controller: "opponent",
                line: LINES.FRONT,
                type: CARD_TYPES.CHARACTER,
                max: 1,
                choiceKey: "frontRestTarget"
              },
              secondTarget: {
                controller: "opponent",
                line: LINES.ENERGY,
                type: CARD_TYPES.CHARACTER,
                max: 1,
                choiceKey: "energyRestTarget"
              }
            }
          ]
        }
      }]
    },
    front_target: {
      id: "front_target",
      number: "DEM-1-121",
      sourceCode: "DEM",
      name: "Front Target",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: []
    },
    energy_target: {
      id: "energy_target",
      number: "DEM-1-122",
      sourceCode: "DEM",
      name: "Energy Target",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: []
    }
  };
  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game.phase = PHASES.MAIN;
  game.activePlayer = "P1";
  game.players.P1.hand = [{ uid: "swapper-card", owner: "P1", defId: "swapper", faceUp: true }];
  game.players.P2.frontLine = [permanent("front-target", "P2", "front_target")];
  game.players.P2.energyLine = [permanent("energy-target", "P2", "energy_target")];

  game = applyAction(game, {
    type: "playCard",
    player: "P1",
    handIndex: 0,
    destination: LINES.FRONT,
    choices: {
      frontRestTarget: [{ playerId: "P2", lineName: LINES.FRONT, index: 0 }],
      energyRestTarget: [{ playerId: "P2", lineName: LINES.ENERGY, index: 0 }]
    }
  });

  assert.equal(topDefId(game.players.P2.frontLine[0]), "energy_target");
  assert.equal(topDefId(game.players.P2.energyLine[0]), "front_target");
  assert.equal(game.players.P2.frontLine[0].rested, true);
  assert.equal(game.players.P2.energyLine[0].rested, true);

  game.phase = PHASES.MOVEMENT;
  game.activePlayer = "P2";
  game.players.P2.energyLine[0].keywordModifiers.push({
    keyword: "cannotMove",
    value: true,
    expires: "endOfTurn"
  });
  assert.throws(() => applyAction(game, {
    type: "moveCharacters",
    player: "P2",
    moves: [{ from: LINES.ENERGY, to: LINES.FRONT, index: 0 }]
  }), /This character cannot move/);
});

test("static energy generation follows active and under-card conditions", () => {
  const catalog = {
    ...sampleCatalog,
    active_energy: {
      id: "active_energy",
      number: "DEM-1-088",
      sourceCode: "DEM",
      name: "Active Energy",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [],
      affinities: [],
      staticEnergyModifiers: [{ color: "green", amount: 1, condition: { active: true } }]
    },
    tucked_energy: {
      id: "tucked_energy",
      number: "DEM-1-089",
      sourceCode: "DEM",
      name: "Tucked Energy",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [],
      affinities: [],
      staticEnergyModifiers: [{ color: "green", amount: 2, condition: { hasFaceDownUnder: true } }]
    }
  };
  const game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  const activeSource = permanent("active-energy", "P1", "active_energy");
  const tuckedSource = permanent("tucked-energy", "P1", "tucked_energy");
  game.players.P1.energyLine.push(activeSource, tuckedSource);

  assert.deepEqual(internals.energyAvailable(game, "P1"), { green: 1 });

  activeSource.rested = true;
  tuckedSource.cards.unshift({ uid: "face-down-under", owner: "P1", defId: "demo_rookie", faceUp: false });

  assert.deepEqual(internals.energyAvailable(game, "P1"), { green: 2 });
});

test("empty-field hand reduction makes a 2-required-energy character usable as an opener", () => {
  const catalog = {
    ...sampleCatalog,
    empty_field_opener: {
      id: "empty_field_opener",
      number: "DEM-1-097",
      sourceCode: "DEM",
      name: "Empty Field Opener",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 2 },
      apCost: 1,
      bp: 2500,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      useCostModifiers: [{
        kind: "requiredEnergy",
        color: "green",
        amount: 2,
        sourceZone: "hand",
        condition: { emptyField: true }
      }]
    }
  };
  const game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });

  assert.equal(internals.requiredEnergyForCardUse(game, "P1", catalog.empty_field_opener), 0);
  assert.equal(internals.hasRequiredEnergy(game, "P1", catalog.empty_field_opener), true);

  game.players.P1.energyLine.push(permanent("existing-energy", "P1", "demo_rookie"));

  assert.equal(internals.requiredEnergyForCardUse(game, "P1", catalog.empty_field_opener), 2);
  assert.equal(internals.hasRequiredEnergy(game, "P1", catalog.empty_field_opener), false);
});

test("required-energy modifiers handle opponent colors, scaling, and field auras", () => {
  const catalog = {
    ...sampleCatalog,
    purple_marker: {
      id: "purple_marker",
      number: "DEM-1-090",
      sourceCode: "DEM",
      name: "Purple Marker",
      type: CARD_TYPES.CHARACTER,
      color: "purple",
      requiredEnergy: { color: "purple", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "purple", amount: 1 }],
      affinities: []
    },
    opponent_color_discount: {
      id: "opponent_color_discount",
      number: "DEM-1-091",
      sourceCode: "DEM",
      name: "Opponent Color Discount",
      type: CARD_TYPES.CHARACTER,
      color: "yellow",
      requiredEnergy: { color: "yellow", amount: 2 },
      apCost: 1,
      bp: 2500,
      energy: [{ color: "yellow", amount: 1 }],
      affinities: [],
      useCostModifiers: [{
        kind: "requiredEnergy",
        color: "yellow",
        amount: 1,
        sourceZone: "hand",
        condition: { opponentFieldAnyColor: ["purple", "green"] }
      }]
    },
    sideline_scaler: {
      id: "sideline_scaler",
      number: "DEM-1-092",
      sourceCode: "DEM",
      name: "Sideline Scaler",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 4 },
      apCost: 1,
      bp: 4000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      useCostModifiers: [{
        kind: "requiredEnergy",
        color: "green",
        amount: 1,
        sourceZone: "hand",
        amountPer: { kind: "zoneCountFloor", zone: "sideline", every: 5 }
      }]
    },
    aura_source: {
      id: "aura_source",
      number: "DEM-1-093",
      sourceCode: "DEM",
      name: "Aura Source",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      staticUseCostModifiers: [{
        kind: "requiredEnergy",
        amount: 1,
        sourceZone: "hand",
        filter: { name: "Aura Target" },
        condition: { turn: "controller", sourceLine: LINES.FRONT }
      }]
    },
    aura_target: {
      id: "aura_target",
      number: "DEM-1-094",
      sourceCode: "DEM",
      name: "Aura Target",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 3 },
      apCost: 1,
      bp: 3000,
      energy: [{ color: "green", amount: 1 }],
      affinities: []
    }
  };
  const game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });

  game.players.P2.frontLine.push(permanent("purple-marker", "P2", "purple_marker"));
  for (let index = 0; index < 10; index += 1) {
    game.players.P1.sideline.push({ uid: `sideline-${index}`, owner: "P1", defId: "demo_rookie", faceUp: true });
  }
  game.players.P1.frontLine.push(permanent("aura-source", "P1", "aura_source"));

  assert.equal(internals.requiredEnergyForCardUse(game, "P1", catalog.opponent_color_discount), 1);
  assert.equal(internals.requiredEnergyForCardUse(game, "P1", catalog.sideline_scaler), 2);
  assert.equal(internals.requiredEnergyForCardUse(game, "P1", catalog.aura_target), 2);

  game.activePlayer = "P2";
  assert.equal(internals.requiredEnergyForCardUse(game, "P1", catalog.aura_target), 3);
});

test("next-use required-energy reductions are consumed after matching card use", () => {
  const catalog = {
    ...sampleCatalog,
    reduced_target: {
      id: "reduced_target",
      number: "DEM-1-095",
      sourceCode: "DEM",
      name: "Reduced Target",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 3 },
      apCost: 0,
      bp: 3000,
      energy: [{ color: "green", amount: 1 }],
      affinities: []
    }
  };
  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game = mainPhase(game);
  game.players.P1.energyLine.push(permanent("single-energy", "P1", "demo_rookie"));
  game.players.P1.hand.unshift({ uid: "reduced-target-ref", owner: "P1", defId: "reduced_target", faceUp: true });
  game.continuousEffects.push({
    kind: "requiredEnergyReduction",
    controller: "P1",
    amount: 2,
    sourceZone: "hand",
    filter: { name: "Reduced Target" },
    consumeOnUse: true,
    expires: "endOfTurn"
  });

  assert.equal(internals.requiredEnergyForCardUse(game, "P1", catalog.reduced_target), 1);
  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0, destination: LINES.FRONT });
  assert.equal(game.continuousEffects.some((effect) => effect.kind === "requiredEnergyReduction"), false);
});

test("use restrictions affect legal actions and pay additional use costs", () => {
  const catalog = {
    ...sampleCatalog,
    restricted_event: {
      id: "restricted_event",
      number: "DEM-1-096",
      sourceCode: "DEM",
      name: "Restricted Event",
      type: CARD_TYPES.EVENT,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      affinities: [],
      eventEffect: {
        kind: "replacementOrUseRestriction",
        useRestrictions: [{
          kind: "condition",
          condition: { lifeMin: 1 },
          costAlternatives: [{ kind: "lifeToSideline", amount: 1 }]
        }]
      }
    }
  };
  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game = mainPhase(game);
  game.players.P1.hand.unshift({ uid: "restricted-event-ref", owner: "P1", defId: "restricted_event", faceUp: true });

  assert.ok(legalActions(game, "P1").some((action) => action.type === "playCard" && action.handIndex === 0));
  const lifeBefore = game.players.P1.life.length;
  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0, destination: LINES.FRONT });
  assert.equal(game.players.P1.life.length, lifeBefore - 1);
});

test("opponent ability protection blocks automatic and explicit target choices", () => {
  const catalog = {
    ...sampleCatalog,
    protected_target: {
      ...sampleCatalog.demo_rookie,
      id: "protected_target",
      number: "DEM-1-097",
      name: "Protected Target",
      keywords: { opponentAbilityProtection: true }
    },
    target_event: {
      id: "target_event",
      number: "DEM-1-098",
      sourceCode: "DEM",
      name: "Target Event",
      type: CARD_TYPES.EVENT,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      affinities: [],
      eventEffect: {
        kind: "sidelineTargets",
        target: { controller: "opponent", line: LINES.FRONT, type: CARD_TYPES.CHARACTER, max: 1 }
      }
    }
  };

  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game = mainPhase(game);
  game.players.P1.hand.unshift({ uid: "target-event-ref", owner: "P1", defId: "target_event", faceUp: true });
  game.players.P2.frontLine = [
    permanent("protected-target", "P2", "protected_target"),
    permanent("open-target", "P2", "demo_rookie")
  ];

  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0, destination: LINES.FRONT });
  assert.equal(game.players.P2.frontLine.length, 1);
  assert.equal(game.players.P2.frontLine[0].cards[0].defId, "protected_target");

  let explicitGame = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  explicitGame = mainPhase(explicitGame);
  explicitGame.players.P1.hand.unshift({ uid: "target-event-ref-2", owner: "P1", defId: "target_event", faceUp: true });
  explicitGame.players.P2.frontLine = [
    permanent("protected-target-2", "P2", "protected_target"),
    permanent("open-target-2", "P2", "demo_rookie")
  ];

  assert.throws(() => applyAction(explicitGame, {
    type: "playCard",
    player: "P1",
    handIndex: 0,
    choices: {
      targets: [{ player: "P2", line: LINES.FRONT, index: 0 }]
    }
  }), /not legal/i);
});

test("returned-to-hand triggered reducers apply during the controller turn", () => {
  const catalog = {
    ...sampleCatalog,
    return_source: {
      id: "return_source",
      number: "DEM-1-097",
      sourceCode: "DEM",
      name: "Return Source",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      abilities: [{
        id: "returned-reducer",
        timing: TIMINGS.WHEN_RETURNED_TO_HAND,
        effect: {
          kind: "reduceRequiredEnergy",
          amount: 2,
          sourceZone: "hand",
          filter: { name: "Returned Target" },
          consumeOnUse: true,
          expires: "endOfTurn"
        }
      }]
    },
    returned_target: {
      id: "returned_target",
      number: "DEM-1-098",
      sourceCode: "DEM",
      name: "Returned Target",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 3 },
      apCost: 0,
      bp: 3000,
      energy: [{ color: "green", amount: 1 }],
      affinities: []
    },
    return_event: {
      id: "return_event",
      number: "DEM-1-099",
      sourceCode: "DEM",
      name: "Return Event",
      type: CARD_TYPES.EVENT,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      affinities: [],
      eventEffect: {
        kind: "returnTargetsToHand",
        target: { controller: "self", line: LINES.FRONT, type: CARD_TYPES.CHARACTER, max: 1 }
      }
    }
  };
  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game = mainPhase(game);
  game.players.P1.frontLine.push(permanent("return-source", "P1", "return_source"));
  game.players.P1.hand.unshift({ uid: "return-event-ref", owner: "P1", defId: "return_event", faceUp: true });

  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0 });
  assert.equal(internals.requiredEnergyForCardUse(game, "P1", catalog.returned_target), 1);
});

test("turn advancement gives player two two AP on their first turn", () => {
  let game = makeGame();
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });

  assert.equal(game.activePlayer, "P2");
  assert.equal(game.phase, PHASES.START);
  assert.equal(game.players.P2.apCards.length, 2);
});

test("Step allows movement from front line to energy line", () => {
  let game = makeGame();
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, {
    type: "playCard",
    player: "P1",
    handIndex: 4,
    destination: LINES.FRONT
  });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P2" });
  game = applyAction(game, { type: "advancePhase", player: "P2" });
  game = applyAction(game, { type: "advancePhase", player: "P2" });
  game = applyAction(game, { type: "advancePhase", player: "P2" });
  game = applyAction(game, { type: "advancePhase", player: "P2" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });

  assert.equal(game.activePlayer, "P1");
  assert.equal(game.phase, PHASES.MOVEMENT);
  game = applyAction(game, {
    type: "moveCharacters",
    player: "P1",
    moves: [{ from: LINES.FRONT, index: 0, to: LINES.ENERGY }]
  });

  assert.equal(game.players.P1.frontLine.length, 0);
  assert.equal(game.players.P1.energyLine.length, 1);
});

test("legal actions expose normal energy-to-front movement", () => {
  let game = makeGame();
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, {
    type: "playCard",
    player: "P1",
    handIndex: 0,
    destination: LINES.ENERGY
  });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P2" });
  game = applyAction(game, { type: "advancePhase", player: "P2" });
  game = applyAction(game, { type: "advancePhase", player: "P2" });
  game = applyAction(game, { type: "advancePhase", player: "P2" });
  game = applyAction(game, { type: "advancePhase", player: "P2" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });

  const move = legalActions(game, "P1").find((action) => {
    return action.type === "moveCharacters"
      && action.moves[0].from === LINES.ENERGY
      && action.moves[0].to === LINES.FRONT;
  });

  assert.ok(move);
  game = applyAction(game, move);
  assert.equal(game.players.P1.energyLine.length, 0);
  assert.equal(game.players.P1.frontLine.length, 1);
});

test("movement is selected once and can move characters in both directions simultaneously", () => {
  let game = makeGame();
  game.phase = PHASES.MOVEMENT;
  game.activePlayer = "P1";
  game.players.P1.frontLine = [permanent("movement-step", "P1", "demo_stepper")];
  game.players.P1.energyLine = [permanent("movement-forward", "P1", "demo_rookie")];

  const simultaneous = legalActions(game, "P1").find((action) => (
    action.type === "moveCharacters"
    && action.moves.length === 2
    && action.moves.some((move) => move.from === LINES.FRONT && move.to === LINES.ENERGY)
    && action.moves.some((move) => move.from === LINES.ENERGY && move.to === LINES.FRONT)
  ));
  assert.ok(simultaneous);

  game = applyAction(game, simultaneous);
  assert.equal(topDefId(game.players.P1.frontLine[0]), "demo_rookie");
  assert.equal(topDefId(game.players.P1.energyLine[0]), "demo_stepper");
  assert.equal(legalActions(game, "P1").some((action) => action.type === "moveCharacters"), false);
  assert.throws(() => applyAction(game, simultaneous), /only be moved once during a movement phase/i);
});

test("simultaneous movement exposes destination-line overflow removals", () => {
  let game = makeGame();
  game.phase = PHASES.MOVEMENT;
  game.activePlayer = "P1";
  game.players.P1.frontLine = Array.from({ length: MAX_LINE_SIZE }, (_, index) => (
    permanent(`movement-full-${index}`, "P1", "demo_guardian")
  ));
  game.players.P1.energyLine = [permanent("movement-overflow-forward", "P1", "demo_rookie")];

  const movementActions = legalActions(game, "P1").filter((action) => action.type === "moveCharacters");
  assert.equal(movementActions.length, MAX_LINE_SIZE);
  assert.ok(movementActions.every((action) => action.movementReplacements?.length === 1));

  game = applyAction(game, movementActions[2]);
  assert.equal(game.players.P1.frontLine.length, MAX_LINE_SIZE);
  assert.equal(game.players.P1.energyLine.length, 0);
  assert.equal(game.players.P1.removal.length, 1);
  assert.equal(topDefId(game.players.P1.frontLine.at(-1)), "demo_rookie");
});

test("direct attack deals damage and resolves get trigger into hand", () => {
  const catalog = sampleCatalog;
  const deck = [
    "demo_rookie",
    "demo_rookie",
    "demo_rookie",
    "demo_rookie",
    "demo_stepper",
    "demo_stepper",
    "demo_stepper",
    "demo_get_trigger",
    "demo_extra",
    "demo_extra",
    "demo_extra",
    "demo_extra",
    "demo_extra",
    "demo_extra",
    ...sampleDeckList.flatMap((entry) => Array(entry.count).fill(entry.id)).slice(0, 36)
  ];

  let game = createGame({
    catalog,
    decks: { P1: deck, P2: deck },
    skipShuffle: true,
    validateDecks: false
  });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0, destination: LINES.FRONT });
  game.players.P1.frontLine[0].rested = false;
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, {
    type: "declareAttack",
    player: "P1",
    attackerIndex: 0,
    target: { type: "player" }
  });
  const p2HandBefore = game.players.P2.hand.length;
  game = applyAction(game, { type: "declineBlock", player: "P2", lifeIndices: [0] });

  assert.equal(game.players.P2.life.length, 6);
  assert.equal(game.players.P2.hand.length, p2HandBefore + 1);
});

test("unblocked attack timing abilities resolve after direct damage", () => {
  const catalog = {
    ...sampleCatalog,
    private_unblocked_draw: {
      ...sampleCatalog.demo_rookie,
      id: "private_unblocked_draw",
      number: "DEM-1-100",
      name: "Private Unblocked Draw",
      abilities: [
        {
          id: "unblocked-draw",
          timing: TIMINGS.WHEN_ATTACK_UNBLOCKED,
          effect: { kind: "draw", amount: 1 }
        }
      ]
    }
  };

  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game.phase = PHASES.ATTACK;
  game.activePlayer = "P1";
  game.players.P1.frontLine = [permanent("unblocked-attacker", "P1", "private_unblocked_draw")];
  game.players.P1.deck.unshift({ uid: "unblocked-draw-card", owner: "P1", defId: "demo_extra", faceUp: true });
  game.players.P2.life = Array.from({ length: 7 }, (_, index) => ({
    uid: `unblocked-life-${index}`,
    owner: "P2",
    defId: "demo_extra",
    faceUp: true
  }));

  const p1HandBefore = game.players.P1.hand.length;
  game = applyAction(game, { type: "declareAttack", player: "P1", attackerIndex: 0, target: { type: "player" } });
  game = applyAction(game, { type: "declineBlock", player: "P2", lifeIndices: [0] });

  assert.equal(game.players.P2.life.length, 6);
  assert.equal(game.players.P1.hand.length, p1HandBefore + 1);
});

test("no-trigger life-to-sideline defensive abilities see the moved life card", () => {
  const catalog = {
    ...sampleCatalog,
    private_life_site: {
      ...sampleCatalog.demo_site,
      id: "private_life_site",
      number: "DEM-1-103",
      name: "Private Life Site",
      abilities: [
        {
          id: "life-card-to-hand",
          timing: TIMINGS.WHEN_LIFE_TO_SIDELINE_NO_TRIGGER,
          conditions: { turn: "opponent" },
          effect: {
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
          }
        }
      ]
    }
  };

  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game.phase = PHASES.ATTACK;
  game.activePlayer = "P1";
  game.players.P1.frontLine = [permanent("life-attacker", "P1", "demo_rookie")];
  game.players.P2.energyLine = [permanent("life-site", "P2", "private_life_site")];
  game.players.P2.life = Array.from({ length: 7 }, (_, index) => ({
    uid: `life-no-trigger-${index}`,
    owner: "P2",
    defId: "demo_extra",
    faceUp: true
  }));

  const p2HandBefore = game.players.P2.hand.length;
  game = applyAction(game, { type: "declareAttack", player: "P1", attackerIndex: 0, target: { type: "player" } });
  game = applyAction(game, { type: "declineBlock", player: "P2", lifeIndices: [0] });

  assert.equal(game.players.P2.energyLine[0].rested, true);
  assert.equal(game.players.P2.hand.length, p2HandBefore + 1);
  assert.equal(game.players.P2.hand.at(-1).uid, "life-no-trigger-0");
  assert.equal(game.players.P2.sideline.some((card) => card.uid === "life-no-trigger-0"), false);
});

test("deck-to-sideline zone triggers resolve from the sideline", () => {
  const catalog = {
    ...sampleCatalog,
    private_milled_trigger: {
      ...sampleCatalog.demo_rookie,
      id: "private_milled_trigger",
      number: "DEM-1-103",
      name: "Private Milled Trigger",
      abilities: [
        {
          id: "milled-draw",
          timing: TIMINGS.WHEN_SELF_DECK_TO_SIDELINE_BY_ABILITY,
          conditions: { zone: "sideline" },
          effect: { kind: "draw", amount: 1 }
        }
      ]
    },
    private_mill_event: {
      id: "private_mill_event",
      number: "DEM-1-104",
      sourceCode: "DEM",
      name: "Private Mill Event",
      type: CARD_TYPES.EVENT,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      affinities: [],
      eventEffect: { kind: "moveTopDeck", count: 1, destination: "sideline" }
    }
  };

  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game = mainPhase(game);
  game.players.P1.hand.unshift({ uid: "mill-event-ref", owner: "P1", defId: "private_mill_event", faceUp: true });
  game.players.P1.deck.unshift(
    { uid: "milled-trigger-ref", owner: "P1", defId: "private_milled_trigger", faceUp: true },
    { uid: "milled-draw-ref", owner: "P1", defId: "demo_extra", faceUp: true }
  );

  const handBefore = game.players.P1.hand.length;
  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0 });

  assert.equal(game.players.P1.hand.length, handBefore);
  assert.ok(game.players.P1.sideline.some((card) => card.uid === "milled-trigger-ref"));
  assert.ok(game.players.P1.hand.some((card) => card.uid === "milled-draw-ref"));
});

test("deck-to-sideline triggers can perform Raid from sideline", () => {
  const catalog = {
    ...sampleCatalog,
    private_raid_base: {
      ...sampleCatalog.demo_rookie,
      id: "private_raid_base",
      number: "DEM-1-105",
      name: "Private Raid Base"
    },
    private_milled_raid: {
      ...sampleCatalog.demo_guardian,
      id: "private_milled_raid",
      number: "DEM-1-106",
      name: "Private Milled Raid",
      requiredEnergy: { color: "green", amount: 0 },
      raid: { names: ["Private Raid Base"], affinities: [] },
      abilities: [
        {
          id: "milled-raid",
          timing: TIMINGS.WHEN_SELF_DECK_TO_SIDELINE_BY_ABILITY,
          conditions: { zone: "sideline" },
          effect: { kind: "raidSourceFromZone", source: "sideline" }
        }
      ]
    },
    private_mill_event: {
      id: "private_mill_event",
      number: "DEM-1-107",
      sourceCode: "DEM",
      name: "Private Mill Event",
      type: CARD_TYPES.EVENT,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      affinities: [],
      eventEffect: { kind: "moveTopDeck", count: 1, destination: "sideline" }
    }
  };

  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game = mainPhase(game);
  game.players.P1.hand.unshift({ uid: "mill-raid-event-ref", owner: "P1", defId: "private_mill_event", faceUp: true });
  game.players.P1.deck.unshift({ uid: "milled-raid-ref", owner: "P1", defId: "private_milled_raid", faceUp: true });
  game.players.P1.energyLine = [permanent("raid-base", "P1", "private_raid_base", { rested: true })];

  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0 });

  assert.equal(game.players.P1.energyLine.length, 0);
  assert.equal(game.players.P1.frontLine.length, 1);
  assert.deepEqual(game.players.P1.frontLine[0].cards.map((card) => card.defId), ["private_raid_base", "private_milled_raid"]);
  assert.equal(game.players.P1.frontLine[0].rested, false);
});

test("battle win timing abilities resolve when the attacker wins combat", () => {
  const catalog = {
    ...sampleCatalog,
    private_battle_winner: {
      ...sampleCatalog.demo_guardian,
      id: "private_battle_winner",
      number: "DEM-1-101",
      name: "Private Battle Winner",
      abilities: [
        {
          id: "win-draw",
          timing: TIMINGS.WHEN_ATTACK_WINS_BATTLE,
          effect: { kind: "draw", amount: 1 }
        }
      ]
    }
  };

  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game.phase = PHASES.ATTACK;
  game.activePlayer = "P1";
  game.players.P1.frontLine = [permanent("battle-attacker", "P1", "private_battle_winner")];
  game.players.P1.deck.unshift({ uid: "battle-draw-card", owner: "P1", defId: "demo_extra", faceUp: true });
  game.players.P2.frontLine = [permanent("battle-blocker", "P2", "demo_extra")];

  const p1HandBefore = game.players.P1.hand.length;
  game = applyAction(game, { type: "declareAttack", player: "P1", attackerIndex: 0, target: { type: "player" } });
  game = applyAction(game, { type: "declareBlock", player: "P2", blockerIndex: 0 });

  assert.equal(game.players.P2.frontLine.length, 0);
  assert.equal(game.players.P2.sideline.at(-1).defId, "demo_extra");
  assert.equal(game.players.P1.hand.length, p1HandBefore + 1);
});

test("field-wide battle win timing abilities resolve from support permanents", () => {
  const catalog = {
    ...sampleCatalog,
    private_arena: {
      ...sampleCatalog.demo_site,
      id: "private_arena",
      number: "DEM-1-102",
      name: "Private Arena",
      abilities: [
        {
          id: "field-win-draw",
          timing: TIMINGS.WHEN_OWN_CHARACTER_ATTACK_WINS_BATTLE,
          oncePerTurn: true,
          effect: { kind: "draw", amount: 1 }
        }
      ]
    }
  };

  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game.phase = PHASES.ATTACK;
  game.activePlayer = "P1";
  game.players.P1.frontLine = [permanent("arena-attacker", "P1", "demo_guardian")];
  game.players.P1.energyLine = [permanent("arena-support", "P1", "private_arena")];
  game.players.P1.deck.unshift({ uid: "arena-draw-card", owner: "P1", defId: "demo_extra", faceUp: true });
  game.players.P2.frontLine = [permanent("arena-blocker", "P2", "demo_extra")];

  const p1HandBefore = game.players.P1.hand.length;
  game = applyAction(game, { type: "declareAttack", player: "P1", attackerIndex: 0, target: { type: "player" } });
  game = applyAction(game, { type: "declareBlock", player: "P2", blockerIndex: 0 });

  assert.equal(game.players.P2.frontLine.length, 0);
  assert.equal(game.players.P1.hand.length, p1HandBefore + 1);
  assert.deepEqual(game.players.P1.energyLine[0].usedOncePerTurn, ["field-win-draw"]);
});

test("field attack timing abilities can react to a matching attacker", () => {
  const catalog = {
    ...sampleCatalog,
    private_attack_support: {
      ...sampleCatalog.demo_site,
      id: "private_attack_support",
      number: "DEM-1-104",
      name: "Private Attack Support",
      abilities: [
        {
          id: "mahito-attack-draw",
          timing: TIMINGS.WHEN_OWN_CHARACTER_ATTACKS,
          oncePerTurn: true,
          conditions: { attackingCharacter: { name: "Demo Rookie" } },
          effect: { kind: "draw", amount: 1 }
        }
      ]
    }
  };

  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game.phase = PHASES.ATTACK;
  game.activePlayer = "P1";
  game.players.P1.frontLine = [permanent("matching-attacker", "P1", "demo_rookie")];
  game.players.P1.energyLine = [permanent("attack-support", "P1", "private_attack_support")];
  game.players.P1.deck.unshift({ uid: "attack-support-draw", owner: "P1", defId: "demo_extra", faceUp: true });

  const p1HandBefore = game.players.P1.hand.length;
  game = applyAction(game, { type: "declareAttack", player: "P1", attackerIndex: 0, target: { type: "player" } });

  assert.equal(game.players.P1.hand.length, p1HandBefore + 1);
  assert.deepEqual(game.players.P1.energyLine[0].usedOncePerTurn, ["mahito-attack-draw"]);
});

test("attack ends cleanly when the attacker leaves during attack triggers", () => {
  const catalog = {
    ...sampleCatalog,
    private_departing_attacker: {
      ...sampleCatalog.demo_rookie,
      id: "private_departing_attacker",
      number: "DEM-1-107",
      name: "Private Departing Attacker",
      abilities: [
        {
          id: "attack-sideline-self",
          timing: TIMINGS.WHEN_ATTACKING,
          effect: { kind: "moveSelfCardToZone", destination: "sideline" }
        }
      ]
    }
  };

  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game.phase = PHASES.ATTACK;
  game.activePlayer = "P1";
  game.players.P1.frontLine = [permanent("departing-attacker", "P1", "private_departing_attacker")];

  game = applyAction(game, { type: "declareAttack", player: "P1", attackerIndex: 0, target: { type: "player" } });

  assert.equal(game.pendingAttack, null);
  assert.equal(game.players.P1.frontLine.length, 0);
  assert.equal(game.players.P1.sideline.at(-1).defId, "private_departing_attacker");
  assert.deepEqual(legalActions(game, "P2"), []);
});

test("blocked attack ends cleanly when a battling character leaves before battle", () => {
  const catalog = {
    ...sampleCatalog,
    private_departing_blocker: {
      ...sampleCatalog.demo_guardian,
      id: "private_departing_blocker",
      number: "DEM-1-108",
      name: "Private Departing Blocker",
      abilities: [
        {
          id: "block-sideline-self",
          timing: TIMINGS.WHEN_BLOCKING,
          effect: { kind: "moveSelfCardToZone", destination: "sideline" }
        }
      ]
    }
  };

  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game.phase = PHASES.ATTACK;
  game.activePlayer = "P1";
  game.players.P1.frontLine = [permanent("blocked-attacker", "P1", "demo_rookie")];
  game.players.P2.frontLine = [permanent("departing-blocker", "P2", "private_departing_blocker")];
  game.players.P2.life = Array.from({ length: 7 }, (_, index) => ({
    uid: `departing-blocker-life-${index}`,
    owner: "P2",
    defId: "demo_extra",
    faceUp: false
  }));

  game = applyAction(game, { type: "declareAttack", player: "P1", attackerIndex: 0, target: { type: "player" } });
  game = applyAction(game, { type: "declareBlock", player: "P2", blockerIndex: 0 });

  assert.equal(game.pendingAttack, null);
  assert.equal(game.players.P1.frontLine.length, 1);
  assert.equal(game.players.P2.frontLine.length, 0);
  assert.equal(game.players.P2.life.length, 7);
  assert.equal(game.players.P2.sideline.at(-1).defId, "private_departing_blocker");
});

test("stale pending attacks are cleaned up during defender responses", () => {
  let game = createGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game.phase = PHASES.ATTACK;
  game.activePlayer = "P1";
  game.pendingAttack = {
    attackerPlayer: "P1",
    defenderPlayer: "P2",
    attackerPermanentId: "missing-attacker"
  };
  game.players.P1.frontLine = [];
  game.players.P2.frontLine = [permanent("stale-blocker", "P2", "demo_guardian")];

  game = applyAction(game, { type: "declineBlock", player: "P2" });

  assert.equal(game.pendingAttack, null);
  assert.equal(game.players.P2.life.length, 7);
});

test("attack phase timing abilities fire at phase and attack boundaries", () => {
  const catalog = {
    ...sampleCatalog,
    private_phase_support: {
      ...sampleCatalog.demo_rookie,
      id: "private_phase_support",
      number: "DEM-1-105",
      name: "Private Phase Support",
      abilities: [
        {
          id: "start-ready-ap",
          timing: TIMINGS.START_OF_ATTACK_PHASE,
          conditions: { turn: "controller", line: LINES.FRONT, active: true },
          effect: { kind: "readyAp", amount: 1 }
        },
        {
          id: "end-sideline-self",
          timing: TIMINGS.END_OF_ATTACK_PHASE,
          conditions: { turn: "controller", line: LINES.FRONT, active: true },
          effect: { kind: "moveSelfCardToZone", destination: "sideline" }
        }
      ]
    },
    private_restanding_attacker: {
      ...sampleCatalog.demo_rookie,
      id: "private_restanding_attacker",
      number: "DEM-1-106",
      name: "Private Restanding Attacker",
      abilities: [
        {
          id: "end-attack-ready",
          timing: TIMINGS.END_OF_ATTACK,
          effect: {
            kind: "optional",
            choiceKey: "optionalPayAp",
            default: true,
            effect: {
              kind: "sequence",
              effects: [
                { kind: "payAp", amount: 1 },
                { kind: "readySelf" }
              ]
            }
          }
        }
      ]
    }
  };

  let phaseGame = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  phaseGame.phase = PHASES.MAIN;
  phaseGame.activePlayer = "P1";
  phaseGame.players.P1.apCards[0].rested = true;
  phaseGame.players.P1.frontLine = [permanent("phase-support", "P1", "private_phase_support")];

  phaseGame = applyAction(phaseGame, { type: "advancePhase", player: "P1" });
  assert.equal(phaseGame.phase, PHASES.ATTACK);
  assert.equal(phaseGame.players.P1.apCards[0].rested, false);

  phaseGame = applyAction(phaseGame, { type: "advancePhase", player: "P1" });
  assert.equal(phaseGame.phase, PHASES.END);
  assert.equal(phaseGame.players.P1.frontLine.length, 0);
  assert.equal(phaseGame.players.P1.sideline.at(-1).defId, "private_phase_support");

  let attackGame = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  attackGame.phase = PHASES.ATTACK;
  attackGame.activePlayer = "P1";
  attackGame.players.P1.frontLine = [permanent("restanding-attacker", "P1", "private_restanding_attacker")];

  attackGame = applyAction(attackGame, { type: "declareAttack", player: "P1", attackerIndex: 0, target: { type: "player" } });
  assert.equal(attackGame.players.P1.frontLine[0].rested, true);
  attackGame = applyAction(attackGame, { type: "declineBlock", player: "P2" });
  assert.equal(attackGame.players.P1.frontLine[0].rested, false);
  assert.equal(attackGame.players.P1.apCards[0].rested, true);
});

test("granted timing abilities trigger at their granted timing", () => {
  const catalog = {
    ...sampleCatalog,
    grant_target: {
      ...sampleCatalog.demo_rookie,
      id: "grant_target",
      number: "DEM-1-120",
      name: "Grant Target",
      abilities: []
    },
    grant_draw_event: {
      id: "grant_draw_event",
      number: "DEM-1-121",
      sourceCode: "DEM",
      name: "Grant Draw Event",
      type: CARD_TYPES.EVENT,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      energy: [],
      affinities: [],
      keywords: {},
      eventEffect: {
        kind: "grantAbility",
        duration: "turn",
        target: { controller: "self", line: LINES.FRONT, type: CARD_TYPES.CHARACTER, max: 1 },
        ability: {
          id: "granted-draw",
          timing: TIMINGS.WHEN_ATTACKING,
          effect: { kind: "draw", amount: 1 }
        }
      }
    }
  };

  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game.phase = PHASES.MAIN;
  game.activePlayer = "P1";
  game.players.P1.frontLine = [permanent("grant-target", "P1", "grant_target")];
  game.players.P1.hand = [{ uid: "grant-event-card", owner: "P1", defId: "grant_draw_event", faceUp: true }];
  game.players.P1.deck.unshift({ uid: "grant-draw-card", owner: "P1", defId: "demo_extra", faceUp: true });

  const deckBeforeEvent = game.players.P1.deck.length;
  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0 });
  assert.equal(game.players.P1.deck.length, deckBeforeEvent);
  assert.equal(game.players.P1.frontLine[0].gainedAbilities.length, 1);

  game.phase = PHASES.ATTACK;
  const handBeforeAttack = game.players.P1.hand.length;
  game = applyAction(game, { type: "declareAttack", player: "P1", attackerIndex: 0, target: { type: "player" } });
  assert.equal(game.players.P1.hand.length, handBeforeAttack + 1);
});

test("raided permanents can inherit selected base-card abilities", () => {
  const catalog = {
    ...sampleCatalog,
    base_drawer: {
      ...sampleCatalog.demo_rookie,
      id: "base_drawer",
      number: "DEM-1-122",
      name: "Base Drawer",
      abilities: [
        {
          id: "base-attack-draw",
          timing: TIMINGS.WHEN_ATTACKING,
          effect: { kind: "draw", amount: 1 }
        }
      ]
    },
    raid_inheritor: {
      ...sampleCatalog.demo_raider,
      id: "raid_inheritor",
      number: "DEM-1-123",
      name: "Raid Inheritor",
      gainsBaseAbilityTimings: [TIMINGS.WHEN_ATTACKING],
      abilities: []
    }
  };

  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game.phase = PHASES.ATTACK;
  game.activePlayer = "P1";
  const raided = permanent("raid-inheritor", "P1", "raid_inheritor");
  raided.cards = [
    { uid: "base-drawer-card", owner: "P1", defId: "base_drawer", faceUp: true },
    { uid: "raid-inheritor-card", owner: "P1", defId: "raid_inheritor", faceUp: true }
  ];
  game.players.P1.frontLine = [raided];
  game.players.P1.deck.unshift({ uid: "base-attack-draw-card", owner: "P1", defId: "demo_extra", faceUp: true });

  const handBefore = game.players.P1.hand.length;
  game = applyAction(game, { type: "declareAttack", player: "P1", attackerIndex: 0, target: { type: "player" } });
  assert.equal(game.players.P1.hand.length, handBefore + 1);
});

test("last-played delayed cleanup can return multiple played characters at attack phase end", () => {
  const catalog = {
    ...sampleCatalog,
    return_play_event: {
      id: "return_play_event",
      number: "DEM-1-124",
      sourceCode: "DEM",
      name: "Return Play Event",
      type: CARD_TYPES.EVENT,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      energy: [],
      affinities: [],
      keywords: {},
      eventEffect: {
        kind: "sequence",
        effects: [
          {
            kind: "playCardFromZone",
            zone: "hand",
            count: 2,
            rested: false,
            destinationLine: LINES.FRONT,
            filter: { type: CARD_TYPES.CHARACTER }
          },
          {
            kind: "scheduleLastPlayedPermanentToZone",
            timing: TIMINGS.END_OF_ATTACK_PHASE,
            zone: "hand",
            sidelined: false
          }
        ]
      }
    }
  };

  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game.phase = PHASES.MAIN;
  game.activePlayer = "P1";
  game.players.P1.hand = [
    { uid: "return-event-card", owner: "P1", defId: "return_play_event", faceUp: true },
    { uid: "return-play-one", owner: "P1", defId: "demo_rookie", faceUp: true },
    { uid: "return-play-two", owner: "P1", defId: "demo_extra", faceUp: true }
  ];

  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0 });
  assert.equal(game.players.P1.frontLine.length, 2);
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  assert.equal(game.phase, PHASES.END);
  assert.equal(game.players.P1.frontLine.length, 0);
  assert.equal(game.players.P1.hand.length, 2);
});

test("blocking delayed returns resolve at the end of that attack", () => {
  const catalog = {
    ...sampleCatalog,
    private_block_returner: {
      ...sampleCatalog.demo_guardian,
      id: "private_block_returner",
      number: "DEM-1-125",
      name: "Private Block Returner",
      bp: 10000,
      abilities: [
        {
          id: "block-return",
          timing: TIMINGS.WHEN_BLOCKING,
          effect: {
            kind: "scheduleReturnTargetsToHand",
            timing: TIMINGS.END_OF_ATTACK,
            target: "self"
          }
        }
      ]
    }
  };

  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game.phase = PHASES.ATTACK;
  game.activePlayer = "P1";
  game.players.P1.frontLine = [permanent("small-attacker", "P1", "demo_rookie")];
  game.players.P2.frontLine = [permanent("block-returner", "P2", "private_block_returner")];

  game = applyAction(game, { type: "declareAttack", player: "P1", attackerIndex: 0, target: { type: "player" } });
  game = applyAction(game, { type: "declareBlock", player: "P2", blockerIndex: 0 });

  assert.equal(game.players.P2.frontLine.length, 0);
  assert.equal(game.players.P2.hand.at(-1).defId, "private_block_returner");
});

test("target-sidelined effect watchers resolve when the watched permanent is sidelined", () => {
  const catalog = {
    ...sampleCatalog,
    watcher_source: {
      ...sampleCatalog.demo_rookie,
      id: "watcher_source",
      number: "DEM-1-126",
      name: "Watcher Source",
      abilities: [
        {
          id: "watch-draw",
          timing: TIMINGS.WHEN_PLAYED,
          effect: {
            kind: "watchTargetSidelinedForEffect",
            target: { controller: "opponent", line: LINES.FRONT, type: CARD_TYPES.CHARACTER, max: 1 },
            effect: { kind: "draw", amount: 2 }
          }
        },
        {
          id: "blast",
          timing: TIMINGS.ACTIVATE_MAIN,
          effect: {
            kind: "sidelineTargets",
            target: { controller: "opponent", line: LINES.FRONT, type: CARD_TYPES.CHARACTER, max: 1 }
          }
        }
      ]
    }
  };

  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game.phase = PHASES.MAIN;
  game.activePlayer = "P1";
  game.players.P1.hand = [{ uid: "watcher-card", owner: "P1", defId: "watcher_source", faceUp: true }];
  game.players.P1.deck.unshift(
    { uid: "watch-draw-one", owner: "P1", defId: "demo_extra", faceUp: true },
    { uid: "watch-draw-two", owner: "P1", defId: "demo_extra", faceUp: true }
  );
  game.players.P2.frontLine = [permanent("watched-target", "P2", "demo_guardian")];

  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0, destination: LINES.FRONT });
  const handBeforeSideline = game.players.P1.hand.length;
  game = applyAction(game, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: "blast"
  });

  assert.equal(game.players.P2.frontLine.length, 0);
  assert.equal(game.players.P1.hand.length, handBeforeSideline + 2);
});

test("target-conditional effects apply the branch matching the chosen target state", () => {
  const catalog = {
    ...sampleCatalog,
    conditional_returner: {
      ...sampleCatalog.demo_rookie,
      id: "conditional_returner",
      number: "DEM-1-127",
      name: "Conditional Returner",
      abilities: [
        {
          id: "return-or-sideline",
          timing: TIMINGS.ACTIVATE_MAIN,
          effect: {
            kind: "targetConditional",
            target: { controller: "opponent", line: LINES.FRONT, type: CARD_TYPES.CHARACTER, max: 1 },
            condition: { rested: true },
            effect: { kind: "sidelineTargets" },
            elseEffect: { kind: "returnTargetsToHand" }
          }
        }
      ]
    }
  };

  let activeGame = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  activeGame.phase = PHASES.MAIN;
  activeGame.activePlayer = "P1";
  activeGame.players.P1.frontLine = [permanent("conditional-source", "P1", "conditional_returner")];
  activeGame.players.P2.frontLine = [permanent("active-target", "P2", "demo_guardian")];
  activeGame = applyAction(activeGame, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: "return-or-sideline"
  });
  assert.equal(activeGame.players.P2.hand.at(-1).defId, "demo_guardian");
  assert.equal(activeGame.players.P2.sideline.length, 0);

  let restedGame = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  restedGame.phase = PHASES.MAIN;
  restedGame.activePlayer = "P1";
  restedGame.players.P1.frontLine = [permanent("conditional-source-2", "P1", "conditional_returner")];
  restedGame.players.P2.frontLine = [permanent("rested-target", "P2", "demo_guardian", { rested: true })];
  restedGame = applyAction(restedGame, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: "return-or-sideline"
  });
  assert.equal(restedGame.players.P2.sideline.at(-1).defId, "demo_guardian");
});

test("raid-stack return replacement can return base cards to hand", () => {
  const catalog = {
    ...sampleCatalog,
    stack_returner: {
      ...sampleCatalog.demo_raider,
      id: "stack_returner",
      number: "DEM-1-128",
      name: "Stack Returner",
      returnRaidStackToHandOnReturn: true,
      abilities: [
        {
          id: "return-self",
          timing: TIMINGS.ACTIVATE_MAIN,
          effect: { kind: "returnTargetsToHand", target: "self" }
        }
      ]
    }
  };

  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game.phase = PHASES.MAIN;
  game.activePlayer = "P1";
  const stack = permanent("stack-returner", "P1", "stack_returner");
  stack.cards = [
    { uid: "stack-base", owner: "P1", defId: "demo_rookie", faceUp: true },
    { uid: "stack-top", owner: "P1", defId: "stack_returner", faceUp: true }
  ];
  game.players.P1.frontLine = [stack];

  game = applyAction(game, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: "return-self"
  });

  assert.equal(game.players.P1.frontLine.length, 0);
  assert.deepEqual(game.players.P1.hand.slice(-2).map((card) => card.defId), ["stack_returner", "demo_rookie"]);
  assert.equal(game.players.P1.sideline.some((card) => card.defId === "demo_rookie"), false);
});

test("legal actions expose payable Activate Main abilities", () => {
  let game = makeGame();
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0, destination: LINES.ENERGY });
  game.players.P1.hand.unshift({ uid: "test-activator", owner: "P1", defId: "demo_activator", faceUp: true });
  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0, destination: LINES.FRONT });
  game.players.P1.frontLine[0].rested = false;

  const action = legalActions(game, "P1").find((candidate) => {
    return candidate.type === "activateMainAbility"
      && candidate.line === LINES.FRONT
      && candidate.index === 0
      && candidate.abilityId === "draw-main";
  });

  assert.ok(action);
  const handBefore = game.players.P1.hand.length;
  game = applyAction(game, action);
  assert.equal(game.players.P1.frontLine[0].rested, true);
  assert.equal(game.players.P1.hand.length, handBefore + 1);
  assert.equal(legalActions(game, "P1").some((candidate) => candidate.type === "activateMainAbility"), false);
});

test("normal play respects entersActive and under-card effects can move cards to hand", () => {
  const catalog = {
    ...sampleCatalog,
    private_active_utility: {
      id: "private_active_utility",
      number: "DEM-1-090",
      sourceCode: "DEM",
      name: "Private Active Utility",
      type: "character",
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      keywords: {},
      entersActive: true,
      abilities: [
        {
          id: "stash",
          timing: TIMINGS.WHEN_PLAYED,
          effect: { kind: "placeTopDeckUnderSelf", count: 1 }
        },
        {
          id: "take",
          timing: TIMINGS.ACTIVATE_MAIN,
          effect: { kind: "moveUnderCardsToZone", count: 1, destination: "hand", target: "self" }
        }
      ]
    }
  };
  let game = createGame({
    catalog,
    decks: { P1: ["private_active_utility", ...sampleDeckList.flatMap((entry) => Array(entry.count).fill(entry.id)).slice(0, 49)], P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  const handBefore = game.players.P1.hand.length;
  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0, destination: LINES.FRONT });

  assert.equal(game.players.P1.frontLine[0].rested, false);
  assert.equal(game.players.P1.frontLine[0].cards.length, 2);
  assert.equal(game.players.P1.frontLine[0].cards[0].faceUp, false);

  game = applyAction(game, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: "take"
  });
  assert.equal(game.players.P1.frontLine[0].cards.length, 1);
  assert.equal(game.players.P1.hand.length, handBefore);
});

test("hand and looked deck cards can be placed face down under a source permanent", () => {
  const catalog = {
    ...sampleCatalog,
    under_worker: {
      id: "under_worker",
      number: "DEM-1-091",
      sourceCode: "DEM",
      name: "Under Worker",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      keywords: {},
      abilities: [
        {
          id: "hand-under",
          timing: TIMINGS.ACTIVATE_MAIN,
          effect: { kind: "moveHandCardsUnderSelf", count: 1, faceUp: false }
        },
        {
          id: "deck-under",
          timing: TIMINGS.ACTIVATE_MAIN,
          effect: {
            kind: "lookTopDeckAndMove",
            count: 3,
            destinations: ["underSelf", "bottom"],
            defaultDestination: "bottom",
            nonDefaultDestination: "underSelf",
            defaultNonDefaultCount: 2,
            minNonDefault: 2,
            maxNonDefault: 2
          }
        }
      ]
    }
  };
  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game = mainPhase(game);
  game.players.P1.frontLine.push(permanent("under-worker", "P1", "under_worker"));
  game.players.P1.hand.unshift({ uid: "hand-tuck", owner: "P1", defId: "demo_guardian", faceUp: true });

  game = applyAction(game, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: "hand-under",
    choices: { handIndices: [0] }
  });

  assert.equal(game.players.P1.frontLine[0].cards.length, 2);
  assert.equal(game.players.P1.frontLine[0].cards[0].uid, "hand-tuck");
  assert.equal(game.players.P1.frontLine[0].cards[0].faceUp, false);

  game.players.P1.deck.unshift(
    { uid: "deck-tuck-1", owner: "P1", defId: "demo_rookie", faceUp: true },
    { uid: "deck-tuck-2", owner: "P1", defId: "demo_guardian", faceUp: true },
    { uid: "deck-bottom", owner: "P1", defId: "demo_raider", faceUp: true }
  );
  game = applyAction(game, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: "deck-under"
  });

  assert.deepEqual(game.players.P1.frontLine[0].cards.slice(0, 3).map((card) => card.uid), [
    "hand-tuck",
    "deck-tuck-1",
    "deck-tuck-2"
  ]);
  assert.equal(game.players.P1.frontLine[0].cards[1].faceUp, false);
  assert.equal(game.players.P1.deck.at(-1).uid, "deck-bottom");
});

test("zone cards tuck only under legal no-face-down-under targets", () => {
  const catalog = {
    ...sampleCatalog,
    rei: {
      ...sampleCatalog.demo_rookie,
      id: "rei",
      number: "DEM-1-091",
      name: "Rei Ayanami"
    },
    shinji: {
      ...sampleCatalog.demo_rookie,
      id: "shinji",
      number: "DEM-1-092",
      name: "Shinji Ikari"
    },
    tuck_event: {
      id: "tuck_event",
      number: "DEM-1-093",
      sourceCode: "DEM",
      name: "Tuck Event",
      type: CARD_TYPES.EVENT,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      affinities: [],
      eventEffect: {
        kind: "moveZoneCardsUnderTargets",
        source: "sideline",
        count: 1,
        faceUp: false,
        filter: { name: "Rei Ayanami" },
        target: { controller: "self", line: "field", name: "Shinji Ikari", max: 1, noFaceDownUnder: true }
      }
    }
  };
  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game = mainPhase(game);
  const occupied = permanent("occupied-shinji", "P1", "shinji");
  occupied.cards.unshift({ uid: "already-under", owner: "P1", defId: "demo_guardian", faceUp: false });
  game.players.P1.frontLine.push(occupied, permanent("open-shinji", "P1", "shinji"));
  game.players.P1.sideline.push({ uid: "rei-card", owner: "P1", defId: "rei", faceUp: true });
  game.players.P1.hand.unshift({ uid: "tuck-event", owner: "P1", defId: "tuck_event", faceUp: true });

  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0 });

  assert.equal(game.players.P1.frontLine[0].cards.length, 2);
  assert.equal(game.players.P1.frontLine[1].cards[0].uid, "rei-card");
  assert.equal(game.players.P1.frontLine[1].cards[0].faceUp, false);
  assert.equal(game.players.P1.sideline.length, 1);
  assert.equal(game.players.P1.sideline[0].defId, "tuck_event");
});

test("sideline Activate Main abilities can play their source and resolve source when-played effects", () => {
  const catalog = {
    ...sampleCatalog,
    sideline_swaper: {
      id: "sideline_swaper",
      number: "DEM-1-090",
      sourceCode: "DEM",
      name: "Sideline Swapper",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 2000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      keywords: {},
      abilities: [
        {
          id: "from-sideline",
          timing: TIMINGS.ACTIVATE_MAIN,
          conditions: { zone: "sideline" },
          effect: { kind: "playSourceFromZone", source: "sideline", rested: true, destinationLine: LINES.FRONT }
        },
        {
          id: "swap",
          timing: TIMINGS.WHEN_PLAYED,
          effect: { kind: "swapSourceWithOtherLine" }
        }
      ]
    }
  };
  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game = mainPhase(game);
  game.players.P1.sideline.push({ uid: "sideline-source", owner: "P1", defId: "sideline_swaper", faceUp: true });
  game.players.P1.energyLine.push(permanent("energy-body", "P1", "demo_rookie"));

  const action = legalActions(game, "P1").find((candidate) => {
    return candidate.type === "activateMainAbility"
      && candidate.zone === "sideline"
      && candidate.abilityId === "from-sideline";
  });

  assert.ok(action);
  game = applyAction(game, action);
  assert.equal(game.players.P1.sideline.length, 0);
  assert.equal(game.players.P1.frontLine[0].cards.at(-1).defId, "demo_rookie");
  assert.equal(game.players.P1.energyLine[0].cards.at(-1).defId, "sideline_swaper");
});

test("moved-card ability copies become activatable for the source this turn", () => {
  const catalog = {
    ...sampleCatalog,
    copy_host: {
      id: "copy_host",
      number: "DEM-1-091",
      sourceCode: "DEM",
      name: "Copy Host",
      type: CARD_TYPES.CHARACTER,
      color: "red",
      requiredEnergy: { color: "red", amount: 0 },
      apCost: 0,
      bp: 2500,
      energy: [{ color: "red", amount: 1 }],
      affinities: [],
      keywords: {},
      abilities: [
        {
          id: "copy-from-removal",
          timing: TIMINGS.ACTIVATE_MAIN,
          oncePerTurn: true,
          effect: {
            kind: "sequence",
            effects: [
              {
                kind: "moveCardBetweenZones",
                source: "sideline",
                destination: "removal",
                count: 1,
                filter: { color: "red", affinity: "Cursed Spirit" }
              },
              {
                kind: "copyActivatedAbilitiesFromMovedCards",
                timing: TIMINGS.ACTIVATE_MAIN,
                sourceDestination: "removal",
                expires: "endOfTurn"
              }
            ]
          }
        }
      ]
    },
    donor_spirit: {
      id: "donor_spirit",
      number: "DEM-1-092",
      sourceCode: "DEM",
      name: "Donor Spirit",
      type: CARD_TYPES.CHARACTER,
      color: "red",
      requiredEnergy: { color: "red", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "red", amount: 1 }],
      affinities: ["Cursed Spirit"],
      keywords: {},
      abilities: [
        {
          id: "donor-draw",
          timing: TIMINGS.ACTIVATE_MAIN,
          effect: { kind: "draw", amount: 1 }
        }
      ]
    }
  };
  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game = mainPhase(game);
  game.players.P1.frontLine.push(permanent("copy-host", "P1", "copy_host"));
  game.players.P1.sideline.push({ uid: "donor-card", owner: "P1", defId: "donor_spirit", faceUp: true });

  const handBefore = game.players.P1.hand.length;
  game = applyAction(game, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: "copy-from-removal"
  });

  assert.equal(game.players.P1.sideline.length, 0);
  assert.equal(game.players.P1.removal[0].defId, "donor_spirit");
  assert.equal(game.players.P1.frontLine[0].gainedAbilities.length, 1);

  const copiedAbilityId = game.players.P1.frontLine[0].gainedAbilities[0].id;
  game = applyAction(game, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: copiedAbilityId
  });
  assert.equal(game.players.P1.hand.length, handBefore + 1);
});

test("life-area transfer effects move selected life cards to hand or sideline", () => {
  const catalog = {
    ...sampleCatalog,
    life_mover: {
      id: "life_mover",
      number: "DEM-1-090",
      sourceCode: "DEM",
      name: "Life Mover",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      keywords: {},
      abilities: [
        {
          id: "life-to-hand",
          timing: TIMINGS.ACTIVATE_MAIN,
          effect: { kind: "moveCardBetweenZones", source: "life", destination: "hand", count: 1, choiceKey: "lifeIndices" }
        },
        {
          id: "life-to-sideline",
          timing: TIMINGS.ACTIVATE_MAIN,
          effect: { kind: "moveCardBetweenZones", source: "life", destination: "sideline", count: 1, choiceKey: "lifeIndices" }
        }
      ]
    }
  };
  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game = mainPhase(game);
  game.players.P1.frontLine.push(permanent("life-mover", "P1", "life_mover"));
  const firstLifeUid = game.players.P1.life[0].uid;

  game = applyAction(game, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: "life-to-hand",
    choices: { lifeIndices: [0] }
  });

  assert.equal(game.players.P1.life.length, 6);
  assert.equal(game.players.P1.hand.at(-1).uid, firstLifeUid);
  const secondLifeUid = game.players.P1.life[0].uid;

  game = applyAction(game, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: "life-to-sideline",
    choices: { lifeIndices: [0] }
  });

  assert.equal(game.players.P1.life.length, 5);
  assert.equal(game.players.P1.sideline.at(-1).uid, secondLifeUid);
});

test("played-ability suppression prevents When Played abilities from resolving", () => {
  const catalog = {
    ...sampleCatalog,
    suppress_event: {
      id: "suppress_event",
      number: "DEM-1-093",
      sourceCode: "DEM",
      name: "Suppress Event",
      type: CARD_TYPES.EVENT,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      affinities: [],
      eventEffect: {
        kind: "sequence",
        effects: [
          { kind: "suppressPlayedAbilities" },
          {
            kind: "playCardFromZone",
            zones: ["hand"],
            rested: false,
            destinationLine: LINES.FRONT,
            filter: { name: "Suppressed Recruit" }
          }
        ]
      }
    },
    suppressed_recruit: {
      id: "suppressed_recruit",
      number: "DEM-1-094",
      sourceCode: "DEM",
      name: "Suppressed Recruit",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      keywords: {},
      abilities: [
        {
          id: "draw-when-played",
          timing: TIMINGS.WHEN_PLAYED,
          effect: { kind: "draw", amount: 1 }
        }
      ]
    }
  };
  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game = mainPhase(game);
  game.players.P1.hand.unshift({ uid: "suppressed-recruit", owner: "P1", defId: "suppressed_recruit", faceUp: true });
  game.players.P1.hand.unshift({ uid: "suppress-event", owner: "P1", defId: "suppress_event", faceUp: true });
  const handBefore = game.players.P1.hand.length;

  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0 });

  assert.equal(game.players.P1.frontLine[0].cards.at(-1).defId, "suppressed_recruit");
  assert.equal(game.players.P1.hand.length, handBefore - 2);
});

test("play-from-zone effects enforce fulfilled required energy filters", () => {
  const catalog = {
    ...sampleCatalog,
    play_caller: {
      id: "play_caller",
      number: "DEM-1-089",
      sourceCode: "DEM",
      name: "Play Caller",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      keywords: {},
      abilities: [
        {
          id: "play-fulfilled",
          timing: TIMINGS.ACTIVATE_MAIN,
          effect: {
            kind: "playCardFromZone",
            zones: ["hand"],
            rested: true,
            destinationLine: LINES.FRONT,
            filter: { type: CARD_TYPES.CHARACTER, requiredEnergyFulfilled: true, apCost: 1 }
          }
        }
      ]
    },
    fulfilled_target: {
      id: "fulfilled_target",
      number: "DEM-1-088",
      sourceCode: "DEM",
      name: "Fulfilled Target",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 1 },
      apCost: 1,
      bp: 2000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      keywords: {}
    }
  };
  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game = mainPhase(game);
  game.players.P1.frontLine.push(permanent("play-caller", "P1", "play_caller"));
  game.players.P1.hand.unshift({ uid: "fulfilled-target", owner: "P1", defId: "fulfilled_target", faceUp: true });

  game = applyAction(game, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: "play-fulfilled"
  });
  assert.equal(game.players.P1.frontLine.length, 1);
  assert.equal(game.players.P1.hand[0].defId, "fulfilled_target");

  game.players.P1.energyLine.push(permanent("energy-source", "P1", "demo_rookie"));
  game = applyAction(game, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: "play-fulfilled"
  });
  assert.equal(game.players.P1.frontLine.length, 2);
  assert.equal(game.players.P1.frontLine[1].cards.at(-1).defId, "fulfilled_target");
});

test("choice-mode modifiers resolve every branch of matching choose-one abilities", () => {
  const catalog = {
    ...sampleCatalog,
    choice_modifier: {
      id: "choice_modifier",
      number: "DEM-1-095",
      sourceCode: "DEM",
      name: "Choice Modifier",
      type: CARD_TYPES.EVENT,
      color: "purple",
      requiredEnergy: { color: "purple", amount: 0 },
      apCost: 0,
      affinities: [],
      eventEffect: {
        kind: "choiceModeModifier",
        mode: "chooseAll",
        color: "purple",
        once: true,
        expires: "endOfTurn"
      }
    },
    purple_chooser: {
      id: "purple_chooser",
      number: "DEM-1-096",
      sourceCode: "DEM",
      name: "Purple Chooser",
      type: CARD_TYPES.CHARACTER,
      color: "purple",
      requiredEnergy: { color: "purple", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "purple", amount: 1 }],
      affinities: [],
      keywords: {},
      abilities: [
        {
          id: "choose-main",
          timing: TIMINGS.ACTIVATE_MAIN,
          effect: {
            kind: "chooseOne",
            choices: [
              { id: "draw", effect: { kind: "draw", amount: 1 } },
              { id: "pump", effect: { kind: "modifyBp", amount: 1000, duration: "turn", target: "self" } }
            ]
          }
        }
      ]
    }
  };
  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game = mainPhase(game);
  game.players.P1.frontLine.push(permanent("purple-chooser", "P1", "purple_chooser"));
  game.players.P1.hand.unshift({ uid: "choice-modifier", owner: "P1", defId: "choice_modifier", faceUp: true });

  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0 });
  assert.equal(game.continuousEffects.some((effect) => effect.kind === "choiceModeModifier"), true);

  const handAfterEvent = game.players.P1.hand.length;
  game = applyAction(game, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: "choose-main"
  });

  assert.equal(game.players.P1.hand.length, handAfterEvent + 1);
  assert.equal(internals.battlePower(game, game.players.P1.frontLine[0]), 2000);
  assert.equal(game.continuousEffects.some((effect) => effect.kind === "choiceModeModifier"), false);
});

test("AP cost reductions apply to the next matching card use and are consumed", () => {
  const catalog = {
    ...sampleCatalog,
    reducer: {
      id: "reducer",
      number: "DEM-1-091",
      sourceCode: "DEM",
      name: "Reducer",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      keywords: {},
      abilities: [
        {
          id: "discount",
          timing: TIMINGS.ACTIVATE_MAIN,
          effect: {
            kind: "reduceNextUseApCost",
            amount: 1,
            sourceZone: "hand",
            expires: "endOfTurn",
            filter: { name: "Hajime Saito", requiredEnergyMax: 3 }
          }
        }
      ]
    },
    hajime: {
      id: "hajime",
      number: "DEM-1-092",
      sourceCode: "DEM",
      name: "Hajime Saito",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 1,
      bp: 3000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      keywords: {}
    }
  };
  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game = mainPhase(game);
  game.players.P1.frontLine.push(permanent("reducer-perm", "P1", "reducer"));
  game.players.P1.hand.unshift({ uid: "hajime-card", owner: "P1", defId: "hajime", faceUp: true });

  game = applyAction(game, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: "discount"
  });
  assert.equal(internals.apCostForCardUse(game, "P1", catalog.hajime), 0);

  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0, destination: LINES.FRONT });
  assert.equal(game.players.P1.apCards.filter((ap) => !ap.rested).length, 1);
  assert.equal(game.continuousEffects.length, 0);
});

test("effects can pay for and use an event from sideline into removal", () => {
  const catalog = {
    ...sampleCatalog,
    event_caller: {
      id: "event_caller",
      number: "DEM-1-093",
      sourceCode: "DEM",
      name: "Event Caller",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      keywords: {},
      abilities: [
        {
          id: "use-elixir",
          timing: TIMINGS.ACTIVATE_MAIN,
          effect: {
            kind: "useEventFromZone",
            source: "sideline",
            destination: "removal",
            filter: { type: CARD_TYPES.EVENT, name: "Elixir of Life" }
          }
        }
      ]
    },
    elixir: {
      id: "elixir",
      number: "DEM-1-094",
      sourceCode: "DEM",
      name: "Elixir of Life",
      type: CARD_TYPES.EVENT,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 1,
      affinities: [],
      eventEffect: { kind: "draw", amount: 1 }
    }
  };
  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game = mainPhase(game);
  game.players.P1.frontLine.push(permanent("caller-perm", "P1", "event_caller"));
  game.players.P1.sideline.push({ uid: "elixir-card", owner: "P1", defId: "elixir", faceUp: true });
  const handBefore = game.players.P1.hand.length;

  game = applyAction(game, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: "use-elixir"
  });

  assert.equal(game.players.P1.sideline.length, 0);
  assert.equal(game.players.P1.removal[0].defId, "elixir");
  assert.equal(game.players.P1.hand.length, handBefore + 1);
  assert.equal(game.players.P1.apCards.filter((ap) => !ap.rested).length, 0);
});

test("replay effects sideline a field character and resolve its when-played ability", () => {
  const catalog = {
    ...sampleCatalog,
    blinker: {
      id: "blinker",
      number: "DEM-1-095",
      sourceCode: "DEM",
      name: "Blinker",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      keywords: {},
      abilities: [
        {
          id: "blink",
          timing: TIMINGS.ACTIVATE_MAIN,
          effect: {
            kind: "replayTargets",
            rested: false,
            destinationLine: LINES.FRONT,
            target: { controller: "self", line: "field", type: CARD_TYPES.CHARACTER, max: 1 }
          }
        }
      ]
    },
    redraw_body: {
      id: "redraw_body",
      number: "DEM-1-096",
      sourceCode: "DEM",
      name: "Redraw Body",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      keywords: {},
      abilities: [
        {
          id: "redraw",
          timing: TIMINGS.WHEN_PLAYED,
          effect: { kind: "draw", amount: 1 }
        }
      ]
    }
  };
  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game = mainPhase(game);
  game.players.P1.frontLine.push(permanent("redraw-perm", "P1", "redraw_body"));
  game.players.P1.frontLine.push(permanent("blinker-perm", "P1", "blinker"));
  const handBefore = game.players.P1.hand.length;

  game = applyAction(game, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 1,
    abilityId: "blink"
  });

  assert.equal(game.players.P1.sideline.length, 0);
  assert.equal(game.players.P1.frontLine.at(-1).cards.at(-1).defId, "redraw_body");
  assert.equal(game.players.P1.frontLine.at(-1).rested, false);
  assert.equal(game.players.P1.hand.length, handBefore + 1);
});

test("Raid stacks on a matching character, readies it, and may move it to front line", () => {
  let game = makeGame();
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0, destination: LINES.ENERGY });

  game.players.P1.hand.unshift({ uid: "test-raider", owner: "P1", defId: "demo_raider", faceUp: true });
  game.players.P1.apCards.push({ id: "test-ap-2", rested: false });

  game = applyAction(game, {
    type: "performRaid",
    player: "P1",
    handIndex: 0,
    targetLine: LINES.ENERGY,
    targetIndex: 0,
    moveToFront: true
  });

  assert.equal(game.players.P1.energyLine.length, 0);
  assert.equal(game.players.P1.frontLine.length, 1);
  assert.equal(game.players.P1.frontLine[0].cards.length, 2);
  assert.equal(game.players.P1.frontLine[0].rested, false);
});

test("legal actions include Raid choices while keeping normal play choices", () => {
  let game = makeGame();
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0, destination: LINES.ENERGY });
  game.players.P1.hand.unshift({ uid: "test-raider", owner: "P1", defId: "demo_raider", faceUp: true });

  const actions = legalActions(game, "P1");
  assert.ok(actions.some((action) => {
    return action.type === "playCard"
      && action.handIndex === 0
      && action.destination === LINES.FRONT;
  }));
  assert.ok(actions.some((action) => {
    return action.type === "performRaid"
      && action.handIndex === 0
      && action.targetLine === LINES.ENERGY
      && action.targetIndex === 0
    && action.moveToFront === true;
  }));
});

test("full-line plays and Raid movement enumerate every legal replacement", () => {
  const catalog = {
    ...sampleCatalog,
    full_line_play: {
      ...sampleCatalog.demo_rookie,
      id: "full_line_play",
      number: "DEM-FULL-LINE-PLAY",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0
    },
    full_line_raid_base: {
      ...sampleCatalog.demo_rookie,
      id: "full_line_raid_base",
      number: "DEM-FULL-LINE-BASE",
      name: "Full Line Raid Base"
    },
    full_line_raider: {
      ...sampleCatalog.demo_raider,
      id: "full_line_raider",
      number: "DEM-FULL-LINE-RAIDER",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      raid: { names: ["Full Line Raid Base"], affinities: [] }
    }
  };
  const makeFullGame = (handDefId) => {
    const game = mainPhase(makeGame({ catalog, validateDecks: false }));
    game.players.P1.frontLine = Array.from({ length: 4 }, (_, index) => (
      permanent(`full-front-${index}`, "P1", "demo_guardian")
    ));
    game.players.P1.energyLine = [permanent("full-raid-base", "P1", "full_line_raid_base")];
    game.players.P1.hand = [card("full-line-hand-card", "P1", handDefId)];
    return game;
  };

  const playGame = makeFullGame("full_line_play");
  const fullLinePlays = legalActions(playGame, "P1")
    .filter((action) => action.type === "playCard" && action.destination === LINES.FRONT);
  assert.deepEqual(fullLinePlays.map((action) => action.replaceIndex), [0, 1, 2, 3]);
  const played = applyAction(playGame, fullLinePlays[2]);
  assert.equal(played.players.P1.frontLine.length, 4);
  assert.equal(played.players.P1.frontLine.at(-1).cards.at(-1).defId, "full_line_play");
  assert.equal(played.players.P1.removal.length, 1);

  const raidGame = makeFullGame("full_line_raider");
  const raids = legalActions(raidGame, "P1").filter((action) => action.type === "performRaid");
  assert.equal(raids.filter((action) => !action.moveToFront).length, 1);
  assert.deepEqual(
    raids.filter((action) => action.moveToFront).map((action) => action.replaceIndex),
    [0, 1, 2, 3]
  );
  const movedRaid = applyAction(raidGame, raids.find((action) => action.moveToFront && action.replaceIndex === 1));
  assert.equal(movedRaid.players.P1.energyLine.length, 0);
  assert.equal(movedRaid.players.P1.frontLine.length, 4);
  assert.equal(movedRaid.players.P1.frontLine.at(-1).cards.at(-1).defId, "full_line_raider");
  assert.equal(movedRaid.players.P1.removal.length, 1);
});

test("unique-name reveal effects calculate BP threshold from hand and field", () => {
  const catalog = {
    ...sampleCatalog,
    reveal_removal: {
      id: "reveal_removal",
      number: "DEM-1-090",
      sourceCode: "DEM",
      name: "Reveal Removal",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      abilities: [
        {
          id: "reveal-remove",
          timing: TIMINGS.WHEN_PLAYED,
          effect: {
            kind: "sidelineTargetsByUniqueAffinityReveal",
            amountPerCard: 1000,
            filter: { affinity: "Specified Slot" },
            target: { controller: "opponent", line: LINES.FRONT, type: CARD_TYPES.CHARACTER, max: 1 }
          }
        }
      ]
    },
    slot_a: {
      ...sampleCatalog.demo_rookie,
      id: "slot_a",
      number: "DEM-1-091",
      name: "Slot A",
      affinities: ["Specified Slot"]
    },
    slot_b: {
      ...sampleCatalog.demo_rookie,
      id: "slot_b",
      number: "DEM-1-092",
      name: "Slot B",
      affinities: ["Specified Slot"]
    },
    slot_c: {
      ...sampleCatalog.demo_rookie,
      id: "slot_c",
      number: "DEM-1-093",
      name: "Slot C",
      affinities: ["Specified Slot"]
    },
    target_3000: {
      ...sampleCatalog.demo_guardian,
      id: "target_3000",
      number: "DEM-1-094",
      name: "Target 3000",
      bp: 3000
    }
  };
  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game = mainPhase(game);
  game.players.P1.frontLine.push(permanent("slot-field", "P1", "slot_a"));
  game.players.P1.hand.unshift(
    { uid: "reveal-source", owner: "P1", defId: "reveal_removal", faceUp: true },
    { uid: "slot-b", owner: "P1", defId: "slot_b", faceUp: true },
    { uid: "slot-c", owner: "P1", defId: "slot_c", faceUp: true }
  );
  game.players.P2.frontLine.push(permanent("target-3000", "P2", "target_3000"));

  game = applyAction(game, {
    type: "playCard",
    player: "P1",
    handIndex: 0,
    destination: LINES.FRONT
  });

  assert.equal(game.players.P2.frontLine.length, 0);
  assert.equal(game.players.P2.sideline.at(-1).defId, "target_3000");
});

test("delayed start-of-opponent-turn effects sideline target and move source to energy", () => {
  const catalog = {
    ...sampleCatalog,
    delayed_source: {
      id: "delayed_source",
      number: "DEM-1-089",
      sourceCode: "DEM",
      name: "Delayed Source",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      abilities: [
        {
          id: "delayed-remove",
          timing: TIMINGS.WHEN_PLAYED,
          effect: {
            kind: "scheduleSidelineTargetsAndMoveSelfToEnergy",
            target: { controller: "opponent", line: LINES.FRONT, type: CARD_TYPES.CHARACTER, max: 1 }
          }
        }
      ]
    }
  };
  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game = mainPhase(game);
  game.players.P1.hand.unshift({ uid: "delayed-source-card", owner: "P1", defId: "delayed_source", faceUp: true });
  game.players.P2.frontLine.push(permanent("delayed-target", "P2", "demo_guardian"));

  game = applyAction(game, {
    type: "playCard",
    player: "P1",
    handIndex: 0,
    destination: LINES.FRONT
  });
  assert.equal(game.players.P2.frontLine.length, 1);

  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });

  assert.equal(game.activePlayer, "P2");
  assert.equal(game.players.P2.frontLine.length, 0);
  assert.equal(game.players.P2.sideline.at(-1).defId, "demo_guardian");
  assert.equal(game.players.P1.frontLine.length, 0);
  assert.equal(game.players.P1.energyLine.at(-1).cards.at(-1).defId, "delayed_source");
  assert.equal(game.players.P1.energyLine.at(-1).rested, true);
});

test("front-energy swap effects can swap opponent lines", () => {
  const catalog = {
    ...sampleCatalog,
    opponent_swap_event: {
      id: "opponent_swap_event",
      number: "DEM-1-090",
      sourceCode: "DEM",
      name: "Opponent Swap Event",
      type: CARD_TYPES.EVENT,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      affinities: [],
      eventEffect: { kind: "swapOwnFrontAndEnergy", player: "opponent" }
    }
  };
  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game = mainPhase(game);
  game.players.P1.hand.unshift({ uid: "swap-event", owner: "P1", defId: "opponent_swap_event", faceUp: true });
  game.players.P2.frontLine.push(permanent("opponent-front", "P2", "demo_guardian"));
  game.players.P2.energyLine.push(permanent("opponent-energy", "P2", "demo_rookie"));

  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0 });

  assert.equal(game.players.P2.frontLine[0].pid, "opponent-energy");
  assert.equal(game.players.P2.energyLine[0].pid, "opponent-front");
});

test("field cards can raise the end-phase maximum hand size", () => {
  const catalog = {
    ...sampleCatalog,
    large_hand_site: {
      ...sampleCatalog.demo_site,
      id: "large_hand_site",
      number: "DEM-1-210",
      name: "Large Hand Site",
      maximumHandSize: 15
    }
  };
  let game = makeGame({ catalog, validateDecks: false });
  game.phase = PHASES.END;
  game.players.P1.energyLine = [permanent("large-hand", "P1", "large_hand_site")];
  game.players.P1.hand = [...Array(15)].map((_, index) => card(`hand-${index}`, "P1", "demo_rookie"));
  assert.deepEqual(legalActions(game, "P1").map((action) => action.type), ["advancePhase"]);

  game.players.P1.hand.push(card("hand-15", "P1", "demo_rookie"));
  assert.deepEqual(legalActions(game, "P1").map((action) => action.type), ["discardForHandLimit"]);
  game = applyAction(game, { type: "discardForHandLimit", player: "P1", handIndices: [15] });
  assert.equal(game.players.P1.hand.length, 15);
});

test("front-line capacity reducers immediately remove overflow cards and recalculate capacity", () => {
  const catalog = {
    ...sampleCatalog,
    capacity_reducer: {
      ...sampleCatalog.demo_rookie,
      id: "capacity_reducer",
      number: "DEM-1-211",
      name: "Capacity Reducer",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      lineCapacityModifiers: [{ line: LINES.FRONT, amount: -1, condition: { line: LINES.FRONT } }]
    }
  };
  let game = mainPhase(makeGame({ catalog, validateDecks: false }));
  game.players.P1.frontLine = [
    permanent("old-1", "P1", "demo_rookie"),
    permanent("old-2", "P1", "demo_rookie"),
    permanent("old-3", "P1", "demo_rookie")
  ];
  game.players.P1.hand = [card("reducer-card", "P1", "capacity_reducer")];
  game = applyAction(game, {
    type: "playCard",
    player: "P1",
    handIndex: 0,
    destination: LINES.FRONT
  });

  assert.equal(game.players.P1.frontLine.length, 3);
  assert.equal(game.players.P1.frontLine.some((item) => topDefId(item) === "capacity_reducer"), true);
  assert.equal(game.players.P1.removal.some((item) => item.uid === "old-1-card"), true);
});

test("play-only and own-ability-only line restrictions remain distinct", () => {
  const catalog = {
    ...sampleCatalog,
    own_move_only: {
      ...sampleCatalog.demo_rookie,
      id: "own_move_only",
      number: "DEM-1-212",
      name: "Own Move Only",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      cannotPlayToFrontLine: true,
      frontLineMoveByOwnAbilityOnly: true,
      abilities: [{
        id: "move-self",
        timing: TIMINGS.ACTIVATE_MAIN,
        effect: { kind: "moveTargetsToLine", destinationLine: LINES.FRONT, target: "self" }
      }]
    },
    no_energy_entry: {
      ...sampleCatalog.demo_rookie,
      id: "no_energy_entry",
      number: "DEM-1-213",
      name: "No Energy Entry",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      cannotEnterEnergyLine: true
    }
  };
  let game = mainPhase(makeGame({ catalog, validateDecks: false }));
  game.players.P1.hand = [
    card("own-move-card", "P1", "own_move_only"),
    card("no-energy-card", "P1", "no_energy_entry")
  ];
  const playActions = legalActions(game, "P1").filter((action) => action.type === "playCard");
  assert.equal(playActions.some((action) => action.handIndex === 0 && action.destination === LINES.FRONT), false);
  assert.equal(playActions.some((action) => action.handIndex === 0 && action.destination === LINES.ENERGY), true);
  assert.equal(playActions.some((action) => action.handIndex === 1 && action.destination === LINES.ENERGY), false);

  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0, destination: LINES.ENERGY });
  assert.equal(legalActions(game, "P1").some((action) => action.type === "moveCharacters"), false);
  game = applyAction(game, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.ENERGY,
    index: 0,
    abilityId: "move-self"
  });
  assert.equal(game.players.P1.frontLine.some((item) => topDefId(item) === "own_move_only"), true);
});

test("unbracketed leave-field abilities fire when a character leaves the field", () => {
  const catalog = {
    ...sampleCatalog,
    leave_source: {
      id: "leave_source",
      number: "DEM-1-091",
      sourceCode: "DEM",
      name: "Leave Source",
      type: CARD_TYPES.CHARACTER,
      color: "yellow",
      requiredEnergy: { color: "yellow", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "yellow", amount: 1 }],
      affinities: [],
      keywords: {},
      abilities: [
        {
          id: "leave-play",
          timing: TIMINGS.WHEN_LEAVES_FIELD,
          effect: {
            kind: "optional",
            default: true,
            effect: {
              kind: "sequence",
              effects: [
                { kind: "moveHandToZone", amount: 1, destination: "sideline" },
                {
                  kind: "playCardFromZone",
                  zone: "sideline",
                  rested: false,
                  destinationLine: LINES.FRONT,
                  filter: { color: "yellow", name: "Rei Ayanami", requiredEnergyMax: 2 }
                }
              ]
            }
          }
        }
      ]
    },
    rei_ayanami: {
      ...sampleCatalog.demo_rookie,
      id: "rei_ayanami",
      number: "DEM-1-092",
      name: "Rei Ayanami",
      color: "yellow",
      requiredEnergy: { color: "yellow", amount: 0 }
    },
    sideline_own_event: {
      id: "sideline_own_event",
      number: "DEM-1-093",
      sourceCode: "DEM",
      name: "Sideline Own Event",
      type: CARD_TYPES.EVENT,
      color: "yellow",
      requiredEnergy: { color: "yellow", amount: 0 },
      apCost: 0,
      affinities: [],
      eventEffect: {
        kind: "sidelineTargets",
        target: { controller: "self", line: LINES.FRONT, type: CARD_TYPES.CHARACTER, max: 1 }
      }
    }
  };
  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game = mainPhase(game);
  game.players.P1.frontLine.push(permanent("leave-source", "P1", "leave_source"));
  game.players.P1.sideline.push({ uid: "sideline-rei", owner: "P1", defId: "rei_ayanami", faceUp: true });
  game.players.P1.hand.unshift(
    { uid: "sideline-own-event", owner: "P1", defId: "sideline_own_event", faceUp: true },
    { uid: "discard-for-leave", owner: "P1", defId: "demo_guardian", faceUp: true }
  );

  game = applyAction(game, {
    type: "playCard",
    player: "P1",
    handIndex: 0,
    choices: { handIndices: [0] }
  });

  assert.equal(game.players.P1.frontLine.some((item) => item.cards.at(-1).defId === "rei_ayanami"), true);
  assert.equal(game.players.P1.frontLine.find((item) => item.cards.at(-1).defId === "rei_ayanami").rested, false);
  assert.equal(game.players.P1.sideline.some((card) => card.uid === "discard-for-leave"), true);
});

test("alternate card names satisfy Raid requirements", () => {
  const catalog = {
    ...sampleCatalog,
    aliased_base: {
      ...sampleCatalog.demo_rookie,
      id: "aliased_base",
      number: "DEM-ALIAS-BASE",
      name: "Kirito & Eugeo",
      alternateNames: ["Kirito", "Eugeo"]
    },
    alias_raid: {
      ...sampleCatalog.demo_guardian,
      id: "alias_raid",
      number: "DEM-ALIAS-RAID",
      name: "Eugeo Raid",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      raid: { names: ["Eugeo"], affinities: [] }
    }
  };
  let game = mainPhase(makeGame({ catalog, validateDecks: false }));
  game.players.P1.frontLine = [permanent("alias-base", "P1", "aliased_base")];
  game.players.P1.hand = [card("alias-raid-card", "P1", "alias_raid")];

  const raidAction = legalActions(game, "P1").find((action) => action.type === "performRaid");
  assert.ok(raidAction);
  game = applyAction(game, raidAction);
  assert.equal(game.players.P1.frontLine[0].cards.at(-1).defId, "alias_raid");
});

test("battle replacement moves a defeated character to its controller's energy line", () => {
  const catalog = {
    ...sampleCatalog,
    energy_battle_attacker: {
      ...sampleCatalog.demo_guardian,
      id: "energy_battle_attacker",
      number: "DEM-BATTLE-ENERGY",
      bp: 5000,
      battleLosersToEnergyInstead: true
    },
    energy_battle_blocker: {
      ...sampleCatalog.demo_rookie,
      id: "energy_battle_blocker",
      number: "DEM-BATTLE-BLOCKER",
      bp: 1000
    }
  };
  let game = makeGame({ catalog, validateDecks: false });
  game.phase = PHASES.ATTACK;
  game.activePlayer = "P1";
  game.players.P1.frontLine = [permanent("energy-attacker", "P1", "energy_battle_attacker")];
  game.players.P2.frontLine = [permanent("energy-blocker", "P2", "energy_battle_blocker")];
  game.players.P2.energyLine = [];

  game = applyAction(game, { type: "declareAttack", player: "P1", attackerIndex: 0, target: { type: "player" } });
  game = applyAction(game, { type: "declareBlock", player: "P2", blockerIndex: 0 });

  assert.equal(game.players.P2.frontLine.length, 0);
  assert.equal(game.players.P2.energyLine[0].cards.at(-1).defId, "energy_battle_blocker");
  assert.equal(game.players.P2.sideline.some((item) => item.defId === "energy_battle_blocker"), false);
});

test("battle-to-energy replacement exposes the defender's full-line removal choice", () => {
  const catalog = {
    ...sampleCatalog,
    energy_battle_attacker: {
      ...sampleCatalog.demo_guardian,
      id: "energy_battle_attacker",
      number: "DEM-BATTLE-ENERGY-FULL",
      bp: 5000,
      battleLosersToEnergyInstead: true
    }
  };
  let game = makeGame({ catalog, validateDecks: false });
  game.phase = PHASES.ATTACK;
  game.activePlayer = "P1";
  game.players.P1.frontLine = [permanent("energy-attacker-full", "P1", "energy_battle_attacker")];
  game.players.P2.frontLine = [permanent("energy-blocker-full", "P2", "demo_rookie")];
  game.players.P2.energyLine = [0, 1, 2, 3]
    .map((index) => permanent(`energy-slot-${index}`, "P2", "demo_rookie"));

  game = applyAction(game, { type: "declareAttack", player: "P1", attackerIndex: 0, target: { type: "player" } });
  const blockActions = legalActions(game, "P2").filter((action) => action.type === "declareBlock");
  assert.deepEqual(blockActions.map((action) => action.energyLineReplaceIndex), [0, 1, 2, 3]);

  game = applyAction(game, blockActions[2]);
  assert.equal(game.players.P2.removal.some((item) => item.uid === "energy-slot-2-card"), true);
  assert.equal(game.players.P2.energyLine.some((item) => item.pid === "energy-blocker-full"), true);
});

test("front-line free-extra-draw text bypasses the AP payment", () => {
  const catalog = {
    ...sampleCatalog,
    free_draw_source: {
      ...sampleCatalog.demo_rookie,
      id: "free_draw_source",
      number: "DEM-FREE-DRAW",
      freeExtraDrawFromFrontLine: true
    }
  };
  let game = makeGame({ catalog, validateDecks: false });
  game.players.P1.frontLine = [permanent("free-draw", "P1", "free_draw_source")];
  game.players.P1.apCards.forEach((ap) => { ap.rested = true; });
  const handBefore = game.players.P1.hand.length;

  assert.equal(legalActions(game, "P1").some((action) => action.type === "extraDraw"), true);
  game = applyAction(game, { type: "extraDraw", player: "P1" });
  assert.equal(game.players.P1.hand.length, handBefore + 1);
  assert.equal(game.players.P1.apCards.every((ap) => ap.rested), true);
});

test("BP-increase reactions resolve once without recursively retriggering", () => {
  const catalog = {
    ...sampleCatalog,
    bp_reactor: {
      ...sampleCatalog.demo_rookie,
      id: "bp_reactor",
      number: "DEM-BP-REACTOR",
      bp: 2000,
      abilities: [{
        id: "react-once",
        timing: TIMINGS.WHEN_BP_INCREASED,
        oncePerTurn: true,
        conditions: { turn: "controller" },
        effect: { kind: "modifyBp", amount: 1000, duration: "turn", target: "self" }
      }]
    },
    bp_boost_event: {
      id: "bp_boost_event",
      number: "DEM-BP-EVENT",
      sourceCode: "DEM",
      name: "BP Boost",
      type: CARD_TYPES.EVENT,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      affinities: [],
      eventEffect: {
        kind: "modifyBp",
        amount: 500,
        duration: "turn",
        target: { controller: "self", line: LINES.FRONT, name: "Demo Rookie", max: 1 }
      }
    }
  };
  catalog.bp_reactor.name = "Demo Rookie";
  let game = mainPhase(makeGame({ catalog, validateDecks: false }));
  game.players.P1.frontLine = [permanent("bp-reactor", "P1", "bp_reactor")];
  game.players.P1.hand = [card("bp-event", "P1", "bp_boost_event")];

  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0 });
  assert.equal(internals.battlePower(game, game.players.P1.frontLine[0]), 3500);
  assert.deepEqual(game.players.P1.frontLine[0].usedOncePerTurn, ["react-once"]);
});

test("named opponent-ability leave replacement sidelines its active source instead", () => {
  const catalog = {
    ...sampleCatalog,
    main_activator: {
      ...sampleCatalog.demo_rookie,
      id: "main_activator",
      number: "DEM-MAIN-ACTIVATOR",
      abilities: [{ id: "activate", timing: TIMINGS.ACTIVATE_MAIN, effect: { kind: "none" } }]
    },
    aoshi: {
      ...sampleCatalog.demo_rookie,
      id: "aoshi",
      number: "DEM-AOSHI",
      name: "Aoshi Shinomori"
    },
    shikijo: {
      ...sampleCatalog.demo_rookie,
      id: "shikijo",
      number: "DEM-SHIKIJO",
      name: "Shikijo",
      opponentAbilityLeaveReplacement: {
        protectedName: "Aoshi Shinomori",
        requiresActive: true,
        during: "controllerTurn",
        line: LINES.FRONT
      }
    },
    opponent_watcher: {
      ...sampleCatalog.demo_rookie,
      id: "opponent_watcher",
      number: "DEM-WATCHER",
      abilities: [{
        id: "remove-aoshi",
        timing: TIMINGS.WHEN_OPPONENT_ACTIVATE_MAIN_ABILITY,
        effect: {
          kind: "sidelineTargets",
          target: { controller: "opponent", line: LINES.FRONT, name: "Aoshi Shinomori", max: 1 }
        }
      }]
    }
  };
  let game = mainPhase(makeGame({ catalog, validateDecks: false }));
  game.players.P1.frontLine = [
    permanent("activator", "P1", "main_activator"),
    permanent("shikijo", "P1", "shikijo"),
    permanent("aoshi", "P1", "aoshi")
  ];
  game.players.P2.frontLine = [permanent("watcher", "P2", "opponent_watcher")];

  game = applyAction(game, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: "activate"
  });

  assert.equal(game.players.P1.frontLine.some((item) => topDefId(item) === "aoshi"), true);
  assert.equal(game.players.P1.frontLine.some((item) => topDefId(item) === "shikijo"), false);
  assert.equal(game.players.P1.sideline.some((item) => item.defId === "shikijo"), true);
});

test("a card can replace its own Get trigger with a printed alternative", () => {
  const activeEffect = {
    kind: "sequence",
    effects: [
      { kind: "readyTargets", target: { controller: "self", line: "field", type: CARD_TYPES.CHARACTER, max: 1 } },
      { kind: "modifyBp", amount: 3000, duration: "turn", target: { controller: "self", line: "field", type: CARD_TYPES.CHARACTER, max: 1 } }
    ]
  };
  const catalog = {
    ...sampleCatalog,
    flexible_trigger: {
      ...sampleCatalog.demo_rookie,
      id: "flexible_trigger",
      number: "DEM-FLEX-TRIGGER",
      trigger: { type: "get" },
      selfTriggerAlternatives: [{ type: "draw", amount: 1 }, { type: "active", effect: activeEffect }]
    }
  };
  const game = makeGame({ catalog, validateDecks: false });
  game.players.P2.life = [card("flex-life", "P2", "flexible_trigger", false)];
  game.players.P2.deck = [card("drawn-card", "P2", "demo_guardian", false)];
  game.players.P2.hand = [];

  internals.dealDamage(game, "P2", 1, {
    sourcePlayer: "P1",
    triggerChoices: [{ choices: { selfTriggerType: "draw" } }]
  });

  assert.equal(game.players.P2.hand.some((item) => item.uid === "drawn-card"), true);
  assert.equal(game.players.P2.sideline.some((item) => item.uid === "flex-life"), true);
});
