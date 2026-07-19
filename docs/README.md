# Documentation

Adaptive Model Router is a pre-1.0 Codex plugin. Use this page to find the
smallest document for the job instead of treating the root README as the full
specification.

## Users

- [English README](../README.md): product boundary, installation, upgrade, and
  basic routing behavior.
- [中文 README](../README.zh-CN.md)：产品定位、安装、升级和基本路由规则。
- [Tool reference](TOOLS.md): public MCP contracts, control scopes, outcomes,
  and the source-tree developer CLI.
- [Privacy](PRIVACY.md): local storage, classifier redaction, diagnostics, legacy
  data, and deletion.
- [Troubleshooting](TROUBLESHOOTING.md): installation, runtime, hook, catalog,
  classifier, and Windows-specific failures.

## Contributors

- [Architecture](ARCHITECTURE.md): component boundaries, route lifecycle,
  concurrency, and failure behavior.
- [Contributing](../CONTRIBUTING.md): development setup, invariants, and checks.
- [Security policy](../SECURITY.md): vulnerability reporting and trust boundary.

## Maintainers

- [Release checklist](RELEASE.md): automated gates, signed tag, artifacts, and
  protected `stable` advancement.
- [Native Windows 11 smoke test](WINDOWS_SMOKE.md): a self-contained handoff that
  can be given to Codex on a Windows machine.
- [Changelog](../CHANGELOG.md): release-visible behavior changes.

The release checklist is authoritative for release gates. The Windows runbook
is authoritative for the native Windows manual smoke procedure.

## Official Codex references

- [Build plugins](https://learn.chatgpt.com/docs/build-plugins)
- [Hooks](https://learn.chatgpt.com/docs/hooks)
- [Codex developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
- [ChatGPT desktop app for Windows](https://learn.chatgpt.com/docs/windows/windows-app)

These links define the host behavior. This repository's documents define the
router-specific contracts and release gates.
