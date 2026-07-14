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
    sourceUrl: entry.sourceUrl,
    cardCode: entry.cardCode,
    cardName: entry.cardName,
    question: entry.question,
    answer: entry.answer,
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
  const text = `${entry.question ?? ""} ${entry.answer ?? ""}`.toLowerCase();
  const cardEffectKinds = collectCardEffectKinds(card);
  const topic = classifyTopic(text, entry.cardCode);
  const status = classifyStatus({ card, topic, cardEffectKinds, text });

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
  if ((text.includes("following") && text.includes("if you do"))
    && (text.includes("condition was not satisfied") || text.includes("only two cards") || text.includes("only three cards"))) {
    return "partial-if-do-payment";
  }
  if (text.includes("face-down card") && text.includes("under") && (text.includes("can check") || text.includes("cannot check"))) {
    return "face-down-under-visibility";
  }
  if (text.includes("destination line is full") || text.includes("maximum number of cards that can be placed on the line")) {
    return "line-capacity-overflow";
  }
  if (text.includes("remain set to resting the next time") || text.includes("remain resting the next time")) {
    return "ready-lock-single-consumption";
  }
  if (text.includes("bp printed in the lower left") || text.includes("printed bp")) return "printed-bp-value";
  if (text.includes("ap cost that is printed") || text.includes("printed ap cost")) return "printed-ap-cost";
  if (text.includes("when this character attacks and wins a battle") || text.includes("attacks and battles one of your opponent's characters")) {
    return "battle-win-definition";
  }
  if ((text.includes("after the battle ends") && text.includes("trigger check"))
    || text.includes("at the end of your attack phase after your opponent activates a trigger")) {
    return "post-battle-trigger-timing";
  }
  if ((text.includes("add it to your hand without revealing") || text.includes("do not perform a trigger check"))
    && text.includes("hand")) {
    return "life-move-no-trigger-check";
  }
  if (text.includes("they choose one character that can block") || text.includes("must block your opponent's attacks if able")) {
    return "mandatory-block-choice";
  }
  if (text.includes("blocking character declaration step") || text.includes("blocking character designation step")) {
    return "when-blocking-timing";
  }
  if ((text.includes("additional cost") && text.includes("choose this character"))
    || text.includes("cannot be chosen by abilities like")
    || text.includes("prevents the character from being chosen by abilities like")) {
    return "targeting-choose-protection";
  }
  if (text.includes("lose if you have zero cards in your life") || text.includes("lose after managing this card's ability")) {
    return "life-zero-state-action";
  }
  if (text.includes("generates energy even while on the front line")) return "front-line-energy-generation";
  if (text.includes("abilities that affected the raided card lose their effect")
    || text.includes("when performing raid, all abilities affecting")
    || text.includes("abilities affecting the base raid card do not remain")) {
    return "raid-resets-applied-effects";
  }
  if (text.includes("raided card was resting") && text.includes("retains the raided card's active or resting state")) {
    return "raid-retains-active-rest-state";
  }
  if (text.includes("only the top card of the raided character") || text.includes("card underneath") && text.includes("sideline")) {
    return "raid-stack-zone-transition";
  }
  if (text.includes("top raided card") || text.includes("top card of a raided")) return "raid-stack-top-card";
  if (text.includes('"raided" refers to') || text.includes('"raided card" refers to')) return "raided-state-definition";
  if (text.includes("does not lose abilities gained from other cards")
    || text.includes("abilities printed on that card")
    || text.includes("triggers are not lost")) {
    return "printed-vs-gained-abilities";
  }
  if ((text.includes("only activate one copy") || text.includes("only activate one of them"))
    && (text.includes("two") || text.includes("multiple") || text.includes("copy"))) {
    return "shared-once-per-turn";
  }
  if (text.includes("neither abilities activate because the cards are not sidelined or played")
    || text.includes("it was not played, so it does not activate")
    || text.includes("does not activate because it is no longer on your front line")) {
    return "zone-transition-trigger-timing";
  }
  if (text.includes("becomes private") || text.includes("remain public") || text.includes("goes back to being face down")) {
    return "revealed-card-privacy";
  }
  if (cardCode === "BLC-1-065" || (text.includes("same character twice") && text.includes("separate characters"))) return "independent-repeat-targets";
  if (text.includes("choose two") || text.includes("same ability twice")) return "multi-choice-distinct-order";
  if (text.includes("color trigger") && (text.includes("instead") || text.includes("in place of"))) return "replacement-color-trigger";
  if (text.includes("cannot be blocked")) return "block-restriction-once-per-turn";
  if (text.includes("when sidelined") || text.includes("when played")) return "trigger-non-activation";
  return cardCode ? "card-specific-effect" : "general";
}

function classifyStatus({ card, topic, cardEffectKinds }) {
  if (!card) return "missing-card-data";
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
  const regressionTopics = new Set([
    "battle-win-definition",
    "front-line-energy-generation",
    "life-move-no-trigger-check",
    "life-zero-state-action",
    "line-capacity-overflow",
    "mandatory-block-choice",
    "partial-if-do-payment",
    "post-battle-trigger-timing",
    "printed-ap-cost",
    "printed-bp-value",
    "printed-vs-gained-abilities",
    "raid-resets-applied-effects",
    "raid-retains-active-rest-state",
    "raid-stack-top-card",
    "raid-stack-zone-transition",
    "raided-state-definition",
    "ready-lock-single-consumption",
    "shared-once-per-turn",
    "targeting-choose-protection",
    "trigger-non-activation",
    "when-blocking-timing",
    "zone-transition-trigger-timing"
  ]);
  if (regressionTopics.has(topic)) return "covered-by-regression";
  if (topic === "face-down-under-visibility" || topic === "revealed-card-privacy") {
    return "information-rule-reviewed";
  }
  return cardEffectKinds.has("unsupported") ? "needs-manual-review" : "encoded-card-specific";
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
    case "partial-if-do-payment":
      return "Move every available card required by the instruction, but resolve the following payoff only when the full printed quantity moved.";
    case "line-capacity-overflow":
      return "Make room in a full destination line before moving or playing, and repeatedly enforce a reduced line capacity as a state action.";
    case "ready-lock-single-consumption":
      return "The next attempt to switch the affected card to active is replaced once, including phase-based readying, then the lock is consumed.";
    case "raid-resets-applied-effects":
      return "Performing Raid clears effects applied to the base permanent while preserving separately gained effects on the new Raid card as the ruling requires.";
    case "raid-retains-active-rest-state":
      return "A Raid stack retains the base permanent's active or resting state unless Raid or another effect switches it.";
    case "raid-stack-zone-transition":
      return "When only the top Raid card changes zones, underlying cards follow the FAQ destination rule and do not incorrectly trigger as played or sidelined.";
    case "life-zero-state-action":
      return "A player loses after the resolving effect leaves them with zero life, not midway through that effect.";
    case "targeting-choose-protection":
      return "Only instructions that choose a target are affected by choose protection or additional targeting costs, and choosing zero remains legal when printed.";
    case "mandatory-block-choice":
      return "A legal mandatory blocker must block; its controller chooses among multiple legal mandatory blockers.";
    case "life-move-no-trigger-check":
      return "Moving a life card by an effect without a trigger check does not reveal or activate that card's trigger.";
    case "front-line-energy-generation":
      return "Front-line cards generate energy only when card text explicitly allows them to override the normal line rule.";
    case "printed-bp-value":
      return "Printed BP checks use the value printed on the card rather than the permanent's modified current BP.";
    case "printed-ap-cost":
      return "Printed AP-cost checks use the card's printed AP cost rather than temporary use-cost modifiers.";
    case "face-down-under-visibility":
      return "A player may inspect and reorder their own face-down under-cards but receives no identity information for an opponent's face-down under-cards.";
    case "revealed-card-privacy":
      return "A revealed card becomes hidden again when an effect returns it to a private zone unless the effect says otherwise.";
    case "battle-win-definition":
      return "A battle is won when the attacker battles a character and its BP is at least the opposing character's BP; direct damage is not a battle win.";
    case "post-battle-trigger-timing":
      return "Post-attack abilities wait until battle or the life trigger check has fully resolved.";
    case "when-blocking-timing":
      return "When Blocking abilities activate after the blocking decision at the blocking-character declaration timing.";
    case "shared-once-per-turn":
      return "Where the printed name scopes an ability across copies, only one copy may activate it during that turn.";
    case "printed-vs-gained-abilities":
      return "Effects that remove printed abilities do not remove separately gained abilities or triggers unless the wording explicitly includes them.";
    case "zone-transition-trigger-timing":
      return "Cards moved between zones without being played or sidelined do not fire unrelated When Played or When Sidelined abilities.";
    default:
      return topic === "card-specific-effect"
        ? "The referenced card exists in the catalog and its structured effects contain no unsupported node; this individual ruling is retained for card-level review."
        : "No executable expectation classified yet.";
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
