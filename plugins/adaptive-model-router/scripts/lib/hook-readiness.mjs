import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppServerClient, withAppServer } from "./app-server.mjs";
import { lifecycleBinding, nativeQualificationHost, nativeTaskWorkingDirectory, provenQualificationShellRoots, qualificationReadiness } from "./lifecycle-qualification.mjs";
import { payloadHash } from "./io.mjs";
import { discoverRuntimeCandidates } from "./runtime-loader.mjs";
import { readHookIdentityDiagnostic } from "./hook-diagnostics.mjs";

export const HOOK_READINESS_TIMEOUT_MS = 5_000;

const PLUGIN_ID = "adaptive-model-router@adaptive-model-router";
const MODULE_PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REQUIRED_EVENTS = new Set([
  "sessionStart",
  "subagentStart",
  "subagentStop",
  "preToolUse",
  "postToolUse",
  "userPromptSubmit",
  "stop",
]);
const READINESS_FAILURE_CODES = new Set([
  "HOOK_TRUST_REQUIRED",
  "HOST_HOOK_SET_MISMATCH",
  "HOST_HOOK_STATUS_UNAVAILABLE",
  "HOST_HOOK_DISPATCH_NOT_OBSERVED",
  "HOST_LIFECYCLE_ROUND_TRIP_UNPROVEN",
  "HOST_LIFECYCLE_QUALIFICATION_FAILED",
]);

export function resolveLifecyclePluginRoot({
  env = process.env,
  argv = process.argv,
  moduleRoot = MODULE_PLUGIN_ROOT,
} = {}) {
  if (typeof env.PLUGIN_ROOT === "string" && env.PLUGIN_ROOT) {
    return resolve(env.PLUGIN_ROOT);
  }
  const entrypoint = typeof argv?.[1] === "string" ? resolve(argv[1]) : null;
  if (entrypoint && ["mcp-server.mjs", "hook.mjs"].includes(entrypoint.split(/[\\/]/u).at(-1))) {
    return resolve(dirname(entrypoint), "..");
  }
  return resolve(moduleRoot);
}

function hostEventName(eventName) {
  return `${eventName[0].toLowerCase()}${eventName.slice(1)}`;
}

function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function expectedHooks(pluginRoot, platform) {
  const sourcePath = join(pluginRoot, "hooks", "hooks.json");
  let document;
  try {
    document = JSON.parse(readFileSync(sourcePath, "utf8"));
  } catch {
    return null;
  }
  const expected = [];
  for (const [eventName, groups] of Object.entries(document?.hooks || {})) {
    if (!Array.isArray(groups)) return null;
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) return null;
      for (const hook of group.hooks) {
        const command = platform === "win32" ? hook?.commandWindows : hook?.command;
        if (hook?.type !== "command" || typeof command !== "string" || !command) return null;
        expected.push({
          eventName: hostEventName(eventName),
          command,
          matcher: group.matcher ?? null,
          timeoutSec: hook.timeout,
          statusMessage: hook.statusMessage ?? null,
          async: hook.async === true,
        });
      }
    }
  }
  return { sourcePath, entries: expected };
}

function sameDefinition(actual, expected, sourcePath) {
  return (
    actual?.pluginId === PLUGIN_ID
    && actual?.source === "plugin"
    && actual?.handlerType === "command"
    && actual?.eventName === expected.eventName
    && actual?.command === expected.command
    && (actual?.matcher ?? null) === expected.matcher
    && actual?.timeoutSec === expected.timeoutSec
    && (actual?.statusMessage ?? null) === expected.statusMessage
    && actual?.async === expected.async
    && canonicalPath(actual?.sourcePath) === sourcePath
    && /^sha256:[0-9a-f]{64}$/u.test(actual?.currentHash || "")
  );
}

export function evaluateLifecycleHookInventory(hooksList, {
  cwd,
  pluginRoot = resolveLifecyclePluginRoot(),
  platform = process.platform,
} = {}) {
  const canonicalCwd = canonicalPath(cwd);
  const canonicalPluginRoot = canonicalPath(pluginRoot);
  if (!canonicalCwd || !canonicalPluginRoot) {
    return { ready: false, reasonCode: "HOST_HOOK_SET_MISMATCH" };
  }
  const expected = expectedHooks(canonicalPluginRoot, platform);
  const expectedSourcePath = expected ? canonicalPath(expected.sourcePath) : null;
  const expectedEventCounts = new Map();
  for (const entry of expected?.entries || []) {
    expectedEventCounts.set(entry.eventName, (expectedEventCounts.get(entry.eventName) || 0) + 1);
  }
  if (
    !expected
    || !expectedSourcePath
    || [...REQUIRED_EVENTS].some((eventName) => expectedEventCounts.get(eventName) !== 1)
  ) {
    return { ready: false, reasonCode: "HOST_HOOK_SET_MISMATCH" };
  }
  if (!Array.isArray(hooksList?.data)) {
    return { ready: false, reasonCode: "HOST_HOOK_STATUS_UNAVAILABLE" };
  }
  const groups = hooksList.data.filter((group) => canonicalPath(group?.cwd) === canonicalCwd);
  if (groups.length !== 1 || !Array.isArray(groups[0]?.hooks) || (groups[0].errors?.length || 0) > 0) {
    return { ready: false, reasonCode: "HOST_HOOK_STATUS_UNAVAILABLE" };
  }
  const actual = groups[0].hooks.filter((entry) => entry?.pluginId === PLUGIN_ID);
  if (actual.length !== expected.entries.length) {
    return { ready: false, reasonCode: "HOST_HOOK_SET_MISMATCH" };
  }
  const remaining = [...actual];
  for (const entry of expected.entries) {
    const matches = remaining
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => sameDefinition(candidate, entry, expectedSourcePath));
    if (matches.length !== 1) {
      return { ready: false, reasonCode: "HOST_HOOK_SET_MISMATCH" };
    }
    remaining.splice(matches[0].index, 1);
  }
  if (remaining.length !== 0) {
    return { ready: false, reasonCode: "HOST_HOOK_SET_MISMATCH" };
  }
  if (actual.some((entry) => entry.enabled !== true || entry.trustStatus !== "trusted")) {
    return { ready: false, reasonCode: "HOOK_TRUST_REQUIRED" };
  }
  return { ready: true, reasonCode: null };
}

async function withHostAppServer(callback, { timeoutMs }) {
  return withAppServer(callback, {
    timeoutMs,
    clientFactory: ({ timeoutMs: clientTimeout }) => new AppServerClient({
      timeoutMs: clientTimeout,
      isolateSqlite: false,
    }),
  });
}

function safeHistoricalTree(root) {
  if (canonicalPath(root) !== resolve(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) return false;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) { if (!safeHistoricalTree(join(root, entry.name))) return false; }
    else if (!entry.isFile() || entry.isSymbolicLink()) return false;
  }
  return true;
}

function historicalHookShells(store, context, pluginRoot, inventoryRoot, platform) {
  const roots = [pluginRoot, inventoryRoot].map(canonicalPath);
  const required = new Set(provenQualificationShellRoots(store.db, context));
  for (const root of roots) required.delete(payloadHash(root));
  if (required.size === 0) return [];
  const expected = expectedHooks(inventoryRoot, platform);
  const matched = [];
  for (const base of roots) for (const candidate of discoverRuntimeCandidates(base)) {
    const hash = payloadHash(candidate.root);
    if (!required.has(hash)) continue;
    const actual = expectedHooks(candidate.root, platform);
    if (!safeHistoricalTree(candidate.root) || !actual || payloadHash(actual.entries) !== payloadHash(expected.entries)) {
      throw new Error("previously observed Hook shell is no longer equivalent");
    }
    matched.push(candidate.root); required.delete(hash);
  }
  if (required.size !== 0) throw new Error("previously observed Hook shell is unavailable");
  return matched;
}

export async function inspectLifecycleHookReadiness({
  cwd,
  pluginRoot = resolveLifecyclePluginRoot(),
  platform = process.platform,
  timeoutMs = HOOK_READINESS_TIMEOUT_MS,
  appServer = withHostAppServer,
  dispatchRoundTripProbe = null,
  store = null,
  context = null,
  contextId = null,
  nativeHost = nativeQualificationHost,
} = {}) {
  let inventory;
  let hooksList;
  let taskTurnId;
  let inventoryRoot = pluginRoot;
  try {
    hooksList = await appServer(
      async (client, deadlineAt) => {
        if (store && context) {
          await client.start(deadlineAt);
          const result = await client.request("thread/read", { threadId: contextId, includeTurns: false }, deadlineAt);
          cwd = nativeTaskWorkingDirectory(result.thread, { contextId, store, context });
          const turns = await client.request("thread/turns/list", {
            threadId: contextId, limit: 1, itemsView: "summary", sortDirection: "desc",
          }, deadlineAt);
          taskTurnId = turns.data?.[0]?.id;
        }
        return client.listHooks(cwd, deadlineAt);
      },
      { timeoutMs },
    );
    inventory = evaluateLifecycleHookInventory(hooksList, { cwd, pluginRoot, platform });
    if (store && context && inventory.reasonCode === "HOST_HOOK_SET_MISMATCH") {
      const group = hooksList.data?.find((entry) => canonicalPath(entry.cwd) === canonicalPath(cwd));
      const roots = [...new Set((group?.hooks || []).filter((entry) => entry.pluginId === PLUGIN_ID)
        .map((entry) => entry.sourcePath && canonicalPath(dirname(dirname(entry.sourcePath)))))];
      if (roots.length === 1 && roots[0]) {
        const discovered = evaluateLifecycleHookInventory(hooksList, { cwd, pluginRoot: roots[0], platform });
        // A hot runtime can have a different configured cache path from this
        // task's fixed shell. Equivalent definitions permit only the approved
        // inert qualification, never normal work without its current-task proof.
        const pinned = expectedHooks(pluginRoot, platform);
        const configured = expectedHooks(roots[0], platform);
        if ((discovered.ready || discovered.reasonCode === "HOOK_TRUST_REQUIRED") && pinned && configured
          && payloadHash(pinned.entries) === payloadHash(configured.entries)) {
          inventory = discovered;
          inventoryRoot = roots[0];
        }
      }
    }
  } catch {
    return { ready: false, reasonCode: "HOST_HOOK_STATUS_UNAVAILABLE" };
  }
  if (inventory.ready !== true) return inventory;
  if (store && context) {
    // A new app-server's trusted inventory does not prove that the long-lived
    // Desktop task loaded those plugin Hooks. Require an actual receipt for the
    // latest native turn before allocating even an inert qualification ticket.
    // Never borrow another task's receipt or an older turn's successful proof.
    const dispatched = typeof taskTurnId === "string" && taskTurnId
      ? readHookIdentityDiagnostic(process.env, { contextId, turnId: taskTurnId }) : null;
    if (!dispatched?.available || dispatched.reasonCode !== "HOOK_DISPATCHED_IDENTITY_ACCEPTED") {
      return { ready: false, reasonCode: "HOST_HOOK_DISPATCH_NOT_OBSERVED" };
    }
  }
  if (typeof dispatchRoundTripProbe !== "function") {
    if (store && context) {
      try {
        const host = await nativeHost();
        const group = hooksList.data.find((entry) => canonicalPath(entry.cwd) === canonicalPath(cwd));
        const historicalRoots = historicalHookShells(store, context, pluginRoot, inventoryRoot, platform);
        const binding = lifecycleBinding(group.hooks, pluginRoot, inventoryRoot, host, cwd, historicalRoots);
        return qualificationReadiness(store.db, context, binding);
      } catch { /* Unknown hosts remain root-only, without a qualification ticket. */ }
    }
    return { ready: false, reasonCode: "HOST_LIFECYCLE_ROUND_TRIP_UNPROVEN" };
  }
  try {
    const proof = await dispatchRoundTripProbe({ cwd, pluginRoot, platform });
    if (proof?.ready === true) return { ready: true, reasonCode: null };
    return {
      ready: false,
      reasonCode: proof?.reasonCode === "HOST_HOOK_SET_MISMATCH"
        ? "HOST_HOOK_SET_MISMATCH"
        : "HOST_LIFECYCLE_ROUND_TRIP_UNPROVEN",
    };
  } catch {
    return { ready: false, reasonCode: "HOST_LIFECYCLE_ROUND_TRIP_UNPROVEN" };
  }
}

export function normalizeHookReadinessFailure(value) {
  return READINESS_FAILURE_CODES.has(value?.reasonCode)
    ? value.reasonCode
    : "HOST_HOOK_STATUS_UNAVAILABLE";
}
