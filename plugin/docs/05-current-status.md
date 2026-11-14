# 05 · 当前状态

更新日期：**2026-11-14**（Asia/Hong_Kong）。对应源码 manifest `0.7.0`：宿主支持收敛为 **DSH Core `0.2.2-rc.1`+**，整套实现按准入设计重写（规格见 [14](<14-rc1-redesign.md>)），旧投影/epoch/journal/PTC/描述精简子系统整体移除。npm 发布状态以 registry 为准。
现行行为见 [00 当前实现契约](<00-current-contract.md>)，验收判据见 [03](<03-implementation-and-acceptance.md>)。
本文不登记未经重新核验的远端最新发布、STORE 收录或在线安装状态。

## 0. 状态口径

“实现存在”“测试通过”“非作者有限核验”“完整产品验收”“分发”“安装生效”是不同结论。
旧文件中的“本轮”“当前宿主”“未发布”“待合并”仅在其取证时点成立，不自动滚动到今天。
历史记录保留在 [04](<04-runtime-evidence.md>)、[06](<06-rewrite-changelog.md>)、[07](<07-lifecycle-recovery-coverage.md>)、[08](<08-trusted-epoch-baselines.md>)、[10](<10-store-compatibility.md>)、[11](<11-code-review-findings.md>) 与私有证据中。

**版本坐标**：本源码 manifest 为 `0.7.0`、协议版本 `3`（仍是 3，协议未变）。npm 发布与 provenance 以 registry 为准；GitHub Release/tarball 不能替代 npm 发布证明。

### 0.1 版本与兼容

- 包版本：`0.7.0`；协议版本：`3`（不再与 0.5.x 的 `2` 兼容，调用处须显式传 3 或依赖默认）。不要把包版本当 Core 版本。
- 安装准入由 `engines.dsh` = `>=0.2.2-rc.1` 声明（0.2.2-rc.1 的 app-boot 有它时只按它判定，不再逐个比对含 optional 在内的 dsh peer）；Core peer 范围同为 `>=0.2.2-rc.1`。`@deepseek-ai/dsh-llm` 与 `@deepseek-ai/dsh-tool-executor-ptc` peer 已随 0.6.0 移除。
- `dshReleases`：`0.2.2-rc.1` 为 `compatible`，`0.2.1-alpha.1`/`0.2.1-alpha.2`/`0.2.0-rc.2` 为 `incompatible`；0.2.2 更晚版本未逐一验收。
- `schemastery` peer 为 `>=3.18.5-alpha.1 <4`（0.2.2-rc.1 自带 `3.19.0`）。
- 组合测试锚点为 `.probe/install-root-rc1`（从 DSH NEXT `2.0.22-next` 桌面壳 `app.asar` 解包；Core / dsh-tools / executor 均为 `0.2.2-rc.1`，Cordis `4.1.0`）。这不是逐版本兼容声明。

### 0.3 本轮运行证据（2026-11-14，0.7.0 工作区）

Node **v24.13.0**（单测）与锚点捆绑 Node（组合）；`DSH_INSTALL_ROOT` 指向 `.probe/install-root-rc1`。未安装、未重启、未访问在线 GUI、未跑真实 provider。

| 本次实际执行 | 结果 |
|---|---|
| `npm test`（单测，含 client/settings 宿主绑定用例） | 499 tests / **495 pass / 0 fail / 4 skip**（skip 为锚点缺 `react-reconciler` 的渲染用例） |
| `npm run test:composition` | **92 pass / 0 fail / 0 skip**，含本轮新增 `gate-disabled-presets`（5）与 `gate-volatile-live-config`（7） |
| `npm run check` | 通过（identity + 258 条相对链接） |
| `npm run check:quality` | 1/21 未通过（H037/H044 类别期望误标），输出与改动前逐字相同，冻结标签未改 |

**覆盖缺口（必须与本轮结果一起读）：**

- CI 的 `portable-unit` 显式排除 `client.test.mjs` 与 `settings.test.mjs`（需真实 DSH 安装），`composition` 与 `quality` 只在 `workflow_dispatch` 下运行且托管 runner 无 DSH Core 会跳过。因此**本轮最重的修复（volatile 撕裂、guard fail-open、畸形绑定隔离、设置页热改）不在 tag/push 发布链的自动覆盖内**，上表本地结果是它们的唯一证据。
- 发布前要求的独立只读交叉核验**未完成**：两次子代理在完成前失败（未返回结论）。记录为未核验，不以实现者自验替代。
- 未覆盖：真实 provider wire、token/TTFT 净收益、浏览器 GUI 实际操作、Profile 安装、0.2.2-rc.1 之外的版本。

### 0.2.5 历史优化验证（2026-11-07，0.6.0 工作区）

目标锚点为 `.probe/install-root-rc1`，真实公共服务 + mock provider + 测试私有存储。单测使用 Node v24.13.0，组合使用捆绑 Node v24.21.0；未安装、重启或访问在线 GUI。

- 全量单测：482 pass / 0 fail / 4 skip（486，exit 0）；跳过项为锚点缺 react-reconciler 的渲染用例。
- 全量组合：81 pass / 0 fail / 0 skip（exit 0），含新增 11 项撤权/恢复/配置/步骤/掩码边界覆盖。
- 仓库一致性与 diff 空白检查通过。质量集保留 H037/H044 既有三项跨类别期望问题，冻结标签未改，不发布评分。
- 20 次 load/unload 循环：纯掩码引发的全会话目录刷新 40 → 0；保留 filter 引用 41 → 1，实际安装均为 1 层。这是特定测试的事件/引用计数，不是 token 或时延收益。

当前实现采用 storageDomain 快照/delete、晚 seed 撤销墓碑、open 排队与关闭排空；混批 unload 原子校验；toolSet 绑定步骤准入快照；常驻配置 engine/mask/guard 同源；掩码旧引用及时回收。持续 I/O 错误下 durable 仍是 best-effort。

### 历史迁移记录（2026-11-06，0.6.0 工作区）

Node **v24.21.0**（DSH NEXT 运行时自带）。`DSH_INSTALL_ROOT` 指向 `.probe/install-root-rc1`；TMP 指向工作区私有目录。真实 provider、模型行为、在线 GUI、Profile 安装与 HMR 均未验收。

| 本次实际执行 | 退出码 | 结果与边界 |
|---|---|---|
| `npm run check`（identity + docs 链接 + git diff） | 0 | 通过 |
| `npm test`（unit） | — | 迁移中：单元套件由子代理批量重写，本记录时未完成全绿；基线 428 pass / 291 fail / 133 total |
| `npm run test:composition`（真实 Loader + mock provider + 测试自有临时存储） | — | 迁移中：组合套件由子代理批量重写，本记录时部分门禁（adapter 主链、mask、terminal、PTC SDK 同源、in-history unload）已 19/19 绿，其余分批推进；完整结果待全量 |
| `npm run check:quality` | — | 依赖未公开评分集，本记录未复跑 |

产品侧本批改动：`createDiscoveryEngine` 显式 `protocolVersion: 3`；`mask` 加 `getAlwaysVisible` provider（掩码 allow-list 并入常驻）；`agent/created` 内同步 `lifecycle.runtimeFor` 再 `mask.ensure`（修复首轮 own-scope 逃逸）；`requireState` 不覆盖既有锁、disposed 即 `ENGINE_DISPOSED`；`handleLoad` 的 alwaysVisible 在 tolerant 模式不写 selected（改 `alreadyResident`）；`errorCodes` 补 `ENGINE_DISPOSED`；`locale` entry 表补 `tool_unload` 双语；`client.js` FIXED_ENTRIES 同步为 4。配置 schema 保留 inert 字段：`ptcCompatibility`/`compactBuiltin*`/`requireTrustedEpoch(+ForSubagents)`/`allowMissingSessionQuery`。

### 0.2 本次运行证据（2026-11-06，DSH Core 0.2.2-rc.1 适配，未提交工作区）

Node **v24.21.0**（DSH NEXT 运行时自带）。`DSH_INSTALL_ROOT` 指向从 DSH NEXT `2.0.22-next` 桌面壳 `app.asar` 解包的私有锚点 `.probe/install-root-rc1`（Core / dsh-tools / executor 均为 `0.2.2-rc.1`，Cordis `4.1.0`，schemastery `3.19.0`）；锚点缺 `react-reconciler`。TMP 指向工作区私有目录。

| 本次实际执行 | 退出码 | 结果与边界 |
|---|---|---|
| 全量 unit | 0 | **679 pass / 0 fail / 4 skip**（683）；跳过项为锚点缺 `react-reconciler` 的客户端渲染用例，非浏览器 DOM 验收 |
| 全部 `gate-*.test.mjs` composition | 0 | **173 pass / 0 fail / 6 skip**（179）；4 条内置描述精简用例在 provider-owned 宿主按能力跳过（rc.1 行为由 "rc.1 native leaves provider-owned builtin descriptions intact…" 覆盖），2 条为既有 rc.3 指纹门槛；旧宿主独有断言位于 `legacyHost` 分支，**本机无旧宿主安装，该分支本次未实跑** |
| `npm run check` 与 `git diff --check` | 0 | 包身份、双语文档和相对链接通过 |

改动前同一锚点基线为 unit 661/5/3、composition 144/31/2（31 个失败多为旧宿主独有断言、测试搭建不经 `agent/created`、冷恢复首轮中止三类，没有隐藏工具被执行的证据）。本批产品改动：`engines.dsh` 安装准入；resume 有 own 历史时创建期有界（3 秒）等待冷恢复再装掩码；激活前私有 registry 形状自检；自有掩码引起的 `tools/change` 跳过全量重算；压缩中止双语重发提示。真实 provider、模型行为、在线 GUI、Profile 安装与 HMR 均未验收。

### 0.2.0.1 历史运行证据（2026-11-01，v0.5.1）

以下“本次”仅指该批次。2026-11-01，Node **v24.13.0**。产品代码对应修复提交 `23e61a5`（在 `ac37bbc` 请求形状统一之上补在途 load 口径与纯空白 cursor），发布准备仅更新版本与文档。本机全局 npm 树中的两棵 DSH 安装已于 10-30 被清空，旧锚点不可复用；本次 `DSH_INSTALL_ROOT` 指向从桌面壳 `app.asar` 解包的 `dsh/` 子树（Core 全量依赖与原生 unpacked 模块齐备，desktop `0.2.1-rc.5`），react / react-reconciler / scheduler 由本机 npm 缓存离线装入同一锚点。

| 本次实际执行 | 退出码 | 结果与边界 |
|---|---|---|
| 全量 unit，包括 client/settings | 0 | **654 pass / 0 fail / 0 skip**（含本批新增 3 条回归钉）；客户端使用真实 React 19.2.8/reconciler 0.32.0 与 schemastery，非浏览器 DOM 验收 |
| 全部 `gate-*.test.mjs` composition | 0 | **151 pass / 0 fail / 2 skip**；2 条 BCD 指纹测试按设计仅在 `dsh-tools 0.2.1-rc.3` 执行，锚点为 rc.5 时跳过（fixture 冻结在 rc.3，不重标）；真实 Loader、mock provider 与测试自有临时存储，不调用真实模型 |
| 仓库一致性与 `git diff --check` | 0 | 包身份、双语文档和相对链接通过 |
| `npm pack --ignore-scripts --dry-run --json` | 0 | 43 文件，解包 674,635 字节（tarball 235,081 字节），载荷只含声明的 files 范围；发布后仍需核验实际分发资产 |
| 质量数据集 validator | 1 | 20 PASS / 1 FAIL，唯一 FAIL 仍是已记录的 H037/H044 类别期望误标（见 0.3 与 Known issues），非本批新增 |

质量数据集未修改冻结标签，不据此发布搜索评分。真实 provider、模型行为等价性、token/TTFT、在线 GUI、安装与完整 HMR 均未在本次验收。宿主绑定两文件的通过依赖解包锚点与缓存离线安装，不是"默认锚点开箱即绿"；解包锚点是本机临时产物，不随仓库分发。

### 0.2.1 历史运行证据（2026-10-26）

以下“本轮/本次”仅指此历史批次，不覆盖上面的 0.5.1 运行结果。

2026-10-26，Node **v24.13.0**。产品代码对应 `16208ccd924d1671f5e6450346dab7cdab4dd9ae`，发布准备仅更新版本与文档。

| 本次实际执行 | 退出码 | 结果与边界 |
|---|---|---|
| 全量 unit，包括 client/settings | 0 | **642 pass / 0 fail / 0 skip**；客户端使用真实 React/reconciler 与 schemastery，非浏览器 DOM 验收 |
| 全部 `gate-*.test.mjs` composition | 0 | **153 pass / 0 fail / 0 skip**；公共 DSH 服务 `0.2.1-rc.3`、真实 Loader、mock provider 与私有临时会话存储，不调用真实模型 |
| 仓库一致性与 `git diff --check` | 0 | 包身份、双语文档和相对链接通过 |
| `npm pack --ignore-scripts --dry-run --json` | 0 | 校验文件范围与描述策略、Host/Client/domain 入口；发布后仍需核验实际分发资产 |
| 有界独立源码与测试设计复核 | — | 原严格周期持续阻断、翻译键及组合测试时点问题已闭环；不替代浏览器、真实 provider 或全版本验收 |

质量数据集仍有 H037/H044 的三个类别期望误标，validator 为 20 PASS / 1 FAIL；未修改冻结标签，不据此发布搜索评分。真实 provider、模型行为等价性、token/TTFT、在线 GUI、安装与完整 HMR 均未在本次验收。

### 0.2.2 历史运行证据（2026-10-24）

以下“本轮/本次”仅指此历史批次，不覆盖上面的 0.5.0 运行结果。

2026-10-24 整合 PR #21（`d1aa807`）热路径性能与检索排序批次并准备 `v0.4.4`。Node **v24.13.0**。上一批（2026-10-21，`fcdb348`×`c1709d3` 整合）的证据移入 0.3 节的历史口径，不在本轮重复宣称。

| 本次实际执行 | 退出码 | 结果与边界 |
|---|---|---|
| 显式排除 `client.test.mjs`、`settings.test.mjs` 后运行全部 unit 文件 | 0 | **549 pass / 0 fail / 0 skip**；含 6 项新增检索回归（稀有词优先、概念三档、3+ 词置换一致、词干守卫、新同义词组端到端与负面）；两份宿主绑定文件仍是排除，不是通过 |
| 新旧实现差分探针（私有 `.probe/crosscheck-a/b/c`） | 0 | canonical 20034 例输出与报错逐字一致；registry 15 场景（含非枚举/原型/toJSON/BigInt/循环引用）绑定代次一致；guard 31 样本 30 一致，1 项为已记录的 PTC 日志载荷对齐（模型可见文案不变）；journal 广告记账与放行条件等价 |
| `npm run check`（仓库身份与文档链接） | 0 | 全部通过 |
| `node --check`（本批改动文件：canonical、search、constants、journal、registry、guard、names-drift） | 0 | 语法检查，不等于类型检查、Loader 或 GUI |

上一批 2026-10-21 整合时的对应记录（544 pass / 0 fail、business/catalog 回归 16/16 与 14/14、`node --check` 五文件）仍按原时点成立；本批微基准（`bindingsFor` 200 条不变绑定约 4.3ms→0.8ms、单 schema digest 约 -20%）在私有 `.probe/bench-hot-paths.mjs`，属工作区测量，不是端到端时延验收。

`npm test` 全量、真实 Loader composition、质量评分、真实 provider、当前 GUI 与安装均**未在本轮执行**。

修复前人工反例中，258 字节上限被同 ID 的 1213 字节新 schema 绕过，另一项小工具反被旧预留阻塞。现在按整笔回执的当前定义版本核算预留，不把旧 ID 预留借给新 schema；任一项移除/换版则整批不计费，但不提前取消操作，也不释放独立 selected/frozen。资格代次改变时，已无法使用的游标立即回收；无变化/校验失败仍保留有效游标。

游标测试只在同步构造期观察原生 Map 分配并立即恢复全局，不替换业务方法；证明记录数回收，不是 RSS/TTFT 实测。前轮 VM client 测试也不是 React/DOM 渲染。生产 registry 仍为 `skill:null`。
精确 portable 命令见[开发指南](<../README.md#portable-unit-subset>)；本次整合日志为私有 `.probe/publish-github-20261021-portable.log`。整合前 533 项、红转绿和负控制日志仍保留原文件，不冒充本次整合结果。

候选 ref 在 `tool_load` 接纳时校验；已接纳操作在资格代次未变时以逐字匹配的 canonical 回执提交，不因等待期间 ref 到期而撤销。DI6b 回归覆盖 ref 到期后的热态提交与冷恢复一致性；目录资格变更仍会使旧候选失效。该修复不解决检索通用动词误召回或 PTC SDK 冻结。
`npm test` 全量、真实 Loader composition、质量评分、真实 provider、当前 GUI 与安装均**未在本轮执行**。

### 0.3 历史测试不等于本轮通过

| 时点/版本 | 原记录 | 如何使用 |
|---|---|---|
| 2026-10-10/11，`0.3.0` × Core alpha.2 | 后次复跑 401 unit / 137 composition；一次性 Profile 记录 | 见 [10](<10-store-compatibility.md>)；不证明 `0.4.2` 在新 Core 上通过 |
| 2026-10-13，卸载/activation 修复 | 419 unit / 145 composition 与有限非作者复核 | 对应当时快照，不是今天的全量结果 |
| 2026-10-14，`0.4.0` | 421 unit / 145 composition；React/Chromium DOM 探针 65 项断言 | **历史上有 DOM 证据**；不应写“从未测过 DOM”，也不应升级为当前在线 GUI 验收 |
| 2026-10-14，`0.4.1` | 456 unit / 147 composition，含 PTC 出站 fixture | 非真实 Node/Python worker 或生产 Profile 全路径验收 |
| 2026-10-19，状态一致性修复 | 503 portable、新设计回归及七组私有负控制 | 非宿主全量、非 PTC SDK 冻结验收 |
| 2026-10-20，先行文档刷新 | 当时源码未改，503 portable 与文档/配置静态核验 | 该阶段的 `.probe/docs-verification-20261020-*` 是旧快照，不能覆盖随后业务修复的结果 |
| 2026-10-20，前轮四项业务修复 | 519 portable、16/16 业务回归、五组负控制 | 私有 `.probe/business-review-20261020-*` 是前轮快照；后续整合没有重写它 |
| 2026-10-20，目录/在途复核 | 533 portable、14/14 目录回归、三组负控制分别 9/2/2 转红 | 对应私有 `.probe/catalog-review-20261020-*`；不是整合上游后的数字 |
| 2026-10-20，PR18 后续审核 | Node 26.8.1、固定 React 18.3.1 与 schemastery 3.18.5-alpha.1 的独立副本 549 pass / 0 fail；其中 client/settings 35 pass；11 项新增回归 | 官方依赖下的单测，不是桌面安装、真实 Loader 或性能验收。原先 5 项审核反例中 4 项失败，修正后通过 |
| 2026-10-21，`fcdb348`×`c1709d3` 整合 | 544 portable / 0 fail；business 16/16、catalog 14/14；预算预留整批核算、游标随资格代次即时回收、DI6b 候选 ref 过期一致性修复 | 对应当时快照，行为叙述见 CHANGELOG `0.4.4` 节；不证明 2026-10-24 性能批的本轮结果 |

以上历史的完整叙述可从[文档刷新前快照](https://github.com/KouzakiUmi/dsh-tool-discovery/blob/b12dfef1815636c1518f741da870c1dd5427442f/plugin/docs/05-current-status.md)及[PR18 后续主线记录](https://github.com/KouzakiUmi/dsh-tool-discovery/blob/c1709d3693ed89d4f6c7185cf27c4d86aa5ea910/plugin/docs/05-current-status.md)取回。后者也保留 503 项、18 项设计回归、七组负控制及私有质量 20/1 的原始说明；私有原始报告与审查镜像未被改写。

### 0.4 历史可选设置的有限独立复核

2026-10-08 两份非作者报告只覆盖六类可选设置边界，不是全功能或安全发布签署：
`plugin/audits/release-security-pro-20261008.md` 与 `plugin/audits/release-security-grok-20261008.md`。
其目录 partial/unknown、preset 来源、周期采用、子代理所有权、主/子开关和 guard/projection 覆盖见 [08 §0.1](<08-trusted-epoch-baselines.md>)。
不能用这些报告给后来改动、浏览器、真实 provider、PTC 冻结或早期签核债务补签。

## 1. 状态速览

| 面 | 当前实现与证据边界 |
|---|---|
| 四入口、目录、分类、词法搜索、版本与预算 | 已实现，有单测与组合回归；检索指标尚未达成可发布评分 |
| native 披露、guard、admission 恢复 | 真实 Loader/mock provider 组合通过，范围见 0.2 |
| 状态一致性 | 混批卸载原子性、晚 seed 撤销墓碑、关闭排空、同 id 恢复与步骤快照有回归 |
| 旧 epoch/journal/projection | 已移除；对应配置键也已从 Config 与设置页删除（不再是保留的兼容字段） |
| 设置页 | VM/配置面通过；四项渲染用例缺依赖跳过，当前 GUI 未验收 |
| PTC | SDK 掩码同源测试通过；真实 worker/transport 未覆盖 |
| 性能、真实 wire、自然语言搜索指标 | 本轮仅有掩码事件/引用计数；无 token、TTFT 或搜索评分 |
| npm / GitHub Release / STORE / Profile | 相互独立，需核对各自实际状态；不从源码版本推断 |

## 2. 已有回归保护的关键链路（0.7.0）

- 单元覆盖 domain/client 与 adapter 接缝；新增 [存储耐久性](<../tests/unit/admission-durability.test.mjs>)、[卸载原子性](<../tests/unit/unload-atomicity.test.mjs>) 与 [掩码回收](<../tests/unit/mask.test.mjs>)。
- 组合使用真实 Loader + mock provider + 测试自有临时存储，含 settings、lifecycle、resume、isolation、PTC SDK、in-history 及 [rc.1 优化边界](<../tests/composition/gate-rc1-optimization.test.mjs>)。
- 测试覆盖不等于真实 provider、在线 GUI 或全版本验收。

## 3. 未闭合的验证与产品边界

1. **真实 provider wire、token、TTFT 与任务净收益**：没有可据此发布的 A/B/C 指标。历史域内微基准不代表端到端时延。
2. **检索质量**：类别词不得独立命中的门禁已修；Recall@K、误命中率与模型正确选择率仍未完成。私有 validator 的历史结果为 20 PASS / 1 FAIL（H037/H044 类别期望误标），不是产品搜索评分。
3. **当前目标宿主的完整重验**：0.2.2-rc.1 解包锚点上全量 unit 和 Loader/mock provider composition 已运行；rc.1 路径依赖私有 registry 结构，0.2.2 更晚版本须重新核验；真实模型/程序 worker、完整 prompt 组合压力与浏览器自然操作仍未覆盖，不能把公共安装测试当成在线桌面 Profile 已验收。
4. **持久化与切换**：crash/fsync、无停顿热替换原子绑定、完整 HMR 压力仍不能从正常恢复或 admission 记录例外推。
5. **旧子系统已移除，不是"待修复"**：epoch/journal/projection/trusted-epoch/PTC 开关/描述精简的既有缺口随 0.6.0 整体删除；对应断言不迁移为"仍待实现"。

## 4. 明确不提供的行为

| 行为 | 当前约束 |
|---|---|
| 静默 LRU 淘汰 | 不提供；模型可显式 tool_unload，超限拒绝新增 |
| 同名定义无重新加载直接继承准入 | 不提供；换版失效，须重新 load |
| 同 session 多活动 agent 并发 | 不声明支持，不能仅靠最近 header 建立无歧义归属 |
| 全量 shadow 来源认证 | 宿主只提供胜出视图，不能补造 provider 身份 |
| 坏历史、查询失败降级新会话 | fail closed，不用 header 推断选择或授权 |
| 将 native 冻结外推到 PTC | 不成立 |
| 新 Core 落入 peer 范围即视为兼容 | 不成立；需跟版核验与实际测试 |

## 5. 独立核验与签核边界

历史有限复核保留各自范围。2026-10-19 的推送前只读复核未发现阻断项，绑定当时 26 份源码/配置指纹；记录为私有 `.probe/pre-push-review-20261019.md`。
它不是完整产品或安全验收，不能抹掉 [08](<08-trusted-epoch-baselines.md>)、[11](<11-code-review-findings.md>) 与历史报告中明确保留的未覆盖项。
触及安全边界仍要求非作者审核；文档整理不充当新签署，作者不得自签。

## 6. 更新纪律

- 当前契约集中在 [00](<00-current-contract.md>)，当前状态只放快照，不持续堆积逐轮流水账。
- 新证据须给出命令、退出码、版本/快照、证据位置与未覆盖项；旧记录只按原时点引用。
- 私有报告不建公开死链接，不修改原始审查证据，不为让门禁变绿而发布评分数据。
- 源码、CI、包载荷、npm、STORE、Profile 与 GUI 分开核验；不把任一“绿”写成全部已验收。
