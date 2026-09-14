# Router 历史备份归档验收

日期：2026-09-12。范围：用户授权归档不再需要的本机版本副本；不安装正在开发的升级隔离实现。

## 已执行

- 22 个孤立旧备份已原子移动到项目和生产扫描范围之外，合计 1,671 个文件、18,564,064 字节（17.704 MiB）。归档是保留原件的迁移，没有永久删除代码，也不等于释放同等磁盘空间。
- `runtime-shell-vault`：61 → 39 个版本目录；cache：39 → 39 个版本目录。
- 活动版本仍为 `0.4.0+codex.20260912132803`，回退版本仍为 `0.4.0+codex.20260912132046`。
- 活动指针、vault 索引、全部 39 个缓存和保留的 39 个备份内容均与操作前基线一致。已归档文件也逐一核验 SHA-256 一致。

## 选择依据

归档的 22 项均不在 vault 索引、没有同名 cache 目录，也不属于 active、previous 或 failed 指针。其 shell/tool/storage 协议为 1/3/1、1/4/2 或 1/6/2；全部已安装 cache 入口要求 1/7/3，不能加载这些副本。旧候选入口没有 vault 恢复逻辑，现行入口和安装器只恢复索引内版本。

独立只读审计还检查了当前进程、打开文件和 Router 资格记录，没有候选 vault 路径引用。进程不存在仅作为辅助证据。两个旧版本的 cache 路径摘要仍出现在已通过的历史资格中，所以本次只归档孤立 vault 副本，不能宣称这些版本与历史任务完全无关。

现存 39 个 cache 目录和 39 个已索引备份仍由旧绝对入口、发现、资格与恢复机制使用，不能按年龄强行减少为最近两版。

## 归档与恢复

- 归档目录：[orphan-vault](/Users/niuzhenya/Documents/adaptive-model-router-archives/20260912-upgrade-isolation/orphan-vault)
- 完整文件摘要、权限、原路径与目标路径清单：[orphan-vault-manifest.json](/Users/niuzhenya/Documents/adaptive-model-router-archives/20260912-upgrade-isolation/orphan-vault-manifest.json)
- 操作前基线：[production-before.json](/Users/niuzhenya/Documents/adaptive-model-router-archives/20260912-upgrade-isolation/production-before.json)
- 可复核摘要与版本名单：[runtime-vault-archive-20260912.json](./runtime-vault-archive-20260912.json)

需要恢复时，先按 manifest 校验归档文件和目标身份，仅在原路径不存在、当前机制确实需要该副本时逐项移动回原路径。禁止覆盖并发新建目录；禁止恢复数据库、活动指针或索引快照来撤销本次归档。执行脚本自身在失败时遵循这一局部回退规则，本次未发生回退。

## 本次边界

没有调用安装器、重新注册插件、修改全局活动指针、改写已安装 Hook 或替换共享数据库。升级隔离功能另在开发分支及临时数据区实现和验收，是否安装遵循用户后续通知。
