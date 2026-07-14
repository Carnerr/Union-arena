#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  actionModelPathForKey,
  baselinePolicyPathForKey,
  matchupOverlayPathForKeys,
  policyKeySegment
} from "../src/policy-router.js";

const agentRoot = option("--agent-root") ?? "work/private/pilot-agent";
const policyDir = option("--policy-dir") ?? join(agentRoot, "policies");
const baselineRoot = option("--baseline-root") ?? join(agentRoot, "baselines");
const overwrite = hasFlag("--overwrite");

if (hasFlag("--help")) {
  usage();
  process.exit(0);
}

const copied = [];
const skipped = [];
const missing = [];

migratePolicyBaselines();
migrateActionModels();
migrateMatchupOverlays();

const manifest = {
  schema: "union-arena-local-engine/pilot-baseline-migration@1",
  createdAt: new Date().toISOString(),
  agentRoot,
  policyDir,
  baselineRoot,
  overwrite,
  copied,
  skipped,
  missing
};
mkdirSync(baselineRoot, { recursive: true });
const manifestPath = join(baselineRoot, `migration-${timestamp()}.json`);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Pilot baseline migration complete.`);
console.log(`Copied: ${copied.length}; skipped: ${skipped.length}; missing: ${missing.length}`);
console.log(`Manifest: ${manifestPath}`);

function migratePolicyBaselines() {
  if (!existsSync(policyDir)) {
    missing.push({ kind: "legacy policy dir", path: policyDir });
    return;
  }
  for (const entry of readdirSync(policyDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const ownKey = policyKeySegment(entry.name.replace(/\.json$/u, ""));
    copyArtifact({
      kind: "baseline policy",
      from: join(policyDir, entry.name),
      to: baselinePolicyPathForKey(ownKey, { policyDir, baselineRoot })
    });
  }
}

function migrateActionModels() {
  const legacyDir = join(agentRoot, "action-models");
  if (!existsSync(legacyDir)) {
    missing.push({ kind: "legacy action-model dir", path: legacyDir });
    return;
  }
  for (const entry of readdirSync(legacyDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const ownKey = policyKeySegment(entry.name.replace(/\.json$/u, ""));
    copyArtifact({
      kind: "action model",
      from: join(legacyDir, entry.name),
      to: actionModelPathForKey(ownKey, { agentRoot, baselineRoot })
    });
  }
}

function migrateMatchupOverlays() {
  const legacyDir = join(policyDir, "matchups");
  if (!existsSync(legacyDir)) {
    missing.push({ kind: "legacy matchup dir", path: legacyDir });
    return;
  }
  for (const entry of readdirSync(legacyDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const source = join(legacyDir, entry.name);
    const parsed = matchupKeysFromOverlay(source, entry.name);
    if (!parsed) {
      skipped.push({ kind: "matchup overlay", from: source, reason: "could not infer own/opponent keys" });
      continue;
    }
    copyArtifact({
      kind: "matchup overlay",
      from: source,
      to: matchupOverlayPathForKeys(parsed.ownKey, parsed.opponentKey, { policyDir, baselineRoot })
    });
  }
}

function matchupKeysFromOverlay(path, fileName) {
  try {
    const overlay = JSON.parse(readFileSync(path, "utf8"));
    if (overlay?.ownKey && overlay?.opponentKey) {
      return {
        ownKey: policyKeySegment(overlay.ownKey),
        opponentKey: String(overlay.opponentKey)
      };
    }
  } catch {
    // Filename fallback below.
  }
  const match = fileName.match(/^(.+)-vs-(.+)\.json$/u);
  if (!match) return null;
  return {
    ownKey: policyKeySegment(match[1]),
    opponentKey: match[2]
  };
}

function copyArtifact({ kind, from, to }) {
  if (!existsSync(from)) {
    missing.push({ kind, path: from });
    return;
  }
  if (existsSync(to) && !overwrite) {
    skipped.push({ kind, from, to, reason: "target exists" });
    return;
  }
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  copied.push({
    kind,
    from,
    to,
    bytes: statSync(to).size
  });
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
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
  node tools/migrate-pilot-baselines.mjs

Copies legacy pilot artifacts into the organized baseline layout:
  work/private/pilot-agent/baselines/decks/<set-color>/baseline-policy.json
  work/private/pilot-agent/baselines/decks/<set-color>/action-model.json
  work/private/pilot-agent/baselines/decks/<set-color>/matchups/<opponent>.json

The migration is non-destructive by default. Add --overwrite to refresh existing targets.`);
}
