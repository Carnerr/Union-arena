# Workspace Layout

This repository keeps source code, docs, private card data, saved decks, and generated run output in separate places.

## Keep

- `src/`: engine code.
- `tools/`: command-line tools for imports, simulations, agents, and audits.
- `test/`: regression tests.
- `data/`: fictional sample cards and catalog templates.
- `examples/`: small runnable demos.
- `docs/`: project documentation.
- `work/private/egman-unionarena-catalog.json`: normalized private card catalog used by the engine.
- `work/private/egman-unionarena-raw.json`: raw private card data used to rebuild the catalog.
- `work/private/decks/`: canonical saved local deck library.
- `work/private/deck-gauntlets/`: reusable opponent lists.
- `work/private/deck-imports/`: raw text decklist imports, useful as source material.
- `work/private/audits/`: saved gap and FAQ audit results.
- `work/private/pilot-agent/baselines/`: organized pilot baselines by deck profile key. Profile keys may be broad set/color keys or named archetypes such as `eva-purple-spear-eva-13`. Each profile has `baseline-policy.json`, optional `action-model.json`, validated runtime overlays in `matchups/`, and inactive accumulating overlays in `matchup-candidates/`.
- `work/union_arena_rule_manual.pdf`: local rules reference.

## Generated Output

These directories are safe to prune when their results are no longer needed:

- `work/private/batch-simulations/`
- `work/private/deck-agent/`
- `work/private/pilot-agent/policies/`: legacy flat policy storage. Keep until everything has migrated, then archive deliberately.
- `work/private/pilot-agent/runs/`
- `work/private/pilot-agent/smoke/`
- `work/private/pilot-agent/smoke-runs/`
- `work/private/simulations/`
- `work/private/ai-games/`
- `outputs/`

Prefer naming serious runs descriptively, for example:

```text
work/private/pilot-agent/runs/eva-spencer-seed-1001/
work/private/deck-agent/eva-with-trained-pilot/
work/private/batch-simulations/user-eva-033-regional-200/
```

Smoke runs should go under `work/private/pilot-agent/smoke/` or the legacy `smoke-runs/` folder so they are easy to delete later. Keep `work/private/pilot-agent/current-best-policy.json`; that is the reusable Spear/current fallback policy. Keep `work/private/pilot-agent/baselines/`; those are specialist pilots, validated matchup policies, and deduplicated candidate evidence, such as `baselines/decks/eva-purple-spear-eva-13/baseline-policy.json`, `baselines/decks/eva-purple-spear-eva-13/matchups/eva-yellow.json`, and `baselines/decks/eva-purple-spear-eva-13/matchup-candidates/eva-yellow.json`.

## Regenerable Scratch Files

- `work/manual_pages/`: rendered rule-manual images. Keep the PDF instead.
- `outputs/union-arena-local-engine.zip`: old export bundle. Recreate when needed.
- `work/private/pilot-agent/smoke-runs/`: short command checks and temporary smoke outputs.

## Cleanup Rule

Before deleting, keep any run that represents a real decision point or longer simulation sample. Delete smoke runs, one-off JSON game states, and rendered intermediate files after tests pass.
