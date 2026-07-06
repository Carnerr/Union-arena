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
- `work/union_arena_rule_manual.pdf`: local rules reference.

## Generated Output

These directories are safe to prune when their results are no longer needed:

- `work/private/batch-simulations/`
- `work/private/deck-agent/`
- `work/private/pilot-agent/`
- `work/private/simulations/`
- `work/private/ai-games/`
- `outputs/`

Prefer naming serious runs descriptively, for example:

```text
work/private/pilot-agent/eva-spencer-seed-1001/
work/private/deck-agent/eva-with-trained-pilot/
work/private/batch-simulations/user-eva-033-regional-200/
```

Smoke runs should use `smoke-...` in the directory name so they are easy to delete later.

## Regenerable Scratch Files

- `work/manual_pages/`: rendered rule-manual images. Keep the PDF instead.
- `outputs/union-arena-local-engine.zip`: old export bundle. Recreate when needed.
- `work/private/*smoke*`: short command checks and temporary smoke outputs.

## Cleanup Rule

Before deleting, keep any run that represents a real decision point or longer simulation sample. Delete smoke runs, one-off JSON game states, and rendered intermediate files after tests pass.
