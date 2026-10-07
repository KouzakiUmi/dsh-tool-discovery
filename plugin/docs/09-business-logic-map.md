# 09 · 业务逻辑地图与待办清单

> **性质**：这是一份**派生的整理文档**，不是证据文档、也不代表任何验收结论。
> 逐项"已验证 / 未验证"的权威口径仍以 [05 当前状态](<05-current-status.md>)、[03 验收矩阵](<03-implementation-and-acceptance.md>)
> 与 [08 可信周期基线](<08-trusted-epoch-baselines.md>) 为准；本文与它们冲突时以它们为准。
>
> **方法**：通读 `plugin/domain/**` 与 `plugin/adapters/dsh/**` 全部产品源码 + 设计文档 01/02，
> 加上在 `.probe/` 下对活引擎跑的定向探针（检索排序、入口行为、分页与预算），
> 以及 `fix/runtime-stability-and-retrieval-quality` 分支上的一轮修复。
> 涉及宿主动态行为的结论标注了静态推理的部分；本轮改动碰到 `domain/` 的 load/unload
> 状态机，**按 CONTRIBUTING 的规矩不算作者自签**，需非作者复核。
>
> 整理日期：2026-10-07 · 对应源码版本 `0.2.0-functional.6`（未 bump）

---

## 1. 一句话业务

模型每轮本来要背全部工具的 JSON Schema（实测 60K+ token）。本插件把普通工具**全部藏起来**，
只留三个小入口让模型自己问："有什么能力 / 哪个能用 / 我要激活哪些"。
激活的工具在**下一轮**才随原生 `tools` 数组出现，且只能靠原名称、原参数、原执行链调用。

省下来的是**披露量**，代价是**多一到两次工具往返**。

---

## 2. 分层与职责

| 层 | 文件 | 只负责 |
|---|---|---|
| 目录 | `domain/catalog.mjs` | 绑定 → 不可变快照；`schemaDigest` / `revision` / `searchDocumentId` 的唯一算法 |
| 分类 | `domain/categories.mjs` | 结构规则（只看 name/namespace，不读外部描述）→ 12 个受控类别 |
| 检索 | `domain/search.mjs` | 双语分词、受控同义词、字段覆盖率加权排序；**不凑 K** |
| 列举 | `domain/list.mjs` | 四个 view + 绑定顺序摘要的 opaque 游标分页 |
| 协议 | `domain/protocol.mjs` | 三个入口的严格入参校验 + 响应外壳（未知字段一律拒） |
| 预算 | `domain/budgets.mjs` | 字节/项数核算；**只减完整项数或明确失败，不截断内容** |
| 状态 | `domain/state.mjs` | 纯 reducer + 回执逐字核验 + guard 判据 |
| 组合根 | `domain/engine.mjs` | list/search/load 事务、canonical 折叠、曝光登记、代次、恢复 |
| 宿主适配 | `adapters/dsh/*` | 资格事实（registry）、投影（projection）、门禁（guard）、journal / lifecycle / trusted-epoch |

**铁律**：`domain/` 只依赖 `node:crypto` 与自身相对模块，不 import 任何宿主包；
所有"当前可见性 / 展示模式 / 保留名单"都由 adapter 以可信 DTO 传入。

---

## 3. 三入口的协议面

| 入口 | 入参 | 出参 | 不做什么 |
|---|---|---|---|
| `tool_list` | `view`(available/loaded/categories/state)、`category`、`cursor`、`limit` | 只有完整原生名称的分页 / 类别卡 / 会话状态 | 不带描述、不带 schema、不生成 ref、不自动加载 |
| `tool_search` | `category`、`query`、`limit` | 少量候选卡（`toolId`+`ref`+`revision`+名称+≤96 码点摘要+受控 `matchReasons`） | 不返回参数 schema、不改激活集合、不凑 K |
| `tool_load` | `candidates[{ref, revision?}]` **或** `names[]`（互斥） | 版本化回执 + 技能卡（下一轮生效） | **不执行目标工具**、不批准副作用 |

失败语义统一是 `ok:false` + `error.code` 的 JSON 串**作为结果文本返回**，`execute` 不外抛
（DSH 会把抛错渲染成非 JSON 文本，破坏外壳契约）。

`candidates[].revision` **可选**：省略（键缺失 / `null` / `""` 三种写法都算）即取 ref 绑定的版本。
`ref` 始终是版本权威 —— 工具在 ref 签发后变化仍被拒，不会被静默升级。

模型**不得自主 unload**：两次成功压缩之间，已披露的 schema 只增不减；清空点只有一次成功的
上下文压缩（`resetCacheEpoch`）。

---

## 4. 会话状态机（整个插件的核心）

`state.mjs` 维护四张表，彼此职责严格分离：

| 表 | 含义 | 何时清空 |
|---|---|---|
| `selected` | **执行授权**：模型显式选定且身份重算通过的版本 | 撤权/定义变化立即作废；成功压缩清空 |
| `advertised` | **已披露凭据**：这一轮出站请求真的把该 schema 投给模型了 | 换版本即作废；成功压缩清空 |
| `frozen` | **披露缓存**：逐字 wire + 首次披露次序 | **只增不改**，成功压缩才清 |
| `invalidated` | 作废原因，供状态视图解释 | 同 selected |

外加 `epoch`（缓存周期号）、`lastAppliedSeq`、`integrity`（applied / duplicatesIgnored /
outOfOrderIgnored / gaps / rejected / coldCandidateRestores）。

### 关键不变量

1. **`frozen` 与 `selected` 分离**是缓存命中率的命门：`selected` 随时会因撤权作废，
   而模型上下文里已经投出去的那份 schema 不能因此变形 —— 否则一次 prefix 就废了。
2. **披露顺序只由首次披露次序决定**，绝不交给宿主字典序（先载 z 再载 a 必须得到 `[..., z, a]`）。
3. **回执不自证**：从 canonical `tool/call` 重算输入路径、从当前绑定重算
   `name/toolId/revision/schemaDigest/skillRevision` 五字段，任一不等则整批不提交。
4. **执行放行 = mode ready ∧ 已选定 ∧ 已被当前请求披露且版本一致 ∧ registry 仍解析得到**。
5. **投影只减工具，门禁只加拒绝**，两者都不能授予权限。
6. **资格代次只在目录身份真的变了才升**（本轮新增）：无关工具热注册不得作废在途 ref / 游标。

---

## 5. 一次请求的完整链路

```
模型请求
  └─ system-prompt/assemble（await next() 之后）
       ├─ 冷恢复未落定 → await whenReady（仍在恢复 = 不发请求，无超时兜底）
       ├─ 可信基线 pending/blocked → 不发请求
       └─ 投影：常驻基线（三入口 + 框架保留 + 常驻工具）+ 披露段（frozen 按次序追加）
  └─ 原生出站 tools = 投影结果 → provider
  └─ canonical request/header 观测 → recordAdvertisement（唯一的 advertised 来源）
  └─ 模型调用工具 → tools.guard（同步，只加拒绝）
  └─ tool_load 结果写回 canonical tool/result → applyCanonicalPair → reducer → selected
```

**冷恢复的两个坑（已在代码注释里写死）**：宿主 assemble 先于异步恢复完成（所以要 await）；
宿主的 pre-step 自动压缩发生在 assemble **之后**却仍返回旧 assembly（所以要留
`refreshPendingProjection` 就地 splice 刷新）。

---

## 6. 恢复与可信周期（最复杂的一段）

- **真相是日志**：本插件成功 load 的 canonical `tool/call → tool/result` 对就是可恢复 journal。
  冷恢复必须**先订阅缓存新事件、再读 query 快照**，按 seq 折叠合并去重后才切 ready。
- **恢复缓冲是按时长有界、不是按时长与大小**：读快照期间到达的事件必须留着，
  一旦进入"没有读者"的状态（bootstrap 分支 / fail closed / dispose）必须**显式**关掉。
- **fork 不继承能力状态**：只折叠 fork 自己拥有的段（`ownSeqStart` 边界）。
- **compaction 不是授权**：`resetCacheEpoch` 清空 selected/advertised/frozen 与本会话未决预留。
- **trusted-epoch**：常驻工具名单必须由宿主 storage domain 里的 durable 记录背书，
  冷恢复时不再用 request/header 内容反推。缺记录 = 明确报错并停止发请求，
  旧会话只能经一次真实用户 `/compact` 迁移。

---

## 7. 问题清单与本轮处置

> 排序依据是"是否影响功能逻辑成立"，安全边界一律排最后。
> **状态口径**：`已修` = 本分支已改且有新增单测钉住；`未修` = 明确不做；
> `待他人复核` = 涉及边界，按 CONTRIBUTING 不可由本轮作者签核。

### ✅ 已修（7 项，含 4 份新增单测）

**P0-1 · 新会话的恢复缓冲永不释放 → 会话期内存单调增长**
`journal.mjs` 的 `buffering` 原先只在 `restore()` 成功或 `dispose()` 时置 false，
而 `lifecycle.ensureRuntime` 的 bootstrap 分支（`session.seq === 0`，即**每个新会话**）
从不调 `restore()` —— 于是每个 `session/event`（含带完整出站工具表的 `request/header`）
都留进一个永远没人读的数组。现新增幂等的 `stopBuffering()`，在 bootstrap 分支、
fail closed 与 dispose 三处显式关闭，并把文件头那句"读起来像有界"的注释改成实情。
钉在 `tests/unit/journal-buffering.test.mjs`（6 例，做过 red→green 反证）。

**P0-2 · 任何无关工具注册都会作废所有在途 ref 与游标**
`refreshCatalog` 原本无条件升 `eligibilityGeneration` 并 `dropForEligibility`，
而宿主对**任一 scope** 的 register/dispose/restrict 都广播 `tools/change`。
现改为**按内容判定**：先算绑定集的身份指纹（顺序敏感，口径与 `buildEntry` 派生身份
所用的字段完全一致），指纹相同就直接返回 —— 不重建目录、不重建索引、不作废 ref、不动会话。
真变更走的仍是原来那条路（升代次 / 失效 / 取交集）。450 绑定实测**快路径 1.64 ms vs 重建 15.7 ms**。
连带补上 `catalog.orderDigestByView` 缺失的 **`available:all`** 摘要 —— 否则
`category:'all'` 的游标会一直绑定常量 `'empty'`，修完代次 churn 就立刻变成真洞。
`engine.handleList` 的 available 视图改为复用 `orderedNamesFor`，使**翻页顺序与游标摘要同源**。
钉在 `tests/unit/catalog-refresh.test.mjs`（13 例，逐字段 + 顺序 + 同口径 + 变异反证）。

**P1-3 · `cancelOperation` 没有任何生产调用点**
现由 `journal.abandonLiveCalls()` 在**有证据的丢弃路径**上调用：fail closed 与 dispose
（`settleCompactionEnd` 刻意不调 —— 下一行的 `resetCacheEpoch` 已经收了本会话的 pending，
再调一次会让"谁负责关"变得不可读）。见下面"未修"那条关于中断轮的说明。

**P1-4 · 中文检索基本不可用**
`documentTokens` 的 `categoryTokens` 原先只分词英文类别 id，而条目摘要是外部描述、
实际多为英文 —— 中文查询唯一能搭的桥是那张受控同义词表，不在表里就是零命中
（实测 `读取文件内容` → 0 条）。现把**每个受控类别在所有支持语言下的标题与摘要**
并入该字段（索引按集合构建、与 locale 无关，中英检索共用一份）。
实测中文目标查询 9/9 落到正确类别。
另：`engine.handleSearch` 原本在字节预算判定**之前**就发 ref，被预算挡掉的候选仍占着 ref；
现改为预算通过后再发（用等长占位符保持记账字节与真实 ref 逐字等价）。

**P1-5 · 同义词证据压过直接名称证据**
`read file contents` 原本让 `grep`（12.00）压过 `read_file`（12.00，靠名字序 tiebreak）。
现规定：**文档名称零命中时，同义词得分减半**；名称已有命中的保持原满分，
因此既修正了排序，又不移动任何既有排序。现测 `read_file=14.00` 领先 `grep=10.00`。

**P2-6 · 「revision 可选」只落了一半**
行为层（`protocol` / `engine` / `state`）早已实现，这轮把**周边**对齐：
模型可见的 `tool_load` description、`protocol.mjs` 的 JSDoc 类型、
`docs/01 §5.4` 与 `docs/02` 的接口与示例、`constants.mjs` 里两个叠在一起的 JSDoc 块。
并把真实的线上边界修掉：`revision` 现在接受**键缺失 / `null` / `""`** 三种"未给"写法
（模型对可选字段最常见的就是后两种），仍拒数字/对象/数组/布尔。
关键是**丢弃该键**而不是把 `''` 透传下去 —— `engine` 用的是 `item.revision ?? rec.revision`，
`??` 抓不到 `''`，透传会把每一次空串都变成 `STALE_CANDIDATE`。
钉在 `tests/unit/load-revision-optional.test.mjs`（9 例，含 stale 反例）。

**P3-9 里的两处小修**：`ENGINE_DISPOSED` 取错了表层级（该键在表里是顶层而非 `error` 下），
dispose 后的拒绝文案原本是 `undefined`；`toDomainError` 原先回落英文而 `DomainError`
构造器回落界面语言，同一次失败可能中英混排 —— 现统一为回落绑定语言。

### ❌ 未修（明确不做，需要一个本仓库无法提供的事实）

**被中断的那一轮 `tool_load` 仍会永久占用预算槽。**
turn 被取消（用户 Esc / 审批被拒 / post-policy 失败）时宿主不产 canonical `tool/result`，
journal 此后再也看不到这次调用：`liveCalls` 条目不删、`cancelOperation` 不触发、
`pendingLoadNames()` 会一直告诉门禁"pending fold"（与事实相反的措辞）。
仓库里唯一带证据的相邻事件是 `turn/end`，但
`contracts/gate-runtime-contract.mjs:302-307` **只证明了正常完成时会记录它**，
没有证明它不会与迟到的 `tool/result` 竞态。在 `turn/end` 上取消有把一次合法晚到的折叠
误判掉的��险（工具会卡在 `TOOL_NOT_ADVERTISED`），那比泄漏更糟，因此不猜。
**需要**：宿主对 `turn/end` 与 `tool/result` 在中断路径上先后关系的可核验说明。
拿到之后修复很小：`onEvent` 里一个 `turn/end` 分支调 `abandonLiveCalls()`。

### 🔍 新发现（尚未处置）

- **`STALE_CANDIDATE` 基本不可达。** 定义在 ref 签发后变化时，升代次会先把 ref 作废，
  于是结果是 `CANDIDATE_UNAVAILABLE` 而不是 `STALE_CANDIDATE`。两者都是拒绝、都不升级选择，
  但错误码与 `recovery` 指引给模型的是不同信号。这不是本轮引入的，属既有语义。
- **中文只能定位到"类"，定位不到"具体哪个工具"。** 工具名是原生英文、摘要是英文，
  `读取文件内容` 会把 files 类几个工具打成同分再按名字序 tiebreak。
  要修需要**每个工具的中文可描述**（catalog / adapter 层），不是检索层能单独解决的 ——
  与下面"技能从未接线"是同一类缺口。
- **`tool_list {}`（不带参数）直接报错。** `view` 缺省是 `available`，而 available/loaded
  强制要求 `category`，于是模型最自然的首次调用落到 `INVALID_ARGS`。
  与其让模型猜，不如让 `view:'categories'` 成为缺省。
- ~~**`SYNONYM_GROUPS` 有两个重复触发词**（`search engine`、`spreadsheet` 各自在同组内出现两次）。~~
  **已处置（2026-10-07 晚）**：两处重复已删除（同一触发词 → 同一概念，删除不改变行为；349 单测 + 108 组合全过）。

### 🔐 待他人复核（不可由本轮作者签核）

本轮改动碰到 `plugin/domain/` 的 load/unload 状态机与资格代次失效面
（`refreshCatalog` 的内容判定直接决定旧 ref / 游标是否仍然有效），
按 CONTRIBUTING「作者不签自己的安全边界」，这部分需要非作者复核。
需要重点看的两处判断：
1. 身份指纹的**字段口径**是否与"下游真正会读的东西"完全一致 ——
   本轮已把**派生类别**与**技能正文**补进指纹（它们决定 `orderDigestByView` 与
   `searchDocumentId`），并加了"预判侧从原始绑定跑 `classifyBinding`、快照侧从条目读
   `categories`"的同口径断言。
2. 快路径下**不做**会话失效是否总是安全 —— 当前仅在指纹逐字相同时早退。

### ⚪ 未修（本轮不在范围内）

- **六项产品能力里"工具技能加载"在生产中从未接线**：`registry.mjs` 无条件 `skill: null`，
  于是每次 `tool_load` 的 `skills` 永远是 `[]`、`skillRevision` 永远是 `'none'`、
  `skills.mjs` 整条链路是死代码 —— 但 `docs/01 §1.2` 把它列为六项能力之一。
  要么接上（可信配置里按工具给使用指导），要么在能力清单里显式划出去。**这是产品决策，不是 bug 修复。**
- **死导出清理**：`registry.toolIdFor()`（无人调用，且每次调用都重跑整个 `bindingsFor()`）、
  `catalog.sameOrderDigest`、`protocol.toErrorEnvelope`、`NO_MATCH` 码元数据。
  其中 `isListView` / `navigationFootprint` / `hasNameConflict` / `orderedNamesFor` 有单测在用，**不是**死代码。
- ~~**`docs/01 §1.3` 说的"倒排索引"实际不存在**（全量线性扫描）。~~ **已跟上（2026-10-07 晚）**：
  `docs/01 §1.3` 与 §5.2 的"倒排索引 / 倒排项"措辞已改为与实现一致（token 集合 + 有界线性扫描打分）。
- **`engine.mjs` 两套 locale 取值通道**（模块级 `t()` 绑全局 `domainText`，
  被 `const text = createText(config.locale)` 遮蔽）。生产里同源所以一致，
  但谁只构造引擎不调 `setDomainLocale`，拒绝文案就会退回英文。属重构，不在本轮。

---

## 8. 性能：域内热路径仍然不是瓶颈

| 路径 | 实测 |
|---|---|
| `tool_list` available（全类别 400 工具） | 0.046 ms/次 |
| `tool_list` categories | 0.003 ms/次 |
| `tool_search`（有命中） | 0.119 ms/次 |
| `refreshCatalog`（N=450） | 重建 15.7 ms → **内容未变的快路径 1.64 ms** |

真正值得动的从来不是**单次成本**，而是**调用频次与无界增长**：

- `refreshCatalog` 原本每次 `tools/change` × 每个活动会话各来一遍 —— P0-2 修完后
  内容没变就是 1.6 ms 的空转，不再作废 ref、不再 15.7 ms 重建。
- `journal` 恢复缓冲按**时长**而非大小有界 —— P0-1 修完后不再无界增长。
- `registry.mjs` 的 `generations` / `lastSeen` / `bindingState` **仍不清理**：
  `retireAbsent` 只把值改写成"缺席"而不删键，进程期内 (scope × tool) 组合只增不减，
  子代理频繁起落时会缓慢泄漏。未修。
- `journal.recordAdvertisements` 每个 `request/header` 都要重建 `allowed`、
  全量遍历 `state.selected` 并新建 `byName` Map —— 随目录规模线性增长。未修。
- `index.mjs` 的 `refreshToolChoices()` 在**每个会话的首个请求**同步触发（`ensureRuntime`
  → `onRuntimeCreated`），每次都要走全局视图 + 所有会话的完整目录，并让
  `settings.invalidate()` 重新序列化整棵 Config schema 树。未修。

---

## 9. 建议的下一步顺序

1. **非作者复核**本轮碰到的边界面（资格代次失效 + 指纹口径），这是发布前的硬门槛。
2. **拿宿主事实**收掉"中断轮的 `tool_load`"那条 —— 需要 `turn/end` 与 `tool/result`
   在中断路径上的先后关系说明。拿到之前不动。
3. **产品决策**：技能是否接线、中文工具描述从哪来（同一条链路，一起想）。
4. 清理轮：死导出、registry 三张表的清理、`tool_list` 缺省 view（~~`docs/01` 的"倒排"措辞~~ 已于 2026-10-07 晚改完）。

> 明确**不在**范围：任何进一步的安全边界加固。功能闭环之前不加新门禁。