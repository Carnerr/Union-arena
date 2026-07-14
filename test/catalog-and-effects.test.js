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
  encodeEgmanCardText,
  internals,
  normalizeCatalog,
  parseKeywordEffects,
  validateCatalog
} from "../src/index.js";
import { sampleCatalog, sampleDeckList } from "../data/sample-cards.js";

function testPermanent(pid, owner, defId, rested = false) {
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

function topDefId(permanent) {
  return permanent.cards.at(-1).defId;
}

test("static rules encode deck limits, hand size, line capacity, and line-entry restrictions", () => {
  const beach = encodeEgmanCardText({
    name: "Strip of Beach",
    category: "Site",
    effect: "A deck can only contain up to three copies of this card. Your maximum hand size is now 15 cards. [When Played] Draw a card.",
    trigger: ""
  }).fields;
  assert.equal(beach.deckCopyLimit, 3);
  assert.equal(beach.maximumHandSize, 15);

  const titan = encodeEgmanCardText({
    name: "Colossal Titan",
    category: "Character",
    effect: "This card cannot be played onto your energy line. [If on the Front Line] The number of cards you can place onto your front line is reduced by one.",
    trigger: ""
  }).fields;
  assert.equal(titan.cannotPlayToEnergyLine, true);
  assert.deepEqual(titan.lineCapacityModifiers, [{
    line: LINES.FRONT,
    amount: -1,
    condition: { line: LINES.FRONT }
  }]);

  const hiko = encodeEgmanCardText({
    name: "Seijuro Hiko",
    category: "Character",
    effect: "This card cannot be played onto your front line and can only be moved to your front line using its ability.",
    trigger: ""
  }).fields;
  assert.equal(hiko.cannotPlayToFrontLine, true);
  assert.equal(hiko.frontLineMoveByOwnAbilityOnly, true);

  const muzan = encodeEgmanCardText({
    name: "Muzan Kibutsuji",
    category: "Character",
    effect: "This character cannot be played onto or moved to your front line unless you have 20 or more cards in your sideline.",
    trigger: ""
  }).fields;
  assert.equal(muzan.cannotEnterFrontLine, undefined);
  assert.deepEqual(muzan.frontLineEntryCondition, { sidelineCountMin: 20 });
});

function flattenEffectTree(effect) {
  if (!effect || typeof effect !== "object") return [];
  return [
    effect,
    ...(effect.effects ?? []).flatMap(flattenEffectTree),
    ...flattenEffectTree(effect.effect),
    ...flattenEffectTree(effect.elseEffect),
    ...flattenEffectTree(effect.ifMovedEffect),
    ...flattenEffectTree(effect.successEffect),
    ...(effect.choices ?? []).flatMap((choice) => flattenEffectTree(choice.effect))
  ];
}

test("normalizes private card rows into engine card definitions", () => {
  const catalog = normalizeCatalog([
    {
      id: "abc_001",
      cardNumber: "ABC-1-001",
      cardName: "Private Character",
      cardType: "Character",
      cardColor: "Green",
      requiredEnergy: "2",
      apCost: "1",
      BP: "3500",
      generatedEnergy: "Green:1",
      affinity: "Squad; Blade",
      keywordEffect: "Step; Damage (2); Impact (+1)",
      triggerEffect: "Get"
    }
  ]);

  validateCatalog(catalog);
  assert.equal(catalog.abc_001.type, CARD_TYPES.CHARACTER);
  assert.deepEqual(catalog.abc_001.keywords, { step: true, damage: 2, impactPlus: 1 });
  assert.equal(catalog.abc_001.trigger.type, "get");
});

test("normalizing an already-normalized card preserves required energy amount", () => {
  const catalog = normalizeCatalog({
    abc_002: {
      id: "abc_002",
      number: "ABC-1-002",
      sourceCode: "ABC",
      name: "Already Normalized Character",
      type: "character",
      color: "purple",
      requiredEnergy: { color: "purple", amount: 3 },
      apCost: 1,
      bp: 3500,
      energy: [{ color: "purple", amount: 1 }],
      affinities: []
    }
  });

  assert.deepEqual(catalog.abc_002.requiredEnergy, { color: "purple", amount: 3 });
});

test("EGM encoder handles empty-field required energy hand reductions", () => {
  const encoded = encodeEgmanCardText({
    category: "Character",
    name: "Empty Field Opener",
    effect: "If you have no cards on your field, reduce this card's required energy by [Blue×2] while in your hand."
  }).fields;

  assert.deepEqual(encoded.useCostModifiers, [{
    kind: "requiredEnergy",
    color: "blue",
    amount: 2,
    sourceZone: "hand",
    condition: { emptyField: true }
  }]);
});

test("EGM encoder preserves grouped timing tags and static energy generation", () => {
  const encoded = encodeEgmanCardText({
    category: "Character",
    name: "Grouped Timing Energy",
    effect: "If this character is active, it gains [Green] energy generation. [When Played] [When Attacking] Draw a card."
  }).fields;

  assert.deepEqual(encoded.staticEnergyModifiers, [{
    color: "green",
    amount: 1,
    condition: { active: true }
  }]);
  assert.deepEqual(encoded.abilities.map((ability) => ability.timing), [
    TIMINGS.WHEN_PLAYED,
    TIMINGS.WHEN_ATTACKING
  ]);
  assert.equal(encoded.abilities[0].effect.kind, "draw");
  assert.equal(encoded.abilities[1].effect.kind, "draw");

  const frontLineGenerator = encodeEgmanCardText({
    category: "Character",
    name: "Front Line Generator",
    effect: "This character generates energy even if it is on the front line."
  }).fields;
  assert.deepEqual(frontLineGenerator.keywords, { frontLineEnergyGeneration: true });

  const conditionalEnergy = encodeEgmanCardText({
    category: "Character",
    name: "Conditional Energy",
    effect: "If <Edward Elric> is on your front line, this character gains [Yellow] energy generation. If you have a <Sukuna's Finger> card in your sideline, this character gains [Blue] energy generation. If you have two or more [Pizza] affinity cards in your sideline, this character gains [Red] energy generation."
  }).fields;
  assert.deepEqual(conditionalEnergy.staticEnergyModifiers, [
    { color: "yellow", amount: 1, condition: { namedOnFrontLine: "edward elric" } },
    { color: "blue", amount: 1, condition: { zone: "sideline", zoneCountMin: 1, filter: { name: "sukuna's finger" } } },
    { color: "red", amount: 1, condition: { zone: "sideline", zoneCountMin: 2, filter: { affinity: "pizza" } } }
  ]);
});

test("EGM encoder handles unbracketed combat trigger abilities", () => {
  const result = encodeEgmanCardText({
    category: "Character",
    name: "Combat Draw",
    effect: "[Once Per Turn] When this character attacks and wins a battle, draw two cards. When this character attacks and is not blocked, draw a card. When a character on your field attacks and wins a battle, draw a card.",
    trigger: ""
  });

  assert.equal(result.coverage.unsupported.length, 0);
  assert.equal(result.fields.abilities[0].timing, TIMINGS.WHEN_ATTACK_WINS_BATTLE);
  assert.equal(result.fields.abilities[0].oncePerTurn, true);
  assert.deepEqual(result.fields.abilities[0].effect, { kind: "draw", amount: 2 });
  assert.equal(result.fields.abilities[1].timing, TIMINGS.WHEN_ATTACK_UNBLOCKED);
  assert.deepEqual(result.fields.abilities[1].effect, { kind: "draw", amount: 1 });
  assert.equal(result.fields.abilities[2].timing, TIMINGS.WHEN_OWN_CHARACTER_ATTACK_WINS_BATTLE);
  assert.deepEqual(result.fields.abilities[2].effect, { kind: "draw", amount: 1 });

  const siteRest = encodeEgmanCardText({
    category: "Site",
    name: "Combat Site",
    effect: "[Once Per Turn] When a character on your field attacks and wins a battle, you may switch this active site to resting.",
    trigger: ""
  });
  assert.equal(siteRest.coverage.unsupported.length, 0);
  assert.equal(siteRest.fields.abilities[0].timing, TIMINGS.WHEN_OWN_CHARACTER_ATTACK_WINS_BATTLE);
  assert.equal(siteRest.fields.abilities[0].effect.kind, "optional");
  assert.deepEqual(siteRest.fields.abilities[0].effect.effect, { kind: "restSelf" });

  const siteRestDraw = encodeEgmanCardText({
    category: "Site",
    name: "Arena",
    effect: "[Once Per Turn] When a character on your field attacks and wins a battle, you may switch this active site to resting. If you do, draw a card.",
    trigger: ""
  });
  assert.equal(siteRestDraw.coverage.unsupported.length, 0);
  assert.equal(siteRestDraw.fields.abilities[0].effect.kind, "optional");
  assert.deepEqual(siteRestDraw.fields.abilities[0].effect.effect.effects.map((effect) => effect.kind), ["restSelf", "draw"]);

  const affinityBattle = encodeEgmanCardText({
    category: "Site",
    name: "CCG Headquarters",
    effect: "[Once Per Turn] When one of your [CCG] affinity cards attacks and wins a battle, draw a card.",
    trigger: ""
  });
  assert.equal(affinityBattle.coverage.unsupported.length, 0);
  assert.equal(affinityBattle.fields.abilities[0].timing, TIMINGS.WHEN_OWN_CHARACTER_ATTACK_WINS_BATTLE);
  assert.deepEqual(affinityBattle.fields.abilities[0].conditions.attackingCharacter, { affinity: "CCG" });
});

test("EGM encoder handles field attack triggered support abilities", () => {
  const site = encodeEgmanCardText({
    category: "Site",
    name: "Self-Embodiment of Perfection",
    effect: "[Once Per Turn] When a <Mahito> on your field attacks, you may sideline one character on your field other than <Mahito>. If you do, play up to one character card with [Transfigured Human] affinity from your hand or sideline set to active onto your field.",
    trigger: ""
  });

  assert.equal(site.coverage.unsupported.length, 0);
  assert.equal(site.fields.abilities[0].timing, TIMINGS.WHEN_OWN_CHARACTER_ATTACKS);
  assert.equal(site.fields.abilities[0].oncePerTurn, true);
  assert.deepEqual(site.fields.abilities[0].conditions, {
    attackingCharacter: { name: "Mahito" }
  });
  assert.equal(site.fields.abilities[0].effect.kind, "optional");
  assert.deepEqual(site.fields.abilities[0].effect.effect.effects.map((effect) => effect.kind), [
    "sidelineTargets",
    "playCardFromZone"
  ]);

  const support = encodeEgmanCardText({
    category: "Character",
    name: "Tusk",
    effect: "When one of your [Shadow Army] affinity cards with 2000 or less base BP attacks, you may switch this active character to resting. If you do, choose one of the following. You cannot choose one of the abilities on <Tusk> that you have already chosen this turn. - Choose one attacking character. It gains 1500 BP until the end of the turn. - Draw a card, then place one card from your hand into your sideline.",
    trigger: ""
  });
  assert.equal(support.coverage.unsupported.length, 0);
  assert.equal(support.fields.abilities[0].timing, TIMINGS.WHEN_OWN_CHARACTER_ATTACKS);
  assert.deepEqual(support.fields.abilities[0].conditions.attackingCharacter, {
    affinity: "Shadow Army",
    bpMax: 2000
  });
  assert.equal(support.fields.abilities[0].effect.kind, "optional");
  const supportSequence = support.fields.abilities[0].effect.effect;
  assert.equal(supportSequence.kind, "sequence");
  assert.equal(supportSequence.effects[0].kind, "optional");
  assert.deepEqual(supportSequence.effects[0].effect, { kind: "restSelf" });
  assert.equal(supportSequence.effects[1].kind, "chooseOne");
  assert.equal(supportSequence.effects[1].choices[0].effect.target.attacking, true);

  const kaisel = encodeEgmanCardText({
    category: "Character",
    name: "Kaisel",
    effect: "When one of your [Shadow Army] affinity cards with 2000 or less base BP attacks, you may switch this active character to resting. If you do, choose one of the following. You cannot choose one of the abilities on <Kaisel> that you have already chosen this turn. - Choose up to one attacking character. It gains \"This character cannot be blocked by a character with 4000 or more BP\" until the end of the turn. - Choose up to one attacking character. It gains \"This character cannot be chosen by your opponent's abilities\" until the end of the turn.",
    trigger: ""
  });
  assert.equal(kaisel.coverage.unsupported.length, 0);
  const kaiselChoice = kaisel.fields.abilities[0].effect.effect.effects[1].choices[1].effect;
  assert.deepEqual(kaiselChoice, {
    kind: "grantKeyword",
    keyword: "targetingRestriction",
    value: {
      mode: "prohibit",
      sourceTypes: [CARD_TYPES.CHARACTER, CARD_TYPES.EVENT, CARD_TYPES.SITE, "trigger"]
    },
    duration: "turn",
    target: { type: CARD_TYPES.CHARACTER, max: 1, attacking: true }
  });
});

test("EGM encoder handles attack phase timing abilities", () => {
  const encoded = encodeEgmanCardText({
    category: "Character",
    name: "Attack Phase Timing",
    effect: "[If on the Front Line] At the start of your attack phase, if this character is active, choose up to one of your AP cards and switch it to active. At the end of this character's attack, you may pay 1 AP. If you do, switch this character to active. [Impact (1)] [If on the Front Line] If this character is active at the end of your attack phase, sideline it.",
    trigger: ""
  });

  assert.equal(encoded.coverage.unsupported.length, 0);
  assert.equal(encoded.fields.abilities[0].timing, TIMINGS.START_OF_ATTACK_PHASE);
  assert.deepEqual(encoded.fields.abilities[0].conditions, {
    line: LINES.FRONT,
    turn: "controller"
  });
  assert.equal(encoded.fields.abilities[0].effect.kind, "conditional");
  assert.equal(encoded.fields.abilities[1].timing, TIMINGS.END_OF_ATTACK);
  assert.deepEqual(encoded.fields.abilities[1].effect.effect.effects.map((effect) => effect.kind), ["payAp", "readySelf"]);
  assert.equal(encoded.fields.abilities[2].timing, TIMINGS.END_OF_ATTACK_PHASE);
  assert.deepEqual(encoded.fields.abilities[2].conditions, {
    line: LINES.FRONT,
    turn: "controller",
    active: true
  });
  assert.deepEqual(encoded.fields.abilities[2].effect, {
    kind: "moveSelfCardToZone",
    destination: "sideline"
  });

  const combatReorder = encodeEgmanCardText({
    category: "Character",
    name: "Sinon",
    effect: "When this character attacks and wins a battle, look at the top two cards of your deck. Place any number of them on the top of your deck in any order, then place any remaining cards on the bottom of your deck in any order. Choose up to one other character on your field. It gains 1000 BP until the end of the turn.",
    trigger: ""
  });
  const combatAbility = combatReorder.fields.abilities[0];
  assert.equal(combatAbility.timing, TIMINGS.WHEN_ATTACK_WINS_BATTLE);
  assert.equal(combatAbility.effect.kind, "sequence");
  assert.deepEqual(combatAbility.effect.effects.map((effect) => effect.kind), ["lookTopDeckAndMove", "modifyBp"]);
  assert.deepEqual(combatAbility.effect.effects[0].destinations, ["top", "bottom"]);
});

test("EGM encoder handles audited line-swap and top-deck templates", () => {
  const energyLineSwap = encodeEgmanCardText({
    category: "Character",
    name: "Nezuko Kamado",
    effect: "[#If on the Energy Line#] At the start of your attack phase, choose one character on your front line. You may swap it with this character.",
    trigger: ""
  });
  assert.equal(energyLineSwap.coverage.unsupported.length, 0);
  assert.equal(energyLineSwap.fields.abilities[0].timing, TIMINGS.START_OF_ATTACK_PHASE);
  assert.deepEqual(energyLineSwap.fields.abilities[0].conditions, {
    line: LINES.ENERGY,
    turn: "controller"
  });
  assert.equal(energyLineSwap.fields.abilities[0].effect.kind, "optional");
  assert.equal(energyLineSwap.fields.abilities[0].effect.effect.kind, "swapSourceWithOtherLine");

  const quotedSwapRequirement = encodeEgmanCardText({
    category: "Character",
    name: "Ma Dongwook",
    effect: "[#If on the Energy Line#] At the end of your attack phase, you may choose one character on your front line that \"will remain set to resting the next time it would be switched to active\" and swap it with this character.",
    trigger: ""
  });
  assert.equal(quotedSwapRequirement.coverage.unsupported.length, 0);
  assert.equal(quotedSwapRequirement.fields.abilities[0].timing, TIMINGS.END_OF_ATTACK_PHASE);
  assert.equal(quotedSwapRequirement.fields.abilities[0].effect.kind, "optional");
  assert.equal(quotedSwapRequirement.fields.abilities[0].effect.effect.kind, "swapSourceWithOtherLine");

  const riko = encodeEgmanCardText({
    category: "Character",
    name: "Riko Amanai",
    effect: "[#If on the Energy Line#] At the end of your attack phase and your opponent's attack phase, if neither <Satoru Gojo> nor <Suguru Geto> are on your front line, move this character to your front line.",
    trigger: ""
  });
  assert.equal(riko.coverage.unsupported.length, 0);
  assert.equal(riko.fields.abilities[0].timing, TIMINGS.END_OF_ATTACK_PHASE);
  assert.deepEqual(riko.fields.abilities[0].conditions, { line: LINES.ENERGY });
  assert.equal(riko.fields.abilities[0].effect.kind, "conditional");
  assert.deepEqual(riko.fields.abilities[0].effect.condition, {
    frontLineCountMax: 0,
    filter: { names: ["satoru gojo", "suguru geto"] }
  });
  assert.equal(riko.fields.abilities[0].effect.effect.kind, "moveTargetsToLine");

  const asuna = encodeEgmanCardText({
    category: "Character",
    name: "Asuna",
    effect: "[When Played] Choose up to one character on your opponent's front line and up to one character with 1 or less energy generation on their energy line and switch them to resting. If you chose two cards, {you may swap them}.",
    trigger: ""
  });
  assert.equal(asuna.coverage.unsupported.length, 0);
  assert.equal(asuna.fields.abilities[0].effect.kind, "sequence");
  assert.deepEqual(asuna.fields.abilities[0].effect.effects.map((effect) => effect.kind), [
    "restTargets",
    "restTargets",
    "optional"
  ]);
  assert.equal(asuna.fields.abilities[0].effect.effects[2].effect.kind, "swapChosenTargets");

  const cho = encodeEgmanCardText({
    category: "Character",
    name: "Cho Sawagejo",
    effect: "[When Played] If your opponent's front line is not full, you may reveal one <Makoto Shishio>, <Yumi Komagata>, or [Ten Swords] affinity card from your hand and place it on the top of your deck. If you do, choose up to one character with 1 or less energy generation on your opponent's energy line and move it to their front line.",
    trigger: ""
  });
  assert.equal(cho.coverage.unsupported.length, 0);
  assert.equal(cho.fields.abilities[0].effect.effect.kind, "optional");
  assert.deepEqual(cho.fields.abilities[0].effect.effect.effect.effects.map((effect) => effect.kind), [
    "moveHandToZone",
    "moveTargetsToLine"
  ]);

  const shin = encodeEgmanCardText({
    category: "Character",
    name: "Shin Asakura",
    effect: "[When Played] Choose up to one character on your opponent's front line and switch it to resting. It will remain set to resting the next time it would be switched to active. If there is a face-up card on the top of your deck, you may add it to your hand. If you do, switch this character to active and turn the top card of your deck face up.",
    trigger: ""
  });
  assert.equal(shin.coverage.unsupported.length, 0);
  assert.equal(shin.fields.abilities[0].effect.kind, "sequence");
  assert.deepEqual(shin.fields.abilities[0].effect.effects.map((effect) => effect.kind), [
    "restTargets",
    "restTargets",
    "conditional"
  ]);
  assert.deepEqual(shin.fields.abilities[0].effect.effects[2].condition, { topDeckFaceUp: true });

  const suguru = encodeEgmanCardText({
    category: "Character",
    name: "Suguru Geto",
    effect: "[When Played] Look at the top two cards of your deck. Place any number of [Cursed Spirit] or [Cursed Wombs: Death Paintings] affinity cards among them into your sideline. Place the remaining cards on the top of your deck in any order.",
    trigger: ""
  });
  assert.equal(suguru.coverage.unsupported.length, 0);
  assert.equal(suguru.fields.abilities[0].effect.kind, "lookTopDeckAndMove");
  assert.deepEqual(suguru.fields.abilities[0].effect.destinations, ["top", "sideline"]);

  const invitation = encodeEgmanCardText({
    category: "Event",
    name: "Invitation from the Demon Lord",
    effect: "Look at the top three cards of your deck. Play up to one green character card with 4 or less required energy and 1 AP cost set to resting onto your field, or perform Raid with it. Place the remaining cards on the bottom of your deck in any order.",
    trigger: ""
  });
  assert.equal(invitation.coverage.unsupported.length, 0);
  assert.equal(invitation.fields.eventEffect.kind, "lookTopDeckPlayOneAndMoveRest");
  assert.deepEqual(invitation.fields.eventEffect.filter, {
    type: CARD_TYPES.CHARACTER,
    color: "green",
    requiredEnergyMax: 4,
    apCost: 1
  });
});

test("EGM encoder handles self deck-to-sideline zone triggers", () => {
  const encoded = encodeEgmanCardText({
    category: "Character",
    name: "Private Milled Trigger",
    effect: "When this card is placed from your deck into your sideline by one of your abilities, draw up to one card.",
    trigger: ""
  });

  assert.equal(encoded.coverage.unsupported.length, 0);
  assert.deepEqual(encoded.fields.abilities, [{
    id: `${TIMINGS.WHEN_SELF_DECK_TO_SIDELINE_BY_ABILITY}-1`,
    timing: TIMINGS.WHEN_SELF_DECK_TO_SIDELINE_BY_ABILITY,
    oncePerTurn: false,
    conditions: { zone: "sideline" },
    effect: {
      kind: "optional",
      choiceKey: "optionalDraw",
      default: true,
      effect: { kind: "draw", amount: 1 }
    }
  }]);

  const raid = encodeEgmanCardText({
    category: "Character",
    name: "Private Sideline Raid",
    effect: "When this card is placed from your deck into your sideline by one of your abilities, if you have the required energy for it, you may perform Raid with it from your sideline.",
    trigger: ""
  });
  assert.equal(raid.coverage.unsupported.length, 0);
  assert.deepEqual(raid.fields.abilities[0].effect, {
    kind: "optional",
    choiceKey: "optionalEffect",
    default: true,
    effect: { kind: "raidSourceFromZone", source: "sideline" }
  });
});

test("EGM encoder handles return-to-hand templates", () => {
  const returnEvent = encodeEgmanCardText({
    category: "Event",
    name: "Return",
    effect: "Return one character from your field to your hand. If you do, draw two cards.",
    trigger: ""
  });
  assert.equal(returnEvent.coverage.unsupported.length, 0);
  assert.deepEqual(returnEvent.fields.eventEffect.effects.map((effect) => effect.kind), ["returnTargetsToHand", "draw"]);

  const worldTree = encodeEgmanCardText({
    category: "Site",
    name: "World Tree",
    effect: "[Activate: Main] [Switch to Resting] Return one character on your field with [ALO] affinity to your hand. If you do, choose up to one character on your field or your opponent's field. It gains 1000 BP until the end of the turn.",
    trigger: ""
  });
  assert.equal(worldTree.coverage.unsupported.length, 0);
  assert.equal(worldTree.fields.abilities[0].effect.effects[0].kind, "returnTargetsToHand");
  assert.deepEqual(worldTree.fields.abilities[0].effect.effects[0].target.affinity, "alo");

  const instead = encodeEgmanCardText({
    category: "Event",
    name: "Fishing Rod",
    effect: "Choose one character on your opponent's front line with BP equal to or less than the highest BP of the characters on your field and {return it to their hand}. If <Gon Freecss> is on your field, {sideline it} instead.",
    trigger: ""
  });
  assert.equal(instead.coverage.unsupported.length, 0);
  assert.equal(instead.fields.eventEffect.kind, "conditional");
  assert.equal(instead.fields.eventEffect.effect.kind, "sidelineTargets");
  assert.equal(instead.fields.eventEffect.elseEffect.kind, "returnTargetsToHand");
});

test("EGM encoder handles base-card and bottom-deck movement templates", () => {
  const flattenEffects = (effect) => {
    if (!effect) return [];
    return [
      effect,
      ...(effect.effects ?? []).flatMap(flattenEffects),
      ...(effect.effect ? flattenEffects(effect.effect) : []),
      ...(effect.elseEffect ? flattenEffects(effect.elseEffect) : []),
      ...(effect.choices ?? []).flatMap((choice) => flattenEffects(choice.effect))
    ];
  };

  const activeBase = encodeEgmanCardText({
    category: "Character",
    name: "Aoshi Shinomori",
    effect: "[Activate: Main] Play the base card of this Raided character set to active onto your field.",
    trigger: ""
  });
  assert.equal(activeBase.coverage.unsupported.length, 0);
  assert.equal(activeBase.fields.abilities[0].effect.kind, "playBaseCardFromSelf");
  assert.equal(activeBase.fields.abilities[0].effect.rested, false);

  const baseToSideline = encodeEgmanCardText({
    category: "Character",
    name: "Evangelion Production Model-New 02",
    effect: "At the end of this character's attack, you may place four [WILLE] affinity cards from your sideline into your removal area. If you do, switch this character to active and place the base card of this Raided character into your sideline.",
    trigger: ""
  });
  assert.equal(baseToSideline.coverage.unsupported.length, 0);
  assert.ok(flattenEffects(baseToSideline.fields.abilities[0].effect).some((effect) => effect.kind === "moveBaseCardFromSelf" && effect.destination === "sideline"));

  const baseToLife = encodeEgmanCardText({
    category: "Character",
    name: "Leafa",
    effect: "[When Played] If you have 4 or less life, place up to one base card of this Raided character face up into your life area.",
    trigger: ""
  });
  assert.equal(baseToLife.coverage.unsupported.length, 0);
  const lifeMove = flattenEffects(baseToLife.fields.abilities[0].effect).find((effect) => effect.kind === "moveBaseCardFromSelf");
  assert.equal(lifeMove.destination, "life");
  assert.equal(lifeMove.faceUp, true);

  const sidelineBottom = encodeEgmanCardText({
    category: "Character",
    name: "Yuna",
    effect: "[Activate: Main] Place four cards from your sideline on the bottom of your deck in any order.",
    trigger: ""
  });
  assert.equal(sidelineBottom.coverage.unsupported.length, 0);
  assert.equal(sidelineBottom.fields.abilities[0].effect.kind, "moveCardBetweenZones");
  assert.equal(sidelineBottom.fields.abilities[0].effect.destination, "deck");
  assert.equal(sidelineBottom.fields.abilities[0].effect.position, "bottom");

  const namedReturn = encodeEgmanCardText({
    category: "Character",
    name: "Tanjiro Kamado",
    effect: "[When Played] You may return one <Nezuko Kamado> on your field to your hand.",
    trigger: ""
  });
  assert.equal(namedReturn.coverage.unsupported.length, 0);
  assert.equal(namedReturn.fields.abilities[0].effect.effect.kind, "returnTargetsToHand");
  assert.equal(namedReturn.fields.abilities[0].effect.effect.target.name, "nezuko kamado");
});

test("EGM encoder handles unbracketed leave-field play triggers", () => {
  const encoded = encodeEgmanCardText({
    category: "Character",
    name: "Rei Ayanami",
    effect: "When this character leaves the field due to battle or one of your or your opponent's abilities, you may place one card from your hand into your sideline. If you do, play up to one yellow <Rei Ayanami> card with 2 or less required energy from your sideline set to active onto your field.",
    trigger: ""
  });
  assert.equal(encoded.coverage.unsupported.length, 0);
  assert.equal(encoded.fields.abilities[0].timing, TIMINGS.WHEN_LEAVES_FIELD);
  assert.equal(encoded.fields.abilities[0].effect.kind, "optional");
  assert.deepEqual(encoded.fields.abilities[0].effect.effect.effects.map((effect) => effect.kind), [
    "moveHandToZone",
    "playCardFromZone"
  ]);
});

test("keyword parser handles current card-list keyword families", () => {
  assert.deepEqual(parseKeywordEffects("Double Attack; Nullify Impact; Damage (7)"), {
    doubleAttack: true,
    nullifyImpact: true,
    damage: 7
  });

  const protectedStatic = encodeEgmanCardText({
    category: "Character",
    name: "Private Protected",
    effect: "This character cannot be chosen by your opponent's abilities.",
    trigger: ""
  });
  assert.deepEqual(protectedStatic.fields.keywords, { opponentAbilityProtection: true });
});

test("data-defined event effects can rest targets and move top deck cards", () => {
  const catalog = {
    ...sampleCatalog,
    private_rest_event: {
      id: "private_rest_event",
      number: "DEM-1-099",
      sourceCode: "DEM",
      name: "Private Rest Event",
      type: CARD_TYPES.EVENT,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      affinities: [],
      eventEffect: {
        kind: "sequence",
        effects: [
          {
            kind: "restTargets",
            target: { controller: "opponent", line: LINES.FRONT, type: CARD_TYPES.CHARACTER, max: 1 }
          },
          { kind: "moveTopDeck", count: 1, destination: "hand" }
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
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });

  game.players.P1.hand.unshift({ uid: "private-event-ref", owner: "P1", defId: "private_rest_event", faceUp: true });
  game.players.P2.frontLine.push({
    pid: "manual-p2-front",
    owner: "P2",
    controller: "P2",
    cards: [{ uid: "manual-p2-card", owner: "P2", defId: "demo_rookie", faceUp: true }],
    rested: false,
    bpDelta: 0,
    bpModifiers: [],
    keywordModifiers: [],
    attacksThisTurn: 0,
    blocksThisTurn: 0,
    usedOncePerTurn: []
  });

  const p1HandBefore = game.players.P1.hand.length;
  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0 });

  assert.equal(game.players.P2.frontLine[0].rested, true);
  assert.equal(game.players.P1.hand.length, p1HandBefore);
  assert.equal(game.players.P1.sideline.at(-1).defId, "private_rest_event");
});

test("data-defined when-played effects modify battle power", () => {
  const catalog = {
    ...sampleCatalog,
    private_power_up: {
      id: "private_power_up",
      number: "DEM-1-098",
      sourceCode: "DEM",
      name: "Private Power Up",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      abilities: [
        {
          id: "self-plus-1000",
          timing: TIMINGS.WHEN_PLAYED,
          effect: { kind: "modifyBp", amount: 1000, target: "self" }
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
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game.players.P1.hand.unshift({ uid: "private-power-ref", owner: "P1", defId: "private_power_up", faceUp: true });
  game = applyAction(game, {
    type: "playCard",
    player: "P1",
    handIndex: 0,
    destination: LINES.FRONT
  });

  assert.equal(internals.battlePower(game, game.players.P1.frontLine[0]), 2000);
});

test("EGM text encoder emits common ability, trigger, raid, and static specs", () => {
  const encoded = encodeEgmanCardText({
    name: "Private Raider",
    category: "Character",
    effect: "[Raid]<Private Base> Switch to active. May move to the front line.<br/>[When Played]Draw a card, then place one card from your hand into your sideline.<br/>[During Your Turn]This character gains 1000 BP.",
    trigger: "[Active] Choose one character on your field and switch it to active. It gains 3000 BP until the end of the turn."
  }).fields;

  assert.deepEqual(encoded.raid, { names: ["Private Base"], affinities: [] });
  assert.equal(encoded.abilities[0].timing, TIMINGS.WHEN_PLAYED);
  assert.equal(encoded.abilities[0].effect.kind, "sequence");
  assert.equal(encoded.triggerEffect.type, "active");
  assert.deepEqual(encoded.staticModifiers, [{ bp: 1000, condition: { turn: "controller" } }]);
});

test("searchTopDeck moves matching cards to hand and bottoms the rest", () => {
  const catalog = {
    ...sampleCatalog,
    private_search_event: {
      id: "private_search_event",
      number: "DEM-1-097",
      sourceCode: "DEM",
      name: "Private Search Event",
      type: CARD_TYPES.EVENT,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      affinities: [],
      eventEffect: {
        kind: "searchTopDeck",
        count: 3,
        max: 1,
        filter: { type: CARD_TYPES.CHARACTER, otherThanName: "Demo Rookie" }
      }
    }
  };

  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });

  game.players.P1.hand.unshift({ uid: "search-event-ref", owner: "P1", defId: "private_search_event", faceUp: true });
  game.players.P1.deck = [
    { uid: "search-1", owner: "P1", defId: "demo_rookie", faceUp: true },
    { uid: "search-2", owner: "P1", defId: "demo_stepper", faceUp: true },
    { uid: "search-3", owner: "P1", defId: "demo_guardian", faceUp: true }
  ];

  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0 });

  assert.equal(game.players.P1.hand.at(-1).defId, "demo_stepper");
  assert.deepEqual(game.players.P1.deck.map((card) => card.defId), ["demo_rookie", "demo_guardian"]);
});

test("searchTopDeck reveal-selected records only the card shown to the opponent", () => {
  const catalog = {
    ...sampleCatalog,
    reveal_selected_event: {
      id: "reveal_selected_event",
      number: "DEM-1-098",
      sourceCode: "DEM",
      name: "Reveal Selected Event",
      type: CARD_TYPES.EVENT,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      affinities: [],
      eventEffect: {
        kind: "searchTopDeck",
        count: 3,
        max: 1,
        destination: "hand",
        revealSelected: true,
        filter: { type: CARD_TYPES.CHARACTER, otherThanName: "Demo Rookie" }
      }
    }
  };

  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });

  game.players.P1.hand.unshift({ uid: "reveal-selected-event-ref", owner: "P1", defId: "reveal_selected_event", faceUp: true });
  game.players.P1.deck = [
    { uid: "reveal-selected-1", owner: "P1", defId: "demo_rookie", faceUp: true },
    { uid: "reveal-selected-2", owner: "P1", defId: "demo_stepper", faceUp: true },
    { uid: "reveal-selected-3", owner: "P1", defId: "demo_guardian", faceUp: true }
  ];

  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0 });

  assert.deepEqual(
    game.publicKnowledge.P2.players.P1.revealedCards.map((card) => card.defId),
    ["demo_stepper"]
  );
});

test("look-top deck arrangement can move cards to bottom or sideline", () => {
  const encoded = encodeEgmanCardText({
    name: "Private Arrange Event",
    category: "Event",
    effect: "Look at the top card of your deck, then place it on the top or bottom of your deck.",
    trigger: ""
  }).fields.eventEffect;
  assert.equal(encoded.kind, "lookTopDeckAndMove");
  assert.deepEqual(encoded.destinations, ["top", "bottom"]);

  const catalog = {
    ...sampleCatalog,
    private_arrange_event: {
      id: "private_arrange_event",
      number: "DEM-1-093",
      sourceCode: "DEM",
      name: "Private Arrange Event",
      type: CARD_TYPES.EVENT,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      affinities: [],
      eventEffect: encoded
    },
    private_sideline_arrange_event: {
      id: "private_sideline_arrange_event",
      number: "DEM-1-092",
      sourceCode: "DEM",
      name: "Private Sideline Arrange Event",
      type: CARD_TYPES.EVENT,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      affinities: [],
      eventEffect: encodeEgmanCardText({
        name: "Private Sideline Arrange Event",
        category: "Event",
        effect: "Look at the top card of your deck, then place it on the top of your deck or into your sideline.",
        trigger: ""
      }).fields.eventEffect
    }
  };

  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game.players.P1.hand.unshift({ uid: "arrange-event-ref", owner: "P1", defId: "private_arrange_event", faceUp: true });
  game.players.P1.deck = [
    { uid: "arrange-1", owner: "P1", defId: "demo_rookie", faceUp: true },
    { uid: "arrange-2", owner: "P1", defId: "demo_stepper", faceUp: true }
  ];
  game = applyAction(game, {
    type: "playCard",
    player: "P1",
    handIndex: 0,
    choices: { lookTopDeckPlacements: [{ index: 0, destination: "bottom" }] }
  });
  assert.deepEqual(game.players.P1.deck.map((card) => card.defId), ["demo_stepper", "demo_rookie"]);

  game.players.P1.hand.unshift({ uid: "arrange-sideline-event-ref", owner: "P1", defId: "private_sideline_arrange_event", faceUp: true });
  game.players.P1.deck = [
    { uid: "arrange-3", owner: "P1", defId: "demo_guardian", faceUp: true },
    { uid: "arrange-4", owner: "P1", defId: "demo_rookie", faceUp: true }
  ];
  game = applyAction(game, {
    type: "playCard",
    player: "P1",
    handIndex: 0,
    choices: { lookTopDeckPlacements: [{ index: 0, destination: "sideline" }] }
  });
  assert.deepEqual(game.players.P1.deck.map((card) => card.defId), ["demo_rookie"]);
  assert.ok(game.players.P1.sideline.some((card) => card.defId === "demo_guardian"));
});

test("look-top deck distribution can move cards to hand, sideline, and bottom", () => {
  const encoded = encodeEgmanCardText({
    name: "Private Research Event",
    category: "Event",
    effect: "Look at the top five cards of your deck. Add one card among them to your hand and place one card among them into your sideline. Place the remaining cards on the bottom of your deck in any order.",
    trigger: ""
  }).fields.eventEffect;

  assert.equal(encoded.kind, "lookTopDeckAndMove");
  assert.deepEqual(encoded.destinations, ["hand", "sideline", "bottom"]);
  assert.deepEqual(encoded.defaultPlacements, [
    { index: 0, destination: "hand" },
    { index: 1, destination: "sideline" }
  ]);

  const revealEncoded = encodeEgmanCardText({
    name: "Private Reveal Character",
    category: "Character",
    effect: "[When Played] Reveal the top two cards of your deck. Add up to one character card among them to your hand. Place the remaining cards into your sideline.",
    trigger: ""
  }).fields.abilities[0].effect;
  assert.equal(revealEncoded.kind, "searchTopDeck");
  assert.equal(revealEncoded.publicReveal, true);
  assert.equal(revealEncoded.remainingDestination, "sideline");

  const revealTopThree = encodeEgmanCardText({
    name: "Liltotto Lamperd",
    category: "Character",
    effect: "[When Played] Reveal the top three cards of your deck. Add up to one [Bambies] affinity or <Bambietta Basterbine> card among them to your hand. Place the remaining cards into your sideline. If you added a card to your hand, place one card from your hand into your sideline.",
    trigger: ""
  }).fields.abilities[0].effect;
  assert.equal(revealTopThree.kind, "sequence");
  assert.equal(revealTopThree.effects[0].kind, "searchTopDeck");
  assert.equal(revealTopThree.effects[0].publicReveal, true);
  assert.equal(revealTopThree.effects[0].count, 3);
  assert.equal(revealTopThree.effects[0].remainingDestination, "sideline");
  assert.deepEqual(revealTopThree.effects[0].filter.anyOf, [
    { affinity: "bambies" },
    { name: "bambietta basterbine" }
  ]);

  const sidelineTop = encodeEgmanCardText({
    name: "Private Sideline Top",
    category: "Character",
    effect: "[When Played] Look at the top three cards of your deck. Place up to one card into your sideline, then place the remaining cards on the top of your deck in any order.",
    trigger: ""
  }).fields.abilities[0].effect;
  assert.equal(sidelineTop.kind, "lookTopDeckAndMove");
  assert.deepEqual(sidelineTop.destinations, ["top", "sideline"]);
  assert.equal(sidelineTop.maxNonDefault, 1);

  const sidelineBottom = encodeEgmanCardText({
    name: "Private Sideline Bottom",
    category: "Character",
    effect: "[When Played] Look at the top five cards of your deck. Place up to one purple card with 2 or less required energy into your sideline. Place the remaining cards on the bottom of your deck in any order.",
    trigger: ""
  }).fields.abilities[0].effect;
  assert.equal(sidelineBottom.kind, "lookTopDeckAndMove");
  assert.deepEqual(sidelineBottom.destinations, ["sideline", "bottom"]);
  assert.equal(sidelineBottom.maxNonDefault, 1);

  const playFromLooked = encodeEgmanCardText({
    name: "Private Look Play Event",
    category: "Event",
    effect: "Look at the top four cards of your deck. Play up to one green character card with 1 or less required energy and 1 AP cost among them set to resting onto your field. Place the remaining cards on the bottom of your deck in any order.",
    trigger: ""
  }).fields.eventEffect;
  assert.equal(playFromLooked.kind, "lookTopDeckPlayOneAndMoveRest");
  assert.equal(playFromLooked.rested, true);
  assert.equal(playFromLooked.remainingDestination, "bottom");

  const selectedReveal = encodeEgmanCardText({
    name: "Private Selected Reveal",
    category: "Character",
    effect: "[When Played] Look at the top three cards of your deck. Reveal up to one character card among them and add it to your hand. Place the remaining cards on the bottom of your deck in any order.",
    trigger: ""
  }).fields.abilities[0].effect;
  assert.equal(selectedReveal.kind, "searchTopDeck");
  assert.equal(selectedReveal.revealSelected, true);
  assert.equal(selectedReveal.publicReveal, undefined);

  const catalog = {
    ...sampleCatalog,
    private_research_event: {
      id: "private_research_event",
      number: "DEM-1-094",
      sourceCode: "DEM",
      name: "Private Research Event",
      type: CARD_TYPES.EVENT,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      affinities: [],
      eventEffect: encoded
    },
    private_look_play_event: {
      id: "private_look_play_event",
      number: "DEM-1-095",
      sourceCode: "DEM",
      name: "Private Look Play Event",
      type: CARD_TYPES.EVENT,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      affinities: [],
      eventEffect: playFromLooked
    }
  };

  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game.players.P1.hand.unshift({ uid: "research-event-ref", owner: "P1", defId: "private_research_event", faceUp: true });
  game.players.P1.deck = [
    { uid: "research-hand", owner: "P1", defId: "demo_rookie", faceUp: true },
    { uid: "research-sideline", owner: "P1", defId: "demo_guardian", faceUp: true },
    { uid: "research-bottom-1", owner: "P1", defId: "demo_stepper", faceUp: true },
    { uid: "research-bottom-2", owner: "P1", defId: "demo_raider", faceUp: true }
  ];

  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0 });

  assert.equal(game.players.P1.hand.at(-1).uid, "research-hand");
  assert.ok(game.players.P1.sideline.some((card) => card.uid === "research-sideline"));
  assert.deepEqual(game.players.P1.deck.map((card) => card.uid), ["research-bottom-1", "research-bottom-2"]);

  game.players.P1.hand.unshift({ uid: "look-play-event-ref", owner: "P1", defId: "private_look_play_event", faceUp: true });
  game.players.P1.deck = [
    { uid: "look-play-card", owner: "P1", defId: "demo_guardian", faceUp: true },
    { uid: "look-bottom-1", owner: "P1", defId: "demo_extra", faceUp: true },
    { uid: "look-bottom-2", owner: "P1", defId: "demo_draw_event", faceUp: true }
  ];
  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0 });

  assert.equal(game.players.P1.frontLine.at(-1).cards[0].uid, "look-play-card");
  assert.equal(game.players.P1.frontLine.at(-1).rested, true);
  assert.deepEqual(game.players.P1.deck.map((card) => card.uid), ["look-bottom-1", "look-bottom-2"]);
});

test("EGM encoder handles reveal-top deck arrangement", () => {
  const encoded = encodeEgmanCardText({
    category: "Character",
    name: "Genthru",
    effect: "[When Played] Reveal the top card of your deck. Place the revealed card on the top or bottom of your deck.",
    trigger: ""
  });
  assert.equal(encoded.coverage.unsupported.length, 0);
  assert.equal(encoded.fields.abilities[0].effect.kind, "lookTopDeckAndMove");
  assert.equal(encoded.fields.abilities[0].effect.publicReveal, true);
  assert.deepEqual(encoded.fields.abilities[0].effect.destinations, ["top", "bottom"]);
});

test("EGM encoder handles front-energy swap templates", () => {
  const opponentSwap = encodeEgmanCardText({
    category: "Character",
    name: "Aoi Todo",
    effect: "[When Played] You may choose one character on both your opponent's front line and energy line and swap them.",
    trigger: ""
  });
  assert.equal(opponentSwap.coverage.unsupported.length, 0);
  assert.equal(opponentSwap.fields.abilities[0].effect.effect.kind, "swapOwnFrontAndEnergy");
  assert.equal(opponentSwap.fields.abilities[0].effect.effect.player, "opponent");

  const sourceSwap = encodeEgmanCardText({
    category: "Character",
    name: "Hakuro",
    effect: "[When Played] [#If on the Energy Line#] You may choose one active character on your front line and swap it with this character.",
    trigger: ""
  });
  assert.equal(sourceSwap.coverage.unsupported.length, 0);
  assert.equal(sourceSwap.fields.abilities[0].effect.effect.kind, "swapSourceWithOtherLine");

  const sourceMoveOrSwap = encodeEgmanCardText({
    category: "Character",
    name: "Ginshi Shirazu",
    effect: "[Activate: Main] [Pay 1 AP] [Once Per Turn] Move this character to the other line or swap it with a character on the other line.",
    trigger: ""
  });
  assert.equal(sourceMoveOrSwap.coverage.unsupported.length, 0);
  assert.equal(sourceMoveOrSwap.fields.abilities[0].effect.kind, "chooseOne");
  assert.equal(sourceMoveOrSwap.fields.abilities[0].effect.choices[1].effect.kind, "swapSourceWithOtherLine");

  const targetMoveOrSwap = encodeEgmanCardText({
    category: "Character",
    name: "Sumi",
    effect: "[When Played] Choose up to one <Chihiro Rokuhira>, <Iori Samura>, or [Iai White Purity Style] affinity card on your field and move it to the other line or swap it with a character on the other line.",
    trigger: ""
  });
  assert.equal(targetMoveOrSwap.coverage.unsupported.length, 0);
  assert.equal(targetMoveOrSwap.fields.abilities[0].effect.kind, "chooseOne");
  assert.equal(targetMoveOrSwap.fields.abilities[0].effect.choices[1].effect.kind, "swapTargetsWithOtherLine");
  assert.equal(targetMoveOrSwap.fields.abilities[0].effect.choices[1].effect.target.anyOf.length, 3);

  const massMoveOrSwap = encodeEgmanCardText({
    category: "Event",
    name: "Accompany",
    effect: "Choose any number of characters on your field and move them to or swap them with characters on the other line. Draw a card.",
    trigger: ""
  });
  assert.equal(massMoveOrSwap.coverage.unsupported.length, 0);
  assert.deepEqual(massMoveOrSwap.fields.eventEffect.effects.map((effect) => effect.kind), ["moveOrSwapTargetsToOtherLine", "draw"]);
  assert.equal(massMoveOrSwap.fields.eventEffect.effects[0].target.min, 0);
  assert.equal(massMoveOrSwap.fields.eventEffect.effects[0].target.max, MAX_LINE_SIZE * 2);

  const finral = encodeEgmanCardText({
    category: "Character",
    name: "Finral Roulacase",
    effect: "At the end of your attack phase, you may place one face-down card under this character into your sideline. If you do, choose one of the following: ・Choose one character on your field and move it to the other line. ・Choose one character on both your front line and energy line and swap them.",
    trigger: ""
  });
  const finralChoices = finral.fields.abilities[0].effect.effect.effects[1].choices;
  assert.equal(finralChoices.length, 2);
  assert.equal(finralChoices[1].effect.kind, "swapOwnFrontAndEnergy");
});

test("EGM encoder handles split-target rest, ready, and sideline-cost templates", () => {
  const tooSlow = encodeEgmanCardText({
    category: "Event",
    name: "Too Slow!",
    effect: "Choose one character on your opponent's front line and switch it to resting. Choose up to one <Sakonji Urokodaki> on your field and switch it to active.",
    trigger: ""
  }).fields.eventEffect;
  assert.equal(tooSlow.kind, "sequence");
  assert.deepEqual(tooSlow.effects.map((effect) => effect.kind), ["restTargets", "readyTargets"]);
  assert.equal(tooSlow.effects[0].target.controller, "opponent");
  assert.equal(tooSlow.effects[1].target.name, "sakonji urokodaki");

  const weakStrong = encodeEgmanCardText({
    category: "Event",
    name: "The Weak and the Strong",
    effect: "Choose up to one character on your opponent's front line and switch it to resting. It will remain set to resting the next time it would be switched to active. If you have three or more [Exotic] affinity cards on your field, choose up to one character on your field and switch it to active.",
    trigger: ""
  }).fields.eventEffect;
  assert.equal(weakStrong.kind, "sequence");
  assert.equal(weakStrong.effects[0].kind, "restTargets");
  assert.equal(weakStrong.effects[0].preventNextReady, true);
  assert.equal(weakStrong.effects[1].kind, "conditional");
  assert.equal(weakStrong.effects[1].effect.kind, "readyTargets");

  const siteLoop = encodeEgmanCardText({
    category: "Site",
    name: "Silbern",
    effect: "[When Played] Look at the top three cards of your deck. Reveal up to one [Stern Ritters] affinity card among them and add it to your hand. Place the remaining cards on the bottom of your deck in any order. [Activate: Main] [Switch to Resting] Sideline one character on your field. If you do, activate this site's [When Played] ability.",
    trigger: ""
  }).fields.abilities.find((ability) => ability.timing === TIMINGS.ACTIVATE_MAIN);
  assert.equal(siteLoop.effect.kind, "sidelineTargetsThenActivateSourceWhenPlayed");
  assert.equal(siteLoop.effect.target.controller, "self");
});

test("EGM encoder handles no-trigger hand costs before ready and BP follow-ups", () => {
  const encoded = encodeEgmanCardText({
    category: "Character",
    name: "Evangelion Production Model-02 (Beast Form)",
    effect: "[Raid] <Mari Makinami Illustrious> Switch to active. May move to the front line. [Once Per Turn] At the end of this character's attack, if a character is on your opponent's front line, you may place two cards without [Trigger] abilities from your hand into your sideline. If you do, switch this character to active and give it 3000 BP until the end of the turn.",
    trigger: ""
  });
  const ability = encoded.fields.abilities.find((candidate) => candidate.timing === TIMINGS.END_OF_ATTACK);
  assert.equal(ability.effect.kind, "conditional");
  assert.equal(ability.effect.effect.kind, "optional");
  const optionalSequence = ability.effect.effect.effect;
  assert.deepEqual(optionalSequence.effects.map((effect) => effect.kind), ["moveHandToZone", "sequence"]);
  assert.equal(optionalSequence.effects[0].filter.noTrigger, true);
  assert.deepEqual(optionalSequence.effects[1].effects.map((effect) => effect.kind), ["readySelf", "modifyBp"]);
});

test("opponent may sideline chosen targets else fallback events encode and resolve", () => {
  const eventEffect = encodeEgmanCardText({
    category: "Event",
    name: "Exciting Multiple-Choice Quiz",
    effect: "Choose one character on both your opponent's front line and energy line. Your opponent may sideline one of the chosen characters. If they do not, draw a card and switch up to one of your AP cards to active.",
    trigger: ""
  }).fields.eventEffect;
  assert.equal(eventEffect.kind, "opponentMaySidelineChosenTargetsElse");
  assert.deepEqual(eventEffect.elseEffect.effects.map((effect) => effect.kind), ["draw", "readyAp"]);

  const catalog = {
    ...sampleCatalog,
    private_quiz_event: {
      id: "private_quiz_event",
      number: "DEM-1-095",
      sourceCode: "DEM",
      name: "Private Quiz Event",
      type: CARD_TYPES.EVENT,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      affinities: [],
      eventEffect
    }
  };
  const makePermanent = (pid, owner, defId) => ({
    pid,
    owner,
    controller: owner,
    cards: [{ uid: `${pid}-card`, owner, defId, faceUp: true }],
    rested: false,
    bpDelta: 0,
    bpModifiers: [],
    keywordModifiers: [],
    energyModifiers: [],
    gainedAbilities: [],
    usedOncePerTurn: []
  });
  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game.players.P1.hand.unshift({ uid: "quiz-event-ref", owner: "P1", defId: "private_quiz_event", faceUp: true });
  game.players.P2.frontLine = [makePermanent("quiz-front", "P2", "demo_guardian")];
  game.players.P2.energyLine = [makePermanent("quiz-energy", "P2", "demo_rookie")];

  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0 });

  assert.equal(game.players.P2.frontLine.length, 1);
  assert.equal(game.players.P2.energyLine.length, 0);
  assert.ok(game.players.P2.sideline.some((card) => card.uid === "quiz-energy-card"));
});

test("encoded active triggers ready and boost only the selected character", () => {
  const activeTrigger = encodeEgmanCardText({
    name: "Private Trigger",
    category: "Character",
    effect: "",
    trigger: "[Active] Choose one character on your field and switch it to active. It gains 3000 BP until the end of the turn."
  }).fields.triggerEffect;

  const catalog = {
    ...sampleCatalog,
    private_active_trigger: {
      id: "private_active_trigger",
      number: "DEM-1-096",
      sourceCode: "DEM",
      name: "Private Active Trigger",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      trigger: activeTrigger
    }
  };

  const game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game.players.P1.life[0] = { uid: "active-life", owner: "P1", defId: "private_active_trigger", faceUp: false };
  game.players.P1.frontLine = ["demo_rookie", "demo_guardian"].map((defId, index) => ({
    pid: `active-target-${index}`,
    owner: "P1",
    controller: "P1",
    cards: [{ uid: `active-card-${index}`, owner: "P1", defId, faceUp: true }],
    rested: true,
    bpDelta: 0,
    bpModifiers: [],
    keywordModifiers: [],
    energyModifiers: [],
    attacksThisTurn: 0,
    blocksThisTurn: 0,
    usedOncePerTurn: []
  }));

  internals.dealDamage(game, "P1", 1, {
    sourcePlayer: "P2",
    lifeIndices: [0],
    triggerChoices: [{
      choices: {
        activeTarget: [{ player: "P1", lineName: LINES.FRONT, index: 1 }]
      }
    }]
  });

  assert.equal(game.players.P1.frontLine[0].rested, true);
  assert.equal(game.players.P1.frontLine[1].rested, false);
  assert.equal(internals.battlePower(game, game.players.P1.frontLine[1]), 6000);
});

test("static BP modifiers apply only during the controller turn", () => {
  const catalog = {
    ...sampleCatalog,
    private_static_body: {
      id: "private_static_body",
      number: "DEM-1-095",
      sourceCode: "DEM",
      name: "Private Static Body",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 2000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      staticModifiers: [{ bp: 1000, condition: { turn: "controller" } }]
    }
  };

  const game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  const permanent = {
    pid: "static-perm",
    owner: "P1",
    controller: "P1",
    cards: [{ uid: "static-card", owner: "P1", defId: "private_static_body", faceUp: true }],
    rested: false,
    bpDelta: 0,
    bpModifiers: [],
    keywordModifiers: [],
    energyModifiers: [],
    attacksThisTurn: 0,
    blocksThisTurn: 0,
    usedOncePerTurn: []
  };

  assert.equal(internals.battlePower(game, permanent), 3000);
  game.activePlayer = "P2";
  assert.equal(internals.battlePower(game, permanent), 2000);
});

test("EGM encoder handles conditional and scaling static BP modifiers", () => {
  const encoded = encodeEgmanCardText({
    name: "Private Static Scaling",
    category: "Character",
    effect: "[During Opponent's Turn] [If on the Front Line] If this character has a face-down card under it, this character gains 500 BP. This character gains 1000 BP for each resting character on your opponent's front line. If there are no other characters on your front line, this character gains 1000 BP.",
    trigger: ""
  }).fields;

  assert.deepEqual(encoded.staticModifiers[0], {
    bp: 500,
    condition: {
      allOf: [
        { turn: "opponent" },
        { line: LINES.FRONT },
        { hasFaceDownUnder: true }
      ]
    }
  });
  assert.deepEqual(encoded.staticModifiers[1], {
    bp: 1000,
    condition: {},
    amountPer: {
      kind: "fieldCount",
      controller: "opponent",
      line: LINES.FRONT,
      rested: true,
      filter: { type: CARD_TYPES.CHARACTER }
    }
  });
  assert.deepEqual(encoded.staticModifiers[2], {
    bp: 1000,
    condition: {
      frontLineCountMax: 0,
      otherThanSource: true,
      filter: { type: CARD_TYPES.CHARACTER }
    }
  });
});

test("EGM encoder handles richer static BP and energy conditions", () => {
  const encoded = encodeEgmanCardText({
    name: "Private Static Thresholds",
    category: "Character",
    effect: "If six or more other [Squad] affinity cards are on your field, this character gains 500 BP. If you have one or more [Tool] affinity cards or four or more event cards in your sideline, this character gains 1000 BP. [During Your Turn] This character gains 1000 BP if you have the same number or more characters on your front line than your opponent. [During Your Turn] This character loses 1000 BP. If you have no cards with [Trigger] abilities on your field, this character gains [Blue] energy generation.",
    trigger: ""
  }).fields;

  assert.deepEqual(encoded.staticModifiers[0], {
    bp: 500,
    condition: {
      fieldCountMin: 6,
      otherThanSource: true,
      filter: { affinity: "squad" }
    }
  });
  assert.deepEqual(encoded.staticModifiers[1], {
    bp: 1000,
    condition: {
      anyOf: [
        { zone: "sideline", zoneCountMin: 1, filter: { affinity: "tool" } },
        { zone: "sideline", zoneCountMin: 4, filter: { type: CARD_TYPES.EVENT } }
      ]
    }
  });
  assert.deepEqual(encoded.staticModifiers[2], {
    bp: 1000,
    condition: {
      allOf: [
        { turn: "controller" },
        { frontLineCountAtLeastOpponent: true, filter: { type: CARD_TYPES.CHARACTER } }
      ]
    }
  });
  assert.deepEqual(encoded.staticModifiers[3], {
    bp: -1000,
    condition: { turn: "controller" }
  });
  assert.deepEqual(encoded.staticEnergyModifiers, [{
    color: "blue",
    amount: 1,
    condition: {
      fieldCountMax: 0,
      filter: { withTrigger: true }
    }
  }]);
});

test("EGM encoder handles tiered static ability thresholds", () => {
  const pizza = encodeEgmanCardText({
    name: "C.C.",
    category: "Character",
    effect: "This character gains all abilities listed below if you have the required number of [Pizza] affinity cards in your sideline. ãƒ»Two or more: Play this character set to active onto your field. ãƒ»Four or more: [Impact (1)] ãƒ»Six or more: [During Your Turn] This character gains 1000 BP and [Double Attack] (When this character attacks for the first time this turn, switch it to active.)",
    trigger: ""
  }).fields;

  assert.equal(pizza.entersActive, undefined);
  assert.deepEqual(pizza.entersActiveCondition, {
    zone: "sideline",
    zoneCountMin: 2,
    filter: { affinity: "pizza" }
  });
  assert.deepEqual(pizza.staticModifiers, [{
    bp: 1000,
    condition: {
      allOf: [
        { zone: "sideline", zoneCountMin: 6, filter: { affinity: "pizza" } },
        { turn: "controller" }
      ]
    }
  }]);
  assert.deepEqual(pizza.staticKeywordModifiers, [
    {
      keyword: "impact",
      value: 1,
      condition: { zone: "sideline", zoneCountMin: 4, filter: { affinity: "pizza" } }
    },
    {
      keyword: "doubleAttack",
      value: true,
      condition: {
        allOf: [
          { zone: "sideline", zoneCountMin: 6, filter: { affinity: "pizza" } },
          { turn: "controller" }
        ]
      }
    }
  ]);

  const garou = encodeEgmanCardText({
    name: "Garou",
    category: "Character",
    effect: "This character gains all abilities listed below if you have the required number of cards in your sideline. ãƒ»5 or more: This character gains 500 BP. ãƒ»10 or more: This character gains 500 BP. ãƒ»15 or more: This character gains 500 BP. [When Played] You may pay 1 AP. If you do, choose up to one character on your opponent's front line with BP equal to or less than this character's BP and sideline it.",
    trigger: ""
  }).fields;
  assert.deepEqual(garou.staticModifiers, [
    { bp: 500, condition: { sidelineCountMin: 5 } },
    { bp: 500, condition: { sidelineCountMin: 10 } },
    { bp: 500, condition: { sidelineCountMin: 15 } }
  ]);

  const mikasa = encodeEgmanCardText({
    name: "Mikasa Ackermann",
    category: "Character",
    effect: "This character gains all abilities listed below if you have the required number of event cards in your sideline. ãƒ»Two or more: This character gains [Blue] energy generation. ãƒ»Four or more: This character gains 1000 BP.",
    trigger: ""
  }).fields;
  assert.deepEqual(mikasa.staticEnergyModifiers, [{
    color: "blue",
    amount: 1,
    condition: { zone: "sideline", zoneCountMin: 2, filter: { type: CARD_TYPES.EVENT } }
  }]);
  assert.deepEqual(mikasa.staticModifiers, [{
    bp: 1000,
    condition: { zone: "sideline", zoneCountMin: 4, filter: { type: CARD_TYPES.EVENT } }
  }]);

  const leorio = encodeEgmanCardText({
    name: "Leorio",
    category: "Character",
    effect: "This character gains all abilities listed below if you have the required number of cards with unique card names on your field from among the following: <Gon Freecss>, <Killua Zoldyck>, and <Kurapika>. ãƒ»One or more: This character generates energy even if it is on the front line. ãƒ»Three or more: [During Your Turn] This character gains 1000 BP.",
    trigger: ""
  }).fields;
  assert.deepEqual(leorio.staticKeywordModifiers, [{
    keyword: "frontLineEnergyGeneration",
    value: true,
    condition: {
      uniqueFieldNameCountMin: 1,
      filter: { anyOf: [{ name: "gon freecss" }, { name: "killua zoldyck" }, { name: "kurapika" }] }
    }
  }]);
  assert.deepEqual(leorio.staticModifiers, [{
    bp: 1000,
    condition: {
      allOf: [
        {
          uniqueFieldNameCountMin: 3,
          filter: { anyOf: [{ name: "gon freecss" }, { name: "killua zoldyck" }, { name: "kurapika" }] }
        },
        { turn: "controller" }
      ]
    }
  }]);
});

test("EGM encoder handles static field keyword protection auras", () => {
  const silverfang = encodeEgmanCardText({
    name: "Silverfang",
    category: "Character",
    effect: "[During Opponent's Turn] [If on the Front Line] [Hero] affinity cards on your field gain \"Your opponent cannot choose this character with abilities on characters or event cards unless they place one card from their hand into their sideline as an additional cost.\" This <Silverfang> ability does not stack.",
    trigger: ""
  }).fields;

  assert.deepEqual(silverfang.staticFieldKeywordModifiers, [{
    keyword: "targetingRestriction",
    value: {
      mode: "tax",
      sourceTypes: [CARD_TYPES.CHARACTER, CARD_TYPES.EVENT],
      payment: { kind: "handToSideline", amount: 1 },
      during: "opponentTurn"
    },
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
  }]);

  const kirito = encodeEgmanCardText({
    name: "Kirito",
    category: "Character",
    effect: "[During Opponent's Turn] Your opponent cannot choose this character with an ability on an event card unless they place one card from their hand into their sideline as an additional cost.",
    trigger: ""
  }).fields;
  assert.deepEqual(kirito.staticKeywordModifiers, [{
    keyword: "targetingRestriction",
    value: {
      mode: "tax",
      sourceTypes: [CARD_TYPES.EVENT],
      payment: { kind: "handToSideline", amount: 1 },
      during: "opponentTurn"
    },
    condition: { turn: "opponent" }
  }]);
});

test("EGM encoder handles self-sideline and under-card sideline costs", () => {
  const searchCost = encodeEgmanCardText({
    name: "Just Do What I Say",
    category: "Event",
    effect: "Sideline one character on your field. If you do, look at the top four cards of your deck. Reveal up to two [Missilis] affinity cards among them and add them to your hand. Place the remaining cards on the bottom of your deck in any order. Choose up to one of your AP cards and switch it to active.",
    trigger: ""
  }).fields;
  assert.equal(searchCost.eventEffect.kind, "sequence");
  assert.equal(searchCost.eventEffect.effects[0].kind, "sidelineTargets");
  assert.equal(searchCost.eventEffect.effects[1].kind, "sequence");
  assert.deepEqual(searchCost.eventEffect.effects[1].effects.map((effect) => effect.kind), ["searchTopDeck", "readyAp"]);

  const underCost = encodeEgmanCardText({
    name: "Yami Sukehiro",
    category: "Character",
    effect: "[When Played] You may place one face-down card under a character on your field into your sideline. If you do, draw a card.",
    trigger: ""
  }).fields;
  assert.equal(underCost.abilities[0].effect.kind, "optional");
  assert.deepEqual(underCost.abilities[0].effect.effect.effects.map((effect) => effect.kind), ["moveUnderCardsToZone", "draw"]);

  const kuguri = encodeEgmanCardText({
    name: "Kuguri",
    category: "Character",
    effect: "[When Attacking] Choose one of the following: ・Place the top card of your deck face down under this character. ・You may place all face-down cards under this character into your sideline. If you do, for each card placed into your sideline with this ability, this character gains 1000 BP until the end of the turn. If you place two or more cards into your sideline, this character also gains [Damage (2)] until the end of the turn.",
    trigger: ""
  }).fields;
  const secondChoice = kuguri.abilities[0].effect.choices[1].effect.effect;
  assert.deepEqual(secondChoice.effects.map((effect) => effect.kind), [
    "moveUnderCardsToZone",
    "modifyBpForLastMovedUnderCards",
    "conditional"
  ]);
});

test("EGM encoder reads static BP after keyword reminder text", () => {
  const encoded = encodeEgmanCardText({
    name: "Private Reminder Static",
    category: "Character",
    effect: "[Damage (2)] (When this character attacks and deals direct damage, deal 2 damage instead.) [During Your Turn] This character gains 1500 BP.",
    trigger: ""
  }).fields;

  assert.deepEqual(encoded.staticModifiers, [{ bp: 1500, condition: { turn: "controller" } }]);
});

test("static BP modifiers count matching permanents at runtime", () => {
  const catalog = {
    ...sampleCatalog,
    private_static_scaling: {
      id: "private_static_scaling",
      number: "DEM-1-096",
      sourceCode: "DEM",
      name: "Private Static Scaling",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 2000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      staticModifiers: [
        {
          bp: 500,
          condition: {},
          amountPer: {
            kind: "fieldCount",
            controller: "opponent",
            line: LINES.FRONT,
            rested: true,
            filter: { type: CARD_TYPES.CHARACTER }
          }
        },
        {
          bp: 1000,
          condition: {
            frontLineCountMax: 0,
            otherThanSource: true,
            filter: { type: CARD_TYPES.CHARACTER }
          }
        }
      ]
    },
    private_static_conditions: {
      id: "private_static_conditions",
      number: "DEM-1-095",
      sourceCode: "DEM",
      name: "Private Static Conditions",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 2000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      staticModifiers: [
        {
          bp: 500,
          condition: { frontLineCountAtLeastOpponent: true, filter: { type: CARD_TYPES.CHARACTER } }
        },
        {
          bp: 700,
          condition: {
            sameLineCountMin: 1,
            otherThanSource: true,
            filter: { type: CARD_TYPES.CHARACTER, requiredEnergyMin: 2, requiredEnergyMax: 2 }
          }
        },
        {
          bp: -200,
          condition: { fieldCountMax: 0, filter: { withTrigger: true } }
        }
      ]
    },
    private_vanilla_runtime: {
      id: "private_vanilla_runtime",
      number: "DEM-1-094",
      sourceCode: "DEM",
      name: "Private Vanilla Runtime",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
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
  const permanent = (pid, player, defId, rested = false) => ({
    pid,
    owner: player,
    controller: player,
    cards: [{ uid: `${pid}-card`, owner: player, defId, faceUp: true }],
    rested,
    bpDelta: 0,
    bpModifiers: [],
    keywordModifiers: [],
    energyModifiers: [],
    attacksThisTurn: 0,
    blocksThisTurn: 0,
    usedOncePerTurn: []
  });
  const scaling = permanent("scaling", "P1", "private_static_scaling");
  game.players.P1.frontLine = [scaling];
  game.players.P2.frontLine = [
    permanent("opp-rested-1", "P2", "private_vanilla_runtime", true),
    permanent("opp-rested-2", "P2", "private_vanilla_runtime", true),
    permanent("opp-active", "P2", "private_vanilla_runtime", false)
  ];

  assert.equal(internals.battlePower(game, scaling), 4000);
  game.players.P1.frontLine.push(permanent("ally", "P1", "private_vanilla_runtime"));
  assert.equal(internals.battlePower(game, scaling), 3000);

  const conditioned = permanent("conditioned", "P1", "private_static_conditions");
  game.players.P1.frontLine = [
    conditioned,
    permanent("same-line-required-energy", "P1", "demo_large_body"),
    permanent("front-count-extra", "P1", "demo_rookie")
  ];
  game.players.P2.frontLine = [
    permanent("opp-count-1", "P2", "demo_rookie"),
    permanent("opp-count-2", "P2", "demo_rookie")
  ];
  assert.equal(internals.battlePower(game, conditioned), 3000);

  game.players.P1.energyLine = [permanent("trigger-on-field", "P1", "demo_get_trigger")];
  assert.equal(internals.battlePower(game, conditioned), 3200);

  game.players.P2.frontLine.push(permanent("opp-count-3", "P2", "demo_rookie"));
  game.players.P2.frontLine.push(permanent("opp-count-4", "P2", "demo_rookie"));
  assert.equal(internals.battlePower(game, conditioned), 2700);
});

test("static field BP auras apply to matching allied characters", () => {
  const auraFields = encodeEgmanCardText({
    name: "Asta",
    category: "Character",
    effect: "[During Your Turn] If <Yuno> is on your field, all characters on your field gain 500 BP.",
    trigger: ""
  }).fields;
  const catalog = {
    ...sampleCatalog,
    private_aura_asta: {
      id: "private_aura_asta",
      number: "DEM-1-156",
      sourceCode: "DEM",
      name: "Asta",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 2000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      ...auraFields
    },
    private_yuno: {
      id: "private_yuno",
      number: "DEM-1-157",
      sourceCode: "DEM",
      name: "Yuno",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1500,
      energy: [{ color: "green", amount: 1 }],
      affinities: []
    },
    private_ally: {
      id: "private_ally",
      number: "DEM-1-158",
      sourceCode: "DEM",
      name: "Private Ally",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: []
    }
  };
  const permanent = (pid, defId) => ({
    pid,
    owner: "P1",
    controller: "P1",
    cards: [{ uid: `${pid}-card`, owner: "P1", defId, faceUp: true }],
    rested: false,
    bpDelta: 0,
    bpModifiers: [],
    keywordModifiers: [],
    energyModifiers: [],
    attacksThisTurn: 0,
    blocksThisTurn: 0,
    usedOncePerTurn: []
  });
  const game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  const asta = permanent("asta", "private_aura_asta");
  const yuno = permanent("yuno", "private_yuno");
  const ally = permanent("ally", "private_ally");
  game.players.P1.frontLine = [asta, yuno, ally];

  assert.equal(internals.battlePower(game, ally), 1500);
  game.activePlayer = "P2";
  assert.equal(internals.battlePower(game, ally), 1000);
});

test("tiered static thresholds affect runtime power, energy, keywords, and active entry", () => {
  const garouFields = encodeEgmanCardText({
    name: "Garou",
    category: "Character",
    effect: "This character gains all abilities listed below if you have the required number of cards in your sideline. ãƒ»5 or more: This character gains 500 BP. ãƒ»10 or more: This character gains 500 BP. ãƒ»15 or more: This character gains 500 BP.",
    trigger: ""
  }).fields;
  const mikasaFields = encodeEgmanCardText({
    name: "Mikasa Ackermann",
    category: "Character",
    effect: "This character gains all abilities listed below if you have the required number of event cards in your sideline. ãƒ»Two or more: This character gains [Blue] energy generation. ãƒ»Four or more: This character gains 1000 BP.",
    trigger: ""
  }).fields;
  const leorioFields = encodeEgmanCardText({
    name: "Leorio",
    category: "Character",
    effect: "This character gains all abilities listed below if you have the required number of cards with unique card names on your field from among the following: <Gon Freecss>, <Killua Zoldyck>, and <Kurapika>. ãƒ»One or more: This character generates energy even if it is on the front line. ãƒ»Three or more: [During Your Turn] This character gains 1000 BP.",
    trigger: ""
  }).fields;
  const ccFields = encodeEgmanCardText({
    name: "C.C.",
    category: "Character",
    effect: "This character gains all abilities listed below if you have the required number of [Pizza] affinity cards in your sideline. ãƒ»Two or more: Play this character set to active onto your field.",
    trigger: ""
  }).fields;
  const catalog = {
    ...sampleCatalog,
    private_garou: {
      id: "private_garou",
      number: "DEM-1-130",
      sourceCode: "DEM",
      name: "Garou",
      type: CARD_TYPES.CHARACTER,
      color: "red",
      requiredEnergy: { color: "red", amount: 0 },
      apCost: 0,
      bp: 2500,
      energy: [{ color: "red", amount: 1 }],
      affinities: [],
      ...garouFields
    },
    private_mikasa: {
      id: "private_mikasa",
      number: "DEM-1-131",
      sourceCode: "DEM",
      name: "Mikasa Ackermann",
      type: CARD_TYPES.CHARACTER,
      color: "blue",
      requiredEnergy: { color: "blue", amount: 0 },
      apCost: 0,
      bp: 2000,
      energy: [{ color: "blue", amount: 1 }],
      affinities: [],
      ...mikasaFields
    },
    private_leorio: {
      id: "private_leorio",
      number: "DEM-1-132",
      sourceCode: "DEM",
      name: "Leorio",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 3000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      ...leorioFields
    },
    private_cc: {
      id: "private_cc",
      number: "DEM-1-133",
      sourceCode: "DEM",
      name: "C.C.",
      type: CARD_TYPES.CHARACTER,
      color: "red",
      requiredEnergy: { color: "red", amount: 0 },
      apCost: 0,
      bp: 2500,
      energy: [{ color: "red", amount: 1 }],
      affinities: [],
      ...ccFields
    },
    private_event: {
      id: "private_event",
      number: "DEM-1-134",
      sourceCode: "DEM",
      name: "Private Event",
      type: CARD_TYPES.EVENT,
      color: "blue",
      requiredEnergy: { color: "blue", amount: 0 },
      apCost: 0,
      affinities: []
    },
    private_pizza: {
      id: "private_pizza",
      number: "DEM-1-135",
      sourceCode: "DEM",
      name: "Private Pizza",
      type: CARD_TYPES.CHARACTER,
      color: "red",
      requiredEnergy: { color: "red", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "red", amount: 1 }],
      affinities: ["pizza"]
    },
    private_gon: {
      id: "private_gon",
      number: "DEM-1-136",
      sourceCode: "DEM",
      name: "Gon Freecss",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: []
    },
    private_killua: {
      id: "private_killua",
      number: "DEM-1-137",
      sourceCode: "DEM",
      name: "Killua Zoldyck",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: []
    },
    private_kurapika: {
      id: "private_kurapika",
      number: "DEM-1-138",
      sourceCode: "DEM",
      name: "Kurapika",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: []
    }
  };
  const permanent = (pid, player, defId) => ({
    pid,
    owner: player,
    controller: player,
    cards: [{ uid: `${pid}-card`, owner: player, defId, faceUp: true }],
    rested: false,
    bpDelta: 0,
    bpModifiers: [],
    keywordModifiers: [],
    energyModifiers: [],
    attacksThisTurn: 0,
    blocksThisTurn: 0,
    usedOncePerTurn: []
  });
  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });

  const garou = permanent("garou", "P1", "private_garou");
  game.players.P1.frontLine = [garou];
  game.players.P1.sideline = Array.from({ length: 10 }, (_, index) => ({
    uid: `sideline-${index}`,
    owner: "P1",
    defId: index < 4 ? "private_event" : "demo_rookie",
    faceUp: true
  }));
  assert.equal(internals.battlePower(game, garou), 3500);

  const mikasa = permanent("mikasa", "P1", "private_mikasa");
  game.players.P1.frontLine = [mikasa];
  assert.equal(internals.battlePower(game, mikasa), 3000);
  game.players.P1.energyLine = [mikasa];
  assert.equal(internals.energyAvailable(game, "P1").blue, 2);

  const leorio = permanent("leorio", "P1", "private_leorio");
  game.players.P1.frontLine = [
    leorio,
    permanent("gon", "P1", "private_gon"),
    permanent("killua", "P1", "private_killua"),
    permanent("kurapika", "P1", "private_kurapika")
  ];
  game.players.P1.energyLine = [];
  assert.equal(internals.energyAvailable(game, "P1").green, 1);
  assert.equal(internals.battlePower(game, leorio), 4000);

  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game.players.P1.frontLine = [];
  game.players.P1.energyLine = [];
  game.players.P1.sideline = [
    { uid: "pizza-1", owner: "P1", defId: "private_pizza", faceUp: true },
    { uid: "pizza-2", owner: "P1", defId: "private_pizza", faceUp: true }
  ];
  game.players.P1.hand.unshift({ uid: "cc-card", owner: "P1", defId: "private_cc", faceUp: true });
  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0, destination: LINES.FRONT });
  assert.equal(game.players.P1.frontLine[0].rested, false);
});

test("turn-history static conditions track events, played triggers, and sidelined characters", () => {
  const catalog = {
    ...sampleCatalog,
    private_event_watcher: {
      id: "private_event_watcher",
      number: "DEM-1-139",
      sourceCode: "DEM",
      name: "Private Event Watcher",
      type: CARD_TYPES.CHARACTER,
      color: "purple",
      requiredEnergy: { color: "purple", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "purple", amount: 1 }],
      affinities: [],
      staticEnergyModifiers: [{ color: "purple", amount: 1, condition: { eventUsedThisTurn: "self" } }]
    },
    private_get_watcher: {
      id: "private_get_watcher",
      number: "DEM-1-140",
      sourceCode: "DEM",
      name: "Private Get Watcher",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      staticModifiers: [{ bp: 1000, condition: { playedCharacterWithTriggerTypeThisTurn: "get" } }]
    },
    private_sidelined_watcher: {
      id: "private_sidelined_watcher",
      number: "DEM-1-141",
      sourceCode: "DEM",
      name: "Private Sidelined Watcher",
      type: CARD_TYPES.CHARACTER,
      color: "yellow",
      requiredEnergy: { color: "yellow", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "yellow", amount: 1 }],
      affinities: [],
      staticEnergyModifiers: [{ color: "yellow", amount: 1, condition: { characterSidelinedThisTurn: "self" } }]
    },
    private_get_character: {
      id: "private_get_character",
      number: "DEM-1-142",
      sourceCode: "DEM",
      name: "Private Get Character",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      trigger: { type: "get" }
    },
    private_sideline_event: {
      id: "private_sideline_event",
      number: "DEM-1-143",
      sourceCode: "DEM",
      name: "Private Sideline Event",
      type: CARD_TYPES.EVENT,
      color: "purple",
      requiredEnergy: { color: "purple", amount: 0 },
      apCost: 0,
      affinities: [],
      eventEffect: {
        kind: "sidelineTargets",
        target: { controller: "self", line: LINES.FRONT, type: CARD_TYPES.CHARACTER, max: 1 }
      }
    },
    private_blank_event: {
      id: "private_blank_event",
      number: "DEM-1-144",
      sourceCode: "DEM",
      name: "Private Blank Event",
      type: CARD_TYPES.EVENT,
      color: "purple",
      requiredEnergy: { color: "purple", amount: 0 },
      apCost: 0,
      affinities: [],
      eventEffect: { kind: "none" }
    }
  };
  const permanent = (pid, player, defId) => ({
    pid,
    owner: player,
    controller: player,
    cards: [{ uid: `${pid}-card`, owner: player, defId, faceUp: true }],
    rested: false,
    bpDelta: 0,
    bpModifiers: [],
    keywordModifiers: [],
    energyModifiers: [],
    attacksThisTurn: 0,
    blocksThisTurn: 0,
    usedOncePerTurn: []
  });

  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });

  const eventWatcher = permanent("event-watcher", "P1", "private_event_watcher");
  const getWatcher = permanent("get-watcher", "P1", "private_get_watcher");
  const sidelinedWatcher = permanent("sidelined-watcher", "P1", "private_sidelined_watcher");
  game.players.P1.energyLine = [eventWatcher, sidelinedWatcher];
  game.players.P1.frontLine = [getWatcher, permanent("sideline-target", "P1", "demo_rookie")];
  assert.equal(internals.energyAvailable(game, "P1").purple, 1);
  assert.equal(internals.battlePower(game, getWatcher), 1000);
  assert.equal(internals.energyAvailable(game, "P1").yellow, 1);

  game.players.P1.hand.unshift({ uid: "blank-event", owner: "P1", defId: "private_blank_event", faceUp: true });
  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0 });
  assert.equal(internals.energyAvailable(game, "P1").purple, 2);

  game.players.P1.hand.unshift({ uid: "get-character", owner: "P1", defId: "private_get_character", faceUp: true });
  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0, destination: LINES.ENERGY });
  assert.equal(internals.battlePower(game, getWatcher), 2000);

  game.players.P1.hand.unshift({ uid: "sideline-event", owner: "P1", defId: "private_sideline_event", faceUp: true });
  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0 });
  assert.equal(internals.energyAvailable(game, "P1").yellow, 2);
});

test("hand-to-sideline zone triggers fire from ability costs and effects", () => {
  const rukaFields = encodeEgmanCardText({
    name: "Ruka Rengoku",
    category: "Character",
    effect: "When this card is placed from your hand into your sideline with an ability on one of your event or <Kyojuro Rengoku> cards, draw a card.",
    trigger: ""
  }).fields;
  const rapunzelFields = encodeEgmanCardText({
    name: "Rapunzel",
    category: "Character",
    effect: "When this card is placed from your hand into your sideline, if you have a purple card on your field and two or less remaining cards in your hand, choose up to one [Pioneer] affinity card on your field and switch it to active.",
    trigger: ""
  }).fields;
  const catalog = {
    ...sampleCatalog,
    private_ruka: {
      id: "private_ruka",
      number: "DEM-1-145",
      sourceCode: "DEM",
      name: "Ruka Rengoku",
      type: CARD_TYPES.CHARACTER,
      color: "red",
      requiredEnergy: { color: "red", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "red", amount: 1 }],
      affinities: [],
      ...rukaFields
    },
    private_rapunzel: {
      id: "private_rapunzel",
      number: "DEM-1-146",
      sourceCode: "DEM",
      name: "Rapunzel",
      type: CARD_TYPES.CHARACTER,
      color: "purple",
      requiredEnergy: { color: "purple", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "purple", amount: 1 }],
      affinities: [],
      ...rapunzelFields
    },
    private_pioneer: {
      id: "private_pioneer",
      number: "DEM-1-147",
      sourceCode: "DEM",
      name: "Private Pioneer",
      type: CARD_TYPES.CHARACTER,
      color: "purple",
      requiredEnergy: { color: "purple", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "purple", amount: 1 }],
      affinities: ["pioneer"]
    },
    private_move_hand_event: {
      id: "private_move_hand_event",
      number: "DEM-1-148",
      sourceCode: "DEM",
      name: "Private Move Hand Event",
      type: CARD_TYPES.EVENT,
      color: "purple",
      requiredEnergy: { color: "purple", amount: 0 },
      apCost: 0,
      affinities: [],
      eventEffect: { kind: "moveHandToZone", amount: 1, destination: "sideline" }
    }
  };
  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game.players.P1.hand.unshift(
    { uid: "move-event", owner: "P1", defId: "private_move_hand_event", faceUp: true },
    { uid: "ruka-card", owner: "P1", defId: "private_ruka", faceUp: true }
  );
  const deckCountBefore = game.players.P1.deck.length;
  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0 });
  assert.ok(game.players.P1.sideline.some((card) => card.defId === "private_ruka"));
  assert.equal(game.players.P1.deck.length, deckCountBefore - 1);

  game.players.P1.hand = [
    { uid: "move-event-2", owner: "P1", defId: "private_move_hand_event", faceUp: true },
    { uid: "rapunzel-card", owner: "P1", defId: "private_rapunzel", faceUp: true }
  ];
  const pioneer = {
    pid: "pioneer",
    owner: "P1",
    controller: "P1",
    cards: [{ uid: "pioneer-card", owner: "P1", defId: "private_pioneer", faceUp: true }],
    rested: true,
    bpDelta: 0,
    bpModifiers: [],
    keywordModifiers: [],
    energyModifiers: [],
    attacksThisTurn: 0,
    blocksThisTurn: 0,
    usedOncePerTurn: []
  };
  game.players.P1.frontLine = [pioneer];
  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0 });
  assert.equal(game.players.P1.frontLine[0].rested, false);
});

test("field watchers react when opposing front-line characters are sidelined", () => {
  const genyaFields = encodeEgmanCardText({
    name: "Genya Shinazugawa",
    category: "Character",
    effect: "[During Your Turn] [Once Per Turn] When a character on your opponent's front line is sidelined, you may draw a card. If you do, place one card from your hand into your sideline.",
    trigger: ""
  }).fields;
  const catalog = {
    ...sampleCatalog,
    private_genya: {
      id: "private_genya",
      number: "DEM-1-149",
      sourceCode: "DEM",
      name: "Genya Shinazugawa",
      type: CARD_TYPES.CHARACTER,
      color: "red",
      requiredEnergy: { color: "red", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "red", amount: 1 }],
      affinities: [],
      ...genyaFields
    },
    private_sideline_opp_event: {
      id: "private_sideline_opp_event",
      number: "DEM-1-150",
      sourceCode: "DEM",
      name: "Private Sideline Opponent Event",
      type: CARD_TYPES.EVENT,
      color: "red",
      requiredEnergy: { color: "red", amount: 0 },
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
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game.players.P1.frontLine = [{
    pid: "genya",
    owner: "P1",
    controller: "P1",
    cards: [{ uid: "genya-card", owner: "P1", defId: "private_genya", faceUp: true }],
    rested: false,
    bpDelta: 0,
    bpModifiers: [],
    keywordModifiers: [],
    energyModifiers: [],
    attacksThisTurn: 0,
    blocksThisTurn: 0,
    usedOncePerTurn: []
  }];
  game.players.P2.frontLine = [{
    pid: "opponent-target",
    owner: "P2",
    controller: "P2",
    cards: [{ uid: "opponent-target-card", owner: "P2", defId: "demo_rookie", faceUp: true }],
    rested: false,
    bpDelta: 0,
    bpModifiers: [],
    keywordModifiers: [],
    energyModifiers: [],
    attacksThisTurn: 0,
    blocksThisTurn: 0,
    usedOncePerTurn: []
  }];
  game.players.P1.hand.unshift({ uid: "sideline-opp-event", owner: "P1", defId: "private_sideline_opp_event", faceUp: true });
  const deckCountBefore = game.players.P1.deck.length;
  const sidelineCountBefore = game.players.P1.sideline.length;
  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0 });

  assert.equal(game.players.P2.frontLine.length, 0);
  assert.equal(game.players.P1.deck.length, deckCountBefore - 1);
  assert.equal(game.players.P1.sideline.length, sidelineCountBefore + 2);
});

test("returned-to-hand triggers resolve after the source leaves the field", () => {
  const arminFields = encodeEgmanCardText({
    name: "Armin Arlelt",
    category: "Character",
    effect: "When this character is returned to your hand from your field, you may place one red <Armin Arlelt> card with 1 required energy from your hand into your sideline. If you do, draw two cards, then place one card from your hand into your sideline.",
    trigger: ""
  }).fields;
  const catalog = {
    ...sampleCatalog,
    private_return_armin: {
      id: "private_return_armin",
      number: "DEM-1-151",
      sourceCode: "DEM",
      name: "Armin Arlelt",
      type: CARD_TYPES.CHARACTER,
      color: "red",
      requiredEnergy: { color: "red", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "red", amount: 1 }],
      affinities: [],
      ...arminFields
    },
    private_cost_armin: {
      id: "private_cost_armin",
      number: "DEM-1-152",
      sourceCode: "DEM",
      name: "Armin Arlelt",
      type: CARD_TYPES.CHARACTER,
      color: "red",
      requiredEnergy: { color: "red", amount: 1 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "red", amount: 1 }],
      affinities: []
    },
    private_return_event: {
      id: "private_return_event",
      number: "DEM-1-153",
      sourceCode: "DEM",
      name: "Private Return Event",
      type: CARD_TYPES.EVENT,
      color: "red",
      requiredEnergy: { color: "red", amount: 0 },
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
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game.players.P1.frontLine = [{
    pid: "return-armin",
    owner: "P1",
    controller: "P1",
    cards: [{ uid: "return-armin-card", owner: "P1", defId: "private_return_armin", faceUp: true }],
    rested: false,
    bpDelta: 0,
    bpModifiers: [],
    keywordModifiers: [],
    energyModifiers: [],
    attacksThisTurn: 0,
    blocksThisTurn: 0,
    usedOncePerTurn: []
  }];
  game.players.P1.hand.unshift(
    { uid: "return-event", owner: "P1", defId: "private_return_event", faceUp: true },
    { uid: "cost-armin", owner: "P1", defId: "private_cost_armin", faceUp: true }
  );
  const deckCountBefore = game.players.P1.deck.length;
  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0 });

  assert.equal(game.players.P1.frontLine.length, 0);
  assert.ok(game.players.P1.hand.some((card) => card.defId === "private_return_armin"));
  assert.ok(game.players.P1.sideline.some((card) => card.defId === "private_cost_armin"));
  assert.equal(game.players.P1.deck.length, deckCountBefore - 2);
});

test("start-of-turn raided-stack abilities move the top card and draw", () => {
  const genkaiFields = encodeEgmanCardText({
    name: "Genkai",
    category: "Character",
    effect: "At the start of your turn, place the top card from this Raided character into your sideline, then draw a card.",
    trigger: ""
  }).fields;
  const catalog = {
    ...sampleCatalog,
    private_base_genkai: {
      id: "private_base_genkai",
      number: "DEM-1-154",
      sourceCode: "DEM",
      name: "Genkai",
      type: CARD_TYPES.CHARACTER,
      color: "blue",
      requiredEnergy: { color: "blue", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "blue", amount: 1 }],
      affinities: []
    },
    private_raid_genkai: {
      id: "private_raid_genkai",
      number: "DEM-1-155",
      sourceCode: "DEM",
      name: "Genkai",
      type: CARD_TYPES.CHARACTER,
      color: "blue",
      requiredEnergy: { color: "blue", amount: 0 },
      apCost: 0,
      bp: 3000,
      energy: [{ color: "blue", amount: 1 }],
      affinities: [],
      ...genkaiFields
    }
  };
  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game.players.P1.frontLine = [{
    pid: "genkai-stack",
    owner: "P1",
    controller: "P1",
    cards: [
      { uid: "base-genkai-card", owner: "P1", defId: "private_base_genkai", faceUp: true },
      { uid: "raid-genkai-card", owner: "P1", defId: "private_raid_genkai", faceUp: true }
    ],
    rested: false,
    bpDelta: 0,
    bpModifiers: [],
    keywordModifiers: [],
    energyModifiers: [],
    attacksThisTurn: 0,
    blocksThisTurn: 0,
    usedOncePerTurn: []
  }];
  game.activePlayer = "P2";
  game.phase = PHASES.END;
  const deckCountBefore = game.players.P1.deck.length;
  game = applyAction(game, { type: "advancePhase", player: "P2" });

  assert.equal(game.activePlayer, "P1");
  assert.equal(game.players.P1.frontLine[0].cards.length, 1);
  assert.ok(game.players.P1.sideline.some((card) => card.defId === "private_raid_genkai"));
  assert.equal(game.players.P1.deck.length, deckCountBefore - 2);
});

test("base-card when-raided abilities resolve after Raid is performed", () => {
  const asukaFields = encodeEgmanCardText({
    name: "Asuka Shikinami Langley",
    category: "Character",
    effect: "When this character is Raided, choose one of the following. (Resolve the Raided character's [When Played] abilities and this ability in any order.) ãƒ»Draw a card. ãƒ»Choose up to one character on your opponent's front line. It loses 1000 BP until the end of the turn.",
    trigger: ""
  }).fields;
  const catalog = {
    ...sampleCatalog,
    private_base_asuka: {
      id: "private_base_asuka",
      number: "DEM-1-159",
      sourceCode: "DEM",
      name: "Asuka Shikinami Langley",
      type: CARD_TYPES.CHARACTER,
      color: "purple",
      requiredEnergy: { color: "purple", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "purple", amount: 1 }],
      affinities: [],
      ...asukaFields
    },
    private_raid_asuka: {
      id: "private_raid_asuka",
      number: "DEM-1-160",
      sourceCode: "DEM",
      name: "Asuka Shikinami Langley",
      type: CARD_TYPES.CHARACTER,
      color: "purple",
      requiredEnergy: { color: "purple", amount: 0 },
      apCost: 0,
      bp: 3000,
      energy: [{ color: "purple", amount: 1 }],
      affinities: [],
      raid: { names: ["Asuka Shikinami Langley"], affinities: [] }
    }
  };
  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game.players.P1.frontLine = [{
    pid: "asuka-base",
    owner: "P1",
    controller: "P1",
    cards: [{ uid: "asuka-base-card", owner: "P1", defId: "private_base_asuka", faceUp: true }],
    rested: true,
    bpDelta: 0,
    bpModifiers: [],
    keywordModifiers: [],
    energyModifiers: [],
    attacksThisTurn: 0,
    blocksThisTurn: 0,
    usedOncePerTurn: []
  }];
  game.players.P1.hand.unshift({ uid: "asuka-raid-card", owner: "P1", defId: "private_raid_asuka", faceUp: true });
  const deckCountBefore = game.players.P1.deck.length;
  game = applyAction(game, { type: "performRaid", player: "P1", handIndex: 0, targetLine: LINES.FRONT, targetIndex: 0 });

  assert.equal(game.players.P1.frontLine[0].cards.length, 2);
  assert.equal(game.players.P1.frontLine[0].rested, false);
  assert.equal(game.players.P1.deck.length, deckCountBefore - 1);
});

test("when-blocking conditions can inspect the attacking character keywords", () => {
  const blockerFields = encodeEgmanCardText({
    name: "Razor",
    category: "Character",
    effect: "[When Blocking] If your opponent's attacking character has [Impact] , this character gains 2000 BP until the end of the turn.",
    trigger: ""
  }).fields;
  const catalog = {
    ...sampleCatalog,
    private_impact_attacker: {
      id: "private_impact_attacker",
      number: "DEM-1-161",
      sourceCode: "DEM",
      name: "Private Impact Attacker",
      type: CARD_TYPES.CHARACTER,
      color: "red",
      requiredEnergy: { color: "red", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "red", amount: 1 }],
      affinities: [],
      keywords: { impact: 1 }
    },
    private_razor_blocker: {
      id: "private_razor_blocker",
      number: "DEM-1-162",
      sourceCode: "DEM",
      name: "Razor",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      ...blockerFields
    }
  };
  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game.players.P1.frontLine = [{
    pid: "impact-attacker",
    owner: "P1",
    controller: "P1",
    cards: [{ uid: "impact-attacker-card", owner: "P1", defId: "private_impact_attacker", faceUp: true }],
    rested: false,
    bpDelta: 0,
    bpModifiers: [],
    keywordModifiers: [],
    energyModifiers: [],
    attacksThisTurn: 0,
    blocksThisTurn: 0,
    usedOncePerTurn: []
  }];
  game.players.P2.frontLine = [{
    pid: "razor-blocker",
    owner: "P2",
    controller: "P2",
    cards: [{ uid: "razor-blocker-card", owner: "P2", defId: "private_razor_blocker", faceUp: true }],
    rested: false,
    bpDelta: 0,
    bpModifiers: [],
    keywordModifiers: [],
    energyModifiers: [],
    attacksThisTurn: 0,
    blocksThisTurn: 0,
    usedOncePerTurn: []
  }];
  game = applyAction(game, { type: "declareAttack", player: "P1", attackerIndex: 0 });
  game = applyAction(game, { type: "declareBlock", player: "P2", blockerIndex: 0 });

  assert.equal(internals.battlePower(game, game.players.P2.frontLine[0]), 3000);
});

test("multi-target clauses move your character and rest the opponent's target separately", () => {
  const genkaiFields = encodeEgmanCardText({
    name: "Genkai",
    category: "Character",
    effect: "[When Played] Choose up to one character on your field and move it to the other line, then choose up to one character with 3500 or less BP on your opponent's front line and switch it to resting.",
    trigger: ""
  }).fields;
  const catalog = {
    ...sampleCatalog,
    private_genkai_multi: {
      id: "private_genkai_multi",
      number: "DEM-1-163",
      sourceCode: "DEM",
      name: "Genkai",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 4500,
      energy: [{ color: "green", amount: 1 }],
      affinities: [],
      ...genkaiFields
    },
    private_own_move_target: {
      id: "private_own_move_target",
      number: "DEM-1-164",
      sourceCode: "DEM",
      name: "Private Move Target",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: []
    },
    private_rest_target: {
      id: "private_rest_target",
      number: "DEM-1-165",
      sourceCode: "DEM",
      name: "Private Rest Target",
      type: CARD_TYPES.CHARACTER,
      color: "red",
      requiredEnergy: { color: "red", amount: 0 },
      apCost: 0,
      bp: 3500,
      energy: [{ color: "red", amount: 1 }],
      affinities: []
    }
  };
  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game.players.P1.frontLine = [testPermanent("own-move-target", "P1", "private_own_move_target")];
  game.players.P2.frontLine = [testPermanent("rest-target", "P2", "private_rest_target")];
  game.players.P1.hand.unshift({ uid: "genkai-multi-card", owner: "P1", defId: "private_genkai_multi", faceUp: true });

  game = applyAction(game, {
    type: "playCard",
    player: "P1",
    handIndex: 0,
    destination: LINES.FRONT
  });

  assert.equal(game.players.P1.frontLine.some((permanent) => permanent.pid === "own-move-target"), false);
  assert.equal(game.players.P1.energyLine.some((permanent) => permanent.pid === "own-move-target"), true);
  assert.equal(game.players.P2.frontLine[0].rested, true);
});

test("optional instead branches replace the base action after paying their hand cost", () => {
  const shizukaFields = encodeEgmanCardText({
    name: "Shizuka Yoshimoto",
    category: "Character",
    effect: "[When Played] Choose up to one character with 4 or more required energy on your opponent's front line and {switch it to resting}. If there are four or more other characters on your field with 3 or less required energy, you may place one card from your hand into your sideline. If you do, {return it to their hand} instead.",
    trigger: ""
  }).fields;
  const catalog = {
    ...sampleCatalog,
    private_shizuka_instead: {
      id: "private_shizuka_instead",
      number: "DEM-1-166",
      sourceCode: "DEM",
      name: "Shizuka Yoshimoto",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 3 },
      apCost: 1,
      bp: 3500,
      energy: [{ color: "green", amount: 3 }],
      affinities: [],
      ...shizukaFields
    },
    private_low_energy_friend: {
      id: "private_low_energy_friend",
      number: "DEM-1-167",
      sourceCode: "DEM",
      name: "Private Low Energy Friend",
      type: CARD_TYPES.CHARACTER,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "green", amount: 1 }],
      affinities: []
    },
    private_big_target: {
      id: "private_big_target",
      number: "DEM-1-168",
      sourceCode: "DEM",
      name: "Private Big Target",
      type: CARD_TYPES.CHARACTER,
      color: "red",
      requiredEnergy: { color: "red", amount: 4 },
      apCost: 1,
      bp: 4000,
      energy: [{ color: "red", amount: 1 }],
      affinities: []
    }
  };
  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game.players.P1.energyLine = [
    testPermanent("friend-1", "P1", "private_low_energy_friend"),
    testPermanent("friend-2", "P1", "private_low_energy_friend"),
    testPermanent("friend-3", "P1", "private_low_energy_friend"),
    testPermanent("friend-4", "P1", "private_low_energy_friend")
  ];
  game.players.P2.frontLine = [testPermanent("big-target", "P2", "private_big_target")];
  game.players.P1.hand.unshift(
    { uid: "shizuka-instead-card", owner: "P1", defId: "private_shizuka_instead", faceUp: true },
    { uid: "spare-cost-card", owner: "P1", defId: "private_low_energy_friend", faceUp: true }
  );

  game = applyAction(game, {
    type: "playCard",
    player: "P1",
    handIndex: 0,
    destination: LINES.FRONT
  });

  assert.equal(game.players.P2.frontLine.length, 0);
  assert.equal(game.players.P2.hand.some((card) => card.defId === "private_big_target"), true);
  assert.equal(game.players.P1.sideline.some((card) => card.uid === "spare-cost-card"), true);
});

test("played-by-ability characters can be scheduled for start-of-end cleanup", () => {
  const shalnarkFields = encodeEgmanCardText({
    name: "Shalnark",
    category: "Character",
    effect: "[When Played] Play up to one character card with 3 or less required energy and 1 AP cost from your sideline set to resting onto your front line. At the start of the end phase, sideline that character.",
    trigger: ""
  }).fields;
  const catalog = {
    ...sampleCatalog,
    private_shalnark_cleanup: {
      id: "private_shalnark_cleanup",
      number: "DEM-1-169",
      sourceCode: "DEM",
      name: "Shalnark",
      type: CARD_TYPES.CHARACTER,
      color: "yellow",
      requiredEnergy: { color: "yellow", amount: 0 },
      apCost: 0,
      bp: 1500,
      energy: [{ color: "yellow", amount: 1 }],
      affinities: [],
      ...shalnarkFields
    },
    private_cleanup_target: {
      id: "private_cleanup_target",
      number: "DEM-1-170",
      sourceCode: "DEM",
      name: "Private Cleanup Target",
      type: CARD_TYPES.CHARACTER,
      color: "yellow",
      requiredEnergy: { color: "yellow", amount: 3 },
      apCost: 1,
      bp: 3000,
      energy: [{ color: "yellow", amount: 1 }],
      affinities: []
    }
  };
  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game.players.P1.hand.unshift({ uid: "shalnark-cleanup-card", owner: "P1", defId: "private_shalnark_cleanup", faceUp: true });
  game.players.P1.sideline.push({ uid: "cleanup-target-card", owner: "P1", defId: "private_cleanup_target", faceUp: true });

  game = applyAction(game, {
    type: "playCard",
    player: "P1",
    handIndex: 0,
    destination: LINES.FRONT
  });
  assert.equal(game.players.P1.frontLine.some((permanent) => topDefId(permanent) === "private_cleanup_target"), true);

  game = applyAction(game, { type: "advancePhase", player: "P1" });
  assert.equal(game.phase, PHASES.ATTACK);
  assert.equal(game.players.P1.frontLine.some((permanent) => topDefId(permanent) === "private_cleanup_target"), true);

  game = applyAction(game, { type: "advancePhase", player: "P1" });
  assert.equal(game.phase, PHASES.END);
  assert.equal(game.players.P1.frontLine.some((permanent) => topDefId(permanent) === "private_cleanup_target"), false);
  assert.equal(game.players.P1.sideline.some((card) => card.defId === "private_cleanup_target"), true);
});

test("rest-target payoff clauses and colored hand costs are encoded", () => {
  const rewardFields = encodeEgmanCardText({
    name: "Reward",
    category: "Event",
    effect: "You may switch one active [Exotic] or [Wardress] affinity card on your front line to resting. If you do, draw three cards.",
    trigger: ""
  }).fields;
  assert.equal(rewardFields.eventEffect.kind, "restTargetsThen");
  assert.equal(rewardFields.eventEffect.optional, true);
  assert.deepEqual(rewardFields.eventEffect.target.affinities, ["exotic", "wardress"]);

  const c2Fields = encodeEgmanCardText({
    name: "C.C.",
    category: "Character",
    effect: "[Activate: Main] This ability can only be activated when this card is in your sideline. You may place two purple cards from your hand into your sideline. If you do, add this card to your hand.",
    trigger: ""
  }).fields;
  assert.deepEqual(c2Fields.abilities[0].effect.effect.effects[0].filter, { color: "purple" });

  const catalog = {
    ...sampleCatalog,
    private_reward_event: {
      id: "private_reward_event",
      number: "DEM-1-171",
      sourceCode: "DEM",
      name: "Reward",
      type: CARD_TYPES.EVENT,
      color: "blue",
      requiredEnergy: { color: "blue", amount: 0 },
      apCost: 0,
      affinities: [],
      ...rewardFields
    },
    private_exotic_target: {
      id: "private_exotic_target",
      number: "DEM-1-172",
      sourceCode: "DEM",
      name: "Private Exotic Target",
      type: CARD_TYPES.CHARACTER,
      color: "blue",
      requiredEnergy: { color: "blue", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "blue", amount: 1 }],
      affinities: ["exotic"]
    }
  };
  let game = createGame({
    catalog,
    decks: { P1: sampleDeckList, P2: sampleDeckList },
    skipShuffle: true,
    validateDecks: false
  });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game = applyAction(game, { type: "advancePhase", player: "P1" });
  game.players.P1.frontLine = [testPermanent("exotic-target", "P1", "private_exotic_target")];
  game.players.P1.hand.unshift({ uid: "reward-event-card", owner: "P1", defId: "private_reward_event", faceUp: true });
  const handBefore = game.players.P1.hand.length;

  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0 });

  assert.equal(game.players.P1.frontLine[0].rested, true);
  assert.equal(game.players.P1.hand.length, handBefore - 1 + 3);
});

test("removal-zone costs handle larger number words", () => {
  const kento = encodeEgmanCardText({
    name: "Kento Nanami",
    category: "Character",
    effect: "[When Played] You may place seven cards from your sideline into your removal area. If you do, draw a card.",
    trigger: ""
  }).fields;
  const optionalEffect = kento.abilities[0].effect.effect;
  assert.equal(optionalEffect.effects[0].kind, "moveCardBetweenZones");
  assert.equal(optionalEffect.effects[0].source, "sideline");
  assert.equal(optionalEffect.effects[0].destination, "removal");
  assert.equal(optionalEffect.effects[0].count, 7);
});

test("EGM encoder handles regional active-entry and sideline-play patterns", () => {
  const site = encodeEgmanCardText({
    category: "Site",
    name: "Monarch's Domain",
    effect: "Play this site set to active. [Activate: Main] [Switch to Resting] All [Shadow Army] affinity cards on your field gain {500 BP} until the end of the turn.",
    trigger: "[Get] Add this card to your hand."
  });
  assert.equal(site.fields.entersActive, true);
  assert.equal(site.fields.abilities[0].cost.restSelf, true);
  assert.equal(site.fields.abilities[0].effect.kind, "modifyBp");
  assert.equal(site.fields.abilities[0].effect.target.affinity, "shadow army");

  const event = encodeEgmanCardText({
    category: "Event",
    name: "Shadow Monarch",
    effect: "Choose one of the following: ・Play up to one character card with [Shadow Army] affinity from your sideline set to active onto your field. ・Play up to two character cards with 3 or less required energy and [Shadow Army] affinity from your sideline set to resting onto your field.",
    trigger: "[Special] Choose one character on your opponent's front line and sideline it."
  });
  assert.equal(event.coverage.unsupported.length, 0);
  assert.equal(event.fields.eventEffect.kind, "chooseOne");
  assert.equal(event.fields.eventEffect.choices[0].effect.kind, "playCardFromZone");
  assert.equal(event.fields.eventEffect.choices[0].effect.filter.affinity, "shadow army");
  assert.equal(event.fields.eventEffect.choices[1].effect.count, 2);
});

test("EGM encoder handles under-card and named sideline retrieval patterns", () => {
  const encoded = encodeEgmanCardText({
    category: "Character",
    name: "Utility Character",
    effect: "[When Played] Place the top two cards of your deck face down under this character. [Activate: Main] Add one face-down card under this character to your hand. [Activate: Main] [Switch to Resting] [Sideline This Card] Add one <Shinji Ikari> or [WILLE] affinity card from your sideline to your hand.",
    trigger: ""
  });

  assert.equal(encoded.coverage.unsupported.length, 0);
  assert.equal(encoded.fields.abilities[0].effect.kind, "placeTopDeckUnderSelf");
  assert.equal(encoded.fields.abilities[1].effect.kind, "moveUnderCardsToZone");
  assert.equal(encoded.fields.abilities[2].effect.kind, "moveCardBetweenZones");
  assert.equal(encoded.fields.abilities[2].effect.filter.anyOf.length, 2);
});

test("EGM encoder handles richer under-card templates", () => {
  const flattenEffects = (effect) => {
    if (!effect) return [];
    return [
      effect,
      ...(effect.effects ?? []).flatMap(flattenEffects),
      ...(effect.effect ? flattenEffects(effect.effect) : []),
      ...(effect.elseEffect ? flattenEffects(effect.elseEffect) : []),
      ...(effect.choices ?? []).flatMap((choice) => flattenEffects(choice.effect))
    ];
  };
  const flattenKinds = (effect) => {
    return flattenEffects(effect).map((item) => item.kind).filter(Boolean);
  };

  const handTuck = encodeEgmanCardText({
    category: "Character",
    name: "Liebe",
    effect: "[When Played] Draw a card, then place one card from your hand face down under this character.",
    trigger: ""
  });
  assert.equal(handTuck.coverage.unsupported.length, 0);
  assert.deepEqual(flattenKinds(handTuck.fields.abilities[0].effect), ["sequence", "draw", "moveHandCardsUnderSelf"]);

  const deckTuck = encodeEgmanCardText({
    category: "Character",
    name: "Kyora Sazanami",
    effect: "[When Played] Look at the top five cards of your deck. Place three cards face down under this character. Place the remaining cards on the bottom of your deck in any order.",
    trigger: ""
  });
  assert.equal(deckTuck.coverage.unsupported.length, 0);
  assert.equal(deckTuck.fields.abilities[0].effect.kind, "lookTopDeckAndMove");
  assert.deepEqual(deckTuck.fields.abilities[0].effect.destinations, ["underSelf", "bottom"]);
  assert.equal(deckTuck.fields.abilities[0].effect.defaultNonDefaultCount, 3);

  const sidelineTuck = encodeEgmanCardText({
    category: "Event",
    name: "Ayanami! Give Me Your Hand... Come Here!!",
    effect: "Choose one character with 5000 or less BP on your opponent's front line and sideline it. Place up to one <Rei Ayanami> from your sideline face down under a <Shinji Ikari> with no face-down cards under it on your field.",
    trigger: ""
  });
  assert.equal(sidelineTuck.coverage.unsupported.length, 0);
  assert.ok(flattenKinds(sidelineTuck.fields.eventEffect).includes("moveZoneCardsUnderTargets"));
  const tuckEffect = flattenEffects(sidelineTuck.fields.eventEffect).find((effect) => effect.kind === "moveZoneCardsUnderTargets");
  assert.deepEqual(tuckEffect.filter, { name: "rei ayanami" });
  assert.equal(tuckEffect.target.noFaceDownUnder, true);

  const cleanup = encodeEgmanCardText({
    category: "Event",
    name: "Magic-Suppressing Mask",
    effect: "Choose one character on your field or your opponent's field. Place all cards under it into their owner's sideline.",
    trigger: ""
  });
  assert.equal(cleanup.coverage.unsupported.length, 0);
  assert.ok(flattenKinds(cleanup.fields.eventEffect).includes("moveUnderCardsToZone"));
  assert.equal(flattenEffects(cleanup.fields.eventEffect).find((effect) => effect.kind === "moveUnderCardsToZone").target.controller, "both");

  const selfUnderTarget = encodeEgmanCardText({
    category: "Character",
    name: "Hinata",
    effect: "[Activate: Main] Choose one non-Raided <Hinata> card with [Raid] on your front line, switch it to active, place this character face up under it, then activate that character's [When Played] ability.",
    trigger: ""
  });
  assert.equal(selfUnderTarget.coverage.unsupported.length, 0);
  assert.ok(flattenKinds(selfUnderTarget.fields.abilities[0].effect).includes("moveSelfCardUnderTarget"));
  assert.equal(flattenEffects(selfUnderTarget.fields.abilities[0].effect).find((effect) => effect.kind === "moveSelfCardUnderTarget").faceUp, true);

  const topDeckUnderTarget = encodeEgmanCardText({
    category: "Character",
    name: "Nacht Faust",
    effect: "[When Attacking] Choose up to one <Asta> or <Liebe> card on your field. It gains 1000 BP until the end of the turn. Place the top card of your deck face down under the chosen character.",
    trigger: ""
  });
  assert.equal(topDeckUnderTarget.coverage.unsupported.length, 0);
  assert.ok(flattenKinds(topDeckUnderTarget.fields.abilities[0].effect).includes("placeTopDeckUnderTargets"));
  const topDeckUnder = flattenEffects(topDeckUnderTarget.fields.abilities[0].effect)
    .find((effect) => effect.kind === "placeTopDeckUnderTargets");
  assert.deepEqual(topDeckUnder.target.names, ["asta", "liebe"]);
});

test("EGM encoder handles life-area transfers before follow-up effects", () => {
  const lifeToHand = encodeEgmanCardText({
    category: "Character",
    name: "Life Buyer",
    effect: "[When Played] You may add one card from your life area to your hand. If you do, draw two cards, then place one card from your hand into your sideline.",
    trigger: ""
  });
  assert.equal(lifeToHand.coverage.unsupported.length, 0);
  assert.equal(lifeToHand.fields.abilities[0].effect.kind, "optional");
  assert.deepEqual(lifeToHand.fields.abilities[0].effect.effect.effects.map((effect) => effect.kind), [
    "moveCardBetweenZones",
    "draw",
    "moveHandToZone"
  ]);
  assert.equal(lifeToHand.fields.abilities[0].effect.effect.effects[0].source, "life");
  assert.equal(lifeToHand.fields.abilities[0].effect.effect.effects[0].destination, "hand");

  const lifeToSideline = encodeEgmanCardText({
    category: "Site",
    name: "Life Toll",
    effect: "[Activate: Main] [Switch to Resting] Place one card from your life area into your sideline.",
    trigger: ""
  });
  assert.equal(lifeToSideline.coverage.unsupported.length, 0);
  assert.equal(lifeToSideline.fields.abilities[0].effect.kind, "moveCardBetweenZones");
  assert.equal(lifeToSideline.fields.abilities[0].effect.source, "life");
  assert.equal(lifeToSideline.fields.abilities[0].effect.destination, "sideline");
});

test("EGM encoder handles no-trigger life-to-sideline defensive triggers", () => {
  const dorothy = encodeEgmanCardText({
    category: "Character",
    name: "Dorothy",
    effect: "[During Opponent's Turn] [If on the Front Line] When a card without a [Trigger] ability is placed from your life area into your sideline, draw a card. You can only activate this <Dorothy> ability one time each turn.",
    trigger: ""
  });
  assert.equal(dorothy.coverage.unsupported.length, 0);
  assert.equal(dorothy.fields.abilities[0].timing, TIMINGS.WHEN_LIFE_TO_SIDELINE_NO_TRIGGER);
  assert.deepEqual(dorothy.fields.abilities[0].conditions, {
    line: LINES.FRONT,
    turn: "opponent"
  });
  assert.equal(dorothy.fields.abilities[0].oncePerTurnKey, "Dorothy:shared-ability");
  assert.deepEqual(dorothy.fields.abilities[0].effect, { kind: "draw", amount: 1 });

  const eden = encodeEgmanCardText({
    category: "Site",
    name: "Eden",
    effect: "[During Opponent's Turn] When a card without a [Trigger] ability is placed from your life area into your sideline, you may switch this active site to resting. If you do, add the card that was placed into your sideline to your hand. You can only activate this <Eden> ability one time each turn.",
    trigger: ""
  });
  assert.equal(eden.coverage.unsupported.length, 0);
  assert.equal(eden.fields.abilities[0].effect.kind, "optional");
  assert.deepEqual(eden.fields.abilities[0].effect.effect.effects, [
    { kind: "restSelf" },
    { kind: "moveContextCardToZone", source: "sideline", destination: "hand" }
  ]);
});

test("EGM encoder handles named and filtered hand-zone moves", () => {
  const named = encodeEgmanCardText({
    category: "Character",
    name: "Private Hand Cost",
    effect: "[Activate: Main] Place one <Saitama> card from your hand into your sideline.",
    trigger: ""
  });
  assert.equal(named.coverage.unsupported.length, 0);
  assert.equal(named.fields.abilities[0].effect.kind, "moveHandToZone");
  assert.deepEqual(named.fields.abilities[0].effect.filter, { name: "saitama" });

  const anyRemoval = encodeEgmanCardText({
    category: "Character",
    name: "Private Removal Cost",
    effect: "[When Played] Place any number of [Squad Zero] affinity cards from your hand into your removal area.",
    trigger: ""
  });
  assert.equal(anyRemoval.coverage.unsupported.length, 0);
  assert.equal(anyRemoval.fields.abilities[0].effect.kind, "moveAllHandToZone");
  assert.equal(anyRemoval.fields.abilities[0].effect.destination, "removal");
  assert.deepEqual(anyRemoval.fields.abilities[0].effect.filter, { affinity: "squad zero" });

  const bpSideline = encodeEgmanCardText({
    category: "Character",
    name: "Private BP Retrieval",
    effect: "[When Played] Add up to one character card with {2000} or less BP other than <Sung Jinwoo> from your sideline to your hand.",
    trigger: ""
  });
  assert.equal(bpSideline.coverage.unsupported.length, 0);
  assert.equal(bpSideline.fields.abilities[0].effect.kind, "moveCardBetweenZones");
  assert.deepEqual(bpSideline.fields.abilities[0].effect.filter, {
    color: undefined,
    type: CARD_TYPES.CHARACTER,
    bpMax: 2000,
    otherThanName: "sung jinwoo"
  });

  const optionalDrawDiscard = encodeEgmanCardText({
    category: "Character",
    name: "Veldora",
    effect: "When this character attacks and wins a battle, you may draw a card. If you do, place one card from your hand into your sideline.",
    trigger: ""
  });
  assert.equal(optionalDrawDiscard.coverage.unsupported.length, 0);
  assert.equal(optionalDrawDiscard.fields.abilities[0].effect.kind, "optional");
  assert.deepEqual(optionalDrawDiscard.fields.abilities[0].effect.effect.effects.map((effect) => effect.kind), [
    "draw",
    "moveHandToZone"
  ]);

  const optionalAffinityDiscardThenDraw = encodeEgmanCardText({
    category: "Character",
    name: "Sung Jinwoo",
    effect: "[When Played] You may place one [Shadow Army] affinity card from your hand into your sideline. If you do, draw a card.",
    trigger: ""
  });
  assert.equal(optionalAffinityDiscardThenDraw.coverage.unsupported.length, 0);
  const affinityEffects = optionalAffinityDiscardThenDraw.fields.abilities[0].effect.effect.effects;
  assert.deepEqual(affinityEffects.map((effect) => effect.kind), [
    "moveHandToZone",
    "draw"
  ]);
  assert.deepEqual(affinityEffects[0].filter, { affinity: "shadow army" });
});

test("EGM encoder handles richer play-from-zone templates", () => {
  const noTriggerPlay = encodeEgmanCardText({
    category: "Character",
    name: "Evangelion Production Model-02",
    effect: "[When Played] Play up to one red character card with {0} or less required energy and without a [Trigger] ability from your hand set to resting onto your field.",
    trigger: ""
  });
  assert.equal(noTriggerPlay.coverage.unsupported.length, 0);
  assert.equal(noTriggerPlay.fields.abilities[0].effect.kind, "playCardFromZone");
  assert.deepEqual(noTriggerPlay.fields.abilities[0].effect.zones, ["hand"]);
  assert.deepEqual(noTriggerPlay.fields.abilities[0].effect.filter, {
    type: CARD_TYPES.CHARACTER,
    color: "red",
    requiredEnergyMax: 0,
    noTrigger: true
  });

  const namedPairRaid = encodeEgmanCardText({
    category: "Event",
    name: "Let's Go Home",
    effect: "Add up to one <Edward Elric> or <Alphonse Elric> card from your sideline to your hand. Play up to one <Edward Elric> or <Alphonse Elric> card with fulfilled required energy and 1 AP cost from your hand set to resting onto your field, or perform Raid with it.",
    trigger: ""
  });
  assert.equal(namedPairRaid.coverage.unsupported.length, 0);
  assert.equal(namedPairRaid.fields.eventEffect.kind, "sequence");
  assert.equal(namedPairRaid.fields.eventEffect.effects[1].kind, "playOrRaidCardFromZone");
  assert.equal(namedPairRaid.fields.eventEffect.effects[1].filter.requiredEnergyFulfilled, true);
  assert.deepEqual(namedPairRaid.fields.eventEffect.effects[1].filter.names, ["edward elric", "alphonse elric"]);

  const mixedSite = encodeEgmanCardText({
    category: "Event",
    name: "Clone",
    effect: "You may place one card from your hand into your removal area. If you do, draw a card and play one character or site card with [Specified Slot] affinity from your sideline set to active onto your energy line.",
    trigger: ""
  });
  assert.equal(mixedSite.coverage.unsupported.length, 0);
  const mixedSiteOptional = mixedSite.fields.eventEffect.kind === "optional"
    ? mixedSite.fields.eventEffect
    : mixedSite.fields.eventEffect.effects[1];
  assert.equal(mixedSiteOptional.kind, "optional");
  assert.deepEqual(mixedSiteOptional.effect.effects.map((effect) => effect.kind), [
    "moveHandToZone",
    "draw",
    "playCardFromZone"
  ]);
  const mixedSitePlay = mixedSiteOptional.effect.effects[2];
  assert.equal(mixedSitePlay.destinationLine, LINES.ENERGY);
  assert.deepEqual(mixedSitePlay.filter.anyOf, [
    { type: CARD_TYPES.CHARACTER },
    { type: CARD_TYPES.SITE }
  ]);
});

test("EGM encoder handles remaining regional sideline, reducer, and replay patterns", () => {
  const sidelineSource = encodeEgmanCardText({
    category: "Character",
    name: "Self Returning Unit",
    effect: "[Activate: Main] [If in the Sideline] Play this card from your sideline set to resting onto your field. [When Played] You may choose one of your characters on the other line from this character and swap it with this character.",
    trigger: ""
  });
  assert.equal(sidelineSource.coverage.unsupported.length, 0);
  assert.equal(sidelineSource.fields.abilities[0].conditions.zone, "sideline");
  assert.equal(sidelineSource.fields.abilities[0].effect.kind, "playSourceFromZone");
  assert.equal(sidelineSource.fields.abilities[1].effect.kind, "optional");
  assert.equal(sidelineSource.fields.abilities[1].effect.effect.kind, "swapSourceWithOtherLine");

  const reducer = encodeEgmanCardText({
    category: "Character",
    name: "AP Reducer",
    effect: "[Activate: Main] Reduce the AP cost of the next <Hajime Saito> card with 3 or less required energy you use from your hand this turn by 1.",
    trigger: ""
  });
  assert.equal(reducer.coverage.unsupported.length, 0);
  assert.equal(reducer.fields.abilities[0].effect.kind, "reduceNextUseApCost");
  assert.equal(reducer.fields.abilities[0].effect.filter.name, "hajime saito");

  const sidelineEvent = encodeEgmanCardText({
    category: "Character",
    name: "Sideline Event User",
    effect: "[Activate: Main] You can only activate this ability if you have 20 or more cards in your sideline. Pay the AP cost of and use up to one <Elixir of Life> card with fulfilled required energy from your sideline. Place any card used with this ability into your removal area instead of your sideline.",
    trigger: ""
  });
  assert.equal(sidelineEvent.coverage.unsupported.length, 0);
  assert.equal(sidelineEvent.fields.abilities[0].effect.kind, "useEventFromZone");
  assert.equal(sidelineEvent.fields.abilities[0].effect.destination, "removal");

  const returnSource = encodeEgmanCardText({
    category: "Character",
    name: "Shadow Return",
    effect: "[Activate: Main] [If in the Sideline] Place one [Shadow Army] affinity card from your hand into your sideline. If you do, add this card from your sideline to your hand.",
    trigger: ""
  });
  assert.equal(returnSource.coverage.unsupported.length, 0);
  assert.equal(returnSource.fields.abilities[0].effect.kind, "sequence");
  assert.equal(returnSource.fields.abilities[0].effect.effects.at(-1).kind, "moveSourceCardBetweenZones");

  const replay = encodeEgmanCardText({
    category: "Character",
    name: "Replay Unit",
    effect: "[Activate: Main] Sideline one character on your field. If you do, play that card set to active onto your field.",
    trigger: ""
  });
  assert.equal(replay.coverage.unsupported.length, 0);
  assert.equal(replay.fields.abilities[0].effect.kind, "replayTargets");

  const conditionalChoice = encodeEgmanCardText({
    category: "Character",
    name: "Iori Samura",
    effect: "[Activate: Main] [Switch to Resting] You can only activate this ability if <Chihiro Rokuhira> or a [Masumi] affinity card is on your field. Choose one of the following: ãƒ»Look at the top card of your deck, then place it on the top or bottom of your deck. ãƒ»Place one card from your hand into your sideline. If you do, choose up to one other character on your field. It gains 1000 BP until the end of the turn.",
    trigger: ""
  });
  assert.equal(conditionalChoice.coverage.unsupported.length, 0);
  assert.deepEqual(conditionalChoice.fields.abilities[0].conditions.fieldAnyOf, [
    { name: "Chihiro Rokuhira" },
    { affinity: "Masumi" }
  ]);
  assert.equal(conditionalChoice.fields.abilities[0].effect.kind, "chooseOne");
});

test("EGM encoder handles full-pool tail instead, delayed, and named-split patterns", () => {
  const insteadChoice = encodeEgmanCardText({
    category: "Event",
    name: "Presence of the Demon King",
    effect: "Choose one character on your opponent's front line. It loses {3000 BP} until the start of your next turn. If <Dante Zogratis> is on your field, choose one of the following: ãƒ»{4000 BP} instead. ãƒ»Draw a card.",
    trigger: ""
  });
  assert.equal(insteadChoice.coverage.unsupported.length, 0);
  assert.equal(insteadChoice.fields.eventEffect.kind, "conditional");
  assert.equal(insteadChoice.fields.eventEffect.effect.kind, "chooseOne");

  const delayedReturn = encodeEgmanCardText({
    category: "Character",
    name: "Milim",
    effect: "[When Played] If this character was not played with one of your abilities, it gains \"At the end of your opponent's attack phase, this character returns to your hand\" until the start of your next turn.",
    trigger: ""
  });
  assert.equal(delayedReturn.coverage.unsupported.length, 0);
  assert.equal(delayedReturn.fields.abilities[0].effect.kind, "conditional");
  assert.equal(delayedReturn.fields.abilities[0].effect.effect.kind, "scheduleReturnTargetsToHand");

  const namedSplit = encodeEgmanCardText({
    category: "Character",
    name: "Hantengu",
    effect: "[When Sidelined] Choose up to one of each of the following cards from your sideline: <Aizetsu>, <Urogi>, <Karaku>, and <Sekido>. Play up to two among them set to resting onto your field. Add any remaining cards to your hand.",
    trigger: ""
  });
  assert.equal(namedSplit.coverage.unsupported.length, 0);
  assert.equal(namedSplit.fields.abilities[0].effect.kind, "playSomeNamedFromSidelineAddRest");
});

test("EGM encoder keeps embedded timing tags inside ability-copy prose", () => {
  const encoded = encodeEgmanCardText({
    category: "Character",
    name: "Suguru Geto",
    effect: "[Activate: Main] [Once Per Turn] Place up to two red [Cursed Spirit] affinity cards without [Raid] and with different card names from your sideline into your removal area. This character gains all [Activate: Main] abilities on the cards placed into the removal area by this ability until the end of the turn.",
    trigger: ""
  });

  assert.equal(encoded.coverage.unsupported.length, 0);
  assert.equal(encoded.fields.abilities.length, 1);
  assert.equal(encoded.fields.abilities[0].effect.kind, "sequence");
  assert.deepEqual(
    encoded.fields.abilities[0].effect.effects.map((effect) => effect.kind),
    ["moveCardBetweenZones", "copyActivatedAbilitiesFromMovedCards"]
  );
});

test("EGM encoder handles quoted granted abilities and base-card timing inheritance", () => {
  const grantedDraw = encodeEgmanCardText({
    category: "Event",
    name: "Sakabato",
    effect: "Draw a card. Choose up to one <Kenshin Himura> on your field. It gains \"[When Attacking] Draw a card\" until the end of the turn.",
    trigger: ""
  });
  assert.equal(grantedDraw.coverage.unsupported.length, 0);
  assert.equal(grantedDraw.fields.eventEffect.kind, "sequence");
  assert.ok(grantedDraw.fields.eventEffect.effects.some((effect) => effect.kind === "draw"));
  const grant = grantedDraw.fields.eventEffect.effects.find((effect) => effect.kind === "grantAbility");
  assert.equal(grant.ability.timing, TIMINGS.WHEN_ATTACKING);
  assert.equal(grant.ability.effect.kind, "draw");
  assert.equal(grant.target.name, "kenshin himura");

  const inherited = encodeEgmanCardText({
    category: "Character",
    name: "Invisibility Suit",
    effect: "This character gains all [When Played] and [When Attacking] abilities on its base card.",
    trigger: ""
  });
  assert.deepEqual(inherited.fields.gainsBaseAbilityTimings, [TIMINGS.WHEN_PLAYED, TIMINGS.WHEN_ATTACKING]);

  const delayedReturn = encodeEgmanCardText({
    category: "Character",
    name: "Eren Jaeger",
    effect: "[When Attacking] Play up to one red character card with 3 or less required energy, 1 AP cost, and [104th Cadet Corps] affinity from your hand set to active onto your front line. That character gains \"At the end of the attack phase, return this character to your hand\" until the end of the turn.",
    trigger: ""
  });
  assert.equal(delayedReturn.coverage.unsupported.length, 0);
  assert.equal(delayedReturn.fields.abilities[0].effect.kind, "sequence");
  assert.deepEqual(
    delayedReturn.fields.abilities[0].effect.effects.map((effect) => effect.kind),
    ["playCardFromZone", "scheduleLastPlayedPermanentToZone"]
  );
  assert.equal(delayedReturn.fields.abilities[0].effect.effects[1].zone, "hand");

  const sidelinedWatcher = encodeEgmanCardText({
    category: "Character",
    name: "Illumi",
    effect: "[When Played] Choose up to one of your opponent's characters. You gain \"Draw two cards if the chosen character is sidelined\" until the end of the turn.",
    trigger: ""
  });
  assert.equal(sidelinedWatcher.coverage.unsupported.length, 0);
  assert.equal(sidelinedWatcher.fields.abilities[0].effect.kind, "watchTargetSidelinedForEffect");
  assert.equal(sidelinedWatcher.fields.abilities[0].effect.effect.amount, 2);
});

test("EGM encoder keeps movement-granted timing abilities conditional", () => {
  const encoded = encodeEgmanCardText({
    category: "Character",
    name: "Asuna",
    effect: "[During Your Turn] [Once Per Turn] When this character moves outside of your movement phase, it gains \"[When Attacking] Draw a card\" until the end of the turn.",
    trigger: "[Draw] Draw a card."
  });
  assert.equal(encoded.coverage.unsupported.length, 0);
  assert.equal(encoded.fields.abilities.length, 1);
  const movement = encoded.fields.abilities[0];
  assert.equal(movement.timing, TIMINGS.WHEN_OWN_CHARACTER_MOVES_OUTSIDE_MOVEMENT_PHASE);
  assert.equal(movement.oncePerTurn, true);
  assert.equal(movement.conditions.turn, "controller");
  assert.equal(movement.effect.kind, "grantAbility");
  assert.equal(movement.effect.ability.timing, TIMINGS.WHEN_ATTACKING);
  assert.equal(movement.effect.ability.effect.kind, "draw");
});

test("EGM encoder handles remaining audited exact card templates", () => {
  const mina = encodeEgmanCardText({
    category: "Character",
    name: "Mina Ashiro",
    effect: "[Activate: Main] [If on the Front Line] [Once Per Turn] Choose one resting character on your opponent's front line. It gains \"This character remains set to resting the next time it would be switched to active.\"",
    trigger: ""
  });
  assert.equal(mina.coverage.unsupported.length, 0);
  const restLock = mina.fields.abilities[0].effect;
  assert.equal(restLock.kind, "restTargets");
  assert.equal(restLock.preventNextReady, true);
  assert.equal(restLock.target.rested, true);

  const rakuzaichi = encodeEgmanCardText({
    category: "Site",
    name: "Rakuzaichi",
    effect: "[Activate: Main] [Switch to Resting] Choose one of the following: ・Place the top card of your deck face down under this site. ・Place one card from your hand into your sideline. If you do, reveal all face-down cards under this site and {add them to your hand}. Your opponent may place two cards from their hand into their sideline. If they do, {place them into your sideline} instead.",
    trigger: ""
  });
  assert.equal(rakuzaichi.coverage.unsupported.length, 0);
  const opponentMove = flattenEffectTree(rakuzaichi.fields.abilities[0].effect)
    .find((effect) => effect.kind === "opponentMayMoveCardsBetweenZonesElse");
  assert.equal(opponentMove.count, 2);
  assert.equal(opponentMove.source, "hand");
  assert.equal(opponentMove.destination, "sideline");
  assert.equal(opponentMove.destinationPlayer, "self");

  const dailyQuest = encodeEgmanCardText({
    category: "Site",
    name: "Daily Quest",
    effect: "[Activate: Main] [Switch to Resting] [Place 1 Card From Hand Into Sideline] You may place one face-down card under a card on your field into your sideline. If you do, add up to one <Sung Jinwoo> card with 0 required energy from your sideline to your hand.",
    trigger: ""
  });
  assert.equal(dailyQuest.coverage.unsupported.length, 0);
  const retrieve = flattenEffectTree(dailyQuest.fields.abilities[0].effect)
    .find((effect) => effect.kind === "moveCardBetweenZones");
  assert.equal(retrieve.filter.name, "sung jinwoo");
  assert.equal(retrieve.filter.requiredEnergyMin, 0);
  assert.equal(retrieve.filter.requiredEnergyMax, 0);

  const diablo = encodeEgmanCardText({
    category: "Character",
    name: "Diablo",
    effect: "[Activate: Main] [Once Per Turn] Choose one of the following: ・If this character has 6000 or more BP, switch it to active. ・This character gains \"[When Attacking] If this character has 6000 or more BP, draw up to one card\" until the end of the turn.",
    trigger: ""
  });
  assert.equal(diablo.coverage.unsupported.length, 0);
  const grant = flattenEffectTree(diablo.fields.abilities[0].effect)
    .find((effect) => effect.kind === "grantAbility");
  assert.equal(grant.ability.timing, TIMINGS.WHEN_ATTACKING);
  assert.equal(grant.ability.effect.kind, "conditional");
  assert.equal(grant.ability.effect.condition.selfBpMin, 6000);
  assert.equal(grant.ability.effect.effect.kind, "optional");
  assert.equal(grant.ability.effect.effect.effect.kind, "draw");
});

test("audited Boogie Woogie and Soka encodings preserve optional responder choices and effect order", () => {
  const boogie = encodeEgmanCardText({
    card_code: "UE03BT_JJK-1-098",
    name: "Boogie Woogie",
    category: "Event",
    effect: "Choose one character with 5000 or less BP on your opponent's front line and place it on the bottom of their deck. Your opponent plays up to one character card with 3 or less required energy from their hand set to resting onto their front line. [When Played] abilities on characters played with this ability do not activate. If <Aoi Todo> is on your field, draw a card.",
    trigger: ""
  }).fields.eventEffect;
  assert.deepEqual(boogie.effects.map((effect) => effect.kind), [
    "suppressPlayedAbilities",
    "moveTargetsToBottomDeck",
    "playCardFromZone",
    "conditional"
  ]);
  assert.equal(boogie.effects[1].target.bpMax, 5000);
  assert.equal(boogie.effects[2].player, "opponent");
  assert.equal(boogie.effects[2].min, 0);
  assert.equal(boogie.effects[2].max, 1);
  assert.equal(boogie.effects[3].condition.filter.name, "Aoi Todo");

  const sokaFields = encodeEgmanCardText({
    card_code: "UE20BT_TSK-2-029",
    name: "Soka",
    category: "Character",
    effect: "[Activate: Main] [Switch to Resting] [Sideline This Card] Play one purple character card with 3 or less required energy and 1 AP cost from your hand set to active onto your field, or perform Raid with it. If you do, your opponent plays up to one character card with 2 or less required energy and 1 AP cost from their hand set to active onto their front line. [When Played] abilities on characters you and your opponent play with this ability do not activate.",
    trigger: ""
  }).fields;
  assert.equal(sokaFields.abilities.length, 1);
  const sokaAbility = sokaFields.abilities[0];
  assert.equal(sokaAbility.timing, TIMINGS.ACTIVATE_MAIN);
  assert.deepEqual(sokaAbility.cost, { restSelf: true, sidelineSelf: true });
  assert.deepEqual(sokaAbility.effect.effects.map((effect) => effect.kind), [
    "suppressPlayedAbilities",
    "playOrRaidCardFromZone",
    "playCardFromZone"
  ]);
  assert.equal(sokaAbility.effect.effects[1].requiredPlayedCountForFollowing, 1);
  assert.deepEqual(sokaAbility.effect.effects[1].destinationLines, [LINES.FRONT, LINES.ENERGY]);
  assert.equal(sokaAbility.effect.effects[2].player, "opponent");
  assert.equal(sokaAbility.effect.effects[2].min, 0);
});

test("audited Rimuru and Cha Hae-in encodings preserve every legal play branch", () => {
  const rimuru = encodeEgmanCardText({
    card_code: "UE20BT_TSK-1-053",
    name: "Rimuru",
    category: "Character",
    effect: "[When Played] Add up to one blue character card with 4 or less required energy and 1 AP cost from your sideline to your hand. If there are 4 or more character cards with 4000 or more BP or 4 or more event cards in your sideline, you may play that card set to active onto your field or perform Raid with it instead.",
    trigger: ""
  }).fields.abilities[0].effect;
  assert.equal(rimuru.kind, "conditional");
  assert.equal(rimuru.effect.kind, "chooseOne");
  assert.deepEqual(rimuru.effect.choices.map((choice) => choice.id), ["add-to-hand", "play-or-raid"]);
  const rimuruPlay = rimuru.effect.choices[1].effect;
  assert.equal(rimuruPlay.min, 0);
  assert.equal(rimuruPlay.max, 1);
  assert.deepEqual(rimuruPlay.destinationLines, [LINES.FRONT, LINES.ENERGY]);
  assert.equal(rimuruPlay.allowRaid, true);
  assert.equal(rimuru.elseEffect.min, 0);

  const cha = encodeEgmanCardText({
    card_code: "UE17BT_SLG-1-011",
    name: "Cha Hae-in",
    category: "Character",
    effect: "When this card is added from your sideline to your hand by one of your abilities, you may play it with fulfilled required energy from your hand set to resting onto your field. If this card was added to your hand by an ability on a <Sung Jinwoo>, set it to active instead. If you have 10 or more cards in your sideline, this character cannot be blocked by a character with 4000 or more BP. [When Played] Place the top card of your deck into your sideline.",
    trigger: ""
  }).fields;
  const recoveryAbility = cha.abilities.find((ability) => ability.timing === TIMINGS.WHEN_SIDELINE_TO_HAND_BY_ABILITY);
  assert.equal(recoveryAbility.effect.kind, "optional");
  assert.equal(recoveryAbility.effect.effect.kind, "playSourceFromZone");
  assert.equal(recoveryAbility.effect.effect.requiredEnergyFulfilled, true);
  assert.equal(recoveryAbility.effect.effect.activeIfTriggerSourceName, "Sung Jinwoo");
  assert.deepEqual(recoveryAbility.effect.effect.destinationLines, [LINES.FRONT, LINES.ENERGY]);
});

test("Cha Hae-in recovery is a runtime choice and only Sung Jinwoo makes it active", () => {
  const chaFields = encodeEgmanCardText({
    card_code: "UE17BT_SLG-1-011",
    name: "Cha Hae-in",
    category: "Character",
    effect: "When this card is added from your sideline to your hand by one of your abilities, you may play it with fulfilled required energy from your hand set to resting onto your field. If this card was added to your hand by an ability on a <Sung Jinwoo>, set it to active instead. If you have 10 or more cards in your sideline, this character cannot be blocked by a character with 4000 or more BP. [When Played] Place the top card of your deck into your sideline.",
    trigger: ""
  }).fields;
  const recoveryAbility = {
    id: "recover-cha",
    timing: TIMINGS.ACTIVATE_MAIN,
    oncePerTurn: false,
    conditions: {},
    effect: {
      kind: "moveCardBetweenZones",
      source: "sideline",
      destination: "hand",
      count: 1,
      filter: { name: "Cha Hae-in" }
    }
  };
  const catalog = {
    ...sampleCatalog,
    private_cha: {
      ...sampleCatalog.demo_rookie,
      id: "private_cha",
      number: "UE17BT_SLG-1-011",
      name: "Cha Hae-in",
      color: "purple",
      requiredEnergy: { color: "purple", amount: 4 },
      ...chaFields
    },
    private_sung: {
      ...sampleCatalog.demo_rookie,
      id: "private_sung",
      number: "DEM-SUNG",
      name: "Sung Jinwoo",
      color: "purple",
      abilities: [recoveryAbility]
    },
    private_other_recovery: {
      ...sampleCatalog.demo_rookie,
      id: "private_other_recovery",
      number: "DEM-OTHER-RECOVERY",
      name: "Other Recovery",
      color: "purple",
      abilities: [recoveryAbility]
    },
    private_purple_energy: {
      ...sampleCatalog.demo_rookie,
      id: "private_purple_energy",
      number: "DEM-PURPLE-ENERGY",
      name: "Purple Energy",
      color: "purple",
      energy: [{ color: "purple", amount: 4 }]
    }
  };
  const makeGame = (sourceDefId) => {
    const game = createGame({
      catalog,
      decks: { P1: sampleDeckList, P2: sampleDeckList },
      skipShuffle: true,
      validateDecks: false
    });
    game.phase = PHASES.MAIN;
    game.activePlayer = "P1";
    game.players.P1.frontLine = [testPermanent("recovery-source", "P1", sourceDefId)];
    game.players.P1.energyLine = [testPermanent("energy-source", "P1", "private_purple_energy")];
    game.players.P1.sideline = [{ uid: "cha-card", owner: "P1", defId: "private_cha", faceUp: true }];
    game.players.P1.hand = [];
    return game;
  };
  const recover = (game, accept = true) => applyAction(game, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: "recover-cha",
    resolutionChoiceResolver: ({ request }) => {
      if (request.kind === "optionalEffect") return { [request.choiceKey]: accept };
      if (request.kind === "playSourceFromZone") {
        return { [request.destinationLineChoiceKey]: LINES.ENERGY };
      }
      return {};
    }
  });

  const sungResult = recover(makeGame("private_sung"));
  assert.equal(sungResult.players.P1.hand.length, 0);
  assert.equal(topDefId(sungResult.players.P1.energyLine.at(-1)), "private_cha");
  assert.equal(sungResult.players.P1.energyLine.at(-1).rested, false);

  const otherResult = recover(makeGame("private_other_recovery"));
  assert.equal(otherResult.players.P1.energyLine.at(-1).rested, true);

  const declined = recover(makeGame("private_sung"), false);
  assert.equal(declined.players.P1.hand[0].defId, "private_cha");
  assert.equal(declined.players.P1.energyLine.length, 1);
});

test("Soka only offers the opponent a play after its own play succeeds and suppresses both When Played abilities", () => {
  const drawAbility = (id) => ({
    id,
    timing: TIMINGS.WHEN_PLAYED,
    oncePerTurn: false,
    conditions: {},
    effect: { kind: "draw", amount: 1 }
  });
  const sokaFields = encodeEgmanCardText({
    card_code: "UE20BT_TSK-2-029",
    name: "Soka",
    category: "Character",
    effect: "[Activate: Main] [Switch to Resting] [Sideline This Card] Play one purple character card with 3 or less required energy and 1 AP cost from your hand set to active onto your field, or perform Raid with it. If you do, your opponent plays up to one character card with 2 or less required energy and 1 AP cost from their hand set to active onto their front line. [When Played] abilities on characters you and your opponent play with this ability do not activate.",
    trigger: ""
  }).fields;
  const catalog = {
    ...sampleCatalog,
    private_soka: {
      id: "private_soka",
      number: "UE20BT_TSK-2-029",
      sourceCode: "UE20BT",
      name: "Soka",
      type: CARD_TYPES.CHARACTER,
      color: "purple",
      requiredEnergy: { color: "purple", amount: 2 },
      apCost: 1,
      bp: 2000,
      energy: [{ color: "purple", amount: 1 }],
      affinities: [],
      ...sokaFields
    },
    private_soka_own_play: {
      ...sampleCatalog.demo_rookie,
      id: "private_soka_own_play",
      number: "DEM-SOKA-OWN",
      name: "Soka Own Play",
      color: "purple",
      requiredEnergy: { color: "purple", amount: 1 },
      apCost: 1,
      abilities: [drawAbility("own-when-played")]
    },
    private_soka_opponent_play: {
      ...sampleCatalog.demo_rookie,
      id: "private_soka_opponent_play",
      number: "DEM-SOKA-OPPONENT",
      name: "Soka Opponent Play",
      requiredEnergy: { color: "green", amount: 1 },
      apCost: 1,
      abilities: [drawAbility("opponent-when-played")]
    }
  };
  const makeGame = () => {
    const game = createGame({
      catalog,
      decks: { P1: sampleDeckList, P2: sampleDeckList },
      skipShuffle: true,
      validateDecks: false
    });
    game.phase = PHASES.MAIN;
    game.activePlayer = "P1";
    game.players.P1.frontLine = [testPermanent("soka-source", "P1", "private_soka")];
    game.players.P1.hand = [];
    game.players.P2.hand = [{ uid: "soka-opponent-card", owner: "P2", defId: "private_soka_opponent_play", faceUp: true }];
    game.players.P1.deck = [{ uid: "soka-own-draw", owner: "P1", defId: "demo_rookie", faceUp: false }];
    game.players.P2.deck = [{ uid: "soka-opponent-draw", owner: "P2", defId: "demo_rookie", faceUp: false }];
    return game;
  };

  const failed = applyAction(makeGame(), {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: "activateMain-1",
    choices: { opponentPlayHandIndex: { uid: "soka-opponent-card" } }
  });
  assert.equal(failed.players.P2.frontLine.length, 0);
  assert.equal(failed.players.P2.hand[0].uid, "soka-opponent-card");

  const successfulGame = makeGame();
  successfulGame.players.P1.hand.push({ uid: "soka-own-card", owner: "P1", defId: "private_soka_own_play", faceUp: true });
  const successful = applyAction(successfulGame, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: "activateMain-1",
    choices: {
      playZoneIndex: { uid: "soka-own-card" },
      performRaid: false,
      opponentPlayHandIndex: { uid: "soka-opponent-card" }
    }
  });
  assert.equal(successful.players.P1.frontLine[0].cards.at(-1).uid, "soka-own-card");
  assert.equal(successful.players.P2.frontLine[0].cards.at(-1).uid, "soka-opponent-card");
  assert.equal(successful.players.P1.deck[0].uid, "soka-own-draw");
  assert.equal(successful.players.P2.deck[0].uid, "soka-opponent-draw");
});

test("EGM encoder preserves conditional and temporary quoted ability grants", () => {
  const neon = encodeEgmanCardText({
    category: "Character",
    name: "Neon",
    effect: "If you have used an event card this turn, this character gains [Damage (2)] and \" [When Attacking] You may draw a card. If you do, place one card from your hand into your sideline\" until the end of the turn.",
    trigger: ""
  });
  assert.equal(neon.coverage.unsupported.length, 0);
  assert.equal(neon.fields.abilities[0].timing, TIMINGS.WHEN_ATTACKING);
  assert.deepEqual(neon.fields.abilities[0].conditions, { eventUsedThisTurn: "self" });
  assert.equal(neon.fields.abilities[0].effect.kind, "optional");
  assert.deepEqual(neon.fields.abilities[0].effect.effect.effects.map((effect) => effect.kind), ["draw", "moveHandToZone"]);

  const cha = encodeEgmanCardText({
    category: "Character",
    name: "Cha Hae-in",
    effect: "[When Played] If you have five or more [Fourth Jeju Island Raid] affinity cards on your field, switch this character to active and give it \" [When Attacking] This character remains set to resting the next time it would be switched to active\" until the end of the turn. You can only activate this <Cha Hae-in> ability one time each turn.",
    trigger: ""
  });
  const chaEffects = cha.fields.abilities[0].effect.effect.effects;
  assert.deepEqual(chaEffects.map((effect) => effect.kind), ["readySelf", "grantAbility"]);
  assert.equal(chaEffects[1].ability.timing, TIMINGS.WHEN_ATTACKING);
  assert.equal(chaEffects[1].ability.effect.preventNextReady, true);

  const goto = encodeEgmanCardText({
    category: "Character",
    name: "Goto Ryuji",
    effect: "Play this character set to active. [If on the Front Line] When a [Fourth Jeju Island Raid] affinity card on your field without [Japanese Hunters] affinity is sidelined, all [Japanese Hunters] affinity cards on your field gain \" [When Sidelined] Add this card to your hand\" until the end of the turn. [When Played] Choose up to one character on your field. It gains 1000 BP until the end of the turn.",
    trigger: ""
  });
  assert.equal(goto.fields.staticModifiers, undefined);
  const gotoGrant = goto.fields.abilities.find((ability) => ability.timing === TIMINGS.WHEN_OWN_CHARACTER_SIDELINED);
  assert.equal(gotoGrant.conditions.line, LINES.FRONT);
  assert.deepEqual(gotoGrant.conditions.sidelinedCharacter, {
    affinity: "Fourth Jeju Island Raid",
    withoutAffinity: "Japanese Hunters"
  });
  assert.equal(gotoGrant.effect.ability.timing, TIMINGS.WHEN_SIDELINED);
  assert.equal(gotoGrant.effect.ability.effect.destination, "hand");

  const ichigo = encodeEgmanCardText({
    category: "Character",
    name: "Ichigo Kurosaki",
    effect: "[Activate: Main] [Once Per Turn] Place one card with \"Zangetsu\" or \"Getsuga\" in its card name from your hand into your sideline. If you do, draw a card and give this character 1000 BP and \" [When Attacking] Draw up to one card\" until the end of the turn.",
    trigger: ""
  });
  const ichigoAbility = ichigo.fields.abilities[0];
  assert.equal(ichigoAbility.cost.discardFromHand, 1);
  assert.deepEqual(ichigoAbility.cost.discardFromHandFilter.anyOf, [
    { nameIncludesAll: ["Zangetsu"] },
    { nameIncludesAll: ["Getsuga"] }
  ]);
  assert.deepEqual(ichigoAbility.effect.effects.map((effect) => effect.kind), ["draw", "modifyBp", "grantAbility"]);
  assert.equal(ichigoAbility.effect.effects[2].ability.effect.kind, "optional");
});

test("EGM encoder handles return-cost lists, target conditional returns, and raid-stack return replacements", () => {
  const namedList = encodeEgmanCardText({
    category: "Character",
    name: "Hajime Saito",
    effect: "[When Attacking] You may return one <Kenshin Himura> or <Sanosuke Sagara>, or one other <Hajime Saito> on your front line to your hand. If you do, this character gains 1500 BP until the end of the turn.",
    trigger: ""
  });
  assert.equal(namedList.coverage.unsupported.length, 0);
  assert.equal(namedList.fields.abilities[0].effect.kind, "optional");
  assert.deepEqual(namedList.fields.abilities[0].effect.effect.effects.map((effect) => effect.kind), ["returnTargetsToHand", "modifyBp"]);

  const conditionalReturn = encodeEgmanCardText({
    category: "Character",
    name: "C.C.",
    effect: "[When Played] Choose up to one character with 3000 or less BP on your opponent's front line and {return it to their hand}. If the chosen character is resting, {sideline it} instead.",
    trigger: ""
  });
  assert.equal(conditionalReturn.coverage.unsupported.length, 0);
  assert.equal(conditionalReturn.fields.abilities[0].effect.kind, "targetConditional");
  assert.equal(conditionalReturn.fields.abilities[0].effect.effect.kind, "sidelineTargets");
  assert.equal(conditionalReturn.fields.abilities[0].effect.elseEffect.kind, "returnTargetsToHand");

  const stackReplacement = encodeEgmanCardText({
    category: "Character",
    name: "Nezuko Kamado",
    effect: "If this character is returned from your field to your hand, return this Raided character and its base card to your hand instead.",
    trigger: ""
  });
  assert.equal(stackReplacement.fields.returnRaidStackToHandOnReturn, true);
});

test("EGM encoder handles exact-three then four-or-more choose upgrades", () => {
  const encoded = encodeEgmanCardText({
    category: "Character",
    name: "Sukuna",
    effect: "[When Played] {Choose one} of the abilities listed below. If you have three <Sukuna's Finger> cards in your sideline, {Choose two} instead. If you have four or more <Sukuna's Finger> cards in your sideline, {Choose all} instead. - Draw a card. - This character gains 1000 BP until the end of the turn. - Choose up to one character with 3500 or less BP on your opponent's front line and sideline it.",
    trigger: ""
  });

  const effect = encoded.fields.abilities[0].effect;
  assert.equal(encoded.coverage.unsupported.length, 0);
  assert.equal(effect.kind, "conditional");
  assert.deepEqual(effect.condition, {
    zone: "sideline",
    zoneCountMin: 4,
    filter: { name: "Sukuna's Finger" }
  });
  assert.equal(effect.effect.kind, "chooseN");
  assert.equal(effect.effect.max, 3);
  assert.equal(effect.elseEffect.effect.kind, "chooseN");
  assert.equal(effect.elseEffect.effect.max, 2);
});

test("EGM encoder handles period-form optional choose-one clauses", () => {
  const encoded = encodeEgmanCardText({
    category: "Character",
    name: "Choi Jong-in",
    effect: "[When Attacking] You may choose one of the following. If you do, this character remains set to resting the next time it would be switched to active. - Activate this character's [When Played] ability. - Choose up to one character with 2000 or less BP on your opponent's front line and sideline it.",
    trigger: ""
  });

  const effect = encoded.fields.abilities[0].effect;
  assert.equal(encoded.coverage.unsupported.length, 0);
  assert.equal(effect.kind, "optional");
  assert.equal(effect.effect.kind, "sequence");
  assert.equal(effect.effect.effects[0].kind, "chooseOne");
  assert.equal(effect.effect.effects[0].choices.length, 2);
  assert.equal(effect.effect.effects[1].kind, "restTargets");
  assert.equal(effect.effect.effects[1].target, "self");
});

test("EGM encoder handles return-cost choose-one clauses", () => {
  const encoded = encodeEgmanCardText({
    category: "Character",
    name: "Silverfang",
    effect: "[Activate: Main] [If on the Front Line] Return one other character on your field to your hand. If you do, choose one of the abilities listed below. You can only activate this <Silverfang> ability one time each turn. - Switch this character to active. - This character gains 1500 BP until the end of the turn.",
    trigger: ""
  });

  const effect = encoded.fields.abilities[0].effect;
  assert.equal(encoded.coverage.unsupported.length, 0);
  assert.equal(effect.kind, "sequence");
  assert.equal(effect.effects[0].kind, "returnTargetsToHandOrSelf");
  assert.equal(effect.effects[0].target.otherThanSource, true);
  assert.equal(effect.effects[1].kind, "chooseOne");
});

test("EGM encoder gates choose-one clauses behind optional AP payment", () => {
  const encoded = encodeEgmanCardText({
    category: "Character",
    name: "Yami Sukehiro",
    effect: "[When Played] You may pay 1 AP. If you do, choose one of the following: - Choose up to one Raided card on your opponent's front line and place its top Raided card into their sideline. - Draw two cards.",
    trigger: ""
  });

  const effect = encoded.fields.abilities[0].effect;
  assert.equal(encoded.coverage.unsupported.length, 0);
  assert.equal(effect.kind, "optional");
  assert.equal(effect.choiceKey, "optionalPayAp");
  assert.equal(effect.effect.kind, "sequence");
  assert.equal(effect.effect.effects[0].kind, "payAp");
  assert.equal(effect.effect.effects[1].kind, "chooseOne");
});

test("EGM encoder handles raid, movement, opponent-activation, and sideline-to-hand triggers", () => {
  const kurama = encodeEgmanCardText({
    category: "Character",
    name: "Kurama",
    effect: "When performing Raid on this character, if you have three or less cards in your hand, draw a card. (Resolve the Raided character's [When Played] ability and this ability in any order you want.)",
    trigger: ""
  }).fields;
  assert.deepEqual(kurama.abilities[0].conditions, { handSizeMax: 3 });
  assert.equal(kurama.abilities[0].timing, TIMINGS.WHEN_RAIDED);
  assert.equal(kurama.abilities[0].effect.kind, "draw");

  const hange = encodeEgmanCardText({
    category: "Character",
    name: "Hange",
    effect: "[When Played] You may choose one active [Inheritor of the Titan] or [Pure Titan] affinity card on your field or your opponent's field and switch it to resting. If you do, the player whose character was switched to resting with this ability draws a card.",
    trigger: ""
  }).fields;
  assert.equal(hange.abilities[0].effect.kind, "restTargetsThen");
  assert.deepEqual(hange.abilities[0].effect.target.affinities, ["inheritor of the titan", "pure titan"]);
  assert.equal(hange.abilities[0].effect.effect.kind, "drawLastRestedTargetControllers");

  const tafuku = encodeEgmanCardText({
    category: "Character",
    name: "Tafuku Mihara",
    effect: "[When Played] Choose up to one <Hiyuki Kagari> on your field. It gains 1000 BP until the end of the turn. If your opponent has 3 or less life, it also gains \"When this character's attack is not blocked, draw a card\" until the end of the turn.",
    trigger: ""
  }).fields;
  const tafukuEffects = tafuku.abilities[0].effect.effects;
  assert.ok(tafukuEffects.some((effect) => effect.kind === "modifyBp"));
  assert.ok(tafukuEffects.some((effect) => effect.kind === "conditional" && effect.condition.opponentLifeMax === 3));

  const zora = encodeEgmanCardText({
    category: "Character",
    name: "Zora Ideale",
    effect: "[If on the Front Line] [Once Per Turn] When your opponent activates an [Activate: Main] ability, if you have another [Black Bulls] affinity card on your field, draw a card.",
    trigger: ""
  }).fields;
  assert.equal(zora.abilities[0].timing, TIMINGS.WHEN_OPPONENT_ACTIVATE_MAIN_ABILITY);
  assert.equal(zora.abilities[0].conditions.line, LINES.FRONT);
  assert.equal(zora.abilities[0].conditions.otherThanSource, true);

  const lisbeth = encodeEgmanCardText({
    category: "Character",
    name: "Lisbeth",
    effect: "[During Your Turn] [Once Per Turn] When a character on your field moves outside of your movement phase, you may draw a card. If you do, place one card from your hand into your sideline.",
    trigger: ""
  }).fields;
  assert.equal(lisbeth.abilities[0].timing, TIMINGS.WHEN_OWN_CHARACTER_MOVES_OUTSIDE_MOVEMENT_PHASE);
  assert.equal(lisbeth.abilities[0].effect.kind, "optional");

  const esil = encodeEgmanCardText({
    category: "Character",
    name: "Esil",
    effect: "When this card is added from your sideline to your hand by one of your abilities, draw a card, then place one card from your hand into your sideline.",
    trigger: ""
  }).fields;
  assert.equal(esil.abilities[0].timing, TIMINGS.WHEN_SIDELINE_TO_HAND_BY_ABILITY);
  assert.deepEqual(esil.abilities[0].conditions, { zone: "hand" });

  const lu = encodeEgmanCardText({
    category: "Character",
    name: "Lu Shaotang",
    effect: "[During Your Turn] If you have three or more [Sakamoto's] affinity cards with unique card names on your field, this character gains \"This character cannot be blocked by a character with 4000 or more BP.\"   When this character attacks and is not blocked, draw a card.",
    trigger: ""
  }).fields;
  assert.equal(lu.abilities[0].timing, TIMINGS.WHEN_ATTACK_UNBLOCKED);
  assert.equal(lu.abilities[0].effect.kind, "draw");

  const ken = encodeEgmanCardText({
    category: "Character",
    name: "Ken Kaneki",
    effect: "This character can only be played by performing Raid with it. [Raid] <Ken Kaneki> Switch to active. May move to the front line. [Impact (1)] (When this character attacks and wins a battle, deal 1 damage to your opponent.) [Damage (2)] (Direct damage dealt by this character's attacks deals 2 damage.) At the end of your opponent's attack phase, perform: \"Add one card from your life to your hand\" or \"Sideline this character, then draw a card.\"",
    trigger: ""
  }).fields;
  assert.equal(ken.abilities[0].timing, TIMINGS.END_OF_ATTACK_PHASE);
  assert.deepEqual(ken.abilities[0].conditions, { turn: "opponent" });
  assert.equal(ken.abilities[0].effect.kind, "chooseOne");
  assert.equal(ken.abilities[0].effect.choices[1].effect.effects[1].kind, "draw");
});

test("sideline-to-hand triggers resolve when a card is added by your ability", () => {
  const shadowFields = encodeEgmanCardText({
    category: "Character",
    name: "Shadow",
    effect: "When this card is added from your sideline to your hand by one of your abilities, draw a card.",
    trigger: ""
  }).fields;
  const retrieveFields = encodeEgmanCardText({
    category: "Event",
    name: "Retrieve Shadow",
    effect: "Add one <Shadow> card from your sideline to your hand.",
    trigger: ""
  }).fields;
  const catalog = {
    ...sampleCatalog,
    private_shadow: {
      id: "private_shadow",
      number: "DEM-1-190",
      sourceCode: "DEM",
      name: "Shadow",
      type: CARD_TYPES.CHARACTER,
      color: "purple",
      requiredEnergy: { color: "purple", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "purple", amount: 1 }],
      affinities: [],
      ...shadowFields
    },
    private_retrieve_shadow: {
      id: "private_retrieve_shadow",
      number: "DEM-1-191",
      sourceCode: "DEM",
      name: "Retrieve Shadow",
      type: CARD_TYPES.EVENT,
      color: "purple",
      requiredEnergy: { color: "purple", amount: 0 },
      apCost: 0,
      energy: [],
      affinities: [],
      ...retrieveFields
    }
  };
  let game = createGame({ catalog, decks: { P1: sampleDeckList, P2: sampleDeckList }, skipShuffle: true, validateDecks: false });
  game.phase = PHASES.MAIN;
  game.activePlayer = "P1";
  game.players.P1.hand = [{ uid: "retrieve-shadow-card", owner: "P1", defId: "private_retrieve_shadow", faceUp: true }];
  game.players.P1.sideline = [{ uid: "shadow-card", owner: "P1", defId: "private_shadow", faceUp: true }];
  game.players.P1.deck.unshift({ uid: "shadow-draw-card", owner: "P1", defId: "demo_extra", faceUp: true });

  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0 });

  assert.equal(game.players.P1.hand.length, 2);
  assert.ok(game.players.P1.hand.some((card) => card.defId === "private_shadow"));
  assert.ok(game.players.P1.hand.some((card) => card.uid === "shadow-draw-card"));
});

test("movement triggers resolve only outside the movement phase", () => {
  const catalog = {
    ...sampleCatalog,
    private_move_watcher: {
      ...sampleCatalog.demo_rookie,
      id: "private_move_watcher",
      number: "DEM-1-192",
      name: "Move Watcher",
      abilities: [{
        id: "move-watch-draw",
        timing: TIMINGS.WHEN_OWN_CHARACTER_MOVES_OUTSIDE_MOVEMENT_PHASE,
        oncePerTurn: true,
        effect: { kind: "draw", amount: 1 }
      }]
    },
    private_move_event: {
      id: "private_move_event",
      number: "DEM-1-193",
      sourceCode: "DEM",
      name: "Move Event",
      type: CARD_TYPES.EVENT,
      color: "blue",
      requiredEnergy: { color: "blue", amount: 0 },
      apCost: 0,
      energy: [],
      affinities: [],
      eventEffect: {
        kind: "moveTargetsToLine",
        destinationLine: LINES.FRONT,
        target: { controller: "self", line: LINES.ENERGY, type: CARD_TYPES.CHARACTER, max: 1 }
      }
    }
  };
  let game = createGame({ catalog, decks: { P1: sampleDeckList, P2: sampleDeckList }, skipShuffle: true, validateDecks: false });
  game.phase = PHASES.MAIN;
  game.activePlayer = "P1";
  game.players.P1.hand = [{ uid: "move-event-card", owner: "P1", defId: "private_move_event", faceUp: true }];
  game.players.P1.deck.unshift({ uid: "move-draw-card", owner: "P1", defId: "demo_extra", faceUp: true });
  game.players.P1.frontLine = [testPermanent("move-watcher", "P1", "private_move_watcher")];
  game.players.P1.energyLine = [testPermanent("move-target", "P1", "demo_guardian")];

  game = applyAction(game, { type: "playCard", player: "P1", handIndex: 0 });
  assert.ok(game.players.P1.hand.some((card) => card.uid === "move-draw-card"));

  let movementGame = createGame({ catalog, decks: { P1: sampleDeckList, P2: sampleDeckList }, skipShuffle: true, validateDecks: false });
  movementGame.phase = PHASES.MOVEMENT;
  movementGame.activePlayer = "P1";
  movementGame.players.P1.hand = [];
  movementGame.players.P1.deck.unshift({ uid: "movement-phase-draw-card", owner: "P1", defId: "demo_extra", faceUp: true });
  movementGame.players.P1.frontLine = [testPermanent("move-watcher-2", "P1", "private_move_watcher")];
  movementGame.players.P1.energyLine = [testPermanent("move-target-2", "P1", "demo_guardian")];

  movementGame = applyAction(movementGame, {
    type: "moveCharacters",
    player: "P1",
    moves: [{ from: LINES.ENERGY, index: 0, to: LINES.FRONT }]
  });
  assert.equal(movementGame.players.P1.hand.length, 0);
});

test("opponent activate-main triggers and affected-player rest draws resolve", () => {
  const zoraFields = encodeEgmanCardText({
    category: "Character",
    name: "Zora Ideale",
    effect: "[If on the Front Line] [Once Per Turn] When your opponent activates an [Activate: Main] ability, if you have another [Black Bulls] affinity card on your field, draw a card.",
    trigger: ""
  }).fields;
  const hangeFields = encodeEgmanCardText({
    category: "Character",
    name: "Hange",
    effect: "[When Played] You may choose one active [Inheritor of the Titan] or [Pure Titan] affinity card on your field or your opponent's field and switch it to resting. If you do, the player whose character was switched to resting with this ability draws a card.",
    trigger: ""
  }).fields;
  const catalog = {
    ...sampleCatalog,
    private_blank_activator: {
      ...sampleCatalog.demo_rookie,
      id: "private_blank_activator",
      number: "DEM-1-194",
      name: "Blank Activator",
      abilities: [{ id: "blank-main", timing: TIMINGS.ACTIVATE_MAIN, effect: { kind: "none" } }]
    },
    private_zora: {
      ...sampleCatalog.demo_rookie,
      id: "private_zora",
      number: "DEM-1-195",
      name: "Zora Ideale",
      affinities: ["black bulls"],
      ...zoraFields
    },
    private_black_bulls: {
      ...sampleCatalog.demo_guardian,
      id: "private_black_bulls",
      number: "DEM-1-196",
      name: "Black Bulls Ally",
      affinities: ["black bulls"]
    },
    private_hange: {
      ...sampleCatalog.demo_rookie,
      id: "private_hange",
      number: "DEM-1-197",
      name: "Hange",
      ...hangeFields
    },
    private_titan: {
      ...sampleCatalog.demo_guardian,
      id: "private_titan",
      number: "DEM-1-198",
      name: "Titan Target",
      affinities: ["inheritor of the titan"]
    }
  };

  let zoraGame = createGame({ catalog, decks: { P1: sampleDeckList, P2: sampleDeckList }, skipShuffle: true, validateDecks: false });
  zoraGame.phase = PHASES.MAIN;
  zoraGame.activePlayer = "P1";
  zoraGame.players.P1.frontLine = [testPermanent("blank-activator", "P1", "private_blank_activator")];
  zoraGame.players.P2.frontLine = [testPermanent("zora", "P2", "private_zora")];
  zoraGame.players.P2.energyLine = [testPermanent("black-bulls", "P2", "private_black_bulls")];
  zoraGame.players.P2.deck.unshift({ uid: "zora-draw-card", owner: "P2", defId: "demo_extra", faceUp: true });

  zoraGame = applyAction(zoraGame, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: "blank-main"
  });
  assert.ok(zoraGame.players.P2.hand.some((card) => card.uid === "zora-draw-card"));

  let hangeGame = createGame({ catalog, decks: { P1: sampleDeckList, P2: sampleDeckList }, skipShuffle: true, validateDecks: false });
  hangeGame.phase = PHASES.MAIN;
  hangeGame.activePlayer = "P1";
  hangeGame.players.P1.hand = [{ uid: "hange-card", owner: "P1", defId: "private_hange", faceUp: true }];
  hangeGame.players.P2.frontLine = [testPermanent("titan-target", "P2", "private_titan")];
  hangeGame.players.P2.deck.unshift({ uid: "hange-draw-card", owner: "P2", defId: "demo_extra", faceUp: true });

  hangeGame = applyAction(hangeGame, { type: "playCard", player: "P1", handIndex: 0, destination: LINES.FRONT });
  assert.equal(hangeGame.players.P2.frontLine[0].rested, true);
  assert.ok(hangeGame.players.P2.hand.some((card) => card.uid === "hange-draw-card"));
});

test("end-of-opponent-attack-phase choose-one effects resolve", () => {
  const kenFields = encodeEgmanCardText({
    category: "Character",
    name: "Ken Kaneki",
    effect: "This character can only be played by performing Raid with it. [Raid] <Ken Kaneki> Switch to active. May move to the front line. [Impact (1)] (When this character attacks and wins a battle, deal 1 damage to your opponent.) [Damage (2)] (Direct damage dealt by this character's attacks deals 2 damage.) At the end of your opponent's attack phase, perform: \"Add one card from your life to your hand\" or \"Sideline this character, then draw a card.\"",
    trigger: ""
  }).fields;
  const catalog = {
    ...sampleCatalog,
    private_ken: {
      ...sampleCatalog.demo_guardian,
      id: "private_ken",
      number: "DEM-1-199",
      name: "Ken Kaneki",
      ...kenFields
    }
  };
  let game = createGame({ catalog, decks: { P1: sampleDeckList, P2: sampleDeckList }, skipShuffle: true, validateDecks: false });
  game.phase = PHASES.ATTACK;
  game.activePlayer = "P2";
  game.players.P1.frontLine = [testPermanent("ken", "P1", "private_ken")];
  game.players.P1.life = [{ uid: "ken-life-card", owner: "P1", defId: "demo_extra", faceUp: false }];

  game = applyAction(game, { type: "advancePhase", player: "P2" });

  assert.equal(game.players.P1.life.length, 0);
  assert.ok(game.players.P1.hand.some((card) => card.uid === "ken-life-card"));
  assert.equal(game.players.P1.frontLine.length, 1);
});

test("field-to-deck, reveal-hand, and face-up-count templates resolve", () => {
  const psychic = encodeEgmanCardText({
    category: "Event",
    name: "Psychic Ability",
    effect: "Draw two cards. Your opponent reveals all the cards in their hand.",
    trigger: ""
  }).fields;
  assert.ok(psychic.eventEffect.effects.some((effect) => effect.kind === "revealOpponentHand"));

  const eren = encodeEgmanCardText({
    category: "Character",
    name: "Eren Jaeger",
    effect: "[When Attacking] Place up to one other [104th Cadet Corps] affinity card on your front line on the top of your deck. If your front line is not full, play up to one red card with 3 or less required energy, 1 AP cost, and [104th Cadet Corps] affinity from your hand set to active onto your front line. That character gains \"At the end of the attack phase, return this character to your hand\" until the end of the turn.",
    trigger: ""
  }).fields;
  assert.ok(eren.abilities[0].effect.effects.some((effect) => effect.kind === "moveTargetsToDeck" && effect.position === "top"));

  const heisuke = encodeEgmanCardText({
    category: "Character",
    name: "Heisuke Mashimo",
    effect: "[Activate: Main] [Once Per Turn] If there are a combined total of three or more face-up cards in your and your opponent's decks and life areas, this character gains [Impact (1)] until the end of the turn.",
    trigger: ""
  }).fields;
  assert.deepEqual(heisuke.abilities[0].effect.condition, { faceUpDeckOrLifeCountMin: 3 });

  const catalog = {
    ...sampleCatalog,
    private_deck_event: {
      id: "private_deck_event",
      number: "DEM-1-200",
      sourceCode: "DEM",
      name: "Deck Event",
      type: CARD_TYPES.EVENT,
      color: "red",
      requiredEnergy: { color: "red", amount: 0 },
      apCost: 0,
      energy: [],
      affinities: [],
      eventEffect: {
        kind: "moveTargetsToDeck",
        position: "top",
        target: { controller: "self", line: LINES.FRONT, type: CARD_TYPES.CHARACTER, otherThanSource: false, max: 1 }
      }
    },
    private_heisuke: {
      ...sampleCatalog.demo_rookie,
      id: "private_heisuke",
      number: "DEM-1-201",
      name: "Heisuke Mashimo",
      abilities: heisuke.abilities
    }
  };

  let deckGame = createGame({ catalog, decks: { P1: sampleDeckList, P2: sampleDeckList }, skipShuffle: true, validateDecks: false });
  deckGame.phase = PHASES.MAIN;
  deckGame.activePlayer = "P1";
  deckGame.players.P1.hand = [{ uid: "deck-event-card", owner: "P1", defId: "private_deck_event", faceUp: true }];
  deckGame.players.P1.frontLine = [testPermanent("deck-target", "P1", "demo_guardian")];
  deckGame = applyAction(deckGame, { type: "playCard", player: "P1", handIndex: 0 });
  assert.equal(deckGame.players.P1.frontLine.length, 0);
  assert.equal(deckGame.players.P1.deck[0].uid, "deck-target-card");

  let conditionGame = createGame({ catalog, decks: { P1: sampleDeckList, P2: sampleDeckList }, skipShuffle: true, validateDecks: false });
  conditionGame.phase = PHASES.MAIN;
  conditionGame.activePlayer = "P1";
  conditionGame.players.P1.frontLine = [testPermanent("heisuke", "P1", "private_heisuke")];
  for (const playerId of ["P1", "P2"]) {
    for (const card of [...conditionGame.players[playerId].deck, ...conditionGame.players[playerId].life]) {
      card.faceUp = false;
    }
  }
  conditionGame.players.P1.deck[0].faceUp = true;
  conditionGame.players.P1.life[0].faceUp = true;
  conditionGame = applyAction(conditionGame, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: "activateMain-1"
  });
  assert.equal(conditionGame.players.P1.frontLine[0].keywordModifiers.some((modifier) => modifier.keyword === "impact"), false);

  let activeConditionGame = createGame({ catalog, decks: { P1: sampleDeckList, P2: sampleDeckList }, skipShuffle: true, validateDecks: false });
  activeConditionGame.phase = PHASES.MAIN;
  activeConditionGame.activePlayer = "P1";
  activeConditionGame.players.P1.frontLine = [testPermanent("heisuke-active", "P1", "private_heisuke")];
  for (const playerId of ["P1", "P2"]) {
    for (const card of [...activeConditionGame.players[playerId].deck, ...activeConditionGame.players[playerId].life]) {
      card.faceUp = false;
    }
  }
  activeConditionGame.players.P1.deck[0].faceUp = true;
  activeConditionGame.players.P1.life[0].faceUp = true;
  activeConditionGame.players.P2.deck[0].faceUp = true;
  activeConditionGame = applyAction(activeConditionGame, {
    type: "activateMainAbility",
    player: "P1",
    line: LINES.FRONT,
    index: 0,
    abilityId: "activateMain-1"
  });
  assert.equal(activeConditionGame.players.P1.frontLine[0].keywordModifiers.some((modifier) => modifier.keyword === "impact"), true);
});

test("EGM encoder preserves keyword grants without executing reminder text", () => {
  const conditional = encodeEgmanCardText({
    category: "Character",
    name: "Conditional Finisher",
    effect: "[When Played] If <Leader> is on your field, this character gains \"Your opponent must block this character's attacks if able\" and [Impact (1)] (When this character attacks and wins a battle, deal 1 damage to your opponent) until the end of the turn.",
    trigger: ""
  }).fields;
  const conditionalEffects = flattenEffectTree(conditional.abilities[0].effect);
  assert.deepEqual(conditionalEffects.filter((effect) => effect.kind === "grantKeyword").map((effect) => effect.keyword), [
    "mustBlock",
    "impact"
  ]);
  assert.equal(conditionalEffects.some((effect) => effect.kind === "damageOpponent"), false);

  const choice = encodeEgmanCardText({
    category: "Character",
    name: "Choice Finisher",
    effect: "[When Attacking] Choose one of the following: - This character gains 1000 BP until the end of the turn. - This character gains [Damage (2)] (When this character attacks and deals direct damage, deal 2 damage instead) until the end of the turn.",
    trigger: ""
  }).fields;
  const choiceEffects = flattenEffectTree(choice.abilities[0].effect);
  assert.ok(choiceEffects.some((effect) => effect.kind === "grantKeyword" && effect.keyword === "damage" && effect.value === 2));
  assert.equal(choiceEffects.some((effect) => effect.kind === "damageOpponent"), false);

  const nextTurnBuff = encodeEgmanCardText({
    category: "Character",
    name: "Persistent Defender",
    effect: "[When Played] This character gains 2000 BP until the start of your next turn.",
    trigger: ""
  }).fields;
  assert.equal(flattenEffectTree(nextTurnBuff.abilities[0].effect).find((effect) => effect.kind === "modifyBp").duration, "startOfNextTurn");
});

test("EGM encoder handles conditional blocker limits and multi-card play-or-Raid", () => {
  const leafa = encodeEgmanCardText({
    category: "Character",
    name: "Leafa",
    effect: "[Raid] <Leafa> Switch to active. May move to the front line. If you have five or more cards in your hand, this character cannot be blocked by a character with 4000 or more BP.",
    trigger: ""
  }).fields;
  assert.deepEqual(leafa.staticKeywordModifiers, [{
    keyword: "cantBeBlockedByBpMin",
    value: 4000,
    condition: { handSizeMin: 5 }
  }]);

  const event = encodeEgmanCardText({
    category: "Event",
    name: "Warrior Reinforcements",
    effect: "Play up to two green character cards with 4 or more required energy and 1 AP cost from your hand set to active onto your front line or perform Raid with them on characters on your field.",
    trigger: ""
  }).fields.eventEffect;
  assert.equal(event.kind, "playOrRaidCardFromZone");
  assert.equal(event.count, 2);
  assert.equal(event.allowRaid, true);
});

test("multi-card play-or-Raid resolves both selected Raid cards", () => {
  const base = {
    ...sampleCatalog.demo_rookie,
    id: "private_raid_base",
    number: "FAQ-RAID-BASE",
    name: "Raid Base"
  };
  const raid = (id, number) => ({
    ...sampleCatalog.demo_raider,
    id,
    number,
    name: "Raid Upgrade",
    raid: { names: ["Raid Base"], affinities: [] },
    abilities: []
  });
  const catalog = {
    ...sampleCatalog,
    private_raid_base: base,
    private_raid_one: raid("private_raid_one", "FAQ-RAID-1"),
    private_raid_two: raid("private_raid_two", "FAQ-RAID-2"),
    private_multi_raid_event: {
      id: "private_multi_raid_event",
      number: "FAQ-RAID-EVENT",
      sourceCode: "FAQ",
      name: "Multi Raid Event",
      type: CARD_TYPES.EVENT,
      color: "green",
      requiredEnergy: { color: "green", amount: 0 },
      apCost: 0,
      energy: [],
      affinities: [],
      eventEffect: {
        kind: "playOrRaidCardFromZone",
        zones: ["hand"],
        count: 2,
        simultaneous: true,
        allowRaid: true,
        rested: false,
        destinationLine: LINES.FRONT,
        choiceKey: "playZoneIndex",
        filter: { type: CARD_TYPES.CHARACTER }
      }
    }
  };
  let game = createGame({ catalog, decks: { P1: sampleDeckList, P2: sampleDeckList }, skipShuffle: true, validateDecks: false });
  game.phase = PHASES.MAIN;
  game.activePlayer = "P1";
  game.players.P1.frontLine = [
    testPermanent("raid-base-one", "P1", "private_raid_base"),
    testPermanent("raid-base-two", "P1", "private_raid_base")
  ];
  game.players.P1.hand = [
    { uid: "multi-raid-event", owner: "P1", defId: "private_multi_raid_event", faceUp: true },
    { uid: "multi-raid-one", owner: "P1", defId: "private_raid_one", faceUp: true },
    { uid: "multi-raid-two", owner: "P1", defId: "private_raid_two", faceUp: true }
  ];

  game = applyAction(game, {
    type: "playCard",
    player: "P1",
    handIndex: 0,
    choices: {
      playZoneIndex: [0, 1],
      performRaid: [true, true],
      raidTarget: [
        { lineName: LINES.FRONT, index: 0 },
        { lineName: LINES.FRONT, index: 1 }
      ],
      simultaneousPlayedOrder: [0, 1]
    }
  });

  assert.equal(game.players.P1.frontLine[0].cards.at(-1).defId, "private_raid_one");
  assert.equal(game.players.P1.frontLine[1].cards.at(-1).defId, "private_raid_two");
  assert.equal(game.players.P1.frontLine[0].rested, false);
  assert.equal(game.players.P1.frontLine[1].rested, false);
});

test("Impact plus starts at one when the character has no base Impact", () => {
  const catalog = {
    ...sampleCatalog,
    private_impact_plus: {
      ...sampleCatalog.demo_rookie,
      id: "private_impact_plus",
      number: "FAQ-IMPACT-PLUS",
      keywords: { impactPlus: 1 }
    },
    private_impact_and_plus: {
      ...sampleCatalog.demo_rookie,
      id: "private_impact_and_plus",
      number: "FAQ-IMPACT-BOTH",
      keywords: { impact: 1, impactPlus: 1 }
    }
  };
  const game = createGame({ catalog, decks: { P1: sampleDeckList, P2: sampleDeckList }, skipShuffle: true, validateDecks: false });
  const defender = testPermanent("impact-defender", "P2", "demo_rookie");
  assert.equal(internals.impactDamageAmount(game, testPermanent("impact-plus", "P1", "private_impact_plus"), defender), 1);
  assert.equal(internals.impactDamageAmount(game, testPermanent("impact-both", "P1", "private_impact_and_plus"), defender), 2);
});

test("EGM encoder covers alternate names and newly audited static rule families", () => {
  const aliases = encodeEgmanCardText({
    name: "Kirito & Eugeo",
    category: "Character",
    effect: "This card is also treated as <Kirito> and <Eugeo>.",
    trigger: ""
  }).fields;
  assert.deepEqual(aliases.alternateNames, ["Kirito", "Eugeo"]);

  const kenshin = encodeEgmanCardText({
    name: "Kenshin Himura",
    category: "Character",
    effect: "[During Your Turn] Your opponent's characters that lose to this character in battle move to their energy line instead of being sidelined.",
    trigger: ""
  }).fields;
  assert.equal(kenshin.battleLosersToEnergyInstead, true);

  const shikijo = encodeEgmanCardText({
    name: "Shikijo",
    category: "Character",
    effect: "[During Your Turn] [If on the Front Line] If an <Aoshi Shinomori> leaves your field due to one of your opponent's abilities, you may sideline this active character instead.",
    trigger: ""
  }).fields;
  assert.deepEqual(shikijo.opponentAbilityLeaveReplacement, {
    protectedName: "Aoshi Shinomori",
    requiresActive: true,
    during: "controllerTurn",
    line: LINES.FRONT
  });

  const zushi = encodeEgmanCardText({
    name: "Zushi",
    category: "Character",
    effect: "[During Your Turn] [Once Per Turn] When this character's BP is increased, it gains 1000 BP until the end of the turn.",
    trigger: ""
  }).fields;
  assert.equal(zushi.abilities[0].timing, TIMINGS.WHEN_BP_INCREASED);
  assert.equal(zushi.abilities[0].oncePerTurn, true);
});
