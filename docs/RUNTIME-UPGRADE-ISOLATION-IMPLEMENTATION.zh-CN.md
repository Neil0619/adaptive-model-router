# Router 运行时隔离：实现、安装与验收边界

日期：2026-09-13；安装进度更新至 2026-09-14。本文对应 `codex/runtime-upgrade-isolation` 开发源码。首次安装和入口兼容补丁已按用户后续授权在冷窗口完成；不要在当前运行的 Codex 中重复下列冷安装步骤。

2026-09-14 更新：材料化 Hook 等价检查缺陷已修复并加载为 `0.4.0+codex.20260914084118.runtime2`。本机旧任务的新资格、普通独立委派、补充消息与结果结算已通过，最终本任务无待结结果、委派门禁可用；证据见[入口兼容补丁安装记录](evidence/runtime-v2-shell-repair-20260914.zh-CN.md)。原 stable Hook、默认代及原任务/阶段绑定保持；旧 v1 任务继续选择 v1。下述热发布边界、冷窗口要求与尚未完成的 Windows 登录态验收继续适用。

## 已实现的行为

稳定入口按原生可信任务身份选择完整运行时包；任务绑定与阶段绑定分别保存。显式发布 B 只改变后续新绑定的默认版本，A 的票据、子代理、消息、命令和结果责任继续交给 A。历史事件按所属阶段恢复其完整包，不改变该任务当前的新代绑定。候选目录不被运行时扫描；同目录更高版本、active.json 或调用者指定版本都不能隐式晋级。

已有 v2 任务在原生根回合结束后的下一边界检查迁移。检查覆盖全历史未结束的 session/cell、消息、子代理 revision、已核验结果、maintenance、原生 MCP receipt 和正在执行的运行时调用。N 回合启动的命令不会因 N+1 普通回复而消失；真正匹配的终态 poll 可以结清它。已核验消费的 accepted 消息也不会永远阻塞。

候选资格与 A 的原有效资格分开存放。资格来源、route/outcome 和剩余责任均须再次吻合，调用者自报 passed 不成立。候选失败只有在自身责任已经收尾且 A 的资格仍有效时才恢复 A；未知、缺 Stop 或活动调用保持阻断。没有基于年龄、租约到期或一次 task_complete 的自动放行。

原生 MCP Pre、受信环境/无受信环境两种调用分支消费同一 receipt；明确 method-not-found 的原生拒绝可结清，泛化错误和丢失结果不能结清。每个任务的已完成 invocation 和终态 receipt 保留有界；active/unknown 不因裁剪而消失。

普通、可信且未带 Router carrier 的原生子代理保持旁路，不建立 Router 票据、阶段、任务绑定或预留。Router 故障时，普通根任务命令保持可用，并产生 `runtime_coverage_gap` 诊断；Router carrier、相关目标与 Router 工具仍拒绝。旁路不补写命令回执，不构成迁移证明。

## 这一个兼容代能发布哪些代码

全部普通文件始终进入包 SHA-256 摘要；文件链接和非普通文件拒绝。路径以真实目录身份检查，候选、正式包、归档和恢复不能用 symlink 别名跨域。

入口映射的语义和全部实际入口文件也进入冻结契约，包括不在 lib 下的 probe；正常发布与首次冷桥都拒绝把 Hook、service 或 probe 重定向到另一个文件。JSON 字段顺序和发行版本标签不被误判为入口语义变化。

当前开放的真实代码边界是 `scorer.mjs` 中 `inferCategory` 的纯类别分支程序：固定初始化、最多 32 个受限 `includesAny`/字符串 `includes` 分支，以及已知类别的 return。测试 B 新增 `glossary → documentation` 分支，直接验证 A/B 对同一输入的实际分类差异，并验证 A 在途完成、新任务采用 B 和共享写入不变量。

这不等于所有日常运行时修复都可以热升级。其余 scorer 字节、`scripts/lib` 中所有共享 writer/reader、`scripts/hook.mjs` 的真实持久化行为、launcher/MCP/stdio/管理入口和原生 Hook/MCP 定义保持冻结。新增导入、任意表达式、顶层副作用、SQL/枚举/加密/生命周期变化均被拒绝。未来这些更新需要另行实现并审查真实兼容适配或精确摘要绑定的晋级验证；当前没有一个 `--compatible` 开关可以绕过它，也没有通用的新 writer 冷升级命令。

每次发布都由已登记壳自己的验证器，在新建的独立临时 home 对精确 A/B 摘要运行 20 个合成阶段：交错写入、两个进程并发写入、两版交替持有共 10 个全局预留、两版均拒绝第 11 个、对方完成既有票据、幂等与冲突检查、加密值/枚举、唯一 outcome、完整性与外键检查。纯边界验证加上这些检查才构成准入，版本号或 schema 相同不构成准入。

## 日常开发到发布：无需手工复制稳定壳

开发目录和候选目录必须在缓存、vault、正式发布树外。`source` 是正常源码 checkout 内的插件目录；`shell-root` 是首次登记后保持不变的稳定壳。修改允许的类别分支后，正常维护 `runtime.json` 和 `.codex-plugin/plugin.json` 中的版本名称。

```bash
node /absolute/stable-entry/plugin/scripts/runtime-admin.mjs prepare \
  --source=/absolute/development/plugins/adaptive-model-router \
  --shell-root=/absolute/stable-entry/plugin \
  --candidates=/absolute/offline-candidates
```

`prepare` 检查源码的原生入口模板仍匹配首次记录的摘要，再继承稳定壳中已经 materialize 的 `.mcp.json`、`hooks/hooks.json` 和 `runtime-host.json`。它不会静默覆盖源码中新的入口配置变更；这种变更直接拒绝。包的其他源码保持原样并重新计算全包摘要。返回 `candidate` 和 `digest`，不会写数据库或注册插件。

```bash
node /absolute/stable-entry/plugin/scripts/runtime-admin.mjs publish \
  --candidate=/absolute/offline-candidates/RETURNED_DIGEST \
  --home=/absolute/original-router-data
```

此命令执行兼容验证并更新默认代，不调用原生 plugin add、marketplace remove，也不改变模型策略。回退也是对保留 A 执行同一个 `publish`，不会撤销共享数据或替其他任务回滚。现有阶段和任务仍按安全边界处理。

## 首次已安装 v1 → v2：同一个数据库

首个冷桥只接纳本轮逐文件核对的精确已安装 v1：`0.4.0+codex.20260912132803`，143 个文件，全包摘要 `9d23b8ae47f6d9bd6b388a33b75c7f94741546116efa29d3e33d9ebc72a1c9b2`。它不是从 Git 推测出来的旧版。桥还要求 v2 的 `scripts/hook.mjs` 与该已安装 Hook 完全相同；核心 writer fixture 不被表述成 Hook 修改资格。

只向原数据库添加 runtime 表和受控兼容 trigger；原 routes/outcomes/attempts/children、盐、模型策略、全局开启、预留延期处分不清空、不伪造，也不复制到第二个账本。已有任务和保留的委派 route/attempt/child 并集登记为冷边界时实际执行的 legacy 代；历史创建版本仍未知。正常裁剪 terminal attempt 后的 child maintenance 与 no-child outcome 幂等读取仍选 A。

已未知或 operator_deferral 的 legacy 责任只约束原任务，不阻止其他真正的新任务采用 v2。切换后首次出现的任务，需要原生 session 元数据证明是冷切点之后创建的根任务才能选择新默认；此前未见过的休眠旧任务、身份不全的任务均保守留 legacy。此创建证据不结清任何业务责任。v1 不识别 v2 租约，因此 legacy 任务当前不会自动迁入 v2；其原包及历史入口保留，后续真实退役协议尚未实现。

`runtime-admin` 在任何可写数据库打开前检查 action、参数、候选和冷进程清单。已有 v1 的查询通过稳定双读校验的私有 SQLite 文件副本完成，因为 SQLite readOnly 也可能在源目录创建 WAL/SHM。未知 action、错误候选、活跃宿主拒绝和未注册库的 references 不初始化或迁移原库。完全空白且不触及 legacy 的独立 home 可以离线 bootstrap，不受无关 Codex 进程阻挡。

## 延后安装时的可执行顺序

安装前确认实际原数据目录和当前已安装 v1 路径；不使用默认 fallback、不使用本轮测试副本代替真实宿主路径。`router_state`、`router_v1`、`router_entry`、`router_retained`、`router_versions`、`router_node` 均为操作者确认的绝对路径；不要重设用户的 CODEX_HOME，也不要从旧副本运行其中指向原全局路径的配置命令。

先准备一个独立的新目录，稳定壳不能放在 native cache、vault 或 published 内。其父目录是专用 marketplace，不能已有 marketplace 文件：

```bash
"$router_node" plugins/adaptive-model-router/scripts/runtime-admin.mjs prepare-shell \
  --source="$router_source" --shell-root="$router_entry/plugin" --home="$router_state"
```

返回的 `registered:false` 表示尚未注册。稳定壳写明原数据 home，并把当前平台 Hook、MCP 的 Node、脚本和 cwd materialize 为绝对路径；版本带独立 `.runtime2` 后缀。Linux/Windows 的真实首次宿主验收仍须在目标平台执行，不能复用 macOS 壳。

后续步骤在延后安装获得授权时，于独立终端的明确冷窗口执行：关闭相关 Codex 宿主和 Router writer；保留未知任务和外部作业的责任记录，不以关闭进程伪造终态。CLI 自行检查原生进程清单，没有调用者可传的“已冷却”标志。

```bash
router_admin="$router_entry/plugin/scripts/runtime-admin.mjs"
"$router_node" "$router_admin" capture-host-entries \
  --anchor="$router_v1" --archive="$router_retained"
"$router_node" "$router_admin" bootstrap \
  --candidate="$router_entry/plugin" --shell-root="$router_entry/plugin" \
  --legacy-runtime="$router_v1" --home="$router_state"
```

`capture-host-entries` 保存 v1 所在版本父目录的全部文件和摘要，包括其他历史代与索引；它们仅作为原路径恢复材料，不被授予 v2 writer 资格。`router_versions` 必须取 capture 返回的 `source`。原生 marketplace remove 实测会删除旧 cache，所以注册期间必须在成功与失败路径都执行恢复，宿主在恢复核对完成前保持关闭。例如 POSIX shell 可在移除前安装退出 trap：

```bash
restore_router_paths() {
  "$router_node" "$router_admin" restore-host-entries \
    --archive="$router_retained" --versions-root="$router_versions"
}
trap restore_router_paths EXIT
codex plugin marketplace remove adaptive-model-router --json &&
codex plugin marketplace add "$router_entry" --json &&
codex plugin add adaptive-model-router@adaptive-model-router --json
restore_router_paths
trap - EXIT
codex plugin list --json
```

必须检查每条退出码。失败时先确认恢复结果，再使用安装前记录的 marketplace 原来源恢复注册；不要重跑 bootstrap、覆盖原数据库或开始任务。上述 trap 只恢复文件，不宣称原生配置自动回滚。恢复幂等且只补缺失文件，遇到历史字节冲突或路径重定向会拒绝；新 v2 cache 保留。Windows 需在 PowerShell `try/finally` 执行相同恢复命令。

已登记单个旧入口也可用 `restore-host-entry --digest=... --path=... --home=...` 从精确保留包恢复；首次注册应使用完整 capture/restore 流程以覆盖全部旧路径。重新打开后审核真实 Hook 信任，执行 macOS/Windows 原生生命周期与在途任务验收；这些不是离线测试可以替代的证据。普通 `manage-install install/upgrade/repair` 在本分支永久拒绝，不能用来执行此入口转换。

显式 `node scripts/manage-install.mjs uninstall` 支持从原源码、稳定壳及其原生缓存副本执行。准备时记录原源码身份；卸载核对专用 marketplace 的唯一插件、真实子目录、shellRoot 与调用入口的归属。异源同名 marketplace 或混有其他插件时拒绝移除。卸载前停止 Router 进程并保留仍需要的旧入口，原共享数据和无关配置保留；不得用卸载替代普通运行时发布。

## 命令边界、归档与崩溃

根操作检查支持有真实前瞻 Hook 覆盖的 Promise.all/allSettled 命令批次，含 for-of、索引 for、forEach 输出包装；变量名和空白不作为权限。要求最多 16 个字面量 exec_command，每个匹配原生 start/terminal，不能靠打印 JSON 证明。确切 awaited 的四个只读 Router 转发也可收敛。较早回合的 continuation/cell/session 仍逐个核对。

任意 JavaScript、计算属性调用、未支持的批次形状、opaque 外部作业、缺失原生回执保持未知。目前没有任意根操作人工“清零”入口。大日志原生核查在 SQLite 写事务之外，共享 250ms 预算；事务内仅复核绑定、责任和与内容摘要绑定的文件身份。超时保留 A。完整扫描上限、未覆盖历史与未知作业可能长期阻止该任务迁移，这是明确限制。

`references --digest=... --home=...` 查询真实引用；`archive` 拒绝默认、回退、任务、候选、活动/未知调用、宿主入口和未决阶段。单纯已结清历史阶段行不构成永久活动引用。归档仅移动完整包到确定性 archive 路径，历史事件可按全摘要恢复；rename 后 SQLite commit 前崩溃可从另一路径重获同一包。恢复目标只由实际打开的 store.path 决定，部分或冲突身份 env 不能把包移到 fallback。

已绑定但尚未迁移的休眠任务、legacy 任务和历史宿主入口仍可长期保留旧包。当前没有硬删除这些未知引用或按版本数量/年龄强行保留两代的操作。

2026-09-13 的[任务归档与版本退休复查](evidence/task-archive-runtime-retirement-20260913.zh-CN.md)进一步确认：原生任务归档/取消归档尚未联动 `runtime_tasks` 与宿主入口的退休/恢复。当时本机 v1 已按真实入口、资格和未结责任另行完成 29 对历史 cache/vault 的受控外移，各剩 10 个版本，尚未加载本分支。2026-09-14 的两次受控安装各新增一个原生壳缓存，目前 cache 12、vault 10；原归档保持。这是维护结果，不是 v2 已实现自动归档联动的证明。

## 验收与真实限制

2026-09-13 的源码基线：`npm test` 共 449 项，446 通过、0 失败、3 项原生 Windows 检查跳过；显式启用精确 v1 fixture 和实际 macOS Codex CLI 0.153.4 的隔离注册、历史入口恢复与卸载验收。`npm run validate` 通过；`npm run eval` 的 232 个离线策略用例全部一致（风险底线召回 1、控制误触发 0），不代表模型质量评测。`git diff --check` 通过。机器可读回执见 [runtime-isolation-validation-20260913.json](evidence/runtime-isolation-validation-20260913.json)。2026-09-14 补丁最终源码套件为 452 项、448 通过、0 失败、4 跳过；独立安装器 7 项全通过（含真实隔离 CLI 注册）。本机登录态资格与普通委派的后续结果以[入口补丁验收](evidence/runtime-v2-shell-repair-20260914.zh-CN.md)为准。

所有自动测试入口先创建隔离 home/CODEX_HOME/PLUGIN_DATA。直接执行 writer verifier 时，缺 env、数据目录不一致、默认 fallback、非直接临时根或 symlink 会在导入 writer/打开数据库前拒绝。

回归包含真实分类代码 B、A/B 同库交错与并发、全局 10、两长命 MCP、阶段与子代理绑定、消息结清、跨回合命令、未知租约、候选失败、归档崩溃、错误路径和身份 env、CLI 拒绝不改原库、源码到 materialize 候选、普通原生子代理旁路及根诊断命令保留。精确 v1 副本的未决、历史裁剪和 maintenance 回归使用合成数据库；主任务另在真实生产历史的私有 online backup 上核验 1,400 个保留阶段、策略、盐、结果与释放处分全部不变。该副本检查显式使用离线冷边界及新根身份 fixture，不作为实际登录态迁移证据。

真实 macOS Codex CLI 已在显式临时 CODEX_HOME 执行 v1 marketplace/plugin add、remove、v2 add、旧树完整恢复及 list，确认新登记是 `.runtime2` 且旧路径保持完整；随后通过真实卸载 wrapper 移除临时登记并确认共享数据保留。该检查不启动旧副本配置命令，不包含实际登录对话、Hook 信任或生产入口接管。原生 Windows/PowerShell 门禁尚未在本阶段执行。旧 v1 自动挑选 sibling 与热改桥接测试已归档，见插件的 `test/RUNTIME-TESTS.md`；它们不作为 v2 通过证据。

## 本轮隔离误写例外与处置

不能宣称本轮完全没有全局状态写入。一次缺少显式 env 的直接 verifier 执行，在 fallback `~/.codex/adaptive-model-router-v2/router.sqlite3` 写入同一个已精确识别的合成项目：20 outcome/attempt 等 8 表记录。此前三个 GC fixture 还因恢复目录错误把各自 B 包移动到该 fallback 的 published 下。实际已安装插件的数据目录、配置、marketplace、cache/vault 树未被这些操作修改；主任务独立核对了生产基线。

处置先做 SQLite online backup、全表/设置及文件清单封存。经独立复核和明确授权，只删除与完整备份逐行一致的该项目 8 表合成记录，再对全部其余 rows 摘要、原有 6 个 outcome、完整性与 FK 核对；三份完整 fixture 包经全文件归因后移到私有事故归档。原 schema、meta、sequence 和未知前态结构保留，不猜测删除，也没有整库覆盖。清理前后快照、精确清理与目录移出回执保留在主任务掌握的 `adaptive-model-router-archives/20260912-upgrade-isolation/fallback-test-incident`。

根因修复为 verifier 执行前隔离断言、测试/eval 全入口隔离，以及恢复路径绑定实际 store.path。对应直接缺 env、冲突/部分 env 的反例均纳入测试。该处置只恢复已证明的合成记录与文件范围，不声称未知旧结构已回到无法证明的事故前状态。

最终独立复核发现的入口重定向绕过、稳定 marketplace 卸载误判均已修复并独立复验，未留下已确认的实质问题。最终生产边界及归档复核见 [交付验收记录](evidence/runtime-upgrade-isolation-20260913.zh-CN.md)。
