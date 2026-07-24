import { CATEGORIES, EFFORT_ORDER } from "./constants.mjs";
import { clamp, includesAny, normalizeText } from "./io.mjs";

const PATTERNS = {
  ambiguity: [/architecture|design|trade-?off|brainstorm|from scratch|方案|架构|设计|权衡|讨论|从零|产品定义/i],
  risk: [/security|authentication|authorization|payment|migration|concurren|production|public api|database schema|安全|鉴权|认证|授权|支付|迁移|并发|生产|公开.?api|数据库结构/i],
  security: [/security|authentication|authorization|credential|secret|安全|鉴权|认证|授权|凭据|密钥/i],
  migration: [/migration|schema change|data backfill|迁移|表结构|数据回填/i],
  publicContract: [/public api|shared contract|published interface|公开.?api|公共契约|已发布接口/i],
  architectureTradeoff: [/architecture trade-?off|architectural decision|system design trade-?off|架构权衡|架构决策|系统设计权衡/i],
  crossCutting: [/multi[- ]module|cross[- ]module|end[- ]to[- ]end|full stack|shared contract|多个模块|跨模块|端到端|全栈|公共契约/i],
  mechanical: [/extract|classif|format|rename|translate|convert|sort|deduplicat|提取|分类|格式化|重命名|翻译|转换|排序|去重/i],
  clear: [/\b(?:exactly|well-scoped|acceptance criteria|specified)\b|按以下|明确|验收标准|只修改|固定格式|照此/i],
  verification: [/test|lint|type.?check|compile|build|schema|snapshot|测试|检查|编译|构建|类型|验收/i],
  exploration: [/explore|inspect|scan|search|read.?only|investigate|调查|探索|扫描|搜索|只读|查看代码/i],
  review: [/review|audit|final check|审查|审核|复核|代码评审/i],
  implementation: [/\b(?:implement|build|code|fix|refactor)\b|开发|实现|编码|修复|重构/i],
  documentation: [/\b(?:document|specification|proposal|readme)\b|文档|说明书|规格|方案书/i],
};

const TRIVIAL = /^(?:hi|hello|hey|thanks|thank you|ok|okay|你好|您好|嗨|谢谢|好的|收到)[!！。,.，\s]*$/i;
const SIMPLE_QUESTION = /^(?:what is|who is|when is|where is|how many|什么是|谁是|什么时候|多少).{0,80}[?？]$/i;

export function inferCategory(goal, phase = "") {
  const text = `${phase} ${normalizeText(goal)}`;
  if (includesAny(text, PATTERNS.review)) return "review";
  if (includesAny(text, PATTERNS.exploration)) return "exploration";
  if (includesAny(text, PATTERNS.documentation)) return "documentation";
  if (includesAny(text, PATTERNS.implementation)) return "implementation";
  if (includesAny(text, PATTERNS.mechanical)) return "mechanical";
  return "general";
}

export function isTrivialTask(goal, evidence = {}) {
  const text = String(goal || "").trim();
  if (evidence.workProduct === true || evidence.batchSize > 1) return false;
  if (evidence.workProduct === false && text.length < 160 && !includesAny(text, PATTERNS.implementation)) return true;
  return TRIVIAL.test(text) || SIMPLE_QUESTION.test(text);
}

export function scoreTask({ goal, phase = "", evidence = {}, policy = {} }) {
  const text = `${phase} ${normalizeText(goal)}`;
  const category = inferCategory(goal, phase);
  const generalRisk = evidence.highRisk === true || includesAny(text, PATTERNS.risk);
  const signals = {
    ambiguity: evidence.ambiguous === true || includesAny(text, PATTERNS.ambiguity),
    risk: generalRisk || evidence.highFailureCost === true || evidence.irreversible === true,
    highFailureCost: evidence.highFailureCost === true,
    irreversible: evidence.irreversible === true,
    security: evidence.securitySensitive === true || includesAny(text, PATTERNS.security),
    migration: evidence.migration === true || includesAny(text, PATTERNS.migration),
    publicContract: evidence.publicContract === true || includesAny(text, PATTERNS.publicContract),
    architectureTradeoff: evidence.architectureTradeoff === true || includesAny(text, PATTERNS.architectureTradeoff),
    crossCutting: evidence.crossCutting === true || includesAny(text, PATTERNS.crossCutting),
    mechanical: evidence.mechanical === true || includesAny(text, PATTERNS.mechanical),
    clear: evidence.requirementsSettled === true || includesAny(text, PATTERNS.clear),
    verification: evidence.strongVerification === true || includesAny(text, PATTERNS.verification),
    exploration: evidence.exploration === true || includesAny(text, PATTERNS.exploration),
    review: evidence.review === true || includesAny(text, PATTERNS.review),
    implementation: includesAny(text, PATTERNS.implementation),
    documentation: includesAny(text, PATTERNS.documentation),
  };
  let score = 40;
  if (signals.ambiguity) score += 18;
  if (signals.risk) score += 25;
  if (signals.security || signals.migration) score += 10;
  if (signals.crossCutting) score += 15;
  if (!signals.verification && (signals.implementation || signals.risk)) score += 8;
  if (signals.review) score += 10;
  if (signals.mechanical) score -= evidence.batchSize > 1 ? 28 : 20;
  if (signals.clear) score -= 10;
  if (signals.verification && signals.clear) score -= 5;
  if (signals.exploration && !signals.risk) score -= 8;
  if (text.length > 2_000) score += 8;
  const offset = Number(policy.categoryOffsets?.[category] || 0);
  score = clamp(score + offset, 0, 100);
  const matched = Object.values(signals).filter(Boolean).length;
  const distance = Math.min(...[25, 45, 60, 80, 92, 97].map((boundary) => Math.abs(score - boundary)));
  const confidence = clamp(0.55 + matched * 0.035 + distance / 100, 0.55, 0.96);
  const substantive = evidence.workProduct === true || text.length >= 80 || signals.implementation || signals.review || signals.exploration || evidence.batchSize > 1;
  const borderline = substantive && (distance <= 6 || (matched <= 1 && score >= 30 && score <= 80));
  const hardSignalCount = [
    signals.security || signals.migration,
    evidence.highRisk === true || signals.highFailureCost,
    signals.crossCutting && signals.publicContract,
    signals.architectureTradeoff,
    signals.irreversible,
  ].filter(Boolean).length;
  return {
    score,
    confidence,
    borderline,
    substantive,
    category: CATEGORIES.includes(category) ? category : "general",
    signals,
    hardSignalCount,
    policyOffset: offset,
  };
}

export function desiredRoute(scored, evidence = {}) {
  let family;
  let effort;
  if (scored.score <= 25) [family, effort] = ["luna", "low"];
  else if (scored.score <= 45) [family, effort] = ["terra", "low"];
  else if (scored.score <= 60) [family, effort] = ["terra", "medium"];
  else if (scored.score <= 80) [family, effort] = ["sol", "medium"];
  else if (scored.score <= 92) [family, effort] = ["sol", "high"];
  else if (scored.score <= 97 || scored.hardSignalCount < 2) [family, effort] = ["sol", "xhigh"];
  else [family, effort] = ["sol", "max"];
  if (scored.signals.mechanical && evidence.batchSize > 1 && !scored.signals.risk) [family, effort] = ["luna", "low"];
  if (scored.signals.implementation && family === "luna") [family, effort] = ["terra", "low"];
  if (scored.category === "review" && family !== "sol") [family, effort] = ["sol", "medium"];
  if (scored.signals.risk || scored.signals.security || scored.signals.migration) {
    family = "sol";
    if (EFFORT_ORDER.indexOf(effort) < EFFORT_ORDER.indexOf("high")) effort = "high";
  }
  let verificationGate = "structured-check";
  if (!evidence.workProduct && scored.category === "general") verificationGate = "task-specific";
  if (scored.signals.implementation) verificationGate = "targeted-tests";
  if (scored.signals.risk || scored.signals.security || scored.signals.migration) verificationGate = "full-checks";
  return { family, effort, verificationGate };
}

export function deterministicReasonCodes(scored, { learned = false } = {}) {
  const codes = [];
  if (scored.signals.mechanical) codes.push("MECHANICAL_BATCH");
  if (scored.signals.ambiguity) codes.push("AMBIGUOUS_REQUIREMENTS");
  if (scored.signals.crossCutting) codes.push("CROSS_CUTTING_CHANGE");
  if (scored.signals.risk) codes.push("HIGH_RISK");
  if (scored.signals.security) codes.push("SECURITY_SENSITIVE");
  if (scored.signals.migration) codes.push("MIGRATION_RISK");
  if (scored.signals.exploration) codes.push("EXPLORATION_STAGE");
  if (scored.signals.review) codes.push("REVIEW_STAGE");
  if (scored.signals.verification) codes.push("STRONG_VERIFICATION");
  if (scored.score >= 98 && scored.hardSignalCount >= 2) codes.push("MAX_EFFORT_GATE");
  if (learned) codes.push("LEARNED_POLICY");
  if (!codes.length) codes.push("DEFAULT_POLICY");
  return [...new Set(codes)];
}
