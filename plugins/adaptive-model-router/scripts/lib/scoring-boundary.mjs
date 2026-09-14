// The initial hot-code seam is inferCategory's pure branch program. Every byte
// outside this bounded grammar remains a shared-writer byte. This is deliberately
// smaller than all of scorer.mjs: an import, top-level side effect, arbitrary
// expression or changed score/return contract requires a new compatibility epoch.
export function scoringWriterProjection(source) {
  const match = /export function inferCategory\(goal, phase = ""\) \{\r?\n([\s\S]*?)\r?\n\}/u.exec(source);
  if (!match) throw new Error("Pure scoring boundary is missing");
  let body = match[1].trim();
  const prefix = 'const text = `${phase} ${normalizeText(goal)}`;';
  if (!body.startsWith(prefix)) throw new Error("Unproven scorer writer change");
  body = body.slice(prefix.length).trim();
  const category = '(?:review|exploration|documentation|implementation|mechanical|general)';
  const branch = new RegExp(`^if \\(includesAny\\(text, PATTERNS\\.${category}\\)\\) return "${category}";`, "u");
  const literal = new RegExp(`^if \\(text\\.includes\\("[^"\\\\\\r\\n]{1,128}"\\)\\) return "${category}";`, "u");
  let count = 0;
  while (!new RegExp(`^return "${category}";$`, "u").test(body)) {
    const next = branch.exec(body) || literal.exec(body);
    if (!next || count++ >= 32) throw new Error("Unproven scorer writer change");
    body = body.slice(next[0].length).trim();
  }
  return source.slice(0, match.index) + "PURE_CATEGORY_BRANCH_PROGRAM" + source.slice(match.index + match[0].length);
}
