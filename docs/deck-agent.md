# Deck Agent

`tools/deck-agent.mjs` is a local deck-building loop for the engine. It does not fetch or know the live meta by itself; it treats the saved decks you pass in `--opponents` as the local meta gauntlet.

## Evaluate A Deck

```powershell
node tools/deck-agent.mjs evaluate --deck legal-deck-id --opponents meta-deck-a,meta-deck-b --games 20 --auto-mulligan-bricks
```

This runs the deck as player 1 against each opponent deck, alternates first player by game, uses the autoplay pilot, and writes a report.

## Optimize From A Base Deck

```powershell
node tools/deck-agent.mjs optimize --base legal-deck-id --opponents meta-deck-a,meta-deck-b --generations 3 --population 8 --games 12 --auto-mulligan-bricks
```

The optimizer:

- infers the base deck source code,
- builds a mutation pool from that source's cards in the catalog,
- swaps card copies while preserving 50 cards and copy limits,
- evaluates candidates against the gauntlet,
- keeps the best candidates and mutates them for the next generation.

## Solve For A Set/Color

```powershell
node tools/deck-agent.mjs solve --query "Blue Slime" --opponents meta-deck-a,meta-deck-b --generations 3 --population 8 --games 12 --auto-mulligan-bricks
node tools/deck-agent.mjs solve --query "Blue Slime" --opponents-file work\private\deck-gauntlets\regional-last3.txt --generations 3 --population 8 --games 12 --auto-mulligan-bricks
```

Equivalent explicit form:

```powershell
node tools/deck-agent.mjs solve --set "That Time I Got Reincarnated as a Slime" --color blue --opponents meta-deck-a,meta-deck-b --generations 3 --population 8 --games 12 --auto-mulligan-bricks
```

Solve mode resolves the matching source/title/color pool from the catalog, generates legal seed decks from that pool, then optimizes them against the gauntlet. If `--opponents` is omitted, it creates a generated baseline deck from the same pool, but saved meta decks are much better opponents.

## Useful Options

- `--opponents deck-a,deck-b,deck-c`: the gauntlet the agent optimizes against.
- `--opponents-file path`: newline or comma-separated deck IDs for larger gauntlets.
- `--games 20`: games per opponent per candidate.
- `--generations 5`: number of optimization generations after the initial population.
- `--population 12`: candidates per generation.
- `--elite 3`: best candidates kept as parents.
- `--mutation-swaps 3`: card-copy swaps per child.
- `--seed 1000`: deterministic search seed.
- `--auto-mulligan-bricks`: mulligan opening hands with no 0-cost unit.
- `--max-turns 80`: playout turn cap.
- `--out-dir path`: output folder.
- `--advisor-memory path`: choose the local memory file used for imported GPT advice.

Deck-agent candidates and saved gauntlet decks are always required to pass the engine's legal deck validator. If a saved deck fails, fix the deck list first rather than bypassing validation.

## Autoplay Pilot Scope

The built-in pilot now generates and scores normal movement, Raid, and payable `Activate: Main` abilities. It also attaches heuristic choices for common encoded decision trees: optional effects, choose-one/choose-N branches, targets, zone-play choices, and discard choices. This makes the deck agent much better at using cards that already have structured effect definitions.

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

`analysis.md` is the human-readable testing breakdown. It summarizes the test sample, win/loss/incomplete record, first/second split, stop reasons, matchup results, positives, negatives, recommendations, and deck-shape notes. `advisor-prompt.md` is the package to give your Union Arena GPT for critique. `report.json` contains the same analysis in structured form under `analysis`. `rankings.csv` is the high-level candidate scoreboard. `games.csv` is the game-by-game ledger for the final/best evaluation. `best-deck.txt` uses the same pasteable format as the deck importer.

## Reading Scores

The default score rewards non-loss rate and life differential, then penalizes brick rate and incomplete games. Treat it as a search heuristic, not a final tournament truth. The current autoplay pilot is deterministic and improving, so the agent is best used for comparing many rough builds and finding promising directions before manual testing.

The positives and negatives in `analysis.md` are generated from observed metrics such as win rate, life differential, brick rate, mulligan rate, incomplete games, matchup spread, unique-card count, zero-cost unit count, and curve concentration.
