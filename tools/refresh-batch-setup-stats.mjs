#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  analyzeSetupHand,
  applyAction,
  catalogGameResult,
  createSimulationGame,
  loadCatalogJson,
  loadDeckJson,
  normalizePilotPolicy,
  resolvePilotSetup
} from "../src/index.js";

const root = requiredOption("--root");
const matchups = requiredOption("--matchups").split(",").map((item) => item.trim()).filter(Boolean);

for (const dir of matchups) {
  const summaryPath = join(root, dir, "summary.json");
  const catalogPath = join(root, dir, "game-catalog.json");
  if (!existsSync(summaryPath) || !existsSync(catalogPath)) throw new Error(`Missing batch files for ${dir}`);

  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  const gameCatalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  const catalog = loadCatalogJson(summary.catalogPath);
  const decks = {
    P1: loadDeckJson(join("work/private/decks", `${summary.decks.P1}.json`)),
    P2: loadDeckJson(join("work/private/decks", `${summary.decks.P2}.json`))
  };
  const setupPolicy = {
    P1: loadPolicy(summary.policyPaths?.P1),
    P2: loadPolicy(summary.policyPaths?.P2)
  };

  gameCatalog.rows = gameCatalog.rows.map((row, index) => {
    const setup = createSimulationGame({
      catalog,
      decks,
      seed: row.seed,
      skipShuffle: summary.skipShuffle,
      validateDecks: summary.validateDecks,
      firstPlayer: row.firstPlayer,
      setupMode: summary.autoMulliganBricks || summary.pilotMulligan ? "manual" : "auto"
    });
    const setupState = resolveSetupState(setup.state, summary, setupPolicy);
    const setupRow = catalogGameResult(setupState, { index: index + 1, seed: row.seed, statePath: row.statePath });
    return {
      ...row,
      firstPlayer: setupRow.firstPlayer,
      secondPlayer: setupRow.secondPlayer,
      p1Mulliganed: setupRow.p1Mulliganed,
      p2Mulliganed: setupRow.p2Mulliganed,
      p1Bricked: setupRow.p1Bricked,
      p2Bricked: setupRow.p2Bricked,
      p1InitialBricked: setupRow.p1InitialBricked,
      p2InitialBricked: setupRow.p2InitialBricked,
      p1SetupOpenersSeen: setupRow.p1SetupOpenersSeen,
      p2SetupOpenersSeen: setupRow.p2SetupOpenersSeen,
      p1InitialSetupOpenersSeen: setupRow.p1InitialSetupOpenersSeen,
      p2InitialSetupOpenersSeen: setupRow.p2InitialSetupOpenersSeen,
      p1ZeroCostUnitsSeen: setupRow.p1ZeroCostUnitsSeen,
      p2ZeroCostUnitsSeen: setupRow.p2ZeroCostUnitsSeen,
      p1InitialZeroCostUnitsSeen: setupRow.p1InitialZeroCostUnitsSeen,
      p2InitialZeroCostUnitsSeen: setupRow.p2InitialZeroCostUnitsSeen,
      p1SpecialTriggersInLife: setupRow.p1SpecialTriggersInLife,
      p2SpecialTriggersInLife: setupRow.p2SpecialTriggersInLife
    };
  });

  writeFileSync(catalogPath, `${JSON.stringify(gameCatalog, null, 2)}\n`);
  writeFileSync(join(root, dir, "game-catalog.csv"), csvFromRows(gameCatalog.rows));
  console.log(`Refreshed setup stats for ${dir}`);
}

function resolveSetupState(state, summary, policy) {
  if (summary.pilotMulligan) {
    const baseline = normalizePilotPolicy();
    return resolvePilotSetup(state, {
      P1: policy.P1 ?? baseline,
      P2: policy.P2 ?? policy.P1 ?? baseline
    });
  }
  if (summary.autoMulliganBricks) return resolveBrickMulligans(state);
  return state;
}

function resolveBrickMulligans(state) {
  let nextState = state;
  for (const playerId of ["P1", "P2"]) {
    const actionType = analyzeSetupHand(nextState, playerId).initialBricked ? "mulligan" : "keepHand";
    nextState = applyAction(nextState, { type: actionType, player: playerId });
  }
  return nextState;
}

function loadPolicy(path) {
  if (!path || !existsSync(path)) return null;
  return normalizePilotPolicy(JSON.parse(readFileSync(path, "utf8")));
}

function csvFromRows(rows) {
  const headers = Object.keys(rows[0] ?? { index: "", seed: "" });
  const lines = [headers.join(",")];
  for (const row of rows) lines.push(headers.map((key) => csvCell(row[key])).join(","));
  return `${lines.join("\n")}\n`;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

function requiredOption(flag) {
  const index = process.argv.indexOf(flag);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`Missing required option: ${flag}`);
  return value;
}
