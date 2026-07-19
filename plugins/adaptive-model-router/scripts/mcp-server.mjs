#!/usr/bin/env node
import { createInterface } from "node:readline";
import { ROUTER_VERSION } from "./lib/constants.mjs";
import { sanitizedError, writeJsonLine } from "./lib/io.mjs";
import { assertRuntime } from "./lib/runtime.mjs";

try {
  assertRuntime();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
}
const { callRouterTool, createServiceStore, TOOL_DEFINITIONS } = await import("./lib/service.mjs");
let store;
try {
  store = createServiceStore();
} catch {
  process.stderr.write("Adaptive Model Router could not open its local database.\n");
  process.exit(2);
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
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "adaptive-model-router", version: ROUTER_VERSION },
      },
    });
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: TOOL_DEFINITIONS } });
    return;
  }
  if (message.method === "tools/call") {
    try {
      const result = await callRouterTool(message.params?.name, message.params?.arguments || {}, { store });
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
    }
    return;
  }
  if (message.id != null) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  handle(message).catch(() => {
    if (message?.id != null) send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "Internal error" } });
  });
});
process.once("exit", () => store.close());
