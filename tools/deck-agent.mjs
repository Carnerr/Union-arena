#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  analyzeSetupHand,
  applyAction,
  catalogGameResult,
  createSimulationGame,
  expandDeckList,
  loadCatalogJson,
  loadDeckJson,
  makeRng,
  normalizeDeckList,
  runAutoplayGame,
  sourceCodeFromNumber,
  validateDeck
} from "../src/index.js";

const DEFAULT_CATALOG = "work/private/egman-unionarena-catalog.json";
const DEFAULT_LIBRARY = "work/private/decks";
const DEFAULT_OUT_DIR = "work/private/deck-agent";
const DEFAULT_ADVISOR_MEMORY = "work/private/deck-agent/advisor-memory.json";
const LIMITED_TRIGGERS = new Set(["special", "color", "final"]);

const command = process.argv[2];

try {
  switch (command) {
    case "evaluate":
      evaluateCommand();
      break;
    case "optimize":
      optimizeCommand();
      break;
    case "solve":
      solveCommand();
      break;
    case "import-advice":
      importAdviceCommand();
      break;
    case "help":
    case "--help":
    case undefined:
      usage();
      process.exit(command ? 0 : 1);
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(error.message);
  if (error.details) console.error(JSON.stringify(error.details, null, 2));
  process.exit(1);
}

function evaluateCommand() {
  const config = readConfig({
    outDir: option("--out-dir") ?? join(DEFAULT_OUT_DIR, `${timestamp()}-evaluate`)
  });
  const deckId = requiredOption("--deck");
  const deck = loadSavedDeck(config.libraryDir, deckId);
  const opponents = loadOpponents(config.libraryDir, opponentsText(deckId));
  const evaluation = evaluateDeck({
    catalog: config.catalog,
    deck: deck.cards,
    opponents,
    games: config.games,
    seed: config.seed,
    validateDecks: config.validateDecks,
    autoMulliganBricks: config.autoMulliganBricks,
    maxTurns: config.maxTurns,
    maxActions: config.maxActions,
    pilotPolicy: config.pilotPolicy,
    opponentPilotPolicy: config.opponentPilotPolicy
  });

  const report = {
    schema: "union-arena-local-engine/deck-agent-report@1",
    mode: "evaluate",
    createdAt: new Date().toISOString(),
    config: printableConfig(config),
    deck: deckSummary(deckId, deck.cards, config.catalog),
    opponents: opponents.map((opponent) => opponent.id),
    result: evaluation.summary,
    games: evaluation.rows
  };

  writeReport(config.outDir, report, [{
    candidateId: deckId,
    generation: 0,
    ...evaluation.summary
  }], evaluation.rows, deck.cards, config.catalog);
  console.log(`Evaluated ${deckId} into ${config.outDir}`);
  printSummary(evaluation.summary);
}

function optimizeCommand() {
  const config = readConfig({
    outDir: option("--out-dir") ?? join(DEFAULT_OUT_DIR, `${timestamp()}-optimize`)
  });
  const baseId = requiredOption("--base");
  const baseDeck = loadSavedDeck(config.libraryDir, baseId);
  const opponents = loadOpponents(config.libraryDir, opponentsText(baseId));
  const populationSize = Number(option("--population") ?? 8);
  const generations = Number(option("--generations") ?? 3);
  const eliteCount = Math.max(1, Number(option("--elite") ?? 2));
  const mutationSwaps = Math.max(1, Number(option("--mutation-swaps") ?? 3));
  const rng = makeRng(config.seed);
  const sourceCode = inferDeckSourceCode(baseDeck.cards, config.catalog, config.validateDecks);
  const pool = mutationPool(config.catalog, sourceCode);

  let population = seedPopulation({
    baseDeck: baseDeck.cards,
    catalog: config.catalog,
    pool,
    rng,
    populationSize,
    mutationSwaps,
    validateDecks: config.validateDecks,
    advisorMemory: config.advisorMemory
  });
  const rankings = [];
  const seen = new Set();
  let best = null;

  for (let generation = 0; generation <= generations; generation += 1) {
    const evaluated = population.map((deck, index) => {
      const candidateId = `g${generation}-c${index}`;
      const evaluation = evaluateDeck({
        catalog: config.catalog,
        deck,
        opponents,
        games: config.games,
        seed: config.seed + generation * 100000 + index * 1000,
        validateDecks: config.validateDecks,
        autoMulliganBricks: config.autoMulliganBricks,
        maxTurns: config.maxTurns,
        maxActions: config.maxActions,
        pilotPolicy: config.pilotPolicy,
        opponentPilotPolicy: config.opponentPilotPolicy
      });
      const row = {
        generation,
        candidateId,
        signature: deckSignature(deck),
        ...evaluation.summary,
        deck
      };
      rankings.push(withoutDeck(row));
      if (!best || row.score > best.score) {
        best = row;
      }
      return row;
    }).sort((a, b) => b.score - a.score);

    console.log(`Generation ${generation}: best score ${evaluated[0].score.toFixed(2)} (${formatPercent(evaluated[0].winRate)} win rate)`);

    if (generation === generations) break;

    const elites = evaluated.slice(0, eliteCount);
    population = elites.map((candidate) => candidate.deck);
    for (const candidate of elites) seen.add(candidate.signature);

    while (population.length < populationSize) {
      const parent = elites[Math.floor(rng() * elites.length)].deck;
      const child = mutateDeck(parent, config.catalog, pool, rng, {
        swaps: mutationSwaps,
        validateDecks: config.validateDecks,
        advisorMemory: config.advisorMemory
      });
      const signature = deckSignature(child);
      if (seen.has(signature)) continue;
      seen.add(signature);
      population.push(child);
    }
  }

  const bestEvaluation = evaluateDeck({
    catalog: config.catalog,
    deck: best.deck,
    opponents,
    games: config.games,
    seed: config.seed + 9000000,
    validateDecks: config.validateDecks,
    autoMulliganBricks: config.autoMulliganBricks,
    maxTurns: config.maxTurns,
    maxActions: config.maxActions,
    pilotPolicy: config.pilotPolicy,
    opponentPilotPolicy: config.opponentPilotPolicy
  });

  const report = {
    schema: "union-arena-local-engine/deck-agent-report@1",
    mode: "optimize",
    createdAt: new Date().toISOString(),
    config: {
      ...printableConfig(config),
      base: baseId,
      opponents: opponents.map((opponent) => opponent.id),
      populationSize,
      generations,
      eliteCount,
      mutationSwaps,
      sourceCode,
      mutationPoolSize: pool.length
    },
    baseDeck: deckSummary(baseId, baseDeck.cards, config.catalog),
    best: {
      ...withoutDeck(best),
      searchScore: best.score,
      finalEvaluation: bestEvaluation.summary,
      summary: deckSummary("agent-best", best.deck, config.catalog)
    },
    rankings,
    bestGames: bestEvaluation.rows
  };

  writeReport(config.outDir, report, rankings, bestEvaluation.rows, best.deck, config.catalog);
  console.log(`Optimized from ${baseId} into ${config.outDir}`);
  printSummary(bestEvaluation.summary);
}

function solveCommand() {
  const config = readConfig({
    outDir: option("--out-dir") ?? join(DEFAULT_OUT_DIR, `${timestamp()}-solve`)
  });
  const request = {
    query: option("--query"),
    set: option("--set") ?? option("--title"),
    source: option("--source"),
    color: option("--color") ?? inferColorFromText(option("--query")),
    archetype: option("--archetype")
  };
  if (!request.query && !request.set && !request.source && !request.color && !request.archetype) {
    usage();
    throw new Error("Solve mode needs at least one of --query, --set, --source, --color, or --archetype.");
  }

  const populationSize = Number(option("--population") ?? 8);
  const generations = Number(option("--generations") ?? 3);
  const eliteCount = Math.max(1, Number(option("--elite") ?? 2));
  const mutationSwaps = Math.max(1, Number(option("--mutation-swaps") ?? 3));
  const rng = makeRng(config.seed);
  const resolved = resolveSolvePool(config.catalog, request);
  const baseline = buildSeedDeck(resolved.pool, config.catalog, rng, {
    validateDecks: config.validateDecks,
    advisorMemory: config.advisorMemory
  });
  const opponents = option("--opponents") || option("--opponents-file")
    ? loadOpponents(config.libraryDir, opponentsText())
    : [{ id: "generated-baseline", name: "Generated Baseline", cards: baseline }];

  let population = [];
  const seen = new Set();
  let attempts = 0;
  while (population.length < populationSize && attempts < populationSize * 300) {
    attempts += 1;
    const deck = buildSeedDeck(resolved.pool, config.catalog, rng, {
      validateDecks: config.validateDecks,
      advisorMemory: config.advisorMemory
    });
    const signature = deckSignature(deck);
    if (seen.has(signature)) continue;
    seen.add(signature);
    population.push(deck);
  }
  if (population.length === 0) throw new Error("Could not generate any seed decks for this solve request.");

  const rankings = [];
  let best = null;

  for (let generation = 0; generation <= generations; generation += 1) {
    const evaluated = population.map((deck, index) => {
      const candidateId = `solve-g${generation}-c${index}`;
      const evaluation = evaluateDeck({
        catalog: config.catalog,
        deck,
        opponents,
        games: config.games,
        seed: config.seed + generation * 100000 + index * 1000,
        validateDecks: config.validateDecks,
        autoMulliganBricks: config.autoMulliganBricks,
        maxTurns: config.maxTurns,
        maxActions: config.maxActions,
        pilotPolicy: config.pilotPolicy,
        opponentPilotPolicy: config.opponentPilotPolicy
      });
      const row = {
        generation,
        candidateId,
        signature: deckSignature(deck),
        ...evaluation.summary,
        deck
      };
      rankings.push(withoutDeck(row));
      if (!best || row.score > best.score) best = row;
      return row;
    }).sort((a, b) => b.score - a.score);

    console.log(`Generation ${generation}: best score ${evaluated[0].score.toFixed(2)} (${formatPercent(evaluated[0].winRate)} win rate)`);

    if (generation === generations) break;

    const elites = evaluated.slice(0, eliteCount);
    population = elites.map((candidate) => candidate.deck);

    while (population.length < populationSize) {
      const parent = elites[Math.floor(rng() * elites.length)].deck;
      const child = mutateDeck(parent, config.catalog, resolved.pool, rng, {
        swaps: mutationSwaps,
        validateDecks: config.validateDecks,
        advisorMemory: config.advisorMemory
      });
      const signature = deckSignature(child);
      if (seen.has(signature)) continue;
      seen.add(signature);
      population.push(child);
    }
  }

  const bestEvaluation = evaluateDeck({
    catalog: config.catalog,
    deck: best.deck,
    opponents,
    games: config.games,
    seed: config.seed + 9000000,
    validateDecks: config.validateDecks,
    autoMulliganBricks: config.autoMulliganBricks,
    maxTurns: config.maxTurns,
    maxActions: config.maxActions,
    pilotPolicy: config.pilotPolicy,
    opponentPilotPolicy: config.opponentPilotPolicy
  });

  const report = {
    schema: "union-arena-local-engine/deck-agent-report@1",
    mode: "solve",
    createdAt: new Date().toISOString(),
    config: {
      ...printableConfig(config),
      request,
      resolved: {
        sourceCode: resolved.sourceCode,
        sourceTitle: resolved.sourceTitle,
        color: request.color,
        poolSize: resolved.pool.length
      },
      opponents: opponents.map((opponent) => opponent.id),
      populationSize,
      generations,
      eliteCount,
      mutationSwaps
    },
    best: {
      ...withoutDeck(best),
      searchScore: best.score,
      finalEvaluation: bestEvaluation.summary,
      summary: deckSummary("agent-best", best.deck, config.catalog)
    },
    rankings,
    bestGames: bestEvaluation.rows
  };

  writeReport(config.outDir, report, rankings, bestEvaluation.rows, best.deck, config.catalog);
  console.log(`Solved ${solveRequestLabel(request)} into ${config.outDir}`);
  console.log(`Resolved pool: ${resolved.sourceTitle} / ${resolved.sourceCode} / ${request.color ?? "any color"} (${resolved.pool.length} card(s))`);
  printSummary(bestEvaluation.summary);
}

function importAdviceCommand() {
  const catalogPath = option("--catalog") ?? DEFAULT_CATALOG;
  const catalog = loadCatalogJson(catalogPath);
  const adviceFile = requiredOption("--advice-file");
  const memoryPath = option("--memory") ?? option("--advisor-memory") ?? DEFAULT_ADVISOR_MEMORY;
  const advice = parseAdviceFile(adviceFile);
  const memory = loadAdvisorMemory(memoryPath);
  const entry = normalizeAdviceEntry(advice, catalog, adviceFile);
  const nextMemory = mergeAdvisorMemory(memory, entry);
  mkdirSync(dirname(memoryPath), { recursive: true });
  writeFileSync(memoryPath, `${JSON.stringify(nextMemory, null, 2)}\n`);
  console.log(`Imported advisor advice into ${memoryPath}`);
  console.log(`Priority cards: ${entry.priorityCards.length}; avoid cards: ${entry.avoidCards.length}; notes: ${entry.notes.length}`);
}

function readConfig({ outDir }) {
  if (hasFlag("--no-validate")) {
    throw new Error("The deck agent only works with legal decks. Remove --no-validate and fix any deck validation errors instead.");
  }
  const catalogPath = option("--catalog") ?? DEFAULT_CATALOG;
  const libraryDir = option("--library") ?? DEFAULT_LIBRARY;
  const pilotPolicyPath = option("--pilot-policy");
  const opponentPilotPolicyPath = option("--opponent-pilot-policy");
  return {
    catalogPath,
    libraryDir,
    outDir,
    catalog: loadCatalogJson(catalogPath),
    games: Number(option("--games") ?? 12),
    seed: Number(option("--seed") ?? 1000),
    validateDecks: true,
    autoMulliganBricks: hasFlag("--auto-mulligan-bricks"),
    maxTurns: Number(option("--max-turns") ?? 80),
    maxActions: Number(option("--max-actions") ?? 1000),
    pilotPolicyPath,
    opponentPilotPolicyPath,
    pilotPolicy: loadOptionalJson(pilotPolicyPath),
    opponentPilotPolicy: loadOptionalJson(opponentPilotPolicyPath),
    advisorMemoryPath: option("--advisor-memory") ?? DEFAULT_ADVISOR_MEMORY,
    advisorMemory: loadAdvisorMemory(option("--advisor-memory") ?? DEFAULT_ADVISOR_MEMORY)
  };
}

function evaluateDeck({
  catalog,
  deck,
  opponents,
  games,
  seed,
  validateDecks,
  autoMulliganBricks,
  maxTurns,
  maxActions,
  pilotPolicy,
  opponentPilotPolicy
}) {
  const rows = [];
  let index = 0;

  for (const opponent of opponents) {
    for (let game = 0; game < games; game += 1) {
      const firstPlayer = game % 2 === 0 ? "P1" : "P2";
      const gameSeed = seed + index;
      const simulation = createSimulationGame({
        catalog,
        decks: { P1: deck, P2: opponent.cards },
        seed: gameSeed,
        firstPlayer,
        validateDecks,
        setupMode: autoMulliganBricks ? "manual" : "auto"
      });
      const setupState = autoMulliganBricks ? resolveBrickMulligans(simulation.state) : simulation.state;
      const playout = runAutoplayGame(setupState, {
        maxTurns,
        maxActions,
        policy: pilotPolicy || opponentPilotPolicy
          ? { P1: pilotPolicy, P2: opponentPilotPolicy ?? pilotPolicy }
          : undefined
      });
      const result = catalogGameResult(playout.state, {
        index: index + 1,
        seed: gameSeed
      });
      rows.push({
        ...result,
        opponent: opponent.id,
        candidatePlayer: "P1",
        playoutSteps: playout.steps,
        playoutStoppedReason: playout.stoppedReason
      });
      index += 1;
    }
  }

  return {
    rows,
    summary: summarizeRows(rows)
  };
}

function resolveBrickMulligans(state) {
  let nextState = state;
  for (const playerId of ["P1", "P2"]) {
    const actionType = analyzeSetupHand(nextState, playerId).initialBricked ? "mulligan" : "keepHand";
    nextState = applyAction(nextState, { type: actionType, player: playerId });
  }
  return nextState;
}

function summarizeRows(rows) {
  const total = rows.length;
  const wins = rows.filter((row) => row.winner === "P1").length;
  const losses = rows.filter((row) => row.winner === "P2").length;
  const incomplete = total - wins - losses;
  const winRate = total === 0 ? 0 : wins / total;
  const nonLossRate = total === 0 ? 0 : (wins + incomplete * 0.5) / total;
  const brickRate = average(rows, (row) => row.p1Bricked ? 1 : 0);
  const mulliganRate = average(rows, (row) => row.p1Mulliganed ? 1 : 0);
  const avgLifeDiff = average(rows, (row) => row.p1LifeRemaining - row.p2LifeRemaining);
  const avgTurns = average(rows, (row) => row.turnsTaken);
  const avgSpecialsInLife = average(rows, (row) => row.p1SpecialTriggersInLife);
  const incompleteRate = total === 0 ? 0 : incomplete / total;
  const score = nonLossRate * 1000 + avgLifeDiff * 8 - brickRate * 100 - incompleteRate * 60;

  return {
    total,
    wins,
    losses,
    incomplete,
    winRate,
    nonLossRate,
    brickRate,
    mulliganRate,
    avgLifeDiff,
    avgTurns,
    avgSpecialsInLife,
    score
  };
}

function seedPopulation({ baseDeck, catalog, pool, rng, populationSize, mutationSwaps, validateDecks, advisorMemory }) {
  const population = [normalizeDeckList(baseDeck)];
  const seen = new Set([deckSignature(baseDeck)]);
  let attempts = 0;

  while (population.length < populationSize && attempts < populationSize * 200) {
    attempts += 1;
    const child = mutateDeck(baseDeck, catalog, pool, rng, {
      swaps: mutationSwaps,
      validateDecks,
      advisorMemory
    });
    const signature = deckSignature(child);
    if (seen.has(signature)) continue;
    seen.add(signature);
    population.push(child);
  }

  return population;
}

function mutateDeck(deck, catalog, pool, rng, { swaps, validateDecks, advisorMemory }) {
  let candidate = normalizeDeckList(deck);

  for (let swap = 0; swap < swaps; swap += 1) {
    let accepted = false;
    for (let attempt = 0; attempt < 200 && !accepted; attempt += 1) {
      const counts = countsFromDeck(candidate);
      const removeIds = [...counts.entries()]
        .filter(([, count]) => count > 0)
        .map(([id]) => id);
      const removeId = removeIds[Math.floor(rng() * removeIds.length)];
      const addCard = chooseWeightedCard(pool.filter((card) => card.id !== removeId), catalog, rng, advisorMemory);
      const addId = addCard?.id;
      if (!addId) continue;

      counts.set(removeId, counts.get(removeId) - 1);
      if (counts.get(removeId) === 0) counts.delete(removeId);
      counts.set(addId, (counts.get(addId) ?? 0) + 1);

      const next = deckFromCounts(counts);
      if (!isDeckCandidateValid(next, catalog, validateDecks)) continue;
      candidate = next;
      accepted = true;
    }
  }

  return candidate;
}

function isDeckCandidateValid(deck, catalog, validateDecks) {
  const expanded = expandDeckList(deck);
  if (expanded.length !== 50) return false;
  if (expanded.some((id) => !catalog[id])) return false;

  if (!validateDecks) {
    return copyLimitOk(deck, catalog);
  }

  try {
    validateDeck(deck, catalog);
    return true;
  } catch {
    return false;
  }
}

function copyLimitOk(deck, catalog) {
  const counts = new Map();
  for (const id of expandDeckList(deck)) {
    const number = catalog[id]?.number ?? id;
    counts.set(number, (counts.get(number) ?? 0) + 1);
  }
  return [...counts.values()].every((count) => count <= 4);
}

function mutationPool(catalog, sourceCode) {
  return Object.values(catalog)
    .filter((card) => cardSourceCode(card) === sourceCode)
    .filter((card) => card.id)
    .sort((a, b) => String(a.number ?? a.id).localeCompare(String(b.number ?? b.id)));
}

function resolveSolvePool(catalog, request) {
  let cards = Object.values(catalog);
  const textFilters = [request.query, request.set, request.archetype].filter(Boolean);

  for (const filter of textFilters) {
    cards = cards.filter((card) => textMatches(cardSearchText(card), filter));
  }

  if (request.source) {
    cards = cards.filter((card) => {
      const source = normalizeText(request.source);
      return normalizeText(cardSourceCode(card)) === source || textMatches(cardSearchText(card), request.source);
    });
  }

  if (request.color) {
    const color = normalizeColorName(request.color);
    cards = cards.filter((card) => card.color === color);
  }

  if (cards.length === 0) {
    throw new Error(`No cards matched solve request: ${solveRequestLabel(request)}`);
  }

  const sourceGroups = groupBy(cards, cardSourceCode);
  const [sourceCode, sourceCards] = [...sourceGroups.entries()]
    .sort((a, b) => b[1].length - a[1].length)[0];
  const sourceTitle = mostCommon(sourceCards.map((card) => card.title ?? card.product ?? sourceCode));
  const pool = sourceCards.sort((a, b) => String(a.number ?? a.id).localeCompare(String(b.number ?? b.id)));

  if (pool.length * 4 < 50) {
    throw new Error(`Only ${pool.length} matching card(s) are available for ${solveRequestLabel(request)}; at four copies each this cannot make a legal 50-card deck.`);
  }

  return {
    sourceCode,
    sourceTitle,
    pool
  };
}

function buildSeedDeck(pool, catalog, rng, { validateDecks, advisorMemory }) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const counts = new Map();
    const zeroCostUnits = pool.filter((card) => isZeroCostUnit(card));
    const zeroTarget = Math.min(12, maxCopiesAvailable(zeroCostUnits));

    while (deckSizeFromCounts(counts) < zeroTarget) {
      if (!addWeightedCard(counts, zeroCostUnits, catalog, rng, validateDecks, advisorMemory)) break;
    }

    while (deckSizeFromCounts(counts) < 50) {
      if (!addWeightedCard(counts, pool, catalog, rng, validateDecks, advisorMemory)) break;
    }

    const deck = deckFromCounts(counts);
    if (isDeckCandidateValid(deck, catalog, validateDecks)) return deck;
  }

  throw new Error("Could not generate a legal seed deck from the requested card pool.");
}

function addWeightedCard(counts, cards, catalog, rng, validateDecks, advisorMemory) {
  const candidates = cards.filter((card) => canAddCard(counts, card, catalog, validateDecks));
  if (candidates.length === 0) return false;
  const card = chooseWeightedCard(candidates, catalog, rng, advisorMemory);
  counts.set(card.id, (counts.get(card.id) ?? 0) + 1);
  return true;
}

function chooseWeightedCard(cards, catalog, rng, advisorMemory) {
  if (cards.length === 0) return null;
  const totalWeight = cards.reduce((total, card) => total + seedCardWeight(card, catalog, advisorMemory), 0);
  let roll = rng() * totalWeight;
  for (const card of cards) {
    roll -= seedCardWeight(card, catalog, advisorMemory);
    if (roll <= 0) return card;
  }
  return cards.at(-1);
}

function canAddCard(counts, card, catalog, validateDecks) {
  const number = card.number ?? card.id;
  let copiesOfNumber = 0;
  for (const [id, count] of counts.entries()) {
    if ((catalog[id]?.number ?? id) === number) copiesOfNumber += count;
  }
  if (copiesOfNumber >= 4) return false;

  if (validateDecks && LIMITED_TRIGGERS.has(card.trigger?.type)) {
    let triggerCopies = 0;
    for (const [id, count] of counts.entries()) {
      if (catalog[id]?.trigger?.type === card.trigger.type) triggerCopies += count;
    }
    if (triggerCopies >= 4) return false;
  }

  return true;
}

function seedCardWeight(card, catalog, advisorMemory) {
  const requiredEnergy = Number(card.requiredEnergy?.amount ?? 0);
  let weight = 1;
  if (card.type === "character") weight += 4;
  if (card.type === "site") weight += 3;
  if (card.type === "event") weight += 2;
  if (requiredEnergy === 0 && card.type === "character") weight += 10;
  if (requiredEnergy === 1) weight += 5;
  if (requiredEnergy === 2) weight += 4;
  if (requiredEnergy >= 5) weight -= 1;
  if (card.energy?.length > 0) weight += 2;
  if (card.trigger?.type && card.trigger.type !== "none") weight += 1;
  weight += advisorCardDelta(card, catalog, advisorMemory);
  return Math.max(1, weight);
}

function advisorCardDelta(card, catalog, advisorMemory) {
  if (!advisorMemory?.cardWeights) return 0;
  const ids = [
    card.id,
    card.number,
    displayCode(card),
    normalizeText(card.id),
    normalizeText(card.number),
    normalizeText(displayCode(card))
  ].filter(Boolean);
  return ids.reduce((total, key) => total + Number(advisorMemory.cardWeights[key] ?? 0), 0);
}

function maxCopiesAvailable(cards) {
  const numbers = new Set(cards.map((card) => card.number ?? card.id));
  return numbers.size * 4;
}

function deckSizeFromCounts(counts) {
  return [...counts.values()].reduce((total, count) => total + count, 0);
}

function isZeroCostUnit(card) {
  return card.type === "character" && Number(card.requiredEnergy?.amount ?? 0) === 0;
}

function inferDeckSourceCode(deck, catalog, validateDecks) {
  if (validateDecks) {
    return validateDeck(deck, catalog).sourceCode;
  }

  const firstId = expandDeckList(deck).find((id) => catalog[id]);
  if (!firstId) throw new Error("Could not infer deck source code.");
  return cardSourceCode(catalog[firstId]);
}

function cardSourceCode(card) {
  return card.sourceCode ?? sourceCodeFromNumber(card.number);
}

function cardSearchText(card) {
  return [
    card.id,
    card.number,
    card.name,
    card.title,
    card.product,
    card.sourceCode,
    card.color,
    ...(card.affinities ?? [])
  ].join(" ");
}

function textMatches(haystack, needle) {
  const text = normalizeText(haystack);
  return normalizeText(needle)
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => text.includes(token));
}

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeColorName(value) {
  const color = normalizeText(value);
  const colors = new Set(["red", "blue", "yellow", "green", "purple"]);
  if (!colors.has(color)) throw new Error(`Unknown Union Arena color: ${value}`);
  return color;
}

function inferColorFromText(value) {
  const text = normalizeText(value);
  return ["red", "blue", "yellow", "green", "purple"].find((color) => text.split(/\s+/).includes(color));
}

function groupBy(items, keyFn) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function mostCommon(values) {
  const counts = new Map();
  for (const value of values.filter(Boolean)) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

function solveRequestLabel(request) {
  return [
    request.query && `query=${request.query}`,
    request.set && `set=${request.set}`,
    request.source && `source=${request.source}`,
    request.color && `color=${request.color}`,
    request.archetype && `archetype=${request.archetype}`
  ].filter(Boolean).join(", ");
}

function parseAdviceFile(path) {
  const text = readFileSync(path, "utf8").trim();
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (match) return JSON.parse(match[1]);
    throw new Error(`Advisor advice must be JSON or contain a JSON fenced block: ${path}`);
  }
}

function loadAdvisorMemory(path) {
  if (!existsSync(path)) {
    return {
      schema: "union-arena-local-engine/advisor-memory@1",
      entries: [],
      cardWeights: {},
      notes: []
    };
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadOptionalJson(path) {
  if (!path) return undefined;
  if (!existsSync(path)) throw new Error(`JSON file not found: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function normalizeAdviceEntry(advice, catalog, sourcePath) {
  return {
    importedAt: new Date().toISOString(),
    sourcePath,
    summary: String(advice.summary ?? ""),
    priorityCards: normalizeAdviceCards([
      ...(advice.priorityCards ?? []),
      ...(advice.coreCards ?? [])
    ], catalog),
    increaseCards: normalizeAdviceCards(advice.increaseCards ?? [], catalog),
    decreaseCards: normalizeAdviceCards(advice.decreaseCards ?? [], catalog),
    avoidCards: normalizeAdviceCards(advice.avoidCards ?? [], catalog),
    positives: stringList(advice.positives),
    negatives: stringList(advice.negatives),
    recommendations: stringList(advice.recommendations),
    notes: [
      ...stringList(advice.notes),
      ...stringList(advice.lessons)
    ]
  };
}

function normalizeAdviceCards(values, catalog) {
  return stringList(values)
    .map((value) => findCardId(catalog, value) ?? value)
    .filter(Boolean);
}

function stringList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  return [String(value).trim()].filter(Boolean);
}

function findCardId(catalog, idOrCode) {
  const key = normalizeCode(idOrCode);
  return catalog[key]?.id
    ?? Object.values(catalog).find((card) => normalizeCode(card.id) === key)?.id
    ?? Object.values(catalog).find((card) => normalizeCode(card.number) === key)?.id
    ?? Object.values(catalog).find((card) => normalizeCode(displayCode(card)) === key)?.id;
}

function normalizeCode(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[\\/]+/g, "_")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function mergeAdvisorMemory(memory, entry) {
  const next = {
    schema: "union-arena-local-engine/advisor-memory@1",
    entries: [...(memory.entries ?? []), entry],
    cardWeights: { ...(memory.cardWeights ?? {}) },
    notes: [...(memory.notes ?? []), ...entry.notes]
  };

  for (const cardId of entry.priorityCards) addCardWeight(next.cardWeights, cardId, 4);
  for (const cardId of entry.increaseCards) addCardWeight(next.cardWeights, cardId, 2);
  for (const cardId of entry.decreaseCards) addCardWeight(next.cardWeights, cardId, -2);
  for (const cardId of entry.avoidCards) addCardWeight(next.cardWeights, cardId, -5);

  return next;
}

function addCardWeight(weights, cardId, delta) {
  weights[cardId] = Math.max(-10, Math.min(10, Number(weights[cardId] ?? 0) + delta));
}

function loadOpponents(libraryDir, text) {
  return text.split(/[,\r\n]+/)
    .map((id) => id.trim())
    .filter((id) => id && !id.startsWith("#"))
    .filter(Boolean)
    .map((id) => loadSavedDeck(libraryDir, id));
}

function opponentsText(fallback) {
  const file = option("--opponents-file");
  if (file) return readFileSync(file, "utf8");
  return option("--opponents") ?? fallback;
}

function loadSavedDeck(libraryDir, id) {
  const path = join(libraryDir, `${id}.json`);
  if (!existsSync(path)) throw new Error(`Saved deck not found: ${path}`);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return {
    id: raw.id ?? id,
    name: raw.name ?? id,
    path,
    cards: loadDeckJson(path)
  };
}

function deckSummary(id, deck, catalog) {
  const normalized = normalizeDeckList(deck);
  const expanded = expandDeckList(normalized);
  const typeCounts = {};
  const energyCurve = {};
  const triggerCounts = {};
  const sourceCodes = new Set();
  const colorCounts = {};
  let zeroCostUnits = 0;
  let limitedTriggers = 0;

  for (const cardId of expanded) {
    const card = catalog[cardId];
    const type = card?.type ?? "unknown";
    const energy = String(card?.requiredEnergy?.amount ?? "unknown");
    const trigger = card?.trigger?.type ?? "none";
    if (card?.number) sourceCodes.add(sourceCodeFromNumber(card.number));
    if (card?.color) colorCounts[card.color] = (colorCounts[card.color] ?? 0) + 1;
    typeCounts[type] = (typeCounts[type] ?? 0) + 1;
    energyCurve[energy] = (energyCurve[energy] ?? 0) + 1;
    triggerCounts[trigger] = (triggerCounts[trigger] ?? 0) + 1;
    if (type === "character" && Number(card?.requiredEnergy?.amount ?? 0) === 0) zeroCostUnits += 1;
    if (LIMITED_TRIGGERS.has(trigger)) limitedTriggers += 1;
  }

  return {
    id,
    size: expanded.length,
    sourceCodes: [...sourceCodes],
    sourceCode: sourceCodes.size === 1 ? [...sourceCodes][0] : undefined,
    colors: Object.entries(colorCounts)
      .sort(([aColor, aCount], [bColor, bCount]) => bCount - aCount || aColor.localeCompare(bColor))
      .map(([color]) => color),
    colorCounts,
    uniqueCards: normalized.length,
    zeroCostUnits,
    limitedTriggers,
    typeCounts,
    energyCurve,
    triggerCounts,
    cards: normalized
  };
}

function writeReport(outDir, report, rankings, gameRows, bestDeck, catalog) {
  mkdirSync(outDir, { recursive: true });
  const bestDeckSummary = deckSummary("agent-best", bestDeck, catalog);
  const analysis = buildTestingAnalysis({
    report,
    rankings,
    gameRows,
    bestDeckSummary
  });
  const finalReport = {
    ...report,
    analysis
  };

  writeFileSync(join(outDir, "report.json"), `${JSON.stringify(finalReport, null, 2)}\n`);
  writeFileSync(join(outDir, "analysis.md"), analysisMarkdown(analysis));
  writeFileSync(join(outDir, "advisor-prompt.md"), advisorPromptMarkdown(finalReport, analysis, bestDeck, catalog));
  writeFileSync(join(outDir, "rankings.csv"), csvFromRows(rankings.map(flattenRow)));
  writeFileSync(join(outDir, "games.csv"), csvFromRows(gameRows.map(flattenRow)));
  writeFileSync(join(outDir, "best-deck.json"), `${JSON.stringify({
    schema: "union-arena-local-engine/deck-agent-deck@1",
    createdAt: new Date().toISOString(),
    name: "Deck Agent Best",
    cards: normalizeDeckList(bestDeck),
    summary: bestDeckSummary
  }, null, 2)}\n`);
  writeFileSync(join(outDir, "best-deck.txt"), deckText(bestDeck, catalog));
}

function buildTestingAnalysis({ report, rankings, gameRows, bestDeckSummary }) {
  const summary = summarizeRows(gameRows);
  const stopReasons = countBy(gameRows, (row) => row.playoutStoppedReason ?? "unknown");
  const firstSecond = {
    wentFirst: gameRows.filter((row) => row.firstPlayer === "P1").length,
    wentSecond: gameRows.filter((row) => row.firstPlayer === "P2").length
  };
  const matchups = matchupBreakdown(gameRows);
  const topRankings = [...rankings]
    .sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0))
    .slice(0, 5)
    .map((row) => ({
      candidateId: row.candidateId,
      generation: row.generation,
      score: Number(row.score ?? 0),
      winRate: Number(row.winRate ?? 0),
      brickRate: Number(row.brickRate ?? 0),
      avgLifeDiff: Number(row.avgLifeDiff ?? 0)
    }));

  const positives = [];
  const negatives = [];
  const recommendations = [];
  const confidenceNotes = [];
  const completedRate = summary.total === 0 ? 0 : (summary.total - summary.incomplete) / summary.total;
  const weakMatchups = matchups.filter((matchup) => matchup.winRate < 0.5);
  const strongMatchups = matchups
    .filter((matchup) => matchup.winRate >= 0.65 && matchup.total >= 3)
    .sort((a, b) => b.winRate - a.winRate || b.avgLifeDiff - a.avgLifeDiff);
  const largestCurveBucket = largestEntry(bestDeckSummary.energyCurve);

  if (summary.total < 20) {
    confidenceNotes.push(`Only ${summary.total} game(s) were tested, so the result is directional rather than stable.`);
    recommendations.push("Increase `--games` before trusting small win-rate differences.");
  } else if (summary.total >= 50) {
    confidenceNotes.push(`${summary.total} game(s) gives a more useful sample for comparing candidates.`);
  }

  if (summary.winRate >= 0.6) positives.push(`Win rate was strong at ${formatPercent(summary.winRate)}.`);
  if (summary.nonLossRate >= 0.65 && summary.incomplete > 0) positives.push(`Non-loss rate was solid at ${formatPercent(summary.nonLossRate)}, counting incomplete games as half-results.`);
  if (summary.avgLifeDiff > 0) positives.push(`Average life differential was positive at ${summary.avgLifeDiff.toFixed(2)}.`);
  if (summary.brickRate <= 0.08) positives.push(`Brick rate was low at ${formatPercent(summary.brickRate)}.`);
  if (completedRate >= 0.9) positives.push(`Most games completed under the autoplay limits (${formatPercent(completedRate)} completion rate).`);
  if (bestDeckSummary.zeroCostUnits >= 10 && bestDeckSummary.zeroCostUnits <= 18) positives.push(`Zero-cost unit count looks healthy at ${bestDeckSummary.zeroCostUnits}.`);
  if (strongMatchups.length > 0) positives.push(`Best matchup result was into ${strongMatchups[0].opponent} at ${formatPercent(strongMatchups[0].winRate)}.`);

  if (summary.winRate < 0.5) negatives.push(`Win rate was below break-even at ${formatPercent(summary.winRate)}.`);
  if (summary.avgLifeDiff < 0) negatives.push(`Average life differential was negative at ${summary.avgLifeDiff.toFixed(2)}.`);
  if (summary.brickRate >= 0.15) negatives.push(`Brick rate was high at ${formatPercent(summary.brickRate)}.`);
  if (summary.mulliganRate >= 0.25) negatives.push(`The deck mulliganed often (${formatPercent(summary.mulliganRate)}), which can signal shaky openers.`);
  if (summary.incomplete > 0) negatives.push(`${summary.incomplete} game(s) did not finish before the autoplay cap.`);
  if (weakMatchups.length > 0) negatives.push(`Weakest matchup was ${weakMatchups[0].opponent} at ${formatPercent(weakMatchups[0].winRate)}.`);
  if (bestDeckSummary.uniqueCards > 24) negatives.push(`The candidate is spread across ${bestDeckSummary.uniqueCards} unique cards, so consistency may be low.`);
  if (bestDeckSummary.zeroCostUnits < 8) negatives.push(`Zero-cost unit count is low at ${bestDeckSummary.zeroCostUnits}, increasing brick risk.`);
  if (largestCurveBucket && largestCurveBucket.count >= 35) negatives.push(`The energy curve is heavily concentrated at ${largestCurveBucket.label} required energy (${largestCurveBucket.count} cards); verify that is intentional and that catalog costs are encoded correctly.`);

  if (weakMatchups.length > 0) recommendations.push(`Run focused tests into ${weakMatchups[0].opponent} and compare card choices from winning candidates.`);
  if (bestDeckSummary.uniqueCards > 24) recommendations.push("Try a follow-up optimize run from `best-deck.txt` with fewer mutation swaps to consolidate the card package.");
  if (summary.brickRate >= 0.1 || summary.mulliganRate >= 0.2) recommendations.push("Bias the next candidate pool toward more reliable 0-cost units and early energy pieces.");
  if (summary.incomplete > 0) recommendations.push("Increase `--max-turns` or inspect incomplete games in `games.csv` to see where autoplay stalls.");
  recommendations.push("Add more legal gauntlet decks to make the result reflect the actual meta you expect.");

  if (positives.length === 0) positives.push("No clear positive signal appeared in this run; treat the list as a starting point only.");
  if (negatives.length === 0) negatives.push("No major statistical warning appeared in this run, though more games and stronger gauntlets can still change the result.");

  return {
    mode: report.mode,
    generatedAt: new Date().toISOString(),
    testingBreakdown: {
      totalGames: summary.total,
      wins: summary.wins,
      losses: summary.losses,
      incomplete: summary.incomplete,
      winRate: summary.winRate,
      nonLossRate: summary.nonLossRate,
      avgLifeDiff: summary.avgLifeDiff,
      avgTurns: summary.avgTurns,
      brickRate: summary.brickRate,
      mulliganRate: summary.mulliganRate,
      avgSpecialsInLife: summary.avgSpecialsInLife,
      firstSecond,
      stopReasons,
      matchups,
      topRankings
    },
    deckShape: {
      size: bestDeckSummary.size,
      sourceCode: bestDeckSummary.sourceCode,
      sourceCodes: bestDeckSummary.sourceCodes,
      colors: bestDeckSummary.colors,
      colorCounts: bestDeckSummary.colorCounts,
      uniqueCards: bestDeckSummary.uniqueCards,
      zeroCostUnits: bestDeckSummary.zeroCostUnits,
      limitedTriggers: bestDeckSummary.limitedTriggers,
      typeCounts: bestDeckSummary.typeCounts,
      energyCurve: bestDeckSummary.energyCurve,
      triggerCounts: bestDeckSummary.triggerCounts
    },
    positives,
    negatives,
    recommendations,
    confidenceNotes
  };
}

function matchupBreakdown(rows) {
  return [...groupBy(rows, (row) => row.opponent ?? "unknown").entries()]
    .map(([opponent, matchupRows]) => {
      const summary = summarizeRows(matchupRows);
      return {
        opponent,
        total: summary.total,
        wins: summary.wins,
        losses: summary.losses,
        incomplete: summary.incomplete,
        winRate: summary.winRate,
        avgLifeDiff: summary.avgLifeDiff,
        brickRate: summary.brickRate
      };
    })
    .sort((a, b) => a.winRate - b.winRate || a.avgLifeDiff - b.avgLifeDiff);
}

function countBy(items, keyFn) {
  return Object.fromEntries([...groupBy(items, keyFn).entries()].map(([key, values]) => [key, values.length]));
}

function largestEntry(record) {
  const [label, count] = Object.entries(record ?? {}).sort((a, b) => Number(b[1]) - Number(a[1]))[0] ?? [];
  return label === undefined ? null : { label, count: Number(count) };
}

function analysisMarkdown(analysis) {
  const breakdown = analysis.testingBreakdown;
  const lines = [
    "# Deck Agent Analysis",
    "",
    `Mode: ${analysis.mode}`,
    `Generated: ${analysis.generatedAt}`,
    "",
    "## Testing Breakdown",
    "",
    `- Games: ${breakdown.totalGames}`,
    `- Wins / losses / incomplete: ${breakdown.wins} / ${breakdown.losses} / ${breakdown.incomplete}`,
    `- Win rate: ${formatPercent(breakdown.winRate)}`,
    `- Average life differential: ${breakdown.avgLifeDiff.toFixed(2)}`,
    `- Brick rate: ${formatPercent(breakdown.brickRate)}`,
    `- Mulligan rate: ${formatPercent(breakdown.mulliganRate)}`,
    `- Went first / second: ${breakdown.firstSecond.wentFirst} / ${breakdown.firstSecond.wentSecond}`,
    `- Stop reasons: ${JSON.stringify(breakdown.stopReasons)}`,
    "",
    "## Positives",
    "",
    ...analysis.positives.map((item) => `- ${item}`),
    "",
    "## Negatives",
    "",
    ...analysis.negatives.map((item) => `- ${item}`),
    "",
    "## Recommendations",
    "",
    ...analysis.recommendations.map((item) => `- ${item}`),
    "",
    "## Matchups",
    "",
    ...breakdown.matchups.map((matchup) => `- ${matchup.opponent}: ${matchup.wins}/${matchup.losses}/${matchup.incomplete}, ${formatPercent(matchup.winRate)} win rate, ${matchup.avgLifeDiff.toFixed(2)} average life diff`),
    "",
    "## Deck Shape",
    "",
    `- Set/source: ${analysis.deckShape.sourceCode ?? JSON.stringify(analysis.deckShape.sourceCodes)}`,
    `- Colors: ${JSON.stringify(analysis.deckShape.colors)}`,
    `- Unique cards: ${analysis.deckShape.uniqueCards}`,
    `- Zero-cost units: ${analysis.deckShape.zeroCostUnits}`,
    `- Type counts: ${JSON.stringify(analysis.deckShape.typeCounts)}`,
    `- Energy curve: ${JSON.stringify(analysis.deckShape.energyCurve)}`,
    `- Trigger counts: ${JSON.stringify(analysis.deckShape.triggerCounts)}`,
    "",
    "## Confidence Notes",
    "",
    ...analysis.confidenceNotes.map((item) => `- ${item}`)
  ];
  return `${lines.join("\n")}\n`;
}

function advisorPromptMarkdown(report, analysis, bestDeck, catalog) {
  return `# Union Arena GPT Advisor Request

You are advising a local Union Arena deck-building agent. Review this run and give concise, actionable deck-building feedback.

## What I Need Back

Return JSON only, with this shape:

\`\`\`json
{
  "summary": "short overall take",
  "priorityCards": ["card code or id"],
  "increaseCards": ["card code or id"],
  "decreaseCards": ["card code or id"],
  "avoidCards": ["card code or id"],
  "positives": ["what looked good in testing"],
  "negatives": ["what looked bad in testing"],
  "recommendations": ["what the local agent should try next"],
  "notes": ["rules, matchup, or archetype observations"]
}
\`\`\`

Use exact card codes when possible. Do not suggest illegal deck construction.

## Run Context

- Mode: ${report.mode}
- Total games: ${analysis.testingBreakdown.totalGames}
- Win rate: ${formatPercent(analysis.testingBreakdown.winRate)}
- Average life differential: ${analysis.testingBreakdown.avgLifeDiff.toFixed(2)}
- Brick rate: ${formatPercent(analysis.testingBreakdown.brickRate)}
- Mulligan rate: ${formatPercent(analysis.testingBreakdown.mulliganRate)}
- Opponents: ${analysis.testingBreakdown.matchups.map((matchup) => matchup.opponent).join(", ") || "none"}

## Local Agent Analysis

### Positives
${analysis.positives.map((item) => `- ${item}`).join("\n")}

### Negatives
${analysis.negatives.map((item) => `- ${item}`).join("\n")}

### Recommendations
${analysis.recommendations.map((item) => `- ${item}`).join("\n")}

## Best Deck Candidate

\`\`\`text
${deckText(bestDeck, catalog).trim()}
\`\`\`

## Matchups

${analysis.testingBreakdown.matchups.map((matchup) => `- ${matchup.opponent}: ${matchup.wins}/${matchup.losses}/${matchup.incomplete}, ${formatPercent(matchup.winRate)} win rate, ${matchup.avgLifeDiff.toFixed(2)} average life diff`).join("\n") || "- No matchup rows"}
`;
}

function deckText(deck, catalog) {
  const lines = ["// Main Deck"];
  for (const entry of normalizeDeckList(deck).sort((a, b) => displayCode(catalog[a.id]).localeCompare(displayCode(catalog[b.id])))) {
    lines.push(`${entry.count} x ${displayCode(catalog[entry.id])}`);
  }
  return `${lines.join("\n")}\n`;
}

function displayCode(card) {
  const number = String(card?.number ?? card?.id ?? "");
  if (!number.includes("_")) return number;
  const [product, rest] = number.split(/_(.+)/);
  return `${product}/${rest}`;
}

function countsFromDeck(deck) {
  const counts = new Map();
  for (const entry of normalizeDeckList(deck)) {
    counts.set(entry.id, entry.count);
  }
  return counts;
}

function deckFromCounts(counts) {
  return [...counts.entries()]
    .filter(([, count]) => count > 0)
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function deckSignature(deck) {
  return normalizeDeckList(deck)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((entry) => `${entry.id}:${entry.count}`)
    .join("|");
}

function withoutDeck(row) {
  const { deck, ...rest } = row;
  return rest;
}

function average(rows, fn) {
  if (rows.length === 0) return 0;
  return rows.reduce((total, row) => total + Number(fn(row) ?? 0), 0) / rows.length;
}

function flattenRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    typeof value === "object" && value !== null ? JSON.stringify(value) : value
  ]));
}

function csvFromRows(rows) {
  const headers = Object.keys(rows[0] ?? { index: "", candidateId: "" });
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((key) => csvCell(row[key])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

function printableConfig(config) {
  const { catalog, advisorMemory, pilotPolicy, opponentPilotPolicy, ...printable } = config;
  return printable;
}

function printSummary(summary) {
  console.log(`Score: ${summary.score.toFixed(2)}`);
  console.log(`Wins/losses/incomplete: ${summary.wins}/${summary.losses}/${summary.incomplete}`);
  console.log(`Win rate: ${formatPercent(summary.winRate)}`);
  console.log(`Brick rate: ${formatPercent(summary.brickRate)}`);
  console.log(`Average life diff: ${summary.avgLifeDiff.toFixed(2)}`);
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function option(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function requiredOption(flag) {
  const value = option(flag);
  if (!value) {
    usage();
    throw new Error(`Missing required option: ${flag}`);
  }
  return value;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function usage() {
  console.log(`Usage:
  node tools/deck-agent.mjs evaluate --deck deck-id --opponents opp-a,opp-b [--games 20] [--auto-mulligan-bricks]
  node tools/deck-agent.mjs optimize --base deck-id --opponents opp-a,opp-b [--generations 3] [--population 8] [--games 12] [--auto-mulligan-bricks]
  node tools/deck-agent.mjs solve --query "Blue Slime" --opponents opp-a,opp-b [--generations 3] [--population 8] [--games 12] [--auto-mulligan-bricks]
  node tools/deck-agent.mjs solve --query "Blue Slime" --opponents-file work/private/deck-gauntlets/regional-last3.txt
  node tools/deck-agent.mjs import-advice --advice-file path/to/union-arena-gpt-advice.json

Pilot options:
  --pilot-policy work/private/pilot-agent/run/best-policy.json
  --opponent-pilot-policy work/private/pilot-agent/opponent/best-policy.json

Outputs are written under work/private/deck-agent by default:
  report.json
  analysis.md
  advisor-prompt.md
  rankings.csv
  games.csv
  best-deck.json
  best-deck.txt

The agent treats --opponents as the local meta gauntlet. Add more saved meta decks there to make the search care about them. Deck-agent candidates are always validated as legal decks. Advisor advice is stored in work/private/deck-agent/advisor-memory.json by default.`);
}
