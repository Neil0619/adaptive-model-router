import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectLifecycleHookReadiness } from "./hook-readiness.mjs";
import { supportsResidencyHookMatcherUpgrade } from "./installation-surface.mjs";
import { payloadHash } from "./io.mjs";
import { inspectRuntimePackage, verifyRuntimePackage } from "./runtime-package.mjs";

// This only recognizes the two exact launcher arguments materialized by
// prepareRuntimeHostEntry. Node, mode, matcher, timeout and all other fields
// still have to match. It never rewrites the native inventory or grants trust.
export function equivalentMaterializedHookEntries(previous, current, shellRoot) {
  const materialize = (entries) => entries.map((entry) => ({ ...entry,
    command: entry.command.replaceAll('"$PLUGIN_ROOT/scripts/node-launcher.mjs"', `"${shellRoot}/scripts/node-launcher.mjs"`)
      .replaceAll('"$PLUGIN_ROOT/scripts/hook.mjs"', `"${shellRoot}/scripts/hook.mjs"`),
  }));
  const before = materialize(previous), after = materialize(current);
  return payloadHash(before) === payloadHash(after) || supportsResidencyHookMatcherUpgrade(before, after);
}

// Readiness runs at the stable host boundary, but proof storage, source digest
// and final outcome must belong to the selected immutable runtime. Calling the
// legacy inspector directly compares its template with the materialized shell
// and rejects every previously qualified legacy task after the first cutover.
// This adapter preserves actual host evidence and asks that same runtime for a
// fresh no-tool qualification; it does not copy or mint a passed proof.
export function createRuntimeLifecycleProbe(runtime, shellRoot, { inspect = inspectLifecycleHookReadiness } = {}) {
  return async (options) => {
    verifyRuntimePackage(runtime);
    const registered = options.store.db.prepare("SELECT record FROM runtime_generations WHERE digest=? AND state='published'")
      .get(runtime.digest);
    if (!registered || JSON.parse(registered.record).root !== runtime.root) throw new Error("Lifecycle runtime is not the selected published package");
    const lifecycle = await import(pathToFileURL(join(runtime.root, "scripts/lib/lifecycle-qualification.mjs")));
    const shell = inspectRuntimePackage(shellRoot);
    // Unmaterialized, explicitly enrolled shells remain useful for isolated
    // fixtures. They get no command-equivalence exception.
    if (!existsSync(join(shell.root, "runtime-host.json"))) return inspect({ ...options, pluginRoot: shell.root,
      lifecycle, nativeHost: lifecycle.nativeQualificationHost });
    const host = JSON.parse(readFileSync(join(shell.root, "runtime-host.json"), "utf8"));
    if (realpathSync(host.shellRoot) !== shell.root || !options.store.db.prepare(
      "SELECT 1 FROM runtime_host_entries WHERE path=? AND generation=? AND state='referenced'")
      .get(shell.root, shell.digest)) throw new Error("Materialized lifecycle shell is not enrolled");
    // A transport-only repair may keep the exact old Hook command and its
    // trusted shell. Its dependency is explicit, registered and byte-verified;
    // the transport directory must never impersonate the executing Hook root.
    const hookRoot = host.hookShellRoot ? realpathSync(host.hookShellRoot) : shell.root;
    if (hookRoot !== shell.root) {
      const hookShell = inspectRuntimePackage(hookRoot);
      if (!options.store.db.prepare("SELECT 1 FROM runtime_host_entries WHERE path=? AND generation=? AND state='referenced'")
        .get(hookRoot, hookShell.digest)
        || !readFileSync(join(shell.root, "hooks/hooks.json")).equals(readFileSync(join(hookRoot, "hooks/hooks.json")))) {
        throw new Error("Retained Hook shell dependency is not exactly proven");
      }
    }
    const retainedShellRoots = options.store.db.prepare("SELECT path FROM runtime_host_entries WHERE state='referenced'")
      .all().map((row) => row.path);
    return inspect({ ...options, pluginRoot: hookRoot,
      lifecycle, nativeHost: lifecycle.nativeQualificationHost,
      retainedShellRoots,
      equivalentEntries: (previous, current) => equivalentMaterializedHookEntries(previous, current, hookRoot),
    });
  };
}

export async function inspectRuntimeQualification(runtime, shellRoot, { store, contextId, cwd = process.cwd() }) {
  const context = { ...store.context({ cwd, contextId }), runtimeDigest: runtime.digest };
  const readiness = await createRuntimeLifecycleProbe(runtime, shellRoot)({ store, contextId, cwd, context });
  const lifecycle = await import(pathToFileURL(join(runtime.root, "scripts/lib/lifecycle-qualification.mjs")));
  return { ready: readiness.ready === true,
    qualification: typeof lifecycle.verifiedRuntimeQualification === "function"
      ? lifecycle.verifiedRuntimeQualification(store.db, context) : null };
}
