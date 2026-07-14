import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  activeSweepTask,
  buildDashboardCurrentRunStatus
} from "../src/dashboard-current-run.js";

test("current run status reports a live matchup and its improvement from the task baseline", () => {
  const status = buildDashboardCurrentRunStatus({
    controller: {
      running: true,
      startedAt: "2026-07-14T10:00:00.000Z",
      config: { kind: "auto-refiner" }
    },
    loopHealth: {
      alive: true,
      status: "running",
      currentCycle: { taskType: "matchup-sweep", deckId: "carnerr-spear" }
    },
    profiles: profiles(),
    sweepState: {
      currentTask: {
        deckId: "carnerr-spear",
        deckName: "Carnerr Spear",
        ownKey: "eva-purple-spear",
        opponentKey: "blc-green-toshiro",
        opponentLabel: "BLC green Toshiro",
        currentGames: 80,
        currentWinRate: 0.36,
        startedAt: "2026-07-14T10:05:00.000Z"
      }
    }
  });

  assert.equal(status.active, true);
  assert.equal(status.phase, "matchup");
  assert.equal(status.badge, "MATCHUP");
  assert.equal(status.title, "Carnerr - Spear vs Engine - BLC Green Toshiro");
  assert.equal(status.latestWinRate, 0.43);
  assert.equal(status.startingWinRate, 0.36);
  assert.ok(Math.abs(status.winRateDelta - 0.07) < 1e-9);
  assert.equal(status.deltaTone, "positive");
  assert.equal(status.completedGames, 100);
  assert.equal(status.startedAt, "2026-07-14T10:05:00.000Z");
});

test("current run status falls back to the next selected sweep task", () => {
  const task = activeSweepTask({
    startedAt: "2026-07-14T10:00:00.000Z",
    selectedTasks: [
      { opponentKey: "first" },
      { opponentKey: "second" }
    ],
    results: [{ opponentKey: "first" }]
  });

  assert.equal(task.opponentKey, "second");
  assert.equal(task.index, 2);
  assert.equal(task.startedAt, "2026-07-14T10:00:00.000Z");
});

test("current run status uses a direct matchup launch baseline", () => {
  const status = buildDashboardCurrentRunStatus({
    controller: {
      running: true,
      startedAt: "2026-07-14T11:00:00.000Z",
      config: {
        trainingMode: "matchup",
        deck: "carnerr-spear",
        ownKey: "eva-purple-spear",
        opponentKey: "blc-green-toshiro",
        currentRunBaseline: {
          opponentLabel: "BLC green Toshiro",
          winRate: 0.48,
          completedGames: 40
        }
      }
    },
    loopHealth: {
      alive: true,
      status: "running",
      currentCycle: {
        status: "training",
        startedAt: "2026-07-14T11:01:00.000Z"
      }
    },
    profiles: profiles({ winRate: 0.44 })
  });

  assert.equal(status.phase, "matchup");
  assert.equal(status.startingWinRate, 0.48);
  assert.equal(status.latestWinRate, 0.44);
  assert.equal(status.deltaTone, "negative");
  assert.equal(status.startedAt, "2026-07-14T11:01:00.000Z");
});

test("current run status describes profile ML and idle states without matchup metrics", () => {
  const active = buildDashboardCurrentRunStatus({
    controller: { running: true, startedAt: "2026-07-14T12:00:00.000Z", config: { kind: "auto-refiner" } },
    loopHealth: {
      alive: true,
      status: "running",
      currentCycle: {
        taskType: "action-model-suite",
        deckName: "Profile ML Suite",
        startedAt: "2026-07-14T12:01:00.000Z"
      }
    }
  });
  const idle = buildDashboardCurrentRunStatus({
    controller: { running: false },
    loopHealth: { alive: false, status: "idle" }
  });

  assert.equal(active.badge, "PROFILE ML");
  assert.equal(active.title, "All Deck Profiles");
  assert.equal(active.latestWinRate, null);
  assert.equal(idle.active, false);
  assert.equal(idle.title, "No active training run");
});

test("current run status names the deck in a focused profile-ML suite", () => {
  const status = buildDashboardCurrentRunStatus({
    controller: { running: true, config: { kind: "auto-refiner" } },
    loopHealth: {
      alive: true,
      status: "running",
      currentCycle: {
        taskType: "action-model-suite",
        deckName: "Profile ML Suite",
        command: "node tools/pilot-baseline-suite.mjs --decks carnerr-spear --seed 26"
      }
    },
    profiles: profiles()
  });

  assert.equal(status.title, "Profile ML: Carnerr - Spear");
  assert.equal(status.deckId, "carnerr-spear");
  assert.equal(status.ownKey, "eva-purple-spear");
});

test("dashboard rebuilds card evidence outside the HTTP server process", () => {
  const source = readFileSync("tools/pilot-dashboard.mjs", "utf8");
  const start = source.indexOf("function scheduleCardEvidenceWarm()");
  const end = source.indexOf("function cardEvidenceWarmProcessArgs()", start);
  const scheduler = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(scheduler, /spawn\(process\.execPath, cardEvidenceWarmProcessArgs\(\)/u);
  assert.doesNotMatch(scheduler, /buildDecisionCardEvidenceByOwnKey\(\)/u);
  assert.match(source, /process\.argv\.includes\("--build-card-evidence-cache"\)/u);
});

function profiles({ winRate = 0.43 } = {}) {
  return [
    {
      id: "carnerr-spear",
      name: "Carnerr - Spear",
      ownKey: "eva-purple-spear",
      matchupStats: [{
        opponentKey: "blc-green-toshiro",
        winRate,
        wins: Math.round(winRate * 100),
        losses: 100 - Math.round(winRate * 100),
        completedGames: 100
      }]
    },
    {
      id: "engine-blc-green-toshiro",
      name: "Engine - BLC Green Toshiro",
      ownKey: "blc-green-toshiro",
      matchupStats: []
    }
  ];
}
