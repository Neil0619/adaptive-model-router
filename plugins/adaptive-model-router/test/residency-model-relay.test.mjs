import test from "node:test";
import assert from "node:assert/strict";
import { ResidencyModelRelay } from "../scripts/lib/residency-model-relay.mjs";

const post = (base, body) => fetch(`${base}/responses`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const item = (text) => text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6))).find((event) => event.type === "response.output_item.done").item;

test("the relay advances only after the exact native result and keeps the root open for outcome verification", async () => {
  const relay = new ResidencyModelRelay("TEST_ROOT"); const base = await relay.start();
  try {
    const request = post(base, { input: [{ type: "message", text: "TEST_ROOT" }] });
    await relay.waitForRoot();
    const result = relay.native("list_agents", {});
    const call = item(await (await request).text());
    assert.equal(call.namespace, "collaboration");
    assert.equal(call.name, "list_agents");
    const response = post(base, { input: [{ text: "TEST_ROOT" }, { type: "function_call_output", call_id: call.call_id, output: "native-result" }] });
    assert.equal(await result, "native-result");
    await relay.waitForRoot();
    relay.finish();
    assert.equal(item(await (await response).text()).content[0].text, "RESIDENCY_PROTOCOL_VERIFIED");
    assert.equal(relay.nativeCalls, 1);
  } finally { await relay.close(); }
});

test("fixed child responses require the injected stage and expose received supplemental markers", async () => {
  const relay = new ResidencyModelRelay("TEST_ROOT"); const base = await relay.start();
  try {
    relay.addChild("CHILD_STAGE", ["REQUIRED_ADDITION"]);
    const initial = item(await (await post(base, { input: [{ text: "CHILD_STAGE" }] })).text());
    assert.equal(initial.content[0].text, "CHILD_STAGE");
    const next = item(await (await post(base, { input: [{ text: "CHILD_STAGE REQUIRED_ADDITION" }] })).text());
    assert.equal(next.content[0].text, "CHILD_STAGE|REQUIRED_ADDITION");
    assert.equal(relay.childReplies, 2);
    assert.equal((await post(base, { input: [{ text: "no injected task" }] })).status, 500);
    assert.equal(relay.errors.length, 1);
  } finally { await relay.close(); }
});

test("a final-response barrier holds native completion while a supplemental call can be delivered", async () => {
  const relay = new ResidencyModelRelay("TEST_ROOT"); const base = await relay.start();
  try {
    relay.addChild("RACE_STAGE", ["LATE_REQUIREMENT"], true);
    const response = await post(base, { input: [{ text: "RACE_STAGE" }] });
    await relay.waitForChildBarrier();
    const reader = response.body.getReader();
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    assert.match(text, /response.output_item.done/);
    assert.doesNotMatch(text, /response.completed/);
    relay.releaseChildBarrier();
    const tail = await reader.read();
    assert.match(new TextDecoder().decode(tail.value), /response.completed/);
    assert.equal((await reader.read()).done, true);
  } finally { await relay.close(); }
});
