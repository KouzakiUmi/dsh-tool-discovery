# 05 · 当前状态

截至 **2026-10-08**（Asia/Hong_Kong）。本文件只记录**有证据的结论**，并把每项标为 **已验证 / 未验证 / 不支持**。协议判据见[02](<02-protocol-and-data-model.md>)，矩阵见[03](<03-implementation-and-acceptance.md>)，接口事实见[04](<04-runtime-evidence.md>)，可信周期细节见[08](<08-trusted-epoch-baselines.md>)。

> **维护方式**：本文件是**当前快照**，不是流水账。过程叙述（每一轮修了什么、谁复核、命令与日志）归 [`CHANGELOG.md`](../../CHANGELOG.md)、[08](<08-trusted-epoch-baselines.md>) 与私有证据 `plugin/reports/**` / `plugin/audits/**`；这里只留结论、数字与未覆盖项。旧版逐轮叙述可在 git 历史中取回。

## 0. 状态口径

**版本坐标**：`main` 是当前已发布基线，源码版本 **`0.2.0-functional.6`**（未 bump）。本仓库于 2026-10-06 重建，旧历史（`2a1f9c0`、`257ddc0` 等）已被重写移除，**不再可引用**。每个绿的 `main` 构建会自动产出 GitHub Release 资产（`build-<sha>`），那是**构建产物，不是验收声明**。

整理完成 ≠ 发布完成 ≠ 产品验收 ≠ npm 发布 ≠ 安装生效，五者互不替代。本文件的“已验证”一律指**工作区内的代码与测试证据**，不含任何安装或分发结论；它不是 [03 §11](<03-implementation-and-acceptance.md>) 发布门槛的产品验收，不是 npm 发布，也不是安装到 profile / GUI 生效。

**核验范围声明**（2026-10-08，本工作区 Windows、Node 24，DSH Core `0.2.1-alpha.1` 在默认安装根）：

| 项 | 结果 | 命令 |
|---|---|---|
| 单元测试 | **349 pass / 0 fail**（exit 0） | `npm test` |
| 组合门禁（真实 Loader，14 个 `gate-*.test.mjs`） | **108 pass / 0 fail / 0 skip**（exit 0） | `npm run test:composition` |
| 仓库一致性（身份 + 文档链接 + 未测量声明） | **通过**（exit 0） | `npm run check` |
| 质量工装单测 | **14 pass / 0 fail / 1 skip**（skip 为符号链接场景，平台 `EPERM`，记 **unknown**，不算通过） | `node --test plugin/quality/tests/*.test.mjs` |
| 质量验证器 | **20 PASS / 1 FAIL**（exit 1，类别资格 H037 ×2、H044 ×1）；digest 全 PASS、冻结数据未改；**评分 still not ready** | `npm run check:quality` |

- 以上是**该时点的一次复跑**，不是“独立签署”：作者复跑与非作者复核是两回事，各子系统的复核范围见 §0.1 / §0.2 / §5 与 [08 §5](<08-trusted-epoch-baselines.md>)。数字会随测试增减漂移，以命令实际输出为准。
- 质量验证器的结论**依赖私有的 `quality/queries/` 与 `quality/labels/`**，只在完整内部资料下成立；无这两者的 checkout 无法复现该退出码。
- **入口执行语义**（已定案，见 §2.5）：入口 `execute` 对业务失败**返回 `ok:false` + `error.code` 的 JSON 串，不外抛**；“execute 单点抛错”的旧说法是错的。
- **仍未验证**（不因任一结果而升级）：外部真实 provider wire、token / TTFT、检索质量门槛、**L04 compaction**、**L08 crash/fsync 窗口**、**L10 HMR**、**S12 非 native 组合**、**S13 同 session 多活动 agent**、多 scope 并发压力、回执 meta 通道、产品验收与安装生效。

### 0.1 可信周期基线（trusted-epoch，**WIP / 验收未完成**）

- **目标**：移除冷恢复时以首请求 / `request/header` 内容反推常驻工具名单的授信，改为通过宿主 storage domain 持久化**周期记录**，记录落盘后才允许出站；缺记录的旧会话明确报错并阻止请求（旧会话仅经一次满足严格条件的真实用户 `/compact` 迁移）；已可信会话的手动与自动压缩仍正常采最新配置并换新周期。
- **现状**：源码已实现并并入 `main`；契约、判据与逐轮门禁见 [08](<08-trusted-epoch-baselines.md>)。**本行不表示缺陷已全部修复，也不表示任何门禁等同产品验收。**
- **已关闭的缺陷与覆盖缺口**（范围与证据以 08 对应节为准；前五项各获非作者限定复核，F3 另有主代理独立复核，`TS1/TS2`、`TE-U19` 门禁本身仅作者复跑；**都不是全 feature 验收**）：

  | 项 | 内容 | 出处 |
  |---|---|---|
  | 迟到到位绕过迁移 | `retryBaseline` 不检查 own 出站资格 | [08 §5.2](<08-trusted-epoch-baselines.md>) |
  | fail-closed 被吞成 0 请求 | 账本永远停在 pending；新增第四态 `failed-closed` | [08 §2.4b](<08-trusted-epoch-baselines.md>) |
  | 恢复收尾覆盖在途迁移（`TE4b`） | 收尾 `ledger.load()` 让迁移 superseded | [08 §5.2](<08-trusted-epoch-baselines.md>) |
  | TE-R 覆盖 | canonical `tool_load` 回执链作为正向授权源；产品源码未动，补门禁 `TER0/1/2` | [08 §5.4-1](<08-trusted-epoch-baselines.md>) |
  | 坏记录连坐 | 一条坏记录让整个域停摆；传输层降为 `z.unknown()`，判据回到逐会话校验；门禁 `BR4` | [08 §5.3](<08-trusted-epoch-baselines.md>) |
  | 恢复收尾（F3）窄修复 | supersede 的 `PENDING/null` 不再误判；建档资格与初始记录同步启动；门禁 `TS1/TS2`、`TE-U19` | [08 §5.5、§5.6](<08-trusted-epoch-baselines.md>) |

- **仍开放**：[08 §2.2a](<08-trusted-epoch-baselines.md>) 的 MEDIUM 契约级缺口（线上未证实、未改授权行为）；独立复审的其余未覆盖项；**旧 F4 窄窗口整范围仍未闭合**；`retryBaseline` 在 `restoring=false` 时沿用旧 blocked 归因、维持 0 request 的既有窗口；[03 §11](<03-implementation-and-acceptance.md>) 阶段 3 全未完成。
- 反例门禁里的 canonical 链与调度点是**声明式注入的产品代码反例**，不冒称线上自然复现；真实宿主上的防回归是 `npm run test:composition`。

### 0.2 运行时稳定性与检索质量（PR #8 / #9，**待非作者复核**）

已并入 `main` 的一轮功能修复，逐项说明与测量见 [09](<09-business-logic-map.md>) 与 [`CHANGELOG.md`](../../CHANGELOG.md) 的 `[Unreleased]`：

- 新会话的恢复缓冲不再永不释放（`journal.stopBuffering()`）；
- 无关工具注册不再作废全部在途 ref / 游标（`refreshCatalog` 改为按内容身份指纹判定，补 `available:all` 摘要）；
- `engine.cancelOperation` 有了生产调用点（仅限有证据的丢弃路径）；
- 中文检索可用（类别标题 / 摘要并入检索字段）；同义词证据不再压过直接名称证据；
- `tool_load` 的 `candidates[].revision` 真正可选（键缺失 / `null` / `""`）。

每项有新增单测钉住（含变异反证）。**这些改动碰到 `domain/` 的 load/unload 状态机与资格代次失效面，按 [CONTRIBUTING](../../CONTRIBUTING.md) 作者不得自签，需非作者复核——尚未完成。** 仍**未修**的项（中断轮的 `tool_load` 占预算槽、技能从未接线、中文只能定位到类别等）清单见 09 §7。

## 1. 状态速览

| 阶段 / 事项 | 状态 | 签核情况 |
|---|---|---|
| 阶段 0 宿主 seam 合同 | **已实现并经独立核验** | G1–G8 + S08 通过；**已签核**（限 Core `0.2.1-alpha.1` 公开 seam） |
| 阶段 1 `domain` 内核 | **已实现**；两轮独立审查完成 | 首轮判不通过（D1/D2），修复后独立复验通过 |
| 阶段 2 `adapters/dsh` | **已实现**；独立审查与交叉审核完成 | 13 项判据通过；D-1 修复与错误外壳契约经交叉审核确认（残留签核债务见 §5） |
| 恢复与 fork 覆盖增强 | **已并入基线** | 源码曾独立复审，范围限当时 3 个 code 文件；见 [07](<07-lifecycle-recovery-coverage.md>) |
| 可信周期基线 | **WIP，验收未完成** | 见 §0.1 与 [08](<08-trusted-epoch-baselines.md>) |
| 运行时稳定性与检索质量（PR #8/#9） | **已并入，待非作者复核** | 见 §0.2 |
| 质量数据 | 数据冻结完成 | 20 PASS / 1 FAIL，**评分暂不可发布** |
| 阶段 3 性能与真实 wire | **未开始** | 真实 wire、token、TTFT、检索门槛均未测 |
| 安装 / 发布 | **部分完成** | 源码基线随 `main` 发布；**未安装、未启用、未上 npm** |

## 2. 已验证

### 2.1 阶段 0：宿主 seam 合同（G1–G8 + S08）

- 在 Core `0.2.1-alpha.1` 的真实 Loader composition 上通过：首请求只含三个入口（inherited 与 scope-own 普通工具同时隐藏）；猜测隐藏工具名的执行 body 计数为 0，且两种可见性有**可执行正控制**；成功 `tool_load` 后下一轮出现原生 schema 而原定义对象未变；原生参数校验与真实审批链仍能拒绝已加载工具；成功回执经真实持久化并由公开 query 冷读回放可见（跨进程）；`request/header` 与宿主 tool-addition 真实变化；`unload` 后 tool-removal、历史保留与拒绝执行；显式保留的框架终止工具生效而名称形似诱饵仍被隐藏；同一响应内 `load` 与猜隐藏调用并存时被拒。
- 独立审查在隔离镜像中逐字节复制被审文件（哈希一致）复跑，并补充反例：伪回执激活、预写结果、候选路径与错参早失败。**未发现门禁旁路或虚假通过机制。**
- 审查保留一项如实记录的判别发现：门禁对**根本未注册的名字**也报与隐藏工具相同的拒绝文案。产品据此明确“**调用面不区分存在性**”，由代码以统一文案落实（见 02 §10）。

### 2.2 阶段 1：`domain` 内核

- 宿主无关：全部 import 仅为 `node:crypto` 与域内相对模块；不导入 Cordis / 宿主包。
- 单测覆盖见 §0 范围声明。首轮独立审查（非作者）判不通过，两项实证缺陷：**D1** `load` 候选路径未检查入口 / 框架保留项保护；**D2** 保护集合在引擎构造时一次性快照、不随目录刷新。修复（保护检查对称化、折叠侧双重拦截、保护集合动态化、回归测试）经**非作者**独立复验通过，并自建 17 项反例全部通过且未误伤普通工具。
- 折叠安全边界（回执归属、输入路径重算、候选 `ref` 交叉、五字段完整重算、`isError` 与协议 `ok` 双条件、改写拒绝、冷恢复名称不升级）均经源码与反例双重核验。

### 2.3 阶段 2：`adapters/dsh`

- 组合门禁见 §0 范围声明；基础门禁 [`gate-adapter.test.mjs`](../tests/composition/gate-adapter.test.mjs)（F01 / S01 / S02 / S08 / F03pos / S06 / F20 / L09 / COMP，每条安全断言配正控制）与 [`gate-adapter-lifecycle.test.mjs`](../tests/composition/gate-adapter-lifecycle.test.mjs)（候选卡 `ref+revision`、跨会话 `ref` 拒绝、`unload` 移除 / 拒绝 / 历史保留、冷恢复选中）。
- 首轮独立审查判不通过：13 项判据通过，1 项缺陷 **D-1**——恢复时 `readSession` 失败且缓冲内无工具事件，走“新会话”分支置为就绪，违反 fail-closed（L11）。已修，见 §5。
- 同时确认：产品代码无绝对安装路径、未使用已弃用的同步快照接口、`visibility` 不进模型可见文案、不伪造 `UNKNOWN_TOOL`、`applyCanonicalPair` 只在 canonical 对上被调用、整组回滚无孤儿 listener / 门禁。

### 2.4 质量数据

- 冻结评分输入摘要：`sha256:d3ff166099e1f1a380f36eabbc928f7573feebb885025f3fcd1c45bb79140b4e`，**未变**。验证器共 21 项检查（结果见 §0）。失败项为类别资格：两条 held-out 样本的期望答案落在其 `category` 之外，类别内检索不可达。验证器只如实列举，不修改数据。
- 结论：**评分暂不可发布（still not ready）**。摘要只证明评分输入一致，**不证明**语义正确或真实目录下的检索效果；标注为 AI 合成，未经人类专家审核。
- 冻结工装的排他创建缺口（撞名覆写）已改为真实文件系统原子排他创建并经反例复验；该路径通过**不等于**全部冻结与别名安全关闭。
- **20 PASS / 1 FAIL 是当前快照的如实状态，不得改写为通过。** 修复须走显式新版本 / 新冻结，并由独立于作者的人员审查标签语义；详见私有材料 `plugin/quality/README.md` 与 `plugin/reports/quality-plan.md`。

### 2.5 三条失败语义的实际归属（已独立定案）

| 语义 | 实际形态 | 代码位置 |
|---|---|---|
| 协议失败 | `ok:false` + `error.code` 的 JSON 字符串，作为**成功返回的结果文本**；入口 `execute` **不外抛** | [`domain/engine.mjs`](../domain/engine.mjs) `failEnvelope` → [`adapters/dsh/entries.mjs`](../adapters/dsh/entries.mjs) |
| 执行门禁拒绝 | 门禁返回拒绝理由字符串，目标 body 不运行；**不是** `execute` 返回值 | [`adapters/dsh/guard.mjs`](../adapters/dsh/guard.mjs) |
| 宿主原生错误 | 宿主自身 `error.code`；本插件不伪造、不代称 | 宿主执行链 |

现读代码正确：入口 `execute` 对业务失败返回外壳串、不外抛；`scopeFromExec` 的 throw 在 `execute` 内被 catch 转成同一外壳；`S03c` 在真实 composition 上通过，符合冻结契约，**非发布阻断项**。历史中把 `ok:false` 改为抛错的改动已被交叉审核裁定为缺陷并回滚。[02](<02-protocol-and-data-model.md>) §2 与 §12 第 10 条记录了这一区分；“不得把 `ok:false` 当成功返回”的落点是 **reducer / 恢复激活判据**（§11 第 12 条双条件），**验收标准本身未改动**。

### 2.6 工具增减与缓存一致性

- **覆盖**：工具**减少**路径此前在组合层零覆盖，而真实环境里减少确实发生过（[07](<07-lifecycle-recovery-coverage.md>) 记录的实测：出站 header 工具数 28 → 26）。门禁 [`gate-tool-churn.test.mjs`](../tests/composition/gate-tool-churn.test.mjs)：`TC1` 真实移除已 selected 的工具 → 执行 body=0 / 旧 ref 失效 / 无关工具不受影响；`TC2` 移除后重加 → 旧选择不得复活、必须重新 load。fixture [`removable-tool.mjs`](../tests/composition/fixtures/removable-tool.mjs) 通过 dispose 该 entry 的 fiber 取得**真实移除**。
- **定位并修复的真缺陷**：移除 → 重加 → 重新 `tool_load` 后，该工具**永久**停在 `TOOL_NOT_ADVERTISED`。根因：宿主 `@deepseek-ai/dsh-agent-loop` 的 `buildRequest` **只在 header 变化时**才 append `request/header`；出站 wire 逐字未变时宿主不发事件，而 `invalidateTool` 与 `reducePair` 已清掉 `advertised`，记账永远补不回来。修法在 [`journal.mjs`](../adapters/dsh/journal.mjs) 的 `applyAdvertisementPass` / `replayAdvertisements`：记住最后一次观测到的 header，在 load 折叠成功后据此重放一次对账。**没有放宽任何拒绝判据**。
- **由此确立的实现事实**：`request/header` **不是**“每个出站请求都有”的事件；任何依赖“下一轮必然有 header 事件来刷新记账”的写法都会踩这个坑。

## 3. 未验证

- **外部真实 provider wire**：现有录制面是最终请求对象，不是外部 wire。
- **token 与 TTFT**：初始工具相关 token、P95 检索延迟、首次有效工具延迟的 A/B/C 实验全部未做。
- **搜索质量门槛**：held-out Recall@5、负例误命中率、模型正确选定率均未产出；数据本身尚不可发布。检索改动目前靠单测与手工探针，没有指标回归保护。
- **冷恢复端到端链路**（L01/L04/L08）：分支语义与 fork / unload / 候选 / 资格恢复已有实证（[07](<07-lifecycle-recovery-coverage.md>)）；**L04 compaction、L08 crash/fsync 窗口仍未驱动**。
- **fork / compaction / resume 全量语义**（L01/L03/L04）：真实宿主 fork seam 的恢复与不继承语义已实证；**L04 compaction 仍未驱动**，仅内核单测层覆盖。
- **canonical `tool/result` 的 seq 门禁**：8 项 event-seq 套件；该层源码曾由独立会话复审通过，**范围限当时 3 个 code 文件**。真实总线方法学已定（`session.append` 以自身 `SessionSeq` 校验才 emit；合法伪造 seq 被 projection 拒、畸形 seq 被 `SessionSeq` 拒，journal 均未收到）。**仅正常 bus 路径已实证**；异常防御回归是直驱 `journal.onEvent` 的合成，真实宿主畸形总线与持久化损坏日志的端到端取证价值仍未验。出站 mock provider 录制只是装配证据，**不是真实 provider wire**。
- **子代理真实委派链**：fork 走真实宿主 seam 已覆盖；**普通 spawn** 仍以 scope 注册模拟。
- **非 native 展示模式、完整 prompt 组合、其它 waterfall 重新加工具**（S12）：未组合测试。
- **L10 HMR 多次加载卸载**、**S13 同 session 多活动 agent**：未验证。
- **回执 meta 通道**：回执只走内容渲染通道，meta 通道未测。
- **多 scope 并发注册变更压力**：只覆盖单次变更的失效路径。
- **类型与打包门禁**、**插件公开 API 类型编译**、**设置面板的真实 DOM 渲染**、**当前 GUI 安装生效状态**。

## 4. 不支持（本版明确拒绝或列为不支持）

| 项 | 处置 |
|---|---|
| 无停顿的定义热替换 | 门禁与实际派发之间存在重新解析窗口，本版不承诺原子绑定 |
| 同一 session 多活动 agent 并发发请求 | 拒绝该组合（无法仅凭最近 header 无歧义绑定） |
| 非 native 展示模式 | 激活期即拒绝，不静默改模式 |
| 入口名冲突 | 检测后拒绝启用，不覆盖其它插件定义，不发布服务 |
| 完整同名双绑定（shadow）检测 | 需宿主新 API，本期不冒称覆盖 |
| 静默 LRU 卸载 | 不做；达上限提示显式卸载 |
| 按名称自动豁免框架工具 | 不做；只接受显式可信配置 |
| 查询 / 日志不可验证时的恢复 | fail closed，不降级为新会话 |
| 伪造宿主 `UNKNOWN_TOOL` 错误码 | 不做；拒绝理由与宿主错误码分列 |

## 5. 交叉审核结论（2026-10-06，已闭环）

依据内部证据 `plugin/reports/crossreview-adapter.md` 与主代理终审复核（原始命令与日志在该报告与 `plugin/audits/` 下，不随文档公开）：

- **D-1 修复：通过**。`journal.restore()` 的 `readSession` 失败分支一律 fail closed（`mode:'incompatible'`），与 02 §11、adapter 恢复判据及原审查 V16/O2 一致；mode 屏障与折叠判据构成纵深防御，无执行旁路。
- **入口错误外壳**：曾试行的 `ok:false` → 抛错映射被裁定为缺陷并已回滚——它违反 02 §10“其它失败用标准错误外壳”，并破坏冻结组合测试 S03c。现行行为：**三个入口对失败一律返回标准错误外壳 JSON 字符串，不抛**（§2.5）；激活把关由折叠侧 `isError` / `ok` 双判据承担。
- **原审查 cx4:77 断言为脚本缺陷**（与同审查者 cx3 明文的“handle* 返回外壳不抛出”契约矛盾）：corrected 反例 4/4 通过；原脚本不改，书面豁免留档于交叉审核报告。

残留签核债务（如实记录，不影响“工作区实现已验证”表述）：

1. entries 回滚修复的作者是交叉审核者本人、D-1 修复作者未署名——按“作者不自签”，两者留待下一次独立审查确认。
2. 观察项：fail-closed 分支事件缓冲不复位（既有行为、无权限影响）、原审查 cx 日志被复跑覆盖（已存档声明）、平台层参数校验文案不受协议外壳约束。
3. §0.2 的运行时稳定性与检索质量改动待非作者复核。

## 6. 状态更新的纪律

- 任何状态升级都必须有**报告路径 + 命令 + 退出码 + 未覆盖项**。
- 静态证据、设计推导与 mock 记录**不得**升级为“产品通过”。
- 作者不得为自己的安全边界补签；无合格独立核验者时写“未完成”。
- `03 §11` 的发布门槛未全通过前，对外只能称“工作区实现已验证”。
- **发布（源码基线）是一个独立于验收的里程碑**：它只登记“源码已一致整理并提交、推送与远端验证”，不得替代任何验收判定，也不得反过来推断产品可用。
- **报告历史不可改写**：内部证据 `plugin/reports/**` 与 `plugin/audits/**` 中的既有结论与数值按原样保留；本快照的订正只写在文档集内，并在 [06 §6](<06-rewrite-changelog.md>) 说明差异来源。
