import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deckPolicyProfile,
  loadMatchupOverlaysForProfile,
  policyPathForProfile,
  resolveArchetypeProfile,
  resolvePolicyForDeck,
  writeMatchupOverlay,
  writePolicyForProfile
} from "../src/policy-router.js";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "ua-policy-router-"));
}

function demoProfile() {
  return {
    key: "eva-purple",
    policyFileName: "eva-purple.json"
  };
}

function demoSavedDeck() {
  return {
    id: "carnerr-spear",
    summary: {
      sourceCode: "EVA",
      colors: ["purple"]
    },
    cards: []
  };
}

test("policy router writes set/color baselines into organized deck folders", () => {
  const root = tempRoot();
  const policyDir = join(root, "policies");
  const profile = demoProfile();
  const path = writePolicyForProfile({ name: "demo-policy", weights: {} }, profile, { policyDir });

  assert.match(path.replace(/\\/g, "/"), /baselines\/decks\/eva-purple\/baseline-policy\.json$/u);
  assert.equal(policyPathForProfile(profile, { policyDir }), path);

  const savedDeck = demoSavedDeck();
  const routed = resolvePolicyForDeck({
    deck: savedDeck.cards,
    savedDeck,
    deckId: savedDeck.id,
    catalog: {},
    policyDir
  });

  assert.equal(routed.kind, "set-color");
  assert.equal(routed.layout, "organized");
  assert.equal(routed.path, path);
  assert.equal(routed.foundSpecialist, true);
});

test("policy router still reads legacy flat specialist policies as fallback", () => {
  const root = tempRoot();
  const policyDir = join(root, "policies");
  mkdirSync(policyDir, { recursive: true });
  const legacyPath = join(policyDir, "eva-purple.json");
  writeFileSync(legacyPath, `${JSON.stringify({ name: "legacy-policy", weights: {} }, null, 2)}\n`);

  const savedDeck = demoSavedDeck();
  const routed = resolvePolicyForDeck({
    deck: savedDeck.cards,
    savedDeck,
    deckId: savedDeck.id,
    catalog: {},
    policyDir
  });

  assert.equal(routed.kind, "set-color");
  assert.equal(routed.layout, "legacy");
  assert.equal(routed.path, legacyPath);
  assert.equal(routed.foundSpecialist, true);
});

test("policy router uses explicit saved deck policy keys for archetype baselines", () => {
  const root = tempRoot();
  const policyDir = join(root, "policies");
  const profile = {
    key: "slg-purple-shadow-army",
    policyFileName: "slg-purple-shadow-army.json"
  };
  const path = writePolicyForProfile({ name: "shadow-army-policy", weights: {} }, profile, { policyDir });

  const savedDeck = {
    id: "carnerr-slg-purple-shadow-army",
    source: {
      policyKey: "SLG Purple Shadow Army"
    },
    summary: {
      sourceCode: "UE17BT",
      colors: ["purple"]
    },
    validation: {
      sourceCode: "SLG"
    },
    cards: []
  };
  const routedProfile = deckPolicyProfile({
    deck: savedDeck.cards,
    savedDeck,
    deckId: savedDeck.id,
    catalog: {}
  });
  const routed = resolvePolicyForDeck({
    deck: savedDeck.cards,
    savedDeck,
    deckId: savedDeck.id,
    catalog: {},
    policyDir
  });

  assert.equal(routedProfile.key, "slg-purple-shadow-army");
  assert.equal(routedProfile.setColorKey, "slg-purple");
  assert.equal(routed.kind, "set-color");
  assert.equal(routed.layout, "organized");
  assert.equal(routed.path, path);
  assert.equal(routed.foundSpecialist, true);
});

test("policy router infers archetype baselines from close decklist representatives", () => {
  const root = tempRoot();
  const policyDir = join(root, "policies");
  const libraryDir = join(root, "decks");
  mkdirSync(libraryDir, { recursive: true });
  const representative = {
    id: "engine-slg-purple-shadow-army",
    name: "Engine SLG Purple Shadow Army",
    source: {
      policyKey: "SLG Purple Shadow Army",
      archetype: "Shadow Army"
    },
    summary: {
      sourceCode: "SLG",
      colors: ["purple"]
    },
    validation: {
      sourceCode: "SLG"
    },
    cards: [
      { id: "UE17BT/SLG-1-030", count: 12 },
      { id: "UE17BT/SLG-1-038", count: 4 },
      { id: "UE17BT/SLG-1-040", count: 4 }
    ]
  };
  writeFileSync(join(libraryDir, `${representative.id}.json`), `${JSON.stringify(representative, null, 2)}\n`);
  const profile = {
    key: "slg-purple-shadow-army",
    policyFileName: "slg-purple-shadow-army.json"
  };
  const policyPath = writePolicyForProfile({ name: "shadow-army-policy", weights: {} }, profile, { policyDir });

  const untaggedDeck = {
    id: "regional-slg-purple-example",
    summary: {
      sourceCode: "SLG",
      colors: ["purple"]
    },
    validation: {
      sourceCode: "SLG"
    },
    cards: [
      { id: "UE17BT/SLG-1-030", count: 11 },
      { id: "UE17BT/SLG-1-038", count: 4 },
      { id: "UE17BT/SLG-1-040", count: 4 },
      { id: "UE17BT/SLG-1-041", count: 1 }
    ]
  };
  const resolution = resolveArchetypeProfile({
    savedDeck: untaggedDeck,
    deck: untaggedDeck.cards,
    deckId: untaggedDeck.id,
    deckLibrary: libraryDir
  });
  const routed = resolvePolicyForDeck({
    savedDeck: untaggedDeck,
    deck: untaggedDeck.cards,
    deckId: untaggedDeck.id,
    policyDir,
    deckLibrary: libraryDir
  });

  assert.equal(resolution.status, "matched");
  assert.equal(resolution.method, "deck-distance");
  assert.equal(resolution.profile.key, "slg-purple-shadow-army");
  assert.equal(resolution.distance, 1);
  assert.equal(routed.path, policyPath);
  assert.equal(routed.profile.archetypeResolution.status, "matched");
});

test("policy router flags untagged decks that are ten slots from known archetypes", () => {
  const root = tempRoot();
  const libraryDir = join(root, "decks");
  mkdirSync(libraryDir, { recursive: true });
  const representative = {
    id: "engine-eva-purple-spear-eva-13",
    name: "Engine EVA Purple Spear/EVA-13",
    source: {
      policyKey: "EVA Purple Spear EVA 13",
      archetype: "Spear/EVA-13"
    },
    summary: {
      sourceCode: "EVA",
      colors: ["purple"]
    },
    validation: {
      sourceCode: "EVA"
    },
    cards: [
      { id: "UE15BT/EVA-1-027", count: 20 },
      { id: "UE15BT/EVA-1-033", count: 20 },
      { id: "UE15BT/EVA-1-053", count: 10 }
    ]
  };
  writeFileSync(join(libraryDir, `${representative.id}.json`), `${JSON.stringify(representative, null, 2)}\n`);

  const distantDeck = {
    id: "regional-eva-purple-new-shape",
    summary: {
      sourceCode: "EVA",
      colors: ["purple"]
    },
    validation: {
      sourceCode: "EVA"
    },
    cards: [
      { id: "UE15BT/EVA-1-027", count: 10 },
      { id: "UE15BT/EVA-1-033", count: 20 },
      { id: "UE15BT/EVA-1-053", count: 10 },
      { id: "UE15BT/EVA-1-067", count: 10 }
    ]
  };
  const resolution = resolveArchetypeProfile({
    savedDeck: distantDeck,
    deck: distantDeck.cards,
    deckId: distantDeck.id,
    deckLibrary: libraryDir
  });

  assert.equal(resolution.status, "new-archetype-needed");
  assert.equal(resolution.method, "nearest-too-far");
  assert.equal(resolution.profile.key, "eva-purple");
  assert.equal(resolution.distance, 10);
  assert.equal(resolution.profile.archetypeResolution.nearest.key, "eva-purple-spear-eva-13");
});

test("matchup overlays write and load from the owning organized baseline folder", () => {
  const root = tempRoot();
  const policyDir = join(root, "policies");
  const ownProfile = demoProfile();
  const opponentProfile = { key: "kgr-red" };
  const path = writeMatchupOverlay({
    ownProfile,
    opponentProfile,
    policyDir,
    overlay: {
      name: "eva-purple-vs-kgr-red",
      weights: { attackPressure: 10 }
    }
  });

  assert.match(path.replace(/\\/g, "/"), /baselines\/decks\/eva-purple\/matchups\/kgr-red\.json$/u);

  const overlays = loadMatchupOverlaysForProfile(ownProfile, { policyDir });
  assert.equal(Object.keys(overlays).length, 1);
  assert.equal(overlays["kgr-red"].layout, "organized");
  assert.equal(overlays["kgr-red"].path, path);
  assert.equal(overlays["kgr-red"].overlay.opponentKey, "kgr-red");
});
