import test from "node:test";
import assert from "node:assert/strict";
import {
  CARD_TYPES,
  LINES,
  PHASES,
  TRIGGER_TYPES,
  applyAction,
  catalogGameResult,
  createSimulationGame,
  runAutoplayGame
} from "../src/index.js";
import { sampleCatalog, sampleDeckList } from "../data/sample-cards.js";

function make(seed) {
  return createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    seed
  }).state.players.P1.deck.map((card) => card.defId);
}

test("simulation shuffling is deterministic for the same seed", () => {
  assert.deepEqual(make(42), make(42));
});

test("simulation shuffling changes when the seed changes", () => {
  assert.notDeepEqual(make(42), make(43));
});

test("game catalog records setup and outcome fields", () => {
  const simulation = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    seed: 7
  });
  const result = catalogGameResult(simulation.state, { index: 1, seed: simulation.seed });

  assert.equal(result.index, 1);
  assert.equal(result.seed, 7);
  assert.equal(result.complete, false);
  assert.equal(result.winner, null);
  assert.equal(result.firstPlayer, "P1");
  assert.equal(result.secondPlayer, "P2");
  assert.equal(result.turnsTaken, 1);
  assert.equal(result.p1TurnsTaken, 1);
  assert.equal(result.p2TurnsTaken, 0);
  assert.equal(result.p1LifeRemaining, 7);
  assert.equal(result.p2LifeRemaining, 7);
  assert.equal(result.p1Mulliganed, false);
  assert.equal(result.p2Mulliganed, false);
  assert.equal(typeof result.p1SpecialTriggersInLife, "number");
  assert.equal(typeof result.p2SpecialTriggersInLife, "number");
});

test("game catalog marks a hand as bricked when it sees no zero-cost unit", () => {
  const catalog = {
    zero: {
      id: "zero",
      number: "TST-1-001",
      type: CARD_TYPES.CHARACTER,
      requiredEnergy: { color: "green", amount: 0 }
    },
    one: {
      id: "one",
      number: "TST-1-002",
      type: CARD_TYPES.CHARACTER,
      requiredEnergy: { color: "green", amount: 1 }
    },
    special: {
      id: "special",
      number: "TST-1-003",
      type: CARD_TYPES.EVENT,
      requiredEnergy: { color: "green", amount: 1 },
      trigger: { type: TRIGGER_TYPES.SPECIAL }
    }
  };
  const deck = [
    ...Array(7).fill("one"),
    ...Array(2).fill("special"),
    ...Array(41).fill("zero")
  ];
  const simulation = createSimulationGame({
    catalog,
    decks: { P1: deck, P2: deck },
    skipShuffle: true,
    validateDecks: false
  });
  const result = catalogGameResult(simulation.state);

  assert.equal(result.p1Bricked, true);
  assert.equal(result.p2Bricked, true);
  assert.equal(result.p1ZeroCostUnitsSeen, 0);
  assert.equal(result.p2ZeroCostUnitsSeen, 0);
  assert.equal(result.p1SpecialTriggersInLife, 2);
  assert.equal(result.p2SpecialTriggersInLife, 2);
});

test("game catalog treats empty-field required-energy reducers as setup openers", () => {
  const catalog = {
    one: {
      id: "one",
      number: "TST-1-001",
      type: CARD_TYPES.CHARACTER,
      requiredEnergy: { color: "green", amount: 1 },
      apCost: 1,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }]
    },
    opener: {
      id: "opener",
      number: "TST-1-002",
      type: CARD_TYPES.CHARACTER,
      requiredEnergy: { color: "green", amount: 2 },
      apCost: 1,
      bp: 2500,
      energy: [{ color: "green", amount: 1 }],
      useCostModifiers: [{
        kind: "requiredEnergy",
        color: "green",
        amount: 2,
        sourceZone: "hand",
        condition: { emptyField: true }
      }]
    }
  };
  const deck = [
    "opener",
    ...Array(49).fill("one")
  ];
  const simulation = createSimulationGame({
    catalog,
    decks: { P1: deck, P2: deck },
    skipShuffle: true,
    validateDecks: false
  });
  const result = catalogGameResult(simulation.state);

  assert.equal(result.p1Bricked, false);
  assert.equal(result.p2Bricked, false);
  assert.equal(result.p1ZeroCostUnitsSeen, 1);
  assert.equal(result.p2ZeroCostUnitsSeen, 1);
});

test("game catalog preserves empty-field setup opener facts after playout", () => {
  const catalog = {
    one: {
      id: "one",
      number: "TST-1-001",
      type: CARD_TYPES.CHARACTER,
      requiredEnergy: { color: "green", amount: 1 },
      apCost: 1,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }]
    },
    opener: {
      id: "opener",
      number: "TST-1-002",
      type: CARD_TYPES.CHARACTER,
      requiredEnergy: { color: "green", amount: 2 },
      apCost: 1,
      bp: 2500,
      energy: [{ color: "green", amount: 1 }],
      useCostModifiers: [{
        kind: "requiredEnergy",
        color: "green",
        amount: 2,
        sourceZone: "hand",
        condition: { emptyField: true }
      }]
    }
  };
  const deck = [
    "opener",
    ...Array(49).fill("one")
  ];
  const simulation = createSimulationGame({
    catalog,
    decks: { P1: deck, P2: deck },
    skipShuffle: true,
    validateDecks: false
  });
  const playout = runAutoplayGame(simulation.state, { maxActions: 20, maxTurns: 4 });
  const result = catalogGameResult(playout.state);

  assert.equal(result.p1InitialBricked, false);
  assert.equal(result.p1Bricked, false);
  assert.equal(result.p1InitialZeroCostUnitsSeen, 1);
  assert.equal(result.p1ZeroCostUnitsSeen, 1);
});

test("autoplay advances a bounded game without losing catalog setup facts", () => {
  const simulation = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    seed: 12
  });
  const playout = runAutoplayGame(simulation.state, { maxActions: 20, maxTurns: 4 });
  const result = catalogGameResult(playout.state, { seed: simulation.seed });

  assert.ok(playout.steps > 0);
  assert.match(playout.stoppedReason, /winner|maxTurns|maxActions|noLegalAutoplayAction/);
  assert.equal(result.seed, 12);
  assert.equal(result.p1LifeRemaining <= 7, true);
  assert.equal(typeof result.p1SpecialTriggersInLife, "number");
});

test("autoplay moves an energy-line character to the front during movement", () => {
  let game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true
  }).state;
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0, destination: LINES.ENERGY });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P2" });
  game = applyAction(game, { type: "advancePhase", player: "P2" });
  game = applyAction(game, { type: "advancePhase", player: "P2" });
  game = applyAction(game, { type: "advancePhase", player: "P2" });
  game = applyAction(game, { type: "advancePhase", player: "P2" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });

  const playout = runAutoplayGame(game, { maxActions: 1, maxTurns: 10 });
  assert.equal(playout.state.players.P1.energyLine.length, 0);
  assert.equal(playout.state.players.P1.frontLine.length, 1);
});

test("autoplay advances movement instead of bouncing Step characters backward", () => {
  let game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true
  }).state;
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 4, destination: LINES.FRONT });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P2" });
  game = applyAction(game, { type: "advancePhase", player: "P2" });
  game = applyAction(game, { type: "advancePhase", player: "P2" });
  game = applyAction(game, { type: "advancePhase", player: "P2" });
  game = applyAction(game, { type: "advancePhase", player: "P2" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });

  const playout = runAutoplayGame(game, { maxActions: 1, maxTurns: 10 });
  assert.equal(playout.state.phase, PHASES.MAIN);
  assert.equal(playout.state.players.P1.frontLine.length, 1);
  assert.equal(playout.state.players.P1.energyLine.length, 0);
});

test("autoplay chooses Raid over playing the same Raid card normally", () => {
  let game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true
  }).state;
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0, destination: LINES.ENERGY });
  game.players.P1.hand.unshift({ uid: "test-raider", owner: "P1", defId: "demo_raider", faceUp: true });

  const playout = runAutoplayGame(game, { maxActions: 1, maxTurns: 10 });
  assert.equal(playout.state.players.P1.energyLine.length, 0);
  assert.equal(playout.state.players.P1.frontLine.length, 1);
  assert.equal(playout.state.players.P1.frontLine[0].cards.length, 2);
});

test("autoplay activates a choice ability and selects the highest-impact branch", () => {
  const catalog = {
    ...sampleCatalog,
    private_choice_pilot: {
      id: "private_choice_pilot",
      number: "DEM-1-090",
      sourceCode: "DEM",
      name: "Choice Pilot",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      abilities: [
        {
          id: "choice-main",
          timing: "activateMain",
          oncePerTurn: true,
          effect: {
            kind: "chooseOne",
            choiceKey: "effectChoice",
            choices: [
              { id: "draw", effect: { kind: "draw", amount: 1 } },
              { id: "lethal", effect: { kind: "damageOpponent", amount: 1 } }
            ]
          }
        }
      ]
    }
  };
  let game = createSimulationGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  }).state;
  game.phase = PHASES.MAIN;
  game.activePlayer = "P1";
  game.players.P1.frontLine = [{
    pid: "choice-pilot",
    owner: "P1",
    controller: "P1",
    cards: [{ uid: "choice-card", owner: "P1", defId: "private_choice_pilot", faceUp: true }],
    rested: false,
    bpDelta: 0,
    bpModifiers: [],
    keywordModifiers: [],
    energyModifiers: [],
    attacksThisTurn: 0,
    blocksThisTurn: 0,
    usedOncePerTurn: []
  }];
  game.players.P1.hand = [];
  game.players.P2.life = [{ uid: "last-life", owner: "P2", defId: "demo_rookie", faceUp: false }];

  const playout = runAutoplayGame(game, { maxActions: 1, maxTurns: 10 });
  assert.equal(playout.state.winner, "P1");
  assert.equal(playout.state.players.P2.life.length, 0);
});
