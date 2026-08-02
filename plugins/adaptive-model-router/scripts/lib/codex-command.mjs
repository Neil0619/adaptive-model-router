import { execFile, spawnSync } from "node:child_process";
import { access, constants as fsConstants } from "node:fs/promises";
import { accessSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAC_BINARIES = [
  "/Applications/Codex.app/Contents/Resources/codex",
  "/Applications/ChatGPT.app/Contents/Resources/codex",
];
const WINDOWS_BINARIES = ["codex.cmd", "codex.exe", "codex.bat"];

function windowsKind(path) {
  return /\.(?:cmd|bat)$/i.test(path) ? "cmd" : "direct";
}

function firstOutputLine(stdout) {
  return String(stdout).split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
}

async function executable(path) {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableSync(path) {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveCodexCommand({ platform = process.platform, env = process.env } = {}) {
  if (env.CODEX_BIN) return { path: env.CODEX_BIN, kind: platform === "win32" ? windowsKind(env.CODEX_BIN) : "direct" };
  if (platform === "darwin") {
    for (const path of MAC_BINARIES) if (await executable(path)) return { path, kind: "direct" };
  }
  if (platform === "win32") {
    for (const name of WINDOWS_BINARIES) {
      try {
        const { stdout } = await execFileAsync("where.exe", [name], { env, windowsHide: true, timeout: 2_000 });
        const candidate = firstOutputLine(stdout);
        if (candidate) return { path: candidate, kind: windowsKind(candidate) };
      } catch {
        // Try the next directly runnable Windows command.
      }
    }
    return { path: "codex.exe", kind: "direct" };
  }
  return { path: "codex", kind: "direct" };
}

export function resolveCodexCommandSync({ platform = process.platform, env = process.env } = {}) {
  if (env.CODEX_BIN) return { path: env.CODEX_BIN, kind: platform === "win32" ? windowsKind(env.CODEX_BIN) : "direct" };
  if (platform === "darwin") {
    for (const path of MAC_BINARIES) if (executableSync(path)) return { path, kind: "direct" };
  }
  if (platform === "win32") {
    for (const name of WINDOWS_BINARIES) {
      const result = spawnSync("where.exe", [name], {
        encoding: "utf8",
        env,
        timeout: 2_000,
        windowsHide: true,
      });
      if (result.status !== 0) continue;
      const candidate = firstOutputLine(result.stdout);
      if (candidate) return { path: candidate, kind: windowsKind(candidate) };
    }
    return { path: "codex.exe", kind: "direct" };
  }
  return { path: "codex", kind: "direct" };
}

function quoteCmd(value) {
  const escaped = String(value).replaceAll("%", "%%").replaceAll("^", "^^").replaceAll('"', '""');
  return `"${escaped}"`;
}

export function spawnSpec(resolved, args, env = process.env) {
  if (resolved.kind !== "cmd") return { command: resolved.path, args, windowsVerbatimArguments: false };
  const commandLine = [quoteCmd(resolved.path), ...args.map(quoteCmd)].join(" ");
  return {
    command: env.ComSpec || env.COMSPEC || "cmd.exe",
    args: ["/d", "/v:off", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}
