# 09 · 当前业务逻辑地图

更新日期：2026-11-06。依据 manifest `0.6.0` 的工作区源码（DSH Core `0.2.2-rc.1+` 的准入设计，规格见 [14](<14-rc1-redesign.md>)）。
这是**源码导读**，不是一次新安全审查或产品验收；精确行为见 [00](<00-current-contract.md>)，实测状态见 [05](<05-current-status.md>)。
旧投影/epoch/journal/PTC 路径已整体移除，历史版本见 git 记录，不再混作当前待办。

## 1. 一句话业务

把"发现需要什么能力"与"向模型披露完整参数"分开。四个入口和初始工具集合先出现，其它工具经显式 `tool_load` 准入后下一轮才披露并可调用，`tool_unload` 则把已准入的工具从下一轮起收回。执行仍由宿主原链完成，本插件只在调度前加一层只增拒绝的门禁。
减少披露是设计目标；是否节省 token 或总任务时延需要测量，不能从工具数量或域内微基准推断。

## 2. 分层与职责

| 层 | 源码 | 职责 |
|---|---|---|
| 目录/版本 | [catalog](<../domain/catalog.mjs>)、[categories](<../domain/categories.mjs>) | 当前绑定快照、类别、schemaDigest/revision；不赋予宿主权限 |
| 搜索/列表 | [search](<../domain/search.mjs>)、[list](<../domain/list.mjs>) | 任务候选、完整名称、游标；不提交选择 |
| 参数/预算 | [protocol](<../domain/protocol.mjs>)、[budgets](<../domain/budgets.mjs>) | 严格字段校验、完整成功外壳计量、事务配额 |
| 状态/组合根 | [state](<../domain/state.mjs>)、[engine](<../domain/engine.mjs>) | selected 提交、版本/锁串行化、`handleLoad`/`handleUnload` 立即提交 |
| 资格 | [registry](<../adapters/dsh/registry.mjs>)、[restriction-view](<../adapters/dsh/restriction-view.mjs>) | scope 原生可见性（忽略本插件掩码）与绑定代次；目录建于**无掩码视图** |
| 掩码 | [mask](<../adapters/dsh/mask.mjs>) | 每 agent 一个 `restrict({allow})`；allow = 四入口 ∪ `frameworkRetained` ∪ alwaysVisible ∪ admitted，经 `restrictableNames` 过滤；换掩码先装新再解除旧 |
| 准入 | [admission](<../adapters/dsh/admission.mjs>) | admission 权威存储：内存 Map + `storageDomain` 持久快照（best-effort，缺席退化纯内存） |
| 生命周期 | [lifecycle](<../adapters/dsh/lifecycle.mjs>) | per-session/agent runtime，`runtimeFor` 在 `agent/created` 内同步建立、`commitAdmissions`/`revokeAdmissions`、resume 对齐持久行 |
| 执行门禁 | [guard](<../adapters/dsh/guard.mjs>) | `tools.guard` 同步只增拒绝：admitted + 当前目录 digest 一致才放行；目录内未准入拒；`gateOwnScopeTools` 兜 own-scope；入口名被同名覆盖即拒 |
| 变更通知 | [registry-change](<../adapters/dsh/registry-change.mjs>) | 忽略自有掩码引起的注册表指纹变化，第三方注册经 microtask 对齐 |
| 设置 | [config](<../adapters/dsh/config.mjs>)、[inventory](<../adapters/dsh/tool-inventory.mjs>)、[client](<../client/client.js>) | 配置与全局登记辅助目录，和会话执行目录分开 |

宿主依赖与文件 I/O 留在 adapter；domain 不导入宿主包，也不读取真实 profile。

## 3. 四入口如何闭环

```text
tool_list：浏览类别或名称 ────────┐
tool_search：类别内任务候选 ────┤
                                ▼
tool_load：解析当前绑定 → 配额 → 写 selected + admit（同一事务）
                                ▼
掩码 reconcile（next request 起可见）→ 宿主原调度链
                                ▼
原生调用：guard 只增加拒绝 → 宿主原策略与派发

tool_unload：撤销 admitted + 清 selected ──► 下一 request 消失且拒执行
```

`tool_load`/`tool_unload` 都返回立即回执，但 effect 写"next_request"——同一步的 toolSet 已定型，load 当步不可调。目录外的 own-scope 名字宿主遮不住、可能直接披露，执行仍经 `gateOwnScopeTools` 兜底。任一 `ok` body、检索命中或掩码允许都不能独立完成整条链。

## 4. 准入与持久化

- admission 是单一事实源：`selected`（domain）与 admitted（adapter tracker）由 `commitAdmissions`/`revokeAdmissions` 在同一生命周期提交，掩码 allow-list 即时重算。
- `storageDomain` 缺席/失败 → admission 退化纯内存（不阻塞，仅不跨重启保留）；可用时 per-session 一行 `{name, toolId, schemaDigest}`。
- resume 按持久行与当前目录对齐：同 toolId + 同 schemaDigest 才恢复准入，缺失/变更丢弃；own-only 恢复不依赖会话历史回放（无 `sessionQuery`）。
- 换版（schemaDigest 变）与撤权（binding 消失）走 `refreshCatalog`：`invalidated` 记入 state，admission 同步撤销，下步起不可执行。

## 5. 掩码安装与 reconcile

- `agent/created`（宿主 await）：`lifecycle.runtimeFor` 同步建 runtime（含恢复 durable admission）→ `mask.ensure` 装初始掩码；修复了此前"掩码装上但 runtime 未建，guard `runtime===undefined` 放行 own-scope"的漏洞。
- `agent/pre-step` 兜底 reconcile；`tools/change` 由 [registry-change](<../adapters/dsh/registry-change.mjs>) 的指纹判断（忽略自有掩码）决定是否全量重算，自反馈环跳过。
- 掩码 allow-list 计算在 [mask.mjs](<../adapters/dsh/mask.mjs>) 的 `desired()`：`ENTRY_TOOL_NAMES` ∪ `frameworkRetained` ∪ `alwaysNamesFor(agent)`（由 lifecycle 提供 = 手动 alwaysVisible ∪ preset ∪ self-attested）∪ admitted，再经 `restrictableNames`（global + 父 scope）过滤——own-scope 名字本就遮不住，不需要进 allow。
- `getAlwaysVisible` 通过 `lifecycleForMask` 延迟绑定注入，避免 mask 与 lifecycle 的循环依赖。

## 6. 配置与门禁面

- `gateOwnScopeTools`（volatile，默认 `true`）：own-scope 注册在 catalog 内且未 admitted → 拒绝；catalog 外 → 放行（宿主语义兜底）。关闭时目录外 own-scope 名直接放行。
- `alwaysVisible`/`initialToolsEnabled`/`alwaysAllowPresetTools`/`respectAlwaysVisible`/`tolerantLoadProtected`/`frameworkRetained`/`budgets`/`categoryConfig`/`locale` 见 [00](<00-current-contract.md>)。
- 已移除（schema 保留、inert）：`ptcCompatibility`、`compactBuiltinToolDescriptions`/`Overrides`、`requireTrustedEpoch(+ForSubagents)`、`allowMissingSessionQuery`；`apply.inject` 不再需要 `sessionQuery`。
- `engines.dsh >=0.2.2-rc.1`；peer 移除 `dsh-llm` 与 `dsh-tool-executor-ptc`。

## 7. 测试与证据面

- `npm test`：domain + client 逻辑与文案（`client.test`/`settings.test` 需 `DSH_INSTALL_ROOT` 真实安装的 React/schemastery）。
- `npm run test:composition`：真实公共 Loader + mock provider + 测试自有临时存储；覆盖 adapter 主链、mask 契约、gate、生命周期、resume、terminal、PTC SDK 同源、设置。
- 历史 epoch/journal/PTC/描述精简套件随旧子系统移除；新断言等价物按准入口径迁移。
