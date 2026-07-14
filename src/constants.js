export const PLAYERS = Object.freeze(["P1", "P2"]);

export const CARD_TYPES = Object.freeze({
  CHARACTER: "character",
  SITE: "site",
  EVENT: "event"
});

export const PHASES = Object.freeze({
  SETUP: "setup",
  START: "start",
  MOVEMENT: "movement",
  MAIN: "main",
  ATTACK: "attack",
  END: "end",
  GAME_OVER: "game_over"
});

export const LINES = Object.freeze({
  FRONT: "frontLine",
  ENERGY: "energyLine"
});

export const TRIGGER_TYPES = Object.freeze({
  NONE: "none",
  DRAW: "draw",
  GET: "get",
  ACTIVE: "active",
  SPECIAL: "special",
  COLOR: "color",
  RAID: "raid",
  FINAL: "final"
});

export const TIMINGS = Object.freeze({
  WHEN_PLAYED: "whenPlayed",
  WHEN_ATTACKING: "whenAttacking",
  WHEN_ATTACK_BLOCKED: "whenAttackBlocked",
  WHEN_ATTACK_WINS_BATTLE: "whenAttackWinsBattle",
  WHEN_ATTACK_LOSES_BATTLE: "whenAttackLosesBattle",
  WHEN_ATTACK_UNBLOCKED: "whenAttackUnblocked",
  WHEN_OWN_CHARACTER_ATTACKS: "whenOwnCharacterAttacks",
  WHEN_OWN_CHARACTER_ATTACK_WINS_BATTLE: "whenOwnCharacterAttackWinsBattle",
  WHEN_OWN_CHARACTER_ATTACK_LOSES_BATTLE: "whenOwnCharacterAttackLosesBattle",
  WHEN_OWN_CHARACTER_ATTACK_UNBLOCKED: "whenOwnCharacterAttackUnblocked",
  WHEN_OWN_CHARACTER_ATTACK_ENDS: "whenOwnCharacterAttackEnds",
  WHEN_OWN_FRONT_CHARACTER_RESTED_BY_ABILITY: "whenOwnFrontCharacterRestedByAbility",
  WHEN_LIFE_TO_SIDELINE_NO_TRIGGER: "whenLifeToSidelineNoTrigger",
  WHEN_BLOCKING: "whenBlocking",
  WHEN_SIDELINED: "whenSidelined",
  WHEN_LEAVES_FIELD: "whenLeavesField",
  WHEN_RETURNED_TO_HAND: "whenReturnedToHand",
  WHEN_SELF_DECK_TO_SIDELINE_BY_ABILITY: "whenSelfDeckToSidelineByAbility",
  WHEN_HAND_TO_SIDELINE_BY_ABILITY: "whenHandToSidelineByAbility",
  WHEN_SIDELINE_TO_HAND_BY_ABILITY: "whenSidelineToHandByAbility",
  WHEN_CHOSEN_BY_ABILITY: "whenChosenByAbility",
  WHEN_OWN_CHARACTER_SIDELINED: "whenOwnCharacterSidelined",
  WHEN_OPPONENT_CHARACTER_SIDELINED: "whenOpponentCharacterSidelined",
  WHEN_OWN_CHARACTER_MOVES_OUTSIDE_MOVEMENT_PHASE: "whenOwnCharacterMovesOutsideMovementPhase",
  WHEN_OPPONENT_ACTIVATE_MAIN_ABILITY: "whenOpponentActivateMainAbility",
  WHEN_BP_INCREASED: "whenBpIncreased",
  WHEN_RAIDED: "whenRaided",
  START_OF_TURN: "startOfTurn",
  START_OF_ATTACK_PHASE: "startOfAttackPhase",
  END_OF_ATTACK_PHASE: "endOfAttackPhase",
  END_OF_ATTACK: "endOfAttack",
  START_OF_END_PHASE: "startOfEndPhase",
  ACTIVATE_MAIN: "activateMain"
});

export const MAX_LINE_SIZE = 4;
export const MAX_AP_CARDS = 3;
export const STARTING_HAND_SIZE = 7;
export const STARTING_LIFE = 7;
export const MAX_HAND_AT_END = 8;

export function opponentOf(playerId) {
  return playerId === "P1" ? "P2" : "P1";
}

export function requiredApCards(playerId, playerTurnNumber) {
  if (playerTurnNumber >= 3) return 3;
  if (playerId === "P1") return playerTurnNumber === 1 ? 1 : 2;
  return 2;
}
