import { access, constants as fsConstants } from "node:fs/promises";
import { accessSync } from "node:fs";
import { delimiter, dirname, resolve, win32 } from "node:path";

const MAC_BINARIES = [
  "/Applications/Codex.app/Contents/Resources/codex",
  "/Applications/ChatGPT.app/Contents/Resources/codex",
];
// Prefer the native executable (including Desktop's bundled CLI) over an npm
// shim that may run an older host with different Hook and transcript contracts.
// An explicit CODEX_BIN still takes precedence.
const WINDOWS_BINARIES = ["codex.exe", "codex.cmd", "codex.bat"];

function windowsKind(path) {
  return /\.(?:cmd|bat)$/i.test(path) ? "cmd" : "direct";
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
      // where.exe uses the console code page, which corrupts Unicode paths
      // when decoded as UTF-8. Inspect PATH entries through the filesystem.
      for (const path of pathCandidates(env, name)) {
        if (await executable(path)) return { path, kind: windowsKind(path) };
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
      for (const path of pathCandidates(env, name)) {
        if (executableSync(path)) return { path, kind: windowsKind(path) };
      }
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
  // A batch file found by PATH receives only its basename as %0, so wrappers
  // that use %~dp0 (including npm's codex.cmd) resolve files from the caller's
  // working directory. Ask cmd.exe to expand the fixed, allow-listed basename
  // through PATH first. This preserves the caller cwd without embedding an
  // environment-selected absolute path in the command line.
  const commandLine = [
    `for %I in (${executable}) do @"%~$PATH:I"`,
    ...args.map(quoteCmd),
  ].join(" ");
  return {
    command: "cmd.exe",
    args: ["/d", "/v:off", "/s", "/c", `"${commandLine}"`],
    env: childEnv,
    windowsVerbatimArguments: true,
  };
}
