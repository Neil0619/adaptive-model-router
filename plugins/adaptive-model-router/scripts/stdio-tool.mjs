#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { sanitizedError } from "./lib/io.mjs";
import { environmentWithPluginData } from "./lib/plugin-data.mjs";

const MAX_INPUT_BYTES = 1_048_576;
const TIMEOUT_MS = 15_000;
const requestedInputTimeout = Number(process.env.ADAPTIVE_ROUTER_STDIO_INPUT_TIMEOUT_MS || 5_000);
const INPUT_TIMEOUT_MS = Number.isInteger(requestedInputTimeout) &&
  requestedInputTimeout >= 1 && requestedInputTimeout <= 60_000
  ? requestedInputTimeout
  : 5_000;
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readRequest() {
  return new Promise((resolveRequest, reject) => {
    let body = "";
    let settled = false;
    let timer;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const parse = (value) => {
      finish(() => {
        process.stdin.destroy();
        try {
          const parsed = JSON.parse(value);
          if (
            !parsed ||
            typeof parsed !== "object" ||
            Array.isArray(parsed) ||
            typeof parsed.name !== "string" ||
            !parsed.arguments ||
            typeof parsed.arguments !== "object" ||
            Array.isArray(parsed.arguments)
          ) {
            throw new Error("stdio bridge request must contain name and arguments");
          }
          resolveRequest(parsed);
        } catch (error) {
          reject(error);
        }
      });
    };
    timer = setTimeout(() => {
      finish(() => {
        process.stdin.destroy();
        reject(new Error(
          "stdio bridge timed out before receiving JSON; caller must start a writable command session and send one JSON line",
        ));
      });
    }, INPUT_TIMEOUT_MS);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      if (settled) return;
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > MAX_INPUT_BYTES) {
        finish(() => {
          reject(new Error("stdio bridge input is too large"));
          process.stdin.destroy();
        });
        return;
      }
      const newline = body.indexOf("\n");
      if (newline >= 0) parse(body.slice(0, newline));
    });
    process.stdin.on("end", () => {
      if (!settled) parse(body);
    });
    process.stdin.on("error", (error) => {
      finish(() => reject(error));
    });
  });
}

function mcpConfig() {
  const document = JSON.parse(readFileSync(resolve(pluginRoot, ".mcp.json"), "utf8"));
  const server = document?.mcpServers?.["adaptive-model-router"];
  if (
    !server ||
    typeof server.command !== "string" ||
    !Array.isArray(server.args) ||
    server.tools?.[request.name]?.approval_mode !== "approve"
  ) {
    throw new Error("stdio bridge tool is not approved by the installed MCP contract");
  }
  return server;
}

function callTool(server) {
  return new Promise((resolveCall, reject) => {
    const child = spawn(server.command, server.args, {
      cwd: pluginRoot,
      env: environmentWithPluginData(import.meta.url),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("stdio bridge timed out"));
    }, TIMEOUT_MS);
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4096) stderr += chunk;
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code) => {
      if (!settled && code !== 0) {
        finish(() => reject(new Error(stderr.trim() || `stdio bridge child exited ${code}`)));
      }
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message?.id !== 2) return;
      finish(() => {
        lines.close();
        resolveCall(message.result);
      });
    });
    child.stdin.end(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    })}\n${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: request.name, arguments: request.arguments },
    })}\n`);
  });
}

let request;
try {
  request = await readRequest();
  const result = await callTool(mcpConfig());
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    transport: "stdio-bridge",
    tool: request.name,
    ...result,
  })}\n`);
  process.exitCode = result?.isError ? 1 : 0;
} catch (error) {
  process.stderr.write(`adaptive-model-router stdio bridge: ${sanitizedError(error)}\n`);
  process.exitCode = 1;
}
