import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectRuntimePackage, verifyRuntimePackage } from "./runtime-package.mjs";
import { runtimeSourceDigest } from "./lifecycle-qualification.mjs";

// Exact, already deployed epoch dispatcher reviewed with the native cold
// installation. This is a source contract, never an App version allowlist.
// Its immutable Hook entry can select a repaired engine without replacing
// the trusted shell or interrupting other tasks.
const PREVIOUS_EPOCH_SOURCE = "40189647d64b21537523eb884550db104eba4c173f52bc1a7d0eb2dd9bc2eee2";

export async function installedEpochEntry(db, shellRoot) {
  const shell = inspectRuntimePackage(shellRoot);
  const verifier = runtimeSourceDigest(shell.root);
  if (shell.descriptor.shellProtocolVersion !== 2
    || ![runtimeSourceDigest(), PREVIOUS_EPOCH_SOURCE].includes(verifier)
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
