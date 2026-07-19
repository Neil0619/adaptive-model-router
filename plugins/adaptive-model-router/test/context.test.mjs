import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeIdentityPath, projectIdentityMaterial } from "../scripts/lib/context.mjs";
import { RouterStore } from "../scripts/lib/database.mjs";
import { temporaryProject, withRouterEnvironment } from "./fixtures.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

test("Git worktrees share a project ID while nested repositories remain independent", async () => {
  const project = await temporaryProject();
  const main = join(project.root, "main repo");
  const worktree = join(project.root, "worktree 中文");
  const nested = join(main, "submodule-like");
  await mkdir(main);
  try {
    git(main, "init");
    git(main, "config", "user.email", "test@example.invalid");
    git(main, "config", "user.name", "Test");
    await writeFile(join(main, "README.md"), "test\n");
    git(main, "add", "README.md");
    git(main, "commit", "-m", "initial");
    git(main, "worktree", "add", "-b", "worktree-test", worktree);
    await mkdir(nested);
    git(nested, "init");

    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const mainContext = store.context({ cwd: main, contextId: "same" });
      const worktreeContext = store.context({ cwd: worktree, contextId: "same" });
      const nestedContext = store.context({ cwd: nested, contextId: "same" });
      assert.equal(mainContext.projectId, worktreeContext.projectId);
      assert.notEqual(mainContext.projectId, nestedContext.projectId);
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});

test("non-Git project material is stable and Windows drive normalization is case-insensitive", async () => {
  const project = await temporaryProject();
  try {
    assert.equal(projectIdentityMaterial(project.root), projectIdentityMaterial(project.root));
    assert.equal(
      normalizeIdentityPath("C:\\Users\\Name\\Project", "win32"),
      normalizeIdentityPath("c:\\Users\\Name\\Project", "win32"),
    );
  } finally {
    await project.cleanup();
  }
});

test("the same context ID does not share session overrides across projects", async () => {
  const project = await temporaryProject();
  const other = join(project.root, "other");
  await mkdir(other);
  try {
    await withRouterEnvironment(project, async () => {
      const store = new RouterStore();
      const first = store.context({ cwd: project.root, contextId: "same-session" });
      const second = store.context({ cwd: other, contextId: "same-session" });
      store.setOverride(first, { scope: "session", model: "gpt-5.6-sol" });
      assert.equal(store.resolveOverride(first).source, "session");
      assert.equal(store.resolveOverride(second).source, null);
      store.close();
    });
  } finally {
    await project.cleanup();
  }
});
