import { spawnSync } from "node:child_process";

export function archiveHistoricalRuntime(repository, revision, { env = process.env } = {}) {
  // git archive also applies core.autocrlf. Frozen runtime hashes bind the Git
  // bytes, not a Windows working-tree representation; never normalize afterward.
  return spawnSync("git", ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "archive", revision, "plugins/adaptive-model-router"],
    { cwd: repository, env, maxBuffer: 32 * 1024 * 1024 });
}
