import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectRuntimePackage, verifyRuntimePackage } from "./runtime-package.mjs";
import { runtimeSourceDigest } from "./lifecycle-qualification.mjs";

// Exact, already deployed epoch dispatcher reviewed with the native cold
// installation. This is a source contract, never an App version allowlist.
// Its immutable Hook entry can select a repaired engine without replacing
// the trusted shell or interrupting other tasks.
const PREVIOUS_EPOCH_SOURCES = new Set([
  "40189647d64b21537523eb884550db104eba4c173f52bc1a7d0eb2dd9bc2eee2",
  // Exact Windows cold shell before PowerShell terminal reconciliation. Its
  // dispatcher is unchanged; its retained verifier still owns retirement.
  "99fe61db6fb98666523db63095bc5869c591d7429eb0b2cf176a3fab5edcfdcc",
]);

export async function installedEpochEntry(db, shellRoot) {
  const shell = inspectRuntimePackage(shellRoot);
  const verifier = runtimeSourceDigest(shell.root);
  if (shell.descriptor.shellProtocolVersion !== 2
    || (verifier !== runtimeSourceDigest() && !PREVIOUS_EPOCH_SOURCES.has(verifier))
    || !db.prepare("SELECT 1 FROM runtime_host_entries WHERE path=? AND generation=? AND state='referenced'").get(shell.root, shell.digest)) {
    throw new Error("Host compatibility epoch blocked: unreviewed_installed_epoch_entry");
  }
  // The original verifier owns its original retirement receipt and fingerprint.
  // Re-run that exact retained code; never rewrite its receipt to this release's
  // fingerprint, and never interpret a newer recovery as an active retirement.
  const original = await import(pathToFileURL(join(shell.root, "scripts/lib/runtime-cold-install.mjs")));
  return { shell, verifier, verify() {
    verifyRuntimePackage(shell);
    if (!db.prepare("SELECT 1 FROM runtime_host_entries WHERE path=? AND generation=? AND state='referenced'").get(shell.root, shell.digest)) {
      throw new Error("Host compatibility epoch blocked: installed_epoch_entry_changed");
    }
  }, assertRetirement(source) {
    verifyRuntimePackage(shell);
    return original.assertColdEpochRetirement(db, source, shell.digest);
  } };
}
