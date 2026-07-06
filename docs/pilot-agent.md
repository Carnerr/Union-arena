# Union Arena Pilot Agent

This agent trains a gameplay pilot, not a deck list. The engine still owns legality and card resolution; the pilot learns how to rank legal actions and automatic choices.

## Commands

Evaluate the baseline pilot:

```powershell
node tools/pilot-agent.mjs evaluate --deck user-eva-033-test --opponents regional-slg-purple-spencer-1-peoria-illinois --games 50 --auto-mulligan-bricks --out-dir work/private/pilot-agent/eva-baseline-vs-spencer-50
```

Train a pilot:

```powershell
node tools/pilot-agent.mjs train --deck user-eva-033-test --opponents regional-slg-purple-spencer-1-peoria-illinois --games 20 --final-games 100 --generations 6 --population 10 --elite 2 --seed 1001 --auto-mulligan-bricks --out-dir work/private/pilot-agent/eva-spencer-seed-1001
```

Use the best policy from a prior run:

```powershell
node tools/pilot-agent.mjs evaluate --deck user-eva-033-test --opponents regional-slg-purple-spencer-1-peoria-illinois --policy work/private/pilot-agent/eva-spencer-seed-1001/best-policy.json --games 200 --auto-mulligan-bricks --out-dir work/private/pilot-agent/eva-spencer-seed-1001-check
```

Train against a gauntlet file:

```powershell
node tools/pilot-agent.mjs train --deck user-eva-033-test --opponents-file work/private/deck-gauntlets/regional-q1-2026.txt --games 10 --final-games 80 --generations 5 --population 8 --seed 2001 --auto-mulligan-bricks --out-dir work/private/pilot-agent/eva-regional-seed-2001
```

## Parallel Sessions

Launch several PowerShell windows or terminal tabs and vary `--seed` plus `--out-dir`.

```powershell
node tools/pilot-agent.mjs train --deck user-eva-033-test --opponents regional-slg-purple-spencer-1-peoria-illinois --games 20 --final-games 100 --generations 6 --population 10 --seed 3001 --auto-mulligan-bricks --out-dir work/private/pilot-agent/eva-spencer-seed-3001
node tools/pilot-agent.mjs train --deck user-eva-033-test --opponents regional-slg-purple-spencer-1-peoria-illinois --games 20 --final-games 100 --generations 6 --population 10 --seed 3002 --auto-mulligan-bricks --out-dir work/private/pilot-agent/eva-spencer-seed-3002
node tools/pilot-agent.mjs train --deck user-eva-033-test --opponents regional-slg-purple-spencer-1-peoria-illinois --games 20 --final-games 100 --generations 6 --population 10 --seed 3003 --auto-mulligan-bricks --out-dir work/private/pilot-agent/eva-spencer-seed-3003
```

Compare `analysis.md`, `rankings.csv`, and `best-policy.json` from each run. The strongest policy can become the starting point for a broader run by passing it with `--policy`.

## Output Files

- `best-policy.json`: the learned gameplay policy to reuse.
- `analysis.md`: plain-language positives, negatives, matchup notes, and learned weight changes.
- `report.json`: full structured report.
- `rankings.csv`: policy candidates and scores.
- `games.csv`: final evaluation game rows.
- `training-games.csv`: game rows from the training search.

## How It Fits The Deck Agent

The next layer should use a strong `best-policy.json` when evaluating deck changes. Once the pilot is credible, deck optimization results become more meaningful because wins and losses are less dominated by bad autoplay choices.

```powershell
node tools/deck-agent.mjs evaluate --deck user-eva-033-test --opponents regional-slg-purple-spencer-1-peoria-illinois --pilot-policy work/private/pilot-agent/eva-spencer-seed-1001/best-policy.json --games 100 --auto-mulligan-bricks --out-dir work/private/deck-agent/eva-with-trained-pilot
```
