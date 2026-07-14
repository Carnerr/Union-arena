#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const libraryDir = option("--library") ?? "work/private/decks";
const outDir = option("--out-dir") ?? "work/private/deck-archetypes";
const threshold = Number(option("--threshold") ?? 10);
const deckPrefix = option("--deck-prefix") ?? "regional-";
const reportName = option("--report-name") ?? "regional-archetype-candidates";
const includeSingletonBuckets = !hasFlag("--hide-singleton-buckets");

if (hasFlag("--help")) {
  usage();
  process.exit(0);
}

if (!Number.isFinite(threshold) || threshold <= 0) {
  throw new Error("--threshold must be a positive number.");
}

const decks = loadDecks();
const buckets = groupBy(decks, (deck) => deck.ownKey);
const analyzedBuckets = [...buckets.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([ownKey, rows]) => analyzeBucket(ownKey, rows))
  .filter((bucket) => includeSingletonBuckets || bucket.categories.length > 1);

const report = {
  schema: "union-arena-local-engine/regional-archetype-candidates@1",
  generatedAt: new Date().toISOString(),
  libraryDir,
  deckPrefix,
  threshold,
  distanceDefinition: "cardSlotsDifferent = sum(abs(copyCountA - copyCountB)) / 2; decks can share a category only when every pair in that category differs by fewer than threshold card slots.",
  totalDecks: decks.length,
  bucketCount: analyzedBuckets.length,
  buckets: analyzedBuckets
};

mkdirSync(outDir, { recursive: true });
const jsonPath = join(outDir, `${reportName}.json`);
const markdownPath = join(outDir, `${reportName}.md`);
const namingCsvPath = join(outDir, `${reportName}-naming.csv`);
writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(markdownPath, markdownReport(report));
writeFileSync(namingCsvPath, namingCsv(report));

console.log(`Analyzed ${decks.length} regional decks across ${analyzedBuckets.length} set/color buckets.`);
console.log(`Wrote ${jsonPath}`);
console.log(`Wrote ${markdownPath}`);
console.log(`Wrote ${namingCsvPath}`);
console.table(analyzedBuckets.map((bucket) => ({
  ownKey: bucket.ownKey,
  decks: bucket.deckCount,
  categories: bucket.categories.length,
  sizes: bucket.categories.map((category) => category.deckCount).join("/")
})));

function loadDecks() {
  if (!existsSync(libraryDir)) return [];
  return readdirSync(libraryDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      const path = join(libraryDir, entry.name);
      const raw = JSON.parse(readFileSync(path, "utf8"));
      const id = raw.id ?? entry.name.replace(/\.json$/u, "");
      if (!id.startsWith(deckPrefix) || !Array.isArray(raw.cards)) return null;
      const ownKey = deckOwnKey(raw);
      if (!ownKey) return null;
      const counts = cardCounts(raw.cards);
      const totalCards = [...counts.values()].reduce((total, count) => total + count, 0);
      return {
        id,
        fileName: entry.name,
        name: raw.name ?? id,
        path,
        ownKey,
        sourceCode: raw.validation?.sourceCode ?? raw.summary?.sourceCode ?? raw.summary?.sourceCodes?.[0] ?? null,
        colors: deckColors(raw),
        source: raw.source ?? {},
        cards: raw.cards,
        counts,
        cardInfo: cardInfo(raw.cards),
        totalCards
      };
    })
    .filter(Boolean)
    .sort(compareDecks);
}

function analyzeBucket(ownKey, rows) {
  const decks = [...rows].sort(compareDecks);
  const categories = [];
  for (const deck of decks) {
    const candidates = categories
      .filter((category) => category.members.every((member) => distance(deck, member) < threshold))
      .map((category) => ({
        category,
        averageDistance: average(category.members.map((member) => distance(deck, member)))
      }))
      .sort((a, b) => a.averageDistance - b.averageDistance
        || compareDecks(a.category.representative, b.category.representative));
    if (candidates.length > 0) {
      candidates[0].category.members.push(deck);
      candidates[0].category.members.sort(compareDecks);
      candidates[0].category.representative = candidates[0].category.members[0];
    } else {
      categories.push({
        members: [deck],
        representative: deck
      });
    }
  }

  categories.sort((a, b) => compareDecks(a.representative, b.representative)
    || b.members.length - a.members.length);

  const finalized = categories.map((category, index) => finalizeCategory({
    ownKey,
    category,
    categoryIndex: index + 1,
    allCategories: categories
  }));

  return {
    ownKey,
    sourceCode: decks[0]?.sourceCode ?? null,
    colors: decks[0]?.colors ?? [],
    deckCount: decks.length,
    categoryCount: finalized.length,
    threshold,
    categories: finalized
  };
}

function finalizeCategory({ ownKey, category, categoryIndex, allCategories }) {
  const members = category.members;
  const pairwise = pairwiseDistances(members);
  const otherCategories = allCategories.filter((other) => other !== category);
  const externalDistances = [];
  for (const member of members) {
    for (const other of otherCategories.flatMap((other) => other.members)) {
      externalDistances.push(distance(member, other));
    }
  }
  const id = `${ownKey}-candidate-${categoryIndex}`;
  const nearestExternal = nearestExternalCategory({
    ownKey,
    category,
    allCategories,
    categoryIndex
  });
  const sourceTypes = countValues(members.map((deck) => deck.source.deckType).filter(Boolean));
  return {
    id,
    ownKey,
    label: `${ownKey} Candidate ${categoryIndex}`,
    deckCount: members.length,
    representative: deckSummary(category.representative),
    reportedTypes: sourceTypes,
    placements: members
      .map((deck) => numericPlacement(deck))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b),
    locations: [...new Set(members.map((deck) => deck.source.location).filter(Boolean))].sort(),
    distanceStats: {
      maxWithin: pairwise.length > 0 ? Math.max(...pairwise.map((row) => row.distance)) : 0,
      minWithin: pairwise.length > 0 ? Math.min(...pairwise.map((row) => row.distance)) : 0,
      averageWithin: round(pairwise.length > 0 ? average(pairwise.map((row) => row.distance)) : 0),
      nearestOther: externalDistances.length > 0 ? Math.min(...externalDistances) : null,
      nearestOtherCategory: nearestExternal?.id ?? null,
      averageToOther: externalDistances.length > 0 ? round(average(externalDistances)) : null
    },
    reviewFlags: reviewFlags({ threshold, nearestExternal }),
    sharedCore: sharedCoreCards(members).slice(0, 16),
    signatureCards: signatureCards(members, otherCategories.flatMap((other) => other.members)).slice(0, 16),
    decks: members.map(deckSummary),
    pairwiseDistances: pairwise
  };
}

function nearestExternalCategory({ ownKey, category, allCategories, categoryIndex }) {
  const rows = [];
  for (let index = 0; index < allCategories.length; index += 1) {
    const other = allCategories[index];
    if (other === category) continue;
    const distances = [];
    for (const member of category.members) {
      for (const otherMember of other.members) {
        distances.push(distance(member, otherMember));
      }
    }
    if (distances.length === 0) continue;
    rows.push({
      id: `${ownKey}-candidate-${index + 1}`,
      minDistance: Math.min(...distances),
      averageDistance: round(average(distances)),
      note: index + 1 < categoryIndex ? "earlier category" : "later category"
    });
  }
  return rows.sort((a, b) => a.minDistance - b.minDistance
    || a.averageDistance - b.averageDistance
    || a.id.localeCompare(b.id))[0] ?? null;
}

function reviewFlags({ threshold, nearestExternal }) {
  if (!nearestExternal) return [];
  if (nearestExternal.minDistance >= threshold) return [];
  return [
    `Borderline split: nearest deck in ${nearestExternal.id} is ${nearestExternal.minDistance} card slot(s) away, but merging would violate the pairwise <${threshold} rule.`
  ];
}

function deckSummary(deck) {
  return {
    id: deck.id,
    name: deck.name,
    player: deck.source.player ?? null,
    placement: deck.source.placement ?? null,
    location: deck.source.location ?? null,
    eventDate: deck.source.eventDate ?? null,
    deckType: deck.source.deckType ?? null,
    deckListUrl: deck.source.deckListUrl ?? null,
    mainCards: topCardsFromCounts(deck.counts, deck.cardInfo, 18)
  };
}

function sharedCoreCards(members) {
  if (members.length === 0) return [];
  const keys = new Set(members.flatMap((deck) => [...deck.counts.keys()]));
  return [...keys]
    .map((key) => {
      const counts = members.map((deck) => Number(deck.counts.get(key) ?? 0));
      const minCount = Math.min(...counts);
      const maxCount = Math.max(...counts);
      if (minCount <= 0) return null;
      return {
        card: cardLabel(key, members[0].cardInfo),
        minCount,
        maxCount,
        averageCount: round(average(counts))
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.minCount - a.minCount
      || b.averageCount - a.averageCount
      || a.card.localeCompare(b.card));
}

function signatureCards(members, others) {
  const memberAggregate = aggregateCounts(members);
  const otherAggregate = aggregateCounts(others);
  const info = mergeCardInfo([...members, ...others]);
  const keys = new Set([...memberAggregate.keys(), ...otherAggregate.keys()]);
  return [...keys]
    .map((key) => {
      const averageCount = Number(memberAggregate.get(key) ?? 0);
      const otherAverage = Number(otherAggregate.get(key) ?? 0);
      const delta = averageCount - otherAverage;
      if (averageCount <= 0 || delta < 1.5) return null;
      return {
        card: cardLabel(key, info),
        averageCount: round(averageCount),
        otherAverage: round(otherAverage),
        delta: round(delta)
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.delta - a.delta
      || b.averageCount - a.averageCount
      || a.card.localeCompare(b.card));
}

function pairwiseDistances(members) {
  const rows = [];
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      rows.push({
        left: members[i].id,
        right: members[j].id,
        distance: distance(members[i], members[j])
      });
    }
  }
  return rows.sort((a, b) => b.distance - a.distance || a.left.localeCompare(b.left));
}

function distance(left, right) {
  const keys = new Set([...left.counts.keys(), ...right.counts.keys()]);
  let total = 0;
  for (const key of keys) {
    total += Math.abs(Number(left.counts.get(key) ?? 0) - Number(right.counts.get(key) ?? 0));
  }
  return total / 2;
}

function cardCounts(cards) {
  const counts = new Map();
  for (const card of cards) {
    const key = cardKey(card);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + Number(card.count ?? 1));
  }
  return counts;
}

function cardInfo(cards) {
  const info = new Map();
  for (const card of cards) {
    const key = cardKey(card);
    if (!key || info.has(key)) continue;
    info.set(key, {
      number: localCardNumber(card.number ?? card.id),
      name: card.name ?? ""
    });
  }
  return info;
}

function mergeCardInfo(decks) {
  const info = new Map();
  for (const deck of decks) {
    for (const [key, value] of deck.cardInfo.entries()) {
      if (!info.has(key)) info.set(key, value);
    }
  }
  return info;
}

function aggregateCounts(members) {
  const aggregate = new Map();
  if (members.length === 0) return aggregate;
  for (const deck of members) {
    for (const [key, count] of deck.counts.entries()) {
      aggregate.set(key, (aggregate.get(key) ?? 0) + Number(count));
    }
  }
  for (const [key, count] of aggregate.entries()) {
    aggregate.set(key, count / members.length);
  }
  return aggregate;
}

function topCardsFromCounts(counts, info, limit) {
  return [...counts.entries()]
    .map(([key, count]) => ({
      card: cardLabel(key, info),
      count
    }))
    .sort((a, b) => b.count - a.count || a.card.localeCompare(b.card))
    .slice(0, limit);
}

function cardLabel(key, info) {
  const row = info.get(key);
  if (!row) return key;
  return row.name ? `${row.number} ${row.name}` : row.number;
}

function cardKey(card) {
  return localCardNumber(card.number ?? card.id).toUpperCase();
}

function localCardNumber(cardNumber) {
  const text = String(cardNumber ?? "");
  return text.includes("/")
    ? text.split("/").at(-1)
    : text.includes("_")
      ? text.split("_").at(-1)
      : text;
}

function deckOwnKey(raw) {
  const sourceCode = raw.validation?.sourceCode ?? raw.summary?.sourceCode ?? raw.summary?.sourceCodes?.[0] ?? "unknown";
  const color = deckColors(raw)[0] ?? "multi";
  return `${policyKeySegment(sourceCode)}-${policyKeySegment(color)}`;
}

function deckColors(raw) {
  return [
    ...new Set([
      ...(Array.isArray(raw.summary?.colors) ? raw.summary.colors : []),
      raw.summary?.color
    ].filter(Boolean).map((color) => String(color).toLowerCase()))
  ];
}

function compareDecks(a, b) {
  return placementRank(a) - placementRank(b)
    || String(b.source?.eventDate ?? "").localeCompare(String(a.source?.eventDate ?? ""))
    || String(a.name ?? a.id).localeCompare(String(b.name ?? b.id))
    || String(a.id).localeCompare(String(b.id));
}

function placementRank(deck) {
  const placement = numericPlacement(deck);
  return Number.isFinite(placement) ? placement : 9999;
}

function numericPlacement(deck) {
  const value = Number(deck?.source?.placement);
  return Number.isFinite(value) ? value : NaN;
}

function countValues(values) {
  return Object.fromEntries([...groupBy(values, (value) => value).entries()]
    .map(([value, group]) => [value, group.length])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function average(values) {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + Number(value), 0) / values.length;
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}

function policyKeySegment(value) {
  return String(value ?? "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

function markdownReport(data) {
  const lines = [
    "# Regional Archetype Candidate Categories",
    "",
    `Generated: ${data.generatedAt}`,
    "",
    `Threshold: ${data.threshold} card slots. Two lists can share a category only if every pair in that category differs by fewer than ${data.threshold} card slots.`,
    "",
    "Distance formula: `sum(abs(copyCountA - copyCountB)) / 2`.",
    "",
    "## Summary",
    "",
    "| Set/Color | Regional Lists | Candidate Categories | Category Sizes |",
    "| --- | ---: | ---: | --- |",
    ...data.buckets.map((bucket) => `| ${bucket.ownKey} | ${bucket.deckCount} | ${bucket.categories.length} | ${bucket.categories.map((category) => category.deckCount).join(", ")} |`),
    ""
  ];

  for (const bucket of data.buckets) {
    lines.push(`## ${bucket.ownKey}`, "");
    lines.push(`${bucket.deckCount} regional list(s), ${bucket.categories.length} candidate categor${bucket.categories.length === 1 ? "y" : "ies"}.`, "");
    for (const category of bucket.categories) {
      const representative = category.representative;
      lines.push(`### ${category.label}`, "");
      lines.push(`Representative: ${representative.name} (${representative.placement ? `#${representative.placement}, ` : ""}${representative.location ?? "unknown location"})`);
      lines.push(`Distance: max within ${category.distanceStats.maxWithin}, nearest other ${category.distanceStats.nearestOther ?? "n/a"}${category.distanceStats.nearestOtherCategory ? ` (${category.distanceStats.nearestOtherCategory})` : ""}.`);
      for (const flag of category.reviewFlags ?? []) {
        lines.push(`Review: ${flag}`);
      }
      if (Object.keys(category.reportedTypes).length > 0) {
        lines.push(`Reported type(s): ${Object.entries(category.reportedTypes).map(([type, count]) => `${type} (${count})`).join(", ")}`);
      }
      lines.push("");
      lines.push("Decks:");
      for (const deck of category.decks) {
        const placement = deck.placement ? `#${deck.placement}` : "no placement";
        const location = deck.location ?? "unknown location";
        const type = deck.deckType ? `, ${deck.deckType}` : "";
        lines.push(`- ${deck.name} (${placement}, ${location}${type})`);
      }
      lines.push("");
      if (category.signatureCards.length > 0) {
        lines.push("Signature cards versus other categories in this set/color:");
        for (const card of category.signatureCards.slice(0, 10)) {
          lines.push(`- ${card.averageCount}x ${card.card} (other avg ${card.otherAverage}x)`);
        }
        lines.push("");
      }
      if (category.sharedCore.length > 0) {
        lines.push("Shared core cards:");
        for (const card of category.sharedCore.slice(0, 10)) {
          const countText = card.minCount === card.maxCount
            ? `${card.minCount}x`
            : `${card.minCount}-${card.maxCount}x`;
          lines.push(`- ${countText} ${card.card}`);
        }
        lines.push("");
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

function namingCsv(data) {
  const rows = [[
    "ownKey",
    "candidateId",
    "suggestedName",
    "deckCount",
    "representative",
    "reportedTypes",
    "nearestOther",
    "reviewFlags",
    "deckIds"
  ]];
  for (const bucket of data.buckets) {
    for (const category of bucket.categories) {
      rows.push([
        bucket.ownKey,
        category.id,
        "",
        String(category.deckCount),
        category.representative.name,
        Object.entries(category.reportedTypes ?? {}).map(([type, count]) => `${type} (${count})`).join("; "),
        category.distanceStats.nearestOtherCategory
          ? `${category.distanceStats.nearestOther} to ${category.distanceStats.nearestOtherCategory}`
          : category.distanceStats.nearestOther ?? "",
        (category.reviewFlags ?? []).join(" "),
        category.decks.map((deck) => deck.id).join(";")
      ]);
    }
  }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/u.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function option(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function usage() {
  console.log(`Usage:
  node tools/categorize-regional-archetypes.mjs --threshold 10

Reads saved regional deck JSON files, groups them by set/color, and creates candidate
archetype buckets. A deck joins an existing bucket only when it is fewer than the
threshold number of card slots different from every deck already in that bucket.

Options:
  --library PATH       Saved deck library. Default: work/private/decks
  --out-dir PATH       Report output directory. Default: work/private/deck-archetypes
  --threshold N        Card-slot distance threshold. Default: 10
  --deck-prefix TEXT   Saved deck id prefix. Default: regional-
`);
}
