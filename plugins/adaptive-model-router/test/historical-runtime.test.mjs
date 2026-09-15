import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveHistoricalRuntime } from "./support/historical-runtime.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const baseline = "16c439dd0bf3657ba06707ff15c1465613d49554";

for (const autocrlf of ["true", "false"]) test(`historical archive keeps exact Git blob bytes with core.autocrlf=${autocrlf} and core.eol=crlf`, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "router-historical-bytes-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "core.autocrlf", GIT_CONFIG_VALUE_0: autocrlf,
    GIT_CONFIG_KEY_1: "core.eol", GIT_CONFIG_VALUE_1: "crlf" };
  const archive = archiveHistoricalRuntime(repository, baseline, { env });
  assert.equal(archive.status, 0, String(archive.stderr));
  const extracted = spawnSync("tar", ["-xf", "-", "-C", directory], { input: archive.stdout });
  assert.equal(extracted.status, 0, String(extracted.stderr));

  // cat-file reads raw objects, independently of checkout/archive conversion.
  // Compare every archived file, including binary fixtures, without rewriting it.
  const tree = spawnSync("git", ["ls-tree", "-rz", baseline, "--", "plugins/adaptive-model-router"],
    { cwd: repository, env, encoding: "utf8" });
  assert.equal(tree.status, 0, tree.stderr);
  const files = tree.stdout.split("\0").filter(Boolean).map((entry) => {
    const [metadata, path] = entry.split("\t");
    const [, type, oid] = metadata.split(" ");
    assert.equal(type, "blob");
    return { oid, path };
  });
  assert.ok(files.length > 0);
  const blobs = spawnSync("git", ["cat-file", "--batch"], { cwd: repository, env,
    input: files.map(({ oid }) => oid).join("\n") + "\n", maxBuffer: 32 * 1024 * 1024 });
  assert.equal(blobs.status, 0, String(blobs.stderr));
  let offset = 0;
  for (const file of files) {
    const headerEnd = blobs.stdout.indexOf(10, offset);
    assert.ok(headerEnd >= offset);
    const [oid, type, size] = blobs.stdout.subarray(offset, headerEnd).toString().split(" ");
    assert.equal(oid, file.oid); assert.equal(type, "blob");
    offset = headerEnd + 1;
    const raw = blobs.stdout.subarray(offset, offset + Number(size));
    assert.deepEqual(readFileSync(join(directory, file.path)), raw, `${file.path} changed from its frozen Git blob`);
    offset += Number(size) + 1;
  }
  assert.equal(offset, blobs.stdout.length);
});
