#!/usr/bin/env node
import { RouterStore } from "./lib/database.mjs";
import { recoverDelegation } from "./lib/delegation-recovery.mjs";
import { environmentWithPluginData } from "./lib/plugin-data.mjs";

// Explicit operator recovery; no runtime caller can submit host observations.
// Inspect first, then apply only the exact digest freshly revalidated here.
let store;
try {
  Object.assign(process.env, environmentWithPluginData(import.meta.url));
  const input = {};
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--apply") input.apply = true;
    else {
      const key = {
        "--context": "contextId", "--route": "routeId", "--expect-digest": "expectedEvidenceDigest",
      }[flag];
      if (!key || input[key] !== undefined || !argv[index + 1] || argv[index + 1].startsWith("--")) {
        throw new Error("invalid recovery arguments");
      }
      input[key] = argv[++index];
    }
  }
  if (!input.contextId || !input.routeId
    || (input.apply && !/^[a-f0-9]{64}$/u.test(input.expectedEvidenceDigest || ""))) {
    throw new Error("inspect requires --context and --route; --apply also requires --expect-digest");
  }
  store = new RouterStore();
  const result = await recoverDelegation(input, { store, cwd: process.cwd() });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === "unresolved") process.exitCode = 7;
} catch {
  process.stderr.write("Adaptive Router recovery could not establish authoritative closure; no recovery was applied.\n");
  process.exitCode = 7;
} finally {
  store?.close();
}
