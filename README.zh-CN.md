# Adaptive Model Router

Adaptive Model Router 是一个 local-first 的 Codex 插件。它会在有意义的任务阶段边界上判断：继续由当前任务处理、询问用户，还是把一个边界明确的阶段委派给指定的可用模型与 reasoning effort。

它**不会热切换根任务模型**。根任务始终负责统筹、集成、验证和用户沟通。

[English README](README.md) · [文档导航](docs/README.md) · [工具接口](docs/TOOLS.md)

## 安装

要求：Codex Desktop 或 CLI、Git、Node.js 24.15.0 及以上。支持 Windows 11 原生 PowerShell、macOS 和 Linux。

Codex Desktop 的 `PATH` 可能比交互式终端更精简。安装器会把合格 Node 的绝对路径物化到已安装 MCP transport 和当前平台的全部 Hook 命令，并用空 `PATH` 验证这些真实启动命令。启动后，插件启动器仍严格要求 24.15+，并会依次从 `ADAPTIVE_ROUTER_NODE`、`PATH`、常见 Node 版本管理器及 Windows/macOS/Linux 标准安装位置寻找合格运行时；不会退回旧版 Node 执行路由器。

如果任务是在 MCP 启动故障期间创建的，其原生函数清单可能已经冻结。兼容升级会让该任务通过已验证的一次性 stdio bridge 调用同一个已安装 MCP `tools/call`，无需重启 Desktop，也无需新建替代任务。

受审阅的仓库包装脚本是受支持的安装路径。它在内部使用原生 Codex 命令，并继续物化、
验证真实的 Desktop 启动契约：

```bash
git clone --branch stable --single-branch https://github.com/Neil0619/adaptive-model-router.git
cd adaptive-model-router
./install.sh
```

```powershell
git clone --branch stable --single-branch https://github.com/Neil0619/adaptive-model-router.git
Set-Location adaptive-model-router
.\install.ps1
```

直接执行 `codex plugin add` 会把源码中的可移植占位命令 `node` 写入宿主缓存。它只是
冷注册操作，不是本插件完整的 Desktop 安全安装。若开发或恢复时执行过该命令，必须
立即运行 `./install.sh repair` 或 `.\install.ps1 -Action Repair`。repair 不改变
marketplace 身份，也不重新注册插件；它会物化当前安装、恢复正在运行的 Desktop
兼容 shim，并验证 MCP、Hooks 与旧任务 bridge。

安装后请启动一个新任务，打开 `/hooks`，分别审阅并信任插件提供的
`SessionStart(source=compact)`、`SubagentStart`、`SubagentStop`、
`PreToolUse(Agent)`、`PostToolUse(Agent)`、`UserPromptSubmit` 和 `Stop`
命令处理器。如果 ChatGPT 桌面端仍显示旧的插件状态，请重启应用并再创建一个新任务。

Router 只接受 Codex 提供的非空 `session_id` 作为稳定任务身份，绝不使用
`turn_id` 兜底。可信压缩会话处理器会在自动或手动压缩后、同一回合立即继续之前
重新注入相同的路由上下文。

自动路由需要明确开启。在这个新任务中单独发送一次以下命令，即可为共享同一插件
数据的所有本地 Codex 项目开启默认自动路由：

```text
路由器：全局开启
```

安装或升级不会静默替你打开这个设置。

包装脚本还支持在明确请求时写入 AGENTS 规则：

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
./install.sh upgrade
```

```powershell
.\install.ps1 -Action Upgrade
```

如果健康注册由裸 `plugin add` 创建，或 Codex 更新替换了 Desktop runtime 目录，可
执行原地修复：

```bash
./install.sh repair
```

```powershell
.\install.ps1 -Action Repair
```

```bash
codex plugin remove adaptive-model-router@adaptive-model-router
codex plugin marketplace remove adaptive-model-router
```

卸载包装脚本为 `./install.sh uninstall` 和 `.\install.ps1 -Action Uninstall`。

安装器始终核验不可变安装包、已注册 MCP 命令和 MCP 工具契约。冷首次安装时，
`--verify-task-tools`（macOS/Linux）或 `-VerifyTaskTools`（Windows）还会启动一个
一次性登录态 Codex CLI 任务，并要求实际调用 `diagnose_router` 与 `route_stage`。
兼容热升级时，同一参数只执行固定壳内的 MCP、Hook 与 stdio bridge 探针，不启动
新 CLI 任务，因为新任务可能触发宿主重整正在使用的插件缓存。两类结果都不能代替
下文“同一个 Desktop 任务跨升级”的连续性验收。

兼容热升级必须使用仓库包装脚本。脚本在刷新 marketplace 前，先把所有已验证的兼容
运行壳归档到稳定 plugin data 下的严格原子 vault；刷新后重新读取宿主注册，再把已
审阅的新包原子旁加载成不可变兄弟运行时。若 Codex 在重整时清理了旧的宿主缓存，包装
脚本会先把索引中的历史壳恢复到原来的不可变路径，再刷新其 live bridge。冷安装也会
为当前运行时建立首个归档；若刷新在清理缓存后失败，脚本会先恢复历史壳再返回失败。
整个安装生命周期由 plugin data 下的 SQLite 事务跨进程串行化，安装器退出或崩溃后
事务会自动释放；索引只在持锁时合并写入，已验证的不可变归档不会被原地替换。整个热
路径不会调用 `codex plugin add`，也不会请求插件
重新注册；直接执行 `plugin add` 属于冷安装/替换，不是热升级操作。

vault 只保存经过验证的插件包副本和运行时目录名索引，位于宿主管理缓存之外；它不
保存 prompt、项目数据或路由数据库，也不是可绕过校验的备用执行源。历史壳恢复前
必须匹配自身已索引的 host surface、受支持 Hook 集合和当前共享 runtime/storage
兼容契约；当前版本还必须完整匹配当前源码表面，再以目录 rename 原子安装。索引、
历史 Hook 集合或归档损坏时升级会 fail closed。

v0.4.0 增加了稳定启动壳。安装后续兼容的 v0.4.x 或更高版本后，已经打开的任务会在
下一次 Hook 或 MCP 调用时加载新实现，不需要更换根模型，也不必重新开任务。旧壳会先
核对 shell、工具和存储契约，在隔离目录运行健康探针，再原子切换活动运行时；候选
失败会被隔离，并继续使用上一版。

升级边界固定如下：

| 操作 | 已有原生 Router 工具的任务 | 原生工具库存已冻结的任务 |
| --- | --- | --- |
| 兼容热升级 | 保留原生函数，并在下次调用激活兼容兄弟运行时 | 保留同一任务并使用受限 stdio bridge；升级不会向库存注入原生工具 |
| 冷安装/替换 | 审阅变化的 Hook/契约，并创建真正全新的非派生任务 | 审阅变化的 Hook/契约，并创建真正全新的非派生任务 |

从 v0.3.x 升到 v0.4.0 属于冷替换，因为 v0.3 没有稳定启动壳。Skill 的名称和描述
是固定的宿主身份；live-read 工作流 body 与 bridge 只有在候选版本声明匹配的
插件根目录 `compatibility.json` 中的 `liveWorkflowContractVersion` 和
`stdioBridgeContractVersion` 时才允许兼容刷新。Hook JSON、MCP Schema、存储语义、
Skill identity、UI metadata 或任一工作流契约发生不兼容变化时，升级必须在改写
宿主注册前返回 `HOST_RELOAD_REQUIRED`。重启 Desktop 或 fork 都不会改变任务的
原生工具库存；bridge 是兼容升级的连续性通道，不是原生工具注入。

Windows 环境问题参见[故障排查](docs/TROUBLESHOOTING.md)。发布维护者应直接使用
[原生 Windows 11](docs/WINDOWS_SMOKE.md)和
[原生 macOS](docs/MACOS_SMOKE.md)冒烟手册，不要根据 README 临时拼装发布测试。
在 Windows 上打开仓库后，可以直接让 Codex“完整读取该手册、逐项执行、按模板回传，
但不要创建或推送 `v0.4.0` tag”。

## 路由规则

全局自动开启后，受信任的 `UserPromptSubmit` hook 会为普通任务加入一小段工作流
上下文。Codex 会在实质性阶段自动使用路由器，不再要求每次写
`$adaptive-model-router`；问候和不产生工作产物的简单问题仍由根任务直接处理。

根任务创建 bounded subagent 后，`SubagentStart` 和子代理自己的 prompt hook
会把自动路由指令替换成固定的隔离指令。子代理只执行父任务分配的阶段：不观察根
模型意图、不修改路由控制、不再次调用 `route_stage`，也不负责 route outcome。
验证和 `record_outcome` 始终由根任务完成。

`route_stage` 只返回四种动作：

- `continue`：问候、简单问答和不产生工作产物的短任务；
- `delegate`：返回 `target.model` 和 `target.effort`，用于一个 bounded subagent；
- `busy`：当前任务已有一个尚未闭合的 Router 子代理，不再创建第二个；
- `ask_user`：显式目标不可用，或 reasoning failure 达到自动升级上限。

在返回普通工作的 `delegate` 前，插件通过 Codex 的只读 `hooks/list` 接口确认当前安装中的七个
Router Hook 与插件定义一致、已启用且受信任；同时还要求 source-owned 原生证明确认
当前精确宿主的 Agent 路径真实派发完整 `PreToolUse`/`PostToolUse` 生命周期。未信任时
返回 `HOOK_TRUST_REQUIRED`，定义不一致时返回 `HOST_HOOK_SET_MISMATCH`，无法读取时返回
`HOST_HOOK_STATUS_UNAVAILABLE`，缺少原生往返证明时返回
`HOST_LIFECYCLE_ROUND_TRIP_UNPROVEN`；四种情况都只允许根任务继续，不签发委派
ticket。这个检查不会写 `config.toml`，也不会替用户确认 Hook 信任。

对于已明确支持的 macOS 原生构建（`0.153.0`、`0.153.0-alpha.5`），尚无证明的任务
可先收到 `delegate / HOST_LIFECYCLE_QUALIFICATION`：仅创建一个 Sol/low 子任务，
不携带原任务内容、不调用工具，只返回固定标记。服务端核验四个生命周期事件和完整
原始子任务记录后才接受通过结果。证明绑定当前任务、可执行文件、完整有序 Hook
清单、实际 Hook 入口和运行时源码；失败或绑定变化后仍禁止普通委派，不会自动重试
自检。自检不消耗 once override，也不进入学习；成功后再对原阶段正常路由。

优先级固定为：本次请求、once、session、project、可选 global、已批准项目策略、默认均衡策略。隐藏模型和未知模型不会自动入选；显式目标不可用时不会静默替换。

根模型可见目录、bounded subagent 能力和辅助分类器使用三套独立目录。Codex
选择器里能看到某个模型，不代表它可以作为 subagent。调用方通过
`hostCapabilities` 提交当前宿主可直接原生调用的 bounded 模型、effort 和调用模式；
只在 `functions.exec` 内可见的 spawn 工具一律视为不可委派。`list_agents` 只列出
已经存在的 Agent，空列表不代表 direct `spawn_agent` 不可用。同一任务一旦完成过
可信 direct child 派发，后续 unavailable 声明若没有绑定“直接工具实际拒绝且明确
未创建 child”的证据，就会被拒绝。旧调用方只会
保守允许已知的 Sol、Terra。当策略偏好 Luna、但宿主没有公开 Luna 委派能力时，
自动路由回退到 Terra 并返回 `MODEL_FAMILY_FALLBACK`；显式指定 Luna 则返回
`ask_user`，不会静默换模型。

每个委派都有 verification gate，并且最多记录一个严格最终 outcome。只有匹配的
`PreToolUse` 派发握手消费 ticket 后，首次 outcome 写入才会被接受；只有 route 决定、
没有真实派发尝试时不存在验证结果。活动 gate 会优先返回 `busy`，不会被后续
unavailable 声明遮蔽。如果根任务试图带着尚未派发的 delegate 结束，Stop hook 会
阻止第一次结束并指出必须执行的 direct `spawn_agent`。若受保护的 Stop 重入时 ticket
仍未消费，Router 会把生命周期标记为 ambiguous 并继续保留 gate；在没有权威
no-child 证据时，它不会归档 attempt、释放预留、创建 outcome 或允许替代 child。

只有匹配的 `PostToolUse`、子代理终态（`SubagentStop` 或宿主明确证明未创建子代理）
和 outcome 全部到达后才释放已派发 gate；派发后的未知、缺失或关联不唯一都会保持 gate。Stop hook
不会伪造 `unknown` outcome。

辅助分类器复用宿主现有的已登录 App Server 状态，并且只创建 `ephemeral` thread；
它不会再把 `CODEX_SQLITE_HOME` 指向空临时库。脱敏输入、统一 deadline 和熔断规则不变。

`continue`、`busy` 和 `ask_user` 路由不接受 outcome。严格输入输出、管理工具以及源码内
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

- 同类别至少 12 个合格结果、来自至少 4 个不同任务 context，且失败、纠正或
  reasoning retry 的结果不少于 4 个，提议 `+5`；
- 同类别至少 20 个合格结果、来自至少 5 个不同任务 context，且没有失败、纠正
  和 reasoning retry，提议 `-5`；
- offset 始终限制在 `[-15, 15]`。

显式 override、分类器调整、升级后的 route、unknown 结果，以及 environment、
information、tooling failure 不参与在线锚定。每条委派会保存不含 prompt 的脱敏
评分快照，重启后仍可审计证据是否合格。

批准和拒绝都会推进证据窗口；revision 不可变，连续 rollback 只沿父 revision
向后。离线重锚必须显式确认并安装更高版本的不可变评分 profile，不会自动批准
类别 offset。Shadow 评分不创建 route 或学习记录。只有违反风险底线时才自动回滚
评分 profile。

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

本地使用 Codex plugin cachebuster helper 改写版本后，应先运行
`npm run sync-runtime-version`，再执行校验，确保 `runtime.json` 与缓存版本一致。

运行时无第三方依赖。可从[文档导航](docs/README.md)开始，或直接查看
[架构文档](docs/ARCHITECTURE.md)、[隐私说明](docs/PRIVACY.md)、
[故障排查](docs/TROUBLESHOOTING.md)、[贡献指南](CONTRIBUTING.md)和
[安全策略](SECURITY.md)。

本项目采用 Apache-2.0 许可证。
