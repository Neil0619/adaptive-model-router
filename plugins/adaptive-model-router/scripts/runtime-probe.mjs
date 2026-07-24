#!/usr/bin/env node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalJson } from "./lib/io.mjs";
import { pluginRootFrom, readRuntimeDescriptor, runtimeModuleUrl } from "./lib/runtime-loader.mjs";

const shellRoot = pluginRootFrom(import.meta.url);
const candidateRoot = process.argv[2] ? resolve(process.argv[2]) : shellRoot;
const temporary = mkdtempSync(join(tmpdir(), "adaptive-router-runtime-probe-"));
const previousHome = process.env.ADAPTIVE_ROUTER_HOME;
const previousLocalOnly = process.env.ADAPTIVE_ROUTER_LOCAL_ONLY;

try {
  process.env.ADAPTIVE_ROUTER_HOME = temporary;
  process.env.ADAPTIVE_ROUTER_LOCAL_ONLY = "1";
  const shellDescriptor = readRuntimeDescriptor(shellRoot);
  const shell = await import(runtimeModuleUrl({ root: shellRoot, descriptor: shellDescriptor }, "service"));
  const descriptor = readRuntimeDescriptor(candidateRoot);
  const candidate = { root: candidateRoot, descriptor };
  const service = await import(runtimeModuleUrl(candidate, "service"));
  if (!Array.isArray(service.TOOL_DEFINITIONS) || typeof service.createServiceStore !== "function") {
    throw new Error("runtime service contract is incomplete");
  }
  const contract = (definitions) =>
    canonicalJson(definitions.map(({ name, inputSchema }) => ({ name, inputSchema })));
  if (contract(shell.TOOL_DEFINITIONS) !== contract(service.TOOL_DEFINITIONS)) {
    throw new Error("runtime tool contract is incompatible");
  }
  const store = service.createServiceStore();
  try {
    const diagnosis = store.diagnose(store.context({
      cwd: temporary,
      contextId: "runtime-probe",
      authoritative: true,
    }));
    if (diagnosis.databaseHealth !== "ok") throw new Error("runtime database probe failed");
  } finally {
    store.close();
  }
} catch {
  process.exitCode = 78;
} finally {
  if (previousHome === undefined) delete process.env.ADAPTIVE_ROUTER_HOME;
  else process.env.ADAPTIVE_ROUTER_HOME = previousHome;
  if (previousLocalOnly === undefined) delete process.env.ADAPTIVE_ROUTER_LOCAL_ONLY;
  else process.env.ADAPTIVE_ROUTER_LOCAL_ONLY = previousLocalOnly;
  rmSync(temporary, { recursive: true, force: true });
}
