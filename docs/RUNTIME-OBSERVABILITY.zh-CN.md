# 运行观测与只读巡检

Router 的主账本仍负责票据、资格验证、子任务责任、运行时归属和唯一 outcome。观测事件保存到同一数据目录的 `observations.sqlite3`，不参与授权、资格判定、责任结清或容量释放。记录失败不得改变工具结果或 Hook 的允许/拒绝决定。

## 查看运行情况

在正确的数据目录环境下运行当前版本的开发者 CLI：

```sh
node scripts/codex-route.mjs health --scope local --from 2026-09-14T00:00:00Z --to 2026-09-21T00:00:00Z --limit 50
```

默认范围为当前项目，默认时间窗为最近七天；`local` 查询本机数据目录中的所有任务。时间范围左闭右开。下一页传入返回的 `nextCursor`；游标保留原时间范围，不能挪用于另一查询。跨任务只返回本地 HMAC 标识和必要的 route ID，不返回任务正文或工作区路径。

该入口在导入写入服务、构造 `RouterStore` 之前返回，不进行迁移、注册、修复、回收或补写 salt。它稳定复制主文件和现有 WAL 到私有临时目录，然后以只读方式查询快照，结束后删除临时副本。原目录不会因此产生 WAL/SHM 文件；也不会用忽略 WAL 的 immutable 读取漏掉已提交事务。源文件正在变更或损坏时报告不可用。主库和观测库是两个独立快照，不构成原子的授权证据。

## 如何解读

| 字段 | 含义 |
| --- | --- |
| `integrity` | SQLite 文件完整性；`ok` 不能证明插件运行正常 |
| `operationHealth.toolCalls` | 工具操作成功、拒绝、失败、busy、降级的独立数量；桥接与实际 MCP 调用不重复计数 |
| `hookProblems` / `transportProblems` / `detailProblems` | Hook 校验异常、启动/桥接失败，以及响应后的清理错误 |
| `pendingResponsibilities` | 当前所有年代的未结委派或维护责任；不受请求时间窗截断 |
| `reservations` | 收费中的容量、已释放但未结责任，以及未能重新验证的释放凭证；释放容量不等于完成工作 |
| `runtimeResponsibilities` | active/unknown invocation 和 pending receipt；active 是账本状态，不保证进程此刻仍存活 |
| `fallback` | 窗口内回退的次数和首末时间，可与最近通过的委派时间比较 |
| `evidenceCoverage` | 采集起点、最早/最近可用事件、裁剪和丢失情况；没有事件不能证明没有报错 |

事件生命周期 `completed` 表示调用已返回，操作仍可能是 `rejected` 或 `failed`。busy 不新增 route/outcome；存储降级不算健康成功。已识别的存储错误可以安全回退，编程异常报告 `INTERNAL_ERROR`，不再冒充存储不可用。

`contextId` 在入参校验前只是声明地址。仅可信 native dispatch/Hook 绑定进入任务操作统计；未验证身份保留在未归属统计中。来源只有经原生元数据核验才标为交互根任务、后台建议或子任务，否则为 unknown。`taskOrigin` 表示所属根任务，`executionOrigin` 表示本次执行；子代理 Hook 计入父任务账本时不会覆盖父任务来源。选中一个 runtime 不等于执行过；执行观察、当前任务绑定、原 stage owner、查询时版本各自有不同含义，历史未知版本不追溯填造。

巡检会分别隔离数据库文件损坏、必要列或查询依赖表缺失；坏观测记录计入 `invalidObservationRecords`，其余有效记录继续显示。文件与 WAL 从稳定的私有副本读取，不在原目录创建 SQLite sidecar。尚未初始化的 Router 状态和普通未管理子代理仍保持原有 Hook 绕过边界；此时只使用既有 stderr 诊断，不因观测而创建插件状态目录。

## 保留与隐私

统一事件目标保留七天，上限为本机 100,000 条、每任务 10,000 条；容量先触顶会裁剪较早事件并标示缺口。覆盖账本独立于事件，不随事件裁剪。日志写失败尽力留下 `observations-gap.json` 和固定 stderr 提示；无法精确计数时标为至少一次，不能解释为零丢失。

既有 finalized attempt 64 条、completed invocation/settled receipt 128 条的容量界限保持不变，新增事务内裁剪计数。旧 runtime 没有这些计数的历史为 unknown。active/unknown invocation、pending receipt、未 finalized attempt 和未结责任不做 TTL 删除。Hook 最新收据仍服务 readiness；新历史不会反向成为资格证明。详细生命周期诊断仍需原有短时授权，达到 64 KiB 时记录独立截断标记。

事件字段为闭合 schema：不保存 goal、提示词、carrier、ticket、完整命令/输出、凭据、路径、环境值、任意异常文本或堆栈。错误使用有限 code/category，身份使用已有本地 salt 生成的 HMAC；salt 不可用时不另造身份。观测库故障独立呈现，不隐藏主库责任。

## outcome 验收附件

当前 runtime 的 `record_outcome` 接受可选 `verificationEvidence`：最多 16 项检查，记录检查种类、状态、有限命令模板、命令/结果摘要以及 `artifact:<sha256>` 或 `check:<sha256>` 逻辑定位，不接受原始日志或任意 URL/路径。

附件与 outcome 在同一事务中写入，注明调用方提交；它不取代根任务核验、可信 Hook 或 closure token。原 outcome 的 payload hash 保持原算法。相同附件重放幂等，冲突拒绝；不能给旧 outcome 补造当时没有的验收证据。

旧 shell 的工具发现视图保持冻结。新 shell 可以加载旧 writer，旧输入仍按原契约执行；旧 writer 不支持附件时明确返回 `VERIFICATION_EVIDENCE_UNSUPPORTED`，不能静默丢附件。当前桥接可提供新 schema，但不能把旧 stage 的运行时归属说成已升级。
