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

function validObservation(value, scoped) {
  const fields = ["schemaVersion", "hookEvent", "source", "sessionId", "turnId",
    "boundedSubagent", "identityStatus", "contextInjection", "observedAt", ...(scoped ? ["turnDigest"] : [])];
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === fields.length && Object.keys(value).every((key) => fields.includes(key))
    && value.schemaVersion === 1
    && ["SessionStart", "SubagentStart", "SubagentStop", "PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "unknown"].includes(value.hookEvent)
    && ["startup", "resume", "clear", "compact", "none"].includes(value.source)
    && ["present", "missing"].includes(value.sessionId) && ["present", "absent"].includes(value.turnId)
    && typeof value.boundedSubagent === "boolean"
    && value.identityStatus === (value.sessionId === "present" ? "accepted" : "missing_session_id")
    && ["identity_accepted", "context_emitted", "blocked_missing_session_id", "not_injected_router_inactive", "injected_after_compaction"].includes(value.contextInjection)
    && typeof value.observedAt === "string" && Number.isFinite(Date.parse(value.observedAt))
    && (!scoped || (value.turnId === "present"
      ? typeof value.turnDigest === "string" && /^[a-f0-9]{64}$/u.test(value.turnDigest)
      : value.turnDigest === null));
}

function taskPath(env, contextId, turn = false) {
  return join(root(env), "diagnostics", turn ? "hook-turns-v1" : "hook-tasks-v1", `${identityDigest("context", contextId)}.json`);
}

function atomicWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function writeScoped(path, value) {
  atomicWrite(path, value);
  // Bound each diagnostic index independently. A pruned receipt is unobserved.
  const entries = readdirSync(dirname(path)).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name));
  if (entries.length > 256) {
    const oldest = entries.map((name) => {
      const file = join(dirname(path), name);
      try { return { file, time: statSync(file).mtimeMs }; } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.time - a.time).slice(256);
    for (const entry of oldest) rmSync(entry.file, { force: true });
  }
}

export function recordHookIdentityDiagnostic(audit, contextInjection, env = process.env, { contextId, turnId } = {}) {
  const value = {
    ...audit,
    contextInjection,
    observedAt: new Date().toISOString(),
  };
  atomicWrite(pathFor(env), value);
  if (identityDigest("context", contextId)) {
    const scoped = { ...value, turnDigest: identityDigest("turn", turnId) };
    writeScoped(taskPath(env, contextId), scoped);
    // SessionStart(compact) has no turn_id on Desktop. Keep its latest task
    // diagnostic, while retaining the independently observed exact-turn proof.
    // Never infer a turn from a turnless event or overwrite its proof with one.
    if (scoped.turnDigest) writeScoped(taskPath(env, contextId, true), scoped);
  }
  return value;
}

export function readHookIdentityDiagnostic(env = process.env, { contextId, turnId } = {}) {
  const scoped = Boolean(identityDigest("context", contextId));
  const scope = scoped ? turnId ? "turn" : "task" : "global_latest";
  try {
    let raw;
    if (scoped && turnId) {
      try { raw = readFileSync(taskPath(env, contextId, true), "utf8"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    // Read the previous format only when no separate turn receipt exists.
    const value = JSON.parse(raw ?? readFileSync(scoped ? taskPath(env, contextId) : pathFor(env), "utf8"));
    if (!validObservation(value, scoped)) throw new Error("Hook receipt is malformed");
    if (turnId && (!scoped || value.turnDigest !== identityDigest("turn", turnId)
      || value.identityStatus !== "accepted" || value.boundedSubagent || value.hookEvent === "unknown")) {
      throw new Error("root turn not observed");
    }
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
