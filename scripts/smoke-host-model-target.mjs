#!/usr/bin/env node
import { AppServerClient } from "../plugins/adaptive-model-router/scripts/lib/app-server.mjs";
import { normalizeCatalog } from "../plugins/adaptive-model-router/scripts/lib/catalog.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((argument) => {
  const match = /^--(initial-model|effort)=(.+)$/u.exec(argument);
  if (!match) throw new Error("expected --initial-model=MODEL --effort=EFFORT");
  return [match[1], match[2]];
}));
if (!args["initial-model"] || !args.effort) throw new Error("initial host model and effort are required");

// Root-model availability is a host capability, independent of the bounded
// delegation allowlist. This helper never changes a task or chooses a delegate.
const client = new AppServerClient({ timeoutMs: 20_000 });
try {
  await client.start();
  const entries = [];
  const cursors = new Set();
  let cursor;
  do {
    const page = await client.request("model/list", { limit: 100, ...(cursor ? { cursor } : {}) });
    entries.push(...page.data);
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error("native model catalog repeated a cursor");
    cursors.add(cursor);
  } while (cursor);
  const catalog = normalizeCatalog(entries).filter((entry) => entry.visibility === "list"
    && entry.supportedReasoningEfforts.includes(args.effort));
  if (!catalog.some((entry) => entry.model === args["initial-model"])) {
    throw new Error("initial host model and effort are unavailable");
  }
  const alternatives = catalog.filter((entry) => entry.model !== args["initial-model"]);
  const alternate = alternatives.find((entry) => entry.model === "gpt-5.6-sol") || alternatives[0];
  if (!alternate) throw new Error("HOST_MODEL_OVERRIDE_UNAVAILABLE: no second native root model supports the initial effort");
  process.stdout.write(`${JSON.stringify({ model: alternate.model, effort: args.effort, source: "native-model-list" })}\n`);
} finally {
  client.close();
}
