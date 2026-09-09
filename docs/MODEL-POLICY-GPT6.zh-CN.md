# GPT‑6 单模型、质量优先的路由规范

状态：已安装 GPT‑6 策略，2026-09-06；本机 macOS 登录态路由验收通过。
最新安装状态见[安装核验记录](evidence/gpt6-installation-validation.zh-CN.md)，源码实现与首次验证记录另见文末。
本规范取代先前 Sol/high 加 GPT‑6、按窄评分区间分配目标的设计。

默认仅允许 `gpt-6-astra`，六档 low、medium、high、xhigh、max、ultra。
默认 high，常规自动选择集中在 medium、high、xhigh。任务分类数量固定，
候选模型数量独立变化。增加候选不会增加评分区间，也不要求每个候选获得自动流量。
Router 仅约束自己发起的委派、辅助分类和验证调用；根任务模型仍由 Codex 管理。

## 决策条件

先判断高档条件，再判断是否有充分证据降档。分数只用于诊断和历史比较。

| 档位 | 自动条件 |
| --- | --- |
| low | 需求明确、低风险、纯机械处理，且提供强验证和确定性输出校验；不包括代码实现 |
| medium | 需求明确、强验证，且没有风险、审查、歧义、跨模块影响或架构权衡 |
| high | 默认；一般设计、审查、风险任务，以及缺少安全降档证据的任务 |
| xhigh | 跨模块且有歧义或架构权衡，或至少两个独立困难信号 |
| max | 至少三个独立困难信号，并有高失败成本或不可逆性；或 xhigh 推理失败后的升级 |
| ultra | max 推理失败且自动升级次数尚有余额，或用户明确指定 |

五个独立困难组分别为：安全或迁移、显式高风险或高失败成本、跨模块公共契约、
架构权衡、不可逆性。相关标签在同组只计一次。Plan、grill、描述长度和辅助评分
调整不增加独立困难数。文本可以补充正向风险信号；安全降档必须明确提供
`requirementsSettled` 和 `strongVerification`，low 还需 `mechanical`、
`exactOutputCheck`。不能因为文字出现“有测试”就认定验证充分。

简单应答和无需委派的单个机械步骤留在根任务；机械批量任务可以委派到 low。
`high` 是默认委派档位，不表示 Router 会改变当前根任务的 effort。

## 阶段与升级

提供稳定的 `stageId`；省略时按当前任务与 `phase` 关联。数据库仅保存其 HMAC，
不保存原始阶段标识或任务描述。阶段未成功结束时，描述改写、文本增长、分数
波动都不会单独切换目标；遗漏 `previousRouteId` 也会找回同阶段已有失败，
引用旧尝试不能绕过最新尝试或重置升级次数。
成功后，下一阶段重新分类。

推理失败按 `low/medium → high → xhigh → max → ultra` 升级，每个逻辑阶段
最多自动增强两次。从 high 开始最多自动到 max；从 xhigh 开始可到 ultra。
用户本次显式指定的合法目标不消耗、也不重置自动增强次数；次数耗尽后仍可显式
指定 ultra。已有锁定不能悄悄替代自动升级所需的目标。
失败必须已经记录为相同类型的最终 outcome。环境、信息、工具故障保持原目标，
不能借失败标签升档。不可用的升级返回明确原因；不会把同一目标当作升级。

显式选择优先于自动规则，但必须满足允许范围、当前执行接口能力和风险底线。
范围外锁定在写入前拒绝；已有不合规锁定保留以便检查，路由拒绝使用且不消费 once。
显式不可用目标返回 `EXPLICIT_TARGET_UNAVAILABLE`，不替换为其他组合。

活动委派继续受一任务一子代理、宿主总预留、磁盘预算、可信 Hook、派发 ticket、
实际生命周期和最终验证约束。资格探针使用独立阶段，不消耗原任务的 once 锁定
和升级次数。新探针的实际目标及策略摘要绑定在证据中；旧 Sol/low 记录按原义验证。

## 配置与未来换代

唯一默认配置：[model-policy.json](../plugins/adaptive-model-router/model-policy.json)。
可复制的相同样例：[model-policy.gpt6-quality-first-v1.json](examples/model-policy.gpt6-quality-first-v1.json)。

- `allowedModels`：精确模型 slug 与允许 effort。拒绝通配符、latest 和重复项。
- `conditions`：默认档位、降档所需与禁止信号、xhigh/max 触发条件、风险底线。
- `targets`、`fallbacks`、`escalation`：六个稳定工作档位的目标、明确备用档位与升级边。
- `purposes`：辅助分类器、资格验证和登录态烟测分别绑定哪个工作档位。

当前 v1 只允许把条件改得更严格，不允许移除风险与强验证约束。目标绑定不得降低
同名 effort 底线；升级边与备用档位只能向前，合并到相同目标的升级边会跳过。
这些是保守的工程约束，不是跨模型能力排名。需要不同能力刻度时应升级策略解释器，
不能只把未知模型名字当作性能排序。

以后新增模型，先在相同工作样本上评估，然后将精确组合加入 `allowedModels`，
再按需替换现有 `targets`。只扩大允许范围、调整目录顺序不会改变默认绑定。
无需为新增五个模型创建五段评分区间。当前执行接口没有明确公开的组合不参与选择。
根模型目录不能授权子代理；辅助分类器与烟测使用各自 app-server 的 `model/list`。

## 预览、激活与回滚

新决策策略 schema 为 `1`，路由输出 `6.0`，数据库版本 `6`，存储契约 `3`，
工具契约 `7`。策略定义按 SHA-256 保留不可变修订；活动指针在 SQLite 写事务中切换。
默认策略在数据库迁移时固定，未来改动包内默认文件不会静默替换已激活的策略。

```sh
node scripts/codex-route.mjs model-policy
node scripts/codex-route.mjs model-preview candidate.json
node scripts/codex-route.mjs model-activate candidate.json --expected CURRENT_DIGEST --confirm ACTIVATE_MODEL_POLICY
node scripts/codex-route.mjs model-rollback --expected CURRENT_DIGEST --confirm ROLLBACK_MODEL_POLICY
```

以上短命令用于已显式指定 `ADAPTIVE_ROUTER_HOME` 的开发环境。正式安装优先使用 MCP，
或通过安装目录中的 `node-launcher.mjs` 启动同目录的 CLI，以正确绑定正式插件数据。
MCP 对应 `get_model_policy`、`preview_model_policy`、
`activate_model_policy`、`rollback_model_policy`。策略在共享的 Router 数据目录中
全局生效，预览不写入、不调用模型。激活使用预览得到的当前摘要做并发校验；
候选无效、摘要过期、写入失败或存在未收尾委派/分类调用时，活动指针保持不变。
回滚按实际激活顺序恢复上一份不可变定义的完整允许范围与绑定，同样核对摘要并
等待活动调用收尾。重新启用曾用过的定义也会记录这次切换，不会跳回其首次激活的父版本。

此变更跨工具与存储契约，旧 shell 不能当作兼容热升级使用。旧历史可读，旧程序
不能向新数据库插入没有决策策略的 delegate。安装应走项目已有的契约检查流程；
不能删除 gate、伪造 Hook 信任或启动旧运行时来绕过检查。

## 历史与学习隔离

新路由保存策略 ID、schema、摘要、目标档位与命中条件，状态与历史同时显示最终
outcome、验证 gate、失败类型和纠正/重试信息。缺少 outcome 表示未验证，不能当作通过。
主任务模型、请求的子代理目标、最终验证结果保持各自含义。

旧评分 profile、历史分数、类别 offset、学习提案保持原义。GPT‑6 v1 的
`policyOffset` 固定为 `0`，快照标记 `MODEL_POLICY_OBSERVE_ONLY`，不产生新在线
offset 提案。辅助分类器默认 `local-only`；显式启用时，只影响诊断分数，不改变档位。
实际结果继续记录，为未来离线校准提供证据。

## 验证与当前边界

离线回归覆盖六档、冲突优先级、能力缺失、锁定、同阶段稳定性、两次升级、
并发激活、回滚、活跃委派、旧记录迁移、旧学习隔离，以及增加五个候选/重排目录/
增长文本时默认选择不变。`npm run eval` 是规则符合性检查，不能解释为模型质量。
完整命令、数量与验收边界见[本轮验证记录](evidence/gpt6-implementation-validation.zh-CN.md)。

`node eval/quality.mjs OUTPUT.json` 使用登录态 Codex，在相同的实现、事务审查、
条件分析样本上轮换 medium/high/xhigh，执行确定性验证，最多一次纠正，并记录
耗时、配置模型和可观测 token。缺少字段为 null；配置模型不等于实际服务模型证明。
这不是 API 单价或 Codex 订阅额度测量。

[本轮小样本记录](evidence/gpt6-quality-pilot.json)：9 次首次通过，三档均为 3/3，
无纠正；medium/high/xhigh 总耗时分别约 39/44/61 秒。仅三个样本不足以校准生产阈值，
保持默认 high。记录包含执行时的策略定义，最终配置结构整理没有改变这些显式调用组合。

首次原生预检曾因 Hook 未受信任而停止。用户完成当前哈希信任后，CLI `0.153.3` 上的
正式 MCP 资格检查、正常委派、原始记录审计、结果入库、无效 ticket 拦截及新任务工具
暴露均已通过，详见[安装核验记录](evidence/gpt6-installation-validation.zh-CN.md)。
上述首次实现记录中，Windows 原生宿主不可用；当时根 slug 变化只做离线事件测试，
标记为 `HOST_MODEL_INTENT_OFFLINE_ONLY`。保留该历史边界，不能把旧记录改称原生通过。

当前普通烟测和 Router 自己发起的调用仍从共享策略取得允许目标。宿主模型意图验收
另由持续存活的 smoke 协调任务通过 Codex 原生任务控制执行；这是宿主操作，
不修改 Router 的 GPT-6 允许范围，也不允许范围外的子代理。Windows runner 的
`smoke-host-model-target.mjs` 从原生 `model/list` 选择支持初始 effort 的不同根模型，
当前优先选可用的 Sol，仅用于宿主控制步骤；普通烟测不能使用该通道绕过策略。

按 [macOS 手册](MACOS_SMOKE.md#4-exercise-both-host-model-decisions)和
[Windows 手册](WINDOWS_SMOKE.md#6-exercise-host-model-intent-protection)核验原生状态、
可信 Hook、pending 和两种决定，并在失败时也恢复初始模型及宿主暴露的思考档位。
能力不足应报告宿主能力失败，不能要求用户反复手工切换模型，或用离线回归替代原生
验收。是否通过仍以当前候选的实际记录为准。
