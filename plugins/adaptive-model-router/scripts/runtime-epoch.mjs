#!/usr/bin/env node
// Only actual package/native references are accepted. No --passed, --proof,
// --idle, --no-pending or injected input JSON can authorize a handover.
import { existsSync, realpathSync } from "node:fs";
import { resolve, join } from "node:path";
import { inspectRuntimePackage } from "./lib/runtime-package.mjs";
import { readRuntimeDescriptor } from "./lib/runtime-loader.mjs";
import { RouterStore } from "./lib/database.mjs";
import { qualifyHostEpochPublication, publishHostEpoch } from "./lib/runtime-epoch.mjs";
import { sweepHostCompatibilityEpoch, startHostCompatibilityEpochSweep, activateHostCompatibilityEpoch } from "./lib/runtime-epoch-sweep.mjs";
import { prepareColdHostEpochInstallation, inspectColdHostEpochRetirement, commitColdHostEpochRetirement,
  installColdHostEpoch, restoreColdHostEpochEntries, relocateColdHostEpochEntries } from "./lib/runtime-cold-install.mjs";
import { prepareMessageCheckpoint, commitMessageCheckpoint } from "./lib/message-checkpoint.mjs";
const [action, ...raw] = process.argv.slice(2);
const inspectSource = (root) => inspectRuntimePackage(root, { legacy: readRuntimeDescriptor(root).shellProtocolVersion === 1 });
let store;
try {
  const options = {};
  for (const option of raw) {
    const match = /^--([a-z-]+)=(.+)$/u.exec(option);
    if (!match || Object.hasOwn(options, match[1])) throw new Error("Use unique explicit --name=value references");
    options[match[1]] = match[2];
  }
  const fields = { publish: ["source", "candidate", "home", "codex-home"], activate: ["source", "candidate", "home", "codex-home", "shell-root"], sweep: ["candidate", "shell-root", "home", "codex-home"],
    watch: ["candidate", "shell-root", "home", "codex-home"],
    "prepare-cold": ["source", "candidate", "shell-root", "home", "codex-home"],
    "install-cold": ["installation", "marketplace", "home", "codex-home"],
    "retire-cold": ["installation", "home", "codex-home"],
    "restore-cold": ["installation", "home", "codex-home"],
    "checkpoint-inputs": ["context", "route", "cwd", "parent-source", "revision", "home", "codex-home"] }[action];
  if (!fields || Object.keys(options).length !== fields.length || fields.some((key) => !options[key]))
    throw new Error("activate requires source,candidate,home,codex-home,shell-root; publish omits shell-root; sweep/watch use candidate digest,shell-root,home,codex-home");
  const home = realpathSync(options.home);
  if (home !== resolve(options.home) || !existsSync(join(home, "router.sqlite3"))) throw new Error("Explicit existing nonredirected Router home required");
  process.env.ADAPTIVE_ROUTER_HOME = home; process.env.PLUGIN_DATA = home;
  process.env.CODEX_HOME = realpathSync(options["codex-home"]);
  process.env.ADAPTIVE_ROUTER_INVOCATION_ID = "";
  store = new RouterStore();
  if (action === "checkpoint-inputs") {
    const revision = Number(options.revision);
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Explicit nonnegative stage revision required");
    const context = store.context({ cwd: realpathSync(options.cwd), contextId: options.context, create: false });
    process.stdout.write(JSON.stringify(commitMessageCheckpoint(store, prepareMessageCheckpoint(store, context, {
      routeId: options.route, expectedRevision: revision, parentTranscriptPath: realpathSync(options["parent-source"]),
    }))) + "\n");
  } else if (action === "prepare-cold") {
    process.stdout.write(JSON.stringify(prepareColdHostEpochInstallation(store, { source: inspectSource(options.source),
      candidate: inspectRuntimePackage(options.candidate), shellRoot: realpathSync(options["shell-root"]) })) + "\n");
  } else if (action === "install-cold") {
    process.stdout.write(JSON.stringify(await installColdHostEpoch(store, options.installation, { marketplacePath: options.marketplace })) + "\n");
  } else if (action === "retire-cold") {
    relocateColdHostEpochEntries(store, options.installation);
    process.stdout.write(JSON.stringify(commitColdHostEpochRetirement(store, inspectColdHostEpochRetirement(store, options.installation))) + "\n");
  } else if (action === "restore-cold") {
    process.stdout.write(JSON.stringify(restoreColdHostEpochEntries(store, options.installation)) + "\n");
  } else if (action === "activate") {
    const candidate = inspectRuntimePackage(options.candidate);
    const result = await activateHostCompatibilityEpoch({ store, source: inspectSource(options.source), candidate,
      shellRoot: realpathSync(options["shell-root"]) });
    process.stdout.write(JSON.stringify({ ...result, resumeArguments: ["watch", `--candidate=${candidate.digest}`, `--home=${home}`,
      `--codex-home=${process.env.CODEX_HOME}`, `--shell-root=${realpathSync(options["shell-root"])}`] }) + "\n");
  } else if (action === "publish") {
    const token = qualifyHostEpochPublication(inspectSource(options.source), inspectRuntimePackage(options.candidate));
    process.stdout.write(JSON.stringify(publishHostEpoch(store, token)) + "\n");
  } else {
    const settings = { store, candidate: options.candidate, shellRoot: realpathSync(options["shell-root"]) };
    if (action === "sweep") process.stdout.write(JSON.stringify(await sweepHostCompatibilityEpoch(settings)) + "\n");
    else {
      const watcher = startHostCompatibilityEpochSweep(settings, { onChange: (value) => process.stdout.write(JSON.stringify(value) + "\n") });
      process.once("SIGINT", () => watcher.stop()); process.once("SIGTERM", () => watcher.stop());
      await watcher.done;
    }
  }
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
finally { store?.close(); }
