# DSH Tool Discovery · 文档导航

更新日期：2026-11-06。源码基线：manifest `0.6.0` 工作区源码（DSH Core `0.2.2-rc.1+` 的准入重设计）；GitHub 构建快照和既有 npm 正式版分别核验。
这里记录**当前工作区实现**；不根据版本号推断 npm 最新版、STORE 收录、在线 Profile 或 GUI 已生效。

## 1. 先读什么

| 需要了解什么 | 文档 |
|---|---|
| 使用、配置与权限概览 | [中文 README](<../../README.md>) / [English README](<../../README.en.md>) |
| **现在到底怎么工作** | [00 当前实现契约](<00-current-contract.md>) |
| 为什么分层、有哪些取舍 | [01 需求与架构](<01-requirements-and-architecture.md>) |
| 0.2.2-rc.1 重设计规格 | [14 rc.1 重设计](<14-rc1-redesign.md>) |
| 怎么验证、哪些门槛还没过 | [03 实施与验收](<03-implementation-and-acceptance.md>)、[05 当前状态](<05-current-status.md>) |
| 从源码追踪一轮请求 | [09 业务逻辑地图](<09-business-logic-map.md>) |
| 开发目录、可执行命令与前提 | [开发指南](<../README.md>) |
| Core 升级后怎么核对名单 | [12 核心工具跟版](<12-core-tools-maintenance.md>) |

**当前行为以 00 和源码为准；历史测试只证明它当时覆盖的版本与路径。** 不再要求读者拼接多轮勘误才能知道当前规则。

## 2. 最短工作流

```text
首轮：四个入口 + 类别导航 + 初始工具集合

按类别浏览 tool_list ──────→ 精确 names ──────┐
按任务搜索 tool_search ────→ ref / revision ──┤
                                             ▼
                                tool_load（准入，不执行）
                                             ▼
                          下一请求起披露并可调用

tool_unload ──► 撤销准入 ──► 下一请求起消失且拒执行
```

| 入口 | 主要结果 | 是否改变激活 |
|---|---|---|
| `tool_list` | 类别、名称分页或状态 | 否 |
| `tool_search` | 任务候选、短摘要、ref/revision | 否 |
| `tool_load` | 立即回执；同一步不可调 | 是（准入） |
| `tool_unload` | 立即回执 | 是（撤回） |

默认初始集合包含手动核心名单与当前 preset 保留项，不是无条件只有四个入口。披露不等于执行权限。

## 3. 历史规范与证据入口

保留原文件名、编号、验收 ID 与历史原文，避免报告引用断链；顶部说明其适用时期，不把旧实验改写为新结果。

| 文档 | 如何使用 |
|---|---|
| [02 冻结协议与历次 delta](<02-protocol-and-data-model.md>) | **历史设计依据**。冻结 wire/epoch/unload 禁令均已被 0.6.0 的准入设计取代，不能覆盖 [00](<00-current-contract.md>) |
| [04 运行时接口证据](<04-runtime-evidence.md>) | 2026-10-06 / Core alpha.1 的宿主接口取证，不是当前机器版本声明 |
| [06 文档整理历史](<06-rewrite-changelog.md>) | 早期重写与目录迁移记录，不是当前文档数量或发布状态 |
| [07 恢复与 fork 覆盖](<07-lifecycle-recovery-coverage.md>) | 旧 epoch/journal/seq 门禁证据；引用文件已于 0.6.0 移除 |
| [08 可信周期基线](<08-trusted-epoch-baselines.md>) | 旧 durable 基线设计证据；`trusted-epoch`/`journal`/`projection` 及对应套件已于 0.6.0 移除 |
| [10 兼容与 STORE 证据](<10-store-compatibility.md>) | 当前 manifest 声明与**注明日期的**一次性 Profile、规则镜像记录分开阅读 |
| [11 历史审查发现](<11-code-review-findings.md>) | 按审查时点解释发现与决定；顶部列出后续处理，旧“待决策”不是自动延续的当前待办 |
| [13 默认工具描述精简](<13-builtin-descriptions.md>) | 旧可选特性的设计与数据；`builtin-descriptions*` 已于 0.6.0 移除，仅历史引用 |

## 4. 三层事实不能混用

1. **实现合同**：参数、默认值、状态与错误码，要能对应当前源码。
2. **验证证据**：记录实际命令、退出码、版本、快照与未覆盖项。portable、host-bound、composition、真实 provider/DOM 是不同层。
3. **分发与运行状态**：源码提交、GitHub 构建资产、npm、STORE、Profile 安装与在线 GUI 相互独立；需要各自的实际证据。

协议版本是 `3`（0.6.0 起），构建源码的包版本是 `0.6.0`；`engines.dsh >=0.2.2-rc.1`，`dshReleases` 只把 rc.1 标为 `compatible`。manifest 的 Core peer 准入范围不是逐版本兼容测试；CLI 和桌面壳版本也不替代 Core 版本。

## 5. 验证前提与公开边界

| 命令/材料 | 前提 |
|---|---|
| 仓库检查、便携 unit 子集 | Node；命令见[开发指南](<../README.md>) |
| `npm test` 完整 unit | 另有两份 host-bound 文件，需能从 DSH 安装解析 React / schemastery |
| composition | 可解析、匹配版本的真实 DSH Loader 与 peer；脚本存在不代表当前环境已满足 |
| 质量 validator | 依赖未公开评分集；不能以缺数据为由发布私有数据或宣称零样本通过 |
| 真实 provider / GUI | 另行受控运行；不从 unit 或 mock provider 推导 |

公开：源码、本文档集、测试、非临时 fixtures、质量工装与合成协议目录夹具。
私有：`plugin/reports/`、`plugin/audits/`、根 `docs/`、`plugin/fixtures/tmp/`、质量 queries/labels 等 [.gitignore](<../../.gitignore>) 指定材料。
私有证据只写代码路径，不建立公开版无法打开的相对链接。贡献与安全边界分别见 [CONTRIBUTING](<../../CONTRIBUTING.md>)、[SECURITY](<../../SECURITY.md>)。
