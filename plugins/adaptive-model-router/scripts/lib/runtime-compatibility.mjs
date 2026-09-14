import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyRuntimePackage } from "./runtime-package.mjs";

const proofs = new WeakMap();
// The verifier belongs to the enrolled shell, not the candidate. It invokes
// real A/B writers in an empty disposable home; caller supplied "passed" flags,
// matching schema numbers and candidate-owned test scripts grant nothing.
export function qualifyRuntimeCompatibility(source, candidate, { coldLegacy = false } = {}) {
  verifyRuntimePackage(source); verifyRuntimePackage(candidate);
  // The cold bridge also checks the real dispatch mapping: qualifying writers
  // at known paths cannot authorize execution through a different entrypoint.
  if (Object.keys(source.descriptor.entrypoints).some((name) => source.descriptor.entrypoints[name] !== candidate.descriptor.entrypoints[name])) {
    throw new Error("Runtime entrypoint mapping requires a separate compatibility epoch");
  }
  // Exact installed v1, copied and checked against the 2026-09-12 production
  // baseline (143 files). A schema label or caller-chosen legacy package is
  // not an admission grant. Expanding this reviewed list needs new evidence.
  if (coldLegacy && source.digest !== "9d23b8ae47f6d9bd6b388a33b75c7f94741546116efa29d3e33d9ebc72a1c9b2") {
    throw new Error("Legacy runtime is outside the reviewed exact installed baseline");
  }
  if (coldLegacy && !readFileSync(join(source.root, "scripts/hook.mjs")).equals(readFileSync(join(candidate.root, "scripts/hook.mjs")))) {
    throw new Error("The cold bridge freezes installed Hook behavior; changed Hook code needs separate native interoperability evidence");
  }
  if (coldLegacy && (source.descriptor.shellProtocolVersion !== 1 || candidate.descriptor.shellProtocolVersion !== 2
    || source.descriptor.storageContractVersion !== candidate.descriptor.storageContractVersion
    || source.descriptor.databaseVersion !== candidate.descriptor.databaseVersion)) throw new Error("Unsupported legacy storage boundary");
  if (!coldLegacy && (source.writerDigest !== candidate.writerDigest || source.shellDigest !== candidate.shellDigest)) {
    throw new Error("Unproven writer/shell change requires a separate compatibility epoch");
  }
  const temporary = mkdtempSync(join(tmpdir(), "router-writer-qualification-"));
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../verify-runtime-compatibility.mjs", import.meta.url)),
      source.root, candidate.root, temporary], { encoding: "utf8", timeout: 45_000, windowsHide: true,
      env: { ...process.env, ADAPTIVE_ROUTER_HOME: join(temporary, "state"), CODEX_HOME: join(temporary, "codex"),
        PLUGIN_DATA: join(temporary, "state"), ADAPTIVE_ROUTER_LOCAL_ONLY: "1", ADAPTIVE_ROUTER_INVOCATION_ID: "" } });
    if (result.error || result.status !== 0) throw new Error(`Shared-writer qualification failed: ${String(result.stderr || result.error?.message).slice(-1200)}`);
    verifyRuntimePackage(source); verifyRuntimePackage(candidate);
    const proof = Object.freeze({ source: source.digest, candidate: candidate.digest, coldLegacy, suite: "alternating-concurrent-stages/2" });
    proofs.set(proof, [source.digest, candidate.digest, coldLegacy]);
    return proof;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
export function validRuntimeCompatibility(proof, source, candidate, coldLegacy = false) {
  const pair = proof && proofs.get(proof);
  return pair?.[0] === source && pair?.[1] === candidate && pair?.[2] === coldLegacy;
}
