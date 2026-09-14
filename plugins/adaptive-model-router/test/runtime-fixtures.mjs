import { resolve, join } from "node:path";
import { RouterStore } from "../scripts/lib/database.mjs";
import { inspectRuntimePackage } from "../scripts/lib/runtime-package.mjs";
import { acquireRuntimeInvocation, ensureRuntimeTask, publishRuntime, publishedDefault } from "../scripts/lib/runtime-isolation.mjs";

// Offline fixtures enroll a real immutable package before any task or stage is
// created. Production enrollment instead uses runtime-admin's cold inspector.
export function enrollRuntimeFixture({ home, shellRoot, cwd, contextId = null, store = null, lease = false }) {
  const owned = !store;
  store ||= new RouterStore({ path: join(home, "router.sqlite3") });
  try {
    const candidate = inspectRuntimePackage(resolve(shellRoot));
    return store.transaction(() => {
      if (!publishedDefault(store.db)) publishRuntime(store.db, candidate, home, { bootstrap: true, shellRoot: candidate.root });
      if (!contextId) return;
      const context = store.context({ cwd, contextId, authoritative: true });
      ensureRuntimeTask(store.db, context, { trustedHook: true });
      if (lease) store.runtimeInvocation = acquireRuntimeInvocation(store.db, context, { kind: "offline-fixture" }).invocation;
      return context;
    });
  } finally { if (owned) store.close(); }
}
