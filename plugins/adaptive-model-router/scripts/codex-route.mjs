#!/usr/bin/env node
import { sanitizedError } from "./lib/io.mjs";
import { assertRuntime } from "./lib/runtime.mjs";

function parseArgs(values) {
  const parsed = { _: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      parsed._.push(value);
      continue;
    }
    const separator = value.indexOf("=");
    const key = value.slice(2, separator < 0 ? undefined : separator);
    if (separator >= 0) parsed[key] = value.slice(separator + 1);
    else if (values[index + 1] && !values[index + 1].startsWith("--")) parsed[key] = values[++index];
    else parsed[key] = true;
  }
  return parsed;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function help() {
  process.stdout.write(`Adaptive Model Router developer CLI (not installed globally)

Usage:
  node scripts/codex-route.mjs doctor [--context ID]
  node scripts/codex-route.mjs status [--context ID]
  node scripts/codex-route.mjs history [--context ID] [--limit 20] [--action all|delegate|continue|ask_user]
  node scripts/codex-route.mjs catalog
  node scripts/codex-route.mjs proposals [--context ID]
  node scripts/codex-route.mjs learning [--context ID]
  node scripts/codex-route.mjs approve PROPOSAL_ID [--context ID]
  node scripts/codex-route.mjs reject PROPOSAL_ID [--context ID]
  node scripts/codex-route.mjs rebase PROPOSAL_ID [--context ID]
  node scripts/codex-route.mjs rollback [--context ID]
  node scripts/codex-route.mjs import-legacy --confirm IMPORT_LEGACY_SETTINGS_POLICY [--context ID]
`);
}

async function main() {
  assertRuntime();
  const [{ getModelCatalog }, { RouterStore }, { importLegacySettingsAndPolicy }, { callRouterTool }] = await Promise.all([
    import("./lib/catalog.mjs"),
    import("./lib/database.mjs"),
    import("./lib/legacy.mjs"),
    import("./lib/service.mjs"),
  ]);
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "doctor";
  const contextId = String(args.context || process.env.CODEX_THREAD_ID || "developer-cli");
  const store = new RouterStore();
  try {
    if (command === "doctor") return print(await callRouterTool("diagnose_router", { contextId }, { store }));
    if (command === "status") return print(await callRouterTool("get_route_status", { contextId }, { store }));
    if (command === "history") {
      const limit = args.limit == null ? 20 : Number(args.limit);
      if (!Number.isInteger(limit)) throw new Error("history --limit must be an integer");
      return print(await callRouterTool("get_route_history", {
        contextId,
        limit,
        action: String(args.action || "all"),
      }, { store }));
    }
    if (command === "catalog") return print(await getModelCatalog({ store }));
    if (command === "proposals") return print(await callRouterTool("list_policy_proposals", { contextId }, { store }));
    if (command === "learning") return print(await callRouterTool("get_learning_status", { contextId }, { store }));
    if (command === "approve" || command === "reject" || command === "rebase") {
      const proposalId = args._[1];
      if (!proposalId) throw new Error(`${command} requires a proposal id`);
      const tool = {
        approve: "approve_policy_proposal",
        reject: "reject_policy_proposal",
        rebase: "rebase_policy_proposal",
      }[command];
      return print(await callRouterTool(
        tool,
        { contextId, proposalId },
        { store },
      ));
    }
    if (command === "rollback") return print(await callRouterTool("rollback_policy", { contextId }, { store }));
    if (command === "import-legacy") {
      const context = store.context({ contextId });
      return print(await importLegacySettingsAndPolicy(store, context, args.confirm));
    }
    if (command === "help" || args.help) return help();
    throw new Error(`unknown command: ${command}`);
  } finally {
    store.close();
  }
}

main().catch((error) => {
  process.stderr.write(`adaptive-model-router: ${sanitizedError(error)}\n`);
  process.exitCode = 1;
});
