import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  auditNativeLifecycleTranscript,
  auditNativeLifecycle1533Transcript,
  auditNativeLifecycle1534Transcript,
  auditNativeLifecycle1540Alpha62Transcript,
  auditNativeRecoveryTranscript,
  readNativeRecoveryTranscript,
} from "./native-recovery-audit.mjs";

const AUDITORS = Object.freeze({
  "0.153.0-alpha.5": auditNativeRecoveryTranscript,
  "0.153.0": auditNativeLifecycleTranscript,
  "0.153.3": auditNativeLifecycle1533Transcript,
  "0.153.4": auditNativeLifecycle1534Transcript,
  "0.154.0-alpha.6.2": auditNativeLifecycle1540Alpha62Transcript,
});
export const NATIVE_LIFECYCLE_CLI_VERSIONS = Object.freeze(Object.keys(AUDITORS));

export function supportsNativeLifecycleHost(platform, cliVersion) {
  if (platform === "win32") return cliVersion === "0.153.4";
  return platform === "darwin" && ["0.153.0-alpha.5", "0.153.0", "0.153.3", "0.153.4", "0.154.0-alpha.6.2"].includes(cliVersion);
}

function requireFact(value) {
  if (!value) throw new Error("native no-op evidence is unproven");
}

function readProbeTranscript(path) {
  const actual = realpathSync(path);
  const codexRoot = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"));
  requireFact(actual === resolve(path) && !lstatSync(path).isSymbolicLink());
  requireFact(["sessions", "archived_sessions"].some((folder) => {
    const child = relative(join(codexRoot, folder), actual);
    return child && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
  }));
  const before = statSync(actual);
  requireFact(before.isFile());
  const bytes = readNativeRecoveryTranscript(actual);
  const after = statSync(actual);
  requireFact(["dev", "ino", "size", "mtimeMs", "ctimeMs"].every((key) => before[key] === after[key]));
  return bytes;
}

// Diagnostic-only evidence validation, using the same pinned native no-work
// adapter as recovery. A native thread projection omits code-mode calls, so it
// is never sufficient. The CLI accepts neither source replacement nor a passed
// assertion. This helper writes nothing and does not grant production admission.
export function auditNativeLifecycleNoop({ child, parentId, taskName, target, marker }, {
  readTranscript = readProbeTranscript,
} = {}) {
  try {
    requireFact(typeof parentId === "string" && parentId && /^router_[a-f0-9]{32}$/u.test(taskName));
    requireFact(/^NATIVE_ROUTER_NOOP_[a-f0-9]{24}$/u.test(marker));
    requireFact(typeof child?.id === "string" && child.id && child.parentThreadId === parentId);
    requireFact(child.forkedFromId === null && child.model === target?.model
      && child.reasoningEffort === target?.effort);
    const spawn = child.source?.subAgent?.thread_spawn;
    requireFact(spawn?.parent_thread_id === parentId && spawn.depth === 1
      && spawn.agent_path === `/root/${taskName}`);
    requireFact(Array.isArray(child.turns) && child.turns.length === 1);
    const [turn] = child.turns;
    requireFact(turn.status === "completed" && turn.error == null && turn.itemsView === "full");
    requireFact(Array.isArray(turn.items) && turn.items.length > 0 && turn.items.length <= 128);
    requireFact(turn.items.every((item) => ["reasoning", "agentMessage"].includes(item.type)));
    const finals = turn.items.filter((item) => item.type === "agentMessage" && item.phase === "final_answer");
    requireFact(finals.length === 1 && finals[0] === turn.items.at(-1) && finals[0].text === marker);
    const bytes = readTranscript(child.path);
    const auditTranscript = Object.hasOwn(AUDITORS, child.cliVersion) ? AUDITORS[child.cliVersion] : null;
    requireFact(typeof auditTranscript === "function");
    const audit = auditTranscript(bytes, child, parentId);
    const repeated = readTranscript(child.path);
    requireFact(Buffer.isBuffer(repeated) && bytes.equals(repeated));
    return { passed: true, ...audit };
  } catch {
    return { passed: false, reasonCode: "NATIVE_NOOP_EVIDENCE_UNPROVEN" };
  }
}
