# 自动委派未启动与能力降级事故修复方案

状态：macOS 本地修复、实装和当前 Desktop 自动委派验收已闭环。`131336` 的单次资格自检完成四个 Hook、双重原生无工具审计及服务端复核；随后正常自动委派自动选择 Sol/high，完成真实只读代码审查和根任务完整验收，两条唯一成功 outcome 均已记录，gate available。临时采集已关闭，旧失败资格、outcome、缺失事件和独立恢复回执全部保留。修复已进入 [PR #20](https://github.com/Neil0619/adaptive-model-router/pull/20)；本篇记录候选提交时的证据，远端 CI 和合并状态以 PR 记录及远端提交为准。下面各次验收结果均为当时快照；旧失败原因不从本次成功倒推，Windows 实机测试仍按用户要求后置。

## 已确认故障

1. route_stage 已返回 delegate，调用侧却没有执行匹配的 spawn_agent。路由提前占用了 Delegation Gate，形成 ticket 未消费、没有 PostToolUse/SubagentStop、但可能已经写入 outcome 的孤儿记录。
2. 调用侧随后把同一任务的 direct 委派能力改报为 unavailable。原实现先接受该声明，再检查活动 gate，因此连续返回 HOST_DELEGATION_UNAVAILABLE，掩盖了真正的阻塞路由。
3. record_outcome 接受尚未经过 PreToolUse 派发握手的路由，允许“没有启动子任务”被误写成最终验证结果。
4. verificationFailed 只允许引用 delegate 路由。根任务执行 continue 后若本地验证失败，合法失败信号会被输入校验拒绝。
5. 辅助分类器默认把 CODEX_SQLITE_HOME 指向空临时目录。当前已登录 Codex 主机的认证状态不在该目录内，App Server 初始化超时，路由退化到 deterministic fallback。

修复过程中另外确认了六个相邻问题：

6. 本机 `codex plugin list --available --json` 输出约 1.63 MB，超过 Node `spawnSync` 默认 1 MiB 缓冲区。安装器因此会在任何安装变更前失败，并只报告笼统的 catalog 命令错误。
7. 热升级后运行时已解析到新版本，但诊断仍直接回显旧的 active pointer 版本；当旧目录已经不存在时，`activeVersion` 会与实际加载的 `runtimeVersion` 不一致。
8. 旧版本已经制造的“ticket 未消费但 outcome 已记录”attempt 会永久占用全局 child 空间预留；三条历史 pending 足以让后续所有任务命中 `ROUTER_CHILD_STORAGE_LIMIT`，即使当前 context gate 可用。
9. 7 个 Hook 全部 enabled/trusted 后，`route_stage` 返回 delegate，direct `spawn_agent` 也真实创建了 child，但生产 attempt 的 `root_turn_id`、`tool_use_id`、`dispatch_input_digest` 和 `post_observed` 始终为空；`SubagentStart` 因 ticket 未消费而拒绝 child。规范工具名已被 matcher 覆盖，但新的 `hooks/list` 进程不能证明旧任务正在使用的 Hook 集合。旧任务缓存原四 Hook 集合是待核实假设，不能把这一次现场外推为所有同版本 direct 路径都不分派 Pre/Post。
10. readiness 只验证 `hooks/list` 的定义、enabled 与 trust，把“Hook 配置可信”错误等同于“Agent 生命周期往返可用”；没有要求精确宿主构建的 Dispatch Round Trip 证明。
11. 当宿主已经创建 child 但跳过 PreToolUse 时，旧 `SubagentStart` 路径不会把 attempt 标成 ambiguous；后续 child prompt 还可能仅凭 ticket 名称读到 bounded context。受保护 Stop 重入又会把同样的未消费状态误归档为“派发前放弃”，从而释放一个实际已经出现过 child 的 gate。

## 修复不变量

- delegate 仍然自动选择有边界的子代理模型和 reasoning effort，根任务模型不改变。
- 一个 route_stage 返回的 delegate 在本轮结束前必须真实尝试一次匹配的 spawn_agent；未尝试时，可信 Stop hook 阻止第一次结束并给出恢复指令。
- 没有消费派发 ticket 的路由不能记录 outcome。
- 活动 gate 的 busy 状态优先于调用侧后续提交的 unavailable 声明。
- 同一任务已经由可信生命周期证明创建过 Router 子任务后，调用侧不能在没有权威 tooling/no-child 失败的情况下把 direct 能力静默降级。
- continue 路由后的根任务本地失败可以通过 previousRouteId 保留失败链路，但不伪造子代理 effort escalation。
- 分类器使用宿主已有登录态，只创建 ephemeral thread；不得新增可见持久任务。
- trusted/enabled Hook 清单只是普通委派的必要条件；没有 source-owned、精确宿主绑定的 Dispatch Round Trip 证明时不得交付原任务工作。经用户批准，已支持的 macOS 构建允许一次固定无工具资格 child；其他情况继续 `HOST_LIFECYCLE_ROUND_TRIP_UNPROVEN`，失败不重试。
- 不删除历史 route/outcome 审计行，不伪造 no-child 或 Stop。受保护 Stop 重入不是权威 no-child 证明：ticket 未消费时只能标记 ambiguous 并保留 gate。旧版本留下的“ticket 未消费 + 已记录 outcome”非法组合仍按独立迁移规则保留审计并隔离终结。

## 实现切片

1. Stop hook：检测 unresolved attempt 且 ticket_consumed=0。在 stop_hook_active=false 时输出 decision=block；受保护重入时若 ticket 仍未消费，则标记 ambiguous 并保留 carrier、gate 与预留，绝不把重入解释成 no-child 或“派发前放弃”。
2. Outcome gate：首次写入 outcome 前必须存在匹配 delegation_attempt 且 ticket_consumed=1；已有 outcome 的完全相同幂等重放保持兼容。
3. 路由优先级：在 enabled/任务模式检查之后、hostCapabilities 降级和分类器之前检查活动 gate；有活动路由时只返回 busy。
4. 能力单调性：从可信 delegation_attempt 生命周期推导“本任务 direct child 已被创建”。后续 unavailable 声明若没有与权威 no-child tooling outcome 绑定则作为 INVALID_INPUT 拒绝。
5. 根任务重试：允许 verificationFailed 引用同一 project/context 的 continue 路由，增加 ROOT_LOCAL_RETRY 原因码，重新进行正常评分和委派选择，escalation 计数保持 0。
6. 分类器：AppServerClient 默认不覆盖 CODEX_SQLITE_HOME，继续使用 thread/start 的 ephemeral=true；显式隔离开关保留给不需要登录态的测试或诊断。
7. 提示合同：明确 list_agents 不能判断 spawn_agent 是否可调用；只有直接工具调用的实际拒绝才能触发能力降级，且 record_outcome 必须晚于派发握手。
8. 安装器：为受控宿主命令设置 16 MiB 上限，并在 JSON 解析失败时保留具体命令身份；用超过 1 MiB 的 catalog fixture 回归。
9. 运行时诊断：`activeVersion` 取已解析且实际存在的 active descriptor，不再回显可能悬空的原始 pointer 字段。
10. 旧状态收敛：打开 v5 storage 时，精确隔离“ticket 未消费 + outcome 已记录 + 未 finalized”的旧非法组合；保留 route/outcome 和 attempt 审计行，将 attempt 标记为 ambiguous/finalized、清除 carrier，并把对应 score snapshot 排除出学习。其他未收敛状态不变。
11. 宿主能力门：`hooks/list` 通过后仍必须调用 source-owned Dispatch Round Trip proof seam；当前没有有效原生证明时固定返回 `HOST_LIFECYCLE_ROUND_TRIP_UNPROVEN`，生产 MCP 没有 caller-supplied bypass。
12. 启动后异常：可信 `SubagentStart` transcript identity 命中未消费 ticket 时，保存哈希化 child identity、标记 ambiguous、拒绝授权 context；迟到的 PreToolUse 也不得再消费该 ticket。
13. 子任务续回合：只有 `ticket_consumed=1` 且当前 agent 已通过 lifecycle claim 绑定、attempt 非 ambiguous 时，prompt/compact 才能读取 bounded context；仅知道 carrier task name 不构成授权。

## 回归测试计划

- Hook：未消费 ticket 的 Stop 第一次返回 block；受保护重入标记 ambiguous 并保留 gate，且不生成 outcome/no-child；已消费 ticket 的重入不改变生命周期；数据库中没有路径或消息泄漏。
- Gate：未派发 route 的 record_outcome 被拒绝；活动 gate 不能被 unavailable 输入遮蔽；并发 50 路由仍只有一个 delegate。
- Legacy state：旧的未派发 outcome 保留审计但退出活动预留和学习；已消费但缺 child terminal 的历史 attempt 保持 occupied。
- Capability：可信 Hook inventory 单独稳定返回 `HOST_LIFECYCLE_ROUND_TRIP_UNPROVEN`；只有内部 source-owned proof seam 通过才允许 delegate；已成功创建过 child 后的无依据降级被拒绝，真实 no-child tooling 失败后的降级仍可继续 root-only。
- Lifecycle anomaly：未经过 PreToolUse 的 Router-marked child 进入 ambiguous reconciliation、拿不到 bounded context；迟到 PreToolUse 不能解除歧义或启动替代 child。
- Retry：continue 后的 reasoning/tooling 本地失败可带 previousRouteId 重新路由；跨 context 引用仍被拒绝。
- Classifier：默认启动环境保留宿主 CODEX_SQLITE_HOME，thread/start 始终 ephemeral；macOS 登录态探针从初始化超时恢复为结构化结果，且 thread/list 没有新增 id。
- Installer：超过 1 MiB 的插件 catalog 仍可完成解析和计划；错误消息绑定具体失败命令。
- Runtime：active pointer 指向已移除旧目录时，诊断中的 activeVersion 与实际解析运行时一致。
- 全量：npm test、npm run validate、npm run eval、git diff --check。

## macOS 实装与验收

1. 在源码树完成定向和全量验证，记录当前 Codex/Node 版本、候选插件树摘要和安装前 Router 状态。
2. 只停止工作目录位于目标插件缓存内的 Adaptive Router launcher/server；保持 Codex Desktop 与当前协调任务存活。
3. 使用仓库受管安装器执行兼容升级，不手工复制缓存文件，不修改用户全局配置来模拟修复。
4. 验证安装后的 runtime、Hook、MCP、数据库版本和精确源码摘要一致。
5. 在 macOS 本机验证 Hook inventory 和 Dispatch Round Trip 两层门。只有存在有效 source-owned receipt 时才运行 route -> spawn -> child terminal -> root verification -> outcome；否则必须验证 typed root fallback、零 ticket、零新 child，并保留已启动异常的 reconciliation gate。
6. 本轮 Windows 实机项记录为未执行，不把 macOS 结果外推成 Windows 通过。

## 2026-09-04 第一次验收结果（信任前）

- 最终候选与本机安装版本：`0.4.0+codex.20260904005537`。
- `npm test`：223 项，222 通过、0 失败、1 跳过；跳过项仅为 Windows shell 集成测试。
- `npm run validate`：通过。
- `npm run eval`：226 个案例，`routeAgreement=1`、`riskFloorRecall=1`，无 mismatch、mutation 或 miss。
- `git diff --check`：通过。
- 受管升级 `./install.sh upgrade --verify-task-tools --ref=stable`：通过；固定 MCP、Hook、stdio bridge 探针均通过，没有创建一次性 CLI 任务。
- 已安装目录与源码中的 `app-server.mjs`、`database.mjs`、`delegation-gate.mjs`、`router.mjs`、`runtime-loader.mjs`、`manage-install.mjs`、`hook.mjs` 和 Router Skill 逐文件一致。
- 登录态 classifier smoke：识别 7 个宿主模型，使用 `gpt-5.6-luna/low` 返回结构化分类；`thread/list` 前后均为 44 个 id，新增持久任务为 0。
- 安装后诊断：数据库 v5、WAL、`databaseHealth=ok`，classifier failures 已归零，实际 `runtimeVersion` 与 `activeVersion` 均为 `0.4.0+codex.20260904005537`。
- 数据变更前已用 SQLite 在线 backup API 生成 `router-before-predispatch-reconcile-20260904005537.sqlite3`；备份 `quick_check=ok`。
- 原事故 route `8b44704f-8ba6-4516-9d9c-b10b9452212a` 的 route/outcome/attempt 审计均保留；attempt 现为 ambiguous/finalized，ticket/context carrier 已清除，没有写入 no_child 或 Stop。历史 pending 从 3 降到 2。
- 两条 ticket 已消费但缺完整 child terminal 证据的旧 attempt 没有被修改，继续 fail-closed。当前已计入 57.04 MiB，下一次预留为 768 MiB，总量低于 1 GiB 上限，容量检查恢复为 allowed。
- 最终 live route 经 stdio bridge 成功调用分类器，但因 7 个已启用 Router Hook 的新哈希均为 `trustStatus=modified` 返回 `HOOK_TRUST_REQUIRED`；没有生成 delegation ticket、没有启动 Agent、没有 outcome。需用户在 Codex `/hooks` 中完成一次显式信任后继续无人值守 smoke。
- 本轮没有执行 Windows 实机测试，没有 commit、push 或发布。

## 2026-09-04 信任后复测

- 用户完成 7 个 Hook 的 exact-hash 信任，`hooks/list` 显示全部 enabled/trusted，warnings/errors 均为 0。
- route `1adfb80d-b66c-4fdc-8df7-ca612406779b` 返回 `delegate`，根模型保持 `gpt-5.6-sol`，目标为 `gpt-5.6-sol/high`。
- exactly-once direct `spawn_agent` 创建 child `01a06864-7bff-7331-8581-dc888d4406c3`；child 的 `SubagentStart` 收到拒绝上下文并未工作。
- 生产 attempt 仍为 `ticket_consumed=0`、`post_observed=0`、无 root turn/tool use/agent correlation，证明 PreToolUse 与 PostToolUse 均未形成 round trip；没有 outcome，也没有重试 Agent。
- 当前 route 保持 occupied，等待安全 reconciliation；不得以本次失败生成“委派通过”结论。

## 2026-09-04 二次候选实装结果

- 最终候选与本机 active runtime：`0.4.0+codex.20260904021201`；previous runtime 为 `0.4.0+codex.20260904005537`，failed runtime 为 0。
- 新增生命周期红测先稳定失败，修复后定向用例 54/54 通过；最终 `npm test` 为 225 项、224 通过、0 失败、1 项仅因非 Windows 宿主跳过。
- `npm run validate`、226 项 `npm run eval`、Router skill quick validation 和 `git diff --check` 均通过。
- 受管热升级与固定 MCP/Hook/stdio bridge/Desktop Node 探针通过，未执行插件重注册、未创建 disposable Codex task；源码与已安装的 readiness、gate、database、Hook 和 Router skill 文件逐字节一致。
- 安装后的 7 个 Hook 均 enabled/trusted，warnings/errors 为 0；这只证明配置层可信，不再被当作生命周期能力证明。
- 安装后的真实 readiness 返回 `HOST_LIFECYCLE_ROUND_TRIP_UNPROVEN`。隔离临时存储上的完整 `route_stage` 服务探针返回 `continue`、无 target/carrier、`delegation_attempts=0`，证明不会再生成同类孤儿 child。
- 事故 route `1adfb80d-b66c-4fdc-8df7-ca612406779b` 没有 outcome、没有 replacement child，继续保留 occupied gate；旧版本已经错过的 Pre/Post 事件不会被推断或补造。
- 本轮没有执行 Windows 实机测试，没有 commit、push 或发布。

## 2026-09-04 原生协议修复与受审计恢复

- 新鲜原生宿主明确拒绝合法形状但未签发的 `router_<32 hex>` ticket：`PreToolUse=blocked`，无 child。早先使用 `router_invalid` 的探针属于普通任务名，不能用来判断 Router 拒绝边界。
- 合法链路捕获真实错误：`PreToolUse hook returned unsupported permissionDecision:allow`。已将合法调用的输出改为 `{}`，保留宿主正常权限检查；拒绝路径仍输出 `deny`。对应红测先失败、修复后通过。
- `scripts/probe-native-lifecycle.mjs` 通过 Codex 原生事件订阅与持久线程读取验证，不以模型最终回复作为通过依据。它只创建临时状态和固定无工具工作，并在结束后归档自己的测试线程。
- CLI symlink 启动会找不到相邻的 `codex-code-mode-host`，探针改用真实可执行路径；原生插件 MCP 不继承临时 `ADAPTIVE_ROUTER_HOME`，探针以进程内 `router_smoke` 配置显式绑定已安装 MCP 入口和临时状态。库绑定预检失败时不签发测试 ticket。此临时注册不等于生产插件注册的验收。
- `0.4.0+codex.20260904094111` 的原生 deny smoke 通过；完整 roundtrip smoke 也通过：四个生命周期 Hook 均 completed，恰好一个 child、正确无工具标记、一次 outcome、`ambiguous=0`、attempt finalized。测试根模型与 effort 保持 `gpt-5.6-sol/low`；这不是路由器改变用户根模型。
- 新增 `reconcile-delegation.mjs`，默认只 inspect。只有匹配的父任务 started/completed、精确 child/turn/source 绑定、完整 native items、稳定物理文件测量以及原始记录审计同时成立，才给出可恢复的 evidence digest。apply 必须重新读取并匹配同一 digest，事务中再次核对 attempt。
- `thread/read` 的 full 视图仍会省略 code-mode 调用。恢复因此额外使用限 2 MiB、锁定 `0.153.0-alpha.5` 的原始记录适配器；未知构建、未知事件/动作、隐藏工具调用、截断、重入、身份不符或两次读取不稳定一律保留 gate。它不是稳定公共 Hook API，也不把原始日志文本中的“没有工作”当证据。
- 恢复回执是独立的 `native-thread-delegation-recovery/2` tooling failure 审计，不补造 Pre/Post/Stop/no-child/outcome；只终结这一条已证实无工具工作的异常 attempt、清除其 carrier、计入真实 transcript 空间并排除学习。状态和历史单独显示 reconciliation。
- 生产库已用在线 SQLite backup 备份，`integrity_check=ok`。安装后的恢复 CLI 重新 inspect 后，以精确 digest 执行 apply；`2026-09-04T01:45:48.046Z` 返回 `reconciled_failure`。原生 MCP 状态和历史均显示独立 tooling reconciliation、`outcome=null`、`pendingOutcomes=0`、`delegationGate=available`，运行时与 activeVersion 均为 `094111`，数据库健康、无失败运行时。
- 原记录的 `ticket_consumed`、`post_observed`、`stop_observed`、`no_child`、`outcome_recorded` 全部保持 0；只按恢复事务标记 ambiguous/finalized、清除 ticket/context、排除学习并计入 135168 字节物理空间。完整原始记录为 101658 字节。没有创建 replacement child，没有补造 outcome。
- 最终 `npm test` 为 232 项、231 通过、0 失败、1 项 Windows shell 专属跳过；`npm run validate` 通过。原生 deny 与 roundtrip 均在 `094111` 上重新通过。
- 尚未完成：把原生资格证明接入生产 readiness、证明当前 Desktop 任务的实际 Hook 集合与原生路径，再完成普通自动路由端到端验收。隔离测试成功不得解除这些条件。

## 2026-09-04 当前 Desktop 任务的剩余阻塞

- 旧 gate 释放后，真实生产路由 `3063d2bc-bb5c-4372-bfbd-169ba359ebfa` 返回 `continue / HOST_HOOK_SET_MISMATCH`；`pendingOutcomes=0`、gate 为 available、根模型仍为 `gpt-5.6-sol`。没有签发新 ticket、没有新 child、没有 outcome。此结果与恢复审计相互独立。
- readiness 按固定 MCP/Hook shell 的插件路径校验，而不是按热升级后 runtime module 的路径猜测。新建 `hooks/list` 进程读取的是当前配置，不能证明旧 Desktop 任务实际加载的 Hook 注册表。不得把源路径检查改为 active runtime 路径或忽略路径差异，以此把当前任务判为通过。
- 已检查本任务可调用的原生 Codex App 工具：没有当前任务 Hook 注册表查询或重载入口。另起 App Server 的 `config/mcpServer/reload` 只作用于该新进程加载的任务，不能被当成已经重载 Desktop 当前任务。原生 thread 元数据和 world-state 也未给出可核验的实际 Hook 集合摘要。
- 剩余闭环必须同时满足：取得当前受测原生路径的有效 Hook 集合证据；将源端原生往返结果绑定精确构建、插件定义和有效 Hook 集合并接入生产 readiness；再由普通生产 `route_stage` 发起一次真实委派，核验一次 child、一条 outcome 和 gate 释放。独立探针通过、仅重启、仅重信任或再跑单测，都不能单独代替这个闭环。
- 当前没有足够证据安全实现该生产授权绑定。缺口同时包含生产 proof 接线和宿主观测能力，不能全部归因于用户尚未重启，也不能声称更新安装即已完成自动委派修复。维持安全 root-only，暂不合并推送。

### 新回合复核：排除信任遗漏与 Agent 匹配器干扰

- 新回合路由 `5469ad54-89d8-4285-8731-9d4ec0eb14af` 仍返回相同的 `continue / HOST_HOOK_SET_MISMATCH`。这不是等待一个新回合就已解除的状态。
- 通过系统进程 cwd/argv 只读取证，当前 Router launcher/server 仍固定在 `0.4.0+codex.20260904021201` 缓存，而新建 `hooks/list` 只发现 `0.4.0+codex.20260904094111`。两版本 `hooks.json` 的 SHA-256 均为 `69ee7aebf54346049b1948ee4eb735bb0939fca7834fd39cfee9fabe6226ea0e`。同一份原生 inventory 对固定路径返回 mismatch，对 active 路径通过配置检查；因此这一层确认为来源路径差异，不是 Hook 定义内容不同或用户遗漏信任。
- 7 个 Router Hook 均 enabled/trusted，errors 为 0。另 3 个用户级生命周期 Hook 的 matcher 分别为 `Bash`、`Write|Edit|Bash`、`Bash`，不匹配此次检查的 `Agent`/`spawn_agent` 名称；没有修改或禁用它们。这仍只是新建进程的配置观察，不宣称已证明旧 Desktop 的有效匹配集合。
- 当前 Desktop App Server 仍是同一个长驻进程，使用默认 stdio 传输；没有发现可附加的 TCP listener 或具名 App Server Unix listener。捆绑 Codex App 工具桥只转发已列出的工具，没有任意 App Server RPC 入口。没有发送私有猜测命令、修改全局配置或终止 Desktop。
- [官方 App Server 文档](https://learn.chatgpt.com/zh-Hans/docs/app-server) 将 `hooks/list` 定义为按 cwd 发现 Hook，将 `config/mcpServer/reload` 定义为刷新该服务已加载的线程；本任务没有可对当前 Desktop 服务调用该重载的入口。下一步需要宿主侧实际重载或有效集合观测能力，再继续源端证明接线与生产链路验收；仅改为接受 active 路径不构成修复。

## 2026-09-04 Desktop 重载后的继续核验

- 已确认旧 Desktop App Server 进程退出，当前 Router launcher/server 均从 `094111` 启动。生产路由 `7e9035b6-256a-4f9f-a61c-f90cca483ec6`、`59951267-606c-4cd7-8e2b-e9541a286eda` 和 `2bbaed4b-b6f9-4cc9-b5b9-51909a16d1f3` 均已越过来源路径检查，返回 `continue / HOST_LIFECYCLE_ROUND_TRIP_UNPROVEN`；这些 continue 路由没有 child 或 outcome。
- 当前原生可执行文件报告 `codex-cli 0.153.0`；新建原生 child 的元数据与原始记录也均为 `0.153.0`。既有任务的 `cliVersion=0.153.0-alpha.5` 是历史元数据，不能当成此次执行的构建身份。新探针最初被旧版本锁拒绝，该拒绝正确，未计为成功。
- 修复诊断探针仅检查 `thread/read` 投影的证据缺口：原始 code-mode 调用、错误 child 绑定、截断和变化记录的 3 组回归先红后绿；增加精确 `0.153.0` 源记录适配器后，新构建正例也先红后绿。旧恢复适配器及其已有 receipt 保持绑定 `0.153.0-alpha.5`，没有扩大历史恢复权限。默认读取仅接受原生 sessions/archived_sessions 下稳定的普通文件，拒绝链接和越界路径。
- 探针改为由外层源端审计完整 child 记录后，才通过隔离 MCP 写入唯一一条 outcome；模型报告标记正确不再足以触发 outcome。此改动没有修改生产 admission、公共 MCP schema 或任何正式 attempt。
- 最新完整隔离往返通过：root `01a06a4a-3159-7241-aeb5-ea03dacc8c01`，route `7a12711f-bdf8-4082-94c8-564ae2b92abd`，child `01a06a4a-7994-70e2-b804-d8a2e2a19b69`；Pre/Post/Start/Stop 完成，恰好一个 child/一个 outcome，ambiguous=0、finalized=true。原始记录 87720 字节，审计 digest `4a7d1947d66ca78e3f21e1289289c9351088f966e185d903375794973c98940a`，物理计量 147456 字节。root/child 已归档，独立临时 Router 状态已清理。
- 最终相关 21 项测试通过；全量 `npm test` 为 238 项、237 通过、0 失败、1 项 Windows shell 专属跳过，耗时 167 秒。`npm run validate`、226 项 `npm run eval`、语法检查和 `git diff --check` 均通过。此次源端诊断补强尚未另行 cachebust/实装；当前安装版本仍是 `094111`。生产 readiness 仍未接线，不能用隔离成功宣称当前任务自动委派恢复。
- 当时已向用户提出需要明确批准的启动规则调整：一次性的当前任务固定无工具资格探针，通过后才允许普通委派、失败不重试并保留审计。该阶段尚未实现或执行；后续批准与实现见下一节。未将其他任务的隔离证明直接转换为生产授权，也未改写冻结的 Phase 0/v4 设计资料。

## 2026-09-04 用户批准后的生产资格接线

- 用户回复“同意”，明确批准一次固定无工具子任务自检。新增任务级 `native_qualification` 状态；正常评分会委派的阶段，先原子保留唯一 qualification，不传递原任务内容，不消耗 once override，也不进入学习或触发评分回滚。
- 自检固定为可用的 `gpt-5.6-sol/low`；仍经过原有容量、磁盘、单 child gate、一次性 ticket、Pre/Post/Start/Stop 和 outcome 事务。未知平台/构建或缺少精确目标继续 root-only，Windows 保持未认证。
- 准入证明绑定当前 project/context、真实可执行文件和构建、完整有序 Hook inventory、固定与配置 Hook 入口及运行时源码。路径不同但 Hook 定义等价时，只允许无工具资格自检；必须有当前任务四个实际 Hook 观测和原生父子链路后才可通过，不能靠路径等价直接开放普通委派。
- `record_outcome` 的服务端从原生父任务定位精确 turn、调用和唯一 child，审计两次稳定的完整原始记录，并在前后重新核验绑定；仅源端验证器能铸造进程内 proof token，数据库事务重新匹配输入和 attempt。公共 MCP 不接受 proof、reader 或 passed-bypass 参数。隐藏 code-mode 工具、同票据第二个 child、缺 Hook、错误构建/调用、变化来源一律拒绝。
- 新增回归先红后绿，覆盖首次自检隔离、重复资格拒绝、once 保留、伪造 proof 拒绝、完整源记录审计、失败保留及变更后失效。安装器测试曾因运行中缓存版本变化而发生 fixture 快照不一致；该轮不计为候选通过，已冻结 `111857` 后重跑全量。
- 默认 UTC cachebuster 小于先前按本地时间生成的 `094111`。为满足仓库运行时严格单调版本合同，使用已核验本地时间 token `20260904111857`，并验证 comparator 判定新版本更高；未降低版本比较规则。
- 当时待完成：受管升级、生产 MCP 临时状态双阶段 smoke、当前 Desktop 任务自己的 qualification 和普通工作委派，再确认合并推送。后续结果见下文。

### 首次生产双阶段通过与旧缓存 cwd 缺陷

- 冻结 `111857` 后，`npm test` 247 项中 246 通过、0 失败、1 Windows 专属跳过，耗时 188.8 秒；validate、226 项 eval、diff check 均通过。受管升级成功，固定 MCP/Hook/bridge 探针通过，未重注册插件或重启 Desktop。源码与实装运行时摘要均为 `5394f0dea8d08961dc9c4645f0be2b9171236182c0c4b497a0c1cf59d4c23662`。
- `probe-native-qualification.mjs` 在真实已登录宿主中仅调用生产 MCP，不调用底层 routeStage 或注入 proof。临时 root `01a06a72-ffaa-7611-9f5c-7169a419d1e5`：资格 route `d272ce88-7106-4599-b7ec-888fbeb61a70` 与普通 route `c8421deb-f5d0-4a3d-93b4-d8f706d51cd7` 均通过完整源记录审计，两个不同 child、两条 outcome、两次 gate available；全部测试任务已归档，临时状态已清理。
- 当前 Desktop 随后的 route `483f595a-7d72-4e18-92a8-20e8eb8837af` 返回 `HOST_HOOK_STATUS_UNAVAILABLE`，没有 ticket/child/outcome。`lsof` 证明四个长驻 Router server 的 cwd 仍持有旧 inode `448557485`，而已恢复同名 `094111` 目录的 inode 为 `448791896`。新启动的独立进程能读清单，旧 MCP 派生进程却继承已删除的 cwd inode。
- AppServerClient 启动时改为显式重开当前 cwd 路径，不再隐式继承旧目录句柄。实际 POSIX 删除/恢复目录进程回归通过；分类器和只读 Hook/原生记录客户端共用该修复。
- 同时修复目录绑定边界：MCP 的运行目录是插件缓存，不是受测任务目录。生产 readiness 通过只读 `thread/read` 取得精确 contextId 的原生 cwd，校验其 authoritative project/context 一致后再读取 Hook 清单；资格证明只存规范化任务 cwd 的 digest。Outcome 审计重新核验原生父子目录与该 digest，不把缓存目录或调用方路径当作证明。相关正反例和跨项目拒绝均通过。
- `113131` 候选相关 35 项测试通过；当时正在全量与实装复验。此问题在当前任务资格签发之前被拦截，没有耗用或重试资格 child。

### `113131` 最终验证与当前 Desktop 单次资格失败

- 全量 `npm test`：251 项，250 通过、0 失败、1 项 Windows shell 专属跳过，耗时 159.3 秒。`npm run validate`、226 项 `npm run eval` 和 `git diff --check` 通过；eval 的 agreement/risk-floor recall 均为 1。
- `manage-install.mjs upgrade --non-interactive --verify-task-tools` 受管升级通过，固定 MCP/Hook/bridge 探针通过，未重注册插件或重启 Desktop。源码与已安装运行时摘要均为 `3e7646926a5dcaa08965864a65c5e1cd0cbf12d95fa4f4bf932ce4a3a4e75aa0`。
- 临时生产 MCP 双阶段测试通过：root `01a06a7d-b9b1-7b71-b0e1-65949b1001bc`；资格 route `5ee2e407-e084-408a-9be6-5605cc9a161d`，child `01a06a7d-f35b-7153-b4f7-9fea1bd32d63`，原始审计 digest `4eb90cbec106847a48eefdc307c882a99a9758abf4ebbd9e0e3a3eff6380bf8f`；普通 route `53e347ae-9344-4a68-a1fd-440351452638`，child `01a06a7e-31aa-7700-ad1d-3aa0a39101d9`，digest `e27eedeae4dc7a0eb531550dfe15b1616f63ee4c01f6407699e164e33986d026`。两个 child、两条 outcome、两次 gate available，测试任务均已归档，临时状态已清理。它不为当前 Desktop 任务提供准入资格。
- 当前 Desktop 资格 route `83ed1306-8d31-4933-bf53-e05bd9077681` 于 `2026-09-04T03:38:04.085Z` 签发；随后恰好一次 direct spawn 创建 child `01a06a7e-c863-7f50-bf71-5aedae4cb223`。根模型保持 `gpt-5.6-sol`，根强度仍由宿主管理；自检 child 为 `gpt-5.6-sol/low`。
- 生产库确认 `ticket_consumed=1`、`post_observed=1`，root turn/tool-use 已精确绑定，资格 Hook 观测只有 pre/post；`agent_id=null`、`stop_observed=0`。这次已不是此前的“Pre/Post 均未往返”故障，不得复用旧归因。
- 原生父任务 full 投影确认一个 started 和一个 completed child；child 只有一个 completed turn。完整原始记录经 `codex-0.153.0-no-work/1` 适配器及两次稳定读取审计，无工具动作，未收到资格上下文、未返回固定标记。原始记录 97403 字节，物理文件 135168 字节，digest `7d28cc8d7814278090efe3fc7fa1340a2b4fb699fa2a73eaa6e2282a3b389e5a`。该检查仅确认失败现场，不是 gate-release proof，也没有补记生产计量。
- 事后读取的父子 session/source 身份、depth、目录与构建能够通过现有 `readThreadSpawnIdentity` 校验；这不能证明 Hook 当时收到同样的输入或能及时读取该文件。当前与临时 child 的配置日志均含 `CodexHooks`，但现有宿主日志没有可定位此次 Start/Stop 执行的记录。尚不能区分未派发、当时的读取/身份拒绝或其他子任务 Hook 加载问题，不把缺少日志当作“宿主肯定没派发”的证据。
- 派发 ticket 已真实消费且结构化自检确定失败后，于 `2026-09-04T03:48:42.111Z` 通过生产 MCP 记录唯一 outcome：`failed / structured-check / tooling`，重试与 escalation 均为 0；没有 proposal 或 safety mutation。资格状态变为 failed，proof 为 null，`pendingOutcomes=0`。
- 失败 outcome 不释放不完整生命周期：`outcome_recorded=1`，但 `no_child=0`、`ambiguous=0`、`finalized_at=null`、`transcript_bytes=null`，gate 仍由这一条 route 占用。没有重试自检、再次 route、创建 replacement child、补造 Start/Stop/no-child，或借临时任务成功开放普通工作。
- 按已批准的失败停止规则，当前自检到此终止。后续先取得可定位当前 Desktop Start/Stop 的源端事件证据并修复差异，再为这一条已消费但缺 child claim 的失败 attempt 建立单独、经验证的恢复路径；已有针对旧未消费事故的恢复回执不能复用。重新资格测试需要另行明确批准，当前不能合并推送。

### 失败资格的独立恢复实现与只读预检

- 后续目标续跑先核对可观测性：当前原生 `thread/read` 的父、子 turn 均只有标准 items/status/error/timing 字段，没有独立 Hook 执行数组；临时成功 child 的投影也没有该字段。因此不能用投影中没有 Hook item 来证明 Start/Stop 未派发。[官方 Hooks 文档](https://learn.chatgpt.com/docs/hooks) 明确子任务 Hook 使用父 session id，且 transcript 不是稳定 Hook 接口；事后身份可读仍不足以推断 Hook 当时的输入。
- 在不再创建子任务的前提下，新增仅供操作员调用的 `native-thread-delegation-recovery/3` 分支。旧 `/2` 及 `0.153.0-alpha.5` 审计适配器保持原语义；普通已消费 attempt 仍拒绝恢复。新分支只接受已记录 `failed / structured-check / tooling`、精确 Pre/Post、缺 child claim/Stop 的 `0.153.0` 固定无工具资格自检。
- 新分支绑定完整 attempt、qualification、route、outcome 四类状态，并校验原生 root turn/tool-use、唯一 child、单个终态回合、实际 child 构建、原始 session/source 身份、两次完整稳定无工具审计和物理计量。失败文本不是无工具证明；隐藏 code-mode 动作、其他交互、重复/恢复 child、源变化、错误目录/构建及事务前状态漂移均拒绝。
- 两个恢复正例先稳定返回 `RECOVERY_ATTEMPT_INELIGIBLE`；实现后新旧恢复 11 项测试全部通过，包含 23 个拒绝变体、3 类最终事务状态竞争与 8 个不完整/越权 receipt 变体。另一次覆盖生命周期、资格与历史的定向验证 46 项通过。最终全量 `npm test` 为 255 项、254 通过、0 失败、1 项 Windows shell 专属跳过，耗时 166 秒；validate、226 项 eval、插件结构验证和 diff check 均通过。
- 首次从插件子目录调用被精确任务 cwd 绑定拒绝；改为从实际项目根目录调用后，真实 route `83ed1306-8d31-4933-bf53-e05bd9077681` 的只读预检通过，`evidenceDigest=c21e3add0d7641d6224ea6406f9ce468ba33af78b6f0f54c541de59e0b7b231c`，物理计量 135168 字节，`ordinaryDelegationEnabled=false`。此次没有 `--apply`，attempt/outcome/qualification/receipt/usage 的前后摘要均为 `87001c80a96159c22d9ff71ccdcfb8c905701fdc34f88d09e883acb7648dfdd8`，生产状态未变。该 digest 是当时快照，正式 apply 必须重新 inspect。
- 按既有单调缓存版本约束使用本地时间序列 `20260904120659`，只更新 cachebuster 与匹配的 runtime version。受管热升级完成，未重注册插件、未重启 Desktop、未创建 disposable task，固定 MCP/Hook/bridge 探针通过。源码和已安装 `0.4.0+codex.20260904120659` 的运行时摘要均为 `f2413d519b3ac346ef707b2c2da53022dfac365101e4c96e1ec31f4331c502ea`；生产 MCP 的 runtimeVersion/activeVersion 都为 `120659`、failedRuntimeCount=0、数据库健康。
- 已安装恢复 CLI 从项目根目录重新 inspect 同一真实记录，得到同一 evidence digest；前后生产状态摘要仍完全一致。未带 `--apply`，gate 仍 occupied、资格仍 failed、唯一 outcome 仍为 tooling 失败。历史 classifier failures=9 保留，当前 circuitOpen=false；没有手工清零或用这一诊断声称完成新的分类器验收。
- 本节只证明恢复实现、实装与只读资格，不是已解除 gate，更不是普通自动委派恢复。执行恢复须另行确认并先备份；资格 failed 状态不能被此操作重置，重新自检和临时生产 Hook 诊断也未执行。

### 追加授权后的恢复与重新资格准备

- 用户明确回复“授权”，范围是受审计恢复、脱敏 Hook 诊断及再一次固定无工具自检；失败仍停止，不扩大为无限重试或普通委派旁路。
- 恢复前重新运行新旧恢复 11 项测试，全部通过。在线备份位于插件数据目录 `recovery-backup-O3iH8H/router.sqlite3`，父目录 0700、数据库 0600、quick_check=ok，SHA-256 为 `b708e4548ab4798685908cb2b1ff71cbc095d30216466b619f928429c2f53d30`。
- 已安装 `120659` 恢复 CLI 从项目根目录重新 inspect，精确 digest 仍为 `c21e3add0d7641d6224ea6406f9ce468ba33af78b6f0f54c541de59e0b7b231c`。随后在 `2026-09-04T04:56:56.726Z` 应用 `/3` 回执；旧失败 route 的 gate 已释放，原失败资格和唯一 outcome 与备份逐项相同，计量恰好增加 135168 字节。缺失 Start/Stop/no-child 没有被补造。
- 新操作员入口默认只读，正式授权须新鲜 inspect digest 和明确的一次性无工具参数。授权绑定恢复状态、当前运行时、宿主/完整配置 Hook 集合及任务目录，最多存活一小时；准入事务归档原失败资格、消费授权并创建新资格，普通工作仍需新的完整源端成功证明。不存在公共 MCP passed/permission flag，既有普通 attempt 不适用。
- 诊断默认关闭，授权后只观察本任务四种生命周期事件，记录闭合枚举、字段类型、摘要和身份比较布尔值，不记录提示词、票据、原始路径或工具参数/结果。关闭/到期后旧记录函数也停止写入；日志仅供定位，不被当作准入或生命周期证明。
- 回归包含实际 Hook 进程的缺字段路径、不同任务不采集、关闭/过期拒绝、容量上限、旧资格归档、授权重放、源变化和准入事务状态变化。全量 `npm test` 为 260 项、259 通过、0 失败、1 项 Windows shell 专属跳过，耗时 140.1 秒；validate、226 项 eval、插件结构验证和 diff check 通过。插件结构验证在隔离的 uv/PyYAML 环境执行，没有修改项目或全局依赖。
- 受管升级到 `0.4.0+codex.20260904131336`，固定 MCP/Hook/bridge 探针通过，未重注册插件、重启 Desktop 或创建 disposable task。源码与安装目录的运行时摘要都是 `01d2a2288727cef6bcb2330b06c41e6dfc6617d6199688c6527cd7c8ce0a774c`，生产 MCP 的 runtimeVersion/activeVersion 一致、failedRuntimeCount=0、数据库健康。辅助分类器的历史失败累计为 10，circuitOpen=true；没有重置其历史，也不以固定资格自检声称分类器验收通过。
- 已安装 CLI 从项目根目录进行只读预检并应用一次性授权，evidence digest 为 `2df77eb0439031380dfdb2ffe24d952780e28d73dcdac4b517c02df9d02d7711`，到期时间 `2026-09-04T06:15:52.682Z`。该操作只允许一个固定无工具资格 child，ordinaryDelegationEnabled=false。
- 自检路由 `4149b3f4-2df1-4a3a-a7da-9e60c4253e5d` 在派发前返回 `continue / ROUTER_CHILD_STORAGE_LIMIT`；未返回 carrier、未创建 child、未写入 outcome，也未消费上述授权或归档旧资格。只读快照显示已用 60231680 字节、3 个 pending 预留，新增一个后的预留合计 1073741824 字节；本轮没有放宽限额或代替其他任务终结 attempt。
- 三条预留中的 `4a2a9e35-410e-47fc-bce3-07db3e79d3a4` 属于用户引用的任务“Fix persistent credential handling”：派发和 Stop 均已关联，但原任务尚未记录验证 outcome，原任务仍 active。已向用户请求仅发送协调消息的许可，由原任务自行验证并记录结果；在取得同意前，不跨任务代填 outcome 或修改其业务代码。其余两条历史缺 Stop 的 attempt 保持不变。
- 容量拦截后补充测试，验证授权逐字节不变、旧资格不归档、没有新 attempt/carrier/outcome，之后仅在容量允许时消费一次授权。初跑最后一个断言误用 `newRouteId`，按实际契约修正为 `routeId`，未修改运行时；随后资格恢复与脱敏诊断定向测试 10/10 通过，diff check 通过，源码与安装运行时摘要仍一致。该次复核路由 `bd3d92c6-c936-498d-8a76-8b906105bd75` 的 classifier 已返回 `used`，但准入仍被全局容量拦截，不能将其当作新资格或普通委派验收。

### 容量等待中的自主闭环与最终回归

- 用户允许协调原任务后，新鲜生产库检查确认其 route `4a2a9e35-410e-47fc-bce3-07db3e79d3a4` 已在 `2026-09-04T05:31:34.388Z` 由原任务完成 outcome 并终结；无需再发送过时的协调消息，更没有重复记录结果。
- 另一活动任务“优化插件与网页端界面体验”的 route `d5e4d53d-7bf7-4f24-a393-a3759ed2d477` 也在 `2026-09-04T05:53:04.845Z` 正常终结。随后它的新 route `8f31de89-d23f-4a3d-b61e-f2db07026db5` 已关联 Stop、尚无 outcome；该任务经原生 wait 确认仍 active。`05:57Z` 快照仍有 3 条全局预留，已用 63279104 字节，单次重新资格授权仍未消费。针对不同任务的协调另行询问，未将原任务授权扩大为代填或清理其他记录。
- 包含新增容量回归的全量 `npm test` 已重新执行：261 项、260 通过、0 失败、1 项 Windows shell 专属跳过，耗时 131.1 秒。validate、226 项 eval 和 diff check 同轮通过；源码与安装运行时摘要仍同为 `01d2a2288727cef6bcb2330b06c41e6dfc6617d6199688c6527cd7c8ce0a774c`。这一轮没有修改运行时、安装版本或生产授权。
- 根模型仍为 `gpt-5.6-sol`，根强度由宿主管理；全量验证路由 `73784eb5-afdf-419c-bb7f-d0bf4d881441` 返回 `continue / ROUTER_CHILD_STORAGE_LIMIT`，无 child 或 outcome。本轮没有执行重新资格或普通自动委派验收，合并推送条件仍未满足。

### 当前 Desktop 单次重新资格通过

- `2026-09-04T06:00:49Z` 新鲜只读检查确认全局 pending 已正常回到 2、容量允许，已有一次性授权仍有效，源码和安装摘要不变。没有发送跨任务协调消息、暂停其他任务、清理其记录或放宽限额。
- 资格 route `7587d502-0922-414b-8d4e-3f71880fe2f8` 于 `06:01:10.416Z` 签发，只执行一次 direct spawn，创建 child `01a06b01-dd63-7873-be04-67a6d9969305`。目标是固定的 `gpt-5.6-sol/low`；根模型仍为 `gpt-5.6-sol`，根强度由宿主管理。
- 生产 attempt 的 ticket/pre、post、child claim、Stop 全部匹配，无 ambiguity；临时源端诊断记录四种 Hook 的 entry/exit，Start、Stop 的父子身份比较均通过，Start 明确记录 `contextInjected=true`。child 单个 completed turn 返回精确预期标记。这里证明当前派发与身份链可用，不能据此断言上次缺失事件的具体原因。
- 根任务对原生父子记录进行两次稳定读取，确认唯一 started/completed 对、精确 tool-use/turn/child/carrier 绑定、相同 cwd 和 `0.153.0` 构建。完整无工具适配器为 `codex-0.153.0-no-work/1`，sourceBytes=97026，rawAuditDigest=`5eb34e2e827db596e571e856a9e966c9a14f3e56c79587f02b5ed471ddfa4ebd`，物理计量 135168 字节。
- 服务端再次独立校验 Hook/source/binding 后，于 `06:03:20.930Z` 接受唯一 `passed / structured-check` outcome，重试和 escalation 均为 0，无 proposal/safety mutation；资格 passed、gate available、pendingOutcomes=0。旧失败资格归档和旧唯一失败 outcome 的摘要仍匹配原 `/3` 恢复回执，没有被新成功覆盖。
- 已通过安装目录的操作员 CLI 关闭临时诊断采集，确认 enabled=false；脱敏证据保留，未删除。一次性授权状态为 consumed 并精确绑定本次 route，未重新发放。
- 随后普通真实审查 route `f999c31d-742a-4b1f-a6c0-4d346c495bef` 自动选择 `gpt-5.6-sol/high`、`full-checks`，已恰好一次派发有边界的只读代码审查，尚未记录 outcome。它不是第二次固定自检；根任务负责独立验收和最终结果记录。
- 该普通子任务完成了源代码审查，指出诊断 check/append 与关闭之间的在途写入边界。根任务用两个隔离 Node 进程和精确 size/write 栅栏独立复现：并发文件可越过 64 KiB，但只多出已通过检查的有界记录，与此前文档已声明的在途预算一致；关闭后的新记录被拒绝，只有关闭前已通过检查的写入会收尾。没有把软上限误报成严格上限，也没有把该行为声称为新的准入故障。新增两个并发契约用例，诊断测试 4/4 通过，并明确文档中关闭操作不是 I/O 排空屏障；生产运行时、资格证明、授权和关闭状态均未修改。
- 普通 child `01a06b05-2af0-7670-8219-b44eeb766634` 在单个 completed turn 中按 `gpt-5.6-sol/high` 完成 10 次只读工具调用，无嵌套 spawn；两个 `interacted` 事件均为向根任务发送进度，不是新子任务。ticket、Post、child、Stop 精确关联，物理计量 991232 字节。
- 补充并发契约后全量回归再次通过：263 项、262 通过、0 失败、1 项 Windows 专属跳过，耗时 147.4 秒；validate、226 项 eval、`sh -n install.sh`、diff check 均通过。本机没有 `pwsh`，PowerShell 解析交由必需 Installer syntax CI 执行，不能把 macOS 回归说成 Windows 实机验收。
- 根任务完成上述验证后，于 `2026-09-04T06:15:34.114Z` 为普通审查 route 记录唯一 `passed / full-checks` outcome；retries/escalations 均为 0，safety 检查无 rollback、无新 proposal。新鲜 status 确认 gate available、pendingOutcomes=0；运行时仍为 active `131336`、数据库健康，旧记录未改写。

## PR #20 首轮 CI 与测试可移植性修正

- 首个候选提交 `11ca2fc52c98fffefa36c5ceab81c15d353a9207` 已推送；[首轮 CI](https://github.com/Neil0619/adaptive-model-router/actions/runs/33844393323) 的两组 macOS、Installer syntax（含 PowerShell）和插件校验通过，独立 CodeQL 通过。两组 Linux 各只有一次性 shell 请求测试失败：夹具硬编码 `/bin/zsh`，进程 status 为 null。注入仅缺失该 shell 的条件可复现同一断言，改为 `/bin/sh -c` 并显式检查启动 error 后通过。
- Windows 两组在诊断测试停滞，取消该失败轮次后日志明确停在 `lifecycle-diagnostics.test.mjs`。根任务注入 group/other mode bits，复现运行时拒写后测试把零字节记录当作正常预算而无限填充的路径。补上正记录长度和逐次前进断言后，同一条件会立即明确失败，不再死循环。
- 运行时的私密文件拒写保护没有放宽。依赖 POSIX 私密权限的三个正向诊断用例只在支持的系统执行；新增跨平台负向用例，断言非私密 mode 不追加记录且不改变 Hook stdout。[Node 文件模式文档](https://nodejs.org/docs/latest-v24.x/api/fs.html#fschmodpath-mode-callback) 明确 Windows 不实现 owner/group/other 区分，不能把跳过正向前提用例说成 Windows 诊断资格通过。
- 两个相关测试文件 13/13 通过；缺失 zsh、零进展快速失败和权限拒写三个隔离探针均符合预期。该轮补丁仅修改测试与文档，源端和已安装 `131336` 运行时摘要仍为 `01d2a2288727cef6bcb2330b06c41e6dfc6617d6199688c6527cd7c8ce0a774c`，不重发资格授权、不重新运行一次性自检。
- 修正后 macOS 全量回归 264 项、263 通过、0 失败、1 项平台专属跳过，耗时 162.1 秒；validate、226 项 eval 与 diff check 通过。
- 这些修正不能代替下一候选 SHA 的完整必需 CI。Windows CI 仍是合并关卡；后置的是 Windows 原生实机 smoke，而非 CI。

## PR 安全评论与 shell 字面路径回归

- 候选 `11a20d2a45c4b67bcb60b5d9db443cc9dbe04586` 的第二轮 9 项必需 CI 全部通过；两组 Windows 均为 264 项、255 通过、0 失败、9 项明确的平台前提跳过，权限拒写用例实际通过。但最终合并核验发现仓库还要求解决 review conversation，并保留一条 [CodeQL 评论](https://github.com/Neil0619/adaptive-model-router/pull/20#discussion_r3931552962)；不能仅凭检查任务成功就声称满足全部合并条件。
- 告警指出 `JSON.stringify(path)` 的双引号不是 POSIX shell 转义。独立只读审查确认，根任务用指向真实 Node 和 bridge 的符号链接先复现：包含引号、空格、算术展开和反引号的路径被 shell 改写，退出码为 127。
- 改为固定 `"$1" "$2"` 命令前缀、显式 `$0` 和独立 argv 传递两个路径，保留带引号的 here-document；回归再覆盖变量引用、命令替换与中文路径，正常路径和特殊字符路径均通过真实桥接调用。相关测试 13/13 通过，不引入生产代码、权限放宽或告警忽略。
- 修正后完整 macOS 回归再次通过：264 项、263 通过、0 失败、1 项平台专属跳过，耗时 134.1 秒；validate、226 项 eval、diff check 通过，生产运行时摘要仍与已安装版本一致。
- `4bfd2ba` 的 CodeQL 将告警 6 标记 fixed 并自动解决旧评论，但对位置参数创建告警 7。[间接命令模型](https://github.com/github/codeql/blob/main/javascript/ql/lib/semmle/javascript/security/dataflow/IndirectCommandArgument.qll) 将 `sh -c` 参数数组整体视为输入，未区分后续 `$0`/数据参数。为保持固定 shell 程序和明确的数据边界，最终夹具改用两个仅传给该子进程的专用环境变量，并只在双引号内展开路径；不拼接路径、不使用 eval，也不添加告警忽略规则。相同真实路径回归 13/13、validate、226 项 eval 通过；本机没有 CodeQL CLI，最终告警状态和完整跨平台结果须由新候选 CI 确认。
- 后续仍须验证新候选的 CI 与 CodeQL 告警状态，再处理已修复的指定 conversation。仓库要求线性历史，最终使用受保护规则允许的 squash 合并，不创建绕过规则的 merge commit。

## 完成条件（候选提交快照）

- 已满足：所有新增红测在修复前稳定失败、修复后稳定通过。
- 已满足：新运行时不再允许产生“unconsumed ticket + accepted outcome + unavailable masked gate”。
- 已满足：分类器不再因空 SQLite home 稳定超时。
- 已满足：二次 macOS 候选已安装且 active，真实宿主 readiness 与完整服务探针均证明 typed root fallback、零 ticket、零 child。
- 已满足：原事故产生的非法未派发 outcome 已在保留审计的前提下退出全局预留，且没有释放两条已派发但证据不完整的 attempt。
- 已满足：用户已信任第一次候选 Hook；复测没有伪造成功，而是确认了 `HOST_LIFECYCLE_ROUND_TRIP_UNPROVEN` 应作为当前宿主的安全边界。
- 已满足：二次候选已完成全量回归与 macOS 实装。
- 已满足：旧异常 route `1adfb80d-b66c-4fdc-8df7-ca612406779b` 已通过 native/thread 与版本锁定原始记录的双重审计安全终结；其状态、历史和计量闭环。此结论不适用于后续的资格失败 route。
- 已满足：生产 readiness 已接入源端资格证明，`113131` 实装与临时生产 MCP 双阶段验收通过；当前 Desktop 失败不会误授权普通委派或进入学习。
- 已满足：资格失败 route `83ed1306-8d31-4933-bf53-e05bd9077681` 已经独立 `/3` 回执安全恢复，未改写原失败与缺失事件。
- 已满足：当前 Desktop 任务的 Start/Stop 可信关联与完整资格验收，唯一新成功与旧失败记录均保留。
- 已满足：随后普通自动委派端到端验收、根任务完整代码/测试验证和唯一 outcome，具备提交已验证候选的条件。
- 候选提交时待核验：PR 的全部必需 CI、受保护 main 合并及远端最终状态；必须以 PR 检查与合并记录闭环，不能用本文候选快照替代。
- 已满足：没有改写或删除无关用户变更；Windows 实机测试仍按用户要求后置，没有创建发布 tag 或发布包。
