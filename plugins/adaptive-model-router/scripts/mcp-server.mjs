#!/usr/bin/env node
import { createInterface } from "node:readline";
import { ROUTER_VERSION } from "./lib/constants.mjs";
import { sanitizedError, writeJsonLine } from "./lib/io.mjs";
import { compatibleToolDefinitions } from "./lib/tool-contract-compatibility.mjs";
import { assertSchema } from "./lib/schema.mjs";
import { assertRuntime } from "./lib/runtime.mjs";
import { pluginRootFrom, resolveRuntime, runtimeModuleUrl } from "./lib/runtime-loader.mjs";
import { beginMcpDispatch, endRuntimeDispatch } from "./lib/runtime-dispatch.mjs";
import { createRuntimeLifecycleProbe, inspectRuntimeQualification } from "./lib/runtime-lifecycle.mjs";
import { acquireRuntimeInvocation, runtimeGeneration, runtimeTask, finishRuntimeInvocation, settleRuntimeMigration } from "./lib/runtime-isolation.mjs";


try {
  assertRuntime();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
}
const shellService = await import("./lib/service.mjs");
const TOOL_DEFINITIONS = shellService.TOOL_DEFINITIONS;
const pluginRoot = pluginRootFrom(import.meta.url);
function contractMatches(service) {
  return compatibleToolDefinitions(TOOL_DEFINITIONS, service.TOOL_DEFINITIONS);
}


async function importRuntime(resolution) {
  const service = await import(runtimeModuleUrl(resolution, "service"));
  if (!contractMatches(service)) throw new Error("runtime tool contract is incompatible");
  if (
    typeof service.callRouterTool !== "function" ||
    typeof service.createServiceStore !== "function"
  ) {
    throw new Error("runtime service contract is incomplete");
  }
  return service;
}

async function settleCandidate(dispatch, args) {
  const candidate = await importRuntime(dispatch.selected);
  let store = candidate.createServiceStore({ runtimeInvocation: dispatch.invocation });
  try {
    const task = runtimeTask(store.db, dispatch.context);
    if (!task?.candidate || task.candidate !== dispatch.invocation.generation) return dispatch;
    const status = await inspectRuntimeQualification(dispatch.selected, pluginRoot, { store, contextId: args.contextId });
    const old = await inspectRuntimeQualification(runtimeGeneration(store.db, task.generation), pluginRoot,
      { store, contextId: args.contextId });
    store.transaction(() => {
      const settled = settleRuntimeMigration(store.db, dispatch.context, {
        candidateQualification: status.qualification, oldQualificationValid: old.ready,
        candidateReady: status.ready,
        ignoreInvocation: dispatch.invocation.id,
      });
      if (["migrated", "restored"].includes(settled.state)) {
        finishRuntimeInvocation(store.db, dispatch.invocation);
        const next = acquireRuntimeInvocation(store.db, dispatch.context, { kind: "mcp:route_stage" });
        dispatch = { ...dispatch, ...next };
      }
    });
    return dispatch;
  } finally { store.close(); }
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
    let store, dispatch;
    try {
      const definition = TOOL_DEFINITIONS.find((tool) => tool.name === message.params?.name);
      if (!definition) throw new Error("Unknown Router tool");
      assertSchema(definition.inputSchema, message.params?.arguments || {}, `${definition.name} input`);
      dispatch = beginMcpDispatch(message.params?.name, message.params?.arguments || {}, { shellRoot: pluginRoot });
      if (message.params?.name === "route_stage") dispatch = await settleCandidate(dispatch, message.params.arguments);
      const runtime = { resolution: dispatch.selected, service: await importRuntime(dispatch.selected) };
      store = runtime.service.createServiceStore({ runtimeInvocation: dispatch.invocation });
      const lifecycleHookProbe = createRuntimeLifecycleProbe(dispatch.selected, pluginRoot);
      let result = await runtime.service.callRouterTool(
        message.params?.name,
        message.params?.arguments || {},
        {
          store,
          routeOptions: {
            enforceLifecycleHooks: true,
            pluginRoot,
            lifecycleHookProbe,
          },
          qualificationOptions: { inspectBinding: () => lifecycleHookProbe({
            store, contextId: message.params.arguments.contextId,
            context: store.context({ cwd: process.cwd(), contextId: message.params.arguments.contextId }),
            cwd: process.cwd(),
          }) },
        },
      );
      if (
        message.params?.name === "diagnose_router" &&
        result &&
        typeof result === "object" &&
        !Array.isArray(result)
      ) {
        result = { ...result, runtime: { runtimeVersion: runtime.resolution.descriptor.runtimeVersion,
          contentDigest: runtime.resolution.digest, shellProtocolVersion: 2, taskIsolation: true,
          migrationPending: Boolean(runtimeTask(store.db, dispatch.context)?.candidate) } };
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
      endRuntimeDispatch(dispatch);
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
