import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { defaultPluginData } from "./plugin-data.mjs";

function root(env) {
  return env.ADAPTIVE_ROUTER_HOME || env.PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA || defaultPluginData(env);
}

function pathFor(env) {
  return join(root(env), "diagnostics", "hook-identity-v1.json");
}

const identityDigest = (kind, value) => typeof value === "string" && value.trim()
  ? createHash("sha256").update(`hook-${kind}\0${value.trim()}`).digest("hex") : null;

function taskPath(env, contextId) {
  return join(root(env), "diagnostics", "hook-tasks-v1", `${identityDigest("context", contextId)}.json`);
}

function atomicWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function recordHookIdentityDiagnostic(audit, contextInjection, env = process.env, { contextId, turnId } = {}) {
  const value = {
    ...audit,
    contextInjection,
    observedAt: new Date().toISOString(),
  };
  atomicWrite(pathFor(env), value);
  if (identityDigest("context", contextId)) {
    const path = taskPath(env, contextId);
    atomicWrite(path, { ...value, turnDigest: identityDigest("turn", turnId) });
    // Keep diagnostics bounded. Losing an old receipt means unobserved, never
    // permission to borrow another task's dispatch evidence.
    const entries = readdirSync(dirname(path)).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name));
    if (entries.length > 256) {
      const oldest = entries.map((name) => {
        const file = join(dirname(path), name);
        try { return { file, time: statSync(file).mtimeMs }; } catch { return null; }
      }).filter(Boolean).sort((a, b) => b.time - a.time).slice(256);
      for (const entry of oldest) rmSync(entry.file, { force: true });
    }
  }
  return value;
}

export function readHookIdentityDiagnostic(env = process.env, { contextId, turnId } = {}) {
  const scoped = Boolean(identityDigest("context", contextId));
  const scope = scoped ? turnId ? "turn" : "task" : "global_latest";
  try {
    const value = JSON.parse(readFileSync(scoped ? taskPath(env, contextId) : pathFor(env), "utf8"));
    if (turnId && (!scoped || value.turnDigest !== identityDigest("turn", turnId))) throw new Error("turn not observed");
    const { turnDigest: ignored, ...lastObservation } = value;
    return {
      scope,
      available: true,
      reasonCode: value.identityStatus === "missing_session_id"
        ? "HOOK_DISPATCHED_MISSING_SESSION_ID"
        : "HOOK_DISPATCHED_IDENTITY_ACCEPTED",
      lastObservation,
    };
  } catch {
    return {
      scope,
      available: false,
      reasonCode: "HOOK_DISPATCH_NOT_OBSERVED",
      lastObservation: null,
    };
  }
}
