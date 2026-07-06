# Union Arena Local Engine

This is a dependency-free local rules-engine scaffold for simulating Union Arena-style gameplay. It models the public rule spine: setup, mulligan, life, AP progression, field zones, energy checks, movement, main-phase card use, Raid stacking, attack/block flow, direct damage, battle comparison, triggers, and end-phase hand cleanup.

It deliberately keeps real card text and card images out of the repo. Add card definitions in data files you control, then map their abilities into the small effect/ability DSL in `src/game.js`.

## Run

```powershell
node --test
node examples/demo.mjs
```

If your shell does not have `node` on PATH, use the bundled runtime shown by Codex:

```powershell
& 'C:\Users\OWNER\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test
```

## Project Shape

- `src/constants.js`: phase, zone, card-type, timing, and trigger constants.
- `src/deck.js`: 50-card deck validation, source-code checks, copy limits, and limited trigger counts.
- `src/deck-import.js`: text deck-list parser and saved deck metadata helpers.
- `src/effect-text.js`: private card-text encoder for common EGM Union Arena wording.
- `src/game.js`: deterministic state machine and action application.
- `data/sample-cards.js`: fictional demo cards that exercise mechanics without copying official card text.
- `data/catalog-template.json`: private catalog template for real-card entry.
- `tools/import-catalog.mjs`: converts private JSON/CSV card rows to normalized engine catalog JSON.
- `tools/fetch-egman-unionarena.mjs`: fetches or rebuilds a private EGM catalog.
- `tools/deck-library.mjs`: imports, lists, and shows saved local decks.
- `tools/import-deck-folder.mjs`: bulk-imports deck text files from a manifest.
- `tools/simulate-decks.mjs`: starts a game from two saved deck IDs.
- `tools/batch-simulate.mjs`: creates many shuffled opening game states for mass simulations and writes game-catalog output for matchup analysis.
- `tools/deck-agent.mjs`: evaluates decks and runs evolutionary deck optimization against a saved-deck gauntlet.
- `tools/ai-engine.mjs`: JSON command bridge for AI agents.
- `tools/analyze-card-effects.mjs`: reports text-encoding coverage for the private EGM pool.
- `tools/audit-official-faq.mjs`: compares official FAQ card rulings to local encoded catalog coverage.
- `test/engine.test.js`: executable rule checks using Node's built-in test runner.
- `examples/demo.mjs`: tiny local simulation.
- `docs/card-data.md`: schema and effect-spec reference.
- `docs/decks.md`: saved deck import and simulation workflow.
- `docs/ai-usage.md`: command contract for giving the engine to an AI.
- `docs/deck-agent.md`: local deck-agent evaluation, solve, and optimize workflow.
- `docs/pilot-agent.md`: gameplay-pilot learning workflow.
- `docs/gpt-advisor.md`: how to use your Union Arena GPT as an advisor for the local deck agent.
- `docs/workspace-layout.md`: local file layout, keep/delete guidance, and output conventions.

## Current Action API

Use `createGame()` to build state, then feed state plus an action into `applyAction()`.

```js
import { createGame, applyAction, LINES } from "./src/index.js";
import { sampleCatalog, sampleDeckList } from "./data/sample-cards.js";

let game = createGame({
  catalog: sampleCatalog,
  decks: { P1: sampleDeckList, P2: sampleDeckList },
  seed: 7
});

game = applyAction(game, { type: "advancePhase", player: "P1" });
game = applyAction(game, { type: "advancePhase", player: "P1" });
game = applyAction(game, {
  type: "playCard",
  player: "P1",
  handIndex: 0,
  destination: LINES.ENERGY
});
```

Supported actions include `keepHand`, `mulligan`, `extraDraw`, `advancePhase`, `moveCharacters`, `playCard`, `performRaid`, `activateMainAbility`, `declareAttack`, `declareBlock`, `declineBlock`, and `discardForHandLimit`.

## Private Card Data

Use `data/catalog-template.json` or convert your own CSV/JSON:

```powershell
node tools/import-catalog.mjs path\to\cards.csv data\my-private-catalog.json
```

Fetch or rebuild the private EGM catalog:

```powershell
node tools/fetch-egman-unionarena.mjs
node tools/fetch-egman-unionarena.mjs --raw-in work\private\egman-unionarena-raw.json
node tools/analyze-card-effects.mjs
node tools/audit-official-faq.mjs --series UE21BT
node tools/audit-official-faq.mjs --all-products
```

See `docs/card-data.md` for the normalized card schema, keyword parser, effect specs, and target selectors.

## Saved Decks

Import pasted deck lists that look like `4 x UE15BT/EVA-1-027`:

```powershell
node tools/deck-library.mjs import work\private\deck-imports\eva-user-main.txt --name "EVA User Main" --id eva-user-main
node tools/deck-library.mjs list
node tools/deck-library.mjs show eva-user-main
```

Saved decks live in `work/private/decks` by default. Use a saved deck in a local simulation:

```powershell
node tools/simulate-decks.mjs --p1 eva-user-main --p2 eva-user-main --no-validate
node tools/batch-simulate.mjs --p1 eva-user-main --p2 eva-user-main --games 100 --random-seed --no-validate
node tools/batch-simulate.mjs --p1 eva-user-main --p2 eva-user-main --games 100 --auto-mulligan-bricks --playout --random-seed --no-validate
```

Use `--no-validate` for experiments with decks that intentionally break construction checks. Without that flag, imports and simulations enforce the engine's deck validator.

Decks are shuffled by default. The shuffle is seeded and reproducible; use different `--seed` values or `--random-seed` for different shuffles. Batch runs write `game-catalog.json` and `game-catalog.csv` with winner, life remaining, mulligans, turn counts, brick flags, and special triggers in starting life. Add `--auto-mulligan-bricks --playout` when you want the batch runner to mulligan no-0-cost hands and use the built-in basic pilot to fill end-of-game fields.

## Deck Agent

Evaluate a saved deck against a local meta gauntlet:

```powershell
node tools/deck-agent.mjs evaluate --deck legal-deck-id --opponents meta-deck-a,meta-deck-b --games 20 --auto-mulligan-bricks
```

Run an evolutionary search from a base deck:

```powershell
node tools/deck-agent.mjs optimize --base legal-deck-id --opponents meta-deck-a,meta-deck-b --generations 3 --population 8 --games 12 --auto-mulligan-bricks
node tools/deck-agent.mjs solve --query "Blue Slime" --opponents meta-deck-a,meta-deck-b --generations 3 --population 8 --games 12 --auto-mulligan-bricks
node tools/deck-agent.mjs solve --query "Blue Slime" --opponents-file work\private\deck-gauntlets\regional-last3.txt --generations 3 --population 8 --games 12 --auto-mulligan-bricks
```

The deck agent writes `analysis.md`, `advisor-prompt.md`, `report.json`, `rankings.csv`, `games.csv`, `best-deck.json`, and `best-deck.txt`. Its autoplay pilot handles normal movement, Raid, payable `Activate: Main` abilities, and heuristic choices for common optional/branching effects. You can give `advisor-prompt.md` to your Union Arena GPT, then import its JSON advice with `node tools/deck-agent.mjs import-advice --advice-file path\to\advice.json`. Deck-agent candidates and gauntlet decks must be legal. See `docs/deck-agent.md` for details.

## Important Scope Notes

This is a rules kernel with a growing private text-encoding layer, not yet a perfect official simulator. Full gameplay fidelity still needs the remaining conditional/custom card text translated into structured definitions, effect handlers, and pilot heuristics. The engine already has hooks for `When Played`, `When Attacking`, `When Blocking`, `When Sidelined`, `Start of End Phase`, `Activate: Main`, triggers, common costs, AP payment, rest/ready, draw/search, line movement, BP modification, temporary keyword/energy grants, self-sideline, under-card movement, sideline-to-hand retrieval, hand/sideline play effects, enter-active cards, damage, and Raid.

The official Union Arena site currently lists the Official Rule Manual as updated August 30, 2024, Tournament Rules Manual as updated May 22, 2025, and banned/restricted information as updated April 10, 2026. The site also states that web images/text/data may not be reproduced without permission, so this project uses fictional sample card data.
