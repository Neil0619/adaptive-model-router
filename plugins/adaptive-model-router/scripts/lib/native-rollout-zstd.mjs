import { closeSync, fstatSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Decode in a bounded streaming process: neither compressed bombs nor a large
// historical rollout can allocate the whole expanded file in the Hook process.
// No shell, external executable, persistent cache or source-file mutation.
const decoder = `
import { createReadStream, writeSync, readSync, fstatSync } from 'node:fs';
import { createZstdDecompress, constants } from 'node:zlib';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
let size = 0;
${compressedFrames.toString()}
try {
  for (const [start, end] of compressedFrames(0, fstatSync(0).size, Number(process.argv[2]))) {
  await pipeline(createReadStream(null, { fd: 0, autoClose: false, start, end }),
    createZstdDecompress({ params: { [constants.ZSTD_d_windowLogMax]: Math.max(10, Math.min(27, Math.ceil(Math.log2(Number(process.argv[1]))))) } }),
    new Writable({ write(chunk, encoding, done) {
      size += chunk.length;
      if (size > Number(process.argv[1])) return done(new Error('native transcript exceeds evidence bounds'));
      try { let offset = 0; while (offset < chunk.length) offset += writeSync(1, chunk, offset); done(); }
      catch (error) { done(error); }
    } }));
  }
} catch (error) { process.stderr.write(error.message); process.exitCode = 1; }
`;

// Node's zstd stream currently accepts truncated frames at EOF. Validate the
// RFC 8878 frame/block boundaries first, including checksums. Decode each frame
// separately because Node can silently ignore concatenated frames. A complete
// JSON prefix must never masquerade as a complete archive.
function* compressedFrames(fd, size, deadline) {
  let position = 0, frames = 0;
  const invalid = () => { throw new Error("native compressed transcript is invalid"); };
  const skip = (length) => { position += length; if (position > size) invalid(); };
  const take = (length) => {
    if (Date.now() > deadline) throw new Error("native evidence read budget exhausted");
    const bytes = Buffer.alloc(length);
    if (position + length > size || readSync(fd, bytes, 0, length, position) !== length) invalid();
    position += length; return bytes;
  };
  while (position < size) {
    const start = position;
    const magic = take(4).readUInt32LE();
    if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) { skip(take(4).readUInt32LE()); continue; }
    if (magic !== 0xfd2fb528) invalid();
    frames++;
    const descriptor = take(1)[0], single = Boolean(descriptor & 32);
    if (descriptor & 8) invalid();
    if (!single) skip(1); // window descriptor
    skip([0, 1, 2, 4][descriptor & 3]); // dictionary ID
    skip([single ? 1 : 0, 2, 4, 8][descriptor >>> 6]); // frame content size
    let last;
    do {
      const block = take(3).readUIntLE(0, 3), kind = (block >>> 1) & 3;
      if (kind === 3) invalid();
      last = Boolean(block & 1); skip(kind === 1 ? 1 : block >>> 3);
    } while (!last);
    if (descriptor & 4) skip(4); // content checksum; libzstd verifies its value
    yield [start, position - 1];
  }
  if (!frames) invalid();
}

export function withDecodedRollout(path, { maxBytes, deadline }, read) {
  if (Date.now() > deadline) throw new Error("native evidence read budget exhausted");
  const directory = mkdtempSync(join(tmpdir(), "router-rollout-zstd-"));
  let input, output;
  try {
    input = openSync(path, "r");
    const stat = fstatSync(input, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(maxBytes)) throw new Error("native transcript exceeds evidence bounds");
    const decoded = join(directory, "decoded.jsonl");
    output = openSync(decoded, "wx", 0o600);
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", decoder, String(maxBytes), String(deadline)], {
      stdio: [input, output, "pipe"], encoding: "utf8", maxBuffer: 4096,
      timeout: Math.max(1, Math.min(30_000, deadline - Date.now())),
    });
    if (result.error?.code === "ETIMEDOUT" || Date.now() > deadline) throw new Error("native evidence read budget exhausted");
    if (result.error || result.status !== 0) throw new Error(result.stderr?.includes("exceeds evidence bounds")
      ? "native transcript exceeds evidence bounds" : "native compressed transcript is invalid");
    return read(decoded);
  } finally {
    if (output !== undefined) closeSync(output);
    if (input !== undefined) closeSync(input);
    rmSync(directory, { recursive: true, force: true });
  }
}
