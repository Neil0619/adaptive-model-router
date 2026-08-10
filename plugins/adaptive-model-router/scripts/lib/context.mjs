import { createHmac } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export function stateRoot(env = process.env) {
  if (env.ADAPTIVE_ROUTER_HOME) return resolve(env.ADAPTIVE_ROUTER_HOME);
  const pluginData = env.PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA;
  if (pluginData) return resolve(pluginData);
  const codexHome = env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(homedir(), ".codex");
  return join(codexHome, "adaptive-model-router-v2");
}

export function databasePath() {
  return join(stateRoot(), "router.sqlite3");
}

function realpathOrResolve(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

export function normalizeIdentityPath(path, platform = process.platform) {
  const raw = platform === "win32" && /^[A-Za-z]:[\\/]/.test(path) ? path : realpathOrResolve(path);
  let normalized = raw.normalize("NFC").replaceAll("\\", "/");
  if (platform === "win32" && /^[A-Z]:/.test(normalized)) {
    normalized = `${normalized[0].toLowerCase()}${normalized.slice(1)}`;
  }
  return normalized.replace(/\/$/, "");
}

function gitCommonDirectoryFromMetadata(workingDirectory) {
  let cursor = workingDirectory;
  while (true) {
    const marker = join(cursor, ".git");
    try {
      const metadata = statSync(marker);
      if (metadata.isDirectory()) return realpathOrResolve(marker);
      if (metadata.isFile()) {
        const match = /^gitdir:\s*(.+)$/iu.exec(readFileSync(marker, "utf8").trim());
        if (!match) return null;
        const gitDirectory = isAbsolute(match[1]) ? match[1] : resolve(cursor, match[1]);
        try {
          const common = readFileSync(join(gitDirectory, "commondir"), "utf8").trim();
          return realpathOrResolve(resolve(gitDirectory, common));
        } catch {
          return realpathOrResolve(gitDirectory);
        }
      }
      return null;
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") return null;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

export function projectIdentityMaterial(cwd = process.cwd()) {
  const workingDirectory = realpathOrResolve(cwd);
  const metadataDirectory = gitCommonDirectoryFromMetadata(workingDirectory);
  if (metadataDirectory) return `git:${normalizeIdentityPath(metadataDirectory)}`;
  const result = spawnSync("git", ["-C", workingDirectory, "rev-parse", "--git-common-dir"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 2_000,
  });
  if (result.status === 0 && String(result.stdout).trim()) {
    const raw = String(result.stdout).trim();
    const commonDirectory = isAbsolute(raw) ? raw : resolve(workingDirectory, raw);
    return `git:${normalizeIdentityPath(commonDirectory)}`;
  }
  return `cwd:${normalizeIdentityPath(workingDirectory)}`;
}

export function opaqueId(salt, namespace, value) {
  return createHmac("sha256", salt).update(`${namespace}\0${value}`).digest("hex");
}

export function legacyStatePresent() {
  const codexHome = process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), ".codex");
  const legacyRoot = join(codexHome, "adaptive-model-router");
  return ["settings.json", "policy.json", "history.jsonl", "outcomes.jsonl", "overrides.json"]
    .some((name) => existsSync(join(legacyRoot, name)));
}
