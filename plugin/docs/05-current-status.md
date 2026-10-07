# 05 · 当前状态

截至 **2026-10-06**（Asia/Hong_Kong）。本文件只记录**有证据的结论**，并把每项标为 **已验证 / 未验证 / 不支持**。协议判据见[02](<02-protocol-and-data-model.md>)，矩阵见[03](<03-implementation-and-acceptance.md>)，接口事实见[04](<04-runtime-evidence.md>)。

## 0. 本快照的状态口径

> **版本坐标**：`main` / `origin/main` 同为**当前已发布的初始基线**（单一 initial-publish 提交）。本仓库于 2026-10-06 重建，旧历史（`2a1f9c0`、`257ddc0` 等 commit）已被重写移除，**不再可引用**；下文凡标注这些 ID 之处均为历史记录。恢复覆盖增强原位于分支 **`fix/lifecycle-recovery-coverage`**，其内容已并入当前基线。状态变更走正常分支与评审流程，不在 `main` 上直接改写；远端状态以提交记录与推送核验为准。

本文件的准确表述是：**已发布的初始基线 + 一条待复核签署的恢复覆盖分支**。它**不是**：

- 不是 [03 §11](<03-implementation-and-acceptance.md>) 发布门槛的产品验收；
- 不是 npm 发布或插件市场上架；
- 不是安装到用户 profile、也不是 GUI 生效。

整理完成 ≠ 发布完成 ≠ 产品验收 ≠ npm 发布 ≠ 安装生效，五者互不替代。本文件记录的是**该时点的观察**，不安排事后回头改写；新事实由新提交与新文档修订承载。

本文件各处的“已验证”一律指**工作区内的代码与测试证据**，不含任何安装或分发结论。

**核验范围声明（两条基线分开记，不得互相外推）**：

| 基线 | 范围与结果 | 签署状态 |
|---|---|---|
| 当前 `main`（**已发布基线**，含原分支内容） | unit **160 pass / 0 fail**；composition **42 pass / 0 fail**（14 + 7 + recovery 13 + event-seq 8）；质量工装单测 **14 / 0 / 1 skip**（符号链接平台 `EPERM`，记 **unknown**，不算通过）；validate **20 PASS / 1 FAIL**（类别资格 H037 ×2、H044 ×1），digest 全 PASS、**冻结数据未改动**、**评分 still not ready** | **独立门禁已通过**（**不等于**产品验收） |
| 恢复覆盖增强（原分支，内容已并入基线） | unit **160**；composition **42**（gate 14 + lifecycle 7 + recovery 13 + **event-seq 8**） | **源码已独立复审通过，范围限于当时的 3 个 code 文件**。**产品损坏日志价值、fork 长会话仍未验**；**不等于产品验收** |

- 入口执行语义（基线已定案，不因本分支改变）：现读代码正确——入口 `execute` 对业务失败**返回 `ok:false` + `error.code` 的 JSON 串，不外抛**；`scopeFromExec` 的 throw 在 `execute` 内被 catch 转成外壳。历史中把 `ok:false` 改为抛错的改动已被交叉审核裁定为缺陷并**回滚**；**「execute 单点抛错」的记忆说法是错的**。代码符合冻结 `S03c` 与 [02 §10](<02-protocol-and-data-model.md>)，**非发布阻断项**。
- **仍未验证**（不因任一基线而升级）：外部真实 provider wire、token/TTFT、检索质量门槛、**L04 compaction**、**L08 crash/fsync 窗口**、**L10 HMR**、**S12 非 native 组合**、**S13 同 session 多活动 agent**、多 scope 并发压力、回执 meta 通道、产品验收与安装生效。

### 0.1 可信周期基线（**进行中 / WIP**，本地开发分支 `feat/trusted-cache-epochs`）

> 分支口径：`feat/trusted-cache-epochs` 是**本地未提交、未推送**的开发分支；它携带的源码文件与本树
> 其余文件一样，在提交后随仓库**公开**，不因此成为私有代码。文档中的 `private` 一律只指**包未发布**。

- **目标**：移除冷恢复时以首请求 / `request`/`header` 内容反推常驻工具名单的授信，改为通过宿主
  提供的 storage domain 持久化**周期记录**，记录落盘后才允许出站；缺少记录的旧会话明确报错并阻止
  请求（旧会话仅经一次满足严格条件的真实用户 `/compact` 迁移）；已可信会话的手动与**自动**压缩
  仍正常采最新配置并换新周期。
- **现状**：源码侧**已初步实现**，**集成 / 测试套件验收尚未完成**；契约、判据与对应门禁见
  [08](<08-trusted-epoch-baselines.md>)。**本行不表示缺陷已修复**，也不表示任何门禁已通过。
- **本轮（额度刷新后继续）新增并已定位的三处缺陷**，均已修复；已获一次**非作者独立复审
  「通过」**（报告 `plugin/audits/trusted-epoch-fix-review-20261007.md`），命令与退出码见
  [08 §5.2](<08-trusted-epoch-baselines.md>)。**复审仍有 9 项未覆盖**，且留有一条 MEDIUM 契约
  级缺口（[08 §2.2a](<08-trusted-epoch-baselines.md>)，本轮**未修**），因此**不得**把本项
  整体写成「已验收」：
  1. **迟到到位绕过迁移**（授权面 HIGH）：`retryBaseline` 复用 bootstrap 路径而**不检查 own
     出站资格**，legacy 会话会在存储迟到时拿到一条**初始记录**并被授权 —— 反例门禁 `TE-LM`
     先行 RED（durable 侧确有 `trigger:'initial'` 记录），修复后 GREEN。
  2. **既有 fail-closed 被吞成 0 请求**（回归，破坏 `L11b` / `RB2`）：journal 损坏 /
     `readSession` 失败后账本**永远停在 pending**，投影把它当成「基线尚未落定」而整轮不发请求。
     已新增独立第四态 `failed-closed` 裁决，见 [08 §2.4b](<08-trusted-epoch-baselines.md>)。
  3. **恢复收尾覆盖在途迁移**（`TE4b`）：缓冲重放已在 live 链上完成迁移时，收尾的一次
     `ledger.load()` 会自增 revision 让迁移变成 superseded，并把尚未落盘的新 epoch 读成
     `MISSING` → 一次**真实成功的用户 `/compact`** 被判成 legacy，永久 0 请求。
- 本节**不改变**上文任何一行结论：header 授权缺陷**既未宣称已修，也不因此降级既有已验证项**；
  `07` 的结论同样保持不变。本包**未发布到 npm**，本轮源码版本为 `0.2.0-functional.5`
  （`0.2.0-functional.2` 已由 `build-c4a111c` 占用，不可复用）。
- **2026-10-07 追加一轮（分支 `feat/trusted-epoch-isolated-bad-record`）**：修 `08 §2.4c`
  末段此前如实记录为「未修」的**连坐**副作用 —— 存量里一条记录读不出来会让
  `facility.open(spec)` 对**整个域**抛错，于是**所有**会话（含记录完好、与那条坏行毫无
  关系的）一起停摆。修法是把 SDK 那层 schema 降为**传输层**（`z.unknown()`），判据全部
  移回本模块已有的逐会话校验器；**介质一行未动**，「不删 / 不 quarantine / 不覆盖」三条
  原则全部保持。受影响会话**仍**是 `INVALID` + 0 出站请求，无辜会话照常 ready 且出站。
  新增判据 `BR4`（先 RED 后 GREEN），并用变异把传输层改回 `strictObject` 证明门禁有分辨力。
  **本轮改了产品源码**，复跑 unit 283/0、composition 104/0；按「作者不自签」**仍需独立复审**。
  详见 [08 §5.3](<08-trusted-epoch-baselines.md>)。

## 1. 状态速览

| 阶段 | 状态 | 签核情况 |
|---|---|---|
| 阶段 0 宿主 seam 合同 | **已实现并经独立核验** | G1–G8 + S08 通过；**已签核**（限于 Core `0.2.1-alpha.1` 公开 seam） |
| 阶段 1 `domain` 内核 | **已实现**；两轮独立审查已完成 | 首轮独立审查判定不通过（D1/D2）；修复后经**独立复验通过**，单测 160 项全过 |
| 阶段 2 `adapters/dsh` | **已实现**；独立审查与交叉审核均已完成 | 原审查 13 项判据通过；D-1 修复经交叉审核核实通过；错误外壳契约经交叉审核恢复并全量复跑通过（残留签核债务见 §5） |
| 质量数据 | 数据冻结完成 | 21 项检查中 20 PASS / 1 FAIL，**评分暂不可发布** |
| 阶段 3 性能与真实 wire | **未开始** | 真实 wire、token、TTFT、检索门槛均未测 |
| 安装 / 发布 | **部分完成** | 源码基线已随 `main` 发布；**未安装、未启用、未构建产物、未上 npm** |
| 文档与路径口径整理 | **已完成** | 本文件集已按迁移后布局订正；**不升级以上任何一行** |
| 基线独立门禁（当前 `main`） | **已通过（限 §0 范围）** | unit 160/0、composition 42/0（含 `S03c`、recovery、event-seq）、质量工装 14/0/1 skip、validate 20PASS/1FAIL |
| 可信周期基线（见 §0.1） | **已初步实现 / WIP，验收未完成** | 契约、判据与门禁见 [08](<08-trusted-epoch-baselines.md>)；三处修复已获**非作者独立复审「通过」**；另新增 2 份门禁（failclosed / badrecord）并接入 `package.json` 与 CI，unit 283/0、composition 101/0（均 exit 0）；**`08 §2.4c` 的「坏记录连坐」副作用已于 2026-10-07 修复**（composition 104/0，变异验证过，**未经独立复审**）；**复审其余未覆盖项 + 一条 MEDIUM 契约级缺口未修**，**无验收结论** |
| 恢复覆盖增强（内容已并入基线） | 已合并；源码曾经独立复审（限 3 个 code 文件） | composition 42（14 + 7 + recovery 13 + event-seq 8）；**不等于产品验收**；见 [07](<07-lifecycle-recovery-coverage.md>) |

## 2. 已验证

### 2.1 阶段 0：宿主 seam 合同（G1–G8 + S08）

- 在 Core `0.2.1-alpha.1` 的真实 Loader composition 上通过：首请求只含三个入口（inherited 与 scope-own 普通工具同时隐藏）；猜测隐藏工具名的执行 body 计数为 0，且两种可见性有**可执行正控制**（证明不是“工具根本不可执行”造成的假通过）；成功 `tool_load` 后下一轮出现原生 schema 而原定义对象未变；原生参数校验与真实审批链仍能拒绝已加载工具；成功回执经真实持久化并由公开 query 冷读回放可见（跨进程验证）；`request/header` 与宿主 tool-addition 真实变化；`unload` 后 tool-removal、历史保留与拒绝执行；显式保留的框架终止工具生效而名称形似诱饵仍被隐藏；同一响应内 `load` 与猜隐藏调用并存时被拒。
- 独立审查在隔离镜像中逐字节复制被审文件（哈希一致）复跑，并补充反例：伪回执激活、预写结果、候选路径与错参早失败。**未发现门禁旁路或虚假通过机制**。
- 审查保留一项如实记录的判别发现：门禁对**根本未注册的名字**也报与隐藏工具相同的拒绝文案。产品据此明确“**调用面不区分存在性**”，并由代码以统一文案落实（见 `02` §10）。

### 2.2 阶段 1：`domain` 内核

- 宿主无关：全部 import 仅为 `node:crypto` 与域内相对模块；不导入 Cordis / 宿主包。
- 单测 **160 项全过**（`node --test`，显式列出 [`tests/unit/`](<../tests/unit/>) 下 8 个 `*.test.mjs`；Windows 不能把目录当模块）。静态清点为 8 文件共 160 个 `test(...)`，与实测数一致；**本轮独立实跑同为 160 pass / 0 fail**（见 §0 范围声明）。
- 首轮独立审查（V/R3，非作者）判定 **不通过**，两项实证缺陷：
  - **D1**：`load` 的候选路径未检查入口 / 框架保留项保护，可经 `search → load(candidates) → 折叠` 把框架项放入 selected（名称路径正确拒绝，控制组通过）。
  - **D2**：保护集合在引擎构造时一次性快照，不随目录刷新更新。
- 修复后由**非作者**独立复验：源码逐项核实四处修复（保护检查对称化、折叠侧双重拦截、保护集合动态化、4 个回归测试），全量复跑 160/160、边界反例 24/0、保护反例 17/0、组合门禁 14/14，并自建 17 项反例全部通过且**未误伤普通工具**。原审查中“入口 / 框架项不可 load / unload”一项由不通过转为**通过**，无回归。
- 折叠安全边界（回执归属、输入路径重算、候选 `ref` 交叉、五字段完整重算、`isError` 与协议 `ok` 双条件、改写拒绝、冷恢复名称不升级）均经源码与反例双重核验通过。

### 2.3 阶段 2：`adapters/dsh` 实现与首轮独立审查

- 组合门禁 **14 项全过**（[`gate-adapter.test.mjs`](../tests/composition/gate-adapter.test.mjs)，= 5 个场景测试 + 9 个 `gate()` 判据 F01 / S01 / S02 / S08 / F03pos / S06 / F20 / L09 / COMP），覆盖 F01 / S01 / S02 / S08 / F03 正控制 / S06 / F20 / L09 / 组合不兼容；每条安全断言均配正控制。
- 另有一组生命周期组合测试 **7 项全过**（[`gate-adapter-lifecycle.test.mjs`](../tests/composition/gate-adapter-lifecycle.test.mjs)），覆盖候选卡 `ref+revision`、跨会话 `ref` 拒绝、`unload` 的移除 / 拒绝 / 历史保留、以及重开 composition 的冷恢复选中。
- **本轮独立实跑：组合两文件合计 21 pass / 0 fail**（14 + 7），其中 `S03c` 在真实 composition 上通过。
- 首轮独立审查（V/R3，与产出方不同源）判定 **不通过**：13 项判据通过，1 项缺陷
  **D-1** —— 恢复时 `readSession` 失败且缓冲内无工具事件，走“新会话”分支把状态置为就绪，违反 fail-closed 语义（对应 L11）。
- 审查同时确认：产品代码无绝对安装路径、未使用已弃用的同步快照接口、`visibility` 不进模型可见文案、不伪造 `UNKNOWN_TOOL`、`applyCanonicalPair` 只在 canonical 对上被调用、整组回滚无孤儿 listener / 门禁。

### 2.4 质量数据

- 冻结评分输入摘要：`sha256:d3ff166099e1f1a380f36eabbc928f7573feebb885025f3fcd1c45bb79140b4e`，**未变**。
- 质量验证器 [`quality/validate.mjs`](../quality/validate.mjs)（公开）共注册 **21 项**检查，本轮独立实跑 **20 PASS / 1 FAIL，退出码 1**。失败项为类别资格：两条 held-out 样本的期望答案落在其 `category` 之外，类别内检索不可达（H037 ×2、H044 ×1）；验证器只如实列举全部不匹配项，不修改数据。**digest 相关检查全部 PASS**，**冻结数据未改动**。**该结论依赖私有的 `quality/queries/` 与 `quality/labels/`，只在完整内部资料下成立**；无这两者的 checkout 无法复现该退出码。
- 结论：**评分暂不可发布（still not ready）**。该摘要只证明评分输入一致，**不证明**语义正确或真实目录下的检索效果；标注为 AI 合成，未经人类专家审核。
- 冻结工装的排他创建缺口（撞名覆写）已由独立作者改为真实文件系统原子排他创建并经反例复验；该路径通过**不等于**全部冻结与别名安全关闭。
- 20 PASS / 1 FAIL 是**当前快照的如实状态，不得改写为通过**。修复须走显式新版本 / 新冻结并由独立于作者的人员审查标签语义，详见私有材料 `plugin/quality/README.md` 与 `plugin/reports/quality-plan.md`。
- 冻结工装单测本轮独立实跑 **14 pass / 0 fail / 1 skip**；该 skip 为符号链接场景，平台返回 `EPERM`，**记为 unknown，不计入通过**。

### 2.5 三条失败语义的实际归属（已独立定案）

| 语义 | 实际形态 | 代码位置 |
|---|---|---|
| 协议失败 | `ok:false` + `error.code` 的 JSON 字符串，作为**成功返回的结果文本**；入口 `execute` **不外抛** | [`domain/engine.mjs`](../domain/engine.mjs) `failEnvelope` → [`adapters/dsh/entries.mjs`](../adapters/dsh/entries.mjs) |
| 执行门禁拒绝 | 门禁返回拒绝理由字符串，目标 body 不运行；**不是** `execute` 返回值 | [`adapters/dsh/guard.mjs`](../adapters/dsh/guard.mjs) |
| 宿主原生错误 | 宿主自身 `error.code`；本插件不伪造、不代称 | 宿主执行链 |

**独立核验批次 1 结论**：现读代码正确——入口 `execute` 对业务失败返回外壳串、不外抛；`scopeFromExec` 的 throw 在 `execute` 内被 catch 转成同一外壳。历史中把 `ok:false` 改为抛错的改动已被交叉审核裁定为缺陷并回滚。`S03c` 在真实 composition 上通过，**符合冻结契约，非发布阻断项**。「execute 单点抛错」的旧记忆说法**不成立**。

`02` §2 与 §12 第 10 条记录了这一区分，并已把「不得把 `ok:false` 当成功返回」的落点澄清为 **reducer / 恢复激活判据**（§11 第 12 条双条件），**验收标准本身未改动**。

### 2.6 工具增减与缓存一致性（2026-10-07 新增）

- **覆盖现状**：新增之前，工具**减少**这条路径在组合层**零覆盖** —— 既有的
  `registry-churn` fixture 只会**增加**工具，`unit/registry.test.mjs` 的 R5 只覆盖**代次**。
  而真实环境里减少确实发生过（[07](<07-lifecycle-recovery-coverage.md>) 与
  `unload-diagnosis-handoff.md` 记录的实测：出站 header 工具数 28 → 26）。
- **门禁**：[`gate-tool-churn.test.mjs`](../tests/composition/gate-tool-churn.test.mjs)
  （`TC1` 真实移除已 selected 的工具 → 执行 body=0 / 旧 ref 失效 / 无关工具不受影响；
  `TC2` 移除后重加 → 旧选择不得复活、必须重新 load）。fixture 为
  [`removable-tool.mjs`](../tests/composition/fixtures/removable-tool.mjs)，通过 dispose
  该 entry 的 fiber 取得**真实移除**，不是构造出来的边角。
- **本轮定位并修复的真缺陷**：移除 → 重加 → 重新 `tool_load` 之后，该工具**永久**停在
  `TOOL_NOT_ADVERTISED`。根因是宿主侧的事实：`@deepseek-ai/dsh-agent-loop` 的
  `buildRequest` **只在 header 发生变化时**才 append `request/header`
  （`!headerEquals(baseline, header)` 才写，外加首次 / 新请求序列）。而出站 wire 在这一段
  **逐字未变**（`frozen` 披露缓存一直留着那份定义，实测 6 次出站全都带着它），于是宿主
  不发事件；而 `invalidateTool`（移除时）与 `reducePair`（换版本时）都已清掉 `advertised`
  —— 两头一夹，记账永远补不回来。修法见 [`journal.mjs`](../adapters/dsh/journal.mjs)
  的 `applyAdvertisementPass` / `replayAdvertisements`：记住最后一次观测到的 header，
  在 load 折叠成功后据此重放一次对账。**没有放宽任何拒绝判据**（digest 仍逐字比对，
  `currentRequestId()` 仍指向同一 header seq）。
- **由此确立的一条实现事实**：`request/header` **不是**「每个出站请求都有」的事件。任何依赖
  「下一轮必然有 header 事件来刷新记账」的写法都会踩这个坑。

## 3. 未验证

- **外部真实 provider wire**：现有录制面是最终请求对象，不是外部 wire。
- **token 与 TTFT**：初始工具相关 token 减少、P95 检索延迟、首次有效工具延迟的 A/B/C 实验全部未做。
- **搜索质量门槛**：held-out Recall@5、负例误命中率、模型正确选定率均未产出；数据本身尚不可发布。
- **冷恢复端到端链路**（L01/L04/L08）：恢复链路的**分支语义与 fork/unload/候选/资格恢复**已在分支上取得实证（见 [07](<07-lifecycle-recovery-coverage.md>)）；但 **L04 compaction、L08 crash/fsync 窗口仍未驱动，仍记为未验证**。
- **fork / compaction / resume 全量语义**（L01/L03/L04）：**真实宿主 fork seam** 的恢复与不继承语义已在分支上取得实证（见 [07](<07-lifecycle-recovery-coverage.md>)）；**L04 compaction 仍未驱动**，仅内核单测层覆盖。
- **canonical `tool/result` 的 seq 门禁**：分支新增 seq 校验与封存路径及 8 项 event-seq 套件（composition 42）。**该层源码已由独立会话复审 GREEN_REVIEW_PASS，范围限于本轮 3 个 code 文件**；真实总线方法学亦已定（`session.append` 以自身 `SessionSeq` 校验才 emit：正常轮次 19 事件 / 13 类型折叠成功；合法伪造 seq 9000/9001 被 projection 以 missing seq 19 拒、journal 未收到；畸形 seq 被 `SessionSeq` 拒、journal 未收到）。**据此仅正常 bus 路径已实证，异常防御回归是直驱 `journal.onEvent` 的合成，真实宿主畸形总线未覆盖，持久化损坏日志的端到端取证价值仍未验**。出站 mock provider 录制只是装配证据，**不是真实 provider wire**。
- **子代理真实委派链**：**fork** 走真实宿主 seam 已覆盖（分支）；**普通 spawn** 仍以 scope 注册模拟，真实委派链未接入。
- **非 native 展示模式、完整 prompt 组合、其它 waterfall 重新加工具**（S12）：未组合测试。
- **L10 HMR 多次加载卸载**、**S13 同 session 多活动 agent**：未验证。
- **回执 meta 通道**：回执只走内容渲染通道，meta 通道未测。
- **多 scope 并发注册变更压力**：只覆盖单次变更的失效路径。
- **类型与打包门禁**、**插件公开 API 类型编译**、**当前 GUI 安装生效状态**。

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

依据内部证据 `plugin/reports/crossreview-adapter.md` 与主代理终审复核（独立复跑 unit 160/0、组合门禁 14/0、生命周期 7/0；原始命令与日志在该报告与 `plugin/audits/` 下，不随文档公开）：

- **D-1 修复：通过**。`journal.restore()` 的 `readSession` 失败分支一律 fail closed（`mode:'incompatible'`），与 02 §11、adapter 恢复判据及原审查 V16/O2 一致；mode 屏障与折叠判据构成纵深防御，无执行旁路。
- **入口错误外壳：曾试行的 `ok:false` → 抛错映射被交叉审核裁定为缺陷并已回滚**。该映射违反 02 §10「其它失败用标准错误外壳」，并破坏冻结组合测试 S03c（失败结果须可 JSON.parse 且保留 `error.code`）。现行行为：**三个入口对失败一律返回标准错误外壳 JSON 字符串，不抛**（见 §2.5 与 [`entries.mjs`](../adapters/dsh/entries.mjs)）；激活把关由折叠侧 `isError` / `ok` 双判据承担。
- **原审查 cx4:77 断言为脚本缺陷**（与同审查者 cx3 明文的「handle* 返回外壳不抛出」契约矛盾）：corrected 反例 4/4 通过；原脚本不改，书面豁免留档于交叉审核报告。

残留签核债务（如实记录，不影响"工作区实现已验证"表述）：

1. entries 回滚修复的作者是交叉审核者本人、D-1 修复作者未署名——按「作者不自签」，两者留待下一次独立审查确认。
2. 观察项：fail-closed 分支事件缓冲不复位（既有行为、无权限影响）、原审查 cx 日志被复跑覆盖（已存档声明）、平台层参数校验文案不受协议外壳约束——处置依据见交叉审核报告「未决」节。

## 6. 状态更新的纪律

- 任何状态升级都必须有**报告路径 + 命令 + 退出码 + 未覆盖项**。
- 静态证据、设计推导与 mock 记录**不得**升级为“产品通过”。
- 作者不得为自己的安全边界补签；无合格独立核验者时写“未完成”。
- `03 §11` 的发布门槛未全通过前，对外只能称“工作区实现已验证”。
- **`initial publish`（源码基线发布）是一个独立于验收的里程碑**：它只登记“源码已一致整理并完成提交、推送与远端验证”，不得用它替代任何一条验收判定，也不得反过来推断产品可用。**截至 2026-10-06 该里程碑尚未达成。**
- **报告历史不可改写**：内部证据 `plugin/reports/**` 与 `plugin/audits/**` 中的既有结论与数值按原样保留；本快照的订正只写在文档集内（例如目录路径迁移、`execute` 返回外壳 vs 抛错的措辞），并在 §0 / [06 §6](<06-rewrite-changelog.md>) 说明差异来源。
