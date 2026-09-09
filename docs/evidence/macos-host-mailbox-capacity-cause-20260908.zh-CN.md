# 子代理数量上限故障：原因调查

日期：2026-09-08。范围：确认原因；未实施新的运行时修复、安装、配置修改、业务操作或提交。

**原因已确认：Codex 0.153.4 的 V2 子代理虽然显示完成，但只要消息队列仍有未处理消息，就不能被自动回收。本次任务在同一宿主运行期间积累了 3 个这样的子代理，占满 3 个驻留名额，下一次创建因此被拒绝。**

该结论由原始任务记录、对应版本宿主源码和当前安装二进制的隔离对照实验共同支持。实验没有修改原 Hosted 任务；本报告不表示该任务已经恢复委派。

## 实际限制与回收条件

本机配置为 `agents.max_threads=3`；故障任务的原生上下文声明包含主任务共 4 个并发名额。V2 将这个总数减去主任务，得到 3 个子代理名额。配置解析见对应版本的[有效子代理上限](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/config/mod.rs#L1562)和[旧配置兼容转换](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/config/mod.rs#L2691)。

宿主分别管理执行容量和驻留容量。驻留名额满时，创建操作会尝试按最近使用顺序卸载可回收的子代理；找不到候选对象，才返回 `AgentLimitReached`。因此串行委派可以累计超过 3 次，完成后也不必立即销毁代理。[驻留准入与自动回收实现](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/agent/control/residency.rs#L80)

可回收条件必须同时满足：状态为 completed/errored/interrupted、没有活动中的 turn、没有待处理的 mailbox 消息。最后一个条件直接阻止本次三个已完成子代理被卸载。[完整回收条件](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/agent/control/residency.rs#L233)

`send_message` 使用 QueueOnly，不会主动启动下一轮。宿主在收尾时可以把这种消息留给下一轮，同时让当前任务完成。这就形成“显示完成、消息尚未处理、无法回收”的状态。[发送实现](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/tools/handlers/multi_agents_v2/send_message.rs#L39)、[收尾时延后消息的实现](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/session/input_queue.rs#L211)

源码来自官方 `rust-v0.153.4`，提交 `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`。实际实验运行的是本机已安装的 `/Applications/ChatGPT.app/Contents/Resources/codex`，SHA-256 为 `a30ec314bbd0e3721632234d07db7c99855db3b9f1e32dbe8c791947f07e7629`；没有编译或替换宿主。

## 原始事故时间线

任务：**完成 Hosted 验收并上线生产**，`01a07b17-5336-7172-b6ec-2e82ea6fb882`。

本次主 App Server 于北京时间 2026-09-08 09:44:40 启动，PID 11292；故障期间没有重新启动该主进程。以下时间均为同日北京时间。

| 子代理 | 主任务发送消息 | 子代理报告完成 | 拒绝发生前是否收到该条消息 |
| --- | --- | --- | --- |
| Ptolemy | 10:10:07.328 | 10:10:08.831 | 未见投递记录 |
| Avicenna | 11:07:49.775 | 11:08:15.001 | 未见投递记录 |
| Kuhn | 13:48:27.119 | 13:49:10.910 | 尚未投递；13:57:24.270 才收到 |

三次发送均由宿主成功受理，且发送时间早于完成时间，并非主任务明知代理已完成后仍向它发送消息。因此只在发送前检查一次 completed 状态，不能消除收尾竞态。

13:56:11.552，新的 `spawn_agent` 返回精确错误 `collab spawn failed: agent thread limit reached`。该次启动的五个参数齐全且匹配票据。此前 42 次直接启动尝试中，40 次成功、1 次是更早的模型配置拦截、最后 1 次是此次容量拒绝；原生可见活动在拒绝时为 0。**40 是累计成功次数，不是配置的硬上限。** [原始拒绝记录](/Users/niuzhenya/.codex/sessions/2026/09/07/rollout-2026-09-07T16-58-41-01a07b17-5336-7172-b6ec-2e82ea6fb882.jsonl:6306)

13:57:24.234，主任务对 Kuhn 调用了 `followup_task`。随后其子记录先出现此前积压消息，再出现本次 followup 消息；旧消息的 `trigger_turn=false`，新消息为 `true`。旧消息此前确实没有进入该子代理的输入记录。[Kuhn 的延后投递记录](/Users/niuzhenya/.codex/sessions/2026/09/08/rollout-2026-09-08T13-44-32-01a07f8b-ee3e-7cf1-8e6b-b15b19de6ebc.jsonl:99)

核对方法是父任务发送内容与子任务 `agent_message.encrypted_content` 的不透明密文 SHA-256 精确匹配；未解密消息，报告不保存业务消息正文。更早、属于前一次主宿主运行期间的 2 条未投递消息没有计入此次 3 个名额。原始日志用于恢复时间线，不被当作直接读取宿主内存计数的替代品。

## 当前二进制的隔离对照

使用同一安装二进制、V2、含主任务总数 4，执行临时 CLI 实验。模型响应由本机回环 HTTP 服务按固定步骤提供；原生创建、调度、消息队列、驻留和卸载逻辑均真实执行，未调用付费模型。每次进入下一个操作前，都等待原生 `list_agents` 返回所有子代理 completed。

| 步骤 | 结果 |
| --- | --- |
| 串行创建并完成子代理 1—6 | 全部成功；驻留始终不超过 3，较早完成者自动卸载 |
| 创建并完成 7、8、9，分别发送 QueueOnly 消息 | 三次发送成功，三者仍显示 completed |
| 创建子代理 10 | 返回与原事故完全相同的数量上限错误 |
| 让 9 执行一次 followup，等待完成 | 成功 |
| 保持上限不变，再创建 11 | 成功；9 被卸载，7、8 仍驻留 |

验收断言全部通过：11 次创建尝试中 10 次成功、1 次预期容量拒绝；最大可见运行子代理数为 1；不是并发任务尚未结束造成的拒绝。实验进程退出码为 0，回环服务已结束。

实验使用临时目录、临时 SQLite、`--ignore-user-config` 与 `--ephemeral`，没有修改持久配置或 Hook 信任，也没有加载 Router 作为原生基线的一部分。临时会话产生了找不到父 rollout 的 Hook 警告，但原生工具照常执行。此实验验证宿主故障机制，不代替 Router Hook 验收，更不表示已经回收原 Desktop 任务中的代理。

该对照有意在 completed 后发送消息，以稳定建立“完成且消息待处理”的状态。原事故则在收尾前发送，由宿主延后处理；二者进入相同的回收阻塞条件。没有把实验中的固定消息时序冒充成对原事故竞态时序的重放。

完整脱敏操作结果、断言、源码摘要与原始记录位置见[结构化证据](/Users/niuzhenya/Documents/adaptive-model-router/docs/evidence/macos-host-mailbox-capacity-cause-20260908.json)。

## 为什么此前能用，以及此前修复的缺口

两次被引用的成功验收均使用相同的 0.153.4 宿主：**取消展示 service_tier 未知提示** 创建了 2 个子代理；**解释 service_tier 未知提示** 也创建了 2 个，其中有 1 次发送消息。它们验证了启动和结束，未覆盖 3 个已完成子代理都积压消息的条件。普通串行运行会正常自动回收，长任务在特定收尾时序下才逐渐累积不可回收者。这能解释“之前没有遇到、这次长任务遇到”，没有证据把本次容量故障归因于这两次验收之后宿主版本变化。

Router 的 `inspectRouterChildBudget`、`finalizeIfSafe`、`observeAgentResult`、`observeSubagentStop` 在旧工作副本、旧安装副本、`7fc6955`、`5b2c4b4` 和当前源码的对照中一致。没有发现这些修复删除了原生关闭步骤。V2 本身已经具有自动回收能力，缺少旧版 `close_agent` 不是本次已证实的根因。

此外有两个 Router 层问题，需要与宿主拒绝分开处理：

1. 原生启动被明确拒绝，没有生成子代理及其 Stop 事件；旧状态机仍保留 Router 预留，导致后续卡锁。后来的精确拒绝审计解决了这一部分。
2. 后来的容量恢复补丁在释放预留时写入持续性的 `HOST_AGENT_LIMIT_REACHED` 标记，后续路由见到标记就直接继续主任务，没有容量恢复迁移。这是补丁自身的功能缺口，并非宿主要求永久停止委派。[标记写入](/Users/niuzhenya/Documents/adaptive-model-router/plugins/adaptive-model-router/scripts/lib/delegation-recovery.mjs:214)、[后续路由分支](/Users/niuzhenya/Documents/adaptive-model-router/plugins/adaptive-model-router/scripts/lib/router.mjs:221)

因此此前“本机已全面恢复”“完成即已释放名额”的说法超出了验收证据；“此任务后续由主任务执行”只能维持工作继续，不能算完整修复。

## 对后续修复的约束

修复应处理完成时尚未消费的消息和可恢复的容量状态，保留普通连续委派能力；应覆盖收尾竞态、三个已完成但消息积压的代理、清除阻塞后同一任务再次委派，以及失败票据的幂等结算。不能用提高上限、重开任务或永久停用委派作为完成标准。

隔离实验中的 followup 证明宿主具备恢复路径，不等于可以直接在业务任务中唤醒任意已完成的 Router 子代理。生产方案仍须遵守原阶段边界和启动票据约束，验证消息内容处理、结果影响及恢复后的新票据，不复用失败票据或把旧代理当作新阶段执行者。

本轮调查已完成；尚未实施上述修复。检查了原始日志、版本源码及独立原生对照，516 个既有工作区文件与调查前保护清单的哈希一致；仅新增本报告和结构化证据。本次调查路由已结算，当前任务的 Router gate 为 available、pendingOutcomes 为 0。未重跑 Router 全量回归或从源码构建宿主，因为本轮没有运行时代码变更；原 Hosted 任务的恢复与完整功能验收仍属于后续修复范围。
