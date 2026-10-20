# 00 · 当前实现契约

> 更新日期：2026-10-20。依据源码版本 `0.4.2`（含 `b12dfef` 的状态一致性修复）。
> 本文是现行行为入口，不是发布、安装或完整产品验收声明。
> [02 历史冻结协议](<02-protocol-and-data-model.md>)保留了早期设计和历次 delta；其中旧默认值、unload、展示模式等不能直接当作当前行为。

## 1. 支持范围与初始集合

本插件不执行工具代理，也不建立第二个工具注册表。它在宿主请求组装时控制披露，在执行链上增加拒绝条件；宿主审批、沙箱、原生可见性和派发仍然有效。

- **native** 是完整披露路径：首轮为三个发现入口、类别导航，以及本周期的初始工具集合；不是默认只有三个入口。
- **PTC** 默认旁路，保留宿主 SDK。显式开启 `ptcCompatibility` 后，发现入口和选定工具进入下一轮 `run_code` SDK，而不是额外暴露一套原生工具。
- **PTC 暂不保证 SDK 逐字冻结、稳定追加或跨重启冻结。** 不能把 native 冻结结论扩展到 SDK 文本。
- 一个会话按一个活动 agent 建立 runtime；不承诺同会话多 agent 并发隔离，也不承诺无停顿热替换的原子派发绑定。

初始集合的来源分别是：

| 来源 | 默认与边界 |
|---|---|
| 三个发现入口 | 始终保留，不由 `alwaysVisible` 删除 |
| 手动名单 | `alwaysVisible` 缺省取手工维护的 `CORE_TOOL_NAMES`；显式数组是替换，不是追加；由 `initialToolsEnabled` 控制 |
| 当前 preset | `alwaysAllowPresetTools=true` 独立保留实际绑定修订自己登记、且原生 scope 仍可见的工具；不等于所有 preset 或整个应用目录 |
| 核心同名自证 | `respectAlwaysVisible=false` 且本周期初始注入未关闭时，guard 可吸收当前 scope 实际提供的核心名单工具；因此手动空名单不是默认模式下的最终授权上限 |
| 框架保留项 | `frameworkRetained` 是可信组合配置，不是模型可自行填写的名单 |

设置页的全局登记目录只是编辑辅助，不是会话的可调用集合。partial 目录未列出的项是 `unknown`，不能据此宣称未注册。

## 2. 三入口

三入口采用协议版本 `2`，拒绝未知字段、模型指定的会话身份、路径、代码或自由技能名。模型必须下一轮才使用已加载工具；`tool_load` 不执行目标工具，也不批准副作用。

### 2.1 `tool_list`

| 请求 | 行为 |
|---|---|
| `{}` | 默认返回类别导航 |
| `{"category":"files"}` | 省略 view 时按 `available` 列名称 |
| `{"view":"available","category":"all"}` | 当前可发现名称分页；同名去重，不返回 schema、描述或 ref |
| `{"view":"loaded","category":"all"}` | 当前有效 selected 名称分页；不是完整常驻集合，也不是全部 frozen wire |
| `{"view":"categories"}` | 类别卡分页；不接受 `category` |
| `{"view":"state"}` | 当前选择、披露、失效诊断与预算；不接受 `category`、`cursor` 或 `limit` |

`available` 和 `loaded` 必须给类别，可用 `all`；`categories`、`available`、`loaded` 支持 opaque 游标与正整数 `limit`。默认页长 20。游标绑定会话、view、类别、资格代次、顺序摘要和有效期，失效后从首页重查。资格代次改变时立即回收旧游标，不等待 TTL；内容相同的刷新或校验失败不清掉仍有效的游标。

### 2.2 `tool_search`

必填 `category`、非空 `query`，可选正整数 `limit`，默认 5。可限定一个受控类别，也可用 `category:"all"` 搜索当前 scope 的全部可发现类别；不确定类别时无需先列类别。`all` 是已有行为，不扩大 scope 资格。

返回候选卡，包括名称、短摘要、ref、revision、loaded 和受控匹配原因；不返回工具 schema、不加载、不为凑满数量补项。`loaded=true` 表示已选中/属于基线，不必重复 load；但只有当前工具表实际出现其 schema 才可调用，否则等下一轮。词法证据不保证任务语义相关，通用动词仍可能误召回，不能把候选当成能力保证。

**类别词只辅助排序，不能独立制造命中。** 至少需要名称、受控同义词、工具摘要或技能字段的证据。纯类别词可能得到空候选与改写/浏览指引；这是一项精确率与召回率取舍，不是检索质量达标声明。

### 2.3 `tool_load`

两条互斥路径：

```json
{"names":["精确原生名称"]}
```

```json
{"candidates":[{"ref":"上次搜索给出的引用","revision":"可选的版本断言"}]}
```

- action 缺省为 `load`；当前模型接口拒绝 `unload` 和 `toolIds`。旧历史 reducer 的 unload 分支不是开放的卸载 API。
- 候选 revision 省略、`null` 或空串在域层同义，均采用 ref 绑定版本；显式给出的非空版本必须匹配。ref 过期或绑定变化不能静默升级。
- 每次加载重新核验资格、版本、受保护项和预算。`tolerantLoadProtected=true` 容忍重复加载已在基线的项，但不把不可用项变成可用。
- 成功响应包含 canonical 选择回执。**生成成功响应不等于提交**：须观察到匹配的 canonical 成功 call/result 对，之后再由真实请求 header 确认已披露。
- 内核可发送受信任的技能内容，但生产 registry 当前提供 `skill: null`。不承诺已接入外部技能服务，也不伪造指南。

## 3. 状态、版本与冻结

| 状态 | 表示什么 | 不表示什么 |
|---|---|---|
| `selected` | canonical 回执核验通过的当前版本选择 | 不等于宿主批准执行，也不等于本轮已披露 |
| `advertised` | 当前请求 header 实际披露过、且版本匹配的凭据 | 预览 assemble 不算；请求头不能反向授予选择 |
| `frozen` | 按需项首次实际披露的 wire 与次序 | 不是执行权限；移除或撤权后仍可保留旧定义 |
| `invalidated` | 选择/披露失效的诊断 | 不是可重新调用的目录 |

在健康的 native runtime 内，按实际首次披露次序保留旧 wire，新项追加。常驻 wire 使用 journal 观测缓存，按需 wire 使用 engine 冻结账本。缓存不扩大资格；非 ready、封存、卸载等 fail-closed 状态不能用冻结承诺绕过门禁。

### 3.1 同名升级

同一周期中，以**原生名称**占冻结槽位。新 schemaDigest 与冻结定义不同，即使 toolId 改了，也在预留预算前返回：

- code：`COMPACTION_REQUIRED`
- retryable：`false`
- recovery：`wait_for_successful_compaction`

相同 schema 的绑定重连或技能换版可重选；冻结名称不重复计 schema 配额。技能只对**已提交的同版本选择**去重；冻结 wire 或另一个可失败/取消的 pending 不证明指南已送达。并发响应必要时各自携带指南，但 schema 预留仍去重，实际技能卡总字节仍受本次技能上限约束。

### 3.2 周期边界

只有**宿主确认成功且具有有效摘要的压缩**重开缓存周期，手动和自动压缩均适用；失败、取消或缺摘要不算。配置变更不能改写已经发送的数组。新会话/成功压缩边界采用名单类 volatile 设置；严格记录落定失败等情况不能靠“压缩过了”强行放行。

## 4. 恢复与乱序

恢复先读公开 canonical 历史，并核验 own/inherited 边界与事件 seq；不把父会话继承前缀当成子会话自己的加载。恢复未落定时装配等待，不以固定超时发送缩水工具集；恢复失败另走 fail-closed，不等同于仍在 pending。

两类事实分开恢复：

1. **执行选择**：重算 canonical 输入路径、回执、当前资格与版本；旧版本不再有效时不恢复执行资格。
2. **native 披露账本**：own 当前周期中，匹配成功 load 回执后实际出现同 digest header 的旧 wire 可恢复，即使当前定义已变更或移除。单独 header、失败回执或继承前缀不赋权。

`call.seq` 负责配对、去重及来源归属；`resultSeq` 负责最终结果的提交次序和选择顺序。热态观察与冷态 replay 按相同顺序折叠，不能因调用先后与结果先后不同而丢掉合法选择。旧 DTO 未给 resultSeq 时保留原 call-seq 回退语义。

**仍有已复现的候选边界未闭合**：ref 有效时已被 load 接纳，但最终回执到达时 ref 过期，热态可拒绝该选择；同一成功回执冷恢复会按当前绑定重新选中。上面的结果次序回归不等于这一边界已统一。本轮保留既有候选提交校验，需另行确定已接纳事务与短期引用的关系。

crash/fsync 窗口、真实 provider、所有 fork 生命周期或跨进程完整验收也未完成。

## 5. 预算

以 [constants.mjs](<../domain/constants.mjs>) 和 [budgets.mjs](<../domain/budgets.mjs>) 为准：

| 设置 | 缺省 |
|---|---|
| `defaultListLimit` / `defaultSearchLimit` | 20 / 5 |
| `listCursorTtlMs` / `candidateTtlMs` | 各 900000 ms |
| `maxInitialCategories` | 12（受控分类自然总数，不授予资格） |
| `maxListLimit`、`maxListResultBytes`、`maxSearchLimit`、`maxSearchResultBytes` | `null`，关闭硬上限 |
| `maxQueryCodePoints`、`maxLoadBatch`、`maxActiveTools`、`maxActiveSchemaBytes`、`maxSkillBytesPerLoad` | `null`，关闭硬上限 |
| `initialSchemaTargetTokens` / `maxInitialBytes` | 2048 / 8192，历史参考值，生产路径未执行 |

硬上限可设为正整数；未知键、非法数值或 `Infinity` 不接受。省略 limit 时默认值会收窄到显式 max；显式 limit 超出 max 仍返回 `INVALID_ARGS`。

活跃 schema 配额针对按需的 selected、frozen 与 pending 去重足迹，不把初始常驻基线算入，包括容错重载基线产生的 pending/selected/frozen。pending 按原子回执里的确定版本核算，不只认 toolId：任一项已移除或换版，则整批不再计入当前配额；操作仍保留至正式回执/取消收口，不据此释放其它独立 selected/frozen。定义仍匹配的在途操作继续预留，不因任意目录广播一概取消。降低限额后旧披露可以暂时超限，但零新增重选仍可继续；真正新增占用仍拒绝，不淘汰已披露项，不引导模型自行压缩腾位。

`maxListResultBytes` 覆盖四个 list view 的**完整成功 JSON 外壳**，`maxSearchResultBytes` 同样覆盖 search：

- 以实际 JSON 的 UTF-8 字节计量，包含 operation、恢复提示和分页元数据，空成功响应也计量。
- 减少完整名称/卡片，不截断名称或 schema；交付页确定后才铸出游标/ref。
- state 不裁 `selected`/`advertised`，只可裁诊断性 `invalidated` 并标 `invalidatedTruncated`。
- 连最小合法成功响应都放不下时返回 `BUDGET_EXCEEDED`；**错误外壳本身及宿主额外包装不受这些成功响应上限保证**。

## 6. 配置生效时点

完整字段以 [config.mjs](<../adapters/dsh/config.mjs>) 为准。

| 配置 | 默认 | 生效与限制 |
|---|---|---|
| `alwaysVisible` | 核心手工名单 | volatile；与下面两项在新 runtime/成功周期边界采用 |
| `initialToolsEnabled` | `true` | 只控制手动名单，不关闭发现入口或独立 preset 保留 |
| `alwaysAllowPresetTools` | `true` | 独立的当前 preset 保留 |
| `ptcCompatibility` | `false` | volatile；下一轮按展示模式采用；不补齐 SDK 冻结 |
| `requireTrustedEpoch` | `false` | 改动重挂载；启用 durable 基线记录 |
| `requireTrustedEpochForSubagents` | `false` | 仅与主开关同时启用时要求运行时子代理记录；所有权未知不获豁免 |
| `respectAlwaysVisible` | `false` | 改动重挂载；关闭核心同名自证，不能与 trusted-epoch 合称一个“严格模式” |
| `tolerantLoadProtected` | `true` | 受保护基线的幂等加载容错 |
| `locale` | `auto` | 激活时确定；显式语言不读宿主语言文件，未知语言回落 en |
| `categoryConfig` / `budgets` | `{}` / `null` | 导航覆盖 / 域预算覆盖；不因自定义类别文字扩大资格 |
| `frameworkRetained` | `[]` | 可信组合方例外，不是普通 UI 权限开关 |

主可信周期关闭时，不打开该可信基线存储；当前配置与可见性、回执、坏历史、版本和执行检查仍有效。开启后的 durable 记录只解决初始名单来源，不是所有工具调用权限的替代品。详细历史合同见 [08](<08-trusted-epoch-baselines.md>)。

## 7. 错误与信任边界

入口业务失败返回 `ok:false` 和结构化 `error.code/message/retryable/recovery`，不依靠抛出异常让宿主改写成非 JSON 文本。无匹配搜索可成功返回空候选；不应把它误读成加载成功。

门禁拒绝、入口业务错误与宿主原生工具错误是三层不同结果。隐藏名与不存在名不用于暴露注册事实。初始/框架保留项有独立例外，因此“所有未 load 工具都不可调用”并非完整描述。

本地可信存储不是有签名的授权数据库；模型输入、类别、设置页目录和历史请求头都不能自行提升资格。宿主插件注册与可信组合配置属于控制面。完整产品验收和当前核验范围见 [03](<03-implementation-and-acceptance.md>)、[05](<05-current-status.md>)。

## 8. 实现索引

- 参数与外壳：[protocol.mjs](<../domain/protocol.mjs>)；类别与错误：[constants.mjs](<../domain/constants.mjs>)。
- 事务、预留与恢复：[engine.mjs](<../domain/engine.mjs>)；纯归约：[state.mjs](<../domain/state.mjs>)。
- 日志、配对与实际披露：[journal.mjs](<../adapters/dsh/journal.mjs>)；native 投影：[projection.mjs](<../adapters/dsh/projection.mjs>)。
- 执行附加门禁：[guard.mjs](<../adapters/dsh/guard.mjs>)；PTC：[ptc-sdk.mjs](<../adapters/dsh/ptc-sdk.mjs>)。
- 跨生命周期回归：[design-invariants.test.mjs](<../tests/unit/design-invariants.test.mjs>)。有测试代码不等于本轮已经运行，实测状态单独记录。
