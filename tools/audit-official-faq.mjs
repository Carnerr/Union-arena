#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const FAQ_INDEX = "https://www.unionarena-tcg.com/na/faq/";
const DEFAULT_CATALOG = "work/private/egman-unionarena-catalog.json";

const seriesArg = valuesAfter("--series");
const allProducts = process.argv.includes("--all-products");
const allowEmpty = process.argv.includes("--allow-empty");
const existingIn = valueAfter("--from-existing");
const catalogPath = valueAfter("--catalog") ?? DEFAULT_CATALOG;
const out = valueAfter("--out") ?? "work/private/official-faq-audit.json";
const summaryOut = valueAfter("--summary-out") ?? "outputs/union-arena-faq-audit-summary.json";

if (process.argv.includes("--help")) {
  console.log(`Usage:
  node tools/audit-official-faq.mjs [--series UE21BT] [--all-products] [--from-existing path] [--catalog path] [--out path] [--summary-out path] [--allow-empty]

Fetches official Union Arena FAQ list pages and compares card-specific FAQ entries to the local encoded catalog.
The summary output avoids reproducing FAQ questions/answers and stores only IDs, card codes, and status labels.`);
  process.exit(0);
}

const catalog = loadCatalog(catalogPath);
const catalogIndex = buildCatalogIndex(catalog);
const { seriesList, entries, cardEntries, audited } = existingIn
  ? auditExistingReport(existingIn, catalogIndex)
  : await auditOfficialPages(catalogIndex);

const summary = {
  source: FAQ_INDEX,
  generatedAt: new Date().toISOString(),
  productPages: seriesList.length,
  faqEntries: entries.length,
  cardSpecificEntries: cardEntries.length,
  statuses: countBy(audited, "status"),
  topics: countBy(audited, "topic")
};

if (!allowEmpty && summary.faqEntries === 0) {
  throw new Error("FAQ audit parsed 0 entries. Refusing to overwrite outputs; pass --allow-empty only if this is intentional.");
}

const report = {
  summary,
  entries: audited
};

writeJson(out, report);
writeJson(summaryOut, {
  summary,
  entries: audited.map(({ id, updated, series, cardCode, cardId, status, topic, engineExpectation }) => ({
    id,
    updated,
    series,
    cardCode,
    cardId,
    status,
    topic,
    engineExpectation
  }))
});

console.log(`Fetched ${seriesList.length} FAQ product page(s).`);
console.log(`Parsed ${entries.length} FAQ entries; ${cardEntries.length} are card-specific.`);
console.log(`Status counts: ${JSON.stringify(summary.statuses)}`);
console.log(`Private report: ${out}`);
console.log(`Summary report: ${summaryOut}`);

async function auditOfficialPages(catalogIndex) {
  const seriesList = await resolveSeriesList();
  const pages = [];
  for (const series of seriesList) {
    const url = new URL("list.php", FAQ_INDEX);
    url.searchParams.set("series", series);
    const html = await fetchText(url.href);
    if (!allowEmpty && /Data acquisition failed/i.test(html)) {
      throw new Error(`Official FAQ page returned a data-acquisition failure: ${url.href}`);
    }
    pages.push({ series, url: url.href, entries: parseFaqEntries(html, url.href) });
  }

  const entries = pages.flatMap((page) => page.entries.map((entry) => ({ ...entry, series: page.series, sourceUrl: page.url })));
  const cardEntries = entries.filter((entry) => entry.cardCode);
  const audited = cardEntries.map((entry) => auditEntry(entry, catalogIndex));
  return { seriesList, entries, cardEntries, audited };
}

function auditExistingReport(path, catalogIndex) {
  const existing = JSON.parse(readFileSync(path, "utf8"));
  const sourceEntries = existing.entries ?? [];
  const audited = sourceEntries.map((entry) => auditKnownEntry(entry, catalogIndex));
  return {
    seriesList: [...new Set(audited.map((entry) => entry.series).filter(Boolean))],
    entries: sourceEntries,
    cardEntries: sourceEntries.filter((entry) => entry.cardCode),
    audited
  };
}

async function resolveSeriesList() {
  if (seriesArg.length > 0) return [...new Set(seriesArg)];
  if (!allProducts) return ["UE21BT"];

  const html = await fetchText(FAQ_INDEX);
  const series = new Set();
  for (const match of html.matchAll(/list\.php\?series=([A-Z0-9]+)/g)) {
    series.add(match[1]);
  }
  return [...series].sort();
}

function parseFaqEntries(html, sourceUrl) {
  const entries = [];
  for (const unit of html.matchAll(/<section class="faqUnit">([\s\S]*?)<\/section>/g)) {
    const block = unit[1];
    const title = matchText(block, /<h2 class="tit">(Q\d+)<span>(.*?)<\/span><\/h2>/);
    if (!title) continue;
    const cardIdText = matchText(block, /<p class="cardID">(.*?)<\/p>/)?.[0] ?? "";
    const cardCode = cardIdText.includes("/") ? cardIdText.split("/").at(-1) : "";

    entries.push({
      id: title[0],
      updated: stripTags(title[1]),
      sourceUrl,
      cardIdText: stripTags(cardIdText),
      cardCode: stripTags(cardCode),
      cardName: stripTags(matchText(block, /<p class="cardName">(.*?)<\/p>/)?.[0] ?? ""),
      question: stripTags(matchText(block, /<div class="question[\s\S]*?<p>([\s\S]*?)<\/p>/)?.[0] ?? ""),
      answer: stripTags(matchText(block, /<div class="answer[\s\S]*?<p>([\s\S]*?)<\/p>/)?.[0] ?? "")
    });
  }
  return entries;
}

function auditEntry(entry, catalogIndex) {
  const cardId = idFromCardCode(entry.cardCode);
  const card = catalogIndex.get(cardId) ?? catalogIndex.get(idFromCardCode(localCardCode(entry.cardCode)));
  const text = `${entry.question} ${entry.answer}`.toLowerCase();
  const cardEffectKinds = collectCardEffectKinds(card);
  const topic = classifyTopic(text, entry.cardCode);
  const status = classifyStatus({ card, topic, cardEffectKinds, text });

  return {
    id: entry.id,
    updated: entry.updated,
    series: entry.series,
    cardCode: entry.cardCode,
    cardId: card?.id ?? cardId,
    status,
    topic,
    engineExpectation: expectationForTopic(topic),
    effectKinds: [...cardEffectKinds].sort()
  };
}

function auditKnownEntry(entry, catalogIndex) {
  const cardId = idFromCardCode(entry.cardCode);
  const card = catalogIndex.get(cardId) ?? catalogIndex.get(idFromCardCode(localCardCode(entry.cardCode)));
  const cardEffectKinds = collectCardEffectKinds(card);
  const topic = entry.topic ?? "card-specific-unclassified";
  const status = classifyStatus({ card, topic, cardEffectKinds });

  return {
    ...entry,
    cardId: card?.id ?? entry.cardId ?? cardId,
    status,
    topic,
    engineExpectation: expectationForTopic(topic),
    effectKinds: [...cardEffectKinds].sort()
  };
}

function classifyTopic(text, cardCode) {
  if (text.includes("top raided card") || text.includes("raided card")) return "raid-stack-top-card";
  if (cardCode === "BLC-1-065" || (text.includes("same character twice") && text.includes("separate characters"))) return "independent-repeat-targets";
  if (text.includes("choose two") || text.includes("same ability twice")) return "multi-choice-distinct-order";
  if (text.includes("color trigger") && (text.includes("instead") || text.includes("in place of"))) return "replacement-color-trigger";
  if (text.includes("cannot be blocked")) return "block-restriction-once-per-turn";
  if (text.includes("when sidelined") || text.includes("when played")) return "trigger-non-activation";
  return cardCode ? "card-specific-unclassified" : "general";
}

function classifyStatus({ card, topic, cardEffectKinds }) {
  if (!card) return "missing-card-data";
  if (topic === "raid-stack-top-card") {
    return "covered-by-regression";
  }
  if (topic === "multi-choice-distinct-order") {
    return cardEffectKinds.has("chooseN")
      || cardEffectKinds.has("optionalChoiceUpgrade")
      || cardEffectKinds.has("choiceModeAssist")
      ? "covered-by-regression"
      : "engine-gap";
  }
  if (topic === "independent-repeat-targets") {
    return cardEffectKinds.has("modifyBp") && cardEffectKinds.has("sequence")
      ? "covered-by-regression"
      : "engine-gap";
  }
  if (topic === "replacement-color-trigger") {
    return cardEffectKinds.has("triggerReplacement") ? "covered-by-regression" : "manual-engine-gap";
  }
  if (topic === "block-restriction-once-per-turn") {
    return cardEffectKinds.has("cantBeBlockedByRequiredEnergyMin") || cardEffectKinds.has("grantKeyword")
      ? "covered-by-regression"
      : "manual-engine-gap";
  }
  if (topic === "trigger-non-activation") return "covered-by-regression";
  return cardEffectKinds.has("unsupported") ? "needs-manual-review" : "mapped-no-regression";
}

function expectationForTopic(topic) {
  switch (topic) {
    case "raid-stack-top-card":
      return "Removing a top Raid card leaves the base permanent on field, keeps active/resting state, does not fire played/sidelined triggers, and clears effects applied to the former top card.";
    case "multi-choice-distinct-order":
      return "Multi-choice effects must choose distinct branches and resolve selected branches in printed order.";
    case "replacement-color-trigger":
      return "Replacement color-trigger abilities should replace, not duplicate, the original color trigger.";
    case "independent-repeat-targets":
      return "Independent repeated target instructions may choose the same target or different targets, and each effect resolves separately.";
    case "block-restriction-once-per-turn":
      return "Named once-per-turn attack restrictions are shared across copies where the FAQ says so.";
    default:
      return "No executable expectation classified yet.";
  }
}

function collectCardEffectKinds(card) {
  const kinds = new Set();
  if (!card) return kinds;
  for (const ability of card.abilities ?? []) collectEffectKinds(ability.effect, kinds);
  collectEffectKinds(card.eventEffect, kinds);
  collectEffectKinds(card.trigger?.effect, kinds);
  for (const assist of card.choiceModeAssists ?? []) kinds.add("choiceModeAssist");
  for (const replacement of card.triggerReplacements ?? []) {
    kinds.add("triggerReplacement");
    collectEffectKinds(replacement.effect, kinds);
  }
  return kinds;
}

function collectEffectKinds(effect, kinds) {
  if (!effect) return;
  kinds.add(effect.kind ?? "unknown");
  for (const child of effect.effects ?? []) collectEffectKinds(child, kinds);
  for (const choice of effect.choices ?? []) collectEffectKinds(choice.effect, kinds);
  for (const key of ["effect", "elseEffect", "costEffect", "baseEffect", "upgradedEffect", "ifMovedEffect", "insteadEffect"]) {
    collectEffectKinds(effect[key], kinds);
  }
}

function loadCatalog(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return raw.cards ?? raw;
}

function buildCatalogIndex(catalog) {
  const index = new Map();
  for (const [id, card] of Object.entries(catalog)) {
    index.set(id, card);
    if (card.number) {
      index.set(idFromCardCode(card.number), card);
      index.set(idFromCardCode(localCardCode(card.number)), card);
    }
  }
  return index;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "accept": "text/html",
      "user-agent": "union-arena-local-engine/0.1 private faq audit"
    }
  });
  if (!response.ok) throw new Error(`FAQ fetch failed ${response.status}: ${url}`);
  return response.text();
}

function matchText(text, regex) {
  const match = text.match(regex);
  return match ? match.slice(1) : undefined;
}

function stripTags(value) {
  return String(value ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, "\"")
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function idFromCardCode(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function localCardCode(value) {
  return String(value ?? "").split("_").at(-1).split("/").at(-1);
}

function countBy(rows, key) {
  const counts = {};
  for (const row of rows) counts[row[key]] = (counts[row[key]] ?? 0) + 1;
  return counts;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function valuesAfter(flag) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === flag && process.argv[index + 1]) values.push(process.argv[index + 1]);
  }
  return values;
}
