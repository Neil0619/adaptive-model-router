import { lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";

const UUID = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const NAME = new RegExp(`^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-(${UUID})(?:_${UUID})?\\.jsonl$`, "u");
const root = () => resolve(process.env.CODEX_HOME || join(homedir(), ".codex"));

// Names only locate candidates. The consumer must still prove the complete
// native session, project, call, input and result from stable file contents.
export function isNativeSessionSource(path, sessionId) {
  if (typeof path !== "string" || NAME.exec(basename(path))?.[1] !== sessionId) return false;
  const part = relative(root(), resolve(path)).split(sep);
  return (part.length === 2 && part[0] === "archived_sessions")
    || (part.length === 5 && part[0] === "sessions" && /^\d{4}$/u.test(part[1])
      && part.slice(2, 4).every((value) => /^\d{2}$/u.test(value)));
}

export function nativeSessionSourceIndex(deadline) {
  if (!Number.isFinite(deadline)) throw new Error("native session discovery requires a finite deadline");
  const index = new Map(); let visited = 0;
  const budget = () => {
    if (++visited > 100_000 || Date.now() > deadline) throw new Error("native session discovery budget exhausted");
  };
  const walk = (directory, depth) => {
    budget();
    try {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("native session directory is not a regular directory");
    } catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      budget();
      if (depth) {
        if (!(depth === 3 ? /^\d{4}$/u : /^\d{2}$/u).test(entry.name)) continue;
        walk(join(directory, entry.name), depth - 1);
      } else {
        const owner = NAME.exec(entry.name)?.[1];
        if (!owner) continue;
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("native session candidate is not a regular file");
        if (!index.has(owner)) index.set(owner, []);
        const paths = index.get(owner);
        if (paths.length >= 256) throw new Error("native session segment count exceeds evidence bounds");
        paths.push(join(directory, entry.name));
      }
    }
  };
  walk(join(root(), "sessions"), 3);
  walk(join(root(), "archived_sessions"), 0);
  for (const paths of index.values()) paths.sort();
  return index;
}
