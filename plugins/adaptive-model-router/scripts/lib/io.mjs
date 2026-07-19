import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function payloadHash(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function parseJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

export function normalizeText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.normalize("NFC");
  return canonicalJson(value).normalize("NFC");
}

export function includesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

export function sleepSync(milliseconds) {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function isSqliteBusy(error) {
  const message = String(error?.message || "").toLowerCase();
  return error?.code === "ERR_SQLITE_BUSY" || message.includes("database is locked") || message.includes("database is busy");
}

export function sanitizedError(error, fallback = "operation failed") {
  const message = String(error?.message || fallback)
    .replace(/(?:[A-Za-z]:[\\/]|\/)(?:[^\s:'\"]+[\\/])*[^\s:'\"]*/g, "[path]")
    .replace(/(?:api[_-]?key|token|secret|password)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 240);
  return message || fallback;
}

export function redactPromptSummary(value, limit = 2_000) {
  let text = String(value || "").normalize("NFC");
  text = text.replace(/```[\s\S]*?```/g, "[code omitted]");
  text = text.replace(/`[^`\n]+`/g, "[code omitted]");
  text = text.replace(/\b[A-Za-z]:\\[^\s\r\n"']+/g, "[path]");
  text = text.replace(/(?:^|[\s(])\/(?:[^\s\r\n"']+\/)*[^\s\r\n"']+/g, " [path]");
  text = text.replace(/\b[A-Z][A-Z0-9_]{2,}\s*=\s*[^\s]+/g, "[environment]");
  text = text.replace(/\b(?:sk-[A-Za-z0-9_-]{10,}|gh[opurs]_[A-Za-z0-9_]{10,}|AKIA[A-Z0-9]{12,})\b/g, "[secret]");
  text = text.replace(/(?:api[_-]?key|token|secret|password)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]");
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
}

export function writeJsonLine(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}
