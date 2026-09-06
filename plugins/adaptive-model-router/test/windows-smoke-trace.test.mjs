import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { desiredRoute, scoreTask } from "../scripts/lib/scorer.mjs";

test("the canonical bounded review goal keeps the structured-check contract", () => {
  const runner = readFileSync(new URL("../../../scripts/windows-smoke.ps1", import.meta.url), "utf8");
  const goal = /<bounded-review-goal>([^<]+)<\/bounded-review-goal>/u.exec(runner)?.[1];
  assert.ok(goal);
  const evidence = { review: true, workProduct: true, requirementsSettled: true, strongVerification: true, batchSize: 2 };
  const scored = scoreTask({ goal, phase: "review", evidence });
  assert.equal(scored.category, "review");
  assert.equal(desiredRoute(scored, evidence).verificationGate, "structured-check");
});

test("Windows smoke recognizes completed legacy and native MCP trace events only", {
  skip: process.platform !== "win32" ? "native PowerShell gate adapter" : false,
}, () => {
  const runner = fileURLToPath(new URL("../../../scripts/windows-smoke.ps1", import.meta.url));
  const script = `
$ErrorActionPreference = 'Stop'
$errors = $null
$tokens = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:ROUTER_SMOKE_TEST_RUNNER, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Runner syntax is invalid' }
foreach ($name in @('Get-NestedPropertyValue','Get-McpTraceTool')) {
    $definitions = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true))
    if ($definitions.Count -ne 1) { throw 'Helper is not uniquely defined' }
    Invoke-Expression $definitions[0].Extent.Text
}
$cases = [Console]::In.ReadToEnd() | ConvertFrom-Json -Depth 15
$actual = @($cases | ForEach-Object { Get-McpTraceTool -Entry $_ })
ConvertTo-Json -InputObject $actual -Compress
`;
  const item = { type: "McpToolCall", tool: "record_outcome", status: "completed" };
  const event = (type, itemValue) => ({ type: "event_msg", payload: { type, item: itemValue } });
  const cases = [
    { type: "event_msg", payload: { type: "mcp_tool_call_end", invocation: { tool: "route_stage" } } },
    event("item_completed", item),
    event("item_started", item),
    event("item_completed", { ...item, status: "in_progress" }),
    event("item_completed", { ...item, type: "CommandExecution" }),
    { type: "response_item", payload: { type: "item_completed", item } },
    { type: "event_msg", payload: { type: "task_complete" } },
  ];
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input: JSON.stringify(cases), encoding: "utf8", timeout: 10_000, windowsHide: true,
    env: { ...process.env, ROUTER_SMOKE_TEST_RUNNER: runner },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ["route_stage", "record_outcome", null, null, null, null, null]);
});
