import test from "node:test";
import assert from "node:assert/strict";
import { parseHookNodeCommand, renderHookNodeCommand, windowsPowerShellCommand } from "../scripts/lib/hook-command.mjs";

const suffix = ' -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))"';

test("materialized Windows Hook preserves literal Node paths across both shell grammars", () => {
  for (const executable of ["C:\\Program Files\\nodejs\\node.exe", "C:\\用户 空格\\O'Brien $node (24)\\node.exe"]) {
    const command = renderHookNodeCommand(executable, suffix, { platform: "win32" });
    assert.ok(command.startsWith(`${windowsPowerShellCommand()} -NoLogo -NoProfile -NonInteractive -EncodedCommand `));
    assert.deepEqual(parseHookNodeCommand(command), { executable, suffix, windowsEncoded: true });
    assert.equal(renderHookNodeCommand(parseHookNodeCommand(command).executable, suffix, { platform: "win32" }), command);
  }
});

test("Hook normalization keeps legacy Node shells compatible without admitting another launcher", () => {
  for (const command of [`node${suffix}`, `"C:\\Program Files\\nodejs\\node.exe"${suffix}`]) {
    assert.equal(parseHookNodeCommand(command).suffix, suffix);
    assert.equal(parseHookNodeCommand(command).windowsEncoded, false);
  }
  const valid = renderHookNodeCommand("C:\\Program Files\\nodejs\\node.exe", suffix, { platform: "win32" });
  assert.throws(() => parseHookNodeCommand(valid.replace(windowsPowerShellCommand(), "C:\\untrusted\\powershell.exe")), /system PowerShell/u);
  assert.throws(() => parseHookNodeCommand(`${valid}; echo injected`), /encoding/u);
  const badScript = Buffer.from("& 'C:\\untrusted\\other.exe' -e anything", "utf16le").toString("base64");
  assert.throws(() => parseHookNodeCommand(valid.replace(/\S+$/u, badScript)), /absolute Node/u);
  assert.throws(() => renderHookNodeCommand("node", suffix, { platform: "win32" }), /absolute/u);
});
