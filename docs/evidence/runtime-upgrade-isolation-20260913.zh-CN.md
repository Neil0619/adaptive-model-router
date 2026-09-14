# Router 升级隔离与历史版本归档：交付验收

日期：2026-09-13，Asia/Shanghai。分支：`codex/runtime-upgrade-isolation`，基线：`2ffccd911cd49c0a311584176aff488a56be1558`。代码尚未提交或推送。

## 交付状态

本轮完成开发、离线验证、独立复核与已证明无引用的旧备份归档。**没有把本轮 v2 实现安装或加载到全局**。首次入口转换需要冷注册窗口；按用户要求，等待后续通知再执行，不要求现在关闭任何正在运行的任务。

运行中的任务继续使用原有已安装版本 `0.4.0+codex.20260912132803`。未修改活动指针、全局配置、marketplace、已安装 Hook 或缓存代码，也未给被放弃的 DeepSeek 任务发送消息。

实现与后续安装操作见 [运行时隔离实现说明](../RUNTIME-UPGRADE-ISOLATION-IMPLEMENTATION.zh-CN.md)，开发前依据见 [隔离审查与方案](../RUNTIME-UPGRADE-ISOLATION-REVIEW.zh-CN.md)。

## 实现及边界

- 开发目录、候选包与正式发布分离；旧 v1 loader 不会把 v2 sibling、active 指针或 vault 候选当成新版运行时。
- 稳定入口统一选择任务与阶段绑定。发布只更新默认版本；在途票据、子代理、消息、命令及历史结果继续由其所属版本处理。
- 现有 v2 任务只在可证明的原生回合边界、无未决责任且资格有效时迁移。未知操作、丢失回执或活动调用保持旧绑定。冷桥保留同一数据库、策略、盐、结果和全局 10 个预留账本。
- 发布完整校验包摘要及执行入口。当前允许热发布的代码边界仅为经过受限语法检查的 `inferCategory` 纯分支；Hook、共享 writer、稳定入口及其他代码变化需要另行实现并验证兼容过渡。不能把此次交付描述为任意代码都可无感热升级。
- 兼容更新复用稳定入口，不为每个任务重新注册 Hook。仍被任务、原生入口、回退或未知责任引用的旧包保留；不承诺固定最多两个版本，也不按年龄强删。legacy 任务的自动入口退役尚未实现。
- 普通原生子代理保留未托管旁路；Router 损坏时保留根任务普通诊断命令。缺失覆盖不会被伪造成迁移证据。

## 最终检查

| 检查 | 结果与范围 |
| --- | --- |
| 完整源码测试 | 449 项：446 通过，0 失败，3 项原生 Windows 检查跳过；104.1 秒 |
| `npm run validate` | 通过 |
| `npm run eval` | 232 个策略用例全部一致，风险底线召回 1，控制误触发 0；不是模型质量评测 |
| 原生 macOS CLI 0.153.4 | 显式临时 CODEX_HOME 下注册 v1、替换为 v2、恢复全部旧缓存路径，并通过真实 wrapper 卸载临时插件；原共享数据保留 |
| 真实历史的私有副本 | online backup 上的 1,400 个保留阶段、原有策略/盐/outcome/释放处分不变；无创建时间证据的休眠任务保留 v1，新根身份 fixture 选择 v2 |
| 独立复核 | gpt-6-astra / xhigh；两项确认缺陷已修复并独立复验，0 项未解决实质问题 |
| 差异检查 | `git diff --check` 通过 |

独立发现的两个缺陷分别为：入口映射能绕过冻结代码边界，以及稳定 marketplace 被卸载 wrapper 错判为异源。回归现在覆盖 hook/service/probe 重定向、原路径 probe 变化、源码/稳定壳/cache 卸载，以及异源、软链接和多插件来源拒绝。

历史副本检查采用明确的离线冷边界与原生身份 fixture；没有在真实任务中伪造 Hook、Stop 或成功记录。测试跳过项为 Windows 原生命令发现、精确 Windows Hook 命令、PowerShell gate adapter。真实首次冷注册、Hook 信任、macOS 与原生 Windows 登录态在途任务跨升级验收仍延后，不能用离线通过替代。

最终源码包摘要：`d1099839b136945f837aa7b55d6c0bc7170c167d62b956587bda5952509aba59`。完整计数、摘要和限定条件见 [机器可读回执](runtime-isolation-validation-20260913.json)。

原始日志保存在私有归档：[完整测试](/Users/niuzhenya/Documents/adaptive-model-router-archives/20260912-upgrade-isolation/final-suite.log)、[validate](/Users/niuzhenya/Documents/adaptive-model-router-archives/20260912-upgrade-isolation/final-validate.log)、[eval](/Users/niuzhenya/Documents/adaptive-model-router-archives/20260912-upgrade-isolation/final-eval.log)。

## 版本清理

| 位置 | 操作前 | 操作后 | 处理 |
| --- | ---: | ---: | --- |
| cache | 39 | 39 | 旧绝对入口、资格及恢复机制仍需保留 |
| runtime-shell-vault | 61 | 39 | 22 个孤立副本已归档 |

归档共 1,671 个文件、18,564,064 字节，全部逐文件核对摘要，采用同文件系统原子移动；没有永久删除。归档不等于释放同等磁盘空间。归档路径与恢复方法见 [历史备份归档验收](runtime-vault-archive-20260912.zh-CN.md)。

最终检查时间为 2026-09-13 00:57:33 +08:00：原始 100 棵版本树（包括已归档的 22 棵）内容全部与操作前基线一致；活动指针、vault 索引、全局注册配置及 materialized marketplace 未变。生产数据库没有 v2 runtime 表；当前任务正常的 v1 路由及 outcome 记录仍会写入，不能声称整个生产数据库字节未变。

## 本轮发生的备用库误写及处理

一次直接执行验证脚本时缺少隔离环境，向备用路径 `~/.codex/adaptive-model-router-v2/router.sqlite3` 写入一个合成项目的 8 表记录（包括 20 个 outcome）。另有三个测试包因恢复目录错误进入该备用路径。这与当前已安装插件实际使用的 `~/.codex/plugins/data/adaptive-model-router-adaptive-model-router` 是不同的数据域。

先保留 online backup、全表和文件清单，再经独立核对精确删除该合成项目记录；全部其他行及原有 6 个 outcome 保留。三个测试包完整归档。没有覆盖整个数据库，没有猜测删除 schema、meta 或 sequence。**没有事故前完整快照，因此不声称未知结构已恢复到无法证明的前态。**

根因已修复：测试与 eval 入口统一使用临时数据域；writer verifier 在导入写入代码前检查严格隔离条件；恢复目录只从实际打开的数据库路径派生。最后一轮完整测试后再次核对：39 张表与精确清理后的备份完全一致，原有 6 个 outcome 仍在，没有新泄漏包，完整性与外键检查通过。

私有证据目录为 `/Users/niuzhenya/Documents/adaptive-model-router-archives/20260912-upgrade-isolation/fallback-test-incident`，目录权限 0700、文件 0600；保存清理前后快照、逐表对比、归档归因及最终复核。它们不进入 Git。

## 当前任务收尾

实现阶段与独立复核均使用原生子代理完成，并分别保存唯一 outcome（1377、1378）。最终 `stageClosure=null`、`pendingOutcomes=0`、委派门禁可用。本机全局有效预留为 1/10，历史释放记录为 3 条；其他任务责任未被本轮擅自清理。

用户现在无需操作。后续收到安装通知后，再安排首次冷注册与两平台登录态验收；本轮不执行全局加载。
