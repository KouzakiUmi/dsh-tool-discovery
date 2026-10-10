# 渐进式工具披露（Progressive Tool Discovery）· 设计文档集

项目代号：**PTD**
日期线：2026-10-06（Asia/Hong_Kong）
目标内核：本机安装的 DeepSeek Harness Core **`0.2.1-alpha.1`**

本目录是 PTD 的**独立项目文档**。PTD 从用户需求与上表内核的公开接口直接出发设计，不承接、不迁移、不兼容任何其它实现；目录内所有规范以本文件集自身与 [`domain/`](../domain/) 、[`adapters/dsh/`](../adapters/dsh/) 的已实现内核为准（实现根目录已从早期代号 `progressive-v2/` 迁到 `plugin/`，见 [06 §6](<06-rewrite-changelog.md>)）。

## 1. 问题与方案一句话

工具定义在首轮就随完整 JSON Schema 注入，占用远超任务所需；PTD 改为**首轮只给三个小入口，模型显式选定后才在下一轮披露该工具的真实原生 schema**。

| 入口 | 回答的问题 | 主结果 | 是否改变激活集合 |
|---|---|---|---|
| `tool_list` | 某类别里有哪些可发现工具？ | 分页的完整名称 | 否 |
| `tool_search` | 哪个工具适合当前任务？ | Top-K 候选卡 + 短用途 + `ref`/`revision` | 否 |
| `tool_load` | 我要用哪些工具？ | 版本化成功回执 + 使用技能；下一轮披露 schema | 仅成功 `load`/`unload` |

```text
首轮：tool_list / tool_search / tool_load + 有界类别摘要（不预展开普通工具清单）

自然语言需求 → tool_search(category, query) → 候选 ref+revision ──┐
                                                                    │
浏览类别     → tool_list(category, cursor)   → 只有名称的分页 ──────┤
                                                                    ▼
已知精确名称 ──────────────────────────────→ tool_load(names | candidates)
                                                 │
                                    资格 / 版本 / 预算重新验证
                                                 │
                                    技能 + canonical 成功回执
                                                 │
                                    下一轮原生 tools 披露真实 schema
                                                 │
                                              调用原工具
```

`tool_load` 的“确认”是**模型显式选定**，不要求用户逐次点击，也不是对副作用的批准；两条加载路径都不执行目标工具。

## 2. 文档集

| 文件 | 内容 |
|---|---|
| [01 需求与架构](<01-requirements-and-architecture.md>) | 问题拆解、六类能力边界、分层架构、生命周期、安全与性能取舍 |
| [02 协议与数据模型](<02-protocol-and-data-model.md>) | 三入口参数契约、响应外壳、类别导航、状态机、预算表、错误码、恢复规则（**冻结**） |
| [03 实施与验收](<03-implementation-and-acceptance.md>) | 阶段划分、分工与文件所有权、验收矩阵 F/S/L 与阶段 0 G1–G8+S08、作者不自签规则、发布门槛 |
| [04 本机运行时证据](<04-runtime-evidence.md>) | Core `0.2.1-alpha.1` 公开接口的只读核验事实、宿主 seam 缺口、证据边界 |
| [05 当前状态](<05-current-status.md>) | 已验证 / 未验证 / 不支持清单；按**当前已发布基线**与**私有证据边界**记 |
| [06 重写变更说明](<06-rewrite-changelog.md>) | 本次文档集完全重写相对上一版的取舍，以及其后的追加订正 |
| [07 恢复与 fork 覆盖](<07-lifecycle-recovery-coverage.md>) | 恢复覆盖增强的 own-only 折叠、事件 `seq` 门禁、证据强度分级与结论口径（**已并入基线**；范围限当时的 3 个 code 文件，非产品验收） |
| [08 可信周期基线](<08-trusted-epoch-baselines.md>) | trusted-epoch 的契约、判据与配套门禁的进展与未覆盖项（**WIP，未验收**） |
| [09 业务逻辑地图](<09-business-logic-map.md>) | **派生整理稿**：分层职责、协议面、会话状态机与请求链路，以及按功能影响排序的待办问题与实测性能基线。非证据文档，不代表任何验收结论 |
| [10 上架与兼容声明](<10-store-compatibility.md>) | 固定 Commit 的上架契约逐项对照、逐版本兼容声明与证据来源、一次性 Profile 的安装/启动/卸载/恢复记录、已知未覆盖项（**顺带记录 npm/商城/真实 Profile 三种状态的区别**） |
| [11 代码审查发现与处置](<11-code-review-findings.md>) | 三份独立只读审查（安全边界 / 协议与内核 / 客户端与打包面）+ STORE 规则镜像复算的结论：已整改项各配门禁证据、未整改项写清为什么与可选方案及代价、以及必须写明的信任前提 |

跨文档一致的证据放在 `plugin/reports/` 与 `plugin/audits/` 下（阶段 0 合同与独立审查、domain API 与两轮独立审查、adapter 接口对照、实现报告与独立审查、质量数据计划）。本文件集引用它们作为证据，不复制其内容。

## 2.1 证据可见性：本地证据与公开文档的边界

本文件集**可以公开**作为设计规范，但私有质量数据与内部证据**不是公开产物的一部分**。引用必须区分：

| 类别 | 位置 | 是否公开 | 本文件集如何引用 |
|---|---|---|---|
| **公开设计文档** | `plugin/docs/**`、`plugin/README.md` | **是** | 可点击相对链接 |
| **实现源码** | `plugin/domain/**`、`plugin/adapters/**`、`plugin/contracts/**`、`plugin/tests/**` | **是** | 可点击相对链接 |
| **公开的组合测试夹具** | `plugin/fixtures/**`（`fixtures/tmp/**` 除外） | **是** | 可点击相对链接 |
| **公开的质量工装** | `plugin/quality/validate.mjs`、`plugin/quality/tools/**`、`plugin/quality/tests/**`、`plugin/quality/fixtures/catalog.invented.json` | **是** | 可点击相对链接 |
| **私有** | `plugin/quality/queries/**`、`plugin/quality/labels/**`、`plugin/quality/README.md`、`plugin/fixtures/tmp/**`，以及 `quality/fixtures/` 中除 `catalog.invented.json` 外的任何文件 | **否** | 以代码字体写出相对路径，**不建链接** |
| **内部证据** | `plugin/reports/**`、`plugin/audits/**` | **否** | 同上 |

**为什么私有项不建链接**：公开版里指向未发布目录的链接就是死链，会让读者误以为证据缺失或被删除。本文因此只写「状态摘要 + 私有证据路径」，路径对持有完整工作区的读者可直接定位，对公开读者则明确标注为内部材料。

**各验证命令的运行前提**（先看前提，再读结论）：

| 命令 | 运行前提 | 说明 |
|---|---|---|
| `npm test`（= `node --test plugin/tests/unit/*.test.mjs`） | 只需 Node（`client` / `settings` 两个文件依赖宿主，见根 README） | 单测唯一的仓库内文件依赖是公开的 `quality/fixtures/catalog.invented.json`（合成 protocol fixture，不含 held-out 数据） |
| `npm run test:composition`（glob 展开全部 `gate-*.test.mjs`） | **目标 DSH Core 安装在本 host 且提供被测宿主依赖与对应版本**。**Core 位于默认安装根时不设环境变量即可运行**；**仅当在其它机器或非默认安装根时才需用 `DSH_INSTALL_ROOT` 覆盖** | 组合测试经 [`contracts/install-resolver.mjs`](../contracts/install-resolver.mjs) 解析真实 Loader 与服务。**文件齐备、宿主到位即可运行；无宿主则不可运行**。新增 `gate-*.test.mjs` 自动纳入 |
| `npm run check` | 只需 Node（可选 git） | 包身份（`package.json` ↔ `cordis.patch.yml`、私有、无厂商 scope、无旧包名）与本文档集的相对链接 / 未测量声明检查，CI 调用同一脚本 |
| `npm run check:quality`（= `node plugin/quality/validate.mjs`） | **需完整内部资料** | 缺私有的 `quality/queries/` 与 `quality/labels/` 时必然报缺文件；**21 项 / 20 PASS / 1 FAIL 的结论只在完整内部资料下成立** |

`contracts/install-resolver.mjs` 的解析根是 `process.env.DSH_INSTALL_ROOT` 优先、否则回落到默认安装根（本机路径 `C:/Program Files/DSH NEXT/resources/app`）。因此 `DSH_INSTALL_ROOT` **不是无条件必填**：默认安装根下直接可跑，只有换机器或改用非默认安装根时才需要它；该覆盖与根 README 的说明一致。**产品代码不写绝对安装路径**，机器差异只出现在这个 resolver 里。

目录结构与复跑矩阵的原始记录在私有证据 `plugin/reports/structure-migration.md`；本文档集只保留它的结论，不复制其逐条表格。**报告历史不改写**——若公开口径与内部报告有出入，以本文档集为准并注明来源，原始报告按原样保留。

## 3. 冻结语义速查

以下数值与语义是**冻结**的，模型不可修改，实现见 [`domain/constants.mjs`](../domain/constants.mjs)。任何修改必须先改代码与验收，再同步本文档集。

| 项 | 冻结值 |
|---|---|
| `PROTOCOL_VERSION` | `2` |
| `ENTRY_TOOL_NAMES` | `tool_list` / `tool_search` / `tool_load` |
| `initialSchemaTargetTokens` | `2048`（**历史目标值，当前代码路径未强制**；不是实测的初始 2K 保证） |
| `maxInitialBytes` | `8192`（同上，历史目标值） |
| `maxInitialCategories` | `12`（受控分类的自然总数，用于自然遍历，**不是**权限门槛） |
| `defaultListLimit` | `20`（默认输出策略，始终有界） |
| `defaultSearchLimit` | `5`（默认输出策略，始终有界） |
| `listCursorTtlMs` | `900000` |
| `candidateTtlMs` | `900000` |
| 展示模式 | `native-only`（非 native 报 `INCOMPATIBLE_PRESENTATION`，不静默降级） |
| fork 选择继承 | `reset`（子会话不隐式继承父 `selected` / `ref` / `cursor` / `advertised`） |

### 3.1 可选限额：默认关闭

下列**硬上限默认全部关闭**（`null`），不构成本插件自带的风险阈值。`null` = 关闭；给出**显式正整数**即启用该项限额。`Infinity` 被 `resolveBudgets` 拒绝（无法进入 JSON）。

| 可选限额键 | 历史默认值（**已废弃**） | 当前默认值 |
|---|---|---|
| `maxActiveTools` | `12` | `null` |
| `maxActiveSchemaBytes` | `49152` | `null` |
| `maxLoadBatch` | `4` | `null` |
| `maxListLimit` | `20` | `null` |
| `maxSearchLimit` | `8` | `null` |
| `maxListResultBytes` | `4096` | `null` |
| `maxSearchResultBytes` | `6144` | `null` |
| `maxQueryCodePoints` | `512` | `null` |
| `maxSkillBytesPerLoad` | `12288` | `null` |

关闭硬上限**不等于**输出无界：`defaultListLimit`、`defaultSearchLimit`、分页与各项 TTL 仍然有界，只是默认策略之上没有额外天花板。

启用限额是有代价的权衡而非免费的安全加成：超限时只**拒绝新增项**（任何配置下都不会卸载已披露的工具来腾位），模型必须拆批，增加轮次、延迟与总成本，也可能诱使用户提前压缩——但同样可以选择**调高或关闭自己设置的限额**，这始终是最直接的出路。限额不等同于优化：默认建议保持关闭。

完整语义与逐项说明见[协议与数据模型](<02-protocol-and-data-model.md>)。

## 4. 三条不可让步的不变量

1. **不伪造授权**：目录、搜索结果、候选、用户文本都不是执行许可；`load` 的成功 canonical 回执是唯一的激活凭据。
2. **不绕过原执行链**：scope 可见性、原生审批、沙箱、参数校验、超时、取消、调度与 UI 展示一律由宿主继续负责。
3. **不静默降级**：无法证明安全或受支持时 fail closed（拒绝 / `STATE_NOT_READY` / `INCOMPATIBLE_*`），不猜、不补、不兜底。

## 5. 状态口径：已发布基线 ≠ 产品验收

整理完成 ≠ 发布完成 ≠ 产品验收 ≠ npm 发布 ≠ 安装生效，五者互不替代，任何一者的结论都不得外推到另一者。

> 仓库于 2026-10-06 重建，旧历史（`2a1f9c0`、`257ddc0` 等）已被重写移除、**不再可引用**。远端状态一律以提交记录与推送核验为准；新的事实由新的提交与文档修订承载，**不在 `main` 上直接改写**。

| 事项 | 当前状态 | 判据出处 |
|---|---|---|
| 源码基线**发布** | **已完成**：`main` 已发布，每次绿的 `main` 构建自动产出 GitHub Release 资产（构建产物，**不是**验收声明） | [05 §0](<05-current-status.md>) |
| 工作区独立门禁（单测 / 组合 / 质量工装） | 逐项数字与签署范围只在 05 一处维护，本文**不复写计数** | [05 §0、§1](<05-current-status.md>) |
| 恢复与 fork 覆盖增强 | **已并入基线** | [07](<07-lifecycle-recovery-coverage.md>) |
| 可信周期基线 | **WIP，验收未完成** | [08](<08-trusted-epoch-baselines.md>) |
| 产品验收（`03 §11` 发布门槛全通过） | **未达成**：性能 / 真实 wire / 检索门槛仍未验证 | [03 §11](<03-implementation-and-acceptance.md>)、[05 §3](<05-current-status.md>) |
| npm 发布 / 插件市场上架 | **未做** | [05 §1](<05-current-status.md>) |
| 安装到用户 profile 并在 GUI 生效 | **未做** | [05 §3](<05-current-status.md>) |

## 6. 阅读顺序

先读本文与 [02 协议](<02-protocol-and-data-model.md>)，再看 [05 当前状态](<05-current-status.md>) 判断哪些结论已有证据、哪些仍是设计目标；恢复与 fork 的分支增强见 [07](<07-lifecycle-recovery-coverage.md>)。**设计文档不等于实现已可运行**；发布判据只看[03 §发布门槛](<03-implementation-and-acceptance.md>)。
