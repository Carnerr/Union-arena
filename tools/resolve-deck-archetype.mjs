#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveArchetypeProfile } from "../src/policy-router.js";

const libraryDir = option("--library") ?? "work/private/decks";
const deckId = requiredOption("--deck");
const threshold = Number(option("--threshold") ?? 10);
const deckPrefixes = (option("--deck-prefix") ?? "carnerr-,engine-")
  .split(",")
  .map((prefix) => prefix.trim())
  .filter(Boolean);
const path = join(libraryDir, `${deckId}.json`);

if (!existsSync(path)) throw new Error(`Saved deck not found: ${path}`);

const raw = JSON.parse(readFileSync(path, "utf8"));
const resolution = resolveArchetypeProfile({
  deck: raw.cards,
  savedDeck: raw,
  deckId: raw.id ?? deckId,
  deckLibrary: libraryDir,
  threshold,
  deckPrefixes
});

console.log(JSON.stringify({
  deckId: raw.id ?? deckId,
  deckName: raw.name ?? raw.id ?? deckId,
  resolvedKey: resolution.profile.key,
  setColorKey: resolution.profile.setColorKey,
  status: resolution.status,
  method: resolution.method,
  threshold: resolution.threshold,
  distance: resolution.distance,
  nearest: resolution.nearest,
  candidates: resolution.candidates
}, null, 2));

function option(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function requiredOption(flag) {
  const value = option(flag);
  if (!value) throw new Error(`Missing required ${flag}. Example: node tools/resolve-deck-archetype.mjs --deck regional-eva-purple-example`);
  return value;
}
