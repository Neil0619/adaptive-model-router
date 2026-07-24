#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { ROUTER_VERSION } from "./lib/constants.mjs";
import { canonicalJson, sanitizedError, writeJsonLine } from "./lib/io.mjs";
import { assertRuntime } from "./lib/runtime.mjs";
import {
  markRuntimeFailed,
  markRuntimeHealthy,
  pluginRootFrom,
  resolveRuntime,
  RUNTIME_PROBE_TIMEOUT_MS,
  runtimeEntrypoint,
  runtimeModuleUrl,
  runtimePublicState,
} from "./lib/runtime-loader.mjs";

try {
  assertRuntime();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
}
const shellService = await import("./lib/service.mjs");
const TOOL_DEFINITIONS = shellService.TOOL_DEFINITIONS;
const pluginRoot = pluginRootFrom(import.meta.url);
const shellContract = canonicalJson(
  TOOL_DEFINITIONS.map(({ name, inputSchema }) => ({ name, inputSchema })),
);

function contractMatches(service) {
  if (!Array.isArray(service.TOOL_DEFINITIONS)) return false;
  return canonicalJson(
    service.TOOL_DEFINITIONS.map(({ name, inputSchema }) => ({ name, inputSchema })),
  ) === shellContract;
}

function probeRuntime(resolution) {
  try {
    const contract = spawnSync(process.execPath, [
      runtimeEntrypoint(resolution.current, "probe"),
      resolution.candidate.root,
    ], {
      env: process.env,
      encoding: "utf8",
      windowsHide: true,
      timeout: RUNTIME_PROBE_TIMEOUT_MS,
    });
    if (contract.error || contract.status !== 0) return false;
    const health = spawnSync(process.execPath, [runtimeEntrypoint(resolution.candidate, "probe")], {
      env: process.env,
      encoding: "utf8",
      windowsHide: true,
      timeout: RUNTIME_PROBE_TIMEOUT_MS,
    });
    return !health.error && health.status === 0;
  } catch {
    return false;
  }
}

async function importRuntime(resolution) {
  const service = await import(runtimeModuleUrl(resolution.candidate, "service"));
  if (!contractMatches(service)) throw new Error("runtime tool contract is incompatible");
  if (
    typeof service.callRouterTool !== "function" ||
    typeof service.createServiceStore !== "function"
  ) {
    throw new Error("runtime service contract is incomplete");
  }
  return service;
}

async function loadRuntime() {
  let resolution = resolveRuntime(pluginRoot);
  if (resolution.provisional) {
    if (!probeRuntime(resolution)) {
      markRuntimeFailed(resolution);
      resolution = resolveRuntime(pluginRoot, { allowTrial: false });
    }
  }
  try {
    const service = await importRuntime(resolution);
    return { resolution, service };
  } catch (error) {
    if (resolution.candidate.root === resolution.current.root) throw error;
    markRuntimeFailed(resolution);
    const fallback = resolveRuntime(pluginRoot, { allowTrial: false });
    return { resolution: fallback, service: await importRuntime(fallback) };
  }
}

function send(value) {
  writeJsonLine(process.stdout, value);
}

async function handle(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "initialize") {
    let version = ROUTER_VERSION;
    try {
      version = resolveRuntime(pluginRoot, { allowTrial: false }).candidate.descriptor.runtimeVersion;
    } catch {}
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "adaptive-model-router", version },
      },
    });
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: TOOL_DEFINITIONS } });
    return;
  }
  if (message.method === "tools/call") {
    let store;
    try {
      let runtime = await loadRuntime();
      try {
        store = runtime.service.createServiceStore();
      } catch (error) {
        if (runtime.resolution.candidate.root === runtime.resolution.current.root) throw error;
        markRuntimeFailed(runtime.resolution);
        const fallback = resolveRuntime(pluginRoot, { allowTrial: false });
        runtime = { resolution: fallback, service: await importRuntime(fallback) };
        store = runtime.service.createServiceStore();
      }
      if (runtime.resolution.provisional) {
        markRuntimeHealthy(runtime.resolution);
        runtime = {
          ...runtime,
          resolution: { ...runtime.resolution, provisional: false },
        };
      }
      let result = await runtime.service.callRouterTool(
        message.params?.name,
        message.params?.arguments || {},
        { store },
      );
      if (
        message.params?.name === "diagnose_router" &&
        result &&
        typeof result === "object" &&
        !Array.isArray(result)
      ) {
        result = { ...result, runtime: runtimePublicState(runtime.resolution) };
      }
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result && typeof result === "object" && !Array.isArray(result) ? result : { items: result },
          isError: false,
        },
      });
    } catch (error) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: sanitizedError(error) }], isError: true },
      });
    } finally {
      store?.close();
    }
    return;
  }
  if (message.id != null) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let processing = Promise.resolve();
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  processing = processing
    .then(() => handle(message))
    .catch(() => {
      if (message?.id != null) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "Internal error" } });
      }
    });
});
