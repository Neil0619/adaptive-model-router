# GPT-6 经济优先委派策略

策略 ID：`gpt6-economy-v1`，解释器 schema：`2`。这是可激活的新策略；
源码、测试通过或候选包准备好，都不表示当前安装已切换。

| 工作级别 | 子代理目标 | 用途 |
| --- | --- | --- |
| low | gpt-6-luna / low | 强验证、确定性输出的机械批量工作 |
| medium | gpt-6-luna / medium | 需求明确、强验证且无风险或复杂性信号 |
| high | gpt-6-sol / high | 默认、普通实现、调试和审查 |
| xhigh | gpt-6-sol / xhigh | 跨模块、架构权衡等复杂任务 |
| max | gpt-6-astra / high | 关键风险，或 Sol 推理失败后的升级 |
| ultra | gpt-6-astra / max | 显式选择，或 Astra/high 已验证推理失败后的升级 |

工作级别与实际 effort 分开记录；`ultra` 工作级别不代表调用 Astra/ultra。
允许范围仅包含表内六个精确组合。Astra/ultra、Astra/xhigh、Luna/high 等
范围外锁定被明确拒绝，已有锁定保留在历史中并通过 `invalidLocks` 报告。
主任务模型仍由 Codex 管理。API 单价不是 Codex 订阅额度或任务总消耗的测量。

## 选择、风险和升级

保留 v1 的需求/验证条件和六个工作级别。普通审查与架构讨论可以使用 Sol。
明确 `highFailureCost` 或 `irreversible` 时应用 `CRITICAL_RISK_FLOOR`，至少选
max 工作级别的 Astra/high；显式目标、重试和能力回退同样检查这个模型下限。

`modelOrder` 明确声明该策略的 Luna、Sol、Astra 顺序；它是工程配置，
不表示跨模型相同 effort 的能力已经测得等价。v2 校验模型顺序、同模型 effort
单调性、精确允许范围以及每个允许目标的唯一升级锚点，不从宿主目录顺序推断能力。

只有已记录的推理失败触发升级，每个逻辑阶段最多两次：

- Luna/low 或 Luna/medium → Sol/high → Astra/high。
- Sol/high 或 Sol/xhigh → Astra/high → Astra/max。
- Astra/high → Astra/max；到顶或预算耗尽时返回明确原因。

环境、信息和工具故障保持原目标。阶段 ID、策略摘要、outcome 和升级次数保留；
修改任务文字或遗漏 previousRouteId 不会重置预算。并行写风险仍阻止顶档调用。
没有显式选择或从 max 工作级别的推理失败升级，不会自动使用 Astra/max。

能力缺失按配置尝试更高工作级别：例如缺少 Sol 时可回退到 Astra/high。
不会为了可用性选择 Astra/max，或降低关键风险的模型下限；显式不可用目标不被替换。
目标始终与当前直接委派接口提供的模型/effort 求交集。

仅指定 effort 的锁定按允许组合解析：`low`、`medium` 选择 Luna，`xhigh`
选择 Sol，`max` 选择 Astra/max（ultra 工作级别）。`high` 优先使用当前需求
对应的组合，否则选择满足风险与升级下限的最低可用组合；关键风险使用 Astra/high。
如需精确固定模型，应同时指定 model 和 effort。

资格验证和可选辅助分类绑定 low（Luna/low），普通烟测绑定 high（Sol/high）。
辅助分类仍默认 local-only。改变这些辅助用途需通过实际资格和登录态测试验证，
不能把无工具质量样本或规则评估称为真实原生委派验收。

## 兼容性和激活

候选文件为 `plugins/adaptive-model-router/model-policy.economy.json`。
原 `model-policy.json` 和旧策略摘要保持不变；现有安装不会随源码改动自动切换。

新解释器支持 schema 1 和 2。首次激活 schema 2 后，使用独立的
`model_policy:v2:active` 与 `model_policy:v2:activation-lineage`；旧指针及 lineage
永远只保存 schema 1。两代共享原数据库、不可变策略修订、历史、容量和未完成责任。
状态和预览通过 `activationScope=v2-interpreters` 与 `legacyRuntimePolicy` 明确范围。
仍运行旧解释器的任务继续使用旧策略，需完成受验证的 runtime handover 才能采用新策略。

回滚到 schema 1 仍在 v2 通道保留精确摘要，不删除指针来暴露旧解释器可能独立修改的策略。
之后通过新解释器激活 schema 1 也操作当前有效的 v2 通道。激活、回滚均检查预期摘要、
受当前配置影响的未完成委派和辅助推理租约，在同一事务中更新；任何失败保持原策略。

默认将所有未完成责任视为阻塞。只有当前已发布的原生 MCP 服务，且存在精确 A/B
兼容性发布证明，才可将已证明只读取旧配置的运行时代际隔离在 v2 激活范围外。
证明同时绑定来源包、候选包、验证器和实际读取行为；同代、未知归属、缺少证明、
旧配置通道写入及未结束的辅助租约仍会阻塞。预览分别报告总责任、隔离的旧责任和
阻塞责任。隔离不会完成、删除、改写旧任务，也不会释放它们的委派名额。

先运行新候选的 `model-preview model-policy.economy.json`，再使用预览所得摘要执行
`model-activate model-policy.economy.json --expected DIGEST --confirm ACTIVATE_MODEL_POLICY`。
存在旧责任时，通过实际已接管的新 MCP 的 `preview_model_policy`、`activate_model_policy`
执行范围验证；直接 CLI 不取得这项原生服务权限。生产命令必须经已安装候选的 launcher
并绑定原 Router 数据目录。旧 MCP schema
不能接受 schema 2；不得通过直接修改数据库或旧缓存绕开解释器/运行时验证。

这是 writer/工具输入契约的变化，应走已有 compatibility epoch：对每个实际旧来源
验证 A/B 构造、旧读者、新策略与跨 writer outcome，再执行可见的安装和任务接管。
普通 runtime publish 不接受未验证的 writer 改动。保留一次性 Hook 信任边界，
运行时发布、安装、策略激活、原生委派验收分别报告结果。

## 验证

`test/economy-policy.test.mjs` 覆盖六档、风险、能力缺失、顶档限制、两次升级、
旧策略摘要、激活/回滚原子性和新旧指针隔离。`npm run eval` 同时保留旧策略
与历史评分样本，并增加中英经济策略样本；它只衡量规则符合性。
`verify-runtime-compatibility.mjs` 在一次性数据库执行真实新旧 writer，激活新策略后
检查旧启动/status/history、三模型目标、跨 writer ticket/outcome 和回滚。
`test/support/verify-policy-activation.mjs` 另用精确保留包在旧任务未完成时执行新策略
激活及回滚，检查缺失证明时拒绝，以及旧任务、原绑定与旧指针完全保留。
这些是离线集成检查，不代表在线模型质量或登录态原生 smoke 已通过。
