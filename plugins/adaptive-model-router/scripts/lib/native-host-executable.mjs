import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, isAbsolute } from "node:path";
import { resolveCodexCommand } from "./codex-command.mjs";

function readMacProcess(pid) {
  const result = spawnSync("/bin/ps", ["-ww", "-p", String(pid), "-o", "ppid=,comm="], {
    encoding: "utf8", timeout: 1_000, maxBuffer: 8_192,
  });
  const match = /^\s*(\d+)\s+([^\r\n]+)\s*$/u.exec(result.stdout || "");
  if (result.error || result.status !== 0 || !match) return null;
  return { pid, parentPid: Number(match[1]), executable: match[2].trim() };
}

// Qualification attests the host that actually owns this process. PATH can
// still point to a separately installed, older CLI after a Desktop upgrade.
// General command discovery remains unchanged for installers and CLI callers.
export async function resolveNativeCodexCommand({
  platform = process.platform, parentPid = process.ppid,
  readProcess = readMacProcess, resolveCommand = resolveCodexCommand,
  requireAncestor = false,
} = {}) {
  if (platform === "darwin") {
    const seen = new Set();
    for (let depth = 0; parentPid > 1 && depth < 8; depth++) {
      if (!Number.isSafeInteger(parentPid) || seen.has(parentPid)) throw new Error("native host ancestry is unproven");
      seen.add(parentPid);
      const current = readProcess(parentPid);
      if (!current || current.pid !== parentPid || !Number.isSafeInteger(current.parentPid)
        || current.parentPid < 0 || typeof current.executable !== "string") {
        throw new Error("native host ancestry is unavailable");
      }
      if (basename(current.executable) === "codex") {
        if (!isAbsolute(current.executable)) throw new Error("native host executable is not absolute");
        const path = realpathSync(current.executable);
        const repeated = readProcess(parentPid);
        if (!repeated || repeated.pid !== current.pid || repeated.parentPid !== current.parentPid
          || repeated.executable !== current.executable) throw new Error("native host ancestry changed");
        return { path, kind: "direct" };
      }
      parentPid = current.parentPid;
    }
    if (parentPid > 1) throw new Error("native host ancestry exceeds its bound");
  }
  if (requireAncestor) throw new Error("native owning host is unproven");
  return resolveCommand();
}

export async function attestNativeCodexHost({ requireAncestor = false } = {}) {
  const command = await resolveNativeCodexCommand({ requireAncestor });
  if (command.kind !== "direct") throw new Error("native host requires a directly verifiable executable");
  const path = realpathSync(command.path);
  const result = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 3_000, maxBuffer: 1024, windowsHide: true });
  const version = /^codex-cli (\S+)\s*$/u.exec(result.stdout || "")?.[1];
  if (result.error || result.status !== 0 || !version) throw new Error("native host version is unproven");
  const sha = (value) => createHash("sha256").update(value).digest("hex");
  return { platform: process.platform, arch: process.arch, cliVersion: version,
    executableDigest: sha(readFileSync(path)), executablePathDigest: sha(JSON.stringify(path)) };
}
