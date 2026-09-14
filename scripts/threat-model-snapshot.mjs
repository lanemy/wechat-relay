#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Computes the THREAT_MODEL.md snapshot digest over every git-tracked file.
//
//   node scripts/threat-model-snapshot.mjs          print digest and match status
//   node scripts/threat-model-snapshot.mjs --write  update the version line
//   node scripts/threat-model-snapshot.mjs --check  exit 1 on mismatch (CI)
//
// Algorithm (documented in THREAT_MODEL.md): files come from `git ls-files`,
// sorted by path. THREAT_MODEL.md's version line is normalized to
// "Version: snapshot-pending" before hashing. For each file the per-file
// digest is sha256(utf8(path) + 0x00 + content); the snapshot digest is the
// sha256 of all per-file digests concatenated.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";

const THREAT_MODEL = "THREAT_MODEL.md";
const VERSION_LINE = /^Version: uncommitted-snapshot-sha256:[0-9a-f]{64}$/mu;

function trackedFiles() {
  return execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .sort();
}

function fileContent(relativePath) {
  let content = fs.readFileSync(relativePath);
  if (relativePath === THREAT_MODEL) {
    content = Buffer.from(
      content.toString("utf8").replace(VERSION_LINE, "Version: snapshot-pending"),
    );
  }
  return content;
}

export function computeSnapshotDigest(root) {
  const previousCwd = process.cwd();
  process.chdir(root);
  try {
    const perFile = trackedFiles().map((relativePath) =>
      createHash("sha256")
        .update(Buffer.concat([Buffer.from(relativePath, "utf8"), Buffer.alloc(1), fileContent(relativePath)]))
        .digest(),
    );
    return createHash("sha256").update(Buffer.concat(perFile)).digest("hex");
  } finally {
    process.chdir(previousCwd);
  }
}

function storedDigest(root) {
  const text = fs.readFileSync(path.join(root, THREAT_MODEL), "utf8");
  const match = text.match(VERSION_LINE);
  return match ? match[0].slice("Version: uncommitted-snapshot-sha256:".length) : null;
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const mode = process.argv[2] ?? "";
  const digest = computeSnapshotDigest(root);
  const stored = storedDigest(root);

  if (mode === "--write") {
    if (stored === null) {
      fs.appendFileSync(path.join(root, THREAT_MODEL), `Version: uncommitted-snapshot-sha256:${digest}\n`);
    } else {
      const updated = fs
        .readFileSync(path.join(root, THREAT_MODEL), "utf8")
        .replace(VERSION_LINE, `Version: uncommitted-snapshot-sha256:${digest}`);
      fs.writeFileSync(path.join(root, THREAT_MODEL), updated);
    }
    process.stdout.write(`THREAT_MODEL.md snapshot updated to ${digest}\n`);
    return;
  }

  process.stdout.write(`computed: ${digest}\n`);
  process.stdout.write(`stored:   ${stored ?? "(missing)"}\n`);
  if (stored !== digest) {
    process.stderr.write("snapshot mismatch — run: node scripts/threat-model-snapshot.mjs --write\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
