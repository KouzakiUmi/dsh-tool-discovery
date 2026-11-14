# 项目维护入口

## 目的与设计依据

本项目为 DSH 提供渐进式工具发现：通过 `tool_list`、`tool_search`、`tool_load`、`tool_unload` 控制工具披露，并在执行链增加准入门禁，不替代宿主注册表、审批、沙箱或派发。

现行行为以 [当前实现契约](plugin/docs/00-current-contract.md) 为入口；0.2.2-rc.1+ 的重设计规格见 [14-rc1-redesign](plugin/docs/14-rc1-redesign.md)。历史协议文档中的旧默认值与展示模式不得直接作为当前需求。

## 架构与关键取舍

- `plugin/domain` 是不依赖宿主的目录、预算、选择与准入内核；`plugin/adapters/dsh` 负责宿主注册、日志、生命周期、掩码（mask.mjs）、admission store（admission.mjs）与执行门禁（guard.mjs）；`plugin/client` 为设置界面。
- 准入是单一事实源：tool_load 立即写 `selected` 并 admit 到 admission tracker，掩码 allow-list 随之即时更新——工具从**下一请求**起出现在声明里；tool_unload 撤销 admitted，下一请求起消失。同一步 toolSet 已定型，load 当步不可调；assemble 只记录绑定 toolSet 的准入快照，guard 据此拒绝 own-scope 同响应新 load 的调用。常驻 volatile 名单在后续请求同步到 engine/mask/guard，own-scope 门禁开关按新 runtime 采用。
- 掩码 allow-list = 入口四件 + frameworkRetained + alwaysVisible（含 preset/核心自证）+ admitted 名，经 `restrictableNames` 过滤；换掩码先装新再解除旧，遮不住的 own-scope 注册由 `gateOwnScopeTools` 门禁兜底（默认 true 也要 admission）。
- 生效边界 `disabledPresets`（默认 `["minimal"]`，替换语义，`[]` = 全开）：命中的 preset 里插件惰性——掩码改 `restrict({deny: 四入口})`（只遮入口、不枚举 allow），guard 只拒这四个入口、其余名字不做准入判定。判定读 `agentPresets.composedPreset(agent.ctx)`，读不到按正常流程（不猜、不静默停用）。
- volatile 配置热改的唯一同步点是 **`loader/volatile-update`**：宿主的 volatile 写入不重挂载插件，只原地更新引用并 emit 该事件；而 `agent/pre-step` 在本步 `tools.resolve()`/`systemPrompt.assemble()` **之后**才触发，只靠它重算会让该步的声明、toolSet 与 guard 三套状态撕裂（停用切换会死锁）。可热改字段：`alwaysVisible`、`initialToolsEnabled`、`alwaysAllowPresetTools`、`gateOwnScopeTools`、`disabledPresets`、`tolerantLoadProtected`、`respectAlwaysVisible`、`budgets`、`locale`（重建入口 definition）、`categoryConfig`；`frameworkRetained` 保持非 volatile（只读，经 volatile 节点 meta 通道下发）。宿主在 apply 前已按 schema 解析，`validateConfig` 必须解包这些字段的 `{get()}` 引用。
- admission 由 `storageDomain` 服务持久化（best-effort）：按会话完整快照，rc.1 撤空用 `table.delete()`；晚 seed 合并本地 touched/撤销墓碑，排队写入等待 open，卸载排空写链再 close。持续 I/O 错误不能承诺撤权跨重启已落盘。resume 按会话重读并按 schemaDigest 对齐，不符丢弃；创建即 ready。
- 执行门禁只增拒绝：admitted 且 digest 与当前目录一致才放行；目录外且 non-restrictable 的 own-scope 名字放行（宿主语义兜底）。入口名被同名覆盖即拒绝该名执行。runtime 缺失（异常态，如 warmup 失败）时对**不可遮**的 own-scope 名字 fail-closed——它们是宿主遮不住、只能靠准入拦的那一面。
- 目录边界隔离畸形定义：宿主 `register()` 接受 `parameters` 非普通对象的定义，domain 会拒绝；适配层在 registry 处跳过并记一次日志，`onRegistryChange` 逐会话隔离，避免一个坏绑定让所有新会话建不起来、并中断刷新链。
- 输入形状判定只保留一套口径：字段按"是否给出有效值"判定（空数组、纯空白字符串不算给出；候选 `revision` 的 `null`/空串不算断言），协议校验与执行门禁共用同一判定。

## 宿主版本兼容

只支持 DSH Core `0.2.2-rc.1` 及以上（`engines.dsh >=0.2.2-rc.1`，`dshReleases` 中 rc.1 为 `compatible`，更旧版 `incompatible`）。不再有旧宿主分支：

- 掩码用宿主公开的 `agent.ctx.tools.restrict({allow})`（停用场景改为 `{deny}`）；目录与 preset 判定用 `viewWithoutRestriction`（忽略本插件 filters）得到的可见面——被遮的工具必须能被发现，preset 名单也不能被自己的掩码吃掉。
- `agent/created`（宿主 await）内同步建 runtime + 装初始掩码；`agent/pre-step` 兜底 reconcile；`tools/change` 用注册表指纹（忽略自有掩码）跳过自反馈环，重入的第三方注册经 microtask 对齐。
- PTC 与 native 统一：掩码作用于 `view().visible` → `definitions()`/SDK 投影同源，`run_code` 内的 SDK 同样看不到被遮工具，无 PTC 兼容开关。
- global 与父 scope（含 preset）工具可受掩码控制；agent 当前 scope 自己注册的工具遮不住，可能直接披露，执行仍经准入门禁。
- 增量声明与历史保留由宿主按模型路由决定；`in-history` 路由可能继续发送已撤工具的历史 schema，但撤权后不得执行。同名定义变更后要重新成功加载和实际披露。
- 激活前由 `assertRestrictionHost` 一次性校验 restriction 层结构，不符拒绝激活；形状相符也不能声称兼容所有 0.2.2+。
- Cordis 4.1 起 `fiber.config` 是原始输入，已解析（含 volatile 引用）的配置在 `fiber.effectiveConfig`；读取统一走 `liveConfig()`，缺失时回落 apply 期快照。
- 安装准入用 `engines.dsh`（0.2.2-rc.1 的 app-boot 有它时不再逐个比对 dsh peer）。

## 验收与测试维护

修改前先对照有效设计与实际调用链，再判断测试是否表达当前目标。不得通过放宽生产门禁、跳过测试或删除有效断言消除失败。

关键验收包括：隐藏 global 工具未 load 不披露也不执行；own-scope 工具披露（遮不住）但未 admitted 时不执行（gateOwnScopeTools=true）；同响应 load 不追认执行；合法下一轮调用可用；tool_unload 后下步不在声明且不可执行；换版/撤权后不执行；admission 在 storageDomain 可用时 durable；own-only 恢复与跨会话隔离；插件卸载不复活旧 runtime；配置保存和中英文界面接线正确。

- 单测：`npm test`；组合：`npm run test:composition`；一致性：`npm run check`；质量数据集：`npm run check:quality`。
- 组合测试使用真实公共 DSH 服务、mock provider 和测试自有临时存储，不操作用户 profile 或真实模型。
- 宿主解析锚点由 `DSH_INSTALL_ROOT` 指定（rc.1 解包：`.probe/install-root-rc1`）；测试依赖必须来自已核实的安装。
- 类型、静态检查、单测、组合、GUI 和真实 provider 验证分别报告；测试通过不代表全版本兼容或安装生效。

## 维护边界

保持最小改动，不修改宿主安装目录。Host 与 Client 物理隔离，Client 不引入 Node 原生模块。监听与资源必须随插件生命周期清理。双语文档、配置元数据、回执与实际投影保持一致。质量数据集的冻结标签与摘要须遵循其设计流程，不为消除校验错误随意重标。
