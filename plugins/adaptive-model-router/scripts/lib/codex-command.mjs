import { execFile, spawnSync } from "node:child_process";
import { access, constants as fsConstants } from "node:fs/promises";
import { accessSync } from "node:fs";
import { delimiter, dirname, resolve, win32 } from "node:path";
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

function pathCandidates(env, name) {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  if (!pathKey || !env[pathKey]) return [];
  return String(env[pathKey]).split(delimiter).filter(Boolean).map((directory) => resolve(directory, name));
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
    for (const path of pathCandidates(env, "codex")) if (await executable(path)) return { path, kind: "direct" };
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
    for (const path of pathCandidates(env, "codex")) if (executableSync(path)) return { path, kind: "direct" };
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

function portableBasename(path) {
  return String(path).replaceAll("\\", "/").split("/").at(-1).toLowerCase();
}

function commandEnvironment(resolved, env) {
  const next = { ...env };
  const pathKey = Object.keys(next).find((key) => key.toLowerCase() === "path") || "PATH";
  const windowsPath = /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(resolved.path) && win32.isAbsolute(resolved.path);
  const directory = windowsPath ? win32.dirname(resolved.path) : dirname(resolved.path);
  if (directory && directory !== ".") {
    const separator = windowsPath ? ";" : delimiter;
    next[pathKey] = [directory, next[pathKey] || ""].filter(Boolean).join(separator);
  }
  return next;
}

export function spawnSpec(resolved, args, env = process.env) {
  const executable = portableBasename(resolved.path);
  const allowed = resolved.kind === "cmd"
    ? ["codex.cmd", "codex.bat"]
    : ["codex", "codex.exe"];
  if (!allowed.includes(executable)) throw new Error("resolved Codex command has an unexpected executable name");
  const childEnv = commandEnvironment(resolved, env);
  if (resolved.kind !== "cmd") {
    return { command: executable, args, env: childEnv, windowsVerbatimArguments: false };
  }
  const commandLine = [quoteCmd(executable), ...args.map(quoteCmd)].join(" ");
  return {
    command: "cmd.exe",
    args: ["/d", "/v:off", "/s", "/c", `"${commandLine}"`],
    env: childEnv,
    windowsVerbatimArguments: true,
  };
}
