# 2026-09-11 全局委派预留恢复与本机验收

## 已安装版本与范围

- 验收时分支：`codex/fix-global-delegation-reclamation`；以下状态为提交、合并与推送前的验收快照。
- 本机活动版本：`0.4.0+codex.20260911075751`。
- 全局预留上限：10；原生每个根任务的驻留上限未修改。
- 正常阶段继续由既有 Stop / 原生终态 / outcome / maintenance 流程及时收尾；实际满额准入才触发全局验证回收，只释放缺额。
- 回收不等于业务通过，原任务收尾责任与加密材料保留；恢复执行重新取得容量。

## 用户指定的历史处置

| 记录 | 处置 | 保留证据 |
| --- | --- | --- |
| `b095dd37-3887-4067-8d37-a3beb34ef740`（9 月 3 日） | operator_deferral，释放全局计费预留 | 原始 attempt/outcome、可解密的阶段要求、缺失原生关联与终态的事实 |
| `22c7adc3-dd79-4d09-b345-136dfb49645a`（9 月 3 日） | operator_deferral，释放全局计费预留 | 原始 attempt/outcome、可解密的阶段要求、缺失原生关联与终态的事实 |
| `6bef2d8d-aae7-4a14-9511-d9699bfecda0`（提供通用问题解决方案） | 原生完成证据验证后的 verified_deferral | 原始要求、全部输入、两轮最终成果与原任务 gate |

9 月 3 日两条记录的父任务身份未取得充分证据，不猜测归属。它们只在用户明确点名后解除全局计费预留，未伪造 Stop、no_child 或 passed。

释放前的在线 SQLite 完整备份位于：
`/Users/niuzhenya/Documents/adaptive-model-router-archives/20260911-global-reservation-recovery/router-before.sqlite3`。
目录权限 0700、文件权限 0600，未纳入版本库。三条记录的原始 attempt 和 outcome 已逐字段核对相同；释放及材料补齐写入加密元记录，并保留旧版本。

另一个原有未结记录 `1e09a224-4346-49e2-ba5a-6e5aaa620c04` 未执行人工释放或修改业务状态。运行期间它的 updated_at 由原生流程刷新，原始 outcome 与其余 attempt 字段未变。

## 根因与实现证据

1. 原全局 4 条上限与磁盘错误共用存储提示；现区分 `ROUTER_GLOBAL_PENDING_LIMIT` 与实际字节/磁盘不足。
2. 原生最终消息的透传轮次 ID 与真实宿主轮次 ID 可以不同。新解析器验证同 child、唯一消息 ID、完整正文、final 阶段及对应完成事件；拒绝错 child、冲突正文和新输入。
3. 归档移动日志时按确定目录重新定位、复核身份；内容相同的文件元数据变化不重新计费。
4. 中断请求不会作为重新执行；已延期或已结算历史维护都需先取得名额。终态 attempt 被历史策略裁剪后仍保留维护能力，unknown 的已持有名额不会被漏计。
5. 查询与纯维护不刷新业务活动时间，重复维护以首次意图记录为界。保存所有阶段最终成果，维护接口同时返回原始延期材料。
6. 验收复现连续热升级的入口关联缺失：子代理使用前一版已配置入口，却被资格校验排除。新增 parent/configured 角色保留，并继续验证可信定义和真实原生资格；未扩大信任到全部历史缓存。

## 自动与真实验收

- 完整测试：479 项，476 通过，3 个 Windows 专属检查跳过，0 失败。
- 插件验证与 `npm run validate` 通过；232 个离线路由规则用例全部一致。这是规则一致性验证，不是模型质量评估。
- 新增回归包含：跨项目满额、终态优先与最旧真实活动、精确缺额、五进程真实准入只放行一个、状态查询只读、inspect/save 竞态、旧历史维护、重复维护、归档往返、来源缺失后材料读取以及显式处置幂等。
- 独立 gpt-6-astra / xhigh 代码审查及同阶段补查已完成，最终未发现剩余实质问题；`full-checks` outcome 已结算。
- 本机安装使用现有受管理热修复流程，MCP / Hook / stdio 桥探针通过，活动版本指针 matched，无需手工修改缓存或重建用户任务。
- 安装验收曾遇到一个真实 Hook 入口不匹配。该次无工具自检记录为 failed/tooling；源码审计证明未执行工具后，使用既有一次性恢复命令取得新票据。后续恢复自检和入口绑定确认均通过并结算，普通委派已成功启动。
- 最终独立安装验收：gpt-6-astra / high 已核验部署文件一致、三条释放数据与备份相同、第三条全部输入及两轮 final 内容一致；部署解析器返回 finished=true，未决调用/操作为 0。无剩余实质问题，`full-checks` outcome 已唯一结算（seq 1345）。
- 结算后实时诊断：数据库 healthy，版本指针 matched；全局占用 1/10、已释放 3、延后核验 0；本任务 stageClosure=null、待结算 outcome=0、gate=available。一次性恢复诊断已关闭。

此次未运行原生 Windows 登录验收；Windows 相关逻辑仅有本机跨平台模拟测试覆盖。

完整最终测试日志：`/tmp/router-global-reclamation-final-full3.log`。
最终安装日志：`/tmp/router-global-reclamation-final-install2.log`。

## PR 交付期跨平台复核

PR #24 首轮必需 CI 有 8/9 项通过；Windows / Node 24.15.0 的 `append permission cannot hide modified prefixes, truncation or path replacement` 报告缺少预期异常，其余 Windows / Node 24.x 通过。失败日志未区分三个变更分项，也未记录 runner 的原始 inode，不能声称已经取得该 runner 的具体文件 ID。

后续确定性回归通过真实 rename / 同内容重建文件，注入 `2^54` 与 `2^54+1` 两个可被 Number 舍入为相同值的 inode，实际复现旧实现漏检路径替换。读取器现使用 BigInt Stats 精确比较文件身份与纳秒时间，仅将受 512 MiB 上限保护的长度转为 Number，并保持对外字节计数类型不变。三个原有变更分项已拆为独立命名测试。

修复后的读取器、活动判定和阶段收尾定向测试 71/71 通过，0 失败或跳过；独立复核未发现实质问题。该记录补充 CI 发现与修复证据，不替代前述本机安装验收，也不代表已执行原生 Windows 登录验收。
