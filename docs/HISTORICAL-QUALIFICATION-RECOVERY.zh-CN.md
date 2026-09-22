# 历史资格验证恢复

本次修复处理两种已复现的历史状态：完整 Hook 链下，两轮结束的旧版资格验证被记为 `failed/environment`；以及票据已消费、Post 已观察，但 child 在产生模型结果前中断，Start、Stop 和 outcome 均缺失。

这两种状态使用独立恢复收据，不改写原资格或 outcome，不补造缺失 Hook、child 关联、`no_child` 或成功证明。无原始日志、身份不一致、未知原始事件、晚到输入、隐藏工具、模型执行证据不完整或检查期间发生变化，均保留阻断。

## 运维入口

在目标任务原工作目录运行源码或已发布包中的脚本；明确指定已有的 Router 数据目录。

```sh
ADAPTIVE_ROUTER_HOME=/absolute/existing/router-home node /absolute/plugin/scripts/reconcile-historical-qualification.mjs \
  --context NATIVE_TASK_ID --route ORIGINAL_ROUTE_ID
```

预览通过私有只读数据库副本取证，不对原数据库运行初始化或迁移。原生父、子日志与完整 native projection 必须两次读取一致。`recoverable` 仅表示本次证据满足恢复契约。

确认同一证据摘要后应用；脚本会重新执行完整检查，并在写事务内复核数据库和文件身份：

```sh
ADAPTIVE_ROUTER_HOME=/absolute/existing/router-home node /absolute/plugin/scripts/reconcile-historical-qualification.mjs \
  --context NATIVE_TASK_ID --route ORIGINAL_ROUTE_ID --apply --expect-digest PREVIEW_DIGEST
```

若原资格使用运行时命名空间，另传 `--source-runtime SOURCE_PACKAGE_DIGEST`。参数只选择原始记录，不提供可信证明。脚本自行读取原生身份、模型、调用和结果。

恢复后仍返回 `ordinaryDelegationEnabled: false`。中断票据只在原生终态已证明后收尾，并计入实际日志空间；完整失败记录原有状态保持，只补足尚未记账的日志增长。重复恢复不重复计费。

## 后续资格与运行时交接

在同一运行时继续时，已有 `authorize-requalification.mjs` 可为恢复记录授予一次无工具资格验证。它重新检查完整原生历史、当前 Hook 绑定和最终写入时的文件身份；授权绑定原始记录、当前配置与运行时，保留一小时有效期、一次消费和原资格归档限制。

在已通过安装兼容验证的运行时交接中，epoch sweep 只能读取已经应用的恢复收据，再取得本进程持有的原生复核结果。该结果不可由 JSON 或摘要替代，源变化取消交接。交接保留原资格、原 outcome 和责任，并使候选运行时重新取得自己的资格；交接收据不授予业务委派资格。已有不同的候选资格也不得被覆盖。

## 无法补回的历史

旧 root coverage 仅保留前缀摘要时，当前全量日志、当前空闲和重复读取不能证明原前缀没有丢失。`root_coverage_changed` 继续阻断。恢复需要匹配原摘要的历史前缀及可信的变更关联证据；本功能不重新锚定旧日志，不把当前内容追溯解释为旧内容。

这些运维检查和实际安装、原生入口接管、重新资格验证分别验收。源码或隔离测试通过不能替代真实任务恢复。
