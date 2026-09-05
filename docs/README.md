# Documentation

Adaptive Model Router is a pre-1.0 Codex plugin. Use this page to find the
smallest document for the job instead of treating the root README as the full
specification.

## Users

- [English README](../README.md): product boundary, installation, upgrade, and
  basic routing behavior.
- [中文 README](../README.zh-CN.md)：产品定位、安装、升级和基本路由规则。
- [Routing triggers and history](ROUTING.md) /
  [中文说明](ROUTING.zh-CN.md): exact trigger path, task conditions, visible
  current-stage target, and route history.
- [Tool reference](TOOLS.md): public MCP contracts, control scopes, outcomes,
  and the source-tree developer CLI.
- [Privacy](PRIVACY.md): local storage, classifier redaction, diagnostics, legacy
  data, and deletion.
- [Troubleshooting](TROUBLESHOOTING.md): installation, runtime, hook, catalog,
  classifier, and Windows-specific failures.

## Contributors

- [Architecture](ARCHITECTURE.md): component boundaries, route lifecycle,
  concurrency, and failure behavior.
- [GPT-6 quality-first routing and configurable scope（中文规范）](MODEL-POLICY-GPT6.zh-CN.md):
  GPT-6 only, default high, all six host-supported effort levels, shared model constraints,
  escalation, versioned scope changes, migration, and implementation acceptance.
  Installed and verified on native macOS; the
  [installation record](evidence/gpt6-installation-validation.zh-CN.md) records
  the evidence and the pending native Windows acceptance.
- [Contributing](../CONTRIBUTING.md): development setup, invariants, and checks.
- [Security policy](../SECURITY.md): vulnerability reporting and trust boundary.

## Maintainers

- [Release checklist](RELEASE.md): automated gates, signed tag, artifacts, and
  protected `stable` advancement.
- [Native Windows 11 smoke test](WINDOWS_SMOKE.md): a self-contained handoff that
  can be given to Codex on a Windows machine.
- [Native macOS smoke test](MACOS_SMOKE.md): the equivalent logged-in native
  macOS gate for automatic routing and host-model intent.
- [Changelog](../CHANGELOG.md): release-visible behavior changes.
- [2026-08-14 hot-upgrade incident](INCIDENT-2026-08-14-HOT-UPGRADE.md): root
  cause, corrective controls, and the superseded original replacement-task
  conclusion.
- [2026-08-14 Desktop MCP bootstrap incident](INCIDENT-2026-08-14-DESKTOP-MCP-BOOTSTRAP.md):
  MCP/Hook bare-Node PATH failures, bridge-based old-task recovery,
  installed-command verification, and permanent upgrade regression controls.

The release checklist is authoritative for release gates. The platform
runbooks are authoritative for native Windows and macOS smoke procedures.

## Official Codex references

- [Build plugins](https://learn.chatgpt.com/docs/build-plugins)
- [Hooks](https://learn.chatgpt.com/docs/hooks)
- [Codex developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
- [ChatGPT desktop app for Windows](https://learn.chatgpt.com/docs/windows/windows-app)

These links define the host behavior. This repository's documents define the
router-specific contracts and release gates.
