import { expandDeckList, localCardNumber, normalizeDeckList, sourceCodeFromNumber, validateDeck } from "./deck.js";
import { assertRule } from "./errors.js";

const DECK_LINE_PATTERNS = [
  /^\s*(\d+)\s*x\s*([A-Za-z0-9_/-]+)\s*$/i,
  /^\s*(\d+)\s+([A-Za-z0-9_/-]+)\s*$/i,
  /^\s*([A-Za-z0-9_/-]+)\s*x\s*(\d+)\s*$/i
];

export function parseDeckText(text, catalog, options = {}) {
  const {
    validate = true,
    strict = true
  } = options;
  const lookup = buildCatalogLookup(catalog);
  const entries = [];
  const errors = [];

  String(text ?? "")
    .split(/\r?\n/)
    .forEach((line, index) => {
      const parsed = parseDeckLine(line);
      if (!parsed) return;

      const resolved = resolveDeckCardCode(parsed.code, lookup, catalog);
      if (!resolved) {
        errors.push({
          line: index + 1,
          code: parsed.code,
          message: `Unknown card code: ${parsed.code}`
        });
        return;
      }

      entries.push({
        id: resolved.id,
        count: parsed.count,
        inputCode: parsed.code
      });
    });

  if (strict) {
    assertRule(errors.length === 0, "DECK_IMPORT", "Deck import contains unknown card codes.", { errors });
  }

  const cards = normalizeDeckList(entries).map((entry) => {
    const def = catalog[entry.id];
    return {
      id: entry.id,
      count: entry.count,
      number: def.number,
      name: def.name
    };
  });

  const summary = summarizeDeckList(cards, catalog);
  const validation = validate ? validateDeck(cards, catalog) : undefined;
  return {
    cards,
    summary,
    validation,
    errors
  };
}

export function makeSavedDeck({ id, name, cards, summary, validation, source = {} }) {
  const now = new Date().toISOString();
  return pruneUndefined({
    schema: "union-arena-local-engine/deck@1",
    id: id ?? slugifyDeckName(name),
    name,
    createdAt: now,
    updatedAt: now,
    source,
    summary,
    validation,
    cards
  });
}

export function summarizeDeckList(deckList, catalog) {
  const expanded = expandDeckList(deckList);
  const sourceCodes = new Set();
  const colorCounts = {};
  const cardNumberCounts = new Map();
  const triggerCounts = {};

  for (const cardId of expanded) {
    const def = catalog[cardId];
    if (!def) continue;
    sourceCodes.add(def.sourceCode ?? sourceCodeFromNumber(def.number));
    if (def.color) colorCounts[def.color] = (colorCounts[def.color] ?? 0) + 1;
    const cardNumber = localCardNumber(def.number);
    cardNumberCounts.set(cardNumber, (cardNumberCounts.get(cardNumber) ?? 0) + 1);
    const triggerType = def.trigger?.type ?? "none";
    triggerCounts[triggerType] = (triggerCounts[triggerType] ?? 0) + 1;
  }

  const colors = Object.entries(colorCounts)
    .sort(([aColor, aCount], [bColor, bCount]) => bCount - aCount || aColor.localeCompare(bColor))
    .map(([color]) => color);

  return {
    size: expanded.length,
    sourceCodes: [...sourceCodes],
    sourceCode: sourceCodes.size === 1 ? [...sourceCodes][0] : undefined,
    colors,
    color: colors.length === 1 ? colors[0] : undefined,
    colorCounts,
    uniqueCardNumbers: cardNumberCounts.size,
    triggerCounts
  };
}

export function slugifyDeckName(value) {
  return String(value ?? "deck")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "deck";
}

export function buildCatalogLookup(catalog) {
  const lookup = new Map();
  for (const [id, card] of Object.entries(catalog)) {
    addLookup(lookup, id, id);
    addLookup(lookup, card.number, id);
    addLookup(lookup, displayCardCode(card.number), id);
    addLookup(lookup, localCardCode(card.number), id);
  }
  return lookup;
}

export function resolveDeckCardCode(code, lookup, catalog) {
  const key = normalizeLookupKey(code);
  const matches = lookup.get(key);
  if (!matches || matches.size === 0) return undefined;
  if (matches.size > 1 && catalog) {
    const equivalent = collapseEquivalentMatches([...matches], catalog);
    if (equivalent) return { id: equivalent };
  }
  assertRule(matches.size === 1, "DECK_IMPORT", `Ambiguous card code: ${code}`, {
    code,
    matches: [...matches]
  });
  return { id: [...matches][0] };
}

export function displayCardCode(number) {
  const text = String(number ?? "");
  if (!text.includes("_")) return text;
  const [setCode, local] = text.split(/_(.+)/);
  return `${setCode}/${local}`;
}

function parseDeckLine(line) {
  const trimmed = stripComment(line).trim();
  if (!trimmed) return undefined;
  if (/^(main deck|deck|sideboard|side deck)$/i.test(trimmed)) return undefined;

  for (const pattern of DECK_LINE_PATTERNS) {
    const match = trimmed.match(pattern);
    if (!match) continue;
    const firstIsCount = /^\d+$/.test(match[1]);
    return {
      count: Number(firstIsCount ? match[1] : match[2]),
      code: firstIsCount ? match[2] : match[1]
    };
  }

  throw new Error(`Could not parse deck line: ${line}`);
}

function stripComment(line) {
  return String(line ?? "")
    .replace(/\s*\/\/.*$/, "")
    .replace(/\s*#.*$/, "");
}

function addLookup(lookup, value, id) {
  const key = normalizeLookupKey(value);
  if (!key) return;
  const matches = lookup.get(key) ?? new Set();
  matches.add(id);
  lookup.set(key, matches);
}

function normalizeLookupKey(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\\/]+/g, "_")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function localCardCode(number) {
  return String(number ?? "").split("_").at(-1).split("/").at(-1);
}

function collapseEquivalentMatches(matches, catalog) {
  const signatures = new Map();
  for (const id of matches) {
    signatures.set(id, equivalentCardSignature(catalog[id]));
  }
  if (new Set(signatures.values()).size !== 1) return undefined;
  return matches.sort(preferredEquivalentId)[0];
}

function equivalentCardSignature(card) {
  return JSON.stringify({
    name: card.name,
    type: card.type,
    color: card.color,
    requiredEnergy: card.requiredEnergy,
    apCost: card.apCost,
    bp: card.bp,
    energy: card.energy,
    affinities: card.affinities,
    keywords: card.keywords,
    trigger: card.trigger,
    abilities: card.abilities,
    staticModifiers: card.staticModifiers,
    staticFieldModifiers: card.staticFieldModifiers,
    staticEnergyModifiers: card.staticEnergyModifiers,
    staticKeywordModifiers: card.staticKeywordModifiers,
    useCostModifiers: card.useCostModifiers,
    staticUseCostModifiers: card.staticUseCostModifiers,
    entersActive: card.entersActive,
    entersActiveCondition: card.entersActiveCondition,
    raid: card.raid,
    eventEffect: card.eventEffect
  });
}

function preferredEquivalentId(a, b) {
  const aScore = equivalentPreferenceScore(a);
  const bScore = equivalentPreferenceScore(b);
  return bScore - aScore || a.localeCompare(b);
}

function equivalentPreferenceScore(id) {
  if (/_bt_/i.test(id)) return 2;
  if (/_st_/i.test(id)) return 1;
  return 0;
}

function pruneUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
