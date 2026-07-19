import { access, mkdtemp } from "node:fs/promises";
import { constants as fsConstants, rmSync } from "node:fs";
import { spawn, spawnSync, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ROUTER_VERSION } from "./constants.mjs";

const execFileAsync = promisify(execFile);
const MAC_BINARIES = [
  "/Applications/Codex.app/Contents/Resources/codex",
  "/Applications/ChatGPT.app/Contents/Resources/codex",
];

async function executable(path) {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function windowsKind(path) {
  return /\.(?:cmd|bat)$/i.test(path) ? "cmd" : "direct";
}

export async function resolveCodexCommand({ platform = process.platform, env = process.env } = {}) {
  if (env.CODEX_BIN) return { path: env.CODEX_BIN, kind: platform === "win32" ? windowsKind(env.CODEX_BIN) : "direct" };
  if (platform === "darwin") {
    for (const path of MAC_BINARIES) if (await executable(path)) return { path, kind: "direct" };
  }
  if (platform === "win32") {
    for (const name of ["codex.exe", "codex.cmd", "codex.bat"]) {
      try {
        const { stdout } = await execFileAsync("where.exe", [name], { windowsHide: true, timeout: 2_000 });
        const candidate = String(stdout).split(/\r?\n/).map((line) => line.trim()).find(Boolean);
        if (candidate) return { path: candidate, kind: windowsKind(candidate) };
      } catch {
        // Try the next platform-specific executable name.
      }
    }
    return { path: "codex.exe", kind: "direct" };
  }
  return { path: "codex", kind: "direct" };
}

function quoteCmd(value) {
  const escaped = String(value).replaceAll("%", "%%").replaceAll("^", "^^").replaceAll('"', '""');
  return `"${escaped}"`;
}

export function spawnSpec(resolved, args, env = process.env) {
  if (resolved.kind !== "cmd") return { command: resolved.path, args };
  const commandLine = [quoteCmd(resolved.path), ...args.map(quoteCmd)].join(" ");
  return {
    command: env.ComSpec || env.COMSPEC || "cmd.exe",
    args: ["/d", "/v:off", "/s", "/c", `"${commandLine}"`],
  };
}

export class AppServerClient {
  constructor({ timeoutMs = 8_000, spawnImpl = spawn, resolveImpl = resolveCodexCommand, clock = Date.now } = {}) {
    this.timeoutMs = timeoutMs;
    this.spawnImpl = spawnImpl;
    this.resolveImpl = resolveImpl;
    this.clock = clock;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = new Set();
    this.subscribers = new Set();
    this.notificationBuffer = [];
    this.process = null;
    this.closedError = null;
  }

  remaining(deadlineAt) {
    const remaining = Math.floor(deadlineAt - this.clock());
    if (remaining <= 0) throw new Error("classifier deadline exceeded");
    return Math.min(this.timeoutMs, remaining);
  }

  async start(deadlineAt = this.clock() + this.timeoutMs) {
    if (this.process) return;
    const resolved = await this.resolveImpl();
    this.spawnKind = resolved.kind;
    this.remaining(deadlineAt);
    const appHome = await mkdtemp(join(tmpdir(), "adaptive-model-router-app-server-"));
    this.appHome = appHome;
    const spec = spawnSpec(resolved, ["app-server", "--listen", "stdio://"]);
    try {
      this.process = this.spawnImpl(spec.command, spec.args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: {
          ...process.env,
          ADAPTIVE_ROUTER_INTERNAL: "1",
          CODEX_SQLITE_HOME: appHome,
        },
      });
    } catch (error) {
      this.cleanupHome();
      throw error;
    }
    this.process.once("error", (error) => {
      this.failAll(new Error(`codex app-server failed: ${error.code || "spawn error"}`));
      this.cleanupHome();
    });
    this.process.once("exit", (code) => {
      this.failAll(new Error(`codex app-server exited with code ${code ?? "unknown"}`));
      this.cleanupHome();
    });
    this.process.stderr?.resume();
    const lines = createInterface({ input: this.process.stdout });
    lines.on("line", (line) => this.handleLine(line));
    await this.request("initialize", {
      clientInfo: { name: "adaptive_model_router", title: "Adaptive Model Router", version: ROUTER_VERSION },
    }, deadlineAt);
    this.notify("initialized", {});
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id != null && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || "app-server request failed"));
      else pending.resolve(message.result);
      return;
    }
    this.notificationBuffer.push(message);
    if (this.notificationBuffer.length > 100) this.notificationBuffer.shift();
    for (const subscriber of [...this.subscribers]) subscriber(message);
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(message);
    }
  }

  send(message) {
    if (this.closedError) throw this.closedError;
    if (!this.process?.stdin?.writable) throw new Error("app-server is not running");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}, deadlineAt = this.clock() + this.timeoutMs) {
    const id = this.nextId++;
    const timeout = this.remaining(deadlineAt);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} exceeded the classifier deadline`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this.send({ method, params });
  }

  createWaiter(predicate, deadlineAt = this.clock() + this.timeoutMs) {
    const buffered = this.notificationBuffer.find(predicate);
    if (buffered) return { promise: Promise.resolve(buffered), cancel() {} };
    let waiter;
    const promise = new Promise((resolve, reject) => {
      waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error("app-server notification exceeded the classifier deadline"));
      }, this.remaining(deadlineAt));
      this.waiters.add(waiter);
    });
    return {
      promise,
      cancel: () => {
        if (!waiter || !this.waiters.delete(waiter)) return;
        clearTimeout(waiter.timer);
        waiter.reject(new Error("app-server waiter cancelled"));
      },
    };
  }

  subscribe(callback) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  async classify({ model, effort, prompt, outputSchema }, deadlineAt = this.clock() + this.timeoutMs) {
    await this.start(deadlineAt);
    const started = await this.request("thread/start", { model, ephemeral: true }, deadlineAt);
    const threadId = started?.thread?.id;
    if (!threadId) throw new Error("classifier thread did not start");
    const deltas = [];
    let finalText = null;
    const unsubscribe = this.subscribe((message) => {
      if (message?.params?.threadId && message.params.threadId !== threadId) return;
      const method = String(message?.method || "");
      const delta = message?.params?.delta;
      if (/agentMessage\/delta$/i.test(method) && typeof delta === "string") deltas.push(delta);
      const item = message?.params?.item;
      if (item?.type === "agentMessage" && typeof item.text === "string" && /completed|final/i.test(method)) {
        finalText = item.text;
      }
    });
    const completion = this.createWaiter(
      (message) => message?.method === "turn/completed" && message?.params?.threadId === threadId,
      deadlineAt,
    );
    completion.promise.catch(() => {});
    try {
      await this.request("turn/start", {
        threadId,
        effort,
        input: [{ type: "text", text: prompt }],
        outputSchema,
      }, deadlineAt);
      const completed = await completion.promise;
      if (completed?.params?.turn?.status === "failed") throw new Error("classifier turn failed");
    } catch (error) {
      completion.cancel();
      throw error;
    } finally {
      unsubscribe();
    }
    const text = String(finalText ?? deltas.join("")).trim();
    if (!text) throw new Error("classifier returned no output");
    return JSON.parse(text);
  }

  failAll(error) {
    if (this.closedError) return;
    this.closedError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
    this.waiters.clear();
    this.subscribers.clear();
    this.process = null;
  }

  cleanupHome() {
    if (!this.appHome) return;
    try {
      rmSync(this.appHome, { recursive: true, force: true });
      this.appHome = null;
    } catch {
      // Windows may hold files until the child exit event retries cleanup.
    }
  }

  close() {
    const processHandle = this.process;
    if (!this.closedError) this.failAll(new Error("app-server closed"));
    if (processHandle && !processHandle.killed) {
      if (process.platform === "win32" && this.spawnKind === "cmd" && processHandle.pid) {
        const killed = spawnSync("taskkill.exe", ["/PID", String(processHandle.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        if (killed.status !== 0) processHandle.kill("SIGTERM");
      } else {
        processHandle.kill("SIGTERM");
      }
    }
    if (!processHandle) this.cleanupHome();
  }
}

export async function withAppServer(callback, { timeoutMs = 8_000, clientFactory = null } = {}) {
  const deadlineAt = Date.now() + timeoutMs;
  const client = clientFactory ? clientFactory({ timeoutMs }) : new AppServerClient({ timeoutMs });
  try {
    return await callback(client, deadlineAt);
  } finally {
    client.close();
  }
}
