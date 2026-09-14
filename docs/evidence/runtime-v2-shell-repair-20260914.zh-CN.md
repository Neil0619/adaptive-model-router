# v2 稳定入口兼容补丁安装

2026-09-14，用户明确授权“开始安装”。目标版本为 `0.4.0+codex.20260914084118.runtime2`，完整包摘要 `dc3797f7539e861e71bb4481604c5b309a82828e1a34c80179347ec177a6f7e1`。

## 当前状态

17:04:12（北京时间）完成本次原生注册，11 步全部退出码 0；自动重开返回 0。命令阶段从 17:03:59 开始，实际约 13 秒。16:52 起的等待发生在宿主退出之前，不是注册本身耗时。安装器回执为 `installed_awaiting_host_acceptance`；该回执只记录安装，后续登录态验收另行记录，不能用旧回执代替。

用户重开后，本旧任务通过两次真实无工具资格检查，均取得唯一 passed / structured-check outcome。随后 `gpt-6-astra / xhigh` 完成普通独立审查及同阶段补充要求，未发现实质实现缺陷；主任务核验最新结果后已结算唯一 passed / full-checks outcome 1448。本机安装与旧任务委派验收完成。主任务一直为 `gpt-6-astra`，思考档位由宿主界面控制。

本次已不需要再次退出或重开。首次原生注册会删除旧缓存，因此安装在实际冷窗口内完成，并在打开宿主前恢复历史文件。自动重开只是便利操作，不是安装成功的条件。

## 本次切换范围

旧稳定 Hook 目录 `/Users/niuzhenya/.codex/router-runtime-v2-host/adaptive-model-router`、Hook 命令和脚本字节保持不变。新的 MCP 入口位于 `/Users/niuzhenya/.codex/router-runtime-v2-mcp-repair-20260914/adaptive-model-router`，通过明确、已登记且全包核验的 `hookShellRoot` 依赖使用原 Hook。

仅改变 7 个文件：3 个入口/资格适配代码文件，插件版本、runtime 版本、MCP 路径和宿主元数据。没有替换已有完整运行时包，没有修改默认代、回退代、任务绑定、阶段绑定、原资格、消息、预留或 outcome。数据库只新增新传输入口的完整包和对应 host entry；全部旧表行及 schema 逐项核对不变。该步骤不是普通 runtime 发布，也不扩展现行冻结 writer 契约。

生命周期资格检查使用实际执行代的 API 和资格存储，保留原 Hook 及原生 inventory 的真实身份。旧模板命令只允许两个精确路径展开，修改 Node、脚本、参数、超时或未经审查的 matcher 仍拒绝；既有 `supportsResidencyHookMatcherUpgrade` 白名单仍有效。仅能请求新无工具资格验证，不会继承旧成功。候选迁移和原代有效性检查也使用同一适配，避免后续迁移入口再次走回旧检查。

## 验证与恢复

完整套件 452 项，448 通过、0 失败、4 跳过（三项 Windows 检查及该套件未启用的独立原生注册 fixture）。本次安装器另有 7 项测试全部通过，其中使用真实固定 Codex CLI 0.153.4 在隔离 home 执行注册、缓存删除及恢复；不是模拟 CLI 的通过。其余覆盖活跃宿主零写入、原行保护、未知责任保留、内容变化拒绝、注册失败恢复、冷窗口丢失及禁止重放。

源码 validate、插件 validator 通过，232 例策略评估零偏差。候选的真实 Node launcher/MCP 初始化与 tools/list 通过，22 个工具可见；这项检查没有调用 Router 业务工具，也没有执行 Hook，不能代替登录态资格。

执行器复用已验证的僵尸识别和有限重新观察逻辑。进入真实冷窗口后先取得原生命周期锁，重新完整备份数据库、配置和全部历史缓存；只在保护验证通过后登记新入口，再执行原生注册及历史缓存恢复。失败时恢复原 marketplace/plugin 并再次核验所有旧字节；已完成的附加入口登记保留，不整体回滚数据库、不重跑 bootstrap。未知进程或冷窗口丢失时保守停止；不终止业务宿主或无关进程。

重开后的本机核验：数据库完整性正常，外键问题为 0；冷备份中的 408 个任务、1466 个阶段全部保持原 generation，默认代不变。本旧任务仍选精确保留的 v1 `9d23b8ae…`；这符合隔离策略，不是新版入口没有加载。新增任务和阶段来自重开后的正常活动，不能要求整个实时数据库仍与冷备份逐字相等。

1396 个历史缓存文件与本次冷归档逐项比对，缺失和内容差异均为 0。目前缓存 12 个版本，包含原 11 个版本和这次新增的 MCP 壳；原稳定 Hook 的完整定义摘要仍为 `34c89481e5a64ed8a72fe95e9b21c8190bdbfbbfee8b8cf0b26336f1e86471c4`。

资格记录 `f1d8b901-35a9-49df-96b3-386a39cce1bc` / outcome 1446 与 `3ecfd796-e89f-43cf-b6c4-12ac7214576a` / outcome 1447 均为实际原生往返。两次的配置、直接入口和运行时代码摘要一致；第一次沿用的第三个历史观察根在新证明后不再需要，绑定集合从 3 收敛到 2，因此触发一次刷新。随后进入普通委派，没有资格重试循环，也没有复制旧成功或伪造 Hook。

普通审查 `49dbc574-4c4a-45df-9d7c-d5c7833cc1d1` 的最终 closure revision=1，覆盖原始及补充两个真实输入；主任务用该最新 closure token 结算 outcome 1448。最终原生诊断确认 `stageClosure=null`、`pendingStageWork=[]`、`pendingOutcomes=0`、`delegationGate=available`，数据库健康。全局预留为 1/10，剩余预留属于其他任务，本任务没有占用或遗留待收尾工作。

独立审查以另一实现重算新壳全部 163 文件，稳定目录、原生缓存和 published 副本均匹配完整包摘要；旧稳定包仍为 `22a9d720…`。还逐项核对 1235 个 vault 文件、原指针、索引、全局 Hook 及 9 个冻结安装文件，字节和权限保持。冷前与登记后的 39 表快照中，只有 generations、host entries 各新增一行，其余 37 表和 schema 全部一致。该独立检查补充了源码 fixture；最新数据库判断使用主任务的安全文件副本摘要，审查者没有独立重放原生 rollout 审计，原生资格由正常 Router 验证器完成。

本轮未执行原生 Windows 登录态验收。保留 v1 任务仍使用 v1，当前修补也不代表任意 writer、Hook 或 MCP 变更可以无条件热升级；其受控边界见[运行时隔离说明](../RUNTIME-UPGRADE-ISOLATION-IMPLEMENTATION.zh-CN.md)。

## 后续核验入口

私有安装材料：`/Users/niuzhenya/Documents/adaptive-model-router-archives/20260914-runtime-v2-shell-repair`。worker 使用 `registration-resume.mjs --config=.../repair-config.json`，launchd label 为 `local.router-v2-shell-repair.20260914`，RunAtLoad=true、KeepAlive=false、LaunchOnlyOnce=true。不要重复提交此 job。

已核对本次 `registration-state.json` 和 `registration-events.jsonl`，确认实际版本、全部命令退出码、缓存恢复及旧行保护。`host-acceptance-local-check.json` 保留当前本机安全副本核查摘要；不对生产数据库建立额外 SQLite 连接。`host-acceptance-final-status.json` 为最终原生 MCP 诊断结果。完整状态见[机器可读记录](runtime-v2-shell-repair-20260914.json)。该验收快照记录于提交之前；后续提交、合并和推送以 Git 历史及 PR 为准。
