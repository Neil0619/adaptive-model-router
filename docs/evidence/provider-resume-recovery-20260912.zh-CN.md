# 旧子代理恢复与 Desktop 版本识别验收

记录日期：2026-09-12。

**状态：本机修复、旧子代理收尾、源码独立审查、完整回归及最终部署验收全部完成。当前待结算为 0、无遗留阶段要求，委派入口可用，无需再次重开或用户操作。**

## 已确认的原因

1. 原交付子代理 `01a08f99-c460-79a3-8518-fd80be701956` 的原生 `session_meta.model_provider` 是 `codex_local_access`。2026-09-11 最后一轮因原生 429 错误结束，`last_agent_message=null`，没有最终报告。
2. 原生 `collaboration.followup_task` 返回精确错误 ``collab tool failed: Model provider `codex_local_access` not found``。当时配置及已检查的历史备份没有该定义。名称最初由哪个启动环节写入，证据不足，不能归因为用户删除配置。
3. Router 未识别上述提供者解析拒绝，错误地将已拒绝消息保留为 `message_result_pending`。这是已复现的插件缺陷。
4. 重开后，应用嵌入式 Codex 已是 `0.154.0-alpha.6.2`，PATH 上独立 CLI 仍为 `0.153.4`。Router 通过 PATH 错绑版本，导致成功执行的无业务子代理被严格审计拒绝。MCP 进程没有 `CODEX_VERSION` 或 `CODEX_CLI_PATH`；只读取环境变量不足以解决问题。

## 修复及证据边界

- 提供者拒绝解析限定逐调用宿主 `0.153.4`、已审查子元数据格式和 `followup_task`，核对原子代理、父任务、代理路径、创建深度、提供者名称、原始调用和结果。真实 Pre Hook 测量实际 Codex 祖先进程，将版本及执行文件摘要绑定到发送者、调用、轮次、工具和输入摘要。创建版本不再证明调用宿主版本；缺失、陈旧、输入改变、冲突及未知版本证据均保留 pending。拒绝只证明未送达，要求仍由发送者负责，不生成最终报告、Stop、成功 outcome 或直接释放名额。原先已核验历史回执必须与原始证据逐项一致才保留，不补造旧宿主测量。
- 通过原生 `config/value/write` 添加 `model_providers.codex_local_access`，严格复制已有 `custom` 的四字段：`name`、`requires_openai_auth`、`supports_websockets`、`wire_api`，未新增地址或凭证。私有备份在仓库外 `adaptive-model-router-archives/20260912-provider-recovery/config-before.toml`，目录 `0700`、文件 `0600`。配置差异仅为别名和 Router 管理的 marketplace 来源路径。原父进程未热刷新提供者是当时推断；重开后的真实恢复才是最终证据。
- macOS 原生资格核验沿实际父进程链查找 Codex，只读取 PID、父 PID、执行路径，限定深度并重复核对进程身份。无法证明进程链时拒绝核验；确认没有 Codex 祖先进程或其他平台时保留原查找。安装器等通用 CLI 命令选择不变。
- 审查实际 `0.154.0-alpha.6.2` 完整原生日志后添加精确适配。邻接版本不自动接受，Windows 的该新版仍未获准。完整记录、父子身份、单轮完成、精确标记及隐藏工具/操作审计继续生效。
- 版本错配失败只能走一次恢复：完整原生审计、四个原始 Hook、已完成无业务轮次、已审查实际版本、前后证据一致全部满足才可授权一个新自检。保留旧绑定、失败和唯一 outcome；新自检必须重新通过，不能把旧失败改写为成功。

## 原子代理实际收尾

用户重开后，父进程由 `26277` 变为 `21613`。原目标 `/root/router_19819610ffd26ba8b3d7b24348898bb1` 的仅收集 followup 成功，返回真实最终报告，原生轮次 `01a0959e-0b1a-77b0-bb2d-0ab9626d6ad1`。

- 原委派 `b99c0cf6-8163-4028-a257-03586c534c73`，维护意图 `superseded`，完成 revision `9`。
- 两次提供者拒绝保留为未送达回执；激活后的七条输入逐项核验。按原合同，激活消息不计入维护输入。原消息与要求未删除。
- 旧 watcher `56491` 已由主任务核实：原生日志第 451 行有 `CommandExecution` `exec-24c882f0-b9de-44d0-8f61-069392d7e641` 的 `failed / exit_code=-1` 终态，时间 `2026-09-11T09:09:17.275Z`；旧 CI run `34581861574` 也已结束。未把最终回复当作进程结束证据。
- `read_operations` 返回空，`verify_maintenance` 成功。唯一 outcome **1353，failed/tooling**，保留原异常执行事实；业务交付由主任务完成。
- 收尾后 `stageClosure=null`、`pendingOutcomes=0`、`pendingStageWork=[]`，委派入口可用。已结算子代理未复用于新业务。

## 应用升级后的实际资格验收

| 阶段 | 委派 | 唯一 outcome | 结果 |
| --- | --- | --- | --- |
| PATH 版本错配自检 | `1bf6d5d5-32fe-492a-a8c6-b4195594c77f` | 1355，failed/tooling | 实际完成但旧绑定版本错误，失败保留 |
| 一次恢复自检 | `6d321aa6-f579-4630-bd16-9ffe5958bca2` | 1356，passed | 新子代理、真实最终标记及完整原生审计通过 |
| 关闭临时诊断后的配置自检 | `b31dffba-8599-45e9-b59b-69409d573b24` | 1357，passed | 最终配置重新绑定通过 |
| 独立最终审查 | `55cfb1ab-de5d-4e0e-9358-2543cd615259` | 1358，passed / full-checks | 两项边界发现修复后，同阶段复核零实质发现；全部四条输入完成 |
| 最终安装原生自检 | `9101c95b-07c0-4b8d-8ec7-a644be634a7a` | 1359，passed | 最终源码安装后原生完整审计通过 |
| 最终入口绑定复核 | `37e76a0e-2d2e-4384-a297-2ba8a88a22bb` | 1360，passed | 热更新入口绑定完成 |
| 最终部署独立验收 | `f31c605d-5df6-4e75-bf91-6bf90dd51327` | 1361，passed / targeted-tests | 普通新子代理真实执行，零实质发现；安装、历史状态及完整测试记录均核实 |

失败自检的原始日志通过新适配器审计：`codex-0.154.0-alpha.6.2-no-work/1`，字节数 `105522`，审计摘要 `94fe0859f53e5058bd8382bdd522076ef8e4b42c4e84690e51e703d62fb527f4`。安装包脚本执行一次恢复授权，证据摘要 `dd93479d952413b0896ec6e483e6c3eb46c1756d32b54df31237572f6714613c`；临时诊断随后正常关闭。未重试旧票据、修改原生日志或伪造 Hook。

## 安装与验证

- 仓库管理的最终热修复已安装 **`0.4.0+codex.20260912132803`**，无需再次重开。
- 部署后宿主识别为 `darwin / arm64 / 0.154.0-alpha.6.2`；可执行文件摘要 `ecad78dbf98adb89ec475edac86630406cbe59d9f3070b17d88065f136b94bcb`。
- 最终安装的 82 个运行脚本及版本文件与仓库逐一比较，无差异。
- 提供者回执与阶段收尾定向测试 `76/76`；宿主识别与资格核验定向测试 `45/45`，均通过。
- 最终完整测试 **504 项，501 通过、3 项 Windows 专用跳过、0 失败**。
- `npm run validate`、插件结构验证和 `git diff --check` 通过；`npm run eval` **232 例零不匹配**。
- 未运行原生 Windows 登录验收，不据此宣称新版 Windows 支持。

完整测试日志 `/tmp/router-provider-host-recovery-full.log`；定向日志 `/tmp/router-desktop-version-targeted.log`；安装日志 `/tmp/router-provider-host-recovery-install.log`。临时日志不替代本验收记录。

独立审查发现旧创建元数据不能证明 resume 后回执执行版本；补充复核又发现，新式已核验回执不能在宿主证据后来冲突时借用历史兼容路径。两项均修复：新回执显式使用 `schema=2`，重核和只读阶段状态检查都要求原 `hostEvidenceDigest` 与当前逐调用证明一致。同版本二进制变化也会保留 pending，不能回落重新分类。原审查子代理同阶段最终复核零实质发现，独立 20 项筛选测试及 5 项冲突/丢失/同版本变化/缺失字段反证通过；父任务最终相关 21 项测试通过。

真实 followup `call_vlKZDPqBSaggwwiRT0NIdlAX` 的加密审计记录已核实宿主为 `0.154.0-alpha.6.2`，父任务初始元数据仍为 `0.153.4`。独立审查又将两条 followup 的测量与父原生日志第 21233、21259 行及消息账本逐项比较，发送者、调用、轮次、工具、输入摘要全部相符。测量在发送时写入，未从当前 MCP 或创建版本回填。独立审查还验证三份真实新版本无工具日志，并通过 24 项隐藏工作、未知动作、身份/版本错配、缺失完成证据等反证。

最终完整回归日志 `/tmp/router-provider-host-schema2-full.log`；定向日志 `/tmp/router-provider-host-schema2-targeted.log`；安装日志 `/tmp/router-provider-host-schema2-install.log`。

最终原生诊断：活动版本 `0.4.0+codex.20260912132803`，指针 `matched`、非临时状态、数据库健康；`stageClosure=null`、`pendingOutcomes=0`、`pendingStageWork=[]`、委派入口 `available`。全局名额为上限 10、占用 0、历史释放 3。主任务始终为 `gpt-6-astra`，思考档位由界面控制。机器可读快照见 [provider-resume-recovery-20260912.json](provider-resume-recovery-20260912.json)。

## Git 交付边界

原全局委派回收修改已通过 [PR #24](https://github.com/Neil0619/adaptive-model-router/pull/24) 合入主分支，提交 `19a5a1fe2bbaf68a4f91417bc9fb642c7184e067`，是本次追加修复开始时的基线。

本次追加的提供者恢复及 Desktop 版本识别补丁在 `codex/fix-provider-resume-reconciliation` 分支形成独立交付，沿用用户此前提交、合并、推送的授权。原 PR #24 不包含本补丁；本次合并结果以追加 PR 的 Git 提交和远端记录为准。
