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
