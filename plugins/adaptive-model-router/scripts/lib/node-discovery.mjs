import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { MIN_NODE } from "./constants.mjs";

export function nodeVersionTuple(version) {
  return String(version).trim().replace(/^v/i, "").split(".").slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
}

export function supportsNodeRuntime(version) {
  const current = nodeVersionTuple(version);
  for (let index = 0; index < MIN_NODE.length; index += 1) {
    if (current[index] > MIN_NODE[index]) return true;
    if (current[index] < MIN_NODE[index]) return false;
  }
  return true;
}

function versionOrder(left, right) {
  const leftParts = nodeVersionTuple(left);
  const rightParts = nodeVersionTuple(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return rightParts[index] - leftParts[index];
  }
  return 0;
}

function versionDirectories(root, readDirectory = readdirSync) {
  try {
    return readDirectory(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(versionOrder);
  } catch {
    return [];
  }
}

function pushCandidate(result, seen, candidate, platform) {
  if (typeof candidate !== "string" || candidate.length === 0) return;
  const key = platform === "win32" ? candidate.toLowerCase() : candidate;
  if (seen.has(key)) return;
  seen.add(key);
  result.push(candidate);
}

export function runtimeCandidates({
  env = process.env,
  platform = process.platform,
  userHome = homedir(),
  currentExecutable = process.execPath,
  readDirectory = readdirSync,
} = {}) {
  const result = [];
  const seen = new Set();
  const paths = platform === "win32" ? win32 : posix;
  const executable = platform === "win32" ? "node.exe" : "node";
  const add = (candidate) => pushCandidate(result, seen, candidate, platform);

  add(env.ADAPTIVE_ROUTER_NODE);
  add(currentExecutable);
  for (const directory of String(env.PATH || "").split(paths.delimiter).filter(Boolean)) {
    add(paths.join(directory, executable));
  }

  if (platform === "win32") {
    add(env.NVM_SYMLINK && paths.join(env.NVM_SYMLINK, executable));
    add(env.NVM_HOME && paths.join(env.NVM_HOME, executable));
    for (const root of [env.NVM_HOME, env.APPDATA && paths.join(env.APPDATA, "nvm")].filter(Boolean)) {
      for (const version of versionDirectories(root, readDirectory)) add(paths.join(root, version, executable));
    }
    add(env.ProgramFiles && paths.join(env.ProgramFiles, "nodejs", executable));
    add(env["ProgramFiles(x86)"] && paths.join(env["ProgramFiles(x86)"], "nodejs", executable));
  } else {
    const nvmRoots = [env.NVM_DIR, paths.join(userHome, ".nvm")].filter(Boolean);
    for (const root of nvmRoots) {
      const versionsRoot = paths.join(root, "versions", "node");
      for (const version of versionDirectories(versionsRoot, readDirectory)) {
        add(paths.join(versionsRoot, version, "bin", executable));
      }
    }

    const fnmRoots = [
      env.FNM_DIR,
      paths.join(userHome, ".local", "share", "fnm"),
      paths.join(userHome, "Library", "Application Support", "fnm"),
    ].filter(Boolean);
    add(env.FNM_MULTISHELL_PATH && paths.join(env.FNM_MULTISHELL_PATH, "bin", executable));
    for (const root of fnmRoots) {
      const versionsRoot = paths.join(root, "node-versions");
      for (const version of versionDirectories(versionsRoot, readDirectory)) {
        add(paths.join(versionsRoot, version, "installation", "bin", executable));
      }
    }

    add(env.VOLTA_HOME && paths.join(env.VOLTA_HOME, "bin", executable));
    add(paths.join(userHome, ".volta", "bin", executable));
    add(paths.join(userHome, ".asdf", "shims", executable));
    add(`/opt/homebrew/opt/node@24/bin/${executable}`);
    add(`/usr/local/opt/node@24/bin/${executable}`);
    add(`/opt/homebrew/bin/${executable}`);
    add(`/usr/local/bin/${executable}`);
    add(`/usr/bin/${executable}`);
  }

  return result;
}

export function probeNode(candidate) {
  const result = spawnSync(candidate, ["--version"], {
    encoding: "utf8",
    timeout: 3_000,
    windowsHide: true,
    shell: false,
  });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || "").trim() || null;
}

export function discoverNodeRuntime(options = {}) {
  const currentExecutable = options.currentExecutable || process.execPath;
  const currentVersion = options.currentVersion || process.versions.node;
  const probe = options.probe || probeNode;
  for (const candidate of runtimeCandidates({ ...options, currentExecutable })) {
    const version = candidate === currentExecutable ? currentVersion : probe(candidate);
    if (version && supportsNodeRuntime(version)) return { executable: candidate, version };
  }
  return null;
}
