# Deck Agent

`tools/deck-agent.mjs` is a local deck-building loop for the engine. It does not fetch or know the live meta by itself; it treats the saved decks selected by the opponent mode as the local meta gauntlet.

## Evaluate A Deck

```powershell
node tools/deck-agent.mjs evaluate --deck carnerr-spear --opponent-mode random --opponent-count 8 --games 20 --auto-mulligan-bricks
```

This runs the deck as player 1 against each opponent deck, alternates first player by game, uses the autoplay pilot, and writes a report.

## Optimize From A Base Deck

```powershell
node tools/deck-agent.mjs optimize --base carnerr-spear --opponent-mode regional --regions "Peoria Illinois,Orlando Florida" --opponent-top 16 --generations 3 --population 8 --games 12 --auto-mulligan-bricks
```

The optimizer:

- infers the base deck source code,
- builds a mutation pool from that source's cards in the catalog,
- swaps card copies while preserving 50 cards and copy limits,
- evaluates candidates against the gauntlet,
- keeps the best candidates and mutates them for the next generation.

## Solve For A Set/Color

```powershell
node tools/deck-agent.mjs solve --query "Blue Slime" --opponent-mode all-regionals --opponent-top 16 --generations 3 --population 8 --games 12 --auto-mulligan-bricks
node tools/deck-agent.mjs solve --query "Blue Slime" --opponent-mode random --opponent-count 8 --generations 3 --population 8 --games 12 --auto-mulligan-bricks
```

Equivalent explicit form:

```powershell
node tools/deck-agent.mjs solve --set "That Time I Got Reincarnated as a Slime" --color blue --opponents regional-slg-purple-spencer-1-peoria-illinois,regional-rnk-purple-andrew-tygr-2-orlando-florida --generations 3 --population 8 --games 12 --auto-mulligan-bricks
```

Solve mode resolves the matching source/title/color pool from the catalog, generates legal seed decks from that pool, then optimizes them against the gauntlet. If `--opponents` is omitted, it creates a generated baseline deck from the same pool, but saved meta decks are much better opponents.

## Opponent Modes

Old explicit lists still work:

```powershell
node tools/deck-agent.mjs evaluate --deck carnerr-spear --opponents regional-slg-purple-spencer-1-peoria-illinois --games 20 --auto-mulligan-bricks
node tools/deck-agent.mjs solve --query "Blue Slime" --opponents-file work\private\deck-gauntlets\regional-q1-2026.txt --generations 3 --population 8 --games 12 --auto-mulligan-bricks
```

Random mode samples saved regional decks. The sample is deterministic for a given `--seed` unless you pass `--opponent-seed`.

```powershell
node tools/deck-agent.mjs optimize --base carnerr-spear --opponent-mode random --opponent-count 8 --generations 3 --population 8 --games 12 --seed 4101 --auto-mulligan-bricks
```

Regional mode trains/evaluates only against selected event locations. Region matching is term-based, so `Peoria` matches `Peoria Illinois`.

```powershell
node tools/deck-agent.mjs evaluate --deck carnerr-spear --opponents regional --regions Peoria --opponent-count 4 --games 20 --auto-mulligan-bricks
```

All-regionals mode uses every saved regional deck after filters:

```powershell
node tools/deck-agent.mjs solve --query "Blue Slime" --opponent-mode all-regionals --opponent-top 16 --opponent-color purple --generations 3 --population 8 --games 12 --auto-mulligan-bricks
```

## Useful Options

- `--opponent-mode explicit`: use `--opponents deck-a,deck-b,deck-c` or `--opponents-file path`.
- `--opponent-mode mirror`: self-play against the selected/base deck; this is the default for `evaluate` and `optimize` when no opponent options are supplied.
- `--opponent-mode random`: sample saved regional decks; use `--opponent-count`.
- `--opponent-mode regional`: use only locations named by `--regions`.
- `--opponent-mode all-regionals`: use every saved regional deck after filters.
- `--opponents random`: shortcut form for `--opponent-mode random`; `regional` and `all-regionals` also work here.
- `--opponent-count 8`: sample this many decks after filters.
- `--regions "Peoria Illinois,Virginia"`: restrict to those event locations.
- `--opponent-top 16`: keep only decks with placement at or above that finish.
- `--opponent-color purple`: keep only matching deck colors.
- `--opponent-set SLG`: keep only matching set/source/deck text.
- `--opponent-seed 1234`: choose a separate deterministic random sample seed.
- `--games 20`: games per opponent per candidate.
- `--generations 5`: number of optimization generations after the initial population.
- `--population 12`: candidates per generation.
- `--elite 3`: best candidates kept as parents.
- `--mutation-swaps 3`: card-copy swaps per child.
- `--seed 1000`: deterministic search seed.
- `--auto-mulligan-bricks`: mulligan opening hands with no setup-valid opener.
- `--pilot-mulligan`: use the supplied pilot policy's opening-hand evaluator instead of the brick-only heuristic.
- When no explicit pilot policy is supplied, the deck agent routes each deck to `work/private/pilot-agent/baselines/decks/<set-color>/baseline-policy.json`, falling back to `work/private/pilot-agent/current-best-policy.json`. Legacy files under `work/private/pilot-agent/policies/` are still read as fallbacks.
- `--pilot-policy current`: use `work/private/pilot-agent/current-best-policy.json` as the candidate deck's pilot.
- `--opponent-pilot-policy current`: force the current champion policy as the opponent pilot. If omitted, each opponent routes by its own set/color policy.
- `--max-turns 80`: playout turn cap.
- `--out-dir path`: output folder.
- `--advisor-memory path`: choose the local memory file used for imported GPT advice.

Deck-agent candidates and saved gauntlet decks are always required to pass the engine's legal deck validator. If a saved deck fails, fix the deck list first rather than bypassing validation.

## Autoplay Pilot Scope

The built-in pilot now generates and scores normal movement, Raid, and payable `Activate: Main` abilities. It also attaches heuristic choices for common encoded decision trees: optional effects, choose-one/choose-N branches, targets, zone-play choices, and discard choices. This makes the deck agent much better at using cards that already have structured effect definitions.

For routed specialist evaluation, omit explicit policy flags:

```powershell
node tools/deck-agent.mjs evaluate --deck carnerr-spear --opponent-mode random --opponent-count 8 --games 20 --pilot-mulligan
```

For champion-policy evaluation, force the current fallback pilot on both sides:

```powershell
node tools/deck-agent.mjs evaluate --deck carnerr-spear --opponent-mode random --opponent-count 8 --games 20 --pilot-policy current --opponent-pilot-policy current --pilot-mulligan
```

It is still a heuristic pilot, not a perfect tournament player. Unsupported or custom card text is skipped, and complex multi-step lines can still need explicit handlers or better scoring rules before the agent will play them optimally.

## Union Arena GPT Advisor Loop

Each run writes an `advisor-prompt.md` file. Give that file to your Union Arena GPT in ChatGPT and ask it to return the requested JSON. Save the GPT response to a local file, then import it:

```powershell
node tools/deck-agent.mjs import-advice --advice-file work\private\deck-agent\blue-slime-run-1\union-arena-gpt-advice.json
```

By default, advice is stored in:

```text
work/private/deck-agent/advisor-memory.json
```

Future `solve` and `optimize` runs load that memory automatically. Cards the GPT marks as `priorityCards` or `increaseCards` become more likely in generated candidates; cards marked as `decreaseCards` or `avoidCards` become less likely. The legal deck validator still controls the final candidate list.

This is not API training or fine-tuning. It is a local feedback loop: the agent learns from play results through rankings, and it learns from your GPT through imported advisor memory.

## Outputs

The run folder contains:

```text
report.json
analysis.md
advisor-prompt.md
rankings.csv
games.csv
best-deck.json
best-deck.txt
```

`analysis.md` is the human-readable testing breakdown. It summarizes the test sample, win/loss/incomplete record, first/second split, stop reasons, matchup results, positives, negatives, recommendations, deck-shape notes, and the paired saved-base-vs-candidate comparison. `advisor-prompt.md` is the package to give your Union Arena GPT for critique, including the same paired comparison and exact candidate card-count changes. `report.json` contains the same analysis in structured form under `analysis` plus `deckComparison`. `rankings.csv` is the high-level candidate scoreboard. `games.csv` is the game-by-game ledger for the final/best evaluation, while `baseGames` in `report.json` stores the paired saved-base evaluation. `best-deck.txt` uses the same pasteable format as the deck importer.

## Reading Scores

The default score rewards non-loss rate and life differential, then penalizes brick rate and incomplete games. Treat search-generation scores as a search heuristic, not a final tournament truth. For deck-edit candidates, use the paired saved-base-vs-candidate final comparison in `analysis.md` or `report.json.deckComparison`; that is the cleaner adoption signal because both lists are checked against the same opponent pool and seed window.

The positives and negatives in `analysis.md` are generated from observed metrics such as win rate, life differential, brick rate, mulligan rate, incomplete games, matchup spread, unique-card count, zero-cost unit count, and curve concentration.
