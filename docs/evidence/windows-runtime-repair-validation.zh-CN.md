# Windows 运行时修复验证

2026-09-06，原生 Windows 11 Pro x64（10.0.26220）、PowerShell 7.6.5、Node.js 24.18.0、Codex CLI 0.153.4。
分支为 `codex/fix-router-runtime-repair`，基线为 `dbff000e394b29fbbd6cb949930e0651a7711051`。
修复版安装运行时为 `0.4.0+codex.20260906014558`；安装源码摘要与工作树一致。

本次当前账号下的 Windows 功能验收通过。此记录不是 `v0.4.0` 正式发布门禁的 PASS 证明。

## 已修复的问题

- Codex 使用任务的 PowerShell 派发 Hook，原有带引号的 Node 命令无法作为 PowerShell 调用执行。Windows 安装命令改为固定系统 PowerShell 包装，内部通过调用运算符启动绝对路径 Node；安装验证同时覆盖 cmd 与 PowerShell 的空 PATH 环境。
- PATH 中旧 npm shim 会遮蔽 Desktop 原生 CLI，`where.exe` 输出解码还会损坏 Unicode 路径。Windows 发现流程优先原生可执行文件，使用文件系统读取 PATH，并继续尊重显式 `CODEX_BIN`。
- 原生插件目录输出可能超过默认 1 MiB 缓冲区；安装身份验证提高到 16 MiB，并继承所选命令的启动环境。
- Windows CLI 0.153.4 增加独立的完整记录审计适配器。未知版本、隐藏工具动作和不完整记录仍拒绝准入；每个任务仍需独立证明当前 Hook、可执行文件、运行时及父子任务绑定。
- 全局自动路由关闭时，显式 `$adaptive-model-router` 调用缺少可信任务上下文。现仅提供调用所需身份，保留自动路由开关和控制规则。
- 安装器识别当前 CLI 仅返回目录的本地市场条目，仍拒绝其他目录或显式不匹配来源。原生探针清理临时目录时，对 Windows 句柄释放延迟进行有限重试。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| 完整 `npm test` | 290 项：280 通过，0 失败，0 取消，10 跳过；625597 ms |
| `npm run validate`、插件清单校验、PowerShell 语法、`git diff --check` | 通过 |
| `npm run eval` | 232 项策略一致性用例，0 偏差；不衡量模型质量 |
| 原地兼容升级及安装内容 | 通过；源码摘要一致，7/7 当前 Hook 可信，Desktop 保持运行 |
| 新登录态 CLI 工具调用 | `diagnose_router`、`route_stage` 各成功一次 |
| 无效委派票据 | 原生 PreToolUse 阻止；0 子任务 |
| 生产 MCP 委派闭环 | 资格验证与普通委派各一个无工具探针子任务；2 次完整记录审计、2 个 passed outcome，待处理结果归零 |
| 根模型与子任务目标 | 根为 GPT-6 high，子任务为 GPT-6 low；根模型保持不变 |
| 控制、能力及模型范围 | 原生 Hook 全局开启、会话关闭/恢复通过；引用文本不触发控制；无能力时 continue，显式 Luna 返回 ask_user 且未启动子任务 |
| 只读与持久化 | shadow 与 learning 无状态写入；诊断健康且不含路径/原始上下文；两个临时项目共享全局设置，任务状态隔离 |

跳过项为 9 项既有 POSIX 专用检查，以及 1 项受本机文件符号链接权限限制的子测试。
安装锁测试保留所有断言，将超时预算从 20 秒调整为 60 秒；本轮实际通过。
根模型意图变化由离线测试覆盖，没有执行跨模型登录态切换。

原始记录在子任务归档后再次读取，字节数及 SHA-256 均与审计结果一致。
可提交的脱敏证据见 [原生 Windows 验证](windows-cli1534-native-validation.json) 和 [宿主源码核对](windows-cli1534-static-source-review.json)。
测试用控制设置写入隔离的临时 Router 数据目录，结束前恢复关闭并清理；未清理用户学习数据。

## 发布验收边界

`scripts/windows-smoke.ps1` 的 17 项正式发布门禁未运行。它要求专用、已登录的 Codex Home，以及实际同一 Desktop 任务跨兼容升级的 continuity receipt；本次未提供这些证据。
CLI 探针、Desktop 进程保持存活和实现层热升级测试，均未被记为同一 Desktop 任务的连续性证明。
没有创建发布标签，也没有生成或复用正式发布 PASS receipt。
