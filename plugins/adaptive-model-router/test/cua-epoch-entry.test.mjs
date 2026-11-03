import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installedEpochEntry } from "../scripts/lib/installed-epoch-entry.mjs";
import { inspectRuntimePackage } from "../scripts/lib/runtime-package.mjs";
import { runtimeSourceDigest } from "../scripts/lib/lifecycle-qualification.mjs";
test("reviewed command-cwd shell remains immutable while selecting the CUA receipt reader", {
  skip: !process.env.ADAPTIVE_ROUTER_COMMAND_CWD_FIXTURE && "Requires the exact installed command-cwd fixture",
}, async () => {
  const root = process.env.ADAPTIVE_ROUTER_COMMAND_CWD_FIXTURE;
  const shell = inspectRuntimePackage(root);
  assert.equal(shell.digest, "3c17bc11889e1b0583b7660f82b603dfc10a6abfda3c7b03a99d3c59b4bea35a");
  assert.equal(runtimeSourceDigest(root), "b1abdca1c23cd8c6fa0291f67d8f1930f5703219623fe33165c65692e95643dc");
  assert.notEqual(runtimeSourceDigest(), runtimeSourceDigest(root));
  const db = new DatabaseSync(":memory:"), work = mkdtempSync(join(tmpdir(), "router-cua-shell-"));
  try {
    db.exec("CREATE TABLE runtime_host_entries(path TEXT, generation TEXT, state TEXT)");
    await assert.rejects(installedEpochEntry(db, root), /unreviewed_installed_epoch_entry/);
    db.prepare("INSERT INTO runtime_host_entries VALUES(?,?,'referenced')").run(shell.root, shell.digest);
    const entry = await installedEpochEntry(db, root);
    assert.equal(entry.verifier, runtimeSourceDigest(root)); entry.verify();
    db.exec("UPDATE runtime_host_entries SET state='retired'");
    assert.throws(() => entry.verify(), /installed_epoch_entry_changed/);
    const copy = join(work, "changed"); cpSync(root, copy, { recursive: true });
    const file = join(copy, "scripts/lib/root-epoch-operations.mjs");
    writeFileSync(file, readFileSync(file, "utf8") + "\n// unknown source\n");
    const altered = inspectRuntimePackage(copy);
    db.prepare("INSERT INTO runtime_host_entries VALUES(?,?,'referenced')").run(altered.root, altered.digest);
    await assert.rejects(installedEpochEntry(db, copy), /unreviewed_installed_epoch_entry/);
    assert.equal(inspectRuntimePackage(root).digest, shell.digest);
  } finally { db.close(); rmSync(work, { recursive: true, force: true }); }
});
