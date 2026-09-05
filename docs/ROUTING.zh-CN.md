# 路由触发、模型展示与历史记录

Adaptive Model Router 不是模型代理，也不会热切换根任务模型。它在一个有意义的
任务阶段边界上生成路由决定，必要时让根任务创建一个指定模型和 reasoning effort
的 bounded subagent。

## 什么时候会触发

当前有两条彼此配合的触发路径：

1. `UserPromptSubmit` hook 处理完整前缀控制命令。用户明确打开全局自动后，它还会
   为普通任务注入精简的路由工作流指令；不会把任务文本写入路由数据库。
2. 实际任务路由发生在 Codex 为一个实质性阶段使用 Adaptive Model Router skill，
   并调用 `route_stage` 时。skill 要求只在阶段边界调用，而不是每条消息都调用。

仅安装插件不会自动处理普通任务。信任 Hook 后单独发送一次
`路由器：全局开启` 或 `router: global on`。自动开启表示实质性阶段会调用
`route_stage`，不表示每条消息都会创建 subagent 或切换根模型。每次调用后，skill 必须显示一条可见
路由提示，明确区分根任务与阶段委派目标。

当宿主策略允许“适用 skill 明确要求的 subagent”时，`delegate` 返回值本身就是该
skill 的显式授权。它是必须执行的 action，不是建议：根任务必须立即创建且只创建一个
bounded subagent。不得把它描述为“建议委派”、把条件性策略误读成全面禁止、静默改为
root-only，或再次要求用户授权。只有宿主工具实际拒绝已声明可用的目标时，才进入文档规定的
tooling failure 重试流程。

Hook 只保留通过校验的活动根模型 slug；缺失或非法值显示为 host-managed。仅在
全局自动有效时，slug 变化才会作为手动意图信号。当前任务首次合法观察只建立
基线；后续 slug 变化会进入 `pending_confirmation`。当前请求继续使用根模型，但用户明确选择
“本任务手动”或“保持自动”前不得启动 subagent；沉默时后续轮次也保持 root-only。
恢复到基线会取消待确认，继续改成第三个模型会 supersede 旧事件。

## GPT‑6 质量优先策略

仅使用 GPT‑6 六档，默认 high，常规自动选择集中在 medium/high/xhigh。
[完整规范与配置](MODEL-POLICY-GPT6.zh-CN.md) 说明六档条件、稳定阶段、失败升级、
允许范围、原子激活、回滚和本轮验收边界。

先检查高档触发条件，再考虑安全降档。low 需要明确需求、低风险、纯机械处理、
强验证和确定性输出校验；medium 需要明确需求和强验证，且没有歧义、跨模块、
审查、风险或架构权衡。证据不足保持 high。xhigh 需要跨模块加歧义/架构权衡，
或两个独立困难组；max 需要三个独立困难组加高失败成本/不可逆性，或由 xhigh
推理失败升级；ultra 只由 max 推理失败且仍有预算，或显式请求进入。

困难组为安全或迁移、高风险或高失败成本、跨模块公共契约、架构权衡、不可逆性，
相关标签不重复计数。每个逻辑阶段最多自动增强两次，顺序为
`low/medium → high → xhigh → max → ultra`。环境、信息、工具故障保持目标。
传入稳定 `stageId`；省略时按本任务的 phase 关联。描述长度或分数小幅变化不会
单独切换档位，成功后下一阶段重新分类。

旧评分、学习偏移和历史保留原义；新策略的分数仅作诊断，旧 offset 不决定档位。
分类器默认本地规则，显式启用的辅助分类只影响诊断分数。根模型、子代理、分类器
分别读取实际执行接口能力，统一与允许范围求交集；缺少子代理能力时不猜测模型。
显式不可用或范围外目标不会静默替换。

活动委派、Hook 信任、派发握手、验证和 once 消费仍遵守原有约束。范围、条件和
目标绑定保存在独立版本化策略中，新增候选不会新增评分区间。预览只读，激活和
回滚核对当前摘要；存在未收尾委派或分类调用时不切换。

## 如何看“当前模型”

必须区分两件事：

- **根任务模型**：由 Codex 宿主管理。受信任 Hook 可以观察其 slug，但读不到
  reasoning effort；路由器不会改变两者。右下角选择器始终表示这个根任务。
- **阶段委派目标**：`delegate` route 中的 `target.model` 和 `target.effort`。

发送以下任一命令：

```text
router: status
路由器：状态
```

状态报告会显示：

- 全局自动开关、本任务模式、观察到的根模型或 host-managed fallback；
- 待确认的根模型变化；
- 最近一次 route 的 action；
- 当前有无待提交 outcome 的委派；
- 阶段目标模型和 effort；
- route 时间、原因、transition 和 outcome；
- 待提交 outcome 与待审批策略数量。

## 如何看模型委派变化记录

最方便的交互命令是：

```text
router: history 10
路由器：历史 10
```

数字范围是 `1..20`。每条记录包含 route 当时的根模型快照、时间、action、bounded
目标模型/effort、
`initial_delegate`、`target_unchanged` 或 `target_changed` transition、
reason codes、route ID 和 outcome。

这些时间是 route 原子写入 SQLite 的时间。记录表示“阶段路由/委派决定”，不是
根模型热切换，也不能单独证明宿主进程已经成功启动 subagent；最终 outcome 提供
该委派是否完成验证的后续证据。

Agent 或自动化可以使用只读 MCP 工具：

```text
get_route_status
get_route_history
```

源码仓库中的开发 CLI 也支持：

```bash
node plugins/adaptive-model-router/scripts/codex-route.mjs status --context TASK_ID
node plugins/adaptive-model-router/scripts/codex-route.mjs history --context TASK_ID --limit 20
node plugins/adaptive-model-router/scripts/codex-route.mjs history --context TASK_ID --limit 20 --action delegate
```

history 只能读取当前项目与当前 `contextId`，不能枚举其他项目或任务。数据库不保存
prompt、源码、绝对项目路径、环境变量或 secret。
