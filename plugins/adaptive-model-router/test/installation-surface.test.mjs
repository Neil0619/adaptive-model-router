import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { supportsResidencySurfaceRefresh, supportsResidencyHookMatcherUpgrade } from "../scripts/lib/installation-surface.mjs";

const files = [".mcp.json", "hooks/hooks.json", ".codex-plugin/plugin.json", "skills/adaptive-model-router/agents/openai.yaml"];
const current = Object.fromEntries(files.map((path) => [path, readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8")]));
const previous = structuredClone(current);
const mcp = JSON.parse(previous[".mcp.json"]);
delete mcp.mcpServers["adaptive-model-router"].tools.manage_stage;
previous[".mcp.json"] = JSON.stringify(mcp);
const hooks = JSON.parse(previous["hooks/hooks.json"]);
for (const event of ["PreToolUse", "PostToolUse"]) hooks.hooks[event][0].matcher = "^(?:Agent|spawn_agent|collaborationspawn_agent)$";
previous["hooks/hooks.json"] = JSON.stringify(hooks);

test("the reviewed residency extension preserves existing commands, transports and permissions", () => {
  assert.equal(supportsResidencySurfaceRefresh(previous, current), true);
  assert.equal(supportsResidencySurfaceRefresh(current, current), true);
});

test("surface refresh cannot authorize unrelated commands, tools, approvals or hook events", () => {
  const mutations = [
    (next) => { const doc = JSON.parse(next[".mcp.json"]); doc.mcpServers["adaptive-model-router"].cwd = "/unrelated"; next[".mcp.json"] = JSON.stringify(doc); },
    (next) => { const doc = JSON.parse(next[".mcp.json"]); doc.mcpServers["adaptive-model-router"].tools.configure_router = { approval_mode: "approve" }; next[".mcp.json"] = JSON.stringify(doc); },
    (next) => { const doc = JSON.parse(next[".mcp.json"]); doc.mcpServers["adaptive-model-router"].tools.route_stage.approval_mode = "prompt"; next[".mcp.json"] = JSON.stringify(doc); },
    (next) => { const doc = JSON.parse(next["hooks/hooks.json"]); doc.hooks.PreToolUse[0].hooks[0].command = "different executable"; next["hooks/hooks.json"] = JSON.stringify(doc); },
    (next) => { const doc = JSON.parse(next["hooks/hooks.json"]); doc.hooks.PermissionRequest = []; next["hooks/hooks.json"] = JSON.stringify(doc); },
    (next) => { next["skills/adaptive-model-router/agents/openai.yaml"] += "changed"; },
  ];
  for (const mutate of mutations) {
    const next = structuredClone(current); mutate(next);
    assert.equal(supportsResidencySurfaceRefresh(previous, next), false);
  }
});

test("historical Hook shells may enter fresh qualification for the reviewed matcher extension only", () => {
  const entries = (source) => Object.entries(JSON.parse(source["hooks/hooks.json"]).hooks).flatMap(([event, groups]) =>
    groups.map((group) => ({ eventName: event[0].toLowerCase() + event.slice(1), matcher: group.matcher ?? null,
      ...group.hooks[0] })));
  const old = entries(previous), next = entries(current);
  assert.equal(supportsResidencyHookMatcherUpgrade(old, next), true);
  assert.equal(supportsResidencyHookMatcherUpgrade(next, next), true);
  for (const mutate of [
    (list) => { list.find((x) => x.eventName === "preToolUse").command = "unrelated command"; },
    (list) => { list.find((x) => x.eventName === "preToolUse").matcher = "unknown legacy matcher"; },
    (list) => { list.find((x) => x.eventName === "stop").timeout += 1; },
    (list) => { list.push({ ...list.find((x) => x.eventName === "preToolUse") }); },
  ]) {
    const changed = structuredClone(old); mutate(changed);
    assert.equal(supportsResidencyHookMatcherUpgrade(changed, next), false);
  }
  assert.equal(supportsResidencyHookMatcherUpgrade(next, old), false, "this cannot authorize a matcher rollback");
});
