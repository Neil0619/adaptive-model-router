#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function normalizeLineEndings(bytes) {
  const normalized = [];
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0d) {
      normalized.push(bytes[index]);
      continue;
    }
    if (bytes[index + 1] === 0x0a) index += 1;
    normalized.push(0x0a);
  }
  return Buffer.from(normalized);
}

export async function filesMatchIgnoringLineEndings(left, right) {
  const [leftBytes, rightBytes] = await Promise.all([readFile(left), readFile(right)]);
  return normalizeLineEndings(leftBytes).equals(normalizeLineEndings(rightBytes));
}

async function main() {
  if (process.argv.length !== 4) throw new Error("usage: compare-gate-content.mjs LEFT RIGHT");
  process.exitCode = await filesMatchIgnoringLineEndings(process.argv[2], process.argv[3]) ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
