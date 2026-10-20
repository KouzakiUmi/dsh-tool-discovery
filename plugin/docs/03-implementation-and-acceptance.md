# 03 · 实施、验收与发布门槛

> 更新日期：2026-10-20。本文区分现行验证方法和历史冻结验收矩阵。原 F/S/L/G/S08 ID 与表格判据保留，便于追溯报告，**不表示旧默认值或卸载 API 仍开放**。
> 现行实现以 [00](<00-current-contract.md>) 为准，实际执行与未覆盖项见 [05](<05-current-status.md>)。历史矩阵不是当前全部测试文件的清单。

## 1. 实施原则

1. 从本设计与实际 SDK 公开接口出发；不把任何外部代码作为设计模板。
2. **先用最小真实 composition 验证宿主 seam，再实现产品内核**；API 探针不通过时，不允许用大量 mock 测试掩盖。
3. `domain` 层不导入 Cordis / 宿主包；`adapters` 层不承担检索排序、分类或状态归约业务。
4. 每项宿主证据绑定实际 Core/peer 版本与源码快照；开放 peer 准入不等于新版本已通过兼容测试。
5. 实现、架构复核与独立审查由不同职责承担；**作者不能给自己的安全边界补签**。
6. 未经明确授权不安装、不发布、不改 profile、不改全局工具限制、不重启、不启动替代服务器。
7. 对每个结论区分 **已验证 / 未验证 / 不支持**，不写没有证据的“已完成”。

## 2. 模块边界与运行前提

| 目录 | 当前职责 |
|---|---|
| [domain](<../domain/>) | 宿主无关的 catalog/search/list/protocol/budgets/state/engine |
| [adapters/dsh](<../adapters/dsh/>) | 资格、日志、native/PTC 投影、guard、生命周期、可信基线、配置 |
| [client](<../client/>) | 已存在的设置页及纯 model，不需要独立构建 |
| [tests/unit](<../tests/unit/>) | portable 回归 + 两份 host-bound 文件，不能统称只需 Node |
| [tests/composition](<../tests/composition/>) | 真实 Loader 的 gate-*.test.mjs，不写死文件/用例数 |
| [contracts](<../contracts/>) / [fixtures](<../fixtures/>) | 测试解析器、harness 与隔离夹具；临时数据不公开 |
| [quality validator](<../quality/validate.mjs>) | 工装公开，评分输入私有；数据完整性检查不是产品检索评分 |

命令及明确的 portable 排除列表见[开发指南](<../README.md>)。完整 unit 的 client/settings 两文件与 composition 都需要能从目标安装解析对应 peers；仅有 ASAR 不自动满足现有测试解析器。
私有 reports/audits、评分集与临时会话文件只用代码路径引用，不强制纳入公开仓库来制造“可复现”。
配置即时变化时按它的实际生效边界核验，不能拿应用登记目录冒充会话资格，也不能在周期中途改写已发送工具表。

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

## 4. 变更与审查职责

实现者说明需求、可写范围、源码快照、关键不变量和红转绿证据；审查者独立核对反例、实际命令与未覆盖项。安全边界作者不能自签，不能以多份同意代替可复现证据。

- 不让多个实现者覆盖共享入口、manifest 或他人审查材料。
- 私有报告保留原文；文档整理不能把历史测试追认为当前通过。
- 第三方接口按实际消费版本核验；内部状态机按源码与断言核对。
- 宿主、Profile、安装和发布与工作区验证分开，不把“能运行脚本”当作执行生产操作的许可。

### 历史 ID 到当前语义的映射

以下第 5–8 节及阶段 0 表保留早期矩阵原文。对照当前实现时必须应用下表，不能把旧矩阵直接当用户 API：

| 历史项 | 当前解释 |
|---|---|
| 首轮仅三入口（G1/F01/L02） | 受控测试可清空初始名单；生产默认还有核心/preset 基线及可信例外 |
| unload（G7/F08） | 模型接口拒绝 unload；历史 reducer 分支不代表开放卸载；成功压缩才 reset |
| category=all（F07） | search 与 list 的 available/loaded 都支持 all；仍只在当前 scope 的可发现目录内查询 |
| 最大 20（F11） | 默认 20；硬上限默认 null，显式 max 才启用，省略 limit 也受该 max 收窄 |
| 同名新版本（F19/L05） | 相同 schema 可重选；冲突 schema 返回 COMPACTION_REQUIRED，不能静默换 frozen wire |
| 撤权从请求移除（L06） | 撤销执行/advertised；健康 native 周期可保留旧 frozen 披露，不授予执行 |
| 非 native 拒绝（S12） | 当前 PTC 默认旁路、可选 SDK 兼容；不得据此声称 native 式冻结或完整组合验收 |

新增跨生命周期保护见 [design-invariants](<../tests/unit/design-invariants.test.mjs>)，覆盖提交次序、冻结恢复、技能换版、类别词准入与完整成功外壳预算；不重编号旧 F/S/L 矩阵。

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

**覆盖口径**：own-only/fork/seq 的历史证据见 [07](<07-lifecycle-recovery-coverage.md>)；后续成功手动/自动压缩、activation 释放及 PTC fixture 已有分批记录，不再将 L04/DOM/PTC 全部笼统写成“从未驱动”。crash/fsync、完整 HMR、真实 provider/worker 等仍未闭合。历史绿不替本轮目标 Core 复跑；具体范围见 [05](<05-current-status.md>)。

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
- 支持范围写明：核心版本、按 scope 的展示模式、一会话一活动 agent、热更新窗口与框架例外。
- 独立审查完成；同源复核须注明同源误差。
- 入口装配、exports、Config 与产物成套检查，交付代码与产物同步。
- 文档、版本、测试命令与实测报告对应**实际产物**。

未安装到用户正在使用的 profile 时，只能称“工作区实现已验证”，不能称“当前 GUI 已生效”。

**源码分发与产品验收分开**：提交/推送、GitHub 构建资产、npm、STORE 与 Profile 安装都是独立里程碑，不能由本节或文档更新推断。这里不保留会过时的“尚无发布/尚无推送”总判断。完整产品门槛未达成，也不等于不能明确标注范围地分发源码基线。

## 12. 剩余关键验证项

- PTC SDK 冻结、稳定追加与跨重启披露一致性。
- 当前目标宿主的完整 unit/composition 重验，以及真实 provider/程序 worker 和完整 prompt 组合。
- token、TTFT、首次有效工具和任务完成时间的受控 A/B/C 测量。
- held-out 任务检索指标与私有评分数据的语义审查，不拿结构 validator 当质量评分。
- crash/fsync、跨 scope 压力、完整 HMR 及未停顿热替换原子绑定。
- 既有 trusted-epoch 契约残余与历史签核债务；不能用本次文档维护补签。

动态状态集中维护于 [05](<05-current-status.md>)，本节保留工作方向而不复制滚动测试数字。
