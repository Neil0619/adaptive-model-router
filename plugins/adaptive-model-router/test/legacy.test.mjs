import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RouterStore } from "../scripts/lib/database.mjs";
import { importLegacySettingsAndPolicy } from "../scripts/lib/legacy.mjs";
import { temporaryProject, withRouterEnvironment } from "./fixtures.mjs";

test("legacy import requires confirmation, imports only settings and approved policy, and excludes history from learning", async () => {
  const project = await temporaryProject();
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHome = join(project.root, "legacy-home");
  const legacy = join(codexHome, "adaptive-model-router");
  process.env.CODEX_HOME = codexHome;
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, "settings.json"), JSON.stringify({ enabled: false, globalOverride: { model: "must-not-import" } }));
  await writeFile(join(legacy, "policy.json"), JSON.stringify({ approvedProposals: ["old-approved"], categoryOffsets: { implementation: 50, review: -7 } }));
  await writeFile(join(legacy, "events.jsonl"), '{"prompt":"legacy secret prompt"}\n{"status":"failed"}\n');
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const context = store.context({ cwd: project.root, contextId: "legacy" });
      await assert.rejects(importLegacySettingsAndPolicy(store, context, "wrong"), /confirmation/);
      const imported = await importLegacySettingsAndPolicy(store, context, "IMPORT_LEGACY_SETTINGS_POLICY");
      assert.equal(imported.settingsImported, true);
      assert.equal(imported.policyImported, true);
      assert.equal(imported.historyRecordsArchived, 2);
      assert.equal(imported.historyUsedForLearning, false);
      assert.equal(store.getSettings(context).enabled, false);
      const policy = store.ensurePolicy(context);
      assert.equal(policy.categoryOffsets.implementation, 15);
      assert.equal(policy.categoryOffsets.review, -7);
      assert.equal(Number(store.db.prepare("SELECT count(*) AS count FROM outcomes").get().count), 0);
      assert.equal(Number(store.db.prepare("SELECT count(*) AS count FROM policy_proposals").get().count), 0);
      assert.equal((await importLegacySettingsAndPolicy(store, context, "IMPORT_LEGACY_SETTINGS_POLICY")).idempotent, true);
      store.close();
    });
  } finally {
    if (previousCodexHome == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await project.cleanup();
  }
});
