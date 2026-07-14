import { createHash, randomUUID } from "node:crypto";
import { cpSync, createReadStream, existsSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function writeTextAtomicSync(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporaryPath, text, { encoding: "utf8", flag: "wx" });
    renameSync(temporaryPath, path);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
  return path;
}

export function writeJsonAtomicSync(path, value, { pretty = true } = {}) {
  const json = JSON.stringify(value, null, pretty ? 2 : 0);
  return writeTextAtomicSync(path, `${json}\n`);
}

export function fileContentDigest(path, { algorithm = "sha256" } = {}) {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    const input = createReadStream(path);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(`${algorithm}:${hash.digest("hex")}`));
  });
}

export function restoreDirectorySnapshotSync({ source, target }) {
  if (!target) throw new Error("restoreDirectorySnapshotSync requires a target directory.");
  const sourceExists = Boolean(source && existsSync(source));
  const targetExisted = existsSync(target);
  if (targetExisted) rmSync(target, { recursive: true, force: true });
  if (sourceExists) {
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true, force: true });
  }
  return {
    source,
    target,
    sourceExists,
    targetExisted,
    restored: sourceExists,
    removedTarget: targetExisted && !sourceExists
  };
}
