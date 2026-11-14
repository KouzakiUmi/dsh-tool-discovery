# rc.1 原生重设计（v0.6）

现行设计，适用于已核验的 DSH Core `0.2.2-rc.1`；行为入口见 [当前实现契约](<00-current-contract.md>)。更晚版本需核验 restriction 内部结构与公共服务契约。

## 目标与宿主边界

四入口负责发现、选择与撤销；隐藏工具默认不占声明，未准入的受控工具不可执行。宿主持有 provider 声明、模型路由的历史增量、审批、沙箱与派发；插件不改写声明数组，不维护逐字冻结 wire、epoch 或 canonical journal。

- `agent.ctx.tools.restrict({allow})` 控制 global/父 scope 工具；自身 scope 注册不能隐藏。
- 宿主固定每步 toolSet。global 工具同响应 load 后不在本步 toolSet；own-scope 已披露，因此额外需要步骤准入快照。
- `in-history` 路由可能继续发送旧 schema；卸载撤权不删除历史。`addition-only` 路由的移除可能引起宿主重声明，不承诺缓存或费用收益。

## 架构

- domain：目录、检索、候选 ref、分页、预算、selected。
- adapter：registry 资格视图、admission tracker、mask、guard、生命周期。
- client：浏览器设置界面，不导入 Node 模块。

准入 tracker 是披露/执行共同事实源，selected 是供检索/状态/预算使用的投影。入口提交将两者对齐；失败批次不得产生部分修改。

## 掩码

allow = 四入口 + frameworkRetained + 常驻集合 + admitted，过滤到 restrictableNames。创建 agent 时同步建 runtime 并装初始掩码；load/unload 后立即重掩码，下一模型请求采用新声明；pre-step 为兜底 reconcile。

目录与 preset 从忽略**本插件** restriction 的视图构造，其它插件限制仍有效。适配层镜像 rc.1 view 算法，激活前检查所需内部结构。

生效边界（`disabledPresets`，默认 `["minimal"]`）：命中的 preset 里插件惰性——掩码换成 `restrict({ deny: 四个入口 })`（只移除入口，不枚举 allow，之后注册的全局工具不会被误遮），guard 只拒这些入口、其余名字不做准入判定。判定读 `agentPresets.composedPreset(agent.ctx)`，读不到按正常流程处理；字段 volatile，在下一请求对齐（含空白会话换 preset）。

更换先装新后解除旧，瞬时交集不扩大权限。仅跟踪仍在宿主层中的自有 filter；释放失败的旧 disposer 保留并在后续 reconcile 重试。指纹忽略自有 filters，纯掩码变动不刷新所有会话；掩码事件内的第三方重入注册经 microtask 对齐。

## 执行门禁与步骤语义

入口被同名覆盖时拒绝。frameworkRetained、常驻集合交由宿主权限链；核心自证必须同时满足初始注入开启且非精确名单模式。

受控名字要求 admission 存在且 schemaDigest 与当前目录一致。默认 own-scope 同样需要准入；目录外且不可遮名字由宿主兜底。`gateOwnScopeTools=false` 放开 own-scope 准入要求。

`system-prompt/assemble` 不改写 assembly，仅以 context.toolSet 记录该请求开始时的 admission 对象快照。guard 同时检查即时 admission 和步骤快照：同响应新 load 或 unload 后再 load 不追认；unload 即时撤权；下一请求可调用。无 toolSet 的宿主直接调用按即时准入判定。

## 准入持久化

- 使用可选 storageDomain 服务，域 `progressive_tools_admissions`、版本 1、single 布局、表 `admissions`，sessionId 为键。
- 快照 `{sessionId, updatedAt, admissions:[{name,toolId,schemaDigest,at}]}`；非空使用 `table.put()`，撤空使用 rc.1 `table.delete()`，不是 JSONL。
- 同步改内存；异步每会话有序快照，写入中合并后续更新。等待 open 后才写；open/写失败各有一次有界重试，不后台轮询。
- 晚 seed 合并 durable 行与本地 touched 覆盖；不存在于本地 rows 的 touched 名字是撤销墓碑，不得重新加入。幂等 unload 同样记录墓碑。
- 仅恢复活动会话；同 id 在同进程重建时重新按键读取。不把其它会话载入当前 runtime。
- seed 按名字/schemaDigest 对齐当前目录，不符丢弃。服务缺席或读取失败以较少准入继续，创建即 ready，无恢复屏障。
- session 释放后公共读侧为空；未完成的写入继续排空。插件卸载同步停止新操作/新增准入，等待已开始入口续体完成撤权，再冻结 tracker、排空已排队快照，最后关闭存储域；晚 open 回调不得复活 runtime。
- best-effort 不是持久化成功保证：持续 I/O 错误保留内存事实与诊断，跨重启仍取决于最后成功的快照。

## 配置

常驻名单、初始注入和 preset 保留在后续请求 reconcile 同步到 engine/mask/guard；现有按需 admission 不因常驻变更而隐式删除。own-scope 门禁开关按新 runtime 采用。非 volatile 配置保存仍由宿主重载。

旧 `ptcCompatibility`、`compactBuiltinTool*`、`requireTrustedEpoch*`、`allowMissingSessionQuery` 已从 Config 与设置页删除（宿主非严格合并会保留旧 profile 里的同名键，既不报错也不生效）。PTC SDK 从同一宿主掩码视图投影，不维护独立 SDK 披露路径或展示模式分支。

## 验收

1. 隐藏 global 首轮无声明、猜名不执行；own-scope 可披露但默认未 load 不执行。
2. global/own 同响应 load 不追认执行，下一请求可用；unload 即时撤权，下一请求收回可遮声明。
3. 混批 unload 任一保护名使整批失败，selected/admission/预算不变；合法重试可撤权。
4. 换版/撤权使旧选择失效；重新 load 接纳当前定义。
5. durable 撤空后重启不复活；慢 open 期间 revoke 不被晚 seed 覆盖；排队写入在卸载前排空。
6. 同进程同 id resume 恢复有效行；会话/fork 准入隔离；晚异步回调不复活旧 activation。
7. 常驻名单取消后可正常按需 load；关闭初始注入不被 own-scope 核心同名自证绕过。
8. 纯掩码 churn 不全量刷新目录，已释放 filter 引用有界；第三方限制、重入注册仍对齐。
9. 压缩无 epoch 中止；native/PTC SDK 同源。真实 provider、worker 与在线 GUI 另行验收。
