import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { supportsRuntime } from "../scripts/lib/runtime.mjs";
import { AGENTS_MARKER_END, AGENTS_MARKER_START } from "../scripts/lib/constants.mjs";
import { temporaryProject } from "./fixtures.mjs";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(pluginRoot, "..", "..");
const manager = join(pluginRoot, "scripts", "manage-install.mjs");

const FAKE_SOURCE = `
import { readFileSync, writeFileSync } from "node:fs";
const path = process.env.FAKE_CODEX_STATE;
const state = JSON.parse(readFileSync(path, "utf8"));
const args = process.argv.slice(2);
const save = () => writeFileSync(path, JSON.stringify(state));
if (args[0] === "--version") { process.stdout.write("codex 1.0.0\\n"); process.exit(0); }
if (args.join(" ") === "plugin marketplace list --json") { process.stdout.write(JSON.stringify({marketplaces:state.marketplaces})); process.exit(0); }
if (args.join(" ") === "plugin list --available --json") { process.stdout.write(JSON.stringify({installed:state.installed,available:state.available})); process.exit(0); }
state.mutations.push(args);
if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") {
  const refIndex = args.indexOf("--ref");
  const ref = refIndex >= 0 ? args[refIndex + 1] : null;
  state.marketplaces.push({name:"adaptive-model-router",marketplaceSource:{sourceType:"git",source:"https://github.com/Neil0619/adaptive-model-router.git",ref}});
  state.available=[{pluginId:"adaptive-model-router@adaptive-model-router",name:"adaptive-model-router",marketplaceName:"adaptive-model-router"}];
} else if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "remove") {
  state.marketplaces=state.marketplaces.filter((entry)=>entry.name!==args[3]);
  state.available=state.available.filter((entry)=>entry.marketplaceName!==args[3]);
} else if (args[0] === "plugin" && args[1] === "add") {
  if (!state.installed.some((entry)=>entry.pluginId===args[2])) state.installed.push({pluginId:args[2],name:"adaptive-model-router",marketplaceName:args[2].split("@")[1]});
} else if (args[0] === "plugin" && args[1] === "remove") {
  state.installed=state.installed.filter((entry)=>entry.pluginId!==args[2]);
}
save();
process.stdout.write("ok\\n");
`;

async function fakeCodex(project, initial = {}) {
  const bin = join(project.root, "fake bin");
  await mkdir(bin, { recursive: true });
  const source = join(bin, "fake-codex.mjs");
  const statePath = join(project.root, "fake-state.json");
  await writeFile(source, FAKE_SOURCE);
  const state = { marketplaces: [], installed: [], available: [], mutations: [], ...initial };
  await writeFile(statePath, JSON.stringify(state));
  let executable;
  if (process.platform === "win32") {
    executable = join(bin, "codex.cmd");
    await writeFile(executable, `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.mjs" %*\r\n`, "ascii");
  } else {
    executable = join(bin, "codex");
    await writeFile(executable, `#!${process.execPath}\n${FAKE_SOURCE}`);
    await chmod(executable, 0o755);
  }
  return { executable, statePath, bin };
}

function runManager(project, fake, args = []) {
  const codexHome = join(project.root, "Codex Home 空格");
  const result = spawnSync(process.execPath, [manager, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEX_BIN: fake.executable,
      FAKE_CODEX_STATE: fake.statePath,
    },
  });
  return { ...result, codexHome };
}

async function state(fake) {
  return JSON.parse(await readFile(fake.statePath, "utf8"));
}

test("runtime boundary accepts 24.15 and rejects 24.14", () => {
  assert.equal(supportsRuntime("24.14.9"), false);
  assert.equal(supportsRuntime("24.15.0"), true);
  assert.equal(supportsRuntime("25.0.0"), true);
});

test("install, upgrade, optional AGENTS patch, and uninstall are idempotent in a Unicode Codex Home", async () => {
  const project = await temporaryProject("adaptive installer Unicode 空格 ");
  try {
    const fake = await fakeCodex(project);
    const codexHome = join(project.root, "Codex Home 空格");
    await mkdir(codexHome, { recursive: true });
    const agents = join(codexHome, "AGENTS.md");
    await writeFile(agents, "User instructions.\n");

    const installed = runManager(project, fake, ["install", "--non-interactive"]);
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stdout, /v0\.3\.x/);
    assert.match(installed.stdout, /Compatible v0\.4\.x\+ runtime updates/);
    assert.match(installed.stdout, /upgrades preserve this setting/);
    assert.equal(await readFile(agents, "utf8"), "User instructions.\n");
    assert.equal((await state(fake)).installed.length, 1);

    const upgraded = runManager(project, fake, ["upgrade", "--non-interactive"]);
    assert.equal(upgraded.status, 0, upgraded.stderr);
    assert.equal((await state(fake)).installed.length, 1);

    assert.equal(runManager(project, fake, ["install", "--patch-agents", "--non-interactive"]).status, 0);
    assert.equal(runManager(project, fake, ["install", "--patch-agents", "--non-interactive"]).status, 0);
    await writeFile(agents, `${await readFile(agents, "utf8")}User edit after the owned block.\n`);
    const patched = await readFile(agents, "utf8");
    assert.equal(patched.split(AGENTS_MARKER_START).length - 1, 1);
    assert.equal(patched.split(AGENTS_MARKER_END).length - 1, 1);

    const removed = runManager(project, fake, ["uninstall", "--non-interactive"]);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(runManager(project, fake, ["uninstall", "--non-interactive"]).status, 0);
    const finalAgents = await readFile(agents, "utf8");
    assert.equal(finalAgents.includes(AGENTS_MARKER_START), false);
    assert.equal(finalAgents, "User instructions.\nUser edit after the owned block.\n");
    const finalState = await state(fake);
    assert.equal(finalState.installed.length, 0);
    assert.equal(finalState.marketplaces.length, 0);
  } finally {
    await project.cleanup();
  }
});

test("AGENTS patch and uninstall preserve the original content exactly", async () => {
  const project = await temporaryProject("adaptive installer exact AGENTS 空格 ");
  try {
    const fake = await fakeCodex(project);
    const codexHome = join(project.root, "Codex Home 空格");
    await mkdir(codexHome, { recursive: true });
    const agents = join(codexHome, "AGENTS.md");
    const originals = [
      "User instructions.\n",
      "User instructions.",
      "Windows instructions.\r\n\r\n",
      "",
    ];

    for (const original of originals) {
      await writeFile(agents, original);
      const installed = runManager(project, fake, ["install", "--patch-agents", "--non-interactive"]);
      assert.equal(installed.status, 0, installed.stderr);
      const removed = runManager(project, fake, ["uninstall", "--non-interactive"]);
      assert.equal(removed.status, 0, removed.stderr);
      assert.equal(await readFile(agents, "utf8"), original);
    }

    await rm(agents, { force: true });
    const installedWithoutFile = runManager(project, fake, ["install", "--patch-agents", "--non-interactive"]);
    assert.equal(installedWithoutFile.status, 0, installedWithoutFile.stderr);
    const removedWithoutFile = runManager(project, fake, ["uninstall", "--non-interactive"]);
    assert.equal(removedWithoutFile.status, 0, removedWithoutFile.stderr);
    await assert.rejects(access(agents), { code: "ENOENT" });
  } finally {
    await project.cleanup();
  }
});

test("upgrade accepts the current Codex marketplace shape using install metadata for the stable ref", async () => {
  const project = await temporaryProject("adaptive marketplace metadata Unicode 空格 ");
  try {
    const marketplaceRoot = join(project.root, "marketplace cache 中文");
    await mkdir(marketplaceRoot, { recursive: true });
    await writeFile(join(marketplaceRoot, ".codex-marketplace-install.json"), JSON.stringify({
      source_type: "git",
      source: "https://github.com/Neil0619/adaptive-model-router.git",
      ref_name: "stable",
      revision: "0123456789abcdef",
    }));
    const fake = await fakeCodex(project, {
      marketplaces: [{
        name: "adaptive-model-router",
        root: marketplaceRoot,
        marketplaceSource: {
          sourceType: "git",
          source: "https://github.com/Neil0619/adaptive-model-router.git",
        },
      }],
      installed: [{
        pluginId: "adaptive-model-router@adaptive-model-router",
        name: "adaptive-model-router",
        marketplaceName: "adaptive-model-router",
      }],
      available: [],
      mutations: [],
    });

    const result = runManager(project, fake, ["upgrade", "--non-interactive"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await state(fake)).mutations.map((args) => args.join(" ")), [
      "plugin marketplace upgrade adaptive-model-router",
      "plugin add adaptive-model-router@adaptive-model-router",
    ]);
  } finally {
    await project.cleanup();
  }
});

test("upgrade accepts a stable marketplace checkout when Codex omits install metadata", async () => {
  const project = await temporaryProject("adaptive marketplace checkout Unicode 空格 ");
  try {
    const marketplaceRoot = join(project.root, "marketplace checkout 中文");
    await mkdir(join(marketplaceRoot, ".git"), { recursive: true });
    await writeFile(join(marketplaceRoot, ".git", "HEAD"), "ref: refs/heads/stable\n");
    const fake = await fakeCodex(project, {
      marketplaces: [{
        name: "adaptive-model-router",
        root: marketplaceRoot,
        marketplaceSource: {
          sourceType: "git",
          source: "https://github.com/Neil0619/adaptive-model-router.git",
        },
      }],
      installed: [{
        pluginId: "adaptive-model-router@adaptive-model-router",
        name: "adaptive-model-router",
        marketplaceName: "adaptive-model-router",
      }],
      available: [],
      mutations: [],
    });

    const result = runManager(project, fake, ["upgrade", "--non-interactive"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await state(fake)).mutations.map((args) => args.join(" ")), [
      "plugin marketplace upgrade adaptive-model-router",
      "plugin add adaptive-model-router@adaptive-model-router",
    ]);
  } finally {
    await project.cleanup();
  }
});

test("upgrade rejects a non-stable marketplace checkout when Codex omits install metadata", async () => {
  const project = await temporaryProject();
  try {
    const marketplaceRoot = join(project.root, "marketplace-checkout");
    await mkdir(join(marketplaceRoot, ".git"), { recursive: true });
    await writeFile(join(marketplaceRoot, ".git", "HEAD"), "ref: refs/heads/main\n");
    const fake = await fakeCodex(project, {
      marketplaces: [{
        name: "adaptive-model-router",
        root: marketplaceRoot,
        marketplaceSource: {
          sourceType: "git",
          source: "https://github.com/Neil0619/adaptive-model-router.git",
        },
      }],
      installed: [],
      available: [],
      mutations: [],
    });

    const result = runManager(project, fake, ["upgrade", "--non-interactive"]);
    assert.equal(result.status, 4);
    assert.deepEqual((await state(fake)).mutations, []);
  } finally {
    await project.cleanup();
  }
});

test("upgrade rejects current Codex marketplace metadata for a different ref", async () => {
  const project = await temporaryProject();
  try {
    const marketplaceRoot = join(project.root, "marketplace-cache");
    await mkdir(marketplaceRoot, { recursive: true });
    await writeFile(join(marketplaceRoot, ".codex-marketplace-install.json"), JSON.stringify({
      source_type: "git",
      source: "https://github.com/Neil0619/adaptive-model-router.git",
      ref_name: "main",
      revision: "0123456789abcdef",
    }));
    const fake = await fakeCodex(project, {
      marketplaces: [{
        name: "adaptive-model-router",
        root: marketplaceRoot,
        marketplaceSource: {
          sourceType: "git",
          source: "https://github.com/Neil0619/adaptive-model-router.git",
        },
      }],
      installed: [],
      available: [],
      mutations: [],
    });

    const result = runManager(project, fake, ["upgrade", "--non-interactive"]);
    assert.equal(result.status, 4);
    assert.deepEqual((await state(fake)).mutations, []);
  } finally {
    await project.cleanup();
  }
});

test("legacy adaptive-local stops noninteractive installation before mutation with exact cleanup commands", async () => {
  const project = await temporaryProject();
  try {
    const initial = {
      marketplaces: [{ name: "adaptive-local", marketplaceSource: { sourceType: "local", source: "/legacy" } }],
      installed: [{ pluginId: "adaptive-model-router@adaptive-local", name: "adaptive-model-router", marketplaceName: "adaptive-local" }],
      available: [],
      mutations: [],
    };
    const fake = await fakeCodex(project, initial);
    const result = runManager(project, fake, ["install", "--non-interactive"]);
    assert.equal(result.status, 3);
    assert.match(result.stderr, /codex plugin remove adaptive-model-router@adaptive-local/);
    assert.match(result.stderr, /codex plugin marketplace remove adaptive-local/);
    assert.deepEqual((await state(fake)).mutations, []);
  } finally {
    await project.cleanup();
  }
});

test("explicit legacy migration removes old plugin then marketplace before installing the stable source", async () => {
  const project = await temporaryProject();
  try {
    const fake = await fakeCodex(project, {
      marketplaces: [{ name: "adaptive-local", marketplaceSource: { sourceType: "local", source: "/legacy" } }],
      installed: [{ pluginId: "adaptive-model-router@adaptive-local", name: "adaptive-model-router", marketplaceName: "adaptive-local" }],
      available: [], mutations: [],
    });
    const result = runManager(project, fake, ["install", "--yes"]);
    assert.equal(result.status, 0, result.stderr);
    const mutations = (await state(fake)).mutations.map((args) => args.join(" "));
    assert.deepEqual(mutations.slice(0, 4), [
      "plugin remove adaptive-model-router@adaptive-local",
      "plugin marketplace remove adaptive-local",
      "plugin marketplace add Neil0619/adaptive-model-router --ref stable",
      "plugin add adaptive-model-router@adaptive-model-router",
    ]);
  } finally {
    await project.cleanup();
  }
});

test("an explicit release-candidate ref is required consistently for install, upgrade, and uninstall", async () => {
  const project = await temporaryProject();
  try {
    const candidateRef = "codex/v030-smoke-handoff";
    const fake = await fakeCodex(project);
    const invalid = runManager(project, fake, ["install", "--ref=../untrusted", "--non-interactive"]);
    assert.equal(invalid.status, 2);
    assert.deepEqual((await state(fake)).mutations, []);

    const installed = runManager(project, fake, ["install", `--ref=${candidateRef}`, "--non-interactive"]);
    assert.equal(installed.status, 0, installed.stderr);
    assert.deepEqual((await state(fake)).mutations.slice(0, 2).map((args) => args.join(" ")), [
      `plugin marketplace add Neil0619/adaptive-model-router --ref ${candidateRef}`,
      "plugin add adaptive-model-router@adaptive-model-router",
    ]);

    const wrongUpgrade = runManager(project, fake, ["upgrade", "--non-interactive"]);
    assert.equal(wrongUpgrade.status, 4);
    const upgraded = runManager(project, fake, ["upgrade", `--ref=${candidateRef}`, "--non-interactive"]);
    assert.equal(upgraded.status, 0, upgraded.stderr);

    const wrongUninstall = runManager(project, fake, ["uninstall", "--non-interactive"]);
    assert.equal(wrongUninstall.status, 4);
    const removed = runManager(project, fake, ["uninstall", `--ref=${candidateRef}`, "--non-interactive"]);
    assert.equal(removed.status, 0, removed.stderr);
  } finally {
    await project.cleanup();
  }
});

test("same marketplace name from another source and partial AGENTS markers fail before mutation", async () => {
  const project = await temporaryProject();
  try {
    const conflict = await fakeCodex(project, {
      marketplaces: [{ name: "adaptive-model-router", marketplaceSource: { sourceType: "git", source: "someone/else", ref: "stable" } }],
      installed: [], available: [], mutations: [],
    });
    const sourceFailure = runManager(project, conflict, ["install", "--non-interactive"]);
    assert.equal(sourceFailure.status, 4);
    assert.deepEqual((await state(conflict)).mutations, []);

    const clean = await fakeCodex(project);
    const codexHome = join(project.root, "Codex Home 空格");
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, "AGENTS.md"), `${AGENTS_MARKER_START}\npartial\n`);
    const markerFailure = runManager(project, clean, ["install", "--patch-agents", "--non-interactive"]);
    assert.equal(markerFailure.status, 6);
    assert.deepEqual((await state(clean)).mutations, []);
  } finally {
    await project.cleanup();
  }
});

test("platform wrapper performs the same native installation flow", async () => {
  const project = await temporaryProject();
  try {
    const fake = await fakeCodex(project);
    const codexHome = join(project.root, "wrapper home 空格");
    const candidateRef = "codex/v030-smoke-handoff";
    let result;
    if (process.platform === "win32") {
      result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(repoRoot, "install.ps1"), "-NonInteractive", "-Ref", candidateRef], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${fake.bin};${dirname(process.execPath)};${process.env.PATH}`, CODEX_HOME: codexHome, FAKE_CODEX_STATE: fake.statePath },
      });
    } else {
      result = spawnSync("sh", [join(repoRoot, "install.sh"), `--ref=${candidateRef}`, "--non-interactive"], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${fake.bin}:${dirname(process.execPath)}:${process.env.PATH}`, CODEX_HOME: codexHome, FAKE_CODEX_STATE: fake.statePath },
      });
    }
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await state(fake)).installed.length, 1);
    assert.equal((await state(fake)).marketplaces[0].marketplaceSource.ref, candidateRef);
  } finally {
    await project.cleanup();
  }
});
