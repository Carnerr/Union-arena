#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const root = option("--root") ?? requiredOption("--root");
const outJson = option("--out-json") ?? join(root, "aggregate-summary.json");
const outCsv = option("--out-csv") ?? join(root, "aggregate-summary.csv");

const matchups = matchupDirs(root).map((dir) => summarizeMatchup(root, dir));
const report = {
  createdAt: new Date().toISOString(),
  root,
  games: matchups.reduce((sum, matchup) => sum + matchup.games, 0),
  matchups
};

writeJson(outJson, report);
writeFileSync(outCsv, csvFromRows(matchups.map(flattenSummary)));

console.table(matchups.map((summary) => ({
  matchup: summary.name,
  games: summary.games,
  complete: summary.complete,
  p1Wins: summary.p1Wins,
  p1WinRate: formatPercent(summary.p1WinRate),
  p1WhenFirst: `${summary.p1WinWhenFirst}/${summary.p1GamesWhenFirst}`,
  p1WhenSecond: `${summary.p1WinWhenSecond}/${summary.p1GamesWhenSecond}`,
  p1Mulligan: formatPercent(summary.p1MulliganRate),
  p1InitialBrick: formatPercent(summary.p1InitialBrickRate),
  p1FinalBrick: formatPercent(summary.p1FinalBrickRate),
  p1AvgSpecialLife: summary.p1AvgSpecialLife.toFixed(2),
  p2AvgSpecialLife: summary.p2AvgSpecialLife.toFixed(2),
  avgTurns: summary.avgTurns.toFixed(1),
  stoppedReasons: JSON.stringify(summary.stoppedReasons)
})));
console.log(`Wrote ${outJson}`);
console.log(`Wrote ${outCsv}`);

function summarizeMatchup(rootDir, dir) {
  const catalogPath = join(rootDir, dir, "game-catalog.json");
  const summaryPath = join(rootDir, dir, "summary.json");
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  const summary = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, "utf8")) : {};
  const rows = catalog.rows ?? [];
  const completeRows = rows.filter((row) => row.complete);
  const p1FirstRows = rows.filter((row) => row.firstPlayer === "P1");
  const p1SecondRows = rows.filter((row) => row.firstPlayer === "P2");

  return {
    name: readableName(dir),
    dir,
    decks: summary.decks ?? catalog.decks,
    games: rows.length,
    complete: completeRows.length,
    incomplete: rows.length - completeRows.length,
    p1Wins: rows.filter((row) => row.winner === "P1").length,
    p2Wins: rows.filter((row) => row.winner === "P2").length,
    p1WinRate: ratio(rows.filter((row) => row.winner === "P1").length, rows.length),
    p1CompletedWinRate: ratio(rows.filter((row) => row.winner === "P1").length, completeRows.length),
    p1WinWhenFirst: p1FirstRows.filter((row) => row.winner === "P1").length,
    p1GamesWhenFirst: p1FirstRows.length,
    p1WinWhenSecond: p1SecondRows.filter((row) => row.winner === "P1").length,
    p1GamesWhenSecond: p1SecondRows.length,
    stoppedReasons: counts(rows, (row) => row.playoutStoppedReason),
    firstPlayers: counts(rows, (row) => row.firstPlayer),
    p1MulliganRate: average(rows, (row) => row.p1Mulliganed ? 1 : 0),
    p2MulliganRate: average(rows, (row) => row.p2Mulliganed ? 1 : 0),
    p1InitialBrickRate: average(rows, (row) => row.p1InitialBricked ? 1 : 0),
    p2InitialBrickRate: average(rows, (row) => row.p2InitialBricked ? 1 : 0),
    p1FinalBrickRate: average(rows, (row) => row.p1Bricked ? 1 : 0),
    p2FinalBrickRate: average(rows, (row) => row.p2Bricked ? 1 : 0),
    p1AvgSpecialLife: average(rows, (row) => row.p1SpecialTriggersInLife),
    p2AvgSpecialLife: average(rows, (row) => row.p2SpecialTriggersInLife),
    p1SpecialLifeDist: counts(rows, (row) => row.p1SpecialTriggersInLife),
    p2SpecialLifeDist: counts(rows, (row) => row.p2SpecialTriggersInLife),
    avgTurns: average(rows, (row) => row.turnsTaken),
    avgTurnCycles: average(rows, (row) => row.turnCyclesTaken),
    avgP1LifeRemaining: average(rows, (row) => row.p1LifeRemaining),
    avgP2LifeRemaining: average(rows, (row) => row.p2LifeRemaining),
    minP1LifeRemaining: min(rows, (row) => row.p1LifeRemaining),
    maxP1LifeRemaining: max(rows, (row) => row.p1LifeRemaining),
    minP2LifeRemaining: min(rows, (row) => row.p2LifeRemaining),
    maxP2LifeRemaining: max(rows, (row) => row.p2LifeRemaining),
    gameCatalogPath: join(rootDir, dir, "game-catalog.csv")
  };
}

function matchupDirs(rootDir) {
  return process.argv.includes("--matchups")
    ? requiredOption("--matchups").split(",").map((item) => item.trim()).filter(Boolean)
    : JSON.parse(readFileSync(join(rootDir, "manifest.json"), "utf8")).matchups.map((entry) => entry.dir);
}

function flattenSummary(summary) {
  return {
    matchup: summary.name,
    games: summary.games,
    complete: summary.complete,
    incomplete: summary.incomplete,
    p1Wins: summary.p1Wins,
    p2Wins: summary.p2Wins,
    p1WinRate: formatPercent(summary.p1WinRate),
    p1CompletedWinRate: formatPercent(summary.p1CompletedWinRate),
    p1WhenFirst: `${summary.p1WinWhenFirst}/${summary.p1GamesWhenFirst}`,
    p1WhenSecond: `${summary.p1WinWhenSecond}/${summary.p1GamesWhenSecond}`,
    p1MulliganRate: formatPercent(summary.p1MulliganRate),
    p2MulliganRate: formatPercent(summary.p2MulliganRate),
    p1InitialBrickRate: formatPercent(summary.p1InitialBrickRate),
    p1FinalBrickRate: formatPercent(summary.p1FinalBrickRate),
    p2InitialBrickRate: formatPercent(summary.p2InitialBrickRate),
    p2FinalBrickRate: formatPercent(summary.p2FinalBrickRate),
    p1AvgSpecialLife: summary.p1AvgSpecialLife.toFixed(2),
    p2AvgSpecialLife: summary.p2AvgSpecialLife.toFixed(2),
    p1SpecialLifeDist: JSON.stringify(summary.p1SpecialLifeDist),
    p2SpecialLifeDist: JSON.stringify(summary.p2SpecialLifeDist),
    avgTurns: summary.avgTurns.toFixed(2),
    avgP1LifeRemaining: summary.avgP1LifeRemaining.toFixed(2),
    avgP2LifeRemaining: summary.avgP2LifeRemaining.toFixed(2),
    stoppedReasons: JSON.stringify(summary.stoppedReasons),
    gameCatalogPath: summary.gameCatalogPath
  };
}

function average(rows, fn) {
  return rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + Number(fn(row) ?? 0), 0) / rows.length;
}

function counts(rows, fn) {
  const result = {};
  for (const row of rows) {
    const key = String(fn(row));
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

function min(rows, fn) {
  return rows.length === 0 ? null : Math.min(...rows.map((row) => Number(fn(row))));
}

function max(rows, fn) {
  return rows.length === 0 ? null : Math.max(...rows.map((row) => Number(fn(row))));
}

function ratio(value, total) {
  return total ? value / total : 0;
}

function formatPercent(value) {
  return `${(100 * value).toFixed(1)}%`;
}

function readableName(dir) {
  return basename(dir)
    .replace(/^vs-/, "")
    .split("-")
    .map((part) => part.length <= 3 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function csvFromRows(rows) {
  const headers = Object.keys(rows[0] ?? {});
  return `${[
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))
  ].join("\n")}\n`;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function option(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function requiredOption(flag) {
  const value = option(flag);
  if (!value) throw new Error(`Missing required option: ${flag}`);
  return value;
}
