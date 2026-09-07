import { createHash } from "node:crypto";
import { auditNativeLifecycle1534Transcript } from "./native-recovery-audit.mjs";

export const METADATA_RECOVERY_ADAPTER = "codex-0.153.4-tool-metadata-only/1";
// Reviewed from the native incident stream. This is a literal, pure lookup of
// the code-mode host's supplied tool descriptions, not a JavaScript evaluator
// or a general allowlist of read-only tools. Any other program fails closed.
const QUERY = 'text(ALL_TOOLS.filter(x=>/context|route|stage|status/.test(x.name)&&/router|adaptive/i.test(x.name+" "+x.description)));';
const hash = (value) => createHash("sha256").update(value).digest("hex");
const queryDigest = hash(QUERY);
const requireFact = (value) => { if (!value) throw new Error("native metadata-only recovery coverage is unproven"); };

export function isMetadataRecoveryAudit(value) {
  return value.cliVersion === "0.153.4" && value.rawAuditAdapter === METADATA_RECOVERY_ADAPTER
    && value.metadataOnlyCalls === 1 && value.metadataQueryDigest === queryDigest;
}

// Only the explicit unconsumed-attempt recovery path uses this adapter. Normal
// lifecycle qualification still requires a complete stream with no tool calls.
export function auditNativeUnconsumed1534Transcript(bytes, child, parentId) {
  requireFact(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 2 * 1024 * 1024);
  const source = bytes.toString("utf8");
  requireFact(source.endsWith("\n") && !source.includes("\uFFFD"));
  const records = source.trimEnd().split("\n").map((line) => JSON.parse(line));
  requireFact(records.length <= 1_000);
  const custom = records.filter((record) => record.type === "response_item"
    && ["custom_tool_call", "custom_tool_call_output"].includes(record.payload?.type));
  if (custom.length === 0) return auditNativeLifecycle1534Transcript(bytes, child, parentId);
  requireFact(custom.length === 2);
  const [call, output] = custom.map((record) => record.payload);
  requireFact(call.type === "custom_tool_call" && call.name === "exec" && call.status === "completed"
    && [undefined, "functions"].includes(call.namespace)
    && typeof call.call_id === "string" && call.call_id.length > 0
    && typeof call.input === "string" && call.input.trim() === QUERY);
  requireFact(output.type === "custom_tool_call_output" && output.call_id === call.call_id
    && Array.isArray(output.output) && output.output.length === 2
    && output.output.every((part) => part.type === "input_text" && typeof part.text === "string"));
  requireFact(/^Script completed\nWall time [0-9]+(?:\.[0-9]+)? seconds\nOutput:\n$/u.test(output.output[0].text));
  const metadata = JSON.parse(output.output[1].text);
  requireFact(Array.isArray(metadata) && metadata.length > 0 && metadata.length <= 100
    && metadata.every((tool) => tool && Object.keys(tool).length === 2
      && typeof tool.name === "string" && tool.name.startsWith("mcp__adaptive_model_router__")
      && typeof tool.description === "string"));
  const remaining = Buffer.from(records.filter((record) => !custom.includes(record)).map(JSON.stringify).join("\n") + "\n");
  auditNativeLifecycle1534Transcript(remaining, child, parentId);
  return { rawAuditAdapter: METADATA_RECOVERY_ADAPTER, rawAuditDigest: hash(bytes), sourceBytes: bytes.length,
    metadataOnlyCalls: 1, metadataQueryDigest: queryDigest };
}
