# 宿主升级兼容性：本机全局安装

2026-09-15，用户要求“完成全局安装”。本记录承接[开发验收记录](host-upgrade-compatibility-20260914.zh-CN.md)，区分已通过的开发/隔离检查与本次真实全局切换。

最终状态：全局安装、本任务实际委派和自动接入服务的本机验收均已完成。自动服务持续运行，安装验收心跳已暂停；无需用户再次重开 App 或批准信任。下文按实际发生顺序保留中间失败及待办状态，最终结果以末节“自动协调器全局部署与最终验收”为准。本次源码尚未提交、推送。

## 安装前发现与处理

前一候选源码指纹 `ad5fb0ed7f6a63c155cd6233a5ed5b719b76532b1d1bc086687212d4e924b783` 的本机隔离业务链路已经通过，但真实安装前检发现本机多旧运行时组合尚未被完整覆盖。原候选不能直接安装；此前隔离通过记录保留，不被改写为全局通过。

本机实际保留的三代分别为 v1 `9d23b8ae…`、当前默认稳定壳 `22a9d720…`、资格兼容修补 MCP 壳 `dc3797f7…`。主要阻断包括：

- 准确默认包的旧 MCP 实现未被新 `reviewedEntry` 覆盖，实际 `qualifyHostEpochPublication` 已重现 `unreviewed_invocation_registration`。
- 单 source 的 publication/retirement 不能为其它保留执行代提供证明；重复退役会错误改写休眠任务的原出生分界。
- portable 候选在隔离测试中登记过其准确缓存，但不能把这份登记移作全局证据。全局使用受管生成的稳定绝对入口。
- 原生 `plugin/install` 不负责替换已配置的同名 marketplace。隔离实验确认需要先用原生 marketplace remove/add 更换准确来源，再安装并读回核验；仅成功回执不足。

修复仅针对上述实际安装边界，原任务、阶段、消息、结果和 outcome 继续保留。前检独立审查的唯一 outcome 为 seq 1473，表示前检完成及阻断确认，不表示插件已经安装。

## 冷窗口与安装器

私有准备材料位于 `/Users/niuzhenya/Documents/adaptive-model-router-archives/20260915-host-upgrade-global-install`。安装器在真实 Codex/ChatGPT 宿主仍运行时只等待；不会伪造进程清单、强制结束业务任务或改写正在加载的入口。真实冷窗口到达后才取得安装锁、备份全局账本和旧缓存，调用源码管理入口完成准备、原生注册及退役。

准备中的安装器包含实际 marketplace/版本/缓存/MCP 与 Hook 来源验证、原业务表不变核对、准确 Hook 定义信任读回，以及通过源码恢复旧入口和默认代的失败恢复。原生包装层未提供伪造 cold、passed 或 no-child 的参数。安装完成后的主任务/子代理实际接入证据另行核验。

安装器独立复核后补齐了两项保护：原生 `config/batchWrite` 使用准确 user layer 的 `expectedVersion`，只写本次 7 个 Hook key；恢复也只恢复本次准确写入，拒绝后来修改。原生隔离实验已验证旧版本 CAS 被拒、带点号的引用 key 写入、单 key 删除、无关 key 保留，自有进程已真实退出；没有安装测试插件、信任 Hook 或运行模型。业务不变检查还明确覆盖原 `runtime_tasks`、`runtime_stages`、`runtime_invocations`、`runtime_call_receipts`、`local_salt` 和首次 bootstrap。私有安装器 7 项回归通过。

## 实际历史消息规模与兼容边界

私有账本副本包含 203 个保留子代理，其中 125 个有 accepted 输入。旧实现把所有来源放进一个 5 秒预算，并对每条输入重新扫描父日志。当前父日志单份约 191 MiB；这一方式会把已完成输入误报为来源未核实。

候选 `30f34083…49f39` 引入批次内准确来源索引，普通 Hook 保持 5 秒，显式冷前检按有限 child 清单逐项核验；索引不跨批次存活，来源变化仍拒绝。指定历史 child 的 25 条误报降为零，未知操作记录继续保留。完整批次实际遍历 203 个 child 约 13 秒，没有跳过历史任务。

静止读取后仍发现两项不会随重启消失的边界，继续修复后才安排退出 App：14 个 child 的共享父源含一条约 16.044 MiB 的原生 `compacted` 记录；另 4 个 child 的原调用使用推理 UUID，而准确原生 `SubAgentActivity` 和返回记录使用 Hook 记账的宿主轮次 UUID。不得删除压缩记录、修改旧 caller_turn_id，或仅按参数相同放宽身份检查。

这版中间源码的默认全套检查为 552 项、538 通过、14 项依赖平台/显式隔离材料而跳过；准确三旧包的相关回归为 124/124。它已准备但未全局注册的安装包不代表最终修复通过；新增静态兼容修补完成后必须重新冻结、测试和打包。

最终消息修补保持普通日志行上限不变，只在确定的原生 `compacted` 元数据记录上扩展有界读取；跨推理/宿主轮次必须同时匹配准确 child、调用、原生活动和完成返回证据。缺少证据仍保留。最终源码的正式私有预检遍历 203 个 child、449 条 accepted 输入，耗时 11.073 秒，pending 为 0；原消息行逐行不变。

## 物化入口的验证器隔离修正

在执行最终稳定壳资格验证前，主任务发现旧验证器直接启动物化包 launcher 会重新采用其 `runtime-host.json` 的绑定账本，并且把退出码 0 当作入口可达；这既可能触碰绑定状态，也可能把拒绝执行误判为通过。发现后没有对全局绑定壳运行该旧验证器。

修正仅发生在源码管理的两个验证器：完整核验原包，只将三份经过校验的原生适配配置映射到临时入口，其它文件、writer 摘要和 descriptor 保持准确一致。真实 Hook 必须留下准确 pid、任务、代际和 completed invocation；拒绝或静默退出 0 均不能通过。生产 `node-launcher.mjs` 未改，未加入绕过绑定的环境变量。独立 `hookShellRoot` 缺少映射证据时仍明确拒绝。

相关 144 项检查全部通过。其中隔离反例覆盖原绑定账本及目录的内容、mtime、ctime 不变，以及入口拒绝、静默退出、适配配置和 writer 篡改。三个准确历史源分别对绑定 canary 的物化 B 运行真实资格验证，原账本所有表均不变。

## 最终候选与当前状态

最终候选 `0.4.0+codex.20260915030515.runtime2` 的源码指纹为 `40189647d64b21537523eb884550db104eba4c173f52bc1a7d0eb2dd9bc2eee2`，安装包摘要为 `8732d9524390ff549a3e9fc616dacc41ffc7341ae8d6049ace8de0d27cc05989`。通过受管版本更新与 `prepare-shell` 生成；中间两版未登记、未信任的候选已移入本次私有归档，未改动在用包。

- 最终完整测试 566 项：563 通过，3 项 Windows 专用检查跳过，0 失败。日志：`/tmp/router-host-global-final-full-40189647-20260915.log`。
- validate、插件校验、`git diff --check` 通过；232 个离线策略用例无差异。
- 主任务独立执行最终物化安装包对 v1、原默认壳、MCP 修补壳的源码管理隔离资格验证，三项全部通过；没有进行全局 publication。
- 原生 App CLI 为 `0.154.0-alpha.6.2`。隔离原生安装只用于读取最终 7 个准确 Hook 定义，未执行模型或 Hook，未写信任；自有原生检查进程已真实退出。
- 本阶段已通过最新子任务结果和输入责任核验，以唯一 `passed / full-checks` outcome seq 1474 收尾；`stageClosure` 为空，委派 gate 可用。该 outcome 表示安装前修复与验证通过，不表示全局安装通过。

当前全局默认仍为 `22a9d720…`，原生插件来源仍为此前 MCP 修补入口。用户已明确回复“批准全局 Hook 信任”，授权[本次全局信任材料](/Users/niuzhenya/Documents/adaptive-model-router-archives/20260915-host-upgrade-global-install/GLOBAL-HOOK-TRUST.zh-CN.md)中的 7 个准确定义。原请求材料保留不变；另存 `global-hook-trust-approval.json`，保留用户原文、当前任务、批准时间和原材料摘要。批准回执 SHA256 为 `be15d71910a0be6babd9d0ccd279895eb25288b64b2683fe2318fdf543680268`，最终 `installation-config.json` 指向该回执。实际全局信任写入仍由冷窗口中的原生配置 API 执行。

持久安装器、失败恢复、launchd 配置及最终授权配置均已准备。独立启动检查还发现：失败后即使旧注册已完整恢复，原包装器也不会重新打开 App，可能再次造成长时间无反馈。私有安装器已修正为仅在原注册、准确自有信任、业务与无关配置均验证恢复、安装锁释放、再次确认冷窗口后重开准确 App；原失败状态和退出码继续保留。未验证恢复或等待超时不会无条件重开；失败结果另有有界系统通知及准确私有记录位置。私有安装器 10 项回归通过。该修正未改变冻结插件或已批准的 Hook 定义。

## 真实冷窗口中的独立宿主

启动检查进一步确认，单独退出 App 不足以满足本机冷窗口。独立 iTerm 中的 Codex PID 20862 运行在本项目，子进程 20944 正在加载旧 MCP 修补入口；Chrome 的原生连接 PID 7674 属于 Google Chrome PID 674，当前原生启动配置指向真实 Codex CLI 和全局 Codex HOME。扩展具有 `codexRuntime/ensure`、`restart` 和自动重连能力，不能仅杀掉连接进程或将它排除。

另外，PID 910/912 是当前 App 的崩溃收集器及自监控配对；真实映射文件、OpenAI 签名、完整二进制摘要、启动参数、用户和出生时间均已只读取证。它们不执行 Router 业务，但生产 guard 仍按 App 路径阻止冷切换。私有安装器只在所有真实业务宿主退出、剩余阻断仅为这两个准确进程时，先等待 10 秒自然退出，再逐次重新验证身份并各发至多一次 SIGTERM，之后仍须由完整真实进程清单通过原 guard。任何新宿主、未知进程或身份变化都保留阻断，不升级 SIGKILL，也不修改 Crashpad 数据库。SIGTERM 不代表保证刷盘的优雅退出。

私有安装器还在原 guard 之前额外拒绝仍存活的已取证 Google Chrome 本体，覆盖原生连接重连空窗；此检查用于维护及每个实际安装边界。生产 guard、冻结插件和 Hook 定义没有修改或过滤。等待记录现包含真实剩余阻断的 PID 与操作系统可执行路径。全部私有安装器回归共 15 项，15/15 通过，日志位于本次私有目录 `private-installer-tests.log`；测试未向真实进程发信号。

最终启动检查以唯一 `passed / full-checks` outcome seq 1475 收尾，最新 `stageClosure` 为空，委派 gate 可用。该结果为准确授权材料与安装启动边界通过，不表示已完成全局安装。

第一次持久 launchd 安装器于 `2026-09-15T03:41:01.671Z` 启动，PID 37881，任务名 `com.niuzhenya.adaptive-model-router.host-epoch-install-20260915`。当时读回为 `running` / `waiting_for_hosts`，安装步骤为空、`globalInstalled=false`，新稳定入口尚未登记。该历史启动回执保留在 `launchd-start-receipt.json`；后续实际结果见下节，不能把当时状态当作当前状态。

## 手动重开后的真实失败与续装修复

用户确实退出了各宿主，安装器于 `03:47:09.038Z` 取得真实冷窗口，随后完成旧缓存备份。`prepare-cold` 于 `03:47:22.716Z` 开始、`03:48:30.029Z` 以退出码 0 完成，共约 67 秒；App 在 `03:48:19Z` 被用户手动重开。外层在 `03:48:30.415Z` 再次检查冷窗口时退出，最终状态为 `installation_failed_preserved`，`globalInstalled=false`。原日志、准备回执、第一次备份及 [失败状态](/Users/niuzhenya/Documents/adaptive-model-router-archives/20260915-host-upgrade-global-install/installation-state.json) 保留不变。

这次失败有两个独立原因，不能只归因于用户提前重开：

1. 原私有安装器使用 launchd `ProcessType=Background`。历史消息校验首次读父记录的 5 秒预算耗尽，失败又按同一源缓存，最终 60 个阶段的 217 条消息统一显示为 `native_message_source_unverified`。同一冻结源码、同一只读备份、同一 60 个阶段，在真实 launchd Background 下耗时 11,723 ms、217 pending，所有底层异常均为读取超时；Interactive 下耗时 5,289 ms、0 pending，原消息行不变。两个父记录约 368 MB、462 MB，安装期间没有变化。独立子任务以相同最小环境配合 `taskpolicy -b` 也得到相同 217 条失败，去掉后台策略后为 0。Adaptive 仍可能处于 Background，不能凭配置名称判断已经修复。
2. 准备步骤已提交不可变记录，但原 `step()` 在解析回执、赋值 `prepared` 前执行冷窗口复检，异常使外层丢失安装编号，恢复条件未满足。编号实际为 `c8e9cc8e53fedc5fc8683237305e2d074a3a12386a13f5a5847643943319be81`。新的候选壳已登记，三个旧 source 的 publication 也已保存；默认与原生注册没有切换，retirement/recovery 均为 0。不得再将该候选当作未登记目录归档。

诊断阶段通过最新输入与结果核验，以唯一 `passed / full-checks` outcome seq 1476 收尾；它证明根因和恢复前置状态，不代表全局安装通过。

修复保存在同一私有材料目录的 `continuation-1`，保持冻结插件源码、候选包和原批准的 7 个 Hook 完全不变：

- 一次性续装 worker 使用经实际验证的 Interactive 调度；等待仍每 5 秒检查，不常驻运行安装业务。
- 源命令成功后先保存原始回执、回调赋值并持久化结果，再检查冷窗口。prepare/install 两类副作用均有回归覆盖；非零退出或非 JSON 返回不伪造成功。
- 以原回执/原失败状态/准确不可变记录摘要绑定此次续装。复用已完成的 preparation，拒绝已有 retirement/recovery 的其它阶段；不会重复 prepare 或改写旧记录。
- 在任何 marketplace 改动前核验完整 registry、bootstrap、sourceSnapshot、完整 defaults、各 cold publication、保留包、候选包，以及每个仍可执行旧入口的存在、字节、非重定向属性和 archivePath 尚未出现。安装源仍独立重验全部原约束。
- 刷新全部原生消息证据，不使用旧 217 pending 回执或此前 203-child 预检作为放行凭据。`04:13:28.621Z` 的真实 launchd Interactive 全量只读前检覆盖 **206 children / 465 accepted**，耗时 **10,500 ms**、**0 pending**。真正切换前还会在冷窗口再次检查。
- 如果还未开始原生修改而前检失败，仅在本轮冷备份时的完整配置、插件和缓存包、完整 default 行、原生注册及业务表均验证不变后才允许重开 App，原失败状态继续保留；部分修改后的恢复仍由源码及原生 API 完成，不整体恢复 DB。
- App 重开后的准确 Crashpad 进程身份已重新读取并固定为 PID 41708/41710、出生 `03:48:19Z`，原文件映射、二进制和参数摘要均符合原审查范围。只在其它业务宿主退出、自然等待 10 秒后才可逐次核验并至多各发一次 TERM；旧 PID 不被复用。第一次安装没有实际发送清理信号，宿主自然退出即达到冷窗口。

续装器回归 **29/29 通过**；准确配置、原准备状态和包字节的只读验证通过。完整插件源码未改变，所以此前 563 通过 / 3 Windows 跳过和离线评测保持原验证范围，未将它们重标为本次安装通过。结束的原 worker 和只读 QoS 探针已注销，全部历史日志保留。完整实时预检位于 `continuation-1/live-readonly-preflight.json`，测试日志位于 `continuation-1/private-installer-tests.log`。

最终续装修复以唯一 `passed / full-checks` outcome seq 1477 收尾，最新 `stageClosure=null`、委派 gate 可用。独立审查和 root 启动摘要匹配最终 worker SHA256 `27a60cc0dc0e047c0b1bb2ab5736930d7a32fd861d7d4130fac9b0cfb1da46b6`。

第一轮续装 worker 于 `2026-09-15T04:16:44.889Z` 启动，PID 73743，任务名 `com.niuzhenya.adaptive-model-router.host-epoch-continuation-1-20260915`。`04:17:06Z` 当时读回为 running / waiting_for_hosts，步骤为空，`globalInstalled=false`。历史启动回执为 `continuation-1/launchd-start-receipt.json`，该轮最终状态见 [第一轮续装结果](/Users/niuzhenya/Documents/adaptive-model-router-archives/20260915-host-upgrade-global-install/continuation-1/installation-state.json)；随后实际安装与回退如下。

当前仍未完成全局原生注册、实际信任写入及重开后的真实任务接入验收。续装成功后会尝试自动重开准确 App；如果前检失败且原安装保持原状已被完整验证，或部分修改后原安装已被完整恢复，也会重开并保留失败回执。尚未运行原生 Windows 登录态验收。本次源码未提交、未推送。

## 旧 Hook 信任升级场景的修复

用户“已打开”后读取真实结果：第一轮续装在 `05:47:23.653Z` 达到冷窗口；全量消息扫描 9,755 ms、0 pending。`install-cold` 于 `05:47:35.513Z–05:47:54.846Z` 完成原生注册及旧入口退役，返回 `awaiting_task_entries`。随后私有 `verifyHooks()` 在原生信任状态断言处失败，尚未写入新信任。

源码于 `05:47:56Z` 完成 `restore-cold`，原生 marketplace/plugin 注册、旧缓存及原七项信任恢复验证完成于 `05:47:58.762Z`，App 随后自动重开。冷窗口内从开始到恢复约 35 秒。最终为 `failed_old_registration_restored`、`globalInstalled=false`；自动重开不能视为安装成功。

此次源退休记录为 `bf6c3c7c-a6ce-4f0e-8241-ccc91345c895`，恢复记录为 `fed42e77-410c-4c46-90f7-9c3ed1d97b81`，均属于原 preparation。完整 default 已恢复；候选在 task、stage 和 epoch receipt 中的使用均为 0。独立只读核对原冷缓存回执的 1,559 个文件，missing/changed 均为 0，原七项 Hook state 逐项一致。

此前原生隔离实验只覆盖全新安装的 `untrusted`，未覆盖已有旧信任的升级。以实际旧配置中的七个准确 `trusted_hash` 在新的隔离 HOME 重现：安装相同候选后七项均为原生 **`modified`**，旧私有校验器出现与实际相同的断言失败。原实际失败回执未保存完整 inventory；`modified` 的准确观察来自这项原生重现实验，不能伪填回旧日志。

修复仅在私有 `continuation-2`：

- 迁移前接受 `trusted/untrusted/modified`，先要求单一准确项目、无原生 errors/warnings、七个唯一 key、准确批准投影和 sourcePath；启用、非托管、命令和 currentHash 偏差仍拒绝。`modified` 不代表可信，真正执行前的验证仍必须全部 `trusted`，生产 readiness 未放宽。
- 写信任前保存真实 inventory 和状态；通过原生 `config/batchWrite` 的 expectedVersion CAS 写入已批准七个准确哈希，再重新 `listHooks` 验证。最终原生隔离实验已完成 **7 modified → 7 trusted**，全局配置未改，未调用模型或执行 Hook，自有客户端实际退出。
- 原 prepared-only 分支保留；新增准确恢复链续装，固定两次原失败状态、prepare/install/restore 收据与摘要，以及原退休/恢复 ID、record 摘要、单条计数、引用和完整 default 关系。拒绝后续新退休/恢复、候选 task/stage/receipt 使用及任何原入口或来源漂移，保留全部原历史。下一次仍由源码创建新的退役记录，不改写旧记录。
- 回退完成判断补充完整默认行、原插件包及原缓存锚点摘要读回。新启动准确 Crashpad profile 为 6378/6380、出生 `05:47:58Z`，实际身份和文件映射再次核对；其余退出保护不变。

回归 **35/35 通过**，独立只读审查以唯一 `passed / full-checks` outcome seq 1478 收尾；它仍表示续装修复通过。候选、源码、批准的七项 Hook 和原材料均未改变。最终 worker SHA256 `534a1905da00ac97e00cf5b3c9856b467eaccd3ea8726fef7e658b90a81a1957`，配置 SHA256 `ac5b6402a67941ddc5d5e963e8ff6bf1f9a901ef971402baed1a57c779a1f157`。

活动期间两次全量预检对本任务仍在追加的父记录保留了 184 项未验证责任，没有据此放行。其后同一 39-child 子集只读检查全部通过，底层错误为空；完整预检以等待命令完成再返回的方式重做，`06:02:38.999Z` 结果为 **207 children / 467 accepted / 0 pending**，耗时 **12,170 ms**，保存为 `continuation-2/live-readonly-preflight-stable.json`。真实安装仍以冷窗口中新扫描为最终门槛，不能用活动期读回或旧报告代替。

第二轮续装器已于 `2026-09-15T06:04:34.051Z` 启动，PID 36331，服务 `com.niuzhenya.adaptive-model-router.host-epoch-continuation-2-20260915`，实际读回 running / waiting_for_hosts，步骤为空、`globalInstalled=false`。准确配置、最终代码、原生隔离结果、35项测试及全量前检摘要记录在 `continuation-2/prelaunch-verification.json`，启动读回为 `continuation-2/launchd-start-receipt.json`，实时状态为 [第二轮续装状态](/Users/niuzhenya/Documents/adaptive-model-router-archives/20260915-host-upgrade-global-install/continuation-2/installation-state.json)。此前已退出的第一轮 worker 与原生只读前检服务已注销，原日志不改写。

以上是第二轮续装启动时的历史状态。随后安装已完成，重开后的实际状态与接入修复见下节；不需要对同一七项信任再次批准。

## 第二轮原生安装完成后的实际接入修复

第二轮安装器于 `2026-09-15T06:09:38.333Z` 正常退出，状态为 `installed_awaiting_actual_task_acceptance`，`globalInstalled:true`。原生安装、七项准确 Hook 信任写入及读回、重新启用和 App 重开均成功；新的退役记录为 `51916878-7499-4998-9fb1-8e0f82595c95`，关联原恢复记录，原历史不变。原生版本仍为 `0.4.0+codex.20260915030515.runtime2`，包 `8732d952…`、源码 `40189647…`。真实状态保存在上文链接的 `continuation-2/installation-state.json`。

这份安装回执不代表本任务已经使用新引擎。重开后实际 B 入口已执行并选中原 A，但任务、88 个保留阶段仍为 `9d23b8ae…`。逐项核验发现以下真正的接入缺陷，并在源码修复：

- 原迁移要求全部 62 个历史 child 都再进入一次 B Hook，连 settled 历史也不例外。61 个 child 的原核验 token 与完整当前责任一致，可以原样保留；另一个维护 token 陈旧，已通过原 `begin_maintenance`、真实同 child 无工具补充、15 项原生操作回执重核与 `verify_maintenance` 收尾。原 outcome 不变，未唤醒其余已完成 child。
- 旧 v1 qualification 使用不带 runtime 后缀的 key。新版发现逻辑遗漏了该 key；现在仅在新 key 缺失时查旧 key，已有 invalid/failed/pending 不会被旧成功覆盖。发现不等于验证通过。
- 宿主的准确原启动返回实际为 `task_name`，原资格迁移只接受 `agent_id`。修复后要求它与同一个宿主 `subAgentActivity` 的 call、child ID、完整 agentPath 同时关联；错误路径、冲突 ID、空结果继续拒绝。原资格源已在本机真实原生 API 与原始日志下重新验证通过，尚未将开发诊断 token 提交为接入记录。
- 根任务历史存在无 call_id 的异步任务消息、已结束的旧 code-mode 和缺少后加 Hook 账本的进程。升级只核验解释器/原生命令是否静止，保留未验证的业务状态；不会把历史脚本完成解释为业务成功。真实终态须绑定准确任务、轮次、进程句柄及命令或原生轮询。该逻辑不用于 child 结算或全局预留回收。
- 已安装 B 入口保持原字节和信任。新协调器验证准确 B 源码，并调用其自己的原退役验证器重核三个旧源；新版引擎的写入/调用互操作另行执行，不重标原 B 证明。提交时仍复核实际入口登记和内容。

修复后的根任务日志只读核验保留了历史未知业务效果，历史进程均找到相应原生结束证据；当前正在执行的检查本身仍被识别为在途，未伪造空闲或 task_complete。准确已安装 B 到开发候选的源码管理隔离资格验证已通过，包含真实旧 launcher、Hook、MCP 和 lifecycle 入口；原绑定 HOME 未被作为测试目标。

最终全套回归为 **576 项、571 通过、5 跳过、0 失败**，日志 `/tmp/router-post-open-full-20260915.log`。另用已获批准并保存的真实原生材料补跑 `native-cold-hooks.test.mjs`，**25/25 通过**，覆盖其中两个被跳过的原父子恢复和真实消息回放案例；日志 `/tmp/router-post-open-native-capture-20260915.log`。因此合并覆盖仅剩 3 项 Windows 专用检查未运行，不能表述为本轮重新进行了原生 Windows 登录态验收。定向回归、validate、插件校验、232 个离线用例及 diff 检查也通过。

最终修复源码指纹 `d3313321533f5db641f9f3d71ba7bfca7285a80054488131cd0c24425e05e395`；通过 `prepareRuntimeCandidate` 保留准确 B 原生配置后的受管引擎摘要为 `316a1facca3b8b1cc8f71a5da80c8e8e1d1aeb08bab5e2c5b737e16144cdc84a`。三份准确旧源及已安装 B 到该引擎的四组源码管理互操作验证全部通过，随后只追加包和 publication。原生稳定壳、七项 Hook 信任、缓存目录、全局默认 B 和全部任务绑定不变。在线备份和详细结果分别为 `continuation-2/engine-repair-before.sqlite3`、`engine-repair-publication.json`，仅存私有目录。

发布后使用真实只读账本及原始日志重核本任务 **62/62** 历史 child 的当前闭合责任与原 token，bad 为 0；包含根日志读取的共享 5 秒检查耗时 4,912 ms。这是准备验证，不是迁移提交；实际完整交接还必须在真实根任务结束后重读来源并通过事务比较。

`07:20:16Z` 已启动一次性接入协调器 `com.niuzhenya.adaptive-model-router.adopt-current-task-20260915`，只针对本任务，最长等待 30 分钟。它从受管不可变修复包加载源码，使用实际原生 `thread/read`、原 qualification adoption 和 handover token，不启动模型、不更改默认/信任，也不修改其它任务。任务仍活动或原记录正在追加时已实际返回等待/来源变化，未提交接入。实时状态为 `continuation-2/current-task-adoption-state.json`，启动及准确 worker 摘要在 `current-task-adoption-launch.json`。已正常结束的第二轮安装器服务已注销，日志保留。

同时在本任务安排了原生心跳 **Router 安装后接入验收**（自动化 ID `router`），在协调器完成后继续核验实际 C Hook/读取、独立委派和唯一 outcome；状态无变化时保持安静，完成后暂停自身并注销已退出的接入服务。当前真实任务尚未切换，最终独立验收仍未完成；不能把本节的安装、回归或 publication 表述为最终全局功能验收通过。用户无需再次退出或重开 App。本次源码尚未提交、推送。

## 本任务空闲接入的时间预算修复

第一轮协调器在本任务真实结束后的空闲窗口到达 handover 提交，但被 `native_source_changed` 拒绝，未修改任务或阶段绑定。源码核对发现，原实现把整任务历史读取开始时的 5 秒截止时间沿用到提交，而且将该截止时间耗尽也报告成来源变化。前述只读扫描已经耗时 4,912 ms，提交前还有冷消息检查点复检。原失败日志没有逐步耗时，不向旧回执回填推算值。

负向回归重现了两个具体问题：在真实根日志读取中模拟 6 秒耗时，原代码报读取预算耗尽；单独过期的未使用 token 被原代码误报成来源变化。修复后，写事务外的整任务扫描共享 15 秒，完成准备后 token 有效 5 秒，冷消息检查点复检结束后再启用独立 5 秒提交预算。提交前和实际更新绑定前均重新比较来源身份；过期、提交预算不足、来源变化分别报告，事务失败整体回滚。普通 Hook、闭合检查与预留回收的预算未改变。

新增回归与原并发/回滚用例共 4 项针对性检查通过。最终全套 **578 项、575 通过、3 项 Windows 专用跳过、0 失败**，耗时约 216 秒；日志为 `/tmp/router-post-open-budget-full-20260915.log`，测试前后源码指纹一致。已批准原生材料回放 **25/25** 通过，日志 `/tmp/router-post-open-budget-capture-20260915.log`。validate、插件校验、232 项离线用例和 diff 检查通过；这不包含新的原生 Windows 登录态验收。

本轮源码指纹 `d8b0e9a1a56a096d3dab94d7dd0b1dad6cca3ae1bf6632e74162a282f73a254d`。通过源码管理的 `prepareRuntimeCandidate` 生成 C2 `4b950f2687b1a8da98ce87a66a5c813a51f7ccd76c8292f7ad38e9d7862176a9`，三份准确旧源和已安装 B 到 C2 的四组原生入口/账本互操作验证全部通过后，才追加不可变包和 publication。原稳定壳、全局配置摘要、完整默认行及原退役验证在发布前后逐项一致。未切换其它任务，未新增 Hook 缓存版本或信任；C1 发布历史保留，其引擎未被任何任务接入。

旧接入 worker 已于 `07:27:21Z` 停止，服务随后注销，原日志保留。新的单任务协调器于 `2026-09-15T07:45:10Z` 启动，服务为 `com.niuzhenya.adaptive-model-router.adopt-current-task-budget-20260915`，worker 摘要 `2321ada496dc6adf54c842912c419e489ab8fb2c6c10e15097ab46da9ba80d0c`。它从 C2 不可变包加载，增加精确步骤和耗时记录；原生 `thread/read`、真实日志静止点、原资格继承、来源与账本 CAS 均由原源码 API 校验。活动中的根日志变动已实际阻止只读准备，不以活动期诊断伪造空闲。

材料目录为 `continuation-2/adoption-2`，包括 `engine-repair-publication.json`、`current-task-adoption-launch.json`、`current-task-adoption-inspection.json`，实时状态为 [本任务接入状态](/Users/niuzhenya/Documents/adaptive-model-router-archives/20260915-host-upgrade-global-install/continuation-2/adoption-2/current-task-adoption-state.json)。原生心跳仍使用同一 ID `router`，已更新为 C2 并恢复，接入成功后继续实际 Hook/MCP 和独立委派验收。当前 `stageClosure=null`，`pendingOutcomes=1` 为保留历史统计，没有无证据清理。最终实际验收仍未完成，不能将本轮回归或引擎发布重标为完成。无需用户再次重开或批准。

## 本任务实际接入与安装后验收

上述协调器于 `2026-09-15T07:48:12.391Z` 成功提交本任务接入，收据 `981364d2a0e6628c4cb643e888c9a8e23490851fa1fffe51abd5122e2d851697`。准备阶段耗时 10,597 ms，提交入口总耗时 3,469 ms（包含事务外冷消息复检）；两个数值来自本轮实际记录。原 88 个阶段随本任务转到 C2，未切换全局默认。

下一轮实际原生 Hook 和正常 `get_route_status` 调用均执行 C2，随后 `diagnose_router` 确认 `epoch.ready/rootReady/childReady=true`、`migrationPending=false`、数据库 `ok`。第一次只读返回尚未完成的 read receipt 状态，完成后第二次诊断转为 ready；没有伪造入口或另建资格子代理。

根任务使用只读连接将原在线备份与当前数据逐行对比：**86 outcomes、64 delegation_attempts、62 delegation_children 全部相同，changed=0、missing=0**。接入收据保留全部 88 阶段、62 历史 child、89 个加密 origin；其中 61 个历史 child 使用原 token 例外，另 1 个已有实际新入口。2,604 项根任务解释器历史责任按原规则保留，未当作业务完成。核验材料为 `continuation-2/adoption-2/root-adoption-audit.json`。

稳定 B 壳字节及全局配置摘要再次逐项一致，全局默认仍 B。当前仅本任务使用 C2；不宣称其它历史任务已完成 epoch 接入，也不批量唤醒或改变它们。已完成的单任务协调器以退出码 0 结束并注销，私有日志保留。

安装后独立只读验收已成功通过真实 Router 票据启动 `gpt-6-astra / xhigh` 子代理，route `7692d35a-dcab-4c66-8b6e-55145910317d`，该 child 的实际 Hook 也选中 C2。独立审查未发现 C2 单任务接入的实质代码问题，另核对原 155 routes、其它 418 个任务绑定及 1,420 个阶段逐行一致。全部补充要求与最新结果通过根任务核验，唯一 `passed / full-checks` outcome seq **1489** 已记录；它证明本任务的实际修复和独立审查完成，不代表所有历史任务已升级。

### 自动推进的部署缺口

独立审查同时发现，默认 B 已采用宿主版本仅作诊断的契约，但 417 个旧账本绑定仍选择带版本检查的旧 reader；原 `watch` 只有显式 CLI 入口，没有全局常驻推进。不能将这些绑定当作 417 个正在使用的用户任务，也不能把本任务成功推广为全局旧任务兼容已完成。

根任务从当前真实 CLI 生成协议 schema，核验并实际调用带 `useStateDbOnly:true`、非归档、全部根来源、按更新时间降序的轻量列表。全量两页得到 69 条，匹配 65 个 Router 根（C2 1、B 2、旧 62）；没有未排除的旧根同时具备实际 B 入口。全部发现只读，没有定向读取其历史或执行迁入。当前活跃根在独立 app-server 上也显示 `notLoaded`，最新 turn 元数据显示 `interrupted`，两者都不能作为空闲依据。

补全方案已写入方案第 9.6 节，并通过独立只读核验（route `faaa796a-a2ae-4169-8e11-42b71fe63581`，唯一 `passed / full-checks` outcome seq **1490**）。新增内容只在仓库根调度脚本及其测试，从已发布 C2 调用原证明 API，不改变 C2、B Hook、信任或全局默认；以原生真实入口和来源变化触发，排除已归档及明确暂不处理任务，串行、有界、退避推进。原验收心跳已暂停，避免按先前单任务验收提示重复启动审查。

### 自动协调器实现与真实只读检查

已新增三个运行脚本与针对性测试，并接入 POSIX CI。调度器与真实 Python→Node 跨进程锁回归 **27/27 通过**，根任务复跑日志 `/tmp/router-global-epoch-coordinator-root-20260915.log`；另核验原 C2 的活动/unknown 拒绝、真实入口确认和失败提交回滚三项用例。冻结 C2 与 B 稳定壳摘要再次一致，插件源码指纹仍为 `d8b0e9a1…73a254d`。

复核补齐了几个实际边界：同证据的暂时 RPC 错误到退避期满可重试；新入口清除旧指数退避但保留 60 秒冷却；锁验证要求该继承 fd 自己持有锁；App 替换程序或自有客户端结束后退出 75，由 launchd 有界重启，普通请求超时仍沿用退避。B 的不可变发布包路径与原生稳定壳路径分别验证，不能因字节相同而混同角色。实际第一轮 `--inspect-once` 曾被这一双路径断言拒绝，保留原失败回执；修复后第二轮真实检查成功。

`2026-09-15T08:27:10.214Z` 的只读检查发现 69 条非归档原生记录，1 个已接入 C2、62 个旧根等待实际 B 入口；attempts、prepare、commit 均为 0。前后 420 个任务绑定、1,515 个阶段、默认行、1 份 epoch 收据与 89 个 origin 全部逐表摘要一致，全局配置摘要也一致。这证明原生发现与固定包验证能运行，不代表其它旧任务已迁入。材料位于私有 `continuation-2/global-coordinator-acceptance/inspect-once-2.json`。

实现阶段全部补充输入与最新结果经根任务验证，唯一 `passed / full-checks` outcome seq **1493**。其间一条清理命令被宿主在 CreateProcess 前拒绝；根任务按准确命令摘要和原生拒绝回执追加 `not_started` 核验，未伪造 Post、启动进程或业务成功。此前测试进程的真实句柄与该拒绝命令分开核验。该阶段之后继续完成下述独立部署审查与常驻服务安装。

## 自动协调器全局部署与最终验收

最终独立复核发现并修复两类恢复缺口：C2 历史资格/提交准备内部的临时 Hook inventory 读取失败也必须进入重试；进程退出遗留的 `verifying` 状态必须在冷却后重新取证，不能永久停留。四处 Hook 检查统一区分证据暂不可读与真实信任/身份/责任不满足；中断恢复不保存或复用 handover token。最终协调器回归 **31/31 通过**，日志 `/tmp/router-global-epoch-coordinator-final-20260915.log`；独立审查另行复跑 31/31，并核对部署后的准确脚本、真实原生启动与保存回执，无剩余实质问题。全部四份补充输入与最新结果通过根任务核验，唯一 `passed / full-checks` outcome seq **1494**。

服务于 `2026-09-15T08:46:11.937Z` 经 launchd 成功加载，名称 `com.niuzhenya.adaptive-model-router.epoch-coordinator`，定义为 `/Users/niuzhenya/Library/LaunchAgents/com.niuzhenya.adaptive-model-router.epoch-coordinator.plist`。运行文件位于 `/Users/niuzhenya/.codex/router-epoch-coordinator/releases/65a901657cba8ba6ef0ea66653e2f63ba261ed54d41dce9530733a6324cd09f8`；独立部署只增加协调脚本，不新增插件缓存版本，不改稳定 B 壳、七项 Hook 信任、C2 字节或全局默认。服务以私有配置和状态运行，使用原生轻量列表、有界分页、串行验证和实际入口证据推进；已归档、明确暂不处理、临时/非根任务与已废弃 Windows 项目均被排除。

现场恢复测试先核对服务及其自有原生 metadata 客户端的实际父子关系、uid、工作目录和映射可执行文件，再仅结束这一自有客户端。协调器实际以 **75 / EX_TEMPFAIL** 退出，launchd 自动启动新进程；随后状态继续推进，stderr 为 0。最终观察服务 `running`、PID `33714`、`runs=2`，重复实例探针返回 73，证明互斥仍生效。测试未结束 Codex Desktop、其它任务或业务子代理，也未要求用户重开 App。此证据验证自有连接故障恢复，不等同于实际 App 二进制升级实验。

截至 `2026-09-15T08:58:29.957Z`，服务发现 1 个已接入根和 62 个等待真实 B 入口的旧根，handover attempts/prepares/commits 均为 0；当时没有可自动接入的其它旧根。旧任务再次使用、产生已完成的准确 B 根入口并到达原生安全空闲边界后，服务才调用 C2 原资格、责任核验、来源和账本 CAS 完成接入；下一次真实 Hook 与普通 Router 读取确认新引擎。不能将 `notLoaded`、`interrupted` 或长时间未使用当作空闲证明，也不承诺回合中途切换。

最终数据核验保留原 **155 routes、86 outcomes、62 children** 不变。原 64 个 attempt 中 60 个仍在活动表且完全相同，另 4 个因本轮新阶段正常结束触发既有“最多 64 条终态历史”裁剪；逐一解密准确 immutable epoch origin，确认四份原 attempt 与安装前备份完全相同，原 outcome 和 child 也继续保留。部署基线的 1,516 个阶段不变，正常并行任务追加 2 个阶段；原默认行、epoch 收据、89 个 origin 及其它 418 个原任务的 generation/candidate 均不变。正常并行任务的 turn 元数据与新绑定允许推进，不宣称整个实时数据库字节相同。全局配置、B/C2 字节与冻结源码指纹再次匹配。

最终 Router 诊断为数据库 `ok`、`migrationPending=false`、`epoch.ready/rootReady/childReady=true`、`stageClosure=null`、`pendingStageWork=[]`，当前委派入口可用。`pendingOutcomes=2` 与全局预留 `limit=10/pending=2/released=3/verificationDeferred=0` 是保留统计，未无证据清理。根模型仍为 `gpt-6-astra`，思考档位由界面控制。所有本轮委派已核验并结算，自动服务保留运行，旧一次性安装/接入服务已注销，验收心跳 `router` 保持 `PAUSED`。

详细现场证据见[最终服务验收快照](/Users/niuzhenya/Documents/adaptive-model-router-archives/20260915-host-upgrade-global-install/continuation-2/global-coordinator-acceptance/service-final-acceptance.json)，机器可读总记录见[全局安装验收 JSON](host-upgrade-global-install-20260915.json)。核心回归 **575 通过、3 项 Windows 专用跳过**，批准原生材料回放 **25/25**、协调器回归 **31/31** 通过。未重新执行原生 Windows 登录态验收，未现场迁移其它旧任务，未运行远程 CI；这些边界不重标为已通过。本次授权的本机安装交付已完成，无需用户进一步操作，源码仍未提交、推送。
