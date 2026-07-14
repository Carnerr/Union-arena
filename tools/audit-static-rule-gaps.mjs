#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { cleanUnionArenaText } from "../src/effect-text.js";

const rawIn = valueAfter("--raw-in") ?? "work/private/egman-unionarena-raw.json";
const catalogIn = valueAfter("--catalog-in") ?? "work/private/egman-unionarena-catalog.json";
const out = valueAfter("--out") ?? "work/private/audits/static-rule-gap-audit.json";

const rawCards = JSON.parse(readFileSync(rawIn, "utf8"));
const catalogPayload = JSON.parse(readFileSync(catalogIn, "utf8"));
const catalog = catalogPayload.cards ?? catalogPayload;
const checks = staticChecks();
const categoryCounts = {};
const gapCounts = {};
const cards = [];

for (const raw of rawCards) {
  if (String(raw.category).toLowerCase() === "action point") continue;
  const def = catalog[sanitizeId(raw.card_code ?? raw.id)];
  const text = normalizeText(raw.effect);
  if (!text) continue;
  const encoding = describe(def);
  const matched = checks.filter((check) => check.pattern.test(text));
  if (matched.length === 0) continue;
  const gaps = matched.filter((check) => !check.encoded(def, encoding, text));
  for (const check of matched) increment(categoryCounts, check.kind);
  for (const check of gaps) increment(gapCounts, check.kind);
  if (gaps.length > 0) {
    cards.push({
      code: raw.card_code,
      name: raw.name,
      categories: matched.map(({ kind }) => kind),
      gaps: gaps.map(({ kind }) => kind),
      text,
      encoding
    });
  }
}

const report = {
  summary: {
    auditedAt: new Date().toISOString(),
    rawIn,
    catalogIn,
    cardCount: Object.keys(catalog).length,
    categoryCounts,
    gapCounts,
    cardsWithGaps: cards.length
  },
  cards
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

console.log(`Audited ${report.summary.cardCount} cards for ${checks.length} static/replacement rule families.`);
console.log(`Cards with apparent static-rule gaps: ${cards.length}.`);
for (const [kind, count] of Object.entries(gapCounts)) console.log(`  ${kind}: ${count}`);
console.log(`Report: ${out}`);
if (cards.length > 0) process.exitCode = 1;

function staticChecks() {
  const kind = (name, pattern, encoded) => ({ kind: name, pattern, encoded });
  return [
    kind("deck-copy-limit", /deck can (?:only )?contain up to .+ copies of this card/, (d) => d?.deckCopyLimit !== undefined),
    kind("maximum-hand-size", /maximum hand size is now .+ cards/, (d) => d?.maximumHandSize !== undefined),
    kind("line-capacity", /number of cards you can place onto your (?:front|energy) line is (?:reduced|increased)/, (d) => d?.lineCapacityModifiers?.length > 0),
    kind("raid-only-play", /can only be played by performing raid with it/, (d) => d?.raidOnlyPlay),
    kind("raid-use-condition", /can only perform raid with this card if/, (d) => Boolean(d?.raidUseCondition)),
    kind("raid-target-permission", /cards? with \[raid\] can perform raid on this character/, (d, e) => d?.raidTargetPermissions?.length > 0 || e.effectKinds.has("grantKeyword")),
    kind("front-entry-restriction", /cannot be played onto or moved to your front line/, (d) => d?.cannotEnterFrontLine || Boolean(d?.frontLineEntryCondition)),
    kind("energy-entry-restriction", /cannot be played onto or moved to your energy line/, (d) => d?.cannotEnterEnergyLine),
    kind("play-line-restriction", /cannot be played onto your (?:front|energy) line/, (d) => d?.cannotPlayToFrontLine || d?.cannotPlayToEnergyLine || d?.cannotEnterFrontLine || d?.cannotEnterEnergyLine),
    kind("movement-phase-restriction", /cannot .{0,45}move during your move(?:ment)? phase|can only be moved to your front line using its ability/, (d) => d?.cannotMoveDuringMovementPhase || d?.frontLineMoveByOwnAbilityOnly),
    kind("must-attack", /must attack if able/, (d, e) => d?.keywords?.mustAttack || e.staticKeywordNames.has("mustAttack")),
    kind("must-block", /must block .+ attacks if able/, (d, e) => d?.keywords?.mustBlockAttacks
      || e.effectKinds.has("grantMandatoryBlockLink")
      || ["mustBlock", "mustBlockFirstAttack", "mustBlockAttacks"].some((keyword) => e.staticKeywordNames.has(keyword) || e.effectKeywords.has(keyword))),
    kind("cannot-attack", /this character cannot attack(?: or block)?(?:[.]|$)/, (d, e) => d?.keywords?.cantAttack || e.staticKeywordNames.has("cantAttack") || e.effectKeywords.has("cantAttack")),
    kind("cannot-block", /this character cannot (?:attack or )?block(?:[.]|$)/, (d, e) => d?.keywords?.cantBlock || e.staticKeywordNames.has("cantBlock") || e.effectKeywords.has("cantBlock")),
    kind("cannot-move", /this character cannot move(?:[.]|$)/, (d, e) => d?.keywords?.cannotMove || e.staticKeywordNames.has("cannotMove") || e.effectKeywords.has("cannotMove")),
    kind("unblockable-bp", /cannot be blocked by a character with \d+ or (?:less|more) bp/, (d, e) => hasKeywordPrefix(d, e, "cantBeBlockedByBp")),
    kind("unblockable-energy", /cannot be blocked by a character with \d+ or more required energy/, (d, e) => hasKeyword(d, e, "cantBeBlockedByRequiredEnergyMin")),
    kind("unblockable-raided", /cannot be blocked by a raided character/, (d, e) => hasKeyword(d, e, "cantBeBlockedByRaided")),
    kind("block-attacker-limit", /cannot block characters? with \d+ or less bp/, (d, e) => hasKeyword(d, e, "cantBlockAttackerBpMax")),
    kind("snipe-target-limit", /cannot target characters? with \d+ or more bp using \[snipe\]/, (d, e) => hasKeyword(d, e, "snipeCannotTargetBpMin")),
    kind("draw-trigger-suppression", /cannot activate \[draw trigger\].+damage dealt by this character/, (d, e) => hasKeyword(d, e, "suppressDrawTriggersOnDamage")),
    kind("active-trigger-suppression", /cannot activate \[active trigger\].+damage dealt by this character/, (d, e) => hasKeyword(d, e, "suppressActiveTriggersOnDamage")),
    kind("ability-action-protection", /cannot be (?:sidelined|switched to resting|moved|returned to your hand)|not affected by bp-reducing abilities/, (d, e) => d?.abilityProtections?.length > 0
      || hasKeyword(d, e, "abilityProtection")
      || hasKeyword(d, e, "bpReductionProtection")
      || d?.abilityReturnToHandProtection),
    kind("targeting-protection", /cannot choose this (?:character|site)|cannot be chosen by your opponent's/, (d, e) => d?.targetingRestrictions?.length > 0
      || hasKeyword(d, e, "opponentAbilityProtection")
      || hasKeyword(d, e, "targetingRestriction")),
    kind("raid-stack-return", /return this raided character and its base card to your hand instead/, (d) => d?.returnRaidStackToHandOnReturn),
    kind("sideline-top-raid-instead", /place this top raided card into your sideline instead/, (d) => d?.sidelineTopRaidCardInstead),
    kind("battle-loser-removal", /lose to this character in battle are placed into their removal area instead/, (d) => d?.battleLosersToRemovalInstead),
    kind("battle-loser-energy", /lose to this character in battle move to their energy line instead/, (d) => d?.battleLosersToEnergyInstead),
    kind("alternate-card-name", /this card is also treated as (?:<[^>]+>)(?:\s*(?:,|and)\s*<[^>]+>)*/, (d) => d?.alternateNames?.length > 0),
    kind("free-extra-draw", /perform an extra draw without paying ap/, (d) => d?.freeExtraDrawFromFrontLine),
    kind("self-trigger-alternative", /change it to a \[draw trigger\] or \[active trigger\]/, (d) => d?.selfTriggerAlternatives?.length === 2),
    kind("named-leave-replacement", /if an? <[^>]+> leaves your field due to one of your opponent's abilities, .+sideline this active character instead/, (d) => Boolean(d?.opponentAbilityLeaveReplacement)),
    kind("bp-increase-trigger", /when this character's bp is increased, it gains \d+ bp/, (d) => d?.abilities?.some((ability) => ability.timing === "whenBpIncreased")),
    kind("front-line-energy", /generates energy even (?:if it is )?on the front line/, (d, e) => hasKeyword(d, e, "frontLineEnergyGeneration")),
    kind("conditional-static-keyword", /if [^.]+, (?:this character|it) (?:also )?gains \[(?:damage|impact|snipe|step|double attack|double block|nullify impact)/, (d, e) => d?.staticKeywordModifiers?.length > 0
      || ["damage", "damagePlus", "impact", "impactPlus", "snipe", "step", "doubleAttack", "doubleBlock", "nullifyImpact"].some((keyword) => e.effectKeywords.has(keyword))),
    kind("conditional-static-bp", /if [^.]+, (?:this character|it) (?:also )?gains \d+ bp/, (d, e) => d?.staticModifiers?.length > 0 || e.effectKinds.has("modifyBp")),
    kind("conditional-static-bp-loss", /if [^.]+, (?:this character|it) loses \d+ bp/, (d) => d?.staticModifiers?.some((modifier) => Number(modifier.bp) < 0)),
    kind("static-bp-per-base-ap", /gains \d+ bp for each character .+ with \d+ or more base ap cost/, (d) => d?.staticModifiers?.some((modifier) => modifier.amountPer?.filter?.apCostMin !== undefined)),
    kind("conditional-static-energy", /if [^.]+, (?:this character|it) gains (?:\[(?:red|blue|green|yellow|purple)\]\s*)+energy generation/, (d, e) => d?.staticEnergyModifiers?.length > 0 || e.effectKinds.has("grantEnergy")),
    kind("play-or-raid", /play .+ or perform raid with|play set to active .+ or perform raid|\{play set to active .+ perform raid with\}/, (d, e) => e.effectKinds.has("playOrRaidCardFromZone") || e.hasAllowRaid || e.hasSelectedAlternative || d?.trigger?.type === "raid"),
    kind("unique-choice-per-turn", /cannot choose the same ability again during this turn/, (d, e) => e.uniqueChoicesPerTurn),
    kind("unique-target-per-affinity", /chosen by an ability on .+ this turn cannot be chosen by this ability/, (d, e) => e.notChosenBySourceAffinityThisTurn)
  ];
}

function describe(def) {
  const effectKinds = new Set();
  const effectKeywords = new Set();
  let hasSelectedAlternative = false;
  let hasAllowRaid = false;
  let uniqueChoicesPerTurn = false;
  let notChosenBySourceAffinityThisTurn = false;
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (value.kind) effectKinds.add(value.kind);
    if (value.keyword) effectKeywords.add(value.keyword);
    if (value.selectedAlternative) hasSelectedAlternative = true;
    if (value.allowRaid) hasAllowRaid = true;
    if (value.uniqueChoicesPerTurn) uniqueChoicesPerTurn = true;
    if (value.notChosenBySourceAffinityThisTurn) notChosenBySourceAffinityThisTurn = true;
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object") visit(child);
    }
  };
  visit(def);
  return {
    effectKinds,
    effectKeywords,
    hasSelectedAlternative,
    hasAllowRaid,
    uniqueChoicesPerTurn,
    notChosenBySourceAffinityThisTurn,
    staticKeywordNames: new Set([
      ...(def?.staticKeywordModifiers ?? []).map((item) => item.keyword),
      ...(def?.staticFieldKeywordModifiers ?? []).map((item) => item.keyword)
    ])
  };
}

function hasKeyword(def, encoding, keyword) {
  return Boolean(def?.keywords?.[keyword])
    || encoding.staticKeywordNames.has(keyword)
    || encoding.effectKeywords.has(keyword);
}

function hasKeywordPrefix(def, encoding, prefix) {
  return Object.keys(def?.keywords ?? {}).some((name) => name.startsWith(prefix))
    || [...encoding.staticKeywordNames, ...encoding.effectKeywords].some((name) => name.startsWith(prefix));
}

function normalizeText(value) {
  return cleanUnionArenaText(value).replace(/\s+/g, " ").trim().toLowerCase();
}

function sanitizeId(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function increment(record, key) {
  record[key] = (record[key] ?? 0) + 1;
}
