# Adaptive Model Router

Adaptive Model Router 是一个 local-first 的 Codex 插件。它会在有意义的任务阶段边界上判断：继续由当前任务处理、询问用户，还是把一个边界明确的阶段委派给指定的可用模型与 reasoning effort。

它**不会热切换根任务模型**。根任务始终负责统筹、集成、验证和用户沟通。

[English README](README.md) · [文档导航](docs/README.md) · [工具接口](docs/TOOLS.md)

## 安装

要求：Codex Desktop 或 CLI、Git、Node.js 24.15.0 及以上。支持 Windows 11 原生 PowerShell、macOS 和 Linux。

Codex Desktop 解析到的 `node` 可能与交互式终端不同。插件启动器仍严格要求 24.15+，并会依次从 `ADAPTIVE_ROUTER_NODE`、`PATH`、常见 Node 版本管理器及 Windows/macOS/Linux 标准安装位置寻找合格运行时；不会退回旧版 Node 执行路由器。

原生 Codex 命令是主安装路径，无需执行远程脚本：

```bash
codex plugin marketplace add Neil0619/adaptive-model-router --ref stable
codex plugin add adaptive-model-router@adaptive-model-router
```

安装后请启动一个新任务，打开 `/hooks`，分别审阅并信任插件提供的
`UserPromptSubmit` 和 `Stop` 命令处理器。如果 ChatGPT 桌面端仍显示旧的
插件状态，请重启应用并再创建一个新任务。

自动路由需要明确开启。在这个新任务中单独发送一次以下命令，即可为共享同一插件
数据的所有本地 Codex 项目开启默认自动路由：

```text
路由器：全局开启
```

安装或升级不会静默替你打开这个设置。

仓库内也提供带环境检查、旧版检测和明确错误码的包装脚本：

```bash
./install.sh
./install.sh --patch-agents
```

```powershell
.\install.ps1
.\install.ps1 -PatchAgents
```

默认不会修改 `~/.codex/AGENTS.md`。只有显式使用 `--patch-agents` 或 `-PatchAgents` 才写入带起止标记的自有段落；重复执行不会重复写入，卸载只删除该段落。

检测到旧 `adaptive-local` 安装时，交互模式会先询问；非交互模式会在任何修改前停止并打印两条精确清理命令。旧历史不会自动加入当前学习窗口。

## 升级与卸载

```bash
codex plugin marketplace upgrade adaptive-model-router
codex plugin add adaptive-model-router@adaptive-model-router
```

```bash
codex plugin remove adaptive-model-router@adaptive-model-router
codex plugin marketplace remove adaptive-model-router
```

包装脚本对应为 `./install.sh upgrade`、`./install.sh uninstall`、`.\install.ps1 -Action Upgrade` 和 `.\install.ps1 -Action Uninstall`。

Windows 环境问题参见[故障排查](docs/TROUBLESHOOTING.md)。发布维护者应直接使用
[原生 Windows 11](docs/WINDOWS_SMOKE.md)和
[原生 macOS](docs/MACOS_SMOKE.md)冒烟手册，不要根据 README 临时拼装发布测试。
在 Windows 上打开仓库后，可以直接让 Codex“完整读取该手册、逐项执行、按模板回传，
但不要创建或推送 `v0.3.1` tag”。

## 路由规则

全局自动开启后，受信任的 `UserPromptSubmit` hook 会为普通任务加入一小段工作流
上下文。Codex 会在实质性阶段自动使用路由器，不再要求每次写
`$adaptive-model-router`；问候和不产生工作产物的简单问题仍由根任务直接处理。

`route_stage` 只返回三种动作：

- `continue`：问候、简单问答和不产生工作产物的短任务；
- `delegate`：返回 `target.model` 和 `target.effort`，用于一个 bounded subagent；
- `ask_user`：显式目标不可用，或 reasoning failure 达到自动升级上限。

优先级固定为：本次请求、once、session、project、可选 global、已批准项目策略、默认均衡策略。隐藏模型和未知模型不会自动入选；显式目标不可用时不会静默替换。

根模型可见目录、bounded subagent 能力和辅助分类器使用三套独立目录。Codex
选择器里能看到某个模型，不代表它可以作为 subagent。调用方通过
`hostCapabilities` 提交当前宿主真实支持的 bounded 模型和 effort；旧调用方只会
保守允许已知的 Sol、Terra。当策略偏好 Luna、但宿主没有公开 Luna 委派能力时，
自动路由回退到 Terra 并返回 `MODEL_FAMILY_FALLBACK`；显式指定 Luna 则返回
`ask_user`，不会静默换模型。

每个委派都有 verification gate，并且最多记录一个严格最终 outcome。Stop hook 首次发现遗漏会提醒；继续后再次停止仍未提交，则记为不参与学习的 `unknown`。

`continue` 和 `ask_user` 路由不接受 outcome。严格输入输出、管理工具以及源码内
开发 CLI 参见[工具接口](docs/TOOLS.md)。

## 当前模型与委派历史

Codex 右下角模型选择器始终表示根任务，不会切换成 bounded subagent 的目标。
Hook 可以观察根模型 slug，但读不到 Max/High 等 reasoning effort；路由器不会切换
根模型或其 effort。
`delegate` 中的 `target.model`/`target.effort` 只是当前 bounded stage 的
subagent 目标。每次 `route_stage` 后，skill 会明确显示这条边界和本次动作。

当前任务首次观察到的模型只作为基线，不询问。如果随后 slug 发生变化，本轮和未
确认的后续轮次都只使用根模型继续，并询问“本任务手动”还是“保持自动”。仅从
Sol High 改为 Sol Max 这类 effort 变化无法被 Hook 检测。

随时发送以下命令查看当前状态或最近记录：

```text
路由器：状态
路由器：历史 10
```

英文等价命令为 `router: status` 和 `router: history 10`。历史包含 route 当时的
根模型快照、写入时间、action、bounded 目标模型/effort、相对前一次委派是否变化、原因、route ID
和 outcome，并且只限当前项目与任务。完整触发顺序、评分阈值以及“路由决定”和
“实际根模型切换”的区别参见[路由触发与历史](docs/ROUTING.zh-CN.md)。

## 本地学习与隐私

学习数据按项目隔离，统一保存在单个 SQLite 数据库。Git worktree 通过 common dir 共享项目身份；submodule 独立。数据库只保存本机随机盐生成的 HMAC，不保存原始绝对路径。

策略永不自动批准：

- 同类别至少 12 个新结果，且失败、纠正或重试的结果不少于 4 个，提议 `+5`；
- 同类别至少 20 个新结果，且没有失败、纠正和重试，提议 `-5`；
- offset 始终限制在 `[-15, 15]`。

批准和拒绝都会推进证据窗口；revision 不可变，连续 rollback 只沿父 revision 向后。

辅助分类器默认开启，但只接收不超过 2,000 字的脱敏摘要、阶段和布尔信号；不会收到任意 evidence、源码附件、路径或环境变量。超时、熔断和 local-only 模式都会确定性降级。

## 控制命令

只有从首字符开始的完整 `router:` 或 `路由器：` 前缀才会改变状态：

```text
路由器：全局开启
路由器：全局关闭
路由器：本任务手动
路由器：本任务自动
router: lock gpt-5.6-sol high session
router: auto session
router: off
路由器：启用
```

引用、代码块、否定句、行中前缀、第二行前缀和未知命令都不会修改状态。

## 开发与文档

```bash
cd plugins/adaptive-model-router
npm test
npm run validate
npm run eval
```

运行时无第三方依赖。可从[文档导航](docs/README.md)开始，或直接查看
[架构文档](docs/ARCHITECTURE.md)、[隐私说明](docs/PRIVACY.md)、
[故障排查](docs/TROUBLESHOOTING.md)、[贡献指南](CONTRIBUTING.md)和
[安全策略](SECURITY.md)。

本项目采用 Apache-2.0 许可证。
