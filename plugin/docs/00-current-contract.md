# 00 · 当前实现契约

> 更新日期：2026-11-07。依据 manifest `0.6.0` 的工作树源码：本版起**只支持 DSH Core 0.2.2-rc.1+**，旧宿主投影路径（逐字冻结 wire、canonical 回执、缓存周期、可信周期记录、PTC 兼容开关、内置描述精简）整体移除。
> 本文是现行行为入口，不是发布、安装或完整产品验收声明。
> 重设计规格见 [14-rc1-redesign](<14-rc1-redesign.md>)；[02 历史冻结协议](<02-protocol-and-data-model.md>)保留了早期设计和历次 delta，其中旧默认值、展示模式、冻结承诺不能直接当作当前行为。

## 1. 支持范围与初始集合

本插件不执行工具代理，也不建立第二个工具注册表。它通过宿主 agent 级 `restrict` 掩码控制披露，在执行链上增加准入门禁；宿主审批、沙箱、原生可见性和派发仍然有效。

- 首轮携带四个固定入口、有界类别导航，以及初始集合的完整 schema——初始集合不是"只有四个入口"。
- **准入（admission）是披露与执行的唯一共同事实源**：`tool_load` 成功后该名从**下一请求**起出现在声明里，并可执行；`tool_unload` 使其从下一请求起消失且不可执行。同一次 toolSet 已定型，load 当步不可调；own-scope 虽已披露，也由绑定 toolSet 的准入快照拒绝同响应新 load 的调用。
- PTC 与 native 统一：掩码作用于 `view().visible`，`definitions()` 与 `run_code` 内的 SDK 投影遵守同一套掩码；无独立 PTC 路径。
- 一个会话按 agent 建 runtime；runtime 在宿主 await 的 `agent/created` 内同步建立（含目录快照与初始掩码）。不承诺同会话多 agent 并发隔离，也不承诺无停顿热替换的原子派发绑定。
- admission 在 `storageDomain` 服务可用时持久化（best-effort）：服务缺席、打不开或读写失败退化为纯内存，不阻断会话。resume 按 `schemaDigest` 与当前目录逐名对齐，不符的 durable 行丢弃、不落 selected。

初始集合的来源分别是：

| 来源 | 默认与边界 |
|---|---|
| 四个发现入口 | 始终保留，不由 `alwaysVisible` 删除；被同名覆盖时该名执行拒绝 |
| 手动名单 | `alwaysVisible` 缺省取手工维护的 `CORE_TOOL_NAMES`；显式数组是替换，不是追加；由 `initialToolsEnabled` 控制 |
| 当前 preset | `alwaysAllowPresetTools=true` 独立保留实际绑定修订自己登记、且原生 scope 仍可见的工具；不等于所有 preset 或整个应用目录 |
| 核心同名自证 | `respectAlwaysVisible=false` 且初始注入未关闭时，guard 可吸收当前 scope 实际提供的核心名单工具；手动空名单不是默认模式下的最终授权上限 |
| 框架保留项 | `frameworkRetained` 是可信组合配置，不是模型可自行填写的名单 |

设置页的全局登记目录只是编辑辅助，不是会话的可调用集合。partial 目录未列出的项是 `unknown`，不能据此宣称未注册。

## 2. 掩码与披露

- 掩码 allow-list = 四个入口 + `frameworkRetained` + alwaysVisible（手动/preset/自证合并）+ admitted 名，再经 `restrictableNames` 过滤。更换掩码先安装新限制再解除旧限制。
- `restrictableNames` 只含 global 与父 scope 注册；**agent 当前 scope 自己注册的工具遮不住**，可能直接披露——其执行由 `gateOwnScopeTools`（默认 true）门禁兜底：目录内仍要 admission，目录外名字放行（宿主语义兜底）。
- 本插件掩码切换引起的 `tools/change` 按注册表指纹跳过，不触发全量重算；第三方注册在同一 microtask 内对齐。
- 目录从忽略本插件掩码的可见面构建：被遮的工具必须能被 `tool_list`/`tool_search` 发现，preset 名单也不被自己的掩码吃掉。

## 3. 四入口

四入口采用协议版本 `3`，拒绝未知字段、模型指定的会话身份、路径、代码或自由技能名。`tool_load`/`tool_unload` 不执行目标工具，也不批准副作用。

### 3.1 `tool_list`

| 请求 | 行为 |
|---|---|
| `{}` | 默认返回类别导航 |
| `{"category":"files"}` | 省略 view 时按 `available` 列名称 |
| `{"view":"available","category":"all"}` | 当前可发现名称分页；同名去重，不返回 schema、描述或 ref |
| `{"view":"loaded","category":"all"}` | 当前 admitted/selected 名称分页（即下轮会披露的工具） |
| `{"view":"categories"}` | 类别卡分页；不接受 `category` |
| `{"view":"state"}` | 当前选择、失效诊断与预算；不接受 `category`、`cursor` 或 `limit` |

`available` 和 `loaded` 必须给类别，可用 `all`；`categories`、`available`、`loaded` 支持 opaque 游标与正整数 `limit`。默认页长 20。游标绑定会话、view、类别、资格代次、顺序摘要和有效期，失效后从首页重查。资格代次改变时立即回收旧游标，不等待 TTL；内容相同的刷新或校验失败不清掉仍有效的游标。

### 3.2 `tool_search`

必填 `category`、非空 `query`，可选正整数 `limit`，默认 5。可限定一个受控类别，也可用 `category:"all"` 搜索当前 scope 的全部可发现类别；不确定类别时无需先列类别。`all` 是已有行为，不扩大 scope 资格。

`query` 按首尾空白归一后判非空：纯空白与空串同义，直接拒绝，不以"成功但零候选"回应——那是"没有匹配工具"的信号，会把模型推向换类别而不是重写查询。

返回候选卡，包括名称、短摘要、ref、revision、loaded 和受控匹配原因；不返回工具 schema、不加载、不为凑满数量补项。`loaded=true` 表示已 admitted，不必重复 load；但只有当前工具表实际出现其 schema 才可调用，否则等下一轮。词法证据不保证任务语义相关，通用动词仍可能误召回，不能把候选当成能力保证。

**类别词只辅助排序，不能独立制造命中。** 至少需要名称、受控同义词、工具摘要或技能字段的证据。纯类别词可能得到空候选与改写/浏览指引；这是一项精确率与召回率取舍，不是检索质量达标声明。

### 3.3 `tool_load`

两条互斥路径：

| 请求 | 行为 |
|---|---|
| `{"names":[...]}` | 按当前 scope 可见目录精确选名；未注册名称按 `NAME_NOT_FOUND` 拒绝，不静默忽略 |
| `{"candidates":[{"ref":"c_…","revision":"…"}]}` | 按 `tool_search` 返回的候选卡选 ref；`revision` 可省略，省略时按当前目录版本加载 |

混用两条路径按 `INVALID_ARGS` 拒绝。候选 `ref` 绑定会话与目录资格代次：注册表变动使旧 ref 立即失效，须重新搜索；`revision` 给出时必须与当前目录条目完全一致，不一致按 `NAME_CONFLICT` 拒绝，不做降级猜测。

`tool_load` 成功后立即写 `selected` 并 admit：该名从**下一请求**起披露并可执行。重复 load 已 admitted 且同版本的名字返回成功但不重复回灌技能（省上下文）。加载被 alwaysVisible 覆盖的"受保护"名字在 `tolerantLoadProtected=true`（默认）时按成功处理，显式关闭时拒绝。

### 3.4 `tool_unload`

`{"names":[...]}` 必填，按名字撤销本会话 admission：从下一请求起不再披露，且立即不可执行。撤销不存在于当前 admitted 集合的名字幂等返回成功，并保留本地撤销墓碑，阻止晚到的存储 seed 复活。入口名、`frameworkRetained` 与 alwaysVisible 名单按 `INVALID_ARGS` 整批拒绝；所有名字校验通过前不修改选择或准入。

## 4. 执行门禁

每次工具派发前做同步检查，只增拒绝：

| 情况 | 判定 |
|---|---|
| 四个入口名被同名覆盖（实例不同） | 拒绝（fail-closed） |
| `frameworkRetained` / alwaysVisible 名单 | 放行（宿主链负责） |
| `respectAlwaysVisible=true` 之外的宿主原生可见 | 核心名单自证吸收后放行 |
| 目录内名字未 admitted | 拒绝 not-admitted |
| admitted 但当前目录条目 name/schemaDigest 已变 | 拒绝 definition-changed，须重新 load |
| 目录外且 non-restrictable（own-scope）名字 | `gateOwnScopeTools=true` 且名字在目录/可遮时要求 admission；否则放行 |

披露不是执行许可：每次调用仍走宿主原生的审批、沙箱与权限链。

## 5. 失效与恢复

- 注册表变化触发目录重算（`eligibilityGeneration` 递增）：目录里消失的 admitted 名被 invalidate，`tool_list view:"state"` 可看到失效诊断；掩码同步收紧。
- 同名定义实例被替换或 schemaDigest 变化 → selected 失效并撤销 admission，须重新 `tool_load` 接纳新版本。
- durable admission 行按 `{name, toolId, schemaDigest}` 与当前目录对齐：digest 不符或名字不在目录 → 该行丢弃，session 以更少 admitted 起步。
- `in-history` 模型路由可能继续发送已撤工具的历史 schema，但撤权/换版后执行拒绝。
- 存储为 `progressive_tools_admissions` 域中按 sessionId 的完整快照；撤空使用 rc.1 `table.delete()`，同进程 resume 按会话重新读取，不扫描全部历史。open 和快照写失败各有一次有界重试。
- 排队写入等待 open、与晚 seed 合并本地修改和撤销墓碑。卸载先禁止新操作与新增准入，等待已开始入口的提交续体（尤其撤权），再冻结 tracker、排空已有写链并关闭域。卸载竞态中的 load 回执不会建立新准入。持续存储错误只保留本进程内存事实并记录诊断，不能承诺跨重启撤权已落盘。

## 6. 配置兼容

- 仍有效：`alwaysVisible`、`initialToolsEnabled`、`alwaysAllowPresetTools`、`respectAlwaysVisible`、`tolerantLoadProtected`、`gateOwnScopeTools`、`frameworkRetained`、`budgets`、`locale`、`categoryConfig`。`alwaysVisible`、`initialToolsEnabled`、`alwaysAllowPresetTools` 在后续请求 reconcile 时同步到 engine/mask/guard；已有按需 admission 不因常驻配置变更而隐式撤销。`gateOwnScopeTools` 在 runtime 建立时采用。
- 已废弃但保留字段（不读、不校验、无效果）：`ptcCompatibility`、`compactBuiltinToolDescriptions`、`compactBuiltinToolOverrides`、`requireTrustedEpoch`、`requireTrustedEpochForSubagents`、`allowMissingSessionQuery`。
