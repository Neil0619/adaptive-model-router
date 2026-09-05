#!/usr/bin/env node
// Logged-in, ephemeral, no-tool pilot. Rule agreement is not a model-quality metric.
import { writeFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { performance } from "node:perf_hooks";
import { AppServerClient } from "../scripts/lib/app-server.mjs";
import { normalizeCatalog } from "../scripts/lib/catalog.mjs";
import { resolveModelTarget } from "../scripts/lib/model-policy.mjs";
import { RouterStore } from "../scripts/lib/database.mjs";
import { readModelPolicy, withModelPolicyLease } from "../scripts/lib/model-policy-store.mjs";
const output = process.argv[2];
if (!output) throw new Error("Usage: node eval/quality.mjs OUTPUT.json (uses logged-in Codex)");
const schema = { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "string" } } };
const samples = [
  { id: "normalization-implementation", prompt: `Implement a JavaScript function normalize(input). Return only the function expression as answer, without markdown. input must be a string, otherwise throw TypeError. Normalize CRLF and bare CR to LF. Trim trailing spaces and tabs from each line, preserving leading whitespace and blank lines. Do not trim the whole document. Examples: " a  \\r\\nb\\t\\r" => " a\\nb\\n".`,
    check(answer) { const fn = runInNewContext(`(${answer})`, {}, { timeout: 100 });
      const cases = [[" a  \r\nb\t\r", " a\nb\n"], ["\n\n", "\n\n"], ["  a\t \n b", "  a\n b"], ["", ""], ["x\r\ry", "x\n\ny"]];
      for (const [input, expected] of cases) if (runInNewContext("fn(input)", { fn, input }, { timeout: 100 }) !== expected) return false;
      for (const input of [null, 3, {}]) { let threw = false; try { runInNewContext("fn(input)", { fn, input }, { timeout: 100 }); } catch (error) { threw = error.name === "TypeError"; } if (!threw) return false; }
      return true; } },
  { id: "atomic-activation-review", prompt: `Review this SQLite activation pseudo-code: const old = readActive(db); if (old.digest !== expected) return conflict; if (countActiveDelegates(db)) return busy; await validate(candidate); db.exec('BEGIN IMMEDIATE'); writeRevision(db,candidate); writeActive(db,candidate.digest); db.exec('COMMIT'); A separate process can admit a delegate or activate another policy concurrently. Identify which checks MUST run again inside the write transaction. Answer exactly a comma-separated sorted list chosen from: active_delegates, candidate_description, expected_digest, file_extension.`,
    check(answer) { return answer.trim() === "active_delegates,expected_digest"; } },
  { id: "routing-condition-analysis", prompt: `Apply these explicit rules: default high; settled and strongly verified, without risk, ambiguity or cross-module impact => medium; additionally purely mechanical with exact output check => low. At least two independent difficulty groups => xhigh; at least three plus high failure cost or irreversibility => max. Groups: security-or-migration, high-risk-or-high-failure-cost, cross-module-public-contract, architecture-tradeoff, irreversibility. Ultra only explicit or max reasoning failure with budget. Return the comma-separated levels in order for: (1) settled only; (2) settled+verified; (3) settled+verified+mechanical+exact; (4) security+migration; (5) security+high-risk; (6) security+high-risk+architecture; (7) security+high-failure-cost+architecture; (8) explicit ultra. No other signals apply.`,
    check(answer) { return answer.replaceAll(" ", "").trim() === "high,medium,low,high,xhigh,xhigh,max,ultra"; } },
];
const store = new RouterStore();
const policy = readModelPolicy(store.db);
const report = { schemaVersion: 1, policyId: policy.definition.id, policyDigest: policy.digest,
  policyDefinitionAtRun: policy.definition,
  startedAt: new Date().toISOString(), kind: "bounded-pilot", productionCalibration: false,
  limitations: ["Three bounded samples; insufficient for optimizing production thresholds.", "Configured model is not proof of the model actually served.", "Missing usage is null, never zero."], results: [] };
const client = new AppServerClient({ timeoutMs: 180_000 });
try {
  await withModelPolicyLease(store, policy, async () => {
    const catalog = normalizeCatalog(await client.listModels());
    const targets = ["medium", "high", "xhigh"].map((workLevel) => {
      const target = resolveModelTarget({ policy, catalog, demand: { workLevel, minimumLevel: "low" },
        override: policy.definition.targets[workLevel] }).target;
      if (!target) throw new Error(`allowed pilot target unavailable: ${workLevel}`);
      return { workLevel, target };
    });
    // Rotate order to reduce always-first warmup bias, preserving identical samples.
    for (const [index, sample] of samples.entries()) {
      for (const offset of [0, 1, 2]) {
        const { workLevel, target } = targets[(index + offset) % 3];
        const result = { sample: sample.id, workLevel, requested: target, configuredModel: null, servedModel: null,
          firstPass: false, passed: false, corrections: 0, elapsedMs: 0, usage: null };
        const started = performance.now();
        try {
          let prompt = `This is a bounded evaluation. Do not use tools, files, browsing or subagents. Return JSON matching the supplied schema.\n${sample.prompt}`;
          for (let attempt = 0; attempt < 2; attempt++) {
            const value = await client.classify({ ...target, prompt, outputSchema: schema, onObservation(observation) {
              result.configuredModel = observation.configuredModel;
              if (observation.usage) {
                result.usage ||= {};
                for (const field of ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"])
                  if (Number.isFinite(observation.usage[field])) result.usage[field] = (result.usage[field] || 0) + observation.usage[field];
              }
            } });
            let passed = false; try { passed = sample.check(value.answer); } catch {}
            if (attempt === 0) result.firstPass = passed;
            if (passed) { result.passed = true; break; }
            if (attempt === 0) { result.corrections = 1; prompt += `\nYour previous answer failed deterministic acceptance checks: ${JSON.stringify(value.answer)}. Correct it against every stated requirement.`; }
          }
        } catch (error) { result.error = String(error.message).slice(0, 240); }
        result.elapsedMs = Math.round(performance.now() - started);
        report.results.push(result);
        await writeFile(output, JSON.stringify(report, null, 2) + "\n");
        process.stdout.write(JSON.stringify({ sample: sample.id, effort: target.effort, firstPass: result.firstPass, passed: result.passed, elapsedMs: result.elapsedMs, error: result.error }) + "\n");
        if (result.error) throw new Error("pilot stopped after host/inference failure");
      }
    }
  });
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  client.close(); store.close(); report.completedAt = new Date().toISOString();
  report.summary = ["medium", "high", "xhigh"].map((workLevel) => {
    const rows = report.results.filter((row) => row.workLevel === workLevel);
    return { workLevel, samples: rows.length, firstPassRate: rows.length ? rows.filter((row) => row.firstPass).length / rows.length : null,
      corrections: rows.reduce((n, row) => n + row.corrections, 0), elapsedMs: rows.reduce((n, row) => n + row.elapsedMs, 0) };
  });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
}
