# 08 · 可信周期基线（Trusted Epoch Baselines）

> **状态：WIP / 契约与验收计划**。本文件描述的是**计划中的产品行为与边界**，以及要满足它
> 所需的验收判据。**实现、测试与验收均未完成**，本文件不表示缺陷已修复、不表示测试已通过、
> 不表示已部署或已生效。凡涉及源码现状的表述，只在标注「现状」处成立。
>
> 冻结协议常量、预算表与错误码见[02](<02-protocol-and-data-model.md>)，发布门槛见
> [03 §11](<03-implementation-and-acceptance.md>)，总状态见[05](<05-current-status.md>)。

## 0. 当前配置边界（2026-10-08）

本文件以下持久化契约和历史复核结论限定于**显式启用**的严格模式，不再是默认行为。主会话由 `requireTrustedEpoch: true` 控制（默认 `false`）；宿主运行时拥有的子代理还必须显式开启 `requireTrustedEpochForSubagents: true`（默认 `false`）。两项都走普通 Loader 重挂载。默认子代理使用配置基线，不因缺记录要求用户 `/compact`；显式启用子严格模式仍可阻断旧子会话，而子代理无法自行代替用户压缩。

子代理身份以 SDK Agent 注册表的实时所有权判定，既有 fork 血缘或可伪造 header/meta 不授予豁免；作为顶层恢复的 fork 会话仍按主会话处理。未知身份不获得子代理豁免。

默认模式不访问可信周期存储、不合成 trusted 记录，诊断基线为 `disabled`；常驻集合来自周期开始时的配置快照，而不是历史请求头。`initialToolsEnabled`（默认 `true`）可关闭手动初始注入；独立的 `alwaysAllowPresetTools`（默认 `true`）保留当前实际绑定 preset 修订自身登记且原生可见的工具。合并后的名单和这两项开关在新会话/成功压缩边界采用；严格模式把合并名单持久化，不从全局设置目录或会话 header 推断授权。canonical load、资格、协议、历史损坏与执行校验不变。默认模式不保证冷恢复时复用严格模式的 durable 名单。

当前开关回归见[可选设置组合门禁](<../tests/composition/gate-optional-settings.test.mjs>)、[全局目录与 preset 门禁](<../tests/composition/gate-global-tools-preset.test.mjs>)、[子代理开关与真实 fork 门禁](<../tests/composition/gate-subagent-epoch-option.test.mjs>)；下文旧审查发现仍按原严格模式范围保留，不能因为默认关闭而视作已经修复。UI 浏览器渲染/在线部署未验收。

### 0.1 可选设置边界的独立交叉复核概述（2026-10-08）

本轮可选设置实现另获两份**非作者**独立报告，各自按六项建议范围做**限定**复核，结论只覆盖这六项，**不是**全 feature 或产品验收，也不声称与任何外部模型的通用能力对等：`plugin/audits/release-security-pro-20261008.md`（MiMo-V2.6-Pro，六项有界签署通过；独立复跑 502 项测试 + 4 组 30 项断言探针 + 真实 SDK 只读核对）与 `plugin/audits/release-security-grok-20261008.md`（Grok4.6，六项在具体维度通过；自建 9 unit / 6 composition 反例 + 相关 49 unit / 17 composition）。主代理核对两份报告的 9 个生产文件 SHA256 与当前树一致，并复跑上述探针与反例全部 exit 0。

六项为：登记目录 partial/unknown 不虚假判不可用、preset 只取实际绑定修订 ∩ 原生可见、只在周期边界采用且已发送数组不被改写、子豁免只认运行时 live 所有权、主/子 AND 与真 Loader remount 及坏历史/回执/原生 deny 保留、guard/projection 两模式切换无 fail-open。**非缺陷观察项**（本轮未改产品）：`initialSelectionView` 的输入合同是归一 meta 而非 raw `schema.meta` 且无生产调用方、`unknown` 行的 `available:false` 字段外观语义、`tools.view()` 无 try/catch 的 fail-closed 方向、以及 `isRuntimeSubagent` 对 SDK `list()/roots()` 对象同一性的耦合。**未覆盖**（保留为未覆盖项）：浏览器 DOM/视觉、外部真实 provider wire、跨进程所有权、所有权原地 re-parent、私有质量集、线上安装与完整产品验收；Grok 的 `CX-C6` 只自造历史，真实冷恢复 + 默认坏历史由 MiMo 探针 3 补证。口径细节见 [05 §0.4](<05-current-status.md>)。

下文（§1 起）的持久化契约、历史审查发现与「仍未闭合」结论**按其原范围原样保留**：它们针对显式严格模式，**不因**这份可选设置复核而上抬或补签。

## 1. 要解决的问题

工具常驻名单（alwaysVisible 派生的 `alwaysNameSet`）在**冷恢复**时，曾被允许从**出站日志**
反推：如果持久化历史里某一轮的 `request`/`header` 多出了一个工具名，恢复后就把它算作本会话
的常驻项，而执行门禁对 `alwaysNameSet` 中的名字**早退放行**。于是「模型猜一个名字」就可能
真正执行，**不经过** canonical `tool/call → tool/result` 折叠，也没有任何可信的持久记录为其
背书。出站日志是**观测**，不是授权事实；这是本项要移除的根本授信来源。

## 2. 目标行为（契约）

### 2.1 授权只来自官方 storage 的周期记录

- 可信事实一律读写**官方 storageDomain** 中的**周期记录（epoch record）**。记录是**常驻
  baseline 的授权事实**。
- **被移除的授信来源**：常驻 baseline **不得**从 `request`/`header` 的出站内容、也不得从会话
  日志里出现过的**工具名**反推。这一条只针对**常驻 baseline**。
- **保留的授权来源**：**canonical `tool_load` 的 `call → result` 回执链仍然是按需 selection 的
  授权事实**，不受本项影响；事件日志在这条用途上照旧是可信的。移除的只是「把出站名字当常驻」。
- 记录形状至少包含：本周期标识、该周期的工具名集合，以及使其可校验的上下文锚点（会话 / 周期）。
- **新会话**（判定见 §2.2）的首个出站请求，必须在该记录**持久写入完成之后**才允许发出。
- **已可信的会话**在后续周期更新时，同样必须**持久写入完成后**才放行出站请求。

### 2.2 「新会话」的判定

新会话 = **本会话自有历史中没有任何出站记录与工具状态**。它**不是**「seq === 0」，也**不是**
「epoch 为 null」；这两者都不足以判定，因为它们在既有会话的早期阶段同样成立。

#### 2.2a 已知缺口：bootstrap 分支目前只信 live 计数（**仍未修；线上未证实**）

> **以下段落是当时独立复审的原始记录**（含「`session.seq` 语义尚未核实」一句），按审查快照
> 原样保留、不改写；**当前的语义纠正与更准确的定性见 §2.2a-1 / §2.2a-2**，冲突处以后者为准。

独立复审（`plugin/audits/trusted-epoch-fix-review-20261007.md` F2，MEDIUM）查明：当
`noOwnHistoryPossible(session)` 为真时，`lifecycle.mjs` 直接进 `resolveBootstrapBaseline`，
**从不调用 `journal.restore()`**。于是两道本该兜底的检查都不跑：

1. `journal.mjs` 里「扫描 own 段并置 `ownOutboundSeen`」的存储扫描；
2. `journal.mjs` 里 `inheritedEventCount` 的 **live 值 vs `query.readSession()` 值**交叉核验。

因此 `hasOwnOutboundHistory()` 退化为「本进程激活以来观测到的出站事实」，而
`noOwnHistoryPossible` 退化为「对 live `session` 计数器的一次**信任**」。复审用内存 harness
**实证**：一个存储里有 4 条真实 own `request/header`、而 live 报 `inheritedEventCount === seq`
的会话，拿到 `initial` 记录并被授权（`seq === 0` 的变体同样成立）。

**为什么是缺口**：恢复路径**明确不信任** live 的 `inheritedEventCount`，专门为此做了交叉
核验；bootstrap 路径是**唯一一处单独信任 live 值**的地方。两套标准不一致。

**可达性未证实**：该情形要求宿主报告一对**自相矛盾**的 `session.seq` / `inheritedEventCount`。
真实 DSH 宿主的 `session.seq` 语义**尚未核实**，故本项目前把它记为**契约级缺口**，
**不是**已证实的线上漏洞。
（`session.seq` 的实现本身已按 §2.2a-1 现读确认；**仍未核实的是宿主能否产生与该实现相矛盾的
计数**，以及 live `Session` 对象是否可能陈旧。）

**本轮不修**：修它要改 bootstrap 的授权判据本身（新增一次存储侧交叉核验），属设计变更；
且可达性未证实，不凭推测改安全边界。倾向的修法记在审查报告 §6.3。

##### 2.2a-1 语义纠正（2026-10-07，仅文档；宿主 Core `0.2.1-alpha.1` 现读）

上面第 (1)(2) 两项此前被读成「只要让 bootstrap 也走一遍 `journal.restore()` 就能兜住」。按宿主
**现读**源码，这个读法不成立，缺口的性质需要改写：

1. **`query.readSession()` 不是存储侧的独立事实。** `dsh-session-query` 的 `readSession`
   （`lib/index.js:1079-1087`）先调 `corpus.load`，而 `load`（`:126-155`）**live 优先**：命中
   `ctx.sessions.get(id)` 就直接 `snapshotLive(live)`，其 docstring 自述「A known live target never
   consults persistence」；`snapshotLive`（`:300-306`）回传的 `inheritedEventCount` 正是
   `session.inheritedEventCount` —— **同一个对象的同一个字段**，`events` 也来自该对象的
   `snapshotEvents()`。`readSession` 末尾那次 `Session.create(...)`（`:1081`）只做**重放校验**，
   返回值仍来自那个 live 快照，其 docstring 亦自述「without making it live」。
   **推论**：在「`corpus.load` 与 `journal` 拿到的是**同一个 live 对象**、且
   `session.inheritedEventCount` 在这段 await 窗口内**稳定不变**」的前提下，live 会话上
   `journal.mjs:617` 的边界交叉核验在同一对象上形同 `x !== x`，不会触发；**当 `corpus.load`
   走持久化分支，或 `agent.session` 与 `ctx.sessions` 里的对象/边界确实不同时，该比较仍可以有
   内容**。这两条前提**未在全部路径上证成**：对象可能不同、该 await 窗口内字段也可能改变，
   本轮**尚未全排除**（见 §2.2a-2）。因此这是**有条件**的结论，不是「该检查在所有形态下都无效」。
   **单加一次 `readSession` 不能证成「独立的存储侧交叉核验」** —— 第 (2) 项的问题首先是**没有第二个
   信源**，不是「restore 没跑」。
2. **第 (1) 项在闸门放行的会话上结构性空转（有条件）。** `noOwnHistoryPossible`
   （`lifecycle.mjs:352-356`）为真只有两种形态：`seq === 0`，或 `boundary >= session.seq`；
   两种下 own 段按定义为空。宿主侧 `Session.seq` 是 getter `SessionLogOffset(this.log.length)`
   （`dsh-session/lib/index.js:1401-1403`，自述 `seq = log.length` 连续性契约），`isOwnSeq`
   （`:1397-1398`）以同一 `inheritedEventCount` 为 own 段下界。restore 读到的又是同一份 log，
   因此在**同一对象、且两次读之间没有 own 事件进入**的前提下，「扫描 own 段置 `ownOutboundSeen`」
   对被闸门放行的会话恒为 no-op —— **跑了也一样空**。**该前提未在全部路径上证成**：闸门内部是两次
   独立读（`:353` / `:354`），其间若有 append 到达，own 段就不再为空；空 own 段的推论因此只覆盖
   「两次读之间没有 own 事件进入」的形态。
3. **一条真实路径的实读（非全称证明）**：真实 Loader 单路径探针（host-only，exit **0**）显示
   `agent.session === ctx.sessions.get(id)` 在 create 与 after-turn 两个观察点均为 `true`，
   `query.events.length === session.seq` 且 boundary 相同（created：seq 0 / boundary 0 / events 0；
   after-turn：seq 12 / boundary 0 / events 12、own 出站 1）。**这只覆盖这一条真实路径**，
   既不是所有路径的证明，也不构成独立读盘证据；脚本与日志在私有目录，**不随本文档集公开**。
4. **不得复制的旧错误**：旧报告把「`sessionQuery` 缺席 → 全新会话 bootstrap 变成回归」算作候选
   修法的净效果代价，该形态在真实组合里**不成立**：`apply.inject` 含 `'sessionQuery'`
   （`index.mjs:486-494`，快照 `1049d47`），该服务不可用时宿主**不调用 apply**、组合不激活
   （`gate-adapter-recovery.test.mjs:87-101`，L11a）。

##### 2.2a-2 缺口的当前准确表述

bootstrap 快路径依赖的是一条**契约**：「live `session.seq` / `inheritedEventCount` 就是该会话**当前的
完整逻辑事件历史**」。注意措辞是**逻辑**历史、**当前**值，**不是**「完整持久化历史」：宿主 append
**不阻塞 I/O**（`dsh-session/lib/index.js:1405-1408` 自述「never blocks on I/O」，持久化由插件
异步缓冲），所以 **live 内存态与 durable 介质态在任意时刻都可能不同**，live 计数只声称覆盖内存里
那份完整日志。该契约由 `Session.log` 的连续性契约与 `snapshotLive` 的**同源**回传共同支撑，但
**没有第二个信源去核验它**。**live `Session` 对象是否可能对 `ctx.sessions` 陈旧、从而使该契约被违反，
仍未全证**（上面那条探针只覆盖 create 与 after-turn 两个观察点，且只覆盖一条真实路径）。

本节因此**保持**「契约级缺口、线上未证实」的定性：它**不是**已证实的线上漏洞，也**不是**已修复。
真正的补法是引入一个**独立于 live `Session` 对象**的持久化事实或显式核验路径，属设计变更；本轮
**不改授权行为**，不凭推测改安全边界。

> **行号口径**：本小节引用的 `lifecycle.mjs` / `journal.mjs` / `index.mjs` 行号基于快照
> `1049d47`；同期作者正在改 `lifecycle.mjs`，**行号可能已移位**，引用时请按符号名核对。
> 支撑用的私有调查、探针脚本与日志在私有目录，**不随本文档集公开**，本节只保留结论摘要。

### 2.3 持久写的时点

持久写必须落在**下一轮 agent 的 pre-step 屏障**上（post-next 等待），使「写完再放行」覆盖到
`assemble` 之后才发生的新写入。
理由是次序：**SDK 的 `assemble` 阶段先于自动压缩发生**。若实现只在 `assemble` 处等待持久化，
而 pre-step 随后才开启新写入，首个请求仍会在记录落盘前**抢跑**；只有把「写完再放行」的等待
放到 pre-step / post-next 屏障上，屏障才真正拦住这个竞态。
在**成功压缩之后**写入新周期记录是**正确**的（见 §2.6）；本节要的不是排除这个时机，而是让
post-next 等待覆盖到 `assemble` 之后才开启的那次新写入。

### 2.4 旧会话（严格模式下缺少周期记录）

- 缺少周期记录的既有会话：**明确报错并阻止请求**。不得猜测、不得按当前配置重建、不得默认放行。
- 这是一个**显式错误终态**：**没有默认超时**，也不会降级为「缩水请求」（即只带发现入口的请求）。
- 当前配置的哈希**不得**被当作 epoch 标识或可信判据。
- **「缺失」本身不构成建立初始记录的资格。** 唯一资格判据是 **own 段没有任何真实出站/
  工具事实**（§2.2）。own 段已经出过站的会话即使因为**存储迟到到位**而走到
  「读 → 缺失」的路径，也**不得**被补建初始记录：那会把「观察到的存储可用性」当成
  「用户迁移过」的替身，正是本项要移除的那类授信。它只能等本次真实用户 `/compact`。

### 2.4b 与「既有 fail closed」的边界裁决（本轮补充）

下面两种终态**都停止请求**，但**原因不同，处置也不同**，绝不能互相冒充：

| 终态 | 触发 | 请求 | 处置 |
|---|---|---|---|
| `STORAGE_UNAVAILABLE` / `MISSING` / `INVALID` | **可信基线**不可授权 | **0 request** | 见 §2.4 / §2.5 |
| `SESSION_FAILED_CLOSED` | 会话因**与可信周期无关**的既有原因 fail closed（journal 自身损坏、`readSession` 失败、严重 seq 不连续） | **请求照发，只带基线**（引擎仍 incompatible） | 既有 fail-closed 语义原样保留 |

- 后者是本模块出现**之前**就有的语义（见 `L11b` / `RB2`：请求照发、只带基线、执行照拒）。
  把它并进 `BLOCKED` 会凭空多出一条「请求不得发出」的新规则，并连带把同 composition 里
  其它会话的请求队列错位；把它并进 `TRUSTED` 则是谎称名单已可信。因此它在账本里是**独立的
  第四态** `failed-closed`，投影侧照常放行这一次请求，guard 侧仍按
  `baseline !== TRUSTED` 拒绝每一次非入口调用——**出站与执行两侧的既有判据都原样保留**。
- 落到这一态时**不写盘**，并自增 `revision` 让任何在途写变成 superseded：已经不可能发生
  授权，就不让迟到的写事后复活它。

### 2.4c 存量坏记录与 open 失败的归因（本轮补充）

- **实测**（安装内 `@deepseek-ai/dsh-storage-domain` 0.2.1-alpha.1，真实 JSON backend）：
  存量里存在一条**与 schema 不匹配**的记录时，`facility.open(spec)` 让**整个域**打开失败，
  报 `stored record '<key>' in table 'epoch_baselines' does not match its schema`。这不是
  「存储服务不可用」：provider 健康，只是数据里有一行读不出来。
- 因此 open 失败被再分一层：认得出「schema 不匹配」→ 落 **`INVALID`**（其文案已明确写了
  「不会被覆盖、不会被删除，请人工处置」）；认不出的一律落 `UNAVAILABLE`。
  **诚实降级**：宁可少一个归因，也绝不把未知失败猜成「坏记录」。
- **仍然不做**的事：**不自动删除、不 quarantine、不用当前配置覆盖**坏记录。
- **已修（2026-10-07，分支 `feat/trusted-epoch-isolated-bad-record`）**：上面那条「一条坏记录
  让**所有**会话落终态」的副作用**已消除**。坏记录现在**只**让**它自己**那个会话落
  `INVALID`，同一域里其它记录完好的会话照常 ready、照常出站。**对那条坏记录不删、不覆盖、不
  quarantine**（其它可信记录的正常 `put` 照旧）—— 上面的「不删除 / 不 quarantine / 不覆盖」
  三条原则**全部保持**。修法与判据见 [§5.3](#53-24c-连坐修复2026-10-07)。

### 2.5 迁移（一次性、严格受限）

只有**本次真实的用户发起的 `/compact` 成功**之后，旧会话才允许迁移为可信会话。该次压缩必须
满足下列五条 canonical 链条件，且这些条件是**同一条链、同一会话内的一致性要求**，不是五个字段
各自「存在」即可：

1. 整条链属于**同一个 own session**（不得取自父会话或继承前缀）。链内是**两组各自一致的关联键**，
   不是同一个值：`command/run.commandId` == `start.sourceCommandId` == `end.sourceCommandId` ==
   `done.commandId`；`start` / `summary` / `end` 上的 `compactionId` **另成一组且彼此相同**。
   **`compactionId` 是为本次压缩新 mint 的随机 UUID，本就不等于 `commandId`**，不得要求两者相等；
2. 运行名为 `compact`，来源为 `user`；`start.sourceCommandId` 存在；
3. `start` 与 `end` 的 `turn` 均为 `null`（该次压缩不挂在某个 turn 上）；
4. 恰好产生 **1 条 summary**：其 `seq` 在链内**顺序正确**，且位于 `start` 之后、`done` 之前；
5. `end` 中**没有 error**，链以 `done` 成功结束，且 `done.sourceEventSeq` **正好对应**该条
   `summary.seq`（不是仅等于某个存在的 `seq`）。

任一条不成立即不迁移，且**不重试、不推断**。跨会话拼接、两组关联键各自内部不一致、`turn` 非
null、summary 多于一条或缺失、`sourceEventSeq` 与 summary 不对应，一律视为**未迁移**。

### 2.6 已经可信的会话：不做迁移限制

与旧迁移路径不同，**已经可信**的会话在任何**手动或自动**压缩成功后，仍然采信**最新配置**、
`put` 一个**新周期记录**并 reset 常驻名单。

- **不得**因为自动压缩而阻断正常的周期更新——自动压缩是正常路径，不是例外。
- **同一 epoch 内**：工具名集合**只来自该 epoch 记录自身**。配置刷新**不改写**已写入的 epoch
  记录，也**不拿当前配置去替换**记录里的名单。
- **切换到新 epoch 时**：该新周期的工具名集合**全量采用当时配置的边界快照**，与旧 epoch 的名单
  **不求交**、**不继承**、**不保留**其中任何项。这是一次整份换新，不是逐项合并——契约中**不存在**
  「替换式合并」这种动作，也不允许用交集或并集去拼接两个 epoch 的名单。

### 2.7 不变的既有边界

- **fork 的 own-only 语义保持不变**：继承前缀不折叠、不观测、不授权。子会话要成为可信会话，
  走 §2.2 的新会话路径，而不是继承父会话的记录。
- **模型驱动的 unload 仍然被拒绝**（模型不能自己决定撤掉工具）。
- **显式卸载只撤执行资格，不撤已披露的 wire 定义**：卸载后该工具在**已冻结披露的请求体**中
  仍然保留（wire 定义在 epoch 内冻结），直至该 epoch 以**成功压缩**结束。也就是说本项**不承诺**
  “显式卸载即让工具 schema 从请求中消失”；那不是本项的行为，也不得据此推断。

### 2.8 依赖边界

- 周期记录通过**宿主提供的 storageDomain 能力**读写。该能力作为 **optional peer** 声明：
  宿主已装配 storage 三件套时使用；**未装配时明确报错阻止**，而不是自动挂载任何 provider 或
  自动切换到本地后端。
- 不新增 session 事件类型；**不使用 developer message 承载 storage 语义**。

## 3. 现状（**已初步实现，尚未完成集成验收**）

源码侧已初步落地，本节据此区分**「已实现」**与**「尚未完成集成验收」**：

| 项 | 实现状态 | 验收状态 |
|---|---|---|
| 移除 header / 首请求授信 | **已初步实现** | **未完成集成验收** |
| 周期记录读写（宿主 storageDomain） | **已初步实现** | **未完成集成验收** |
| 新会话首请求前的持久屏障 | **已初步实现** | **未完成集成验收** |
| 旧会话缺记录时明确报错 | **已初步实现** | **未完成集成验收** |
| `/compact` canonical 链迁移 | **已初步实现** | **未完成集成验收** |
| 可信会话的自动压缩更新 | **已初步实现** | **未完成集成验收** |

**「已初步实现」不等于「缺陷已修复」**：它只表示工作区内已有对应源码。**本文件不断言修复成立**，
不引用任何通过数，也不把作者自测结果当作验收结论；集成 / 测试套件整体仍未完成，等全验收后再
去 WIP。

相关门禁文件（均已存在，三者分工不同）：

- [`gate-trusted-epoch.test.mjs`](../tests/composition/gate-trusted-epoch.test.mjs) —— 授权面：
  污染头 / 缺记录 / 缺 provider / 手动 `/compact` 迁移 / 同 root 重启冻结 / **存储迟到
  到位不得补建初始记录（TE-LM）**。其反例判据取自一条**声明式注入**的受污染历史，用于证伪旧实现。
- [`gate-trusted-epoch-io.test.mjs`](../tests/composition/gate-trusted-epoch-io.test.mjs) —— I/O 时序：
  初始 put 被挂住 / 真实自动压缩后的新 epoch put 被挂住 / put 被拒与 SDK 不可用 / pending 期间
  dispose，以及 legacy 会话上的**真实自动**压缩**不得**迁移。
- [`gate-trusted-epoch-fork.test.mjs`](../tests/composition/gate-trusted-epoch-fork.test.mjs) ——
  **真实 fork** 下 baseline 记录隔离：子会话建自己的记录，绝不继承父的名单。

**文件存在不等于判据已通过。** 三者都只出现在需要真实 DSH 宿主的 composition 作业里。

## 4. 验收计划（判据先于实现）

以下为计划中的验收项。**在集成验收完成并复跑之前，任何一项都不得写成「已通过」。**

| ID | 判据 | 期望结果 | 对应套件 |
|---|---|---|---|
| TE-A | 新会话：无自有出站/工具状态，持久写入完成后才允许首个请求 | 首请求在记录落盘后才出站；记录缺失则请求被阻止 | `io` |
| TE-B | 污染历史冷恢复：模型猜测历史中出现过的工具名 | **执行 body 次数为 0**；配一条正常加载路径的正控制证明判据有分辨力 | `gate-trusted-epoch` |
| TE-C | 已可信会话 + 自动压缩成功 | 采最新配置、`put` 新周期、reset；**不被阻断** | `io`（IO2）、`gate-trusted-epoch` |
| TE-D | 已可信会话 + 手动压缩成功 | 同 TE-C | `gate-trusted-epoch` |
| TE-E | 同 epoch 内配置刷新；以及切到新 epoch | 同 epoch：**只读记录自身**的 names，当前配置不替换记录；新 epoch：**全量采用**配置边界快照，与旧名单不求交 | `gate-trusted-epoch`、`fork` |
| TE-F | 旧会话缺少周期记录 | 明确错误终态、**阻止请求**；无默认超时；不发出缩水请求 | `gate-trusted-epoch`、`io`（IO3/IO5） |
| TE-G | 当前配置哈希 | 不得被当作 epoch 标识或可信判据 | `gate-trusted-epoch` |
| TE-H | `/compact` 迁移 | 仅当 §2.5 五条 canonical 链在**同一 own session 内一致成立**时迁移；任一条不成立即不迁移 | `gate-trusted-epoch`（真实用户 `/compact`）、`io`（IO5：legacy 上的真实自动压缩不得迁移） |
| TE-I | fork | own-only 边界不因本项放宽；子会话不继承父记录 | `fork`（真实 fork 隔离） |
| TE-J | 模型驱动 unload | 仍被拒绝 | `gate-trusted-epoch` |
| TE-J2 | 显式卸载 | 只撤执行资格；**已披露 wire 定义仍保留**直到成功压缩，不得据此声称 schema 被移除 | `gate-trusted-epoch` |
| TE-K | 未装配 storageDomain 的生产捕获 | 明确阻止，而不是自动挂载 provider | `gate-trusted-epoch`、`io`（IO3 omitStorage） |
| TE-P | 持久写时点 | post-next agent / pre-step 屏障；**仅在 assemble 等待不足以拦住首请求抢跑**（assemble 先于自动压缩，pre-step 才开启新写） | `io`（IO1 初始 put 挂住、IO2 自动压缩后新 epoch put 挂住） |
| TE-LM | 存储**迟到到位** + legacy 会话 | **不得**补建初始记录（durable 侧无该会话任何记录）；基线仍不可授权；再开一轮仍 0 请求 | `gate-trusted-epoch`（TE-LM） |
| TE-FC | 会话因**与可信周期无关**的既有原因 fail closed | 请求**照发**、只带基线、引擎停 incompatible、执行照拒（既有语义不被 0-request 规则吞掉） | `gate-adapter-recovery`（L11b）、`gate-review-boundaries`（RB2） |
| TE-BAD | 存量记录与 schema 不匹配 | 落 **INVALID**（数据问题）而非 UNAVAILABLE；坏记录**不删不改**；**且不得连坐**——同一域里其它完好会话必须照常 ready 并出站（`08 §2.4c` 末段那条副作用已修） | 单测 TE-U18 / TE-U18b / TE-U4（真实 SDK 行为见 §2.4c 的实测）；组合 `gate-trusted-epoch-badrecord` 的 BR1 与 **BR4** |
| TE-MIG | legacy 会话在**恢复收尾**期间完成迁移 | 恢复收尾**不得**用一次 `load()` 覆盖在途的迁移写；迁移成功后正常出站并落 ready | `gate-trusted-epoch`（TE4b） |
| TE-DP | pending 期间 dispose / 释放闸门 | 释放后**不得复活授权** | `io`（IO4） |
| TE-R | canonical `tool_load` 回执链 | 仍为按需 selection 的授权事实；本项**不**将其移除或降级 | `gate-trusted-epoch`（**TE-R0 / TER1 / TER2**，2026-10-07 补齐，见 §5.4）、`fork` |

「对应套件」列只表示**该判据由哪份门禁覆盖**，**不表示该判据已通过**。

**验收纪律**：

- 每条前置都有独立断言，禁止「取到 undefined 就跳过」式空转；每条安全断言配正控制。
- 与 `07` 同源，受污染历史是**声明式注入**的反例材料，**不得**表述为宿主自然产生该日志。
- 该门禁是宿主相关的（需要真实 Loader 与宿主提供的 storage 模块），因此只在**已具备真实 DSH
  宿主**的 composition 作业中显式列出；它**不进入** CI 的可移植跳过清单，也**不隐式安装任何 SDK**。
- 可移植的 unit / 周期相关单测必须**纯可移植**：不解析宿主 SDK。

## 5. 本项明确不声称

- **不声称**授权缺陷已修复：集成验收未完成，**本文件不断言修复成立**。
- **不声称**任何门禁或回归已通过：本文件不引用通过数，也不断言任何 pass 数字；作者自测结果
  **不等于**验收结论。
- **不声称**真实 provider wire、请求体、性能、GUI 呈现或在线迁移行为已验证。门禁中录到的
  请求对象是 mock provider 侧的装配证据，不是真实 provider wire。
- **不声称**已安装、已发布、已重启或已在产品中生效。包仍未发布到 npm。
- 在集成验收完成之前，[07](<07-lifecycle-recovery-coverage.md>) 与
  [05](<05-current-status.md>) 中的既有结论**保持不变**。

### 5.1 独立复审结论（非作者，2026-10-07）

> **历史截至该轮**：本节按当时快照原样保留，其中的 F3 / F4 状态**不再代表当前**；F3（恢复收尾
> 竞态）的后续修复与限定复核见 §5.5，F4 窄窗口仍未复核。

审查者与产出方不同源，全程只读；报告见内部证据 `plugin/audits/trusted-epoch-fix-review-20261007.md`
（**不随本文档集公开**，按 [README §2.1](<README.md>) 的约定此处只以代码字体写出路径、不建链接）。

**判定：三处修复全部「通过」。** 审查者用内存 harness 直驱真实 `createLifecycle` /
`createProjection` / `createGuard` 做了独立实证，其中最有分量的两条：

- 修复 1 是**结构性**成立：`ledger.begin()` 在产品里**只有一个**调用点，且位于新判据**之后**；
  三个进入 bootstrap 的入口全部经它收口 —— 不变量在唯一的出口上。
- 修复 3 **可证是承重的**：审查者复现了修复前的原始失败（`blocked/MISSING`、**0** 条
  durable 记录、pre-step 抛错），所以它不是空门禁；并额外尝试在 `load()` 的 await 窗口注入
  压缩，**未**复现（`load()` 在入口同步自增 revision，后来的写一律压过它）。

**留下的发现**：F1（门禁未接线，MEDIUM）**是快照过期**，已在审查窗口内由主代理关闭 —— 当前
`package.json` 与 `ci.yml` 都已列入，实跑 101/0 证明接线生效；F2（bootstrap 分支的判据只信 live
计数、对存储侧**没有第二个信源**可核验，MEDIUM；原表述「看不见存储历史」按 §2.2a-1 更正）
**维持原判并已写入 §2.2a，仍不修**；F3 / F4 为 LOW，未复现、不凭推测改。

**仍未覆盖**（审查报告 §4 共 9 项）：其中最值得优先补的是 **TE-R**（canonical `tool_load`
回执链作为**正向**授权源）与 `§2.4c` 的整域 open 失败。**TE-R 已于 2026-10-07 补齐门禁
（见 §5.4），并已获**限定范围**的专项复核；`§2.4c` 的整域 open 失败已于同日由另一分支修复（见 §5.3，
已获**限定范围**的非作者复核，未替 TE-R 补签）。真实 provider wire、token/TTFT、
性能、GUI 生效、在线迁移仍**未验证**。

### 5.2 工作区复跑记录（**不是验收结论**）

以下是**本轮改动者**在工作区内的独立复跑记录。按 §4 的验收纪律，**作者自测结果不等于验收
结论**：这些都是**产出方本人**跑的，因此**不得**据此把任何一条判据写成「已通过」，也**不**
解除任何一项待办的独立复审。

**本节截至 `0.2.0-functional.3`**；其后两轮（`0.2.0-functional.4` 见 §5.4、`0.2.0-functional.5`
见 §5.3）各自成节。下方事实按当时源码原样保留，不按当前源码改写。

| 范围 | 命令 | 结果 |
|---|---|---|
| 单元 | `npm test` | **283 pass / 0 fail / 0 skipped**，退出码 **0**（`.probe/final4-unit.log`） |
| 组合（13 份门禁） | `npm run test:composition` | **103 pass / 0 fail / 0 skipped**，退出码 **0**（`.probe/final4-comp.log`） |
| 质量验证器 | `node plugin/quality/validate.mjs` | **20 PASS / 1 FAIL**，退出码 **1**（冻结数据的既有类别资格项，**与本项无关、未改动**） |

**仍未完成、不得上抬的部分**：

- **三处修复已获一次非作者独立复审「通过」**（见 §5.1）。但复审**仍有 9 项未覆盖**，且
  `TE-R` 与 `§2.4c` 整域 open 失败在优先补齐之前，**不得**把本项整体写成「已验收」。
- 真实 provider wire、token/TTFT、检索质量门槛、L04 compaction、L08 crash/fsync 窗口、
  L10 HMR、S12/S13、GUI 生效与在线迁移：仍**未验证**。
- §2.4c 末段那条「一条坏记录拖垮整个域」的副作用**未修**，只是被如实记录并给了诚实归因。
- 本轮源码**已提交并以 PR 形式提交评审**；**未安装、未发布到 npm、未重启**，任何宿主
  profile 与 GUI 生效状态均未变。本轮源码版本为 `0.2.0-functional.3`。

### 5.3 §2.4c「连坐」修复（2026-10-07，分支 `feat/trusted-epoch-isolated-bad-record`）

**这一轮改了产品源码**：[`trusted-epoch.mjs`](../adapters/dsh/trusted-epoch.mjs) 一处，外加门禁
与单测。它修的是 §2.4c 末段那条此前如实记录为「未修」的副作用。

#### 缺口到底是什么

`BR1` 只种了**一个**会话，因此从未覆盖这件事：SDK 在 `facility.open(spec)` 里对**每一条**存量
记录跑 `tableSpec.valueSchema.parse(raw)`，**任何一条**抛错就 `throw` 掉整个 `open`
（安装内 `dsh-storage-domain` `lib/index.js:371-373`）。于是「表里有一行读不出来」这个
**局部**问题，被放大成「这个域里**所有**会话都停摆」——包括记录完好、与那条坏行毫无关系的
会话。实测：同一份介质里，被注入坏版本号的会话与未受影响的会话**双双**拿到非 ready 终态。

#### 为什么不能用 SDK 自带的开关

`dsh-storage-domain` 确实提供 `invalidRecords: 'backup-and-skip'`（`defineDomain` 显式支持，
`lib/index.js:69-72`；`open` 里校验失败就 `backupRecord` 后 `continue`）。**本插件用不上**：

- 它要求 unit 实现 `backupRecord`，而那只存在于 **`per-record` 布局**的 unit 上
  （`dsh-storage-json` 的 `PerRecordJsonUnit`）。本 spec 声明 `layout: 'single'`，其
  `SingleJsonUnit` **没有** `backupRecord`，于是 SDK 走到 `unit.backupRecord === void 0`
  分支**照旧抛出**（同一行 `lib/index.js:373`）——**在本布局上是个空开关**。
- 改布局则要同时把 `epochKeyOf()` 的 `JSON.stringify([...])` 键换成 path-safe 形状
  （JSON backend 要求 `/^[a-zA-Z0-9_-]+$/`），那是一次带数据迁移的破坏性变更。

#### 采用的修法：把权威从 SDK 那层移回逐会话校验器

`createEpochSchema` → **`createEpochTransportSchema`**，内容改为 `z.unknown()`：SDK 那层**不再
收紧**，只当传输形状。判据全部回到本模块已有的 `validateEpochRecordShape`（写前自证）与
`validateEpochRecord`（读时逐条校验，并**额外**比对当前 epoch 身份）。

**为什么不损失任何安全性**——逐条核对：

| 面 | 收紧前 | 收紧后 |
|---|---|---|
| 写入 | SDK 不校验；`store.put()` 调 `validateEpochRecordShape` 自证 | **不变**（非法记录仍然写不出去） |
| 读取 | SDK `strictObject` + 纯 JS 校验**双重** | 只剩纯 JS 校验，且它**更严**（key 集合精确相等、`names` 唯一、身份逐字段比对） |
| 坏记录处置 | 不删不改 | **不变**（对那条坏记录不删、不覆盖、不 quarantine；其它可信记录的正常 `put` 照旧） |
| 全局失败 | **有**：一条坏记录 → 整个域打不开 → 所有会话停摆 | **无**：只有坏记录自己那个会话落 `INVALID` |

**唯一的行为变化，正是要修的那条。**

#### 判据（`gate-trusted-epoch-badrecord` 的 **BR4**，判据先于实现）

BR4 在**同一个 composition** 里种**两个**会话，让两条记录都真实落盘，然后只注入**受害者**那一条：

- **BR4a** 受害者**自己**的会话仍必须 `INVALID` + **0 出站请求** —— 本次修复**不放宽**这条；
- **BR4b** 同一份介质里另一条**完好**记录对应的会话必须 `ready` 且**真的出站**
  —— 这才是要修的东西（`settled.mode` 与出站计数都必须成立，`ready` 但没发请求不算）；
- **BR4c** 坏记录**仍在**文件里、**仍是**注入后的原值（BR3 原则不放松）；
- **BR4d** 注入正控：必须证明注入**只**落在那一条上，另一条版本号仍合法。

单测 **TE-U4** 同步重写：它原先把「`valueSchema.__zod === 'strictObject'`」当成契约，现在改为
断言传输层是 `unknown`，**并**断言那些过去由 SDK 那层挡掉的坏记录**全部**仍被纯 JS 校验器挡下
——权威搬家了，就得把权威本身钉住。

**分辨力已用变异验证**：把传输层改回 `z.strictObject(...)` 后，BR4 **转红**。变异已撤销。

**工作区复跑**（**本轮改动者本人**所跑，按 §4 纪律**不是**验收结论）：`npm test` **283 pass /
0 fail**；`npm run test:composition` **104 pass / 0 fail**（+1 = BR4）。

**非作者复核（限定范围，2026-10-07，PR5）**：复核者与本轮改动者不同源，**通过**，范围**仅限**
坏记录隔离修复与本次冲突合并。独立复跑：`npm test` **283 pass / 0 fail**、
`npm run test:composition` **106 pass / 0 fail / 0 skipped**（合并后合并树），文档交叉引用与章节
编号复核无断链。分辨力在**私有副本**上独立复现：把传输层恢复为旧的 `strictObject` 后，**BR4b
转红**（bystander 会话 `mode` 为 `incompatible` 而非 `ready`，exit **1**，日志
`.probe/pr5-parent-mutation-red.log`）；**产品源码未动**，变异只存在于私有副本
（`.probe/pr5-mutation-check`）。上方那条作者自测记录按当时事实保留，不因复核而改写。

**仍未完成**：本次复核**不替 TE-R 专项补签**，也**不是**全 feature 验收；`§2.2a` bootstrap 契约
缺口仍未修；审查其余未覆盖项、`03 §11` 阶段 3（真实 wire / token / TTFT / 检索门槛）、npm 发布与
安装生效**全部仍未完成**，整体仍为 **WIP / 未验收**。本包仍未发布到 npm，本轮源码版本为
`0.2.0-functional.5`。

### 5.4 TE-R 门禁补齐（2026-10-07，分支 `feat/tool-load-receipt-authorization`，`0.2.0-functional.4`）

**合并说明**：本节原为 §5.3，与 §5.3 撞号，故改为 §5.4。

**这一轮只改测试与文档，产品源码一行未动。** 复核结论是：TE-R 要保住的性质**本来就成立**，
缺的是覆盖 —— 因此本节**不**宣称修过任何缺陷。

为什么 TE-R 必须独立成门禁，不能由 TE0 / TE1x 代替：

- TE0 覆盖**新鲜会话**折叠后 `selected` 可观测、body 执行 1 次；
- TE1x 覆盖**常驻名单**（`alwaysVisible` 显式含该工具 → `alwaysNameSet` 早退放行）。

两者都没有把「授权来自**回执链**」与「授权来自**常驻名单**」**拆开**证明。本组用
`alwaysVisible: []`（基线显式置空）把常驻名单这条面整个拿掉，于是该工具能被执行就**只可能**
是因为 canonical 回执链产出了 selection。

| 判据 | 断言 | 反空过控制 |
|---|---|---|
| **TER0** | 置空基线下真实 `tool_load` 折叠产出该工具的 selection，且该名字**既不在** `alwaysNameSet` **也不在** `ledger.names` | 两条否定前置缺一即报错，先判空转 |
| **TER1** | **真重启**（全部服务真关闭 → 同 root 重开 Loader → resume）冷恢复后，selection 必须由持久日志里的回执链**重放重建**，直连执行 `isError:false` + body=1 | 全程基线为空，授权无处可借 |
| **TER2** | 同一冷恢复后的同族隐藏工具（`fixture_hidden_scope`，**从未 load**）必须仍被拒、body=0 | TER1 不得靠「恢复后一律放行」换来 |

两点实现事实（本轮实测所得，值得单独记）：

1. `engine.selected` 是以**规范 toolId**（`global::fixture_hidden_inherited`）为键的 Map，
   **不是**裸工具名。产品自己的授权判据按 `.name` 过滤
   （[`state.mjs`](../domain/state.mjs) `evaluateCall`：`Array.from(state.selected.values()).filter((s) => s.name === ctx.name)`），
   所以门禁也走**同一条**解析路径。此前 TE0 只断言 `selected.size`，因此没有暴露这个区别。
2. 冷恢复里重建 selection 的是 `applyCanonicalPair`（`journal.mjs` 的折叠点），它在 live 与
   restore 两条路径上是**同一段**代码 —— 这正是 TER1 能成立的结构原因。

**分辨力已用变异验证**：把 `journal.mjs` 的 `engine.applyCanonicalPair` 短接（= 整条回执链退出
授权面）后，TER0 与 TER1 **双双转红**，连同既有 TE0 / TE1c。变异已撤销，`journal.mjs` 与 `main`
逐字节一致。

**工作区复跑**（`npm test` **283 pass / 0 fail**、`npm run test:composition` **105 pass / 0 fail**
（原 103，+2），**以下三条截至 `0.2.0-functional.4` 那一轮**，均为**本轮改动者本人**所跑）：

- 按 §4 的验收纪律，作者自测**不等于**验收结论 —— 上述任一判据**不得**据此写成「已通过」，
  也**不**解除任何一项待办的独立复审。
- 补门禁的是本轮产出方本人，按「作者不自签」，它与三处修复的非作者复审是**两件不同的事**。
- `§2.4c` 整域 open 失败、`§2.2a` bootstrap 契约缺口、审查其余未覆盖项、`03 §11` 阶段 3
  （真实 wire / token / TTFT / 检索门槛）、npm 发布与安装生效：**全部仍未完成**。
  本包仍未发布到 npm，本轮源码版本为 `0.2.0-functional.4`。

> **合并后的后续修正**：`§2.4c` 的整域 open 失败已于同日由分支
> `feat/trusted-epoch-isolated-bad-record` 修复，见 §5.3（已获**限定范围**的非作者复核）。

##### 5.4-1 TE-R 专项复核（限定范围，2026-10-07）

**非作者专项复核 + 加强后复核「通过」，范围仅限 TE-R 的门禁与其加强**：基线快照 `1049d47`
加最终门禁（该门禁文件 SHA256 `3FA2A9918D4E489CF72E5864EEA7EFBE2AE1A30AC26BB05D0C6F95810B320401`）。
审查方实测：该门禁文件 **14/14 绿**；掐断冷恢复重放（M2）时 **TER0 绿、TER1 红**，证明 TER1
与 TER0 不冗余；guard 过宽（M3）时在 **TER2** 红；把关闭做成 no-op 的假重启（M4）时在
**TE9 与 TER1** 以 `actual: false / expected: true` 精确红。复核方的三条**测试判据 finding**
（TER1 未钉住真重启、TER2 缺 scope 存在前置与拒因、TE9 的探针可静默跳过）**已关闭**。

**命名澄清**：上述第三条 finding 是**测试** finding（TE9 的释放探针可静默跳过），它与**产品**侧的
**恢复收尾竞态（restore-settlement）**是**两件事** —— 后者**已在其后单独修复并限定复核**，见 §5.5。

**边界**：这是**限定**复核，**不包含**同期并发的 `lifecycle.mjs` 改动与新增 unit 门禁（后者见
§5.5），**不是全 feature 验收**；`§2.2a` bootstrap 契约缺口（线上未证实、未改授权行为）、审查
其余未覆盖项、`03 §11` 阶段 3、npm 发布与安装生效**仍未完成**，整体仍为 **WIP**。

### 5.5 后续工作区恢复收尾修复（限定复核，**未发布**）

**这是 `0.2.0-functional.5` 之后的未发布工作区改动**，`package.json` 版本未变、**不在**任何已发布
条目内。两处关闭的机制：

1. **pending/null 的误裁决**：`load()` / `begin()` 在自己的 await 窗口里被更晚的 live 用户
   `/compact` 的 adopt supersede 时会提前返回 `PENDING/null`。过去调用方只判一次终态就
   `blockBaseline`，于是出现 `reason=null` 的过度反应（名单被清、引擎 fail closed、`restoring`
   提前归 false，而真实状态随后翻转）。现在由跟随最新在途工作的收口逐轮跟到终态。
2. **建档资格判定之后的微任务 TOCTOU**：资格判定为「缺失且有资格」后，若把资格快照交出去、
   外层 `await` 之后才启动 `begin()`，间隙里抵达的 adopt 会被那条过期初始记录 supersede ——
   一次真实的手动迁移被静默回退成 `initial` + 当时的当前配置。现在**决定与启动同处一个同步块**，
   启动后只把 promise 交出去等待；**await 同期最新在途写的 durable 屏障不绕过**，也**未**新增
   ledger API、state、reason 或 timeout。

**证据口径（分清两类，不得混称）**：canonical `/compact` 五条链、微任务调度点与 fake store 都是
**声明式注入的产品代码反例**，证明的是**产品代码在该时序下的行为**，**不是**线上自然时序复现；
`npm run test:composition` 的 **106/106/0 skip** 才是真实宿主 Loader 上的防回归。

| 复核 | 范围与结果 |
|---|---|
| 非作者限定复核（只读快照） | 新增 unit **12/12**、真 Loader 子集 **37/37**；P-H 红→绿；P-A/B/C/D/G 绿（含 3 次连续 supersede、dispose 时在途 load、**不多读一次**、**不**对被 supersede 的写再 `load()`）；私有回退「同步启动」后 LS-U12 **红**（其余 11 条绿），原 legacy 3 红与原 post-begin 1 红仍红 |
| 主代理独立最终复核 | `npm test` **295/295**、`npm run test:composition` **106/106/0 skip**，docs 15 文件 **0 断链**；父级反例由红转绿（`trusted` / `manual` / `parent-cmp@3` / 边界名单，与当前配置 `glob` 不同） |
| 快照指纹 | `lifecycle.mjs` SHA256 `68AFA23071A78AEC…`；新增 unit `D245132120B5C790…`；`trusted-epoch.mjs`（`228ADEC7…`）与 TE-R 门禁（`3FA2A991…`）**逐字未改** |

**仍未完成（不得随本节一并上抬）**：`§2.2a` bootstrap 契约缺口**线上未证实、授权行为未改**；旧的
**F4 窄窗口未复核**；`retryBaseline` 在 `restoring=false` 时沿用上一次的 blocked 归因、维持
**0 request** 的既有窗口**本轮未改**；`03 §11` 阶段 3（真实 wire / token / TTFT / 检索门槛）、
npm 发布与安装生效全部未完成；整体仍 **WIP、未验收**。历史 audit 报告与 §5.1 / §5.2 的作者自测
记录**一字未改**，其口径截至当时那几轮，后续结论以本节为准。

### 5.6 pending 结算门禁与记录键单测（限定复核，**未发布**）

`0.2.0-functional.5` 之后的未发布工作区工作。**本子轮只涉及测试与文档**：验证的产品源码是上一节那条
已记录的未发布 F3 改动；`package.json` 只在 `test:composition` 里**加了这一个文件**（CI 主机显式列表
另加一行），版本未 bump，**不在**任何已发布条目内。

**一个门禁文件、两例**（[gate-trusted-epoch-settlement.test.mjs](../tests/composition/gate-trusted-epoch-settlement.test.mjs)），
接在真实 Loader、adapter、runtime / journal / ledger、agent 与真实用户 `/compact` 上，**无
`createLifecycle` fake、无 mock apply**；注入面**按用例分列**：`TS1` = **own 段为空的 bootstrap**
（`resolveBootstrapBaseline` 的 post-begin 裁决点），**仅**注入 `table().put` 写屏障；`TS2` = **真
legacy**（段一不装配 adapter → 真实 own 出站事实、表里无记录；`settleRestoreBaseline` 的 legacy 入口），
注入 ① **先等测试闸门、后调用真实 `facility.open()`**（此刻域尚未打开）② 真实域打开后的 `put` 屏障
③ `ledger.load` 的**只观察**旁路（返回**同一个原始 promise**）—— 是 instrumentation，**不是** fake store。
两例窗口内都不得提前终态、不得授权、不得发对话出站；释放**最新 manual 写**后要求 `ready` / `trusted`、
名单 = 压缩边界那份、epoch 与 journal 及 durable 记录一致，且**同一条** pending 用户轮**恰好**补发一次出站。

**交叉口径**（全新私有副本，产品源码零插桩）：回退 post-begin 裁决点 → **只 TS1 红**；回退 legacy 入口
的**忠实**形态（F3 之前代码：单次 `load()`、单次判态）→ **只 TS2 红**；粗改成**连 `load()` 都不调用**只红
在**前置**上，属**弱反例**。二者钉住**两个可重复的结算契约**，但**都不证明真实宿主会自然产生这两条窗口**。

**新增可移植单测 `TE-U19`**（[unit/trusted-epoch.test.mjs](../tests/unit/trusted-epoch.test.mjs)），用
**声明式注入的测试存储**，只钉三条：记录键由构造时冻结的身份编码、迟到 resolve 不覆盖 runtime
`identity` / `names`、冷恢复按最新 identity 取名单。它**不宣称真实 SDK 的内部提交 / 排队时点**（其 map
是 fixture 记录视图，非物理介质），也**不断言**「旧 put 绝不落盘」；分辨力在**私有副本**上验过。

**本轮指纹**：新门禁 `DD691EBA…`、unit `8D37D411…`；`lifecycle.mjs`（`68AFA230…`）、ledger
（`228ADEC7…`）、上一轮收尾 unit（`D2451321…`）与 TE-R 门禁（`3FA2A991…`）**逐字未改**。非作者限定复核
与主代理终核均通过（**296/296/0 skip**、**108/108/0 skip**）；前轮 283 / 295 / 106 保留，**不相加、不漂白**。
**仍未完成**：**旧 F4 窄窗口整范围仍未闭合**；`§2.2a` 线上未证实、授权行为未改；其余未覆盖项、
`03 §11` 阶段 3、发布与安装生效全部未完成；质量冻结（21 项、20 PASS / 1 FAIL）**未改写**；§5.1 / §5.2
与历史 audit 记录**一字未改**。整体仍 **WIP、未验收**；本节是**有限工作区实现**，不等于全 feature
发布验收。

**发布范围（源码版本 `0.2.0-functional.6`）**：本节的门禁、单测与前节 F3 的两处机制随该版本一并
纳入发布准备。`0.2.0-functional.5` **已作为 GitHub 构建版发布**（`v0.2.0-functional.5 ·
1049d47f920d`，tag `build-1049d47f920d`，commit `1049d47f920d…`）；它**之后**的两处 `[Unreleased …]`
条目此前**未发布**，现首次并入本版本，历史段**按原样保留**。GitHub Release 资产由 `main` 绿跑自动
产出（`build-<sha>`），**本文写在发布动作之前，不声称本版本已远端发布**；未安装 / 未重启 / **未发
npm** / 未打 semantic tag。上文所有"仍未完成"与"未验收"结论**不因这次发布准备而上抬**，也**不**代表
无缺陷。

> **2026-10-08 补记**：该版本此后确已由 `build-80216ba3effa`（`v0.2.0-functional.6 · 80216ba3effa`，
> 目标提交 `80216ba…`，资产 `dsh-tool-discovery.tgz`）发布。上一段"写在发布之前"的措辞**按原样保留**
> 为写作时记录；发布资产仍**不是**验收声明，也未安装到任何 profile。其后 `main` 上同一未 bump 的
> `version` 又产生了若干 `build-*` 资产；`0.2.0-functional.7`（可选设置）在工作区，尚未发布。

## 6. 相关文件

- 门禁：[`gate-trusted-epoch.test.mjs`](../tests/composition/gate-trusted-epoch.test.mjs)、
  [`gate-trusted-epoch-io.test.mjs`](../tests/composition/gate-trusted-epoch-io.test.mjs)、
  [`gate-trusted-epoch-fork.test.mjs`](../tests/composition/gate-trusted-epoch-fork.test.mjs)
- pending 结算门禁：[`gate-trusted-epoch-settlement.test.mjs`](../tests/composition/gate-trusted-epoch-settlement.test.mjs)
- 恢复收尾单测（**纯可移植**，无宿主 SDK）：[`lifecycle-settlement.test.mjs`](../tests/unit/lifecycle-settlement.test.mjs)
- 改动面：[`adapters/dsh/journal.mjs`](../adapters/dsh/journal.mjs)、
  [`adapters/dsh/lifecycle.mjs`](../adapters/dsh/lifecycle.mjs)、
  [`adapters/dsh/guard.mjs`](../adapters/dsh/guard.mjs)、
  [`adapters/dsh/projection.mjs`](../adapters/dsh/projection.mjs)
- 协议与状态口径：[02](<02-protocol-and-data-model.md>)、[05](<05-current-status.md>)、
  [07](<07-lifecycle-recovery-coverage.md>)