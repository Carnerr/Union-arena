import test from "node:test";
import assert from "node:assert/strict";
import {
  CARD_TYPES,
  COUNTERFACTUAL_STATE_EVALUATION_VERSION,
  LINES,
  MAX_LINE_SIZE,
  MIN_LEARNING_EVIDENCE_FILTER_VERSION,
  MIN_LEARNING_SOURCE_DIGEST_VERSION,
  MIN_ML_EVIDENCE_DIVERSITY_VERSION,
  MIN_ML_PAIRWISE_EFFECTIVE_WEIGHT_VERSION,
  MIN_ML_PAIRWISE_INPUT_CONSISTENCY_VERSION,
  MIN_ML_PAIRWISE_ORIENTATION_VERSION,
  MIN_ML_REGRESSION_VERSION,
  MIN_ML_VALIDATION_DIVERSITY_VERSION,
  MIN_ML_VALIDATION_STATE_VERSION,
  PHASES,
  TIMINGS,
  TRIGGER_TYPES,
  actionExplorationEvidence,
  applyAction,
  autoplayActionCandidates,
  blendPilotPolicyWithMatchupOverlay,
  blendPilotPolicyWithMlModel,
  catalogGameResult,
  chooseSetupAction,
  counterfactualAdaptiveStopDecision,
  counterfactualStateEvaluation,
  counterfactualOpportunityScore,
  createSimulationGame,
  legalActions,
  pilotActionFeatures,
  publicOpponentProfile,
  publicTopDeckRequiredEnergyPrediction,
  resolvePilotSetup,
  runAutoplayGame,
  sampleCounterfactualTargetPhase,
  sampleCounterfactualTargetOrdinal,
  setupHandFeatures,
  stampMatchupOverlayImpactValidation,
  scorePilotAction
} from "../src/index.js";
import { sampleCatalog, sampleDeckList } from "../data/sample-cards.js";

function trustedMlEvidenceDiversity() {
  return {
    pairwiseEffectiveWeightVersion: MIN_ML_PAIRWISE_EFFECTIVE_WEIGHT_VERSION,
    pairwiseEffectiveWeight: 12,
    evidenceDiversityVersion: MIN_ML_EVIDENCE_DIVERSITY_VERSION,
    pairwiseEvidenceDiversity: {
      version: MIN_ML_EVIDENCE_DIVERSITY_VERSION,
      trackedExamples: 40,
      historicalUnclassifiedExamples: 0,
      phaseCounts: { attack: 13, block: 13, main: 14 },
      actionPairCounts: {
        "advancePhase <-> playCard:energyLine": 14,
        "declareAttack <-> advancePhase": 13,
        "declareBlock <-> declineBlock": 13
      },
      opponentProfileCounts: { "rnk-red": 20, "tsk-blue": 20 },
      evidenceKindCounts: { "bounded-state-evaluation": 40 }
    }
  };
}

function trustedMlValidation(heldoutPlayerGames = 8) {
  const retainedGameCount = Math.max(1, Math.min(30, heldoutPlayerGames));
  const playerGameCounts = {};
  for (let index = 0; index < 30; index += 1) {
    const key = `heldout-game-${index % retainedGameCount}`;
    playerGameCounts[key] = Number(playerGameCounts[key] ?? 0) + 1;
  }
  return {
    fraction: 0.2,
    heldoutPlayerGames,
    pairwise: {
      examples: 30,
      weightTotal: 12,
      signAccuracy: 0.75,
      balancedSignAccuracy: 0.75,
      positiveExamples: 15,
      negativeExamples: 15,
      inputConsistency: {
        version: MIN_ML_PAIRWISE_INPUT_CONSISTENCY_VERSION,
        complete: true,
        trackedExamples: 30,
        contexts: 12,
        repeatedContexts: 6,
        repeatedExamples: 18,
        repeatedWeight: 7.2,
        conflictingContexts: 0,
        minorityWeight: 0,
        conflictRate: 0
      },
      validationDiversity: {
        version: MIN_ML_VALIDATION_DIVERSITY_VERSION,
        trackedExamples: 30,
        phaseCounts: { main: 10, attack: 10, block: 10 },
        actionPairCounts: {
          "advancephase <-> playcard:energyline": 10,
          "advancephase <-> declareattack": 10,
          "declineblock <-> declareblock": 10
        },
        opponentProfileCounts: { "rnk-red": 15, "tsk-blue": 15 },
        playerGameCounts,
        actionPairReliability: [
          { key: "advancephase <-> playcard:energyline", examples: 10, weightTotal: 4, signAccuracy: 0.7, balancedSignAccuracy: 0.7, positiveExamples: 5, negativeExamples: 5, distinctPlayerGames: Math.min(retainedGameCount, 8) },
          { key: "advancephase <-> declareattack", examples: 10, weightTotal: 4, signAccuracy: 0.8, balancedSignAccuracy: 0.8, positiveExamples: 5, negativeExamples: 5, distinctPlayerGames: Math.min(retainedGameCount, 8) },
          { key: "declineblock <-> declareblock", examples: 10, weightTotal: 4, signAccuracy: 0.7, balancedSignAccuracy: 0.7, positiveExamples: 5, negativeExamples: 5, distinctPlayerGames: Math.min(retainedGameCount, 8) }
        ]
      }
    }
  };
}

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

test("counterfactual target sampling spreads rollouts beyond the first decision", () => {
  assert.equal(sampleCounterfactualTargetOrdinal(() => 0, 12), 0);
  assert.equal(sampleCounterfactualTargetOrdinal(() => 0.5, 12), 6);
  assert.equal(sampleCounterfactualTargetOrdinal(() => 0.999999, 12), 11);
});

test("counterfactual phase sampling follows configured strategic weights", () => {
  const weights = { main: 1, attack: 1, block: 1, movement: 1 };
  assert.equal(sampleCounterfactualTargetPhase(() => 0, weights), "main");
  assert.equal(sampleCounterfactualTargetPhase(() => 0.26, weights), "attack");
  assert.equal(sampleCounterfactualTargetPhase(() => 0.51, weights), "block");
  assert.equal(sampleCounterfactualTargetPhase(() => 0.76, weights), "movement");
});

test("counterfactual opportunities prioritize Raid placement over repeating Raid versus normal play", () => {
  const state = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  }).state;
  state.phase = PHASES.MAIN;
  state.players.P1.hand = [{ uid: "placement-raider", owner: "P1", defId: "demo_raider", faceUp: true }];
  state.players.P1.energyLine = [permanent("P1", "demo_rookie", "placement-base")];
  const candidates = [
    { type: "performRaid", player: "P1", handIndex: 0, targetLine: LINES.ENERGY, targetIndex: 0, moveToFront: true },
    { type: "performRaid", player: "P1", handIndex: 0, targetLine: LINES.ENERGY, targetIndex: 0, moveToFront: false },
    { type: "playCard", player: "P1", handIndex: 0, destination: LINES.FRONT }
  ];

  const opportunity = counterfactualOpportunityScore({
    state,
    playerId: "P1",
    selectedAction: candidates[0],
    selectedIndex: 0,
    candidates,
    decisionPolicy: {}
  });

  assert.equal(opportunity.reason, "raid-placement");
  assert.equal(opportunity.alternativeIndex, 1);
});

test("counterfactual opportunities compare which permanent a full line replaces", () => {
  const state = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  }).state;
  state.phase = PHASES.MAIN;
  state.players.P1.hand = [{ uid: "replacement-rookie", owner: "P1", defId: "demo_rookie", faceUp: true }];
  state.players.P1.frontLine = [
    permanent("P1", "demo_rookie", "replace-left"),
    permanent("P1", "demo_guardian", "replace-right")
  ];
  const candidates = [
    { type: "playCard", player: "P1", handIndex: 0, destination: LINES.FRONT, replaceIndex: 0 },
    { type: "playCard", player: "P1", handIndex: 0, destination: LINES.FRONT, replaceIndex: 1 },
    { type: "playCard", player: "P1", handIndex: 0, destination: LINES.ENERGY }
  ];

  const opportunity = counterfactualOpportunityScore({
    state,
    playerId: "P1",
    selectedAction: candidates[0],
    selectedIndex: 0,
    candidates,
    decisionPolicy: {}
  });

  assert.equal(opportunity.reason, "field-replacement-choice");
  assert.equal(opportunity.alternativeIndex, 1);
});

test("counterfactual state evaluation values strategic resources without hidden-hand leakage", () => {
  const base = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  }).state;
  for (const playerId of ["P1", "P2"]) {
    base.players[playerId].hand = [];
    base.players[playerId].frontLine = [];
    base.players[playerId].energyLine = [];
  }
  const card = (owner, defId, suffix = defId) => ({
    uid: `${owner}-${suffix}`,
    owner,
    defId,
    faceUp: true
  });

  const energyState = structuredClone(base);
  energyState.players.P1.energyLine = [permanent("P1", "demo_rookie", "energy-rookie")];
  assert.ok(
    counterfactualStateEvaluation(energyState, "P1").score
      > counterfactualStateEvaluation(base, "P1").score
  );

  const activeState = structuredClone(base);
  activeState.players.P1.frontLine = [permanent("P1", "demo_raider", "active-raider")];
  const restedState = structuredClone(activeState);
  restedState.players.P1.frontLine[0].rested = true;
  assert.ok(
    counterfactualStateEvaluation(activeState, "P1").score
      > counterfactualStateEvaluation(restedState, "P1").score
  );

  const playableHand = structuredClone(base);
  playableHand.players.P1.hand = [card("P1", "demo_rookie", "playable")];
  const strandedHand = structuredClone(base);
  strandedHand.players.P1.hand = [card("P1", "demo_finisher", "stranded")];
  assert.ok(
    counterfactualStateEvaluation(playableHand, "P1").score
      > counterfactualStateEvaluation(strandedHand, "P1").score
  );

  const hiddenLow = structuredClone(base);
  hiddenLow.players.P2.hand = [card("P2", "demo_rookie", "hidden-low")];
  const hiddenHigh = structuredClone(base);
  hiddenHigh.players.P2.hand = [card("P2", "demo_finisher", "hidden-high")];
  assert.equal(
    counterfactualStateEvaluation(hiddenLow, "P1").score,
    counterfactualStateEvaluation(hiddenHigh, "P1").score
  );

  const won = structuredClone(base);
  won.winner = "P1";
  const lostWithBoard = structuredClone(base);
  lostWithBoard.winner = "P2";
  lostWithBoard.players.P1.frontLine = Array.from({ length: 4 }, (_, index) => (
    permanent("P1", "demo_finisher", `losing-finisher-${index}`)
  ));
  assert.ok(
    counterfactualStateEvaluation(won, "P1").score
      > counterfactualStateEvaluation(lostWithBoard, "P1").score
  );
});

test("top-deck energy predictions cannot infer cards hidden in life", () => {
  const catalog = {
    low: { id: "low", requiredEnergy: { color: "purple", amount: 2 } },
    high: { id: "high", requiredEnergy: { color: "purple", amount: 5 } }
  };
  const card = (defId, uid) => ({ defId, uid, owner: "P1" });
  const first = {
    catalog,
    players: {
      P1: {
        deck: [card("low", 1), card("low", 2), card("low", 3), card("low", 4)],
        life: [card("low", 5), card("high", 6), card("high", 7), card("high", 8)]
      }
    }
  };
  const swapped = {
    catalog,
    players: {
      P1: {
        deck: [card("low", 5), card("high", 6), card("high", 7), card("high", 8)],
        life: [card("low", 1), card("low", 2), card("low", 3), card("low", 4)]
      }
    }
  };

  assert.equal(publicTopDeckRequiredEnergyPrediction(first, "P1"), 2);
  assert.equal(publicTopDeckRequiredEnergyPrediction(swapped, "P1"), 2);
});

test("adaptive counterfactual depth only stops on strong directionally stable evidence", () => {
  const common = {
    adaptive: true,
    requestedHorizon: { targetPlayerTurns: 8 },
    stageHorizon: { targetPlayerTurns: 7 },
    stageEvidence: {
      rolloutHorizon: { comparable: true },
      chosenWinner: null,
      alternativeWinner: null,
      preference: "chosen",
      chosenScore: 1800,
      alternativeScore: 400
    }
  };

  assert.deepEqual(
    counterfactualAdaptiveStopDecision({ ...common, initialScoreDelta: 300 }),
    { eligible: true, terminal: false, reason: "stable-strong-stage" }
  );
  assert.equal(
    counterfactualAdaptiveStopDecision({ ...common, initialScoreDelta: -300 }).eligible,
    false
  );
  assert.equal(
    counterfactualAdaptiveStopDecision({
      ...common,
      initialScoreDelta: 300,
      stageEvidence: { ...common.stageEvidence, chosenScore: 900, alternativeScore: 400 }
    }).eligible,
    false
  );
});

test("setup and mulligan shuffles use deterministic independent streams", () => {
  const setup = (seed) => createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    seed,
    setupMode: "manual"
  }).state;
  const allCards = (state, playerId) => [
    ...state.players[playerId].hand,
    ...state.players[playerId].deck
  ].map((card) => card.defId);
  const mulliganHand = (seed) => {
    const state = applyAction(setup(seed), { type: "mulligan", player: "P1" });
    return state.players.P1.hand.map((card) => card.defId);
  };
  const replacementHandAfterOpponentChoice = ({ seed, playerId, opponentAction }) => {
    const opponentId = playerId === "P1" ? "P2" : "P1";
    let state = setup(seed);
    state = applyAction(state, { type: opponentAction, player: opponentId });
    state = applyAction(state, { type: "mulligan", player: playerId });
    return state.players[playerId].hand.map((card) => card.defId);
  };

  assert.deepEqual(allCards(setup(123), "P1"), allCards(setup(123), "P1"));
  assert.notDeepEqual(allCards(setup(123), "P1"), allCards(setup(124), "P1"));
  assert.notDeepEqual(allCards(setup(123), "P1"), allCards(setup(123), "P2"));
  assert.deepEqual(mulliganHand(123), mulliganHand(123));
  assert.notDeepEqual(mulliganHand(123), mulliganHand(124));
  for (const playerId of ["P1", "P2"]) {
    assert.deepEqual(
      replacementHandAfterOpponentChoice({ seed: 123, playerId, opponentAction: "keepHand" }),
      replacementHandAfterOpponentChoice({ seed: 123, playerId, opponentAction: "mulligan" })
    );
  }
});

function setupStateWithHands({ p1Hand, p2Hand = ["demo_rookie", "demo_stepper", "demo_guardian", "demo_large_body", "demo_raider", "demo_draw_event", "demo_get_trigger"] }) {
  const game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false,
    setupMode: "manual"
  }).state;
  const makeHand = (owner, ids) => ids.map((defId, index) => ({
    uid: `${owner}-manual-${index}`,
    owner,
    defId,
    faceUp: true
  }));
  game.players.P1.hand = makeHand("P1", p1Hand);
  game.players.P2.hand = makeHand("P2", p2Hand);
  game.players.P1.initialHandDefIds = [...p1Hand];
  game.players.P2.initialHandDefIds = [...p2Hand];
  return game;
}

function permanent(owner, defId, pid = `${owner}-${defId}`, rested = false) {
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
    attacksThisTurn: 0,
    blocksThisTurn: 0,
    usedOncePerTurn: []
  };
}

function validatedMatchupOverlay(overlay = {}) {
  const artifact = {
    ...trustedMlEvidenceDiversity(),
    learningSignalVersion: 2,
    trainingPipelineVersion: 2,
    sourceDigestVersion: MIN_LEARNING_SOURCE_DIGEST_VERSION,
    learningEvidenceFilterVersion: MIN_LEARNING_EVIDENCE_FILTER_VERSION,
    regressionVersion: MIN_ML_REGRESSION_VERSION,
    counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION,
    learningSignalTrust: 1,
    examples: 80,
    pairwiseExamples: 80,
    ...overlay
  };
  return stampMatchupOverlayImpactValidation(artifact, {
    verdict: "positive",
    pairedGames: 20,
    validatedAt: "2026-01-01T00:00:00.000Z"
  });
}

test("pilot setup decision keeps playable opening hands", () => {
  const game = setupStateWithHands({
    p1Hand: ["demo_rookie", "demo_stepper", "demo_guardian", "demo_large_body", "demo_raider", "demo_draw_event", "demo_get_trigger"]
  });

  const decision = chooseSetupAction(game, "P1");

  assert.equal(decision.type, "keepHand");
  assert.equal(decision.features.setupPlayableOpener, 1);
  assert.equal(decision.features.setupEnergyPathToThree, 1);
});

test("pilot setup decision mulligans unplayable opening hands", () => {
  const game = setupStateWithHands({
    p1Hand: ["demo_finisher", "demo_finisher", "demo_large_body", "demo_large_body", "demo_draw_event", "demo_draw_event", "demo_site"]
  });

  const decision = chooseSetupAction(game, "P1");

  assert.equal(decision.type, "mulligan");
  assert.equal(decision.features.setupBrick, 1);
});

test("pilot setup resolver applies policy mulligan decisions", () => {
  const game = setupStateWithHands({
    p1Hand: ["demo_finisher", "demo_finisher", "demo_large_body", "demo_large_body", "demo_draw_event", "demo_draw_event", "demo_site"]
  });

  const resolved = resolvePilotSetup(game);

  assert.equal(resolved.players.P1.mulliganUsed, true);
  assert.equal(resolved.players.P2.mulliganUsed, false);
  assert.equal(resolved.setupComplete, true);
});

test("pilot setup resolver records keep and mulligan as learnable alternatives", () => {
  const game = setupStateWithHands({
    p1Hand: ["demo_finisher", "demo_finisher", "demo_large_body", "demo_large_body", "demo_draw_event", "demo_draw_event", "demo_site"]
  });
  const decisions = [];

  resolvePilotSetup(game, undefined, { decisionRecorder: (decision) => decisions.push(decision) });

  assert.equal(decisions.length, 2);
  assert.equal(decisions[0].step, "setup-P1");
  assert.equal(decisions[0].chosenAction.type, "mulligan");
  assert.equal(decisions[0].candidates.length, 2);
  assert.equal(decisions[0].candidates[0].action.type, "keepHand");
  assert.equal(decisions[0].candidates[0].features.setupBrick, 1);
  assert.equal(decisions[0].candidates[1].action.type, "mulligan");
});

test("pilot setup counterfactuals compare keep and mulligan with bounded rollout evidence", () => {
  const game = setupStateWithHands({
    p1Hand: ["demo_finisher", "demo_finisher", "demo_large_body", "demo_large_body", "demo_draw_event", "demo_draw_event", "demo_site"]
  });
  const decisions = [];
  const diagnostics = {};

  resolvePilotSetup(game, undefined, {
    decisionRecorder: (decision) => decisions.push(decision),
    counterfactual: {
      P1: { setupRate: 1, rate: 0, maxPerGame: 1, rolloutMaxActions: 16 },
      P2: null
    },
    maxTurns: 8,
    diagnostics
  });

  const evidence = decisions[0].counterfactual;
  assert.equal(diagnostics.counterfactualsEvaluated, 1);
  assert.equal(diagnostics.evaluatedByPlayer.P1, 1);
  assert.equal(evidence.targetPhase, "setup");
  assert.equal(evidence.decisionPhase, "setup");
  assert.equal(evidence.alternativeSelection, "setup-keep-vs-mulligan");
  assert.equal(evidence.alternativeAction.type, "keepHand");
  assert.equal(evidence.stateEvaluationVersion, COUNTERFACTUAL_STATE_EVALUATION_VERSION);
  assert.ok(["chosen", "alternative", "tie"].includes(evidence.preference));
  assert.ok(evidence.confidence <= 0.45);
  assert.equal(decisions[1].counterfactual, null);
});

test("only validated learning artifacts can influence runtime policy weights", () => {
  const policy = { name: "test", weights: { playCard: 10 } };
  const legacy = blendPilotPolicyWithMlModel(policy, { weights: { playCard: 100 } }, { strength: 1 });
  const trusted = blendPilotPolicyWithMlModel(policy, {
    ...trustedMlEvidenceDiversity(),
    learningSignalVersion: 2,
    trainingPipelineVersion: 2,
    sourceDigestVersion: MIN_LEARNING_SOURCE_DIGEST_VERSION,
    learningEvidenceFilterVersion: MIN_LEARNING_EVIDENCE_FILTER_VERSION,
    validationAssignmentVersion: 2,
    validationStateVersion: MIN_ML_VALIDATION_STATE_VERSION,
    pairwiseOrientationVersion: MIN_ML_PAIRWISE_ORIENTATION_VERSION,
    regressionVersion: MIN_ML_REGRESSION_VERSION,
    counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION,
    learningSignalTrust: 0.8,
    pairwiseExamples: 30,
    validation: trustedMlValidation(8),
    weights: { playCard: 100 }
  }, { strength: 1 });
  const noPairwiseTrusted = blendPilotPolicyWithMlModel(policy, {
    learningSignalVersion: 2,
    trainingPipelineVersion: 2,
    sourceDigestVersion: MIN_LEARNING_SOURCE_DIGEST_VERSION,
    learningEvidenceFilterVersion: MIN_LEARNING_EVIDENCE_FILTER_VERSION,
    validationAssignmentVersion: 2,
    validationStateVersion: MIN_ML_VALIDATION_STATE_VERSION,
    pairwiseOrientationVersion: MIN_ML_PAIRWISE_ORIENTATION_VERSION,
    regressionVersion: MIN_ML_REGRESSION_VERSION,
    counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION,
    learningSignalTrust: 0.8,
    validation: { heldoutPlayerGames: 8 },
    weights: { playCard: 100 }
  }, { strength: 1 });
  const staleEvaluatorModel = blendPilotPolicyWithMlModel(policy, {
    learningSignalVersion: 2,
    trainingPipelineVersion: 2,
    sourceDigestVersion: MIN_LEARNING_SOURCE_DIGEST_VERSION,
    learningEvidenceFilterVersion: MIN_LEARNING_EVIDENCE_FILTER_VERSION,
    validationAssignmentVersion: 2,
    validationStateVersion: MIN_ML_VALIDATION_STATE_VERSION,
    pairwiseOrientationVersion: MIN_ML_PAIRWISE_ORIENTATION_VERSION,
    regressionVersion: MIN_ML_REGRESSION_VERSION,
    counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION - 1,
    learningSignalTrust: 1,
    pairwiseExamples: 100,
    validation: { heldoutPlayerGames: 40 },
    weights: { playCard: 100 }
  }, { strength: 1 });
  const staleRegressionModel = blendPilotPolicyWithMlModel(policy, {
    learningSignalVersion: 2,
    trainingPipelineVersion: 2,
    sourceDigestVersion: MIN_LEARNING_SOURCE_DIGEST_VERSION,
    learningEvidenceFilterVersion: MIN_LEARNING_EVIDENCE_FILTER_VERSION,
    validationAssignmentVersion: 2,
    validationStateVersion: MIN_ML_VALIDATION_STATE_VERSION,
    pairwiseOrientationVersion: MIN_ML_PAIRWISE_ORIENTATION_VERSION,
    regressionVersion: MIN_ML_REGRESSION_VERSION - 1,
    counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION,
    learningSignalTrust: 1,
    pairwiseExamples: 100,
    validation: { heldoutPlayerGames: 40 },
    weights: { playCard: 100 }
  }, { strength: 1 });
  const prePipelineModel = blendPilotPolicyWithMlModel(policy, {
    learningSignalVersion: 2,
    learningSignalTrust: 1,
    pairwiseExamples: 100,
    validation: { heldoutPlayerGames: 40 },
    weights: { playCard: 100 }
  }, { strength: 1 });
  const provisional = blendPilotPolicyWithMlModel(policy, {
    learningSignalVersion: 2,
    learningSignalTrust: 0.05,
    weights: { playCard: 100 }
  }, { strength: 1 });
  const blockedTrusted = blendPilotPolicyWithMlModel(policy, {
    learningSignalVersion: 2,
    trainingPipelineVersion: 2,
    sourceDigestVersion: MIN_LEARNING_SOURCE_DIGEST_VERSION,
    learningEvidenceFilterVersion: MIN_LEARNING_EVIDENCE_FILTER_VERSION,
    validationAssignmentVersion: 2,
    validationStateVersion: MIN_ML_VALIDATION_STATE_VERSION,
    pairwiseOrientationVersion: MIN_ML_PAIRWISE_ORIENTATION_VERSION,
    regressionVersion: MIN_ML_REGRESSION_VERSION,
    counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION,
    learningSignalTrust: 1,
    learningHealth: { status: "blocked" },
    pairwiseExamples: 30,
    validation: { heldoutPlayerGames: 40 },
    weights: { playCard: 100 }
  }, { strength: 1 });
  const outcomeAnchored = blendPilotPolicyWithMlModel(policy, {
    learningSignalVersion: 2,
    trainingPipelineVersion: 2,
    sourceDigestVersion: MIN_LEARNING_SOURCE_DIGEST_VERSION,
    learningEvidenceFilterVersion: MIN_LEARNING_EVIDENCE_FILTER_VERSION,
    validationAssignmentVersion: 2,
    validationStateVersion: MIN_ML_VALIDATION_STATE_VERSION,
    pairwiseOrientationVersion: MIN_ML_PAIRWISE_ORIENTATION_VERSION,
    regressionVersion: MIN_ML_REGRESSION_VERSION,
    counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION,
    learningSignalTrust: 1,
    includeChosenAnchor: true,
    pairwiseExamples: 100,
    validation: { heldoutPlayerGames: 40 },
    weights: { playCard: 100 }
  }, { strength: 1 });
  const legacyOverlay = blendPilotPolicyWithMatchupOverlay(policy, {
    weights: { playCard: 100 }
  }, { strength: 1, confidence: 1 });
  const trustedOverlay = blendPilotPolicyWithMatchupOverlay(policy, validatedMatchupOverlay({
    weights: { playCard: 100 }
  }), { strength: 1, confidence: 1 });
  const staleEvaluatorArtifact = validatedMatchupOverlay({ weights: { playCard: 100 } });
  staleEvaluatorArtifact.counterfactualStateEvaluationVersion = COUNTERFACTUAL_STATE_EVALUATION_VERSION - 1;
  const staleEvaluatorOverlay = blendPilotPolicyWithMatchupOverlay(policy, staleEvaluatorArtifact, { strength: 1, confidence: 1 });
  const staleRegressionArtifact = validatedMatchupOverlay({ weights: { playCard: 100 } });
  staleRegressionArtifact.regressionVersion = MIN_ML_REGRESSION_VERSION - 1;
  const staleRegressionOverlay = blendPilotPolicyWithMatchupOverlay(policy, staleRegressionArtifact, { strength: 1, confidence: 1 });
  const prePipelineOverlay = blendPilotPolicyWithMatchupOverlay(policy, {
    learningSignalVersion: 2,
    learningSignalTrust: 1,
    weights: { playCard: 100 }
  }, { strength: 1, confidence: 1 });
  const staleValidatedArtifact = validatedMatchupOverlay({ weights: { playCard: 100 } });
  staleValidatedArtifact.weights.playCard = 200;
  const staleValidatedOverlay = blendPilotPolicyWithMatchupOverlay(policy, staleValidatedArtifact, {
    strength: 1,
    confidence: 1
  });
  const blockedOverlay = blendPilotPolicyWithMatchupOverlay(policy, {
    learningSignalVersion: 2,
    trainingPipelineVersion: 2,
    sourceDigestVersion: MIN_LEARNING_SOURCE_DIGEST_VERSION,
    learningEvidenceFilterVersion: MIN_LEARNING_EVIDENCE_FILTER_VERSION,
    regressionVersion: MIN_ML_REGRESSION_VERSION,
    counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION,
    learningSignalTrust: 1,
    learningHealth: { status: "blocked" },
    weights: { playCard: 100 }
  }, { strength: 1, confidence: 1 });
  const outcomeAnchoredArtifact = validatedMatchupOverlay({ weights: { playCard: 100 } });
  outcomeAnchoredArtifact.includeChosenAnchor = true;
  const outcomeAnchoredOverlay = blendPilotPolicyWithMatchupOverlay(policy, outcomeAnchoredArtifact, { strength: 1, confidence: 1 });

  assert.equal(legacy.weights.playCard, 10);
  assert.equal(trusted.weights.playCard, 90);
  assert.equal(noPairwiseTrusted.weights.playCard, 10);
  assert.equal(staleEvaluatorModel.weights.playCard, 10);
  assert.equal(staleRegressionModel.weights.playCard, 10);
  assert.equal(prePipelineModel.weights.playCard, 10);
  assert.equal(provisional.weights.playCard, 10);
  assert.equal(blockedTrusted.weights.playCard, 10);
  assert.equal(outcomeAnchored.weights.playCard, 10);
  assert.equal(legacyOverlay.weights.playCard, 10);
  assert.equal(trustedOverlay.weights.playCard, 110);
  assert.equal(staleEvaluatorOverlay.weights.playCard, 10);
  assert.equal(staleRegressionOverlay.weights.playCard, 10);
  assert.equal(prePipelineOverlay.weights.playCard, 10);
  assert.equal(staleValidatedOverlay.weights.playCard, 10);
  assert.equal(blockedOverlay.weights.playCard, 10);
  assert.equal(outcomeAnchoredOverlay.weights.playCard, 10);
  assert.throws(() => stampMatchupOverlayImpactValidation({ weights: {} }, {
    verdict: "negative",
    pairedGames: 20
  }), /Only a positive/u);
  assert.throws(() => stampMatchupOverlayImpactValidation({ weights: {} }, {
    verdict: "positive",
    pairedGames: 4
  }), /at least 12 paired games/u);
  assert.throws(() => stampMatchupOverlayImpactValidation({
    learningSignalVersion: 2,
    trainingPipelineVersion: 2,
    sourceDigestVersion: MIN_LEARNING_SOURCE_DIGEST_VERSION,
    learningEvidenceFilterVersion: MIN_LEARNING_EVIDENCE_FILTER_VERSION,
    regressionVersion: MIN_ML_REGRESSION_VERSION,
    counterfactualStateEvaluationVersion: COUNTERFACTUAL_STATE_EVALUATION_VERSION,
    learningSignalTrust: 1,
    pairwiseExamples: 100,
    weights: {}
  }, {
    verdict: "positive",
    pairedGames: 20
  }), /causal evidence breadth/u);
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
  assert.equal(result.p1SetupOpenersSeen, 1);
  assert.equal(result.p2SetupOpenersSeen, 1);
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

test("autoplay can record decision candidates for ML training data", () => {
  const simulation = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    seed: 17001
  });
  const decisions = [];
  const playout = runAutoplayGame(simulation.state, {
    maxActions: 1,
    maxTurns: 4,
    decisionRecorder: (decision) => decisions.push(decision)
  });

  assert.equal(playout.steps, 1);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].candidates.some((candidate) => candidate.chosen), true);
  assert.equal(typeof decisions[0].candidates[0].score, "number");
  assert.equal(typeof decisions[0].candidates[0].features.baseScore, "number");
});

test("autoplay can pass main phase instead of forcing a bad play", () => {
  const game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    seed: 17011,
    validateDecks: false
  }).state;
  game.phase = PHASES.MAIN;
  game.activePlayer = "P1";
  game.players.P1.hand = [{
    uid: "P1-bad-play",
    owner: "P1",
    defId: "demo_rookie",
    faceUp: true
  }];
  const decisions = [];

  const playout = runAutoplayGame(game, {
    maxActions: 1,
    policy: {
      P1: {
        weights: {
          baseScore: 0,
          advancePhase: 100,
          playCard: -1000,
          playToEnergy: -1000,
          playToFront: -1000,
          lowCostUnit: -1000,
          roleOpener: -1000,
          roleEnergyBuilder: -1000
        }
      }
    },
    decisionRecorder: (decision) => decisions.push(decision)
  });

  assert.equal(playout.steps, 1);
  assert.equal(decisions[0].chosenAction.type, "advancePhase");
  assert.equal(playout.state.phase, PHASES.ATTACK);
  assert.equal(playout.state.players.P1.hand.length, 1);
});

test("autoplay can pass attack phase instead of forcing a bad attack", () => {
  const game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    seed: 17012,
    validateDecks: false
  }).state;
  game.phase = PHASES.ATTACK;
  game.activePlayer = "P1";
  game.players.P1.frontLine = [permanent("P1", "demo_rookie", "attack-pass-rookie")];
  game.players.P2.frontLine = [];
  const p2LifeBefore = game.players.P2.life.length;
  const decisions = [];

  const playout = runAutoplayGame(game, {
    maxActions: 1,
    policy: {
      P1: {
        weights: {
          baseScore: 0,
          advancePhase: 100,
          attackPlayer: -1000,
          damageThreat: -1000,
          lifePressure: -1000,
          lowLifePressure: -1000,
          openLaneDamage: -1000,
          passWithReadyAttackers: 0,
          passMissedDamage: 0,
          passMissedLethal: 0
        }
      }
    },
    decisionRecorder: (decision) => decisions.push(decision)
  });

  assert.equal(playout.steps, 1);
  assert.equal(decisions[0].chosenAction.type, "advancePhase");
  assert.equal(playout.state.phase, PHASES.END);
  assert.equal(playout.state.players.P2.life.length, p2LifeBefore);
});

test("public opponent profile becomes confident after one public card", () => {
  const game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    seed: 17003
  }).state;
  assert.equal(publicOpponentProfile(game, "P1").known, false);

  game.players.P2.frontLine = [permanent("P2", "demo_rookie", "known-opener")];
  const profile = publicOpponentProfile(game, "P1");

  assert.equal(profile.known, true);
  assert.equal(profile.key, "dem-green");
  assert.equal(profile.confidence, 1);
  assert.deepEqual(profile.observedLowCostCardIds, ["demo_rookie"]);
});

test("public opponent profile includes cards revealed to the player", () => {
  const game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    seed: 17005
  }).state;
  game.publicKnowledge.P1.players.P2.revealedCards.push({
    uid: "remembered-opponent-opener",
    owner: "P2",
    defId: "demo_rookie",
    firstKnownZone: "hand",
    lastKnownZone: "hand"
  });

  const profile = publicOpponentProfile(game, "P1");

  assert.equal(profile.known, true);
  assert.equal(profile.key, "dem-green");
  assert.deepEqual(profile.observedLowCostCardIds, ["demo_rookie"]);
});

test("public opponent profile uses local source material code for product-prefixed cards", () => {
  const catalog = {
    ...sampleCatalog,
    ue15st_eva_1_112: {
      ...sampleCatalog.demo_guardian,
      id: "ue15st_eva_1_112",
      number: "UE15ST_EVA-1-112",
      sourceCode: "UE15ST",
      name: "EVA Starter Opener",
      color: "purple",
      requiredEnergy: { color: "purple", amount: 1 }
    }
  };
  const game = createSimulationGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    seed: 17006,
    validateDecks: false
  }).state;
  game.players.P2.energyLine = [permanent("P2", "ue15st_eva_1_112", "known-eva")];

  const profile = publicOpponentProfile(game, "P1");

  assert.equal(profile.key, "eva-purple");
  assert.equal(profile.sourceCode, "EVA");
});

test("public opponent profile ranks saved deck fingerprints from observed cards only", () => {
  const game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    seed: 17007
  }).state;
  game.players.P2.frontLine = [permanent("P2", "demo_rookie", "known-rookie")];

  const profile = publicOpponentProfile(game, "P1", {
    deckFingerprints: [
      {
        id: "known-demo-build",
        name: "Known Demo Build",
        key: "dem-green",
        sourceCode: "DEM",
        colorKey: "green",
        colors: ["green"],
        cardCounts: { demo_rookie: 4, demo_stepper: 4 }
      },
      {
        id: "other-demo-build",
        name: "Other Demo Build",
        key: "dem-green",
        sourceCode: "DEM",
        colorKey: "green",
        colors: ["green"],
        cardCounts: { demo_guardian: 4 }
      }
    ]
  });

  assert.equal(profile.deckCandidateId, "known-demo-build");
  assert.equal(profile.deckCandidates[0].observedCoverage, 1);
  assert.equal(profile.deckCandidates[1].missing, 1);
});

test("public opponent profile keeps saved deck fingerprints broad by default", () => {
  const game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    seed: 17008
  }).state;
  game.players.P2.frontLine = [permanent("P2", "demo_rookie", "known-rookie")];

  const profile = publicOpponentProfile(game, "P1", {
    deckFingerprints: [
      {
        id: "known-demo-build",
        name: "Known Demo Build",
        key: "dem-green",
        sourceCode: "DEM",
        colorKey: "green",
        colors: ["green"],
        cardCounts: { demo_rookie: 4, demo_stepper: 4 }
      },
      {
        id: "other-demo-build",
        name: "Other Demo Build",
        key: "dem-green",
        sourceCode: "DEM",
        colorKey: "green",
        colors: ["green"],
        cardCounts: { demo_guardian: 4 }
      }
    ]
  });

  assert.equal(profile.deckCandidateId, "known-demo-build");
  assert.equal(profile.variantStatus, "broad");
  assert.equal(profile.variantKey, "dem-green");
  assert.equal(profile.variantReason, "saved-deck-fingerprint-not-distinct");
});

test("public opponent profile promotes close saved archetype fingerprints without player-specific variants", () => {
  const game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    seed: 170081
  }).state;
  game.players.P2.frontLine = [permanent("P2", "demo_rookie", "known-rookie")];

  const profile = publicOpponentProfile(game, "P1", {
    deckFingerprints: [
      {
        id: "regional-demo-rookie-player",
        name: "Regional Demo Rookie Player",
        key: "dem-green-rookie-core",
        setColorKey: "dem-green",
        sourceCode: "DEM",
        colorKey: "green",
        colors: ["green"],
        cardCounts: { demo_rookie: 4, demo_stepper: 4 }
      },
      {
        id: "regional-demo-guardian-player",
        name: "Regional Demo Guardian Player",
        key: "dem-green-guardian-core",
        setColorKey: "dem-green",
        sourceCode: "DEM",
        colorKey: "green",
        colors: ["green"],
        cardCounts: { demo_guardian: 4 }
      }
    ]
  });

  assert.equal(profile.key, "dem-green");
  assert.equal(profile.deckCandidateId, "regional-demo-rookie-player");
  assert.equal(profile.variantStatus, "known-archetype");
  assert.equal(profile.variantKey, "dem-green-rookie-core");
  assert.equal(profile.variantReason, "saved-archetype-fingerprint");
});

test("public opponent profile can opt into known-deck variant keys", () => {
  const game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    seed: 17008
  }).state;
  game.players.P2.frontLine = [permanent("P2", "demo_rookie", "known-rookie")];

  const profile = publicOpponentProfile(game, "P1", {
    knownDeckVariants: true,
    deckFingerprints: [
      {
        id: "known-demo-build",
        name: "Known Demo Build",
        key: "dem-green",
        sourceCode: "DEM",
        colorKey: "green",
        colors: ["green"],
        cardCounts: { demo_rookie: 4, demo_stepper: 4 }
      }
    ]
  });

  assert.equal(profile.variantStatus, "known-deck");
  assert.equal(profile.variantKey, "dem-green__deck-known-demo-build");
});

test("public opponent profile logs unknown variants when public cards do not fit a saved list", () => {
  const game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    seed: 17009
  }).state;
  game.players.P2.frontLine = [
    permanent("P2", "demo_rookie", "known-rookie"),
    permanent("P2", "demo_stepper", "known-stepper")
  ];
  game.players.P2.energyLine = [
    permanent("P2", "demo_guardian", "known-guardian"),
    permanent("P2", "demo_raider", "known-raider")
  ];

  const profile = publicOpponentProfile(game, "P1", {
    deckFingerprints: [{
      id: "other-demo-build",
      name: "Other Demo Build",
      key: "dem-green",
      sourceCode: "DEM",
      colorKey: "green",
      colors: ["green"],
      cardCounts: { demo_guardian: 4 }
    }]
  });

  assert.equal(profile.variantStatus, "unknown-variant");
  assert.equal(profile.variantKey.startsWith("dem-green__unknown-"), true);
  assert.equal(profile.variantReason, "observed-cards-do-not-fit-saved-fingerprint");
  assert.ok(profile.variantCardIds.includes("demo_rookie"));
});

test("autoplay selects matchup overlay after public profile confidence is high enough", () => {
  const game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    seed: 17004
  }).state;
  game.players.P2.frontLine = [permanent("P2", "demo_rookie", "known-opener")];
  const decisions = [];

  runAutoplayGame(game, {
    maxActions: 1,
    maxTurns: 4,
    matchupOverlays: {
      P1: {
        enabled: true,
        minConfidence: 0.7,
        strength: 1,
        overlays: {
          "dem-green": {
            path: "demo-overlay.json",
            overlay: validatedMatchupOverlay({
              name: "demo-overlay",
              opponentKey: "dem-green",
              weights: { extraDraw: 10 }
            })
          }
        }
      }
    },
    decisionRecorder: (decision) => decisions.push(decision)
  });

  assert.equal(decisions[0].matchupProfile.key, "dem-green");
  assert.equal(decisions[0].matchupOverlayPath, "demo-overlay.json");
});

test("autoplay prefers variant matchup overlay before broad set-color overlay", () => {
  const game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    seed: 17010
  }).state;
  game.players.P2.frontLine = [permanent("P2", "demo_rookie", "known-opener")];
  const decisions = [];

  runAutoplayGame(game, {
    maxActions: 1,
    maxTurns: 4,
    matchupDeckFingerprints: {
      P1: [{
        id: "known-demo-build",
        name: "Known Demo Build",
        key: "dem-green",
        sourceCode: "DEM",
        colorKey: "green",
        colors: ["green"],
        cardCounts: { demo_rookie: 4, demo_stepper: 4 }
      }]
    },
    matchupOverlays: {
      P1: {
        enabled: true,
        minConfidence: 0.7,
        knownDeckVariants: true,
        strength: 1,
        overlays: {
          "dem-green": {
            path: "broad-overlay.json",
            overlay: validatedMatchupOverlay({
              name: "broad-overlay",
              opponentKey: "dem-green",
              weights: { extraDraw: 10 }
            })
          },
          "dem-green__deck-known-demo-build": {
            path: "variant-overlay.json",
            overlay: validatedMatchupOverlay({
              name: "variant-overlay",
              opponentKey: "dem-green__deck-known-demo-build",
              weights: { extraDraw: 20 }
            })
          }
        }
      }
    },
    decisionRecorder: (decision) => decisions.push(decision)
  });

  assert.equal(decisions[0].matchupProfile.variantKey, "dem-green__deck-known-demo-build");
  assert.equal(decisions[0].matchupOverlayPath, "variant-overlay.json");
});

test("autoplay falls back to validated broad overlay while a variant is quarantined", () => {
  const game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    seed: 17011
  }).state;
  game.players.P2.frontLine = [permanent("P2", "demo_rookie", "known-opener")];
  const decisions = [];

  runAutoplayGame(game, {
    maxActions: 1,
    maxTurns: 4,
    matchupDeckFingerprints: {
      P1: [{
        id: "known-demo-build",
        name: "Known Demo Build",
        key: "dem-green",
        sourceCode: "DEM",
        colorKey: "green",
        colors: ["green"],
        cardCounts: { demo_rookie: 4, demo_stepper: 4 }
      }]
    },
    matchupOverlays: {
      P1: {
        enabled: true,
        minConfidence: 0.7,
        knownDeckVariants: true,
        overlays: {
          "dem-green": {
            path: "validated-broad.json",
            overlay: validatedMatchupOverlay({ opponentKey: "dem-green", weights: { extraDraw: 10 } })
          },
          "dem-green__deck-known-demo-build": {
            path: "quarantined-variant.json",
            overlay: {
              learningSignalVersion: 2,
              trainingPipelineVersion: 2,
              learningSignalTrust: 1,
              opponentKey: "dem-green__deck-known-demo-build",
              weights: { extraDraw: 20 }
            }
          }
        }
      }
    },
    decisionRecorder: (decision) => decisions.push(decision)
  });

  assert.equal(decisions[0].matchupProfile.variantKey, "dem-green__deck-known-demo-build");
  assert.equal(decisions[0].matchupOverlayPath, "validated-broad.json");
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

test("autoplay can choose Step movement back to energy when policy values it", () => {
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

  const playout = runAutoplayGame(game, {
    maxActions: 1,
    maxTurns: 10,
    policy: {
      P1: {
        weights: {
          baseScore: 0,
          advancePhase: -100,
          moveToEnergy: 500,
          movedToEnergyBp: 0
        }
      }
    }
  });

  assert.equal(playout.state.phase, PHASES.MOVEMENT);
  assert.equal(playout.state.players.P1.frontLine.length, 0);
  assert.equal(playout.state.players.P1.energyLine.length, 1);
});

test("autoplay discards the lowest-value hand cards for end phase hand limit", () => {
  const game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  }).state;
  game.phase = PHASES.END;
  game.activePlayer = "P1";
  game.players.P1.hand = [
    "demo_finisher",
    "demo_raider",
    "demo_large_body",
    "demo_guardian",
    "demo_rookie",
    "demo_stepper",
    "demo_get_trigger",
    "demo_blocker",
    "demo_draw_event"
  ].map((defId, index) => ({
    uid: `hand-limit-${index}`,
    owner: "P1",
    defId,
    faceUp: true
  }));

  const playout = runAutoplayGame(game, { maxActions: 1, maxTurns: 10 });

  assert.equal(playout.state.players.P1.hand.length, 8);
  assert.equal(playout.state.players.P1.removal.at(-1).defId, "demo_draw_event");
  assert.equal(playout.state.players.P1.hand.some((card) => card.defId === "demo_finisher"), true);
});

test("autoplay supplies replacement choices for start-of-attack hand plays", () => {
  const catalog = {
    filler: {
      id: "filler",
      number: "TST-1-001",
      sourceCode: "TST",
      name: "Filler",
      type: CARD_TYPES.CHARACTER,
      color: "red",
      requiredEnergy: { color: "red", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "red", amount: 1 }],
      affinities: [],
      abilities: []
    },
    attack_guest: {
      id: "attack_guest",
      number: "TST-1-002",
      sourceCode: "TST",
      name: "Attack Guest",
      type: CARD_TYPES.CHARACTER,
      color: "red",
      requiredEnergy: { color: "red", amount: 9 },
      apCost: 0,
      bp: 2000,
      energy: [{ color: "red", amount: 1 }],
      affinities: [],
      abilities: [
        {
          id: "startOfAttackPhase-1",
          timing: TIMINGS.START_OF_ATTACK_PHASE,
          conditions: { zone: "hand" },
          effect: {
            kind: "optional",
            choiceKey: "optionalEffect",
            default: true,
            effect: {
              kind: "playSourceFromZone",
              source: "hand",
              rested: false,
              destinationLine: LINES.FRONT
            }
          }
        }
      ]
    }
  };
  const deck = [{ id: "filler", count: 50 }];
  let game = createSimulationGame({
    catalog,
    decks: { P1: deck, P2: deck },
    skipShuffle: true,
    validateDecks: false,
    setupMode: "manual"
  }).state;
  game = applyAction(game, { type: "keepHand", player: "P1" });
  game = applyAction(game, { type: "keepHand", player: "P2" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  for (let i = 0; i < 4; i += 1) {
    game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0, destination: LINES.FRONT });
  }
  game.players.P1.hand = [{ uid: "manual-attack-guest", owner: "P1", defId: "attack_guest", faceUp: true }];

  assert.equal(game.phase, PHASES.MAIN);
  assert.equal(game.players.P1.frontLine.length, 4);

  const playout = runAutoplayGame(game, { maxActions: 1, maxTurns: 10 });
  assert.notEqual(playout.stoppedReason, "noLegalAutoplayAction");
  assert.equal(playout.state.phase, PHASES.ATTACK);
  assert.equal(playout.state.players.P1.frontLine.length, 4);
  assert.equal(playout.state.players.P1.frontLine.some((permanent) => permanent.cards.at(-1).defId === "attack_guest"), true);
});

test("autoplay supplies replacement choices for life triggers during attack damage", () => {
  const catalog = {
    filler: {
      id: "filler",
      number: "TST-1-001",
      sourceCode: "TST",
      name: "Filler",
      type: CARD_TYPES.CHARACTER,
      color: "red",
      requiredEnergy: { color: "red", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "red", amount: 1 }],
      affinities: [],
      abilities: []
    },
    attacker: {
      id: "attacker",
      number: "TST-1-002",
      sourceCode: "TST",
      name: "Attacker",
      type: CARD_TYPES.CHARACTER,
      color: "red",
      requiredEnergy: { color: "red", amount: 0 },
      apCost: 0,
      bp: 2000,
      energy: [{ color: "red", amount: 1 }],
      affinities: [],
      abilities: []
    },
    color_guest: {
      id: "color_guest",
      number: "TST-1-003",
      sourceCode: "TST",
      name: "Color Guest",
      type: CARD_TYPES.CHARACTER,
      color: "red",
      requiredEnergy: { color: "red", amount: 0 },
      apCost: 0,
      bp: 1500,
      energy: [{ color: "red", amount: 1 }],
      affinities: [],
      abilities: [],
      trigger: {
        type: TRIGGER_TYPES.COLOR,
        effect: {
          kind: "playSourceFromZone",
          source: "sideline",
          rested: false,
          destinationLine: LINES.FRONT
        }
      }
    }
  };
  const deck = [{ id: "filler", count: 50 }];
  const card = (owner, defId, uid) => ({ uid, owner, defId, faceUp: true });
  const permanent = (owner, defId, pid, rested) => ({
    pid,
    owner,
    controller: owner,
    cards: [card(owner, defId, `${pid}-card`)],
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
  });

  let game = createSimulationGame({
    catalog,
    decks: { P1: deck, P2: deck },
    skipShuffle: true,
    validateDecks: false,
    setupMode: "manual"
  }).state;
  game = applyAction(game, { type: "keepHand", player: "P1" });
  game = applyAction(game, { type: "keepHand", player: "P2" });
  game.phase = PHASES.ATTACK;
  game.activePlayer = "P1";
  game.players.P1.frontLine = [permanent("P1", "attacker", "attacker-perm", false)];
  game.players.P2.frontLine = [0, 1, 2, 3].map((index) => permanent("P2", "filler", `blocker-${index}`, true));
  game.players.P2.life = [
    card("P2", "color_guest", "life-color-trigger"),
    ...[1, 2, 3, 4, 5, 6].map((index) => card("P2", "filler", `life-filler-${index}`))
  ];

  const playout = runAutoplayGame(game, { maxActions: 2, maxTurns: 10 });

  assert.notEqual(playout.stoppedReason, "noLegalAutoplayAction");
  assert.equal(playout.state.players.P2.life.length, 6);
  assert.equal(playout.state.players.P2.frontLine.length, 4);
  assert.equal(playout.state.players.P2.frontLine.some((item) => item.cards.at(-1).defId === "color_guest"), true);
  assert.equal(playout.state.players.P2.removal.length, 1);
});

test("trigger replacements that require hand payment are skipped when unpaid", () => {
  const catalog = {
    filler: {
      id: "filler",
      number: "TST-1-001",
      sourceCode: "TST",
      name: "Filler",
      type: CARD_TYPES.CHARACTER,
      color: "red",
      requiredEnergy: { color: "red", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "red", amount: 1 }],
      affinities: [],
      abilities: []
    },
    attacker: {
      id: "attacker",
      number: "TST-1-002",
      sourceCode: "TST",
      name: "Attacker",
      type: CARD_TYPES.CHARACTER,
      color: "red",
      requiredEnergy: { color: "red", amount: 0 },
      apCost: 0,
      bp: 2000,
      energy: [{ color: "red", amount: 1 }],
      affinities: [],
      abilities: []
    },
    replacer: {
      id: "replacer",
      number: "TST-1-003",
      sourceCode: "TST",
      name: "Replacement Watcher",
      type: CARD_TYPES.CHARACTER,
      color: "red",
      requiredEnergy: { color: "red", amount: 0 },
      apCost: 0,
      bp: 1500,
      energy: [{ color: "red", amount: 1 }],
      affinities: [],
      abilities: [],
      triggerReplacements: [
        {
          triggerType: TRIGGER_TYPES.GET,
          effect: {
            kind: "sequence",
            effects: [
              { kind: "playSourceFromZone", source: "sideline", rested: true, destinationLine: LINES.FRONT },
              { kind: "moveHandToZone", amount: 1, destination: "sideline" }
            ]
          }
        }
      ]
    },
    get_guest: {
      id: "get_guest",
      number: "TST-1-004",
      sourceCode: "TST",
      name: "Get Guest",
      type: CARD_TYPES.CHARACTER,
      color: "red",
      requiredEnergy: { color: "red", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "red", amount: 1 }],
      affinities: [],
      abilities: [],
      trigger: { type: TRIGGER_TYPES.GET }
    }
  };
  const deck = [{ id: "filler", count: 50 }];
  const card = (owner, defId, uid) => ({ uid, owner, defId, faceUp: true });
  const permanent = (owner, defId, pid, rested) => ({
    pid,
    owner,
    controller: owner,
    cards: [card(owner, defId, `${pid}-card`)],
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
  });

  let game = createSimulationGame({
    catalog,
    decks: { P1: deck, P2: deck },
    skipShuffle: true,
    validateDecks: false,
    setupMode: "manual"
  }).state;
  game = applyAction(game, { type: "keepHand", player: "P1" });
  game = applyAction(game, { type: "keepHand", player: "P2" });
  game.phase = PHASES.ATTACK;
  game.activePlayer = "P1";
  game.players.P1.frontLine = [permanent("P1", "attacker", "attacker-perm", false)];
  game.players.P2.frontLine = [permanent("P2", "replacer", "replacer-perm", true)];
  game.players.P2.life = [card("P2", "get_guest", "life-get-trigger")];
  game.players.P2.hand = [];

  game = applyAction(game, { type: "declareAttack", player: "P1", attackerIndex: 0, target: { type: "player" } });
  game = applyAction(game, { type: "declineBlock", player: "P2" });

  assert.equal(game.players.P2.hand.length, 1);
  assert.equal(game.players.P2.hand[0].defId, "get_guest");
  assert.equal(game.players.P2.frontLine.length, 1);
  assert.equal(game.players.P2.frontLine[0].cards.at(-1).defId, "replacer");
});

test("exploration evidence distinguishes learned support from session attempts", () => {
  const feature = "context.play.card.demo_raider";
  const evidence = actionExplorationEvidence({ [feature]: 1 }, {
    targetObservations: 24,
    featureObservations: { [feature]: 3 },
    featureAttempts: { [feature]: 7 }
  });

  assert.equal(evidence.status, "collecting");
  assert.equal(evidence.observations, 3);
  assert.equal(evidence.attempts, 7);
  assert.ok(evidence.noveltyMultiplier > 1);
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

test("autoplay can explore playing a Raid card normally when it is a plausible alternative", () => {
  let game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true
  }).state;
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  const permanent = (index) => ({
    pid: `explore-energy-${index}`,
    owner: "P1",
    controller: "P1",
    cards: [{ uid: `explore-energy-${index}-card`, owner: "P1", defId: "demo_rookie", faceUp: true }],
    rested: false,
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
  });
  game.players.P1.energyLine = Array.from({ length: MAX_LINE_SIZE }, (_, index) => permanent(index));
  game.players.P1.frontLine = [];
  game.players.P1.hand.unshift({ uid: "test-raider", owner: "P1", defId: "demo_raider", faceUp: true });

  const playout = runAutoplayGame(game, {
    maxActions: 1,
    maxTurns: 10,
    exploration: {
      raidNormalPlayRate: 1,
      raidNormalPlayScoreWindow: 1000,
      maxRank: 12
    }
  });
  assert.equal(playout.state.players.P1.energyLine.length, MAX_LINE_SIZE);
  assert.equal(playout.state.players.P1.frontLine.length, 1);
  assert.equal(playout.state.players.P1.frontLine[0].cards.length, 1);
  assert.equal(playout.state.players.P1.frontLine[0].cards[0].defId, "demo_raider");
});

test("autoplay exploration does not take Raid normal-play lines outside the score window", () => {
  let game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true
  }).state;
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0, destination: LINES.ENERGY });
  game.players.P1.hand.unshift({ uid: "test-raider", owner: "P1", defId: "demo_raider", faceUp: true });

  const playout = runAutoplayGame(game, {
    maxActions: 1,
    maxTurns: 10,
    exploration: {
      raidNormalPlayRate: 1,
      raidNormalPlayScoreWindow: 1,
      raidNormalPlayHeuristicWindow: 1,
      maxRank: 12
    }
  });
  assert.equal(playout.state.players.P1.energyLine.length, 0);
  assert.equal(playout.state.players.P1.frontLine.length, 1);
  assert.equal(playout.state.players.P1.frontLine[0].cards.length, 2);
});

test("per-player exploration leaves the benchmark opponent deterministic", () => {
  const game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true
  }).state;
  game.phase = PHASES.MAIN;
  game.activePlayer = "P2";
  game.players.P2.turnsTaken = 1;
  game.players.P2.energyLine = Array.from({ length: MAX_LINE_SIZE }, (_, index) => permanent("P2", "demo_rookie", `opponent-energy-${index}`));
  game.players.P2.frontLine = [];
  game.players.P2.hand.unshift({ uid: "opponent-raider", owner: "P2", defId: "demo_raider", faceUp: true });
  const decisions = [];
  const controlDecisions = [];
  runAutoplayGame(game, {
    maxActions: 1,
    maxTurns: 10,
    decisionRecorder: (decision) => controlDecisions.push(decision)
  });

  runAutoplayGame(game, {
    maxActions: 1,
    maxTurns: 10,
    exploration: {
      P1: { raidNormalPlayRate: 1, raidNormalPlayScoreWindow: 1000 },
      P2: null
    },
    decisionRecorder: (decision) => decisions.push(decision)
  });

  assert.equal(decisions[0].player, "P2");
  assert.equal(decisions[0].exploration, null);
  assert.deepEqual(decisions[0].chosenAction, controlDecisions[0].chosenAction);
});

test("autoplay bounds exploration to causal slots instead of stacking unlabeled deviations", () => {
  const game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    seed: 6812
  }).state;
  const decisions = [];
  const playout = runAutoplayGame(game, {
    maxActions: 50,
    maxTurns: 10,
    exploration: {
      P1: { rate: 1, maxPerGame: 1, scoreWindow: 10_000, maxRank: 100, minScore: -10_000 },
      P2: null
    },
    counterfactual: {
      P1: { rate: 0, maxPerGame: 1, rolloutMaxActions: 12 },
      P2: null
    },
    decisionRecorder: (decision) => decisions.push(decision)
  });

  const explored = decisions.filter((decision) => decision.player === "P1" && decision.exploration);
  assert.equal(explored.length, 1);
  assert.ok(explored[0].counterfactual);
  assert.equal(explored[0].counterfactual.samplingReason, "explored-action-priority");
  assert.equal(playout.explorationDiagnostics.byPlayer.P1, 1);
  assert.equal(playout.explorationDiagnostics.byPlayer.P2, 0);
  assert.equal(playout.explorationDiagnostics.total, 1);
  assert.equal(playout.counterfactualDiagnostics.explorationPriorityEvaluations, 1);
});

test("autoplay can explore Raid normal-play lines through neutral plausibility when policy overvalues Raid", () => {
  let game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true
  }).state;
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0, destination: LINES.ENERGY });
  game.players.P1.hand.unshift({ uid: "test-raider", owner: "P1", defId: "demo_raider", faceUp: true });

  const decisions = [];
  const playout = runAutoplayGame(game, {
    maxActions: 1,
    maxTurns: 10,
    policy: {
      weights: {
        performRaid: 1500,
        moveRaidToFront: 600,
        playRaidCardNormally: -500
      }
    },
    exploration: {
      raidNormalPlayRate: 1,
      raidNormalPlayScoreWindow: 1,
      raidNormalPlayHeuristicWindow: 1400,
      maxRank: 12
    },
    counterfactual: {
      rate: 0,
      maxPerGame: 1,
      rolloutMaxActions: 80,
      decisionWindow: 1,
      phaseWeights: { main: 1 }
    },
    decisionRecorder: (decision) => decisions.push(decision)
  });

  assert.equal(playout.state.players.P1.frontLine.length, 1);
  assert.equal(playout.state.players.P1.frontLine[0].cards.length, 1);
  assert.equal(playout.state.players.P1.frontLine[0].cards[0].defId, "demo_raider");
  assert.equal(decisions[0].exploration.reason, "raid-normal-play");
  assert.equal(decisions[0].chosenAction.explorationReason, "raid-normal-play");
  assert.equal(playout.counterfactualsEvaluated, 1);
  assert.ok(["chosen", "alternative", "tie"].includes(decisions[0].counterfactual.preference));
  assert.equal(decisions[0].counterfactual.alternativeIndex, 1);
  assert.equal(decisions[0].counterfactual.alternativeAction.type, "performRaid");
  assert.equal(decisions[0].counterfactual.samplingReason, "explored-action-priority");
  assert.equal(decisions[0].counterfactual.informationReason, "explored-action");
  assert.equal(playout.counterfactualDiagnostics.explorationPriorityEvaluations, 1);
});

test("training probes novel Raid lines without changing the on-policy fitness trajectory", () => {
  let game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true
  }).state;
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0, destination: LINES.ENERGY });
  game.players.P1.hand.unshift({ uid: "test-raider", owner: "P1", defId: "demo_raider", faceUp: true });

  const decisions = [];
  const playout = runAutoplayGame(game, {
    maxActions: 1,
    maxTurns: 10,
    policy: {
      weights: {
        performRaid: 1500,
        moveRaidToFront: 600,
        playRaidCardNormally: -500
      }
    },
    exploration: {
      mode: "counterfactual-probe",
      raidNormalPlayRate: 1,
      raidNormalPlayScoreWindow: 1,
      raidNormalPlayHeuristicWindow: 1400,
      maxRank: 12
    },
    counterfactual: {
      rate: 0,
      maxPerGame: 1,
      rolloutMaxActions: 80,
      rolloutMaxPlayerTurns: 1,
      decisionWindow: 1,
      phaseWeights: { main: 1 }
    },
    decisionRecorder: (decision) => decisions.push(decision)
  });

  assert.equal(playout.state.players.P1.energyLine.length, 0);
  assert.equal(playout.state.players.P1.frontLine[0].cards.length, 2);
  assert.equal(decisions[0].chosenAction.type, "performRaid");
  assert.equal(decisions[0].chosenAction.explorationReason, undefined);
  assert.equal(decisions[0].exploration.mode, "counterfactual-probe");
  assert.equal(decisions[0].exploration.reason, "raid-normal-play");
  assert.equal(decisions[0].counterfactual.alternativeAction.type, "playCard");
  assert.equal(decisions[0].counterfactual.samplingReason, "explored-alternative-priority");
  assert.equal(decisions[0].counterfactual.informationReason, "counterfactual-probe:raid-normal-play");
  assert.equal(playout.explorationDiagnostics.probesByPlayer.P1, 1);
  assert.equal(playout.explorationDiagnostics.actionsByPlayer.P1, 0);
});

test("probe-only exploration waits for its combat target instead of spending the budget in main", () => {
  const game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  }).state;
  game.phase = PHASES.MAIN;
  game.activePlayer = "P1";
  game.players.P1.apCards = [{ id: "P1-ap-1", rested: false }];
  game.players.P1.hand = [{ uid: "probe-rookie", owner: "P1", defId: "demo_rookie", faceUp: true }];
  game.players.P1.frontLine = [permanent("P1", "demo_raider", "probe-attacker")];
  game.players.P2.frontLine = [];

  const decisions = [];
  const playout = runAutoplayGame(game, {
    maxActions: 3,
    maxTurns: 10,
    policy: {
      weights: {
        playCard: 1000,
        attackPlayer: 1500,
        advancePhase: -1000
      }
    },
    exploration: {
      P1: {
        mode: "counterfactual-probe",
        rate: 1,
        maxPerGame: 1,
        scoreWindow: 20_000,
        maxRank: 100,
        minScore: -20_000
      },
      P2: null
    },
    counterfactual: {
      P1: {
        rate: 0,
        maxPerGame: 1,
        rolloutMaxActions: 20,
        rolloutMaxPlayerTurns: 1,
        decisionWindow: 1,
        phaseWeights: { attack: 1 },
        fallbackAfterEligible: 100
      },
      P2: null
    },
    decisionRecorder: (decision) => decisions.push(decision)
  });

  const mainDecision = decisions.find((decision) => decision.state.decisionPhase === "main"
    && decision.candidates.length > 1);
  const attackDecision = decisions.find((decision) => decision.state.decisionPhase === "attack");
  assert.ok(mainDecision);
  assert.equal(mainDecision.exploration, null);
  assert.equal(mainDecision.counterfactual, null);
  assert.ok(attackDecision);
  assert.equal(attackDecision.chosenAction.type, "declareAttack");
  assert.equal(attackDecision.exploration.mode, "counterfactual-probe");
  assert.equal(attackDecision.counterfactual.targetPhase, "attack");
  assert.equal(attackDecision.counterfactual.decisionPhase, "attack");
  assert.equal(attackDecision.counterfactual.alternativeAction.type, "advancePhase");
  assert.equal(attackDecision.counterfactual.alternativeSelection, "attack-vs-pass");
  assert.equal(playout.counterfactualDiagnostics.enabledPlayers, 0);
  assert.equal(playout.counterfactualDiagnostics.probeTargetedPlayers, 1);
  assert.equal(playout.counterfactualDiagnostics.evaluatedPhaseCounts.main, 0);
  assert.equal(playout.counterfactualDiagnostics.evaluatedPhaseCounts.attack, 1);
  assert.equal(playout.explorationDiagnostics.probesByPlayer.P1, 1);
});

test("probe-only exploration labels late off-target comparisons as fallbacks", () => {
  const game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  }).state;
  game.phase = PHASES.MAIN;
  game.activePlayer = "P1";
  game.players.P1.apCards = [{ id: "P1-ap-1", rested: false }];
  game.players.P1.hand = [{ uid: "fallback-rookie", owner: "P1", defId: "demo_rookie", faceUp: true }];

  const decisions = [];
  const playout = runAutoplayGame(game, {
    maxActions: 1,
    maxTurns: 10,
    exploration: {
      P1: {
        mode: "counterfactual-probe",
        rate: 1,
        maxPerGame: 1,
        scoreWindow: 20_000,
        maxRank: 100,
        minScore: -20_000
      },
      P2: null
    },
    counterfactual: {
      P1: {
        rate: 0,
        maxPerGame: 1,
        rolloutMaxActions: 20,
        rolloutMaxPlayerTurns: 1,
        decisionWindow: 1,
        phaseWeights: { attack: 1 },
        fallbackAfterEligible: 0
      },
      P2: null
    },
    decisionRecorder: (decision) => decisions.push(decision)
  });

  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].state.decisionPhase, "main");
  assert.equal(decisions[0].counterfactual.targetPhase, "attack");
  assert.equal(decisions[0].counterfactual.decisionPhase, "main");
  assert.equal(decisions[0].counterfactual.fallbackUsed, true);
  assert.equal(decisions[0].counterfactual.samplingReason, "explored-alternative-fallback");
  assert.equal(playout.counterfactualDiagnostics.fallbacks, 1);
});

test("coverage-aware probes rotate away from an over-attempted Raid line", () => {
  let game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true
  }).state;
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0, destination: LINES.ENERGY });
  game.players.P1.hand = [
    { uid: "coverage-raider", owner: "P1", defId: "demo_raider", faceUp: true },
    { uid: "coverage-rookie", owner: "P1", defId: "demo_rookie", faceUp: true }
  ];
  const raidContextFeatures = new Set(legalActions(game, "P1")
    .filter((action) => action.handIndex === 0)
    .flatMap((action) => Object.keys(pilotActionFeatures(game, "P1", action)))
    .filter((feature) => feature.startsWith("context.")));
  const featureAttempts = Object.fromEntries([...raidContextFeatures].map((feature) => [feature, 10_000]));
  const featureObservations = Object.fromEntries([...raidContextFeatures].map((feature) => [feature, 1]));
  const decisions = [];

  runAutoplayGame(game, {
    maxActions: 1,
    maxTurns: 10,
    exploration: {
      mode: "counterfactual-probe",
      rate: 1,
      raidNormalPlayRate: 1,
      maxRank: 20,
      raidNormalPlayHeuristicWindow: 10_000,
      raidNormalPlayMinHeuristicScore: -10_000,
      evidence: {
        targetObservations: 24,
        featureObservations,
        featureAttempts
      }
    },
    counterfactual: {
      rate: 0,
      maxPerGame: 1,
      rolloutMaxActions: 80,
      rolloutMaxPlayerTurns: 1,
      decisionWindow: 1,
      phaseWeights: { main: 1 }
    },
    decisionRecorder: (decision) => decisions.push(decision)
  });

  assert.equal(decisions[0].exploration.selectionMode, "coverage-gap");
  assert.equal(decisions[0].counterfactual.alternativeAction.cardId, "demo_rookie");
  assert.notEqual(decisions[0].counterfactual.alternativeAction.cardId, "demo_raider");
});

test("autoplay counterfactuals evaluate normal policy decisions without requiring exploration", () => {
  let game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true
  }).state;
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0, destination: LINES.ENERGY });
  game.players.P1.hand.unshift({ uid: "test-raider", owner: "P1", defId: "demo_raider", faceUp: true });

  const decisions = [];
  const playout = runAutoplayGame(game, {
    maxActions: 1,
    maxTurns: 10,
    policy: {
      weights: {
        performRaid: 1500,
        moveRaidToFront: 600,
        playRaidCardNormally: -500
      }
    },
    counterfactual: {
      rate: 1,
      maxPerGame: 1,
      rolloutMaxActions: 80,
      rolloutMaxPlayerTurns: 1,
      decisionWindow: 1,
      phaseWeights: { main: 1 }
    },
    decisionRecorder: (decision) => decisions.push(decision)
  });

  assert.equal(decisions[0].exploration, null);
  assert.equal(playout.counterfactualsEvaluated, 1);
  assert.ok(["chosen", "alternative", "tie"].includes(decisions[0].counterfactual.preference));
  assert.notEqual(decisions[0].counterfactual.alternativeIndex, 0);
  assert.ok(decisions[0].counterfactual.alternativeAction.type);
  assert.equal(decisions[0].counterfactual.rolloutHorizon.playerTurnBudget, 1);
  assert.equal(decisions[0].counterfactual.rolloutHorizon.comparable, true);
  assert.equal(decisions[0].counterfactual.rolloutHorizon.chosenReachedHorizon, true);
  assert.equal(decisions[0].counterfactual.rolloutHorizon.alternativeReachedHorizon, true);
});

test("adaptive counterfactual staging preserves full-horizon deterministic evidence", () => {
  const evaluate = (adaptiveRollout) => {
    let game = createSimulationGame({
      catalog: sampleCatalog,
      decks: { P1: sampleDeckList, P2: sampleDeckList },
      skipShuffle: true
    }).state;
    game = applyAction(game, { type: "advancePhase", player: "P1" });
    game = applyAction(game, { type: "advancePhase", player: "P1" });
    game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0, destination: LINES.ENERGY });
    game.players.P1.hand.unshift({ uid: "test-raider", owner: "P1", defId: "demo_raider", faceUp: true });
    const decisions = [];
    runAutoplayGame(game, {
      maxActions: 1,
      maxTurns: 10,
      counterfactual: {
        rate: 1,
        maxPerGame: 1,
        rolloutMaxActions: 80,
        rolloutMaxPlayerTurns: 3,
        adaptiveRollout,
        adaptiveAuditRate: 1,
        decisionWindow: 1,
        phaseWeights: { main: 1 }
      },
      decisionRecorder: (decision) => decisions.push(decision)
    });
    return decisions[0].counterfactual;
  };

  const staged = evaluate(true);
  const direct = evaluate(false);
  assert.equal(staged.rolloutHorizon.adaptive, true);
  assert.equal(direct.rolloutHorizon.adaptive, false);
  assert.equal(staged.preference, direct.preference);
  assert.equal(staged.chosenScore, direct.chosenScore);
  assert.equal(staged.alternativeScore, direct.alternativeScore);
  assert.equal(staged.chosenWinner, direct.chosenWinner);
  assert.equal(staged.alternativeWinner, direct.alternativeWinner);
  assert.equal(staged.rolloutHorizon.chosenEndPlayerTurns, direct.rolloutHorizon.chosenEndPlayerTurns);
  assert.equal(staged.rolloutHorizon.alternativeEndPlayerTurns, direct.rolloutHorizon.alternativeEndPlayerTurns);
  assert.equal(staged.rolloutHorizon.chosenSteps, direct.rolloutHorizon.chosenSteps);
  assert.equal(staged.rolloutHorizon.alternativeSteps, direct.rolloutHorizon.alternativeSteps);
});

test("counterfactual learning rejects action-bounded branches before the shared turn horizon", () => {
  let game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true
  }).state;
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0, destination: LINES.ENERGY });
  game.players.P1.hand.unshift({ uid: "test-raider", owner: "P1", defId: "demo_raider", faceUp: true });

  const decisions = [];
  runAutoplayGame(game, {
    maxActions: 1,
    maxTurns: 10,
    counterfactual: {
      rate: 1,
      maxPerGame: 1,
      rolloutMaxActions: 1,
      rolloutMaxPlayerTurns: 3,
      decisionWindow: 1,
      phaseWeights: { main: 1 }
    },
    decisionRecorder: (decision) => decisions.push(decision)
  });

  const evidence = decisions[0].counterfactual;
  assert.equal(evidence.preference, "tie");
  assert.equal(evidence.evidenceKind, "unsynchronized-horizon");
  assert.equal(evidence.confidence, 0);
  assert.equal(evidence.rolloutHorizon.comparable, false);
  assert.equal(evidence.rolloutHorizon.chosenReachedHorizon, false);
  assert.equal(evidence.rolloutHorizon.alternativeReachedHorizon, false);
  assert.equal(evidence.chosenStoppedReason, "maxActions");
  assert.equal(evidence.alternativeStoppedReason, "maxActions");
});

test("counterfactual fallback waits for useful evidence instead of forcing a weak comparison", () => {
  let game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true
  }).state;
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });

  const decisions = [];
  const playout = runAutoplayGame(game, {
    maxActions: 1,
    maxTurns: 10,
    policy: {
      weights: {
        advancePhase: 5000,
        playCard: -5000,
        playToEnergy: -5000,
        playToFront: -5000
      }
    },
    counterfactual: {
      rate: 1,
      maxPerGame: 1,
      rolloutMaxActions: 20,
      decisionWindow: 1,
      phaseWeights: { block: 1 },
      fallbackAfterEligible: 0,
      minimumInformationScore: 1,
      lowInformationExplorationRate: 0
    },
    decisionRecorder: (decision) => decisions.push(decision)
  });

  assert.equal(playout.counterfactualsEvaluated, 0);
  assert.equal(playout.counterfactualDiagnostics.lowInformationSkips, 1);
  assert.ok(decisions.every((decision) => decision.counterfactual === null));
});

test("autoplay can target counterfactual evidence at defender block decisions", () => {
  const game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  }).state;
  game.phase = PHASES.ATTACK;
  game.activePlayer = "P1";
  game.pendingAttack = {
    attackerPlayer: "P1",
    defenderPlayer: "P2",
    attackerPermanentId: "attacker"
  };
  game.players.P1.frontLine = [permanent("P1", "demo_raider", "attacker", true)];
  game.players.P1.frontLine[0].attacksThisTurn = 1;
  game.players.P2.frontLine = [permanent("P2", "demo_rookie", "blocker")];

  const decisions = [];
  const playout = runAutoplayGame(game, {
    maxActions: 1,
    maxTurns: 10,
    counterfactual: {
      rate: 1,
      maxPerGame: 1,
      rolloutMaxActions: 20,
      decisionWindow: 1,
      phaseWeights: { block: 1 },
      fallbackAfterEligible: 100
    },
    decisionRecorder: (decision) => decisions.push(decision)
  });

  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].state.phase, PHASES.ATTACK);
  assert.equal(decisions[0].state.decisionPhase, "block");
  assert.equal(decisions[0].counterfactual.targetPhase, "block");
  assert.equal(decisions[0].counterfactual.decisionPhase, "block");
  assert.equal(decisions[0].counterfactual.fallbackUsed, false);
  assert.equal(decisions[0].counterfactual.alternativeSelection, "block-vs-life");
  assert.deepEqual(
    [decisions[0].chosenAction.type, decisions[0].counterfactual.alternativeAction.type].sort(),
    ["declareBlock", "declineBlock"]
  );
  assert.equal(playout.counterfactualDiagnostics.evaluatedPhaseCounts.block, 1);
  assert.equal(playout.counterfactualDiagnostics.fallbacks, 0);
});

test("probe-only combat exploration prioritizes block versus taking life", () => {
  const game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  }).state;
  game.phase = PHASES.ATTACK;
  game.activePlayer = "P1";
  game.pendingAttack = {
    attackerPlayer: "P1",
    defenderPlayer: "P2",
    attackerPermanentId: "probe-block-attacker"
  };
  game.players.P1.frontLine = [permanent("P1", "demo_raider", "probe-block-attacker", true)];
  game.players.P1.frontLine[0].attacksThisTurn = 1;
  game.players.P2.frontLine = [permanent("P2", "demo_rookie", "probe-blocker")];

  const decisions = [];
  runAutoplayGame(game, {
    maxActions: 1,
    maxTurns: 10,
    exploration: {
      P1: null,
      P2: {
        mode: "counterfactual-probe",
        rate: 1,
        maxPerGame: 1,
        scoreWindow: 20_000,
        maxRank: 100,
        minScore: -20_000
      }
    },
    counterfactual: {
      P1: null,
      P2: {
        rate: 0,
        maxPerGame: 1,
        rolloutMaxActions: 20,
        rolloutMaxPlayerTurns: 1,
        decisionWindow: 1,
        phaseWeights: { block: 1 },
        fallbackAfterEligible: 100
      }
    },
    decisionRecorder: (decision) => decisions.push(decision)
  });

  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].exploration.reason, "block-vs-life");
  assert.equal(decisions[0].exploration.selectionMode, "strategic-combat");
  assert.equal(decisions[0].counterfactual.alternativeSelection, "block-vs-life");
  assert.deepEqual(
    [decisions[0].chosenAction.type, decisions[0].counterfactual.alternativeAction.type].sort(),
    ["declareBlock", "declineBlock"]
  );
});

test("counterfactual attack evidence can compare attacking with passing", () => {
  const game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  }).state;
  game.phase = PHASES.ATTACK;
  game.activePlayer = "P1";
  game.players.P1.frontLine = [permanent("P1", "demo_raider", "attacker")];
  game.players.P2.frontLine = [];

  const decisions = [];
  runAutoplayGame(game, {
    maxActions: 1,
    maxTurns: 10,
    policy: { weights: { attackPlayer: 1500, advancePhase: -1000 } },
    counterfactual: {
      rate: 1,
      maxPerGame: 1,
      rolloutMaxActions: 20,
      decisionWindow: 1,
      phaseWeights: { attack: 1 },
      fallbackAfterEligible: 100,
      alternativeDiversityRate: 0
    },
    decisionRecorder: (decision) => decisions.push(decision)
  });

  assert.equal(decisions[0].chosenAction.type, "declareAttack");
  assert.equal(decisions[0].counterfactual.alternativeAction.type, "advancePhase");
  assert.equal(decisions[0].counterfactual.alternativeSelection, "attack-vs-pass");
  assert.equal(decisions[0].counterfactual.informationReason, "attack-vs-pass");
});

test("counterfactual alternatives exclude rule-invalid strategic pairs", () => {
  const game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  }).state;
  game.phase = PHASES.ATTACK;
  game.activePlayer = "P1";
  game.pendingAttack = {
    attackerPlayer: "P1",
    defenderPlayer: "P2",
    attackerPermanentId: "must-block-attacker"
  };
  game.players.P1.frontLine = [permanent("P1", "demo_raider", "must-block-attacker", true)];
  game.players.P1.frontLine[0].attacksThisTurn = 1;
  game.players.P1.frontLine[0].keywordModifiers.push({ keyword: "mustBlock", value: true });
  game.players.P2.frontLine = [
    permanent("P2", "demo_rookie", "blocker-a"),
    permanent("P2", "demo_guardian", "blocker-b")
  ];

  const decisions = [];
  const playout = runAutoplayGame(game, {
    maxActions: 1,
    maxTurns: 10,
    counterfactual: {
      rate: 1,
      maxPerGame: 1,
      rolloutMaxActions: 20,
      decisionWindow: 1,
      phaseWeights: { block: 1 },
      fallbackAfterEligible: 100,
      alternativeDiversityRate: 1
    },
    decisionRecorder: (decision) => decisions.push(decision)
  });

  assert.equal(decisions[0].chosenAction.type, "declareBlock");
  assert.equal(decisions[0].counterfactual.alternativeAction.type, "declareBlock");
  assert.equal(decisions[0].counterfactual.alternativeSelection, "information-priority-close");
  assert.equal(playout.counterfactualsEvaluated, 1);
});

test("pilot tempo scoring punishes passing with lethal attackers", () => {
  let game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  }).state;
  game.phase = PHASES.ATTACK;
  game.activePlayer = "P1";
  game.players.P1.frontLine = [{
    pid: "finisher",
    owner: "P1",
    controller: "P1",
    cards: [{ uid: "finisher-card", owner: "P1", defId: "demo_finisher", faceUp: true }],
    rested: false,
    bpDelta: 0,
    bpModifiers: [],
    keywordModifiers: [],
    energyModifiers: [],
    attacksThisTurn: 0,
    blocksThisTurn: 0,
    usedOncePerTurn: []
  }];
  game.players.P2.frontLine = [];
  game.players.P2.life = [
    { uid: "life-1", owner: "P2", defId: "demo_rookie", faceUp: false },
    { uid: "life-2", owner: "P2", defId: "demo_rookie", faceUp: false }
  ];

  const attackScore = scorePilotAction(game, "P1", {
    type: "declareAttack",
    player: "P1",
    attackerIndex: 0,
    target: { type: "player" }
  });
  const passScore = scorePilotAction(game, "P1", { type: "advancePhase", player: "P1" });

  assert.ok(attackScore > passScore);
});

test("pilot block scoring allows safe damage instead of early chump blocks", () => {
  let game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  }).state;
  game.phase = PHASES.ATTACK;
  game.activePlayer = "P1";
  game.pendingAttack = {
    attackerPlayer: "P1",
    defenderPlayer: "P2",
    attackerPermanentId: "attacker"
  };
  game.players.P1.frontLine = [{
    pid: "attacker",
    owner: "P1",
    controller: "P1",
    cards: [{ uid: "attacker-card", owner: "P1", defId: "demo_raider", faceUp: true }],
    rested: true,
    bpDelta: 0,
    bpModifiers: [],
    keywordModifiers: [],
    energyModifiers: [],
    attacksThisTurn: 1,
    blocksThisTurn: 0,
    usedOncePerTurn: []
  }];
  game.players.P2.frontLine = [{
    pid: "blocker",
    owner: "P2",
    controller: "P2",
    cards: [{ uid: "blocker-card", owner: "P2", defId: "demo_rookie", faceUp: true }],
    rested: false,
    bpDelta: 0,
    bpModifiers: [],
    keywordModifiers: [],
    energyModifiers: [],
    attacksThisTurn: 0,
    blocksThisTurn: 0,
    usedOncePerTurn: []
  }];
  game.players.P2.life = [
    { uid: "life-1", owner: "P2", defId: "demo_rookie", faceUp: false },
    { uid: "life-2", owner: "P2", defId: "demo_rookie", faceUp: false },
    { uid: "life-3", owner: "P2", defId: "demo_rookie", faceUp: false },
    { uid: "life-4", owner: "P2", defId: "demo_rookie", faceUp: false },
    { uid: "life-5", owner: "P2", defId: "demo_rookie", faceUp: false },
    { uid: "life-6", owner: "P2", defId: "demo_rookie", faceUp: false }
  ];

  const declineScore = scorePilotAction(game, "P2", { type: "declineBlock", player: "P2" });
  const blockScore = scorePilotAction(game, "P2", { type: "declareBlock", player: "P2", blockerIndex: 0 });

  assert.ok(declineScore > blockScore);
});

test("legal attacks target the player unless the attacker has Snipe", () => {
  let game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  }).state;
  game.phase = PHASES.ATTACK;
  game.activePlayer = "P1";
  game.players.P1.frontLine = [permanent("P1", "demo_rookie", "rookie")];
  game.players.P2.frontLine = [permanent("P2", "demo_large_body", "large")];

  let attacks = legalActions(game, "P1").filter((action) => action.type === "declareAttack");
  assert.equal(attacks.some((action) => action.target?.type === "character"), false);
  assert.equal(attacks.some((action) => action.target?.type === "player"), true);

  game.players.P1.frontLine = [permanent("P1", "demo_sniper", "sniper")];
  attacks = legalActions(game, "P1").filter((action) => action.type === "declareAttack");
  assert.equal(attacks.some((action) => action.target?.type === "character"), true);
});

test("direct attack features model defender choice instead of choosing a target", () => {
  let game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  }).state;
  game.phase = PHASES.ATTACK;
  game.activePlayer = "P1";
  game.players.P1.frontLine = [permanent("P1", "demo_raider", "raider")];
  game.players.P2.frontLine = [permanent("P2", "demo_rookie", "blocker")];

  const features = pilotActionFeatures(game, "P1", {
    type: "declareAttack",
    player: "P1",
    attackerIndex: 0,
    target: { type: "player" }
  });

  assert.equal(features.attackPlayer, 1);
  assert.equal(features.attackCharacter, undefined);
  assert.equal(features.attackIntoBlockers, 1);
  assert.equal(features.attackCanBeatBlocker, 1);
});

test("setup and play decisions expose stable card-specific learning features", () => {
  const game = setupStateWithHands({
    p1Hand: ["demo_rookie", "demo_raider", "demo_activator", "demo_draw_event"]
  });
  const setupFeatures = setupHandFeatures(game, "P1");
  assert.equal(setupFeatures["context.setup.card.demo_rookie"], 1);
  assert.equal(setupFeatures["context.setup.card.demo_raider"], 1);

  const raiderIndex = game.players.P1.hand.findIndex((card) => card.defId === "demo_raider");
  const normalPlay = pilotActionFeatures(game, "P1", {
    type: "playCard",
    player: "P1",
    handIndex: raiderIndex,
    destination: LINES.FRONT
  });
  assert.equal(normalPlay["context.play.card.demo_raider"], 1);
  assert.equal(normalPlay["context.play.frontline.card.demo_raider"], 1);
  assert.equal(normalPlay["context.raid.card.demo_raider"], undefined);

  game.players.P1.frontLine = [permanent("P1", "demo_rookie", "raid-base")];
  const raidPlay = pilotActionFeatures(game, "P1", {
    type: "performRaid",
    player: "P1",
    handIndex: raiderIndex,
    targetLine: LINES.FRONT,
    targetIndex: 0,
    moveToFront: true
  });
  assert.equal(raidPlay["context.raid.card.demo_raider"], 1);
  assert.equal(raidPlay["context.raid.pair.demo_raider.demo_rookie"], 1);
  assert.equal(raidPlay["context.play.card.demo_raider"], undefined);
});

test("snipe attack features identify threat removal as the special targeting case", () => {
  let game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  }).state;
  game.phase = PHASES.ATTACK;
  game.activePlayer = "P1";
  game.players.P1.frontLine = [permanent("P1", "demo_sniper", "sniper")];
  game.players.P2.frontLine = [permanent("P2", "demo_finisher", "finisher")];

  const features = pilotActionFeatures(game, "P1", {
    type: "declareAttack",
    player: "P1",
    attackerIndex: 0,
    target: { type: "character", index: 0 }
  });

  assert.equal(features.attackCharacter, 1);
  assert.equal(features.snipeAttack, 1);
  assert.ok(features.snipeThreatRemoval > 0);
});

test("ability features recognize card advantage and attacker rest costs", () => {
  let game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  }).state;
  game.phase = PHASES.MAIN;
  game.activePlayer = "P1";
  game.players.P1.frontLine = [permanent("P1", "demo_activator", "activator")];

  const features = pilotActionFeatures(game, "P1", {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: "draw-main"
  });

  assert.equal(features.abilityRestsPotentialAttacker, 1);
  assert.equal(features.abilityCardAdvantage, 1);
  assert.equal(features.abilitySearch, 1);
  assert.equal(features["context.ability.card.demo_activator.draw-main"], 1);
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

  const decisions = [];
  const playout = runAutoplayGame(game, {
    maxActions: 1,
    maxTurns: 10,
    decisionRecorder: (decision) => decisions.push(decision)
  });
  assert.equal(playout.state.winner, "P1");
  assert.equal(playout.state.players.P2.life.length, 0);
  const choiceCandidates = decisions[0].candidates.filter((candidate) => candidate.action.type === "activateMainAbility");
  assert.equal(choiceCandidates.length, 2);
  assert.ok(choiceCandidates.some((candidate) => candidate.features["context.choice.private_choice_pilot.choice-main.effectchoice.0"] === 1));
  assert.ok(choiceCandidates.some((candidate) => candidate.features["context.choice.private_choice_pilot.choice-main.effectchoice.1"] === 1));
});

test("autoplay exposes both sides of an optional card effect to learning", () => {
  const catalog = {
    ...sampleCatalog,
    private_optional_pilot: {
      id: "private_optional_pilot",
      number: "DEM-1-091",
      sourceCode: "DEM",
      name: "Optional Pilot",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      abilities: [{
        id: "optional-main",
        timing: "activateMain",
        oncePerTurn: true,
        effect: {
          kind: "optional",
          choiceKey: "takeOption",
          effect: { kind: "draw", amount: 1 }
        }
      }]
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
    pid: "optional-pilot",
    owner: "P1",
    controller: "P1",
    cards: [{ uid: "optional-card", owner: "P1", defId: "private_optional_pilot", faceUp: true }],
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
  const decisions = [];

  runAutoplayGame(game, {
    maxActions: 1,
    maxTurns: 10,
    decisionRecorder: (decision) => decisions.push(decision)
  });

  const optionalCandidates = decisions[0].candidates.filter((candidate) => candidate.action.type === "activateMainAbility");
  assert.equal(optionalCandidates.length, 2);
  assert.ok(optionalCandidates.some((candidate) => candidate.features["context.choice.private_optional_pilot.optional-main.takeoption.true"] === 1));
  assert.ok(optionalCandidates.some((candidate) => candidate.features["context.choice.private_optional_pilot.optional-main.takeoption.false"] === 1));
});

test("top-deck search choices do not leak hidden cards into the activating decision", () => {
  const character = (id, name, bp) => ({
    id,
    number: id,
    sourceCode: "DEM",
    name,
    type: CARD_TYPES.CHARACTER,
    color: "green",
    requiredEnergy: { color: "green", amount: 0 },
    apCost: 0,
    bp,
    energy: [{ color: "green", amount: 1 }],
    affinities: [],
    abilities: []
  });
  const catalog = {
    ...sampleCatalog,
    private_search_low: character("private_search_low", "Search Low", 1000),
    private_search_high: character("private_search_high", "Search High", 5000),
    private_search_pilot: {
      ...character("private_search_pilot", "Search Pilot", 1000),
      abilities: [{
        id: "search-main",
        timing: "activateMain",
        oncePerTurn: true,
        effect: { kind: "searchTopDeck", count: 2, min: 1, max: 1, choiceKey: "searchIndices" }
      }]
    }
  };
  const decisionForDeck = (deck) => {
    let game = createSimulationGame({
      catalog,
      decks: { P1: sampleDeckList, P2: sampleDeckList },
      skipShuffle: true,
      validateDecks: false
    }).state;
    game.phase = PHASES.MAIN;
    game.activePlayer = "P1";
    game.players.P1.frontLine = [{
      pid: "search-pilot",
      owner: "P1",
      controller: "P1",
      cards: [{ uid: "search-pilot-card", owner: "P1", defId: "private_search_pilot", faceUp: true }],
      rested: false,
      bpDelta: 0,
      bpModifiers: [],
      keywordModifiers: [],
      energyModifiers: [],
      attacksThisTurn: 0,
      blocksThisTurn: 0,
      usedOncePerTurn: []
    }];
    game.players.P1.deck = deck;
    const action = autoplayActionCandidates(game, "P1")
      .find((candidate) => candidate.type === "activateMainAbility");
    return { action, features: pilotActionFeatures(game, "P1", action) };
  };

  const lowThenHigh = decisionForDeck([
    { uid: "search-low", owner: "P1", defId: "private_search_low", faceUp: false },
    { uid: "search-high", owner: "P1", defId: "private_search_high", faceUp: false }
  ]);
  const highThenLow = decisionForDeck([
    { uid: "search-high-2", owner: "P1", defId: "private_search_high", faceUp: false },
    { uid: "search-low-2", owner: "P1", defId: "private_search_low", faceUp: false }
  ]);

  assert.deepEqual(lowThenHigh.features, highThenLow.features);
  assert.equal(lowThenHigh.action.choices.searchIndices[0], 1);
  assert.equal(highThenLow.action.choices.searchIndices[0], 0);
  assert.equal(Object.keys(lowThenHigh.features).some((key) => key.includes("searchindices")), false);
  assert.equal(Object.keys(lowThenHigh.features).some((key) => key.includes("private_search_low") || key.includes("private_search_high")), false);

  let runtimeGame = createSimulationGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  }).state;
  runtimeGame.phase = PHASES.MAIN;
  runtimeGame.activePlayer = "P1";
  runtimeGame.players.P1.frontLine = [permanent("P1", "private_search_pilot", "runtime-search-pilot")];
  runtimeGame.players.P1.deck = [
    { uid: "runtime-search-low", owner: "P1", defId: "private_search_low", faceUp: false },
    { uid: "runtime-search-high", owner: "P1", defId: "private_search_high", faceUp: false }
  ];
  runtimeGame.players.P1.hand = [];
  const runtimeDecisions = [];
  const runtimeResult = runAutoplayGame(runtimeGame, {
    maxActions: 1,
    maxTurns: 10,
    decisionRecorder: (decision) => runtimeDecisions.push(decision)
  });
  const nestedSearch = runtimeDecisions.find((decision) => decision.chosenAction.type === "resolutionChoice");
  assert.equal(runtimeResult.state.players.P1.hand[0].defId, "private_search_high");
  assert.equal(Object.keys(nestedSearch.candidates[nestedSearch.chosenIndex].features)
    .some((key) => key.includes("private_search_high")), true);
  assert.equal(Object.keys(runtimeDecisions[0].candidates.find((candidate) => candidate.action.type === "activateMainAbility").features)
    .some((key) => key.includes("private_search_high")), false);
});

test("post-search policy chooses bottom-deck order after cards become known", () => {
  const catalog = {
    ...sampleCatalog,
    private_search_order: {
      id: "private_search_order",
      number: "DEM-1-094A",
      sourceCode: "DEM",
      name: "Search Order",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      abilities: [{
        id: "search-order-main",
        timing: "activateMain",
        oncePerTurn: true,
        effect: { kind: "searchTopDeck", count: 3, min: 1, max: 1, filter: { type: CARD_TYPES.CHARACTER } }
      }]
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
  game.players.P1.frontLine = [permanent("P1", "private_search_order", "search-order")];
  game.players.P1.deck = [
    { uid: "order-rookie", owner: "P1", defId: "demo_rookie", faceUp: false },
    { uid: "order-raider", owner: "P1", defId: "demo_raider", faceUp: false },
    { uid: "order-finisher", owner: "P1", defId: "demo_finisher", faceUp: false }
  ];
  const decisions = [];
  const playout = runAutoplayGame(game, {
    maxActions: 1,
    maxTurns: 10,
    policy: { weights: {
      activateMain: 10000,
      advancePhase: -10000,
      "context.resolution.private_search_order.searchtopdeck.bottom_slot_1.card.demo_rookie": 50000
    } },
    decisionRecorder: (decision) => decisions.push(decision)
  });

  const response = decisions.find((decision) => decision.chosenAction.type === "resolutionChoice");
  const parent = decisions.find((decision) => decision.chosenAction.type === "activateMainAbility");
  assert.ok(response, JSON.stringify(decisions.map((decision) => ({
    chosen: decision.chosenAction,
    candidates: decision.candidates.map((candidate) => candidate.action)
  }))));
  assert.ok(response.candidates.length >= 2);
  assert.equal(playout.state.players.P1.deck[0].defId, "demo_rookie");
  assert.ok(response.candidates.some((candidate) => candidate.features[
    "context.resolution.private_search_order.searchtopdeck.bottom_slot_1.card.demo_rookie"
  ] === 1));
  assert.equal(Object.keys(parent.candidates.find((candidate) => candidate.action.type === "activateMainAbility").features)
    .some((key) => key.includes("demo_rookie") || key.includes("demo_raider") || key.includes("demo_finisher")), false);
});

test("post-search policy can keep, play, or Raid the selected card", () => {
  const catalog = {
    ...sampleCatalog,
    private_search_alternative: {
      id: "private_search_alternative",
      number: "DEM-1-094B",
      sourceCode: "DEM",
      name: "Search Alternative",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      abilities: [{
        id: "search-alternative-main",
        timing: "activateMain",
        oncePerTurn: true,
        effect: {
          kind: "searchTopDeck",
          count: 1,
          min: 1,
          max: 1,
          destination: "hand",
          filter: { type: CARD_TYPES.CHARACTER },
          selectedAlternative: {
            choiceKey: "searchPlayInstead",
            allowRaid: true,
            rested: false,
            destinationLine: LINES.FRONT,
            filter: { type: CARD_TYPES.CHARACTER, apCost: 1, requiredEnergyFulfilled: true }
          }
        }
      }]
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
  game.players.P1.frontLine = [permanent("P1", "private_search_alternative", "search-alternative")];
  game.players.P1.energyLine = [permanent("P1", "demo_rookie", "search-raid-base")];
  game.players.P1.deck = [{ uid: "search-alternative-raider", owner: "P1", defId: "demo_raider", faceUp: false }];
  game.players.P1.hand = [];
  const decisions = [];
  runAutoplayGame(game, {
    maxActions: 1,
    maxTurns: 10,
    policy: { weights: { activateMain: 10000, advancePhase: -10000 } },
    decisionRecorder: (decision) => decisions.push(decision)
  });

  const parent = decisions.find((decision) => decision.chosenAction.type === "activateMainAbility");
  const response = decisions.find((decision) => decision.chosenAction.type === "resolutionChoice");
  const featureKeys = response.candidates.map((candidate) => Object.keys(candidate.features));
  assert.ok(featureKeys.some((keys) => keys.some((key) => key.includes("alternative_keep.card.demo_raider"))));
  assert.ok(featureKeys.some((keys) => keys.some((key) => key.includes("alternative_play.card.demo_raider"))));
  assert.ok(featureKeys.some((keys) => keys.some((key) => key.includes("alternative_raid.card.demo_raider"))));
  assert.equal(Object.keys(parent.candidates.find((candidate) => candidate.action.type === "activateMainAbility").features)
    .some((key) => key.includes("demo_raider")), false);
});

test("autoplay exposes optional-instead branches and their attack choices", () => {
  const catalog = {
    ...sampleCatalog,
    private_instead_pilot: {
      id: "private_instead_pilot",
      number: "DEM-1-095",
      sourceCode: "DEM",
      name: "Instead Pilot",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 3000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      abilities: [{
        id: "instead-attack",
        timing: "whenAttacking",
        oncePerTurn: false,
        effect: {
          kind: "optionalInstead",
          choiceKey: "useInstead",
          requiredMovedFromHand: 1,
          costEffect: { kind: "moveHandToZone", amount: 1, destination: "sideline" },
          baseEffect: { kind: "draw", amount: 1 },
          insteadEffect: { kind: "damageOpponent", amount: 1 }
        }
      }]
    }
  };
  let game = createSimulationGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  }).state;
  game.phase = PHASES.ATTACK;
  game.activePlayer = "P1";
  game.players.P1.frontLine = [permanent("P1", "private_instead_pilot", "instead-pilot")];
  game.players.P1.hand = [{ uid: "instead-cost", owner: "P1", defId: "demo_rookie", faceUp: true }];
  const decisions = [];

  runAutoplayGame(game, {
    maxActions: 1,
    maxTurns: 10,
    decisionRecorder: (decision) => decisions.push(decision)
  });

  const attacks = decisions[0].candidates.filter((candidate) => candidate.action.type === "declareAttack");
  assert.equal(attacks.length, 2);
  assert.ok(attacks.some((candidate) => candidate.features["context.choice.private_instead_pilot.attack.useinstead.true"] === 1));
  assert.ok(attacks.some((candidate) => candidate.features["context.choice.private_instead_pilot.attack.useinstead.false"] === 1));
});

test("revealed-card effects decide play, Raid, or decline only after revealing the top card", () => {
  const catalog = {
    ...sampleCatalog,
    private_reveal_plan: {
      id: "private_reveal_plan",
      number: "DEM-1-096",
      sourceCode: "DEM",
      name: "Reveal Plan",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 3000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      abilities: [{
        id: "reveal-attack",
        timing: "whenAttacking",
        oncePerTurn: false,
        effect: {
          kind: "revealTopDeckOptionalPlayOrRaidInstead",
          filter: { type: CARD_TYPES.CHARACTER },
          allowRaid: true,
          rested: true,
          destinationLine: LINES.FRONT,
          destinations: ["top", "bottom"],
          defaultDestination: "top"
        }
      }]
    }
  };
  const decisionsForTop = (topCard) => {
    let game = createSimulationGame({
      catalog,
      decks: { P1: sampleDeckList, P2: sampleDeckList },
      skipShuffle: true,
      validateDecks: false
    }).state;
    game.phase = PHASES.ATTACK;
    game.activePlayer = "P1";
    game.players.P1.frontLine = [permanent("P1", "private_reveal_plan", "reveal-plan")];
    game.players.P1.energyLine = [permanent("P1", "demo_rookie", "reveal-raid-base")];
    game.players.P1.deck = [{ uid: `top-${topCard}`, owner: "P1", defId: topCard, faceUp: false }];
    const decisions = [];
    runAutoplayGame(game, {
      maxActions: 1,
      maxTurns: 10,
      decisionRecorder: (decision) => decisions.push(decision)
    });
    return decisions;
  };

  const raidDecisions = decisionsForTop("demo_raider");
  const normalDecisions = decisionsForTop("demo_rookie");
  const raidParent = raidDecisions.find((decision) => decision.chosenAction.type === "declareAttack");
  const normalParent = normalDecisions.find((decision) => decision.chosenAction.type === "declareAttack");
  const raidNested = raidDecisions.find((decision) => decision.chosenAction.type === "resolutionChoice");
  const normalNested = normalDecisions.find((decision) => decision.chosenAction.type === "resolutionChoice");
  const raidParentAttacks = raidParent.candidates.filter((candidate) => candidate.action.type === "declareAttack");
  const normalParentAttacks = normalParent.candidates.filter((candidate) => candidate.action.type === "declareAttack");

  assert.equal(raidParentAttacks.length, 1);
  assert.equal(normalParentAttacks.length, 1);
  assert.deepEqual(raidParentAttacks[0].features, normalParentAttacks[0].features);
  assert.equal(Object.keys(raidParentAttacks[0].features).some((key) => key.includes("demo_raider")), false);
  assert.ok(raidNested.candidates.some((candidate) => Object.keys(candidate.features)
    .some((key) => key.includes(".raid.card.demo_raider"))));
  assert.ok(raidNested.candidates.some((candidate) => Object.keys(candidate.features)
    .some((key) => key.includes(".play.card.demo_raider"))));
  assert.ok(raidNested.candidates.some((candidate) => Object.keys(candidate.features)
    .some((key) => key.includes(".decline.") && key.includes("demo_raider"))));
  assert.equal(normalNested.candidates.some((candidate) => Object.keys(candidate.features)
    .some((key) => key.includes("demo_raider"))), false);
  assert.ok(normalNested.candidates.some((candidate) => Object.keys(candidate.features)
    .some((key) => key.includes("demo_rookie"))));
});

test("opponent-owned effect responses are not player policy features", () => {
  const catalog = {
    ...sampleCatalog,
    private_opponent_choice: {
      id: "private_opponent_choice",
      number: "DEM-1-097",
      sourceCode: "DEM",
      name: "Opponent Choice",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      abilities: [{
        id: "opponent-choice-main",
        timing: "activateMain",
        oncePerTurn: true,
        effect: { kind: "opponentMayDraw", amount: 1, choiceKey: "customResponse" }
      }]
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
  game.players.P1.frontLine = [permanent("P1", "private_opponent_choice", "opponent-choice")];
  const decisions = [];
  runAutoplayGame(game, {
    maxActions: 1,
    maxTurns: 10,
    policy: { weights: { activateMain: 10000, advancePhase: -10000 } },
    decisionRecorder: (decision) => decisions.push(decision)
  });
  const candidate = decisions[0].candidates.find((item) => item.action.type === "activateMainAbility");
  assert.equal(Object.keys(candidate.features).some((key) => key.includes("customresponse")), false);
  const response = decisions.find((decision) => decision.chosenAction.type === "resolutionChoice");
  assert.equal(response.player, "P2");
  assert.equal(response.candidates.length, 2);
  assert.ok(response.candidates.some((item) => item.features["context.resolution.private_opponent_choice.opponentmaydraw.amount.0"] === 1));
  assert.ok(response.candidates.some((item) => item.features["context.resolution.private_opponent_choice.opponentmaydraw.amount.1"] === 1));
});

test("opponent payment responses enumerate exact card subsets and resolve stable card identities", () => {
  const catalog = {
    ...sampleCatalog,
    private_opponent_payment: {
      id: "private_opponent_payment",
      number: "DEM-1-097A",
      sourceCode: "DEM",
      name: "Opponent Payment",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      abilities: [{
        id: "opponent-payment-main",
        timing: "activateMain",
        oncePerTurn: true,
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
  let game = createSimulationGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  }).state;
  game.phase = PHASES.MAIN;
  game.activePlayer = "P1";
  game.players.P1.frontLine = [permanent("P1", "private_opponent_payment", "opponent-payment")];
  game.players.P1.sideline = [];
  game.players.P2.hand = [
    { uid: "payment-a", owner: "P2", defId: "demo_rookie", faceUp: true },
    { uid: "payment-b", owner: "P2", defId: "demo_raider", faceUp: true },
    { uid: "payment-c", owner: "P2", defId: "demo_finisher", faceUp: true }
  ];
  const decisions = [];
  const playout = runAutoplayGame(game, {
    maxActions: 1,
    maxTurns: 10,
    policy: {
      P1: { weights: { activateMain: 10000, advancePhase: -10000 } },
      P2: { weights: {
        "context.resolution.private_opponent_payment.opponentmaymovecardsbetweenzoneselse.payment.sideline.card.demo_rookie": 50000,
        "context.resolution.private_opponent_payment.opponentmaymovecardsbetweenzoneselse.payment.sideline.card.demo_finisher": 50000,
        "context.resolution.private_opponent_payment.opponentmaymovecardsbetweenzoneselse.payment.sideline.card.demo_raider": -50000
      } }
    },
    decisionRecorder: (decision) => decisions.push(decision)
  });

  const response = decisions.find((decision) => decision.chosenAction.type === "resolutionChoice");
  assert.equal(response.player, "P2");
  assert.equal(response.candidates.length, 4);
  assert.deepEqual(playout.state.players.P1.sideline.map((card) => card.uid).sort(), ["payment-a", "payment-c"]);
  assert.deepEqual(playout.state.players.P2.hand.map((card) => card.uid), ["payment-b"]);
});

test("revealed opponent-hand choices become nested policy decisions without parent leakage", () => {
  const revealedCard = (id, name, bp) => ({
    ...sampleCatalog.demo_rookie,
    id,
    number: `DEM-${id}`,
    name,
    bp
  });
  const catalog = {
    ...sampleCatalog,
    private_reveal_low: revealedCard("private_reveal_low", "Reveal Low", 1000),
    private_reveal_mid: revealedCard("private_reveal_mid", "Reveal Mid", 2500),
    private_reveal_high: revealedCard("private_reveal_high", "Reveal High", 5000),
    private_revealed_choice: {
      id: "private_revealed_choice",
      number: "DEM-1-097B",
      sourceCode: "DEM",
      name: "Revealed Choice",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      abilities: [{
        id: "revealed-choice-main",
        timing: "activateMain",
        oncePerTurn: true,
        effect: {
          kind: "sequence",
          effects: [
            { kind: "revealOpponentHand" },
            {
              kind: "moveCardBetweenZones",
              player: "opponent",
              source: "hand",
              destination: "deck",
              position: "top",
              count: 1
            }
          ]
        }
      }]
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
  game.players.P1.frontLine = [permanent("P1", "private_revealed_choice", "revealed-choice")];
  game.players.P2.hand = [
    { uid: "reveal-low", owner: "P2", defId: "private_reveal_low", faceUp: true },
    { uid: "reveal-mid", owner: "P2", defId: "private_reveal_mid", faceUp: true },
    { uid: "reveal-high", owner: "P2", defId: "private_reveal_high", faceUp: true }
  ];
  const decisions = [];
  const playout = runAutoplayGame(game, {
    maxActions: 1,
    maxTurns: 10,
    policy: { weights: {
      activateMain: 10000,
      advancePhase: -10000,
      "context.resolution.private_revealed_choice.chooserevealedzonecards.selected.deck.card.private_reveal_high": 50000
    } },
    decisionRecorder: (decision) => decisions.push(decision)
  });

  const parent = decisions.find((decision) => decision.chosenAction.type === "activateMainAbility");
  const response = decisions.find((decision) => decision.chosenAction.type === "resolutionChoice");
  assert.equal(response.player, "P1");
  assert.equal(response.candidates.length, 3);
  assert.equal(playout.state.players.P2.deck[0].uid, "reveal-high");
  assert.equal(Object.keys(parent.candidates.find((candidate) => candidate.action.type === "activateMainAbility").features)
    .some((key) => key.includes("private_reveal_low") || key.includes("private_reveal_mid") || key.includes("private_reveal_high")), false);
});

test("optional opponent hand plays are chosen by the responder policy and may be declined", () => {
  const playable = (id, name, bp) => ({
    ...sampleCatalog.demo_rookie,
    id,
    number: `DEM-${id}`,
    name,
    bp,
    requiredEnergy: { color: "green", amount: 1 },
    apCost: 1
  });
  const catalog = {
    ...sampleCatalog,
    private_opponent_play_low: playable("private_opponent_play_low", "Opponent Play Low", 1000),
    private_opponent_play_high: playable("private_opponent_play_high", "Opponent Play High", 5000),
    private_opponent_hand_play: {
      id: "private_opponent_hand_play",
      number: "DEM-1-097C",
      sourceCode: "DEM",
      name: "Opponent Hand Play",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      abilities: [{
        id: "opponent-hand-play-main",
        timing: "activateMain",
        oncePerTurn: true,
        effect: {
          kind: "playCardFromZone",
          player: "opponent",
          zone: "hand",
          min: 0,
          max: 1,
          rested: false,
          destinationLine: LINES.FRONT,
          choiceKey: "opponentPlayHandIndex",
          filter: { type: CARD_TYPES.CHARACTER, requiredEnergyMax: 2, apCost: 1 }
        }
      }]
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
  game.players.P1.frontLine = [permanent("P1", "private_opponent_hand_play", "opponent-hand-play")];
  game.players.P2.hand = [
    { uid: "opponent-play-low", owner: "P2", defId: "private_opponent_play_low", faceUp: true },
    { uid: "opponent-play-high", owner: "P2", defId: "private_opponent_play_high", faceUp: true }
  ];
  const decisions = [];
  const playout = runAutoplayGame(game, {
    maxActions: 1,
    maxTurns: 10,
    policy: {
      P1: { weights: { activateMain: 10000, advancePhase: -10000 } },
      P2: { weights: {
        "context.resolution.private_opponent_hand_play.opponentmayplaycardfromhand.play.frontline.card.private_opponent_play_low": 50000,
        "context.resolution.private_opponent_hand_play.opponentmayplaycardfromhand.play.frontline.card.private_opponent_play_high": -50000
      } }
    },
    decisionRecorder: (decision) => decisions.push(decision)
  });

  const parent = decisions.find((decision) => decision.chosenAction.type === "activateMainAbility");
  const response = decisions.find((decision) => decision.chosenAction.type === "resolutionChoice");
  assert.equal(response.player, "P2");
  assert.equal(response.candidates.length, 3);
  assert.ok(response.candidates.some((candidate) => candidate.features[
    "context.resolution.private_opponent_hand_play.opponentmayplaycardfromhand.decline"
  ] === 1));
  assert.equal(playout.state.players.P2.frontLine[0].cards.at(-1).uid, "opponent-play-low");
  assert.deepEqual(playout.state.players.P2.hand.map((card) => card.uid), ["opponent-play-high"]);
  assert.equal(Object.keys(parent.candidates.find((candidate) => candidate.action.type === "activateMainAbility").features)
    .some((key) => key.includes("private_opponent_play_low") || key.includes("private_opponent_play_high")), false);
});

test("play-or-Raid effects expose both legal plans and use the post-event hand", () => {
  const catalog = {
    ...sampleCatalog,
    private_play_or_raid_event: {
      id: "private_play_or_raid_event",
      number: "DEM-1-098",
      sourceCode: "DEM",
      name: "Play or Raid Event",
      type: CARD_TYPES.EVENT,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      affinities: [],
      eventEffect: {
        kind: "playOrRaidCardFromZone",
        zones: ["hand"],
        count: 1,
        choiceKey: "playZoneIndex",
        raidChoiceKey: "performRaid",
        filter: { id: "demo_raider" },
        allowRaid: true,
        rested: true,
        destinationLine: LINES.FRONT
      }
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
  game.players.P1.frontLine = [permanent("P1", "demo_rookie", "play-or-raid-base")];
  game.players.P1.hand = [
    { uid: "play-or-raid-event", owner: "P1", defId: "private_play_or_raid_event", faceUp: true },
    { uid: "play-or-raid-card", owner: "P1", defId: "demo_raider", faceUp: true }
  ];

  const candidates = autoplayActionCandidates(game, "P1")
    .filter((action) => action.type === "playCard" && action.handIndex === 0);
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every((action) => action.choices.playZoneIndex.uid === "play-or-raid-card"));
  const raid = candidates.find((action) => action.choices.performRaid === true);
  const normal = candidates.find((action) => action.choices.performRaid === false);
  assert.ok(raid);
  assert.ok(normal);

  const raidState = applyAction(game, raid);
  const normalState = applyAction(game, normal);
  assert.equal(raidState.players.P1.frontLine.length, 1);
  assert.equal(raidState.players.P1.frontLine[0].cards.length, 2);
  assert.equal(normalState.players.P1.frontLine.length, 2);
  assert.equal(normalState.players.P1.frontLine[1].cards.at(-1).defId, "demo_raider");
  const normalFeatures = pilotActionFeatures(game, "P1", normal);
  assert.equal(normalFeatures["context.choice.private_play_or_raid_event.play.playzoneindex.card.demo_raider"], 1);
  assert.equal(normalFeatures["context.choice.private_play_or_raid_event.play.performraid.false"], 1);
});

test("play-or-Raid effects expose every legal Raid base", () => {
  const catalog = {
    ...sampleCatalog,
    private_rookie_variant: {
      ...sampleCatalog.demo_rookie,
      id: "private_rookie_variant",
      number: "DEM-1-116",
      bp: 2500
    },
    private_raid_target_event: {
      id: "private_raid_target_event",
      number: "DEM-1-117",
      sourceCode: "DEM",
      name: "Raid Target Event",
      type: CARD_TYPES.EVENT,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      affinities: [],
      eventEffect: {
        kind: "playOrRaidCardFromZone",
        zones: ["hand"],
        count: 1,
        choiceKey: "playedCard",
        raidChoiceKey: "performRaid",
        raidTargetChoiceKey: "chosenRaidBase",
        filter: { id: "demo_raider" },
        allowRaid: true,
        rested: true,
        destinationLine: LINES.FRONT
      }
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
  game.players.P1.frontLine = [
    permanent("P1", "demo_rookie", "raid-base-rookie"),
    permanent("P1", "private_rookie_variant", "raid-base-variant")
  ];
  game.players.P1.hand = [
    { uid: "raid-target-event", owner: "P1", defId: "private_raid_target_event", faceUp: true },
    { uid: "raid-target-raider", owner: "P1", defId: "demo_raider", faceUp: true }
  ];

  const candidates = autoplayActionCandidates(game, "P1")
    .filter((action) => action.type === "playCard" && action.handIndex === 0);
  const raids = candidates.filter((action) => action.choices.performRaid === true);
  const normal = candidates.filter((action) => action.choices.performRaid === false);
  assert.equal(raids.length, 2);
  assert.equal(normal.length, 1);
  assert.deepEqual(raids.map((action) => action.choices.chosenRaidBase.index).sort(), [0, 1]);
  const variantRaid = raids.find((action) => action.choices.chosenRaidBase.index === 1);
  const variantFeatures = pilotActionFeatures(game, "P1", variantRaid);
  assert.equal(variantFeatures["context.choice.private_raid_target_event.play.chosenraidbase.card.private_rookie_variant"], 1);
  const resolved = applyAction(game, variantRaid);
  assert.equal(resolved.players.P1.frontLine[0].cards.length, 1);
  assert.equal(resolved.players.P1.frontLine[1].cards.at(-1).uid, "raid-target-raider");
});

test("play-or-Raid effects learn whether to move from energy and what a full front line replaces", () => {
  const catalog = {
    ...sampleCatalog,
    private_full_raid_event: {
      id: "private_full_raid_event",
      number: "DEM-FULL-RAID-EVENT",
      sourceCode: "DEM",
      name: "Full Raid Event",
      type: CARD_TYPES.EVENT,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      affinities: [],
      eventEffect: {
        kind: "playOrRaidCardFromZone",
        zones: ["hand"],
        count: 1,
        choiceKey: "playedCard",
        raidChoiceKey: "performRaid",
        raidTargetChoiceKey: "chosenRaidBase",
        allowRaid: true,
        rested: true,
        destinationLine: LINES.FRONT,
        filter: { id: "demo_raider" }
      }
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
  game.players.P1.frontLine = Array.from({ length: MAX_LINE_SIZE }, (_, index) => (
    permanent("P1", "demo_guardian", `full-effect-front-${index}`)
  ));
  game.players.P1.energyLine = [permanent("P1", "demo_rookie", "full-effect-raid-base")];
  game.players.P1.hand = [
    { uid: "full-effect-event", owner: "P1", defId: "private_full_raid_event", faceUp: true },
    { uid: "full-effect-raider", owner: "P1", defId: "demo_raider", faceUp: true }
  ];

  const candidates = autoplayActionCandidates(game, "P1")
    .filter((action) => action.type === "playCard" && action.handIndex === 0);
  const normal = candidates.filter((action) => action.choices.performRaid === false);
  const raids = candidates.filter((action) => action.choices.performRaid === true);
  assert.equal(normal.length, 4);
  assert.equal(raids.filter((action) => action.choices.moveRaidToFront === false).length, 1);
  assert.equal(raids.filter((action) => action.choices.moveRaidToFront === true).length, 4);

  const moveRaid = raids.find((action) => action.choices.moveRaidToFront
    && action.choices.raidMoveReplaceIndex.index === 2);
  assert.ok(moveRaid);
  const features = pilotActionFeatures(game, "P1", moveRaid);
  assert.ok(Object.keys(features).some((key) => key.includes("raidmovereplaceindex") && key.includes("demo_guardian")));
  const resolved = applyAction(game, moveRaid);
  assert.equal(resolved.players.P1.energyLine.length, 0);
  assert.equal(resolved.players.P1.frontLine.length, MAX_LINE_SIZE);
  assert.equal(resolved.players.P1.frontLine.at(-1).cards.at(-1).defId, "demo_raider");
  assert.equal(resolved.players.P1.removal.length, 1);
});

test("Raid triggers make a post-reveal policy choice including full-line replacements", () => {
  const catalog = {
    ...sampleCatalog,
    private_trigger_attacker: {
      ...sampleCatalog.demo_guardian,
      id: "private_trigger_attacker",
      number: "DEM-TRIGGER-ATTACKER",
      bp: 5000
    },
    private_trigger_raid_base: {
      ...sampleCatalog.demo_rookie,
      id: "private_trigger_raid_base",
      number: "DEM-TRIGGER-RAID-BASE",
      name: "Trigger Raid Base"
    },
    private_raid_trigger_card: {
      ...sampleCatalog.demo_raider,
      id: "private_raid_trigger_card",
      number: "DEM-RAID-TRIGGER-CARD",
      name: "Raid Trigger Card",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      raid: { names: ["Trigger Raid Base"], affinities: [] },
      trigger: { type: TRIGGER_TYPES.RAID }
    }
  };
  let game = createSimulationGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  }).state;
  game.phase = PHASES.ATTACK;
  game.activePlayer = "P1";
  game.players.P1.frontLine = [permanent("P1", "private_trigger_attacker", "trigger-attacker")];
  game.players.P2.frontLine = Array.from({ length: MAX_LINE_SIZE }, (_, index) => (
    permanent("P2", "demo_guardian", `trigger-front-${index}`, true)
  ));
  game.players.P2.energyLine = [permanent("P2", "private_trigger_raid_base", "trigger-raid-base")];
  game.players.P2.life = [
    {
      uid: "raid-trigger-life-card",
      owner: "P2",
      defId: "private_raid_trigger_card",
      faceUp: false
    },
    {
      uid: "raid-trigger-life-buffer",
      owner: "P2",
      defId: "demo_rookie",
      faceUp: false
    }
  ];
  game = applyAction(game, {
    type: "declareAttack",
    player: "P1",
    attackerIndex: 0,
    target: { type: "player" }
  });

  const offTargetDecisions = [];
  const offTarget = runAutoplayGame(game, {
    maxActions: 1,
    maxTurns: 10,
    exploration: {
      P2: { mode: "counterfactual-probe", rate: 1, maxPerGame: 1 }
    },
    counterfactual: {
      P2: {
        rate: 1,
        maxPerGame: 1,
        rolloutMaxActions: 8,
        rolloutMaxPlayerTurns: 1,
        adaptiveRollout: false,
        decisionWindow: 0,
        phaseWeights: { main: 1, attack: 0, block: 0, movement: 0 }
      }
    },
    decisionRecorder: (decision) => offTargetDecisions.push(decision)
  });
  const offTargetResponse = offTargetDecisions.find((decision) => decision.chosenAction.decisionKind === "raidTrigger");
  assert.ok(offTargetResponse);
  assert.equal(offTargetResponse.counterfactual, null);
  assert.equal(offTarget.counterfactualsEvaluated, 0);

  const decisions = [];
  const playout = runAutoplayGame(game, {
    maxActions: 1,
    maxTurns: 10,
    exploration: {
      P2: { mode: "counterfactual-probe", rate: 1, maxPerGame: 1 }
    },
    counterfactual: {
      P2: {
        rate: 1,
        maxPerGame: 1,
        rolloutMaxActions: 8,
        rolloutMaxPlayerTurns: 1,
        adaptiveRollout: false,
        decisionWindow: 0,
        phaseWeights: { main: 0, attack: 0, block: 1, movement: 0 }
      }
    },
    decisionRecorder: (decision) => decisions.push(decision)
  });
  const response = decisions.find((decision) => decision.chosenAction.decisionKind === "raidTrigger");
  assert.ok(response, JSON.stringify(decisions.map((decision) => ({
    player: decision.player,
    action: decision.chosenAction,
    candidates: decision.candidates.length
  }))));
  assert.equal(response.player, "P2");
  assert.equal(response.candidates.length, 6);
  assert.equal(response.exploration, null);
  assert.ok(response.counterfactual);
  assert.equal(response.counterfactual.alternativeSelection, "nested-resolution-diversity");
  assert.notEqual(response.counterfactual.alternativeIndex, response.chosenIndex);
  assert.ok(response.counterfactual.alternativeAction.resolutionOption);
  assert.equal(playout.counterfactualsEvaluated, 1);
  assert.equal(playout.explorationDiagnostics.actionsByPlayer.P2, 0);
  assert.equal(response.candidates.filter((candidate) => Object.keys(candidate.features)
    .some((key) => key.includes("movetofront.true"))).length, 4);
  assert.ok(response.candidates.some((candidate) => candidate.features[
    "context.resolution.private_raid_trigger_card.raidtrigger.decline.card.private_raid_trigger_card"
  ] === 1));

  const attemptedContextFeatures = new Set(response.candidates
    .filter((candidate) => candidate.action.resolutionOption !== "decline")
    .flatMap((candidate) => Object.keys(candidate.features))
    .filter((feature) => feature.startsWith("context.")));
  const rotatedDecisions = [];
  runAutoplayGame(game, {
    maxActions: 1,
    maxTurns: 10,
    exploration: {
      P2: {
        mode: "counterfactual-probe",
        rate: 1,
        maxPerGame: 1,
        evidence: {
          targetObservations: 24,
          featureObservations: Object.fromEntries([...attemptedContextFeatures].map((feature) => [feature, 24])),
          featureAttempts: Object.fromEntries([...attemptedContextFeatures].map((feature) => [feature, 100]))
        }
      }
    },
    counterfactual: {
      P2: {
        rate: 1,
        maxPerGame: 1,
        rolloutMaxActions: 8,
        rolloutMaxPlayerTurns: 1,
        adaptiveRollout: false,
        decisionWindow: 0,
        phaseWeights: { main: 0, attack: 0, block: 1, movement: 0 }
      }
    },
    decisionRecorder: (decision) => rotatedDecisions.push(decision)
  });
  const rotatedResponse = rotatedDecisions.find((decision) => decision.chosenAction.decisionKind === "raidTrigger");
  assert.equal(rotatedResponse.counterfactual.alternativeAction.resolutionOption, "decline");
});

test("Raid trigger runtime choices account for a line filled before a when-played character is placed", () => {
  const catalog = {
    ...sampleCatalog,
    private_nested_trigger_attacker: {
      ...sampleCatalog.demo_guardian,
      id: "private_nested_trigger_attacker",
      number: "DEM-NESTED-TRIGGER-ATTACKER",
      bp: 5000
    },
    private_nested_trigger_base: {
      ...sampleCatalog.demo_rookie,
      id: "private_nested_trigger_base",
      number: "DEM-NESTED-TRIGGER-BASE",
      name: "Nested Trigger Base"
    },
    private_nested_trigger_guest: {
      ...sampleCatalog.demo_rookie,
      id: "private_nested_trigger_guest",
      number: "DEM-NESTED-TRIGGER-GUEST",
      name: "Nested Trigger Guest"
    },
    private_nested_raid_trigger: {
      ...sampleCatalog.demo_raider,
      id: "private_nested_raid_trigger",
      number: "DEM-NESTED-RAID-TRIGGER",
      name: "Nested Raid Trigger",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      raid: { names: ["Nested Trigger Base"], affinities: [] },
      trigger: { type: TRIGGER_TYPES.RAID },
      abilities: [{
        id: "whenPlayed-1",
        timing: TIMINGS.WHEN_PLAYED,
        effect: {
          kind: "playCardFromZone",
          zone: "hand",
          rested: false,
          min: 0,
          filter: { type: CARD_TYPES.CHARACTER, withoutRaid: true },
          destinationLines: [LINES.FRONT, LINES.ENERGY],
          destinationLineChoiceKey: "destinationLine"
        }
      }]
    }
  };
  let game = createSimulationGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  }).state;
  game.phase = PHASES.ATTACK;
  game.activePlayer = "P1";
  game.players.P1.frontLine = [permanent("P1", "private_nested_trigger_attacker", "nested-trigger-attacker")];
  game.players.P2.frontLine = Array.from({ length: MAX_LINE_SIZE - 1 }, (_, index) => (
    permanent("P2", "demo_guardian", `nested-trigger-front-${index}`, true)
  ));
  game.players.P2.energyLine = [permanent("P2", "private_nested_trigger_base", "nested-trigger-base")];
  game.players.P2.hand = [{
    uid: "nested-trigger-guest-card",
    owner: "P2",
    defId: "private_nested_trigger_guest",
    faceUp: true
  }];
  game.players.P2.life = [
    {
      uid: "nested-raid-trigger-life-card",
      owner: "P2",
      defId: "private_nested_raid_trigger",
      faceUp: false
    },
    {
      uid: "nested-raid-trigger-life-buffer",
      owner: "P2",
      defId: "demo_rookie",
      faceUp: false
    }
  ];
  game = applyAction(game, {
    type: "declareAttack",
    player: "P1",
    attackerIndex: 0,
    target: { type: "player" }
  });

  const decisions = [];
  const playout = runAutoplayGame(game, {
    maxActions: 1,
    maxTurns: 10,
    decisionRecorder: (decision) => decisions.push(decision)
  });
  const raidChoice = decisions.find((decision) => decision.chosenAction.decisionKind === "raidTrigger");
  const playChoice = decisions.find((decision) => decision.chosenAction.decisionKind === "playCardFromZone");

  assert.ok(raidChoice);
  assert.equal(raidChoice.selectedChoices.moveToFront, true);
  assert.ok(playChoice);
  assert.equal(playChoice.selectedChoices.destinationLine, LINES.ENERGY);
  assert.notEqual(playout.stoppedReason, "noLegalAutoplayAction");
  assert.equal(playout.failureDiagnostics, null);
  assert.equal(playout.state.players.P2.frontLine.length, MAX_LINE_SIZE);
  assert.equal(playout.state.players.P2.energyLine.at(-1).cards.at(-1).defId, "private_nested_trigger_guest");
});

test("nested looked-card play choices use the engine's complete card filter", () => {
  const catalog = {
    ...sampleCatalog,
    private_filter_attacker: {
      ...sampleCatalog.demo_guardian,
      id: "private_filter_attacker",
      number: "DEM-FILTER-ATTACKER",
      bp: 5000
    },
    private_filter_raid_base: {
      ...sampleCatalog.demo_rookie,
      id: "private_filter_raid_base",
      number: "DEM-FILTER-RAID-BASE",
      name: "Filter Raid Base"
    },
    private_filter_legal: {
      ...sampleCatalog.demo_rookie,
      id: "private_filter_legal",
      number: "DEM-FILTER-LEGAL",
      name: "Legal Looked Card",
      color: "yellow",
      apCost: 1,
      bp: 1000,
      affinities: []
    },
    private_filter_illegal: {
      ...sampleCatalog.demo_large_body,
      id: "private_filter_illegal",
      number: "DEM-FILTER-ILLEGAL",
      name: "Illegal Looked Card",
      color: "yellow",
      apCost: 1,
      bp: 5000,
      affinities: []
    },
    private_filter_trigger: {
      ...sampleCatalog.demo_raider,
      id: "private_filter_trigger",
      number: "DEM-FILTER-TRIGGER",
      name: "Filter Trigger",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      raid: { names: ["Filter Raid Base"], affinities: [] },
      trigger: { type: TRIGGER_TYPES.RAID },
      abilities: [{
        id: "whenPlayed-1",
        timing: TIMINGS.WHEN_PLAYED,
        effect: {
          kind: "lookTopDeckPlayOneAndMoveRest",
          count: 5,
          filter: {
            anyOf: [
              { affinity: "Sakamoto's" },
              { type: CARD_TYPES.CHARACTER, color: "yellow", apCost: 1, bpMax: 3500 }
            ]
          },
          rested: false,
          destinationLine: LINES.FRONT,
          remainingDestination: "bottom",
          allowRaid: false
        }
      }]
    }
  };
  let game = createSimulationGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  }).state;
  game.phase = PHASES.ATTACK;
  game.activePlayer = "P1";
  game.players.P1.frontLine = [permanent("P1", "private_filter_attacker", "filter-attacker")];
  game.players.P2.frontLine = [];
  game.players.P2.energyLine = [permanent("P2", "private_filter_raid_base", "filter-raid-base")];
  game.players.P2.deck = [
    { uid: "filter-illegal", owner: "P2", defId: "private_filter_illegal", faceUp: true },
    { uid: "filter-legal", owner: "P2", defId: "private_filter_legal", faceUp: true },
    { uid: "filter-rest-1", owner: "P2", defId: "demo_guardian", faceUp: true },
    { uid: "filter-rest-2", owner: "P2", defId: "demo_large_body", faceUp: true },
    { uid: "filter-rest-3", owner: "P2", defId: "demo_draw_event", faceUp: true }
  ];
  game.players.P2.life = [
    { uid: "filter-trigger-life", owner: "P2", defId: "private_filter_trigger", faceUp: false },
    { uid: "filter-life-buffer", owner: "P2", defId: "demo_rookie", faceUp: false }
  ];
  game = applyAction(game, {
    type: "declareAttack",
    player: "P1",
    attackerIndex: 0,
    target: { type: "player" }
  });

  const decisions = [];
  const playout = runAutoplayGame(game, {
    maxActions: 1,
    maxTurns: 10,
    decisionRecorder: (decision) => decisions.push(decision)
  });
  const lookedChoice = decisions.find((decision) => (
    decision.chosenAction.decisionKind === "lookTopDeckPlayOneAndMoveRest"
  ));

  assert.ok(lookedChoice);
  assert.equal(lookedChoice.selectedChoices.lookPlayIndex, 1);
  assert.equal(lookedChoice.candidates.some((candidate) => candidate.choices.lookPlayIndex === 0), false);
  assert.notEqual(playout.stoppedReason, "noLegalAutoplayAction");
  assert.equal(playout.failureDiagnostics, null);
  assert.equal(playout.state.players.P2.frontLine.at(-1).cards.at(-1).defId, "private_filter_legal");
});

test("hand-cost alternatives are separate card-specific learning actions", () => {
  const catalog = {
    ...sampleCatalog,
    private_hand_choice: {
      id: "private_hand_choice",
      number: "DEM-1-099",
      sourceCode: "DEM",
      name: "Hand Choice",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      abilities: [{
        id: "hand-choice-main",
        timing: "activateMain",
        oncePerTurn: true,
        effect: { kind: "moveHandToZone", amount: 1, destination: "sideline", choiceKey: "discardChoice" }
      }]
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
  game.players.P1.frontLine = [permanent("P1", "private_hand_choice", "hand-choice")];
  game.players.P1.hand = [
    { uid: "discard-rookie", owner: "P1", defId: "demo_rookie", faceUp: true },
    { uid: "discard-raider", owner: "P1", defId: "demo_raider", faceUp: true }
  ];

  const candidates = autoplayActionCandidates(game, "P1")
    .filter((action) => action.type === "activateMainAbility");
  assert.equal(candidates.length, 2);
  const featureSets = candidates.map((action) => pilotActionFeatures(game, "P1", action));
  assert.ok(featureSets.some((features) => features["context.choice.private_hand_choice.hand-choice-main.discardchoice.card.demo_rookie"] === 1));
  assert.ok(featureSets.some((features) => features["context.choice.private_hand_choice.hand-choice-main.discardchoice.card.demo_raider"] === 1));
});

test("multi-card zone costs move the full required count and expose bounded selections", () => {
  const catalog = {
    ...sampleCatalog,
    private_multi_zone_choice: {
      id: "private_multi_zone_choice",
      number: "DEM-1-100",
      sourceCode: "DEM",
      name: "Multi Zone Choice",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      abilities: [{
        id: "multi-zone-main",
        timing: "activateMain",
        oncePerTurn: true,
        effect: {
          kind: "sequence",
          effects: [
            {
              kind: "moveCardBetweenZones",
              source: "sideline",
              destination: "removal",
              count: 3,
              requiredMovedCountForFollowing: 3,
              choiceKey: "sidelineChoices"
            },
            { kind: "draw", amount: 1 }
          ]
        }
      }]
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
  game.players.P1.frontLine = [permanent("P1", "private_multi_zone_choice", "multi-zone")];
  game.players.P1.sideline = ["demo_rookie", "demo_raider", "demo_activator", "demo_finisher"]
    .map((defId, index) => ({ uid: `multi-zone-${index}`, owner: "P1", defId, faceUp: true }));

  const candidates = autoplayActionCandidates(game, "P1")
    .filter((action) => action.type === "activateMainAbility");
  assert.equal(candidates.length, 4);
  assert.ok(candidates.every((action) => action.choices.sidelineChoices.length === 3));
  const resolved = applyAction(game, candidates[0]);
  assert.equal(resolved.players.P1.removal.length, 3);
  assert.equal(resolved.players.P1.sideline.length, 1);
});

test("simultaneous hand plays select complete post-event card sets", () => {
  const catalog = {
    ...sampleCatalog,
    private_multi_play_event: {
      id: "private_multi_play_event",
      number: "DEM-1-102",
      sourceCode: "DEM",
      name: "Multi Play Event",
      type: CARD_TYPES.EVENT,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      affinities: [],
      eventEffect: {
        kind: "playCardFromZone",
        zones: ["hand"],
        count: 2,
        simultaneous: true,
        choiceKey: "playZoneIndex",
        filter: { type: CARD_TYPES.CHARACTER },
        rested: true,
        destinationLine: LINES.FRONT
      }
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
  game.players.P1.hand = [
    { uid: "multi-play-event", owner: "P1", defId: "private_multi_play_event", faceUp: true },
    { uid: "multi-play-rookie", owner: "P1", defId: "demo_rookie", faceUp: true },
    { uid: "multi-play-raider", owner: "P1", defId: "demo_raider", faceUp: true },
    { uid: "multi-play-activator", owner: "P1", defId: "demo_activator", faceUp: true }
  ];

  const candidates = autoplayActionCandidates(game, "P1")
    .filter((action) => action.type === "playCard" && action.handIndex === 0);
  assert.equal(candidates.length, 10);
  const playTwo = candidates.find((action) => action.choices.playZoneIndex.length === 2);
  assert.ok(playTwo);
  assert.equal(playTwo.choices.playZoneIndex.some((choice) => choice.uid === "multi-play-event"), false);
  const resolved = applyAction(game, playTwo);
  assert.equal(resolved.players.P1.frontLine.length, 2);
  assert.equal(resolved.players.P1.sideline.some((card) => card.uid === "multi-play-event"), true);
});

test("simultaneous plays expose both card-specific ability orders", () => {
  const character = (id, name, whenPlayedEffect) => ({
    id,
    number: id,
    sourceCode: "DEM",
    name,
    type: CARD_TYPES.CHARACTER,
    color: "green",
    requiredEnergy: { color: "green", amount: 0 },
    apCost: 0,
    bp: 1000,
    energy: [{ color: "green", amount: 1 }],
    affinities: [],
    abilities: [{
      id: `${id}-when-played`,
      timing: TIMINGS.WHEN_PLAYED,
      oncePerTurn: false,
      effect: whenPlayedEffect
    }]
  });
  const catalog = {
    ...sampleCatalog,
    private_order_sideline: character(
      "private_order_sideline",
      "Order Sideline",
      { kind: "moveTopDeck", amount: 1, destination: "sideline" }
    ),
    private_order_draw: character(
      "private_order_draw",
      "Order Draw",
      { kind: "draw", amount: 1 }
    ),
    private_simultaneous_event: {
      id: "private_simultaneous_event",
      number: "DEM-1-115",
      sourceCode: "DEM",
      name: "Simultaneous Event",
      type: CARD_TYPES.EVENT,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      affinities: [],
      eventEffect: {
        kind: "playCardFromZone",
        zones: ["hand"],
        count: 2,
        simultaneous: true,
        choiceKey: "playedCards",
        abilityOrderChoiceKey: "simultaneousPlayedOrder",
        filter: { type: CARD_TYPES.CHARACTER },
        rested: true,
        destinationLine: LINES.FRONT
      }
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
  game.players.P1.hand = [
    { uid: "simultaneous-event", owner: "P1", defId: "private_simultaneous_event", faceUp: true },
    { uid: "order-sideline", owner: "P1", defId: "private_order_sideline", faceUp: true },
    { uid: "order-draw", owner: "P1", defId: "private_order_draw", faceUp: true }
  ];
  game.players.P1.deck = [
    { uid: "order-top-rookie", owner: "P1", defId: "demo_rookie", faceUp: false },
    { uid: "order-next-raider", owner: "P1", defId: "demo_raider", faceUp: false }
  ];

  const pairCandidates = autoplayActionCandidates(game, "P1")
    .filter((action) => action.type === "playCard"
      && action.handIndex === 0
      && action.choices.playedCards.length === 2);
  assert.equal(pairCandidates.length, 2);
  assert.deepEqual(pairCandidates.map((action) => action.choices.simultaneousPlayedOrder.join(",")).sort(), ["0,1", "1,0"]);
  const identity = pairCandidates.find((action) => action.choices.simultaneousPlayedOrder[0] === 0);
  const reverse = pairCandidates.find((action) => action.choices.simultaneousPlayedOrder[0] === 1);
  const identityFeatures = pilotActionFeatures(game, "P1", identity);
  const reverseFeatures = pilotActionFeatures(game, "P1", reverse);
  assert.equal(identityFeatures["context.choice.private_simultaneous_event.play.simultaneousplayedorder.slot_1.card.private_order_sideline"], 1);
  assert.equal(reverseFeatures["context.choice.private_simultaneous_event.play.simultaneousplayedorder.slot_1.card.private_order_draw"], 1);

  const identityState = applyAction(game, identity);
  const reverseState = applyAction(game, reverse);
  assert.equal(identityState.players.P1.hand.some((card) => card.uid === "order-next-raider"), true);
  assert.equal(reverseState.players.P1.hand.some((card) => card.uid === "order-top-rookie"), true);
});

test("face-down life selections never become card-identity or UID features", () => {
  const catalog = {
    ...sampleCatalog,
    private_life_choice: {
      id: "private_life_choice",
      number: "DEM-1-101",
      sourceCode: "DEM",
      name: "Life Choice",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      abilities: [{
        id: "life-choice-main",
        timing: "activateMain",
        oncePerTurn: true,
        effect: { kind: "moveCardBetweenZones", source: "life", destination: "hand", count: 1, choiceKey: "lifeIndices" }
      }]
    }
  };
  const featuresForLife = (life) => {
    let game = createSimulationGame({
      catalog,
      decks: { P1: sampleDeckList, P2: sampleDeckList },
      skipShuffle: true,
      validateDecks: false
    }).state;
    game.phase = PHASES.MAIN;
    game.activePlayer = "P1";
    game.players.P1.frontLine = [permanent("P1", "private_life_choice", "life-choice")];
    game.players.P1.life = life;
    const action = autoplayActionCandidates(game, "P1")
      .find((candidate) => candidate.type === "activateMainAbility");
    return pilotActionFeatures(game, "P1", action);
  };
  const first = featuresForLife([
    { uid: "hidden-life-rookie", owner: "P1", defId: "demo_rookie", faceUp: false },
    { uid: "hidden-life-raider", owner: "P1", defId: "demo_raider", faceUp: false }
  ]);
  const second = featuresForLife([
    { uid: "hidden-life-raider-2", owner: "P1", defId: "demo_raider", faceUp: false },
    { uid: "hidden-life-rookie-2", owner: "P1", defId: "demo_rookie", faceUp: false }
  ]);
  assert.deepEqual(first, second);
  assert.equal(Object.keys(first).some((key) => key.includes("hidden-life") || key.includes("demo_rookie") || key.includes("demo_raider")), false);
});

test("optional rest effects expose clean accept and decline decisions", () => {
  const catalog = {
    ...sampleCatalog,
    private_optional_rest: {
      id: "private_optional_rest",
      number: "DEM-1-103",
      sourceCode: "DEM",
      name: "Optional Rest Pilot",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      abilities: [{
        id: "optional-rest-main",
        timing: "activateMain",
        oncePerTurn: true,
        effect: {
          kind: "restTargetsThen",
          optional: true,
          choiceKey: "useOptionalRest",
          target: {
            controller: "opponent",
            line: LINES.FRONT,
            min: 1,
            max: 1,
            choiceKey: "restTarget"
          },
          effect: { kind: "draw", amount: 1 }
        }
      }]
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
  game.players.P1.frontLine = [permanent("P1", "private_optional_rest", "optional-rest")];
  game.players.P2.frontLine = [
    permanent("P2", "demo_rookie", "rest-rookie"),
    permanent("P2", "demo_guardian", "rest-guardian")
  ];

  const candidates = autoplayActionCandidates(game, "P1")
    .filter((action) => action.type === "activateMainAbility");
  const decline = candidates.filter((action) => action.choices.useOptionalRest === false);
  const accept = candidates.filter((action) => action.choices.useOptionalRest === true);
  assert.equal(decline.length, 1);
  assert.equal(accept.length, 2);
  assert.equal("restTarget" in decline[0].choices, false);
  const declineFeatures = pilotActionFeatures(game, "P1", decline[0]);
  assert.equal(Object.keys(declineFeatures).some((key) => key.includes("resttarget.card.")), false);
  assert.ok(accept.some((action) => action.choices.restTarget[0].index === 0));
  assert.ok(accept.some((action) => action.choices.restTarget[0].index === 1));

  const declinedState = applyAction(game, decline[0]);
  assert.equal(declinedState.players.P2.frontLine.some((unit) => unit.rested), false);
  const acceptedState = applyAction(game, accept.find((action) => action.choices.restTarget[0].index === 1));
  assert.equal(acceptedState.players.P2.frontLine[1].rested, true);
});

test("line swaps expose every legal front and energy pair", () => {
  const catalog = {
    ...sampleCatalog,
    private_swap_pilot: {
      id: "private_swap_pilot",
      number: "DEM-1-104",
      sourceCode: "DEM",
      name: "Swap Pilot",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      abilities: [{
        id: "swap-main",
        timing: "activateMain",
        oncePerTurn: true,
        effect: {
          kind: "swapOwnFrontAndEnergy",
          frontChoiceKey: "swapFront",
          energyChoiceKey: "swapEnergy"
        }
      }]
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
  game.players.P1.frontLine = [
    permanent("P1", "private_swap_pilot", "swap-pilot"),
    permanent("P1", "demo_finisher", "swap-front-finisher")
  ];
  game.players.P1.energyLine = [
    permanent("P1", "demo_rookie", "swap-energy-rookie"),
    permanent("P1", "demo_guardian", "swap-energy-guardian")
  ];

  const candidates = autoplayActionCandidates(game, "P1")
    .filter((action) => action.type === "activateMainAbility");
  const pairs = new Set(candidates.map((action) => `${action.choices.swapFront.index}:${action.choices.swapEnergy.index}`));
  assert.deepEqual([...pairs].sort(), ["0:0", "0:1", "1:0", "1:1"]);
  const features = candidates.map((action) => pilotActionFeatures(game, "P1", action));
  assert.ok(features.some((row) => row["context.choice.private_swap_pilot.swap-main.swapfront.card.demo_finisher"] === 1));
  assert.ok(features.some((row) => row["context.choice.private_swap_pilot.swap-main.swapenergy.card.demo_rookie"] === 1));

  const selected = candidates.find((action) => action.choices.swapFront.index === 1 && action.choices.swapEnergy.index === 0);
  const resolved = applyAction(game, selected);
  assert.equal(resolved.players.P1.frontLine[1].pid, "swap-energy-rookie");
  assert.equal(resolved.players.P1.energyLine[0].pid, "swap-front-finisher");
});

test("two-target swaps expose every legal cross-line pair", () => {
  const catalog = {
    ...sampleCatalog,
    private_two_target_swap_pilot: {
      id: "private_two_target_swap_pilot",
      number: "DEM-1-119",
      sourceCode: "DEM",
      name: "Two Target Swap Pilot",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      abilities: [{
        id: "two-target-swap-main",
        timing: "activateMain",
        oncePerTurn: true,
        effect: {
          kind: "swapChosenTargets",
          firstTarget: {
            controller: "opponent",
            line: LINES.FRONT,
            type: CARD_TYPES.CHARACTER,
            max: 1,
            choiceKey: "frontSwapTarget"
          },
          secondTarget: {
            controller: "opponent",
            line: LINES.ENERGY,
            type: CARD_TYPES.CHARACTER,
            max: 1,
            choiceKey: "energySwapTarget"
          }
        }
      }]
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
  game.players.P1.frontLine = [permanent("P1", "private_two_target_swap_pilot", "two-target-swap-pilot")];
  game.players.P2.frontLine = [
    permanent("P2", "demo_rookie", "two-swap-front-rookie"),
    permanent("P2", "demo_finisher", "two-swap-front-finisher")
  ];
  game.players.P2.energyLine = [
    permanent("P2", "demo_guardian", "two-swap-energy-guardian"),
    permanent("P2", "demo_raider", "two-swap-energy-raider")
  ];

  const candidates = autoplayActionCandidates(game, "P1")
    .filter((action) => action.type === "activateMainAbility");
  const pairs = new Set(candidates.map((action) => `${action.choices.frontSwapTarget[0].index}:${action.choices.energySwapTarget[0].index}`));
  assert.deepEqual([...pairs].sort(), ["0:0", "0:1", "1:0", "1:1"]);
  const selected = candidates.find((action) => action.choices.frontSwapTarget[0].index === 1
    && action.choices.energySwapTarget[0].index === 0);
  const selectedFeatures = pilotActionFeatures(game, "P1", selected);
  assert.equal(selectedFeatures["context.choice.private_two_target_swap_pilot.two-target-swap-main.frontswaptarget.card.demo_finisher"], 1);
  assert.equal(selectedFeatures["context.choice.private_two_target_swap_pilot.two-target-swap-main.energyswaptarget.card.demo_guardian"], 1);
  const resolved = applyAction(game, selected);
  assert.equal(resolved.players.P2.frontLine[1].pid, "two-swap-energy-guardian");
  assert.equal(resolved.players.P2.energyLine[0].pid, "two-swap-front-finisher");
});

test("energy-rest costs expose bounded card-specific subsets", () => {
  const catalog = {
    ...sampleCatalog,
    private_energy_rest_pilot: {
      id: "private_energy_rest_pilot",
      number: "DEM-1-105",
      sourceCode: "DEM",
      name: "Energy Rest Pilot",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      abilities: [{
        id: "energy-rest-main",
        timing: "activateMain",
        oncePerTurn: true,
        effect: { kind: "restEnergyLineForRequiredEnergyTotal", choiceKey: "energySources" }
      }]
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
  game.players.P1.frontLine = [permanent("P1", "private_energy_rest_pilot", "energy-rest-pilot")];
  game.players.P1.energyLine = [
    permanent("P1", "demo_guardian", "energy-rest-guardian"),
    permanent("P1", "demo_finisher", "energy-rest-finisher")
  ];

  const candidates = autoplayActionCandidates(game, "P1")
    .filter((action) => action.type === "activateMainAbility");
  const subsets = new Set(candidates.map((action) => action.choices.energySources.map((choice) => choice.index).join(",")));
  assert.deepEqual([...subsets].sort(), ["", "0", "0,1", "1"]);
  const single = candidates.find((action) => action.choices.energySources.length === 1
    && action.choices.energySources[0].index === 1);
  const singleFeatures = pilotActionFeatures(game, "P1", single);
  assert.equal(singleFeatures["context.choice.private_energy_rest_pilot.energy-rest-main.energysources.card.demo_finisher"], 1);
  assert.equal(Object.keys(singleFeatures).some((key) => key.includes("energy-rest-finisher")), false);
  const resolved = applyAction(game, single);
  assert.equal(resolved.players.P1.energyLine[0].rested, false);
  assert.equal(resolved.players.P1.energyLine[1].rested, true);
});

test("under-card moves expose known choices without leaking face-down identities", () => {
  const catalog = {
    ...sampleCatalog,
    private_under_pilot: {
      id: "private_under_pilot",
      number: "DEM-1-118",
      sourceCode: "DEM",
      name: "Under Pilot",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      abilities: [{
        id: "under-main",
        timing: "activateMain",
        oncePerTurn: true,
        effect: {
          kind: "moveUnderCardsToZone",
          count: 1,
          destination: "hand",
          choiceKey: "movedUnderCard",
          target: "self"
        }
      }]
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
  const source = permanent("P1", "private_under_pilot", "under-pilot");
  source.cards.unshift(
    { uid: "under-rookie", owner: "P1", defId: "demo_rookie", faceUp: true },
    { uid: "under-raider", owner: "P1", defId: "demo_raider", faceUp: true }
  );
  game.players.P1.frontLine = [source];

  const candidates = autoplayActionCandidates(game, "P1")
    .filter((action) => action.type === "activateMainAbility");
  assert.equal(candidates.length, 2);
  const features = candidates.map((action) => pilotActionFeatures(game, "P1", action));
  assert.ok(features.some((row) => row["context.choice.private_under_pilot.under-main.movedundercard.card.demo_rookie"] === 1));
  assert.ok(features.some((row) => row["context.choice.private_under_pilot.under-main.movedundercard.card.demo_raider"] === 1));

  const hiddenGame = structuredClone(game);
  hiddenGame.players.P1.frontLine[0].cards[0].faceUp = false;
  hiddenGame.players.P1.frontLine[0].cards[1].faceUp = false;
  const hiddenCandidates = autoplayActionCandidates(hiddenGame, "P1")
    .filter((action) => action.type === "activateMainAbility");
  assert.equal(hiddenCandidates.length, 2);
  const hiddenFeatures = hiddenCandidates.map((action) => pilotActionFeatures(hiddenGame, "P1", action));
  assert.deepEqual(hiddenFeatures[0], hiddenFeatures[1]);
  assert.equal(hiddenFeatures.some((row) => Object.keys(row).some((key) => key.includes("demo_rookie") || key.includes("demo_raider"))), false);

  const moveRaider = hiddenCandidates.find((action) => action.choices.movedUnderCard[0].uid === "under-raider");
  const resolved = applyAction(hiddenGame, moveRaider);
  assert.equal(resolved.players.P1.hand.some((card) => card.uid === "under-raider" && card.faceUp), true);
  assert.equal(resolved.players.P1.frontLine[0].cards.some((card) => card.uid === "under-rookie"), true);
});

test("deck-placement decisions combine every legal target and position", () => {
  const catalog = {
    ...sampleCatalog,
    private_deck_placement_pilot: {
      id: "private_deck_placement_pilot",
      number: "DEM-1-106",
      sourceCode: "DEM",
      name: "Deck Placement Pilot",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      abilities: [{
        id: "deck-placement-main",
        timing: "activateMain",
        oncePerTurn: true,
        effect: {
          kind: "moveTargetsToDeck",
          positions: ["top", "bottom"],
          positionChoiceKey: "deckPosition",
          target: {
            controller: "opponent",
            line: LINES.FRONT,
            min: 1,
            max: 1,
            choiceKey: "deckTarget"
          }
        }
      }]
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
  game.players.P1.frontLine = [permanent("P1", "private_deck_placement_pilot", "deck-placement-pilot")];
  game.players.P2.frontLine = [
    permanent("P2", "demo_rookie", "deck-target-rookie"),
    permanent("P2", "demo_guardian", "deck-target-guardian")
  ];

  const candidates = autoplayActionCandidates(game, "P1")
    .filter((action) => action.type === "activateMainAbility");
  const plans = new Set(candidates.map((action) => `${action.choices.deckTarget[0].index}:${action.choices.deckPosition}`));
  assert.deepEqual([...plans].sort(), ["0:bottom", "0:top", "1:bottom", "1:top"]);
  const bottomGuardian = candidates.find((action) => action.choices.deckTarget[0].index === 1
    && action.choices.deckPosition === "bottom");
  const resolved = applyAction(game, bottomGuardian);
  assert.equal(resolved.players.P2.frontLine.length, 1);
  assert.equal(resolved.players.P2.deck.at(-1).uid, "deck-target-guardian-card");
});

test("autoplay rejects an illegal preferred target before policy scoring", () => {
  const catalog = {
    ...sampleCatalog,
    private_target_guard: {
      id: "private_target_guard",
      number: "DEM-1-111",
      sourceCode: "DEM",
      name: "Target Guard",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 5000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      targetingRestrictions: [{ mode: "prohibit", sourceTypes: [CARD_TYPES.CHARACTER] }],
      abilities: []
    },
    private_protection_pilot: {
      id: "private_protection_pilot",
      number: "DEM-1-112",
      sourceCode: "DEM",
      name: "Protection Pilot",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      abilities: [{
        id: "protection-main",
        timing: "activateMain",
        oncePerTurn: true,
        effect: {
          kind: "restTargets",
          target: {
            controller: "opponent",
            line: LINES.FRONT,
            type: CARD_TYPES.CHARACTER,
            min: 1,
            max: 1,
            choiceKey: "restTarget"
          }
        }
      }]
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
  game.players.P1.frontLine = [permanent("P1", "private_protection_pilot", "protection-pilot")];
  game.players.P2.frontLine = [
    permanent("P2", "private_target_guard", "protected-target"),
    permanent("P2", "demo_rookie", "legal-target")
  ];

  const candidates = autoplayActionCandidates(game, "P1")
    .filter((action) => action.type === "activateMainAbility");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].choices.restTarget[0].index, 1);
  const resolved = applyAction(game, candidates[0]);
  assert.equal(resolved.players.P2.frontLine[0].rested, false);
  assert.equal(resolved.players.P2.frontLine[1].rested, true);
});

test("targeting taxes expose every legal payment card to the policy", () => {
  const catalog = {
    ...sampleCatalog,
    private_taxed_target: {
      id: "private_taxed_target",
      number: "DEM-1-113",
      sourceCode: "DEM",
      name: "Taxed Target",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 3000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      targetingRestrictions: [{
        mode: "tax",
        sourceTypes: [CARD_TYPES.CHARACTER],
        payment: { kind: "handToSideline", amount: 1 }
      }],
      abilities: []
    },
    private_tax_pilot: {
      id: "private_tax_pilot",
      number: "DEM-1-114",
      sourceCode: "DEM",
      name: "Tax Pilot",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      abilities: [{
        id: "tax-main",
        timing: "activateMain",
        oncePerTurn: true,
        effect: {
          kind: "restTargets",
          target: {
            controller: "opponent",
            line: LINES.FRONT,
            type: CARD_TYPES.CHARACTER,
            min: 1,
            max: 1,
            choiceKey: "taxTarget"
          }
        }
      }]
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
  game.players.P1.frontLine = [permanent("P1", "private_tax_pilot", "tax-pilot")];
  game.players.P1.hand = [
    { uid: "tax-rookie", owner: "P1", defId: "demo_rookie", faceUp: true },
    { uid: "tax-raider", owner: "P1", defId: "demo_raider", faceUp: true }
  ];
  game.players.P2.frontLine = [permanent("P2", "private_taxed_target", "taxed-target")];

  const candidates = autoplayActionCandidates(game, "P1")
    .filter((action) => action.type === "activateMainAbility");
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every((action) => action.choices.targetTaxHandIndices.length === 1));
  const features = candidates.map((action) => pilotActionFeatures(game, "P1", action));
  assert.ok(features.some((row) => row["context.choice.private_tax_pilot.tax-main.targettaxhandindices.card.demo_rookie"] === 1));
  assert.ok(features.some((row) => row["context.choice.private_tax_pilot.tax-main.targettaxhandindices.card.demo_raider"] === 1));

  const payRaider = candidates.find((action) => action.choices.targetTaxHandIndices[0].uid === "tax-raider");
  const resolved = applyAction(game, payRaider);
  assert.equal(resolved.players.P1.sideline.some((card) => card.uid === "tax-raider"), true);
  assert.equal(resolved.players.P1.hand.some((card) => card.uid === "tax-rookie"), true);
  assert.equal(resolved.players.P2.frontLine[0].rested, true);
});

test("hand-to-deck effects expose every legal card and position", () => {
  const catalog = {
    ...sampleCatalog,
    private_hand_placement_pilot: {
      id: "private_hand_placement_pilot",
      number: "DEM-1-107",
      sourceCode: "DEM",
      name: "Hand Placement Pilot",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      abilities: [{
        id: "hand-placement-main",
        timing: "activateMain",
        oncePerTurn: true,
        effect: {
          kind: "moveHandToZone",
          amount: 1,
          destination: "deck",
          positions: ["top", "bottom"],
          positionChoiceKey: "handDeckPosition",
          choiceKey: "handCard"
        }
      }]
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
  game.players.P1.frontLine = [permanent("P1", "private_hand_placement_pilot", "hand-placement-pilot")];
  game.players.P1.hand = [
    { uid: "hand-placement-rookie", owner: "P1", defId: "demo_rookie", faceUp: true },
    { uid: "hand-placement-raider", owner: "P1", defId: "demo_raider", faceUp: true }
  ];

  const candidates = autoplayActionCandidates(game, "P1")
    .filter((action) => action.type === "activateMainAbility");
  const plans = new Set(candidates.map((action) => `${action.choices.handCard[0]}:${action.choices.handDeckPosition}`));
  assert.deepEqual([...plans].sort(), ["0:bottom", "0:top", "1:bottom", "1:top"]);
  const features = candidates.map((action) => pilotActionFeatures(game, "P1", action));
  assert.ok(features.some((row) => row["context.choice.private_hand_placement_pilot.hand-placement-main.handcard.card.demo_rookie"] === 1));
  assert.ok(features.some((row) => row["context.choice.private_hand_placement_pilot.hand-placement-main.handdeckposition.bottom"] === 1));

  const topRaider = candidates.find((action) => action.choices.handCard[0] === 1
    && action.choices.handDeckPosition === "top");
  const bottomRookie = candidates.find((action) => action.choices.handCard[0] === 0
    && action.choices.handDeckPosition === "bottom");
  assert.equal(applyAction(game, topRaider).players.P1.deck[0].uid, "hand-placement-raider");
  assert.equal(applyAction(game, bottomRookie).players.P1.deck.at(-1).uid, "hand-placement-rookie");
});

test("targeted line swaps expose every legal subject and counterpart", () => {
  const catalog = {
    ...sampleCatalog,
    private_target_swap_pilot: {
      id: "private_target_swap_pilot",
      number: "DEM-1-108",
      sourceCode: "DEM",
      name: "Target Swap Pilot",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      abilities: [{
        id: "target-swap-main",
        timing: "activateMain",
        oncePerTurn: true,
        effect: {
          kind: "swapTargetsWithOtherLine",
          swapChoiceKey: "swapCounterpart",
          target: {
            controller: "self",
            line: LINES.FRONT,
            otherThanSource: true,
            min: 1,
            max: 1,
            choiceKey: "swapSubject"
          }
        }
      }]
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
  game.players.P1.frontLine = [
    permanent("P1", "private_target_swap_pilot", "target-swap-pilot"),
    permanent("P1", "demo_rookie", "target-swap-rookie"),
    permanent("P1", "demo_finisher", "target-swap-finisher")
  ];
  game.players.P1.energyLine = [
    permanent("P1", "demo_guardian", "target-swap-guardian"),
    permanent("P1", "demo_raider", "target-swap-raider")
  ];

  const candidates = autoplayActionCandidates(game, "P1")
    .filter((action) => action.type === "activateMainAbility");
  const plans = new Set(candidates.map((action) => `${action.choices.swapSubject[0].index}:${action.choices.swapCounterpart.index}`));
  assert.deepEqual([...plans].sort(), ["1:0", "1:1", "2:0", "2:1"]);
  const selected = candidates.find((action) => action.choices.swapSubject[0].index === 2
    && action.choices.swapCounterpart.index === 1);
  const selectedFeatures = pilotActionFeatures(game, "P1", selected);
  assert.equal(selectedFeatures["context.choice.private_target_swap_pilot.target-swap-main.swapsubject.card.demo_finisher"], 1);
  assert.equal(selectedFeatures["context.choice.private_target_swap_pilot.target-swap-main.swapcounterpart.card.demo_raider"], 1);
  const resolved = applyAction(game, selected);
  assert.equal(resolved.players.P1.frontLine[2].pid, "target-swap-raider");
  assert.equal(resolved.players.P1.energyLine[1].pid, "target-swap-finisher");
});

test("name-matched zone plays expose the chosen target and matching card", () => {
  const catalog = {
    ...sampleCatalog,
    private_name_play_pilot: {
      id: "private_name_play_pilot",
      number: "DEM-1-109",
      sourceCode: "DEM",
      name: "Name Play Pilot",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      abilities: [{
        id: "name-play-main",
        timing: "activateMain",
        oncePerTurn: true,
        effect: {
          kind: "playCardFromZoneMatchingTargetName",
          zone: "sideline",
          choiceKey: "matchingCard",
          rested: true,
          destinationLine: LINES.FRONT,
          target: {
            controller: "self",
            line: LINES.FRONT,
            otherThanSource: true,
            min: 1,
            max: 1,
            choiceKey: "nameTarget"
          }
        }
      }]
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
  game.players.P1.frontLine = [
    permanent("P1", "private_name_play_pilot", "name-play-pilot"),
    permanent("P1", "demo_rookie", "name-target-rookie"),
    permanent("P1", "demo_guardian", "name-target-guardian")
  ];
  game.players.P1.sideline = [
    { uid: "matching-rookie", owner: "P1", defId: "demo_rookie", faceUp: true },
    { uid: "matching-guardian", owner: "P1", defId: "demo_guardian", faceUp: true }
  ];

  const candidates = autoplayActionCandidates(game, "P1")
    .filter((action) => action.type === "activateMainAbility");
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every((action) => action.choices.nameTarget[0].index === action.choices.matchingCard.index + 1));
  const guardianPlan = candidates.find((action) => action.choices.matchingCard.uid === "matching-guardian");
  const guardianFeatures = pilotActionFeatures(game, "P1", guardianPlan);
  assert.equal(guardianFeatures["context.choice.private_name_play_pilot.name-play-main.nametarget.card.demo_guardian"], 1);
  assert.equal(guardianFeatures["context.choice.private_name_play_pilot.name-play-main.matchingcard.card.demo_guardian"], 1);
  const resolved = applyAction(game, guardianPlan);
  assert.equal(resolved.players.P1.sideline.some((card) => card.uid === "matching-guardian"), false);
  assert.equal(resolved.players.P1.frontLine.at(-1).cards.at(-1).uid, "matching-guardian");
});

test("named sideline effects expose every legal played-card subset", () => {
  const namedCharacter = (id, name, bp) => ({
    id,
    number: id,
    sourceCode: "DEM",
    name,
    type: CARD_TYPES.CHARACTER,
    color: "green",
    requiredEnergy: { color: "green", amount: 0 },
    apCost: 0,
    bp,
    energy: [{ color: "green", amount: 1 }],
    affinities: [],
    abilities: []
  });
  const catalog = {
    ...sampleCatalog,
    private_named_a: namedCharacter("private_named_a", "Aizetsu", 1000),
    private_named_b: namedCharacter("private_named_b", "Urogi", 2000),
    private_named_c: namedCharacter("private_named_c", "Karaku", 3000),
    private_named_pilot: {
      ...namedCharacter("private_named_pilot", "Named Pilot", 1000),
      abilities: [{
        id: "named-main",
        timing: "activateMain",
        oncePerTurn: true,
        effect: {
          kind: "playSomeNamedFromSidelineAddRest",
          names: ["aizetsu", "urogi", "karaku"],
          playCount: 2,
          choiceKey: "playedNamedCards",
          rested: true,
          destinationLine: LINES.FRONT
        }
      }]
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
  game.players.P1.frontLine = [permanent("P1", "private_named_pilot", "named-pilot")];
  game.players.P1.sideline = [
    { uid: "named-a", owner: "P1", defId: "private_named_a", faceUp: true },
    { uid: "named-b", owner: "P1", defId: "private_named_b", faceUp: true },
    { uid: "named-c", owner: "P1", defId: "private_named_c", faceUp: true }
  ];

  const candidates = autoplayActionCandidates(game, "P1")
    .filter((action) => action.type === "activateMainAbility");
  assert.equal(candidates.length, 3);
  const subsets = new Set(candidates.map((action) => action.choices.playedNamedCards
    .map((choice) => choice.uid)
    .sort()
    .join(",")));
  assert.deepEqual([...subsets].sort(), ["named-a,named-b", "named-a,named-c", "named-b,named-c"]);
  const outerPair = candidates.find((action) => action.choices.playedNamedCards.some((choice) => choice.uid === "named-a")
    && action.choices.playedNamedCards.some((choice) => choice.uid === "named-c"));
  const pairFeatures = pilotActionFeatures(game, "P1", outerPair);
  assert.equal(pairFeatures["context.choice.private_named_pilot.named-main.playednamedcards.card.private_named_a"], 1);
  assert.equal(pairFeatures["context.choice.private_named_pilot.named-main.playednamedcards.card.private_named_c"], 1);
  const resolved = applyAction(game, outerPair);
  assert.equal(resolved.players.P1.frontLine.some((unit) => unit.cards.at(-1).uid === "named-a"), true);
  assert.equal(resolved.players.P1.frontLine.some((unit) => unit.cards.at(-1).uid === "named-c"), true);
  assert.equal(resolved.players.P1.hand.some((card) => card.uid === "named-b"), true);
});

test("zone-under effects expose every legal sideline-card and target pair", () => {
  const catalog = {
    ...sampleCatalog,
    private_zone_under_pilot: {
      ...sampleCatalog.demo_rookie,
      id: "private_zone_under_pilot",
      number: "DEM-1-114",
      name: "Zone Under Pilot",
      abilities: [{
        id: "zone-under-main",
        timing: "activateMain",
        oncePerTurn: true,
        effect: {
          kind: "moveZoneCardsUnderTargets",
          source: "sideline",
          count: 1,
          min: 1,
          faceUp: false,
          choiceKey: "tuckedCard",
          target: {
            controller: "self",
            line: LINES.FRONT,
            otherThanSource: true,
            min: 1,
            max: 1,
            choiceKey: "tuckTarget"
          }
        }
      }]
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
  game.players.P1.frontLine = [
    permanent("P1", "private_zone_under_pilot", "zone-under-pilot"),
    permanent("P1", "demo_rookie", "zone-under-rookie"),
    permanent("P1", "demo_guardian", "zone-under-guardian")
  ];
  game.players.P1.sideline = [
    { uid: "under-raider", owner: "P1", defId: "demo_raider", faceUp: true },
    { uid: "under-finisher", owner: "P1", defId: "demo_finisher", faceUp: true }
  ];

  const candidates = autoplayActionCandidates(game, "P1")
    .filter((action) => action.type === "activateMainAbility");
  const plans = new Set(candidates.map((action) => `${action.choices.tuckedCard[0].uid}:${action.choices.tuckTarget[0].index}`));
  assert.deepEqual([...plans].sort(), [
    "under-finisher:1",
    "under-finisher:2",
    "under-raider:1",
    "under-raider:2"
  ]);
  const selected = candidates.find((action) => action.choices.tuckedCard[0].uid === "under-finisher"
    && action.choices.tuckTarget[0].index === 2);
  const features = pilotActionFeatures(game, "P1", selected);
  assert.equal(features["context.choice.private_zone_under_pilot.zone-under-main.tuckedcard.card.demo_finisher"], 1);
  assert.equal(features["context.choice.private_zone_under_pilot.zone-under-main.tucktarget.card.demo_guardian"], 1);

  const resolved = applyAction(game, selected);
  assert.equal(resolved.players.P1.frontLine[2].cards[0].uid, "under-finisher");
  assert.equal(resolved.players.P1.frontLine[2].cards[0].faceUp, false);
  assert.deepEqual(resolved.players.P1.sideline.map((card) => card.uid), ["under-raider"]);
});

test("hand-under effects expose every legal hand-card and target pair", () => {
  const catalog = {
    ...sampleCatalog,
    private_hand_under_pilot: {
      ...sampleCatalog.demo_rookie,
      id: "private_hand_under_pilot",
      number: "DEM-1-115",
      name: "Hand Under Pilot",
      abilities: [{
        id: "hand-under-main",
        timing: "activateMain",
        oncePerTurn: true,
        effect: {
          kind: "moveHandCardsUnderTargets",
          count: 1,
          min: 1,
          faceUp: false,
          choiceKey: "tuckedHandCard",
          target: {
            controller: "self",
            line: LINES.FRONT,
            otherThanSource: true,
            min: 1,
            max: 1,
            choiceKey: "handTuckTarget"
          }
        }
      }]
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
  game.players.P1.frontLine = [
    permanent("P1", "private_hand_under_pilot", "hand-under-pilot"),
    permanent("P1", "demo_rookie", "hand-under-rookie"),
    permanent("P1", "demo_guardian", "hand-under-guardian")
  ];
  game.players.P1.hand = [
    { uid: "hand-under-raider", owner: "P1", defId: "demo_raider", faceUp: true },
    { uid: "hand-under-finisher", owner: "P1", defId: "demo_finisher", faceUp: true }
  ];

  const candidates = autoplayActionCandidates(game, "P1")
    .filter((action) => action.type === "activateMainAbility");
  const plans = new Set(candidates.map((action) => `${action.choices.tuckedHandCard[0].uid}:${action.choices.handTuckTarget[0].index}`));
  assert.deepEqual([...plans].sort(), [
    "hand-under-finisher:1",
    "hand-under-finisher:2",
    "hand-under-raider:1",
    "hand-under-raider:2"
  ]);
  const selected = candidates.find((action) => action.choices.tuckedHandCard[0].uid === "hand-under-raider"
    && action.choices.handTuckTarget[0].index === 1);
  const features = pilotActionFeatures(game, "P1", selected);
  assert.equal(features["context.choice.private_hand_under_pilot.hand-under-main.tuckedhandcard.card.demo_raider"], 1);
  assert.equal(features["context.choice.private_hand_under_pilot.hand-under-main.handtucktarget.card.demo_rookie"], 1);

  const resolved = applyAction(game, selected);
  assert.equal(resolved.players.P1.frontLine[1].cards[0].uid, "hand-under-raider");
  assert.equal(resolved.players.P1.frontLine[1].cards[0].faceUp, false);
  assert.deepEqual(resolved.players.P1.hand.map((card) => card.uid), ["hand-under-finisher"]);
});

test("move-or-swap effects expose every legal counterpart instead of forcing the first", () => {
  const catalog = {
    ...sampleCatalog,
    private_move_or_swap_pilot: {
      ...sampleCatalog.demo_rookie,
      id: "private_move_or_swap_pilot",
      number: "DEM-1-116",
      name: "Move Or Swap Pilot",
      abilities: [{
        id: "move-or-swap-main",
        timing: "activateMain",
        oncePerTurn: true,
        effect: {
          kind: "moveOrSwapTargetsToOtherLine",
          swapChoiceKey: "moveOrSwapPlan",
          target: {
            controller: "self",
            line: LINES.FRONT,
            otherThanSource: true,
            min: 1,
            max: 1,
            choiceKey: "moveOrSwapTarget"
          }
        }
      }]
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
  game.players.P1.frontLine = [
    permanent("P1", "private_move_or_swap_pilot", "move-or-swap-pilot"),
    permanent("P1", "demo_finisher", "move-or-swap-target")
  ];
  game.players.P1.energyLine = [
    permanent("P1", "demo_rookie", "move-counterpart-rookie"),
    permanent("P1", "demo_guardian", "move-counterpart-guardian"),
    permanent("P1", "demo_site", "move-counterpart-site-a"),
    permanent("P1", "demo_site", "move-counterpart-site-b")
  ];

  const candidates = autoplayActionCandidates(game, "P1")
    .filter((action) => action.type === "activateMainAbility");
  const counterpartIds = new Set(candidates.map((action) => action.choices.moveOrSwapPlan["move-or-swap-target"].permanentId));
  assert.deepEqual([...counterpartIds].sort(), ["move-counterpart-guardian", "move-counterpart-rookie"]);
  const selected = candidates.find((action) => action.choices.moveOrSwapPlan["move-or-swap-target"].permanentId === "move-counterpart-guardian");
  const features = pilotActionFeatures(game, "P1", selected);
  assert.equal(features["context.choice.private_move_or_swap_pilot.move-or-swap-main.moveorswapplan.move-or-swap-target.card.demo_guardian"], 1);

  const resolved = applyAction(game, selected);
  assert.equal(resolved.players.P1.frontLine[1].pid, "move-counterpart-guardian");
  assert.equal(resolved.players.P1.energyLine[1].pid, "move-or-swap-target");

  const openGame = structuredClone(game);
  openGame.players.P1.energyLine = openGame.players.P1.energyLine.slice(0, 2);
  const openCandidates = autoplayActionCandidates(openGame, "P1")
    .filter((action) => action.type === "activateMainAbility");
  const operationChoices = openCandidates.map((action) => action.choices.moveOrSwapPlan["move-or-swap-target"]);
  assert.equal(operationChoices.includes("move"), true);
  assert.deepEqual(operationChoices
    .filter((choice) => choice && typeof choice === "object")
    .map((choice) => choice.permanentId)
    .sort(), ["move-counterpart-guardian", "move-counterpart-rookie"]);
  const moved = applyAction(openGame, openCandidates.find((action) => action.choices.moveOrSwapPlan["move-or-swap-target"] === "move"));
  assert.equal(moved.players.P1.frontLine.some((unit) => unit.pid === "move-or-swap-target"), false);
  assert.equal(moved.players.P1.energyLine.some((unit) => unit.pid === "move-or-swap-target"), true);
});

test("full-line ability plays expose every legal replacement permanent", () => {
  const catalog = {
    ...sampleCatalog,
    private_replacement_pilot: {
      ...sampleCatalog.demo_rookie,
      id: "private_replacement_pilot",
      number: "DEM-1-117",
      name: "Replacement Pilot",
      abilities: [{
        id: "replace-main",
        timing: "activateMain",
        oncePerTurn: true,
        effect: {
          kind: "playCardFromZone",
          zone: "sideline",
          count: 1,
          destinationLine: LINES.FRONT,
          choiceKey: "playedReplacement"
        }
      }]
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
  game.players.P1.energyLine = [permanent("P1", "private_replacement_pilot", "replacement-pilot")];
  game.players.P1.frontLine = [
    permanent("P1", "demo_rookie", "replace-rookie"),
    permanent("P1", "demo_guardian", "replace-guardian"),
    permanent("P1", "demo_raider", "replace-raider"),
    permanent("P1", "demo_finisher", "replace-finisher")
  ];
  game.players.P1.sideline = [
    { uid: "replacement-card", owner: "P1", defId: "demo_stepper", faceUp: true }
  ];

  const candidates = autoplayActionCandidates(game, "P1")
    .filter((action) => action.type === "activateMainAbility");
  assert.deepEqual(candidates.map((action) => action.choices.replaceIndex.permanentId).sort(), [
    "replace-finisher",
    "replace-guardian",
    "replace-raider",
    "replace-rookie"
  ]);
  const selected = candidates.find((action) => action.choices.replaceIndex.permanentId === "replace-guardian");
  const features = pilotActionFeatures(game, "P1", selected);
  assert.equal(features["context.choice.private_replacement_pilot.replace-main.replaceindex.card.demo_guardian"], 1);

  const resolved = applyAction(game, selected);
  assert.equal(resolved.players.P1.frontLine.some((unit) => unit.pid === "replace-guardian"), false);
  assert.equal(resolved.players.P1.frontLine.at(-1).cards.at(-1).uid, "replacement-card");
  assert.equal(resolved.players.P1.removal.some((card) => card.defId === "demo_guardian"), true);
});

test("effects that play onto the field expose both legal destination lines", () => {
  const catalog = {
    ...sampleCatalog,
    private_field_play_source: {
      id: "private_field_play_source",
      number: "DEM-1-121A",
      sourceCode: "DEM",
      name: "Field Play Source",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      abilities: [{
        id: "field-play-main",
        timing: "activateMain",
        oncePerTurn: true,
        effect: {
          kind: "playCardFromZone",
          zones: ["hand"],
          count: 1,
          rested: false,
          destinationLines: [LINES.FRONT, LINES.ENERGY],
          destinationLineChoiceKey: "destinationLine",
          choiceKey: "fieldPlayIndex",
          filter: { id: "demo_rookie" }
        }
      }]
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
  game.players.P1.frontLine = [permanent("P1", "private_field_play_source", "field-play-source")];
  game.players.P1.energyLine = [];
  game.players.P1.hand = [{ uid: "field-play-card", owner: "P1", defId: "demo_rookie", faceUp: true }];

  const candidates = autoplayActionCandidates(game, "P1")
    .filter((action) => action.type === "activateMainAbility" && action.abilityId === "field-play-main");
  assert.deepEqual(new Set(candidates.map((action) => action.choices.destinationLine)), new Set([LINES.FRONT, LINES.ENERGY]));

  const energyPlan = candidates.find((action) => action.choices.destinationLine === LINES.ENERGY);
  const result = applyAction(game, energyPlan);
  assert.equal(result.players.P1.frontLine.length, 1);
  assert.equal(result.players.P1.energyLine[0].cards.at(-1).uid, "field-play-card");
});

test("hand-reveal BP effects expose every legal unique-name subset", () => {
  const catalog = {
    ...sampleCatalog,
    private_hand_reveal_pilot: {
      id: "private_hand_reveal_pilot",
      number: "DEM-1-110",
      sourceCode: "DEM",
      name: "Hand Reveal Pilot",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      abilities: [{
        id: "hand-reveal-main",
        timing: "activateMain",
        oncePerTurn: true,
        effect: {
          kind: "modifyBpForHandReveal",
          uniqueNames: true,
          includeField: false,
          min: 0,
          max: 2,
          amountPerCard: 1000,
          choiceKey: "revealedCards",
          target: "self"
        }
      }]
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
  game.players.P1.frontLine = [permanent("P1", "private_hand_reveal_pilot", "hand-reveal-pilot")];
  game.players.P1.hand = [
    { uid: "reveal-rookie", owner: "P1", defId: "demo_rookie", faceUp: true },
    { uid: "reveal-guardian", owner: "P1", defId: "demo_guardian", faceUp: true }
  ];

  const candidates = autoplayActionCandidates(game, "P1")
    .filter((action) => action.type === "activateMainAbility");
  const subsets = new Set(candidates.map((action) => action.choices.revealedCards.map((choice) => choice.index).join(",")));
  assert.deepEqual([...subsets].sort(), ["", "0", "0,1", "1"]);
  const both = candidates.find((action) => action.choices.revealedCards.length === 2);
  const bothFeatures = pilotActionFeatures(game, "P1", both);
  assert.equal(bothFeatures["context.choice.private_hand_reveal_pilot.hand-reveal-main.revealedcards.card.demo_rookie"], 1);
  assert.equal(bothFeatures["context.choice.private_hand_reveal_pilot.hand-reveal-main.revealedcards.card.demo_guardian"], 1);
  const resolved = applyAction(game, both);
  assert.equal(resolved.players.P1.frontLine[0].bpModifiers.some((modifier) => modifier.amount === 2000), true);
  const knownCards = resolved.publicKnowledge.P2.players.P1.revealedCards;
  assert.equal(knownCards.some((known) => known.uid === "reveal-rookie"), true);
  assert.equal(knownCards.some((known) => known.uid === "reveal-guardian"), true);
});

test("autoplay exposes alternate effect targets with target-card features", () => {
  const catalog = {
    ...sampleCatalog,
    private_target_pilot: {
      id: "private_target_pilot",
      number: "DEM-1-094",
      sourceCode: "DEM",
      name: "Target Pilot",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      abilities: [{
        id: "target-main",
        timing: "activateMain",
        oncePerTurn: true,
        effect: {
          kind: "restTargets",
          target: { controller: "opponent", line: "front", min: 1, max: 1, choiceKey: "targets" }
        }
      }]
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
  const permanent = (pid, owner, defId) => ({
    pid,
    owner,
    controller: owner,
    cards: [{ uid: `${pid}-card`, owner, defId, faceUp: true }],
    rested: false,
    bpDelta: 0,
    bpModifiers: [],
    keywordModifiers: [],
    energyModifiers: [],
    attacksThisTurn: 0,
    blocksThisTurn: 0,
    usedOncePerTurn: []
  });
  game.players.P1.frontLine = [permanent("target-pilot", "P1", "private_target_pilot")];
  game.players.P2.frontLine = [
    permanent("target-low", "P2", "demo_rookie"),
    permanent("target-high", "P2", "demo_raider")
  ];
  const decisions = [];

  runAutoplayGame(game, {
    maxActions: 1,
    maxTurns: 10,
    decisionRecorder: (decision) => decisions.push(decision)
  });

  const candidates = decisions[0].candidates.filter((candidate) => candidate.action.type === "activateMainAbility");
  assert.equal(candidates.length, 2);
  assert.ok(candidates.some((candidate) => candidate.features["context.choice.private_target_pilot.target-main.targets.card.demo_rookie"] === 1));
  assert.ok(candidates.some((candidate) => candidate.features["context.choice.private_target_pilot.target-main.targets.card.demo_raider"] === 1));
});

test("autoplay accepts null per-player matchup overlay entries", () => {
  const game = createSimulationGame({
    catalog: sampleCatalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  }).state;

  assert.doesNotThrow(() => runAutoplayGame(game, {
    maxActions: 1,
    maxTurns: 10,
    matchupOverlays: { P1: null, P2: null }
  }));
});
