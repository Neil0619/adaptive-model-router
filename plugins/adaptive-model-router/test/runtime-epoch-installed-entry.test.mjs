import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveHistoricalRuntime } from "./support/historical-runtime.mjs";
import { inspectRuntimePackage } from "../scripts/lib/runtime-package.mjs";
import { runtimeSourceDigest } from "../scripts/lib/lifecycle-qualification.mjs";
import { qualifyHostEpochPublication } from "../scripts/lib/runtime-epoch.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installed = process.env.ADAPTIVE_ROUTER_INSTALLED_EPOCH_FIXTURES;
const observability = process.env.ADAPTIVE_ROUTER_INSTALLED_OBSERVABILITY_FIXTURE;
const observabilityDigest = "168f5886af293a5a5d701fb83949accc813a84c88f16d7ee53e2c334d62d6d1a";
const diagnostics = process.env.ADAPTIVE_ROUTER_INSTALLED_DIAGNOSTICS_FIXTURE;
const diagnosticsDigest = "69425bc27ec7e7359f80c9d18f34b626d32d00be03f8a8f18da03d2f73479853";
const validation = process.env.ADAPTIVE_ROUTER_INSTALLED_VALIDATION_FIXTURE;
const validationDigest = "08a717303357af962c0c55171ab292312944ef8d135488f12d808204e016db25";
const digests = [
  "8732d9524390ff549a3e9fc616dacc41ffc7341ae8d6049ace8de0d27cc05989",
  "316a1facca3b8b1cc8f71a5da80c8e8e1d1aeb08bab5e2c5b737e16144cdc84a",
  "4b950f2687b1a8da98ce87a66a5c813a51f7ccd76c8292f7ad38e9d7862176a9",
];
let work, candidate, fingerprint;
before(() => {
  fingerprint = runtimeSourceDigest(root);
  work = realpathSync(mkdtempSync(join(tmpdir(), "router-installed-entry-")));
  cpSync(root, join(work, "candidate"), { recursive: true });
  candidate = inspectRuntimePackage(join(work, "candidate"));
});
after(() => {
  try { assert.equal(runtimeSourceDigest(root), fingerprint, "Verification source stayed fixed"); }
  finally { rmSync(work, { recursive: true, force: true }); }
});

test("old epoch entry bytes and v2 labels alone cannot admit an unreviewed package", () => {
  const archive = archiveHistoricalRuntime(resolve(root, "../.."), "fab0ff28c0462071c23ea9ebb07d20398753aecc");
  assert.equal(archive.status, 0, "The exact pre-repair source commit must remain available");
  assert.equal(spawnSync("tar", ["-xf", "-", "-C", work], { input: archive.stdout }).status, 0);
  const source = inspectRuntimePackage(join(work, "plugins/adaptive-model-router"));
  assert.ok(!digests.includes(source.digest));
  for (const cold of [false, true]) assert.throws(() => qualifyHostEpochPublication(source, candidate, { cold }),
    /unreviewed_invocation_registration/);
});

test("exact installed B, C1 and C2 qualify through real A/B writers; altered packages stay rejected", {
  skip: !installed && "Set ADAPTIVE_ROUTER_INSTALLED_EPOCH_FIXTURES to isolated copies of the three exact retained packages",
}, () => {
  for (const digest of digests) {
    const original = inspectRuntimePackage(join(installed, digest));
    assert.equal(original.digest, digest, "Fixture is the complete retained package");
    for (const cold of [false, true]) assert.ok(qualifyHostEpochPublication(original, candidate, { cold }));

    const copy = join(work, digest); cpSync(original.root, copy, { recursive: true });
    const retained = inspectRuntimePackage(copy);
    const entry = join(copy, "scripts/lib/runtime-dispatch.mjs"), bytes = readFileSync(entry);
    writeFileSync(entry, Buffer.concat([bytes, Buffer.from("\n// changed entry\n")]));
    assert.throws(() => qualifyHostEpochPublication(retained, candidate), /Runtime content integrity changed/);
    assert.throws(() => qualifyHostEpochPublication(inspectRuntimePackage(copy), candidate), /unreviewed_invocation_registration/);
    writeFileSync(entry, bytes);
    writeFileSync(join(copy, "unreviewed-release-note.txt"), "Documentation-only changes still create another immutable package.\n");
    const changed = inspectRuntimePackage(copy);
    assert.notEqual(changed.digest, original.digest);
    for (const cold of [false, true]) assert.throws(() => qualifyHostEpochPublication(changed, candidate, { cold }),
      /unreviewed_invocation_registration/);
    assert.equal(inspectRuntimePackage(original.root).digest, digest, "Retained source is never rewritten");
  }
});

test("exact approved observability entry qualifies while changed entry or package bytes stay rejected", {
  skip: !observability && "Requires an isolated copy of the exact approved observability package",
}, () => {
  const original = inspectRuntimePackage(observability);
  assert.equal(original.digest, observabilityDigest);
  for (const cold of [false, true]) assert.ok(qualifyHostEpochPublication(original, candidate, { cold }));
  const copy = join(work, "observability"); cpSync(original.root, copy, { recursive: true });
  const retained = inspectRuntimePackage(copy);
  for (const name of ["scripts/lib/runtime-dispatch.mjs", "scripts/lib/runtime-isolation.mjs", "scripts/node-launcher.mjs", "scripts/mcp-server.mjs"]) {
    const path = join(copy, name), bytes = readFileSync(path);
    writeFileSync(path, Buffer.concat([bytes, Buffer.from("\n// changed entry\n")]));
    assert.throws(() => qualifyHostEpochPublication(retained, candidate, { cold: true }), /Runtime content integrity changed/);
    for (const cold of [false, true]) assert.throws(() => qualifyHostEpochPublication(inspectRuntimePackage(copy), candidate, { cold }),
      /unreviewed_invocation_registration/);
    writeFileSync(path, bytes);
  }
  writeFileSync(join(copy, "unreviewed-release-note.txt"), "A changed package still needs an independent review.\n");
  for (const cold of [false, true]) assert.throws(() => qualifyHostEpochPublication(inspectRuntimePackage(copy), candidate, { cold }),
    /unreviewed_invocation_registration/);
  assert.equal(inspectRuntimePackage(original.root).digest, observabilityDigest);
});

test("exact installed diagnostics patch qualifies for receipt prevention; modified package cannot inherit admission", {
  skip: !diagnostics && "Requires an isolated copy of the exact installed diagnostics patch",
}, () => {
  const original = inspectRuntimePackage(diagnostics);
  assert.equal(original.digest, diagnosticsDigest);
  for (const cold of [false, true]) assert.ok(qualifyHostEpochPublication(original, candidate, { cold }));
  const copy = join(work, "diagnostics"); cpSync(original.root, copy, { recursive: true });
  const retained = inspectRuntimePackage(copy);
  for (const name of ["scripts/lib/runtime-dispatch.mjs", "scripts/lib/runtime-isolation.mjs", "scripts/node-launcher.mjs", "scripts/mcp-server.mjs"]) {
    const path = join(copy, name), bytes = readFileSync(path);
    writeFileSync(path, Buffer.concat([bytes, Buffer.from("\n// changed diagnostics entry\n")]));
    assert.throws(() => qualifyHostEpochPublication(retained, candidate, { cold: true }), /Runtime content integrity changed/);
    for (const cold of [false, true]) assert.throws(() => qualifyHostEpochPublication(inspectRuntimePackage(copy), candidate, { cold }),
      /unreviewed_invocation_registration/);
    writeFileSync(path, bytes);
  }
  writeFileSync(join(copy, "unreviewed-release-note.txt"), "Even documentation cannot inherit another package's approval.\n");
  for (const cold of [false, true]) assert.throws(() => qualifyHostEpochPublication(inspectRuntimePackage(copy), candidate, { cold }),
    /unreviewed_invocation_registration/);
  assert.equal(inspectRuntimePackage(original.root).digest, diagnosticsDigest);
});

test("exact installed validation patch qualifies for JSON classification; modified entries and packages stay rejected", {
  skip: !validation && "Requires an isolated copy of the exact installed validation patch",
}, () => {
  const original = inspectRuntimePackage(validation);
  assert.equal(original.digest, validationDigest);
  for (const cold of [false, true]) assert.ok(qualifyHostEpochPublication(original, candidate, { cold }));
  const copy = join(work, "validation"); cpSync(original.root, copy, { recursive: true });
  const retained = inspectRuntimePackage(copy);
  for (const name of ["scripts/lib/runtime-dispatch.mjs", "scripts/lib/runtime-isolation.mjs", "scripts/node-launcher.mjs", "scripts/mcp-server.mjs"]) {
    const path = join(copy, name), bytes = readFileSync(path);
    writeFileSync(path, Buffer.concat([bytes, Buffer.from("\n// changed validation entry\n")]));
    assert.throws(() => qualifyHostEpochPublication(retained, candidate, { cold: true }), /Runtime content integrity changed/);
    for (const cold of [false, true]) assert.throws(() => qualifyHostEpochPublication(inspectRuntimePackage(copy), candidate, { cold }),
      /unreviewed_invocation_registration/);
    writeFileSync(path, bytes);
  }
  writeFileSync(join(copy, "unreviewed-release-note.txt"), "A release label or matching entries cannot approve a different package.\n");
  for (const cold of [false, true]) assert.throws(() => qualifyHostEpochPublication(inspectRuntimePackage(copy), candidate, { cold }),
    /unreviewed_invocation_registration/);
  assert.equal(inspectRuntimePackage(original.root).digest, validationDigest);
});
