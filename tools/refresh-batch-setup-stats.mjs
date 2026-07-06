#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  analyzeSetupHand,
  applyAction,
  catalogGameResult,
  createSimulationGame,
  loadCatalogJson,
  loadDeckJson
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

  gameCatalog.rows = gameCatalog.rows.map((row, index) => {
    const setup = createSimulationGame({
      catalog,
      decks,
      seed: row.seed,
      skipShuffle: summary.skipShuffle,
      validateDecks: summary.validateDecks,
      firstPlayer: row.firstPlayer,
      setupMode: summary.autoMulliganBricks ? "manual" : "auto"
    });
    const setupState = summary.autoMulliganBricks ? resolveBrickMulligans(setup.state) : setup.state;
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

function resolveBrickMulligans(state) {
  let nextState = state;
  for (const playerId of ["P1", "P2"]) {
    const actionType = analyzeSetupHand(nextState, playerId).initialBricked ? "mulligan" : "keepHand";
    nextState = applyAction(nextState, { type: actionType, player: playerId });
  }
  return nextState;
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
