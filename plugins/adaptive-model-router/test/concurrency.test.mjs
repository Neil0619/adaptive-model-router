import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RouterStore } from "../scripts/lib/database.mjs";
import { listPolicyProposals } from "../scripts/lib/learning.mjs";
import { temporaryProject } from "./fixtures.mjs";

const worker = join(dirname(fileURLToPath(import.meta.url)), "concurrency-worker.mjs");

function runWorker(project, operation, contextId, value = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, operation, project.root, contextId, String(value)], {
      env: {
        ...process.env,
        ADAPTIVE_ROUTER_HOME: project.home,
        ADAPTIVE_ROUTER_LOCAL_ONLY: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) reject(new Error(`worker ${operation} exited ${code}: ${stderr}`));
      else {
        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          reject(new Error(`worker ${operation} returned invalid JSON: ${error.message}; ${stdout}; ${stderr}`));
        }
      }
    });
  });
}

test("50 processes concurrently migrate an empty SQLite database", async () => {
  const project = await temporaryProject("adaptive concurrency migration ");
  try {
    const results = await Promise.all(Array.from({ length: 50 }, (_, index) => runWorker(project, "migrate", `migration-${index}`)));
    assert.equal(results.length, 50);
    assert.ok(results.every((result) => result.version === 1 && result.health === "ok"));
    const store = new RouterStore({ path: join(project.home, "router.sqlite3") });
    assert.equal(Number(store.db.prepare("PRAGMA user_version").get().user_version), 1);
    store.close();
  } finally {
    await project.cleanup();
  }
});

test("50 processes claim once, write routes/outcomes/proposal, and approve exactly once without lost updates", async () => {
  const project = await temporaryProject("adaptive concurrency data ");
  const previousHome = process.env.ADAPTIVE_ROUTER_HOME;
  process.env.ADAPTIVE_ROUTER_HOME = project.home;
  try {
    const setup = new RouterStore();
    const context = setup.context({ cwd: project.root, contextId: "shared" });
    setup.setOverride(context, { scope: "session", model: "gpt-5.6-terra", effort: "medium" });
    setup.setOverride(context, { scope: "once", model: "gpt-5.6-sol", effort: "high" });
    setup.close();

    const results = await Promise.all(Array.from({ length: 50 }, (_, index) => runWorker(project, "route-outcome", "shared", index)));
    assert.equal(results.filter((result) => result.route.target.model === "gpt-5.6-sol").length, 1);
    assert.equal(results.filter((result) => result.route.target.model === "gpt-5.6-terra").length, 49);

    const store = new RouterStore();
    assert.equal(Number(store.db.prepare("SELECT count(*) AS count FROM routes").get().count), 50);
    assert.equal(Number(store.db.prepare("SELECT count(*) AS count FROM outcomes").get().count), 50);
    assert.equal(Number(store.db.prepare("SELECT count(*) AS count FROM overrides WHERE scope = 'once'").get().count), 0);
    const proposals = listPolicyProposals({ contextId: "shared" }, { store, cwd: project.root });
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].delta, 5);
    assert.ok(proposals[0].eligibleCount >= 12);
    assert.ok(proposals[0].affectedCount >= 4);
    store.close();

    const approvals = await Promise.all(Array.from({ length: 50 }, () => runWorker(project, "approve", "shared", proposals[0].proposalId)));
    assert.equal(approvals.filter((result) => result.idempotent === false).length, 1);
    const finalStore = new RouterStore();
    const finalContext = finalStore.context({ cwd: project.root, contextId: "shared" });
    assert.equal(Number(finalStore.db.prepare("SELECT count(*) AS count FROM policy_revisions WHERE project_id = ?").get(finalContext.projectId).count), 2);
    assert.equal(Number(finalStore.db.prepare("SELECT count(*) AS count FROM policy_proposals WHERE status = 'approved'").get().count), 1);
    finalStore.close();
  } finally {
    if (previousHome == null) delete process.env.ADAPTIVE_ROUTER_HOME;
    else process.env.ADAPTIVE_ROUTER_HOME = previousHome;
    await project.cleanup();
  }
});
