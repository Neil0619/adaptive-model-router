import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const [boundary, encodedInput, releasePath] = process.argv.slice(2);
const input = JSON.parse(encodedInput);
const waitArray = new Int32Array(new SharedArrayBuffer(4));
let waiting = false;
function barrier() {
  if (waiting) return;
  waiting = true;
  process.stdout.write("ready\n");
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(releasePath)) {
    if (Date.now() >= deadline) throw new Error("diagnostic test barrier timed out");
    Atomics.wait(waitArray, 0, 0, 5);
  }
}
if (boundary === "size") {
  const original = fs.fstatSync;
  fs.fstatSync = (...args) => {
    const snapshot = original(...args);
    barrier();
    return snapshot;
  };
} else if (boundary === "write") {
  const original = fs.writeSync;
  fs.writeSync = (...args) => {
    barrier();
    return original(...args);
  };
} else {
  throw new Error("unknown diagnostic test boundary");
}
syncBuiltinESMExports();
const { createLifecycleDiagnostic } = await import("../scripts/lib/lifecycle-diagnostics.mjs");
const trace = createLifecycleDiagnostic(input, "subagent-start");
if (boundary === "write") trace("result", { claimed: true });
