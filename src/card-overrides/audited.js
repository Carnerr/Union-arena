import { CARD_TYPES, LINES, TIMINGS } from "../constants.js";

const auditedOverrides = {
  "UE02BT_HTR-1-084": {
    abilities: [{
      id: "whenPlayed-1",
      timing: TIMINGS.WHEN_PLAYED,
      oncePerTurn: false,
      conditions: {},
      effect: {
        kind: "searchTopDeck",
        count: 4,
        max: 1,
        destination: "hand",
        revealSelected: true,
        filter: { type: CARD_TYPES.CHARACTER },
        selectedAlternative: {
          choiceKey: "searchPlayInstead",
          allowRaid: true,
          rested: false,
          destinationLines: [LINES.FRONT, LINES.ENERGY],
          destinationLineChoiceKey: "destinationLine",
          filter: {
            type: CARD_TYPES.CHARACTER,
            apCost: 1,
            requiredEnergyFulfilled: true
          }
        }
      }
    }]
  },
  "UE03BT_JJK-1-098": {
    eventEffect: {
      kind: "sequence",
      effects: [
        { kind: "suppressPlayedAbilities" },
        {
          kind: "moveTargetsToBottomDeck",
          target: {
            controller: "opponent",
            line: LINES.FRONT,
            type: CARD_TYPES.CHARACTER,
            bpMax: 5000,
            max: 1
          }
        },
        {
          kind: "playCardFromZone",
          player: "opponent",
          zone: "hand",
          min: 0,
          max: 1,
          rested: true,
          destinationLine: LINES.FRONT,
          choiceKey: "opponentPlayHandIndex",
          filter: {
            type: CARD_TYPES.CHARACTER,
            requiredEnergyMax: 3
          }
        },
        {
          kind: "conditional",
          condition: { fieldCountMin: 1, filter: { name: "Aoi Todo" } },
          effect: { kind: "draw", amount: 1 }
        }
      ]
    }
  },
  "UE13BT_YYH-1-025": {
    abilities: [{
      id: "whenPlayed-1",
      timing: TIMINGS.WHEN_PLAYED,
      oncePerTurn: false,
      conditions: {},
      effect: {
        kind: "sequence",
        effects: [
          {
            kind: "modifyBp",
            amount: -1000,
            duration: "turn",
            target: {
              controller: "opponent",
              line: LINES.FRONT,
              type: CARD_TYPES.CHARACTER,
              all: true
            }
          },
          {
            kind: "sidelineTargets",
            target: {
              controller: "opponent",
              line: LINES.FRONT,
              type: CARD_TYPES.CHARACTER,
              bpMax: 4000,
              max: 1
            }
          }
        ]
      }
    }]
  },
  "UE13BT_YYH-1-067": {
    eventEffect: {
      kind: "sequence",
      effects: [
        {
          kind: "playOrRaidCardFromZone",
          zones: ["sideline"],
          choiceKey: "genkaiSidelineIndex",
          raidChoiceKey: "performRaid",
          raidTargetChoiceKey: "raidTarget",
          allowRaid: true,
          nonRaidDestination: "hand",
          filter: { name: "Genkai", apCost: 1 }
        },
        {
          kind: "conditional",
          condition: { equalEnergyGenerationWithOpponent: true },
          effect: { kind: "readyAp", amount: 1 }
        }
      ]
    }
  },
  "UE17BT_SLG-1-011": {
    abilities: [
      {
        id: "whenPlayed-1",
        timing: TIMINGS.WHEN_PLAYED,
        oncePerTurn: false,
        conditions: {},
        effect: { kind: "moveTopDeck", count: 1, destination: "sideline" }
      },
      {
        id: "whenSidelineToHandByAbility-1",
        timing: TIMINGS.WHEN_SIDELINE_TO_HAND_BY_ABILITY,
        oncePerTurn: false,
        conditions: { zone: "hand" },
        effect: {
          kind: "optional",
          choiceKey: "optionalSelfPlay",
          default: true,
          effect: {
            kind: "playSourceFromZone",
            source: "hand",
            requiredEnergyFulfilled: true,
            rested: true,
            activeIfTriggerSourceName: "Sung Jinwoo",
            destinationLines: [LINES.FRONT, LINES.ENERGY],
            destinationLineChoiceKey: "destinationLine"
          }
        }
      }
    ]
  },
  "UE17BT_SLG-1-051": {
    abilities: [{
      id: "whenPlayed-1",
      timing: TIMINGS.WHEN_PLAYED,
      oncePerTurn: false,
      conditions: {},
      effect: {
        kind: "chooseOne",
        choiceKey: "effectChoice",
        choices: [
          {
            id: "choice-1",
            effect: {
              kind: "moveCardBetweenZones",
              source: "sideline",
              destination: "hand",
              count: 1,
              filter: { type: CARD_TYPES.CHARACTER, requiredEnergyMax: 2 }
            }
          },
          {
            id: "choice-2",
            effect: {
              kind: "optional",
              choiceKey: "payForSidelineRaid",
              default: true,
              effect: {
                kind: "sequence",
                effects: [
                  { kind: "payAp", amount: 1 },
                  { kind: "moveHandToZone", amount: 1, destination: "sideline" },
                  {
                    kind: "playOrRaidCardFromZone",
                    zones: ["sideline"],
                    choiceKey: "sungJinwooSidelineIndex",
                    raidTargetChoiceKey: "raidTarget",
                    allowRaid: true,
                    forceRaid: true,
                    filter: {
                      type: CARD_TYPES.CHARACTER,
                      color: "green",
                      name: "Sung Jinwoo",
                      requiredEnergyMin: 4,
                      requiredEnergyMax: 4
                    }
                  }
                ]
              }
            }
          }
        ]
      }
    }]
  },
  "UE19BT_SMD-1-025": {
    abilities: [{
      id: "whenPlayed-1",
      timing: TIMINGS.WHEN_PLAYED,
      oncePerTurn: false,
      conditions: {},
      effect: {
        kind: "sequence",
        effects: [
          {
            kind: "grantKeyword",
            keyword: "abilityProtection",
            value: {
              actions: ["sideline", "bpReduction"],
              source: "any"
            },
            duration: "startOfNextTurn",
            target: "self"
          },
          {
            kind: "grantKeyword",
            keyword: "targetingRestriction",
            value: {
              mode: "prohibit",
              sourceTypes: [CARD_TYPES.CHARACTER, CARD_TYPES.EVENT]
            },
            duration: "startOfNextTurn",
            target: {
              controller: "self",
              line: "field",
              type: CARD_TYPES.CHARACTER,
              max: 1
            }
          }
        ]
      }
    }]
  },
  "UE20BT_TSK-1-053": {
    abilities: [{
      id: "whenPlayed-1",
      timing: TIMINGS.WHEN_PLAYED,
      oncePerTurn: false,
      conditions: {},
      effect: {
        kind: "conditional",
        condition: {
          anyOf: [
            {
              zone: "sideline",
              zoneCountMin: 4,
              filter: { type: CARD_TYPES.CHARACTER, bpMin: 4000 }
            },
            {
              zone: "sideline",
              zoneCountMin: 4,
              filter: { type: CARD_TYPES.EVENT }
            }
          ]
        },
        effect: {
          kind: "chooseOne",
          choiceKey: "rimuruSidelineMode",
          choices: [
            {
              id: "add-to-hand",
              effect: {
                kind: "moveCardBetweenZones",
                source: "sideline",
                destination: "hand",
                choiceKey: "rimuruSidelineIndex",
                min: 0,
                count: 1,
                filter: {
                  type: CARD_TYPES.CHARACTER,
                  color: "blue",
                  requiredEnergyMax: 4,
                  apCost: 1
                }
              }
            },
            {
              id: "play-or-raid",
              effect: {
                kind: "playOrRaidCardFromZone",
                zones: ["sideline"],
                choiceKey: "rimuruSidelineIndex",
                raidChoiceKey: "performRaid",
                raidTargetChoiceKey: "raidTarget",
                min: 0,
                max: 1,
                count: 1,
                allowRaid: true,
                rested: false,
                destinationLines: [LINES.FRONT, LINES.ENERGY],
                destinationLineChoiceKey: "destinationLine",
                filter: {
                  type: CARD_TYPES.CHARACTER,
                  color: "blue",
                  requiredEnergyMax: 4,
                  apCost: 1
                }
              }
            }
          ]
        },
        elseEffect: {
          kind: "moveCardBetweenZones",
          source: "sideline",
          destination: "hand",
          choiceKey: "rimuruSidelineIndex",
          min: 0,
          count: 1,
          filter: {
            type: CARD_TYPES.CHARACTER,
            color: "blue",
            requiredEnergyMax: 4,
            apCost: 1
          }
        }
      }
    }]
  },
  "UE20BT_TSK-2-029": {
    abilities: [{
      id: "activateMain-1",
      timing: TIMINGS.ACTIVATE_MAIN,
      oncePerTurn: false,
      conditions: {},
      cost: { restSelf: true, sidelineSelf: true },
      effect: {
        kind: "sequence",
        effects: [
          { kind: "suppressPlayedAbilities" },
          {
            kind: "playOrRaidCardFromZone",
            zones: ["hand"],
            count: 1,
            rested: false,
            destinationLines: [LINES.FRONT, LINES.ENERGY],
            destinationLineChoiceKey: "destinationLine",
            choiceKey: "playZoneIndex",
            raidChoiceKey: "performRaid",
            raidTargetChoiceKey: "raidTarget",
            allowRaid: true,
            requiredPlayedCountForFollowing: 1,
            filter: {
              type: CARD_TYPES.CHARACTER,
              color: "purple",
              requiredEnergyMax: 3,
              apCost: 1
            }
          },
          {
            kind: "playCardFromZone",
            player: "opponent",
            zone: "hand",
            min: 0,
            max: 1,
            rested: false,
            destinationLine: LINES.FRONT,
            choiceKey: "opponentPlayHandIndex",
            filter: {
              type: CARD_TYPES.CHARACTER,
              requiredEnergyMax: 2,
              apCost: 1
            }
          }
        ]
      }
    }]
  }
};

export function auditedCardEncodingOverride(card) {
  const code = String(card?.card_code ?? card?.cardCode ?? card?.number ?? "").toUpperCase();
  const override = auditedOverrides[code];
  return override ? structuredClone(override) : undefined;
}
