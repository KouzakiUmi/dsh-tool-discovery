# 03 · 实施、验收与发布门槛

> 更新日期：2026-11-14。本文按 manifest `0.7.0`、协议版本 `3` 描述验收口径；现行行为以 [00](<00-current-contract.md>) 为准，实际执行与未覆盖项见 [05](<05-current-status.md>)。矩阵是待核验标准，不代表本次已执行或产品已验收。

## 1. 实施原则

1. 在目标 Core 的公开宿主接口和真实组合中核验，不以纯 mock 代替宿主接线。
2. domain 保持宿主无关；adapter 负责注册、掩码、准入、存储、门禁和生命周期。
3. 四入口与初始集合分开核验；准入控制披露与执行，guard 只增拒绝，宿主原调度、审批及沙箱仍有效。
4. 实现存在、测试通过、独立审查、产品验收、分发与安装生效分别记录；版本范围不是各版本验收结论。

## 2. 模块边界与运行前提

[domain](<../domain/>) 提供目录、搜索、协议、预算和选择；[adapters/dsh](<../adapters/dsh/>) 接入宿主；[client](<../client/>) 提供设置界面。[单元测试](<../tests/unit/>) 与 [组合测试](<../tests/composition/>) 的运行条件见 [开发指南](<../README.md>)。宿主相关测试需要可解析目标安装的 peer；测试自有临时存储不等于用户 Profile。

## 3. 组合验收：adapter 主链

| 场景 | 必须观察的结果 |
|---|---|
| `agent/created` | 宿主等待的创建流程内同步建立 runtime 和初始掩码；首请求按初始集合披露 |
| 隐藏的 global 工具 | 未加载不在受控声明中，猜名调用不得执行 body |
| `tool_load` | 成功立即提交 selected 与 admission；同一步 toolSet 已定型，不追认该步调用；下一请求披露并可经宿主链执行 |
| `tool_unload` | 立即撤销 admission、立即拒绝执行；下一请求受控声明中移除；受保护名称拒绝撤销，不存在的普通 admitted 名幂等成功 |
| terminal | 加载及撤销在终止路径前立即提交，不依赖后续一步触发提交 |
| 原生执行链 | 参数校验、审批、沙箱和原有拒绝仍生效；插件不执行目标工具代理 |

## 4. 变更与审查职责

实现者提供实际快照、运行命令与未覆盖项；安全审查应独立核对反例和证据。配置目录是编辑辅助，不可冒充会话资格。历史报告不自动升级为当前版本的测试结果。

## 5. 验收矩阵：发现与披露

| 场景 | 必须观察的结果 |
|---|---|
| 四入口与初始集合 | 四入口保留；手动、preset、核心自证及可信框架项按各自配置生效 |
| `tool_list` / `tool_search` | 返回受控名称或候选，不披露目标完整 schema，不改变 admission |
| 精确名称和候选加载 | 按当前 scope、资格与版本校验；无效请求不产生部分提交 |
| 定义换版或撤权 | 旧准入不能执行变更后的定义；重新加载当前定义后才可放行。撤权后历史 schema 即使仍被发送也不能执行 |
| 掩码集合 | allow 为四入口 ∪ `frameworkRetained` ∪ alwaysVisible（手动/preset/自证）∪ admitted，经 `restrictableNames` 过滤 |
| 掩码切换 | 先安装新限制再解除旧限制；本插件变更不形成无限反馈，第三方注册可对齐 |
| own-scope | 宿主不能遮住当前 agent 自己注册的工具，可能披露；默认门禁对目录内未准入工具拒绝执行 |
| 停用 preset（`disabledPresets`，默认 `minimal`） | 四个入口不在会话声明里且猜名调用被拒；其它工具不遮罩、不要求 admission；`[]` 恢复全部 preset 的发现流程；空白会话换 preset 在下一请求对齐 |
| volatile 配置热改 | 设置页写入**不重挂载**插件；`disabledPresets`/`alwaysVisible` 等热改后**下一个请求**的声明、toolSet 与 guard 即同源一致（不得出现「声明可见却 unknown tool」的撕裂面）；`gateOwnScopeTools` 由新建 runtime 采用活值；`budgets`/`categoryConfig`/`tolerantLoadProtected` 进入运行中的 engine；`locale` 重建入口文案后仍可派发 |
| 畸形第三方定义 | `parameters` 非普通对象的定义在目录边界被跳过并记一次日志；不得阻止新会话创建、不得中断 tools/change 刷新链；runtime 缺失时不可遮的 own-scope 名字 fail-closed |

## 6. 验收矩阵：门禁与安全

| 场景 | 必须观察的结果 |
|---|---|
| 已准入且摘要匹配 | 普通工具通过插件门禁，仍走宿主权限及派发链 |
| 未准入或摘要不匹配 | 拒绝执行；变更定义须重新加载 |
| 入口被同名覆盖 | 对被覆盖的入口名拒绝执行 |
| own-scope 目录外且不可遮 | 按宿主语义放行；不得误称所有 own-scope 均可隐藏 |
| 不可信描述 | 仅作资料，不改变配置、准入或系统规则 |

`gateOwnScopeTools` 的配置和初始/框架项例外均须分别覆盖，不能把掩码允许当成授权证明。

## 7. 验收矩阵：生命周期与持久化

| 场景 | 必须观察的结果 |
|---|---|
| durable admission | `storageDomain` 可用时持久化；缺席或失败时退化纯内存，不阻断会话 |
| resume | 依当前目录比对 `toolId` 与 `schemaDigest`；不匹配或消失的记录不恢复 |
| own-only 恢复 | 仅恢复本会话持久准入，不依赖继承历史；跨会话和 fork 不泄露 admission |
| 生命周期释放 | 插件停用后不复活旧 runtime，所拥有的限制与监听按生命周期清理 |
| 同会话多活动 agent / 热替换 | 不将未经验证的并发隔离或无停顿原子绑定作为已支持能力 |

历史资料：[07 恢复覆盖](<07-lifecycle-recovery-coverage.md>)、[08 历史基线](<08-trusted-epoch-baselines.md>)、[11 审查记录](<11-code-review-findings.md>)、[13 描述精简](<13-builtin-descriptions.md>) 仅用于追溯，不是当前验收合同。

## 8. 验收矩阵：宿主声明与执行链

PTC 的 `run_code` 内 SDK definitions 与原生声明来自同一受掩码可见面：未准入的可遮工具不得出现在 SDK；加载后下一请求可见，撤销后下一请求不再可见。实际请求、路由历史与执行拒绝须分别观察；`in-history` 可能继续发送旧 schema，不等于恢复执行权限。

## 9. 检索质量实验

将调参与 held-out 任务分开，覆盖中英文、同义改写、组合需求和不可完成负例；分别报告 Recall@5、MRR、负例误命中与模型选定率。结构校验不等于语义质量验收；当前数据状态以 [05](<05-current-status.md>) 为准。

## 10. 性能实验

比较全量声明、检索即加载与显式发现加载方案，在相同 provider、model 和任务条件下测量实际请求 token、缓存、首次有效工具与端到端时间；将额外轮次纳入。减少披露是目标，不从工具数推断 token 节省或延迟收益。

## 11. 发布门槛

产品验收需在目标版本核对上述功能、安全和生命周期场景，完成适用的独立审查，并报告真实 provider 与实际运行环境的结果及限制。源码、构建产物、npm、STORE 与 Profile 安装是独立里程碑；工作区测试通过不表示在线 GUI 已生效。

## 12. 剩余关键验证项

覆盖口径：组合测试使用真实公共 Loader、mock provider 与测试自有临时存储，可验证其断言覆盖的宿主接线，但不是外部真实 provider wire、真实 GUI 或当前 Profile 安装验收。具体执行状态以 [05](<05-current-status.md>) 为准；真实 provider、GUI、安装、跨版本、性能与检索质量须分别取证。
