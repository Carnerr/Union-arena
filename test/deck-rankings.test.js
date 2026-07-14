import test from "node:test";
import assert from "node:assert/strict";
import { buildOverallDeckRankings, wilsonLowerBound } from "../src/deck-rankings.js";

test("deck rankings keep tiny perfect samples unranked", () => {
  const ranking = buildOverallDeckRankings([
    profile("deep", [matchup("a", 60, 40), matchup("b", 60, 40), matchup("c", 60, 40)]),
    profile("tiny", [matchup("a", 8, 0)])
  ]);

  assert.equal(ranking.rows[0].deckId, "deep");
  assert.equal(ranking.rows[0].rank, 1);
  assert.equal(ranking.rows[1].deckId, "tiny");
  assert.equal(ranking.rows[1].rank, null);
  assert.equal(ranking.rows[1].evidenceLabel, "Unranked");
});

test("deck rankings reward stronger records and penalize missing coverage", () => {
  const full = profile("full", [
    matchup("a", 60, 40),
    matchup("b", 60, 40),
    matchup("c", 60, 40),
    matchup("d", 60, 40)
  ]);
  const narrow = profile("narrow", [matchup("a", 120, 80), matchup("b", 120, 80)]);
  const ranking = buildOverallDeckRankings([narrow, full]);

  assert.equal(ranking.coverageTarget, 4);
  assert.equal(ranking.rows[0].deckId, "full");
  assert.ok(ranking.rows[0].rankScore > ranking.rows[1].rankScore);
});

test("deck rankings use completed outcomes for strategy and expose incomplete reliability", () => {
  const ranking = buildOverallDeckRankings([
    profile("clean", [matchup("a", 30, 20), matchup("b", 30, 20), matchup("c", 30, 20)]),
    profile("unstable", [
      matchup("a", 30, 20, 30),
      matchup("b", 30, 20, 30),
      matchup("c", 30, 20, 30)
    ])
  ]);
  const clean = ranking.rows.find((row) => row.deckId === "clean");
  const unstable = ranking.rows.find((row) => row.deckId === "unstable");

  assert.equal(clean.winRate, 0.6);
  assert.equal(unstable.winRate, 0.6);
  assert.equal(clean.rankable, true);
  assert.equal(unstable.rankable, false);
  assert.equal(unstable.evidenceLabel, "Unreliable");
});

test("Wilson lower bound rises with stronger evidence", () => {
  assert.ok(wilsonLowerBound(600, 400) > wilsonLowerBound(60, 40));
  assert.equal(wilsonLowerBound(0, 0), null);
});

test("best and worst matchup headlines ignore tiny buckets", () => {
  const ranking = buildOverallDeckRankings([
    profile("sampled", [
      matchup("tiny-perfect", 8, 0),
      matchup("supported-good", 14, 6),
      matchup("supported-bad", 8, 12)
    ])
  ]);
  const row = ranking.rows[0];

  assert.equal(row.strongestMatchup.key, "supported-good");
  assert.equal(row.weakestMatchup.key, "supported-bad");
});

function profile(id, matchupStats) {
  return {
    id,
    name: id,
    ownKey: `${id}-profile`,
    baselinePolicy: { exists: true, needsTraining: false },
    matchupStats
  };
}

function matchup(opponentKey, wins, losses, incomplete = 0) {
  const completed = wins + losses;
  return {
    opponentKey,
    opponentLabel: opponentKey,
    wins,
    losses,
    incomplete,
    games: completed + incomplete,
    avgLifeDiff: wins > losses ? 1 : -1,
    avgTurnCycles: 6
  };
}
