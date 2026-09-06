# GPT‑6 本地安装核验

日期：2026-09-06。用户已明确授权安装，并完成当前 Hook 哈希的信任。
结论：GPT‑6 策略已安装生效，本机 macOS 登录态路由验收通过。

## 已完成

- 从仓库的现有本地 marketplace 安装，未提交或发布代码。
- 最终构建：`0.4.0+codex.20260905170206`。安装前同名较早构建缓存仍有部分旧文件，使用新的 cachebuster 区分候选及验收修复。
- 执行项目安装器 `node plugins/adaptive-model-router/scripts/manage-install.mjs upgrade --non-interactive --verify-task-tools`，退出码 0。
- 安装器确认 MCP、Hook 命令、stdio bridge 和 Desktop Node 启动检查通过；此次兼容更新没有创建用于推理的 Codex 任务。
- 新缓存内 Hook 脚本、运行时模块及策略文件的源码摘要与候选一致。
- 原生 MCP 握手与工具枚举通过，共 21 个工具，包括策略查询、预览、激活和回滚。
- 插件结构校验与 `npm run validate` 通过。通用插件校验器缺少 PyYAML 的环境问题已通过临时依赖目录解决，没有修改全局 Python 环境。
- 安装后定向运行 `test/runtime-launcher.test.mjs` 与 `test/runtime-hot-upgrade.test.mjs`，10 项全部通过；`git diff --check` 通过。
- 信任后的完整回归：282 项，281 通过、0 失败、1 个 Windows 专用测试跳过。`npm run eval` 的 232 个规则用例全部符合预期；此结果不代表模型质量。

通过安装后的 `node-launcher.mjs` 调用 `codex-route.mjs`，核实正式插件数据目录：

| 项目 | 实际结果 |
| --- | --- |
| 决策策略 | `gpt6-quality-first-v1` |
| 策略摘要 | `eeef1f9773b931b8651fea7c7804a1ed7170da8d14694a16e5aea3e2e67c3a78` |
| 允许范围 | 仅 `gpt-6-astra` 的 low / medium / high / xhigh / max / ultra |
| 默认绑定 | `gpt-6-astra / high` |
| 辅助分类 | `local-only` |
| 全局自动路由 | 已开启，沿用原设置 |
| 数据库 | 版本 6，健康状态 ok |
| 旧委派 | 原有 2 个未收尾记录字段与安装前备份一致，9 个旧 gate 标记保留 |

安装前已对正式 SQLite 数据库做一致性备份。没有把未收尾记录伪造为完成，也没有清除 gate。
正式数据核验经安装后的 launcher 执行；直接运行开发 CLI 会使用旧的备用数据位置，其结果不作为正式插件状态证据。
最终有效运行时、源码摘要、七个 Hook、策略和旧数据对比见[安装状态记录](gpt6-installed-state.json)。

## macOS 登录态验收

安装器最初把裸 `node` 启动命令固定为绝对路径，造成新哈希需要信任。
用户确认后，原生 `hooks/list` 核实七个 Hook 全部开启且 `trusted`；随后修复和热更新没有改变这些哈希。
没有改写宿主信任记录，也没有使用跳过 Hook 信任的参数。

在本机 Codex CLI `0.153.3` 上执行：

| 检查 | 实际结果 |
| --- | --- |
| 正式 MCP 资格检查 | 真实 GPT‑6/low 子代理，Pre/Post/Start/Stop 关联、完整原始记录审计和服务端结果验证通过 |
| 正式 MCP 正常委派 | 资格通过后再次路由，真实 GPT‑6/low 子代理完成精确输出验证 |
| 结果与收尾 | 两个子代理、两个通过的 outcome；每次记录后 gate 为 available，待记录结果为 0 |
| 无效 ticket | 一次原生 spawn 请求被可信 PreToolUse 阻止，未创建子代理 |
| 新任务工具暴露 | GPT‑6/high 的一次性 CLI 任务实际各调用一次 `diagnose_router` 和 `route_stage` |
| 清理 | 探针根任务及子代理已归档，临时 Router 数据已清理 |

所有登录态根任务与子代理仅调用允许的 GPT‑6 组合。根任务均为新建的一次性原生测试载体，
采用 GPT‑6/high；没有修改用户现有根任务的模型或 effort。根 slug 改变分支由离线事件测试覆盖。

机器可读证据：[正式链路](gpt6-native-production-acceptance.json)、[无效委派拦截](gpt6-native-deny-acceptance.json)、
[新任务工具与安装状态](gpt6-installed-state.json)。记录只保留摘要和验证事实，不包含委派 ticket 或任务正文。

验收期间发现并修复两项兼容问题：

- 不可变策略目标交给路由后，旧校验代码尝试修改模型名，异常被映射为 `STORAGE_UNAVAILABLE`。现在返回规范化副本，已加入真实不可变策略目标的回归用例。
- 旧原始记录审计只认识较早 CLI 构建。先验证真实 `0.153.3` 的子代理和原始记录格式，再添加独立的精确版本适配。旧版本回执仍使用旧适配，未知及相邻版本继续拒绝。见[构建记录审查](gpt6-native-cli1533-source-review.json)。

另将无操作测试阶段名改为 `native-acceptance-noop`，避免名称中的 `production` 被正确识别为生产风险而触发 high 底线；未放宽风险规则。

本轮没有 Windows 原生宿主，未执行 Windows 原生验收，也未使用已废弃的 Windows 集成。

先前完整本地回归与九次登录态质量比较见[源码实现验证记录](gpt6-implementation-validation.zh-CN.md)。
