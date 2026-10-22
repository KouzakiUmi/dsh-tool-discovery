# 09 · 当前业务逻辑地图

更新日期：2026-10-22。依据 manifest `0.4.3` 的构建源码，整合主线 `c1709d3` 与后续预算、名单、技能、游标和候选提交修复。
这是**源码导读**，不是一次新安全审查或产品验收；精确行为见 [00](<00-current-contract.md>)，实测状态见 [05](<05-current-status.md>)。
旧微基准、历史问题清单与当时的处置保留在[刷新前版本](https://github.com/KouzakiUmi/dsh-tool-discovery/blob/b12dfef1815636c1518f741da870c1dd5427442f/plugin/docs/09-business-logic-map.md)，不再混作当前待办。

## 1. 一句话业务

把“发现需要什么能力”与“向模型披露完整参数”分开。三个入口和初始工具集合先出现，其它工具经显式加载后下一轮披露，仍由宿主原执行链调用。
减少披露是设计目标；是否节省 token 或总任务时延需要测量，不能从工具数量或域内微基准推断。

## 2. 分层与职责

| 层 | 源码 | 职责 |
|---|---|---|
| 目录/版本 | [catalog](<../domain/catalog.mjs>)、[categories](<../domain/categories.mjs>) | 当前绑定快照、类别、schemaDigest/revision；不赋予宿主权限 |
| 搜索/列表 | [search](<../domain/search.mjs>)、[list](<../domain/list.mjs>) | 任务候选、完整名称、游标；不提交选择 |
| 参数/预算 | [protocol](<../domain/protocol.mjs>)、[budgets](<../domain/budgets.mjs>) | 严格字段校验、完整成功外壳计量、事务配额 |
| 状态/组合根 | [state](<../domain/state.mjs>)、[engine](<../domain/engine.mjs>) | canonical 归约、pending、版本冻结、选择/披露恢复 |
| 资格 | [registry](<../adapters/dsh/registry.mjs>) | scope 原生可见性与绑定代次；生产技能仍为 null |
| 生命周期 | [lifecycle](<../adapters/dsh/lifecycle.mjs>) | per-session runtime、就绪屏障、周期切换、卸载与旧等待失效 |
| 日志 | [journal](<../adapters/dsh/journal.mjs>) | own-only 历史、call/result 配对、header 观测与重放 |
| 展示/执行 | [projection](<../adapters/dsh/projection.mjs>)、[guard](<../adapters/dsh/guard.mjs>)、[PTC](<../adapters/dsh/ptc-sdk.mjs>) | native 披露/附加拒绝；可选 PTC SDK 投影与出站匹配 |
| 基线策略 | [epoch-policy](<../adapters/dsh/epoch-policy.mjs>)、[trusted-epoch](<../adapters/dsh/trusted-epoch.mjs>) | 主/子可选 durable 记录，不从 header 生成授权名单 |
| 设置 | [config](<../adapters/dsh/config.mjs>)、[inventory](<../adapters/dsh/tool-inventory.mjs>)、[client](<../client/client.js>) | 配置与全局登记辅助目录，和会话执行目录分开 |

宿主依赖与文件 I/O 留在 adapter；domain 不导入宿主包，也不读取真实 profile。

## 3. 三入口如何闭环

```text
tool_list：浏览类别或名称 ────────┐
tool_search：类别内任务候选 ────┤
                                ▼
tool_load：解析当前绑定 → 冻结冲突检查 → 配额预留 → 回执
                                ▼
canonical 最终成功结果：核验输入、归属与版本 → selected
                                ▼
下一轮实际披露观测：advertised / frozen
                                ▼
原生调用：guard 只增加拒绝 → 宿主原策略与派发
```

任一 `ok:true` body、检索命中或 header 都不能独立完成整条链。加载取消、回执改写、后处理失败、版本变化等要么拒绝提交，要么收口该操作的 pending，不留下幽灵配额。

## 4. 四类状态为何不能合并

- **selected**：当前有效版本的显式选择，不是宿主副作用批准。
- **advertised**：该版本实际披露的请求凭据；预览 assemble 不算。
- **frozen**：首次披露的旧 wire/次序；撤权不能让已经送进模型的文本凭空被改写，但也不能继续赋予执行资格。
- **invalidated**：失效诊断；state 视图可以带标记裁剪这一段，不能静默删除执行/披露事实。

同名不同 schema 不能在周期中普通重载：先返回 `COMPACTION_REQUIRED`，无预算预留。
相同 schema 的重绑可重新选择，冻结槽位只计一次；新技能发送独立于 schema 配额去重。

## 5. 一轮请求与成功压缩

1. 确认 agent/session 和当前展示模式，取得对应 runtime。
2. 等恢复与需要的 durable 基线落定；pending 不用超时兜底发缩水请求。失败则按既有 fail-closed 状态处理。
3. native 组装后投影：入口、可信保留项、初始集合、有效选择及冻结缓存；观察到的首见次序优先，新项追加。
4. 若成功自动压缩发生在 assemble 后、实际发送前，刷新**尚未发送**的投影；已经发送的历史数组不被事后修改。
5. canonical header 建立实际披露凭据，执行 guard 再查当前资格与版本。

名单类 volatile 设置在新 runtime / 成功周期边界采用；`ptcCompatibility` 另按下一轮采用。
两个可信周期开关及 `respectAlwaysVisible` 等非 volatile 设置走重挂载，不应统称为一种“严格模式”。

## 6. 恢复与次序

- 先订阅并缓存，再读 raw 历史、核验 own/inherited 边界与连续 seq，再合并去重。
- `call.seq` 保持来源归属，`resultSeq` 排序提交；热态和 replay 用相同最终结果次序。
- 执行选择按当前绑定与资格核验；旧 wire 的 native 披露恢复按当前周期实际历史证据单独进行。
- 有 matched 成功回执且之后有同 digest 的实际 header，才可恢复按需披露；继承前缀、失败回执、孤立 header 不授予选择。
- 新周期不继承旧周期 frozen；fork 不从父的继承前缀恢复父 selected。
- 卸载使本次 activation 的等待失效，不 abort 宿主/用户自己的 signal；旧 runtime 不得在释放后重建。

严格模式存的是基线名单，不是完整工具权限数据库；默认关闭时不伪造 trusted durable 记录。其历史合同和残余窗口见 [08](<08-trusted-epoch-baselines.md>)。

## 7. 当前修复与明确取舍

| 项 | 当前落点 |
|---|---|
| 冻结 schema 升级 | 同名槽位检查，必须等成功压缩；不假返回无法兑现的加载成功 |
| 冷恢复丢旧披露 | 披露与执行选择分别恢复；不因保留旧定义重新授权 |
| 结果乱序 | 最终结果序提交，不依 call 顺序丢弃合法结果 |
| 技能换版 | 相同 wire 不重复计 schema；只对已提交同版本选择省略技能，不让可失败的 pending 吞掉后续指南 |
| 初始与重试额度 | 容错重载基线仍免费；降限额后的零新增重选可继续，真正新增仍受限 |
| 目录与在途预留 | 整笔回执的版本均须匹配当前目录；任一项已换版/移除则整批不计额，不借旧 toolId 预留给新 schema |
| 失效游标 | 资格代次改变立即回收；无变化或刷新失败仍保留有效游标 |
| 候选提交边界 | ref 在 load 接纳时校验；逐字匹配的已接纳回执不因等待期间 ref 到期而撤销，热态提交与冷恢复一致 |
| 类别词误命中 | 类别只参与排序，必须有工具级证据；纯类别查询可能需要改用浏览 |
| 字节预算 | list 四视图/search 完整成功外壳，先确定可交付页再铸 ref/cursor |
| 默认基线 | 核心同名自证可减少往返；开启 respectAlwaysVisible 才收窄这一例外 |
| 技能服务 | 内核有合同，生产 registry 尚不提供技能，不把“可发送”写成“已接线” |

状态/披露回归见 [design-invariants](<../tests/unit/design-invariants.test.mjs>)，前轮四项业务闭环与双语引导见 [business-workflow](<../tests/unit/business-workflow.test.mjs>)，目录/在途/游标交互见 [catalog-workflow](<../tests/unit/catalog-workflow.test.mjs>)。通用动词误召回和候选迟到回执的热冷边界仍未闭合，没有靠新增默认门槛改变检索准入或排序。

## 8. 性能与覆盖边界

宿主可能在投影之前仍收集、克隆完整 schema；出站工具减少不意味着宿主 CPU 自动从 O(N) 变成 O(已加载)。
历史域内耗时只反映对应目录、机器和快照，不能替代 provider、TTFT 或任务完成时间测量。
实际披露会随任务增长，并积累搜索/加载历史；默认不允许模型自主 unload，不能承诺上下文永远保持初始大小。

PTC 当前按当前 SDK schemas 渲染，**不是 native frozen wire 的另一种序列化**。已有出站匹配保护不代表 SDK 冻结、追加顺序和跨重启语义完成。

## 9. 后续工作入口

- 尚未闭合的产品、测量与宿主覆盖项只在 [05 §3](<05-current-status.md#3-未闭合的验证与产品边界>)集中维护，不再复制过时的逐轮问题清单。
- 目标 Core 升级时执行[12 的取证/差集流程](<12-core-tools-maintenance.md>)，不能只放宽 peer。
- 任何未来状态机/授权修改仍需非作者复核；历史有限签署不替后来改动补签。
