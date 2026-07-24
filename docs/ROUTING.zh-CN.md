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

Hook 只保留通过校验的活动根模型 slug；缺失或非法值显示为 host-managed。仅在
全局自动有效时，slug 变化才会作为手动意图信号。当前任务首次合法观察只建立
基线；后续 slug 变化会进入 `pending_confirmation`。当前请求继续使用根模型，但用户明确选择
“本任务手动”或“保持自动”前不得启动 subagent；沉默时后续轮次也保持 root-only。
恢复到基线会取消待确认，继续改成第三个模型会 supersede 旧事件。

## 决策顺序

`route_stage` 按以下顺序执行：

1. 校验严格输入，并把项目和任务标识转换成本机 HMAC。
2. 根模型意图待确认或本任务手动时，以专用 reason 返回 `continue`。
3. 按固定优先级解析 override：
   本次请求 → once → session → project → 可选 global。
4. 路由器被禁用时返回 `continue`。
5. 宿主不能按模型和 effort 创建 subagent 时返回 `continue`。
6. 没有 override，且任务是问候、简单短问答或明确不产生工作产物时返回
   `continue`。
7. 加载 Codex 可见模型目录；没有已知可用模型时 fail-open 为 `continue`。
8. 进行确定性评分；只有实质性且临界的任务才可能调用脱敏辅助分类器。
9. 应用风险底线、已批准项目策略和单调失败升级。
10. 检查目标模型/effort 能力，并原子写入 route；once override 只在真正提交
   `delegate` 时消费。

显式模型或 effort 不可用时返回 `ask_user`，不会静默替换。reasoning failure
最多自动增强两次；之后返回 `ask_user`。

## 确定性评分

基础分为 `40`。文本信号和调用方提供的事实 evidence 会产生以下调整：

| 信号 | 调整 |
| --- | ---: |
| 需求含糊、架构或权衡 | `+18` |
| 高风险、生产、公开 API、并发等 | `+25` |
| 安全或迁移 | `+10` |
| 跨模块/端到端改动 | `+15` |
| 实现或风险任务缺少强验证 | `+8` |
| 评审阶段 | `+10` |
| 批量机械任务 | `-28` |
| 单个机械任务 | `-20` |
| 需求明确 | `-10` |
| 需求明确且有强验证 | 再 `-5` |
| 非风险的探索阶段 | `-8` |
| 脱敏后的任务文本超过 2,000 字 | `+8` |
| 已批准的类别策略 | `-15` 至 `+15` |

最终分数限制在 `0..100`，下表表示策略偏好的模型家族：

| 分数 | 模型家族 | effort |
| ---: | --- | --- |
| `0..25` | Luna | low |
| `26..45` | Terra | low |
| `46..60` | Terra | medium |
| `61..80` | Sol | medium |
| `81..92` | Sol | high |
| `93..97` | Sol | xhigh |
| `98..100`，且至少两个独立硬信号 | Sol | max |

另外还有硬规则：

- `0..25` 的低复杂度非批量阶段默认留在根任务；显式 override 除外；
- 无风险的批量机械任务使用 Luna low；
- 实现、review、风险、安全和迁移任务不使用低复杂度 `continue` 捷径；
- 需要委派的实现任务不会自动落到 Luna；
- review 至少使用 Sol medium；
- 风险、安全或迁移任务至少使用 Sol high。

Max 门只计算彼此独立的维度，不重复计算相关标签：安全或迁移、显式高风险或高
失败成本、跨模块公共契约、架构权衡、不可逆性。静态评分永远不会直接选择 Ultra。
只有 reasoning verification failure 可以最多自动增强两次，严格遵循
`high → xhigh → max → ultra`；之后询问用户。environment、information 和
tooling failure 不提高 effort。若 Ultra 阶段存在并行写入风险，则返回
`ask_user`，不创建委派。

最终 bounded 目标还必须与当前宿主声明的 subagent 能力求交集；根模型可见不等于
可委派。当前宿主如果只向 bounded subagent 公开 Sol、Terra，Luna 偏好会自动
回退到 Terra，并带上 `MODEL_FAMILY_FALLBACK`。用户显式指定的不可用目标不会被
替换。辅助分类器使用第三套独立目录，来自其临时 app-server 的 `model/list`。

实质性任务距离 `25/45/60/80/92/97` 任一边界不超过 6 分，或者只匹配到很少信号且
分数在 `30..80`，才属于临界任务。默认辅助分类器最多只把复杂度调整
`-10/0/+10`，且不能突破风险底线。

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
