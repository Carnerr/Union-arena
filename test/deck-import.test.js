import test from "node:test";
import assert from "node:assert/strict";
import {
  CARD_TYPES,
  displayCardCode,
  makeSavedDeck,
  parseDeckText,
  slugifyDeckName,
  validateDeck
} from "../src/index.js";
import { sampleCatalog, sampleDeckList } from "../data/sample-cards.js";

test("deck text importer parses saved-list format into engine deck entries", () => {
  const text = [
    "// Main Deck",
    ...sampleDeckList.map((entry) => ` ${entry.count} x ${sampleCatalog[entry.id].number}`)
  ].join("\n");

  const parsed = parseDeckText(text, sampleCatalog);

  assert.equal(parsed.validation.size, 50);
  assert.equal(parsed.cards.length, sampleDeckList.length);
  assert.equal(parsed.summary.color, "green");
  assert.deepEqual(parsed.summary.colors, ["green"]);
  assert.equal(parsed.summary.colorCounts.green, 50);
  assert.deepEqual(
    parsed.cards.map(({ id, count }) => ({ id, count })),
    sampleDeckList
  );
  assert.equal(validateDeck(parsed.cards, sampleCatalog).sourceCode, "DEM");
});

test("deck text importer resolves product slash codes to prefixed catalog ids", () => {
  const catalog = {
    ue15bt_eva_1_027: {
      id: "ue15bt_eva_1_027",
      number: "UE15BT_EVA-1-027",
      sourceCode: "UE15BT",
      name: "Private Pilot",
      type: CARD_TYPES.CHARACTER,
      color: "blue",
      requiredEnergy: { color: "blue", amount: 0 },
      apCost: 0,
      bp: 1000,
      energy: [{ color: "blue", amount: 1 }],
      affinities: []
    }
  };

  const parsed = parseDeckText("4 x UE15BT/EVA-1-027", catalog, { validate: false });

  assert.deepEqual(parsed.cards, [{
    id: "ue15bt_eva_1_027",
    count: 4,
    number: "UE15BT_EVA-1-027",
    name: "Private Pilot"
  }]);
  assert.equal(displayCardCode("UE15BT_EVA-1-027"), "UE15BT/EVA-1-027");
});

test("deck validator allows booster and starter cards from the same source material", () => {
  const catalog = Object.fromEntries([...Array(13)].map((_, index) => {
    const number = index + 1;
    const product = index % 2 === 0 ? "UE15BT" : "UE15ST";
    const id = `${product.toLowerCase()}_eva_1_${String(number).padStart(3, "0")}`;
    return [id, {
      id,
      number: `${product}_EVA-1-${String(number).padStart(3, "0")}`,
      sourceCode: product,
      name: `EVA Card ${number}`,
      type: CARD_TYPES.CHARACTER,
      color: "purple",
      requiredEnergy: { color: "purple", amount: number === 1 ? 0 : 1 },
      apCost: 1,
      bp: 1000,
      energy: [{ color: "purple", amount: 1 }],
      affinities: []
    }];
  }));
  const deck = Object.keys(catalog).map((id, index) => ({ id, count: index === 12 ? 2 : 4 }));

  const validation = validateDeck(deck, catalog);

  assert.equal(validation.size, 50);
  assert.equal(validation.sourceCode, "EVA");
});

test("deck validator applies card-specific copy limit overrides", () => {
  const catalog = {
    shadow_soldiers: {
      id: "shadow_soldiers",
      number: "UE17BT_SLG-1-030",
      sourceCode: "UE17BT",
      name: "Shadow Soldiers",
      type: CARD_TYPES.CHARACTER,
      color: "purple",
      requiredEnergy: { color: "purple", amount: 0 },
      apCost: 1,
      bp: 1500,
      energy: [{ color: "purple", amount: 1 }],
      affinities: []
    }
  };
  for (let index = 1; index <= 10; index += 1) {
    catalog[`other_${index}`] = {
      id: `other_${index}`,
      number: `UE17BT_SLG-1-${String(index).padStart(3, "0")}`,
      sourceCode: "UE17BT",
      name: `Other ${index}`,
      type: CARD_TYPES.CHARACTER,
      color: "purple",
      requiredEnergy: { color: "purple", amount: index === 1 ? 0 : 1 },
      apCost: 1,
      bp: 1000,
      energy: [{ color: "purple", amount: 1 }],
      affinities: []
    };
  }
  const deck = [
    { id: "shadow_soldiers", count: 12 },
    ...[...Array(9)].map((_, index) => ({ id: `other_${index + 1}`, count: 4 })),
    { id: "other_10", count: 2 }
  ];

  const validation = validateDeck(deck, catalog);

  assert.equal(validation.size, 50);
  assert.equal(validation.sourceCode, "SLG");
});

test("deck text importer resolves equivalent ambiguous local reprints", () => {
  const base = {
    name: "Kenshin Himura",
    type: CARD_TYPES.CHARACTER,
    color: "red",
    requiredEnergy: { color: "red", amount: 0 },
    apCost: 1,
    bp: 1000,
    energy: [{ color: "red", amount: 1 }],
    affinities: [],
    trigger: { type: "get" }
  };
  const catalog = {
    ue11bt_rnk_1_085: {
      id: "ue11bt_rnk_1_085",
      number: "UE11BT_RNK-1-085",
      sourceCode: "UE11BT",
      ...base
    },
    ue11st_rnk_1_085: {
      id: "ue11st_rnk_1_085",
      number: "UE11ST_RNK-1-085",
      sourceCode: "UE11ST",
      ...base
    }
  };

  const parsed = parseDeckText("4 x RNK-1-085", catalog, { validate: false });

  assert.equal(parsed.cards[0].id, "ue11bt_rnk_1_085");
});

test("saved deck records preserve metadata while staying loadable as cards array", () => {
  const saved = makeSavedDeck({
    name: "EVA Test Deck",
    cards: [{ id: "demo_rookie", count: 4, number: "DEM-1-001", name: "Demo Rookie" }],
    validation: { size: 4, sourceCode: "DEM", uniqueCardNumbers: 1 }
  });

  assert.equal(saved.id, "eva-test-deck");
  assert.equal(slugifyDeckName("  EVA Test Deck!! "), "eva-test-deck");
  assert.deepEqual(saved.cards, [{ id: "demo_rookie", count: 4, number: "DEM-1-001", name: "Demo Rookie" }]);
});
