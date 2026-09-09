# Mac 子代理驻留：原生机制实测与已更正的 v2 判断

日期：2026-09-08。**更正：下面的原生机制观测有效，但“必须先补齐宿主接口”这一 v2 结论已撤回。该结论来自额外要求立即物理卸载和原生邮箱原子封闭，不是用户功能目标的必要条件。**

新方向及依据见[方案 v3](/Users/niuzhenya/Documents/adaptive-model-router/docs/HOST-CAPACITY-LIFECYCLE-REPAIR-PLAN.zh-CN.md)和[12 阶段原生编排对照](/Users/niuzhenya/Documents/adaptive-model-router/docs/evidence/macos-residency-plan-reassessment-20260908.json)：保持三子名额，主动 followup 收尾，容量拒绝为零。该对照仍非插件安装验收；运行时修复、完整验收与 Mac 实装尚未完成。

以下保留 v2 实验和接口核对的历史事实。仓库其它 v4 Phase 0/ADR 的证据没有被挪用来证明本次完成。

## 已执行的工作

- 核对实际二进制 `/Applications/ChatGPT.app/Contents/Resources/codex`：`codex-cli 0.153.4`，SHA-256 为 `a30ec314bbd0e3721632234d07db7c99855db3b9f1e32dbe8c791947f07e7629`。
- 将原来的临时实验整理成可重复运行的[原生机制探针](/Users/niuzhenya/Documents/adaptive-model-router/scripts/probe-native-residency.py)。使用私有临时 Codex home、回环固定模型响应、原生 V2 工具和三子代理容量，不使用账号凭证或付费模型，不连接已有业务任务。
- 新增[协议回归检查](/Users/niuzhenya/Documents/adaptive-model-router/scripts/test_native_residency_probe.py)，8 项通过。覆盖真实 `task_name` 返回、携带结果的完成状态、旧代理正常卸载、未观测到完成的代理消失、错误身份、非容量错误，以及不能用扩大容量后的新建成功冒充主动消费。
- 重新从当前二进制导出标准及 experimental App Server Schema：分别 99、155 个方法。检查全部方法清单和对应官方源代码；没有将标准清单缺少 experimental 方法误判为接口不存在。

执行命令：

```sh
python3 -B -m unittest discover -s scripts -p test_native_residency_probe.py -v
python3 -B scripts/probe-native-residency.py --require-proactive
```

当时第一条退出 0（8 项）；第二条退出 1，状态为 `proactive_contract_failed`。这是旧探针对“无 Router/Hook 时原生自行消费 QueueOnly”的额外期待失败，不能当成插件修复的产品红测。省略 `--require-proactive` 时也只采集机制诊断。当前探针新增 `--scenario cooperative`，11 项协议测试及十二阶段编排对照通过；旧运行的原始字段和哈希保留。

| 原生对照 | 本次结果 |
| --- | --- |
| 串行创建 6 个，每个等待原生完成状态 | 成功，证明不是累计创建三次的限制 |
| 3 个完成代理各积压 QueueOnly 消息，再创建第 10 个 | 精确返回 `collab spawn failed: agent thread limit reached` |
| 对其中一个原阶段执行 followup，再创建第 11 个 | 成功，容量未调高 |
| 对另外两条积压消息执行收尾 | 三条要求均进入真实子代理的模型输入；合成响应不证明语义落实质量 |

合计 45 次根响应请求、13 次子响应、44 个原生调用。首次手动恢复前，三条积压要求均未进入子代理的模型输入。等待依赖真实列表状态；时间延迟只用于让通知前进，不作为完成证据。创建返回、最后完成状态和模型输入中的要求标记分别核对。列表中历史代理消失不被当作任务完成或可靠释放回执。

探针最初版本曾把原生返回误读为 `agent_name` 和字符串完成态；首次运行因此是 `probe_failed`，不能算根因证据。修正由真实返回驱动，新增失败用例后再运行；上表只引用修正后的完整运行。

原始结果和摘要见[结构化证据](/Users/niuzhenya/Documents/adaptive-model-router/docs/evidence/macos-residency-p0-20260908.json)。原始脱敏调用在该文件指向的临时目录中保留；探针退出时关闭自身服务并核实自己创建的进程组已结束。临时目录不承担生产状态或长期工作续接。

## v2 所要求接口的核对记录（不再作为本次实施前提）

官方源码依据是 `rust-v0.153.4` 的 `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`。它是接口与机制证据；不是宣称源码重建后与签名二进制逐字节相同。

| 方案所需能力 | 本机可用能力与缺口 |
| --- | --- |
| 准确控制原 Desktop 的 child 实例 | 当前 Router 的 `AppServerClient` 新建 stdio server；持久记录可读不代表它持有原 Desktop 的内存对象。尚未找到当前插件可调用的同一拥有实例控制连接。 |
| 完整 mailbox 范围、消息 ID、水位与处置回执 | V2 `send_message` 是 QueueOnly，followup 是 TriggerTurn，成功返回为空；没有消费或语义落实回执。`thread/queue/*` 操作 `UserInput` 排队项，不是代理间 mailbox。 |
| 原子封闭、迟到消息明确拒绝/可靠移交 | `InputQueue` 的邮箱由原生私有 mutex 管理。当前公开操作没有封闭版本、消息处置和卸载共用的原子操作。插件 SQLite 锁不能给原生队列增加这个保证。 |
| 安全停止和准确释放回执 | 直接 V2 工具包含 interrupt，但没有显式 close/unload；自动缓存卸载只在满足原生条件时发生。请求 interrupt、另一个实例查询 NotFound、归档响应都不能替代 R3/R7。 |

源位置：[V2 工具实现](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/tools/handlers/multi_agents_v2.rs)、[消息投递方式](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/tools/handlers/multi_agents_v2/message_tool.rs)、[原生邮箱](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/session/input_queue.rs)、[驻留回收](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/agent/control/residency.rs)、[V2 直接输入限制](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/src/request_processors/thread_input.rs)。

[官方子代理说明](https://learn.chatgpt.com/docs/agent-configuration/subagents)介绍了关闭已完成代理的产品操作，但不构成当前 V2 插件拥有完整生命周期 API 的证明。本机直接工具清单、当前二进制 Schema 和源码需分别核对。

### 现有替代入口的追加核验

继续按同一精确源码提交核对，结果如下。以下是源码合同证据，没有向原 Desktop 业务子代理执行注入、归档或退订实验。

| 入口 | 实际行为 | 对修复的影响 |
| --- | --- | --- |
| `thread/inject_items` | `turn_processor.rs:949–951` 先加载准确线程，再调用同一个 V2 直接输入限制；不是该限制的例外入口 | 不能用注入绕过原阶段的消息处置或直接启动 V2 子代理 |
| `thread/archive` | `thread_processor.rs:1043–1056` 先从当前 manager 移除对象，再等待停止；提交停止失败或十秒超时后仍继续归档；最终响应为空 | 归档成功不能证明 R3 静止或 R7 准确释放，也不提供 R4 消息处置 |
| `thread/unsubscribe` | `thread_processor.rs:1011–1036` 只移除本连接订阅，或返回本 manager 的 `NotLoaded`；真正异步卸载走另一条路径 | 本响应不是原 Desktop 实例的卸载回执，不能据此释放 Router 责任 |
| Stop/SubagentStop Hook | `hooks/src/events/stop.rs` 的请求携带线程、回合、代理身份、transcript 和最后回复；输出能阻止停止并提供继续提示 | 现有输入/输出没有完整 mailbox 水位、原子封闭或卸载事务；扩展插件 matcher 只能增加观察，不能使宿主内部队列受 SQLite 锁约束 |

对应源码：[直接注入的校验](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/src/request_processors/turn_processor.rs#L944)、[退订与归档预处理](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/src/request_processors/thread_processor.rs#L1011)、[停止结果及异步卸载](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/src/request_processors/thread_lifecycle.rs#L415)、[Stop Hook 合同](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/hooks/src/events/stop.rs#L29)。

这些核验说明不能把 archive/unsubscribe 等接口拼成 v2 要求的显式卸载证明；它们并未排除本根任务直接调用原生 followup 的路径。v3 使用后者处理业务和消息，让现有 LRU 管理内存，因此不需要插件另起 App Server 控制 Desktop 的驻留对象。

## 当前下一步与尚未执行的验收

对外接口请求草稿已取消、未发送，不纳入本次修复提交。保留原始机制数据及旧推论作为历史，当前结论按方案 v3 执行。

接下来修复插件的同阶段续轮/消息跟踪、最新 Stop 关联、根结束检查、旧 child 受限维护，以及暂时容量回退后的再次准入。不能只换用 followup 却仍允许旧 Stop 结算新回合，也不能用永久主任务执行代替修复。

原生基线路径、十二阶段正常收尾对照、协议测试已完成。开启 Router/Hook 的真实模型质量、原始收尾窗口竞态、取消与未结束工具、旧 child 的维护约束、同根 100 阶段、旧 Hosted 原任务恢复与 Mac 安装仍未验收。

此前自动目标续轮曾返回 `HOST_HOOK_DISPATCH_NOT_OBSERVED`，因此当时没有委派审查；这是该回合的历史事实。本次用户纠正后的新回合已按新鲜 Hook 路由，实际启动 gpt-6-astra / xhigh 独立复核，结论同样指出 v2 的前提被不当扩大。
