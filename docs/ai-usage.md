# AI Usage Contract

Use `tools/ai-engine.mjs` when an AI needs to inspect cards, choose decks, start games, list legal actions, or apply actions. All outputs are JSON so another AI can parse them reliably.

Use `tools/deck-agent.mjs` when an AI needs to evaluate or optimize decklists against a saved-deck gauntlet. It writes JSON/CSV reports and a pasteable `best-deck.txt`.

## Files To Provide

For code-only use, create a fresh export bundle when needed:

```powershell
Compress-Archive -Path README.md,package.json,src,tools,test,data,examples,docs -DestinationPath outputs/union-arena-local-engine.zip -Force
```

For local simulations with real cards and saved decks, keep these private files available in the same workspace:

```text
work/private/egman-unionarena-catalog.json
work/private/decks/*.json
```

The zip intentionally does not include private scraped card data or saved decks.

## Commands

List saved decks:

```powershell
node tools/ai-engine.mjs decks
```

Evaluate or optimize decks:

```powershell
node tools/deck-agent.mjs evaluate --deck legal-deck-id --opponents meta-deck-a,meta-deck-b --games 20 --auto-mulligan-bricks
node tools/deck-agent.mjs optimize --base legal-deck-id --opponents meta-deck-a,meta-deck-b --generations 3 --population 8 --games 12 --auto-mulligan-bricks
node tools/deck-agent.mjs solve --query "Blue Slime" --opponents meta-deck-a,meta-deck-b --generations 3 --population 8 --games 12 --auto-mulligan-bricks
node tools/deck-agent.mjs import-advice --advice-file work/private/deck-agent/run/union-arena-gpt-advice.json
```

Inspect one card:

```powershell
node tools/ai-engine.mjs card --id UE15BT/EVA-1-033
```

Search cards:

```powershell
node tools/ai-engine.mjs cards --query "Spear of Gaius" --limit 5
node tools/ai-engine.mjs cards --source UE15BT --query EVA-1-033
```

Start a game from saved deck IDs:

```powershell
node tools/ai-engine.mjs new-game --p1 eva-user-main --p2 eva-user-main --no-validate --out work/private/ai-games/eva-test.json
```

Use `--seed n` for reproducible shuffled decks or `--random-seed` for a fresh shuffle.

Summarize a state:

```powershell
node tools/ai-engine.mjs state --state work/private/ai-games/eva-test.json
```

The `new-game`, `state`, and `apply-action` commands include a `gameCatalog` object with matchup-analysis fields such as winner, life remaining, mulligans, first/second player, brick flags, special triggers in starting life, and turn counts.

List legal actions:

```powershell
node tools/ai-engine.mjs legal-actions --state work/private/ai-games/eva-test.json --player P1
```

Apply an action:

```powershell
node tools/ai-engine.mjs apply-action --state work/private/ai-games/eva-test.json --action "{\"type\":\"advancePhase\",\"player\":\"P1\"}"
```

For large or nested actions, write JSON to a file and use:

```powershell
node tools/ai-engine.mjs apply-action --state work/private/ai-games/eva-test.json --action-file work/private/action.json
```

## Notes For The AI

- Treat `legal-actions` as the default source for what can be done next.
- Decks are shuffled by default. Same seed means same shuffle; use `--random-seed` or changing `--seed` values for different games.
- Use `card --id` to inspect a card's encoded effects before relying on a card interaction.
- Use `gameCatalog` for simulation result analysis instead of deriving those fields from raw zones.
- For deck-agent runs, read `analysis.md` first for the agent's testing breakdown, positives, negatives, and recommendations.
- Give `advisor-prompt.md` to the user's Union Arena GPT when external card/deck critique is wanted, then import the GPT's JSON advice with `import-advice`.
- If a saved deck is marked unvalidated, use `--no-validate` when starting a game.
- Game state files are JSON and can be inspected directly, but prefer the CLI commands for mutations.
- If a command returns `{ "ok": false }`, stop and report the `error` string.
