# Card Data Workflow

The engine supports real cards through private JSON/CSV imports. Do not commit scraped card text, official images, or large copied databases unless you have permission to store them.

## Import A Private Catalog

Start from `data/catalog-template.json`, or prepare a CSV with these columns:

```csv
id,cardNumber,cardName,cardType,cardColor,requiredEnergy,apCost,BP,generatedEnergy,affinity,keywordEffect,triggerEffect,abilities,eventEffect
```

Then run:

```powershell
node tools/import-catalog.mjs path\to\cards.csv data\my-private-catalog.json
```

## Fetch From EGM Deck Builder

EGM currently exposes a direct Union Arena JSON endpoint. This project includes a fetcher that maps it into the engine catalog schema:

```powershell
node tools/fetch-egman-unionarena.mjs
```

Default outputs:

- `work/private/egman-unionarena-raw.json`
- `work/private/egman-unionarena-catalog.json`

Image URLs are omitted by default. To include image URL metadata without downloading images:

```powershell
node tools/fetch-egman-unionarena.mjs --include-image-urls
```

Use the resulting data privately and respect EGM's site terms plus the underlying Union Arena card IP.

Rebuild the encoded catalog from a saved raw file without network access:

```powershell
node tools/fetch-egman-unionarena.mjs --raw-in work\private\egman-unionarena-raw.json
```

Measure text-encoding coverage for the private pool:

```powershell
node tools/analyze-card-effects.mjs
```

Default report:

- `work/private/effect-coverage.json`

Compare local encoded card coverage to the official FAQ:

```powershell
node tools/audit-official-faq.mjs --series UE21BT
node tools/audit-official-faq.mjs --all-products
```

Default reports:

- `work/private/official-faq-audit.json`
- `outputs/union-arena-faq-audit-summary.json`

The importer normalizes aliases such as `cardNumber`/`number`, `cardName`/`name`, `cardType`/`type`, `generatedEnergy`/`energy`, and `keywordEffect`/`keywords`.

## Normalized Card Schema

```json
{
  "id": "abc_001",
  "number": "ABC-1-001",
  "sourceCode": "ABC",
  "name": "Card Name",
  "type": "character",
  "title": "Source Title",
  "color": "green",
  "requiredEnergy": { "color": "green", "amount": 1 },
  "apCost": 1,
  "bp": 3000,
  "energy": [{ "color": "green", "amount": 1 }],
  "affinities": ["Affinity"],
  "keywords": { "step": true, "impact": 1 },
  "trigger": { "type": "get" },
  "entersActive": false,
  "abilities": [],
  "staticModifiers": []
}
```

## Keywords

The importer recognizes these keyword labels from plain text:

- `Step`
- `Snipe`
- `Double Block`
- `Double Attack`
- `Impact (n)`
- `Impact (+n)`
- `Damage (n)`
- `Damage (+n)`
- `Nullify Impact`

## Effect Specs

Current reusable effect kinds:

- `sequence`: run multiple effects in order.
- `draw`, `drawOpponent`: draw cards.
- `lookTopDeck`: log a top-deck look for local simulation.
- `searchTopDeck`: look at top deck cards, add matching cards to a zone, and bottom the rest.
  - Add `publicReveal: true` when the whole looked group was revealed publicly, such as "Reveal the top two cards..."
  - Add `revealSelected: true` when the player looked privately but only the selected card was revealed, such as "Look at the top three cards... Reveal up to one... and add it to your hand."
- `moveTopDeck`: move cards from deck to `hand`, `life`, `sideline`, or `removal`.
- `placeTopDeckUnderSelf`: place deck cards under the source permanent.
- `moveUnderCardsToZone`: move cards under a permanent to `hand`, `sideline`, or another private zone.
- `moveZoneCardsUnderSelf`: move matching zone cards face down under the source permanent.
- `moveHandToZone`: move selected hand cards to `sideline` or `removal`.
- `moveCardBetweenZones`: move a matching card between private zones such as sideline to hand.
- `modifyBp`: change BP permanently or with `"duration": "turn"`.
- `grantKeyword`: grant a keyword permanently or with `"duration": "turn"`.
- `grantEnergy`: grant generated energy permanently or with `"duration": "turn"`.
- `readySelf`, `restSelf`, `readyTargets`, `restTargets`.
- `readyAp`: switch AP cards to active.
- `sidelineSelf`, `sidelineTargets`, `removeTargets`, `returnTargetsToHand`.
- `returnTargetsToHandOrSelf`: return a target to hand, or the source if no target exists.
- `moveTargetsToLine`, `moveTargetsToOtherLine`, `swapOwnFrontAndEnergy`.
- `moveTargetsToBottomDeck`, `moveTopRaidCardToZone`, `moveBaseCardFromSelf`.
- `damageOpponent`, `damage`.
- `discardFromHand`, `discardOpponentFromHand`.
- `moveSelfCardToDeckTop`: place the source card on top of its owner's deck when it is in a private zone.
- `playCardFromZone`: play one or more matching cards from hand and/or sideline.
- `recoverLifeIfEmpty`: final-trigger style life recovery.
- `scheduleSidelineSelfAtEndOfMain`: delayed sideline at the end of the main phase.
- `optional`, `chooseOne`, `unsupported`.

Target selectors can use:

```json
{
  "controller": "self",
  "line": "frontLine",
  "type": "character",
  "max": 1,
  "bpMax": 3500,
  "requiredEnergyMax": 2
}
```

Use `"controller": "opponent"` for opposing cards, `"line": "field"` for both front and energy lines, and `"choiceKey"` when an action supplies explicit target choices.

## Example Ability

```json
{
  "id": "rest-draw",
  "timing": "Activate: Main",
  "oncePerTurn": true,
  "conditions": { "line": "front" },
  "cost": { "restSelf": true },
  "effect": {
    "kind": "sequence",
    "effects": [
      { "kind": "draw", "amount": 1 },
      {
        "kind": "modifyBp",
        "amount": 1000,
        "duration": "turn",
        "target": "self"
      }
    ]
  }
}
```
