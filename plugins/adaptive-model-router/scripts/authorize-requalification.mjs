#!/usr/bin/env node
import { RouterStore } from "./lib/database.mjs";
import { authorizeRequalification, closeQualificationDiagnostics } from "./lib/qualification-retry.mjs";
import { environmentWithPluginData } from "./lib/plugin-data.mjs";

let store;
try {
  Object.assign(process.env, environmentWithPluginData(import.meta.url));
  const input = {};
  let close = false;
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--approve-one-no-tool-requalification" && !input.apply) input.apply = true;
    else if (flag === "--close-diagnostics" && !close) close = true;
    else {
      const key = { "--context": "contextId", "--route": "routeId", "--expect-digest": "expectedEvidenceDigest" }[flag];
      if (!key || input[key] !== undefined || !argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error("invalid arguments");
      input[key] = argv[++index];
    }
  }
  if (!input.contextId || (close ? Object.keys(input).length !== 1 : !input.routeId)
    || (input.apply && !/^[a-f0-9]{64}$/u.test(input.expectedEvidenceDigest || ""))) throw new Error("invalid arguments");
  store = new RouterStore();
  const result = close ? closeQualificationDiagnostics(store, input.contextId)
    : await authorizeRequalification(input, { store, cwd: process.cwd() });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === "unresolved") process.exitCode = 7;
} catch {
  process.stderr.write("Adaptive Router could not authorize this one-use no-tool qualification.\n");
  process.exitCode = 7;
} finally { store?.close(); }
