# 本机 Router v2 首次安装记录

2026-09-14，用户已授权安装 `codex/runtime-upgrade-isolation` 的新版。本文记录首次切换的执行情况；安装与登录态验收分开记录。

## 当前状态

17:04 后续更新：兼容补丁 `0.4.0+codex.20260914084118.runtime2` 已安装，原稳定 Hook 和全部历史缓存保留。重开后本旧任务的新资格、普通独立审查、补充消息处理及结果结算全部通过；最终待结结果为 0，委派门禁可用。本次回执与收尾见[稳定入口兼容补丁安装记录](runtime-v2-shell-repair-20260914.zh-CN.md)。下述失败是首次安装阶段的历史结论，不代表补丁安装后的状态。

## 首次安装阶段记录（16:07—16:28）

最新核验（2026-09-14）：**原生注册已完成，但旧任务委派验收失败，不能宣布功能恢复。** retry2 在 16:07:13 开始执行原生命令，16:07:27.914 完成，11 步全部退出码 0，实际切换约 15 秒，自动打开宿主也返回 0。此前等待来自冷窗口等待及已记录的执行器问题，不是安装本身耗时很长；自动重开只是便利功能。

注册后的版本为 `0.4.0+codex.20260912132803.runtime2`。重开后的真实 MCP 诊断确认 shellProtocolVersion=2、taskIsolation=true、数据库完整性正常；本旧会话仍绑定精确保留的 v1，符合隔离策略。旧缓存的 1234 个原文件已完整恢复，注册前后业务和 runtime 表严格比较不变（仅在注册前按已核验规则追加 2 个此前观察到的 v1 任务绑定）。现在有 11 个缓存版本（旧 10 + 新 1）和 10 个 vault 版本，原已归档 29 对不变。

**剩余缺陷已实测定位**：旧运行时的历史 Hook 等价检查比较原 `$PLUGIN_ROOT` 命令与新稳定入口的绝对路径命令，抛出 `previously observed Hook shell is no longer equivalent`，外部表现为 `HOST_LIFECYCLE_ROUND_TRIP_UNPROVEN`。本会话有真实旧资格通过记录，但不能进入新资格验证，更不能普通委派。实际应用宿主是受支持的 `0.154.0-alpha.6.2`；终端 PATH 中的 `0.154.0` 不是本次拒绝原因。

源码已补充运行时对应的资格适配：稳定壳负责检查真实 inventory，保留代负责其原资格键、源码摘要与结果核验；只承认已登记完整壳的两个精确路径展开。真实历史库的私有副本回放中，旧代码拒绝，修补后返回新的 `qualificationBinding` 和 `passedRefresh`，仍为 ready=false，等待真实无工具往返，不借用旧成功。该回放没有创建真实子代理或修改生产资格。

**修补尚未全局加载。** 本次改动涉及 `mcp-server.mjs` 及生命周期适配，超出现行已冻结稳定入口的热发布契约；不能改现有缓存、伪造新摘要或绕过兼容门禁。受控入口修复安装和真实委派验收仍未完成；本轮不再运行原安装程序、重跑 bootstrap 或自动关闭应用。当前没有等待用户退出的安装 worker。详细回归结果见机器可读快照。

本轮源码验证：针对性 49/49 通过；完整套件 452 项，448 通过、0 失败、4 跳过（三项 Windows 检查及本轮未启用的原生 CLI 注册 fixture）。完整套件使用精确旧版的隔离副本运行 legacy 兼容检查；validate 通过，eval 232 例零偏差，diff 空白检查通过。新增反例覆盖命令参数、Node 路径、脚本路径、超时、matcher、错误稳定入口、已释放入口、未发布或被篡改运行时，以及缺少真实信任时拒绝。当前修补验证针对 macOS 材料化路径，不构成 Windows `node -e` 入口兼容证明。生产委派和新增独立子代理复核仍被现行资格门禁阻断，不能用这些离线通过结果替代。

当前会话的真实宿主是 `/Applications/ChatGPT.app` 内嵌的 Codex，后台执行器必须等该应用和其他实际 Codex 宿主完全退出。不能仅关闭窗口，也不能在仍有业务任务执行时强制终止应用。执行器不会终止业务宿主或无关进程；宿主全部退出后，仅能向经过再次核验的目标 Router 孤立 launcher/MCP 发送 SIGTERM。

## 精确安装身份

| 项目 | 已核对的值 |
| --- | --- |
| 开发分支 / 基准提交 | `codex/runtime-upgrade-isolation` / `2ffccd911cd49c0a311584176aff488a56be1558`，开发修改尚未提交 |
| 源码插件摘要 | `d1099839b136945f837aa7b55d6c0bc7170c167d62b956587bda5952509aba59` |
| 实际保留 v1 摘要 | `9d23b8ae47f6d9bd6b388a33b75c7f94741546116efa29d3e33d9ebc72a1c9b2` |
| 准备好的稳定壳版本 | `0.4.0+codex.20260912132803.runtime2` |
| 稳定壳完整摘要 | `22a9d720b0aabc5be18d12478f3b0e50c97c411ca1dfd32ca64934dbdb19ae31` |
| 稳定入口 | `/Users/niuzhenya/.codex/router-runtime-v2-host/adaptive-model-router` |
| 原共享数据目录 | `/Users/niuzhenya/.codex/plugins/data/adaptive-model-router-adaptive-model-router` |
| 实际原 marketplace | 原数据目录内的 `materialized-marketplace/generation-356bc82331f49946431a3c84` |
| 安装 CLI | 独立 Codex CLI `0.153.4` 的真实可执行路径，未使用运行中的应用后端 |

## 已完成的独立核查

- 首次切换前，插件源码、准备好的稳定壳及专用 marketplace 验证通过。精确 v1 与该稳定壳在独立临时数据目录执行 `alternating-concurrent-stages/2` 兼容验证通过；这一步预检没有执行生产 bootstrap。
- 主任务直接检查真实 `ps`、`lsof`、原生 marketplace/plugin/MCP 返回结构。修正 macOS 负 UID、MCP cwd 末尾 `/.`、DockTile 系统进程误判和真实相对 launcher 命令的处理。
- 在独立临时 home 中，使用真实 Codex CLI 执行六步原生注册/移除，确认 Hook trust 与无关配置语义保持不变，生产 config 摘要未变。测试没有执行 Hook，也不提供登录态资格证明。
- 实际 `launchctl submit` 存活检查通过：测试进程由 PID 1 承载，原调用结束后仍完成工作，退出码为 0；测试 job 已移除。
- 执行器测试使用独立文件、数据库与命令适配器，覆盖成功、部分提交、注册失败、恢复失败、历史字节冲突、重复运行、冷窗口丢失、原业务记录保护及真实进程识别反例。主任务对冻结版本复跑 23 项，全部通过，无跳过；最终结果见私有安装目录的 `root-runner-tests.log`。执行器 SHA-256 为 `c944969e02d185bd5905b59fb78c1f5b02232f73badfad7aeb623242ecccb620`。

## 首次执行失败与修正

14:08:23 bootstrap 成功提交后，原执行器报 `Original business rows/salt/policies/releases/outcomes changed`，尚未执行 marketplace remove/add 或 plugin add。根因是精确迁移本来会向 `meta` 新增 `runtime_legacy_bootstrap`，原校验却拒绝任何整表变化。此前 23 项测试中的模拟 bootstrap 没有写入这条真实标记，漏掉了这一契约。主任务已在隔离冷备份上执行真实 `publishRuntime` 重现错误：只有 meta 从 142 行变为 143 行。新增校验只接纳身份、兼容套件和真实冷时间区间均匹配的单一标记，任何已有元数据、盐或业务行变化仍拒绝。

独立逐行复核确认：首次冷备份与失败后快照的 30 张旧表中，29 表完全一致。meta 除新增标记外，重开后另有两项正常 Hook 变化：root transcript 再次加密后的解密路径完全相同，capacity native turn 对应 14:14 的真实新回合。这两项不进入 bootstrap 白名单。盐、1435 条 outcome、6 个释放元数据键、策略和评分设置均保持；原有未知、未结与 maintenance 责任也保留。两份数据库完整性正常、外键问题为 0。

新增 runtime 结构恰为 9 表、3 个触发器，SQL 与精确候选一致；两代完整包与数据库记录相符。首次快照 403 个任务、1456 个阶段均绑定 legacy；本次独立审查阶段进入后为 1457 个阶段，新增部分与该审查对应，没有漏绑或 v2 执行迹象。原 cache/archive 各 1234 文件、vault 1235 文件，内容完整；config、active、vault index、全局 hooks 的内容及权限一致，原生注册未改变。

首次恢复步骤另出现 `Cold window lost`（code 75）。旧日志没有保留当时进程清单，无法确认具体进程原因，不将其归因于元数据校验。新程序已在冷窗口丢失时记录 PID、启动时间、cwd 和 argv 摘要。

`launchctl submit` 设置了等同 KeepAlive 的旧 OnDemand=false，失败后又尝试启动程序 43 次；持久一次性守卫全部拒绝，因此 bootstrap 实际只执行了一次。原 job 已移除。新配置改为 archive 内的 plist，使用 `RunAtLoad=true`、`KeepAlive=false`、`LaunchOnlyOnce=true`；故障探针在超过 145 秒后仍仅运行一次，随后服务自动移除。

续注册程序额外核对原失败回执、冷备份、固定包身份、完整存储记录、精确 schema、MCP 二进制/参数/环境及所有历史入口。在真实冷窗口重新完整 capture，保留初次安装后新增的旧入口。若出现已被 v1 观察但尚未绑定的任务，只能在旧注册仍被证明且无 v2 活动时，新增精确的 legacy runtime 投影；原绑定、业务数据、meta、cutoverTime 均不改。注册前后对包括全部 runtime 表在内的全库严格比较。

新增 12 项回归全部通过，包括真实 bootstrap 的旧校验失败/新校验通过、盐篡改拒绝、注册期间 runtime 行变化拒绝、独立的触发器及额外表反例、晚入 v1 的精确补齐和错误 MCP 入口。独立复核确认冻结清单 6/6 文件摘要吻合，语法与 plist 检查通过。生产登录态验收仍须实际注册成功后进行。

## 切换顺序与恢复边界

一次性执行器由 macOS 独立运行，先等待所有相关宿主退出，再获取现有安装锁，重新备份真实共享数据库、配置、指针、vault 索引与全部十代历史缓存。初步备份不会替代这份冷窗口备份。

首次执行已经向同一个数据库添加了 v2 运行时结构。续装程序再次核对原生注册、迁移证据及精确包身份，保留这次迁移；只在有确切漏绑证据时补齐 legacy 投影，然后完成原生注册。逐表验证全部既有业务行、策略、盐、结果、释放记录与完整 schema 不变。原生注册成功和失败两条路径都恢复并校验全部历史缓存；不以升级为由回收旧任务的责任或入口。

原生注册失败时，按安装前真实 materialized marketplace 恢复注册，再次恢复旧缓存。已经提交的附加 v2 结构保留，不整库回滚、不删除业务表、不盲目重跑 bootstrap。只有完整验证成功，或旧注册及历史入口已验证恢复，才自动打开实际宿主。无法证明的失败保持关闭并留下日志，等待本任务审查。

配置检查只允许目标 Router 的 marketplace/plugin 注册项变化。Hook 信任与其他设置必须语义一致；全局 `hooks.json`、旧指针和 vault 内容保持不变。新入口若触发原生 Hook 信任提示，仍由用户完成一次正式批准，不写入或绕过信任状态。

## 归档与后续验收

### 手动重开后的等待检查修正

15:01 再次检查时，原续装 worker 71150 仍是 `waiting_for_hosts`、steps 为 0、registrationStarted 为 false，未发生第二次注册失败。14:58:26 的日志表明应用退出时，`huayi` 目录下的终端 Codex（PID 77011）仍活跃并持有 Router 子进程，因此当时没有满足冷窗口。

同时确认等待检查存在独立缺陷：Cockpit Tools 的已结束子进程 77616（系统状态 Z）没有打开资源，旧检查却把所有同用户、对 lsof 不可见的进程都当成阻碍。主任务直接用该真实进程重现永久等待断言失败。新适配层在原有完整 inventory 前后各读取一次系统 stat，只排除 PID、PPID、UID、启动时间、命令身份一致，且两次均为 Z、没有 cwd 或打开文件、visibility 为 false 的条目。任何缺失、变化、活跃状态或矛盾资源证据继续保留；不结束真实终端业务或 Cockpit Tools。

重试候选位于 `/Users/niuzhenya/Documents/adaptive-model-router-archives/20260914-runtime-v2-recovery-retry1`。19 项回归全部通过，包括原有 12 项及进程身份反例、僵尸与真实 Codex 同时存在时不得获取安装锁/写入/终止进程、只有已证实僵尸时完整注册仍保留原数据。15:08 的实机只读验证确认旧路径将 77616 判为 blocker，新路径已排除它，而 77011 仍为 host。原始执行器、首次失败回执和已提交 bootstrap 保持不变。

独立 xhigh 复核确认八个冻结文件摘要、只读实机 inventory 和测试结果，唯一 passed/full-checks outcome 为 seq 1440。复核期间，77011 已从原始系统进程清单消失，后续不再要求退出这个已结束的终端进程。

15:13:11，在实际 ChatGPT 主进程仍存活时，再次核对旧 worker 的 PID/PPID/启动时间/参数、steps 为 0、无冷备份且状态摘要未变，只卸载了 `local.router-v2-recovery.20260914`。已验证旧 job 和 worker 均不存在，配置与 cache/vault/稳定壳/原 marketplace 未变。原 state 保留 `waiting_for_hosts` 的历史内容；退役证据单独写入新目录的 `retired-waiting-worker.json`，不篡改原回执。

15:13:58 已验证新 job `local.router-v2-recovery-retry1.20260914`（worker PID 97256，PPID 1）正在等待，runs 为 1、LaunchOnlyOnce 生效、命令步骤为 0、registrationStarted 为 false。实际等待 inventory 不再包含僵尸 77616，原终端 77011 也已消失。当前配置、十代历史 cache/vault、稳定壳和原 marketplace 全部保持。新目录的 `waiting-confirmation.json` 为本次等待回执，实际安装仍须读取其后续持久状态确认。

### retry1 的实际失败与直接安装核验

用户随后退出应用后，15:33:46 清单已为空，15:33:47 获取安装锁并完成冷备份。三个原生 list 命令均成功；15:33:51 的检查记录 hosts/orphans 均为空，但一个当秒出现的 PID 5912（父进程 Cockpit Tools 70880）没有可见 cwd/文件证据，被当作 blocker，程序立即以 code 75 退出。该进程在事后系统清单已不存在。原回执为 `failed_preserved`、registrationStarted=false、三个步骤均为只读 list，没有 capture、marketplace remove/add 或 plugin add。自动重开路径未被执行，所以用户继续等待也不会有结果。不能把暂时无法观察到进程资源表述成已确认的 Router 写入。

直接安装的两份独立实验都固定使用执行器的真实 CLI 0.153.4，在隔离 CODEX_HOME 和合成插件中进行：同名 marketplace add 更换本地来源被拒绝；本地来源不支持 Git upgrade；原生 config/batchWrite 的 CAS 可以切换来源且保留旧缓存，但随后 plugin add 安装新版仍会删除整个旧版本缓存。根任务的文件监视与持续检查观察到旧文件缺失；独立复核另用 kqueue NOTE_DELETE 和持续 stat 验证。因此这次原生注册不能在仍运行旧任务时安全执行；这一限制来自已验证的缓存删除行为，并非要求用户必须依赖自动重开。

retry2 在不执行任何安装操作的情况下，对清单异常或仅因不可见而未能归属的条目进行有界重新观察；真实宿主、Router 命令/cwd/文件占用立即拒绝。持续不确定、重试期间出现宿主、预算耗尽后才得到空清单均不能放行。重新观察预算为 3 秒，加上已经在执行的有界系统清单调用；不声称总墙钟时间硬限 3 秒。精确僵尸识别、原存储保护、冷备份、历史缓存恢复及原 bootstrap 保持不变。

新增外部 Terminal 进度窗口只读取状态，不启动第二个安装。执行器在 finally 解锁后才写入 finishedAt；窗口据此区分恢复中与已结束，身份不明时也不把旧状态当作重开许可。完成后可手动打开应用，自动重开只是便利功能。27 项回归全部通过，包含真实失败位置 old-mcp 后的临时进程、超时冷结果、恢复竞态和身份不明反例；独立复核 outcome 为 seq 1443，13 个冻结文件摘要均吻合。

16:01 只读预检确认原数据库完整性正常、外键问题为 0、迁移及包身份正确；另外发现 2 个已观察到的 v1 任务需要在冷窗口补齐 legacy 投影，阶段漏绑为 0，由既有精确追加流程处理，没有提前改动生产投影。旧 retry1 job 和 worker 已退出，原失败回执和冷备份完整保留。

该次执行材料为 `/Users/niuzhenya/Documents/adaptive-model-router-archives/20260914-runtime-v2-recovery-retry2`。16:04:19 实测 job `local.router-v2-recovery-retry2.20260914`、worker 37476 由 PID 1 承载，runs=1，waiting_for_hosts、steps=0；进度进程 38456 的父链实际终止于系统 Terminal.app。配置、全局 hooks、旧指针、vault 索引、全部历史缓存、稳定壳及原 marketplace 启动前后相同。当前等待回执为该目录的 `waiting-confirmation.json`。

此前已完成的 29 对历史 cache/vault 归档保持在原归档目录。本次首次注册保留当前十代历史入口，原生注册另产生新版缓存；这不代表历史归档被恢复，也不代表旧任务已自动迁移。原有 legacy 任务继续使用其保留运行时；创建于冷切换之后且身份可验证的新根任务才能采用新默认。

安装后的 macOS 登录态检查已执行，结果为部分通过：入口和数据保留通过，旧任务委派因上述兼容缺陷未通过。原生 Windows 登录态验收未执行。

首次执行器、安装配置、备份、命令日志和持久状态保存在 `/Users/niuzhenya/Documents/adaptive-model-router-archives/20260914-runtime-v2-install`。该目录不进入 Git，现作为原始证据保留；已有一次性执行声明，不得重复运行。

首次 macOS job `local.router-v2-install.20260914` 已移除，原目录中的 `cold-install-state.json` 和事件日志是失败证据，不能重跑。

续装材料位于 `/Users/niuzhenya/Documents/adaptive-model-router-archives/20260914-runtime-v2-recovery`；程序为 `registration-resume.mjs`，配置为 `recovery-config.json`，job 定义为 `registration-job.plist`，名称为 `local.router-v2-recovery.20260914`。

历史核验：2026-09-14 14:47:53（Asia/Shanghai）实测该 job 已运行一次，由 PID 1 承载，worker PID 为 71150，状态 `waiting_for_hosts`，注册尚未开始，命令步骤为 0。启动前后 config、全局 hooks、旧指针、vault 索引、十代 cache/vault、稳定壳、原 marketplace 及六个已复核文件全部一致；没有创建冷备份或执行安装写入。证据为私有目录的 `waiting-before.json` 与 `waiting-confirmation.json`。该版独立复核 outcome 为 seq 1437；此 worker 已被上述修正版替换，不能重提旧 job。

以上等待及退出步骤均为已完成的历史执行记录，不再要求用户照做。retry2 已成功结束，其原始回执保持不变；此处的安装后验收结果单独记录。后续需要完成修补的受控入口安装方案和真实旧任务委派验收，当前不应再次重开或重提任何旧 job。机器可读状态见 [runtime-v2-install-20260914.json](runtime-v2-install-20260914.json)。
