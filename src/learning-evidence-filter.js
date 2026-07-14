import { createHash } from "node:crypto";

export const LEARNING_EVIDENCE_FILTER_VERSION = 1;

const DEFAULT_INITIAL_CAPACITY = 4096;
const DEFAULT_FALSE_POSITIVE_RATE = 1e-7;
const MAX_HASH_COUNT = 28;

export function createLearningEvidenceFilter(artifact = null, {
  initialCapacity = DEFAULT_INITIAL_CAPACITY,
  falsePositiveRate = DEFAULT_FALSE_POSITIVE_RATE
} = {}) {
  const normalizedCapacity = Math.max(128, Math.floor(Number(initialCapacity ?? DEFAULT_INITIAL_CAPACITY)));
  const normalizedRate = clamp(Number(falsePositiveRate ?? DEFAULT_FALSE_POSITIVE_RATE), 1e-12, 0.01);
  if (Number(artifact?.version ?? 0) !== LEARNING_EVIDENCE_FILTER_VERSION) {
    return {
      version: LEARNING_EVIDENCE_FILTER_VERSION,
      initialCapacity: normalizedCapacity,
      falsePositiveRate: normalizedRate,
      levels: []
    };
  }
  return {
    version: LEARNING_EVIDENCE_FILTER_VERSION,
    initialCapacity: Math.max(128, Math.floor(Number(artifact.initialCapacity ?? normalizedCapacity))),
    falsePositiveRate: clamp(Number(artifact.falsePositiveRate ?? normalizedRate), 1e-12, 0.01),
    levels: (artifact.levels ?? []).map(loadLevel).filter(Boolean)
  };
}

export function learningEvidenceFilterHas(filter, fingerprint) {
  const hashes = fingerprintHashes(fingerprint);
  return filter.levels.some((level) => levelHas(level, hashes));
}

export function learningEvidenceFilterAdd(filter, fingerprint) {
  const hashes = fingerprintHashes(fingerprint);
  if (filter.levels.some((level) => levelHas(level, hashes))) return false;
  let level = filter.levels.at(-1);
  if (!level || level.inserted >= level.capacity) {
    level = createLevel(filter, filter.levels.length);
    filter.levels.push(level);
  }
  setLevelBits(level, hashes);
  level.inserted += 1;
  return true;
}

export function serializeLearningEvidenceFilter(filter) {
  return {
    version: LEARNING_EVIDENCE_FILTER_VERSION,
    algorithm: "scalable-bloom-double-hash",
    initialCapacity: filter.initialCapacity,
    falsePositiveRate: filter.falsePositiveRate,
    levels: filter.levels.map((level) => ({
      capacity: level.capacity,
      inserted: level.inserted,
      bitCount: level.bitCount,
      hashCount: level.hashCount,
      targetFalsePositiveRate: level.targetFalsePositiveRate,
      bits: level.bits.toString("base64")
    }))
  };
}

export function learningEvidenceFilterStats(filter) {
  const levels = filter.levels.map((level) => ({
    capacity: level.capacity,
    inserted: level.inserted,
    bitCount: level.bitCount,
    hashCount: level.hashCount,
    bytes: level.bits.length,
    estimatedFalsePositiveRate: estimatedFalsePositiveRate(level)
  }));
  return {
    version: LEARNING_EVIDENCE_FILTER_VERSION,
    levels: levels.length,
    inserted: levels.reduce((total, level) => total + level.inserted, 0),
    capacity: levels.reduce((total, level) => total + level.capacity, 0),
    bytes: levels.reduce((total, level) => total + level.bytes, 0),
    estimatedFalsePositiveRate: levels.reduce((total, level) => total + level.estimatedFalsePositiveRate, 0),
    levelDetails: levels
  };
}

function createLevel(filter, index) {
  const capacity = filter.initialCapacity * (2 ** index);
  const targetFalsePositiveRate = filter.falsePositiveRate / (2 ** (index + 1));
  const rawBitCount = Math.ceil((-capacity * Math.log(targetFalsePositiveRate)) / (Math.log(2) ** 2));
  const bitCount = Math.max(8, Math.ceil(rawBitCount / 8) * 8);
  const hashCount = Math.max(1, Math.min(MAX_HASH_COUNT, Math.round((bitCount / capacity) * Math.log(2))));
  return {
    capacity,
    inserted: 0,
    bitCount,
    hashCount,
    targetFalsePositiveRate,
    bits: Buffer.alloc(bitCount / 8)
  };
}

function loadLevel(level) {
  const capacity = Math.max(1, Math.floor(Number(level?.capacity ?? 0)));
  const inserted = Math.max(0, Math.floor(Number(level?.inserted ?? 0)));
  const bitCount = Math.max(8, Math.floor(Number(level?.bitCount ?? 0) / 8) * 8);
  const hashCount = Math.max(1, Math.min(MAX_HASH_COUNT, Math.floor(Number(level?.hashCount ?? 0))));
  const bits = Buffer.from(String(level?.bits ?? ""), "base64");
  if (!capacity || !bitCount || bits.length !== bitCount / 8) return null;
  return {
    capacity,
    inserted,
    bitCount,
    hashCount,
    targetFalsePositiveRate: clamp(Number(level?.targetFalsePositiveRate ?? 0.01), 1e-12, 0.01),
    bits
  };
}

function fingerprintHashes(fingerprint) {
  const text = String(fingerprint ?? "");
  const digest = /^[a-f0-9]{64}$/iu.test(text)
    ? Buffer.from(text, "hex")
    : createHash("sha256").update(text).digest();
  return {
    first: digest.readUInt32BE(0),
    second: (digest.readUInt32BE(4) | 1) >>> 0
  };
}

function levelHas(level, hashes) {
  for (let index = 0; index < level.hashCount; index += 1) {
    const bit = bloomBitIndex(hashes, index, level.bitCount);
    if ((level.bits[bit >>> 3] & (1 << (bit & 7))) === 0) return false;
  }
  return true;
}

function setLevelBits(level, hashes) {
  for (let index = 0; index < level.hashCount; index += 1) {
    const bit = bloomBitIndex(hashes, index, level.bitCount);
    level.bits[bit >>> 3] |= 1 << (bit & 7);
  }
}

function bloomBitIndex({ first, second }, index, bitCount) {
  return (first + index * second) % bitCount;
}

function estimatedFalsePositiveRate(level) {
  if (level.inserted <= 0) return 0;
  return (1 - Math.exp((-level.hashCount * level.inserted) / level.bitCount)) ** level.hashCount;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
