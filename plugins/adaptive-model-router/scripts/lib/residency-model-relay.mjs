import { createServer } from "node:http";

/** Fixed responses for native protocol acceptance only. Never stores prompts,
 * headers, credentials or carrier text. Semantic quality requires real models. */
export class ResidencyModelRelay {
  constructor(marker) {
    this.marker = marker;
    this.sequence = 0;
    this.childReplies = 0;
    this.specs = [];
    this.errors = [];
    this.nativeCalls = 0;
    this.rootWaiters = [];
    this.server = createServer((request, response) => this.accept(request, response));
  }

  async start() {
    await new Promise((resolve, reject) => { this.server.once("error", reject); this.server.listen(0, "127.0.0.1", resolve); });
    return `http://127.0.0.1:${this.server.address().port}/v1`;
  }

  addChild(marker, supplements = [], holdFinal = false) { this.specs.push({ marker, supplements, holdFinal }); }

  waitForChildBarrier() {
    if (this.childBarrier) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("child did not reach the controlled final-response window")), 30000);
      this.childBarrierReady = () => { clearTimeout(timer); resolve(); };
    });
  }

  releaseChildBarrier() {
    if (!this.childBarrier) throw new Error("no child final-response window is held");
    this.childBarrier.response.end(this.childBarrier.tail);
    this.childBarrier = null;
  }

  async accept(request, response) {
    try {
      let bytes = 0;
      const chunks = [];
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) throw new Error("fixed-response request exceeded its byte bound");
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const wire = JSON.stringify(input);
      if (!wire.includes(this.marker)) {
        const matches = this.specs.filter((spec) => wire.includes(spec.marker));
        if (matches.length !== 1) throw new Error("child request lacks one exact injected stage marker");
        const spec = matches[0];
        const handled = spec.supplements.filter((marker) => wire.includes(marker));
        this.childReplies += 1;
        const hold = spec.holdFinal && !spec.held;
        if (hold) spec.held = true;
        this.reply(response, this.final([spec.marker, ...handled].join("|")), hold);
        return;
      }
      if (this.inflight) {
        const outputs = input.input?.filter((item) => item.type === "function_call_output" && item.call_id === this.inflight.id) || [];
        if (outputs.length !== 1) throw new Error("native call result is missing or repeated");
        const inflight = this.inflight;
        this.inflight = null;
        clearTimeout(inflight.timer);
        inflight.resolve(outputs[0].output);
      }
      if (this.rootResponse) throw new Error("root has overlapping response streams");
      this.rootResponse = response;
      for (const resolve of this.rootWaiters.splice(0)) resolve();
      this.dispatch();
    } catch (error) {
      this.errors.push(error.message);
      this.inflight?.reject(error);
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain" });
      response.end("residency protocol acceptance failed");
    }
  }

  waitForRoot() {
    if (this.rootResponse) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("native root never reached the fixed-response relay")), 30000);
      this.rootWaiters.push(() => { clearTimeout(timer); resolve(); });
    });
  }

  native(name, args) {
    if (this.inflight || this.queued) throw new Error("native acceptance operations must remain sequential");
    return new Promise((resolve, reject) => {
      const id = `residency_${++this.sequence}`;
      const timer = setTimeout(() => reject(new Error(`native ${name} exceeded its acceptance deadline`)), 30000);
      this.queued = { id, name, args, resolve, reject, timer };
      this.dispatch();
    });
  }

  dispatch() {
    if (!this.rootResponse || !this.queued) return;
    const response = this.rootResponse;
    this.rootResponse = null;
    this.inflight = this.queued;
    this.queued = null;
    this.nativeCalls += 1;
    const { id, name, args } = this.inflight;
    this.reply(response, { type: "function_call", id: `fc_${id}`, call_id: id, namespace: "collaboration", name, arguments: JSON.stringify(args) });
  }

  final(text) {
    return { type: "message", id: `msg_${++this.sequence}`, role: "assistant", phase: "final_answer",
      content: [{ type: "output_text", text, annotations: [] }] };
  }

  finish() {
    if (!this.rootResponse || this.inflight || this.queued) throw new Error("cannot finish before the last native result");
    const response = this.rootResponse; this.rootResponse = null;
    this.reply(response, this.final("RESIDENCY_PROTOCOL_VERIFIED"));
  }

  reply(response, item, hold = false) {
    const id = `response_${++this.sequence}`;
    const events = [
      ["response.created", { response: { id, object: "response", status: "in_progress", output: [] } }],
      ["response.output_item.done", { output_index: 0, item }],
      ["response.completed", { response: { id, object: "response", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }],
    ];
    const parts = events.map(([type, value]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    if (hold) {
      if (this.childBarrier) throw new Error("overlapping child final-response barriers");
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(parts.slice(0, 2).join(""));
      this.childBarrier = { response, tail: parts[2] };
      this.childBarrierReady?.(); this.childBarrierReady = null;
      return;
    }
    const data = parts.join("");
    response.writeHead(200, { "Content-Type": "text/event-stream", "Content-Length": Buffer.byteLength(data) });
    response.end(data);
  }

  async close() {
    for (const work of [this.inflight, this.queued].filter(Boolean)) {
      clearTimeout(work.timer); work.reject(new Error("acceptance relay closed"));
    }
    this.rootResponse?.end();
    this.childBarrier?.response.end();
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}
