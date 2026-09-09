// A deliberately small, non-executing recognizer for the native code-mode
// single-tool forwarding forms. Arbitrary JavaScript and text() output are not
// tool receipts. No eval, accessors, spreads, expressions or result mutation.
function literalObject(source) {
  let at = 0;
  const space = () => { while (/\s/u.test(source[at] || "") && at < source.length) at += 1; };
  const string = () => {
    const start = at++;
    while (at < source.length) {
      const char = source[at++];
      if (char === "\\") at += 1;
      else if (char === '"') return JSON.parse(source.slice(start, at));
    }
    throw new Error("unfinished literal");
  };
  const value = () => {
    space();
    if (source[at] === '"') return string();
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(source.slice(at));
    if (!match) throw new Error("non-literal argument");
    at += match[0].length;
    const parsed = JSON.parse(match[0]);
    if (typeof parsed === "number" && !Number.isFinite(parsed)) throw new Error("non-finite argument");
    return parsed;
  };
  const result = Object.create(null);
  space();
  if (source[at++] !== "{") throw new Error("object required");
  space();
  while (source[at] !== "}") {
    let key;
    if (source[at] === '"') key = string();
    else { key = /^[A-Za-z_$][\w$]*/u.exec(source.slice(at))?.[0]; at += key?.length || 0; }
    if (typeof key !== "string") throw new Error("literal key required");
    if (["__proto__", "constructor", "prototype"].includes(key) || Object.hasOwn(result, key)) throw new Error("ambiguous key");
    space();
    if (source[at++] !== ":") throw new Error("colon required");
    result[key] = value();
    space();
    if (source[at] === "}") break;
    if (source[at++] !== ",") throw new Error("comma required");
    space();
  }
  at += 1;
  space();
  if (at !== source.length) throw new Error("trailing expression");
  return result;
}

export function forwardedToolCall(input) {
  if (typeof input !== "string" || input.length > 65536) return null;
  const source = input.replace(/^\s*\/\/ @exec:[^\r\n]*\r?\n/u, "").trim();
  const direct = /^text\s*\(\s*await\s+tools\.(exec_command|write_stdin)\s*\(([\s\S]*)\)\s*\)\s*;?$/u.exec(source);
  const bound = /^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+tools\.(exec_command|write_stdin)\s*\(([\s\S]*)\)\s*;\s*text\s*\(\s*\1\s*\)\s*;?$/u.exec(source);
  if (!direct && (!bound || ["tools", "text"].includes(bound[1]))) return null;
  try {
    return { name: direct?.[1] || bound[2], args: literalObject(direct?.[2] || bound[3]) };
  } catch { return null; }
}

export function forwardedToolResult(blocks) {
  if (!Array.isArray(blocks) || blocks.length !== 1 || blocks[0]?.type !== "input_text") return null;
  try {
    const value = JSON.parse(blocks[0].text);
    if (!value || typeof value !== "object" || Array.isArray(value)
      || typeof value.output !== "string" || typeof value.wall_time_seconds !== "number"
      || !Number.isFinite(value.wall_time_seconds) || value.wall_time_seconds < 0
      || Object.keys(value).some((key) => !["chunk_id", "wall_time_seconds", "session_id", "exit_code", "original_token_count", "output"].includes(key))) return null;
    if (Number.isSafeInteger(value.session_id) && value.session_id > 0 && value.exit_code == null) return { state: "running", id: String(value.session_id) };
    if (Number.isSafeInteger(value.exit_code) && value.session_id == null) return { state: "terminal", exitCode: value.exit_code };
    return null;
  } catch { return null; }
}

export function forwardedPollInput(input) {
  if (!/^(?:functions\.?)?exec$/u.test(input.tool_name || "")) return null;
  const value = input.tool_input;
  if (typeof value === "string") return forwardedToolCall(value);
  if (value && typeof value === "object" && Object.keys(value).length === 1) {
    return forwardedToolCall(value.input ?? value.code);
  }
  return null;
}
