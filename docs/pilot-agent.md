# Union Arena Pilot Agent

This agent trains a gameplay pilot, not a deck list. The engine still owns legality and card resolution; the pilot learns how to rank legal actions and automatic choices.

## Commands

Evaluate the baseline pilot:

```powershell
node tools/pilot-agent.mjs evaluate --deck carnerr-spear --opponents regional-slg-purple-spencer-1-peoria-illinois --games 50 --auto-mulligan-bricks --out-dir work/private/pilot-agent/runs/spear-baseline-vs-spencer-50
```

You can omit `--deck` to pick from saved decks interactively before the run starts.

Train a pilot:

```powershell
node tools/pilot-agent.mjs train --deck carnerr-spear --opponents regional-slg-purple-spencer-1-peoria-illinois --games 20 --final-games 100 --generations 6 --population 10 --elite 2 --seed 1001 --auto-mulligan-bricks --progress-minutes 2 --out-dir work/private/pilot-agent/runs/spear-spencer-seed-1001
```

Use the best policy from a prior run:

```powershell
node tools/pilot-agent.mjs evaluate --deck carnerr-spear --opponents regional-slg-purple-spencer-1-peoria-illinois --policy work/private/pilot-agent/runs/spear-spencer-seed-1001/best-policy.json --games 200 --auto-mulligan-bricks --out-dir work/private/pilot-agent/runs/spear-spencer-seed-1001-check
```

## Opponent Modes

The agent now supports opponent selection modes. Old explicit lists still work:

```powershell
node tools/pilot-agent.mjs train --deck carnerr-spear --opponents regional-slg-purple-spencer-1-peoria-illinois --games 10 --final-games 80 --generations 5 --population 8 --seed 2001 --auto-mulligan-bricks --out-dir work/private/pilot-agent/runs/spear-explicit-spencer
node tools/pilot-agent.mjs train --deck carnerr-spear --opponents-file work/private/deck-gauntlets/regional-q1-2026.txt --games 10 --final-games 80 --generations 5 --population 8 --seed 2002 --auto-mulligan-bricks --out-dir work/private/pilot-agent/runs/spear-file-gauntlet
```

Random mode samples saved regional decks. The sample is deterministic for a given `--seed` unless you pass `--opponent-seed`.

```powershell
node tools/pilot-agent.mjs train --deck carnerr-spear --opponent-mode random --opponent-count 8 --games 10 --final-games 80 --generations 5 --population 8 --seed 2101 --auto-mulligan-bricks --out-dir work/private/pilot-agent/runs/spear-random-8-seed-2101
```

You can also use the mode word through `--opponents`:

```powershell
node tools/pilot-agent.mjs train --deck carnerr-spear --opponents random --opponent-count 8 --games 10 --seed 2102 --auto-mulligan-bricks --out-dir work/private/pilot-agent/runs/spear-random-8-seed-2102
```

Regional mode trains only against selected event locations:

```powershell
node tools/pilot-agent.mjs train --deck carnerr-spear --opponent-mode regional --regions "Peoria Illinois,Orlando Florida" --opponent-top 16 --games 10 --final-games 80 --generations 5 --population 8 --seed 2201 --auto-mulligan-bricks --out-dir work/private/pilot-agent/runs/spear-peoria-orlando-top16
```

All-regionals mode uses every saved regional deck, with optional filters:

```powershell
node tools/pilot-agent.mjs train --deck carnerr-spear --opponent-mode all-regionals --opponent-top 16 --games 6 --final-games 50 --generations 5 --population 8 --seed 2301 --auto-mulligan-bricks --out-dir work/private/pilot-agent/runs/spear-all-regionals-top16
```

Useful opponent filters:

- `--opponent-count 8`: sample this many decks after filters.
- `--regions "Peoria Illinois,Virginia"`: restrict to those event locations.
- `--opponent-top 16`: keep only decks with placement at or above that finish.
- `--opponent-color purple`: keep only matching deck colors.
- `--opponent-set SLG`: keep only matching set/source/deck text.
- `--opponent-seed 1234`: choose a separate deterministic random sample seed.
- `--opponent-include-self`: allow the selected deck to appear in the opponent pool.

With no opponent options, the default is `mirror` mode, which self-plays against the selected deck.

```powershell
node tools/pilot-agent.mjs evaluate --deck carnerr-spear --opponent-mode mirror --games 20 --auto-mulligan-bricks --out-dir work/private/pilot-agent/runs/spear-mirror-check
```

## Parallel Sessions

Launch several PowerShell windows or terminal tabs and vary `--seed` plus `--out-dir`.

```powershell
node tools/pilot-agent.mjs train --deck carnerr-spear --opponent-mode random --opponent-count 8 --games 20 --final-games 100 --generations 6 --population 10 --seed 3001 --auto-mulligan-bricks --out-dir work/private/pilot-agent/runs/spear-random-seed-3001
node tools/pilot-agent.mjs train --deck carnerr-spear --opponent-mode random --opponent-count 8 --games 20 --final-games 100 --generations 6 --population 10 --seed 3002 --auto-mulligan-bricks --out-dir work/private/pilot-agent/runs/spear-random-seed-3002
node tools/pilot-agent.mjs train --deck carnerr-spear --opponent-mode regional --regions "Peoria Illinois,Virginia" --games 20 --final-games 100 --generations 6 --population 10 --seed 3003 --auto-mulligan-bricks --out-dir work/private/pilot-agent/runs/spear-peoria-virginia-seed-3003
```

Compare `analysis.md`, `rankings.csv`, and `best-policy.json` from each run. The strongest policy can become the starting point for a broader run by passing it with `--policy`.

## Managed Parallel Runs

You can also let one command launch several child training runs, wait for them, compare their learned policies, build a merged policy from the child winners, run a final head-to-head check, and write one parent `best-policy.json`.

For the first managed run, do not pass `--policy work/private/pilot-agent/current-best-policy.json` yet. That file does not exist until a run creates it with `--update-policy`.

```powershell
node tools/pilot-agent.mjs train --deck carnerr-spear --opponent-mode random --opponent-count 8 --parallel-runs 4 --parallel-concurrency 4 --games 10 --final-games 80 --parallel-final-games 100 --generations 5 --population 8 --seed 6001 --auto-mulligan-bricks --progress-minutes 2 --update-policy work/private/pilot-agent/current-best-policy.json --out-dir work/private/pilot-agent/runs/spear-parallel-random-6001
```

After a reusable policy exists, `--policy current` is shorthand for `work/private/pilot-agent/current-best-policy.json`. If `--opponent-policy` is omitted, each opponent deck routes to its own set/color policy, falling back to the current Spear baseline.

If `--policy` is omitted or set to `auto`, the agent routes by the selected deck's saved profile key. Saved Carnerr and Engine decks should set `source.policyKey` for distinct archetype baselines such as `eva-purple-spear-eva-13`, `slg-purple-mill-woo`, and `slg-purple-shadow-army`. When a deck has no explicit key, the router compares its exact 50-card shape against known `carnerr-` and `engine-` representative decks in the same set/color. A deck fewer than 10 slots away from one representative inherits that archetype key; a deck 10+ slots away is flagged as `new-archetype-needed` so it can get its own Engine representative instead of silently becoming a player-specific policy. Routed specialist policies live under `work/private/pilot-agent/baselines/decks/<ownKey>/baseline-policy.json`. If no specialist exists, the agent falls back to `work/private/pilot-agent/current-best-policy.json`; training creates the missing specialist slot and updates it only when the run beats its baseline. Legacy files under `work/private/pilot-agent/policies/` are still read as fallbacks during migration.

To inspect a saved deck's routing decision:

```powershell
node tools/resolve-deck-archetype.mjs --deck regional-eva-purple-example
```

The parent locks the opponent pool once, then passes that exact opponent list to every child run. This makes the final comparison fair. To train on a wider gauntlet, increase `--opponent-count`, use `--opponent-mode all-regionals`, or run another parent session with a different `--seed`.

Useful parallel options:

- `--parallel-runs 4`: number of child training sessions to launch.
- `--parallel-concurrency 4`: maximum child processes running at once.
- `--parallel-final-games 100`: games per opponent for the parent comparison after children finish.
- `--parallel-final-top-percent 25`: parent comparison only tests the top child policies from that percent of child runs, plus the merged policy and starting baseline. When child baselines exist, top means score improvement over that child's starting policy; otherwise it falls back to absolute child score. With 12 child runs, the final tests the top 3 children.
- `--parallel-final-candidates merged-baseline`: parent comparison candidate set. Use `merged-baseline` for fast matchup-learning loops, `best-baseline` to test only the best child, `best-merged-baseline` for a middle ground, or `all` for the older full comparison.
- `--skip-parallel-final`: skip the expensive parent comparison and select by the skip-selection mode.
- `--parallel-skip-selection merged`: when skipping the parent comparison, select the score-weighted merge of child policies instead of one child.
- `--parallel-opponents-per-run`: give each child run its own opponent sample.
- `--parallel-opponent-seed 1234`: derive per-run opponent samples from a separate deterministic seed.
- `--parallel-decks deck-a,deck-b`: train child runs across a saved-deck pool.
- `--parallel-decks-file path`: load the child deck pool from a newline/comma-separated file.
- `--parallel-deck-mode round-robin`: assign child decks by `round-robin` or `random`.
- `--parallel-deck-seed 1234`: derive random child deck assignments from a separate deterministic seed.
- `--child-seed 1234`: derive child seeds from a separate deterministic seed.
- `--random-child-seeds`: use fresh random child seeds instead of reproducible child seeds.
- `--policy auto`: route by deck set/source and color, falling back to the current Spear baseline.
- `--policy-dir work/private/pilot-agent/policies`: choose the legacy policy root. The organized baseline root is the sibling `baselines/` directory unless a tool exposes `--baseline-root`.
- `--policy current`: use the current champion policy as the starting pilot.
- `--opponent-policy current`: force the current champion policy as the opponent pilot. If omitted, each opponent routes by its own set/color policy.
- `--update-policy work/private/pilot-agent/current-best-policy.json`: copy the final selected policy to a stable path for the next run, but only if it beats the baseline score.
- `--policy-promotion-margin 0`: require the candidate to beat the baseline by this score margin before updating the reusable policy. When a final baseline comparison runs, an existing trusted baseline also requires a positive paired common-random-number verdict; a score-only improvement is retained in the run folder but is not promoted.
- `--allow-skip-final-policy-promotion`: let skipped-final runs update the reusable policy if their aggregate score beats baseline. Without this, skipped-final runs are exploratory and keep their selected policy only in the output folder.
- `--force-update-policy`: overwrite the reusable policy even if the candidate did not beat the baseline.

By default, child seeds are pseudo-random but reproducible from `--seed`, so rerunning the same command gives the same child seeds. Add `--random-child-seeds` when you want fresh child seeds each run.

By default, every child trains against the same opponent pool. That is best when you want a fair apples-to-apples comparison between child policies. Add `--parallel-opponents-per-run` when you want broader training coverage: each child gets a different opponent sample, then the parent still final-tests every child policy on the same locked comparison pool.

```powershell
node tools/pilot-agent.mjs train --deck carnerr-spear --opponent-mode random --opponent-count 8 --parallel-opponents-per-run --parallel-runs 4 --parallel-concurrency 4 --games 10 --final-games 80 --parallel-final-games 100 --seed 6101 --auto-mulligan-bricks --no-training-games --update-policy work/private/pilot-agent/current-best-policy.json --out-dir work/private/pilot-agent/runs/spear-parallel-per-run-opponents-6101
```

For broad matchup-data passes, spread opponents across set/color buckets where possible:

```powershell
node tools/pilot-agent.mjs train --deck carnerr-spear --policy auto --opponent-mode random --opponent-count 20 --parallel-opponents-per-run --parallel-opponent-diversity set-color --parallel-opponent-count-per-run 1 --parallel-runs 10 --parallel-concurrency 10 --games 4 --generations 2 --population 5 --final-games 12 --skip-parallel-final --parallel-skip-selection merged --seed 13001 --pilot-mulligan --no-training-games --record-decisions --decision-log-mode learning --progress-minutes 2 --out-dir work/private/pilot-agent/runs/spear-matchup-data-13001
```

`--parallel-opponent-diversity set-color` tries to give each child a different regional deck profile, such as EVA purple, KGR red, or SLG purple. If there are more child runs than available profiles, it cycles through profiles while still avoiding duplicate deck IDs when possible.

To train a more general pilot across multiple saved decks, add `--parallel-decks`. Children train on the assigned decks, and the parent final comparison evaluates the top child policies, the merged policy, and the starting baseline across the whole deck pool.

```powershell
node tools/pilot-agent.mjs train --deck carnerr-spear --parallel-decks carnerr-spear,carnerr-blue-slime,carnerr-purple-slime,carnerr-purple-solo-leveling,carnerr-red-kagurabachi --opponent-mode random --opponent-count 8 --parallel-opponents-per-run --parallel-runs 10 --parallel-concurrency 4 --games 10 --final-games 80 --parallel-final-games 100 --seed 6201 --auto-mulligan-bricks --no-training-games --update-policy work/private/pilot-agent/current-best-policy.json --out-dir work/private/pilot-agent/runs/carnerr-generalist-6201
```

For faster learning intervals, use `--skip-parallel-final`. This still writes the normal parent `report.json`, `analysis.md`, `rankings.csv`, `best-policy.json`, and `parallel-runs.json`. Add `--parallel-skip-selection merged` for generalist training across different child decks or opponent samples; leave it out when every child had the same deck and opponents and you want the single best child by score. Skipped-final runs aggregate the child baseline results for review, but they do not update `--update-policy` unless you also pass `--allow-skip-final-policy-promotion` or `--force-update-policy`. Use the full parent final comparison later when you want a slower confirmation run.

The parent output folder contains the final selected policy and summary:

```text
best-policy.json
report.json
analysis.md
parallel-runs.json
parallel-child-processes.json
runs/run-01/
runs/run-02/
```

`parallel-runs.json` records every child result and which policy was selected. When the parent final comparison runs, it also records the merged-policy result and starting-policy comparison. If a reusable policy is updated, the run folder keeps a `previous-policy.json` snapshot and `policy-promotion.json` records the promotion decision. Each child run folder keeps its own `best-policy.json`, `report.json`, `analysis.md`, `stdout.log`, and `stderr.log`.

To continue training from the updated policy later:

```powershell
node tools/pilot-agent.mjs train --deck carnerr-spear --policy work/private/pilot-agent/current-best-policy.json --opponent-mode random --opponent-count 8 --parallel-runs 4 --parallel-concurrency 4 --games 10 --final-games 80 --parallel-final-games 100 --seed 7001 --auto-mulligan-bricks --update-policy work/private/pilot-agent/current-best-policy.json --out-dir work/private/pilot-agent/runs/spear-parallel-random-7001
```

## Progress Updates

Training prints timed progress updates by default every two minutes. Change the interval with:

```powershell
--progress-minutes 3
--progress-seconds 30
```

Disable timed updates with `--no-progress`.

For large learning batches, add `--no-training-games` to skip writing the full training-game ledger. The run still writes final `games.csv`, `rankings.csv`, `analysis.md`, `report.json`, and `best-policy.json`; it just avoids the large `training-games.csv` file from every candidate during training.

The report foregrounds `Average turn cycles`, which is the full back-and-forth game clock. For example, 12 individual player-turns is about 6 turn cycles. Raw CSV/JSON output may still include `avgTurns` for compatibility with older analysis tools.

The pilot scoring includes tempo features for pressure and blocking discipline: open-lane damage, low-life pressure, forcing blocks, passing with ready attackers, missed lethal, safe no-blocks, and early chump blocks. These features do not cap game length; they give training better signals so stronger policies can learn to end games naturally.

Use `--pilot-mulligan` when you want the policy to decide opening hands. This replaces the brick-only setup heuristic with setup-hand scoring for opener access, early energy path, turn-three plan potential, greedy payoff, and greedy risk. The learned setup weights appear in `analysis.md` under `Opening Hand Signals`.

Use `--auto-mulligan-bricks` only when you want the older fixed heuristic: mulligan if the initial hand has no setup-valid opener, otherwise keep.

Combat scoring models normal Union Arena attacks as attacks on the opposing player. The defender's block/no-block choice is represented through pressure, blocker quality, crack-back risk, and life-buffer features. Character-target attacks are scored separately and only appear when a legal action has Snipe or another effect-granted targeting rule. Learned combat, role, and ability-cost weights appear in `analysis.md` under `Combat And Ability Signals`.

## ML Action Scorer

The pilot can now write decision logs and train a lightweight local ML-style action scorer from those logs. The rules engine still owns legality; the model only learns extra weights for the same action features the heuristic pilot already scores.

Action evidence includes both structural game concepts and sparse card-specific context. The model can therefore distinguish playing a particular Raid card normally from raiding with it, learn individual Raid/base pairs, ability timing, movement, attacks, blocks, discards, opening-hand cards, and meaningful optional choices. Structural concepts use the normal 12-observation floor; an exact card/ability feature must accumulate at least 24 causal observations before it can enter a runtime model. Lower-support context remains in `trainingStats` and is shown as collecting evidence instead of being discarded. The dense solver always retains structural concepts and admits the most-observed graduated context within a 512-feature budget; `featureSelection` in each artifact and the dashboard show how many signals were retained, deferred for support, or dropped by the budget.

Knowledge updates and direct trainer commands default to direct `pairwise` mode with chosen-action outcome anchors disabled. The learner does not pretend that a game result proves what an unplayed action would have done: a chosen-versus-alternative pair is learned only when the decision row contains direct `counterfactualPreference` evidence from both branches. Exploration broadens the situations available for comparison; it does not manufacture a label from a win or loss. A zero pairwise count is therefore valid when no branch comparison was run. `--include-chosen-anchor` remains available for controlled diagnostics, but artifacts containing those raw outcome anchors are quarantined from runtime policy blending.

Record decision data during a run:

```powershell
node tools/pilot-agent.mjs train --deck carnerr-spear --policy auto --opponent-mode random --opponent-count 10 --parallel-opponents-per-run --parallel-runs 16 --parallel-concurrency 16 --games 4 --parallel-final-games 8 --parallel-final-top-percent 25 --generations 3 --population 6 --seed 15001 --pilot-mulligan --no-training-games --record-decisions --decision-log-mode learning --out-dir work/private/pilot-agent/runs/carnerr-spear-ml-data-15001
```

`--decision-log-mode learning` is the efficient default. It records complete final comparisons, including keep-versus-mulligan choices, plus only explored or directly counterfactual actions during training. It also writes one compact `pilot-learning-game@1` telemetry row per training game. That row never enters regression examples or feature weights. Both ML trainers accumulate it in a separate, persistent sampling-safety ledger so direct trainer commands cannot bypass exploration-yield and adaptive-depth audit gates; learning health and Auto Refine use the same telemetry to measure all attempted games instead of overestimating coverage from the few games that produced compact decision rows. Use `final` to omit exploratory training evidence, or `all` only when intentionally collecting a much larger diagnostic log.

Training presets sample games for direct branch rollouts. A phase and an eligible-decision ordinal are sampled before play, then the scheduler waits for that main, attack, block, or movement opportunity instead of always taking an early turn choice. If the requested phase never produces a useful decision, a late comparison is retained with an explicit fallback label. A smaller derived sample also compares keep versus mulligan, allowing opening-hand features to learn from causal rollouts instead of final-game correlation. The chosen line and a legal strategic alternative continue with exploration disabled. Fundamental pairs include block versus take life, attack versus pass, Raid versus normal play, Raid move versus stay, and which permanent a full line replaces. The exact legal alternative that earns the information-priority score is the one rolled out; rule-invalid alternatives are skipped.

Production presets use `counterfactual-probe` exploration: the policy's chosen move remains on the actual fitness trajectory, while the novel move receives immediate synchronized branch priority even when the ordinary random sampler did not select that game. This prevents the candidate from losing fitness because the trainer deliberately tested an unfamiliar move. Probes are capped at one experiment per player-game by default and share the counterfactual budget; after that causal slot is consumed, the rest of the game stays on-policy. The exploration scheduler gives plausible under-supported card, ability, movement, combat, replacement, and Raid lines a shared coverage lane. Novelty is calculated from the contextual features that differ between the chosen and alternate action, so a shared card or phase feature cannot make an already-tested branch look unseen. Every synchronized causal comparison updates session-local attempt coverage, while only a directional result increases learned support. This rotates repeated Raid, replacement, and optional-choice lines behind genuinely unseen alternatives. Priority and fallback probes both count as paired evidence when their branches reached a shared horizon. Explicit diagnostic runs can restore the older forced-action behavior with `--exploration-mode action`. Change the cap with `--exploration-max-per-game`.

Dynamically triggered choices use the same phase scheduler and pair-specific novelty rule. Optional effects, post-reveal searches, opponent responses, Raid triggers, and other choices that do not exist until an outer action is resolving stay on-policy in the played game. A nested choice can consume a causal slot only when it matches the sampled phase or the scheduler's explicit fallback condition. When sampled, the simulator clones the pre-action state, replays the same outer action and all earlier nested choices, changes exactly one nested branch, and compares the synchronized continuations from the decision owner's perspective. Repeated events rotate among under-tested options such as Raid stay and decline. These branches carry explicit action-family labels, so evidence breadth and held-out validation do not collapse every response into a generic `resolutionChoice` bucket.

Matchup training enables in-game sampling for 40% of games and setup sampling for 14%; deck training uses 35% and about 12%, capped at one total comparison per game and 64 rollout actions per branch. In-game comparisons request the same three-player-turn horizon, so a line that spends more actions developing its board is not compared at an earlier game-time point against a line that passes quickly. The evaluator first reaches a synchronized two-player-turn checkpoint. Only strong outcomes that keep the same direction from the immediate post-action state may stop there; thin, reversing, one-terminal-branch, and otherwise ambiguous comparisons continue through the full horizon. Keep-versus-mulligan comparisons always use the full horizon. A deterministic 10% sample of eligible early stops also continues to the full horizon. Audit disagreement is recorded in learning health, and sustained disagreement blocks artifact promotion rather than silently teaching from an unsafe shortcut.

The action cap is only a safety ceiling; if either nonterminal branch reaches that ceiling before the shared turn horizon, the comparison is tagged `unsynchronized-horizon`, forced to a tie, and excluded from pairwise learning. Terminal winner changes receive full confidence for deterministic in-game branches; stochastic mulligan evidence is capped at 45% confidence. Truncated but synchronized branches use a versioned, public-safe state evaluator covering life, visible board quality and readiness, energy development, AP, immediate attack pressure, deck count, and only the opponent hand count rather than hidden card identities. Horizon comparisons are explicitly tagged and down-weighted. Compact game telemetry records coverage-gap probes, contextual feature breadth, actionable exploration yield, adaptive turns saved, and full-horizon audit agreement. Override the main sampling budget with `--exploration-mode`, `--counterfactual-exploration-rate`, `--counterfactual-setup-rate`, `--counterfactual-max-per-game`, `--counterfactual-rollout-actions`, and `--counterfactual-rollout-player-turns`. P2 remains deterministic during candidate training, so benchmark noise is not mistaken for candidate improvement.

Train an action model from one or more run folders:

```powershell
node tools/train-ml-scorer.mjs --input work/private/pilot-agent/runs/carnerr-spear-ml-data-15001 --out work/private/pilot-agent/baselines/decks/eva-purple/action-model.json --name eva-purple-action-model
```

Blend the model into the next pilot run:

```powershell
node tools/pilot-agent.mjs train --deck carnerr-spear --policy auto --ml-model work/private/pilot-agent/baselines/decks/eva-purple/action-model.json --ml-strength 0.35 --opponent-mode random --opponent-count 10 --parallel-opponents-per-run --parallel-runs 16 --parallel-concurrency 16 --games 4 --parallel-final-games 8 --parallel-final-top-percent 25 --generations 3 --population 6 --seed 16001 --pilot-mulligan --no-training-games --record-decisions --decision-log-mode learning --out-dir work/private/pilot-agent/runs/carnerr-spear-ml-blend-16001
```

Start with `--ml-strength 0.25` to `0.5`. Higher values let the model steer harder but can overfit if the logs came from a narrow gauntlet.

Opponents automatically route to their own trusted profile action model when one exists, then fall back to a trusted global action model. Provisional and legacy models remain available for diagnostics and continued training but contribute no runtime policy weight. Use `--opponent-ml-model` to force one specific opponent model for an experiment, or `--no-opponent-profile-ml` to test against baseline-policy-only opponents.

## Matchup Overlays

The pilot can also blend matchup-specific overlays based on the opponent cards it has publicly seen. This does not read the opponent's hidden hand, life, or deck order. The profile starts unknown, then becomes confident as public cards hit field, sideline, removal, face-up life, or are revealed by searches and reveal abilities. Private top-deck looks stay private; only selected revealed cards or fully revealed top-deck groups become opponent evidence.

In practice, one public card usually gives a strong set/color read, and the logged profile also records observed 0/1-cost cards so future overlays can distinguish common builds inside the same color.

When saved opponent decklists are available, the pilot also compares the currently observed public card IDs against those known lists. This is meta knowledge, not game-state leakage: it uses saved deck card counts plus cards the player has actually seen. The current best deck-list read is logged as evidence and can change as more cards become public. Regional/player deck IDs do not become separate matchup policies by default; they resolve through the same archetype keys, so a Spencer-style Shadow Army list and another close Shadow Army list both train the `slg-purple-shadow-army` matchup profile.

The matchup selector starts with broad set/color reads, such as `eva-purple` or `kgr-red`. If public cards cleanly fit a known archetype representative, it promotes the overlay lookup to that archetype key, such as `eva-purple-spear-eva-13` or `slg-purple-shadow-army`. If public cards do not fit the known lists and enough evidence exists, the decision log records an unknown variant key such as `eva-purple__unknown-ab12cd`; that is how the agent can notice “this is actually a different build” without making a separate policy for every player.

Matchup overlays live inside the owning deck profile:

```text
work/private/pilot-agent/baselines/decks/eva-purple/matchups/rnk-red.json
work/private/pilot-agent/baselines/decks/eva-purple/matchups/kgr-red.json
```

Train overlays from decision logs:

```powershell
node tools/train-matchup-overlays.mjs --input work/private/pilot-agent/runs/carnerr-spear-ml-data-15001 --own-key eva-purple
```

Train unknown-variant overlays from the same logs:

```powershell
node tools/train-matchup-overlays.mjs --input work/private/pilot-agent/runs/carnerr-spear-ml-data-15001 --own-key eva-purple --group-by variant --min-examples 80
```

The easier post-run path is to let the knowledge updater do the action model, broad overlays, and variant overlays together:

```powershell
node tools/update-pilot-knowledge.mjs --input work/private/pilot-agent/runs/carnerr-spear-ml-data-15001 --own-key eva-purple
```

It writes `work/private/pilot-agent/baselines/decks/<ownKey>/action-model.json`, updates files under `work/private/pilot-agent/baselines/decks/<ownKey>/matchups`, and creates a knowledge manifest plus `next-run.ps1` under `work/private/pilot-agent/knowledge-updates`. The action-model, broad-overlay, and variant-overlay trainers run concurrently because they write independent artifacts; use `--serial-artifact-training` only when diagnosing the learning phase.

The direct trainers default to `pairwise` learning. Use `--learning-mode selected` or `--learning-mode all` only for a controlled raw-outcome diagnostic; those modes label their artifacts as outcome-anchored and remain runtime-quarantined even if no anchor flag is supplied. In normal `pairwise` mode, only the exact alternative evaluated by a direct counterfactual branch can create a preference example. `--pairwise-scale` controls how strongly that verified evidence moves weights; the old heuristic score gap does not suppress a result that the branch rollout directly observed.

## Overseer Loop

Once the trainer is behaving, use the overseer instead of manually running each command. The overseer has two optimized paths: deck training for learning the selected deck's baseline policy, and matchup training for learning action-model plus matchup-overlay knowledge after the deck policy is already credible. `--cycles` is a safety ceiling, not something you need to babysit; direct overseer launches default to three cycles.

```powershell
node tools/pilot-loop-overseer.mjs --training-mode matchup --deck carnerr-spear --own-key eva-purple --seed 13201
```

Useful loop controls:

```powershell
--training-mode matchup
--training-focus hybrid
--cycles 12
--max-cycles 12
--games 8
--generations 1
--parallel-runs 14
--parallel-concurrency 14
--parallel-opponent-count-per-run 1
--ml-strength 0.35
--parallel-final-games 0
--parallel-final-top-percent 25
--parallel-final-candidates merged-baseline
--decision-log-mode learning
--knowledge-mode full
--skip-parallel-final
--knowledge-inputs work/private/pilot-agent/runs/spear-knowledge-iter-13201
--cumulative-knowledge
--stop-after-each-cycle
--no-stop-if-no-promotion
--no-stop-if-no-learning
--dry-run
```

Use `--training-mode matchup` for the current matchup-learning loop: one opponent profile per child run, skipped parent finals by default, no base-policy promotion by default, and full knowledge updates (the profile action model plus broad/variant matchup overlays). Use `--training-mode deck` when you want to focus the selected deck's routed/base policy first: two opponent profiles per child run, a stronger final comparison, routed policy promotion enabled, and action-model-only knowledge updates so it does not create matchup overlays too early.

Training presets are defined once in `src/pilot-training-presets.js` and shared by the agent, overseer, and dashboard. The dashboard intentionally uses a richer deck-training launch than the lean direct CLI preset: 20 games and six random opponent decks per child instead of 12 and two. Those visible dashboard values are now passed explicitly to the overseer, so they cannot silently fall back to a different downstream default. Every overseer session writes a fully resolved `launch-plan.json` covering workers, opponent pool, training volume, exploration, knowledge mode, and validation before any games begin. For a no-run contract check, use `node tools/pilot-dashboard.mjs --check-launch-contract`.

Both paths isolate each knowledge update and conditionally run a paired common-random-number comparison against the previous artifact. Before launching games, the overseer compares the cycle snapshot with the new effective runtime policy and checks whether an active overlay candidate was produced. Candidate-only evidence, provisional ML, unchanged effective ML weights, and no-change updates skip gameplay validation because they cannot change a move in the engine. When behavior can change, the same seeds, opponent order, and first-player assignments are used before and after. Action-only validation holds the current deck policy and previous validated matchup overlays constant. Overlay-only validation holds the current deck policy and action model constant. Full matchup learning uses three variants: previous action model plus previous overlay, candidate action model plus previous overlay, then candidate action model plus candidate overlay. This attributes each change without needing four independent sides. Both layers must pass. If the action model passes but the overlay does not, profile rollback restores the old overlay and then retains the independently proven action model. This prevents an action-model improvement from being credited to an overlay, or an overlay improvement from masking a weak action model. The strict gate requires at least 12 paired games plus either directional outcome evidence or a consistent life/score improvement. Negative, inconclusive, missing, failed, or learning-health-blocked artifacts are restored or kept inactive without undoing a base-policy promotion that already passed training. Deck mode samples up to six opponents from that cycle's actual pool, while matchup mode validates against the selected archetype opponent. Use `--matchup-validation-games` to change the default 20 games per variant.

New or changed matchup overlays remain quarantined while this comparison runs. Before validation, an overlay must contain at least 30 direct causal pairs carrying at least 4.0 effective pairwise weight, with 30 classified pairs spanning at least two decision phases and three action-pair families; one action-pair family cannot exceed 85% of its evidence. The validator may apply a causally ready quarantined `after` artifact only inside its paired test. It also requires the changed overlay to be selected for at least half as many pilot decisions as validation games, with a floor of four, so unrelated changes cannot receive credit when opponent identification never routes into the candidate. Ordinary games ignore unready or unvalidated overlays and fall back to the last positively validated broad or archetype overlay. A positive result stamps only changed overlay files actually observed in validation. Retraining, editing learned weights or evidence metadata, or changing the state-evaluator version changes the exact artifact signature and automatically returns the overlay to quarantine until it passes again.

An overlay that is provisional, inconclusive, or negative is not allowed to replace the active file, but its duplicate-filtered causal ledger is retained under `baselines/decks/<ownKey>/matchup-candidates/<opponentKey>.json`. Even a below-threshold batch is written there. The next matchup cycle seeds training from that candidate when it contains more evidence than the active overlay, so short runs accumulate one causal corpus without repeatedly relearning the same decisions. Candidate source ledgers participate in migration and deduplication. The active `matchups/` file remains the last positively validated policy throughout. A later positive review promotes the accumulated artifact and removes its candidate file.

Each cycle supplies only its new run folder to the knowledge updater by default. The action model, overlays, held-out validation reservoir, source digests, and learning-unit filter already retain accepted history, so rereading every old folder would add startup cost without adding knowledge. Rejected decision logs remain in their run folders for audits and deliberate experiments. Use `--cumulative-knowledge` only for an explicit replay audit or rebuild; even then, copied and previously consumed evidence is filtered out.

Legacy action models and legacy matchup overlays are both disabled for runtime play. A learning artifact must use the duplicate-safe training pipeline, persistent source-content digests, a persistent learning-unit filter, covariance-aware multivariate regression, complete effective causal-weight accounting, classified evidence-breadth ledgers, and the current counterfactual state-evaluator version; an action model must also use seeded game-level validation assignment and balanced pairwise orientation before it can contribute policy weight. Source files are streamed through SHA-256 before parsing, so moving or copying an accepted decision log to another path cannot make either trainer learn it again. A scalable low-false-positive membership filter additionally records individual decision fingerprints, preventing an appended, combined, or partially overlapping corpus from reinforcing historical decisions while allowing its genuinely new decisions through. Old nonterminal counterfactual labels are ignored; an old terminal winner-change remains valid because it does not depend on heuristic state scoring. Pre-regression-v2 and pre-causal-ledger artifacts rebuild from retained source logs when those logs remain available; otherwise they stay quarantined instead of inheriting unprovable historical counts. This prevents old forced choices, incomplete games, duplicated evidence, over-credited long games, stale horizon judgments, repetitive action families, weak comparisons that pass by count alone, and correlated features that describe the same move from multiplying its learned reward.

The ML trainers stream JSONL rows instead of loading complete decision logs into memory. Large unattended runs therefore use memory proportional to one decision group rather than the entire log, avoiding the old `Invalid string length` failure mode. Learning presets retain at most two candidate rows per decision: the chosen move and the exact rolled-out counterfactual when one exists. Full diagnostic logging modes can still retain the wider candidate list.

Current mode defaults:

```text
matchup: games 8, generations 1, population 4, opponents/run 1, final games 0, skipped parent final, ML strength 0.35, knowledge full
deck:    games 12, generations 3, population 8, opponents/run 2, final games 10, final candidates best-merged-baseline, ML strength 0.20, knowledge action-only
```

Deck mode updates the selected routed specialist policy. It only updates `current-best-policy.json` automatically when `--own-key eva-purple` is selected, keeping the Spear/EVA policy as the fallback baseline for unknown decks.

The hybrid stop condition is no learning movement: no reusable/routed policy promotion and no created or updated matchup overlay. Use `--training-focus policy` if you want the older base-policy-only stopping rule.

The overseer writes:

```text
work/private/pilot-agent/loops/<session>/loop-state.json
work/private/pilot-agent/loops/<session>/launch-plan.json
work/private/pilot-agent/loops/<session>/latest-handoff.md
work/private/pilot-agent/loops/<session>/cycle-01/handoff.md
```

When you want Codex to review a completed cycle, paste the contents of `latest-handoff.md` or just give Codex the loop folder path.

## Pilot Dashboard

The local dashboard is a deck-centric coach hub. Each saved Carnerr or Engine deck appears in the left deck rail, and you can drag those deck buttons or use the small up/down controls to put them in your preferred order. The order is saved in the browser and only changes the dashboard display. The top strip holds the loop controls you normally change: training mode, opponent set/color, cycles, search runs, active workers, and games. It also shows the resource-aware CPU budget. Seeds advance automatically. Regional decklists stay in the same saved-deck library for engine opponents and gauntlets, but they are hidden from the pilot deck rail.

```powershell
node tools\pilot-dashboard-service.mjs start
```

That starts the dashboard as a background service and verifies `http://127.0.0.1:8787/api/state` before reporting success. Then open:

```text
http://127.0.0.1:8787
```

If the dashboard ever feels stale, stuck, or the port is confused, use the reset command. It stops the process currently listening on the dashboard port, starts a fresh dashboard, and verifies that it is responding:

```powershell
node tools\pilot-dashboard-service.mjs restart
```

Useful service commands:

```powershell
node tools\pilot-dashboard-service.mjs status
node tools\pilot-dashboard-service.mjs stop
```

If you prefer the package scripts from PowerShell on this machine, use `npm.cmd run pilot:dashboard`, `npm.cmd run pilot:dashboard:reset`, and `npm.cmd run pilot:dashboard:status`. The `.cmd` form avoids PowerShell's script execution-policy block on `npm.ps1`.

The dashboard writes controller state and logs here:

```text
work/private/pilot-agent/dashboard/
```

Use `Build Needed Baselines` first when you want to build missing baselines quickly. The dashboard queues every Carnerr/Engine deck with no specialist baseline, trains one deck at a time with the full local worker budget, and writes each winner under `work/private/pilot-agent/baselines/decks/<ownKey>/baseline-policy.json`. Keeping deck-level concurrency at one avoids multiplying a full set of simulation workers by several simultaneous decks; the suite automatically continues through the remaining queue.

The same baseline suite is available from PowerShell:

```powershell
node tools/pilot-agent.mjs train --parallel-decks missing-baselines --parallel-deck-prefix carnerr-,engine- --update-parallel-child-routed-policies --no-create-routed-policy --no-update-routed-policy --opponent-mode random --opponent-count 84 --parallel-opponents-per-run --parallel-opponent-diversity set-color --parallel-opponent-count-per-run 6 --parallel-runs 14 --parallel-concurrency 14 --games 20 --generations 8 --population 8 --skip-parallel-final --seed 17001 --pilot-mulligan --no-training-games --record-decisions --decision-log-mode learning --progress-minutes 2 --out-dir work/private/pilot-agent/runs/missing-baselines-17001
```

Deck Training always uses a random regional opponent pool. If the selected pilot deck does not have a specialist policy yet, the routed policy system creates `work/private/pilot-agent/baselines/decks/<ownKey>/baseline-policy.json` from the fallback policy and the run works from there. The dashboard derives `ownKey` from the selected deck's saved profile key, falling back to set/color when no explicit archetype key exists, so you do not need to type it.

Use `Matchup Sweep` after a deck baseline and runtime-ready profile action model exist. The sweep applies the same readiness contract as the engine and dashboard: current learning pipeline, validation assignment, and state evaluator; at least 75% signal trust; eight held-out player-games; 30 direct pairwise examples carrying at least 4.0 effective pairwise weight; and 30 breadth-tracked comparisons spanning at least three phases, three action-pair families, and two opponent archetypes. No action pair may supply more than 85% of the tracked evidence. Effective weight includes decision credit, observed advantage, evaluator confidence, and pairwise scale, so dozens of barely distinguishable horizon results cannot activate ML by count alone. A model file merely existing is not enough. Excluded decks and their exact readiness reasons are written to `matchup-sweep-state.json`. The sweep combines raw game coverage with the actual active/candidate artifact ledger. Missing causal pairs, effective mass, phase breadth, action-pair breadth, migrations, and validation-ready candidates receive explicit priority; a matchup with 60 raw games is not considered learned merely because its sample counter is full. Each task trains one selected pilot deck into one regional archetype bucket, uses one opponent list per child run, records final decision evidence, and updates the deck's action model plus matchup overlays. `--bootstrap-baseline-if-missing` is the explicit exception for a deck with no baseline; it lets the overseer build that profile before the requested matchup. This is the fast refinement lane when you want to sharpen several matchups without running a long master comparison.

The same matchup sweep is available from PowerShell:

```powershell
node tools/pilot-matchup-sweep.mjs --deck carnerr-spear --limit 3 --target-games 60 --parallel-runs 14 --parallel-concurrency 14 --seed 19001
```

Useful sweep controls:

```powershell
--deck carnerr-spear       selected pilot deck; use all for every Carnerr/Engine deck with a baseline
--limit 3                  number of matchup buckets to refine this sweep
--mode priority            priority, missing, low-sample, weak, or all
--target-games 60          keep revisiting buckets below this sample size
--opponent-keys rnk-red    optional comma-separated opponent archetype filter
--dry-run                  write the selected commands without starting training
```

Use `Auto Refine` when you want the machine to keep working unattended. It reads the deck rail order from the dashboard, starts with the top deck, groups missing baselines and profile-ML catch-up decks into recoverable jobs, then exhausts one ready deck's matchup queue before advancing. Dashboard launches use a physical-core-scale CPU budget (16 workers on the current 32-thread machine) and permit only one full-strength baseline or profile-ML deck loop at a time, preventing nested suites from silently doubling the worker count. Each recoverable job handles one opponent archetype by default, so its knowledge update, conditional paired validation, retry, and dashboard result finish as one compact unit. Routine round-robin baseline refresh is deliberately smaller at two decks per pass, so it does not delay matchup work behind another all-baselines campaign. The light baseline tier is 8 games, 2 generations, population 4, and 8 final games per child; deep increases to 12/3/6/10, while long uses 16/4/8/12. This gives the first pass roughly one third of the old workload and reserves expensive search for a real plateau. The generated state file records nominal per-child and all-child game slots for every tier. It applies the engine's exact action-model readiness contract, including the pairwise threshold. An unresolved profile receives its configured suite attempts and at most one individual attempt per pass; it is then recorded as a scheduler skip. Skips remain visible but do not consume the `maxJobs` training budget or advance the seed. The loop retries a failed child job once, writes state after every step, and escalates through light, deep, then long settings after a full no-progress pass. Training and knowledge subprocesses snapshot the live profile first and restore it on failure, so an automatic retry cannot build on a partial model or overlay. A no-progress pass means the deck profiles' baseline policy, action model, and matchup overlay artifacts did not change across the pass.

The same auto-refiner is available from PowerShell:

```powershell
node tools/pilot-auto-refiner.mjs --deck-order carnerr-spear,carnerr-blue-slime,carnerr-purple-slime --start-deck carnerr-spear --max-jobs 48 --target-games 60 --parallel-runs 14 --parallel-concurrency 14 --seed 20001
```

Useful auto-refiner controls:

```powershell
--decks all                 all Carnerr/Engine deck profiles; or pass a comma-separated subset
--deck-order deck-a,deck-b  priority order, usually the dashboard deck rail order
--max-jobs 48               unattended safety ceiling
--stages light,deep,long    escalation ladder after plateau
--max-retries 1             retry failed jobs once with a new seed
--dry-run                   write the first planned commands without training
```

The `Baseline Tracker` summarizes every Carnerr and Engine deck at once. It shows whether each deck has a specialist baseline, whether its ML/action model is still using the global fallback or has a profile model, how many completed runs and matchup games it has, the weakest known matchup, linked card-decision evidence, and the next recommended training action. Clicking a tracker row selects that deck in the rest of the dashboard.

After baselines exist, use a deck button plus `Matchup Training`. The opponent dropdown is a set/color selector, such as EVA purple or RNK red. Starting the loop with a matchup selected launches the overseer with `--opponent-mode random` plus `--opponent-set` and `--opponent-color`, so each child samples multiple saved regional lists from that archetype bucket instead of training against one player's exact deck. If you accidentally start matchup training before a specialist policy exists, the overseer first runs one deck-baseline bootstrap for that set/color, updates the profile action model, and then continues into the requested matchup loop.

The selected matchup drives the top stats panel, the matchup notes panel, and `Selected Matchup Card Evidence`. The dashboard defaults to the weakest known matchup for the selected pilot deck because that is usually the first place to train or investigate. `Bad Matchup Radar` ranks recorded matchup buckets by completed-game win rate, completed-game life spread, completed-game turn length, and sample size so weak archetypes are visible without opening the raw table. Incomplete simulations remain visible in W/L/I and reliability notes, but they are excluded from strategic averages and cannot satisfy matchup-confidence thresholds. The raw matchup table is still available under `Evidence Tables` for deeper inspection.

`Selected Matchup Card Evidence` filters card-linked decisions down to the currently selected matchup. It shows each card's matchup-specific decision count, win/loss/incomplete record, reward, life spread, common action types, and a next check. This is the best place to ask “which cards or play patterns are hurting this matchup?” before trying any deck edits.

`Deck Experiment Planner` is the bridge toward future deck editing. It shows the hard gates first: specialist baseline, profile ML model, total matchup games, confident matchup buckets, and card-linked decision evidence. When those are immature, the planner tells you what to collect next. When enough evidence exists, it proposes controlled experiment questions such as the next focused matchup, weak-pattern cards to inspect, useful roles to protect, and global card-watch items. It still does not auto-edit the deck; it tells you what to test and what guardrails to keep.

`Deck Edit Lab` is the controlled deck-change lane. Use `Run Deck Experiment` after selecting a pilot deck and, ideally, a focused set/color matchup. The dashboard launches `tools/deck-agent.mjs optimize` with legal-deck validation, policy routing, pilot mulligans, and a separate output folder under `work/private/pilot-agent/deck-experiments`. The saved base list is not overwritten. The lab reads the resulting `report.json` and `best-deck.json`, compares the candidate to the saved base list, and shows the paired final win-rate/score delta, exact copy-count adds/cuts, opponent pool, and first recommendation. Treat positive candidates as hypotheses: rerun the same matchup with more games before manually updating a saved deck.

`Card Pros / Cons Readout` turns the saved deck list plus all decision evidence into a cautious card-level review. It highlights roles such as opener, reducer, search, draw, trigger, core, or flex; then it adds evidence-backed positives, concerns, and a next check. These rows are still associations from pilot decisions, not automatic cut/add commands.

`Evidence Tables` also includes `Card Decision Evidence`, `Deck Card Matrix`, `Pilot Learning Signals`, and `Performance Trend`. Card Decision Evidence is built from decision logs and shows chosen card-linked decisions, associated win rate, shaped reward, life spread, common action types, and matchup buckets. Deck Card Matrix is built from the saved list plus catalog metadata and shows count, type, required/opening energy, AP, BP, trigger, and card roles such as opener, empty-field reducer, raid, search, draw, core, or flex. Pilot Learning Signals shows the strongest reward and penalty weights from the current action model, grouped by opening hand, attack, defense, abilities, energy, development, and card roles. Performance Trend shows recent completed runs for the selected pilot deck with win rate, score, life spread, turn cycles, and promotion result. These tables are evidence surfaces for review; they are not standalone cut/add recommendations.

The `General Deck Notes / Suggestions / Possible Changes` panel turns current evidence into priorities, next actions, strengths, concerns, performance notes, pilot-learning notes, edit-readiness notes, deck-shape notes, card-package notes, and card-slot notes. It intentionally stays evidence-based: missing baselines/models are called out as setup work, weak matchup claims require saved game rows, pilot-learning notes come from the action model's learned feature weights, and card-slot notes are based on catalog-backed list structure until richer card-level performance data is available. Edit readiness is gated by a specialist baseline, a profile action model, enough matchup games, and confident matchup buckets; until then the dashboard points you toward more training instead of premature deck changes.

The dashboard launches training loops as detached child processes with stdout and stderr written directly to `work/private/pilot-agent/dashboard/loop.log`. That makes a started loop more durable if the dashboard page or server is refreshed/restarted. The Stop button controls loops launched by the dashboard. Runs started manually in another PowerShell window still appear in the run tables after they write files, but the dashboard does not blindly kill unrelated Node processes.

`Loop Health` interprets the controller state, loop-state file, latest log line, stale-log age, stop reason, handoff path, and failure artifacts such as `failure.json` or `report-write-error.json`. Use it before reading raw logs: it should tell you whether the process is live, stale, stopped by the no-learning rule, missing, or failed during report writing.

`Own Key` is now dashboard-managed. It is still the policy profile key for the deck you are training, not the baseline itself. For example, Carnerr Spear uses `eva-purple-spear-eva-13`, Blue Slime uses `tsk-blue`, and Red Kagurabachi uses `kgr-red`. The key tells the policy router and knowledge updater which specialist policy, action model, and matchup overlays to use or write, such as `work/private/pilot-agent/baselines/decks/tsk-blue/baseline-policy.json`, `work/private/pilot-agent/baselines/decks/tsk-blue/action-model.json`, or `work/private/pilot-agent/baselines/decks/tsk-blue/matchups/eva-yellow.json`. If a profile action model does not exist yet, the overseer falls back to `current-action-model.json` while future knowledge updates create the profile model. The normal dashboard path keeps knowledge updates on: deck training runs action-model updates, while matchup training runs full action plus matchup-overlay updates.

The old advanced loop settings are now dashboard-managed defaults based on the selected training mode. The collapsible `Loop Log` panel sits under the top controls so you can monitor a run without opening the evidence tables, and you can collapse it when you want more vertical space. `Reset Layout` clears any old saved dashboard layout and deck-rail order. `Clear Log` only clears the dashboard's live loop log panel; it does not delete run reports or matchup evidence.

Future pilot runs use those overlay files automatically. Useful controls:

```powershell
--matchup-overlay-strength 1
--matchup-min-confidence 0.7
--matchup-variant-min-deck-confidence 0.55
--matchup-variant-min-coverage 0.75
--matchup-unknown-min-evidence 4
--no-matchup-overlays
```

Use lower confidence such as `--matchup-min-confidence 0.5` if you want overlays to activate after the first public card even in slightly mixed evidence. Keep the default `0.7` for cleaner reads.

Decision logs include these matchup columns when `--record-decisions` is enabled:

- `matchupProfileKey`: current public set/color read, such as `eva-purple`.
- `matchupConfidence`: share of public evidence matching the top read.
- `matchupObservedLowCostCardIds`: known 0/1-cost character IDs, useful for identifying common build variants.
- `matchupDeckCandidateId`: best saved-deck fingerprint match from observed cards.
- `matchupDeckCandidateConfidence`: probability-like confidence among the selected fingerprint candidates.
- `matchupVariantKey`: exact overlay bucket when the known list or unknown variant is more specific than set/color.
- `matchupVariantStatus`: `known-archetype`, `known-deck`, `unknown-variant`, `broad`, or `unknown`.
- `matchupVariantCardIds`: public cards used to name an unknown variant signature.

Decision logging keeps the chosen action plus the highest-ranked alternatives, capped at 24 candidates per final decision and two per exploratory training decision. Forced decisions with only one legal action are omitted. The alternatives support diagnostics and direct counterfactual comparisons without treating an unplayed action as known. Change the caps with `--decision-log-max-candidates` and `--training-decision-log-max-candidates`; the live pilot still evaluates every legal action.

## Evaluation And Learning Integrity

Candidate policies within a generation use common random numbers: every candidate sees the same initial deck shuffles, first-player assignments, opponent order, and mulligan streams. Final baseline-versus-candidate comparisons also use identical seeds with action exploration disabled. This makes score differences attributable to policy behavior instead of different opening draws.

Each generation uses a fresh seed batch, so raw scores from different generations are not treated as directly comparable. The policy sent to final validation is the last generation's champion, after the elite lineage has been re-evaluated and evolved through every generation. An earlier all-time training high remains in the report only as a diagnostic; it cannot win final selection merely because its seed batch was easier.

Policy score v2 optimizes wins first, then final life margin, with a strong incomplete-game penalty. Turn count and long-game rate remain visible diagnostics but are not reward terms. The learner therefore gains nothing by losing quickly and is free to take a longer defensive or trigger-aware line when that improves the actual result.

Matchup impact validation uses the same paired method. Its report includes improved, regressed, and tied game counts, a directional binomial probability, and aggregate win-rate, life, turn-cycle, incomplete-rate, and score deltas. Two favorable flips in a 20-game check are inconclusive; the unattended loop restores the pre-cycle profile unless the configured gate sees enough paired practical evidence.

Knowledge updates are incremental. Each action model and matchup overlay stores sufficient per-feature training statistics plus the exact decision-log files already consumed. A later cycle reads only new logs and merges their statistics. Within every supplied corpus, a source-independent evidence fingerprint prevents copied or overlapping decision groups from increasing the model's example count; the artifact and dashboard report unique units and duplicates ignored. Use `--no-merge-existing` on `update-pilot-knowledge.mjs` only when intentionally rebuilding a model from scratch.

Learning-signal version 2 excludes incomplete games and forced actions, preserves positive targets for wins and negative targets for losses, and caps each player's total credit per game at 24 decision-equivalents. Credit is divided by phase so hundreds of attack responses cannot drown out mulligan, movement, or main-phase learning. Later choices receive slightly more credit, phase-advance bookkeeping receives less, and actual exploratory actions receive a modest boost. The model reports both raw examples and effective weighted examples so a long game cannot masquerade as dozens of independent games.

Action-model validation holds out whole seeded games, never individual decisions or another policy trajectory from a correlated game that also appears in training. Assignment is independent of decision-log path and candidate policy name. Held-out examples persist across incremental updates in a deterministic priority reservoir capped at 5,000 samples by default, so every new fit is checked against cumulative evidence instead of only the newest batch. Pairwise examples receive a deterministic, outcome-independent orientation: flipping both the feature difference and target leaves the fitted weight equation unchanged, but produces balanced positive and negative held-out labels. Validation therefore cannot claim 100% merely because every target was encoded as positive. It reports raw and balanced sign accuracy, positive/negative counts, majority baseline, effective causal weight, and the independent player-games still represented in the retained reservoir. Games that no longer have a retained comparison cannot inflate the game count. One-class validation, such as a run containing only losses, stays provisional even if raw accuracy is 100%. Held-out comparisons are also classified by player-game, phase, action-pair family, opponent archetype, and evidence kind. Runtime activation requires at least 1.0 effective held-out pairwise weight and retained coverage across eight player-games, two phases, three action-pair families, and two opponents. Each of three supported action families needs at least five held-out examples from at least two player-games, must include both deterministic target orientations, and may not fall below 50% directional accuracy; one family may not exceed 85% of the holdout. `--validation-fraction 0` is diagnostic-only and always quarantines the resulting model. A model contributes no runtime policy weight until it uses the current pipeline, cumulative validation state, pairwise orientation, validation assignment, and state evaluator, reaches at least 75% signal trust, has eight retained held-out games, contains 30 direct pairwise training examples with at least 4.0 effective training weight, and satisfies both the training and held-out evidence-breadth contracts. The trainer persists player-game, phase, action-pair, opponent-archetype, evidence-kind, and effective-weight accounting. Validation-state upgrades preserve learned training statistics but discard opaque old holdout samples; fresh games rebuild the classified validation reservoir incrementally. Missing or explicitly forced incompatible training evidence remains classified as historical unknown and can never influence runtime play. Legacy and provisional artifacts continue collecting evidence without steering play.

Pairwise validation also canonicalizes each model-visible feature difference independently of the trainer's randomized sign orientation. This reveals cases where the exact same visible input receives both preferred-action labels, which no deterministic linear scorer can resolve. Sparse disagreement is reported as information, not treated as corruption. Once validation contains at least three repeated contexts and 12 repeated examples, more than 25% minority effective weight quarantines the model; otherwise the dashboard reports the irreducible conflict rate and the corresponding maximum attainable repeated-input accuracy. The learning-data audit and knowledge preflight use the same definition, so contradictory labels are visible before they can silently become a promoted runtime model.

During action-only deck training, healthy provisional models are retained as inactive learning memory instead of being rolled back merely because they cannot yet change gameplay. Their accepted decision logs remain eligible for cumulative updates. Once a model reaches runtime readiness, the normal paired common-random-number gameplay gate activates; negative or inconclusive impact restores the last inactive/accepted profile snapshot. Matchup overlays never use this provisional exception.

Baseline policy weights and ML corrections are persisted as separate layers. Training evaluates their combined runtime policy, then removes the current ML contribution before writing `best-policy.json` or promoting a routed baseline. Loading that baseline later applies the ML layer exactly once, so repeated training cycles cannot compound the same model weights. Quarantined, outcome-anchored, blocked, or legacy ML artifacts also cannot suppress evidence-aware exploration through their observation counters; healthy provisional causal evidence may still guide the explorer toward under-sampled card actions.

The knowledge manifest also records learning health. Excess incomplete/forced rows, stale signal or state-evaluator versions, missing credit, or a large one-class model without reliable counterfactual pairs blocks the update. Branch-coverage diagnostics separately report available, played, causally tested, and covered counts for Raid-versus-normal-play, Raid stay/move/replacement, field replacement, and nested resolution options. Candidate-only action types are likewise separated from candidate actions that were never played but did receive a direct causal comparison. Repeatedly available and genuinely uncovered branches become watch-level warnings; a safe counterfactual is not mislabeled as a missing decision merely because the live policy stayed on-policy. Learning-mode telemetry reports comparisons and actionable labels per attempted training game, so sparse compact logs cannot make causal sampling look healthier than it is; Auto Refine raises both causal and bounded opportunity sampling when that measured yield is thin. The direct action-model and matchup-overlay trainers retain the same telemetry cumulatively and stamp unsafe artifacts as blocked, while the runtime independently refuses an artifact whose sampling-safety ledger is blocked. Splitting unsafe audit evidence across several small incremental runs therefore cannot evade quarantine. The audit reports the evaluator-version mix and game-level sampling yield so stale or sparse horizon evidence is visible instead of silently discarded. The overseer restores the pre-knowledge profile immediately and skips paired validation games for a blocked update. Watch-level diagnostics remain visible without silently promoting the artifact.

Policy search mutates a small number of coherent feature groups per child instead of perturbing every weight at once. This makes a generation test interpretable changes such as opening-hand, attack, block, Raid, movement, or ability preferences. `baseScore` is a constant and is never mutated or learned.

Audit any run before feeding it into the learner:

```powershell
node tools/audit-learning-data.mjs --input work/private/pilot-agent/runs/my-run --out work/private/audits/my-run-learning.json
```

The audit includes information-score and sampling-reason totals, priority and fallback probe pairing, played-versus-causal branch coverage, canonical repeated-input conflict diagnostics, and the same phase/action-pair/opponent diversity summary used by runtime readiness. Normal `evaluate` runs remain deterministic even when training exploration defaults exist. Pass `--explore-evaluation` only for a diagnostic evaluation in which you intentionally want exploratory actions and counterfactual labels; do not use that switch for policy promotion or win-rate benchmarking.

Baseline-suite child runs sample six opponent archetypes per child by default even when the global regional pool is larger. This keeps each candidate evaluation bounded while the parallel suite still covers a broad opponent population.

After changing reveal encoding, rebuild the cached EGM catalog from the saved raw dump:

```powershell
node tools/fetch-egman-unionarena.mjs --raw-in work/private/egman-unionarena-raw.json --raw-out work/private/egman-unionarena-raw.json --catalog-out work/private/egman-unionarena-catalog.json
```

Use `--no-deck-inference` to disable saved-deck fingerprint matching while keeping normal set/color matchup profiling.

## Output Files

- `best-policy.json`: the learned gameplay policy to reuse.
- `analysis.md`: plain-language positives, negatives, matchup notes, and learned weight changes.
- `report.json`: full structured report.
- `rankings.csv`: policy candidates and scores.
- `games.csv`: final evaluation game rows.
- `training-games.csv`: game rows from the training search.
- `decision-log.jsonl`: optional per-action learning data when `--record-decisions` is enabled.

## How It Fits The Deck Agent

The next layer should use a strong `best-policy.json` when evaluating deck changes. Once the pilot is credible, deck optimization results become more meaningful because wins and losses are less dominated by bad autoplay choices.

```powershell
node tools/deck-agent.mjs evaluate --deck carnerr-spear --opponents regional-slg-purple-spencer-1-peoria-illinois --pilot-policy work/private/pilot-agent/runs/spear-spencer-seed-1001/best-policy.json --games 100 --auto-mulligan-bricks --out-dir work/private/deck-agent/spear-with-trained-pilot
```
