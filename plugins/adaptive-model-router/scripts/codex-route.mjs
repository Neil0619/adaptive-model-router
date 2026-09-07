#!/usr/bin/env node
import { sanitizedError } from "./lib/io.mjs";
import { assertRuntime } from "./lib/runtime.mjs";
import { readFile } from "node:fs/promises";

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
  node scripts/codex-route.mjs hook-doctor [--context ID] [--turn ID] [--global]
  node scripts/codex-route.mjs status [--context ID]
  node scripts/codex-route.mjs history [--context ID] [--limit 20] [--action all|delegate|continue|ask_user]
  node scripts/codex-route.mjs catalog
  node scripts/codex-route.mjs model-policy [--context ID]
  node scripts/codex-route.mjs model-target --purpose smoke|qualification
  node scripts/codex-route.mjs model-preview POLICY.json [--context ID]
  node scripts/codex-route.mjs model-activate POLICY.json --expected DIGEST --confirm ACTIVATE_MODEL_POLICY [--context ID]
  node scripts/codex-route.mjs model-rollback --expected DIGEST --confirm ROLLBACK_MODEL_POLICY [--context ID]
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
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "doctor";
  if (command === "hook-doctor") {
    const { readHookIdentityDiagnostic } = await import("./lib/hook-diagnostics.mjs");
    return print(readHookIdentityDiagnostic(process.env, {
      contextId: args.global ? null : args.context || process.env.CODEX_THREAD_ID,
      turnId: args.turn,
    }));
  }
  const [{ getModelCatalog }, { RouterStore }, { importLegacySettingsAndPolicy }, { callRouterTool }] = await Promise.all([
    import("./lib/catalog.mjs"),
    import("./lib/database.mjs"),
    import("./lib/legacy.mjs"),
    import("./lib/service.mjs"),
  ]);
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
    if (command === "model-policy") return print(await callRouterTool("get_model_policy", { contextId }, { store }));
    if (command === "model-target") {
      if (!["smoke", "qualification"].includes(args.purpose)) throw new Error("model-target requires --purpose smoke|qualification");
      const { withAppServer } = await import("./lib/app-server.mjs");
      const { normalizeCatalog } = await import("./lib/catalog.mjs");
      const { resolveModelTarget } = await import("./lib/model-policy.mjs");
      const { readModelPolicy } = await import("./lib/model-policy-store.mjs");
      const catalog = normalizeCatalog(await withAppServer((client) => client.listModels()));
      const selected = resolveModelTarget({ policy: readModelPolicy(store.db), catalog, purpose: args.purpose });
      if (!selected.target) throw new Error(selected.reason);
      return print(selected.target);
    }
    if (["model-preview", "model-activate", "model-rollback"].includes(command)) {
      const toolArgs = { contextId };
      if (command !== "model-rollback") {
        if (!args._[1]) throw new Error(`${command} requires a policy file`);
        toolArgs.definition = JSON.parse(await readFile(args._[1], "utf8"));
      }
      if (command !== "model-preview") {
        toolArgs.expectedDigest = args.expected;
        toolArgs.confirm = args.confirm;
      }
      const name = { "model-preview": "preview_model_policy", "model-activate": "activate_model_policy", "model-rollback": "rollback_model_policy" }[command];
      return print(await callRouterTool(name, toolArgs, { store }));
    }
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
