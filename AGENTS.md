# Project instructions

## Automated logged-in smoke tests

- After the one-time Hook trust bootstrap, the agent owns the complete macOS
  and native Windows logged-in smoke. Do not ask the user to select models,
  run `/status`, copy controls, or paste test prompts when Codex-native task
  tools can perform the same operation.
- For host-model intent coverage, record the initial root model, wait until the
  target task is idle, then use a Codex-native task/thread model override on
  the next dispatched prompt. Verify the changed slug through the trusted Hook
  and router status/history, exercise pending, keep-automatic, and manual-root
  behavior, and restore the initial root model in a finally-style cleanup even
  when the smoke fails. Restore the initial reasoning effort too when the host
  exposes it, then verify the restored state.
- A task/thread model override is a Codex host operation used only by the smoke
  orchestrator. It is not a router override, not a bounded-subagent target, and
  must never be described as the router changing the root model.
- Do not use Computer Use to control the Codex UI, edit configuration, or
  restart Codex to imitate a model change. Selector and Subagents screenshots
  are optional corroborating evidence; trusted Hook observations, task state,
  route history, and outcome records are the blocking evidence.
- If the native task/thread surface cannot apply a supported model override,
  report a host-capability failure. Do not fall back to repeated human `/model`
  gates.
- Native Windows smoke uses Codex App's native task handoff and thread
  coordination from a persistent orchestrator that remains alive while the
  Windows target task is stopped or restarted. The target must not be expected
  to orchestrate after it exits. Never install, restore, or use the deprecated
  `windows-codex` project or any of its runners, hooks, skills, plugins, or SSH
  integration.
- Before a native Windows plugin add, upgrade, remove, or wrapper lifecycle,
  wait for bounded agents to finish and stop every Adaptive Router launcher and
  server process whose working directory is the target plugin cache. This
  includes MCP children started by the persistent orchestrator. Keep the Codex
  Desktop and coordinator process alive, and never terminate unrelated Node or
  Codex processes.
- When a logged-in smoke must use a disposable Codex CLI target, do not leave
  it on the interactive `on-request` approval policy. Codex CLI 0.145.0 on
  Windows and 0.146.0-alpha.9.2 on macOS cancel approval-gated router MCP calls
  under a never-approve policy; per-tool approval overrides are not reliable on
  those hosts. Run only that disposable smoke
  process with `--dangerously-bypass-approvals-and-sandbox`, keep it scoped to
  the temporary smoke project, and never combine it with
  `--dangerously-bypass-hook-trust` or a persistent configuration edit.
- Hook trust remains an explicit host security boundary. Ask for that one-time
  approval only when the current Hook hash is not already trusted; after trust,
  the smoke must run unattended through model restoration and the final report.
