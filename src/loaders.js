import { readFileSync } from "node:fs";
import { normalizeCatalog, validateCatalog } from "./catalog.js";

export function loadCatalogJson(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const catalog = raw.cards ? normalizeCatalog(raw.cards) : normalizeCatalog(raw);
  validateCatalog(catalog);
  return catalog;
}

export function loadDeckJson(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (Array.isArray(raw)) return raw;
  if (raw.cards) return raw.cards;
  if (raw.deck) return raw.deck;
  throw new Error(`Deck JSON must be an array or contain "cards"/"deck": ${path}`);
}
