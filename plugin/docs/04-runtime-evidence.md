# 04 · 本机运行时接口证据

核验日期：2026-10-06（Asia/Hong_Kong）。
证据类型：**本机安装实现的只读核验 + 官方文档索引 + 真实 Loader composition 运行结果**。
本文件只说明扩展接口与限制，**不构成产品已可运行或已发布的证明**。

## 1. 版本与消费锚点

| 对象 | 现场结果 | 取证 |
|---|---|---|
| 消费安装解析锚点 | `C:/Program Files/DSH NEXT/resources/app/package.json` | 宿主经该 manifest 解析显式模块路径 |
| 目标核心 | `@deepseek-ai/dsh` **0.2.1-alpha.1** | Core manifest |
| 工具服务 | `@deepseek-ai/dsh-tools` 0.2.1-alpha.1 | 工具服务 manifest |
| prompt 服务 | `@deepseek-ai/dsh-system-prompt` 0.2.1-alpha.1 | prompt 服务 manifest |
| query 服务 | `@deepseek-ai/dsh-session-query` 0.2.1-alpha.1 | query manifest |
| cordis / cordis-plugin-loader | 4.0.5-alpha.1 / 1.0.6-alpha.1 | 各包 package.json |
| node | v24.13.0 | `node --version` |
| 类型文件 | manifest 声明 `lib/types/index.d.ts`，实物不存在 | 目录枚举无命中 |

CLI、核心与第三方桌面壳属于不同版本线，**不能拿 CLI 或壳版本替代核心版本**。部分包声明了类型导出但缺少实际 `.d.ts`，因此本项目以可读的实际 JS 为接口依据，**不声称已完成生成类型编译**；后续实施必须定位类型来源或明确记录该缺口。

## 2. 已核验的公开接口

### 2.1 原生 schema 来自 registry 投影

- **wireSchemas**：native 模式返回当前 view 可见定义投影出的 schema。
- **schemaOf**：schema 字段白名单为 `name`、`description`、`parameters` 与可选 `deferLoading`，**不包含** execute、output 或 UI callback。

结论：目录不得直接序列化 `ToolDefinition`；只保存 / 返回合规投影。`load` 不能复制执行函数来建立第二套 registry。

### 2.2 restrict 的真实边界

- 需要 scoped context；必须有 `allow` 或 `deny`；会校验 `restrictableNames`，**未知名字直接抛错**。
- view 的可见性解析：`inherited` 集合包含 global 与祖先 scope 的注册，对其应用 scope chain 的 restriction 交集；**当前 own scope 的注册随后直接加入 visible，不受这些 restriction 过滤**。

结论：仅靠 `restrict` 无法覆盖 scope-own 工具。必须采用 assembly 投影并另加执行门禁；**不承诺**其拒绝语义等同于 registry 的 `UNKNOWN_TOOL`。

### 2.3 官方单调执行门禁

- 门禁是**同步**函数；返回 reason string 表示拒绝，返回 `undefined` 不强制允许。
- 全局与 scope chain 门禁都可能拒绝；返回 disposer，可按 fiber 生命周期清理。
- 执行准备阶段先运行 pre-execute 与审批，再计算门禁理由；拒绝后不进入 dispatch。

结论：适合做附加披露门禁，但不是新的审批授权系统，也不保证隐藏工具的恶意调用不会先触发原审批询问。

### 2.4 门禁与 body 之间的热替换窗口

- 真正执行 body 前会**重新解析**执行定义。
- 准备后的执行经 `tools/execute` waterfall 再进入实际派发。

结论：仅在门禁中校验 digest 不足以证明随后的派发永远绑定同一注册定义。首版**明确不承诺**无停顿热替换；若将来要求强原子绑定，须由实际宿主 API 实验给出证据。宿主插件注册属可信控制面，不能与“模型猜工具名”混为同一威胁。

### 2.5 systemPrompt.tools 是增加 provider，不是覆盖工具列表

- provider 注册返回 scope-aware disposer。
- assembly 会把 global 与 matching scope 的 provider 一起收集、克隆参数并排序，然后才运行 assemble waterfall。

结论：新增一个返回空数组的 provider **不会**覆盖 registry 的全量 tools，不能当作“只发我提供的工具”的开关。

### 2.6 可用的投影 seam

- assemble waterfall 的返回值通常是 authoritative；存在 complete section 或上下文抑制时再恢复相应宿主约束。
- assemble 上下文同时设置 agent 与 scope；每个 preStep 获取新的 assembly。

结论：可按调用 agent 投影工具子集。但 complete prompt 可能排除本插件的导航文字，waterfall 组合也可能重新加工具，因此**需要最终请求验收**，不能只测 listener 的局部返回值。

注意：完整 schema 的参数克隆发生在 waterfall **之前**。因此 wire token 减少**不代表**宿主组装 CPU 从 O(N) 降为 O(活跃工具数)。

### 2.7 请求 tools 变化已有宿主历史机制

- loop 根据 assembly tools 建 canonical request/header，tools 变化时记录新的 header，并按名字增减记录 tool-addition / tool-removal。
- 最终请求返回 header.tools 与 toolHistory。

结论：插件不需要把完整 schema 写进聊天消息，也不需要自行伪造 developer tool-addition；插件负责投影正确 tools，宿主负责日志与请求历史。但适配器可能重映射 tools / toolHistory，**真实出站请求仍需验收**。

### 2.8 deferLoading 不是通用解决方案

pi-ai 的 tools 收集逻辑发现任一 `deferLoading=true` 即抛出 `UNSUPPORTED_CONTENT`（`Deferred tool loading is not supported yet`）。

结论：首版不设置 `deferLoading`，不作为跨 provider 基础。这是本机该分支的事实，不等于所有适配器永久不支持。

### 2.9 成功工具结果与 durable result 的区别

- 最终 `tools/result` 物化后通知，listener 错误被隔离，异步返回**不构成可靠事务等待点**。
- 成功结果保留 canonical value。
- loop 写 `tool/call` 与 `tool/result`；raw 持久数据主要是 message / content、错误 info 与 meta，**不直接保存内存中的 `result.value`**；`sourceEventSeqs` 引用 call。

结论：不能默认“`result.value` 自动进入可恢复日志”。回执必须通过已验证的 render / content 或 meta 保留；reducer 只在收到成功 durable result 后提交，**不在工具 body 或异步 observer 中抢先修改内存**。

### 2.10 冷恢复使用公开 query 服务

- query 服务名为 `ctx.sessionQuery`。
- `readSession` 异步读取逻辑日志、重放验证，返回 session、继承事件数与**原始 events**；`listEvents` / `filterEvents` 提供轻量记录与语义过滤。

结论：恢复应先 `readSession` 一次折叠，之后事件驱动增量更新，**不是**每次检索都读整份历史。恢复必须使用带完整回执与 call 关联的原始事件，不把轻量记录当完整数据。

### 2.11 已弃用的同步快照接口

同步读取快照的接口在本机实现中标记为 deprecated，并明确禁止新调用。

结论：PTD 不使用它。恢复失败时 **fail closed**，不用任何已弃用接口兜底；缺少公开 query 服务即视为产品级 resume 验收不通过。

### 2.12 外部自定义事件的持久化兼容性

- 已知事件清单说明：外部事件必然在内置清单之外，持久化读取需要 `ignorable` 标记，否则不应静默略过未知事件。
- 现场可见的 `append` 选项投影未核实可直接写入 `ignorable` 的公开参数。
- append 的持久化缓冲为异步：**日志被接受不等于文件已 fsync**。

结论：不把自定义事件当作已解决的持久化接口；PTD 的 journal 采用 canonical 工具结果。崩溃耐久性需单独实验并明确窗口。

## 3. 宿主 seam 缺口（实现必须自证）

| # | 缺口 | 事实 | 处置 |
|---|---|---|---|
| H1 | 工具服务**不暴露** toolId / providerNamespace / bindingGeneration；view 只给可见集合与可限制名 | 公开 API 无此概念 | toolId 由适配层合成（`global::<name>` / `agent:<id>::<name>`）；不可证明的三个字段一律 `null`，**不猜** |
| H2 | 无公开分层枚举，**同名 shadow 只能看到胜出者** | view 每个名称只有一个定义 | 只能在“scope 解析结果 ≠ global 解析结果”时合成 `shadowOf`；完整同名双绑定检测需宿主新 API，本期**不冒称覆盖** |
| H3 | 工具变更事件**无 payload** | 公开事件不带差异信息 | 变更代次由适配层自行 diff：每次变更重算该会话绑定并刷新目录，由内核升代次 |
| H4 | 门禁是**同步**函数，执行上下文不带 request 身份 | 无官方 request 绑定 | 用 canonical `request/header` 事件的 seq 合成请求标识，门禁传同一值；无 header 时无匹配即拒绝；**不引入全局同名兜底** |
| H5 | 工具定义工厂只是包导出，不在工具服务实例上 | — | 适配层工厂接受注入；产品入口按裸包名动态导入，组合测试由测试解析器注入，**产品代码不写绝对安装路径** |
| H6 | `session/created` 监听器返回的 Promise **不被 await** | fire-and-forget | 新会话在恢复完成前处于 `restoring`，三入口之外一律不披露，入口返回 `STATE_NOT_READY`；暴露就绪等待接口，**不假装同步就绪** |
| H7 | 无官方“本次请求实际调用”与 request 的绑定 | — | 采用 H4 的 header-seq 绑定 |

## 4. 技术方案比较

| 方案 | 初始小表 | 选定后真实可调用 | 覆盖 scope-own | 跨 provider | 主要问题 |
|---|---|---|---|---|---|
| 全量 schema 改写为技能正文 | 否 | 仅靠正文无法保证 | 否 | 文本层可读 | 仍携带大清单 |
| 只发数据库路径 | 是 | 否 | 否 | 不完整 | 模型没有标准查询 / 激活入口 |
| 原生 `deferLoading` | 未证明 | provider 限定 | 未证明 | 本机该分支明确拒绝 | 不是通用发现协议 |
| 仅 `restrict` 动态 allow | inherited 可变 | 可恢复原工具可见性 | 否，own 有豁免 | 原生层可用 | 资格查询与自身限制耦合 |
| 仅 assembly 过滤 | 是 | 原工具仍在 registry | 模型列表可以 | 需实际 wire 测试 | 猜名称仍可能执行 |
| 通用 execute 转发器 | 是 | 通过代理调用 | 自行实现 | 表面统一 | 参数、权限、调度 / UI 语义易漂移 |
| **assembly 投影 + 官方门禁** | 是 | 下一轮原生调用 | 可以共同约束 | 目标原生适配器待测 | 组合、恢复与热替换边界需逐项验收 |

最后一行是本项目采用的形态，**不是**已全面实测通过的实现。

## 5. 证据边界

已完成：版本读取、关键公开接口片段核验、官方文档索引查询、真实 Loader composition 的阶段 0 门禁运行与独立复跑、内核与适配层的单测 / 组合测试与两轮独立审查（见[当前状态](<05-current-status.md>)）。

其中单测与组合测试的具体条数、命令与退出码记录在内部证据 `plugin/reports/` 与 `plugin/audits/` 下（不随本文档集公开，见 [README §2.1](<README.md>)）；本文件只保留结论，不复制其逐条日志。

未完成：

- 插件公开 API 的类型编译；
- 外部真实 provider wire 与 token 计数；
- 冷恢复端到端链路、fork / compaction / resume 全量、崩溃 fsync 窗口；
- TTFT 与首次有效工具延迟的 A/B/C 实验；
- 无停顿定义热替换的原子绑定能力；
- 宿主非 native 展示模式与完整 prompt 组合；
- 当前 GUI 的插件安装生效状态。

这些项目在本文件集中一律按“未验证”或“不支持”处理，不以静态证据或设计推导替代。
