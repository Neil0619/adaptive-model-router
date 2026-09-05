# GPT‑6 路由实现验证记录

日期：2026-09-06。验证对象为当前源代码工作区，未提交、未发布、未安装此候选。
本文件不是原生发布 PASS 凭证。

## 候选身份

- 构建：`0.4.0+codex.20260905151630`。
- 策略：`gpt6-quality-first-v1`，schema `1`。
- 策略摘要：`eeef1f9773b931b8651fea7c7804a1ed7170da8d14694a16e5aea3e2e67c3a78`。
- 原生探针所用源码摘要（Hook、lib 模块及策略文件）：`87ed0e7d242e674e508d4f4779fa5ecd0a49770010b01cdb465657a99f4447d0`。
- 路由输出 `6.0`，数据库 `6`，工具契约 `7`，存储契约 `3`；live workflow 契约 `4`。

## 本地检查

在 `plugins/adaptive-model-router` 执行：

| 命令 | 结果 |
| --- | --- |
| `npm test` | 280 项：279 通过、0 失败、1 跳过；约 106 秒 |
| `npm run validate` | 通过；包含源文件语法、工具 schema、版本、安装与文档契约检查 |
| `npm run eval` | 232 项符合预期：30 个中英文新规则用例、202 个旧评分兼容用例；无差异 |

根目录 `git diff --check` 通过；质量比较脚本 `node --check` 通过。
唯一跳过项为原生 Windows cmd.exe / PowerShell Hook 集成测试，本轮宿主为 macOS。
安装器测试使用隔离 fixture 与模拟 Codex，不代表实际插件已安装。

新增回归覆盖风险优先、六档条件、候选数量与排序不影响选择、缺少能力、旧范围外锁定、
显式不可用目标、同阶段目标保持、失败类型核对、最多两次自动增强、过期前驱引用拒绝、
用户在预算耗尽后显式选择 ultra、活跃委派/推理租约阻止切换，以及旧评分与新决策隔离。
策略预览不写入；激活和回滚均测试了写入失败原子性；重新启用旧定义后按实际激活顺序回滚。

## 登录态质量比较

[原始脱敏记录](gpt6-quality-pilot.json)包含相同三个样本在 medium/high/xhigh 的九次执行。
样本为行规范化实现、事务激活审查和路由条件分析，输出经过确定性检查。

| 档位 | 首次通过 | 纠正次数 | 三个样本总耗时 |
| --- | --- | --- | --- |
| medium | 3/3 | 0 | 39.041 秒 |
| high | 3/3 | 0 | 43.683 秒 |
| xhigh | 3/3 | 0 | 61.216 秒 |

所有调用明确请求并观测到配置模型 `gpt-6-astra`，可观测 token 用量保存在 JSON。
宿主未提供实际服务模型证明，`servedModel` 保持 null。耗时包含宿主开销；缓存状态有差异。
记录保存了执行时的策略定义；后续配置结构整理没有改变这九次调用的允许组合。
三个样本不足以校准生产阈值，本轮保留默认 high。规则符合率不能作为模型质量结论。

## 原生验收与安装边界

macOS 命令 `node scripts/probe-native-qualification.mjs` 在预检返回：

```json
{"stage":"error","message":"trusted installed Hook set is unavailable"}
```

该次原生探针没有启动模型推理、任务或子代理。未绕过 Hook 信任，未安装或激活此候选。
新工具/存储契约不属于旧 shell 的兼容热升级范围。

后续安装验收需通过现有安装器的契约检查，将当前候选安装到受支持宿主，并完成对应
Hook 哈希的一次性信任，再运行原生资格与完整委派烟测。项目
[AGENTS.md](../../AGENTS.md)规定：
“Hook trust remains an explicit host security boundary.”
信任由用户授权，源代码测试不能代替这一宿主操作。

Windows 原生宿主本轮不可用。Windows 脚本从共享策略读取允许目标；仅 GPT‑6 时，
跨根模型 slug 的 pending/keep-automatic/manual-root 分支使用离线事件测试并标记
`HOST_MODEL_INTENT_OFFLINE_ONLY`，不实际调用 Sol。完整跨平台原生验收尚未完成。
