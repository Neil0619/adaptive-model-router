# Adaptive Model Router

Adaptive Model Router 是一个 local-first 的 Codex 插件。它会在有意义的任务阶段边界上判断：继续由当前任务处理、询问用户，还是把一个边界明确的阶段委派给指定的可用模型与 reasoning effort。

它**不会热切换根任务模型**。根任务始终负责统筹、集成、验证和用户沟通。

[English README](README.md) · [文档导航](docs/README.md) · [工具接口](docs/TOOLS.md)

## 运行时协议 v2：隔离发布与受控安装

当前源码采用显式发布、任务绑定与阶段绑定。2026-09-14 已完成 macOS 受控安装及旧任务真实委派验收，见[安装证据](docs/evidence/runtime-v2-shell-repair-20260914.zh-CN.md)。原生 Windows 登录态验收仍待完成；本次通过不代表任意运行时改动都可以热发布。

需要 Node.js 24.15.0 或更新版本。当前源码的 `manage-install.mjs install`、`upgrade`、`repair` 会在宿主变更前拒绝。不要对本分支执行旧的 `./install.sh`、`./install.sh upgrade` 或 `./install.sh repair`；旧版发布文档对应 v1 loader。

请使用 [v2 安装与发布流程](docs/RUNTIME-UPGRADE-ISOLATION-IMPLEMENTATION.zh-CN.md) 和 [插件内命令说明](plugins/adaptive-model-router/RUNTIME.md)。首次转换需要明确的冷窗口：准备稳定入口、完整保留全部旧缓存路径、对精确已安装 v1 与 v2 做隔离同库验证，在**原数据库**登记两代运行时，再注册新入口并恢复历史路径后重开宿主。原模型策略、GPT-6 only、全局开启设置、未知责任、结果及全局 10 个未收尾预留的共同口径均保留。

日常代码发布从普通源码修改开始；命令自动继承已经登记的固定入口：

```bash
node /绝对路径/stable-entry/plugin/scripts/runtime-admin.mjs prepare \
  --source=/绝对路径/开发仓库/plugins/adaptive-model-router \
  --shell-root=/绝对路径/stable-entry/plugin \
  --candidates=/绝对路径/offline-candidates
node /绝对路径/stable-entry/plugin/scripts/runtime-admin.mjs publish \
  --candidate=/绝对路径/offline-candidates/返回的摘要 \
  --home=/绝对路径/原Router数据目录
```

`prepare` 不激活候选。`publish` 只改变新绑定任务的默认版本；A 的活动阶段继续使用 A。已有 v2 任务需要原生终态、无未决责任和候选资格才能迁移，失败或未知状态不会被当成已完成。

当前可兼容发布的**真实代码更新**限定为 `inferCategory` 中经过非执行语法验证的纯类别分支，并运行 A/B 交错、并发同库验收。其余 scorer、共享 writer、Hook 代码及原生适配器仍冻结；这些改动需要另行实现并验证兼容过渡，不能宣称所有日常运行时代码修复都已支持热升级。每个发布包的全部普通文件始终受完整性摘要覆盖。

普通原生子代理保持未托管旁路；Router 自身故障不应拦截根任务的普通诊断命令。Router 管理的调用仍保守拒绝，缺失的命令覆盖不会成为迁移证明。

现有显式 `uninstall` 路径保留，卸载不清除共享学习或无关配置。先停止 Router 进程并保存仍需要的旧任务入口；不要通过移除 marketplace 更新普通运行时，因为原生移除会删除旧缓存路径。

自动路由仍需显式 `router: global on`，安装与发布不擅自更改原开关或根模型。

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

新调用按实际行为契约验证，不再以 App/CLI 版本、平台标签、磁盘程序摘要或路径作为版本白名单。尚无证明的任务
可先收到 `delegate / HOST_LIFECYCLE_QUALIFICATION`：仅创建一个策略绑定的 GPT-6/low 子任务，
不携带原任务内容、不调用工具，只返回固定标记。服务端核验四个生命周期事件和完整
原始子任务记录后才接受通过结果。新证明绑定当前任务、Hook 的功能定义和信任、实际入口、运行时源码及所需契约。
App 版本、程序摘要、Hook 展示文案或无关插件的变化，不重新签发资格自检；实际功能依赖变化仍需核验。
旧资格和收据保留原文，历史资料充分时通过单独的承接证据继续使用，不把旧结果改写为新格式 passed。
失败、进行中、损坏或关联不明的尝试不会自动重试。自检不消耗
once override，也不进入学习；新证明通过服务端核验后，再对原阶段正常路由。

首次安装这项改造还涉及旧任务的运行时接续，不能使用原来的普通 `publish` 冒充接入完成。
具体边界见 [App 升级兼容方案](docs/HOST-UPGRADE-COMPATIBILITY-PLAN.zh-CN.md)及[开发验收记录](docs/evidence/host-upgrade-compatibility-20260914.zh-CN.md)。
未取得真实原生入口证据的旧任务继续保留原版本；开发测试结果不代表本机已全局安装。

优先级固定为：本次请求、once、session、project、可选 global、已批准项目策略、默认均衡策略。隐藏模型和未知模型不会自动入选；显式目标不可用时不会静默替换。

根模型可见目录、bounded subagent 能力和辅助分类器使用三套独立目录。Codex
选择器里能看到某个模型，不代表它可以作为 subagent。调用方通过
`hostCapabilities` 提交当前宿主可直接原生调用的 bounded 模型、effort 和调用模式；
只在 `functions.exec` 内可见的 spawn 工具一律视为不可委派。`list_agents` 只列出
已经存在的 Agent，空列表不代表 direct `spawn_agent` 不可用。同一任务一旦完成过
可信 direct child 派发，后续 unavailable 声明若没有绑定“直接工具实际拒绝且明确
未创建 child”的证据，就会被拒绝。缺少当前直接调用接口的能力信息时，不允许新委派。当前仅允许 GPT‑6 六档，
默认 high；常规选择集中在 medium/high/xhigh。允许范围、任务条件和目标绑定
分别配置，详见 [GPT‑6 规范](docs/MODEL-POLICY-GPT6.zh-CN.md)。

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

日常通知省略排查用的 route ID，委派阶段显示“阶段 · 模型 / effort”。
编号仍保留在路由记录、状态/历史查询和诊断中，不影响子任务关联或验收。
当前接口未提供子任务服务档位时省略 `service_tier` 字段，仅有该子任务的直接证据时才展示。
字段省略不代表 Fast 已关闭，也不会根据主任务 Fast 设置推测。仅观察到请求档位时会明确标注，
不会当作实际服务档位；该展示不修改 Fast 设置。

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
和 outcome，并且只限当前项目与任务。完整触发顺序、任务条件以及“路由决定”和
“实际根模型切换”的区别参见[路由触发与历史](docs/ROUTING.zh-CN.md)。

## 本地学习与隐私

学习数据按项目隔离，统一保存在单个 SQLite 数据库。Git worktree 通过 common dir 共享项目身份；submodule 独立。数据库只保存本机随机盐生成的 HMAC，不保存原始绝对路径。

策略永不自动批准：

GPT‑6 新策略只记录结果，旧 offset 不影响档位，也不从新路由产生在线偏移提案。
以下规则保留用于历史学习数据：

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

辅助分类器默认关闭（local-only）；显式开启时，只接收不超过 2,000 字的脱敏摘要、阶段和布尔信号；不会收到任意 evidence、源码附件、路径或环境变量。超时、熔断和 local-only 模式都会确定性降级。

## 控制命令

只有从首字符开始的完整 `router:` 或 `路由器：` 前缀才会改变状态：

```text
路由器：全局开启
路由器：全局关闭
路由器：本任务手动
路由器：本任务自动
router: lock gpt-6-astra high session
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
