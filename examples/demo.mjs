import { applyAction, createGame, legalActions, LINES } from "../src/index.js";
import { sampleCatalog, sampleDeckList } from "../data/sample-cards.js";

let game = createGame({
  catalog: sampleCatalog,
  decks: { P1: sampleDeckList, P2: sampleDeckList },
  seed: 42
});

console.log("Initial phase:", game.phase, "active:", game.activePlayer);
console.log("P1 legal actions:", legalActions(game, "P1").map((action) => action.type));

game = applyAction(game, { type: "advancePhase", player: "P1" });
game = applyAction(game, { type: "advancePhase", player: "P1" });

const firstPlayable = legalActions(game, "P1").find((action) => {
  return action.type === "playCard" && action.destination === LINES.ENERGY;
});

if (firstPlayable) {
  game = applyAction(game, firstPlayable);
}

game = applyAction(game, { type: "advancePhase", player: "P1" });
game = applyAction(game, { type: "advancePhase", player: "P1" });
game = applyAction(game, { type: "advancePhase", player: "P1" });

console.log("After P1 passes turn phase:", game.phase, "active:", game.activePlayer);
console.log("P1 field:", {
  front: game.players.P1.frontLine.length,
  energy: game.players.P1.energyLine.length,
  ap: game.players.P1.apCards.map((ap) => (ap.rested ? "rested" : "active"))
});
console.log("Recent log:");
console.log(game.log.slice(-6).join("\n"));
