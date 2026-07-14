import { TRIGGER_TYPES } from "./constants.js";
import { assertRule } from "./errors.js";

const LIMITED_TRIGGER_TYPES = new Set([
  TRIGGER_TYPES.SPECIAL,
  TRIGGER_TYPES.COLOR,
  TRIGGER_TYPES.FINAL
]);

const COPY_LIMIT_OVERRIDES = new Map([
  ["HTR-1-026", 3],
  ["HTR-1-029", 3],
  ["SLG-1-030", 12],
  ["JJK-3-072", 3],
  ["HTR-2-011", 14]
]);

export function copyLimitForCardNumber(cardNumber) {
  return COPY_LIMIT_OVERRIDES.get(localCardNumber(cardNumber)) ?? 4;
}

export function sourceCodeFromNumber(cardNumber) {
  return localCardNumber(cardNumber).split("-").at(0).toUpperCase();
}

export function localCardNumber(cardNumber) {
  const text = String(cardNumber ?? "");
  return text.includes("/")
    ? text.split("/").at(-1)
    : text.includes("_")
      ? text.split("_").at(-1)
      : text;
}

export function normalizeDeckList(deckList) {
  const counts = new Map();
  for (const entry of deckList) {
    if (typeof entry === "string") {
      counts.set(entry, (counts.get(entry) ?? 0) + 1);
    } else {
      counts.set(entry.id, (counts.get(entry.id) ?? 0) + entry.count);
    }
  }
  return [...counts.entries()].map(([id, count]) => ({ id, count }));
}

export function expandDeckList(deckList) {
  if (deckList.every((entry) => typeof entry === "string")) {
    return [...deckList];
  }

  const expanded = [];
  for (const entry of normalizeDeckList(deckList)) {
    for (let i = 0; i < entry.count; i += 1) {
      expanded.push(entry.id);
    }
  }
  return expanded;
}

export function validateDeck(deckList, catalog) {
  const expanded = expandDeckList(deckList);
  assertRule(expanded.length === 50, "DECK_SIZE", "A Union Arena deck must contain exactly 50 cards.", {
    size: expanded.length
  });

  const sourceCodes = new Set();
  const cardNumberCounts = new Map();
  const limitedTriggerCounts = new Map();
  const cardNumberLimits = new Map();

  for (const cardId of expanded) {
    const def = catalog[cardId];
    assertRule(def, "UNKNOWN_CARD", `Deck contains unknown card id: ${cardId}`, { cardId });

    const sourceCode = sourceCodeFromNumber(def.number);
    sourceCodes.add(sourceCode);
    const cardNumber = localCardNumber(def.number);
    cardNumberCounts.set(cardNumber, (cardNumberCounts.get(cardNumber) ?? 0) + 1);
    cardNumberLimits.set(cardNumber, def.deckCopyLimit ?? copyLimitForCardNumber(cardNumber));

    const triggerType = def.trigger?.type ?? TRIGGER_TYPES.NONE;
    if (LIMITED_TRIGGER_TYPES.has(triggerType)) {
      limitedTriggerCounts.set(triggerType, (limitedTriggerCounts.get(triggerType) ?? 0) + 1);
    }
  }

  assertRule(sourceCodes.size === 1, "SOURCE_CODE", "All cards in a deck must share the same source material code.", {
    sourceCodes: [...sourceCodes]
  });

  for (const [number, count] of cardNumberCounts) {
    const limit = cardNumberLimits.get(number) ?? copyLimitForCardNumber(number);
    assertRule(count <= limit, "COPY_LIMIT", `No more than ${limit} cards with the same card number may be included.`, {
      number,
      count,
      limit
    });
  }

  for (const [triggerType, count] of limitedTriggerCounts) {
    assertRule(count <= 4, "TRIGGER_LIMIT", "Special, color, and final triggers are limited to four cards per trigger type.", {
      triggerType,
      count
    });
  }

  return {
    size: expanded.length,
    sourceCode: [...sourceCodes][0],
    uniqueCardNumbers: cardNumberCounts.size
  };
}
