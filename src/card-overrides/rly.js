const CHARACTER = "character";

function ability(id, timing, effect, options = {}) {
  return {
    id,
    timing,
    oncePerTurn: false,
    ...options,
    effect
  };
}

function selfCharacterTarget(options = {}) {
  return {
    type: CHARACTER,
    max: 1,
    controller: "self",
    line: "field",
    ...options
  };
}

function opponentFrontTarget(options = {}) {
  return {
    type: CHARACTER,
    max: 1,
    controller: "opponent",
    line: "frontLine",
    ...options
  };
}

function handDiscardCost(choiceKey) {
  return {
    kind: "moveHandToZone",
    amount: 1,
    destination: "sideline",
    choiceKey
  };
}

function noEffect() {
  return { kind: "none" };
}

function searchThenDiscard(otherThanName, filter = {}) {
  return {
    kind: "sequence",
    effects: [
      {
        kind: "searchTopDeck",
        count: 3,
        max: 1,
        destination: "hand",
        revealSelected: true,
        filter: {
          type: CHARACTER,
          ...(otherThanName ? { otherThanName } : {}),
          ...filter
        }
      },
      {
        kind: "conditional",
        condition: { lastSearchSelectedMin: 1 },
        effect: handDiscardCost("rlySearchDiscard")
      }
    ]
  };
}

const rentaroUniqueNames = {
  uniqueFieldNameCountMin: 3,
  filter: { type: CHARACTER, otherThanName: "Rentaro Aijo" }
};

const rentaroSixUniqueNames = {
  uniqueFieldNameCountMin: 6,
  filter: { type: CHARACTER, otherThanName: "Rentaro Aijo" }
};

const rlyOverrides = {
  "RLY-1-001": {
    abilities: [ability("whenPlayed-1", "whenPlayed", searchThenDiscard("Rentaro Aijo"))]
  },
  "RLY-1-002": {
    replaceParsedKeywords: true,
    keywords: {},
    staticModifiers: [{
      bp: 1000,
      condition: { allOf: [{ turn: "controller" }, rentaroUniqueNames] }
    }],
    staticKeywordModifiers: [
      { keyword: "impact", value: 1, condition: rentaroSixUniqueNames },
      { keyword: "damage", value: 2, condition: rentaroSixUniqueNames }
    ]
  },
  "RLY-1-008": {
    abilities: [ability("whenPlayed-1", "whenPlayed", {
      kind: "optionalChoiceUpgrade",
      choiceKey: "rly008Discard",
      default: true,
      requiredMovedFromHand: 1,
      costEffect: handDiscardCost("rly008DiscardIndex"),
      baseEffect: noEffect(),
      upgradedEffect: {
        kind: "chooseOne",
        choiceKey: "rly008Choice",
        choices: [
          {
            id: "rest-opponent",
            effect: { kind: "restTargets", target: opponentFrontTarget({ choiceKey: "rly008RestTarget" }) }
          },
          {
            id: "ready-own",
            effect: {
              kind: "readyTargets",
              target: selfCharacterTarget({ otherThanSource: true, choiceKey: "rly008ReadyTarget" })
            }
          }
        ]
      }
    })]
  },
  "RLY-1-009": {
    abilities: [ability("whenPlayed-1", "whenPlayed", {
      kind: "optional",
      choiceKey: "rly009Sideline",
      default: true,
      effect: {
        kind: "sequence",
        effects: [
          {
            kind: "sidelineTargets",
            target: opponentFrontTarget({ bpMax: 4000, choiceKey: "rly009Target" })
          },
          {
            kind: "conditional",
            condition: { lastSidelinedTargetCountMin: 1 },
            effect: {
              kind: "opponentMayDraw",
              amount: 1,
              amountIf: {
                condition: { lastSidelinedBpMin: 3500 },
                amount: 2,
                sourceChoiceKey: "rly009Target"
              },
              choiceKey: "rly009OpponentDraw"
            }
          }
        ]
      }
    })]
  },
  "RLY-1-015": {
    abilities: [ability("activateMain-1", "activateMain", {
      kind: "sequence",
      effects: [
        {
          kind: "modifyBp",
          amount: 2000,
          duration: "turn",
          target: selfCharacterTarget({ otherThanSource: true, choiceKey: "rly015Target" })
        },
        { kind: "draw", amount: 1 }
      ]
    }, { cost: { restSelf: true, sidelineSelf: true } })]
  },
  "RLY-1-016": {
    abilities: [ability("activateMain-1", "activateMain", {
      kind: "sequence",
      effects: [
        { kind: "grantEnergy", color: "yellow", amount: 1, duration: "turn", target: "self" },
        { kind: "scheduleSidelineSelfAtEndOfMain" }
      ]
    }, { oncePerTurn: true, cost: { restSelf: true } })]
  },
  "RLY-1-024": {
    abilities: [ability("whenPlayed-1", "whenPlayed", {
      kind: "sequence",
      effects: [
        { kind: "draw", amount: 1 },
        { kind: "lookTopDeckAndMove", count: 1, destinations: ["top", "bottom"], defaultDestination: "top" }
      ]
    })]
  },
  "RLY-1-025": {
    abilities: [
      ability("activateMain-1", "activateMain", {
        kind: "reduceRequiredEnergy",
        amount: 1,
        sourceZone: "hand",
        expires: "endOfTurn",
        filter: { type: CHARACTER, affinity: "Hanazono Family" }
      }, {
        oncePerTurn: true,
        conditions: { line: "frontLine" },
        cost: { discardFromHand: 1 }
      }),
      ability("whenAttacking-2", "whenAttacking", {
        kind: "searchTopDeck",
        count: 1,
        max: 1,
        destination: "hand",
        revealSelected: true,
        remainingDestinations: ["top", "bottom"],
        defaultRemainingDestination: "top",
        filter: { affinity: "Hanazono Family" }
      })
    ]
  },
  "RLY-1-031": {
    abilities: [
      ability("whenPlayed-1", "whenPlayed", {
        kind: "reduceNextUseApCost",
        amount: 1,
        sourceZones: ["hand"],
        expires: "endOfTurn",
        filter: { name: "Hakari Hanazono" }
      }),
      ability("whenAttacking-2", "whenAttacking", {
        kind: "modifyBp",
        amount: 1000,
        duration: "turn",
        target: selfCharacterTarget({ affinity: "Hanazono Family", choiceKey: "rly031Target" })
      })
    ]
  },
  "RLY-1-032": {
    abilities: [
      ability("whenPlayed-1", "whenPlayed", {
        kind: "chooseOne",
        choiceKey: "rly032Choice",
        choices: [
          {
            id: "deck",
            effect: {
              kind: "searchTopDeck",
              count: 5,
              max: 1,
              destination: "hand",
              revealSelected: true,
              filter: { name: "Hakari Hanazono", withoutRaid: true }
            }
          },
          {
            id: "sideline",
            effect: {
              kind: "moveCardBetweenZones",
              source: "sideline",
              destination: "hand",
              count: 1,
              choiceKey: "rly032SidelineIndex",
              filter: { name: "Hakari Hanazono", withoutRaid: true }
            }
          }
        ]
      }),
      ability("whenAttacking-2", "whenAttacking", {
        kind: "readyTargets",
        target: selfCharacterTarget({ name: "Hakari Hanazono", choiceKey: "rly032ReadyTarget" })
      }, { oncePerTurn: true })
    ]
  },
  "RLY-1-033": {
    abilities: [ability("whenPlayed-1", "whenPlayed", {
      kind: "searchTopDeck",
      count: 2,
      max: 1,
      destination: "hand",
      revealSelected: true,
      remainingDestinations: ["top", "bottom"],
      defaultRemainingDestination: "top",
      filter: { affinity: "Hanazono Family" }
    })]
  },
  "RLY-1-034": {
    staticModifiers: [],
    eventEffect: {
      kind: "sidelineTargets",
      target: opponentFrontTarget({
        min: 1,
        bpMax: 3000,
        bpMaxBonuses: [{ amount: 2000, condition: { namedOnField: "Hakari Hanazono" } }],
        choiceKey: "rly034Target"
      })
    }
  },
  "RLY-1-035": {
    eventEffect: {
      kind: "sequence",
      effects: [
        {
          kind: "searchTopDeck",
          count: 3,
          max: 1,
          destination: "hand",
          revealSelected: true,
          filter: { color: "yellow" }
        },
        {
          kind: "conditional",
          condition: {
            lastSearchSelectedMin: 1,
            lastSearchSelectedCardFilter: { requiredEnergyMax: 1 }
          },
          effect: { kind: "readyAp", amount: 1 }
        }
      ]
    }
  },
  "RLY-1-036": {
    eventEffect: {
      kind: "sequence",
      effects: [
        {
          kind: "replacementOrUseRestriction",
          useRestrictions: [{
            kind: "condition",
            condition: {
              allOf: [
                { namedOnField: "Karane Inda" },
                { namedOnField: "Hakari Hanazono" }
              ]
            }
          }]
        },
        {
          kind: "sidelineTargets",
          target: selfCharacterTarget({
            name: "Hakari Hanazono",
            min: 1,
            choiceKey: "rly036OwnTarget"
          })
        },
        {
          kind: "sidelineTargets",
          target: opponentFrontTarget({
            bpMaxFromLastSidelined: true,
            bpMaxFromChoiceKey: "rly036OwnTarget",
            choiceKey: "rly036OpponentTarget"
          })
        },
        { kind: "draw", amount: 2 }
      ]
    }
  },
  "RLY-1-037": {
    replaceParsedKeywords: true,
    keywords: {},
    staticModifiers: [],
    eventEffect: {
      kind: "chooseN",
      choiceKey: "rly037Choices",
      min: 1,
      max: 1,
      maxIf: { condition: { namedOnField: "Hahari Hanazono" }, value: 2 },
      defaultCount: 1,
      choices: [
        {
          id: "sideline",
          effect: { kind: "sidelineTargets", target: opponentFrontTarget({ bpMax: 5000, min: 1, choiceKey: "rly037Target" }) }
        },
        { id: "draw", effect: { kind: "draw", amount: 2 } },
        { id: "ap", effect: { kind: "readyAp", amount: 1 } },
        {
          id: "bp",
          effect: {
            kind: "modifyBp",
            amount: 3000,
            duration: "turn",
            target: selfCharacterTarget({ choiceKey: "rly037BpTarget" })
          }
        }
      ]
    }
  },
  "RLY-1-038": {
    eventEffect: {
      kind: "predictTopDeckRequiredEnergy",
      choiceKey: "rly038Prediction",
      successEffect: {
        kind: "sequence",
        effects: [
          {
            kind: "readyTargets",
            target: selfCharacterTarget({ choiceKey: "rly038Character" })
          },
          { kind: "readyAp", amount: 1 },
          {
            kind: "modifyBp",
            amount: 1000,
            duration: "turn",
            target: selfCharacterTarget({ choiceKey: "rly038Character" })
          }
        ]
      }
    }
  },
  "RLY-1-039": {
    replaceParsedKeywords: true,
    keywords: {},
    staticModifiers: [],
    eventEffect: {
      kind: "chooseOne",
      choiceKey: "rly039Choice",
      choices: [
        {
          id: "sideline",
          effect: { kind: "sidelineTargets", target: opponentFrontTarget({ bpMax: 4000, min: 1, choiceKey: "rly039OpponentTarget" }) }
        },
        {
          id: "karane",
          effect: {
            kind: "sequence",
            effects: [
              {
                kind: "modifyBp",
                amount: 2000,
                duration: "turn",
                target: selfCharacterTarget({ name: "Karane Inda", choiceKey: "rly039KaraneTarget" })
              },
              {
                kind: "grantKeyword",
                keyword: "impactPlus",
                value: 1,
                duration: "turn",
                target: selfCharacterTarget({ name: "Karane Inda", choiceKey: "rly039KaraneTarget" })
              },
              {
                kind: "grantKeyword",
                keyword: "damagePlus",
                value: 1,
                duration: "turn",
                target: selfCharacterTarget({ name: "Karane Inda", choiceKey: "rly039KaraneTarget" })
              }
            ]
          }
        }
      ]
    }
  },
  "RLY-1-040": {
    eventEffect: {
      kind: "searchTopDeck",
      count: 6,
      max: 2,
      destination: "hand",
      revealSelected: true,
      uniqueNames: true,
      filter: { type: CHARACTER, otherThanName: "Rentaro Aijo" }
    }
  },
  "RLY-1-042": {
    abilities: [ability("whenPlayed-1", "whenPlayed", searchThenDiscard("Rentaro Aijo"))]
  },
  "RLY-1-043": {
    abilities: [
      ability("whenPlayed-1", "whenPlayed", {
        kind: "modifyBp",
        amount: 500,
        duration: "turn",
        target: {
          type: CHARACTER,
          controller: "self",
          line: "frontLine",
          max: 4,
          uniqueNames: true,
          otherThanName: "Rentaro Aijo",
          choiceKey: "rly043Targets"
        }
      }),
      ability("whenAttacking-2", "whenAttacking", {
        kind: "modifyBp",
        amount: 500,
        duration: "turn",
        target: {
          type: CHARACTER,
          controller: "self",
          line: "frontLine",
          max: 4,
          uniqueNames: true,
          otherThanName: "Rentaro Aijo",
          choiceKey: "rly043Targets"
        }
      })
    ]
  },
  "RLY-1-046": {
    abilities: [ability("whenPlayed-1", "whenPlayed", {
      kind: "opponentMayDraw",
      amount: 1,
      choiceKey: "rly046OpponentDraw"
    })]
  },
  "RLY-1-051": {
    replaceParsedKeywords: true,
    keywords: {},
    staticKeywordModifiers: [{
      keyword: "impact",
      value: 1,
      condition: {
        zone: "sideline",
        zoneCountMin: 5,
        filter: { name: "Nano Eiai" }
      }
    }]
  },
  "RLY-1-053": {
    abilities: [
      ability("whenPlayed-1", "whenPlayed", {
        kind: "sequence",
        effects: [
          { kind: "draw", amount: 1 },
          {
            kind: "optionalChoiceUpgrade",
            choiceKey: "rly053Discard",
            default: true,
            requiredMovedFromHand: 1,
            costEffect: handDiscardCost("rly053DiscardIndex"),
            baseEffect: noEffect(),
            upgradedEffect: {
              kind: "reduceNextUseApCost",
              amount: 1,
              sourceZones: ["hand"],
              expires: "endOfTurn",
              filter: { requiredEnergyMax: 3 }
            }
          }
        ]
      }),
      ability("whenAttacking-2", "whenAttacking", {
        kind: "lookTopDeckAndMove",
        count: 1,
        destinations: ["top", "sideline"],
        defaultDestination: "top"
      })
    ]
  },
  "RLY-1-055": {
    abilities: [ability("whenPlayed-1", "whenPlayed", searchThenDiscard(undefined, { type: "event" }))]
  },
  "RLY-1-058": {
    replaceParsedKeywords: true,
    keywords: { nullifyImpact: true },
    staticKeywordModifiers: [{
      keyword: "impact",
      value: 1,
      condition: { selfBpMin: 5000 }
    }],
    abilities: [ability("whenSidelined-1", "whenSidelined", {
      kind: "optionalChoiceUpgrade",
      choiceKey: "rly058Discard",
      default: true,
      requiredMovedFromHand: 1,
      costEffect: handDiscardCost("rly058DiscardIndex"),
      baseEffect: noEffect(),
      upgradedEffect: {
        kind: "moveCardBetweenZones",
        source: "sideline",
        destination: "hand",
        count: 1,
        choiceKey: "rly058SidelineIndex",
        filter: { name: "Kusuri Yakuzen", requiredEnergyMax: 3 }
      }
    })]
  },
  "RLY-1-059": {
    abilities: [
      ability("whenPlayed-1", "whenPlayed", {
        kind: "sequence",
        effects: [
          {
            kind: "optional",
            choiceKey: "rly059Reveal",
            default: true,
            effect: {
              kind: "revealHandCards",
              max: 1,
              choiceKey: "rly059RevealIndex",
              filter: { type: "event" }
            }
          },
          {
            kind: "conditional",
            condition: {
              anyOf: [
                { eventUsedCountMin: 1 },
                { lastRevealedHandCountMin: 1 }
              ]
            },
            effect: { kind: "draw", amount: 1 }
          }
        ]
      }),
      ability("activateMain-2", "activateMain", {
        kind: "moveCardBetweenZones",
        source: "sideline",
        destination: "hand",
        count: 1,
        choiceKey: "rly059SidelineIndex",
        filter: { type: "event", requiredEnergyMax: 2 }
      }, { cost: { restSelf: true, sidelineSelf: true } })
    ]
  },
  "RLY-1-060": {
    replaceParsedKeywords: true,
    keywords: {},
    staticKeywordModifiers: [{
      keyword: "impact",
      value: 1,
      condition: { selfBpMin: 4500 }
    }],
    abilities: [
      ability("whenPlayed-1", "whenPlayed", {
        kind: "moveCardBetweenZones",
        source: "sideline",
        destination: "hand",
        count: 1,
        choiceKey: "rly060SidelineIndex",
        filter: { type: "event", requiredEnergyMax: 2 }
      }),
      ability("whenAttacking-2", "whenAttacking", {
        kind: "modifyBp",
        amount: 500,
        amountPer: { kind: "eventUsedCount" },
        duration: "turn",
        target: {
          type: CHARACTER,
          controller: "self",
          line: "frontLine",
          all: true
        }
      })
    ]
  },
  "RLY-1-066": {
    abilities: [
      ability("whenPlayed-1", "whenPlayed", {
        kind: "conditional",
        condition: { lessCardsInHandThanOpponent: true },
        effect: {
          kind: "optionalChoiceUpgrade",
          choiceKey: "rly066PayAp",
          default: true,
          costEffect: { kind: "payAp", amount: 1 },
          baseEffect: noEffect(),
          upgradedEffect: {
            kind: "sequence",
            effects: [
              { kind: "drawUntilHandSize", sameAsOpponent: true },
              { kind: "restrictCardUse", sourceZones: ["hand"], expires: "endOfTurn" }
            ]
          }
        }
      }),
      ability("activateMain-2", "activateMain", {
        kind: "modifyBp",
        amount: 1000,
        duration: "turn",
        target: selfCharacterTarget({ requiredEnergyMax: 3, choiceKey: "rly066Target" })
      }, {
        oncePerTurn: true,
        conditions: { line: "frontLine" },
        cost: { discardFromHand: 1 }
      })
    ]
  },
  "RLY-1-067": {
    replaceParsedKeywords: true,
    keywords: { cantBeBlockedByRequiredEnergyMin: 4 }
  },
  "RLY-1-071": {
    abilities: [ability("activateMain-1", "activateMain", {
      kind: "sequence",
      effects: [
        { kind: "grantEnergy", color: "green", amount: 1, duration: "turn", target: "self" },
        { kind: "scheduleSidelineSelfAtEndOfMain" }
      ]
    }, { oncePerTurn: true, cost: { restSelf: true } })]
  },
  "RLY-1-074": {
    abilities: [ability("activateMain-1", "activateMain", { kind: "draw", amount: 1 }, {
      conditions: { eventUsedCountMin: 1 },
      cost: { restSelf: true }
    })]
  },
  "RLY-1-075": {
    eventEffect: {
      kind: "conditional",
      condition: {
        zone: "sideline",
        zoneCountMin: 5,
        filter: { name: "Nano Eiai" }
      },
      effect: {
        kind: "searchTopDeck",
        count: 9,
        max: 2,
        destination: "hand",
        revealSelected: true,
        filter: { type: CHARACTER }
      },
      elseEffect: {
        kind: "searchTopDeck",
        count: 4,
        max: 1,
        destination: "hand",
        revealSelected: true,
        filter: { type: CHARACTER }
      }
    }
  },
  "RLY-1-077": {
    eventEffect: {
      kind: "sidelineTargets",
      target: opponentFrontTarget({
        min: 1,
        bpMax: 3000,
        bpMaxBonuses: [{ amount: 2000, condition: { namedOnField: "Nano Eiai" } }],
        choiceKey: "rly077Target"
      })
    }
  },
  "RLY-1-078": {
    replaceParsedKeywords: true,
    keywords: {},
    staticModifiers: [],
    eventEffect: {
      kind: "sequence",
      effects: [
        {
          kind: "modifyBp",
          amount: 1500,
          duration: "turn",
          target: {
            type: CHARACTER,
            controller: "self",
            line: "field",
            requiredEnergyMax: 3,
            all: true
          }
        },
        {
          kind: "grantKeyword",
          keyword: "impactPlus",
          value: 1,
          duration: "turn",
          target: selfCharacterTarget({ name: "Shizuka Yoshimoto", choiceKey: "rly078Target" })
        }
      ]
    }
  },
  "RLY-1-079": {
    staticModifiers: [],
    eventEffect: {
      kind: "sequence",
      effects: [
        {
          kind: "modifyBp",
          amount: 1000,
          duration: "turn",
          target: selfCharacterTarget({ choiceKey: "rly079Target" })
        },
        {
          kind: "moveCardBetweenZones",
          source: "sideline",
          destination: "hand",
          count: 1,
          choiceKey: "rly079SidelineIndex",
          filter: { type: CHARACTER, differentNameFromChoiceKey: "rly079Target" }
        }
      ]
    }
  },
  "RLY-1-080": {
    replaceParsedKeywords: true,
    keywords: {},
    staticModifiers: [],
    eventEffect: {
      kind: "sequence",
      effects: [
        {
          kind: "modifyBp",
          amount: 3000,
          duration: "turn",
          target: selfCharacterTarget({ choiceKey: "rly080Target" })
        },
        {
          kind: "grantKeyword",
          keyword: "snipe",
          value: true,
          duration: "turn",
          target: selfCharacterTarget({ choiceKey: "rly080Target" })
        },
        {
          kind: "conditional",
          condition: { namedOnField: "Kusuri Yakuzen" },
          effect: {
            kind: "optionalChoiceUpgrade",
            choiceKey: "rly080Discard",
            default: true,
            requiredMovedFromHand: 1,
            costEffect: handDiscardCost("rly080DiscardIndex"),
            baseEffect: noEffect(),
            upgradedEffect: {
              kind: "reduceNextUseApCost",
              amount: 1,
              sourceZones: ["hand"],
              expires: "endOfTurn",
              filter: { type: "event", requiredEnergyMax: 2 }
            }
          }
        }
      ]
    }
  },
  "RLY-1-081": {
    eventEffect: {
      kind: "sidelineTargets",
      target: opponentFrontTarget({
        min: 1,
        bpMax: 3000,
        bpMaxBonuses: [{
          amountPerFieldMatch: 1000,
          condition: { namedOnField: "Shizuka Yoshimoto" },
          controller: "self",
          line: "frontLine",
          filter: { type: CHARACTER, requiredEnergyMax: 3 }
        }],
        choiceKey: "rly081Target"
      })
    }
  }
};

export function rlyCardEncodingOverride(card) {
  const code = String(card?.card_code ?? card?.cardCode ?? card?.number ?? "").toUpperCase();
  const override = rlyOverrides[code];
  return override ? structuredClone(override) : undefined;
}
