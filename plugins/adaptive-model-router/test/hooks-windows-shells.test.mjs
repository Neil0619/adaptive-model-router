import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

test("exact Windows hook commands run through cmd.exe and Windows PowerShell", {
  skip: process.platform !== "win32" ? "Windows shell integration test" : false,
}, async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "adaptive hooks 空格 "));
  const projectCwd = join(temporaryRoot, "project cwd 项目");
  const pluginData = join(temporaryRoot, "plugin data 数据");
  await mkdir(projectCwd, { recursive: true });
  await mkdir(pluginData, { recursive: true });

  try {
    const config = JSON.parse(await readFile(join(pluginRoot, "hooks", "hooks.json"), "utf8"));
    const cases = [
      {
        event: "UserPromptSubmit",
        input: { cwd: projectCwd, session_id: "shell-prompt", model: "gpt-5.6-sol", prompt: "Inspect Unicode 中文 paths." },
      },
      {
        event: "Stop",
        input: { cwd: projectCwd, session_id: "shell-stop", stop_hook_active: false },
      },
    ];
    const shells = [
      {
        name: "cmd.exe",
        executable: "cmd.exe",
        args: (command) => ["/d", "/s", "/c", `"${command}"`],
        windowsVerbatimArguments: true,
      },
      { name: "Windows PowerShell", executable: powershell, args: (command) => ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] },
    ];

    for (const { event, input } of cases) {
      const command = config.hooks[event][0].hooks[0].commandWindows;
      for (const shell of shells) {
        const result = spawnSync(shell.executable, shell.args(command), {
          cwd: projectCwd,
          env: {
            ...process.env,
            PLUGIN_ROOT: pluginRoot,
            PLUGIN_DATA: pluginData,
            ADAPTIVE_ROUTER_LOCAL_ONLY: "1",
          },
          input: JSON.stringify(input),
          encoding: "utf8",
          windowsHide: true,
          windowsVerbatimArguments: shell.windowsVerbatimArguments,
        });
        assert.equal(result.status, 0, `${event} via ${shell.name}: ${result.stderr}`);
      }
      assert.doesNotMatch(command, /%PLUGIN_ROOT%|\$env:PLUGIN_ROOT|\$PLUGIN_ROOT/);
      assert.match(command, /process\.env\.PLUGIN_ROOT/);
      assert.match(command, /path\.join/);
      assert.match(command, /pathToFileURL/);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
