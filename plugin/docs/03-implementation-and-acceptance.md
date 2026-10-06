# 03 · 实施、验收与发布门槛

> 验收矩阵的 **ID 是测试与报告的锚点，保持不变**；判据文字已按实现与宿主接口核对后重述。协议见[协议与数据模型](<02-protocol-and-data-model.md>)，证据见内部证据目录 `plugin/reports/`（不随本文档集公开，见 [README §2.1](<README.md>)），进展见[当前状态](<05-current-status.md>)。

## 1. 实施原则

1. 从本设计与实际 SDK 公开接口出发；不把任何外部代码作为设计模板。
2. **先用最小真实 composition 验证宿主 seam，再实现产品内核**；API 探针不通过时，不允许用大量 mock 测试掩盖。
3. `domain` 层不导入 Cordis / 宿主包；`adapters` 层不承担检索排序、分类或状态归约业务。
4. 一次性锚定一个目标核心版本；不加入旧版兼容 shim。
5. 实现、架构复核与独立审查由不同职责承担；**作者不能给自己的安全边界补签**。
6. 未经明确授权不安装、不发布、不改 profile、不改全局工具限制、不重启、不启动替代服务器。
7. 对每个结论区分 **已验证 / 未验证 / 不支持**，不写没有证据的“已完成”。

## 2. 模块边界（实际布局）

```text
plugin/                  实现根目录（早期代号 progressive-v2/，见 reports/structure-migration.md）
  contracts/         阶段0 真实 Loader harness、门禁脚本、安装解析器（只读证据）
  fixtures/          阶段0 fixture 工具与 mock provider
  domain/            宿主无关内核（ESM .mjs，零宿主依赖）
    constants.mjs    协议版本、错误码、预算默认值、受控类别与受控匹配标签
    errors.mjs       DomainError + code → message/retryable/recovery
    canonical.mjs    canonicalJson / digest / UTF-8 字节
    categories.mjs   可信分类、CategoryCard、有界导航
    catalog.mjs      目录条目、不可变快照、schema 身份与版本
    budgets.mjs      字节 / token 预算核算（无 tokenizer 时显式标 estimate）
    search.mjs       双语 tokenizer、倒排、可解释排序
    candidate-refs.mjs 会话 + 代次绑定的短期 opaque ref
    list.mjs         四个 view 与 opaque 游标分页
    skills.mjs       技能校验与投影（禁止复述 schema）
    protocol.mjs     三个请求的严格校验与响应外壳
    state.mjs        纯 reducer、canonical 对核验、门禁判据
    engine.mjs       组合根：请求处理、事务、披露记录、失效、恢复
    util.mjs         code point 截断、plain object 断言、稳定排序、会话互斥锁
    index.mjs        唯一公开出口
  adapters/dsh/      宿主接线层
    index.mjs        装配面：Config 校验、入口名冲突检测、native-only、整组回滚
    registry.mjs     资格事实唯一入口、绑定代次、变更 diff
    journal.mjs      canonical 对折叠、request/header 观测、公开 query 冷恢复
    projection.mjs   await next() 之后的最终投影与返回值校验
    guard.mjs        同步只增拒绝的执行门禁
    entries.mjs      三个 typed definition（输入/输出 schema 与 render）
    lifecycle.mjs    scope 注册、事件、disposer、整组回滚
  tests/
    unit/            domain 单元测试（8 个 *.test.mjs + helpers.mjs）
    composition/     真实 Loader 组合门禁
      harness.mjs + fixtures/          共享 harness 与 fixture 插件
      gate-adapter.test.mjs             组合门禁 14 项
      gate-adapter-lifecycle.test.mjs   生命周期 7 项
      gate-adapter-recovery.test.mjs    恢复与 fork 覆盖 13 项（分支 fix/lifecycle-recovery-coverage 新增，未合并）
      gate-adapter-event-seq.test.mjs   事件 seq 门禁 8 项（同上分支，同一轮新增）
  quality/           检索质量数据与验证工装
    fixtures/ queries/ labels/ tools/ tests/ validate.mjs
  audits/            独立审查的隔离镜像、反例与日志
  reports/           合同、审查与实现报告
  docs/              本文档集
```

`domain` 是唯一业务实现处；`adapters` 只做接线、资格视图、投影、门禁、日志折叠与恢复。模块数量表示职责边界，不为形式创建空文件；无 UI 需求时不引入客户端 bundle。框架保留工具由 adapter 的**可信配置**声明，不在 `domain` 里猜名称。

上树中的 `contracts/`、`fixtures/`（`fixtures/tmp/**` 除外）、`tests/`、`domain/`、`adapters/`、`docs/`，以及 `quality/` 下的 `validate.mjs`、`tools/`、`tests/` 与 `fixtures/catalog.invented.json` 随实现公开；`quality/queries/`、`quality/labels/`、`quality/README.md`、`reports/`、`audits/` 与 `fixtures/tmp/**` 是**私有数据与内部证据**，不公开，因此本文只以代码字体写出路径而不建链接（见 [README §2.1](<README.md>)）。

**运行前提**：组合测试文件齐备；**目标 DSH Core 在本 host 且提供被测宿主依赖与对应版本即可运行**（无宿主不可运行）。`contracts/install-resolver.mjs` 以 `DSH_INSTALL_ROOT` 优先、否则回落默认安装根，因此**默认安装根下无需设置该变量**，仅换机器或改用非默认安装根时才需要它覆盖。**`plugin/quality/validate.mjs` 虽已公开，仍依赖私有 `queries/` 与 `labels/`，其 21 项结论只在完整内部资料下成立**。

不把配置瞬态化用于会话身份、协议版本或必须整体重建的索引结构；配置若即时变化，应在操作边界重新读取并重新核验预算与资格，不用旧闭包冒充 live config。

## 3. 阶段划分

| 阶段 | 目标 | 门禁 |
|---|---|---|
| 0 可行性 | 在真实宿主 seam 上验证可执行合同 | G1–G8 + S08 全部通过并经独立核验 |
| 1 内核 | 宿主无关的协议内核 | 单测通过 + 独立安全审查通过 |
| 2 适配 | 宿主接线与生命周期 | 组合门禁通过 + 独立审查通过 |
| 3 性能与模型行为 | 真实 wire、token、TTFT、检索质量 | 见 §10、§11 发布门槛 |

### 3.1 阶段 0 门禁

在真实 Loader composition 中注册：一项 inherited 普通工具、一项 scope-own 普通工具、三个控制工具、systemPrompt 与工具服务、agent/session/loop、只记录最终请求的 mock provider，以及投影与门禁 listener。

| ID | 场景 | 必须观察的结果 |
|---|---|---|
| G1 | 同时隐藏 inherited 与 scope-own 普通工具 | 首请求只有三个控制入口；框架例外另测 |
| G2 | 模型响应中直接猜隐藏工具名 | 两种工具的执行 body 计数均为 0 |
| G3 | 成功 canonical `tool_load` 后 | 下一轮原生 schema 出现，原 definition 未被改写 |
| G4 | 已加载工具的非法参数与需审批动作 | 原生参数校验与真实审批链仍可拒绝，body=0 |
| G5 | 成功回执的持久化 | 可经公开 session query 冷读回放读到，不依赖 `result.value` 或内存事件 |
| G6 | 下一轮请求 | `request/header` 真实变化，宿主自动记录 tool-addition |
| G7 | `unload` 后 | tool-removal 与历史正确，新调用被拒且 body=0 |
| G8 | 显式保留的框架输出/终止工具 | 保留生效且终止路径正常；名称形似的诱饵工具仍被隐藏 |
| S08 | 同一响应内 `load` 与猜隐藏调用并存 | 旧请求未曝光的调用被拒，body=0 |

**阶段 0 的结论只覆盖“合同在这些公开 seam 上可执行”**，不等于产品实现完成。mock provider 记录的是最终请求对象，**不是**外部真实 provider wire。

### 3.2 阶段 0 不通过时的处理

- 宿主 seam 不支持某目标：报告具体缺口，不访问私有 layers、不改宿主方法。
- 缺少公开 query 服务：产品级 resume 验收不通过，不得用任何已弃用的同步快照接口兜底。
- 完整 prompt 恢复会抹掉本插件导航：拒绝该组合，或由部署方显式接入导航，不偷偷改 persona。
- 有其它 listener 重新加回全量 schema：修正受支持组合，或在权威 `request/header` 上判为不兼容并 fail closed，**不能只报告局部过滤成功**。
- 无法把门禁与执行调用绑定：限制为“一会话一活动模型 agent”，不默认宣称并发共享安全。
- 无法原子绑定热替换定义：无进行中调用时更新；无停顿热替换明确列为不支持。

## 4. 分工、路由与交接

推荐**主代理编排 + 直接 worker**，不为此规模再增子编排者；只有模块与审查进一步独立时才引入一层，且编排者不写交付代码。

| 任务 | 能力门槛 | 范围 | 依赖 |
|---|---|---|---|
| 宿主合同 worker | R3 | contracts、fixtures、runtime-contract 报告 | 无 |
| 内核 worker | R2（安全状态另交 R3） | `domain/**`、`tests/unit/**`、内核实现报告 | 协议冻结 |
| 适配 worker | R3 | `adapters/**`、组合测试 | 阶段 0 + 内核接口 |
| 文档 / 基准 worker | R2 | 文档、性能脚本与实测报告 | 内核与适配可运行 |
| 独立审查者 | V，不低于所审产出门槛 | 独立核验与反例测试 | 实现完成 |

规则：

- 每次委派前先加载模型选型技能并重新发现可用路由；能力资料只作线索，不硬编码模型。
- 复杂 SDK 接入、安全边界与终审不得为求快降到窄提取档位。**没有合格独立核验者时标记未完成**，不用作者自评补齐。
- 同一任务的执行者只派一个；审查者不得是写出该交付物的人。
- 不让多个 worker 同时改入口装配、manifest 或共享测试配置；文件所有权唯一。

交接包：

```text
task_id:
goal:
acceptance_criteria:
scope: 唯一可写文件范围
required_evidence: 命令、退出码、失败原因、精确路径、测试与未覆盖项
relevant_prior_state: 协议版本、冻结 DTO、阶段 0 合同结论
constraints:
  - 不改宿主核心 / profile
  - 不安装 / 发布 / 重启 / 跑依赖构建脚本
  - 不覆盖他人文件
  - 不擅自改变 search/load 边界或权限模型
  - 不再委派（直接 worker 模式）
```

返回：`status / summary / changes / evidence / verification / unresolved / next_action`。完整日志留在 worker 侧，主代理只汇总证据与关键分歧。审查发现问题后按证据归因并返工，不做多模型投票。

## 5. 验收矩阵：功能与请求披露

| ID | 场景 | 必须观察的结果 |
|---|---|---|
| F01 | 冷启动普通会话 | 最终首请求仅三入口，不预展开普通工具名 / 描述 / schema 清单 |
| F02 | `search(category, query)` | Top-K 卡片；无 `parameters`；下一轮工具集合不变 |
| F03 | 明确 load 一个候选 | 成功 canonical 回执；下次请求只新增该工具 |
| F04 | 同版本 load 两次 | 不重复 schema / 技能全文；预算不双算 |
| F05 | load 两个、第二个过期 | 整批不激活，无半提交 |
| F06 | 无关 query | 零命中，不凑相关度低的项 |
| F07 | `category=all` | 有界检索，不返回全量清单 |
| F08 | `unload` | 下次 tools 移除；历史保留；新调用受拒 |
| F09 | 相同工具集合重组装 | 工具顺序与序列化确定性 |
| F10 | 单工具完整 schema 超预算 | 明确失败；schema 未截断 |
| F11 | `list` 按类别分页 | 默认 / 最大 20 个完整名称，无描述 / schema，不自动追页或激活 |
| F12 | `loaded` / 类别 / `state` 列举 | `loaded` 是有效 selected；类别与状态只返回对应有界元数据 |
| F13 | `list` 游标过期 / 跨会话 / 撤权 | `CURSOR_UNAVAILABLE`，不继续暴露旧资格 |
| F14 | 已知名称直接 load | 不强制先检索；回执固定当前定义，下一轮才可调用 |
| F15 | 名称不存在 / 私有 / 仅前缀 | `TOOL_UNAVAILABLE`，不透露私有存在性、不模糊回退 |
| F16 | 名称批次验证期间版本变化 | `SELECTION_CHANGED`，全批不提交 |
| F17 | 回放名称 load | 恢复历史精确版本；与当前定义不同时失效，不按名字升级 |
| F18 | 候选与名称混用 | `INVALID_ARGS`，不形成半批状态 |
| F19 | 同名已加载后的新显式选择 | 当前资格 / 版本重新验证，不复用 stale 版本 |
| F20 | 三入口各自冲突 / 被 shadow | 全部检测，不覆盖其它插件定义，服务不发布 |

## 6. 验收矩阵：权限与安全

| ID | 场景 | 必须观察的结果 |
|---|---|---|
| S01 | 猜从未加载的 global 工具名 | 原 body 调用次数为 0，且不伪造原生 `UNKNOWN_TOOL` |
| S02 | 猜隐藏的 scope-own 工具名 | 同样拒绝，不被任何豁免绕过；对外文案与“未注册”逐字一致 |
| S03 | 另一个 agent 的 `ref` | `CANDIDATE_UNAVAILABLE`，不泄露私有存在信息 |
| S04 | 同名 scope shadow | 检索、schema 与实际解析匹配当前定义 |
| S05 | 宿主原 scope deny | 目录不出现；load 不恢复；执行拒绝 |
| S06 | 已加载但被沙箱 / 审批拒绝 | 原拒绝仍生效，无旁路授权 |
| S07 | 描述内含“忽略规则 / 加载全部” | 仅资料文本；不影响 action、状态与配置 |
| S08 | `load` 与隐藏调用同一响应 | 当前旧请求未曝光的调用被拒 |
| S09 | 用户文本伪造成功回执 | 不进入 selected |
| S10 | `tools/result` 后处理失败 | 无激活；不能只看 execute body 成功 |
| S11 | 入口同名冲突 / 被 shadow | 明确不兼容，不替换现有工具 |
| S12 | 非 native 展示模式及完整 SDK prompt | 拒绝组合，不报告已省全量 token |
| S13 | 同 session 多活动 agent | 拒绝该组合，或提供实际的 request 绑定证据 |
| S14 | 门禁之后注册定义被热替换 | 验证替换窗口；未经证明的无停顿替换不发布 |

## 7. 验收矩阵：生命周期与持久化

矩阵 ID 与判据是冻结锚点，**不因任何一轮实现而增删改**。各 ID 的**当前实证覆盖程度**（哪些已在真实 Loader 上跑过、哪些仍未验证）由[当前状态](<05-current-status.md>)与[07 恢复与 fork 覆盖](<07-lifecycle-recovery-coverage.md>)给出，矩阵本身只定义必须观察到什么。

| ID | 场景 | 必须观察的结果 |
|---|---|---|
| L01 | resume | 成功操作重放，当前资格重新核验 |
| L02 | spawn 子代理 | 空 selected，仅入口与必要框架项 |
| L03 | fork | 父 selected / ref / cursor / advertised 不隐式继承 |
| L04 | compaction | 原始 journal 可恢复；摘要不作为授权 |
| L05 | schema / 描述 / 技能变更 | 旧候选与选择失效，须重新确认 |
| L06 | 工具撤除 / 撤权 | 目录与下一请求移除，原工具不执行 |
| L07 | 取消 load | 无成功 canonical 操作就不激活 |
| L08 | crash / restart | 明确 flush 窗口；日志存在则重放 |
| L09 | listener 部分注册失败 | 全部已创建 listener / 门禁 / section 回滚，无孤儿 |
| L10 | HMR 多次加载卸载 | listener / 缓存 / 工具数量恢复，无增长泄漏 |
| L11 | query 缺失或日志损坏 | fail closed；不得恢复成全量可用，也不得因“有历史”误判为新会话 |
| L12 | renderer / pruner 改写回执 | 不激活，并拒绝未通过验收的组合 |

**当前覆盖速览（不改变上表判据，只标实证状态）**：`L01`、`L03`、`L08` 之外，`L11` 已在分支 `fix/lifecycle-recovery-coverage` 上以真实组合实证（query 缺失 / readSession 失败均 fail closed，含健康会话正控）；该分支另有 8 项 event-seq 套件覆盖 canonical `tool/result` 的 `seq` 门禁与封存后的出站收敛。**L04、L08、L10 仍未验证**，不得因上述用例的绿而外推。对应测试见 [`gate-adapter-recovery.test.mjs`](../tests/composition/gate-adapter-recovery.test.mjs)、[`gate-adapter-event-seq.test.mjs`](../tests/composition/gate-adapter-event-seq.test.mjs) 与 [07](<07-lifecycle-recovery-coverage.md>)。

## 8. 验收矩阵：宿主 wire 与执行链

- 在目标官方原生调用适配器中抓取脱敏的最终出站请求。
- 首轮无全量 schema；load 后只有选定项；`description` / `required` / `enum` 原样。
- 不使用 `deferLoading`，以免对应适配器直接拒绝。
- tool-addition / removal、历史结果与模型切换的适配处理正确。
- 参数校验、超时、取消、并发分类与原 UI callback 不因本插件而改变。
- “本插件拒绝”与宿主 `UNKNOWN_TOOL` 是不同语义，报告分列。

## 9. 检索质量实验

数据集至少分为训练 / 调参与 held-out 两组；**不得用调参 query 宣称最终质量**。

建议 held-out ≥60 条人工标注需求：

- 中文与英文各覆盖；
- 描述的同义改写、目标任务而非工具名；
- 多工具组合需求；
- 至少 15 条当前目录无法完成的负例；
- 易混淆对：路径查找 vs 正文搜索、网页读取 vs 浏览器操作、图片查看 vs 生成、搜索 PR vs 列表 PR。

指标：Recall@5、MRR、负例误命中率、模型正确选定率。`Exact-name@1` 单独作为精确协议测试，**不计入**自然语言检索成绩。

建议首版目标：held-out Recall@5 ≥ 90%，负例误命中率 ≤ 10%。标注有争议时记录候选集合与理由，不强行做单答案指标。目标未达成时改分类、摘要或同义词规则，**不能靠提高 K 到全量目录作弊**。

质量数据的当前状态是**暂不可发布**：机械验证器共 21 项检查，**20 PASS / 1 FAIL**（退出码 1）；唯一 FAIL 是类别资格检查——存在跨类别样本的答案在其 `category` 内不可达，冻结评分输入未改动。详见[当前状态 §2.4](<05-current-status.md>)与内部证据 `plugin/quality/README.md`（不随本文档集公开）。

## 10. 性能实验

### 10.1 三组基线

| 组 | 方式 | 比较意义 |
|---|---|---|
| A | 全量 schema | 当前问题的成本基线 |
| B | 检索即自动加载候选 | 单阶段对照，展示额外轮次取舍 |
| C | 本设计的 `search → load` | 用户要求的两阶段方案 |

B 只作为实验对照，不是默认功能。

### 10.2 测量维度

1. 初始 tools schema、类别摘要与普通系统指令的 token。
2. 每轮活跃 schema token 与候选 / 技能历史 token。
3. 实际 wire 字节、准确 tokenizer 或明确的 estimate。
4. 从发出请求到第一个流事件、第一段可见文本、第一项工具调用的时间；**三者不可混用**。
5. 首次实际工具 body 开始延迟与端到端任务时间。
6. provider usage、cache 命中 / 未命中与费用口径（订阅扣量未知则记未知）。
7. 宿主目录构建、检索、投影的 CPU 时间与峰值内存。
8. 工具数量 N = 200 / 1,000 / 10,000；活动 agent 数 A = 1 / 5 / 20；注册变更 burst。

### 10.3 方法与目标

- 同 provider、model、effort、网络条件与任务；冷缓存与热缓存分组。
- A/B/C 交错或随机顺序运行，每组至少 20 个有效样本，报告中位数、P95 与失败率。
- 额外产生的模型轮次必须纳入端到端时间。
- 初始工具相关 token 目标 ≤ 2,048；完整初始请求还含 persona / skills 等材料，**不承诺总 prompt ≤ 2K**。
- 当真实基线 ≥ 60K 且适配组合通过时，工具相关 token 减少目标 ≥ 95%。
- warm search 在 N≈1,000 时建议 P95 < 20ms，首次建索引另计；机器条件随报告给出。
- TTFT 不预先规定“快几倍”，报告置信范围与分布；端到端未改善也必须记录。

## 11. 发布门槛

以下**全部**通过才可称“产品实现完成”：

- 真实 Loader composition、原执行链与 provider wire 测试通过。
- 功能、安全、生命周期矩阵无未解释失败。
- 自然语言 held-out 检索达到门槛，或已获明确的范围调整。
- 真实初始请求无全量工具泄露，token 减少达到目标。
- 支持范围写明：核心版本、`native-only`、一会话一活动 agent、热更新窗口与框架例外。
- 独立审查完成；同源复核须注明同源误差。
- 入口装配、exports、Config 与产物成套检查，交付代码与产物同步。
- 文档、版本、测试命令与实测报告对应**实际产物**。

未安装到用户正在使用的 profile 时，只能称“工作区实现已验证”，不能称“当前 GUI 已生效”。

**源码基线发布与本节门槛无关**：源码基线发布表示代码、协议、文档与既有证据已一致整理并完成提交、推送与远端验证——**该里程碑当前尚未达成**，且即便达成也不构成任何一条门槛的通过证据。本节全通过才是“产品实现完成”；二者都还要求另行完成 npm 发布 / 安装生效（见[当前状态 §1](<05-current-status.md>)）。

## 12. 剩余关键验证项

| 项目 | 当前判定 | 下一步 |
|---|---|---|
| 公共 assembly / 门禁 seam | 已在真实 composition 上验证 | 继续以组合测试覆盖 |
| scope-own 工具隐藏 | 已验证 | 保持为回归项 |
| canonical 回执恢复 | 分支语义已验证，端到端链路待驱动 | 驱动 L01 / L04 |
| 出站 token 减少 | **未测**（仅有设计推导） | wire 抓取与 tokenizer |
| TTFT / 任务延迟 | **未测** | A/B/C 实验 |
| 子代理终止 / 强制输出 | 以 scope 注册形态验证，真实委派链未接 | 接真实子代理链路 |
| 热替换原子版本绑定 | **不支持**（无停顿热替换） | 保持明确限制 |
| 技能服务接入 | 首版不依赖 | 需要时再验证公开 provider API |
