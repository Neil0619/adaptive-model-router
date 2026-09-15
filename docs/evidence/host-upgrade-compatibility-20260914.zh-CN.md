# 宿主升级兼容性开发验收记录

日期：2026-09-14；本机原生验收完成于 2026-09-15。分支：`codex/host-upgrade-compatibility`。基线：`16c439dd0bf3657ba06707ff15c1465613d49554`。

**源码实现、本机隔离全量检查、最终源码独立审查，以及候选 Router 的真实资格、委派和同子代理重启恢复均已通过。** 当前源码指纹为 `ad5fb0ed7f6a63c155cd6233a5ed5b719b76532b1d1bc086687212d4e924b783`。Windows 登录态验收和实际冷安装退役尚未执行；代码未提交、未推送、未全局安装。没有重启真实 App 或中断其他任务。

完整目标见[修改方案](../HOST-UPGRADE-COMPATIBILITY-PLAN.zh-CN.md)。机器可读证据见[验收快照](host-upgrade-compatibility-20260914.json)。以下区分源码回归、原生通用 Hook 实验与尚未完成的产品验收。

## 当前实现

| 场景 | 实现及验证边界 |
| --- | --- |
| 仅 App/CLI 版本、发行标签、程序摘要或路径变化 | 新资格使用真实功能依赖契约；宿主观测仅用于诊断，不再单独撤销资格或要求新探针 |
| 实际 Hook、信任、来源、父子关系或输入输出发生变化 | 继续验证这些真实依赖；未知操作和证据冲突不能被版本兼容掩盖 |
| 新调用与历史收据共存 | 新行为契约按原生调用验证；旧 schema、输入、原始结果、hostEvidenceDigest 和 outcome 保留 |
| 冻结 v1/v2 首次接入 | 新增独立冷安装、准确旧包保留、原生入口退役与逐任务实际接入流程；不放宽原 coldLegacy 的 Hook 冻结检查 |
| B 接入后发布同契约 C | 普通发布使用真实 writer/shell 与资格证据；保留共享 A 默认和历史 B stage，不把原创建者重标为 C |
| 已接受但未消费的消息 | 保存加密 checkpoint；用原主任务上下文向同一 child 明确补充，核验实际输入与最新结果后追加接续收据 |
| 原消息迟到 | 必须按真实 nativeInputId 审核；即使阶段已结算也重新显示待处理责任，原 outcome 不变 |
| 多个保留 checkpoint 的核验 | 一个实际操作共享 5 秒预算；原日志扫描在事务外，事务内只比较账本快照、来源身份和有效期 |
| 证据过期、日志追加/替换、新消息或跨任务缓存 | 不落收尾结果，明确 pending 并要求重新核验；事务内不会回退到全文扫描 |

主要新模块为 `host-compatibility.mjs`、`host-epoch-storage.mjs`、`runtime-epoch.mjs`、`runtime-cold-install.mjs`、`message-checkpoint.mjs`。outcome、Stop 和 maintenance 的实际入口已经接入 checkpoint 预检，不只是独立辅助函数通过测试。

消息检查点同样适用于普通新版任务的 App 重启；不能强制要求它存在首次插件升级的 epoch 记录。原宿主密文只作不透明比对和加密保留，不解密、不作为文本重发。新补充解决的是保留的业务要求，不能将原 accepted 行改写为已消费或拒绝。

## 最新完整检查

最新全量、validate、eval 和最终独立增量检查针对上述源码指纹。132 项相关组和25项驱动独立日志来自前一源码快照，它们均已在最终全量中重新运行。测试使用隔离目录和数据区，未指向全局 Router 数据库。最终日志另保留在私有候选目录的 `source-checks/`，不依赖 `/tmp` 长期保留。

| 检查 | 结果 | 日志 |
| --- | --- | --- |
| 完整测试，启用精确 v1 样本、原生 CLI 及本轮已捕获的 Hook 证据 | **541 项：538 通过，0 失败，3 跳过**；exit 0，172.2 秒 | `/tmp/router-host-upgrade-full-final4.log` |
| checkpoint/冷接入相关完整组 | 132/132 通过，0 跳过 | `/tmp/router-checkpoint-preflight-full.log` |
| 新增真实 outcome、Stop、maintenance 事务边界与多 child 预算反例 | 3/3 通过 | `/tmp/router-checkpoint-preflight-entries3.log` |
| 原生捕获驱动和真实消息解析重放 | 25/25 通过，0 跳过；已包含在最新全量中 | `/tmp/router-native-model-hook-receipts6.log` |
| `npm run validate` | 通过 | `/tmp/router-host-upgrade-validate-final4.log` |
| `npm run eval` | 232 个样例，0 差异 | `/tmp/router-host-upgrade-eval-final4.log` |
| plugin validator、`git diff --check` | 通过 | 本任务工具记录 |

三个跳过项均依赖 Windows：进程适配器、Windows Hook shell 集成、原生 PowerShell smoke 事件适配器。没有用 macOS 或模拟数据宣称 Windows 登录态通过，远程 CI 也尚未运行。

全量入口：`plugins/adaptive-model-router/scripts/test-isolated.mjs`；Node 为 `/Users/niuzhenya/.nvm/versions/node/v24.18.0/bin/node`；原生 CLI 为 `/Applications/ChatGPT.app/Contents/Resources/codex`。精确 v1 样本使用私有副本 `/tmp/router-host-upgrade-legacy-e784Nh/exact-v1`，摘要 `9d23b8ae47f6d9bd6b388a33b75c7f94741546116efa29d3e33d9ebc72a1c9b2`。

新增事务边界检查通过实际 service record_outcome、store.handleStop 和 service verify_maintenance 调用，并观测 fs.readSync 时的 db.isTransaction。父日志追加、同字节换 inode、消息 revision、新消息、过期、独立连接和错误任务均有反例。两个真实构造并结算的独立 child checkpoint 共用截止时间；超时保留责任，下一次真实入口可重新核验。

## 已获授权的真实通用 Hook 实验

用户授权原文：“允许隔离测试 Hook 信任”。此前准备的 A/B 各 7 个准确摘要已经分阶段在独立 CODEX_HOME 中信任并执行。两组共用 7 个原生 key，因此按 A、停止自有进程、B 的顺序应用；原 14 个定义无需重复批准。

私有原始证据目录：`/Users/niuzhenya/Documents/adaptive-model-router-archives/20260914-native-cold-entry-acceptance`。批准材料摘要：`sha256:0b8da24784af1f13856dbf6f0e089b3444d517470b67beebfa72217e759c897b`。

### 原父任务和原 child 冷恢复通过

- 父任务 ID：`01a0a047-66ca-70b0-ab23-7a80849fa949`。
- child ID：`01a0a047-93fc-7a03-bd1f-f7ed1ba9a402`，路径 `/root/cold_entry_child`。
- A 中只启动一个 child，完成 `CHILD_A_READY`。确认 A 自有 app-server 实际退出后，在隔离环境安装、信任 B。
- B 恢复同一父任务及原 child；父任务和 child 的固定 echo 均 exit 0。child 最终回复 `CHILD_B_FOLLOWUP_DONE`，父任务回复 `PARENT_B_FOLLOWUP_DONE`。
- B 的 child PreToolUse、PostToolUse、SubagentStop 来自新入口；原 child followup 没有再次 SubagentStart。父子 ID 和原生 transcript 路径不变。

证据为 `model-AB-A-verified-report.json`、`model-AB-B-report.json` 及各自 RPC 日志。初始 A 驱动仅识别旧展示字段而失败的报告仍保留；用实际 `subAgentActivity`、SubagentStart 和只读 thread/read 完成核对，没有重建 child。驱动现在直接启动准确 App 二进制，避免改写 PATH 后落到另一 CLI。

模型验证使用进程内短期外部 access token；没有复制 refresh token、刷新或注销账户、写隔离 auth.json，且全局认证字节未变。所有自有原生进程已实际退出；SIGTERM 退出没有被写成 code 0。

### 原生排队消息没有跨进程保存，原要求已显式恢复

A 中原主任务向 idle child 发送 `send_message`，宿主返回接受回执，但没有启动 child。B 恢复后首次 followup 未重复原要求；child 只处理新输入，原要求未执行。

`queued-message-source-audit.json` 逐字节比较原 sender 的 opaque payload 与 child 的真实 encrypted_content：原 payload 0 匹配，新 followup 有准确输入/turn 匹配。该失败保存在 `queued-AB-B-report.json`，不能表述为原生队列跨进程持久化成功。

随后同一主任务从保留上下文补充原要求，仍使用同一 child，实际得到 `QUEUED_A_REQUIREMENT_HANDLED RECOVERED_REQUIREMENT_DONE`。证据为 `queued-message-recovery-report.json`。没有重发原调用、替换 child 或覆盖旧结果；该实验中的原要求已经完成。

生产解析器的重放测试使用真实父/child 日志前缀和 Pre/Post/Stop 捕获，在隔离内存账本中验证 checkpoint→同 child 新输入→接续收据。原 accepted 行和原生源文件字节保持不变；不需要 runtime_epoch_tasks。账本前置状态是明确的测试构造，**不是原生 Router ticket、业务资格、迁移或生产 outcome 证明**。

### 不能由这些实验推出的结论

shell-only 的 thread/start/resume 加 thread/shellCommand 没有触发 Hook；正常 turn/start 才出现实际 Hook 记录。MCP 的同 ID 冷恢复也已单独通过，但它同样不能替代真实 Hook 证明。原生安装会删除旧缓存路径，测试先保留了准确旧包；保留副本本身不等于原任务已接入。

上述 A/B 是通用日志 Hook 包，验证的是本机原生父/child 的入口恢复能力，并非一次真实 Codex App 版本升级，也不是候选 Router 的完整业务链路。

## 独立审查与历史失败

最终独立审查由 gpt-6-astra / xhigh 子代理完成。发现并修复一个 P2：非 root 消息核验错误依赖同任务所有历史 sibling 日志，无关旧日志缺失会阻断恢复。现仅筛选原 author 对应的来源，并优先使用保留的准确 checkpoint 来源，避免被当前主任务日志遮蔽。

独立增量正反例 **7/7 通过**，覆盖无关历史日志缺失、真实 sender 缺失、author/parent 错配、正确 locator 寻址和不可读真实 locator；未发现新的实质缺陷。root 新增无需私有捕获的完整 sibling 生命周期回归，实际走 checkpoint→补充→outcome→迟到审核；随后删除真实 sender 必须重新 pending，保留原 outcome。最新全量包含该用例。审查阶段已核验全部输入与最新结果，唯一 passed / full-checks outcome 为 seq 1470。

此前实现阶段的唯一 `passed / full-checks` outcome 为 seq 1468，对应 f909 源码和当时通过的检查；独立审查后修复的最新结果另由 seq 1470 记录。历史 outcome 没有改写，两者都不授予候选插件原生资格。

历史检查和失败记录原样保留，不能与最新源码混用：

- `91a0f1…` 的 527 项检查为 521 通过、2 失败、4 跳过；失败是旧 cold 桥拒绝变化后的 Hook。对应旧审查/驱动阶段 seq 1461、1462 仍是 failed，后续没有改写。新增独立冷接入协议已通过这两项原正向要求。
- seq 1463 是可信 bounded 授权限制导致无模型阶段未执行的 tooling 失败；之后的真实模型实验另有证据，没有补造旧阶段成功。
- `53acba…` 的 537 项检查全部可运行项通过，但随后发现新增 checkpoint 在写锁内读源，继续修复，没有以旧通过结果跳过并发问题。
- `f909386…` 首次全量出现测试夹具缺 created_at：536 通过、1 失败、3 跳过（`full-final2.log`）。补齐 root 所有的隔离夹具后，25 项捕获重放及新全量均通过；生产代码未为通过该测试而放宽校验。

## 候选 Router 原生验收

候选在独立目录 `/Users/niuzhenya/Documents/adaptive-model-router-archives/20260914-host-upgrade-router-candidate` 完成了原生注册、运行时登记、信任与真实模型执行。版本为 `0.4.0+codex.20260914153541`，批准材料摘要为 `sha256:c82f6c86424b574572930e16399aeec738f8243ae66f71dd0a443e4031ef83dc`。用户本轮“批准”后，7 项实际 Router Hook 的原生信任读回均通过；182 个文件在源副本和安装副本各核验一次。全局配置、凭据文件保持原样，隔离域未创建 `auth.json`，所有自有原生进程均有真实退出回执。

| 验收项 | 实际结果 |
| --- | --- |
| Router 自身资格 | schema 2 passed；真实 child `01a0a0b3-b2d6-7c62-8720-ea9068f01488`，原生无工具来源复核通过，唯一 outcome seq 1 |
| 普通委派与补充 | 同一 child `01a0a0b6-a3bd-72c2-8cc4-161069d364df` 完成 initial、followup 两次指定命令与结果 |
| 原生进程退出前 | 已 accepted 的必要 `send_message` 尚未消费，实际 `manage_stage checkpoint_requirements` 保全一条加密检查点；根 turn 经真实 interrupt 完成，再确认自有进程退出 |
| 恢复后继续原责任 | 恢复原 root `01a0a0a7-eca4-7fb1-b409-be4cc278a0f1`、原 child 和原日志；新语义 followup 完成原 recovery 要求，未创建替代 child |
| 消息处置与结算 | 实际 `resolve_checkpoint` 返回 `responsibility_resolved`，原消息仍为 accepted、`originalMessageConsumed:false`；原记录与先前快照一致，业务唯一 outcome seq 2 |
| 终态 | 三条 echo 各执行一次、exit 0；资格与业务两个 outcome 均 passed；最后真实 Router 状态 gate available、stageClosure null、pendingOutcomes 0 |

原始证据：[信任读回](/Users/niuzhenya/Documents/adaptive-model-router-archives/20260914-host-upgrade-router-candidate/approved-router-trust.json)、[资格验证](/Users/niuzhenya/Documents/adaptive-model-router-archives/20260914-host-upgrade-router-candidate/native-qualification-a5-verified.json)、[退出前检查点](/Users/niuzhenya/Documents/adaptive-model-router-archives/20260914-host-upgrade-router-candidate/native-business-open-1-verified.json)、[恢复及结算](/Users/niuzhenya/Documents/adaptive-model-router-archives/20260914-host-upgrade-router-candidate/native-business-recover-1-result.json)。这些是实际候选业务路径，未以通用日志 Hook 实验或合成账本代替。

验收驱动修正过新 root 首轮前不能读取完整轮次、退出清理必须独立于快照成功、初次运行时登记、隔离 CLI 显式启用原生 v2 接口，以及指定测试子目标以覆盖委派等准备问题。缺少接口和精确机械任务留在本地时，Router 分别保留了真实 continue 记录；没有为这些结果补造子代理或 outcome。外层只读复核也纠正了隔离日志根路径与 native UUID/agent path 的区分；所有初始失败报告仍保留，复核只读取原始证据，没有重跑已完成子任务。

测试目标刻意禁止根模型读取文件，因此恢复时由持续存活的外层编排器从真实 child 日志补充准确 `nativeInputId`，随后由目标自身的生产 `manage_stage` 严格核验并结算。没有解密或重新发送原始宿主密文，没有直接写入业务 outcome。

最终 gpt-6-astra / xhigh [独立原生证据复核](/Users/niuzhenya/Documents/adaptive-model-router-archives/20260914-host-upgrade-router-candidate/native-driver-final-verification.json)通过：两个真实 child、两个唯一 passed outcome、三条业务命令各执行一次且 exit 0，原 accepted 记录不变，七个自有原生进程均实际退出。正常 root 可沿 `read_checkpoints.source`、原 root 日志中的 child UUID 和对应 child 日志核验准确输入 ID，无须数据库私钥、解密或新增宿主能力；本次未证明禁止文件读取、仅有 Router MCP 的受限宿主也能完成同样恢复。

本任务验收阶段的 14 项输入与最新结果已逐项核验，closure revision 13 后记录唯一 passed / full-checks outcome seq **1471**。最终本任务 gate available、stageClosure null、pendingStageWork 为空；先前已有的一条历史 pending outcome 保持原样。本次开发与本机隔离验证收尾完成，源码独立审查 seq 1470 和隔离业务 seq 1/2 均保留原始含义。

## 安装及跨平台边界

真正的冷安装退役仍须在授权且安全的窗口执行：生产检查会拒绝真实 App/旧 writer 仍运行的情形。本轮没有替换全局进程清单、伪造退役证明或绕过这条保护。该一次性插件接入与将来单纯 App 版本变化不同；将来同契约 App 升级不需要重复插件安装或新增 Hook 版本。

Windows 原生登录态验收还需要可用的原生 Windows 目标；当前只暴露 local 主机。不会恢复或使用已废弃的 windows-codex。以上剩余项完成前，不宣称完整 P0–P5 交付或全局插件已具备全部能力。
