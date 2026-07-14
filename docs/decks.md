# Saved Deck Workflow

The engine accepts decks as arrays of `{ "id": "card_id", "count": 4 }`. The deck library tools let you paste common deck-list text once, save the normalized result, and reuse it by deck ID.

## Import Format

Supported lines:

```text
// Main Deck
4 x UE15BT/EVA-1-027
3 x UE15BT/EVA-1-045
1 x UE15BT/EVA-1-066
```

Blank lines and `//` or `#` comments are ignored. Product slash codes such as `UE15BT/EVA-1-027` are resolved to catalog IDs such as `ue15bt_eva_1_027`.

## Commands

```powershell
node tools/deck-library.mjs import path\to\deck.txt --name "Deck Name" --id deck-id
node tools/deck-library.mjs list
node tools/deck-library.mjs show deck-id
```

Default saved-deck folder:

```text
work/private/decks
```

Use `--no-validate` to save a deck that resolves card codes but does not pass construction validation.

## Bulk Import

If a deck package includes a manifest with `deck_name`, `file`, and `suggested_id` columns, import the whole folder:

```powershell
node tools/import-deck-folder.mjs --manifest work\private\deck-imports\regionals-last3\union_arena_regional_decklists\manifest.csv --root work\private\deck-imports\regionals-last3\union_arena_regional_decklists --library work\private\decks --id-prefix regional- --report work\private\decks\regional-last3-import-report.json
```

Imports are validated by default. Use `--fallback-invalid` only when you intentionally want validator-failed lists saved as unvalidated raw decks.

## Simulate With Saved Decks

```powershell
node tools/simulate-decks.mjs --p1 deck-id --p2 other-deck-id
```

Useful options:

- `--no-validate`: skip construction validation when creating the game.
- `--seed 7`: set deterministic shuffle seed.
- `--random-seed`: choose a fresh random seed for this game.
- `--skip-shuffle`: keep deck order from the saved list.
- `--out path`: choose where to save the initial game state JSON.

Saved deck JSON files contain a `cards` array, so `loadDeckJson()` can load them directly for custom scripts.

## Randomization

The engine shuffles decks by default when a game starts. It uses a deterministic seeded shuffle:

- Same deck plus same seed produces the same shuffled order.
- Different seeds produce different shuffled orders.
- `--skip-shuffle` disables shuffling.
- Tooling defaults to deterministic seeds so tests and simulations can be reproduced.

Use `--random-seed` when you want a fresh random shuffle each run.

## Batch Simulations

Create many opening game states at once:

```powershell
node tools/batch-simulate.mjs --p1 deck-id --p2 other-deck-id --games 100 --no-validate
node tools/batch-simulate.mjs --p1 deck-id --p2 other-deck-id --games 100 --auto-mulligan-bricks --playout --no-validate
```

Useful options:

- `--seed 1000`: use deterministic sequential seeds: `1000`, `1001`, `1002`, ...
- `--random-seed`: use fresh random seeds for each game.
- `--auto-mulligan-bricks`: keep non-bricked hands and mulligan initial hands with no setup-valid opener.
- `--playout`: run each game forward with the built-in deterministic basic pilot so winner and end-life fields can fill in.
- `--max-turns 100`: stop an autoplay game after this many total player turns.
- `--save-states`: save every generated game state, not just the summary files.
- `--out-dir path`: choose the output folder.

The batch runner writes:

```text
summary.json
summary.csv
game-catalog.json
game-catalog.csv
```

`game-catalog` is the analysis-friendly ledger for each generated game. Each row includes the winner, first/second player, remaining life totals, mulligan flags, brick flags, setup opener counts, special triggers in starting life, and turn counts. Brick is defined here as a final setup hand with no setup-valid opener: either a literal 0-cost character or an empty-field required-energy reducer that becomes playable as the first unit. Legacy `ZeroCostUnitsSeen` columns are still written for compatibility; use the newer `SetupOpenersSeen` columns when reading current output.

Without `--playout`, rows describe shuffled opening game states and `complete` will usually be `false`. With `--playout`, rows describe the final state reached by the basic pilot; `playoutStoppedReason` says whether the game ended by `winner`, `maxTurns`, `maxActions`, or no available autoplay action.
