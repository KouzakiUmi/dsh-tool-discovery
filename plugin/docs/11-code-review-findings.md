# 11 · 代码审查发现与处置（2026-10-11）

## 0. 口径与方法

- **基线**：本轮审查针对 `main` 上的固定 Commit `71d62f2`；随后同轮整改（含本文档）落在新 Commit 上。
- **方法**：三份**互不相同的只读**审查并行进行，各自独立读代码与宿主安装树，不修改任何文件：
  1. 权限与安全边界（`plugin/adapters/dsh/` 全部 11 个文件）；
  2. 协议、输入校验、不变量与资源边界（`plugin/domain/` 全部 + `plugin/client/model.mjs`）；
  3. 浏览器客户端纯净性、打包面、CI 门禁与上架披露。
  另加一轮**规则镜像复算**：用 DSH STORE 自己的规则实现（`src/package-source-surface.mjs`、
  `src/automation-source-policy.mjs`、`src/fixed-source-review.mjs`、`registry/automation-policy.json`）
  对固定 Commit 跑了一遍，见[上架与兼容声明](<10-store-compatibility.md>) §3.1。
- 本文档只收录**结论与处置**：已整改的写清改了什么、用什么钉住；**未整改**的写清为什么没改、
  可选方案与代价。审查报告里的"未发现问题"清单不在这里重复 —— 它们的作用是界定结论范围，
  而不是新的承诺。

## 1. 已整改

| # | 位置 | 问题 | 处置 | 钉住它的证据 |
|---|---|---|---|---|
| 1 | `plugin/adapters/dsh/journal.mjs`（`restore()` 的两条终态出口） | 没有 `query` 与 `readSession` 失败这两条出口**没有收口**：缓冲此后永无读者却继续累积（`request/header` 的 payload 是完整出站 tools 数组），在途 load 的 engine 预算预留也永不释放。违反本模块自定的"每个走到无人再读副本的位置都必须显式收口"。 | 两条出口各补 `stopBuffering(); abandonLiveCalls();`。**不**改用 `failClosedUncertain()`：置 `sealed` 会把归因改写成 `journal-sealed`，抹掉 `readSession-failed` 这个更精确的前缀（既有门禁依赖它）。 | 新增 `JB-U8`、`JB-U9`（在途预留被释放、归因与 seal 语义不变）。缓冲自身在该场景没有第二个观测面，测试注释里写明了这条诚实边界。 |
| 2 | `plugin/domain/search.mjs`（`queryTermGroups`） | 词分组去重是 `groups.find(...)`，对**不断增长的数组**做线性扫描 ⇒ O(L²)。实测 8000 个 CJK 字符要 729ms，而查询长度默认没有硬上限。 | 改为 `token → group` 的 Map 索引，语义等价、复杂度降为 O(L)。 | 既有检索用例（`search.test.mjs`、`search-bilingual.test.mjs`）全部保持通过。 |
| 3 | `plugin/domain/engine.mjs`（`destroySession`） | 会话销毁只清 `sessions`/`locks`，**不回收 `pending`**；每条 pending 都握着整份原始请求与期望回执，会留到插件结束。 | 补上按 `sessionId` 清理 `pending` 的循环。 | 由 `getPendingSize()` 可观测（与 `JB-U5` 同一观测面）。 |
| 4 | `plugin/domain/host-locale.mjs`、`plugin/adapters/dsh/index.mjs` | `desktop-locale.json` 是**以 profile 名为键的 map**（宿主写 `{ ...saved, [profile]: locale }`），原实现按 `desktop ?? locale ?? preference` 猜固定字段：本机活跃 profile 恰好叫 `desktop` 才显得能用；profile 名为 `web` 等时会**静默回落英文**，存在同名 profile 时还会读到**别的 profile** 的语言。 | 改为两级来源：① 宿主 profile patch 里 `- id: locale` 的 `config.preference`（与 profile 名无关，权威）；② `desktop-locale.json` 但**只认调用方给出的 `profileKey`**，拿不到就回落，不猜。适配层从 `ctx.get('profileContext')` 取 `name` / `patchPath` / `home`（`home` 已由宿主规范化）。 | `HL1`–`HL9`：显式配置优先、`preference` 优先于文件、按 profile 名取值、**缺键不得回落到同名字段**、区域标签归一、缺来源不碰文件系统。 |
| 5 | `plugin/domain/host-locale.mjs` | `AUTO_LOCALE` 哨兵比较大小写/空白敏感：配置写 `'AUTO'` / `' auto '` 会被当成语言名而静默钉死默认值。 | 比较前 `trim().toLowerCase()`。 | `HL2`（三种写法都必须走"跟随界面"路径）。 |
| 6 | `plugin/domain/engine.mjs`（`createText`） | 直接用公开 API 构造 engine 且沿用 Config 默认 `locale: 'auto'` 时，哨兵会被当成无法识别的语言名。 | 内核侧把哨兵归一为"未指定"。 | 适配层生产路径早已归一；此处覆盖第三方直接使用 kernel 的情形。 |
| 7 | `plugin/domain/locale.mjs`（`limit` 描述） | 面向模型的文案写死 `Default 20, max 20` / `max 8`，而硬上限默认全部关闭（`null`）——对模型**伪造了不存在的上限**。 | 文案改为只陈述真实默认值（`Default 20.` / `Default 5.`）。 | 描述快照类断言（`settings.test.mjs` 等）保持通过。 |
| 8 | `plugin/adapters/dsh/guard.mjs` | `frameworkRetained` 的无条件豁免排在基线门禁**之前**（pending/blocked 也照放），且没有任何日志；核武器式的"配置即授权"在运维面不可审计。 | 拆出独立分支并记 `guard:framework-admitted`。 | 放行语义不变，只增加可审计性。 |
| 9 | `plugin/adapters/dsh/guard.mjs` | 只校验 `agent === undefined`，未校验 `agent.session`：缺它时 `runtimeFor` 抛 TypeError，被宿主兜成非结构化错误（仍 fail closed，但不可归因）。 | 与 `index.mjs` 同一句结构化拒绝。 | 拒绝文案与 index 侧一致。 |
| 10 | `plugin/adapters/dsh/guard.mjs` | 核心工具的"运行时装载自证"放行会**同时**把名字写进常驻集合（一次名单变更），却没有任何日志 —— 与第 1 条未整改项直接相关。 | 记 `guard:core-self-admitted`，让这条路径被走到过这件事可查。 | 行为不变，只加可观测性。 |
| 11 | `plugin/adapters/dsh/journal.mjs` | fail-closed 日志把宿主错误 message 原文逐字写进日志（可能带会话存储路径或用户名）。 | 改记为宿主的 `code`（拿不到就 `unknown`），归因仍由固定前缀给出。 | 日志文案变化不影响既有归因断言。 |
| 12 | `plugin/adapters/dsh/tool-inventory.mjs`、`index.mjs` | `scopeMountedToolNamesOf` 是死代码（只有定义与一处 import，无调用方），却读宿主的 `layers` 内部结构，无谓扩大权限与维护面。 | 删除该导出与 import。 | `tool-inventory.test.mjs` 只覆盖另两个函数，保持通过。 |
| 13 | `plugin/domain/protocol.mjs`（`toErrorEnvelope`） | 第四个形参 `details` 永远不会被 envelope 带出去（冻结契约 §10 无该字段），是死参数。 | 删除形参，并在 JSDoc 里写明 envelope 不含 `details`。 | 无调用方（全仓仅导出点）。 |
| 14 | `plugin/domain/core-tools.mjs` | 整段注释为英文（适配/内核纪律要求中文），且缺少对已知语义边界的指向。 | 译为中文，并加一条指向本文档 §2.3 的已知边界说明。 | 仅注释。 |
| 15 | `.github/workflows/ci.yml` | composition 与 quality 两个 job 以 `github.event_name == 'workflow_dispatch'` 为条件，但 `on:` 从未声明 `workflow_dispatch` ——**连手动也触发不了**，注释所称的"opt-in 手动门禁"实际不可达。 | 补上 `workflow_dispatch` 触发器。 | 触发器本身即可核对（`on:` 块）。注意：这恢复的是**可达性**，不是把组合门禁变成发布门禁 —— 见 §2.4。 |
| 16 | `README.md` / `README.zh.md` | 同一份文件里版本与发布状态三处互斥：`0.2.2` vs manifest `0.3.0`、"未发布到 npm" vs "自 `0.2.1` 起已发布"、以及直接教用户 `npm install`。 | 统一为：`0.2.1`、`0.2.2` 已发布；`0.3.0` **尚未发布**（只存在于 `main` 与提交级构建资产）；并写明本轮**没有**向真实 profile 安装/重载/重启。 | 与 `package.json`、`plugin/docs/10-store-compatibility.md` §1 的状态表一致。 |
| 17 | `plugin/docs/10-store-compatibility.md` §3 | 载荷说明错误：把 `CHANGELOG.md` 列为随包文件（它既不在 `files` 内、也不在 STORE 的审查面内）。 | 修正为只列自动附带的 `package.json` / `LICENSE` / `README*`。 | `npm pack` 载荷清单。 |

## 2. 未整改（需要产品决策，不是遗漏）

以下四条**没有**改代码。每一条都给出：为什么不动、可选方案、代价。它们的共同点是会改变产品对外承诺
或安全语义，因此应当由作者显式决定，而不是由一次审查顺手改掉。

### 2.1 核心工具的"运行时装载自证"绕过可信记录（严重度：高）

`guard.mjs` 里有一条放行：只要工具名在 `CORE_TOOL_NAMES` 且宿主当前 scope 能解析到它，就直接执行，
并把它补进常驻集合。它排在基线门禁之后、`engine.evaluateCall` 之前，因此**不**经过：可信记录名单、
`alwaysNameSet`、披露状态、资格判定。默认配置下 `requireTrustedEpoch` 为 `false`，基线门禁本身也不生效。

- **为什么像是有意设计**：注释自述目的是"避免 `TOOL_NOT_LOADED` 冲突死锁"（核心工具本来就在 scope 里），
  并且 `RV1`/`RV3` 两条组合门禁**固定了这个行为**（RV3 断言放行并加入 `alwaysNameSet`）。
- **为什么仍要报告**：它与同文件上方"任何常驻名都不得被放行，否则一份不可信名单就能凭猜名真正执行
  隐藏工具的 body"的自我声明冲突；并且当部署用 `alwaysVisible: []` / `initialToolsEnabled: false`
  显式移除某核心工具（例如 `write`、`subagent`）时，模型只要猜中名字就仍能执行，且这次放行不在任何
  持久记录里（不落盘、不可审计、重启即失）。
- **可选方案**：(a) 删除该分支，让核心工具与其它工具走同一条判定（需要把 `RV3` 从"断言放行"改成
  "断言拒绝"，并补一条正控制证明记录内的核心工具仍可执行）；(b) 收紧为"仅当该名已在
  `alwaysNameSet`（严格模式下即记录名单）中才放行"，同时保留死锁兜底；(c) 保留现状，但把它明确写成
  信任边界（本文档 + 注释 + README 的权限表），并接受"配置不能阻止核心工具执行"。
- **代价**：(a)/(b) 会改变既有承诺并需要重跑受影响的组合门禁；(c) 不需要改代码，但用户对 `alwaysVisible`
  的预期必须被纠正。**本轮只做了 (c) 的一半**：加了 `guard:core-self-admitted` 日志，并在
  `core-tools.mjs` 与本文档里写明边界，没有改语义。

### 2.2 冷恢复只证明 wire 合同（严重度：取决于宿主）

`engine` 的冷恢复会把历史里成对的 canonical 回执折叠进 `selected`；只要回执与当前绑定身份
（toolId / revision / schemaDigest / skillRevision）逐字一致，伪造的历史同样会被折叠。协议文档
（`02-protocol-and-data-model.md` §8）已经承认这条边界（"回执不可伪造"只在**热态**成立）。

- **为什么不动**：会话历史是否可能被非宿主写入，属于适配层与宿主的事实，**无法从本仓库代码确认**。
  在没有那条事实之前，任何"加固"都是猜测。
- **建议**：先确认宿主会话日志的写入面（谁能写、是否校验），再决定是否需要把冷恢复降级为
  "只恢复 wire 披露、不恢复执行授权"。

### 2.3 显式 `alwaysVisible: []` 无法真正移除核心工具（严重度：低）

适配层的"运行时装载自证"会在周期边界把 scope 内**可见**的核心工具重新并进常驻名单，并写进可信记录。
于是 `alwaysVisible: []` 只能影响"初始注入"，不能缩小"常驻集合"；这与 `config.mjs` 与
`core-tools.mjs` 中"显式 `[]` 会完整替换默认项"的表述冲突。

- **可选方案**：(a) 配置显式给出数组（或 `initialToolsEnabled: false`）时跳过自证；(b) 保留自证，
  把三处文档/注释改成"显式数组只影响初始注入，不影响周期边界后的自证补入"。
- **代价**：(a) 需要改 `RV1` 与 `gate-settings` 的期望值；(b) 只需要改文字。本轮未动。

### 2.4 `tool_list` 的 `loaded` / `state` 视图不受 `limit` 与字节预算约束（严重度：中）

`loaded` 视图丢弃已校验的 `limit`/`cursor`（实测 `limit: 2` 仍返回 30 个名字），`state` 视图不经字节核算
（实测把 `maxListResultBytes` 配成 64 仍返回 4534 字节）。两者都与 `02-protocol-and-data-model.md` 里
"limit 默认 20、最大 20""该上限覆盖状态响应"的表述冲突。

- **为什么不在本轮改**：正确修法是让它们走 `paginateNames` 与 `createByteAccumulator`，属于分页语义改动，
  需要同步设计 `loaded` 的游标语义（当前 `nextCursor` 恒为 `null`、`truncated` 恒为 `false`），
  不是一行修正。在长审查轮的末尾做这类中等风险改动，不如单独一轮做。
- **同时记录**：`02` 文档 §9 的预算表有 9 行仍写死旧默认值（`maxListLimit: 20`、`maxQueryCodePoints: 512`
  等），而实现是"默认全部关闭"（README 也这样写）。冻结文档的方向应当是**追加 delta**，
  而不是把实现改回去。

## 3. 已知信任前提（不是缺陷，但必须写明）

1. **可信记录没有完整性与真实性绑定**：没有 MAC/签名，只有四元组键与字段自洽。能写该 JSON 文件的
   本地攻击者可以为任意 `sessionId` 伪造常驻名单。这是"存储可信"前提的一部分。
2. **一个 session 一个 runtime**：同一 session 内多 agent 共享 engine scope（取首个 agent）。会话内跨
   agent 的能力借用是否可达，取决于宿主是否允许一个 session 下多个 agent 执行工具 —— 本仓库无法判定。
3. **`session/disposed` 之后若仍有 `session/event`**，缓冲会按会话重建（每会话上限 4096 条、有界，
   直到插件 dispose 才回收）。宿主是否会这样发事件，同样无法从本仓库确认。

## 4. 四个待决策项的业务分析（2026-10-11）

§2 记录的是技术发现与实现选项。本节把同一批问题翻译成**业务决策**：要回答的产品问题是什么、
三份独立高端分析收敛到哪里、本轮补了哪些事实核实。**本文档不预设结论**，代码未动。

三份分析分别由不同厂商路由独立完成（Anthropic / OpenAI / 智谱），口径与本文档相同：只读，不改文件。

### 4.0 作者决策（2026-10-11）

总原则：**很多问题不是问题 —— 做成开关、默认关闭、选择权交给用户。产品服务于用户，而不是代码正确性。**

| 开放项 | 决策 | 落地 |
|---|---|---|
| §4.1 核心工具能否被配置收窄 | **做一个开关，两种行为都要** | 新增 Config `respectAlwaysVisible`（默认 `false` = 现状）。开启后 `alwaysVisible` 成为**上限**：名单层不再自证并集，guard 也不再免披露放行。门禁 `RV4` / `RV5`。 |
| §4.2 冷恢复的授权边界 | **只承诺单用户、单 profile** | 不改恢复链路。在 README 的权限段写明「承诺范围」，把会话历史与可信周期存储列为**受信任输入**。 |
| §4.3 默认上限 | **不默认打开，给设置建议** | 默认值不变；README 增加一组起步配方（护栏三项 + 交互两项），并说明为什么这样分。 |
| §4.3 两处实现缺陷 | **照修**（否则用户配的开关会静默失效） | `loaded` 视图改为与 `available` 走同一条分页；`state` 视图纳入 `maxListResultBytes`，超限以 `BUDGET_EXCEEDED` 明确失败。门禁 `F12b` / `F12c`。 |

**实施中额外发现并修复的真实缺陷**：`validateConfig` 返回的是一个**新字面量**（不是调用方传入的原对象），
而其中漏掉了三个已声明的字段 —— `tolerantLoadProtected`、`locale`、`respectAlwaysVisible`。
也就是说"关掉 tolerantLoadProtected"和"钉住 locale"此前**都是假的**（配置项静默不存在）。
新门禁 `plugin/tests/unit/config-passthrough.test.mjs` 现在对着 `config.mjs` 的 schema 字段逐项钉住，
`CP2` 是这三个键的正控制。

### 4.1 核心工具能否被用户配置收窄（对应 §2.1 与 §2.3）

**要回答的产品问题**：DSH 自带的 37 个核心工具，用户配置能不能收窄？

本轮补的四个事实：

1. **名单层并集从会话第一天就发生**，不是"周期边界之后才推翻配置"。`currentAlwaysNames` 在建 runtime
   （`lifecycle.mjs` 的 `ensureRuntime` 路径）、周期边界、严格模式写初始记录三处都会被调用。所以
   README 里 `alwaysVisible: ["read","grep"]` 这种配法**从来没有**得到过它写的那个集合。
2. **"移除自证会死锁"这个理由不成立**：`tolerantLoadProtected`（默认 true，`LT1`）让"load 一个已常驻
   的工具"幂等成功；`tools/change` 会逐会话刷新目录，后注册的核心工具因此可被 `tool_load` 到；
   全部 `@deepseek-ai/*/lib/*.js` 中 `.tools.execute(` **零命中**（未穷尽，但没有明显的非模型调用方）。
3. **技术前提尚未满足**：当前无法区分"用户显式配置"与"schema 默认值"——两者经 `resolveAlwaysVisible`
   之后完全同形。要落地"尊重显式配置"，必须先把 Config 默认值改成 `null`（未配置哨兵），
   `null` 时才自证补入。
4. **测试盲区**：`SG2/SG3` 声称验证"显式 `[]` 真的清空"，但 `plugin/fixtures` 里没有任何核心同名工具，
   因此是**空转通过**。这条路径事实上只被 `RV1/RV3` 覆盖，而它们断言的正是"并集"。

三个选项（撤回承诺 / 尊重显式配置 / 新增 opt-in 开关）的收益与代价见 §2.3。三份独立分析一致倾向
"尊重显式配置"，理由是默认用户零变化、迁移成本只落在本来就想收窄的人身上。

### 4.2 冷恢复的授权边界（对应 §2.2）

**要回答的产品问题**：这个插件的部署形态是"本机单用户桌面"，还是会被用于多用户 / 远程 / 共享环境？

本轮补的三个事实：

1. 恢复出的 `selected` **还需要下一轮真实披露为 `advertised`** 才能执行，链路上仍要经过宿主审批、
   沙箱与权限链——它不是一条"直接拿到执行权"的短路。
2. 增量收益比想象的窄：`write` / `subagent` 默认就是常驻可用的，**不是**理想利用例；真正的增量风险是
   **非核心、当前非常驻但资格合格的隐藏工具**。若某名字仍属 protected 集合，伪造 load 反而会被拒。
3. **"能写工作区文件"不等于"能写 DSH 会话库"**。这条区分很重要：不能笼统地用"能写本机文件即已越出
   威胁模型"把它一笔带过。若模型沙箱、低信任插件、导入 / 同步或跨 profile 路径能写会话库，它就升级为
   现实的门禁绕过。

**A 方案（保持现状并写明边界）落地时需要向宿主确认的问题清单**：

| 维度 | 需要确认 |
|---|---|
| 存储 | 会话日志的实际后端与路径；文件/目录/备份的 owner 与 ACL；其他用户或同用户进程能否写；是否防 junction / symlink / 离线替换 |
| 写接口 | 插件、工具、CLI、Web UI、导入器能否追加或修改事件；能否自定 `seq` / `type` / `callId` / `sourceEventSeqs` / `isError` / `content` |
| 隔离 | sessionId 是否防碰撞；跨 profile、账号、工作区是否共库、可见或可导入 |
| 重写链 | 压缩、迁移、修复、同步、备份恢复是否会合成或重排事件；是否保留来源 |
| 完整性 | canonical 事件是否带宿主签名 / MAC 或不可伪造的 append-origin；读取时是否验证 |
| storage 域 | 其他插件或同权限进程能否打开、改写可信周期域；是否抗复制与回滚 |

翻转条件：上述任一项不成立（尤其是"模型或普通插件可写会话库""跨 profile 同步不保来源""多用户/远程"），
就应当从 A 升到 B（冷恢复只恢复 wire 披露，重启后需重新 load）。

### 4.3 契约一致性与默认上限（对应 §2.4）

**要回答的产品问题**：默认值应该是"什么都不限制"，还是"护栏开、交互不限"？

本轮补的三个事实：

1. **测试没有冻结 `loaded` / `state` 的行为**——`list.test.mjs` 的 F12 只断言列出的名字，不断言
   `limit` 或 `truncated`。所以"修实现"这条路没有断言阻力。
2. **§10 那条"引导模型显式卸载"没有流进模型可见面**：`entries.mjs` 的工具描述写着
   *"there is no unload"*，模型不会照开发者文档去走死路。伤害主要落在开发者 / 运维侧。
3. **额外发现一处描述失真**：`tool_list` 的描述写 *"in bounded pages"*，而 `loaded` 视图恰恰不是分页的。
   修 `loaded` 时应一并改这句。

三份分析里最有价值的区分是把九个 `null` 分成两类：

- **交互型上限**（`maxListLimit` / `maxSearchLimit` / `maxQueryCodePoints`）默认关**可辩护**：
  默认 `limit` 已保证输出有界，显式大 limit 是合法需求，误拒代价高。
- **护栏型上限**（`maxActiveTools` / `maxActiveSchemaBytes`）默认关**不合理**：它们正是"压 schema 体积"
  这个卖点的执行机制，而 unload 已被禁止、唯一的释放阀是压缩——默认无界意味着插件在默认配置下
  不兑现自己存在的理由。

推荐 B（追加文档 delta + `loaded` 尊重 `limit` + `state` 纳入字节核算），C（默认打开护栏型上限）
需要真实使用数据（一个会话通常 load 多少工具）才能判断会不会误伤。

## 5. 第二轮对抗性审查（2026-10-11，三份独立审核）

开关化改造完成后，同一批**未提交**改动被三份独立审核并行核对（不同厂商路由，全部只读——变异的
部分由它们在 `%TEMP%` 的 index 导出副本上执行，仓库零写入）。三份的结论一致：**开关语义在代码层
完整、默认路径零回归、新门禁全部非空转**（变异实测）。但它们各自找到了"测试看起来在守、实际没守"
的形态 —— 这类缺口比单个 bug 更值得记。

### 5.1 共同确认成立的部分

- **开关没有被绕过的路径**：枚举 `alwaysNameSet` / `alwaysNames` 的全部写入点，入参只有
  `currentAlwaysNames()`（受开关门）、`runtime.ledger.names`（严格模式记录，权威）与 `[]`；
  `projection` 与 `journal` 对名单**只读**。执行层与名单层同步关断。
- **默认零回归**：把默认值翻成 `true` 会让 `RV1` / `RV3` 变红 ⇒ 旧行为被真实钉住（不是恒真）。
- **`digestOf(allNames)` 的选择正确**：名单一变（含 revision 失效被过滤）摘要必变 → 旧游标
  `CURSOR_UNAVAILABLE`，确定且 fail-closed。
- **`CP1` 能抓未来新增字段**：注入一个未透传的新字段会被点名报错。

### 5.2 审核发现并已整改（本轮）

| # | 发现 | 来源 | 整改 |
|---|---|---|---|
| 1 | **`RV5` 恒真**：删掉 `CORE_TOOL_NAMES` 里的 `'bash'`/`'write'` 后 390 单元 + 5 RV **全绿** | GLM 5.3（变异 F）、MiMo（独立同结论）、GLM Flash（同） | fixture 前置断言 + `RV6` 默认模式正控制 |
| 2 | `RV5` 只钉名单层：只去掉 guard 侧判断时它仍绿 | GLM Flash（缺口 2） | `RV5` 内补执行层断言（已注册的核心工具必须 `TOOL_NOT_LOADED`） |
| 3 | **`RV2` 名单层断言空转**：`scope-tools` fixture 挂在 `agent/created`，而该用例从不创建真 agent | GLM Flash（缺口 7） | 显式 `ctx.tools.register(def, agentScope)` + 前置断言 |
| 4 | **"不会死锁"的归因错误**（4 处）：被拒的核心工具不在 `alwaysNames`，与 `tolerantLoadProtected` 无关 | GLM 5.3（问题 2）、MiMo（附注） | README 双语 / CHANGELOG / guard 注释改为"不在受保护基线里，普通 `tool_load` 即可" |
| 5 | **`loaded` 游标契约无门禁**：`orderDigest` 换常量后全绿 | MiMo（问题 1，列为最重要缺口）、GLM 5.3（变异 G） | 新增 `F12d`（名单变化 → 旧游标 `CURSOR_UNAVAILABLE` + 重新翻页正控制） |
| 6 | `F12b` 只验数量不验内容 | MiMo（问题 2） | 改 `deepEqual(names.slice(20))` + 两页并集断言 |
| 7 | **`state` 上限会长期失败**：`invalidated` 只增不减，配方下 12 个 selected 已 2,032 字节 | MiMo（问题 6，实测） | `fitStateWithinBudget`：超限**先裁诊断段并带 `invalidatedTruncated` 标记**，`selected`/`advertised` 不裁；门禁 `SB1`–`SB5` |
| 8 | §13 delta 自己引错 §9 的两个数字（写成 8192，实际 6,144 / 12,288） | MiMo（问题 5） | 订正，并把 §9 表末的 unload 指引一并纳入 §13.2 |
| 9 | `CP1` 容差过宽（`>= 8`，实际 11 个字段） | MiMo（问题 7） | 棘轮到 `>= 11` |
| 10 | 度量口径不一致（`canonicalJson` vs 出站 `JSON.stringify`） | MiMo（问题 9） | 统一为 `JSON.stringify` |
| 11 | 错误消息硬编码英文、未走文案表 | MiMo（问题 10） | 走 `text.format(['detail','bytesOverBudget'])`，数字并进 `what` |
| 12 | 形状校验与"兼容 volatile"注释互相矛盾 | MiMo（问题 8）、GLM 5.3（问题 6） | 与 `initialToolsEnabled` 同样先 unwrap `.get()` |
| 13 | **出站披露面在开关打开时零覆盖** | GLM Flash（缺口 1） | 新增 `RV7`（`assemble` 后断言 wire 含配置核心、不含未列出核心、三入口恒在） |

### 5.3 仍未覆盖（如实记录，不阻塞）

- `preset` 保留项 × 开关打开：代码上 preset 保留**不受**开关门控（有意语义），但无测试钉住。
- 开关打开 × 缺省 `alwaysVisible`；`requireTrustedEpoch: true` × 开关打开：无组合门禁。
- `RV4` 的解锁闭环只覆盖到 `load → 折叠`。"再执行成功"还需要一次真实出站（`evaluateCall` 要求
  `advertised.requestId` 匹配当前请求），那需要驱动真实 agent 轮次；本用例的注释里写明了这条边界。
- `initialToolsEnabled=false × 开关打开` 的等价性目前是**读码推断**，未实测。

### 5.4 三份审核共同强调的一点

它们各自独立指出：这个仓库真正该防的不是"某条断言写错"，而是**"测试看起来在守、实际没守"**——
`SG2/SG3` 曾因 fixture 缺素材而空转，我新加的 `RV5` 又重演了一次同款形态，而 `RV2` 的空转已经存在
很久却一直没被发现。因此新增门禁时，"前置素材真的到位了吗"必须和断言本身一样被钉住 —— 本轮的
整改就是把这一条补进每一处。
