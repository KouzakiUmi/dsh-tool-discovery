# 05 · 当前状态

更新日期：**2026-10-22**（Asia/Hong_Kong）。对应源码 manifest `0.4.3`，整合已发布主线 `c1709d3` 与后续业务修复；本批仅作 GitHub 构建分发，不代表新 npm 正式版。
现行行为见 [00 当前实现契约](<00-current-contract.md>)，验收判据见 [03](<03-implementation-and-acceptance.md>)。
本文不登记未经重新核验的远端最新发布、STORE 收录或在线安装状态。

## 0. 状态口径

“实现存在”“测试通过”“非作者有限核验”“完整产品验收”“分发”“安装生效”是不同结论。
旧文件中的“本轮”“当前宿主”“未发布”“待合并”仅在其取证时点成立，不自动滚动到今天。
历史记录保留在 [04](<04-runtime-evidence.md>)、[06](<06-rewrite-changelog.md>)、[07](<07-lifecycle-recovery-coverage.md>)、[08](<08-trusted-epoch-baselines.md>)、[10](<10-store-compatibility.md>)、[11](<11-code-review-findings.md>) 与私有证据中。

**版本坐标**：本源码 manifest 为 `0.4.3`，但后续 `build-<sha>` 与已发布的 npm `0.4.3` 是不同源码快照。npm 发布与 provenance 以 registry 为准；GitHub Release/tarball 不能替代 npm 发布证明。每个绿色 main 构建会产出 `build-<sha>` 资产，正式语义版本由 `v<version>` 标签驱动。本次不新增正式版本标签或 npm 发布。
上游记录的 2026-10-06 重建前历史（`2a1f9c0`、`257ddc0` 等）已淘汰，不作为本批证据来源。

### 0.1 版本与兼容

- 包版本：`0.4.3`；协议版本：`2`。不要把包版本当 Core 版本。
- manifest 的 Core peer 准入范围为 `>=0.2.1-alpha.1`；显式兼容声明仍只将 alpha.1、alpha.2 标为 `compatible`，`0.2.0-rc.2` 为 `unknown`。未列出的新版本不据此变成“已测”。
- `schemastery` peer 仍是 `3.18.5-alpha.1`；不能把所有 peer 都描述成同一开放 Core 范围。
- 当前文档核对没有重新读取宿主安装版本；[04](<04-runtime-evidence.md>) 的 alpha.1 现场与 [10](<10-store-compatibility.md>) 的 alpha.2 实验均是历史坐标。
- 整合的 PR #18 后续修复保留有序 wire 独立副本、getter/toJSON 内容变化拒绝、逐项字节累计及末页节省判定。字节上限约束响应构造，不约束索引评分/排序的全部计算量。其历史 549 项结果见 0.3，不冒充本轮宿主验收。

### 0.2 本次运行证据

2026-10-21 将已核业务批次 `fcdb348` 与已发布主线 `c1709d3` 整合。Node **v24.13.0**。保留上游有序 wire 副本、逐项字节有界构造和本批预算/名单/技能/回收修复；本次为 GitHub build，不新增 npm 正式版本。

| 本次实际执行 | 退出码 | 结果与边界 |
|---|---|---|
| 显式排除 `client.test.mjs`、`settings.test.mjs` 后运行全部 unit 文件 | 0 | **544 pass / 0 fail / 0 skip**；含上游 PR18 跟进与本批业务回归，两份宿主绑定文件仍是排除，不是通过 |
| 本批 [business-workflow](<../tests/unit/business-workflow.test.mjs>) / [catalog-workflow](<../tests/unit/catalog-workflow.test.mjs>) | 0 | 分别 16/16 与 14/14，包含在上面的 544 项中，不重复累加 |
| `node --check`（engine、budgets、list、state、registry） | 0 | 语法检查，不等于类型检查、Loader 或 GUI |

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

以上历史的完整叙述可从[文档刷新前快照](https://github.com/KouzakiUmi/dsh-tool-discovery/blob/b12dfef1815636c1518f741da870c1dd5427442f/plugin/docs/05-current-status.md)及[PR18 后续主线记录](https://github.com/KouzakiUmi/dsh-tool-discovery/blob/c1709d3693ed89d4f6c7185cf27c4d86aa5ea910/plugin/docs/05-current-status.md)取回。后者也保留 503 项、18 项设计回归、七组负控制及私有质量 20/1 的原始说明；私有原始报告与审查镜像未被改写。

### 0.4 历史可选设置的有限独立复核

2026-10-08 两份非作者报告只覆盖六类可选设置边界，不是全功能或安全发布签署：
`plugin/audits/release-security-pro-20261008.md` 与 `plugin/audits/release-security-grok-20261008.md`。
其目录 partial/unknown、preset 来源、周期采用、子代理所有权、主/子开关和 guard/projection 覆盖见 [08 §0.1](<08-trusted-epoch-baselines.md>)。
不能用这些报告给后来改动、浏览器、真实 provider、PTC 冻结或早期签核债务补签。

## 1. 状态速览

| 面 | 当前实现与证据边界 |
|---|---|
| 三入口、目录、分类、词法搜索、版本与预算 | 已实现，有 portable 回归；检索指标尚未达成可发布评分 |
| native 披露、guard、canonical 恢复 | 已实现；早期真实 Loader 证据按历史版本保留；本轮未重新做宿主集成 |
| 状态一致性修复 | 同名 schema 冲突、独立旧 wire 恢复、结果提交次序、技能下发和完整成功外壳预算已进入源码及回归 |
| trusted-epoch | 已实现的**可选功能**，主/子开关默认关闭；不是“还没有实现”，也未完成全 feature 验收 |
| 设置页 | 已实现，有 VM/配置面/历史 DOM 证据；当前 GUI 未验收 |
| PTC 兼容 | 默认旁路，显式开启后接入 `run_code`；SDK 冻结、稳定追加、跨重启冻结仍缺失 |
| 性能、真实 wire、自然语言搜索指标 | 没有本轮或可替代产品验收的测量结论 |
| npm / GitHub Release / STORE / Profile | 相互独立，需核对各自实际状态；不从源码版本推断 |

## 2. 已有回归保护的关键链路

- [设计契约回归](<../tests/unit/design-invariants.test.mjs>)：native 冻结迁移、当前资格与旧 wire 分离、失败/继承/header 不授信、native/PTC 加载结果完成排列、技能限额及完整响应字节上限。
- [状态回归](<../tests/unit/state.test.mjs>)、[可选限额](<../tests/unit/optional-limits.test.mjs>)、[候选版本](<../tests/unit/load-revision-optional.test.mjs>)：回执不一致释放 pending、默认 limit 受显式 max 约束、空 revision 归一。
- [恢复组合门禁](<../tests/composition/gate-adapter-recovery.test.mjs>)、[周期组合门禁](<../tests/composition/gate-cache-epoch.test.mjs>)：测试文件和历史结果存在；不能把“文件存在”写成“本轮跑过”。
- [插件释放门禁](<../tests/composition/gate-plugin-disposal.test.mjs>)与 [activation unit](<../tests/unit/activation-lifetime.test.mjs>)：旧 activation 等待失效、清理和取消监听器回收；不承诺外部持有对象零内部写入或 GC 定量结果。
- [PTC 组合门禁](<../tests/composition/gate-ptc-disclosure.test.mjs>)：fixture 与 mock provider 的 SDK 出站覆盖，不等于真实程序 worker、provider 或跨重启文本冻结。

## 3. 未闭合的验证与产品边界

1. **PTC SDK 逐字冻结、稳定追加和跨重启冻结**：当前实现仍按当前 `sdkSchemas` 重新渲染；执行守卫不能代替披露一致性。
2. **真实 provider wire、token、TTFT 与任务净收益**：没有可据此发布的 A/B/C 指标。历史域内微基准不代表端到端时延。
3. **检索质量**：类别词不得独立命中的门禁已修；Recall@K、误命中率与模型正确选择率仍未完成。私有 validator 的历史结果为 20 PASS / 1 FAIL（H037/H044 类别期望误标），不是产品搜索评分。
4. **当前目标宿主的完整重验**：host-bound unit、Loader composition、真实子代理/worker、完整 prompt 组合、跨 scope 压力与浏览器自然操作未在本轮运行。
5. **持久化与切换**：crash/fsync、无停顿热替换原子绑定、完整 HMR 压力仍不能从正常恢复或成功压缩用例外推。
6. **trusted-epoch 残余**：历史定义的新会话/迁移契约窗口及有限审查未覆盖项仍见 [08](<08-trusted-epoch-baselines.md>)；本轮没有修改其授权实现或宣布旧债务全闭合。

## 4. 明确不提供的行为

| 行为 | 当前约束 |
|---|---|
| 模型自主 unload、静默 LRU 淘汰 | 不提供；超限拒绝新增或等待用户/DSH 成功压缩 |
| 同周期换名槽位的不同 schema | `COMPACTION_REQUIRED`，不能靠换 toolId 绕过 |
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
